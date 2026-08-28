import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import Svg, { Path, Rect, G } from 'react-native-svg';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
// The Reanimated one, deliberately. The root export's Swipeable is marked
// "@deprecated use Reanimated version of Swipeable instead" in the installed
// package's own types; this is the current API in 2.28.
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
// Aliased, because this file's Animated is React Native's and both are in use:
// every existing animation here drives RN's own Animated, and only the swipe
// actions read a Reanimated shared value. react-native-reanimated is already a
// dependency — gesture-handler's Swipeable is built on it.
import Reanimated, {
  useAnimatedStyle, useAnimatedReaction, useDerivedValue, useSharedValue,
  interpolate, runOnJS, Extrapolation, type SharedValue,
  withTiming, withSequence, withDelay, Easing as REasing,
} from 'react-native-reanimated';
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
  setFlightArchived,
  setFlightReminders,
  savedFlightFromApi,
  makeFlightId,
  ISO_DAY_RE,
  migrateLegacyIfNeeded,
  mergeGuestInto,
} from '../lib/storage';
import { airlineFromFlightNumber } from '../lib/airlines';
// zonedIsoToTs and clock24 moved to lib/time.ts, which is now the one place
// either kind of ISO is read. The reasoning that used to sit above them here
// moved with them, because it is the reasoning that stops the next person
// calling new Date() on a flight DTO field.
import { zonedIsoToTs, clock24 } from '../lib/time';
import {
  ensureChannel,
  ensurePermission,
  reminderTimes,
  scheduleFor,
  cancelFor,
  reconcile,
} from '../lib/reminders';
import {
  Airport,
  airportByCode,
  resolveAirportName,
  isKnownPlace,
  normalizeTerm,
} from '../lib/airports';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

const API_BASE = 'https://flight-tracker-970706733452.asia-south1.run.app';

// The flight endpoint's URL, in one place, because four fetch sites build it and
// they must agree. Both parameters are optional and both are omitted when null,
// so an argument-free call produces the URL this file has always sent.
//
// The query is ASSEMBLED rather than concatenated. Appending "&origin=" to a
// path that has no "?date=" on it — which is every route-row tap on an undated
// board, the commonest case there is — would send a malformed URL and lose the
// filter silently, which is the same class of fault this change exists to fix.
function flightUrl(number: string, date: string | null, origin: string | null): string {
  const parts: string[] = [];
  if (date !== null && date !== '') parts.push(`date=${date}`);
  if (origin !== null && origin !== '') parts.push(`origin=${origin}`);
  return `${API_BASE}/flight/${number}${parts.length === 0 ? '' : `?${parts.join('&')}`}`;
}

const FLIGHT_REGEX = /^[A-Z]{2}\d{2,4}$/;
// Three letters, an optional single separator, three letters. "BLR DEL",
// "BLR>DEL", "BLR-DEL", "BLR\u2192DEL" and "BLRDEL" all match. Tested after
// FLIGHT_REGEX, which needs digits, so the two can never both match.
const ROUTE_REGEX = /^([A-Z]{3})[\s>\-\u2192]?([A-Z]{3})$/;

// ── PLAIN ENGLISH ────────────────────────────────────────────────────────────
//
// "Flight from San Francisco to Abu Dhabi on 3 October, morning, fastest" is a
// route search with three decorations on it. All of this is LOCAL and FREE:
// nothing here calls a model, and the only thing it can cause to happen is the
// same board fetch "SFO AUH" already causes.
//
// THE SHAPE. One function wrapping the existing parser:
//
//   1  parseRouteQuery on the raw string. A hit returns immediately and this
//      whole file might as well not exist — see parseSearchQuery.
//   2  peel the modifier phrases off, hand the remainder to the SAME parser.
//   3  no hit either way: return step 1's answer verbatim, so what falls
//      through to /chat is exactly what fell through before.
//
// THE SAFETY PROPERTY, and everything else rests on it: a peel is only accepted
// if the REMAINDER STILL RESOLVES TO TWO AIRPORTS. A wrong strip cannot turn a
// working route into a broken one; it can only fail to help. That is what makes
// it safe to guess aggressively — an over-reach costs a fallthrough, which is
// where the input was going anyway.

// Full names only, and deliberately not "mon"/"tue"/"sat". A weekday is the one
// date form that strips WITHOUT a number beside it, so it is the one form that
// can eat a place name on its own. "Sat" and "Sun" are far likelier to be part
// of something else than "Saturday" is.
const NL_WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// Abbreviations ARE safe here, because a month only counts adjacent to a
// number. "March" alone stays a town in Cambridgeshire; "3 March" is a date.
const NL_MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

// The four bands the results screen already filters on, by the words people use
// for them. "night" and "evening" are the same band; "overnight" is not, which
// is the distinction the 00:00-05:00 band exists to make.
const NL_BANDS: Record<string, RouteBand> = {
  morning: '05:00-12:00',
  afternoon: '12:00-18:00',
  evening: '18:00-00:00',
  night: '18:00-00:00',
  overnight: '00:00-05:00',
  redeye: '00:00-05:00',
};
const NL_BAND_PAIRS: Record<string, RouteBand> = {
  'red eye': '00:00-05:00',
  'early morning': '00:00-05:00',
  'late night': '00:00-05:00',
};

// NO "latest" and no "last", though both are asked for. The list sorts one way
// only, so "latest departure" has no honest mapping — arrival-ascending is a
// different question wearing the same word. Leaving them out means they stay in
// the string and the sentence falls through, which is the failure the user can
// see. See the note on partial understanding at parseSearchQuery.
const NL_SORTS: Record<string, RouteSort> = {
  fastest: 'duration', quickest: 'duration', shortest: 'duration',
  earliest: 'departure', soonest: 'departure',
};

// Words that are never part of a place name in the dataset and are common in a
// spoken request. Dropped only in the SECOND candidate, so a place that happens
// to contain one still has a chance in the first.
//
// "to" is not here and must never be: it is the route separator. "from" is,
// because it only ever introduces the origin.
const NL_FILLER = new Set([
  'flight', 'flights', 'fly', 'flying', 'show', 'me', 'find', 'search', 'get',
  'please', 'a', 'an', 'the', 'for', 'on', 'at', 'in', 'from', 'departing',
  'leaving', 'going', 'arriving', 'ticket', 'tickets', 'any', 'all', 'is',
  'are', 'there', 'what', 'whats', 'when', 'plz',
]);

// What a sentence added on top of the route.
type SearchMods = { date: string | null; band: RouteBand | null; sort: RouteSort | null };
const NL_NO_MODS: SearchMods = { date: null, band: null, sort: null };

type SearchParse =
  | { kind: 'ok'; from: RouteEnd; to: RouteEnd; mods: SearchMods }
  | { kind: 'error'; message: string; soft?: boolean }
  | null;

// A day number with or without its ordinal tail: 3, 3rd, 21st, 22nd.
const NL_DAY_RE = /^([0-9]{1,2})(st|nd|rd|th)?$/;
const NL_YEAR_RE = /^(20[0-9]{2})$/;

// Whole days from today, or null when the date is not a real one. Built the same
// way routeDayOffset builds it, from local midnight, because the window the
// calendar enforces is a local-calendar window.
function nlOffset(d: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

// A day-and-month with no year: this year, or next year if that has already
// gone. "3 January" asked in December means the January five weeks away, not
// the one eleven months back.
function nlFromDayMonth(day: number, month: number, year: number | null): Date | null {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const made = new Date(y, month, day);
  // Rejects 31 February, which rolls over into March rather than failing.
  if (made.getMonth() !== month || made.getDate() !== day) return null;
  if (year === null && nlOffset(new Date(y, month, day)) < 0) {
    const next = new Date(y + 1, month, day);
    return next.getMonth() === month ? next : null;
  }
  return made;
}

// The next occurrence of a weekday. `skipToday` is the whole difference between
// "friday" and "next friday": said on a Friday, the first means today and the
// second means the one after. Both readings of "next friday" exist in English;
// this is the near one, and the extraction is shown before Execute either way.
function nlWeekdayDate(target: number, skipToday: boolean): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 && skipToday) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}

type NlPeel = {
  candidates: string[];
  mods: SearchMods;
  // A date that parsed cleanly and lands outside the window the calendar allows.
  // Held rather than thrown, because it only becomes an error if the ROUTE
  // resolves — otherwise the sentence was never a route search at all.
  dateError: string | null;
};

// Walk the words once, longest phrase first, and take out what is recognised.
// Returns null when there is nothing to peel or the sentence contradicts itself.
function nlPeel(q: string): NlPeel | null {
  // Commas and semicolons separate a spoken list and are never inside a name
  // this dataset can match. Other punctuation is left alone.
  const norm = q.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (norm === '') return null;
  const words = norm.split(' ');
  const low = words.map(w => w.toLowerCase());

  const keep: boolean[] = words.map(() => true);
  let date: Date | null = null;
  let band: RouteBand | null = null;
  let sort: RouteSort | null = null;
  let found = false;
  // Two dates, or two different bands, means the sentence is not understood.
  // Guessing which one was meant is exactly the over-reach the discard rule
  // cannot protect against, because both readings resolve.
  let clash = false;

  const take = (i: number, n: number) => { for (let k = i; k < i + n; k++) keep[k] = false; found = true; };
  const setDate = (d: Date | null, i: number, n: number) => {
    if (d === null) return false;
    if (date !== null) { clash = true; return false; }
    date = d; take(i, n); return true;
  };

  for (let i = 0; i < low.length; i++) {
    if (!keep[i]) continue;
    const w = low[i];
    const w1 = i + 1 < low.length ? low[i + 1] : '';
    const w2 = i + 2 < low.length ? low[i + 2] : '';

    // "next friday"
    if (w === 'next' && w1 in NL_WEEKDAYS) {
      if (setDate(nlWeekdayDate(NL_WEEKDAYS[w1], true), i, 2)) { i++; continue; }
    }
    // "3 October" / "3rd Oct" (+ an optional year, consumed so it cannot poison
    // the remainder)
    const dm = NL_DAY_RE.exec(w);
    if (dm && w1 in NL_MONTHS) {
      const yr = NL_YEAR_RE.test(w2) ? Number(w2) : null;
      const n = yr === null ? 2 : 3;
      if (setDate(nlFromDayMonth(Number(dm[1]), NL_MONTHS[w1], yr), i, n)) { i += n - 1; continue; }
    }
    // "October 3" / "Oct 3rd"
    const md = NL_DAY_RE.exec(w1);
    if (w in NL_MONTHS && md) {
      const yr = NL_YEAR_RE.test(w2) ? Number(w2) : null;
      const n = yr === null ? 2 : 3;
      if (setDate(nlFromDayMonth(Number(md[1]), NL_MONTHS[w], yr), i, n)) { i += n - 1; continue; }
    }
    // Two-word bands before one-word ones, or "red" and "eye" both survive.
    const pair = `${w} ${w1}`;
    if (pair in NL_BAND_PAIRS) {
      if (band !== null && band !== NL_BAND_PAIRS[pair]) clash = true;
      band = NL_BAND_PAIRS[pair]; take(i, 2); i++; continue;
    }
    if (w === 'today' || w === 'tonight') { if (setDate(new Date(), i, 1)) continue; }
    if (w === 'tomorrow') {
      const d = new Date(); d.setDate(d.getDate() + 1);
      if (setDate(d, i, 1)) continue;
    }
    if (w in NL_WEEKDAYS) {
      if (setDate(nlWeekdayDate(NL_WEEKDAYS[w], false), i, 1)) continue;
    }
    if (w in NL_BANDS) {
      if (band !== null && band !== NL_BANDS[w]) clash = true;
      band = NL_BANDS[w]; take(i, 1); continue;
    }
    if (w in NL_SORTS) {
      if (sort !== null && sort !== NL_SORTS[w]) clash = true;
      sort = NL_SORTS[w]; take(i, 1); continue;
    }
  }

  if (clash || !found) return null;

  const kept = words.filter((_, i) => keep[i]);
  // Two candidates, tried in order. The first keeps every word that is not a
  // modifier, so a place containing a filler word survives it; the second drops
  // the filler, which is what turns "Flight from San Francisco to Abu Dhabi"
  // into something the route parser's six-word limit will look at.
  const a = kept.join(' ').trim();
  const b = kept.filter(w => !NL_FILLER.has(w.toLowerCase())).join(' ').trim();
  const candidates = [a];
  if (b !== a && b !== '') candidates.push(b);
  // "between X and Y" is the one phrasing worth rewriting, because `and` cannot
  // join ROUTE_SEPARATORS without changing what the existing parser does to
  // every input. Contained here, it changes nothing outside this candidate.
  if (low.includes('between')) {
    const c = b.replace(/^between\s+/i, '').replace(/\s+and\s+/i, ' to ').trim();
    if (c !== '' && !candidates.includes(c)) candidates.push(c);
  }

  let dateError: string | null = null;
  let iso: string | null = null;
  if (date !== null) {
    const off = nlOffset(date);
    if (off < 0) dateError = 'that date has already gone';
    else if (off > ROUTE_MAX_DATE_DAYS) dateError = `route search reaches ${ROUTE_MAX_DATE_DAYS} days ahead at most`;
    else iso = localIsoDate(date);
  }

  return { candidates, mods: { date: iso, band, sort }, dateError };
}

// THE ROUTER for everything typed into the command line that is not a flight
// number.
//
// PARTIAL UNDERSTANDING, which is the rule the rest of this follows from: an
// unrecognised phrase is never silently dropped.
//
//   - route resolves, modifiers understood        run with all of them
//   - route resolves, no modifiers present        run exactly as before
//   - route resolves, a date parsed but is out of the window
//                                                 DO NOT SEARCH. Say so, free
//   - anything else in the sentence               it stays in the string, the
//                                                 route fails, /chat gets it
//
// The third case is the one worth defending. "SFO to AUH on 3 October 2027"
// resolves both ends and names a real date the backend will not serve. Running
// it with the date quietly dropped returns TODAY's board — a plausible answer
// to a different question, for two units. Erring costs nothing and is visibly
// wrong rather than invisibly wrong.
//
// The fourth is why "SFO to AUH at dawn" is not a search that ignores "dawn":
// dawn is not a band word, so it stays, the route fails, and the sentence goes
// where it went before. Under-reaching is a failure you can see. Over-reaching
// is a wrong answer you cannot.
function parseSearchQuery(q: string): SearchParse {
  // STEP 1, and the reason short routes cost nothing new: the existing parser
  // on the raw string, first, every time. On a hit nothing below runs.
  const raw = parseRouteQuery(q);
  if (raw !== null && raw.kind === 'ok') return { ...raw, mods: NL_NO_MODS };

  const peeled = nlPeel(q);
  if (peeled !== null) {
    for (const cand of peeled.candidates) {
      const r = parseRouteQuery(cand);
      // ok only. A peeled candidate that produces an ERROR is not trusted: the
      // error was computed from a string the user did not type.
      if (r !== null && r.kind === 'ok') {
        if (peeled.dateError !== null) return { kind: 'error', message: peeled.dateError };
        return { ...r, mods: peeled.mods };
      }
    }
  }
  // STEP 3. Whatever the raw parse said, unchanged — including null, which is
  // what sends a sentence to /chat.
  return raw;
}

// The user's own words back, not the app's internal values: a band renders as
// "morning" rather than "05:00-12:00", which is what was typed and what the
// filter will show.
const NL_BAND_LABEL: Record<RouteBand, string> = {
  '00:00-05:00': 'overnight',
  '05:00-12:00': 'morning',
  '12:00-18:00': 'afternoon',
  '18:00-00:00': 'evening',
};
const NL_SORT_LABEL: Record<RouteSort, string> = {
  duration: 'fastest', departure: 'earliest', arrival: 'by arrival',
};

function nlModsLabel(m: SearchMods): string {
  const parts: string[] = [];
  if (m.date !== null) parts.push(routeDateLabel(m.date));
  if (m.band !== null) parts.push(NL_BAND_LABEL[m.band]);
  if (m.sort !== null) parts.push(NL_SORT_LABEL[m.sort]);
  return parts.join('  \u00b7  ');
}

// One band on, the rest off, in the shape the filter state already holds.
function nlBandOnly(b: RouteBand): Record<RouteBand, boolean> {
  const out = {} as Record<RouteBand, boolean>;
  for (const k of ROUTE_BANDS) out[k] = k === b;
  return out;
}

// ── THE MODEL RUNG ───────────────────────────────────────────────────────────
//
// Everything above this is free. This is the one rung that costs a model call,
// and it exists for the sentences the peeler cannot reach: a misspelt place, a
// numeric date, a range, a time word outside the four bands, an origin the user
// never named.
//
// THE GATE, and it is the whole reason this is affordable.
//
// The obvious gate — "the peeler found a modifier but nothing resolved" — was
// measured and rejected. It fires on "flights tomorrow", "morning flights" and
// "fastest", none of which name a place, and it MISSES the cases it exists for,
// because the peeler only recognises vocabulary it already knows: "on 3/10",
// "this weekend" and "at dawn" peel nothing at all.
//
// This gate asks a different question: does the sentence contain a place, EXACTLY
// spelt? Measured over eleven non-search inputs — "is my flight on time", "what
// time does my flight land", "how do I get to the airport", "when does my plane
// land", "what is my gate", "cancel my booking" and the rest — it fired zero
// times, and it fired on seven of nine intended ones.
//
// It has to be an EXACT test. resolveAirportName's lowest tier matches any
// haystack containing the term, which answers "time" with Nice, "land" with
// Gothenburg and "sfo" with Sydney. A gate built on it would send every
// question to the model. isKnownPlace exists for this and nothing else.
//
// The two it misses are sentences where EVERY place is misspelt. Nothing free
// can tell those from noise, and paying a model call to find out is the cost
// this gate exists to avoid.
const NL_GATE_MAX_SPAN = 3;

