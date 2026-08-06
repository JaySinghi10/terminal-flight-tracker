import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_KEY = 'savedFlights';
const KEY_PREFIX = 'savedFlights:';
const GUEST_KEY = `${KEY_PREFIX}guest`;
const BACKUP_PREFIX = 'backup:v1:';
const SCHEMA_VERSION = 4;
export const MAX_SAVED_FLIGHTS = 20;

export type SavedFlightEndpoint = {
  iata: string;
  airport: string;
  terminal: string | null;
  gate: string | null;
  scheduled: string;
  actual: string;
  estimated: string;
  delay: number | null;
  scheduledIso: string | null;
  estimatedIso: string | null;
  actualIso: string | null;
  timezone: string | null;
  checkinDesk: string | null;
  baggage: string | null;
  actualSource: string | null;
  estimatedSource: string | null;
};

export type SavedFlight = {
  id: string;
  flightNumber: string;
  airline: string;
  flightDate: string;
  status: string;
  from: SavedFlightEndpoint;
  to: SavedFlightEndpoint;
  aircraftModel: string | null;
  aircraftRegistration: string | null;
  savedAt: number;
  updatedAt: number;
  landedAt: number | null;
  schemaVersion: number;
};

export function makeFlightId(flightNumber: string) {
  return (flightNumber || '').toUpperCase();
}

function endpointFromApi(raw: any): SavedFlightEndpoint {
  return {
    iata: raw?.iata ?? '',
    airport: raw?.airport ?? '',
    terminal: raw?.terminal ?? null,
    gate: raw?.gate ?? null,
    scheduled: raw?.scheduled ?? 'N/A',
    actual: raw?.actual ?? 'N/A',
    estimated: raw?.estimated ?? 'N/A',
    delay: typeof raw?.delay === 'number' ? raw.delay : null,
    scheduledIso: raw?.scheduled_iso ?? null,
    estimatedIso: raw?.estimated_iso ?? null,
    actualIso: raw?.actual_iso ?? null,
    timezone: raw?.timezone ?? null,
    checkinDesk: raw?.checkin_desk ?? null,
    baggage: raw?.baggage ?? null,
    actualSource: raw?.actual_source ?? null,
    estimatedSource: raw?.estimated_source ?? null,
  };
}

// Maps a /flight/{number} response into a SavedFlight.
// savedAt is set to now here; saveFlight preserves the original on re-save.
export function savedFlightFromApi(data: any): SavedFlight {
  const now = Date.now();
  const flightNumber = (data?.flight_number ?? '').toUpperCase();
  const flightDate = data?.flight_date ?? 'unknown';
  const status = (data?.status ?? 'unknown').toLowerCase();
  return {
    id: makeFlightId(flightNumber),
    flightNumber,
    airline: data?.airline ?? '',
    flightDate,
    status,
    from: endpointFromApi(data?.departure),
    to: endpointFromApi(data?.arrival),
    aircraftModel: data?.aircraft_model ?? null,
    aircraftRegistration: data?.aircraft_registration ?? null,
    savedAt: now,
    updatedAt: now,
    landedAt: status === 'landed' ? now : null,
    schemaVersion: SCHEMA_VERSION,
  };
}

function isValid(f: any): f is SavedFlight {
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.id === 'string' &&
    f.id.length > 0 &&
    typeof f.flightNumber === 'string' &&
    typeof f.status === 'string' &&
    typeof f.updatedAt === 'number' &&
    !!f.from &&
    !!f.to &&
    typeof f.from.iata === 'string' &&
    typeof f.to.iata === 'string'
  );
}

