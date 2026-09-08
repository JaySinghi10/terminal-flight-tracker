"""Which changes are worth waking someone for, and what to say.

WHAT THIS IS. The poller records every change it sees in a ledger (see the
`pending` list in pollstate). Most of those changes are not worth a
notification: an estimate drifting by two minutes, a gate flapping seventeen
hours before departure, an arrival gate nobody acts on. This module holds the
rules that turn the CURRENT record into the few messages a person would want,
and the text of each.

THE ONE PRINCIPLE EVERYTHING FOLLOWS FROM: a message is derived from the
current record against the last state we TOLD the person, never from the
change entries one by one. The entries are folded into the record before this
runs, and one decision runs. So a gate that goes 84, 87A, 84 between two polls
is invisible, because the current value equals the last one notified; and a
revert AFTER a message was sent is a real change and gets its own message.

WHAT IS SENT IS FACTS, NOT SENTENCES. A message in the outbox carries the
kind, the flight, both cities, the scheduled time and the values that changed.
The sentence is written at delivery, by render(), when the sender has the
recipient's own watch list in hand -- because the SUBJECT of the sentence
depends on who is reading it. "Your flight to Bangalore" is right for the
person on it; "The flight from Mumbai" is right for the person meeting it; and
someone watching two flights to the same city that day needs the time in the
subject. See subject().

NOTHING HERE SENDS. Push needs a dev build that does not exist yet. The outbox
fills, bounded, and the sender drains it when it exists. See the note at the
top of pollstate.py.

NEVER SEND THE PERSON TO THE AIRLINE. A cancellation names the next departure
on the route, found with the same route board the app uses; if nothing leaves
for days the search continues across polls and names the first flight that
does exist, however far out. A diversion says plainly that the aircraft went
somewhere else and that we do not yet know where, because the schedule
provider carries no diversion airport.

NEVER CLAIM WHAT THE DATA DOES NOT SUPPORT. An estimate is "around"; a fact
from a landing feed is a plain time; a gate we were not given is not mentioned;
a "departed" is only said once the actual time is in the past AND has held for
two polls, because the provider has been seen to revise an "actual" by
fifty-three minutes (6E6188, 7 Sep 2026, in the ledger).
"""
import hashlib
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

# ── KINDS ───────────────────────────────────────────────────────────────────
CANCELLED = "cancelled"
CANCEL_WITHDRAWN = "cancel_withdrawn"
NEXT_FLIGHT = "next_flight"          # the follow-up when the search finds one later
GATE = "gate"
GATE_CAP = "gate_cap"
TERMINAL = "terminal"
DELAY = "delay"
ON_TIME = "on_time"
DEPARTED = "departed"
ARRIVAL_MOVED = "arrival_moved"
ARRIVAL_TERMINAL = "arrival_terminal"
LANDED = "landed"
BELT = "belt"
DIVERTED = "diverted"

# ── THE WINDOWS ─────────────────────────────────────────────────────────────
# A gate change three days out is not the same as one while she is walking to
# the gate. Outside these windows the change is swallowed; the app shows the
# current value whenever it is opened.
GATE_WINDOW = timedelta(hours=4)
TERMINAL_WINDOW = timedelta(hours=24)
DELAY_WINDOW = timedelta(hours=12)
BELT_WINDOW = timedelta(minutes=90)

# ── THE THRESHOLDS ──────────────────────────────────────────────────────────
DELAY_MIN = timedelta(minutes=15)       # the first delay notice
DELAY_STEP = timedelta(minutes=15)      # a further notice needs this much movement
DELAY_FLOOR = timedelta(minutes=30)     # ...and this long since the last one
ON_TIME_TOLERANCE = timedelta(minutes=5)
ARRIVAL_STEP = timedelta(minutes=15)

# A VALUE MUST HOLD FOR TWO CONSECUTIVE POLLS before it is worth a message:
# a gate that flips and flips back inside one poll interval was never the gate.
# Cancellation, landing and diversion are exempt -- a landing is already
# confirmed by the feed, and a cancellation that waits thirty minutes at the
# day tier is a cancellation the person hears about late.
SETTLE_POLLS = 2

