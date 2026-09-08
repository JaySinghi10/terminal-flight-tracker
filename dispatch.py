"""Draining the outbox. The half that did not exist.

notify.py decides WHAT to say and writes a message into a flight's outbox.
poller.py puts it there. Nothing took it out. This does.

WHY IT IS NOT PART OF THE POLL, and this is the whole reason the module is
separate: notify defers a cancellation through the night. A message written at
02:00 carries deliver_after 07:00, and if dispatch only ran inside a poll it
would go out on the next poll OF THAT FLIGHT -- which, for a cancelled flight
sitting in a slow tier, may be hours later or not at all. Dispatch needs its
own clock. The second reason is smaller: an Expo call that retries inside the
poll inflates a request that already holds a lock and runs to a provider
budget.

ONE PASS DOES RECEIPTS FIRST, THEN SENDS. A ticket from Expo is not a delivery;
the real outcome arrives from a second call about fifteen minutes later. Both
phases live on this one endpoint on purpose -- the pass runs on a schedule
whether or not there is anything to send, so the receipt sweep always happens
and needs no scheduler of its own.

AT LEAST ONCE, NEVER SILENTLY NEVER. Each (message, device) pair is claimed in
the flight's state before the HTTP call and confirmed after it. A crash between
the two leaves a claim with no send, and a claim goes stale after CLAIM_STALE
and is picked up again. The other way round -- mark first, never retry -- would
be safe against duplicates and would lose a message permanently, because
notify's `keys` list refuses to ever create that message a second time. For
this app a rare duplicate is much cheaper than a delay nobody hears about.

NOTHING HERE DECIDES WHAT TO SAY. The sentences come from notify.render and the
titles from notify.subject. This module picks readers, sends bytes, and
remembers what happened.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

import requests

import notify
import pollstate
import store

logger = logging.getLogger("flight-tracker")

# -- EXPO --------------------------------------------------------------------
SEND_URL = "https://exp.host/--/api/v2/push/send"
RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"

# THE SERVICE IS FREE. Expo does not bill for push, so there is no per-message
# cost to budget the way the providers in poller.py are budgeted. The only real
# ceiling is throughput, far above anything this will produce.
SEND_BATCH = 100
RECEIPT_BATCH = 100
HTTP_TIMEOUT = 20

# UNAUTHENTICATED WORKS TODAY, and that was verified against the live endpoint
# rather than assumed: a POST with no Authorization header is accepted and
# answered with a per-message result. Turning on "Enhanced Security for Push
# Notifications" in the Expo dashboard changes that, and the only fix is a
# token. Setting EXPO_ACCESS_TOKEN makes this send one; leaving it unset sends
# none. Either way the code is the same, so enabling the setting later needs an
# environment variable and not a deploy.
ACCESS_TOKEN = (os.getenv("EXPO_ACCESS_TOKEN") or "").strip()

# -- TIMING ------------------------------------------------------------------
# Expo asks for roughly fifteen minutes before a receipt is looked up.
RECEIPT_AFTER = timedelta(minutes=15)
# A claim with no send is retryable after this. Longer than any single HTTP
# timeout, so a slow call still in flight is never treated as abandoned.
CLAIM_STALE = timedelta(minutes=10)
# Expo keeps receipts about a day. After this a ticket is closed unread rather
# than asked about for ever.
TICKET_GIVE_UP = timedelta(hours=24)

# -- HOW LONG A MESSAGE IS STILL WORTH SENDING -------------------------------
#
# WRITTEN AFTER THE FIRST PASS SENT A BACKLOG. Nothing drained the outbox until
# the scheduler job existed, so the first run delivered eight messages at once,
# the oldest six hours old -- including a cancellation from six hours earlier,
# which reads as current news and is arguably worse than silence. That was a
# one-off, but the cause is not: any gap in this job, an outage, a paused
# scheduler, a bad deploy, ends the same way.
#
# NOT THE SAME QUESTION notify's WINDOWS ANSWER. Those gate whether a change is
# worth SAYING, measured against the flight's own schedule -- a gate change four
# hours out, a belt within ninety minutes of landing. This gates whether a thing
# already said is still worth DELIVERING, measured from when it was written.
# A message can pass the first test and fail this one, which is exactly what a
# backlog is.
#
# MEASURED FROM deliver_after WHEN THERE IS ONE. A cancellation written at 02:00
# and deferred to 07:00 for the night is five hours old the moment it becomes
# due, and dropping it would defeat the deferral it was given on purpose. The
# clock starts at the later of the two.
#
# THE NUMBERS ARE ABOUT WHAT THE READER CAN STILL DO. A belt number is useless
# once she has left the hall. A gate change goes stale fastest of all, because a
# stale one is not merely useless but wrong: gates move again, and an hour-old
# gate is a confident answer that may send her to the wrong pier. Terminal and
# cancellation get the longest lives, because both can still change what a
# person does hours later -- which terminal to drive to, and whether to travel
# at all.
STALE_AFTER = {
    notify.BELT: timedelta(minutes=45),
    notify.GATE: timedelta(minutes=30),
    notify.GATE_CAP: timedelta(minutes=30),
    notify.DELAY: timedelta(hours=1),
    notify.ON_TIME: timedelta(hours=1),
    notify.DEPARTED: timedelta(hours=1),
    notify.LANDED: timedelta(hours=1),
    notify.ARRIVAL_MOVED: timedelta(hours=1),
    notify.TERMINAL: timedelta(hours=2),
    notify.ARRIVAL_TERMINAL: timedelta(hours=2),
    notify.CANCELLED: timedelta(hours=2),
    notify.CANCEL_WITHDRAWN: timedelta(hours=2),
    notify.NEXT_FLIGHT: timedelta(hours=2),
    notify.DIVERTED: timedelta(hours=2),
}

# A kind this table has never heard of. An hour is the shortest life any kind
# here has other than the two that are shorter for stated reasons, so an
# unrecognised message errs towards silence rather than towards waking somebody
# about something nobody wrote a rule for.
STALE_DEFAULT = timedelta(hours=1)

# What a drop is called in the record. A string rather than a boolean, because
# there is already more than one way for a message to be decided against.
DROP_STALE = "stale"
DROP_UNRENDERABLE = "unrenderable"


def _useful_life(kind):
    return STALE_AFTER.get(kind, STALE_DEFAULT)


def _age(msg, now):
    """How long this message has been waiting, from when it became due."""
    written = _parse(msg.get("at"))
    due = _parse(msg.get("deliver_after"))
    start = max([t for t in (written, due) if t is not None], default=None)
    return None if start is None else now - start


# -- BOUNDS ------------------------------------------------------------------
# ONE STATE READ PER WATCHED FLIGHT PER PASS. That is inherent: receipts live on
# state objects, and the subject ladder needs a reader's OTHER flights to know
# whether to disambiguate. It is fine at today's size and would not be at the
# watch store's own ceiling, so the pass is bounded and takes the newest dates
# first, which is where anything live actually is.
MAX_FLIGHTS_PER_PASS = 400

# The error Expo returns for a token that no longer exists. It is the only one
# that means "stop trying", and it arrives in a ticket or in a receipt.
DEAD_TOKEN = "DeviceNotRegistered"


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def _parse(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _slot_id(msg_key, device_id):
    """One delivery: this message, to this device."""
    return "%s|%s" % (msg_key, device_id)


def _slots(doc):
    """The delivery record, always a dict.

    blank_state reserved `sent` as a list before there was anything to put in
    it. Any state object written before this module existed carries [], so a
    list is read as the empty map rather than as a broken document.
    """
    cur = (doc or {}).get("sent")
    return dict(cur) if isinstance(cur, dict) else {}


# -- WHO IS READING, AND WHAT ELSE THEY WATCH --------------------------------

def _reader_index(watched, states):
    """device_id -> flight_date -> [(city, departure clock)].

    THE SUBJECT LADDER NEEDS THE READER, NOT THE FLIGHT. "Your flight to Delhi"
    becomes "Your 9:30 PM flight to Delhi" only when that person watches more
    than one flight to Delhi that day, and picks up the airline only when two of
    those also share a time. watched_flights is indexed by flight, so this
    inverts it.

    The city and the time come from the last provider record already held on
    each state object, so a flight with nothing in its outbox still counts
    towards its reader's totals without costing a provider call.
    """
    index = {}
    for row in watched:
        doc = states.get((row["flight_number"], row["flight_date"]))
        dto = (doc or {}).get("dto")
        if not dto:
            continue
        facts = notify._facts(dto)
        dest = facts.get("destination") or {}
        city = dest.get("city") or dest.get("iata")
        when = " ".join((facts.get("scheduled_departure") or "").split()[:2])
        for device in row.get("devices") or []:
            did = device.get("device_id")
            if not did:
                continue
            index.setdefault(did, {}).setdefault(row["flight_date"], []).append((city, when))
    return index


def _counts(index, device_id, day, city, when):
    """(same_city, same_time) for this reader, this day, this destination."""
    rows = (index.get(device_id) or {}).get(day) or []
    same_city = sum(1 for c, _w in rows if c == city)
    same_time = sum(1 for c, w in rows if c == city and w == when)
    return max(same_city, 1), max(same_time, 1)


# -- THE WIRE ----------------------------------------------------------------

def _headers():
    head = {"Content-Type": "application/json", "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate"}
    if ACCESS_TOKEN:
        head["Authorization"] = "Bearer " + ACCESS_TOKEN
    return head


def _post(url, payload):
    """The one place this module touches the network."""
    resp = requests.post(url, json=payload, headers=_headers(), timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _envelope(msg, device, index):
    """One Expo message. Words from notify, routing from here."""
    owned = device.get("owned")
    dest = msg.get("destination") or {}
    city = dest.get("city") or dest.get("iata")
    when = " ".join((msg.get("scheduled_departure") or "").split()[:2])
    same_city, same_time = _counts(index, device.get("device_id"),
                                   msg.get("flight_date"), city, when)
    return {
        "to": device.get("push_token"),
        "title": notify.subject(msg, owned, same_city, same_time),
        "body": notify.render(msg, owned, same_city, same_time),
        "data": notify.deep_link(msg),
        "sound": "default",
        # A flight message is worthless once the flight has gone. Expo drops it
        # rather than waking somebody about a gate that changed yesterday.
        "ttl": 3600,
        "priority": "high",
    }


# -- PHASE ONE: RECEIPTS -----------------------------------------------------

def _ripe_tickets(states, now):
    """[(flight_key, slot_id, ticket_id)] for tickets old enough to ask about."""
    ripe = []
    for flight_key, doc in states.items():
        for slot_id, slot in _slots(doc).items():
            if slot.get("receipt_at") or not slot.get("ticket"):
                continue
            sent = _parse(slot.get("sent_at"))
            if sent is None or now - sent < RECEIPT_AFTER:
                continue
            ripe.append((flight_key, slot_id, slot["ticket"]))
    return ripe


def collect_receipts(states, now, post=None):
    """Ask Expo what actually happened, and act on what it says.

    A RECEIPT IS THE ONLY HONEST ANSWER. The ticket returned at send time says
    Expo accepted the message, not that Apple delivered it. DeviceNotRegistered
    arrives here as often as it arrives there.
    """
    post = post or _post
    ripe = _ripe_tickets(states, now)
    if not ripe:
        return {"asked": 0, "ok": 0, "failed": 0, "dead_tokens": 0}

    by_ticket = {ticket: (fk, sid) for fk, sid, ticket in ripe}
    results, asked = {}, 0
    for start in range(0, len(ripe), RECEIPT_BATCH):
        ids = [ticket for _fk, _sid, ticket in ripe[start:start + RECEIPT_BATCH]]
        asked += len(ids)
        try:
            body = post(RECEIPTS_URL, {"ids": ids})
        except Exception:
            # A receipt sweep that fails changes nothing. The tickets keep their
            # unanswered state and the next pass asks again.
            logger.exception("dispatch: receipt lookup failed")
            continue
        got = (body or {}).get("data") or {}
        if isinstance(got, dict):
            results.update(got)

    ok = failed = 0
    updates, dead_tokens = {}, set()
    for ticket, receipt in results.items():
        where = by_ticket.get(ticket)
        if where is None:
            continue
        flight_key, slot_id = where
        status = (receipt or {}).get("status")
        error = ((receipt or {}).get("details") or {}).get("error")
        if status == "ok":
            ok += 1
        else:
            failed += 1
            if error == DEAD_TOKEN:
                token = (_slots(states.get(flight_key)).get(slot_id) or {}).get("token")
                if token:
                    dead_tokens.add(token)
        updates.setdefault(flight_key, {})[slot_id] = {
            "receipt_at": _iso(now),
            "receipt_status": status,
            "receipt_error": error,
        }

    # A ticket nobody answered for after a day is closed rather than asked about
    # for ever. Expo stops keeping them at about that point.
    for flight_key, slot_id, ticket in ripe:
        if ticket in results:
            continue
        slot = _slots(states.get(flight_key)).get(slot_id) or {}
        sent = _parse(slot.get("sent_at"))
        if sent is not None and now - sent > TICKET_GIVE_UP:
            updates.setdefault(flight_key, {})[slot_id] = {
                "receipt_at": _iso(now), "receipt_status": "expired",
                "receipt_error": None,
            }

    for flight_key, changes in updates.items():
        _merge_slots(flight_key, changes, states)
    for token in dead_tokens:
        _forget(token)

    return {"asked": asked, "ok": ok, "failed": failed,
            "dead_tokens": len(dead_tokens)}


# -- PHASE TWO: SENDING ------------------------------------------------------

def _due(doc, now):
    """The outbox messages that are ready, in the order they were written."""
    ns = (doc or {}).get("notify") or {}
    out = []
    for msg in ns.get("outbox") or []:
        after = _parse(msg.get("deliver_after"))
        if after is not None and now < after:
            continue
        out.append(msg)
    return out


def _claimable(slot, now):
    """True when this (message, device) is ours to take.

    Never sent, or claimed by a pass that did not come back. A slot with a
    sent_at is finished for good: notify will not create that message again, so
    re-sending it would be a duplicate with no upstream check to stop it.
    """
    if not slot:
        return True
    if slot.get("sent_at") or slot.get("gave_up"):
        return False
    claimed = _parse(slot.get("claimed_at"))
    return claimed is None or now - claimed > CLAIM_STALE


def _plan(watched, states, now):
    """(work, drops).

    work  [(flight_key, slot_id, device, envelope)] -- ready to send.
    drops [(flight_key, slot_id, kind, age)] -- too old to be worth sending.

    THE ORDER OF THE THREE CHECKS MATTERS. Claimable comes first, so a slot
    already sent or already dropped is skipped without being reconsidered --
    otherwise a stale message would be re-dropped and re-written on every pass
    for as long as it sat in the outbox. Staleness comes next, so an old message
    costs no envelope. Only what survives both becomes work.
    """
    index = _reader_index(watched, states)
    work, drops = [], []
    for row in watched:
        flight_key = (row["flight_number"], row["flight_date"])
        doc = states.get(flight_key)
        if doc is None:
            continue
        slots = _slots(doc)
        for msg in _due(doc, now):
            age = _age(msg, now)
            stale = age is not None and age > _useful_life(msg.get("kind"))
            for device in row.get("devices") or []:
                token, did = device.get("push_token"), device.get("device_id")
                if not token or not did:
                    continue
                slot_id = _slot_id(msg.get("key"), did)
                if not _claimable(slots.get(slot_id), now):
                    continue
                if stale:
                    drops.append((flight_key, slot_id, msg.get("kind"), age, DROP_STALE))
                    continue
                # ONE BAD MESSAGE MUST NOT SILENCE EVERY OTHER FLIGHT. notify's
                # renderers read their own `values` by key, so a message written
                # by an older version of notify, or by a kind whose shape has
                # changed since, raises rather than returning a sentence. Left
                # unguarded that exception leaves _plan, leaves send_due, and
                # ends the whole pass -- so a single malformed row in one
                # flight's outbox would stop delivery for everybody, every
                # minute, until somebody noticed. It is dropped like a stale one
                # instead, under its own reason, and the traceback goes to the
                # log where it can be found.
                try:
                    envelope = _envelope(msg, device, index)
                except Exception:
                    logger.exception("dispatch: could not render a %s for %s/%s",
                                     msg.get("kind"), flight_key[0], flight_key[1])
                    drops.append((flight_key, slot_id, msg.get("kind"), age, DROP_UNRENDERABLE))
                    continue
                work.append((flight_key, slot_id, device, envelope))
    return work, drops


def send_due(watched, states, now, post=None):
    """Claim, send, confirm."""
    post = post or _post
    work, drops = _plan(watched, states, now)

    # RECORDED, NOT JUST SKIPPED. gave_up is what stops _claimable ever offering
    # the slot again, and drop_reason is what says why it was never sent -- the
    # difference between a message that failed and one this module decided
    # against. The age is kept in seconds because the question asked of this
    # record later is always "how late was it", never "when was it".
    dropped = {}
    for flight_key, slot_id, kind, age, reason in drops:
        dropped.setdefault(flight_key, {})[slot_id] = {
            "gave_up": True,
            "drop_reason": reason,
            "dropped_at": _iso(now),
            "kind": kind,
            "age_s": int(age.total_seconds()) if age is not None else None,
        }
    for flight_key, changes in dropped.items():
        _merge_slots(flight_key, changes, states)
    for flight_key, _slot_id, kind, age, reason in drops:
        if reason == DROP_STALE:
            logger.info("dispatch: dropped a stale %s for %s/%s, %d minutes late",
                        kind, flight_key[0], flight_key[1],
                        int(age.total_seconds() // 60) if age is not None else -1)

    if not work:
        return {"queued": 0, "sent": 0, "failed": 0, "dead_tokens": 0,
                "dropped": len(drops)}

    # CLAIMED BEFORE THE CALL, one write per flight. Two instances cannot both
    # take the same slot, because the write goes through the same generation
    # precondition the poller uses.
    claims = {}
    for flight_key, slot_id, device, _env in work:
        claims.setdefault(flight_key, {})[slot_id] = {
            "claimed_at": _iso(now), "token": device.get("push_token"),
            "device_id": device.get("device_id"),
        }
    for flight_key, changes in claims.items():
        _merge_slots(flight_key, changes, states)

    sent = failed = 0
    results, dead_tokens = {}, set()
    for start in range(0, len(work), SEND_BATCH):
        chunk = work[start:start + SEND_BATCH]
        try:
            body = post(SEND_URL, [env for _fk, _sid, _dev, env in chunk])
        except Exception:
            # The claims stand and go stale. The next pass tries again.
            logger.exception("dispatch: send failed for %d messages", len(chunk))
            failed += len(chunk)
            continue
        tickets = (body or {}).get("data")
        if isinstance(tickets, dict):
            tickets = [tickets]
        if not isinstance(tickets, list):
            tickets = []
        for i, (flight_key, slot_id, device, _env) in enumerate(chunk):
            ticket = tickets[i] if i < len(tickets) else None
            status = (ticket or {}).get("status")
            error = ((ticket or {}).get("details") or {}).get("error")
            if status == "ok":
                sent += 1
                results.setdefault(flight_key, {})[slot_id] = {
                    "sent_at": _iso(now), "ticket": ticket.get("id"),
                }
                continue
            failed += 1
            if error == DEAD_TOKEN:
                # Nothing to retry. The token is gone, and so are that device's
                # watches once _forget runs.
                dead_tokens.add(device.get("push_token"))
                results.setdefault(flight_key, {})[slot_id] = {
                    "gave_up": True, "send_error": error,
                }
            else:
                # Rate limits and anything unrecognised are transient. Clearing
                # the claim lets the next pass pick it up rather than waiting
                # out CLAIM_STALE.
                results.setdefault(flight_key, {})[slot_id] = {
                    "claimed_at": None, "send_error": error or status,
                }

    for flight_key, changes in results.items():
        _merge_slots(flight_key, changes, states)
    for token in dead_tokens:
        _forget(token)

    return {"queued": len(work), "sent": sent, "failed": failed,
            "dead_tokens": len(dead_tokens), "dropped": len(drops)}


# -- WRITING IT DOWN ---------------------------------------------------------

def _apply_fields(slot, fields):
    """One slot, updated. A None claimed_at REMOVES the claim rather than
    storing a null, because _claimable reads its absence as free."""
    out = dict(slot or {})
    for name, value in fields.items():
        if name == "claimed_at" and value is None:
            out.pop("claimed_at", None)
        else:
            out[name] = value
    return out


def _merge_slots(flight_key, changes, states):
    """Merge per-slot fields into a flight's delivery record.

    THROUGH mutate_state, so it lands under the same generation precondition
    the poller writes with and a poll running in the same second cannot lose
    it. The apply function works on the document mutate_state hands back, never
    on the copy this pass read, which is the whole point of the precondition.
    """
    number, day = flight_key

    def apply(doc):
        if doc is None:
            return None
        slots = _slots(doc)
        for slot_id, fields in changes.items():
            slots[slot_id] = _apply_fields(slots.get(slot_id), fields)
        doc["sent"] = _prune_slots(slots, doc)
        return doc

    if not pollstate.mutate_state(number, day, apply):
        logger.warning("dispatch: could not record delivery for %s/%s", number, day)
        return False

    # The in-pass copy is kept in step, so the send phase sees the claims the
    # same pass just wrote and a second pass over the same states cannot double
    # up.
    doc = states.get(flight_key)
    if doc is not None:
        slots = _slots(doc)
        for slot_id, fields in changes.items():
            slots[slot_id] = _apply_fields(slots.get(slot_id), fields)
        doc["sent"] = slots
    return True


def _prune_slots(slots, doc):
    """Bounded, like everything else written to a state object.

    Tied to the outbox rather than to a clock: a delivery record for a message
    that has fallen out of the outbox can never be consulted again, because
    nothing will look that slot up. notify caps the outbox at OUTBOX_MAX, so
    this caps with it.
    """
    ns = (doc or {}).get("notify") or {}
    live = {m.get("key") for m in (ns.get("outbox") or [])}
    return {sid: slot for sid, slot in slots.items()
            if sid.split("|", 1)[0] in live}


def _forget(token):
    """A dead token, and the watches only it could have reached."""
    result = store.forget_push_token(token)
    if not (result or {}).get("ok"):
        logger.warning("dispatch: could not drop a dead token: %s",
                       (result or {}).get("error"))
    else:
        logger.info("dispatch: dropped %d watch(es) for a dead token",
                    result.get("removed", 0))


# -- ONE PASS ----------------------------------------------------------------

def run_once(now=None, post=None):
    now = now or _now()
    watched = store.watched_flights()
    if watched is None:
        # UNREADABLE IS NOT EMPTY. store.watched_flights draws that distinction
        # deliberately; collapsing it here would make an unreadable store look
        # like a quiet one, and this pass would report success for ever while
        # nobody was told anything.
        logger.warning("dispatch: the watch store could not be read")
        return {"ok": False, "error": "watch store unreadable"}

    watched = watched[:MAX_FLIGHTS_PER_PASS]
    states = {}
    for row in watched:
        doc, _gen = pollstate.read_state(row["flight_number"], row["flight_date"])
        if doc is not None:
            states[(row["flight_number"], row["flight_date"])] = doc

    receipts = collect_receipts(states, now, post=post)
    sends = send_due(watched, states, now, post=post)

    out = {
        "ok": True,
        "flights": len(watched),
        "states": len(states),
        "queued": sends["queued"],
        "sent": sends["sent"],
        "send_failed": sends["failed"],
        "dropped_stale": sends["dropped"],
        "receipts_asked": receipts["asked"],
        "receipts_ok": receipts["ok"],
        "receipts_failed": receipts["failed"],
        "dead_tokens": sends["dead_tokens"] + receipts["dead_tokens"],
    }
    logger.info("dispatch: %d flights, %d sent, %d dropped stale, %d receipts asked, "
                "%d dead tokens", out["flights"], out["sent"], out["dropped_stale"],
                out["receipts_asked"], out["dead_tokens"])
    return out
