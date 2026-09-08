# Terminal — Native iOS Conversion Specification

**Version 3. Supersedes v1 and v2 entirely.**

---

## 0. How this document addresses code, and why

### No line numbers

Versions 1 and 2 of this specification cited line numbers. Both were written from `origin/master` while local `HEAD` was 24 commits ahead, covering the poller, the notification layer, the refresh-token sign-in, the account-scoping fix, the map loader and the pending legs. A spot-check of twelve line references found ten landing on the wrong line.

The inventory itself was correct. Checked by name rather than position: seven `Modal`s, eleven `GlassLayers` sites, nine `BlurView`s, four `expo-blur` imports, three `KeyboardAvoidingView`s, one `LayoutAnimation.configureNext`, `expo-status-bar` never imported, the Android status bar prop on Home, and every cited package version resolving exactly as the lockfile states.

**The conclusion is that line numbers are the wrong addressing scheme for a document that outlives a commit.** This version has none. Every reference is a file path plus a named construct — a component, a constant, a style key, a state variable. Names survive commits; positions do not.

Each stage therefore opens with a **discovery step**: locate the named constructs in the current tree, list what was found and where, and report anything that could not be found before changing it. If a named construct is missing, that is information, not a blocker — report it and continue.

### Two corrections to earlier versions, recorded so they are not repeated

- **The tab bar's `ITEMS` says `deck`, not `bookings`.** v1 and v2 both claimed otherwise. It has said `deck` since before this work began. There is no rename to do.
- **`CONTEXT.md` does not state a background colour.** v2 claimed it says `#050505` and needed correcting. It says nothing on the subject. The `#050505` appears in the project's standing instructions, which are stale; `PAGE_BG` in `lib/cards.ts` is `#0a0a0a` and is correct.

### House style — read this before touching anything

Comment blocks in this repository routinely run twenty to four hundred lines and contain measured arithmetic, rejected alternatives, and named past bugs. They are the only record of defects that were expensive to find.

**When code is deleted, its comment block is not silently deleted with it.** For every block removed, one of two things must happen:

1. The rule still applies to the native replacement, in which case it moves to the new code in condensed form.
2. The rule is genuinely retired because the native component makes it impossible to hit, in which case a one-line note records which rule was retired and why it can no longer occur.

**Section 16 is the register of retired rules. Section 17 is the register of surviving rules and their new homes.** Nothing in either register may be dropped without an entry. If a rule's disposition is unclear, keep the rule and flag it.

---

## 1. Constraints that do not move

- **Background `#0a0a0a`.** `PAGE_BG` in `lib/cards.ts` is the single source. Native surfaces that default to a system background must be set to it explicitly.
- **`#4ade80` green for live or actionable only.** Green never becomes a decorative accent or a broadly applied system tint. One deliberate exception is granted in Stage 8 and justified there.
- **JetBrains Mono for machine data** — flight numbers, times, gates, codes, terminals, belts, airport codes. **Inter for human language** — greetings, labels, prose, empty states.
- **Terminal-flavoured, not terminal-literal. Legibility beats aesthetics.**
- **iOS only.** Android-only code encountered is deleted, not ported. No Android branches. Android is not weighed in any decision.
- **Every rule about what the app will and will not claim about flight data stays exactly as it is.** This conversion is presentation-only. It must not change: which provider may declare a landing, the two-poll confirmation on departures, the five-minute estimate threshold, "absence is never an assertion", "first sight is never a change", the refusal to display an unsupplied gate, terminal, belt or desk, or the diversion wording. If a stage appears to require touching any of these, stop and report.

---

## 2. Verified environment

Read from the packages resolved in `package-lock.json`, downloaded and inspected directly. Not from documentation, not from memory.

| Package | Version |
|---|---|
| `expo` | 57.0.19 |
| `expo-router` | 57.0.18 |
| `react-native` | 0.86.3 |
| `react-native-screens` | 4.26.2 |
| `expo-glass-effect` | 57.0.1 |
| `expo-symbols` | 57.0.2 |
| `@expo/ui` | 57.0.15, present as a dependency of `expo-router` |

### API gate results

**Native tabs exist.** `expo-router/unstable-native-tabs` exports `NativeTabs` and `NativeTabTrigger`. `NativeTabs` carries `.Trigger` (itself carrying `.Label`, `.Icon`, `.Badge`, `.VectorIcon`) and `.BottomAccessory` with a static `usePlacement(): 'regular' | 'inline'`.

`Icon`, `Label`, `Badge` and `VectorIcon` are **not** top-level named exports in this version. Documentation showing `import { NativeTabs, Icon, Label }` describes SDK 54 and does not apply. Use the compound form.

**`role="search"` does not give a search field.** `role` is typed `NativeTabsTabBarItemRole`, whose union is exactly `'bookmarks' | 'contacts' | 'downloads' | 'favorites' | 'featured' | 'history' | 'more' | 'mostRecent' | 'mostViewed' | 'recents' | 'search' | 'topRated'`. Its own doc comment points at `UITabBarItem.systemItem` and states the system-defined title cannot be customized. This is UIKit's legacy system tab item, not the iOS 26 search-tab morph. A full text search of the native-tabs build for "search" returns two hits, both that enum. **There is no search-field-in-the-tab-bar primitive in expo-router 57.** Stage 9 uses `headerSearchBarOptions` instead.

**`NativeTabsProps` surface, verified:** `unstable_screenErrorBoundary`, `labelStyle`, `iconColor`, `tintColor`, `backgroundColor`, `badgeBackgroundColor`, `hidden`, `minimizeBehavior`, `blurEffect`, `shadowColor`, `titlePositionAdjustment`, `disableTransparentOnScrollEdge`, `sidebarAdaptable`, `disableIndicator`, `backBehavior`, `labelVisibilityMode`, `rippleColor`, `indicatorColor`, `badgeTextColor`, `tabBarRespectsIMEInsets`, `screenListeners`, `unstable_nativeProps`. `labelStyle` and `iconColor` each accept a flat value or `{ default, selected }`.

**`blurEffect` accepts `'systemChromeMaterialDark'`** — the exact string the hand-built bar and `GlassLayers` already use. The material carries over by name.

**Label typography is settable.** `NativeTabsLabelStyle = Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontStyle' | 'fontWeight' | 'color'>`. JetBrains Mono in tab labels is available and has been **declined**: tab labels are human words, not machine data.

**`@expo/ui` is already installed.** `@expo/ui/swift-ui` exports `Menu`, `ContextMenu`, `Host`, `DatePicker`, `Button`, `Toggle`, `Picker`, `Section`, `Divider`, `Alert`, `BottomSheet`, `Popover`, `GlassEffectContainer` and others.

- `ContextMenu.Trigger`'s own doc says it opens on **long-press**. All three of Terminal's menus are tap-triggered. **Use `Menu`, not `ContextMenu`.**
- `DatePicker` props are `title`, `selection`, `range?: { start?: Date; end?: Date }`, `displayedComponents` (`'date' | 'hourAndMinute'`), `onDateChange`, `children`. **There is no `minimumDate` or `maximumDate`.**

**Form sheets are available.** On expo-router's native stack screen types: `presentation: 'formSheet'`, `sheetAllowedDetents` (`number[] | 'fitToContents'`), `sheetInitialDetentIndex` (`number | 'last'`), `sheetGrabberVisible`, `sheetCornerRadius`, `sheetLargestUndimmedDetentIndex` (`number | 'none' | 'last'`).

**`headerSearchBarOptions` is available**, typed `SearchBarProps` from `react-native-screens`. Verified surface: `ref` (`SearchBarCommands`), `autoCapitalize`, `autoFocus`, `barTintColor`, `tintColor`, `cancelButtonText`, `hideNavigationBar`, `hideWhenScrolling`, `inputType`, `obscureBackground`, `onBlur`, `onCancelButtonPress`, `onChangeText`, `onClose`, `onFocus`, `onOpen`, `onSearchButtonPress`, `placeholder`, `placement`, `allowToolbarIntegration`, `textColor`, `hintTextColor`, `headerIconColor`, `shouldShowHintSearchIcon`. `placement` accepts `'automatic' | 'inline' | 'stacked' | 'integrated' | 'integratedButton' | 'integratedCentered'`. **There is no `fontFamily`.**

**Automatic content insets.** `NativeTabTriggerProps.disableAutomaticContentInsets` documents that on iOS the first scroll view nested inside a native tabs screen already has automatic content inset adjustment enabled. The four hand-tuned bottom paddings may be handled by the system for free.

---

## 3. The eleven surfaces

The app has seven `Modal`s but **eleven distinct sheet-shaped surfaces**, because one modal hosts three arms and two surfaces are not modals at all. The eleven are the unit of work.

