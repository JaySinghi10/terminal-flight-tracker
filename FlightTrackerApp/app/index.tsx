import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import Svg, { Path, Rect, G } from 'react-native-svg';
// The Reanimated one, deliberately. The root export's Swipeable is marked
// "@deprecated use Reanimated version of Swipeable instead" in the installed
// package's own types; this is the current API in 2.28.
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
// Aliased, because this file's Animated is React Native's and both are in use:
// every existing animation here drives RN's own Animated, and only the swipe
// actions read a Reanimated shared value. react-native-reanimated is already a
// dependency — gesture-handler's Swipeable is built on it.
import Reanimated, {
  useAnimatedStyle, useSharedValue,
  runOnJS, type SharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Google from 'expo-auth-session/providers/google';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Animated,
  StatusBar,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  Dimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SavedFlight,
  savedFlightFromApi,
  ISO_DAY_RE,
} from '../lib/storage';
// zonedIsoToTs and clock24 moved to lib/time.ts, which is now the one place
// either kind of ISO is read. The reasoning that used to sit above them here
// moved with them, because it is the reasoning that stops the next person
// calling new Date() on a flight DTO field.
import { clock24 } from '../lib/time';
// THE STORE. The saved list, the account email, the refresh loop and its caps,
// the undo window and the reminder scheduling all moved to lib/saved.tsx, so the
// tab bar and every screen after it can reach the same records rather than a
// copy. lib/reminders.ts and lib/watch.ts are reached through it now and are no
// longer imported here at all.
//
// THE PURE RULES WENT WITH THEM, and are imported back from there rather than
// left on a screen for the store to reach into: a screen must never be the place
// another module imports from. One copy each.
import {
  useSaved,
  arrivalTs,
  hasFlown,
  effectiveStatus,
  isArchived,
  isOwned,
  sortSavedByRelevance,
} from '../lib/saved';
// WHAT A FLIGHT IS DOING, AND HOW LONG UNTIL IT DOES IT. The status colour, the
// countdown line and the formatters the three surfaces that render it share all
// moved to lib/flightstatus.tsx, unchanged. They are imported back here because
// this screen still renders two of those three surfaces; the card is the one
// leaving.
import {
  getStatusColor,
  WEEKDAYS,
  MONTHS,
  routeDateLabel,
  StatusLine,
} from '../lib/flightstatus';
// THE SWIPE, AND EVERY PIECE IT IS MADE OF. The button, the expanding box, the
// threshold's haptic, the geometry, the spring, the fills, the glyphs and the
// exit timings all moved to components/swipe.tsx, unchanged. They come back here
// because this screen still builds both panels that use them — the watchlist
// row's and the card's; the card is the one leaving.
import {
  SWIPE_W,
  DragMirror,
  SwipeAction,
  EXPAND_HAPTIC,
  ExpandAction,
  EXIT_TIMING,
  EXIT_BACK_TIMING,
  SWIPE_SPRING,
  SWIPE_FILL_RED,
  SWIPE_FILL_DIM,
  ICON_NOTIFY,
  ICON_DELETE,
  ICON_RESTORE,
  ICON_ARCHIVE,
  ICON_REMIND,
  notImplemented,
} from '../components/swipe';
// THE MATERIAL, and it is no longer declared here. Every constant and the
// GlassLayers component moved to lib/glass.tsx unchanged, so the tab bar can
// render the same glass without importing a screen. The comments that specify
// all of it went with them; read them there.
import {
  SHEET_BLUR, SHEET_FILL, SHEET_RADIUS, SHEET_EDGE, SHEET_SCRIM,
  GlassLayers,
  // THE SHEET CHROME AND THE OVERLAY MOTION, moved to sit beside the material
  // they are the chrome and the motion FOR. `g` is that file's stylesheet: the
  // eight sheet entries and the calendar scrim are read from it now rather than
  // from this screen's own `s`.
  EASE_OUT, EASE_IN, CAL_RISE,
  CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  g,
} from '../lib/glass';
// THE FLAT SURFACES, and they are not glass. See the note at the top of that
// file for why the card vocabulary did not go in beside the blur.
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG, c } from '../lib/cards';
// THE TWO BANNERS, AND THE CARD'S OWN MACHINERY. Both moved out of this screen
// because the search screen needs them too, and neither may be imported from a
// screen. See the notes at the top of each.
import { useToast } from '../lib/toast';
import { useFlightCardHost, FlightError } from '../lib/flightcard';
// THE GMAIL TOKEN, and it is the only thing in there. Sign-in and logout are on
// this screen and the /chat request that sends it is on the search screen, so it
// is the one piece of the account that had to stop being one screen's.
import { useAccount } from '../lib/account';
// THE CARD, AND THE SHEET IT OPENS. The card is not this screen's — the search
// screen renders the same object from the same record — so all of it moved to
// components/FlightCard.tsx unchanged: the swipe, the sheet, the tiles, the
// progress bar, and what a flight LOOKS like once the wire has been read.
//
// The twelve names below come back because this screen still builds a card's
// worth of data of its own. renderSavedFlight maps a stored record into exactly
// the shape the card is handed, and it has to do that through the same functions
// or a tapped watchlist row and a fresh lookup would say different things about
// one flight.
import {
  FlightCard,
  getStatusBg,
  badgeLabel,
  hasTime,
  movementTimeCell,
  displayStatus,
  scheduledDuration,
  airportFullLabel,
  flightDataFromApi,
} from '../components/FlightCard';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

// STILL DECLARED HERE, unlike the rest of the material: the profile modal's own
// sheet tint is the only thing that uses it, and the modal has not moved out.
// The value is recovered from the commit that deleted it rather than picked
// again by eye.
const PROFILE_FILL = 'rgba(0,0,0,0.45)';
// The same grey the bookmark outline uses on the flight card.
const ARCHIVE_ICON = 'rgba(226,226,226,0.5)';

