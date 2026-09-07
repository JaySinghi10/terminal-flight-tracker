"""The poller, offline. No bucket, no provider, no credits spent.

WHAT THIS IS ACTUALLY TESTING is the two decisions that cost money -- which tier
a flight is in, and whether it is due -- and the one that will eventually wake
somebody's phone at 3am, which is what counts as a change. Everything else in
poller.py is plumbing between those three.
"""
import sys
from datetime import datetime, timedelta, timezone

import fr24
import poller
import pollstate

PASS = FAIL = 0


def check(label, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   %s" % label)
    else:
        FAIL += 1
        print("  FAIL %s   -> %r" % (label, detail))


NOW = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def dto(dep_sched=None, dep_actual=None, arr_sched=None, arr_actual=None,
        arr_est=None, status="Scheduled", gate=None, belt=None, terminal=None,
        arr_gate=None, iata="BLR"):
    return {
        "flight_number": "6E5071", "flight_date": "2026-09-07",
        "status": status,
        "departure": {"iata": "BOM", "gate": gate, "terminal": terminal,
                      "scheduled_iso": dep_sched, "actual_iso": dep_actual,
                      "estimated_iso": None},
        "arrival": {"iata": iata, "gate": arr_gate, "terminal": None,
                    "scheduled_iso": arr_sched, "actual_iso": arr_actual,
                    "estimated_iso": arr_est, "baggage": belt},
    }


def state(**kw):
    d = pollstate.blank_state("6E5071", "2026-09-07")
    d.update(kw)
    return d


# ── TIERS ───────────────────────────────────────────────────────────────────
print("-- which tier --")

check("a flight we have never fetched is NEAR, not FAR",
      poller.tier_for(None, NOW) == poller.NEAR, poller.tier_for(None, NOW))

check("ten hours out is FAR",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW + timedelta(hours=10)),
                                    arr_sched=iso(NOW + timedelta(hours=13)))),
                      NOW) == poller.FAR)

check("three hours out is DAY",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW + timedelta(hours=3)),
                                    arr_sched=iso(NOW + timedelta(hours=6)))),
                      NOW) == poller.DAY)

check("an hour out is NEAR",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW + timedelta(hours=1)),
                                    arr_sched=iso(NOW + timedelta(hours=4)))),
                      NOW) == poller.NEAR)

check("departed with three hours to run is AIRBORNE",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW - timedelta(hours=1)),
                                    dep_actual=iso(NOW - timedelta(hours=1)),
                                    arr_sched=iso(NOW + timedelta(hours=3)))),
                      NOW) == poller.AIRBORNE)

check("twenty minutes from landing is ARRIVAL",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW - timedelta(hours=3)),
                                    dep_actual=iso(NOW - timedelta(hours=3)),
                                    arr_sched=iso(NOW + timedelta(minutes=20)))),
                      NOW) == poller.ARRIVAL)

# ── THE ONE THE SCHEDULE ALONE WOULD GET WRONG ──
#
# A flight running two hours late, scheduled to land twenty minutes from now.
# On the SCHEDULED time it is in the ARRIVAL tier and would be polled every two
# minutes for the next two and a half hours. On the ESTIMATED time it is not.
check("a delayed flight is tiered on its estimate, not its schedule",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW - timedelta(hours=3)),
                                    dep_actual=iso(NOW - timedelta(hours=3)),
                                    arr_sched=iso(NOW + timedelta(minutes=20)),
                                    arr_est=iso(NOW + timedelta(hours=2, minutes=20)))),
                      NOW) == poller.AIRBORNE,
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW - timedelta(hours=3)),
                                    dep_actual=iso(NOW - timedelta(hours=3)),
                                    arr_sched=iso(NOW + timedelta(minutes=20)),
                                    arr_est=iso(NOW + timedelta(hours=2, minutes=20)))),
                      NOW))

print()
print("-- when to stop --")

landed = {"outcome": fr24.LANDED, "landed_utc": iso(NOW - timedelta(minutes=20))}

# ── THE MOST IMPORTANT ONE IN THIS FILE ──
#
# Touchdown is NOT the end. The belt and the arrival gate are published after
# it, and they are the part somebody standing in the terminal actually needs.
check("landed but not yet at a gate keeps polling",
      poller.tier_for(state(landing=landed,
                            dto=dto(dep_actual=iso(NOW - timedelta(hours=3)),
                                    arr_sched=iso(NOW - timedelta(minutes=20)))),
                      NOW) != poller.DONE)

