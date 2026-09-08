"""Google sign-in with a refresh token, kept on the server.

WHAT THIS IS. The app signs in with Google using the authorization code flow
and PKCE, and it never exchanges the code itself: it posts the code, the PKCE
verifier and the redirect URI here. This module exchanges them with Google,
keeps the refresh token, and hands the app an opaque session token. From then
on a Gmail pull carries the session, and this module produces a Google access
token for it, minting a fresh one with the refresh grant when the current one
has expired.

NO CLIENT SECRET, AND THAT IS CORRECT. The app signs in as Google's iOS client
type, which Google issues no secret for -- it is a public client, and a secret
compiled into an app is not a secret. PKCE is the binding instead: the code is
useless without the verifier, which only the app and this server ever see.
Google issues refresh tokens to installed-app clients on exactly this exchange.

WHERE THE RECORD LIVES. Cloud Storage, one object per Google account at
users/<sub>.json, written with generation preconditions exactly as watches.json
and the poll state are. One writer per record (the person's own sign-in), no
query ever crosses records, and a lookup is by key -- the two things a database
would add are absent, so none is added. Without a bucket this falls back to
this process, as pollstate does, so the tests need no cloud.

WHAT THE RECORD HOLDS, AND DOES NOT. The Google account id (sub), the refresh
token and the current access token both ENCRYPTED, the access token's expiry,
the scopes Google granted, and the hashes of live sessions. NOT the email, NOT
a name: the app already has those, from the id token this module reads once
and passes back. The record is the first thing on the server tied to a person,
and the privacy policy says so.

HOW THE TOKENS ARE PROTECTED. AES-256-GCM with a key that reaches the process
from Secret Manager as TOKEN_KEY. Fresh nonce per encryption; the sub is bound
in as associated data so a ciphertext lifted from one record cannot be decrypted
under another; a version prefix on the ciphertext so the key can be rotated by
adding TOKEN_KEY_PREVIOUS and re-encrypting on next use. The bucket's own
at-rest encryption protects the disk; this protects against reading the bucket.

THE SESSION. 32 random bytes, shown to the app once. The server keeps only its
SHA-256: an index object sessions/<hash>.json naming the sub, and the hash in
the record so sign-out revokes every session at once. Five per account, oldest
evicted.

NOTHING IN THIS FILE LOGS A TOKEN, A CODE OR A VERIFIER. Log lines carry codes
and counts, the way gmail_flights.py's do.
"""
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import gcs

logger = logging.getLogger("auth")

# ── CONFIGURATION ───────────────────────────────────────────────────────────
BUCKET = (os.getenv("ALERTS_BUCKET") or "").strip()
CLIENT_ID = (os.getenv("GOOGLE_IOS_CLIENT_ID") or "").strip()
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

USERS_PREFIX = "users/"
SESSIONS_PREFIX = "sessions/"
RECORD_VERSION = 1
MAX_SESSIONS = 5
# An access token this close to expiry is refreshed before use, so a pull that
# takes a minute cannot start with a live token and end with a dead one.
REFRESH_SLACK_SECONDS = 60
SESSION_PREFIX = "t1."
HTTP_TIMEOUT = 10
WRITE_ATTEMPTS = 5

# ── OUTCOME CODES ───────────────────────────────────────────────────────────
# The app switches on these; api.py maps them to fixed sentences.
BAD_REQUEST = "auth_bad_request"      # missing or malformed code / verifier / uri
REJECTED = "auth_rejected"            # Google refused the exchange
NO_REFRESH = "auth_no_refresh"        # Google issued no refresh token: sign in again
UNAVAILABLE = "auth_unavailable"      # not configured, or Google unreachable
# For the pull path these are gmail_flights' own codes, so the app's handling
# of an expired sign-in is one branch, not two.
EXPIRED = "gmail_expired"
BUSY = "gmail_busy"

_SUB_RE = re.compile(r"^[0-9]{1,64}$")
_SESSION_RE = re.compile(r"^t1\.[A-Za-z0-9_-]{43}$")


class AuthError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


# ── THE KEY ─────────────────────────────────────────────────────────────────
def _load_key(raw):
    """32 bytes from base64 (standard or urlsafe), or None."""
    if not raw:
        return None
    s = raw.strip()
    try:
        b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (ValueError, TypeError):
        try:
            b = base64.b64decode(s + "=" * (-len(s) % 4))
        except (ValueError, TypeError):
            return None
    return b if len(b) == 32 else None


_KEYS = None


