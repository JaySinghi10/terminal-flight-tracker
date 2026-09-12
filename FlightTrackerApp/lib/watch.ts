// The device's half of push notifications, and the only file that knows the
// server keeps a watch at all.
//
// FIRE AND FORGET, ABSOLUTELY. registerWatch and deregisterWatch return void
// rather than a promise, which is not a style choice: a promise is something a
// call site can accidentally await, and awaiting either of these would put a
// network round trip in front of a save. Saving a flight is a local operation
// and has to stay one. Nothing here sets error state, shows a toast, shakes the
// input or touches the UI in any way — a device with no signal saves flights
// exactly as it always did and never learns that a registration failed.
//
// WITH ONE EXCEPTION, AND IT IS DELIBERATE: the FIRST registration on an install
// may put the system's notification prompt on screen. A watch with no push token
// is a flight the server can never tell anybody about, and permission used to be
// asked for only by the reminder path — so somebody who saved flights without
// ever setting a reminder was registered, silently, as unreachable. The prompt is
// asked for once per install and never again, it does not block the save, and a
// refusal is remembered rather than retried. See ensurePushToken.
//
// THE SERVER IS THE ONE THAT DECIDES. Everything sent here is validated again
// in store.py, which is where the caps live too. This file's job is to send a
// well-formed request and forget about it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Its own key, not part of the saved-flight store. The device id outlives every
// flight on it and belongs to the install rather than to any record, and
// storage.ts deliberately knows nothing about watches.
const DEVICE_ID_KEY = 'watch:deviceId';

// WHETHER THIS INSTALL HAS EVER BEEN ASKED. Written before the prompt is shown,
// so a person is asked once and once only, whatever they answered and whatever
// happened next. The system has its own memory of a refusal -- on iOS a second
// request resolves with no dialog at all -- but it cannot tell us whether the
// question has been PUT, and asking on every save would be the one behaviour
// that gets notifications turned off wholesale.
const PUSH_ASKED_KEY = 'watch:pushAsked';

// THE TOKEN EVERY EXISTING WATCH HAS ALREADY BEEN TOLD ABOUT. See
// backfillWatches: this is what makes the re-registration happen once per token
// rather than on every launch, and what makes it happen AGAIN if Expo ever
// issues this install a different one.
const TOKEN_SENT_KEY = 'watch:tokenRegisteredFor';

const DAY_MS = 24 * 60 * 60 * 1000;

// The same test storage.ts's ISO_DAY_RE applies, and it is here for a reason
// that matters: makeFlightId files a record with no usable date under the
// literal string "unknown", so a saved flight's flightDate is NOT guaranteed to
// be a date. The server requires a real one, so a flight filed under "unknown"
// is never registered — and, by the same rule below, never deregistered
// either. Consistency: the two calls agree on what a flight is, so the store
// can never be asked to remove something it was never allowed to hold.
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GENERATED ONCE, REUSED FOREVER. Cached in memory as well as persisted so a
// save does not wait on AsyncStorage after the first call.
let deviceIdCache: string | null = null;

async function deviceId(): Promise<string> {
  if (deviceIdCache !== null) return deviceIdCache;
  const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (stored !== null && stored !== '') {
    deviceIdCache = stored;
    return stored;
  }
  // expo-crypto's randomUUID is synchronous and returns the canonical
  // 36-character v4 form, which is exactly what the server validates against.
  const made = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, made);
  deviceIdCache = made;
  return made;
}

// ── THE DEVICE'S PUSH ADDRESS ────────────────────────────────────────────────
//
// THIS RETURNED A HARDCODED null AND IT NO LONGER HAS TO. The old note gave two
// reasons: Expo Go cannot issue a remote token, and app.json carried no EAS
// project id. THE SECOND IS NOW FALSE — app.json has extra.eas.projectId — and
// the first was never a reason to have no implementation, only a reason for
// this to return null AT RUNTIME in Expo Go, which it still does.
//
// A TOKEN IS SCOPED TO A PROJECT ID, so it is read from the manifest rather than
// written here. expoConfig is what a running app sees; easConfig is the older
// shape and costs one `??` to keep working. No project id means no token, and
// that is a configuration fault worth failing quietly on rather than guessing.
const PROJECT_ID: string | undefined =
  (Constants.expoConfig as any)?.extra?.eas?.projectId
  ?? (Constants as any)?.easConfig?.projectId;

