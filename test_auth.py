"""The refresh-token flow, offline. Google is a fake that answers what each
test tells it to; the store is the in-process one; the key is made here.

WHAT THIS TESTS: that the exchange is posted with the verifier and no secret,
that nothing readable lands in the record, that a session resolves and
evicts, that an expired access token is refreshed and a revoked grant is
forgotten, that sign-out revokes at Google, and that NO token, code or
verifier ever reaches the log.
"""
import base64
import json
import logging
import sys
import time
from datetime import datetime, timedelta, timezone

import auth

PASS = FAIL = 0


def check(label, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   %s" % label)
    else:
        FAIL += 1
        print("  FAIL %s   -> %r" % (label, detail))


# ── THE LOG, CAPTURED FOR THE WHOLE RUN ─────────────────────────────────────
class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


cap = Capture()
auth.logger.addHandler(cap)
auth.logger.setLevel(logging.DEBUG)

# ── FIXTURES ────────────────────────────────────────────────────────────────
KEY = b"\x01" * 32
KEY_PREV = b"\x02" * 32
auth.set_keys_for_tests(KEY)
auth.CLIENT_ID = "123-ios.apps.googleusercontent.com"
NOW = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)

CODE = "4/0AX4XfWh-the-code"
VERIFIER = "the-pkce-verifier-that-must-never-be-logged"
REDIRECT = "com.googleusercontent.apps.123-ios:/oauth2redirect"
REFRESH = "1//0refresh-token-secret-value"
ACCESS = "ya29.access-token-one"
ACCESS2 = "ya29.access-token-two"
SECRETS = (CODE, VERIFIER, REFRESH, ACCESS, ACCESS2)


def id_token(sub="10987654321", email="jay@example.com", given="Jay", aud=None, exp=None):
    payload = {"iss": "https://accounts.google.com", "aud": aud or auth.CLIENT_ID, "sub": sub,
               "email": email, "given_name": given, "exp": exp or int(time.time()) + 3600}
    seg = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return "%s.%s.sig" % (seg({"alg": "RS256"}), seg(payload))


