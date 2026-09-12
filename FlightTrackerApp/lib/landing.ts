// The device's half of landing detection, and the only file that talks to the
// /landing endpoint.
//
// WHY A SECOND PROVIDER OWNS THIS. AeroDataBox lost the arrival on three
// flights out of three at Indian airports, in three different ways: EK500
// reported 3h24m late, EK502 reported "Arrived" five hours EARLY with an actual
// time in the future that then moved five times, and 6E5071 sat on
// "Approaching" for three and a half hours after it was on the ground. The same
// provider timed LH909 into Frankfurt to the minute -- touchdown 18:07, gate
// 18:14, both published within thirteen minutes. So the split is by JOB rather
// than by trust, and this is the job that moved to Flightradar24.
//
// THIS FILE DECIDES NOTHING. It knows when a flight is worth asking about and
// how to ask; what the answer MEANS is saved.tsx's business, in effectiveStatus
// and landedInstant, where every other status rule already lives.
import { zonedIsoToTs } from './time';
import type { SavedFlight } from './storage';

// ── THE FOUR OUTCOMES, AS THE SERVER SPELLS THEM ────────────────────────────
//
// KEPT APART ON PURPOSE, and the distinction that matters is 'unknown' against
// 'error'. The first means FR24 answered and has nothing -- which is what lets
// AeroDataBox's own arrival stand. The second means we never got an answer,
// which must NOT. Flattening the two would hand the landing decision straight
// back to the provider it was taken from.
export type LandingOutcome = 'landed' | 'pending' | 'unknown' | 'error';

export type LandingResult = {
  outcome: LandingOutcome;
  landedUtc: string | null;
  // ── READ FROM THE WIRE, CARRIED NO FURTHER, AND KEPT ON PURPOSE ───────────
  //
  // NOTHING CONSUMES THIS TODAY. The sweep in lib/saved.tsx hands
  // setFlightLanding three fields and this is not one of them, so a diversion
  // FR24 reported is parsed here and then dropped.
  //
  // IT IS NOT JUNK, AND DELETING IT WOULD COST MORE THAN IT SAVES. FR24 does
  // report diversions -- fr24.py fills diverted_to with the ICAO the aircraft
  // ACTUALLY reached whenever that differs from the one it was going to -- and
  // that is a fact no other source in this app has. The flight card says so
  // outright: search components/FlightCard.tsx for "NO DIVERSION AIRPORT, AND
  // THAT IS NOT AN OMISSION", which argues that a diverted flight must show its
  // origin alone because the DTO carries nowhere to show instead. This field is
  // the thing that would make that argument false.
  //
  // WHAT SURFACING IT WOULD ACTUALLY TAKE, measured rather than guessed:
  //
  //   * a field on SavedFlight, a default in the blank record, and a schema
  //     migration branch -- the last was version < 12
  //   * a fourth parameter on setFlightLanding
  //   * a preservation line in touchSavedFlight, without which an ordinary
  //     /flight refresh nulls it once a minute. That block exists because
  //     exactly this already happened to the other landing fields.
  //   * SOMETHING THAT CAN NAME AN ICAO. This is "VOMM", and every surface in
  //     this app speaks IATA or a city name. lib/adsb.ts's ICAO_PREFIX maps
  //     AIRLINES, not airports; there is no airport ICAO map on the device at
  //     all. So this needs a map shipped to the client or a translation added
  //     to the server's /landing response.
  //   * and then the card block above has to be re-argued and rewritten.
  //
  // THAT IS A FEATURE ACROSS FIVE FILES, NOT A LOOSE END. It is parked here,
  // parsed and typed, so the day it is wanted the wire-reading half is already
  // done and correct -- rather than deleted and rediscovered.
  divertedTo: string | null;
};

// ── WHEN A FLIGHT IS WORTH ASKING ABOUT ─────────────────────────────────────
//
// TWENTY MINUTES BEFORE THE ESTIMATE. Earlier is pure waste: FR24 has no
// landing either, and every call bills whether it answers or not. Twenty
// minutes covers an arrival that beats its own estimate, which is common.
export const LANDING_WINDOW_BEFORE_MS = 20 * 60 * 1000;

// EVERY FIVE MINUTES INSIDE THE WINDOW. The measured provider latency at
// Frankfurt was eight to thirteen minutes from touchdown, so a five-minute
// cadence is roughly the resolution the data itself supports; going faster
// would spend credits on a number that has not moved.
export const LANDING_CHECK_EVERY_MS = 5 * 60 * 1000;

// AND STOP THREE HOURS PAST THE ESTIMATE. A flight really can run long -- a
// hold, a diversion, a long taxi -- but a provider that has said nothing for
// three hours is not about to. Past this the record belongs to the 'stale'
// rule, which already exists and already says the only true thing available.
export const LANDING_WINDOW_AFTER_MS = 3 * 60 * 60 * 1000;

