// THE TABS, NATIVE. Stage 8 of the conversion: components/GlassTabBar.tsx --
// four thousand four hundred and eighty-nine lines of hand-built chrome, a
// sliding pill, a per-character wave, a pan gesture and a search field -- is
// deleted, and this is Apple's tab bar in its place. SPEC.md Section 12 is the
// stage; Sections 16 and 17 are the registers this file's notes answer to.
//
// PROVIDERS ARE NOT HERE, AND MUST NOT BE. They stay in the root layout,
// outside the Stack, because a sheet route presented beside this group has to
// reach the saved list, the account, the map routes, the query, the toasts and
// the chrome flag. A provider mounted inside this group would be out of a
// sheet's reach.
//
// ── S-13, MOVED FROM THE DELETED BAR ────────────────────────────────────────
// NAVIGATION TYPES AND COMPONENTS COME FROM expo-router, NOT @react-navigation.
// As of SDK 56 expo-router VENDORS react-navigation rather than depending on
// it -- it has no @react-navigation/* dependency or peer at all -- and
// re-exports from its own copy. The two sets of types are field for field
// identical and stopped being assignable four levels down (a backImage
// tintColor that is ColorValue in one and string in the other). The copy the
// navigator actually hands us is expo-router's, so that is the only name used
// for it anywhere in this app: the tab bar, the theme, the Stack, the sheets.
//
// ── RETIRED WITH THE BAR (Section 16, R1 to R6) ─────────────────────────────
// Six rules lived in the deleted file and each is recorded here once, with why
// the native bar makes it impossible to hit again:
//   R1  "THE GESTURE'S CONFIGURATION AND STATE MUST NEVER DEPEND ON searchMode"
//       -- retired: there is no gesture. The system bar owns its touches.
//   R2  "SEARCH MODE MAY NEVER AFFECT THE gesture's lifecycle or view presence"
//       -- retired: there is no search mode in the bar, and no gesture.
//   R3  "A SECOND REF AND NOT pressOutTimer" -- retired: no press timers
//       remain; the bar's press feedback is Apple's.
//   R4  "THE MEASUREMENTS NEVER MOVE" / "THE MEASUREMENT IS NEVER TORN DOWN"
//       -- retired: nothing here measures a slot or a track. The system lays
//       the bar out.
//   R5  "A ZERO BOX IS NEVER WORTH REPORTING" -- retired: no onLayout remains.
//   R6  "A TRANSFORM AND NEVER A LAYOUT" -- retired: the bar no longer
//       animates its own box; minimisation and hiding are the system's.
// The five gesture rules that SURVIVE the bar (S-1 to S-5) moved to the top of
// components/swipe.tsx, which still owns a gesture.
import { NativeTabs } from "expo-router/unstable-native-tabs";
// WHETHER THE CHROME SHOULD STAND ASIDE. The globe's drag raises the flag on
// the search screen; this is the one consumer, and it was the only thing about
// retraction that changed: the bar used to animate itself out of the way, and
// now the system hides it. lib/chrome.tsx and the wiring are untouched.
import { useChrome } from "../../lib/chrome";
import { PAGE_BG } from "../../lib/cards";

export default function TabsLayout() {
  const { retracted } = useChrome();

  // THE ONE SANCTIONED EXCEPTION TO THE GREEN RULE. Green is for live or
  // actionable, and the selected tab is where the app currently IS -- the
  // actionable position -- so it is the tint. Nothing else in the bar is
  // coloured. blurEffect is the same string the hand-built bar used, so the
  // material carries over by name. labelStyle is deliberately unset: tab
  // labels are human words, and San Francisco is the decision (SPEC 12.1).
  //
  // THE ICONS ARE SETTLED. Home, Deck and Search are the symbols SPEC 12.1
  // names. My Flights was to keep the hand-drawn aeroplane, and could not:
  // Icon.src takes a bitmap image source, a VectorIcon font glyph or a promise
  // loader, and warns and drops an SVG element. The owner reversed the
  // instruction rather than rasterise a bitmap, so it is the SF Symbol
  // 'airplane', which has no filled variant; the green tint carries selection
  // there exactly as it does on the other three. The drawn path survives in
  // lib/icons.ts for Stage 10, where the swipe glyphs meet the same question.
  return (
    <NativeTabs
      tintColor="#4ade80"
      blurEffect="systemChromeMaterialDark"
      backgroundColor={PAGE_BG}
      minimizeBehavior="onScrollDown"
      hidden={retracted}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="flights">
        <NativeTabs.Trigger.Icon sf={{ default: 'airplane', selected: 'airplane' }} />
        <NativeTabs.Trigger.Label>My Flights</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="deck">
        {/* A placeholder by the owner's instruction; it will change. */}
        <NativeTabs.Trigger.Icon sf={{ default: 'building.2', selected: 'building.2.fill' }} />
        <NativeTabs.Trigger.Label>Deck</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
