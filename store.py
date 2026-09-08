"""Everything the alerts feature keeps in Google Cloud Storage.

api.py calls these functions and mcp_server.py does not know this file exists —
provider code and storage code stay apart, so a change to one cannot break the
other. pollstate.py is the other module that holds a bucket; it keeps what each
watched flight LOOKED LIKE, where this keeps WHO IS WATCHING WHAT, and they are
separate objects so a registration and a poll cannot contend for one file.

AUTHENTICATION IS THE RUNTIME SERVICE ACCOUNT'S. storage.Client() picks up
Application Default Credentials, which on Cloud Run is the service's own
identity. There is no key file and no credentials environment variable, and
there must never be one: a key in the image is a key in the repository sooner or
later.

UNCONFIGURED IS A VALID STATE. If ALERTS_BUCKET is unset this module still
imports and every operation returns an error dict rather than raising, so the
service boots and /flight, /route, /quota, /chat and /parse are untouched by a
feature they know nothing about. THE SDK ITSELF IS LOADED LAZILY, via gcs.py,
for the same reason and one layer down -- see the note in that file.
"""
import json
import os
import random
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import gcs

ALERTS_BUCKET = (os.getenv("ALERTS_BUCKET") or "").strip()

# ── THE ONE VALUE THAT MUST NEVER REACH THE BUCKET ──────────────────────────
#
# THE ALERT PAYLOAD ECHOES OUR OWN CALLBACK URL BACK AT US, secret and all.
# subscription.subscriber.id is the full webhook address the provider was given:
#
#   {"subscription": {"subscriber": {"type": "WebHook", "id": ".../alerts/<SECRET>"}}}
#
# So a body stored verbatim puts ALERT_WEBHOOK_SECRET in Cloud Storage, and
# GET /alerts/{ALERT_READ_SECRET}/deliveries/{id} hands it to anyone holding the
# READ secret. Two secrets exist precisely so that one cannot be used to obtain
# the other, and storing the body raw quietly collapsed them into one.
#
# READ HERE RATHER THAN PASSED IN, and this is the one env var this module reads
# that it does not otherwise use. A redaction that depends on a caller
# remembering to pass the secret is a redaction that stops happening the first
# time somebody adds a second call site.
#
# UNSET IS SAFE: the structural rule below removes the whole URL regardless, and
# an empty secret would otherwise match everywhere.
_WEBHOOK_SECRET = (os.getenv("ALERT_WEBHOOK_SECRET") or "").strip()
REDACTED = "[redacted]"

# ──────────────────────────────────────────────
# SHAPE AND LIMITS
# ──────────────────────────────────────────────
WATCHES_KEY = "watches.json"
WATCH_STORE_VERSION = 1

MAX_WATCHES_PER_DEVICE = 20
MAX_WATCHES_TOTAL = 5000
MAX_PUSH_TOKEN_CHARS = 256

# A row is dropped once its date is this far behind the server's UTC date, and
# the same bound is the earliest date a registration may name. Two numbers that
# must agree: a date the store would accept and then immediately prune would be
# a registration that succeeds and vanishes.
PRUNE_PAST_DAYS = 2
DATE_MAX_FUTURE_DAYS = 400

# 1 MiB of body kept. Past that the record says so and still exists — a delivery
# we could not store whole is worth far more than one we refused.
MAX_RAW_BODY_BYTES = 1024 * 1024

DEFAULT_LIST_LIMIT = 100
MAX_LIST_LIMIT = 500

# Five attempts at the read-modify-write below. Randomised so two instances that
# collide do not collide again on the same schedule.
WRITE_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 0.05
BACKOFF_MAX_SECONDS = 0.4

PLATFORMS = ("ios", "android", "unknown")

