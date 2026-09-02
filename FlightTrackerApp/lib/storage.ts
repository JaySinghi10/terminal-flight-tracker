import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_KEY = 'savedFlights';
const KEY_PREFIX = 'savedFlights:';
const GUEST_KEY = `${KEY_PREFIX}guest`;
const BACKUP_PREFIX = 'backup:v1:';
const SCHEMA_VERSION = 11;
export const MAX_SAVED_FLIGHTS = 20;

export type SavedFlightEndpoint = {
  iata: string;
  airport: string;
  city: string | null;
  shortName: string | null;
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
  // WHEN THE USER ARCHIVED IT BY HAND, or null if they never did.
  //
  // The archive is otherwise derived: index.tsx calls a flight archived once its
  // arrival time is six hours past, which needs nothing stored because the
  // arrival time and the clock are both already here. That covers every flight
  // that actually flew, and none that has not — so archiving something early,
  // which is a decision rather than a fact, is the one thing the derivation
  // cannot express. Hence a field, and hence a migration.
  //
  // A TIMESTAMP rather than a boolean, for no cost: it answers "is it archived"
  // exactly as well, and it is the only record of when the decision was made.
  // Restoring clears it back to null, which returns the flight to the
  // derivation's judgement rather than to the opposite decision.
  archivedAt: number | null;
  // WHEN THE USER TURNED REMINDERS ON, or null if they never did.
  //
  // Device-owned, exactly as archivedAt is: the provider knows nothing about it
  // and never will, so a refresh must carry it forward rather than replace it.
  // See touchSavedFlight.
  //
  // A TIMESTAMP rather than a boolean, for the same reason and at the same
  // cost: it answers "are reminders on" as well as a flag would, and it is the
  // only record of when the decision was made. Turning them off clears it to
  // null rather than storing a false, so there is one representation of "off"
  // and it is the same one a record has before it is ever touched.
  //
  // The scheduled notifications themselves are NOT stored. Their identifiers
  // are derived from the flight's id, so the operating system's own list is the
  // record and this field only says whether that list should have anything in
  // it. See lib/reminders.ts reconcile().
  remindersSetAt: number | null;
  // WHICH JOURNEY THIS FLIGHT BELONGS TO, or null if it belongs to none.
  //
  // NULL MEANS THE USER IS ONLY WATCHING THIS FLIGHT. Non-null means they are
  // FLYING it, and the value names the journey it is part of. A trip is every
  // record sharing a tripId, and a single flight is a trip with one leg -- there
  // is no separate representation for the one-leg case, because a trip is a
  // grouping rather than a container.
  //
  // LEGS ARE ORDERED BY THEIR DEPARTURE INSTANT, never by a stored index. The
  // order is already a fact about the times on each record, so an index would be
  // a second copy of it that could disagree -- and would have to be rewritten
  // every time a leg was added, removed or rescheduled. This is the same reason
  // hasFlown and effectiveStatus derive rather than store.
  //
  // DEVICE-OWNED, exactly as archivedAt and remindersSetAt are: the provider
  // knows nothing about it and never will, so a refresh must carry it forward
  // rather than replace it. See touchSavedFlight.
  tripId: string | null;
  // THE PROVIDER'S OWN WORD for what the flight is doing, verbatim: "Boarding",
  // "GateClosed", "EnRoute", "Delayed". Null on a record saved before v10 and on
  // any response that omitted it.
  //
  // FOR DISPLAY ONLY. Nothing branches on this and nothing may start to. The
  // MAPPED `status` above stays the app's canonical vocabulary — sorting, the
  // countdowns, the archive rule and reminderTimes all key on it, and they key
  // on it precisely because it is a closed set of five words this app defines.
  // This field is an open set the provider defines and can extend without
  // telling us, which is exactly what makes it safe to print and unsafe to
  // decide with.
  //
  // It exists because that mapping is lossy in the one direction a traveller
  // cares about: Expected, CheckIn, Boarding, GateClosed and Delayed all become
  // "scheduled", so a flight at the gate and a flight an hour late wore the same
  // badge. The badge now reads this; everything else still reads `status`.
  //
  // NOT in touchSavedFlight's preserved-fields list, unlike archivedAt and
  // remindersSetAt: those are the user's decisions and a refresh must not
  // overwrite them, whereas this is provider data and a refresh SHOULD replace
  // it. The spread already does that.
  rawStatus: string | null;
  schemaVersion: number;
};

