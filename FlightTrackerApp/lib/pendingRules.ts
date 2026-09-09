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
  // ── WHICH JOURNEY THIS LEG BELONGS TO, or null if nothing ties it to one ──
  //
  // AN UNPUBLISHED LEG IS STILL PART OF A TRIP. A person with a ticket is
  // taking that flight whether or not a provider has heard of it, so it belongs
  // in My Flights between the legs either side rather than in a list of its own.
  // This is what puts it there.
  //
  // ASSIGNED FROM THE BOOKING REFERENCE, NOT FROM GEOGRAPHY. Every leg of one
  // confirmation carries one reference, which is the same fact connection
  // detection now refuses to link across. A leg with no reference keeps null,
  // because nothing ties it to anything and guessing would be the coincidence
  // bug again in a new place.
  //
  // NULL IS ORDINARY, not a migration gap: a leg typed in by hand, or one from
  // an email that printed no reference, has no journey to join.
  tripId: string | null;
  // ── WHETHER THE AIRLINE STILL INTENDS TO FLY IT ─────────────────────────
  //
  // TWO REASONS A FLIGHT IS NOT IN THE PROVIDER'S SCHEDULE, and until now they
  // looked identical on screen: it has not been published yet, or it has been
  // cancelled. The first is a wait; the second is a trip that is not happening.
  // Showing both as "unpublished" told somebody with a cancelled flight to keep
  // waiting for it.
  //
  // THE SERVER SAYS WHICH. A cancellation email is classified as one and every
  // leg it names comes back carrying leg_status cancelled -- see the extractor.
  // Nothing here infers it; a leg is scheduled unless an email said otherwise.
  //
  // 'scheduled' IS THE DEFAULT AND IS FILLED IN ON READ, so every reader can
  // test the field rather than testing whether it exists. See getPending.
  legStatus: 'scheduled' | 'cancelled';
  // ── WHEN THE BOOKING SAID THIS LEG LANDS ────────────────────────────────
  //
  // NOBODY ELSE WILL EVER SAY IT. A provider record carries an arrival three
  // ways over -- actual, estimated, scheduled -- and an unpublished leg has
  // none of them, because no provider has heard of the flight. The email is
  // the only source there is, and it does print the arrival.
  //
  // IT IS WHAT MAKES A LAYOVER COMPUTABLE. The wait at a connection is this
  // leg's arrival to the next leg's departure; without this end the row can
  // only say that nobody has published one.
  //
  // A DATE OF ITS OWN, BECAUSE AN OVERNIGHT LEG LANDS ON ANOTHER DAY. Where
  // the email prints one date for the leg it is the departure's, and this is
  // null -- which the reader treats as "the same day" rather than inventing a
  // rollover. See pendingArrivalTs on the trip screen.
  //
  // BOTH NULL IS ORDINARY: a boarding pass or a cancellation notice prints no
  // arrival at all, and both are filled in on read so no reader has to ask
  // whether the field exists before asking what it says.
  arrivalTime: string | null;
  arrivalDate: string | null;
};

// TEN, AND IT IS A CAP ON DAILY SPEND. Each pending leg costs one provider unit
// a day until the airline publishes it; ten is ten units against roughly four
// thousand nine hundred a month, and more than ten unpublished bookings at
// once is not a traveller this app has met.
// ── NOT A LIMIT TODAY, FOR THE REASON THE OTHER TWO ARE NOT ────────────────
//
// TEN WAS FULL AND NOBODY COULD HAVE KNOWN. A booking of three legs where two
// are unpublished puts two here at once, and a few pulls of test mail filled it
// silently -- after which every further unpublished leg was refused and said
// nothing. That is how a real booking lost its second and third legs.
//
// IT MOVES WITH MAX_SAVED_FLIGHTS AND MAX_WATCHES_PER_DEVICE, which are now 500
// for the same reason. A limit here is cheaper than either of those, because a
// pending leg costs one provider lookup a day rather than a whole poll tier --
// so if a real ceiling ever comes back, this one should be the highest of the
// three rather than the lowest.
export const MAX_PENDING = 500;
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
  // OPTIONAL BECAUSE A SERVER THAT HAS NOT BEEN DEPLOYED YET DOES NOT SEND IT.
  // Absent reads as scheduled below, which is what every leg was before the
  // extractor learned to classify a cancellation.
  leg_status?: 'scheduled' | 'cancelled' | null;
  // OPTIONAL FOR THE SAME REASON, and absent on the emails that print no
  // arrival -- which the extractor is told never to invent one for.
  arrival_time?: string | null;
  arrival_date?: string | null;
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
    // Filled by the caller, which is the only place that knows what else this
    // booking already put on the device. See ownFlight and the Gmail pull.
    tripId: null,
    // ONLY THE ONE WORD IS BELIEVED. Anything else the wire carries -- a value
    // from a newer server, a null, a missing field -- is scheduled, because
    // "not known to be cancelled" and "scheduled" are the same statement and
    // the wrong way to be wrong here is to grey out a flight somebody is on.
    legStatus: leg.leg_status === 'cancelled' ? 'cancelled' : 'scheduled',
    // CARRIED AS PRINTED AND NOT VALIDATED HERE. The server has already
    // checked the shape of both and dropped either one it could not parse;
    // the screen that reads them checks again before doing arithmetic on
    // them, because that is where being wrong would show.
    arrivalTime: leg.arrival_time ?? null,
    arrivalDate: leg.arrival_date ?? null,
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

