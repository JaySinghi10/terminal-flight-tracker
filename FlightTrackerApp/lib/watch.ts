// The device's half of push notifications, and the only file that knows the
// server keeps a watch at all.
//
// FIRE AND FORGET, ABSOLUTELY. Both exported functions return void rather than
// a promise, which is not a style choice: a promise is something a call site
// can accidentally await, and awaiting either of these would put a network
// round trip in front of a save. Saving a flight is a local operation and has
// to stay one. Nothing here sets error state, shows a toast, shakes the input
// or touches the UI in any way — a device with no signal saves flights exactly
// as it always did and never learns that a registration failed.
//
// THE SERVER IS THE ONE THAT DECIDES. Everything sent here is validated again
// in store.py, which is where the caps live too. This file's job is to send a
// well-formed request and forget about it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

// Its own key, not part of the saved-flight store. The device id outlives every
// flight on it and belongs to the install rather than to any record, and
// storage.ts deliberately knows nothing about watches.
const DEVICE_ID_KEY = 'watch:deviceId';

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

// NULL, ON PURPOSE, AND THIS IS THE ONLY FUNCTION THAT CHANGES LATER.
//
// Remote push is not available in Expo Go on SDK 54 — the client was removed
// from it — and app.json carries no EAS project id, which is what an Expo push
// token has to be scoped to. There is nothing to return yet and pretending
// otherwise would put a fabricated value in the store.
//
// REGISTRATION STILL HAPPENS WITH A NULL TOKEN, deliberately. A null token
// exercises the entire server path and populates the watch store; the token
// fills in when the dev build exists, and nothing on the server changes when it
// does, because a row's token is refreshed by the next registration anyway.
export async function pushToken(): Promise<string | null> {
  return null;
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
async function post(apiBase: string, path: string, payload: object): Promise<void> {
  await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Watch-Secret': WATCH_SECRET,
    },
    body: JSON.stringify(payload),
  });
}

// apiBase is a parameter rather than an import because index.tsx imports this
// module: importing API_BASE back out of it would be a cycle, and a second copy
// of the Cloud Run URL would be a second thing to change.
//
// The try covers the device-id read as well as the fetch, so a failure in
// AsyncStorage is as silent as a failure in the network.
export function registerWatch(apiBase: string, flightNumber: string, flightDate: string): void {
  if (!ISO_DAY_RE.test(flightDate)) return;
  void (async () => {
    try {
      await post(apiBase, '/watch', {
        device_id: await deviceId(),
        push_token: await pushToken(),
        platform: platformName(),
        // The same normalisation makeFlightId applies, so the server and the
        // device agree on what a flight is.
        flight_number: flightNumber.toUpperCase(),
        flight_date: flightDate,
      });
    } catch {
      // Invisible, by design. See the note at the top of this file.
    }
  })();
}

export function deregisterWatch(apiBase: string, flightNumber: string, flightDate: string): void {
  if (!ISO_DAY_RE.test(flightDate)) return;
  void (async () => {
    try {
      await post(apiBase, '/unwatch', {
        device_id: await deviceId(),
        flight_number: flightNumber.toUpperCase(),
        flight_date: flightDate,
      });
    } catch {
      // Invisible, by design.
    }
  })();
}
