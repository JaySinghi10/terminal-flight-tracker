// THE SEARCH SCREEN.
//
// Every line of this was app/index.tsx's and every line is unchanged but for the
// four edits recorded below. It moved because searching stopped being something
// the home screen does: the field is the tab bar's, the tab bar navigates here,
// and home is the watchlist.
//
// THERE IS NO INPUT ON THIS SCREEN, and there must not be. What has been typed
// arrives through lib/query.tsx, which the tab bar's field writes to. The prompt,
// the TextInput, the animated placeholder and the underline that used to sit at
// the top of home were deleted rather than moved, because the bar already renders
// all four.
//
// SO EXECUTE IS THE TRIGGER, and it is the only one. The bar's field has no
// submit wiring and this screen may not add any, so the button below is what
// spends units — which is what the natural-language rung needs anyway: the first
// press buys the reading, the second spends. Everything free happens without a
// press, exactly as it did, because parseSearchQuery runs during render off the
// query. Pressing Return on the keyboard now dismisses it and searches nothing.
//
// THE FOUR EDITS THE MOVE FORCED.
//
//   1  The route row clears chatResponse. runFlightLookup used to do it and no
//      longer can — see lib/flightcard.tsx. The clear moved to the one call site
//      that did not already have its own; handleSearch's is untouched.
//   2  The query's own side effects became an effect. They were onChangeText's
//      on an input that no longer exists here, and one of them matters: editing
//      the query abandons a chosen date, which is what stops a 4-unit dated
//      search running against a different route.
//   3  The account is watched rather than told. clearResultView used to be called
//      by sign-in and logout, both of which live in home's profile modal; home
//      cannot reach this screen's results, so this watches `email` on the store
//      and clears itself when the account actually changes.
//   4  detailsTitle and headingRow read as `c.*`. They are two entries both
//      screens need, and they are in lib/cards.ts now.
import { useState, useRef, useEffect, useCallback } from "react";
// COMING BACK TO THIS TAB IS A FOCUS EVENT, NOT A MOUNT. The tabs navigator keeps
// this screen mounted when it loses focus, so nothing else can see the return.
import { useFocusEffect } from "expo-router";
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import { BlurView } from 'expo-blur';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  Pressable,
  Dimensions,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { savedFlightFromApi, makeFlightId, ISO_DAY_RE } from '../lib/storage';
import { airlineFromFlightNumber } from '../lib/airlines';
import { clock24 } from '../lib/time';
import {
  useSaved,
  API_BASE,
  flightUrl,
  NO_TIME,
  SAVE_MSG,
  effectiveStatus,
  localIsoDate,
} from '../lib/saved';
import {
  getStatusColor,
  WEEKDAYS,
  MONTHS,
  routeDateLabel,
  stripZoneLabel,
  formatCountdown,
} from '../lib/flightstatus';
import {
  SHEET_RADIUS, SHEET_EDGE, SHEET_SCRIM,
  GlassLayers,
  EASE_OUT, EASE_IN, OVERLAY_RISE, CAL_RISE,
  PANEL_IN_MS, PANEL_OUT_MS, CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  g,
} from '../lib/glass';
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG, c } from '../lib/cards';
// WHAT THE TAB BAR'S FIELD HAS BEEN GIVEN. This screen reads it and never writes
// it, except to clear it — see clearResultView.
import { useQuery } from '../lib/query';
import { useToast } from '../lib/toast';
import { useFlightCardHost, FlightError } from '../lib/flightcard';
import {
  FlightCard,
  resultWrap,
  trimAirportName,
  flightDataFromApi,
} from '../components/FlightCard';
// THE MAP BEHIND EVERYTHING. Geometry and place names, absoluteFill under the
// whole screen, with its own pan and pinch. See the note at the call site for
// what that means for touches.
import GlobeMap, { type GlobeMapHandle } from '../components/GlobeMap';
// WHERE THE MAP OPENS AND HOW IT REMEMBERS. The timezone answer is synchronous
// and always available; location only ever improves on it. See lib/home.ts.
import {
  timezoneHome, loadHome, saveHome, clearHome,
  loadConsent, saveConsent, SIGNED_OUT_SCOPE, LOCATION_TIMEOUT_MS,
  type HomeView,
} from '../lib/home';
import * as Location from 'expo-location';
// THE GMAIL TOKEN, for the /chat request below. It is written on home, by the
// sign-in and the logout in the profile modal, and read here. See lib/account.tsx.
import { useAccount } from '../lib/account';
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