| # | Surface | File · construct | Nature | Stage |
|---|---|---|---|---|
| S1 | Profile sheet | `app/index.tsx` · the `Modal` gated on the profile modal's `visible` prop, wearing `pm.sheet` inside `pm.backdrop` | Bottom-anchored sheet | 2 |
| S2 | Archive sheet | `app/index.tsx` · the `Modal` gated on `archiveOpen`, wearing `g.sheetShell` | Centred sheet | 3 |
| S3 | Airport sheet | `components/FlightCard.tsx` · the `Modal` gated on `airportSheetOpen` | Centred sheet, per-card | 4 |
| S4 | Import sheet | `app/flights.tsx` · the local `Sheet` component, rendered on `overlay === 'import'` | Centred sheet | 5 |
| S5 | My Flights menu | `app/flights.tsx` · the local `Menu` and `MenuRow` components, rendered on `overlay === 'menu'` | Menu | 6 |
| S6 | Map menu | `components/FlightCard.tsx` · the `Modal` gated on `mapMenuOpen` | Menu | 6 |
| S7 | Route dropdown | `app/search.tsx` · the `Modal` gated on `routeOpenDrop`, wearing `routeDropPanel` | Anchored menu | 6 |
| S8 | Route calendar | `app/search.tsx` · the `Modal` gated on `routeCalOpen` | Date picker | 7 |
| S9 | Past overlay | `app/flights.tsx` · the `overlay === 'past'` arm | **Dead code** | 11 |
| S10 | Toast card | `lib/toast.tsx` · the `View` wearing `g.sheetShell` and `s.toastCard` | Floating chrome | 10 |
| S11 | Undo banner | `lib/toast.tsx` · the `View` wearing `g.sheetShell` and `s.undoCard` | Floating chrome | 10 |

**Not surfaces, and deliberately excluded:**

- `components/FlightCard.tsx` · the `View` wearing `g.sheetShell` and `s.airportCard` — an inline card on the map variant, not a presented surface. Left alone. See 13.3.
- `components/FlightCard.tsx` · `SheetFlightHeader` and `SheetGroup` — sections rendered inside S3, not sheets.

---

## 4. Complete inventory of everything else hand-built

### 4.1 Blur surfaces — nine

| # | File · construct | Stage |
|---|---|---|
| B1 | `lib/glass.tsx` · the `BlurView` inside `GlassLayers` | 10 |
| B2 | `components/GlassTabBar.tsx` · the `BlurView` inside `BarGlass` | 8 |
| B3 | `components/GlassTabBar.tsx` · the `BlurView` at intensity 12 inside `capsuleClip`, the fallback pill's frost | 8 |
| B4 | `components/GlassTabBar.tsx` · the `BlurView` inside the Home glyph's `glyphClip` | 9 |
| B5 | `components/GlassTabBar.tsx` · the `BlurView` inside the magnifier glyph's `glyphClip` | 9 |
| B6 | `app/search.tsx` · the `BlurView` inside the consent prompt wrapper `cs.wrap` | 10 |
| B7 | `app/search.tsx` · the `BlurView` inside the past-flights toggle `pt.btn` | 10 |
| B8 | `app/search.tsx` · the `BlurView` inside the map home button `hm` group | 10 |
| B9 | `components/FlightCard.tsx` · the `BlurView` in the `mapVariant` branch, inset by `insets.top` | **Kept.** See 13.3 |

`expo-blur` is imported in four files: `app/search.tsx`, `lib/glass.tsx`, `components/FlightCard.tsx`, `components/GlassTabBar.tsx`.

### 4.2 `GlassLayers` render sites — eleven

`app/search.tsx` ×2 (inside the route dropdown panel; inside the calendar sheet) · `app/flights.tsx` ×2 (inside `Menu`; inside `Sheet`) · `app/index.tsx` ×2 (inside the profile sheet; inside the archive sheet) · `lib/toast.tsx` ×2 (inside `toastCard`; inside `undoCard`) · `components/FlightCard.tsx` ×3 (inside the airport sheet; inside the map menu; inside the conditional site whose comment begins "NULL, NOT A DIMMER GlassLayers").

### 4.3 The tab bar

`components/GlassTabBar.tsx`, mounted in `app/_layout.tsx` via the `tabBar` prop on `Tabs`. Five separable things:

1. **Tab bar chrome** — four items from `ITEMS`, SVG icons, monospace labels, a sliding selection pill.
2. **Search mode** — a `TextInput` inside the bar expanding to a full-width field, a keyboard-tracking close button, two glyph pills, a cycling animated placeholder.
3. **A pan gesture** — drag across to switch tabs, spring settling, per-slot measurement.
4. **A per-character wave** — `waveAt`, a smootherstep falloff scaling and recolouring each character.
5. **A mode machine** coordinating the above with `lib/chrome.tsx` and `lib/query.tsx`.

Exports consumed elsewhere: `TAB_BAR_HEIGHT`, imported by `app/search.tsx`; a press spring also imported by `app/search.tsx` for the map pin.

Type import: `BottomTabBarProps` from `expo-router/tabs`, **not** from `@react-navigation/bottom-tabs`. The comment above that import explains why. **Follow that convention throughout this work.**

### 4.4 Hand-driven motion

| File | Driver |
|---|---|
| `app/index.tsx` | RN `Animated` — sheet and scrim timings |
| `app/search.tsx` | RN `Animated` — dropdown, calendar, scrim |
| `app/flights.tsx` | RN `Animated` — overlay multiplexer |
| `components/FlightCard.tsx` | RN `Animated` — two sheets, scrims, card grow |
| `lib/flightcard.tsx` | RN `Animated` — error line fade |
| `lib/toast.tsx` | Reanimated — toast and undo sequence |
| `components/swipe.tsx` | Reanimated — swipe actions |
| `components/GlassTabBar.tsx` | Reanimated — everything in the bar |

Shared timing constants exported by `lib/glass.tsx`: `EASE_OUT`, `EASE_IN`, `OVERLAY_RISE`, `CAL_RISE`, `PANEL_IN_MS`, `PANEL_OUT_MS`, `CAL_IN_MS`, `CAL_OUT_MS`, `SCRIM_IN_MS`, `SCRIM_OUT_MS`.

### 4.5 Everything else

| Item | File · construct | Disposition | Stage |
|---|---|---|---|
| `userInterfaceStyle: "automatic"` | `app.json` | **Must become `"dark"`.** Native sheets, menus, pickers and tab bars read system appearance. On a light-mode device they render white against a `#0a0a0a` app | 1 |
| Splash `backgroundColor: "#ffffff"` and its `dark` override `"#000000"` | `app.json`, `expo-splash-screen` plugin | Both to `#0a0a0a` | 1 |
| No navigation theme | `app/_layout.tsx` | Native containers read it. Wrap in a dark theme provider | 1 |
| `LayoutAnimation.configureNext` | `app/deck.tsx` · the zone expand/collapse toggle | **Unsupported on New Architecture**, which RN 0.86 runs. Animating by accident or not at all. Replace with Reanimated | 11 |
| `UIManager.setLayoutAnimationEnabledExperimental` | `app/deck.tsx` · the Android guard near the top | Delete | 11 |
| RN `StatusBar` with `backgroundColor="#000"` | `app/index.tsx` | `backgroundColor` is Android-only and does nothing. `expo-status-bar` is installed and in `app.json` plugins but never imported | 1, 11 |
| `KeyboardAvoidingView` ×3 | `app/index.tsx` ×2 (inside the profile modal; wrapping the screen), `app/search.tsx` ×1 | Two become unnecessary | 2, 11 |
| `Platform.OS === 'ios' ? … : …` in keyboard behaviour | `app/index.tsx`, `app/search.tsx` | Simplify. iOS only | 11 |
| `experimentalBlurMethod="dimezisBlurView"` | every `BlurView` | Android-only prop | 11 |
| Manual bottom clearance | `app/index.tsx`, `app/search.tsx`, `app/flights.tsx`, `app/deck.tsx` — each a `paddingBottom` on a scroll content container derived from `insets.bottom` | Revisit. May be free — see 12.6 | 8 |
| `expo-symbols` installed, zero imports | — | Becomes the icon source | 10 |
| Haptics used once | `components/swipe.tsx` | Expands to seven | 10 |
| `RefreshControl` ×2 | `app/index.tsx`, `app/flights.tsx` | **Already native. Leave alone** | — |
| `ActivityIndicator` ×1 | `app/search.tsx` | **Already native. Leave alone** | — |
| MapLibre in a WebView | `components/GlobeMap.tsx` | **Out of scope** | — |
| Terminal schematic | `components/CorridorView.tsx` | Bespoke visualisation, not a system component | — |
| Swipe actions | `components/swipe.tsx` | iOS exposes no swipe-action primitive for a plain view row. Legitimate hand-build | — |

---

## 5. Stage 1 — dark appearance and a root Stack

**Purpose:** make the app unambiguously dark to the system and introduce the Stack every later sheet needs. No visual change should be observable.

### 5.0 Discovery

Locate and report: the `expo` block in `app.json` including `userInterfaceStyle` and the `expo-splash-screen` plugin entry; the provider tree and `Tabs` mount in `app/_layout.tsx`; the four route files `app/index.tsx`, `app/flights.tsx`, `app/deck.tsx`, `app/search.tsx`; the `PAGE_BG` export in `lib/cards.ts`. Confirm `expo-router` re-exports a navigation theme provider, checking its `react-navigation` entry point before falling back to `@react-navigation/native`.