GATE_CAP_COUNT = 3                      # gate messages per flight, then one cap notice
BELT_CAP_COUNT = 2
# One message per flight per twenty minutes, so a busy ten minutes does not
# become five buzzes. Cancelled, landed and diverted are exempt.
FLIGHT_FLOOR = timedelta(minutes=20)
# Belt is exempt too: it follows a landing by minutes, is capped at two, and
# is the one thing the person at arrivals is waiting to hear.
FLOOR_EXEMPT = {CANCELLED, CANCEL_WITHDRAWN, LANDED, DIVERTED, NEXT_FLIGHT, BELT}

# A cancellation of a flight more than a day away that lands in the night at
# the departure airport is DEFERRED to seven in the morning there, not dropped.
QUIET_START_HOUR = 22
QUIET_END_HOUR = 7
QUIET_ONLY_BEYOND = timedelta(hours=24)

# ── THE NEXT-FLIGHT SEARCH ──────────────────────────────────────────────────
# A dated board costs two provider calls (the provider caps a range at twelve
# hours, so a day is two windows). The first pass looks three days ahead in
# the same poll, which is the common case answered at once; after that the
# search continues two days per poll until it finds a flight or reaches the
# board's evidenced ceiling. So a route with nothing for a fortnight costs
# ~30 calls spread over six polls, and never a burst.
NEXT_FIRST_PASS_DAYS = 3
NEXT_DAYS_PER_POLL = 2
NEXT_MAX_DAYS = 60                      # mcp_server.ROUTE_MAX_FUTURE_DAYS, the evidenced limit
NEXT_CALLS_PER_DAY = 2

OUTBOX_MAX = 40

STATUS_CANCELLED = "cancelled"
STATUS_DIVERTED = "diverted"
LANDING_LANDED = "landed"


# ── TIME HELPERS ────────────────────────────────────────────────────────────
def _parse(iso):
    """An aware datetime from the DTO's ISO strings, or None."""
    if not iso or not isinstance(iso, str):
        return None
    s = iso.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S%z")


def _clock(dt):
    """'9:30 PM' -- the DTO's own style, so computed times read like given ones."""
    return dt.strftime("%I:%M %p").lstrip("0")


def _tz_label(dto_time_string):
    """'IST' from '9:30 PM IST'. The DTO already carries the airport's label;
    reusing it is how a computed time never invents a zone name."""
    parts = str(dto_time_string or "").split()
    return parts[-1] if len(parts) >= 3 else ""


def _minutes(td):
    return int(round(td.total_seconds() / 60))


def _duration(td):
    m = abs(_minutes(td))
    if m < 60:
        return "%d min" % m
    h, r = divmod(m, 60)
    return "%d h" % h if r == 0 else "%d h %02d min" % (h, r)


def _day_label(dt, now):
    """'today', 'tomorrow', 'Thursday', or '25 Sep' when it is a week or more."""
    d = (dt.date() - now.astimezone(dt.tzinfo).date()).days
    if d <= 0:
        return "today"
    if d == 1:
        return "tomorrow"
    if d < 7:
        return dt.strftime("%A")
    return dt.strftime("%d %b").lstrip("0")


# ── THE RECORD, READ ────────────────────────────────────────────────────────
def _facts(dto):
    dep, arr = dto.get("departure") or {}, dto.get("arrival") or {}
    return {
        "flight_number": dto.get("flight_number"),
        "flight_date": dto.get("flight_date"),
        "airline": dto.get("airline"),
        "origin": {"iata": dep.get("iata"), "city": dep.get("city")},
        "destination": {"iata": arr.get("iata"), "city": arr.get("city")},
        "scheduled_departure": dep.get("scheduled"),
        "scheduled_departure_iso": dep.get("scheduled_iso"),
        "scheduled_arrival": arr.get("scheduled"),
        "scheduled_arrival_iso": arr.get("scheduled_iso"),
    }