class FakeGoogle:
    """Answers the token endpoint from a script; records every call."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, url, data):
        self.calls.append((url, dict(data)))
        if not self.answers:
            return 500, None
        return self.answers.pop(0)


def ok_exchange(**over):
    body = {"access_token": ACCESS, "expires_in": 3599, "refresh_token": REFRESH,
            "id_token": id_token(), "scope": "openid email profile " + auth.GMAIL_SCOPE,
            "token_type": "Bearer"}
    body.update(over)
    return 200, body


def fresh_store():
    st = auth.MemoryStore()
    auth.set_store_for_tests(st)
    return st


# ── CRYPTO ──────────────────────────────────────────────────────────────────
print("-- the box --")
blob = auth.encrypt("sub1", REFRESH)
check("ciphertext carries the version and no plaintext", blob.startswith("v1.") and REFRESH not in blob, blob[:12])
check("round trip", auth.decrypt("sub1", blob) == REFRESH)
check("another sub cannot open it", auth.decrypt("sub2", blob) is None)
check("a damaged blob is None, not an exception", auth.decrypt("sub1", blob[:-3] + "AAA") is None)
check("an unknown version is None", auth.decrypt("sub1", "v9" + blob[2:]) is None)
check("garbage is None", auth.decrypt("sub1", "hello") is None)
check("two encryptions of the same text differ (fresh nonce)", auth.encrypt("sub1", REFRESH) != blob)
auth.set_keys_for_tests(KEY_PREV)
old_blob = auth.encrypt("sub1", REFRESH).replace("v1.", "v0.", 1)
auth.set_keys_for_tests(KEY, previous=KEY_PREV)
check("a blob under the previous key still opens during rotation", auth.decrypt("sub1", old_blob) == REFRESH)
auth.set_keys_for_tests(KEY)
check("and not once the previous key is gone", auth.decrypt("sub1", old_blob) is None)

# ── SIGN-IN ─────────────────────────────────────────────────────────────────
print("-- sign-in --")
st = fresh_store()
g = FakeGoogle(ok_exchange())
r = auth.sign_in(CODE, VERIFIER, REDIRECT, http=g, now=NOW)
check("ok", r["ok"] is True, r)
check("the session has the shape resolve accepts", r["session"].startswith("t1.") and auth._SESSION_RE.match(r["session"]), r.get("session"))
check("email and first name come back once", r["email"] == "jay@example.com" and r["name"] == "Jay", r)
check("gmail scope reported", r["gmail"] is True)
url, data = g.calls[0]
check("the exchange goes to Google's token endpoint", url == auth.TOKEN_URL)
check("with the code, the verifier, the redirect and the client id", data["code"] == CODE and data["code_verifier"] == VERIFIER
      and data["redirect_uri"] == REDIRECT and data["client_id"] == auth.CLIENT_ID and data["grant_type"] == "authorization_code", data)
check("and no client secret", "client_secret" not in data)

rec, _ = st.read("users/10987654321.json")
raw = st.docs["users/10987654321.json"]
check("one record, keyed by sub", rec is not None and rec["sub"] == "10987654321")
check("neither token is readable in the record", REFRESH not in raw and ACCESS not in raw)
check("both decrypt under the sub", auth.decrypt("10987654321", rec["refresh"]) == REFRESH and auth.decrypt("10987654321", rec["access"]) == ACCESS)
check("no email, no name in the record", "example.com" not in raw and "Jay" not in raw)
check("the expiry is stored", rec["access_expires_at"] == "2026-09-08T12:59:59Z", rec.get("access_expires_at"))
check("scopes recorded", auth.GMAIL_SCOPE in rec["scopes"])
check("the session is stored hashed, not raw", r["session"] not in raw and len(rec["sessions"]) == 1)
check("the session index resolves to the sub", auth.resolve(r["session"]) == "10987654321")
check("the raw session appears in no key", not any(r["session"] in k for k in st.keys()))

print("-- sign-in refusals --")
check("google 400 -> rejected", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle((400, {"error": "invalid_grant"})), now=NOW)["code"] == auth.REJECTED)
check("google unreachable -> unavailable", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle((0, None)), now=NOW)["code"] == auth.UNAVAILABLE)
check("google 503 -> unavailable", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle((503, None)), now=NOW)["code"] == auth.UNAVAILABLE)
check("no refresh token -> no_refresh, nothing stored", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange(refresh_token=None, id_token=id_token(sub="555"))), now=NOW)["code"] == auth.NO_REFRESH
      and st.read("users/555.json")[0] is None)
check("id token for another client -> rejected", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange(id_token=id_token(aud="someone-else"))), now=NOW)["code"] == auth.REJECTED)
check("stale id token -> rejected", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange(id_token=id_token(exp=int(time.time()) - 3600))), now=NOW)["code"] == auth.REJECTED)
check("missing code -> bad_request, and google is not called", auth.sign_in("", VERIFIER, REDIRECT, http=(g2 := FakeGoogle()), now=NOW)["code"] == auth.BAD_REQUEST and g2.calls == [])
check("non-string -> bad_request", auth.sign_in(None, VERIFIER, REDIRECT, http=FakeGoogle(), now=NOW)["code"] == auth.BAD_REQUEST)
saved = auth.CLIENT_ID
auth.CLIENT_ID = ""
check("unconfigured -> unavailable", auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(), now=NOW)["code"] == auth.UNAVAILABLE)
auth.CLIENT_ID = saved

print("-- sessions --")
st = fresh_store()
sessions = []
for i in range(auth.MAX_SESSIONS + 1):
    rr = auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange()), now=NOW + timedelta(minutes=i))
    sessions.append(rr["session"])
rec, _ = st.read("users/10987654321.json")
check("one record after six sign-ins", len(st.keys("users/")) == 1)
check("the cap holds", len(rec["sessions"]) == auth.MAX_SESSIONS)
check("the oldest session is evicted and its index gone", auth.resolve(sessions[0]) is None and len(st.keys("sessions/")) == auth.MAX_SESSIONS)
check("the newest five resolve", all(auth.resolve(s) == "10987654321" for s in sessions[1:]))
check("a malformed session resolves to nothing", auth.resolve("x") is None and auth.resolve(None) is None and auth.resolve("t1." + "a" * 43 + "b") is None)
check("a well-formed unknown session resolves to nothing", auth.resolve("t1." + "A" * 43) is None)

# ── THE ACCESS TOKEN ────────────────────────────────────────────────────────
print("-- the access token for a pull --")
st = fresh_store()
r = auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange()), now=NOW)
S = r["session"]
g = FakeGoogle()
tok, code = auth.access_token(S, http=g, now=NOW + timedelta(minutes=30))
check("a live token is returned without asking google", tok == ACCESS and code is None and g.calls == [], (tok, code, g.calls))
g = FakeGoogle()
tok, code = auth.access_token(S, http=g, now=NOW + timedelta(minutes=59, seconds=30))
check("within the slack of expiry it refreshes", len(g.calls) == 1, g.calls)
g = FakeGoogle((200, {"access_token": ACCESS2, "expires_in": 3600}))
later = NOW + timedelta(hours=2)
tok, code = auth.access_token(S, http=g, now=later)
check("an expired token is refreshed", tok == ACCESS2 and code is None, (tok, code))
url, data = g.calls[0]
check("with the refresh grant, the client id and the decrypted refresh token, no secret",
      url == auth.TOKEN_URL and data["grant_type"] == "refresh_token" and data["refresh_token"] == REFRESH
      and data["client_id"] == auth.CLIENT_ID and "client_secret" not in data, data)
rec, _ = st.read("users/10987654321.json")
check("the new token is stored encrypted with the new expiry", auth.decrypt("10987654321", rec["access"]) == ACCESS2
      and rec["access_expires_at"] == "2026-09-08T15:00:00Z" and ACCESS2 not in st.docs["users/10987654321.json"], rec.get("access_expires_at"))
g = FakeGoogle()
tok, code = auth.access_token(S, http=g, now=later + timedelta(minutes=5))
check("and served from the record next time", tok == ACCESS2 and g.calls == [])

g = FakeGoogle((500, None))
tok, code = auth.access_token(S, http=g, now=later + timedelta(hours=2))
check("google down on refresh -> busy, record kept", tok is None and code == auth.BUSY and st.read("users/10987654321.json")[0] is not None, (tok, code))

g = FakeGoogle((400, {"error": "invalid_grant"}))
tok, code = auth.access_token(S, http=g, now=later + timedelta(hours=2))
check("revoked at google -> expired", tok is None and code == auth.EXPIRED, (tok, code))
check("and the record and every session are forgotten", st.keys() == [], st.keys())
check("the session now resolves to nothing", auth.resolve(S) is None)
check("an unknown session -> expired without a google call", auth.access_token("t1." + "B" * 43, http=(g3 := FakeGoogle()), now=NOW) == (None, auth.EXPIRED) and g3.calls == [])

# ── SIGN-OUT ────────────────────────────────────────────────────────────────
print("-- sign-out --")
st = fresh_store()
a = auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange()), now=NOW)["session"]
b = auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange()), now=NOW)["session"]
g = FakeGoogle((200, {}))
check("sign-out reports something removed", auth.sign_out(a, http=g) is True)
check("google is asked to revoke the refresh token", g.calls and g.calls[0][0] == auth.REVOKE_URL and g.calls[0][1]["token"] == REFRESH, g.calls)
check("the record is gone", st.keys("users/") == [])
check("every session of the account is gone, not just this one", auth.resolve(a) is None and auth.resolve(b) is None and st.keys("sessions/") == [])
check("a second sign-out is a no-op", auth.sign_out(a, http=FakeGoogle()) is False)
check("a garbage session is a no-op", auth.sign_out("nope", http=FakeGoogle()) is False)
g = FakeGoogle((503, None))
c = auth.sign_in(CODE, VERIFIER, REDIRECT, http=FakeGoogle(ok_exchange()), now=NOW)["session"]
check("revocation failing at google still signs out here", auth.sign_out(c, http=g) is True and st.keys() == [])

# ── THE LOG ─────────────────────────────────────────────────────────────────
print("-- the log --")
joined = "\n".join(cap.lines)
check("the log carries codes, not secrets (%d lines)" % len(cap.lines), cap.lines and not any(s in joined for s in SECRETS), [l for l in cap.lines if any(s in l for s in SECRETS)])
check("no session token in the log", not any(s in joined for s in sessions + [S, a, b, c]))

print("\nPASSED: %d   FAILURES: %d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
