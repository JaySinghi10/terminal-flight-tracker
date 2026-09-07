import { useState, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, LayoutAnimation,
  Platform, UIManager,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// HOME'S HEADER LINE. Imported rather than restated, and from lib rather than
// from a screen -- see the note where it lives.
import { formatClock } from '../lib/flightstatus';
// THE PAGE AND THE ELEVATION SCALE. See lib/cards.ts.
import {
  PAGE_BG, SURFACE_1, SURFACE_2, CARD_RADIUS, CARD_GAP, CARD_PAD,
} from '../lib/cards';
// THE DATASET. allDining is never called here: diningAt filters the one airport
// on screen, and the picker reads the airport codes out of it once.
import { diningAt, allDining, Dining, HoursWindow } from '../lib/dining';
// THE JOURNEY, FROM THE ONE PLACE THAT KNOWS IT. currentLegIndex moved out of
// app/flights.tsx for this screen -- see its note in lib/saved.tsx. Nothing
// about which leg a traveller is on is computed twice.
import {
  useSaved, tripsOf, isArchived, currentLegIndex, departureTs,
  // WHETHER A LEG HAS LANDED, AND WHEN IT ARRIVED. whereAmI asks the first and
  // budgetFor the second; neither is computed here any more.
  effectiveStatus, arrivalTs,
} from '../lib/saved';
// THE RECORD ITSELF comes from storage, which is where it is declared -- saved
// re-exports nothing and a type imported from the wrong file is a second name
// for one thing.
import { SavedFlight } from '../lib/storage';
import { airportByCode, findAirports, Airport } from '../lib/airports';
// THE SCHEMATIC. Terminal geometry is a separate dataset from dining for the
// same reason airports.ts is separate from both: it is a different source with a
// different licence, and it is absent for most airports.
import { terminalOf, terminalsAt, Gate } from '../lib/terminals';
import TerminalMap, { placeDining, Placed } from '../components/TerminalMap';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

const GREEN = '#4ade80';
const INK = '#e2e2e2';
const DIM = 'rgba(226,226,226,0.4)';
const DIMMER = 'rgba(226,226,226,0.28)';
const AMBER = '#fbbf24';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THE RESERVE. THESE ARE ESTIMATES, NOT MEASUREMENTS.                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// EVERY NUMBER BELOW IS A GUESS MADE ON PURPOSE, and they are named so they can
// be argued with. We have the layover duration and both terminals. We do NOT
// have walking times -- no vendor sells them for a set of airports this size --
// and we do NOT have IATA Minimum Connecting Times, which are a paid
// subscription. So the usable window is the layover minus a stated budget rather
// than a routed estimate, and the screen shows the subtraction rather than
// hiding it.
//
// THEY WILL NEED TUNING once real journeys are seen. Treat a change here as a
// product decision, not a tweak: every minute added removes options from
// somebody with a short connection, and every minute removed risks sending them
// to a restaurant they cannot get back from.
//
// CONSERVATIVE BY CONSTRUCTION. Where a term was arguable the larger value was
// taken, because the cost of the two errors is not symmetric: a missed flight is
// not the same kind of wrong as a missed sandwich.

// Boarding closes before departure, and the gate is shut before that.
const RESERVE_BOARDING_MIN = 25;
// Getting from wherever you are to the gate, in a terminal you may not know.
const RESERVE_TO_GATE_MIN = 15;
// Changing terminals. A transfer bus or a train, plus the waiting for it.
const RESERVE_TERMINAL_CHANGE_MIN = 30;
// Immigration and customs on an international connection, and re-clearing
// security where the transfer is not airside-to-airside.
const RESERVE_INTERNATIONAL_MIN = 45;

// Below this, the screen stops being a list of options and starts being a
// warning. Thirty minutes of usable time is not a meal.
const TIGHT_MIN = 30;

// ── WHAT WE HAVE DATA FOR ───────────────────────────────────────────────────
//
// EIGHT AIRPORTS OF 1,223 IN airports.ts, so the no-data state is the COMMON
// case and is built first. Read from the dataset rather than listed here: a
// hand-kept second list is a list that goes stale the next time an adapter
// ships.
function coveredAirports(): string[] {
  const seen = new Set<string>();
  for (const d of allDining()) seen.add(d.airport);
  return [...seen].sort();
}

// ── THE JOURNEY, READ ONCE ──────────────────────────────────────────────────
//
// WHERE THE TRAVELLER IS, AND HOW LONG THEY HAVE. Everything this screen does
// with a trip comes from here, so there is one place to look when it is wrong.
//
// THE LAYOVER IS THE INTERESTING CASE and it is the one with a clock: the
// previous leg has landed, the next has not gone, and the gap between them is
// real time in a real terminal. Everything else -- in the air, not yet departed,
// no trip at all -- gives an airport but no window, and the screen must not
// invent one.
type Where = {
  airport: string | null;      // IATA the traveller is at, or heading to
  kind: 'layover' | 'departing' | 'airborne' | 'none';
  // Only on a layover: the leg that landed and the one to come.
  arrived: SavedFlight | null;
  next: SavedFlight | null;
  layoverMs: number | null;
};

function whereAmI(list: SavedFlight[], now: number): Where {
  const none: Where = { airport: null, kind: 'none', arrived: null, next: null, layoverMs: null };
  const trips = tripsOf(list, now).filter(legs => legs.some(l => !isArchived(l, now)));
  if (trips.length === 0) return none;
  const legs = trips[0];
  const i = currentLegIndex(legs, now);
  if (i < 0) return none;

  const leg = legs[i];
  // ── ONE PLACE DECIDES WHETHER A FLIGHT HAS LANDED, AND IT IS NOT THIS ONE ──
  //
  // THIS USED TO ASK landedInstant AND IT WAS THE WRONG QUESTION. That function
  // answers WHEN a flight arrived, for the bag window; whether it arrived at all
  // is effectiveStatus's job, and effectiveStatus already knows things this did
  // not -- FR24's touchdown outranks a stored status, an arrival in the future
  // is refused, an estimate an hour stale demotes to 'stale'.
  //
  // THE DRIFT WAS REAL AND VISIBLE. On a leg with a spurious landedAt,
  // effectiveStatus said 'scheduled' while this said "landed" in the same
  // render, and the Deck opened a layover six hours before the flight was due.
  // Two answers to one question is how that happens.
  const hasLanded = effectiveStatus(leg, now) === 'landed';
  const after = i + 1 < legs.length ? legs[i + 1] : null;
  const before = i > 0 ? legs[i - 1] : null;

  const layover = (arrived: SavedFlight, next: SavedFlight): Where => {
    // THE GAP IS ARRIVAL TO DEPARTURE AS INSTANTS -- the only reading that is
    // right when the two legs are in different zones, which a connection
    // usually is. Null when either end cannot be read, or when they contradict
    // each other; neither is a duration and printing one would invent it.
    //
    // arrivalTs, NOT landedInstant, AND THAT IS THE SAME ANCHOR app/flights.tsx
    // USES. The two screens printed different layovers for one connection --
    // 10h 44m here against 4h 36m there -- because this measured from
    // landedInstant, which had fallen through to a landedAt belonging to a leg
    // still in the air. A layover is a property of the itinerary; it must not
    // depend on when a device happened to notice something.
    const a = arrivalTs(arrived);
    const dep = departureTs(next);
    const gap = a !== null && dep !== null && dep >= a ? dep - a : null;
    return {
      airport: (arrived.to.iata || next.from.iata || '').toUpperCase() || null,
      kind: 'layover', arrived, next, layoverMs: gap,
    };
  };

  // ── TWO WAYS TO BE ON A LAYOVER, AND currentLegIndex HANDS BACK A DIFFERENT
  //    LEG FOR EACH ──
  //
  // FOR BAG_WINDOW_MS AFTER TOUCHDOWN it returns the leg that LANDED, so the
  // pair is (leg, after). Once that window closes it returns the leg still to
  // COME, so the pair is (before, leg) -- and reading only the first case would
  // have dropped the traveller out of "layover" forty-five minutes in, which is
  // exactly when they start looking for lunch. The airport is the same either
  // way; what would have been lost is the clock.
  if (hasLanded && after !== null) return layover(leg, after);
  if (hasLanded) return none;                         // the journey is over

  const dep = departureTs(leg);
  if (dep !== null && dep <= now) {
    // In the air: the airport that matters is the one being flown to.
    return { ...none, airport: (leg.to.iata || '').toUpperCase() || null, kind: 'airborne' };
  }
  if (before !== null && effectiveStatus(before, now) === 'landed') {
    return layover(before, leg);
  }
  // The first leg of the journey, not yet gone: the airport is where it starts.
  return { ...none, airport: (leg.from.iata || '').toUpperCase() || null, kind: 'departing' };
}

// ── THE BUDGET ──────────────────────────────────────────────────────────────
//
// usable = layover - reserve, and the reserve is itemised so the screen can say
// what it took. Returns null when there is no layover to budget.
type Budget = {
  layoverMin: number;
  reserveMin: number;
  usableMin: number;
  terminalChange: boolean;
  international: boolean;
};

function budgetFor(w: Where, now: number): Budget | null {
  if (w.kind !== 'layover' || w.layoverMs === null || w.arrived === null || w.next === null) {
    return null;
  }
  // ── FROM WHICHEVER IS LATER: NOW, OR THE ARRIVAL ──────────────────────────
  //
  // NEITHER ONE ALONE IS RIGHT, and each is wrong in the opposite direction.
  //
  // FROM NOW ALONE hands the traveller the whole gap before they have landed --
  // it printed "10h 37m until boarding" on a 4h 36m connection, because the
  // screen had opened a layover six hours early and then measured from the
  // clock.
  //
  // FROM THE ARRIVAL ALONE keeps saying the full layover after they are down:
  // three hours into a four-hour connection it would still promise four hours.
  //
  // max() IS BOTH READINGS AT ONCE. Before the wheels touch it is the whole
  // layover, which is what somebody planning the connection wants; after, it is
  // what is actually left. They are the same number at the moment of arrival,
  // so nothing jumps.
  const arr = arrivalTs(w.arrived);
  const anchor = arr === null ? now : Math.max(now, arr);
  const dep = departureTs(w.next);
  const remainingMs = dep === null ? (w.layoverMs ?? 0) : Math.max(0, dep - anchor);
  const layoverMin = Math.round(remainingMs / 60000);

  const arrT = (w.arrived.to.terminal || '').trim();
  const depT = (w.next.from.terminal || '').trim();
  // ONLY WHEN BOTH ARE KNOWN AND THEY DIFFER. An unknown terminal is not a
  // change and is not a match; charging thirty minutes for a fact we do not
  // have would be inventing a transfer.
  const terminalChange = arrT !== '' && depT !== '' && arrT.toUpperCase() !== depT.toUpperCase();

  // INTERNATIONAL IF EITHER END OF EITHER LEG LEAVES THE COUNTRY. Read from the
  // bundled dataset, the same way lib/reminders.ts asks the question -- there is
  // no country on the flight record itself.
  const international = isInternational(w.arrived) || isInternational(w.next);

  const reserveMin = RESERVE_BOARDING_MIN + RESERVE_TO_GATE_MIN
    + (terminalChange ? RESERVE_TERMINAL_CHANGE_MIN : 0)
    + (international ? RESERVE_INTERNATIONAL_MIN : 0);

  return {
    layoverMin, reserveMin, usableMin: layoverMin - reserveMin,
    terminalChange, international,
  };
}

// THE SAME TEST lib/reminders.ts MAKES, and for the same reason: the country is
// not on the record, so it comes from the bundled dataset. Unresolved is treated
// as INTERNATIONAL, which is the conservative direction -- it adds time to the
// reserve rather than removing it.
function isInternational(f: SavedFlight): boolean {
  const from = airportByCode(f.from.iata);
  const to = airportByCode(f.to.iata);
  if (from === null || to === null) return true;
  return from.country !== to.country;
}

// ── HOURS ───────────────────────────────────────────────────────────────────
//
// OPEN NOW, IN THE AIRPORT'S OWN TIME. The windows are local wall clock with no
// zone attached -- that is what the sources publish -- so they are read against
// the airport's timezone from airports.ts rather than the device's.
//
// null MEANS WE CANNOT SAY, and that is most rows: hours exist for HKG, FRA and
// ARN only. A row with no windows shows no open/closed state at all rather than
// a guess in either direction.
function openNow(d: Dining, tz: string | null): boolean | null {
  if (d.is24H) return true;
  if (!d.hours || d.hours.length === 0) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
  } catch {
    return null;
  }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wk = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  if (wk < 0) return null;
  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  for (const w of d.hours) {
    if (!coversDay(w, wk)) continue;
    const o = toMin(w.open), c = toMin(w.close);
    if (o === null || c === null) continue;
    // A CLOSING TIME BEFORE ITS OPENING RUNS PAST MIDNIGHT, which is ordinary at
    // an airport. 24:00 is midnight at the END of the day and is already larger
    // than any opening, so it needs no special case.
    if (c > o ? mins >= o && mins < c : mins >= o || mins < c) return true;
  }
  return false;
}