### 5.1 `app.json`

- `"userInterfaceStyle": "automatic"` → `"dark"`
- Splash `"backgroundColor": "#ffffff"` → `"#0a0a0a"`
- Splash `"dark": { "backgroundColor": "#000000" }` → `"#0a0a0a"`
- Leave the `"android"` block in place. Inert on iOS; removing it is churn.

### 5.2 `app/_layout.tsx`

Current tree, outside in: `GestureHandlerRootView` → `AccountProvider` → `SavedProvider` → `MapRoutesProvider` → `ChromeProvider` → `QueryProvider` → `ToastProvider` → `Tabs`.

1. Wrap the provider tree in a dark navigation theme provider whose `colors.background` is `PAGE_BG`. **Prefer an expo-router re-export** over importing from `@react-navigation/native` directly, matching the convention documented above the `BottomTabBarProps` import in `components/GlassTabBar.tsx`.
2. Add `<StatusBar style="light" />` from `expo-status-bar` as a sibling of the navigator. **Leave the RN `StatusBar` in `app/index.tsx` in place for now.** Stage 11 removes it, so there is never a moment with no status bar configuration.
3. Introduce a root `Stack`. The `Tabs` navigator becomes one screen of it.

Resulting structure:

```
app/
  _layout.tsx          root Stack + all providers
  (tabs)/
    _layout.tsx        the Tabs navigator, moved verbatim
    index.tsx
    flights.tsx
    deck.tsx
    search.tsx
```

**Providers stay in the root `_layout.tsx`, outside the Stack.** Load-bearing: sheet routes presented as Stack siblings must reach `SavedProvider`, `AccountProvider`, `MapRoutesProvider`, `QueryProvider`, `ToastProvider` and `ChromeProvider`. Providers inside the tab group would be out of reach.

Root Stack screen options: `headerShown: false`, `contentStyle: { backgroundColor: PAGE_BG }`.

`(tabs)/_layout.tsx` keeps its `tabBar` prop and `screenOptions` exactly as they are. The tab bar is untouched in this stage.

### 5.3 Deleted

Nothing.

### 5.4 Must not change

- **Provider nesting order.** `SavedProvider` must contain `MapRoutesProvider` (reads the account email from it) and `ToastProvider` (undo reaches the store). `ChromeProvider` and `QueryProvider` carry no ordering meaning. The file's comments state this; preserve them.
- **`GestureHandlerRootView` stays outermost.** Stated in the file.
- **`sceneStyle`, not `sceneContainerStyle`.** The v7 name; the comment says so. Do not "correct" it.
- **Screens stay mounted when they lose focus.** Home keeps its search, its result and its scroll position. Do not introduce a stack inside the tab group.

### 5.5 Could break

- **`typedRoutes: true`.** Moving four files into `(tabs)/` regenerates route types. Because `(tabs)` is a group the URLs do not change, but a stale cache produces false errors. Clear `.expo/types`.
- **`reactCompiler: true`.** Moving files does not change contents, so this should be inert. If a screen behaves differently, suspect the compiler before the move.
- **Deep links.** `app.json` declares two schemes including a Google OAuth reverse-client-ID. Test sign-in in this stage, not later.
- **The tab bar's active index**, read from `state`. Confirm it still resolves.

### 5.6 Verify

1. Launches. `#0a0a0a` everywhere, no white flash on cold start.
2. Device in Light Mode: app still renders dark.
3. All four tabs navigate. Pill slides. Wave runs. Drag-to-switch works.
4. Tab bar search mode opens, types, closes.
5. Google sign-in completes and returns.
6. Pull-to-refresh works on Home and My Flights.
7. All eleven surfaces still open and close.
8. No flight card content, wording or status has changed.

---

## 6. Stage 2 — S1, profile sheet

### 6.0 Discovery

In `app/index.tsx`, locate: the profile `Modal` and its `visible` prop, the `KeyboardAvoidingView` inside it, the `GlassLayers` render inside it, the `pm` stylesheet keys `backdrop`, `sheet`, `tint`, `closeBtn`, `closeTxt`, the `PROFILE_FILL` constant, the `profileOpen` state and its setter, the `askName` and `onSkipName` handlers, the profile button's `onPress` including its `Keyboard.dismiss()` call, and any `Animated.Value` driving this sheet. Report each with its location.

### 6.1 Replacement

New route `app/profile.tsx` on the root Stack:

- `presentation: 'formSheet'`
- `sheetAllowedDetents: [0.6, 1]`
- `sheetGrabberVisible: true`
- `sheetCornerRadius: 16` — `SHEET_RADIUS` from `lib/glass.tsx`, carried deliberately
- `contentStyle: { backgroundColor: PAGE_BG }` — **opaque, not transparent.** Transparent gives liquid glass; over `#0a0a0a` that is uncontrollable near-black glass
- `sheetLargestUndimmedDetentIndex: 'none'` — always dim behind, matching the current scrim
- `headerShown: false`

The profile button's `setProfileOpen(true)` becomes `router.push('/profile')`.

**Delete the `KeyboardAvoidingView`.** A native form sheet resizes for the keyboard on iOS. Keeping it double-compensates.

**Delete the "X".** Grabber plus drag-to-dismiss is the native close. Where an explicit dismissal is needed, `router.back()`.

### 6.2 Deleted

The `Modal`; its `KeyboardAvoidingView`; its `GlassLayers`; `pm.backdrop`; `pm.tint`; `PROFILE_FILL`; `pm.closeBtn`; `pm.closeTxt`; `profileOpen` state; any `Animated.Value` driving this sheet.

### 6.3 Must not change

- **The name-asking flow.** `askName` and `onSkipName` mean this can open in a state where close is a *skip*, not a cancel. A native sheet is dismissible by drag; the old `Modal` was not. **A drag-dismiss while `askName` is true must take the same path as `onSkipName`.** If those diverge, a user can dismiss past the name prompt into an unexpected state.
- **The Gmail token write.** `app/_layout.tsx`'s comment records that this sheet writes the token `app/search.tsx`'s `/chat` request reads. Confirm provider reach.
- **Sign-out revoking at Google.** `CONTEXT.md` records this path is written, tested against a fake, and has never run on a device, and that the privacy policy describes it. Move it verbatim or not at all.
- **The `Keyboard.dismiss()` on the profile button** must survive the change to `router.push`.

### 6.4 Could break

Keyboard double-compensation — check the *screen's* `KeyboardAvoidingView`, which stays for now. The sheet rendering under the tab bar means the route was registered inside `(tabs)` by mistake. Back-gesture conflict with the tab navigator.

### 6.5 Verify

1. The profile button opens a sheet from the bottom with a grabber.
2. Drags between detents, rubber-bands at the top, dismisses downward.
3. Keyboard raises and the sheet resizes. No jump, no double shift.
4. Page behind is dimmed.
5. Sheet is `#0a0a0a`. Not white, not grey, not lifted.
6. Google sign-in completes and returns cleanly.
7. **Force the name-asking state and dismiss by dragging.** Behaves exactly as tapping skip.
8. Sign-out works.

---

## 7. Stage 3 — S2, archive sheet

### 7.0 Discovery

In `app/index.tsx`, locate: the `Modal` gated on `archiveOpen`, the `Pressable` wearing `g.routeCalScrim`, the scrim `Animated.View` wearing `g.routeCalDim` and its driving value, the sheet `Animated.View` wearing `g.sheetShell`, its `GlassLayers`, its `g.sheetEdge` sibling, the header built from `g.sheetHead` / `g.sheetHeadSpacer` / `g.sheetTitle` / `g.sheetClose`, the `archiveOpen` state, the opening handler and its `Keyboard.dismiss()`, and the entry/exit `useEffect`.

### 7.1 Replacement

Route `app/archive.tsx` on the root Stack:

- `presentation: 'formSheet'`
- `sheetAllowedDetents: [0.9]` — a single tall detent. This is a scrolled list; a half-height detent gives a cramped scroll area
- `sheetGrabberVisible: true`
- `sheetCornerRadius: 16`
- `contentStyle: { backgroundColor: PAGE_BG }`
- `headerShown: true`, `headerTitle` set to the existing title, `headerLargeTitle: false`

**The header becomes the native stack header.** `g.sheetHead` / `g.sheetTitle` / `g.sheetClose` / `g.sheetHeadSpacer` are a hand-built navigation bar, including a spacer whose width exists purely to optically centre a title against a close button. A native header centres its own title; the spacer and its arithmetic retire.

**Title typography.** `g.sheetTitle` is 13pt `JetBrainsMono_700Bold`. "Archive" is human language, so under the constraints it should be Inter. `headerTitleStyle` is available. Set Inter if it takes `fontFamily`; otherwise accept San Francisco. **Do not force JetBrains Mono onto a native header title.**

The opening handler becomes `router.push('/archive')`.

### 7.2 Deleted

The `Modal`, the scrim `Pressable`, both `Animated.View`s, both `Animated.Value`s and their `useEffect`, the `GlassLayers`, this sheet's `g.sheetEdge` render, `archiveOpen` state, the hand-built header row and close button.

