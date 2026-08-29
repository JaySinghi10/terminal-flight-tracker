"""Everything the alerts feature keeps in Google Cloud Storage.

NOTHING ELSE IN THIS CODEBASE TOUCHES A BUCKET. api.py calls these functions and
mcp_server.py does not know this file exists — provider code and storage code
stay apart, so a change to one cannot break the other.

AUTHENTICATION IS THE RUNTIME SERVICE ACCOUNT'S. storage.Client() picks up
Application Default Credentials, which on Cloud Run is the service's own
identity. There is no key file and no credentials environment variable, and
there must never be one: a key in the image is a key in the repository sooner or
later.

UNCONFIGURED IS A VALID STATE. If ALERTS_BUCKET is unset this module still
imports and every operation returns an error dict rather than raising, so the
service boots and /flight, /route, /quota, /chat and /parse are untouched by a
feature they know nothing about.
"""
import json
import os
import random
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

from google.api_core import exceptions as gcs_exceptions
from google.cloud import storage

ALERTS_BUCKET = (os.getenv("ALERTS_BUCKET") or "").strip()

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
        except gcs_exceptions.GoogleAPIError:
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
        except gcs_exceptions.PreconditionFailed:
            # Somebody else wrote between our read and our write. Re-read and
            # reapply; the backoff is randomised so a collision does not repeat
            # on the same schedule.
            delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (2 ** attempt))
            time.sleep(delay * (0.5 + random.random()))
            continue
        except gcs_exceptions.GoogleAPIError:
            return {"ok": False, "error": ERR_WRITE}

    return {"ok": False, "error": ERR_CONTENTION}


def register_watch(device_id, push_token, platform, flight_number, flight_date):
    """Upsert on (device_id, flight_number, flight_date)."""
    did, err = _clean_device_id(device_id)
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
_CREDIT_KEYS = (
    "credits_remaining", "creditsRemaining", "credits", "balance",
    "remaining_credits", "remainingCredits", "units_remaining", "unitsRemaining",
)


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


def _credits_remaining(parsed):
    if not isinstance(parsed, dict):
        return None
    for key in _CREDIT_KEYS:
        value = parsed.get(key)
        # bool is a subclass of int and True is not a balance.
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    return None


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
        # URL path: the path carries the webhook secret.
        "content_type": headers.get("content-type"),
        "user_agent": headers.get("user-agent"),
        "content_length": content_length,
        "body_bytes": body_bytes,
        "truncated": truncated,
        "parsed_json": parsed_json,
        "item_count": _item_count(parsed) if parsed_json else None,
        "credits_remaining": _credits_remaining(parsed) if parsed_json else None,
        # The record of truth. Everything above it is a convenience derived from
        # this, and every one of those derivations is allowed to be wrong.
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
    except gcs_exceptions.GoogleAPIError:
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
        "credits_remaining": delivery.get("credits_remaining"),
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
    except gcs_exceptions.GoogleAPIError:
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
        except (gcs_exceptions.GoogleAPIError, ValueError, UnicodeDecodeError):
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
    except gcs_exceptions.GoogleAPIError:
        return {"ok": False, "error": ERR_READ}
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "error": ERR_READ}
    return {"ok": True, "day": resolved, "delivery": doc, "error": None}
