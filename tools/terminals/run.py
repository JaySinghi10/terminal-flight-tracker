"""Terminal outlines and gates, from OpenStreetMap, for the schematic map.

    python tools/terminals/run.py            # every airport in the manifest
    python tools/terminals/run.py jfk
    python tools/terminals/run.py --offline  # re-derive from the cached body

WHAT THIS IS FOR: drawing the shape of the concourse a traveller is standing in,
where the gates are along it, and -- with lib/dining.ts -- what food sits between
the gate they landed at and the gate they leave from. It is a DEPARTURES BOARD,
not a map: the outlines are simplified hard on purpose.

THREE THINGS ARE COMPUTED HERE RATHER THAN IN THE APP, because they are facts
about the geometry and not about any particular screen:

  * SIMPLIFICATION. Raw JFK is 984 outline points; at a 10-metre tolerance it is
    272, and the payload falls from 26.0 KB to 11.6 KB. Ten metres is sub-pixel
    at a schematic's zoom, so nothing visible is lost -- and the detail being
    dropped is exactly the detail a schematic exists to drop.

  * GATE ATTRIBUTION, by nearest footprint rather than by containment. A gate
    node is the aircraft STAND, at the outboard end of the jetbridge, so it sits
    on the apron OUTSIDE the building it serves: a strict point-in-polygon test
    put 74 of JFK's 136 gates in no terminal at all. Bounding boxes are no good
    either -- they overlap, and Terminal 1 and New Terminal 1 sit on top of each
    other. So it is inside-or-within-100m of the nearest ring.

  * THE CONCOURSE AXIS, by principal component analysis, and its confidence. A
    pier is a line and gates along it have a real order; a bent or branching
    concourse does not, and the app must be able to say which it is looking at.
    `along` is each gate's position on that axis, 0 at one end and 1 at the
    other, so the app compares two numbers instead of doing PCA at render time.

THE SAME REFUSAL RULES AS tools/dining. A run that returns fewer gates or fewer
terminals than the manifest expects keeps the previous data, because a quiet
empty map is worse than no map.
"""
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(DATA, "raw")
MANIFEST = os.path.join(HERE, "manifest.json")
TS_OUT = os.path.join(REPO, "FlightTrackerApp", "lib", "terminals.ts")

ENDPOINT = "https://overpass-api.de/api/interpreter"
UA = "flight-tracker-terminal-map/1.0 (personal project; one build-time request per airport)"

# TEN METRES. See the note above: measured, not chosen for roundness.
SIMPLIFY_M = 10.0

# HOW FAR A GATE CAN SIT FROM ITS TERMINAL AND STILL BELONG TO IT. See the
# attribution note below: a gate node is the aircraft stand, not a door, so it is
# outside the building by the length of a jetbridge.
GATE_ATTACH_M = 100.0

# Overpass is a volunteer service and this runs at build time for eight airports.
PAUSE_S = 20

QUERY = """[out:json][timeout:180];
way(around:%(radius)d,%(lat)f,%(lon)f)[aeroway=terminal];
out geom;
node(around:%(radius)d,%(lat)f,%(lon)f)[aeroway=gate];
out tags center;
"""


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ── geometry, in local metres ────────────────────────────────────────────────
#
# EVERY CALCULATION BELOW IS IN METRES, not degrees. A degree of longitude is
# not a degree of latitude anywhere but the equator, so simplifying or measuring
# in raw lon/lat would squash every airport by the cosine of its latitude -- and
# at Stockholm that is a factor of two.
def projector(lat0):
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians(lat0))
    return (lambda lon, lat: (lon * mlon, lat * mlat),
            lambda x, y: (x / mlon, y / mlat))


def _perp(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(points, tol):
    """Douglas-Peucker, iterative so a 462-point ring cannot blow the stack."""
    if len(points) < 3:
        return points[:]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, idx = 0.0, -1
        for i in range(lo + 1, hi):
            d = _perp(points[i], points[lo], points[hi])
            if d > worst:
                worst, idx = d, i
        if idx >= 0 and worst > tol:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [p for p, k in zip(points, keep) if k]


def inside(pt, ring):
    """Ray casting. Fifteen lines and no dependency, and it is what the
    overlapping bounding boxes at JFK need."""
    x, y = pt
    hit = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xin:
                hit = not hit
    return hit


def dist_to_ring(pt, ring):
    """Metres from a point to a polygon's boundary."""
    best = float("inf")
    n = len(ring)
    for i in range(n):
        d = _perp(pt, ring[i], ring[(i + 1) % n])
        if d < best:
            best = d
    return best


def axis_of(points):
    """(share, angle) -- how well one line explains these points, and which line.

    share is the larger eigenvalue over their sum: 1.0 is a perfect line, 0.5 is
    a circular blob. It is carried into the app so a bent concourse can say it is
    bent rather than implying an order it does not have.
    """
    n = len(points)
    if n < 3:
        return (0.0, 0.0)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    sxx = sum((p[0] - cx) ** 2 for p in points) / n
    syy = sum((p[1] - cy) ** 2 for p in points) / n
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in points) / n
    tr, det = sxx + syy, sxx * syy - sxy * sxy
    disc = max(0.0, tr * tr / 4.0 - det)
    l1 = tr / 2.0 + math.sqrt(disc)
    l2 = tr / 2.0 - math.sqrt(disc)
    share = l1 / (l1 + l2) if (l1 + l2) > 0 else 0.0
    return (share, 0.5 * math.atan2(2 * sxy, sxx - syy))


