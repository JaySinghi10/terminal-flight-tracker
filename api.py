import requests
import os
import re
import base64
import logging
from datetime import datetime, timedelta, timezone
import anthropic
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from mcp_server import (
    fetch_flight_full,
    extract_flight_number,
    fetch_route,
    quota_status,
    _validate_route_date,
)

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

# Cloud Run captures stdout and stderr, so a module logger needs no handler and
# no configuration to reach the service logs. This is the first logging in the
# file: the reason a request failed used to exist only in the string sent back
# to the client, which is exactly the place a billing detail must not be.
logger = logging.getLogger("flight-tracker")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*", "https://flight-tracker-navy-eight.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.get("/flight/{flight_number}")
def get_flight(flight_number: str, date: str | None = None):
    # The same validator the route search uses, so the two cannot drift on what
    # a date means or how far it may reach. Every rejection happens here, before
    # any upstream call, so a malformed date costs nothing.
    day, date_error = _validate_route_date(date)
    if date_error is not None:
        return {"error": date_error}
    _text, dto = fetch_flight_full(flight_number, day)
    if dto is None:
        suffix = f" on {day}" if day else ""
        return {"error": f"No flight found for {flight_number.strip().upper()}{suffix}"}
    return dto


@app.get("/route/{origin}/{destination}")
def get_route(origin: str, destination: str, hours: int = 12, date: str | None = None):
    return fetch_route(origin, destination, hours, date)


# Its own endpoint, deliberately, rather than a key on the route and flight
# envelopes. Those answer "what is this search", and a cached one involves no
# provider call at all — a units figure sitting in that payload would read as
# measured now when it could be hours old. Here the age travels with the number.
# Costs nothing: it reports what earlier calls already told us.
@app.get("/quota")
def get_quota():
    return quota_status()


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


# HUNK 5. The tool set is three tools deep and the longest honest path is two
# rounds: find the number in Gmail, then look that number up, then answer. Four
# leaves room for one wrong turn and still terminates. Each round is a full
# model call, so an uncapped loop is a bill and a hung request, not just a bug.
CHAT_MAX_TOOL_ROUNDS = 4

# HUNK 4. What the app is allowed to show. Fixed strings, never the provider's
# own message: an upstream error can quote a key, an account identifier or an
# internal endpoint, and none of that may reach a client.
CHAT_ERROR_GENERIC = "The assistant is unavailable right now. Please try again."
CHAT_ERROR_BUSY = "The assistant is busy right now. Please try again in a moment."
# Deliberately WORD FOR WORD the generic string. Credit exhaustion is a billing
# fact about the operator's account, and a user who reads it can do nothing with
# it except learn something that is none of their business. The branch survives
# so the LOG can still say which failure it was — see _chat_error.
CHAT_ERROR_CREDIT = "The assistant is unavailable right now. Please try again."
CHAT_ERROR_CONFIG = "The assistant is not configured correctly."
CHAT_ERROR_TOO_MANY_STEPS = (
    "The assistant took too many steps to answer that. Please rephrase and try again."
)


class ChatRequest(BaseModel):
    message: str
    gmail_token: str | None = None


class ParseRequest(BaseModel):
    message: str


# ──────────────────────────────────────────────
# STRUCTURED EXTRACTION
# ──────────────────────────────────────────────
#
# A sentence in, fields out. Never prose — that is what /chat is for, and the
# two must not share an endpoint: /chat's whole system prompt is about SHAPING
# TERMINAL TEXT, it carries three flight tools, and it returns a string plus an
# optional flight card. An extractor wants none of that and wants a schema
# instead, so one endpoint serving both would mean one system prompt serving two
# incompatible goals.
#
# PLACE NAMES, NEVER CODES, and this is the load-bearing decision in the whole
# feature. The model reads "san fransisco" and returns "San Francisco"; the
# DEVICE turns that into SFO against the bundled dataset. So the model cannot
# invent an airport, cannot reach one that is not in the app's own data, and
# cannot route around the on-device rejection of codes that do not exist. It
# segments a sentence. It does not choose a destination.
#
# ONE TURN, NO TOOL LOOP. There is nothing to look up: the airports live on the
# device, the date window is checked here and again there, and the vocabularies
# are closed and enforced by the schema below. A loop would add rounds and
# failure modes to a task with no external dependency.
PARSE_MODEL = "claude-haiku-4-5-20251001"
PARSE_MAX_TOKENS = 256

