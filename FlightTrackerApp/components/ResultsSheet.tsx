// THE RESULTS, IN A SHEET OF THIS APP'S OWN.
//
// IT WAS A UISheetPresentationController, a sibling route presented as a
// formSheet, and that sheet could not be made full-width: react-native-screens
// 4.26 does not expose edge attachment, and on iOS 26 a partial-height form
// sheet floats in from the sides with a gap under it. So the sheet is built
// here, on the map screen, as an overlay -- and everything about its motion
// that used to be UIKit's is written in the SHELL at the top of the component:
// the pan, the springs, the detents, the rubber band, the dismiss, the grabber,
// the dim. What is INSIDE it is the body, unchanged from the route: the pill,
// the controls, the two picker Modals and the list.
//
// WHERE IT SITS. Under the tab bar, always -- a view in the tab's content is
// drawn beneath the UITabBar, and the one thing that draws above the bar (a
// Modal) takes every touch on the screen and would kill the map. So the
// sheet's surface runs to the screen's bottom edge BEHIND the bar, its content
// is padded above the bar by the bar's inset, and its three heights are
// measured from the screen's bottom: the bar inset plus the head, half the
// sheet's maximum, and nine tenths of it. See sheetGeometry in
// lib/routeResults.
//
// THE GESTURE MODEL. One Pan on the sheet, one Native gesture on the list,
// run simultaneously. The pan works in DELTAS, not total translation, so who
// owns a frame can change mid-drag: the list may scroll only while the sheet
// is at its largest, and even then a downward delta with the list at offset
// zero belongs to the sheet. Everything the pan decides it decides on the UI
// thread; runOnJS is spent on two things only, reporting the settled detent
// and asking to close.
//
// THE PHYSICS. A critically damped spring, response 0.45s. A fling of
// SHEET_FLING or more goes one detent in its direction and never two; slower,
// the nearest detent. Above the largest detent the excess is rubber-banded on
// UIKit's own curve; below the smallest there is no band, because that is the
// dismiss path: the sheet tracks the finger 1:1 and lets go at the threshold.
//
// WHAT IT READS. The board, the sort, the filters, the date and every derived
// list come from lib/routeResults, the provider mounted above the search
// Stack. What it writes back is the sort, the filters, the date, which detent
// it settled at, and -- when it has dropped off the bottom -- that it is gone.
//
// THE SURFACE IS GLASS, AND THE GLASS THINS AS THE SHEET RISES. At the small
// detent the sheet is a control over a map and wants to read as chrome; at the
// large one it is a list somebody is reading and wants to read as a page. One
// material, one tint, and the tint's alpha follows the HEIGHT, continuously.
//
// HOW THE ALPHA MOVES. tintColor on GlassView is a colour string on a wrapped
// native view, which no animation driver can interpolate. So the glass carries
// the LARGE detent's tint as a constant, and a second layer -- the page black
// at an animated opacity -- sits over it and carries the difference. Two
// alphas stack as 1 - (1 - a)(1 - b), so with the glass at 0.3 the veil is
// solved per detent for a combined 0.7, 0.5 and 0.3:
//
//     small   1 - 0.3/0.7 = 0.571
//     middle  1 - 0.5/0.7 = 0.286
//     large   0
//
// and interpolated between them by the sheet's height, on the UI thread.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Keyboard,
  Modal,
  Pressable,
  Dimensions,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { GlassView } from 'expo-glass-effect';
// THE GESTURE AND THE MOTION. The five rules at the top of components/swipe.tsx
// apply to the pan below: no .enabled(), no manager.fail() from a touch
// callback, no early returns in a worklet, primitives only into runOnJS.
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps, useAnimatedScrollHandler,
  withSpring, interpolate, Extrapolation, runOnJS,
} from 'react-native-reanimated';
import { localIsoDate } from '../lib/saved';
import { WEEKDAYS, MONTHS, routeDateLabel } from '../lib/flightstatus';
import {
  SHEET_RADIUS, SHEET_EDGE, SHEET_SCRIM,
  GlassLayers,
  EASE_OUT, EASE_IN, OVERLAY_RISE, CAL_RISE,
  PANEL_IN_MS, PANEL_OUT_MS, CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  g,
} from '../lib/glass';
import {
  CARD_FILL, CARD_GAP, PAGE_BG, PAGE_RGB, SURFACE_EDGE, GLASS_DARK, GLASS_RADIUS,
} from '../lib/cards';
import { trimAirportName } from './FlightCard';
import { RouteRow } from './RouteRow';
import { airportByCode } from '../lib/airports';
import {
  useRouteResults,
  SHEET_GRABBER_CLEARANCE, SHEET_PILL_PAD, SHEET_PILL_LINE, SHEET_HEAD_PAD,
  ROUTE_MAX_DATE_DAYS, ROUTE_SORT_LABELS, ROUTE_SORT_PILLS, ROUTE_SORT_CAPSULE,
  ROUTE_BANDS,
  type RouteBand, type RouteFlight,
} from '../lib/routeResults';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

// THE GLASS'S OWN TINT, which is the LARGE detent's: the page black at 0.3, the
// same value the bubble on the map carries at half strength. See the note at
// the top for how the other two detents are reached from it.
const SHEET_TINT = `rgba(${PAGE_RGB},0.3)`;
// THE VEIL OVER IT, AT EACH DETENT, in the order sheetGeometry declares them;
// the shell interpolates between these by height. See the arithmetic at the top.
const SHEET_VEIL = [0.571, 0.286, 0] as const;
// THE BUBBLE'S OWN TINT, which is the page black at half strength -- the same
// value the map screen's bubble carries, spelled from the same components. The
// sort dropdown wears it so the panel and the pill it opens from read as the
// one piece of chrome.
const BUBBLE_TINT = `rgba(${PAGE_RGB},0.5)`;

// ── THE SHEET'S MOTION ──────────────────────────────────────────────────────
//
// CRITICALLY DAMPED, RESPONSE 0.45s, which is the sheet UIKit draws: it lands
// and does not bounce. stiffness = (2 pi / 0.45)^2 = 195; damping = 2 sqrt(195)
// = 28 at mass 1. Overshoot is clamped so a hard fling cannot carry the sheet
// past the detent it was sent to. Not SWIPE_SPRING: that is a row's return at
// a ratio of 0.94, a different motion for a different thing.
const SHEET_SPRING = { mass: 1, stiffness: 195, damping: 28, overshootClamping: true };
// A FLING, in points per second. At or above this the sheet goes ONE detent in
// the fling's direction, never two, which is what UIKit's sheet does with a
// flick; under it the sheet settles at the nearest detent.
const SHEET_FLING = 400;
// WHEN A DRAG BELOW THE SMALL DETENT LETS GO. Released this far under it, or
// flung downward this fast at or under it, the sheet is dismissed; otherwise it
// springs back to the small detent.
const SHEET_DISMISS_BELOW = 40;
const SHEET_DISMISS_VEL = 500;
// THE RUBBER BAND ABOVE THE LARGEST DETENT, UIKit's own curve and constant:
// shown = (1 - 1 / (excess * c / d + 1)) * d, with d the sheet's own height.
const SHEET_BAND = 0.55;
// THE GRABBER, UIKit's own dimensions: 36 by 5, five points down. Its ink is
// the bubble's meta ink, an existing colour and nothing new.
const SHEET_GRABBER_W = 36;
const SHEET_GRABBER_H = 5;
const SHEET_GRABBER_TOP = 5;
const SHEET_GRABBER_INK = 'rgba(226,226,226,0.45)';

function rubber(excess: number, dimension: number): number {
  'worklet';
  return (1 - 1 / ((excess * SHEET_BAND) / dimension + 1)) * dimension;
}