// Local calendar day as a zero-padded "YYYY-MM-DD" string (lexicographically
// comparable). Uses getFullYear/getMonth/getDate — NOT toISOString (UTC).
function localDay(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Expired only once a landed flight's landing day is strictly in the past.
function isExpired(flight: SavedFlight, now: number): boolean {
  if (flight.status !== 'landed') return false;
  if (flight.landedAt == null) return false;
  return localDay(flight.landedAt) < localDay(now);
}

// Upgrades a record to the current schema in place, reporting whether anything
// changed.
// record is null (dropped) when the flight number is empty after normalization.
function normalizeRecord(flight: SavedFlight): { record: SavedFlight | null; changed: boolean } {
  let changed = false;

  const newId = makeFlightId(flight.flightNumber);
  if (flight.id !== newId) {
    flight.id = newId;
    changed = true;
  }

  const version = typeof flight.schemaVersion === 'number' ? flight.schemaVersion : 0;

  // v1 -> v2: grace-stamp past-day landed flights so they don't vanish on first launch.
  if (version < 2 && flight.landedAt == null) {
    flight.landedAt = flight.status === 'landed' ? Date.now() : null;
  }

  // v2 -> v3: default the new ISO/timezone fields to null (no countdown until refreshed).
  if (version < 3) {
    for (const ep of [flight.from, flight.to]) {
      if (ep) {
        ep.scheduledIso = ep.scheduledIso ?? null;
        ep.estimatedIso = ep.estimatedIso ?? null;
        ep.actualIso = ep.actualIso ?? null;
        ep.timezone = ep.timezone ?? null;
      }
    }
  }

  // v3 -> v4: default the estimated/source/check-in/belt and aircraft fields.
  // Existing records keep everything they already had; the new fields fill in on
  // the next refresh.
  if (version < 4) {
    for (const ep of [flight.from, flight.to]) {
      if (ep) {
        ep.estimated = ep.estimated ?? 'N/A';
        ep.checkinDesk = ep.checkinDesk ?? null;
        ep.baggage = ep.baggage ?? null;
        ep.actualSource = ep.actualSource ?? null;
        ep.estimatedSource = ep.estimatedSource ?? null;
      }
    }
    flight.aircraftModel = flight.aircraftModel ?? null;
    flight.aircraftRegistration = flight.aircraftRegistration ?? null;
  }

  if (version !== 4) {
    flight.schemaVersion = 4;
    changed = true;
  }

  if (!flight.flightNumber) return { record: null, changed: true };
  return { record: flight, changed };
}

function keyFor(email: string | null) {
  return email ? `${KEY_PREFIX}${email.trim().toLowerCase()}` : GUEST_KEY;
}

async function readKey(key: string): Promise<SavedFlight[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    let changed = false;
    const valid = parsed.filter(isValid);
    if (valid.length !== parsed.length) changed = true; // malformed record filtered → persist the cleanup

    let hadV1 = false;
    const normalized: SavedFlight[] = [];
    for (const rec of valid) {
      if ((rec.schemaVersion ?? 0) < 2) hadV1 = true; // only genuine pre-v2 records trigger a v1 backup
      const { record, changed: recChanged } = normalizeRecord(rec);
      if (recChanged) changed = true;
      if (record) normalized.push(record);
      else changed = true; // dropped empty flight number
    }

    const merged = mergeById(normalized, []);
    if (merged.length !== normalized.length) changed = true; // duplicate collapsed

    const now = Date.now();
    const kept = merged.filter(f => !isExpired(f, now));
    if (kept.length !== merged.length) changed = true; // expired pruned

    if (changed) {
      if (hadV1) await backupOnce(key, raw); // only back up buckets that were genuinely v1
      await writeKey(key, kept); // awaited so a later saveFlight write can't race and be overwritten
    }
    return kept;
  } catch {
    return [];
  }
}

async function writeKey(key: string, flights: SavedFlight[]) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(flights));
  } catch {
    // write failed; in-memory state stays correct for this session
  }
}

// One-time snapshot of a key's pre-migration payload, under a "backup:v1:"
// marker. Written only if no backup exists yet; never read or pruned.
// Best-effort — a failure must not block migration.
async function backupOnce(key: string, raw: string) {
  try {
    const backupKey = `${BACKUP_PREFIX}${key}`;
    if (await AsyncStorage.getItem(backupKey) === null) {
      await AsyncStorage.setItem(backupKey, raw);
    }
  } catch {
    // backup is best-effort
  }
}