def terminal_key(name, aliases):
    """OSM's name -> the key lib/dining.ts uses. "Terminal 4" -> "T4".

    THE ALIAS TABLE IS NOT TIDINESS. JFK's OSM carries "Terminl 8", a misspelling
    of Terminal 8 with its own polygon and seventeen of the terminal's gates --
    left alone, Terminal 8 draws twice and its gates halve.

    ── AND IT USED TO READ ONLY A LEADING PREFIX, WHICH LOST MOST AIRPORTS ─────

    Surveyed across all eight, that rule threw away almost everything OSM had,
    because operators do not name their buildings the way it assumed:

        "Heathrow Terminal 5"            the word is not first, so Heathrow's
                                         largest terminal was dropped entirely
        "T2 (International)"             ARN. Every terminal, gone.
        "T5, Pier F (International)"     ARN again
        "TB East Pedestrian Bridge"      LGA, drawn as its own terminal
        "T1 Flugsteig A"                 FRA
        "一號客運大樓 Terminal 1"          HKG. The English is second, so HKG
                                         resolved ZERO terminals and 0 gates.

    Measured effect of reading the whole name: HKG goes from no geometry at all
    to two terminals and 90 gates, LHR gains Terminal 5, FRA gains three
    concourses, and ARN and LGA get their first dining matches.

    ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────

    IT WILL NOT TURN A PIER OR A FLUGSTEIG INTO A TERMINAL. "Pier 6" is not
    Terminal 6 and "Flugsteig G" is not Terminal G -- they are structures INSIDE
    a terminal, and which one is an airport-specific fact this function cannot
    know. Those stay unkeyed and belong in the manifest's alias table, where the
    answer is written down rather than guessed.

    AND THE TERSE FORM IS TESTED ON THE FIRST WORD ONLY, which is what stops
    "Terminl 8" being read as T-then-E. An earlier draft did exactly that and
    invented a terminal "TE" out of a misspelling -- turning a typo the alias
    table already handles into a phantom building.
    """
    n = (name or "").strip()
    if n in aliases:
        return aliases[n]

    # "Heathrow Terminal 5", "一號客運大樓 Terminal 1" -- anywhere in the string.
    #
    # THE TRAILING LETTER IS CONSUMED AND DISCARDED, and leaving it out was a
    # regression caught by re-running the survey: "Terminal 2A" and "Heathrow
    # Terminal 5B" resolved to NOTHING, so LHR lost Terminal 2 entirely and came
    # back with fewer gates than before the fix. 2A and 2B are piers of Terminal
    # 2; 5B and 5C are satellites of Terminal 5. They belong to their terminal,
    # which is the key dining.ts uses.
    m = re.search(
        r"(?:terminal|concourse)\s+(?:([0-9]{1,2})[A-Za-z]?|([A-Za-z]))(?![0-9A-Za-z])",
        n, re.I)
    if m:
        return "T" + (m.group(1) or m.group(2)).upper()

    # The terse form, on the FIRST WORD of the name with any parenthetical or
    # comma-suffix already behind it: "T2 (International)", "T5, Pier F",
    # "TB East Pedestrian Bridge", "T1 Flugsteig A", "T2A".
    core = re.split(r"[,(]", n)[0].strip()
    first = core.split()[0] if core.split() else ""
    m = re.match(r"^T\s*([0-9]{1,2})[A-Za-z]?$", first, re.I)
    if m:
        return "T" + m.group(1).upper()
    m = re.match(r"^T\s*([A-Za-z])$", first, re.I)
    if m:
        return "T" + m.group(1).upper()
    return ""


