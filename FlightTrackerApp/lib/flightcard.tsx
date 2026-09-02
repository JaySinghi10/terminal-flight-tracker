// EVERYTHING A SCREEN NEEDS TO OWN A FLIGHT CARD.
//
// Every line of this was app/index.tsx's and every line is unchanged but for the
// two edits recorded below. It moved because BOTH screens own a card now: home's
// is opened by tapping a watchlist row, the search screen's by a lookup or a
// route row, and they are the same component driven by the same actions. The
// lookup, the save, the refresh, the entry animation, the error channel and the
// minute tick are what drives one, and one copy of each is the only way the two
// cards can behave identically.
//
// WHAT IS NOT HERE. `chatResponse` and every route value stayed on the search
// screen, because only it can render one. `closeFlightCard` stayed on both,
// because it genuinely differs: home's card is always opened from a watchlist
// row and closing it is the full clear, while the search screen's has a result
// list to fall back to. A shared version would have had to ask the caller for
// half of itself, which is not sharing.
//
// THE TWO EDITS THE MOVE FORCED.
//
// runFlightLookup's `setChatResponse(null)` came out. It cleared state that is
// now the search screen's, and this hook cannot reach it. The clear did not
// disappear: it moved to the one call site that did not already have it — see
// the route row in app/search.tsx.
//
// The error effect lost its cardBorderAnim half. That value drove the command
// line's underline, the command line's input is the tab bar's now, and the row
// it underlined was deleted; with nothing left to animate the Animated.parallel
// collapsed to the single timing that remains. The 2500ms hold and the 3000ms
// clear are untouched.
import { useState, useRef, useEffect } from 'react';
import { Text, Animated, Easing } from 'react-native';
import { SavedFlight, savedFlightFromApi, MapRoute, MAX_MAP_ROUTES } from './storage';
import {
  useSaved, flightUrl, SAVE_MSG, OWN_MSG, effectiveStatus, departureTs, arrivalTs,
} from './saved';
import { useToast } from './toast';
// THE ROUTE OVERLAY'S STORE. Here rather than in the card for the same reason
// isSaved is: the card is handed the facts it cannot work out for itself, and
// which routes are drawn is one of them. Both screens already call this hook, so
// putting it here is what lets the card stay prop-driven.
import { useMapRoutes } from './maproutes';
import { FlightData, flightDataFromApi } from '../components/FlightCard';

// Declared here rather than imported from a screen, exactly as every other
// module in lib/ and components/ declares its own. The values are the family
// names _layout registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

// THE ERROR LINE, AND THE SHAKE WITH IT.
//
// A COMPONENT RATHER THAN A BLOCK ON EACH SCREEN, because both screens can
// produce an error and neither may hold the only copy of how one is reported: a
// failed lookup on the search screen and a failed card refresh on home are the
// same failure and have to read the same way.
//
// THE SHAKE IS GONE RATHER THAN MOVED. errorShake jolted the command line's
// input row; that row was deleted when the field became the tab bar's, and the
// only surviving element of the block is this line. Shaking the message itself
// is a different gesture from shaking the thing that was typed into, so the
// value, the sequence that drove it and every call to it came out. The fade in
// and out is untouched, and it is what reports an error now.
export function FlightError({ error, errorMsgOpacity }: {
  error: string; errorMsgOpacity: Animated.Value;
}) {
  return (
    <>
      {error !== "" && (
        <Animated.View style={{ opacity: errorMsgOpacity }}>
          <Text style={{ fontFamily: SANS, color: 'rgba(248,113,113,0.8)', fontSize: 11, marginTop: 4, marginBottom: 6, paddingLeft: 18 }}>{`> ${error}`}</Text>
        </Animated.View>
      )}
    </>
  );
}

