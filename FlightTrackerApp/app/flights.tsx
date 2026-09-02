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
import { StatusLine, routeDateLabel, CD_GREEN } from '../lib/flightstatus';
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG } from '../lib/cards';
import {
  GlassLayers, g,
  EASE_OUT, EASE_IN, CAL_RISE,
  CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
} from '../lib/glass';
import { useToast } from '../lib/toast';
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

// ── THE SHEET, AND IT IS THE ARCHIVE SHEET'S STRUCTURE ──────────────────────
//
// A COMPONENT RATHER THAN TWO COPIES, and nothing about the structure differs
// from app/index.tsx's archive sheet: the same Modal flags, the same scrim
// Pressable, the same full-screen dim on its own value, the same CAL_RISE / 0.96
// rise-scale-fade on CAL_IN_MS and CAL_OUT_MS, the same shell, glass, edge and
// swallowing body, the same head with its spacer, title and red close X. Two
// sheets on one screen written out twice is exactly how the two would come to
// differ.
function useSheet() {
  const [open, setOpen] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!open) return;
    anim.setValue(0);
    scrim.setValue(0);
    Animated.parallel([
      Animated.timing(scrim, {
        toValue: 1, duration: SCRIM_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(anim, {
        toValue: 1, duration: CAL_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [open]);
  // Animated out, then unmounted, exactly as closeArchive does it.
  const dismiss = () => {
    Animated.parallel([
      Animated.timing(anim, {
        toValue: 0, duration: CAL_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(scrim, {
        toValue: 0, duration: SCRIM_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setOpen(false));
  };
  return { open, present: () => setOpen(true), dismiss, anim, scrim };
}

function Sheet({ sheet, title, children }: {
  sheet: ReturnType<typeof useSheet>; title: string; children: ReactNode;
}) {
  return (
    <Modal visible={sheet.open} transparent animationType="none" onRequestClose={sheet.dismiss}>
      <Pressable style={g.routeCalScrim} onPress={sheet.dismiss}>
        {/* The dim alone, full screen and unblurred. The blur lives inside the
            sheet, so outside it the page stays sharp. */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: sheet.scrim }]}
        />
        <Animated.View
          style={[
            g.sheetShell,
            st.sheet,
            {
              opacity: sheet.anim,
              transform: [
                { translateY: sheet.anim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                { scale: sheet.anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
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
                onPress={sheet.dismiss}
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
      </Pressable>
    </Modal>
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

  const importSheet = useSheet();
  const pastSheet = useSheet();

  const remove = async (leg: SavedFlight) => {
    await disownFlight(leg);
    showToast(`${leg.flightNumber} removed`);
  };

  const add = async (f: SavedFlight) => {
    await ownFlight(f);
    importSheet.dismiss();
    showToast(`${f.flightNumber} added`);
  };

  // THE TWO WAYS IN, and neither of them is a text field. A search input here
  // would be a second command line: the tab bar already owns one and the search
  // screen is where it types. This sends you there rather than reimplementing it.
  const addControls = (
    <View style={st.adds}>
      <TouchableOpacity
        style={st.addRow}
        activeOpacity={0.7}
        onPress={() => router.push('/search')}
        accessibilityRole="button"
      >
        <Text style={st.addText}>{'Search for a flight'}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={st.addRow}
        activeOpacity={0.7}
        onPress={importSheet.present}
        accessibilityRole="button"
      >
        <Text style={st.addText}>{'Import from watchlist'}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      <Sheet sheet={importSheet} title="Import">
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

      {/* READ-ONLY, AND THAT IS THE WHOLE OF WHAT THIS SHEET IS. A finished trip
          has nothing left to do to it: it cannot be left, its reminders are
          spent, and removing it belongs to the watchlist rather than here. Rows
          with no actions are rows nobody has to be careful around. */}
      <Sheet sheet={pastSheet} title="Past flights">
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

      {/* THE BOTTOM PADDING RUNS THE LAST CONTENT UNDER THE FLOATING BAR, which
          is home's treatment and its reasoning: a blur with nothing behind it is
          a grey pill, and the material only reads as glass while something is
          moving underneath it. */}
      <ScrollView
        contentContainerStyle={[st.scroll, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={st.brand}>{'>_'}</Text>
        <Text style={st.title}>{'My Flights'}</Text>

        {current.length === 0 ? (
          <>
            <Text style={st.empty}>{"Add the flight you're taking."}</Text>
            {addControls}
          </>
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

            {addControls}
          </>
        )}

        {/* A LINK RATHER THAN A SECTION. Past trips are not part of this screen's
            subject; this is the door out to them. */}
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={pastSheet.present}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={st.pastLink}
          accessibilityRole="button"
        >
          <Text style={st.pastLinkText}>{'Past flights'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  // 20 either side, so the brand mark sits in the same column as home's and the
  // profile screen's.
  scroll: { paddingHorizontal: 20 },
  brand: { fontFamily: MONO_BOLD, color: CD_GREEN, fontSize: 15 },
  title: { fontFamily: MONO, fontSize: 20, color: '#e2e2e2', marginTop: 36 },
  empty: { fontFamily: SANS, fontSize: 13, color: DIM, marginTop: 10 },

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

  // ── THE TWO ADD CONTROLS ──
  adds: { marginTop: 20, gap: CARD_GAP },
  addRow: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    paddingVertical: 16,
    paddingHorizontal: CARD_PAD,
  },
  addText: { fontFamily: SANS, fontSize: 13, color: '#e2e2e2' },

  pastLink: { marginTop: 28, alignSelf: 'flex-start' },
  pastLinkText: { fontFamily: SANS, fontSize: 11, color: DIM },

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
