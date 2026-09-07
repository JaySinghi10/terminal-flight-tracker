"""What the server knows about a watched flight, and what it knew last time.

── WHY THIS EXISTS SEPARATELY FROM store.py ────────────────────────────────────

store.py holds WHO IS WATCHING WHAT -- one small watches.json that every
registration mutates. This holds WHAT EACH FLIGHT LOOKED LIKE, one object per
flight instance, written by the poller and read by nothing else yet. Putting
them in one file would mean a registration and a poll contending for the same
object, and a poll runs every two minutes.

── ONE OBJECT PER FLIGHT INSTANCE ──────────────────────────────────────────────

state/<number>/<date>.json. The number and the date are separate path segments
for the same reason store.py keeps them separate fields: the provider is asked
by bare number, and a composite key would have to be parsed apart again.

IT HOLDS THE WHOLE DTO, not a summary. A diff that only kept the fields we
thought were interesting could never notice a field becoming interesting, and
the payload is a few kilobytes.

── AND A LEDGER, WHICH IS THE POINT OF STORING ANYTHING AT ALL ─────────────────

`pending` is what changed and has not been sent. `sent` is what has. Dispatch
does not exist yet and that is deliberate: the poller fills the ledger from day
one, so when sending arrives it has real history to work against rather than
being tested for the first time on live notifications.

── THE FR24 RUNTIME IS HERE TOO, AND IT HAD TO MOVE ────────────────────────────

fr24.py kept its circuit breaker in a module global. Cloud Run scales to zero
between two-minute pokes, so every poll started with a fresh process and a
closed breaker -- a rotated or exhausted token would be retried every two
minutes for ever, which is exactly what a breaker exists to prevent. A breaker
that resets on every cold start is not a breaker.
"""
import json
import logging
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone

# THE SDK IS LOADED LAZILY -- see gcs.py for why that is not just tidiness.
import gcs

logger = logging.getLogger("pollstate")

# The same bucket store.py uses. One bucket, several prefixes: watches.json,
# alerts/, and now state/ and runtime/.
BUCKET = (os.getenv("ALERTS_BUCKET") or "").strip()
_client = None

STATE_VERSION = 1
RUNTIME_KEY = "runtime/fr24.json"

WRITE_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 0.15
BACKOFF_MAX_SECONDS = 1.5

# A state object older than this is a flight nobody is watching any more. The
# poller deletes on the same rule store.py prunes watches on, so the two cannot
# disagree about what is live.
KEEP_PAST_DAYS = 3

_NUM_RE = re.compile(r"^[0-9A-Z]{2,8}$")
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def configured() -> bool:
    return bool(BUCKET)


def _bucket():
    global _client
    if not BUCKET:
        return None
    storage = gcs.sdk()
    if storage is None:
        return None
    if _client is None:
        _client = storage.Client()
    return _client.bucket(BUCKET)


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def state_key(number, day):
    """state/<number>/<date>.json, or None if either part is not what it claims.

    VALIDATED BECAUSE IT BECOMES A PATH. A flight number is two to eight
    alphanumerics and a date is a date; anything else could walk out of the
    prefix, and an object key is not a place to find out later.
    """
    n = str(number or "").strip().upper()
    d = str(day or "").strip()
    if not _NUM_RE.match(n) or not _DAY_RE.match(d):
        return None
    return "state/%s/%s.json" % (n, d)


# ── ONE FLIGHT'S STATE ──────────────────────────────────────────────────────
#
# WITHOUT A BUCKET IT FALLS BACK TO THIS PROCESS, exactly as the runtime does.
# Not because a bucket-less deployment is a supported way to run the poller --
# run_once refuses outright -- but because the alternative is a store whose
# writes silently fail after four retries and three seconds of backoff, which is
# a bad thing to have sitting in the codebase whatever the intent.
_local_state = {}


def read_state(number, day):
    """(doc, generation). doc is None when nothing has been written yet."""
    key = state_key(number, day)
    if key is None:
        return None, None
    bucket = _bucket()
    if bucket is None:
        return _local_state.get(key), None
    try:
        blob = bucket.get_blob(key)
    except gcs.errors().GoogleAPIError:
        return None, None
    if blob is None:
        return None, None
    try:
        return json.loads(blob.download_as_bytes().decode("utf-8")), blob.generation
    except (ValueError, UnicodeDecodeError, gcs.errors().GoogleAPIError):
        # A CORRUPT OBJECT IS TREATED AS ABSENT, not as an error to propagate.
        # The next write replaces it, and a poll that refused to run because one
        # flight's state would not parse would take every other flight with it.
        return None, None


