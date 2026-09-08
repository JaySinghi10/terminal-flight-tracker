// THE STACK AROUND SEARCH, AND IT EXISTS FOR ONE REASON: a native search bar
// is a navigation-item property, so it needs a native stack header to hang
// on. The tab navigator has no header. Wrapping this one route in a Stack of
// its own gives it one; the header is kept transparent and untitled so that
// on iOS 26, where the field docks into the tab bar's search pill
// (role="search" on the trigger plus placement 'integrated' on the bar), the
// header adds nothing visible and the screen's own top-of-page arithmetic is
// untouched. On an earlier iOS the field falls back into this header, and
// then it is the header. SPEC.md Section 12, Stage 9.
//
// THE FIELD ITSELF IS CONFIGURED IN THE SCREEN, not here, through
// Stack.Screen options: its callbacks write the screen's state and there is no
// honest way to reach that state from a layout.
//
// Stack from expo-router's own surface, for the reason recorded in
// app/(tabs)/_layout.tsx (S-13).
import { Stack } from "expo-router";
import { PAGE_BG } from "../../../lib/cards";

export default function SearchLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        headerTitle: '',
        headerShadowVisible: false,
        contentStyle: { backgroundColor: PAGE_BG },
      }}
    />
  );
}