# The canonical 36-character form and nothing else. A device id is generated
# once on the device and never typed, so anything that is not this shape is a
# client bug or an attempt, and both deserve the same answer.
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_FLIGHT_NUMBER_RE = re.compile(r"^[A-Z0-9]{3,8}$")
_ISO_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Every error a caller can be handed. Distinct strings, because the two caps in
# particular are different problems: one is the user's, one is ours.
ERR_NOT_CONFIGURED = "storage is not configured"
ERR_BAD_DEVICE = "invalid device id"
ERR_BAD_TOKEN = "invalid push token"
ERR_BAD_NUMBER = "invalid flight number"
ERR_BAD_DATE = "invalid flight date"
ERR_BAD_DELIVERY_ID = "invalid delivery id"
ERR_DEVICE_CAP = "device watch limit reached"
ERR_GLOBAL_CAP = "global watch limit reached"
ERR_CONTENTION = "storage is busy"
ERR_READ = "storage read failed"
ERR_WRITE = "storage write failed"
ERR_NOT_FOUND = "not found"


# ──────────────────────────────────────────────
# CLIENT
# ──────────────────────────────────────────────
# ONE CLIENT FOR THE PROCESS, built on first use, in the same spirit as
# mcp_server.py's module-level requests.Session: a client per request would pay
# for credential discovery and a fresh connection pool every time.
_client = None


def _bucket():
    """The bucket handle, or None when the feature is not configured."""
    global _client
    if not ALERTS_BUCKET:
        return None
    storage = gcs.sdk()
    if storage is None:
        return None
    if _client is None:
        _client = storage.Client()
    return _client.bucket(ALERTS_BUCKET)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ──────────────────────────────────────────────
# VALIDATION
# ──────────────────────────────────────────────
# All of it lives here rather than in the endpoints, so /watch and /unwatch
# cannot drift apart on what a flight number is.
def _clean_device_id(value):
    s = str(value or "").strip()
    return (s, None) if _UUID_RE.match(s) else (None, ERR_BAD_DEVICE)


def _clean_push_token(value):
    """None, or a string of at most MAX_PUSH_TOKEN_CHARS.

    An empty or whitespace-only string becomes None rather than being stored:
    "" and null both mean "no token yet", and keeping two representations of one
    state is how a later `if token:` and a later `if token is not None:` end up
    disagreeing.
    """
    if value is None:
        return (None, None)
    if not isinstance(value, str):
        return (None, ERR_BAD_TOKEN)
    s = value.strip()
    if s == "":
        return (None, None)
    if len(s) > MAX_PUSH_TOKEN_CHARS:
        return (None, ERR_BAD_TOKEN)
    return (s, None)


def _clean_owned(value):
    """True (the person is on the flight), False (meeting it), or None
    (an app that predates the flag). Never rejected: a watch is a watch."""
    if value is True or value is False:
        return value
    return None


def _clean_platform(value) -> str:
    """Coerced, never rejected. A platform we do not recognise is still a device
    worth watching for, and "unknown" says exactly what we know."""
    s = str(value or "").strip().lower()
    return s if s in PLATFORMS else "unknown"


def _clean_flight_number(value):
    s = re.sub(r"\s+", "", str(value or "")).upper()
    if not _FLIGHT_NUMBER_RE.match(s):
        return (None, ERR_BAD_NUMBER)
    # At least one digit, which is what separates AI2758 from a word.
    if not any(c.isdigit() for c in s):
        return (None, ERR_BAD_NUMBER)
    return (s, None)


def _clean_flight_date(value, today):
    s = str(value or "").strip()
    if not _ISO_DAY_RE.match(s):
        return (None, ERR_BAD_DATE)
    try:
        day = datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return (None, ERR_BAD_DATE)
    if day < today - timedelta(days=PRUNE_PAST_DAYS):
        return (None, ERR_BAD_DATE)
    if day > today + timedelta(days=DATE_MAX_FUTURE_DAYS):
        return (None, ERR_BAD_DATE)
    return (s, None)


