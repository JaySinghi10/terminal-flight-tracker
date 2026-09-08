import { useEffect } from "react";
// THE ROOT IS A STACK NOW, AND THE TABS ARE ONE SCREEN OF IT. Stage 1 of the
// native conversion: every sheet that follows -- profile, archive, airports,
// import -- is presented as a Stack sibling of the tab group rather than as a
// hand-built Modal inside a screen. The tab navigator itself moved, verbatim,
// to app/(tabs)/_layout.tsx. Because (tabs) is a route GROUP the URLs did not
// change: /search is still /search, which is what the notification tap below
// and the Google OAuth redirect both rely on.
//
// DarkTheme, ThemeProvider and Stack come from expo-router's own surface, not
// from @react-navigation/* directly, for the reason recorded above the
// BottomTabBarProps import in components/GlassTabBar.tsx: expo-router pins
// and re-exports the navigation packages it was built against, and importing
// the same names from the underlying package is how two copies end up loaded.
import { Stack, useRouter, ThemeProvider, DarkTheme } from "expo-router";
// THE STATUS BAR, FROM THE PACKAGE THAT IS ACTUALLY IN app.json's PLUGINS.
// expo-status-bar was installed and configured and never imported; the RN
// StatusBar on Home carried an Android-only backgroundColor and did the job by
// accident. This one is authoritative. Home's stays until Stage 11 removes it,
// so there is never a moment with no status bar configuration.
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
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
import { SavedProvider } from "../lib/saved";
// AND THE QUERY, SEPARATELY. Two providers rather than one value with both
// on it: the saved list changes a handful of times a session and the query
// changes on every keystroke, and a consumer of either must not be woken by
// the other. See the note at the top of lib/query.tsx.
//
// INSIDE SavedProvider, and the nesting order carries no meaning: neither
// reads the other, so this is only a place to stand.
import { QueryProvider } from "../lib/query";
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

// THE THEME NATIVE CONTAINERS READ. A native stack paints its background, a
// form sheet its card and a header its bar from the navigation theme, not from
// any style on a screen. Without this a sheet presented in Stage 2 would come
// up in the system's default, which on a light-mode device is white against a
// #0a0a0a app. app.json says "dark" now too; the two are belt and braces, and
// this is the one that carries the exact colour.
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

  useEffect(() => {
    // Hide on error too: a font failure must not leave the splash up forever.
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  // ── A TAPPED NOTIFICATION ──
  //
  // The server's messages carry a deep link (notify.deep_link): a cancellation
  // opens the route list, earliest first, with the origin, destination and
  // date filled in. Nothing sends yet -- push needs a dev build -- so this is
  // the receiving end, built against the payload shape the sender will use.
  // The response listener covers a tap while the app is running or in the
  // background; the last-response read covers a cold start from the tap.
  const router = useRouter();
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (data: Record<string, unknown> | undefined) => {
      if (!data || data.screen !== 'search') return;
      const from = typeof data.from === 'string' ? data.from : null;
      const to = typeof data.to === 'string' ? data.to : null;
      if (from === null || to === null) return;
      router.push({
        pathname: '/search',
        params: {
          from, to,
          date: typeof data.date === 'string' ? data.date : '',
          sort: typeof data.sort === 'string' ? data.sort : 'earliest',
          // A fresh nonce, so tapping two notifications for the same route
          // runs the lookup twice rather than being deduplicated as one.
          tap: String(Date.now()),
        },
      });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(resp => {
      open(resp.notification.request.content.data as Record<string, unknown> | undefined);
    });
    Notifications.getLastNotificationResponseAsync().then(resp => {
      if (resp) open(resp.notification.request.content.data as Record<string, unknown> | undefined);
    }).catch(() => {});
    return () => { sub.remove(); };
  }, [router]);

  if (!fontsLoaded && !fontError) return null;

  // REQUIRED for any gesture to fire, and it was not here before because
  // nothing used one. react-native-gesture-handler needs this at the root of
  // the tree; expo-router does not mount it for you. Without it the swipe
  // actions on the saved rows fail silently on Android rather than erroring,
  // which is the worst way for this to be wrong.
  //
  // PROVIDER ORDER. SavedProvider must contain MapRoutesProvider (reads the
  // account email from it) and ToastProvider (undo reaches the store).
  // ChromeProvider and QueryProvider carry no ordering meaning. See each
  // import's note above.
  //
  // THE STACK HAS NO HEADER AND PAINTS THE PAGE. Its one screen today is the
  // tab group. Sheets join it as siblings from Stage 2, each declaring its own
  // presentation; nothing here needs to change for them to appear.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={TERMINAL_THEME}>
        <AccountProvider>
          <SavedProvider>
            <MapRoutesProvider>
              <ChromeProvider>
              <QueryProvider>
                <ToastProvider>
                  <StatusBar style="light" />
                  <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: PAGE_BG } }}>
                    <Stack.Screen name="(tabs)" />
                  </Stack>
                </ToastProvider>
              </QueryProvider>
              </ChromeProvider>
            </MapRoutesProvider>
          </SavedProvider>
        </AccountProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
