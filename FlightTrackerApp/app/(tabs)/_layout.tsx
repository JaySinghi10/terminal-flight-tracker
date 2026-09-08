// THE TABS, MOVED HERE VERBATIM FROM THE ROOT LAYOUT. Stage 1 of the native
// conversion introduced a root Stack so that sheets can be presented as its
// siblings; the tab navigator became one screen of that Stack and lives in
// this group. Nothing about the tabs themselves changed in that move: the bar
// is still ours, the scene background is still the page's, and the four
// screens still stay mounted when they lose focus.
//
// PROVIDERS ARE NOT HERE, AND MUST NOT BE. They stay in the root layout,
// outside the Stack, because a sheet route presented beside this group has to
// reach the saved list, the account, the map routes, the query, the toasts and
// the chrome flag. A provider mounted inside this group would be out of a
// sheet's reach.
import { Tabs } from "expo-router";
import GlassTabBar from "../../components/GlassTabBar";
// THE PAGE, FROM THE ONE PLACE THAT NAMES IT. This was a hardcoded "#050505"
// and it is the navigator's own scene background -- the colour every screen is
// drawn onto. A page colour spelled twice is a page colour that can be changed
// once.
import { PAGE_BG } from "../../lib/cards";

export default function TabsLayout() {
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
    <Tabs
      tabBar={props => <GlassTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: PAGE_BG } }}
    />
  );
}
