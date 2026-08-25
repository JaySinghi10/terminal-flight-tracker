import { useState, useRef, useEffect } from "react";
import Svg, { Path, Rect, G } from 'react-native-svg';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Google from 'expo-auth-session/providers/google';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Animated,
  AppState,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Easing,
  Modal,
  Pressable,
  Dimensions,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SavedFlight,
  SavedFlightEndpoint,
  getSavedFlights,
  saveFlight,
  unsaveFlight,
  touchSavedFlight,
  savedFlightFromApi,
  makeFlightId,
  migrateLegacyIfNeeded,
  mergeGuestInto,
} from '../lib/storage';
import { airlineFromFlightNumber } from '../lib/airlines';
import {
  Airport,
  airportByCode,
  resolveAirportName,
} from '../lib/airports';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

const API_BASE = 'https://flight-tracker-970706733452.asia-south1.run.app';

const FLIGHT_REGEX = /^[A-Z]{2}\d{2,4}$/;
// Three letters, an optional single separator, three letters. "BLR DEL",
// "BLR>DEL", "BLR-DEL", "BLR\u2192DEL" and "BLRDEL" all match. Tested after
// FLIGHT_REGEX, which needs digits, so the two can never both match.
const ROUTE_REGEX = /^([A-Z]{3})[\s>\-\u2192]?([A-Z]{3})$/;

// The affordance under the command line and the routing branch in handleSearch
// must test the IDENTICAL string, or the affordance shows for input the search
// then rejects. One helper, called from both, so the two cannot drift.
// Internal whitespace collapses to a single space: "BLR  DEL" is a typing
// accident, not a question worth spending an LLM call on.
function matchRoute(q: string) {
  return ROUTE_REGEX.exec(q.trim().toUpperCase().replace(/\s+/g, ' '));
}

// A route needs two DIFFERENT airports. Both the affordance and the routing
// branch read this, so neither can accept what the other rejects — the same
// guarantee matchRoute gives for the normalized string.
function routeCodes(q: string): { from: string; to: string; sameAirport: boolean } | null {
  const m = matchRoute(q);
  if (!m) return null;
  return { from: m[1], to: m[2], sameAirport: m[1] === m[2] };
}

// What a person writes between two places, longest first so " to " is tried
// before a bare ">". A hyphen must be spaced: "Baden-Baden" is a city, and
// splitting inside it would lose the search.
const ROUTE_SEPARATORS = [' to ', ' \u2192 ', '\u2192', ' > ', '>', ' - '];

// "Thiruvananthapuram to New York City" is five. Anything longer is prose.
const ROUTE_MAX_WORDS = 6;

// Words that are never a place. Used for one decision only: telling "Mumbai to
// Xyzzy" — a route naming somewhere this app cannot resolve, which has to be
// reported — from "flight to Mumbai", which is a question and belongs to /chat.
// Checked against the dataset: none of these is a city or an airport name.
const NOT_A_PLACE = new Set([
  'a', 'an', 'the', 'my', 'me', 'is', 'are', 'was', 'do', 'does', 'did',
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'get',
  'flight', 'flights', 'fly', 'flying', 'plane', 'time', 'times', 'status',
  'arrive', 'arrives', 'arrival', 'depart', 'departs', 'departure', 'land',
  'today', 'tomorrow', 'tonight', 'next', 'cheap', 'cheapest', 'book',
]);

type RouteEnd = { airport: Airport; options: Airport[] };

// One end of a route.
//
// A three-letter string is tested as a CODE FIRST and only falls through to
// name matching when it is not a code at all. So "GOA" is Genoa, never Goa —
// a real code is unambiguous and wins — while "Rio", which is no airport's
// code, is still free to match a city.
function resolveRouteEnd(text: string): RouteEnd | null {
  const t = text.trim();
  if (/^[A-Za-z]{3}$/.test(t)) {
    const a = airportByCode(t);
    if (a !== null) return { airport: a, options: [a] };
  }
  const hit = resolveAirportName(t);
  return hit === null ? null : { airport: hit.airport, options: hit.options };
}

// Every way the command line could be cut into two places, best candidate
// first: the explicit separator if there is one, then whitespace splits with
// the LONGEST left-hand side first — which is what makes "New York London"
// break after "York" rather than after "New".
function routeSplits(q: string): [string, string][] {
  const norm = q.trim().replace(/\s+/g, ' ');
  const lower = norm.toLowerCase();
  const out: [string, string][] = [];
  for (const sep of ROUTE_SEPARATORS) {
    const i = lower.indexOf(sep);
    if (i > 0 && i + sep.length < norm.length) {
      out.push([norm.slice(0, i), norm.slice(i + sep.length)]);
      break;                          // one explicit separator is enough
    }
  }
  const words = norm.split(' ');
  // A route is at most a few words each side. Past that the input is prose, and
  // trying every cut of a sentence only costs time and invents coincidences.
  if (words.length <= ROUTE_MAX_WORDS) {
    for (let k = words.length - 1; k >= 1; k--) {
      out.push([words.slice(0, k).join(' '), words.slice(k).join(' ')]);
    }
  }
  return out;
}

// What handleSearch should do with the command line, decided entirely on this
// device. Three outcomes, and the third is the one that keeps /chat working:
//
//   ok     a route to look up, both ends resolved to a real airport
//   error  route-shaped but unresolvable — reported, and nothing is spent
//   null   not a route at all, and falls through to /chat exactly as before
type RouteParse =
  | { kind: 'ok'; from: RouteEnd; to: RouteEnd }
  | { kind: 'error'; message: string }
  | null;

function parseRouteQuery(q: string): RouteParse {
  // Codes first, on the whole string, exactly as this has always worked. Three
  // letters, an optional separator, three letters — and now both are checked
  // against the dataset before anything is spent on them.
  const codes = routeCodes(q);
  if (codes !== null) {
    const from = airportByCode(codes.from);
    const to = airportByCode(codes.to);
    // A three-letter code that is not in the dataset is KNOWN to be wrong here.
    // Rejecting it on the device is what stops a typo costing a board fetch:
    // failures are not cached, so the same typo used to spend every time.
    if (from === null || to === null) {
      const bad = from === null ? codes.from : codes.to;
      return { kind: 'error', message: `${bad} is not an airport code I know` };
    }
    if (codes.sameAirport) {
      return { kind: 'error', message: 'origin and destination must be different airports' };
    }
    return {
      kind: 'ok',
      from: { airport: from, options: [from] },
      to: { airport: to, options: [to] },
    };
  }

  // A split is only taken when BOTH ends resolve, so a question can never be
  // mistaken for a route.
  let orphan: string | null = null;
  for (const [left, right] of routeSplits(q)) {
    const from = resolveRouteEnd(left);
    const to = resolveRouteEnd(right);
    if (from !== null && to !== null) {
      if (from.airport.iata === to.airport.iata) {
        return { kind: 'error', message: 'origin and destination must be different airports' };
      }
      return { kind: 'ok', from, to };
    }
    // One end is a place and the other is short and says nothing else it could
    // be. That is a route with a name this app does not know, and saying so is
    // better than sending the whole line to the LLM.
    if (orphan === null && (from === null) !== (to === null)) {
      const unknown = (from === null ? left : right).trim();
      const words = unknown.toLowerCase().split(' ');
      if (words.length <= 3 && words.every(w => !NOT_A_PLACE.has(w))) orphan = unknown;
    }
  }
  if (orphan !== null) return { kind: 'error', message: `no airport matches "${orphan}"` };
  return null;
}

