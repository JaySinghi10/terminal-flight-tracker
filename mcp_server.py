import requests
import os
import re
import time
from dotenv import load_dotenv
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from mcp.server.fastmcp import FastMCP

load_dotenv()

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY")

AERODATABOX_HOST = "aerodatabox.p.rapidapi.com"
REQUEST_TIMEOUT_SECONDS = 10

# The provider reports the monthly budget it has left on EVERY response, so the
# number is free: it is read off calls that were being made anyway and never by
# asking for it. There is no endpoint that reports quota without spending units,
# and adding one would defeat the purpose.
AERODATABOX_UNITS_HEADER = "x-ratelimit-api-units-remaining"

# Last reported value and when it was reported. Process-local, so it is empty
# after a cold start — Cloud Run scales to zero — which quota_status reports as
# an absence rather than as a zero.
_QUOTA = {"remaining": None, "at": None}

# One connection pool for the process. requests.get() builds and discards a
# Session per call, so every lookup previously paid a fresh DNS resolution, TCP
# connect and TLS handshake to RapidAPI.
_SESSION = requests.Session()

# Successful lookups only, keyed by the normalised flight number. Entries are
# ignored once older than the window, never removed: no eviction, no size cap.
FLIGHT_CACHE_TTL = timedelta(minutes=5)
_FLIGHT_CACHE = {}

mcp = FastMCP("Flight Tracker")

# ──────────────────────────────────────────────
# PROVIDER VOCABULARY
# ──────────────────────────────────────────────
# AeroDataBox status -> the lowercase vocabulary the app, the saved-flight store
# and the website already speak. Extend here; nothing else needs to change.
STATUS_MAP = {
    "Expected": "scheduled",
    "CheckIn": "scheduled",
    "Boarding": "scheduled",
    "GateClosed": "scheduled",
    # Known consequence: a flight running an hour late still shows a SCHEDULED
    # badge. Accurate but under-informative — a dedicated status is a candidate
    # for a later frontend pass, not something to work around here.
    "Delayed": "scheduled",
    "Departed": "active",
    "EnRoute": "active",
    "Approaching": "active",
    "Arrived": "landed",
    "Canceled": "cancelled",
    "CanceledUncertain": "cancelled",
    "Diverted": "diverted",
    "Unknown": "unknown",
}
_STATUS_LOOKUP = {k.lower(): v for k, v in STATUS_MAP.items()}

# There is no per-movement "has this happened yet" flag in the payload, so it is
# derived from the item-level status. These two sets are the only place that
# question is answered.
_DEPARTURE_OCCURRED = {"departed", "enroute", "approaching", "arrived"}
_ARRIVAL_OCCURRED = {"arrived"}

# Wire format for the *_iso DTO fields. Enforced before anything is emitted.
_ISO_WIRE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$")

# THREE LETTERS, and the one definition of "an IATA code" in this file. It sits
# here rather than with the route search below because fetch_flight_full reads it
# too and is defined above that section. KEEP IT ABOVE BOTH CONSUMERS: moving it
# back down would still run — module globals resolve at call time — which is
# exactly what makes that a bad place for it, since nothing would fail to warn
# you.
_IATA_RE = re.compile(r"^[A-Z]{3}$")

# Fallback for datetime strings that are well-formed but not zero-padded.
# datetime.fromisoformat rejects those outright.
_LENIENT_DT_RE = re.compile(
    r"^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?"
    r"(Z|[+-]\d{1,2}:?\d{2})?$"
)


def map_status(raw_status) -> str:
    return _STATUS_LOOKUP.get(str(raw_status or "").strip().lower(), "unknown")


def movement_has_occurred(movement: str, raw_status) -> bool:
    """Single source of truth for 'has this movement already happened?'.

    Canceled / CanceledUncertain / Diverted deliberately fall through to False:
    those flights have no trustworthy actual times.
    """
    s = str(raw_status or "").strip().lower()
    if movement == "departure":
        return s in _DEPARTURE_OCCURRED
    return s in _ARRIVAL_OCCURRED

