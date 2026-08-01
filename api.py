import requests
import os
import re
import base64
import anthropic
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from datetime import datetime
from zoneinfo import ZoneInfo
from mcp_server import fetch_flight_full, extract_flight_number

load_dotenv()

AVIATIONSTACK_API_KEY = os.getenv("AVIATIONSTACK_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*", "https://flight-tracker-navy-eight.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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

def search_gmail_for_flight(gmail_token: str):
    headers = {"Authorization": f"Bearer {gmail_token}"}
    list_resp = requests.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        headers=headers,
        params={"q": "flight booking confirmation", "maxResults": 5},
    )
    messages = list_resp.json().get("messages", [])
    if not messages:
        return None
    for msg in messages:
        msg_data = requests.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg['id']}",
            headers=headers,
            params={"format": "full"},
        ).json()
        payload = msg_data.get("payload", {})
        body_text = ""
        for part in payload.get("parts", []) or [payload]:
            if part.get("mimeType", "").startswith("text/plain"):
                data = part.get("body", {}).get("data", "")
                if data:
                    body_text += base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="ignore")
        match = re.search(r'\b([A-Z]{2}\d{2,4})\b', body_text.upper())
        if match:
            return match.group(1)
    return None


def flight_to_dto(flight: dict) -> dict:
    dep = flight.get("departure") or {}
    arr = flight.get("arrival") or {}
    airline = flight.get("airline") or {}
    flt = flight.get("flight") or {}
    return {
        "airline": airline.get("name"),
        "flight_number": flt.get("iata"),
        "flight_date": flight.get("flight_date"),
        "status": flight.get("flight_status"),
        "departure": {
            "airport": dep.get("airport"),
            "iata": dep.get("iata"),
            "terminal": dep.get("terminal"),
            "gate": dep.get("gate"),
            "scheduled": format_time(dep.get("scheduled"), dep.get("timezone")),
            "actual": format_time(dep.get("actual"), dep.get("timezone")),
            "delay": dep.get("delay"),
            "scheduled_iso": dep.get("scheduled"),
            "estimated_iso": dep.get("estimated"),
            "actual_iso": dep.get("actual"),
            "timezone": dep.get("timezone"),
        },
        "arrival": {
            "airport": arr.get("airport"),
            "iata": arr.get("iata"),
            "terminal": arr.get("terminal"),
            "gate": arr.get("gate"),
            "scheduled": format_time(arr.get("scheduled"), arr.get("timezone")),
            "actual": format_time(arr.get("actual"), arr.get("timezone")),
            "delay": arr.get("delay"),
            "baggage": arr.get("baggage"),
            "scheduled_iso": arr.get("scheduled"),
            "estimated_iso": arr.get("estimated"),
            "actual_iso": arr.get("actual"),
            "timezone": arr.get("timezone"),
        },
    }


@app.get("/flight/{flight_number}")
def get_flight(flight_number: str):
    url = "http://api.aviationstack.com/v1/flights"
    params = {
        "access_key": AVIATIONSTACK_API_KEY,
        "flight_iata": flight_number.upper(),
    }
    response = requests.get(url, params=params)
    print('AVIATIONSTACK STATUS:', response.status_code)
    print('AVIATIONSTACK RESPONSE:', response.text[:500])
    print('KEY USED:', AVIATIONSTACK_API_KEY[:8] if AVIATIONSTACK_API_KEY else 'NONE')
    data = response.json()

    if "data" not in data or len(data["data"]) == 0:
        return {"error": f"No flight found for {flight_number.upper()}"}

    flight = data["data"][0]
    return flight_to_dto(flight)


TOOLS = [
    {
        "name": "check_my_flight",
        "description": (
            "Smart flight status checker. "
            "If a flight number is given (e.g. AI2630), check it directly. "
            "If the question is vague (e.g. 'what's my flight status?'), "
            "scan Gmail for recent booking confirmations and check that flight."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The user's question or flight number"}
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_flight_status",
        "description": "Get the current status of a flight by its IATA flight number e.g. AI2630, 6E5031",
        "input_schema": {
            "type": "object",
            "properties": {
                "flight_number": {"type": "string", "description": "IATA flight number e.g. AI2630"}
            },
            "required": ["flight_number"],
        },
    },
    {
        "name": "find_flight_from_gmail",
        "description": "Search the user's Gmail for a flight booking and return the flight number. Use this only when the user asks about their own flight without giving a flight number.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
]


def run_tool(name: str, inputs: dict, gmail_token: str = None) -> tuple[str, dict | None]:
    if name == "check_my_flight":
        flight_number = extract_flight_number(inputs["query"])
        if flight_number:
            return fetch_flight_full(flight_number)
        if not gmail_token:
            return ("No flight number provided and you're not signed in with Google. Please sign in or provide a flight number directly.", None)
        found = search_gmail_for_flight(gmail_token)
        return fetch_flight_full(found) if found else ("No flight booking found in your Gmail.", None)
    if name == "get_flight_status":
        return fetch_flight_full(inputs["flight_number"])
    if name == "find_flight_from_gmail":
        if not gmail_token:
            return ("You need to sign in with Google first so I can access your Gmail.", None)
        found = search_gmail_for_flight(gmail_token)
        return fetch_flight_full(found) if found else ("No flight booking found in your Gmail.", None)
    return (f"Unknown tool: {name}", None)


class ChatRequest(BaseModel):
    message: str
    gmail_token: str | None = None


@app.post("/chat")
def chat(req: ChatRequest):
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    messages = [{"role": "user", "content": req.message}]

    system = (
        "You are a terminal-based flight assistant. "
        "Format all responses as plain terminal output — no emojis, no markdown, no bold, no headers, no tables. "
        "Each piece of information must be on its own line in plain text. "
        "Use lowercase labels followed by a colon, like:\n"
        "EK648 — Emirates\n"
        "status: active\n"
        "departure: Dubai (DXB) terminal 3, gate C12\n"
        "scheduled departure: 4:10 PM GMT+4\n"
        "arrival: Colombo (CMB) terminal main\n"
        "scheduled arrival: 10:10 PM GMT+5:30\n"
        "Always reproduce the timezone label exactly as the flight tool returns it for each time. "
        "Never substitute, convert, or invent a timezone label.\n"
        "Keep responses concise. Output must be suitable for a monospace terminal display."
    )

    captured_flight = None

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason == "end_turn":
            text = next((b.text for b in response.content if b.type == "text"), "")
            return {"response": text, "flight": captured_flight}

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result_text, flight_data = run_tool(block.name, block.input, req.gmail_token)
                    if flight_data is not None:
                        captured_flight = flight_to_dto(flight_data)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result_text,
                    })
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
        else:
            break

    return {"response": "No response generated", "flight": captured_flight}