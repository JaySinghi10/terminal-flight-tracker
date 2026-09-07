"""Is there enough OpenStreetMap geometry to draw the other seven airports?

    python tools/terminals/survey.py            # all eight
    python tools/terminals/survey.py bom fra

A SURVEY, NOT A BUILD. It writes no terminals.ts and touches no manifest. JFK
took a manifest entry with hand-written aliases, an exclude list and guardrails,
and none of that can be written before seeing what OSM actually holds. This
reports what is there so those entries can be written from evidence.

── THE THREE NUMBERS, AND WHY THE THIRD MATTERS MOST ───────────────────────────

TERMINALS AND GATES tell us whether a schematic can be drawn at all. An airport
with no gate nodes is one where the map would be an empty outline.

GATE-HINT MATCH RATE is how many dining rows the CURRENT app can put on that
schematic. It replicates placeDining exactly -- verbatim ref, bare number
against leading digits, a range, and JFK's own "39and41" -- because a survey
that measured a different matcher would be measuring nothing.

COORDINATE COVERAGE is the one that may make the other two beside the point.
Many dining rows already carry lat/lon from the scrape. A row with coordinates
needs no gate at all to be drawn -- it is already a point on the map. If that
number is high, the map rebuild plots dining directly and gates become labels
rather than the join.

── ORDER-OF-MAGNITUDE HONESTY ──────────────────────────────────────────────────

An earlier pass at JFK reported a 94% dining/gate match and it was measured
wrong -- against every gate at the airport rather than against the gates of the
terminal the restaurant is in. Within the correct terminal it was 69%, and
48/49 once numeric-prefix matching was added. This matches WITHIN THE TERMINAL,
and a row whose terminal has no geometry is counted as unmatched rather than
quietly skipped.
"""
import io
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

import run as R                                            # noqa: E402

# The same threshold lib/terminals.ts publishes. Restated rather than imported
# because run.py emits it into the TypeScript and does not hold it as a name.
ORDER_IS_ROUGH = 0.85

DINING_TS = os.path.join(REPO, "FlightTrackerApp", "lib", "dining.ts")
CACHE = os.path.join(HERE, "data", "raw")

# code, lat, lon, radius. Centres are the airport reference points; the radius
# has to cover the whole field, and a few of these are much bigger than JFK.
AIRPORTS = [
    ("JFK", 40.6394, -73.7793, 6000),
    ("BOM", 19.0887, 72.8679, 5000),
    ("FRA", 50.0267, 8.5584, 6000),
    ("LHR", 51.4700, -0.4543, 6000),
    ("HKG", 22.3080, 113.9185, 6000),
    ("EWR", 40.6895, -74.1745, 5000),
    ("LGA", 40.7769, -73.8740, 4000),
    ("ARN", 59.6519, 17.9186, 6000),
]


def dining_rows():
    """Parse the generated dining.ts. Each ROW is a JSON array on one line."""
    text = io.open(DINING_TS, encoding="utf8").read()
    out = []
    for line in text.split("\n"):
        t = line.strip()
        if not t.startswith("[\"") and not t.startswith('["'):
            continue
        if t.endswith(","):
            t = t[:-1]
        try:
            row = json.loads(t)
        except ValueError:
            continue
        if len(row) < 21:
            continue
        out.append({
            "airport": row[0], "name": row[1], "terminal": row[4],
            "gateHint": row[7], "lat": row[19], "lon": row[20],
        })
    return out


# ── placeDining, replicated. See the note at the top. ───────────────────────
def lead_number(ref):
    m = re.match(r"^(\d+)", str(ref).strip())
    return int(m.group(1)) if m else None


def gates_numbered(gates, want):
    out = []
    for g in gates:
        n = lead_number(g["ref"])
        if n is not None and want(n):
            out.append(g)
    return out


def matches(hint, gates):
    hint = str(hint or "").strip().upper()
    if hint == "":
        return None                      # no hint at all -- not a failure to match
    by_ref = {str(g["ref"]).upper(): g for g in gates}
    if hint in by_ref:
        return "exact"
    if re.match(r"^\d+$", hint):
        n = int(hint)
        if gates_numbered(gates, lambda x: x == n):
            return "number"
    m = re.match(r"^(\d+)\s*-\s*(\d+)$", hint)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if gates_numbered(gates, lambda x: lo <= x <= hi):
            return "range"
    m = re.match(r"^(\d+)\s*AND\s*(\d+)$", hint)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if gates_numbered(gates, lambda x: x in (a, b)):
            return "pair"
    return "unmatched"


