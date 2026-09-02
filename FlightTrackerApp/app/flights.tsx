// MY FLIGHTS. THE JOURNEY THE USER IS CURRENTLY TAKING, AND NOTHING ELSE.
//
// NOT A LIST AND NOT A RECORDS SCREEN. The watchlist is home's: twenty flights
// somebody is following, sorted by relevance, each one a row. This is the one
// they are ON, opened out — the legs in the order they are flown, and under each
// leg only what is useful at the point the traveller has actually reached.
//
// A BOOKINGS SCREEN IS NOT THIS. PNRs, tickets, seats, fares and past journeys
// as records all belong to a screen that does not exist yet, and nothing here is
// built in anticipation of it. The past-flights sheet at the foot of this page is
// an exit, not an archive: it lists what has flown and offers nothing to do with
// it.
//
// WHAT DECIDES WHAT IS SHOWN IS THE PHASE, and the phase is derived from the
// clock and the reminder arithmetic that already exists. See phaseOf and BLOCKS.
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TouchableOpacity,
  Modal, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { SavedFlight } from '../lib/storage';
// THE STORE AND ITS RULES. tripsOf, isOwned and isArchived are pure functions of
// a list and a clock; the two callbacks are the only things here that write.
import {
  useSaved,
  tripsOf,
  isOwned,
  isArchived,
  departureTs,
  effectiveStatus,
  sortSavedByRelevance,
  OWN_MSG,
} from '../lib/saved';
// THE PHASE BOUNDARIES, AND THEY ARE ALREADY WRITTEN. See phaseOf.
//
// IMPORTING THIS COSTS NOTHING NEW. lib/reminders sets a notification handler at
// module scope, and lib/saved already imports it, so the module is loaded before
// this screen renders whatever this file does.
import { reminderTimes } from '../lib/reminders';
// TWO OF THE THREE QUESTIONS THIS APP ASKS OF A TIME. clock24 reads the digits
// out of a stored ISO field; clockInZone takes an instant that was COMPUTED
// rather than stored, which is what reminderTimes hands back. See lib/time.
import { clock24, clockInZone } from '../lib/time';
// formatClock IS HOME'S HEADER LINE, and it is imported rather than restated
// because this screen now wears the same header. See the note where it lives.
import { StatusLine, routeDateLabel, formatClock, CD_GREEN } from '../lib/flightstatus';
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG } from '../lib/cards';
import {
  GlassLayers, g,
  EASE_OUT, EASE_IN, CAL_RISE,
  CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  // THE SMALL PANEL'S OWN MOTION. A menu is not a sheet: it travels less and
  // arrives quicker. See Menu.
  OVERLAY_RISE, PANEL_IN_MS, PANEL_OUT_MS,
} from '../lib/glass';
import { useToast } from '../lib/toast';
// THE APP'S ONE HAPTIC. components/swipe fires it when a full swipe arms and
// when a long press becomes a menu -- both moments where a gesture turns into an
// offer. Opening this menu is the same kind of moment, and a second weight for
// it would be a second vocabulary.
import { EXPAND_HAPTIC } from '../components/swipe';
// THE ONE FRACTION, and it is the card's. A second implementation of "how far
// along is this flight" would be a bar on this screen that disagrees with the bar
// on the card for the same record.
import { computeProgress } from '../components/FlightCard';

// Declared here rather than imported from a screen or a component, exactly as
// every module in lib/ declares its own. These are the family names _layout
// registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
// The semibold face, loaded in _layout with the rest. The screen's title is the
// only thing here that uses it -- see st.title.
const SANS_SEMI = 'Inter_600SemiBold';

// AMBER MEANS "SOMETHING IS HAPPENING THAT YOU SHOULD KNOW ABOUT" and it is the
// app's existing #fbbf24 — CD_LATE's value, spelled here rather than imported
// because this is a boarding state rather than a delay and borrowing the name
// would say it was one.
const BOARDING_AMBER = '#fbbf24';
// getStatusColor('landed') exactly. A finished leg is grey; it is never green.
const LANDED_GREY = '#8e8e93';
const DIM = 'rgba(226,226,226,0.4)';
const EM_DASH = '—';

// A real value, or nothing. "N/A" is what the backend writes for an absent field
// and the stored record keeps it, so it is a sentinel to be read rather than a
// string to be shown — the same rule hasTime states on the flight card.
function shown(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' || s === 'N/A' ? null : s;
}

// ── WHERE IN THE JOURNEY THIS LEG IS ────────────────────────────────────────
//
// FIVE PHASES, AND THEY ARE READ OFF WHAT ALREADY EXISTS. Nothing new is stored
// and no new thresholds are invented: the status decides the last two, and
// reminderTimes decides the first three.
//
// reminderTimes RETURNS null FOR AN INSTANT ALREADY PAST — see its own note,
// "A time already past is null rather than an error" — which is what makes it
// readable as a phase boundary. `leave` going null means the leave-now moment has
// gone, so the traveller is at or heading to the airport; `evening` going null
// means the evening before has gone, so it is the day of the flight. Two
// booleans, no second set of thresholds to keep in step with the reminders.
//
// A CANCELLED OR DIVERTED FLIGHT LANDS IN 'far', AND THAT IS DELIBERATE.
// effectiveStatus returns the provider's word for both, so neither takes the
// landed or active branch, and their reminder times behave like any other
// scheduled flight's. StatusLine at the top of the card already prints the word
// in its own colour, which is the whole of what there is to say — inventing a
// sixth phase for it would mean building a block with no data behind it.
type Phase = 'far' | 'dayOf' | 'airport' | 'air' | 'landed';

