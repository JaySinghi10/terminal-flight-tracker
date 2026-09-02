// THE FLIGHT CARD, AND THE SHEET IT OPENS.
//
// Every line of this was app/index.tsx's and every line is unchanged. It moved
// because the card is not the home screen's: it is what a flight IS on this
// device, and the search screen is going to render the same object from the same
// record. A second copy of a card this size is not a risk of drift, it is a
// guarantee of it.
//
// WHAT IS HERE: what a flight looks like once the wire has been read — FlightData
// and the mapping that builds it — the tiles and groups that put it on screen,
// the card itself, the sheet it grows into, the swipe on both, and the progress
// bar. WHAT IS NOT: anything that decides WHEN a card is shown or WHAT is done
// about it. The record, the toast, the undo banner, the entry animation and
// every provider call stayed on the screen, and the three things this component
// may ask for arrive as callbacks.
//
// IT REACHES NO STORE. useSaved is not imported here and must not be: a card
// renders what it is handed. The two things it does take from lib/saved are
// effectiveStatus and isArchived, which are that module's RULES rather than its
// state — lib/flightstatus.tsx imports the first for exactly this reason.
//
// THE EDITS THE MOVE FORCED, and there are only two kinds.
//
// `export` in front of thirteen names: the twelve app/index.tsx still reads, and
// TimeCell, which is exported because it is the declared return type of one of
// them.
//
// And the details sheet's two null guards on `flight`, which existed only because
// that Modal used to live outside the block that renders the card. Here `flight`
// is a non-optional prop and cannot be null, so the guards were not merely
// redundant, they were a type error. The comments explaining them went with them.
//
// The three stylesheets are index's own entries, lifted out of its `s`, `sf` and
// `pg` into local ones of the same names, so every render block below is
// character-for-character what it was.
import { useState, useRef, useEffect, useCallback } from "react";
import Svg, { Path } from 'react-native-svg';
// The Reanimated one, deliberately, and the same import app/index.tsx uses for
// the watchlist rows. See the note there.
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
// The same aliasing index.tsx uses, and this file needs BOTH systems rather than
// merely inheriting them: React Native's Animated drives the sheet's rise and the
// progress bar, Reanimated drives the swipe and its exit throw. The card kept
// both when it moved because neither can do the other's job.
import Reanimated, {
  useAnimatedStyle, useSharedValue,
  runOnJS, type SharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Modal,
  Pressable,
  Dimensions,
} from "react-native";
import { SavedFlight } from '../lib/storage';
// See lib/time.ts: there are two kinds of ISO in this app, and only one of them
// may ever become an instant.
import { zonedIsoToTs, clock24 } from '../lib/time';
// THE STORE'S RULES, NOT THE STORE. Both are pure functions of a record and a
// clock. One implementation, so the card, the watchlist rows and the refresh loop
// cannot come to disagree about what a flight is doing.
import { effectiveStatus, isArchived } from '../lib/saved';
import {
  getStatusColor,
  routeDateLabel,
  CD_GREEN,
  CD_LATE,
  StatusWord,
  StatusLine,
} from '../lib/flightstatus';
import {
  SWIPE_W,
  SwipeAction,
  EXPAND_HAPTIC,
  ExpandAction,
  EXIT_TIMING,
  SWIPE_SPRING,
  SWIPE_FILL_RED,
  SWIPE_FILL_DIM,
  SWIPE_INK_DIM,
  BOOKMARK_D,
  ICON_NOTIFY,
  ICON_DELETE,
  notImplemented,
  ICON_REFRESH,
  ICON_MAP,
  ICON_MAP_ON,
} from './swipe';
import {
  GlassLayers,
  g,
  EASE_OUT, EASE_IN, CAL_RISE, CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  OVERLAY_RISE, PANEL_IN_MS, PANEL_OUT_MS,
} from '../lib/glass';
import { CARD_RADIUS, CARD_PAD, CARD_FILL, PAGE_BG } from '../lib/cards';
// HOW FAR THE BLACK TAKES TO BECOME GLASS, in points, measured from the bottom
// of the cutout downward.
//
// 40 IS ENOUGH TO BE A FADE AND SHORT ENOUGH TO STAY A TOP. Under about 24 the
// ramp reads as a hard edge with a soft apology on it; much over 56 and the
// card has a dark band across its head rather than a black top, which is the
// thing the island is supposed to disappear into.
const MAP_CARD_FADE = 40;

// THE MAP VARIANT RUNS TO THE TOP OF THE SCREEN and has to pay the safe area
// back as padding, or its first line sits under the cutout. Read here rather
// than passed as a prop: it is a property of the device, not of the card.
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SHEET_BLUR } from '../lib/glass';

// Declared here rather than imported from a screen, exactly as lib/glass.tsx,
// lib/flightstatus.tsx and components/swipe.tsx declare their own. The values are
// the family names _layout registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';


// THE AIRPORT SHEET'S QUIET TIER, and the only font size in this file that is a
// constant rather than a literal.
//
// Three things share it: the two airport lines and the aircraft model. They are
// what somebody reads AFTER the answer they opened the sheet for — a full
// airport name when the code was not enough, a tail number, a model — and they
// sit a step below the 15 the working values use.
//
// IT IS A CONSTANT BECAUSE THEY MOVE TOGETHER. The aircraft was put at this size
// specifically to sit with the airport lines; spelling 13 into archiveTileValueQuiet
// and again into footerCode and footerName would mean the next person raising
// the airport lines silently leaves the aircraft behind, which is the tie this
// exists to keep.
const SHEET_QUIET_SIZE = 13;

export type FlightData = {
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
  // THE DELAY IN MINUTES, PER ENDPOINT, signed: positive is late, negative early,
  // null is "the provider gave us nothing to compare".
  //
  // THE ONLY FORM THE DELAY TAKES NOW. delayLabel and delayValue stood above
  // these, carrying the departure's delay pre-formatted as "Delay" / "50
  // minutes" for a row on the card that no longer exists; movementTile puts the
  // figure on the movement it belongs to instead, and reads the minutes. Two
  // shapes of one fact, one of them unread, is what came out.
  //
  // NOT RECOMPUTED FROM THE ISOs. _delay_minutes on the server already did that
  // comparison against the scheduled time, on both endpoints; deriving it again
  // here would be a second implementation of one rule.
  depDelay: number | null;
  arrDelay: number | null;
  date: string;
};

