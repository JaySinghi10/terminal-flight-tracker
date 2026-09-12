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

  DISTANT   > 48h to departure     once every 12 hours
  FAR       6h .. 48h               once every 6 hours
  DAY       6h .. 90m              every 30 minutes
  NEAR      90m before departure   every 5 minutes   (+ FR24, see below)
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
  * FR24 IS ASKED WHETHER IT HAS LANDED -- and, from NEAR, WHETHER IT HAS LEFT
    THE GROUND. AIRBORNE and ARRIVAL ask the first. NEAR asks the second,
    because FR24's takeoff time is the only proof of a departure that costs no
    schedule unit, and without it a flight AeroDataBox cannot be asked about
    never reaches AIRBORNE at all. See _has_departed's third proof.

FR24 REMAINS THE ONLY THING THAT SAYS A FLIGHT HAS LANDED. This module does not
relitigate that; it calls fr24.landing_for and stores what comes back.

── THE BUDGET FLOOR IS A REFUSAL, NOT A WARNING ────────────────────────────────

pollstate.budget_floor() is units-per-day-remaining until the billing date. Below
it, the cheap tiers stop asking AERODATABOX and only ARRIVAL and AIRBORNE do. A
month that runs out on the 20th is worse than a month that polls the FAR tier
half as often, because the flights that matter are the ones about to land.

IT IS A REFUSAL OF ONE CURRENCY, NOT OF THE FLIGHT. It used to return before the
FR24 call was even considered, which spent nothing and cost everything: with the
schedule quota exhausted, a flight that was never seen to depart stayed NEAR, was
skipped here, never became AIRBORNE, and finished with no landing recorded at
all. FR24 bills credits against a balance this floor knows nothing about, so the
floor now suppresses the AeroDataBox half and leaves the FR24 half to run.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

import fr24
import pollstate
import notify
import store
from mcp_server import fetch_flight_full

logger = logging.getLogger("poller")

# ── THE TIERS ───────────────────────────────────────────────────────────────
DISTANT = "distant"
FAR = "far"
DAY = "day"
NEAR = "near"
AIRBORNE = "airborne"
ARRIVAL = "arrival"
DONE = "done"

TIER_INTERVAL = {
    DISTANT: timedelta(hours=12),
    FAR: timedelta(hours=6),
    DAY: timedelta(minutes=30),
    NEAR: timedelta(minutes=5),
    AIRBORNE: timedelta(minutes=15),
    ARRIVAL: timedelta(minutes=2),
}

# ── WHICH TIERS MAY ASK FR24 ────────────────────────────────────────────────
#
# AIRBORNE AND ARRIVAL ASK WHETHER IT HAS LANDED. Before wheels-up that answer
# cannot be yes, which is why the cheap tiers never asked.
#
# NEAR ASKS A DIFFERENT QUESTION: HAS IT LEFT THE GROUND. FR24 returns
# takeoff_utc on every outcome, pending included, and that is the only evidence
# of a departure in this system that does not cost an AeroDataBox unit. Without
# it, a flight the schedule provider cannot be asked about is tiered NEAR on its
# stale scheduled time, never satisfies _has_departed, never becomes AIRBORNE,
# and is marked DONE three hours past its scheduled arrival having told nobody
# anything.
#
# IT IS THE EXPENSIVE TIER IN CREDITS, and that is the trade being made: five
# minutes over a ninety-minute window is eighteen queries per departure, and
# fr24 bills per returned record.
FR24_TIERS = {NEAR, AIRBORNE, ARRIVAL}

# Which tiers survive the budget floor. See the note at the top.
#
# NEAR IS DELIBERATELY NOT HERE. It may ask FR24, which the floor does not
# govern; it may not ask AeroDataBox, which the floor exists to protect.
ESSENTIAL_TIERS = {ARRIVAL, AIRBORNE}

NEAR_BEFORE_DEPARTURE = timedelta(minutes=90)
DAY_BEFORE_DEPARTURE = timedelta(hours=6)
DISTANT_BEFORE_DEPARTURE = timedelta(hours=48)
ARRIVAL_BEFORE_ARRIVAL = timedelta(minutes=30)