def _keys():
    """{version: key}. The current key is "1"; a previous one, during a
    rotation, is "0". Loaded once, from the environment, never logged."""
    global _KEYS
    if _KEYS is None:
        cur = _load_key(os.getenv("TOKEN_KEY"))
        prev = _load_key(os.getenv("TOKEN_KEY_PREVIOUS"))
        _KEYS = {}
        if cur is not None:
            _KEYS["1"] = cur
        if prev is not None:
            _KEYS["0"] = prev
    return _KEYS


def set_keys_for_tests(current, previous=None):
    global _KEYS
    _KEYS = {"1": current}
    if previous is not None:
        _KEYS["0"] = previous


def configured():
    return bool(CLIENT_ID) and "1" in _keys()


def encrypt(sub, text):
    """'v1.<nonce>.<ciphertext>', both base64url without padding."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = _keys().get("1")
    if key is None:
        raise AuthError(UNAVAILABLE)
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, text.encode("utf-8"), sub.encode("utf-8"))
    b64 = lambda b: base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")
    return "v1.%s.%s" % (b64(nonce), b64(ct))


def decrypt(sub, blob):
    """The text, or None: wrong key, wrong sub, damaged, or not ours."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    try:
        ver, n, c = str(blob).split(".")
        if not ver.startswith("v"):
            return None
        key = _keys().get(ver[1:])
        if key is None:
            return None
        unb64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        return AESGCM(key).decrypt(unb64(n), unb64(c), sub.encode("utf-8")).decode("utf-8")
    except Exception:
        return None


# ── THE STORE ───────────────────────────────────────────────────────────────
class MemoryStore:
    """The in-process fallback, and what the tests run against. The same
    generation contract as the bucket: None means 'must not exist'."""

    def __init__(self):
        self.docs = {}
        self.gens = {}
        self._counter = 0

    def read(self, key):
        if key not in self.docs:
            return None, None
        return json.loads(self.docs[key]), self.gens[key]

    def write(self, key, doc, generation):
        exists = key in self.docs
        if generation is None and exists:
            return False
        if generation is not None and self.gens.get(key) != generation:
            return False
        self._counter += 1
        self.docs[key] = json.dumps(doc, separators=(",", ":"))
        self.gens[key] = self._counter
        return True

    def delete(self, key):
        self.docs.pop(key, None)
        self.gens.pop(key, None)

    def keys(self, prefix=""):
        return sorted(k for k in self.docs if k.startswith(prefix))


class GcsStore:
    def __init__(self, bucket):
        self.bucket = bucket

    def read(self, key):
        try:
            blob = self.bucket.get_blob(key)
            if blob is None:
                return None, None
            return json.loads(blob.download_as_bytes().decode("utf-8")), blob.generation
        except (ValueError, UnicodeDecodeError, gcs.errors().GoogleAPIError):
            return None, None

    def write(self, key, doc, generation):
        try:
            self.bucket.blob(key).upload_from_string(
                json.dumps(doc, separators=(",", ":")),
                content_type="application/json",
                if_generation_match=0 if generation is None else generation,
            )
            return True
        except gcs.errors().PreconditionFailed:
            return False
        except gcs.errors().GoogleAPIError:
            return False

    def delete(self, key):
        try:
            self.bucket.blob(key).delete()
        except gcs.errors().GoogleAPIError:
            # Includes NotFound. A delete of what is not there has succeeded.
            pass


_store_instance = None
_client = None


def _store():
    global _store_instance, _client
    if _store_instance is not None:
        return _store_instance
    storage = gcs.sdk() if BUCKET else None
    if storage is None:
        _store_instance = MemoryStore()
        if BUCKET:
            logger.warning("auth: bucket configured but the storage SDK is unavailable; in-process store")
    else:
        if _client is None:
            _client = storage.Client()
        _store_instance = GcsStore(_client.bucket(BUCKET))
    return _store_instance


def set_store_for_tests(store):
    global _store_instance
    _store_instance = store


def _mutate(key, apply_fn):
    """Read, apply, write with the generation, retry on contention.
    apply_fn(doc or None) -> doc, or None to write nothing. Returns the doc
    written, or None."""
    st = _store()
    for attempt in range(WRITE_ATTEMPTS):
        doc, gen = st.read(key)
        new = apply_fn(doc)
        if new is None:
            return None
        if st.write(key, new, gen):
            return new
        time.sleep(0.05 * (attempt + 1))
    logger.warning("auth: write contention gave up")
    return None


