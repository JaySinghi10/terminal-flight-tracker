import { useCallback, useEffect, useRef, useState } from "react";
// THE ROOT IS A STACK NOW, AND THE TABS ARE ONE SCREEN OF IT. Stage 1 of the
// native conversion: every sheet that follows -- profile, archive, airports,
// import -- is presented as a Stack sibling of the tab group rather than as a
// hand-built Modal inside a screen. The tab navigator itself moved, verbatim,
// to app/(tabs)/_layout.tsx. Because (tabs) is a route GROUP the URLs did not
// change: /search is still /search, which is what the notification tap below
// and the Google OAuth redirect both rely on.
//
// DarkTheme, ThemeProvider and Stack come from expo-router's own surface, not
// from @react-navigation/* directly, for the reason recorded as S-13 at the top
// of app/(tabs)/_layout.tsx: expo-router vendors and re-exports the navigation
// packages it was built against, and importing the same names from the
// underlying package is how two copies end up loaded.
import { Stack, useRouter, useNavigationContainerRef, ThemeProvider, DarkTheme } from "expo-router";
// THE STATUS BAR, FROM THE PACKAGE THAT IS ACTUALLY IN app.json's PLUGINS.
// expo-status-bar was installed and configured and never imported; the RN
// StatusBar on Home carried an Android-only backgroundColor and did the job by
// accident. This one is authoritative. Home's stays until Stage 11 removes it,
// so there is never a moment with no status bar configuration.
import { StatusBar } from "expo-status-bar";
// Text, FOR THE SHEET'S TITLE. iOS refuses to move a native header title off
// centre -- headerTitleAlign is documented "Not supported on iOS. It's always
// center and cannot be changed" -- so the title is a header LEFT ITEM instead
// and the native title is left empty. See the profile screen below.
import { Platform, Text } from "react-native";
import * as Notifications from "expo-notifications";
// THE STORE, MOUNTED ONCE FOR THE WHOLE APP. Inside GestureHandlerRootView
// because that has to stay the outermost thing in the tree, and wrapping the
// Stack rather than sitting inside a screen: the saved list is the tab bar's
// as much as home's, and a provider mounted on one screen is a provider that
// unmounts when that screen does.
//
// AND OUTSIDE THE STACK, WHICH IS LOAD-BEARING FROM STAGE 2 ON. A sheet route
// presented as a sibling of the tab group must reach every one of these. A
// provider mounted inside app/(tabs)/ would be out of a sheet's reach.
import { SavedProvider, useSaved } from "../lib/saved";
// THE ID A SAVED FLIGHT IS FILED UNDER, so a flight push can name the record
// My Flights holds rather than a flight number and a date that it would have to
// assemble for itself. lib/storage imports nothing but AsyncStorage.
import { makeFlightId } from "../lib/storage";
// THE QUERY PROVIDER IS GONE (Stage 9). It existed to carry typed text from
// the tab bar's field to the search screen across a sibling boundary. The
// field is the search screen's own now, so there is no boundary to cross and
// nothing to provide.
// AND THE TWO BANNERS. Inside SavedProvider because undo reaches the store, and
// wrapping the navigator because the screen that RAISES a toast is not always
// the screen that would have drawn it: the search screen saves, unsaves and
// refreshes, and a banner mounted on home reports none of it. See lib/toast.tsx.
import { ToastProvider } from "../lib/toast";
// AND THE SESSION. Written by the profile modal on home, read by the search
// screen's /chat request, and owned by neither. It holds that one value and
// nothing else — see the note at the top of lib/account.tsx for why username and
// displayName deliberately stayed where they are.
import { AccountProvider } from "../lib/account";
// AND WHICH ROUTES ARE ON THE MAP. Inside SavedProvider because it reads the
// account email from it, and wrapping the navigator for the same reason the
// saved list does: the card that ADDS a route is on two screens and the map
// that DRAWS one is on a third state of a third, and none of them owns the list.
import { MapRoutesProvider } from "../lib/maproutes";
// AND WHETHER THE CHROME SHOULD STAND ASIDE. OUTSIDE the tabs rather than inside
// a screen, because the tab bar is the navigator's furniture and the thing that
// raises the flag is a screen -- the two are siblings and this is the only place
// that contains both. See lib/chrome.
import { ChromeProvider } from "../lib/chrome";
// THE PAGE, FROM THE ONE PLACE THAT NAMES IT. It is the Stack's content
// background, the theme's background, and (in app/(tabs)/_layout.tsx) the tab
// navigator's scene background: the colour every screen is drawn onto, and the
// colour a native container paints before a screen has rendered. A page colour
// spelled twice is a page colour that can be changed once.
import { PAGE_BG } from "../lib/cards";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import { Inter_400Regular, Inter_600SemiBold } from "@expo-google-fonts/inter";

