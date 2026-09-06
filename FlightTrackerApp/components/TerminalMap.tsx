// A schematic of one terminal: its shape, its gates, and the food along it.
//
// A DEPARTURES BOARD, NOT A MAP. There are no streets, no satellite, no tiles
// and no pan. The outline is drawn at a 10-metre simplification -- JFK's
// Terminal 4 is 133 points rather than 462 -- because the question is "where am
// I along this concourse", and every metre of traced detail below that answers a
// question nobody asked.
//
// react-native-svg RATHER THAN MapLibre, AND THE WORLD MAP'S LESSON DOES NOT
// TRANSFER. WorldMap.tsx moved to MapLibre in a WebView because react-native-svg
// re-rasterises every mounted node on any prop change, and that map animated an
// aircraft along an arc continuously -- every frame touched a prop and every
// frame redrew hundreds of nodes. NOTHING HERE ANIMATES. One terminal is roughly
// 130 outline points as a single Path, 16 to 50 gate marks and a handful of
// labels: drawn once, redrawn only when the traveller taps something.
//
// THE DISCIPLINE THAT CARRIES OVER: no animated props on this component, ever.
// If something has to move continuously it goes in a sibling view on top, not
// through these props.
//
// ONE TERMINAL, HERS. Six polygons spread over four kilometres of JFK is
// unreadable on a phone, and a connection between two of them is two of these
// side by side -- which is what it physically is.
import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle, Line, G } from 'react-native-svg';
import { Terminal, Gate, ORDER_IS_ROUGH } from '../lib/terminals';
import { Dining } from '../lib/dining';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

const GREEN = '#4ade80';
const INK = '#e2e2e2';
const DIM = 'rgba(226,226,226,0.4)';
const DIMMER = 'rgba(226,226,226,0.28)';
const AMBER = '#fbbf24';
const OUTLINE = 'rgba(226,226,226,0.22)';
const FILL = 'rgba(255,255,255,0.035)';

const PAD = 14;          // inside the viewBox, so marks at the edge are not clipped
const H = 190;           // the schematic's height in points

// ── WHERE A DINING ROW SITS ON THE CONCOURSE ────────────────────────────────
//
// MATCHING IS WITHIN ONE TERMINAL, AND THAT IS THE WHOLE POINT. An earlier
// measurement matched hints against every gate at the airport and reported 94%
// -- a number that would happily place a Terminal 1 restaurant on a Terminal 5
// gate. Scoped to the correct terminal it is 48 of 49 at JFK, and the one miss
// is a hint of "15" in a terminal whose gates run 501-529.
//
// A ROW'S gateHint IS EITHER A GATE OR A RANGE: "6", "25", "40-80", "09-20".
// A single gate is a point. A RANGE IS DRAWN AS A SPAN rather than a point,
// because that is what it is -- "the food court near gates 40 to 80" is not at
// gate 60, it is along that stretch, and putting a dot in the middle would claim
// a precision the source never gave.
export type Placed = {
  d: Dining;
  from: number;          // 0..1 along the concourse
  to: number;            // equal to `from` for a single gate
};

// THE LEADING NUMBER OF A GATE REF, or null when it does not start with one.
//
// ONLY THE LEADING ONE, AND ONLY WHEN THE REF BEGINS WITH IT. OpenStreetMap
// writes JFK's Terminal 1 as "3 A-B", "5A", "7B" where the airport's own dining
// feed says "3", "5", "7" -- so a bare number has to match a ref that starts
// with it. But Terminal 4's refs are "A2", "A10": stripping non-digits there
// would turn "A2" into 2 and let a hint of "2" land on the wrong pier. Starting
// with a digit is the test that separates the two.
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

