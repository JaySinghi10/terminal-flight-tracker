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

// ── PERSISTENCE ─────────────────────────────────────────────────────────────
//
// TWO KEYS, AND THE SECOND IS NOT DERIVABLE FROM THE FIRST. "We have a home
// view" and "we have already asked for location" are different facts: a user who
// refused permission has no position but must never be asked again, and storing
// only the home would make that refusal look like a first run every launch.
const KEY_HOME = 'map.home.v1';
const KEY_ASKED = 'map.locationAsked.v1';

export async function loadHome(): Promise<HomeView | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_HOME);
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

export async function saveHome(h: HomeView): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_HOME, JSON.stringify(h));
  } catch {
    // A HOME THAT WILL NOT PERSIST IS NOT AN ERROR THE USER SHOULD SEE. The map
    // still opens correctly this session; it just recomputes next launch.
  }
}

export async function hasAskedLocation(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_ASKED)) !== null;
  } catch {
    // FAIL AS "ALREADY ASKED". If the flag cannot be read we cannot know we have
    // not asked, and asking twice is worse than never asking again.
    return true;
  }
}

export async function markAskedLocation(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_ASKED, '1');
  } catch {
    // Same reasoning as saveHome: nothing to report.
  }
}

// ── FORGETTING, WHICH IS A PRIVACY OPERATION AND NOT A TIDY-UP ──────────────
//
// BOTH KEYS GO: map.home.v1 and map.locationAsked.v1.
//
// THE HOME IS OBVIOUS — a stored `position` is the user's coordinates, and
// leaving it behind means signing out and handing over the phone still shows
// where they live.
//
// THE ASKED FLAG IS THE JUDGEMENT CALL, and it is cleared deliberately.
//
//   KEEPING IT would mean the next person to use this device is never asked, so
//   they get the timezone view forever with no way to change it. Worse, the
//   ORIGINAL user hits the same wall: log out once, log back in, and the feature
//   is permanently gone with no control anywhere in the app to bring it back. A
//   single reversible action would cause an irreversible degradation.
//
//   CLEARING IT returns the device to a genuine first-run state, which is what
//   logging out is supposed to mean. It does not reintroduce nagging: the flag
//   still guarantees at most one prompt per account, and an explicit logout is
//   an event the user caused rather than a repeated ask they did not.
//
// It also leaks nothing either way — the flag is a boolean about this device,
// not about the person. The deciding argument is recoverability, not privacy.
export async function clearHome(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([KEY_HOME, KEY_ASKED]);
  } catch {
    // A CLEAR THAT FAILS IS WORTH KNOWING ABOUT, unlike a save that fails: this
    // one is the difference between forgetting a location and only appearing to.
    // There is no user-facing surface for it, so it goes to the log.
    console.warn('[HOME] could not clear the stored home view');
  }
}