### 7.3 Must not change

- **The `Keyboard.dismiss()` before opening.**
- **The content.** Which flights appear, in what order, with what wording.
- **The list's own scroll.** `g.sheetBodyFill`'s comment states "an unbounded ScrollView does not scroll." Inside a form sheet the sheet has a definite height, so a `flex: 1` body is still required. **This rule survives.** Carry it into the new file as a one-line comment.
- **The green rule.** Do not let a native header's default tint make anything green.

### 7.4 Could break

List not scrolling — the body is not `flex: 1`, exactly the bug `sheetBodyFill` predicted. A duplicate title means the hand-built header survived. Dismiss-while-scrolling conflict, which iOS resolves natively but must be felt rather than assumed.

### 7.5 Verify

1. Opens as a tall sheet with a native header and grabber.
2. List scrolls to its end.
3. Pulling down from a scrolled list scrolls first, then dismisses. Does not dismiss mid-scroll.
4. Title is centred with no hand-built spacer.
5. Sheet is `#0a0a0a`.
6. Every flight shows the same information in the same words.
7. Tapping a row does what it did before.

---

## 8. Stage 4 — S3, airport sheet

**Highest-risk sheet. It is per-card, so identity must travel.**

### 8.0 Discovery

In `components/FlightCard.tsx`, locate: the `Modal` gated on `airportSheetOpen`, the `Pressable` on `g.routeCalScrim`, the scrim `Animated.View` and its value, the sheet `Animated.View` on `g.sheetShell` and its value, the `airportGrow` geometry object and every use of its `tx`, `ty` and `scale` fields, the `GlassLayers`, the `g.sheetEdge` sibling, the inner tap-swallowing `Pressable`, the `g.sheetHead` header, the `SheetFlightHeader` and `SheetGroup` components, the `useEffect` keyed on `airportSheetOpen`, the `s.airportCardStood` style and every place it is applied, and `makeFlightId` in `lib/flightcard.tsx`.

### 8.1 Replacement

Route `app/airports.tsx` taking the flight identity as a route parameter.

**Parameter design.** Pass the minimum stable identity the card already computes — the key `makeFlightId` produces, or flight number plus departure date, whichever the card already holds. The sheet reads the record from `SavedProvider` or the card's own source. **Do not serialise a record into a URL.** If the record is not reachable from a provider, stop and report rather than inventing a store.

- `presentation: 'formSheet'`
- `sheetAllowedDetents: [0.75, 1]`
- `sheetGrabberVisible: true`
- `sheetCornerRadius: 16`
- `contentStyle: { backgroundColor: PAGE_BG }`
- `headerShown: true` with the existing title

`SheetFlightHeader` and `SheetGroup` move into the route unchanged. They are sections, not surfaces.

### 8.2 Deleted

The `Modal`, both `Animated.View`s, both `Pressable`s; both `Animated.Value`s; the `airportGrow` geometry; the `useEffect` keyed on `airportSheetOpen`; the `GlassLayers`; `airportSheetOpen` state; the hand-built header row.

### 8.3 Must not change

- **`s.airportCardStood`.** The card changes style while the sheet is open. That state now derives from navigation. **The card must stand while the sheet is open and sit back when it closes, including on drag-dismiss.** Wire it to route focus, not to a boolean the sheet sets on its way out.
- **Every claim rule in the card.** A gate not supplied is not shown. An absent terminal, belt or desk is shown as absent. The stale phase exists so a card with old data cannot render as "in air" and draw a live pulse over data that is not live. **None of this may change.** If the extraction appears to require touching phase logic, stop.
- **Green inside the card** stays the live pulse and actionable controls only.
- **JetBrains Mono** for airport codes, gates and times inside the sheet. The header title follows Stage 3's rule.

### 8.4 Lost here

**The grow-out-of-the-card animation.** `airportGrow`'s three-part translate-and-scale makes the sheet appear to emerge from the card's rectangle. Native form sheets always rise from the bottom. Recorded in Section 15.

### 8.5 Could break

Identity plumbing is the single most likely failure in the conversion. Home and My Flights both render cards; both must open with the correct identity. The card standing state can stick on if drag-dismiss is not wired.

### 8.6 Verify

1. Open a card on Home, then the airport sheet. Correct flight's airports.
2. Same from My Flights. Correct flight.
3. Dismiss by drag. Card sits back down.
4. Dismiss by the header control. Card sits back down.
5. A flight with a missing gate still shows the gate as absent, not invented.
6. A landed flight, an in-air flight and a pre-departure flight all read exactly as before.
7. Airport codes and times still JetBrains Mono.

---

## 9. Stage 5 — S4, import sheet

### 9.0 Discovery

In `app/flights.tsx`, locate: the `Overlay` type and all three of its arms, the `overlay` state, `openOverlay`, `closeOverlay`, `swapOverlay`, the scrim value, the `Modal` gated on `overlay !== null`, the local `Sheet` component and its `GlassLayers`, the `overlay === 'import'` branch, `chooseImport`, the `importable` computation, and the `st.sheetEmpty` style.

### 9.1 Replacement

Route `app/import.tsx`:

- `presentation: 'formSheet'`
- `sheetAllowedDetents: [0.6, 0.95]`
- `sheetGrabberVisible: true`
- `sheetCornerRadius: 16`
- `contentStyle: { backgroundColor: PAGE_BG }`
- `headerShown: true`, title `Import`

The empty state ("Nothing on your watchlist to import.") moves in unchanged.

`chooseImport` becomes `router.push('/import')`.

### 9.2 Deleted

The local `Sheet` component **once nothing else uses it** — the `'past'` arm still references it and is deleted in Stage 11, so `Sheet` may have to survive until then. **Check before deleting; report if it must stay.** Its `GlassLayers`. The `'import'` arm of the `Overlay` union.

### 9.3 Must not change

- **`swapOverlay`.** The menu currently swaps into the import sheet without a close-then-open flicker. Once the menu is native (Stage 6) and the sheet is a route, this becomes: dismiss the menu, then push. **Push after the menu's dismissal completes.**
- **What `importable` means.** Do not change the eligibility logic.
- **The twenty-flight watchlist cap.** Import must not exceed it.

### 9.4 Verify

1. From My Flights, open the menu, choose "Import from watchlist". Sheet rises. No flicker, no double animation.
2. Empty watchlist shows the empty line.
3. Importing still adds the flight to the trip it belongs to.
4. The cap still holds.

---

## 10. Stage 6 — S5, S6, S7: three menus

**Use `Menu` from `@expo/ui/swift-ui`, not `ContextMenu`.** `ContextMenu.Trigger` opens on long-press; all three of these are tap-triggered today and must stay so.

`@expo/ui` is already installed transitively. **Add it to `package.json` as a direct dependency** with `npx expo install @expo/ui` so the import does not rest on a transitive resolution. **This does not require a new native build.**

Menu items come from `@expo/ui/swift-ui`: `Button`, `Toggle`, `Picker`, `Section`, `Divider`. Menus render inside a `Host`.

### 10.0 Discovery

**S5, `app/flights.tsx`:** the local `Menu` and `MenuRow` components, their `GlassLayers`, the `overlay === 'menu'` branch, the two rows and their handlers, the trigger that opens the menu, the panel `Animated.Value`, and the `OVERLAY_RISE` / `PANEL_IN_MS` / `PANEL_OUT_MS` imports.

**S6, `components/FlightCard.tsx`:** the `Modal` gated on `mapMenuOpen`, `openMapMenu` and its guard, both `Animated.Value`s, the `GlassLayers`, the `s.mapMenu` / `s.mapMenuBody` / `s.mapMenuRoute` / `s.mapMenuLabel` / `s.mapMenuLabelOn` styles, the `routeOnMap` and `isOwnedFlight` state, the tap-swallowing inner `Pressable`, and `MAX_MAP_ROUTES` in `lib/storage.ts`.

**S7, `app/search.tsx`:** `routeAnchor`, `routePanelSize`, `routePanelMeasured`, `routeOpenDrop`, `routePanelAnim`, both entry effects, `routeAnchorRefs`, the measure-and-place block, `routePanelFlip`, `routePanelSpace`, `routePanelLeft`, `ROUTE_PANEL_EDGE`, the `GlassLayers`, `s.routeOverlayScrim`, `s.routePanelDim`, `routeDropPanel`, and every trigger that opens a dropdown.

### 10.1 S5 — My Flights menu

Replaced by a native `Menu` on the existing trigger. Two `Button` items, same labels ("Search for a flight", "Import from watchlist"), same order.

**Deleted:** local `Menu` and `MenuRow`; their `GlassLayers`; the `'menu'` arm of `Overlay`; the panel `Animated.Value` and its rise; the `OVERLAY_RISE` / `PANEL_IN_MS` / `PANEL_OUT_MS` imports once unused in the file.

**Must not change:** the two destinations.

### 10.2 S6 — map menu

Replaced by a native `Menu` on the same trigger. The route line (`${flight.from} to ${flight.to}`) becomes a `Section` title. Action rows become `Button`s with SF Symbol icons; where `mapMenuLabelOn` indicates on-ness, use `Toggle`.

