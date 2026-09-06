// Independent corroboration for a flight the provider has lost.
//
// WHY THIS EXISTS: three flights, three lost arrivals, from three airports and
// three operators. EK500 reported its arrival three hours twenty-four minutes
// late; EK502 reported "Arrived" five hours EARLY, with an actual arrival in the
// future; 6E5071 was still "Approaching" four hours after it came down. That is
// not one airport or one ground handler -- it is the provider losing arrivals.
//
// ADS-B IS GENUINELY INDEPENDENT, which is the whole point. Aircraft broadcast
// their own position; volunteers receive it. A second COMMERCIAL provider would
// cost money and would likely share upstream feeds with the first, so it might
// agree with it while both were wrong.
//
// ── WHAT THIS IS ALLOWED TO DO ──────────────────────────────────────────────
//
// CORROBORATION ONLY. NEVER PRIMARY. It runs for one kind of record -- a 'stale'
// one, where the provider's own estimate expired and no arrival was reported --
// and its only possible outputs are "an aircraft matching this flight was on the
// ground at the destination" or silence.
//
// SILENCE IS NOT EVIDENCE OF ANYTHING. No match means no match: coverage is
// volunteer receivers and it is thin in places (Bengaluru showed five aircraft
// and none on the ground, against forty-three at JFK), and the callsign route
// below fails on whole airlines. A record with no corroboration stays exactly as
// stale as it was.
//
// AND IT NEVER SETS A LANDING. It does not write landedAt, it does not change
// effectiveStatus, and it does not put a time in the arrival slot. It adds one
// attributed sentence to a card that already says we have lost the flight.
import { airportByCode } from './airports';
import type { SavedFlight } from './storage';

// ── THE TWO SERVICES, BOTH FREE AND NEITHER NEEDING A KEY ───────────────────
//
// OpenSky's anonymous tier is 400 credits a day, bucketed by IP, at ten-second
// resolution -- ample for one call per lost flight and nowhere near enough to
// poll with, which is why this is not in the refresh loop.
const OPENSKY = 'https://opensky-network.org/api/states/all';

// adsbdb turns a tail number into the aircraft's permanent 24-bit address.
// OpenSky's own metadata API used to do this and now answers 410 Gone.
const ADSBDB = 'https://api.adsbdb.com/v0/aircraft/';

// A quarter of a degree around the field: about 25km, which covers the apron and
// the taxiways without reaching a neighbouring airport at any of ours.
const BOX_DEG = 0.22;

// A contact older than this is not evidence about now. Receivers drop out.
const CONTACT_FRESH_MS = 30 * 60 * 1000;

// ── IATA TO ICAO, FOR THE FALLBACK ONLY ─────────────────────────────────────
//
// THE CALLSIGN ROUTE IS THE WEAK ONE AND THIS TABLE IS THE LEAST OF ITS
// PROBLEMS. Even with the right prefix, many carriers fly callsigns that are NOT
// the commercial flight number: over Bengaluru, IndiGo showed IGO6432 and IGO556
// -- which do map -- alongside IGO403W, IGO5YT, IGO334V and IGO54DH, which map
// to nothing a passenger has ever seen. Airlines do that deliberately, to keep
// similar-sounding numbers apart on the radio.
//
// SO A CALLSIGN MATCH IS TRIED SECOND AND ITS FAILURE MEANS NOTHING. The
// registration route below is the one to trust.
const ICAO_PREFIX: Record<string, string> = {
  '6E': 'IGO', AI: 'AIC', IX: 'AXB', UK: 'VTI', SG: 'SEJ', QP: 'AKJ',
  BA: 'BAW', LH: 'DLH', AF: 'AFR', KL: 'KLM', LX: 'SWR', OS: 'AUA',
  EK: 'UAE', EY: 'ETD', QR: 'QTR', SV: 'SVA', GF: 'GFA',
  SQ: 'SIA', CX: 'CPA', TG: 'THA', MH: 'MAS', JL: 'JAL', NH: 'ANA',
  AA: 'AAL', DL: 'DAL', UA: 'UAL', WN: 'SWA', B6: 'JBU', AS: 'ASA',
  AC: 'ACA', TK: 'THY', SK: 'SAS', AY: 'FIN', IB: 'IBE', VS: 'VIR',
};

export type Corroboration =
  | { kind: 'onGround'; airport: string; atMs: number; via: 'registration' | 'callsign' }
  | { kind: 'none' };

type State = {
  icao24: string;
  callsign: string;
  onGround: boolean;
  lastContactMs: number;
};