# ── GOOGLE ──────────────────────────────────────────────────────────────────
def _http_post(url, data):
    """(status, json or None). The one place a request leaves; injectable."""
    import requests
    try:
        r = requests.post(url, data=data, timeout=HTTP_TIMEOUT)
    except requests.RequestException:
        return 0, None
    try:
        body = r.json()
    except ValueError:
        body = None
    return r.status_code, body


def _id_token_claims(id_token):
    """The claims of an id token that came straight from Google's token
    endpoint, over TLS, in our own request. Its signature is NOT verified here,
    and that is deliberate: verification defends against a token presented by
    a third party, and this one was never in anyone else's hands. What IS
    checked is that it is for us and not stale."""
    try:
        seg = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))
    except Exception:
        return None
    if claims.get("iss") not in GOOGLE_ISSUERS:
        return None
    if claims.get("aud") != CLIENT_ID:
        return None
    if not isinstance(claims.get("sub"), str) or not _SUB_RE.match(claims["sub"]):
        return None
    try:
        if int(claims.get("exp", 0)) < time.time() - 300:
            return None
    except (TypeError, ValueError):
        return None
    return claims


def exchange_code(code, verifier, redirect_uri, http=None):
    """The token response from Google, or AuthError."""
    http = http or _http_post
    status, body = http(TOKEN_URL, {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
    })
    if status == 200 and isinstance(body, dict) and body.get("access_token"):
        return body
    if status in (400, 401):
        logger.info("auth: google refused the code (%s)", (body or {}).get("error") if isinstance(body, dict) else status)
        raise AuthError(REJECTED)
    logger.warning("auth: token endpoint unavailable (%s)", status)
    raise AuthError(UNAVAILABLE)


def _refresh(refresh_token, http):
    """(access_token, expires_in) or AuthError(EXPIRED | BUSY)."""
    status, body = http(TOKEN_URL, {
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    })
    if status == 200 and isinstance(body, dict) and body.get("access_token"):
        try:
            ttl = int(body.get("expires_in") or 3600)
        except (TypeError, ValueError):
            ttl = 3600
        return body["access_token"], ttl
    if status in (400, 401):
        # invalid_grant: the person revoked us at Google, or the token is
        # otherwise dead. Nothing this server can do brings it back.
        logger.info("auth: refresh refused (%s)", (body or {}).get("error") if isinstance(body, dict) else status)
        raise AuthError(EXPIRED)
    logger.warning("auth: refresh unavailable (%s)", status)
    raise AuthError(BUSY)


def _revoke(token, http):
    """Best effort. Google revokes the whole grant given either token."""
    try:
        status, _ = http(REVOKE_URL, {"token": token})
        return status == 200
    except Exception:
        return False


# ── SESSIONS ────────────────────────────────────────────────────────────────
def _new_session():
    return SESSION_PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def _session_hash(session):
    return hashlib.sha256(session.encode("ascii")).hexdigest()


def _user_key(sub):
    return USERS_PREFIX + sub + ".json"


def _session_key(h):
    return SESSIONS_PREFIX + h + ".json"


def resolve(session):
    """The sub a session names, or None."""
    if not isinstance(session, str) or not _SESSION_RE.match(session):
        return None
    doc, _ = _store().read(_session_key(_session_hash(session)))
    if not doc:
        return None
    sub = doc.get("sub")
    return sub if isinstance(sub, str) and _SUB_RE.match(sub) else None


def _first_name(email, claims):
    given = claims.get("given_name")
    if isinstance(given, str) and given.strip():
        return given.strip()
    m = re.match(r"^[a-zA-Z]+", (email or "").split("@")[0])
    return m.group(0) if m else "user"


