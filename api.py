import requests
import os
import re
import base64
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
CHAT_ERROR_CREDIT = "The assistant has run out of credit and cannot answer right now."
CHAT_ERROR_CONFIG = "The assistant is not configured correctly."
CHAT_ERROR_TOO_MANY_STEPS = (
    "The assistant took too many steps to answer that. Please rephrase and try again."
)


class ChatRequest(BaseModel):
    message: str
    gmail_token: str | None = None


def _chat_error(exc: Exception) -> str:
    """One of the fixed strings above. Never the exception's own text.

    Credit exhaustion arrives as a 400 invalid_request_error rather than as a
    billing-specific class, so it is identified by substring and then answered
    with our own wording — the provider's message is read, never forwarded.
    """
    if isinstance(exc, anthropic.AuthenticationError):
        return CHAT_ERROR_CONFIG
    if isinstance(exc, anthropic.PermissionDeniedError):
        return CHAT_ERROR_CONFIG
    if isinstance(exc, anthropic.RateLimitError):
        return CHAT_ERROR_BUSY
    if isinstance(exc, anthropic.BadRequestError):
        if "credit balance" in str(exc).lower():
            return CHAT_ERROR_CREDIT
        return CHAT_ERROR_CONFIG
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