**Deleted:** the `Modal`, both `Animated.View`s, both `Animated.Value`s, the `GlassLayers`, `mapMenuOpen` state, the tap-swallowing inner `Pressable`.

**Must not change — the single-guard rule.** The comment above this modal states that it renders even with no record, that `openMapMenu` is what guarantees it never opens then, and that gating in two places would let them disagree. **That rule survives.** The native menu keeps one guard, on the trigger.

`MAX_MAP_ROUTES` must still be enforced.

### 10.3 S7 — route dropdown

Replaced by a native `Menu` on each trigger. **This is the largest deletion-per-line-of-replacement in the document.** All the measuring, flipping, clamping and edge-avoidance is what UIKit does automatically.

**Deleted:** every construct listed under S7 in 10.0.

**Must not change:** the options and what selecting one does to the route board query.

### 10.4 Could break

Menu items are not `Pressable`s; handlers relying on press-in/press-out visual state must be dropped. `Toggle` state for `routeOnMap` and `isOwnedFlight` must read correctly. Native menus apply a system tint — ensure `#4ade80` appears only where it did. Verify all three remain tap-triggered.

### 10.5 Verify

1. My Flights menu opens on **tap**, two items in the same order, both work.
2. Map menu opens on **tap**, shows the route line as a section title, the on/off item shows correct state, adding a route works, and `MAX_MAP_ROUTES` still blocks the eleventh.
3. Map menu cannot be opened for a flight with no record.
4. Route dropdown opens on every trigger, including near the right edge and near the bottom, and never runs off screen.
5. Selecting an option still changes the route board.

---

## 11. Stage 7 — S8, route calendar to a native date picker

### 11.0 Discovery

In `app/search.tsx`, locate: `routeCalOpen`, `routeCalMonth`, both calendar `Animated.Value`s, the entry `useEffect`, `routeDayOffset`, `routeCalWeeks`, `routeCalCanGoBack`, `routeCalCanGoNext`, `closeRouteCal`, the `Modal` and its `g.sheetShell` sheet, its `GlassLayers`, `ROUTE_MAX_DATE_DAYS`, `ROUTE_TODAY_HOURS`, and **the branch that decides between `hours=…` alone and `hours=…&date=…`**. Also locate `zonedIsoToTs` in `lib/time.ts` and confirm which code path the picked date currently flows through.

### 11.1 Replacement

`DatePicker` from `@expo/ui/swift-ui`, inside a `Host`:

- `displayedComponents: ['date']`
- `selection` = the currently chosen date
- **`range: { start: today, end: today + ROUTE_MAX_DATE_DAYS }`**
- `onDateChange` writing the selection

Present it in a small form sheet or inline. If a sheet, `sheetAllowedDetents: ['fitToContents']`.

### 11.2 Must not change — the critical part

**The date window is a data-integrity rule, not a UI rule.** `CONTEXT.md` records that the route board is only evidenced to 60 days, and that dated single-flight lookups reach 180 because the provider returned a 400 saying so. `ROUTE_MAX_DATE_DAYS` encodes the board's limit.

**`range.end` must be derived from `ROUTE_MAX_DATE_DAYS`, not restated.** Two sources for this bound is how a user gets offered a date the provider will refuse.

**It is a local-calendar window.** `routeDayOffset` computes whole days on the device's calendar, and a comment near the parser states this explicitly. Confirm the boundary days match exactly. Off-by-one at the maximum is the failure to look for.

**The `+00:00` trap.** `zonedIsoToTs` exists because AviationStack `*_iso` fields carry incorrect offsets. Nothing here may introduce a path where a picked date becomes an ISO string that skips it. The picked date must produce the same `day` string the current code sends, by the same code path.

**The rolling-today case.** The request builder sends `hours=${ROUTE_TODAY_HOURS}` with no `date` in one branch and `&date=${day}` in the other. **Verify which branch today takes before changing anything**, and preserve it.

### 11.3 Verify

1. Picker shows a month grid.
2. Yesterday cannot be selected.
3. The day at exactly `ROUTE_MAX_DATE_DAYS` can be selected; the day after cannot.
4. Selecting today produces the same request the old calendar produced for today.
5. Selecting a future date produces the correct `date=` value on the device's local calendar, not UTC-shifted.
6. Change the device timezone far from IST and repeat 2, 3 and 5.

---

## 12. Stages 8 and 9 — the tab bar and search

**These ship together.** See 12.9. Do them alone, on a branch, with nothing else in flight.

### 12.0 Discovery

In `components/GlassTabBar.tsx`, locate and list every construct named in 12.4 before deleting anything. Report any that do not exist. Separately locate: `TAB_BAR_HEIGHT` and its importer in `app/search.tsx`; the press spring and its importer in `app/search.tsx`; the four bottom-clearance `paddingBottom` expressions; `useChrome` and `setRetracted` in `lib/chrome.tsx` and their use in `app/search.tsx`; `lib/query.tsx` in full and every `useQuery` consumer; `PLACEHOLDER_PROMPTS` and `AnimatedPlaceholder` in `app/index.tsx`; every `Keyboard.dismiss()` in `app/search.tsx` and the comment near one of them beginning "IT DOES NOT FIX THE ARITHMETIC".

### 12.1 The tab layout

`app/(tabs)/_layout.tsx` becomes a `NativeTabs` layout with four `NativeTabs.Trigger`s.

**Icon and label decisions are settled. Use exactly these:**

| Order | `name` | Label | Icon |
|---|---|---|---|
| 1 | `index` | Home | `sf={{ default: 'house', selected: 'house.fill' }}` |
| 2 | `flights` | My Flights | `sf={{ default: 'bookmark', selected: 'bookmark.fill' }}` |
| 3 | `deck` | Deck | `sf={{ default: 'building.2', selected: 'building.2.fill' }}` |
| 4 | `search` | Search | `sf="magnifyingglass"` |

Rationale, recorded so it is not relitigated: the hand-drawn My Flights icon is a bookmark today, and an airplane there would collide with the in-air card. Deck is a place, not a map, and `map` would read as the globe on the Search tab.

Compound form, verified:

- `<NativeTabs.Trigger name="index">` containing `<NativeTabs.Trigger.Icon sf={…} />` and `<NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>`
- `Icon` accepts `sf` as a string or `{ default, selected }`, plus `selectedColor`
- `Label` accepts `children: string`, `selectedStyle`, `hidden`

`NativeTabs` props:

- `tintColor: '#4ade80'`. **This is the one sanctioned exception to the green rule**: the selected tab is where the app currently is, which is the actionable position.
- `blurEffect: 'systemChromeMaterialDark'` — the same string the hand-built bar uses. The material carries over by name.
- `backgroundColor: PAGE_BG`
- `minimizeBehavior: 'onScrollDown'`
- `hidden={retracted}` reading `useChrome()` from `lib/chrome.tsx`
- **`labelStyle` unset.** San Francisco for tab labels is the decision.

**Do not use `role="search"`.** See Section 2. It would give an uncustomisable system title.

### 12.2 No rename

`ITEMS` already says `deck`. There is nothing to rename. Confirm no reference to `bookings` exists anywhere in the tree and report the result.

### 12.3 Deleted outright

The whole of `components/GlassTabBar.tsx`. Named explicitly so nothing is accidentally preserved.

**Geometry:** `LABEL_FS`, `LABEL_LINE_H`, `LABEL_ADV`, `ICON_SIZE`, `ICON_GAP`, `ITEM_CONTENT_H`, `BAR_H`, `BAR_R`, `CAPSULE_H`, `CAPSULE_TOP`, `ITEM_PAD_V`, `TRACK_PAD`, `DOCK_INSET`, `BAR_GROW`, `BAR_SCALE_Y`, `SEARCH_CIRCLE`, `SEARCH_OBJ_GAP`, `TAB_BAR_MARGIN_V`, `GLYPH_SIZE`, `pillW`, `slots`, `ovalW`, `ITEMS`, and every `ICON_*_D` path constant.

**Motion:** `SPRING`, `SPRING_END`, `PRESS_SPRING`, `PRESS_TRAVEL_LEAD`, `DRAG_SQUASH_MAX`.

**The wave:** `waveAt`, `WaveChar`, `WaveIcon`, `AnimatedG`, `AnimatedRect`.

**The pan gesture:** the entire `Gesture.Pan()` construction, `capX`, `capR`, `capOpacity`, `slotsSV`, `trackW`, `activeSV`, `lastCommitted`, `dragging`, `dragAmt`, `pressAmt`, and every `onTrackLayout` and `onSlotLayout`.

**Search mode:** `searchSV`, `searchMode`, `typing`, `kbH`, the `Keyboard.addListener` pair, `frostOpacity`, `homeAmt`, `closeAmt`, `retractAmt`, `homeGlyphAmt`, `magGlyphAmt`, `chipAmt`, `TabBarPlaceholder`, `SEARCH_PROMPTS`, `SEARCH_PROMPTS_BAR`, and the `st` keys `fullField`, `fullClip`, `fullEdge`, `fullRow`, `fullBody`, `fullInput`, `closeBtn`, `closeTap`, `glyphPill`, `glyphClip`, `glyphFill`, `glyphEdge`, `ovalGlyph`, `barFieldBody`, `barQuery`, `prompt`, `placeholder`.