# ── SIGN-IN ─────────────────────────────────────────────────────────────────
def sign_in(code, verifier, redirect_uri, http=None, now=None):
    """{'ok': True, 'session', 'email', 'name'} or {'ok': False, 'code'}."""
    if not configured():
        return {"ok": False, "code": UNAVAILABLE}
    if not all(isinstance(x, str) and 0 < len(x) <= 2048 for x in (code, verifier, redirect_uri)):
        return {"ok": False, "code": BAD_REQUEST}
    http = http or _http_post
    now = now or _now()
    try:
        tok = exchange_code(code, verifier, redirect_uri, http)
    except AuthError as e:
        return {"ok": False, "code": e.code}

    claims = _id_token_claims(tok.get("id_token") or "")
    if claims is None:
        logger.warning("auth: exchange succeeded but the id token was not for us")
        return {"ok": False, "code": REJECTED}
    refresh = tok.get("refresh_token")
    if not isinstance(refresh, str) or not refresh:
        # prompt=consent normally guarantees one. Without it the sign-in is
        # worthless to this design, so it is refused rather than half-kept.
        logger.info("auth: no refresh token in the exchange")
        return {"ok": False, "code": NO_REFRESH}

    sub = claims["sub"]
    email = claims.get("email") if isinstance(claims.get("email"), str) else None
    scopes = sorted(set((tok.get("scope") or "").split()))
    try:
        ttl = int(tok.get("expires_in") or 3600)
    except (TypeError, ValueError):
        ttl = 3600
    session = _new_session()
    h = _session_hash(session)

    evicted = []

    def apply(doc):
        rec = doc if isinstance(doc, dict) and doc.get("sub") == sub else {
            "version": RECORD_VERSION, "sub": sub, "created_at": _iso(now), "sessions": []}
        rec["version"] = RECORD_VERSION
        rec["refresh"] = encrypt(sub, refresh)
        rec["access"] = encrypt(sub, tok["access_token"])
        rec["access_expires_at"] = _iso(now + timedelta(seconds=ttl))
        rec["scopes"] = scopes
        rec["last_used_at"] = _iso(now)
        sessions = [s for s in rec.get("sessions", []) if isinstance(s, str)] + [h]
        evicted[:] = sessions[:-MAX_SESSIONS]
        rec["sessions"] = sessions[-MAX_SESSIONS:]
        return rec

    if _mutate(_user_key(sub), apply) is None:
        return {"ok": False, "code": UNAVAILABLE}
    st = _store()
    st.write(_session_key(h), {"sub": sub, "created_at": _iso(now)}, None)
    for old in evicted:
        st.delete(_session_key(old))
    logger.info("auth: signed in (gmail scope %s, sessions evicted %d)",
                "yes" if GMAIL_SCOPE in scopes else "NO", len(evicted))
    return {"ok": True, "session": session, "email": email,
            "name": _first_name(email, claims), "gmail": GMAIL_SCOPE in scopes}


# ── THE ACCESS TOKEN FOR A PULL ─────────────────────────────────────────────
def access_token(session, http=None, now=None):
    """(token, None) or (None, code). code is one of gmail_flights' codes."""
    http = http or _http_post
    now = now or _now()
    sub = resolve(session)
    if sub is None:
        return None, EXPIRED
    st = _store()
    rec, _ = st.read(_user_key(sub))
    if not isinstance(rec, dict):
        return None, EXPIRED

    exp = _parse_iso(rec.get("access_expires_at"))
    if exp is not None and (exp - now).total_seconds() > REFRESH_SLACK_SECONDS:
        tok = decrypt(sub, rec.get("access") or "")
        if tok:
            return tok, None

    refresh = decrypt(sub, rec.get("refresh") or "")
    if not refresh:
        return None, EXPIRED
    try:
        tok, ttl = _refresh(refresh, http)
    except AuthError as e:
        if e.code == EXPIRED:
            # Revoked at Google. The record is dead weight and the sessions
            # would only ever answer "expired" again: forget the lot, so the
            # next sign-in starts clean.
            _forget(sub, rec)
        return None, e.code

    def apply(doc):
        if not isinstance(doc, dict):
            return None
        doc["access"] = encrypt(sub, tok)
        doc["access_expires_at"] = _iso(now + timedelta(seconds=ttl))
        doc["last_used_at"] = _iso(now)
        return doc

    _mutate(_user_key(sub), apply)
    return tok, None


def _forget(sub, rec):
    st = _store()
    for h in (rec or {}).get("sessions", []) or []:
        if isinstance(h, str):
            st.delete(_session_key(h))
    st.delete(_user_key(sub))


# ── SIGN-OUT ────────────────────────────────────────────────────────────────
def sign_out(session, http=None):
    """Every session gone, the record gone, and the grant revoked at Google
    so 'disconnect' is true from Google's side too. Idempotent; True when
    there was something to remove."""
    http = http or _http_post
    sub = resolve(session)
    if sub is None:
        return False
    rec, _ = _store().read(_user_key(sub))
    if isinstance(rec, dict):
        refresh = decrypt(sub, rec.get("refresh") or "")
        if refresh:
            _revoke(refresh, http)
    _forget(sub, rec if isinstance(rec, dict) else {"sessions": [_session_hash(session)]})
    logger.info("auth: signed out")
    return True