def name_rank(name, aliases):
    """Lower is a better name for a terminal that several polygons share.

    A NAME THAT RESOLVES ON ITS OWN MERITS BEATS ONE THAT NEEDED AN ALIAS. JFK's
    Terminal 8 is two polygons, "Terminal 8" and "Terminl 8", and the first one
    OSM happened to return won the label -- so the app displayed a misspelling
    it had already corrected the KEY for. This is not a hardcoded override; it
    is the same test the key already makes, reused to pick the label.
    """
    return 0 if terminal_key(name, {}) != "" else 1


def fetch(entry, cache_path, offline):
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return json.loads(io.open(cache_path, "rb").read().decode("utf8"))
    q = QUERY % {"radius": entry.get("radius_m", 6000),
                 "lat": entry["lat"], "lon": entry["lon"]}
    req = urllib.request.Request(ENDPOINT, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=240) as r:
        body = r.read()
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return json.loads(body.decode("utf8"))


def build(entry, raw):
    """(terminals, notes) for one airport."""
    notes = []
    code = entry["code"]
    aliases = entry.get("aliases") or {}
    exclude = set(entry.get("exclude") or [])
    to_m, to_deg = projector(entry["lat"])

    els = raw.get("elements") or []
    ways = [e for e in els if e.get("type") == "way" and e.get("geometry")]
    gate_nodes = [e for e in els if e.get("type") == "node"
                  and (e.get("tags") or {}).get("ref")]

    # ── the outlines, grouped by key ──
    #
    # A KEY CAN HOLD SEVERAL RINGS. Terminal 8 at JFK is two polygons in OSM and
    # merging their geometry would mean a real polygon library; keeping both
    # rings under one key draws the same thing and invents nothing.
    parts = {}
    dropped, unkeyed = [], []
    for w in ways:
        name = (w.get("tags") or {}).get("name")
        if name in exclude:
            dropped.append(str(name))
            continue
        key = terminal_key(name, aliases)
        if key == "":
            unkeyed.append(str(name))
            continue
        ring_m = [to_m(p["lon"], p["lat"]) for p in w["geometry"]]
        part = parts.setdefault(key, {"name": name, "rings": []})
        # THE BEST NAME WINS A MERGE, NOT THE FIRST ONE OVERPASS RETURNED.
        # See name_rank: "Terminl 8" was labelling Terminal 8 purely by
        # arriving first in the response.
        if name_rank(name, aliases) < name_rank(part["name"], aliases):
            part["name"] = name
        part["rings"].append(ring_m)

    if dropped:
        notes.append("excluded %d polygon(s) by manifest: %s" % (len(dropped), ", ".join(dropped)))
    if unkeyed:
        notes.append("%d polygon(s) had no readable terminal name and were skipped: %s"
                     % (len(unkeyed), ", ".join(sorted(set(unkeyed))[:5])))

    # ── the gates: INSIDE, OR ATTACHED TO, A TERMINAL ──
    #
    # STRICT POINT-IN-POLYGON IS THE WRONG RULE AND THE GUARDRAIL CAUGHT IT. A
    # gate node is where the AIRCRAFT parks -- the stand, at the outboard end of
    # the jetbridge -- so it sits on the apron just OUTSIDE the building it
    # belongs to. Tested at JFK, a strict test put 74 of 136 gates in no terminal
    # at all, which is not a fact about JFK but about what a gate node is.
    #
    # SO: INSIDE THE FOOTPRINT, OR WITHIN GATE_ATTACH_M OF ITS EDGE, whichever
    # terminal is nearest. A jetbridge is tens of metres; a hundred is generous
    # without reaching the next building, and a gate further out than that really
    # is a remote stand reached by bus.
    homeless = []
    for g in gate_nodes:
        pt = to_m(g["lon"], g["lat"])
        best_key, best_d = None, float("inf")
        for key, blob in parts.items():
            for ring in blob["rings"]:
                d = 0.0 if inside(pt, ring) else dist_to_ring(pt, ring)
                if d < best_d:
                    best_key, best_d = key, d
        if best_key is not None and best_d <= GATE_ATTACH_M:
            parts[best_key].setdefault("gates", []).append(
                {"ref": str((g.get("tags") or {}).get("ref")).strip().upper(),
                 "m": pt, "lon": g["lon"], "lat": g["lat"]})
        else:
            homeless.append(str((g.get("tags") or {}).get("ref")))
    if homeless:
        # REMOTE STANDS ARE REAL and are not drawn. A stand a bus ride from every
        # building is not somewhere a passenger walks past a restaurant.
        notes.append("%d gate(s) further than %dm from any terminal (remote stands, "
                     "not drawn): %s"
                     % (len(homeless), GATE_ATTACH_M, ", ".join(sorted(set(homeless))[:8])))

    out = []
    for key, blob in sorted(parts.items()):
        gates = blob.get("gates") or []
        rings_m = [simplify(r, SIMPLIFY_M) for r in blob["rings"]]
        share, ang = axis_of([g["m"] for g in gates])

        # `along`: where each gate sits on the concourse axis, 0..1. Computed
        # here so the app compares two numbers rather than doing PCA per render.
        if gates:
            proj = [(g["m"][0] * math.cos(ang) + g["m"][1] * math.sin(ang)) for g in gates]
            lo, hi = min(proj), max(proj)
            span = hi - lo
            for g, p in zip(gates, proj):
                g["along"] = 0.0 if span <= 0 else round((p - lo) / span, 4)
            spread_m = round(span)
        else:
            spread_m = 0

        pts = [p for r in rings_m for p in r] + [g["m"] for g in gates]
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bbox_deg = list(to_deg(min(xs), min(ys))) + list(to_deg(max(xs), max(ys)))

        out.append({
            "airport": code,
            "key": key,
            "name": blob["name"],
            "rings": [[[round(c, 6) for c in to_deg(x, y)] for x, y in r] for r in rings_m],
            "gates": sorted(
                [{"ref": g["ref"], "lon": round(g["lon"], 6), "lat": round(g["lat"], 6),
                  "along": g.get("along", 0.0)} for g in gates],
                key=lambda g: g["along"]),
            "axis_share": round(share, 3),
            "spread_m": spread_m,
            "bbox": [round(v, 6) for v in bbox_deg],
        })

    for t in out:
        notes.append("%s: %d ring point(s), %d gate(s), axis %.2f over %dm"
                     % (t["key"], sum(len(r) for r in t["rings"]), len(t["gates"]),
                        t["axis_share"], t["spread_m"]))
    return out, notes


