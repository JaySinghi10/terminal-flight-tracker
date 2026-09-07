"""Flightradar24: the only thing allowed to say a flight has landed.

WHY THERE IS A SECOND PROVIDER AT ALL. AeroDataBox lost the arrival on three
flights out of three at Indian airports, in three different ways. EK500 reported
its arrival 3h24m late. EK502 reported "Arrived" five hours EARLY, with an actual
arrival time in the FUTURE that then moved five times, and never produced a
runway time at all. 6E5071 was still "Approaching" three and a half hours after
it was on the ground -- its estimate had been right to the minute; the provider
simply never wrote down that the flight landed.

AND WHY AERODATABOX IS STILL HERE. The same provider timed LH909 into Frankfurt
correctly: touchdown 18:07, gate 18:14, both published within thirteen minutes,
gate B1 alongside. It is not broken everywhere -- it is broken where we measured
it. So the split is by JOB, not by trust: FR24 decides whether and when a flight
landed; AeroDataBox keeps schedules, terminals, gates, aircraft and route search,
and keeps timing the gate arrival, which is the half it does well and which FR24
does not report at all.

── WHAT THIS MODULE IS ALLOWED TO RETURN ───────────────────────────────────────

FOUR OUTCOMES, AND THEY MUST NOT COLLAPSE INTO ONE. "FR24 says it landed",
"FR24 says it is still flying", "FR24 was asked and does not know" and "FR24
could not be reached" are four different facts, and exactly one of them --
UNKNOWN -- is what lets AeroDataBox's own arrival stand. Merging any of the
others into it would hand the decision back to the provider we removed it from.

ABSENCE IS NEVER AN ASSERTION. Nothing here ever returns "not landed" as a fact.
A flight FR24 has never heard of leaves the card exactly as it was.

── WHERE FR24 IS WEAK, MEASURED RATHER THAN ASSUMED ────────────────────────────

A 200-flight validation across six regions on 2026-09-07 put overall detection
at 94.6% -- 106 of the 112 flights that actually finished. Europe, India and
South-East Asia were 100%.

ALMOST THE ENTIRE SHORTFALL IS ONE AIRPORT: DOHA. Four of the six misses were
arrivals into DOH, against zero at DXB and zero at AUH in the same region on the
same day (p = 0.00073). It is recorded in full at the branch that produces the
symptom -- search this file for "DOHA" -- so that a missing Doha landing is
RECOGNISED rather than investigated again from scratch. Nothing is done about
it deliberately; the reasoning is there too.

── COST ────────────────────────────────────────────────────────────────────────

flight-summary/light bills PER RETURNED RECORD -- 1 credit live, 2 historic
under 30 days -- and a query returning nothing still costs 1. So the window
matters: a query that sweeps two days to find one leg pays for every other leg
it drags back. departure_utc narrows it to one, which is why the endpoint asks
for it and why the fallback window is deliberately grudging.
"""
import logging
import os
import re
import threading
from datetime import datetime, timedelta, timezone

import requests

import pollstate
from airport_icao import icao_for

logger = logging.getLogger("flight-tracker")

# ── CONFIGURATION ───────────────────────────────────────────────────────────
#
# A CLOUD RUN ENVIRONMENT VARIABLE, read the way llm.py reads GEMINI_API_KEY.
# Never written to a file in this repository, never logged, and never echoed in
# a response. Absent means DISABLED, not broken: the module answers "error /
# not configured" and every caller carries on, so a deployment that has not set
# it yet degrades to exactly the behaviour that existed before this file.
FR24_API_TOKEN = (os.getenv("FR24_API_TOKEN") or "").strip()

BASE = "https://fr24api.flightradar24.com/api"

# WITHOUT ONE OF THESE, fr24api ANSWERS 403. Measured: Cloudflare rejects
# urllib's and requests' default agents with an error 1010 page -- "banned based
# on your browser's signature" -- which arrives in the same shape as an auth
# failure and mentions neither the token nor the real reason. Diagnosing that
# from the response alone costs an hour.
USER_AGENT = "flight-tracker/1.0 (+landing detection)"

REQUEST_TIMEOUT_SECONDS = 10

