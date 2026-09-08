"""Push every fixture through gmail_flights with the REAL model.

Gmail is replaced -- the lister returns the fixture names and the fetch reads
the .eml files -- but extraction is the deployed code path end to end:
decode_body, the JSON-LD pass, the gate, the model call, the re-check, the
merge. Model calls are counted and each fixture reports what came out of it
and by which method.

Runs against today's real date, so a fixture dated in the past is dropped
exactly as it would be for a user.
"""
import base64
import glob
import io
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

import gmail_flights as g  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(HERE, "*.eml")))
only = sys.argv[1:]  # optional substrings to select fixtures
if only:
    files = [f for f in files if any(o in os.path.basename(f) for o in only)]

today = datetime.now(timezone.utc).date()
calls = []


def fetch(token, name):
    with open(name, "rb") as f:
        return g.decode_body(base64.urlsafe_b64encode(f.read()).decode().rstrip("="))


def extract(m, today_):
    calls.append(m["subject"])
    return g.extract_with_model(m, today_)


print("today %s | model %s" % (today, g.llm.PARSE_MODEL))
print()

# ── ONE AT A TIME, so each fixture's result is its own ──────────────────────
for path in files:
    name = os.path.basename(path)
    m = fetch(None, path)
    gate = g.worth_a_model_call(m)
    print("=" * 78)
    print(name)
    print("  subject   : %s" % m["subject"])
    print("  received  : %s | body %d chars | json-ld legs %d | gate %s"
          % (m["received"], len(m["body"]), len(m["jsonld"]), "PASS" if gate else "blocked"))
    before = len(calls)
    r = g.upcoming_flights("tok", today, fetch=fetch, extract=extract, lister=lambda t, d: ([path], g.OK))
    print("  model calls: %d" % (len(calls) - before))
    if not r["flights"]:
        print("  -> nothing extracted")
    for leg in r["flights"]:
        where = "%s -> %s" % (leg["origin"] or leg["origin_name"], leg["destination"] or leg["destination_name"])
        extra = []
        if leg["operating_flight_number"]:
            extra.append("operated as " + leg["operating_flight_number"])
        elif leg["operated_by"]:
            extra.append("operated by " + leg["operated_by"])
        print("  -> %-7s %s %s  %-14s pnr %-7s conf %.2f  [%s]%s"
              % (leg["flight_number"], leg["date"], leg["departure_time"] or "--:--", where,
                 leg["pnr"] or "-", leg["confidence"], leg["method"],
                 ("  " + ", ".join(extra)) if extra else ""))

# ── ALL TOGETHER, which is what a real inbox is: the dedupe across emails ───
print()
print("=" * 78)
print("ALL FIXTURES AS ONE INBOX")
before = len(calls)
r = g.upcoming_flights("tok", today, fetch=fetch, extract=extract, lister=lambda t, d: (files, g.OK))
print("  scanned %d | structured %d | sent to model %d | upcoming legs %d"
      % (r["scanned"], r["structured"], r["extracted"], len(r["flights"])))
for leg in r["flights"]:
    print("  %-7s %s  %-4s -> %-4s  pnr %-7s [%s]" % (
        leg["flight_number"], leg["date"], leg["origin"] or "?", leg["destination"] or "?",
        leg["pnr"] or "-", leg["method"]))
print()
print("total model calls this run: %d" % len(calls))