export function placeDining(rows: Dining[], t: Terminal): { placed: Placed[]; unplaced: Dining[] } {
  const byRef = new Map<string, Gate>();
  for (const g of t.gates) byRef.set(g.ref.toUpperCase(), g);
  const placed: Placed[] = [];
  const unplaced: Dining[] = [];

  for (const d of rows) {
    const hint = (d.gateHint || '').trim().toUpperCase();
    if (hint === '') { unplaced.push(d); continue; }

    const span = (hits: Gate[]) => {
      const alongs = hits.map(g => g.along);
      placed.push({ d, from: Math.min(...alongs), to: Math.max(...alongs) });
    };

    // 1. THE REF, VERBATIM. "501", "A12".
    const exact = byRef.get(hint);
    if (exact !== undefined) { placed.push({ d, from: exact.along, to: exact.along }); continue; }

    // 2. A BARE NUMBER against refs that start with it -- "5" reaches "5A" and
    //    "5B", which is the same gate written two ways.
    if (/^\d+$/.test(hint)) {
      const n = parseInt(hint, 10);
      const hits = gatesNumbered(t.gates, x => x === n);
      if (hits.length > 0) { span(hits); continue; }
    }

    // 3. A RANGE. "40-80" is a stretch of concourse, not a point.
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(hint);
    if (range !== null) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      const hits = gatesNumbered(t.gates, x => x >= lo && x <= hi);
      if (hits.length > 0) { span(hits); continue; }
    }

    // 4. TWO NAMED GATES. JFK's own feed writes "39and41" and "1and2".
    const pair = /^(\d+)\s*AND\s*(\d+)$/.exec(hint);
    if (pair !== null) {
      const a = parseInt(pair[1], 10);
      const b = parseInt(pair[2], 10);
      const hits = gatesNumbered(t.gates, x => x === a || x === b);
      if (hits.length > 0) { span(hits); continue; }
    }
    // NOT DROPPED. A restaurant our join could not place is still a restaurant,
    // and the Deck lists it under the terminal instead. Losing it because our
    // matching failed would be the same error as losing one for a blank zone.
    unplaced.push(d);
  }
  return { placed, unplaced };
}

// WHAT SITS BETWEEN TWO GATES, and how much that claim is worth.
//
// AN ORDER ALONG AN AXIS IS NOT A WALKING ORDER. Where one straight line
// explains the gates well -- JFK's Terminal 1 scores 0.94 -- the ordering is
// real and "between" means what it says. Where the concourse bends, Terminal 4
// at 0.79, a place can be between two gates by projection while walking there
// means doubling back. The caller is told which it has.
export function between(placed: Placed[], a: number, b: number): Placed[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return placed.filter(p => p.to >= lo && p.from <= hi);
}