def check(entry, terminals):
    """Every reason to refuse. Same shape as tools/dining/run.py."""
    fail = []
    g = entry.get("guardrails") or {}
    keys = sorted(t["key"] for t in terminals)
    want = g.get("expect_terminals")
    if want is not None:
        missing = sorted(set(want) - set(keys))
        extra = sorted(set(keys) - set(want))
        if missing:
            fail.append("terminals missing: %s (found %s)" % (missing, keys))
        if extra:
            fail.append("terminals not in the manifest: %s" % extra)
    total_gates = sum(len(t["gates"]) for t in terminals)
    if total_gates < g.get("min_gates", 0):
        fail.append("only %d gates, floor is %d" % (total_gates, g.get("min_gates", 0)))
    for t in terminals:
        if sum(len(r) for r in t["rings"]) < 4:
            fail.append("%s has almost no outline (%d points)"
                        % (t["key"], sum(len(r) for r in t["rings"])))
    return fail


def emit_ts(all_terminals):
    def num(v):
        return repr(round(v, 6))

    rows = []
    for t in all_terminals:
        rings = "[" + ",".join(
            "[" + ",".join("[%s,%s]" % (num(p[0]), num(p[1])) for p in r) + "]"
            for r in t["rings"]) + "]"
        gates = "[" + ",".join(
            '["%s",%s,%s,%s]' % (g["ref"], num(g["lon"]), num(g["lat"]), num(g["along"]))
            for g in t["gates"]) + "]"
        bbox = "[" + ",".join(num(v) for v in t["bbox"]) + "]"
        rows.append('  ["%s","%s",%s,%s,%s,%s,%s],'
                    % (t["airport"], t["key"], json.dumps(t["name"], ensure_ascii=False),
                       rings, gates, t["axis_share"], bbox))

    body = '''// Terminal outlines and gates. Generated by tools/terminals/run.py -- do not edit.
//
// FROM OPENSTREETMAP, © OpenStreetMap contributors, ODbL. THE ATTRIBUTION IS NOT
// OPTIONAL: anything that draws this data has to carry it on screen.
//
// A SCHEMATIC, NOT A MAP. The outlines are simplified at a 10-metre tolerance --
// JFK falls from 984 points to 272 -- because ten metres is sub-pixel at the zoom
// a terminal is drawn at, and because the detail being dropped is the detail a
// departures-board schematic exists to drop.
//
// axisShare IS THE HONESTY FIELD. It is how much of the gates' spread one
// straight line explains: 1.0 is a pier, 0.5 is a blob. Gates carry `along`,
// their position on that line from 0 to 1, so "what is between these two gates"
// is a comparison of two numbers. BUT AN ORDER ALONG A BENT CONCOURSE IS NOT A
// WALKING ORDER -- at JFK, Terminal 1 scores 0.94 and its ordering is real,
// while Terminal 4 scores 0.79 and a gate can be "between" two others while
// walking there means doubling back. Anything below ORDER_IS_ROUGH must say so
// rather than implying a route we have no path data for.
//
// A KEY CAN HOLD SEVERAL RINGS. Terminal 8 at JFK is two polygons in OSM, one of
// them misspelled "Terminl 8"; merging their geometry would need a polygon
// library, and drawing both rings under one key shows the same building and
// invents nothing.

export type Gate = {
  ref: string;
  lon: number;
  lat: number;
  along: number;      // 0..1 along the concourse axis
};

export type Terminal = {
  airport: string;
  key: string;        // "T4" -- the same spelling lib/dining.ts uses
  name: string;       // as OpenStreetMap has it
  rings: [number, number][][];
  gates: Gate[];
  axisShare: number;
  bbox: [number, number, number, number];   // minLon, minLat, maxLon, maxLat
};

// BELOW THIS, AN ORDERING IS ROUGH AND THE SCREEN MUST SAY SO. Measured at JFK:
// piers land at 0.87-0.98, bent concourses at 0.76-0.79.
export const ORDER_IS_ROUGH = 0.85;

type Row = [string, string, string, [number, number][][],
            [string, number, number, number][], number,
            [number, number, number, number]];

const ROWS: Row[] = [
%s
];

let cache: Terminal[] | null = null;

export function allTerminals(): Terminal[] {
  if (cache !== null) return cache;
  cache = ROWS.map(([airport, key, name, rings, gates, axisShare, bbox]) => ({
    airport, key, name, rings, axisShare, bbox,
    gates: gates.map(([ref, lon, lat, along]) => ({ ref, lon, lat, along })),
  }));
  return cache;
}

// ONE TERMINAL, HERS. Six polygons spread over four kilometres of JFK is
// unreadable at any size a phone has, so the map draws the terminal the
// traveller is actually in -- and a connection between two of them is two small
// schematics side by side, because that is what it physically is.
export function terminalOf(airport: string, key: string): Terminal | null {
  const a = airport.toUpperCase();
  const k = key.toUpperCase();
  return allTerminals().find(t => t.airport === a && t.key === k) ?? null;
}

export function terminalsAt(airport: string): Terminal[] {
  const a = airport.toUpperCase();
  return allTerminals().filter(t => t.airport === a);
}
''' % "\n".join(rows)

    os.makedirs(os.path.dirname(TS_OUT), exist_ok=True)
    io.open(TS_OUT, "w", encoding="utf8", newline="\n").write(body)
    return len(body)