# ──────────────────────────────────────────────
# DATETIME NORMALISATION
# ──────────────────────────────────────────────
def _normalise_dt_string(raw):
    """AeroDataBox emits '2026-08-03 21:40+04:00' (local) and '2026-08-03 17:40Z'
    (utc): space separator, bare trailing Z. Acceptance of that exact combination
    is Python-version dependent, and the Cloud Run image is not necessarily this
    interpreter — so normalise rather than trusting the parser.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return s


def _parse_dt(raw):
    s = _normalise_dt_string(raw)
    if s is None:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass

    # Not padded to width. Recover the components rather than dropping the value.
    m = _LENIENT_DT_RE.match(s)
    if not m:
        return None
    year, month, day, hour, minute, second, offset = m.groups()
    tzinfo = None
    if offset == "Z":
        tzinfo = timezone.utc
    elif offset:
        sign = 1 if offset[0] == "+" else -1
        body = offset[1:].replace(":", "")
        try:
            tzinfo = timezone(sign * timedelta(hours=int(body[:-2] or 0),
                                               minutes=int(body[-2:])))
        except ValueError:
            return None
    try:
        return datetime(int(year), int(month), int(day), int(hour), int(minute),
                        int(second or 0), tzinfo=tzinfo)
    except ValueError:
        return None


def _has_seconds(normalised: str) -> bool:
    core = re.sub(r"(Z|[+-]\d{1,2}:?\d{2})$", "", normalised or "")
    time_part = core.split("T", 1)[1] if "T" in core else ""
    return time_part.count(":") >= 2


def _to_wire_iso(local_raw, utc_raw):
    """Build one *_iso DTO value.

    These strings are LOCAL WALL-CLOCK digits carrying the TRUE local offset,
    e.g. '2026-08-04T21:40+04:00'. The app's zonedIsoToTs reads only the digits
    and discards the offset, so they must NOT be converted to UTC.
    Switching this to UTC shifts every countdown by the airport's offset with no
    exception and no blank line — a confident wrong number, the worst outcome.
    The offset is attached so the string is also correct for anything that does
    parse it; both readings agree and nothing here is deliberately wrong.
    """
    dt = _parse_dt(local_raw)
    if dt is None:
        return None

    if dt.tzinfo is None:
        # Local string carried no offset: recover it from the utc/local delta.
        utc_dt = _parse_dt(utc_raw)
        if utc_dt is None:
            return None
        secs = round((dt - utc_dt.replace(tzinfo=None)).total_seconds())
        if abs(secs) > 14 * 3600 or secs % 60:
            return None
        dt = dt.replace(tzinfo=timezone(timedelta(seconds=secs)))

    keep_seconds = _has_seconds(_normalise_dt_string(local_raw))
    core = dt.strftime("%Y-%m-%dT%H:%M:%S" if keep_seconds else "%Y-%m-%dT%H:%M")
    off = dt.strftime("%z")
    wire = f"{core}{off[:3]}:{off[3:]}"

    if not _ISO_WIRE_RE.match(wire):
        print("ISO WIRE ASSERTION FAILED; refusing to emit:", repr(wire))
        return None
    return wire


def _delay_minutes(scheduled_utc, comparison_utc):
    """Signed whole minutes, negative meaning early. Compared UTC-to-UTC."""
    sched = _parse_dt(scheduled_utc)
    other = _parse_dt(comparison_utc)
    if sched is None or other is None:
        return None
    if sched.tzinfo is None:
        sched = sched.replace(tzinfo=timezone.utc)
    if other.tzinfo is None:
        other = other.replace(tzinfo=timezone.utc)
    return int(round((other - sched).total_seconds() / 60))

# ──────────────────────────────────────────────
# FORMAT TIME
# ──────────────────────────────────────────────
def _record_quota(response) -> None:
    """Remember what the provider says is left. Never raises, never blocks.

    Called on every response including failures: a 4xx still carries the header,
    and a rejected call still spent nothing, so the number is still true.
    """
    try:
        raw = response.headers.get(AERODATABOX_UNITS_HEADER)
        if raw is None:
            return
        _QUOTA["remaining"] = int(str(raw).strip())
        _QUOTA["at"] = datetime.now(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return


def quota_status() -> dict:
    """The provider's own count, and how old it is.

    The age is what keeps this honest. A cached route or flight answer involves
    no provider call, so attaching a units figure to it would report a number
    from some earlier call as though it had just been measured. Here the caller
    is told exactly when it was last true and can decide for itself.

    Never triggers a call.
    """
    at = _QUOTA["at"]
    if at is None:
        return {
            "units_remaining": None,
            "as_of_seconds_ago": None,
            "error": "No provider call has been made since this server started.",
        }
    return {
        "units_remaining": _QUOTA["remaining"],
        "as_of_seconds_ago": int((datetime.now(timezone.utc) - at).total_seconds()),
        "error": None,
    }


def format_time(time_str, tz_name=None):
    if not time_str:
        return "N/A"
    dt = _parse_dt(time_str)
    if dt is None:
        return "N/A"
    dt = dt.replace(tzinfo=None)

    period = "AM" if dt.hour < 12 else "PM"
    display_hour = dt.hour if dt.hour <= 12 else dt.hour - 12
    if display_hour == 0:
        display_hour = 12
    time_part = f"{display_hour}:{dt.minute:02d} {period}"

    label = None
    if tz_name:
        try:
            abbr = dt.replace(tzinfo=ZoneInfo(tz_name)).tzname()
        except Exception:
            abbr = None
        if abbr:
            if abbr[0].isalpha():
                label = abbr
            else:
                m = re.match(r'^([+-])(\d{1,2})(?::?(\d{2}))?$', abbr)
                if m:
                    sign, hh, mm = m.group(1), int(m.group(2)), m.group(3)
                    label = f"GMT{sign}{hh}:{mm}" if mm and int(mm) != 0 else f"GMT{sign}{hh}"

    return f"{time_part} {label}" if label else time_part

# ──────────────────────────────────────────────
# EXTRACT FLIGHT NUMBER FROM TEXT USING REGEX
# ──────────────────────────────────────────────
def extract_flight_number(text: str):
    pattern = r'\b([A-Z]{1,2}\d{1,4}|[0-9][A-Z]\d{1,4})\b'
    matches = re.findall(pattern, text.upper())
    return matches[0] if matches else None

# ──────────────────────────────────────────────
# PROVIDER -> DTO
# ──────────────────────────────────────────────
def _times(movement: dict, field: str):
    block = movement.get(field) or {}
    return block.get("local"), block.get("utc")


def _build_movement(movement, movement_name: str, raw_status, include_baggage: bool) -> dict:
    m = movement or {}
    airport = m.get("airport") or {}
    tz = airport.get("timeZone")
    occurred = movement_has_occurred(movement_name, raw_status)

    # Cancelled and diverted flights get no estimate and no delay. "Cancelled,
    # 30 minutes late" is meaningless, and for a diverted flight the arrival
    # airport in the response is still the ORIGINAL one — an ETA there is an ETA
    # for somewhere the aircraft is no longer going. Scheduled times are still
    # emitted so the card shows the original time instead of going blank.
    suppress_forecast = map_status(raw_status) in ("cancelled", "diverted")

    sched_local, sched_utc = _times(m, "scheduledTime")
    rev_local, rev_utc = _times(m, "revisedTime")
    pred_local, pred_utc = _times(m, "predictedTime")
    run_local, run_utc = _times(m, "runwayTime")

    # actual and estimated are mutually exclusive: a movement is either done or
    # forecast, never both. revisedTime is an estimate before the event and the
    # actual after it, which is why the branch is on occurrence, not precedence.
    actual_local = actual_utc = actual_source = None
    est_local = est_utc = est_source = None
    if occurred:
        # Gate times first: runwayTime is wheels-off/on and is not comparable
        # with the scheduled gate time, so it would inflate every delay.
        if rev_local:
            actual_local, actual_utc, actual_source = rev_local, rev_utc, "revised"
        elif run_local:
            actual_local, actual_utc, actual_source = run_local, run_utc, "runway"
    elif not suppress_forecast:
        if rev_local:
            est_local, est_utc, est_source = rev_local, rev_utc, "revised"
        elif pred_local:
            est_local, est_utc, est_source = pred_local, pred_utc, "predicted"

    # Delay compares like with like: the actual once the movement has happened,
    # otherwise the current estimate. A flight that has not left yet but is
    # running an hour late is delayed NOW, and that is the headline fact on the
    # card. Null only when there is neither an actual nor an estimate.
    comparison_utc = actual_utc if occurred else est_utc

    out = {
        "airport": airport.get("name"),
        # The city, which is NOT the airport name: BOM is name="Mumbai
        # Chhatrapati Shivaji", municipalityName="Mumbai". Absent on some
        # airports, so consumers must fall back to the name.
        "city": airport.get("municipalityName"),
        # The airport's own name with the city stripped off: BOM is
        # name="Mumbai Chhatrapati Shivaji", shortName="Chhatrapati Shivaji".
        "short_name": airport.get("shortName"),
        "iata": airport.get("iata"),
        "terminal": m.get("terminal"),
        "gate": m.get("gate"),
        "checkin_desk": m.get("checkInDesk"),
        "scheduled": format_time(sched_local, tz),
        "actual": format_time(actual_local, tz),
        "estimated": format_time(est_local, tz) if est_local else None,
        "delay": _delay_minutes(sched_utc, comparison_utc) if comparison_utc else None,
        # LOCAL wall clock + true offset — see _to_wire_iso. Never UTC.
        "scheduled_iso": _to_wire_iso(sched_local, sched_utc),
        "estimated_iso": _to_wire_iso(est_local, est_utc) if est_local else None,
        "actual_iso": _to_wire_iso(actual_local, actual_utc) if actual_local else None,
        "timezone": tz,
        "actual_source": actual_source,
        "estimated_source": est_source,
        "runway_time": format_time(run_local, tz) if run_local else None,
    }
    if include_baggage:
        # baggageBelt only appears once the flight has landed; N/A before that.
        out["baggage"] = m.get("baggageBelt")
    return out


def _build_dto(item) -> dict:
    it = item or {}
    raw_status = it.get("status")
    airline = it.get("airline") or {}
    aircraft = it.get("aircraft") or {}

    departure = _build_movement(it.get("departure"), "departure", raw_status, False)
    arrival = _build_movement(it.get("arrival"), "arrival", raw_status, True)

    # "EK 500" arrives with a space; the saved-flight id is built from this.
    flight_number = re.sub(r"\s+", "", str(it.get("number") or "")).upper()

    # Derived from the departure LOCAL date. Deriving it from UTC would put
    # early-morning departures on the wrong calendar day.
    flight_date = (departure.get("scheduled_iso") or "")[:10] or None

    return {
        "airline": airline.get("name"),
        "flight_number": flight_number,
        "flight_date": flight_date,
        "status": map_status(raw_status),
        # The provider's own vocabulary, carried verbatim. Nothing renders it;
        # it exists so a live response can be diagnosed without another call.
        "raw_status": raw_status,
        "aircraft_model": aircraft.get("model"),
        "aircraft_registration": aircraft.get("reg"),
        "departure": departure,
        "arrival": arrival,
    }


def _movement_utc(item: dict, movement: str):
    """Scheduled UTC for one movement, as an aware datetime, or None."""
    raw = ((item.get(movement) or {}).get("scheduledTime") or {}).get("utc")
    dt = _parse_dt(raw)
    if dt is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _arrival_key(item: dict):
    """Arrival scheduled UTC, falling back to the departure when absent."""
    return _movement_utc(item, "arrival") or _movement_utc(item, "departure")


def _departure_iata(item: dict) -> str:
    """The item's departure airport code, upper-cased, or "" when absent."""
    airport = ((item or {}).get("departure") or {}).get("airport") or {}
    return str(airport.get("iata") or "").strip().upper()