function nlLooksLikeSearch(q: string): boolean {
  const w = normalizeTerm(q).split(' ').filter(Boolean);
  // One word is a place name, not a sentence, and the free rungs have already
  // had it. Two is the shortest thing that can be a search this rung improves.
  if (w.length < 2) return false;
  for (let i = 0; i < w.length; i++) {
    for (let n = NL_GATE_MAX_SPAN; n >= 1; n--) {
      if (i + n > w.length) continue;
      if (isKnownPlace(w.slice(i, i + n).join(' '))) return true;
    }
  }
  return false;
}

// What the endpoint sends back, before the device has looked at any of it.
type ParseReply = {
  origin: string | null;
  destination: string | null;
  date: string | null;
  date_kind: 'single' | 'range' | null;
  band: 'morning' | 'afternoon' | 'evening' | 'overnight' | null;
  sort: 'fastest' | 'earliest' | null;
  confidence: number;
  error: string | null;
};

// What the device made of it.
//
// `armed` is the only field that decides whether the next press spends units.
// `note` is the line the user reads. A reading can be shown and not armed, which
// is the point: an extraction the app is unsure of is still worth showing,
// because the user can see in one glance whether it read them correctly.
type NlRead = {
  from: RouteEnd | null;
  to: RouteEnd | null;
  fromName: string | null;
  toName: string | null;
  mods: SearchMods;
  armed: boolean;
  note: string;
};

// Below this the reading is shown but the next press does not search. 0.7 rather
// than a half: the cost of being wrong is four units and a board for the wrong
// day, and the cost of being cautious is one more press.
const NL_ARM_AT = 0.7;
// A rank above this came from the substring tier and is a coincidence as often
// as a match. See resolveAirportName.
const NL_TRUST_RANK = 2;

const NL_BAND_OF: Record<string, RouteBand> = {
  morning: '05:00-12:00', afternoon: '12:00-18:00',
  evening: '18:00-00:00', overnight: '00:00-05:00',
};
const NL_SORT_OF: Record<string, RouteSort> = {
  fastest: 'duration', earliest: 'departure',
};

// The reply, checked again. The endpoint already validated the date against the
// same window and the vocabularies against the same enums; this is the second
// of the two cheap checks, and it is here because a field that reaches the
// search has to have been agreed by both sides.
function nlReadReply(r: ParseReply): NlRead {
  const none: SearchMods = { date: null, band: null, sort: null };
  const dead = (note: string): NlRead =>
    ({ from: null, to: null, fromName: r.origin, toName: r.destination, mods: none, armed: false, note });

  if (r.error !== null) return dead(r.error);

  // A RANGE IS REFUSED, never narrowed. "This weekend" is two days and the board
  // is one; picking Saturday would be a wrong answer that costs four units and
  // looks right. The endpoint is told never to collapse one, and this is what
  // happens when it says so.
  if (r.date_kind === 'range') {
    return dead('I can only search one day at a time — which date?');
  }
  if (r.origin === null || r.destination === null) {
    const missing = r.origin === null ? 'where you are flying from' : 'where you are flying to';
    return dead(`I did not catch ${missing}`);
  }

  // NAMES, resolved HERE. The model never picked an airport; it read two words
  // out of a sentence. Everything that decides which airport those words mean —
  // including the refusal of anything not in the dataset — happens on the
  // device, exactly as it does for a typed route.
  const from = resolveRouteEnd(r.origin);
  const to = resolveRouteEnd(r.destination);
  if (from === null || to === null) {
    const bad = from === null ? r.origin : r.destination;
    return dead(`no airport matches "${bad}"`);
  }
  if (from.airport.iata === to.airport.iata) {
    return dead('origin and destination must be different airports');
  }

  const mods: SearchMods = {
    date: r.date,
    band: r.band !== null ? NL_BAND_OF[r.band] ?? null : null,
    sort: r.sort !== null ? NL_SORT_OF[r.sort] ?? null : null,
  };

  // Two ways to be unsure, and either is enough to withhold the search: the
  // model said so, or the names it returned only matched something loosely.
  const loose = from.rank > NL_TRUST_RANK || to.rank > NL_TRUST_RANK;
  const armed = r.confidence >= NL_ARM_AT && !loose;
  return {
    from, to, fromName: r.origin, toName: r.destination, mods, armed,
    note: armed
      ? 'read from your words — press again to search'
      : 'I am not sure I read that right — check it, then press again',
  };
}

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

type RouteEnd = { airport: Airport; options: Airport[]; rank: number };

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
    // An exact code is the most certain match there is.
    if (a !== null) return { airport: a, options: [a], rank: 0 };
  }
  const hit = resolveAirportName(t);
  return hit === null ? null : { airport: hit.airport, options: hit.options, rank: hit.rank };
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
  | { kind: 'error'; message: string; soft?: boolean }
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
      from: { airport: from, options: [from], rank: 0 },
      to: { airport: to, options: [to], rank: 0 },
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
  // SOFT. The other two errors in this function are confident — a code that is
  // not in the dataset is known to be wrong, and an origin equal to its
  // destination is known to be wrong. This one only means the split did not
  // resolve, which is exactly the case a model might read better. The flag is
  // what lets the router offer it upwards instead of stopping on it.
  if (orphan !== null) return { kind: 'error', message: `no airport matches "${orphan}"`, soft: true };
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
// The same grey the bookmark outline uses on the flight card.
const ARCHIVE_ICON = 'rgba(226,226,226,0.5)';

// THE BLUR, inside the sheet and clipped to it.
//
// It covered the whole screen before, which softened the page everywhere and
// left nothing for the sheet to be a window ONTO. Behind the panel the page is
// blurred; a millimetre outside it, the page is sharp and merely dimmed. That
// edge is the whole effect.
//
// THE TINT is systemChromeMaterialDark, and that is the whole of this change.
//
// "dark" was not a neutral darkening. expo-blur's own table gives it as
// rgb(25,25,25) at 0.69 x intensity — at 55 that is a 38%-opaque light-grey
// wash, and over a page this dark it does not darken at all, it LIFTS. Measured
// from those numbers: the ground under the panel is rgb(2.25); "dark" takes it
// to rgb(10.88). The scrim and the fill both subtract; the tint was the only
// thing adding, and it was adding more than they were taking away.
//
// systemChromeMaterialDark is the one dark material in the set whose colour is
// rgb(0,0,0) rather than rgb(25) or rgb(37) — pure black at 0.75 x intensity.
// It blurs exactly as hard and adds no light at all, which is what lets the
// panel sit on the page colour instead of above it.
//
// The intensity is untouched. It could not have fixed this: the tint's alpha
// scales WITH intensity, so turning the blur down turns the grey down and the
// blur with it. The colour was the problem, not the amount.

// 32 of 100.
//
// 32, down from 55, and this one number is doing two jobs at once.
//
// A blur preserves the AVERAGE brightness under its kernel; what it changes is
// how far that average is spread. On Android the radius is intensity / 4, so 55
// was a radius of 13.75 against a saved row's pitch of roughly 41pt. The kernel
// was wide enough to reach from one row of text to the next, which means every
// dark gap got averaged together with the white text on either side of it and
// the whole panel settled at the page's mean brightness. That is what a uniform
// grey fog IS: a blur wide enough that nothing local survives it.
//
// At 32 the radius is 8. Still comfortably past readable — the probe at 8 gave
// a radius of 2 and the page was plainly legible, and 13pt text loses its words
// once the radius passes its x-height of about 6.5 — but only a fifth of the
// row pitch, so the gaps between rows stay as dark as they started and the text
// stays a localised blob rather than a screen-wide wash. Black where the page
// is black, soft shape where the page has something on it.
const SHEET_BLUR = 32;

// THE SHEET SURFACE, and there is only one layer of it now.
//
// FILL is translucent black over the blur, and NOTHING else. The vertical
// gradient that used to sit on top of it has gone: white over black makes grey,
// and a grey panel on a black page reads as a card laid on the screen rather
// than as a window through it.
//
// 0.22, down from 0.34. More of the blurred page comes through and nothing
// else about the panel moves.
//
// The whole stack, from the page outward. The scrim figure below was stale —
// it still read 0.55 after routeCalDim went to 0.40 last round — and is
// corrected here:
//
//   page                        rgb(5.00)
//   through the scrim 0.40      rgb(3.00)   <- and this is also what is seen
//                                              OUTSIDE the panel
//   through the tint (black)    rgb(2.28)
//   through the fill 0.22       rgb(1.78)   <- the panel's own ground
//
// Transmission goes from 30.1% to 35.6%: (1 - 0.40)(1 - 0.24)(1 - 0.22).
//
// It cannot turn grey by going down, which is worth being explicit about since
// grey is the failure mode everything here is guarding against. The fill is
// BLACK; less of it means more of the page, and the page is rgb(5). The ground
// rises from rgb(1.51) to rgb(1.78) and stays a level and a quarter BELOW the
// rgb(3.00) around it. The panel is still the darkest thing on the screen.
const SHEET_FILL = 'rgba(0,0,0,0.22)';

// THERE IS NO OUTLINE. The stroked SVG rounded rectangle that used to sit here,
// and the per-side border before it, are both gone.
//
// What replaces them is nothing, and that is the point: the panel's boundary is
// the place where the page stops being blurred. Outside the radius the page is
// sharp and merely dimmed; a pixel inside it, the same content is soft. Over
// anything with content behind it that transition is unmistakable, and it costs
// no ink at all — it is the edge FELT rather than an edge drawn.
//
// Where there is genuinely nothing behind the panel the boundary does vanish,
// and no fill can rescue it: the surroundings are already rgb(2.25), so even a
// fully opaque black panel would differ by two levels. There is not enough
// light out there to take any more of away. The alternative was a stroke, and a
// stroke is the thing being removed.
//
// SHEET_RADIUS survives because sheetShell still rounds and still clips — the
// clip is what confines the blur, which is now the only thing marking the edge.
const SHEET_RADIUS = 16;
// The rule under the heading is NOT an edge treatment. It separates two pieces
// of content and keeps its own weight accordingly.
const SHEET_RULE = 'rgba(255,255,255,0.07)';

// A HAIRLINE, and the fifth attempt at this edge is the first that is not a
// gradient. Four soft falloffs — top stroke, top wash, bottom wash — all read
// as grey rather than as light, and they read that way because that is what a
// low-alpha white ramp over black IS. Spread any small amount of white over
// 20pt and the eye integrates it into a haze; put the same white in one row of
// pixels and it is a line with a lit edge.
//
// So: one pixel, one opacity, all four sides the same. Nothing to integrate.
//
// 0.08 white, down from the 0.12 this was first written for. Against the page
// outside at rgb(3.0) that renders at rgb(23) rather than rgb(33) — still a
// definite line, but a quiet one, and confined to a single pixel so it cannot
// wash anything whatever its opacity.
//
// That puts it within a hair of SHEET_RULE's 0.07 above. At 0.12 the panel's
// outline was plainly the heavier of the two; at 0.08 the edge of the sheet and
// the rule under its heading carry about the same weight, which is a choice
// rather than an oversight — nothing here is meant to outrank the content.
//
// A hairline is also the one treatment where lowering the opacity costs no
// crispness: there is no falloff to go hazy, so it stays a line all the way
// down. rgb(23) is roughly the floor at which it still reads on a dark panel.
//
// Uniform on every side ON PURPOSE, and this is the one thing that must not
// change. React Native draws a border from the layer's own corner radius as a
// single unbroken rounded rectangle only while all four sides share a colour;
// give one side its own and RN switches to drawing four separate edges and
// splits every corner arc between two of them. That is what broke the corners
// two rounds ago. A lit-from-above asymmetry is not available here at any
// price, and trying to fake it with a gradient is what this replaces.
//
// It is a sibling rather than a border on sheetShell so that adding it costs no
// layout: a border there would inset the content box by 1pt on every side.
const SHEET_EDGE = 'rgba(255,255,255,0.08)';

// THE SCRIM behind every glass surface. One value, three users: the archive
// sheet, the calendar sheet and the anchored dropdown panels, plus the profile
// sheet's backdrop. It was three different values before — 0.40, 0.35 and 0.72
// — which is exactly the drift this constant exists to stop.
const SHEET_SCRIM = 'rgba(0,0,0,0.40)';

// THE PROFILE SHEET'S OWN DENSITY, and it is deliberately NOT a second version
// of the material.
//
// GlassLayers is untouched and every surface still renders exactly it: one
// blur, one SHEET_FILL tint, spelled once. This is an EXTRA layer drawn on top
// of that pair inside the profile sheet only — composition rather than a fork,
// so there is still nothing to drift out of step. Adding a local layer cannot
// change what the shared one does.
//
// The profile sheet is the one surface that is nearly all text at reading
// weight, over the whole width of the screen, and it is the only one you sign
// in through. It wants to be a room rather than a window.
//
// 0.45 black over the shared 0.22 is an effective fill of
// 1 - (1 - 0.22)(1 - 0.45) = 0.57, which takes transmission from 35.6% to 19.6%
// and the ground from rgb(1.78) to rgb(0.98). Still glass, and still the same
// blur behind it — about half as much of the page gets through.
const PROFILE_FILL = 'rgba(0,0,0,0.45)';

// THE MATERIAL, as one component, so it cannot be spelled differently in two
// places. Every glass surface renders this pair behind its content and nothing
// else: the blur samples what is behind the surface, then the tint darkens the
// result.
//
// Both layers are position: absolute, which matters more here than it does in
// the sheets. The dropdown panel is measured by onLayout to decide whether it
// flips above its trigger, and Yoga skips absolutely-positioned children when
// it collects a container's flex lines — FlexLine.cpp continues past any child
// whose positionType is Absolute — so neither layer can contribute to the size
// the panel reports.
//
// dimezisBlurView is not optional on Android. expo-blur's own default is
// 'none', which paints a flat colour and no blur at all.
//
// EVERY glass surface goes through here: both centred sheets, the anchored
// dropdown panels and the profile sheet. The two sheets used to spell the pair
// out inline, which is the drift this exists to stop — there is no second copy
// of the material left to fall out of step.
//
// A fragment, so it contributes no host view of its own and the layers stay
// direct children of whatever renders them. The output is the same two views
// in the same order that each caller had before.
function GlassLayers() {
  return (
    <>
      <BlurView
        intensity={SHEET_BLUR}
        tint="systemChromeMaterialDark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, s.sheetTint]} pointerEvents="none" />
    </>
  );
}
// Rows fade up as the sheet arrives, each a little after the one above it.
// Expressed as FRACTIONS of the sheet's own 0->1 travel rather than as
// milliseconds, so the cascade is driven by the existing archiveAnim and cannot
// drift from it. Past ARCHIVE_ROW_MAX every row shares the last slot: a long
// list should not still be arriving after the sheet has settled.
const ARCHIVE_ROW_STAGGER = 0.07;
const ARCHIVE_ROW_FADE = 0.45;
const ARCHIVE_ROW_MAX = 6;
const ARCHIVE_ROW_RISE = 6;
// The backend accepts one day back (ROUTE_MAX_PAST_DAYS). A record older than
// that can only ever be refused, so it is never asked for. Kept slightly under
// two days so a local date one side of the server's UTC date still qualifies.
const REFRESH_MAX_PAST_MS = 36 * 60 * 60 * 1000;
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

// THE PROVIDER'S WORD -> THE WORD ON THE BADGE. Display only.
//
// STATUS_MAP on the backend collapses Expected, CheckIn, Boarding, GateClosed
// and Delayed into one mapped status, "scheduled", because five words is the
// right vocabulary for SORTING, countdowns, the archive rule and reminderTimes,
// all of which want to know what kind of thing a flight is doing rather than
// exactly what it is doing. That collapse is lossy in the one direction a
// traveller cares about: a flight at the gate and a flight an hour late both
// read SCHEDULED.
//
// So the badge — and only the badge — reads the raw word instead. Nothing
// branches on this map; it turns a string into a different string.
//
// KEYED LOWERCASE and looked up lowercased, so "EnRoute", "enroute" and
// "ENROUTE" all land. Both spellings of cancelled are here because the provider
// sends the American one and the app writes the British one everywhere else.
const BADGE_LABEL: Record<string, string> = {
  expected: 'SCHEDULED',
  checkin: 'CHECK-IN',
  boarding: 'BOARDING',
  gateclosed: 'GATE CLOSED',
  delayed: 'DELAYED',
  departed: 'DEPARTED',
  enroute: 'IN AIR',
  approaching: 'LANDING',
  arrived: 'LANDED',
  canceled: 'CANCELLED',
  canceleduncertain: 'CANCELLED',
  diverted: 'DIVERTED',
};