SplashScreen.preventAutoHideAsync();

// ── THE SPLASH IS HIDDEN UNTIL THE CEILING, NOT ONCE ────────────────────────
//
// THE CALL ABOVE MAKES THIS FILE THE ONLY THING THAT CAN HIDE IT. It tells the
// native module the app is in charge, which switches off both of the other
// hides -- expo-router's own and the native one that fires when content first
// appears. So a single hide that misses is a splash that stays up forever.
//
// AND A HIDE CAN MISS WITHOUT A SOUND. The native side returns silently when it
// has no root view yet or no visible loading view, and it re-shows the splash
// on every reload command with a fresh view that an earlier hide never saw. JS
// cannot ask whether the splash is still up -- the module exposes hide, hideAsync,
// preventAutoHideAsync and setOptions and nothing that reports visibility -- so
// the hide is repeated for a fixed window instead. Each repeat is a no-op on
// the native side when there is nothing left to hide.
//
// A QUARTER OF A SECOND APART FOR THREE SECONDS. Short enough that a re-shown
// splash is gone before a person reads it as a hang; long enough to outlast the
// launch and reload interleaving a development client goes through on a cold
// start from a notification tap.
const SPLASH_RETRY_MS = 250;
const SPLASH_CEILING_MS = 3000;

// ── A TAPPED NOTIFICATION, HELD UNTIL IT CAN BE REACHED ─────────────────────
//
// WHAT THE TAP ASKED FOR, NOT YET WHERE IT GOES. A search link knows its
// screen. A flight link names a saved flight, and which screen holds that
// flight's card is only known once the saved list has loaded -- see
// destinationFor. Every one carries `tap`, a fresh nonce, so a second tap on the
// same route or the same flight is a new request rather than a repeat the screen
// can mistake for the last one.
type SearchParams = { from: string; to: string; date: string; sort: string; tap: string };
type PendingLink =
  | { kind: 'search'; params: SearchParams }
  | { kind: 'flight'; id: string; tap: string };

// WHERE IT GOES, in the shape router.push takes.
type TapHref =
  | { pathname: '/search'; params: SearchParams }
  | { pathname: '/flights'; params: { open: string; tap: string } }
  | { pathname: '/'; params: { open: string; tap: string } };