def _select_item(items: list):
    """Chooses between DAYS. It cannot choose between LEGS.

    The endpoint returns every matching day, so one has to be chosen.
    Nearest-to-now is symmetric and will happily pick a flight that finished
    yesterday over one departing this evening. Prefer the next relevant flight:
    the earliest one still to arrive, and only when none remain, the most
    recently departed.

    THAT RULE IS MEANINGLESS ACROSS LEGS. A tag flight — one number operating
    BOM-DEL then DEL-BOM the same day — puts two items in this list, both still
    to arrive, and "the earliest one still to arrive" then returns the first leg
    no matter which one the caller wanted. Nothing here can do better: this
    function is never told an origin, and the two items are equally valid
    answers to "this number, this day".

    So the CALLER filters by departure airport before calling this, and what
    arrives here is one leg's worth of days. See fetch_flight_full.
    """
    now = datetime.now(timezone.utc)

    upcoming = []
    for it in items:
        key = _arrival_key(it)
        if key is not None and key > now:
            upcoming.append((key, it))
    if upcoming:
        return min(upcoming, key=lambda pair: pair[0])[1]

    past = []
    for it in items:
        key = _movement_utc(it, "departure")
        if key is not None:
            past.append((key, it))
    if past:
        return max(past, key=lambda pair: pair[0])[1]

    return items[0] if items else None