def write_state(number, day, doc, generation):
    """Write with a precondition. False means somebody else got there first.

    THE SAME ARGUMENT store.py MAKES FOR watches.json, for the same reason:
    several Cloud Run instances can be polling and a plain read-modify-write
    would silently lose one. generation None means "must not already exist".
    """
    key = state_key(number, day)
    if key is None:
        return False
    doc = dict(doc)
    doc["version"] = STATE_VERSION
    doc["updated_at"] = _iso(_now())
    bucket = _bucket()
    if bucket is None:
        _local_state[key] = doc
        return True
    try:
        bucket.blob(key).upload_from_string(
            json.dumps(doc, separators=(",", ":")),
            content_type="application/json",
            if_generation_match=0 if generation is None else generation,
        )
        return True
    except gcs.errors().PreconditionFailed:
        return False
    except gcs.errors().GoogleAPIError:
        return False


def mutate_state(number, day, apply_fn):
    """Read, apply, write, retry on contention. apply_fn(doc or None) -> doc.

    Returning None from apply_fn writes nothing, which is how a poll that
    decides a flight is not due costs no write at all.
    """
    for attempt in range(WRITE_ATTEMPTS):
        doc, gen = read_state(number, day)
        new = apply_fn(doc)
        if new is None:
            return True
        if write_state(number, day, new, gen):
            return True
        delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (2 ** attempt))
        time.sleep(delay * (0.5 + random.random()))
    return False


def forget_local():
    """Drop the in-process fallback. For tests, and for nothing else."""
    global _local_runtime
    _local_state.clear()
    _local_runtime = None
    _runtime_cache.update({"at": 0.0, "doc": None, "gen": None})


def blank_state(number, day):
    return {
        "version": STATE_VERSION,
        "flight_number": str(number).upper(),
        "flight_date": day,
        # The last DTO AeroDataBox returned, whole.
        "dto": None,
        # What Flightradar24 last said about the landing.
        "landing": None,
        # When each provider was last asked, so the tiers can be enforced
        # without a second store.
        "last_adb_at": None,
        "last_fr24_at": None,
        "adb_polls": 0,
        "fr24_polls": 0,
        # WHAT CHANGED AND HAS NOT BEEN SENT. Dispatch does not exist; this
        # fills anyway. See the note at the top of the file.
        "pending": [],
        "sent": [],
    }


def delete_state(number, day):
    key = state_key(number, day)
    if key is None:
        return
    bucket = _bucket()
    if bucket is None:
        _local_state.pop(key, None)
        return
    try:
        bucket.blob(key).delete()
    except gcs.errors().GoogleAPIError:
        pass


# ── THE FR24 RUNTIME, SHARED ACROSS INSTANCES ───────────────────────────────
#
# READ ONCE PER POLL AND CACHED IN PROCESS FOR A FEW SECONDS. A GCS read per
# landing call would put a network round trip in front of every flight; a poll
# is one pass over the watchlist and the breaker cannot meaningfully change
# inside it.
_RUNTIME_TTL = 20.0
_runtime_cache = {"at": 0.0, "doc": None, "gen": None}

# ── WITHOUT A BUCKET IT FALLS BACK TO THIS PROCESS, NOT TO NOTHING ──────────
#
# A DEPLOYMENT WITH NO ALERTS_BUCKET STILL NEEDS A BREAKER. If an unconfigured
# store simply refused every write, fr24.py would count to four failures, write
# the count nowhere, read zero back, and call a dead provider for ever -- worse
# than the module global this replaced, not better.
#
# SO THE DEGRADED MODE IS THE OLD BEHAVIOUR: per-process, lost on a cold start,
# not shared between instances. That is what breaker_status()["shared"] reports,
# and it is why it says False rather than staying silent about it.
_local_runtime = None


def _empty_runtime():
    return {"breaker": {"failures": 0, "open_until": None}, "landings": {},
            "quota": {"remaining": None, "at": None}}