// Rows fade up as the sheet arrives, each a little after the one above it.
// Expressed as FRACTIONS of the sheet's own 0->1 travel rather than as
// milliseconds, so the cascade is driven by the existing archiveAnim and cannot
// drift from it. Past ARCHIVE_ROW_MAX every row shares the last slot: a long
// list should not still be arriving after the sheet has settled.
const ARCHIVE_ROW_STAGGER = 0.07;
const ARCHIVE_ROW_FADE = 0.45;
const ARCHIVE_ROW_MAX = 6;
const ARCHIVE_ROW_RISE = 6;
// Header line, e.g. "Sat, 16 Aug · 02:04". Fixed arrays rather than Intl so
// the output never shifts with locale.
//
// 24-hour, matching the route rows. Both parts are zero-padded, so the line is
// the same nineteen characters at every hour and no longer changes width as the
// meridiem comes and goes.
function formatClock(ts: number) {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = String(d.getDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]}, ${day} ${MONTHS[d.getMonth()]} · ${time}`;
}

// WEEKDAYS holds abbreviations for the clock line; "Happy Sat" reads clipped in
// a greeting, so the full names live here. Only the weekend entries reach it.
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Greeting prefixes, keyed by the situation greetingPrefix resolves to. Every
// entry renders as "<prefix>, <name>", so each has to read naturally in front of
// a comma and a first name. '{day}' is substituted with the weekday name.
const GREETINGS = {
  morning: ['Good morning', 'Morning', 'Up early'],
  afternoon: ['Good afternoon', 'Afternoon'],
  evening: ['Good evening', 'Evening', 'Winding down'],
  night: ['Still up', 'Late one'],
  mondayMorning: ['Monday again', 'New week', 'Good morning'],
  weekendMorning: ['Happy {day}', 'Slow start', 'Weekend mode'],
  weekendAfternoon: ['Enjoy the weekend', 'Good afternoon'],
};

// Pure and total. Day-specific cases resolve first, then the plain hour buckets.
// The night bucket spans 22-04 and so wraps past midnight, which is why it is
// the fallthrough rather than a range. Evenings and nights are deliberately
// shared across every day: a Saturday 2am is not different from a Tuesday 2am.
// The double modulo keeps the lookup total for a negative index.
function greetingPrefix(ts: number, index: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const h = d.getHours();
  const isWeekend = day === 0 || day === 6;
  const pool =
    day === 1 && h >= 5 && h <= 11 ? GREETINGS.mondayMorning :
    isWeekend && h >= 5 && h <= 11 ? GREETINGS.weekendMorning :
    isWeekend && h >= 12 && h <= 16 ? GREETINGS.weekendAfternoon :
    h >= 5 && h <= 11 ? GREETINGS.morning :
    h >= 12 && h <= 16 ? GREETINGS.afternoon :
    h >= 17 && h <= 21 ? GREETINGS.evening :
    GREETINGS.night;
  const prefix = pool[((index % pool.length) + pool.length) % pool.length];
  // No-op for every entry without the token.
  return prefix.replace('{day}', WEEKDAYS_LONG[day]);
}

// Display-only handle. Saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

function InfoRow({ label, value, sans }: { label: string; value: string; sans?: boolean }) {
  return (
    <View style={ir.row}>
      <Text style={ir.label}>{label}</Text>
      <Text style={[ir.value, sans && ir.valueSans]}>{value}</Text>
    </View>
  );
}

// DELIBERATELY STILL FLAT, while the saved, archive and route rows became
// cards.
//
// The difference is what a row IS in each place. A saved row or a route row is
// one flight — a separate object, independently tappable, saveable, swipeable —
// and cards are how a list says "these are separate things". An InfoRow is one
// field of ONE flight: Terminal, Gate, Baggage Belt. They are a specification
// table, and the hairline between them separates data within a single object
// rather than one object from the next.
//
// Carding them would also nest a card in a card, since these already sit inside
// the flight card, and turn a dense readable table into a dozen floating
// blocks — twelve gaps of 8pt added to a section that is read by scanning down
// the labels.
const ir = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  label: { fontSize: 13, color: "rgba(226,226,226,0.45)", fontFamily: SANS },
  value: { fontSize: 13, color: "#ffffff", textAlign: "right", flex: 1, marginLeft: 16, fontFamily: MONO },
  valueSans: { fontFamily: SANS },
});

// The date, the aircraft and its registration, on one line, or nothing at all.
//
// "N/A" IS A SENTINEL EVERYWHERE ELSE ON THIS CARD and it has to be one here
// too. The tiles above recede to an em dash on exactly that value; a footer
// printing it as plain text would contradict a rule three inches above it.
// hasTime is this file's single implementation of the question — its name is
// about times, but what it actually answers is "is this a real value, or the
// N/A the backend writes when it has none".
//
// routeDateLabel turns 2026-09-04 into "Fri 4 Sep". The raw ISO was the last
// place on this card still printing a machine string at a human.
//
// filter(Boolean) keeps the separators honest for the other two: aircraft and
// registration are null on plenty of records, and joining the survivors rather
// than the slots means no empty gap between two dots and none trailing off the
// end. With nothing left to join it renders NOTHING — not an empty line, which
// would leave the footer's gap hanging under the airports for no reason.
function FooterMeta({ date, aircraft, registration }: {
  date: string; aircraft: string | null; registration: string | null;
}) {
  const parts = [
    hasTime(date) ? routeDateLabel(date) : null,
    aircraft,
    registration,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <Text style={s.footerMeta} numberOfLines={1}>{parts.join(' \u00b7 ')}</Text>;
}

// ── SWIPE ACTIONS ────────────────────────────────────────────────────────────
//
// A FIXED 52 x 52 SQUARE, and the fix for buttons that looked squashed and
// misshapen at rest.
//
// The cause was that the button had no height of its own. swipeGroup carried
// alignItems: 'stretch', so every button took the height of the panel it sat
// in, and the panel is absoluteFillObject over the Swipeable's container. Three
// consequences, all of them visible:
//
//   1. The height came from the ROW, and rows are content-driven. A saved row
//      is about 62pt and an archive row about 72, so the same button rendered
//      roughly 58pt tall in one list and 68 in the other — against a fixed 66pt
//      width, which flips it from wider-than-tall to taller-than-wide between
//      two lists showing the same actions.
//   2. RADIUS 18 then reads differently on each. On a 58pt button it is a soft
//      rectangle; on a 40pt one — a row with a short second line — it is nearly
//      a capsule. The radius never changed; the shape under it did.
//   3. The container includes sf.row's marginBottom of 8, since the card gap is
//      inside the row's own box. So the panel was 8pt taller than the card and
//      the button was centred over card-plus-gap, sitting 4pt BELOW the card's
//      centre on every row.
//
// So: a fixed square, centred, and the group inset by the card's gap so that
// "centred" means centred on the CARD. The shape is now a decision rather than
// a by-product of whatever the row happens to contain.
//
// 52 because the glyph is 20 and 16pt of clearance on each side is what makes a
// tap target rather than an icon with a box drawn round it. It also clears the
// 44pt minimum comfortably. With the label gone there is nothing else to fit.
//
// The slot returns to 64: 52 of button and 6 of margin either side, which is a
// 12pt gutter between neighbours and a 6pt gap to the card. The panel is 128pt
// again, so the drag costs 147pt of finger to open and 221pt to arm the
// expansion, where the 72pt slots cost 166 and 202. Nineteen points more to
// arm, because a narrower panel leaves more of the distance to the overshoot's
// firmer friction; overshootFriction is the knob if that reads as too far.

// The reminder indicator on a saved row. ARCHIVE_ICON's grey, which is the
// file's existing dim ink for a glyph sitting on the page rather than on a
// fill.
//
// NOT #4ade80, deliberately. Green means live and actionable here — an active
// flight, a countdown that is running. A pending reminder is neither: it is a
// note about something that has not happened, and colouring it green would put
// it in the same visual class as a flight in the air.
const REMIND_DOT = ARCHIVE_ICON;

// Lifted out of the parameter list so the memo comparison below can name it,
// and so the two cannot describe different shapes.
type SavedFlightRowProps = {
  flight: SavedFlight;
  // OMITTED ON ARCHIVE ROWS, which are not tappable. An archived flight is
  // finished and is never refreshed again, so the card behind it could only ever
  // repeat what the row already says; opening one offered a screen of stale
  // readings and an action bar that does not apply. The swipe actions are how an
  // archive row is used, and restore is still among them.
  onPress?: () => void;
  onUnsave: () => void | Promise<void>;
  now: number;
  // Set only inside a sheet. The main list is a dense column against the page
  // and reads correctly at 13; the same density inside a panel with 20 of
  // padding on every side looks cramped against its own container. One row
  // component, two rhythms, chosen by the caller that knows which it is in.
  roomy?: boolean;
  // Drops this row's separator. Every row draws a hairline UNDER itself, which
  // is right for all of them but the last: there it rules off against nothing,
  // and inside the archive sheet it floats in the 20pt of padding below the
  // list looking like a row that failed to render.
  //
  // The caller decides, because only the caller knows what the list is. Both
  // lists that use this row are a plain map over a sorted array, so both can
  // answer it with the index they already have.
  last?: boolean;
  // Rendered inside the archive sheet. Changes what the second line says and
  // nothing else: the number, the cities and the date are the same row.
  //
  // The archive's second line is the single word "landed" and no more. The
  // countdown and the "updated N ago" that StatusLine renders are both live
  // readings, and neither means anything for a flight that is finished — a
  // countdown to a departure that happened last March, and an update age that
  // only ever grows because nothing will ever update it again.
  archived?: boolean;
  // Sets or clears archivedAt. Both lists pass it; what the row does with it
  // differs, which is decided below rather than by the caller.
  //
  // Both of these return void or a promise: the call sites are async arrows, and
  // the commit awaits whatever comes back so that a storage failure can put the
  // row back rather than leaving it flown off screen and still in the list.
  onArchive: (archived: boolean) => void | Promise<void>;
  // Raised after a committed swipe, once the action has actually succeeded.
  onDone: (message: string) => void;
  // Turns reminders on or off and RETURNS THE MESSAGE to show.
  //
  // The message is the caller's because only the caller knows the outcome:
  // permission refused, no times left to schedule, or done. The row flips a
  // label and reports what it is told, which keeps `email`, the store and the
  // scheduler out of a component that renders one flight.
  onRemind: (on: boolean) => Promise<string>;
};

// WHAT COUNTS AS THE SAME ROW: the five data props, by identity, and the
// callbacks deliberately NOT.
//
// EVERYTHING ON THE FLIGHT RIDES ON `a.flight` — archivedAt, remindersSetAt and
// anything added later. The store returns new objects on every write, so a row
// whose reminder state changed is never the same reference and the first
// comparison has already failed. Do not add flight.<field> lines here: they can
// only ever be reached when the identity check passed, which means the field is
// equal too.
//
// Every call site builds its handlers as inline arrows inside a .map, so they
// are new functions on every parent render; comparing them would defeat the
// memo entirely. Excluding them is safe in the one way that matters — anything
// they read that could actually change, the email or the stored list, also
// replaces the flight objects, and the flight IS compared.
//
// WHAT THIS DOES NOT FIX, and it is worth being exact because it was the
// original suspicion: it does NOT stop the 60-second tick re-rendering every
// row. `now` genuinely changes on every tick and the countdowns genuinely
// depend on it, so the row must re-render. What makes the tick affordable is
// the formatter cache above, not this. What this stops is the other forty-six
// pieces of state in the screen — a route search, a toast, a dropdown opening —
// dragging every saved row through a render that would change nothing.
function sameRow(a: SavedFlightRowProps, b: SavedFlightRowProps): boolean {
  return a.flight === b.flight
    && a.now === b.now
    && a.roomy === b.roomy
    && a.last === b.last
    && a.archived === b.archived;
}

const SavedFlightRow = memo(function SavedFlightRow({
  flight,
  onPress,
  onUnsave,
  now,
  roomy,
  last,
  archived,
  onArchive,
  onDone,
  onRemind,
}: SavedFlightRowProps) {
  const swipe = useRef<SwipeableMethods>(null);
  // Every action closes the row first. Leaving it open behind a modal or a
  // vanished row is the standard way this control goes wrong.
  //
  // Stable: it captures nothing but the ref, whose identity never changes.
  const act = useCallback((fn: () => void) => () => { swipe.current?.close(); fn(); }, []);

  // The row's own width, measured once by onLayout and read on the UI thread.
  // The threshold is a fraction of it, so it cannot be a constant.
  const rowW = useSharedValue(0);

  // WHICH SIDE IS ARMED, in JS, because the release handler is a JS callback.
  //
  // A ref rather than state on purpose: arming must not re-render the row
  // mid-drag, and nothing on screen reads this — the expansion itself is driven
  // entirely by the shared value inside ExpandAction.
  const armedSide = useRef<'left' | 'right' | null>(null);
  const onCrossRight = useCallback((on: boolean) => {
    armedSide.current = on ? 'right' : null;
    EXPAND_HAPTIC();
  }, []);
  const onCrossLeft = useCallback((on: boolean) => {
    armedSide.current = on ? 'left' : null;
    EXPAND_HAPTIC();
  }, []);

  // The row's own exit, on top of whatever the Swipeable is doing underneath.
  //
  // A separate wrapper rather than the library's translation, because the
  // library owns that value and clamps it to the panel: there is no way to ask
  // it to keep going. This transform composes with it — the Swipeable is still
  // settling its 128pt while the wrapper is carrying the whole thing off.
  //
  // A REANIMATED shared value now rather than an Animated.Value. The previous
  // one was already useNativeDriver: true, so the animation itself was on the
  // UI thread either way; what this removes is the system boundary. The drag,
  // the expansion and now the exit are all shared values evaluated in the same
  // place, so there is one animation model in this component rather than two
  // meeting at the moment of release.
  const exitX = useSharedValue(0);
  const exitStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: exitX.value }],
  }));

  // The JS half of the commit: the storage write, the message, and the retreat
  // if it fails. Split out because a worklet cannot await, and declared BEFORE
  // onWillOpen because that hook names it in its dependency list, which is
  // evaluated the moment the line is reached rather than when the row is swiped.
  //
  // ON COMPLETION, not at the start. Firing at the start races the state update
  // against the animation: the row is removed from the list, this component
  // unmounts, and the exit is cut off part-way at whatever moment the storage
  // write happens to land. Waiting makes the sequence the same every time — the
  // row goes, then the list closes up behind it.
  const commit = useCallback(async (side: 'left' | 'right') => {
    try {
      if (side === 'right') {
        // NO onDone HERE ANY MORE. onUnsave now raises the undo banner itself,
        // and a second toast at the top saying the same thing in different words
        // is one banner too many — two notices, two places, one action. The
        // banner says more than this line did: it can be acted on.
        await onUnsave();
      } else if (archived) {
        await onArchive(false);
        onDone(`${flight.flightNumber} restored`);
      } else {
        await onArchive(true);
        onDone(`${flight.flightNumber} moved to archive`);
      }
    } catch {
      // IF THE ACTION FAILS the row comes back, because it is still in the list
      // and an invisible row that is still there is the worse outcome by some
      // distance. Writing a shared value from JS is allowed and the animation
      // runs on the UI thread from there; nothing about the failure path
      // depended on being inside the old callback. No message is raised —
      // nothing happened, so nothing is claimed.
      exitX.value = withTiming(0, EXIT_BACK_TIMING);
      swipe.current?.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived, onUnsave, onArchive, onDone, flight.flightNumber]);

  // THE RELEASE. onSwipeableWillOpen fires the moment the row is let go and
  // starts animating open, which is the last point at which the panel can be
  // told not to.
  //
  // Armed means the finger went past the threshold and did not come back, so
  // the row COMMITS. Not armed — including the case where the user crossed the
  // threshold and dragged back before letting go, which disarms on the way past
  // — means this does nothing at all and the panel settles open exactly as it
  // did before.
  const onWillOpen = useCallback(() => {
    const side = armedSide.current;
    if (side === null) return;
    armedSide.current = null;

    // The row LEAVES rather than snapping back. It used to close() first and
    // fire the action after, which played the gesture in reverse before
    // anything happened — the reading was "that was undone", not "that was
    // done". It now continues the way it was thrown.
    const dir = side === 'right' ? -1 : 1;
    exitX.value = withTiming(
      dir * Dimensions.get('window').width,
      EXIT_TIMING,
      // HOW COMPLETION FIRES, now that the animation lives on the UI thread: the
      // callback is a worklet, invoked there, and runOnJS is what carries the
      // decision back to JavaScript to do the async work. It is one hop, at the
      // end, when nothing is animating — as against the old Animated.timing
      // callback, which was a JS function the native driver had to call back
      // into for the same purpose.
      (finished) => {
        'worklet';
        if (finished) runOnJS(commit)(side);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit]);

  // SWIPING LEFT drags the row leftward and uncovers the panel on its right,
  // which is what renderRightActions names. Delete sits outermost, at the
  // screen edge, where iOS Mail puts it.
  //
  // MEMOISED, because the library wraps its own leftElement/rightElement in a
  // useCallback keyed on these two props. An inline arrow is a new function on
  // every render, which busts that cache and remounts BOTH action panels —
  // every Svg in them — whenever the row renders for any reason at all.
  //
  // The dependencies mirror sameRow rather than listing the callbacks, and for
  // the same reason it excludes them: they are rebuilt on every parent render,
  // so depending on them would make this a no-op.
  const renderRight = useCallback((progress: SharedValue<number>, translation: SharedValue<number>) => (
    <View style={sf.swipeGroup}>
      {/* IN THE RIGHT PANEL BECAUSE THE RIGHT PANEL IS ALWAYS THERE. The left
          one is undefined on an archive row with nothing to restore, and the
          fill has to follow the drag on every row. Both callbacks are handed
          the same appliedTranslation, so which side it is read from does not
          matter. */}
      <DragMirror from={translation} to={dragX} />
      {/* Nothing to notify about once a flight has landed, so the archive
          keeps only the destructive half of this panel. */}
      {!archived && (
        <SwipeAction label="notify" fill={SWIPE_FILL_DIM} progress={progress} onPress={act(notImplemented)}>
          {ICON_NOTIFY}
        </SwipeAction>
      )}
      {/* notify shares this panel unless the row is archived, in which case
          delete is alone in it. */}
      <ExpandAction side="right" translation={translation} rowW={rowW} others={archived ? 0 : SWIPE_W} onCross={onCrossRight}>
        <SwipeAction label="delete" fill={SWIPE_FILL_RED} progress={progress} grow="right" onPress={act(onUnsave)}>
          {ICON_DELETE}
        </SwipeAction>
      </ExpandAction>
    </View>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [archived, act, onCrossRight]);

  // SWIPING RIGHT uncovers the panel on the left.
  //
  // In the archive this is restore, and it appears only for a flight that was
  // archived by hand AND has not flown. Offering it on a flight that genuinely
  // landed would be a button that does nothing visible: clearing archivedAt
  // hands the row back to the arrival-time rule, which puts it straight back.
  const canRestore = archived && flight.archivedAt !== null && !hasFlown(flight, now);
  // useMemo rather than useCallback: on an archive row with nothing to restore
  // this is deliberately undefined, and useCallback's signature takes only a
  // Function. The value being memoised happens to be a function; that is not
  // the same thing.
  const renderLeft = useMemo(
    () => archived
      ? (canRestore
          ? (progress: SharedValue<number>, translation: SharedValue<number>) => (
              <View style={sf.swipeGroup}>
                {/* restore is the only action in the archive's left panel. */}
                <ExpandAction side="left" translation={translation} rowW={rowW} others={0} onCross={onCrossLeft}>
                  <SwipeAction label="restore" fill={SWIPE_FILL_DIM} progress={progress} grow="left" onPress={act(() => onArchive(false))}>
                    {ICON_RESTORE}
                  </SwipeAction>
                </ExpandAction>
              </View>
            )
          : undefined)
      : (progress: SharedValue<number>, translation: SharedValue<number>) => (
          <View style={sf.swipeGroup}>
            {/* remind shares this panel. */}
            <ExpandAction side="left" translation={translation} rowW={rowW} others={SWIPE_W} onCross={onCrossLeft}>
              <SwipeAction label="archive" fill={SWIPE_FILL_DIM} progress={progress} grow="left" onPress={act(() => onArchive(true))}>
                {ICON_ARCHIVE}
              </SwipeAction>
            </ExpandAction>
            {/* The label is the state. "remind" when there is nothing set and
                "cancel" when there is, so the button says what pressing it will
                do rather than what it is about. Second in the panel, so it can
                never be the one that expands — a destructive-feeling toggle
                should not be reachable by a full swipe. */}
            <SwipeAction
              label={flight.remindersSetAt === null ? 'remind' : 'cancel'}
              fill={SWIPE_FILL_DIM}
              progress={progress}
              onPress={act(async () => {
                onDone(await onRemind(flight.remindersSetAt === null));
              })}
            >
              {ICON_REMIND}
            </SwipeAction>
          </View>
        ),
    // remindersSetAt is a dependency because the left panel renders the label
    // that reads it. Without it the button would keep saying "remind" after the
    // reminder was set, until something else re-rendered the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archived, canRestore, act, onCrossLeft, flight.remindersSetAt, onRemind],
  );

  const rowStyle = [sf.row, roomy && sf.rowRoomy, last && sf.rowLast];

  // The children container is exactly the row's width, so this is the width the
  // expansion fills and the width the threshold is a fraction of. Lifted out
  // because both wrappers below need it and a second copy could drift.
  const onRowLayout = (e: LayoutChangeEvent) => { rowW.value = e.nativeEvent.layout.width; };

  // THE ROW'S FILL, AND WHY IT IS NOT A PLAIN STYLE.
  //
  // The panels are absoluteFill siblings UNDER the children, so a transparent
  // row does not occlude them: the moment one is uncovered it is legible
  // straight through the flight number and the date. A flat opaque fill fixes
  // that and costs the archive sheet its glass — every row became a hole in it,
  // at any colour, because that sheet's ground is not one colour but whatever
  // the blur is sampling behind it.
  //
  // SO IT IS ONLY OPAQUE WHILE IT NEEDS TO BE. At rest the row paints nothing
  // and the sheet shows through it; from the first frame of a drag it is the
  // page's own colour, which is what the saved list is sitting on anyway.
  //
  // An epsilon rather than !== 0, so a spring that settles a hair off zero
  // cannot leave the row opaque for the rest of its life.
  const dragX = useSharedValue(0);
  const surfaceStyle = useAnimatedStyle(() => ({
    backgroundColor: Math.abs(dragX.value) < 0.5 ? 'transparent' : PAGE_BG,
  }));

  // ONE BODY, TWO WRAPPERS. The row renders identically either way; only whether
  // it responds to a tap differs, so the contents are lifted out rather than
  // written twice.
  const rowBody = (
    <>
      <View style={sf.line1}>
        <Text style={sf.number}>{flight.flightNumber}</Text>
        {/* ICON_REMIND's path data at 11pt, not the element itself: that
            constant strokes in SWIPE_INK_DIM, which is the ink for a glyph
            sitting on a filled button and is far too bright for a mark on the
            page. The stroke is thickened to 2.25 because 1.75 in a 24-unit
            viewBox drawn at 11pt is a hairline that disappears. */}
        {flight.remindersSetAt !== null && (
          <Svg width={11} height={11} viewBox="0 0 24 24" style={sf.remindMark}>
            <Path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18" fill="none" stroke={REMIND_DOT} strokeWidth={2.25} />
            <Path d="M12 7v5l3 2" fill="none" stroke={REMIND_DOT} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        )}
        {/* Cities, not codes. "Bangalore → Delhi" says where the flight goes to
            someone who does not read IATA, which is most people. city arrived in
            schema v5, so a record older than that carries null and falls back to
            the code it has always shown.

            At 320pt the row leaves 149.6pt here — nineteen characters of 13pt
            JetBrains Mono — which covers most pairs. A longer one ellipsizes in
            the MIDDLE rather than at the end, because losing the destination
            entirely is worse than losing the middle of both names. numberOfLines
            holds it to one line, so the row's height is unchanged either way. */}
        <Text style={sf.route} numberOfLines={1} ellipsizeMode="middle">
          {`${flight.from.city || flight.from.iata} → ${flight.to.city || flight.to.iata}`}
        </Text>
        {/* Two instances of one number are otherwise identical rows telling
            apart only by a countdown. The route text flexes, so this sits hard
            against the × on the right — a column of dates down the list rather
            than a value that drifts with the length of the route beside it.
            Hidden entirely when the date is not one: a pre-v3 record filed
            under "unknown" has nothing truthful to show here. */}
        {/* routeDateLabel, not routeShortDate: "Sat 29 Aug" rather than "29 Aug".
            It already exists for the applied-date line above the route list, so
            the weekday is spelled the same way in both places by construction.

            WIDTH, at 320pt. JetBrains Mono advances 0.6em, so 11pt is 6.6pt a
            character and this date is 10 of them, 66pt. The other cells on the
            line are the number and an 8pt gap, both fixed, so everything else
            is the route text.

            The × used to sit here too and took 24pt with it — a 20pt glyph is
            12pt of advance, plus 12pt of padding — all of which has gone back
            to the route.

            THE ROW DOES NOT GET TALLER, and cannot. The route already carries
            numberOfLines={1} with ellipsizeMode="middle", so it absorbs the
            loss by ellipsizing further into the middle of the pair rather than
            by wrapping — "Bangalore → Delhi" still fits, "Thiruvananthapuram →
            Chandigarh" loses more of its middle than it did. The date itself is
            numberOfLines={1} and unflexed, so it keeps its intrinsic width and
            never wraps either. Losing the middle of a route the heading does
            not repeat is the cost; telling two instances of one flight number
            apart by more than a bare number is what it buys. */}
        {ISO_DAY_RE.test(flight.flightDate) && (
          <Text style={sf.date} numberOfLines={1}>{routeDateLabel(flight.flightDate)}</Text>
        )}
      </View>
      {/* Two second lines, and which one shows is decided by the clock rather
          than by the record. A row in the archive whose arrival has passed is
          finished, so it says so and stops there; anything else keeps the live
          line, which is what a manually archived future flight still needs. */}
      {archived && hasFlown(flight, now) ? (
        <Text style={sf.landed}>{'landed'}</Text>
      ) : (
        <StatusLine f={flight} now={now} numberOfLines={1} style={{ marginTop: 4 }} />
      )}
    </>
  );

  return (
    // The x stays. This is an addition, so the one control that is visible
    // without knowing the gesture exists is the one that must not move.
    //
    // RESISTANCE, in two grades, because the drag has two regions.
    //
    // friction 1.15 across the whole drag. The row is applied as
    // `userDrag / friction`, so it travels at 87% of the finger: enough lag to
    // feel like something is being pulled, not enough to feel weighed down. The
    // 128pt panel now costs 147pt of finger instead of 128.
    //
    // overshootFriction 2 past the open panel, where the row moves at half the
    // finger. This is the firmer grade, and it is what makes the panel's own
    // width feel like a detent rather than a place the row happens to be
    // passing. The docs suggest 8 or above "for a native feel", which is right
    // when the space past the panel is dead; here it holds the expansion
    // threshold, so 8 would put that threshold 256pt of finger further out and
    // make the gesture a two-stroke affair. At 2 the threshold sits at 221pt of
    // travel on a 320pt row — one comfortable stroke, and 61pt more than the
    // 160 it cost when the row was free.
    //
    // 1 was the previous value for both, which is the library's default and
    // means no resistance anywhere: the row was simply under the finger, and
    // past the panel it kept going as if nothing were attached to it.
    //
    // OVERSHOOT IS BACK ON, which is the library's own default and which it
    // expresses by omission: overshootLeft ?? leftWidth > 0.
    //
    // It was off on the reasoning that letting the row be pulled past the panel
    // promises a full swipe that does not exist. It exists now, so the reasoning
    // inverts: the travel past the panel is where the expansion threshold lives,
    // and without overshoot the row hits a wall at 128pt and the threshold at
    // half the row width is unreachable. The rubber band is not decoration here,
    // it is the only way to get to the gesture.
    //
    // overshootFriction is left at its default of 1, which is no friction at
    // all. The docs suggest 8 or above "for a native feel", and that is right
    // when the region past the panel is dead space to be resisted. Here it is
    // functional, so resisting it would be resisting the gesture: at 8, reaching
    // a threshold 32pt beyond the panel would cost 256pt of extra finger.
    //
    // childrenContainerStyle carries the background: it is the layer the library
    // translates, so the fill travels with the row and occludes the panel it is
    // sliding over. See surfaceStyle: it is transparent until the drag starts,
    // so the glass behind an archive row is only occluded while something is
    // actually being uncovered.
    // The wrapper the commit animates, outside the Swipeable because the
    // library owns the translation inside it. No style of its own beyond the
    // transform, so it costs nothing until a row is actually thrown.
    <Reanimated.View style={exitStyle}>
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.15}
      overshootFriction={2}
      animationOptions={SWIPE_SPRING}
      onSwipeableWillOpen={onWillOpen}
      childrenContainerStyle={surfaceStyle}
      renderLeftActions={renderLeft}
      renderRightActions={renderRight}
    >
    {/* A PLAIN VIEW ON ARCHIVE ROWS, not a disabled TouchableOpacity. A dead
        touchable still reads as one to anything inspecting the tree, and the
        next person to add a prop to it would be adding it to a control that is
        not a control. The View keeps the layout, the padding and the measured
        width, and has no press behaviour to suppress — no onPress, and no
        activeOpacity, so the row does not dim under a finger and does not
        invite the tap it would ignore.

        THE SWIPE IS UNTOUCHED and deliberately so: ReanimatedSwipeable is the
        parent, not this element, so archive, restore, delete and remind all
        still work. Restore in particular has to stay reachable — without it a
        flight archived by mistake could not be brought back. */}
    {archived ? (
      <View style={rowStyle} onLayout={onRowLayout}>
        {rowBody}
      </View>
    ) : (
      <TouchableOpacity
        style={rowStyle}
        onPress={onPress}
        activeOpacity={0.7}
        onLayout={onRowLayout}
      >
        {rowBody}
      </TouchableOpacity>
    )}
    </ReanimatedSwipeable>
    </Reanimated.View>
  );
}, sameRow);

const sf = StyleSheet.create({
  row: {
    paddingVertical: 13,
    paddingHorizontal: CARD_PAD,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    marginBottom: CARD_GAP,
  },
  // Applied after sf.row, so it is this paddingVertical that survives.
  rowRoomy: { paddingVertical: 18 },
  // Last in its list. It used to drop the hairline; now it drops the gap, which
  // is the same job — the list ends where its last card ends rather than eight
  // points of nothing later.
  rowLast: { marginBottom: 0 },
  line1: { flexDirection: 'row', alignItems: 'center' },
  number: { fontSize: 13, color: '#ffffff', fontFamily: MONO_BOLD },
  // Against the number, not the route: it is a fact about this flight rather
  // than about where it goes.
  remindMark: { marginLeft: 6 },
  // Deliberately outside the type scale: this is a hit target, not text.
  chevron: { fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)' },
  // detailsTitle carries marginBottom: 10, so the chevron beside it needs the
  // same or the two sit on different baselines.
  headingTap: { flexDirection: 'row', alignItems: 'center' },
  chevronLeft: {
    fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)',
    marginRight: 8, marginBottom: 10,
  },
  // marginBottom matches detailsTitle's, so the icon shares the heading's
  // baseline. The collapsed line has no such offset, hence the second style.
  archiveBtn: { marginBottom: 10 },
  archiveBtnCollapsed: { paddingLeft: 12 },
  noneActive: {
    fontSize: 11, color: 'rgba(226,226,226,0.4)', fontFamily: SANS,
    paddingVertical: 10,
  },
  collapsedRow: { flexDirection: 'row', alignItems: 'center' },
  collapsedLine: { paddingVertical: 10, flex: 1 },
  collapsedNumber: { fontFamily: MONO, fontSize: 11, color: '#ffffff' },
  collapsedDim: { fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.45)' },
  route: { fontSize: 13, color: 'rgba(226,226,226,0.6)', fontFamily: MONO, flex: 1, marginLeft: 12 },
  // Supporting detail, so a step down in size and two steps down the grey ramp
  // from the route beside it. Same 11pt mono the codes line under the route
  // heading uses.
  // MONO_BOLD and a step up the ramp: with two instances of one number in the
  // list this is what tells them apart, so it had to stop whispering.
  date: { fontSize: 11, color: 'rgba(226,226,226,0.6)', fontFamily: MONO_BOLD, marginLeft: 8 },
  updated: { color: 'rgba(226,226,226,0.3)' },
  // getStatusColor('landed') exactly, and the same 11pt mono StatusLine renders
  // at, so the archive's line sits where the saved list's line sits and in the
  // colour that word already has everywhere else in the app.
  landed: { fontFamily: MONO, fontSize: 11, color: '#8e8e93', marginTop: 4 },
  // Stretches to the row's height however tall the row is, so a roomy archive
  // row and a dense saved row both get a full-height target.
  // CENTRE, not stretch — the buttons have their own height now.
  //
  // marginBottom is what makes "centred" mean centred on the CARD: the panel
  // this group fills spans the row's whole box, and the row's box includes the
  // card gap below it. Without this the buttons sit half a gap low.
  swipeGroup: { flexDirection: 'row', alignItems: 'center', marginBottom: CARD_GAP },
});

function ProfileModal({
  visible, onClose, onGoogleSignIn, onLogout, username,
  email, effectiveName, askName, onSaveName, onSkipName,
}: {
  visible: boolean; onClose: () => void; onGoogleSignIn: () => void; onLogout: () => void;
  username: string | null; email: string | null; effectiveName: string | null; askName: boolean;
  onSaveName: (name: string) => void; onSkipName: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(effectiveName ?? '');
  const [editing, setEditing] = useState(false);

  // Re-seed each time the sheet opens so a discarded edit does not linger.
  useEffect(() => {
    if (visible) {
      setNameDraft(effectiveName ?? '');
      setEditing(false);
    }
  }, [visible, effectiveName]);

  // The first-run ask forces the input open; otherwise the pencil does.
  const showInput = askName || editing;

  const commitName = () => {
    const cleaned = sanitiseDisplayName(nameDraft);
    if (!cleaned) return;            // empty after sanitising: keep the old value and stay open
    setEditing(false);
    onSaveName(cleaned);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={askName ? onSkipName : onClose}>
      <View style={pm.backdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={pm.sheet}>
            <GlassLayers />
            {/* On top of the shared pair, not instead of it. See PROFILE_FILL. */}
            <View style={[StyleSheet.absoluteFill, pm.tint]} pointerEvents="none" />
            <TouchableOpacity style={pm.closeBtn} onPress={askName ? onSkipName : onClose}>
              <Text style={pm.closeTxt}>X</Text>
            </TouchableOpacity>

            <View style={pm.avatar}>
              <Text style={pm.avatarTxt}>{'//'}</Text>
            </View>
            {username !== null && showInput && (
              <>
                <Text style={pm.nameLabel}>{askName ? 'pick a name' : 'username'}</Text>
                <View style={pm.nameRow}>
                  <TextInput
                    style={pm.nameInput}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    onSubmitEditing={commitName}
                    placeholder="terminal"
                    placeholderTextColor="rgba(226,226,226,0.25)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={14}
                    selectionColor="#4ade80"
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={pm.nameBtn} activeOpacity={0.75} onPress={commitName}>
                    <Text style={pm.nameBtnTxt}>{'save'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {username !== null && !showInput && (
              <View style={pm.nameLine}>
                <Text style={pm.name}>{effectiveName ?? 'Guest User'}</Text>
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => setEditing(true)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Text style={pm.pencil}>{'\u270E'}</Text>
                </TouchableOpacity>
              </View>
            )}

            {username === null && (
              <Text style={[pm.name, { marginBottom: 8 }]}>{effectiveName ?? 'Guest User'}</Text>
            )}

            <Text style={pm.sub}>{username ? (email ? `signed in as ${email}` : 'signed in') : 'Sign in to sync your flights'}</Text>

            {!username && (
              <>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75} onPress={onGoogleSignIn}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 24 24">
                      <G>
                        <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                        <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </G>
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Google </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 21 21">
                      <Rect x="1" y="1" width="9" height="9" fill="#F25022" />
                      <Rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                      <Rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                      <Rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Microsoft </Text>
                  </View>
                </TouchableOpacity>
              </>
            )}

            {username && (
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={onLogout}
                style={{ alignSelf: 'center', marginTop: 20, paddingVertical: 8 }}
              >
                <Text style={{ fontFamily: SANS, fontSize: 13, color: 'rgba(248,113,113,0.7)' }}> Log out </Text>
              </TouchableOpacity>
            )}

          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

export default function Index() {
  // THE STORE, AND WHAT IS LEFT HERE WITHOUT IT. Everything that REPORTS on the
  // saved list stayed on this screen — the toasts, the undo banner, the refresh
  // message, the collapse state and the archive sheet — and everything that
  // decides what the list IS went to lib/saved.tsx.
  //
  // `now` IS NOT ON IT, deliberately. This screen keeps its own minute tick below
  // for the countdowns; the store runs a separate one for the day rollover and
  // the AppState resume. See the note at the top of lib/saved.tsx.
  const {
    savedFlights, email, setEmail, refreshing,
    saveRecord, handleUnsave, undoUnsave, refreshOne, refreshAll,
    handleRemind, setArchived,
  } = useSaved();
  // THE TWO BANNERS ARE NO LONGER THIS SCREEN'S. Both moved to lib/toast.tsx and
  // are rendered by the provider in app/_layout.tsx, because the search screen
  // raises most of them now — a banner drawn here reports nothing while the user
  // is looking at a search result.
  const { showToast } = useToast();
  // THE GMAIL TOKEN. This screen only ever WRITES it — sign-in and logout are
  // both here — and the search screen is what reads it, for the /chat request.
  // See lib/account.tsx.
  const { persistGmailToken } = useAccount();
  // EVERYTHING THIS SCREEN NEEDS TO OWN A FLIGHT CARD, and the search screen owns
  // one too. The lookup, the save, the refresh, the entry animation, the error
  // channel and the minute tick moved to lib/flightcard.tsx so that a card opened
  // from a watchlist row and a card opened from a route row are the same card
  // driven the same way. `now` came with them, and still ticks this screen's
  // countdowns, its archive split and its clock.
  const {
    now,
    flight, setFlight,
    flightRecord, setFlightRecord,
    error, setError,
    setSaveError,
    setLastUpdated,
    errorMsgOpacity, resultOpacity, resultTranslate,
    showResult, isSaved, unsaveWithBanner,
    handleToggleSave, refreshFlightCard,
    routeOnMap, toggleRouteOnMap,
    isOwnedFlight, toggleOwned,
  } = useFlightCardHost();
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  // Persisted under 'savedCollapsed'. Starts true so an absent key means
  // collapsed; hydration only overrides it when the key exists.
  const [savedCollapsed, setSavedCollapsed] = useState(true);
  // THIS SCREEN'S OWN HYDRATION FLAG, and not the store's. It gates the collapse
  // state and the first-run ask, both of which are read out of the pass below;
  // lib/saved.tsx keeps a private one of its own for the account it reads there.
  const [authHydrated, setAuthHydrated] = useState(false);
  // Picked on mount, re-picked only by onRefresh. The header re-renders every
  // 60s on the `now` tick, so choosing this during render would reshuffle the
  // greeting every minute. 60 is a whole multiple of every pool length (3 and
  // 2), so the modulo stays uniform.
  const [greetingIndex, setGreetingIndex] = useState(() => Math.floor(Math.random() * 60));
  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshMsgCounter, setRefreshMsgCounter] = useState(0);
  const [refreshTone, setRefreshTone] = useState<'error' | 'info'>('error');
  const insets = useSafeAreaInsets();

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    iosClientId: '970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e.apps.googleusercontent.com',
    androidClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    redirectUri: 'com.googleusercontent.apps.970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e:/oauth2redirect',
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  });

  useEffect(() => {
    console.log('[Auth] response:', JSON.stringify(response));
    if (response?.type === 'success') {
      const accessToken = response.authentication?.accessToken;
      if (!accessToken) return;
      (async () => {
        try {
          const userInfo = await fetch('https://www.googleapis.com/userinfo/v2/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const user = await userInfo.json();
          const name = user.email.split('@')[0].match(/^[a-zA-Z]+/)[0];
          const validEmail = typeof user.email === 'string' && user.email.trim() ? user.email : null;
          await SecureStore.setItemAsync('username', name);
          // BOTH HALVES IN ONE CALL, where this was a storage write here and a
          // setState three lines below. The token is lib/account.tsx's now — the
          // search screen sends it to /chat and cannot see this screen's state —
          // and that module writes and sets together so a caller cannot do one
          // without the other. Nothing else on these lines moved.
          await persistGmailToken(accessToken);
          if (validEmail) await SecureStore.setItemAsync('email', validEmail);
          setUsername(name);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        } catch (err) {
          console.log('[Auth] userinfo fetch error:', err);
        }
      })();
    }
  }, [response]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const u = localStorage.getItem('username');
      if (u) setUsername(u);
      const dn = localStorage.getItem('displayName');
      if (dn) setDisplayName(dn);
      // Resolved before authHydrated, which gates the saved-list load, so the
      // section never renders expanded and then snaps shut.
      AsyncStorage.getItem('savedCollapsed').then(c => {
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    } else {
      // 'email' IS NOT READ HERE ANY MORE. lib/saved.tsx reads it itself, because
      // the store owns the account it is keyed on; leaving it here would have
      // made this screen the authority on when the store is ready. Sign-in and
      // logout still WRITE it, through setEmail off the hook.
      Promise.all([
        SecureStore.getItemAsync('username'),
        SecureStore.getItemAsync('displayName'),
        AsyncStorage.getItem('savedCollapsed'),
      ]).then(([u, dn, c]) => {
        if (u) setUsername(u);
        if (dn) setDisplayName(dn);
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    }
  }, []);

  // First-run ask. Only after hydration, only when signed in, and only while
  // displayName is still unset — which skipping also fills, so it asks once.
  //
  // NO GUARD REF, AND IT DOES NOT NEED ONE. Setting profileOpen twice is
  // idempotent, which is what a modal buys over a route: the navigate this
  // briefly became had to remember whether it had already asked, because
  // navigating twice is not the same as navigating once.
  useEffect(() => {
    if (!authHydrated) return;
    if (username === null) return;
    if (displayName !== null) return;
    setProfileOpen(true);
  }, [authHydrated, username, displayName]);

  // AND NO FOCUS EFFECT. While the profile was a screen this file re-read
  // username, email and displayName from storage every time home came back into
  // focus, because the other screen owned its own copies and wrote them behind
  // this one's back. A modal is inside this component and sets this component's
  // state directly, so there is nothing to pick up on the way back and no read
  // to race the hydration effect above.

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      (window as any).google.accounts.id.initialize({
        client_id: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
        scope: 'profile email https://www.googleapis.com/auth/gmail.readonly',
        callback: (credentialResponse: any) => {
          const payload = JSON.parse(atob(credentialResponse.credential.split('.')[1]));
          const firstName = (payload.email as string).split('@')[0].match(/^[a-zA-Z]+/)?.[0] || 'user';
          const validEmail = typeof payload.email === 'string' && payload.email.trim() ? payload.email : null;
          localStorage.setItem('username', firstName);
          if (validEmail) localStorage.setItem('email', validEmail);
          setUsername(firstName);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        },
      });
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);


  const badgePulse = useRef(new Animated.Value(1)).current;
  const refreshMsgOpacity = useRef(new Animated.Value(0)).current;
  const refreshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiveAnim = useRef(new Animated.Value(0)).current;
  const archiveScrimAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (flight?.status === 'ACTIVE') {
      Animated.loop(Animated.sequence([
        Animated.timing(badgePulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
        Animated.timing(badgePulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])).start();
    } else {
      badgePulse.stopAnimation();
      badgePulse.setValue(1);
    }
  }, [flight]);

  useEffect(() => {
    if (refreshMsg === '') return;
    if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current);
    refreshMsgOpacity.stopAnimation();
    refreshMsgOpacity.setValue(1);
    Animated.timing(refreshMsgOpacity, { toValue: 0, duration: 500, delay: 4500, useNativeDriver: false }).start();
    refreshMsgTimerRef.current = setTimeout(() => setRefreshMsg(''), 5000);
    return () => { if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current); };
  }, [refreshMsg, refreshMsgCounter]);

  // Same two-layer rise the calendar sheet uses, on the same curves and
  // durations. One approach for every sheet in the file.
  useEffect(() => {
    if (!archiveOpen) return;
    archiveAnim.setValue(0);
    archiveScrimAnim.setValue(0);
    Animated.parallel([
      Animated.timing(archiveScrimAnim, {
        toValue: 1, duration: SCRIM_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(archiveAnim, {
        toValue: 1, duration: CAL_IN_MS,
        easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [archiveOpen]);

  const renderSavedFlight = (saved: SavedFlight) => {
    // FIRST, as in handleSearch: the card is about to take the screen, and a
    // keyboard left standing over it is covering the thing the tap asked for.
    Keyboard.dismiss();
    setError("");
    setSaveError("");
    setFlightRecord(saved);
    // THE SAME DEMOTION THE ROW APPLIES, so tapping a row cannot contradict the
    // row that was tapped. Date.now() rather than the `now` state: this runs on
    // a tap rather than at render, and the tick that maintains `now` is a minute
    // wide.
    const storedStatus = saved.status.toLowerCase();
    const effective = effectiveStatus(saved, Date.now());
    // A CONTRADICTED rawStatus IS TREATED AS ABSENT, and this is the point of
    // the whole hunk. The provider said BOTH "landed" and "Arrived" about a
    // flight whose own arrival time had not come; the raw word is not a second
    // opinion, it is the same claim in finer detail, and the clock has just
    // refuted it. So it stops being evidence.
    //
    // NULLED AT THE CALL SITE rather than passed to badgeLabel as a third
    // "trusted" flag, for two reasons. badgeLabel already documents null as
    // "fall back to the display status", which is exactly the behaviour wanted,
    // so no new contract is needed; and the clock lives out here, where
    // effectiveStatus was already called, instead of being handed to a function
    // whose job is turning one string into another.
    //
    // The SAME value goes to displayStatus. It cannot change the outcome today —
    // demotion only fires on stored 'landed' or 'active', whose raw words are
    // Arrived, Departed, EnRoute or Approaching, and displayStatus only tests
    // for 'delayed' — but trusting the word in one call and not the other would
    // be a distinction with no reason behind it.
    const trustedRaw = effective === storedStatus ? saved.rawStatus : null;
    const savedStatus = displayStatus(effective, saved.from.delay, trustedRaw);
    const depCell = movementTimeCell(
      clock24(saved.from.actualIso, saved.from.actual),
      clock24(saved.from.estimatedIso, saved.from.estimated),
      clock24(saved.from.scheduledIso, saved.from.scheduled), true);
    const arrCell = movementTimeCell(
      clock24(saved.to.actualIso, saved.to.actual),
      clock24(saved.to.estimatedIso, saved.to.estimated),
      clock24(saved.to.scheduledIso, saved.to.scheduled), false);
    setFlight({
      flight: saved.flightNumber,
      airline: saved.airline,
      // As in flightDataFromApi: label from the provider's word, colour from the
      // mapped status. A pre-v10 record has rawStatus null and falls back to the
      // uppercased display status, which is what it already showed — and so now
      // does a record the clock has demoted, by the same route.
      status: badgeLabel(trustedRaw, savedStatus),
      statusColor: getStatusColor(savedStatus),
      statusBg: getStatusBg(savedStatus),
      from: saved.from.iata,
      fromFull: airportFullLabel(saved.from.shortName, saved.from.city, saved.from.airport),
      // Records saved before v5 carry city: null and fall back until refreshed.
      fromCity: saved.from.city || saved.from.airport,
      to: saved.to.iata,
      toFull: airportFullLabel(saved.to.shortName, saved.to.city, saved.to.airport),
      toCity: saved.to.city || saved.to.airport,
      dep: saved.from.scheduled || "N/A",
      arr: saved.to.scheduled || "N/A",
      depIso: saved.from.scheduledIso,
      arrIso: saved.to.scheduledIso,
      depTimeLabel: depCell.label,
      depTimeValue: depCell.value,
      arrTimeLabel: arrCell.label,
      arrTimeValue: arrCell.value,
      duration: scheduledDuration(saved.from.scheduledIso, saved.from.timezone, saved.to.scheduledIso, saved.to.timezone),
      terminal: saved.from.terminal || "N/A",
      gate: saved.from.gate || "N/A",
      checkinDesk: saved.from.checkinDesk ?? null,
      aircraft: saved.aircraftModel ?? null,
      registration: saved.aircraftRegistration ?? null,
      baggage: saved.to.baggage ?? "N/A",
      depDelay: saved.from.delay,
      arrDelay: saved.to.delay,
      date: saved.flightDate === 'unknown' ? "N/A" : saved.flightDate,
    });
    setLastUpdated(saved.updatedAt);
    showResult();
  };

  const onRefresh = async () => {
    // THE PULL IS THE STORE'S; THE MESSAGES ARE THIS SCREEN'S.
    //
    // onStarted FIRES SYNCHRONOUSLY, past the double-fire guard and above the
    // cooldown, which is exactly where these two statements sat. Acting on the
    // returned `ran` instead would have moved both to the far side of a network
    // round trip, and the greeting would reroll seconds after the pull.
    const r = await refreshAll(flightRecord?.id ?? null, () => {
      setGreetingIndex(Math.floor(Math.random() * 60));         // past the double-fire guard, above the cooldown: a throttled pull still rerolls
      setRefreshMsg("");
    });

    if (r.throttled) {
      setRefreshMsg('> already up to date');
      setRefreshTone('info');
      setRefreshMsgCounter(c => c + 1);
    }

    // THE OPEN CARD, and this is the second untangling: the refresh reports what
    // came back for it and this screen decides what to do with that. `r.list` is
    // the list as read back from storage rather than the state it set, because a
    // setState is not visible to the call that awaited it in the same turn.
    if (r.openCardFresh && r.list !== null) {
      // HOISTED, exactly as in runFlightLookup: the record was already being
      // built here for its id, so building it first costs nothing and lets one
      // clock check serve the card. It is also now built ONCE rather than
      // twice — the id below reads this record instead of calling
      // savedFlightFromApi a second time on the same response.
      const fresh = savedFlightFromApi(r.openCardFresh);
      setFlight(flightDataFromApi(r.openCardFresh, effectiveStatus(fresh, Date.now())));
      // By id, not by number: with two instances saved, matching on the number
      // alone could put the OTHER date's record behind the open card. The id
      // can also change across a refresh — a record filed under "unknown"
      // takes a real date the first time one comes back — so the fresh data's
      // id is tried first and the one the card was opened with second.
      const freshId = fresh.id;
      const stored = r.list.find(f => f.id === freshId)
        ?? r.list.find(f => f.id === (flightRecord?.id ?? ''));
      if (stored) setFlightRecord(stored);                  // from disk, so savedAt stays in sync
      setLastUpdated(fresh.updatedAt);
    }

    if (r.failures > 0) {
      setRefreshMsg(`> ${r.failures} ${r.failures === 1 ? 'flight' : 'flights'} could not be updated`);
      setRefreshTone('error');
      setRefreshMsgCounter(c => c + 1);
    }
  };

  // Everything on screen reads this; `username` stays exactly as sign-in derived it.
  const effectiveName = displayName ?? username;

  // Derived per render from a copy; savedFlights itself is never reordered.
  // Split once, here, so nothing below has to remember which list it wants.
  // `now` ticks, so a flight crosses into the archive on screen without a
  // reload.
  // -- WHAT HOME SHOWS, WHICH IS NOT EVERYTHING IT STORES -------------------
  //
  // A FLIGHT THE USER IS FLYING BELONGS TO MY FLIGHTS, and appears there in
  // full: its legs in order, its phase, its gate, its belt. Showing it here as
  // well would put one flight in two lists with two different treatments and two
  // different sets of controls -- a swipe-to-archive on one screen and a
  // phase-driven card on the other, both claiming the same record.
  //
  // A FILTER ON WHAT IS DISPLAYED AND NOTHING ELSE. The record is untouched, it
  // is still in savedFlights, the refresh loop still reaches it -- refreshAll
  // reads savedFlights directly, not this -- and disowning it from My Flights
  // brings it straight back here with everything it had.
  //
  // BOTH LISTS, DELIBERATELY, AND NOT JUST THE LIVE ONE. Filtering only
  // activeSaved would keep an owned flight out of the watchlist until it landed
  // and then let it reappear in home's ARCHIVE -- the duplication returning at
  // the worst moment, when the user has stopped thinking about the trip and the
  // two copies are hardest to explain. One filter, above the split, so neither
  // half can be forgotten.
  const watchlist = savedFlights.filter(f => !isOwned(f));
  const activeSaved = watchlist.filter(f => !isArchived(f, now));
  // Most recent first: the flight that landed an hour ago before the one from
  // last March.
  const archivedSaved = watchlist
    .filter(f => isArchived(f, now))
    .sort((a, b) => (arrivalTs(b) ?? 0) - (arrivalTs(a) ?? 0));

  const sortedSaved = sortSavedByRelevance(activeSaved, now);

  // ONE definition, rendered in both the collapsed and the expanded state.
  // The archive is not part of the saved list — it holds the flights that are
  // no longer in it — so collapsing the list must not take it away too. It keeps
  // the same place either way: the right-hand end of the section's top line.
  const archiveButton = (style: any) => (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => { Keyboard.dismiss(); setArchiveOpen(true); }}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={style}
    >
      {/* An archive box: lid, body, and the pull on its front. Same 18x18 /
          24-viewBox / 1.75-stroke treatment as the bookmark on the flight
          card. */}
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path d="M3 5h18v4H3z" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
        <Path d="M5 9v10h14V9" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
        <Path d="M10 13h4" fill="none" stroke={ARCHIVE_ICON} strokeWidth={1.75} />
      </Svg>
    </TouchableOpacity>
  );

  // The stagger, read off the sheet's own value. Clamped at both ends so a row
  // is fully hidden before its slot and fully settled after it, and so the
  // input range is always strictly increasing: the last slot ends at 0.87.
  const archiveRowStyle = (i: number) => {
    const start = Math.min(i, ARCHIVE_ROW_MAX) * ARCHIVE_ROW_STAGGER;
    const end = start + ARCHIVE_ROW_FADE;
    return {
      opacity: archiveAnim.interpolate({
        inputRange: [start, end], outputRange: [0, 1], extrapolate: 'clamp' as const,
      }),
      transform: [{
        translateY: archiveAnim.interpolate({
          inputRange: [start, end],
          outputRange: [ARCHIVE_ROW_RISE, 0],
          extrapolate: 'clamp' as const,
        }),
      }],
    };
  };

  // Unmounts only once both layers have left, exactly as closeRouteCal does.
  const closeArchive = () => {
    Animated.parallel([
      Animated.timing(archiveAnim, {
        toValue: 0, duration: CAL_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(archiveScrimAnim, {
        toValue: 0, duration: SCRIM_OUT_MS,
        easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setArchiveOpen(false));
  };

  const persistCollapsed = async (next: boolean) => {
    setSavedCollapsed(next);
    try { await AsyncStorage.setItem('savedCollapsed', next ? 'true' : 'false'); } catch {}
  };

  const persistDisplayName = async (name: string) => {
    if (Platform.OS === 'web') localStorage.setItem('displayName', name);
    else await SecureStore.setItemAsync('displayName', name);
    setDisplayName(name);
  };

  // CLOSING A CARD ON HOME IS THE FULL CLEAR. The branch this used to carry
  // tested for a route list to fall back to, and there is none here: home's card
  // is always opened by tapping a watchlist row. That branch went to the search
  // screen with the results it tested for.
  const closeFlightCard = () => {
    clearResultView();
  };

  // FOUR OF THE SEVEN. chatResponse, routeResult and the query are the search
  // screen's, and it clears its own — see the account watch there. What is left
  // is what sign-in and logout still need cleared on this screen.
  const clearResultView = () => {
    setFlight(null);
    setFlightRecord(null);
    setSaveError("");
    setError("");
  };

  return (
    <View style={s.root}>
      <ProfileModal
        visible={profileOpen}
        onClose={() => setProfileOpen(false)}
        username={username}
        email={email}
        effectiveName={effectiveName}
        askName={username !== null && displayName === null}
        onSaveName={async (name) => { await persistDisplayName(name); setProfileOpen(false); }}
        onSkipName={async () => { if (username) await persistDisplayName(username); setProfileOpen(false); }}
        onLogout={async () => {
          if (Platform.OS === 'web') {
            localStorage.removeItem('username');
            localStorage.removeItem('email');
            localStorage.removeItem('displayName');
          } else {
            await SecureStore.deleteItemAsync('username');
            await SecureStore.deleteItemAsync('email');
            await SecureStore.deleteItemAsync('displayName');
          }
          setUsername(null);
          setDisplayName(null);
          // The delete came off the native branch above and went with it: this
          // clears the key and the value together, and carries the same web guard
          // that branch gave it. See lib/account.tsx.
          await persistGmailToken(null);
          setEmail(null);
          clearResultView();
          setProfileOpen(false);
        }}
        onGoogleSignIn={async () => {
          console.log('Google sign in tapped, platform: ' + Platform.OS);
          setProfileOpen(false);
          if (Platform.OS === 'web') {
            (window as any).google?.accounts?.id?.prompt();
          } else {
            promptAsync();
          }
        }}
      />
      {/* ── DATE CALENDAR ── */}
      <Modal visible={archiveOpen} transparent animationType="none" onRequestClose={closeArchive}>
        <Pressable style={g.routeCalScrim} onPress={closeArchive}>
          {/* The dim alone, full screen and unblurred. The blur lives inside the
              sheet now, so outside it the page stays sharp. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: archiveScrimAnim }]}
          />
          {/* Unchanged: the same rise, scale and fade the calendar sheet uses. */}
          <Animated.View
            style={[
              g.sheetShell,
              s.archiveSheet,
              {
                opacity: archiveAnim,
                transform: [
                  { translateY: archiveAnim.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                  { scale: archiveAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
          >
            {/* THE GLASS. Three layers, in this order and no other: the blur
                samples what is behind the sheet, the tint darkens the result,
                and the hairline draws the edge. The first two are clipped by
                the shell's overflow to the 16pt radius, so the blur stops
                exactly where the panel does; the third carries its own matching
                radius and lands on that same edge.

                The first two now come from GlassLayers, which every other glass
                surface renders too. They were written out here once; that was
                one copy of the material too many. */}
            <GlassLayers />
            <View style={g.sheetEdge} pointerEvents="none" />
            {/* Swallows the tap so the scrim's dismiss does not fire through. */}
            <Pressable style={[g.sheetBody, g.sheetBodyFill]}>
              <View style={g.sheetHead}>
                {/* Exactly the close button's width, so the title centres on the
                    sheet rather than on whatever space is left beside it. */}
                <View style={g.sheetHeadSpacer} />
                <Text style={g.sheetTitle}>{'Archives'}</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={closeArchive}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={g.sheetClose}
                >
                  {/* The app's own close X, character for character: the same
                      20pt box, the same 5..19 span, the same weight, cap and
                      red the calendar sheet and the flight card already use.
                      The ring it used to sit in is gone — nothing else in the
                      file outlines an icon, and it was the outline rather than
                      the glyph that made this control look borrowed. */}
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
              {archivedSaved.length === 0 ? (
                <Text style={s.archiveEmpty}>
                  {'Nothing here yet. A flight moves in a few hours after it lands.'}
                </Text>
              ) : (
                <ScrollView style={s.archiveList} showsVerticalScrollIndicator={false}>
                  {archivedSaved.map((f, i) => (
                    <Animated.View key={f.id} style={archiveRowStyle(i)}>
                      <SavedFlightRow
                        flight={f}
                        now={now}
                        roomy
                        archived
                        last={i === archivedSaved.length - 1}
                        onDone={showToast}
                        onRemind={(on) => handleRemind(f, on)}
                        onUnsave={() => unsaveWithBanner(f)}
                        onArchive={(on) => setArchived(f, on)}
                      />
                    </Animated.View>
                  ))}
                </ScrollView>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, paddingTop: insets.top + 12 }}>
        {/* CLEARANCE FOR THE FLOATING BAR, applied here rather than in
            s.scroll because it depends on the safe-area inset and a StyleSheet
            entry cannot read one. insets is already in scope for the
            paddingTop above.

            AND IT DOES NOT TRACK THE BAR'S HEIGHT. profile.tsx derives its
            footer clearance from TAB_BAR_HEIGHT; this deliberately does not,
            because it is not trying to clear anything. Do not "fix" it to match.

            24 IS DELIBERATELY NOT ENOUGH TO CLEAR THE BAR. GlassTabBar's top
            edge is insets.bottom + 64 off the bottom of the screen, so at 24
            the last rows of the list end UNDER it and scroll past behind the
            glass. That is the point: a blur with nothing behind it is a grey
            pill, and the material only reads as glass while something is moving
            underneath it.

            PROFILE DOES THE OPPOSITE, at insets.bottom + 76, and the difference
            is what the content is. Home ends in a list, and a list that
            continues under an edge is understood — you can see there is more and
            you can scroll it out. The profile screen ends in its version and its
            data credit, which are read once and never scrolled; half a line of
            those behind frosted glass is not atmosphere, it is a defect.

            THE ONLY BOTTOM PADDING THERE IS. s.scroll carried 48 and no longer
            carries anything: two sources for one edge, one of which could not
            see the inset, is how a page ends up with a gap nobody can account
            for. s.scroll keeps the horizontal padding, which does not depend on
            anything at runtime. */}
        <ScrollView
          contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4ade80" colors={["#4ade80"]} />
          }
        >

          {/* ── HEADER ── */}
          <View style={[s.header, effectiveName === null && { marginBottom: 16 }]}>
            <View>
              <Text style={{ fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 }}>{'>_'}</Text>
              {/* 24, UP FROM 20. It is the first line a person reads on
                  opening the app and it was the same size as a card's flight
                  number, which put a greeting and a datum on one footing. The
                  clock below moves with it -- see the note there -- so the
                  two grow together and the hierarchy between them is kept. */}
              {effectiveName !== null && (
                <Text style={{ fontFamily: SANS_SEMI, fontSize: 24, color: '#e2e2e2', marginTop: 10 }}>{`${greetingPrefix(now, greetingIndex)}, ${effectiveName}`}</Text>
              )}
              {/* 15, UP FROM 13, WHICH KEEPS IT THE SMALLER OF THE TWO.
                  20:13 was 1.54; 24:15 is 1.60, so the gap widens slightly
                  rather than closing -- the greeting is still plainly the
                  heading and this is still plainly the line under it. The 0.4
                  alpha does the rest of the separating and is unchanged. */}
              {effectiveName !== null && (
                <Text style={{ fontFamily: MONO, fontSize: 15, color: 'rgba(226,226,226,0.4)', marginTop: 3 }}>{formatClock(now)}</Text>
              )}
            </View>
            {/* The modal has its own TextInput and its own KeyboardAvoidingView
                and will raise a keyboard of its own if it asks for a name; what
                is dismissed here is the one that was already up behind it. */}
            {username !== null && (
              <TouchableOpacity style={s.profileBtn} onPress={() => { Keyboard.dismiss(); setProfileOpen(true); }}>
                <Text style={s.profileTxt}>{'>//'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* THE ERROR CHANNEL, and it is still here because home can still
              produce one: a card opened from a watchlist row can be refreshed,
              and a refresh can fail. The line is in lib/flightcard.tsx so
              that both screens report a failure in the same words, in the same
              place, with the same fade.

              IT SITS WHERE THE COMMAND LINE SAT. That block is on the search
              screen now and its input is the tab bar's. */}
          <FlightError error={error} errorMsgOpacity={errorMsgOpacity} />

          {username === null && (
            <View style={{ alignItems: 'center', marginBottom: 24, marginTop: 0 }}>
              <Text style={{ fontFamily: SANS, color: 'rgba(226,226,226,0.5)', fontSize: 11, marginBottom: 12, textAlign: 'center' }}>
                {'// sign in to pull your flights straight from gmail'}
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (Platform.OS === 'web') {
                    (window as any).google?.accounts?.id?.prompt();
                  } else {
                    promptAsync();
                  }
                }}
                style={{ backgroundColor: '#131314', borderWidth: 1, borderColor: '#5f6368', borderRadius: 4, paddingVertical: 11, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' }}
              >
                <Svg width={18} height={18} viewBox="0 0 48 48" style={{ marginRight: 10 }}>
                  <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </Svg>
                <Text style={{ fontFamily: SANS, color: '#e3e3e3', fontSize: 13 }}>Sign in with Google</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* GATED ON watchlist, NOT ON savedFlights. The section is about what
              home SHOWS, and it is gated on the same list it renders. A heading
              and an archive button over "Nothing upcoming" is a section
              reporting on a list that no longer has anything to do with it --
              which is exactly what a user whose every saved flight is owned
              would have seen. */}
          {watchlist.length > 0 && flight === null && (
            <View style={{ marginBottom: 24 }}>
              {/* Above the collapse branch: a refresh failure must never be silent. */}
              {refreshMsg !== '' && (
                <Animated.View style={{ opacity: refreshMsgOpacity }}>
                  <Text style={{
                    fontFamily: SANS,
                    fontSize: 11,
                    marginTop: 4,
                    marginBottom: 2,
                    color: refreshTone === 'info' ? 'rgba(226,226,226,0.3)' : 'rgba(248,113,113,0.8)',
                  }}>{refreshMsg}</Text>
                </Animated.View>
              )}
              {/* sortedSaved, not savedCollapsed alone: every flight can be
                  archived while records still exist, and the collapsed line
                  reads sortedSaved[0]. Falling through to the expanded branch
                  keeps the heading — and the way into the archive — reachable. */}
              {savedCollapsed && sortedSaved.length > 0 ? (
                <View style={sf.collapsedRow}>
                <TouchableOpacity
                  style={sf.collapsedLine}
                  activeOpacity={0.7}
                  onPress={() => persistCollapsed(false)}
                >
                  <Text numberOfLines={1}>
                    <Text style={sf.chevron}>{'\u25B8 '}</Text>
                    <Text style={sf.collapsedNumber}>{sortedSaved[0].flightNumber}</Text>
                    <Text style={sf.collapsedDim}>{' '}</Text>
                    <StatusLine f={sortedSaved[0]} now={now} hideStatus />
                    {activeSaved.length > 1 && (
                      <Text style={sf.collapsedDim}>{` · +${activeSaved.length - 1} more`}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
                {archiveButton(sf.archiveBtnCollapsed)}
                </View>
              ) : (
                <>
                  <View style={c.headingRow}>
                    {/* The chevron leads the heading now, on the left, where it
                        reads as the control for the thing it is next to rather
                        than as a stray glyph at the far edge. The tap target is
                        the pair, not the row, so the archive icon opposite gets
                        its own. */}
                    <TouchableOpacity
                      style={sf.headingTap}
                      activeOpacity={0.7}
                      onPress={() => persistCollapsed(true)}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    >
                      <Text style={sf.chevronLeft}>{'\u25BE'}</Text>
                      <Text style={c.detailsTitle}>{'watchlist'}</Text>
                    </TouchableOpacity>
                    {archiveButton(sf.archiveBtn)}
                  </View>
                  {sortedSaved.length === 0 ? (
                    <Text style={sf.noneActive}>
                      {'Nothing upcoming. Past flights are in the archive.'}
                    </Text>
                  ) : sortedSaved.map((f, i) => (
                    <SavedFlightRow
                      key={f.id}
                      flight={f}
                      now={now}
                      last={i === sortedSaved.length - 1}
                      onDone={showToast}
                      onRemind={(on) => handleRemind(f, on)}
                      onPress={() => renderSavedFlight(f)}
                      onUnsave={() => unsaveWithBanner(f)}
                      onArchive={(on) => setArchived(f, on)}
                    />
                  ))}
                </>
              )}
            </View>
          )}

          {/* ── RESULT ── */}
          {flight && (
            // THE ENTRY ANIMATION STAYS ON THE OUTSIDE and keeps this transform
            // to itself. showResult() drives it, the Swipeable inside drives its
            // own translation, and the two compose without either having to know
            // about the other.
            //
            // s.resultWrap IS ON THE VIEW BELOW, not this one. It went in with
            // the content while the Swipeable wrapped the whole result; the
            // Swipeable wraps the card alone now and the route block is its
            // sibling, so the gap moved to whichever element holds them both —
            // which is the exit wrapper, not this.
            <Animated.View
              style={{ opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }}
            >
              {/* THE CARD, AND EVERYTHING THAT IS THE CARD'S. The swipe, the
                  exit throw, the route row, the bar, the status line and the
                  sheet all moved to components/FlightCard.tsx unchanged. What is
                  passed in is what this screen knows and the card cannot: the
                  data, the record, the clock, whether this flight is saved, and
                  the three things the card is allowed to ask for. */}
              <FlightCard
                flight={flight}
                flightRecord={flightRecord}
                now={now}
                isSaved={isSaved}
                handleToggleSave={handleToggleSave}
                routeOnMap={routeOnMap}
                toggleRouteOnMap={toggleRouteOnMap}
                isOwnedFlight={isOwnedFlight}
                toggleOwned={toggleOwned}
                refreshFlightCard={refreshFlightCard}
                closeFlightCard={closeFlightCard}
              />
            </Animated.View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  scroll: { paddingHorizontal: 20 },

  header: { marginBottom: 36, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  // RESTORED AT THE VALUES THEY HAD, recovered from the commit before the modal
  // was retired rather than reconstructed by eye. 36 square on an 18 radius is a
  // circle; the hairline is the same 0.12 white every bordered control here uses.
  profileBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },
  profileTxt: { color: 'rgba(226,226,226,0.5)', fontSize: 11, fontFamily: MONO },

  // UNREFERENCED SINCE THE ROUTE WENT BARE. There is no card around it any
  // more: the row and its bar sit on the page. Left in place.
  heroCard: {
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 12,
  },
  heroRow: { flexDirection: "row", alignItems: "flex-start" },
  heroControls: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  // 36 square, and 5% white — one step above the card it sits on, so the tile
  // reads as raised without spending a colour on it. The existing hitSlop
  // carries the tap area well past this.
  heroBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center", justifyContent: "center",
  },
  flightNumber: { fontSize: 32, color: "#ffffff", letterSpacing: 1, fontFamily: MONO_BOLD },
  // UNREFERENCED SINCE THE AIRLINE CAME OUT OF THE CARD. Left in place.
  flightAirline: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 3, fontFamily: SANS },
  // The fill is flight.statusBg and the rail flight.statusColor, both applied
  // inline: they come from getStatusBg and getStatusColor, which are the one
  // place this app decides what a status looks like.
  statusBand: {
    // No flexDirection: the default column is what this wants. The word gets a
    // line, the tail gets the one under it, and gap 4 is the vertical space
    // between them. alignItems flex-start so both sit against the left edge
    // rather than being stretched across the band.
    alignItems: "flex-start",
    borderRadius: 8,
    // 6 AND 10, DOWN FROM 10 AND 12. The band carries a short word and one line
    // of small grey text, and at 10 vertical it was a block the size of the
    // route row beneath it — a container arguing for more attention than its
    // contents. 6 still reads as a filled band rather than as text on a tint,
    // which is the whole job of the fill.
    paddingVertical: 6,
    paddingHorizontal: 10,
    overflow: "hidden",
    gap: 4,
  },
  statusRail: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  // flexShrink 0: the status word is the one thing on this card that must never
  // be abbreviated, whatever else has to give.
  //
  // 13, DOWN FROM 15. It shares the band with an 11pt tail, and one step of
  // separation is enough to say which of the two is the heading. The colour is
  // still getStatusColor's, applied inline, and the rail beside it is unchanged.
  statusWord: { fontSize: 13, letterSpacing: 0.5, fontFamily: MONO_BOLD, flexShrink: 0 },
  statusSaveError: { fontFamily: SANS, fontSize: 11, color: "rgba(248,113,113,0.8)" },
  statusUpdated: { fontFamily: MONO, fontSize: 11, color: "rgba(226,226,226,0.3)" },

  // UNREFERENCED SINCE THE MERGE. The route no longer has a surface of its own;
  // it is the lower half of heroCard. Left in place rather than deleted.
  routeSurface: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
  },
  // UNREFERENCED SINCE THE AIRLINE AND THE SEAM CAME OUT. Left in place.
  //
  // 2 EACH SIDE, ON TOP OF heroCard's GAP OF 12, so the rule had 14 above and 14
  // below. The seam it replaces was 38pt — the hero's bottom CARD_PAD, then
  // resultWrap's 10, then the route's top CARD_PAD — and collapsing that to the
  // card's bare 12 would have read as tight where a card edge used to be. 14 is
  // CARD_PAD's own figure, which is the amount of air every other block in this
  // app gets from its container.
  heroRuleSpace: { marginVertical: 2 },
  routeTime: { fontSize: 13, color: "#aeaeb2", marginTop: 8, fontFamily: MONO_BOLD },

  // The empty pair. Both recede, and the value recedes further than its label:
  // the label still names a thing worth knowing, the dash only says we do not
  // know it yet.
  airportTileLabelEmpty: { color: "rgba(226,226,226,0.22)" },
  airportTileValueEmpty: { color: "rgba(226,226,226,0.18)" },

  // No backgroundColor, no borderRadius, no padding: see the note at the call
  // site. The one visual difference that matters is that this starts at the page
  // margin while every card above it insets its content by CARD_PAD.
  footer: { gap: 6 },
  // A step quieter than the lines above it: the airports are at least about
  // where you are going, and this is metadata about the aircraft.
  footerMeta: { fontSize: 11, fontFamily: MONO, color: "rgba(226,226,226,0.3)" },

  // A FLOOR AND A CEILING. More than half the screen whatever is in it, and
  // never so tall that the scrim disappears at both ends.
  archiveSheet: { minHeight: "62%", maxHeight: "82%" },
  archiveEmpty: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS,
    textAlign: "center", lineHeight: 18, paddingVertical: 12,
  },
  // Negative margin then equal padding, so a row's hairline runs the full width
  // of the sheet while its text still lines up with the heading above it.
  //
  // flex: 1 completes the chain from sheetBodyFill. It is what gives the list a
  // definite height — everything below the header — and a ScrollView only
  // scrolls once it has one. Without it the list would run past the bottom of
  // the sheet at the ceiling and simply be clipped.
  archiveList: { marginHorizontal: -20, paddingHorizontal: 20, flex: 1 },
});

const pm = StyleSheet.create({
  backdrop: {
    flex: 1,
    // The shared scrim, down from its own 0.72. That value was set when the
    // sheet behind it was opaque and nothing had to be seen through it.
    backgroundColor: SHEET_SCRIM,
    justifyContent: 'flex-end',
  },
  // A BOTTOM sheet, which is the one structural difference from the others: it
  // is flush with the bottom of the screen, so it has three edges rather than
  // four and two rounded corners rather than four. "The same edge" therefore
  // means the same colour and the same weight on the edges it actually has —
  // a fourth line across the bottom would be an edge where the sheet does not
  // end. The per-side WIDTHS stay as they are, and only the colour is shared:
  // it is mismatched border COLOURS that make React Native abandon the corner
  // radius and split each arc, and every side here still agrees on 0.08.
  sheet: {
    // NO backgroundColor: the blur samples what is behind it, and an ancestor's
    // fill would be flattened into the result. GlassLayers carries both.
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: SHEET_EDGE,
    // Clips the blur to the two rounded corners.
    overflow: 'hidden',
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 52,
    alignItems: 'center',
  },
  // Drawn over GlassLayers and under the content, the same slot the shared
  // tint occupies inside it.
  tint: { backgroundColor: PROFILE_FILL },
  closeBtn: {
    position: 'absolute',
    top: 20,
    right: 24,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeTxt: { color: '#4ade80', fontSize: 15, fontFamily: MONO },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1.5,
    borderColor: 'rgba(74,222,128,0.4)',
    backgroundColor: 'rgba(74,222,128,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 4,
  },
  avatarTxt: { color: '#4ade80', fontSize: 20, fontFamily: MONO },
  name: { fontSize: 20, color: '#ffffff', fontFamily: MONO },
  sub: {
    fontSize: 13,
    color: 'rgba(226,226,226,0.4)',
    fontFamily: MONO,
    marginBottom: 32,
    textAlign: 'center',
  },
  authBtn: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  authBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameLabel: {
    fontFamily: SANS,
    fontSize: 11,
    color: 'rgba(226,226,226,0.4)',
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', marginBottom: 8 },
  nameInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 13,
    color: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  nameBtn: {
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.4)',
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  nameBtnTxt: { fontFamily: MONO, fontSize: 13, color: '#4ade80' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  pencil: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)' },
  authBtnTxt: { color: '#ffffff', fontSize: 15, fontFamily: MONO },
});