# One pool for the process, exactly as mcp_server.py keeps one for RapidAPI.
_SESSION = requests.Session()

# ── THE FOUR OUTCOMES ───────────────────────────────────────────────────────
LANDED = "landed"      # FR24 has a touchdown time. Authoritative.
PENDING = "pending"    # FR24 knows this leg and it is still in the air.
UNKNOWN = "unknown"    # FR24 was asked, answered cleanly, and has no landing.
ERROR = "error"        # Unreachable, rejected, unconfigured, or breaker open.

# ── THE SEARCH WINDOW ───────────────────────────────────────────────────────
#
# The endpoint filters on first_seen, which is roughly the departure. Given a
# departure instant we can ask for a few hours either side and get one leg.
DEPARTURE_SLACK_BEFORE = timedelta(hours=6)
DEPARTURE_SLACK_AFTER = timedelta(hours=20)

# WITHOUT A DEPARTURE INSTANT, the date alone is all there is, and a local
# calendar date can start the day before in UTC -- a 01:00 departure from Mumbai
# is 19:30Z on the PREVIOUS day. So the fallback straddles, and it costs more
# because it drags back neighbouring legs of the same number. Callers should
# send departure_utc.
DATE_SLACK_BEFORE = timedelta(hours=12)
DATE_SLACK_AFTER = timedelta(hours=36)

# A hard ceiling on what one query can bill, whatever the window returns.
RESULT_LIMIT = 8

# ── CIRCUIT BREAKER ─────────────────────────────────────────────────────────
#
# WHAT IT IS FOR: a rotated token, an exhausted balance or an outage answers the
# same way every time, and the caller is a five-minute poll across every flight
# in the arrival window. Without this, a 401 is retried for ever, on every
# flight, and the log fills with one fact repeated.
#
# IT FAILS OPEN, NOT CLOSED. When it trips, callers get ERROR -- which is
# explicitly the outcome that does NOT let AeroDataBox claim a landing. A broken
# FR24 must not silently restore the behaviour this module exists to replace.
#
# ── AND IT LIVES IN CLOUD STORAGE, NOT IN THIS PROCESS ──────────────────────
#
# IT USED TO BE A MODULE GLOBAL AND THAT MADE IT USELESS UNDER THE POLLER. Cloud
# Run scales to zero between two-minute pokes, so every poll began in a fresh
# process with a closed breaker and a zeroed count -- a rotated or exhausted
# token would be retried every two minutes for ever, which is the exact
# behaviour a breaker exists to prevent. A breaker that resets on every cold
# start is not a breaker.
#
# IT IS ALSO SHARED, which the in-process one never was: several instances can
# be serving at once and each was learning the outage separately.
#
# THE LOCK STAYS for the threads inside one instance; the object's generation
# precondition is what settles a race between instances.
BREAKER_THRESHOLD = 4
BREAKER_COOLDOWN = timedelta(minutes=10)

_lock = threading.Lock()

# ── CACHE ───────────────────────────────────────────────────────────────────
#
# A LANDING IS IMMUTABLE, so once it is known it is cached for the life of the
# process and never asked about again. Everything else is cached briefly: it
# stops a client retry, a double-mounted screen or two Cloud Run requests
# landing together from paying twice for one answer.
#
# SHARED, SO ONE INSTANCE'S ANSWER IS EVERY INSTANCE'S. A landing is immutable,
# so once any instance has one nothing should ever pay for it again -- which a
# process-local cache could not deliver on a service that scales to zero.
#
# ONLY LANDINGS ARE SHARED. A 'pending' or 'unknown' is a fact about a moment
# and is worth nothing to another instance a minute later; those stay in process
# memory with a short life, where they still stop a double-call inside one poll.
LANDED_CACHE_TTL = timedelta(hours=12)
SHORT_CACHE_TTL = timedelta(seconds=60)
_CACHE = {}

_ISO_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_IATA_RE = re.compile(r"^[A-Z]{3}$")
_FLIGHT_RE = re.compile(r"^(?:[A-Z]{1,3}[0-9]{1,4}[A-Z]?|[0-9][A-Z][0-9]{1,4}|[A-Z][0-9][0-9]{1,4})$")


