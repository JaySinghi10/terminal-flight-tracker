// The concourse as a corridor, seen from inside it rather than from above.
//
// ── THE THIRD ATTEMPT, AND WHY THE FIRST TWO WERE THE WRONG SHAPE ───────────
//
// A FLOOR PLAN IS NOT WHAT A TRAVELLER HAS. Standing in a pier, the question is
// "is it ahead of me or behind me, and which side", and a top-down drawing
// answers a different one -- where things are relative to the building. Two
// versions of this screen were built that way and neither was usable.
//
// SO THE CORRIDOR RUNS DOWN THE SCREEN and everything hangs off it: gates on
// the side they are actually on, restaurants beside them, the traveller's own
// position as a line across it. The vertical axis is REAL DISTANCE at a fixed
// scale, so the gap between two things on screen is the gap between them in the
// building.
//
// ── AND IT IS NOT A MAP, SO IT NEEDS NO MAP ENGINE ──────────────────────────
//
// NO WEBVIEW, NO MAPLIBRE, NO SVG, NO CDN. A corridor is one-dimensional: a
// ScrollView and absolutely positioned rows. That deletes the whole offline
// problem the WebView version had -- the library came from a CDN and the map
// did not come up without a network, at an airport, which is where this screen
// is used.
//
// IT ALSO ANSWERS THE THREE COMPLAINTS AT ONCE. Zoom sensitivity, blank frames
// while zooming and dots floating with no context were all artefacts of free
// two-dimensional panning. There is no zoom here, only scroll, and every dot is
// attached to the corridor by construction.
import { useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable,
  type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import type { Terminal, Pier, Gate } from '../lib/terminals';
import type { Placed } from '../lib/terminalgeo';
import {
  drawablePiers, gatesOn, outletsOn, extentOf, sideOf, wayThere, metresWord,
  type PierGateRow, type PierOutlet,
} from '../lib/piers';
// THE DIM TONE. This file declared its own copy of the same rgba; see the note
// in lib/cards for why one export replaced four declarations. It is the only
// thing this view takes from there -- the corridor draws no cards.
import { DIM } from '../lib/cards';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';
const INK = '#e2e2e2';
const DIMMER = 'rgba(226,226,226,0.28)';
const GREEN = '#4ade80';
const AMBER = '#fbbf24';
const SURFACE = 'rgba(255,255,255,0.04)';

// ── A FIXED SCALE, NOT A FITTED ONE ─────────────────────────────────────────
//
// EVERY PIER IS DRAWN AT THE SAME METRES-PER-PIXEL, so a long walk LOOKS like a
// long walk and two piers can be compared. Fitting each pier to the screen
// would make a 96-metre concourse and a 909-metre one the same length, which is
// the single most useful fact about them thrown away for tidiness.
//
// 1.5 px/m PUTS ADJACENT GATES ABOUT SIXTY POINTS APART -- stands sit 40-60m
// along a concourse -- which is enough for a label without stacking.
const PX_PER_M = 1.5;
const PAD_PX = 28;
const MIN_H = 260;

type Props = {
  terminal: Terminal;
  placed: Placed[];
  /** Index into terminal.gates of the gate the traveller tapped, or null. */
  hereGi: number | null;
  onSetHere: (gi: number | null) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The traveller's own gates, marked so they can find themselves on the pier. */
  arrival: Gate | null;
  departure: Gate | null;
};

export default function CorridorView({
  terminal, placed, hereGi, onSetHere, selected, onSelect, arrival, departure,
}: Props) {
  const piers = useMemo(() => drawablePiers(terminal), [terminal]);
  const [pierIdx, setPierIdx] = useState(0);
  const pier: Pier | null = piers[Math.min(pierIdx, piers.length - 1)] ?? null;

  const gates = useMemo(
    () => (pier === null ? [] : gatesOn(terminal, pier)), [terminal, pier]);
  const outlets = useMemo(
    () => (pier === null ? [] : outletsOn(terminal, pier, placed)), [terminal, pier, placed]);

  // The pier the tapped gate is actually on, so tapping a gate on pier 2 and
  // then switching to pier 1 does not leave a position marker floating.
  const hereAlong = useMemo(() => {
    if (hereGi === null || pier === null) return null;
    const row = gates.find(g => g.gi === hereGi);
    return row === undefined ? null : row.at.along;
  }, [hereGi, gates, pier]);

  const extent = useMemo(
    () => extentOf([...gates, ...outlets.map(o => ({ at: o.at }))]), [gates, outlets]);
  const height = Math.max(MIN_H, (extent.hi - extent.lo) * PX_PER_M + PAD_PX * 2);
  const y = (along: number) => PAD_PX + (along - extent.lo) * PX_PER_M;

  // ── THE OVERVIEW STRIP ──────────────────────────────────────────────────
  //
  // A NINE-HUNDRED-METRE PIER IS FOURTEEN HUNDRED POINTS OF SCROLL and nothing
  // on screen says how much of it you are looking at. The strip is the whole
  // pier at once with the visible window marked on it -- the one thing the
  // scroll itself cannot show.
  const [viewH, setViewH] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const scroller = useRef<ScrollView>(null);

  const onLayout = (e: LayoutChangeEvent) => setViewH(e.nativeEvent.layout.height);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setScrollY(e.nativeEvent.contentOffset.y);

  // NO DRAWABLE PIER IS AN ANSWER, NOT A BLANK. HKG Terminal 1's main hall is
  // thirty-six gates at aspect 1.1 and JFK Terminal 5 is 2.2 -- rooms, not
  // corridors. Drawing them as one would put things ahead of and behind each
  // other that are side by side, so the screen says what it is and stops.
  if (pier === null) {
    const halls = terminal.piers.filter(p => p.kind === 'hall').length;
    return (
      <View style={st.wrap}>
        <View style={st.head}>
          <Text style={st.title}>{terminal.key}</Text>
          <Text style={st.sub}>{`${terminal.gates.length} gates`}</Text>
        </View>
        <View style={st.empty}>
          <Text style={st.emptyTitle}>{'This one is a hall, not a corridor'}</Text>
          <Text style={st.emptyBody}>
            {halls > 0
              ? 'Its gates are spread across a room rather than along a walkway, so '
                + 'there is no "ahead of you" to draw. Everything here is in the list '
                + 'below.'
              : 'We have no walkable shape for this terminal. Everything here is in '
                + 'the list below.'}
          </Text>
        </View>
      </View>
    );
  }

  const single = pier.kind === 'single';

  return (
    <View style={st.wrap}>
      <View style={st.head}>
        <Text style={st.title}>{terminal.key}</Text>
        <Text style={st.sub}>
          {`${Math.round(pier.lengthM)}m · ${gates.length} gates`}
          {outlets.length > 0 ? ` · ${outlets.length} places` : ''}
        </Text>
      </View>

      {/* MORE THAN ONE CORRIDOR IS THE NORMAL CASE, not an edge one: fourteen
          of the twenty terminals we hold have two or more. */}
      {piers.length > 1 && (
        <View style={st.pierRow}>
          {piers.map((p, i) => (
            <Pressable
              key={i}
              onPress={() => { setPierIdx(i); scroller.current?.scrollTo({ y: 0, animated: false }); }}
              style={[st.pierChip, i === pierIdx && st.pierChipOn]}
            >
              <Text style={[st.pierChipText, i === pierIdx && st.pierChipTextOn]}>
                {gatesOn(terminal, p)[0]?.gate.ref ?? `Pier ${i + 1}`}
                {'–'}
                {gatesOn(terminal, p).slice(-1)[0]?.gate.ref ?? ''}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={st.frame}>
        <ScrollView
          ref={scroller}
          style={st.scroll}
          onLayout={onLayout}
          onScroll={onScroll}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ height }}>
            {/* THE CORRIDOR ITSELF. Everything else is positioned against it,
                which is the whole point: a gate dot is ON the line rather than
                floating near it. */}
            <View style={[st.spine, single && st.spineSingle]} />

            {hereAlong !== null && (
              <View style={[st.hereBand, { top: y(hereAlong) - 1 }]}>
                <View style={st.hereDot} />
                <Text style={st.hereText}>{'you are here'}</Text>
              </View>
            )}

            {gates.map(g => (
              <GateRow
                key={g.gi}
                row={g}
                top={y(g.at.along)}
                single={single}
                isHere={g.gi === hereGi}
                // IDENTITY, NOT ref. Three separate stands are signed A6 at JFK
                // Terminal 4; comparing the string would light up all three.
                role={g.gate === arrival ? 'arr' : g.gate === departure ? 'dep' : null}
                away={hereAlong === null ? null : wayThere(gates, hereAlong, g.at.along)}
                onPress={() => onSetHere(g.gi === hereGi ? null : g.gi)}
              />
            ))}

            {outlets.map(o => (
              <OutletRow
                key={o.placed.d.sourceId}
                row={o}
                top={y(o.at.along)}
                single={single}
                on={o.placed.d.sourceId === selected}
                away={hereAlong === null ? null : metresWord(o.at.along - hereAlong)}
                onPress={() => onSelect(
                  o.placed.d.sourceId === selected ? null : o.placed.d.sourceId)}
              />
            ))}
          </View>
        </ScrollView>

        {height > viewH && viewH > 0 && (
          <View style={st.strip}>
            <View
              style={[st.stripWindow, {
                top: (scrollY / height) * viewH,
                height: Math.max(18, (viewH / height) * viewH),
              }]}
            />
          </View>
        )}
      </View>

      {hereGi === null ? (
        <Text style={st.note}>
          {'Tap the gate you are nearest and everything below reads from there.'}
        </Text>
      ) : null}

      {single && (
        <Text style={st.note}>
          {'Every gate on this pier is on one side, so nothing is drawn opposite. '
            + 'That is the concourse, not a gap in our data.'}
        </Text>
      )}

      {outlets.length === 0 && (
        <Text style={st.note}>
          {'We have no positions for food on this pier — the airport does not publish '
            + 'them. The gates and distances are still right.'}
        </Text>
      )}

      <Text style={st.attrib}>{'Gate positions © OpenStreetMap contributors'}</Text>
    </View>
  );
}

function GateRow({ row, top, single, isHere, role, away, onPress }: {
  row: PierGateRow; top: number; single: boolean; isHere: boolean;
  role: 'arr' | 'dep' | null; away: string | null; onPress: () => void;
}) {
  const side = single ? 'left' : sideOf(row.at);
  const right = side === 'right';
  return (
    <Pressable onPress={onPress} style={[st.item, { top: top - 13 }]} hitSlop={6}>
      <View style={[st.itemInner, right && st.itemRight]}>
        <View style={[st.gateDot, role !== null && st.gateDotMine,
          isHere && st.gateDotHere]} />
        <View style={[st.gateWords, right && st.alignRight]}>
          <Text style={[st.gateRef, role !== null && st.gateRefMine,
            isHere && st.gateRefHere]}>{row.gate.ref}</Text>
          {role !== null && (
            <Text style={st.gateMine}>{role === 'arr' ? 'you landed here' : 'your gate'}</Text>
          )}
          {away !== null && away !== 'you are here' && (
            <Text style={st.gateAway}>{away}</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function OutletRow({ row, top, single, on, away, onPress }: {
  row: PierOutlet; top: number; single: boolean; on: boolean;
  away: string | null; onPress: () => void;
}) {
  // ON THE OPPOSITE SIDE FROM THE GATES WHERE THERE IS ONLY ONE SIDE. A
  // single-sided pier has all its gates left, so food goes right rather than
  // being stacked on top of them.
  const side = single ? 'right' : sideOf(row.at);
  const right = side !== 'left';
  // A HOLLOW MARKER MEANS THE POSITION CAME FROM A GATE, not from the airport.
  const loose = row.placed.source === 'gate';
  return (
    <Pressable onPress={onPress} style={[st.item, { top: top - 11 }]} hitSlop={6}>
      <View style={[st.itemInner, right && st.itemRight, st.outletInner]}>
        <View style={[st.foodDot, loose && st.foodDotLoose, on && st.foodDotOn]} />
        <View style={[st.gateWords, right && st.alignRight]}>
          <Text style={[st.foodName, on && st.foodNameOn]} numberOfLines={1}>
            {row.placed.d.name}
          </Text>
          {away !== null && <Text style={st.gateAway}>{away}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

const SPINE_LEFT = '46%';

const st = StyleSheet.create({
  wrap: { marginTop: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    paddingHorizontal: 16, marginBottom: 6 },
  title: { fontFamily: MONO_BOLD, fontSize: 13, color: INK, letterSpacing: 1 },
  sub: { fontFamily: MONO, fontSize: 11, color: DIM },

  pierRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16,
    marginBottom: 8 },
  pierChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: 'transparent' },
  pierChipOn: { borderColor: GREEN },
  pierChipText: { fontFamily: MONO, fontSize: 11, color: DIM },
  pierChipTextOn: { color: INK },

  frame: { height: 380, marginHorizontal: 16, borderRadius: 14, overflow: 'hidden',
    backgroundColor: SURFACE },
  scroll: { flex: 1 },

  spine: { position: 'absolute', left: SPINE_LEFT, top: 0, bottom: 0, width: 2,
    backgroundColor: 'rgba(226,226,226,0.16)' },
  spineSingle: { left: '30%' },

  item: { position: 'absolute', left: 0, right: 0, height: 26, justifyContent: 'center' },
  itemInner: { flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 10, paddingRight: 10 },
  itemRight: { flexDirection: 'row-reverse' },
  outletInner: { opacity: 0.95 },
  alignRight: { alignItems: 'flex-end' },
  gateWords: { flexShrink: 1 },

  gateDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: DIM },
  gateDotHere: { backgroundColor: GREEN, width: 11, height: 11, borderRadius: 6 },
  gateRef: { fontFamily: MONO_BOLD, fontSize: 12, color: DIM },
  gateRefHere: { color: GREEN },
  gateAway: { fontFamily: MONO, fontSize: 9, color: DIMMER },
  gateDotMine: { backgroundColor: AMBER, width: 9, height: 9, borderRadius: 5 },
  gateRefMine: { color: AMBER },
  gateMine: { fontFamily: MONO, fontSize: 9, color: AMBER },

  foodDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: INK },
  foodDotLoose: { backgroundColor: 'transparent', borderWidth: 2, borderColor: INK },
  foodDotOn: { backgroundColor: AMBER, borderColor: AMBER },
  foodName: { fontFamily: SANS_SEMI, fontSize: 12, color: INK },
  foodNameOn: { color: AMBER },

  hereBand: { position: 'absolute', left: 0, right: 0, height: 2,
    backgroundColor: 'rgba(74,222,128,0.35)', flexDirection: 'row', alignItems: 'center' },
  hereDot: { position: 'absolute', left: SPINE_LEFT, width: 10, height: 10,
    borderRadius: 6, backgroundColor: GREEN, marginLeft: -4, marginTop: -0 },
  hereText: { position: 'absolute', right: 8, top: -14, fontFamily: MONO,
    fontSize: 9, color: GREEN, letterSpacing: 0.5 },

  strip: { position: 'absolute', right: 4, top: 8, bottom: 8, width: 3,
    borderRadius: 2, backgroundColor: 'rgba(226,226,226,0.08)' },
  stripWindow: { position: 'absolute', left: 0, right: 0, borderRadius: 2,
    backgroundColor: 'rgba(226,226,226,0.35)' },

  empty: { marginHorizontal: 16, padding: 16, borderRadius: 14, backgroundColor: SURFACE },
  emptyTitle: { fontFamily: SANS_SEMI, fontSize: 15, color: INK },
  emptyBody: { fontFamily: SANS, fontSize: 12, color: DIM, marginTop: 6, lineHeight: 18 },

  note: { fontFamily: SANS, fontSize: 11, color: DIM, paddingHorizontal: 16,
    marginTop: 8, lineHeight: 16 },
  attrib: { fontFamily: SANS, fontSize: 9, color: DIMMER, paddingHorizontal: 16,
    marginTop: 6 },
});