// Decoration the provider puts on board names that the airport dataset does
// not carry: "Bengaluru Intl Airport", "Dubai Intl (Terminal 3)", "Khorog
// Airport,Tajikistan". Each was found on a real board, not imagined.
//
// "aeroport" is here because the DATED board does not speak the same language
// as the rolling one. The airport a rolling board calls "Ayodhya" a dated board
// calls "Aeroport Ayodkhya", and Delhi and Kolkata come back as "Deli" and
// "Kalkutta". The spellings themselves are aliases in the dataset; only the
// word "aeroport" belongs here, because it is decoration rather than a name.
const ROUTE_NAME_NOISE =
  /\b(intl|int'l|international|aeroport|airport|arpt|apt|airfield|aerodrome|domestic|terminal)\b/gi;

function routeTidyName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/,.*$/, '')          // "Khorog Airport,Tajikistan"
    .replace(/\(.*?\)/g, ' ')     // "Dubai Intl (Terminal 3)"
    .replace(ROUTE_NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The airport a board name refers to, or null.
//
// The whole tidied name first, then progressively shorter LEADING phrases. The
// provider usually leads with the city and follows it with the airport's own
// name — "Delhi Indira Gandhi", "Mumbai Chhatrapati Shivaji" — and the dataset
// indexes those two separately, never that concatenation. Narrowing to "Delhi"
// is what resolves them; without it the whole string simply misses.
//
// Only ever used to ask "is this row for the destination that was searched
// for", and a wrong answer means the row is left out rather than shown wrongly.
function routeResolveDestination(raw: string | null | undefined): Airport | null {
  const tidy = routeTidyName(raw);
  if (tidy.length < 3) return null;
  // Split on hyphens too, not only spaces. normalizeTerm already turns a hyphen
  // into a space when it builds the dataset's own haystack, so leaving them
  // joined here made the two disagree: "Denpasar-Bali Island" narrowed to
  // "Denpasar-Bali" and never to "Denpasar", which is what actually resolves.
  const words = tidy.split(/[\s-]+/).filter(w => w.length > 0);
  for (let n = words.length; n >= 1; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (candidate.length < 3) continue;
    const hit = resolveAirportName(candidate);
    if (hit !== null) return hit.airport;
  }
  return null;
}

// These caps protect the AeroDataBox quota.
const PULL_COOLDOWN_MS = 60 * 1000;
const AUTO_REFRESH_MAX_FLIGHTS = 2;
const AUTO_REFRESH_MIN_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000; // auto-refresh disabled while on the free tier; set to 12 * 60 * 60 * 1000 to re-enable
const AUTO_REFRESH_RESUME_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const COUNTDOWN_MAX_AGE_MS = 3 * 60 * 60 * 1000; // how fresh data must be to show a live countdown; lower to 30 * 60 * 1000 or 10 * 60 * 1000 for stricter honesty
// The provider's BASIC plan caps requests at one per second and rejects the rest
// with HTTP 429, so consecutive saved-flight lookups are spaced past that ceiling.
const REFRESH_SPACING_MS = 1300;
// The backend fetches a 12-hour board whichever value it is sent, then filters
// down to this. At 6 half of what was already paid for was discarded, so 12 is
// strictly more for the same 2 units.
const ROUTE_TODAY_HOURS = 12;

// Matches ROUTE_MAX_FUTURE_DAYS on the backend. Checked here too so an
// out-of-range date never reaches the network: a dated search costs 4 units.
const ROUTE_MAX_DATE_DAYS = 60;

// THE LABEL BUDGET, in the pieces it is computed from.
//
// The pills STRETCH: each is flex: 1, so a row of n divides the screen evenly
// and every pill's width is known from the layout alone —
//
//     pill = (screen - 2 x SCROLL_PAD - (n-1) x GAP) / n
//     text = pill - CHROME,  and one character is 6.6pt
//
// which makes the budget per-pill and fixed, not shared across the row. There is
// nothing left to allocate between pills, so the round-robin that used to hand
// out a row-wide budget is gone with the content sizing that needed it.
//
// CHROME is 28, not the 36 it was. Stretched thirds are narrow — 88pt at 320pt —
// and at 36 the text budget came to 7 characters, which is under "Departure",
// "duration" and "Filters 3", all of which render today. Trimming the pill's
// horizontal padding from 10 to 8 and the chevron's left margin from 8 to 4
// buys 9 characters and keeps every existing label intact.
const ROUTE_SCROLL_PAD = 20;    // s.scroll paddingHorizontal
const ROUTE_PILL_CHROME = 28;   // 16 padding + 2 border + 4 chevron margin + 6 chevron
const ROUTE_PILL_GAP = 8;       // s.routePillRow gap
const ROUTE_MONO_ADVANCE = 6.6; // JetBrains Mono, fontSize 11
// The picker's "from"/"to" caption sits OUTSIDE the pill, so it comes off the
// pill's budget: s.routeEndSide's 28pt width plus its 8pt marginRight.
const ROUTE_END_SIDE_WIDTH = 36;

// A cap on how wide the panel may GROW, so a long airline name wraps inside it
// rather than running off the right of a 320pt display. "Pakistan International
// Airlines (2)" alone measures 267pt.
//
// It is not what the panel is positioned against: the placement clamp reads the
// panel's measured width. Using this instead treated every panel as if it were
// the widest one possible.
const ROUTE_PANEL_MAX_WIDTH = 260;

// Distance from the panel to its trigger, and the margin it keeps from the top
// and bottom of the window when deciding which side it opens on.
const ROUTE_PANEL_GAP = 6;
const ROUTE_PANEL_EDGE = 12;

// Overlay motion. Entry decelerates hard and settles; exit accelerates away and
// is shorter. The asymmetry is the point: a surface arriving should look like it
// is coming to rest, and one leaving should not make you wait for it.
//
// EASE_OUT is the standard expo-out bezier. Easing.out(Easing.cubic), which
// these used before, spends too much of its budget near the end to read as
// motion at all over 140ms.
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN = Easing.bezier(0.4, 0, 1, 1);

// The panel travels less than the calendar because it starts beside its trigger
// and only has to look like it came out of it.
const OVERLAY_RISE = 10;
const CAL_RISE = 28;

const PANEL_IN_MS = 220;
const PANEL_OUT_MS = 150;
const CAL_IN_MS = 260;
const CAL_OUT_MS = 170;
// Its own timing, on its own value. Slightly ahead going in and slightly behind
// coming out, so the backdrop never looks welded to the surface it sits under.
const SCRIM_IN_MS = 200;
const SCRIM_OUT_MS = 150;

// Local-only view controls. Nothing here re-fetches: every option reorders or
// hides rows already in state.
const ROUTE_SORT_OPTIONS = ['departure', 'arrival', 'duration'] as const;
type RouteSort = typeof ROUTE_SORT_OPTIONS[number];
const ROUTE_SORT_DEFAULT: RouteSort = 'departure';

// The bare enum values are ambiguous on a pill: "departure" could as easily mean
// a filter as an ordering. Naming the quantity being sorted on removes the
// question.
const ROUTE_SORT_LABELS: Record<RouteSort, string> = {
  departure: 'departure time',
  arrival: 'arrival time',
  duration: 'duration',
};

// What the SORT PILL shows, which is not the same thing. The panel has room to
// spell it out; the pill has an 8-character cap, and the default shows the noun
// rather than its value because a pill reading "departure" would look like a
// filter. These are the panel's own words minus the redundant "time".
const ROUTE_SORT_PILL: Record<RouteSort, string> = {
  departure: 'Sort',
  arrival: 'arrival',
  duration: 'duration',
};

// Boundaries are on each airport's own wall clock, not the device's. Labelled in
// 24-hour time so the control reads in the same units as the rows.
// Chronological, so the filter panels and the group headings both read down the
// clock. bandForHour is boundary-based and does not depend on this order; every
// other use derives from it, so this line is the only place ordering lives.
const ROUTE_BANDS = ['00:00-05:00', '05:00-12:00', '12:00-18:00', '18:00-00:00'] as const;
type RouteBand = typeof ROUTE_BANDS[number];

function bandForHour(h: number): RouteBand {
  if (h >= 5 && h < 12) return '05:00-12:00';
  if (h >= 12 && h < 18) return '12:00-18:00';
  if (h >= 18) return '18:00-00:00';
  return '00:00-05:00';
}

const ALL_BANDS_ON: Record<RouteBand, boolean> =
  { '00:00-05:00': true, '05:00-12:00': true, '12:00-18:00': true, '18:00-00:00': true };

// A departure board is almost entirely "scheduled". Printing it on every row is
// a column of identical grey words that buries the one row a traveller actually
// needs to see. Everything else renders, including states this app does not yet
// know about: an unrecognised status is by definition not routine.
const ROUTE_STATUS_ROUTINE = 'scheduled';

// Ceiling on the DRAWN line only. The connector's box still spans everything
// between the two times; the line is centred inside it, so the gap either side
// is equal by construction at any width.
//
// This replaces a duration-proportional left inset, which was a defect: pushing
// the line right grew the left gap while the right gap stayed fixed, so only the
// single longest flight in a list ever showed equal gaps.
const ROUTE_CONNECTOR_MAX = 120;

type FlightData = {
  flight: string;
  airline: string;
  status: string;
  statusColor: string;
  statusBg: string;
  from: string;
  fromFull: string;
  fromCity: string;
  to: string;
  toFull: string;
  toCity: string;
  // The backend's formatted string, kept ONLY as the fallback clock24 needs
  // when there is no ISO to read. Never rendered on its own.
  dep: string;
  arr: string;
  // What is actually rendered, once clock24 has read the digits out of it.
  // Null on a pre-v3 saved record, which is the one case that falls back.
  depIso: string | null;
  arrIso: string | null;
  depTimeLabel: string;
  depTimeValue: string;
  arrTimeLabel: string;
  arrTimeValue: string;
  duration: string | null;
  terminal: string;
  gate: string;
  checkinDesk: string | null;
  aircraft: string | null;
  registration: string | null;
  baggage: string;
  delayLabel: string | null;
  delayValue: string | null;
  date: string;
};

// Only the fields actually rendered. `airline` is deliberately absent: the
// provider mislabels at least one carrier (QP comes back as "Starlight
// Airline", not Akasa Air), and the two-letter prefix of flight_number is the
// reliable identifier. Omitting it here makes rendering it a type error.
type RouteFlight = {
  flight_number: string;
  // Null when the provider named the destination without coding it. Rows that
  // reach the rendered list always have one: routeRecovered fills it in from
  // destination_airport, and a row whose name resolves to nothing never gets
  // there. The type stays honest about the wire.
  destination_iata: string | null;
  // The provider's own name for the destination. Present on every row; the only
  // identifier the null-code ones carry.
  destination_airport?: string | null;
  departure_scheduled: string;
  departure_scheduled_iso: string | null;
  // Null when the board carried no arrival time for this row at all. The
  // backend sends the key with a null value rather than omitting it.
  arrival_scheduled: string | null;
  arrival_scheduled_iso: string | null;
  status: string;
};

type RouteResult = {
  origin: string;
  destination: string;
  window_hours: number;
  // The local calendar date the board was fetched for, or null for the rolling
  // window from now. window_hours does not apply to a dated search.
  date: string | null;
  count: number;
  total_found: number;
  truncated: boolean;
  flights: RouteFlight[];
  // Rows the backend could not match, because the board named the destination
  // without coding it. Candidates, not results: they are not in count,
  // total_found or truncated. Optional so a response from an older backend
  // still parses.
  unresolved?: RouteFlight[];
};

function getStatusColor(status: string) {
  switch (status) {
    case "landed": return "#8e8e93";
    case "active": return "#4ade80";
    case "scheduled": return "#aeaeb2";
    case "delayed": return "#fbbf24";
    case "cancelled": return "#f87171";
    default: return "#fbbf24";
  }
}

function getStatusBg(status: string) {
  switch (status) {
    case "landed": return "#8e8e9312";
    case "active": return "#4ade8012";
    case "scheduled": return "#aeaeb212";
    case "delayed": return "#fbbf2412";
    case "cancelled": return "#f8717112";
    default: return "#fbbf2412";
  }
}

// The backend uses "N/A" for a time that does not exist yet, and saved records
// default to the same string, so neither may be treated as a real value.
function hasTime(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '' && v !== 'N/A';
}

type TimeCell = { label: string; value: string };

// Decides the "what happened / what is expected" row for one movement. Shared by
// the fresh-search card and the saved-record card so the two cannot drift.
function movementTimeCell(
  actual: string | null | undefined,
  estimated: string | null | undefined,
  actualSource: string | null | undefined,
  estimatedSource: string | null | undefined,
  isDeparture: boolean,
): TimeCell {
  const noun = isDeparture ? 'Departure' : 'Arrival';
  if (hasTime(actual)) {
    const suffix = actualSource === 'runway'
      ? (isDeparture ? ' (wheels up)' : ' (touchdown)')
      : '';
    return { label: `Actual ${noun}`, value: `${actual}${suffix}` };
  }
  if (hasTime(estimated)) {
    const suffix = estimatedSource === 'predicted' ? ' (predicted)' : '';
    return { label: `Estimated ${noun}`, value: `${estimated}${suffix}` };
  }
  return {
    label: `Actual ${noun}`,
    value: isDeparture ? 'Not departed yet' : 'Not arrived yet',
  };
}

// Signed minutes -> row label and value. Zero and null hide the row entirely.
function delayCell(delay: number | null | undefined): { label: string | null; value: string | null } {
  if (typeof delay !== 'number' || delay === 0) return { label: null, value: null };
  const magnitude = Math.abs(delay);
  const unit = magnitude === 1 ? 'minute' : 'minutes';
  return delay > 0
    ? { label: 'Delay', value: `${magnitude} ${unit}` }
    : { label: 'Early', value: `${magnitude} ${unit}` };
}

// A not-yet-departed flight already running late reads better as "delayed" than
// as "scheduled". Display only — the stored status vocabulary is unchanged.
function displayStatus(status: string, departureDelay: number | null | undefined): string {
  if (status === 'scheduled' && typeof departureDelay === 'number' && departureDelay > 0) {
    return 'delayed';
  }
  return status;
}

// Scheduled block time, from the two scheduled ISO values in their own zones.
function scheduledDuration(
  depIso: string | null,
  depTz: string | null,
  arrIso: string | null,
  arrTz: string | null,
): string | null {
  const dep = zonedIsoToTs(depIso, depTz);
  const arr = zonedIsoToTs(arrIso, arrTz);
  if (dep == null || arr == null) return null;
  const totalMin = Math.round((arr - dep) / 60000);
  if (totalMin <= 0) return null;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Fraction of the flight elapsed, or null meaning "do not draw the bar at all".
// Called at render time from the live `now` so it advances with the clock.
function computeProgress(f: SavedFlight | null, now: number): number | null {
  if (!f) return null;
  const s = f.status.toLowerCase();
  if (s === 'landed') return 1;
  if (s === 'scheduled') return 0;
  if (s !== 'active') return null; // cancelled, diverted, unknown, anything else
  const depIso = f.from.actualIso ?? f.from.estimatedIso ?? f.from.scheduledIso;
  const arrIso = f.to.estimatedIso ?? f.to.scheduledIso;
  const dep = zonedIsoToTs(depIso, f.from.timezone);
  const arr = zonedIsoToTs(arrIso, f.to.timezone);
  if (dep == null || arr == null || arr <= dep) return null;
  return Math.min(0.98, Math.max(0.02, (now - dep) / (arr - dep)));
}

function flightDataFromApi(data: any): FlightData {
  const dep = data?.departure ?? {};
  const arr = data?.arrival ?? {};
  const status = displayStatus((data?.status || "unknown").toLowerCase(), dep.delay);
  // Formatted BEFORE the cell is chosen, because the cell appends "(predicted)"
  // or "(wheels up)" to the value and there would be no way to reach the time
  // again afterwards. clock24 leaves "N/A" alone, so hasTime still recognises it.
  const depCell = movementTimeCell(
    clock24(dep.actual_iso ?? null, dep.actual),
    clock24(dep.estimated_iso ?? null, dep.estimated),
    dep.actual_source, dep.estimated_source, true);
  const arrCell = movementTimeCell(
    clock24(arr.actual_iso ?? null, arr.actual),
    clock24(arr.estimated_iso ?? null, arr.estimated),
    arr.actual_source, arr.estimated_source, false);
  const delay = delayCell(dep.delay);
  return {
    flight: data?.flight_number || "—",
    airline: data?.airline || "—",
    status: status.toUpperCase(),
    statusColor: getStatusColor(status),
    statusBg: getStatusBg(status),
    from: dep.iata || "—",
    fromFull: airportFullLabel(dep.short_name ?? null, dep.city ?? null, dep.airport || "—"),
    // City where there is one, airport name where there is not: the provider
    // omits municipalityName on plenty of airports.
    fromCity: dep.city || dep.airport || "—",
    to: arr.iata || "—",
    toFull: airportFullLabel(arr.short_name ?? null, arr.city ?? null, arr.airport || "—"),
    toCity: arr.city || arr.airport || "—",
    dep: dep.scheduled || "N/A",
    arr: arr.scheduled || "N/A",
    depIso: dep.scheduled_iso ?? null,
    arrIso: arr.scheduled_iso ?? null,
    depTimeLabel: depCell.label,
    depTimeValue: depCell.value,
    arrTimeLabel: arrCell.label,
    arrTimeValue: arrCell.value,
    duration: scheduledDuration(dep.scheduled_iso ?? null, dep.timezone ?? null, arr.scheduled_iso ?? null, arr.timezone ?? null),
    terminal: dep.terminal || "N/A",
    gate: dep.gate || "N/A",
    checkinDesk: dep.checkin_desk ?? null,
    aircraft: data?.aircraft_model ?? null,
    registration: data?.aircraft_registration ?? null,
    baggage: arr.baggage || "N/A",
    delayLabel: delay.label,
    delayValue: delay.value,
    date: data?.flight_date || "N/A",
  };
}

function timeAgo(ts: number, now: number) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Header line, e.g. "Sat, 16 Aug · 02:04". Fixed arrays rather than Intl so
// the output never shifts with locale.
//
// 24-hour, matching the route rows. Both parts are zero-padded, so the line is
// the same nineteen characters at every hour and no longer changes width as the
// meridiem comes and goes.
function formatClock(ts: number) {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = String(d.getDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]}, ${day} ${MONTHS[d.getMonth()]} · ${time}`;
}

// WEEKDAYS holds abbreviations for the clock line; "Happy Sat" reads clipped in
// a greeting, so the full names live here. Only the weekend entries reach it.
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Greeting prefixes, keyed by the situation greetingPrefix resolves to. Every
// entry renders as "<prefix>, <name>", so each has to read naturally in front of
// a comma and a first name. '{day}' is substituted with the weekday name.
const GREETINGS = {
  morning: ['Good morning', 'Morning', 'Up early'],
  afternoon: ['Good afternoon', 'Afternoon'],
  evening: ['Good evening', 'Evening', 'Winding down'],
  night: ['Still up', 'Late one'],
  mondayMorning: ['Monday again', 'New week', 'Good morning'],
  weekendMorning: ['Happy {day}', 'Slow start', 'Weekend mode'],
  weekendAfternoon: ['Enjoy the weekend', 'Good afternoon'],
};

// Pure and total. Day-specific cases resolve first, then the plain hour buckets.
// The night bucket spans 22-04 and so wraps past midnight, which is why it is
// the fallthrough rather than a range. Evenings and nights are deliberately
// shared across every day: a Saturday 2am is not different from a Tuesday 2am.
// The double modulo keeps the lookup total for a negative index.
function greetingPrefix(ts: number, index: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const h = d.getHours();
  const isWeekend = day === 0 || day === 6;
  const pool =
    day === 1 && h >= 5 && h <= 11 ? GREETINGS.mondayMorning :
    isWeekend && h >= 5 && h <= 11 ? GREETINGS.weekendMorning :
    isWeekend && h >= 12 && h <= 16 ? GREETINGS.weekendAfternoon :
    h >= 5 && h <= 11 ? GREETINGS.morning :
    h >= 12 && h <= 16 ? GREETINGS.afternoon :
    h >= 17 && h <= 21 ? GREETINGS.evening :
    GREETINGS.night;
  const prefix = pool[((index % pool.length) + pool.length) % pool.length];
  // No-op for every entry without the token.
  return prefix.replace('{day}', WEEKDAYS_LONG[day]);
}

// YYYY-MM-DD from the device's own calendar parts. Never toISOString, which
// reports UTC and lands on the wrong day either side of midnight.
function localIsoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// "Sat, 29 Aug" from a YYYY-MM-DD string, or the string itself if unparseable.
// Built from the fixed WEEKDAYS/MONTHS arrays so it never shifts with locale.
function routeDateLabel(iso: string | null): string {
  if (!iso) return 'Today';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "16 Sep" for the date pill, where routeDateLabel's "Sat 29 Aug" costs four
// characters the row cannot spare. The weekday is the first thing to go: the
// applied-date line above the list still spells it out in full, so nothing is
// lost, and a day and month alone are unambiguous inside a 60-day window.
function routeShortDate(iso: string | null): string {
  if (!iso) return 'Today';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// Display-only handle. Saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

function localDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// "6:40 PM IST" -> "6:40 PM". A departure board omits the origin airport
// object, so departure times arrive with no zone label while arrivals have one;
// dropping the label restores symmetry. Anything without AM/PM is returned
// untouched rather than guessed at — trimming the last token would corrupt an
// unlabelled value like "18:40" or "N/A".
function stripZoneLabel(t: string): string {
  if (typeof t !== 'string') return '';
  const m = /^(.*?[AP]M)\b/.exec(t);
  return m ? m[1] : t;
}

// "2026-08-21T15:45+05:30" -> "15:45". Every time in the app comes through
// here: route rows, the flight card, and the saved list. There is no second way
// to format a time in this file, and no time is displayed as the backend
// formatted it while an ISO value for it exists.
//
// READ AS TEXT, never through Date. That is what makes one helper correct for
// both kinds of ISO this app handles, which are not the same:
//
//   ROUTE rows      local digits + a TRUE offset      "...T15:45+05:30"
//   FLIGHT DTO      local digits + a bogus "+00:00"   "...T15:45+00:00"
//
// The offsets differ and cannot be compared, but the DIGITS BEFORE THEM are the
// airport's own wall clock in both — which is precisely the value being
// rendered. new Date(iso).getHours() would re-express the instant in the
// DEVICE's zone and silently shift every time on screen, and it would shift the
// two kinds differently. zonedIsoToTs exists for the other question, "what
// instant is this", and must not be used for display.
//
// Already zero-padded upstream, so every result is exactly five characters —
// which is what lets both route time cells share one fixed width.
const ISO_CLOCK_RE = /T(\d{2}:\d{2})/;

function clock24(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const m = ISO_CLOCK_RE.exec(iso);
  // Unparseable, or a record saved before the schema carried ISO at all: show
  // what was stored, untouched. A pre-v3 saved flight has no ISO to convert
  // from and would otherwise render nothing; a stale 12-hour value is worse
  // than the rest of the card but far better than a blank, and it corrects
  // itself the first time that flight is refreshed.
  return m ? m[1] : fallback;
}

// Shown when a row has no arrival time of any kind. An em dash says "not known"
// in the width of a glyph; the "N/A" that used to arrive here said it in the
// width of a word and read as an error rather than as a gap. The font already
// renders this dash elsewhere in the file at MONO_BOLD.
const ROUTE_NO_TIME = '\u2014';

function trimAirportName(name: string) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf(' (');
  return (i >= 0 ? name.slice(0, i) : name).trim();
}

// "London Gatwick Airport" -> "London Gatwick".
//
// Past trimAirportName's parenthetical, two words carry nothing on a control
// that is already an airport picker. Both are dropped ANYWHERE they appear, not
// just at the end: BWI is "Baltimore/Washington International Thurgood Marshall
// Airport" and EZE is "Ezeiza International Airport - Ministro Pistarini", so a
// trailing-only rule would miss both.
function routeAirportShort(name: string): string {
  const base = trimAirportName(name);
  const cut = base
    .replace(/\bInternational\b/gi, ' ')
    .replace(/\bAirports?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\u2013-]+|[\s\u2013-]+$/g, '');
  return cut === '' ? base : cut;
}

// Clips to `room` characters INCLUDING the ellipsis, at a word boundary when
// that does not throw away more than half of what was asked for.
function routeClip(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = text.slice(0, room - 1);
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.ceil(room / 2) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s\u2013,-]+$/, '')}\u2026`;
}

// The airport picker's label: the airport, and nothing else.
//
//   1. name and code   "London Gatwick (LGW)"
//   2. name alone      "Tenerife Norte-Ciudad de La Laguna"
//   3. name clipped    "Sao Paulo/Guarulhos-Governor..."
//
// No count. A "+3 more" beside one airport name reads as three things selected
// rather than three available, and the chevron already says the control opens.
// Dropping it gives the name and the code six more characters, which is why
// both now survive at 320pt for every airport a curated city can offer.
function routeEndLabel(code: string, name: string, cap: number): string {
  const short = routeAirportShort(name);
  const withCode = `${short} (${code})`;
  if (withCode.length <= cap) return withCode;
  if (short.length <= cap) return short;
  return routeClip(short, cap);
}

// "Chhatrapati Shivaji, Mumbai" when the provider supplies both parts and they
// differ, otherwise the full airport name alone. Single-name airports return
// shortName === city — DXB is "Dubai"/"Dubai" — and must not read "Dubai,
// Dubai". Compared case-insensitively after trimming.
function airportFullLabel(shortName: string | null, city: string | null, airport: string): string {
  const s = (shortName ?? '').trim();
  const c = (city ?? '').trim();
  if (s && c && s.toLowerCase() !== c.toLowerCase()) return `${s}, ${c}`;
  return airport;
}

function InfoRow({ label, value, sans }: { label: string; value: string; sans?: boolean }) {
  return (
    <View style={ir.row}>
      <Text style={ir.label}>{label}</Text>
      <Text style={[ir.value, sans && ir.valueSans]}>{value}</Text>
    </View>
  );
}

const ir = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  label: { fontSize: 13, color: "rgba(226,226,226,0.45)", fontFamily: SANS },
  value: { fontSize: 13, color: "#ffffff", textAlign: "right", flex: 1, marginLeft: 16, fontFamily: MONO },
  valueSans: { fontFamily: SANS },
});

// --- Live-countdown helpers -------------------------------------------------
const CD_GREEN = '#4ade80';
const CD_AGE = 'rgba(226,226,226,0.3)';
const CD_LATE = '#fbbf24';
const CD_EARLY = 'rgba(226,226,226,0.5)';

type LineSeg = { text: string; color: string };

// The backend's *_iso fields carry a bogus "+00:00"; the value is the airport's
// LOCAL wall clock. Strip the offset, treat as naive, interpret in the IANA zone.
// Never use `new Date(iso)` on these directly.
function zonedIsoToTs(iso: string | null, timeZone: string | null): number | null {
  if (!iso || !timeZone) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asZoned = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return guess - (asZoned - guess); // subtract the zone offset at that instant
  } catch {
    return null;
  }
}

function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

// scheduled/active: estimated vs scheduled. landed: actual (else estimated) vs scheduled.
function delaySegment(ep: SavedFlightEndpoint, status: string): LineSeg | null {
  const sch = zonedIsoToTs(ep.scheduledIso, ep.timezone);
  const cmpIso = status === 'landed' ? (ep.actualIso ?? ep.estimatedIso) : ep.estimatedIso;
  const cmp = zonedIsoToTs(cmpIso, ep.timezone);
  if (cmp == null || sch == null) return null;
  const diffMin = Math.round((cmp - sch) / 60000);
  if (Math.abs(diffMin) < 5) return null;
  return diffMin > 0
    ? { text: ` · ${diffMin}m late`, color: CD_LATE }
    : { text: ` · ${Math.abs(diffMin)}m early`, color: CD_EARLY };
}

function absoluteTime(f: SavedFlight): string {
  const s = f.status.toLowerCase();
  if (s === 'landed') {
    return f.to.actual && f.to.actual !== 'N/A'
      ? clock24(f.to.actualIso, f.to.actual)
      : clock24(f.to.scheduledIso, f.to.scheduled);
  }
  if (s === 'active') return clock24(f.to.scheduledIso, f.to.scheduled);
  return clock24(f.from.scheduledIso, f.from.scheduled);
}

// Line-2 / card status line. Always leads with the coloured status word so the
// row still says what the flight is doing when the countdown falls away.
function flightLineSegments(f: SavedFlight, now: number): LineSeg[] {
  const s = f.status.toLowerCase();
  const statusSeg: LineSeg = { text: s, color: getStatusColor(s) };
  const fresh = now - f.updatedAt < COUNTDOWN_MAX_AGE_MS;

  let ep: SavedFlightEndpoint | null = null;
  let iso: string | null = null;
  let verb: 'departs in' | 'lands in' | null = null;
  if (s === 'scheduled') { ep = f.from; iso = f.from.estimatedIso ?? f.from.scheduledIso; verb = 'departs in'; }
  else if (s === 'active') { ep = f.to; iso = f.to.estimatedIso ?? f.to.scheduledIso; verb = 'lands in'; }
  else if (s === 'landed') { ep = f.to; iso = f.to.actualIso ?? f.to.estimatedIso ?? f.to.scheduledIso; }

  const ts = fresh && ep ? zonedIsoToTs(iso, ep.timezone) : null;

  if (fresh && ep && ts != null) {
    if (s === 'landed') {
      const ago = now - ts;
      if (ago >= 0) {
        const segs: LineSeg[] = [statusSeg, { text: ` · ${formatCountdown(ago)} ago`, color: 'rgba(226,226,226,0.5)' }];
        const d = delaySegment(ep, s); if (d) segs.push(d);
        return segs;
      }
    } else if (verb) {
      const diff = ts - now;
      if (diff >= 0) {
        const segs: LineSeg[] = [statusSeg, { text: ` · ${verb} ${formatCountdown(diff)}`, color: CD_GREEN }];
        const d = delaySegment(ep, s); if (d) segs.push(d);
        return segs;
      }
    }
  }

  // Fallback: status · updated <age> [· absolute time]
  const abs = absoluteTime(f);
  const tail = abs && abs !== 'N/A'
    ? ` · updated ${timeAgo(f.updatedAt, now)} · ${abs}`
    : ` · updated ${timeAgo(f.updatedAt, now)}`;
  return [statusSeg, { text: tail, color: CD_AGE }];
}

function StatusLine({ f, now, style, numberOfLines, hideStatus }: { f: SavedFlight; now: number; style?: any; numberOfLines?: number; hideStatus?: boolean }) {
  const all = flightLineSegments(f, now);
  // The status word is always the first segment, and everything after it opens
  // with " · ". Dropping the word means dropping that separator too.
  const segs = hideStatus
    ? all.slice(1).map((seg, i) => (i === 0 ? { ...seg, text: seg.text.replace(/^ · /, '') } : seg))
    : all;
  return (
    <Text style={[{ fontFamily: MONO, fontSize: 11 }, style]} numberOfLines={numberOfLines}>
      {segs.map((seg, i) => <Text key={i} style={{ color: seg.color }}>{seg.text}</Text>)}
    </Text>
  );
}