// Dedupes by id. Newer updatedAt wins; the earliest savedAt is preserved.
// Result is sorted newest-saved first.
function mergeById(a: SavedFlight[], b: SavedFlight[]): SavedFlight[] {
  const map = new Map<string, SavedFlight>();
  for (const f of [...a, ...b]) {
    const prev = map.get(f.id);
    if (!prev) {
      map.set(f.id, f);
    } else if (f.updatedAt > prev.updatedAt) {
      map.set(f.id, { ...f, savedAt: Math.min(prev.savedAt, f.savedAt) });
    } else {
      map.set(f.id, { ...prev, savedAt: Math.min(prev.savedAt, f.savedAt) });
    }
  }
  return Array.from(map.values()).sort((x, y) => y.savedAt - x.savedAt);
}

// One-time move of the old global key into the guest bucket. Safe to call
// on every launch; it no-ops once the legacy key is gone.
export async function migrateLegacyIfNeeded(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed) ? parsed.filter(isValid) : [];
    if (valid.length > 0) {
      const guest = await readKey(GUEST_KEY);
      await writeKey(GUEST_KEY, mergeById(guest, valid).slice(0, MAX_SAVED_FLIGHTS));
    }
    await AsyncStorage.removeItem(LEGACY_KEY);
  } catch {
    // leave the legacy key in place; a later launch can retry
  }
}

// Folds guest-saved flights into the account bucket, then clears guest.
// Anything over the cap stays in guest rather than being dropped.
export async function mergeGuestInto(email: string): Promise<SavedFlight[]> {
  const guest = await readKey(GUEST_KEY);
  const account = await readKey(keyFor(email));
  if (guest.length === 0) return account;

  const merged = mergeById(account, guest);
  const kept = merged.slice(0, MAX_SAVED_FLIGHTS);
  const keptIds = new Set(kept.map(f => f.id));
  const leftovers = guest.filter(f => !keptIds.has(f.id));

  await writeKey(keyFor(email), kept);
  await writeKey(GUEST_KEY, leftovers);
  return kept;
}

export type SaveResult = { ok: boolean; reason?: 'limit'; flights: SavedFlight[] };

export async function getSavedFlights(email: string | null): Promise<SavedFlight[]> {
  return readKey(keyFor(email));
}

export async function saveFlight(email: string | null, flight: SavedFlight): Promise<SaveResult> {
  const flights = await readKey(keyFor(email));
  const existing = flights.findIndex(f => f.id === flight.id);

  if (existing >= 0) {
    const next = [...flights];
    const prev = flights[existing];
    const landedAt = flight.status === 'landed'
      ? (prev.landedAt ?? flight.landedAt ?? Date.now())
      : null;
    next[existing] = { ...flight, savedAt: prev.savedAt, landedAt };
    await writeKey(keyFor(email), next);
    return { ok: true, flights: next };
  }

  if (flights.length >= MAX_SAVED_FLIGHTS) {
    return { ok: false, reason: 'limit', flights };
  }

  const next = [flight, ...flights];
  await writeKey(keyFor(email), next);
  return { ok: true, flights: next };
}

export async function unsaveFlight(email: string | null, id: string): Promise<SavedFlight[]> {
  const flights = await readKey(keyFor(email));
  const next = flights.filter(f => f.id !== id);
  await writeKey(keyFor(email), next);
  return next;
}

// Updates a stored record after a fresh lookup. No-op if not saved.
export async function touchSavedFlight(email: string | null, flight: SavedFlight): Promise<SavedFlight[] | null> {
  const flights = await readKey(keyFor(email));
  const idx = flights.findIndex(f => f.id === flight.id);
  if (idx < 0) return null;
  const next = [...flights];
  const prev = flights[idx];
  const landedAt = flight.status === 'landed'
    ? (prev.landedAt ?? flight.landedAt ?? Date.now())
    : null;
  next[idx] = { ...flight, savedAt: prev.savedAt, landedAt };
  await writeKey(keyFor(email), next);
  return next;
}