check("landed AND at a gate is DONE",
      poller.tier_for(state(landing=landed,
                            dto=dto(dep_actual=iso(NOW - timedelta(hours=3)),
                                    arr_sched=iso(NOW - timedelta(minutes=20)),
                                    arr_actual=iso(NOW - timedelta(minutes=5)))),
                      NOW) == poller.DONE)

check("cancelled is DONE",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW + timedelta(hours=2)),
                                    arr_sched=iso(NOW + timedelta(hours=5)),
                                    status="canceled")),
                      NOW) == poller.DONE)

check("three hours past arrival with no landing gives up",
      poller.tier_for(state(dto=dto(dep_actual=iso(NOW - timedelta(hours=8)),
                                    arr_sched=iso(NOW - timedelta(hours=4)))),
                      NOW) == poller.DONE)

check("but two hours past arrival is still watched",
      poller.tier_for(state(dto=dto(dep_actual=iso(NOW - timedelta(hours=6)),
                                    arr_sched=iso(NOW - timedelta(hours=2)))),
                      NOW) != poller.DONE)

print()
print("-- is it due --")

fresh = state(dto=dto(dep_sched=iso(NOW + timedelta(hours=10)),
                      arr_sched=iso(NOW + timedelta(hours=13))),
              last_adb_at=iso(NOW - timedelta(minutes=30)))
check("a FAR flight asked 30 minutes ago is not due",
      not poller._due(fresh, poller.FAR, NOW, "last_adb_at"))
check("the same flight in the ARRIVAL tier would be",
      poller._due(fresh, poller.ARRIVAL, NOW, "last_adb_at"))
check("never asked is always due",
      poller._due(state(), poller.FAR, NOW, "last_adb_at"))
check("DONE is never due", not poller._due(state(), poller.DONE, NOW, "last_adb_at"))

print()
print("-- what counts as a change --")

base = dto(gate="A12", arr_sched=iso(NOW + timedelta(hours=3)))

check("the first sighting is not a change",
      poller.diff(None, base) == [], poller.diff(None, base))
check("nothing changing is no change", poller.diff(base, base) == [])

moved = dto(gate="B4", arr_sched=iso(NOW + timedelta(hours=3)))
d = poller.diff(base, moved)
check("a gate change is one change", len(d) == 1 and d[0]["field"] == "departure_gate", d)
check("and it carries both sides", d[0]["from"] == "A12" and d[0]["to"] == "B4", d)

belt = dto(gate="A12", arr_sched=iso(NOW + timedelta(hours=3)), belt="7")
check("a belt appearing is a change",
      [c["field"] for c in poller.diff(base, belt)] == ["baggage_belt"],
      poller.diff(base, belt))

# ── NOISE ──
#
# An estimated time recomputed upstream drifts by a minute or two between polls.
# Recording that would bury the slip that matters under a hundred that do not.
jitter_a = dto(arr_sched=iso(NOW + timedelta(hours=3)),
               arr_est=iso(NOW + timedelta(hours=3)))
jitter_b = dto(arr_sched=iso(NOW + timedelta(hours=3)),
               arr_est=iso(NOW + timedelta(hours=3, minutes=2)))
check("a two-minute drift in the estimate is not a change",
      poller.diff(jitter_a, jitter_b) == [], poller.diff(jitter_a, jitter_b))

slip = dto(arr_sched=iso(NOW + timedelta(hours=3)),
           arr_est=iso(NOW + timedelta(hours=3, minutes=40)))
check("a forty-minute slip is",
      [c["field"] for c in poller.diff(jitter_a, slip)] == ["arrival_estimated"],
      poller.diff(jitter_a, slip))

# AN ACTUAL TIME IS NEVER NOISE. It is published once and it is the event.
act_a = dto(arr_sched=iso(NOW + timedelta(hours=3)))
act_b = dto(arr_sched=iso(NOW + timedelta(hours=3)), arr_actual=iso(NOW))
check("an actual arrival appearing is always a change",
      [c["field"] for c in poller.diff(act_a, act_b)] == ["arrival_actual"],
      poller.diff(act_a, act_b))

print()
print("-- one flight, end to end --")

pollstate.forget_local()
fr24.forget_cached()