# ──────────────────────────────────────────────
# THE WATCH STORE
# ──────────────────────────────────────────────
def _prune(rows, today):
    """Rows whose date is safely behind us. Runs inside every mutation, which is
    why there is no cron job and nothing to forget to schedule."""
    cutoff = today - timedelta(days=PRUNE_PAST_DAYS)
    kept = []
    for r in rows:
        s = str((r or {}).get("flight_date") or "")
        if not _ISO_DAY_RE.match(s):
            # Unparseable: keep it. A row we cannot date is not a row we can
            # prove is expired, and dropping it would be guessing.
            kept.append(r)
            continue
        try:
            if datetime.strptime(s, "%Y-%m-%d").date() >= cutoff:
                kept.append(r)
        except ValueError:
            kept.append(r)
    return kept


def _read_watches(bucket):
    """(rows, generation). A MISSING object is an empty store and generation 0.

    A CORRUPT object is NOT. Missing means nobody has registered yet; corrupt
    means something is there and we cannot read it, and treating that as empty
    would have the very next write destroy every watch in it. It raises instead
    and the caller reports a read failure.
    """
    blob = bucket.get_blob(WATCHES_KEY)
    if blob is None:
        return [], 0
    doc = json.loads(blob.download_as_bytes().decode("utf-8"))
    rows = doc.get("watches") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        raise ValueError("watches.json has no watches list")
    return rows, blob.generation


def _mutate_watches(apply_fn):
    """Read with a generation, modify, write back with a precondition, retry.

    THE PRECONDITION IS THE WHOLE POINT. Cloud Run runs several instances and
    two of them can register different flights in the same instant; a plain
    read-modify-write would silently lose one. if_generation_match makes the
    second write fail with a 412 instead, and the loop re-reads the copy that
    won and applies the change to it.

    A brand new object is written with if_generation_match=0, which means "only
    if this does not exist" — so two instances racing to create the store cannot
    both succeed.

    NOTHING IS CACHED IN PROCESS MEMORY. A cached watches.json on one instance
    goes stale the moment another instance writes, and it goes stale silently.
    """
    bucket = _bucket()
    if bucket is None:
        return {"ok": False, "error": ERR_NOT_CONFIGURED}

    today = _now().date()
    for attempt in range(WRITE_ATTEMPTS):
        try:
            rows, generation = _read_watches(bucket)
        except gcs.errors().GoogleAPIError:
            return {"ok": False, "error": ERR_READ}
        except (ValueError, UnicodeDecodeError):
            return {"ok": False, "error": ERR_READ}

        # Pruned before the change is applied, so the caps below count only rows
        # that are still real.
        rows = _prune(rows, today)
        new_rows, result = apply_fn(rows, today)
        # A rejection writes nothing at all — including the pruning, which is
        # only ever persisted alongside a successful mutation.
        if new_rows is None:
            return result

        doc = {
            "version": WATCH_STORE_VERSION,
            "updated_at": _iso(_now()),
            "watches": new_rows,
        }
        try:
            bucket.blob(WATCHES_KEY).upload_from_string(
                json.dumps(doc, separators=(",", ":")),
                content_type="application/json",
                if_generation_match=generation,
            )
            return result
        except gcs.errors().PreconditionFailed:
            # Somebody else wrote between our read and our write. Re-read and
            # reapply; the backoff is randomised so a collision does not repeat
            # on the same schedule.
            delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (2 ** attempt))
            time.sleep(delay * (0.5 + random.random()))
            continue
        except gcs.errors().GoogleAPIError:
            return {"ok": False, "error": ERR_WRITE}

    return {"ok": False, "error": ERR_CONTENTION}