function phaseOf(leg: SavedFlight, now: number): Phase {
  const s = effectiveStatus(leg, now);
  if (s === 'landed') return 'landed';
  if (s === 'active') return 'air';
  const t = reminderTimes(leg, now);
  // NOTHING TO TIME AGAINST, so show what we have rather than guessing at a
  // stage. A pre-v3 record carries no ISO and an airport with no IANA zone
  // cannot be put on a clock; both arrive here.
  if (departureTs(leg) === null) return 'far';
  if (t.leave === null) return 'airport';
  if (t.evening === null) return 'dayOf';
  return 'far';
}

// ── ONE FACT, LABELLED, KEEPING ITS PLACE ───────────────────────────────────
//
// AN EM DASH RATHER THAN A HIDDEN CELL, which is AirportTiles' rule on the
// flight card and is right for the same reason here: Gate is where Gate is
// whether or not a gate has been assigned, so a glance at the same spot answers
// the same question every time, and the number appears where the eye already is
// instead of shoving its neighbours sideways.
function Cell({ label, value, big }: { label: string; value: string | null; big?: boolean }) {
  return (
    <View style={st.cell}>
      <Text style={st.cellLabel} numberOfLines={1}>{label}</Text>
      <Text style={big === true ? st.cellBig : st.cellValue} numberOfLines={1}>
        {value ?? EM_DASH}
      </Text>
    </View>
  );
}

// A LABEL AND A TIME ON ONE ROW. The countdown block's shape, kept apart from
// Cell because these are stacked rather than laid out in a row and the value is
// a step smaller.
function TimeRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={st.timeRow}>
      <Text style={st.cellLabel}>{label}</Text>
      <Text style={st.timeValue}>{value}</Text>
    </View>
  );
}

// ── WHAT A LEG SHOWS, BY PHASE ──────────────────────────────────────────────
//
// AN ORDERED ARRAY, AND THAT IS THE WHOLE POINT OF THE INDIRECTION. A leg card
// maps over this, keeps the entries whose `phases` include the leg's own, calls
// render, and drops the nulls. Adding boarding cards, food, a disruption notice
// or a seat map later is ONE ENTRY HERE and touches nothing else: not the card,
// not the phase function, not the screen. Removing one is deleting an entry.
//
// render MAY RETURN null, and several do. A block whose data is absent renders
// nothing rather than an empty container — the phase says the block is
// APPLICABLE, the data says whether there is anything to draw.
//
// ONLY WHAT REAL DATA SUPPORTS. Every value below comes off the stored record or
// out of reminderTimes. Nothing is estimated and nothing is derived from a rule
// this app has not already written down.
type Block = {
  id: string;
  phases: Phase[];
  render: (leg: SavedFlight, now: number) => ReactNode | null;
};