// THE LABEL BUDGET, in the pieces it is computed from.
//
// The pills STRETCH: each is flex: 1, so a row of n divides the screen evenly
// and every pill's width is known from the layout alone —
//
//     pill = (screen - 2 x SCROLL_PAD - (n-1) x GAP) / n
//     text = pill - CHROME,  and one character is 6.6pt
//
// which makes the budget per-pill and fixed, not shared across the row. There is
// nothing left to allocate between pills, so the round-robin that used to hand
// out a row-wide budget is gone with the content sizing that needed it.
//
// CHROME is 28, not the 36 it was. Stretched thirds are narrow — 88pt at 320pt —
// and at 36 the text budget came to 7 characters, which is under "Departure",
// "duration" and "Filters 3", all of which render today. Trimming the pill's
// horizontal padding from 10 to 8 and the chevron's left margin from 8 to 4
// buys 9 characters and keeps every existing label intact.
const ROUTE_SCROLL_PAD = 20;    // sh.controls paddingHorizontal
const ROUTE_PILL_CHROME = 28;   // 16 padding + 2 border + 4 chevron margin + 6 chevron
const ROUTE_PILL_GAP = 8;       // s.routePillRow gap
const ROUTE_MONO_ADVANCE = 6.6; // JetBrains Mono, fontSize 11
// The picker's "from"/"to" caption sits OUTSIDE the pill, so it comes off the
// pill's budget: s.routeEndSide's 28pt width plus its 8pt marginRight.
const ROUTE_END_SIDE_WIDTH = 36;

// A cap on how wide the panel may GROW, so a long airline name wraps inside it
// rather than running off the right of a 320pt display. "Pakistan International
// Airlines (2)" alone measures 267pt.
//
// It is not what the panel is positioned against: the placement clamp reads the
// panel's measured width. Using this instead treated every panel as if it were
// the widest one possible.
const ROUTE_PANEL_MAX_WIDTH = 260;

// Distance from the panel to its trigger, and the margin it keeps from the
// bottom of the window. A panel only ever opens downward now -- see
// openRouteDrop -- so there is no side to decide.
const ROUTE_PANEL_GAP = 6;
const ROUTE_PANEL_EDGE = 12;

// "16 Sep" for the date pill, where routeDateLabel's "Sat 29 Aug" costs four
// characters the row cannot spare. The weekday is the first thing to go: a day
// and month alone are unambiguous inside a 60-day window.
function routeShortDate(iso: string | null): string {
  if (!iso) return 'Today';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "London Gatwick Airport" -> "London Gatwick".
//
// Past trimAirportName's parenthetical, two words carry nothing on a control
// that is already an airport picker. Both are dropped ANYWHERE they appear, not
// just at the end: BWI is "Baltimore/Washington International Thurgood Marshall
// Airport" and EZE is "Ezeiza International Airport - Ministro Pistarini", so a
// trailing-only rule would miss both.
function routeAirportShort(name: string): string {
  const base = trimAirportName(name);
  const cut = base
    .replace(/\bInternational\b/gi, ' ')
    .replace(/\bAirports?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s–-]+|[\s–-]+$/g, '');
  return cut === '' ? base : cut;
}

