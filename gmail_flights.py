"""Upcoming flights, read out of the user's own Gmail.

── WHAT THIS REPLACES, AND WHY EVERY PART OF IT WAS WRONG ─────────────────────

The old search_gmail_for_flight searched the whole mailbox for one phrase,
took the top five hits, and regexed the first two-letters-plus-digits out of
whatever plain-text part it found. No date bound, so a 2019 booking could win.
A regex that matched PNR fragments and "ID 1234" as readily as a flight number.
Plain text only, so an HTML-only airline email yielded nothing. One level of
multipart, so anything nested was missed. And one flight number back with no
date, so the lookup never knew which day it was looking up.

── THE SHAPE OF THIS ONE ───────────────────────────────────────────────────────

  1. SEARCH BY WHEN THE EMAIL ARRIVED, never by when the flight departs. An
     airline confirmation lands months before the flight, and Gmail cannot
     filter on a date that is only written inside the body. That is the whole
     reason parsing exists here rather than a better query.
  2. FETCH THE RAW RFC 822 MESSAGE and let the standard library walk it: every
     level of multipart, every transfer encoding, every charset. HTML is
     stripped to text rather than skipped.
  3. GATE, THEN EXTRACT. A cheap presence check decides whether an email is
     worth a model call; the MODEL decides what is in it. The gate must never
     be the extractor -- that is the mistake the old regex made.
  4. RE-CHECK EVERYTHING THE MODEL SAID. Flight numbers against a regex that
     accepts digit-leading codes, dates re-parsed, PNRs re-shaped, confidence
     clamped, past dates dropped, duplicates across emails collapsed.

── WHAT NEVER LEAVES THIS PROCESS ──────────────────────────────────────────────

THESE ARE PEOPLE'S BOOKING CONFIRMATIONS. Bodies go to the model and nowhere
else: never to the log, never to storage, never back to the client. The log
carries counts, outcome codes, Gmail message ids, the classified kind of an
email, the instant it arrived, and for each merge decision the flight number
and date it concerned -- never a subject, a sender or a body. The
truncation to BODY_MAX_CHARS is
applied here, on every body, before it is handed anywhere -- it is not a limit
somebody upstream is trusted to have applied.

The access token is used for the two Gmail calls and is not logged either.
"""
import base64
import email
import os
import email.policy
import email.utils
import html
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import requests

import llm

logger = logging.getLogger("gmail-flights")

GMAIL_MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
HTTP_TIMEOUT = 15

# ── THE WINDOW AND THE CAPS ─────────────────────────────────────────────────
#
# 365 DAYS OF RECEIVED MAIL. A long-haul booked in December for the following
# August is the case a six-month window loses, and the window is a filter that
# costs nothing; the caps below are what cost something.
WINDOW_DAYS = 365
# Listed, fetched, and sent to the model. Gmail bills five quota units per list
# and five per fetch, so a request at these caps is 5 + 25 * 5 = 130 units
# against a per-user allowance of 250 per second -- quota is not the constraint,
# latency is, which is why the fetches run in a pool.
#
# FETCH_MAX AND EXTRACT_MAX ARE EQUAL, AND THAT IS THE POINT. They were 25 and
# 10, so fifteen emails could be fetched, decoded, and pass the spend gate --
# every one of them looking like a booking -- and then be thrown away before
# the model ever saw them, silently, on a rule that knew nothing about them
# but their position in a list. A fetched email that passes the gate is an
# email somebody may have a ticket in; the cap must not be what loses it.
#
# THE GATE IS THE FILTER NOW, NOT THE SLICE. worth_a_model_call is what decides
# whether an email is worth paying for, and it reads the email; EXTRACT_MAX only
# stops a runaway. Raising it raises the worst-case model bill for one pull and
# changes the typical one hardly at all, because the gate already refuses most
# of what is fetched.
LIST_MAX = 40
FETCH_MAX = 25
EXTRACT_MAX = 25
FETCH_POOL = 5
MODEL_POOL = 4
# ENFORCED HERE, on every body, before the model sees it. See the header.
BODY_MAX_CHARS = 12000

# ── THE ITINERARY THAT IS NOT IN THE EMAIL ──────────────────────────────────
#
# AIRLINES SEND THE TICKET AS AN ATTACHMENT and leave the body nearly empty.
# Those bookings produced nothing at all until now, and TWO separate things
# stopped them: the decoder threw attachments away, and the spend gate below
# reads the body, so an email with an empty body failed it and never reached
# the model even in principle.
#
# THE BYTES COST NOTHING EXTRA TO OBTAIN. fetch_message asks Gmail for the raw
# message, which returns the whole thing including attachments in one call, so
# these were already being downloaded and discarded. No second request, no extra
# Gmail quota, no new scope.
#
# ONE MEGABYTE, AND IT IS A CEILING ON MEMORY RATHER THAN ON PAGES. A booking
# confirmation is tens of kilobytes; anything past a megabyte is a brochure, a
# boarding pass with a map, or not an itinerary at all. The check happens in the
# decoder so an oversized part is dropped before it is held, and every message
# in a pull is decoded inside one Cloud Run request that has a timeout.
PDF_MAX_BYTES = 1024 * 1024

# FOUR PAGES. Gemini bills a document page as 258 tokens whatever is on it, and
# an itinerary is one or two pages -- the fourth exists for a return leg printed
# separately. A twelve-page attachment is a fare brochure and paying to read it
# is paying for the wrong thing. Enforced at the call rather than at the decode,
# because it is a question about spending and not about memory.
PDF_MAX_PAGES = 4

PDF_MEDIA_TYPE = "application/pdf"
# A leg the model was not sure of is a leg not shown. It is re-validated after
# this anyway, but a low confidence usually means an inferred field.
MIN_CONFIDENCE = 0.6
# AIRLINES DO NOT SELL BEYOND A YEAR. A leg further out than this is a wrong
# year, whatever produced it, and is dropped rather than shown.
MAX_DAYS_AHEAD = 365
# ── THE YEAR ROLLOVER ─────────────────────────────────────────────────────────
#
# AN EMAIL RECEIVED ON 28 DECEMBER FOR A FLIGHT ON 15 JANUARY IS NEXT YEAR. The
# email prints "15 Jan", the model is told the received date, and mostly gets
# it right; this is the backstop for when it does not. A flight dated BEFORE
# the email that booked it is impossible, so the year is bumped once.
#
# ONLY WHEN THE GAP IS LARGE. A wrong-year resolution puts the flight about
# eleven months before the email; a post-flight email -- "thanks for flying
# with us on the 3rd", received on the 5th -- puts it a few days before. The
# second must NOT be bumped, or a flight that has already happened would come
# back as next year's. Sixty days separates the two cases by a wide margin.
ROLLOVER_MIN_GAP_DAYS = 60
EXTRACT_MAX_TOKENS = 1024

