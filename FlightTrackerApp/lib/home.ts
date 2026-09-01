// WHERE THE MAP OPENS, AND HOW IT REMEMBERS.
//
// THREE ANSWERS IN ORDER OF QUALITY, and every one of them is a real answer —
// nothing here can fail into a blank map:
//
//   position   the device's own coordinates, once the user has allowed it
//   zone       the user's country, read from the device timezone
//   fallback   a fixed camera, when even the timezone matches nothing
//
// THE ZONE ANSWER COSTS NOTHING AND NEEDS NO PERMISSION. Intl already knows the
// timezone and lib/airports already carries a tz for every row, so the
// intersection of the two is the user's country for free and with nothing to ask
// them for. It is computed SYNCHRONOUSLY, which is what lets the map open on it
// rather than opening somewhere arbitrary and correcting itself.
//
// A TIMEZONE IS A REGION, NOT A POINT. The airports sharing one are spread
// across it, so their bounding box IS the country-ish extent — and that is why
// `zone` carries a box while `position` carries only a point. Framing the box is
// reading the signal for what it actually says.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { allAirports } from './airports';

// A DISCRIMINATED UNION rather than a bag of optional fields, because the three
// answers are genuinely different shapes and the caller has to treat them
// differently: only `zone` can be fitted to a box, and only `position` earns a
// pin. Optional fields would have let "a point with a box" and "a country with a
// pin" be spelled, and both are nonsense.
export type HomeView =
  | { kind: 'position'; lon: number; lat: number }
  | { kind: 'zone'; lon: number; lat: number; bbox: [number, number, number, number] }
  | { kind: 'fallback'; lon: number; lat: number };

// THE LEGACY ALIASES ARE HERE BECAUSE DEVICES STILL SEND THEM. Android reports
// Asia/Calcutta on a great many handsets while the dataset says Asia/Kolkata,
// and without this the largest market in the set would silently fall through to
// the fixed camera.
const TZ_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

// ARBITRARY, AND SAID SO. Nothing about this point is meaningful; it is where
// the map looks when the device tells us nothing we can use. It is over land at
// a latitude Mercator does not distort badly, and that is the whole of it.
const FALLBACK: HomeView = { kind: 'fallback', lon: 20, lat: 20 };

// WHAT "COUNTRY ZOOM" MEANS, in MapLibre zoom rather than in kilometres.
//
// With 512px tiles the viewport spans 402 * 40075 / (512 * 2^z) * cos(lat) km,
// so at 50N z4 is about 1,265km across and z5 about 632km. z4 reads as a country
// with its neighbours around it; z6 is a region and z8 is a city. A POSITION is
// given z4.5 as a compromise — close enough that the user can see where they
// are, far enough that the country is still the subject.
export const HOME_ZOOM_POSITION = 4.5;
export const HOME_ZOOM_FALLBACK = 2.2;
// AND A CEILING ON THE FITTED BOX. Singapore's timezone is one airport and its
// box is a point; without this the fit would drop onto a runway.
export const HOME_ZOOM_MAX = 5.5;

// ── THE ZONE ANSWER ─────────────────────────────────────────────────────────
//
// SYNCHRONOUS ON PURPOSE. The map's opening camera is baked into the page it
// loads, so this has to be answerable before any promise resolves — otherwise
// the map opens somewhere arbitrary and visibly corrects itself.
export function timezoneHome(): HomeView {
  // IN A try BECAUSE Intl IS NOT GUARANTEED. Hermes can be built without the
  // full ICU data, and a map that throws on startup because it wanted to be
  // clever about the opening camera is worse than one that opens over nowhere.
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return FALLBACK;
  }
  const zone = TZ_ALIASES[tz] ?? tz;
  if (zone === '') return FALLBACK;

  let w = 180; let e = -180; let s = 90; let n = -90; let count = 0;
  for (const a of allAirports()) {
    if (a.tz !== zone) continue;
    count++;
    if (a.lon < w) w = a.lon;
    if (a.lon > e) e = a.lon;
    if (a.lat < s) s = a.lat;
    if (a.lat > n) n = a.lat;
  }
  if (count === 0) return FALLBACK;

  // A ZONE WITH ONE AIRPORT HAS A ZERO-SIZE BOX. Giving it a floor here rather
  // than at the fit means every consumer gets a box it can actually frame.
  const padLon = Math.max((e - w) * 0.12, 0.5);
  const padLat = Math.max((n - s) * 0.12, 0.5);
  return {
    kind: 'zone',
    lon: (w + e) / 2,
    lat: (s + n) / 2,
    bbox: [w - padLon, s - padLat, e + padLon, n + padLat],
  };
}