export function getStatusBg(status: string) {
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
export function badgeLabel(rawStatus: string | null | undefined, fallback: string): string {
  const key = String(rawStatus ?? '').trim().toLowerCase();
  return BADGE_LABEL[key] ?? fallback.toUpperCase();
}

// The backend uses "N/A" for a time that does not exist yet, and saved records
// default to the same string, so neither may be treated as a real value.
export function hasTime(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '' && v !== 'N/A';
}

export type TimeCell = { label: string; value: string };

// Decides the "what happened / what is expected" row for one movement. Shared by
// the fresh-search card and the saved-record card so the two cannot drift.
export function movementTimeCell(
  actual: string | null | undefined,
  estimated: string | null | undefined,
  // THE SCHEDULED TIME FOR THIS MOVEMENT, which is what the cell falls back to
  // when the provider has sent neither an actual nor an estimate. Formatted by
  // the caller, exactly as the other two are, so this function never has to know
  // about ISOs or timezones.
  scheduled: string,
  isDeparture: boolean,
): TimeCell {
  const noun = isDeparture ? 'Departure' : 'Arrival';
  // ── THE TIME, AND NOTHING AFTER IT ────────────────────────────────────────
  //
  // " (wheels up)" AND " (touchdown)" ARE GONE. They said where a measurement
  // was taken -- a runway sensor rather than the gate -- which is a fact about
  // the provider's instrumentation and not about the flight. The label already
  // says the only thing a reader is asking: whether this time HAPPENED or is
  // expected. A clock that has to be qualified in brackets to be read is a
  // clock competing with its own label.
  //
  // AND actualSource WENT WITH IT. It was a parameter of this function for one
  // purpose -- choosing between those two strings -- and with them gone it had
  // no reader here, so it is off the signature and off all four call sites.
  // See the note at the tiles for what did NOT become dead with it.
  if (hasTime(actual)) {
    return { label: `Actual ${noun}`, value: actual };
  }
  // BOTH BRANCHES ARE BARE NOW, and the asymmetry this note used to explain has
  // gone with the suffix that caused it. " (predicted)" was removed long before
  // for the reason that now applies to both: a parenthetical restating its own
  // label. That is also why estimatedSource is not a parameter.
  if (hasTime(estimated)) {
    return { label: `Estimated ${noun}`, value: estimated };
  }
  // NOTHING HAS BEEN REPORTED, so the schedule is the best estimate there is.
  // Until an airline says otherwise, a flight is expected at the time it was
  // sold at — that is what a timetable IS — and "Estimated Departure 09:40" says
  // so. It replaces "Not departed yet", which answered a question nobody asked:
  // the tile is headed by when the flight is expected, not by whether it has
  // gone, and the row above it already carries the scheduled time for anyone
  // comparing the two.
  //
  // NO DELAY FOLLOWS IT. The server derives its delay from an actual or
  // estimated time, so a movement with neither carries a null delay and
  // movementTile leaves the value white and unqualified. The schedule is never
  // shown as running to time on the strength of being the schedule.
  return { label: `Estimated ${noun}`, value: scheduled };
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
export function displayStatus(
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
export function scheduledDuration(
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
//
// EXPORTED for app/flights.tsx, which draws its own bar from the same fraction.
// One implementation, so the card and the trip screen cannot disagree about how
// far along a flight is.
export function computeProgress(f: SavedFlight | null, now: number): number | null {
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
export function flightDataFromApi(data: any, effective?: string): FlightData {
  const dep = data?.departure ?? {};
  const arr = data?.arrival ?? {};
  const mapped = (data?.status || "unknown").toLowerCase();
  const effectiveMapped = effective ?? mapped;
  // The contradicted-raw-word rule, for the reason set out at length in
  // renderSavedFlight: a raw word the clock has just refuted is the same claim
  // in finer detail, not a second opinion, so it stops being evidence.
  const trustedRaw = effectiveMapped === mapped ? (data?.raw_status ?? null) : null;
  const status = displayStatus(effectiveMapped, dep.delay, trustedRaw);
  // Formatted BEFORE the cell is chosen. The cell no longer appends anything --
  // "(predicted)" and "(wheels up)" have both gone -- but the order still
  // matters: movementTimeCell CHOOSES between the three, so whichever it picks
  // has to arrive already formatted. clock24 leaves "N/A" alone, so hasTime
  // still recognises it.
  const depCell = movementTimeCell(
    clock24(dep.actual_iso ?? null, dep.actual),
    clock24(dep.estimated_iso ?? null, dep.estimated),
    clock24(dep.scheduled_iso ?? null, dep.scheduled), true);
  const arrCell = movementTimeCell(
    clock24(arr.actual_iso ?? null, arr.actual),
    clock24(arr.estimated_iso ?? null, arr.estimated),
    clock24(arr.scheduled_iso ?? null, arr.scheduled), false);
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
    depDelay: typeof dep.delay === 'number' ? dep.delay : null,
    arrDelay: typeof arr.delay === 'number' ? arr.delay : null,
    date: data?.flight_date || "N/A",
  };
}

// THE SAME CARD, BUILT FROM THE RECORD INSTEAD OF FROM THE WIRE.
//
// AN ADAPTER, NOT A SECOND IMPLEMENTATION, and the distinction is the whole
// reason this is safe to add. Every RULE it needs is already exported and is
// called here exactly as flightDataFromApi calls it: movementTimeCell decides
// the actual/estimated/scheduled precedence, displayStatus and badgeLabel decide
// the word, getStatusColor and getStatusBg decide the colours, airportFullLabel
// decides the name and scheduledDuration decides the duration. What is written
// below is field mapping and nothing else, so the two builders cannot come to
// disagree about what a flight looks like -- only about where they read it from.
//
// WHY IT HAS TO EXIST: a flight opened from the MAP has no wire response behind
// it. The route was saved, the record is on disk, and fetching it again to draw
// a card would spend a provider call to be told what is already known.
//
// `effective` IS REQUIRED HERE where it is optional there, because a stored
// record's own status word is frozen at whatever the last refresh returned --
// for anything saved in advance that is "scheduled" forever. Only the clock can
// say otherwise, and only the caller has one. See effectiveStatus in lib/saved.
//
// THE RAW STATUS IS THE RECORD'S OWN, and it is subject to the same rule
// flightDataFromApi applies. An earlier version of this passed null on the
// belief that SavedFlight did not store the provider's word; it does --
// savedFlightFromApi writes rawStatus straight off the response -- so a stored
// flight can read BOARDING exactly as a freshly fetched one does.
//
// THE CONTRADICTED-RAW-WORD RULE COMES WITH IT. If the clock has already
// overruled the stored status, the finer word underneath it was describing the
// same overruled claim and stops being evidence. Same test, same reasoning, same
// two lines as the other builder.
export function flightDataFromSaved(f: SavedFlight, effective: string): FlightData {
  const trustedRaw = effective === (f.status || 'unknown').toLowerCase()
    ? f.rawStatus
    : null;
  const status = displayStatus(effective, f.from.delay, trustedRaw);
  const depCell = movementTimeCell(
    clock24(f.from.actualIso, f.from.actual),
    clock24(f.from.estimatedIso, f.from.estimated),
    clock24(f.from.scheduledIso, f.from.scheduled), true);
  const arrCell = movementTimeCell(
    clock24(f.to.actualIso, f.to.actual),
    clock24(f.to.estimatedIso, f.to.estimated),
    clock24(f.to.scheduledIso, f.to.scheduled), false);
  return {
    flight: f.flightNumber || "\u2014",
    airline: f.airline || "\u2014",
    status: badgeLabel(trustedRaw, status),
    statusColor: getStatusColor(status),
    statusBg: getStatusBg(status),
    from: f.from.iata || "\u2014",
    fromFull: airportFullLabel(f.from.shortName, f.from.city, f.from.airport || "\u2014"),
    fromCity: f.from.city || f.from.airport || "\u2014",
    to: f.to.iata || "\u2014",
    toFull: airportFullLabel(f.to.shortName, f.to.city, f.to.airport || "\u2014"),
    toCity: f.to.city || f.to.airport || "\u2014",
    dep: f.from.scheduled || "N/A",
    arr: f.to.scheduled || "N/A",
    depIso: f.from.scheduledIso,
    arrIso: f.to.scheduledIso,
    depTimeLabel: depCell.label,
    depTimeValue: depCell.value,
    arrTimeLabel: arrCell.label,
    arrTimeValue: arrCell.value,
    duration: scheduledDuration(
      f.from.scheduledIso, f.from.timezone, f.to.scheduledIso, f.to.timezone),
    terminal: f.from.terminal || "N/A",
    gate: f.from.gate || "N/A",
    checkinDesk: f.from.checkinDesk,
    aircraft: f.aircraftModel,
    registration: f.aircraftRegistration,
    baggage: f.to.baggage || "N/A",
    depDelay: f.from.delay,
    arrDelay: f.to.delay,
    date: f.flightDate || "N/A",
  };
}

// IT DOES NOT BELONG HERE, and that is worth saying rather than hiding. This is a
// general airport-name helper — lib/airports.ts is its home — and it is in a card
// component only because the route row's city labels and this card's both call
// it, and this step was allowed to touch two files. It is exported back rather
// than copied, so there is still exactly one of it.
export function trimAirportName(name: string) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf(' (');
  return (i >= 0 ? name.slice(0, i) : name).trim();
}

// "Chhatrapati Shivaji, Mumbai" when the provider supplies both parts and they
// differ, otherwise the full airport name alone. Single-name airports return
// shortName === city — DXB is "Dubai"/"Dubai" — and must not read "Dubai,
// Dubai". Compared case-insensitively after trimming.
export function airportFullLabel(shortName: string | null, city: string | null, airport: string): string {
  const s = (shortName ?? '').trim();
  const c = (city ?? '').trim();
  if (s && c && s.toLowerCase() !== c.toLowerCase()) return `${s}, ${c}`;
  return airport;
}

// ONE FACT ABOUT THE AIRPORT, and it keeps its place when it has nothing to
// say.
//
// A tile with no value RECEDES, it does not disappear and it does not shrink.
// Gate is where gate is, whether or not there is a gate yet, so a glance at the
// same spot answers the same question every time — and the moment a gate is
// assigned it appears where the eye already is rather than shoving Terminal and
// Belt sideways. An em dash says "nothing yet" without the shout of the word
// N/A, which is three characters of noise claiming the same weight as a real
// answer.
//
// "N/A" is what the backend writes for an absent value — see flightDataFromApi,
// where gate, terminal and baggage all fall back to it — so it is a sentinel to
// be read here, never a string to be shown.
//
// hasTime IS THAT READING, and it is the file's only implementation of it: null,
// whitespace, or the sentinel itself. Its name is about times, but the question
// it answers is "is this a real value", which is the same question a gate asks.
// FooterMeta asks it too, three inches below, and one rule with two spellings is
// the thing that drifts.
//
// THE RULE BELONGS TO THE TILE, not to the row. A rule rendered as a sibling
// BETWEEN tiles cannot survive wrapping: with four tiles in two rows, the third
// separator falls at the end of the first visual row and hangs in space. Owned
// by the tile and drawn on its left edge, it wraps with the tile it belongs to,
// and `first` — the tile that starts a visual row — simply does not draw one.
// It is still a View with a background colour rather than a border.
function AirportTile({ label, value, wide, first, sheet }: {
  label: string; value: string | null; wide: boolean; first: boolean;
  // THE SHEET'S TREATMENT OF THIS ROW, which differs from the card's in two
  // ways, both carried by this one flag rather than by a flag each. It was
  // `small` when the size was the only difference; the name went with the second
  // one, because a boolean called `small` that also changes a font weight is a
  // boolean whose name has stopped describing it.
  //
  //   THE VALUE IS 15, NOT 20. On the card these four tiles are the loudest
  //   thing on screen and are meant to be. In the sheet they sit among four
  //   other groups whose values are all 15, and a 20 among them read as a
  //   different kind of fact rather than the same kind at a different scale.
  //
  //   THE LABEL IS SEMIBOLD, NOT REGULAR. The sheet's other labels take the
  //   weight its headings use, so that a label reads as naming the value under
  //   it rather than as more of the same grey.
  //
  // A PROP RATHER THAN AN EDIT TO airportTileValue AND airportTileLabel, because
  // both styles are the card's and the card is not moving. Optional, so the
  // card's call site says nothing and gets what it always got.
  sheet?: boolean;
}) {
  const empty = !hasTime(value);
  return (
    <View style={[
      s.airportTile,
      wide ? s.airportTileHalf : s.airportTileThird,
      first && s.airportTileFirst,
    ]}>
      {!first && <View style={s.airportTileRule} />}
      {/* NO EMPTY TREATMENT ON EITHER SURFACE. A gate, a terminal and a belt
          are three tiles of one row, and dimming the ones without a value made
          them read as broken rather than as pending — two greyed tiles beside a
          bright one look like a load that failed, not like an airport that has
          not decided yet.

          THE EM DASH IS THE WHOLE SIGNAL, and it is enough: a dash where a gate
          number goes says the gate is unassigned, at the same weight every other
          tile is drawn at. Nothing needs to be faded to say it twice.

          It went from the sheet first, gated on `sheet`; the card wanted the
          same and the gate came out with it. */}
      <Text
        style={[s.airportTileLabel, sheet === true && s.sheetTileLabel]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        style={[s.airportTileValue, sheet === true && s.airportTileValueSmall]}
        numberOfLines={1}
      >
        {empty ? '\u2014' : value}
      </Text>
    </View>
  );
}

// THE SHEET'S TILES. Same grammar as AirportTile above — label, value beneath,
// a rule on any tile that does not start a visual row — but a SECOND COMPONENT
// rather than props bolted onto that one, because three of its rules invert here
// and a component that did both would be a component whose type no longer says
// what it renders:
//
//   THE VALUE IS 15, NOT 20. These are secondary facts and the size difference
//   is the hierarchy. AirportTile hard-codes 20 and should keep doing so.
//
//   ABSENT MEANS ABSENT. The AT THE AIRPORT group in this sheet renders
//   AirportTile and keeps an em-dashed tile for a gate nobody has assigned yet,
//   because its POSITION is the answer. These groups are the opposite: a
//   registration this record does not carry is not one that might arrive later,
//   so the tile does not exist.
//
//   ALWAYS TWO COLUMNS, so there is no count-driven basis to choose.
//
// THE ROW TEST RUNS ON THE SURVIVORS. `shown` is the filtered list, so i % 2 is
// the index among the tiles that actually render — drop Aircraft and
// Registration still starts a row and still draws no rule. A fixed index into
// the unfiltered list would have left rules dangling in the gaps.
//
// ONE FILTER, AND THE HEADING IS INSIDE IT. The group returns null when nothing
// survives — heading included — so a heading over nothing is not a case anybody
// has to remember to handle, and there is no second emptiness test that could
// come to disagree with the first.
//
// THE ITEMS COME FROM THE CALLER. It was one fixed list when the sheet was one
// flat run of tiles; now that the sheet is grouped, the grouping is the caller's
// business and this renders whichever group it is handed.
//
// NO HAIRLINE ANY MORE. It owned a rule below itself when the groups had nothing
// else dividing them. The headings divide them now, and a heading with a rule
// four points above it is two separators doing one job.
// ONE OF THE CARD'S TIME PAIRS, in the card's own label-above-value shape.
//
// IT DECIDES NOTHING. movementTile is the rule — what turns amber, what carries
// a figure, what stays green — and this renders whatever that returns. The card
// and the sheet now say the same thing about the same delay because there is one
// implementation and two shapes, not two implementations.
//
// A COMPONENT RATHER THAN AN INLINE CALL, and that is the whole of what item one
// cost. movementTile returns a record with four fields the render needs, and JSX
// cannot bind it to a name mid-expression: calling it inline would have meant
// calling it three times per row, once for the label, the value and the suffix.
// Passing the record in once is the alternative.
//
// THE SUFFIX IS NESTED, exactly as it is in the sheet's tiles, so the delay sits
// on the same line as the time and inherits its size and colour. Only the family
// changes: MONO against the value's MONO_BOLD.
function MovementLine({ cell }: {
  cell: { label: string; value: string; suffix?: string; tone?: 'ontime' | 'late' };
}) {
  return (
    <View style={s.airportTimeRow}>
      <Text style={s.airportTimeLabel}>{cell.label}</Text>
      <Text
        style={[
          s.airportTimeValue,
          cell.tone === 'ontime' && s.airportTimeOnTime,
          cell.tone === 'late' && s.airportTimeLate,
        ]}
        // THREE. It was 1 while the value was only ever a clock, then 2 when
        // the qualifier and the delay were appended to it, and 3 now that the
        // line shares its row with an identity column and has 120pt rather than
        // the card's full 252 to do it in.
        //
        // The arithmetic is what sets it: the longest value is 252.0pt, two
        // lines of 120 hold 240, and truncating cuts the qualifier and the
        // figure — the half that says what the clock MEANS. The card grows a
        // line in the one case that needs it and no line in every other.
        numberOfLines={3}
      >
        {cell.value}
        {cell.suffix !== undefined && (
          <Text style={s.archiveTileValueMono}>{cell.suffix}</Text>
        )}
      </Text>
    </View>
  );
}

// THE SHEET'S OPENING BLOCK: when, on the left, and what, on the right.
//
// NOT A SheetGroup AND NOT HEADED. Every other block in the sheet is a heading
// over a grid of like things; this one is two unlike halves, and the date is
// itself the heading — a 32pt SAT / 26 SEP says what a line reading DATE over a
// small date would have said, in one object instead of two.
//
// IT SPLITS routeDateLabel RATHER THAN FORMATTING AGAIN. That helper already
// returns "Sat 26 Sep" from the same field, and a second formatter reading the
// same input is a second thing to keep in step. The split is on the string this
// app just produced, not on provider text.
//
// THE THREE-PART TEST IS A GUARD, not ceremony. routeDateLabel passes anything
// it cannot parse straight through unchanged, so a malformed date would arrive
// here as one part rather than three; requiring exactly three means such a value
// renders no date at all instead of rendering half of itself very large.
//
// 32 FITS. At 32pt JetBrains Mono Bold the advance is 19.2pt, so the longest
// possible second line — six characters, "26 SEP" — is 115.2pt against the 124pt
// half column, and every weekday is 57.6pt.
function SheetFlightHeader({ flight }: { flight: FlightData }) {
  const parts = hasTime(flight.date) ? routeDateLabel(flight.date).split(' ') : [];
  const dated = parts.length === 3;

  return (
    <View style={s.sheetFlightHead}>
      {dated && (
        <View style={s.sheetFlightWhen}>
          <Text style={s.sheetFlightDate} numberOfLines={1}>
            {parts[0].toUpperCase()}
          </Text>
          <Text style={s.sheetFlightDate} numberOfLines={1}>
            {`${parts[1]} ${parts[2]}`.toUpperCase()}
          </Text>
        </View>
      )}
      {/* Keeps its half whether or not the date is beside it: with no date it
          simply sits at the left edge, rather than stretching and leaving the
          airline in a column twice the width it was measured for. */}
      <View style={s.sheetFlightWhat}>
        <View style={s.sheetFlightField}>
          <Text style={[s.airportTileLabel, s.sheetTileLabel]} numberOfLines={1}>{'Flight'}</Text>
          {/* The tile treatment, composed from the same styles the tiles use,
              so this pair cannot drift from the values below it. */}
          <Text
            style={[s.archiveTileValue, s.archiveTileValueMono, s.sheetFlightIdent]}
            numberOfLines={1}
          >
            {flight.flight}
          </Text>
        </View>
        <View style={s.sheetFlightField}>
          <Text style={[s.airportTileLabel, s.sheetTileLabel]} numberOfLines={1}>{'Airline'}</Text>
          <Text
            style={[s.archiveTileValue, s.archiveTileValueSans, s.sheetFlightIdent]}
            numberOfLines={2}
          >
            {flight.airline}
          </Text>
        </View>
      </View>
    </View>
  );
}

function SheetGroup({ title, items }: {
  // OPTIONAL, because one group has no heading at all: the times sit directly
  // under the header block, which already carries the date they belong to.
  title?: string;
  items: {
    label: string; value: string;
    full?: boolean; quiet?: boolean;
    // SUPPRESSES THE LABEL, but does not remove it: the label is still the
    // tile's key, and it is still what the item calls itself. A tile whose
    // group heading already names it does not need to say the word twice, and
    // an empty label string would not have done — the Text would still lay out
    // a line box and the tile's gap above it, leaving a hole where the label
    // was rather than no label at all.
    hideLabel?: boolean;
    // A NAME, NOT MACHINE DATA, so it takes the sans family. Every other value
    // in this sheet is a code, a clock or a registration — things mono exists
    // for, where a fixed advance makes columns of digits line up. A carrier's
    // name is prose and reads as prose.
    sans?: boolean;
    // MONO AT REGULAR WEIGHT, where the tile's own style is mono at bold.
    //
    // It reads as a weight switch rather than a family switch, and that is
    // exactly what it is: weight in this file is carried by the family and
    // nothing else, so dropping MONO_BOLD to MONO IS unbolding. It pairs with
    // `sans` above, which now does the same thing on the other side — SANS
    // rather than SANS_SEMI — so the two together say "an identifier, not a
    // value": something you read to know WHICH flight this is, not something
    // that changes as the flight goes.
    mono?: boolean;
    // WHAT THE CLOCK MEANS, where it means anything: 'ontime' greens the value,
    // 'late' ambers it. Absent leaves it white, which is what a tile says when
    // there is nothing to compare against. See movementTile.
    tone?: 'ontime' | 'late';
    // THE DELAY, AS ITS OWN RUN OF TEXT, separator included — " · 50m late".
    //
    // A SEPARATE FIELD RATHER THAN A NODE IN `value`, and the filter above is
    // why: `shown` tests hasTime(t.value), so value has to stay a string this
    // component can read. Making it a ReactNode would have meant either giving
    // up that test or asking every caller to supply a second string for it.
    //
    // It renders NESTED inside the value's own Text, which is what keeps the two
    // on one line and wrapping as one block — the delay is not a second line, it
    // is the tail of the same sentence. A nested Text inherits its parent's size
    // and colour, so the style it takes only has to say what differs.
    suffix?: string;
    // MAY USE A SECOND LINE, where every other tile is held to one.
    //
    // AND IT IS STILL NEEDED, WITH THE SUFFIX GONE. " (wheels up)" used to be
    // half of why: "10:15 (wheels up)" is 17 characters against 112pt of
    // second-column tile. That half has been removed -- but movementTile still
    // appends the DELAY, and "10:15 · 50m late" is 16 characters and 144pt,
    // which does not fit either. Held to one line a late movement would truncate
    // to "10:15 · 50m l...", cutting off the half that says how late. Given two
    // it breaks at its own space, which puts the clock on one line and the
    // offset under it: exactly where a person would have broken it.
    //
    // The unqualified case was always one line and is unchanged: a bare "10:15"
    // has nothing to wrap.
    twoLines?: boolean;
  }[];
}) {
  const shown = items.filter(t => hasTime(t.value));
  if (shown.length === 0) return null;

  // WHICH TILES START A VISUAL ROW, walked rather than derived from the index.
  //
  // i % 2 was exact while every tile was a half. It stops being exact the moment
  // one of them takes the whole row: a full tile at an ODD index wraps, so it
  // starts a row that i % 2 says it does not, and it would draw a left rule
  // dangling at the beginning of that row. Nothing in the group order guarantees
  // that cannot happen — with no Date, Aircraft lands at index 1 and it does.
  //
  // So the column is carried. A full tile always starts a row, whether it wrapped
  // to get there or was already at the left, and always leaves the next tile at
  // the left edge too.
  let col = 0;
  const laid = shown.map(t => {
    const full = t.full === true;
    const first = full || col === 0;
    col = full ? 0 : (col + 1) % 2;
    return { ...t, first, full };
  });

  return (
    <View style={s.airportGroup}>
      {/* A SECTION LABEL, OR NOTHING. The times group passes no title and gets
          no heading: the date that used to head it now heads the whole sheet
          from the header block at the top, and a "TIMES" label in its place
          would name a category its own four labels already name.

          There was a third case here, a dated heading in its own larger style,
          and it went when the date moved. A branch nothing could reach was
          keeping a style alive and telling the next reader that groups can be
          headed two ways when they cannot. */}
      {title !== undefined && (
        <Text style={s.sheetHeading}>{title}</Text>
      )}
      <View style={s.airportTiles}>
        {laid.map(t => (
          <View
            key={t.label}
            style={[
              s.airportTile,
              t.full ? s.airportTileFull : s.airportTileHalf,
              t.first && s.airportTileFirst,
            ]}
          >
            {!t.first && <View style={s.airportTileRule} />}
            {t.hideLabel !== true && (
              <Text
                style={[s.airportTileLabel, s.sheetTileLabel]}
                numberOfLines={1}
              >
                {t.label}
              </Text>
            )}
            <Text
              style={[
                s.archiveTileValue,
                t.quiet === true && s.archiveTileValueQuiet,
                t.sans === true && s.archiveTileValueSans,
                t.mono === true && s.archiveTileValueMono,
                t.tone === 'ontime' && s.archiveTileValueOnTime,
                t.tone === 'late' && s.archiveTileValueLate,
              ]}
              numberOfLines={t.twoLines === true ? 2 : 1}
            >
              {t.value}
              {/* MONO where the line around it is MONO_BOLD, and nothing else.
                  Inheriting the size and the amber means the delay cannot drift
                  from the time it qualifies: one of them turning amber turns
                  both, and only the weight separates them — the clock is the
                  fact, the delay is what to make of it. */}
              {t.suffix !== undefined && (
                <Text style={s.archiveTileValueMono}>{t.suffix}</Text>
              )}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// THREE ACROSS, OR TWO BY TWO, decided by the tile count and nothing else.
//
// The row is flexWrap, and each tile's flexBasis is a percentage of it: 33.33%
// when there are three, so 99.99% fits on one line, and 50% when there are
// four, so the third tile has nowhere to go but the next line. No screen width
// is consulted and nothing is measured — the count is known at render time and
// the count is the whole input.
//
// FOUR ACROSS WAS THE THING TO AVOID. At 320pt the card's interior is 252, and
// four columns leave about 63 each before padding, which is brittle exactly
// where most phones are. Two rows of two give each tile 126.
//
// `first` is index % cols, which is what tells a tile it starts a visual row —
// 0 of three, or 0 and 2 of four — and therefore draws no left rule.
function AirportTiles({ gate, terminal, belt, desk, sheet }: {
  gate: string; terminal: string; belt: string; desk: string | null;
  // Passed straight down. See AirportTile.
  sheet?: boolean;
}) {
  const tiles: { label: string; value: string | null }[] = [
    { label: 'Gate', value: gate },
    { label: 'Terminal', value: terminal },
    { label: 'Belt', value: belt },
  ];
  // The same guard this row has always had, in the one place that now needs it.
  if (desk !== null) tiles.push({ label: 'Desk', value: desk });
  const cols = tiles.length === 4 ? 2 : 3;
  return (
    <View style={s.airportTiles}>
      {tiles.map((t, i) => (
        <AirportTile
          key={t.label}
          label={t.label}
          value={t.value}
          wide={cols === 2}
          first={i % cols === 0}
          sheet={sheet}
        />
      ))}
    </View>
  );
}

// ONE MOVEMENT TILE, READY TO RENDER: the value with its offset, and which of
// the two tones it takes.
//
// IT DOES NOT COMPARE ANYTHING. The comparison is _delay_minutes on the server,
// which measured the movement against the scheduled time for that endpoint and
// sent the result; this reads that figure and decides how to say it. delayCell
// formats the same number for the card's status row but has no threshold and no
// colour, and delaySegment applies a threshold but rebuilds the comparison from
// a SavedFlightEndpoint's ISOs — a shape the sheet does not have. Neither fits,
// and neither is duplicated: the arithmetic they share was done upstream.
//
// NO DEADBAND. A minute late is late, and four minutes late is four minutes
// late: the figure is the provider's own and there is no size at which it stops
// being true. delaySegment on the watchlist rows suppresses anything under five,
// because a row is a glance and a two-minute drift is noise there — this is the
// sheet somebody opened to read the detail, and the detail is the point.
//
// TWO BRANCHES, AND NO WHITE ONE. Late is amber and carries the figure;
// everything else is green.
//
// A NULL DELAY IS ON TIME, which is the reading that changed. The server emits
// null only when there is neither an actual nor an estimated time to compare
// against — see _build_movement, "Null only when there is neither an actual nor
// an estimate" — so a null arrives on exactly the movement that is running to
// its schedule and has had nothing said against it. Treating that as "no
// statement" left the commonest case, a flight that is simply on time, rendering
// as though the tile had failed. Nobody reads an unremarkable departure as
// missing data; they read it as fine, and now it says so.
//
// Zero and negative land here too: dead on the minute, and early at any size.
function movementTile(label: string, value: string, delay: number | null): {
  label: string; value: string; suffix?: string;
  tone?: 'ontime' | 'late'; twoLines: boolean;
} {
  if (typeof delay === 'number' && delay > 0) {
    // The time and the delay travel separately from here so the tile can set
    // them in different weights. They still render as one line.
    return { label, value, suffix: ` · ${delay}m late`, tone: 'late', twoLines: true };
  }
  return { label, value, tone: 'ontime', twoLines: true };
}

// `style` is optional and composes ON TOP of pg.wrap, so every existing caller
// is untouched: omit it and the bar is exactly what it has always been. It
// exists because pg.wrap's 24 of vertical margin is tuned for a bar floating on
// black with a whole screen around it, and the same 24 inside a padded card is
// 48pt of air the card did not ask for.
function ProgressBar({ progress, color, style }: { progress: number; color: string; style?: any }) {
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
    <View style={[pg.wrap, style]}>
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

// WHAT THE SCREEN KNOWS AND THE CARD CANNOT.
//
// Seven, and the split is the point. The first three are the subject: the flight
// as it will be rendered, the stored record behind it where there is one, and the
// clock the countdowns and the progress bar read. The fourth is the one fact that
// requires the store, so it has to come from something that has one. The last
// three are everything this card is allowed to ask for.
//
// THE NAMES ARE THE CALL SITES' OWN. handleToggleSave, refreshFlightCard and
// closeFlightCard are what these were called while they were locals in
// app/index.tsx, and keeping the names is what let every line below move without
// being touched.
//
// `flight` IS NOT OPTIONAL. The screen renders this inside `{flight && (`, so a
// null cannot arrive, and saying so here is what removed the two null guards the
// details sheet used to carry.
type FlightCardProps = {
  flight: FlightData;
  flightRecord: SavedFlight | null;
  now: number;
  // From the store, and the only prop that needs one. An ARCHIVED record is still
  // saved — it is simply filed away — which is why isArchivedCard below is
  // derived from the record and the clock rather than passed in beside this.
  isSaved: boolean;
  handleToggleSave: () => void;
  // WHETHER THIS FLIGHT'S ROUTE IS DRAWN ON THE GLOBE, and the toggle that
  // changes it. A second pair in the shape of isSaved / handleToggleSave, for
  // the same reason: the card cannot know, because the answer is in a store, and
  // it is not allowed to reach for one.
  //
  // ON THE MAP IS NOT DERIVED FROM SAVED. A flight can be drawn without being
  // watched and watched without being drawn -- see lib/maproutes.
  routeOnMap: boolean;
  toggleRouteOnMap: () => void;
  // -- WHETHER THE USER IS FLYING THIS FLIGHT, AND THE TOGGLE FOR IT ---------
  //
  // A THIRD PAIR IN THE SHAPE OF isSaved / handleToggleSave AND
  // routeOnMap / toggleRouteOnMap, for the same reason: the card cannot know,
  // because the answer is in a store, and it is not allowed to reach for one.
  //
  // OPTIONAL, WHERE THE OTHER TWO ARE NOT, AND THAT IS THE ONE DIFFERENCE. The
  // map variant at app/search.tsx builds its own values by hand -- cardToggleSave,
  // cardRefresh and cardToggleRoute all act on the flight whose ARC was tapped,
  // not on the search result useFlightCardHost is holding -- so it has no
  // ownership pair to pass and would have to invent one. It should not: a card
  // glanced at over the map is not where a trip is planned, and adding a leg is
  // a decision that belongs on the screen that shows the trip.
  //
  // UNDEFINED MEANS THE ROW IS NOT RENDERED AT ALL, which is the same mechanism
  // renderLeftActions already uses to remove a whole swipe panel: the absence of
  // a handler is how this component is told a thing does not apply here.
  isOwnedFlight?: boolean;
  toggleOwned?: () => void;
  // -- TAKE THIS LEG OFF THE TRIP -------------------------------------------
  //
  // Called by the remove action in the trip variant's left panel. It is the same
  // act toggleOwned performs when the flight is already owned, and app/flights
  // passes the same function to both -- two controls, one action, so the swipe
  // and the menu row cannot come to mean different things.
  removeFromTrip?: () => void;
  refreshFlightCard: () => void;
  closeFlightCard: () => void;
  // -- MY FLIGHTS' OWN CUT OF THIS CARD --------------------------------------
  //
  // OFF EVERYWHERE ELSE, AND THAT IS THE CONTRACT, exactly as mapVariant's is.
  // Home and the search results pass nothing and get precisely the card they
  // have today; every read of this flag is additive-by-omission.
  //
  // WHAT IT CHANGES AND WHY:
  //
  //   THE LEFT PANEL BECOMES REFRESH AND REMOVE-FROM-TRIP. The bookmark toggles
  //   WATCHING, and watching is the wrong verb on a screen about flights you are
  //   TAKING: every leg here is saved by construction, so the button could only
  //   ever unsave -- deleting the record out from under the trip that is showing
  //   it. Remove is what a person means on this screen, and it disowns rather
  //   than deletes.
  //
  //   THE RIGHT PANEL GOES ENTIRELY. It holds notify, which is unimplemented,
  //   and close, which closes a SEARCH RESULT. This is not one: there is nothing
  //   to close, and a card that vanished from a trip because it was swiped shut
  //   would be a delete wearing the wrong word. undefined is how the library is
  //   told there is no panel -- see renderRightActions below.
  //
  // AND NOTHING ELSE. The route block, the airport tiles, the progress bar, the
  // sheet the card opens and the long-press menu all stay exactly as they are.
  // That is the whole point of using the card here rather than rebuilding a
  // worse one beside it.
  tripVariant?: boolean;
  // ── THE MAP'S OWN CUT OF THIS CARD ────────────────────────────────────────
  //
  // OFF EVERYWHERE ELSE, AND THAT IS THE CONTRACT. Home and the search results
  // pass nothing and get exactly the card they had: both swipe panels, the route
  // card, the updated-x-ago line, the tap that opens the sheet. This flag is
  // read in four places and every one of them is additive-by-omission.
  //
  // WHAT IT REMOVES AND WHY:
  //   THE ROUTE CARD -- the map panel beside it already names both airports,
  //   their codes and their clocks, so the route block would be the same
  //   journey stated twice on one screen.
  //   THE UPDATED LINE -- it belongs to a result the user searched for. Nobody
  //   searched for this; they tapped a line on a globe.
  //   BOTH SWIPE PANELS -- save, refresh, notify and close are a list's
  //   vocabulary. See renderLeftActions below, where undefined is how this
  //   library is told there is no panel.
  //   THE SHEET TAP -- a third layer over a card that is already over a map.
  //
  // WHAT IT DOES NOT DO IS DISMISS. The swipe-up that closes the map card is the
  // OVERLAY's, not the card's: the thing being dismissed is the overlay, the
  // card is only what is drawn in it, and putting the gesture here would mean a
  // Pan handler that has to be disabled on every other screen.
  mapVariant?: boolean;
};

export function FlightCard({
  flight,
  flightRecord,
  now,
  isSaved,
  handleToggleSave,
  routeOnMap,
  toggleRouteOnMap,
  isOwnedFlight,
  toggleOwned,
  removeFromTrip,
  refreshFlightCard,
  closeFlightCard,
  tripVariant = false,
  mapVariant = false,
}: FlightCardProps) {
  // CALLED UNCONDITIONALLY, read only when mapVariant. A hook behind an if is
  // not a hook.
  const insets = useSafeAreaInsets();
  // A PLAIN BOOLEAN, not a flight identity. The expanded-card version needed a
  // key because its state outlived the card and could describe a flight that
  // had since been replaced. A sheet cannot: it reads `flight` live, it is
  // dismissed by the person who opened it, and the card it covers cannot change
  // underneath it while it is up.
  const [airportSheetOpen, setAirportSheetOpen] = useState(false);
  const airportSheetAnim = useRef(new Animated.Value(0)).current;
  const airportSheetScrimAnim = useRef(new Animated.Value(0)).current;
  // WHERE THE CARD WAS, in window coordinates, captured on the press that opens
  // the sheet. Null means "not measured", which is not an error — it selects the
  // generic rise instead. See openAirportSheet.
  const airportCardRef = useRef<View | null>(null);
  const [airportCardRect, setAirportCardRect] =
    useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // The archive sheet's rise, on the same values. One approach for every sheet
  // in the file, so a change to the curve reaches all of them.
  useEffect(() => {
    if (!airportSheetOpen) return;
    airportSheetAnim.setValue(0);
    airportSheetScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(airportSheetScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(airportSheetAnim, {
        toValue: 1, duration: CAL_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [airportSheetOpen]);

  // MEASURE, THEN OPEN. The rect has to be in hand on the render that mounts the
  // Modal, because the entrance interpolations are built from it — so the state
  // that opens the sheet is set inside the measurement callback rather than
  // beside it. openRouteDrop has the same shape for the same reason.
  //
  // measureInWindow reports where the card actually is on screen, so the
  // ScrollView's offset is already in the number. The swipeable above it is at
  // translateX 0 whenever this runs: its pan needs about 10pt of horizontal
  // travel to activate and a tap never gets there.
  //
  // A MISSING NODE IS NOT A DEAD END. It opens with a null rect, which is the
  // fallback rise, rather than failing to open — an animation that starts from
  // the wrong place is a much smaller fault than a card that stops responding.
  const openAirportSheet = () => {
    const node = airportCardRef.current;
    if (node === null) {
      setAirportCardRect(null);
      setAirportSheetOpen(true);
      return;
    }
    node.measureInWindow((wx, wy, width, height) => {
      const usable =
        width > 0 && height > 0 && Number.isFinite(wx) && Number.isFinite(wy);
      setAirportCardRect(usable ? { x: wx, y: wy, w: width, h: height } : null);
      setAirportSheetOpen(true);
    });
  };

  // Unmounts only once both layers have left, exactly as closeArchive does.
  const closeAirportSheet = () => {
    Animated.parallel([
      Animated.timing(airportSheetAnim, {
        toValue: 0, duration: CAL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(airportSheetScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setAirportSheetOpen(false));
  };

  // DERIVED, from the stored record and the clock, by the same rule the saved
  // list and the archive sheet split on — not a new field, because there is
  // nothing here that isArchived does not already answer.
  //
  // It exists because an archived record has isSaved TRUE: it is in
  // savedFlights, it is simply filed away. Without this the card's left panel
  // would show a GREEN "unsave" over a flight the user archived rather than
  // saved, and committing it would permanently delete the record — green being
  // exactly the wrong signal for that, since it reads as the reversal of a save
  // the user never made.
  //
  // So the panel is suppressed and a right swipe does nothing. Deletion stays in
  // the archive sheet, where deletion already lives and where the row's own
  // delete action has the undo window behind it.
  const isArchivedCard = flightRecord !== null && isArchived(flightRecord, now);
  // WHERE THE SHEET STARTS FROM. Three numbers, derived rather than measured.
  //
  // THE SHEET IS NEVER MEASURED and does not need to be. routeCalScrim is
  // flex: 1 with justifyContent center and symmetric 16pt padding, so whatever
  // the sheet's height turns out to be, its centre is the window's centre and
  // its width is the window's width less 32. Both are known here, which is what
  // lets the entrance be built on the render that mounts the Modal instead of
  // needing a measuring pass at opacity 0 the way the dropdown panels do.
  //
  // THE SCALE IS UNIFORM, from the widths. The card is the page width less its
  // 20pt margins and the sheet is the window less 16pt each side, so this lands
  // near 0.97: the card and the sheet are almost the same width, and the
  // transition is therefore mostly a directed travel out of the card's position
  // rather than a zoom. Deliberate. Matching the heights as well would mean a
  // non-uniform scale, and a non-uniform scale on a sheet full of text is a
  // squash that the opacity ramp masks but does not hide.
  //
  // NULL IS THE FALLBACK, NOT A FAILURE: no usable rect gives exactly the rise
  // every other sheet uses. One animation either way — the difference is in the
  // output ranges, not in a branch.
  const airportGrow = (() => {
    const win = Dimensions.get('window');
    if (airportCardRect === null) return { tx: 0, ty: CAL_RISE, scale: 0.96 };
    return {
      tx: airportCardRect.x + airportCardRect.w / 2 - win.width / 2,
      ty: airportCardRect.y + airportCardRect.h / 2 - win.height / 2,
      scale: airportCardRect.w / (win.width - 32),
    };
  })();
  // Recomputed every render, so the bar tracks the ticking `now` state.
  const progressValue = computeProgress(flightRecord, now);

  // ── THE CARD'S SWIPE ───────────────────────────────────────────────────────
  //
  // The same vocabulary as a saved row — right to save, left to reveal notify —
  // so nothing moves when push notifications land and the gesture means one
  // thing in both places.
  const cardSwipe = useRef<SwipeableMethods>(null);
  const cardW = useSharedValue(0);
  // THE THROW, and it is SavedFlightRow's exactly: a shared value driving a
  // translateX on a Reanimated.View OUTSIDE the ReanimatedSwipeable, because the
  // library owns the translation inside it. Same EXIT_TIMING, same worklet
  // completion carrying the action back with runOnJS.
  //
  // IT WRAPS THE WHOLE RESULT, NOT THE CARD. The drag still moves the card
  // alone — that is the Swipeable, and it is unchanged. But a commit here ends
  // the result: throwing the card off while the route block sat still would play
  // a 240ms exit for one piece and then unmount the rest with no animation at
  // all, which reads as a card being deleted from a list that then disappears.
  // Everything is going, so everything goes.
  const cardExitX = useSharedValue(0);
  const cardExitStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: cardExitX.value }],
  }));
  const cardArmed = useRef<'left' | 'right' | null>(null);
  const onCardCrossLeft = useCallback((on: boolean) => {
    cardArmed.current = on ? 'left' : null;
    EXPAND_HAPTIC();
  }, []);
  // The same, for the panel that now has an action worth committing. It had no
  // ExpandAction while notify was the only thing in it: a full swipe commits
  // what it uncovers, and there was nothing there to commit.
  const onCardCrossRight = useCallback((on: boolean) => {
    cardArmed.current = on ? 'right' : null;
    EXPAND_HAPTIC();
  }, []);

  // THE CARD DOES NOT LEAVE, and that is the whole of what differs from the
  // row's commit.
  //
  // A row is one of a list and a committed swipe removes it from that list, so
  // it is thrown a screen width and the gap closes behind it. The card is not in
  // a list; there is nowhere for it to go and nothing to close behind it, and
  // the flight it shows is still the flight it shows whether or not it is saved.
  // So the panel simply closes and the action runs — no exit animation, and
  // nothing touching the card's own Animated.View, whose transform belongs to
  // the entry animation showResult() drives and must stay that way.
  const onCardWillOpen = () => {
    const side = cardArmed.current;
    if (side === null) return;
    cardArmed.current = null;
    // ONLY THE RIGHT-HAND COMMIT THROWS, and the asymmetry is the point rather
    // than an omission.
    //
    // On a watchlist row every full swipe REMOVES the row — delete, archive,
    // restore — so the throw means "this is leaving" and the motion is the
    // meaning. Close is that: the result goes and does not come back.
    //
    // REFRESH REMOVES NOTHING. The card stays and reloads in place, so there is
    // no departure to animate. Throwing it out and pulling it back would put the
    // result off screen for the length of a lookup, which is unbounded — a cold
    // start on Cloud Run is seconds — and returning it early would animate a
    // departure that never happened. It keeps the settle it has: the panel
    // closes and the lookup runs.
    if (side === 'left') {
      cardSwipe.current?.close();
      // THE LEFT COMMIT IS WHATEVER THE LEFT PANEL'S EXPANDING ACTION IS, and
      // the two panels put a different one there: refresh on the ordinary card,
      // remove on a trip leg. Reading the flag here rather than giving the trip
      // its own onSwipeableWillOpen keeps one commit path with one close.
      if (tripVariant) {
        removeFromTrip?.();
        return;
      }
      refreshFlightCard();
      return;
    }

    // NEGATIVE, because the right panel is uncovered by dragging LEFT and the
    // result continues the way it was thrown. Same sign convention the row uses.
    //
    // closeFlightCard ON COMPLETION, not at the start: firing it first would
    // unmount the tree mid-flight and cut the exit off at whatever frame the
    // state update landed on.
    cardExitX.value = withTiming(
      -Dimensions.get('window').width,
      EXIT_TIMING,
      (finished) => {
        'worklet';
        if (finished) runOnJS(closeFlightCard)();
      },
    );
  };

  // ── THE ROUTE CARD'S SWIPE ────────────────────────────────────────────────
  //
  // A SECOND Swipeable, NOT A SECOND VOCABULARY. Everything here is
  // components/swipe's: SwipeAction and ExpandAction, SWIPE_FILL_DIM,
  // SWIPE_SPRING, EXPAND_HAPTIC, the 1.15 friction and the 2 overshoot. What
  // differs is the panel's contents and what a commit does, which is exactly
  // what that file says stays with the caller.
  //
  // NEITHER .enabled() NOR .onTouchesDown() WITH manager.fail(). This is a plain
  // ReanimatedSwipeable exactly as the flight card above it is; the two are
  // siblings with no gesture relationship to compose, so there is nothing here
  // that would reach for either.
  //
  // ONE PANEL, ON THE LEFT, revealed by dragging RIGHT. The left panel is where
  // this app puts the actions that KEEP something -- save on the card, restore
  // on an archive row -- and putting a route on the map is that kind of action.
  // The right-hand side stays empty rather than being given a second copy of
  // what the panel already has.
  const routeSwipe = useRef<SwipeableMethods>(null);
  const routeW = useSharedValue(0);
  const routeArmed = useRef(false);
  const onRouteCross = useCallback((on: boolean) => {
    routeArmed.current = on;
    EXPAND_HAPTIC();
  }, []);

  // NOTHING LEAVES, so nothing is thrown. The route card stays exactly where it
  // is whether its route is drawn or not -- the same reasoning the flight card's
  // refresh commit gives for settling rather than exiting. The panel closes and
  // the toggle runs.
  const onRouteWillOpen = () => {
    if (!routeArmed.current) return;
    routeArmed.current = false;
    routeSwipe.current?.close();
    toggleRouteOnMap();
  };

  // others={0} BECAUSE THIS ACTION IS ALONE IN ITS PANEL. ExpandAction subtracts
  // the width of whatever else shares the panel so the box cannot start growing
  // before the panel is open; with nothing beside it there is nothing to
  // subtract, which is the case that parameter documents.
  const renderRouteLeft = (progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.routeSwipeGroup}>
      <ExpandAction side="left" translation={translation} rowW={routeW} others={0} onCross={onRouteCross}>
        {/* THE GLYPH CARRIES THE STATE AND THE FILL DOES NOT, which is the
            bookmark's treatment on the card above: one control changing state
            rather than two different buttons. Green when the route is drawn,
            dim when it is not. */}
        <SwipeAction
          label={routeOnMap ? 'remove route from map' : 'add route to map'}
          fill={SWIPE_FILL_DIM}
          progress={progress}
          grow="left"
          onPress={() => { routeSwipe.current?.close(); toggleRouteOnMap(); }}
        >
          {routeOnMap ? ICON_MAP_ON : ICON_MAP}
        </SwipeAction>
      </ExpandAction>
    </View>
  );

  // ── THE LONG PRESS, AND WHAT IT OFFERS ────────────────────────────────────
  //
  // THE SAME ACTION AS THE SWIPE, deliberately. A swipe is fast once you know it
  // is there and invisible until then; a long press is what people try when they
  // suspect something is available and cannot find it. Two ways in, one action
  // behind them -- toggleRouteOnMap in lib/flightcard.
  //
  // A MENU RATHER THAN A DIRECT TOGGLE. Holding something and having it silently
  // change state is the one long-press behaviour that cannot be undone by
  // letting go; naming the action and asking for a second tap is what makes the
  // hold safe to try.
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const mapMenuAnim = useRef(new Animated.Value(0)).current;
  const mapMenuScrimAnim = useRef(new Animated.Value(0)).current;

  // ── THE ROUTE CARD UNDER A FINGER ─────────────────────────────────────────
  //
  // -1 LIFTED, 0 AT REST, 1 HELD DOWN. One value on one axis -- positive is
  // into the page -- so the whole press reads as one movement rather than as
  // two animations taking turns.
  //
  // THE DIM WAS DOING THIS ALONE AND IT WAS NOT ENOUGH: TouchableOpacity fades
  // the instant a finger lands and then holds that fade for the whole 500ms of
  // the long press, so the card looked the same at 20ms as at 480ms and nothing
  // said the hold was going anywhere.
  //
  // AND RETURNING TO REST WAS NOT A LIFT. The first version of this ran 0.97
  // back to 1.0 when the menu opened, which is a release: the card stopped
  // being pressed and nothing more. Going ABOVE rest is what makes it an
  // ascent -- the card comes off the page toward the menu instead of merely
  // stopping where it started.
  //
  // A SCALE IS THE ONLY NEW PART, and it is built from what this file already
  // uses: an Animated.Value, EASE_OUT and EASE_IN, and the panel timings from
  // lib/glass. The dim stays exactly as it was at activeOpacity 0.7, because
  // that is the app's press state everywhere and this is not a different kind
  // of press -- it is the same press with a second thing to say.
  const routePress = useRef(new Animated.Value(0)).current;
  const routePressStyle = {
    transform: [{
      // 0.97 DOWN, 1.02 UP, AND THE ASYMMETRY IS DELIBERATE. The card is
      // nearly the full width of the screen, so three per cent down is about
      // five points of travel at its edges -- clearly felt, and far short of
      // the shrink that would read as the card being dragged away rather than
      // pushed. The lift is smaller because it is going the other way, toward
      // the viewer, where the same proportion reads as a larger movement; two
      // per cent is enough to be seen leaving the page and not enough to look
      // like a bounce.
      //
      // CLAMPED. The value is only ever driven to exactly -1, 0 or 1, so no
      // extrapolation happens today; the clamp is what stops a later stop being
      // added to this ramp and silently scaling the card past either end.
      scale: routePress.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [1.02, 1, 0.97],
        extrapolate: 'clamp',
      }),
    }],
  };
  const routePressTo = (to: number, duration: number, easing: typeof EASE_OUT) =>
    Animated.timing(routePress, { toValue: to, duration, easing, useNativeDriver: true }).start();

  // DOWN FAST, so the card is already moving before the finger has settled.
  const onRoutePressIn = () => routePressTo(1, 110, EASE_OUT);
  // AND BACK TO REST ON RELEASE, from whichever side the card is on.
  //
  // AFTER A COMPLETED HOLD THIS IS THE SETTLE, not a cancellation: the lift has
  // already taken the card to 1.02 and the finger is still down, so the card
  // stays up for as long as it is held and comes to rest when it is let go. The
  // menu is unaffected either way -- it is a Modal with its own scrim and has
  // stopped depending on the card by the time this runs.
  const onRoutePressOut = () => routePressTo(0, 160, EASE_IN);

  // THE OVERLAY'S TIMINGS, NOT THE SHEET'S. PANEL_IN_MS and OVERLAY_RISE are
  // what the app's small floating panels use; CAL_IN_MS and CAL_RISE belong to a
  // full sheet growing out of a card, and this grows out of nothing and covers
  // almost none of the screen.
  useEffect(() => {
    if (!mapMenuOpen) return;
    mapMenuAnim.setValue(0);
    mapMenuScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(mapMenuScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(mapMenuAnim, {
        toValue: 1, duration: PANEL_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [mapMenuOpen]);

  // THE HAPTIC IS THE THRESHOLD'S, the same one a full swipe fires when it arms.
  // Both are the moment a gesture becomes an offer, and they should feel like
  // the same event.
  const openMapMenu = () => {
    if (flightRecord === null) return;
    EXPAND_HAPTIC();
    // THE LIFT, PAST REST, ON THE MENU'S OWN TIMING. -1 rather than 0: the card
    // rises ABOVE the page as the menu arrives, so the hold ends in an ascent
    // rather than in the absence of a press.
    //
    // PANEL_IN_MS, UNCHANGED. The card travels for exactly as long as the menu
    // takes to rise, so the two read as one movement -- the thing you were
    // pressing hands what it was holding to the thing that arrives. Releasing
    // it instantly instead would have the card move before the menu had
    // started.
    routePressTo(-1, PANEL_IN_MS, EASE_OUT);
    setMapMenuOpen(true);
  };

  // ANIMATED OUT, THEN UNMOUNTED. Setting mapMenuOpen false first would take the
  // Modal off screen on the frame the exit began.
  const closeMapMenu = () => {
    Animated.parallel([
      Animated.timing(mapMenuScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(mapMenuAnim, {
        toValue: 0, duration: PANEL_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(({ finished }) => { if (finished) setMapMenuOpen(false); });
  };

  // CLOSES FIRST, THEN ACTS. The toggle re-renders this card and swaps the
  // menu's own label underneath the finger; running it while the menu is still
  // on screen would show the opposite word for the length of the exit.
  const chooseMapToggle = () => {
    closeMapMenu();
    toggleRouteOnMap();
  };

  // chooseMapToggle's shape exactly, and for the reason stated there: running
  // the toggle while the menu is still on screen would swap its own label
  // underneath the finger for the length of the exit -- "Add to My Flights"
  // becoming "Remove from My Flights" as the panel fades out.
  const chooseOwnToggle = () => {
    closeMapMenu();
    toggleOwned?.();
  };

  // NOT MEMOISED, unlike the row's. The row memoises because there are up to
  // twenty of them and a new function identity remounts every Svg in both
  // panels; there is exactly one card, and these close over isSaved and
  // handleToggleSave, both of which change with the state the button is
  // reporting. A stale closure here would be a button showing one thing and
  // doing another.
  // REFRESH OUTBOARD, BOOKMARK INBOARD. A panel lays its children out left to
  // right and the card sits to the right of this one, so the FIRST child is the
  // one against the screen edge. Reading out from the card: bookmark, then
  // refresh — which is why refresh is written first.
  //
  // others={SWIPE_W}. ExpandAction sizes its box to the strip the row has
  // uncovered LESS whatever else shares the panel, so the expansion cannot start
  // before the panel is even open. It was 0 while the bookmark was alone.
  const renderCardLeft = (progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.cardSwipeGroup}>
      <ExpandAction side="left" translation={translation} rowW={cardW} others={SWIPE_W} onCross={onCardCrossLeft}>
        <SwipeAction
          label="refresh"
          fill={SWIPE_FILL_DIM}
          progress={progress}
          grow="left"
          onPress={() => { cardSwipe.current?.close(); refreshFlightCard(); }}
        >
          {ICON_REFRESH}
        </SwipeAction>
      </ExpandAction>
      {/* THE GLYPH CARRIES THE STATE, not the fill: green when this flight is
          already saved, dim when it is not, which is the card header's own
          treatment of the same shape moved onto the button that replaced it.
          The fill stays SWIPE_FILL_DIM in both cases, so the button reads as
          one control changing state rather than as two different buttons. */}
      <SwipeAction
        label={isSaved ? 'unsave' : 'save'}
        fill={SWIPE_FILL_DIM}
        progress={progress}
        onPress={() => { cardSwipe.current?.close(); handleToggleSave(); }}
      >
        <Path
          d={BOOKMARK_D}
          fill={isSaved ? '#4ade80' : 'none'}
          stroke={isSaved ? '#4ade80' : SWIPE_INK_DIM}
          strokeWidth={1.75}
        />
      </SwipeAction>
    </View>
  );

  // -- THE TRIP LEG'S LEFT PANEL --------------------------------------------
  //
  // A SECOND RENDERER RATHER THAN A BRANCH INSIDE THE FIRST. renderCardLeft is
  // the ordinary card's panel and stays exactly what it is; a flag threaded
  // through it would make one function describe two panels and neither clearly.
  //
  // REMOVE IS THE EXPANDING ACTION, so a full swipe commits it -- which is the
  // same promise a watchlist row makes with delete, and the reason remove sits
  // in the outboard slot the panel gives to whatever it is really for. Refresh
  // is the second child, inboard, against the card.
  //
  // SWIPE_FILL_DIM AND SWIPE_INK_DIM, NOT THE RED DELETE TREATMENT, and that is
  // the whole of what the colour is saying. Removing a leg DISOWNS it: the
  // record stays, its reminders stay, its archive decision stays, and the flight
  // goes back to the watchlist. Red is this app's word for destroying something,
  // and using it here would claim a deletion that does not happen.
  //
  // THE GLYPH IS ICON_DELETE'S TWO PATHS AT THE DIM INK. It is not that constant
  // itself, because that one strokes in SWIPE_INK_RED -- the ink is the
  // difference, and the shape is the same X the app closes and deletes with.
  const renderTripLeft = (progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.cardSwipeGroup}>
      <ExpandAction side="left" translation={translation} rowW={cardW} others={SWIPE_W} onCross={onCardCrossLeft}>
        <SwipeAction
          label="remove"
          fill={SWIPE_FILL_DIM}
          progress={progress}
          grow="left"
          onPress={() => { cardSwipe.current?.close(); removeFromTrip?.(); }}
        >
          <Path d="M19 5 5 19" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
          <Path d="M5 5 19 19" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
        </SwipeAction>
      </ExpandAction>
      <SwipeAction
        label="refresh"
        fill={SWIPE_FILL_DIM}
        progress={progress}
        onPress={() => { cardSwipe.current?.close(); refreshFlightCard(); }}
      >
        {ICON_REFRESH}
      </SwipeAction>
    </View>
  );

  // CLOSE OUTBOARD, NOTIFY INBOARD, and the ordering reads the opposite way to
  // the left panel for the same reason: the card is to the LEFT of this one, so
  // the first child is the one against the card and the last is at the edge.
  // Out from the card: notify, then close.
  //
  // It takes `translation` now. The signature was (progress) alone while notify
  // was the only action and nothing here could expand.
  const renderCardRight = (progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.cardSwipeGroup}>
      <SwipeAction label="notify" fill={SWIPE_FILL_DIM} progress={progress} onPress={notImplemented}>
        {ICON_NOTIFY}
      </SwipeAction>
      <ExpandAction side="right" translation={translation} rowW={cardW} others={SWIPE_W} onCross={onCardCrossRight}>
        {/* THE WATCHLIST ROW'S DELETE TREATMENT, reused rather than restated:
            SWIPE_FILL_RED behind SWIPE_INK_RED, which is a white glyph on a
            red field. SwipeAction already paints `fill` as the button's
            background, so the fill prop is the whole of it.

            ICON_DELETE IS THE SAME GLYPH. Its two paths are M19 5 5 19 and
            M5 5 19 19; the close X written for the header was M19 5 5 19 and
            M5 5l14 14 — the same line, one absolute and one relative. Keeping
            both would have been two spellings of one X differing only in ink,
            and the ink is what the fill decides.

            The label stays "close": the button does what it always did, and
            nothing here deletes anything. */}
        <SwipeAction
          label="close"
          fill={SWIPE_FILL_RED}
          progress={progress}
          grow="right"
          onPress={() => { cardSwipe.current?.close(); closeFlightCard(); }}
        >
          {ICON_DELETE}
        </SwipeAction>
      </ExpandAction>
    </View>
  );

  // A FRAGMENT, because the sheet is not inside the card. It is a Modal — its own
  // host view, above everything, wherever it is written — and it renders first
  // here for the same reason it stood first in index.tsx: it is what the card
  // opens INTO, and the card underneath it is what it grows out of.
  return (
    <>
      {/* AT THE AIRPORT, IN FULL. The archive sheet's structure line for line —
          same Modal flags, same scrim Pressable, same unblurred full-screen dim
          on its own value, same rise, scale and fade on CAL_RISE and 0.96, same
          shell, glass, edge and swallowing body, same head with its spacer,
          title and close button. */}
      <Modal
        visible={airportSheetOpen}
        transparent
        animationType="none"
        onRequestClose={closeAirportSheet}
      >
        <Pressable style={g.routeCalScrim} onPress={closeAirportSheet}>
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: airportSheetScrimAnim }]}
          />
          <Animated.View
            style={[
              g.sheetShell,
              s.airportSheet,
              {
                opacity: airportSheetAnim,
                // Out of the card's frame and back into it on the way out, on
                // the same value, duration and curve the rise used. See
                // airportGrow for where the three numbers come from.
                transform: [
                  { translateX: airportSheetAnim.interpolate({ inputRange: [0, 1], outputRange: [airportGrow.tx, 0] }) },
                  { translateY: airportSheetAnim.interpolate({ inputRange: [0, 1], outputRange: [airportGrow.ty, 0] }) },
                  { scale: airportSheetAnim.interpolate({ inputRange: [0, 1], outputRange: [airportGrow.scale, 1] }) },
                ],
              },
            ]}
          >
            <GlassLayers />
            <View style={g.sheetEdge} pointerEvents="none" />
            {/* Swallows the tap so the scrim's dismiss does not fire through. */}
            <Pressable style={g.sheetBody}>
              <View style={g.sheetHead}>
                {/* Exactly the close button's width, so the title centres on the
                    sheet rather than on whatever space is left beside it. */}
                <View style={g.sheetHeadSpacer} />
                {/* THE TITLE ALONE. It carried the flight number under it for a
                    while, on the reasoning that a sheet floating over a page of
                    several cards has to say which one it belongs to. It does not:
                    the sheet grows out of the card that opened it and hides that
                    card while it is up, so the question of which flight this is
                    was already answered by the gesture.

                    With the number gone the column around it went too. One child
                    does not need a wrapper, so the title is a direct row child
                    again and takes the flex the column was holding. */}
                {/* THE CARD'S OWN HEADING, composed rather than copied: the
                    typography is airportTitle and this adds only the layout the
                    head needs. The sheet is the card opened, so the two saying
                    the same words in the same voice is the point — and one style
                    holding that voice means they cannot drift apart. */}
                <Text style={[s.airportTitle, s.sheetHeadTitle]}>{'Flight card'}</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={closeAirportSheet}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={g.sheetClose}
                >
                  {/* The app's own close X, character for character. */}
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

                <View style={s.airportSheetBody}>
                  {/* WHEN AND WHAT, and it opens the sheet because it is the
                      one block that identifies rather than reports. The head
                      above says "Flight details" and nothing more, so this is
                      where the sheet names its subject. See SheetFlightHeader. */}
                  <SheetFlightHeader flight={flight} />

                  {/* THE CARD'S OWN ROW, the component and not a copy of it.
                      The sheet has to be complete on its own — once the card's
                      contents start moving around, a sheet that relied on the
                      card to have already said something would be a sheet that
                      quietly loses it — but "complete on its own" is about the
                      DATA, not about owning a second layout.

                      SO THIS ONE GROUP IS NOT ON THE SHEET'S GRID. The other
                      three are two columns of half-width tiles; this is three
                      across, or two by two when there is a Desk, because that is
                      what the card does and these are the card's four facts. A
                      person who opens the sheet should recognise the row they
                      just tapped, not have to re-read it in a new arrangement.

                      AirportTiles NEEDED NO CHANGES to work here. It takes four
                      values, decides its columns from how many tiles it built,
                      and sizes them with percentages of whatever row it is put
                      in — nothing in it is scoped to the card. The interiors are
                      near enough identical in any case: the card's is the screen
                      less 40 of page margin and 28 of CARD_PAD, so 252 at 320pt,
                      and the sheet's is the screen less 32 of scrim padding and
                      40 of sheetBody, so 248. Three across is 82.7pt a tile here
                      against 84 there.

                      IT ALSO BRINGS THE CARD'S RULE FOR ABSENCE with it, which
                      is the behaviour this group wants and the opposite of what
                      the other three want: a gate nobody has assigned keeps its
                      tile and recedes to an em dash, because its position is the
                      answer. See SheetGroup for the other half of that.

                      NO HEADING, ALONE AMONG THE GROUPS. It is the first thing
                      under the head, and the head has just said Flight details
                      and named the flight — a label here would be a third line of
                      chrome before the first fact. The groups below it are headed
                      because they follow something and need distinguishing from
                      it; this one follows nothing.

                      AND NO WRAPPER EITHER. airportGroup exists to hold a heading
                      against the tiles it names, and with the heading gone it
                      would be grouping one child with a 10pt gap between it and
                      nothing. The spacing to the group below is unaffected:
                      that comes from airportSheetBody's own 20pt gap between its
                      children, and AirportTiles is now the child that gap
                      applies to. */}
                  <AirportTiles
                    gate={flight.gate}
                    terminal={flight.terminal}
                    belt={flight.baggage}
                    desk={flight.checkinDesk}
                    sheet
                  />

                  {/* THE SCHEDULE, which the card deliberately does not carry:
                      the two big times up there are the LIVE ones, and printing
                      the scheduled pair beside them was the old spec table
                      repeating the headline in a smaller font. Here there is
                      nothing to repeat.

                      NO HEADING. It carried the date for a while, and then the
                      date moved to the header block at the top of the sheet
                      where it heads everything rather than one group. A "TIMES"
                      label in its place would name a category the four labels
                      below it already name four times over. */}
                  <SheetGroup
                    items={[
                      { label: 'Scheduled Departure', value: clock24(flight.depIso, flight.dep) },
                      { label: 'Scheduled Arrival', value: clock24(flight.arrIso, flight.arr) },
                      // WHAT ACTUALLY HAPPENED, beside what was meant to. The
                      // label comes from movementTimeCell rather than being
                      // written here, because only that function knows whether
                      // the provider sent an actual time or an estimate — it
                      // returns "Actual Departure" or "Estimated Departure"
                      // accordingly, and a hardcoded "Estimated" here would
                      // claim a landed flight had not landed.
                      //
                      // HALF WIDTH, AND UNDER THEIR OWN SCHEDULED TIME. Four
                      // tiles on the two-column grid put departure in the left
                      // column and arrival in the right, each movement directly
                      // beneath the time it was measured against — so the
                      // comparison the group exists to make is a glance down a
                      // column rather than across a row.
                      //
                      // twoLines IS WHAT MAKES THAT FIT, and it has one thing
                      // to fit rather than two. movementTimeCell used to append
                      // " (wheels up)" or " (touchdown)" as well; that is gone,
                      // and what remains is movementTile's " · 50m late" on a
                      // five-character clock -- still past the 112pt a
                      // second-column tile offers. Wrapped, it breaks at its own
                      // space rather than truncating, which is the whole point:
                      // the offset is the half that says what the clock MEANS.
                      //
                      // The row is a line taller whenever either is present.
                      // airportTiles stretches its children, so both tiles take
                      // that height and the left rule spans it; the scheduled
                      // pair above is a separate wrap row and does not move.
                      //
                      // A MOVEMENT WITH NOTHING REPORTED SHOWS ITS SCHEDULED
                      // TIME, labelled as an estimate, which is the honest
                      // reading: until an airline says otherwise a flight is
                      // expected when the timetable says. It used to read "Not
                      // departed yet" at the recede pair the empty card tiles
                      // use, and that looked disabled next to three bright tiles
                      // rather than merely quiet.
                      //
                      // It carries no colour, because the server's delay is null
                      // without an actual or estimated time to compare. So the
                      // scheduled time repeats in the row above and again here,
                      // white in both places, and neither claims the flight is
                      // running to time.
                      movementTile(flight.depTimeLabel, flight.depTimeValue, flight.depDelay),
                      movementTile(flight.arrTimeLabel, flight.arrTimeValue, flight.arrDelay),
                    ]}
                  />

                  {/* NOT A SheetGroup, because these are not tiles. A
                      half-width tile is 112pt of text on a 320pt screen and a
                      full airport name has no chance in it, so the two lines run
                      the width of the sheet.

                      NO EMPTINESS TEST EITHER, and it does not need one: from,
                      fromFull, to and toFull are non-optional on FlightData and
                      a flight without two airports is not a flight. The heading
                      cannot end up over nothing. */}
                  <View style={s.airportGroup}>
                    <Text style={s.sheetHeading}>{'Airports'}</Text>
                    <View style={s.airportPlaces}>
                      {/* NOSE UP, then nose down. The pair is the whole point:
                          two identical glyphs at opposite tilts say leaving and
                          arriving without a word, and the lines below already
                          carry the codes in departure-then-arrival order. */}
                      {/* THE RUNWAY GOES UNDER THE LOW END, which is what makes
                          the pair read as a departure and an arrival rather than
                          as one glyph rotated twice. Nose up, tail down and to
                          the LEFT, so the rule sits left; nose down and to the
                          RIGHT on the way in, so it sits right. */}
                      <View style={s.footerLine}>
                        <View style={s.footerPlaneWrap}>
                          <Text style={[s.footerPlane, s.footerPlaneUp]}>{'✈'}</Text>
                          <View style={[s.footerRunway, s.footerRunwayStart]} />
                        </View>
                        <Text style={s.footerCode}>{flight.from}</Text>
                        <Text style={s.footerName} numberOfLines={1}>{flight.fromFull}</Text>
                      </View>
                      <View style={s.footerLine}>
                        <View style={s.footerPlaneWrap}>
                          <Text style={[s.footerPlane, s.footerPlaneDown]}>{'✈'}</Text>
                          <View style={[s.footerRunway, s.footerRunwayEnd]} />
                        </View>
                        <Text style={s.footerCode}>{flight.to}</Text>
                        <Text style={s.footerName} numberOfLines={1}>{flight.toFull}</Text>
                      </View>
                    </View>
                  </View>

                  {/* LAST, because it is the least of it. Which aircraft flew a
                      route and what its tail number was are facts about the
                      metal rather than about the journey.

                      NO DATE TILE ANY MORE: it heads the times above, where it
                      belongs, and a group cannot hold the same fact twice.

                      WHAT IS LEFT IS THE CASE THE COLUMN WALK EXISTS FOR, and it
                      is now the ordinary case rather than an edge one. Two items,
                      Registration at the left of the first row and Aircraft
                      spanning the second — which is index 1, exactly where the
                      old i % 2 test would have called a full-width tile a
                      second-column tile and drawn it a left rule with nothing to
                      its left. See SheetGroup. */}
                  <SheetGroup
                    title="Aircraft"
                    items={[
                      { label: 'Registration', value: flight.registration ?? '' },
                      // LAST AND FULL WIDTH, and the order follows from the
                      // width rather than from importance. A model name does not
                      // fit half a row at any size on the scale — "Airbus A320
                      // NEO" is 15 characters, 135pt at 15pt JetBrains Mono,
                      // against 112pt of text in a second-column half tile — so
                      // it spans, and a spanning tile put anywhere but last
                      // leaves a half-row hole above it.
                      //
                      // Full width is 248pt at 320pt: the sheet less its scrim
                      // padding and its body padding, with no left padding
                      // because a spanning tile always starts a row.
                      // QUIET, and it is a SEPARATE FLAG from full rather than
                      // being read off it. They agree on this one tile and that
                      // is a coincidence of this group: full is about how much
                      // room a model name needs, quiet is about how much
                      // attention it deserves, and a later tile that spans
                      // without receding would find the two welded together.
                      // NO LABEL, because the heading above already is one. The
                      // group is called AIRCRAFT and holds exactly one aircraft;
                      // a tile labelled Aircraft underneath it said the word
                      // twice for one value. Registration keeps its label — it
                      // is the second thing in the group and the heading does
                      // not name it.
                      {
                        label: 'Aircraft', value: flight.aircraft ?? '',
                        full: true, quiet: true, hideLabel: true,
                      },
                    ]}
                  />
                </View>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* ── WHAT A LONG PRESS ON THE ROUTE OFFERS ──
          A MENU, NOT A SHEET, and the difference is in every number. The airport
          sheet is the card OPENED: it grows out of the card's own rect, rises
          CAL_RISE and runs CAL_IN_MS, because it is the same object arriving at
          a new size. This is a small panel that appears over the page to ask one
          question, so it takes the overlay's rise and the panel's timings.

          THE SAME MATERIAL THOUGH. sheetShell, GlassLayers and sheetEdge, in
          that order, exactly as every other floating surface in this app. A menu
          made of something else would be a fourth material for one control.

          NO HEAD AND NO CLOSE BUTTON. There are two actions and a scrim that
          dismisses; a title bar over two rows would still be more chrome than
          content, and the reasoning is unchanged from when there was one. The
          route itself is the caption, which is also what confirms WHICH card was
          held on a screen that can show several.

          THE SECOND ROW IS OPTIONAL. It renders only when toggleOwned was
          passed, so the map variant -- which passes neither -- gets exactly the
          one-row menu this note was originally written for.

          IT RENDERS EVEN WITH NO RECORD, and openMapMenu is what guarantees it
          never opens then. Gating the Modal on flightRecord as well would put
          the guard in two places and let them disagree. */}
      <Modal
        visible={mapMenuOpen}
        transparent
        animationType="none"
        onRequestClose={closeMapMenu}
      >
        <Pressable style={g.routeCalScrim} onPress={closeMapMenu}>
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: mapMenuScrimAnim }]}
          />
          <Animated.View
            style={[
              g.sheetShell,
              s.mapMenu,
              {
                opacity: mapMenuAnim,
                transform: [{
                  translateY: mapMenuAnim.interpolate({
                    inputRange: [0, 1], outputRange: [OVERLAY_RISE, 0],
                  }),
                }],
              },
            ]}
          >
            <GlassLayers />
            <View style={g.sheetEdge} pointerEvents="none" />
            {/* Swallows the tap so the scrim's dismiss does not fire through. */}
            <Pressable style={s.mapMenuBody}>
              <Text style={s.mapMenuRoute}>{`${flight.from} to ${flight.to}`}</Text>
              {/* THE GLYPH AND THE WORDS SAY THE SAME THING, which is what makes
                  this row and the swipe button behind the same gesture read as
                  one control: green pin and "Remove" when the route is drawn,
                  dim pin and "Add" when it is not. */}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={chooseMapToggle}
                style={s.mapMenuAction}
                accessibilityRole="button"
              >
                <Svg width={20} height={20} viewBox="0 0 24 24">
                  {routeOnMap ? ICON_MAP_ON : ICON_MAP}
                </Svg>
                <Text style={[s.mapMenuLabel, routeOnMap && s.mapMenuLabelOn]}>
                  {routeOnMap ? 'Remove route from map' : 'Add route to map'}
                </Text>
              </TouchableOpacity>
              {/* -- AND THE SAME CONTROL FOR THE TRIP --
                  THE CARD'S OWN BOOKMARK, REUSED RATHER THAN RESTATED. BOOKMARK_D
                  is the path the left swipe panel already draws for save, and the
                  treatment is that button's: the GLYPH carries the state and the
                  surface does not -- filled green when it is yours, outlined at
                  the dim ink when it is not -- so this reads as one control
                  changing state rather than as two different buttons.

                  NO SWIPE BUTTON TO GO WITH IT. The left panel already holds
                  refresh and the bookmark; a third would crowd a gesture that is
                  two-deep and put a trip decision behind a stroke nobody would
                  find. The long press is where a second action belongs, and it
                  now has two. */}
              {toggleOwned !== undefined && (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={chooseOwnToggle}
                  style={s.mapMenuAction}
                  accessibilityRole="button"
                >
                  <Svg width={20} height={20} viewBox="0 0 24 24">
                    <Path
                      d={BOOKMARK_D}
                      fill={isOwnedFlight === true ? '#4ade80' : 'none'}
                      stroke={isOwnedFlight === true ? '#4ade80' : SWIPE_INK_DIM}
                      strokeWidth={1.75}
                    />
                  </Svg>
                  <Text style={[s.mapMenuLabel, isOwnedFlight === true && s.mapMenuLabelOn]}>
                    {isOwnedFlight === true ? 'Remove from My Flights' : 'Add to My Flights'}
                  </Text>
                </TouchableOpacity>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
            {/* THE ONE THE COMMIT ANIMATES, and s.resultWrap rides on it because
                the gap belongs to whichever element holds the children. Two
                animation systems, one each: React Native's Animated owns the
                entry on the view outside this, Reanimated owns the exit here,
                and the Swipeable inside owns the drag. None of the three needs
                to know about the other two. */}
            <Reanimated.View style={[s.resultWrap, cardExitStyle]}>
            {/* THE SWIPE IS THE CARD'S ALONE NOW. It wrapped the whole result
                and dragged the route block along with it, which said the gesture
                belonged to everything on screen; it belongs to the record, and
                the card is what represents the record.

                RIGHT TO SAVE, LEFT TO REVEAL NOTIFY — the saved row's vocabulary,
                so the gesture means one thing everywhere in the app.

                childrenContainerStyle carries sf.rowSurface, the page's own
                #050505. The card has no fill of its own, and without one the
                panel behind it would be legible straight through every gap
                between its rows the moment a drag began. It is an opaque
                rectangle, and it is invisible: it is painted in exactly the
                colour it is painted over. It now covers the card rather than the
                whole result, which is the only part that moves over the panel.

                NO LEFT PANEL ON AN ARCHIVED RECORD: undefined, not a disabled
                panel, which is the same mechanism renderLeft already uses on an
                archive row with nothing to restore. The library renders no panel
                at all and the drag has nothing to uncover. See isArchivedCard.
                The notify panel is unaffected — an archived flight is finished,
                but nothing about that makes the right-hand side wrong. */}
            <ReanimatedSwipeable
              ref={cardSwipe}
              friction={1.15}
              overshootFriction={2}
              animationOptions={SWIPE_SPRING}
              onSwipeableWillOpen={onCardWillOpen}
              // ── AND THIS IS WHY THE CARD WAS OPAQUE ──
              // rowSurface IS backgroundColor: PAGE_BG, WHICH IS #050505 WITH
              // NO ALPHA. It goes on the Swipeable's children container, which
              // is an ANCESTOR of the view holding the BlurView -- so the blur
              // had nothing behind it to sample but solid black, and returned
              // solid black. Four rounds of fixes went to the tint, the fill
              // and the gradient, every one of them ABOVE the blur, where none
              // of them could have helped.
              //
              // IT IS STILL RIGHT EVERYWHERE ELSE. Its job is to stop the swipe
              // panels being legible through the row: the library renders them
              // as absoluteFill siblings UNDER the children, and a transparent
              // row occludes nothing. On a black page an opaque black backdrop
              // is invisible, which is why this was free for two years and
              // ruinous the moment the same card was put over a map.
              //
              // NOTHING SHOWS THROUGH IN THE VARIANT, and that was read rather
              // than assumed. In ReanimatedSwipeable.js the children container
              // is style={[animatedStyle, childrenContainerStyle]} and
              // animatedStyle is a translateX and a pointerEvents -- no
              // background of its own; styles.container is { overflow:
              // 'hidden' } alone; and the two action wrappers take their
              // children from renderLeftActions?.() and renderRightActions?.(),
              // which are undefined here. The wrappers exist and paint nothing.
              // Omitting this leaves the container with no background at all,
              // which is exactly what a card over a map wants.
              childrenContainerStyle={mapVariant ? undefined : sf.rowSurface}
              // THE SUPPRESSIONS STILL WIN. mapVariant and isArchivedCard both
              // mean "no panel at all", and neither is overridden by the trip
              // variant choosing which panel it would otherwise have had.
              renderLeftActions={
                mapVariant || isArchivedCard
                  ? undefined
                  : (tripVariant ? renderTripLeft : renderCardLeft)
              }
              renderRightActions={mapVariant || tripVariant ? undefined : renderCardRight}
            >
              {/* AT THE AIRPORT. The specification table became the three
                  things somebody standing in a terminal actually looks for. The
                  rest of that table did not vanish — it moved into the sheet
                  this card opens, which is the whole of the arrangement: what
                  you need while you are standing in a terminal is on the card,
                  what is merely on file about the flight is one tap away.

                  So Scheduled Departure and Scheduled Arrival are not here,
                  because they are already the two big times on the route row
                  BELOW — this card sits first on the page now — and printing them
                  again was the table repeating the headline in a smaller font. Nor are the date, the aircraft, the
                  registration or the airports' full names, because they are
                  archival rather than operational: true when the card opened and
                  true a week later.

                  PRESSING ANYWHERE ON THE CARD opens the sheet. No chevron:
                  the card's own press feedback is the affordance, exactly as it
                  is on a watchlist row, and a chevron would promise the card
                  expands in place when it does not.

                  IT DOES NOT FIGHT THE SWIPE. ReanimatedSwipeable's pan needs
                  dragOffsetFromLeftEdge / dragOffsetFromRightEdge of horizontal
                  travel — 10pt by default — before it activates, and when it
                  does it takes the responder and cancels the press. A tap never
                  reaches that threshold, which is why the watchlist rows have
                  been TouchableOpacity inside ReanimatedSwipeable all along. */}
              {/* cardW MEASURES THE CARD NOW, and it is the same number it was:
                  the old onLayout sat on resultWrap, which has no horizontal
                  padding, so the card already filled it. What changed is what it
                  MEANS — ExpandAction reads it as the width of the thing being
                  dragged, and the thing being dragged is this. */}
              {/* activeOpacity 1 AND NO onPress ON THE MAP, rather than a
                  different element. Swapping the TouchableOpacity for a View
                  would change the tree shape between variants and remount the
                  whole card body the first time one was opened from the map;
                  a touchable with nothing to do and no feedback is inert and
                  costs a wrapper nobody sees. */}
              <TouchableOpacity
                activeOpacity={mapVariant ? 1 : 0.7}
                onPress={mapVariant ? undefined : openAirportSheet}
                onLayout={e => { cardW.value = e.nativeEvent.layout.width; }}
              >
              {/* HIDDEN WHILE THE SHEET IS UP, because the sheet is not a panel
                  over the card — it is the card, opened. Two copies of the same
                  three facts on screen at once says otherwise.

                  OPACITY RATHER THAN UNMOUNTING. Taking it out of the tree would
                  collapse its height, the results list would reflow behind the
                  sheet, and the scroll position would have moved by the time the
                  sheet closed. This holds the space and costs nothing.

                  It is instant in both directions on purpose. The card goes as
                  the sheet leaves it and returns as the sheet lands back on it,
                  so there is never a frame with both.

                  collapsable={false} FOR THE MEASUREMENT, not for the layout:
                  without it Android may flatten this View away and
                  measureInWindow returns nothing usable. Same reason the
                  dropdown anchors carry it. */}
              {/* THE SAME GLASS THE SHEETS USE, and the same three pieces in
                  the same order: sheetShell for the clip, GlassLayers for the
                  blur and its tint, then the hairline edge over both. The card
                  is the surface you tap to open a sheet made of exactly this
                  material, so it reading as a flat fill underneath was the one
                  place the vocabulary broke.

                  CARD_RADIUS, NOT SHEET_RADIUS. sheetShell and sheetEdge both
                  carry 16, which is a sheet's corner; a card's is 12. Both are
                  composed with a style that overrides only the radius, so the
                  clip, the border width and SHEET_EDGE's colour still come from
                  the shared pair rather than being respelled here. */}
              <View
                ref={airportCardRef}
                collapsable={false}
                style={[
                  g.sheetShell, s.airportCard,
                  // THE TOP EDGE IS THE SCREEN'S, so there must not be a corner
                  // on it. Squaring the two upper corners and paying the safe
                  // area back as padding is what lets the surface run up behind
                  // the cutout with nothing of its own visible up there -- the
                  // island reads as the top of the card rather than as something
                  // sitting above it.
                  mapVariant && { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
                  // insets.top + CARD_PAD, DOWN FROM insets.top + MAP_CARD_FADE
                  // + CARD_PAD -- 113 to 73 on a 59pt inset. The fade's 40
                  // points were being paid twice: once as the ramp, which is
                  // paint, and again as padding, which is space. Only the first
                  // is needed. The first line now begins inside the last stretch
                  // of the ramp, where it is nearly transparent, which is where
                  // it should have been all along.
                  mapVariant && { paddingTop: insets.top + CARD_PAD },
                  airportSheetOpen && s.airportCardStood,
                ]}
              >
                {/* ── ONE FILL, NOT TWO, AND HALF AS DENSE ──
                    THE CARD RENDERED OPAQUE AND THE ARITHMETIC SAYS WHY. It was
                    GlassLayers -- a BlurView under a tint of rgba(0,0,0,0.22) --
                    and then a second fill of rgba(5,5,5,0.82) over that. Two
                    translucent layers multiply what they let through:

                      0.78 through the tint  x  0.18 through the fill  =  0.14

                    Fourteen per cent of a blurred image survived, and the image
                    is a globe painted #050505 and #121212. Fourteen per cent of
                    near-black over near-black is black. The BlurView was never
                    covered and was compositing correctly the whole time -- it
                    was simply buried under 86% of ink.

                    SO THE TINT AND THE FILL ARE ONE LAYER NOW, at 0.55, which
                    passes 45% instead of 14%. GlassLayers is not used here at
                    all rather than being used and then undone.

                    0.55 RATHER THAN THE HOME BUTTON'S 0.82, and the difference
                    is area. A 40pt disc at 0.82 reads as dark glass because the
                    eye has the whole map beside it for comparison; a card that
                    fills the upper half of the screen at the same value has
                    nothing to be compared against and simply reads as a panel.
                    Big surfaces need to be thinner than small ones to say the
                    same thing. */}
                {mapVariant ? (
                  <>
                    {/* AND IT STARTS BELOW THE CAP TOO. The cap is opaque, so
                        the blur under it could not show through -- but "could
                        not" is a claim about compositing and the ask was that
                        nothing be there to make the claim about. Inset by
                        insets.top, there is no blur, no vibrancy and no
                        backdrop sample anywhere in the island's band; the only
                        thing painting there is a solid #000000. The blur still
                        covers every pixel of the card that is not the cap,
                        which is all of it that is meant to be glass. */}
                    <BlurView
                      intensity={SHEET_BLUR}
                      tint="systemChromeMaterialDark"
                      experimentalBlurMethod="dimezisBlurView"
                      style={[StyleSheet.absoluteFill, mapVariant && { top: insets.top }]}
                      pointerEvents="none"
                    />
                    {/* ── BLACK AT THE TOP, NOTHING AT THE BOTTOM ──
                        THE FLAT FILL IS GONE, and that is the whole change. Any
                        constant fill makes the card the same darkness at the
                        island as it is over the middle of the map, which is
                        exactly the two things this has to do differently: hide a
                        piece of hardware at the top, and be genuinely see-through
                        below it. One value cannot do both, and 0.55 was the
                        compromise that did neither.

                        SO IT IS A RAMP, AND IT ENDS AT NOTHING. Below the fade
                        there is no fill at all -- the card is the BlurView and
                        the map is really behind it. GlassLayers' own tint is not
                        used here either, for the same reason.

                        THE CAP OWNS THE ISLAND'S BAND AND THIS OWNS THE FADE
                        UNDER IT. It used to be one three-stop ramp doing both --
                        alpha 1 from y=0 to insets.top, then down to nothing over
                        MAP_CARD_FADE. The solid half is a flat View now, so this
                        is two stops from black to nothing over MAP_CARD_FADE and
                        starts where the cap ends. Nothing overlaps it, so there
                        is nothing for it to be composited with.

                        AND THE CONTENT STARTS INSIDE THE FADE. paddingTop below
                        is insets.top + CARD_PAD, so the first line begins a
                        little way down the ramp rather than clear of it. */}
                    <LinearGradient
                      // ── PURE BLACK, NOT THE PAGE'S BLACK ──
                      //
                      // THE DIFFERENCE WAS FIVE LEVELS AND NOTHING ELSE. The
                      // stops were rgba(5,5,5,1) -- #050505, this app's page
                      // colour -- and the Dynamic Island is the panel switched
                      // off, which is #000000. Five of 255 is under two per
                      // cent, which is exactly the "slightly lighter" that made
                      // the seam visible.
                      //
                      // IT IS NOT THE BLUR SHOWING THROUGH. The first two stops
                      // are alpha 1, so nothing beneath them reaches the screen
                      // -- the BlurView, the fill and the map are all fully
                      // covered for the whole solid section. The only thing that
                      // could be lighter than the island there is the colour
                      // itself, and it was.
                      //
                      // THE PAGE COLOUR IS STILL RIGHT EVERYWHERE ELSE. #050505
                      // is what a card sits ON; this is a card pretending to be
                      // the hardware, which is a different job.
                      colors={['rgba(0,0,0,1)', 'rgba(0,0,0,0)']}
                      locations={[0, 1]}
                      // AND THE RAMP STARTS BELOW THE CAP AS WELL, so its own
                      // solid section no longer exists: the cap owns the band
                      // and this owns the fade under it. One stop pair, from
                      // black to nothing, over MAP_CARD_FADE -- which is what
                      // the three-stop version was always describing and is now
                      // the only thing it does. Nothing overlaps the cap, so
                      // nothing can be composited with it.
                      style={[s.mapCardFade, { top: insets.top, height: MAP_CARD_FADE }]}
                      pointerEvents="none"
                    />
                    {/* ── AND A FLAT BLACK CAP OVER THE ISLAND'S OWN BAND ──
                        THE GRADIENT'S FIRST SECTION IS ALREADY alpha 1, so this
                        paints the same colour in the same place -- which is the
                        point. It removes the whole class of reasons the band
                        could be anything other than #000: a stop interpolated in
                        premultiplied space, a `locations` array the platform
                        rounds differently, a CAGradientLayer dithered against
                        the layer below, or the BlurView being composited over a
                        sibling rather than under it. A plain View with a
                        backgroundColor has none of those degrees of freedom.
                        Whatever the gradient was doing up there, this is what is
                        on screen now.

                        insets.top AND NOT insets.top + MAP_CARD_FADE. The cap's
                        job is the hardware's band only; the ramp below it is
                        still the ramp, and the card is still genuinely
                        see-through under the cutout. */}
                    <View
                      style={[s.mapCardCap, { height: insets.top }]}
                      pointerEvents="none"
                    />
                  </>
                ) : (
                  <GlassLayers />
                )}
                {/* ── NO LIT EDGE ANYWHERE NEAR THE ISLAND ──
                    g.sheetEdge IS A 1px BORDER ON ALL FOUR SIDES at
                    rgba(255,255,255,0.08). With the top corners squared and the
                    card running to y=0, the top run drew a lit line straight
                    across the screen's top edge beside the cutout, and
                    borderTopWidth: 0 removes that.

                    THE CORNERS ARE THE REST OF IT, and they are the only thing I
                    found painting ABOVE the gradient -- every value I had been
                    changing was below it. s.airportCardEdge re-declares
                    borderRadius: CARD_RADIUS, which the card's own
                    borderTopLeftRadius: 0 does not reach -- it is a different
                    View -- so the edge kept two 12pt rounded top corners on a
                    card that has none. borderTopWidth: 0 removes the straight
                    run between them but NOT the arcs: the left and right borders
                    still curve up and inward, drawing two short lit strokes at
                    rgba(255,255,255,0.08) either side of the cutout, which is
                    about twenty levels of grey in exactly the place the island
                    is being compared against. Squaring them ends it. */}
                <View
                  style={[
                    g.sheetEdge, s.airportCardEdge,
                    // AND IT STARTS BELOW THE CAP. Squaring the corners killed
                    // the arcs, but the LEFT AND RIGHT borders still ran from
                    // y=0 down -- two 1px verticals at rgba(255,255,255,0.08),
                    // one at each screen edge, straight through the band the
                    // island is being compared against. They are the last thing
                    // in this subtree that paints anything but black up there.
                    // top: insets.top drops the whole edge below the cap, so
                    // the band is the cap and nothing else, and the card's
                    // border is unchanged everywhere it is actually visible.
                    mapVariant && {
                      top: insets.top,
                      borderTopWidth: 0,
                      borderTopLeftRadius: 0,
                      borderTopRightRadius: 0,
                    },
                  ]}
                  pointerEvents="none"
                />
                {/* THE WORD SITS IN THE HEADING'S ROW, centred on the CARD
                    rather than on the space beside the heading — which is what
                    the absolute positioning is for. left 0 and right 0 span the
                    full width and textAlign centres within that, so no mirror
                    spacer is needed on the right and the heading's own width
                    never enters into it.

                    IT CANNOT COLLIDE WITH THE HEADING. "FLIGHT CARD" ends at
                    84.4pt; the widest word this can hold is "scheduled" or
                    "cancelled" at 59.4, which spans 96.3 to 155.7 on the card's
                    252. Every other word in the vocabulary is shorter.

                    ABSOLUTE ALSO MEANS IT ADDS NO HEIGHT: Yoga skips absolutely
                    positioned children when it measures the row, so the row is
                    exactly as tall as the 11pt heading was on its own. */}
                <View style={s.airportHeadRow}>
                  <Text style={s.airportTitle}>{'Flight card'}</Text>
                  {flightRecord !== null && (
                    <StatusWord f={flightRecord} now={now} style={s.airportHeadStatus} />
                  )}
                </View>

                {/* THE MOVEMENTS FIRST, and the tiles under them. It was the
                    other way round: the gate, terminal and belt led the card and
                    these two sat below a rule. A gate number is where to stand
                    once you know the flight is running; when it left and when it
                    lands is the thing that decides whether any of the rest
                    matters, so it reads first.

                    THEY SHARE THE ROW WITH AN IDENTITY COLUMN, and no longer
                    have the card's full width. What that costs, and what was
                    done about it, is set out at the two columns below. */}
                <View style={s.airportSplit}>
                  {/* WHEN, WHICH FLIGHT, ON WHICH CARRIER. Three facts that
                      identify the record rather than report on it. The date
                      leads at 20pt in white; the number and the airline sit at
                      13 in the label grey — the sheet's own treatment of the same
                      two — because neither changes while the flight is in the
                      air.

                      CONTENT-SIZED, no flex, and the DATE is what sizes it: 120.0pt
                      at 20pt mono against the widest airline's 111.8, so this
                      column is 120 whatever carrier it holds. It had its own
                      full-width row for a while, which cost the movements
                      nothing; back here it costs them the 120.

                      hasTime BEFORE routeDateLabel, as everywhere else: that
                      helper passes through what it cannot parse, so "N/A" would
                      survive formatting and render as a date. */}
                  <View style={s.airportIdent}>
                    {hasTime(flight.date) && (
                      <Text style={s.airportDate}>{routeDateLabel(flight.date).toUpperCase()}</Text>
                    )}
                    <Text style={s.airportIdentNum} numberOfLines={1}>{flight.flight}</Text>
                    <Text style={s.airportIdentName} numberOfLines={1}>{flight.airline}</Text>
                  </View>

                  {/* THE MOVEMENTS, unchanged but for the width they get. The
                      pair and its gap are airportTimes exactly as before; this
                      adds the flex that claims the remainder and the gutter that
                      holds it off the date.

                      120pt HERE, AND MovementLine STILL TAKES THREE LINES.
                      The worst case it was sized for was "10:15 (wheels up) ·
                      50m late" — 28 characters, 252.0pt, the whole card
                      interior, which two lines of 120 could not hold however it
                      broke. With the suffix removed the worst case is "10:15 ·
                      50m late", 16 characters and 144pt, which fits in two.
                      THE THIRD LINE IS THEREFORE SLACK NOW rather than load-
                      bearing, and it is left in place: numberOfLines is a
                      ceiling, not a height, so an unused third line costs
                      nothing and taking it away is a layout change nobody asked
                      for. Worth removing deliberately, not as a side effect. */}
                  <View style={[s.airportTimes, s.airportMovements]}>
                    {/* THE SAME RULE THE SHEET USES, through the same function.
                        See MovementLine and movementTile. */}
                    <MovementLine
                      cell={movementTile(flight.depTimeLabel, flight.depTimeValue, flight.depDelay)}
                    />
                    <MovementLine
                      cell={movementTile(flight.arrTimeLabel, flight.arrTimeValue, flight.arrDelay)}
                    />
                  </View>
                </View>

                <View style={s.airportRule} />

                {/* Three tiles in one row, four as two by two. The layout and
                    the rules both live in AirportTiles; see the note there. */}
                <AirportTiles
                  gate={flight.gate}
                  terminal={flight.terminal}
                  belt={flight.baggage}
                  desk={flight.checkinDesk}
                />
              </View>
              </TouchableOpacity>
            </ReanimatedSwipeable>

            {!mapVariant && (
            <>
            {/* THE ROUTE IS A CARD AGAIN, AND THE GESTURE IS THE REASON.
                  It stood on the bare page because a surface exists to group
                  things and there was one thing left inside it. That held while
                  the block was inert. It is now something you can hold and
                  swipe, and a thing you can pick up needs an edge to pick it up
                  by: the drag has to be seen to move something, and a swipe that
                  slides loose text across black reads as a rendering fault.

                  THE PROGRESS BAR COMES INSIDE IT. The bar measures the distance
                  between the two airports named on either side of it and belongs
                  to them -- the same argument the status line's old note made
                  for sitting after the bar rather than between it and the route.
                  Now that the route has a surface, leaving the bar outside would
                  put the measure on the page and the thing it measures on a
                  card.

                  THE STATUS LINE DOES NOT. It went to the bottom of the flight
                  card above, which is what it was always about: when the RECORD
                  was last fetched is metadata about the lookup rather than a
                  fact about these two airports.

                  s.routeCard IS NOW THE SURFACE and s.routeRow is the row it
                  holds. Every text style inside is untouched; the row's own
                  style object is the old routeCard under a name that says what
                  it is. */}
            <ReanimatedSwipeable
              ref={routeSwipe}
              friction={1.15}
              overshootFriction={2}
              animationOptions={SWIPE_SPRING}
              onSwipeableWillOpen={onRouteWillOpen}
              childrenContainerStyle={sf.rowSurface}
              renderLeftActions={flightRecord === null ? undefined : renderRouteLeft}
            >
              {/* NO onPress, ONLY onLongPress. A tap on the route means nothing
                  -- the card above is what opens a sheet -- and giving this one a
                  tap action would put two different results behind two presses
                  that feel identical.

                  THE DIM ON PRESS-IN IS THE WHOLE AFFORDANCE, and it is the only
                  one there is. TouchableOpacity fades on touch whether or not a
                  press ever fires, so holding the card visibly does something
                  before the menu arrives. Same 0.7 as the flight card, so the
                  two read as the same kind of surface.

                  IT DOES NOT FIGHT THE SWIPE, for the reason the card above
                  gives: ReanimatedSwipeable's pan takes the responder after
                  about 10pt of horizontal travel and cancels the press, and a
                  long press that has moved 10pt is a drag.

                  DISABLED WITHOUT A RECORD, exactly as the panel is. There is
                  nothing to add: the id the map keys on and the timezones its
                  instants are read against both live on the record.

                  onLayout HERE RATHER THAN ON THE CARD INSIDE, because
                  ExpandAction reads routeW as the width of the thing being
                  dragged and this is what the Swipeable translates. */}
              <TouchableOpacity
                activeOpacity={0.7}
                onLongPress={openMapMenu}
                onPressIn={onRoutePressIn}
                onPressOut={onRoutePressOut}
                disabled={flightRecord === null}
                onLayout={e => { routeW.value = e.nativeEvent.layout.width; }}
              >
              {/* THE SCALE IS INSIDE THE TOUCHABLE, not on it. The touchable is
                  what the Swipeable measures for routeW and what the pan reads
                  for its own geometry; transforming it would make both of those
                  read a card that is momentarily 3% narrower than it lays out
                  as. This wraps only what is drawn. */}
              <Animated.View style={routePressStyle}>
              <View style={s.routeCard}>
                <View style={s.routeRow}>
                  <View style={s.routeLeft}>
                    <Text style={s.routeIATA}>{flight.from}</Text>
                    <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.fromCity)}</Text>
                  </View>
                  <View style={s.routeMid}>
                    {flight.duration !== null && <Text style={s.routeDuration}>{flight.duration}</Text>}
                    <Text style={s.routeArrow}>· ✈ ·</Text>
                    <Text style={s.routeDirect}>Direct</Text>
                  </View>
                  <View style={s.routeRight}>
                    <Text style={s.routeIATA}>{flight.to}</Text>
                    <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.toCity)}</Text>
                  </View>
                </View>

                {/* Hidden entirely when the flight state cannot place it. */}
                {progressValue !== null && (flight.status === 'ACTIVE' || flight.status === 'LANDED') && (
                  <ProgressBar
                    progress={progressValue}
                    color={flight.statusColor}
                    style={s.routeProgress}
                  />
                )}
              </View>
              </Animated.View>
              </TouchableOpacity>
            </ReanimatedSwipeable>

            {/* WHEN THIS WAS LAST ASKED FOR, AND IT BELONGS TO NEITHER CARD.
                It spent a round inside the flight card, under the tiles, on the
                argument that it is metadata about the record and the card shows
                the record. That was half right and it read wrong: sitting on a
                surface made it look like one of the card's facts, alongside the
                gate and the belt, when it is not about the flight at all -- it
                is about when this app last asked. The gate is true of the world;
                this is true of the lookup.

                SO IT SITS ON THE PAGE, BELOW EVERYTHING. Last child of the
                result, under both cards, on no surface -- which is what says it
                describes the whole result rather than any part of it. The
                scroll's own paddingBottom is what holds it clear of the tab bar.

                hideStatus AND hideAbsolute ARE UNCHANGED and both notes still
                hold: the word is in the card's heading, and the tail's departure
                time would repeat one the route card prints in full above. */}
            {flightRecord !== null && (
              <StatusLine
                f={flightRecord}
                now={now}
                hideStatus
                hideAbsolute
                numberOfLines={1}
                style={s.routeStatus}
              />
            )}
            </>
            )}
            </Reanimated.View>
    </>
  );
}

// index.tsx's own entries, in the order they stood in its `s`, read above as
// `s.*` exactly as they were. The name is kept so that no render block had to
// change to move.
const s = StyleSheet.create({
  // 10, down from 14. The blocks are cards now and each carries its own
  // CARD_PAD, so the space between them reads wider than the number says —
  // 14 of gap plus 28 of facing padding. 10 puts the stack back to the
  // rhythm it had when the blocks were flat.
  resultWrap: { gap: 10 },
  // The bar's own pg.wrap carries marginVertical 24, which is right when it is
  // floating on black and far too much inside a card that is already padded.
  //
  // 14 above rather than 0: pg.plane sits at top -11 with a 20pt glyph, so it
  // overflows the wrap upward and would otherwise collide with the times above
  // it. Nothing below, because pg.track's own marginBottom 14 already puts the
  // space there.
  // 2, DOWN FROM 14, AND THE TOTAL IS UNCHANGED. This bar used to sit inside
  // routeSurface, which had no gap of its own, so its 14 was the whole of its
  // clearance from the route row. It is now a child of heroCard, whose gap of 12
  // is applied first — leaving 14 in total once this adds 2, which is the figure
  // the clearance was set to in the first place.
  //
  // THAT FIGURE MATTERS MORE THAN MOST. pg.plane is positioned at top: -11, so
  // the glyph riding the bar overhangs its wrapper upward by 11pt; 14 leaves it
  // 3pt clear of the route row above, and anything under 11 would put a plane
  // through the arrival time. Leaving the 14 here would have made it 26 and
  // opened a hole in the middle of the card instead.
  // 14, UP FROM 4, AND THE TOTAL IS STILL 14. The 4 was what was left after
  // resultWrap's gap of 10 had already been applied between two siblings on the
  // page. The bar is inside the route card now, stacked directly under the row
  // with no gap in front of it, so the whole 14 has to be spelled here.
  //
  // 14 IS THE FIGURE THAT MATTERS, and it has survived three arrangements.
  // pg.plane is at top: -11, so the glyph riding the bar overhangs its wrapper
  // upward by 11pt; 14 leaves it 3pt clear of the route row above, and anything
  // under 11 would put a plane through an airport name.
  //
  // marginBottom STAYS 0, and pg.track's own 14 is why. That margin is not a
  // gap — it is the height the wrapper needs for the plane glyph to descend
  // into, since the track itself is 3pt and the glyph is 20. The card's
  // CARD_PAD sits under it.
  routeProgress: { marginTop: 14, marginBottom: 0 },
  // 8 ON TOP OF resultWrap's GAP OF 10, so this line sits 18 below the route
  // card. At the bare 10 it read as a third card that had lost its surface
  // rather than as a note under the pair of them.
  routeStatus: { marginTop: 8 },
  // THE ROUTE'S SURFACE. The app's card, in the app's constants: CARD_FILL is
  // the same 3% white every other card is painted with and CARD_RADIUS the same
  // 12, so this reads as one of the family rather than as a rectangle that
  // happens to be near them. Spelling either as a literal here is how the next
  // change to the family would leave this behind.
  //
  // CARD_PAD ALL ROUND, and the horizontal half is the visible change to the
  // row inside: the airport codes used to start at the page margin and now start
  // 14 in. Both columns move by the same 14, so the row is still a row.
  routeCard: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
  },
  // THE ROW, WHICH IS THE OLD routeCard UNDER A NAME THAT SAYS WHAT IT IS.
  // Character for character what it was; only the key changed, because the
  // surface above took the old one.
  //
  // paddingVertical is gone: it was breathing room when this row floated on
  // black, and inside a surface carrying CARD_PAD it was padding inside padding
  // — 4pt that made this card sit taller than its siblings for a reason nobody
  // would have been able to name later.
  routeRow: {
    flexDirection: "row", alignItems: "center",
  },
  routeLeft: { flex: 1 },
  routeRight: { flex: 1, alignItems: "flex-end" },
  routeMid: { alignItems: "center", paddingHorizontal: 8 },
  routeIATA: { fontSize: 32, color: "#ffffff", letterSpacing: -0.5, fontFamily: MONO_BOLD },
  routeCity: { fontSize: 13, color: "rgba(226,226,226,0.55)", marginTop: 2, fontFamily: SANS },
  routeDuration: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginBottom: 6, fontFamily: MONO },
  routeArrow: { fontSize: 20, color: "rgba(226,226,226,0.45)", fontFamily: MONO },
  routeDirect: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 6, fontFamily: MONO },
  // ── THE LONG-PRESS MENU ────────────────────────────────────────────────────
  //
  // alignSelf CENTRE, so the panel is only as wide as the longest line in it
  // rather than the full width g.routeCalScrim would otherwise give it. A menu
  // of one row stretched across the screen reads as a sheet that failed to
  // load its contents.
  mapMenu: { alignSelf: "center", minWidth: 220 },
  // TIGHTER THAN g.sheetBody's 20. That padding is sized for a sheet with a
  // header and four groups in it; this holds two lines.
  mapMenuBody: { padding: 16, gap: 12 },
  // THE CAPTION, in the voice every other label in this file uses: 11pt Inter at
  // 0.4. It names the subject and is not the action, so it must not compete with
  // the row under it.
  mapMenuRoute: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI,
    letterSpacing: 1, textTransform: "uppercase",
  },
  // 10 between the glyph and the word, the same gutter the swipe button leaves
  // around its own 20pt icon.
  mapMenuAction: { flexDirection: "row", alignItems: "center", gap: 10 },
  // 15, WHICH IS THE APP'S WORKING SIZE for a value rather than a label. This is
  // the thing being chosen, so it is the largest text on the panel.
  mapMenuLabel: { fontSize: 15, color: SWIPE_INK_DIM, fontFamily: SANS },
  // COLOUR ONLY, so the size and family above still apply. Green when the route
  // is already drawn, which pairs with the glyph beside it.
  mapMenuLabelOn: { color: "#4ade80" },
  // NO backgroundColor ANY MORE. CARD_FILL was the card's whole surface; the
  // glass tint inside GlassLayers is now, and a fill here would sit BEHIND the
  // blur and be flattened into it — the same reason sheetShell and routeDropPanel
  // both refuse one. Composed after sheetShell so this radius wins over the
  // sheet's 16.
  airportCard: {
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 14,
  },
  // sheetEdge at a card's corner. Radius only: the position, the hairline and
  // SHEET_EDGE's colour all still come from sheetEdge itself.
  airportCardEdge: { borderRadius: CARD_RADIUS },
  // THE RAMP'S BOX. Pinned to the top and full width; its HEIGHT is set inline
  // because it is the safe-area inset plus the fade, and only the render knows
  // the inset.
  mapCardFade: { position: 'absolute', top: 0, left: 0, right: 0 },
  // THE CAP'S BOX. Same box as the ramp's, and its height is the inset alone.
  //
  // #000000, ALPHA 1, AND NOTHING ELSE IN THE BAND. Not rgba, not a token, not
  // PAGE_BG -- the literal blackest value the display can be asked for, written
  // where it can be read. The BlurView, the ramp and the hairline all start at
  // insets.top now, so this is the ONLY layer painting between y=0 and the
  // bottom of the cutout, and it is alpha 1, so nothing under it composites
  // either.
  mapCardCap: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000000' },
  // Invisible but still laid out. See the note at the card.
  airportCardStood: { opacity: 0 },
  // detailsTitle's treatment, as its own style. NOT detailsTitle itself: that
  // one is shared with the watchlist heading on the home screen, and this card
  // wants no marginBottom because the card's own gap already spaces it.
  airportTitle: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI,
    letterSpacing: 1, textTransform: "uppercase",
  },
  // THE SHEET'S HEADINGS, forked from airportTitle above rather than edited into
  // it: that style still heads the CARD's at-the-airport row, and the card keeps
  // its uppercase.
  //
  // NO textTransform AND NO letterSpacing. Uppercase and tracking were the last
  // of that treatment left in the sheet once the FLIGHT group and the date
  // heading went, and two shouted words among four groups of sentence case read
  // as leftovers rather than as a system. The strings are already written in the
  // case they now render in — 'Airports', 'Aircraft' — so dropping the transform
  // is the whole change.
  //
  // 13, NOT THE 11 airportTitle CARRIES, and the case is exactly why. Uppercase
  // and tracking were doing the work of separating a heading from the labels
  // under it; with both gone, an 11 here would differ from airportTileLabel only
  // by font weight — same size, same colour — and "Airports" would read as one
  // more label rather than as the thing heading them. A step up the scale does
  // the separating instead, and both words are short enough for it to cost
  // nothing: at 13pt Inter SemiBold "Airports" is 50.9pt and "Aircraft" 47.9,
  // against the sheet's 248.
  sheetHeading: { fontSize: 13, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI },
  // TWO UNLIKE HALVES, on the same 50/50 split the tile grid uses so the block
  // lines up with the groups under it.
  sheetFlightHead: { flexDirection: "row" },
  // No paddingLeft: it is the first column, exactly as airportTileFirst is.
  sheetFlightWhen: { flexBasis: "50%" },
  // 12 to clear the date, the same gutter a second-column tile takes. 14 between
  // the two fields, the same gap airportCard uses between its blocks.
  sheetFlightWhat: { flexBasis: "50%", paddingLeft: 12, gap: 14 },
  // Label over value, at the tile's own 4.
  sheetFlightField: { gap: 4 },
  // 32, the top of the scale, and the only thing in the sheet that uses it. The
  // date is the largest fact here because it is the one that frames every other:
  // a gate or a clock means nothing until you know which day it belongs to.
  //
  // Both lines share this style rather than having one each — they are one
  // object broken across two lines, not a heading and a subheading.
  //
  // 0.4, THE SAME GREY AS EVERYTHING AROUND IT, and the size carries it instead
  // of the colour. It was white, which made it shout twice: at 32 it is already
  // the largest thing in the sheet by a wide margin, and full white on top of
  // that put it ahead of the times and gates people actually open the sheet to
  // read. Grey at 32 still reads first — nothing else here is close to that size
  // — without outranking the values below it.
  //
  // It leaves the tile values as the only white left in the sheet, which is the
  // point: white now means "a reading", and everything that names or frames one
  // is grey.
  sheetFlightDate: { fontSize: 32, color: "rgba(226,226,226,0.4)", fontFamily: MONO_BOLD },
  // rowGap only. There is no column gap on purpose: the basis percentages have
  // to add up to the row exactly, and a gap between them would push the third
  // tile onto a second line when three were meant to fit.
  airportTiles: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", rowGap: 14 },
  // No flex and no grow — the basis below is the whole of the sizing, which is
  // what makes the wrap predictable. paddingLeft holds the text off the rule on
  // its left edge; the tile that starts a visual row has neither.
  airportTile: { paddingLeft: 12, gap: 4 },
  // 33.33 x 3 = 99.99%, which fits one line. 50 x 4 = 200%, which cannot, so it
  // breaks after the second. Two constants, no arithmetic at render time.
  airportTileThird: { flexBasis: "33.33%" },
  airportTileHalf: { flexBasis: "50%" },
  // The whole row, so it wraps onto a line of its own whatever precedes it.
  // Only the sheet uses this; the card's three and four tile rows both divide
  // evenly and have nothing that needs the full width.
  airportTileFull: { flexBasis: "100%" },
  airportTileFirst: { paddingLeft: 0 },
  // Absolutely positioned, so Yoga skips it when it measures the tile and the
  // rule cannot change the column's width. top and bottom 0 give it the tile's
  // full height, and the row's alignItems stretch makes every tile in a line
  // the same height, so the rules line up.
  airportTileRule: {
    position: "absolute",
    left: 0, top: 0, bottom: 0,
    width: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  airportTileLabel: { fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS },
  // THE SHEET'S LABELS, one step heavier than the card's. Family only, so the 11
  // and the grey above still apply and the empty state's colour still overrides
  // on top of it.
  //
  // SANS_SEMI IS WHAT BOLD MEANS FOR SANS HERE — there is no SANS_BOLD constant,
  // and it is the weight sheetHeading uses. That is the point: the labels now
  // carry the same weight as the headings above them, so the sheet reads as one
  // system of names rather than as headings in one voice and labels in another.
  //
  // The card keeps airportTileLabel alone. See the `sheet` flag on AirportTile.
  sheetTileLabel: { fontFamily: SANS_SEMI },
  airportTileValue: { fontSize: 20, color: "#ffffff", fontFamily: MONO_BOLD },
  // SIZE ONLY, so the white and the mono bold above still apply and the empty
  // state's colour still overrides on top. It brings this row to the same 15
  // every other value in the sheet uses — the same figure archiveTileValue
  // carries, reached by overriding rather than by pointing the card's component
  // at a sheet-named style.
  airportTileValueSmall: { fontSize: 15 },
  // 15, AND IT HAS BEEN BOTH. It went to 20 to match the card's tiles, on the
  // argument that a smaller value here read as the more deliberate one because
  // these tiles hold real values where the card's often hold dashes. On device
  // 20 was simply too large for a surface this dense — four groups of it — and
  // the sheet read as a poster rather than as a record.
  //
  // Widths were measured against the shipped fonts rather than estimated: at
  // 15pt mono a clock is 45pt and a registration 54pt, against 112pt of text in
  // a second-column half tile. Only the aircraft model needs more than that, and
  // it has the full width.
  archiveTileValue: { fontSize: 15, color: "#ffffff", fontFamily: MONO_BOLD },
  // 13 RATHER THAN THE TILE'S 15, and it is SHEET_QUIET_SIZE rather than a
  // literal so that it moves with the airport lines it was put alongside. This
  // used to hold the tile's own 15 and recede on weight and colour alone; the
  // size went too once it became clear the model belongs with the quiet tier
  // rather than a shade below the working values.
  //
  // MONO rather than MONO_BOLD, because weight in this file is the family and
  // never a fontWeight.
  //
  // 0.4, WHICH IS THE LABEL GREY — airportTileLabel's exact colour, and that is
  // the point rather than a coincidence. It went in at 0.55, a step between the
  // full-white values and the labels, and on screen a value one step down from
  // white still reads as a value being pointed at. This is the least important
  // fact in the sheet. Sitting it AT label weight rather than above it says so:
  // the label and the model name carry the same visual claim, which is very
  // little, and everything that matters is brighter than both.
  archiveTileValueQuiet: {
    fontSize: SHEET_QUIET_SIZE, fontFamily: MONO, color: "rgba(226,226,226,0.4)",
  },
  // FAMILY ONLY, so the 15 and the white are still archiveTileValue's.
  //
  // SANS, NOT SANS_SEMI — changed deliberately, and it drops the weight as well
  // as the family, because weight in this file IS the family. That is the point
  // for these two tiles: an airline and a flight number identify the record
  // rather than report on it, and nothing about them changes while the flight
  // is in the air. The values that do change stay bold.
  archiveTileValueSans: { fontFamily: SANS },
  // The same idea on the mono side: MONO where the tile's own style is
  // MONO_BOLD. See the `mono` flag.
  //
  // TWO USERS NOW. The other is the delay run nested inside a movement tile's
  // value, which wants exactly this and nothing else: family only, so it
  // inherits the 15 and the amber from the Text it sits inside.
  archiveTileValueMono: { fontFamily: MONO },
  // COLOUR ONLY, both of them, so the 15 and the mono bold are untouched and a
  // tile does not change size when a delay lands. The two greens and ambers in
  // this app are one pair of constants; these read them rather than respelling
  // the hexes.
  archiveTileValueOnTime: { color: CD_GREEN },
  archiveTileValueLate: { color: CD_LATE },
  // COLOUR ONLY, and only the header's two identifiers take it. Size and family
  // are still archiveTileValue's and the family override's.
  //
  // 0.4 IS THE QUIET TIER — the same grey the airport lines, the aircraft model
  // and every tile label use. A flight number and a carrier are what the record
  // is CALLED; the times, gates and belts below them are what it is DOING, and
  // at full white the two identifiers were as loud as the readings underneath.
  //
  // IT IS A SEPARATE STYLE rather than a colour added to archiveTileValueMono
  // and archiveTileValueSans above, because those two are family-only by
  // definition and SheetGroup still offers them to any tile through its `mono`
  // and `sans` flags. Tinting them there would quietly grey out the next tile
  // that only wanted a different family.
  sheetFlightIdent: { color: "rgba(226,226,226,0.4)" },
  airportRule: { height: 1, backgroundColor: "rgba(255,255,255,0.06)" },
  // 28 BETWEEN GROUPS against airportGroup's 10 WITHIN one, and the ratio is the
  // point rather than either number: a heading has to sit closer to the tiles it
  // names than to the group above it, or it reads as floating between two sets
  // of them.
  //
  // IT WAS 20, WHICH WAS NOT ENOUGH. Two to one sounds like a clear separation
  // and does not look like one — 10 and 20 read as one rhythm slightly uneven,
  // and the sheet clumped. At 28 the gap is nearly three times the one inside a
  // group and the levels separate.
  //
  // THIS STYLE ONLY. airportGroup's 10 is untouched, and deliberately: it has
  // two users — SheetGroup and the AIRPORTS block — so it governs every group's
  // heading-to-content spacing at once, while this gap has one user and is the
  // sheet's alone. The body padding, the tile row gap and the tile's own 4 are
  // all unchanged.
  airportSheetBody: { gap: 28, paddingTop: 10 },
  // A heading and the tiles it names. 10 rather than the card's 14: the card
  // has one heading and space to spend on it, the sheet has several and wants
  // them tight to their own group.
  airportGroup: { gap: 10 },
  // The airport lines' own container. footerLine, footerCode and footerName are
  // reused as they are — identical values, and duplicating three style objects
  // to get sheet-scoped names would be worse than the names being slightly off.
  airportPlaces: { gap: 6 },
  // The heading and the status word share a row. No justifyContent: the word is
  // absolute and takes no part in the layout, so the heading sits where it
  // always did, at the left.
  airportHeadRow: { flexDirection: "row", alignItems: "center" },
  // SPANS THE ROW AND CENTRES IN IT. left 0 / right 0 rather than a width, so
  // the centre is the card's centre whatever the word turns out to be.
  airportHeadStatus: {
    position: "absolute", left: 0, right: 0,
    textAlign: "center", fontFamily: MONO, fontSize: 11,
  },
  // TWO COLUMNS UNDER THE DATE: identity on the left, movements on the right.
  airportSplit: { flexDirection: "row" },
  // NO FLEX, so it takes its content's width — the date, at 120.0pt. 3 between
  // the three lines, which is the marginTop flightAirline used to carry.
  airportIdent: { gap: 3 },
  // The remainder, and 12 to hold it off the date. The gap is airportTimes'
  // own, composed rather than restated.
  // alignItems flex-end RIGHT-ALIGNS THE BOXES, and textAlign on the two text
  // styles right-aligns the lines inside them. Both are needed: without the
  // first a single-line label sits left in a full-width column, and without the
  // second a value that WRAPPED has a full-width box whose lines would still
  // read from the left. See airportTimeLabel and airportTimeValue.
  // paddingRight 8, AND IT IMPROVES THE WRAP RATHER THAN COSTING ANYTHING.
  // Right-aligning put the values hard against the card's inner edge, which read
  // as overflowing it; 8 holds them inboard.
  //
  // The column goes from 120pt to 112. This used to be argued from a worst case
  // of "10:15 (wheels up) · 50m late", which needed three lines at either width
  // and broke more cleanly at 112. That suffix is gone; the worst case is now
  // "10:15 · 50m late" and breaks in two at both widths. The 112 stands on the
  // label argument below, which is unaffected.
  // paddingRight 8, BACK DOWN FROM 20, and a label decided it rather than taste.
  // 20 was affordable while the date had its own row and this column ran to 170
  // on a short carrier; with the date back in the column beside it the column is
  // a flat 252 - 120 - 12 = 120, and a 20pt inset would leave 100.
  //
  // AT 100 "Estimated Departure" TRUNCATES. It is 106.4pt at 11pt Inter and
  // MovementLine holds its label to one line, so the commonest label on a
  // scheduled flight would have rendered as "Estimated Departur...". At 8 the
  // text width is 112.0 and it clears by 5.6.
  //
  // The values are unaffected either way: the worst case is now "10:15" /
  // "· 50m late" and fits in two lines at both widths.
  airportMovements: { flex: 1, paddingLeft: 12, paddingRight: 8, alignItems: "flex-end" },
  // 20, and the largest thing in this card. See the note at the column.
  //
  // marginBottom 7 ON TOP OF airportIdent's gap of 3, so the date sits 10 above
  // the flight number while the number and the airline stay 3 apart. At a flat 3
  // all three read as one block; the date is not part of that pair — it frames
  // both of them — and better than three times the gap is what says so. The
  // margin came off while the date had its own row and the card's gap did the
  // spacing; it is back because the row is gone.
  airportDate: {
    fontSize: 20, color: "#ffffff", fontFamily: MONO_BOLD, marginBottom: 7,
  },
  // The identifiers, in the label grey. Mono for the number because it is a
  // code, sans for the carrier because it is a name — the same split the sheet's
  // header makes, one step down the scale.
  airportIdentNum: { fontSize: 13, fontFamily: MONO, color: "rgba(226,226,226,0.4)" },
  airportIdentName: { fontSize: 13, fontFamily: SANS, color: "rgba(226,226,226,0.4)" },
  airportTimes: { gap: 12 },
  // Right-aligned with the column, so a short label and a long value end on the
  // same edge instead of starting on one.
  airportTimeRow: { gap: 3, alignItems: "flex-end", alignSelf: "stretch" },
  // textAlign right on both: the wrap points do not move — wrapping is decided
  // by width alone — but the ragged edge moves to the LEFT, so a value broken
  // over three lines ends flush with the card's right edge on every one of them.
  airportTimeLabel: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS, textAlign: "right",
  },
  airportTimeValue: {
    fontSize: 15, color: "#ffffff", fontFamily: MONO_BOLD, textAlign: "right",
  },
  // CD_LATE, not a fresh literal: it is already this file's #fbbf24 for a
  // movement running late, and one definition of that colour is enough.
  airportTimeLate: { color: CD_LATE },
  // The other half of the pair, and the same two constants the sheet's tiles
  // read. Colour only, so a line does not move when a delay arrives.
  airportTimeOnTime: { color: CD_GREEN },
  footerLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  // 13 — and these are now the SHEET'S styles alone, since the card's footer was
  // retired and the airports group is the only thing left rendering them. They
  // went to 15 with everything else and came back with it. At 13 the code takes
  // 23pt and the row's gap 8, leaving 217 of the sheet's 248, against 162 for a
  // name as long as "Indira Gandhi International".
  // THE GLYPH BEFORE EACH AIRPORT LINE. Size and colour match footerCode beside
  // it, so the plane reads as part of the same quiet line rather than as an icon
  // bolted to the front of it.
  //
  // NO fontFamily, AND NOT BY OVERSIGHT. Neither bundled face carries U+2708 —
  // checked against the cmap tables of JetBrainsMono_400Regular and
  // Inter_400Regular, and it is absent from both — so this glyph comes from the
  // platform's fallback wherever it appears in this file, including routeArrow,
  // which asks for MONO and does not get it. Naming a family here would say
  // something untrue about what renders.
  //
  // ITS ADVANCE IS THEREFORE UNKNOWN to us, and it does not need to be. Both
  // lines use the SAME glyph at the SAME size, so whatever width the platform
  // gives it is given to both, and the two codes stay in a column with each
  // other. Only the absolute indent is out of our hands.
  //
  // marginRight ON TOP OF footerLine's gap of 8. A tilted glyph reaches further
  // right than its upright box suggests, and 2 more keeps its nose off the code.
  // THE PLANE AND ITS RUNWAY, as one unit sitting where the glyph alone used to.
  //
  // THE ROW'S BASELINE STILL RESOLVES THROUGH THE GLYPH. footerLine aligns its
  // children on the baseline, and a View has none of its own — Yoga takes it from
  // the first child still in the flow, which here is the Text. The runway is
  // absolute and therefore out of that reckoning, so the wrapper reports the
  // glyph's baseline exactly as the bare Text did and the code and the name do
  // not move.
  //
  // AND THE ROW DOES NOT GROW. An absolutely positioned child contributes no
  // height, so the wrapper measures the Text and nothing else. The rule is
  // anchored at bottom: 0 rather than hung below it, which keeps it inside that
  // box — a rule at a negative offset would need overflow to be visible on
  // Android to survive, and would be a clip waiting to happen.
  //
  // The marginRight moved here from the Text: it belongs to the unit, and left
  // on the Text it would have widened the box the runway anchors to.
  footerPlaneWrap: { marginRight: 2 },
  footerPlane: {
    fontSize: SHEET_QUIET_SIZE, color: "rgba(226,226,226,0.4)",
  },
  // A View with a background, not a border, as every hairline in this file is.
  footerRunway: {
    position: "absolute", bottom: 0,
    width: 8, height: 1, backgroundColor: "rgba(226,226,226,0.4)",
  },
  // EDGE ANCHORS, NOT OFFSETS, and that is deliberate. The glyph comes from the
  // platform's fallback — no bundled face carries U+2708 — so its advance is not
  // knowable here, and any offset measured from the centre would be a guess that
  // drifts per device. left and right pin the rule to the glyph's own box
  // instead, so it lands under the tail and under the nose at whatever width the
  // platform gives.
  footerRunwayStart: { left: 0 },
  footerRunwayEnd: { right: 0 },
  // ROTATION DOES NOT MOVE THE BOX. transform is a paint-time operation in React
  // Native: the Text is laid out and baseline-aligned by footerLine as though it
  // were upright, then spun about its own centre. So the alignment the row was
  // already doing is the alignment that holds, and no offset is needed to put
  // the plane back on the baseline the code and the name share.
  footerPlaneUp: { transform: [{ rotate: '-20deg' }] },
  footerPlaneDown: { transform: [{ rotate: '20deg' }] },
  footerCode: { fontSize: SHEET_QUIET_SIZE, fontFamily: MONO, color: "rgba(226,226,226,0.4)" },
  // flex 1 so the name takes whatever the code leaves and truncates there rather
  // than wrapping onto a second line under it.
  footerName: {
    fontSize: SHEET_QUIET_SIZE, fontFamily: SANS, color: "rgba(226,226,226,0.4)", flex: 1,
  },
  // FOUR PROPERTIES ON TOP OF airportTitle, and only four. The family, the
  // letterSpacing and the uppercase transform all still come from that style, so
  // the sheet's title and the card's heading are set in one voice and cannot
  // drift; what this adds is the two that make a title a title and the two that
  // place it.
  //
  // 20 AND WHITE, AGAINST airportTitle's 11 AND 0.4 GREY. Taking the whole of
  // that style put the sheet's own name below the section headings inside it —
  // sheetHeading is 13 in the same grey — and a head quieter than its own
  // contents is not a head. The card's heading keeps the 11 and the grey,
  // because there it labels one block among several rather than naming the
  // surface.
  //
  // IT FITS, and uppercase with tracking is the case to check: "FLIGHT CARD" is
  // 144.5pt at 20pt Inter SemiBold with letterSpacing 1, against 200pt between
  // the head's 24pt spacer and its 24pt close button on a 320pt screen.
  //
  // flex: 1 IS SAFE HERE and was not always — it resolves to flexBasis 0 on the
  // MAIN axis, and sheetHead is a ROW, so that means "fill the width between the
  // spacer and the close button", which is what textAlign centres against. The
  // same declaration inside a COLUMN once gave this title no height at all.
  sheetHeadTitle: {
    flex: 1, fontSize: 20, color: "#ffffff", textAlign: "center",
  },
  // A CEILING ONLY, unlike archiveSheet's floor and ceiling. That sheet holds a
  // list of unknown length and needs a minimum so it does not open as a stub;
  // this one holds a bounded amount — at most five tiles in two columns, so
  // three rows, plus two single-line airport rows — and should be exactly as
  // tall as it is rather than padded out to a proportion of the screen.
  //
  // The ceiling is the same 82%, so no sheet in this app can swallow the scrim
  // at both ends. At default text sizes the content comes to roughly 290pt
  // against 466 on the shortest screen this runs on, so the cap is a guard
  // rather than a limit — see the ScrollView note in the body.
  airportSheet: { maxHeight: "82%" },
});

// THE RESULT STACK'S GAP, and the one entry here that another module still reads.
//
// It could not stay behind. The element carrying it is the exit wrapper, whose
// four children are the card, the route row, the bar and the status line — and
// that element came here with the throw that animates it, so the gap had to come
// too or stop spacing anything. app/index.tsx puts the same style on its chat
// block and its route block, so it is exported and imported back rather than
// copied. One declaration, three readers, as before.
export const resultWrap = s.resultWrap;

// The two entries of index's `sf` that are the CARD'S rather than a row's: its
// opaque ground and its action panel. A local sheet of the same name, so both
// call sites read as they did. The rest of `sf` is the watchlist row's and stayed
// with it.
const sf = StyleSheet.create({
  // THE ROW'S OWN FILL, and the fix for actions showing through their row.
  //
  // ReanimatedSwipeable renders both action panels as absoluteFill siblings
  // UNDER the children — correct z-order, but a transparent row occludes
  // nothing, so the panel behind was legible straight through the flight number
  // and the date. The library's own guard is opacity: progress === 0 ? 0 : 1,
  // which hides a panel only while it is exactly shut; the moment a drag starts,
  // or after one is interrupted, it is visible through the row.
  //
  // THE FLIGHT CARD'S, AND ONLY ITS. The saved rows drive the same colour from
  // a worklet instead, so they can drop it at rest and keep the archive sheet's
  // glass — see surfaceStyle in SavedFlightRow.
  //
  // THE CARD DOES NOT NEED THAT. It only ever sits on the page, and this is the
  // page's own colour, so the fill is invisible whether it is there or not.
  // Animating it would buy nothing and cost the card a mapper per frame.
  rowSurface: { backgroundColor: PAGE_BG },
  // THE CARD'S PANEL, and the two differences from swipeGroup above are both
  // consequences of height.
  //
  // alignItems FLEX-START, not centre. Centring is right on a 60pt row, where
  // the middle of the panel and the middle of the row are the same place. The
  // card is several hundred points tall, so centring would park the buttons
  // halfway down a panel whose content — the flight number, the badge — is at
  // the top, and a long way from wherever the finger started the drag.
  //
  // NO marginBottom. swipeGroup's CARD_GAP corrects for the gap below a row in a
  // list of rows; the card is not in a list and has no gap to correct for.
  //
  // paddingTop CARD_PAD, because the hero is a padded card now rather than a
  // flat header. The flight number used to start 4pt down — flightHeader's own
  // paddingVertical — and now starts CARD_PAD down, inside the hero's own
  // padding. The button's top edge lines up with the top of the flight number
  // either way; only the number that gets it there changed. Reading the
  // constant rather than repeating 14 means the two cannot drift if it moves.
  cardSwipeGroup: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: CARD_PAD },
  // THE ROUTE CARD'S PANEL, and it centres where the flight card's pins to the
  // top. That is the difference height makes, and it is the same reasoning
  // cardSwipeGroup gives in reverse: the flight card is several hundred points
  // tall, so centring would park its buttons a long way from anything; the route
  // card is about as tall as a watchlist row, and on a row the middle of the
  // panel and the middle of the card are the same place.
  routeSwipeGroup: { flexDirection: 'row', alignItems: 'center' },
});