# Subject-shaped terms an airline or agent puts on a confirmation. Broad by
# design: the gate and the model do the narrowing, and a term missing here is
# a booking never seen.
SUBJECT_TERMS = [
    "itinerary", "e-ticket", "eticket", "booking confirmation",
    "flight confirmation", "booking reference", "boarding pass",
    "your trip", "your flight", "travel confirmation", "ticket confirmation",
    "PNR", "reservation confirmed", "booking confirmed",
]

# ── A FLIGHT NUMBER, INCLUDING THE ONES THAT START WITH A DIGIT ─────────────
#
# THE FIFTH TIME THIS CODEBASE HAS MET THE LEADING-DIGIT ASSUMPTION. [A-Z]{2}
# rejects 6E, 9W, 5J and U2 -- IndiGo is India's largest carrier -- so the
# code is two characters with AT LEAST ONE LETTER, then one to four digits.
FLIGHT_RE = re.compile(r"^(?:[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}$")
# The presence gate's looser cousin: the same shape, inside running text,
# with an optional space between code and number as airlines print it.
FLIGHT_IN_TEXT_RE = re.compile(r"\b(?:[A-Z][A-Z0-9]|[0-9][A-Z]) ?\d{1,4}\b")
# A CARRIER CODE ON ITS OWN: FLIGHT_RE's front half with no number behind it.
# It is what an airline NAME must never be, and the merge below reads it to stop
# one replacing one.
CARRIER_CODE_RE = re.compile(r"^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$")
PNR_RE = re.compile(r"^[A-Z0-9]{5,8}$")
IATA_RE = re.compile(r"^[A-Z]{3}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Words that, alongside a flight-number-shaped token, make an email worth a
# model call. Matched case-insensitively.
BOOKING_WORDS = (
    "itinerary", "booking", "e-ticket", "eticket", "pnr", "boarding",
    "confirmation", "reservation", "flight",
)

# Outcome codes. The endpoint maps these to fixed user strings; nothing here
# produces a sentence for a user.
OK = None
EXPIRED = "gmail_expired"
FORBIDDEN = "gmail_forbidden"
BUSY = "gmail_busy"
ERROR = "gmail_error"


# ══════════════════════════════════════════════════════════════════════════
# 1. SEARCH
# ══════════════════════════════════════════════════════════════════════════

def search_query(today) -> str:
    """The Gmail query: a window of RECEIVED mail, minus the noise categories.

    after: is a received-date bound and is the only date Gmail can filter on.
    Promotions and social are excluded because that is where fare sales and
    "your friend is travelling" live, and a real confirmation is filed under
    updates or primary.
    """
    since = (today - timedelta(days=WINDOW_DAYS)).strftime("%Y/%m/%d")
    quoted = " OR ".join(('"%s"' % t) if (" " in t or "-" in t) else t for t in SUBJECT_TERMS)
    return "after:%s -category:promotions -category:social (subject:(%s) OR (%s))" % (
        since, quoted, quoted)


def _classify_http(resp) -> str:
    """One of the outcome codes for a non-2xx Gmail response."""
    if resp.status_code == 401:
        return EXPIRED
    if resp.status_code == 403:
        # Insufficient scope reads as 403 too, and so does a daily quota; both
        # are "the operator or the grant has to change", not "try again".
        return FORBIDDEN
    if resp.status_code == 429:
        return BUSY
    return ERROR


def list_messages(token: str, today) -> tuple[list[str], str | None]:
    """Message ids in the window, newest first, or an outcome code.

    THE FIRST CALL IS WHERE AN EXPIRED TOKEN SHOWS UP, before a single body is
    fetched or a single model call is made. An expired sign-in costs nothing.
    """
    try:
        resp = requests.get(
            GMAIL_MESSAGES,
            headers={"Authorization": "Bearer " + token},
            params={"q": search_query(today), "maxResults": LIST_MAX},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        return [], ERROR
    if resp.status_code != 200:
        return [], _classify_http(resp)
    try:
        rows = resp.json().get("messages") or []
    except ValueError:
        return [], ERROR
    return [r["id"] for r in rows if isinstance(r, dict) and r.get("id")], OK


# ══════════════════════════════════════════════════════════════════════════
# 2. FETCH AND DECODE
# ══════════════════════════════════════════════════════════════════════════

class _HtmlToText(HTMLParser):
    """HTML to readable text, keeping the breaks an itinerary depends on.

    Airline emails are tables. A stripper that joins every cell with nothing
    produces "BOM10:35BLR12:20", which no reader -- model or human -- can take
    apart. Block elements become newlines and cells become separators, so the
    table survives as lines.
    """
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
             "table", "section", "article", "header", "footer", "ul", "ol"}
    SKIP = {"script", "style", "head", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n")
        elif tag in ("td", "th"):
            self.out.append("  ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)

    def text(self) -> str:
        raw = "".join(self.out)
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r" *\n *", "\n", raw)
        return re.sub(r"\n{3,}", "\n\n", raw).strip()


# ── SCHEMA.ORG FlightReservation, WHEN THE AIRLINE EMBEDS IT ─────────────────
#
# United, Delta, American, Air France, KLM, Lufthansa, Singapore and Booking.com
# put a <script type="application/ld+json"> block in the email carrying the
# reservation as structured data: ISO-8601 times, IATA codes, the carrier and
# the booking reference. DETERMINISTIC AND FREE, so it is read first and the
# model is only asked when it is absent.
_LDJSON_RE = re.compile(
    r"<script[^>]*type\s*=\s*[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
    re.I | re.S)


def _jsonld_blocks(markup: str) -> list:
    out = []
    for block in _LDJSON_RE.findall(markup or ""):
        try:
            out.append(json.loads(html.unescape(block).strip()))
        except ValueError:
            continue
    return out


def _walk(node, found):
    """Every dict with @type FlightReservation, at any depth, in any list."""
    if isinstance(node, dict):
        t = node.get("@type")
        types = t if isinstance(t, list) else [t]
        if "FlightReservation" in [str(x) for x in types if x]:
            found.append(node)
        for v in node.values():
            _walk(v, found)
    elif isinstance(node, list):
        for v in node:
            _walk(v, found)


def _first(v):
    return v[0] if isinstance(v, list) and v else v


def _code(d, *keys):
    """An IATA code out of a nested object, whichever of the keys carries it."""
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def jsonld_legs(markup: str) -> list[dict]:
    """Raw legs in the same shape the model returns, from the JSON-LD blocks.

    schema.org's Flight carries flightNumber as the NUMBER ALONE ("100") beside
    airline.iataCode ("AA"); some senders put "AA100" in flightNumber directly.
    Both are read. A cancelled reservationStatus USED TO BE SKIPPED; it is
    emitted with leg_status cancelled now, so a structured cancellation reaches
    the merge by the same path a modelled one does and can mark the leg an
    earlier email confirmed. The operating carrier, where a sender names one
    under `provider`, is carried as operated_by; the schema has no field for
    the operating flight NUMBER.
    """
    legs = []
    for doc in _jsonld_blocks(markup):
        found = []
        _walk(doc, found)
        for res in found:
            status = str(res.get("reservationStatus") or "")
            cancelled = "Cancelled" in status or "Canceled" in status
            pnr = res.get("reservationNumber") or res.get("reservationId")
            flights = res.get("reservationFor")
            flights = flights if isinstance(flights, list) else [flights]
            for fl in flights:
                if not isinstance(fl, dict):
                    continue
                airline = fl.get("airline") if isinstance(fl.get("airline"), dict) else {}
                num = str(fl.get("flightNumber") or "").replace(" ", "").upper()
                code = (_code(airline, "iataCode") or "").upper()
                # NUMBER ONLY ("100") IS JOINED TO THE CODE; "AA100" IS KEPT. The
                # test is "starts with a carrier code", which needs a LETTER in
                # its two characters -- "10" is two digits, not a code.
                if num and code and not re.match(r"^(?:[A-Z][A-Z0-9]|[0-9][A-Z])", num):
                    num = code + num
                dep = fl.get("departureAirport") if isinstance(fl.get("departureAirport"), dict) else {}
                arr = fl.get("arrivalAirport") if isinstance(fl.get("arrivalAirport"), dict) else {}
                dep_time = str(fl.get("departureTime") or "")
                arr_time = str(fl.get("arrivalTime") or "")
                provider = fl.get("provider") if isinstance(fl.get("provider"), dict) else {}
                legs.append({
                    "flight_number": num,
                    # THE LOCAL DATE AS PRINTED, not converted: the string carries
                    # its own offset and its first ten characters are the day.
                    "date": dep_time[:10],
                    "departure_time": dep_time[11:16] if len(dep_time) >= 16 else None,
                    # THE ARRIVAL, ON THE SAME TERMS AS THE DEPARTURE: the local
                    # clock and the local day as the sender wrote them, read off
                    # one string and neither converted. schema.org's arrivalTime
                    # carries its own offset exactly as departureTime does, and
                    # its first ten characters are the day the aircraft lands --
                    # which is the day AFTER the departure on an overnight leg,
                    # and is why the date is read rather than assumed to be the
                    # departure's.
                    "arrival_time": arr_time[11:16] if len(arr_time) >= 16 else None,
                    "arrival_date": arr_time[:10] if len(arr_time) >= 10 else None,
                    "origin": _code(dep, "iataCode") or dep.get("name"),
                    "destination": _code(arr, "iataCode") or arr.get("name"),
                    "airline": airline.get("name") if isinstance(airline, dict) else None,
                    "pnr": pnr,
                    "operated_by": provider.get("name") if provider else None,
                    "operating_flight_number": None,
                    "confidence": 1.0,
                    # THE SENDER'S OWN WORD FOR IT. A cancelled reservation is a
                    # cancellation notice for its legs; anything else is a
                    # confirmation, which is what a structured itinerary is.
                    "leg_status": "cancelled" if cancelled else "scheduled",
                    "email_kind": "cancellation" if cancelled else "confirmation",
                })
    return legs


def html_to_text(markup: str) -> str:
    p = _HtmlToText()
    try:
        p.feed(markup)
        p.close()
    except Exception:  # noqa: BLE001 -- a malformed page is still text
        return html.unescape(re.sub(r"<[^>]+>", " ", markup))
    return p.text()


def decode_body(raw_b64url: str, internal_date=None) -> dict:
    """{subject, sender, received, received_at, body} from Gmail's raw message.

    internal_date IS GMAIL'S internalDate: epoch milliseconds, present on every
    message resource, stamped by Gmail on arrival rather than by the sender.
    It becomes received_at, a full-precision UTC instant. The Date HEADER still
    becomes `received`, the day string, exactly as before: the prompt and the
    year-rollover backstop both read that one and neither is changed here.

    THE STANDARD LIBRARY DOES THE WALK. msg.walk() visits every part at every
    depth, get_content() applies the transfer encoding and the declared
    charset, and the policy handles the header folding. None of that is worth
    writing again, and the old one-level loop is what happens when it is.

    PLAIN AND HTML ARE BOTH READ AND THE LONGER WINS. A multipart/alternative
    email's plain part is often a stub ("view this email in your browser") next
    to the real itinerary in HTML; occasionally the reverse. Length is a crude
    judge and a reliable one for this.

    Attachments are skipped. A PDF ticket is real, and out of scope here.
    """
    pad = "=" * (-len(raw_b64url) % 4)
    data = base64.urlsafe_b64decode(raw_b64url + pad)
    msg = email.message_from_bytes(data, policy=email.policy.default)

    plain, htmls, pdfs = [], [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        if ctype == PDF_MEDIA_TYPE:
            # KEPT WHETHER OR NOT IT CALLS ITSELF AN ATTACHMENT. Senders vary:
            # some mark the ticket inline so it previews in the client, some
            # attach it, and the disposition is not a reliable signal of which
            # part holds the itinerary. The media type is.
            try:
                blob = part.get_payload(decode=True)
            except Exception:  # noqa: BLE001 -- an undecodable part is skipped
                continue
            if isinstance(blob, bytes) and 0 < len(blob) <= PDF_MAX_BYTES:
                pdfs.append(blob)
            continue
        if part.get_content_disposition() == "attachment":
            continue
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            content = part.get_content()
        except Exception:  # noqa: BLE001 -- an undecodable part is skipped
            continue
        if not isinstance(content, str):
            continue
        (plain if ctype == "text/plain" else htmls).append(content)

    plain_text = "\n".join(plain).strip()
    raw_html = "\n".join(htmls)
    html_text = html_to_text(raw_html) if htmls else ""
    body = plain_text if len(plain_text) >= len(html_text) else html_text
    # STRUCTURED DATA FIRST. Read off the raw markup before it is stripped,
    # because the stripper drops <script> blocks, which is exactly where it is.
    structured = jsonld_legs(raw_html) if htmls else []

    received = None
    received_at = None
    try:
        dt = email.utils.parsedate_to_datetime(msg.get("date") or "")
        if dt is not None:
            received = dt.astimezone(timezone.utc).strftime("%Y-%m-%d")
            # THE HEADER'S INSTANT IS THE FALLBACK ONLY, for a message with no
            # internalDate -- the fixture inbox, which is files rather than
            # Gmail. A sender's clock is not Gmail's, so it never overrides one.
            received_at = dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    except (TypeError, ValueError):
        received = None
    try:
        if internal_date is not None:
            received_at = datetime.fromtimestamp(
                int(internal_date) / 1000, tz=timezone.utc).isoformat(timespec="milliseconds")
    except (TypeError, ValueError, OverflowError, OSError):
        pass

    return {
        "subject": str(msg.get("subject") or "").strip()[:200],
        "sender": str(msg.get("from") or "").strip()[:200],
        "received": received,
        # WHEN GMAIL RECEIVED IT, to the millisecond, in UTC. The day string
        # above is what the model and the rollover read; this is what an
        # ordering of emails about the same leg will read.
        "received_at": received_at,
        # THE ONE PLACE THE TRUNCATION HAPPENS, and every body passes through it.
        "body": body[:BODY_MAX_CHARS],
        # Legs the sender stated outright. Empty for most airlines still.
        "jsonld": structured,
        # THE TICKET ITSELF, where the airline sent one. Bytes, not text: the
        # model reads the pages. Never logged and never stored, exactly as the
        # body is not -- see the note at the head of this file.
        "pdfs": pdfs,
    }


def fetch_message(token: str, msg_id: str) -> dict | None:
    """One decoded message, or None on any failure. Never raises."""
    try:
        resp = requests.get(
            GMAIL_MESSAGES + "/" + msg_id,
            headers={"Authorization": "Bearer " + token},
            params={"format": "raw"},
            timeout=HTTP_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        body = resp.json()
        raw = body.get("raw")
        if not raw:
            return None
        # internalDate COMES WITH format=raw. The message resource carries it
        # whatever the format, and no field mask is set on the request, so it
        # is already in this response and costs no second call.
        m = decode_body(raw, body.get("internalDate"))
        # THE ID, FOR THE LOG. An opaque Gmail identifier, not content.
        m["id"] = msg_id
        return m
    except Exception:  # noqa: BLE001 -- one bad message must not sink the rest
        return None


# ══════════════════════════════════════════════════════════════════════════
# 3. GATE, THEN EXTRACT
# ══════════════════════════════════════════════════════════════════════════

def worth_a_model_call(m: dict) -> bool:
    """Does this email look like it could hold a flight? A filter on SPENDING.

    It decides whether to pay for a model call, and nothing else. It does not
    read a flight number out; it only checks that something shaped like one is
    present, next to a word that suggests a booking. Both the old regex's
    false positives ("ID 1234") and its false negatives (6E5071) are fine here,
    because the model is what answers and this only opens the door.
    """
    text = (m.get("subject") or "") + "\n" + (m.get("body") or "")
    lower = text.lower()
    # ── AN ATTACHED TICKET OPENS THE DOOR ON ITS OWN ────────────────────────
    #
    # THE FLIGHT NUMBER IS IN THE PDF, WHICH IS THE WHOLE PROBLEM. This gate
    # reads the subject and the body, and an airline that sends the itinerary as
    # an attachment leaves both nearly empty -- so the test below fails and the
    # email is never looked at, however plainly the ticket is a ticket.
    #
    # A BOOKING WORD IS STILL REQUIRED. Dropping both tests would send every
    # PDF-bearing email to the model, which is a bill rather than a feature; a
    # payslip and a bank statement are both PDFs. What is dropped is only the
    # flight-number test, because that is the one the attachment is hiding.
    if m.get("pdfs") and any(w in lower for w in BOOKING_WORDS):
        return True
    if not FLIGHT_IN_TEXT_RE.search(text.upper()):
        return False
    return any(w in lower for w in BOOKING_WORDS)


# ── WHAT AN EMAIL IS, BEFORE WHAT IS IN IT ───────────────────────────────────
#
# THE MODEL USED TO ANSWER ONE QUESTION: is this a booking, yes or no. A
# cancellation was a no, and so the one email that says a leg will NOT fly was
# the one email thrown away. It classifies now, and the legs a cancellation or
# a change names come back carrying their status, so a later step can order
# the emails about one leg and let the newest win.
EMAIL_KINDS = ("confirmation", "change", "cancellation", "other")
# The kinds that still count as a booking for everything downstream that reads
# is_booking. A cancellation is not a booking; its legs come back regardless.
BOOKING_KINDS = ("confirmation", "change")
LEG_STATUSES = ("scheduled", "cancelled")

EXTRACT_TOOL = {
    "name": "flight_bookings",
    "description": (
        "Classify this one email and record every flight leg it names, with "
        "each leg's status."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "email_kind": {
                "type": "string",
                "enum": list(EMAIL_KINDS),
                "description": (
                    "What this email IS. confirmation: an original booking, "
                    "itinerary, e-ticket or boarding pass for the recipient. "
                    "change: a reschedule or rebooking that restates one or "
                    "more legs. cancellation: an airline notice that one or "
                    "more legs will not operate. other: everything else -- "
                    "marketing, fare alerts, hotels, car hire, refunds, surveys, "
                    "reminders, and anything you cannot place with confidence."
                ),
            },
            "is_booking": {
                "type": "boolean",
                "description": (
                    "True for a confirmation or a change, false for every "
                    "other kind. Derived from email_kind; kept for readers "
                    "that still expect it."
                ),
            },
            "bookings": {
                "type": "array",
                "description": (
                    "One entry per flight leg the email names. Empty when "
                    "email_kind is other. For a cancellation or a change, the "
                    "legs the notice names -- the email need not restate the "
                    "whole itinerary."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "flight_number": {
                            "type": "string",
                            "description": (
                                "Airline code and number exactly as printed, "
                                "spaces removed: AI2630, 6E5071, BA178. Never "
                                "invent or complete one."
                            ),
                        },
                        "date": {
                            "type": "string",
                            "description": (
                                "Departure date as YYYY-MM-DD, local to the "
                                "departure airport. If the email prints no "
                                "year, use the email's received date given in "
                                "the message and take the next occurrence on or "
                                "after it."
                            ),
                        },
                        "origin": {
                            "type": "string",
                            "description": "Departure airport: the printed IATA code, else the printed city name.",
                        },
                        "destination": {
                            "type": "string",
                            "description": "Arrival airport: the printed IATA code, else the printed city name.",
                        },
                        "departure_time": {
                            "type": "string",
                            "description": "Departure time as HH:MM, 24-hour, if printed.",
                        },
                        "arrival_time": {
                            "type": "string",
                            "description": (
                                "Arrival time as HH:MM, 24-hour, ONLY if the "
                                "email prints one. Never work it out from a "
                                "duration, from the departure plus a flight "
                                "time, or from a schedule you know."
                            ),
                        },
                        "arrival_date": {
                            "type": "string",
                            "description": (
                                "Arrival date as YYYY-MM-DD, local to the "
                                "ARRIVAL airport, only if the email prints one. "
                                "An overnight leg lands on a different calendar "
                                "day from the one it left, and airlines print "
                                "that day beside the arrival time. Where the "
                                "email gives one date for the whole leg, that "
                                "is the departure date: omit this."
                            ),
                        },
                        "airline": {"type": "string", "description": "The MARKETING airline, whose code is on the flight number."},
                        "operated_by": {
                            "type": "string",
                            "description": (
                                "The OPERATING airline, only if the email prints "
                                "'operated by' or similar fine print. Omit otherwise."
                            ),
                        },
                        "operating_flight_number": {
                            "type": "string",
                            "description": (
                                "The operating carrier's own flight number, only if "
                                "the email prints it, e.g. 'BA1502 operated by American "
                                "Airlines as AA100' gives AA100. Never derive one."
                            ),
                        },
                        "pnr": {
                            "type": "string",
                            "description": (
                                "The booking reference, PNR, record locator or "
                                "confirmation code: 5 to 8 letters and digits. "
                                "NEVER the 13-digit e-ticket number."
                            ),
                        },
                        "confidence": {
                            "type": "number",
                            "description": (
                                "0 to 1. How sure you are that every field on "
                                "this leg is printed in the email rather than "
                                "inferred. Below 0.6 means you guessed something."
                            ),
                        },
                        "leg_status": {
                            "type": "string",
                            "enum": list(LEG_STATUSES),
                            "description": (
                                "cancelled for a leg this email says will not "
                                "operate; scheduled otherwise. Every leg named "
                                "in a cancellation notice is cancelled. Defaults "
                                "to scheduled."
                            ),
                        },
                    },
                    "required": ["flight_number", "date", "confidence"],
                },
            },
        },
        "required": ["email_kind", "is_booking", "bookings"],
    },
}


def _system_prompt(today) -> str:
    return (
        "You classify ONE email and extract the flight legs it names. "
        f"Today is {today.isoformat()}. "
        "Call the flight_bookings tool exactly once and say nothing else.\n"
        "FIRST SAY WHAT THE EMAIL IS, in email_kind. confirmation: an original "
        "booking, itinerary, e-ticket or boarding pass for the recipient. "
        "change: a reschedule or rebooking that restates one or more legs. "
        "cancellation: an airline notice that one or more legs will not "
        "operate. other: everything else -- marketing, fare alerts, hotels, "
        "car hire, refunds, surveys, check-in nags and reminders with no "
        "itinerary, and anything that merely mentions a flight.\n"
        "REFUSE RATHER THAN GUESS. An email you cannot place with confidence "
        "is other, and other returns no bookings. Set is_booking true for a "
        "confirmation or a change and false otherwise.\n"
        "Never write a flight number, date, airport or booking reference that "
        "is not printed in the email. If a required field is not printed, "
        "omit that leg rather than fill it in.\n"
        "For a confirmation, return EVERY leg the email contains: a return trip "
        "is two legs, a connection is two legs, a multi-city itinerary is all "
        "of them.\n"
        "For a cancellation or a change, return the legs the email NAMES, even "
        "when it does not restate the full itinerary -- airlines often send a "
        "notice naming one flight only. Mark every leg named in a cancellation "
        "leg_status cancelled; every other leg is scheduled.\n"
        "Dates are the departure's local calendar date as YYYY-MM-DD. If no "
        "year is printed, resolve it from the received date in the message: "
        "the next occurrence on or after that date.\n"
        "THE ARRIVAL IS OPTIONAL AND IS NEVER COMPUTED. Where the email prints "
        "an arrival time, return it as arrival_time; where it prints the day the "
        "flight lands -- an overnight leg lands on a different date from the one "
        "it left -- return that as arrival_date. Where it prints neither, omit "
        "both and say nothing about the arrival. Never derive one from a "
        "duration, from the departure plus a flight time, or from a schedule you "
        "know: an arrival nobody printed is a guess with a clock on it. A "
        "boarding pass or a short cancellation notice often prints no arrival at "
        "all, and that is an ordinary answer.\n"
        "The booking reference is the short code labelled PNR, booking "
        "reference, record locator or confirmation. It is never the 13-digit "
        "ticket number.\n"
        "Set confidence below 0.6 for any leg where a field was inferred.\n"
        "CODESHARES: the flight number on the booking is the marketing number. "
        "If the email prints 'operated by <airline>' record it as operated_by, and "
        "if it prints the operator's own flight number record that as "
        "operating_flight_number. Do not derive either from knowledge."
    )


def _message_for_model(m: dict) -> str:
    return (
        f"Received: {m.get('received') or 'unknown'}\n"
        f"Subject: {m.get('subject') or ''}\n"
        f"From: {m.get('sender') or ''}\n\n"
        f"{m.get('body') or ''}"
    )


def _pdf_pages(blob: bytes) -> int:
    """How many pages the document claims, or a large number if it will not say.

    COUNTED SO IT CAN BE REFUSED, not so it can be rendered. A cheap structural
    count of the page objects is enough for a spending decision and needs no PDF
    library; being wrong by one on an itinerary changes nothing, and being wrong
    on a file this crude cannot parse is the case the fallback covers.

    AN UNREADABLE COUNT READS AS TOO MANY. A document this cannot count is one
    nothing here understands, and the safe answer for a question about spending
    is the one that declines.
    """
    try:
        n = blob.count(b"/Type/Page") + blob.count(b"/Type /Page")
        # /Type/Pages is the tree node and matches the prefix above, so it is
        # taken back off rather than counted as a page.
        n -= blob.count(b"/Type/Pages") + blob.count(b"/Type /Pages")
        return n if n > 0 else PDF_MAX_PAGES + 1
    except Exception:  # noqa: BLE001
        return PDF_MAX_PAGES + 1


def _messages_for_model(m: dict) -> list[dict]:
    """The text of the email, and the ticket where the airline attached one.

    THE TEXT ALWAYS GOES, even when it is nearly empty, because the subject and
    the received date are in it and the received date is what the year-rollover
    rule is measured against.

    THE PAGE LIMIT IS ENFORCED HERE rather than in the decoder, because it is a
    question about spending rather than about memory. Gemini bills a page at 258
    tokens whatever is printed on it, so a fare brochure costs the same per page
    as an itinerary and is worth nothing. An oversized document is dropped and
    the email still goes as text; the extraction simply has less to work with,
    which is what it had before any of this existed.
    """
    out = [llm.user_text(_message_for_model(m))]
    for blob in (m.get("pdfs") or []):
        if _pdf_pages(blob) <= PDF_MAX_PAGES:
            out.append(llm.user_file(blob, PDF_MEDIA_TYPE))
    return out


def extract_with_model(m: dict, today) -> list[dict]:
    """The model's raw legs for one email. Empty on refusal or any failure."""
    try:
        turn = llm.generate(
            model=llm.PARSE_MODEL,
            system=_system_prompt(today),
            messages=_messages_for_model(m),
            tools=[EXTRACT_TOOL],
            forced_tool="flight_bookings",
            max_tokens=EXTRACT_MAX_TOKENS,
            temperature=0,
            thinking=False,
        )
    except Exception as exc:  # noqa: BLE001
        # The reason goes to the log in llm's own words for it, never the
        # provider's message and never anything from the email.
        kind, reason = llm.failure_kind(exc)
        logger.warning("gmail extract call failed: %s", reason)
        return []
    call = next((c for c in turn.tool_calls if c.name == "flight_bookings"), None)
    if call is None:
        return []
    args = call.args or {}
    # THE KIND IS RE-CHECKED LIKE EVERYTHING ELSE. A value off the list is a
    # guess, and a guess is `other`. is_booking is DERIVED from it rather than
    # read back from the model, so the two cannot disagree.
    kind = args.get("email_kind")
    if kind not in EMAIL_KINDS:
        kind = "other"
    args["is_booking"] = kind in BOOKING_KINDS
    legs = args.get("bookings") if kind != "other" else []
    legs = legs if isinstance(legs, list) else []
    # A LEG NAMED IN A CANCELLATION IS CANCELLED, whatever the model wrote on
    # it. Stamped here so the downstream reader never depends on the model
    # having remembered the per-leg field. THE KIND RIDES ON EVERY LEG TOO:
    # the merge decides by it and logs it, and a leg is all the merge sees.
    for leg in legs:
        if isinstance(leg, dict):
            leg["email_kind"] = kind
            if kind == "cancellation":
                leg["leg_status"] = "cancelled"
    # ONE LINE PER EMAIL THE MODEL SAW. Id, kind, instant and a count: nothing
    # printed in the email reaches the log.
    logger.info("gmail email %s kind=%s received_at=%s legs=%d",
                m.get("id") or "?", kind, m.get("received_at") or "?", len(legs))
    return legs


# ══════════════════════════════════════════════════════════════════════════
# 4. RE-CHECK EVERYTHING
# ══════════════════════════════════════════════════════════════════════════

def _s(v, cap=60):
    v = str(v).strip() if isinstance(v, (str, int, float)) else ""
    return v[:cap] or None


def _place(v):
    """A three-letter code stays a code; anything else is a name."""
    v = _s(v, 60)
    if v is None:
        return None, None
    up = v.upper().replace(".", "")
    if IATA_RE.match(up):
        return up, None
    return None, v


def clean_leg(raw: dict, today, source: dict | None = None) -> dict | None:
    """One leg the model returned, re-validated field by field, or None."""
    if not isinstance(raw, dict):
        return None
    number = re.sub(r"\s+", "", str(raw.get("flight_number") or "")).upper()
    if not FLIGHT_RE.match(number):
        return None
    day = _s(raw.get("date"), 10)
    if day is None or not DAY_RE.match(day):
        return None
    try:
        when = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        return None
    # THE YEAR ROLLOVER. See ROLLOVER_MIN_GAP_DAYS for why the gap is tested.
    rolled = False
    received = None
    try:
        rd = (source or {}).get("received")
        received = datetime.strptime(rd, "%Y-%m-%d").date() if rd else None
    except (TypeError, ValueError):
        received = None
    if received is not None and (received - when).days > ROLLOVER_MIN_GAP_DAYS:
        try:
            when = when.replace(year=when.year + 1)
        except ValueError:
            return None            # 29 Feb into a year without one
        day = when.isoformat()
        rolled = True
    # DROP ANYTHING BEFORE TODAY. "Upcoming" is the contract.
    if when < today:
        return None
    # AND ANYTHING PAST WHAT AN AIRLINE WILL SELL.
    if (when - today).days > MAX_DAYS_AHEAD:
        return None
    try:
        conf = max(0.0, min(1.0, float(raw.get("confidence", 0))))
    except (TypeError, ValueError):
        conf = 0.0
    if conf < MIN_CONFIDENCE:
        return None
    pnr = _s(raw.get("pnr"), 12)
    pnr = pnr.upper().replace(" ", "") if pnr else None
    if pnr and not PNR_RE.match(pnr):
        pnr = None
    dep_time = _s(raw.get("departure_time"), 5)
    if dep_time and not re.match(r"^\d{2}:\d{2}$", dep_time):
        dep_time = None
    # ── THE ARRIVAL, CHECKED LIKE THE DEPARTURE AND DROPPED LIKE A FIELD ─────
    #
    # A BAD VALUE COSTS THE FIELD, NOT THE LEG. Every other test above returns
    # None and loses the whole leg, because a leg with no number or no date is
    # not a leg. An arrival is what lets the app say how long a layover is, and
    # a leg without one is still a flight somebody is on -- so an unparseable
    # arrival is simply not carried.
    arr_time = _s(raw.get("arrival_time"), 5)
    if arr_time and not re.match(r"^\d{2}:\d{2}$", arr_time):
        arr_time = None
    arr_day = _s(raw.get("arrival_date"), 10)
    if arr_day is not None and not DAY_RE.match(arr_day):
        arr_day = None
    if arr_day is not None:
        try:
            arr_when = datetime.strptime(arr_day, "%Y-%m-%d").date()
        except ValueError:
            arr_day = None
        else:
            # THE SAME BUMP THE DEPARTURE TOOK, when it took one. The rollover
            # fires because the email printed no year and the wrong one was
            # resolved; an arrival printed beside that departure is wrong the
            # same way, and an arrival a year before its own departure would
            # make every interval computed from it negative.
            if rolled:
                try:
                    arr_day = arr_when.replace(year=arr_when.year + 1).isoformat()
                except ValueError:
                    arr_day = None
    o_iata, o_name = _place(raw.get("origin"))
    d_iata, d_name = _place(raw.get("destination"))
    op_num = re.sub(r"\s+", "", str(raw.get("operating_flight_number") or "")).upper() or None
    if op_num is not None and (not FLIGHT_RE.match(op_num) or op_num == number):
        op_num = None
    # THE STATUS, DEFAULTING TO SCHEDULED. Anything but the two known values is
    # treated as the default rather than carried through as a stranger.
    status = raw.get("leg_status")
    if status not in LEG_STATUSES:
        status = "scheduled"
    # THE KIND OF EMAIL THE LEG CAME FROM, on the same terms. A leg with none
    # -- an older caller, a test -- is a confirmation, which is what every leg
    # was before emails were classified.
    kind = raw.get("email_kind")
    if kind not in EMAIL_KINDS:
        kind = "confirmation"
    return {
        "flight_number": number,
        "date": day,
        "departure_time": dep_time,
        # BOTH ABSENT UNLESS THE EMAIL PRINTED THEM. Nothing here fills them in,
        # and no reader may treat a missing arrival as a statement of any kind
        # about when the flight lands.
        "arrival_time": arr_time,
        "arrival_date": arr_day,
        "origin": o_iata,
        "origin_name": o_name,
        "destination": d_iata,
        "destination_name": d_name,
        "airline": _s(raw.get("airline"), 40),
        # CODESHARES. The number on the booking is the marketing carrier's; the
        # aircraft flies under the operator's. Both are kept where the email
        # printed both, and the app looks the flight up under the operating one
        # when it has it -- that is the number the landing feed knows.
        "operated_by": _s(raw.get("operated_by"), 40),
        "operating_flight_number": op_num,
        "pnr": pnr,
        "confidence": round(conf, 2),
        # scheduled or cancelled. The merge below acts on it: a cancelled leg
        # marks the stored copy rather than replacing it.
        "leg_status": status,
        # WHAT THE EMAIL WAS. The merge's reason for each decision, and the
        # word it logs. Beside leg_status rather than inside source, because
        # source is what the app shows a person and this is bookkeeping.
        "email_kind": kind,
        # WHERE IT CAME FROM: the subject and the received date, so the app can
        # say "from your BA email of 3 March". Never the body. received_at is
        # the same arrival to the millisecond, for ordering.
        "source": {
            "subject": (source or {}).get("subject"),
            "received": (source or {}).get("received"),
            "received_at": (source or {}).get("received_at"),
        },
    }


def _received_order(leg: dict):
    """Sort key: the instant the email arrived, with the undated last.

    received_at is an ISO-8601 UTC string with a fixed layout, so the strings
    order as the instants do. A leg whose email carries no instant -- a fixture
    read from a file, a test -- cannot be placed and goes after every leg that
    can, in the order it came.
    """
    at = (leg.get("source") or {}).get("received_at")
    return (1, "") if not at else (0, at)


# ── THE FIELDS WHERE A LATER EMAIL CAN SAY LESS AND STILL BE LATER ─────────
#
# BOTH ARE AIRLINE NAMES AND BOTH ARE FREE TEXT. The schema asks for "the
# MARKETING airline, whose code is on the flight number" and for the operator
# named in the fine print, and a terse e-ticket gives a model nothing to answer
# with but the code -- so "SK" and "AA" come back where "Scandinavian Airlines"
# and "American Airlines" came back from the fuller confirmation.
#
# NOTHING ELSE ON A LEG CAN LOSE THIS WAY, which is why the tuple is two long:
#   origin / destination hold an IATA code by construction and origin_name /
#     destination_name hold a name -- _place routes each to its own field, so a
#     code can never arrive in the name's slot to overwrite anything.
#   operating_flight_number, pnr and flight_number ARE codes. Protecting them
#     would mean refusing the correction a later email exists to make.
#   departure_time, arrival_time, date, arrival_date, confidence, leg_status
#     and the source are not names. The two arrival fields take the ordinary
#     rule, which is what they want: a later email that revises an arrival is
#     stating a new fact, and one that omits it leaves the stored value alone
#     through the blank-fill above.
NAME_FIELDS = ("airline", "operated_by")


def _name_lost(later, earlier) -> bool:
    """True when `later` is a bare carrier code and `earlier` is a real name.

    THE TEST IS ASYMMETRIC ON PURPOSE. A code replacing a name is a loss; a NAME
    replacing a code is the correction this merge exists to allow, and a code
    replacing a code is just a later answer to the same question.
    """
    if not isinstance(later, str) or not isinstance(earlier, str):
        return False
    l, e = later.strip().upper(), earlier.strip().upper()
    if not l or not e:
        return False
    return bool(CARRIER_CODE_RE.match(l)) and not CARRIER_CODE_RE.match(e)


def merge(legs: list[dict]) -> list[dict]:
    """One entry per leg, the way the LATEST email left it.

    ── WHAT THE UNION GOT WRONG ────────────────────────────────────────────
    The old merge kept the copy with the higher confidence and filled its
    blanks from the rest. Nothing ordered the emails, so nothing could
    supersede anything: a reschedule lost to a surer original, and a
    cancellation could not touch a confirmation at all -- it was not even
    extracted. Confidence measures how well a field was READ, not whether it
    is still TRUE, and the second is what a person needs.

    ── THE RULES, IN ARRIVAL ORDER ─────────────────────────────────────────
    Emails are walked oldest to newest by the instant Gmail received them.
    Keyed on number and date, which is what the app keys a saved flight on.
      - A confirmation or change leg not yet seen is ADDED.
      - A confirmation or change leg already seen UPDATES the stored copy:
        the later email's values win wherever the two disagree, and its
        blanks are filled from the stored copy, as before. Recency is the
        better signal for every field but the two exceptions below.
      - A LATER EMAIL THAT SAYS LESS DOES NOT WIN. Recency is a good signal
        for which value is TRUE and a poor one for which is USEFUL: a curt
        e-ticket answering "SK" where the confirmation said "Scandinavian
        Airlines" is not new information about the airline, it is the same
        information with the name taken off. On the name fields the stored
        value is kept -- see NAME_FIELDS and _name_lost.
      - A cancellation leg MARKS the stored copy cancelled and changes nothing
        else on it. With no stored copy the leg is added as it is, carrying
        cancelled, so the app can still show what was called off.
      - CANCELLED IS STICKY. Once marked, no later confirmation or change leg
        on the same number and date puts leg_status back to scheduled; it may
        update every other field. A rebooking onto the same flight is rare
        and a re-sent itinerary that still lists a cancelled leg is not, so
        the status that costs a person a trip is the one that must not flip
        on a restatement.
      - A leg is NEVER removed by absence. An itinerary that no longer lists
        a leg says nothing about it; only an explicit cancellation may mark.
    """
    stored = {}
    for leg in sorted(legs, key=_received_order):
        key = (leg["flight_number"], leg["date"])
        kind = leg.get("email_kind") or "confirmation"
        cur = stored.get(key)
        if leg.get("leg_status") == "cancelled":
            if cur is None:
                stored[key] = leg
                action = "added cancelled"
            else:
                cur["leg_status"] = "cancelled"
                action = "marked cancelled"
        elif cur is None:
            stored[key] = leg
            action = "added"
        else:
            # THE LATER EMAIL WINS; the earlier one fills what it left blank.
            for k, v in cur.items():
                if leg.get(k) in (None, "") and v not in (None, ""):
                    leg[k] = v
            # AND EXCEPT A NAME THE LATER EMAIL ABBREVIATED TO A CODE, which
            # the blank-fill above cannot catch: "SK" is not blank, it is
            # simply worth less than what is already stored.
            for field in NAME_FIELDS:
                if _name_lost(leg.get(field), cur.get(field)):
                    leg[field] = cur[field]
            # EXCEPT THE STATUS, WHICH ONLY EVER GOES ONE WAY. See the rules.
            if cur.get("leg_status") == "cancelled":
                leg["leg_status"] = "cancelled"
            stored[key] = leg
            action = "updated"
        # ONE LINE PER DECISION. The number and the date name the leg; the
        # kind is why; the action is what. No subject, sender or body.
        logger.info("gmail merge %s %s kind=%s %s", leg["flight_number"], leg["date"], kind, action)
    return sorted(stored.values(), key=lambda l: (l["date"], l["departure_time"] or "99:99", l["flight_number"]))


# ══════════════════════════════════════════════════════════════════════════
# THE WHOLE THING
# ══════════════════════════════════════════════════════════════════════════

def upcoming_flights(token: str, today=None, *, fetch=fetch_message, extract=extract_with_model,
                     lister=list_messages) -> dict:
    """Every upcoming flight leg in the user's Gmail, or why not.

    {ok, code, flights, scanned, extracted}. `code` is one of the outcome codes
    above and is what the endpoint turns into a sentence.

    fetch / extract / lister are injectable so the tests run with no network
    and no model.
    """
    today = today or datetime.now(timezone.utc).date()
    if not token:
        return {"ok": False, "code": EXPIRED, "flights": [], "scanned": 0, "extracted": 0}

    ids, code = lister(token, today)
    if code is not OK:
        logger.warning("gmail list failed: %s", code)
        return {"ok": False, "code": code, "flights": [], "scanned": 0, "extracted": 0}
    ids = ids[:FETCH_MAX]

    with ThreadPoolExecutor(max_workers=FETCH_POOL) as pool:
        fetched = [m for m in pool.map(lambda i: fetch(token, i), ids) if m]

    # STRUCTURED FIRST, AT NO TOKEN COST. An email that states its legs in
    # JSON-LD is read and done; only the rest are gated and sent to the model.
    legs = []
    structured_n = 0
    rest = []
    for m in fetched:
        if m.get("jsonld"):
            structured_n += 1
            # The same line the model path writes, so every email that yields
            # legs has one. The kind is where the legs came from: no model saw
            # this email, so nothing classified it.
            logger.info("gmail email %s kind=%s received_at=%s legs=%d",
                        m.get("id") or "?", "jsonld", m.get("received_at") or "?", len(m["jsonld"]))
            for raw in m["jsonld"]:
                leg = clean_leg(raw, today, source=m)
                if leg is not None:
                    leg["method"] = "jsonld"
                    legs.append(leg)
        else:
            rest.append(m)
    candidates = [m for m in rest if worth_a_model_call(m)][:EXTRACT_MAX]

    with ThreadPoolExecutor(max_workers=MODEL_POOL) as pool:
        for m, raw_legs in zip(candidates, pool.map(lambda m: extract(m, today), candidates)):
            for raw in raw_legs:
                leg = clean_leg(raw, today, source=m)
                if leg is not None:
                    leg["method"] = "model"
                    legs.append(leg)

    flights = merge(legs)
    # COUNTS ONLY. Nothing from any email reaches the log.
    logger.info("gmail flights: listed %d fetched %d structured %d sent %d legs %d upcoming %d",
                len(ids), len(fetched), structured_n, len(candidates), len(legs), len(flights))
    return {"ok": True, "code": OK, "flights": flights,
            "scanned": len(fetched), "structured": structured_n, "extracted": len(candidates)}


# ══════════════════════════════════════════════════════════════════════════
# A FIXTURE INBOX, so the app can be pointed at synthetic emails
# ══════════════════════════════════════════════════════════════════════════
#
# tools/gmail_fixtures/*.eml are seven airline emails, none real. With these
# two in place of list_messages and fetch_message, upcoming_flights runs the
# same code from decode_body onward -- JSON-LD, gate, model, re-check, merge --
# on files instead of a mailbox. The endpoint enables this ONLY for a token
# that matches an environment secret; see api.py.
FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "gmail_fixtures")


def fixture_lister(token, today):
    try:
        names = sorted(f for f in os.listdir(FIXTURE_DIR) if f.endswith(".eml"))
    except OSError:
        return [], ERROR
    return names, OK


def fixture_fetch(token, name):
    try:
        with open(os.path.join(FIXTURE_DIR, name), "rb") as f:
            return decode_body(base64.urlsafe_b64encode(f.read()).decode().rstrip("="))
    except Exception:  # noqa: BLE001
        return None


def soonest(flights: list[dict]) -> dict | None:
    """The next leg to depart, for callers that want one answer."""
    return flights[0] if flights else None
