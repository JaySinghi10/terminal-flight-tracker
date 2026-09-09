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
  setFlightLanding,
  // THE MERGE'S WRITE. See its note in storage: one read, one map, one write,
  // because a merge is one act on several records and setFlightTrip is one act
  // on one.
  setFlightsTrip,
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
// THE PENDING LEGS: flights the user has booked that the provider does not
// carry yet. Their own store beside this one, never inside it -- see the note
// at the top of lib/pendingRules.ts for why a pending leg is not a SavedFlight.
import {
  getPending, setPending, getRetryDay, setRetryDay, tryResolve, recordResolved,
} from './pending';
import {
  type PendingLeg, type PendingResolvedEvent, addToPending, retryBatch, dueToday,
  legDue, retryInterval, RETRY_INTERVALS_MS,
} from './pendingRules';
import {
  checkLanding,
  landedUtcToTs,
  landingDue,
  landingWindowClosed,
} from './landing';

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

// ── HOW MANY LANDING CHECKS ONE SWEEP WILL MAKE ─────────────────────────────
//
// A DIFFERENT BUDGET FROM EVERY CAP ABOVE IT, which is the only reason it is
// not the same number. Those protect AeroDataBox units, which are scarce. This
// spends Flightradar24 credits, and one flight's entire arrival window -- at
// most forty checks, five minutes apart -- costs at most eighty of the thirty
// thousand a month. Four at a time is a burst limit, not a budget limit:
// it stops a watchlist that all lands at once from firing twenty requests into
// the same second, and the next tick is sixty seconds away.
const LANDING_SWEEP_MAX = 4;

// ── HOW MANY FLIGHTS ONE PULL WILL PAY FOR ──────────────────────────────────
//
// TEN, AND IT WAS FIVE WRITTEN AS A BARE NUMBER AT THE CALL SITE. Half a full
// watchlist -- MAX_SAVED_FLIGHTS is 20 -- so any realistic list is covered in a
// single pull, and a full one still rotates through in two.
//
// WHAT IT COSTS: ONE UNIT PER FLIGHT ACTUALLY ATTEMPTED, so at most ten a pull
// and fewer whenever the list is shorter or a record is skipped as out of date.
// The spinner runs about 11.7s at a full ten, from REFRESH_SPACING_MS.
//
// NOT TWENTY. That doubles the worst case in both units and seconds for the
// tail of a list that refreshRank has already established is not urgent -- and
// the whole point of the ordering is that the cap no longer decides WHETHER the
// flight in the air is reached, only how far down the quiet end it goes.
const PULL_MAX_FLIGHTS = 10;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  AUTO-REFRESH IS OFF. FLIP THIS ONE CONSTANT TO TURN IT ON.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// WHAT FLIPPING IT DOES: saved flights start refreshing themselves in the
// background -- on launch, and on app-resume past AUTO_REFRESH_RESUME_COOLDOWN_MS
// -- at most AUTO_REFRESH_MAX_FLIGHTS per run, on the schedule refreshIntervalFor
// sets out. Nothing else changes. Pull-to-refresh is unaffected either way.
//
// WHAT IT COSTS: one API unit per flight per lookup. A saved flight days away is
// about ONE UNIT A DAY; the same flight over its final day and its time in the
// air is fifteen to twenty in total. Ten watched flights, mostly distant, is
// roughly ten units a day. See refreshIntervalFor for the tiers those come from.
//
// IT WAS A HUNDRED YEARS, WHICH IS THE SAME OFF WRITTEN AS A NUMBER. A constant
// called MIN_AGE set past any possible age is a disabled feature wearing the
// clothes of a tunable one -- and it cost eight hours of a landed flight showing
// DEPARTED before anybody noticed the schedule was not the reason.
const AUTO_REFRESH_ENABLED = false;
const AUTO_REFRESH_RESUME_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// The provider's BASIC plan caps requests at one per second and rejects the rest
// with HTTP 429, so consecutive saved-flight lookups are spaced past that ceiling.
const REFRESH_SPACING_MS = 1300;

// ── HOW LONG A RECORD IS STILL WORTH REFRESHING ─────────────────────────────
//
// TWENTY-FOUR HOURS PAST ARRIVAL, WHICH IS FOUR TIMES THE ARCHIVE WINDOW, and
// the gap between those two numbers is the bug it exists to close.
//
// THE REFRESH USED TO FILTER ON isArchived, which is six hours past arrival --
// and the trip screen shows a leg for as long as ANY leg of its journey is
// unarchived. So a leg that landed eight hours ago sat on screen, plainly
// visible, and was skipped by every refresh as too old to bother with. It showed
// DEPARTED while the provider had ARRIVED, an actual arrival time and a belt
// number, and no amount of pulling would have fixed it.
//
// A LEG STILL ON SCREEN SHOULD BE REFRESHABLE. That is the whole rule. Twenty-
// four hours covers everything that can still change after a landing -- the belt
// appears minutes later, an actual arrival time can land later still -- and stops
// well before the point where nothing about a flight will ever move again.
//
// AND IT STAYS INSIDE WHAT THE BACKEND WILL ANSWER. REFRESH_MAX_PAST_MS below
// refuses a record whose DATE is more than 36 hours old, because the provider
// rejects it; a flight that arrived 24 hours ago departed at most a few hours
// before that, so this window can never ask for something that would be refused.
//
// THE HAND STILL OVERRULES. archivedAt is checked first and separately: filing a
// flight away by hand means stop spending units on it, whatever the clock says.
const REFRESH_UNTIL_AFTER_ARRIVAL_MS = 24 * 60 * 60 * 1000;

// The backend accepts one day back (ROUTE_MAX_PAST_DAYS). A record older than
// that can only ever be refused, so it is never asked for. Kept slightly under
// two days so a local date one side of the server's UTC date still qualifies.
const REFRESH_MAX_PAST_MS = 36 * 60 * 60 * 1000;

// Relevance order: in the air, then upcoming, then finished. Unparseable times
// sink to the end of their own group rather than the end of the list.
// 'stale' RANKS WITH THE LIVE ONES. It is still today's flight and it is the
// record most in need of a look; sinking it under every landed leg would bury
// exactly the thing that wants attention.
const SAVED_RANK: Record<string, number> = { active: 0, stale: 0, scheduled: 1, delayed: 1 };
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

// ── WHAT OWNING A FLIGHT CAN BE ASKED TO DO DIFFERENTLY ─────────────────────
//
// Both fields default to the behaviour that existed before they did, so the
// flight card's own button is unaffected. Only the Gmail pull sets either. See
// ownFlight for why a bulk import wants both turned off.
export type OwnOptions = {
  // Enforce MAX_SAVED_FLIGHTS. Owning by hand does not; a pull does.
  capped?: boolean;
  // Turn reminders on for the flight, as owning by hand always has.
  remind?: boolean;
};

// remind IS null WHEN IT WAS NOT ASKED FOR, and that is not the same as a
// reminder that failed. OWN_MSG has an entry for every RemindOutcome and none
// for "not attempted", so a caller that suppressed reminders must not be handed
// something it would look up.
export type OwnOutcome =
  | { ok: true; remind: RemindOutcome | null }
  | { ok: false; kind: 'limit' };

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

// ── THE LOCAL DAY, AS A REAL ISO DAY ────────────────────────────────────────
//
// IT USED TO RETURN `${year}-${getMonth()}-${getDate()}`, WHICH IS NOT A DATE.
// getMonth is ZERO-BASED and neither part was padded, so today came back as
// "2026-8-9" rather than "2026-09-09".
//
// HARMLESS WHERE IT WAS ONLY COMPARED TO ITSELF -- the day-rollover tick and the
// daily retry stamp only ask whether the key CHANGED -- and silently
// catastrophic where it met a genuine ISO date. pendingRules compares a leg's
// `date` against this key with `<`, and comparing "2026-09-25" to "2026-8-9"
// stops at the first differing character: '0' is less than '8', so the leg
// reads as PAST.
//
// EVERY FUTURE DATE READ AS PAST, not merely some. With the month rendered as
// "8", any date written "09", "10", "11" or "12" loses that comparison. So
// addToPending refused every leg with 'past' and retryBatch deleted any leg
// that had somehow got in. The pending queue could not hold anything at all,
// which is why two legs of a real booking appeared in no list on any screen.
//
// PADDED AND ONE-BASED NOW. The stamp comparisons are unaffected because they
// only test equality; the stored retry stamp in the old format differs from the
// new one once, which costs one extra sweep and nothing else.
export function localDayKey(ts: number) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// The instant a flight arrived, or is expected to. Actual first, then the
// estimate, then the schedule — the same precedence the status line uses.
export function arrivalTs(f: SavedFlight): number | null {
  return zonedIsoToTs(f.to.actualIso ?? f.to.estimatedIso ?? f.to.scheduledIso, f.to.timezone);
}