def survey(code, lat, lon, radius, dining, offline):
    entry = {"code": code, "lat": lat, "lon": lon, "radius_m": radius,
             "aliases": {}, "exclude": []}
    cache_path = os.path.join(CACHE, "%s_overpass.json" % code.lower())
    try:
        raw = R.fetch(entry, cache_path, offline)
    except Exception as exc:
        print("  FETCH FAILED: %s: %s" % (type(exc).__name__, str(exc)[:120]))
        return None
    try:
        terminals, notes = R.build(entry, raw)
    except Exception as exc:
        print("  BUILD FAILED: %s: %s" % (type(exc).__name__, str(exc)[:160]))
        return None

    rows = [d for d in dining if d["airport"] == code]
    by_key = {t["key"]: t for t in terminals}

    print("  terminals with geometry: %d  [%s]"
          % (len(terminals), " ".join(sorted(by_key)) or "-"))
    total_gates = sum(len(t["gates"]) for t in terminals)
    print("  gates: %d" % total_gates)
    for t in sorted(terminals, key=lambda x: x["key"]):
        rough = "" if t["axis_share"] >= ORDER_IS_ROUGH else "   (ordering rough)"
        print("    %-6s %3d gates   axisShare %.2f%s"
              % (t["key"], len(t["gates"]), t["axis_share"], rough))
    for n in notes[:6]:
        print("    note: %s" % n)

    # ── the dining join, within the terminal ──
    hinted = [d for d in rows if str(d["gateHint"] or "").strip() != ""]
    with_coords = [d for d in rows if d["lat"] is not None and d["lon"] is not None]
    kinds = {}
    matched = 0
    no_geometry = 0
    for d in hinted:
        t = by_key.get(str(d["terminal"] or "").strip().upper())
        if t is None:
            no_geometry += 1
            continue
        k = matches(d["gateHint"], t["gates"])
        kinds[k] = kinds.get(k, 0) + 1
        if k not in (None, "unmatched"):
            matched += 1

    def pct(n, d):
        return "  -" if not d else "%3.0f%%" % (100.0 * n / d)

    print("  dining rows: %d" % len(rows))
    print("    with a gate hint      : %4d  %s" % (len(hinted), pct(len(hinted), len(rows))))
    print("    hint + terminal drawn : %4d  (%d hinted rows are in a terminal with no geometry)"
          % (len(hinted) - no_geometry, no_geometry))
    print("    MATCHED TO A GATE     : %4d  %s of all rows, %s of hinted"
          % (matched, pct(matched, len(rows)), pct(matched, len(hinted))))
    if kinds:
        print("      by rule: %s" % ", ".join("%s=%d" % (k, v) for k, v in sorted(kinds.items(), key=lambda x: str(x[0]))))
    print("    WITH lat/lon          : %4d  %s   <- plottable with no gate at all"
          % (len(with_coords), pct(len(with_coords), len(rows))))
    return {
        "code": code, "terminals": len(terminals), "gates": total_gates,
        "rows": len(rows), "hinted": len(hinted), "matched": matched,
        "coords": len(with_coords), "keys": sorted(by_key),
    }


def main():
    args = [a.lower() for a in sys.argv[1:] if not a.startswith("--")]
    offline = "--offline" in sys.argv
    dining = dining_rows()
    print("dining rows parsed: %d" % len(dining))
    wanted = [a for a in AIRPORTS if not args or a[0].lower() in args]
    out = []
    for i, (code, lat, lon, radius) in enumerate(wanted):
        print()
        print("=" * 74)
        print("%s" % code)
        print("=" * 74)
        r = survey(code, lat, lon, radius, dining, offline)
        if r:
            out.append(r)
        # Overpass is a shared free service. One request per airport, spaced.
        if not offline and i + 1 < len(wanted):
            time.sleep(20)

    print()
    print("=" * 74)
    print("SUMMARY")
    print("=" * 74)
    print("%-5s %5s %6s %6s %7s %8s %8s" %
          ("apt", "terms", "gates", "rows", "hinted", "matched", "lat/lon"))
    for r in out:
        print("%-5s %5d %6d %6d %7d %8s %8s" % (
            r["code"], r["terminals"], r["gates"], r["rows"], r["hinted"],
            "%d (%.0f%%)" % (r["matched"], 100.0 * r["matched"] / r["rows"]) if r["rows"] else "-",
            "%d (%.0f%%)" % (r["coords"], 100.0 * r["coords"] / r["rows"]) if r["rows"] else "-"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