**Glass:** `BarGlass`, `BAR_BLUR`, `GLASS_SUPPORTED`, both `GlassView`s, the `GlassContainer`, and B2 through B5.

**Exports:** `TAB_BAR_HEIGHT`. **Imports:** `SHEET_EDGE` and `SHEET_BLUR` from `lib/glass`.

### 12.4 Downstream consumers

| Consumer | Action |
|---|---|
| `TAB_BAR_HEIGHT` in `app/search.tsx` | Remove. See 12.6 |
| The press spring in `app/search.tsx`, reused by the map pin | Move the constant into `app/search.tsx` or a small shared module. No dangling import |
| The four bottom-clearance expressions | See 12.6 |
| Chrome retraction — `useChrome` in `app/search.tsx`, `onDrag={setRetracted}` on the globe | Keep `lib/chrome.tsx` and the wiring. Only the consumer changes: `NativeTabs` takes `hidden` |

### 12.5 Bottom clearance — smaller than earlier versions assumed

`NativeTabTriggerProps.disableAutomaticContentInsets` documents that on iOS the first scroll view nested inside a native tabs screen already has automatic content inset adjustment enabled.

**Procedure: remove all four manual paddings first, then measure on a device.** Add back only what is demonstrably missing. Do not port the hand-tuned numbers forward on the assumption they are still needed.

**One retired rule to record.** The comment above Home's clearance says three things:

1. The clearance is at the call site because it depends on a safe-area inset a `StyleSheet` cannot read.
2. It deliberately does not track the bar's height, and says "Do not 'fix' it to match."
3. 24 is deliberately not enough to clear the bar, because "a blur with nothing behind it is a grey pill, and the material only reads as glass while something is moving underneath it."

**Reason 3 is retired.** It is an argument about a hand-built floating blurred bar. `NativeTabs` renders Apple's material with Apple's scroll-edge behaviour and insets the scene. Content deliberately hidden under the bar is now just content the user cannot read.

**Reasons 1 and 2 survive in modified form** — the clearance still should not hand-track a bar height, now because the system provides it.

Leave a short note at each of the four sites recording that the under-the-glass intent was retired when the bar became native, and why.

### 12.6 Stage 9 — search

**The search field does not go into the tab bar.** `app/(tabs)/search.tsx` gains a native stack header carrying a real `UISearchController` via `headerSearchBarOptions`.

**Settled configuration:**

- `placement: 'integrated'`
- `placeholder: 'flight number or route'`
- `onChangeText` → the screen's own state
- `onSearchButtonPress` → run the search
- `onCancelButtonPress` → clear
- `textColor: '#e2e2e2'`, `hintTextColor` at the existing placeholder grey, `tintColor: '#4ade80'`
- `hideWhenScrolling: false`
- `autoCapitalize` — **decide during this stage, do not set blind.** `'characters'` is right for `6E5071` and for `DEL`, and wrong if route search accepts city names. Check what the route search actually accepts first. If it takes both, `'characters'` still wins because the machine-data case is the common one.

**This puts a header on the Search screen, which it does not have today.** That is an accepted layout change.

**The rejected alternative, recorded so it is not rediscovered:** `NativeTabs.BottomAccessory` docks arbitrary children above the tab bar and adapts via `usePlacement()`. It is closer to the current geometry but is only a container — the field's contents, focus handling and dismissal would still be hand-built. `headerSearchBarOptions` is a real system component. Prefer the component.

### 12.7 `lib/query.tsx` is deleted

It exists solely to carry text from the tab bar to the search screen across a sibling boundary. Once the field and the screen are the same route, there is no boundary. Delete the file, remove `QueryProvider` from `app/_layout.tsx`, remove every `useQuery` import.

**One rule in it deserves a decision, not a deletion.** `lib/query.tsx` uses a submit *counter* rather than a boolean, "because a boolean cannot say 'again'. Two identical searches in a row are two presses and must run twice." **Verify `onSearchButtonPress` fires on a repeated identical search.** If it does, the counter retires. If it does not, keep the counter.

### 12.8 The animated placeholder

`app/index.tsx` has `PLACEHOLDER_PROMPTS` and `AnimatedPlaceholder`. The tab bar carried a copy of both, and a TODO in the tab bar says the fix is to lift both into `lib/`.

**The tab bar's copy dies with the file, which resolves the duplication.** Home's original stays. **Do not lift anything into `lib/`** — there is only one copy now.

A native search bar takes a static `placeholder`. **The cycling placeholder is lost on the search field.** Home keeps its own.

### 12.8.1 Must not change

- **Every `Keyboard.dismiss()` in `app/search.tsx`.** One carries a comment recording that `Keyboard.dismiss()` is asynchronous and "DOES NOT FIX THE ARITHMETIC", meaning a nearby layout calculation does not wait for the keyboard. **Read the surrounding code before deleting anything there.**
- **What a search does.** Parse endpoint, chat endpoint, flight lookup and route board are untouched.
- **JetBrains Mono for the typed flight number.** `SearchBarProps` has no `fontFamily`. **This is a real loss.** Record it; do not work around it with a custom field.

### 12.8.2 A known bug — flag, do not fix

`CONTEXT.md` section 8: the search field rejects most Indian flight numbers. The pattern in `app/search.tsx` requires two letters followed by digits, so `6E5071` and `QP1133` cannot be typed. IndiGo and Akasa are the two largest carriers on this app's core routes.

This is an instance of the project's recurring **leading-digit regex assumption**, which has previously broken terminal key parsing, pier orientation, PANYNJ gate matching and dining gate hints.

**Do not fix it silently.** It is a behaviour change and this conversion is presentation-only. Flag it as a one-line change adjacent to work already being done; fix only on instruction.

### 12.9 Why 8 and 9 ship together

The search field is inside the tab bar. Deleting the bar deletes the only writer of `lib/query.tsx`, and search stops working. No ordering avoids this.

Treat them as one stage with an intermediate checkpoint: get `NativeTabs` rendering and navigating with the search field temporarily stubbed as a plain `TextInput` at the top of `app/search.tsx`, confirm items 1 to 10 below, then do Stage 9 properly and confirm 11 to 17.

### 12.10 Verify

1. Four tabs in order: Home, My Flights, Deck, Search.
2. Icons are `house`, `bookmark`, `building.2`, `magnifyingglass`, each filling on selection where a filled variant is specified.
3. Selected tab is `#4ade80`; unselected are not.
4. Apple's selection animation runs. No pill, no wave. Expected.
5. Tapping the active tab scrolls that screen to the top.
6. Scrolling down minimises the bar; scrolling up restores it.
7. Dragging the globe map hides the bar; releasing restores it.
8. **On a physical device**, the last row of content on Home, My Flights, Deck and Search is fully readable and not under the bar — **with the manual paddings removed**.
9. The bar renders dark in both device appearance modes.
10. Every flight card, status word, countdown and claim unchanged.
11. Search tab presents a native search bar with the placeholder `flight number or route`.
12. Typing filters or queries as before.
13. Return runs the search.
14. **Return twice on the same term runs it twice.**
15. Keyboard dismisses on the same interactions as before.
16. The chat assistant answers, including questions about the signed-in user's own next flight.
17. Globe map renders and drags; route search returns a board.

---

## 13. Stage 10 — S10, S11, remaining glass, icons, haptics

B2 through B5 are gone with the tab bar. Five blur surfaces remain, plus whatever `GlassLayers` sites survived Stages 2 to 7.

### 13.0 Discovery

Locate every remaining `BlurView` and `GlassLayers` render in the tree and list them. Locate `lib/glass.tsx`'s full export list and every importer. Locate the comment in `components/FlightCard.tsx` beginning "NULL, NOT A DIMMER GlassLayers" and read it in full before touching that site. Locate every `Haptics` call and every `ICON_*` SVG path constant in `components/swipe.tsx`.

### 13.1 Remaining blur

| # | Becomes |
|---|---|
| B1 | Deleted once its last caller is gone |
| B6 | `GlassView`, `glassEffectStyle="regular"` |
| B7 | `GlassView`, `glassEffectStyle="regular"`, `isInteractive` |
| B8 | `GlassView`, `glassEffectStyle="regular"`, `isInteractive` |
| B9 | **Stays a `BlurView`.** See 13.3 |

### 13.2 `GlassLayers` sites after Stages 2 to 7

Eight of the eleven are gone: two in `app/index.tsx` (Stages 2 and 3), one in `components/FlightCard.tsx` (Stage 4), two in `app/flights.tsx` (Stages 5 and 6), one more in `components/FlightCard.tsx` (Stage 6), two in `app/search.tsx` (Stages 6 and 7).

**Three remain:**