# ──────────────────────────────────────────────
# DTO -> HUMAN READABLE BLOCK FOR CLAUDE
# ──────────────────────────────────────────────
def _movement_lines(title: str, mv: dict, include_baggage: bool) -> list:
    lines = [
        title,
        f"Airport  : {mv.get('airport') or 'N/A'} ({mv.get('iata') or 'N/A'})",
        f"Terminal : {mv.get('terminal') or 'N/A'} | Gate: {mv.get('gate') or 'N/A'}",
        f"Scheduled: {mv.get('scheduled') or 'N/A'}",
        f"Actual   : {mv.get('actual') or 'N/A'}",
    ]

    if mv.get("estimated_iso"):
        estimated = format_time(mv.get("estimated_iso"), mv.get("timezone"))
        if mv.get("estimated_source") == "predicted":
            estimated = f"{estimated} (predicted)"
        lines.append(f"Estimated: {estimated}")

    if include_baggage:
        lines.append(f"Baggage  : {mv.get('baggage') or 'N/A'}")

    # Wording only — the DTO keeps the honest signed integer, which the app and
    # the website consume and the countdown arithmetic depends on. A negative
    # delay means EARLY, and the system prompt tells Claude to reproduce tool
    # values exactly, so "⚠ Delay: -17 minutes" would be relayed as a delay on
    # what is actually good news. Zero still renders no line at all.
    delay = mv.get("delay")
    if delay:
        magnitude = abs(delay)
        unit = "minute" if magnitude == 1 else "minutes"
        if delay > 0:
            lines.append(f"⚠ Delay: {magnitude} {unit}")
        else:
            lines.append(f"✓ {magnitude} {unit} early")
    return lines


def _render_text(dto: dict) -> str:
    departure = dto.get("departure") or {}
    arrival = dto.get("arrival") or {}
    lines = [
        f"✈ {dto.get('airline') or 'N/A'} | Flight {dto.get('flight_number') or 'N/A'} "
        f"| {dto.get('flight_date') or 'N/A'}",
        "",
        f"STATUS: {(dto.get('status') or 'unknown').upper()}",
        "",
    ]
    lines += _movement_lines("DEPARTURE", departure, False)
    lines.append("")
    lines += _movement_lines("ARRIVAL", arrival, True)
    return "\n".join(lines).strip()