def read_quota():
    """(units_remaining, measured_at) as last observed by ANY instance.

    THE PROVIDER'S UNIT COUNT ARRIVES ON A RESPONSE HEADER, so a process that
    has made no call does not know it. On Cloud Run that is nearly every
    process: it scales to zero between pokes, so a budget floor read from
    process memory would be None at the start of almost every poll and would
    never once engage. The same cold-start problem the breaker had, with the
    same fix.

    IT IS AT MOST ONE POLL STALE, which is the right precision for a floor
    measured in hundreds of units.
    """
    doc, _ = read_runtime()
    q = doc.get("quota") or {}
    at = q.get("at")
    if q.get("remaining") is None or not at:
        return None, None
    try:
        return int(q["remaining"]), datetime.fromisoformat(at)
    except (ValueError, TypeError):
        return None, None


def note_quota(remaining, at=None):
    """Record a freshly observed unit count, if it is newer than the stored one."""
    if remaining is None:
        return
    at = at or _now()

    def apply(doc):
        q = doc.get("quota") or {}
        prev = q.get("at")
        if prev:
            try:
                if datetime.fromisoformat(prev) >= at:
                    return None
            except (ValueError, TypeError):
                pass
        doc["quota"] = {"remaining": int(remaining), "at": _iso(at)}
        return doc
    mutate_runtime(apply)


def read_runtime(force=False):
    """(doc, generation) for the shared FR24 runtime."""
    now = time.time()
    if not force and _runtime_cache["doc"] is not None \
            and now - _runtime_cache["at"] < _RUNTIME_TTL:
        return _runtime_cache["doc"], _runtime_cache["gen"]
    bucket = _bucket()
    if bucket is None:
        global _local_runtime
        if _local_runtime is None:
            _local_runtime = _empty_runtime()
        return _local_runtime, None
    try:
        blob = bucket.get_blob(RUNTIME_KEY)
        if blob is None:
            doc, gen = _empty_runtime(), None
        else:
            doc = json.loads(blob.download_as_bytes().decode("utf-8"))
            gen = blob.generation
    except (gcs.errors().GoogleAPIError, ValueError, UnicodeDecodeError):
        return _empty_runtime(), None
    if not isinstance(doc, dict):
        doc, gen = _empty_runtime(), None
    doc.setdefault("breaker", {"failures": 0, "open_until": None})
    doc.setdefault("landings", {})
    doc.setdefault("quota", {"remaining": None, "at": None})
    _runtime_cache.update({"at": now, "doc": doc, "gen": gen})
    return doc, gen


def write_runtime(doc, generation):
    global _local_runtime
    # A LANDING IS IMMUTABLE BUT NOT ETERNAL. Entries are dropped once their
    # flight date is behind the keep window, so this object cannot grow without
    # bound on a service that never restarts it. DONE BEFORE THE BUCKET CHECK,
    # because a process holding the fallback runtime lives just as long.
    cutoff = (_now() - timedelta(days=KEEP_PAST_DAYS)).strftime("%Y-%m-%d")
    doc["landings"] = {k: v for k, v in (doc.get("landings") or {}).items()
                       if str(v.get("day") or "9999") >= cutoff}
    bucket = _bucket()
    if bucket is None:
        _local_runtime = doc
        return True
    try:
        bucket.blob(RUNTIME_KEY).upload_from_string(
            json.dumps(doc, separators=(",", ":")),
            content_type="application/json",
            if_generation_match=0 if generation is None else generation,
        )
        _runtime_cache.update({"at": 0.0, "doc": None, "gen": None})
        return True
    except gcs.errors().PreconditionFailed:
        _runtime_cache.update({"at": 0.0, "doc": None, "gen": None})
        return False
    except gcs.errors().GoogleAPIError:
        return False


def mutate_runtime(apply_fn):
    """Read, apply, write, retry. apply_fn(doc) -> doc or None."""
    for attempt in range(WRITE_ATTEMPTS):
        doc, gen = read_runtime(force=(attempt > 0))
        new = apply_fn(json.loads(json.dumps(doc)))
        if new is None:
            return True
        if write_runtime(new, gen):
            return True
        time.sleep(BACKOFF_BASE_SECONDS * (2 ** attempt) * (0.5 + random.random()))
    return False