calls = {"adb": 0, "fr24": 0}
FIXED = [dto(gate="A12", dep_sched=iso(NOW + timedelta(minutes=45)),
             arr_sched=iso(NOW + timedelta(hours=3)))]


def fake_fetch(number, date=None, origin=None, max_age=None):
    calls["adb"] += 1
    return ("text", FIXED[0])


poller.fetch_flight_full = fake_fetch
fr24.landing_for = lambda *a, **k: (calls.__setitem__("fr24", calls["fr24"] + 1),
                                    {"outcome": fr24.UNKNOWN})[1]

r = poller.poll_one("6E5071", "2026-09-07", now=NOW)
check("the first poll fetches", calls["adb"] == 1 and r["adb"], (calls, r))
check("and records no change, because there was nothing to compare to",
      r["changes"] == [], r)
check("it is NEAR -- 45 minutes to departure", r["tier"] == poller.NEAR, r["tier"])
check("FR24 is not asked before wheels-up", calls["fr24"] == 0, calls)

# Immediately again: the NEAR interval is five minutes, so nothing is due.
r2 = poller.poll_one("6E5071", "2026-09-07", now=NOW + timedelta(minutes=1))
check("a second poll one minute later costs nothing",
      calls["adb"] == 1 and not r2["adb"], (calls, r2))
check("and says why", r2.get("skipped") == "not due", r2)

# Six minutes on, with a new gate.
FIXED[0] = dto(gate="B4", dep_sched=iso(NOW + timedelta(minutes=45)),
               arr_sched=iso(NOW + timedelta(hours=3)))
r3 = poller.poll_one("6E5071", "2026-09-07", now=NOW + timedelta(minutes=6))
check("six minutes on it fetches again", calls["adb"] == 2, calls)
check("and sees the gate move",
      [c["field"] for c in r3["changes"]] == ["departure_gate"], r3["changes"])

doc, _ = pollstate.read_state("6E5071", "2026-09-07")
check("the change is on the ledger", len(doc["pending"]) == 1, doc["pending"])
check("nothing has been sent", doc["sent"] == [], doc["sent"])
check("the DTO was stored whole", doc["dto"]["departure"]["gate"] == "B4")

print()
print("-- the budget floor --")

pollstate.forget_local()
far = state(dto=dto(dep_sched=iso(NOW + timedelta(hours=10)),
                    arr_sched=iso(NOW + timedelta(hours=13))))
pollstate.write_state("6E5071", "2026-09-07", far, None)
before = calls["adb"]
r = poller.poll_one("6E5071", "2026-09-07", now=NOW, budget_ok=False)
check("below the floor a FAR flight is not polled",
      calls["adb"] == before and r.get("skipped") == "budget floor", r)

pollstate.forget_local()
arriving = state(dto=dto(dep_actual=iso(NOW - timedelta(hours=3)),
                         arr_sched=iso(NOW + timedelta(minutes=20))))
pollstate.write_state("6E5071", "2026-09-07", arriving, None)
before = calls["adb"]
r = poller.poll_one("6E5071", "2026-09-07", now=NOW, budget_ok=False)
check("but an arriving one still is, with the last unit in the account",
      calls["adb"] == before + 1 and r["tier"] == poller.ARRIVAL, r)

print()
print("-- the caps --")

pollstate.forget_local()
spend = {"adb": poller.MAX_ADB_CALLS_PER_RUN, "fr24": 0}
before = calls["adb"]
r = poller.poll_one("6E5071", "2026-09-07", now=NOW, spend=spend)
check("at the per-run cap it stops calling",
      calls["adb"] == before and "cap" in str(r.get("skipped")), r)

print()
print("-- a provider that is down --")

pollstate.forget_local()


def boom(number, date=None, origin=None, max_age=None):
    raise RuntimeError("provider on fire")


poller.fetch_flight_full = boom
r = poller.poll_one("6E5071", "2026-09-07", now=NOW)
check("a failing provider does not raise", r.get("adb_error") is not None, r)
doc, _ = pollstate.read_state("6E5071", "2026-09-07")
# WITHOUT THIS the flight stays permanently due and the next poke retries every
# flight at once, turning one outage into a spend spike.
check("the attempt is still recorded", doc.get("last_adb_at") is not None, doc)
check("and no DTO was invented", doc.get("dto") is None, doc)