// ── PERSISTENCE, SCOPED TO AN ACCOUNT ───────────────────────────────────────
//
// TWO KEYS PER SCOPE, AND THE SECOND IS NOT DERIVABLE FROM THE FIRST. "We have a
// home view" and "we have already asked for location" are different facts: a
// user who refused has no position but must never be asked again, and storing
// only the home would make that refusal look like a first run every launch.
//
// THE SCOPE IS THE ACCOUNT, NOT THE DEVICE, and v1 got that wrong. Device
// scoping meant one person's coordinates were the next person's opening view,
// and it meant a second account could never be asked because the first had
// already answered. Both fall out of the same mistake.
//
// THE SHAPE IS `prefix + scope` ON PURPOSE, so a settings screen can build the
// key for the account it is showing and clear exactly that one — see
// homeKeysFor. Nothing needs to enumerate storage or parse a blob.
const KEY_HOME = 'map.home.v3:';
const KEY_CONSENT = 'map.locationConsent.v3:';

// ── TWO INDEPENDENT FACTS, AND BOTH MUST BE TRUE ────────────────────────────
//
// THE OS GRANT IS DEVICE-WIDE and cannot express "this account agreed". Once one
// person allows location on this phone, requestForegroundPermissionsAsync
// returns granted for everyone afterwards, with no dialogue — so a second
// account was silently given a position it never consented to. The OS is
// answering a different question from the one we need answered.
//
// THIS CONSENT IS OURS AND IS PER ACCOUNT. It is not a record of whether we
// ASKED — that was the v2 mistake, and it is why the flag could be satisfied
// without anyone agreeing to anything. It is the answer itself.
//
// ABSENT MEANS UNDECIDED, which is a third state and not a falsy 'declined'. An
// account that has never been asked gets the country view AND a prompt; one that
// declined gets the country view and silence. Collapsing them would either nag
// the decliner forever or never ask the newcomer.
export type LocationConsent = 'granted' | 'declined';

// ── THERE IS NO SIGNED-OUT SCOPE, AND THAT IS DELIBERATE ────────────────────
//
// It used to be '@signedout', a scope like any other, on the reasoning that a
// signed-out session needed somewhere to keep its own answer. That was wrong:
// CONSENT BELONGS TO AN ACCOUNT. There is nobody to ask when nobody is signed
// in, and a guest agreeing to something binds no one — the next guest is a
// different person on the same device.
//
// SO SIGNED OUT IS NOT A SCOPE WITH DIFFERENT DATA. It is the absence of the
// question: the country view, no prompt, no pin, and nothing written to disk.
// Every accessor in this file takes a scope and every scope is an account.
//
// THE OLD KEYS ARE PURGED, not left to sit under a name nothing will ask for
// again — see LEGACY_PREFIXES.
const SIGNED_OUT_LEGACY = ['map.home.v3:@signedout', 'map.locationConsent.v3:@signedout'];

// What a settings screen needs to read or clear one account's location data.
// Two keys, both derived from the scope, nothing to enumerate.
export function homeKeysFor(scope: string): { home: string; consent: string } {
  return { home: KEY_HOME + scope, consent: KEY_CONSENT + scope };
}