function coversDay(w: HoursWindow, day: number): boolean {
  return w.startDay <= w.endDay
    ? day >= w.startDay && day <= w.endDay
    : day >= w.startDay || day <= w.endDay;   // a window that wraps the week
}

function toMin(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m === null ? null : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ── ZONES ───────────────────────────────────────────────────────────────────
//
// THE SPINE OF THE SCREEN. A landside restaurant is unreachable to a connecting
// passenger, so zone is a GROUP with its own heading rather than a tag on a row
// -- a tag can be skimmed past, a heading cannot.
//
// AND NOTHING IS HIDDEN. The two groups a connecting passenger cannot use are
// COLLAPSED, not removed: a four-hour layover can perfectly well leave the
// airside area, and deciding otherwise on their behalf is the same error as
// guessing which side of security an outlet is on.
const ZONE_ORDER: Dining['zone'][] = [
  'departures_airside', 'departures_landside', 'arrivals', 'unknown',
];

const ZONE_TITLE: Record<Dining['zone'], string> = {
  departures_airside: 'AFTER SECURITY',
  departures_landside: 'BEFORE SECURITY',
  arrivals: 'ARRIVALS',
  unknown: 'LOCATION UNCLEAR',
};

const ZONE_NOTE: Record<Dining['zone'], string> = {
  departures_airside: 'past the checkpoint, where your gate is',
  departures_landside: 'you would have to leave and clear security again',
  arrivals: 'reachable after you land, not on a layover',
  unknown: 'the airport does not say which side of security this is',
};

const CATEGORY_LABEL: Record<string, string> = {
  fast_food: 'Fast food', cafe: 'Café', bakery: 'Bakery', dessert: 'Dessert',
  bar: 'Bar', asian: 'Asian', chinese: 'Chinese', indian: 'Indian',
  western: 'Western', middle_eastern: 'Middle Eastern', vegetarian: 'Vegetarian',
  halal: 'Halal', food_court: 'Food court', lounge: 'Lounge',
  vending: 'Vending machine', other: '',
};

function categoryWords(d: Dining): string {
  const seen: string[] = [];
  for (const c of d.category.split('|')) {
    const label = CATEGORY_LABEL[c];
    if (label && !seen.includes(label)) seen.push(label);
  }
  return seen.join(' · ');
}

function minutesWord(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export default function Deck() {
  const insets = useSafeAreaInsets();
  const { savedFlights } = useSaved();
  // THE MINUTE TICK, IN THE SHAPE app/flights.tsx AND lib/flightcard.tsx BOTH
  // USE. Not on any context: a value that changes every sixty seconds, read
  // through a context, is a re-render of every screen for the benefit of one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  const where = useMemo(() => whereAmI(savedFlights, now), [savedFlights, now]);

  const budget = useMemo(() => budgetFor(where, now), [where, now]);
  const covered = useMemo(() => coveredAirports(), []);

  // ── WHICH AIRPORT IS ON SCREEN ────────────────────────────────────────────
  //
  // A CHOICE, OR THE JOURNEY'S OWN ANSWER. null means "follow the trip", which
  // is the ordinary state and MOVES as legs land -- the same shape as
  // focusOverride on My Flights, and for the same reason: storing the resolved
  // airport would freeze it the moment the traveller landed somewhere else.
  const [picked, setPicked] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [term, setTerm] = useState('');

  const airport = picked ?? where.airport;
  const following = picked === null && where.airport !== null;
  const meta = airport === null ? null : airportByCode(airport);
  const rows = useMemo(() => (airport === null ? [] : diningAt(airport)), [airport]);

  // ── TEMPORARY. DELETE WITH THE REST OF THE devTerminal CODE. ──────────────
  //
  // WHY IT EXISTS: the map draws only when hereTerminal resolves, and that needs
  // a live layover whose arrival record carries a terminal. There is no way to
  // look at the schematic at all without being mid-journey at JFK, so it has
  // never been seen on a device.
  //
  // THIS IS NOT THE TERMINAL SELECTOR. The real rule has four states --
  // following a journey, browsing an airport, a manual pick, and no answer --
  // and none of them is "a developer tapped a chip". This forces one value so
  // the drawing can be judged, and comes out when that rule is built.
  const [devTerminal, setDevTerminal] = useState<string | null>(null);

  // The terminal the traveller is standing in, when the journey says so and the
  // screen is showing that airport. Never guessed from anything else.
  const hereTerminal = useMemo(() => {
    // The override, first and only in a development build. __DEV__ is false in
    // any release bundle, so this branch is compiled out and cannot ship.
    if (__DEV__ && devTerminal !== null) return devTerminal;
    if (!following || where.kind !== 'layover' || where.arrived === null) return null;
    const t = (where.arrived.to.terminal || '').trim();
    return t === '' ? null : ('T' + t).toUpperCase();
  }, [following, where, devTerminal]);

  // ── THE MAP, WHEN THERE IS ONE ────────────────────────────────────────────
  //
  // ONE TERMINAL, HERS -- and only when we have both a terminal to draw and a
  // terminal to draw for. NO POLYGON, NO MAP: an empty frame is worse than the
  // list, which is the same answer the no-data state gives for a whole airport.
  const mapFor = useMemo(() => {
    if (airport === null || hereTerminal === null) return null;
    return terminalOf(airport, hereTerminal);
  }, [airport, hereTerminal]);

  // THE TWO GATES THAT MATTER, matched by ref against the geometry. A record's
  // gate is the provider's string and the geometry's is OpenStreetMap's, so the
  // match can miss -- and a miss draws no mark rather than a mark in the wrong
  // place.
  const gates = useMemo(() => {
    if (mapFor === null) return { arrival: null as Gate | null, departure: null as Gate | null };
    const find = (ref: string | null | undefined) => {
      const r = (ref || '').trim().toUpperCase();
      return r === '' ? null : (mapFor.gates.find(g => g.ref === r) ?? null);
    };
    return {
      arrival: find(where.arrived?.to.gate),
      departure: find(where.next?.from.gate),
    };
  }, [mapFor, where]);

  const onMap = useMemo(() => {
    if (mapFor === null) return { placed: [] as Placed[], unplaced: [] as Dining[] };
    // ONLY THE OUTLETS IN THIS TERMINAL. A pin from another building would sit
    // on a shape it does not belong to.
    return placeDining(rows.filter(d => d.terminal.toUpperCase() === mapFor.key), mapFor);
  }, [rows, mapFor]);

  const grouped = useMemo(() => {
    const by = new Map<Dining['zone'], Dining[]>();
    for (const z of ZONE_ORDER) by.set(z, []);
    for (const d of rows) (by.get(d.zone) ?? by.get('unknown'))!.push(d);
    for (const [, list] of by) {
      list.sort((a, b) => {
        // SAME TERMINAL FIRST -- a different terminal is a different
        // proposition, and it is the only ordering we can justify without a
        // walking time we do not have.
        const at = hereTerminal !== null && a.terminal.toUpperCase() === hereTerminal ? 0 : 1;
        const bt = hereTerminal !== null && b.terminal.toUpperCase() === hereTerminal ? 0 : 1;
        if (at !== bt) return at - bt;
        // Then by how fast they can feed you, where anybody says.
        const as = a.serveMinutes ?? 9999;
        const bs = b.serveMinutes ?? 9999;
        if (as !== bs) return as - bs;
        return a.name.localeCompare(b.name);
      });
    }
    return by;
  }, [rows, hereTerminal]);

  // OPEN BY DEFAULT ONLY WHERE THE TRAVELLER CAN GO. Airside always; the other
  // two only when there is no layover to be respectful of.
  const [openZones, setOpenZones] = useState<Record<string, boolean>>({});
  const zoneOpen = (z: Dining['zone']) => {
    const explicit = openZones[z];
    if (explicit !== undefined) return explicit;
    if (z === 'departures_airside') return true;
    return budget === null;
  };
  const toggleZone = (z: Dining['zone']) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(
      220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setOpenZones(prev => ({ ...prev, [z]: !zoneOpen(z) }));
  };

  const results = useMemo(() => {
    if (term.trim().length < 2) return [];
    const set = new Set(covered);
    return findAirports(term, 20).filter(a => set.has(a.iata)).slice(0, 8);
  }, [term, covered]);

  const tight = budget !== null && budget.usableMin < TIGHT_MIN;

  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      <Text style={st.brand}>{'>_'}</Text>
      <Text style={st.title}>{'Deck'}</Text>
      <Text style={st.clock}>{formatClock(now)}</Text>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── THE AIRPORT, AND HOW IT WAS CHOSEN ── */}
        <Pressable
          style={st.picker}
          onPress={() => { setSearching(s => !s); setTerm(''); }}
          accessibilityRole="button"
          accessibilityLabel={airport === null ? 'Choose an airport' : `Airport ${airport}. Tap to change.`}
        >
          <View style={st.pickerLeft}>
            <Text style={st.code}>{airport ?? '—'}</Text>
            <View style={st.pickerWords}>
              <Text style={st.city} numberOfLines={1}>
                {meta === null ? 'Choose an airport' : meta.city}
              </Text>
              {following && (
                <Text style={st.followNote} numberOfLines={1}>
                  {where.kind === 'layover' ? 'your layover'
                    : where.kind === 'airborne' ? 'where you are heading'
                      : 'your departure airport'}
                </Text>
              )}
            </View>
          </View>
          <Text style={st.change}>{searching ? 'CLOSE' : 'CHANGE'}</Text>
        </Pressable>

        {searching && (
          <View style={st.search}>
            <TextInput
              style={st.input}
              value={term}
              onChangeText={setTerm}
              placeholder="Search airports we have"
              placeholderTextColor={DIMMER}
              autoCorrect={false}
              autoCapitalize="characters"
            />
            {results.map(a => (
              <Pressable
                key={a.iata}
                style={st.result}
                onPress={() => { setPicked(a.iata); setSearching(false); setTerm(''); }}
              >
                <Text style={st.resultCode}>{a.iata}</Text>
                <Text style={st.resultName} numberOfLines={1}>{a.city} · {a.country}</Text>
              </Pressable>
            ))}
            {term.trim().length >= 2 && results.length === 0 && (
              <Text style={st.searchNote}>{'No dining data for that airport yet.'}</Text>
            )}
            {picked !== null && where.airport !== null && (
              <Pressable style={st.result} onPress={() => { setPicked(null); setSearching(false); }}>
                <Text style={st.resultCode}>{'↩'}</Text>
                <Text style={st.resultName}>{`Follow my trip (${where.airport})`}</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── THE CLOCK, WHEN THERE IS ONE ── */}
        {budget !== null && following && (
          <View style={[st.budget, tight && st.budgetTight]}>
            <Text style={[st.budgetBig, tight && { color: AMBER }]}>
              {budget.usableMin <= 0 ? 'Go to your gate' : `${minutesWord(budget.usableMin)} to eat`}
            </Text>
            {/* ── AND NOTHING ELSE. ────────────────────────────────────────
                THE SUBTRACTION WAS ON SCREEN AND IT WAS INTERNAL REASONING.
                "40m held back · 25m boarding · 15m to the gate" is how the
                number was reached, not what the traveller needs: they need one
                answer, and showing the working invites them to audit an
                estimate rather than trust it or ignore it.

                THE RESERVES STILL APPLY -- see budgetFor. They shape the
                number; they have simply stopped narrating it. */}
          </View>
        )}

        {/* ── TEMPORARY DEV CONTROL. Delete with devTerminal. ──────────────
            Lists whatever terminals the geometry actually holds for the airport
            on screen rather than a hardcoded JFK row, because a chip for a
            terminal we have no polygon for would draw nothing and read as a
            broken map rather than as missing data. */}
        {__DEV__ && airport !== null && terminalsAt(airport).length > 0 && (
          <View style={st.devWrap}>
            <Text style={st.devLabel}>DEV ONLY · FORCE TERMINAL</Text>
            <View style={st.chips}>
              {terminalsAt(airport).map(t => (
                <Pressable
                  key={t.key}
                  onPress={() => setDevTerminal(devTerminal === t.key ? null : t.key)}
                  style={[st.chip, devTerminal === t.key && st.devChipOn]}
                >
                  <Text style={st.chipCode}>{t.key}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* ── THE SCHEMATIC, WHEN WE HAVE THE SHAPE AND SHE IS IN IT ── */}
        {mapFor !== null && (
          <TerminalMap
            terminal={mapFor}
            placed={onMap.placed}
            arrival={gates.arrival}
            departure={gates.departure}
          />
        )}

        {/* ── THE LIST, OR THE HONEST ABSENCE OF ONE ── */}
        {airport === null ? (
          <NoAirport covered={covered} onPick={setPicked} />
        ) : rows.length === 0 ? (
          <NoData airport={airport} meta={meta} covered={covered} onPick={setPicked} />
        ) : (
          ZONE_ORDER.map(z => {
            const list = grouped.get(z) ?? [];
            if (list.length === 0) return null;
            const open = zoneOpen(z);
            return (
              <View key={z} style={st.zone}>
                <Pressable
                  style={st.zoneHead}
                  onPress={() => toggleZone(z)}
                  accessibilityRole="button"
                  accessibilityLabel={`${ZONE_TITLE[z]}, ${list.length} places. ${open ? 'Collapse' : 'Expand'}.`}
                >
                  <View style={st.zoneHeadWords}>
                    <Text style={[st.zoneTitle, z === 'departures_airside' && { color: INK }]}>
                      {ZONE_TITLE[z]}
                    </Text>
                    <Text style={st.zoneNote}>{ZONE_NOTE[z]}</Text>
                  </View>
                  <Text style={st.zoneCount}>{`${list.length}  ${open ? '−' : '+'}`}</Text>
                </Pressable>
                {open && list.map(d => (
                  <Row
                    key={d.sourceId || `${d.name}|${d.terminal}|${d.area}`}
                    d={d}
                    tz={meta?.tz ?? null}
                    hereTerminal={hereTerminal}
                    usableMin={budget?.usableMin ?? null}
                  />
                ))}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

// ── ONE OUTLET ──────────────────────────────────────────────────────────────
//
// LINES APPEAR ONLY WHEN THEY HAVE SOMETHING TO SAY. Hours exist for three
// airports of eight and a serve time for fourteen rows of 753, so absence is the
// NORM here rather than an exception -- and a dash in every empty slot, which is
// right on the flight card, would make every row look broken. A row that is a
// name and a location is a complete row.
function Row({ d, tz, hereTerminal, usableMin }: {
  d: Dining;
  tz: string | null;
  hereTerminal: string | null;
  usableMin: number | null;
}) {
  const open = openNow(d, tz);
  const elsewhere = hereTerminal !== null && d.terminal !== ''
    && d.terminal.toUpperCase() !== hereTerminal;
  // GREEN ONLY WHEN IT IS ACTIONABLE: a serve time that fits the window we
  // computed. Never as decoration.
  const fits = usableMin !== null && d.serveMinutes !== null && d.serveMinutes <= usableMin;

  const place = [
    d.terminal || null,
    d.level || null,
    d.gateHint ? `Gate ${d.gateHint}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <View style={st.row}>
      <View style={st.rowTop}>
        <Text style={st.name} numberOfLines={1}>{d.name}</Text>
        {d.serveMinutes !== null && (
          <Text style={[st.serve, fits && { color: GREEN }]}>{`${d.serveMinutes}m`}</Text>
        )}
      </View>

      {categoryWords(d) !== '' && (
        <Text style={st.cats} numberOfLines={1}>{categoryWords(d)}</Text>
      )}

      <View style={st.rowMeta}>
        {place !== '' && <Text style={st.place}>{place}</Text>}
        {/* A DIFFERENT TERMINAL IS A DIFFERENT PROPOSITION, and it is said in
            words with no minutes attached. We have no walking times. */}
        {elsewhere && <Text style={st.elsewhere}>{'different terminal'}</Text>}
        {open === true && <Text style={st.openNow}>{'open'}</Text>}
        {open === false && <Text style={st.closed}>{'closed'}</Text>}
      </View>

      {d.hoursRaw !== '' && (
        <Text style={st.hours} numberOfLines={2}>{d.hoursRaw}</Text>
      )}
    </View>
  );
}

// ── NOTHING CHOSEN ──────────────────────────────────────────────────────────
// onPick IS NOT OPTIONAL HERE, AND ITS ABSENCE WAS A DEAD END. Covered
// disables its chips when no handler is given, so this state showed eight
// airports and responded to none of them -- and the only other way in, the
// search box, could not find an airport by its own code either. With no trip
// saved there was no route to any airport at all.
function NoAirport({ covered, onPick }: {
  covered: string[];
  onPick: (code: string) => void;
}) {
  return (
    <View style={st.empty}>
      <Text style={st.emptyTitle}>{'No trip on the go'}</Text>
      <Text style={st.emptyBody}>
        {'The Deck follows your journey and shows what you can eat where you are. '
          + 'With no trip saved, pick an airport above.'}
      </Text>
      <Covered covered={covered} onPick={onPick} />
    </View>
  );
}

// ── AN AIRPORT WE DO NOT HAVE ───────────────────────────────────────────────
//
// THE COMMON CASE, AND IT IS BUILT AS ONE. Eight airports of 1,223 means most
// travellers meet this screen before they meet a list, so it says what we DO
// have -- a feature still being built reads differently from a broken one, and
// only one of those is true.
function NoData({ airport, meta, covered, onPick }: {
  airport: string;
  meta: Airport | null;
  covered: string[];
  onPick: (code: string) => void;
}) {
  return (
    <View style={st.empty}>
      <Text style={st.emptyTitle}>
        {meta === null ? `No dining for ${airport} yet` : `No dining for ${meta.city} yet`}
      </Text>
      <Text style={st.emptyBody}>
        {'Every airport here is added by hand, because the one fact that matters — '
          + 'whether a restaurant is before or after security — is published by very '
          + 'few airports and guessed by nobody.'}
      </Text>
      <Covered covered={covered} onPick={onPick} />
    </View>
  );
}

function Covered({ covered, onPick }: { covered: string[]; onPick?: (code: string) => void }) {
  return (
    <View style={st.coveredWrap}>
      <Text style={st.coveredLabel}>{`${covered.length} AIRPORTS SO FAR`}</Text>
      <View style={st.chips}>
        {covered.map(code => {
          const a = airportByCode(code);
          return (
            <Pressable
              key={code}
              style={st.chip}
              disabled={onPick === undefined}
              onPress={() => onPick?.(code)}
            >
              <Text style={st.chipCode}>{code}</Text>
              {a !== null && <Text style={st.chipCity} numberOfLines={1}>{a.city}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  // The page margin is index.tsx's s.scroll and profile.tsx's body: 20 either
  // side, so the brand mark sits in the same column on every screen.
  root: { flex: 1, backgroundColor: PAGE_BG, paddingHorizontal: 20 },
  brand: { fontFamily: MONO_BOLD, color: GREEN, fontSize: 15 },
  title: { fontFamily: SANS_SEMI, fontSize: 24, color: INK, marginTop: 10 },
  clock: { fontFamily: MONO, fontSize: 15, color: DIM, marginTop: 3 },
  scroll: { marginTop: 16 },

  // ── the airport picker ──
  picker: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: SURFACE_2, borderRadius: CARD_RADIUS, padding: CARD_PAD,
  },
  pickerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
  code: { fontFamily: MONO_BOLD, fontSize: 22, color: INK, letterSpacing: 1 },
  pickerWords: { flex: 1 },
  city: { fontFamily: SANS, fontSize: 13, color: INK },
  followNote: { fontFamily: SANS, fontSize: 11, color: GREEN, marginTop: 1 },
  change: { fontFamily: MONO, fontSize: 10, color: DIM, letterSpacing: 0.5 },

  search: {
    backgroundColor: SURFACE_1, borderRadius: CARD_RADIUS,
    padding: CARD_PAD, marginTop: CARD_GAP,
  },
  input: {
    fontFamily: MONO, fontSize: 14, color: INK,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)', paddingBottom: 8,
  },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  resultCode: { fontFamily: MONO_BOLD, fontSize: 14, color: INK, width: 34 },
  resultName: { fontFamily: SANS, fontSize: 13, color: DIM, flex: 1 },
  searchNote: { fontFamily: SANS, fontSize: 12, color: DIM, marginTop: 10 },

  // ── the budget ──
  budget: {
    backgroundColor: SURFACE_1, borderRadius: CARD_RADIUS,
    padding: CARD_PAD, marginTop: CARD_GAP,
  },
  budgetTight: { borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)' },
  budgetBig: { fontFamily: SANS_SEMI, fontSize: 17, color: INK },

  // ── zones ──
  zone: { marginTop: 18 },
  zoneHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  zoneHeadWords: { flex: 1, paddingRight: 12 },
  zoneTitle: { fontFamily: MONO_BOLD, fontSize: 11, color: DIM, letterSpacing: 1 },
  zoneNote: { fontFamily: SANS, fontSize: 11, color: DIMMER, marginTop: 2 },
  zoneCount: { fontFamily: MONO, fontSize: 12, color: DIM },

  // ── one outlet ──
  row: {
    backgroundColor: SURFACE_1, borderRadius: CARD_RADIUS,
    padding: CARD_PAD, marginTop: CARD_GAP,
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  name: { fontFamily: SANS_SEMI, fontSize: 15, color: INK, flex: 1 },
  serve: { fontFamily: MONO_BOLD, fontSize: 12, color: DIM },
  cats: { fontFamily: SANS, fontSize: 12, color: DIM, marginTop: 3 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  place: { fontFamily: MONO, fontSize: 11, color: DIM },
  elsewhere: { fontFamily: MONO, fontSize: 11, color: AMBER },
  openNow: { fontFamily: MONO, fontSize: 11, color: GREEN },
  closed: { fontFamily: MONO, fontSize: 11, color: DIMMER },
  hours: { fontFamily: MONO, fontSize: 11, color: DIMMER, marginTop: 4 },

  // ── the empty states ──
  empty: {
    backgroundColor: SURFACE_1, borderRadius: CARD_RADIUS,
    padding: CARD_PAD, marginTop: CARD_GAP,
  },
  emptyTitle: { fontFamily: SANS_SEMI, fontSize: 16, color: INK },
  emptyBody: { fontFamily: SANS, fontSize: 13, color: DIM, marginTop: 6, lineHeight: 19 },
  coveredWrap: { marginTop: 16 },
  coveredLabel: { fontFamily: MONO, fontSize: 10, color: DIMMER, letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: CARD_GAP, marginTop: 8 },
  // TEMPORARY, with devTerminal. Amber because it is scaffolding: nothing else
  // on this screen is that colour except a warning, which is what it is.
  devWrap: { marginTop: CARD_GAP, paddingHorizontal: CARD_PAD },
  devLabel: { fontFamily: MONO, fontSize: 10, color: AMBER, letterSpacing: 1 },
  devChipOn: { borderColor: AMBER },
  chip: {
    backgroundColor: SURFACE_2, borderRadius: 8,
    paddingVertical: 6, paddingHorizontal: 10, minWidth: 74,
  },
  chipCode: { fontFamily: MONO_BOLD, fontSize: 12, color: INK, letterSpacing: 0.5 },
  chipCity: { fontFamily: SANS, fontSize: 10, color: DIM, marginTop: 1 },
});