export default function Search() {
  // THE QUERY IS THE BAR'S, and this screen only reads it. setQuery is here for
  // one purpose: clearResultView wipes the line when the account changes, exactly
  // as it did when sign-in and logout called it on home.
  const { query, setQuery, submitCount } = useQuery();
  const { savedFlights, email, saveRecord, refreshOne } = useSaved();
  const { showToast } = useToast();
  const { gmailToken } = useAccount();
  // EVERYTHING A SCREEN NEEDS TO OWN A FLIGHT CARD. One copy, shared with home,
  // so a card opened from a route row and a card opened from a watchlist row are
  // driven by the same lookup, the same save and the same entry animation.
  const {
    now,
    flight, setFlight,
    flightRecord, setFlightRecord,
    error, setError, setErrorCounter,
    setSaveError,
    loading, setLoading,
    setLastUpdated,
    errorMsgOpacity, resultOpacity, resultTranslate,
    showResult,
    runFlightLookup, refreshFlightCard, handleToggleSave,
    isSaved,
  } = useFlightCardHost();
  const insets = useSafeAreaInsets();

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

  // The hook, not Dimensions.get: this has to re-render on rotation, or the
  // labels would keep the width they were built for.
  const { width: routeWinWidth } = useWindowDimensions();
  const btnScale = useRef(new Animated.Value(1)).current;

  // Four values, not two: each overlay drives its content and its scrim
  // separately, so the backdrop can run its own timing. Every property either
  // value touches is opacity or transform, so all of it is native-driven and
  // none of it can move the layout underneath.
  const routePanelAnim = useRef(new Animated.Value(0)).current;
  const routeScrimAnim = useRef(new Animated.Value(0)).current;
  const routeCalAnim = useRef(new Animated.Value(0)).current;
  const routeCalScrimAnim = useRef(new Animated.Value(0)).current;

  // WHAT THE COMMAND LINE'S onChangeText DID, and it had to survive the input.
  //
  // Two statements, and the second is the one that matters. The date belongs to
  // the route that was typed: editing the query abandons it rather than silently
  // carrying a 4-unit dated search onto a different route. The first simply stops
  // an error sitting under a line the user is already rewriting.
  //
  // AN EFFECT RATHER THAN A HANDLER, because the handler was a prop on a
  // TextInput this screen does not have. It fires on exactly what the handler
  // fired on — the query changing — and its two writes are both no-ops on mount.
  useEffect(() => {
    setError("");
    setRouteDate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // THE ACCOUNT CHANGED, so the results are somebody else's.
  //
  // clearResultView used to be called directly by sign-in and by logout, both of
  // which are in home's profile modal. Home cannot reach this screen's state, so
  // this watches the one thing those two actually change and does it here.
  //
  // A REF RATHER THAN A BARE DEPENDENCY, so mounting is not treated as a change.
  // The screen mounts long after hydration, with an account already in hand;
  // clearing on that first pass would wipe a query the user had just typed to get
  // here.
  //
  // THE MAP WATCHES THE SAME SIGNAL SEPARATELY, further down, where its own state
  // is declared. One effect could have done both, but it would have had to reach
  // forward four hundred lines for refs it does not otherwise touch.
  const lastEmail = useRef(email);
  useEffect(() => {
    if (lastEmail.current === email) return;
    lastEmail.current = email;
    clearResultView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // RETURN ON THE TAB BAR'S FIELD, AND IT IS THE ONLY WAY A SEARCH RUNS.
  //
  // The bar cannot call handleSearch — it must not know what a search is, and it
  // has no callback prop to be handed one through. So it increments a counter on
  // lib/query.tsx and this watches it. The bar states the intent; this performs
  // it.
  //
  // ON THE CHANGE, NOT THE VALUE, which is what makes two identical searches in
  // a row two searches. The ref is seeded with the count as it stands at mount,
  // so mounting is not a press: this screen mounts when the Search tab is first
  // opened, long after the provider, and running a search on arrival would spend
  // units nobody asked for.
  //
  // AN EMPTY QUERY COSTS NOTHING, and no guard is added here for it.
  // handleSearch dismisses the keyboard, clears the view and returns on its own
  // `if (!cleaned)` with the same message Execute used to show, before any fetch
  // — so Return on an empty field reports and spends exactly what pressing
  // Execute on one did.
  const lastSubmit = useRef(submitCount);
  useEffect(() => {
    if (lastSubmit.current === submitCount) return;
    lastSubmit.current = submitCount;
    handleSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitCount]);

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
        return;
      }

      const record = savedFlightFromApi(data);
      // THE WHOLE SAVE IS saveRecord's, the undo check included — the window
      // belongs to the flight, not to the control that closed it. What is left
      // here is this path's own wording for the three endings, which is the
      // error channel and a shake where the card raises a toast.
      const outcome = await saveRecord(record);
      if (outcome.kind === 'restored') { showToast('restored'); return; }
      if (outcome.kind === 'limit') {
        setError('watchlist limit reached \u2014 unsave one first');
        setErrorCounter(c => c + 1);
        return;
      }
      // Reminders on by default, exactly as the card's bookmark does it.
      showToast(SAVE_MSG[outcome.remind]);
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
    } finally {
      setRouteSavingKey(null);
    }
  };

  const handleSearch = async () => {
    // FIRST, and before the empty-query guard: the keyboard should go whether or
    // not there was anything to search for. Pressing enter already dismisses it
    // — blurOnSubmit does that — and Execute is the same instruction given with
    // a thumb, so it should leave the screen in the same state.
    Keyboard.dismiss();
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
          return;
        }
        // Nothing is searched on this press. The reading goes on screen and the
        // user decides whether it is right.
        setNlRead({ q: query, v: nlReadReply(data as ParseReply) });
        return;
      } catch {
        setError("Could not reach the server. Please check your connection and try again.");
        setErrorCounter(c => c + 1);
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
        return;
      }

      setChatResponse(data.response);
      if (data.flight) {
        // THE RECORD FIRST, as in runFlightLookup, so one clock check serves both
        // it and the card. This was the last flightDataFromApi call site passing
        // no effective status, and the omission was visible: computeProgress
        // reads flightRecord and has applied the demotion since it was written,
        // so a record claiming to have landed before its own arrival time drew
        // an EMPTY progress bar under a badge that still said LANDED. The card
        // disagreed with itself.
        const record = savedFlightFromApi(data.flight);
        setFlight(flightDataFromApi(data.flight, effectiveStatus(record, Date.now())));
        setFlightRecord(record);

        // THE STORAGE WRITE IS GATED, and this path is the reason the gate has
        // to exist here rather than upstream.
        //
        // THIS PATH CANNOT PIN A LEG. The assistant's tools call
        // fetch_flight_full with the flight number alone — no date, no origin —
        // because a sentence like "is my flight on time" names neither, and the
        // model is deliberately not allowed to invent them. So _select_item
        // chooses both the day and the leg, and for a tag flight it returns
        // whichever leg arrives first regardless of which one is saved.
        //
        // touchSavedFlight spreads the response over any record sharing the id,
        // and the id is the number and the date — which BOTH legs of a tag
        // flight share. Unguarded, asking the assistant about AI1780 could
        // rewrite a saved IDR-BOM record as DEL-IDR: endpoints, times, terminal,
        // gate and status, silently, without the user having done anything but
        // ask a question. That is the fault 879c1f8 fixed everywhere it could
        // pass an origin, still reachable through the one path that cannot.
        //
        // So the departure airport is the check. An airline does not change
        // where a flight leaves from; a different departure IATA under the same
        // id means a different leg, and the only safe thing to do with it is
        // nothing. The card still shows the response — the user asked for it and
        // it is a real flight — and only the write is suppressed.
        //
        // NO GUARD FOR "NOT SAVED", deliberately. touchSavedFlight returns null
        // when the id is not in the store, so an unsaved flight falls through to
        // a call that does nothing. A second check here would be a second answer
        // to a question that function already answers.
        const stored = savedFlights.find(f => f.id === record.id);
        const wrongLeg = stored !== undefined && stored.from.iata !== record.from.iata;
        if (!wrongLeg) await refreshOne(record);
        setLastUpdated(record.updatedAt);
      }
      showResult();
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
    } finally {
      setLoading(false);
    }
  };

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

  // ── THE MAP CAMERA ────────────────────────────────────────────────────────
  //
  // KEYED ON THE PAIR OF CODES AND NOT ON routeResult, whose identity changes
  // whenever the board is refetched or a filter is applied. Depending on the
  // object would fly the camera back to the route every time the results list
  // was touched, undoing any pan the user had made since it arrived.
  const mapRef = useRef<GlobeMapHandle>(null);
  const flownFrom = routeResult === null ? null : routeResult.origin;
  const flownTo = routeResult === null ? null : routeResult.destination;
  useEffect(() => {
    if (flownFrom === null || flownTo === null) return;
    mapRef.current?.flyRoute(flownFrom, flownTo);
  }, [flownFrom, flownTo]);

  // ── THE HOME VIEW, PER ACCOUNT ────────────────────────────────────────────
  //
  // KEYED ON THE ACCOUNT, WHICH IS WHAT FIXES TWO BUGS AT ONCE.
  //
  // It used to be a mount-only effect with an empty dependency list, so it ran
  // exactly once in the screen's life. A second account signing in was handled
  // somewhere else entirely — by a watcher that substituted the timezone view
  // directly — so resolution never re-ran and the second account was never
  // asked for location. That watcher is gone; this effect replaces it, because
  // "the account changed" and "work out where home is" were always the same
  // event described twice.
  //
  // THE SCOPE IS THE DEPENDENCY. Signing in, signing out and switching accounts
  // are all one thing to React: the scope string changed, so resolve again.
  //
  // THE ORDER WITHIN A SCOPE IS: STORED, THEN PERMISSION, THEN TIMEZONE.
  //   1  a stored home for THIS account is authoritative and costs one disk read
  //   2  otherwise ask for location, once per account, ever
  //   3  otherwise the timezone, which is free and always answers
  //
  // THE MAP HAS ALREADY OPENED ON THE TIMEZONE by the time any of this resolves,
  // because that answer is synchronous and baked into the page. What happens
  // here can only improve it.
  const homeScope = email ?? SIGNED_OUT_SCOPE;
  const [home, setHome] = useState<HomeView | null>(null);
  // WHETHER TO SHOW THE IN-APP PROMPT. True only while this scope's consent is
  // undecided; both answers clear it and neither can come back without a
  // deliberate clear from the profile page.
  const [askConsent, setAskConsent] = useState(false);
  const homeSentRef = useRef(false);
  const prevScopeRef = useRef<string | null>(null);

  // ── THE OS SIDE, WHICH IS THE OTHER OF THE TWO FACTS ──────────────────────
  //
  // RETURNS A HomeView OR null, AND NEVER THROWS. Refusal, revocation, missing
  // hardware and a fix that never lands all mean the same thing to the caller:
  // there is no position, use the country view.
  //
  // THE TIMEOUT IS A RACE BECAUSE getCurrentPositionAsync TAKES NONE and cannot
  // be cancelled. A cold fix runs for tens of seconds and hardware that is off
  // may never settle — and a promise that never settles is not a rejection, so
  // a catch cannot see it. The losing promise is abandoned rather than stopped;
  // there is no abort signal to give it, and if a fix lands later it resolves
  // into nothing.
  const positionOrNull = useCallback(async (): Promise<HomeView | null> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log(`[HOME][OS] permission ${status}`);
      if (status !== 'granted') return null;
      console.log(`[HOME][OS] waiting up to ${LOCATION_TIMEOUT_MS}ms for a fix`);
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({
          // Balanced accuracy: this frames a country, and asking the device for
          // metres would cost battery and time for digits nobody sees.
          accuracy: Location.Accuracy.Balanced,
        }),
        new Promise<null>((r) => setTimeout(() => r(null), LOCATION_TIMEOUT_MS)),
      ]);
      if (pos === null) {
        console.log('[HOME][OS] TIMED OUT');
        return null;
      }
      console.log('[HOME][OS] got a fix');
      return { kind: 'position', lon: pos.coords.longitude, lat: pos.coords.latitude };
    } catch (e) {
      console.log(`[HOME][OS] failed: ${String(e)}`);
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const previous = prevScopeRef.current;
    const switched = previous !== null && previous !== homeScope;
    prevScopeRef.current = homeScope;
    // A NEW SCOPE HAS NOT BEEN SENT TO THE MAP YET, whatever the old one did.
    homeSentRef.current = false;
    // EVERY RUN OF THIS EFFECT, WITH THE SCOPE IT RAN FOR. If the scope is not
    // changing, this line is the proof: it prints once and never again.
    console.log(`[HOME] === RUN === scope="${homeScope}" previous="${previous ?? 'none'}" switched=${switched} email=${email === null ? 'null' : email}`);

    (async () => {
      // ── FORGET THE PREVIOUS ACCOUNT FIRST, BEFORE ANYTHING ASYNC ───────────
      //
      // The old home is dropped from state immediately, which hides the button
      // and stops the previous person's view being the one on screen while the
      // new scope resolves. The map is told the timezone view in the same pass,
      // which empties the pin source — see applyHome, where the pin and the
      // camera move together so there is no frame with one and not the other.
      //
      // NOT ON FIRST MOUNT. There is no previous account to forget, and forcing
      // the timezone here would throw away a stored position before it had a
      // chance to load.
      if (switched) {
        console.log(`[HOME] 0b. scope ${previous} -> ${homeScope}, forgetting`);
        // WHAT THE PAGE HELD BEFORE WE TOUCHED IT. If this reports a position
        // and a pin after a logout, the page was never told — and the storage
        // keys are innocent.
        mapRef.current?.probe(`before forget (${previous} -> ${homeScope})`);
        setHome(null);
        mapRef.current?.setHome(timezoneHome());
        mapRef.current?.probe('after forget');
        // SIGNING OUT WIPES THE SIGNED-OUT SCOPE, so a session that follows a
        // logout never inherits anything from the one before it. An ACCOUNT's
        // own scope is deliberately left alone: that is what lets signing back
        // in restore the pin without a second prompt.
        if (homeScope === SIGNED_OUT_SCOPE) await clearHome(SIGNED_OUT_SCOPE);
      }
      if (!alive) return;

      console.log(`[HOME] 1. resolving for ${homeScope}`);
      const stored = await loadHome(homeScope);
      if (!alive) return;
      if (stored !== null) {
        console.log(`[HOME] 2. from disk (${stored.kind})`);
        setHome(stored);
        return;
      }

      // ── THE COUNTRY VIEW IS THE ANSWER UNTIL CONSENT SAYS OTHERWISE ────────
      //
      // Resolved first and used unless everything below agrees to replace it, so
      // there is no path on which an unconsented position reaches the map.
      const country = timezoneHome();
      const consent = await loadConsent(homeScope);
      if (!alive) return;
      console.log(`[HOME] 2. nothing on disk; consent=${consent ?? 'undecided'}`);

      if (consent === 'declined') {
        // NEVER ASKED AGAIN, AND NO ERROR. The country view is not a degraded
        // state, it is the answer this account chose.
        console.log('[HOME] 3. declined previously, country view');
        setHome(country);
        void saveHome(homeScope, country);
        return;
      }

      if (consent === null) {
        // UNDECIDED. Country view now, and raise the in-app prompt — the OS
        // cannot be trusted to ask, because on a device where permission is
        // already granted it returns granted with no dialogue at all. That was
        // the whole bug: a second account silently inheriting a position.
        console.log('[HOME] 3. undecided, country view + asking in-app');
        setHome(country);
        setAskConsent(true);
        return;
      }

      // CONSENT IS 'granted'. That is OUR fact; the OS grant is a SECOND and
      // independent one, and both have to be true. A user who allowed it here
      // and later revoked it in Settings gets the country view, not an error.
      const pos = await positionOrNull();
      if (!alive) return;
      if (pos === null) {
        console.log('[HOME] 3. consented but no position available, country view');
        setHome(country);
        void saveHome(homeScope, country);
        return;
      }
      console.log('[HOME] 3. consented and located');
      setHome(pos);
      void saveHome(homeScope, pos);
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeScope]);

  // ── THE TWO ANSWERS ───────────────────────────────────────────────────────
  //
  // BOTH RECORD BEFORE THEY ACT, so a crash between the answer and its
  // consequence cannot lose the decision and ask again.
  //
  // ACCEPTING IS NOT THE SAME AS HAVING A POSITION. The user agrees here; the OS
  // is then asked separately, and may refuse, or may grant and never produce a
  // fix. Consent is still recorded as granted in that case — they said yes, and
  // re-asking them because their GPS was cold would be asking the wrong
  // question. The country view stands until a later launch finds a fix.
  const acceptLocation = useCallback(async () => {
    console.log('[HOME] consent: accepted');
    setAskConsent(false);
    await saveConsent(homeScope, 'granted');
    const pos = await positionOrNull();
    if (pos === null) {
      console.log('[HOME] consent: accepted but no position; country view stands');
      return;
    }
    setHome(pos);
    homeSentRef.current = false;
    void saveHome(homeScope, pos);
  }, [homeScope, positionOrNull]);

  // A DECLINE IS FINAL FOR THIS SCOPE and produces no error, no toast and no
  // second chance from the map. The profile control is where it can be undone.
  const declineLocation = useCallback(() => {
    console.log('[HOME] consent: declined');
    setAskConsent(false);
    void saveConsent(homeScope, 'declined');
  }, [homeScope]);

  // THERE IS NO PURGE EFFECT HERE, AND THAT IS THE POINT. Discarding the v1 and
  // v2 keys used to be its own useEffect beside this one, which meant the order
  // the two async bodies interleaved decided whether a read could see a legacy
  // key — an ordering that held only until someone moved a hook. lib/home.ts now
  // awaits the purge inside every accessor, so a read cannot happen before it
  // whatever this screen does. See the note at purgeLegacyHome.

  // SENT WHEN BOTH SIDES ARE READY, whichever arrives last — the map's style may
  // parse before or after the disk read returns, and this must not depend on
  // which. The ref makes it exactly once.
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (!mapReady || home === null || homeSentRef.current) return;
    homeSentRef.current = true;
    mapRef.current?.setHome(home);
  }, [mapReady, home]);

  // ── COMING BACK TO THE TAB RETURNS TO HOME ────────────────────────────────
  //
  // A FOCUS EFFECT AND NOT A MOUNT EFFECT, because this screen does not unmount
  // when the tab loses focus — that is the whole reason a tab navigator was
  // chosen, and it is why leaving and returning used to find the camera exactly
  // where it was abandoned. Mount fires once in the app's life; focus fires
  // every time the user comes back, which is the actual event.
  //
  // NOT ON THE FIRST FOCUS. The camera already opens on home, so flying from
  // home to home would be a 1.6 second animation that starts and ends in the
  // same place — a glitch rather than a motion. The ref is checked and set on
  // the first pass and never consulted again.
  //
  // THE SAME MOTION THE BUTTON USES, deliberately: returning to the tab and
  // pressing home are the same intent, and two spellings of it would eventually
  // become two behaviours.
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      // A no-op until the page has been told where home is, which is what we
      // want: there is nothing to return to yet.
      mapRef.current?.goHome();
    }, []),
  );

  // FORGETTING ON LOGOUT IS NOT A SEPARATE EFFECT ANY MORE. It used to be one,
  // watching `email` and substituting the timezone view directly — which is
  // exactly why a second account was never prompted: the substitution WAS the
  // resolution, so the real resolution never ran again. The scope-keyed effect
  // above now covers signing in, signing out and switching, because all three
  // are the same event: the scope changed.


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
        // Same reasoning as handleSearch and renderSavedFlight: this tap opens
        // the card, and keyboardShouldPersistTaps lets it through with the
        // keyboard still up.
        // setChatResponse HERE, and it is the one line in this file that did
        // not simply move. runFlightLookup used to clear chatResponse itself, in
        // the branch it takes when it is not keeping the card visible. That state
        // is the search screen's now — only this screen can render a chat
        // response — so the lookup, which is shared with home, can no longer
        // reach it. The clear moved to the one call site that did not already
        // have its own: handleSearch clears at the top of every press, and this
        // did not. Same batch, same frame, same effect.
        onPress={() => { Keyboard.dismiss(); setChatResponse(null); runFlightLookup(r.flight_number, false, rowDate, origin || null); }}
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

  const openRouteCal = () => {
    // As in handleSearch. The sheet comes up from the bottom, which is exactly
    // where the keyboard is.
    Keyboard.dismiss();
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
    // As in handleSearch, and here it is more than tidiness: this panel is
    // placed into whatever space the arithmetic below says is free, and a
    // keyboard is the one thing on screen that occupies space without being part
    // of the window the arithmetic measures.
    //
    // IT DOES NOT FIX THE ARITHMETIC. Keyboard.dismiss() is asynchronous and the
    // measureInWindow callback runs while the keyboard is still on screen — see
    // the note on spaceBelow below for what that does and does not mean.
    Keyboard.dismiss();
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
        // MEASURED AGAINST THE WINDOW, WHICH HAS NEVER KNOWN ABOUT THE
        // KEYBOARD. On iOS Dimensions.get('window') is the full window whether
        // or not a keyboard is up, so this figure did not shrink when one
        // appeared and does not grow when one leaves — it was always the height
        // of the screen. The keyboard could therefore sit inside "free" space
        // and a panel could be placed underneath it. Dismissing above does not
        // correct the number; it makes the number true, by removing the thing it
        // was already ignoring.
        //
        // What can still be stale is wy, not the height: the dismiss has not
        // completed when this callback runs, so if the keyboard's presence had
        // scrolled the anchor, this is where the anchor was rather than where it
        // will be.
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
      {/* THE MAP, AND IT IS THE FIRST CHILD SO EVERYTHING ELSE PAINTS OVER IT.
          absoluteFill, under the whole screen.

          IT TAKES TOUCHES NOW, which it did not at step 1: it carries its own
          pan and pinch, and it is the SURFACE of this screen rather than a
          picture behind one. The two full-screen boxes in front of it — the
          KeyboardAvoidingView and the ScrollView — are box-none for exactly
          that reason, so a finger lands on the map wherever this screen draws
          nothing. See the note there.

          NOTHING ON THE SCREEN LOST A TOUCH. Every control is a child of one of
          those two, and box-none leaves children alone. */}
      {/* THE CAMERA IS DRIVEN THROUGH A REF, NOT A PROP. A prop would make the
          flight a function of render — it would re-fire on any re-render that
          happened to carry the same route, and it could not express "fly now"
          distinctly from "a route exists". The effect above decides WHEN. */}
      <GlobeMap ref={mapRef} onReady={() => setMapReady(true)} />
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
      <Modal visible={routeCalOpen} transparent animationType="none" onRequestClose={closeRouteCal}>
        <Pressable style={g.routeCalScrim} onPress={closeRouteCal}>
          {/* The dim is its own layer so it can fade on its own curve. Folding it
              into the sheet's value would drag the whole backdrop through the
              sheet's travel and scale.

              Full screen, unblurred, and identical to the archive sheet's: the
              blur belongs to the panel, not to the backdrop. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: routeCalScrimAnim }]}
          />
          <Animated.View
            style={[
              g.sheetShell,
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
            <View style={g.sheetEdge} pointerEvents="none" />
            <Pressable style={g.sheetBody}>
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
      {/* box-none ON BOTH THIS AND THE ScrollView, so a finger reaches the map
          wherever this screen has nothing drawn.

          WHAT box-none MEANS HERE: the view itself stops being a hit target and
          its children do not. Both of these are full-screen boxes with nothing
          painted in them, so without it they would swallow every touch on an
          empty part of the screen and the map underneath could never be reached.
          Their CONTENTS are untouched — the affordance line, the route rows, the
          card and every control still take their own touches exactly as before,
          because each of those is a child and children are unaffected.

          AND THE ScrollView STILL SCROLLS. Its content container is left at the
          default, so it remains a hit target over its own bounds; a drag that
          starts on content is hit-tested to that container, the scroll view is
          its ancestor, and the pan recogniser fires as it always did. What
          changes is only what happens BELOW the content, where there is nothing
          to scroll to anyway. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1, paddingTop: insets.top + 12 }}
        pointerEvents="box-none"
      >
        {/* The same clearance home gives the floating bar, and for the same
            reason: the list ends under the glass and scrolls past behind it. */}
        <ScrollView
          contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          pointerEvents="box-none"
        >

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

          <FlightError error={error} errorMsgOpacity={errorMsgOpacity} />

          {/* THE EXECUTE BUTTON IS GONE. Return on the tab bar's field is the
              only trigger now — see the submit watch above — so a second control
              saying the same thing would be a second way to spend units.

              AND THE SPINNER WENT WITH IT. That button was the one place
              `loading` was ever shown; it is now shown nowhere on this screen.
              Nothing has been invented to replace it. */}

          {chatResponse && (
            <Animated.View style={[resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View style={{ marginBottom: 4 }}>
                <Text style={c.detailsTitle}>{'response'}</Text>
                <Text style={{ fontFamily: SANS, color: '#e2e2e2', fontSize: 13, lineHeight: 22 }}>{chatResponse}</Text>
              </View>
            </Animated.View>
          )}
          {/* Mutually exclusive in RENDER only: routeResult survives in state
              behind an open card, so closing the card restores this list. */}
          {routeResult && !flight && (
            <Animated.View style={[resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View>
                <View style={c.headingRow}>
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
            // THE ENTRY ANIMATION STAYS ON THE OUTSIDE and keeps this transform
            // to itself. showResult() drives it, the Swipeable inside drives its
            // own translation, and the two compose without either having to know
            // about the other.
            //
            // s.resultWrap IS ON THE VIEW BELOW, not this one. It went in with
            // the content while the Swipeable wrapped the whole result; the
            // Swipeable wraps the card alone now and the route block is its
            // sibling, so the gap moved to whichever element holds them both —
            // which is the exit wrapper, not this.
            <Animated.View
              style={{ opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }}
            >
              {/* THE CARD, AND EVERYTHING THAT IS THE CARD'S. The swipe, the
                  exit throw, the route row, the bar, the status line and the
                  sheet all moved to components/FlightCard.tsx unchanged. What is
                  passed in is what this screen knows and the card cannot: the
                  data, the record, the clock, whether this flight is saved, and
                  the three things the card is allowed to ask for. */}
              <FlightCard
                flight={flight}
                flightRecord={flightRecord}
                now={now}
                isSaved={isSaved}
                handleToggleSave={handleToggleSave}
                refreshFlightCard={refreshFlightCard}
                closeFlightCard={closeFlightCard}
              />
            </Animated.View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
      {/* ── HOME ──
          LAST CHILD OF s.root, AND THAT IS A FIX RATHER THAN A TIDY-UP. It used
          to sit directly after the map, before the KeyboardAvoidingView — and it
          was completely dead, because the ScrollView's content container renders
          after it and is a hit target over its own bounds. See the note at that
          ScrollView: box-none stops the two full-screen boxes taking touches,
          but the CONTENT CONTAINER is a child and children are unaffected. It is
          full width, starts at the same insets.top + 12 this button does, and
          has paddingBottom, so it has height even with no results. The button
          was underneath it and never saw a press.

          MAKING THE CONTAINER box-none WOULD HAVE FIXED IT AND BROKEN SCROLLING.
          That container is a hit target on purpose, so a drag beginning on a
          result card is hit-tested to it and the pan recogniser fires. Turning
          that off puts dead zones between the cards. Moving one element in the
          tree costs nothing and changes nothing else.

          TOP RIGHT, AND IT IS THE ONE CORNER NOTHING ELSE WANTS. The content
          below is left-aligned inside 20px of padding, the floating tab bar owns
          the bottom, and the left side is reserved for the place heading that
          comes next. Sitting it here means it never overlaps a control and never
          fights the bar.

          A GLASS CIRCLE IN THE BAR'S MATERIAL BUT SMALLER THAN ITS CIRCLE. The
          recipe is the bar's — blur, then a fill over it, then a hairline over
          that — so the two are the same family; the size is 40 against the bar's
          56 so they are not the same OBJECT. See HOME_BTN_SIZE for why that gap
          is deliberate.

          RENDERED ONLY ONCE HOME IS KNOWN. A button that returns you nowhere is
          worse than no button, and until the disk read or the timezone resolves
          there is nothing to return to. */}
      {/* ── THE LOCATION CONSENT PROMPT ──
          NOT A MODAL, AND THAT IS THE WHOLE TREATMENT. A dialogue over the map
          would stop the thing it is asking about being visible, and it would
          demand an answer before the user has any reason to care. This is a
          strip: the map keeps its whole surface, every gesture still works, and
          the question can be ignored indefinitely.

          IT SITS OPPOSITE THE HOME BUTTON, at the same y, running from the left
          margin to just clear of it. That is the only horizontal space on this
          screen that is reliably empty, and it puts the question at the top
          where a status line belongs rather than over the results.

          THE SAME GLASS AS THE BUTTON, so it reads as part of the map's own
          furniture rather than as something the app threw on top.

          TERMINAL, NOT A CARD. A prompt line beginning with > , the question in
          plain words, and two verbs. `allow` is green because green in this app
          means live and actionable and this is the only actionable thing on the
          map; `no` is at label ink because a refusal should not be styled as a
          lesser choice, only a quieter one.

          LAST CHILD, LIKE THE BUTTON, for the reason given there — anything
          rendered before the ScrollView is underneath its content container and
          cannot be pressed. */}
      {askConsent && (
        <View style={[cs.wrap, { top: insets.top + 12 }]} pointerEvents="box-none">
          <BlurView
            intensity={HOME_BTN_BLUR}
            tint="systemChromeMaterialDark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={[StyleSheet.absoluteFill, cs.fill]} pointerEvents="none" />
          <View style={[StyleSheet.absoluteFill, cs.edge]} pointerEvents="none" />
          <Text style={cs.q} numberOfLines={1}>{'> show your location'}</Text>
          <Pressable onPress={acceptLocation} hitSlop={10}>
            <Text style={cs.yes}>{'allow'}</Text>
          </Pressable>
          <Pressable onPress={declineLocation} hitSlop={10}>
            <Text style={cs.no}>{'no'}</Text>
          </Pressable>
        </View>
      )}
      {home !== null && (
        <Pressable
          style={[hm.btn, { top: insets.top + 12 }]}
          // THE FIRST STAGE, AND THE ONE MOST LIKELY TO BE MISSING. If pressing
          // the button prints nothing at all, the touch never reached this
          // Pressable and every later stage is irrelevant — see the report on
          // the ScrollView's content container, which is drawn after this and is
          // a hit target over its own bounds.
          onPressIn={() => console.log('[HOME] 0. pressIn reached the Pressable')}
          onPress={() => {
            console.log('[HOME] 6a. onPress fired');
            mapRef.current?.goHome();
          }}
          hitSlop={10}
        >
          {/* THE MATERIAL, IN THE ORDER THE TAB BAR BUILDS IT. The blur samples
              what is behind the surface; the fill is a SIBLING AFTER it, so it
              tints the blur rather than being something the blur samples. Get
              that order wrong and the fill goes into the sample and the whole
              thing turns grey.

              THE HAIRLINE IS ITS OWN VIEW AND NEVER A borderColor ON THE BLUR.
              A border on a rounded BlurView leaves artefacts at the corners
              where the border and the blur's own clip disagree; a sibling with
              its own borderRadius has no such seam.

              overflow hidden ON THE PRESSABLE is what clips the blur to the
              circle — a BlurView does not round itself. */}
          <BlurView
            intensity={HOME_BTN_BLUR}
            tint="systemChromeMaterialDark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={[StyleSheet.absoluteFill, hm.fill]} pointerEvents="none" />
          <View style={[StyleSheet.absoluteFill, hm.edge]} pointerEvents="none" />
          {/* THE GLYPH IS THE MAP'S PIN, RESTATED AT BUTTON SIZE. The pin out
              there is a translucent halo with a solid dot in it; here the halo
              is a stroked RING rather than a filled disc, because a 7% fill at
              this size is nothing at all. Both say the same thing — this point,
              marked — which is what makes the control and the thing it returns
              you to read as one idea rather than two.

              NOT A HOUSE. A house would mean the Home TAB, which is a different
              destination reached by a different control at the other end of
              this screen. */}
          {/* THE STROKE IS SET IN VIEWBOX UNITS, so it has to be widened as the
              glyph shrinks: 1.8 in a 24 box drawn at 18 renders 1.35 real pixels,
              which is what the ring was at the larger size. Leaving it at 1.5
              would have thinned the ring to 1.1 and made it the faintest mark on
              the screen. */}
          <Svg width={HOME_BTN_GLYPH} height={HOME_BTN_GLYPH} viewBox="0 0 24 24">
            <SvgCircle
              cx={12} cy={12} r={7.5}
              fill="none"
              stroke={HOME_BTN_INK_RING}
              strokeWidth={1.8}
            />
            <SvgCircle cx={12} cy={12} r={3.2} fill={HOME_BTN_INK_DOT} />
          </Svg>
        </Pressable>
      )}
    </View>
  );
}

// ── THE HOME CONTROL ────────────────────────────────────────────────────────
//
// Kept out of `s` because it belongs to the map layer rather than to the
// screen's content: `s` is padded and laid out for the results, and this floats
// over everything.
//
// 40 RATHER THAN THE BAR'S 56, AND THE GAP IS THE POINT.
//
// The tab bar's Home circle is SEARCH_CIRCLE = CAPSULE_H = 56. Matching it
// exactly made the two read as DUPLICATES: same size, same material, same shape,
// on screen at once, and only position and a small glyph to say that one
// navigates to another tab while this one moves the camera on the screen you are
// already on. Two identical-looking controls with different scopes is the
// confusion worth spending a number to avoid.
//
// THE MATERIAL STILL MATCHES, so they remain the same family; only the SIZE says
// "smaller scope". That is the one signal changed, and it is the cheapest one
// that separates them.
const HOME_BTN_SIZE = 40;
// 18 RATHER THAN A STRICT 22 * 40/56 = 15.7. Proportional is the right instinct
// and slightly wrong here: below about 16 the 1px ring stroke gets fragile, and a
// smaller surface needs a proportionally LARGER glyph to stay legible. 18 leaves
// 11 of clear glass on every side.
const HOME_BTN_GLYPH = 18;
// INTENSITY 32 RATHER THAN THE BAR'S 18. The bar sits over the page, which is
// already near-black; this sits over the MAP, which carries land, coastlines and
// labels. A weaker blur would let all of that read through the glyph.
const HOME_BTN_BLUR = 32;
// NEAR-OPAQUE, AND BLACK. The bar's fill is 0.12 because it only has to tint a
// blur of the page; this one has to stop a map showing through a 22px glyph, so
// it is doing the work the bar's fill never had to. Black cannot lighten
// anything — the only white on the surface is the hairline, drawn over the blur.
const HOME_BTN_FILL = 'rgba(5,5,5,0.82)';
// The same hairline every other surface in this app draws.
const HOME_BTN_EDGE = 'rgba(255,255,255,0.08)';
// The map's pin is #e2e2e2; these are that ink at the two weights the glyph
// needs, so the button and the mark it returns you to are the same colour.
const HOME_BTN_INK_RING = 'rgba(226,226,226,0.5)';
const HOME_BTN_INK_DOT = 'rgba(226,226,226,0.85)';

// THE CONSENT STRIP. Same material as the button, laid out as a row: it runs
// from the left margin to just clear of the button's 40px plus its 20px gutter
// plus 10 of air, so the two never touch on any width.
const cs = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 20,
    right: 20 + HOME_BTN_SIZE + 10,
    height: HOME_BTN_SIZE,
    borderRadius: HOME_BTN_SIZE / 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 12,
    overflow: 'hidden',
  },
  fill: { backgroundColor: HOME_BTN_FILL },
  edge: {
    borderWidth: 1,
    borderColor: HOME_BTN_EDGE,
    borderRadius: HOME_BTN_SIZE / 2,
  },
  // flexShrink so a narrow screen truncates the question rather than pushing the
  // two answers off the end. The verbs are the part that must survive.
  q: {
    flexShrink: 1,
    fontFamily: MONO,
    fontSize: 11,
    color: 'rgba(226,226,226,0.62)',
    letterSpacing: 0.3,
  },
  yes: {
    fontFamily: MONO,
    fontSize: 11,
    color: '#4ade80',
    letterSpacing: 0.3,
  },
  no: {
    fontFamily: MONO,
    fontSize: 11,
    color: 'rgba(226,226,226,0.45)',
    letterSpacing: 0.3,
  },
});

const hm = StyleSheet.create({
  btn: {
    position: 'absolute',
    right: 20,
    width: HOME_BTN_SIZE,
    height: HOME_BTN_SIZE,
    borderRadius: HOME_BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // WHAT CLIPS THE BLUR TO THE CIRCLE. A BlurView does not round itself, so
    // without this the glass is a square behind a round hairline.
    overflow: 'hidden',
  },
  fill: { backgroundColor: HOME_BTN_FILL },
  edge: {
    borderWidth: 1,
    borderColor: HOME_BTN_EDGE,
    borderRadius: HOME_BTN_SIZE / 2,
  },
});

// index.tsx's own entries, read above as `s.*` exactly as they were, plus the
// page's own two. Home keeps a root and a scroll of its own: they are each
// screen's layout rather than a shared thing, which is how profile.tsx has
// always had them too.
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  scroll: { paddingHorizontal: 20 },

  searchBtn: {
    paddingVertical: 8, paddingHorizontal: 0,
    // Pinned so swapping the label for the spinner cannot resize the row.
    minHeight: 40,
    alignItems: "center", justifyContent: "center",
  },
  searchBtnTxt: { fontSize: 15, color: "#4ade80", fontFamily: MONO_BOLD },
  searchBtnTxtOff: { color: "rgba(226,226,226,0.25)" },
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

// THE ONE ENTRY OF index.tsx's `sf` THAT IS THIS SCREEN'S: the x that clears a
// route result. A local sheet of the same name, so the call site reads as it did.
const sf = StyleSheet.create({
  remove: {
    fontSize: 20,
    color: 'rgba(248,113,113,0.55)',
    fontFamily: MONO,
    paddingLeft: 12,
  },
});