// ── HOW OFTEN ONE LEG IS WORTH ASKING ABOUT ────────────────────────────────
//
// DAILY IS RIGHT THREE WEEKS OUT AND WRONG THE DAY BEFORE. A leg that becomes
// available at nine in the morning used to wait for the next daily tick, which
// is fine for a flight in October and useless for one departing tomorrow.
//
// THE SHAPE MIRRORS THE POLLER'S TIERS rather than inventing a second idea of
// urgency, but the numbers are much longer, because these two things are not
// asking the same question. The poller asks "has anything about this flight
// changed", which is true every few minutes near departure. This asks "does
// this flight exist yet", which changes at most once and usually when an
// airline loads a schedule -- an event measured in hours, not minutes.
//
// NOTHING HERE IS FREE. Each retry is a lookup against the scarce provider, so
// a ceiling that is too eager spends the month's budget confirming an absence.
export const RETRY_INTERVALS_MS = {
  // More than a week out: once a day is plenty.
  far: 24 * 60 * 60 * 1000,
  // Inside a week: four times a day.
  week: 6 * 60 * 60 * 1000,
  // Inside two days: hourly. This is the case that was broken.
  soon: 60 * 60 * 1000,
  // On the day itself: every fifteen minutes. If it is not published by now it
  // probably never will be, but this is the last chance to catch it.
  today: 15 * 60 * 1000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function retryInterval(leg: PendingLeg, now: number): number {
  if (!ISO_DAY.test(leg.date)) return RETRY_INTERVALS_MS.far;
  // MIDNIGHT LOCAL ON THE DEPARTURE DATE, which is the only instant this leg
  // can name: it has a date and at best a printed time with no zone, so a true
  // departure instant does not exist here. Being a few hours out on the
  // boundary between two tiers costs one extra lookup, which is the right way
  // to be wrong.
  const depDay = new Date(`${leg.date}T00:00:00`).getTime();
  if (Number.isNaN(depDay)) return RETRY_INTERVALS_MS.far;
  const until = depDay - now;
  if (until <= DAY_MS) return RETRY_INTERVALS_MS.today;
  if (until <= 2 * DAY_MS) return RETRY_INTERVALS_MS.soon;
  if (until <= 7 * DAY_MS) return RETRY_INTERVALS_MS.week;
  return RETRY_INTERVALS_MS.far;
}

// True when this leg has waited out its own interval. A leg never tried is
// always due, which is what makes a freshly queued leg resolve on the next tick
// rather than tomorrow.
export function legDue(leg: PendingLeg, now: number): boolean {
  if (leg.lastTriedAt === null) return true;
  return now - leg.lastTriedAt >= retryInterval(leg, now);
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
export function retryBatch(
  list: PendingLeg[], todayKey: string, skipIds: ReadonlySet<string>,
  now: number, max = DAILY_RETRY_MAX,
): {
  kept: PendingLeg[]; dropped: PendingLeg[]; batch: PendingLeg[];
} {
  const dropped = list.filter(p => isPast(p, todayKey));
  const kept = list.filter(p => !isPast(p, todayKey));
  // EACH LEG ON ITS OWN CLOCK. The batch used to be "the ten least recently
  // tried", which spread one daily allowance across everything regardless of
  // urgency -- a leg departing tomorrow waited behind one departing in March.
  // Now a leg is a candidate only when its own interval has elapsed, and the
  // ceiling exists to bound one pass rather than to ration the day.
  // ── A CANCELLED LEG IS NEVER ASKED ABOUT AGAIN ──────────────────────────
  //
  // NOT DROPPED, NOT RETRIED. It stays in `kept` so it keeps its place in the
  // journey and can still be seen and forgotten by hand; it is simply never a
  // candidate for a lookup. Asking a provider to confirm a flight the airline
  // has already told the passenger is off spends a unit a day on an answer
  // nobody needs, and the one answer that could come back -- a schedule entry
  // for the cancelled flight -- would overwrite the cancellation with it.
  const batch = kept
    .filter(p => p.legStatus !== 'cancelled' && !skipIds.has(p.id) && legDue(p, now))
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
  // WHAT WOKE THE RETRY THAT RESOLVED IT. 'due' is the new one: a leg whose own
  // interval elapsed, which is every retry inside a week of departure. 'daily'
  // now means only the far tier's once-a-day sweep, so the two are worth
  // telling apart when reading these events back.
  how: 'pull' | 'daily' | 'mount' | 'due';
  delivered: boolean;
};

export const MAX_RESOLVED_EVENTS = 50;

export function appendResolved(events: PendingResolvedEvent[], ev: PendingResolvedEvent): PendingResolvedEvent[] {
  // One event per pending id: a second resolution of the same id (a pull and
  // a daily retry racing) must not become two notifications.
  if (events.some(e => e.id === ev.id)) return events;
  return [...events, ev].slice(-MAX_RESOLVED_EVENTS);
}
