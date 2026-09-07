// Where a restaurant actually is, in coordinates, so a map can draw it.
//
// THIS REPLACES AN ANSWER THAT WAS NOT A POSITION. The old placeDining returned
// a span along the concourse axis -- two numbers between 0 and 1 -- which was
// enough for the schematic's one-dimensional strip and is not enough for a map.
// A marker needs a longitude and a latitude.
//
// ── TWO SOURCES, AND THE FIRST IS FAR BETTER THAN THE SECOND ────────────────
//
// THE SCRAPE'S OWN COORDINATES, where the airport published them. Measured
// across the dataset: HKG carries lat/lon on 76 rows of 76. Nowhere else
// carries a single one. Where they exist there is nothing to infer -- the
// restaurant is at that point.
//
// OTHERWISE THE GATE IT NAMES, which is a real position but a coarser one: it
// puts the outlet at the aircraft stand rather than in the concourse, tens of
// metres out, and for a range like "40-80" it lands at the middle of a stretch
// that may be four hundred metres long. That is honest as "near these gates"
// and would be a lie drawn as a precise pin, which is why `source` travels with
// every placement and the map draws the two differently.
//
// AND MANY ROWS HAVE NEITHER. FRA, LHR and EWR have no coordinates and no gate
// hints at all -- 0 of 83, 0 of 51, and 1 of 118. Those terminals can draw a
// building and its gates and NO FOOD, and the screen has to say that rather
// than show an empty map and let it read as broken.
import type { Dining } from './dining';
import type { Terminal, Gate } from './terminals';

export type PlaceSource = 'coords' | 'gate';

export type Placed = {
  d: Dining;
  lon: number;
  lat: number;
  source: PlaceSource;
  // How many gates the hint resolved to. 1 is a point; more is a stretch, and
  // the position is their centre rather than anywhere the outlet actually is.
  gateSpan: number;
};

function leadNumber(ref: string): number | null {
  const m = /^(\d+)/.exec(ref.trim());
  return m === null ? null : parseInt(m[1], 10);
}

function gatesNumbered(gates: Gate[], want: (n: number) => boolean): Gate[] {
  return gates.filter(g => {
    const n = leadNumber(g.ref);
    return n !== null && want(n);
  });
}

/** The gates a hint names, or an empty list. The rules are unchanged. */
export function gatesForHint(hint: string, gates: Gate[]): Gate[] {
  const h = hint.trim().toUpperCase();
  if (h === '') return [];

  // 1. THE REF, VERBATIM. "501", "A12".
  //
  // EVERY GATE WITH THAT REF, NOT THE FIRST. OSM has three separate stands
  // signed A6 at JFK Terminal 4 and two signed A7, and picking one would put a
  // marker at whichever the fetch happened to return first.
  const exact = gates.filter(g => g.ref.toUpperCase() === h);
  if (exact.length > 0) return exact;

  // 2. A BARE NUMBER against refs that start with it -- "5" reaches "5A" and
  //    "5B", which is the same gate written two ways.
  if (/^\d+$/.test(h)) {
    const n = parseInt(h, 10);
    const hits = gatesNumbered(gates, x => x === n);
    if (hits.length > 0) return hits;
  }

  // 3. A RANGE. "40-80" is a stretch of concourse, not a point.
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(h);
  if (range !== null) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    const hits = gatesNumbered(gates, x => x >= lo && x <= hi);
    if (hits.length > 0) return hits;
  }

  // 4. TWO NAMED GATES. JFK's own feed writes "39and41" and "1and2".
  const pair = /^(\d+)\s*AND\s*(\d+)$/.exec(h);
  if (pair !== null) {
    const a = parseInt(pair[1], 10);
    const b = parseInt(pair[2], 10);
    const hits = gatesNumbered(gates, x => x === a || x === b);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * Every outlet in this terminal that can be put on a map, and every one that
 * cannot.
 *
 * AN UNPLACED ROW IS NOT DROPPED. It is still a restaurant and the Deck still
 * lists it; losing it because our join failed would be the same error as
 * hiding one because its zone was blank.
 */
export function placeDining(rows: Dining[], t: Terminal): {
  placed: Placed[]; unplaced: Dining[];
} {
  const placed: Placed[] = [];
  const unplaced: Dining[] = [];
  for (const d of rows) {
    if (d.lat !== null && d.lon !== null) {
      placed.push({ d, lon: d.lon, lat: d.lat, source: 'coords', gateSpan: 1 });
      continue;
    }
    const hits = gatesForHint(d.gateHint || '', t.gates);
    if (hits.length === 0) { unplaced.push(d); continue; }
    const lon = hits.reduce((s, g) => s + g.lon, 0) / hits.length;
    const lat = hits.reduce((s, g) => s + g.lat, 0) / hits.length;
    placed.push({ d, lon, lat, source: 'gate', gateSpan: hits.length });
  }
  return { placed, unplaced };
}

// ── DISTANCE, FLAT ──────────────────────────────────────────────────────────
//
// EQUIRECTANGULAR, NOT HAVERSINE, AND THAT IS NOT A SHORTCUT. Everything here
// is inside one building. Over a kilometre at any latitude the error against
// the great circle is centimetres, and the input -- a gate centroid standing in
// for a restaurant -- is already tens of metres coarse. Haversine would be
// arithmetic precision applied to data that does not have it.
export function metresBetween(
  a: { lon: number; lat: number }, b: { lon: number; lat: number },
): number {
  const mid = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dx = (b.lon - a.lon) * 111320 * Math.cos(mid);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

// A WALKING MINUTE, AND IT IS AN ESTIMATE SAID OUT LOUD.
//
// 1.2 m/s is an unhurried indoor pace, and a terminal is not open floor: there
// are queues, escalators, and a pier you have to walk out and back along. The
// straight-line distance between two points inside one is a LOWER BOUND on the
// walk, so this number is optimistic by construction and must never be printed
// as though it were a route.
export const WALK_M_PER_MIN = 72;

export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / WALK_M_PER_MIN));
}

/** The terminal's centre, for an opening camera. */
export function centreOf(t: Terminal): { lon: number; lat: number } {
  const [minLon, minLat, maxLon, maxLat] = t.bbox;
  return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}
