import requests
import os
import re
from dotenv import load_dotenv
from datetime import datetime
from zoneinfo import ZoneInfo
from mcp.server.fastmcp import FastMCP

load_dotenv()

AVIATIONSTACK_KEY = os.getenv("AVIATIONSTACK_API_KEY")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY")

mcp = FastMCP("Flight Tracker")

# ──────────────────────────────────────────────
# FORMAT TIME
# ──────────────────────────────────────────────
def format_time(time_str, tz_name=None):
    if not time_str:
        return "N/A"
    try:
        dt = datetime.fromisoformat(time_str).replace(tzinfo=None)
    except (ValueError, TypeError):
        return "N/A"

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
# FETCH FLIGHT STATUS FROM AVIATIONSTACK
# ──────────────────────────────────────────────
def fetch_flight_full(flight_number: str) -> tuple[str, dict | None]:
    url = "http://api.aviationstack.com/v1/flights"
    params = {
        "access_key": AVIATIONSTACK_KEY,
        "flight_iata": flight_number.upper(),
    }
    response = requests.get(url, params=params)
    print('AVIATIONSTACK STATUS:', response.status_code)
    print('AVIATIONSTACK RESPONSE:', response.text[:500])
    print('KEY USED:', AVIATIONSTACK_KEY[:8] if AVIATIONSTACK_KEY else 'NONE')
    data = response.json()

    if "data" not in data or len(data["data"]) == 0:
        return (f"No flight found for {flight_number.upper()}. Make sure it is operating today.", None)

    flight = data["data"][0]
    dep = flight["departure"]
    arr = flight["arrival"]
    status = (flight.get("flight_status") or "Unknown").upper()
    dep_delay = dep.get("delay")
    arr_delay = arr.get("delay")

    result = f"""
✈ {flight['airline']['name']} | Flight {flight['flight']['iata']} | {flight.get('flight_date')}

STATUS: {status}

DEPARTURE
Airport  : {dep['airport']} ({dep['iata']})
Terminal : {dep.get('terminal') or 'N/A'} | Gate: {dep.get('gate') or 'N/A'}
Scheduled: {format_time(dep.get('scheduled'), dep.get('timezone'))}
Actual   : {format_time(dep.get('actual'), dep.get('timezone'))}
{f"⚠ Delay: {dep_delay} minutes" if dep_delay else ""}

ARRIVAL
Airport  : {arr['airport']} ({arr['iata']})
Terminal : {arr.get('terminal') or 'N/A'}
Scheduled: {format_time(arr.get('scheduled'), arr.get('timezone'))}
Actual   : {format_time(arr.get('actual'), arr.get('timezone'))}
{f"⚠ Delay: {arr_delay} minutes" if arr_delay else ""}
"""
    return (result.strip(), flight)


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