// A PURE FALLBACK. An absent or unrecognised raw status returns the uppercased
// display status, which is character-for-character what this badge rendered
// before the map existed — so a record saved before v10, and any word the
// provider adds tomorrow, renders exactly as it does today rather than blank.
function badgeLabel(rawStatus: string | null | undefined, fallback: string): string {
  const key = String(rawStatus ?? '').trim().toLowerCase();
  return BADGE_LABEL[key] ?? fallback.toUpperCase();
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
//
// TWO WAYS TO BE LATE, AND ONE ANSWER. This already promoted a scheduled flight
// to "delayed" off the delay minutes, and getStatusColor has had amber for
// "delayed" all along. The provider ALSO says so in words, as raw status
// "Delayed", and those two must not become two mechanisms: a second amber rule
// bolted on beside this one could paint a badge amber that this function still
// calls scheduled, and the card would then disagree with itself.
//
// So the raw word joins the arithmetic HERE, in the one place that decides what
// the card is showing. getStatusColor and getStatusBg keep their existing keys
// and gain no new case: they are handed "delayed" and already know that word.
//
// The minutes are tested first only because they are the stronger claim — a
// measured number rather than a label — and both roads lead to the same value,
// so the order changes nothing.
function displayStatus(
  status: string,
  departureDelay: number | null | undefined,
  rawStatus: string | null | undefined,
): string {
  if (status !== 'scheduled') return status;
  if (typeof departureDelay === 'number' && departureDelay > 0) return 'delayed';
  if (String(rawStatus ?? '').trim().toLowerCase() === 'delayed') return 'delayed';
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
  // NOT f.status, for the same reason flightLineSegments does not read it: a
  // record claiming to have landed before its own arrival time would fill this
  // bar completely, and a full bar is a stronger claim than the word beside it —
  // it says the flight is over. A demoted record reads 'scheduled' and the bar
  // sits at zero, which is what an unflown flight looks like. `now` was already
  // a parameter, so nothing new is threaded in to get this.
  const s = effectiveStatus(f, now);
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

// `effective` is the status AFTER the clock has had its say — see
// effectiveStatus. It is a parameter rather than something computed here because
// that rule takes a SavedFlight and this takes a response, and a DTO-shaped copy
// of it would be two implementations of one rule, free to drift.
//
// OMITTED MEANS NO CLOCK CHECK WAS MADE, and then everything below reduces to
// exactly what it did before the parameter existed: the response's own mapped
// status, and its raw word trusted. Callers that have no record to check
// against are unaffected.
function flightDataFromApi(data: any, effective?: string): FlightData {
  const dep = data?.departure ?? {};
  const arr = data?.arrival ?? {};
  const mapped = (data?.status || "unknown").toLowerCase();
  const effectiveMapped = effective ?? mapped;
  // The contradicted-raw-word rule, for the reason set out at length in
  // renderSavedFlight: a raw word the clock has just refuted is the same claim
  // in finer detail, not a second opinion, so it stops being evidence.
  const trustedRaw = effectiveMapped === mapped ? (data?.raw_status ?? null) : null;
  const status = displayStatus(effectiveMapped, dep.delay, trustedRaw);
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
    // The LABEL comes from the provider's word, the COLOUR from the mapped
    // status. They are allowed to differ: "BOARDING" in amber says the flight is
    // at the gate AND running late, which is two facts the old single grey
    // SCHEDULED could not carry.
    status: badgeLabel(trustedRaw, status),
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
// Shown when a row has no arrival time of any kind. An em dash says "not known"
// in the width of a glyph; the "N/A" that used to arrive here said it in the
// width of a word and read as an error rather than as a gap. The font already
// renders this dash elsewhere in the file at MONO_BOLD.
const ROUTE_NO_TIME = '\u2014';

// HOW MANY MISSING ARRIVALS ARE WORTH BUYING, per search. Each one is a
// flight-number lookup at 2 units, so this caps a search's extra spend at 6.
//
// Counted from the boards already on disk rather than guessed: whole-airport
// departure boards carry no arrival time on 1.6% to 6.3% of rows (6/384, 6/375,
// 18/394, 10/159). A route search filters that to at most 25 rows for one
// destination, and of eighteen cached result envelopes seventeen had none at
// all and one had a single row. So the ordinary answer is zero, sometimes one.
//
// 3 covers every case observed across about 1,300 rows with room to spare. Past
// that the board is not merely unlucky, it is anomalous — feed missing on the
// provider's side, most likely — and that is precisely when quietly spending 20
// units chasing it is the wrong thing to do. The extra rows keep their dash.
const ROUTE_FILL_MAX = 3;

// The local calendar date a row DEPARTS on, read from its own ISO rather than
// from the board's date: an undated board is a rolling twelve hours, so its late
// rows belong to tomorrow. Module scope because the fill effect needs it before
// the component's own copy is in scope, and both must agree — the date decides
// WHICH instance of a flight number gets fetched.
function routeDayOf(r: { departure_scheduled_iso: string | null }): string | null {
  const d = (r.departure_scheduled_iso ?? '').slice(0, 10);
  return ISO_DAY_RE.test(d) ? d : null;
}

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

// DELIBERATELY STILL FLAT, while the saved, archive and route rows became
// cards.
//
// The difference is what a row IS in each place. A saved row or a route row is
// one flight — a separate object, independently tappable, saveable, swipeable —
// and cards are how a list says "these are separate things". An InfoRow is one
// field of ONE flight: Terminal, Gate, Baggage Belt. They are a specification
// table, and the hairline between them separates data within a single object
// rather than one object from the next.
//
// Carding them would also nest a card in a card, since these already sit inside
// the flight card, and turn a dense readable table into a dozen floating
// blocks — twelve gaps of 8pt added to a section that is read by scanning down
// the labels.
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

// The status is the CALLER'S, not f.status. Re-reading the record here would let
// this pick the arrival endpoint for a row whose word says scheduled, which is
// precisely the disagreement effectiveStatus exists to remove.
function absoluteTime(f: SavedFlight, status: string): string {
  const s = status;
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
  // NOT f.status. A record claiming to have landed six hours before its own
  // arrival time would otherwise take the landed branch below, read the arrival
  // endpoint, and print a grey "landed" on a flight still sitting at the gate.
  const s = effectiveStatus(f, now);
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

  // Fallback: status · updated <age> [· dep|arr <absolute time>]
  const abs = absoluteTime(f, s);
  // WHAT THAT TIME IS. The same slot carries a scheduled departure on one row
  // and an arrival on the next, and unlabelled they are indistinguishable — a
  // bare "21:12" on a landed row and a bare "19:50" on a scheduled one look like
  // the same kind of fact and are not. Airport-board vocabulary, three
  // characters, because the row has to stay one line.
  //
  // Derived from the SAME branch absoluteTime takes, so the label can never name
  // an endpoint the time did not come from.
  const absLabel = s === 'landed' || s === 'active' ? 'arr' : 'dep';
  const tail = abs && abs !== 'N/A'
    ? ` · updated ${timeAgo(f.updatedAt, now)} · ${absLabel} ${abs}`
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

// WHEN A FLIGHT LEAVES THE LIST.
//
// Arrival, not departure: a long-haul that left eleven hours ago may still be
// in the air, and a list that drops it mid-flight is worse than useless.
//
// Six hours after it lands. The card is still worth having for a while after
// touchdown — the belt, the terminal, the actual arrival time — and a red-eye
// that lands at 06:00 should still be there over breakfast. Short enough that
// this morning's flight is gone before tomorrow's crowd the list.
const ARCHIVE_AFTER_ARRIVAL_MS = 6 * 60 * 60 * 1000;

// The instant a flight arrived, or is expected to. Actual first, then the
// estimate, then the schedule — the same precedence the status line uses.
function arrivalTs(f: SavedFlight): number | null {
  return zonedIsoToTs(f.to.actualIso ?? f.to.estimatedIso ?? f.to.scheduledIso, f.to.timezone);
}

// DERIVED, never stored, so there is no schema change and no migration.
//
// A stored flag would have to be recomputed on every read anyway — a flight
// crosses this line while the app is open, not while it is writing — so the
// flag would be a second answer to a question the arrival time already answers
// exactly, and the two could disagree.
//
// A record with no arrival ISO at all is NEVER archived. Those are pre-v3
// records; guessing that they are old enough to file away would hide a flight
// the user saved on purpose.
// HAS IT ACTUALLY FLOWN, which is a different question from whether it is in
// the archive: the archive waits six hours after arrival, this is true the
// moment the arrival time passes.
//
// Read from the CLOCK, never from f.status. A saved record's status only ever
// changes when a refresh returns a new one, and refreshes stop at 36 hours
// past — before that, the backend has no record of a flight that has landed and
// been cleared. So an archived flight's stored status is frozen at whatever it
// was the last time anyone asked, which for anything saved in advance is
// "scheduled" forever. The arrival time is the only thing here that is still
// true a week later.
function hasFlown(f: SavedFlight, now: number): boolean {
  const ts = arrivalTs(f);
  return ts !== null && ts <= now;
}

// THE STATUS TO DISPLAY AND SORT ON, which is not always the status stored.
//
// A stored record can contradict itself. A real one: status "landed", rawStatus
// "Arrived", arrival actualIso 2026-08-28T21:12+05:30 — written at 15:10 IST the
// same day, six hours before that arrival could have happened, with no actual or
// estimated departure time at all. Nothing in this app invents a status; it
// copies the response. So the app cannot treat a stored status as more reliable
// than the clock, and this is the same principle hasFlown states above, applied
// to the word on the row instead of to the archive.
//
// THE CLOCK MAY DEMOTE A STATUS, NEVER PROMOTE IT, and the asymmetry is the
// whole design.
//
// A TIME PASSING DOES NOT PROVE AN EVENT HAPPENED. A flight can sit an hour past
// its scheduled departure still at the gate, and a scheduled arrival can come
// and go while the aircraft is holding. Promoting on the clock would invent
// departures and landings that never occurred, which is exactly the failure this
// exists to correct, pointing the other way. So there is no promotion here at
// all: nothing is ever moved to "active" or "landed" by the clock.
//
// AN EVENT CANNOT HAVE HAPPENED BEFORE ITS OWN TIME. That is what makes
// demotion sound. If the record says a flight has landed and names an arrival
// instant still in the future, the two cannot both be true, and the instant is
// the one with a checkable meaning. Demoting to "scheduled" is the weakest claim
// that resolves the contradiction, and it is self-correcting: the next refresh
// that returns a coherent record restores the stored word.
//
// ONE NARROW, PROVABLE CONTRADICTION, deliberately. This is not a "does the data
// look plausible" check and must not grow into one — no missing-field heuristics,
// no delay-magnitude limits, no cross-field guessing. Two propositions that
// cannot both hold, and nothing else.
//
// AN UNREADABLE TIME IS NOT EVIDENCE. A null from zonedIsoToTs — a pre-v3 record
// with no ISO, a bad timezone — changes nothing, because absence of a time is
// not proof the status is wrong.
//
// DERIVED, NEVER STORED, exactly like hasFlown and isArchived. Nothing here
// writes back; a record's stored status is what the provider last said and stays
// that way.
function effectiveStatus(f: SavedFlight, now: number): string {
  const s = f.status.toLowerCase();
  if (s === 'landed') {
    // The same instant arrivalTs uses, so the row and the archive rule read one
    // arrival time rather than two.
    const ts = arrivalTs(f);
    if (ts !== null && ts > now) return 'scheduled';
  } else if (s === 'active') {
    // arrivalTs's precedence, mirrored onto the departure: actual, then the
    // estimate, then the schedule.
    const ts = zonedIsoToTs(
      f.from.actualIso ?? f.from.estimatedIso ?? f.from.scheduledIso, f.from.timezone);
    if (ts !== null && ts > now) return 'scheduled';
  }
  return s;
}

function isArchived(f: SavedFlight, now: number): boolean {
  // The hand overrules the clock, and only in one direction: archivedAt can put
  // a flight in the archive early, and clearing it hands the flight back to the
  // rule rather than pinning it out. See setFlightArchived.
  if (f.archivedAt !== null) return true;
  const ts = arrivalTs(f);
  return ts !== null && now - ts > ARCHIVE_AFTER_ARRIVAL_MS;
}

// ── SWIPE ACTIONS ────────────────────────────────────────────────────────────
//
// A FIXED 52 x 52 SQUARE, and the fix for buttons that looked squashed and
// misshapen at rest.
//
// The cause was that the button had no height of its own. swipeGroup carried
// alignItems: 'stretch', so every button took the height of the panel it sat
// in, and the panel is absoluteFillObject over the Swipeable's container. Three
// consequences, all of them visible:
//
//   1. The height came from the ROW, and rows are content-driven. A saved row
//      is about 62pt and an archive row about 72, so the same button rendered
//      roughly 58pt tall in one list and 68 in the other — against a fixed 66pt
//      width, which flips it from wider-than-tall to taller-than-wide between
//      two lists showing the same actions.
//   2. RADIUS 18 then reads differently on each. On a 58pt button it is a soft
//      rectangle; on a 40pt one — a row with a short second line — it is nearly
//      a capsule. The radius never changed; the shape under it did.
//   3. The container includes sf.row's marginBottom of 8, since the card gap is
//      inside the row's own box. So the panel was 8pt taller than the card and
//      the button was centred over card-plus-gap, sitting 4pt BELOW the card's
//      centre on every row.
//
// So: a fixed square, centred, and the group inset by the card's gap so that
// "centred" means centred on the CARD. The shape is now a decision rather than
// a by-product of whatever the row happens to contain.
//
// 52 because the glyph is 20 and 16pt of clearance on each side is what makes a
// tap target rather than an icon with a box drawn round it. It also clears the
// 44pt minimum comfortably. With the label gone there is nothing else to fit.
//
// The slot returns to 64: 52 of button and 6 of margin either side, which is a
// 12pt gutter between neighbours and a 6pt gap to the card. The panel is 128pt
// again, so the drag costs 147pt of finger to open and 221pt to arm the
// expansion, where the 72pt slots cost 166 and 202. Nineteen points more to
// arm, because a narrower panel leaves more of the distance to the overshoot's
// firmer friction; overshootFriction is the knob if that reads as too far.
// ── CARDS ────────────────────────────────────────────────────────────────────
//
// A row was a band of text with a hairline under it. It is now a shape.
//
// FILL rgba(255,255,255,0.03), which is already in the file as the pill
// triggers' background and composites over the page to about rgb(12). Seven
// levels above the page: enough to read as a raised surface, far too little to
// compete with anything written on it. The hairline goes with it — a card that
// is a distinct shape does not also need a line telling you where it ends.
//
// RADIUS 12, and the three radii in the app now read as a nesting order. The
// sheets are 16 because they are the largest shapes and hold everything else. A
// card is 12: smaller than its container, which is what stops a card inside a
// sheet looking like a sheet. The swipe buttons are 18, larger than either
// despite being the smallest things on screen, because they are CONTROLS rather
// than containers and roundness is how a control says so.
//
// GAP 8 between cards, which replaces the separator rather than adding to it.
//
// HEIGHT is unchanged, and slightly less. Every paddingVertical is exactly what
// it was — 13 on a saved row, 18 on an archive row and a route row — and the
// 1pt border has gone, so a row is 1pt SHORTER than before. The list is taller,
// but by the gaps between rows rather than by anything inside them.
//
// PADDING 14 horizontally, which the rows did not have at all: content used to
// run to the page's own margin. This is the one number that needed checking
// against the route rows, whose whole layout depends on the departure times
// starting at one x and the arrival times ending at another. It survives
// because every row takes the SAME padding, including the pinned "fastest" row
// above the list — the column moves inward by 14 as a block and stays a column.
// What does change is that the times no longer align with the group headings
// above them, which sit at the page margin. That is correct: the heading labels
// the cards, it is not one of them.
const CARD_FILL = 'rgba(255,255,255,0.03)';
const CARD_RADIUS = 12;
const CARD_GAP = 8;
const CARD_PAD = 14;

const SWIPE_SIZE = 52;
const SWIPE_MARGIN = 6;
const SWIPE_W = SWIPE_SIZE + SWIPE_MARGIN * 2;
// 18 on a 52pt square, which is now a fixed relationship rather than one that
// depended on the row. Short of 26, which would be a circle: a circle reads as
// a floating badge, and these are buttons in a row.
const SWIPE_RADIUS = 18;

// One button: a filled rounded rectangle with a glyph on it, and nothing else.
//
// THE LABEL IS GONE. It was 11pt of SANS under the icon, and it was doing two
// things badly: forcing the button wide enough to fit the longest word in the
// set, and putting a second element in a shape too small to hold two things
// comfortably. The icons are the same five the rest of the app already uses for
// these actions, and the gesture that reveals them is itself the explanation.
//
// `label` survives as the accessibility name, which is where the word was
// always doing its real work — a screen reader has no icon to look at.
//
// `colour` has gone with the text. The glyph strokes take their colour from
// ICON_* at module scope, which is where the fill and its ink are paired.
//
// `grow` is set only by ExpandAction, and switches the button from its fixed
// square to filling whatever width the expanding box has reached.
//
// `progress` is the library's own shared value for this panel: 0 closed, 1 open,
// and it is driven by the finger during the drag and by the release spring
// after it. Reading it here is what makes the contents arrive WITH the panel
// rather than sitting fully formed inside a widening window.
//
// Opacity leads the scale, on a bent curve: nothing for the first fifth of the
// travel, then up to full by the time the panel is open. A button that fades in
// from the very first pixel reads as a smear at the edge of the row; one that
// waits until the panel is unmistakably being opened reads as a reveal.
//
// The scale was removed for one round as a probe. The theory was that animating
// a transform over react-native-svg forces a per-frame re-composite and was
// what made the drag feel rough. Taking it out changed nothing, so the theory
// was wrong and the scale is back exactly as it was. Recorded here so nobody
// removes it again for the same reason.
function SwipeAction({
  label, fill, progress, grow: growSide, onPress, children,
}: {
  label: string; fill: string; progress: SharedValue<number>;
  grow?: 'left' | 'right';
  onPress: () => void; children: React.ReactNode;
}) {
  const grow = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.2, 1], [0, 0, 1], Extrapolation.CLAMP),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.72, 1], Extrapolation.CLAMP) },
    ],
  }));
  return (
    <TouchableOpacity
      style={[
        sf.swipeBtn,
        { backgroundColor: fill },
        growSide === undefined
          ? sf.swipeBtnFixed
          : growSide === 'right' ? sf.swipeBtnGrowRight : sf.swipeBtnGrowLeft,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Reanimated.View style={[sf.swipeInner, grow]}>
        <Svg width={20} height={20} viewBox="0 0 24 24">{children}</Svg>
      </Reanimated.View>
    </TouchableOpacity>
  );
}

// A SETTLE RATHER THAN A SNAP, replacing the library's release spring.
//
// Its default is mass 2, damping 1000, stiffness 700 — a damping ratio of about
// 13, which is so far overdamped that the row does not spring at all, it
// decelerates. This is mass 0.8, damping 26, stiffness 240, a ratio of 0.94:
// just inside critical, so it arrives quickly, slows into position and stops
// without ever crossing it. overshootClamping stays on as the guarantee.
// FULL-SWIPE EXPANSION, and none of it comes from the library.
//
// ReanimatedSwipeable has no expansion of any kind. Its leftThreshold and
// rightThreshold sound like this and are not: they only decide whether letting
// go OPENS the panel or lets it shut, and default to half the panel's width.
// What it does give is everything needed to build it — renderRightActions is
// handed (progress, translation, swipeableMethods), where translation is the
// row's live offset in points, and onSwipeableWillOpen fires on release.
//
// So: watch translation, expand past a threshold, and intercept the release.
//
// 0.5 OF THE ROW WIDTH. Proportional rather than absolute so it holds on any
// screen, and a half because that is where the gesture stops being ambiguous:
// the panel itself is 128pt of a 320pt row, so the threshold sits a clear 32pt
// beyond a fully open panel — far enough that nobody reaches it while merely
// opening the actions, close enough to reach without a second stroke.
const EXPAND_AT = 0.5;


// THE TAP AT THE THRESHOLD, in both directions.
//
// Medium, and the same in both. It is one boundary, so arming and disarming
// should feel identical — a different weight on the way back would read as two
// different events rather than one line being crossed twice. Light is the
// obvious alternative and is the right choice on iOS, but it is close to
// imperceptible on a good deal of Android hardware, and a threshold you cannot
// feel is a threshold that is not there.
//
// Fired and forgotten: impactAsync returns a promise nobody waits on, and a
// device without a taptic engine simply does nothing. The catch is there
// because an unhandled rejection would be a crash over a vibration.
const EXPAND_HAPTIC = () => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
};