# ── THE AERODATABOX BUDGET, AND THE DAY IT REFILLS ──────────────────────────
#
# IT RESETS ON THE BILLING DATE, THE 7th, MONTHLY -- not on the 1st, and the
# difference matters: on the 6th the allowance is nearly spent and on the 8th it
# is nearly whole, so a floor that assumed calendar months would be wrong for
# three weeks out of four.
BILLING_DAY = 7

# What the poller refuses to spend below, per day still to go. Twenty flights
# with three arrivals cost roughly seventy units a day, so this leaves the
# arrival tier able to run while stopping the cheap tiers from eating the month.
RESERVE_PER_DAY = 40


def days_until_reset(now=None):
    """Whole days from now to the next billing date."""
    now = now or _now()
    year, month = now.year, now.month
    if now.day < BILLING_DAY:
        nxt = datetime(year, month, BILLING_DAY, tzinfo=timezone.utc)
    else:
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        nxt = datetime(year, month, BILLING_DAY, tzinfo=timezone.utc)
    return max(1, (nxt - now).days + (1 if (nxt - now).seconds else 0))


def budget_floor(now=None):
    """Units that must remain untouched by anything but an arrival."""
    return RESERVE_PER_DAY * days_until_reset(now)


# ── ONE PASS AT A TIME ──────────────────────────────────────────────────────
#
# A LOCK IN A PROCESS WOULD NOT BE A LOCK. Cloud Run may be running several
# instances and Cloud Scheduler pokes an URL, not an instance -- so two pokes
# can land on two processes that share nothing but the bucket. Both would read
# the same state, both would find the same flights due, and both would pay.
#
# IT IS AN OBJECT WITH A PRECONDITION, NOT A FLAG. if_generation_match=0 means
# "create this, and fail if it already exists", which is decided by the storage
# service rather than by whoever read last -- the same mechanism watches.json
# uses, applied to a different question.
#
# AND IT EXPIRES, because the alternative is one crashed instance stopping every
# poll for ever. A lock older than its TTL is taken from underneath whoever left
# it, and the log says so: a lock that keeps needing to be broken means passes
# are running longer than the TTL, which is a real problem worth seeing.

def take_lock(key, ttl_seconds):
    """True if this caller now holds the lock."""
    bucket = _bucket()
    if bucket is None:
        # NO BUCKET MEANS ONE INSTANCE AND NO CONTENTION TO RESOLVE. Refusing
        # here would make the poller untestable and unrunnable locally to guard
        # against a race that cannot occur.
        return True

    blob = bucket.blob(key)
    try:
        blob.upload_from_string(
            _iso(_now()), content_type="text/plain", if_generation_match=0)
        return True
    except gcs.errors().PreconditionFailed:
        pass
    except gcs.errors().GoogleAPIError:
        # A LOCK WE CANNOT TAKE BECAUSE STORAGE IS UNREACHABLE IS A NO. The pass
        # would fail on its first read anyway, and proceeding would risk running
        # alongside another instance that did get the lock.
        return False

    # Held by somebody. Is it stale?
    try:
        existing = bucket.get_blob(key)
        if existing is None:
            # Released between our write failing and this read. The next poke
            # gets it; one skipped pass is cheaper than a second race.
            return False
        held = _parse_instant_or_none(existing.download_as_bytes())
        if held is None or (_now() - held).total_seconds() < ttl_seconds:
            return False
        logger.warning(
            "poll lock held since %s, past its %ds ttl -- breaking it. "
            "A pass is running longer than the ttl allows.", held, ttl_seconds)
        existing.delete(if_generation_match=existing.generation)
        blob.upload_from_string(
            _iso(_now()), content_type="text/plain", if_generation_match=0)
        return True
    except gcs.errors().GoogleAPIError:
        return False


def release_lock(key):
    bucket = _bucket()
    if bucket is None:
        return
    try:
        bucket.blob(key).delete()
    except gcs.errors().GoogleAPIError:
        # AN UNRELEASED LOCK IS NOT A CRISIS -- the TTL above collects it. This
        # is why the TTL exists rather than trusting the release path.
        pass


def _parse_instant_or_none(raw):
    try:
        return datetime.fromisoformat(raw.decode("utf-8").strip())
    except (ValueError, AttributeError, UnicodeDecodeError):
        return None