const BLOCKS: Block[] = [
  {
    // THE TWO REMINDERS, AS TIMES RATHER THAN AS A PROMISE. Days out, the useful
    // fact is not a countdown to the departure — the status line above already
    // carries that — it is when this app is going to interrupt you about it.
    id: 'countdown',
    phases: ['far'],
    render: (leg, now) => {
      const t = reminderTimes(leg, now);
      // THE ORIGIN AIRPORT'S ZONE, NOT THE DEVICE'S. Every other time on this
      // leg card is the airport's — the departure, the arrival, the actual — and
      // two unlabelled clocks on one card is worse than one missing line. A row
      // that cannot say which clock it is on does not appear: clockInZone
      // returning null renders nothing rather than falling back to a value the
      // reader would have no way of placing.
      const evening = clockInZone(t.evening, leg.from.timezone);
      const leave = clockInZone(t.leave, leg.from.timezone);
      if (evening === null && leave === null) return null;
      return (
        <View style={st.block}>
          {evening !== null && <TimeRow label="the evening before" value={evening} />}
          {leave !== null && <TimeRow label="leave by" value={leave} />}
        </View>
      );
    },
  },
  {
    // THE DAY OF THE FLIGHT, AND ONE NUMBER MATTERS. Everything else on this
    // card is reference; this is the instruction.
    //
    // GREEN, WHICH IS THE ONE THING THE GREEN IS FOR: live and actionable. It is
    // the only green on a leg card outside the progress bar.
    id: 'leave',
    phases: ['dayOf'],
    render: (leg, now) => {
      // THE ORIGIN AIRPORT'S ZONE, NOT THE DEVICE'S, for the reason given at the
      // countdown block above: this card's other times are all the airport's, and
      // an unlabelled second clock beside them would be unreadable. Null renders
      // nothing at all rather than a time nobody could place.
      const leave = clockInZone(reminderTimes(leg, now).leave, leg.from.timezone);
      if (leave === null) return null;
      return (
        <View style={st.block}>
          <Text style={st.cellLabel}>{'leave by'}</Text>
          <Text style={st.leaveValue}>{leave}</Text>
          <View style={st.cells}>
            <Cell label="Terminal" value={shown(leg.from.terminal)} />
            <Cell label="Check-in" value={shown(leg.from.checkinDesk)} />
          </View>
        </View>
      );
    },
  },
  {
    // ── STANDING IN THE TERMINAL ──
    //
    // THERE IS NO BOARDING TIME IN THIS APP'S DATA, AND NONE MAY BE INVENTED.
    // The backend's movement object carries terminal, gate, checkInDesk and
    // baggageBelt and nothing else — no boarding time, no gate-closes time, no
    // door time. Deriving one from the departure ("boarding is 40 minutes
    // before") would be this app stating a fact it has not been told, on a
    // screen somebody is reading while deciding whether to walk to the gate.
    // Do not add one.
    //
    // WHAT THERE IS is the provider's own raw word, which says whether boarding
    // has STARTED. That is a state rather than a time, and it is printed as one.
    id: 'atAirport',
    phases: ['airport'],
    render: (leg) => {
      const raw = String(leg.rawStatus ?? '').trim().toLowerCase();
      const boarding =
        raw === 'boarding' ? 'boarding' :
        raw === 'gateclosed' ? 'gate closed' :
        null;
      return (
        <View style={st.block}>
          <View style={st.cells}>
            <Cell label="Gate" value={shown(leg.from.gate)} />
            <Cell label="Terminal" value={shown(leg.from.terminal)} />
          </View>
          {boarding !== null && <Text style={st.boarding}>{boarding}</Text>}
        </View>
      );
    },
  },
  {
    // IN THE AIR. How far along, when it lands, and where the bags come out if
    // the airline has said yet.
    id: 'inAir',
    phases: ['air'],
    render: (leg, now) => {
      const p = computeProgress(leg, now);
      const arr = shown(clock24(leg.to.estimatedIso ?? leg.to.scheduledIso, leg.to.scheduled));
      const belt = shown(leg.to.baggage);
      if (p === null && arr === null && belt === null) return null;
      return (
        <View style={st.block}>
          {/* NOT ANIMATED, AND IT DOES NOT NEED TO BE. The card's ProgressBar
              eases to its value because it appears all at once when a result
              opens; this is redrawn on the minute tick with the rest of the
              screen, and a bar that eases every sixty seconds is a bar that is
              usually mid-animation. A width is enough. */}
          {p !== null && (
            <View style={st.track}>
              <View style={[st.fill, { width: `${Math.round(p * 100)}%` }]} />
            </View>
          )}
          <View style={st.cells}>
            {arr !== null && <Cell label="Lands" value={arr} />}
            {belt !== null && <Cell label="Belt" value={belt} />}
          </View>
        </View>
      );
    },
  },
  {
    // LANDED, AND THE BELT IS WHAT IS LEFT TO WANT. It is the one thing a
    // traveller walking off an aircraft is looking for, so it is the one thing
    // on this card at 20.
    //
    // GREY, NEVER GREEN. A finished flight is not live and must not be coloured
    // as though it were.
    id: 'landed',
    phases: ['landed'],
    render: (leg) => {
      const arr = shown(clock24(
        leg.to.actualIso ?? leg.to.estimatedIso ?? leg.to.scheduledIso,
        leg.to.actual || leg.to.scheduled,
      ));
      return (
        <View style={st.block}>
          <View style={st.cells}>
            <Cell label="Arrived" value={arr} />
            <Cell label="Belt" value={shown(leg.to.baggage)} big />
          </View>
        </View>
      );
    },
  },
];

// ── ONE LEG OF THE TRIP ─────────────────────────────────────────────────────
//
// A VISIBLE REMOVE CONTROL, NOT A SWIPE. The watchlist rows are swiped because
// they are a list of many and the gesture is worth learning once; a trip has one
// or two legs and this is the only action on them. A gesture nobody would find
// is not an affordance.
//
// IT DISOWNS AND DOES NOT UNSAVE. The flight goes back to the watchlist with its
// record, its reminders and its archive decision intact — see disownFlight.
function Leg({ leg, now, onRemove }: {
  leg: SavedFlight; now: number; onRemove: () => void;
}) {
  const phase = phaseOf(leg, now);
  return (
    <View style={st.leg}>
      <View style={st.legHead}>
        <Text style={st.legNum}>{leg.flightNumber}</Text>
        <Text style={st.legRoute} numberOfLines={1}>
          {`${leg.from.iata} → ${leg.to.iata}`}
        </Text>
        <Pressable
          onPress={onRemove}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel={`remove ${leg.flightNumber} from this trip`}
        >
          <Svg width={16} height={16} viewBox="0 0 24 24">
            <Path d="M19 5 5 19" fill="none" stroke="rgba(226,226,226,0.5)" strokeWidth={1.75} strokeLinecap="round" />
            <Path d="M5 5l14 14" fill="none" stroke="rgba(226,226,226,0.5)" strokeWidth={1.75} strokeLinecap="round" />
          </Svg>
        </Pressable>
      </View>
      <StatusLine f={leg} now={now} numberOfLines={1} />
      {BLOCKS.filter(b => b.phases.includes(phase)).map(b => {
        const node = b.render(leg, now);
        return node === null ? null : <View key={b.id}>{node}</View>;
      })}
    </View>
  );
}