// The outermost action, and the only one that can expand.
//
// It is always the outermost by construction rather than by choice: expansion
// belongs to whatever sits against the screen edge, and in both panels that is
// the real action, never a placeholder. Right panel: delete. Left panel:
// archive on the saved list, restore in the archive.
//
// `side` says which edge to stay pinned to as the box grows, so the glyph
// travels with the row's leading edge instead of drifting to the middle of an
// expanding rectangle.
//
// `others` is the total width of the buttons BESIDE this one in the same panel:
// 64 where a placeholder shares the panel, 0 where this is the only action. It
// is what stops the expansion starting before the panel is even open — see the
// width calculation below.
function ExpandAction({
  side, translation, rowW, others, onCross, children,
}: {
  side: 'left' | 'right';
  translation: SharedValue<number>;
  rowW: SharedValue<number>;
  others: number;
  onCross: (on: boolean) => void;
  children: React.ReactNode;
}) {
  // 1 past the threshold, 0 short of it. A derived value rather than state, so
  // the whole comparison stays on the UI thread with the gesture.
  const armed = useDerivedValue(() => {
    const travelled = side === 'right' ? -translation.value : translation.value;
    return rowW.value > 0 && travelled >= rowW.value * EXPAND_AT ? 1 : 0;
  });

  // THE BOX TRACKS WHAT IS REVEALED, and this is the fix for the expanded
  // button running flush against the card.
  //
  // It used to animate to rowW — the whole row's width — the moment the
  // threshold was crossed. But the row has only translated as far as the finger
  // took it, so a box that wide ran on underneath the card: the button's inner
  // edge, its margin and its two right-hand corners were all hidden behind the
  // row, and what was left looked like a rectangle butted against it.
  //
  // The width is now exactly the strip the row has uncovered, less whatever the
  // other buttons in the panel occupy. So the box always ends where the card
  // begins, the button's own 6pt margin holds the gap open, and all four
  // corners stay on screen at every point in the drag. It is a symmetrical
  // rounded rectangle that grows, rather than a shape that is progressively
  // eaten by the row.
  //
  // No withTiming: the width follows the finger directly. There is nothing to
  // ease, because the thing it tracks is already exactly where the finger is,
  // and on release the row's own spring carries the width home with it.
  //
  // The consequence worth naming: the button no longer JUMPS to full width when
  // the threshold is crossed, it simply keeps growing. Nothing visual marks the
  // crossing any more — the haptic does, and it is the same boundary it always
  // was. Keeping the jump would mean filling the row, and filling the row is
  // what leaves no gap.
  const box = useAnimatedStyle(() => {
    const travelled = side === 'right' ? -translation.value : translation.value;
    return { width: Math.max(SWIPE_W, travelled - others) };
  });
  // The only crossing to the JS thread in the whole gesture, and it fires twice
  // per swipe at most: once on arming, once on disarming.
  useAnimatedReaction(
    () => armed.value,
    (curr, prev) => {
      if (prev !== null && curr !== prev) runOnJS(onCross)(curr === 1);
    },
  );

  return (
    <Reanimated.View
      style={[sf.swipeExpand, side === 'right' ? sf.swipeExpandRight : sf.swipeExpandLeft, box]}
    >
      {/* No separate tint layer any more. The button inside is itself a filled
          shape, so growing this box grows the fill — there is nothing left to
          fade in behind it. */}
      {children}
    </Reanimated.View>
  );
}

// THE COMMIT: past the threshold the row carries on and leaves.
//
// 240ms and a full screen width, unchanged. The EASING is what changed, and it
// was the whole of why this felt laggy.
//
// It was EASE_IN — bezier(0.4, 0, 1, 1) — on the reasoning that the row is
// already moving and should not appear to stop first. The reasoning was right
// and the curve was the exact opposite of it, because the exit does not act
// alone: the library's own spring is simultaneously pulling the row BACK from
// wherever the finger left it to the panel's 128pt, and that spring is fastest
// at the start. Released at about 200pt, that is 72pt of retreat, and against an
// ease-in the first frames are a stalemate:
//
//   t=33ms   spring back 8.3pt   exit forward 10.7pt   NET  2.4pt
//   t=50ms   spring back 15.9    exit forward 22.8     NET  6.9
//   t=83ms   spring back 31.4    exit forward 55.7     NET 24.3
//
// Two and a half points in the first two frames is not slow, it is stationary.
// The row appears to hang at the release point and then leave, which is exactly
// what "laggy" describes — and no amount of moving the animation between
// threads would have touched it, because nothing was late. It was cancelled.
//
// out-cubic instead, which is fastest where the spring is:
//
//   t=33ms   spring back 8.3pt   exit forward 114.7pt  NET 106.4pt
//
// The row is a third of the way off the screen before the spring has taken back
// nine points. It leaves the instant it is let go.
const EXIT_MS = 240;
// Reanimated's Easing, not React Native's. The two are not interchangeable: a
// withTiming curve is evaluated on the UI thread and has to be a worklet, and
// the file's EASE_IN and EASE_OUT are ordinary JS functions belonging to the
// other animation system.
const EXIT_TIMING = { duration: EXIT_MS, easing: REasing.out(REasing.cubic) } as const;
const EXIT_BACK_TIMING = { duration: EXIT_MS, easing: REasing.out(REasing.cubic) } as const;

// THE CONFIRMATION, and it REPLACES the toast rather than joining it.
//
// There was already one: an Animated.Text inside the flight card's header,
// 11pt SANS, opacity only, saying "saved" or "unsaved". Its problem was where
// it lived — inside the card block, which is not on screen when the saved list
// is, and not on screen at all behind the archive sheet. A swipe on a row could
// never have shown it. So the same showToast, the same call sites, the same one
// mechanism, moved to the root and given a surface.
//
// 220 in, 1700 held, 260 out: about 2.2 seconds end to end, which is long
// enough to read a flight number and a verb without becoming something waited
// on. The old one held 900 and had four characters to carry.
// The three steps run as ONE Reanimated sequence rather than an
// Animated.sequence, and that is the fix rather than the driver.
//
// Both steps of the old one were useNativeDriver: true, so each ran on the UI
// thread — but AnimatedImplementation's sequenceImpl chains them in JavaScript:
// its onComplete is a JS callback that calls start() on the next step. So the
// end of the fade-in and the end of the 1700ms hold were both JS-thread events,
// and they arrive at the worst possible moment: right after a committed swipe,
// when the JS thread is running a storage write and re-rendering the list. The
// hold ran long and the fade-out began late, which is the lag.
//
// withSequence has no such boundary. The whole in-hold-out is described once
// and evaluated on the UI thread from beginning to end, so a busy JS thread can
// delay when it STARTS but can no longer stretch it in the middle.
const TOAST_IN_MS = 220;
const TOAST_HOLD_MS = 1700;
const TOAST_OUT_MS = 260;
// It arrives from above and leaves the same way, 12pt of travel. Small on
// purpose: it is a notice, not an entrance.
const TOAST_RISE = 12;

const SWIPE_SPRING = {
  mass: 0.8,
  damping: 26,
  stiffness: 240,
  overshootClamping: true,
} as const;

// FILLS, and the ink that sits on them. Every value is an opacity of a ramp
// already in the file.
//
// The red at 0.7 rather than the 0.55 the strokes used. Over the page it
// composites to rgb(175,81,81), which is solid enough to read as a
// painted button while staying inside this app's muted register — a fully
// opaque 248,113,113 would be the brightest thing on any screen it appears on.
//
// CONTRAST, since the ink now sits on a fill rather than on black. White on
// that red is 5.1:1, which carries an 11pt label comfortably. Going the
// other way is worth knowing: raising the red towards opaque makes it LIGHTER
// over a black page and the white on it worse — 0.9 would drop to 3.3:1.
//
// The grey at 0.12 composites to rgb(32), twenty-seven levels above the
// page, which is enough to read as a shape without competing with the row. The
// ink on it is #e2e2e2, the file's existing near-white, at 12.6:1.
const SWIPE_FILL_RED = 'rgba(248,113,113,0.7)';
const SWIPE_FILL_DIM = 'rgba(226,226,226,0.12)';
const SWIPE_INK_RED = '#ffffff';
const SWIPE_INK_DIM = '#e2e2e2';

// The reminder indicator on a saved row. ARCHIVE_ICON's grey, which is the
// file's existing dim ink for a glyph sitting on the page rather than on a
// fill.
//
// NOT #4ade80, deliberately. Green means live and actionable here — an active
// flight, a countdown that is running. A pending reminder is neither: it is a
// note about something that has not happened, and colouring it green would put
// it in the same visual class as a flight in the air.
const REMIND_DOT = ARCHIVE_ICON;

