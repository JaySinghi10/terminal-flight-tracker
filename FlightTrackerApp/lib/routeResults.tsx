// THE ROUTE RESULTS, LIFTED OUT OF THE SEARCH SCREEN.
//
// EVERYTHING HERE WAS app/(tabs)/search/index.tsx's AND IS UNCHANGED BUT FOR
// WHERE IT LIVES. The board, the sort, the three filters, the date, the picker
// options, the bought-in arrival times, the selection, and every derivation from
// the raw rows to the one flight the bubble shows: all of it used to be state
// and consts inside the Search component, which made it visible to that
// component and nothing else.
//
// WHY IT MOVED: the results were presented in a second screen for a while --
// a native sheet, a sibling route in the same Stack -- and a sibling cannot
// read a sibling's state, so a provider in the search route's own layout sat
// above both. The sheet is the map screen's own again (components/
// ResultsSheet.tsx), and the provider stays: the sheet and the screen still
// read one board and write one sort, and neither has to own the other.
//
// WHAT DID NOT MOVE, DELIBERATELY. The pickers -- the calendar, the anchored
// filter panels, the airport disambiguators -- are Modals with measured
// anchors, and they stay on the screen that draws them. The pill-label budget
// arithmetic stays with the pills. The natural-language parser stays with the
// field. Only what the LIST is made of is here.
//
// THE HOST. runRouteLookup and saveFromRoute report through the flight card
// host's channels -- setError, the error counter, the card's own setters -- and
// the host is a hook the search screen owns. It cannot be called from here, so
// the screen BINDS it: bindHost, once per render, into a ref this file reads at
// the moment of a fetch. The same shape as the gesture's dismissRef was, for the
// same reason -- the thing being called is declared somewhere this code cannot
// reach by scope.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { savedFlightFromApi, makeFlightId, ISO_DAY_RE } from './storage';
import { airlineFromFlightNumber } from './airlines';
import { useSaved, API_BASE, flightUrl, NO_TIME, SAVE_MSG } from './saved';
import { useToast } from './toast';
import { airportByCode, resolveAirportName } from './airports';
import type { Airport } from './airports';