// ── WHEN A LEG ACTUALLY ARRIVED, WHICH IS NOT WHEN WE NOTICED ───────────────
//
// landedAt IS AN OBSERVATION TIMESTAMP AND IT WAS RUNNING THE BAG WINDOW. It is
// written on the device clock at the moment a refresh first comes back saying
// "landed", so it dates OUR KNOWLEDGE rather than the flight. LH455 touched down
// at 10:14 and was not refreshed until 11:02, so landedAt read 34 minutes when
// the aircraft had been down for 82 -- and the forty-five minute window it feeds
// started 48 minutes late. Every passenger-facing thing measured from it was
// wrong by however long the app took to look.
//
// THE ARRIVAL IS THE FLIGHT'S OWN CLOCK, so it is preferred wherever there is
// one, and landedAt survives only as the fallback for a record that has landed
// without the provider publishing an actual time.
//
// AND A FUTURE "ACTUAL" IS REFUSED, which is not a hypothetical. The provider
// carries revisedTime as an estimate before a movement and an actual after it,
// disambiguated only by a status that can be wrong -- EK502 was observed
// reporting status Arrived with an actual arrival FIVE HOURS IN THE FUTURE while
// still on the ground in Dubai. Accepting that would start a bag window before
// the flight had taken off. Past-or-now, or it is not an arrival.
// AND NOW THERE ARE THREE SOURCES, USED FOR WHAT EACH IS GOOD AT.
//
// FLIGHTRADAR24 DECIDES WHETHER AND WHEN -- but what it knows is TOUCHDOWN,
// because it tracks the aircraft. AERODATABOX REPORTS THE GATE, which is the
// moment this function is actually asked about: the bag window, the layover
// rule and every "landed at" on a card mean the door, not the runway.
//
// SO ONCE FR24 HAS CONFIRMED A LANDING, AeroDataBox's gate time is PREFERRED
// over an estimate derived from the touchdown -- a measurement beats a guess --
// but only where the two agree that they are describing one arrival. See
// TAXI_TO_GATE_MAX_MS.
//
// AND WHERE THERE IS NO GATE TIME, which is the Bombay failure exactly, the
// touchdown plus a named taxi estimate is the best available and says so.
export function landedInstant(f: SavedFlight, now: number): number | null {
  const gate = zonedIsoToTs(f.to.actualIso, f.to.timezone);
  const touchdown = landedUtcToTs(f.landedUtc);

  if (touchdown !== null && touchdown <= now) {
    if (gate !== null && gate <= now
      && gate >= touchdown && gate - touchdown <= TAXI_TO_GATE_MAX_MS) {
      return gate;
    }
    return touchdown + TAXI_TO_GATE_MS;
  }

  // NO FR24 ANSWER. Unchanged from before this existed, including the refusal
  // of a future "actual" -- EK502 reported one FIVE HOURS AHEAD while still on
  // the ground in Dubai, and accepting it would start a bag window for a flight
  // that had not taken off.
  if (gate !== null && gate <= now) return gate;

  // ── AND landedAt IS NOT EVIDENCE ON A FLIGHT THAT HAS NOT ARRIVED ─────────
  //
  // A PAST-OR-NOW TEST ON landedAt WOULD BE A NO-OP, which is why the guard is
  // not written that way. landedAt is stamped with Date.now() the moment a
  // refresh first reports a landing, so it is ALWAYS in the past. It is not
  // wrong about WHEN; it is wrong about WHETHER.
  //
  // MEASURED: a leg with landedAt 05:44Z whose arrival is 11:53Z -- six hours
  // in the future. AeroDataBox had reported a landing that had not happened,
  // touchSavedFlight stamped it, and nothing since had cleared it. This
  // function then handed that instant to whereAmI, which opened a layover six
  // hours before the aircraft was due, and the Deck measured a connection from
  // it. effectiveStatus was refusing the same claim at the same moment -- two
  // places answering one question and disagreeing.
  //
  // SO THE TEST IS AGAINST THE RECORD'S OWN ARRIVAL. If the flight says it
  // arrives later than now, it has not arrived, whatever we once observed.
  const arr = arrivalTs(f);
  if (arr !== null && arr > now) return null;
  return f.landedAt;
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
// THE CLOCK MAY DEMOTE A STATUS, NEVER PROMOTE IT. A SECOND SOURCE MAY PROMOTE.
//
// THAT SECOND CLAUSE IS NEW AND IT WEAKENS A RULE THIS FUNCTION USED TO STATE
// ABSOLUTELY, so here is why, rather than an exception bolted onto the old
// text.
//
// THE OLD RULE WAS ABOUT THE CLOCK, AND IT WAS RIGHT ABOUT THE CLOCK. A time
// passing does not prove an event happened: a flight can sit an hour past its
// scheduled departure still at the gate, and a scheduled arrival can come and go
// while the aircraft is holding. Promoting on the clock would invent departures
// and landings that never occurred -- the same failure this function exists to
// correct, pointed the other way. Nothing below promotes on the clock, and
// nothing ever should.
//
// BUT THE RULE WAS ALSO DOING A SECOND JOB IT WAS NEVER STATED TO DO. When
// AeroDataBox was the only source, "never promote" also meant "never contradict
// the provider upwards", because there was nothing to contradict it WITH. That
// was not a principle, it was the shape of having one source -- and that source
// lost the arrival on three flights out of three at Indian airports: 3h24m
// late, five hours EARLY with a timestamp in the future, and one that sat on
// "Approaching" for three and a half hours after touchdown.
//
// A MEASUREMENT IS NOT A CLOCK. Flightradar24 watching an aircraft transmit
// from the ground is evidence of an event, not the passage of time, and it is
// the kind of thing the old rule was protecting the record FROM the absence of.
// So landedUtc promotes, and only landedUtc: it is the single field on this
// record written by a source that observes the aircraft rather than reporting
// what an airline filed.
//
// AND AERODATABOX MAY STILL LAND A FLIGHT, in one narrow case -- see
// aeroDataBoxMayLand. Frankfurt timed LH909 to the minute, touchdown and gate
// both, within thirteen minutes; throwing that away wherever FR24 happens to
// have nothing would cost a working card for no gain.
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
// ── WHEN AERODATABOX IS STILL ALLOWED TO SAY A FLIGHT LANDED ────────────────
//
// FR24 IS THE AUTHORITY, so while it has an opinion -- or while we are still
// going to ask it for one -- AeroDataBox does not get to declare an arrival.
// That is what stops EK502's "Arrived, five hours early" from ever reaching a
// card again.
//
// THE EXEMPTION: a clean "does not know". FR24 asked, answered, has no landing.
// There is no opinion to defer to, and AeroDataBox's own arrival is the best
// thing left -- at Frankfurt it was right to the minute.
//
// AND THE SECOND EXEMPTION, WHICH IS BROADER THAN THE FIRST AND DELIBERATE:
// once the check window has closed, no further check is coming, whatever the
// last outcome was. Without this a record whose checks all ERRORED -- or one
// that was never checked at all, which is every flight saved before this
// shipped and every flight whose arrival passed while the app was closed --
// would refuse a landing FOR EVER on the strength of an answer that will never
// arrive. That is the stuck card this whole exemption exists to prevent, and it
// would arrive through the back door.
//
// SO INSIDE THE WINDOW THE RULE IS STRICT: 'pending' and 'error' both refuse,
// and an unreachable provider never silently restores the old behaviour.
// OUTSIDE IT, AeroDataBox stands.
function aeroDataBoxMayLand(f: SavedFlight, now: number): boolean {
  if (f.landingCheck === 'unknown') return true;
  return landingWindowClosed(arrivalTs(f), now);
}

export function effectiveStatus(f: SavedFlight, now: number): string {
  // ── THE ONE PROMOTION, AND IT COMES FIRST ──
  //
  // A CONFIRMED TOUCHDOWN OUTRANKS EVERY STORED WORD, including a stored
  // 'active' from a provider still insisting the flight is approaching. The
  // past-or-now test is the same one landedInstant applies and for the same
  // reason: a landing in the future is not a landing.
  const touchdown = landedUtcToTs(f.landedUtc);
  if (touchdown !== null && touchdown <= now) return 'landed';

  let s = f.status.toLowerCase();

  // A STORED 'landed' AERODATABOX IS NO LONGER ENTITLED TO. Demoted to
  // 'active', which is what FR24 is actually saying when it answers 'pending',
  // and which the rules below then treat exactly as they treat any other
  // flight in the air.
  if (s === 'landed' && !aeroDataBoxMayLand(f, now)) s = 'active';

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
    // ── AND THE OTHER END OF THE SAME QUESTION ──
    //
    // THE MIRROR OF THE 'landed' RULE ABOVE. That one refuses a landing which
    // has not happened yet; this refuses a flight still "in the air" long after
    // it should have been down. One principle: a status the clock contradicts is
    // not a status.
    //
    // to.actualIso ABSENT IS THE SECOND HALF AND IT IS NOT OPTIONAL. If the
    // provider ever does report an actual arrival then the flight landed and the
    // ordinary path has it. This fires only where the arrival never came at all.
    const arr = arrivalTs(f);
    if (arr !== null && f.to.actualIso == null && now - arr > STALE_AFTER_ARRIVAL_MS) {
      return 'stale';
    }
  }
  return s;
}

