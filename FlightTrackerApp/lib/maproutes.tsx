// WHICH ROUTES ARE DRAWN ON THE GLOBE.
//
// A PROVIDER RATHER THAN A READ IN EACH PLACE, because the two halves of this
// feature are on opposite sides of the tree. The flight card owns the decision
// — a long press or a swipe on its route block adds and removes — and it is
// mounted on both the home screen and the search screen. The map that draws the
// result is on the search screen only, and never inside the card. Two consumers
// reading storage independently would drift the moment one of them wrote.
//
// ITS OWN FILE AND ITS OWN CONTEXT, for the reason _layout gives for keeping
// the query out of the saved list: this changes when somebody adds a route, and
// the watchlist changes on every refresh. A consumer of either must not be woken
// by the other.
//
// WHAT IS HERE: the list, its hydration, and the two writes. WHAT IS NOT: how a
// route is BUILT from a flight record. That is mapRouteFor in lib/flightcard,
// where the record and its timezones already are.
import {
  createContext, useContext, useEffect, useState, useCallback, useMemo,
  type ReactNode,
} from 'react';
import {
  MapRoute,
  getMapRoutes,
  addMapRoute,
  removeMapRoute,
  getMapPastShown,
  setMapPastShown,
} from './storage';
// THE ACCOUNT COMES FROM THE SAVED STORE, which already owns it: it reads the
// email out of SecureStore on boot and every screen in the app takes it from
// there. A second reader would be a second answer to "who is signed in", and
// the two could disagree for exactly as long as one of them was still loading.
import { useSaved } from './saved';

// 'limit' is the cap being hit and nothing else. The caller decides what to say
// about it — see the note on SaveOutcome in lib/saved for why the outcome is a
// word rather than a thrown error.
export type AddRouteOutcome = 'added' | 'limit';

type MapRoutesContextValue = {
  routes: MapRoute[];
  // FALSE UNTIL THE FIRST READ LANDS, and the map has to respect it. Without it
  // the globe would draw an empty overlay on mount and then fill in, which reads
  // as the routes being removed and put back on every app start.
  hydrated: boolean;
  isOnMap: (id: string) => boolean;
  addRoute: (route: MapRoute) => Promise<AddRouteOutcome>;
  removeRoute: (id: string) => Promise<void>;
  // WHETHER THE ARCS OF FLIGHTS THAT HAVE LANDED ARE DRAWN. A preference about
  // the overlay rather than about any one route, and it rides here because it is
  // scoped to the same account and hydrated in the same read -- a second
  // provider for one boolean would be a second thing to keep in step.
  showPast: boolean;
  setShowPast: (on: boolean) => void;
};

const MapRoutesContext = createContext<MapRoutesContextValue | null>(null);

export function useMapRoutes(): MapRoutesContextValue {
  const ctx = useContext(MapRoutesContext);
  if (ctx === null) throw new Error('useMapRoutes must be used inside MapRoutesProvider');
  return ctx;
}

export function MapRoutesProvider({ children }: { children: ReactNode }) {
  const { email } = useSaved();
  const [routes, setRoutes] = useState<MapRoute[]>([]);
  // TRUE BEFORE THE FIRST READ, matching storage's own default. The optimistic
  // side is the one that cannot hide something the user put there.
  const [showPast, setShowPastState] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  // RE-READ ON EVERY ACCOUNT CHANGE, and that is the whole of the sign-out
  // handling. The buckets are per account, so switching accounts is a read of a
  // different key and the previous user's routes leave the map because they are
  // no longer what storage says. Nothing is cleared and nothing needs to be.
  //
  // hydrated GOES BACK TO FALSE FIRST. During the read the state still holds the
  // OLD account's routes, and a map that drew them for those few milliseconds
  // would be showing one user's flights to another.
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    // BOTH READS BEHIND ONE FLAG. They are two keys but one answer to "what
    // should this account's map look like", and hydrating them separately would
    // let the map draw the right routes under the previous account's preference
    // for however long the second read took.
    Promise.all([getMapRoutes(email), getMapPastShown(email)]).then(([list, past]) => {
      if (cancelled) return;
      setRoutes(list);
      setShowPastState(past);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [email]);

  // THE WRITE IS THE SOURCE OF THE NEXT STATE. Both accessors return the list
  // they just persisted, so this sets what is on disk rather than what it
  // predicted would be — the two cannot come apart, and a rejected add (the cap)
  // leaves the state exactly as storage left it.
  const addRoute = useCallback(async (route: MapRoute): Promise<AddRouteOutcome> => {
    const result = await addMapRoute(email, route);
    setRoutes(result.routes);
    return result.ok ? 'added' : 'limit';
  }, [email]);

  const removeRoute = useCallback(async (id: string) => {
    setRoutes(await removeMapRoute(email, id));
  }, [email]);

  // SET FIRST, PERSISTED AFTER, and this one is the exception to the rule the
  // two above follow. They take their next state from what storage returned
  // because a write can be REJECTED -- the cap. This cannot fail in a way that
  // changes the answer, and a toggle that waited on a disk write before moving
  // would feel broken on the press.
  const setShowPast = useCallback((on: boolean) => {
    setShowPastState(on);
    setMapPastShown(email, on);
  }, [email]);

  // A SET RATHER THAN A SCAN. isOnMap is called on every render of the card and
  // there is exactly one card, so the scan would be cheap — but the identity of
  // this function is a dependency of the card's swipe renderers, and rebuilding
  // it on every render of the provider would remount an Svg per panel.
  const ids = useMemo(() => new Set(routes.map(r => r.id)), [routes]);
  const isOnMap = useCallback((id: string) => ids.has(id), [ids]);

  const value = useMemo(
    () => ({ routes, hydrated, isOnMap, addRoute, removeRoute, showPast, setShowPast }),
    [routes, hydrated, isOnMap, addRoute, removeRoute, showPast, setShowPast],
  );

  return <MapRoutesContext.Provider value={value}>{children}</MapRoutesContext.Provider>;
}
