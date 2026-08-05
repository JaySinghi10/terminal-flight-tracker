import requests
import os
import re
from dotenv import load_dotenv
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from mcp.server.fastmcp import FastMCP

load_dotenv()

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY")

AERODATABOX_HOST = "aerodatabox.p.rapidapi.com"
REQUEST_TIMEOUT_SECONDS = 10

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
        "iata": airport.get("iata"),
        "terminal": m.get("terminal"),
        "gate": m.get("gate"),
        "scheduled": format_time(sched_local, tz),
        "actual": format_time(actual_local, tz),
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


def _select_item(items: list):
    """The endpoint returns every matching day, so one has to be chosen.

    Nearest-to-now is symmetric and will happily pick a flight that finished
    yesterday over one departing this evening. Prefer the next relevant flight:
    the earliest one still to arrive, and only when none remain, the most
    recently departed.
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
def fetch_flight_full(flight_number: str) -> tuple[str, dict | None]:
    number = re.sub(r"\s+", "", str(flight_number or "")).upper()
    not_found = (
        f"No flight found for {number}. Make sure it is operating today.",
        None,
    )
    if not number:
        return not_found
    if not RAPIDAPI_KEY:
        return ("Flight lookup is not configured: RAPIDAPI_KEY is not set.", None)

    try:
        response = requests.get(
            f"https://{AERODATABOX_HOST}/flights/number/{number}",
            headers={
                "X-RapidAPI-Key": RAPIDAPI_KEY,
                "X-RapidAPI-Host": AERODATABOX_HOST,
            },
            params={"dateLocalRole": "Both"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return not_found

    # 204 and an empty body both mean "nothing known"; .json() would raise.
    if response.status_code != 200 or not response.content:
        return not_found

    try:
        data = response.json()
    except ValueError:
        return not_found

    if not isinstance(data, list) or not data:
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

    return (_render_text(dto), dto)


def fetch_flight(flight_number: str) -> str:
    return fetch_flight_full(flight_number)[0]

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