- **S10 and S11** in `lib/toast.tsx` → `GlassView`, `glassEffectStyle="regular"`. Both are floating chrome and are exactly what Apple's material is for. The in/hold/out Reanimated sequence stays; only the surface changes.
- **The conditional site in `components/FlightCard.tsx`** whose comment begins "NULL, NOT A DIMMER GlassLayers. My Flights draws the legs…" → **read the comment fully first.** It explains why an alternative was rejected. If the reasoning is about the material's darkness, converting to `GlassView` may reintroduce what it was avoiding. Read, then decide, then report the decision.

Once all three are resolved, **delete `GlassLayers` from `lib/glass.tsx`**, with `SHEET_BLUR`, `SHEET_FILL` and `g.sheetTint`.

### 13.3 Why B9 stays a `BlurView`

The comment block above it contains measured arithmetic — "two translucent layers multiply what they let through: 0.78 through the tint × 0.18 through the fill = 0.14 … Fourteen per cent of near-black over near-black is black" — and a **Dynamic Island concealment requirement**: "Inset by `insets.top`, there is no blur, no vibrancy and no backdrop sample anywhere in the island's band; the only thing painting there is a solid `#000000`."

The blur is deliberately inset from the top so nothing samples the backdrop in the island's band, and a solid `#000000` — not `#0a0a0a`, and the comment records that the five-level difference was visible — covers it, with a `LinearGradient` ramp below.

`GlassView` offers no equivalent inset control. **Converting this reintroduces a seam at the Dynamic Island.** Leave it.

**Consequence: `expo-blur` cannot be removed from `package.json`.**

The inline `s.airportCard` this blur sits inside is likewise left alone. Note its comment recording that `sheetShell`'s "NO backgroundColor" rule does not apply there — a documented exception that must survive.

### 13.4 `lib/glass.tsx` final state

**Expected survivors:** `SHEET_RULE` (a content divider), `SHEET_EDGE` (a hairline on any surviving non-sheet surface), `SHEET_RADIUS` if anything still rounds to it.

**Expected deletions:** `SHEET_BLUR`, `SHEET_FILL`, `SHEET_SCRIM`, `EASE_OUT`, `EASE_IN`, `OVERLAY_RISE`, `CAL_RISE`, `PANEL_IN_MS`, `PANEL_OUT_MS`, `CAL_IN_MS`, `CAL_OUT_MS`, `SCRIM_IN_MS`, `SCRIM_OUT_MS`, `GlassLayers`, and from `g`: `sheetTint`, `routeCalScrim`, `routeCalDim`, `sheetShell`, `sheetEdge`, `sheetBody`, `sheetBodyFill`, `sheetHead`, `sheetHeadSpacer`, `sheetTitle`, `sheetClose`.

**If every export is gone, delete the file** and remove its import from `app/index.tsx`, `app/search.tsx`, `app/flights.tsx`, `components/FlightCard.tsx` (both import statements) and `lib/toast.tsx`.

**Two rules must survive the file's death.** Both move to a comment above B9 in `components/FlightCard.tsx`. See Section 17.

### 13.5 Icons to SF Symbols

`expo-symbols` is installed and never imported. Convert where the glyph is a standard system concept:

- The four tab icons (Stage 8, already specified)
- The swipe action glyphs in `components/swipe.tsx` — the `ICON_*` path constants, including `ICON_MAP` and `ICON_MAP_ON`
- Menu item icons (Stage 6)

**Do not convert:** anything in `components/CorridorView.tsx` (bespoke schematic), anything in `components/GlobeMap.tsx`, and the `>_` and `>//` marks on Home. Those two are the app's voice and are JetBrains Mono text, not icons.

**Swipe icon choices are the owner's.** Propose SF Symbol names, show them, wait. The tab icons are already settled and need no further approval.

### 13.6 Haptics

Currently one call: `ImpactFeedbackStyle.Medium` on a committed swipe in `components/swipe.tsx`.

Add:

| Where | Feedback |
|---|---|
| Saving a flight to the watchlist | `notificationAsync(Success)` |
| Hitting the twenty-flight watchlist cap | `notificationAsync(Warning)` |
| Hitting `MAX_MAP_ROUTES` | `notificationAsync(Warning)` |
| A search returning no result | `notificationAsync(Error)` |
| Setting or clearing the Deck "I am here" pin | `impactAsync(Light)` |
| Toggling a route on or off the map | `selectionAsync()` |

**Do not add haptics to:** tab switches, sheet presentation, menu opening, or scrolling. All four have system haptics; doubling one is worse than having none.

**Every call must be `.catch(() => {})`**, matching the existing one. A haptics failure must never surface.

### 13.7 Verify

1. The three map controls on Search render as Apple glass, are legible over light and dark parts of the globe, and remain tappable.
2. Toast and undo banner render as Apple glass and are legible. Their in/hold/out timing is unchanged.
3. **The map-variant flight card still conceals the Dynamic Island with no visible seam.** Check on a device with an island, in daylight, over a light part of the map.
4. Swipe icons render as SF Symbols at the right weight and size.
5. Each new haptic fires once, not twice.
6. No haptic on tab switch beyond the system's own.
7. `lib/glass.tsx` contains only its surviving exports or is gone, and nothing imports a name that no longer exists.

---

## 14. Stage 11 — S9 and cleanup

### 14.0 Discovery

Locate: the `overlay === 'past'` branch and every reference to `'past'` in `app/flights.tsx`; the `Overlay` type and every remaining arm; `openOverlay`, `closeOverlay`, `swapOverlay`, the scrim value and the `Modal`; the local `Sheet` component if it survived Stage 5; the `LayoutAnimation` import, `configureNext` call and Android guard in `app/deck.tsx`; the RN `StatusBar` and its import in `app/index.tsx`; the screen-level `KeyboardAvoidingView` in `app/index.tsx` and **whether Home still contains any `TextInput` at all**; every `experimentalBlurMethod` prop remaining.

Separately, search `lib/landing.ts`, `lib/watch.ts` and every screen effect for the dead client-side landing sweep named in `CONTEXT.md`, and report what is found before deleting.

### 14.1 S9 and dead code

| Item | Action |
|---|---|
| **S9**, the `'past'` arm | **Delete.** Its own comment says "AND UNREACHABLE. Its entry point was removed; `overlay` cannot [be 'past']". Delete the branch, the `'past'` arm of the union, and the local `Sheet` if it is now unused |
| The `Overlay` type | All three arms are gone by this point. Delete the type, `overlay` state, `openOverlay`, `closeOverlay`, `swapOverlay`, the scrim value and the `Modal` |
| Client-side landing sweep | **Locate and delete.** Named in `CONTEXT.md`, not found in the UI sweep. Find it before deleting |
| Parts of an auto-refresh path | **Locate and report, do not delete blind.** "Parts of" is not precise enough to delete safely |
| Pending-leg retry reporting the wrong trigger name | **Leave alone.** Not a UI concern, named as harmless |

### 14.2 Platform and architecture cleanup

| Item | Action |
|---|---|
| `LayoutAnimation.configureNext` in `app/deck.tsx` | Replace with a Reanimated layout animation. Unsupported on New Architecture |
| `UIManager.setLayoutAnimationEnabledExperimental` guard | Delete. Android-only |
| `LayoutAnimation` import | Delete |
| RN `StatusBar` and its import in `app/index.tsx` | Delete. Stage 1 added `expo-status-bar` at the root |
| `Platform.OS === 'ios' ? 'padding' : 'height'` | Simplify to `'padding'` |
| `experimentalBlurMethod="dimezisBlurView"` on B9 | Delete the prop. Android-only. Retire its "not optional on Android" comment with a note that Android was dropped |

### 14.3 The screen-level `KeyboardAvoidingView`

It wraps all of Home. Home's only text input was the command line, and a comment in `lib/flightcard.tsx` records that "the command line's input is the tab bar's now, and the row it underlined was deleted."

**After Stage 9, Home may have no text input at all.** **Verify there is none before deleting.** The profile sheet has its own and is a separate route, so it does not count.

### 14.4 Unused imports

Run a full pass across every TypeScript file. Deleting eleven `GlassLayers` sites and the tab bar will leave many.

**Use the TypeScript compiler and ESLint, not grep.** The project's own rule: *AST scope check, not grep, before reporting any extraction as verified — grep has missed identifier misses before.*

### 14.5 Verify

1. `npx tsc --noEmit` clean.
2. `npm run lint` clean.
3. Deck zone expand and collapse animates smoothly.
4. Status bar is light on every screen.
5. Nothing on any screen has changed position or wording.

---

## 15. What is lost

### 15.1 Accepted before work began

- **Drag-to-switch across the tab bar.** No native equivalent, no hook to add one.
- **The per-character wave.** Roughly 800 lines exist to make it correct at four screen widths.

### 15.2 The rest