def main():
    args = sys.argv[1:]
    offline = "--offline" in args
    wanted = [a.lower() for a in args if not a.startswith("-")]
    manifest = json.load(io.open(MANIFEST, encoding="utf8"))
    entries = [e for e in manifest["airports"] if not wanted or e["code"].lower() in wanted]
    if not entries:
        print("no matching airport in the manifest")
        return 1

    refused = []
    for i, entry in enumerate(entries):
        code = entry["code"]
        print("\n=== %s ===" % code)
        cache_path = os.path.join(RAW, "%s_overpass.json" % code.lower())
        try:
            raw = fetch(entry, cache_path, offline)
        except (urllib.error.URLError, RuntimeError, OSError, ValueError) as exc:
            print("  FETCH FAILED: %s: %s" % (type(exc).__name__, exc))
            refused.append(code)
            continue

        terminals, notes = build(entry, raw)
        for n in notes:
            print("  %s" % n)
        fails = check(entry, terminals)
        if fails:
            print("  REFUSED, previous data kept:")
            for f in fails:
                print("    - %s" % f)
            refused.append(code)
            continue

        io.open(os.path.join(DATA, "%s.json" % code.lower()), "w",
                encoding="utf8", newline="\n").write(
            json.dumps({"airport": code, "scraped_at": now_iso(), "terminals": terminals},
                       indent=1, ensure_ascii=False))
        print("  OK: %d terminal(s), %d gate(s)"
              % (len(terminals), sum(len(t["gates"]) for t in terminals)))
        if i + 1 < len(entries) and not offline:
            time.sleep(PAUSE_S)

    every = []
    for entry in manifest["airports"]:
        p = os.path.join(DATA, "%s.json" % entry["code"].lower())
        if os.path.exists(p):
            every.extend(json.load(io.open(p, encoding="utf8"))["terminals"])
    if every:
        size = emit_ts(every)
        print("\nwrote %s (%d terminals, %.1f KB)"
              % (os.path.relpath(TS_OUT, REPO), len(every), size / 1024))
    if refused:
        print("\nREFUSED: %s" % ", ".join(refused))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