# ── A NUMBER THE PROVIDER CANNOT RESOLVE MUST NOT BE ASKED FOR EVER ─────────
#
# A FLIGHT WITH NO STORED DTO IS TIERED NEAR, and a number that never resolves
# never gets a DTO -- so without this it stays NEAR permanently and is polled
# every five minutes for the rest of time. THAT IS 288 UNITS A DAY, PER FLIGHT.
# The live watchlist has four such numbers on it; they alone would have spent a
# 5,000-unit month in four days, and with the past-dated flights, in one.
#
# SO CONSECUTIVE MISSES DOUBLE THE INTERVAL, up to a cap. A wrong number settles
# at four calls a day instead of 288, and ONE SUCCESS RESETS IT -- which is why
# this is a backoff and not a giving-up. A flight three weeks out that the
# provider does not carry yet is indistinguishable from a typo today, and will
# resolve on its own nearer the day.
MISS_BACKOFF_CAP = timedelta(hours=6)

# ── HOW EARLY A TAKEOFF MAY BE AND STILL BE THIS FLIGHT ─────────────────────
#
# FR24 IS ASKED OVER A WINDOW, NOT FOR AN INSTANT. fr24._window reaches six
# hours back from the scheduled departure, and a flight number that operates
# twice in a day puts its EARLIER rotation inside that reach. On a repeated
# route the destination filter cannot separate the two -- both go to the same
# airport -- and fr24._pick then sorts by nearest takeoff, which the leg we are
# actually asking about loses, because it has not taken off and so sorts last.
# The earlier rotation wins, it is genuinely airborne, and its takeoff would
# promote an aircraft still at its gate to AIRBORNE. When that rotation lands,
# the person meeting this flight is told it has landed.
#
# SIXTY MINUTES IS THE LINE, and it is drawn where the two explanations part.
# A departure more than an hour before schedule is not something airlines do:
# boarding closes at minus fifteen to minus twenty, and a pushback an hour
# early would leave booked passengers behind. A takeoff that early is far more
# likely to be a different rotation of the same number than a punctual one. An
# hour is also comfortably wider than any real early departure, so the guard
# costs nothing on the flights it is not aimed at.
#
# IT IS A FLOOR, NOT A WINDOW. There is no upper bound: a delay has no limit
# and a flight that leaves nine hours late is still this flight.
FR24_TAKEOFF_EARLY_SLACK = timedelta(minutes=60)

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


def _dep_scheduled(doc):
    """The stored scheduled departure, which is what narrows an FR24 window.

    fr24._window falls back to 48 hours around the DATE without one, and that
    window reaches back far enough to return the previous day's rotation of the
    same flight number -- billed per record, up to eight of them. Every FR24
    query in this module passes this; where it is absent the query is not made.
    """
    dep = (((doc or {}).get("dto") or {}).get("departure") or {})
    return dep.get("scheduled_iso") or None


# ── WHAT TIER IS THIS FLIGHT IN ─────────────────────────────────────────────

def tier_for(doc, now=None, day=None):
    """Which tier a flight is in, from the state we already hold.

    NO PROVIDER IS CALLED TO ANSWER THIS. It reads the stored DTO, so deciding
    that a flight is not due costs nothing at all -- which is what makes a
    two-minute poke over a whole watchlist affordable.

    day is THE DATE THE WATCH WAS REGISTERED FOR, and it is what lets this
    answer sensibly before any DTO exists. Without it every unresolved flight
    looks identical -- a typo, a flight three weeks out and a flight boarding in
    an hour are all just "no data" -- and all three would be polled at the
    five-minute rate.
    """
    now = now or _now()
    dto = (doc or {}).get("dto")
    if not dto:
        return _tier_without_data(day, now)

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
    # THE LANDING GOES IN because it carries a takeoff time. See _has_departed.
    departed = _has_departed(dto, now, landing)

    if departed or status in ("enroute", "en route", "airborne"):
        if arrival_at is not None and now >= arrival_at - ARRIVAL_BEFORE_ARRIVAL:
            return ARRIVAL
        return AIRBORNE

    if departure_at is None:
        return _tier_without_data(day, now)
    until = departure_at - now
    if until <= NEAR_BEFORE_DEPARTURE:
        return NEAR
    if until <= DAY_BEFORE_DEPARTURE:
        return DAY
    if until <= DISTANT_BEFORE_DEPARTURE:
        return FAR
    return DISTANT