// ── WHAT A TAP'S DATA ASKS FOR, OR null ──────────────────────────────────────
//
// THE TWO SHAPES notify.deep_link WRITES. A cancellation, or the next flight
// found after one, carries screen "search" and a route. Every other kind --
// gate, terminal, delay, departed, landed, belt and the rest -- carries screen
// "flight", a flight number and a date: the two parts makeFlightId files a
// saved flight under, so the id is built here and whichever screen holds the
// card is handed the record's own key.
//
// NOTHING IS REFUSED IN SILENCE. A payload that names no screen this app has,
// or leaves out the one field its screen cannot do without, is logged with the
// value that failed and returns null; the caller then clears it, so it is not
// read again on the next launch. The app is already open -- the tap did that --
// and stays wherever it was.
//
// A DATE THAT IS NOT A DAY IS WARNED ABOUT AND STILL SENT. makeFlightId files
// such a record under "unknown" rather than refusing it, so the lookup is made
// on the same rule the store uses; if it matches nothing, Home opens with
// nothing expanded rather than the tap doing nothing.
function linkFor(raw: unknown): PendingLink | null {
  if (raw === null || typeof raw !== 'object') {
    console.warn('[TAP] the notification carried no data; staying where the app is');
    return null;
  }
  const data = raw as Record<string, unknown>;
  const tap = String(Date.now());
  if (data.screen === 'search') {
    const from = typeof data.from === 'string' ? data.from : null;
    const to = typeof data.to === 'string' ? data.to : null;
    if (from === null || to === null) {
      console.warn(`[TAP] a search link without ${from === null ? '"from"' : '"to"'}: ${JSON.stringify(data)}`);
      return null;
    }
    return {
      kind: 'search',
      params: {
        from, to,
        date: typeof data.date === 'string' ? data.date : '',
        sort: typeof data.sort === 'string' ? data.sort : 'earliest',
        tap,
      },
    };
  }
  if (data.screen === 'flight') {
    const number = typeof data.flight_number === 'string' && data.flight_number.trim() !== ''
      ? data.flight_number.trim()
      : null;
    if (number === null) {
      console.warn(`[TAP] a flight link without "flight_number": ${JSON.stringify(data)}`);
      return null;
    }
    const day = typeof data.date === 'string' ? data.date : null;
    if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      console.warn(`[TAP] a flight link whose "date" is not a day: ${JSON.stringify(data.date)}`);
    }
    return { kind: 'flight', id: makeFlightId(number, day), tap };
  }
  console.warn(`[TAP] an unrecognised "screen": ${JSON.stringify(data.screen)}; staying where the app is`);
  return null;
}

// ── A TAP IS FINISHED WITH ───────────────────────────────────────────────────
//
// The sync form; the async one is deprecated and only calls this. It throws
// when the native method is missing, which must never take a send or a refusal
// down with it -- by the time this runs the decision has been made.
function forgetLastTap(): void {
  try {
    Notifications.clearLastNotificationResponse();
  } catch (e) {
    console.warn('[TAP] could not clear the last notification response', e);
  }
}

// ── HAS THIS LAYOUT'S STACK INITIALISED ─────────────────────────────────────
//
// NOT isReady(), AND NOT useRootNavigationState(). expo-router mounts a
// navigator of its own ABOVE this file -- one screen, named __root, whose
// component is this layout -- and that navigator is ready from the first frame.
// Every signal expo-router exposes reports on it: isReady, the container's
// onReady, and the root state's key. All three are true while this layout is
// still rendering nothing for want of its fonts, with no Stack mounted, so a
// push sent on their word is handed to a navigator that cannot route it.
//
// THE STATE ONE LEVEL DOWN IS THE ANSWER. Under the __root route sits this
// Stack's state. Before the Stack mounts it is at most the partial state the
// linking layer derived from a URL, which carries no key; the Stack's router
// keys its state the moment it initialises. A key there is the Stack existing.
// isReady first, because reading the root state of a container that is not
// ready logs an error rather than returning nothing.
function stackReady(nav: ReturnType<typeof useNavigationContainerRef>): boolean {
  if (!nav.isReady()) return false;
  const inner = nav.getRootState()?.routes?.[0]?.state;
  return inner?.key != null && inner.stale !== true;
}