// ONE FETCH PER LAUNCH. getExpoPushTokenAsync is a network round trip to Expo's
// servers, and registerWatch runs on every save — without this, saving four
// flights in a row would make four identical calls. The value is stable for the
// life of an install, so memory is the right lifetime: a cold start re-reads it,
// which is also how a token that Expo has rotated gets picked up.
let tokenCache: string | null = null;

// Remembered in memory as well as on disk, so the common path costs no read.
let askedCache = false;

// ONE PROMPT AND ONE FETCH AT A TIME. Two registrations can be in flight at once
// -- owning a flight registers it and then joins it to a trip, which registers it
// again -- and without this they would race: two dialogs, or one call finishing
// before permission was granted and writing a row with no token over the row the
// other had just given one. Every caller in a batch shares one answer.
let tokenPromise: Promise<string | null> | null = null;

async function alreadyAsked(): Promise<boolean> {
  if (askedCache) return true;
  try {
    const v = await AsyncStorage.getItem(PUSH_ASKED_KEY);
    if (v === '1') {
      askedCache = true;
      return true;
    }
  } catch {
    // AN UNREADABLE FLAG COUNTS AS ASKED. Being wrong this way costs a device
    // its push token; being wrong the other way prompts somebody repeatedly,
    // which is how an app gets its notifications turned off for good.
    return true;
  }
  return false;
}

// ── THE TOKEN, AND THE ONE QUESTION THIS FILE IS ALLOWED TO ASK ─────────────
//
// allowPrompt IS THE WHOLE DIFFERENCE between the two callers. A registration --
// somebody saving or watching a flight -- may ask for permission, because that is
// the moment the question has a reason behind it. The backfill may not: it runs
// unattended at launch and a dialog there would come out of nowhere.
//
// ASKED ONCE PER INSTALL, marked BEFORE the prompt goes up. A crash or a
// dismissal mid-dialog therefore counts as asked, which is the safe direction:
// the reminder swipe still has its own request for the person who changes their
// mind, and lib/reminders.ts is where that belongs.
//
// A REFUSAL IS NOT AN ERROR AND BLOCKS NOTHING. It returns null, the row is
// written without a token, and the flight is saved exactly as it would have been.
export function ensurePushToken(allowPrompt: boolean): Promise<string | null> {
  if (tokenCache !== null) return Promise.resolve(tokenCache);
  if (tokenPromise !== null) return tokenPromise;
  tokenPromise = fetchToken(allowPrompt).finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function fetchToken(allowPrompt: boolean): Promise<string | null> {
  if (PROJECT_ID === undefined) return null;
  try {
    // ALREADY GRANTED, OR ASK ONCE. On iOS a token cannot be issued without APNs
    // registration, which permission gates, so this check is also what stops
    // getExpoPushTokenAsync throwing on the common path.
    let granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted && allowPrompt && !(await alreadyAsked())) {
      askedCache = true;
      try {
        await AsyncStorage.setItem(PUSH_ASKED_KEY, '1');
      } catch {
        // The in-memory flag still holds for this launch. A storage that cannot
        // be written is not a reason to skip the one prompt this install gets.
      }
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return null;
    // THROWS IN EXPO GO AND ON A SIMULATOR, both of which are ordinary states
    // rather than errors. The catch below is the whole handling: no token, no
    // registration change, nothing said.
    const issued = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
    const value = issued?.data ?? null;
    if (typeof value !== 'string' || value === '') return null;
    tokenCache = value;
    return value;
  } catch {
    // Expo Go, a simulator, no network, no credentials. See the note at the top.
    return null;
  }
}

// TODAY, AND YESTERDAY, ON THE DEVICE'S OWN CALENDAR. The server refuses a date
// more than two days behind it and prunes rows past that, so the backfill does
// not offer it flights it would only reject -- one rejection per archived flight
// would be a pile of failure reports about nothing. A day of slack covers the
// device and the server disagreeing about what day it is.
function isoDay(at: number): string {
  const d = new Date(at);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function platformName(): 'ios' | 'android' | 'unknown' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'unknown';
}

// THE SHARED SECRET /watch AND /unwatch REQUIRE. Both endpoints 404 without it.
//
// EXPO_PUBLIC_ IS THE PREFIX THAT MAKES IT REACH THE BUNDLE AT ALL — Expo inlines
// only those at build time, and a variable without it is simply undefined here.
// That prefix is also Expo's own way of saying the value is NOT SECRET: it is
// compiled into the shipped JavaScript, so anyone with the app has it. It is kept
// out of this repository rather than out of the binary, which is a smaller claim
// than it looks and is the honest one. See the note above the endpoints in api.py.
//
// UNDEFINED IS A REAL STATE, not a bug to guard against: a local `expo start`
// with no .env sends the header with an empty value, the server compares it and
// refuses, and registration silently stops — exactly as it would with a wrong
// value. There is nothing better this file could do with that, for the reason
// the note at the top gives.
const WATCH_SECRET = process.env.EXPO_PUBLIC_WATCH_SECRET ?? '';

// One place the request is actually made, so both endpoints behave the same
// way. A non-2xx does not throw and is not read — there is nothing this side
// could usefully do with it.
//
// THE SECRET RIDES HERE RATHER THAN AT THE TWO CALL SITES, so /watch and
// /unwatch cannot come to disagree about whether they send it.
async function post(apiBase: string, path: string, payload: object): Promise<number> {
  const resp = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Watch-Secret': WATCH_SECRET,
    },
    body: JSON.stringify(payload),
  });
  return resp.status;
}