def _has_departed(dto, now, landing=None):
    """Has this aircraft actually left the ground?

    THREE PROOFS, AND THE THIRD COSTS NO SCHEDULE UNIT. The first two are
    AeroDataBox's and are unchanged. The third is FR24's takeoff time, which
    arrives on a `landing` dict this poller has always stored and never read --
    and which is the only one of the three still available when the AeroDataBox
    quota is exhausted. Without it a flight that was never seen to depart is
    tiered NEAR for ever on a stale scheduled time.

    AN actual_iso IN THE FUTURE IS NOT AN ACTUAL, AND AERODATABOX PUBLISHES
    THEM. Observed live on 6E6188 BOM->BLR: status "EnRoute", delay 0, and
    departure.actual_iso set to 21:30 local -- two hours and twenty minutes
    AFTER the moment we read it, with actual_source "revised". The flight was
    sitting at gate 87A.

    THE COST OF BELIEVING IT was not academic. It put a flight that had not
    taken off into the AIRBORNE tier, which is a tier that asks FR24 whether it
    has landed, and FR24 answered with the PREVIOUS DAY'S rotation of the same
    number. A flight still on the ground was recorded as landed.

    So a claimed actual has to be in the past to count, which is the same guard
    lib/saved.tsx already applies to arrivals for the same reason.
    """
    dep = (dto or {}).get("departure") or {}
    actual = _parse(dep.get("actual_iso"))
    if actual is not None and actual <= now:
        return True

    # ── FR24 SAW IT LEAVE ───────────────────────────────────────────────────
    #
    # PENDING AND LANDED BOTH CARRY A TAKEOFF, and both mean the aircraft is off
    # the ground: pending is "FR24 knows this leg and it is still in the air".
    # UNKNOWN and ERROR carry no takeoff and assert nothing, which is the whole
    # point of there being four outcomes rather than two.
    #
    # IN THE PAST, for the reason the actual above has to be: a claimed
    # departure that has not happened yet is not a departure. FR24 reports
    # observed positions rather than schedules, so this is belt and braces.
    #
    # AND NOT TOO FAR BEFORE THE SCHEDULE, which is the wrong-rotation guard --
    # see FR24_TAKEOFF_EARLY_SLACK for why an hour and why there is no upper
    # bound. WITHOUT A STORED SCHEDULE THE PROOF IS REFUSED OUTRIGHT: there is
    # nothing to check the takeoff against, and an unchecked takeoff from a
    # window six hours wide is exactly the claim this guard exists to reject.
    #
    # IT IS BEFORE THE STATUS TEST BELOW AND NOT AFTER IT, because that test
    # returns outright on an enroute status -- False included -- and a third
    # proof written under it would be unreachable for exactly the flights whose
    # status is enroute while the schedule is stale.
    outcome = (landing or {}).get("outcome")
    if outcome in (fr24.PENDING, fr24.LANDED):
        took_off = _parse((landing or {}).get("takeoff_utc"))
        sched_dep = _parse(dep.get("scheduled_iso"))
        if took_off is not None and took_off <= now and sched_dep is not None \
                and took_off >= sched_dep - FR24_TAKEOFF_EARLY_SLACK:
            return True

    # The provider's word for it, but only once the scheduled time has passed --
    # "EnRoute" on a flight not due out for two hours is the same claim in
    # different clothes.
    status = str((dto or {}).get("status") or "").lower()
    raw = str((dto or {}).get("raw_status") or "").lower()
    if status in ("enroute", "en route", "airborne") or raw in ("enroute", "en route"):
        sched = _parse(dep.get("scheduled_iso"))
        return sched is not None and sched <= now
    return False