- **The sliding selection pill.** The bar's own comment calls it "the load-bearing element". `NativeTabs` has its own indicator with its own motion.
- **The grow-out-of-the-card animation on S3.**
- **Centred sheets.** S2, S3, S4 and S8 sit in the middle of the screen today. All move to the bottom. iOS has no centred sheet primitive that is not an alert.
- **The search field's font.** `SearchBarProps` has no `fontFamily`. Typed flight numbers are machine data and will render in San Francisco.
- **The search field's position.** It moves from the bottom of the screen into a header at the top. The most visible single change in the conversion, and accepted.
- **The cycling animated placeholder on the search field.** Home keeps its own.
- **JetBrains Mono in tab labels** — available, declined.
- **The exact material.** `lib/glass.tsx` carries a full transmission calculation: page `rgb(10)` through a 0.40 scrim, a black tint and a 0.22 fill, arriving at a panel ground around `rgb(3.5)` against surroundings around `rgb(6)`. `GlassView` takes `regular` or `clear`.
- **Asymmetric entry and exit curves.** 220ms in on `EASE_OUT`, 150ms out on `EASE_IN`, with the scrim 20ms ahead going in and behind coming out "so the backdrop never looks welded to the surface it sits under." Native sheets have one curve.
- **Content passing under the glass on Home.** Deliberate under-padding, retired in 12.5.
- **The hairline.** `SHEET_EDGE`, the fifth attempt at that edge and the first that is not a gradient, uniform on all four sides because RN splits corner arcs when sides differ.
- **`glassEffectStyle="clear"` while dragging.** The pill went clear during a drag: "a pane you are pushing around should not also be frosting what is under it."

### 15.3 Deliberately kept hand-built

| Kept | Reason |
|---|---|
| Swipe actions, `components/swipe.tsx` | iOS exposes no swipe-action primitive for a plain view row |
| Terminal schematic, `components/CorridorView.tsx` | Bespoke data visualisation |
| Globe map, `components/GlobeMap.tsx` | Explicitly deferred |
| Map-variant card blur, B9 | Dynamic Island concealment needs an inset native glass does not offer |
| Inline airport card | Not a presented surface |
| Toast and undo motion | Surface becomes `GlassView`; the sequence has no system equivalent worth chasing |
| Flight card phases | Product logic, not chrome |
| `>_` and `>//` on Home | The app's voice |

---

## 16. Register of retired rules

Every rule below is deleted along with its code. Each needs a one-line note at the deletion site recording that it was retired and why it can no longer occur. **Nothing may be dropped without an entry here.**

| # | Rule | Home | Why it can no longer occur |
|---|---|---|---|
| R1 | "THE GESTURE'S CONFIGURATION AND STATE MUST NEVER DEPEND ON `searchMode`" | `components/GlassTabBar.tsx` | There is no gesture |
| R2 | "SEARCH MODE MAY NEVER AFFECT THE gesture's lifecycle or view presence — only what callbacks do" | `components/GlassTabBar.tsx` | Same |
| R3 | "A SECOND REF AND NOT `pressOutTimer`" | `components/GlassTabBar.tsx` | No press timers remain |
| R4 | "THE MEASUREMENTS NEVER MOVE" / "THE MEASUREMENT IS NEVER TORN DOWN" | `components/GlassTabBar.tsx` | No measurement remains |
| R5 | "A ZERO BOX IS NEVER WORTH REPORTING" | `components/GlassTabBar.tsx` | No `onLayout` remains |
| R6 | "A TRANSFORM AND NEVER A LAYOUT" | `components/GlassTabBar.tsx` | The bar no longer animates its own box |
| R7 | Home's clearance reason 3: content must pass under the bar because "a blur with nothing behind it is a grey pill" | `app/index.tsx` | The bar is Apple's material with Apple's scroll-edge behaviour, and the scene is inset |
| R8 | `g.sheetHeadSpacer`'s width arithmetic, existing to optically centre a title against a close button | `lib/glass.tsx` | A native header centres its own title |
| R9 | "dimezisBlurView is not optional on Android" | `lib/glass.tsx`, `components/FlightCard.tsx` | Android was dropped from scope |
| R10 | The submit-counter rule in `lib/query.tsx`, "a boolean cannot say 'again'" | `lib/query.tsx` | **Conditional.** Retires only if `onSearchButtonPress` fires on a repeated identical search. Verify first; if it does not, this rule moves to Section 17 instead |

---

## 17. Register of surviving rules and their new homes

Every rule below outlives the code that documents it. **Each must be physically moved to the stated destination in the same commit that deletes its original home.**

| # | Rule | Original home | New home |
|---|---|---|---|
| S-1 | Never `.enabled()` on a gesture | `components/GlassTabBar.tsx` | Comment block at the top of `components/swipe.tsx` |
| S-2 | Never `.onTouchesDown()` with `manager.fail()` | `components/GlassTabBar.tsx` | Same |
| S-3 | No early returns in gesture callbacks; guards are conditions on statements | `components/GlassTabBar.tsx` | Same |
| S-4 | Worklets may only concatenate primitives and shared-value reads into `runOnJS`; plain function calls as arguments throw silently on the UI thread | `components/GlassTabBar.tsx` | Same |
| S-5 | Shared values written by a component that unmounts inside its own press handler must be reset in `onPress`, not only `onPressOut` | `components/GlassTabBar.tsx` | Same |
| S-6 | "Anything white behind a `BlurView` washes the entire surface grey" | `lib/glass.tsx` | Comment above B9 in `components/FlightCard.tsx` |
| S-7 | "NO `backgroundColor`. The blur samples what is drawn behind it, and an ancestor's background counts as behind it" | `lib/glass.tsx`, `g.sheetShell` | Same |
| S-8 | "An unbounded ScrollView does not scroll" — a sheet body inside a fixed-height sheet must be `flex: 1` | `lib/glass.tsx`, `g.sheetBodyFill` | One-line comment in `app/archive.tsx` and any other sheet route with a scrolling body |
| S-9 | The map menu's single-guard rule: gating in two places lets them disagree | `components/FlightCard.tsx` | The native menu's trigger, same file |
| S-10 | `sheetShell`'s "NO backgroundColor" does not apply to the inline `s.airportCard` | `components/FlightCard.tsx` | Stays in place, untouched |
| S-11 | Home's clearance reasons 1 and 2: it cannot live in a `StyleSheet`, and it must not hand-track a bar height | `app/index.tsx` | Rewritten in place — now because the system provides the inset |
| S-12 | `Keyboard.dismiss()` is asynchronous and "DOES NOT FIX THE ARITHMETIC" | `app/search.tsx` | Stays in place. Read before touching the surrounding code |
| S-13 | `BottomTabBarProps` and navigation types come from `expo-router`, not `@react-navigation/*` | `components/GlassTabBar.tsx` | Comment in `app/(tabs)/_layout.tsx` |
| S-14 | The leading-digit regex assumption is a recurring bug shape — five known instances | `CONTEXT.md` | Stays. Referenced by 12.8.2 |

---

## 18. Dependencies

### 18.1 To add

| Package | Why | Note |
|---|---|---|
| `@expo/ui` | `Menu` (Stage 6), `DatePicker` (Stage 7) | **Already installed at 57.0.15** as a dependency of `expo-router`. Promote to a direct dependency with `npx expo install @expo/ui`. **No new native build required** |

### 18.2 Installed, unused, becomes used

`expo-symbols` — all standard icons. `expo-status-bar` — already in `app.json` plugins, never imported.

### 18.3 Installed, use expands

`expo-haptics`, one call site to seven. `expo-glass-effect`, tab bar only to map controls, toast and undo banner.

### 18.4 To remove

**None.** `expo-blur` stays for B9. `react-native-svg` stays for `CorridorView`. `react-native-gesture-handler` stays for `swipe.tsx`, `search.tsx` and `FlightCard.tsx`. `react-native-reanimated` stays in five files. `expo-linear-gradient` stays for the map card ramp. `react-native-webview` stays for the globe. `@react-navigation/*` is not a direct dependency and must not become one — use expo-router's re-exports.

### 18.5 Rebuild

**No new native build is required for any stage.**

---

## 19. Stage order

| Stage | Name | Ships alone | Depends on |
|---|---|---|---|
| 1 | Dark appearance and root Stack | Yes | — |
| 2 | S1 profile sheet | Yes | 1 |
| 3 | S2 archive sheet | Yes | 1 |
| 4 | S3 airport sheet | Yes | 1 |
| 5 | S4 import sheet | Yes | 1 |
| 6 | S5, S6, S7 menus | Yes | 5 |
| 7 | S8 calendar | Yes | — |
| 8 | Tab bar to NativeTabs | **No — with 9** | 1 |
| 9 | Search to headerSearchBarOptions | **No — with 8** | 8 |
| 10 | S10, S11, remaining glass, icons, haptics | Yes | 2–9 |
| 11 | S9 and cleanup | Yes | 10 |

Stages 2 through 7 are independent of each other and may be reordered freely. Stage 8/9 comes after them: the sheets and menus need the root Stack, and sheet behaviour is easier to verify against a tab bar that has not just changed.

**One stage per commit. Stage 1 alone on a branch first, with its eight verifications on a device before anything else begins.**

---

## 20. Open questions

Two things no type file answers. Both are settled on a device during Stage 9.

1. **Does `onSearchButtonPress` fire on a repeated identical search?** Decides whether `lib/query.tsx`'s submit counter dies (R10) or survives (moves to Section 17).
2. **What does route search actually accept — codes only, or city names too?** Decides `autoCapitalize`. See 12.6.
