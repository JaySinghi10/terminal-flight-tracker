// THE RULES OF A PENDING LEG, WITH NOTHING ATTACHED TO THEM.
//
// A pending leg is a flight the user has booked that the provider does not
// carry yet: the email gave a number, a date, two airports and a booking
// reference, and the lookup came back empty. It is NOT a SavedFlight and must
// never be dressed up as one -- a SavedFlight is a provider record, every reader
// of it assumes scheduled times and timezones exist, and saving one registers
// a server watch and schedules reminders off a departure time. A pending leg
// has none of that. It is the absence of a provider record, kept so the lookup
// can be tried again.
//
// THIS FILE IMPORTS NOTHING FROM REACT NATIVE, so its rules can be run under
// plain node by tools/test_pending_rules.mjs. The storage and the network live
// in lib/pending.ts beside it.

export type PendingLeg = {
  // makeFlightId(flightNumber, date) -- the MARKETING number's id, which is
  // what the email printed and what the user recognises.
  id: string;
  flightNumber: string;
  // The operator's number where the email printed one. Tried first: it is the
  // number the aircraft flies under and the one the landing feed knows.
  operatingFlightNumber: string | null;
  date: string;
  origin: string | null;
  originName: string | null;
  destination: string | null;
  destinationName: string | null;
  pnr: string | null;
  airline: string | null;
  departureTime: string | null;
  source: { subject: string | null; received: string | null };
  addedAt: number;
  lastTriedAt: number | null;
  tries: number;
};

// TEN, AND IT IS A CAP ON DAILY SPEND. Each pending leg costs one provider unit
// a day until the airline publishes it; ten is ten units against roughly four
// thousand nine hundred a month, and more than ten unpublished bookings at
// once is not a traveller this app has met.
export const MAX_PENDING = 10;
export const DAILY_RETRY_MAX = 10;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function makePendingId(flightNumber: string, date: string): string {
  // The same shape lib/storage.ts's makeFlightId produces, so a pending leg
  // and the SavedFlight it becomes share an id and neither can shadow the other.
  return `${(flightNumber || '').toUpperCase()}|${ISO_DAY.test(date) ? date : 'unknown'}`;
}

// What the Gmail pull hands over, in the endpoint's own field names.
export type ExtractedLeg = {
  flight_number: string;
  date: string;
  departure_time: string | null;
  origin: string | null;
  origin_name: string | null;
  destination: string | null;
  destination_name: string | null;
  airline: string | null;
  operated_by: string | null;
  operating_flight_number: string | null;
  pnr: string | null;
  source: { subject: string | null; received: string | null };
};

export function pendingFromLeg(leg: ExtractedLeg, now: number): PendingLeg {
  return {
    id: makePendingId(leg.flight_number, leg.date),
    flightNumber: leg.flight_number.toUpperCase(),
    operatingFlightNumber: leg.operating_flight_number ? leg.operating_flight_number.toUpperCase() : null,
    date: leg.date,
    origin: leg.origin,
    originName: leg.origin_name,
    destination: leg.destination,
    destinationName: leg.destination_name,
    pnr: leg.pnr,
    airline: leg.airline,
    departureTime: leg.departure_time,
    source: { subject: leg.source?.subject ?? null, received: leg.source?.received ?? null },
    addedAt: now,
    lastTriedAt: null,
    tries: 0,
  };
}

// A LEG WHOSE DATE HAS PASSED IS NOT PENDING, IT IS GONE. ISO days compare as
// strings. todayKey is the DEVICE's local day: a leg dated today is kept,
// because the flight may still be ahead, and one dated yesterday is dropped,
// because nothing the provider says about it now is worth a unit.
export function isPast(leg: PendingLeg, todayKey: string): boolean {
  return ISO_DAY.test(leg.date) && leg.date < todayKey;
}

// ONCE A DAY MEANS ONCE PER LOCAL CALENDAR DAY, not every 24 hours: the day
// rollover the store already notices is the boundary, so a phone opened at
// 23:50 and again at 00:10 retries twice, and one opened at 09:00 and 21:00
// retries once. Never having retried counts as due.
export function dueToday(lastRetryDayKey: string | null, todayKey: string): boolean {
  return lastRetryDayKey !== todayKey;
}

// THE OPERATING NUMBER FIRST, THEN THE MARKETING ONE, and never the same
// number twice. See the note at the top for why the operating one leads.
export function lookupOrder(leg: PendingLeg): string[] {
  const out: string[] = [];
  if (leg.operatingFlightNumber && leg.operatingFlightNumber !== leg.flightNumber) out.push(leg.operatingFlightNumber);
  out.push(leg.flightNumber);
  return out;
}

export type AddOutcome = { ok: true; pending: PendingLeg[] } | { ok: false; reason: 'dup' | 'limit' | 'past'; pending: PendingLeg[] };

// ADDING IS PURE OVER THE LIST. A duplicate id is refused rather than replaced,
// because the stored copy carries tries and lastTriedAt and a re-extracted leg
// carries neither. Past legs are refused at the door.
export function addToPending(list: PendingLeg[], leg: PendingLeg, todayKey: string): AddOutcome {
  if (isPast(leg, todayKey)) return { ok: false, reason: 'past', pending: list };
  if (list.some(p => p.id === leg.id)) return { ok: false, reason: 'dup', pending: list };
  if (list.length >= MAX_PENDING) return { ok: false, reason: 'limit', pending: list };
  return { ok: true, pending: [...list, leg] };
}

// The next batch to try: past legs dropped first, then the oldest-tried first
// so a leg that keeps missing cannot starve the one behind it.
export function retryBatch(list: PendingLeg[], todayKey: string, skipIds: ReadonlySet<string>, max = DAILY_RETRY_MAX): {
  kept: PendingLeg[]; dropped: PendingLeg[]; batch: PendingLeg[];
} {
  const dropped = list.filter(p => isPast(p, todayKey));
  const kept = list.filter(p => !isPast(p, todayKey));
  const batch = kept
    .filter(p => !skipIds.has(p.id))
    .sort((a, b) => (a.lastTriedAt ?? 0) - (b.lastTriedAt ?? 0))
    .slice(0, max);
  return { kept, dropped, batch };
}

// ── THE TRIGGER: A PENDING LEG BECAME A FLIGHT ──────────────────────────────
//
// A FLIGHT BOOKED MONTHS AGO BECOMING TRACKABLE IS THE FIRST NOTIFICATION THIS
// APP HAS THAT IS WORTH SENDING. Nothing sends it yet -- there is no push --
// so the event is RECORDED, durably and with delivered: false, and whatever
// delivers notifications later drains the undelivered ones. Building the
// trigger without the sending is deliberate: the fact is captured at the only
// moment it is knowable, and the sender can be written against real events.
export type PendingResolvedEvent = {
  id: string;                 // the pending leg's id
  flightNumber: string;       // as the email printed it
  savedFlightNumber: string;  // as the provider filed it -- differs on a codeshare
  savedId: string;            // the SavedFlight's id
  date: string;
  origin: string | null;
  destination: string | null;
  pnr: string | null;
  resolvedAt: number;
  how: 'pull' | 'daily' | 'mount';
  delivered: boolean;
};

export const MAX_RESOLVED_EVENTS = 50;

export function appendResolved(events: PendingResolvedEvent[], ev: PendingResolvedEvent): PendingResolvedEvent[] {
  // One event per pending id: a second resolution of the same id (a pull and
  // a daily retry racing) must not become two notifications.
  if (events.some(e => e.id === ev.id)) return events;
  return [...events, ev].slice(-MAX_RESOLVED_EVENTS);
}