def watched_flights():
    """Every distinct flight instance somebody is watching, newest date first.

    ONE ROW PER FLIGHT, NOT PER DEVICE, and that is the whole reason this exists
    rather than the poller reading watches.json itself. Four people watching
    EK500 is one flight to ask the provider about; returning four rows would
    invite four calls for one answer, and the provider bills per call.

    THE DEVICES COME BACK WITH IT because dispatch will need them, and finding
    them later would mean reading this object a second time. Dispatch does not
    exist yet -- see pollstate.py -- so nothing reads the field today.

    Read-only: no pruning, no write, no generation. A poll is the most frequent
    thing that touches this store and it should never be able to damage it.

    RETURNS None WHEN THE STORE CANNOT BE READ, and [] when it can be read and is
    empty. THE TWO ARE NOT THE SAME and collapsing them is how a poller ends up
    doing nothing for ever without a single error in the log: an unreadable
    object would read as "nobody is watching anything". This module does not
    raise -- see the note at the top of the file -- so the distinction is carried
    in the return value and the caller is expected to check it.
    """
    bucket = _bucket()
    if bucket is None:
        return []
    try:
        rows, _ = _read_watches(bucket)
    except (ValueError, UnicodeDecodeError, gcs.errors().GoogleAPIError):
        return None

    by_flight = {}
    for r in rows or []:
        num = str((r or {}).get("flight_number") or "").strip().upper()
        day = str((r or {}).get("flight_date") or "").strip()
        if not num or not _ISO_DAY_RE.match(day):
            continue
        entry = by_flight.setdefault((num, day), {
            "flight_number": num,
            "flight_date": day,
            "devices": [],
        })
        tok = r.get("push_token")
        entry["devices"].append({
            "device_id": r.get("device_id"),
            "push_token": tok,
            "platform": r.get("platform"),
            # ON IT OR MEETING IT. The sender writes the subject of a message
            # from this: "your flight to X" against "the flight from Y". None
            # reads as on it. See notify.subject.
            "owned": _clean_owned(r.get("owned")),
        })

    return sorted(by_flight.values(),
                  key=lambda f: (f["flight_date"], f["flight_number"]),
                  reverse=True)


def register_watch(device_id, push_token, platform, flight_number, flight_date, owned=None):
    """Upsert on (device_id, flight_number, flight_date)."""
    did, err = _clean_device_id(device_id)
    own = _clean_owned(owned)
    if err:
        return {"ok": False, "error": err}
    tok, err = _clean_push_token(push_token)
    if err:
        return {"ok": False, "error": err}
    num, err = _clean_flight_number(flight_number)
    if err:
        return {"ok": False, "error": err}
    plat = _clean_platform(platform)

    def apply(rows, today):
        day, date_err = _clean_flight_date(flight_date, today)
        if date_err:
            return None, {"ok": False, "error": date_err}

        now = _iso(_now())
        for i, r in enumerate(rows):
            if (r.get("device_id") == did
                    and r.get("flight_number") == num
                    and r.get("flight_date") == day):
                # EXISTING ROW: the token and platform are refreshed and
                # created_at is kept. A device that reinstalls gets a new token
                # against the same watch rather than a second one.
                updated = dict(r)
                updated["push_token"] = tok
                updated["platform"] = plat
                # Ownership follows the latest registration: owning a watched
                # flight re-registers it, and so does disowning one.
                if own is not None:
                    updated["owned"] = own
                updated["updated_at"] = now
                out = list(rows)
                out[i] = updated
                return out, {"ok": True, "created": False, "error": None}

        mine = sum(1 for r in rows if r.get("device_id") == did)
        if mine >= MAX_WATCHES_PER_DEVICE:
            return None, {"ok": False, "error": ERR_DEVICE_CAP}
        if len(rows) >= MAX_WATCHES_TOTAL:
            return None, {"ok": False, "error": ERR_GLOBAL_CAP}

        # FLAT, and the number and the date are SEPARATE FIELDS. The app's saved
        # flight id is number+date joined, but the provider subscribes by bare
        # number, so the server has to be able to group by number without
        # parsing a composite key back apart.
        row = {
            "device_id": did,
            "push_token": tok,
            "platform": plat,
            "flight_number": num,
            "flight_date": day,
            "owned": own,
            "created_at": now,
            "updated_at": now,
        }
        return rows + [row], {"ok": True, "created": True, "error": None}

    return _mutate_watches(apply)