// A rough ceiling on the credits one arrival can cost: the window divided by
// the cadence, at up to two credits a call. Not enforced anywhere -- it is here
// so the number is written down next to the constants that produce it.
export const LANDING_WORST_CASE_CREDITS =
  Math.ceil((LANDING_WINDOW_BEFORE_MS + LANDING_WINDOW_AFTER_MS) / LANDING_CHECK_EVERY_MS) * 2;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Should this record be asked about right now?
 *
 * arrivalMs is passed in rather than derived here, for the same reason watch.ts
 * takes apiBase as a parameter: saved.tsx imports this module, so importing
 * arrivalTs back out of it would be a cycle.
 */
export function landingDue(f: SavedFlight, arrivalMs: number | null, now: number): boolean {
  // ALREADY ANSWERED, AND A LANDING IS IMMUTABLE. Touchdown does not move, so
  // once it is known this flight is finished with FR24 for ever.
  if (f.landedUtc !== null) return false;
  if (f.archivedAt !== null) return false;
  // The server needs a real date to build a search window, and makeFlightId
  // files a record with no usable date under the literal string "unknown" --
  // the same guard watch.ts applies, for the same reason.
  if (!ISO_DAY_RE.test(String(f.flightDate ?? ''))) return false;
  if (arrivalMs === null) return false;

  if (now < arrivalMs - LANDING_WINDOW_BEFORE_MS) return false;
  if (now > arrivalMs + LANDING_WINDOW_AFTER_MS) return false;

  const last = f.landingCheckedAt;
  return last === null || now - last >= LANDING_CHECK_EVERY_MS;
}

/**
 * Whether the landing window has closed on a record that never got an answer.
 *
 * NOT THE SAME QUESTION AS landingDue. This is what tells effectiveStatus that
 * waiting is over -- that no further check is coming, so AeroDataBox's own
 * arrival is the best thing left. Without it a flight whose window has expired
 * would sit refusing a landing for ever on the strength of a check that will
 * never run.
 */
export function landingWindowClosed(arrivalMs: number | null, now: number): boolean {
  if (arrivalMs === null) return true;
  return now > arrivalMs + LANDING_WINDOW_AFTER_MS;
}

// The departure as a UTC instant, which is what narrows the server's search
// window from about two days to about one leg. FR24 bills per returned record,
// so a wide window pays for every neighbouring leg it drags back.
function departureUtc(f: SavedFlight): string | null {
  const ts = zonedIsoToTs(
    f.from.actualIso ?? f.from.estimatedIso ?? f.from.scheduledIso, f.from.timezone);
  return ts === null ? null : new Date(ts).toISOString();
}

/**
 * One landing check. Never throws, and never reports a landing it did not get.
 *
 * A NETWORK FAILURE IS 'error', NOT 'unknown', and the difference is the whole
 * contract of this file. See the note on LandingOutcome.
 */
export async function checkLanding(apiBase: string, f: SavedFlight): Promise<LandingResult> {
  const params: string[] = [`date=${encodeURIComponent(f.flightDate)}`];
  const dest = (f.to.iata || '').trim().toUpperCase();
  if (dest !== '') params.push(`dest=${encodeURIComponent(dest)}`);
  const dep = departureUtc(f);
  if (dep !== null) params.push(`dep=${encodeURIComponent(dep)}`);
  const reg = (f.aircraftRegistration || '').trim();
  if (reg !== '') params.push(`reg=${encodeURIComponent(reg)}`);

  try {
    const r = await fetch(
      `${apiBase}/landing/${encodeURIComponent(f.flightNumber)}?${params.join('&')}`);
    if (!r.ok) return { outcome: 'error', landedUtc: null, divertedTo: null };
    const body = await r.json() as {
      outcome?: string; landed_utc?: string | null; diverted_to?: string | null;
    };
    const outcome = body?.outcome;
    if (outcome !== 'landed' && outcome !== 'pending'
      && outcome !== 'unknown' && outcome !== 'error') {
      // An envelope we do not recognise is not an answer. Reporting it as
      // 'unknown' would let AeroDataBox claim a landing on the strength of a
      // response we could not read.
      return { outcome: 'error', landedUtc: null, divertedTo: null };
    }
    return {
      outcome,
      // A LANDING TIME IS ONLY ACCEPTED ALONGSIDE A 'landed' OUTCOME. The server
      // already guarantees that pairing; not relying on it costs one condition.
      landedUtc: outcome === 'landed' && typeof body.landed_utc === 'string'
        ? body.landed_utc : null,
      divertedTo: typeof body.diverted_to === 'string' ? body.diverted_to : null,
    };
  } catch {
    return { outcome: 'error', landedUtc: null, divertedTo: null };
  }
}

/**
 * FR24 reports UTC with no zone marker: "2026-09-06T11:43:00".
 *
 * Date.parse would read that as LOCAL TIME on most engines, which on a device
 * in India is five and a half hours wrong -- in the direction that makes a
 * landing look like it has not happened yet. Hence the explicit Z.
 */
export function landedUtcToTs(iso: string | null): number | null {
  if (iso === null || iso === '') return null;
  const text = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