// ── WHERE A HELD LINK GOES, OR null TO KEEP WAITING ─────────────────────────
//
// A SEARCH LINK NEEDS NOTHING BUT THE STACK. A FLIGHT LINK NEEDS THE SAVED LIST,
// because where a flight's card lives depends on what the person did with it:
//
//   on a journey       My Flights, which opens its card -- or, if the whole
//                      journey is past, opens with nothing expanded
//   saved, no journey  Home, which opens its card. A watched flight, and the
//                      common case for a push about a flight someone is meeting.
//   not saved at all   Home, with nothing expanded. A push about a flight the
//                      app does not have is still a reason to open the app.
//
// DECIDED HERE, BEFORE ANY SCREEN IS SHOWN, and not by My Flights redirecting:
// the common case is a cold start, which lands on Home already, and a detour
// through My Flights would show the wrong tab first on exactly that path.
//
// `saved` IS null UNTIL THE LIST HAS LOADED, and null keeps the link waiting.
// The list is [] before the read comes back, and deciding from that would send
// every flight, journeys included, to Home.
function destinationFor(
  link: PendingLink,
  saved: readonly { id: string; tripId: string | null }[] | null,
): TapHref | null {
  if (link.kind === 'search') return { pathname: '/search', params: link.params };
  if (saved === null) return null;
  const params = { open: link.id, tap: link.tap };
  const flight = saved.find(f => f.id === link.id);
  return flight !== undefined && flight.tripId !== null
    ? { pathname: '/flights', params }
    : { pathname: '/', params };
}

// ── THE HELD LINK, SENT ONCE IT CAN BE REACHED ──────────────────────────────
//
// A COMPONENT, RENDERED INSIDE SavedProvider, BECAUSE THE LAYOUT IS NOT INSIDE
// IT. Choosing between My Flights and Home needs the saved list, and the layout
// renders the provider rather than sitting under it. It draws nothing.
//
// ON THE CONTAINER'S OWN STATE EVENT, NOT A TIMER. The container emits it on
// every state change, and the Stack initialising under __root is one; the
// listener is registered BEFORE the first check so a Stack that finishes
// mounting in between is not missed. `sent` makes it once even if two events
// arrive before the cleared link re-renders this effect away.
//
// AND ON THE LIST LOADING. `hydrated` is a dependency, so a flight link that
// arrived before the read came back is sent the moment it does.
function PendingTapSender({ pending, onSent }: { pending: PendingLink | null; onSent: () => void }) {
  const router = useRouter();
  const nav = useNavigationContainerRef();
  const { savedFlights, hydrated } = useSaved();
  useEffect(() => {
    if (pending === null) return;
    let sent = false;
    const send = () => {
      if (sent || !stackReady(nav)) return;
      const href = destinationFor(pending, hydrated ? savedFlights : null);
      if (href === null) return;
      sent = true;
      router.push(href);
      onSent();
      forgetLastTap();
    };
    const unsubscribe = nav.addListener('state', send);
    send();
    return unsubscribe;
  }, [pending, hydrated, savedFlights, nav, router, onSent]);
  return null;
}

// THE THEME NATIVE CONTAINERS READ. A native stack paints its background, a
// form sheet its card and a header its bar from the navigation theme, not from
// any style on a screen. Without this a sheet presented in Stage 2 would come
// up in the system's default, which on a light-mode device is white against a
// #0a0a0a app. app.json says "dark" now too; the two are belt and braces, and
// this is the one that carries the exact colour.
// ── HOW FAR UP THE PROFILE SHEET COMES ──────────────────────────────────────
//
// NOT ALL THE WAY, WHICH IS THE POINT. Apple's account sheets stop short of the
// top and leave the screen behind them visible above the corners; a sheet that
// reaches the top reads as a new screen rather than as something laid over the
// one you were on.
//
// ONE DETENT, NOT TWO. The sheet is not meant to be draggable between sizes --
// it has one height and a close button -- so the array holds a single value and
// sheetExpandsWhenScrolledToEdge is off, which would otherwise grow it to full
// height the moment the list scrolled to its end.
//
// 0.92 OF THE STACK'S HEIGHT. Detents are measured against the full height on
// iOS, so this leaves roughly the status bar and a little under it showing.
const PROFILE_DETENT = 0.92;

const TERMINAL_THEME = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: PAGE_BG, card: PAGE_BG },
};