def _key(facts, kind, value=""):
    raw = "%s|%s|%s|%s" % (facts.get("flight_number"), facts.get("flight_date"), kind, value)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def blank_notify_state():
    return {
        "version": 1,
        "seeded": False,
        "notified": {},        # field -> value last told
        "settle": {},          # field -> {"value", "polls"}
        "counts": {},          # kind -> messages sent
        "last_msg_at": None,
        "last_delay_at": None,
        "last_arrival_at": None,
        "outbox": [],
        "keys": [],
        "next_search": None,
    }


def _settled(ns, field, value):
    """True once `value` has been seen SETTLE_POLLS polls in a row."""
    cur = ns["settle"].get(field)
    if cur and cur.get("value") == value:
        cur["polls"] = int(cur.get("polls", 0)) + 1
    else:
        ns["settle"][field] = cur = {"value": value, "polls": 1}
    return cur["polls"] >= SETTLE_POLLS


# ── THE DECISION ────────────────────────────────────────────────────────────
def decide(ns, dto, landing, now, lookup_next=None):
    """(new_state, messages). dto is the CURRENT record; landing the current
    landing answer or None; lookup_next(origin, dest, day) -> rows, or None
    when the caller has no budget for it this poll.

    Pure over its inputs apart from lookup_next, which is the one call that
    leaves the process, and it is only made on a cancellation."""
    ns = dict(ns or blank_notify_state())
    ns["settle"] = dict(ns.get("settle") or {})
    ns["notified"] = dict(ns.get("notified") or {})
    ns["counts"] = dict(ns.get("counts") or {})
    ns["keys"] = list(ns.get("keys") or [])
    ns["outbox"] = list(ns.get("outbox") or [])
    out = []
    if not isinstance(dto, dict):
        return ns, out

    facts = _facts(dto)
    dep, arr = dto.get("departure") or {}, dto.get("arrival") or {}
    sched_dep = _parse(dep.get("scheduled_iso"))
    sched_arr = _parse(arr.get("scheduled_iso"))
    est_dep = _parse(dep.get("estimated_iso"))
    act_dep = _parse(dep.get("actual_iso"))
    est_arr = _parse(arr.get("estimated_iso"))
    status = dto.get("status")
    landed = isinstance(landing, dict) and landing.get("outcome") == LANDING_LANDED
    before_dep = sched_dep is not None and now < sched_dep
    until_dep = (sched_dep - now) if before_dep else timedelta(0)
    departed_told = "departed" in ns["notified"]

    # ── FIRST SIGHT SEEDS AND SAYS NOTHING. Everything about a flight is new
    # the first time; reporting it would be a notification per field.
    if not ns.get("seeded"):
        ns["seeded"] = True
        ns["notified"].update({
            "gate": dep.get("gate"), "terminal": dep.get("terminal"),
            "arrival_terminal": arr.get("terminal"),
            "status": status,
            "delay_min": 0,
        })
        if act_dep is not None and now > act_dep:
            ns["notified"]["departed"] = dep.get("actual_iso")
            due = est_arr or sched_arr
            ns["last_arrival_at"] = _iso(due) if due else None
        if landed:
            ns["notified"]["landed"] = landing.get("landed_utc")
            ns["notified"]["belt"] = arr.get("baggage")
        return ns, out

    def emit(kind, values, deliver_after=None, key_value=""):
        k = _key(facts, kind, key_value)
        if k in ns["keys"]:
            return False
        last = _parse(ns.get("last_msg_at"))
        if kind not in FLOOR_EXEMPT and last is not None and now - last < FLIGHT_FLOOR:
            return False
        msg = dict(facts)
        msg.update({"key": k, "kind": kind, "at": _iso(now),
                    "deliver_after": _iso(deliver_after) if deliver_after else None,
                    "values": values})
        out.append(msg)
        ns["keys"] = (ns["keys"] + [k])[-200:]
        ns["outbox"] = (ns["outbox"] + [msg])[-OUTBOX_MAX:]
        ns["counts"][kind] = int(ns["counts"].get(kind, 0)) + 1
        ns["last_msg_at"] = _iso(now)
        return True

    # ── CANCELLED ── any time before departure, deferred through the night when far out
    if status == STATUS_CANCELLED and ns["notified"].get("status") != STATUS_CANCELLED:
        ns["notified"]["status"] = STATUS_CANCELLED
        deliver_after = _quiet_deferral(now, sched_dep, dep.get("timezone"))
        found, search = _search_next(facts, dto, now, None, lookup_next, NEXT_FIRST_PASS_DAYS)
        ns["next_search"] = search
        values = {"next": found, "searching": found is None and not search.get("done")}
        if found is None and search.get("done"):
            values["none_within_days"] = NEXT_MAX_DAYS
        emit(CANCELLED, values, deliver_after=deliver_after)
        return ns, out

    # ── THE SEARCH CONTINUES across polls until it finds a flight or hits the ceiling
    search = ns.get("next_search")
    if search and not search.get("done") and lookup_next is not None:
        found, search = _search_next(facts, dto, now, search, lookup_next, NEXT_DAYS_PER_POLL)
        ns["next_search"] = search
        if found is not None:
            emit(NEXT_FLIGHT, {"next": found}, key_value=found.get("flight_number", ""))
        elif search.get("done"):
            emit(NEXT_FLIGHT, {"next": None, "none_within_days": NEXT_MAX_DAYS})

    if ns["notified"].get("status") == STATUS_CANCELLED:
        if status != STATUS_CANCELLED and status is not None:
            ns["notified"]["status"] = status
            emit(CANCEL_WITHDRAWN, {"scheduled": dep.get("scheduled")})
        return ns, out

    # ── DIVERTED
    if status == STATUS_DIVERTED and ns["notified"].get("status") != STATUS_DIVERTED:
        ns["notified"]["status"] = STATUS_DIVERTED
        emit(DIVERTED, {})

    # ── LANDED ── once, from the landing feed only
    if landed and "landed" not in ns["notified"]:
        ns["notified"]["landed"] = landing.get("landed_utc")
        when = _parse(landing.get("landed_utc"))
        local = _to_zone(when, arr.get("timezone"))
        belt = arr.get("baggage")
        if belt:
            ns["notified"]["belt"] = belt
            ns["counts"][BELT] = int(ns["counts"].get(BELT, 0)) + 1
        emit(LANDED, {"time": _clock(local) if local else None,
                      "tz": _tz_label(arr.get("scheduled")),
                      "belt": belt,
                      "elsewhere": bool(landing.get("diverted_to"))})
        return ns, out

    # ── BELT ── only after landing, inside the window
    if "landed" in ns["notified"]:
        when = _parse(ns["notified"].get("landed"))
        belt = arr.get("baggage")
        if (belt and belt != ns["notified"].get("belt") and when is not None
                and now - when <= BELT_WINDOW
                and int(ns["counts"].get(BELT, 0)) < BELT_CAP_COUNT
                and _settled(ns, "belt", belt)):
            ns["notified"]["belt"] = belt
            emit(BELT, {"belt": belt}, key_value=belt)
        return ns, out

    # ── DEPARTED ── the actual is in the past and has held for two polls
    if not departed_told and act_dep is not None and now > act_dep:
        if _settled(ns, "departed", dep.get("actual_iso")):
            ns["notified"]["departed"] = dep.get("actual_iso")
            due = est_arr or sched_arr
            ns["last_arrival_at"] = _iso(due) if due else None
            emit(DEPARTED, {"due": _clock(due) if due else None,
                            "tz": _tz_label(arr.get("scheduled"))})
            return ns, out

    # ── AFTER DEPARTURE: the person meeting the flight
    if departed_told:
        if est_arr is not None:
            last = _parse(ns.get("last_arrival_at"))
            if last is None or abs(est_arr - last) >= ARRIVAL_STEP:
                last_msg = _parse(ns.get("last_msg_at"))
                if last_msg is None or now - last_msg >= DELAY_FLOOR:
                    delta = est_arr - last if last is not None else timedelta(0)
                    if emit(ARRIVAL_MOVED, {"due": _clock(est_arr), "tz": _tz_label(arr.get("scheduled")),
                                            "later_by": _minutes(delta)}):
                        ns["last_arrival_at"] = _iso(est_arr)
        at = arr.get("terminal")
        if at and ns["notified"].get("arrival_terminal") and at != ns["notified"]["arrival_terminal"]:
            if _settled(ns, "arrival_terminal", at):
                emit(ARRIVAL_TERMINAL, {"terminal": at, "was": ns["notified"]["arrival_terminal"]}, key_value=at)
                ns["notified"]["arrival_terminal"] = at
        return ns, out

    # ── BEFORE DEPARTURE ──
    # Terminal: inside 24 hours, on a change from the known value
    term = dep.get("terminal")
    if (before_dep and until_dep <= TERMINAL_WINDOW and term
            and ns["notified"].get("terminal") and term != ns["notified"]["terminal"]
            and _settled(ns, "terminal", term)):
        if emit(TERMINAL, {"terminal": term, "was": ns["notified"]["terminal"]}, key_value=term):
            ns["notified"]["terminal"] = term

    # Gate: inside four hours, settled, against the last gate TOLD, capped.
    #
    # THE BASELINE IS TAKEN WHEN THE WINDOW OPENS. Whatever the gate is at
    # four hours out is the known gate from then on -- the app shows it, and
    # nothing about it is news. Only what changes INSIDE the window is a
    # message; seven changes at seventeen hours out are not, and neither is the
    # difference between the gate seeded a day ago and the one at T-4h.
    gate = dep.get("gate")
    in_gate_window = before_dep and until_dep <= GATE_WINDOW
    if in_gate_window and not ns.get("gate_window_open"):
        ns["gate_window_open"] = True
        ns["notified"]["gate"] = gate
        ns["settle"].pop("gate", None)
    elif in_gate_window and gate and gate != ns["notified"].get("gate"):
        if _settled(ns, "gate", gate):
            n = int(ns["counts"].get(GATE, 0))
            if n < GATE_CAP_COUNT:
                if emit(GATE, {"gate": gate, "was": ns["notified"].get("gate"), "terminal": term}, key_value=gate):
                    ns["notified"]["gate"] = gate
            elif int(ns["counts"].get(GATE_CAP, 0)) == 0:
                emit(GATE_CAP, {})
                ns["notified"]["gate"] = gate

    # Delay: inside twelve hours, in bands of fifteen minutes, thirty minutes apart
    if before_dep and until_dep <= DELAY_WINDOW and sched_dep is not None:
        delay = (est_dep - sched_dep) if est_dep is not None else timedelta(0)
        told = timedelta(minutes=int(ns["notified"].get("delay_min") or 0))
        last = _parse(ns.get("last_delay_at"))
        floor_ok = last is None or now - last >= DELAY_FLOOR
        tz = _tz_label(dep.get("scheduled"))
        if delay >= DELAY_MIN and abs(delay - told) >= DELAY_STEP and floor_ok:
            if _settled(ns, "delay", _minutes(delay)):
                kind_hint = "first" if told < DELAY_MIN else ("more" if delay > told else "less")
                if emit(DELAY, {"delay_min": _minutes(delay), "expected": _clock(est_dep), "tz": tz,
                                "change": kind_hint}, key_value=str(_minutes(delay))):
                    ns["notified"]["delay_min"] = _minutes(delay)
                    ns["last_delay_at"] = _iso(now)
        elif delay <= ON_TIME_TOLERANCE and told >= DELAY_MIN and floor_ok:
            if _settled(ns, "delay", _minutes(delay)):
                if emit(ON_TIME, {"scheduled": dep.get("scheduled")}):
                    ns["notified"]["delay_min"] = 0
                    ns["last_delay_at"] = _iso(now)

    return ns, out


