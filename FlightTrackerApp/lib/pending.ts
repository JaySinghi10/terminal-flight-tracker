// THE PENDING LEGS: STORAGE AND THE LOOKUP. The rules are in lib/pendingRules.ts.
//
// ITS OWN KEY, KEYED THE WAY lib/storage.ts KEYS THE SAVED LIST -- one bucket
// per account and one for guest -- so a pending leg follows the account the
// email belongs to and never leaks between them. Deliberately NOT inside the
// saved list's own key: a pending leg is not a SavedFlight and the saved list's
// validator would drop it as malformed, which is correct.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { savedFlightFromApi, type SavedFlight } from './storage';
import {
  type PendingLeg, type PendingResolvedEvent, lookupOrder, appendResolved,
} from './pendingRules';

const PREFIX = 'pendingLegs:';
const RESOLVED_PREFIX = 'pendingResolved:';
const STAMP_PREFIX = 'pendingRetryDay:';

function bucket(email: string | null): string {
  return email ? email.trim().toLowerCase() : 'guest';
}

async function readList<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeList<T>(key: string, list: T[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(list));
  } catch {
    // The write failed; in-memory state stays right for this session, exactly
    // as lib/storage.ts treats the same failure.
  }
}

export async function getPending(email: string | null): Promise<PendingLeg[]> {
  const list = await readList<PendingLeg>(PREFIX + bucket(email));
  // ── EVERY LEG WRITTEN BEFORE tripId EXISTED HAS NO tripId AT ALL ──────────
  //
  // AND undefined IS NOT null, WHICH IS THE WHOLE BUG. The trip merge asks
  // `p.tripId === tripId` and the leftover list on Home asks
  // `p.tripId === null`; a leg carrying neither value fails both, so it
  // vanished from the app entirely rather than appearing in one place or the
  // other. Legs already in somebody's store were exactly that.
  //
  // NORMALISED ON READ RATHER THAN MIGRATED ON WRITE, because this store has no
  // schema version and one absent field does not justify inventing one. Every
  // caller reads through here.
  //
  // legStatus JOINS IT, for the same reason and by the same means: every leg
  // stored before the airline could say "cancelled" has no such field, and a
  // reader that has to ask whether the field EXISTS before asking what it says
  // is the shape that lost those legs in the first place. Scheduled is what
  // they all were.
  //
  // AND THE TWO ARRIVAL FIELDS JOIN THEM, on the same terms. Every leg queued
  // before the extractor returned an arrival has neither, and the trip screen
  // asks what they say rather than whether they are there.
  return list.map(p => ({
    ...p,
    tripId: p.tripId === undefined ? null : p.tripId,
    legStatus: p.legStatus === 'cancelled' ? 'cancelled' : 'scheduled',
    arrivalTime: p.arrivalTime ?? null,
    arrivalDate: p.arrivalDate ?? null,
  }));
}

export function setPending(email: string | null, list: PendingLeg[]): Promise<void> {
  return writeList(PREFIX + bucket(email), list);
}

// The local day the daily retry last ran for this account, or null.
export async function getRetryDay(email: string | null): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STAMP_PREFIX + bucket(email));
  } catch {
    return null;
  }
}

export async function setRetryDay(email: string | null, dayKey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STAMP_PREFIX + bucket(email), dayKey);
  } catch {
    // A missed stamp costs one extra retry tomorrow, nothing more.
  }
}

// ── THE LOOKUP ──────────────────────────────────────────────────────────────
//
// THE SAME REQUEST THE HOME SCREEN MAKES WHEN A LEG IS TAPPED: /flight with the
// date and the origin, so the instance that comes back is the day's and the
// leg's. Operating number first, marketing second, one unit each on a miss.
// Returns the SavedFlight the provider's answer builds, or null.
export async function tryResolve(
  apiBase: string,
  leg: PendingLeg,
  fetchImpl: typeof fetch = fetch,
): Promise<SavedFlight | null> {
  const q = [`date=${encodeURIComponent(leg.date)}`];
  if (leg.origin !== null) q.push(`origin=${encodeURIComponent(leg.origin)}`);
  for (const number of lookupOrder(leg)) {
    try {
      const resp = await fetchImpl(`${apiBase}/flight/${encodeURIComponent(number)}?${q.join('&')}`);
      const data = await resp.json();
      if (resp.ok && !data.error) return savedFlightFromApi(data);
    } catch {
      // A network failure on one number is not a reason to skip the other.
    }
  }
  return null;
}

// ── THE TRIGGER, RECORDED ───────────────────────────────────────────────────
export function getResolved(email: string | null): Promise<PendingResolvedEvent[]> {
  return readList<PendingResolvedEvent>(RESOLVED_PREFIX + bucket(email));
}

export async function recordResolved(
  email: string | null, leg: PendingLeg, saved: SavedFlight, how: PendingResolvedEvent['how'],
): Promise<void> {
  const events = await getResolved(email);
  await writeList(RESOLVED_PREFIX + bucket(email), appendResolved(events, {
    id: leg.id,
    flightNumber: leg.flightNumber,
    savedFlightNumber: saved.flightNumber,
    savedId: saved.id,
    date: leg.date,
    origin: leg.origin,
    destination: leg.destination,
    pnr: leg.pnr,
    resolvedAt: Date.now(),
    how,
    delivered: false,
  }));
}

// FOR THE SENDER THAT DOES NOT EXIST YET. Whatever delivers notifications
// reads these, sends, and marks them delivered; until then they accumulate,
// bounded, and nothing reads them.
export async function undeliveredResolved(email: string | null): Promise<PendingResolvedEvent[]> {
  return (await getResolved(email)).filter(e => !e.delivered);
}

export async function markResolvedDelivered(email: string | null, ids: string[]): Promise<void> {
  const set = new Set(ids);
  const events = await getResolved(email);
  await writeList(RESOLVED_PREFIX + bucket(email), events.map(e => set.has(e.id) ? { ...e, delivered: true } : e));
}
