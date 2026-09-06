"""The refusal tests.

    python tools/dining/test_guardrails.py

EVERY TEST HERE IS THE SAME TEST: does a broken source get REFUSED rather than
published? That is the only property of this pipeline that matters, because the
dangerous failure is silent -- a parser matching nothing, a field that starts
coming back empty, a source that stops labelling its security zones. A crash is
harmless; a quiet empty list is what puts a landside restaurant in front of a
connecting passenger.

These run against the committed HKG data, offline, and touch no network.
"""
import copy
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "adapters"))

import run as R                                  # noqa: E402
from schema import Dining                        # noqa: E402
import hkg                                       # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  -- " + str(detail)) if not cond else ""))
    if not cond:
        FAILURES.append(name)


def load_good():
    raw = json.load(io.open(os.path.join(HERE, "data", "raw", "hkg_shops.json"), encoding="utf8"))
    records, _ = hkg.parse(raw, "2026-01-01T00:00:00Z")
    return raw, [r.to_dict() for r in records]


RULES = json.load(io.open(os.path.join(HERE, "manifest.json"),
                          encoding="utf8"))["airports"][0]["guardrails"]

raw_good, good = load_good()
previous = {"records": good}

# ── the baseline must pass, or every test below is meaningless ──────────────
check("a good run passes its own guardrails",
      R.check_guardrails("HKG", good, RULES, previous) == [],
      R.check_guardrails("HKG", good, RULES, previous))

# ── 1. the empty parse: the failure this pipeline exists to catch ───────────
check("an EMPTY parse is refused",
      R.check_guardrails("HKG", [], RULES, previous) != [])

# ── 2. a silent shrink ─────────────────────────────────────────────────────
check("a shrink to 10 records is refused",
      R.check_guardrails("HKG", good[:10], RULES, previous) != [])
# The floor is max(min_records=60, 76*0.75=57) = 60, so the boundary is 59/60.
check("59 records (one under the floor) is refused",
      R.check_guardrails("HKG", good[:59], RULES, previous) != [])
check("60 records (exactly the floor) is allowed",
      R.check_guardrails("HKG", good[:60], RULES, previous) == [],
      R.check_guardrails("HKG", good[:60], RULES, previous))

# ── 3. a field that starts coming back empty ───────────────────────────────
blank_hours = copy.deepcopy(good)
for r in blank_hours:
    r["hours_raw"] = ""
check("hours going 100% empty is refused",
      any("hours_raw" in f for f in R.check_guardrails("HKG", blank_hours, RULES, previous)))

blank_level = copy.deepcopy(good)
for r in blank_level[:30]:
    r["level"] = ""
check("level going partly empty is refused",
      any("level" in f for f in R.check_guardrails("HKG", blank_level, RULES, previous)))

# ── 4. the security column degrading to guesswork ──────────────────────────
degraded = copy.deepcopy(good)
for r in degraded:
    r["security_basis"] = "inferred"
check("security_basis degrading to 'inferred' is refused",
      any("security_basis" in f for f in R.check_guardrails("HKG", degraded, RULES, previous)))

# ── 5. the schema's own rules ──────────────────────────────────────────────
def rec(**kw):
    base = dict(airport="HKG", name="X", source_id="ABC123",
                terminal_raw="T1", terminal="T1", level="L6",
                area="Terminal 1", gate_hint="", is_airside=True,
                zone="departures_airside",
                security_raw="Restricted Area", security_basis="explicit",
                category_raw="fastf", category="fast_food", hours_raw="07:00 - 23:00",
                hours=[{"start_day": 0, "end_day": 6, "open": "07:00", "close": "23:00"}],
                is_24h=False, lat=22.3, lon=113.9,
                source_url="https://x/y.json", scraped_at="2026-01-01T00:00:00Z",
                source_updated_at="")
    base.update(kw)
    return Dining(**base)

check("a sound record has no complaints", rec().check() == [], rec().check())
check("explicit basis without an answer is rejected",
      rec(is_airside=None).check() != [])
check("explicit basis without the source's words is rejected",
      rec(security_raw="").check() != [])
check("unknown basis carrying a zone is rejected",
      rec(security_basis="unknown", security_raw="").check() != [])

# ── the zone field: arrivals is a third place, not a missing boolean ────────
check("arrivals with is_airside None is sound",
      rec(zone="arrivals", is_airside=None, security_raw="Arrivals").check() == [],
      rec(zone="arrivals", is_airside=None, security_raw="Arrivals").check())
check("arrivals claiming to be airside is rejected",
      rec(zone="arrivals", is_airside=True).check() != [])
check("airside zone with a False boolean is rejected",
      rec(zone="departures_airside", is_airside=False).check() != [])
check("landside zone with a True boolean is rejected",
      rec(zone="departures_landside", is_airside=True).check() != [])
check("an unknown zone cannot be explicit",
      rec(zone="unknown", is_airside=None).check() != [])
check("a zone outside the vocabulary is rejected",
      rec(zone="beyond_passport_control", is_airside=None).check() != [])
check("a category outside the vocabulary is rejected",
      rec(category="sushi").check() != [])