// ── A REGISTRATION THAT DID NOT LAND MUST NOT LOOK LIKE ONE THAT DID ───────
//
// THE NOTE ABOVE SAID A NON-2xx WAS NOT WORTH READING, and it was wrong in one
// specific way that cost three builds. A dropped packet is transient and the
// next save retries it, which is the case that reasoning was about. A 404 from
// a rejected secret is not transient: it is a build that can never register
// anything, and it is indistinguishable from success from in here.
//
// That is exactly what happened. Every TestFlight build inlined an empty watch
// secret, because the value lives in a .env that is git-ignored and EAS builds
// from git. Every save on every one of those builds wrote locally, failed at
// the server, and said nothing. The poller never learned those flights existed,
// so no notification could ever be sent about them.
//
// THE STATUS IS REPORTED, THE SECRET IS NOT. A rejected secret in a log is a
// secret in a log, which is the same rule the server keeps at its own end.
export type WatchFailure = {
  path: string;
  // null when the request never got far enough to have one -- no network, or a
  // failure reading the device id.
  status: number | null;
};

// ONE REPORTER, SET BY THE APP, because this module cannot reach a toast: it is
// imported BY the screens, so importing one back would be a cycle. A screen
// registers a function and decides what to do with the news; nothing here knows
// what a toast is.
let reporter: ((failure: WatchFailure) => void) | null = null;

export function onWatchFailure(fn: ((failure: WatchFailure) => void) | null): void {
  reporter = fn;
}

function report(path: string, status: number | null): void {
  // ALWAYS LOGGED, whether or not anything is listening, because a development
  // build has a console and no toast worth interrupting.
  console.warn(`[watch] ${path} did not register (status ${status ?? 'no response'})`);
  try {
    reporter?.({ path, status });
  } catch {
    // A reporter that throws must not take the caller down with it.
  }
}

// apiBase is a parameter rather than an import because index.tsx imports this
// module: importing API_BASE back out of it would be a cycle, and a second copy
// of the Cloud Run URL would be a second thing to change.
//
// The try covers the device-id read as well as the fetch, so a failure in
// AsyncStorage is as silent as a failure in the network.
//
// ONE REQUEST, AWAITABLE, AND IT REPORTS NOTHING. Both the registration below
// and the backfill send exactly this, so they cannot come to disagree about the
// body; what differs is who may prompt and who speaks up about a failure.
// Returns the status, or null when the request never got far enough to have one.
async function sendWatch(
  apiBase: string,
  flightNumber: string,
  flightDate: string,
  owned: boolean,
  allowPrompt: boolean,
): Promise<number | null> {
  try {
    return await post(apiBase, '/watch', {
      device_id: await deviceId(),
      push_token: await ensurePushToken(allowPrompt),
      platform: platformName(),
      // The same normalisation makeFlightId applies, so the server and the
      // device agree on what a flight is.
      flight_number: flightNumber.toUpperCase(),
      flight_date: flightDate,
      owned,
    });
  } catch {
    return null;
  }
}