// Relevance order: in the air, then upcoming, then finished. Unparseable times
// sink to the end of their own group rather than the end of the list.
const SAVED_RANK: Record<string, number> = { active: 0, scheduled: 1, delayed: 1 };
const RANK_LAST = 2;
const NO_TIME = Number.MAX_SAFE_INTEGER;

function savedSortKey(f: SavedFlight): { rank: number; when: number } {
  const s = f.status.toLowerCase();
  const rank = SAVED_RANK[s] ?? RANK_LAST;
  if (rank === 0) {
    // Same precedence flightLineSegments uses for an active flight.
    return { rank, when: zonedIsoToTs(f.to.estimatedIso ?? f.to.scheduledIso, f.to.timezone) ?? NO_TIME };
  }
  if (rank === 1) {
    return { rank, when: zonedIsoToTs(f.from.estimatedIso ?? f.from.scheduledIso, f.from.timezone) ?? NO_TIME };
  }
  return { rank, when: -f.updatedAt };   // negated so the newest sorts first
}

// Pure: returns a new array, never mutates the input.
function sortSavedByRelevance(list: SavedFlight[]): SavedFlight[] {
  return [...list].sort((a, b) => {
    const ka = savedSortKey(a);
    const kb = savedSortKey(b);
    return ka.rank !== kb.rank ? ka.rank - kb.rank : ka.when - kb.when;
  });
}

function SavedFlightRow({
  flight,
  onPress,
  onUnsave,
  now,
}: { flight: SavedFlight; onPress: () => void; onUnsave: () => void; now: number }) {
  return (
    <TouchableOpacity style={sf.row} onPress={onPress} activeOpacity={0.7}>
      <View style={sf.line1}>
        <Text style={sf.number}>{flight.flightNumber}</Text>
        <Text style={sf.route} numberOfLines={1}>{`${flight.from.iata} → ${flight.to.iata}`}</Text>
        <TouchableOpacity
          onPress={onUnsave}
          activeOpacity={0.7}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={sf.remove}>{'×'}</Text>
        </TouchableOpacity>
      </View>
      <StatusLine f={flight} now={now} numberOfLines={1} style={{ marginTop: 4 }} />
    </TouchableOpacity>
  );
}