def unregister_watch(device_id, flight_number, flight_date):
    """Remove the matching row.

    REMOVING SOMETHING THAT IS NOT THERE IS A SUCCESS. Unsave has to be
    idempotent: the app fires this and forgets, a retry is indistinguishable
    from a first attempt, and "it is already gone" is the outcome the caller
    wanted either way.
    """
    did, err = _clean_device_id(device_id)
    if err:
        return {"ok": False, "error": err}
    num, err = _clean_flight_number(flight_number)
    if err:
        return {"ok": False, "error": err}

    def apply(rows, today):
        day, date_err = _clean_flight_date(flight_date, today)
        if date_err:
            return None, {"ok": False, "error": date_err}
        out = [
            r for r in rows
            if not (r.get("device_id") == did
                    and r.get("flight_number") == num
                    and r.get("flight_date") == day)
        ]
        return out, {"ok": True, "removed": len(rows) - len(out), "error": None}

    return _mutate_watches(apply)


# ──────────────────────────────────────────────
# DELIVERIES
# ──────────────────────────────────────────────
# ONE OBJECT PER DELIVERY, partitioned on the UTC date of receipt. Never
# appended to a shared file, so there is no read-modify-write here at all: two
# deliveries in the same millisecond cannot lose each other, and a delivery
# storm cannot corrupt watches.json because it never opens it.

# BEST EFFORT, and this list is a guess. We do not know the provider's payload
# shape — discovering it is what the whole endpoint is for — so these are
# plausible names and nothing more. A miss writes null and the raw body still
# holds the truth.
_ITEM_KEYS = ("flights", "items", "alerts", "data", "results", "notifications", "events")
# ── WHERE THE BALANCE ACTUALLY LIVES, NOW THAT SIXTEEN DELIVERIES HAVE SHOWN ──
#
# balance.creditsRemaining, ONE LEVEL DOWN, AND THAT IS WHY EVERY DELIVERY
# RECORDED None. The old lookup read top-level keys only. It had both halves of
# the right answer in its list -- "balance" and "creditsRemaining" -- and could
# not reach it: parsed["balance"] IS present but is a dict, which fails the
# numeric test, and parsed["creditsRemaining"] does not exist at the top level.
# The key was in the list twice and the lookup was one level too shallow.
#
# THE OBSERVED PAYLOAD, from delivery c63585c2 of the EK500 run:
#
#   { id, timestampUtc, flights: [...],
#     subscription:    { id, isActive, billingType, createdOnUtc, subject, ... },
#     balance:         { creditsRemaining: 9, lastRefilledUtc, lastDeductedUtc },
#     deliveryAttempt: { seqNo: 1, costCredits: 1, timestampUtc } }
#
# THE TOP-LEVEL NAMES ARE KEPT AS A FALLBACK rather than replaced. They cost one
# dict lookup each and they are the shapes a different provider, or a later
# version of this one, might use. What is added is the nesting, not a new guess.
_CREDIT_KEYS = (
    "credits_remaining", "creditsRemaining", "credits",
    "remaining_credits", "remainingCredits", "units_remaining", "unitsRemaining",
)

# THE CONTAINERS WORTH LOOKING INSIDE, in order. "balance" is what AeroDataBox
# sends; the rest are the same idea under other names, and each is only opened if
# it is actually a dict.
_CREDIT_CONTAINERS = ("balance", "quota", "usage", "account")

# ── WHAT ONE DELIVERY COST, AND WHETHER IT IS A REDELIVERY ───────────────────
#
# costCredits IS THE ONLY HONEST RECORD OF WHAT THE EXPERIMENT SPENT. The
# balance says what is left, which moves for reasons that have nothing to do
# with this webhook -- a refill, a lookup somewhere else -- so it cannot be
# differenced to get a cost. This is the provider stating the price of THIS
# delivery, and sixteen of them at 1 credit each is the whole bill.
#
# seqNo IS HOW A REDELIVERY IS SPOTTED. A retry of the same notification arrives
# with the same seqNo and a new delivery_id, so two records sharing one seqNo are
# one event counted twice -- which is exactly the thing that would make a
# delivery count look higher than the flight's real number of updates.
_ATTEMPT_KEY = "deliveryAttempt"