// ── ONE MODAL, AND WHICH THING IS IN IT ─────────────────────────────────────
//
// THREE MODALS BECAME ONE, AND THE SEQUENCING PROBLEM WENT WITH THEM.
//
// WHAT WAS WRONG, AND IT WAS NOT THE TIMING. The menu and the import sheet were
// two Modals that had to hand off to each other, and React Native cannot present
// one while another is mounted: on iOS a Modal is a presented view controller,
// and the second presentation is dropped with nothing thrown and nothing shown.
// Two fixes were tried against that -- a completion callback, then a
// requestAnimationFrame after the unmount had committed -- and both were bets on
// a native presentation lifecycle this code does not control. The JS ran
// correctly in both: the state was set, the second Modal rendered, and nothing
// appeared.
//
// SO THERE IS NOTHING TO HAND OFF ANY MORE. One state says WHICH overlay is up,
// one Modal is mounted whenever any of them is, and going from the menu to a
// sheet is a CONTENT SWAP INSIDE a Modal that never unmounts. There is no second
// presentation for the platform to refuse.
//
// null IS "NOTHING IS UP", which is also the Modal's own visible test.
type Overlay = 'menu' | 'import' | 'past' | null;

// WHICH TIMINGS AN OVERLAY TAKES, DERIVED RATHER THAN STORED. A menu arrives and
// leaves on the panel's pair; a sheet on the calendar's.
//
// THE RISE AND THE SCALE ARE NOT HERE. Each component spells its own, because
// each knows its own shape -- a sheet rises CAL_RISE and scales, a menu rises
// OVERLAY_RISE and does not -- and returning fields nothing reads would be a
// second place for them to be kept in step.
//
// THREE READERS, WHICH IS WHY IT IS A FUNCTION AND NOT THREE TERNARIES:
// openOverlay and swapOverlay take inMs, closeOverlay takes outMs, and inlining
// would write the same branch three times, twice identically.
function motionOf(o: Exclude<Overlay, null>) {
  return o === 'menu'
    ? { inMs: PANEL_IN_MS, outMs: PANEL_OUT_MS }
    : { inMs: CAL_IN_MS, outMs: CAL_OUT_MS };
}