// Decoration the provider puts on board names that the airport dataset does
// not carry: "Bengaluru Intl Airport", "Dubai Intl (Terminal 3)", "Khorog
// Airport,Tajikistan". Each was found on a real board, not imagined.
//
// "aeroport" is here because the DATED board does not speak the same language
// as the rolling one. The airport a rolling board calls "Ayodhya" a dated board
// calls "Aeroport Ayodkhya", and Delhi and Kolkata come back as "Deli" and
// "Kalkutta". The spellings themselves are aliases in the dataset; only the
// word "aeroport" belongs here, because it is decoration rather than a name.
const ROUTE_NAME_NOISE =
  /\b(intl|int'l|international|aeroport|airport|arpt|apt|airfield|aerodrome|domestic|terminal)\b/gi;

function routeTidyName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/,.*$/, '')          // "Khorog Airport,Tajikistan"
    .replace(/\(.*?\)/g, ' ')     // "Dubai Intl (Terminal 3)"
    .replace(ROUTE_NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The airport a board name refers to, or null.
//
// The whole tidied name first, then progressively shorter LEADING phrases. The
// provider usually leads with the city and follows it with the airport's own
// name — "Delhi Indira Gandhi", "Mumbai Chhatrapati Shivaji" — and the dataset
// indexes those two separately, never that concatenation. Narrowing to "Delhi"
// is what resolves them; without it the whole string simply misses.
//
// Only ever used to ask "is this row for the destination that was searched
// for", and a wrong answer means the row is left out rather than shown wrongly.
function routeResolveDestination(raw: string | null | undefined): Airport | null {
  const tidy = routeTidyName(raw);
  if (tidy.length < 3) return null;
  // Split on hyphens too, not only spaces. normalizeTerm already turns a hyphen
  // into a space when it builds the dataset's own haystack, so leaving them
  // joined here made the two disagree: "Denpasar-Bali Island" narrowed to
  // "Denpasar-Bali" and never to "Denpasar", which is what actually resolves.
  const words = tidy.split(/[\s-]+/).filter(w => w.length > 0);
  for (let n = words.length; n >= 1; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (candidate.length < 3) continue;
    const hit = resolveAirportName(candidate);
    if (hit !== null) return hit.airport;
  }
  return null;
}

// The backend fetches a 12-hour board whichever value it is sent, then filters
// down to this. At 6 half of what was already paid for was discarded, so 12 is
// strictly more for the same 2 units.
export const ROUTE_TODAY_HOURS = 12;

// Matches ROUTE_MAX_FUTURE_DAYS on the backend. Checked here too so an
// out-of-range date never reaches the network: a dated search costs 4 units.
export const ROUTE_MAX_DATE_DAYS = 60;

// ── WHERE THE RESULTS SHEET CAN REST ────────────────────────────────────────
//
// THREE HEIGHTS, MEASURED FROM THE SCREEN'S BOTTOM EDGE. The sheet is this
// app's own -- components/ResultsSheet.tsx -- drawn on the map screen under the
// tab bar, with its surface running to the screen's edge behind the bar and
// its content stopping above it. So the small height is the BAR'S INSET plus
// the head: the room the grabber takes, the green pill, and the air under it,
// so that at rest the sheet shows above the bar how the list is ordered and
// nothing of the controls row beneath. The head is the sum of the four numbers
// below, which are the head's own styles, declared here so the detent and the
// layout it is cut from cannot drift apart.
//
// THE MIDDLE AND THE LARGE are half and nine tenths of the window less 28.
// That 28 was UIKit's, measured when the sheet was UIKit's: on an 874 point
// window its middle detent settled at 423, so its maximum was 846. The custom
// sheet keeps the same two numbers so the two are the same heights on the
// same device -- 423 and 761 here.
//
// TWO POINTS SHORT OF THE HEAD, on purpose, so the head's own bottom air is
// what the cut takes rather than the top of the controls row. The pill itself
// ends twelve points above the cut either way.
//
// THE PILL IS FIFTY TALL: seventeen above and below a sixteen-point line. With
// the fourteen of air under it the head is 86, and the small detent cuts at 84.
export const SHEET_GRABBER_CLEARANCE = 22;
export const SHEET_PILL_PAD = 17;
export const SHEET_PILL_LINE = 16;
export const SHEET_HEAD_PAD = 14;
export const SHEET_HEAD_HEIGHT =
  SHEET_GRABBER_CLEARANCE + SHEET_PILL_PAD * 2 + SHEET_PILL_LINE + SHEET_HEAD_PAD;
const SHEET_SMALL_TOLERANCE = 2;
const SHEET_SMALL_HEIGHT = SHEET_HEAD_HEIGHT - SHEET_SMALL_TOLERANCE;
// WHAT THE WINDOW KEEPS FROM THE SHEET AT ITS LARGEST -- see the note above.
const SHEET_TOP_GAP = 28;
const SHEET_MIDDLE = 0.5;
const SHEET_LARGE = 0.9;

export type SheetGeometry = {
  // The three heights in points from the screen's bottom edge, smallest first:
  // what the shell springs between, and what the map screen's bubble clears.
  heights: number[];
};

export function sheetGeometry(winHeight: number, barInset: number): SheetGeometry {
  const max = Math.max(1, winHeight - SHEET_TOP_GAP);
  return {
    heights: [barInset + SHEET_SMALL_HEIGHT, SHEET_MIDDLE * max, SHEET_LARGE * max],
  };
}

// Local-only view controls. Nothing here re-fetches: every option reorders or
// hides rows already in state.
// 'latest' AND 'airline' ARE NEW, and both exist because the drawer names its
// orderings on pills rather than in a dropdown: Fastest, Earliest, Latest, by
// airline. The first two were already here under other names -- duration and
// departure -- and the other two are a reversed departure and an alphabetical
// carrier. 'arrival' stays: nothing on the new row selects it, but the sort
// itself is sound and deleting it would be deleting working code to tidy a list.
export const ROUTE_SORT_OPTIONS = ['departure', 'arrival', 'duration', 'latest', 'airline'] as const;
export type RouteSort = typeof ROUTE_SORT_OPTIONS[number];
export const ROUTE_SORT_DEFAULT: RouteSort = 'departure';

// The bare enum values are ambiguous on a pill: "departure" could as easily mean
// a filter as an ordering. Naming the quantity being sorted on removes the
// question.
export const ROUTE_SORT_LABELS: Record<RouteSort, string> = {
  departure: 'Earliest',
  arrival: 'arrival time',
  duration: 'Fastest',
  latest: 'Latest',
  airline: 'By airline',
};

// THE FOUR ON THE DRAWER, IN THE ORDER THEY ARE READ. 'arrival' is not among
// them: these are what a person chooses between, and the capsule shows one at a
// time rather than four at once.
export const ROUTE_SORT_PILLS: RouteSort[] = ['duration', 'departure', 'latest', 'airline'];

// WHAT THE SHUT CAPSULE READS. A whole phrase rather than the option's own word,
// because the capsule is a statement about the list under it -- "Fastest flight"
// -- where the four rows inside it are choices and take the short form. 'By
// airline' is the one that cannot take the noun: "By airline flight" is not
// English, and an ordering by carrier is not a claim about any one flight.
export const ROUTE_SORT_CAPSULE: Record<RouteSort, string> = {
  duration: 'Fastest flight',
  departure: 'Earliest flight',
  latest: 'Latest flight',
  airline: 'By airline',
  arrival: 'By arrival time',
};

// What the SORT PILL shows, which is not the same thing. The panel has room to
// spell it out; the pill has an 8-character cap, and the default shows the noun
// rather than its value because a pill reading "departure" would look like a
// filter. These are the panel's own words minus the redundant "time".
export const ROUTE_SORT_PILL: Record<RouteSort, string> = {
  departure: 'Sort',
  arrival: 'arrival',
  duration: 'duration',
  latest: 'latest',
  airline: 'airline',
};

// ── HOW LONG A FLIGHT TAKES, IN WORDS ───────────────────────────────────────
//
// THE BUBBLE'S SECOND LINE AND NOTHING ELSE. Hours and minutes, zero-padded on
// the minutes so two bubbles either side of an hour are the same width.
export const routeDurLabel = (ms: number | null): string | null => {
  if (ms === null) return null;
  const total = Math.round(ms / 60000);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
};

// Boundaries are on each airport's own wall clock, not the device's. Labelled in
// 24-hour time so the control reads in the same units as the rows.
// Chronological, so the filter panels and the group headings both read down the
// clock. bandForHour is boundary-based and does not depend on this order; every
// other use derives from it, so this line is the only place ordering lives.
export const ROUTE_BANDS = ['00:00-05:00', '05:00-12:00', '12:00-18:00', '18:00-00:00'] as const;
export type RouteBand = typeof ROUTE_BANDS[number];

export function bandForHour(h: number): RouteBand {
  if (h >= 5 && h < 12) return '05:00-12:00';
  if (h >= 12 && h < 18) return '12:00-18:00';
  if (h >= 18) return '18:00-00:00';
  return '00:00-05:00';
}

export const ALL_BANDS_ON: Record<RouteBand, boolean> =
  { '00:00-05:00': true, '05:00-12:00': true, '12:00-18:00': true, '18:00-00:00': true };

// A departure board is almost entirely "scheduled". Printing it on every row is
// a column of identical grey words that buries the one row a traveller actually
// needs to see. Everything else renders, including states this app does not yet
// know about: an unrecognised status is by definition not routine.
export const ROUTE_STATUS_ROUTINE = 'scheduled';

// Only the fields actually rendered. `airline` is deliberately absent: the
// provider mislabels at least one carrier (QP comes back as "Starlight
// Airline", not Akasa Air), and the two-letter prefix of flight_number is the
// reliable identifier. Omitting it here makes rendering it a type error.
export type RouteFlight = {
  flight_number: string;
  // Null when the provider named the destination without coding it. Rows that
  // reach the rendered list always have one: routeRecovered fills it in from
  // destination_airport, and a row whose name resolves to nothing never gets
  // there. The type stays honest about the wire.
  destination_iata: string | null;
  // The provider's own name for the destination. Present on every row; the only
  // identifier the null-code ones carry.
  destination_airport?: string | null;
  departure_scheduled: string;
  departure_scheduled_iso: string | null;
  // Null when the board carried no arrival time for this row at all. The
  // backend sends the key with a null value rather than omitting it.
  arrival_scheduled: string | null;
  arrival_scheduled_iso: string | null;
  status: string;
};

export type RouteResult = {
  origin: string;
  destination: string;
  window_hours: number;
  // The local calendar date the board was fetched for, or null for the rolling
  // window from now. window_hours does not apply to a dated search.
  date: string | null;
  count: number;
  total_found: number;
  truncated: boolean;
  flights: RouteFlight[];
  // Rows the backend could not match, because the board named the destination
  // without coding it. Candidates, not results: they are not in count,
  // total_found or truncated. Optional so a response from an older backend
  // still parses.
  unresolved?: RouteFlight[];
};

// Shown when a row has no arrival time of any kind. An em dash says "not known"
// in the width of a glyph; the "N/A" that used to arrive here said it in the
// width of a word and read as an error rather than as a gap. The font already
// renders this dash elsewhere in the file at MONO_BOLD.
export const ROUTE_NO_TIME = '—';

// HOW MANY MISSING ARRIVALS ARE WORTH BUYING, per search. Each one is a
// flight-number lookup at 2 units, so this caps a search's extra spend at 6.
//
// Counted from the boards already on disk rather than guessed: whole-airport
// departure boards carry no arrival time on 1.6% to 6.3% of rows (6/384, 6/375,
// 18/394, 10/159). A route search filters that to at most 25 rows for one
// destination, and of eighteen cached result envelopes seventeen had none at
// all and one had a single row. So the ordinary answer is zero, sometimes one.
//
// 3 covers every case observed across about 1,300 rows with room to spare. Past
// that the board is not merely unlucky, it is anomalous — feed missing on the
// provider's side, most likely — and that is precisely when quietly spending 20
// units chasing it is the wrong thing to do. The extra rows keep their dash.
const ROUTE_FILL_MAX = 3;

// The local calendar date a row DEPARTS on, read from its own ISO rather than
// from the board's date: an undated board is a rolling twelve hours, so its late
// rows belong to tomorrow. Module scope because the fill effect needs it before
// the component's own copy is in scope, and both must agree — the date decides
// WHICH instance of a flight number gets fetched.
export function routeDayOf(r: { departure_scheduled_iso: string | null }): string | null {
  const d = (r.departure_scheduled_iso ?? '').slice(0, 10);
  return ISO_DAY_RE.test(d) ? d : null;
}

// The ROUTE payload's *_iso fields carry a TRUE UTC offset, so Date.parse
// reads them correctly. That is NOT true of the *_iso fields on the flight DTO
// path: those carry a bogus +00:00 over local wall-clock digits and must go
// through zonedIsoToTs. The two paths deliberately do not share a helper for
// turning an ISO into an INSTANT, because one correct-looking swap would
// silently shift every value. clock24 is not an exception to that: it reads
// the digits as text and never computes an instant at all, which is exactly
// why one of it can serve both paths. Everything below parses through this
// one function.
const routeTs = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

// ── THE HOST ────────────────────────────────────────────────────────────────
//
// WHAT A FETCH NEEDS FROM THE SCREEN THAT OWNS THE FLIGHT CARD. Every field is
// one of useFlightCardHost's own setters or values, bound by the search screen
// on every render -- see bindHost. Typed as plainly as the calls here need, so
// a React setter is assignable without a cast.
export type RouteHost = {
  setError: (message: string) => void;
  setErrorCounter: (update: (c: number) => number) => void;
  setSaveError: (message: string) => void;
  setFlight: (value: null) => void;
  setFlightRecord: (value: null) => void;
  setChatResponse: (value: null) => void;
  setLoading: (busy: boolean) => void;
  showResult: () => void;
  loading: boolean;
};

function useRouteResultsState() {
  const { savedFlights, saveRecord } = useSaved();
  const { showToast } = useToast();

  // THE SCREEN'S CHANNELS, READ AT THE MOMENT OF A FETCH. A ref rather than
  // state: binding happens during the screen's render and must not cause one.
  const host = useRef<RouteHost | null>(null);
  const bindHost = (h: RouteHost) => { host.current = h; };

  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  // Arrival times bought one at a time for rows the board sent without one.
  // Keyed by makeFlightId, so it survives a new search: the same flight on the
  // same day is the same answer. See routeRows, which merges these in.
  const [routeFills, setRouteFills] = useState<Record<string, { text: string | null; iso: string | null }>>({});
  // Every key ever ATTEMPTED, successful or not. A ref rather than state
  // because writing it must not re-render, and because it has to outlive the
  // result it was populated from.
  const routeFillTried = useRef<Set<string>>(new Set());
  // null means Today, which sends no date parameter at all and so preserves the
  // existing relative-form search exactly.
  const [routeDate, setRouteDate] = useState<string | null>(null);
  // WHICH ROW THE BUBBLE IS SHOWING, as a key. See routeSelected for why it is
  // a key rather than a row, and for what null means.
  const [routeSelectedKey, setRouteSelectedKey] = useState<string | null>(null);
  const [routeSort, setRouteSort] = useState<RouteSort>(ROUTE_SORT_DEFAULT);
  // What each end of the current result COULD have meant. Length 1 is the
  // ordinary case and renders nothing; longer means the name did not choose
  // between airports, and the picker under the heading says which one won.
  const [routePick, setRoutePick] = useState<{ from: Airport[]; to: Airport[] } | null>(null);
  // The flight number currently being looked up and saved from a route row, or
  // null. A single slot, not a set: it doubles as the guard that stops a user
  // firing several 2-unit lookups by tapping down the list.
  const [routeSavingKey, setRouteSavingKey] = useState<string | null>(null);
  const [routeDepBands, setRouteDepBands] = useState<Record<RouteBand, boolean>>(ALL_BANDS_ON);
  const [routeArrBands, setRouteArrBands] = useState<Record<RouteBand, boolean>>(ALL_BANDS_ON);
  // Exclusions rather than inclusions: the airline list is derived per result
  // set, so an empty array means "all on" without having to seed state for
  // carriers we have not seen yet.
  const [routeAirlinesOff, setRouteAirlinesOff] = useState<string[]>([]);

  // ── THE SHEET, BETWEEN THE MAP SCREEN AND THE SHELL ───────────────────────
  //
  // WHETHER IT IS UP, WHETHER IT IS ON ITS WAY DOWN, AND AT WHICH DETENT. The
  // map screen presents by setting sheetPresented, which mounts the shell, and
  // asks to dismiss by setting sheetClosing; the shell springs down and, when
  // it has landed, clears both. A drag off the bottom sets sheetClosing from
  // inside the shell and ends the same way. The detent is written by the shell
  // on every release and read by the map screen for its bubble's floor.
  const [sheetPresented, setSheetPresented] = useState(false);
  const [sheetClosing, setSheetClosing] = useState(false);
  const [sheetDetent, setSheetDetent] = useState(0);
  // THE SHEET'S HEIGHTS ON THIS DEVICE, from the window and the tab bar's
  // inset -- this provider is inside the tab, so its bottom inset IS the bar's.
  // Hooks, not Dimensions.get, so rotation re-derives them. The shell springs
  // between these and the map screen's bubble clears them.
  const { height: sheetWinHeight } = useWindowDimensions();
  const sheetInsets = useSafeAreaInsets();
  const sheetHeights = sheetGeometry(sheetWinHeight, sheetInsets.bottom).heights;

  // THE HOST'S `loading`, FOR THE SHEET'S PICKERS. A date pick or an end pick
  // must not fire a second fetch over one in flight, and the flag that says so
  // is the host's. Read through the ref so the sheet needs nothing bound.
  const hostLoading = () => host.current?.loading ?? false;

  const runRouteLookup = async (origin: string, destination: string, day: string | null) => {
    const h = host.current;
    h?.setError("");
    h?.setSaveError("");
    // The three result kinds are mutually exclusive; a route answer replaces
    // whatever was on screen.
    h?.setFlight(null);
    h?.setChatResponse(null);
    h?.setFlightRecord(null);
    setRouteResult(null);
    h?.setLoading(true);
    try {
      // The date is omitted entirely for Today, not sent empty: the backend
      // treats absent and empty alike, but omitting keeps the URL identical to
      // what it has always been.
      const query = day === null
        ? `hours=${ROUTE_TODAY_HOURS}`
        : `hours=${ROUTE_TODAY_HOURS}&date=${day}`;
      const response = await fetch(`${API_BASE}/route/${origin}/${destination}?${query}`);
      const data = await response.json();

      // The envelope always carries an `error` key; non-null means failure.
      if (data.error || !response.ok) {
        h?.setError(data.error || "Something went wrong. Please try again.");
        h?.setErrorCounter(c => c + 1);
        return;
      }

      // Airline exclusions are keyed to one result set; a different route has a
      // different carrier list, so carrying them over would silently hide rows.
      setRouteAirlinesOff([]);
      setRouteResult(data as RouteResult);
      h?.showResult();
    } catch {
      h?.setError("Could not reach the server. Please check your connection and try again.");
      h?.setErrorCounter(c => c + 1);
    } finally {
      h?.setLoading(false);
    }
  };

  // Bookmark on a route row: look the flight up, then save it, without the card
  // ever appearing. It deliberately does NOT reuse runFlightLookup, which sets
  // `flight` and calls showResult() — that would unmount the route list and flash
  // the card open and shut. Same endpoint, same DTO mapping, no card.
  //
  // Costs 2 units per distinct flight. The backend caches a successful lookup for
  // five minutes, so re-tapping the same number inside that window is free.
  const saveFromRoute = async (flightNumber: string, date: string | null,
                              origin: string | null = null) => {
    if (routeSavingKey !== null) return;      // one at a time; the UI also disables the rest
    const h = host.current;
    setRouteSavingKey(flightNumber);
    h?.setError("");
    try {
      // Same date AND same origin the row was rendered from. Without the date
      // this stored TODAY's instance of the flight under a row the user picked
      // off a future board; without the origin it stored whichever leg of a tag
      // flight the provider offered first. Both persist, which is what makes
      // them worse here than on the card.
      const response = await fetch(flightUrl(flightNumber, date, origin));
      const data = await response.json();

      if (data.error || !response.ok) {
        h?.setError(data.error || "Something went wrong. Please try again.");
        h?.setErrorCounter(c => c + 1);
        return;
      }

      const record = savedFlightFromApi(data);
      // THE WHOLE SAVE IS saveRecord's, the undo check included — the window
      // belongs to the flight, not to the control that closed it. What is left
      // here is this path's own wording for the three endings, which is the
      // error channel and a shake where the card raises a toast.
      const outcome = await saveRecord(record);
      if (outcome.kind === 'restored') { showToast('restored'); return; }
      if (outcome.kind === 'limit') {
        h?.setError('watchlist limit reached — unsave one first');
        h?.setErrorCounter(c => c + 1);
        return;
      }
      // Reminders on by default, exactly as the card's bookmark does it.
      showToast(SAVE_MSG[outcome.remind]);
    } catch {
      h?.setError("Could not reach the server. Please check your connection and try again.");
      h?.setErrorCounter(c => c + 1);
    } finally {
      setRouteSavingKey(null);
    }
  };

  const routeDepartureTs = (r: RouteFlight): number => routeTs(r.departure_scheduled_iso) ?? NO_TIME;
  const routeArrivalTs = (r: RouteFlight): number => routeTs(r.arrival_scheduled_iso) ?? NO_TIME;

  // Null whenever either end is missing or the pair is nonsensical, so the row
  // simply renders no duration rather than a placeholder.
  const routeDurationMs = (r: RouteFlight): number | null => {
    const dep = routeTs(r.departure_scheduled_iso);
    const arr = routeTs(r.arrival_scheduled_iso);
    if (dep === null || arr === null || arr <= dep) return null;
    return arr - dep;
  };

  // The hour as it reads AT THE AIRPORT, taken from the wall-clock digits.
  // new Date(iso).getHours() would report the device's zone instead, which puts
  // a Bengaluru breakfast flight in the evening band for a user in London.
  const routeHourOf = (iso: string | null): number | null => {
    const m = /T(\d{2}):/.exec(iso ?? '');
    return m ? Number(m[1]) : null;
  };

  const routeDepBand = (r: RouteFlight): RouteBand | null => {
    const h = routeHourOf(r.departure_scheduled_iso);
    return h === null ? null : bandForHour(h);
  };

  const routeArrBand = (r: RouteFlight): RouteBand | null => {
    const h = routeHourOf(r.arrival_scheduled_iso);
    return h === null ? null : bandForHour(h);
  };

  // Unmapped carriers group under their two-letter prefix rather than being left
  // out of the filter. Excluding them would make those rows unfilterable, and
  // would let "turn every airline off" still leave flights on screen.
  const routeAirlineKey = (r: RouteFlight): string => {
    const name = airlineFromFlightNumber(r.flight_number);
    if (name !== null) return name;
    const m = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])/.exec(r.flight_number);
    return m ? m[1] : r.flight_number;
  };

  // Rows the backend named but could not code, resolved here — where the
  // airport dataset lives — and kept only when the name resolves to the
  // destination that was actually searched for. The code is filled in from the
  // resolution, so from this point on a recovered row is indistinguishable from
  // a matched one and every consumer below needs no special case.
  //
  // A name that resolves to nothing, or to somewhere else, is dropped: there
  // would be no honest way to show it in a list of flights to one destination.
  const routeRecovered: RouteFlight[] = routeResult === null
    ? []
    : (routeResult.unresolved ?? []).flatMap(r => {
      const hit = routeResolveDestination(r.destination_airport);
      return hit !== null && hit.iata === routeResult.destination
        ? [{ ...r, destination_iata: hit.iata }]
        : [];
    });

  // THE row set. Everything below counts, filters, sorts and groups this, so a
  // recovered row is counted exactly once, in exactly one group, like any other.
  //
  // The fills are merged HERE and nowhere else, which is the whole reason this
  // is one line rather than a patch at the render site. An arrival time is not
  // only something the row prints: routeDurationMs reads it, so it decides the
  // duration sort, the arrival sort and which row wears the fastest marker.
  // Filling it in at the Text would leave a row showing a time while every
  // derivation above still treated it as having none — a row sorted last for
  // want of a value it is visibly displaying. Merging at the source means the
  // standing checks hold against exactly what is on screen.
  //
  // The visible consequence, and it is intended: a row that gains a time can
  // move, and can take the fastest marker, a moment after the list first
  // appears. That is the list becoming correct, not the list twitching.
  const routeRows: RouteFlight[] = routeResult === null
    ? []
    : [...routeResult.flights, ...routeRecovered].map(r => {
        if (r.arrival_scheduled_iso !== null || r.arrival_scheduled !== null) return r;
        const fill = routeFills[makeFlightId(r.flight_number, routeDayOf(r))];
        return fill === undefined
          ? r
          : { ...r, arrival_scheduled: fill.text, arrival_scheduled_iso: fill.iso };
      });

  // AFTER the list is on screen, never before it.
  //
  // The effect runs on commit, so the rows are already rendered with their
  // dashes and nothing is held up waiting for a network call. Each answer
  // arrives as its own setState and swaps one row's dash for a time in place.
  //
  // Keyed on number AND date, so a dated search fills the instance it is
  // actually showing, and a flight looked up once is never looked up again this
  // session — routeFillTried is a ref, so it outlives every re-render and every
  // new search. The key goes in BEFORE the request rather than after it, which
  // is what makes a failure final: a row whose fetch fails keeps its dash, and
  // nothing retries it. No error is surfaced either. The list was already
  // telling the truth; this only ever improves on it.
  useEffect(() => {
    if (routeResult === null) return;
    const targets: RouteFlight[] = [];
    for (const r of [...routeResult.flights, ...routeRecovered]) {
      // Already has one. Nothing to buy.
      if (r.arrival_scheduled_iso !== null || r.arrival_scheduled !== null) continue;
      if (routeFillTried.current.has(makeFlightId(r.flight_number, routeDayOf(r)))) continue;
      targets.push(r);
      if (targets.length === ROUTE_FILL_MAX) break;
    }
    if (targets.length === 0) return;

    let cancelled = false;
    (async () => {
      // One at a time. Three parallel requests would arrive as three renders in
      // the same frame anyway, and serialising keeps the burst off the backend.
      for (const r of targets) {
        if (cancelled) return;
        const day = routeDayOf(r);
        const key = makeFlightId(r.flight_number, day);
        routeFillTried.current.add(key);
        try {
          // The board's own origin. Every row here departs from it, and without
          // it a tag flight fills this row with the other leg's arrival time —
          // a wrong number in a cell that looks exactly like a right one.
          const res = await fetch(flightUrl(r.flight_number, day, routeResult.origin));
          const data = await res.json();
          if (!res.ok || data.error) continue;
          const text = data.arrival_scheduled ?? null;
          const iso = data.arrival_scheduled_iso ?? null;
          // The endpoint answered but has no arrival either. Nothing to write,
          // and the key is already spent, so this settles the row for good.
          if (text === null && iso === null) continue;
          if (cancelled) return;
          setRouteFills(prev => ({ ...prev, [key]: { text, iso } }));
        } catch {
          // Quiet on purpose. The row keeps its dash.
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeResult]);

  // What the envelope's own totals become once recoveries are included. The
  // backend's count and total_found describe `flights` alone, by design.
  const routeShown = routeRows.length;
  const routeFound = routeResult === null
    ? 0
    : routeResult.total_found + routeRecovered.length;

  // Only carriers actually present in this result set.
  const routeAirlineOptions = routeResult
    ? Array.from(new Set(routeRows.map(routeAirlineKey))).sort()
    : [];

  const routeRowKey = (r: RouteFlight) => `${r.flight_number}-${r.departure_scheduled_iso ?? ''}`;

  // Missing values resolve to NO_TIME in every mode, so unparseable rows sort
  // last whichever key is active.
  // ASCENDING ALWAYS, so a reversed ordering is a negated key rather than a
  // second comparator. NO_TIME is the sentinel a row with no readable time
  // takes, and negating it would promote exactly those rows to the top of the
  // latest list -- so an unreadable row keeps the sentinel and stays last.
  const routeSortKey = (r: RouteFlight): number =>
    routeSort === 'arrival' ? routeArrivalTs(r)
      : routeSort === 'duration' ? (routeDurationMs(r) ?? NO_TIME)
        : routeSort === 'latest'
          ? (routeDepartureTs(r) === NO_TIME ? NO_TIME : -routeDepartureTs(r))
          : routeDepartureTs(r);

  // BY CARRIER, THEN BY THE CLOCK. Sorting on a name alone leaves one airline's
  // flights in whatever order the provider sent them, which reads as no order at
  // all. The comparator below is the only one that is not a single number, so it
  // is applied separately -- see routeSorted.
  const routeAirlineOf = (r: RouteFlight): string =>
    airlineFromFlightNumber(r.flight_number) ?? r.flight_number.slice(0, 2);

  // One predicate for both the real filter and the option counts, so a count can
  // never disagree with what enabling the option actually produces. `skip` names
  // the dimension to ignore.
  //
  // A row whose band cannot be determined is never hidden by that filter: the
  // app has no grounds to place it in a band, and hiding data it cannot classify
  // is worse than showing it.
  const routePasses = (r: RouteFlight, skip: 'dep' | 'arr' | 'air' | null) => {
    if (skip !== 'dep') {
      const b = routeDepBand(r);
      if (b !== null && !routeDepBands[b]) return false;
    }
    if (skip !== 'arr') {
      const b = routeArrBand(r);
      if (b !== null && !routeArrBands[b]) return false;
    }
    if (skip !== 'air' && routeAirlinesOff.includes(routeAirlineKey(r))) return false;
    return true;
  };

  const routeVisible = routeResult
    ? routeRows.filter(r => routePasses(r, null))
    : [];

  // Counted with the OTHER filters applied but not this one, so the number says
  // what enabling the option would give you — and does not collapse to zero the
  // moment you switch the option off.
  const routeCountBy = (skip: 'dep' | 'arr' | 'air', keyOf: (r: RouteFlight) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of routeRows) {
      if (!routePasses(r, skip)) continue;
      const k = keyOf(r);
      if (k !== null) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const routeDepCounts = routeCountBy('dep', routeDepBand);
  const routeArrCounts = routeCountBy('arr', routeArrBand);
  const routeAirCounts = routeCountBy('air', routeAirlineKey);

  const routeSorted = routeSort === 'airline'
    ? [...routeVisible].sort((a, b) => {
      const n = routeAirlineOf(a).localeCompare(routeAirlineOf(b));
      return n !== 0 ? n : routeDepartureTs(a) - routeDepartureTs(b);
    })
    : [...routeVisible].sort((a, b) => routeSortKey(a) - routeSortKey(b));
  const routeHiddenCount = routeRows.length - routeVisible.length;

  // Computed over the FILTERED set, so the marker always describes what is
  // currently on screen. Null when fewer than two rows are timed — one row has
  // nothing to be faster than — or when every duration is identical, where
  // "fastest" would describe the whole list and so describe nothing.
  //
  // A TIE no longer suppresses it. Ties are ordinary: five rows share 170m on a
  // typical BLR-DEL board, and a tie on the minimum used to blank the marker
  // outright — measured at 24% of two-row and 16% of three-row filtered subsets.
  // Rows sharing the shortest time are genuinely the best available, so every
  // one of them keeps its in-row tag and the first in the CURRENT sort order
  // takes the pin. `timed` is built from routeSorted, so "first" means first as
  // rendered, and the pin cannot jump between renders.
  const routeFastest = (() => {
    const timed = routeSorted
      .map(r => ({ key: routeRowKey(r), ms: routeDurationMs(r) }))
      .filter((v): v is { key: string; ms: number } => v.ms !== null);
    if (timed.length < 2) return null;
    const min = Math.min(...timed.map(v => v.ms));
    if (min === Math.max(...timed.map(v => v.ms))) return null;
    const keys = timed.filter(v => v.ms === min).map(v => v.key);
    return { keys: new Set(keys), pin: keys[0] };
  })();

  // Every row achieving the shortest time carries the tag; exactly one of them
  // is lifted into the pin.
  const routeFastestKeys = routeFastest?.keys ?? new Set<string>();
  const routeFastestKey = routeFastest?.pin ?? null;

  // Lifted OUT of the list and pinned above it, so it appears exactly once
  // rather than twice. Never under a duration sort: it is already the first row
  // there, and pinning would buy a heading and a duplicate.
  const routePinned = routeSort !== 'duration' && routeFastestKey !== null
    ? routeSorted.find(r => routeRowKey(r) === routeFastestKey) ?? null
    : null;

  // Everything the list below renders. The groups and their counts both derive
  // from this, so a heading can never claim a row that was lifted out.
  const routeListed = routePinned === null
    ? routeSorted
    : routeSorted.filter(r => routeRowKey(r) !== routeFastestKey);

  // WHICH ROW IS ACTUALLY LAST, as a key rather than an index.
  //
  // routeRowKey rather than object identity, because the row objects are rebuilt
  // by every derivation above and identity does not survive that.
  //
  // THE END OF routeSorted, NOT routeListed. The sheet draws the flat sorted
  // list with nothing lifted out of it, so the last row drawn is the last row
  // sorted. routePinned and routeListed stay for the bubble's default
  // selection, which still prefers the fastest.
  const routeLastKey = routeSorted.length > 0
    ? routeRowKey(routeSorted[routeSorted.length - 1])
    : null;

  // ── WHICH FLIGHT THE BUBBLE IS SHOWING ────────────────────────────────────
  //
  // A KEY RATHER THAN A ROW, because the rows are rebuilt on every filter and
  // sort change and holding one would pin a stale object. The key survives all
  // of that and resolves to whatever the current list says it is.
  //
  // NULL MEANS THE DEFAULT, AND THE DEFAULT IS THE FASTEST. Not the first row:
  // the first row depends on the ordering, so the bubble would change flights
  // when somebody sorted, which is not what sorting means.
  const routeSelected = (() => {
    if (routeListed.length === 0 && routePinned === null) return null;
    const all = routePinned === null ? routeListed : [routePinned, ...routeListed];
    if (routeSelectedKey !== null) {
      const hit = all.find(r => routeRowKey(r) === routeSelectedKey);
      if (hit !== undefined) return hit;
    }
    const fastest = routeFastestKey === null
      ? undefined
      : all.find(r => routeRowKey(r) === routeFastestKey);
    return fastest ?? all[0] ?? null;
  })();

  // THE WORD FOR WHY THIS ONE. The list only ever computes one distinction of
  // its own -- which rows are fastest -- so that is what is said when it applies,
  // and otherwise the ordering the person chose is the honest answer to "why is
  // this the one on top".
  const routeReason = routeSelected === null
    ? ''
    : routeFastestKeys.has(routeRowKey(routeSelected)) || routeRowKey(routeSelected) === routeFastestKey
      ? 'Fastest'
      : ROUTE_SORT_LABELS[routeSort];

  const routeSelectedDur = routeSelected === null ? null : routeDurationMs(routeSelected);

  // Which filters are actually narrowing the list, for the all-hidden message.
  const routeActiveFilters = [
    ROUTE_BANDS.every(b => routeDepBands[b]) ? null : 'departure time',
    ROUTE_BANDS.every(b => routeArrBands[b]) ? null : 'arrival time',
    routeAirlinesOff.length === 0 ? null : 'airline',
  ].filter((v): v is string => v !== null);

  // Everything-on for the filters, and sort back to its default.
  const routeFiltersDirty =
    !ROUTE_BANDS.every(b => routeDepBands[b])
    || !ROUTE_BANDS.every(b => routeArrBands[b])
    || routeAirlinesOff.length > 0;

  const routeAirOn = routeAirlineOptions.filter(a => !routeAirlinesOff.includes(a));

  const routeControlsDirty =
    routeFiltersDirty || routeSort !== ROUTE_SORT_DEFAULT || routeDate !== null;

  // The view-control half of a reset, without the re-fetch. Both search paths
  // call it so that "a search typed from scratch starts clean" is one rule in
  // one place rather than two lists that drift.
  const routeResetControls_forSearch = () => {
    setRouteDepBands(ALL_BANDS_ON);
    setRouteArrBands(ALL_BANDS_ON);
    setRouteSort(ROUTE_SORT_DEFAULT);
  };

  // Clears the view controls AND the date. The view half is free; the date half
  // is not, because a dated list has to be re-fetched for today to match the
  // control that now says Today.
  //
  // Tested on routeResult.date, not routeDate: it is the list on screen that
  // decides whether a fetch is owed. Already-today costs nothing, and a search
  // in flight is left alone.
  //
  // THE ANCHORED PANEL IS NOT CLOSED FROM HERE. That panel is the screen's, so
  // the screen closes it and then calls this. See routeResetControls there.
  const resetRouteControls = () => {
    setRouteDepBands(ALL_BANDS_ON);
    setRouteArrBands(ALL_BANDS_ON);
    setRouteAirlinesOff([]);
    setRouteSort(ROUTE_SORT_DEFAULT);
    setRouteDate(null);
    if (host.current?.loading) return;
    if (routeResult === null || routeResult.date === null) return;
    runRouteLookup(routeResult.origin, routeResult.destination, null);
  };

  return {
    bindHost,
    savedFlights,
    routeResult, setRouteResult,
    routeDate, setRouteDate,
    routeSort, setRouteSort,
    routeDepBands, setRouteDepBands,
    routeArrBands, setRouteArrBands,
    routeAirlinesOff, setRouteAirlinesOff,
    routePick, setRoutePick,
    routeSavingKey,
    routeSelectedKey, setRouteSelectedKey,
    runRouteLookup,
    saveFromRoute,
    routeDurationMs,
    routeRowKey,
    routeShown, routeFound, routeHiddenCount,
    routeAirlineOptions, routeAirOn,
    routeDepCounts, routeArrCounts, routeAirCounts,
    routeSorted, routeListed, routePinned,
    routeFastestKeys, routeLastKey,
    routeSelected, routeReason, routeSelectedDur,
    routeActiveFilters, routeFiltersDirty, routeControlsDirty,
    routeResetControls_forSearch, resetRouteControls,
    sheetPresented, setSheetPresented,
    sheetClosing, setSheetClosing,
    sheetDetent, setSheetDetent,
    sheetHeights,
    hostLoading,
  };
}

type RouteResultsValue = ReturnType<typeof useRouteResultsState>;

const RouteResultsContext = createContext<RouteResultsValue | null>(null);

// MOUNTED IN app/(tabs)/search/_layout.tsx, above the search Stack, so the map
// screen and the results sheet are both inside it. Inside SavedProvider and
// ToastProvider by construction -- the root layout mounts those around every
// route -- which is what lets the save path here reach the store and the toasts.
export function RouteResultsProvider({ children }: { children: ReactNode }) {
  const value = useRouteResultsState();
  return <RouteResultsContext.Provider value={value}>{children}</RouteResultsContext.Provider>;
}

export function useRouteResults(): RouteResultsValue {
  const value = useContext(RouteResultsContext);
  if (value === null) {
    throw new Error('useRouteResults must be used inside RouteResultsProvider');
  }
  return value;
}