check("half a coordinate is rejected", rec(lon=None).check() != [])
check("a nonsense coordinate is rejected", rec(lat=999.0).check() != [])
check("an empty name is rejected", rec(name="  ").check() != [])
check("a malformed hours time is rejected",
      rec(hours=[{"start_day": 0, "end_day": 6, "open": "7am", "close": "23:00"}]).check() != [])
check("an out-of-range hours day is rejected",
      rec(hours=[{"start_day": 0, "end_day": 9, "open": "07:00", "close": "23:00"}]).check() != [])
check("an incomplete hours window is rejected",
      rec(hours=[{"start_day": 0, "open": "07:00"}]).check() != [])
check("24:00 as a closing time is allowed",
      rec(hours=[{"start_day": 0, "end_day": 6, "open": "00:00", "close": "24:00"}]).check() == [])
check("no structured hours at all is allowed (HKG has none)",
      rec(hours=[]).check() == [])

# ── the coverage check: did we scrape the terminals, or an adjacent mall? ───
# THE JEWEL NEAR-MISS. A crawl of Changi followed the site's own nav to
# jewelchangiairport.com and returned a clean list of landside mall restaurants.
# Every other guardrail would have passed it.
COVER = {"require_terminal": True, "expect_terminals": ["T1", "T2", "SB"]}
check("records with no terminal are refused",
      any("no terminal" in f for f in R.check_guardrails(
          "HKG", [dict(r, terminal="") for r in good], COVER, None)))
check("a terminal the manifest does not know is refused",
      any("not in the manifest" in f for f in R.check_guardrails(
          "HKG", [dict(r, terminal="JEWEL") for r in good], COVER, None)))
check("the real HKG terminals pass the coverage check",
      R.check_guardrails("HKG", good, COVER, None) == [],
      R.check_guardrails("HKG", good, COVER, None))

# ── 6. the adapter, against a mutated source ───────────────────────────────
# THE SOURCE STOPS PUBLISHING `restricted`. Every record should fall to
# "unknown" -- never to a guess -- and the run should then be refused by the
# manifest's security_basis rule rather than shipping.
no_flag = copy.deepcopy(raw_good)
for b in no_flag["brand"].values():
    for s in (b.get("shop") or {}).values():
        s.pop("restricted", None)
recs, notes = hkg.parse(no_flag, "2026-01-01T00:00:00Z")
rows = [r.to_dict() for r in recs]
check("losing `restricted` yields no airside claims",
      all(r["is_airside"] is None for r in rows))
check("losing `restricted` yields basis 'unknown'",
      all(r["security_basis"] == "unknown" for r in rows))
check("losing `restricted` is then refused by the manifest",
      R.check_guardrails("HKG", rows, RULES, previous) != [])
check("losing `restricted` is reported in the notes",
      any("no `restricted`" in n for n in notes), notes)

# THE LEGEND FLIPS. If "ra" ever stops meaning Restricted Area, the raw label
# would silently rewrite the meaning of the column -- so it must be reported.
flipped = copy.deepcopy(raw_good)
flipped["area"]["ra"] = "Some New Wording"
_, notes2 = hkg.parse(flipped, "2026-01-01T00:00:00Z")
check("a changed area legend is reported",
      any("legend changed" in n for n in notes2), notes2)

# THE CATEGORIES GROW. A new dining category must be surfaced, not dropped.
grown = copy.deepcopy(raw_good)
grown["kind"]["dining"]["cat"]["ramen"] = "Ramen Bars"
_, notes3 = hkg.parse(grown, "2026-01-01T00:00:00Z")
check("a new source category is reported",
      any("CATEGORY_MAP" in n for n in notes3), notes3)

# ── 7. the diff must be able to tell records apart ─────────────────────────
# NAME+TERMINAL+LEVEL IS NOT UNIQUE. HKG's 76 outlets collapse to 71 such tuples
# because a brand can run two counters on one level -- so a diff keyed on it
# merges five records and can hide a removal behind an addition. This is why the
# source's own id is carried.
keys = set()
for r in good:
    keys.add((r["airport"], r["name"], r["terminal"], r["level"]))
check("name+terminal+level really does collide (why source_id exists)",
      len(keys) < len(good), "%d tuples for %d records" % (len(keys), len(good)))
check("source_id makes every record distinguishable",
      len({(r["airport"], r["source_id"]) for r in good}) == len(good))

no_id = copy.deepcopy(good)
for r in no_id:
    r["source_id"] = ""
check("a diff that cannot tell records apart says so, loudly",
      "CANNOT DIFF" in R.diff({"records": no_id}, no_id))

# ── 8. the diff surfaces a flipped airside flag ────────────────────────────
flip_one = copy.deepcopy(good)
flip_one[0]["is_airside"] = not flip_one[0]["is_airside"]
check("a flipped airside flag appears in the diff",
      "AIRSIDE FLIPPED" in R.diff(previous, flip_one))

# AND AN IDENTICAL RE-RUN MUST BE SILENT. Comparing scraped_at made every record
# look changed on every run, which buries a real change in noise.
rerun = copy.deepcopy(good)
for r in rerun:
    r["scraped_at"] = "2099-12-31T23:59:59Z"
check("an identical re-run reports no changes",
      "(+0  -0  ~0)" in R.diff(previous, rerun), R.diff(previous, rerun))

print()
print("FAILURES: %d" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