// ── v1 AND v2 ARE DISCARDED, NOT MIGRATED ───────────────────────────────────
//
// v1 WAS DEVICE-SCOPED. There is no way to know whose coordinates those were, so
// attaching them to whoever is signed in now would be the very bug the scoping
// exists to prevent.
//
// v2 IS DISCARDED FOR A DIFFERENT AND STRONGER REASON: its flag recorded that we
// ASKED, not that anyone AGREED, and a stored v2 position was therefore acquired
// without consent under the rules that now apply. Consent cannot be inferred
// backwards from a record that never captured it, so the honest migration is to
// forget both and ask once. Every account is asked exactly one more time.
//
// AND THEY ARE ACTIVELY DELETED rather than left to rot, or a position the user
// believes was forgotten stays on disk. Once, at startup.
// v1 IS TWO EXACT KEYS; v2 IS A FAMILY. v2 keys carry the scope as a suffix, so
// they cannot be listed in advance — the store has to be enumerated and filtered
// by prefix. That is the one place this module reads all of storage, and it
// happens once per launch.
// v3's @signedout pair joins the list: the scope no longer exists, so its keys
// are as dead as v1's and hold a position no account ever consented to.
const LEGACY_EXACT = ['map.home.v1', 'map.locationAsked.v1', ...SIGNED_OUT_LEGACY];
const LEGACY_PREFIXES = ['map.home.v2:', 'map.locationAsked.v2:'];

// ── THE PURGE IS A GATE, NOT A STEP ─────────────────────────────────────────
//
// EVERY ACCESSOR IN THIS FILE AWAITS IT, so no caller can read or write a key
// before the legacy sweep has finished. The guarantee lives in the module that
// owns the keys rather than in the order two effects happen to be declared in a
// screen — which is the kind of ordering that holds until someone moves a hook.
//
// MEMOISED, SO IT RUNS ONCE. The first accessor to arrive starts it; everyone
// after awaits the same promise. Calling purgeLegacyHome() directly is therefore
// free and only serves to start it early.
//
// TO BE CLEAR ABOUT WHAT THIS DOES AND DOES NOT FIX: today the key sets are
// disjoint — the purge touches v1 and v2, the accessors touch v3 — so the race
// could not have produced a wrong answer. This makes the ordering EXPLICIT so
// that a future version which needs to migrate rather than discard cannot
// silently depend on an accident.
let purgePromise: Promise<void> | null = null;

export function purgeLegacyHome(): Promise<void> {
  if (purgePromise === null) purgePromise = runPurge();
  return purgePromise;
}

async function runPurge(): Promise<void> {
  try {
    const all = await AsyncStorage.getAllKeys();
    const doomed = all.filter((k) =>
      LEGACY_EXACT.includes(k) || LEGACY_PREFIXES.some((p) => k.startsWith(p)));
    if (doomed.length === 0) {
      console.log('[HOME][KEY] purgeLegacy: nothing from v1 or v2 present');
      return;
    }
    await AsyncStorage.multiRemove(doomed);
    console.log(`[HOME][KEY] purgeLegacy: removed ${doomed.join(', ')}`);
  } catch {
    // Nothing reads them; a failure here costs a few bytes, not correctness.
    console.log('[HOME][KEY] purgeLegacy: threw');
  }
}