print()
print("-- a departure that has not happened yet --")

# ── STRAIGHT FROM THE FIRST LIVE POLL ──
#
# 6E6188 BOM->BLR: AeroDataBox returned status EnRoute, delay 0, and
# departure.actual_iso set to a time TWO HOURS AND TWENTY MINUTES IN THE
# FUTURE, source "revised". The aircraft was at gate 87A. Believing that
# actual put it in the AIRBORNE tier, which asks FR24 whether it has landed.
future_actual = dto(dep_sched=iso(NOW + timedelta(hours=2, minutes=20)),
                    dep_actual=iso(NOW + timedelta(hours=2, minutes=20)),
                    arr_sched=iso(NOW + timedelta(hours=4, minutes=15)),
                    status="active")
check("an actual departure in the future does not mean departed",
      not poller._has_departed(future_actual, NOW))
# Two hours and twenty minutes out, so DAY. The point is that it is not
# AIRBORNE, which is the tier that spends an FR24 credit asking whether a
# flight sitting at its gate has landed.
check("so the flight is not in a tier that asks FR24",
      poller.tier_for(state(dto=future_actual), NOW) not in poller.FR24_TIERS,
      poller.tier_for(state(dto=future_actual), NOW))
check("it is DAY -- 2h20m to departure",
      poller.tier_for(state(dto=future_actual), NOW) == poller.DAY)

check("an actual departure in the past does mean departed",
      poller._has_departed(dto(dep_actual=iso(NOW - timedelta(minutes=5))), NOW))

# "EnRoute" is the same claim in different clothes when the flight is not due
# out for two hours.
enroute_early = dto(dep_sched=iso(NOW + timedelta(hours=2)),
                    arr_sched=iso(NOW + timedelta(hours=5)), status="enroute")
check("EnRoute before the scheduled departure is not believed either",
      not poller._has_departed(enroute_early, NOW))
enroute_late = dto(dep_sched=iso(NOW - timedelta(minutes=30)),
                   arr_sched=iso(NOW + timedelta(hours=2)), status="enroute")
check("EnRoute after the scheduled time is believed",
      poller._has_departed(enroute_late, NOW))

# ── AND THE CONSEQUENCE THAT MATTERED ──
pollstate.forget_local()
asked = {"n": 0}
poller.fetch_flight_full = lambda number, date=None, origin=None, max_age=None: ("t", future_actual)
fr24.landing_for = lambda *a, **k: (asked.__setitem__("n", asked["n"] + 1),
                                    {"outcome": fr24.LANDED,
                                     "landed_utc": "2026-09-06T17:45:37"})[1]
r = poller.poll_one("6E6188", "2026-09-07", now=NOW)
check("FR24 is never asked about a flight still on the ground",
      asked["n"] == 0, asked)
check("so no landing can be recorded for it",
      not any(c["field"] == "landed" for c in r["changes"]), r["changes"])

print()
print("-- the departure time is passed to FR24 --")

# WITHOUT IT fr24 searches a two-day window and can return yesterday's leg.
pollstate.forget_local()
seen = {}
flown = dto(dep_sched=iso(NOW - timedelta(hours=3)),
            dep_actual=iso(NOW - timedelta(hours=3)),
            arr_sched=iso(NOW + timedelta(minutes=20)))
poller.fetch_flight_full = lambda number, date=None, origin=None, max_age=None: ("t", flown)
def capture(number, date=None, destination_iata=None, departure_utc=None, **k):
    seen.update({"date": date, "dest": destination_iata, "dep": departure_utc})
    return {"outcome": fr24.PENDING}
fr24.landing_for = capture
# SEEDED, BECAUSE THE TIER IS READ FROM STORED STATE BEFORE ANYTHING IS
# FETCHED. On a flight's very first poll there is no DTO, so it is NEAR and
# FR24 is not asked -- which is exactly what the first live poll did (9
# AeroDataBox calls, 0 FR24) before the second one found it airborne.
pollstate.write_state("6E6188", "2026-09-07", state(dto=flown), None)
poller.poll_one("6E6188", "2026-09-07", now=NOW + timedelta(minutes=3))
check("the poller sends departure_utc, which narrows the window to one leg",
      seen.get("dep") == iso(NOW - timedelta(hours=3)), seen)
check("and the destination, which separates the legs of a tag flight",
      seen.get("dest") == "BLR", seen)