def _tier_without_data(day, now):
    """The tier for a flight we hold no usable DTO for, decided on its date.

    THE PAST CASE IS THE EXPENSIVE ONE. Nine of the eighteen flights on the live
    watchlist are dated before today, and a provider that no longer carries a
    two-day-old flight returns nothing for ever. Tiered NEAR, each would be
    asked every five minutes indefinitely -- for a flight that has already
    landed and that nobody is waiting on.
    """
    if not day:
        # No date at all: assume it is imminent rather than assume it is not.
        return NEAR
    try:
        d = datetime.strptime(str(day)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return NEAR
    # A day behind us, with nothing stored, is not going to arrive.
    if d.date() < now.date():
        return DONE
    ahead = d - now
    if ahead > DISTANT_BEFORE_DEPARTURE:
        return DISTANT
    if ahead > DAY_BEFORE_DEPARTURE:
        return DAY
    return NEAR


def _due(doc, tier, now, last_key, misses=0):
    """Has this flight's tier interval elapsed since that provider was asked?

    PER PROVIDER, because they are asked on different schedules. FR24 is not
    asked at all until the aircraft is up, so the AeroDataBox clock would say
    "due" on a flight FR24 has never been asked about and vice versa.

    misses STRETCHES THE INTERVAL -- see MISS_BACKOFF_CAP. Doubling per
    consecutive empty answer, so a number that cannot be resolved costs four
    calls a day rather than 288, and one success puts it straight back on its
    tier's own schedule.
    """
    if tier == DONE:
        return False
    interval = TIER_INTERVAL.get(tier)
    if interval is None:
        return False
    if misses > 0:
        interval = min(MISS_BACKOFF_CAP, interval * (2 ** min(misses, 10)))
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
    tier = tier_for(doc, now, day=day)
    misses = int((doc or {}).get("adb_misses") or 0)

    record = {"flight": number, "date": day, "tier": tier,
              "adb": False, "fr24": False, "changes": []}
    if misses:
        record["misses"] = misses

    # A CANCELLED FLIGHT IS DONE, BUT ITS NEXT-FLIGHT SEARCH MAY NOT BE. The
    # cancellation message goes out on the poll that sees it; if the route
    # board had nothing for the first three days, the search continues on later
    # polls -- which are polls of a DONE flight. So DONE returns early only when
    # there is nothing left to look for, and a poll that only continues the
    # search fetches nothing from either provider.
    searching = bool(doc and (((doc.get("notify") or {}).get("next_search") or {}).get("done") is False))
    if tier == DONE and not searching:
        return record

    # THE FLOOR SKIPS THE AERODATABOX CALL, NOT THE FLIGHT. An ARRIVAL flight is
    # still polled with the last unit in the account; a FAR one is not.
    #
    # IT USED TO RETURN HERE, AND THE RETURN TOOK THE FR24 CALL WITH IT -- a
    # call in a different currency, against a balance this floor does not
    # measure. The record still says "budget floor" and the AeroDataBox call is
    # still refused; what has changed is that want_fr24 below is now reachable.
    # See the note at the top of this file.
    adb_allowed = budget_ok or tier in ESSENTIAL_TIERS
    if not adb_allowed:
        record["skipped"] = "budget floor"

    want_adb = adb_allowed and _due(doc, tier, now, "last_adb_at", misses)
    # FR24 IS NOT BACKED OFF ON AERODATABOX'S MISSES. They are different
    # providers with different coverage, and a flight one cannot resolve is
    # exactly the case where the other's answer is worth having.
    want_fr24 = tier in FR24_TIERS and _due(doc, tier, now, "last_fr24_at")

    # AND NEAR ASKS ONLY WHEN THE WINDOW CAN BE NARROWED.
    #
    # NEAR IS THE ONLY FR24 TIER THAT CAN ARRIVE HERE WITHOUT A DTO. AIRBORNE
    # and ARRIVAL are decided FROM one, so they always have a scheduled
    # departure to send; NEAR is also what _tier_without_data returns for a
    # flight nothing is stored for. Asking without a departure instant is the
    # 48-hour window fr24 documents as grudging: billed per record, up to eight
    # of them, and able to return the previous day's rotation as this one.
    if want_fr24 and tier == NEAR and _dep_scheduled(doc) is None:
        want_fr24 = False
        record["skipped"] = record.get("skipped") or "no departure time for fr24"

    if want_adb and spend.get("adb", 0) >= MAX_ADB_CALLS_PER_RUN:
        want_adb = False
        record["skipped"] = "adb cap for this run"
    if want_fr24 and spend.get("fr24", 0) >= MAX_FR24_CALLS_PER_RUN:
        want_fr24 = False

    if not want_adb and not want_fr24 and not searching:
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
        source = new_dto or (doc or {}).get("dto") or {}
        dest = ((source.get("arrival") or {}).get("iata")) or None
        # ── THE DEPARTURE TIME IS NOT OPTIONAL, WHATEVER THE SIGNATURE SAYS ──
        #
        # WITHOUT IT fr24 SEARCHES A TWO-DAY WINDOW AROUND THE DATE -- twelve
        # hours back and thirty-six forward -- because a "date" is a LOCAL
        # departure date and the UTC day it falls on is not knowable without a
        # timezone. THE PREVIOUS DAY'S ROTATION OF A DAILY FLIGHT NUMBER SITS
        # INSIDE THAT WINDOW.
        #
        # That is not hypothetical: 6E6188 on 2026-09-07 came back with
        # yesterday's leg, takeoff 09-06 16:29Z and touchdown 09-06 17:45Z, one
        # record, matched on destination -- and was recorded as today's landing
        # on a flight that had not yet left Mumbai.
        #
        # WE ALWAYS KNOW THIS. It is on the DTO we just fetched. The app has
        # always sent it; this caller was the only one that did not.
        dep_iso = ((source.get("departure") or {}).get("scheduled_iso")) or None
        try:
            landing = fr24.landing_for(number, date=day, destination_iata=dest,
                                       departure_utc=dep_iso)
        except Exception as exc:  # noqa: BLE001
            logger.warning("poll: fr24 failed for %s/%s: %s", number, day, exc)
            record["fr24_error"] = str(exc)[:200]

    changes = diff((doc or {}).get("dto"), new_dto) if new_dto else []

    # ── WHICH OF THIS IS WORTH A MESSAGE ──
    #
    # Decided here, outside the write below, because the one call notify can
    # make -- the route board, on a cancellation -- leaves the process and must
    # not sit inside a read-modify-write that may retry. The decision reads the
    # CURRENT record against what the person was last told (notify.py), so it
    # runs on the record we have now whether or not this poll fetched a new one:
    # a cancellation's next-flight search continues on polls that fetch nothing.
    current_dto = new_dto or (doc or {}).get("dto")
    current_landing = landing if landing is not None else (doc or {}).get("landing")
    prior_ns = (doc or {}).get("notify")
    new_ns, messages = prior_ns, []
    if current_dto and (new_dto or landing is not None or searching):
        def lookup_next(origin, dest, day):
            # A dated board is two provider calls; counted against this run's
            # cap exactly as a flight fetch is, and refused past it so a
            # cancellation cannot spend the poll's whole budget on one route.
            #
            # AND REFUSED BELOW THE FLOOR, which it did not have to be while the
            # floor returned early -- the early return reached this path too. It
            # is an AeroDataBox call like any other, so the floor governs it
            # like any other; without this line, removing that return would have
            # quietly opened a two-unit spend the floor used to close.
            # _search_next treats a raise as "not searched" and retries the same
            # day on the next poll, which is what the cap already relies on.
            if not adb_allowed:
                raise RuntimeError("budget floor")
            if spend.get("adb", 0) + notify.NEXT_CALLS_PER_DAY > MAX_ADB_CALLS_PER_RUN:
                raise RuntimeError("adb cap for this run")
            spend["adb"] = spend.get("adb", 0) + notify.NEXT_CALLS_PER_DAY
            from mcp_server import fetch_route
            return (fetch_route(origin, dest, hours=12, date=day) or {}).get("flights") or []
        try:
            new_ns, messages = notify.decide(prior_ns, current_dto, current_landing, now,
                                             lookup_next=lookup_next)
        except Exception as exc:  # noqa: BLE001
            logger.exception("poll: notify decision failed for %s/%s", number, day)
            record["notify_error"] = str(exc)[:200]
            new_ns, messages = prior_ns, []
    if messages:
        record["notifications"] = [m["kind"] for m in messages]
        logger.info("poll: %s/%s -> %s", number, day, ", ".join(record["notifications"]))

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
            d["adb_misses"] = int(d.get("adb_misses") or 0) + 1
        if new_dto:
            # ONE GOOD ANSWER CLEARS THE BACKOFF ENTIRELY. A flight the provider
            # did not carry last week and does carry today goes straight back to
            # its tier's own interval.
            d["adb_misses"] = 0
        if landing is not None:
            d["landing"] = landing
        if want_fr24:
            d["last_fr24_at"] = pollstate._iso(now)
            d["fr24_polls"] = int(d.get("fr24_polls") or 0) + 1
        if new_ns is not None:
            # The last-told state and the outbox. Nothing drains the outbox yet;
            # it is bounded inside notify.decide.
            d["notify"] = new_ns
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

    # FLIGHTS THE PROVIDER KEEPS NOT ANSWERING FOR, NAMED. A number that never
    # resolves is now cheap rather than ruinous, but it is still a watch that
    # will never do anything, and it should be visible rather than merely
    # affordable.
    stale = sorted((r["flight"], r["date"], r["misses"]) for r in records
                   if r.get("misses", 0) >= 3)

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
        "unresolved": [{"flight": n, "date": d, "misses": m}
                       for n, d, m in stale],
        # THE CHANGES THEMSELVES, so a poke can be read without opening GCS.
        # This is the only way to see what the poller is doing until dispatch
        # exists, and it is the thing to watch before letting it send anything.
        "changes": [r for r in records if r.get("changes")],
        # AND WHAT WOULD HAVE BEEN SENT, by kind. The sentences are in the
        # outbox on each state object, waiting for a sender.
        "notifications": [{"flight": r["flight"], "date": r["date"], "kinds": r["notifications"]}
                          for r in records if r.get("notifications")],
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