# ──────────────────────────────────────────────
# FETCH FLIGHT STATUS FROM AERODATABOX
# ──────────────────────────────────────────────
def fetch_flight_full(flight_number: str, date: str | None = None,
                      origin: str | None = None) -> tuple[str, dict | None]:
    """One flight, optionally on a specific local departure date and from a
    specific airport.

    date is None for the behaviour this has always had: the provider picks the
    nearest instance to now, and _select_item narrows it. A "YYYY-MM-DD" uses the
    provider's dated form instead, which returns that day's instance and nothing
    else. Both forms are TIER 2 upstream, so the date costs no extra units.

    origin is the departure IATA code the caller is asking about, and it is what
    disambiguates a TAG FLIGHT: one number operating consecutive legs on one day
    returns two items, and the date cannot separate them because they share it.
    None means "whichever leg the provider offers", which is every caller's
    behaviour before this existed and is still correct where the caller genuinely
    does not know — a flight number typed into the search box names no airport.
    It costs no extra units: it filters a response that was fetched anyway.
    """
    number = re.sub(r"\s+", "", str(flight_number or "")).upper()
    day = str(date).strip() if date is not None and str(date).strip() else None
    # Anything that is not exactly three letters is not a code, so it is treated
    # as absent rather than as a filter that can never match.
    org = str(origin or "").strip().upper()
    org = org if _IATA_RE.match(org) else None
    not_found = (
        f"No flight found for {number} on {day}."
        if day else
        f"No flight found for {number}. Make sure it is operating today.",
        None,
    )
    if not number:
        return not_found
    if not RAPIDAPI_KEY:
        return ("Flight lookup is not configured: RAPIDAPI_KEY is not set.", None)

    # The date AND THE ORIGIN are PART OF THE KEY, for the same reason the board
    # cache keys on the date: keyed on the number alone, a dated lookup would be
    # handed whichever instance happened to be cached — right flight, wrong day,
    # no error. The origin is on the key because the filtering below happens
    # AFTER the cache is consulted, so a hit returns a finished result and no
    # filter ever runs on it. An origin outside the key would mean the first
    # caller to ask for a number picks the leg every later caller is given.
    key = (number, day, org)
    cached = _FLIGHT_CACHE.get(key)
    if cached is not None:
        cached_at, cached_result = cached
        if datetime.now(timezone.utc) - cached_at < FLIGHT_CACHE_TTL:
            return cached_result

    # Departure, not Both, on the dated form. The board defines a row's day by
    # its DEPARTURE local date, so that is the day being asked about. Both would
    # additionally match a flight arriving that date — one that departed the day
    # before — and hand _select_item two instances to choose between on
    # proximity to now, which is the very fault this is fixing.
    #
    # WHAT IT DOES NOT SOLVE: two legs sharing one departure date. Departure
    # excludes YESTERDAY's leg; it cannot exclude the second leg of a tag flight,
    # because that one departs on the date being asked for and is exactly what
    # the parameter selects for. Only the origin filter below separates those.
    url = (f"https://{AERODATABOX_HOST}/flights/number/{number}/{day}"
           if day else
           f"https://{AERODATABOX_HOST}/flights/number/{number}")

    try:
        response = _SESSION.get(
            url,
            headers={
                "X-RapidAPI-Key": RAPIDAPI_KEY,
                "X-RapidAPI-Host": AERODATABOX_HOST,
            },
            params={"dateLocalRole": "Departure" if day else "Both"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return not_found
    _record_quota(response)

    # 204 and an empty body both mean "nothing known"; .json() would raise.
    if response.status_code != 200 or not response.content:
        return not_found

    try:
        data = response.json()
    except ValueError:
        return not_found

    if not isinstance(data, list) or not data:
        return not_found

    # BEFORE _select_item, which chooses between days and has no way to choose
    # between legs. Filtering here is what makes its rule meaningful again.
    if org is not None:
        data = [it for it in data if _departure_iata(it) == org]
        # NO FALLBACK TO THE UNFILTERED LIST, and this is the whole fix. Falling
        # back is the bug: the caller asked for the leg leaving org, and handing
        # it a different leg means the app opens a card for a flight the user did
        # not tap and — where that id is already saved — writes it over the stored
        # record. A miss is recoverable and visible. A confident wrong leg is
        # neither. If this ever needs relaxing, the answer is a new field saying
        # "this is not the leg you asked for", not a silent substitution.
        #
        # ACCEPTED COST: an item carrying no departure IATA at all is dropped by
        # the same rule, so a gap in the provider's data becomes a visible miss
        # rather than a wrong leg. That is the intended direction.
        if not data:
            return not_found

    item = _select_item(data)
    if item is None:
        return not_found

    dto = _build_dto(item)
    if not dto.get("flight_date") or not dto.get("flight_number"):
        # A response with no departure scheduled local time is malformed enough
        # that the rest of it cannot be trusted either. Report a miss rather
        # than emitting a partial DTO.
        return not_found

    result = (_render_text(dto), dto)
    _FLIGHT_CACHE[key] = (datetime.now(timezone.utc), result)
    return result


def fetch_flight(flight_number: str) -> str:
    return fetch_flight_full(flight_number)[0]


# ──────────────────────────────────────────────
# ROUTE SEARCH
# ──────────────────────────────────────────────
# A board covers a 12-hour window and costs the same regardless of how many
# routes are read out of it, so it is cached far longer than a single flight.
ROUTE_CACHE_TTL = timedelta(minutes=30)
_ROUTE_CACHE = {}

# The window requested upstream. Callers narrow within it; they cannot widen it
# without a second board fetch, which is the whole point of caching one board.
ROUTE_WINDOW_MINUTES = 720
ROUTE_MAX_RESULTS = 25

# General aviation, dropped explicitly. withPrivate=false is already in
# _ROUTE_FLAGS and the provider ignores it: a twelve-hour DEL board carries five
# "Private" rows, ZZ-numbered, off the general aviation terminal. A missing IATA
# code used to drop them by accident. Now that a name alone is enough to keep a
# row, they have to be excluded on purpose or the board fills with private jets.
ROUTE_EXCLUDED_AIRLINES = ("Private",)

# How many name-only rows travel per response. They are candidates, not matches,
# and the client discards most of them: ten survived on a 271-row DEL board.
# 25 was sized for a rolling twelve-hour window, where uncoded rows are a
# handful and 25 covers them several times over. A DATED day is a different
# shape: SFO on 2026-10-03 came back with every single row uncoded — the
# provider ships future schedules without destination codes — so the cap became
# a truncation of the board itself, cutting the day off at 16:40 and hiding
# every evening long-haul from a client that could have resolved it by name.
#
# 250 covers a full day at a large hub. The payload is the cost: an uncoded row
# is about 300 bytes, so a worst case is roughly 75KB against the 9KB that
# search returned. That is the right trade for a search that costs four units —
# a truncated answer is worse than a large one.
#
# ROUTE_MAX_RESULTS stays at 25. That caps what the client SHOWS, which is a
# different question from how many candidates it needs to sift.
ROUTE_MAX_UNRESOLVED = 250

# A dated board is a published schedule, not a live one: it moves when an airline
# retimes or swaps equipment, which is days apart, not minutes. Twelve hours
# means at most two refreshes per date per day of interest while still catching a
# retiming the same day it lands. Longer buys little in practice — Cloud Run
# scales to zero, so the process cache usually dies long before any TTL expires.
ROUTE_FUTURE_CACHE_TTL = timedelta(hours=12)

# The provider caps ANY FIDS range at 12 hours. Verified live: a single
# 00:00-23:59 request returns HTTP 400, "The requested period of time be positive
# and must not be more than 12 hours in duration". A local day therefore takes
# two calls, so a dated search costs 4 units where an undated one costs 2.
#
# The halves overlap at 12:00 deliberately. The provider does not document
# whether a bound is inclusive, and an overlap that is deduplicated is safe
# either way, where a seam at 11:59/12:00 would silently drop a noon departure if
# both ends turned out to be exclusive.
ROUTE_DAY_WINDOWS = (("00:00", "12:00"), ("12:00", "23:59"))

# The BASIC plan rejects a second request inside the same second with HTTP 429 —
# observed live, the second window coming back 429 while the first succeeded. The
# app has spaced its saved-flight refreshes past this ceiling since the original
# 429 diagnosis; a dated board is the first place the BACKEND makes two calls in
# a row, so it needs the same treatment. Applied between windows only: never
# before the first, never after the last.
ROUTE_WINDOW_SPACING_SECONDS = 1.3

# The diagnostic verified 7, 30 and 60 days ahead on this plan. 60 is where the
# evidence stops, so it is where we stop: beyond it we would be guessing.
ROUTE_MAX_FUTURE_DAYS = 60

# Local dates run from UTC-12 to UTC+14, so an airport's own calendar date can be
# a day behind the server's UTC date. One day of slack lets a genuinely-today
# request through for those airports without opening up real history.
ROUTE_MAX_PAST_DAYS = 1

# _IATA_RE now lives with the other module regexes at the top of the file, where
# fetch_flight_full can also reach it. Nothing else about it changed.
_ROUTE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Identical on both the relative and the absolute path, so neither can drift.
_ROUTE_FLAGS = {
    "direction": "Departure",
    # Strings, not Python bools: requests would encode those as
    # "True"/"False", which the provider does not accept.
    "withLeg": "true",
    "withCancelled": "false",
    "withCodeshared": "false",
    "withCargo": "false",
    "withPrivate": "false",
    "withLocation": "false",
}

def _build_route_row(item):
    """One compact board row, or None when the item cannot be used.

    withLeg=true gives every board item the same "departure"/"arrival" blocks the
    per-flight endpoint returns, so the existing time helpers apply unchanged and
    no new date handling is introduced here.
    """
    it = item if isinstance(item, dict) else {}
    departure = it.get("departure") or {}
    arrival = it.get("arrival") or {}
    dep_airport = departure.get("airport") or {}
    dest_airport = arrival.get("airport") or {}

    dest_iata = dest_airport.get("iata")
    dest_name = dest_airport.get("name")
    dep_utc = _movement_utc(it, "departure")

    if str((it.get("airline") or {}).get("name") or "").strip() in ROUTE_EXCLUDED_AIRLINES:
        return None

    # A destination IDENTIFIER of some kind, and a departure UTC. The code is no
    # longer required: the provider frequently knows the airport by name only,
    # and fifteen rows of a twelve-hour DEL board were being discarded for it —
    # ten of them real commercial flights, including AI 2795 to Bengaluru. The
    # name travels instead and the client resolves it against the airport data
    # it already ships. Without a departure UTC a row can be neither sorted nor
    # windowed, so that half of the guard is unchanged.
    if (not dest_iata and not dest_name) or dep_utc is None:
        return None

    dep_local, dep_utc_raw = _times(departure, "scheduledTime")
    arr_local, arr_utc_raw = _times(arrival, "scheduledTime")
    dep_tz = dep_airport.get("timeZone")
    arr_tz = dest_airport.get("timeZone")

    return {
        "flight_number": re.sub(r"\s+", "", str(it.get("number") or "")).upper(),
        "airline": (it.get("airline") or {}).get("name"),
        # None when the provider named the airport without coding it. The KEY
        # is always present, so the payload keeps its shape.
        "destination_iata": dest_iata,
        "destination_airport": dest_name,
        "departure_scheduled": format_time(dep_local, dep_tz),
        "departure_scheduled_iso": _to_wire_iso(dep_local, dep_utc_raw),
        "departure_timezone": dep_tz,
        # None, never the string "N/A". A board row can carry a destination
        # airport and no arrival time at all: the provider sends the arrival
        # airport plus an empty quality array and nothing else. format_time
        # answers "N/A" to an absent value, and that sentinel is what put the
        # literal "N/A" on screen. arrival_scheduled_iso was already None in
        # exactly this case, so the two now agree.
        #
        # The KEY is still emitted, carrying null. Nothing is dropped from the
        # payload, so the frontend contract keeps its shape.
        #
        # Same conditional form _build_movement already uses for "estimated" and
        # "runway_time". format_time is not modified: the flight-number path and
        # the saved-flight store both depend on its "N/A".
        "arrival_scheduled": format_time(arr_local, arr_tz) if arr_local else None,
        "arrival_scheduled_iso": _to_wire_iso(arr_local, arr_utc_raw),
        "arrival_timezone": arr_tz,
        "status": map_status(it.get("status")),
        "aircraft_model": (it.get("aircraft") or {}).get("model"),
        # Sort and window key. Private, and stripped before anything is emitted.
        "_dep_utc": dep_utc,
    }


def _fetch_board_window(code: str, day, start, end):
    """Exactly one upstream call. Returns the board rows, or None on failure.

    day is None for the relative form (a rolling window from now), or a local
    "YYYY-MM-DD" for the absolute form, in which case start and end are local
    "HH:MM" bounds at that airport.
    """
    if day is None:
        url = f"https://{AERODATABOX_HOST}/flights/airports/iata/{code}"
        params = {
            "offsetMinutes": 0,
            "durationMinutes": ROUTE_WINDOW_MINUTES,
            **_ROUTE_FLAGS,
        }
    else:
        # Absolute form: the bounds live in the path and are LOCAL to the
        # airport, so offsetMinutes and durationMinutes have no meaning here and
        # are omitted entirely.
        url = (f"https://{AERODATABOX_HOST}/flights/airports/iata/{code}"
               f"/{day}T{start}/{day}T{end}")
        params = dict(_ROUTE_FLAGS)

    try:
        response = _SESSION.get(
            url,
            headers={
                "X-RapidAPI-Key": RAPIDAPI_KEY,
                "X-RapidAPI-Host": AERODATABOX_HOST,
            },
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return None
    _record_quota(response)

    if response.status_code != 200 or not response.content:
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    if not isinstance(payload, dict):
        return None

    items = payload.get("departures")
    if items is None:
        # Absent or null is a legitimately empty board, not a failure.
        items = []
    if not isinstance(items, list):
        return None

    return [r for r in (_build_route_row(it) for it in items) if r is not None]


def _fetch_board(code: str, day: str | None = None):
    """Trimmed departure board for one airport, cached.

    day is None for the rolling window from now — one call, ROUTE_CACHE_TTL — or a
    local "YYYY-MM-DD", which takes one call per entry in ROUTE_DAY_WINDOWS and
    lives for ROUTE_FUTURE_CACHE_TTL.

    Returns (rows, age_seconds, cache_hit). rows is None on any failure. Only a
    cleanly parsed board is ever cached, and only the trimmed rows: the raw
    response is never retained.
    """
    # The date is PART OF THE KEY. Keyed on the code alone, a dated search would
    # be served the rolling board silently — right shape, wrong day, no error.
    key = (code, day)
    ttl = ROUTE_CACHE_TTL if day is None else ROUTE_FUTURE_CACHE_TTL

    cached = _ROUTE_CACHE.get(key)
    if cached is not None:
        cached_at, rows = cached
        age = datetime.now(timezone.utc) - cached_at
        if age < ttl:
            return rows, int(age.total_seconds()), True

    if day is None:
        rows = _fetch_board_window(code, None, None, None)
        if rows is None:
            return None, None, False
    else:
        rows, seen = [], set()
        for index, (start, end) in enumerate(ROUTE_DAY_WINDOWS):
            # Between windows only, so a single-window day would wait no longer
            # than it does today.
            if index > 0:
                time.sleep(ROUTE_WINDOW_SPACING_SECONDS)
            part = _fetch_board_window(code, day, start, end)
            if part is None:
                # Fail closed. Half a day presented as a whole one is the same
                # class of defect as serving the wrong day: wrong, and silent.
                return None, None, False
            for r in part:
                # The halves overlap at 12:00, so a noon departure arrives twice.
                marker = (r["flight_number"], r["_dep_utc"])
                if marker in seen:
                    continue
                seen.add(marker)
                rows.append(r)

    _ROUTE_CACHE[key] = (datetime.now(timezone.utc), rows)
    return rows, 0, False


def _route_result(origin, destination, hours, flights=None, total_found=0,
                  data_age_seconds=None, error=None, date=None,
                  unresolved=None) -> dict:
    """Every response carries the same keys, so a caller never branches on
    key presence — only on whether "error" is None."""
    flights = flights or []
    unresolved = unresolved or []
    return {
        "origin": origin,
        "destination": destination,
        "window_hours": hours,
        # None for the rolling window; a local calendar date when one was asked
        # for. window_hours does not apply to a dated search, which is the day.
        "date": date,
        "count": len(flights),
        "total_found": total_found,
        "truncated": total_found > len(flights),
        "data_age_seconds": data_age_seconds,
        "flights": flights,
        # Board rows carrying a destination NAME and no code. Candidates only:
        # they are deliberately absent from count, total_found and truncated,
        # which go on describing "flights" exactly as they always have. A client
        # that does not know this key behaves precisely as it does today.
        "unresolved": unresolved,
        "error": error,
    }


def _validate_route_date(raw):
    """(day, error). day is None for a rolling search, a "YYYY-MM-DD" string for a
    dated one. Every rejection happens before any network call, so a malformed
    date costs nothing upstream.
    """
    if raw is None or str(raw).strip() == "":
        return None, None

    day = str(raw).strip()
    if not _ROUTE_DATE_RE.match(day):
        return None, "Date must be in YYYY-MM-DD form."

    try:
        asked = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        return None, f"{day} is not a real calendar date."

    # Bounded against the SERVER's UTC date. An airport's own date can sit a day
    # either side of that, which ROUTE_MAX_PAST_DAYS absorbs at the near end.
    today = datetime.now(timezone.utc).date()
    if asked < today - timedelta(days=ROUTE_MAX_PAST_DAYS):
        return None, "Route search does not cover past dates."
    if asked > today + timedelta(days=ROUTE_MAX_FUTURE_DAYS):
        return None, f"Route search reaches {ROUTE_MAX_FUTURE_DAYS} days ahead at most."
    return day, None


def fetch_route(origin, destination, hours=12, date=None) -> dict:
    """Scheduled departures from origin to destination within the next `hours`.

    Every rejection here happens before any network call, so a malformed request
    costs nothing upstream.
    """
    o = str(origin or "").strip().upper()
    d = str(destination or "").strip().upper()

    # Coerced first so that even a rejection reports a sane window.
    try:
        window = int(hours)
    except (TypeError, ValueError):
        window = 12
    window = max(1, min(12, window))

    day, date_error = _validate_route_date(date)
    if date_error is not None:
        return _route_result(o, d, window, error=date_error)

    if not _IATA_RE.match(o) or not _IATA_RE.match(d):
        return _route_result(o, d, window,
                             error="Origin and destination must both be 3-letter IATA codes.",
                             date=day)
    if o == d:
        return _route_result(o, d, window,
                             error="Origin and destination must be different airports.",
                             date=day)
    if not RAPIDAPI_KEY:
        return _route_result(o, d, window,
                             error="Route lookup is not configured: RAPIDAPI_KEY is not set.",
                             date=day)

    # _fetch_board still reports whether it served the cache; nothing here needs
    # it now that the diagnostic line is gone.
    rows, age_seconds, _ = _fetch_board(o, day)
    if rows is None:
        return _route_result(o, d, window,
                             error=f"Could not load the departure board for {o}.",
                             date=day)

    if day is None:
        # Unchanged: the rolling window from now.
        now = datetime.now(timezone.utc)
        horizon = now + timedelta(hours=window)
        def in_window(r):
            return now <= r["_dep_utc"] <= horizon
    else:
        # The first ten characters of departure_scheduled_iso are the LOCAL
        # calendar date at the origin, so this needs no timezone knowledge and
        # cannot drift with the server's clock.
        def in_window(r):
            return (r.get("departure_scheduled_iso") or "")[:10] == day

    matched = sorted(
        (r for r in rows if r["destination_iata"] == d and in_window(r)),
        key=lambda r: r["_dep_utc"],
    )
    kept = matched[:ROUTE_MAX_RESULTS]

    # Cannot be matched here. The request arrives AS a code and this process has
    # no name-to-code map — the airport data lives on the device — so these
    # travel and the client decides which of them are for this destination.
    unresolved = sorted(
        (r for r in rows if r["destination_iata"] is None and in_window(r)),
        key=lambda r: r["_dep_utc"],
    )[:ROUTE_MAX_UNRESOLVED]

    return _route_result(
        o, d, window,
        # Fresh dicts. A caller must never hold a reference into the cache.
        flights=[{k: v for k, v in r.items() if k != "_dep_utc"} for r in kept],
        unresolved=[{k: v for k, v in r.items() if k != "_dep_utc"} for r in unresolved],
        total_found=len(matched),
        data_age_seconds=age_seconds,
        date=day,
    )


# ──────────────────────────────────────────────
# SEARCH GMAIL FOR FLIGHT BOOKING EMAILS
# ──────────────────────────────────────────────
def search_gmail_for_flight() -> str:
    if not ANTHROPIC_KEY:
        return "ANTHROPIC_KEY_MISSING"

    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }

    # Call Claude API with Gmail MCP to find flight booking emails
    body = {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1000,
        "system": "You are a flight booking email scanner. Search the user's Gmail for recent flight booking confirmation emails from airlines like Air India, IndiGo, SpiceJet, Emirates, etc. Extract the flight number from the most recent booking. Return ONLY the flight number in this exact format: FLIGHT:XX1234. If no booking emails found, return: FLIGHT:NONE",
        "messages": [
            {
                "role": "user",
                "content": "Search my Gmail for the most recent flight booking confirmation email and extract the flight number."
            }
        ],
        "mcp_servers": [
            {
                "type": "url",
                "url": "https://gmailmcp.googleapis.com/mcp/v1",
                "name": "gmail"
            }
        ]
    }

    response = requests.post(url, headers=headers, json=body)
    data = response.json()

    if "content" not in data:
        return "FLIGHT:NONE"

    text = " ".join([b["text"] for b in data["content"] if b["type"] == "text"])
    match = re.search(r'FLIGHT:([A-Z0-9]+)', text)
    if match:
        return match.group(1)
    return "NONE"

# ──────────────────────────────────────────────
# MAIN AGENT TOOL
# ──────────────────────────────────────────────
@mcp.tool()
def check_my_flight(query: str) -> str:
    """
    Smart flight status checker.
    If a flight number is given (e.g. AI2630), check it directly.
    If the question is vague (e.g. 'what's my flight status?'),
    scan Gmail for recent booking confirmations and check that flight.
    """
    # Mode 1 — check if a flight number is in the query
    flight_number = extract_flight_number(query)

    if flight_number:
        return fetch_flight(flight_number)

    # Mode 2 — vague question, scan Gmail
    if not ANTHROPIC_KEY:
        return "To check your flight from Gmail automatically, please add your ANTHROPIC_API_KEY to the .env file."

    flight_from_gmail = search_gmail_for_flight()

    if flight_from_gmail == "NONE" or flight_from_gmail == "ANTHROPIC_KEY_MISSING":
        return "I couldn't find any recent flight booking emails in your Gmail. Please provide a flight number directly, e.g. 'status of AI2630'."

    return fetch_flight(flight_from_gmail)

# ──────────────────────────────────────────────
# EXISTING TOOL — KEPT FOR DIRECT LOOKUPS
# ──────────────────────────────────────────────
@mcp.tool()
def get_flight_status(flight_number: str) -> str:
    """Get the current status of a flight by its flight number e.g. AI2630, 6E5031"""
    return fetch_flight(flight_number)

if __name__ == "__main__":
    mcp.run(transport="stdio")