// Clips to `room` characters INCLUDING the ellipsis, at a word boundary when
// that does not throw away more than half of what was asked for.
function routeClip(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = text.slice(0, room - 1);
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.ceil(room / 2) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s–,-]+$/, '')}…`;
}

// The airport picker's label: the airport, and nothing else.
//
//   1. name and code   "London Gatwick (LGW)"
//   2. name alone      "Tenerife Norte-Ciudad de La Laguna"
//   3. name clipped    "Sao Paulo/Guarulhos-Governor..."
//
// No count. A "+3 more" beside one airport name reads as three things selected
// rather than three available, and the chevron already says the control opens.
function routeEndLabel(code: string, name: string, cap: number): string {
  const short = routeAirportShort(name);
  const withCode = `${short} (${code})`;
  if (withCode.length <= cap) return withCode;
  if (short.length <= cap) return short;
  return routeClip(short, cap);
}

export function ResultsSheet() {
  // THE TAB BAR'S INSET, which is what this screen's provider reports: the
  // home indicator and the bar, 83 on the device this was measured on. The
  // sheet's surface runs under the bar; its content stops above it.
  const insets = useSafeAreaInsets();
  // The hook, not Dimensions.get: this has to re-render on rotation, or the
  // labels would keep the width they were built for. The height is for the
  // glass -- see the header in the render.
  const { width: routeWinWidth, height: winHeight } = useWindowDimensions();
  const {
    routeResult,
    routeDate, setRouteDate,
    routeSort, setRouteSort,
    routeDepBands, setRouteDepBands,
    routeArrBands, setRouteArrBands,
    routeAirlinesOff, setRouteAirlinesOff,
    routePick,
    setRouteSelectedKey,
    runRouteLookup,
    routeRowKey,
    routeShown,
    routeAirlineOptions, routeAirOn,
    routeDepCounts, routeArrCounts, routeAirCounts,
    routeSorted,
    routeActiveFilters, routeControlsDirty,
    resetRouteControls,
    setSheetPresented, sheetClosing, setSheetClosing,
    sheetDetent, setSheetDetent, sheetHeights,
    hostLoading,
  } = useRouteResults();

  // ── THE SHELL ─────────────────────────────────────────────────────────────
  //
  // THE HEIGHT IS THE ONE VALUE. sheetH is how tall the sheet is, measured from
  // the screen's bottom edge, and everything else is read off it on the UI
  // thread: the transform that places it, the veil, the dim, whether the list
  // may scroll. The three detents are shared values too, so the gesture --
  // built once -- reads whatever this device and rotation say they are.
  const sheetH = useSharedValue(0);
  const [smallHeight, midHeight, largeHeight] = sheetHeights;
  const smallH = useSharedValue(smallHeight);
  const midH = useSharedValue(midHeight);
  const largeH = useSharedValue(largeHeight);
  useEffect(() => {
    smallH.value = smallHeight;
    midH.value = midHeight;
    largeH.value = largeHeight;
  }, [smallHeight, midHeight, largeHeight, smallH, midH, largeH]);
  // THE DRAG'S OWN BOOKKEEPING. rawH is where the finger has put the sheet
  // before the rubber band is applied; lastTy is the last translation seen, so
  // each frame is a delta. releaseV carries a fling's velocity from the worklet
  // that decided to dismiss to the effect that runs the dismissal.
  const rawH = useSharedValue(0);
  const lastTy = useSharedValue(0);
  const releaseV = useSharedValue(0);
  // THE LIST'S TWO FACTS: where it is scrolled to, and whether a finger is on
  // it. Both are what decide, at the large detent, whether a frame belongs to
  // the list or to the sheet.
  const scrollY = useSharedValue(0);
  const listActive = useSharedValue(false);

  // ── GONE, AND THE MAP SCREEN IS TOLD ──────────────────────────────────────
  //
  // Called on the JS thread once the dismiss spring has landed at zero, from
  // either path -- a drag off the bottom, or the map screen asking through
  // sheetClosing. The detent goes back to the first so the next presentation
  // opens at the small detent, and the presented flag is what unmounts this.
  const finishDismiss = useCallback(() => {
    setSheetDetent(0);
    setSheetClosing(false);
    setSheetPresented(false);
  }, [setSheetDetent, setSheetClosing, setSheetPresented]);

  // ── PRESENTING, AND CLOSING ───────────────────────────────────────────────
  //
  // ONE EFFECT, ON ONE FLAG. Mounting is presentation: the sheet is at zero
  // and springs to its detent. sheetClosing going true is dismissal: it springs
  // to zero and, if that spring finishes, reports. And sheetClosing going back
  // to false WHILE MOUNTED is a presentation that arrived mid-dismissal -- the
  // route resolved again under a closing sheet -- so it springs back up, and
  // the cancelled spring's callback sees finished false and reports nothing.
  useEffect(() => {
    if (sheetClosing) {
      sheetH.value = withSpring(0, { ...SHEET_SPRING, velocity: releaseV.value }, finished => {
        'worklet';
        if (finished) runOnJS(finishDismiss)();
      });
      releaseV.value = 0;
    } else {
      sheetH.value = withSpring(sheetHeights[sheetDetent], SHEET_SPRING);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetClosing]);

  // ── THE LIST'S GESTURE ────────────────────────────────────────────────────
  //
  // A Native gesture on the scroll view, so the pan can run simultaneously
  // with it and so the pan can know a finger is on the list at all. Built
  // once: a gesture object swapped under a finger loses the touch.
  //
  // THE IMMUTABILITY RULE IS OFF FOR THE TWO GESTURES, and only for them. It
  // reads a shared value written inside useMemo as a render-time mutation of
  // something an effect depends on. These writes are worklets: they run on the
  // UI thread when a finger moves, never during render, and a shared value is
  // exactly the thing built to be written from there. The memo is only how the
  // gesture is built once.
  /* eslint-disable react-hooks/immutability */
  const native = useMemo(
    () => Gesture.Native()
      .onBegin(() => { 'worklet'; listActive.value = true; })
      .onFinalize(() => { 'worklet'; listActive.value = false; }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── THE PAN ───────────────────────────────────────────────────────────────
  //
  // WHO OWNS A FRAME. The list may scroll only at the largest detent. There,
  // with a finger on it, an upward delta or any delta while it is scrolled
  // past zero is the list's and the sheet holds still; a downward delta at
  // offset zero is the sheet's. Everywhere else every delta is the sheet's,
  // and scrollEnabled below is what stops the scroll view taking any of them.
  //
  // DELTAS, so the handover happens whenever the list REACHES zero mid-drag,
  // not only at the touch that started it. rawH accumulates the unbanded
  // position and the band is applied on the way to sheetH; while the list
  // owns a frame rawH is pinned to the sheet's real height so the next frame
  // the sheet owns starts from where it actually is.
  //
  // ON RELEASE. Under the small detent past the threshold, or flung down at
  // it, the sheet is dismissed -- the effect above runs that spring, with the
  // fling's velocity carried across in releaseV. Otherwise one detent in the
  // fling's direction, or the nearest, and the settled index goes to the
  // provider so the map screen's bubble can clear it.
  const pan = useMemo(
    () => Gesture.Pan()
      .simultaneousWithExternalGesture(native)
      .onStart(e => {
        'worklet';
        lastTy.value = e.translationY;
        // Assigning the value is what cancels a spring still in flight.
        sheetH.value = sheetH.value;
        rawH.value = sheetH.value;
      })
      .onUpdate(e => {
        'worklet';
        const dy = e.translationY - lastTy.value;
        lastTy.value = e.translationY;
        const large = largeH.value;
        const atTop = sheetH.value >= large - 0.5;
        const listOwns = atTop && listActive.value && (scrollY.value > 0 || dy < 0);
        if (listOwns) {
          rawH.value = sheetH.value;
        } else {
          const raw = rawH.value - dy;
          rawH.value = raw;
          sheetH.value = raw > large
            ? large + rubber(raw - large, large)
            : Math.max(0, raw);
        }
      })
      .onEnd(e => {
        'worklet';
        // Upward is positive from here on: the sheet's height grows as the
        // finger travels up the screen.
        const v = -e.velocityY;
        const h = sheetH.value;
        const small = smallH.value;
        const mid = midH.value;
        const large = largeH.value;
        const dismiss = h < small - SHEET_DISMISS_BELOW
          || (h <= small + 1 && v < -SHEET_DISMISS_VEL);
        if (dismiss) {
          releaseV.value = v;
          runOnJS(setSheetClosing)(true);
        } else {
          let idx = 0;
          if (v >= SHEET_FLING) {
            idx = h < small - 1 ? 0 : h < mid - 1 ? 1 : 2;
          } else if (v <= -SHEET_FLING) {
            idx = h > large + 1 ? 2 : h > mid + 1 ? 1 : 0;
          } else {
            const dS = Math.abs(h - small);
            const dM = Math.abs(h - mid);
            const dL = Math.abs(h - large);
            idx = dS <= dM && dS <= dL ? 0 : dM <= dL ? 1 : 2;
          }
          const target = idx === 0 ? small : idx === 1 ? mid : large;
          sheetH.value = withSpring(target, { ...SHEET_SPRING, velocity: v });
          runOnJS(setSheetDetent)(idx);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  /* eslint-enable react-hooks/immutability */

  // ── WHAT THE HEIGHT DRIVES ────────────────────────────────────────────────
  //
  // The sheet is a box of the LARGE height anchored to the screen's bottom,
  // translated down by whatever it is short of that. The list may scroll only
  // at the top. The veil thins and the dim thickens with the height, both
  // clamped to their ends.
  const onListScroll = useAnimatedScrollHandler({
    onScroll: e => { scrollY.value = e.contentOffset.y; },
  });
  const listProps = useAnimatedProps(() => ({
    scrollEnabled: sheetH.value >= largeH.value - 0.5,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: largeH.value - sheetH.value }],
  }));
  const veilStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      sheetH.value,
      [smallH.value, midH.value, largeH.value],
      [SHEET_VEIL[0], SHEET_VEIL[1], SHEET_VEIL[2]],
      Extrapolation.CLAMP,
    ),
  }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      sheetH.value,
      [midH.value, largeH.value],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));
  // THE DIM TAKES A TOUCH ONLY AT THE LARGE DETENT, once settled, and a tap on
  // it dismisses the sheet -- which is what a tap on UIKit's dimming view does.
  // Below that detent it is not there to a finger at all, so the map is.
  const dimActive = sheetDetent === 2 && !sheetClosing;
  const dismissFromDim = () => { setSheetClosing(true); };

  // ── A TAP SELECTS ─────────────────────────────────────────────────────────
  //
  // THE BUBBLE ON THE MAP IS WHAT A ROW IS CHOSEN INTO, and opening the card is
  // the bubble's own tap. Nothing is dismissed: the bubble is in the band above
  // this sheet at the small detent, and at the others the person is reading a
  // list and can bring the sheet down when they are done choosing.
  const selectRow = (r: RouteFlight) => {
    Keyboard.dismiss();
    setRouteSelectedKey(routeRowKey(r));
  };

  // ── THE PICKERS, WHICH CAME WITH THEIR TRIGGERS ───────────────────────────
  //
  // Everything from here to the render is the calendar and the anchored filter
  // panels, moved from the search screen unchanged: their state, their two
  // Modals, their measurement and placement. A Modal renders above the sheet
  // as it rendered above the drawer, and measureInWindow reads a trigger inside
  // a sheet as it read one inside a drawer.
  const [routeCalOpen, setRouteCalOpen] = useState(false);
  // The month the grid is showing, independent of what is selected.
  const [routeCalMonth, setRouteCalMonth] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  // Where the open panel floats, measured from its trigger in window
  // coordinates so the panel can live in a Modal and still sit under its
  // control. `top` is the placement -- under the trigger -- and spaceBelow is
  // how much of the window is left under that line. `bottom` and spaceAbove
  // are measured for the one panel that is allowed to rise; see
  // routePanelRises.
  //
  // x and width are the TRIGGER's own geometry, stored unclamped. Nothing here
  // can decide the horizontal placement, because that needs the panel's width
  // and the panel has not laid out yet.
  const [routeAnchor, setRouteAnchor] = useState<{
    x: number;
    width: number;
    screen: number;
    top: number;
    bottom: number;
    spaceBelow: number;
    spaceAbove: number;
  } | null>(null);
  // The panel's own size, reported by onLayout on its first pass. Null until
  // then, which is also what holds the fade back — see routePanelMeasured.
  const [routePanelSize, setRoutePanelSize] = useState<{ w: number; h: number } | null>(null);
  const routePanelMeasured = routePanelSize !== null;
  const [routeFiltersOpen, setRouteFiltersOpen] = useState(false);
  // One slot, so opening any control closes the others by construction. 'sort'
  // is the green pill's own dropdown -- the same anchored panel the filters
  // open, on a glass surface of its own. See the panel in the render.
  const [routeOpenDrop, setRouteOpenDrop] =
    useState<null | 'sort' | 'dep' | 'arr' | 'air' | 'orig' | 'dest'>(null);

  // Four values, not two: each overlay drives its content and its scrim
  // separately, so the backdrop can run its own timing. Every property either
  // value touches is opacity or transform, so all of it is native-driven and
  // none of it can move the layout underneath.
  const routePanelAnim = useRef(new Animated.Value(0)).current;
  const routeScrimAnim = useRef(new Animated.Value(0)).current;
  const routeCalAnim = useRef(new Animated.Value(0)).current;
  const routeCalScrimAnim = useRef(new Animated.Value(0)).current;

  // The scrim owes nothing to layout, so it starts on the tap rather than
  // waiting behind the panel's measuring pass.
  useEffect(() => {
    if (routeOpenDrop === null) return;
    routeScrimAnim.setValue(0);
    Animated.timing(routeScrimAnim, {
      toValue: 1, duration: SCRIM_IN_MS,
      easing: EASE_OUT, useNativeDriver: true,
    }).start();
  }, [routeOpenDrop, routeScrimAnim]);

  // Waits for the measurement, so the panel enters already on the correct side.
  // Depends on the boolean rather than the height itself: a re-layout that
  // happens to change the height must not replay the entrance.
  useEffect(() => {
    if (routeOpenDrop === null || !routePanelMeasured) return;
    routePanelAnim.setValue(0);
    Animated.timing(routePanelAnim, {
      toValue: 1, duration: PANEL_IN_MS,
      easing: EASE_OUT, useNativeDriver: true,
    }).start();
  }, [routeOpenDrop, routePanelMeasured, routePanelAnim]);

  useEffect(() => {
    if (!routeCalOpen) return;
    routeCalAnim.setValue(0);
    routeCalScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(routeCalScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(routeCalAnim, {
        toValue: 1, duration: CAL_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [routeCalOpen, routeCalAnim, routeCalScrimAnim]);

  // Characters available inside the picker pill, which shares its row with the
  // "from"/"to" caption. One number for both pills, sized on the wider caption,
  // so the two can never disagree about how much of a name fits.
  const routeEndCharBudget = () => Math.floor(
    (routeWinWidth - 2 * ROUTE_SCROLL_PAD - ROUTE_END_SIDE_WIDTH - ROUTE_PILL_CHROME)
    / ROUTE_MONO_ADVANCE,
  );

  // Characters available inside ONE pill of a row of n, at the width the app is
  // actually running at. Every pill in the row gets the same, because every pill
  // is the same width.
  const routePillCharBudget = (pills: number) => Math.floor(
    ((routeWinWidth - 2 * ROUTE_SCROLL_PAD - (pills - 1) * ROUTE_PILL_GAP) / pills
      - ROUTE_PILL_CHROME) / ROUTE_MONO_ADVANCE,
  );

  // Which single name stands in for the rest. SHORTEST wins, but a single-word
  // name beats a multi-word one before length is even considered: "IndiGo +2"
  // reads as a name with a remainder, where "Air India +2" reads as a phrase cut
  // in half — and it is longer besides. Ties break alphabetically, so the choice
  // never depends on the order the provider happened to return them in.
  const routePickName = (names: string[]): string =>
    [...names].sort((a, b) =>
      Number(a.includes(' ')) - Number(b.includes(' '))
      || a.length - b.length
      || a.localeCompare(b))[0];

  // Every form a selection pill could take, LONGEST FIRST. The last entry is the
  // floor — what the pill falls back to when nothing else fits — and it is the
  // floors, not the individual labels, that guarantee a row never wraps.
  const routeSelChoices = (
    noun: string,
    abbrev: string,
    on: string[],
    total: number,
  ): string[] => {
    if (on.length === total) return [noun, abbrev];
    const out: string[] = [];
    if (on.length > 0) out.push(on.join(', '));
    if (on.length > 1) out.push(`${routePickName(on)} +${on.length - 1}`);
    out.push(`${abbrev} ${on.length}/${total}`);
    out.push(`${abbrev} ${on.length}`);
    return out;
  };

  // Each pill independently takes the longest form that fits ITS width.
  const routeFitRow = (choices: string[][]): string[] => {
    const cap = routePillCharBudget(choices.length);
    return choices.map(c => c.find(l => l.length <= cap) ?? c[c.length - 1]);
  };

  // Row one. TWO PILLS NOW, NOT THREE: the ordering left the row for the green
  // pill above it, so the date and the filters share the width between them.
  const routeRowOne = routeFitRow(
    routeResult !== null && routeShown > 0
      ? [
        routeDate === null ? ['Today'] : [routeDateLabel(routeDate), routeShortDate(routeDate)],
        routeActiveFilters.length === 0
          ? ['Filters']
          : [`Filters (${routeActiveFilters.length})`, `Filters ${routeActiveFilters.length}`],
      ]
      // An empty board renders the date alone, so it is budgeted alone.
      : [routeDate === null ? ['Today'] : [routeDateLabel(routeDate), routeShortDate(routeDate)]],
  );
  const routeDatePill = routeRowOne[0];
  const routeFiltersPill = routeRowOne[1];

  // Row two. A band is eleven characters and a third of a 320pt row is nine, so
  // these two settle on "Dep 2/4" there; a single band fits from about 380pt and
  // a name-plus-remainder from around 350pt.
  const routeRowTwo = routeFitRow([
    routeSelChoices('Airline', 'Air', routeAirOn, routeAirlineOptions.length),
    routeSelChoices('Departure', 'Dep', ROUTE_BANDS.filter(b => routeDepBands[b]), ROUTE_BANDS.length),
    routeSelChoices('Arrival', 'Arr', ROUTE_BANDS.filter(b => routeArrBands[b]), ROUTE_BANDS.length),
  ]);
  const routeAirPill = routeRowTwo[0];
  const routeDepPill = routeRowTwo[1];
  const routeArrPill = routeRowTwo[2];

  // THE RESET, FROM THE SHEET'S SIDE. The anchored panel is this screen's, so it
  // is closed here; everything the reset does to the LIST is the provider's.
  const routeResetControls = () => {
    closeRouteDrop();
    resetRouteControls();
  };

  // ── Calendar ──────────────────────────────────────────────────────────
  // Whole days between today and a given date, on the DEVICE's calendar. The
  // backend bounds against its own UTC date and carries a day of slack either
  // side, so a boundary disagreement cannot lock a legitimate date out.
  const routeDayOffset = (y: number, m: number, d: number) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m, d).getTime() - today.getTime()) / 86400000);
  };

  // Leading blanks so the 1st lands under its weekday, then the days, padded to
  // whole weeks of seven.
  const routeCalWeeks = (() => {
    const { y, m } = routeCalMonth;
    const lead = new Date(y, m, 1).getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  })();

  // Navigation stops where the selectable range does, so the grid never shows a
  // month in which nothing can be picked.
  const routeCalCanGoBack = routeDayOffset(routeCalMonth.y, routeCalMonth.m, 1) > 0;
  const routeCalCanGoNext =
    routeDayOffset(routeCalMonth.y, routeCalMonth.m + 1, 1) <= ROUTE_MAX_DATE_DAYS;

  const shiftRouteCal = (delta: number) => {
    setRouteCalMonth(prev => {
      const d = new Date(prev.y, prev.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const openRouteCal = () => {
    Keyboard.dismiss();
    const base = routeDate === null ? new Date() : new Date(`${routeDate}T00:00:00`);
    setRouteCalMonth({ y: base.getFullYear(), m: base.getMonth() });
    setRouteCalOpen(true);
  };

  // Unmounts only once BOTH layers have left, so the Modal never snaps away
  // from under a scrim still on screen.
  const closeRouteCal = () => {
    Animated.parallel([
      Animated.timing(routeCalAnim, {
        toValue: 0, duration: CAL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(routeCalScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setRouteCalOpen(false));
  };

  // Picking a date RUNS the search. Today stays null, so that request carries no
  // date parameter and costs the usual 2 units; any other day costs 4.
  //
  // Compared against routeResult.date, not routeDate: re-picking the day already
  // on screen must not spend anything, while a day that only LOOKS selected —
  // set but never searched — still has to fire.
  const pickRouteCalDay = (iso: string, isToday: boolean) => {
    const next = isToday ? null : iso;
    setRouteDate(next);
    closeRouteCal();
    if (hostLoading()) return;
    if (routeResult === null || next === routeResult.date) return;
    runRouteLookup(routeResult.origin, routeResult.destination, next);
  };

  // ── Anchored panels ───────────────────────────────────────────────────
  const routeAnchorRefs = useRef<Record<string, View | null>>({});

  const closeRouteDrop = () => {
    Animated.parallel([
      Animated.timing(routePanelAnim, {
        toValue: 0, duration: PANEL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(routeScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setRouteOpenDrop(null));
  };

  // ── DOWNWARD, ALWAYS, WITH ONE EXCEPTION ──────────────────────────────────
  //
  // A PANEL DROPS OUT OF ITS CONTROL AND NEVER RISES OVER IT. The flip that
  // used to send a panel upward when there was more room above is gone: a menu
  // opening above the thing that was tapped is the one direction that never
  // reads as the control opening. Where the space below is short the panel is
  // capped to it and scrolls inside it.
  //
  // THE EXCEPTION IS THE SORT AT THE SMALL DETENT, and only that. At the small
  // detent the sheet is its head and nothing else, so the pill's bottom edge
  // sits about twelve points above the foot of the window: there is no room
  // below it at all, and react-native-screens cannot raise the sheet from here
  // -- the detent is selected once, at presentation. So that one panel, in
  // that one state, rises out of the pill instead. Every other panel, and the
  // sort itself at the middle and large detents, drops. See routePanelRises.
  const openRouteDrop = (id: 'sort' | 'dep' | 'arr' | 'air' | 'orig' | 'dest') => {
    Keyboard.dismiss();
    const node = routeAnchorRefs.current[id];
    if (!node) return;
    node.measureInWindow((wx, wy, width, height) => {
      const win = Dimensions.get('window');
      const below = wy + height + ROUTE_PANEL_GAP;
      const above = win.height - wy + ROUTE_PANEL_GAP;
      setRouteAnchor({
        // Verbatim, unclamped. routePanelLeft decides the placement once the
        // panel has reported how wide it actually is.
        x: wx,
        width,
        // Carried rather than read again at render time, so the placement and
        // the measurement can never disagree across a rotation.
        screen: win.width,
        top: below,
        bottom: above,
        // MEASURED AGAINST THE WINDOW, which is the whole screen whether or not
        // the sheet is at its small detent: the panel is in a Modal over
        // everything, so the window is the right space for it. Never negative:
        // a trigger at the very foot of the window has no room, not less than
        // none.
        spaceBelow: Math.max(0, win.height - below - ROUTE_PANEL_EDGE),
        spaceAbove: Math.max(0, win.height - above - ROUTE_PANEL_EDGE),
      });
      // Forces a fresh measurement: the previous panel's size says nothing
      // about this one's.
      setRoutePanelSize(null);
      setRouteOpenDrop(id);
    });
  };

  // THE ONE EXCEPTION, NAMED. True only for the sort panel while the sheet is
  // at its small detent; see the note at openRouteDrop. Everything that
  // depends on direction reads this and nothing else.
  const routePanelRises = routeOpenDrop === 'sort' && sheetDetent === 0;

  // What the panel may take, which is everything under its trigger -- or, for
  // the one that rises, everything above it. A long airline list scrolls
  // inside it rather than running off.
  const routePanelSpace = routeAnchor === null
    ? 0
    : routePanelRises ? routeAnchor.spaceAbove : routeAnchor.spaceBelow;

  // Horizontal placement, from the panel's REAL width. Left edges aligned is the
  // default: it reads as the panel dropping out of the control. It matches RIGHT
  // edges instead only when left-aligning would run off.
  const routePanelLeft = (() => {
    if (routeAnchor === null) return 0;
    // Unmeasured: the trigger's own x. This pass renders fully transparent, so
    // the provisional placement is never seen.
    if (routePanelSize === null) return routeAnchor.x;
    const w = routePanelSize.w;
    const rightBound = routeAnchor.screen - ROUTE_PANEL_EDGE;
    const preferred = routeAnchor.x + w > rightBound
      ? routeAnchor.x + routeAnchor.width - w
      : routeAnchor.x;
    return Math.max(ROUTE_PANEL_EDGE, Math.min(preferred, rightBound - w));
  })();

  const toggleBand = (
    set: React.Dispatch<React.SetStateAction<Record<RouteBand, boolean>>>,
    band: RouteBand,
  ) => set(prev => ({ ...prev, [band]: !prev[band] }));

  // Built here rather than at the call sites, because the panel that renders
  // them lives in a Modal far from the trigger. One array per control, and one
  // lookup, so the two can still never disagree.
  type RouteOption = { key: string; label: string; on: boolean; press: () => void };

  // THE FOUR ORDERINGS, as the pill's own dropdown. Single-choice, so picking
  // one is the end of the interaction: the sort is set and the panel closes.
  const routeSortOptions: RouteOption[] = ROUTE_SORT_PILLS.map(opt => ({
    key: opt,
    label: ROUTE_SORT_LABELS[opt],
    on: routeSort === opt,
    press: () => { setRouteSort(opt); closeRouteDrop(); },
  }));

  // The three filters are multi-select: the panel deliberately stays open, and
  // the counts beside each option update under the finger.
  const routeDepOptions: RouteOption[] = ROUTE_BANDS.map(b => ({
    key: b,
    label: `${b} (${routeDepCounts[b] ?? 0})`,
    on: routeDepBands[b],
    press: () => toggleBand(setRouteDepBands, b),
  }));

  const routeArrOptions: RouteOption[] = ROUTE_BANDS.map(b => ({
    key: b,
    label: `${b} (${routeArrCounts[b] ?? 0})`,
    on: routeArrBands[b],
    press: () => toggleBand(setRouteArrBands, b),
  }));

  const routeAirOptions: RouteOption[] = routeAirlineOptions.map(a => ({
    key: a,
    label: `${a} (${routeAirCounts[a] ?? 0})`,
    on: !routeAirlinesOff.includes(a),
    press: () => setRouteAirlinesOff(prev =>
      prev.includes(a) ? prev.filter(v => v !== a) : [...prev, a]),
  }));

  // The two ends of an ambiguous search. Choosing one re-runs the search for
  // that end and leaves the other alone; the applied date is carried over, not
  // the date control's current setting, so the picker cannot silently move the
  // results to a different day.
  const routeEndOptions = (which: 'orig' | 'dest'): RouteOption[] => {
    if (routeResult === null || routePick === null) return [];
    const list = which === 'orig' ? routePick.from : routePick.to;
    const current = which === 'orig' ? routeResult.origin : routeResult.destination;
    return list.map(a => ({
      key: a.iata,
      label: `${trimAirportName(a.name)} (${a.iata})`,
      on: a.iata === current,
      press: () => {
        closeRouteDrop();
        if (a.iata === current || hostLoading()) return;
        const origin = which === 'orig' ? a.iata : routeResult.origin;
        const destination = which === 'dest' ? a.iata : routeResult.destination;
        if (origin === destination) return;
        runRouteLookup(origin, destination, routeResult.date);
      },
    }));
  };

  const routeOpenOptions: RouteOption[] =
    routeOpenDrop === 'sort' ? routeSortOptions
      : routeOpenDrop === 'dep' ? routeDepOptions
        : routeOpenDrop === 'arr' ? routeArrOptions
          : routeOpenDrop === 'air' ? routeAirOptions
            : routeOpenDrop === 'orig' ? routeEndOptions('orig')
              : routeOpenDrop === 'dest' ? routeEndOptions('dest')
                : [];

  // One shape for the three filter triggers. The panel they open is not here —
  // it renders in the overlay Modal below, off the layout entirely.
  //
  // collapsable={false} matters on Android: without it the wrapper View can be
  // flattened away at render time and measureInWindow returns nothing usable.
  const routeDropdown = (id: 'dep' | 'arr' | 'air', label: string) => {
    const open = routeOpenDrop === id;
    return (
      <View
        key={id}
        style={s.routePillCol}
        collapsable={false}
        ref={node => { routeAnchorRefs.current[id] = node; }}
      >
        <TouchableOpacity
          style={s.routeDrop}
          activeOpacity={0.7}
          onPress={() => { if (open) closeRouteDrop(); else openRouteDrop(id); }}
        >
          <Text style={s.routeDropTxt} numberOfLines={1}>{label}</Text>
          <View style={[s.routeDropChev, { transform: [{ rotate: open ? '-135deg' : '45deg' }] }]} />
        </TouchableOpacity>
      </View>
    );
  };

  // Which airport an ambiguous city actually resolved to, and the way to change
  // it. An end with no alternative renders nothing at all — there is nothing to
  // disclose and nothing to pick. The search has already run by the time this
  // appears. It is a correction, not a question, which is why it never blocks.
  const routeEndPicker = (which: 'orig' | 'dest', label: string) => {
    if (routeResult === null || routePick === null) return null;
    const list = which === 'orig' ? routePick.from : routePick.to;
    if (list.length < 2) return null;
    const code = which === 'orig' ? routeResult.origin : routeResult.destination;
    // From the option list, so the pill and the panel can never name the same
    // airport differently.
    const airport = list.find(a => a.iata === code) ?? airportByCode(code);
    const open = routeOpenDrop === which;
    return (
      <View style={s.routeEndPickRow}>
        <Text style={s.routeEndSide}>{label}</Text>
        {/* The ref is on the PILL, not on the row: the panel anchors to the
            control the user tapped, so the caption beside it must not shift
            where the panel opens. */}
        <View
          collapsable={false}
          ref={node => { routeAnchorRefs.current[which] = node; }}
        >
          <TouchableOpacity
            style={s.routeDrop}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => { if (open) closeRouteDrop(); else openRouteDrop(which); }}
          >
            {/* The NAME leads: a code names the airport only to someone who
                already knows it. */}
            <Text style={s.routeDropTxt} numberOfLines={1}>
              {routeEndLabel(code, airport?.name ?? code, routeEndCharBudget())}
            </Text>
            <View style={[s.routeDropChev, { transform: [{ rotate: open ? '-135deg' : '45deg' }] }]} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── WHAT THE LIST SAYS WHEN THERE IS NOTHING IN IT ────────────────────────
  //
  // ONE LINE, NOT A BAND. The drawer gave an empty result fifty-six points of
  // air above and below; a sheet that can be a hundred and thirty points tall
  // has none to give. The words are the drawer's own.
  const emptyLine = routeResult === null
    ? null
    : routeShown === 0
      ? (routeResult.date === null
        ? `This route is quiet for the next ${routeResult.window_hours} `
          + `${routeResult.window_hours === 1 ? 'hour' : 'hours'}`
        : `This route is quiet on ${routeDateLabel(routeResult.date)}`)
      : routeSorted.length === 0
        ? `All ${routeShown} ${routeShown === 1 ? 'flight is' : 'flights are'} hidden `
          + `by the ${routeActiveFilters.join(' and ')} `
          + `${routeActiveFilters.length === 1 ? 'filter' : 'filters'}. Relax one, or Reset.`
        : null;

  return (
    <>
      {/* ── THE DIM, UNDER THE SHEET ───────────────────────────────────────
          The sheets' own scrim, faded in between the middle and the large
          detents by the height. It is not there to a finger until the sheet
          has settled at the large detent; then a tap on it closes the sheet.
          Rendered before the sheet so the sheet draws over it. */}
      <Reanimated.View
        pointerEvents={dimActive ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, sh.dim, dimStyle]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={dismissFromDim} />
      </Reanimated.View>

      {/* ── THE SHEET ──────────────────────────────────────────────────────
          A box of the LARGE height, anchored to the screen's bottom edge and
          translated down to the current height -- so hit-testing, which
          follows the transform, gives everything above its top edge to the
          map. Its two top corners carry the app's glass radius and it clips,
          which is what cuts the glass and the veil at those corners. The pan
          is on the whole of it: header, pill, controls and list alike. */}
      <GestureDetector gesture={pan}>
        <Reanimated.View style={[sh.sheet, { height: sheetHeights[2] }, sheetStyle]}>
          {/* ── THE HEADER ───────────────────────────────────────────────────
              THE SURFACE LIVES HERE. The same glass the bubble wears, at the
              large detent's tint, and the veil over it carrying the rest of
              the alpha, both drawn from the header's top edge down a whole
              window's height -- far past the header's own box, which does not
              clip, and under the list, which is drawn after this and is
              transparent. Neither takes a touch. The grabber is drawn last of
              the three, in the clearance the head keeps for it. */}
          <View style={sh.header} collapsable={false}>
            <GlassView
              {...GLASS_DARK}
              tintColor={SHEET_TINT}
              pointerEvents="none"
              style={[sh.surface, { height: winHeight }]}
            />
            <Reanimated.View
              pointerEvents="none"
              style={[sh.surface, sh.veil, { height: winHeight }, veilStyle]}
            />
            <View style={sh.grabberRow} pointerEvents="none">
              <View style={sh.grabber} />
            </View>

          {/* ── THE PILL, PINNED UNDER THE GRABBER ─────────────────────────────
              VISIBLE AT EVERY DETENT AND NEVER SCROLLS. It is in the header, not
              the list, so the small detent shows the grabber and this and nothing
              else -- which is the whole of what a shut sheet has to say: how the
              list under it is ordered. Tapping it drops the four orderings out of
              it, on the same anchored panel the filters use.

              THE WRAPPER IS THE ANCHOR, collapsable false so it exists to be
              measured, exactly as the filter triggers are wrapped. */}
          <View style={sh.head}>
            {routeShown > 0 && (
              <View
                collapsable={false}
                ref={node => { routeAnchorRefs.current.sort = node; }}
              >
                <TouchableOpacity
                  style={sh.sortHead}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  onPress={() => { if (routeOpenDrop === 'sort') closeRouteDrop(); else openRouteDrop('sort'); }}
                >
                  <Text style={sh.sortHeadTxt} numberOfLines={1}>
                    {ROUTE_SORT_CAPSULE[routeSort]}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* ── THE CONTROLS, ON ONE ROW ───────────────────────────────────────
              THE DATE, THE FILTERS AND THE RESET. Sort is not among them any more;
              it is the pill above. The disambiguators stay above the row, drawn
              only when a search matched more than one airport at an end. */}
          <View style={sh.controls}>
            {routeEndPicker('orig', 'from')}
            {routeEndPicker('dest', 'to')}
            <View style={s.routePillRow}>
              <View style={s.routePillCol}>
                <TouchableOpacity style={s.routeDrop} activeOpacity={0.7} onPress={openRouteCal}>
                  <Text
                    style={routeDate === null ? s.routeDropTxt : s.routeDropTxtOn}
                    numberOfLines={1}
                  >
                    {routeDatePill}
                  </Text>
                  <View style={[s.routeDropChev, { transform: [{ rotate: '45deg' }] }]} />
                </TouchableOpacity>
              </View>
              {routeShown > 0 && (
                <View style={s.routePillCol}>
                  <TouchableOpacity
                    style={s.routeDrop}
                    activeOpacity={0.7}
                    onPress={() => { setRouteFiltersOpen(o => !o); setRouteOpenDrop(null); }}
                  >
                    <Text style={s.routeDropTxt} numberOfLines={1}>{routeFiltersPill}</Text>
                    <View style={[s.routeDropChev, { transform: [{ rotate: routeFiltersOpen ? '-135deg' : '45deg' }] }]} />
                  </TouchableOpacity>
                </View>
              )}
              {routeControlsDirty && (
                <TouchableOpacity
                  style={[s.routeResetBtn, s.resetInline]}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={routeResetControls}
                >
                  <Text style={s.routeReset}>{'Reset'}</Text>
                </TouchableOpacity>
              )}
            </View>
            {routeShown > 0 && routeFiltersOpen && (
              <View style={s.routePillRow}>
                {routeDropdown('air', routeAirPill)}
                {routeDropdown('dep', routeDepPill)}
                {routeDropdown('arr', routeArrPill)}
              </View>
            )}
          </View>

          {/* ── THE ANCHORED PANEL ──
              A Modal, not an inline block, so opening one moves nothing in the
              sheet. The position comes from measuring the trigger in window
              coordinates. Scrim and panel animate on SEPARATE values.

              ONE PANEL, TWO SURFACES. The filters and the disambiguators keep
              GlassLayers, the app's blur-and-fill pair; the sort wears a GlassView
              in the bubble's own material and tint, because it drops out of the
              green pill and the two should read as one piece of chrome. The sort
              also takes the pill's exact width, where a filter panel takes its own
              content's. */}
          <Modal visible={routeOpenDrop !== null} transparent animationType="none" onRequestClose={closeRouteDrop}>
            <Pressable style={s.routeOverlayScrim} onPress={closeRouteDrop}>
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, s.routePanelDim, { opacity: routeScrimAnim }]}
              />
              {routeAnchor !== null && (
                <Animated.View
                  onLayout={e => {
                    const { width, height } = e.nativeEvent.layout;
                    // Bails out when nothing actually changed. Moving the panel fires
                    // onLayout again, and a fresh object each time would re-render
                    // for no reason.
                    setRoutePanelSize(prev =>
                      prev !== null && prev.w === width && prev.h === height
                        ? prev
                        : { w: width, h: height });
                  }}
                  style={[
                    s.routeDropPanel,
                    {
                      position: 'absolute',
                      left: routePanelLeft,
                      // Under the trigger -- or, for the one exception, above it.
                      ...(routePanelRises
                        ? { bottom: routeAnchor.bottom }
                        : { top: routeAnchor.top }),
                      minWidth: routeAnchor.width,
                      // The sort is as wide as the pill it dropped out of.
                      ...(routeOpenDrop === 'sort' ? { maxWidth: routeAnchor.width } : null),
                      // Left off on the measuring pass: a cap applied before the
                      // measurement would clamp the very height being measured.
                      maxHeight: routePanelMeasured ? routePanelSpace : undefined,
                      opacity: routePanelAnim,
                      transform: [
                        // Travels out of its trigger: downward, or upward for the
                        // one panel that rises.
                        {
                          translateY: routePanelAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [routePanelRises ? OVERLAY_RISE : -OVERLAY_RISE, 0],
                          }),
                        },
                        { scale: routePanelAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
                      ],
                    },
                  ]}
                >
                  {/* Behind the options and clipped by the overflow above. Every
                      layer here is absolutely positioned, so none can disturb the
                      onLayout measurement this panel's placement depends on. */}
                  {routeOpenDrop === 'sort' ? (
                    <GlassView
                      {...GLASS_DARK}
                      tintColor={BUBBLE_TINT}
                      pointerEvents="none"
                      style={StyleSheet.absoluteFill}
                    />
                  ) : (
                    <GlassLayers />
                  )}
                  {/* Scrolls only when the cap above actually bites, and stops the
                      tap reaching the scrim behind and closing the panel. */}
                  <ScrollView
                    bounces={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    {routeOpenOptions.map(o => (
                      <TouchableOpacity
                        key={o.key}
                        style={s.routeDropItem}
                        activeOpacity={0.7}
                        onPress={o.press}
                      >
                        <Text style={o.on ? s.routeDropItemOn : s.routeDropItemTxt}>{o.label}</Text>
                        {o.on && <Text style={s.routeDropMark}>{'✓'}</Text>}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </Animated.View>
              )}
            </Pressable>
          </Modal>
          <Modal visible={routeCalOpen} transparent animationType="none" onRequestClose={closeRouteCal}>
            <Pressable style={g.routeCalScrim} onPress={closeRouteCal}>
              {/* The dim is its own layer so it can fade on its own curve. */}
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: routeCalScrimAnim }]}
              />
              <Animated.View
                style={[
                  g.sheetShell,
                  {
                    opacity: routeCalAnim,
                    transform: [
                      { translateY: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                      { scale: routeCalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                    ],
                  },
                ]}
              >
                {/* The same three layers, in the same order, as the archive sheet. */}
                <GlassLayers />
                <View style={g.sheetEdge} pointerEvents="none" />
                <Pressable style={g.sheetBody}>
                  <View style={s.routeCalNav}>
                    {/* Month stepping is one group, so the close control can hold the
                        right edge on its own. */}
                    <View style={s.routeCalNavGroup}>
                      <TouchableOpacity
                        onPress={() => shiftRouteCal(-1)}
                        disabled={!routeCalCanGoBack}
                        activeOpacity={0.7}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      >
                        <Text style={routeCalCanGoBack ? s.routeCalArrow : s.routeCalArrowOff}>{'<'}</Text>
                      </TouchableOpacity>
                      <Text style={s.routeCalTitle}>
                        {`${MONTHS[routeCalMonth.m]} ${routeCalMonth.y}`}
                      </Text>
                      <TouchableOpacity
                        onPress={() => shiftRouteCal(1)}
                        disabled={!routeCalCanGoNext}
                        activeOpacity={0.7}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      >
                        <Text style={routeCalCanGoNext ? s.routeCalArrow : s.routeCalArrowOff}>{'>'}</Text>
                      </TouchableOpacity>
                    </View>
                    {/* The same glyph the flight card closes with, in the file's
                        destructive red. Tapping outside still dismisses. */}
                    <TouchableOpacity
                      onPress={closeRouteCal}
                      activeOpacity={0.7}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={s.routeCalClose}
                    >
                      <Svg width={20} height={20} viewBox="0 0 24 24">
                        <Path
                          d="M19 5 5 19"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                        <Path
                          d="M5 5l14 14"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                      </Svg>
                    </TouchableOpacity>
                  </View>

                  <View style={s.routeCalRow}>
                    {WEEKDAYS.map(w => (
                      <Text key={w} style={s.routeCalHead}>{w}</Text>
                    ))}
                  </View>

                  {routeCalWeeks.map((week, wi) => (
                    <View key={wi} style={s.routeCalRow}>
                      {week.map((day, di) => {
                        if (day === null) return <View key={di} style={s.routeCalCell} />;
                        const iso = localIsoDate(new Date(routeCalMonth.y, routeCalMonth.m, day));
                        const offset = routeDayOffset(routeCalMonth.y, routeCalMonth.m, day);
                        const usable = offset >= 0 && offset <= ROUTE_MAX_DATE_DAYS;
                        const isToday = offset === 0;
                        const picked = routeDate === null ? isToday : routeDate === iso;
                        return (
                          <TouchableOpacity
                            key={di}
                            style={[
                              s.routeCalCell,
                              picked && s.routeCalCellOn,
                              !picked && isToday && s.routeCalCellToday,
                            ]}
                            activeOpacity={0.7}
                            disabled={!usable}
                            onPress={() => pickRouteCalDay(iso, isToday)}
                          >
                            <Text style={
                              !usable ? s.routeCalDayOff
                                : picked ? s.routeCalDayOn
                                  : s.routeCalDay
                            }>{day}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </Pressable>
              </Animated.View>
            </Pressable>
          </Modal>
          </View>

          {/* ── THE LIST ─────────────────────────────────────────────────────
              FLAT, UNDER EVERY ORDERING. No part-of-day headings, no pinned
              row with a heading over it, no captions under it: a list somebody
              opened to choose between options, and rows are the options. The
              fastest rows still wear their in-row tag; that is the row's, not
              a section's.

              IT FILLS WHAT THE HEADER LEAVES of the sheet's large height, and
              scrolls only at that height -- scrollEnabled is animated off the
              sheet's own value, so at the other detents a drag on the rows
              moves the sheet. bounces is off so the list stops dead at zero
              and the sheet takes the next delta; see the pan.

              THE BOTTOM PADDING IS THE TAB BAR. The sheet's surface runs on
              under the bar to the screen's edge; its last row does not. */}
          <GestureDetector gesture={native}>
            <Reanimated.ScrollView
              style={sh.list}
              animatedProps={listProps}
              onScroll={onListScroll}
              scrollEventThrottle={16}
              bounces={false}
              contentContainerStyle={{ paddingBottom: insets.bottom + CARD_GAP }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {emptyLine !== null ? (
                <Text style={sh.empty}>{emptyLine}</Text>
              ) : (
                routeSorted.map(r => (
                  <RouteRow key={routeRowKey(r)} r={r} onPress={selectRow} />
                ))
              )}
            </Reanimated.ScrollView>
          </GestureDetector>
        </Reanimated.View>
      </GestureDetector>
    </>
  );
}

// ── THE SHEET'S OWN STYLES ──────────────────────────────────────────────────
//
// NO NEW COLOURS. The page black, the one green, the card fill and the two
// hairlines are all the app's own -- see lib/cards and lib/glass.
const sh = StyleSheet.create({
  // THE SHEET'S BOX. Full width, on the screen's bottom edge, its height set
  // inline to the large detent; the transform is what places it. The two top
  // corners are the app's glass radius and the box clips to them, which is
  // what cuts the surface below at the corners.
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: GLASS_RADIUS, borderTopRightRadius: GLASS_RADIUS,
    overflow: 'hidden',
  },
  // THE SHEETS' SCRIM, full screen under the sheet. Its opacity is the shell's.
  dim: { backgroundColor: SHEET_SCRIM },
  // THE HEADER. No flex and no fixed height: its layout height is the pill and
  // the controls and nothing else, and the list takes the rest. overflow
  // visible is React Native's default on iOS and is stated because it is
  // load-bearing -- the glass below runs past this box.
  header: { overflow: 'visible' },
  // THE GLASS AND THE VEIL, from the header's top edge down. The height is set
  // inline to the window's, which is more than any detent, so the surface runs
  // under the whole list whatever the sheet's height.
  surface: { position: 'absolute', top: 0, left: 0, right: 0 },
  // THE PAGE BLACK, at whatever opacity the height asks for. See SHEET_VEIL.
  veil: { backgroundColor: PAGE_BG },
  // THE GRABBER, centred in the clearance the head keeps above the pill. A row
  // rather than alignSelf on an absolute child, so the centring is Yoga's
  // ordinary kind.
  grabberRow: { position: 'absolute', top: SHEET_GRABBER_TOP, left: 0, right: 0, alignItems: 'center' },
  grabber: {
    width: SHEET_GRABBER_W, height: SHEET_GRABBER_H,
    borderRadius: SHEET_GRABBER_H / 2, backgroundColor: SHEET_GRABBER_INK,
  },
  // UNDER THE GRABBER. The clearance is the grabber's room;
  // the sides are the page's own inset. THE FOUR VERTICAL NUMBERS IN THIS BLOCK
  // ARE THE SMALL DETENT: they come from lib/routeResults, where the detent is
  // computed from them, so the head cannot grow without the detent following.
  head: {
    paddingTop: SHEET_GRABBER_CLEARANCE,
    paddingHorizontal: ROUTE_SCROLL_PAD,
    paddingBottom: SHEET_HEAD_PAD,
  },
  // FILLED GREEN AND FULLY ROUNDED, seventeen of vertical padding: fifty tall.
  sortHead: {
    backgroundColor: '#4ade80',
    borderRadius: 999,
    paddingVertical: SHEET_PILL_PAD,
    alignItems: 'center',
  },
  // AN EXPLICIT LINE HEIGHT, so the pill's height is a sum and not a font's
  // opinion: 13 of text on a 16 line, which is what the detent is cut from.
  sortHeadTxt: {
    fontFamily: MONO_BOLD, fontSize: 13, lineHeight: SHEET_PILL_LINE,
    color: PAGE_BG, letterSpacing: 0.5,
  },
  controls: { paddingHorizontal: ROUTE_SCROLL_PAD, marginBottom: 4 },
  list: { flex: 1, paddingHorizontal: ROUTE_SCROLL_PAD },
  // The empty result as one quiet line at the top of the list's space. Same ink
  // the drawer's empty headline had, one size down, no band.
  empty: {
    fontSize: 13, color: 'rgba(226,226,226,0.6)', fontFamily: SANS,
    lineHeight: 20, paddingVertical: 8,
  },
});

// THE PICKERS' STYLES, AS THEY WERE IN THE SEARCH SCREEN'S SHEET.
const s = StyleSheet.create({
  // Content-sized, so the pill is as wide as its label rather than a third of
  // the row: these are not part of the view-control grid and must not line up
  // with it. One per row, because two airport names side by side do not fit at
  // 320pt.
  routeEndPickRow: {
    alignSelf: "flex-start", marginTop: 8,
    flexDirection: "row", alignItems: "center",
  },
  // "from" and "to" sit OUTSIDE the pill so the pill carries only the airport.
  // A FIXED width, not content width: it lines the two pills up with each
  // other. 28pt holds "from" at 6.6pt per character.
  routeEndSide: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO,
    width: 28, marginRight: 8,
  },
  // No flexWrap. Wrapping is what this layout is built to make impossible, and
  // leaving it on would hide a label that outgrew its cap instead of showing it.
  routePillRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8,
  },
  // Stretched, not content-sized: equal shares, so a row is always full to its
  // right edge whatever the labels inside it say. This is also what makes each
  // pill's width knowable without measuring it.
  routePillCol: { flex: 1 },
  // Content-sized and left-aligned so it reads as subordinate to the rows
  // rather than as another pill in them.
  routeResetBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: SURFACE_EDGE,
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginTop: 6,
  },
  // ALREADY ALIGNED BY THE ROW; this only stops the button stretching to the
  // pills' height, which alignSelf flex-start on the base style would do from
  // the top instead of the baseline.
  resetInline: { alignSelf: 'center', marginTop: 0 },
  routeReset: { fontSize: 11, color: "rgba(226,226,226,0.5)", fontFamily: MONO },
  // Layout only. The dim that used to live here is now a sibling layer, so it
  // can fade on its own value.
  routeOverlayScrim: { flex: 1 },
  // The sheets' scrim exactly. The panel is glass and glass needs the same
  // ground under it as the sheets have, or the two read as different materials
  // lit differently.
  routePanelDim: { backgroundColor: SHEET_SCRIM },
  routeCalNav: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 14,
  },
  routeCalNavGroup: { flexDirection: "row", alignItems: "center", gap: 4 },
  routeCalClose: { paddingVertical: 4, paddingHorizontal: 4, marginRight: -4 },
  routeCalTitle: { fontSize: 13, color: "#ffffff", fontFamily: MONO_BOLD },
  routeCalArrow: { fontSize: 15, color: "#ffffff", fontFamily: MONO_BOLD, paddingHorizontal: 8 },
  routeCalArrowOff: { fontSize: 15, color: "rgba(226,226,226,0.25)", fontFamily: MONO_BOLD, paddingHorizontal: 8 },
  routeCalRow: { flexDirection: "row" },
  routeCalHead: {
    flex: 1, textAlign: "center", fontSize: 11,
    color: "rgba(226,226,226,0.4)", fontFamily: MONO, marginBottom: 6,
  },
  // flex divides the row evenly whatever the screen. Height is the one axis
  // with room, so it takes the 44pt guideline outright.
  routeCalCell: { flex: 1, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  routeCalCellOn: { backgroundColor: "rgba(74,222,128,0.08)" },
  routeCalCellToday: { borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  routeCalDay: { fontSize: 13, color: "#ffffff", fontFamily: MONO },
  routeCalDayOn: { fontSize: 13, color: "#4ade80", fontFamily: MONO_BOLD },
  routeCalDayOff: { fontSize: 13, color: "rgba(226,226,226,0.25)", fontFamily: MONO },
  // THE EDGE STAYS SHEET_EDGE AND THE FILL IS THE CARD'S. This control opens a
  // glass panel and wears that panel's edge on purpose. See the exception note
  // at SHEET_EDGE in lib/glass.tsx.
  routeDrop: {
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    backgroundColor: CARD_FILL,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  routeDropTxt: { fontSize: 11, color: "#ffffff", fontFamily: MONO, flexShrink: 1 },
  // A chosen date is one of the three things green is allowed to mark.
  routeDropTxtOn: { fontSize: 11, color: "#4ade80", fontFamily: MONO_BOLD, flexShrink: 1 },
  // Two borders of a square: a real chevron with a controllable weight.
  routeDropChev: {
    width: 6, height: 6,
    borderRightWidth: 1.5, borderBottomWidth: 1.5,
    borderColor: "rgba(226,226,226,0.5)",
    marginLeft: 4,
  },
  routeDropPanel: {
    maxWidth: ROUTE_PANEL_MAX_WIDTH,
    // NO backgroundColor. The fill is a sibling drawn AFTER the blur, inside
    // GlassLayers.
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: SHEET_RADIUS,
    // Keeps the scrolling contents — and the blur — inside the corners.
    overflow: "hidden",
  },
  routeDropItem: {
    paddingVertical: 8, paddingHorizontal: 10,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  routeDropItemTxt: { fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO },
  routeDropItemOn: { fontSize: 11, color: "#ffffff", fontFamily: MONO_BOLD },
  routeDropMark: { fontSize: 11, color: "#ffffff", fontFamily: MONO },
});