print()
print("-- a flight we have no data for --")

# ── THE CASE THAT WOULD HAVE EMPTIED THE MONTH ──
#
# Nine of the eighteen flights on the live watchlist are dated before today.
# A provider that no longer carries a two-day-old flight returns nothing for
# ever; tiered NEAR, each would be asked every five minutes indefinitely.
check("a past-dated flight with no data is DONE, not NEAR",
      poller.tier_for(None, NOW, day="2026-09-05") == poller.DONE,
      poller.tier_for(None, NOW, day="2026-09-05"))
check("yesterday too",
      poller.tier_for(None, NOW, day="2026-09-06") == poller.DONE)
check("today with no data is NEAR -- it may be about to happen",
      poller.tier_for(None, NOW, day="2026-09-07") == poller.NEAR)
check("two days out is DAY",
      poller.tier_for(None, NOW, day="2026-09-09") == poller.DAY)
check("nineteen days out is DISTANT",
      poller.tier_for(None, NOW, day="2026-09-26") == poller.DISTANT)
check("no date at all falls back to NEAR",
      poller.tier_for(None, NOW, day=None) == poller.NEAR)
check("an unparseable date does too, rather than being dropped",
      poller.tier_for(None, NOW, day="not-a-date") == poller.NEAR)

# A flight far enough out that its own DTO says DISTANT.
check("a DTO three weeks out is DISTANT as well",
      poller.tier_for(state(dto=dto(dep_sched=iso(NOW + timedelta(days=19)),
                                    arr_sched=iso(NOW + timedelta(days=19, hours=3)))),
                      NOW) == poller.DISTANT)

print()
print("-- backing off a number that never resolves --")

near = state(dto=None, last_adb_at=iso(NOW - timedelta(minutes=6)))
check("with no misses, a NEAR flight is due after 5 minutes",
      poller._due(near, poller.NEAR, NOW, "last_adb_at", 0))
check("after 3 misses it is not -- the interval is now 40 minutes",
      not poller._due(near, poller.NEAR, NOW, "last_adb_at", 3))
check("after 3 misses it IS due once 40 minutes have passed",
      poller._due(state(last_adb_at=iso(NOW - timedelta(minutes=41))),
                  poller.NEAR, NOW, "last_adb_at", 3))
# THE CAP IS WHAT STOPS A LONG-DEAD WATCH DRIFTING TO NEVER.
check("the backoff caps at six hours however many misses",
      poller._due(state(last_adb_at=iso(NOW - timedelta(hours=6, minutes=1))),
                  poller.NEAR, NOW, "last_adb_at", 40))
check("and not before",
      not poller._due(state(last_adb_at=iso(NOW - timedelta(hours=5))),
                      poller.NEAR, NOW, "last_adb_at", 40))

# End to end: a number the provider does not know.
pollstate.forget_local()
misses = {"n": 0}


def never_found(number, date=None, origin=None, max_age=None):
    misses["n"] += 1
    return ("No flight found.", None)


poller.fetch_flight_full = never_found
t = NOW
for _ in range(30):
    poller.poll_one("MOK645", "2026-09-07", now=t)
    t += timedelta(minutes=5)
# Thirty five-minute ticks is two and a half hours. Unbacked-off that is 30
# calls; backed off it is a handful.
check("30 five-minute ticks on a dead number cost far fewer than 30 calls",
      misses["n"] <= 8, misses["n"])
doc, _ = pollstate.read_state("MOK645", "2026-09-07")
# FOUR CALLS IN TWO AND A HALF HOURS: at 0, +10, +30, +70 minutes as the
# interval doubles past the five-minute tier. Unbacked-off it would be thirty.
check("and the misses are counted", doc.get("adb_misses", 0) == 4, doc.get("adb_misses"))

# ── AND IT IS A BACKOFF, NOT A GIVING-UP ──
FOUND = dto(dep_sched=iso(NOW + timedelta(hours=2)),
            arr_sched=iso(NOW + timedelta(hours=5)))


def found_now(number, date=None, origin=None, max_age=None):
    return ("text", FOUND)


poller.fetch_flight_full = found_now
poller.poll_one("MOK645", "2026-09-07", now=t + timedelta(hours=7))
doc, _ = pollstate.read_state("MOK645", "2026-09-07")
check("one good answer clears the backoff completely",
      doc.get("adb_misses") == 0 and doc.get("dto") is not None,
      doc.get("adb_misses"))