def _to_zone(dt, tz_name):
    if dt is None:
        return None
    if tz_name and ZoneInfo is not None:
        try:
            return dt.astimezone(ZoneInfo(tz_name))
        except Exception:
            pass
    return dt


def _quiet_deferral(now, sched_dep, tz_name):
    """07:00 local at the departure airport, when a cancellation of a flight
    more than a day away lands in the night there. Otherwise None."""
    if sched_dep is None or sched_dep - now <= QUIET_ONLY_BEYOND:
        return None
    local = _to_zone(now, tz_name)
    if local.hour >= QUIET_START_HOUR:
        target = (local + timedelta(days=1)).replace(hour=QUIET_END_HOUR, minute=0, second=0, microsecond=0)
    elif local.hour < QUIET_END_HOUR:
        target = local.replace(hour=QUIET_END_HOUR, minute=0, second=0, microsecond=0)
    else:
        return None
    return target.astimezone(timezone.utc)


def _search_next(facts, dto, now, search, lookup_next, days):
    """Walk the route board forward. Returns (found or None, search state).

    search state: {"from": iso of the cancelled departure, "next_day": the
    next local day to ask about, "days_searched": n, "done": bool}."""
    dep = dto.get("departure") or {}
    origin, dest = facts["origin"]["iata"], facts["destination"]["iata"]
    sched = _parse(dep.get("scheduled_iso")) or now
    after = max(sched, now)
    if search is None:
        search = {"from": _iso(after), "next_day": after.date().isoformat(),
                  "days_searched": 0, "done": False, "found": None}
    search = dict(search)
    if lookup_next is None or not origin or not dest:
        return None, search
    own = str(facts.get("flight_number") or "").upper()
    for _ in range(days):
        if search["days_searched"] >= NEXT_MAX_DAYS:
            search["done"] = True
            break
        day = search["next_day"]
        try:
            rows = lookup_next(origin, dest, day) or []
        except Exception:
            # THE LOOKUP REFUSED -- the run's budget is spent, or the board is
            # down. That day has NOT been searched: stop here without advancing,
            # and the next poll asks about the same day.
            break
        search["days_searched"] += 1
        search["next_day"] = (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat()
        best = None
        for r in rows:
            t = _parse(r.get("departure_scheduled_iso"))
            if t is None or t <= after:
                continue
            if str(r.get("status") or "") == STATUS_CANCELLED:
                continue
            if str(r.get("flight_number") or "").upper() == own and t.date() == after.date():
                continue
            if best is None or t < best[0]:
                best = (t, r)
        if best is not None:
            t, r = best
            found = {"flight_number": r.get("flight_number"), "airline": r.get("airline"),
                     "time": _clock(t), "tz": _tz_label(r.get("departure_scheduled")),
                     "day": _day_label(t, now), "date": t.date().isoformat(),
                     "iso": r.get("departure_scheduled_iso")}
            search["done"] = True
            search["found"] = found
            return found, search
    if search["days_searched"] >= NEXT_MAX_DAYS:
        search["done"] = True
    return None, search


# ── THE SENTENCE, WRITTEN FOR ONE READER ────────────────────────────────────
def subject(msg, owned=True, same_city=1, same_time=1):
    """The thing the message is about, for THIS reader.

    owned: the reader is on the flight (True) or meeting it (False). None is
    treated as on it, which is what the app registers by default.
    same_city: how many flights to this city the reader watches that day.
    same_time: of those, how many share this scheduled time."""
    city_to = (msg.get("destination") or {}).get("city") or (msg.get("destination") or {}).get("iata") or "your destination"
    city_from = (msg.get("origin") or {}).get("city") or (msg.get("origin") or {}).get("iata") or "the origin"
    when = " ".join((msg.get("scheduled_departure") or "").split()[:2])  # '9:30 PM', no zone
    airline = msg.get("airline") or ""
    parts = []
    if same_city > 1 and when:
        parts.append(when)
    if same_time > 1 and airline:
        parts.append(airline)
    qualifier = (" ".join(parts) + " ") if parts else ""
    if owned is False:
        return "The %sflight from %s" % (qualifier, city_from)
    return "Your %sflight to %s" % (qualifier, city_to)


def render(msg, owned=True, same_city=1, same_time=1):
    """One sentence or two. Facts in, words out; nothing here decides."""
    s = subject(msg, owned, same_city, same_time)
    v = msg.get("values") or {}
    k = msg.get("kind")
    city_to = (msg.get("destination") or {}).get("city") or "your destination"
    city_from = (msg.get("origin") or {}).get("city") or "the origin"
    tz = (" " + v["tz"]) if v.get("tz") else ""

    if k == CANCELLED:
        nxt = v.get("next")
        if nxt:
            return "%s is cancelled. The next one leaves %s at %s, %s %s." % (
                s, nxt.get("day"), nxt.get("time"), nxt.get("airline") or "", nxt.get("flight_number") or "")
        if v.get("none_within_days"):
            return "%s is cancelled. Nothing else is in the schedule for the next %d days, which is as far as the schedule reaches." % (s, v["none_within_days"])
        return "%s is cancelled. Terminal is looking for the next departure and will tell you." % s
    if k == NEXT_FLIGHT:
        nxt = v.get("next")
        if nxt:
            return "The next flight to %s leaves %s at %s, %s %s." % (
                city_to, nxt.get("day"), nxt.get("time"), nxt.get("airline") or "", nxt.get("flight_number") or "")
        return "No flight to %s is in the schedule for the next %d days, which is as far as the schedule reaches." % (city_to, v.get("none_within_days") or NEXT_MAX_DAYS)
    if k == CANCEL_WITHDRAWN:
        return "%s is no longer showing as cancelled. Scheduled %s from %s." % (s, v.get("scheduled"), city_from)
    if k == GATE:
        if v.get("was"):
            return "%s has moved to gate %s, was %s." % (s, v["gate"], v["was"])
        term = (", Terminal %s" % v["terminal"]) if v.get("terminal") else ""
        return "%s departs from gate %s%s." % (s, v["gate"], term)
    if k == GATE_CAP:
        return "%s's gate keeps changing. Terminal will show the current one when you open it." % s
    if k == TERMINAL:
        return "%s now departs from Terminal %s, not Terminal %s." % (s, v["terminal"], v["was"])
    if k == DELAY:
        d = _duration(timedelta(minutes=v.get("delay_min") or 0))
        if v.get("change") == "more":
            return "%s is delayed further, now %s. Expected %s%s." % (s, d, v.get("expected"), tz)
        if v.get("change") == "less":
            return "%s's delay has shortened to %s. Expected %s%s." % (s, d, v.get("expected"), tz)
        return "%s is delayed %s. Now expected %s%s from %s." % (s, d, v.get("expected"), tz, city_from)
    if k == ON_TIME:
        return "%s is back on schedule, %s from %s." % (s, v.get("scheduled"), city_from)
    if k == DEPARTED:
        if v.get("due"):
            return "%s has left %s. Due around %s%s." % (s, city_from, v["due"], tz)
        return "%s has left %s." % (s, city_from)
    if k == ARRIVAL_MOVED:
        by = v.get("later_by") or 0
        tail = (", %s later" % _duration(timedelta(minutes=by))) if by > 0 else (", %s earlier" % _duration(timedelta(minutes=-by)) if by < 0 else "")
        return "%s is now due around %s%s%s." % (s, v.get("due"), tz, tail)
    if k == ARRIVAL_TERMINAL:
        return "%s now arrives at Terminal %s, not Terminal %s." % (s, v["terminal"], v["was"])
    if k == LANDED:
        where = (", though not at %s" % city_to) if v.get("elsewhere") else ""
        t = (", %s%s" % (v["time"], tz)) if v.get("time") else ""
        belt = (" Bags on belt %s." % v["belt"]) if v.get("belt") else ""
        return "%s has landed%s%s.%s" % (s, where, t, belt)
    if k == BELT:
        return "%s: bags on belt %s." % (s, v.get("belt"))
    if k == DIVERTED:
        return "%s has been diverted. Terminal does not yet know where it landed, and will say when it does." % s
    return "%s has an update." % s


def deep_link(msg):
    """What a tap opens. A cancellation opens the route list, earliest first;
    everything else opens the flight."""
    if msg.get("kind") in (CANCELLED, NEXT_FLIGHT):
        nxt = (msg.get("values") or {}).get("next") or {}
        return {"screen": "search", "from": (msg.get("origin") or {}).get("iata"),
                "to": (msg.get("destination") or {}).get("iata"),
                "date": nxt.get("date") or msg.get("flight_date"), "sort": "earliest"}
    return {"screen": "flight", "flight_number": msg.get("flight_number"), "date": msg.get("flight_date")}
