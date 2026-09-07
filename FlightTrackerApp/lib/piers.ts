// Putting things on a corridor: gates, restaurants, and the traveller.
//
// THE CORRIDOR IS THE PIER'S AXIS, computed in tools/terminals/run.py and
// shipped with every terminal. Everything here projects onto it -- one dot
// product for the distance ALONG, one for which SIDE.
//
// WHY THIS IS NOT PER TERMINAL. Measured before any of it was built: projecting
// a whole terminal onto one line puts unrelated buildings on top of each other.
// At HKG Terminal 1, twenty-two gates numbered 201-230 land inside a
// FORTY-SEVEN METRE slice of the axis and spread 680 metres across it -- an
// entire satellite concourse crushed to a point. Seven of twenty terminals
// looked like corridors. Broken into piers, twenty-seven of thirty-seven do,
// holding 377 of 571 gates.
import type { Dining } from './dining';
import type { Terminal, Pier, Gate } from './terminals';
import { M_PER_DEG_LAT, mPerDegLon } from './terminals';
import type { Placed } from './terminalgeo';

/** Where something sits on a pier. */
export type OnPier = {
  /** Metres along the corridor, increasing away from the lowest-numbered gate. */
  along: number;
  /** Signed metres across. Positive is one side, negative the other. */
  side: number;
};

// AN OUTLET FURTHER ACROSS THAN THIS IS NOT BESIDE THE CORRIDOR. Piers that
// measure as corridors run 13-216m wide, so sixty metres either side of the
// centreline covers the walkway and the units along it. Beyond that it is
// somewhere else in the building and saying "on your left" would be a lie.
export const BESIDE_M = 60;

// AND AN OUTLET PAST EITHER END BY MORE THAN THIS IS NOT ON THIS PIER either.
export const BEYOND_M = 80;

/**
 * Project a longitude/latitude onto a pier's axis.
 *
 * THE ARITHMETIC MATCHES tools/terminals/run.py EXACTLY -- the same flat
 * projection, the same constants, the same origin. If the two ever drift, every
 * `along` shipped in terminals.ts would mean something slightly different from
 * what this computes for a restaurant, and the two would be drawn in
 * disagreement with no error anywhere.
 */
export function projectOnto(p: Pier, lon: number, lat: number): OnPier {
  const mlon = mPerDegLon(p.clat);
  const dx = lon * mlon - p.clon * mlon;
  const dy = lat * M_PER_DEG_LAT - p.clat * M_PER_DEG_LAT;
  return {
    along: dx * p.ux + dy * p.uy,
    side: dx * -p.uy + dy * p.ux,
  };
}

/** Is this point beside this pier, rather than merely near the building? */
export function isBeside(p: Pier, at: OnPier): boolean {
  const half = p.lengthM / 2 + BEYOND_M;
  return Math.abs(at.side) <= BESIDE_M && Math.abs(at.along) <= half;
}

/** Only the piers worth drawing as a corridor. */
export function drawablePiers(t: Terminal): Pier[] {
  return t.piers.filter(p => p.kind !== 'hall');
}

export type PierOutlet = { placed: Placed; at: OnPier };

/**
 * The outlets that belong beside one pier.
 *
 * AN OUTLET LANDS ON AT MOST ONE PIER. Terminals have several and a restaurant
 * near a junction can project onto two; taking the nearer centreline keeps it
 * from being drawn twice in two places, which reads as two restaurants.
 */
export function outletsOn(
  t: Terminal, pier: Pier, placed: Placed[],
): PierOutlet[] {
  const others = t.piers.filter(p => p !== pier && p.kind !== 'hall');
  const out: PierOutlet[] = [];
  for (const pl of placed) {
    const at = projectOnto(pier, pl.lon, pl.lat);
    if (!isBeside(pier, at)) continue;
    const mine = Math.abs(at.side);
    let closer = false;
    for (const o of others) {
      const there = projectOnto(o, pl.lon, pl.lat);
      if (isBeside(o, there) && Math.abs(there.side) < mine) { closer = true; break; }
    }
    if (!closer) out.push({ placed: pl, at });
  }
  return out.sort((a, b) => a.at.along - b.at.along);
}

export type PierGateRow = { gate: Gate; gi: number; at: OnPier };

export function gatesOn(t: Terminal, pier: Pier): PierGateRow[] {
  return pier.gates.map(pg => ({
    gate: t.gates[pg.gi], gi: pg.gi, at: { along: pg.along, side: pg.side },
  }));
}

// ── WHICH WAY IS "AHEAD" ────────────────────────────────────────────────────
//
// A SIDE IS ONLY MEANINGFUL RELATIVE TO A DIRECTION OF TRAVEL, and the reader
// is walking one way down the corridor. The view draws the pier with `along`
// increasing downward, so a positive side is drawn on the left and negative on
// the right -- consistently, whichever way they are actually facing. The screen
// says "left" and "right" of the DRAWING, never of the person, because we do
// not know which way they are facing and have no way to find out.
export function sideOf(at: OnPier): 'left' | 'right' | 'centre' {
  if (at.side > 2) return 'left';
  if (at.side < -2) return 'right';
  return 'centre';
}

/** Both ends of a pier in `along` terms, padded so nothing sits on the edge. */
export function extentOf(rows: { at: OnPier }[]): { lo: number; hi: number } {
  if (rows.length === 0) return { lo: -1, hi: 1 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.at.along < lo) lo = r.at.along;
    if (r.at.along > hi) hi = r.at.along;
  }
  return { lo, hi };
}

// ── HOW FAR, IN WORDS ───────────────────────────────────────────────────────
//
// METRES UNDER A KILOMETRE, ROUNDED TO TEN. The input is a gate centroid
// standing in for a restaurant and the walk is not a straight line, so a figure
// to the metre would be precision this does not have.
export function metresWord(m: number): string {
  const v = Math.abs(m);
  if (v < 15) return 'here';
  if (v < 1000) return `${Math.round(v / 10) * 10}m`;
  return `${(v / 1000).toFixed(1)}km`;
}

/** How many gates lie between two points on the pier, ends excluded. */
export function gatesBetween(rows: PierGateRow[], a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return rows.filter(r => r.at.along > lo + 1 && r.at.along < hi - 1).length;
}

/** "400m and eight gates that way" -- useful with no food on it at all. */
export function wayThere(rows: PierGateRow[], from: number, to: number): string {
  const d = metresWord(to - from);
  if (d === 'here') return 'you are here';
  const n = gatesBetween(rows, from, to);
  const dir = to > from ? 'ahead' : 'behind';
  return n === 0 ? `${d} ${dir}` : `${d} and ${n} gate${n === 1 ? '' : 's'} ${dir}`;
}

export type { Dining };