def configured() -> bool:
    return bool(FR24_API_TOKEN)


def _result(outcome, reason=None, **extra):
    out = {
        "outcome": outcome,
        "landed_utc": None,
        "takeoff_utc": None,
        "flight": None,
        "registration": None,
        "destination_icao": None,
        "diverted_to": None,
        "match": None,
        "reason": reason,
        "records": 0,
    }
    out.update(extra)
    return out


def _parse_instant(value):
    """An ISO instant, offset-aware or trailing Z, as UTC. None if unreadable."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_naive_utc(value):
    """FR24 returns 'YYYY-MM-DDTHH:MM:SS' with no zone; it is UTC by contract."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _ended(value):
    """flight_ended, which arrives as either a bool or the STRING "true".

    FR24's own SDK types it Optional[bool]; FR24's own documented example prints
    it as a quoted string. Pydantic hides the difference by coercing and raw
    JSON does not. Plain truthiness would read "false" as ended, and an ended
    leg with no landing time is reported as FR24 having LOST the flight -- so
    the wrong reading here does not merely mislabel, it invents a failure.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return None


# ── ONE FIELD, TWO SPELLINGS, FROM ONE PROVIDER'S OWN DOCUMENTATION ─────────
#
# FR24 DOCUMENTS THE LIGHT RESPONSE WITH destination_icao AND THE FULL RESPONSE
# WITH dest_icao, for the same field, on the same page. Which one the live LIGHT
# endpoint actually sends is not a thing to be deduced from the docs, because
# the docs disagree with themselves.
#
# THIS IS THE THIRD TIME THIS SHAPE HAS BITTEN THIS PROJECT. AeroDataBox sends
# `quality` as ["Basic","Live"] on REST and [0,1] on the webhook -- same enum,
# two encodings -- and mcp_server._live_feed reads either. FR24 sends
# flight_ended as a bool and documents it as the string "true". The habit that
# survives all three is: READ EVERY SPELLING, and never let the difference
# decide anything.
#
# AND THE FAILURE IT CAUSED WAS SILENT AND CONFIDENT. Reading only the Light
# name returned "no leg matched the destination" on a leg FR24 had returned
# correctly -- an answer indistinguishable from a flight it genuinely does not
# know, on a path whose entire job is telling those two apart.
def _field(leg, *names):
    for name in names:
        value = leg.get(name)
        if value not in (None, ""):
            return value
    return None


def _code(leg, *names):
    value = _field(leg, *names)
    return str(value).strip().upper() if value is not None else ""


def _destination(leg):
    return _code(leg, "destination_icao", "dest_icao")


def _destination_actual(leg):
    return _code(leg, "destination_icao_actual", "dest_icao_actual")


def _window(date, departure_utc):
    """(from, to) as naive-UTC strings the endpoint accepts."""
    dep = _parse_instant(departure_utc)
    if dep is not None:
        start, end = dep - DEPARTURE_SLACK_BEFORE, dep + DEPARTURE_SLACK_AFTER
    else:
        day = str(date or "").strip()
        if not _ISO_DAY_RE.match(day):
            return None
        midnight = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start, end = midnight - DATE_SLACK_BEFORE, midnight + DATE_SLACK_AFTER
    fmt = "%Y-%m-%dT%H:%M:%S"
    return start.strftime(fmt), end.strftime(fmt)


def _breaker_read():
    doc, _ = pollstate.read_runtime()
    b = doc.get("breaker") or {}
    until = _parse_instant(b.get("open_until"))
    return int(b.get("failures") or 0), until


def _breaker_open(now):
    """Is the breaker holding calls back right now?

    THE HALF-OPEN CLEAR IS A WRITE AND IT IS DELIBERATELY NOT DONE HERE. Once
    the cooldown has passed this simply reports closed; the next success clears
    the count. Writing on a read would have every instance racing to clear the
    same object at the same moment for no gain.
    """
    _, until = _breaker_read()
    return until is not None and now < until


def _note_failure(now):
    def apply(doc):
        b = doc.setdefault("breaker", {})
        n = int(b.get("failures") or 0) + 1
        b["failures"] = n
        if n >= BREAKER_THRESHOLD:
            b["open_until"] = (now + BREAKER_COOLDOWN).isoformat()
            logger.warning(
                "fr24 circuit breaker open after %d consecutive failures; "
                "no calls for %d minutes",
                n, int(BREAKER_COOLDOWN.total_seconds() // 60))
        return doc
    with _lock:
        pollstate.mutate_runtime(apply)


def _note_success():
    """Clear the count -- but only if there is something to clear.

    A WRITE PER SUCCESSFUL CALL WOULD BE A GCS WRITE PER FLIGHT PER POLL. The
    common case is a closed breaker at zero failures, and that needs no write at
    all; the read is already cached for the length of a poll.
    """
    failures, until = _breaker_read()
    if failures == 0 and until is None:
        return

    def apply(doc):
        doc["breaker"] = {"failures": 0, "open_until": None}
        return doc
    with _lock:
        pollstate.mutate_runtime(apply)


def forget_cached(number=None):
    """Drop what we remember about a landing -- BOTH halves of the cache.

    THE CACHE HAS TWO HALVES AND CLEARING ONE IS A TRAP. _CACHE lives in this
    process; the landings in Cloud Storage are shared and immutable. Anything
    that wants a fresh answer -- a test, a support question, an operator who
    thinks a landing was recorded wrongly -- has to clear both, so there is one
    call that does it rather than two that have to be remembered together.

    number None forgets everything.
    """
    if number is None:
        _CACHE.clear()
    else:
        n = str(number).strip().upper()
        for k in [k for k in _CACHE if k[0] == n]:
            _CACHE.pop(k, None)

    def apply(doc):
        lands = doc.get("landings") or {}
        drop = list(lands) if number is None else             [k for k in lands if k.split("|")[0] == str(number).strip().upper()]
        if not drop:
            return None
        for k in drop:
            lands.pop(k, None)
        doc["landings"] = lands
        return doc
    pollstate.mutate_runtime(apply)


def breaker_status() -> dict:
    failures, until = _breaker_read()
    return {
        "configured": configured(),
        "shared": pollstate.configured(),
        "consecutive_failures": failures,
        "open_until": until.isoformat() if until else None,
    }


def _fetch(params):
    """One flight-summary/light query. Returns (legs, error_reason)."""
    try:
        response = _SESSION.get(
            BASE + "/flight-summary/light",
            headers={
                "Accept": "application/json",
                "Accept-Version": "v1",
                "Authorization": "Bearer " + FR24_API_TOKEN,
                "User-Agent": USER_AGENT,
            },
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return None, "transport: %s" % type(exc).__name__

    if response.status_code != 200:
        # THE STATUS AND NOTHING ELSE. The body of a 403 is a Cloudflare page
        # carrying the caller's IP and a Ray ID, and the body of a 401 is an
        # invitation to log a rejected credential. Neither belongs in a log.
        return None, "http %d" % response.status_code

    try:
        body = response.json()
    except ValueError:
        return None, "malformed json"

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        return None, "unexpected shape"
    return [row for row in data if isinstance(row, dict)], None


def _pick(legs, want_icao, registration, departure_utc):
    """The leg that is the flight we asked about, and how it was identified.

    DESTINATION IS PRIMARY. One flight number can operate two consecutive legs
    on one day -- a tag flight -- and a date range returns both. Taking the
    first would report one leg's landing for the other. This repository already
    refuses that trade on the AeroDataBox side and refuses it here too.

    REGISTRATION IS A CROSS-CHECK, NOT THE KEY. It is unambiguous when present
    and absent often enough that it cannot be relied on -- the ADS-B work found
    registrations our own records carried that no lookup resolved.
    """
    if not legs:
        return None, None
    candidates = legs
    match = "single"

    if want_icao:
        narrowed = [leg for leg in candidates if _destination(leg) == want_icao]
        if not narrowed:
            return None, "destination"
        candidates = narrowed
        match = "destination"

    if len(candidates) > 1 and registration:
        reg = str(registration).strip().upper().replace("-", "")
        by_reg = [leg for leg in candidates
                  if str(leg.get("reg") or "").strip().upper().replace("-", "") == reg]
        if by_reg:
            candidates = by_reg
            match = match + "+registration"

    if len(candidates) > 1:
        dep = _parse_instant(departure_utc)
        if dep is not None:
            def distance(leg):
                t = _parse_naive_utc(_field(leg, "datetime_takeoff", "first_seen"))
                return abs((t - dep).total_seconds()) if t else float("inf")
            candidates = sorted(candidates, key=distance)
            match = match + "+nearest"

    return candidates[0], match


def landing_for(flight_number, date=None, destination_iata=None,
                departure_utc=None, registration=None) -> dict:
    """Has this flight landed, and when?

    The only function in this project permitted to answer that question. Never
    raises: every failure is one of the four outcomes, because a caller in the
    middle of rendering a card has nothing useful to do with an exception.
    """
    number = re.sub(r"\s+", "", str(flight_number or "")).upper()
    if not number or not _FLIGHT_RE.match(number):
        return _result(ERROR, "bad flight number")
    if not configured():
        return _result(ERROR, "not configured")

    dest = str(destination_iata or "").strip().upper()
    want_icao = icao_for(dest) if _IATA_RE.match(dest) else None
    # A DESTINATION WE CANNOT TRANSLATE IS NOT A REASON TO GUESS. Without it the
    # tag-flight case picks a leg at random, so the query still runs and the
    # result is still reported -- but `match` says "single", and the caller can
    # see the answer was not confirmed against a destination.

    window = _window(date, departure_utc)
    if window is None:
        return _result(ERROR, "no usable date or departure time")

    key = (number, window[0], window[1], want_icao or dest)
    skey = "|".join(key)
    now = datetime.now(timezone.utc)

    # THE SHARED LANDING FIRST. It is immutable, so a hit here is final and
    # costs nothing -- and unlike the process cache it survives the cold start
    # between two polls.
    shared, _ = pollstate.read_runtime()
    got = (shared.get("landings") or {}).get(skey)
    if isinstance(got, dict) and got.get("result"):
        return dict(got["result"], cached="shared")

    hit = _CACHE.get(key)
    if hit is not None:
        cached_at, cached = hit
        ttl = LANDED_CACHE_TTL if cached["outcome"] == LANDED else SHORT_CACHE_TTL
        if now - cached_at < ttl:
            return dict(cached, cached=True)

    if _breaker_open(now):
        return _result(ERROR, "circuit breaker open")

    legs, reason = _fetch({
        "flight_datetime_from": window[0],
        "flight_datetime_to": window[1],
        "flights": number,
        "limit": RESULT_LIMIT,
    })
    if legs is None:
        _note_failure(now)
        logger.warning("fr24 lookup failed for %s: %s", number, reason)
        return _result(ERROR, reason)

    # A CLEAN ANSWER, EVEN AN EMPTY ONE, IS A WORKING PROVIDER. The breaker
    # counts transport and protocol failures, never "does not know" -- otherwise
    # a run of obscure flights would trip it and take the real ones down.
    _note_success()

    leg, match = _pick(legs, want_icao, registration, departure_utc)
    if leg is None:
        # WHAT WAS ACTUALLY THERE, when a destination filter rejected everything.
        #
        # NOT DEBUG SCAFFOLDING. "FR24 returned legs and none went where we
        # expected" has three very different causes -- the flight really went
        # somewhere else, our IATA->ICAO map is wrong, or the provider renamed a
        # field -- and without this they are one opaque string. The first live
        # call hit the third of those and there was nothing in the response to
        # say so.
        #
        # BOUNDED AND CHEAP: at most RESULT_LIMIT short codes, and the field
        # names only when not one leg yielded a destination at all, which is the
        # signature of a rename rather than of a wrong airport.
        seen = sorted({d for d in (_destination(l) for l in legs) if d})
        extra = {"saw_destinations": seen, "wanted": want_icao}
        if legs and not seen:
            extra["saw_fields"] = sorted(legs[0].keys())
        out = _result(UNKNOWN,
                      "no leg matched the destination" if match == "destination"
                      else "no legs returned",
                      records=len(legs), **extra)
        _CACHE[key] = (now, out)
        return out

    landed = _parse_naive_utc(leg.get("datetime_landed"))
    takeoff = _parse_naive_utc(leg.get("datetime_takeoff"))
    ended = _ended(leg.get("flight_ended"))
    actual_icao = _destination_actual(leg) or None

    common = {
        "takeoff_utc": takeoff.strftime("%Y-%m-%dT%H:%M:%S") if takeoff else None,
        "flight": leg.get("flight"),
        "registration": leg.get("reg"),
        "destination_icao": _destination(leg) or None,
        # WHERE IT ACTUALLY WENT, when that is not where it was going. FR24
        # fills this only on a diversion, so it is null on every normal leg.
        "diverted_to": actual_icao if actual_icao and actual_icao != want_icao else None,
        "match": match,
        "records": len(legs),
    }

    if landed is not None:
        # A LANDING IN THE FUTURE IS NOT A LANDING. AeroDataBox produced exactly
        # that on EK502 and it is the fault that started all of this; the rule
        # is applied to every source, including the one brought in to fix it.
        if landed > now + timedelta(minutes=5):
            out = _result(UNKNOWN, "landing time in the future", **common)
        else:
            out = _result(LANDED,
                          landed_utc=landed.strftime("%Y-%m-%dT%H:%M:%S"), **common)
    elif ended is True:
        # FR24 followed the leg to its end and still has no touchdown. A clean
        # "I do not know", which is the one outcome that lets AeroDataBox's own
        # arrival stand.
        #
        # ── IF YOU ARE HERE BECAUSE A DOHA ARRIVAL HAS NO LANDING TIME ───────
        #
        # THAT IS KNOWN, IT IS MEASURED, AND IT IS NOT A BUG IN THIS FILE.
        # DO NOT RE-INVESTIGATE IT.
        #
        # A 200-flight validation on 2026-09-07 across six regions found this
        # branch fires for arrivals into DOHA (OTHH) far more than anywhere
        # else. Same run, same hours, same region:
        #
        #     DOH   2 landed,  4 lost   ->  66.7% of finished flights lost
        #     DXB  10 landed,  0 lost   ->   0.0%
        #     AUH  12 landed,  0 lost   ->   0.0%
        #
        # Fisher exact, one-sided, DOH against DXB+AUH: p = 0.00073. That is a
        # real difference in FR24's coverage of one airport, not a small
        # denominator and not noise. Overall detection across all six regions
        # was 94.6% (106 of 112 finished flights); Doha is essentially the
        # whole of the shortfall.
        #
        # The four lost were QR515, QR615, QR8230 and QR8623 -- polled eight
        # times each over roughly three and a half hours, every one ending
        # exactly here. Two other Qatar Airways flights into DOH landed
        # normally in the same window, so it is not "QR flights fail"; the one
        # non-QR arrival we enrolled was still airborne when the run stopped,
        # so airline and airport cannot be fully separated. Either way, every
        # failure we saw was an arrival into Doha.
        #
        # NOTHING IS DONE ABOUT IT ON PURPOSE. Falling back to AeroDataBox for
        # Doha specifically would reintroduce exactly the fault this module
        # exists to prevent -- AeroDataBox declaring a landing that did not
        # happen -- and would do it at the one airport we know least about.
        # UNKNOWN is the correct answer here: it is honest, and it already
        # lets AeroDataBox's arrival stand where AeroDataBox has one.
        #
        # WHAT THIS COSTS A TRAVELLER: a Doha arrival may show no landing until
        # AeroDataBox publishes its own arrival time. That is a delay, not a
        # wrong answer, and a wrong answer is the thing worth avoiding.
        out = _result(UNKNOWN, "leg ended with no landing time", **common)
    else:
        out = _result(PENDING, "still airborne", **common)

    _CACHE[key] = (now, out)
    # ONLY A LANDING IS PROMOTED TO THE SHARED STORE. Everything else is a fact
    # about this minute and would be a write per flight per poll for nothing.
    if out["outcome"] == LANDED:
        def apply(doc):
            lands = doc.setdefault("landings", {})
            if skey in lands:
                return None
            lands[skey] = {"day": str(date or "")[:10] or window[0][:10], "result": out}
            return doc
        pollstate.mutate_runtime(apply)
    return out