# Forced tool use rather than "reply with JSON". The schema is the contract: the
# enums make an out-of-vocabulary band or sort a malformed call rather than a
# plausible-looking string this file would then have to police.
PARSE_TOOL = {
    "name": "flight_search",
    "description": "Record the flight search described by the user's sentence.",
    "input_schema": {
        "type": "object",
        "properties": {
            "origin": {
                "type": "string",
                "description": (
                    "The departure CITY OR AIRPORT NAME, corrected for spelling, "
                    "in English. Never an IATA code. Omit if the sentence does not "
                    "say where the flight leaves from."
                ),
            },
            "destination": {
                "type": "string",
                "description": (
                    "The arrival CITY OR AIRPORT NAME, corrected for spelling, in "
                    "English. Never an IATA code. Omit if not stated."
                ),
            },
            "date": {
                "type": "string",
                "description": (
                    "The single calendar date asked for, as YYYY-MM-DD, resolved "
                    "against today's date given in the system prompt. Omit if no "
                    "date is mentioned, or if the sentence names a RANGE."
                ),
            },
            "date_kind": {
                "type": "string",
                "enum": ["single", "range"],
                "description": (
                    "'range' when the sentence names more than one day - 'this "
                    "weekend', 'next week', 'early October'. Set this INSTEAD of "
                    "date for those. Never collapse a range to one day."
                ),
            },
            "band": {
                "type": "string",
                "enum": ["morning", "afternoon", "evening", "overnight"],
                "description": "Departure time of day, if the sentence names one.",
            },
            "sort": {
                "type": "string",
                "enum": ["fastest", "earliest"],
                "description": "Requested ordering, if the sentence asks for one.",
            },
            "confidence": {
                "type": "number",
                "description": (
                    "0 to 1. How confident you are that this sentence is a flight "
                    "search and that you have read it correctly. Be strict: a "
                    "sentence that might be a question about an existing booking "
                    "is not a search."
                ),
            },
        },
        "required": ["confidence"],
    },
}

PARSE_ERROR_GENERIC = "Could not read that as a flight search. Please try again."


def _parse_clean(raw: dict, today) -> dict:
    """The model's fields, re-checked here before they leave the process.

    Nothing is trusted: the enums are re-tested, the date is re-parsed and
    re-bounded, and confidence is clamped. The device checks all of it AGAIN,
    because two cheap checks in different places is how a hallucinated field
    fails to become a four-unit search of the wrong day.
    """
    def s(key):
        v = raw.get(key)
        v = str(v).strip() if isinstance(v, str) else ""
        return v or None

    band = s("band")
    if band not in ("morning", "afternoon", "evening", "overnight"):
        band = None
    sort = s("sort")
    if sort not in ("fastest", "earliest"):
        sort = None
    kind = s("date_kind")
    if kind not in ("single", "range"):
        kind = None

    date = s("date")
    if date is not None:
        # The route validator, so this cannot drift from what /route will accept.
        day, err = _validate_route_date(date)
        date = None if err is not None else day
    # A range never carries a date, whatever the model put in the field.
    if kind == "range":
        date = None

    try:
        conf = float(raw.get("confidence", 0))
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))

    return {
        "origin": s("origin"),
        "destination": s("destination"),
        "date": date,
        "date_kind": kind,
        "band": band,
        "sort": sort,
        "confidence": conf,
        "error": None,
    }


def _parse_empty(error=None) -> dict:
    return {
        "origin": None, "destination": None, "date": None, "date_kind": None,
        "band": None, "sort": None, "confidence": 0.0, "error": error,
    }