function parseStates(body: unknown): State[] {
  const raw = (body as { states?: unknown[] } | null)?.states;
  if (!Array.isArray(raw)) return [];
  const out: State[] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const icao24 = String(row[0] ?? '').trim().toLowerCase();
    if (icao24 === '') continue;
    out.push({
      icao24,
      callsign: String(row[1] ?? '').trim().toUpperCase(),
      // Field 8. It means the position came from a SURFACE position report --
      // the aircraft is transmitting as being on the ground, which is the fact
      // we want and not an inference from altitude.
      onGround: row[8] === true,
      lastContactMs: (typeof row[4] === 'number' ? row[4] : 0) * 1000,
    });
  }
  return out;
}

// THE TAIL NUMBER'S PERMANENT ADDRESS, or null.
//
// COVERAGE IS REAL BUT NOT COMPLETE, measured: of five registrations taken off
// live records, three resolved (D-AINN, VT-IBO, VT-ISP) and two did not (A6-EXF,
// and VT-NCE -- which is the aircraft on the very flight that prompted all this).
// Newly delivered aircraft are the usual gap. A miss falls through to callsigns.
async function hexForRegistration(reg: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(ADSBDB + encodeURIComponent(reg.trim().toUpperCase()), { signal });
    if (!r.ok) return null;
    const j = await r.json() as { response?: { aircraft?: { mode_s?: string } } };
    const hex = j?.response?.aircraft?.mode_s;
    return typeof hex === 'string' && hex.trim() !== '' ? hex.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

// "6E5071" -> "IGO5071", or null when we cannot build one.
function callsignFor(flightNumber: string, airlineIata: string | null): string | null {
  const m = /^([0-9A-Z]{2})\s*0*([0-9]{1,4})$/.exec(flightNumber.trim().toUpperCase());
  if (m === null) return null;
  const prefix = ICAO_PREFIX[airlineIata ?? m[1]] ?? ICAO_PREFIX[m[1]];
  return prefix === undefined ? null : prefix + m[2];
}

/**
 * One OpenSky call, plus at most one registration lookup.
 *
 * ONLY CALL THIS FOR A RECORD effectiveStatus HAS ALREADY CALLED 'stale'. It is
 * cheap but not free, and on a healthy flight it answers a question nobody asked.
 */
export async function corroborate(
  f: SavedFlight,
  now: number,
  signal?: AbortSignal,
): Promise<Corroboration> {
  const dest = (f.to.iata || '').trim().toUpperCase();
  const place = dest === '' ? null : airportByCode(dest);
  if (place === null) return { kind: 'none' };

  // The registration route first: an aircraft's 24-bit address is permanent and
  // unambiguous, where a callsign is neither.
  const reg = (f.aircraftRegistration || '').trim();
  const hex = reg === '' ? null : await hexForRegistration(reg, signal);
  const wantCall = callsignFor(f.flightNumber, null);
  if (hex === null && wantCall === null) return { kind: 'none' };

  const url = `${OPENSKY}?lamin=${(place.lat - BOX_DEG).toFixed(4)}`
    + `&lomin=${(place.lon - BOX_DEG).toFixed(4)}`
    + `&lamax=${(place.lat + BOX_DEG).toFixed(4)}`
    + `&lomax=${(place.lon + BOX_DEG).toFixed(4)}`;

  let states: State[];
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return { kind: 'none' };
    states = parseStates(await r.json());
  } catch {
    return { kind: 'none' };
  }

  for (const s of states) {
    if (!s.onGround) continue;
    if (s.lastContactMs > 0 && now - s.lastContactMs > CONTACT_FRESH_MS) continue;
    const byHex = hex !== null && s.icao24 === hex;
    const byCall = wantCall !== null && s.callsign === wantCall;
    if (byHex || byCall) {
      return {
        kind: 'onGround',
        airport: dest,
        atMs: s.lastContactMs > 0 ? s.lastContactMs : now,
        via: byHex ? 'registration' : 'callsign',
      };
    }
  }
  return { kind: 'none' };
}

// ── ONE LOOKUP PER LOST FLIGHT PER SESSION ──────────────────────────────────
//
// A MODULE-LEVEL CACHE, DELIBERATELY. The card re-renders on every minute tick,
// and a lookup per tick would spend the whole anonymous budget on one flight
// before lunch. Keyed on the record id; a miss is cached too, because "nobody
// saw it" is an answer and asking again a minute later will not change it.
//
// IT DIES WITH THE PROCESS, which is the right lifetime: a fresh launch is
// exactly when it is worth asking again.
const seen = new Map<string, Corroboration>();
const inflight = new Map<string, Promise<Corroboration>>();

export function cachedCorroboration(id: string): Corroboration | undefined {
  return seen.get(id);
}

export function lookupOnce(
  f: SavedFlight,
  now: number,
): Promise<Corroboration> {
  const hit = seen.get(f.id);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(f.id);
  if (running !== undefined) return running;
  const p = corroborate(f, now)
    .then(r => { seen.set(f.id, r); inflight.delete(f.id); return r; })
    .catch(() => { inflight.delete(f.id); return { kind: 'none' } as Corroboration; });
  inflight.set(f.id, p);
  return p;
}
