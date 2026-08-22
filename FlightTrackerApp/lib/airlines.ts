// IATA carrier code -> airline name.
//
// Deliberately hand-maintained rather than taken from the flight data provider,
// which is wrong about at least one carrier: it reports QP as "Starlight
// Airline". QP is Akasa Air. Nothing in this file may be sourced from the
// provider's `airline` field.
//
// Data only: no imports, no state, no network.
const AIRLINE_NAMES: Record<string, string> = {
  // ── India ──
  AI: 'Air India',
  IX: 'Air India Express',
  '6E': 'IndiGo',
  QP: 'Akasa Air',
  SG: 'SpiceJet',
  '9I': 'Alliance Air',
  S5: 'Star Air',

  // ── Gulf and Middle East ──
  EK: 'Emirates',
  EY: 'Etihad Airways',
  QR: 'Qatar Airways',
  FZ: 'flydubai',
  G9: 'Air Arabia',
  SV: 'Saudia',
  GF: 'Gulf Air',
  WY: 'Oman Air',
  KU: 'Kuwait Airways',

  // ── Asia ──
  SQ: 'Singapore Airlines',
  CX: 'Cathay Pacific',
  TG: 'Thai Airways',
  MH: 'Malaysia Airlines',
  NH: 'All Nippon Airways',
  JL: 'Japan Airlines',
  KE: 'Korean Air',
  OZ: 'Asiana Airlines',
  CA: 'Air China',
  MU: 'China Eastern',
  UL: 'SriLankan Airlines',
  BG: 'Biman Bangladesh Airlines',
  RA: 'Nepal Airlines',
  PK: 'Pakistan International Airlines',

  // ── Europe ──
  BA: 'British Airways',
  VS: 'Virgin Atlantic',
  LH: 'Lufthansa',
  AF: 'Air France',
  KL: 'KLM',
  LX: 'SWISS',
  IB: 'Iberia',
  AZ: 'ITA Airways',
  TK: 'Turkish Airlines',

  // ── Americas, Africa, Oceania ──
  AA: 'American Airlines',
  DL: 'Delta Air Lines',
  UA: 'United Airlines',
  AC: 'Air Canada',
  QF: 'Qantas',
  ET: 'Ethiopian Airlines',
  KQ: 'Kenya Airways',
  MS: 'EgyptAir',
};

// A carrier code is two characters with at least one letter: "AI", "6E", "S5".
// The remainder is the numeric part of the flight number.
const FLIGHT_NUMBER_RE = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4})$/;

// The airline for a flight number, or null when the code is not mapped.
// Never guesses and never falls back to the raw code: a two-letter prefix on its
// own tells the reader nothing they cannot already see in the flight number.
export function airlineFromFlightNumber(flightNumber: string | null | undefined): string | null {
  const cleaned = String(flightNumber ?? '').replace(/\s+/g, '').toUpperCase();
  const m = FLIGHT_NUMBER_RE.exec(cleaned);
  if (!m) return null;
  return AIRLINE_NAMES[m[1]] ?? null;
}