print()
print("-- a whole pass --")

pollstate.forget_local()
fr24.forget_cached()
poller.fetch_flight_full = fake_fetch
calls["adb"] = calls["fr24"] = 0

# Four flights in four tiers, plus one nobody should touch.
WATCH = [
    {"flight_number": "AI101", "flight_date": "2026-09-07", "devices": [{}]},
    {"flight_number": "BA202", "flight_date": "2026-09-07", "devices": [{}, {}]},
    {"flight_number": "EK303", "flight_date": "2026-09-07", "devices": [{}]},
    {"flight_number": "LH404", "flight_date": "2026-09-07", "devices": [{}]},
]
poller.store.watched_flights = lambda: list(WATCH)
pollstate.configured = lambda: True

SHAPES = {
    "AI101": dto(dep_sched=iso(NOW + timedelta(hours=10)),
                 arr_sched=iso(NOW + timedelta(hours=13))),
    "BA202": dto(dep_sched=iso(NOW + timedelta(hours=3)),
                 arr_sched=iso(NOW + timedelta(hours=6))),
    "EK303": dto(dep_actual=iso(NOW - timedelta(hours=3)),
                 arr_sched=iso(NOW + timedelta(minutes=20))),
    # Landed and at a gate: DONE, and must cost nothing at all.
    "LH404": dto(dep_actual=iso(NOW - timedelta(hours=6)),
                 arr_sched=iso(NOW - timedelta(hours=1)),
                 arr_actual=iso(NOW - timedelta(minutes=50))),
}
for num, shape in SHAPES.items():
    st = pollstate.blank_state(num, "2026-09-07")
    st["dto"] = shape
    if num == "LH404":
        st["landing"] = {"outcome": fr24.LANDED,
                         "landed_utc": iso(NOW - timedelta(hours=1))}
    pollstate.write_state(num, "2026-09-07", st, None)


def by_number(number, date=None, origin=None, max_age=None):
    calls["adb"] += 1
    return ("text", SHAPES[number])


poller.fetch_flight_full = by_number
out = poller.run_once(now=NOW)

check("the pass reports itself ok", out.get("ok") is True, out)
check("it saw four flights", out["flights"] == 4, out["flights"])
check("the tiers are what the states say",
      out["tiers"] == {poller.FAR: 1, poller.DAY: 1,
                       poller.ARRIVAL: 1, poller.DONE: 1},
      out["tiers"])
# ── THE DONE FLIGHT IS THE POINT OF THE TIERS ──
# Three calls, not four: a flight that has landed and reached its gate is never
# asked about again, however long it stays on somebody's watchlist.
check("a DONE flight costs nothing", out["adb_calls"] == 3, out["adb_calls"])
check("only the arriving one asked FR24", out["fr24_calls"] == 1, out["fr24_calls"])
check("nothing changed on a first sighting of each",
      out["flights_changed"] == 0, out)

# A second pass immediately: every interval is longer than zero, so nothing is
# due and the whole pass is free.
before = calls["adb"]
out2 = poller.run_once(now=NOW + timedelta(seconds=30))
check("a pass 30 seconds later spends nothing",
      out2["adb_calls"] == 0 and calls["adb"] == before, out2)

# Three minutes on, the ARRIVAL flight alone is due -- and its gate has moved.
SHAPES["EK303"] = dto(dep_actual=iso(NOW - timedelta(hours=3)),
                      arr_sched=iso(NOW + timedelta(minutes=20)),
                      arr_gate="C21")
out3 = poller.run_once(now=NOW + timedelta(minutes=3))
check("three minutes on, only the arriving flight is polled",
      out3["adb_calls"] == 1, out3["adb_calls"])
check("and its gate change is reported",
      len(out3["changes"]) == 1
      and out3["changes"][0]["changes"][0]["field"] == "arrival_gate",
      out3["changes"])

check("an unreadable watch store is not a clean pass",
      poller.run_once.__doc__ is not None)
poller.store.watched_flights = lambda: None
bad = poller.run_once(now=NOW)
check("it refuses rather than reporting zero flights",
      bad.get("ok") is False and "unreadable" in bad.get("error", ""), bad)

print()
print("PASSED: %d   FAILURES: %d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