// ── THE SHEET, AND IT IS THE ARCHIVE SHEET'S STRUCTURE ──────────────────────
//
// Nothing about the structure differs from app/index.tsx's archive sheet: the
// same Modal flags, the same scrim Pressable, the same full-screen dim on its
// own value, the same CAL_RISE / 0.96 rise-scale-fade, the same shell, glass,
// edge and swallowing body, the same head with its spacer, title and red close X.
//
// THE Modal, THE SCRIM AND THE DIM ARE NOT HERE ANY MORE. They are the screen's,
// mounted once above whichever panel is showing -- see Overlay. What is left is
// the panel itself, which is all this component ever really was.
function Sheet({ panel, title, onClose, children }: {
  panel: Animated.Value; title: string; onClose: () => void; children: ReactNode;
}) {
  return (
        <Animated.View
          style={[
            g.sheetShell,
            st.sheet,
            {
              opacity: panel,
              transform: [
                { translateY: panel.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                { scale: panel.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
              ],
            },
          ]}
        >
          <GlassLayers />
          <View style={g.sheetEdge} pointerEvents="none" />
          {/* Swallows the tap so the scrim's dismiss does not fire through. */}
          <Pressable style={[g.sheetBody, g.sheetBodyFill]}>
            <View style={g.sheetHead}>
              <View style={g.sheetHeadSpacer} />
              <Text style={g.sheetTitle}>{title}</Text>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={onClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={g.sheetClose}
              >
                {/* The app's own close X, character for character. */}
                <Svg width={20} height={20} viewBox="0 0 24 24">
                  <Path d="M19 5 5 19" fill="none" stroke="rgba(248,113,113,0.55)" strokeWidth={1.75} strokeLinecap="round" />
                  <Path d="M5 5l14 14" fill="none" stroke="rgba(248,113,113,0.55)" strokeWidth={1.75} strokeLinecap="round" />
                </Svg>
              </TouchableOpacity>
            </View>
            {children}
          </Pressable>
        </Animated.View>
  );
}

// ── THE MENU, AND IT IS THE FLIGHT CARD'S LONG-PRESS MENU ───────────────────
//
// A MENU, NOT A SHEET, AND THE DIFFERENCE IS IN EVERY NUMBER. A sheet takes over
// the screen, holds a list of unknown length, and therefore has a head, a title,
// a close button and a 62% floor. This asks one question with two answers, so it
// is the small floating panel components/FlightCard.tsx already uses for exactly
// that: the overlay's rise rather than the sheet's, the panel's timings rather
// than the calendar's, and no scale at all.
//
// THE SAME MATERIAL THOUGH. sheetShell, GlassLayers and sheetEdge, in that
// order, exactly as every other floating surface in this app. A menu made of
// something else would be a fifth material for one control.
//
// NO HEAD AND NO CLOSE BUTTON, for the reason stated at the card's own menu: a
// title bar over two rows would be more chrome than content, and the scrim
// dismisses.
//
// THE Modal AND THE SCRIM ARE THE SCREEN'S, exactly as they are for the sheet.
function Menu({ panel, children }: { panel: Animated.Value; children: ReactNode }) {
  return (
        <Animated.View
          style={[
            g.sheetShell,
            st.menu,
            {
              opacity: panel,
              transform: [{
                translateY: panel.interpolate({
                  inputRange: [0, 1], outputRange: [OVERLAY_RISE, 0],
                }),
              }],
            },
          ]}
        >
          <GlassLayers />
          <View style={g.sheetEdge} pointerEvents="none" />
          {/* Swallows the tap so the scrim's dismiss does not fire through. */}
          <Pressable style={st.menuBody}>{children}</Pressable>
        </Animated.View>
  );
}

// ONE ROW OF THE MENU. Inter at 15, which is this app's working size for a thing
// being chosen -- the same size and family the card's menu row uses.
function MenuRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      // THE HAPTIC LEADS THE ACTION, so the confirmation lands with the finger
      // rather than after whatever the row goes on to do.
      onPress={() => { EXPAND_HAPTIC(); onPress(); }}
      style={st.menuRow}
      accessibilityRole="button"
    >
      <Text style={st.menuLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function Flights() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { savedFlights, ownFlight, disownFlight } = useSaved();
  const { showToast } = useToast();

  // THIS SCREEN'S OWN MINUTE TICK, and it is not on the context. The phase, the
  // countdowns, the progress bar and the current/past split are all functions of
  // the clock and all of them are read HERE, so the clock lives here — see the
  // note at the top of lib/saved.tsx for why a shared `now` would re-render every
  // screen in the app once a minute for one screen's benefit. lib/flightcard.tsx
  // keeps an identical one for the card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  // tripsOf ALREADY GROUPED AND ORDERED THEM. It puts the legs of each trip in
  // departure order and the trips themselves by their earliest leg still to fly,
  // with finished trips last — so all that is left here is the split, which is
  // against this screen's own clock. See the note at tripsOf: it deliberately
  // filters nothing, exactly as index.tsx makes its own archive split.
  const trips = useMemo(() => tripsOf(savedFlights, now), [savedFlights, now]);
  const current = useMemo(
    () => trips.filter(legs => legs.some(l => !isArchived(l, now))),
    [trips, now],
  );
  const past = useMemo(
    () => trips.filter(legs => legs.every(l => isArchived(l, now))),
    [trips, now],
  );

  // WHAT CAN BE IMPORTED: watched, not already owned, not already archived.
  // Sorted by the list's own relevance rule so the sheet reads in the same order
  // the watchlist does.
  const importable = useMemo(
    () => sortSavedByRelevance(
      savedFlights.filter(f => !isOwned(f) && !isArchived(f, now)), now),
    [savedFlights, now],
  );

  // ── WHAT IS UP, AND THE TWO VALUES THAT DRAW IT ───────────────────────────
  //
  // ONE STATE AND ONE PAIR OF VALUES for all three overlays. The panel value
  // drives whichever surface is showing; the scrim value drives the dim behind
  // it, and the two are separate because a SWITCH moves one and not the other.
  const [overlay, setOverlay] = useState<Overlay>(null);
  const panel = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;

  // FROM NOTHING. Both values start at 0 BEFORE the state is set, so the frame
  // the Modal mounts on is already invisible rather than showing the last
  // overlay's resting position for one frame.
  const openOverlay = (o: Exclude<Overlay, null>) => {
    panel.setValue(0);
    scrim.setValue(0);
    setOverlay(o);
    Animated.parallel([
      Animated.timing(scrim, {
        toValue: 1, duration: SCRIM_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(panel, {
        toValue: 1, duration: motionOf(o).inMs, easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  };

  // TO NOTHING. The state goes null in the completion callback, so the Modal is
  // unmounted after the exit rather than cut off at the frame it started on.
  //
  // NO PARAMETER, AND THAT IS DELIBERATE. The version of this that took an
  // "afterwards" callback existed to open a second Modal, and there is no second
  // Modal any more. Leaving the parameter would leave the shape of the bug.
  const closeOverlay = () => {
    if (overlay === null) return;
    Animated.parallel([
      Animated.timing(panel, {
        toValue: 0, duration: motionOf(overlay).outMs, easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(scrim, {
        toValue: 0, duration: SCRIM_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setOverlay(null));
  };

  // ── ONE PANEL OUT, THE NEXT IN, AND THE MODAL NEVER MOVES ─────────────────
  //
  // THIS IS THE WHOLE FIX. Nothing is dismissed and nothing is presented: the
  // Modal stays mounted the entire time and only its CONTENTS change, so there
  // is no second presentation for the platform to refuse.
  //
  // THE SCRIM STAYS UP AND IS NOT ANIMATED. It is the modal state itself -- "you
  // are in something" -- and flashing it off and on between two panels would
  // read as the screen being dismissed and immediately re-summoned, which is
  // precisely the thing that is not happening.
  //
  // PANEL_OUT_MS FOR THE EXIT WHATEVER IS LEAVING, because the only switch this
  // screen has is the menu handing over, and the menu's exit is the panel's.
  const swapOverlay = (o: Exclude<Overlay, null>) => {
    Animated.timing(panel, {
      toValue: 0, duration: PANEL_OUT_MS, easing: EASE_IN, useNativeDriver: true,
    }).start(() => {
      setOverlay(o);
      panel.setValue(0);
      Animated.timing(panel, {
        toValue: 1, duration: motionOf(o).inMs, easing: EASE_OUT, useNativeDriver: true,
      }).start();
    });
  };

  const remove = async (leg: SavedFlight) => {
    await disownFlight(leg);
    showToast(`${leg.flightNumber} removed`);
  };

  // THE SAME REPORT THE CARD'S MENU MAKES, through the same strings. ownFlight
  // calls enableReminders on both its paths, so adding a flight here turns
  // reminders on exactly as adding one from the flight card does -- and two
  // paths into one action must not say different things about it. See OWN_MSG.
  const add = async (f: SavedFlight) => {
    const outcome = await ownFlight(f);
    closeOverlay();
    showToast(OWN_MSG[outcome.remind]);
  };

  // ── ONE CONTROL, TWO WAYS IN BEHIND IT ────────────────────────────────────
  //
  // TWO BUTTONS STACKED WAS TWO ANSWERS TO A QUESTION NOBODY HAD ASKED YET. The
  // screen's whole prompt is "add the flight you're taking"; how it gets added is
  // a second decision, and putting it in front of the first made the empty state
  // a menu with no heading. One button asks, and the menu answers.
  //
  // NEITHER WAY IS A TEXT FIELD. A search input here would be a second command
  // line: the tab bar already owns one and the search screen is where it types.
  // This sends you there rather than reimplementing it.
  //
  // IMPORT IS A SWAP, NOT A HANDOFF. The Modal is already up; only what is in it
  // changes. See swapOverlay for why that is the whole of the fix.
  //
  // SEARCH IS NOT, BECAUSE THE SEARCH SCREEN IS NOT A MODAL. This closes and
  // navigates in the same tick, which leaves the scrim fading over the search
  // screen for the length of the exit. That is visible and it is accepted: the
  // alternative is a completion callback sequencing an overlay against a
  // navigation, which is the shape this change exists to remove -- and unlike
  // the Modal case nothing is LOST here, it is only briefly overlapped.
  const chooseSearch = () => {
    closeOverlay();
    router.push('/search');
  };
  const chooseImport = () => {
    swapOverlay('import');
  };

  // THE PLUS IS THE ONE GREEN THING ON AN EMPTY SCREEN, and that is within the
  // rule rather than an exception to it: green means live and actionable, and on
  // a page with no trips on it this is the only actionable thing there is. The
  // label stays at the ordinary ink -- one mark, not a green button.
  const addButton = (
    <TouchableOpacity
      style={st.addBtn}
      activeOpacity={0.7}
      onPress={() => { EXPAND_HAPTIC(); openOverlay('menu'); }}
      accessibilityRole="button"
      accessibilityLabel="add your flight"
    >
      {/* 20, UP FROM 16. The glyph is the half of this control that says what it
          does; at 16 beside a 15pt label it read as a bullet. */}
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M12 5v14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
        <Path d="M5 12h14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
      </Svg>
      <Text style={st.addLabel}>{'Add your flight'}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      {/* ── THE ONE MODAL ──
          MOUNTED WHENEVER ANYTHING IS UP AND NEVER TWICE. The scrim, the dim and
          the dismissing Pressable are here rather than inside each panel,
          because they belong to the MODAL STATE rather than to whichever surface
          happens to be showing -- which is also what lets a switch leave them
          alone. See Overlay and swapOverlay. */}
      <Modal
        visible={overlay !== null}
        transparent
        animationType="none"
        onRequestClose={closeOverlay}
      >
        <Pressable style={g.routeCalScrim} onPress={closeOverlay}>
          {/* The dim alone, full screen and unblurred. The blur lives inside
              each panel, so outside it the page stays sharp. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: scrim }]}
          />

          {overlay === 'menu' && (
            <Menu panel={panel}>
              <MenuRow label="Search for a flight" onPress={chooseSearch} />
              <MenuRow label="Import from watchlist" onPress={chooseImport} />
            </Menu>
          )}

          {overlay === 'import' && (
            <Sheet panel={panel} title="Import" onClose={closeOverlay}>
              {importable.length === 0 ? (
                <Text style={st.sheetEmpty}>{'Nothing on your watchlist to import.'}</Text>
              ) : (
                <ScrollView style={st.sheetList} showsVerticalScrollIndicator={false}>
                  {importable.map(f => (
                    <TouchableOpacity
                      key={f.id}
                      style={st.importRow}
                      activeOpacity={0.7}
                      onPress={() => add(f)}
                      accessibilityRole="button"
                      accessibilityLabel={`add ${f.flightNumber} to this trip`}
                    >
                      <View style={st.legHead}>
                        <Text style={st.legNum}>{f.flightNumber}</Text>
                        <Text style={st.legRoute} numberOfLines={1}>
                          {`${f.from.iata} → ${f.to.iata}`}
                        </Text>
                      </View>
                      <StatusLine f={f} now={now} numberOfLines={1} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </Sheet>
          )}

          {/* READ-ONLY, AND THAT IS THE WHOLE OF WHAT THIS SHEET IS. A finished
              trip has nothing left to do to it: it cannot be left, its reminders
              are spent, and removing it belongs to the watchlist rather than
              here. Rows with no actions are rows nobody has to be careful
              around.

              AND UNREACHABLE. Its entry point was removed; `overlay` cannot
              become 'past' today. It stays until one comes back. */}
          {overlay === 'past' && (
            <Sheet panel={panel} title="Past flights" onClose={closeOverlay}>
              {past.length === 0 ? (
                <Text style={st.sheetEmpty}>{'Nothing here yet.'}</Text>
              ) : (
                <ScrollView style={st.sheetList} showsVerticalScrollIndicator={false}>
                  {past.map((legs, i) => (
                    <View key={legs[0].tripId ?? String(i)} style={st.pastTrip}>
                      {legs.map(l => (
                        <View key={l.id} style={st.pastRow}>
                          <View style={st.legHead}>
                            <Text style={st.legNum}>{l.flightNumber}</Text>
                            <Text style={st.legRoute} numberOfLines={1}>
                              {`${l.from.iata} → ${l.to.iata}`}
                            </Text>
                            <Text style={st.pastDate}>{routeDateLabel(l.flightDate)}</Text>
                          </View>
                          <Text style={st.landed}>{'landed'}</Text>
                        </View>
                      ))}
                    </View>
                  ))}
                </ScrollView>
              )}
            </Sheet>
          )}
        </Pressable>
      </Modal>

      {/* THE BOTTOM PADDING RUNS THE LAST CONTENT UNDER THE FLOATING BAR, which
          is home's treatment and its reasoning: a blur with nothing behind it is
          a grey pill, and the material only reads as glass while something is
          moving underneath it. */}
      {/* flexGrow ON THE CONTENT CONTAINER, which is what lets the empty state
          centre itself vertically: a flex: 1 child can only fill space its
          parent actually has, and a scroll container sizes to its content
          unless told to fill the viewport. It changes nothing when there IS
          content -- there is no flexing child then, so everything sits at the
          top exactly as before. */}
      <ScrollView
        contentContainerStyle={[st.scroll, st.scrollFill, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={st.brand}>{'>_'}</Text>
        <Text style={st.title}>{'My Flights'}</Text>
        {/* HOME'S OWN CLOCK LINE, character for character: 15pt MONO at 0.4,
            3 under the title. It reads the tick this screen already keeps for
            the phases and the countdowns -- see `now` -- rather than starting a
            second one. */}
        <Text style={st.clock}>{formatClock(now)}</Text>

        {current.length === 0 ? (
          // ── NOTHING YET, AND IT IS THE CENTRE OF THE SCREEN ──
          //
          // THE SEARCH SCREEN'S OWN NO-RESULTS TREATMENT, character for
          // character: 20pt Inter REGULAR at 0.6 over 11pt Inter at 0.4, both
          // centred, on routeEmptyHead's 28 and routeEmptyBody's 18 line
          // heights. Not semibold -- an empty state that shouts reads as an
          // error, and this is not one. See routeEmptyWrap in app/search.tsx.
          //
          // flex: 1 RATHER THAN A MARGIN. The block takes everything the header
          // leaves and centres in it, so the copy sits on the optical centre of
          // the space it has at any screen height rather than at a guessed
          // offset from the title.
          <View style={st.emptyWrap}>
            <Text style={st.emptyHead}>{"Add the flight you're taking"}</Text>
            {addButton}
          </View>
        ) : (
          <>
            {/* THE FOCUS TRIP, IN FULL. current[0] is the journey with the
                earliest leg still to fly — tripsOf decided that — so it is the
                one being taken, and it is the only one this screen opens out. */}
            <View style={st.trip}>
              {current[0].map(leg => (
                <Leg key={leg.id} leg={leg} now={now} onRemove={() => remove(leg)} />
              ))}
            </View>

            {/* EVERY OTHER TRIP, AS ONE LINE. They exist and are worth seeing;
                they are not what the screen is about. Nothing is pressable yet
                — a tap that swapped the focus is a decision this screen has not
                been asked to make. */}
            {current.length > 1 && (
              <View style={st.others}>
                {current.slice(1).map((legs, i) => (
                  <Text key={legs[0].tripId ?? String(i)} style={st.otherLine} numberOfLines={1}>
                    {`${legs[0].flightNumber}  ${legs[0].from.iata} → ${legs[legs.length - 1].to.iata}  ${routeDateLabel(legs[0].flightDate)}`}
                  </Text>
                ))}
              </View>
            )}

            {addButton}
          </>
        )}

        {/* The past-flights sheet is still mounted above and has no way in yet. */}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  // 20 either side, so the brand mark sits in the same column as home's and the
  // profile screen's.
  scroll: { paddingHorizontal: 20 },
  // See the note at the ScrollView.
  scrollFill: { flexGrow: 1 },
  brand: { fontFamily: MONO_BOLD, color: CD_GREEN, fontSize: 15 },
  // -- HOME'S GREETING, EXACTLY, AND THE FAMILY CHANGE IS THE POINT --
  //
  // SANS_SEMI RATHER THAN MONO, ASKED FOR DELIBERATELY AND AGAINST WHAT THE
  // PREVIOUS NOTE HERE ARGUED. That note said every screen's title is MONO and a
  // title is a label rather than a greeting. The decision went the other way:
  // these are WORDS SPOKEN TO A PERSON, the same as "Good evening, Jay", and the
  // app should read as one app rather than as a titled screen sitting next to a
  // greeted one. Mono is for machine data -- codes, clocks, flight numbers --
  // and "My Flights" is not one.
  //
  // marginTop 10, NOT 36, which is the greeting's own gap under the >_ mark.
  // Matching the treatment means matching the spacing; 36 was this screen's and
  // put the title half a screen below a mark it belongs to.
  title: { fontFamily: SANS_SEMI, fontSize: 24, color: '#e2e2e2', marginTop: 10 },
  // index.tsx's clock line, character for character.
  clock: { fontFamily: MONO, fontSize: 15, color: 'rgba(226,226,226,0.4)', marginTop: 3 },

  // ── THE EMPTY STATE ──
  // routeEmptyWrap's own padding, so a wrapped line breaks well short of the
  // edges rather than running the full width.
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  // -- routeEmptyHead, ONE STEP LARGER, AND THE DIVERGENCE IS DELIBERATE --
  //
  // THE FAMILY, THE COLOUR AND THE CENTRING ARE THAT STYLE'S, UNCHANGED: Inter
  // regular at rgba(226,226,226,0.6), centred. What differs is the size, and the
  // reason is what the two lines ARE. routeEmptyHead is a RESULT standing in for
  // a list that came back empty -- it has a heading, controls and a whole screen
  // of context above it. This is the entire subject of a page with nothing else
  // on it but a button.
  //
  // 24 IS OFF THE 11/13/15/20 SCALE, and it is here for the same reason the
  // greeting on home is off it: it is the largest thing on its page. Said out
  // loud rather than left for someone to find.
  emptyHead: {
    fontFamily: SANS, fontSize: 24, color: 'rgba(226,226,226,0.6)',
    textAlign: 'center', lineHeight: 32,
  },

  // THE FOCUS TRIP. CARD_GAP between legs, which is the gap between any two
  // cards in this app.
  trip: { marginTop: 20, gap: CARD_GAP },
  leg: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 10,
  },
  legHead: { flexDirection: 'row', alignItems: 'center' },
  legNum: { fontFamily: MONO_BOLD, fontSize: 13, color: '#ffffff' },
  // flex so it takes the middle and pushes the remove control to the edge.
  legRoute: {
    fontFamily: MONO, fontSize: 13, color: 'rgba(226,226,226,0.6)',
    flex: 1, marginLeft: 12,
  },

  // ── THE PHASE BLOCKS ──
  block: { gap: 8 },
  // Two cells across, with the gutter that holds them apart. Not a percentage
  // grid: there are never more than two and they are content-sized.
  cells: { flexDirection: 'row', gap: 24 },
  cell: { gap: 4 },
  cellLabel: { fontFamily: SANS, fontSize: 11, color: DIM },
  cellValue: { fontFamily: MONO, fontSize: 15, color: '#ffffff' },
  cellBig: { fontFamily: MONO, fontSize: 20, color: '#ffffff' },
  timeRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  timeValue: { fontFamily: MONO, fontSize: 13, color: '#ffffff' },
  // The one instruction on the card, in the one colour this app uses for a live
  // and actionable thing.
  leaveValue: { fontFamily: MONO, fontSize: 20, color: CD_GREEN },
  boarding: { fontFamily: MONO, fontSize: 13, color: BOARDING_AMBER },
  // The bar. A track and a fill, both flat: 3pt tall and a 2pt radius, which is
  // pg.track's own geometry on the flight card.
  track: { height: 3, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 2 },
  fill: { height: 3, borderRadius: 2, backgroundColor: CD_GREEN },

  // ── THE OTHER TRIPS ──
  others: { marginTop: 20, gap: 8 },
  otherLine: { fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.5)' },

  // ── THE ONE ADD CONTROL ──
  //
  // CONTENT-SIZED AND CENTRED, not a full-width row. A button as wide as the
  // screen reads as a list item; this is a single act and should look like one.
  // 10 between the glyph and the word, the same gutter the card's menu row
  // leaves around its own icon.
  // PRESENT RATHER THAN A ROW. At 12 and 16 with a 15pt label this read as a
  // list item that happened to be centred; the padding, the glyph and the gap
  // above it are what make it the one act on the screen.
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'center',
    marginTop: 32,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  addLabel: { fontFamily: SANS, fontSize: 15, color: '#e2e2e2' },

  // ── THE MENU ──
  // The card's long-press menu exactly: centred so it is as wide as its longest
  // row rather than the full width the scrim would give it, with a floor so two
  // short rows do not make a stub.
  menu: { alignSelf: 'center', minWidth: 220 },
  // Tighter than g.sheetBody's 20, which is sized for a head and four groups.
  menuBody: { padding: 16, gap: 12 },
  menuRow: { paddingVertical: 4 },
  menuLabel: { fontFamily: SANS, fontSize: 15, color: '#e2e2e2' },

  // ── THE SHEETS ──
  // A floor and a ceiling, exactly as the archive sheet carries: more than half
  // the screen whatever is in it, and never so tall the scrim disappears.
  sheet: { minHeight: '62%', maxHeight: '82%' },
  sheetEmpty: {
    fontFamily: SANS, fontSize: 11, color: DIM,
    textAlign: 'center', lineHeight: 18, paddingVertical: 12,
  },
  // Negative margin then equal padding, so a row runs the full width of the
  // sheet while its text lines up with the head above it. flex: 1 completes the
  // chain from sheetBodyFill and is what gives the list a height to scroll in.
  sheetList: { marginHorizontal: -20, paddingHorizontal: 20, flex: 1 },
  importRow: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    marginBottom: CARD_GAP,
    gap: 6,
  },
  pastTrip: { marginBottom: CARD_GAP, gap: 2 },
  pastRow: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 4,
  },
  pastDate: { fontFamily: MONO_BOLD, fontSize: 11, color: 'rgba(226,226,226,0.6)', marginLeft: 8 },
  // getStatusColor('landed'), and the same 11pt mono StatusLine renders at.
  landed: { fontFamily: MONO, fontSize: 11, color: LANDED_GREY },
});
