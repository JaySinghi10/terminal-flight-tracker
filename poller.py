"""One pass over every watched flight: what changed since we last looked.

Cloud Scheduler pokes /poll, /poll calls run_once(), and run_once() decides for
each watched flight whether it is due, asks the providers if it is, diffs the
answer against what pollstate.py stored, and writes the differences back.

IT DOES NOT SEND ANYTHING. That is deliberate and is the whole shape of this
pass: the ledger fills from day one, so when dispatch is built it has real
history to work against instead of being tested for the first time on live
notifications going to a real phone.

── THE TIERS, AND WHY THEY ARE NOT ONE INTERVAL ────────────────────────────────

A flight is interesting in bursts. Nothing happens for the eleven hours between
booking and boarding, and then four things happen in twenty minutes. Polling
every flight every two minutes would spend the month's units in three days;
polling everything every hour would tell somebody their gate changed after they
had walked to the old one.

  FAR       > 6h to departure      once every 6 hours
  DAY       6h .. 90m              every 30 minutes
  NEAR      90m before departure   every 5 minutes
  AIRBORNE  departed, not landed   every 15 minutes  (FR24 only, see below)
  ARRIVAL   30m before arrival     every 2 minutes
  DONE      landed and at a gate   never again

THE ARRIVAL TIER IS THE EXPENSIVE ONE AND IT IS THE ONE WORTH PAYING FOR. Gate,
belt and stand are all published in that window, and it is the only window where
a traveller is standing up waiting to act on what we say.

── WHICH PROVIDER GETS ASKED IS NOT THE SAME QUESTION AS WHETHER IT IS DUE ─────

AeroDataBox bills units and has a monthly allowance. FR24 bills credits and has
a much larger one. They are different currencies, so the tiers do not spend them
together:

  * AERODATABOX IS ASKED FOR SCHEDULE FACTS -- times, terminal, gate, belt,
    stand. Every tier asks it, subject to the budget floor.
  * FR24 IS ASKED WHETHER IT HAS LANDED, and nothing else. Only the AIRBORNE and
    ARRIVAL tiers ask, because before wheels-up the answer cannot be yes.

FR24 REMAINS THE ONLY THING THAT SAYS A FLIGHT HAS LANDED. This module does not
relitigate that; it calls fr24.landing_for and stores what comes back.

── THE BUDGET FLOOR IS A REFUSAL, NOT A WARNING ────────────────────────────────

pollstate.budget_floor() is units-per-day-remaining until the billing date. Below
it, the cheap tiers stop being polled entirely and only ARRIVAL runs. A month
that runs out on the 20th is worse than a month that polls the FAR tier half as
often, because the flights that matter are the ones about to land.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

import fr24
import pollstate
import store
from mcp_server import fetch_flight_full

logger = logging.getLogger("poller")

# ── THE TIERS ───────────────────────────────────────────────────────────────
FAR = "far"
DAY = "day"
NEAR = "near"
AIRBORNE = "airborne"
ARRIVAL = "arrival"
DONE = "done"

TIER_INTERVAL = {
    FAR: timedelta(hours=6),
    DAY: timedelta(minutes=30),
    NEAR: timedelta(minutes=5),
    AIRBORNE: timedelta(minutes=15),
    ARRIVAL: timedelta(minutes=2),
}

# Which tiers may ask FR24 whether it is down. Before wheels-up the answer
# cannot be yes, so asking is a credit spent on a guaranteed no.
FR24_TIERS = {AIRBORNE, ARRIVAL}

# Which tiers survive the budget floor. See the note at the top.
ESSENTIAL_TIERS = {ARRIVAL, AIRBORNE}

NEAR_BEFORE_DEPARTURE = timedelta(minutes=90)
DAY_BEFORE_DEPARTURE = timedelta(hours=6)
ARRIVAL_BEFORE_ARRIVAL = timedelta(minutes=30)

# HOW LONG AFTER A SCHEDULED ARRIVAL WE KEEP ASKING. A flight that never reports
# a landing -- diverted, or simply not covered -- would otherwise be polled at
# the two-minute rate for ever.
GIVE_UP_AFTER_ARRIVAL = timedelta(hours=3)

# A POLL MUST NOT BE SERVED DATA OLDER THAN ITS OWN TIER. See fetch_flight_full's
# max_age. Half the interval, so two watchers on one flight in the same pass
# still share one call but the next pass always fetches.
def _max_age(tier):
    return TIER_INTERVAL.get(tier, timedelta(minutes=5)) / 2


# THE WORK ONE POKE WILL DO, AND NO MORE. Cloud Run has a request timeout and a
# poll that tried to service four hundred flights in one request would hit it
# halfway through, having written some state and not others. The cap is per
# provider because they fail differently.
MAX_ADB_CALLS_PER_RUN = int(os.getenv("POLL_MAX_ADB") or 40)
MAX_FR24_CALLS_PER_RUN = int(os.getenv("POLL_MAX_FR24") or 60)


def _now():
    return datetime.now(timezone.utc)


def _parse(raw):
    """Any of the shapes this codebase carries a time in, as aware UTC."""
    if not raw:
        return None
    s = str(raw).strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else \
        dt.astimezone(timezone.utc)


def _movement_time(dto, movement):
    """Best known instant for a movement: actual, then estimated, then scheduled.

    THE SAME PRECEDENCE THE APP USES. A tier decided on the scheduled time alone
    would put a three-hour-delayed flight in the ARRIVAL tier three hours early
    and poll it every two minutes throughout.
    """
    m = (dto or {}).get(movement) or {}
    for field in ("actual_iso", "estimated_iso", "scheduled_iso"):
        got = _parse(m.get(field))
        if got is not None:
            return got
    return None


# ── WHAT TIER IS THIS FLIGHT IN ─────────────────────────────────────────────

def tier_for(doc, now=None):
    """Which tier a flight is in, from the state we already hold.

    NO PROVIDER IS CALLED TO ANSWER THIS. It reads the stored DTO, so deciding
    that a flight is not due costs nothing at all -- which is what makes a
    two-minute poke over four hundred flights affordable.

    A flight we have never fetched has no DTO and no times. It gets NEAR, not
    FAR: the first fetch is what tells us which tier it really belongs in, and
    guessing FAR would leave a flight departing in an hour unpolled for six.
    """
    now = now or _now()
    dto = (doc or {}).get("dto")
    if not dto:
        return NEAR

    landing = (doc or {}).get("landing") or {}
    landed = landing.get("outcome") == fr24.LANDED

    arr = (dto.get("arrival") or {})
    at_gate = bool(arr.get("actual_iso"))

    # ── DONE MEANS BOTH, NOT EITHER ──
    #
    # WHEELS DOWN IS NOT THE END OF THE FLIGHT. The gate, the stand and the
    # baggage belt are all published AFTER touchdown, and they are the part a
    # traveller standing in the terminal actually needs. Stopping at the landing
    # would end the poll at the exact moment it becomes useful.
    if landed and at_gate:
        return DONE

    arrival_at = _movement_time(dto, "arrival")
    if arrival_at is not None and not landed \
            and now > arrival_at + GIVE_UP_AFTER_ARRIVAL:
        # Three hours past arrival with no landing recorded. Either it diverted
        # or nobody is reporting it; either way it is not worth two-minute polls.
        return DONE

    status = str(dto.get("status") or "").lower()
    if status in ("canceled", "cancelled"):
        return DONE

    departure_at = _movement_time(dto, "departure")
    departed = bool((dto.get("departure") or {}).get("actual_iso"))

    if departed or status in ("enroute", "en route", "airborne"):
        if arrival_at is not None and now >= arrival_at - ARRIVAL_BEFORE_ARRIVAL:
            return ARRIVAL
        return AIRBORNE

    if departure_at is None:
        return NEAR
    until = departure_at - now
    if until <= NEAR_BEFORE_DEPARTURE:
        return NEAR
    if until <= DAY_BEFORE_DEPARTURE:
        return DAY
    return FAR


def _due(doc, tier, now, last_key):
    """Has this flight's tier interval elapsed since that provider was asked?

    PER PROVIDER, because they are asked on different schedules. FR24 is not
    asked at all until the aircraft is up, so the AeroDataBox clock would say
    "due" on a flight FR24 has never been asked about and vice versa.
    """
    if tier == DONE:
        return False
    interval = TIER_INTERVAL.get(tier)
    if interval is None:
        return False
    last = _parse((doc or {}).get(last_key))
    return last is None or (now - last) >= interval


# ── WHAT CHANGED ────────────────────────────────────────────────────────────
#
# THE FIELDS A PERSON WOULD ACT ON. The whole DTO is stored -- see pollstate --
# but a change is only worth recording against a field somebody would change
# their behaviour over. A shifting `estimated_iso` that moves by ninety seconds
# every poll is noise, and a ledger full of it is a ledger nobody will read.
WATCHED_FIELDS = [
    ("status", lambda d: d.get("status")),
    ("departure_gate", lambda d: (d.get("departure") or {}).get("gate")),
    ("departure_terminal", lambda d: (d.get("departure") or {}).get("terminal")),
    ("departure_estimated", lambda d: (d.get("departure") or {}).get("estimated_iso")),
    ("departure_actual", lambda d: (d.get("departure") or {}).get("actual_iso")),
    ("arrival_gate", lambda d: (d.get("arrival") or {}).get("gate")),
    ("arrival_terminal", lambda d: (d.get("arrival") or {}).get("terminal")),
    ("arrival_estimated", lambda d: (d.get("arrival") or {}).get("estimated_iso")),
    ("arrival_actual", lambda d: (d.get("arrival") or {}).get("actual_iso")),
    ("baggage_belt", lambda d: (d.get("arrival") or {}).get("baggage")),
]

# A TIME THAT MOVES BY LESS THAN THIS IS NOT A CHANGE. Estimated times are
# recomputed continuously upstream and drift by a minute or two between polls;
# recording that as an event would bury the ten-minute slip that matters.
TIME_NOISE = timedelta(minutes=5)

_TIME_FIELDS = {"departure_estimated", "arrival_estimated"}


def diff(before, after):
    """[{field, from, to}] -- what a person would notice, not every byte.

    before None means this is the first time we have seen the flight. THAT IS
    NOT A CHANGE and returns nothing: everything about a flight is new the first
    time, and reporting it would mean a notification per field on registration.
    """
    if not before:
        return []
    out = []
    for name, get in WATCHED_FIELDS:
        old, new = get(before), get(after)
        if old == new:
            continue
        if name in _TIME_FIELDS:
            a, b = _parse(old), _parse(new)
            if a is not None and b is not None and abs(b - a) < TIME_NOISE:
                continue
        out.append({"field": name, "from": old, "to": new})
    return out


# ── ONE FLIGHT ──────────────────────────────────────────────────────────────

def poll_one(number, day, now=None, budget_ok=True, spend=None):
    """Fetch, diff and store one flight. Returns a small record of what happened.

    spend is a mutable dict of counters the caller uses to enforce the per-run
    caps; None means uncapped, which is what the tests use.
    """
    now = now or _now()
    spend = spend if spend is not None else {}
    doc, _gen = pollstate.read_state(number, day)
    tier = tier_for(doc, now)

    record = {"flight": number, "date": day, "tier": tier,
              "adb": False, "fr24": False, "changes": []}

    if tier == DONE:
        return record

    # THE FLOOR SKIPS THE CHEAP TIERS, NOT THE FLIGHT. An ARRIVAL flight is
    # still polled with the last unit in the account; a FAR one is not.
    if not budget_ok and tier not in ESSENTIAL_TIERS:
        record["skipped"] = "budget floor"
        return record

    want_adb = _due(doc, tier, now, "last_adb_at")
    want_fr24 = tier in FR24_TIERS and _due(doc, tier, now, "last_fr24_at")

    if want_adb and spend.get("adb", 0) >= MAX_ADB_CALLS_PER_RUN:
        want_adb = False
        record["skipped"] = "adb cap for this run"
    if want_fr24 and spend.get("fr24", 0) >= MAX_FR24_CALLS_PER_RUN:
        want_fr24 = False

    if not want_adb and not want_fr24:
        record["skipped"] = record.get("skipped") or "not due"
        return record

    new_dto = None
    if want_adb:
        spend["adb"] = spend.get("adb", 0) + 1
        record["adb"] = True
        try:
            _text, new_dto = fetch_flight_full(number, date=day,
                                               max_age=_max_age(tier))
        except Exception as exc:  # noqa: BLE001
            # ONE FLIGHT'S FAILURE IS NOT THE POLL'S FAILURE. Four hundred
            # flights behind this one still need servicing, and an exception
            # here would take every one of them with it.
            logger.warning("poll: adb failed for %s/%s: %s", number, day, exc)
            record["adb_error"] = str(exc)[:200]

    landing = None
    if want_fr24:
        spend["fr24"] = spend.get("fr24", 0) + 1
        record["fr24"] = True
        dest = None
        source = new_dto or (doc or {}).get("dto") or {}
        dest = ((source.get("arrival") or {}).get("iata")) or None
        try:
            landing = fr24.landing_for(number, date=day, destination_iata=dest)
        except Exception as exc:  # noqa: BLE001
            logger.warning("poll: fr24 failed for %s/%s: %s", number, day, exc)
            record["fr24_error"] = str(exc)[:200]

    changes = diff((doc or {}).get("dto"), new_dto) if new_dto else []

    # A LANDING IS AN EVENT IN ITS OWN RIGHT, and it does not come from the DTO.
    # FR24 is the only thing allowed to say it, so it is recorded here rather
    # than inferred from any AeroDataBox field.
    if landing and landing.get("outcome") == fr24.LANDED:
        was = ((doc or {}).get("landing") or {}).get("outcome")
        if was != fr24.LANDED:
            changes.append({"field": "landed", "from": None,
                            "to": landing.get("landed_utc")})
    record["changes"] = changes

    def apply(existing):
        d = dict(existing or pollstate.blank_state(number, day))
        if new_dto:
            d["dto"] = new_dto
            d["last_adb_at"] = pollstate._iso(now)
            d["adb_polls"] = int(d.get("adb_polls") or 0) + 1
        elif want_adb:
            # THE ATTEMPT IS RECORDED EVEN THOUGH IT FAILED. Without this a
            # provider outage would leave last_adb_at untouched, every flight
            # would stay permanently due, and the next poke would retry all of
            # them -- turning one outage into a spend spike.
            d["last_adb_at"] = pollstate._iso(now)
        if landing is not None:
            d["landing"] = landing
        if want_fr24:
            d["last_fr24_at"] = pollstate._iso(now)
            d["fr24_polls"] = int(d.get("fr24_polls") or 0) + 1
        if changes:
            pending = list(d.get("pending") or [])
            pending.append({"at": pollstate._iso(now), "tier": tier,
                            "changes": changes})
            # BOUNDED. Nothing drains this yet -- dispatch does not exist -- so
            # a flight polled every two minutes for three hours could otherwise
            # grow an unbounded object. The newest entries are the ones worth
            # keeping.
            d["pending"] = pending[-50:]
        return d

    pollstate.mutate_state(number, day, apply)
    return record


# ── ONE PASS ────────────────────────────────────────────────────────────────

def run_once(now=None):
    """Every watched flight, once. This is what /poll calls."""
    now = now or _now()
    started = now

    if not pollstate.configured():
        return {"ok": False, "error": "no bucket configured", "flights": 0}

    flights = store.watched_flights()
    if flights is None:
        # See store.watched_flights: None is "could not read", which is not the
        # same as "nobody is watching" and must not be reported as a clean pass.
        logger.error("poll: watch store unreadable; no flights polled")
        return {"ok": False, "error": "watch store unreadable", "flights": 0}

    budget = _budget_state()
    budget_ok = budget.get("ok", True)

    spend = {"adb": 0, "fr24": 0}
    records, changed = [], 0
    for f in flights:
        try:
            r = poll_one(f["flight_number"], f["flight_date"],
                         now=now, budget_ok=budget_ok, spend=spend)
        except Exception as exc:  # noqa: BLE001
            logger.exception("poll: %s/%s blew up",
                             f["flight_number"], f["flight_date"])
            r = {"flight": f["flight_number"], "date": f["flight_date"],
                 "error": str(exc)[:200]}
        records.append(r)
        if r.get("changes"):
            changed += 1

    # WHAT THE CALLS WE JUST MADE TAUGHT US ABOUT THE BUDGET, kept for the next
    # poke -- which will almost certainly be a different, cold process.
    try:
        import mcp_server
        seen = mcp_server.quota_status()
        if seen.get("units_remaining") is not None:
            pollstate.note_quota(seen["units_remaining"])
    except Exception:  # noqa: BLE001
        pass

    tiers = {}
    for r in records:
        tiers[r.get("tier", "?")] = tiers.get(r.get("tier", "?"), 0) + 1

    out = {
        "ok": True,
        "at": pollstate._iso(started),
        "took_seconds": round((_now() - started).total_seconds(), 2),
        "flights": len(flights),
        "tiers": tiers,
        "adb_calls": spend["adb"],
        "fr24_calls": spend["fr24"],
        "flights_changed": changed,
        "budget": budget,
        # THE CHANGES THEMSELVES, so a poke can be read without opening GCS.
        # This is the only way to see what the poller is doing until dispatch
        # exists, and it is the thing to watch before letting it send anything.
        "changes": [r for r in records if r.get("changes")],
    }
    logger.info("poll: %d flights, %d adb, %d fr24, %d changed",
                out["flights"], out["adb_calls"], out["fr24_calls"], changed)
    return out


def _budget_state():
    """Are we above the floor? Never fails the poll -- an unknown budget polls.

    IF THE QUOTA CANNOT BE READ, POLLING CONTINUES. The floor exists to stop the
    cheap tiers eating the month, not to be a second circuit breaker; refusing to
    poll because we could not read a counter would turn a monitoring gap into an
    outage.
    """
    floor = pollstate.budget_floor()

    # THIS PROCESS FIRST -- it is exact if it has made a call -- THEN THE SHARED
    # FIGURE, which is at most one poll old. See pollstate.read_quota for why
    # the process alone is not enough.
    import mcp_server
    live = mcp_server.quota_status()
    remaining, age = live.get("units_remaining"), live.get("as_of_seconds_ago")
    source = "this instance"
    if remaining is None:
        remaining, at = pollstate.read_quota()
        source = "last poll"
        age = None if at is None else int((_now() - at).total_seconds())

    if remaining is None:
        return {"ok": True, "floor": floor, "remaining": None,
                "note": "quota never observed; polling all tiers"}
    return {"ok": remaining > floor, "floor": floor, "remaining": remaining,
            "source": source, "measured_seconds_ago": age,
            "days_to_reset": pollstate.days_until_reset()}