export async function loadHome(scope: string): Promise<HomeView | null> {
  await purgeLegacyHome();
  try {
    const key = KEY_HOME + scope;
    const raw = await AsyncStorage.getItem(key);
    console.log(`[HOME][KEY] read  ${key} -> ${raw === null ? 'null' : raw.slice(0, 90)}`);
    if (raw === null) return null;
    const v = JSON.parse(raw);
    // VALIDATED RATHER THAN TRUSTED. This came off the disk, where a previous
    // version of this app wrote it; a shape change would otherwise surface as a
    // camera flying to NaN.
    if (v === null || typeof v !== 'object') return null;
    if (typeof v.lon !== 'number' || typeof v.lat !== 'number') return null;
    if (!Number.isFinite(v.lon) || !Number.isFinite(v.lat)) return null;
    if (v.kind === 'position' || v.kind === 'fallback') {
      return { kind: v.kind, lon: v.lon, lat: v.lat };
    }
    if (v.kind === 'zone' && Array.isArray(v.bbox) && v.bbox.length === 4
      && v.bbox.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) {
      return { kind: 'zone', lon: v.lon, lat: v.lat, bbox: v.bbox as [number, number, number, number] };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveHome(scope: string, h: HomeView): Promise<void> {
  await purgeLegacyHome();
  try {
    const key = KEY_HOME + scope;
    console.log(`[HOME][KEY] write ${key} <- ${JSON.stringify(h)}`);
    await AsyncStorage.setItem(key, JSON.stringify(h));
  } catch {
    // A HOME THAT WILL NOT PERSIST IS NOT AN ERROR THE USER SHOULD SEE. The map
    // still opens correctly this session; it just recomputes next launch.
  }
}

// null MEANS UNDECIDED, and every caller has to handle three cases.
export async function loadConsent(scope: string): Promise<LocationConsent | null> {
  await purgeLegacyHome();
  try {
    const key = KEY_CONSENT + scope;
    const v = await AsyncStorage.getItem(key);
    console.log(`[HOME][KEY] read  ${key} -> ${v ?? 'null (undecided)'}`);
    return v === 'granted' || v === 'declined' ? v : null;
  } catch {
    // FAIL AS DECLINED. If consent cannot be read we do not have it, and using a
    // position we cannot show consent for is the one outcome worth avoiding.
    // The cost of being wrong this way is a country view.
    console.log('[HOME][KEY] read consent threw, treating as declined');
    return 'declined';
  }
}

export async function saveConsent(scope: string, c: LocationConsent): Promise<void> {
  await purgeLegacyHome();
  try {
    const key = KEY_CONSENT + scope;
    console.log(`[HOME][KEY] write ${key} <- ${c}`);
    await AsyncStorage.setItem(key, c);
  } catch {
    // A DECLINE THAT WILL NOT PERSIST MEANS ASKING AGAIN NEXT LAUNCH, which is
    // annoying rather than harmful. A grant that will not persist means the same
    // prompt again. Neither is worth surfacing.
  }
}

// ── FORGETTING ONE SCOPE ────────────────────────────────────────────────────
//
// BOTH OF THAT SCOPE'S KEYS GO, and no other scope is touched. That is the whole
// difference the v2 shape buys: clearing the signed-out scope on logout no
// longer destroys the account's own stored home, so signing back in brings the
// pin back with no second prompt.
//
// THE CONSENT GOES WITH IT, deliberately. Clearing a scope returns it to a
// genuine undecided state — keeping a 'declined' would leave a scope that can
// never be asked again and therefore can never recover its location, with no way
// to undo it. A settings screen will call exactly this, for exactly one account,
// and the account will be offered the choice again the next time it opens the
// map.
export async function clearHome(scope: string): Promise<void> {
  await purgeLegacyHome();
  const k = homeKeysFor(scope);
  try {
    console.log(`[HOME][KEY] clear ${k.home} + ${k.consent}`);
    await AsyncStorage.multiRemove([k.home, k.consent]);
  } catch {
    // A CLEAR THAT FAILS IS WORTH KNOWING ABOUT, unlike a save that fails: this
    // one is the difference between forgetting a location and only appearing to.
    // There is no user-facing surface for it, so it goes to the log.
    console.warn(`[HOME] could not clear the stored home view for ${scope}`);
  }
}

// ── THE FIX FOR A GPS THAT NEVER ANSWERS ────────────────────────────────────
//
// getCurrentPositionAsync HAS NO TIMEOUT AND CAN HANG FOREVER. A cold fix takes
// tens of seconds; hardware that is off or blocked at the OS level may never
// settle at all. A promise that never settles is not a rejection, so a catch
// cannot see it — which is why the button simply never appeared.
//
// SIX SECONDS IS LONG ENOUGH FOR A WARM FIX and short enough that nobody is left
// looking at a map with no control on it. A timeout is treated exactly as a
// refusal: fall back to the timezone, which was already computed.
export const LOCATION_TIMEOUT_MS = 6000;