const sf = StyleSheet.create({
  row: {
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  line1: { flexDirection: 'row', alignItems: 'center' },
  number: { fontSize: 13, color: '#ffffff', fontFamily: MONO_BOLD },
  // Deliberately outside the type scale: this is a hit target, not text.
  chevron: { fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)' },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  collapsedLine: { paddingVertical: 10 },
  collapsedNumber: { fontFamily: MONO, fontSize: 11, color: '#ffffff' },
  collapsedDim: { fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.45)' },
  route: { fontSize: 13, color: 'rgba(226,226,226,0.6)', fontFamily: MONO, flex: 1, marginLeft: 12 },
  updated: { color: 'rgba(226,226,226,0.3)' },
  remove: {
    fontSize: 20,
    color: 'rgba(248,113,113,0.55)',
    fontFamily: MONO,
    paddingLeft: 12,
  },
});

function ProgressBar({ progress, color }: { progress: number; color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  const planeAnim = useRef(new Animated.Value(0)).current;

  // Keyed on `progress` so the bar re-animates as the flight advances. The old
  // useState-callback form ran once and never again.
  useEffect(() => {
    Animated.parallel([
      Animated.timing(anim, {
        toValue: progress,
        duration: 1400,
        delay: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(planeAnim, {
        toValue: progress,
        duration: 1400,
        delay: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  }, [progress]);

  return (
    <View style={pg.wrap}>
      <View style={pg.track}>
        <Animated.View
          style={[
            pg.fill,
            {
              width: anim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
              backgroundColor: color,
            },
          ]}
        />
      </View>
      <Animated.Text
        style={[
          pg.plane,
          {
            left: planeAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ["0%", "88%"],
            }),
          },
        ]}
      >
        ✈
      </Animated.Text>
    </View>
  );
}

const pg = StyleSheet.create({
  wrap: { marginVertical: 24, position: "relative" },
  track: { height: 3, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 2, marginBottom: 14 },
  fill: { height: 3, borderRadius: 2 },
  plane: { position: "absolute", top: -11, fontSize: 20, color: "#ffffff" },
});

function ProfileModal({
  visible, onClose, onGoogleSignIn, onLogout, username,
  email, effectiveName, askName, onSaveName, onSkipName,
}: {
  visible: boolean; onClose: () => void; onGoogleSignIn: () => void; onLogout: () => void;
  username: string | null; email: string | null; effectiveName: string | null; askName: boolean;
  onSaveName: (name: string) => void; onSkipName: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(effectiveName ?? '');
  const [editing, setEditing] = useState(false);

  // Re-seed each time the sheet opens so a discarded edit does not linger.
  useEffect(() => {
    if (visible) {
      setNameDraft(effectiveName ?? '');
      setEditing(false);
    }
  }, [visible, effectiveName]);

  // The first-run ask forces the input open; otherwise the pencil does.
  const showInput = askName || editing;

  const commitName = () => {
    const cleaned = sanitiseDisplayName(nameDraft);
    if (!cleaned) return;            // empty after sanitising: keep the old value and stay open
    setEditing(false);
    onSaveName(cleaned);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={askName ? onSkipName : onClose}>
      <View style={pm.backdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={pm.sheet}>
            <TouchableOpacity style={pm.closeBtn} onPress={askName ? onSkipName : onClose}>
              <Text style={pm.closeTxt}>X</Text>
            </TouchableOpacity>

            <View style={pm.avatar}>
              <Text style={pm.avatarTxt}>{'//'}</Text>
            </View>
            {username !== null && showInput && (
              <>
                <Text style={pm.nameLabel}>{askName ? 'pick a name' : 'username'}</Text>
                <View style={pm.nameRow}>
                  <TextInput
                    style={pm.nameInput}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    onSubmitEditing={commitName}
                    placeholder="terminal"
                    placeholderTextColor="rgba(226,226,226,0.25)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={14}
                    selectionColor="#4ade80"
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={pm.nameBtn} activeOpacity={0.75} onPress={commitName}>
                    <Text style={pm.nameBtnTxt}>{'save'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {username !== null && !showInput && (
              <View style={pm.nameLine}>
                <Text style={pm.name}>{effectiveName ?? 'Guest User'}</Text>
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => setEditing(true)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Text style={pm.pencil}>{'\u270E'}</Text>
                </TouchableOpacity>
              </View>
            )}

            {username === null && (
              <Text style={[pm.name, { marginBottom: 8 }]}>{effectiveName ?? 'Guest User'}</Text>
            )}

            <Text style={pm.sub}>{username ? (email ? `signed in as ${email}` : 'signed in') : 'Sign in to sync your flights'}</Text>

            {!username && (
              <>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75} onPress={onGoogleSignIn}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 24 24">
                      <G>
                        <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                        <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </G>
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Google </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 21 21">
                      <Rect x="1" y="1" width="9" height="9" fill="#F25022" />
                      <Rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                      <Rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                      <Rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Microsoft </Text>
                  </View>
                </TouchableOpacity>
              </>
            )}

            {username && (
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={onLogout}
                style={{ alignSelf: 'center', marginTop: 20, paddingVertical: 8 }}
              >
                <Text style={{ fontFamily: SANS, fontSize: 13, color: 'rgba(248,113,113,0.7)' }}> Log out </Text>
              </TouchableOpacity>
            )}

          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const PLACEHOLDER_PROMPTS = [
  'what is the status of EK500...',
  'is my flight on time?',
  'when does the next flight to New York leave?',
  'what gate is BA178 at?',
  'is there a delay on my LA flight?',
  'track my connecting flight to Chicago...',
  'when does the next flight to Dubai leave?',
  'is my Mumbai flight delayed?',
  'what time does AA101 land in JFK?',
];

function AnimatedPlaceholder() {
  const [text, setText] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>(r => { timer = setTimeout(r, ms); });

    let idx = 0;
    const loop = async () => {
      while (!cancelled) {
        const prompt = PLACEHOLDER_PROMPTS[idx];

        for (let i = 1; i <= prompt.length && !cancelled; i++) {
          await sleep(80);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;

        await sleep(1500);
        if (cancelled) break;

        for (let i = prompt.length - 1; i >= 0 && !cancelled; i--) {
          await sleep(50);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;

        await sleep(400);
        if (cancelled) break;

        idx = (idx + 1) % PLACEHOLDER_PROMPTS.length;
      }
    };

    loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <Text
      style={{ position: 'absolute', left: 0, right: 0, top: 0, color: '#2c2c2e', fontFamily: MONO, fontSize: 15 }}
      numberOfLines={1}
      pointerEvents="none"
    >
      {text}
    </Text>
  );
}

export default function Index() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [flight, setFlight] = useState<FlightData | null>(null);
  const [focused, setFocused] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [errorCounter, setErrorCounter] = useState(0);
  const [chatResponse, setChatResponse] = useState<string | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  // null means Today, which sends no date parameter at all and so preserves the
  // existing relative-form search exactly.
  const [routeDate, setRouteDate] = useState<string | null>(null);
  const [routeCalOpen, setRouteCalOpen] = useState(false);
  // The month the grid is showing, independent of what is selected.
  const [routeCalMonth, setRouteCalMonth] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  // Where the open filter panel floats, measured from its trigger in window
  // coordinates so the panel can live in a Modal and still sit under its control.
  // top and bottom are the two candidate placements; the space fields decide
  // which of them the panel actually gets.
  //
  // x and width are the TRIGGER's own geometry, stored unclamped. Nothing here
  // can decide the horizontal placement, because that needs the panel's width
  // and the panel has not laid out yet.
  const [routeAnchor, setRouteAnchor] = useState<{
    x: number;
    width: number;
    screen: number;
    top: number;
    bottom: number;
    spaceBelow: number;
    spaceAbove: number;
  } | null>(null);
  // The panel's own size, reported by onLayout on its first pass. Null until
  // then, which is also what holds the fade back — see routePanelMeasured.
  // Both dimensions, from the one event: the height decides which side it opens
  // on, the width decides where its left edge lands.
  const [routePanelSize, setRoutePanelSize] = useState<{ w: number; h: number } | null>(null);
  // Declared here, not beside the placement maths below, because the fade
  // effect names it in a dependency array and would otherwise read it before
  // its own initialiser has run.
  const routePanelMeasured = routePanelSize !== null;
  const [routeFiltersOpen, setRouteFiltersOpen] = useState(false);
  const [routeSort, setRouteSort] = useState<RouteSort>(ROUTE_SORT_DEFAULT);
  // One slot, so opening any control closes the others by construction.
  const [routeOpenDrop, setRouteOpenDrop] =
    useState<null | 'sort' | 'dep' | 'arr' | 'air' | 'orig' | 'dest'>(null);
  // What each end of the current result COULD have meant. Length 1 is the
  // ordinary case and renders nothing; longer means the name did not choose
  // between airports, and the picker under the heading says which one won.
  const [routePick, setRoutePick] = useState<{ from: Airport[]; to: Airport[] } | null>(null);
  // The flight number currently being looked up and saved from a route row, or
  // null. A single slot, not a set: it doubles as the guard that stops a user
  // firing several 2-unit lookups by tapping down the list.
  const [routeSavingKey, setRouteSavingKey] = useState<string | null>(null);
  const [routeDepBands, setRouteDepBands] = useState<Record<RouteBand, boolean>>(ALL_BANDS_ON);
  const [routeArrBands, setRouteArrBands] = useState<Record<RouteBand, boolean>>(ALL_BANDS_ON);
  // Exclusions rather than inclusions: the airline list is derived per result
  // set, so an empty array means "all on" without having to seed state for
  // carriers we have not seen yet.
  const [routeAirlinesOff, setRouteAirlinesOff] = useState<string[]>([]);
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  // Persisted under 'savedCollapsed'. Starts true so an absent key means
  // collapsed; hydration only overrides it when the key exists.
  const [savedCollapsed, setSavedCollapsed] = useState(true);
  const [flightRecord, setFlightRecord] = useState<SavedFlight | null>(null);
  const [saveError, setSaveError] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Picked on mount, re-picked only by onRefresh. The header re-renders every
  // 60s on the `now` tick, so choosing this during render would reshuffle the
  // greeting every minute. 60 is a whole multiple of every pool length (3 and
  // 2), so the modulo stays uniform.
  const [greetingIndex, setGreetingIndex] = useState(() => Math.floor(Math.random() * 60));
  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshMsgCounter, setRefreshMsgCounter] = useState(0);
  const [refreshTone, setRefreshTone] = useState<'error' | 'info'>('error');
  // Session only, never persisted. Counter retriggers the fade on repeat taps.
  const [toastMsg, setToastMsg] = useState("");
  const [toastCounter, setToastCounter] = useState(0);
  const insets = useSafeAreaInsets();
  // The hook, not Dimensions.get: this has to re-render on rotation, or the
  // labels would keep the width they were built for.
  const { width: routeWinWidth } = useWindowDimensions();

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    iosClientId: '970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e.apps.googleusercontent.com',
    androidClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    redirectUri: 'com.googleusercontent.apps.970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e:/oauth2redirect',
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  });

  useEffect(() => {
    console.log('[Auth] response:', JSON.stringify(response));
    if (response?.type === 'success') {
      const accessToken = response.authentication?.accessToken;
      if (!accessToken) return;
      (async () => {
        try {
          const userInfo = await fetch('https://www.googleapis.com/userinfo/v2/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const user = await userInfo.json();
          const name = user.email.split('@')[0].match(/^[a-zA-Z]+/)[0];
          const validEmail = typeof user.email === 'string' && user.email.trim() ? user.email : null;
          await SecureStore.setItemAsync('username', name);
          await SecureStore.setItemAsync('gmailToken', accessToken);
          if (validEmail) await SecureStore.setItemAsync('email', validEmail);
          setUsername(name);
          setGmailToken(accessToken);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        } catch (err) {
          console.log('[Auth] userinfo fetch error:', err);
        }
      })();
    }
  }, [response]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const u = localStorage.getItem('username');
      if (u) setUsername(u);
      const e = localStorage.getItem('email');
      if (e) setEmail(e);
      const dn = localStorage.getItem('displayName');
      if (dn) setDisplayName(dn);
      // Resolved before authHydrated, which gates the saved-list load, so the
      // section never renders expanded and then snaps shut.
      AsyncStorage.getItem('savedCollapsed').then(c => {
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    } else {
      Promise.all([
        SecureStore.getItemAsync('username'),
        SecureStore.getItemAsync('gmailToken'),
        SecureStore.getItemAsync('email'),
        SecureStore.getItemAsync('displayName'),
        AsyncStorage.getItem('savedCollapsed'),
      ]).then(([u, t, e, dn, c]) => {
        if (u) setUsername(u);
        if (t) setGmailToken(t);
        if (e) setEmail(e);
        if (dn) setDisplayName(dn);
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    }
  }, []);

  // First-run ask. Only after hydration, only when signed in, and only while
  // displayName is still unset — which skipping also fills, so it asks once.
  useEffect(() => {
    if (!authHydrated) return;
    if (username === null) return;
    if (displayName !== null) return;
    setProfileOpen(true);
  }, [authHydrated, username, displayName]);

  useEffect(() => {
    if (!authHydrated) return;
    let cancelled = false;
    (async () => {
      await migrateLegacyIfNeeded();
      const list = email
        ? await mergeGuestInto(email)
        : await getSavedFlights(null);
      if (!cancelled) {
        setSavedFlights(list);
        autoRefresh(list, () => cancelled);
      }
    })();
    return () => { cancelled = true; };
  }, [authHydrated, email]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      (window as any).google.accounts.id.initialize({
        client_id: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
        scope: 'profile email https://www.googleapis.com/auth/gmail.readonly',
        callback: (credentialResponse: any) => {
          const payload = JSON.parse(atob(credentialResponse.credential.split('.')[1]));
          const firstName = (payload.email as string).split('@')[0].match(/^[a-zA-Z]+/)?.[0] || 'user';
          const validEmail = typeof payload.email === 'string' && payload.email.trim() ? payload.email : null;
          localStorage.setItem('username', firstName);
          if (validEmail) localStorage.setItem('email', validEmail);
          setUsername(firstName);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        },
      });
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);


  const errorShake = useRef(new Animated.Value(0)).current;
  const resultOpacity = useRef(new Animated.Value(0)).current;
  const resultTranslate = useRef(new Animated.Value(30)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const cardBorderAnim = useRef(new Animated.Value(0)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  const errorMsgOpacity = useRef(new Animated.Value(0)).current;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const lastAutoRefreshRef = useRef(0);
  const dayRef = useRef(localDayKey(Date.now()));
  const refreshMsgOpacity = useRef(new Animated.Value(0)).current;
  const refreshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  // Four values, not two: each overlay drives its content and its scrim
  // separately, so the backdrop can run its own timing. Every property either
  // value touches is opacity or transform, so all of it is native-driven and
  // none of it can move the layout underneath.
  const routePanelAnim = useRef(new Animated.Value(0)).current;
  const routeScrimAnim = useRef(new Animated.Value(0)).current;
  const routeCalAnim = useRef(new Animated.Value(0)).current;
  const routeCalScrimAnim = useRef(new Animated.Value(0)).current;
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cardBorderAnim.stopAnimation();
    if (loading) {
      const fastPulse = (anim: Animated.Value) => Animated.loop(Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 200, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: false }),
      ]));
      fastPulse(cardBorderAnim).start();
    } else if (focused) {
      Animated.loop(Animated.sequence([
        Animated.timing(cardBorderAnim, { toValue: 1, duration: 530, useNativeDriver: false }),
        Animated.timing(cardBorderAnim, { toValue: 0, duration: 530, useNativeDriver: false }),
      ])).start();
    } else {
      cardBorderAnim.setValue(0);
    }
  }, [focused, loading]);

  useEffect(() => {
    if (flight?.status === 'ACTIVE') {
      Animated.loop(Animated.sequence([
        Animated.timing(badgePulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
        Animated.timing(badgePulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])).start();
    } else {
      badgePulse.stopAnimation();
      badgePulse.setValue(1);
    }
  }, [flight]);

  useEffect(() => {
    if (error === '') return;
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorMsgOpacity.stopAnimation();
    errorMsgOpacity.setValue(1);
    cardBorderAnim.stopAnimation();
    cardBorderAnim.setValue(2);
    Animated.parallel([
      Animated.sequence([
        Animated.delay(2500),
        Animated.timing(cardBorderAnim, { toValue: 0, duration: 500, useNativeDriver: false }),
      ]),
      Animated.timing(errorMsgOpacity, { toValue: 0, duration: 500, delay: 2500, useNativeDriver: false }),
    ]).start();
    errorTimerRef.current = setTimeout(() => setError(''), 3000);
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, [error, errorCounter]);

  useEffect(() => {
    if (saveError === '') return;
    const t = setTimeout(() => setSaveError(''), 3000);
    return () => clearTimeout(t);
  }, [saveError]);

  useEffect(() => {
    if (refreshMsg === '') return;
    if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current);
    refreshMsgOpacity.stopAnimation();
    refreshMsgOpacity.setValue(1);
    Animated.timing(refreshMsgOpacity, { toValue: 0, duration: 500, delay: 4500, useNativeDriver: false }).start();
    refreshMsgTimerRef.current = setTimeout(() => setRefreshMsg(''), 5000);
    return () => { if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current); };
  }, [refreshMsg, refreshMsgCounter]);

  useEffect(() => {
    if (toastMsg === '') return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastOpacity.stopAnimation();
    toastOpacity.setValue(1);
    Animated.timing(toastOpacity, { toValue: 0, duration: 300, delay: 900, useNativeDriver: false }).start();
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 1200);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toastMsg, toastCounter]);

  // The scrim owes nothing to layout, so it starts on the tap rather than
  // waiting behind the panel's measuring pass.
  useEffect(() => {
    if (routeOpenDrop === null) return;
    routeScrimAnim.setValue(0);
    Animated.timing(routeScrimAnim, {
      toValue: 1, duration: SCRIM_IN_MS,
      easing: EASE_OUT, useNativeDriver: true,
    }).start();
  }, [routeOpenDrop]);

  // Waits for the measurement, so the panel enters already on the correct side.
  // Depends on the boolean rather than the height itself: a re-layout that
  // happens to change the height must not replay the entrance.
  useEffect(() => {
    if (routeOpenDrop === null || !routePanelMeasured) return;
    routePanelAnim.setValue(0);
    Animated.timing(routePanelAnim, {
      toValue: 1, duration: PANEL_IN_MS,
      easing: EASE_OUT, useNativeDriver: true,
    }).start();
  }, [routeOpenDrop, routePanelMeasured]);

  useEffect(() => {
    if (!routeCalOpen) return;
    routeCalAnim.setValue(0);
    routeCalScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(routeCalScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(routeCalAnim, {
        toValue: 1, duration: CAL_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [routeCalOpen]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastCounter(c => c + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const d = localDayKey(t);
      if (d !== dayRef.current) {
        dayRef.current = d;
        getSavedFlights(email).then(list => { if (!cancelled) setSavedFlights(list); });
      }
    };
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        tick();
        if (Date.now() - lastAutoRefreshRef.current > AUTO_REFRESH_RESUME_COOLDOWN_MS) {
          getSavedFlights(email).then(l => { if (!cancelled) autoRefresh(l, () => cancelled); });
        }
      }
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      sub.remove();
    };
  }, [email]);

  const shake = () => {
    Animated.sequence([
      Animated.timing(errorShake, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const showResult = () => {
    resultOpacity.setValue(0);
    resultTranslate.setValue(30);
    Animated.parallel([
      Animated.timing(resultOpacity, {
        toValue: 1, duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(resultTranslate, {
        toValue: 0, tension: 80, friction: 10,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const renderSavedFlight = (saved: SavedFlight) => {
    setError("");
    setSaveError("");
    setChatResponse(null);
    setRouteResult(null);
    setFlightRecord(saved);
    const savedStatus = displayStatus(saved.status.toLowerCase(), saved.from.delay);
    const depCell = movementTimeCell(
      clock24(saved.from.actualIso, saved.from.actual),
      clock24(saved.from.estimatedIso, saved.from.estimated),
      saved.from.actualSource, saved.from.estimatedSource, true);
    const arrCell = movementTimeCell(
      clock24(saved.to.actualIso, saved.to.actual),
      clock24(saved.to.estimatedIso, saved.to.estimated),
      saved.to.actualSource, saved.to.estimatedSource, false);
    const savedDelay = delayCell(saved.from.delay);
    setFlight({
      flight: saved.flightNumber,
      airline: saved.airline,
      status: savedStatus.toUpperCase(),
      statusColor: getStatusColor(savedStatus),
      statusBg: getStatusBg(savedStatus),
      from: saved.from.iata,
      fromFull: airportFullLabel(saved.from.shortName, saved.from.city, saved.from.airport),
      // Records saved before v5 carry city: null and fall back until refreshed.
      fromCity: saved.from.city || saved.from.airport,
      to: saved.to.iata,
      toFull: airportFullLabel(saved.to.shortName, saved.to.city, saved.to.airport),
      toCity: saved.to.city || saved.to.airport,
      dep: saved.from.scheduled || "N/A",
      arr: saved.to.scheduled || "N/A",
      depIso: saved.from.scheduledIso,
      arrIso: saved.to.scheduledIso,
      depTimeLabel: depCell.label,
      depTimeValue: depCell.value,
      arrTimeLabel: arrCell.label,
      arrTimeValue: arrCell.value,
      duration: scheduledDuration(saved.from.scheduledIso, saved.from.timezone, saved.to.scheduledIso, saved.to.timezone),
      terminal: saved.from.terminal || "N/A",
      gate: saved.from.gate || "N/A",
      checkinDesk: saved.from.checkinDesk ?? null,
      aircraft: saved.aircraftModel ?? null,
      registration: saved.aircraftRegistration ?? null,
      baggage: saved.to.baggage ?? "N/A",
      delayLabel: savedDelay.label,
      delayValue: savedDelay.value,
      date: saved.flightDate === 'unknown' ? "N/A" : saved.flightDate,
    });
    setLastUpdated(saved.updatedAt);
    showResult();
  };

  // `date` is the LOCAL DEPARTURE date of the instance wanted, or null for the
  // nearest one — which is what every caller meant before this existed, so an
  // omitted argument preserves today's behaviour exactly.
  const runFlightLookup = async (
    flightNumber: string,
    keepVisible = false,
    date: string | null = null,
  ): Promise<boolean> => {
    setError("");
    setSaveError("");
    if (!keepVisible) {
      setFlight(null);
      setChatResponse(null);
      setFlightRecord(null);
    }
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE}/flight/${flightNumber}${date === null ? '' : `?date=${date}`}`,
      );
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return false;
      }

      setFlight(flightDataFromApi(data));

      const record = savedFlightFromApi(data);
      setFlightRecord(record);
      const refreshed = await touchSavedFlight(email, record);
      if (refreshed) setSavedFlights(refreshed);

      setLastUpdated(Date.now());
      if (!keepVisible) showResult();
      return true;
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
      return false;
    } finally {
      setLoading(false);
    }
  };

  const runRouteLookup = async (origin: string, destination: string, day: string | null) => {
    setError("");
    setSaveError("");
    // The three result kinds are mutually exclusive; a route answer replaces
    // whatever was on screen.
    setFlight(null);
    setChatResponse(null);
    setFlightRecord(null);
    setRouteResult(null);
    setLoading(true);
    try {
      // The date is omitted entirely for Today, not sent empty: the backend
      // treats absent and empty alike, but omitting keeps the URL identical to
      // what it has always been.
      const query = day === null
        ? `hours=${ROUTE_TODAY_HOURS}`
        : `hours=${ROUTE_TODAY_HOURS}&date=${day}`;
      const response = await fetch(`${API_BASE}/route/${origin}/${destination}?${query}`);
      const data = await response.json();

      // The envelope always carries an `error` key; non-null means failure.
      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      }

      // Airline exclusions are keyed to one result set; a different route has a
      // different carrier list, so carrying them over would silently hide rows.
      setRouteAirlinesOff([]);
      setRouteResult(data as RouteResult);
      showResult();
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
    } finally {
      setLoading(false);
    }
  };

  // Bookmark on a route row: look the flight up, then save it, without the card
  // ever appearing. It deliberately does NOT reuse runFlightLookup, which sets
  // `flight` and calls showResult() — that would unmount the route list and flash
  // the card open and shut. Same endpoint, same DTO mapping, no card.
  //
  // Costs 2 units per distinct flight. The backend caches a successful lookup for
  // five minutes, so re-tapping the same number inside that window is free.
  const saveFromRoute = async (flightNumber: string, date: string | null) => {
    if (routeSavingKey !== null) return;      // one at a time; the UI also disables the rest
    setRouteSavingKey(flightNumber);
    setError("");
    try {
      // Same date the row was rendered from. Without it this stored TODAY's
      // instance of the flight under a row the user picked off a future board —
      // and unlike the card, that one persists.
      const response = await fetch(
        `${API_BASE}/flight/${flightNumber}${date === null ? '' : `?date=${date}`}`,
      );
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      }

      const result = await saveFlight(email, savedFlightFromApi(data));
      setSavedFlights(result.flights);
      if (!result.ok) {
        setError('saved flight limit reached \u2014 unsave one first');
        setErrorCounter(c => c + 1);
        shake();
        return;
      }
      showToast('saved');
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
    } finally {
      setRouteSavingKey(null);
    }
  };

  const handleSearch = async () => {
    const cleaned = query.trim().toUpperCase().replace(/\s/g, "");
    setError("");
    setFlight(null);
    setChatResponse(null);
    setRouteResult(null);
    setFlightRecord(null);
    setSaveError("");

    if (!cleaned) {
      setError("enter a flight number or ask a question");
      setErrorCounter(c => c + 1);
      shake();
      return;
    }

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.95, duration: 80, useNativeDriver: true }),
      Animated.spring(btnScale, { toValue: 1, tension: 200, friction: 8, useNativeDriver: true }),
    ]).start();

    if (FLIGHT_REGEX.test(cleaned)) {
      await runFlightLookup(cleaned);
      return;
    }

    // Route-shaped input is answered from the departure board and must never
    // reach /chat — keeping it off the LLM is the point of the feature.
    //
    // routeCandidate, not a fresh parse: the affordance under the command line
    // reads the same value from the same render, so what the user was shown and
    // what Execute does cannot disagree.
    if (routeCandidate !== null && routeCandidate.kind === 'error') {
      // Nothing is spent here — not a board fetch, and not an LLM call.
      setError(routeCandidate.message);
      setErrorCounter(c => c + 1);
      shake();
      return;
    }
    if (routeCandidate !== null) {
      setRoutePick({ from: routeCandidate.from.options, to: routeCandidate.to.options });
      await runRouteLookup(
        routeCandidate.from.airport.iata, routeCandidate.to.airport.iata, routeDate);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query, gmail_token: gmailToken }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      }

      setChatResponse(data.response);
      if (data.flight) {
        setFlight(flightDataFromApi(data.flight));
        const record = savedFlightFromApi(data.flight);
        setFlightRecord(record);
        const refreshed = await touchSavedFlight(email, record);
        if (refreshed) setSavedFlights(refreshed);
        setLastUpdated(Date.now());
      }
      showResult();
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
    } finally {
      setLoading(false);
    }
  };

  // Shared fetch-and-store loop. Sequential; per-flight try/catch; touchSavedFlight on
  // success; captures the open card's fresh data. Returns counts only — no UI side effects.
  const refreshFlights = async (list: SavedFlight[], maxAttempts: number): Promise<{ failures: number; openCardFresh: any }> => {
    const openCardNumber = flightRecord?.flightNumber ?? null;
    let openCardFresh: any = null;
    let failures = 0;
    let attempts = 0;

    for (const f of list) {                                   // sequential — never parallel
      if (attempts >= maxAttempts) break;
      // Between attempts only — never before the first, never after the last, so
      // a single saved flight waits no longer than it does today.
      if (attempts > 0) await new Promise(resolve => setTimeout(resolve, REFRESH_SPACING_MS));
      attempts++;
      try {
        const response = await fetch(`${API_BASE}/flight/${f.flightNumber}`);
        const data = await response.json();
        if (data.error || !response.ok) { failures++; continue; }
        await touchSavedFlight(email, savedFlightFromApi(data));
        if (openCardNumber && f.flightNumber === openCardNumber) openCardFresh = data;
      } catch {
        failures++;                                           // one failure must not abort the loop
      }
    }
    return { failures, openCardFresh };
  };

  // Silent background refresh: no spinner, no message. Failures are invisible — the row age tells the truth.
  const autoRefresh = async (list: SavedFlight[], isCancelled: () => boolean) => {
    if (refreshingRef.current) return;
    const stale = list.filter(f => Date.now() - f.updatedAt > AUTO_REFRESH_MIN_AGE_MS);
    if (stale.length === 0) return;
    refreshingRef.current = true;
    try {
      await refreshFlights(stale, AUTO_REFRESH_MAX_FLIGHTS);
      const fresh = await getSavedFlights(email);             // re-read once, set state once
      if (isCancelled()) return;                              // account switched / unmounted mid-flight
      setSavedFlights(fresh);
      lastAutoRefreshRef.current = Date.now();
    } finally {
      refreshingRef.current = false;
    }
  };

  const onRefresh = async () => {
    if (refreshingRef.current) return;                        // synchronous guard; iOS can double-fire the pull
    setGreetingIndex(Math.floor(Math.random() * 60));         // past the double-fire guard, above the cooldown: a throttled pull still rerolls
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshMsg("");
    try {
      if (savedFlights.length === 0) return;                  // spinner alone acknowledges; message can't render here

      if (Date.now() - lastRefreshRef.current < PULL_COOLDOWN_MS) {
        setRefreshMsg('> already up to date');
        setRefreshTone('info');
        setRefreshMsgCounter(c => c + 1);
        return;
      }
      lastRefreshRef.current = Date.now();

      const { failures, openCardFresh } = await refreshFlights(savedFlights, 5);

      const list = await getSavedFlights(email);              // read once, set state once
      setSavedFlights(list);

      if (openCardFresh) {
        const openCardNumber = flightRecord?.flightNumber ?? null;
        setFlight(flightDataFromApi(openCardFresh));
        const stored = list.find(f => f.flightNumber === openCardNumber);
        if (stored) setFlightRecord(stored);                  // from disk, so savedAt stays in sync
        setLastUpdated(Date.now());
      }

      if (failures > 0) {
        setRefreshMsg(`> ${failures} ${failures === 1 ? 'flight' : 'flights'} could not be updated`);
        setRefreshTone('error');
        setRefreshMsgCounter(c => c + 1);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  // Everything on screen reads this; `username` stays exactly as sign-in derived it.
  const effectiveName = displayName ?? username;

  // Derived per render from a copy; savedFlights itself is never reordered.
  const sortedSaved = sortSavedByRelevance(savedFlights);

  // Resolved from the bundled dataset. This used to read the saved flights on
  // the device, which meant a fresh install never saw an airport name at all —
  // and it could not tell a real code from a typo, because a code it had not
  // seen and a code that does not exist looked identical to it.
  //
  // Parsed once per distinct query and cached: the parser scans the dataset,
  // and this runs on every keystroke.
  const routeParseCache = useRef<{ q: string; v: RouteParse }>({ q: '\u0000', v: null });
  if (routeParseCache.current.q !== query) {
    routeParseCache.current = { q: query, v: parseRouteQuery(query) };
  }
  const routeCandidate = routeParseCache.current.v;
  // Only a resolved pair shows. An error state says its piece through the error
  // channel on Execute, not under the command line while the user is still
  // typing towards something valid.
  const routeAffordance = routeCandidate !== null && routeCandidate.kind === 'ok'
    ? routeCandidate
    : null;

  // The ROUTE payload's *_iso fields carry a TRUE UTC offset, so Date.parse
  // reads them correctly. That is NOT true of the *_iso fields on the flight DTO
  // path: those carry a bogus +00:00 over local wall-clock digits and must go
  // through zonedIsoToTs. The two paths deliberately do not share a helper for
  // turning an ISO into an INSTANT, because one correct-looking swap would
  // silently shift every value. clock24 is not an exception to that: it reads
  // the digits as text and never computes an instant at all, which is exactly
  // why one of it can serve both paths. Everything below parses through this
  // one function.
  const routeTs = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  };

  // The heading's words. Read back from the dataset rather than carried in
  // state, so a re-run from the date control or the picker cannot leave a stale
  // name above a fresh list. Falls back to the bare code, which is all the
  // heading has ever shown.
  const routeHeadFrom = routeResult === null
    ? '' : airportByCode(routeResult.origin)?.city ?? routeResult.origin;
  const routeHeadTo = routeResult === null
    ? '' : airportByCode(routeResult.destination)?.city ?? routeResult.destination;

  const routeDepartureTs = (r: RouteFlight): number => routeTs(r.departure_scheduled_iso) ?? NO_TIME;
  const routeArrivalTs = (r: RouteFlight): number => routeTs(r.arrival_scheduled_iso) ?? NO_TIME;

  // Null whenever either end is missing or the pair is nonsensical, so the row
  // simply renders no duration rather than a placeholder.
  const routeDurationMs = (r: RouteFlight): number | null => {
    const dep = routeTs(r.departure_scheduled_iso);
    const arr = routeTs(r.arrival_scheduled_iso);
    if (dep === null || arr === null || arr <= dep) return null;
    return arr - dep;
  };

  // The hour as it reads AT THE AIRPORT, taken from the wall-clock digits.
  // new Date(iso).getHours() would report the device's zone instead, which puts
  // a Bengaluru breakfast flight in the evening band for a user in London.
  const routeHourOf = (iso: string | null): number | null => {
    const m = /T(\d{2}):/.exec(iso ?? '');
    return m ? Number(m[1]) : null;
  };

  const routeDepBand = (r: RouteFlight): RouteBand | null => {
    const h = routeHourOf(r.departure_scheduled_iso);
    return h === null ? null : bandForHour(h);
  };

  const routeArrBand = (r: RouteFlight): RouteBand | null => {
    const h = routeHourOf(r.arrival_scheduled_iso);
    return h === null ? null : bandForHour(h);
  };

  // Unmapped carriers group under their two-letter prefix rather than being left
  // out of the filter. Excluding them would make those rows unfilterable, and
  // would let "turn every airline off" still leave flights on screen.
  const routeAirlineKey = (r: RouteFlight): string => {
    const name = airlineFromFlightNumber(r.flight_number);
    if (name !== null) return name;
    const m = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])/.exec(r.flight_number);
    return m ? m[1] : r.flight_number;
  };

  // Rows the backend named but could not code, resolved here — where the
  // airport dataset lives — and kept only when the name resolves to the
  // destination that was actually searched for. The code is filled in from the
  // resolution, so from this point on a recovered row is indistinguishable from
  // a matched one and every consumer below needs no special case.
  //
  // A name that resolves to nothing, or to somewhere else, is dropped: there
  // would be no honest way to show it in a list of flights to one destination.
  const routeRecovered: RouteFlight[] = routeResult === null
    ? []
    : (routeResult.unresolved ?? []).flatMap(r => {
      const hit = routeResolveDestination(r.destination_airport);
      return hit !== null && hit.iata === routeResult.destination
        ? [{ ...r, destination_iata: hit.iata }]
        : [];
    });

  // THE row set. Everything below counts, filters, sorts and groups this, so a
  // recovered row is counted exactly once, in exactly one group, like any other.
  const routeRows: RouteFlight[] = routeResult === null
    ? []
    : [...routeResult.flights, ...routeRecovered];

  // What the envelope's own totals become once recoveries are included. The
  // backend's count and total_found describe `flights` alone, by design.
  const routeShown = routeRows.length;
  const routeFound = routeResult === null
    ? 0
    : routeResult.total_found + routeRecovered.length;

  // Only carriers actually present in this result set.
  const routeAirlineOptions = routeResult
    ? Array.from(new Set(routeRows.map(routeAirlineKey))).sort()
    : [];

  const routeRowKey = (r: RouteFlight) => `${r.flight_number}-${r.departure_scheduled_iso ?? ''}`;

  // Missing values resolve to NO_TIME in every mode, so unparseable rows sort
  // last whichever key is active.
  const routeSortKey = (r: RouteFlight): number =>
    routeSort === 'arrival' ? routeArrivalTs(r)
      : routeSort === 'duration' ? (routeDurationMs(r) ?? NO_TIME)
        : routeDepartureTs(r);

  // One predicate for both the real filter and the option counts, so a count can
  // never disagree with what enabling the option actually produces. `skip` names
  // the dimension to ignore.
  //
  // A row whose band cannot be determined is never hidden by that filter: the
  // app has no grounds to place it in a band, and hiding data it cannot classify
  // is worse than showing it.
  const routePasses = (r: RouteFlight, skip: 'dep' | 'arr' | 'air' | null) => {
    if (skip !== 'dep') {
      const b = routeDepBand(r);
      if (b !== null && !routeDepBands[b]) return false;
    }
    if (skip !== 'arr') {
      const b = routeArrBand(r);
      if (b !== null && !routeArrBands[b]) return false;
    }
    if (skip !== 'air' && routeAirlinesOff.includes(routeAirlineKey(r))) return false;
    return true;
  };

  const routeVisible = routeResult
    ? routeRows.filter(r => routePasses(r, null))
    : [];

  // Counted with the OTHER filters applied but not this one, so the number says
  // what enabling the option would give you — and does not collapse to zero the
  // moment you switch the option off.
  const routeCountBy = (skip: 'dep' | 'arr' | 'air', keyOf: (r: RouteFlight) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of routeRows) {
      if (!routePasses(r, skip)) continue;
      const k = keyOf(r);
      if (k !== null) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const routeDepCounts = routeCountBy('dep', routeDepBand);
  const routeArrCounts = routeCountBy('arr', routeArrBand);
  const routeAirCounts = routeCountBy('air', routeAirlineKey);

  const routeSorted = [...routeVisible].sort((a, b) => routeSortKey(a) - routeSortKey(b));
  const routeHiddenCount = routeRows.length - routeVisible.length;

  // Computed over the FILTERED set, so the marker always describes what is
  // currently on screen. Null when fewer than two rows are timed — one row has
  // nothing to be faster than — or when every duration is identical, where
  // "fastest" would describe the whole list and so describe nothing.
  //
  // A TIE no longer suppresses it. Ties are ordinary: five rows share 170m on a
  // typical BLR-DEL board, and a tie on the minimum used to blank the marker
  // outright — measured at 24% of two-row and 16% of three-row filtered subsets.
  // Rows sharing the shortest time are genuinely the best available, so every
  // one of them keeps its in-row tag and the first in the CURRENT sort order
  // takes the pin. `timed` is built from routeSorted, so "first" means first as
  // rendered, and the pin cannot jump between renders.
  const routeFastest = (() => {
    const timed = routeSorted
      .map(r => ({ key: routeRowKey(r), ms: routeDurationMs(r) }))
      .filter((v): v is { key: string; ms: number } => v.ms !== null);
    if (timed.length < 2) return null;
    const min = Math.min(...timed.map(v => v.ms));
    if (min === Math.max(...timed.map(v => v.ms))) return null;
    const keys = timed.filter(v => v.ms === min).map(v => v.key);
    return { keys: new Set(keys), pin: keys[0] };
  })();

  // Every row achieving the shortest time carries the tag; exactly one of them
  // is lifted into the pin.
  const routeFastestKeys = routeFastest?.keys ?? new Set<string>();
  const routeFastestKey = routeFastest?.pin ?? null;

  // Lifted OUT of the list and pinned above it, so it appears exactly once
  // rather than twice. Never under a duration sort: it is already the first row
  // there, and pinning would buy a heading and a duplicate.
  const routePinned = routeSort !== 'duration' && routeFastestKey !== null
    ? routeSorted.find(r => routeRowKey(r) === routeFastestKey) ?? null
    : null;

  // Everything the list below renders. The groups and their counts both derive
  // from this, so a heading can never claim a row that was lifted out.
  const routeListed = routePinned === null
    ? routeSorted
    : routeSorted.filter(r => routeRowKey(r) !== routeFastestKey);

  // Grouping is meaningful only under a departure sort; under arrival or
  // duration the headings would describe an order the list is not in.
  //
  // Ordered by FIRST APPEARANCE in the sorted list, not by ROUTE_BANDS. Fixed
  // band order was a real defect: the rolling twelve-hour window starts before
  // midnight for much of the day, which puts the 23:xx departures in
  // "18:00-00:00" — last in ROUTE_BANDS — so the chronologically FIRST flights
  // rendered after the very last one. A Map preserves insertion order, so the
  // headings now run in the same direction as the rows beneath them.
  const routeGroups = routeSort === 'departure'
    ? (() => {
        const byBand = new Map<RouteBand, RouteFlight[]>();
        for (const r of routeListed) {
          const b = routeDepBand(r);
          if (b === null) continue;
          const g = byBand.get(b);
          if (g) g.push(r); else byBand.set(b, [r]);
        }
        return Array.from(byBand, ([part, rows]) => ({ part, rows }));
      })()
    : [];

  // A row with no DEPARTURE time has no band to sit in and nothing to order by,
  // so it trails the groups. Only a missing departure reaches this: the
  // departure sort and the departure banding both read departure_scheduled_iso
  // and nothing else, so a missing arrival or duration cannot move a row here.
  const routeUngrouped = routeSort === 'departure'
    ? routeListed.filter(r => routeDepBand(r) === null)
    : [];

  // Flat rows, not cards. Line one carries everything variable-width; line two
  // carries the two times and the connector between them, and nothing else may
  // join it. The times are sized to their own content and pinned to opposite
  // edges of the row, so departures start at the same x and arrivals end at the
  // same x while the connector absorbs every point of slack.
  // `pinned` only suppresses the in-row "fastest" tag, because the heading
  // directly above the pinned row already says the word. Same component, same
  // layout, one boolean — there is no second row renderer.
  const routeRow = (r: RouteFlight, pinned = false) => {
    const ms = routeDurationMs(r);
    const origin = routeResult?.origin ?? '';
    // The APPLIED date, never routeDate: that can hold a selection the list has
    // not been re-fetched for, which would open a card for a day the row on
    // screen is not from. Null for an undated board, which is today.
    const rowDate = routeResult?.date ?? null;
    const airline = airlineFromFlightNumber(r.flight_number);
    const saved = savedFlights.some(f => f.id === makeFlightId(r.flight_number));
    const pending = routeSavingKey === r.flight_number;
    const busy = routeSavingKey !== null;
    const showStatus = r.status !== ROUTE_STATUS_ROUTINE;
    return (
      <TouchableOpacity
        key={routeRowKey(r)}
        style={s.routeFlatRow}
        activeOpacity={0.7}
        onPress={() => runFlightLookup(r.flight_number, false, rowDate)}
      >
        <View style={s.routeFlatBody}>
          {/* Identity and flags. Everything variable-width lives on this line so
              the times below keep the whole row to flex into; the airline is the
              only cell allowed to shrink, and may be absent entirely. */}
          <View style={s.routeFlatHead}>
            <View style={s.routeFlatIdent}>
              {airline !== null && (
                <Text style={s.routeFlatAirline} numberOfLines={1}>{airline}</Text>
              )}
              <Text style={s.routeFlatNumber} numberOfLines={1}>{r.flight_number}</Text>
            </View>
            <View style={s.routeFlatTags}>
              {/* No "Direct" label: it printed identically on every row, and the
                  note under the heading already says the whole list is direct.
                  It earns a place here only once connections can appear. */}
              {!pinned && routeFastestKeys.has(routeRowKey(r)) && (
                <Text style={s.routeFastest}>{'fastest'}</Text>
              )}
              {showStatus && (
                <Text style={[s.routeFlatStatus, { color: getStatusColor(r.status) }]} numberOfLines={1}>
                  {r.status}
                </Text>
              )}
            </View>
          </View>

          {/* Both cells are the same fixed width, because every 24-hour time is
              exactly five characters. The connector is the only flexed element
              between them, so the gap either side of it is equal by construction
              rather than by tuning. */}
          <View style={s.routeFlatTop}>
            <Text style={s.routeFlatTime} numberOfLines={1}>
              {clock24(r.departure_scheduled_iso, r.departure_scheduled)}
            </Text>
            <View style={s.routeConn}>
              {ms !== null && (
                <Text style={s.routeConnDur} numberOfLines={1}>{formatCountdown(ms)}</Text>
              )}
              <View style={s.routeConnLineRow}>
                <View style={s.routeConnLine} />
                <View style={s.routeConnHead} />
              </View>
            </View>
            {/* The iso is still preferred; the fallback is the only thing that
                changes. A row with neither value gets the dash, which occupies
                the same 60pt cell a time does, so the arrival still ends on the
                row's right edge and the connector's share is unchanged. */}
            <Text style={[s.routeFlatTime, s.routeFlatTimeEnd]} numberOfLines={1}>
              {clock24(
                r.arrival_scheduled_iso,
                r.arrival_scheduled === null ? ROUTE_NO_TIME : stripZoneLabel(r.arrival_scheduled),
              )}
            </Text>
          </View>

          {/* Its own row, repeating routeFlatTop's geometry exactly, so each code
              sits under its own time. Putting them INSIDE routeFlatTop would have
              grown the box the connector centres itself in, dragging the line
              below the times it belongs to. */}
          <View style={s.routeFlatCodes}>
            <Text style={s.routeFlatCode} numberOfLines={1}>{origin}</Text>
            <View style={s.routeConnSpacer} />
            <Text style={[s.routeFlatCode, s.routeFlatCodeEnd]} numberOfLines={1}>
              {/* Never null in practice — a recovered row carries the code its
                  name resolved to — but the wire type allows it, and the answer
                  is knowable anyway: every row here is for this destination. */}
              {r.destination_iata ?? routeResult?.destination ?? ''}
            </Text>
          </View>
        </View>

        {/* Nested Touchable: React Native gives the responder to the deepest view
            that claims it, so this never triggers the row's own onPress. */}
        <TouchableOpacity
          style={s.routeFlatMark}
          activeOpacity={0.7}
          disabled={saved || busy}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={() => saveFromRoute(r.flight_number, rowDate)}
        >
          <View style={s.routeFlatMarkBox}>
            {pending ? (
              <ActivityIndicator size="small" color="rgba(226,226,226,0.5)" />
            ) : (
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path
                  d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"
                  fill={saved ? '#4ade80' : 'none'}
                  stroke={saved
                    ? '#4ade80'
                    : busy ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.5)'}
                  strokeWidth={1.75}
                />
              </Svg>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  // Which filters are actually narrowing the list, for the all-hidden message.
  const routeActiveFilters = [
    ROUTE_BANDS.every(b => routeDepBands[b]) ? null : 'departure time',
    ROUTE_BANDS.every(b => routeArrBands[b]) ? null : 'arrival time',
    routeAirlinesOff.length === 0 ? null : 'airline',
  ].filter((v): v is string => v !== null);

  // Everything-on for the filters, and sort back to its default.
  const routeFiltersDirty =
    !ROUTE_BANDS.every(b => routeDepBands[b])
    || !ROUTE_BANDS.every(b => routeArrBands[b])
    || routeAirlinesOff.length > 0;
  // Characters available inside the picker pill, which shares its row with the
  // "from"/"to" caption. One number for both pills, sized on the wider caption,
  // so the two can never disagree about how much of a name fits.
  const routeEndCharBudget = () => Math.floor(
    (routeWinWidth - 2 * ROUTE_SCROLL_PAD - ROUTE_END_SIDE_WIDTH - ROUTE_PILL_CHROME)
    / ROUTE_MONO_ADVANCE,
  );

  // Characters available inside ONE pill of a row of n, at the width the app is
  // actually running at. Every pill in the row gets the same, because every pill
  // is the same width.
  const routePillCharBudget = (pills: number) => Math.floor(
    ((routeWinWidth - 2 * ROUTE_SCROLL_PAD - (pills - 1) * ROUTE_PILL_GAP) / pills
      - ROUTE_PILL_CHROME) / ROUTE_MONO_ADVANCE,
  );

  // Which single name stands in for the rest. SHORTEST wins, but a single-word
  // name beats a multi-word one before length is even considered: "IndiGo +2"
  // reads as a name with a remainder, where "Air India +2" reads as a phrase cut
  // in half — and it is longer besides. Ties break alphabetically, so the choice
  // never depends on the order the provider happened to return them in.
  //
  // Bands are all eleven characters and none contains a space, so for those it
  // reduces to the alphabetical tie-break, which for "HH:MM-HH:MM" is also
  // chronological: the earliest band is the one that stands for the others.
  const routePickName = (names: string[]): string =>
    [...names].sort((a, b) =>
      Number(a.includes(' ')) - Number(b.includes(' '))
      || a.length - b.length
      || a.localeCompare(b))[0];

  // Every form a selection pill could take, LONGEST FIRST. The last entry is the
  // floor — what the pill falls back to when nothing else fits — and it is the
  // floors, not the individual labels, that guarantee a row never wraps.
  //
  //   1. everything on   -> the noun                    "Airline"
  //   2. the names       -> comma separated             "Air India, IndiGo"
  //   3. one name + rest -> routePickName picks it      "IndiGo +1"
  //   4. count of total  ->                              "Air 2/5"
  //   5. bare count      ->                              "Air 2"
  //
  // A name says more than a number, so the names come first and the count is
  // what they degrade to, never the reverse. The noun keeps its abbreviation
  // behind it as a floor, so even a screen narrower than 320 shortens rather
  // than truncating.
  const routeSelChoices = (
    noun: string,
    abbrev: string,
    on: string[],
    total: number,
  ): string[] => {
    if (on.length === total) return [noun, abbrev];
    const out: string[] = [];
    if (on.length > 0) out.push(on.join(', '));
    if (on.length > 1) out.push(`${routePickName(on)} +${on.length - 1}`);
    out.push(`${abbrev} ${on.length}/${total}`);
    out.push(`${abbrev} ${on.length}`);
    return out;
  };

  // Each pill independently takes the longest form that fits ITS width. No
  // allocation: a stretched pill's width comes from the layout, not from what
  // its neighbours happen to be rendering, so there is no shared pot to divide.
  //
  // Falling back rather than truncating is the whole point of the chain — the
  // last rung is reached only if nothing above it fits, and the chains are built
  // so their last rung always does.
  const routeFitRow = (choices: string[][]): string[] => {
    const cap = routePillCharBudget(choices.length);
    return choices.map(c => c.find(l => l.length <= cap) ?? c[c.length - 1]);
  };

  const routeAirOn = routeAirlineOptions.filter(a => !routeAirlinesOff.includes(a));

  // Row one. Each takes its long form when its own third can hold it:
  // "Sat 29 Aug" over "29 Aug", "Filters (2)" over "Filters 2", "arrival time"
  // over "arrival". At 320pt a third is nine characters, so these three land on
  // their shorter forms; from about 400pt the longer ones start to fit.
  const routeRowOne = routeFitRow(
    routeResult !== null && routeShown > 0
      ? [
        routeDate === null ? ['Today'] : [routeDateLabel(routeDate), routeShortDate(routeDate)],
        routeActiveFilters.length === 0
          ? ['Filters']
          : [`Filters (${routeActiveFilters.length})`, `Filters ${routeActiveFilters.length}`],
        routeSort === ROUTE_SORT_DEFAULT
          ? [ROUTE_SORT_PILL.departure]
          : [ROUTE_SORT_LABELS[routeSort], ROUTE_SORT_PILL[routeSort]],
      ]
      // An empty board renders the date alone, so it is budgeted alone.
      : [routeDate === null ? ['Today'] : [routeDateLabel(routeDate), routeShortDate(routeDate)]],
  );
  const routeDatePill = routeRowOne[0];
  const routeFiltersPill = routeRowOne[1];
  const routeSortPill = routeRowOne[2];

  // Row two. A band is eleven characters and a third of a 320pt row is nine, so
  // these two settle on "Dep 2/4" there; a single band fits from about 380pt and
  // a name-plus-remainder from around 350pt.
  const routeRowTwo = routeFitRow([
    routeSelChoices('Airline', 'Air', routeAirOn, routeAirlineOptions.length),
    routeSelChoices('Departure', 'Dep', ROUTE_BANDS.filter(b => routeDepBands[b]), ROUTE_BANDS.length),
    routeSelChoices('Arrival', 'Arr', ROUTE_BANDS.filter(b => routeArrBands[b]), ROUTE_BANDS.length),
  ]);
  const routeAirPill = routeRowTwo[0];
  const routeDepPill = routeRowTwo[1];
  const routeArrPill = routeRowTwo[2];

  const routeControlsDirty =
    routeFiltersDirty || routeSort !== ROUTE_SORT_DEFAULT || routeDate !== null;

  // Clears the view controls AND the date. The view half is free; the date half
  // is not, because a dated list has to be re-fetched for today to match the
  // control that now says Today.
  //
  // Tested on routeResult.date, not routeDate: it is the list on screen that
  // decides whether a fetch is owed. Already-today costs nothing, and a search
  // in flight is left alone.
  const routeResetControls = () => {
    setRouteDepBands(ALL_BANDS_ON);
    setRouteArrBands(ALL_BANDS_ON);
    setRouteAirlinesOff([]);
    setRouteSort(ROUTE_SORT_DEFAULT);
    setRouteDate(null);
    closeRouteDrop();
    if (loading) return;
    if (routeResult === null || routeResult.date === null) return;
    runRouteLookup(routeResult.origin, routeResult.destination, null);
  };

  // ── Calendar ──────────────────────────────────────────────────────────
  // Whole days between today and a given date, on the DEVICE's calendar. The
  // backend bounds against its own UTC date and carries a day of slack either
  // side, so a boundary disagreement cannot lock a legitimate date out.
  const routeDayOffset = (y: number, m: number, d: number) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m, d).getTime() - today.getTime()) / 86400000);
  };

  // Leading blanks so the 1st lands under its weekday, then the days, padded to
  // whole weeks of seven.
  const routeCalWeeks = (() => {
    const { y, m } = routeCalMonth;
    const lead = new Date(y, m, 1).getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  })();

  // Navigation stops where the selectable range does, so the grid never shows a
  // month in which nothing can be picked.
  const routeCalCanGoBack = routeDayOffset(routeCalMonth.y, routeCalMonth.m, 1) > 0;
  const routeCalCanGoNext =
    routeDayOffset(routeCalMonth.y, routeCalMonth.m + 1, 1) <= ROUTE_MAX_DATE_DAYS;

  const shiftRouteCal = (delta: number) => {
    setRouteCalMonth(prev => {
      const d = new Date(prev.y, prev.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const openRouteCal = () => {
    const base = routeDate === null ? new Date() : new Date(`${routeDate}T00:00:00`);
    setRouteCalMonth({ y: base.getFullYear(), m: base.getMonth() });
    setRouteCalOpen(true);
  };

  // Unmounts only once BOTH layers have left, so the Modal never snaps away
  // from under a scrim still on screen.
  const closeRouteCal = () => {
    Animated.parallel([
      Animated.timing(routeCalAnim, {
        toValue: 0, duration: CAL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(routeCalScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setRouteCalOpen(false));
  };

  // Picking a date now RUNS the search. It was a two-step selection before, and
  // the second step was invisible: the list simply stayed on the old day until
  // Execute happened to be pressed. Today stays null, so that request carries no
  // date parameter and costs the usual 2 units; any other day costs 4.
  //
  // Compared against routeResult.date, not routeDate: re-picking the day already
  // on screen must not spend anything, while a day that only LOOKS selected —
  // set but never searched — still has to fire.
  const pickRouteCalDay = (iso: string, isToday: boolean) => {
    const next = isToday ? null : iso;
    setRouteDate(next);
    closeRouteCal();
    if (loading) return;
    if (routeResult === null || next === routeResult.date) return;
    runRouteLookup(routeResult.origin, routeResult.destination, next);
  };

  // ── Anchored panels ───────────────────────────────────────────────────
  const routeAnchorRefs = useRef<Record<string, View | null>>({});

  const closeRouteDrop = () => {
    Animated.parallel([
      Animated.timing(routePanelAnim, {
        toValue: 0, duration: PANEL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(routeScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setRouteOpenDrop(null));
  };

  const openRouteDrop = (id: 'sort' | 'dep' | 'arr' | 'air' | 'orig' | 'dest') => {
    const node = routeAnchorRefs.current[id];
    if (!node) return;
    node.measureInWindow((wx, wy, width, height) => {
      const win = Dimensions.get('window');
      const below = wy + height + ROUTE_PANEL_GAP;
      const above = win.height - wy + ROUTE_PANEL_GAP;
      setRouteAnchor({
        // Verbatim, unclamped. routePanelLeft decides the placement once the
        // panel has reported how wide it actually is.
        x: wx,
        width,
        // Carried rather than read again at render time, so the placement and
        // the measurement can never disagree across a rotation.
        screen: win.width,
        top: below,
        bottom: above,
        spaceBelow: win.height - below - ROUTE_PANEL_EDGE,
        spaceAbove: win.height - above - ROUTE_PANEL_EDGE,
      });
      // Forces a fresh measurement: the previous panel's size says nothing
      // about this one's.
      setRoutePanelSize(null);
      setRouteOpenDrop(id);
    });
  };

  // Downward by default, because that reads as the control opening. It flips
  // only when the panel genuinely does not fit below AND there is more room
  // above — a flip that trades one clipped panel for another is not a fix.
  const routePanelFlip =
    routeAnchor !== null && routePanelSize !== null
    && routePanelSize.h > routeAnchor.spaceBelow
    && routeAnchor.spaceAbove > routeAnchor.spaceBelow;

  // If it fits nowhere — a long airline list on a short screen — it takes the
  // better side and scrolls inside the space it has, rather than running off.
  const routePanelSpace = routeAnchor === null
    ? 0
    : routePanelFlip ? routeAnchor.spaceAbove : routeAnchor.spaceBelow;

  // Horizontal placement, from the panel's REAL width.
  //
  // The old form clamped against ROUTE_PANEL_MAX_WIDTH, which is the width the
  // panel may reach and not the width it has. At 320pt that made the ceiling
  // 320 - 12 - 260 = 48, so EVERY trigger past 48pt from the left edge was
  // dragged back to 48 whether or not its panel would have overflowed — which is
  // why a right-hand pill opened its panel most of a row to its left.
  //
  // Left edges aligned is the default: it reads as the panel dropping out of the
  // control. It matches RIGHT edges instead only when left-aligning would run
  // off, that being the smallest shift which still leaves the panel attached to
  // its trigger. The final clamp is the guarantee, not the strategy — with a
  // measured width it now has nothing to do in any ordinary case.
  const routePanelLeft = (() => {
    if (routeAnchor === null) return 0;
    // Unmeasured: the trigger's own x. This pass renders fully transparent, so
    // the provisional placement is never seen — the same contract the height
    // side has always had.
    if (routePanelSize === null) return routeAnchor.x;
    const w = routePanelSize.w;
    const rightBound = routeAnchor.screen - ROUTE_PANEL_EDGE;
    const preferred = routeAnchor.x + w > rightBound
      ? routeAnchor.x + routeAnchor.width - w
      : routeAnchor.x;
    return Math.max(ROUTE_PANEL_EDGE, Math.min(preferred, rightBound - w));
  })();

  const toggleBand = (
    set: React.Dispatch<React.SetStateAction<Record<RouteBand, boolean>>>,
    band: RouteBand,
  ) => set(prev => ({ ...prev, [band]: !prev[band] }));

  // Built here rather than at the call sites, because the panel that renders
  // them now lives in a Modal far from the trigger. One array per control, and
  // one lookup, so the two can still never disagree.
  type RouteOption = { key: string; label: string; on: boolean; press: () => void };

  const routeSortOptions: RouteOption[] = ROUTE_SORT_OPTIONS.map(opt => ({
    key: opt,
    label: ROUTE_SORT_LABELS[opt],
    on: routeSort === opt,
    // Sort is single-choice, so picking one is the end of the interaction.
    press: () => { setRouteSort(opt); closeRouteDrop(); },
  }));

  // The three filters are multi-select: the panel deliberately stays open, and
  // the counts beside each option update under the finger.
  const routeDepOptions: RouteOption[] = ROUTE_BANDS.map(b => ({
    key: b,
    label: `${b} (${routeDepCounts[b] ?? 0})`,
    on: routeDepBands[b],
    press: () => toggleBand(setRouteDepBands, b),
  }));

  const routeArrOptions: RouteOption[] = ROUTE_BANDS.map(b => ({
    key: b,
    label: `${b} (${routeArrCounts[b] ?? 0})`,
    on: routeArrBands[b],
    press: () => toggleBand(setRouteArrBands, b),
  }));

  const routeAirOptions: RouteOption[] = routeAirlineOptions.map(a => ({
    key: a,
    label: `${a} (${routeAirCounts[a] ?? 0})`,
    on: !routeAirlinesOff.includes(a),
    press: () => setRouteAirlinesOff(prev =>
      prev.includes(a) ? prev.filter(v => v !== a) : [...prev, a]),
  }));

  // The two ends of an ambiguous search. Choosing one re-runs the search for
  // that end and leaves the other alone; the applied date is carried over, not
  // the date control's current setting, so the picker cannot silently move the
  // results to a different day.
  const routeEndOptions = (which: 'orig' | 'dest'): RouteOption[] => {
    if (routeResult === null || routePick === null) return [];
    const list = which === 'orig' ? routePick.from : routePick.to;
    const current = which === 'orig' ? routeResult.origin : routeResult.destination;
    return list.map(a => ({
      key: a.iata,
      label: `${trimAirportName(a.name)} (${a.iata})`,
      on: a.iata === current,
      press: () => {
        closeRouteDrop();
        if (a.iata === current || loading) return;
        const origin = which === 'orig' ? a.iata : routeResult.origin;
        const destination = which === 'dest' ? a.iata : routeResult.destination;
        if (origin === destination) return;
        runRouteLookup(origin, destination, routeResult.date);
      },
    }));
  };

  const routeOpenOptions: RouteOption[] =
    routeOpenDrop === 'sort' ? routeSortOptions
      : routeOpenDrop === 'dep' ? routeDepOptions
        : routeOpenDrop === 'arr' ? routeArrOptions
          : routeOpenDrop === 'air' ? routeAirOptions
            : routeOpenDrop === 'orig' ? routeEndOptions('orig')
              : routeOpenDrop === 'dest' ? routeEndOptions('dest')
                : [];

  // One shape for all four triggers. The panel they open is not here — it
  // renders in the overlay Modal below, off the layout entirely, which is what
  // keeps the results list from moving when one opens.
  //
  // The wrapper is content-sized: the row holds three pills at their natural
  // widths, and it is the LABELS that keep them on one line, not the layout.
  //
  // collapsable={false} matters on Android: without it the wrapper View can be
  // flattened away at render time and measureInWindow returns nothing usable.
  const routeDropdown = (
    id: 'sort' | 'dep' | 'arr' | 'air',
    label: string,
  ) => {
    const open = routeOpenDrop === id;
    return (
      <View
        key={id}
        style={s.routePillCol}
        collapsable={false}
        ref={node => { routeAnchorRefs.current[id] = node; }}
      >
        <TouchableOpacity
          style={s.routeDrop}
          activeOpacity={0.7}
          onPress={() => { if (open) closeRouteDrop(); else openRouteDrop(id); }}
        >
          <Text style={s.routeDropTxt} numberOfLines={1}>{label}</Text>
          <View style={[s.routeDropChev, { transform: [{ rotate: open ? '-135deg' : '45deg' }] }]} />
        </TouchableOpacity>
      </View>
    );
  };

  // Which airport an ambiguous city actually resolved to, and the way to change
  // it. It sits directly under the heading, because the heading is the thing it
  // modifies, and above the applied-date line so the facts read top down:
  // where, then which airport, then which day. An end with no alternative
  // renders nothing at all — there is nothing to disclose and nothing to pick.
  //
  // The search has already run by the time this appears. It is a correction, not
  // a question, which is why it never blocks.
  const routeEndPicker = (which: 'orig' | 'dest', label: string) => {
    if (routeResult === null || routePick === null) return null;
    const list = which === 'orig' ? routePick.from : routePick.to;
    if (list.length < 2) return null;
    const code = which === 'orig' ? routeResult.origin : routeResult.destination;
    // From the option list, so the pill and the panel can never name the same
    // airport differently.
    const airport = list.find(a => a.iata === code) ?? airportByCode(code);
    const open = routeOpenDrop === which;
    return (
      <View style={s.routeEndPickRow}>
        <Text style={s.routeEndSide}>{label}</Text>
        {/* The ref is on the PILL, not on the row: the panel anchors to the
            control the user tapped, so the caption beside it must not shift
            where the panel opens. */}
        <View
          collapsable={false}
          ref={node => { routeAnchorRefs.current[which] = node; }}
        >
          <TouchableOpacity
            style={s.routeDrop}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => { if (open) closeRouteDrop(); else openRouteDrop(which); }}
          >
            {/* The NAME leads: a code names the airport only to someone who
                already knows it. */}
            <Text style={s.routeDropTxt} numberOfLines={1}>
              {routeEndLabel(code, airport?.name ?? code, routeEndCharBudget())}
            </Text>
            <View style={[s.routeDropChev, { transform: [{ rotate: open ? '-135deg' : '45deg' }] }]} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // The saved list is a resting-state affordance, not a companion to a result.
  // Any result on screen hides it; clearing the result brings it straight back.
  const resultOnScreen = flight !== null || chatResponse !== null || routeResult !== null;

  const persistCollapsed = async (next: boolean) => {
    setSavedCollapsed(next);
    try { await AsyncStorage.setItem('savedCollapsed', next ? 'true' : 'false'); } catch {}
  };

  const persistDisplayName = async (name: string) => {
    if (Platform.OS === 'web') localStorage.setItem('displayName', name);
    else await SecureStore.setItemAsync('displayName', name);
    setDisplayName(name);
  };

  const isSaved = !!flightRecord && savedFlights.some(f => f.id === flightRecord.id);
  // Recomputed every render, so the bar tracks the ticking `now` state.
  const progressValue = computeProgress(flightRecord, now);

  const handleToggleSave = async () => {
    if (!flightRecord) return;
    setSaveError("");
    if (isSaved) {
      setSavedFlights(await unsaveFlight(email, flightRecord.id));
      showToast('unsaved');
      return;
    }
    const result = await saveFlight(email, flightRecord);
    setSavedFlights(result.flights);
    if (!result.ok) {
      setSaveError('saved flight limit reached — unsave one first');
      return;   // saveError owns this case; no toast
    }
    showToast('saved');
  };

  // Closing a card opened from a route row returns to the list. Closing a card
  // opened from the command line returns to the resting state. clearResultView
  // itself is untouched: logout and sign-in still depend on its full reset.
  const closeFlightCard = () => {
    if (routeResult !== null) {
      setFlight(null);
      setFlightRecord(null);
      setSaveError("");
      setError("");
      return;
    }
    clearResultView();
  };

  const clearResultView = () => {
    setFlight(null);
    setFlightRecord(null);
    setChatResponse(null);
    setRouteResult(null);
    setSaveError("");
    setError("");
    setQuery("");
  };

  return (
    <View style={s.root}>
      <ProfileModal
        visible={profileOpen}
        onClose={() => setProfileOpen(false)}
        username={username}
        email={email}
        effectiveName={effectiveName}
        askName={username !== null && displayName === null}
        onSaveName={async (name) => { await persistDisplayName(name); setProfileOpen(false); }}
        onSkipName={async () => { if (username) await persistDisplayName(username); setProfileOpen(false); }}
        onLogout={async () => {
          if (Platform.OS === 'web') {
            localStorage.removeItem('username');
            localStorage.removeItem('email');
            localStorage.removeItem('displayName');
          } else {
            await SecureStore.deleteItemAsync('username');
            await SecureStore.deleteItemAsync('gmailToken');
            await SecureStore.deleteItemAsync('email');
            await SecureStore.deleteItemAsync('displayName');
          }
          setUsername(null);
          setDisplayName(null);
          setGmailToken(null);
          setEmail(null);
          clearResultView();
          setProfileOpen(false);
        }}
        onGoogleSignIn={async () => {
          console.log('Google sign in tapped, platform: ' + Platform.OS);
          setProfileOpen(false);
          if (Platform.OS === 'web') {
            (window as any).google?.accounts?.id?.prompt();
          } else {
            promptAsync();
          }
        }}
      />
      {/* ── ANCHORED FILTER PANEL ──
          A Modal, not an inline block. Inline it pushed the results list down on
          open and pulled it back on close, so everything below jumped. Floating
          it over the content leaves the layout behind completely undisturbed.
          The position comes from measuring the trigger in window coordinates.

          Scrim and panel animate on SEPARATE values. The scrim starts the moment
          the control is tapped; the panel waits for its measurement. Tying them
          together would hold the whole overlay back for a layout pass. */}
      <Modal visible={routeOpenDrop !== null} transparent animationType="none" onRequestClose={closeRouteDrop}>
        <Pressable style={s.routeOverlayScrim} onPress={closeRouteDrop}>
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.routePanelDim, { opacity: routeScrimAnim }]}
          />
          {routeAnchor !== null && (
            <Animated.View
              onLayout={e => {
                const { width, height } = e.nativeEvent.layout;
                // Bails out when nothing actually changed. Moving the panel fires
                // onLayout again, and a fresh object each time would re-render
                // for no reason.
                setRoutePanelSize(prev =>
                  prev !== null && prev.w === width && prev.h === height
                    ? prev
                    : { w: width, h: height });
              }}
              style={[
                s.routeDropPanel,
                {
                  position: 'absolute',
                  left: routePanelLeft,
                  // One side or the other, never both.
                  ...(routePanelFlip
                    ? { bottom: routeAnchor.bottom }
                    : { top: routeAnchor.top }),
                  minWidth: routeAnchor.width,
                  // Left off on the measuring pass: a cap applied before the
                  // measurement would clamp the very height being measured, and
                  // the panel would then report that it fits when it does not.
                  maxHeight: routePanelMeasured ? routePanelSpace : undefined,
                  opacity: routePanelAnim,
                  transform: [
                    // Travels out of its trigger, so the direction reverses with
                    // the flip: a panel above the control has to rise, not drop.
                    {
                      translateY: routePanelAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [routePanelFlip ? OVERLAY_RISE : -OVERLAY_RISE, 0],
                      }),
                    },
                    { scale: routePanelAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
                  ],
                },
              ]}
            >
              {/* Scrolls only when the cap above actually bites, and stops the
                  tap reaching the scrim behind and closing the panel. */}
              <ScrollView
                bounces={false}
                keyboardShouldPersistTaps="handled"
              >
                {routeOpenOptions.map(o => (
                  <TouchableOpacity
                    key={o.key}
                    style={s.routeDropItem}
                    activeOpacity={0.7}
                    onPress={o.press}
                  >
                    <Text style={o.on ? s.routeDropItemOn : s.routeDropItemTxt}>{o.label}</Text>
                    {o.on && <Text style={s.routeDropMark}>{'✓'}</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </Animated.View>
          )}
        </Pressable>
      </Modal>

      {/* ── DATE CALENDAR ── */}
      <Modal visible={routeCalOpen} transparent animationType="none" onRequestClose={closeRouteCal}>
        <Pressable style={s.routeCalScrim} onPress={closeRouteCal}>
          {/* The dim is its own layer so it can fade on its own curve. Folding it
              into the sheet's value would drag the whole backdrop through the
              sheet's travel and scale. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.routeCalDim, { opacity: routeCalScrimAnim }]}
          />
          <Animated.View
            style={[
              s.routeCalSheet,
              {
                opacity: routeCalAnim,
                transform: [
                  { translateY: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                  { scale: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
          >
            <Pressable>
              <View style={s.routeCalNav}>
                {/* Month stepping is one group, so the close control can hold the
                    right edge on its own. */}
                <View style={s.routeCalNavGroup}>
                  <TouchableOpacity
                    onPress={() => shiftRouteCal(-1)}
                    disabled={!routeCalCanGoBack}
                    activeOpacity={0.7}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Text style={routeCalCanGoBack ? s.routeCalArrow : s.routeCalArrowOff}>{'<'}</Text>
                  </TouchableOpacity>
                  <Text style={s.routeCalTitle}>
                    {`${MONTHS[routeCalMonth.m]} ${routeCalMonth.y}`}
                  </Text>
                  <TouchableOpacity
                    onPress={() => shiftRouteCal(1)}
                    disabled={!routeCalCanGoNext}
                    activeOpacity={0.7}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Text style={routeCalCanGoNext ? s.routeCalArrow : s.routeCalArrowOff}>{'>'}</Text>
                  </TouchableOpacity>
                </View>
                {/* The same glyph the flight card closes with: 20x20 over a
                    24-unit box, spanning 5..19 at 1.75 stroke in the file's
                    destructive red. Tapping outside still dismisses. */}
                <TouchableOpacity
                  onPress={closeRouteCal}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={s.routeCalClose}
                >
                  <Svg width={20} height={20} viewBox="0 0 24 24">
                    <Path
                      d="M19 5 5 19"
                      fill="none"
                      stroke="rgba(248,113,113,0.55)"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                    />
                    <Path
                      d="M5 5l14 14"
                      fill="none"
                      stroke="rgba(248,113,113,0.55)"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                    />
                  </Svg>
                </TouchableOpacity>
              </View>

              <View style={s.routeCalRow}>
                {WEEKDAYS.map(w => (
                  <Text key={w} style={s.routeCalHead}>{w}</Text>
                ))}
              </View>

              {routeCalWeeks.map((week, wi) => (
                <View key={wi} style={s.routeCalRow}>
                  {week.map((day, di) => {
                    if (day === null) return <View key={di} style={s.routeCalCell} />;
                    const iso = localIsoDate(new Date(routeCalMonth.y, routeCalMonth.m, day));
                    const offset = routeDayOffset(routeCalMonth.y, routeCalMonth.m, day);
                    const usable = offset >= 0 && offset <= ROUTE_MAX_DATE_DAYS;
                    const isToday = offset === 0;
                    const picked = routeDate === null ? isToday : routeDate === iso;
                    return (
                      <TouchableOpacity
                        key={di}
                        style={[
                          s.routeCalCell,
                          picked && s.routeCalCellOn,
                          !picked && isToday && s.routeCalCellToday,
                        ]}
                        activeOpacity={0.7}
                        disabled={!usable}
                        onPress={() => pickRouteCalDay(iso, isToday)}
                      >
                        <Text style={
                          !usable ? s.routeCalDayOff
                            : picked ? s.routeCalDayOn
                              : s.routeCalDay
                        }>{day}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, paddingTop: insets.top + 12 }}>
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4ade80" colors={["#4ade80"]} />
          }
        >

          {/* ── HEADER ── */}
          <View style={[s.header, effectiveName === null && { marginBottom: 16 }]}>
            <View>
              <Text style={{ fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 }}>{'>_'}</Text>
              {effectiveName !== null && (
                <Text style={{ fontFamily: SANS_SEMI, fontSize: 20, color: '#e2e2e2', marginTop: 10 }}>{`${greetingPrefix(now, greetingIndex)}, ${effectiveName}`}</Text>
              )}
              {effectiveName !== null && (
                <Text style={{ fontFamily: MONO, fontSize: 13, color: 'rgba(226,226,226,0.4)', marginTop: 3 }}>{formatClock(now)}</Text>
              )}
            </View>
            {username !== null && (
              <TouchableOpacity style={s.profileBtn} onPress={() => setProfileOpen(true)}>
                <Text style={s.profileTxt}>{'>//'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ── SEARCH ── */}
          <Animated.View style={{ transform: [{ translateX: errorShake }] }}>
            <Animated.View style={{ marginBottom: 12, borderBottomWidth: 1, borderBottomColor: cardBorderAnim.interpolate({ inputRange: [0, 1, 2], outputRange: ['rgba(255,255,255,0.12)', '#4ade80', 'rgba(248,113,113,0.6)'] }) }}>
              <View style={s.inputContainer}>
                <Text style={s.prompt}>{`~/${effectiveName !== null ? effectiveName.toLowerCase() : 'terminal'}:-$`}</Text>
                <View style={{ flex: 1 }}>
                  <TextInput
                    style={s.input}
                    value={query}
                    onChangeText={(t) => {
                      setQuery(t);
                      setError("");
                      // The date belongs to the route that was typed. Editing the
                      // query abandons it rather than silently carrying a
                      // 4-unit dated search onto a different route.
                      setRouteDate(null);
                    }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onSubmitEditing={handleSearch}
                    returnKeyType="search"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={200}
                    selectionColor="#4ade80"
                    multiline={false}
                    blurOnSubmit={true}
                  />
                  {query.length === 0 && <AnimatedPlaceholder />}
                </View>
              </View>
            </Animated.View>
          </Animated.View>

          {/* The resolved pair, with the codes, BEFORE anything is spent. This is
              the whole protection against a code meaning somewhere else: "GOA"
              is Genoa, and typing it here says so in words while there is still
              time to change it. Nothing else belongs under the command line
              while typing — the date control moved up with the other view
              controls above the results. */}
          {routeAffordance && (
            <View style={{ marginTop: 4, marginBottom: 10, paddingLeft: 18 }}>
              <Text style={s.routeEcho} numberOfLines={2}>
                {`${routeAffordance.from.airport.city} (${routeAffordance.from.airport.iata})`}
                {' → '}
                {`${routeAffordance.to.airport.city} (${routeAffordance.to.airport.iata})`}
              </Text>
            </View>
          )}

          {error !== "" && (
            <Animated.View style={{ opacity: errorMsgOpacity }}>
              <Text style={{ fontFamily: SANS, color: 'rgba(248,113,113,0.8)', fontSize: 11, marginTop: 4, marginBottom: 6, paddingLeft: 18 }}>{`> ${error}`}</Text>
            </Animated.View>
          )}

          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Animated.View style={{ transform: [{ scale: btnScale }] }}>
              <TouchableOpacity
                style={s.searchBtn}
                onPress={handleSearch}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#4ade80" />
                  : <Text style={[s.searchBtnTxt, !query.trim() && s.searchBtnTxtOff]}>{'Execute'}</Text>
                }
              </TouchableOpacity>
            </Animated.View>
          </View>

          {username === null && (
            <View style={{ alignItems: 'center', marginBottom: 24, marginTop: 0 }}>
              <Text style={{ fontFamily: SANS, color: 'rgba(226,226,226,0.5)', fontSize: 11, marginBottom: 12, textAlign: 'center' }}>
                {'// sign in to pull your flights straight from gmail'}
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (Platform.OS === 'web') {
                    (window as any).google?.accounts?.id?.prompt();
                  } else {
                    promptAsync();
                  }
                }}
                style={{ backgroundColor: '#131314', borderWidth: 1, borderColor: '#5f6368', borderRadius: 4, paddingVertical: 11, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' }}
              >
                <Svg width={18} height={18} viewBox="0 0 48 48" style={{ marginRight: 10 }}>
                  <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </Svg>
                <Text style={{ fontFamily: SANS, color: '#e3e3e3', fontSize: 13 }}>Sign in with Google</Text>
              </TouchableOpacity>
            </View>
          )}

          {savedFlights.length > 0 && !resultOnScreen && (
            <View style={{ marginBottom: 24 }}>
              {/* Above the collapse branch: a refresh failure must never be silent. */}
              {refreshMsg !== '' && (
                <Animated.View style={{ opacity: refreshMsgOpacity }}>
                  <Text style={{
                    fontFamily: SANS,
                    fontSize: 11,
                    marginTop: 4,
                    marginBottom: 2,
                    color: refreshTone === 'info' ? 'rgba(226,226,226,0.3)' : 'rgba(248,113,113,0.8)',
                  }}>{refreshMsg}</Text>
                </Animated.View>
              )}
              {savedCollapsed ? (
                <TouchableOpacity
                  style={sf.collapsedLine}
                  activeOpacity={0.7}
                  onPress={() => persistCollapsed(false)}
                >
                  <Text numberOfLines={1}>
                    <Text style={sf.chevron}>{'\u25B8 '}</Text>
                    <Text style={sf.collapsedNumber}>{sortedSaved[0].flightNumber}</Text>
                    <Text style={sf.collapsedDim}>{' '}</Text>
                    <StatusLine f={sortedSaved[0]} now={now} hideStatus />
                    {savedFlights.length > 1 && (
                      <Text style={sf.collapsedDim}>{` · +${savedFlights.length - 1} more`}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={sf.headingRow}
                    activeOpacity={0.7}
                    onPress={() => persistCollapsed(true)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Text style={s.detailsTitle}>{'saved flights'}</Text>
                    <Text style={sf.chevron}>{'\u25BE'}</Text>
                  </TouchableOpacity>
                  {sortedSaved.map(f => (
                    <SavedFlightRow
                      key={f.id}
                      flight={f}
                      now={now}
                      onPress={() => renderSavedFlight(f)}
                      onUnsave={async () => setSavedFlights(await unsaveFlight(email, f.id))}
                    />
                  ))}
                </>
              )}
            </View>
          )}

          {chatResponse && (
            <Animated.View style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View style={{ marginBottom: 4 }}>
                <Text style={s.detailsTitle}>{'response'}</Text>
                <Text style={{ fontFamily: SANS, color: '#e2e2e2', fontSize: 13, lineHeight: 22 }}>{chatResponse}</Text>
              </View>
            </Animated.View>
          )}

          {/* Mutually exclusive in RENDER only: routeResult survives in state
              behind an open card, so closing the card restores this list. */}
          {routeResult && !flight && (
            <Animated.View style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View>
                <View style={sf.headingRow}>
                  {/* Cities, reading as language rather than two blocks either
                      side of a symbol. Two lines allowed: "Thiruvananthapuram
                      to New Delhi" does not fit on one at any phone width, and
                      shrinking the heading to force it would cost more than the
                      wrap does. */}
                  <Text style={s.routeHeadCodes} numberOfLines={2}>
                    {routeHeadFrom}
                    <Text style={s.routeHeadTo}>{'  to  '}</Text>
                    {routeHeadTo}
                  </Text>
                  <TouchableOpacity
                    onPress={clearResultView}
                    activeOpacity={0.7}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Text style={sf.remove}>{'×'}</Text>
                  </TouchableOpacity>
                </View>
                {/* The codes, kept as supporting detail rather than dropped.
                    They are what was actually asked of the provider, and they
                    are what a reader checks when a city has more than one
                    airport. */}
                <Text style={s.routeHeadSub} numberOfLines={1}>
                  {`${routeResult.origin} → ${routeResult.destination}`}
                </Text>
                {routeEndPicker('orig', 'from')}
                {routeEndPicker('dest', 'to')}
                {/* What the rows below ARE, never what the control is set to.
                    routeResult.date is the date the backend actually filtered
                    on, so this line cannot drift from the list under it. A bare
                    date read as decoration; "Showing" makes it a statement. */}
                {routeResult.date !== null && (
                  <Text style={s.routeAppliedDate}>
                    {`Showing ${routeDateLabel(routeResult.date)}`}
                  </Text>
                )}
                <Text style={[s.routeNote, routeResult.date === null && { marginTop: 12 }]}>
                  {'Times are local to each airport'}
                </Text>

                {/* TWO ROWS, never three, in every label state.

                    Row one always shows. Row two only exists while Filters is
                    expanded, and collapsing removes it outright rather than
                    hiding it, so the block is genuinely one row when shut.

                    The pills are content-sized, so the invariant is bought
                    entirely by the labels: routeFitRow shares the row's real
                    character budget between the three, longest form first, and
                    only shortens a label when the row genuinely cannot take
                    it. */}
                <View style={s.routeControls}>
                  <View style={s.routePillRow}>
                    <View style={s.routePillCol}>
                      <TouchableOpacity
                        style={s.routeDrop}
                        activeOpacity={0.7}
                        onPress={openRouteCal}
                      >
                        <Text
                          style={routeDate === null ? s.routeDropTxt : s.routeDropTxtOn}
                          numberOfLines={1}
                        >
                          {routeDatePill}
                        </Text>
                        <View style={[s.routeDropChev, { transform: [{ rotate: '45deg' }] }]} />
                      </TouchableOpacity>
                    </View>

                    {/* An empty board has nothing to sort or filter, but the date
                        still means something: it is the only control here that
                        changes what comes back. */}
                    {routeShown > 0 && (
                      <>
                        {/* Not a routeDropdown: it opens the row below rather
                            than an anchored panel, so it wears the same pill by
                            hand instead of borrowing machinery it does not use. */}
                        <View style={s.routePillCol}>
                          <TouchableOpacity
                            style={s.routeDrop}
                            activeOpacity={0.7}
                            onPress={() => { setRouteFiltersOpen(o => !o); setRouteOpenDrop(null); }}
                          >
                            <Text style={s.routeDropTxt} numberOfLines={1}>
                              {routeFiltersPill}
                            </Text>
                            <View style={[s.routeDropChev, { transform: [{ rotate: routeFiltersOpen ? '-135deg' : '45deg' }] }]} />
                          </TouchableOpacity>
                        </View>

                        {routeDropdown('sort', routeSortPill)}
                      </>
                    )}
                  </View>

                  {routeShown > 0 && routeFiltersOpen && (
                    <View style={s.routePillRow}>
                      {routeDropdown('air', routeAirPill)}
                      {routeDropdown('dep', routeDepPill)}
                      {routeDropdown('arr', routeArrPill)}
                    </View>
                  )}

                  {routeControlsDirty && (
                    <TouchableOpacity
                      style={s.routeResetBtn}
                      activeOpacity={0.7}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      onPress={routeResetControls}
                    >
                      <Text style={s.routeReset}>{'Reset'}</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {routeShown === 0 ? (
                  /* NOTHING CAME BACK. One line and no explanation. The two
                     cases are different questions and must not share a
                     sentence: an undated search saw a rolling window, a dated
                     one saw a whole day. routeResult.date is what the backend
                     actually filtered on, so this cannot drift from what was
                     asked. "This route" and not "these airports": it is the
                     pairing that is quiet, and both ends may be busy. */
                  <View style={s.routeEmptyWrap}>
                    <Text style={s.routeEmptyHead}>
                      {routeResult.date === null
                        ? `This route is quiet for the next ${routeResult.window_hours} `
                          + `${routeResult.window_hours === 1 ? 'hour' : 'hours'}`
                        : `This route is quiet on ${routeDateLabel(routeResult.date)}`}
                    </Text>
                  </View>
                ) : (
                  <>
                    {routeSorted.length === 0 ? (
                      /* FLIGHTS CAME BACK AND THE FILTERS HID THEM ALL. A
                         different fact from the one above, and the count proves
                         it: there are flights, they are just not shown. */
                      <View style={s.routeEmptyWrap}>
                        <Text style={s.routeEmptyHead}>
                          {`All ${routeShown} `
                            + `${routeShown === 1 ? 'flight is' : 'flights are'} hidden`}
                        </Text>
                        <Text style={s.routeEmptyBody}>
                          {`by the ${routeActiveFilters.join(' and ')} `
                            + `${routeActiveFilters.length === 1 ? 'filter' : 'filters'}. `
                            + 'Relax one, or Reset.'}
                        </Text>
                      </View>
                    ) : (
                      <>
                        {/* Above the list and removed from it, so it renders
                            exactly once. routeListed carries the removal, which
                            is what keeps the group counts honest. */}
                        {routePinned !== null && (
                          <View>
                            <Text style={[s.routeGroup, s.routePinHead]}>{'Fastest'}</Text>
                            {routeRow(routePinned, true)}
                          </View>
                        )}
                        {routeSort === 'departure' ? (
                          <>
                            {routeGroups.map(g => (
                              <View key={g.part}>
                                <Text style={s.routeGroup}>
                                  {`${g.part}  \u00b7  ${g.rows.length}`}
                                </Text>
                                {g.rows.map(r => routeRow(r))}
                              </View>
                            ))}
                            {routeUngrouped.map(r => routeRow(r))}
                          </>
                        ) : (
                          routeListed.map(r => routeRow(r))
                        )}

                        {routeHiddenCount > 0 && (
                          <Text style={s.routeCap}>
                            {`${routeHiddenCount} ${routeHiddenCount === 1 ? 'flight' : 'flights'} hidden by the time filter`}
                          </Text>
                        )}
                        {routeResult.truncated && (
                          <Text style={s.routeCap}>
                            {`Showing ${routeShown} of ${routeFound} found`}
                          </Text>
                        )}
                      </>
                    )}
                  </>
                )}
              </View>
            </Animated.View>
          )}

          {/* ── RESULT ── */}
          {flight && (
            <Animated.View
              style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}
            >
              {/* Flight header + status line, ruled off from the route block */}
              <View style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)', paddingBottom: 16, marginBottom: 4 }}>
                <View style={s.flightHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.flightNumber} numberOfLines={1}>{flight.flight}</Text>
                    <Text style={s.flightAirline}>{flight.airline}</Text>
                  </View>
                  <Animated.View style={[s.statusBadge, { backgroundColor: flight.statusBg, borderColor: flight.statusColor + "50", opacity: flight.status === 'ACTIVE' ? badgePulse : 1 }]}>
                    <Text style={[s.statusTxt, { color: flight.statusColor }]}>{flight.status}</Text>
                  </Animated.View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <TouchableOpacity
                      onPress={handleToggleSave}
                      activeOpacity={0.7}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                      }}
                    >
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path
                          d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"
                          fill={isSaved ? '#4ade80' : 'none'}
                          stroke={isSaved ? '#4ade80' : 'rgba(226,226,226,0.5)'}
                          strokeWidth={1.75}
                        />
                      </Svg>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={async () => {
                        if (!flightRecord) return;
                        // Pinned to the instance on screen. flight.date is the
                        // backend's own flight_date, derived from the departure
                        // ISO, so it names exactly the day being refreshed; the
                        // shape test lets "N/A" fall through to undated.
                        const ok = await runFlightLookup(
                          flightRecord.flightNumber,
                          true,
                          /^\d{4}-\d{2}-\d{2}$/.test(flight.date) ? flight.date : null,
                        );
                        if (ok) showToast('updated');
                      }}
                      activeOpacity={0.7}
                      disabled={loading}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                      }}
                    >
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path
                          d="M21 12a9 9 0 1 1-3.5-7.1"
                          fill="none"
                          stroke={loading ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.6)'}
                          strokeWidth={1.75}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <Path
                          d="M21 3v6h-6"
                          fill="none"
                          stroke={loading ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.6)'}
                          strokeWidth={1.75}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </Svg>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={closeFlightCard}
                      activeOpacity={0.7}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                        // Cancels this control's own right padding so the ink
                        // sits on the content edge, flush with the arrival IATA
                        // code below it. hitSlop keeps the tap area intact.
                        marginRight: -4,
                      }}
                    >
                      {/* Spans 5..19 of the 24-unit box to match the bookmark's
                          3..21; the old 6..18 read visibly smaller at the same
                          nominal size. */}
                      <Svg width={20} height={20} viewBox="0 0 24 24">
                        <Path
                          d="M19 5 5 19"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                        <Path
                          d="M5 5l14 14"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                      </Svg>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={{ flexDirection: 'column', gap: 4 }}>
                  {saveError !== '' ? (
                    <Text style={{ fontFamily: SANS, fontSize: 11, color: 'rgba(248,113,113,0.8)' }}>{`> ${saveError}`}</Text>
                  ) : flightRecord ? (
                    <StatusLine f={flightRecord} now={now} hideStatus />
                  ) : (
                    <Text style={{ fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.3)' }}>{lastUpdated !== null ? `updated ${timeAgo(lastUpdated, now)}` : ''}</Text>
                  )}
                </View>

                {/* Fixed height reserves the line so the block never reflows. */}
                <View style={{ minHeight: 16, alignItems: 'flex-start' }}>
                  {saveError === '' && toastMsg !== '' && (
                    <Animated.Text style={{
                      opacity: toastOpacity,
                      fontFamily: SANS,
                      fontSize: 11,
                      color: 'rgba(226,226,226,0.5)',
                    }}>{toastMsg}</Animated.Text>
                  )}
                </View>
              </View>

              {/* Route card — fixed overflow */}
              <View style={s.routeCard}>
                <View style={s.routeLeft}>
                  <Text style={s.routeIATA}>{flight.from}</Text>
                  <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.fromCity)}</Text>
                  <Text style={s.routeTime}>{clock24(flight.depIso, flight.dep)}</Text>
                </View>
                <View style={s.routeMid}>
                  {flight.duration !== null && <Text style={s.routeDuration}>{flight.duration}</Text>}
                  <Text style={s.routeArrow}>· ✈ ·</Text>
                  <Text style={s.routeDirect}>Direct</Text>
                </View>
                <View style={s.routeRight}>
                  <Text style={s.routeIATA}>{flight.to}</Text>
                  <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.toCity)}</Text>
                  <Text style={s.routeTime}>{clock24(flight.arrIso, flight.arr)}</Text>
                </View>
              </View>

              {/* Progress bar — hidden entirely when the flight state cannot place it */}
              {progressValue !== null && (flight.status === 'ACTIVE' || flight.status === 'LANDED') && (
                <ProgressBar
                  progress={progressValue}
                  color={flight.statusColor}
                />
              )}

              {/* Flight details */}
              <View style={{ marginTop: 8 }}>
                <Text style={s.detailsTitle}>Flight Details</Text>
                <InfoRow label="Date" value={flight.date} />
                <InfoRow label="Scheduled Departure" value={clock24(flight.depIso, flight.dep)} />
                <InfoRow label={flight.depTimeLabel} value={flight.depTimeValue} />
                <InfoRow label="Scheduled Arrival" value={clock24(flight.arrIso, flight.arr)} />
                <InfoRow label={flight.arrTimeLabel} value={flight.arrTimeValue} />
                <InfoRow label="Terminal" value={flight.terminal} />
                <InfoRow label="Gate" value={flight.gate} />
                {flight.checkinDesk !== null && <InfoRow label="Check-in Desk" value={flight.checkinDesk} />}
                {flight.delayLabel !== null && flight.delayValue !== null && (
                  <InfoRow label={flight.delayLabel} value={flight.delayValue} />
                )}
                <InfoRow label="Baggage Belt" value={flight.baggage} />
                {flight.aircraft !== null && <InfoRow label="Aircraft" value={flight.aircraft} />}
                {flight.registration !== null && <InfoRow label="Registration" value={flight.registration} />}
              </View>

              {/* Airports */}
              <View style={{ marginTop: 8 }}>
                <Text style={s.detailsTitle}>Airports</Text>
                <InfoRow label="Departing From" value={flight.fromFull} sans />
                <InfoRow label="Arriving At" value={flight.toFull} sans />
              </View>

            </Animated.View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050505" },
  scroll: { paddingHorizontal: 20, paddingBottom: 48 },

  header: { marginBottom: 36, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  profileBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },
  profileTxt: { color: 'rgba(226,226,226,0.5)', fontSize: 11, fontFamily: MONO },

  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 20,
  },
  prompt: {
    color: "#4ade80",
    fontFamily: MONO,
    fontSize: 13,
    marginRight: 8,
    paddingTop: 2,
  },

  input: {
    fontSize: 15,
    color: "#ffffff",
    fontFamily: MONO,
    textAlign: "left",
  },

  fakePlaceholder: {
    position: "absolute",
    left: 0,
    fontSize: 15,
    fontWeight: "300",
    color: "#2c2c2e",
    letterSpacing: 1,
  },

  searchBtn: {
    paddingVertical: 8, paddingHorizontal: 0,
    // Pinned so swapping the label for the spinner cannot resize the row.
    minHeight: 40,
    alignItems: "center", justifyContent: "center",
  },
  searchBtnTxt: { fontSize: 15, color: "#4ade80", fontFamily: MONO_BOLD },
  searchBtnTxtOff: { color: "rgba(226,226,226,0.25)" },

  resultWrap: { gap: 14 },

  flightHeader: {
    flexDirection: "row", justifyContent: "flex-start", alignItems: "flex-start",
    paddingVertical: 4,
  },
  flightNumber: { fontSize: 32, color: "#ffffff", letterSpacing: 1, fontFamily: MONO_BOLD },
  flightAirline: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 3, fontFamily: SANS },
  statusBadge: {
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1,
    flexShrink: 0,
    marginRight: 16,
  },
  statusTxt: { fontSize: 11, letterSpacing: 0.5, fontFamily: MONO_BOLD },

  routeCard: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 4,
  },
  routeLeft: { flex: 1 },
  routeRight: { flex: 1, alignItems: "flex-end" },
  routeMid: { alignItems: "center", paddingHorizontal: 8 },
  routeIATA: { fontSize: 32, color: "#ffffff", letterSpacing: -0.5, fontFamily: MONO_BOLD },
  routeCity: { fontSize: 13, color: "rgba(226,226,226,0.55)", marginTop: 2, fontFamily: SANS },
  routeTime: { fontSize: 13, color: "#aeaeb2", marginTop: 8, fontFamily: MONO_BOLD },
  routeDuration: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginBottom: 6, fontFamily: MONO },
  routeArrow: { fontSize: 20, color: "rgba(226,226,226,0.45)", fontFamily: MONO },
  routeDirect: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 6, fontFamily: MONO },

  detailsTitle: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI,
    marginBottom: 10, letterSpacing: 1, textTransform: "uppercase",
  },

  // Route search. Row metrics deliberately match sf.row and ir.row exactly.
  routeEcho: { fontSize: 13, color: "rgba(226,226,226,0.55)", fontFamily: SANS },
  // The codes under the heading, and the airport picker under those. Both are
  // supporting detail at the smallest size in the scale, separated from the
  // heading by weight and opacity rather than by a rule.
  routeHeadSub: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO,
    letterSpacing: 1, marginTop: 4,
  },
  // Content-sized, so the pill is as wide as its label rather than a third of
  // the row: these are not part of the view-control grid and must not line up
  // with it. One per row, because two airport names side by side do not fit at
  // 320pt.
  routeEndPickRow: {
    alignSelf: "flex-start", marginTop: 8,
    flexDirection: "row", alignItems: "center",
  },
  // "from" and "to" sit OUTSIDE the pill so the pill carries only the airport.
  // A FIXED width, not content width: it lines the two pills up with each
  // other, which is what makes the pair read as one control of two rows rather
  // than as two loose words. 28pt holds "from" at 6.6pt per character. Same
  // 11pt mono grey as the codes line directly above them.
  routeEndSide: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO,
    width: 28, marginRight: 8,
  },
  // Flat rows. Separation is the file's existing hairline, the same one sf.row
  // and ir.row use; the breathing room comes from paddingVertical, not a box.
  routeFlatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  routeFlatBody: { flex: 1 },
  routeFlatHead: { flexDirection: "row", alignItems: "center" },
  routeFlatIdent: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  routeFlatAirline: { fontSize: 13, color: "rgba(226,226,226,0.6)", fontFamily: SANS, flexShrink: 1 },
  routeFlatNumber: { fontSize: 13, color: "rgba(226,226,226,0.4)", fontFamily: MONO },
  // Content-width, never reserved: these are flags, and a fixed cell for a
  // status that almost never renders would leave a permanent hole. The identity
  // group flexes, so nothing here can push the row wider than the screen.
  routeFlatTags: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  // No width: the cell that collided with the duration was 62pt against a 63.9pt
  // "scheduled" once letterSpacing was counted. Sized to content, it cannot.
  routeFlatStatus: { fontSize: 11, fontFamily: MONO_BOLD, letterSpacing: 0.5 },
  // No width of any kind. As a stretched child of the column body this spans the
  // full row, so the departure sits on the row's left edge and the arrival on its
  // right edge — the same right edge line one's flags end at. Constraining this
  // width was what left the arrival floating mid-row.
  // marginTop clears the duration, which hangs above the connector line without
  // taking layout height.
  routeFlatTop: { flexDirection: "row", alignItems: "center", marginTop: 14 },
  // minWidth, not width: a five-character 24-hour time fits exactly, so both
  // cells match and the connector is centred. Should a row ever fall back to a
  // backend-formatted string, the cell grows and the connector yields instead of
  // the time truncating.
  routeFlatTime: { fontSize: 20, color: "#ffffff", fontFamily: MONO_BOLD, minWidth: 60 },
  routeFlatTimeEnd: { textAlign: "right" },
  // The box spans everything between the times; alignItems centres the drawn
  // line inside it, so the gap either side is equal at every width.
  routeConn: { flex: 1, justifyContent: "center", alignItems: "center", marginHorizontal: 12 },
  // Absolutely positioned so it labels the line without adding row height or
  // shifting the line off the times' vertical centre.
  // MONO_BOLD at 0.75 rather than MONO at 0.4. It labels the connector it sits
  // on, and at 0.4 it read as a watermark rather than as the block time.
  routeConnDur: {
    position: "absolute", left: 0, right: 0, bottom: 7,
    fontSize: 11, color: "rgba(226,226,226,0.75)", fontFamily: MONO_BOLD, textAlign: "center",
  },
  routeConnLineRow: {
    flexDirection: "row", alignItems: "center",
    width: "100%", maxWidth: ROUTE_CONNECTOR_MAX,
  },
  routeConnLine: { flex: 1, height: 1, backgroundColor: "rgba(226,226,226,0.45)" },
  // Two borders of a square turned 45 degrees: an arrowhead with no SVG.
  routeConnHead: {
    width: 5, height: 5,
    borderTopWidth: 1, borderRightWidth: 1,
    borderColor: "rgba(226,226,226,0.45)",
    transform: [{ rotate: "45deg" }],
    marginLeft: -1,
  },
  // 60pt each end and a flexed middle with the same 12pt margins routeConn
  // carries, so a code lands directly under its own time at every width. The
  // times themselves are untouched: departures still start on the row's left
  // edge and arrivals still end on its right.
  routeFlatCodes: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  routeFlatCode: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO, minWidth: 60,
  },
  routeFlatCodeEnd: { textAlign: "right" },
  routeConnSpacer: { flex: 1, marginHorizontal: 12 },

  // Icon only, no container. hitSlop carries the tap target.
  routeFlatMark: { marginLeft: 14 },
  routeFlatMarkBox: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },

  // Pill treatment, now worn by all three toolbar controls as well as the three
  // filters below them. Trigger and panel carry the SAME border at 0.12 — above
  // the 0.06 of the row separators, so they read as real edges rather than
  // receding behind the list. Both also take a 0.03 fill: a stroke alone on
  // near-black does not read as pressable, and it gives the file's 0.7
  // activeOpacity a surface to fade.
  // White, not green: green is reserved for things that are live or that cost
  // something, which here is the chosen date alone.
  //
  // One group, one set of outer margins, whatever sits inside it. The group's
  // bottom edge is therefore the same distance from the first result whether the
  // filter section is open or shut.
  routeControls: { marginTop: 24, marginBottom: 24 },
  // No flexWrap. Wrapping is what this layout is built to make impossible, and
  // leaving it on would hide a label that outgrew its cap instead of showing it.
  routePillRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8,
  },
  // Stretched, not content-sized: three equal thirds, so a row is always full to
  // its right edge whatever the labels inside it say. This is also what makes
  // each pill's width knowable without measuring it.
  routePillCol: { flex: 1 },
  // Last, below both rows and outside every panel, because it acts on all five
  // controls at once. Content-sized and left-aligned so it reads as subordinate
  // to the rows rather than as another pill in them.
  routeResetBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginTop: 6,
  },
  routeReset: { fontSize: 11, color: "rgba(226,226,226,0.5)", fontFamily: MONO },

  // The date the rows ARE for. MONO_BOLD at 13 rather than the 11pt 0.3 SANS the
  // notes use: it is a fact about the data, not small print.
  routeAppliedDate: {
    fontSize: 13, color: "#ffffff", fontFamily: MONO_BOLD,
    marginTop: 12, marginBottom: 10,
  },
  // Layout only. The dim that used to live here is now a sibling layer, so it
  // can fade on its own value.
  routeOverlayScrim: { flex: 1 },
  // Light: the panel is small and the list behind it should stay readable. It
  // still separates the two planes, and makes tap-to-dismiss look like it works.
  routePanelDim: { backgroundColor: "rgba(0,0,0,0.35)" },

  // Centred, unlike pm.backdrop which anchors its sheet to the bottom.
  routeCalScrim: {
    flex: 1,
    justifyContent: "center", paddingHorizontal: 16,
  },
  routeCalDim: { backgroundColor: "rgba(0,0,0,0.72)" },
  routeCalSheet: {
    backgroundColor: "#050505",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 4, padding: 16,
  },
  routeCalNav: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 14,
  },
  // At 320pt the sheet is 256pt wide inside its padding and this group measures
  // about 120 of it, so the close control sits clear on the right at every
  // screen size. Every month abbreviation is three characters, so the title
  // never changes width.
  routeCalNavGroup: { flexDirection: "row", alignItems: "center", gap: 4 },
  routeCalClose: { paddingVertical: 4, paddingHorizontal: 4, marginRight: -4 },
  routeCalTitle: { fontSize: 13, color: "#ffffff", fontFamily: MONO_BOLD },
  routeCalArrow: { fontSize: 15, color: "#ffffff", fontFamily: MONO_BOLD, paddingHorizontal: 8 },
  routeCalArrowOff: { fontSize: 15, color: "rgba(226,226,226,0.25)", fontFamily: MONO_BOLD, paddingHorizontal: 8 },
  routeCalRow: { flexDirection: "row" },
  routeCalHead: {
    flex: 1, textAlign: "center", fontSize: 11,
    color: "rgba(226,226,226,0.4)", fontFamily: MONO, marginBottom: 6,
  },
  // flex divides the row evenly whatever the screen. At 320pt — the narrowest
  // phone worth targeting — that is 36.6pt across. Seven columns cannot do
  // better: even edge to edge with no padding at all it would only reach 45.7pt.
  // Height is the one axis with room, so it takes the 44pt guideline outright.
  routeCalCell: { flex: 1, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  routeCalCellOn: { backgroundColor: "rgba(74,222,128,0.08)" },
  routeCalCellToday: { borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  routeCalDay: { fontSize: 13, color: "#ffffff", fontFamily: MONO },
  routeCalDayOn: { fontSize: 13, color: "#4ade80", fontFamily: MONO_BOLD },
  routeCalDayOff: { fontSize: 13, color: "rgba(226,226,226,0.25)", fontFamily: MONO },
  // space-between puts the chevron on the pill's right edge now that the pill is
  // wider than its label. paddingHorizontal is 8 rather than 10: see
  // ROUTE_PILL_CHROME — those four points are two characters of label at 320pt.
  routeDrop: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 8,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  routeDropTxt: { fontSize: 11, color: "#ffffff", fontFamily: MONO, flexShrink: 1 },
  // A chosen date is one of the three things green is allowed to mark.
  routeDropTxtOn: { fontSize: 11, color: "#4ade80", fontFamily: MONO_BOLD, flexShrink: 1 },
  // Two borders of a square, same trick as the connector's arrowhead: a real
  // chevron with a controllable weight, where a glyph gave a thin triangle.
  // marginLeft 4, not 8: with space-between the gap is whatever the pill has
  // spare, and this is only the minimum. Used by the pill triggers alone.
  routeDropChev: {
    width: 6, height: 6,
    borderRightWidth: 1.5, borderBottomWidth: 1.5,
    borderColor: "rgba(226,226,226,0.5)",
    marginLeft: 4,
  },
  // Same border as the trigger. The open state is already unmistakable from the
  // panel existing at all and the chevron flipping; a heavier edge is not needed
  // to say so.
  //
  // The ground is opaque, not the 0.03 white it carried inline. That tint read
  // correctly against the page directly behind it; floating over a transparent
  // scrim it let the results list show straight through. Same black as the
  // calendar sheet.
  routeDropPanel: {
    maxWidth: ROUTE_PANEL_MAX_WIDTH,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#050505",
    borderRadius: 4,
    // Keeps the scrolling contents inside the rounded corners.
    overflow: "hidden",
  },
  routeDropItem: {
    paddingVertical: 8, paddingHorizontal: 10,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  routeDropItemTxt: { fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO },
  routeDropItemOn: { fontSize: 11, color: "#ffffff", fontFamily: MONO_BOLD },
  routeDropMark: { fontSize: 11, color: "#ffffff", fontFamily: MONO },
  routeHeadCodes: { fontSize: 20, color: "#ffffff", letterSpacing: -0.5, fontFamily: MONO_BOLD },
  routeHeadTo: { fontSize: 13, color: "rgba(226,226,226,0.4)", fontFamily: SANS },
  // A divider, not a whisper: more air above than below binds it to the rows it
  // introduces rather than to the group that ended.
  routeGroup: {
    fontSize: 11, color: "rgba(226,226,226,0.5)", fontFamily: MONO_BOLD,
    letterSpacing: 1, marginTop: 28, marginBottom: 6,
  },
  // Its own size and family: it sits in the row's flag group, not inside a
  // parent Text it could inherit from.
  routeFastest: { fontSize: 11, color: "#4ade80", fontFamily: MONO },
  // The pinned row renders exactly as a list row does. Its whole marking is the
  // green heading above it — nothing on the row, no geometry anywhere.
  routePinHead: { color: "#4ade80" },
  routeNote: { fontSize: 11, color: "rgba(226,226,226,0.3)", fontFamily: SANS, marginBottom: 10 },
  routeCap: { fontSize: 11, color: "rgba(226,226,226,0.3)", fontFamily: SANS, marginTop: 10 },
  // THE ROOM THE LIST WOULD HAVE HAD.
  //
  // 56 top and bottom is about the height of two flat rows, so the message
  // occupies the area the results would have filled instead of tucking under
  // the controls. That vertical space is the whole point: it is what turns a
  // line of text into an answer, and it is why the type below can stop trying.
  //
  // Centred, because a single line with nothing beneath it has no column to
  // align to — left-aligned, it read as the first item of a list that never
  // arrived. 24 of horizontal padding so a wrapped line breaks well short of
  // the edges rather than running the full width.
  //
  // Both empty cases share all of this, so they cannot drift apart.
  routeEmptyWrap: {
    alignItems: "center",
    paddingVertical: 56,
    paddingHorizontal: 24,
  },
  // Still 20: with no list under it this IS the result, and shrinking it would
  // make it a caption again. What changes is the emphasis — SANS rather than
  // SANS_SEMI, and 0.6 of the grey ramp rather than pure white. Semibold white
  // on the left margin read as a headline announcing a failure; the space above
  // now carries the weight, so the letters do not have to.
  routeEmptyHead: {
    fontSize: 20, color: "rgba(226,226,226,0.6)", fontFamily: SANS,
    textAlign: "center", lineHeight: 28,
  },
  // Dimmer than the headline rather than level with it, so the two read in
  // order. The margin lives here and not on the headline above, which means the
  // case with no second line carries no dangling space.
  routeEmptyBody: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS,
    textAlign: "center", lineHeight: 18, marginTop: 10,
  },
});

const pm = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#050505',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 52,
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 20,
    right: 24,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeTxt: { color: '#4ade80', fontSize: 15, fontFamily: MONO },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1.5,
    borderColor: 'rgba(74,222,128,0.4)',
    backgroundColor: 'rgba(74,222,128,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 4,
  },
  avatarTxt: { color: '#4ade80', fontSize: 20, fontFamily: MONO },
  name: { fontSize: 20, color: '#ffffff', fontFamily: MONO },
  sub: {
    fontSize: 13,
    color: 'rgba(226,226,226,0.4)',
    fontFamily: MONO,
    marginBottom: 32,
    textAlign: 'center',
  },
  authBtn: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  authBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameLabel: {
    fontFamily: SANS,
    fontSize: 11,
    color: 'rgba(226,226,226,0.4)',
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', marginBottom: 8 },
  nameInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 13,
    color: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  nameBtn: {
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.4)',
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  nameBtnTxt: { fontFamily: MONO, fontSize: 13, color: '#4ade80' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  pencil: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)' },
  authBtnTxt: { color: '#ffffff', fontSize: 15, fontFamily: MONO },
});