// owned: the person is ON this flight (true) or meeting it (false). The
// server writes the subject of a notification from it -- "your flight to X"
// against "the flight from Y" -- so it is sent on every registration, and a
// change of ownership re-registers. See notify.py on the server.
export function registerWatch(apiBase: string, flightNumber: string, flightDate: string, owned: boolean): void {
  if (!ISO_DAY_RE.test(flightDate)) return;
  void (async () => {
    // MAY ASK FOR PERMISSION, ONCE PER INSTALL. This is a save or a watch, which
    // is the only moment the question is warranted. See ensurePushToken.
    const status = await sendWatch(apiBase, flightNumber, flightDate, owned, true);
    // A null status means the request never completed, or the device id could
    // not be read. Reported all the same, because the outcome for the user is
    // identical -- the server does not know about this flight.
    if (status === null || status < 200 || status >= 300) report('/watch', status);
  })();
}

// ── EVERY WATCH THIS INSTALL ALREADY HAS, ONCE A TOKEN EXISTS ───────────────
//
// A ROW IS WRITTEN ONCE AND NEVER REVISITED. Registration happens on the save,
// so a flight saved before permission was granted has a row with no push token
// and nothing to correct it: the server can never tell anybody about that
// flight, however many other flights are registered afterwards.
//
// SO THE FIRST TOKEN RE-REGISTERS ALL OF THEM. The server upserts on device,
// number and date, so each of these is the existing row corrected rather than a
// second one, and the caps are untouched.
//
// IT NEVER PROMPTS. allowPrompt is false: this runs unattended, and the ask
// belongs to a save. With no token it does nothing at all -- which also means it
// can never overwrite a row's good token with a null one.
//
// ONCE PER TOKEN. The token it finished for is remembered on disk, so this is a
// single read on every later launch; a token Expo has rotated is a new value and
// runs again. Nothing is marked unless every send succeeded, so an offline
// launch retries on the next one rather than recording a lie.
let backfillDone: string | null = null;
let backfillRunning = false;

export async function backfillWatches(
  apiBase: string,
  flights: readonly { flightNumber: string; flightDate: string; tripId: string | null }[],
): Promise<void> {
  if (backfillRunning) return;
  try {
    const token = await ensurePushToken(false);
    if (token === null) return;
    if (backfillDone === token) return;
    const stored = await AsyncStorage.getItem(TOKEN_SENT_KEY);
    if (stored === token) {
      backfillDone = token;
      return;
    }
    // Flights the server would still accept. See isoDay.
    const floor = isoDay(Date.now() - DAY_MS);
    const due = flights.filter(f => ISO_DAY_RE.test(f.flightDate) && f.flightDate >= floor);
    backfillRunning = true;
    let every = true;
    let firstBad: number | null = null;
    // ONE AT A TIME. Every one of these is a read-modify-write of a single
    // object in Cloud Storage, and firing twenty at once is how they collide
    // and retry each other. See _mutate_watches on the server.
    for (const f of due) {
      const status = await sendWatch(apiBase, f.flightNumber, f.flightDate, f.tripId !== null, false);
      if (status === null || status < 200 || status >= 300) {
        every = false;
        if (firstBad === null) firstBad = status;
      }
    }
    // ONE REPORT FOR THE WHOLE PASS, not one per flight: a rejected secret or a
    // dead network fails all of them for one reason, and twenty identical
    // toasts would say it twenty times.
    if (!every) report('/watch (backfill)', firstBad);
    if (every) {
      backfillDone = token;
      await AsyncStorage.setItem(TOKEN_SENT_KEY, token);
    }
  } catch {
    // Silent, exactly as everything else here is. See the top of the file.
  } finally {
    backfillRunning = false;
  }
}

export function deregisterWatch(apiBase: string, flightNumber: string, flightDate: string): void {
  if (!ISO_DAY_RE.test(flightDate)) return;
  void (async () => {
    try {
      const status = await post(apiBase, '/unwatch', {
        device_id: await deviceId(),
        flight_number: flightNumber.toUpperCase(),
        flight_date: flightDate,
      });
      if (status < 200 || status >= 300) report('/unwatch', status);
    } catch {
      report('/unwatch', null);
    }
  })();
}
