import { useEffect } from "react";
import { Tabs } from "expo-router";
import GlassTabBar from "../components/GlassTabBar";
// THE STORE, MOUNTED ONCE FOR THE WHOLE APP. Inside GestureHandlerRootView
// because that has to stay the outermost thing in the tree, and wrapping Tabs
// rather than sitting inside a screen: the saved list is the tab bar's as much
// as home's, and a provider mounted on one screen is a provider that unmounts
// when that screen does.
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
// wrapping Tabs because the screen that RAISES a toast is not always the screen
// that would have drawn it: the search screen saves, unsaves and refreshes, and
// a banner mounted on home reports none of it. See lib/toast.tsx.
import { ToastProvider } from "../lib/toast";
// AND THE GMAIL TOKEN. Written by the profile modal on home, read by the search
// screen's /chat request, and owned by neither. It holds that one value and
// nothing else — see the note at the top of lib/account.tsx for why username and
// displayName deliberately stayed where they are.
import { AccountProvider } from "../lib/account";
// AND WHICH ROUTES ARE ON THE MAP. Inside SavedProvider because it reads the
// account email from it, and wrapping Tabs for the same reason the saved list
// does: the card that ADDS a route is on two screens and the map that DRAWS one
// is on a third state of a third, and none of them owns the list.
import { MapRoutesProvider } from "../lib/maproutes";
// AND WHETHER THE CHROME SHOULD STAND ASIDE. OUTSIDE Tabs rather than inside a
// screen, because the tab bar is the navigator's furniture and the thing that
// raises the flag is a screen -- the two are siblings and this is the only place
// that contains both. See lib/chrome.
import { ChromeProvider } from "../lib/chrome";
// THE PAGE, FROM THE ONE PLACE THAT NAMES IT. This was a hardcoded "#050505"
// and it is the navigator's own scene background -- the colour every screen is
// drawn onto. A page colour spelled twice is a page colour that can be changed
// once.
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

  if (!fontsLoaded && !fontError) return null;

  // REQUIRED for any gesture to fire, and it was not here before because
  // nothing used one. react-native-gesture-handler needs this at the root of
  // the tree; expo-router does not mount it for you. Without it the swipe
  // actions on the saved rows fail silently on Android rather than erroring,
  // which is the worst way for this to be wrong.
  //
  // TABS, NOT A STACK, AND NO TAB BAR. The screens here are peers rather than
  // a push history: home and profile are two places the app can be, and
  // navigating between them should not build a back stack that has to be
  // unwound. What a tab navigator gives that a stack does not is that a screen
  // STAYS MOUNTED when it loses focus, so home keeps its search, its result and
  // its scroll position while the user is somewhere else.
  //
  // THE BAR IS OURS, and it is absolutely positioned inside itself, so it
  // still reserves no height here and the screens stay full-bleed. It floats
  // over them; each screen pads its own last line clear of it.
  //
  // sceneStyle is the v7 name for the wrapper around the screen content — v6
  // called it sceneContainerStyle, which does not exist in this version. It is
  // set so the gap between screens is the page's own black rather than the
  // navigator's default white.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AccountProvider>
        <SavedProvider>
          <MapRoutesProvider>
            <ChromeProvider>
            <QueryProvider>
              <ToastProvider>
                <Tabs
                  tabBar={props => <GlassTabBar {...props} />}
                  screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: PAGE_BG } }}
                />
              </ToastProvider>
            </QueryProvider>
            </ChromeProvider>
          </MapRoutesProvider>
        </SavedProvider>
      </AccountProvider>
    </GestureHandlerRootView>
  );
}