export default function Layout() {
  const [fontsLoaded, fontError] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
    Inter_400Regular,
    Inter_600SemiBold,
  });

  // Hide on error too: a font failure must not leave the splash up forever.
  // See SPLASH_CEILING_MS for why this repeats.
  useEffect(() => {
    if (!fontsLoaded && !fontError) return;
    let stopped = false;
    const started = Date.now();
    const attempt = async () => {
      try {
        await SplashScreen.hideAsync();
      } catch (e) {
        // The next tick tries again; the ceiling below does not depend on it.
        console.warn('[SPLASH] hide failed, retrying', e);
      }
    };
    void attempt();
    const timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() - started >= SPLASH_CEILING_MS) {
        stopped = true;
        clearInterval(timer);
        // THE CEILING: one last hide, synchronous and unconditional. There is
        // nothing past this to try, so a failure here is only reported.
        try {
          SplashScreen.hide();
        } catch (e) {
          console.warn('[SPLASH] final hide failed', e);
        }
        return;
      }
      void attempt();
    }, SPLASH_RETRY_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [fontsLoaded, fontError]);

  // ── A TAPPED NOTIFICATION ──
  //
  // The server's messages carry a deep link (notify.deep_link): a cancellation
  // opens the route list, earliest first, with the origin, destination and
  // date filled in; every other message opens that flight's card where it
  // lives, on My Flights or on Home. See linkFor and destinationFor. The
  // response listener covers a tap while the app is running or in the
  // background; the last-response read covers a cold start from the tap.
  //
  // A TAP IS ACTED ON ONCE, KEYED ON THE NOTIFICATION'S OWN IDENTIFIER. On a
  // cold start expo-notifications holds the tap and replays it to each listener
  // as it registers, so the listener and the last-response read can both see
  // the same one -- which ran the route search twice. Two DIFFERENT
  // notifications carry different identifiers and are still both acted on.
  //
  // AND ACROSS A RELOAD. The set of identifiers lives in memory and a JS reload
  // empties it, after which the last-response read would find the same tap and
  // act on it again. So every tap ENDS with the last response cleared natively,
  // whichever way it ends:
  //
  //   acted on      marked on sight, cleared once its push is SENT. On send,
  //                 not on sight: a reload that lands while the Stack is still
  //                 waiting for its fonts must find the tap again, because it
  //                 has not been acted on yet.
  //   refused       marked on sight, logged by linkFor, cleared at once. It
  //                 used to be marked and then left as the last response, so
  //                 every reload read it and refused it again, silently.
  //
  // MARKED ON SIGHT IN BOTH CASES, and that is the dedupe rather than a side
  // effect: the listener and the last-response read deliver one cold-start tap
  // twice, and marking first is what stops the second delivery logging or
  // queueing it again.
  //
  // AND IT IS HELD, NOT PUSHED. This effect runs on the first commit, while the
  // layout is still rendering nothing for its fonts, and a push then went to
  // expo-router's own navigator with no Stack under it and was dropped. The
  // link waits in `pending` until stackReady says the Stack exists -- and a
  // flight link until the saved list has loaded as well. PendingTapSender,
  // rendered inside the providers below, does the sending.
  const [pending, setPending] = useState<PendingLink | null>(null);
  // Stable, so PendingTapSender's effect is not rebuilt on every render.
  const clearPending = useCallback(() => setPending(null), []);
  const handledTaps = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const take = (resp: Notifications.NotificationResponse | null) => {
      if (resp === null) return;
      const id = resp.notification.request.identifier;
      if (handledTaps.current.has(id)) return;
      handledTaps.current.add(id);
      const link = linkFor(resp.notification.request.content.data);
      if (link === null) {
        // REFUSED, AND SAID SO BY linkFor. Cleared now: there is nothing to
        // wait for, and leaving it would have every reload refuse it again.
        forgetLastTap();
        return;
      }
      setPending(link);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    Notifications.getLastNotificationResponseAsync().then(take).catch(() => {});
    return () => { sub.remove(); };
  }, []);


  if (!fontsLoaded && !fontError) return null;

  // REQUIRED for any gesture to fire, and it was not here before because
  // nothing used one. react-native-gesture-handler needs this at the root of
  // the tree; expo-router does not mount it for you. Without it the swipe
  // actions on the saved rows fail silently on Android rather than erroring,
  // which is the worst way for this to be wrong.
  //
  // PROVIDER ORDER. SavedProvider must contain MapRoutesProvider (reads the
  // account email from it) and ToastProvider (undo reaches the store).
  // ChromeProvider carries no ordering meaning. See each import's note above.
  //
  // THE STACK HAS NO HEADER BY DEFAULT AND PAINTS THE PAGE. The tab group is
  // its first screen and the profile sheet its second, presented over the tabs
  // as a UIKit form sheet stopped at one detent -- see PROFILE_DETENT -- with
  // the native header the tabs do without.
  //
  // THE PRESENTATION AND THE HEADER ARE DECLARED HERE because a sheet's chrome
  // is the presenter's to declare and must be known before the route mounts.
  // The close button is the route's own, through Stack.Toolbar, because only
  // the route can dismiss itself. See app/profile.tsx.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={TERMINAL_THEME}>
        <AccountProvider>
          <SavedProvider>
            <MapRoutesProvider>
              <ChromeProvider>
                <ToastProvider>
                  <StatusBar style="light" />
                  <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: PAGE_BG } }}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen
                      name="profile"
                      options={{
                        presentation: 'formSheet',
                        sheetAllowedDetents: [PROFILE_DETENT],
                        sheetExpandsWhenScrolledToEdge: false,
                        // NO GRABBER. There is one height and a close button;
                        // a grabber advertises a drag that changes nothing.
                        sheetGrabberVisible: false,
                        headerShown: true,
                        // EMPTY, AND THE TITLE IS THE LEFT ITEM BELOW. iOS
                        // centres a native title and will not be told
                        // otherwise; the reference puts it on the left.
                        headerTitle: '',
                        // ── THE TITLE, AND WHY IT IS NOT headerLeft ────────
                        //
                        // headerLeft PUT IT IN A GLASS PILL. That prop is
                        // rendered as <ScreenStackHeaderLeftView>{element}</>
                        // with no hidesSharedBackground prop at all, so the
                        // subview takes the bar's SHARED background -- and on
                        // iOS 26 a shared bar background is Liquid Glass. The
                        // capsule was UIKit drawing a bar button item, which
                        // is what that slot is for; nothing here asked for it.
                        //
                        // unstable_headerLeftItems IS THE SAME SLOT WITH THE
                        // SWITCH EXPOSED. A 'custom' item is rendered as
                        // <ScreenStackHeaderLeftView hidesSharedBackground=
                        // {item.hidesSharedBackground}>, and that prop reaches
                        // the native subview. So the text sits in the same
                        // place with no fill behind it.
                        //
                        // THE unstable_ PREFIX IS THE LIBRARY'S, not a warning
                        // about this use: it is the documented way to put items
                        // in the bar, and it overrides headerLeft by design.
                        unstable_headerLeftItems: () => [
                          {
                            type: 'custom',
                            hidesSharedBackground: true,
                            element: (
                              <Text style={{ color: '#ffffff', fontSize: 17, fontWeight: '600' }}>
                                Profile
                              </Text>
                            ),
                          },
                        ],
                        // WHITE, NOT THE APP'S GREEN. This is the colour bar
                        // items inherit, and the sheet's own accent is set on
                        // the two controls that actually want it.
                        headerTintColor: '#ffffff',
                      }}
                    />
                  </Stack>
                  {/* INSIDE SavedProvider ON PURPOSE: it reads the saved list to
                      choose between My Flights and Home. See PendingTapSender. */}
                  <PendingTapSender pending={pending} onSent={clearPending} />
                </ToastProvider>
              </ChromeProvider>
            </MapRoutesProvider>
          </SavedProvider>
        </AccountProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