// A calendar day, exactly. Exported because index.tsx needs the same test and
// the two must never disagree about what counts as a date.
export const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The day part of an ISO value, or null. The *_iso fields carry the airport's
// LOCAL wall clock, so their first ten characters are the local calendar date —
// which is the same day the backend keys a dated board on.
function dayFromIso(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ''));
  return m ? m[1] : null;
}

// FLIGHT NUMBER AND DATE. AI2758 on the 29th and AI2758 on the 31st are two
// different flights and now hold two different records; keyed on the number
// alone, the second silently overwrote the first and a route row showed as
// saved on every date.
//
// A record with no date usable as a key is filed under "unknown" rather than
// given a guessed one. It stays openable and unsavable, and the first refresh
// that returns a real date re-keys it — see touchSavedFlight's targetId.
export function makeFlightId(flightNumber: string, flightDate: string | null | undefined) {
  const number = (flightNumber || '').toUpperCase();
  const day = ISO_DAY_RE.test(String(flightDate ?? '')) ? String(flightDate) : 'unknown';
  return `${number}|${day}`;
}

function endpointFromApi(raw: any): SavedFlightEndpoint {
  return {
    iata: raw?.iata ?? '',
    airport: raw?.airport ?? '',
    city: raw?.city ?? null,
    shortName: raw?.short_name ?? null,
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
// The oldest data age the backend could honestly report. Its flight cache TTL
// is five minutes and its board cache twelve hours, so a day is far beyond any
// real value and anything past it is a bug or a broken clock rather than old
// data.
const MAX_DATA_AGE_MS = 24 * 60 * 60 * 1000;

// WHEN THIS DATA WAS FETCHED, which is not when the response arrived.
//
// The backend caches a flight lookup for five minutes and reports how old the
// answer is in data_age_seconds. Reading the clock instead would stamp a cache
// hit as fresh, which is what made a row say "updated just now" over data that
// could be most of the TTL old — and it fed the countdown's freshness gate a
// number that was not true.
//
// THE FALLBACK IS THE POINT OF THE GUARD. A backend revision that predates the
// field, a response that omits it, a string, a NaN, a negative from a clock that
// stepped backwards, or an absurd value all land on `now` — which is exactly
// what this function did before the field existed. Nothing gets worse than it
// was; it only gets better when the number is trustworthy.
function fetchedAt(data: any, now: number): number {
  const age = data?.data_age_seconds;
  if (typeof age !== 'number' || !Number.isFinite(age)) return now;
  const ms = age * 1000;
  if (ms < 0 || ms > MAX_DATA_AGE_MS) return now;
  return now - ms;
}

export function savedFlightFromApi(data: any): SavedFlight {
  const now = Date.now();
  const flightNumber = (data?.flight_number ?? '').toUpperCase();
  const flightDate = data?.flight_date ?? 'unknown';
  const status = (data?.status ?? 'unknown').toLowerCase();
  return {
    id: makeFlightId(flightNumber, flightDate),
    flightNumber,
    airline: data?.airline ?? '',
    flightDate,
    status,
    from: endpointFromApi(data?.departure),
    to: endpointFromApi(data?.arrival),
    aircraftModel: data?.aircraft_model ?? null,
    aircraftRegistration: data?.aircraft_registration ?? null,
    // savedAt and landedAt stay on the clock: they are device-owned facts about
    // when the user saved this record and when we first saw it land, not claims
    // about how old the provider's data is.
    savedAt: now,
    updatedAt: fetchedAt(data, now),
    landedAt: status === 'landed' ? now : null,
    // A fresh lookup is never manually archived. touchSavedFlight carries the
    // stored value forward, so a refresh cannot silently un-archive anything.
    archivedAt: null,
    // Same: a lookup carries no reminder decision, and touchSavedFlight is what
    // stops one being lost.
    remindersSetAt: null,
    // Same again: a fresh lookup carries no ownership decision, and
    // touchSavedFlight is what stops one being lost.
    tripId: null,
    // Straight off the response, uppercase and spelling untouched, because the
    // badge matches it case-insensitively and nothing else reads it.
    rawStatus: data?.raw_status ?? null,
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

// Upgrades a record to the current schema in place, reporting whether anything
// changed.
// record is null (dropped) when the flight number is empty after normalization.
function normalizeRecord(flight: SavedFlight): { record: SavedFlight | null; changed: boolean } {
  let changed = false;

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

  // v4 -> v5: default the new city field. Existing records keep everything they
  // already had; the city fills in on the next refresh.
  if (version < 5) {
    for (const ep of [flight.from, flight.to]) {
      if (ep) {
        ep.city = ep.city ?? null;
      }
    }
  }

  // v5 -> v6: default the new shortName field. Existing records keep everything
  // they already had; the short name fills in on the next refresh.
  if (version < 6) {
    for (const ep of [flight.from, flight.to]) {
      if (ep) {
        ep.shortName = ep.shortName ?? null;
      }
    }
  }

  // v6 -> v7: the id gains the flight's date. Records saved under the old key
  // MUST survive, so the date is recovered rather than required:
  //
  //   flightDate is already a date   -> use it, no work to do
  //   flightDate is 'unknown'        -> read the day out of scheduledIso, which
  //                                     is the airport's own local date
  //   neither exists                 -> file it under 'unknown'
  //
  // No date is ever invented. A record that reaches the third case is one saved
  // before v3, when no ISO was stored at all; it keeps everything it has and
  // gains a real key the first time that flight is refreshed.
  //
  // Assigned in every branch, not only where a date is recovered: a record old
  // enough to predate the field carries flightDate undefined, which the type
  // says is a string and which the card would render as the word "undefined".
  if (version < 7 && !ISO_DAY_RE.test(String(flight.flightDate ?? ''))) {
    flight.flightDate =
      dayFromIso(flight.from?.scheduledIso ?? flight.to?.scheduledIso) ?? 'unknown';
    changed = true;
  }

  // Absent on every record written before v8. null is the correct value for all
  // of them: nothing was ever archived by hand, because there was no way to.
  if (version < 8 && flight.archivedAt === undefined) {
    flight.archivedAt = null;
    changed = true;
  }

  // Absent on every record written before v9. null is correct for all of them:
  // nobody had reminders on, because there was no way to turn them on.
  if (version < 9 && flight.remindersSetAt === undefined) {
    flight.remindersSetAt = null;
    changed = true;
  }

  // Absent on every record written before v10. null is correct for all of them:
  // the field was never stored, so there is nothing to recover. A null renders
  // exactly as the record does today and corrects itself on the next refresh.
  if (version < 10 && flight.rawStatus === undefined) {
    flight.rawStatus = null;
    changed = true;
  }

  // Absent on every record written before v11. null is correct for all of them:
  // nobody owned a flight, because there was no way to.
  if (version < 11 && flight.tripId === undefined) {
    flight.tripId = null;
    changed = true;
  }

  // AFTER the version blocks, not before them: v7 may have just supplied the
  // date the id is built from, and the id has to be derived from the record as
  // it now stands rather than as it arrived.
  const newId = makeFlightId(flight.flightNumber, flight.flightDate);
  if (flight.id !== newId) {
    flight.id = newId;
    changed = true;
  }

  if (version !== 11) {
    flight.schemaVersion = 11;
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

    // NOTHING IS PRUNED. A landed flight used to be deleted the day after it
    // landed; it is now archived instead — derived from its arrival time, in
    // app/index.tsx — and kept indefinitely. Deleting a record the user chose
    // to save, on a timer they never saw, was the wrong default.
    if (changed) {
      if (hadV1) await backupOnce(key, raw); // only back up buckets that were genuinely v1
      await writeKey(key, merged); // awaited so a later saveFlight write can't race and be overwritten
    }
    return merged;
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

// countsToward decides which records the cap sees. It exists because an
// archived flight is never refreshed, and MAX_SAVED_FLIGHTS is a limit on
// refresh cost rather than on how much a user may keep. The default counts
// everything, so a caller that does not care is unaffected.
export async function saveFlight(
  email: string | null,
  flight: SavedFlight,
  countsToward: (f: SavedFlight) => boolean = () => true,
): Promise<SaveResult> {
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

  if (flights.filter(countsToward).length >= MAX_SAVED_FLIGHTS) {
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

// Archives a flight by hand, or restores it. No-op if not saved.
//
// null restores, and restoring is not the opposite of archiving: it hands the
// flight back to the arrival-time rule rather than forcing it to stay out of
// the archive. A flight that genuinely flew goes straight back in, which is
// correct — the user can only overrule the rule early, not repeal it.
export async function setFlightArchived(
  email: string | null,
  id: string,
  archivedAt: number | null,
): Promise<SavedFlight[]> {
  const flights = await readKey(keyFor(email));
  const idx = flights.findIndex(f => f.id === id);
  if (idx < 0) return flights;
  const next = [...flights];
  next[idx] = { ...flights[idx], archivedAt };
  await writeKey(keyFor(email), next);
  return next;
}

// Turns reminders on or off for one flight. No-op if not saved.
//
// Mirrors setFlightArchived exactly, and deliberately: both write one
// device-owned field on one record and neither has anything to say about the
// notifications themselves. Scheduling is lib/reminders.ts's job, and keeping
// the two apart is what lets reconcile() rebuild the schedule from this field
// without this file knowing what a notification is.
export async function setFlightReminders(
  email: string | null,
  id: string,
  remindersSetAt: number | null,
): Promise<SavedFlight[]> {
  const flights = await readKey(keyFor(email));
  const idx = flights.findIndex(f => f.id === id);
  if (idx < 0) return flights;
  const next = [...flights];
  next[idx] = { ...flights[idx], remindersSetAt };
  await writeKey(keyFor(email), next);
  return next;
}

// Assigns a flight to a trip, or takes it out of one. No-op if not saved.
//
// Mirrors setFlightArchived and setFlightReminders line for line, and
// deliberately: all three write one device-owned field on one record, and none
// of them has anything to say about what that field means anywhere else.
// Ordering the legs, naming the journey and deciding what a trip looks like are
// all somebody else's job, and keeping them out of here is what lets this stay
// a one-field write that cannot be wrong.
//
// NULL GIVES THE FLIGHT BACK TO THE WATCHLIST WITHOUT DELETING IT. The record
// stays exactly where it is and keeps everything it had; only the claim that
// the user is flying it goes away.
export async function setFlightTrip(
  email: string | null,
  id: string,
  tripId: string | null,
): Promise<SavedFlight[]> {
  const flights = await readKey(keyFor(email));
  const idx = flights.findIndex(f => f.id === id);
  if (idx < 0) return flights;
  const next = [...flights];
  next[idx] = { ...flights[idx], tripId };
  await writeKey(keyFor(email), next);
  return next;
}

// Updates a stored record after a fresh lookup. No-op if not saved.
//
// targetId names the record to update, and defaults to the fresh record's own
// id. It differs in exactly one case: a record filed under "unknown" whose
// refresh came back with a real date. Passing the old id updates that record
// and lets it take the new id, which is how a dateless record recovers its
// date. If the new id collides with a record that already exists, the next
// read's mergeById collapses the two — correctly, since they are the same
// flight on the same day.
export async function touchSavedFlight(
  email: string | null,
  flight: SavedFlight,
  targetId: string = flight.id,
): Promise<SavedFlight[] | null> {
  const flights = await readKey(keyFor(email));
  const idx = flights.findIndex(f => f.id === targetId);
  if (idx < 0) return null;
  const next = [...flights];
  const prev = flights[idx];
  const landedAt = flight.status === 'landed'
    ? (prev.landedAt ?? flight.landedAt ?? Date.now())
    : null;
  // archivedAt, remindersSetAt and tripId join savedAt and landedAt as fields
  // the DEVICE owns and the provider knows nothing about. A refresh replaces
  // the flight's data, never the user's decision about it -- and tripId is the
  // costliest of the three to lose, since it is the only one that cannot be
  // reconstructed from anything else on the record.
  next[idx] = {
    ...flight,
    savedAt: prev.savedAt,
    landedAt,
    archivedAt: prev.archivedAt ?? null,
    remindersSetAt: prev.remindersSetAt ?? null,
    tripId: prev.tripId ?? null,
  };
  await writeKey(keyFor(email), next);
  return next;
}


// -- ROUTES THE USER HAS PUT ON THE MAP --------------------------------------
//
// A SEPARATE BUCKET FROM THE SAVED FLIGHTS, and the separation is the feature.
// The watchlist is what a user is following; this is what they asked to SEE on
// the globe, and the two are not the same list. Twenty saved flights drawn at
// once would be twenty arcs nobody chose; deriving one from the other would
// take the choice away in both directions -- saving a flight would draw it, and
// removing a drawing would unsave it.
//
// KEYED THE SAME WAY THE FLIGHTS ARE, per account, on the same guest fallback.
// A signed-in user's routes and a signed-out one's are different buckets, so
// signing out does not need a clear: the map re-reads under the guest key and
// finds whatever the guest had, which is usually nothing.
const MAP_ROUTE_PREFIX = 'mapRoutes:v1:';
const MAP_ROUTE_GUEST = `${MAP_ROUTE_PREFIX}guest`;

// THE SAME CAP AS THE WATCHLIST, for a different reason. There it is a limit on
// refresh cost; here it is a limit on how much can be drawn before the globe
// stops being readable. They are the same number by coincidence rather than by
// derivation, which is why it is its own constant.
export const MAX_MAP_ROUTES = 20;

// WHAT THE MAP NEEDS AND NOTHING MORE.
//
// CODES, NOT COORDINATES. The map already holds every airport's position -- it
// bakes all 1,223 into its page -- so storing a latitude here would be a second
// copy that could go stale against the dataset and could not be corrected by
// updating it.
//
// THE INSTANTS ARE RESOLVED AT ADD TIME AND FROZEN. They come from the record's
// ISO fields and its airports' timezones, which is a conversion this file has no
// business doing on every read; and a route on the map is a snapshot of a
// decision, not a live subscription. A flight that is refreshed while drawn
// keeps the arc it was drawn with until it is removed and added again.
//
// NULLABLE, because a pre-v3 record carries no ISO at all and a flight without
// a timezone cannot be placed on a clock. The map draws such a route as planned
// and puts no aircraft on it, which is the honest reading: the route is known,
// the schedule is not.
export type MapRoute = {
  // The flight's own id, so adding and removing key on the record rather than on
  // the pair of airports -- two flights on the same route on different days are
  // two routes, and one of them being on the map says nothing about the other.
  id: string;
  from: string;
  to: string;
  dep: number | null;
  arr: number | null;
};

function mapRouteKeyFor(email: string | null) {
  return email ? `${MAP_ROUTE_PREFIX}${email.trim().toLowerCase()}` : MAP_ROUTE_GUEST;
}

// The same defensiveness readKey applies to a flight. A malformed entry is
// dropped rather than thrown on: this is a drawing, and a bad row should cost
// one arc rather than the whole overlay.
function isRoute(r: any): r is MapRoute {
  return !!r
    && typeof r.id === 'string' && r.id !== ''
    && typeof r.from === 'string' && r.from !== ''
    && typeof r.to === 'string' && r.to !== ''
    && (r.dep === null || typeof r.dep === 'number')
    && (r.arr === null || typeof r.arr === 'number');
}

async function readRoutes(key: string): Promise<MapRoute[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isRoute);
    // Written back only when something was actually dropped, so an ordinary
    // read is a read.
    if (valid.length !== parsed.length) await writeRoutes(key, valid);
    return valid;
  } catch {
    return [];
  }
}

async function writeRoutes(key: string, routes: MapRoute[]) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(routes));
  } catch {
    // Same contract as writeKey: the in-memory list stays correct for this
    // session and the map keeps drawing what the user asked for.
  }
}

export type MapRouteResult = { ok: boolean; reason?: 'limit'; routes: MapRoute[] };

export async function getMapRoutes(email: string | null): Promise<MapRoute[]> {
  return readRoutes(mapRouteKeyFor(email));
}

// Adding a route already on the map REPLACES it rather than duplicating it, so
// re-adding is how a stale schedule gets refreshed.
export async function addMapRoute(
  email: string | null,
  route: MapRoute,
): Promise<MapRouteResult> {
  const key = mapRouteKeyFor(email);
  const routes = await readRoutes(key);
  const existing = routes.findIndex(r => r.id === route.id);
  if (existing >= 0) {
    const next = [...routes];
    next[existing] = route;
    await writeRoutes(key, next);
    return { ok: true, routes: next };
  }
  if (routes.length >= MAX_MAP_ROUTES) return { ok: false, reason: 'limit', routes };
  const next = [route, ...routes];
  await writeRoutes(key, next);
  return { ok: true, routes: next };
}

// -- WHETHER PAST ROUTES ARE DRAWN -----------------------------------------
//
// A PREFERENCE ABOUT THE MAP, NOT ABOUT A ROUTE, so it is its own key rather
// than a field on each entry. Hiding the arcs of flights that have already flown
// is one decision about the whole overlay; storing it per route would let the
// same question be answered twelve different ways and would need re-answering
// every time a route was added.
//
// SCOPED THE SAME WAY THE ROUTES ARE, per account with a guest fallback. What
// one user chose to see must not be what the next one finds.
//
// TRUE IS THE DEFAULT AND THE ABSENT KEY MEANS TRUE. The control HIDES; a
// missing preference must not silently take something off the map, and a user
// who has never touched it should see everything they added.
const MAP_PAST_PREFIX = 'mapPastShown:v1:';
const MAP_PAST_GUEST = `${MAP_PAST_PREFIX}guest`;

function mapPastKeyFor(email: string | null) {
  return email ? `${MAP_PAST_PREFIX}${email.trim().toLowerCase()}` : MAP_PAST_GUEST;
}

// ONLY THE EXACT STRING '0' HIDES. Anything else -- absent, malformed, a value
// from some future version of this key -- reads as shown, which is the side that
// cannot lose the user anything.
export async function getMapPastShown(email: string | null): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(mapPastKeyFor(email))) !== '0';
  } catch {
    return true;
  }
}

export async function setMapPastShown(email: string | null, on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(mapPastKeyFor(email), on ? '1' : '0');
  } catch {
    // Same contract as writeRoutes: the choice holds for this session.
  }
}

export async function removeMapRoute(
  email: string | null,
  id: string,
): Promise<MapRoute[]> {
  const key = mapRouteKeyFor(email);
  const next = (await readRoutes(key)).filter(r => r.id !== id);
  await writeRoutes(key, next);
  return next;
}
