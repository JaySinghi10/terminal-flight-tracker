// The saved flights, and everything that keeps them true.
//
// All of this was app/index.tsx's. It moved because the list is not the home
// screen's: the tab bar's search field, and every screen that will want a
// watchlist, need the same records, the same account and the same refresh
// discipline, and a second copy of any of it would be a second answer to a
// question the store already answers.
//
// WHAT IS HERE: the list, the account email, the refresh loop and its caps, the
// undo window, and the reminder scheduling. WHAT IS NOT: every toast, message,
// collapse state and sheet that reports on any of it. Those are the home
// screen's and stayed there.
//
// TWO CLOCKS, DELIBERATELY, AND THEY ARE NOT THE SAME CLOCK. This provider runs
// a minute tick of its own whose only jobs are the day rollover and the
// AppState resume check, and it does NOT expose the reading. The home screen
// keeps its own tick for the countdowns on its rows. One shared `now` would
// have been the obvious economy and it is the wrong one: a value that changes
// every sixty seconds, read through a context every consumer subscribes to, is
// a re-render of every screen in the app once a minute for the benefit of one
// screen's countdowns.
//
// SO THE DERIVED LISTS STAY ON THE SCREEN. activeSaved and archivedSaved are
// functions of the list AND of the clock, so they belong wherever the clock
// they are read against lives. This exposes the raw list; the refresh loop
// derives the active subset internally, from its own reading.
import {
  createContext, useContext, useState, useRef, useEffect, useCallback, useMemo,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import {
  SavedFlight,
  getSavedFlights,
  saveFlight,
  unsaveFlight,
  touchSavedFlight,
  setFlightArchived,
  setFlightReminders,
  setFlightTrip,
  savedFlightFromApi,
  ISO_DAY_RE,
  migrateLegacyIfNeeded,
  mergeGuestInto,
} from './storage';
import { zonedIsoToTs } from './time';
import {
  ensureChannel,
  ensurePermission,
  reminderTimes,
  scheduleFor,
  cancelFor,
  reconcile,
} from './reminders';
import { registerWatch, deregisterWatch } from './watch';

export const API_BASE = 'https://flight-tracker-970706733452.asia-south1.run.app';

// The flight endpoint's URL, in one place, because four fetch sites build it and
// they must agree. Both parameters are optional and both are omitted when null,
// so an argument-free call produces the URL this file has always sent.
//
// The query is ASSEMBLED rather than concatenated. Appending "&origin=" to a
// path that has no "?date=" on it — which is every route-row tap on an undated
// board, the commonest case there is — would send a malformed URL and lose the
// filter silently, which is the same class of fault this change exists to fix.
export function flightUrl(number: string, date: string | null, origin: string | null): string {
  const parts: string[] = [];
  if (date !== null && date !== '') parts.push(`date=${date}`);
  if (origin !== null && origin !== '') parts.push(`origin=${origin}`);
  return `${API_BASE}/flight/${number}${parts.length === 0 ? '' : `?${parts.join('&')}`}`;
}

// These caps protect the AeroDataBox quota.
const PULL_COOLDOWN_MS = 60 * 1000;
const AUTO_REFRESH_MAX_FLIGHTS = 2;
const AUTO_REFRESH_MIN_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000; // auto-refresh disabled while on the free tier; set to 12 * 60 * 60 * 1000 to re-enable
const AUTO_REFRESH_RESUME_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// The provider's BASIC plan caps requests at one per second and rejects the rest
// with HTTP 429, so consecutive saved-flight lookups are spaced past that ceiling.
const REFRESH_SPACING_MS = 1300;

// The backend accepts one day back (ROUTE_MAX_PAST_DAYS). A record older than
// that can only ever be refused, so it is never asked for. Kept slightly under
// two days so a local date one side of the server's UTC date still qualifies.
const REFRESH_MAX_PAST_MS = 36 * 60 * 60 * 1000;

// Relevance order: in the air, then upcoming, then finished. Unparseable times
// sink to the end of their own group rather than the end of the list.
const SAVED_RANK: Record<string, number> = { active: 0, scheduled: 1, delayed: 1 };
const RANK_LAST = 2;
export const NO_TIME = Number.MAX_SAFE_INTEGER;

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

// AND THE WINDOW OUTLIVES THE TOAST, deliberately, by six times over. They
// answer different questions: the toast asks "do you want this back right now",
// the window asks "is this decision still reversible". Someone who reads the
// toast, thinks about it, and taps the bookmark twenty seconds later gets the
// flight back with its reminders intact, and nothing about the banner having
// faded should change that. Coupling them would make the undo as short as the
// notice, which is the shortest of the two for reasons that have nothing to do
// with how long a decision takes.
//
// IN MEMORY ONLY. Nothing is written, so closing the app ends the window and the
// record stays deleted — closing an app is not an undo. The notifications left
// pending by that are swept by the next reconcile on launch, which is what that
// sweep is for.
const UNDO_WINDOW_MS = 30000;

// WHAT ENABLING REMINDERS CAN COME TO. An outcome rather than a sentence,
// because two callers report it and they are answering different questions: the
// swipe was asked to turn reminders on and reports on that alone, while a save
// was asked to save and reports on that first.
export type RemindOutcome = 'on' | 'denied' | 'too-late' | 'no-time';

// The swipe's wording, unchanged from when it was the only caller.
const REMIND_SWIPE_MSG: Record<RemindOutcome, string> = {
  on: 'reminders on',
  denied: 'notifications are turned off for this app',
  'too-late': 'too late to set a reminder for this one',
  'no-time': 'no departure time to remind you about',
};

// The save's wording. SAVED COMES FIRST IN EVERY ONE OF THEM, because saving is
// what the user asked for and it succeeded in all four cases — reminders are the
// thing that happened as well, or did not. A save that reported only a reminder
// failure would read as a save that failed.
//
// Shorter than the swipe's, and deliberately: prefixing "saved · " to the
// swipe's own strings gives 46 and 45 characters, which overflows one line at
// any width this app runs at. These are 20 to 26, which fits 320pt.
export const SAVE_MSG: Record<RemindOutcome, string> = {
  on: 'saved · reminders on',
  denied: 'saved · reminders off',
  'too-late': 'saved · too late to remind',
  'no-time': 'saved · no departure time',
};

// THE OWNERSHIP PATH'S WORDING, and it is SAVE_MSG's argument applied to the
// other verb.
//
// ADDED COMES FIRST IN EVERY ONE OF THEM, for the identical reason saved does:
// adding the flight is what the user asked for and it succeeded in all four
// cases -- reminders are the thing that happened as well, or did not. A line
// reporting only a reminder failure would read as an add that failed.
//
// AND IT HAS TO EXIST AT ALL, which is the point rather than the tidiness.
// ownFlight calls enableReminders on BOTH its paths, so adding a flight to My
// Flights turns reminders on exactly as saving one does. saveRecord reports
// that; this is the ownership path's copy of the same report. A user who had
// deliberately turned reminders off must not have them come back with no
// notice.
//
// THE SAME LENGTH DISCIPLINE. Prefixing the swipe's own strings would give 46
// and 45 characters, which overflows one line at any width this app runs at.
// These are 20 to 26, the same band SAVE_MSG sits in, which fits 320pt.
//
// THE SAME SEPARATOR, character for character: the middle dot SAVE_MSG uses,
// spaced. Two banners in one app reporting one kind of outcome must not be
// punctuated differently.
export const OWN_MSG: Record<RemindOutcome, string> = {
  on: 'added · reminders on',
  denied: 'added · reminders off',
  'too-late': 'added · too late to remind',
  'no-time': 'added · no departure time',
};

// ── THE RULES ABOUT A RECORD ────────────────────────────────────────────────
//
// Pure, and shared. They are here rather than on the home screen because the
// refresh loop and the archive rule both read them and a screen must never be
// the place another screen imports from.

// YYYY-MM-DD from the device's own calendar parts. Never toISOString, which
// reports UTC and lands on the wrong day either side of midnight.
export function localIsoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function localDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// The instant a flight arrived, or is expected to. Actual first, then the
// estimate, then the schedule — the same precedence the status line uses.
export function arrivalTs(f: SavedFlight): number | null {
  return zonedIsoToTs(f.to.actualIso ?? f.to.estimatedIso ?? f.to.scheduledIso, f.to.timezone);
}

// THE INSTANT A FLIGHT LEFT, or is expected to. arrivalTs's rule read from the
// other end of the record, and the two are written together so the precedence
// cannot come apart: actual first, then the estimate, then the schedule.
//
// NOT USED BY THE ARCHIVE, which is why this arrived later than its pair. It is
// the departure half of a route drawn on the map -- an arc needs to know when
// the flight starts as well as when it ends, and the aircraft riding it needs
// both to sit anywhere on it.
export function departureTs(f: SavedFlight): number | null {
  return zonedIsoToTs(f.from.actualIso ?? f.from.estimatedIso ?? f.from.scheduledIso, f.from.timezone);
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
export function hasFlown(f: SavedFlight, now: number): boolean {
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
export function effectiveStatus(f: SavedFlight, now: number): string {
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

export function isArchived(f: SavedFlight, now: number): boolean {
  // The hand overrules the clock, and only in one direction: archivedAt can put
  // a flight in the archive early, and clearing it hands the flight back to the
  // rule rather than pinning it out. See setFlightArchived.
  if (f.archivedAt !== null) return true;
  const ts = arrivalTs(f);
  return ts !== null && now - ts > ARCHIVE_AFTER_ARRIVAL_MS;
}

// `now` for effectiveStatus, and for nothing else: the keys themselves are
// absolute instants and do not move with the clock.
export function savedSortKey(f: SavedFlight, now: number): { rank: number; when: number } {
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
export function sortSavedByRelevance(list: SavedFlight[], now: number): SavedFlight[] {
  return [...list].sort((a, b) => {
    const ka = savedSortKey(a, now);
    const kb = savedSortKey(b, now);
    return ka.rank !== kb.rank ? ka.rank - kb.rank : ka.when - kb.when;
  });
}

// ── OWNERSHIP ───────────────────────────────────────────────────────────────
//
// A FLIGHT THE USER IS FLYING, as against one they are watching. The store has
// carried both in one list since it existed, and tripId is the only thing that
// separates them; these are the rules that read it. Pure and exported, beside
// the sort they sit with, because the screens that group and the store that
// writes must not be two answers to what a trip is.

// AN ID FOR A JOURNEY, OPAQUE, AND MINTED AT THE MOMENT OF OWNERSHIP. Nothing
// reads it but an equality test: it NAMES a journey and says nothing about one.
//
// NEVER DERIVED FROM THE FLIGHT, and the two reasons are the ones that bite
// later rather than now. A derived id COLLIDES when the same flight is owned
// twice -- owned, disowned, and owned again as part of a different journey --
// and it would have to CHANGE when two legs are merged into one trip, which
// means rewriting the field on every record already carrying it. An opaque
// value minted here is stable under both.
//
// THE CLOCK AND FOUR RANDOM CHARACTERS. The timestamp separates two ids minted
// in different milliseconds on its own; the suffix covers two minted inside one,
// which a loop owning three legs at once can do.
function newTripId(): string {
  return `trip:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
}

export function isOwned(f: SavedFlight): boolean {
  return f.tripId !== null;
}

// EVERY RECORD SHARING A tripId, IN THE ORDER THEY ARE FLOWN.
//
// BY THE DEPARTURE INSTANT, never by a stored index -- see the field's own note
// in storage. departureTs already resolves actual, then estimate, then schedule
// against the airport's zone, so a leg that is delayed re-orders itself without
// anything being rewritten.
//
// NO_TIME FOR A LEG WITH NO READABLE DEPARTURE, exactly as savedSortKey does it:
// a pre-v3 record or one with no timezone sinks to the end of its own trip
// rather than to the front, because an absent time is not an early one.
//
// PURE. filter already returns a new array, so the sort cannot reach the
// caller's list.
export function legsOfTrip(list: SavedFlight[], tripId: string): SavedFlight[] {
  return list
    .filter(f => f.tripId === tripId)
    .sort((a, b) => (departureTs(a) ?? NO_TIME) - (departureTs(b) ?? NO_TIME));
}

// WHERE A TRIP SITS, as a rank and a time, which is savedSortKey's shape and for
// savedSortKey's reason: the two questions are asked in order and the second
// only breaks ties in the first.
//
// THE RANK IS "HAS IT ANY FLYING LEFT". A trip with a leg still to fly outranks
// one whose legs have all flown, and it does so on the RANK rather than on the
// time -- because a trip that is still ahead but whose only unflown leg has an
// unreadable departure would otherwise tie with a finished one at NO_TIME, and
// "all flown sorts after every trip that has not" would quietly stop being true.
//
// THE TIME IS THE EARLIEST LEG STILL TO FLY. legs arrive already ordered, so the
// first unflown one IS the earliest. A finished trip is keyed on its first leg's
// departure, which keeps completed journeys in the order they were taken.
//
// hasFlown, NOT the stored status, for the reason stated where it is declared:
// an archived record's status is frozen at whatever the last refresh saw.
function tripSortKey(legs: SavedFlight[], now: number): { rank: number; when: number } {
  const next = legs.find(f => !hasFlown(f, now));
  if (next !== undefined) return { rank: 0, when: departureTs(next) ?? NO_TIME };
  return { rank: 1, when: departureTs(legs[0]) ?? NO_TIME };
}

// EVERY OWNED RECORD, GROUPED INTO JOURNEYS AND ORDERED.
//
// LEGS BY legsOfTrip, so there is one ordering rule for a trip's contents and
// this cannot come to disagree with a screen that calls it directly.
//
// NOTHING IS FILTERED OUT HERE, and that is deliberate rather than an omission.
// A finished trip is still a trip, and whether it belongs under a heading or in
// an archive is a split against a clock -- which is the screen's to make,
// exactly as index.tsx already makes it with isArchived. This orders; it does
// not hide.
//
// UNOWNED RECORDS ARE NOT A TRIP OF THEIR OWN. They are the watchlist, which is
// the list this is derived FROM, and returning them here as one-leg trips would
// make every watched flight look like a journey.
export function tripsOf(list: SavedFlight[], now: number): SavedFlight[][] {
  const ids: string[] = [];
  for (const f of list) {
    if (f.tripId !== null && !ids.includes(f.tripId)) ids.push(f.tripId);
  }
  return ids
    .map(id => legsOfTrip(list, id))
    .sort((a, b) => {
      const ka = tripSortKey(a, now);
      const kb = tripSortKey(b, now);
      return ka.rank !== kb.rank ? ka.rank - kb.rank : ka.when - kb.when;
    });
}

// ── WHAT A SAVE CAME TO ─────────────────────────────────────────────────────
//
// An outcome rather than a sentence, for exactly the reason RemindOutcome is
// one: the two callers say different things about the same three endings. The
// card's bookmark raises a toast, the route row's raises the error channel and
// shakes, and neither wording belongs in the store.
export type SaveOutcome =
  | { kind: 'restored' }
  | { kind: 'limit' }
  | { kind: 'saved'; remind: RemindOutcome };

// WHAT A PULL CAME TO. Every field the home screen needs to report on it, and
// nothing already on this context.
//
// `ran` IS NOT `throttled`. False means the re-entry guard rejected the pull
// outright — iOS can double-fire one — and nothing happened at all, not even
// the greeting reroll. Throttled means the pull was accepted and the cooldown
// declined to spend anything, which is a thing to say out loud.
//
// `list` IS THE LIST AS READ BACK FROM STORAGE, not the state this then set.
// The open card's own record is looked up in it, and a setState is not visible
// to the caller that awaited this in the same turn.
export type RefreshReport = {
  ran: boolean;
  throttled: boolean;
  failures: number;
  openCardFresh: any;
  list: SavedFlight[] | null;
};

type SavedContextValue = {
  savedFlights: SavedFlight[];
  email: string | null;
  setEmail: (email: string | null) => void;
  refreshing: boolean;
  saveRecord: (record: SavedFlight) => Promise<SaveOutcome>;
  handleUnsave: (f: SavedFlight) => Promise<string>;
  undoUnsave: (onTaken?: () => void) => Promise<'none' | 'restored' | 'limit'>;
  refreshOne: (record: SavedFlight, targetId?: string) => Promise<void>;
  refreshAll: (openCardId: string | null, onStarted?: () => void) => Promise<RefreshReport>;
  handleRemind: (f: SavedFlight, on: boolean) => Promise<string>;
  setArchived: (f: SavedFlight, on: boolean) => Promise<void>;
  setTrip: (f: SavedFlight, tripId: string | null) => Promise<void>;
  ownFlight: (record: SavedFlight, tripId?: string) => Promise<{ ok: true; remind: RemindOutcome }>;
  disownFlight: (f: SavedFlight) => Promise<void>;
};

const SavedContext = createContext<SavedContextValue | null>(null);

export function useSaved(): SavedContextValue {
  const v = useContext(SavedContext);
  if (v === null) throw new Error('useSaved must be used inside a SavedProvider');
  return v;
}

export function SavedProvider({ children }: { children: ReactNode }) {
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshingRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const lastAutoRefreshRef = useRef(0);
  // WHEN THE PROVIDER LAST ANSWERED ABOUT A FLIGHT, by id.
  //
  // THE FACT RECORDED IS "ATTEMPTED", NOT "FAILED", and that is the whole idea.
  // The staleness filter in autoRefresh is meant to be self-clearing: attempt a
  // flight, it leaves the candidate set, the next run reaches the ones behind
  // it. That works because touchSavedFlight advances updatedAt — which it does
  // only on success. So updatedAt is the only record of "we tried this", and a
  // flight whose lookup fails never leaves the set: it sits at the head of the
  // list consuming one of the two attempts on every run, for ever, starving
  // everything behind it. Nothing here is a fairness rule bolted on top; this is
  // the missing half of a fact the filter already depends on.
  //
  // MEMORY ONLY, and correctly so. A failure is a fact about one attempt, not
  // about the flight, and there is no reason to believe an attempt that failed
  // this morning still predicts anything after a relaunch. It dies with the
  // process, which is also why it needs no eviction: it is bounded by the
  // flights one session actually touches.
  const lastTriedRef = useRef<Map<string, number>>(new Map());
  const dayRef = useRef(localDayKey(Date.now()));
  // THE WINDOW ITSELF: the deleted record and the timer that ends its life.
  //
  // A ref rather than state, because nothing on screen is derived from it. The
  // toast is its own state and outlives nothing; this is the record, and a
  // re-render when it opens or closes would be a render for no visible reason.
  const undoRef = useRef<{ flight: SavedFlight; timer: ReturnType<typeof setTimeout> } | null>(null);

  // THE EMAIL IS HYDRATED HERE, and this is the one read that moved rather than
  // being handed over.
  //
  // The home screen's own hydration reads username, gmailToken, displayName and
  // savedCollapsed in the same pass and still does; only 'email' is read again
  // here. Two reads of one key at launch is the price of the store owning the
  // account it is keyed on, and the alternative was worse in a way that is not
  // obvious: the screen would have had to push both the email AND a "hydration
  // finished" signal into this provider, which makes a screen the authority on
  // whether the store is ready.
  //
  // authHydrated IS PRIVATE and stays private. It gates the load below so the
  // list is not fetched once for a null email and again for the real one. The
  // home screen keeps its own copy for its own gating; the two answer the same
  // question about different reads and neither is derived from the other.
  useEffect(() => {
    if (Platform.OS === 'web') {
      const e = localStorage.getItem('email');
      if (e) setEmail(e);
      setAuthHydrated(true);
    } else {
      SecureStore.getItemAsync('email').then(e => {
        if (e) setEmail(e);
        setAuthHydrated(true);
      });
    }
  }, []);

  // ── THE UNDO WINDOW ────────────────────────────────────────────────────────
  //
  // ONE WINDOW AT A TIME. A second unsave replaces the first, and the first
  // record's notifications are cancelled at that moment rather than left to a
  // timer nobody is holding: the record is gone from storage and now gone from
  // memory too, so nothing will ever restore it and its reminders would fire for
  // a flight that no longer exists anywhere.
  const beginUndoWindow = useCallback((f: SavedFlight) => {
    const prev = undoRef.current;
    if (prev !== null) {
      clearTimeout(prev.timer);
      cancelFor(prev.flight.id);
    }
    // THE CANCEL HAPPENS HERE, ON EXPIRY, AND NOWHERE ELSE. Unsaving does not
    // touch the schedule at all — that is what makes an undo whole rather than
    // an undo that restores a record and silently loses its reminders.
    undoRef.current = {
      flight: f,
      timer: setTimeout(() => {
        undoRef.current = null;
        cancelFor(f.id);
      }, UNDO_WINDOW_MS),
    };
    // [] FOR ALL THREE OF THESE. undoRef is a ref, which React guarantees is
    // stable, and everything else they touch is an import or a module constant.
    // There is nothing reactive to depend on, so they are formed once.
  }, []);

  // The held record IF it is this flight, and the window closes with it.
  //
  // KEYED ON THE ID, which is the number and the date: another instance of the
  // same number on another day is a different flight and must not be handed
  // someone else's record.
  const takeUndoRecord = useCallback((id: string): SavedFlight | null => {
    const w = undoRef.current;
    if (w === null || w.flight.id !== id) return null;
    clearTimeout(w.timer);
    undoRef.current = null;
    return w.flight;
  }, []);

  // What reconcile must not sweep. See lib/reminders.ts.
  const undoKeepIds = useCallback((): string[] =>
    undoRef.current === null ? [] : [undoRef.current.flight.id], []);

  // Shared fetch-and-store loop. Sequential; per-flight try/catch; touchSavedFlight on
  // success; captures the open card's fresh data. Returns counts only — no UI side effects.
  //
  // openCardId IS A PARAMETER NOW, and that is the first of the two untanglings.
  // It read flightRecord?.id off the home screen's own state, which is what tied
  // a storage loop to a card being open on one screen. The caller knows which
  // record it has on screen; this only needs the id to decide what to hand back.
  const refreshFlights = useCallback(async (
    list: SavedFlight[],
    maxAttempts: number,
    openCardId: string | null,
  ): Promise<{ failures: number; openCardFresh: any }> => {
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
        // THE PROVIDER ANSWERED, AND THE ANSWER WAS NO. Recorded, because that
        // is a fact about THIS FLIGHT: a not-found will be a not-found again in
        // five minutes, so backing off costs nothing and yields the turn.
        //
        // See the catch below for the half that is deliberately not recorded.
        if (data.error || !response.ok) {
          lastTriedRef.current.set(f.id, Date.now());
          failures++;
          continue;
        }
        // A SUCCESS NEEDS NO ENTRY: touchSavedFlight below advances updatedAt,
        // which the filter already reads.
        // f.id, not the fresh record's: a record filed under "unknown" has no
        // date for its id to have been built from, and this is what lets the
        // response supply one.
        await touchSavedFlight(email, savedFlightFromApi(data), f.id);
        if (openCardId && f.id === openCardId) openCardFresh = data;
      } catch {
        // NOTHING RECORDED HERE, and the split from the branch above is
        // load-bearing rather than tidiness. A thrown fetch is a fact about the
        // NETWORK — offline, DNS, a timeout, a body that would not parse — and
        // says nothing whatever about this flight. Record it and one offline
        // stretch puts the first flights attempted into a twelve-hour back-off,
        // so the run after connectivity returns skips precisely the flights that
        // most need refreshing. While offline nothing can succeed anyway, so
        // retrying the same two costs nothing and starves nobody.
        failures++;                                           // one failure must not abort the loop
      }
    }
    return { failures, openCardFresh };
  }, [email]);

  // Silent background refresh: no spinner, no message. Failures are invisible — the row age tells the truth.
  const autoRefresh = useCallback(async (list: SavedFlight[], isCancelled: () => boolean) => {
    if (refreshingRef.current) return;
    // THE LATER OF THE TWO. updatedAt says when this flight's data last came
    // back; the map says when the provider last answered about it at all. A
    // flight is a candidate only when BOTH are old enough, which is what makes
    // the filter self-clearing again for failures as well as successes.
    //
    // updatedAt IS NOT ADVANCED ON A FAILURE, and must not be — it would be the
    // shortest fix and it is wrong twice over. It is a storage write, and worse,
    // updatedAt means "when this data was fetched": flightLineSegments reads it
    // against COUNTDOWN_MAX_AGE_MS to decide whether a row may show a LIVE
    // COUNTDOWN at all, so advancing it on a failure would put a ticking
    // "departs in 2h 14m" over data that was never updated. The row would go
    // from honestly stale to confidently wrong.
    //
    // ONLY autoRefresh READS THIS. onRefresh deliberately does not: a pull is
    // the user asking, and the user is allowed to retry a flight the background
    // gave up on.
    // `at`, not `now`: this component already has a `now` state, and shadowing
    // the ticking clock with a one-off reading inside a function is how the two
    // get confused later.
    const at = Date.now();
    const stale = list.filter(f =>
      at - Math.max(f.updatedAt, lastTriedRef.current.get(f.id) ?? 0) > AUTO_REFRESH_MIN_AGE_MS);
    if (stale.length === 0) return;
    refreshingRef.current = true;
    try {
      // NULL, because this pass has never had an open card to feed. It called
      // refreshFlights and discarded the returned payload, so passing no id is
      // exactly what it already did — the capture simply never fires now.
      await refreshFlights(stale, AUTO_REFRESH_MAX_FLIGHTS, null);
      const fresh = await getSavedFlights(email);             // re-read once, set state once
      if (isCancelled()) return;                              // account switched / unmounted mid-flight
      setSavedFlights(fresh);
      lastAutoRefreshRef.current = Date.now();
    } finally {
      refreshingRef.current = false;
    }
  }, [email, refreshFlights]);

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

  // THE PROVIDER'S OWN MINUTE TICK, and it exposes nothing.
  //
  // The home screen's tick used to do three jobs: advance `now` for the
  // countdowns, notice a day rollover, and run the AppState resume checks. Only
  // the last two are the store's, and they are the two that were never about
  // the clock being READ — they are about a boundary being CROSSED. So the
  // reading stays private and the screen keeps its own interval for the value it
  // actually renders. See the note at the top of this file.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const t = Date.now();
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
        getSavedFlights(email).then(l => { if (!cancelled) reconcile(l, undoKeepIds()); });
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
  // TURNING THEM ON, and the only place that does it. Two callers now want this
  // — the remind swipe and every save — and they want to SAY different things
  // about the same four outcomes, so what comes back is the outcome and not a
  // sentence. Duplicating the scheduling to get different wording would have put
  // two copies of the permission check, the arithmetic and the write order in
  // the file, and the write order is the part that must not vary.
  //
  // Permission first, the store LAST, exactly as before: nothing is recorded if
  // the user refuses or if there is nothing left to schedule, because a record
  // saying reminders are on with no notifications behind it survives every
  // reconcile — reconcile trusts this field.
  const enableReminders = useCallback(async (f: SavedFlight): Promise<RemindOutcome> => {
    if (!(await ensurePermission())) return 'denied';
    // Both null means the evening before has passed and the leave-now instant —
    // three hours before a domestic departure, four before an international one
    // — has passed too. Nothing is written: an empty reminder is a promise the
    // app cannot keep.
    const t = reminderTimes(f, Date.now());
    if (t.evening === null && t.leave === null) {
      return f.from.scheduledIso && f.from.timezone ? 'too-late' : 'no-time';
    }
    await scheduleFor(f);
    setSavedFlights(await setFlightReminders(email, f.id, Date.now()));
    return 'on';
  }, [email]);

  const handleRemind = useCallback(async (f: SavedFlight, on: boolean): Promise<string> => {
    if (!on) {
      await cancelFor(f.id);
      setSavedFlights(await setFlightReminders(email, f.id, null));
      return 'reminders off';
    }
    return REMIND_SWIPE_MSG[await enableReminders(f)];
  }, [email, enableReminders]);

  // EVERY UNSAVE GOES THROUGH HERE, so the window cannot depend on which control
  // the user reached for. It does three things and deliberately not a fourth: it
  // removes the record, it opens the window, and it says so. It does NOT cancel
  // the notifications — see beginUndoWindow.
  //
  // IT RETURNS THE SENTENCE RATHER THAN SHOWING IT. showUndo is the home
  // screen's banner and stayed there; this composes the line because it is the
  // only thing that knows whether the record had reminders on it before it went.
  const handleUnsave = useCallback(async (f: SavedFlight): Promise<string> => {
    const hadReminders = f.remindersSetAt !== null;
    setSavedFlights(await unsaveFlight(email, f.id));
    deregisterWatch(API_BASE, f.flightNumber, f.flightDate);
    beginUndoWindow(f);
    // THE NUMBER LEADS. "unsaved" alone says nothing about which of seven rows
    // just went, and that fact used to live in the swipe's own message.
    //
    // "reminders" AND NOT "reminders off", and the word cut was the weakest one
    // in the line twice over. It costs four characters the line does not have —
    // 30 against a budget of 26 — and it was already a claim slightly ahead of
    // the facts: the notifications are still pending and are only cancelled when
    // the window closes. Naming them in the list of what went is the honest
    // version and the short one.
    return hadReminders ? `${f.flightNumber} unsaved · reminders` : `${f.flightNumber} unsaved`;
  }, [email, beginUndoWindow]);

  // RESTORING IS SAVING THE HELD RECORD, not building a new one: it carries its
  // own savedAt, archivedAt and remindersSetAt, so the flight comes back exactly
  // as it left. Nothing is rescheduled because nothing was cancelled.
  const restoreUnsaved = useCallback(async (held: SavedFlight): Promise<boolean> => {
    const result = await saveFlight(email, held, f => !isArchived(f, Date.now()));
    setSavedFlights(result.flights);
    if (result.ok) registerWatch(API_BASE, held.flightNumber, held.flightDate);
    return result.ok;
  }, [email]);

  // THE BANNER'S CONTROL, minus the banner.
  //
  // onTaken FIRES SYNCHRONOUSLY, THE MOMENT THE RECORD IS IN HAND and before
  // anything is awaited. That is what keeps the banner's dismissal exactly where
  // it was: setUndoMsg('') ran before the restore, not after it, so the banner
  // goes the instant undo is pressed rather than when storage comes back.
  const undoUnsave = useCallback(async (onTaken?: () => void): Promise<'none' | 'restored' | 'limit'> => {
    const w = undoRef.current;
    if (w === null) return 'none';
    const held = takeUndoRecord(w.flight.id);
    if (held === null) return 'none';
    onTaken?.();                          // acted on; the banner goes now
    return (await restoreUnsaved(held)) ? 'restored' : 'limit';
  }, [takeUndoRecord, restoreUnsaved]);

  // THE SAVE, AND BOTH BOOKMARKS ARE THIS.
  //
  // The card's and the route row's save paths were the same seven statements
  // twice, differing only in how they reported the three endings — a toast on
  // one, the error channel and a shake on the other. The statements are here and
  // the wording is theirs; see SaveOutcome.
  //
  // SAVING BACK INSIDE THE WINDOW IS AN UNDO, whichever control does it. The
  // banner may be long gone; the window is what decides, and it is keyed on
  // the id so only this exact flight is restored.
  //
  // SAVING IS THE SIGNAL THAT THE USER CARES ABOUT THIS FLIGHT, so reminders
  // follow from it rather than needing a second action. A refusal never blocks
  // the save and never asks twice: the flight is saved either way, and the
  // toast is where the difference is reported.
  const saveRecord = useCallback(async (record: SavedFlight): Promise<SaveOutcome> => {
    const held = takeUndoRecord(record.id);
    if (held !== null) {
      return (await restoreUnsaved(held)) ? { kind: 'restored' } : { kind: 'limit' };
    }
    const result = await saveFlight(email, record, f => !isArchived(f, Date.now()));
    setSavedFlights(result.flights);
    if (!result.ok) return { kind: 'limit' };
    registerWatch(API_BASE, record.flightNumber, record.flightDate);
    return { kind: 'saved', remind: await enableReminders(record) };
  }, [email, takeUndoRecord, restoreUnsaved, enableReminders]);

  // Sets or clears archivedAt, for the two swipe handlers that used to reach
  // into `email` and the store from inside a .map on a screen.
  const setArchived = useCallback(async (f: SavedFlight, on: boolean): Promise<void> => {
    setSavedFlights(await setFlightArchived(email, f.id, on ? Date.now() : null));
  }, [email]);

  // Sets or clears tripId. setArchived's shape exactly, on the same [email], and
  // for the same reason: one device-owned field, one store call, one setState.
  const setTrip = useCallback(async (f: SavedFlight, tripId: string | null): Promise<void> => {
    setSavedFlights(await setFlightTrip(email, f.id, tripId));
  }, [email]);

  // ── THE USER IS FLYING THIS ONE ───────────────────────────────────────────
  //
  // TWO PATHS AND ONE OUTCOME. A flight already on the watchlist is simply
  // claimed; one that is not is saved first, because a trip's leg has to be a
  // record before it can carry a tripId.
  //
  // tripId IS OPTIONAL AND ABSENT MEANS A NEW JOURNEY. Passing one is how a
  // second leg joins a trip that already exists; omitting it mints one. There is
  // no separate "start a trip" call, because starting a trip and owning its
  // first leg are the same act.
  //
  // countsToward () => false, AND THIS IS THE ONE THING THAT MUST NOT BE LEFT
  // OUT. MAX_SAVED_FLIGHTS is a limit on the WATCHLIST -- on how many flights
  // this app will refresh on the user's behalf -- and a flight the user is
  // actually FLYING is not a watchlist entry. Without this a full watchlist
  // would block ownership for a reason that has nothing to do with the journey,
  // and the block would land BEFORE the flight was owned, so no exemption
  // written downstream could ever fire: the record would not exist to be exempt.
  //
  // WHICH IS ALSO WHY THERE IS NO LIMIT CASE. saveFlight only refuses when
  // flights.filter(countsToward).length reaches the cap, and a predicate that is
  // false for every record makes that count zero. ok is true on both paths, so
  // the type says so rather than leaving a caller to handle an ending that
  // cannot happen.
  //
  // registerWatch ON THE SAVE PATH ONLY, exactly as saveRecord does it. A record
  // already on the watchlist was registered when it was saved, and registering
  // it again would be a second subscription to one flight.
  //
  // REMINDERS FOLLOW OWNERSHIP EXACTLY AS THEY FOLLOW A SAVE. Owning is a
  // stronger signal than saving -- the user is not watching this flight, they
  // are on it -- so it would be strange for the weaker signal to schedule
  // reminders and the stronger one not to. enableReminders is called on both
  // paths and its outcome is returned unwrapped, for the same reason saveRecord
  // returns it: the wording belongs to whichever screen asked.
  const ownFlight = useCallback(async (
    record: SavedFlight,
    tripId?: string,
  ): Promise<{ ok: true; remind: RemindOutcome }> => {
    const trip = tripId ?? newTripId();
    if (!savedFlights.some(f => f.id === record.id)) {
      // Never 'limit' -- see the note above. The list is set here as well as by
      // setTrip below, so the record is in state before anything reads it back.
      const result = await saveFlight(email, record, () => false);
      setSavedFlights(result.flights);
      registerWatch(API_BASE, record.flightNumber, record.flightDate);
    }
    await setTrip(record, trip);
    return { ok: true, remind: await enableReminders(record) };
  }, [email, savedFlights, setTrip, enableReminders]);

  // GIVES THE FLIGHT BACK TO THE WATCHLIST, and does NOT unsave it.
  //
  // Disowning says "I am not flying this after all", which is a smaller claim
  // than "I do not want to see this again" -- and the second is what unsaving
  // means and what the bookmark is for. Deleting here would make one control do
  // both and would take the record's reminders, its archive decision and its
  // history with it.
  //
  // The same shape as clearing archivedAt, which hands a flight back to the
  // arrival-time rule rather than pinning it out of the archive. Both return a
  // record to the default it had before a decision was made about it.
  const disownFlight = useCallback(async (f: SavedFlight): Promise<void> => {
    await setTrip(f, null);
  }, [setTrip]);

  // ONE FRESH RECORD, FOLDED IN. It does not fetch: the card's lookup and the
  // assistant's answer are the home screen's own calls and stay there, and this
  // is only the write they both ended in. touchSavedFlight no-ops when the id is
  // not in the store, so an unsaved flight costs nothing here.
  //
  // targetId names the record to update, for the one case that needs it: a
  // record filed under "unknown" whose refresh came back with a real date.
  const refreshOne = useCallback(async (record: SavedFlight, targetId?: string): Promise<void> => {
    const refreshed = await touchSavedFlight(email, record, targetId);
    if (refreshed) setSavedFlights(refreshed);
  }, [email]);

  // THE PULL. Everything it used to do except say so.
  //
  // onStarted FIRES SYNCHRONOUSLY, past the double-fire guard and above the
  // cooldown, which is precisely where the greeting reroll and the message clear
  // sat. Returning `ran` and letting the caller act on it afterwards would have
  // moved both to the far side of a network round trip.
  const refreshAll = useCallback(async (
    openCardId: string | null,
    onStarted?: () => void,
  ): Promise<RefreshReport> => {
    const nothing: RefreshReport =
      { ran: false, throttled: false, failures: 0, openCardFresh: null, list: null };
    if (refreshingRef.current) return nothing;                // synchronous guard; iOS can double-fire the pull
    onStarted?.();
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      // ITS OWN CLOCK READING, and the reason the derived lists stayed on the
      // screen. `now` is not on this context and must not be; the archive split
      // needs a time, and a pull happens on a tap rather than at render, so the
      // instant of the tap is the right one to read.
      const at = Date.now();
      // Active only. An archived flight is not refreshed, which is the whole
      // reason it does not count against MAX_SAVED_FLIGHTS.
      const activeSaved = savedFlights.filter(f => !isArchived(f, at));
      if (activeSaved.length === 0) return { ...nothing, ran: true };   // spinner alone acknowledges; message can't render here

      if (Date.now() - lastRefreshRef.current < PULL_COOLDOWN_MS) {
        return { ...nothing, ran: true, throttled: true };
      }
      lastRefreshRef.current = Date.now();

      // STALEST FIRST, and this is the refresh QUEUE's order only — a copy, so
      // activeSaved and everything the list renders from are untouched.
      //
      // The cap protects the quota and stays. But a cap on top of a FIXED order
      // is a cliff rather than a queue: activeSaved comes out of savedFlights in
      // stored order and is never sorted, so every pull walked the same first
      // five and the sixth and seventh were not refreshed later, they were never
      // refreshed at all. Two of seven sat at "updated 1d ago" indefinitely.
      //
      // Ordering by updatedAt ascending turns the same cap into a rotation: the
      // five refreshed here become the five freshest, so the next pull starts
      // with the ones this one could not reach and two pulls cover seven flights.
      // It also fixes the worst-looking rows first, because the stalest record is
      // exactly the one whose age is showing.
      const refreshQueue = [...activeSaved].sort((a, b) => a.updatedAt - b.updatedAt);
      const { failures, openCardFresh } = await refreshFlights(refreshQueue, 5, openCardId);

      const list = await getSavedFlights(email);              // read once, set state once
      setSavedFlights(list);

      // A refresh is the one moment a departure time can move under a reminder
      // that was scheduled from the old one, and the one moment a record filed
      // under "unknown" takes a real id. Both leave the schedule wrong, and
      // this is what puts it right.
      reconcile(list, undoKeepIds());

      return { ran: true, throttled: false, failures, openCardFresh, list };
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
    // savedFlights IS IN HERE AND HAS TO BE. This reads the list to derive the
    // active subset, so a dep array without it would close over the list as it
    // stood when the callback was formed and refresh a stale set — which is
    // exactly the kind of bug a stable-looking identity is not worth.
    //
    // SO THIS ONE RE-FORMS ON EVERY LIST WRITE, and that is correct rather than
    // a shortfall. It is stable across every render that does not change the
    // list, which is what the wrapping buys.
  }, [savedFlights, email, refreshFlights, undoKeepIds]);

  // ONE OBJECT PER CHANGE, not one per render. Every consumer of a context
  // re-renders whenever the value's IDENTITY changes, so an object literal here
  // would have handed the tab bar and every screen after it a new value on every
  // render of this provider — including the ones where nothing they read had
  // moved at all.
  //
  // THE ARRAY IS THE OBJECT'S OWN FIELDS, one for one, and deliberately not a
  // shorter list. Leaving one out to make the value look stable is the same
  // mistake as leaving a dependency out of a callback: it would hand consumers a
  // value whose fields disagree with the render it came from.
  const value = useMemo(() => ({
    savedFlights,
    email,
    setEmail,
    refreshing,
    saveRecord,
    handleUnsave,
    undoUnsave,
    refreshOne,
    refreshAll,
    handleRemind,
    setArchived,
    setTrip,
    ownFlight,
    disownFlight,
  }), [
    savedFlights, email, setEmail, refreshing,
    saveRecord, handleUnsave, undoUnsave, refreshOne, refreshAll,
    handleRemind, setArchived, setTrip, ownFlight, disownFlight,
  ]);

  return (
    <SavedContext.Provider value={value}>
      {children}
    </SavedContext.Provider>
  );
}