// THE GLYPHS, as module constants rather than JSX rebuilt inside the row.
//
// Twelve Path elements across the four buttons, every one of them static, and
// every one of them was allocated afresh on each render of each row. Built once
// here they are the same objects for the life of the process, which also lets
// React bail out of reconciling them.
const ICON_NOTIFY = (
  <>
    <Path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinejoin="round" />
    <Path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
const ICON_DELETE = (
  <>
    <Path d="M19 5 5 19" fill="none" stroke={SWIPE_INK_RED} strokeWidth={1.75} strokeLinecap="round" />
    <Path d="M5 5 19 19" fill="none" stroke={SWIPE_INK_RED} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
const ICON_RESTORE = (
  <>
    <Path d="M12 19V7" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
    <Path d="M6 13l6-6 6 6" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
  </>
);
const ICON_ARCHIVE = (
  <>
    <Path d="M3 5h18v4H3z" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M5 9v10h14V9" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M10 13h4" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
const ICON_REMIND = (
  <>
    <Path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M12 7v5l3 2" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
  </>
);

// PLACEHOLDERS. They render, they are tappable, and they deliberately do
// nothing: there is no notification scheduling in this app yet and no reminder
// store. They are here so the gesture's shape is settled before the features
// land. Do not wire either to a toast or an alert to make them feel finished —
// silence is the honest response until they do something.
//
// At module scope so it is one function rather than one per row per render.
const notImplemented = () => {};

// `now` for effectiveStatus, and for nothing else: the keys themselves are
// absolute instants and do not move with the clock.
function savedSortKey(f: SavedFlight, now: number): { rank: number; when: number } {
  // The same word the row shows. Keyed on f.status, a wrongly-landed flight
  // ranks RANK_LAST and sinks under everything real; keyed on this it ranks as
  // the scheduled flight it actually is and returns to its place in the list.
  const s = effectiveStatus(f, now);
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
function sortSavedByRelevance(list: SavedFlight[], now: number): SavedFlight[] {
  return [...list].sort((a, b) => {
    const ka = savedSortKey(a, now);
    const kb = savedSortKey(b, now);
    return ka.rank !== kb.rank ? ka.rank - kb.rank : ka.when - kb.when;
  });
}

// Lifted out of the parameter list so the memo comparison below can name it,
// and so the two cannot describe different shapes.
type SavedFlightRowProps = {
  flight: SavedFlight;
  onPress: () => void;
  onUnsave: () => void | Promise<void>;
  now: number;
  // Set only inside a sheet. The main list is a dense column against the page
  // and reads correctly at 13; the same density inside a panel with 20 of
  // padding on every side looks cramped against its own container. One row
  // component, two rhythms, chosen by the caller that knows which it is in.
  roomy?: boolean;
  // Drops this row's separator. Every row draws a hairline UNDER itself, which
  // is right for all of them but the last: there it rules off against nothing,
  // and inside the archive sheet it floats in the 20pt of padding below the
  // list looking like a row that failed to render.
  //
  // The caller decides, because only the caller knows what the list is. Both
  // lists that use this row are a plain map over a sorted array, so both can
  // answer it with the index they already have.
  last?: boolean;
  // Rendered inside the archive sheet. Changes what the second line says and
  // nothing else: the number, the cities and the date are the same row.
  //
  // The archive's second line is the single word "landed" and no more. The
  // countdown and the "updated N ago" that StatusLine renders are both live
  // readings, and neither means anything for a flight that is finished — a
  // countdown to a departure that happened last March, and an update age that
  // only ever grows because nothing will ever update it again.
  archived?: boolean;
  // Sets or clears archivedAt. Both lists pass it; what the row does with it
  // differs, which is decided below rather than by the caller.
  //
  // Both of these return void or a promise: the call sites are async arrows, and
  // the commit awaits whatever comes back so that a storage failure can put the
  // row back rather than leaving it flown off screen and still in the list.
  onArchive: (archived: boolean) => void | Promise<void>;
  // Raised after a committed swipe, once the action has actually succeeded.
  onDone: (message: string) => void;
  // Turns reminders on or off and RETURNS THE MESSAGE to show.
  //
  // The message is the caller's because only the caller knows the outcome:
  // permission refused, no times left to schedule, or done. The row flips a
  // label and reports what it is told, which keeps `email`, the store and the
  // scheduler out of a component that renders one flight.
  onRemind: (on: boolean) => Promise<string>;
};

// WHAT COUNTS AS THE SAME ROW: the five data props, by identity, and the
// callbacks deliberately NOT.
//
// EVERYTHING ON THE FLIGHT RIDES ON `a.flight` — archivedAt, remindersSetAt and
// anything added later. The store returns new objects on every write, so a row
// whose reminder state changed is never the same reference and the first
// comparison has already failed. Do not add flight.<field> lines here: they can
// only ever be reached when the identity check passed, which means the field is
// equal too.
//
// Every call site builds its handlers as inline arrows inside a .map, so they
// are new functions on every parent render; comparing them would defeat the
// memo entirely. Excluding them is safe in the one way that matters — anything
// they read that could actually change, the email or the stored list, also
// replaces the flight objects, and the flight IS compared.
//
// WHAT THIS DOES NOT FIX, and it is worth being exact because it was the
// original suspicion: it does NOT stop the 60-second tick re-rendering every
// row. `now` genuinely changes on every tick and the countdowns genuinely
// depend on it, so the row must re-render. What makes the tick affordable is
// the formatter cache above, not this. What this stops is the other forty-six
// pieces of state in the screen — a route search, a toast, a dropdown opening —
// dragging every saved row through a render that would change nothing.
function sameRow(a: SavedFlightRowProps, b: SavedFlightRowProps): boolean {
  return a.flight === b.flight
    && a.now === b.now
    && a.roomy === b.roomy
    && a.last === b.last
    && a.archived === b.archived;
}

const SavedFlightRow = memo(function SavedFlightRow({
  flight,
  onPress,
  onUnsave,
  now,
  roomy,
  last,
  archived,
  onArchive,
  onDone,
  onRemind,
}: SavedFlightRowProps) {
  const swipe = useRef<SwipeableMethods>(null);
  // Every action closes the row first. Leaving it open behind a modal or a
  // vanished row is the standard way this control goes wrong.
  //
  // Stable: it captures nothing but the ref, whose identity never changes.
  const act = useCallback((fn: () => void) => () => { swipe.current?.close(); fn(); }, []);

  // The row's own width, measured once by onLayout and read on the UI thread.
  // The threshold is a fraction of it, so it cannot be a constant.
  const rowW = useSharedValue(0);

  // WHICH SIDE IS ARMED, in JS, because the release handler is a JS callback.
  //
  // A ref rather than state on purpose: arming must not re-render the row
  // mid-drag, and nothing on screen reads this — the expansion itself is driven
  // entirely by the shared value inside ExpandAction.
  const armedSide = useRef<'left' | 'right' | null>(null);
  const onCrossRight = useCallback((on: boolean) => {
    armedSide.current = on ? 'right' : null;
    EXPAND_HAPTIC();
  }, []);
  const onCrossLeft = useCallback((on: boolean) => {
    armedSide.current = on ? 'left' : null;
    EXPAND_HAPTIC();
  }, []);

  // The row's own exit, on top of whatever the Swipeable is doing underneath.
  //
  // A separate wrapper rather than the library's translation, because the
  // library owns that value and clamps it to the panel: there is no way to ask
  // it to keep going. This transform composes with it — the Swipeable is still
  // settling its 128pt while the wrapper is carrying the whole thing off.
  //
  // A REANIMATED shared value now rather than an Animated.Value. The previous
  // one was already useNativeDriver: true, so the animation itself was on the
  // UI thread either way; what this removes is the system boundary. The drag,
  // the expansion and now the exit are all shared values evaluated in the same
  // place, so there is one animation model in this component rather than two
  // meeting at the moment of release.
  const exitX = useSharedValue(0);
  const exitStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: exitX.value }],
  }));

  // The JS half of the commit: the storage write, the message, and the retreat
  // if it fails. Split out because a worklet cannot await, and declared BEFORE
  // onWillOpen because that hook names it in its dependency list, which is
  // evaluated the moment the line is reached rather than when the row is swiped.
  //
  // ON COMPLETION, not at the start. Firing at the start races the state update
  // against the animation: the row is removed from the list, this component
  // unmounts, and the exit is cut off part-way at whatever moment the storage
  // write happens to land. Waiting makes the sequence the same every time — the
  // row goes, then the list closes up behind it.
  const commit = useCallback(async (side: 'left' | 'right') => {
    try {
      if (side === 'right') {
        await onUnsave();
        onDone(`${flight.flightNumber} deleted`);
      } else if (archived) {
        await onArchive(false);
        onDone(`${flight.flightNumber} restored`);
      } else {
        await onArchive(true);
        onDone(`${flight.flightNumber} moved to archive`);
      }
    } catch {
      // IF THE ACTION FAILS the row comes back, because it is still in the list
      // and an invisible row that is still there is the worse outcome by some
      // distance. Writing a shared value from JS is allowed and the animation
      // runs on the UI thread from there; nothing about the failure path
      // depended on being inside the old callback. No message is raised —
      // nothing happened, so nothing is claimed.
      exitX.value = withTiming(0, EXIT_BACK_TIMING);
      swipe.current?.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived, onUnsave, onArchive, onDone, flight.flightNumber]);

  // THE RELEASE. onSwipeableWillOpen fires the moment the row is let go and
  // starts animating open, which is the last point at which the panel can be
  // told not to.
  //
  // Armed means the finger went past the threshold and did not come back, so
  // the row COMMITS. Not armed — including the case where the user crossed the
  // threshold and dragged back before letting go, which disarms on the way past
  // — means this does nothing at all and the panel settles open exactly as it
  // did before.
  const onWillOpen = useCallback(() => {
    const side = armedSide.current;
    if (side === null) return;
    armedSide.current = null;

    // The row LEAVES rather than snapping back. It used to close() first and
    // fire the action after, which played the gesture in reverse before
    // anything happened — the reading was "that was undone", not "that was
    // done". It now continues the way it was thrown.
    const dir = side === 'right' ? -1 : 1;
    exitX.value = withTiming(
      dir * Dimensions.get('window').width,
      EXIT_TIMING,
      // HOW COMPLETION FIRES, now that the animation lives on the UI thread: the
      // callback is a worklet, invoked there, and runOnJS is what carries the
      // decision back to JavaScript to do the async work. It is one hop, at the
      // end, when nothing is animating — as against the old Animated.timing
      // callback, which was a JS function the native driver had to call back
      // into for the same purpose.
      (finished) => {
        'worklet';
        if (finished) runOnJS(commit)(side);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit]);

  // SWIPING LEFT drags the row leftward and uncovers the panel on its right,
  // which is what renderRightActions names. Delete sits outermost, at the
  // screen edge, where iOS Mail puts it.
  //
  // MEMOISED, because the library wraps its own leftElement/rightElement in a
  // useCallback keyed on these two props. An inline arrow is a new function on
  // every render, which busts that cache and remounts BOTH action panels —
  // every Svg in them — whenever the row renders for any reason at all.
  //
  // The dependencies mirror sameRow rather than listing the callbacks, and for
  // the same reason it excludes them: they are rebuilt on every parent render,
  // so depending on them would make this a no-op.
  const renderRight = useCallback((progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.swipeGroup}>
      {/* Nothing to notify about once a flight has landed, so the archive
          keeps only the destructive half of this panel. */}
      {!archived && (
        <SwipeAction label="notify" fill={SWIPE_FILL_DIM} progress={progress} onPress={act(notImplemented)}>
          {ICON_NOTIFY}
        </SwipeAction>
      )}
      {/* notify shares this panel unless the row is archived, in which case
          delete is alone in it. */}
      <ExpandAction side="right" translation={translation} rowW={rowW} others={archived ? 0 : SWIPE_W} onCross={onCrossRight}>
        <SwipeAction label="delete" fill={SWIPE_FILL_RED} progress={progress} grow="right" onPress={act(onUnsave)}>
          {ICON_DELETE}
        </SwipeAction>
      </ExpandAction>
    </View>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [archived, act, onCrossRight]);

  // SWIPING RIGHT uncovers the panel on the left.
  //
  // In the archive this is restore, and it appears only for a flight that was
  // archived by hand AND has not flown. Offering it on a flight that genuinely
  // landed would be a button that does nothing visible: clearing archivedAt
  // hands the row back to the arrival-time rule, which puts it straight back.
  const canRestore = archived && flight.archivedAt !== null && !hasFlown(flight, now);
  // useMemo rather than useCallback: on an archive row with nothing to restore
  // this is deliberately undefined, and useCallback's signature takes only a
  // Function. The value being memoised happens to be a function; that is not
  // the same thing.
  const renderLeft = useMemo(
    () => archived
      ? (canRestore
          ? (progress: SharedValue<number>, translation: SharedValue<number>) => (
              <View style={sf.swipeGroup}>
                {/* restore is the only action in the archive's left panel. */}
                <ExpandAction side="left" translation={translation} rowW={rowW} others={0} onCross={onCrossLeft}>
                  <SwipeAction label="restore" fill={SWIPE_FILL_DIM} progress={progress} grow="left" onPress={act(() => onArchive(false))}>
                    {ICON_RESTORE}
                  </SwipeAction>
                </ExpandAction>
              </View>
            )
          : undefined)
      : (progress: SharedValue<number>, translation: SharedValue<number>) => (
          <View style={sf.swipeGroup}>
            {/* remind shares this panel. */}
            <ExpandAction side="left" translation={translation} rowW={rowW} others={SWIPE_W} onCross={onCrossLeft}>
              <SwipeAction label="archive" fill={SWIPE_FILL_DIM} progress={progress} grow="left" onPress={act(() => onArchive(true))}>
                {ICON_ARCHIVE}
              </SwipeAction>
            </ExpandAction>
            {/* The label is the state. "remind" when there is nothing set and
                "cancel" when there is, so the button says what pressing it will
                do rather than what it is about. Second in the panel, so it can
                never be the one that expands — a destructive-feeling toggle
                should not be reachable by a full swipe. */}
            <SwipeAction
              label={flight.remindersSetAt === null ? 'remind' : 'cancel'}
              fill={SWIPE_FILL_DIM}
              progress={progress}
              onPress={act(async () => {
                onDone(await onRemind(flight.remindersSetAt === null));
              })}
            >
              {ICON_REMIND}
            </SwipeAction>
          </View>
        ),
    // remindersSetAt is a dependency because the left panel renders the label
    // that reads it. Without it the button would keep saying "remind" after the
    // reminder was set, until something else re-rendered the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archived, canRestore, act, onCrossLeft, flight.remindersSetAt, onRemind],
  );

  return (
    // The x stays. This is an addition, so the one control that is visible
    // without knowing the gesture exists is the one that must not move.
    //
    // RESISTANCE, in two grades, because the drag has two regions.
    //
    // friction 1.15 across the whole drag. The row is applied as
    // `userDrag / friction`, so it travels at 87% of the finger: enough lag to
    // feel like something is being pulled, not enough to feel weighed down. The
    // 128pt panel now costs 147pt of finger instead of 128.
    //
    // overshootFriction 2 past the open panel, where the row moves at half the
    // finger. This is the firmer grade, and it is what makes the panel's own
    // width feel like a detent rather than a place the row happens to be
    // passing. The docs suggest 8 or above "for a native feel", which is right
    // when the space past the panel is dead; here it holds the expansion
    // threshold, so 8 would put that threshold 256pt of finger further out and
    // make the gesture a two-stroke affair. At 2 the threshold sits at 221pt of
    // travel on a 320pt row — one comfortable stroke, and 61pt more than the
    // 160 it cost when the row was free.
    //
    // 1 was the previous value for both, which is the library's default and
    // means no resistance anywhere: the row was simply under the finger, and
    // past the panel it kept going as if nothing were attached to it.
    //
    // OVERSHOOT IS BACK ON, which is the library's own default and which it
    // expresses by omission: overshootLeft ?? leftWidth > 0.
    //
    // It was off on the reasoning that letting the row be pulled past the panel
    // promises a full swipe that does not exist. It exists now, so the reasoning
    // inverts: the travel past the panel is where the expansion threshold lives,
    // and without overshoot the row hits a wall at 128pt and the threshold at
    // half the row width is unreachable. The rubber band is not decoration here,
    // it is the only way to get to the gesture.
    //
    // overshootFriction is left at its default of 1, which is no friction at
    // all. The docs suggest 8 or above "for a native feel", and that is right
    // when the region past the panel is dead space to be resisted. Here it is
    // functional, so resisting it would be resisting the gesture: at 8, reaching
    // a threshold 32pt beyond the panel would cost 256pt of extra finger.
    //
    // childrenContainerStyle carries the background: it is the layer the library
    // translates, so the fill travels with the row and occludes the panel it is
    // sliding over. See rowSurface.
    // The wrapper the commit animates, outside the Swipeable because the
    // library owns the translation inside it. No style of its own beyond the
    // transform, so it costs nothing until a row is actually thrown.
    <Reanimated.View style={exitStyle}>
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.15}
      overshootFriction={2}
      animationOptions={SWIPE_SPRING}
      onSwipeableWillOpen={onWillOpen}
      childrenContainerStyle={sf.rowSurface}
      renderLeftActions={renderLeft}
      renderRightActions={renderRight}
    >
    <TouchableOpacity
      style={[sf.row, roomy && sf.rowRoomy, last && sf.rowLast]}
      onPress={onPress}
      activeOpacity={0.7}
      // The children container is exactly the row's width, so this is the
      // width the expansion fills and the width the threshold is a fraction of.
      onLayout={e => { rowW.value = e.nativeEvent.layout.width; }}
    >
      <View style={sf.line1}>
        <Text style={sf.number}>{flight.flightNumber}</Text>
        {/* ICON_REMIND's path data at 11pt, not the element itself: that
            constant strokes in SWIPE_INK_DIM, which is the ink for a glyph
            sitting on a filled button and is far too bright for a mark on the
            page. The stroke is thickened to 2.25 because 1.75 in a 24-unit
            viewBox drawn at 11pt is a hairline that disappears. */}
        {flight.remindersSetAt !== null && (
          <Svg width={11} height={11} viewBox="0 0 24 24" style={sf.remindMark}>
            <Path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18" fill="none" stroke={REMIND_DOT} strokeWidth={2.25} />
            <Path d="M12 7v5l3 2" fill="none" stroke={REMIND_DOT} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        )}
        {/* Cities, not codes. "Bangalore → Delhi" says where the flight goes to
            someone who does not read IATA, which is most people. city arrived in
            schema v5, so a record older than that carries null and falls back to
            the code it has always shown.

            At 320pt the row leaves 149.6pt here — nineteen characters of 13pt
            JetBrains Mono — which covers most pairs. A longer one ellipsizes in
            the MIDDLE rather than at the end, because losing the destination
            entirely is worse than losing the middle of both names. numberOfLines
            holds it to one line, so the row's height is unchanged either way. */}
        <Text style={sf.route} numberOfLines={1} ellipsizeMode="middle">
          {`${flight.from.city || flight.from.iata} → ${flight.to.city || flight.to.iata}`}
        </Text>
        {/* Two instances of one number are otherwise identical rows telling
            apart only by a countdown. The route text flexes, so this sits hard
            against the × on the right — a column of dates down the list rather
            than a value that drifts with the length of the route beside it.
            Hidden entirely when the date is not one: a pre-v3 record filed
            under "unknown" has nothing truthful to show here. */}
        {/* routeDateLabel, not routeShortDate: "Sat 29 Aug" rather than "29 Aug".
            It already exists for the applied-date line above the route list, so
            the weekday is spelled the same way in both places by construction.

            WIDTH, at 320pt. JetBrains Mono advances 0.6em, so 11pt is 6.6pt a
            character and this date is 10 of them, 66pt. The other cells on the
            line are the number and an 8pt gap, both fixed, so everything else
            is the route text.

            The × used to sit here too and took 24pt with it — a 20pt glyph is
            12pt of advance, plus 12pt of padding — all of which has gone back
            to the route.

            THE ROW DOES NOT GET TALLER, and cannot. The route already carries
            numberOfLines={1} with ellipsizeMode="middle", so it absorbs the
            loss by ellipsizing further into the middle of the pair rather than
            by wrapping — "Bangalore → Delhi" still fits, "Thiruvananthapuram →
            Chandigarh" loses more of its middle than it did. The date itself is
            numberOfLines={1} and unflexed, so it keeps its intrinsic width and
            never wraps either. Losing the middle of a route the heading does
            not repeat is the cost; telling two instances of one flight number
            apart by more than a bare number is what it buys. */}
        {ISO_DAY_RE.test(flight.flightDate) && (
          <Text style={sf.date} numberOfLines={1}>{routeDateLabel(flight.flightDate)}</Text>
        )}
      </View>
      {/* Two second lines, and which one shows is decided by the clock rather
          than by the record. A row in the archive whose arrival has passed is
          finished, so it says so and stops there; anything else keeps the live
          line, which is what a manually archived future flight still needs. */}
      {archived && hasFlown(flight, now) ? (
        <Text style={sf.landed}>{'landed'}</Text>
      ) : (
        <StatusLine f={flight} now={now} numberOfLines={1} style={{ marginTop: 4 }} />
      )}
    </TouchableOpacity>
    </ReanimatedSwipeable>
    </Reanimated.View>
  );
}, sameRow);

const sf = StyleSheet.create({
  row: {
    paddingVertical: 13,
    paddingHorizontal: CARD_PAD,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    marginBottom: CARD_GAP,
  },
  // Applied after sf.row, so it is this paddingVertical that survives.
  rowRoomy: { paddingVertical: 18 },
  // Last in its list. It used to drop the hairline; now it drops the gap, which
  // is the same job — the list ends where its last card ends rather than eight
  // points of nothing later.
  rowLast: { marginBottom: 0 },
  line1: { flexDirection: 'row', alignItems: 'center' },
  number: { fontSize: 13, color: '#ffffff', fontFamily: MONO_BOLD },
  // Against the number, not the route: it is a fact about this flight rather
  // than about where it goes.
  remindMark: { marginLeft: 6 },
  // Deliberately outside the type scale: this is a hit target, not text.
  chevron: { fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)' },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // detailsTitle carries marginBottom: 10, so the chevron beside it needs the
  // same or the two sit on different baselines.
  headingTap: { flexDirection: 'row', alignItems: 'center' },
  chevronLeft: {
    fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)',
    marginRight: 8, marginBottom: 10,
  },
  // marginBottom matches detailsTitle's, so the icon shares the heading's
  // baseline. The collapsed line has no such offset, hence the second style.
  archiveBtn: { marginBottom: 10 },
  archiveBtnCollapsed: { paddingLeft: 12 },
  noneActive: {
    fontSize: 11, color: 'rgba(226,226,226,0.4)', fontFamily: SANS,
    paddingVertical: 10,
  },
  collapsedRow: { flexDirection: 'row', alignItems: 'center' },
  collapsedLine: { paddingVertical: 10, flex: 1 },
  collapsedNumber: { fontFamily: MONO, fontSize: 11, color: '#ffffff' },
  collapsedDim: { fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.45)' },
  route: { fontSize: 13, color: 'rgba(226,226,226,0.6)', fontFamily: MONO, flex: 1, marginLeft: 12 },
  // Supporting detail, so a step down in size and two steps down the grey ramp
  // from the route beside it. Same 11pt mono the codes line under the route
  // heading uses.
  // MONO_BOLD and a step up the ramp: with two instances of one number in the
  // list this is what tells them apart, so it had to stop whispering.
  date: { fontSize: 11, color: 'rgba(226,226,226,0.6)', fontFamily: MONO_BOLD, marginLeft: 8 },
  updated: { color: 'rgba(226,226,226,0.3)' },
  // getStatusColor('landed') exactly, and the same 11pt mono StatusLine renders
  // at, so the archive's line sits where the saved list's line sits and in the
  // colour that word already has everywhere else in the app.
  landed: { fontFamily: MONO, fontSize: 11, color: '#8e8e93', marginTop: 4 },
  // Stretches to the row's height however tall the row is, so a roomy archive
  // row and a dense saved row both get a full-height target.
  // THE ROW'S OWN FILL, and the fix for actions showing through their row.
  //
  // ReanimatedSwipeable renders both action panels as absoluteFill siblings
  // UNDER the children — correct z-order, but a transparent row occludes
  // nothing, so the panel behind was legible straight through the flight number
  // and the date. The library's own guard is opacity: progress === 0 ? 0 : 1,
  // which hides a panel only while it is exactly shut; the moment a drag starts,
  // or after one is interrupted, it is visible through the row.
  //
  // #050505 is the page's own colour, so on the saved list this is invisible:
  // the row is filled with exactly what was behind it.
  //
  // ON THE ARCHIVE SHEET IT IS A COMPROMISE, and worth stating rather than
  // hiding. That sheet is glass; its composited ground is about rgb(1.8), so an
  // opaque rgb(5) row sits some three levels above it and the blurred page no
  // longer shows through where a row is — only through the sheet's padding and
  // between rows. There is no way to have both: a row that lets the page
  // through lets the action panel through with it. Occluding the actions is the
  // requirement, so the glass gives way, and it gives way to the one colour
  // already in the file rather than to a new near-black.
  rowSurface: { backgroundColor: '#050505' },
  // CENTRE, not stretch — the buttons have their own height now.
  //
  // marginBottom is what makes "centred" mean centred on the CARD: the panel
  // this group fills spans the row's whole box, and the row's box includes the
  // card gap below it. Without this the buttons sit half a gap low.
  swipeGroup: { flexDirection: 'row', alignItems: 'center', marginBottom: CARD_GAP },
  // The growing box. alignItems centre for the same reason swipeGroup uses it:
  // the button has a height and should keep it. justifyContent holds the button
  // against the edge the row is being dragged away from.
  swipeExpand: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  swipeExpandRight: { justifyContent: 'flex-end' },
  swipeExpandLeft: { justifyContent: 'flex-start' },

  // THE BUTTON, and its height is its own rather than the row's. See SWIPE_SIZE.
  swipeBtn: {
    height: SWIPE_SIZE,
    marginHorizontal: SWIPE_MARGIN,
    borderRadius: SWIPE_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeBtnFixed: { width: SWIPE_SIZE },
  // Expanding. flex rather than a width, so the fill follows the animated box
  // around it.
  //
  // AND NOTHING ELSE. These used to carry alignItems: 'flex-end' with a padding
  // that held the glyph against the outer edge however wide the button became.
  // Dropping both leaves swipeBtn's own alignItems: 'center' in force, which is
  // the whole of this change: a centred glyph in a box that is widening IS a
  // glyph travelling to the centre.
  //
  // Nothing new is animated to do it. The only animated value in this component
  // is the box's width in ExpandAction's useAnimatedStyle, which Reanimated
  // evaluates on the UI thread; the glyph's position is Yoga laying that width
  // out in the same pass, on the same thread, in the same frame. There is no
  // second animation to fall behind the first, and no runOnJS anywhere in the
  // path — the only JS crossing in the gesture remains the threshold's onCross.
  //
  // At rest the two agree exactly: the button is a 52pt square and the glyph is
  // 20pt, so centred and edge-pinned are the same 16pt of clearance. The travel
  // starts from zero rather than from a jump.
  //
  // The right and left variants are now identical and kept apart anyway, since
  // ExpandAction still chooses between them by side and a future difference
  // belongs here rather than in a new pair.
  swipeBtnGrowRight: { flex: 1 },
  swipeBtnGrowLeft: { flex: 1 },
  // The scaling half of the button. Kept separate from swipeBtn so the touch
  // target stays a fixed 64pt however small the contents are drawn.
  swipeInner: { alignItems: 'center', justifyContent: 'center' },

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
            <GlassLayers />
            {/* On top of the shared pair, not instead of it. See PROFILE_FILL. */}
            <View style={[StyleSheet.absoluteFill, pm.tint]} pointerEvents="none" />
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
  // The model's reading, and the exact query it was read from. Keyed on the
  // query so an edit invalidates it: a reading of a sentence the user has since
  // changed must never be what the next press spends units on.
  const [nlRead, setNlRead] = useState<{ q: string; v: NlRead } | null>(null);
  // Arrival times bought one at a time for rows the board sent without one.
  // Keyed by makeFlightId, so it survives a new search: the same flight on the
  // same day is the same answer. See routeRows, which merges these in.
  const [routeFills, setRouteFills] = useState<Record<string, { text: string | null; iso: string | null }>>({});
  // Every key ever ATTEMPTED, successful or not. A ref rather than state
  // because writing it must not re-render, and because it has to outlive the
  // result it was populated from.
  const routeFillTried = useRef<Set<string>>(new Set());
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
      // BEFORE anything is scheduled. Android silently drops notifications with
      // no channel — no error at the call site, no delivery.
      await ensureChannel();
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
  // One value for both opacity and travel, so they cannot drift apart, and a
  // Reanimated shared value so the whole sequence stays on the UI thread.
  const toastAnim = useSharedValue(0);
  const toastStyle = useAnimatedStyle(() => ({
    opacity: toastAnim.value,
    transform: [{ translateY: (toastAnim.value - 1) * TOAST_RISE }],
  }));
  // Four values, not two: each overlay drives its content and its scrim
  // separately, so the backdrop can run its own timing. Every property either
  // value touches is opacity or transform, so all of it is native-driven and
  // none of it can move the layout underneath.
  const routePanelAnim = useRef(new Animated.Value(0)).current;
  const routeScrimAnim = useRef(new Animated.Value(0)).current;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiveAnim = useRef(new Animated.Value(0)).current;
  const archiveScrimAnim = useRef(new Animated.Value(0)).current;
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

  // In, hold, out — as one sequence rather than a delayed fade, so a second
  // message arriving mid-flight restarts cleanly instead of inheriting whatever
  // the first one had got to. toastCounter is what makes an identical message
  // twice in a row re-run this.
  useEffect(() => {
    if (toastMsg === '') return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    // Assigning over a running animation cancels it, so a second message
    // restarts from 0 without needing a stopAnimation call first.
    toastAnim.value = 0;
    toastAnim.value = withSequence(
      withTiming(1, { duration: TOAST_IN_MS, easing: REasing.out(REasing.cubic) }),
      withDelay(
        TOAST_HOLD_MS,
        withTiming(0, { duration: TOAST_OUT_MS, easing: REasing.in(REasing.cubic) }),
      ),
    );
    // Cleared a beat after the fade finishes, so the text is never blanked out
    // from under a banner that is still on screen.
    toastTimerRef.current = setTimeout(
      () => setToastMsg(''),
      TOAST_IN_MS + TOAST_HOLD_MS + TOAST_OUT_MS + 40,
    );
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

  // Same two-layer rise the calendar sheet uses, on the same curves and
  // durations. One approach for every sheet in the file.
  useEffect(() => {
    if (!archiveOpen) return;
    archiveAnim.setValue(0);
    archiveScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(archiveScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(archiveAnim, {
        toValue: 1, duration: CAL_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [archiveOpen]);

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
        // Cheap, and the only chance to correct a schedule that drifted while
        // the app was not running. Fire and forget: nothing on screen waits.
        getSavedFlights(email).then(l => { if (!cancelled) reconcile(l); });
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
    // THE SAME DEMOTION THE ROW APPLIES, so tapping a row cannot contradict the
    // row that was tapped. Date.now() rather than the `now` state: this runs on
    // a tap rather than at render, and the tick that maintains `now` is a minute
    // wide.
    const storedStatus = saved.status.toLowerCase();
    const effective = effectiveStatus(saved, Date.now());
    // A CONTRADICTED rawStatus IS TREATED AS ABSENT, and this is the point of
    // the whole hunk. The provider said BOTH "landed" and "Arrived" about a
    // flight whose own arrival time had not come; the raw word is not a second
    // opinion, it is the same claim in finer detail, and the clock has just
    // refuted it. So it stops being evidence.
    //
    // NULLED AT THE CALL SITE rather than passed to badgeLabel as a third
    // "trusted" flag, for two reasons. badgeLabel already documents null as
    // "fall back to the display status", which is exactly the behaviour wanted,
    // so no new contract is needed; and the clock lives out here, where
    // effectiveStatus was already called, instead of being handed to a function
    // whose job is turning one string into another.
    //
    // The SAME value goes to displayStatus. It cannot change the outcome today —
    // demotion only fires on stored 'landed' or 'active', whose raw words are
    // Arrived, Departed, EnRoute or Approaching, and displayStatus only tests
    // for 'delayed' — but trusting the word in one call and not the other would
    // be a distinction with no reason behind it.
    const trustedRaw = effective === storedStatus ? saved.rawStatus : null;
    const savedStatus = displayStatus(effective, saved.from.delay, trustedRaw);
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
      // As in flightDataFromApi: label from the provider's word, colour from the
      // mapped status. A pre-v10 record has rawStatus null and falls back to the
      // uppercased display status, which is what it already showed — and so now
      // does a record the clock has demoted, by the same route.
      status: badgeLabel(trustedRaw, savedStatus),
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
  //
  // `origin` is the departure IATA, and it is how a TAG FLIGHT is pinned to the
  // leg the user actually tapped: one number operating BOM-DEL then DEL-BOM on
  // one day is two instances the date cannot separate. Null where the caller
  // genuinely does not know — a flight number typed into the search box names no
  // airport, and guessing one there would be inventing an answer.
  const runFlightLookup = async (
    flightNumber: string,
    keepVisible = false,
    date: string | null = null,
    origin: string | null = null,
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
      const response = await fetch(flightUrl(flightNumber, date, origin));
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return false;
      }

      // THE RECORD IS BUILT FIRST so one clock check serves both it and the
      // card. savedFlightFromApi is pure — it reads `data` and the clock and
      // writes no state — so moving it above setFlight leaves the order of every
      // state update below exactly as it was, and every value identical.
      const record = savedFlightFromApi(data);
      setFlight(flightDataFromApi(data, effectiveStatus(record, Date.now())));

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
  const saveFromRoute = async (flightNumber: string, date: string | null,
                              origin: string | null = null) => {
    if (routeSavingKey !== null) return;      // one at a time; the UI also disables the rest
    setRouteSavingKey(flightNumber);
    setError("");
    try {
      // Same date AND same origin the row was rendered from. Without the date
      // this stored TODAY's instance of the flight under a row the user picked
      // off a future board; without the origin it stored whichever leg of a tag
      // flight the provider offered first. Both persist, which is what makes
      // them worse here than on the card.
      const response = await fetch(flightUrl(flightNumber, date, origin));
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      }

      const result = await saveFlight(email, savedFlightFromApi(data), f => !isArchived(f, Date.now()));
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
    // A HARD local error stops here, exactly as it always has: a code that is
    // not in the dataset and an origin equal to its destination are both known
    // to be wrong, and no model is going to change that. A SOFT one means the
    // split did not resolve, which is a case the rung below can improve on, so
    // it falls through instead of stopping.
    if (routeCandidate !== null && routeCandidate.kind === 'error' && !routeCandidate.soft) {
      // Nothing is spent here — not a board fetch, and not an LLM call.
      setError(routeCandidate.message);
      setErrorCounter(c => c + 1);
      shake();
      return;
    }
    if (routeCandidate !== null && routeCandidate.kind === 'ok') {
      // A NEW SEARCH STARTS CLEAN. runRouteLookup cannot do this: its other
      // callers are the date pill and the airport picker, which REFINE the list
      // on screen, and wiping the filters there would undo a choice the user
      // just made. Only this branch knows the search was typed from scratch.
      //
      // Before the mods, never after, so a sentence that names a band or a sort
      // still gets exactly what it asked for.
      //
      // routeAirlinesOff is NOT here: runRouteLookup already clears it, and
      // saying so in two places is how the two drift. routeDate is not here
      // either — it is the SUBJECT of the search rather than a filter on it.
      setRouteDepBands(ALL_BANDS_ON);
      setRouteArrBands(ALL_BANDS_ON);
      setRouteSort(ROUTE_SORT_DEFAULT);
      // Only what the sentence actually said. With no modifiers every line below
      // is a no-op and the call is the one this branch has always made:
      // mods.date is null, so `?? routeDate` is routeDate.
      const mods = routeCandidate.mods;
      if (mods.band !== null) {
        setRouteDepBands(nlBandOnly(mods.band));
        setRouteArrBands(ALL_BANDS_ON);
      }
      if (mods.sort !== null) setRouteSort(mods.sort);
      // Set so the date pill on the results screen agrees with the board that
      // was fetched. A sentence overrides the control; it does not reset it.
      if (mods.date !== null) setRouteDate(mods.date);
      setRoutePick({ from: routeCandidate.from.options, to: routeCandidate.to.options });
      await runRouteLookup(
        routeCandidate.from.airport.iata, routeCandidate.to.airport.iata,
        mods.date ?? routeDate);
      return;
    }

    // ── the model rung ──────────────────────────────────────────────────
    //
    // TWO PRESSES, and the split is deliberate. The reading cannot exist before
    // the first press, because producing it as the user types would be a model
    // call per keystroke. So the first press buys the READING and the second
    // spends the UNITS — which is what "see the extraction before Execute
    // fires" has to mean when the extraction costs something to make.
    //
    // A reading already in hand for this exact query is not re-fetched: press
    // two searches, or, if it was not armed, does nothing further. Editing the
    // query clears it, so a stale reading can never be the thing that runs.
    if (nlRead !== null && nlRead.q === query) {
      const v = nlRead.v;
      if (!v.armed || v.from === null || v.to === null) return;
      routeResetControls_forSearch();
      if (v.mods.band !== null) {
        setRouteDepBands(nlBandOnly(v.mods.band));
        setRouteArrBands(ALL_BANDS_ON);
      }
      if (v.mods.sort !== null) setRouteSort(v.mods.sort);
      if (v.mods.date !== null) setRouteDate(v.mods.date);
      setRoutePick({ from: v.from.options, to: v.to.options });
      await runRouteLookup(v.from.airport.iata, v.to.airport.iata, v.mods.date ?? routeDate);
      return;
    }

    if (nlLooksLikeSearch(query)) {
      setLoading(true);
      try {
        const response = await fetch(`${API_BASE}/parse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: query }),
        });
        const data = await response.json();
        if (!response.ok) {
          setError(data.error || "Something went wrong. Please try again.");
          setErrorCounter(c => c + 1);
          shake();
          return;
        }
        // Nothing is searched on this press. The reading goes on screen and the
        // user decides whether it is right.
        setNlRead({ q: query, v: nlReadReply(data as ParseReply) });
        return;
      } catch {
        setError("Could not reach the server. Please check your connection and try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      } finally {
        setLoading(false);
      }
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

      // data.error as well as the status, which is what every other fetch in
      // this file already does — see runRouteLookup, runFlightLookup and the
      // refresh loop. /chat returns its failures as a 200 carrying an error
      // key, so a status-only check swallowed them: the credit error was being
      // reported correctly by the backend and discarded here, which is why
      // "is my flight on time" appeared to do nothing at all.
      if (data.error || !response.ok) {
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
    // The open card's ID, not its number: two instances of one number can be
    // saved, and only the one actually on screen should be refreshed into it.
    const openCardId = flightRecord?.id ?? null;
    let openCardFresh: any = null;
    let failures = 0;
    let attempts = 0;

    // One day back is all the backend accepts, so anything older is refused
    // before it reaches the provider. Computed once, outside the loop.
    const oldest = localIsoDate(new Date(Date.now() - REFRESH_MAX_PAST_MS));

    for (const f of list) {                                   // sequential — never parallel
      if (attempts >= maxAttempts) break;
      const day = ISO_DAY_RE.test(f.flightDate) ? f.flightDate : null;
      // SKIPPED, NOT ATTEMPTED, and therefore not a failure. A past date is
      // rejected by the backend every single time, so these records failed on
      // every pull and "could not be updated" became permanent furniture rather
      // than news. Before attempts++ as well as before the fetch: a skip must
      // not consume one of the attempts a live flight could have used.
      if (day !== null && day < oldest) continue;
      // Between attempts only — never before the first, never after the last, so
      // a single saved flight waits no longer than it does today.
      if (attempts > 0) await new Promise(resolve => setTimeout(resolve, REFRESH_SPACING_MS));
      attempts++;
      try {
        // ON ITS OWN DATE. Undated, this asked for whichever instance is nearest
        // now and wrote that over the record — so a flight saved for the 31st
        // was quietly replaced by today's. That is the same fault the flight
        // card had before it learned to pass a date, and widening the key
        // without fixing it would be worse than the old single overwrite: two
        // records would exist and both would refresh into the same instance.
        //
        // ON ITS OWN ORIGIN as well as its own date, from the record being
        // refreshed. This is the one call site that can read the answer off
        // storage rather than off the screen, and it is also the one that writes
        // unconditionally, so a tag flight refreshed without it would replace a
        // saved BOM-DEL with DEL-BOM under the same id.
        const response = await fetch(
          flightUrl(f.flightNumber, day, f.from.iata || null),
        );
        const data = await response.json();
        if (data.error || !response.ok) { failures++; continue; }
        // f.id, not the fresh record's: a record filed under "unknown" has no
        // date for its id to have been built from, and this is what lets the
        // response supply one.
        await touchSavedFlight(email, savedFlightFromApi(data), f.id);
        if (openCardId && f.id === openCardId) openCardFresh = data;
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

  // ON OR OFF for one flight, and the single place the three things that have
  // to agree are put in order: the operating system's schedule, the stored
  // decision, and what the user is told.
  //
  // OFF cancels first and writes second. A cancel that fails leaves a
  // notification that will fire for a flight the user has turned off, which is
  // worse than a stored flag that says on.
  //
  // ON asks permission first and writes LAST, so nothing is stored if the user
  // refuses or if there is nothing left to schedule. A record saying reminders
  // are on with no notifications behind it would survive every reconcile,
  // because reconcile trusts this field.
  const handleRemind = useCallback(async (f: SavedFlight, on: boolean): Promise<string> => {
    if (!on) {
      await cancelFor(f.id);
      setSavedFlights(await setFlightReminders(email, f.id, null));
      return 'reminders off';
    }
    if (!(await ensurePermission())) return 'notifications are turned off for this app';
    // Both null means the evening before has passed and the leave-now instant —
    // three hours before a domestic departure, four before an international one
    // — has passed too. Nothing is written: an empty reminder is a promise the
    // app cannot keep.
    const t = reminderTimes(f, Date.now());
    if (t.evening === null && t.leave === null) {
      return f.from.scheduledIso && f.from.timezone
        ? 'too late to set a reminder for this one'
        : 'no departure time to remind you about';
    }
    await scheduleFor(f);
    setSavedFlights(await setFlightReminders(email, f.id, Date.now()));
    return 'reminders on';
  }, [email]);

  const onRefresh = async () => {
    if (refreshingRef.current) return;                        // synchronous guard; iOS can double-fire the pull
    setGreetingIndex(Math.floor(Math.random() * 60));         // past the double-fire guard, above the cooldown: a throttled pull still rerolls
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshMsg("");
    try {
      if (activeSaved.length === 0) return;                   // spinner alone acknowledges; message can't render here

      if (Date.now() - lastRefreshRef.current < PULL_COOLDOWN_MS) {
        setRefreshMsg('> already up to date');
        setRefreshTone('info');
        setRefreshMsgCounter(c => c + 1);
        return;
      }
      lastRefreshRef.current = Date.now();

      // Active only. An archived flight is not refreshed, which is the whole
      // reason it does not count against MAX_SAVED_FLIGHTS.
      const { failures, openCardFresh } = await refreshFlights(activeSaved, 5);

      const list = await getSavedFlights(email);              // read once, set state once
      setSavedFlights(list);

      // A refresh is the one moment a departure time can move under a reminder
      // that was scheduled from the old one, and the one moment a record filed
      // under "unknown" takes a real id. Both leave the schedule wrong, and
      // this is what puts it right.
      reconcile(list);

      if (openCardFresh) {
        // HOISTED, exactly as in runFlightLookup: the record was already being
        // built here for its id, so building it first costs nothing and lets one
        // clock check serve the card. It is also now built ONCE rather than
        // twice — the id below reads this record instead of calling
        // savedFlightFromApi a second time on the same response.
        const fresh = savedFlightFromApi(openCardFresh);
        setFlight(flightDataFromApi(openCardFresh, effectiveStatus(fresh, Date.now())));
        // By id, not by number: with two instances saved, matching on the number
        // alone could put the OTHER date's record behind the open card. The id
        // can also change across a refresh — a record filed under "unknown"
        // takes a real date the first time one comes back — so the fresh data's
        // id is tried first and the one the card was opened with second.
        const freshId = fresh.id;
        const stored = list.find(f => f.id === freshId)
          ?? list.find(f => f.id === (flightRecord?.id ?? ''));
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
  // Split once, here, so nothing below has to remember which list it wants.
  // `now` ticks, so a flight crosses into the archive on screen without a
  // reload.
  const activeSaved = savedFlights.filter(f => !isArchived(f, now));
  // Most recent first: the flight that landed an hour ago before the one from
  // last March.
  const archivedSaved = savedFlights
    .filter(f => isArchived(f, now))
    .sort((a, b) => (arrivalTs(b) ?? 0) - (arrivalTs(a) ?? 0));

  const sortedSaved = sortSavedByRelevance(activeSaved, now);

  // Resolved from the bundled dataset. This used to read the saved flights on
  // the device, which meant a fresh install never saw an airport name at all —
  // and it could not tell a real code from a typo, because a code it had not
  // seen and a code that does not exist looked identical to it.
  //
  // Parsed once per distinct query and cached: the parser scans the dataset,
  // and this runs on every keystroke.
  // An edit throws the model's reading away. Doing it here rather than in the
  // TextInput handler means it cannot be forgotten by a second input path.
  if (nlRead !== null && nlRead.q !== query) setNlRead(null);

  const routeParseCache = useRef<{ q: string; v: SearchParse }>({ q: '\u0000', v: null });
  if (routeParseCache.current.q !== query) {
    routeParseCache.current = { q: query, v: parseSearchQuery(query) };
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
  //
  // The fills are merged HERE and nowhere else, which is the whole reason this
  // is one line rather than a patch at the render site. An arrival time is not
  // only something the row prints: routeDurationMs reads it, so it decides the
  // duration sort, the arrival sort and which row wears the fastest marker.
  // Filling it in at the Text would leave a row showing a time while every
  // derivation above still treated it as having none — a row sorted last for
  // want of a value it is visibly displaying. Merging at the source means the
  // standing checks hold against exactly what is on screen.
  //
  // The visible consequence, and it is intended: a row that gains a time can
  // move, and can take the fastest marker, a moment after the list first
  // appears. That is the list becoming correct, not the list twitching.
  const routeRows: RouteFlight[] = routeResult === null
    ? []
    : [...routeResult.flights, ...routeRecovered].map(r => {
        if (r.arrival_scheduled_iso !== null || r.arrival_scheduled !== null) return r;
        const fill = routeFills[makeFlightId(r.flight_number, routeDayOf(r))];
        return fill === undefined
          ? r
          : { ...r, arrival_scheduled: fill.text, arrival_scheduled_iso: fill.iso };
      });

  // AFTER the list is on screen, never before it.
  //
  // The effect runs on commit, so the rows are already rendered with their
  // dashes and nothing is held up waiting for a network call. Each answer
  // arrives as its own setState and swaps one row's dash for a time in place.
  //
  // Keyed on number AND date, so a dated search fills the instance it is
  // actually showing, and a flight looked up once is never looked up again this
  // session — routeFillTried is a ref, so it outlives every re-render and every
  // new search. The key goes in BEFORE the request rather than after it, which
  // is what makes a failure final: a row whose fetch fails keeps its dash, and
  // nothing retries it. No error is surfaced either. The list was already
  // telling the truth; this only ever improves on it.
  useEffect(() => {
    if (routeResult === null) return;
    const targets: RouteFlight[] = [];
    for (const r of [...routeResult.flights, ...routeRecovered]) {
      // Already has one. Nothing to buy.
      if (r.arrival_scheduled_iso !== null || r.arrival_scheduled !== null) continue;
      if (routeFillTried.current.has(makeFlightId(r.flight_number, routeDayOf(r)))) continue;
      targets.push(r);
      if (targets.length === ROUTE_FILL_MAX) break;
    }
    if (targets.length === 0) return;

    let cancelled = false;
    (async () => {
      // One at a time. Three parallel requests would arrive as three renders in
      // the same frame anyway, and serialising keeps the burst off the backend.
      for (const r of targets) {
        if (cancelled) return;
        const day = routeDayOf(r);
        const key = makeFlightId(r.flight_number, day);
        routeFillTried.current.add(key);
        try {
          // The board's own origin. Every row here departs from it, and without
          // it a tag flight fills this row with the other leg's arrival time —
          // a wrong number in a cell that looks exactly like a right one.
          const res = await fetch(flightUrl(r.flight_number, day, routeResult.origin));
          const data = await res.json();
          if (!res.ok || data.error) continue;
          const text = data.arrival_scheduled ?? null;
          const iso = data.arrival_scheduled_iso ?? null;
          // The endpoint answered but has no arrival either. Nothing to write,
          // and the key is already spent, so this settles the row for good.
          if (text === null && iso === null) continue;
          if (cancelled) return;
          setRouteFills(prev => ({ ...prev, [key]: { text, iso } }));
        } catch {
          // Quiet on purpose. The row keeps its dash.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [routeResult]);

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

  // WHICH ROW IS ACTUALLY LAST, as a key rather than an index.
  //
  // The other two lists are one map over one array and can answer this with an
  // index. This one is up to four arrays — a pinned row, then either the groups
  // and the ungrouped remainder, or the flat list — so the last row rendered is
  // not the last element of anything in particular. It is read back to front:
  // the ungrouped tail if there is one, else the last group that has any rows,
  // else the flat list, else the pinned row if it is the only thing on screen.
  //
  // routeRowKey rather than object identity, because the row objects are rebuilt
  // by every derivation above and identity does not survive that.
  const routeLastKey = (() => {
    if (routeSort === 'departure') {
      if (routeUngrouped.length > 0) {
        return routeRowKey(routeUngrouped[routeUngrouped.length - 1]);
      }
      for (let i = routeGroups.length - 1; i >= 0; i--) {
        const g = routeGroups[i];
        if (g.rows.length > 0) return routeRowKey(g.rows[g.rows.length - 1]);
      }
    } else if (routeListed.length > 0) {
      return routeRowKey(routeListed[routeListed.length - 1]);
    }
    // Nothing below it: the pinned row is the whole list.
    return routePinned === null ? null : routeRowKey(routePinned);
  })();

  // The local calendar date a board row DEPARTS on, read from its own ISO.
  //
  // Not the board's date. An undated board is a rolling twelve hours from now,
  // so its late rows belong to tomorrow — and a record saved from one of those
  // is keyed on the date the backend reports, which is the row's own. Matching
  // the indicator on the board's date instead would leave those rows showing
  // unsaved forever.
  const routeRowDay = routeDayOf;

  // Flat rows, not cards. Line one carries everything variable-width; line two
  // carries the two times and the connector between them, and nothing else may
  // join it. The times are sized to their own content and pinned to opposite
  // edges of the row, so departures start at the same x and arrivals end at the
  // same x while the connector absorbs every point of slack.
  // `pinned` only suppresses the in-row "fastest" tag, because the heading
  // directly above the pinned row already says the word. Same component, same
  // layout, one boolean — there is no second row renderer.
  // ONE definition, rendered in both the collapsed and the expanded state.
  // The archive is not part of the saved list — it holds the flights that are
  // no longer in it — so collapsing the list must not take it away too. It keeps
  // the same place either way: the right-hand end of the section's top line.
  const archiveButton = (style: any) => (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => setArchiveOpen(true)}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={style}
    >
      {/* An archive box: lid, body, and the pull on its front. Same 18x18 /
          24-viewBox / 1.75-stroke treatment as the bookmark on the flight
          card. */}
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path d="M3 5h18v4H3z" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
        <Path d="M5 9v10h14V9" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
        <Path d="M10 13h4" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
      </Svg>
    </TouchableOpacity>
  );

  const routeRow = (r: RouteFlight, pinned = false) => {
    const ms = routeDurationMs(r);
    const origin = routeResult?.origin ?? '';
    // The APPLIED date, never routeDate: that can hold a selection the list has
    // not been re-fetched for, which would open a card for a day the row on
    // screen is not from. Null for an undated board, which is today.
    const rowDate = routeResult?.date ?? null;
    const airline = airlineFromFlightNumber(r.flight_number);
    // Number AND date, so a row shows saved only when THAT instance is saved.
    const rowDay = routeRowDay(r);
    const saved = savedFlights.some(f => f.id === makeFlightId(r.flight_number, rowDay));
    const pending = routeSavingKey === r.flight_number;
    const busy = routeSavingKey !== null;
    const showStatus = r.status !== ROUTE_STATUS_ROUTINE;
    return (
      <TouchableOpacity
        key={routeRowKey(r)}
        style={[s.routeFlatRow, routeRowKey(r) === routeLastKey && s.routeFlatRowLast]}
        activeOpacity={0.7}
        onPress={() => runFlightLookup(r.flight_number, false, rowDate, origin || null)}
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
          onPress={() => saveFromRoute(r.flight_number, rowDay ?? rowDate, origin || null)}
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
  // The view-control half of a reset, without the re-fetch. Both search paths
  // call it so that "a search typed from scratch starts clean" is one rule in
  // one place rather than two lists that drift.
  const routeResetControls_forSearch = () => {
    setRouteDepBands(ALL_BANDS_ON);
    setRouteArrBands(ALL_BANDS_ON);
    setRouteSort(ROUTE_SORT_DEFAULT);
  };

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

  // The stagger, read off the sheet's own value. Clamped at both ends so a row
  // is fully hidden before its slot and fully settled after it, and so the
  // input range is always strictly increasing: the last slot ends at 0.87.
  const archiveRowStyle = (i: number) => {
    const start = Math.min(i, ARCHIVE_ROW_MAX) * ARCHIVE_ROW_STAGGER;
    const end = start + ARCHIVE_ROW_FADE;
    return {
      opacity: archiveAnim.interpolate({
        inputRange: [start, end], outputRange: [0, 1], extrapolate: 'clamp' as const,
      }),
      transform: [{
        translateY: archiveAnim.interpolate({
          inputRange: [start, end],
          outputRange: [ARCHIVE_ROW_RISE, 0],
          extrapolate: 'clamp' as const,
        }),
      }],
    };
  };

  // Unmounts only once both layers have left, exactly as closeRouteCal does.
  const closeArchive = () => {
    Animated.parallel([
      Animated.timing(archiveAnim, {
        toValue: 0, duration: CAL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(archiveScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setArchiveOpen(false));
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
    const result = await saveFlight(email, flightRecord, f => !isArchived(f, Date.now()));
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
              {/* Behind the options and clipped by the overflow above. It cannot
                  disturb the onLayout measurement this panel's placement depends
                  on: both its layers are absolutely positioned, and Yoga leaves
                  absolute children out of the flex line it sizes the container
                  from. */}
              <GlassLayers />
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
      <Modal visible={archiveOpen} transparent animationType="none" onRequestClose={closeArchive}>
        <Pressable style={s.routeCalScrim} onPress={closeArchive}>
          {/* The dim alone, full screen and unblurred. The blur lives inside the
              sheet now, so outside it the page stays sharp. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.routeCalDim, { opacity: archiveScrimAnim }]}
          />
          {/* Unchanged: the same rise, scale and fade the calendar sheet uses. */}
          <Animated.View
            style={[
              s.sheetShell,
              s.archiveSheet,
              {
                opacity: archiveAnim,
                transform: [
                  { translateY: archiveAnim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                  { scale: archiveAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
          >
            {/* THE GLASS. Three layers, in this order and no other: the blur
                samples what is behind the sheet, the tint darkens the result,
                and the hairline draws the edge. The first two are clipped by
                the shell's overflow to the 16pt radius, so the blur stops
                exactly where the panel does; the third carries its own matching
                radius and lands on that same edge.

                The first two now come from GlassLayers, which every other glass
                surface renders too. They were written out here once; that was
                one copy of the material too many. */}
            <GlassLayers />
            <View style={s.sheetEdge} pointerEvents="none" />
            {/* Swallows the tap so the scrim's dismiss does not fire through. */}
            <Pressable style={[s.sheetBody, s.sheetBodyFill]}>
              <View style={s.sheetHead}>
                {/* Exactly the close button's width, so the title centres on the
                    sheet rather than on whatever space is left beside it. */}
                <View style={s.sheetHeadSpacer} />
                <Text style={s.sheetTitle}>{'Archives'}</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={closeArchive}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={s.sheetClose}
                >
                  {/* The app's own close X, character for character: the same
                      20pt box, the same 5..19 span, the same weight, cap and
                      red the calendar sheet and the flight card already use.
                      The ring it used to sit in is gone — nothing else in the
                      file outlines an icon, and it was the outline rather than
                      the glyph that made this control look borrowed. */}
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
              {archivedSaved.length === 0 ? (
                <Text style={s.archiveEmpty}>
                  {'Nothing here yet. A flight moves in a few hours after it lands.'}
                </Text>
              ) : (
                <ScrollView style={s.archiveList} showsVerticalScrollIndicator={false}>
                  {archivedSaved.map((f, i) => (
                    <Animated.View key={f.id} style={archiveRowStyle(i)}>
                      <SavedFlightRow
                        flight={f}
                        now={now}
                        roomy
                        archived
                        last={i === archivedSaved.length - 1}
                        onDone={showToast}
                        onRemind={(on) => handleRemind(f, on)}
                        onPress={() => { closeArchive(); renderSavedFlight(f); }}
                        onUnsave={async () => setSavedFlights(await unsaveFlight(email, f.id))}
                        onArchive={async (on) => setSavedFlights(await setFlightArchived(email, f.id, on ? Date.now() : null))}
                      />
                    </Animated.View>
                  ))}
                </ScrollView>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      <Modal visible={routeCalOpen} transparent animationType="none" onRequestClose={closeRouteCal}>
        <Pressable style={s.routeCalScrim} onPress={closeRouteCal}>
          {/* The dim is its own layer so it can fade on its own curve. Folding it
              into the sheet's value would drag the whole backdrop through the
              sheet's travel and scale.

              Full screen, unblurred, and identical to the archive sheet's: the
              blur belongs to the panel, not to the backdrop. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.routeCalDim, { opacity: routeCalScrimAnim }]}
          />
          <Animated.View
            style={[
              s.sheetShell,
              {
                opacity: routeCalAnim,
                transform: [
                  { translateY: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                  { scale: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
          >
            {/* The same three layers, in the same order, as the archive sheet.
                Two centred sheets, one treatment. */}
            <GlassLayers />
            <View style={s.sheetEdge} pointerEvents="none" />
            <Pressable style={s.sheetBody}>
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
      {/* THE BANNER. Absolutely positioned against the root, which is the whole
          of why it cannot shift anything: it is out of flow, so nothing above or
          below it moves when it arrives or leaves, and the list underneath does
          not reflow by a pixel. pointerEvents none so it never intercepts a tap
          meant for what it is covering.

          Rendered after the modals and before the page so it paints above the
          page; the modals are their own host views and sit above it, which is
          correct — a sheet is a thing you are in, and this is a note about
          something you just did to the page behind it.

          The surface is the app's glass, from the same constants and the same
          GlassLayers every sheet and panel uses, so it cannot drift from them:
          sheetShell for the radius and the clip, GlassLayers for the blur and
          the tint, sheetEdge for the hairline. */}
      {toastMsg !== '' && (
        <Reanimated.View
          pointerEvents="none"
          style={[s.toastWrap, { top: insets.top + 12 }, toastStyle]}
        >
          <View style={[s.sheetShell, s.toastCard]}>
            <GlassLayers />
            <View style={s.sheetEdge} pointerEvents="none" />
            <Text style={s.toastText} numberOfLines={1}>{toastMsg}</Text>
          </View>
        </Reanimated.View>
      )}
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
          {/* THE MODEL'S READING, in the same block and the same styles as the
              free one. Three lines rather than two: the route, its settings, and
              a line saying where the reading came from and whether pressing
              again will spend anything. It replaces the free affordance rather
              than joining it, because both cannot be true of one query. */}
          {nlRead !== null && nlRead.q === query && (
            <View style={{ marginTop: 4, marginBottom: 10, paddingLeft: 18 }}>
              {nlRead.v.from !== null && nlRead.v.to !== null && (
                <Text style={s.routeEcho} numberOfLines={2}>
                  {`${nlRead.v.from.airport.city} (${nlRead.v.from.airport.iata})`}
                  {' → '}
                  {`${nlRead.v.to.airport.city} (${nlRead.v.to.airport.iata})`}
                </Text>
              )}
              {nlModsLabel(nlRead.v.mods) !== '' && (
                <Text style={s.routeEchoMods} numberOfLines={1}>
                  {nlModsLabel(nlRead.v.mods)}
                </Text>
              )}
              <Text style={s.routeEchoNote} numberOfLines={2}>{nlRead.v.note}</Text>
            </View>
          )}

          {routeAffordance && nlRead === null && (
            <View style={{ marginTop: 4, marginBottom: 10, paddingLeft: 18 }}>
              <Text style={s.routeEcho} numberOfLines={2}>
                {`${routeAffordance.from.airport.city} (${routeAffordance.from.airport.iata})`}
                {' → '}
                {`${routeAffordance.to.airport.city} (${routeAffordance.to.airport.iata})`}
              </Text>
              {/* Only when the sentence carried something. A short route looks
                  exactly as it did, and this reads from the SAME cached parse
                  the line above does, so what is shown and what Execute does
                  cannot disagree. */}
              {nlModsLabel(routeAffordance.mods) !== '' && (
                <Text style={s.routeEchoMods} numberOfLines={1}>
                  {nlModsLabel(routeAffordance.mods)}
                </Text>
              )}
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
              {/* sortedSaved, not savedCollapsed alone: every flight can be
                  archived while records still exist, and the collapsed line
                  reads sortedSaved[0]. Falling through to the expanded branch
                  keeps the heading — and the way into the archive — reachable. */}
              {savedCollapsed && sortedSaved.length > 0 ? (
                <View style={sf.collapsedRow}>
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
                    {activeSaved.length > 1 && (
                      <Text style={sf.collapsedDim}>{` · +${activeSaved.length - 1} more`}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
                {archiveButton(sf.archiveBtnCollapsed)}
                </View>
              ) : (
                <>
                  <View style={sf.headingRow}>
                    {/* The chevron leads the heading now, on the left, where it
                        reads as the control for the thing it is next to rather
                        than as a stray glyph at the far edge. The tap target is
                        the pair, not the row, so the archive icon opposite gets
                        its own. */}
                    <TouchableOpacity
                      style={sf.headingTap}
                      activeOpacity={0.7}
                      onPress={() => persistCollapsed(true)}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    >
                      <Text style={sf.chevronLeft}>{'\u25BE'}</Text>
                      <Text style={s.detailsTitle}>{'saved flights'}</Text>
                    </TouchableOpacity>
                    {archiveButton(sf.archiveBtn)}
                  </View>
                  {sortedSaved.length === 0 ? (
                    <Text style={sf.noneActive}>
                      {'Nothing upcoming. Past flights are in the archive.'}
                    </Text>
                  ) : sortedSaved.map((f, i) => (
                    <SavedFlightRow
                      key={f.id}
                      flight={f}
                      now={now}
                      last={i === sortedSaved.length - 1}
                      onDone={showToast}
                      onRemind={(on) => handleRemind(f, on)}
                      onPress={() => renderSavedFlight(f)}
                      onUnsave={async () => setSavedFlights(await unsaveFlight(email, f.id))}
                      onArchive={async (on) => setSavedFlights(await setFlightArchived(email, f.id, on ? Date.now() : null))}
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
                        //
                        // AND TO THE LEG ON SCREEN. This is the one call that can
                        // flip an ALREADY-CORRECT card to the other leg of a tag
                        // flight: the card may have been opened from a route row
                        // that got the origin right, and a refresh without one
                        // would quietly replace it with whichever leg the
                        // provider offered. It knows the answer from the very
                        // record it is refreshing.
                        const ok = await runFlightLookup(
                          flightRecord.flightNumber,
                          true,
                          /^\d{4}-\d{2}-\d{2}$/.test(flight.date) ? flight.date : null,
                          flightRecord.from.iata || null,
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
  // A step down in size and two down the ramp from the route above it: the
  // route is what will be searched, these are its settings.
  routeEchoMods: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS, marginTop: 3,
  },
  // Where the reading came from, and whether the next press spends anything.
  // One step further down the same ramp than the settings above it: this is the
  // app talking about itself, which is the least important thing in the block.
  routeEchoNote: {
    fontSize: 11, color: "rgba(226,226,226,0.3)", fontFamily: SANS, marginTop: 4,
  },
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
  // The same card as a saved row, and the same padding, which is what keeps the
  // times in their columns. See CARD_PAD.
  routeFlatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 18,
    paddingHorizontal: CARD_PAD,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    marginBottom: CARD_GAP,
  },
  // See routeLastKey. The hidden-count and truncation notes below the list keep
  // their own spacing, so dropping the gap leaves nothing touching.
  routeFlatRowLast: { marginBottom: 0 },
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
  // The sheets' scrim exactly, up from its own 0.35. The panel is glass now and
  // glass needs the same ground under it as the sheets have, or the two read as
  // different materials lit differently.
  routePanelDim: { backgroundColor: SHEET_SCRIM },

  // Centred, unlike pm.backdrop which anchors its sheet to the bottom.
  routeCalScrim: {
    flex: 1,
    justifyContent: "center", paddingHorizontal: 16,
  },
  // 0.55. It went to 0.88 to do a job that was not its own: with nothing
  // blurring the page, only brute darkness could stop the text behind competing
  // with the text in front, and the result was a black rectangle on a black
  // screen. The blur does that job properly now, so the scrim can go back to
  // what a scrim is for — pushing one plane behind another — and the page is
  // allowed to be visible again.
  //
  // 0.40, down from 0.55, and it is the panel this is for rather than the page.
  //
  // A subtractive panel can only be as dark as the light behind it lets it be.
  // At 0.55 the page outside sat at rgb(2.25) and the panel at rgb(1.13): the
  // panel was removing 50% of nothing, so there was nothing to see. Turning the
  // scrim DOWN puts light back outside for the panel to take away.
  //
  // Where the page is empty this is bounded and stays small — even at no scrim
  // at all the gap tops out at 2.5 levels, because the page itself is only
  // rgb(5). Where the page has content it is the whole effect: a line of white
  // text outside goes from rgb(102) to rgb(138) while the same line inside,
  // blurred and taken through the tint and the fill, stays near rgb(23).
  //
  // An earlier note here claimed 0.45 would "start competing with the sheet".
  // That was asserted, not worked out. At 0.40 the page's text renders at
  // rgb(138) against the sheet's own rgb(255) — 25% of its relative luminance,
  // which recedes clearly. 0.30 would be rgb(161) and 35%, which would not.
  //
  // It is also NOT deleted in favour of the blur's own tint. This layer is the
  // one whose value is known exactly on every platform; if a device renders no
  // blur at all, this is what still separates the sheet from the page.
  //
  // Shared with the calendar sheet, deliberately: both are centred sheets that
  // take over the screen, and a scrim that means one thing on one and another
  // on the other would be a bug in waiting. The dropdown panels now take this
  // same value through SHEET_SCRIM rather than the lighter one of their own
  // they used to carry.
  routeCalDim: { backgroundColor: SHEET_SCRIM },
  // THE SHELL. Deliberately generic: the dropdown panels take this same
  // treatment by swapping routePanel's background, border and radius for these
  // and putting the same BlurView and sheetTint in behind their content.
  // Nothing here knows anything about archives.
  sheetShell: {
    borderRadius: SHEET_RADIUS,
    // Clips the blur — and the rows — to the radius. This is now doing real
    // work: it is what confines the blur to the panel's own rounded rectangle
    // instead of the whole screen.
    overflow: "hidden",
    // NO backgroundColor. The blur samples what is drawn behind it, and an
    // ancestor's background counts as behind it — a fill here would be blurred
    // into the result and flatten it. The fill is a sibling drawn AFTER the
    // blur instead: see sheetTint.
    //
    // NO border and no stroke. The overflow above is the whole edge treatment:
    // it is what stops the blur at the radius, and that stop is what the eye
    // reads as the boundary. See SHEET_RADIUS.
  },
  // Over the blur, under the content. Order in the tree is what makes this a
  // tint on the blur rather than something the blur eats.
  sheetTint: { backgroundColor: SHEET_FILL },
  // Fills the shell exactly and carries the border, so the shell's own layout
  // is untouched. Its radius MATCHES the shell's, which is what puts the line on
  // the shell's edge rather than floating inside it, and what makes the corners
  // curve instead of meeting.
  sheetEdge: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 1, borderColor: SHEET_EDGE, borderRadius: SHEET_RADIUS,
  },
  // OUT OF FLOW, which is the layout guarantee. `top` is set at the call site
  // from the safe-area inset. alignItems centre so the card is only as wide as
  // its message rather than a full-width bar.
  toastWrap: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  toastCard: { paddingVertical: 10, paddingHorizontal: 16 },
  // MONO because the thing being confirmed is usually a flight number, and
  // every flight number in this app is mono. 13 rather than the old 11: this is
  // now the only report of what happened, not a footnote under a card.
  toastText: { fontFamily: MONO, fontSize: 13, color: '#e2e2e2' },
  // Padding only.
  sheetBody: { padding: 20 },
  // FILL, because there is now a height to fill. The shell has a definite
  // minimum, so the body takes all of it and the list takes what is left after
  // the header — which is what bounds the list, and an unbounded ScrollView
  // does not scroll. Only a sheet with a fixed height may use this: flex: 1 in
  // an auto-height parent collapses to nothing.
  sheetBodyFill: { flex: 1 },
  // More above than below. sheetBody's 20 put the title the same distance from
  // the top edge as the rule was from the title, so the header read as pinned
  // to the ceiling rather than seated under it. 8 more above makes it 28 and 18.
  sheetHead: {
    flexDirection: "row", alignItems: "center",
    marginTop: 8,
    paddingBottom: 14, marginBottom: 4,
    borderBottomWidth: 1, borderBottomColor: SHEET_RULE,
  },
  // The close button's LAYOUT width: 20pt glyph + 4pt padding each side, less
  // the 4pt it outdents. Matching it exactly is what centres the title on the
  // sheet rather than on the space left beside the button.
  sheetHeadSpacer: { width: 24 },
  sheetTitle: {
    flex: 1, fontSize: 13, color: "#ffffff", fontFamily: MONO_BOLD,
    textAlign: "center",
  },
  // Identical to routeCalClose. The padding is the touch target the ring used
  // to imply, and the negative margin lets the glyph sit level with the edge of
  // the content rather than one padding-width inside it.
  sheetClose: { paddingVertical: 4, paddingHorizontal: 4, marginRight: -4 },
  // A FLOOR AND A CEILING. More than half the screen whatever is in it, and
  // never so tall that the scrim disappears at both ends.
  archiveSheet: { minHeight: "62%", maxHeight: "82%" },
  archiveEmpty: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS,
    textAlign: "center", lineHeight: 18, paddingVertical: 12,
  },
  // Negative margin then equal padding, so a row's hairline runs the full width
  // of the sheet while its text still lines up with the heading above it.
  //
  // flex: 1 completes the chain from sheetBodyFill. It is what gives the list a
  // definite height — everything below the header — and a ScrollView only
  // scrolls once it has one. Without it the list would run past the bottom of
  // the sheet at the ceiling and simply be clipped.
  archiveList: { marginHorizontal: -20, paddingHorizontal: 20, flex: 1 },
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
  // THE SAME EDGE, and only the edge.
  //
  // A pill is about 24pt tall and sits in the page's own flow rather than over a
  // scrim, and two of the four layers stop making sense at that size.
  //
  // No blur: what is behind a pill is the page background, a flat #050505.
  // Blurring a flat colour returns the same flat colour, so six BlurViews would
  // buy nothing and cost a captured, downscaled redraw each per frame.
  //
  // No SHEET_FILL either, and this is the one that looks wrong until the
  // arithmetic is done. That fill is black; its job is to darken a BLURRED
  // IMAGE. Over an opaque page there is no image, so 0.22 black on rgb(5) lands
  // at rgb(4) — it would take away the 0.03 white lift that is currently the
  // only thing separating a pill from the page and give nothing back. The lift
  // stays as it is.
  //
  // The radius is 8, up from 4 and not the sheets' 16. A pill is about 24pt
  // tall — 11pt of MONO between 5pt of padding each side — so its capsule
  // radius, the point past which the ends are pure semicircles and the shape
  // stops being a rectangle at all, is exactly half that: 12. SHEET_RADIUS at 16
  // is beyond even that and would simply be clamped to a capsule.
  //
  // 8 is two thirds of the way there. It leaves 24 - 16 = 8pt of straight run
  // down each side, which is what keeps the pill reading as a rounded rectangle
  // rather than a lozenge, and it is double what it was.
  //
  // So one thing translates, and it is the one that reads as material rather
  // than as size: the hairline, at the same 0.08 as every other glass edge,
  // down from its own 0.12.
  routeDrop: {
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 8,
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
    // NO backgroundColor. It was an opaque #050505, which is what made the panel
    // a solid card rather than a surface. The fill is now a sibling drawn AFTER
    // the blur, inside GlassLayers.
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: SHEET_RADIUS,
    // Keeps the scrolling contents — and now the blur — inside the corners.
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
    // The shared scrim, down from its own 0.72. That value was set when the
    // sheet behind it was opaque and nothing had to be seen through it.
    backgroundColor: SHEET_SCRIM,
    justifyContent: 'flex-end',
  },
  // A BOTTOM sheet, which is the one structural difference from the others: it
  // is flush with the bottom of the screen, so it has three edges rather than
  // four and two rounded corners rather than four. "The same edge" therefore
  // means the same colour and the same weight on the edges it actually has —
  // a fourth line across the bottom would be an edge where the sheet does not
  // end. The per-side WIDTHS stay as they are, and only the colour is shared:
  // it is mismatched border COLOURS that make React Native abandon the corner
  // radius and split each arc, and every side here still agrees on 0.08.
  sheet: {
    // NO backgroundColor: the blur samples what is behind it, and an ancestor's
    // fill would be flattened into the result. GlassLayers carries both.
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: SHEET_EDGE,
    // Clips the blur to the two rounded corners.
    overflow: 'hidden',
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 52,
    alignItems: 'center',
  },
  // Drawn over GlassLayers and under the content, the same slot the shared
  // tint occupies inside it.
  tint: { backgroundColor: PROFILE_FILL },
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