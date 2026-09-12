"""The landing-authority tests.

    python test_fr24.py

EVERY TEST HERE IS ONE OF TWO QUESTIONS.

FIRST: does an ambiguous or broken answer get REFUSED rather than reported as a
landing? A wrong landing time is worse than none -- it starts a bag window, sets
a status, and prints a record. The dangerous failure is a confident wrong leg,
not a miss.

SECOND: do the four outcomes stay apart? 'unknown' is the only one that lets
AeroDataBox declare an arrival. If 'error' or 'pending' ever collapses into it,
the landing decision goes straight back to the provider it was taken from, and
nothing about the code would look wrong.

Offline. No token, no network: _fetch is replaced throughout.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr24                                          # noqa: E402
import pollstate                                     # noqa: E402
from airport_icao import icao_for, iata_for          # noqa: E402

FAILURES = []


def check(name, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else "   -> %r" % (detail,)))
    if not ok:
        FAILURES.append(name)


def leg(dest="VOBL", landed="2026-09-06T11:43:00", ended=True,
        reg="VT-NCE", takeoff="2026-09-06T09:15:00", actual=None):
    return {
        "fr24_id": "abc123", "flight": "6E5071", "callsign": "IGO5071",
        "reg": reg, "type": "A20N", "origin_icao": "VABB",
        "destination_icao": dest, "destination_icao_actual": actual,
        "datetime_takeoff": takeoff, "datetime_landed": landed,
        "first_seen": takeoff, "last_seen": landed, "flight_ended": ended,
    }


def with_fetch(legs, reason=None):
    """Replace the network with a fixed answer."""
    fr24.forget_cached()
    fr24._note_success()
    fr24.FR24_API_TOKEN = "test-token-not-real"
    fr24._fetch = lambda params: (legs, reason)


print("-- the map --")
check("BLR resolves to VOBL", icao_for("BLR") == "VOBL", icao_for("BLR"))
check("lowercase resolves too", icao_for("blr") == "VOBL", icao_for("blr"))
check("VABB reverses to BOM", iata_for("VABB") == "BOM", iata_for("VABB"))
check("an unknown code is None, not a guess", icao_for("ZZZ") is None, icao_for("ZZZ"))

print()
print("-- flight_ended arrives in two encodings --")
check("bool true", fr24._ended(True) is True)
check("bool false", fr24._ended(False) is False)
check('string "true"', fr24._ended("true") is True)
# THE ONE THAT MATTERS. Plain truthiness reads this as ended, and an ended leg
# with no landing time is reported as FR24 having LOST the flight -- so the
# wrong reading does not mislabel, it invents a failure.
check('string "false" is NOT truthy-ended', fr24._ended("false") is False, fr24._ended("false"))
check("absent is unknown, not false", fr24._ended(None) is None)

print()
print("-- the search window --")
w = fr24._window("2026-09-06", "2026-09-06T15:20:00Z")
check("a departure instant narrows the window",
      w is not None and w[0] == "2026-09-06T09:20:00" and w[1] == "2026-09-07T11:20:00", w)
w2 = fr24._window("2026-09-06", None)
check("a date alone straddles the previous day",
      w2 is not None and w2[0] == "2026-09-05T12:00:00", w2)
check("no date and no departure is refused", fr24._window(None, None) is None)
check("a malformed date is refused", fr24._window("not-a-date", None) is None)

print()
print("-- picking the leg, which is where a tag flight goes wrong --")
bom_blr, bom_del = leg(dest="VOBL"), leg(dest="VIDP", landed="2026-09-06T14:02:00")
picked, how = fr24._pick([bom_del, bom_blr], "VOBL", None, None)
check("destination selects the right leg of two",
      picked is bom_blr and how == "destination", (picked, how))
picked, how = fr24._pick([bom_del], "VOBL", None, None)
# NO FALLBACK TO THE UNFILTERED LIST. mcp_server refuses that trade on the
# AeroDataBox side and it is refused here: a confident wrong leg is not
# recoverable and a miss is.
check("no destination match returns nothing, never a substitute",
      picked is None and how == "destination", (picked, how))
a, b = leg(reg="VT-AAA"), leg(reg="VT-BBB")
picked, how = fr24._pick([a, b], "VOBL", "vt-bbb", None)
check("registration breaks a tie, case and dashes ignored",
      picked is b and "registration" in how, (picked, how))
picked, how = fr24._pick([], "VOBL", None, None)
check("no legs at all is not a match", picked is None and how is None, (picked, how))

print()
print("-- one field, two spellings, from FR24's own documentation --")
# The Light example on FR24's docs page says destination_icao; the Full example
# on the SAME PAGE says dest_icao. The live Light endpoint sends the second, and
# reading only the first returned "no leg matched the destination" on a leg FR24
# had answered correctly -- a silent, confident wrong answer on the one path
# whose whole job is telling "does not know" from "went somewhere else".
light = {"destination_icao": "VOBL"}
full = {"dest_icao": "VOBL"}
check("the documented Light spelling is read", fr24._destination(light) == "VOBL")
check("the documented Full spelling is read too", fr24._destination(full) == "VOBL")
check("neither present is empty, not a crash", fr24._destination({}) == "")
check("diversion field, both spellings",
      fr24._destination_actual({"dest_icao_actual": "VOMM"}) == "VOMM"
      and fr24._destination_actual({"destination_icao_actual": "VOMM"}) == "VOMM")
alt = dict(leg())
del alt["destination_icao"]
alt["dest_icao"] = "VOBL"
with_fetch([alt])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("and a whole leg in the Full spelling still LANDS",
      r["outcome"] == fr24.LANDED and r["landed_utc"] == "2026-09-06T11:43:00", r)

with_fetch([leg(dest="VIDP")])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a real mismatch now says what it saw",
      r.get("saw_destinations") == ["VIDP"] and r.get("wanted") == "VOBL", r)
with_fetch([{"flight": "6E5071", "datetime_landed": "2026-09-06T11:43:00"}])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("and a renamed field is distinguishable from a wrong airport",
      r.get("saw_destinations") == [] and "flight" in (r.get("saw_fields") or []), r)

print()
print("-- the four outcomes --")
with_fetch([leg()])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a landing is LANDED with its time",
      r["outcome"] == fr24.LANDED and r["landed_utc"] == "2026-09-06T11:43:00", r)
check("and it names the registration and the match",
      r["registration"] == "VT-NCE" and r["match"] == "destination", r)

with_fetch([leg(landed=None, ended=False)])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("still airborne is PENDING, never unknown", r["outcome"] == fr24.PENDING, r)

with_fetch([leg(landed=None, ended=True)])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("ended with no landing time is UNKNOWN", r["outcome"] == fr24.UNKNOWN, r)

with_fetch([])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("no legs returned is UNKNOWN, not an error", r["outcome"] == fr24.UNKNOWN, r)

with_fetch([leg(dest="VIDP")])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a leg to the wrong airport is UNKNOWN, never that leg's landing",
      r["outcome"] == fr24.UNKNOWN and r["landed_utc"] is None, r)

with_fetch(None, "http 401")
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a rejected token is ERROR, which must not read as unknown",
      r["outcome"] == fr24.ERROR, r)

print()
print("-- a landing in the future is not a landing --")
# EK502 REPORTED EXACTLY THIS on the other provider and it is the fault that
# started all of it. The rule is applied to the source brought in to fix it.
soon = (datetime.now(timezone.utc) + timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S")
with_fetch([leg(landed=soon)])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a future touchdown is refused and downgraded to UNKNOWN",
      r["outcome"] == fr24.UNKNOWN and r["landed_utc"] is None, r)

print()
print("-- diversion --")
with_fetch([leg(actual="VOMM")])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("a diversion is reported rather than hidden", r["diverted_to"] == "VOMM", r)
with_fetch([leg(actual="VOBL")])
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("arriving where it was going is not a diversion", r["diverted_to"] is None, r)

print()
print("-- configuration and input --")
fr24.forget_cached()
saved_token = fr24.FR24_API_TOKEN
fr24.FR24_API_TOKEN = ""
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("no token is ERROR, never unknown", r["outcome"] == fr24.ERROR
      and r["reason"] == "not configured", r)
fr24.FR24_API_TOKEN = saved_token
with_fetch([leg()])
check("a junk flight number is refused before any call",
      fr24.landing_for("../etc/passwd")["outcome"] == fr24.ERROR)
check("6E5071 is accepted -- a digit-leading IATA code is the awkward one",
      fr24._FLIGHT_RE.match("6E5071") is not None)

print()
print("-- the previous day's rotation of the same number --")

# ── THE FIRST LIVE POLL RECORDED A FALSE LANDING, AND THIS IS IT ──
#
# 6E6188 BOM->BLR, asked for 2026-09-07. FR24 returned ONE record: takeoff
# 09-06 16:29Z, touchdown 09-06 17:45Z -- yesterday's leg of a daily flight,
# matching on destination because it is the same route every day. The aircraft
# was still at gate 87A in Mumbai, not due out for two hours.
YESTERDAY = leg(dest="VOBL", takeoff="2026-09-06T16:29:02",
                landed="2026-09-06T17:45:37", ended=True)

with_fetch([YESTERDAY])
r = fr24.landing_for("6E6188", date="2026-09-07", destination_iata="BLR")
check("a leg from an earlier day is NOT a landing", r["outcome"] == fr24.UNKNOWN, r)
check("and it says why", "different day" in (r.get("reason") or ""), r)

# THE CALLER'S WAY OUT. With a departure time the window is one leg wide, so
# whatever comes back IS the leg asked for and the guard must not fire.
fr24.forget_cached()
with_fetch([leg(dest="VOBL", takeoff="2026-09-07T09:15:00",
                landed="2026-09-07T11:43:00", ended=True)])
r = fr24.landing_for("6E6188", date="2026-09-07", destination_iata="BLR",
                     departure_utc="2026-09-07T09:15:00")
check("the same day's leg with a departure time IS a landing",
      r["outcome"] == fr24.LANDED, r)

# A GENUINE LATE-UTC DEPARTURE still works when the caller passes the time --
# 00:30 local from Asia really does take off on the previous UTC day.
fr24.forget_cached()
with_fetch([YESTERDAY])
r = fr24.landing_for("6E6188", date="2026-09-07", destination_iata="BLR",
                     departure_utc="2026-09-06T16:29:02")
check("a real previous-UTC-day departure is kept when the time is given",
      r["outcome"] == fr24.LANDED, r)

# And the guard must not fire on a leg from the SAME day.
fr24.forget_cached()
with_fetch([leg(dest="VOBL", takeoff="2026-09-07T09:15:00",
                landed="2026-09-07T11:43:00", ended=True)])
r = fr24.landing_for("6E6188", date="2026-09-07", destination_iata="BLR")
check("a same-day leg with no departure time is still a landing",
      r["outcome"] == fr24.LANDED, r)

print()
print("-- the circuit breaker --")
with_fetch(None, "http 500")
now = datetime.now(timezone.utc)
fr24._note_success()
for _ in range(fr24.BREAKER_THRESHOLD):
    fr24.forget_cached()
    fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("it opens after the threshold", fr24.breaker_status()["open_until"] is not None,
      fr24.breaker_status())
fr24.forget_cached()
calls = []
fr24._fetch = lambda p: (calls.append(1), (None, "http 500"))[1]
r = fr24.landing_for("6E5071", date="2026-09-06", destination_iata="BLR")
check("and then stops calling out entirely", len(calls) == 0, calls)
# FAILS OPEN, NOT CLOSED: an open breaker still answers ERROR, which is the
# outcome that does NOT let AeroDataBox claim a landing. A broken FR24 must not
# quietly restore the behaviour this module replaced.
check("while still reporting ERROR rather than unknown", r["outcome"] == fr24.ERROR, r)
fr24._note_success()

print()
print("-- the cache --")

# ── THE DATE HERE IS RELATIVE TO NOW, AND THAT IS NOT TIDINESS ──
#
# THE SHARED HALF KEEPS A LANDING ONLY WHILE ITS DATE IS INSIDE
# pollstate.KEEP_PAST_DAYS, AND write_runtime APPLIES THAT PRUNE IN THE SAME
# WRITE THAT ADDS THE ENTRY. So a fixture pinned to a fixed past date does not
# merely age: once the clock passes the window the landing is written and
# dropped by that one write, the cold-start read below finds nothing, and the
# test pays for a second fetch.
#
# THAT IS PRECISELY HOW THIS TEST FAILED. It was written against 2026-09-06 and
# passed until the wall clock reached 2026-09-09, three days later, at which
# point it began failing with nothing in fr24.py having changed. A test that
# stops being true on a particular calendar day is not pinning the behaviour it
# names, so the date moves with the clock instead.
#
# YESTERDAY, for two reasons: it is inside the window for any KEEP_PAST_DAYS of
# a day or more, and a landing yesterday is unambiguously in the past, which the
# future-touchdown guard requires as well.
RECENT = datetime.now(timezone.utc) - timedelta(days=1)
RECENT_DAY = RECENT.strftime("%Y-%m-%d")
assert pollstate.KEEP_PAST_DAYS >= 1, pollstate.KEEP_PAST_DAYS


def recent_leg(**over):
    """The same leg, dated inside the retention window.

    THE DEFAULTS ARE BUILT FIRST AND OVERRIDDEN SECOND rather than splatted in
    beside the keywords they replace: the pending case below passes landed=None,
    and a keyword given twice is a TypeError, not an override.
    """
    fields = {"takeoff": RECENT_DAY + "T09:15:00", "landed": RECENT_DAY + "T11:43:00"}
    fields.update(over)
    return leg(**fields)


def ask():
    return fr24.landing_for("6E5071", date=RECENT_DAY, destination_iata="BLR")


calls = []
fr24.forget_cached()
fr24._fetch = lambda p: (calls.append(1), ([recent_leg()], None))[1]
ask()
ask()
check("a known landing is not paid for twice", len(calls) == 1, len(calls))

# ── THE HALF THAT SURVIVES A COLD START ──
#
# THIS IS THE WHOLE REASON THE CACHE MOVED. Cloud Run scales to zero between
# two-minute polls, so the process cache is empty on nearly every poll. Emptying
# _CACHE alone is what a cold start looks like from in here; the landing must
# still be there, and must still cost nothing.
fr24._CACHE.clear()
r = ask()
check("and survives the process dying, which is the point", len(calls) == 1, len(calls))
# AND IT CAME FROM THE SHARED HALF, not merely from nobody having called out.
# Counting fetches alone cannot tell a shared hit from a landing that was never
# stored, which is exactly the confusion that let this test rot unnoticed.
check("and the answer says which half answered", r.get("cached") == "shared", r)

# A PENDING ANSWER MUST NOT BE SHARED. It is a fact about one minute. If it were
# promoted, a flight seen mid-air once would read as mid-air for twelve hours.
fr24.forget_cached()
calls = []
fr24._fetch = lambda p: (calls.append(1), ([recent_leg(landed=None, ended=False)], None))[1]
ask()
fr24._CACHE.clear()
ask()
check("a pending answer is NOT kept across a cold start", len(calls) == 2, len(calls))

# AND FORGETTING CLEARS THE SHARED HALF TOO. With the stale date this passed
# without ever proving anything: there was no shared entry to clear, so the
# refetch it checks for would have happened regardless.
fr24.forget_cached()
calls = []
fr24._fetch = lambda p: (calls.append(1), ([recent_leg()], None))[1]
ask()
fr24._CACHE.clear()
fr24.forget_cached("6E5071")
ask()
check("forgetting one flight clears both halves", len(calls) == 2, len(calls))

print()
print("FAILURES: %d" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