export default function TerminalMap({ terminal, placed, arrival, departure }: {
  terminal: Terminal;
  placed: Placed[];
  arrival: Gate | null;
  departure: Gate | null;
}) {
  // ── THE PROJECTION ──
  //
  // Metres, not degrees, and then fitted to the box. A degree of longitude is
  // shorter than a degree of latitude everywhere but the equator, so projecting
  // raw lon/lat would squash the whole terminal by the cosine of its latitude --
  // at JFK that is a 24% error in one direction only.
  const view = useMemo(() => {
    const [minLon, minLat, maxLon, maxLat] = terminal.bbox;
    const midLat = (minLat + maxLat) / 2;
    const kx = Math.cos((midLat * Math.PI) / 180);
    const w = Math.max(1e-9, (maxLon - minLon) * kx);
    const h = Math.max(1e-9, maxLat - minLat);

    // THE LONG SIDE RUNS ACROSS. A concourse is a long thin thing and the screen
    // is wider than it is tall, so a portrait terminal is turned to lie down --
    // it is a schematic, and its job is to be legible rather than north-up.
    const rotate = h > w;
    const spanX = rotate ? h : w;
    const spanY = rotate ? w : h;
    const boxW = 320 - PAD * 2;
    const boxH = H - PAD * 2;
    const scale = Math.min(boxW / spanX, boxH / spanY);
    const offX = PAD + (boxW - spanX * scale) / 2;
    const offY = PAD + (boxH - spanY * scale) / 2;

    const project = (lon: number, lat: number): [number, number] => {
      const east = (lon - minLon) * kx;           // metres-ish from the west edge
      const down = maxLat - lat;                  // and from the north; SVG y grows down
      // Turned on its side when the terminal is taller than it is wide: the
      // long axis of a concourse runs across the screen either way.
      const ux = rotate ? down : east;
      const uy = rotate ? east : down;
      return [offX + ux * scale, offY + uy * scale];
    };
    return { project, rotate };
  }, [terminal]);

  const outline = useMemo(() => terminal.rings.map(ring => {
    if (ring.length === 0) return '';
    const pts = ring.map(([lon, lat]) => view.project(lon, lat));
    return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' Z';
  }).filter(s => s !== ''), [terminal, view]);

  const gatePts = useMemo(
    () => terminal.gates.map(g => ({ g, p: view.project(g.lon, g.lat) })),
    [terminal, view]);

  const rough = terminal.axisShare < ORDER_IS_ROUGH;
  const hasRoute = arrival !== null && departure !== null;
  const lo = hasRoute ? Math.min(arrival!.along, departure!.along) : 0;
  const hi = hasRoute ? Math.max(arrival!.along, departure!.along) : 0;

  return (
    <View style={st.wrap}>
      <View style={st.head}>
        <Text style={st.name}>{terminal.key}</Text>
        <Text style={st.sub}>{`${terminal.gates.length} gates`}</Text>
      </View>

      <Svg width="100%" height={H} viewBox={`0 0 320 ${H}`}>
        {/* THE BUILDING. One Path per ring, filled faintly so the shape reads as
            a solid rather than a wire. */}
        {outline.map((d, i) => (
          <Path key={i} d={d} fill={FILL} stroke={OUTLINE} strokeWidth={1} strokeLinejoin="round" />
        ))}

        {/* THE STRETCH BETWEEN THE TWO GATES, drawn under everything as a band
            rather than a line -- we have positions, not a path, and a line
            between two points would draw a route we cannot vouch for. */}
        {hasRoute && (
          <G>
            {gatePts
              .filter(({ g }) => g.along >= lo && g.along <= hi)
              .map(({ g, p }) => (
                <Circle key={`band-${g.ref}`} cx={p[0]} cy={p[1]} r={7}
                  fill={rough ? 'rgba(251,191,36,0.10)' : 'rgba(74,222,128,0.12)'} />
              ))}
          </G>
        )}

        {/* EVERY GATE, small. These are the ticks of the schematic. */}
        {gatePts.map(({ g, p }) => (
          <Circle key={g.ref} cx={p[0]} cy={p[1]} r={1.6} fill={DIMMER} />
        ))}

        {/* FOOD, ON THE GATES IT WAS MATCHED TO. A range draws as a bar between
            its ends; a single gate draws as one mark. */}
        {placed.map((pl, i) => {
          const inBand = hasRoute && pl.to >= lo && pl.from <= hi;
          const ends = gatePts.filter(({ g }) => g.along >= pl.from && g.along <= pl.to);
          if (ends.length === 0) return null;
          const xs = ends.map(e => e.p[0]);
          const ys = ends.map(e => e.p[1]);
          const colour = inBand ? GREEN : DIM;
          if (pl.from === pl.to || ends.length === 1) {
            return <Circle key={`f${i}`} cx={xs[0]} cy={ys[0]} r={3} fill={colour} />;
          }
          return (
            <Line key={`f${i}`}
              x1={Math.min(...xs)} y1={ys[xs.indexOf(Math.min(...xs))]}
              x2={Math.max(...xs)} y2={ys[xs.indexOf(Math.max(...xs))]}
              stroke={colour} strokeWidth={2.5} strokeLinecap="round" opacity={0.75} />
          );
        })}

        {/* THE TWO GATES THAT MATTER, drawn last so nothing sits on top. */}
        {arrival !== null && (() => {
          const hit = gatePts.find(({ g }) => g.ref === arrival.ref);
          return hit === undefined ? null : (
            <Circle cx={hit.p[0]} cy={hit.p[1]} r={5} fill="none" stroke={INK} strokeWidth={1.6} />
          );
        })()}
        {departure !== null && (() => {
          const hit = gatePts.find(({ g }) => g.ref === departure.ref);
          return hit === undefined ? null : (
            <Circle cx={hit.p[0]} cy={hit.p[1]} r={5} fill={GREEN} />
          );
        })()}
      </Svg>

      <View style={st.legend}>
        {arrival !== null && <Text style={st.legendInk}>{`◯ landed ${arrival.ref}`}</Text>}
        {departure !== null && <Text style={st.legendGreen}>{`● gate ${departure.ref}`}</Text>}
        {hasRoute && rough && (
          // THE HONESTY LINE. See ORDER_IS_ROUGH in lib/terminals.ts: this
          // concourse bends, so "between" is a projection rather than a walk.
          <Text style={st.legendWarn}>{'roughly between — this concourse bends'}</Text>
        )}
      </View>

      {/* ODbL. Not optional, and not in a settings screen somewhere. */}
      <Text style={st.credit}>{'© OpenStreetMap contributors'}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: {
    backgroundColor: 'rgba(255,255,255,0.045)', borderRadius: 12,
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, marginTop: 8,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  name: { fontFamily: MONO_BOLD, fontSize: 14, color: INK, letterSpacing: 1 },
  sub: { fontFamily: MONO, fontSize: 11, color: DIM },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  legendInk: { fontFamily: MONO, fontSize: 10, color: INK },
  legendGreen: { fontFamily: MONO, fontSize: 10, color: GREEN },
  legendWarn: { fontFamily: SANS, fontSize: 10, color: AMBER },
  credit: { fontFamily: MONO, fontSize: 9, color: DIMMER, marginTop: 6 },
});