// WHETHER THIS RECORD IS STILL WORTH SPENDING A UNIT ON. Not the same question
// as isArchived, and the two were conflated until a landed leg sat eight hours
// stale on a screen that was showing it. See REFRESH_UNTIL_AFTER_ARRIVAL_MS.
//
// A RECORD WITH NO READABLE ARRIVAL IS REFRESHABLE. That is a pre-v3 record or
// one with no timezone, and it is exactly the record a refresh would REPAIR --
// refusing to fetch it would leave it broken for ever.
function refreshable(f: SavedFlight, now: number): boolean {
  if (f.archivedAt !== null) return false;
  const ts = arrivalTs(f);
  return ts === null || now - ts <= REFRESH_UNTIL_AFTER_ARRIVAL_MS;
}

// ── HOW OFTEN ONE FLIGHT IS WORTH ASKING ABOUT ──────────────────────────────
//
// PROXIMITY, NOT ONE INTERVAL. A flight next Tuesday changes when the airline
// republishes a timetable; a flight boarding in an hour changes when a gate is
// assigned; a flight in the air changes continuously. One number for all three
// either wastes units on the first or is useless for the third.
//
//   in the air              30m     ~2 units an hour, for a few hours
//   landed, inside 24h       1h     the belt and the actual arrival still land
//   under 6h to departure    1h     gate, terminal, delay -- the actionable window
//   6h to 48h                6h     4 a day
//   beyond 48h              24h     1 a day
//   past the window        never    see refreshable
//
// A TYPICAL FLIGHT COSTS ABOUT ONE UNIT A DAY while it is distant and fifteen to
// twenty across its last day and its flight. Ten saved flights mostly days out is
// around ten a day.
//
// AIRBORNE IS TESTED FIRST AND BY effectiveStatus, not by the clock. A flight
// running late is still 'active' past its scheduled arrival, and that is when it
// is most worth asking about -- ordering this test after the arrival check would
// drop it to hourly at exactly the wrong moment.
//
// null MEANS NEVER, which is the only value that stops a record being asked
// about at all. Every other branch returns a duration.
function refreshIntervalFor(f: SavedFlight, now: number): number | null {
  if (!refreshable(f, now)) return null;
  const eff = effectiveStatus(f, now);
  // A FLIGHT THE PROVIDER HAS LOST IS STILL WORTH ASKING ABOUT, BUT NOT EVERY
  // HALF HOUR. They do catch up -- an arrival often lands in their data hours
  // late -- so it stays on the list; at the active tier it would spend about
  // forty-eight units across a day on a record nothing is changing.
  if (eff === 'stale') return 60 * 60 * 1000;
  if (eff === 'active') return 30 * 60 * 1000;
  const arr = arrivalTs(f);
  if (arr !== null && now > arr) return 60 * 60 * 1000;
  const dep = departureTs(f);
  // NO READABLE DEPARTURE FALLS TO THE MIDDLE TIER rather than to either end.
  // Hourly would spend units on a record we cannot place; daily would leave a
  // repairable record broken for a day.
  if (dep === null) return 6 * 60 * 60 * 1000;
  const until = dep - now;
  if (until < 6 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (until < 48 * 60 * 60 * 1000) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

// ── WHICH RECORD GETS THE UNIT WHEN THERE ARE MORE FLIGHTS THAN ATTEMPTS ────
//
// A CAP ON TOP OF A PURELY STALE-FIRST ORDER SPENT THE PULL ON THE WRONG
// FLIGHTS, and the log said so exactly: LH455 was IN THE AIR at q8 of a queue
// capped at five, while two of the five units went to flights three weeks out.
//
// AND SWIPING THE CARD MADE IT WORSE, WHICH IS WHY IT LOOKED LIKE A PER-CARD
// SUCCESS AND A BULK FAILURE. A single-card refresh advances updatedAt, so the
// leg being watched became the FRESHEST record in the store and sorted to the
// very back of the queue that gets truncated. The workaround was the cause.
//
// THREE RANKS, AND THEY ARE refreshIntervalFor's OWN TIERS. That function
// already decides what is worth asking about how often; disagreeing with it here
// would mean two different opinions in one file about which flight is volatile.
//
//   0  in the air        changing continuously, and the one thing a pull is for
//   1  under 6h to go    the gate, the terminal and the delay land in this window
//   2  everything else   distant, or landed, and neither moves in a minute
//
// STALENESS STILL ORDERS WITHIN A RANK, so the rotation the old sort was built
// for survives intact at the quiet end: the records this pull could not reach
// are the ones the next pull starts with.
//
// AIRBORNE IS TESTED TWICE, BY STATUS AND BY THE CLOCK. effectiveStatus is the
// record's own word for it, and a record whose word is STALE -- still saying
// scheduled or departed while its departure has passed and its arrival has not
// -- is precisely the record this whole exercise was about. Trusting the status
// alone would rank the broken record last and leave it broken.
const REFRESH_SOON_MS = 6 * 60 * 60 * 1000;

function refreshRank(f: SavedFlight, now: number): number {
  const eff = effectiveStatus(f, now);
  // A LOST FLIGHT IS THE ONE A PULL MOST WANTS TO REPAIR, so it queues with the
  // airborne rather than in the tail -- its own tier already keeps the automatic
  // polling down; this is about which records a hand-pulled refresh reaches.
  if (eff === 'active' || eff === 'stale') return 0;
  const dep = departureTs(f);
  // NO READABLE DEPARTURE IS NOT URGENT, only repairable. It goes to the tail
  // with the distant ones, where staleness will bring it round soon enough.
  if (dep === null) return 2;
  if (dep <= now) {
    const arr = arrivalTs(f);
    return arr === null || arr > now ? 0 : 2;               // airborne by the clock, or landed
  }
  return dep - now < REFRESH_SOON_MS ? 1 : 2;
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

// ── HOW LONG A BELT IS WORTH SHOWING ────────────────────────────────────────
//
// FORTY-FIVE MINUTES FROM TOUCHDOWN. The belt is the one fact on a finished leg
// that is still actionable, and it stops being actionable once the bags are off
// it and in a hand.
//
// IT LIVES HERE BECAUSE IT HAS TWO READERS AND THEY MUST NOT DRIFT. app/flights
// uses it for the belt on a COLLAPSED leg and for how long focus stays on a leg
// that has just landed; components/FlightCard uses it for whether the open card
// shows its belt or its arrival. A screen cannot be imported by a component, so
// the shared rules file is the only place both can read -- which is the same
// argument that put effectiveStatus and bagEligible's siblings here.
//
// IT WAS SIXTY, IN app/flights, AND ONLY THE COLLAPSED ROWS READ IT. Moving it
// shortens that window by a quarter of an hour, which is a real change to an
// existing surface and was made deliberately rather than inherited: one number
// meaning "the bags are still worth showing" is worth more than two that agree
// today and will not later.
export const BAG_WINDOW_MS = 45 * 60 * 1000;

// ── FROM WHEELS DOWN TO THE DOOR OPENING ────────────────────────────────────
//
// AN ESTIMATE, NOT A MEASUREMENT -- tune it once real journeys have been
// watched, exactly as STALE_AFTER_ARRIVAL_MS below is waiting to be tuned.
//
// WHY IT HAS TO EXIST AT ALL. Flightradar24 reports TOUCHDOWN. It tracks the
// aircraft, so that is the only arrival it can know. AeroDataBox reports the
// GATE. Those are different moments and the bag window belongs to the second
// one: bags do not start moving when the wheels touch, they start when the
// aircraft is on stand. Feeding a touchdown into a window meant for a gate
// arrival starts it early by the length of the taxi -- which is the SAME class
// of bug as the landedAt one this window already had, where the clock was
// started by when the app noticed rather than by when the flight arrived.
//
// TEN MINUTES, AND FRANKFURT MEASURED SEVEN. LH909 touched down at 18:07 and
// was at its gate at 18:14. That is one taxi at one airport; Mumbai and
// Bengaluru will differ, and a long taxi at a big field is longer still. Ten is
// a deliberate round number sitting slightly above the one real observation.
export const TAXI_TO_GATE_MS = 10 * 60 * 1000;

// AND THE BOUND ON BELIEVING THE TWO ARE THE SAME ARRIVAL.
//
// landedInstant prefers AeroDataBox's gate time over the estimate above
// whenever it has one -- a measurement beats a guess. But only when the two
// sources are describing the same event: a gate time BEFORE the touchdown, or
// an hour after it, is not a taxi, it is two records that do not agree, and the
// estimate is the safer of the two. An hour is generous on purpose; the point
// is to exclude nonsense, not to police long taxis.
export const TAXI_TO_GATE_MAX_MS = 60 * 60 * 1000;

// ── WHEN A FLIGHT STOPS BEING LIVE AND STARTS BEING LOST ────────────────────
//
// SIXTY MINUTES PAST ITS OWN ARRIVAL ESTIMATE, WITH NO ARRIVAL REPORTED. AN
// ESTIMATE, NOT A MEASUREMENT -- tune it once real journeys have been watched.
//
// WHAT IT IS FOR: 6E5071 BOM-BLR was fetched FRESH -- data_age_seconds 0 -- and
// the PROVIDER said "Approaching", live_feed true, arrival estimated 17:13, no
// actual. It was 20:43. The card pulsed green and said LANDING for a flight that
// had come down three and a half hours earlier. Nothing about our copy was old;
// the CLAIM was.
//
// A FLIGHT PAST ITS ARRIVAL WITH NO ARRIVAL REPORTED IS ONE WE HAVE LOST TRACK
// OF, NOT ONE THAT LANDED. Mapping it to 'landed' would invent an arrival time,
// print it as a fact, and start a bag window for a flight nobody has confirmed
// is down. 'stale' says the true thing: we do not know.
//
// AN HOUR IS DELIBERATELY GENEROUS. A flight really can run past its estimate --
// a hold, a diversion, a long taxi -- and this must not fire on one that is
// genuinely still in the air. What it catches is an estimate that expired and
// then never moved.
export const STALE_AFTER_ARRIVAL_MS = 60 * 60 * 1000;

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

// ── WHICH LEG OF A TRIP THE TRAVELLER IS ACTUALLY ON ───────────────────────
//
// IT LIVED IN app/flights.tsx UNTIL A SECOND SCREEN NEEDED IT. The Deck asks the
// same question for a different reason -- not "which card opens" but "which
// airport is this person standing in" -- and the answer must not be computed
// twice. This file's own header says why it is here: a screen must never be the
// place another screen imports from.
//
// UNDER A DAY THE FIRST LEG IS THE THING YOU ARE DOING. That is the window in
// which a trip stops being a plan and becomes a journey: bags get packed, a taxi
// gets booked, the gate gets assigned. Opening the card earlier would put a
// full-height surface on the screen for a flight there is nothing to do about.
export const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── AND HOW LONG PAST ITS DEPARTURE A LEG CAN STILL BE THE CURRENT ONE ──────
//
// THE LOWER BOUND CURRENT_WINDOW_MS NEVER HAD. Its test is `t - now < WINDOW`,
// and for a departure in the past that difference is NEGATIVE -- so every past
// departure passed it, one from last week as readily as one from this morning.
// The branch was written to mean "leg one leaves soon"; it also meant "leg one
// left at some point", and a trip whose landing was never recorded opened its
// first leg for ever with no way out.
//
// TWENTY-FOUR HOURS, because the longest scheduled flight in the world is about
// nineteen. A leg whose departure is more than a day behind us with no landing
// recorded is a stale record rather than a flight still in progress, and the
// honest answer for it is that no leg is current.
export const STALE_AFTER_DEPARTURE_MS = 24 * 60 * 60 * 1000;
// WHICH LEG OPENS, BY THE JOURNEY'S OWN RECKONING, or -1 for none.
//
// TWO RULES, AND THE FIRST ONE WINS. A leg whose PREVIOUS leg has landed is the
// one the traveller has arrived for, whatever the clock says -- that is the
// handover from one flight to the next and it is a fact rather than a threshold.
// Only when no such leg exists does the window apply, and it applies to the
// FIRST leg alone: a middle leg does not open early just because its departure
// is near, because the leg before it has not put the traveller there yet.
//
// -1 IS A REAL ANSWER. A trip five days out has no open card at all, and neither
// does one whose every leg has landed. Both are correct: there is nothing to be
// at an airport for, and a screen that always opens something would be opening
// it for the sake of the layout.
// ── AND THE HANDOVER WAITS FOR THE BAGS ───────────────────────────────────
//
// A LEG THAT HAS JUST LANDED KEEPS FOCUS FOR BAG_WINDOW_MS BEFORE THE NEXT ONE
// TAKES IT. Without that clause the moment leg one touched down, focus moved to
// leg two -- and the open card's landed layout, which exists to put a carousel
// number in front of somebody who has just walked off an aircraft, was a state
// almost nothing could reach. It rendered only if the user went back and tapped
// the leg they had just flown.
//
// THE LAST LEG IS THE CASE THE LOOP CANNOT SEE, and it needs its own clause. The
// loop looks for an UNLANDED leg whose predecessor has landed; when the final leg
// lands there is no such leg, so a finished journey opened nothing at exactly the
// moment its bags were coming out. It now holds that leg for the same window and
// closes afterwards, which is the -1 a completed trip should settle to.
//
// IT IS THE CLOCK, NOT THE BELT. This asks only how long ago the aircraft landed;
// whether there is a carousel number yet, and whether the bags are even claimed
// at this airport, are the card's and bagEligible's questions. Holding focus on a
// through-checked leg for forty-five minutes costs one card being open; deciding
// it here would mean this function taking a trip-position rule it does not have.
export function currentLegIndex(legs: SavedFlight[], now: number): number {
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].landedAt === null && legs[i - 1].landedAt !== null) {
      // WHETHER IT HAS LANDED IS STILL landedAt; WHEN IT LANDED IS NOT.
      // landedAt dates the refresh that noticed, so it ran this window late by
      // however long the app took to look -- 48 minutes, measured. The flag and
      // the instant are deliberately different reads: see landedInstant, which
      // also refuses a "actual" arrival in the future.
      // NO CAST. landedInstant CAN NOW RETURN null even where landedAt is set:
      // it refuses to speak for a leg whose own arrival is still in the future,
      // which is exactly the record that caused the Deck to open a layover six
      // hours early. `now - null` would coerce to a very large number and
      // happen to give the right answer here -- the bag window would not open
      // -- but a cast that asserts something untrue is how the NEXT reader gets
      // it wrong.
      const landed = landedInstant(legs[i - 1], now);
      if (landed === null) return i;
      return now - landed < BAG_WINDOW_MS ? i - 1 : i;
    }
  }
  // EVERY LEG HAS FLOWN, OR THERE IS ONLY ONE AND IT HAS. The loop starts at 1
  // and needs an unlanded leg, so neither case reaches it.
  const last = legs.length - 1;
  const lastLanded = last >= 0 ? landedInstant(legs[last], now) : null;
  if (last >= 0 && legs[last].landedAt !== null
    && lastLanded !== null && now - lastLanded < BAG_WINDOW_MS) return last;
  if (legs.length > 0 && legs[0].landedAt === null) {
    const t = departureTs(legs[0]);
    // BOUNDED AT BOTH ENDS NOW. See STALE_AFTER_DEPARTURE_MS: the upper test
    // alone accepted every departure that has ever happened.
    if (t !== null && t - now < CURRENT_WINDOW_MS && now - t < STALE_AFTER_DEPARTURE_MS) return 0;
  }
  return -1;
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

// ── WHEN TWO FLIGHTS ARE ONE JOURNEY ────────────────────────────────────────
//
// THREE CONDITIONS AND NOTHING ELSE, and all three must hold. The arrival
// airport of the earlier leg is the departure airport of the later one; the
// later one leaves AFTER the earlier one lands; and the wait between them is
// under a day. Any failure and the two flights stay separate -- there is no
// prompt, no partial match and nothing to confirm, because a rule that asks is a
// rule that has not decided.
//
// AIRPORT IDENTITY, NOT TERMINAL. Changing terminal at one airport is still a
// connection -- it is most of what a connection IS -- and a different airport in
// the same city is not one, however short the taxi. LHR to LGW is a journey the
// traveller makes on the ground and this app knows nothing about it.
const MAX_CONNECTION_MS = 24 * 60 * 60 * 1000;

// ── AN AIRPORT CODE, OR NOTHING, AND THE EMPTY STRING IS NOTHING ────────────
//
// THIS IS THE ONE THAT WOULD HAVE BITTEN. endpointFromApi writes `iata: raw?.iata
// ?? ''` -- an ABSENT code becomes the empty string, not null -- and isValid only
// checks that the field is a string, so '' passes validation and reaches storage.
// A bare `earlier.to.iata === later.from.iata` is therefore TRUE for two records
// that both lack a code, and would link two flights at an airport that does not
// exist.
//
// SO EMPTINESS IS TESTED BEFORE EQUALITY, and null is the answer. A null can then
// never equal a real code, which makes the comparison below fail closed by
// construction rather than by a guard somebody has to remember.
//
// TRIMMED AND UPPERCASED. The provider sends uppercase and savedFlightFromApi
// normalises the flight NUMBER but not this field, so the normalisation happens
// here -- the same one makeFlightId already applies to a number. This app reads
// '' as absent in two other places already: flightUrl's `f.from.iata || null` at
// both of its call sites.
function hubOf(code: string): string | null {
  const c = code.trim().toUpperCase();
  return c === '' ? null : c;
}

// THE WAIT BETWEEN TWO LEGS IF THEY CONNECT, or null if they do not.
//
// A DURATION RATHER THAN A BOOLEAN, because the caller needs the number: when a
// flight could join more than one trip on the same side, the shortest gap is
// what decides. Returning true and asking again for the figure would be the test
// run twice.
//
// arrivalTs AND departureTs DIRECTLY, AND NEVER THROUGH NO_TIME. Both already
// resolve actual, then estimate, then schedule against the airport's own zone --
// which is the only way a gap across two zones is right -- and both return null
// when there is no ISO or no timezone. NO_TIME is a SORT sentinel that callers
// substitute for that null -- legsOfTrip and savedSortKey both do it -- and it is
// Number.MAX_SAFE_INTEGER: fed into this subtraction it would produce an enormous
// positive gap on one side and a plausible small one on the other. A null here is
// a record whose times cannot be read, and that is not evidence of a connection.
//
// STRICTLY POSITIVE. A later leg that departs at the exact millisecond the
// earlier one lands is a stored artefact rather than a connection. This is one
// millisecond stricter than Layover's own `dep >= arr`, which renders a gap it is
// given; this decides whether there is one.
function connectionGap(earlier: SavedFlight, later: SavedFlight): number | null {
  const hub = hubOf(earlier.to.iata);
  if (hub === null || hub !== hubOf(later.from.iata)) return null;
  // ── A DIFFERING REFERENCE NO LONGER BLOCKS A JOIN ────────────────────────
  //
  // IT DID, AND THE ASSUMPTION UNDER IT WAS WRONG. The rule read "every leg of
  // one booking is printed on one confirmation under one reference, so a
  // genuine connection agrees here by construction". A real three-leg journey
  // disproved it: SFO to Copenhagen to Mumbai under CS7B02, then Mumbai to
  // Indore under CRU5GE. One journey, two references, and the last leg was cut
  // off from the first two.
  //
  // SO THE AIRPORT AND THE CLOCK DECIDE AGAIN, as they always did. The
  // reference stays a POSITIVE signal wherever it is already used -- it is what
  // tripForBooking reaches for first -- and is a blocker nowhere.
  //
  // THE COST IS KNOWN AND ACCEPTED. This is the test that once joined an
  // unrelated Mumbai to London flight to somebody's booking because it departed
  // Mumbai inside a day of their arrival. That coincidence can happen again.
  // Splitting a real journey is the worse failure of the two: a wrong join is
  // visible and can be undone, where a missing leg is neither.
  const arr = arrivalTs(earlier);
  const dep = departureTs(later);
  if (arr === null || dep === null) return null;
  const gap = dep - arr;
  return gap > 0 && gap < MAX_CONNECTION_MS ? gap : null;
}

// WHEN A TRIP BEGAN, for deciding which id survives a merge. NO_TIME for a trip
// whose legs carry no readable departure at all, so it LOSES rather than winning
// by accident -- the same reading legsOfTrip gives that sentinel.
function tripStart(list: SavedFlight[], tripId: string): number {
  let earliest = NO_TIME;
  for (const f of list) {
    if (f.tripId !== tripId) continue;
    const t = departureTs(f);
    if (t !== null && t < earliest) earliest = t;
  }
  return earliest;
}

// WHICH TRIP A NEWLY OWNED FLIGHT JOINS, AND WHAT HAS TO MOVE FOR IT TO.
//
// `absorb` IS THE MERGE. It is empty in the ordinary case and holds the ids of
// every leg of a trip being folded into another when the new flight BRIDGES two.
export type TripJoin = { tripId: string; absorb: string[] };

// A TRIP WHOSE LEGS HAVE ALL BEEN ARCHIVED IS NOT A CANDIDATE, and this is the
// fourth condition -- added knowingly, on top of the three at MAX_CONNECTION_MS.
// The other three are facts about two flights; this is a fact about the journey
// one of them is already part of. A landed leg and a departure eight hours later
// satisfy all three -- same airport, positive gap, under a day -- so without this
// a new flight would drag a finished journey back onto the rail as though the
// traveller were still on it.
//
// THE FILTER IS ON CANDIDACY, NOT ON MEMBERSHIP. An archived leg cannot ATTRACT a
// new flight; but once a merge is decided, every leg of the absorbed trip moves,
// archived ones included -- see the absorb list below. Leaving them behind under
// a dead id would split the journey rather than join it.
function detectTrip(
  list: SavedFlight[],
  record: SavedFlight,
  now: number,
): TripJoin | null {
  const owned = list.filter(f =>
    f.id !== record.id && f.tripId !== null && !isArchived(f, now));

  // ── THE BEST TRIP ON ONE SIDE OF THE NEW FLIGHT ──
  //
  // `before` ASKS WHICH TRIP THE FLIGHT FOLLOWS and `after` which it precedes,
  // and BOTH ARE ALWAYS ASKED. A flight saved out of order -- leg 3 before leg 2
  // -- connects backwards rather than forwards, and a test that only looked
  // forwards would leave it unlinked for ever after.
  //
  // AT MOST ONE TRIP PER SIDE, because at most one can be true. Two different
  // trips arriving at the same airport before this flight leaves cannot both be
  // the journey it continues: the traveller took one aircraft into that airport.
  //
  // THE SHORTEST GAP WINS. It is the only tie-break that is a fact about the
  // CONNECTION rather than about the order records happened to be saved in, so
  // the same set of flights groups the same way however it was entered -- and a
  // two-hour wait is a likelier itinerary than a twenty-two-hour one when both
  // are on the table.
  //
  // AND THE ID BREAKS AN EXACT TIE, lexicographically. Two gaps equal to the
  // millisecond is not a case that happens; a rule that leaves it undecided is
  // still a rule that can group one list two ways. newTripId embeds Date.now(),
  // so lexicographic order is age order -- the established journey wins.
  const bestOn = (follows: boolean): string | null => {
    const best = new Map<string, number>();
    for (const f of owned) {
      const gap = follows ? connectionGap(f, record) : connectionGap(record, f);
      if (gap === null) continue;
      const id = f.tripId as string;
      const prev = best.get(id);
      if (prev === undefined || gap < prev) best.set(id, gap);
    }
    let win: string | null = null;
    let winGap = 0;
    best.forEach((gap, id) => {
      if (win === null || gap < winGap || (gap === winGap && id < win)) {
        win = id;
        winGap = gap;
      }
    });
    return win;
  };

  const before = bestOn(true);
  const after = bestOn(false);

  if (before === null && after === null) return null;
  if (before === null) return { tripId: after as string, absorb: [] };
  if (after === null) return { tripId: before, absorb: [] };
  // ONE TRIP ON BOTH SIDES IS NOT A BRIDGE. A return leg rejoining the journey it
  // left -- out on Monday, back on Friday -- connects to that trip at each end
  // and is already part of it. There is nothing to merge.
  if (before === after) return { tripId: before, absorb: [] };

  // ── THE BRIDGE, WHICH IS THE CASE A SINGLE tripId CANNOT EXPRESS ──
  //
  // The new flight follows one journey and precedes another, so all three are one
  // journey -- and writing one id onto this record would join one of them and
  // orphan the other. This is what `absorb` is for and the only thing it is for.
  //
  // IT ARISES FROM SAVING OUT OF ORDER, which is the ordinary way it happens: leg
  // 1 is owned, then leg 3 starts a trip of its own because nothing connected it,
  // then leg 2 arrives and turns out to be the missing middle.
  //
  // THE SURVIVING ID IS THE TRIP THAT STARTED FIRST. A tripId NAMES a journey and
  // a journey begins with its first leg, so the earlier journey absorbs the later
  // one rather than the other way round. Independent of save order, which is what
  // makes it stable. An exact tie falls to the id, as everywhere else here.
  const keepFirst = (() => {
    const a = tripStart(list, before);
    const b = tripStart(list, after);
    if (a !== b) return a < b;
    return before < after;
  })();
  const keep = keepFirst ? before : after;
  const gone = keepFirst ? after : before;
  return {
    tripId: keep,
    // EVERY LEG OF THE ABSORBED TRIP, archived ones included. See the note at the
    // candidacy filter: being unable to attract a new flight is not the same as
    // being left behind when the journey you belong to is renamed.
    absorb: list.filter(f => f.tripId === gone).map(f => f.id),
  };
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
//
// `cooldownMs` IS WHAT THE SCREEN NEEDS TO SAY WHY. throttled was computed and
// thrown away -- one caller ignored the report entirely and the other could only
// say "already up to date", which is a statement about the DATA when the truth
// is a statement about the CLOCK. This is the milliseconds left on the cooldown,
// and it is 0 on every other outcome.
export type RefreshReport = {
  ran: boolean;
  throttled: boolean;
  cooldownMs: number;
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
  ownFlight: (
    record: SavedFlight,
    tripId?: string,
    opts?: OwnOptions,
  ) => Promise<OwnOutcome>;
  disownFlight: (f: SavedFlight) => Promise<void>;
  // ── PENDING LEGS ──
  pending: PendingLeg[];
  // Adds one, or says why not: 'dup', 'limit' or 'past'.
  addPendingLeg: (leg: PendingLeg) => Promise<'added' | 'dup' | 'limit' | 'past'>;
  removePendingLeg: (id: string) => Promise<void>;
  // Tries the lookup again for every pending leg (minus skipIds), saves the
  // ones that resolve, drops the ones whose date has passed. Returns what it
  // saved and how many it dropped, so the caller can say so.
  retryPending: (how: PendingResolvedEvent['how'], skipIds?: string[]) => Promise<{ resolved: SavedFlight[]; dropped: number; limit: boolean }>;
};

const SavedContext = createContext<SavedContextValue | null>(null);

export function useSaved(): SavedContextValue {
  const v = useContext(SavedContext);
  if (v === null) throw new Error('useSaved must be used inside a SavedProvider');
  return v;
}

// ── THE ACCOUNT CHANGED, SO WHAT IS ON SCREEN IS SOMEBODY ELSE'S ───────────
//
// WHY A HOOK AND NOT A CALL AT THE TWO CALL SITES. Signing in and signing out
// both happen in home's profile modal, and home cannot reach another screen's
// state. Worse, the tabs navigator keeps every screen MOUNTED when it loses
// focus, so a screen the user last saw as a guest is still sitting there with
// the guest's choices in it after they sign in. Nothing unmounts, so nothing
// resets, and no amount of care at the sign-in site fixes that.
//
// SO EACH SCREEN WATCHES THE ONE THING THAT ACTUALLY CHANGED. This was written
// out by hand on the search screen first; deck and My Flights needed the same
// three lines, and three copies of a rule is how the rule comes to differ.
//
// A REF RATHER THAN A BARE DEPENDENCY, so MOUNTING is not treated as a change.
// A screen mounts long after hydration with an account already in hand, and
// clearing on that first pass would wipe a query the user typed to get there.
//
// THE CALLBACK IS HELD IN A REF TOO, so a caller can pass an inline closure
// without wrapping it in useCallback. The effect depends on the email alone,
// which is the only thing that should be able to fire it.
export function useAccountChange(onChange: () => void): void {
  const { email } = useSaved();
  const last = useRef(email);
  const fn = useRef(onChange);
  fn.current = onChange;
  useEffect(() => {
    if (last.current === email) return;
    last.current = email;
    fn.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);
}

export function SavedProvider({ children }: { children: ReactNode }) {
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  const [pending, setPendingState] = useState<PendingLeg[]>([]);
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
  // The home screen's own hydration reads username, session, displayName and
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
    // THE SWITCH, AND IT IS THE FIRST LINE FOR A REASON. Everything below costs
    // API units; nothing above it does. See AUTO_REFRESH_ENABLED.
    if (!AUTO_REFRESH_ENABLED) return;
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
    // ── PER FLIGHT, ON ITS OWN SCHEDULE ──
    //
    // ONE INTERVAL PER RECORD rather than one for the list, so a flight in the
    // air and a flight next week are not asked about at the same rate. A null
    // interval is a record that should not be asked about at all.
    //
    // THE LATER OF THE TWO CLOCKS, unchanged: updatedAt says when this flight's
    // data last came back, and lastTriedRef says when the provider last answered
    // about it AT ALL. A flight whose lookup fails never advances updatedAt, so
    // without the second reading it would sit at the head of the queue for ever
    // and starve everything behind it.
    const stale = list.filter(f => {
      const every = refreshIntervalFor(f, at);
      if (every === null) return false;
      return at - Math.max(f.updatedAt, lastTriedRef.current.get(f.id) ?? 0) > every;
    });
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
      // ── LEGS QUEUED BEFORE THEY COULD BELONG TO A JOURNEY ──────────────
      //
      // A leg already in the store has no trip, because the field did not exist
      // when it was written. Left alone it would sit in the leftover list on
      // Home for ever while the rest of its booking is a journey in My Flights.
      //
      // MATCHED ON THE BOOKING REFERENCE, the same rule a new leg uses. Every
      // leg of one confirmation carries one, so a queued leg joins the trip of
      // the saved leg it was booked with. Nothing is guessed from airports or
      // times, and a leg with no reference keeps none.
      //
      // A STALE IDENTIFIER IS AS BAD AS NO IDENTIFIER, and this used to only
      // adopt legs whose trip was null. A leg queued before tripForBooking read
      // live storage was given a trip minted from a stale snapshot -- one no
      // saved flight carries. My Flights builds journeys from saved flights, so
      // such a trip is never drawn, and the leg was not null either, so this
      // skipped it. It rendered nowhere and could never recover, because a
      // duplicate is refused rather than updated on every later pull.
      //
      // SO THE TEST IS WHETHER THE TRIP IS REAL, not whether it is present. A
      // leg whose trip a saved flight does carry is left untouched.
      const rawPend = await getPending(email);
      const realTrips = new Set(
        list.map(f => f.tripId).filter((t): t is string => t !== null),
      );
      const pend = rawPend.map(p => {
        const trip = p.tripId ?? null;
        if (p.pnr === null) return p;
        if (trip !== null && realTrips.has(trip)) return p;
        const sibling = list.find(f => f.pnr === p.pnr && f.tripId !== null);
        // EXCLUDING ITSELF, because a leg carrying a stale trip would otherwise
        // match its own row here and re-adopt the identifier it is being
        // rescued from.
        const queued = rawPend.find(o => o.id !== p.id && o.pnr === p.pnr && o.tripId !== null);
        // AND THE SAME CONNECTION FALLBACK tripForBooking USES, because this is
        // what rescues a leg ALREADY in the store. Without it a leg whose
        // reference differs from the rest of its journey -- which is the case
        // this change exists for -- would be adopted on a fresh pull and never
        // on a launch, and a stored leg is only ever reached here.
        const legDay = Date.parse(`${p.date}T00:00:00`);
        const near = (ts: number | null) =>
          ts !== null && !Number.isNaN(legDay) && Math.abs(ts - legDay) <= MAX_CONNECTION_MS;
        const origin = hubOf(p.origin ?? '');
        const destination = hubOf(p.destination ?? '');
        const linked = list.find(f => f.tripId !== null && (
          (origin !== null && hubOf(f.to.iata) === origin && near(arrivalTs(f)))
          || (destination !== null && hubOf(f.from.iata) === destination && near(departureTs(f)))
        ));
        const tripId = sibling?.tripId ?? queued?.tripId ?? linked?.tripId ?? null;
        if (tripId === null || tripId === trip) return p;
        console.warn(`[trip] ${p.flightNumber} ${trip ?? 'null'} -> ${tripId}`);
        return { ...p, tripId };
      });
      if (pend.some((p, i) => p.tripId !== rawPend[i].tripId)) {
        await setPending(email, pend);
      }
      if (!cancelled) {
        setSavedFlights(list);
        setPendingState(pend);
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
  // ── ASKING FLIGHTRADAR24 WHETHER A FLIGHT HAS LANDED ───────────────────────
  //
  // ON THE MINUTE TICK THAT ALREADY EXISTS rather than a timer of its own. The
  // cadence is not the tick's: landingDue holds every record to one check every
  // five minutes and to the window around its own arrival, so this runs sixty
  // times an hour and usually calls out zero times.
  //
  // IT IS NOT autoRefresh AND MUST NOT BE CONFUSED WITH IT. That one is switched
  // off because it spends AeroDataBox units on flights nobody is looking at.
  // This spends FR24 credits on the one question the app cannot answer without
  // asking, during the ninety minutes a year per flight when the answer changes.
  //
  // THE OUTCOME IS WRITTEN EVERY TIME, INCLUDING THE FAILURES. 'error' is not a
  // non-event: it is what stops AeroDataBox declaring a landing while FR24 is
  // unreachable, and a check that wrote nothing on failure would look identical
  // to one that never ran.
  const landingSweepRef = useRef(false);
  const landingSweep = useCallback(async (isCancelled: () => boolean) => {
    // ONE SWEEP AT A TIME. A slow network makes ticks overlap, and two sweeps
    // would ask the same questions and pay twice for them.
    if (landingSweepRef.current) return;
    landingSweepRef.current = true;
    try {
      const list = await getSavedFlights(email);
      const now = Date.now();
      const due = list
        .filter(f => landingDue(f, arrivalTs(f), now))
        .slice(0, LANDING_SWEEP_MAX);
      if (due.length === 0) return;

      let latest: SavedFlight[] | null = null;
      for (const f of due) {
        if (isCancelled()) return;
        const result = await checkLanding(API_BASE, f);
        if (isCancelled()) return;
        latest = await setFlightLanding(email, f.id, {
          // landedUtc is only ever non-null on a 'landed' outcome, and
          // setFlightLanding will not unwrite one it already holds.
          landedUtc: result.landedUtc,
          landingSource: result.outcome === 'landed' ? 'fr24' : null,
          landingCheck: result.outcome,
        });
      }
      // ONE setState FOR THE WHOLE SWEEP. Each write returns the full list, so
      // the last one is current; setting state per flight would re-render the
      // watchlist up to four times for one pass.
      if (latest !== null && !isCancelled()) setSavedFlights(latest);
    } catch {
      // Silent, like watch.ts. A landing check that fails changes nothing on
      // screen -- the card keeps saying exactly what it said before.
    } finally {
      landingSweepRef.current = false;
    }
  }, [email]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const t = Date.now();
      const d = localDayKey(t);
      if (d !== dayRef.current) {
        dayRef.current = d;
        getSavedFlights(email).then(list => { if (!cancelled) setSavedFlights(list); });
      }
      void landingSweep(() => cancelled);
    };
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // tick() runs the sweep too, so a flight whose arrival window opened
        // while the app was in the background is asked about immediately rather
        // than up to a minute later.
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
  }, [email, landingSweep]);

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
    if (result.ok) registerWatch(API_BASE, held.flightNumber, held.flightDate, held.tripId !== null);
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
    registerWatch(API_BASE, record.flightNumber, record.flightDate, record.tripId !== null);
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
    // OWNERSHIP IS PART OF THE WATCH. Joining a trip means the person is on
    // the flight; leaving one means they are only watching it. The server
    // upserts on the same key, so this is the existing watch corrected, not a
    // second one.
    registerWatch(API_BASE, f.flightNumber, f.flightDate, tripId !== null);
  }, [email]);

  // THE MERGE'S WRITE, AND IT IS NOT ON THE CONTEXT. One caller -- ownFlight --
  // so it stays a local. setTrip is already exposed and has no caller outside
  // this file; adding a second unreachable member beside it would be the same
  // fault twice. When an unlink screen needs this it can be exposed then, with a
  // reader to justify it.
  const joinTrip = useCallback(async (ids: string[], tripId: string): Promise<void> => {
    setSavedFlights(await setFlightsTrip(email, ids, tripId));
  }, [email]);

  // ── THE USER IS FLYING THIS ONE ───────────────────────────────────────────
  //
  // TWO PATHS AND ONE OUTCOME. A flight already on the watchlist is simply
  // claimed; one that is not is saved first, because a trip's leg has to be a
  // record before it can carry a tripId.
  //
  // tripId IS OPTIONAL AND ABSENT NOW MEANS "WORK IT OUT", WHICH IS THE CHANGE.
  // It used to mean "mint a new one", and because BOTH call sites omit it, every
  // owned flight became a separate one-leg trip and two flights could never come
  // to share an id by any path in the app. The parameter was the whole mechanism
  // for a second leg joining a trip and nothing ever passed it.
  //
  // SO DETECTION SUPPLIES IT. See detectTrip: three conditions on the airports
  // and the clock, plus the archived-trip exclusion, and a merge when the new
  // flight bridges two journeys. Minting is what happens when nothing connects,
  // which is still the common case and still needs no separate call -- starting a
  // trip and owning its first leg are the same act.
  //
  // AN EXPLICIT tripId STILL WINS AND SKIPS DETECTION ENTIRELY. Nothing passes
  // one today; when a screen offers "add to this trip" by hand, a choice the user
  // has actually made must not be second-guessed by a rule.
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
  // ── OWNING, WITH TWO THINGS THE BULK PATH HAS TO TURN OFF ────────────────
  //
  // BOTH DEFAULTS ARE TODAY'S BEHAVIOUR, so the flight card's own "I am flying
  // this" button is unchanged by this parameter existing: no cap, reminders on.
  // Only the Gmail pull passes anything.
  //
  // capped: THE PULL RESPECTS THE TWENTY. Owning from the card is one deliberate
  // act and the cap is a limit on refresh cost rather than on how many journeys
  // a person may have, so that path has always bypassed it. A pull is not one
  // act -- it is however many legs a year of mail happens to contain -- and an
  // inbox quietly filling the app to thirty is worse than a pull that stops and
  // says so.
  //
  // remind: SIX REMINDERS NOBODY ASKED FOR IS HOW SOMEBODY TURNS NOTIFICATIONS
  // OFF ENTIRELY. Owning one flight by hand means "I am flying this", and
  // reminders following from that is the point; a bulk import carries no such
  // statement about any single leg. The flights arrive owned and silent, and the
  // reminder is still one swipe away on each.
  const ownFlight = useCallback(async (
    record: SavedFlight,
    tripId?: string,
    opts: OwnOptions = {},
  ): Promise<OwnOutcome> => {
    // THE LIST AS IT STANDS AFTER THE SAVE, not as it stood when this callback
    // was formed. Detection reads it, and a record saved on the line above has to
    // be in what it reads -- saveFlight returns the written list precisely so the
    // caller does not have to wait for a setState it cannot observe in its own
    // turn.
    let list = savedFlights;
    if (!savedFlights.some(f => f.id === record.id)) {
      // Never 'limit' -- see the note above. The list is set here as well as by
      // joinTrip below, so the record is in state before anything reads it back.
      // THE CAP IS THE PREDICATE. Passing a predicate that counts nothing is
      // what has always made this path uncapped; passing none uses the default,
      // which counts every record, so `capped` is not a second mechanism.
      const result = opts.capped
        ? await saveFlight(email, record)
        : await saveFlight(email, record, () => false);
      setSavedFlights(result.flights);
      // NOTHING WAS WRITTEN, so there is nothing to join to a trip and no watch
      // to register. The caller decides what to say; this only reports which
      // wall it hit.
      if (!result.ok) return { ok: false, kind: 'limit' };
      list = result.flights;
      // Owned from the first registration: this is the own path.
      registerWatch(API_BASE, record.flightNumber, record.flightDate, true);
    }
    // ONLY WHEN NOTHING WAS ASKED FOR. An explicit id is the user's decision and
    // detection does not get a vote on it.
    const found = tripId === undefined ? detectTrip(list, record, Date.now()) : null;
    const trip = tripId ?? found?.tripId ?? newTripId();
    // ONE WRITE FOR THE WHOLE JOURNEY. The record itself always, plus every leg
    // of an absorbed trip when this flight bridged two -- see detectTrip. In the
    // ordinary case absorb is empty and this is exactly the single-record write
    // setTrip used to do.
    await joinTrip([record.id, ...(found?.absorb ?? [])], trip);
    // null RATHER THAN AN OUTCOME when reminders were not asked for, so a caller
    // cannot report on something that never ran. OWN_MSG is indexed by a real
    // outcome and has no entry for "not attempted".
    const remind = opts.remind === false ? null : await enableReminders(record);
    return { ok: true, remind };
  }, [email, savedFlights, joinTrip, enableReminders]);

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
      { ran: false, throttled: false, cooldownMs: 0, failures: 0, openCardFresh: null, list: null };
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
      // ── REFRESHABLE, NOT UNARCHIVED, AND THE DIFFERENCE IS THE BUG ──
      //
      // THIS FILTERED ON !isArchived AND THAT IS SIX HOURS PAST ARRIVAL. The trip
      // screen keeps a leg on screen while ANY leg of its journey is unarchived,
      // so a leg that landed eight hours ago was visible and unrefreshable at the
      // same time: it showed DEPARTED while the provider had ARRIVED, an actual
      // arrival and a belt number, and pulling could not fix it because the
      // record never entered this list.
      //
      // refreshable IS THE SAME SHAPE AT TWENTY-FOUR HOURS, and it still refuses
      // anything filed away by hand. See its note.
      const activeSaved = savedFlights.filter(f => refreshable(f, at));
      if (activeSaved.length === 0) return { ...nothing, ran: true };   // spinner alone acknowledges; message can't render here

      const since = Date.now() - lastRefreshRef.current;
      if (since < PULL_COOLDOWN_MS) {
        // THE REMAINDER, NOT JUST THE REFUSAL. A spinner that appears and
        // resolves into nothing is indistinguishable from a broken refresh, and
        // that is how this went unnoticed long enough to be blamed on the queue.
        return { ...nothing, ran: true, throttled: true, cooldownMs: PULL_COOLDOWN_MS - since };
      }
      lastRefreshRef.current = Date.now();

      // URGENCY FIRST, THEN STALENESS, and this is the refresh QUEUE's order
      // only — a copy, so activeSaved and everything the list renders from are
      // untouched.
      //
      // THE CAP PROTECTS THE QUOTA AND STAYS. What changes is what it truncates.
      // Stale-first alone put a flight IN THE AIR at position nine of a queue cut
      // at five and spent two of those five on flights three weeks away; ranking
      // first means the cap can now only ever cost the quiet end of the list.
      //
      // STALENESS STILL ROTATES WITHIN EACH RANK, which is what the old sort was
      // for and is worth keeping: the records this pull could not reach are the
      // ones the next pull starts with, so a full watchlist comes round in two.
      const refreshQueue = [...activeSaved].sort((a, b) => {
        const byRank = refreshRank(a, at) - refreshRank(b, at);
        return byRank !== 0 ? byRank : a.updatedAt - b.updatedAt;
      });
      const { failures, openCardFresh } =
        await refreshFlights(refreshQueue, PULL_MAX_FLIGHTS, openCardId);

      const list = await getSavedFlights(email);              // read once, set state once
      setSavedFlights(list);

      // A refresh is the one moment a departure time can move under a reminder
      // that was scheduled from the old one, and the one moment a record filed
      // under "unknown" takes a real id. Both leave the schedule wrong, and
      // this is what puts it right.
      reconcile(list, undoKeepIds());

      return { ran: true, throttled: false, cooldownMs: 0, failures, openCardFresh, list };
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
  // ── PENDING LEGS ───────────────────────────────────────────────────────────
  // ── WHICH JOURNEY AN UNPUBLISHED LEG JOINS ────────────────────────────────
  //
  // THE BOOKING REFERENCE, AND NOTHING ELSE. Every leg of one confirmation
  // carries one reference, which is the fact connection detection now refuses to
  // link across; using it here is the same rule read forwards instead of
  // backwards. Airports and times are deliberately not consulted -- that is the
  // guess that joined two strangers' flights.
  //
  // AN EXISTING TRIP WINS, whether it is a saved leg's or another unpublished
  // leg's, so the legs of one booking converge on one id however they arrive.
  //
  // OTHERWISE ONE IS MINTED, and this is what makes a wholly unpublished
  // booking a journey on the day it is read rather than on the day its first
  // leg resolves. The id lives only in the pending store until then, which is
  // fine: it is a grouping, not a record of anything.
  //
  // NO REFERENCE, NO TRIP. A leg from an email that printed none has nothing
  // tying it to anything, and it keeps the standalone behaviour it has today.
  // ── READ FROM THE STORE, NOT FROM THE CLOSURE, AND THIS WAS THE BUG ───────
  //
  // A GMAIL PULL OWNS AND QUEUES IN ONE LOOP. The first leg is owned and gets a
  // trip; the second is queued a moment later and asked which trip it belongs
  // to. Asked against `savedFlights` -- the React value captured when this
  // callback was built -- the answer was "no saved leg has that reference",
  // because the leg owned two lines earlier is not in that snapshot and will
  // not be until the next render.
  //
  // SO IT MINTED A SECOND TRIP, and the booking split in two: the saved leg in
  // one, the queued legs in another that contains no saved leg at all. My
  // Flights enumerates trips from saved flights, so that second trip was never
  // drawn, and the legs were not orphans either -- they had a trip id. They
  // were in the store and on no screen.
  //
  // THE STORE IS THE TRUTH DURING A LOOP. getSavedFlights reads what was
  // actually written, including the record owned a moment ago.
  const tripForBooking = useCallback(async (
    leg: PendingLeg, pendingList: PendingLeg[],
  ): Promise<string | null> => {
    const current = await getSavedFlights(email);
    // THE REFERENCE FIRST, AND IT STILL WINS. Two legs printed on one
    // confirmation are one journey whatever the airports say, so this needs no
    // clock and cannot be fooled by a coincidence.
    if (leg.pnr !== null) {
      const saved = current.find(f => f.pnr === leg.pnr && f.tripId !== null);
      if (saved !== undefined) return saved.tripId;
      const queued = pendingList.find(p => p.pnr === leg.pnr && p.tripId !== null);
      if (queued !== undefined) return queued.tripId;
    }
    // ── THEN THE CONNECTION, BECAUSE ONE JOURNEY CAN CARRY TWO REFERENCES ────
    //
    // A real booking arrived as SFO to Copenhagen to Mumbai under one reference
    // and Mumbai to Indore under another. Matching on the reference alone left
    // the last leg in a journey of its own.
    //
    // THE DATE, NOT AN INSTANT, and that is the honest limit. A saved flight
    // has a true departure and arrival instant; this leg has a calendar date
    // and at best a printed clock with no zone. So the window is measured from
    // local midnight on the leg's date, which is loose by up to a day at the
    // edges and costs at worst one wrong adoption that a person can undo.
    const legDay = Date.parse(`${leg.date}T00:00:00`);
    const near = (ts: number | null) =>
      ts !== null && !Number.isNaN(legDay) && Math.abs(ts - legDay) <= MAX_CONNECTION_MS;
    const origin = hubOf(leg.origin ?? '');
    const destination = hubOf(leg.destination ?? '');
    const linked = current.find(f => f.tripId !== null && (
      (origin !== null && hubOf(f.to.iata) === origin && near(arrivalTs(f)))
      || (destination !== null && hubOf(f.from.iata) === destination && near(departureTs(f)))
    ));
    if (linked !== undefined) return linked.tripId;
    const linkedQueued = pendingList.find(p => p.id !== leg.id && p.tripId !== null && (
      (origin !== null && hubOf(p.destination ?? '') === origin)
      || (destination !== null && hubOf(p.origin ?? '') === destination)
    ) && Math.abs(Date.parse(`${p.date}T00:00:00`) - legDay) <= MAX_CONNECTION_MS);
    if (linkedQueued !== undefined) return linkedQueued.tripId;
    return leg.pnr === null ? null : newTripId();
  }, [email]);

  const addPendingLeg = useCallback(async (leg: PendingLeg): Promise<'added' | 'dup' | 'limit' | 'past'> => {
    const list = await getPending(email);
    const withTrip = leg.tripId !== null
      ? leg
      : { ...leg, tripId: await tripForBooking(leg, list) };
    const r = addToPending(list, withTrip, localDayKey(Date.now()));
    if (!r.ok) return r.reason;
    await setPending(email, r.pending);
    setPendingState(r.pending);
    return 'added';
  }, [email, tripForBooking]);

  const removePendingLeg = useCallback(async (id: string): Promise<void> => {
    const next = (await getPending(email)).filter(p => p.id !== id);
    await setPending(email, next);
    setPendingState(next);
  }, [email]);

  // ONE RETRY AT A TIME, for the reason landingSweep runs one sweep at a time:
  // the daily tick and a pull can land in the same second and would each pay
  // for the same lookups.
  const retryRef = useRef(false);
  const retryPending = useCallback(async (
    how: PendingResolvedEvent['how'], skipIds: string[] = [],
  ): Promise<{ resolved: SavedFlight[]; dropped: number; limit: boolean }> => {
    const nothing = { resolved: [] as SavedFlight[], dropped: 0, limit: false };
    if (retryRef.current) return nothing;
    retryRef.current = true;
    try {
      const todayKey = localDayKey(Date.now());
      const list = await getPending(email);
      const { kept, dropped, batch } = retryBatch(list, todayKey, new Set(skipIds), Date.now());
      let next = kept;
      const resolved: SavedFlight[] = [];
      let limit = false;
      for (const leg of batch) {
        const record = await tryResolve(API_BASE, leg);
        const now = Date.now();
        if (record === null) {
          next = next.map(p => p.id === leg.id ? { ...p, lastTriedAt: now, tries: p.tries + 1 } : p);
          continue;
        }
        // RESOLVED. Saved through the same path as any other flight, so the
        // watch is registered and the reminders offered exactly as if the user
        // had bookmarked it; then it leaves the pending list; then the trigger.
        // ── IT BECOMES AN ORDINARY LEG IN PLACE ──────────────────────────
        //
        // IT USED TO LAND IN THE WATCHLIST. saveRecord writes the flight with
        // no trip and registers it as watched rather than owned, so a leg that
        // had been sitting inside a journey resolved and jumped out of it --
        // the person watched it become a stranger.
        //
        // THE TRIP IT WAS SHOWN IN IS THE TRIP IT JOINS, passed explicitly, so
        // detection does not get a vote. It already had an answer: the leg was
        // put in that journey by its booking reference, which is a better fact
        // than any airport-and-clock guess.
        //
        // WITHOUT ONE, DETECTION DECIDES, which is the ordinary owning path and
        // the right behaviour for a leg that never belonged to a journey.
        const outcome = leg.tripId !== null
          ? await ownFlight(record, leg.tripId, { remind: false })
          : await ownFlight(record, undefined, { remind: false });
        if (!outcome.ok) { limit = true; break; }
        next = next.filter(p => p.id !== leg.id);
        resolved.push(record);
        await recordResolved(email, leg, record, how);
      }
      await setPending(email, next);
      setPendingState(next);
      if (how === 'daily' || how === 'mount') await setRetryDay(email, todayKey);
      return { resolved, dropped: dropped.length, limit };
    } finally {
      retryRef.current = false;
    }
  }, [email, saveRecord]);

  // ── THE RETRY TICK, WHICH IS NO LONGER ONCE A DAY ────────────────────────
  //
  // DAILY WAS RIGHT THREE WEEKS OUT AND WRONG THE DAY BEFORE. The tick still
  // fires every minute; what changed is what it asks. It used to ask "has a day
  // passed since the last sweep", one question for the whole list, so a leg
  // departing tomorrow waited behind one departing in March. Now each leg
  // carries its own interval -- see retryInterval -- and the pass runs whenever
  // ANY leg is due on its own clock.
  //
  // THE DAY STAMP SURVIVES, FOR THE FAR TIER ONLY. A leg more than a week out
  // wants a daily retry, and the stamp is what makes that hold across a phone
  // that was off over midnight: legDue alone would fire on the first tick after
  // launch every single day, which is the same thing, and after a cold start at
  // 23:58 it would fire twice in three minutes. The stamp is the cheaper guard
  // and it costs one read.
  //
  // A PASS IS STILL BOUNDED. retryBatch caps how many legs one sweep looks up,
  // so a list of fifty legs that all come due at once cannot spend the day's
  // provider budget in one minute; the rest are picked up on the next tick.
  useEffect(() => {
    if (!authHydrated) return;
    let cancelled = false;
    const maybe = async () => {
      const list = await getPending(email);
      if (list.length === 0 || cancelled) return;
      const now = Date.now();
      const anyDue = list.some(p => legDue(p, now));
      if (!anyDue) return;
      // The daily stamp still gates the case it was written for: nothing here
      // is urgent, and the whole list is on the far tier.
      const urgent = list.some(p => retryInterval(p, now) < RETRY_INTERVALS_MS.far && legDue(p, now));
      if (!urgent && !dueToday(await getRetryDay(email), localDayKey(now))) return;
      if (!cancelled) await retryPending(urgent ? 'due' : 'daily');
    };
    void maybe();
    const id = setInterval(() => { void maybe(); }, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [authHydrated, email, retryPending]);

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
    pending,
    addPendingLeg,
    removePendingLeg,
    retryPending,
  }), [
    savedFlights, email, setEmail, refreshing,
    saveRecord, handleUnsave, undoUnsave, refreshOne, refreshAll,
    handleRemind, setArchived, setTrip, ownFlight, disownFlight,
    pending, addPendingLeg, removePendingLeg, retryPending,
  ]);

  return (
    <SavedContext.Provider value={value}>
      {children}
    </SavedContext.Provider>
  );
}