def _item_count(parsed):
    if isinstance(parsed, list):
        return len(parsed)
    if isinstance(parsed, dict):
        for key in _ITEM_KEYS:
            value = parsed.get(key)
            if isinstance(value, list):
                return len(value)
        # An object that is not a container of anything we recognise is one
        # thing, which is the least wrong answer available.
        return 1
    return None


def _number(value):
    """A real number or nothing. bool is a subclass of int and True is not a
    balance, a cost or a sequence number."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def _credits_remaining(parsed):
    if not isinstance(parsed, dict):
        return None
    # The nesting first, because it is where the answer demonstrably is.
    for container in _CREDIT_CONTAINERS:
        inner = parsed.get(container)
        if isinstance(inner, dict):
            for key in _CREDIT_KEYS:
                found = _number(inner.get(key))
                if found is not None:
                    return found
    # Then the top level, unchanged, for a shape this has not seen.
    for key in _CREDIT_KEYS:
        found = _number(parsed.get(key))
        if found is not None:
            return found
    return None


def _attempt(parsed):
    """(cost_credits, seq_no) from deliveryAttempt, or (None, None).

    ONE READER FOR TWO FIELDS because they arrive in one object and are useless
    apart: a cost without a sequence cannot be de-duplicated, and a sequence
    without a cost says nothing about the bill.
    """
    if not isinstance(parsed, dict):
        return (None, None)
    attempt = parsed.get(_ATTEMPT_KEY)
    if not isinstance(attempt, dict):
        return (None, None)
    return (_number(attempt.get("costCredits")), _number(attempt.get("seqNo")))


def _redact(raw_body: str, parsed):
    """(text to store, whether anything was removed).

    TWO RULES, AND EACH COVERS WHAT THE OTHER CANNOT.

    A. THE CALLBACK URL, STRUCTURALLY. Found through the parsed object so the
       exact string is known, then cut out of the RAW TEXT rather than by
       re-serialising the parse. The body is the record of truth and every other
       byte of it stays exactly as it arrived -- key order, spacing, unicode
       escapes and all.

       THREE SPELLINGS OF ONE URL ARE TRIED, because a parsed string does not
       tell you how it was written down. json.dumps gives the quote and unicode
       escaping but DELIBERATELY LEAVES SLASHES ALONE, so it is not the same
       string as a serialiser that writes a slash-escaped URL -- and that form is
       common enough to be worth its own attempt rather than being left to rule
       B. The plain form is last and is what the provider actually sends.

       THE WHOLE URL GOES, not just the secret inside it: the address of our own
       webhook is not something a delivery listing needs.

    B. THE SECRET ITSELF, TEXTUALLY, afterwards. This is what still works when
       the body did not parse -- a truncated or malformed payload is exactly the
       case where the structural rule finds nothing -- and it catches any other
       field that quotes the URL. It runs second because A has usually already
       taken the only copy.

    NEITHER RULE TOUCHES `parsed`, so item_count, the balance and the attempt are
    all derived from the body as it actually arrived.
    """
    text = raw_body
    removed = False

    subscription = parsed.get("subscription") if isinstance(parsed, dict) else None
    subscriber = subscription.get("subscriber") if isinstance(subscription, dict) else None
    url = subscriber.get("id") if isinstance(subscriber, dict) else None
    if isinstance(url, str) and url != "":
        for form in (json.dumps(url)[1:-1], url.replace("/", "\\/"), url):
            if form in text:
                text = text.replace(form, REDACTED)
                removed = True

    if _WEBHOOK_SECRET and _WEBHOOK_SECRET in text:
        text = text.replace(_WEBHOOK_SECRET, REDACTED)
        removed = True

    return text, removed


def build_delivery(raw_body_bytes, headers_subset) -> dict:
    """The delivery record, derived and nothing more. PURE: no I/O, no bucket.

    Separate from record_delivery because the webhook has to LOG the delivery
    before it writes it — the log is the backstop for a slow or failing bucket —
    and the log line carries fields that only exist once the body is parsed.
    """
    body = raw_body_bytes or b""
    body_bytes = len(body)
    truncated = body_bytes > MAX_RAW_BODY_BYTES
    kept = body[:MAX_RAW_BODY_BYTES] if truncated else body
    # errors="replace" so a body that is not UTF-8 is still stored rather than
    # thrown away for being unreadable.
    raw_body = kept.decode("utf-8", errors="replace")

    parsed = None
    parsed_json = False
    try:
        parsed = json.loads(raw_body)
        parsed_json = True
    except ValueError:
        # NOT AN ERROR. A body that is not JSON is exactly the kind of thing
        # this endpoint exists to find out about, and it is stored verbatim.
        pass

    # AFTER THE PARSE, NEVER BEFORE. The derivations below read `parsed`, which
    # is built from the body as it arrived; only the text that gets STORED is
    # rewritten. body_bytes stays the received length, because that is a fact
    # about the delivery rather than about the record.
    raw_body, redacted = _redact(raw_body, parsed)

    headers = headers_subset or {}
    raw_length = headers.get("content-length")
    try:
        content_length = int(raw_length) if raw_length is not None else None
    except (TypeError, ValueError):
        content_length = None

    return {
        "delivery_id": str(uuid.uuid4()),
        "received_at": _iso(_now()),
        # ONLY these three headers. Never the full set, never any part of the
        # URL path: the path carries the webhook secret. The BODY carries it
        # too, which is what _redact is for -- this comment was true and
        # insufficient, and the payload was quoting the address back at us.
        "content_type": headers.get("content-type"),
        "user_agent": headers.get("user-agent"),
        "content_length": content_length,
        "body_bytes": body_bytes,
        "truncated": truncated,
        "parsed_json": parsed_json,
        # THE ITEM CONTAINER IS "flights" AND _ITEM_KEYS ALREADY LED WITH IT,
        # which is why item_count was right through the whole experiment while
        # credits_remaining was not.
        #
        # AND flights[].status IS A NUMBER, NOT A STRING. The observed payload
        # carries `"status": 1` and `"number": "EK 500"` -- so whatever reads
        # this to dispatch a notification must compare against integers, not
        # against the provider's own words. The REST endpoint this app already
        # calls returns "Arrived", "EnRoute", "GateClosed"; the WEBHOOK does not,
        # and STATUS_MAP in mcp_server.py would silently map every one of them to
        # "unknown". Nothing decides on it yet. Nothing should start to without
        # reading this line first.
        "item_count": _item_count(parsed) if parsed_json else None,
        "credits_remaining": _credits_remaining(parsed) if parsed_json else None,
        "cost_credits": _attempt(parsed)[0] if parsed_json else None,
        "seq_no": _attempt(parsed)[1] if parsed_json else None,
        # WHETHER A SECRET WAS TAKEN OUT OF THE BODY BELOW. Recorded rather than
        # silent: a reader comparing raw_body against body_bytes deserves to know
        # why they disagree, and a delivery that reports false is one whose body
        # never contained the callback URL at all -- which would itself be news.
        "redacted": redacted,
        # The record of truth, MINUS the callback URL. Everything above it is a
        # convenience derived from this, and every one of those derivations is
        # allowed to be wrong. See _redact for what is removed and why.
        "raw_body": raw_body,
    }


def _delivery_prefix(day: str) -> str:
    return f"deliveries/{day[0:4]}/{day[5:7]}/{day[8:10]}/"


def record_delivery(delivery: dict) -> dict:
    """Write an already-built delivery. One PUT, no read, no precondition."""
    bucket = _bucket()
    if bucket is None:
        return {"ok": False, "error": ERR_NOT_CONFIGURED}

    # Derived from the record's own received_at rather than from the clock, so
    # the key and the object can never name different days.
    try:
        received = datetime.fromisoformat(str(delivery["received_at"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        received = _now()

    key = (f"{_delivery_prefix(received.strftime('%Y-%m-%d'))}"
           f"{int(received.timestamp() * 1000)}-{delivery['delivery_id']}.json")
    try:
        bucket.blob(key).upload_from_string(
            json.dumps(delivery, separators=(",", ":")),
            content_type="application/json",
        )
    except gcs.errors().GoogleAPIError:
        return {"ok": False, "error": ERR_WRITE}
    return {"ok": True, "key": key, "error": None}


def _resolve_day(day):
    if day is None or str(day).strip() == "":
        return _now().strftime("%Y-%m-%d"), None
    s = str(day).strip()
    if not _ISO_DAY_RE.match(s):
        return None, ERR_BAD_DATE
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None, ERR_BAD_DATE
    return s, None


def _summary(delivery: dict) -> dict:
    """Everything but the raw body, which is what makes a listing cheap to read
    and impossible to accidentally dump a megabyte of payload into."""
    return {
        "delivery_id": delivery.get("delivery_id"),
        "received_at": delivery.get("received_at"),
        "body_bytes": delivery.get("body_bytes"),
        "truncated": delivery.get("truncated"),
        "parsed_json": delivery.get("parsed_json"),
        "item_count": delivery.get("item_count"),
        # A LISTING SHOULD SAY WHETHER A RECORD WAS REWRITTEN, without anybody
        # having to fetch the body to find out.
        "redacted": delivery.get("redacted"),
        "credits_remaining": delivery.get("credits_remaining"),
        # WHAT IT COST AND WHICH ATTEMPT IT WAS. Both belong in the SUMMARY
        # rather than only in the raw body: the two questions a listing is opened
        # to answer are what the day spent and whether anything arrived twice,
        # and neither should need a second request per delivery to answer.
        "cost_credits": delivery.get("cost_credits"),
        "seq_no": delivery.get("seq_no"),
    }


def list_deliveries(day=None, limit=DEFAULT_LIST_LIMIT) -> dict:
    bucket = _bucket()
    if bucket is None:
        return {"ok": False, "error": ERR_NOT_CONFIGURED}
    resolved, err = _resolve_day(day)
    if err:
        return {"ok": False, "error": err}
    try:
        capped = max(1, min(MAX_LIST_LIMIT, int(limit)))
    except (TypeError, ValueError):
        capped = DEFAULT_LIST_LIMIT

    try:
        names = [b.name for b in bucket.list_blobs(prefix=_delivery_prefix(resolved))]
    except gcs.errors().GoogleAPIError:
        return {"ok": False, "error": ERR_READ}

    # NEWEST FIRST BY NAME. The key begins with epoch milliseconds, which is
    # fixed width until the year 2286, so a reverse lexical sort is a reverse
    # chronological sort and needs no metadata read.
    names.sort(reverse=True)
    count = len(names)

    items = []
    for name in names[:capped]:
        try:
            items.append(_summary(json.loads(bucket.blob(name).download_as_bytes().decode("utf-8"))))
        except (gcs.errors().GoogleAPIError, ValueError, UnicodeDecodeError):
            # One unreadable object must not hide the rest of the day.
            continue
    return {"ok": True, "day": resolved, "count": count, "deliveries": items, "error": None}


def get_delivery(delivery_id, day=None) -> dict:
    bucket = _bucket()
    if bucket is None:
        return {"ok": False, "error": ERR_NOT_CONFIGURED}
    resolved, err = _resolve_day(day)
    if err:
        return {"ok": False, "error": err}
    # Validated as a UUID before it goes anywhere near a key: it arrives from a
    # URL path and an unvalidated one is a path the caller controls.
    did = str(delivery_id or "").strip()
    if not _UUID_RE.match(did):
        return {"ok": False, "error": ERR_BAD_DELIVERY_ID}

    suffix = f"-{did}.json"
    try:
        match = next(
            (b.name for b in bucket.list_blobs(prefix=_delivery_prefix(resolved))
             if b.name.endswith(suffix)),
            None,
        )
        if match is None:
            return {"ok": False, "error": ERR_NOT_FOUND}
        doc = json.loads(bucket.blob(match).download_as_bytes().decode("utf-8"))
    except gcs.errors().GoogleAPIError:
        return {"ok": False, "error": ERR_READ}
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "error": ERR_READ}
    return {"ok": True, "day": resolved, "delivery": doc, "error": None}