// A RECORD, AS THE MAP STORES IT.
//
// THE CONVERSION HAPPENS ONCE, HERE, AND THE RESULT IS FROZEN. departureTs and
// arrivalTs read the record's ISO fields against its airports' IANA zones, which
// is the one operation in this app that must never be done twice by two
// different pieces of code -- see the note at the top of lib/time. Storage keeps
// numbers so that neither it nor the map ever has to do it again.
//
// A NULL INSTANT IS NOT A FAILURE. A pre-v3 record has no ISO to read and the
// map is built for that: the arc still draws, in the planned weight, with no
// aircraft on it. The route is known even when the schedule is not.
// EXPORTED FOR app/flights.tsx, which offers the same map toggle on every leg
// of a trip. A second copy of these five fields there would repeat the
// departureTs/arrivalTs conversion in a second place -- which is the one thing
// the note above says must never happen.
export function mapRouteFor(f: SavedFlight): MapRoute {
  return {
    id: f.id,
    from: f.from.iata,
    to: f.to.iata,
    dep: departureTs(f),
    arr: arrivalTs(f),
  };
}

export function useFlightCardHost() {
  const {
    savedFlights, saveRecord, handleUnsave, refreshOne, ownFlight, disownFlight,
  } = useSaved();
  const { showToast, showUndo } = useToast();
  const { isOnMap, addRoute, removeRoute } = useMapRoutes();

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [flight, setFlight] = useState<FlightData | null>(null);
  const [errorCounter, setErrorCounter] = useState(0);
  const [flightRecord, setFlightRecord] = useState<SavedFlight | null>(null);
  const [saveError, setSaveError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const resultOpacity = useRef(new Animated.Value(0)).current;
  const resultTranslate = useRef(new Animated.Value(30)).current;
  const errorMsgOpacity = useRef(new Animated.Value(0)).current;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (error === '') return;
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorMsgOpacity.stopAnimation();
    errorMsgOpacity.setValue(1);
    Animated.timing(errorMsgOpacity, { toValue: 0, duration: 500, delay: 2500, useNativeDriver: false }).start();
    errorTimerRef.current = setTimeout(() => setError(''), 3000);
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, [error, errorCounter]);

  useEffect(() => {
    if (saveError === '') return;
    const t = setTimeout(() => setSaveError(''), 3000);
    return () => clearTimeout(t);
  }, [saveError]);

  // THIS SCREEN'S MINUTE TICK, and it now does one job: advance `now` for the
  // countdowns, the archive split and the clock in the header.
  //
  // THE DAY ROLLOVER AND THE AppState RESUME WENT WITH THE STORE, which runs a
  // tick of its own for them. Two intervals rather than one, deliberately: this
  // value re-renders this screen every sixty seconds and has to, and putting it
  // on the context would re-render every OTHER screen every sixty seconds too.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  const showResult = () => {
    resultOpacity.setValue(0);
    resultTranslate.setValue(30);
    Animated.parallel([
      Animated.timing(resultOpacity, {
        toValue: 1, duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(resultTranslate, {
        toValue: 0, tension: 80, friction: 10,
        useNativeDriver: true,
      }),
    ]).start();
  };

  // `date` is the LOCAL DEPARTURE date of the instance wanted, or null for the
  // nearest one — which is what every caller meant before this existed, so an
  // omitted argument preserves today's behaviour exactly.
  //
  // `origin` is the departure IATA, and it is how a TAG FLIGHT is pinned to the
  // leg the user actually tapped: one number operating BOM-DEL then DEL-BOM on
  // one day is two instances the date cannot separate. Null where the caller
  // genuinely does not know — a flight number typed into the search box names no
  // airport, and guessing one there would be inventing an answer.
  const runFlightLookup = async (
    flightNumber: string,
    keepVisible = false,
    date: string | null = null,
    origin: string | null = null,
  ): Promise<boolean> => {
    setError("");
    setSaveError("");
    if (!keepVisible) {
      setFlight(null);
      setFlightRecord(null);
    }
    setLoading(true);
    try {
      const response = await fetch(flightUrl(flightNumber, date, origin));
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        return false;
      }

      // THE RECORD IS BUILT FIRST so one clock check serves both it and the
      // card. savedFlightFromApi is pure — it reads `data` and the clock and
      // writes no state — so moving it above setFlight leaves the order of every
      // state update below exactly as it was, and every value identical.
      const record = savedFlightFromApi(data);
      setFlight(flightDataFromApi(data, effectiveStatus(record, Date.now())));

      setFlightRecord(record);
      await refreshOne(record);

      setLastUpdated(record.updatedAt);
      if (!keepVisible) showResult();
      return true;
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const isSaved = !!flightRecord && savedFlights.some(f => f.id === flightRecord.id);

  // ON THE MAP IS NOT THE SAME QUESTION AS SAVED, and the card shows both at
  // once. A flight can be drawn without being watched and watched without being
  // drawn; nothing here derives one from the other.
  const routeOnMap = !!flightRecord && isOnMap(flightRecord.id);

  // OWNED IS NOT THE SAME QUESTION AS SAVED EITHER, and the card shows both at
  // once. A flight can be WATCHED without being FLOWN -- the whole watchlist is
  // that -- and FLOWN without being separately watched, because ownership saves
  // the record itself when it has to. Nothing here derives one from the other.
  //
  // READ OFF THE STORE'S OWN LIST rather than off flightRecord, for the reason
  // isSaved is: the record on this screen is a snapshot from a lookup and
  // carries whatever tripId it had when it was built -- which savedFlightFromApi
  // sets to null by construction, so reading it would report every flight as
  // unowned forever. The question is about the STORED record.
  const isOwnedFlight = !!flightRecord
    && savedFlights.some(f => f.id === flightRecord.id && f.tripId !== null);

  // THE TOGGLE, AND IT IS THE ONE ACTION BEHIND THREE CONTROLS: the long press
  // menu, the swipe button and the swipe's own full-swipe commit. Written once
  // so the three cannot come to mean different things.
  //
  // NO RECORD, NO ROUTE. flightRecord is what carries the airports' timezones
  // and the id the map keys on, and it is null only between a lookup failing and
  // the card being cleared. The controls are hidden in that state rather than
  // disabled — see the route card.
  const toggleRouteOnMap = async () => {
    if (!flightRecord) return;
    if (routeOnMap) {
      await removeRoute(flightRecord.id);
      showToast('removed from map');
      return;
    }
    const outcome = await addRoute(mapRouteFor(flightRecord));
    showToast(outcome === 'limit'
      ? `map holds ${MAX_MAP_ROUTES} routes — remove one first`
      : 'added to map');
  };

  // THE SAME SHAPE AS toggleRouteOnMap, and deliberately: one action, two
  // directions, and the wording is this hook's because the card is not allowed
  // to know what a store is.
  //
  // NO RECORD, NO TRIP. flightRecord is what carries the id ownership keys on,
  // and it is null only between a lookup failing and the card being cleared.
  //
  // THE ADD REPORTS ITS REMINDERS. ownFlight calls enableReminders and hands the
  // outcome back for exactly this reason -- see OWN_MSG, which is SAVE_MSG's
  // argument applied to the other verb.
  //
  // DISOWNING RETURNS THE FLIGHT TO THE WATCHLIST AND DOES NOT UNSAVE IT, which
  // is why that side reads "removed from My Flights" rather than "removed". The
  // record keeps its reminders, its archive decision and its place in the list;
  // only the claim that the user is flying it goes away. Saying "removed" would
  // describe a deletion that did not happen.
  const toggleOwned = async () => {
    if (!flightRecord) return;
    if (isOwnedFlight) {
      await disownFlight(flightRecord);
      showToast('removed from My Flights');
      return;
    }
    const outcome = await ownFlight(flightRecord);
    showToast(OWN_MSG[outcome.remind]);
  };

  // THE UNSAVE IS THE STORE'S AND THE BANNER IS THIS SCREEN'S. handleUnsave
  // composes the line, because it is the only thing that knows whether the
  // record had reminders on it when it went; showUndo is what puts it on screen.
  const unsaveWithBanner = async (f: SavedFlight) => {
    showUndo(await handleUnsave(f));
  };

  const handleToggleSave = async () => {
    if (!flightRecord) return;
    setSaveError("");
    if (isSaved) {
      await unsaveWithBanner(flightRecord);
      return;
    }
    // THE WHOLE SAVE IS saveRecord's, and saving back inside the undo window is
    // an undo whichever control does it — the window is keyed on the id, so only
    // this exact flight is restored. What is left here is the card's wording.
    const outcome = await saveRecord(flightRecord);
    if (outcome.kind === 'restored') { showToast('restored'); return; }
    if (outcome.kind === 'limit') {
      // A TOAST, because the thing that used to show this is gone. It was
      // setSaveError, rendered by the status band inside the card, and the line
      // here said "saveError owns this case; no toast" — true while the band
      // existed. Without it the refusal was set, timed out three seconds later
      // and never appeared: a full watchlist would have read as a save button
      // that did nothing at all.
      showToast('watchlist limit reached — unsave one first');
      return;
    }
    // SAVING IS THE SIGNAL THAT THE USER CARES ABOUT THIS FLIGHT, so reminders
    // follow from it rather than needing a second action. A refusal never blocks
    // the save and never asks twice: the flight is saved either way, and the
    // toast is where the difference is reported.
    showToast(SAVE_MSG[outcome.remind]);
  };

  // LIFTED OUT OF THE HEADER ROW, unchanged. It was an inline arrow on the
  // refresh button; that button is now a swipe action AND the left panel's
  // full-swipe commit, so the same body needs two callers and therefore a name.
  // Every argument it passes is the one it passed before.
  const refreshFlightCard = async () => {
    if (!flightRecord) return;
    // THE GUARD THE BUTTON USED TO BE. The header control carried
    // disabled={loading} and dimmed its glyph; a swipe action closes its panel
    // on press and leaves nothing on screen to disable, so the refusal has to
    // live in the handler. Without it a second swipe during a lookup would start
    // another one — two calls billed for one answer.
    if (loading) return;
    // Pinned to the instance on screen. flight.date is the backend's own
    // flight_date, derived from the departure ISO, so it names exactly the day
    // being refreshed; the shape test lets "N/A" fall through to undated.
    //
    // AND TO THE LEG ON SCREEN. This is the one call that can flip an
    // ALREADY-CORRECT card to the other leg of a tag flight: the card may have
    // been opened from a route row that got the origin right, and a refresh
    // without one would quietly replace it with whichever leg the provider
    // offered. It knows the answer from the very record it is refreshing.
    const ok = await runFlightLookup(
      flightRecord.flightNumber,
      true,
      /^\d{4}-\d{2}-\d{2}$/.test(flight?.date ?? '') ? (flight?.date ?? null) : null,
      flightRecord.from.iata || null,
    );
    if (ok) showToast('updated');
  };

  // WHAT A SCREEN GETS. The card's own state and the setters the two screens
  // still need — renderSavedFlight on home builds a card by hand, and the search
  // screen's own clear has to reach the same slots this lookup writes.
  return {
    now,
    flight, setFlight,
    flightRecord, setFlightRecord,
    error, setError, setErrorCounter,
    saveError, setSaveError,
    loading, setLoading,
    lastUpdated, setLastUpdated,
    errorMsgOpacity, resultOpacity, resultTranslate,
    showResult,
    runFlightLookup, refreshFlightCard, handleToggleSave,
    isSaved, unsaveWithBanner,
    routeOnMap, toggleRouteOnMap,
    isOwnedFlight, toggleOwned,
  };
}