@app.post("/parse")
def parse(req: ParseRequest):
    text = str(req.message or "").strip()
    if not text:
        return _parse_empty(PARSE_ERROR_GENERIC)

    today = datetime.now(timezone.utc).date()
    system = (
        "You extract the fields of a flight search from one sentence. "
        f"Today is {today.isoformat()}. "
        "Call the flight_search tool exactly once and say nothing else.\n"
        "Return place NAMES, never airport codes: the caller resolves names "
        "itself and will reject a code.\n"
        "Correct obvious misspellings of place names.\n"
        "Omit any field the sentence does not state. Do not guess a departure "
        "city that was not given.\n"
        "If the sentence names more than one day, set date_kind to 'range' and "
        "omit date. Never pick one day out of a range."
    )

    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = client.messages.create(
            model=PARSE_MODEL,
            max_tokens=PARSE_MAX_TOKENS,
            temperature=0,
            system=system,
            tools=[PARSE_TOOL],
            tool_choice={"type": "tool", "name": "flight_search"},
            messages=[{"role": "user", "content": text}],
        )
    except Exception as exc:
        # The same wording policy as /chat: a fixed string out, the real reason
        # into the log, and never the provider's own text.
        logger.warning("parse call failed: %s", type(exc).__name__)
        return _parse_empty(_chat_error(exc))

    block = next((b for b in response.content if b.type == "tool_use"), None)
    if block is None or not isinstance(block.input, dict):
        logger.warning("parse call returned no tool_use block")
        return _parse_empty(PARSE_ERROR_GENERIC)

    return _parse_clean(block.input, today)


def _chat_error(exc: Exception) -> str:
    """One of the fixed strings above. Never the exception's own text.

    Credit exhaustion arrives as a 400 invalid_request_error rather than as a
    billing-specific class, so it is identified by substring and then answered
    with our own wording — the provider's message is read, never forwarded.
    """
    if isinstance(exc, anthropic.AuthenticationError):
        logger.warning("assistant call failed: authentication rejected")
        return CHAT_ERROR_CONFIG
    if isinstance(exc, anthropic.PermissionDeniedError):
        logger.warning("assistant call failed: permission denied")
        return CHAT_ERROR_CONFIG
    if isinstance(exc, anthropic.RateLimitError):
        logger.warning("assistant call failed: rate limited")
        return CHAT_ERROR_BUSY
    if isinstance(exc, anthropic.BadRequestError):
        if "credit balance" in str(exc).lower():
            # The one that changed. The user is told nothing useful about the
            # billing state of an account that is not theirs; the operator
            # reading the logs is told exactly which wall was hit.
            logger.warning("assistant call failed: credit balance exhausted")
            return CHAT_ERROR_CREDIT
        logger.warning("assistant call failed: bad request (%s)", type(exc).__name__)
        return CHAT_ERROR_CONFIG
    logger.warning("assistant call failed: %s", type(exc).__name__)
    return CHAT_ERROR_GENERIC


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
        "If a time is followed by the qualifier (predicted), reproduce that qualifier exactly as written and never drop it.\n"
        "Keep responses concise. Output must be suitable for a monospace terminal display."
    )

    captured_flight = None

    for _round in range(CHAT_MAX_TOOL_ROUNDS):
        try:
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                system=system,
                tools=TOOLS,
                messages=messages,
            )
        except Exception as exc:
            # The app renders `error`; without this the exception escaped as a
            # bare 500 whose body has no `error` key at all, which is why every
            # failure looked like "Something went wrong".
            return {"error": _chat_error(exc), "response": None, "flight": captured_flight}

        if response.stop_reason == "end_turn":
            text = next((b.text for b in response.content if b.type == "text"), "")
            return {"response": text, "flight": captured_flight}

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result_text, flight_data = run_tool(block.name, block.input, req.gmail_token)
                    if flight_data is not None:
                        captured_flight = flight_data
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result_text,
                    })
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
        else:
            # Any other stop reason — max_tokens, refusal, something new. If the
            # model said anything at all, that is better than a canned line.
            text = next((b.text for b in response.content if b.type == "text"), "")
            if text:
                return {"response": text, "flight": captured_flight}
            return {"error": CHAT_ERROR_GENERIC, "response": None, "flight": captured_flight}

    # The loop ran out of rounds. Anything already found still goes back, so a
    # flight the tools did retrieve is not thrown away with the conversation.
    return {
        "error": CHAT_ERROR_TOO_MANY_STEPS,
        "response": None,
        "flight": captured_flight,
    }
