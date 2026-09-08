// MY FLIGHTS. THE JOURNEY THE USER IS CURRENTLY TAKING, AND NOTHING ELSE.
//
// NOT A LIST AND NOT A RECORDS SCREEN. The watchlist is home's: twenty flights
// somebody is following, sorted by relevance, each one a row. This is the one
// they are ON, opened out — the legs in the order they are flown, and under each
// leg only what is useful at the point the traveller has actually reached.
//
// A BOOKINGS SCREEN IS NOT THIS. PNRs, tickets, seats, fares and past journeys
// as records all belong to a screen that does not exist yet, and nothing here is
// built in anticipation of it. The past-flights sheet at the foot of this page is
// an exit, not an archive: it lists what has flown and offers nothing to do with
// it.
//
// EACH LEG IS THE FLIGHT CARD, and that is the whole of the layout. A phase
// machine used to live here -- five stages read off reminderTimes, each drawing
// its own cells -- and it was a worse copy of a card this app already has, with
// the app's own notification schedule printed as if it were content. The card
// knows the gate, the belt, the times, the delay and the progress; this screen
// decides which flights get one and what a swipe on it does.
import { useState, useEffect, useMemo, useRef, useCallback, Fragment, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TouchableOpacity,
  Modal, Animated, RefreshControl,
  // FOR THE FOLDER'S OWN CURVE, which is declared here rather than taken from
  // lib/glass. See FOLD_EASE.
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
// THE MARKER THAT NAMES THIS SCREEN'S SCROLL VIEW TO UIKit. See the block at
// the marker itself for what it does and why the import path is a deep one.
import { ScrollViewMarker } from 'react-native-screens/experimental';
import {
  SavedFlight, savedFlightFromApi, ISO_DAY_RE, MAX_MAP_ROUTES,
} from '../../lib/storage';
// THE STORE AND ITS RULES. tripsOf, isOwned and isArchived are pure functions of
// a list and a clock; the two callbacks are the only things here that write.
import {
  useSaved,
  // See its note in lib/saved.tsx: this screen stays mounted across a sign-in.
  useAccountChange,
  tripsOf,
  isOwned,
  isArchived,
  effectiveStatus,
  sortSavedByRelevance,
  flightUrl,
  // THE TWO INSTANTS A LAYOVER IS THE DISTANCE BETWEEN, and they are imported
  // rather than rebuilt: both resolve actual, then estimate, then schedule
  // against the airport's own zone, and a second copy of that precedence here
  // would be a layover that disagrees with the cards either side of it.
  arrivalTs,
  // HOW LONG A BELT IS WORTH SHOWING, and it is imported rather than declared
  // because the flight card reads the same number for the same reason. See its
  // note: it was sixty minutes here and is forty-five there now.
  BAG_WINDOW_MS,
  // WHEN A LEG ARRIVED, which is not landedAt. Imported for the same reason
  // BAG_WINDOW_MS is: the card runs the same window and the two must not come
  // to disagree about which clock it starts on.
  landedInstant,
  // WHICH LEG THE JOURNEY IS ON. It lived here until the Deck needed the same
  // answer -- which airport the traveller is actually at -- and a screen must
  // never be the place another screen imports from. See its note in lib/saved.
  //
  // nextLegIndex AND legState STAYED, because they answer "which card is open on
  // THIS screen", which is rendering rather than journey.
  currentLegIndex,
  departureTs,
  OWN_MSG,
} from '../../lib/saved';
// WHICH ROUTES ARE DRAWN, and the one conversion that builds a route from a
// record. mapRouteFor is imported rather than restated: its own note says the
// departureTs/arrivalTs conversion must never be done twice by two pieces of
// code, and a second copy here would break that on the first read.
import { useMapRoutes } from '../../lib/maproutes';
import { mapRouteFor } from '../../lib/flightcard';
// THE COUNTRY OF AN AIRPORT, which is the only thing this screen asks of the
// dataset. airportByCode is the accessor; the rows are not exported and must
// not be. See showsBelt.
import { airportByCode } from '../../lib/airports';
// formatClock IS HOME'S HEADER LINE, and it is imported rather than restated
// because this screen now wears the same header. See the note where it lives.
// CD_LATE JOINS CD_GREEN for the folder's accent. They are the app's one pair
// for late and on time -- the card's clock and its delay figure take the same
// two -- so the folder cannot come to disagree with the leg inside it.
import {
  StatusLine, routeDateLabel, formatClock, CD_GREEN, CD_LATE,
} from '../../lib/flightstatus';
// SURFACE_1 AND SURFACE_2 JOIN THEM FOR THE FOLDER HEADERS. See the scale in
// lib/cards: level is decided by what sits UNDERNEATH, so a header on the page
// takes SURFACE_1 and the date block inside one takes SURFACE_2.
import {
  CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG, SURFACE_EDGE,
  SURFACE_1, SURFACE_2,
} from '../../lib/cards';
import {
  GlassLayers, g,
  EASE_OUT, EASE_IN, CAL_RISE,
  CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  // THE SMALL PANEL'S OWN MOTION. A menu is not a sheet: it travels less and
  // arrives quicker. See Menu.
  OVERLAY_RISE, PANEL_IN_MS, PANEL_OUT_MS,
} from '../../lib/glass';
import { useToast } from '../../lib/toast';
// THE APP'S ONE HAPTIC. components/swipe fires it when a full swipe arms and
// when a long press becomes a menu -- both moments where a gesture turns into an
// offer. Opening this menu is the same kind of moment, and a second weight for
// it would be a second vocabulary.
import { EXPAND_HAPTIC } from '../../components/swipe';
// THE CARD ITSELF, one per leg, and the adapter that builds one from a stored
// record. flightDataFromSaved is what the map's own card already uses -- see the
// note there: every RULE it needs is exported and it is field mapping alone.
//
// THREE NAMES CAME OFF THIS IMPORT AND lib/time's. hasTime, movementTimeCell and
// clock24 served the collapsed leg's departure clock and nothing else here; the
// row has gone and so have they. See CollapsedLeg.
import { FlightCard, flightDataFromSaved } from '../../components/FlightCard';

// Declared here rather than imported from a screen or a component, exactly as
// every module in lib/ declares its own. These are the family names _layout
// registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
// The semibold face, loaded in _layout with the rest. The screen's title is the
// only thing here that uses it -- see st.title.
const SANS_SEMI = 'Inter_600SemiBold';

// getStatusColor('landed') exactly. A finished leg is grey; it is never green.
const LANDED_GREY = '#8e8e93';
const DIM = 'rgba(226,226,226,0.4)';

// TWO OF THE CARD'S PROPS ARE UNREACHABLE UNDER tripVariant AND STILL REQUIRED.
// handleToggleSave is the bookmark, which that variant's left panel does not
// render; closeFlightCard is the close action in the right panel, which it does
// not render either. Neither can be called, and a named no-op says so where two
// bare arrows would only look like something forgotten.
const NOT_REACHABLE = () => {};

// ── THE THREAD DOWN THE LEFT OF A TRIP ──────────────────────────────────────
//
// FOUR CARDS IN A COLUMN WITH EQUAL GAPS ARE FOUR OBJECTS. They are one journey,
// and the gaps between them are not nothing -- they are the waits. A line
// running through the whole trip says the legs are joined; a duration written on
// that line says what the join costs.
//
// GEOMETRY ONLY, AND ALL OF IT HERE. Every number the thread needs is one of
// these three, so tuning it is editing this block rather than hunting literals
// through a stylesheet. The COLOUR is not here because it is not new: the line
// and the duration on it are both DIM, which is the file's existing dim tone,
// and they share it because they are one element rather than two.
//
// RAIL_X is the line's own offset from the trip block's left edge. RAIL_INSET is
// where the cards begin, which leaves the strip between them as the gutter the
// line lives in. The duration's label starts at RAIL_INSET too, so its text
// lines up with the cards' left edge while its background reaches back past the
// line and breaks it -- which is what puts the words ON the thread rather than
// beside it.
// ── WHICH FOLDER HEADER IS BEING TRIED ────────────────────────────────────
//
// THREE SHAPES FOR ONE CONTROL, SWITCHED HERE AND NOWHERE ELSE. They are not
// three settings a user will ever see; they are three answers to the same
// question, kept side by side so they can be looked at on a device and two of
// them deleted.
//
//   'strip'     an aviation flight strip: a square date block with a green edge,
//               then the route and the count packed against it. Everything on the
//               left, nothing spanning an empty bar.
//   'divider'   no container at all. Date over route on the page, a hairline
//               between items, the count and the expander at the right edge.
//   'carousel'  fixed-width stubs scrolling sideways, with the open trip beneath.
//               NOT A FOLDER MODEL -- see the note at the render.
//
// WHEN ONE IS CHOSEN the other two go, and so does this constant. It is a literal
// union rather than a string so a typo is a compile error.
const FOLDER_STYLE: 'strip' | 'divider' | 'carousel' = 'strip';

// ── THE LINE IS WHEREVER THE ICON IS, AND THE ICON IS INBOARD NOW ─────────
//
// 14, AND IT IS DERIVED RATHER THAN CHOSEN: the strip header's left padding plus
// half the icon's own 20 points. It was 6 when the header was bare text and a
// guess, then 10 when the icon sat flush at the row's edge, and it is 14 now that
// the icon has 4 points of padding in front of it. Change STRIP_PAD and this has
// to move with it or the thread stops meeting the folder.
//
// FOUR POINTS OF PADDING AND NOT MORE, BECAUSE THE GUTTER PAYS FOR IT. RAIL_INSET
// is 22 -- where the cards begin -- and the line's right edge is RAIL_X + 1, so
// the dead space between the thread and the cards is 22 - (RAIL_X + 1):
//
//   pad 0  ->  RAIL_X 10  ->  gutter 11   the icon touches the edge
//   pad 4  ->  RAIL_X 14  ->  gutter  7   this
//   pad 8  ->  RAIL_X 18  ->  gutter  3   the line reads as touching the cards
//
// THE ALTERNATIVE WAS TO MOVE RAIL_INSET AND IT IS WORSE THAN IT LOOKS. Every
// card on the screen begins at that inset, so widening it narrows the card
// interior -- which is the 230 points every pill width, column width and label
// measurement on the flight card was worked out against. Four points of header
// padding is not worth re-measuring the card for.
//
// AND THE THIRD OPTION WAS TO GIVE UP THE ALIGNMENT, letting the line drop from
// under the header block rather than from the icon. That is what it did before
// the icon existed and it is perfectly defensible; it is not what was asked for.
//
// layoverTime IS UNAFFECTED: its PAGE_BG background starts at the row's own left
// edge and runs to RAIL_INSET, so it still covers the thread wherever the thread
// is inside that span. See its note for what that background is for.
// ── HOW A FOLDER OPENS, AND WHY IT IS NOT THE PANEL'S MOTION ──────────────
//
// THE OVERLAY TIMINGS WERE TUNED AGAINST TEN POINTS OF TRAVEL. lib/glass states
// it two lines above them: OVERLAY_RISE is 10, and PANEL_IN_MS 220 / PANEL_OUT_MS
// 150 are the pair that suits a surface moving that far. A folder with three legs
// collapses six hundred:
//
//   panel rise      10pt over 220ms  ->    45 pt/s
//   folder open    600pt over 220ms  ->  2700 pt/s
//   folder close   600pt over 150ms  ->  4000 pt/s
//
// SIXTY TO NINETY TIMES THE SPEED THE CURVES WERE CHOSEN FOR. The easing was not
// wrong; the same easing over sixty times the distance is a different motion.
//
// AND THE TWO CURVES FAILED IN OPPOSITE DIRECTIONS. EASE_OUT is expo-out --
// bezier(0.16, 1, 0.3, 1) -- which spends about 85% of its travel in the first
// fifth of its time. Over ten points that reads as arriving and settling; over six
// hundred the folder is open inside fifty milliseconds and the rest is an
// invisible tail. That was the snap. EASE_IN is bezier(0.4, 0, 1, 1), whose second
// control point sits at the far corner: it has NO DECELERATION PHASE and arrives
// at the end well above average velocity, then stops dead. That was the bounce --
// the neighbour is pushed by that edge, travels a long way on the final frame and
// halts, and an abrupt stop after high velocity reads as an overshoot even though
// nothing overshoots.
//
// ONE CURVE BOTH WAYS, AND IT HAS A TAIL AT BOTH ENDS. The shape for something
// that travels a long way and has to STOP is one that leaves rest and arrives at
// rest, and the deceleration is the half that removes the bounce.
//
// bezier(0.2, 0, 0, 1) RATHER THAN bezier(0.4, 0, 0.2, 1), AND THE DIFFERENCE IS
// AT BOTH ENDS. The old curve holds still for the first four tenths of its time
// before moving -- a hesitation nobody could see behind a snap and everybody will
// see now -- and its second control point at x = 0.2 leaves it still moving as it
// arrives. This one starts at 0.2, so it goes when tapped, and its second control
// point sits at x = 0, which makes the tangent at the end HORIZONTAL: it arrives
// with zero vertical velocity. That is the strongest deceleration a cubic can
// have, and it is what the bounce was the absence of.
//
// NOT A SPRING, AND THE REASON IS THIS CONTAINER SPECIFICALLY. A spring with any
// overshoot expands the box PAST the content's natural height, and a clipping
// container with nothing left to show renders that as a flash of empty space
// before it pulls back. overshootClamping would prevent it and leaves a
// front-loaded ease-out: right for opening, wrong for closing, where it would
// collapse fast and then creep. Springs do carry velocity through an interruption,
// which a timing cannot, and that is a real loss -- it does not pay for two
// different feels in one object.
//
// THE TRAVEL IS 321 POINTS, MEASURED, NOT SIX HUNDRED GUESSED. A log of `h` gave
// 337 open and 16 shut on a two-leg trip -- the 16 being folderInner's own padding
// -- so a folder moves about 321. At 320ms that is roughly 1000 points a second,
// which is twenty-odd times the panel's rather than the sixty I estimated from a
// height I had never measured.
//
// 320 AND 260, AND THEY ARE BEING SEEN FOR THE FIRST TIME. The previous pair was
// chosen while a one-frame snap was masking the animation entirely -- the motion
// played after the eye had already been shown the result, so no duration could
// have looked like anything. These are a little longer than that guess because
// the travel is now the visible event.
//
// STILL ASYMMETRIC, BUT ONLY JUST. Leaving should not make you wait; a toggle
// tapped twice in a row should not feel like two different controls.
//
// DECLARED HERE AND NOT IN lib/glass, which is explicitly the app's GLASS
// vocabulary and whose motion pairs are all tuned for 10 to 28 points of overlay
// travel. A folder body is not glass and its motion is not theirs; a third pair
// in that file would invite the next person to put a collapse timing on a panel.
const FOLD_IN_MS = 320;
const FOLD_OUT_MS = 260;
const FOLD_EASE = Easing.bezier(0.2, 0, 0, 1);

const STRIP_PAD = 4;
const RAIL_X = STRIP_PAD + 10;
const RAIL_W = 1;
const RAIL_INSET = 22;

// ── ONE MODAL, AND WHICH THING IS IN IT ─────────────────────────────────────
//
// THREE MODALS BECAME ONE, AND THE SEQUENCING PROBLEM WENT WITH THEM.
//
// WHAT WAS WRONG, AND IT WAS NOT THE TIMING. The menu and the import sheet were
// two Modals that had to hand off to each other, and React Native cannot present
// one while another is mounted: on iOS a Modal is a presented view controller,
// and the second presentation is dropped with nothing thrown and nothing shown.
// Two fixes were tried against that -- a completion callback, then a
// requestAnimationFrame after the unmount had committed -- and both were bets on
// a native presentation lifecycle this code does not control. The JS ran
// correctly in both: the state was set, the second Modal rendered, and nothing
// appeared.
//
// SO THERE IS NOTHING TO HAND OFF ANY MORE. One state says WHICH overlay is up,
// one Modal is mounted whenever any of them is, and going from the menu to a
// sheet is a CONTENT SWAP INSIDE a Modal that never unmounts. There is no second
// presentation for the platform to refuse.
//
// null IS "NOTHING IS UP", which is also the Modal's own visible test.
type Overlay = 'menu' | 'import' | 'past' | null;

// WHICH TIMINGS AN OVERLAY TAKES, DERIVED RATHER THAN STORED. A menu arrives and
// leaves on the panel's pair; a sheet on the calendar's.
//
// THE RISE AND THE SCALE ARE NOT HERE. Each component spells its own, because
// each knows its own shape -- a sheet rises CAL_RISE and scales, a menu rises
// OVERLAY_RISE and does not -- and returning fields nothing reads would be a
// second place for them to be kept in step.
//
// THREE READERS, WHICH IS WHY IT IS A FUNCTION AND NOT THREE TERNARIES:
// openOverlay and swapOverlay take inMs, closeOverlay takes outMs, and inlining
// would write the same branch three times, twice identically.
function motionOf(o: Exclude<Overlay, null>) {
  return o === 'menu'
    ? { inMs: PANEL_IN_MS, outMs: PANEL_OUT_MS }
    : { inMs: CAL_IN_MS, outMs: CAL_OUT_MS };
}

// ── THE SHEET, AND IT IS THE ARCHIVE SHEET'S STRUCTURE ──────────────────────
//
// Nothing about the structure differs from app/index.tsx's archive sheet: the
// same Modal flags, the same scrim Pressable, the same full-screen dim on its
// own value, the same CAL_RISE / 0.96 rise-scale-fade, the same shell, glass,
// edge and swallowing body, the same head with its spacer, title and red close X.
//
// THE Modal, THE SCRIM AND THE DIM ARE NOT HERE ANY MORE. They are the screen's,
// mounted once above whichever panel is showing -- see Overlay. What is left is
// the panel itself, which is all this component ever really was.
function Sheet({ panel, title, onClose, children }: {
  panel: Animated.Value; title: string; onClose: () => void; children: ReactNode;
}) {
  return (
        <Animated.View
          style={[
            g.sheetShell,
            st.sheet,
            {
              opacity: panel,
              transform: [
                { translateY: panel.interpolate({ inputRange: [0, 1], outputRange: [CAL_RISE, 0] }) },
                { scale: panel.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
              ],
            },
          ]}
        >
          <GlassLayers />
          <View style={g.sheetEdge} pointerEvents="none" />
          {/* Swallows the tap so the scrim's dismiss does not fire through. */}
          <Pressable style={[g.sheetBody, g.sheetBodyFill]}>
            <View style={g.sheetHead}>
              <View style={g.sheetHeadSpacer} />
              <Text style={g.sheetTitle}>{title}</Text>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={onClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={g.sheetClose}
              >
                {/* The app's own close X, character for character. */}
                <Svg width={20} height={20} viewBox="0 0 24 24">
                  <Path d="M19 5 5 19" fill="none" stroke="rgba(248,113,113,0.55)" strokeWidth={1.75} strokeLinecap="round" />
                  <Path d="M5 5l14 14" fill="none" stroke="rgba(248,113,113,0.55)" strokeWidth={1.75} strokeLinecap="round" />
                </Svg>
              </TouchableOpacity>
            </View>
            {children}
          </Pressable>
        </Animated.View>
  );
}

// ── THE MENU, AND IT IS THE FLIGHT CARD'S LONG-PRESS MENU ───────────────────
//
// A MENU, NOT A SHEET, AND THE DIFFERENCE IS IN EVERY NUMBER. A sheet takes over
// the screen, holds a list of unknown length, and therefore has a head, a title,
// a close button and a 62% floor. This asks one question with two answers, so it
// is the small floating panel components/FlightCard.tsx already uses for exactly
// that: the overlay's rise rather than the sheet's, the panel's timings rather
// than the calendar's, and no scale at all.
//
// THE SAME MATERIAL THOUGH. sheetShell, GlassLayers and sheetEdge, in that
// order, exactly as every other floating surface in this app. A menu made of
// something else would be a fifth material for one control.
//
// NO HEAD AND NO CLOSE BUTTON, for the reason stated at the card's own menu: a
// title bar over two rows would be more chrome than content, and the scrim
// dismisses.
//
// THE Modal AND THE SCRIM ARE THE SCREEN'S, exactly as they are for the sheet.
function Menu({ panel, children }: { panel: Animated.Value; children: ReactNode }) {
  return (
        <Animated.View
          style={[
            g.sheetShell,
            st.menu,
            {
              opacity: panel,
              transform: [{
                translateY: panel.interpolate({
                  inputRange: [0, 1], outputRange: [OVERLAY_RISE, 0],
                }),
              }],
            },
          ]}
        >
          <GlassLayers />
          <View style={g.sheetEdge} pointerEvents="none" />
          {/* Swallows the tap so the scrim's dismiss does not fire through. */}
          <Pressable style={st.menuBody}>{children}</Pressable>
        </Animated.View>
  );
}

// ONE ROW OF THE MENU. Inter at 15, which is this app's working size for a thing
// being chosen -- the same size and family the card's menu row uses.
function MenuRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      // THE HAPTIC LEADS THE ACTION, so the confirmation lands with the finger
      // rather than after whatever the row goes on to do.
      onPress={() => { EXPAND_HAPTIC(); onPress(); }}
      style={st.menuRow}
      accessibilityRole="button"
    >
      <Text style={st.menuLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── HOW MUCH OF A LEG IS WORTH DRAWING ──────────────────────────────────────
//
// FOUR STATES, AND EVERY ONE OF THEM IS A CLAIM ABOUT WHAT IS STILL ACTIONABLE.
//
//   LANDED    it is over. Number, airline, route -- and a belt, if showsBelt
//             still allows one. Nothing else.
//   DISTANT   it is further down the journey. Identity, date, and how long
//             until it leaves.
//   NEXT      it is the one after the open leg -- the flight you go to when
//             this one is done. The above, plus the departure time as the card
//             would print it.
//   CURRENT   the card itself.
//
// LANDED IS THE STATE THAT WAS MISSING, and its absence was a bug of exactly the
// kind the belt rule exists to prevent. A leg that had flown fell through to the
// next-flight layout and printed a date, a terminal and a gate for a flight that
// was over -- operational data that was true once, presented in the shape the
// app uses for things to act on. A gate number from four hours ago is not a
// gate number; it is a place somebody already left.
//
// landedAt IS THE FACT, and effectiveStatus is not consulted for it. That
// function decides what WORD to print: it demotes a stored "landed" when the
// arrival instant is still ahead, because a badge must not claim what the clock
// contradicts. It is a rule about a label. This is a rule about whether an
// aircraft is on the ground, and the only record of that is landedAt -- set by
// saveFlight and touchSavedFlight the first time a refresh came back landed, and
// never guessed from a schedule.
//
// legs ARE ALREADY ORDERED. legsOfTrip sorted them by departure instant before
// any of this sees them, so "first" and "previous" mean what they say.
type LegState = 'landed' | 'distant' | 'next' | 'current';

// AND THREE DAYS IS WHERE THE FIRST LEG STOPS BEING NEXT -- the first leg, and
// no other. Inside it a departure time is worth printing because it is nearly
// settled; outside it the provider is quoting a timetable, and a time that will
// move is better left to the countdown, which cannot be wrong about an interval.
//
// IT IS NOT A RULE FOR CLASSIFYING LEGS, and reading it as one was the bug. Both
// windows exist to place the FIRST leg of a trip on the day it comes round;
// applied to every leg they made NEXT mean "departs within three days", which on
// a four-leg journey is most of the journey. See nextLegIndex.
const NEXT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// WHICH LEG IS NEXT, AND IT IS A POSITION RATHER THAN A DURATION.
//
// THE ONE AFTER THE OPEN LEG. "Next" means the flight you go to when this one is
// done, which is a fact about ORDER -- so it is exactly one leg, whatever the
// clock says about any of them. A leg two hops away is not next however soon it
// departs, and the leg after the open one is next even if it leaves in a week.
//
// THIS WAS THE BUG, and it was a rule written as a threshold. legState used to
// ask "does this leg depart within three days" of every leg, so on a journey
// taken over two days every remaining leg answered yes and three of four rows
// claimed to be the one to be at an airport for. The windows were only ever
// meant to decide where the FIRST leg of a trip sits.
//
// IT FOLLOWS THE OPEN LEG RATHER THAN THE JOURNEY'S OWN, and that is deliberate:
// openIdx is whatever is CURRENT, including a leg the user has tapped. "The one
// after the open leg" stays true of what is on screen, so tapping down the trip
// walks the highlight with it rather than leaving it pinned to a card that is no
// longer open.
//
// AND WITH NOTHING OPEN THE WINDOW DECIDES THE FIRST LEG, alone. That is the one
// case the thresholds are for: a trip nobody has started, where leg one is next
// if it is inside three days and distant beyond. Legs after it are distant
// regardless -- there is no open leg for them to follow.
//
// -1 IS A REAL ANSWER AND MEANS NO LEG IS NEXT. The open leg is the last one; or
// nothing is open and the first leg is more than three days out; or every leg
// has landed. In each of those there is genuinely no next flight to name.
function nextLegIndex(legs: SavedFlight[], now: number, openIdx: number): number {
  if (openIdx >= 0) return openIdx + 1 < legs.length ? openIdx + 1 : -1;
  if (legs.length > 0 && legs[0].landedAt === null) {
    const t = departureTs(legs[0]);
    if (t !== null && t - now < NEXT_WINDOW_MS) return 0;
  }
  return -1;
}

// AND WHAT EACH LEG THEREFORE DRAWS.
//
// BOTH INDICES ARE PASSED IN rather than recomputed, because the user can
// overrule the open leg by tapping -- see focusOverride -- and a second
// computation here would ignore that and open two legs at once.
//
// LANDED OUTRANKS NEXT, which is what stops a flown leg reading as a forthcoming
// one. It does NOT outrank the open leg: tapping a landed leg still opens its
// card, because that is the user asking to see it rather than the screen
// deciding to show it.
//
// WHICH MEANS THE NEXT SLOT CAN COME BACK EMPTY. If the leg after the open one
// has already landed, LANDED wins and no leg is next -- correctly, because the
// flight to go to has been taken.
//
// DISTANT IS THE DEFAULT AND ASKS NOTHING. It no longer reads a clock at all:
// everything that is not open, not landed and not the one after the open leg is
// distant, whatever its departure time.
//
// AND LANDED IS effectiveStatus'S ANSWER, NOT landedAt.
//
// THIS READ leg.landedAt !== null AND THAT IS A DIFFERENT QUESTION. landedAt is
// an OBSERVATION flag -- it records that some refresh once reported a landing --
// and a wrong report sticks it on a leg that has not arrived. effectiveStatus
// refuses such a claim; this did not, so one leg rendered as a compact LANDED
// row while collapsed and as SCHEDULED, departing 16:15, the moment it was
// opened. Same leg, same instant, two answers, because the collapsed row and
// the expanded card were asking different functions.
//
// IT ALSO INHERITS EVERYTHING effectiveStatus KNOWS and this row never did:
// Flightradar24's touchdown outranking a stored status, an arrival still in the
// future being refused, and an estimate an hour stale demoting to 'stale'
// rather than passing as landed.
function legState(leg: SavedFlight, i: number, openIdx: number, nextIdx: number,
                  now: number): LegState {
  if (i === openIdx) return 'current';
  if (effectiveStatus(leg, now) === 'landed') return 'landed';
  return i === nextIdx ? 'next' : 'distant';
}

// ── HOW LONG UNTIL SOMETHING HAPPENS ────────────────────────────────────────
//
// TO THE DEPARTURE, THEN TO THE ARRIVAL, THEN NOTHING. Before the flight leaves,
// the interval a traveller is living in is the one before the gate closes; once
// it is in the air, the only interval left is until it is down. When it has
// landed there is no interval at all and the line goes -- see the LANDED state,
// which does not ask for one.
//
// AIRBORNE IS effectiveStatus, NOT THE CLOCK. A departure time passing does not
// mean an aircraft left: it can sit an hour at the gate. That function never
// promotes a status on the clock -- see its note in lib/saved.tsx -- so this
// switches to the arrival only when the provider has actually said the flight is
// active, and a flight nobody has reported on keeps counting to its departure.
//
// A PAST TARGET RENDERS NOTHING. If the departure has gone by and no one has
// said the flight is airborne, there is no honest interval to state: counting
// up from a departure that may not have happened is a number about our own
// ignorance. The row simply drops the line.
//
// gapLabel IS THE LAYOVER'S OWN FORMATTER, reused deliberately. Both are "how
// long is this gap", both cross a day, and two spellings of a duration on one
// screen is how "2h 14m" and "2 hr 14 min" come to sit six points apart.
function countdown(leg: SavedFlight, now: number): { label: string; value: string } | null {
  if (leg.landedAt !== null) return null;
  const airborne = effectiveStatus(leg, now) === 'active';
  const target = airborne ? arrivalTs(leg) : departureTs(leg);
  if (target === null || target <= now) return null;
  return { label: airborne ? 'Lands in' : 'Departs in', value: gapLabel(target - now) };
}

// ── WHETHER A LEG'S BELT IS WORTH PRINTING ──────────────────────────────────
//
// BAG_WINDOW_MS IS lib/saved's NOW. It was declared here at sixty minutes and
// read by nothing else; the flight card wants the same window for the open
// card's own belt, and two constants meaning "the bags are still worth showing"
// would agree today and drift later. It is forty-five minutes there.
// lib/airports.ts carries FULL COUNTRY NAMES, not codes -- see the Airport type.
// Spelled once so the two comparisons below cannot drift apart.
const US_COUNTRY = 'United States';

// A BELT ON A CONNECTION SENDS THE PASSENGER THE WRONG WAY, and that is the
// whole of why this is not simply "is there a belt number".
//
// Checked bags are through-checked to the final destination, so on an
// intermediate leg the bag is not on any belt -- it is being moved airside. A
// carousel number printed there would send somebody to baggage reclaim instead
// of to their next gate, which costs them the connection.
//
// THE UNITED STATES IS THE EXCEPTION, and it is a real one rather than a
// hedge. CBP requires every passenger to collect their bags and recheck them at
// the FIRST US port of entry, even in transit -- so on a leg that ARRIVES in the
// US from outside it, the belt is exactly what the passenger needs.
//
// AND FAILING MEANS NO BELT. An airport this dataset does not know cannot be
// placed in a country, so the country test cannot be answered -- and the two
// wrong answers are not symmetric. Hiding a belt costs a passenger a glance at
// a sign; showing one on a connection costs them a flight.
//
// THE LAST LEG NEEDS NO COUNTRY TEST AT ALL. It is the final destination by
// construction, so the bag is on a belt there whatever the dataset knows about
// either airport -- which is why isLast is answered before the lookups rather
// than after them.
//
// EXTRACTED FROM showsBelt RATHER THAN COPIED, because the flight card now asks
// the same question. The card takes bagsClaimedHere -- see its note -- and this
// is the only thing that can answer it: the question is about a leg's POSITION
// IN A TRIP, and this screen is where the trip is.
//
// IT DOES NOT READ THE CLOCK OR THE BELT NUMBER. Eligibility is a fact about
// the journey's shape and stays true whether or not the flight has landed;
// showsBelt below is what adds the landing and the hour. Keeping them apart is
// what lets the card be handed the half it cannot work out and keep the half it
// can.
function bagEligible(legs: SavedFlight[], i: number): boolean {
  if (i === legs.length - 1) return true;
  const leg = legs[i];
  const from = airportByCode(leg.from.iata);
  const to = airportByCode(leg.to.iata);
  if (from === null || to === null) return false;
  return to.country === US_COUNTRY && from.country !== US_COUNTRY;
}

function showsBelt(legs: SavedFlight[], i: number, now: number): boolean {
  const leg = legs[i];
  if (leg.to.baggage === null) return false;
  if (leg.landedAt === null) return false;
  // THE FLIGHT'S CLOCK, NOT THE REFRESH'S. Same correction as currentLegIndex,
  // and it has to be the same or a belt would outlive the leg that is open.
  const landed = landedInstant(leg, now);
  if (landed === null || now - landed >= BAG_WINDOW_MS) return false;
  return bagEligible(legs, i);
}

// ── THE WAIT BETWEEN TWO LEGS ───────────────────────────────────────────────
//
// A DURATION, AND NOTHING ELSE. It said four things once -- how long, where,
// whether the terminal changed, and what kind of connection it was -- and three
// of them were already on the screen. The airport is named by the leg above it
// and the leg below it; the connection type is those same two routes read
// together; and the terminal is printed by the card DIRECTLY BENEATH, which is
// the one place a traveller will actually look for it. A row that restates its
// neighbours is noise wearing the shape of information.
//
// SO IT IS THE ONE FACT THAT IS NOWHERE ELSE: the gap between two flights,
// which neither card can state because neither card knows about the other.
//
// STILL NOT ONE WORD OF ADVICE. It does not say whether the gap is enough, and
// nothing here may ever start to. Deciding a layover is tight needs the
// airport's minimum connection time, the gate close time, and how long it takes
// to walk between two specific gates -- and this app has none of the three. A
// verdict built from what IS here would be a guess wearing the authority of the
// screen it is printed on, and a traveller who reads "you have time" and misses
// the flight was told so by us.
//
// SO THERE IS NO COLOUR, NO ICON AND NO ADJECTIVE. 55 minutes and 5 hours are
// rendered identically. The reader does the arithmetic, because the reader knows
// things this app does not: whether they have bags, whether they have flown
// through here before, whether they walk quickly.

// ── HOW LONG, IN UNITS A PERSON CAN HOLD ───────────────────────────────────
//
// TWENTY-FOUR HOURS IS THE THRESHOLD, and the reason is arithmetic the reader
// should not have to do. "93h 10m" is a true statement of a four-day gap and an
// unreadable one: to know what it means you have to divide by 24, which is work
// this label exists to save. Under a day, hours are the unit somebody already
// thinks in -- a wait is "about five hours" -- and above it days are.
//
// AND THE DAY IS WHERE THE BOUNDARY BELONGS rather than at some larger round
// number. It is not a taste about legibility; it is the point where the gap
// stops fitting inside one span of being awake and starts being a different
// date. 23h and 25h are close as durations and completely different as plans.
//
// MINUTES GO WITH THE CHANGE. "3d 21h 10m" is three units where two will do,
// and nobody plans a four-day wait to the minute -- the precision would be real
// and useless. Under a day they stay, because at that scale ten minutes is the
// difference between making a connection and not.
//
// THE HOURS ARE ROUNDED AND THE CARRY IS HANDLED. Rounding 23h 45m up gives 24,
// which would print "3d 24h"; the guard turns that into the next day with none.
// Flooring instead would have been simpler and would under-report by up to 59
// minutes on every gap this branch touches.
//
// PADDED UNDER A DAY, so the column does not jitter between "5m" and "45m".
// Above it there is nothing to pad: hours never reach three digits.
//
// NOTHING GUARDS AGAINST null OR A NEGATIVE HERE, and nothing should. Layover
// resolves both before it calls this and renders no row at all -- see its own
// note -- so this function only ever sees a duration that exists.
function gapLabel(ms: number): string {
  const total = Math.round(ms / 60000);
  if (total >= 24 * 60) {
    const whole = Math.floor(total / (24 * 60));
    const hours = Math.round((total - whole * 24 * 60) / 60);
    return hours === 24 ? `${whole + 1}d 0h` : `${whole}d ${hours}h`;
  }
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

function Layover({ prev, next }: { prev: SavedFlight; next: SavedFlight }) {
  // THE GAP IS ARRIVAL TO DEPARTURE, both as INSTANTS rather than as clocks --
  // which is the only way it can be right when the two legs are in different
  // zones, and a connection through Frankfurt usually is.
  //
  // NULL WHEN IT CANNOT BE READ, and that includes a NEGATIVE gap. A null is a
  // pre-v3 record or a missing timezone; a negative is a stored contradiction,
  // two legs that overlap. Neither is a duration, and printing "0h 00m" for
  // either would be inventing the one number this row exists to state.
  const arr = arrivalTs(prev);
  const dep = departureTs(next);
  const gap = arr !== null && dep !== null && dep >= arr ? dep - arr : null;

  // AND WITH THE DURATION GONE THERE IS NO ROW. It was the last thing left after
  // the other three lines came out, so an unreadable gap leaves an empty label
  // sitting on the thread -- a break in the line marking nothing. The line runs
  // unbroken past a leg it cannot time, which is the honest drawing of it.
  if (gap === null) return null;

  return (
    <View style={st.layover}>
      <Text style={st.layoverTime}>{gapLabel(gap)}</Text>
    </View>
  );
}

// ── EVERY LEG THAT IS NOT THE ONE YOU ARE ON ────────────────────────────────
//
// ONE COMPONENT, THREE STATES, AND THE CARD'S OWN GRID UNDER ALL OF THEM.
//
// THE ROWS USED TO BE THREE LINES FLUSH LEFT with the right half of the surface
// empty, sitting under a card that used both halves. They read as a different
// component stacked below the card because that is what they were: same fill,
// same radius, same padding, unrelated interior. A trip is one thing at four
// sizes and the interior is what has to say so.
//
// SO THE GRID IS components/FlightCard.tsx's, matched rather than approximated:
//
//   THE LEFT COLUMN IS IDENTITY, content-sized, no flex, gap 3. The date leads
//   at 20 MONO_BOLD white with 7 under it; the number and the airline follow at
//   13, mono and sans, both in the label grey. That is airportIdent exactly --
//   the date frames the pair rather than joining it, which is what the extra 7
//   buys.
//
//   THE RIGHT COLUMN IS EVERYTHING TIMED, flex 1, paddingLeft 12 to hold it off
//   the identity column, paddingRight 8, alignItems flex-end, gap 12. Every
//   entry is a label over a value, both right-aligned: 11 SANS in the label grey
//   over 15 MONO_BOLD in white. That is airportMovements and airportTimeRow.
//
//   THE ROUTE HEADS THAT COLUMN at the value's own size and weight, and the
//   times sit UNDER it rather than beside it. On the card the right column's
//   first thing is a movement; here it is where the flight goes, and what
//   follows is when -- read down, not across.
//
// NO NEW SIZES AND NO NEW COLOURS. 11, 13, 15 and 20; white and DIM, which is
// the same rgba(226,226,226,0.4) the card's own labels carry.
//
// THE RULE AND THE TILE ROW ARE NOT COPIED, and that is the difference between
// matching a grid and cloning a card. The card divides its tiles evenly across
// one row because it has three or four facts of one kind; a row has at most one
// -- a belt -- and a single tile in a four-column grid is a grid with three
// holes in it. It goes in the right column as one more label-and-value.
//
// THE SURFACE IS UNCHANGED: compactLeg's fill, radius and padding, and cardEdge
// over it. Only the interior moved.
function CollapsedLeg({ leg, state, belt, now, onPress }: {
  leg: SavedFlight;
  state: Exclude<LegState, 'current'>;
  belt: boolean;
  now: number;
  onPress: () => void;
}) {
  const landed = state === 'landed';

  // NOTHING WHERE THERE IS NOTHING. Each of these is null when the field is
  // absent and its line does not render -- no em dash, no "N/A", no placeholder
  // holding a slot. The card's tile row does the opposite on purpose, because a
  // dash under "Gate" is news that a gate is coming; on a row there is no slot
  // being held and a dash would just be a smaller way of saying nothing.
  //
  // NO DATE ON A LANDED LEG. It is the date of a flight that is over, and the
  // whole point of that state is to stop printing facts that have expired.
  //
  // ISO_DAY_RE BEFORE routeDateLabel, as everywhere else: flightDate is the
  // literal string "unknown" on a record filed without one -- see makeFlightId
  // -- and that helper passes through what it cannot parse.
  const dated = !landed && ISO_DAY_RE.test(leg.flightDate)
    ? routeDateLabel(leg.flightDate).toUpperCase()
    : null;

  // THE COUNTDOWN IS ABOVE THE CLOCK, AND THAT ORDER IS THE POINT. "2h 14m" and
  // "Estimated Departure 05:30" are nearly the same sentence, and side by side
  // they read as one fact stated twice. Stacked, the interval is what the eye
  // lands on first and the clock is what it checks against -- which is the order
  // somebody actually uses them in.
  const cd = landed ? null : countdown(leg, now);

  // ── NO COLLAPSED LEG PRINTS A CLOCK, AND 'next' NOW EARNS NOTHING VISIBLE ──
  //
  // THE NEXT LEG SHOWED ITS DEPARTURE AND NO OTHER LEG DID, which made exactly
  // one row in the column about 48 points taller than its neighbours -- a label,
  // a value, and legTimes' gap of 12. Scanning a trip, that reads as one row
  // being wrong rather than as one row saying more.
  //
  // EVERY UNFLOWN LEG IS ONE HEIGHT NOW, at the shorter of the two. What is left
  // in the right-hand column is the route and the countdown, and the countdown is
  // the better half of what was there: it cannot go stale the way a quoted
  // timetable can, and it is the question somebody actually has.
  //
  // 'next' IS NOT DEAD CODE, AND THIS NOTE EXISTS SO IT IS NOT READ AS SOME.
  // nextLegIndex, nextIdx and the LegState member are all still computed and
  // still passed, and legState still returns 'next' for exactly one leg. Nothing
  // RENDERS differently for it today, and that is deliberate rather than an
  // oversight: the rule about which leg is next was hard-won -- see nextLegIndex,
  // which exists because an earlier version asked "does this leg depart within
  // three days" of every leg and so called three legs of four next -- and
  // throwing it away to save a computation nobody is paying for would mean
  // deriving it again from scratch the moment this row wants a distinction back.
  //
  // WHAT WENT WITH THE ROW: movementTimeCell, clock24 and hasTime were imported
  // for this and for nothing else in this file, so their import lines and the
  // notes arguing for them went too. components/FlightCard still exports all
  // three; this file simply has no reader for them.

  return (
    <TouchableOpacity style={st.compactLeg} activeOpacity={0.7} onPress={onPress} accessibilityRole="button">
      <View style={st.cardEdge} pointerEvents="none" />
      <View style={st.legSplit}>
        <View style={st.legIdent}>
          {dated !== null && <Text style={st.legDate}>{dated}</Text>}
          <Text style={st.legIdentNum} numberOfLines={1}>{leg.flightNumber}</Text>
          {leg.airline !== '' && (
            <Text style={st.legIdentName} numberOfLines={1}>{leg.airline}</Text>
          )}
        </View>
        <View style={st.legTimes}>
          <Text style={st.legTimeValue} numberOfLines={1}>
            {`${leg.from.iata} → ${leg.to.iata}`}
          </Text>
          {cd !== null && (
            <View style={st.legTimeRow}>
              <Text style={st.legTimeLabel}>{cd.label}</Text>
              {/* GREEN, WHICH IS WHAT THE OPEN CARD ALREADY DOES WITH THE SAME
                  NUMBER. tripCountdown on the flight card is CD_GREEN because an
                  interval is the one thing on a leg that changes while you look
                  at it; the collapsed row was printing the identical value from
                  the identical function in plain white, so the same fact was
                  live on one surface and inert on the other.

                  THE VALUE ONLY, AND THE LABEL STAYS DIM. "Departs in" is a
                  caption and does not move; the figure beside it is what does.
                  The open card carries no label at all -- it renders
                  countdown.value alone -- so greening the label here would be
                  colouring something that surface has no counterpart for. */}
              <Text style={[st.legTimeValue, st.legCountdown]}>{cd.value}</Text>
            </View>
          )}
          {/* THE BELT, WHEN showsBelt ALLOWS ONE AND NOT OTHERWISE. That rule is
              untouched and lives in one place; this asks nothing and decides
              nothing. It can only ever be true on a landed leg, which is why it
              is the one thing that state carries beyond its identity. */}
          {belt && (
            <View style={st.legTimeRow}>
              <Text style={st.legTimeLabel}>{'Belt'}</Text>
              <Text style={st.legTimeValue}>{leg.to.baggage}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── A FOLDER, SHUT AND OPEN ───────────────────────────────────────────────
//
// DRAWN HERE RATHER THAN IMPORTED, AND THAT IS NOT FOR WANT OF A LIBRARY.
// @expo/vector-icons is in package.json -- and is imported by nothing in this
// app. Every icon on screen is a hand-written path in components/swipe.tsx:
// ICON_REFRESH, ICON_MAP, ICON_DELETE, BOOKMARK_D. Pulling a font-based icon set
// in for one glyph would be a second icon system for the sake of not typing a
// path, and it would arrive with a different stroke weight and a different
// optical size than everything beside it.
//
// SO THESE FOLLOW ICON_REFRESH's OWN CONVENTION, value for value: a 24-unit
// viewBox drawn at 20 points, fill none, strokeWidth 1.75, round caps and joins.
// Nothing here is a new number.
//
// TWO SHAPES RATHER THAN ONE THAT MORPHS. Interpolating between path data needs
// a library this project does not have and should not gain for an 8pt icon; two
// static paths crossfaded say the same thing and cost nothing.
const FOLDER_SHUT = (
  <Path
    d="M4 6.5A1.5 1.5 0 0 1 5.5 5h3.6l2 2h7.4A1.5 1.5 0 0 1 20 8.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5z"
    fill="none"
    stroke={DIM}
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

// THE BACK PLATE STOPS SHORT AND THE FRONT LEANS AWAY, which is the whole of what
// makes a folder read as open rather than as a differently-shaped box.
const FOLDER_OPEN = (
  <>
    <Path
      d="M4 16.5v-10A1.5 1.5 0 0 1 5.5 5h3.6l2 2h7.4A1.5 1.5 0 0 1 20 8.5V10"
      fill="none"
      stroke={DIM}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M3.2 18.4 5.4 11.7A1 1 0 0 1 6.4 11h14.1a1 1 0 0 1 .95 1.3l-2 6.2a1 1 0 0 1-.95.7H4.2a1 1 0 0 1-.95-1.3z"
      fill="none"
      stroke={DIM}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
);

// ── WHETHER A TRIP IS RUNNING LATE ────────────────────────────────────────
//
// ONE LEG DECIDES IT, AND IT IS THE LEG THAT MATTERS NOW. Not "any leg is late":
// a journey whose first hop ran forty minutes behind three days ago is not a late
// trip, and a folder that says so about a flight already flown is reporting
// history as though it were news.
//
// THE SAME LEG THE SCREEN ALREADY OPENS. currentLegIndex is the rule for which leg
// a traveller is living in -- the one after a landing, or the first inside its
// day -- so the accent follows the card rather than answering the question a
// second way. Where it declines to open anything, the next leg still to fly is
// the honest subject: a trip five days out is not late, but if its first
// departure has already been moved, that is exactly what the folder should say.
//
// WHICH END OF THE LEG, ON THE SAME SWITCH countdown USES. Before the aircraft
// moves, the departure delay is the fact; once it is airborne or down, the
// arrival is. effectiveStatus rather than the clock, so a departure time passing
// with nothing reported does not silently change which figure is read.
//
// THE DELAYS ARE ON THE RECORD, so nothing new is threaded in.
// SavedFlightEndpoint carries `delay` at both ends -- the server's own figure,
// compared against the scheduled time -- and a trip is a list of records. No
// FlightData, no prop, no second arithmetic.
//
// NULL IS NEUTRAL AND IS NEVER GREEN. The server emits null when it had neither
// an actual nor an estimate to compare, which is silence rather than punctuality.
// This is the same three-way reading clockTone makes on the card -- late above
// zero, on time at or below it, nothing at all for a null -- so the folder and
// the leg inside it cannot disagree about whether a flight is late.
//
// EVERY LEG FLOWN RETURNS NULL. A finished journey has nothing still to be late
// for, and a folder is not the place to relitigate one.
function tripTone(legs: SavedFlight[], now: number): 'ontime' | 'late' | null {
  const i = currentLegIndex(legs, now);
  const leg = i >= 0 ? legs[i] : legs.find(l => l.landedAt === null);
  if (leg === undefined) return null;
  const s = effectiveStatus(leg, now);
  const d = s === 'active' || s === 'landed' ? leg.to.delay : leg.from.delay;
  if (typeof d !== 'number') return null;
  return d > 0 ? 'late' : 'ontime';
}

// ── WHEN A TRIP LEAVES ────────────────────────────────────────────────────
//
// THE FIRST LEG'S DATE, WHICH NO HEADER SHOWED. A folder that names only a route
// cannot be told apart from the same route flown last month, and a shut folder is
// exactly where that matters -- the cards that carry the date are hidden.
//
// routeDateLabel IS SPLIT RATHER THAN RE-FORMATTED, the same way SheetFlightHeader
// and whenLine split it. A second formatter reading the same field is a second
// thing to keep in step.
//
// THE THREE-PART TEST IS A GUARD, not ceremony: routeDateLabel passes through
// anything it cannot parse, so a malformed date arrives as one part rather than
// three and this returns null instead of rendering half of itself.
//
// ISO_DAY_RE FIRST, because flightDate is the literal string "unknown" on a record
// filed without one -- see makeFlightId.
function tripDate(legs: SavedFlight[]): { day: string; mon: string; full: string } | null {
  const d = legs[0].flightDate;
  if (!ISO_DAY_RE.test(d)) return null;
  const parts = routeDateLabel(d).split(' ');
  if (parts.length !== 3) return null;
  return {
    // PADDED, because a column of dates that jitters between "5" and "12" is a
    // column the eye has to re-find on every row.
    day: parts[1].padStart(2, '0'),
    mon: parts[2].toUpperCase(),
    full: `${parts[0]} ${parts[1]} ${parts[2]}`.toUpperCase(),
  };
}

// THE TWO SHAPES, CROSSFADED, AS ONE THING. Extracted because all three headers
// want it and none of them wants to know how it works. See the note at the paths:
// only View opacity animates, so no Svg prop ever changes.
// THE CAROUSEL'S STUBS DRAW NO ICON, so they have no animation to hand one --
// but FolderHead takes an Animated.Value either way and a component may not
// create one conditionally. A module-level constant at rest is what they pass:
// one object, never driven, never read by the branch that receives it.
const STILL = new Animated.Value(0);

function FolderIcon({ anim }: { anim: Animated.Value }) {
  return (
    <View style={st.folderIcon}>
      <Animated.View
        style={[StyleSheet.absoluteFill, {
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        }]}
      >
        <Svg width={20} height={20} viewBox="0 0 24 24">{FOLDER_SHUT}</Svg>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: anim }]}>
        <Svg width={20} height={20} viewBox="0 0 24 24">{FOLDER_OPEN}</Svg>
      </Animated.View>
    </View>
  );
}

// ── WHAT A TRIP IS CALLED ─────────────────────────────────────────────────
//
// THE FIRST DEPARTURE AND THE LAST ARRIVAL. legsOfTrip has already ordered the
// legs by departure instant, so the ends of the array are the ends of the journey
// whatever order they were saved in.
//
// BOTH ENDS ARE IATA OR NEITHER IS, WHICH IS THE RULE. A code beside a city name
// reads as two kinds of fact and invites the reader to think one is more precise
// than the other. So when EITHER end is missing its code the whole title falls
// back to the flight number -- always present, machine data like the codes it
// replaces, and incapable of mixing.
//
// AND A MISSING CODE IS THE EMPTY STRING, NOT NULL. endpointFromApi writes
// `iata: raw?.iata ?? ''` and isValid only checks the field is a string, so ''
// reaches storage; a title built without this test would read " -> JFK". Same trap
// hubOf closes for the connection rule, and closed the same way: emptiness first,
// before the value is used for anything.
//
// NOT EDITABLE, AND NOTHING HERE ANTICIPATES THAT IT WILL BE. No tripName field
// and no affordance. When a trip can be named this becomes the default rather
// than the only answer.
function tripTitle(legs: SavedFlight[]): string {
  const from = legs[0].from.iata.trim().toUpperCase();
  const to = legs[legs.length - 1].to.iata.trim().toUpperCase();
  if (from === '' || to === '') return legs[0].flightNumber;
  return `${from} \u2192 ${to}`;
}

// ── A TRIP, WITH A LID ────────────────────────────────────────────────────
//
// THE HEADER SITS ABOVE THE RAIL AND THE RAIL LIVES INSIDE THE THING THAT
// COLLAPSES, which is the whole mechanism and the reason nothing here animates a
// line. st.rail is position absolute with top: 0 and bottom: 0 -- its height is
// not a value at all, it is pinned to its parent's box -- so when that parent's
// height goes to zero the line retracts into the header for free. No second
// animated value, no measurement of the line, nothing to keep in step.
//
// HEIGHT IS THE ONE THING ANIMATED, and it cannot go on the native driver in any
// library because it is a layout property. This file already drives its three
// overlays with react-native's Animated on EASE_OUT and EASE_IN; pulling
// Reanimated in for one control would be a second animation system doing what the
// first already does.
//
// THE CONTENT IS MEASURED RATHER THAN GUESSED, and re-measured on every layout,
// because a card's height changes as `now` ticks and as legs land. onLayout on the
// inner view reports its own content height even while the outer is clamped to
// zero: Yoga lays every child out and overflow only clips the paint.
//
// BEFORE THE FIRST MEASUREMENT the height is left unset when open and forced to
// zero when closed. Both are one frame and the asymmetry is deliberate -- a closed
// folder flashing its whole contents is far worse than an open one arriving a
// frame late, and the open one is the common case at the top of the screen.
//
// THE MARKER IS A FOLDER NOW AND IT WAS A TRIANGLE. The triangle said open or
// shut and said nothing about WHAT was open; a row of them reads as a list with
// disclosure arrows rather than as a shelf of journeys. The two shapes crossfade
// on the same value that drives the height, so the lid and the contents are one
// movement.
//
// OPACITY ON TWO STACKED Views, AND NO SVG PROP EVER CHANGES. Each shape sits in
// its own absolutely positioned layer and only the layers' opacity animates --
// which is a View property, not an Svg one, so react-native-svg never re-rasters.
// That is the same rule FlightArc follows and for the same reason.
//
// THE VALUE IS THE NON-NATIVE ONE, which opacity did not have to be: it is
// native-driver eligible where height is not. It rides the height's value anyway,
// because one gesture split across two drivers is how the two come apart.
// ── THE HEADER, IN THREE SHAPES ───────────────────────────────────────────
//
// ONE COMPONENT WITH THREE BRANCHES rather than three components, because the
// PROPS are identical and only the arrangement differs -- and because two of the
// three are going to be deleted, which is easier from one place than from three
// call sites.
function FolderHead({ title, count, date, tone, open, anim, first, onToggle }: {
  title: string; count: number;
  date: { day: string; mon: string; full: string } | null;
  // WHAT THE ACCENT SAYS. See tripTone: the relevant leg's own delay, in the same
  // three states the card's clock takes.
  tone: 'ontime' | 'late' | null;
  open: boolean; anim: Animated.Value; first: boolean; onToggle: () => void;
}) {
  const legs = `${count} ${count === 1 ? 'leg' : 'legs'}`;
  const press = {
    activeOpacity: 0.7,
    onPress: onToggle,
    accessibilityRole: 'button' as const,
    accessibilityState: { expanded: open },
    accessibilityLabel: date === null ? title : `${title}, ${date.full}, ${legs}`,
  };

  // ── A — THE FLIGHT STRIP ──
  //
  // EVERYTHING PACKED LEFT, WHICH IS THE WHOLE IDEA. A bar with a route at one
  // end and a count at the other is mostly empty and reads as a table row; a
  // strip reads as an object because its facts touch.
  //
  // THE GREEN EDGE IS THE ONE PLACE THIS FILE SPENDS CD_GREEN ON SOMETHING THAT
  // IS NOT LIVE, and it is two points wide for that reason -- an accent on the
  // date block rather than a statement about the flight. If that reads as a claim
  // on a device it should become DIM.
  if (FOLDER_STYLE === 'strip') {
    return (
      <TouchableOpacity {...press} style={st.stripHead}>
        <View style={st.cardEdge} pointerEvents="none" />
        {/* THE ICON IS FIRST AND FLUSH, AND RAIL_X IS SET TO ITS CENTRE. With no
            left padding the glyph's middle is at 10 -- half of its own 20 -- and
            the thread below drops from exactly there, so the line reads as coming
            out of the folder rather than running past it. */}
        <FolderIcon anim={anim} />
        <Text style={st.stripRoute} numberOfLines={1}>{title}</Text>
        {/* THE DATE BLOCK AT THE FAR EDGE, AND THE ACCENT IS ITS RIGHT BORDER.
            Flush with the header's own edge, which is why stripHead carries no
            right padding and clips to its radius -- the two points of colour end
            where the card ends and the corners follow the curve.

            STACKED, DAY OVER MONTH, because a column of folders is scanned down
            the same edge: "05" over "SEP" puts the number that changes most in the
            same place on every row, where "SAT 5 SEP" moves it about.

            THE COUNT IS GONE AND STAYS GONE. How many legs a journey has is
            answered by opening it; the date and the route are what you choose
            between while it is shut. It is still in the accessibility label, which
            pays nothing.

            THE BORDER IS THE ONLY THING THE TONE TOUCHES. The block's fill stays
            SURFACE_2 in every state, so a late trip is not a differently-shaped
            object -- two points of colour on an edge is an accent, and anything
            more would make amber the loudest thing on a screen of folders. */}
        <View style={st.stripSpace} />
        {date !== null && (
          <View
            style={[
              st.stripDate,
              tone === 'late' && st.stripDateLate,
              tone === 'ontime' && st.stripDateOnTime,
            ]}
          >
            <Text style={st.stripDay}>{date.day}</Text>
            <Text style={st.stripMon}>{date.mon}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  // ── B — NO CONTAINER AT ALL ──
  //
  // THE PAGE IS THE SURFACE AND A HAIRLINE IS THE ONLY CHROME. It is the rule
  // colour the cards already use inside themselves -- rgba(255,255,255,0.06), the
  // same one airportRule and tripRule take -- so nothing new enters the palette.
  //
  // NOT ON THE FIRST ITEM. A divider above the first row is a line under the
  // screen's own header, which is a different statement.
  if (FOLDER_STYLE === 'divider') {
    return (
      <TouchableOpacity {...press} style={[st.divHead, !first && st.divRule]}>
        <View style={st.divText}>
          {date !== null && <Text style={st.divDate}>{date.full}</Text>}
          <Text style={st.divRoute} numberOfLines={1}>{title}</Text>
        </View>
        <View style={st.divPill}>
          <Text style={st.divPillText}>{String(count)}</Text>
          <FolderIcon anim={anim} />
        </View>
      </TouchableOpacity>
    );
  }

  // ── C — A STUB IN A ROW OF STUBS ──
  //
  // FIXED WIDTH, STACKED, AND IT IS A TAB RATHER THAN A LID. See the note at the
  // render for why this one is not a folder at all.
  return (
    <TouchableOpacity {...press} style={[st.stub, open && st.stubOn]}>
      <View style={st.cardEdge} pointerEvents="none" />
      {date !== null && <Text style={st.stubDate}>{date.full}</Text>}
      <Text style={st.stubRoute} numberOfLines={1}>{title}</Text>
      <View style={st.stubCount}>
        <Text style={st.stripCountText}>{legs}</Text>
      </View>
    </TouchableOpacity>
  );
}

function TripFolder({ title, count, date, tone, open, first, onToggle, children }: {
  title: string; count: number;
  date: { day: string; mon: string; full: string } | null;
  tone: 'ontime' | 'late' | null;
  open: boolean; first: boolean; onToggle: () => void;
  children: ReactNode;
}) {
  const [h, setH] = useState(0);
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;
  // ── AT REST THE BOX IS UNCONSTRAINED, AND THAT IS THE BUG FIX ──
  //
  // THE HEIGHT WAS PINNED TO A SINGLE MEASUREMENT FOR AS LONG AS THE FOLDER WAS
  // OPEN, and anything that grew afterwards spilled out of the box and under the
  // next header. overflow: hidden clipped the PAINT; the box is what the folder
  // below is positioned after, so the layout was wrong even where the picture was
  // not.
  //
  // AND SOMETHING ALWAYS GROWS. `now` ticks every sixty seconds and a card can
  // gain a line; FlightArc draws nothing until it has measured its own width; a
  // leg landing swaps a collapsed row for a full card. A number captured once
  // cannot track any of that.
  //
  // SO THE MEASUREMENT IS ONLY USED WHILE THE FOLDER IS MOVING. Settled open, the
  // height is undefined and the container is exactly its content, for ever. A few
  // points of error during 200ms of travel is invisible; the same error at rest
  // is this bug.
  // ── WHICH `open` WE ARE AT REST AT, RATHER THAN WHETHER WE ARE AT REST ────
  //
  // A BARE settled FLAG SNAPPED THE FOLDER TO ITS FINAL STATE BEFORE ANIMATING.
  // It was set false inside an EFFECT, and effects run after the render commits --
  // so the render in which `open` flipped still had settled true and took the
  // at-rest branch with the NEW `open`. A log of it, opening:
  //
  //   {open: true, settled: true,  h: 16,  branch: "AUTO"}   full height, at once
  //   {open: true, settled: false, h: 337, branch: "ANIM"}   then animates 0 -> 1
  //
  // and closing, the same thing pointing the other way: height 0 immediately, then
  // a jump back to 337 and a smooth collapse. The animation was running correctly
  // the whole time -- eighteen frames on the right curve -- but the eye had
  // already been shown the answer, so what it read was the snap. That is why
  // changing the duration did nothing.
  //
  // STORING WHICH VALUE WE SETTLED AT FIXES IT WITHOUT AN EFFECT. `open` flips and
  // restAt still holds the old one, so atRest is false IN THE SAME RENDER and the
  // animated branch is taken immediately -- with anim still at the old end, which
  // is the height it already had. Nothing moves until the animation moves it.
  const [restAt, setRestAt] = useState(open);
  const atRest = restAt === open;

  // ── THE CHILDREN ARE ALWAYS MOUNTED, AND UNMOUNTING THEM WAS MY OWN BUG ───
  //
  // A `show` FLAG USED TO DROP THEM WHEN THE FOLDER SHUT. It was added to fix a
  // suspected overflow: hidden leak on Android -- and a diagnostic background
  // colour on this container later DISPROVED that: the box began exactly where
  // the header ended and finished exactly where the cards did. The overlap was
  // missing padding, nothing more. So the unmount was a fix for a bug that did
  // not exist.
  //
  // AND IT BROUGHT A REAL ONE. `h` is state and survives an unmount, so the next
  // open animated toward a height measured from the PREVIOUS contents -- stale by
  // however much the cards had changed since, and they change on every minute
  // tick. Too small clipped the content for the whole travel and popped it in at
  // the end; too large over-expanded and snapped back. Both of the symptoms.
  //
  // MOUNTED THROUGHOUT, onLayout RUNS CONTINUOUSLY and `h` is never stale. The
  // cost is the one the unmount claimed as its benefit: hidden trips render their
  // card trees. That cost was never justified, because the leak it was buying
  // protection from was imaginary.
  const firstRun = useRef(true);

  // ── WHETHER THE BOX IS LEFT TO ITS CONTENT THIS RENDER ────────────────────
  //
  // ONE BOOLEAN READ BY BOTH THE HEIGHT AND THE MEASUREMENT, so they cannot come
  // to disagree about whether the container is clamped. It is true at rest, and
  // true when `h` is still unknown -- there is nothing to interpolate toward.
  const natural = atRest || h === 0;


  // ── AND NOTHING ANIMATES ON MOUNT ─────────────────────────────────────────
  //
  // THE EFFECT RAN ON MOUNT AND ANIMATED A VALUE TO ITSELF. anim starts at the
  // right end already, so the timing travelled zero distance -- but it still set
  // `settled` false for its whole duration, which under the old `show` flag mounted
  // every CLOSED folder's children for one animation and then dropped them again.
  // A folder should settle into the state it was born in, not transition into it.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? FOLD_IN_MS : FOLD_OUT_MS,
      // THE SAME CURVE IN BOTH DIRECTIONS, which the overlays deliberately do not
      // do. Theirs arrive and depart differently because they are appearing and
      // disappearing; a folder is one object changing size, and it has to come to
      // rest at both ends. See FOLD_EASE.
      easing: FOLD_EASE,
      useNativeDriver: false,
      // THE VALUE IT ANIMATED TO, captured by this closure. An interrupted
      // animation reports finished false and leaves restAt alone, so a folder
      // tapped twice never records a state it did not reach.
    }).start(({ finished }) => { if (finished) setRestAt(open); });
  }, [open]);

  return (
    <View>
      {/* THE LID, IN WHICHEVER SHAPE IS BEING TRIED. The rail below starts at
          RAIL_X and the header is a solid block above it, so the thread reads as
          dropping out of the folder whatever the header is made of -- none of the
          three aligns anything to the line, and none needs to. */}
      <FolderHead
        title={title}
        count={count}
        date={date}
        tone={tone}
        open={open}
        anim={anim}
        first={first}
        onToggle={onToggle}
      />
      <Animated.View
        style={[
          st.folderBody,
          {
            height: natural
              ? (open ? undefined : 0)
              : anim.interpolate({ inputRange: [0, 1], outputRange: [0, h] }),
          },
        ]}
      >
        {/* ── THE CONTENT DISSOLVES INSTEAD OF BEING SCRAPED AWAY ──
            A MOVING CLIP EDGE GUILLOTINES THE BOTTOM CARD. It is a hard line
            travelling through the content, cutting a card in half on its way past;
            a fade means the cards go as a whole rather than being sliced.

            ONE INTERPOLATION SERVES BOTH DIRECTIONS, which is the part worth
            reading twice. Opacity is zero below 0.6 and rises to one at 1, so
            OPENING it stays invisible for the first sixty per cent of the travel
            and appears into space that already exists, and CLOSING -- the same
            value running backwards -- it is gone within the first forty per cent
            and the rest is an empty container shutting. The leading edge of the
            motion in each direction, from one line.

            COMPRESSED RATHER THAN FULL-LENGTH, AND THAT IS WHAT STOPS IT READING
            AS TWO MOTIONS. A fade over the whole duration would run at equal
            weight against the shrink and neither would be the thing happening.
            Confined to a fifth of a second at one end, it is an attribute of the
            collapse rather than a second animation.

            IT COSTS NOTHING TO DRIVE. Same value, one more interpolate, no second
            animation and no driver split -- height is already off the native
            driver, so opacity riding beside it changes nothing.

            THE RAIL FADES WITH THE CARDS because it is inside this view. That is a
            consequence rather than a choice, and it is the right one: the thread
            belongs to the content it threads. */}
        <Animated.View
          style={[
            st.folderInner,
            {
              opacity: anim.interpolate({
                inputRange: [0, 0.6, 1],
                outputRange: [0, 0, 1],
              }),
            },
          ]}
          // ── MEASURED ONLY WHILE THE BOX IS UNCLAMPED, WHICH IS CONFIRMED ──
          //
          // YOGA DOES REPORT THE CLAMPED BOX, AND A LOG SETTLED IT. Shut, this view
          // measured 16 -- folderInner's own paddingVertical and nothing else, the
          // content clipped to zero. The old guard refused a measurement of ZERO
          // and 16 sails through it, so every closed folder was overwriting a good
          // height of 337 with the height of its own padding. That is a stale `h`
          // by any other name.
          //
          // SO THE TEST IS THE CONTAINER'S STATE, NOT THE NUMBER'S. `natural &&
          // open` is exactly when the height is left undefined and the content is
          // laying itself out at its own size; anything measured at any other
          // moment is a reading of the clamp.
          //
          // IT ALSO COVERS THE TRANSITION, which the old guard covered separately:
          // during a collapse the box is clamped, so nothing is taken, so the
          // outputRange cannot be rewritten under an interpolation that is being
          // read.
          //
          // THE FIRST OPEN OF A FOLDER THAT STARTED SHUT DOES NOT ANIMATE ITS
          // HEIGHT, and that is the cost. Its `h` is still 0, so `natural` is true,
          // so the box goes straight to its content -- and the opacity, which needs
          // no measurement, fades the cards in over the same 320ms. The layout is
          // taken on that render and every open afterwards animates properly. A
          // content height simply cannot be known before it has been allowed to
          // exist once; the alternative is rendering every shut folder unclamped
          // for a frame at mount, which is a flash on every launch instead of a
          // soft first open.
          onLayout={e => {
            if (natural && open) setH(e.nativeEvent.layout.height);
          }}
        >
            {/* THE THREAD STARTS AT THE HEADER AND STOPS AT THE LAST CARD. An
                absolute child anchors to its parent's PADDING box, so top: 0 puts
                the line's head up inside folderInner's top padding, touching the
                underside of the lid -- which is the reading this whole
                arrangement is for. Left alone it would also run the padding at
                the BOTTOM and hang eight points below the final card, so the tail
                is inset by exactly that. See railFolder.

                THE OTHER TWO CALLERS TAKE st.rail BARE. The single-trip render
                and the carousel body have no padding to correct for. */}
          <View style={[st.rail, st.railFolder]} pointerEvents="none" />
          <View style={st.trip}>{children}</View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export default function Flights() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    savedFlights, ownFlight, disownFlight, refreshOne,
    // ── THE PULL THIS SCREEN NEVER HAD ──
    //
    // MY FLIGHTS HAD NO REFRESH GESTURE AT ALL, and that is not a figure of
    // speech: there was no RefreshControl on its ScrollView and refreshAll was
    // called from exactly one place in the app, the home screen. Pulling down
    // here bounced the scroll view and did nothing. A leg could sit eight hours
    // stale on the one screen built to show it, and the only ways to update it
    // were a swipe on the leg or a trip to another tab.
    refreshAll, refreshing,
  } = useSaved();
  const { showToast } = useToast();
  const { isOnMap, addRoute, removeRoute } = useMapRoutes();

  // THIS SCREEN'S OWN MINUTE TICK, and it is not on the context. The phase, the
  // countdowns, the progress bar and the current/past split are all functions of
  // the clock and all of them are read HERE, so the clock lives here — see the
  // note at the top of lib/saved.tsx for why a shared `now` would re-render every
  // screen in the app once a minute for one screen's benefit. lib/flightcard.tsx
  // keeps an identical one for the card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  // tripsOf ALREADY GROUPED AND ORDERED THEM. It puts the legs of each trip in
  // departure order and the trips themselves by their earliest leg still to fly,
  // with finished trips last — so all that is left here is the split, which is
  // against this screen's own clock. See the note at tripsOf: it deliberately
  // filters nothing, exactly as index.tsx makes its own archive split.
  const trips = useMemo(() => tripsOf(savedFlights, now), [savedFlights, now]);
  const current = useMemo(
    () => trips.filter(legs => legs.some(l => !isArchived(l, now))),
    [trips, now],
  );
  const past = useMemo(
    () => trips.filter(legs => legs.every(l => isArchived(l, now))),
    [trips, now],
  );

  // ── WHICH LEG IS OPEN, AND WHO DECIDED ────────────────────────────────────
  //
  // A LEG ID, OR NOTHING, AND NOTHING IS THE ORDINARY STATE. Null means the
  // screen is following the journey: focus is wherever currentLegIndex puts it
  // and it MOVES as legs land. A non-null id means the user has overruled that
  // by opening a different leg, and the screen holds still until they say
  // otherwise.
  //
  // AN ID RATHER THAN AN INDEX. Legs are ordered by departure instant and that
  // order can change under a delay, so an index would silently come to name a
  // different leg. An id names the record.
  const [focusOverride, setFocusOverride] = useState<string | null>(null);

  // ── WHICH FOLDERS ARE OPEN ────────────────────────────────────────────────
  //
  // EXPLICIT TOGGLES ONLY, AND THE DEFAULT IS DERIVED. A set of OPEN ids would go
  // stale: tripsOf re-sorts on every tick, so the trip that should be open by
  // default CHANGES the moment a journey finishes and the next is promoted. A
  // record of what the user has actually tapped, read against a default computed
  // fresh, follows that; a set seeded at mount does not.
  //
  // IT DOES NOT SURVIVE A RELAUNCH, and the argument is stronger than it was for
  // the focus override this replaces. A stale focus showed the wrong trip; a stale
  // CLOSED on the current trip shows nothing at all for the journey you are on,
  // with nothing on screen saying why. The default is right, this screen has no
  // persistence of any kind, and the cost of being wrong is a blank.
  const [openTrips, setOpenTrips] = useState<Record<string, boolean>>({});

  // ── SIGNING IN OR OUT EMPTIES THIS SCREEN TOO ─────────────────────────────
  //
  // THE SAME FAULT THE DECK HAD, for the same reason: this screen stays
  // mounted across a sign-in, so the focused leg and the open folders were
  // the previous account's. Both name records BY ID, and an id from another
  // account's list matches nothing here -- so the visible result was a screen
  // that quietly refused to open the trip the user was actually on.
  //
  // THE OVERLAY IS NOT RESET, and that is not an oversight: the account can
  // only change from home's profile modal, so no overlay on this screen can
  // be up when it happens, and tearing down an animated surface that is not
  // there would be a guess about a state that cannot exist.
  useAccountChange(() => {
    setFocusOverride(null);
    setOpenTrips({});
  });







  // AND IT IS DROPPED WHEN IT STOPS MEANING ANYTHING. The trip can change under
  // it: a leg is removed, the whole journey finishes and leaves `current`, or
  // tripsOf puts a different trip first. Holding an id that names nothing on
  // screen would pin the screen to a leg the user cannot see, and the next trip
  // to contain that id would inherit somebody else's decision.
  //
  // IN AN EFFECT RATHER THAN IN THE MEMO ABOVE, because a render must not write
  // state. The memo already falls through, so this only tidies up.
  // ACROSS EVERY TRIP NOW, NOT JUST THE OPEN ONE. There is no single focus trip
  // any more: every folder renders its own legs, so an override is still showing
  // as long as ANY current trip contains that leg. It only clears when the leg
  // leaves the screen entirely -- disowned, or its whole journey archived.
  useEffect(() => {
    if (focusOverride === null) return;
    const showing = current.some(legs => legs.some(l => l.id === focusOverride));
    if (!showing) setFocusOverride(null);
  }, [current, focusOverride]);

  // ── AND IT ENDS WHEN YOU LOOK AWAY ────────────────────────────────────────
  //
  // A LOOK, NOT A SETTING. Tapping a leg is somebody asking to see that one
  // now; it is not a preference about which leg this screen shows from here on.
  // Leaving the tab and coming back to leg 2 still open reads as a state the
  // screen has been put into, and there is nothing on screen saying so or
  // offering to undo it.
  //
  // ON BLUR, AND NOT ON A TIMER. Any interval is a number nobody can defend,
  // and its failure is the worst available: the card changes WHILE IT IS BEING
  // READ. Blur cannot fire while somebody is looking.
  //
  // AND NOT ON "THE RULE WOULD NOW PICK A DIFFERENT LEG" EITHER, which sounds
  // right and is not. It would not have fixed this -- leaving the tab does not
  // move the rule -- and while the screen IS open it is actively wrong: tap leg
  // 2 to read it, let leg 1 land, and it would pull you somewhere else
  // mid-sentence. That is the timer's fault with extra steps.
  //
  // BACKGROUNDING IS NOT LEAVING. useFocusEffect does not fire when the app is
  // backgrounded, which is the behaviour we want: minimising and coming back
  // has not left this screen, and losing your place for it would be a surprise.
  //
  // THE CLEANUP IS THE WHOLE THING, which is the same shape app/search.tsx uses
  // for its card: the effect does nothing on focus and everything on blur.
  useFocusEffect(useCallback(() => () => setFocusOverride(null), []));

  // TAPPING A COLLAPSED LEG OPENS IT, AND TAPPING THE ONE THE JOURNEY WOULD
  // HAVE CHOSEN ANYWAY GIVES CONTROL BACK.
  //
  // The second half is what stops this being a one-way door. Setting the
  // override to the natural leg's own id would LOOK identical and would quietly
  // stop the screen following the journey -- the next landing would move
  // currentLegIndex and the override would pin focus to the leg behind it. Null
  // is a different state from "the same index by coincidence", and it is the
  // one that keeps tracking.
  const openLeg = (legs: SavedFlight[], leg: SavedFlight) => {
    const i = currentLegIndex(legs, now);
    setFocusOverride(i >= 0 && legs[i].id === leg.id ? null : leg.id);
  };



  // ── WHICH FOLDER IS OPEN, AND THE DEFAULT THAT MOVES ──────────────────────
  //
  // current[0] IS THE DEFAULT AND IS READ FRESH EVERY RENDER. tripsOf ranks a
  // journey with a leg still to fly above one that is finished, so the trip that
  // should be open by default CHANGES when a journey ends. Storing the answer
  // would freeze it; storing only what the user has TAPPED lets the default
  // follow.
  //
  // A tripId AND NOT AN INDEX, for the same reason focusOverride is an id: the
  // ordering moves under both of them.
  const isOpen = (legs: SavedFlight[]): boolean => {
    const id = legs[0].tripId as string;
    const explicit = openTrips[id];
    return explicit === undefined ? current[0] === legs : explicit;
  };

  // TOGGLES AGAINST WHAT IS ON SCREEN, not against what was stored. Reading
  // isOpen rather than the record means the first tap on a never-touched folder
  // does the visible thing -- closing the default-open trip, opening any other --
  // instead of depending on an entry that is not there.
  const toggleTrip = (legs: SavedFlight[]) => {
    const id = legs[0].tripId as string;
    const next = !isOpen(legs);
    // ── A CLOSED FOLDER FORGETS WHICH LEG WAS TAPPED ──────────────────────
    //
    // THE OVERRIDE OUTLIVED THE FOLDER AND THAT IS THE BUG. Tapping SFO-FRA on a
    // landed leg, shutting the folder and opening it again showed SFO-FRA again
    // -- not the leg boarding now. Closing a folder is the clearest statement
    // available that the user is done with it, so it is the right moment to hand
    // focus back to the journey.
    //
    // AND IT IS CONDITIONAL, BECAUSE ONE VALUE SERVES EVERY FOLDER. focusOverride
    // is a single leg id for the whole screen -- it works across trips only
    // because ids are unique, so a folder that does not contain the leg simply
    // misses. Clearing it unconditionally would mean shutting ANY folder
    // discarded a decision made in a DIFFERENT one.
    const ownsFocus = focusOverride !== null && legs.some(l => l.id === focusOverride);
    // ── THE CAROUSEL IS SINGLE-SELECT AND THE OTHER TWO ARE NOT ──
    //
    // A ROW OF STUBS WITH ONE BODY UNDER IT CAN ONLY SHOW ONE TRIP, so choosing a
    // stub has to close every other. The folders can have any number open at once
    // because each carries its own body.
    //
    // AND A STUB CANNOT BE UNSELECTED. Tapping the open one again would leave the
    // strip with nothing beneath it and no way back except tapping a stub, which
    // is a state with no purpose; so the carousel ignores a tap on what is already
    // chosen where a folder would shut.
    if (FOLDER_STYLE === 'carousel') {
      if (!next) return;
      const only: Record<string, boolean> = {};
      for (const t of current) only[t[0].tripId as string] = t[0].tripId === id;
      setOpenTrips(only);
      // EVERY OTHER TRIP JUST CLOSED, without any of them being toggled. The
      // override survives only if it names a leg in the one being opened.
      if (focusOverride !== null && !ownsFocus) setFocusOverride(null);
      return;
    }
    setOpenTrips(prev => ({ ...prev, [id]: next }));
    if (!next && ownsFocus) setFocusOverride(null);
  };

  // ── ONE TRIP'S LEGS, AND ITS OWN TWO INDICES ──────────────────────────────
  //
  // THEY USED TO BE MEMOS AT THE TOP OF THIS COMPONENT because there was one
  // open trip and therefore one answer. Every folder renders its own legs now,
  // so every folder needs its own current leg and its own next -- and a hook
  // cannot be called inside a map. currentLegIndex and nextLegIndex are pure
  // functions of a leg list and a clock, so calling them straight is not a
  // downgrade from useMemo; it is what useMemo was wrapping.
  //
  // THE LEG OVERRIDE IS STILL SHARED AND STILL WORKS. focusOverride holds a leg
  // id, and ids are flightNumber|date -- unique across every trip -- so the
  // findIndex below misses in every journey but the one that owns the leg and
  // falls through to currentLegIndex there. One value, N folders, no collisions.
  const renderLegs = (legs: SavedFlight[]) => {
    const oIdx = (() => {
      if (focusOverride !== null) {
        const i = legs.findIndex(l => l.id === focusOverride);
        if (i >= 0) return i;
      }
      return currentLegIndex(legs, now);
    })();
    const nIdx = nextLegIndex(legs, now, oIdx);
    return legs.map((leg, i) => {
      // ONE ANSWER PER LEG, ASKED ONCE. legState reads the two
      // indices and the landing; nothing below re-derives any of them,
      // and no clock is consulted here at all -- both windows were
      // spent deciding openIdx and nextIdx above.
      //
      // showsBelt IS ASKED UNCONDITIONALLY AND NEEDS NO STATE GUARD:
      // its own first two conditions are a belt number and a landing,
      // so it is already false on every state but landed. Gating it
      // here would be the same rule written twice.
      const state = legState(leg, i, oIdx, nIdx, now);
      const card = state !== 'current' ? (
          <CollapsedLeg
            leg={leg}
            state={state}
            belt={showsBelt(legs, i, now)}
            now={now}
            onPress={() => openLeg(legs, leg)}
          />
      ) : (
      <FlightCard
        flight={flightDataFromSaved(leg, effectiveStatus(leg, now))}
        flightRecord={leg}
        now={now}
        // TRUE BY CONSTRUCTION. A leg is a record in savedFlights with
        // a tripId on it, so a flight this screen can show is a flight
        // that is saved -- the same argument the map card makes.
        isSaved
        handleToggleSave={NOT_REACHABLE}
        routeOnMap={isOnMap(leg.id)}
        toggleRouteOnMap={() => { void toggleLegOnMap(leg); }}
        // TRUE BY CONSTRUCTION TOO: current[0] came out of tripsOf,
        // which groups on a non-null tripId.
        isOwnedFlight
        // THE MENU ROW AND THE SWIPE ARE ONE ACTION. Both remove the
        // leg, so both are handed the same function rather than two
        // that could drift.
        toggleOwned={() => { void remove(leg); }}
        removeFromTrip={() => { void remove(leg); }}
        refreshFlightCard={() => { void refreshLeg(leg); }}
        closeFlightCard={NOT_REACHABLE}
        tripVariant
        // THE HALF OF THE BELT QUESTION THE CARD CANNOT ANSWER. See
        // bagEligible above and the prop's own note on the card: it is
        // about this leg's position in the trip, and the trip is here.
        // The card still decides the other half, which is whether the
        // flight has landed.
        bagsClaimedHere={bagEligible(legs, i)}
        // WHERE THIS LEG SITS IN THE JOURNEY, and both numbers were
        // already here -- `i` is the map index and `legs` is the
        // ordered leg list bagEligible above is reading. Nothing is
        // derived and no trip model crosses the boundary; the card
        // gets a position and a total, which is all a header tag is.
        //
        // legsOfTrip SORTED THEM BY DEPARTURE INSTANT before any of
        // this saw them, so "leg 2 of 4" means the second flight taken
        // rather than the second record stored.
        legIndex={i}
        legCount={legs.length}
        // THE SAME COUNTDOWN THE COLLAPSED ROWS TAKE, from the same
        // function on the same tick. The open card and the row above
        // it must not disagree about how long is left, and one
        // implementation is how that is guaranteed rather than
        // checked. See the prop's note on the card.
        countdown={countdown(leg, now)}
      />
      );
      // THE KEY MOVED TO THE FRAGMENT, which is why neither element
      // above carries one any more: a leg now renders as a PAIR --
      // itself, and the gap that follows it -- and React keys the
      // thing that is returned.
      //
      // AFTER EVERY LEG BUT THE LAST. A layover is what sits between
      // two legs, so there are always exactly one fewer of them than
      // there are legs, and a trailing one would be the space after
      // the journey ends.
      //
      // A Fragment ADDS NO VIEW. Its children become direct children
      // of st.trip, so CARD_GAP falls between the card and the row
      // exactly as it falls between two cards.
      return (
        <Fragment key={leg.id}>
          {/* THE SLOT IS WHAT HOLDS THE LEG OFF THE THREAD. The card
              itself cannot carry the margin -- FlightCard's root is a
              Swipeable this screen does not style -- so both levels
              are wrapped, which also keeps the two variants the same
              distance from the line. */}
          <View style={st.legSlot}>{card}</View>
          {i < legs.length - 1 && (
            <Layover prev={leg} next={legs[i + 1]} />
          )}
        </Fragment>
      );
    });
  };

  // WHAT CAN BE IMPORTED: watched, not already owned, not already archived.
  // Sorted by the list's own relevance rule so the sheet reads in the same order
  // the watchlist does.
  const importable = useMemo(
    () => sortSavedByRelevance(
      savedFlights.filter(f => !isOwned(f) && !isArchived(f, now)), now),
    [savedFlights, now],
  );

  // ── WHAT IS UP, AND THE TWO VALUES THAT DRAW IT ───────────────────────────
  //
  // ONE STATE AND ONE PAIR OF VALUES for all three overlays. The panel value
  // drives whichever surface is showing; the scrim value drives the dim behind
  // it, and the two are separate because a SWITCH moves one and not the other.
  const [overlay, setOverlay] = useState<Overlay>(null);
  const panel = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;

  // FROM NOTHING. Both values start at 0 BEFORE the state is set, so the frame
  // the Modal mounts on is already invisible rather than showing the last
  // overlay's resting position for one frame.
  const openOverlay = (o: Exclude<Overlay, null>) => {
    panel.setValue(0);
    scrim.setValue(0);
    setOverlay(o);
    Animated.parallel([
      Animated.timing(scrim, {
        toValue: 1, duration: SCRIM_IN_MS, easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(panel, {
        toValue: 1, duration: motionOf(o).inMs, easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  };

  // TO NOTHING. The state goes null in the completion callback, so the Modal is
  // unmounted after the exit rather than cut off at the frame it started on.
  //
  // NO PARAMETER, AND THAT IS DELIBERATE. The version of this that took an
  // "afterwards" callback existed to open a second Modal, and there is no second
  // Modal any more. Leaving the parameter would leave the shape of the bug.
  const closeOverlay = () => {
    if (overlay === null) return;
    Animated.parallel([
      Animated.timing(panel, {
        toValue: 0, duration: motionOf(overlay).outMs, easing: EASE_IN, useNativeDriver: true,
      }),
      Animated.timing(scrim, {
        toValue: 0, duration: SCRIM_OUT_MS, easing: EASE_IN, useNativeDriver: true,
      }),
    ]).start(() => setOverlay(null));
  };

  // ── ONE PANEL OUT, THE NEXT IN, AND THE MODAL NEVER MOVES ─────────────────
  //
  // THIS IS THE WHOLE FIX. Nothing is dismissed and nothing is presented: the
  // Modal stays mounted the entire time and only its CONTENTS change, so there
  // is no second presentation for the platform to refuse.
  //
  // THE SCRIM STAYS UP AND IS NOT ANIMATED. It is the modal state itself -- "you
  // are in something" -- and flashing it off and on between two panels would
  // read as the screen being dismissed and immediately re-summoned, which is
  // precisely the thing that is not happening.
  //
  // PANEL_OUT_MS FOR THE EXIT WHATEVER IS LEAVING, because the only switch this
  // screen has is the menu handing over, and the menu's exit is the panel's.
  const swapOverlay = (o: Exclude<Overlay, null>) => {
    Animated.timing(panel, {
      toValue: 0, duration: PANEL_OUT_MS, easing: EASE_IN, useNativeDriver: true,
    }).start(() => {
      setOverlay(o);
      panel.setValue(0);
      Animated.timing(panel, {
        toValue: 1, duration: motionOf(o).inMs, easing: EASE_OUT, useNativeDriver: true,
      }).start();
    });
  };

  const remove = async (leg: SavedFlight) => {
    await disownFlight(leg);
    showToast(`${leg.flightNumber} removed`);
  };

  // -- ONE LEG, REFRESHED ----------------------------------------------------
  //
  // A SECOND CALL SITE FOR THE FLIGHT ENDPOINT, AND IT IS SAID OUT LOUD RATHER
  // THAN HIDDEN. useFlightCardHost owns the other one and cannot serve this
  // screen: it holds ONE flight, one error, one entry animation and one
  // `loading` in state, and a trip has several cards that each refresh
  // themselves. Driving three cards from a hook built for one would mean a
  // refresh on leg two writing over leg one.
  //
  // SO IT DUPLICATES THE FETCH AND DELIBERATELY NOT THE STATE MACHINE. No
  // setFlight, no error channel, no entry transition -- there is no single card
  // here to own them, and the only visible result is a toast and the record on
  // disk being newer. The refresh loop in lib/saved.tsx is the third caller of
  // this endpoint and shares nothing with either.
  //
  // THE DATE AND THE ORIGIN ARE THE LEG'S OWN, for the reason refreshFlights
  // states in lib/saved.tsx: undated, this asks for whichever instance is
  // nearest now, and without an origin a TAG FLIGHT refreshes into the other
  // leg -- a saved BOM-DEL quietly becoming DEL-BOM under the same id.
  //
  // refreshOne TAKES THE LEG'S id AS ITS TARGET, so a record filed under
  // "unknown" can take the real date the response carries. Same argument
  // refreshFlights makes for passing f.id.
  const refreshLeg = async (leg: SavedFlight) => {
    try {
      const day = ISO_DAY_RE.test(leg.flightDate) ? leg.flightDate : null;
      const res = await fetch(flightUrl(leg.flightNumber, day, leg.from.iata || null));
      const data = await res.json();
      if (data.error || !res.ok) { showToast('could not update'); return; }
      await refreshOne(savedFlightFromApi(data), leg.id);
      showToast('updated');
    } catch {
      showToast('could not update');
    }
  };

  // THE MAP TOGGLE, PER LEG. lib/flightcard.tsx's toggleRouteOnMap acts on the
  // one flight that hook is holding; this is the same action against whichever
  // leg's card asked for it, in the same words and through the same mapRouteFor.
  const toggleLegOnMap = async (leg: SavedFlight) => {
    if (isOnMap(leg.id)) {
      await removeRoute(leg.id);
      showToast('removed from map');
      return;
    }
    const outcome = await addRoute(mapRouteFor(leg));
    showToast(outcome === 'limit'
      ? `map holds ${MAX_MAP_ROUTES} routes — remove one first`
      : 'added to map');
  };

  // THE SAME REPORT THE CARD'S MENU MAKES, through the same strings. ownFlight
  // calls enableReminders on both its paths, so adding a flight here turns
  // reminders on exactly as adding one from the flight card does -- and two
  // paths into one action must not say different things about it. See OWN_MSG.
  const add = async (f: SavedFlight) => {
    const outcome = await ownFlight(f);
    closeOverlay();
    showToast(OWN_MSG[outcome.remind]);
  };

  // ── ONE CONTROL, TWO WAYS IN BEHIND IT ────────────────────────────────────
  //
  // TWO BUTTONS STACKED WAS TWO ANSWERS TO A QUESTION NOBODY HAD ASKED YET. The
  // screen's whole prompt is "add the flight you're taking"; how it gets added is
  // a second decision, and putting it in front of the first made the empty state
  // a menu with no heading. One button asks, and the menu answers.
  //
  // NEITHER WAY IS A TEXT FIELD. A search input here would be a second command
  // line: the tab bar already owns one and the search screen is where it types.
  // This sends you there rather than reimplementing it.
  //
  // IMPORT IS A SWAP, NOT A HANDOFF. The Modal is already up; only what is in it
  // changes. See swapOverlay for why that is the whole of the fix.
  //
  // SEARCH IS NOT, BECAUSE THE SEARCH SCREEN IS NOT A MODAL. This closes and
  // navigates in the same tick, which leaves the scrim fading over the search
  // screen for the length of the exit. That is visible and it is accepted: the
  // alternative is a completion callback sequencing an overlay against a
  // navigation, which is the shape this change exists to remove -- and unlike
  // the Modal case nothing is LOST here, it is only briefly overlapped.
  const chooseSearch = () => {
    closeOverlay();
    router.push('/search');
  };
  const chooseImport = () => {
    swapOverlay('import');
  };

  // THE PLUS IS THE ONE GREEN THING ON AN EMPTY SCREEN, and that is within the
  // rule rather than an exception to it: green means live and actionable, and on
  // a page with no trips on it this is the only actionable thing there is. The
  // label stays at the ordinary ink -- one mark, not a green button.
  // ── THE SAME ACT, AS A MARK IN THE HEADER ─────────────────────────────────
  //
  // THE FULL BUTTON BELOW THE TRIP WAS DEAD SPACE THE MOMENT A TRIP EXISTED. It
  // sat under the last leg with 32 points above it, so a screen with one flight
  // on it ended in a wide control for adding a second -- which is not what
  // somebody opening this screen mid-journey is there to do.
  //
  // A MARK RATHER THAN A BUTTON, because in the header it is not the subject any
  // more. The plus alone is the whole control, at the title's own optical weight,
  // and the label is gone: "Add your flight" beside "My Flights" would be two
  // headings competing.
  //
  // GREEN, AND IT IS THE SAME EXCEPTION THE FULL BUTTON CLAIMS. Green means
  // actionable; this is the one action in the header.
  //
  // THE FULL BUTTON IS NOT DELETED. It is the empty state's, where the screen has
  // nothing else to say and the act IS the subject -- see the empty branch.
  const headerAdd = (
    <TouchableOpacity
      style={st.headerAdd}
      activeOpacity={0.7}
      onPress={() => { EXPAND_HAPTIC(); openOverlay('menu'); }}
      accessibilityRole="button"
      accessibilityLabel="add your flight"
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
    >
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path d="M12 5v14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
        <Path d="M5 12h14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
      </Svg>
    </TouchableOpacity>
  );

  const addButton = (
    <TouchableOpacity
      style={st.addBtn}
      activeOpacity={0.7}
      onPress={() => { EXPAND_HAPTIC(); openOverlay('menu'); }}
      accessibilityRole="button"
      accessibilityLabel="add your flight"
    >
      <View style={st.cardEdge} pointerEvents="none" />
      {/* 20, UP FROM 16. The glyph is the half of this control that says what it
          does; at 16 beside a 15pt label it read as a bullet. */}
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M12 5v14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
        <Path d="M5 12h14" fill="none" stroke={CD_GREEN} strokeWidth={1.75} strokeLinecap="round" />
      </Svg>
      <Text style={st.addLabel}>{'Add your flight'}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      {/* ── THE ONE MODAL ──
          MOUNTED WHENEVER ANYTHING IS UP AND NEVER TWICE. The scrim, the dim and
          the dismissing Pressable are here rather than inside each panel,
          because they belong to the MODAL STATE rather than to whichever surface
          happens to be showing -- which is also what lets a switch leave them
          alone. See Overlay and swapOverlay. */}
      <Modal
        visible={overlay !== null}
        transparent
        animationType="none"
        onRequestClose={closeOverlay}
      >
        <Pressable style={g.routeCalScrim} onPress={closeOverlay}>
          {/* The dim alone, full screen and unblurred. The blur lives inside
              each panel, so outside it the page stays sharp. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, g.routeCalDim, { opacity: scrim }]}
          />

          {overlay === 'menu' && (
            <Menu panel={panel}>
              <MenuRow label="Search for a flight" onPress={chooseSearch} />
              <MenuRow label="Import from watchlist" onPress={chooseImport} />
            </Menu>
          )}

          {overlay === 'import' && (
            <Sheet panel={panel} title="Import" onClose={closeOverlay}>
              {importable.length === 0 ? (
                <Text style={st.sheetEmpty}>{'Nothing on your watchlist to import.'}</Text>
              ) : (
                <ScrollView style={st.sheetList} showsVerticalScrollIndicator={false}>
                  {importable.map(f => (
                    <TouchableOpacity
                      key={f.id}
                      style={st.importRow}
                      activeOpacity={0.7}
                      onPress={() => add(f)}
                      accessibilityRole="button"
                      // "TO MY FLIGHTS", NOT "TO THIS TRIP". It said the latter
                      // while calling ownFlight with no trip id, which minted a
                      // new one -- so the label named an outcome that could not
                      // happen. It can happen now, and the label is still wrong
                      // for a different reason: whether this flight joins the
                      // open trip, joins a different one, or starts its own is
                      // decided by the airports and the clock AFTER the tap. The
                      // honest label is the destination the user is choosing,
                      // which is the screen -- and it is the word the toast
                      // already uses. See OWN_MSG.
                      accessibilityLabel={`add ${f.flightNumber} to My Flights`}
                    >
                      <View style={st.cardEdge} pointerEvents="none" />
                      <View style={st.legHead}>
                        <Text style={st.legNum}>{f.flightNumber}</Text>
                        <Text style={st.legRoute} numberOfLines={1}>
                          {`${f.from.iata} → ${f.to.iata}`}
                        </Text>
                      </View>
                      <StatusLine f={f} now={now} numberOfLines={1} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </Sheet>
          )}

          {/* READ-ONLY, AND THAT IS THE WHOLE OF WHAT THIS SHEET IS. A finished
              trip has nothing left to do to it: it cannot be left, its reminders
              are spent, and removing it belongs to the watchlist rather than
              here. Rows with no actions are rows nobody has to be careful
              around.

              AND UNREACHABLE. Its entry point was removed; `overlay` cannot
              become 'past' today. It stays until one comes back. */}
          {overlay === 'past' && (
            <Sheet panel={panel} title="Past flights" onClose={closeOverlay}>
              {past.length === 0 ? (
                <Text style={st.sheetEmpty}>{'Nothing here yet.'}</Text>
              ) : (
                <ScrollView style={st.sheetList} showsVerticalScrollIndicator={false}>
                  {past.map((legs, i) => (
                    <View key={legs[0].tripId ?? String(i)} style={st.pastTrip}>
                      {legs.map(l => (
                        <View key={l.id} style={st.pastRow}>
                          <View style={st.cardEdge} pointerEvents="none" />
                          <View style={st.legHead}>
                            <Text style={st.legNum}>{l.flightNumber}</Text>
                            <Text style={st.legRoute} numberOfLines={1}>
                              {`${l.from.iata} → ${l.to.iata}`}
                            </Text>
                            <Text style={st.pastDate}>{routeDateLabel(l.flightDate)}</Text>
                          </View>
                          <Text style={st.landed}>{'landed'}</Text>
                        </View>
                      ))}
                    </View>
                  ))}
                </ScrollView>
              )}
            </Sheet>
          )}
        </Pressable>
      </Modal>

      {/* THE BOTTOM PADDING RUNS THE LAST CONTENT UNDER THE FLOATING BAR, which
          is home's treatment and its reasoning: a blur with nothing behind it is
          a grey pill, and the material only reads as glass while something is
          moving underneath it. */}
      {/* flexGrow ON THE CONTENT CONTAINER, which is what lets the empty state
          centre itself vertically: a flex: 1 child can only fill space its
          parent actually has, and a scroll container sizes to its content
          unless told to fill the viewport. It changes nothing when there IS
          content -- there is no flexing child then, so everything sits at the
          top exactly as before. */}
      {/* THE BOTTOM CLEARANCE WAS REMOVED WHEN THE BAR BECAME NATIVE. It was
          home's insets.bottom + 24, for home's reason: the list ended under the
          glass so the blur had something behind it (R7, SPEC 16). Apple's bar
          insets the first scroll view itself. Add padding back only if a
          device shows the last row hidden; see home's fuller note. */}
      {/* THE MARKER, so UIKit watches THIS list rather than whatever its
          first-child walk happens to reach. flex: 1 keeps the scroll view
          bounded; the full reasoning is at the marker on home. */}
      <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={[st.scroll, st.scrollFill]}
        showsVerticalScrollIndicator={false}
        // THE HOME SCREEN'S OWN CONTROL, value for value -- the same green, the
        // same `refreshing` off the store, so the two screens pull identically.
        //
        // null FOR THE OPEN CARD ID. That parameter exists so the home screen can
        // be handed its open card's fresh payload back; this screen has no single
        // open card and reads the store instead, which refreshAll has already
        // written by the time it resolves.
        //
        // AND THE REPORT IS READ RATHER THAN DISCARDED. `void refreshAll(null)`
        // threw away a `throttled` the store had already computed, so a pull
        // inside the cooldown span the spinner and said nothing at all -- which
        // is exactly what a broken refresh looks like, and is why this was first
        // reported as the queue never reaching a leg.
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void (async () => {
              const r = await refreshAll(null);
              // THE SECONDS LEFT, because "up to date" alone is a claim about
              // the data and the true reason is the clock.
              if (r.throttled) {
                showToast(`just refreshed - try again in ${Math.ceil(r.cooldownMs / 1000)}s`);
              }
            })(); }}
            tintColor="#4ade80"
            colors={['#4ade80']}
          />
        }
      >
        <Text style={st.brand}>{'>_'}</Text>
        {/* THE TITLE AND THE ONE ACTION, ON ONE LINE. The plus is only here while
            there is a trip: on an empty screen the act is the subject and it
            takes the full button in the middle of the page instead. */}
        <View style={st.titleRow}>
          <Text style={st.title}>{'My Flights'}</Text>
          {current.length > 0 && headerAdd}
        </View>
        {/* HOME'S OWN CLOCK LINE, character for character: 15pt MONO at 0.4,
            3 under the title. It reads the tick this screen already keeps for
            the phases and the countdowns -- see `now` -- rather than starting a
            second one. */}
        <Text style={st.clock}>{formatClock(now)}</Text>

        {/* BACK TO current.length, because there is no `focus` to be null. It was
            written the other way to NARROW a maybe-null leg list for the branch
            below; the branch below now takes its list from a map or from
            current[0] behind its own length test, so there is nothing to narrow. */}
        {current.length === 0 ? (
          // ── NOTHING YET, AND IT IS THE CENTRE OF THE SCREEN ──
          //
          // THE SEARCH SCREEN'S OWN NO-RESULTS TREATMENT, character for
          // character: 20pt Inter REGULAR at 0.6 over 11pt Inter at 0.4, both
          // centred, on routeEmptyHead's 28 and routeEmptyBody's 18 line
          // heights. Not semibold -- an empty state that shouts reads as an
          // error, and this is not one. See routeEmptyWrap in app/search.tsx.
          //
          // flex: 1 RATHER THAN A MARGIN. The block takes everything the header
          // leaves and centres in it, so the copy sits on the optical centre of
          // the space it has at any screen height rather than at a guessed
          // offset from the title.
          <View style={st.emptyWrap}>
            <Text style={st.emptyHead}>{"Add the flight you're taking"}</Text>
            {addButton}
          </View>
        ) : (
          <>
            {/* ── THE TRIPS, AT THREE LEVELS OF ATTENTION WITHIN EACH ──
                tripsOf ordered them: a journey with a leg still to fly outranks
                one that is finished, and the earliest unflown departure breaks
                the tie. Every one of them opens out now; what varies is which
                folders are open.

                IT USED TO OPEN OUT EVERY LEG EQUALLY, and that was the mistake.
                A four-leg journey was four full cards, each with its own gate,
                belt, terminal and progress bar, all shouting at the same volume
                — so the leg the traveller was actually standing in an airport
                for looked exactly like the one six days away. A screen about
                where you ARE has to say where you are.

                THE DISTANCE FROM THE CURRENT LEG IS THE WHOLE RULE. Zero is
                the card; one either side is a row that can carry a belt;
                everything beyond is the same row without one. See
                currentLegIndex for what "current" means and why it is not a
                question about status, and CollapsedLeg for why the last two are
                one component rather than two.

                ONE EITHER SIDE RATHER THAN ONE AHEAD. The leg just flown is
                still live for as long as its bags are: showsBelt can only be
                true on a leg that has landed, and the row behind you is where
                that lands. */}
            {/* ── ONE THREAD, AND THE LEGS HANG OFF IT ──
                THE LINE IS A SIBLING OF THE COLUMN, not a border on it and not a
                segment inside each row. Absolutely positioned at top 0 bottom 0
                of this wrapper, it spans exactly the trip: it begins at the top
                edge of the first card and ends at the bottom edge of the last,
                because the wrapper's height IS the column's. A per-row segment
                would have to be stitched across every gap and would come apart
                at the first row that changed height.

                IT IS DRAWN FIRST so everything after it paints over it, which is
                what lets the layover's label break the line by simply having a
                background. See st.rail and st.layoverTime.

                THE MARGIN IS ON EACH LEG, NOT ON THE COLUMN. An absolutely
                positioned child is placed against its parent's PADDING box, so
                padding here would move the line along with the cards and leave
                no gutter at all. Insetting the legs individually leaves the
                column's own left edge at zero, which is where the line and the
                layover label both need to measure from. */}
            {/* ── ONE TRIP IS A TRIP; TWO ARE FOLDERS ──
                A SINGLE JOURNEY GETS NO HEADER, because there is nothing to
                tell it apart from. A folder answers "which of these am I
                looking at", and with one trip the question does not arise: a
                title over the only thing on the screen is chrome naming the
                screen.

                NOTHING SWAPS POSITION ANY MORE. One trip used to render as
                cards and every other as a single tappable line, and tapping
                promoted a trip to the top. Folders keep every journey where
                tripsOf put it and vary only what is VISIBLE, so opening one no
                longer moves another. tripOverride and chooseTrip went with
                that: they existed to decide which trip was drawn as cards, and
                now all of them are. */}
            {current.length === 1 ? (
              <View style={st.tripWrap}>
                <View style={st.rail} pointerEvents="none" />
                <View style={st.trip}>{renderLegs(current[0])}</View>
              </View>
            ) : FOLDER_STYLE === 'carousel' ? (
              /* ── C IS NOT A FOLDER MODEL, AND THIS IS THE FLAG ──
                 A HORIZONTAL STRIP CANNOT CONTAIN A TRIP THAT EXPANDS. A folder
                 holds its own legs and grows in place, which is what lets any
                 number be open and nothing move. Stubs scroll sideways in a fixed
                 height, so the legs have to render SOMEWHERE ELSE -- and the only
                 place is beneath the strip.

                 WHICH MAKES IT THE FOCUS MODEL AGAIN, in better clothes. One trip
                 is shown at a time, choosing a stub swaps what is underneath, and
                 the body's contents change while the strip stays put. It is
                 exactly what tripOverride and chooseTrip did before folders
                 replaced them; the stub row is a nicer picker for the same idea.

                 SO IT BREAKS TWO OF THE RULES THE OTHER TWO KEEP. Only one trip
                 can be open, and tapping does move something -- not the strip, but
                 everything below it. Nothing else in this file is affected: the
                 rail, the legs and the cards are the same, and the strip is
                 genuinely good at the one thing folders are bad at, which is
                 seeing six journeys at once.

                 IT IS BUILT SO IT CAN BE LOOKED AT rather than because it fits. If
                 it wins, the pinned model goes with it and that should be a
                 decision rather than a side effect. */
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={st.stubs}
                >
                  {current.map((legs, i) => (
                    <FolderHead
                      key={legs[0].tripId as string}
                      title={tripTitle(legs)}
                      count={legs.length}
                      date={tripDate(legs)}
                      tone={tripTone(legs, now)}
                      open={isOpen(legs)}
                      anim={STILL}
                      first={i === 0}
                      onToggle={() => toggleTrip(legs)}
                    />
                  ))}
                </ScrollView>
                {(() => {
                  // THE CHOSEN TRIP, OR THE FIRST. isOpen already defaults to
                  // current[0], so an untouched screen shows the journey being
                  // taken and a touched one shows whatever was picked.
                  const shown = current.find(legs => isOpen(legs)) ?? current[0];
                  return (
                    <View style={st.tripWrap}>
                      <View style={st.rail} pointerEvents="none" />
                      <View style={st.trip}>{renderLegs(shown)}</View>
                    </View>
                  );
                })()}
              </>
            ) : (
              <View style={FOLDER_STYLE === 'divider' ? st.divList : st.folders}>
                {current.map((legs, i) => (
                  <TripFolder
                    key={legs[0].tripId as string}
                    title={tripTitle(legs)}
                    count={legs.length}
                    date={tripDate(legs)}
                    tone={tripTone(legs, now)}
                    open={isOpen(legs)}
                    first={i === 0}
                    onToggle={() => toggleTrip(legs)}
                  >
                    {renderLegs(legs)}
                  </TripFolder>
                ))}
              </View>
            )}

          </>
        )}

        {/* The past-flights sheet is still mounted above and has no way in yet. */}

      </ScrollView>
      </ScrollViewMarker>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  // 20 either side, so the brand mark sits in the same column as home's and the
  // profile screen's.
  scroll: { paddingHorizontal: 20 },
  // See the note at the ScrollView.
  scrollFill: { flexGrow: 1 },
  brand: { fontFamily: MONO_BOLD, color: CD_GREEN, fontSize: 15 },
  // -- HOME'S GREETING, EXACTLY, AND THE FAMILY CHANGE IS THE POINT --
  //
  // SANS_SEMI RATHER THAN MONO, ASKED FOR DELIBERATELY AND AGAINST WHAT THE
  // PREVIOUS NOTE HERE ARGUED. That note said every screen's title is MONO and a
  // title is a label rather than a greeting. The decision went the other way:
  // these are WORDS SPOKEN TO A PERSON, the same as "Good evening, Jay", and the
  // app should read as one app rather than as a titled screen sitting next to a
  // greeted one. Mono is for machine data -- codes, clocks, flight numbers --
  // and "My Flights" is not one.
  //
  // marginTop 10, NOT 36, which is the greeting's own gap under the >_ mark.
  // Matching the treatment means matching the spacing; 36 was this screen's and
  // put the title half a screen below a mark it belongs to.
  // THE TITLE'S OWN ROW, so the add mark can sit at the far end of it. The
  // marginTop moved here from the title itself -- a row that positions its
  // children cannot also be positioned by one of them.
  titleRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginTop: 10,
  },
  title: { fontFamily: SANS_SEMI, fontSize: 24, color: '#e2e2e2' },
  // NO SURFACE AND NO PADDING. The full button is a card because it stands alone
  // on an empty page; this is a mark on a header line, and a fill behind it would
  // make the header look like it had a control bolted to it. The hit area comes
  // from hitSlop instead, so the target is comfortable without the glyph growing.
  headerAdd: { alignItems: 'center', justifyContent: 'center' },
  // index.tsx's clock line, character for character.
  clock: { fontFamily: MONO, fontSize: 15, color: 'rgba(226,226,226,0.4)', marginTop: 3 },

  // ── THE EMPTY STATE ──
  // routeEmptyWrap's own padding, so a wrapped line breaks well short of the
  // edges rather than running the full width.
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  // -- routeEmptyHead, ONE STEP LARGER, AND THE DIVERGENCE IS DELIBERATE --
  //
  // THE FAMILY, THE COLOUR AND THE CENTRING ARE THAT STYLE'S, UNCHANGED: Inter
  // regular at rgba(226,226,226,0.6), centred. What differs is the size, and the
  // reason is what the two lines ARE. routeEmptyHead is a RESULT standing in for
  // a list that came back empty -- it has a heading, controls and a whole screen
  // of context above it. This is the entire subject of a page with nothing else
  // on it but a button.
  //
  // 24 IS OFF THE 11/13/15/20 SCALE, and it is here for the same reason the
  // greeting on home is off it: it is the largest thing on its page. Said out
  // loud rather than left for someone to find.
  emptyHead: {
    fontFamily: SANS, fontSize: 24, color: 'rgba(226,226,226,0.6)',
    textAlign: 'center', lineHeight: 32,
  },

  // THE FOCUS TRIP. CARD_GAP between legs, which is the gap between any two
  // cards in this app.
  //
  // THE MARGIN MOVED UP TO tripWrap, so the thread's top: 0 is the top of the
  // first card rather than 20 points above it.
  tripWrap: { marginTop: 20 },
  trip: { gap: CARD_GAP },
  // ── THE FOLDERS ──
  //
  // 20 ON TOP IS tripWrap's OWN MARGIN, so a stack of folders begins where a
  // single bare trip would. CARD_GAP between them is the gap between any two
  // cards in this app, which is what a closed folder reduces to.
  folders: { marginTop: 20, gap: CARD_GAP },
  // ── THE LID, AS A SURFACE ──
  //
  // IT WAS BARE TEXT ON THE PAGE and read as a caption rather than as something
  // you press. It is a card now, in the app's own three constants: CARD_FILL,
  // CARD_RADIUS and cardEdge over it, which is what compactLeg, addBtn, importRow
  // and pastRow are all made of.
  //
  // CARD_FILL AND NOT SURFACE_2, WHICH IS WHAT THE PILLS TAKE, AND THE SCALE IS
  // WHY. lib/cards defines the levels by what is UNDERNEATH: SURFACE_1 is what
  // sits on the page, SURFACE_2 is what sits on a SURFACE_1. The badges are
  // SURFACE_2 because they are inside a card; this header is on the PAGE, so the
  // same RELATIONSHIP is SURFACE_1 even though the pills' literal value is a step
  // up. Using their value here would make a folder lid lighter than the cards it
  // contains, which inverts the hierarchy the scale exists to state.
  //
  // paddingVertical 10 MAKES THE TARGET, not hitSlop. The row is 20 points of
  // icon and 20 of padding, so 40 -- against 29 for the bare text it replaces,
  // and near enough the 44 a primary control wants.
  //
  // THE RAIL NO LONGER EMERGES FROM THE ICON, AND THAT IS THE COST OF THE
  // SURFACE. paddingLeft used to be 2 so the marker's centre landed on RAIL_X;
  // with 10 points of padding the icon sits at about 20 and the line at 6 comes
  // out from under the block's left edge instead. Moving RAIL_X to match would
  // leave two points of gutter before RAIL_INSET's 22 and put the cards on the
  // line. A solid lid with the thread dropping from beneath it still reads as one
  // object; alignment to the glyph mattered when there was nothing but a glyph.
  // ── A: THE FLIGHT STRIP ──
  //
  // NO paddingLeft AT ALL, AND RAIL_X IS BUILT ON THAT. The icon is the first
  // child and flush to the edge, so its centre is at 10 and the thread drops from
  // there. Any padding here moves the icon and the line stops meeting it.
  //
  // paddingVertical 12 MAKES THE TARGET. The row is 20 points of icon and 24 of
  // padding, so 44 -- which is the figure a primary control should have and the
  // first header on this screen to reach it.
  // STRIP_PAD ON THE LEFT AND NOTHING ON THE RIGHT, AND BOTH EDGES DEPEND ON IT.
  // The icon sits STRIP_PAD in, so its centre is STRIP_PAD + 10 -- which is what
  // RAIL_X is defined as, so the thread meets it by construction rather than by
  // two numbers somebody has to keep equal. The date block stays flush right so
  // its accent border ends where the card does. overflow hidden makes both
  // corners follow the radius instead of squaring it.
  //
  // THE HEIGHT COMES FROM THE DATE BLOCK, which carries the only vertical padding
  // in the row -- two stacked lines and 8 either side, about 49 points. Well past
  // the 44 a control should have, and the icon and route centre against it.
  stripHead: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    paddingLeft: STRIP_PAD,
    overflow: 'hidden',
  },
  // NO flex. The route sits against the icon rather than stretching, which is what
  // keeps the two together and lets the spacer do the pushing.
  stripRoute: { fontFamily: MONO_BOLD, fontSize: 15, color: '#ffffff' },
  // THE ONE THING THAT STRETCHES, and it holds nothing. A flex on the ROUTE would
  // have done the same job and would also have let a long route truncate itself
  // into the date; an empty spacer takes the slack without ever being the thing
  // that gives.
  stripSpace: { flex: 1 },
  // 44 WIDE, WHICH IS THE ONE MEASUREMENT HERE THAT IS NOT ARBITRARY: "SEP" is
  // three characters of 11pt mono at 6.6, so 19.8, and 44 leaves twelve either
  // side of it.
  //
  // THE BORDER IS ON THE RIGHT and the block is the last child, so those two
  // points of colour are the card's own right edge.
  //
  // NEUTRAL IS THE DEFAULT AND IT IS THE PAGE'S RULE GREY, not a fourth tone.
  // Nothing to compare means nothing is claimed -- see tripTone, which returns
  // null rather than guessing, and never green on an unknown.
  stripDate: {
    width: 44, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8,
    borderRightWidth: 2, borderRightColor: 'rgba(255,255,255,0.06)',
    backgroundColor: SURFACE_2,
  },
  // COLOUR ONLY, BOTH OF THEM, so the block does not change size when a delay
  // lands. CD_LATE and CD_GREEN are the pair the card's own clock takes; one
  // definition of each, read rather than respelled.
  stripDateLate: { borderRightColor: CD_LATE },
  stripDateOnTime: { borderRightColor: CD_GREEN },
  stripDay: { fontFamily: MONO_BOLD, fontSize: 15, color: '#ffffff' },
  stripMon: { fontFamily: MONO, fontSize: 10, color: DIM, marginTop: 1 },
  // KEPT FOR THE CAROUSEL, which still shows a count in its stubs. The strip's own
  // badge went with the count -- see the header.
  stripCountText: { fontFamily: MONO, fontSize: 11, color: DIM },

  // ── B: NO CONTAINER ──
  //
  // THE LIST HAS NO GAP. The rule between items is the separation, and a gap on
  // top of it would put the line in the middle of the space rather than between
  // two rows.
  divList: { marginTop: 20 },
  divHead: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12,
  },
  // THE CARDS' OWN RULE COLOUR, which airportRule and tripRule already take.
  divRule: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' },
  divText: { flex: 1, gap: 2 },
  divDate: { fontFamily: SANS, fontSize: 11, color: DIM, letterSpacing: 1 },
  divRoute: { fontFamily: MONO_BOLD, fontSize: 17, color: '#ffffff' },
  divPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: SURFACE_1, borderRadius: 6,
    paddingLeft: 8, paddingRight: 5, paddingVertical: 4,
  },
  divPillText: { fontFamily: MONO, fontSize: 11, color: DIM },

  // ── C: THE STUBS ──
  //
  // 170 WIDE, WHICH FITS THE LONGEST THING IN THEM: "SAT 5 SEP" is 49.8 at 11pt
  // Inter and the route is 70.2 at 13pt mono bold, so the padding is what decides
  // it rather than the text.
  //
  // paddingRight 20 ON THE ROW so the last stub does not sit against the screen
  // edge, and paddingLeft 0 so the first lines up with everything above it.
  stubs: { gap: CARD_GAP, paddingRight: 20, paddingVertical: 20 },
  stub: {
    width: 170, gap: 6,
    backgroundColor: CARD_FILL, borderRadius: CARD_RADIUS,
    padding: 12,
  },
  // THE CHOSEN ONE IS A STEP UP THE SCALE, not a new colour and not an outline.
  // SURFACE_2 on a page is one level too high by the scale's own reckoning -- but
  // a stub that is SELECTED is being lifted toward the body it controls, which is
  // the one case where skipping a level says something true.
  stubOn: { backgroundColor: SURFACE_2 },
  stubDate: { fontFamily: SANS, fontSize: 11, color: DIM, letterSpacing: 1 },
  stubRoute: { fontFamily: MONO_BOLD, fontSize: 15, color: '#ffffff' },
  stubCount: {
    alignSelf: 'flex-start',
    backgroundColor: SURFACE_2, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  // A FIXED BOX FOR TWO STACKED LAYERS. Both shapes are absolutely positioned
  // inside it, so it has to carry the size itself -- 20 to match every other Svg
  // this app draws.
  folderIcon: { width: 20, height: 20 },
  // folderName AND folderCount WENT WITH THE ONE HEADER THEY DRESSED. Each
  // variant carries its own type now -- see stripRoute, divRoute and stubRoute.
  // overflow hidden IS THE CLIP AND IT IS ALWAYS ON. The height animates to zero
  // and the content inside keeps its full layout -- which is what lets onLayout
  // report a real height while the folder is shut.
  // ── THE CLIP, AND NOTHING ELSE ──
  //
  // NO PADDING HERE ANY MORE, AND THAT IS THE SECOND HALF OF THE SPACING FIX. It
  // was on this element and it widened the SHUT rows: a closed folder is
  // height: 0, and sixteen points of padding on a zero-height box still took
  // sixteen points of the list. Two shut headers ended up twenty-four apart where
  // every other pair of cards in this app is eight.
  //
  // IT LIVES ON THE INNER VIEW NOW -- see folderInner -- which is rendered only
  // while the folder is open or closing. A shut folder has no inner view at all,
  // so there is nothing left to contribute a single point.
  //
  // AND THE MEASUREMENT IMPROVES WITH IT. `h` is onLayout on that same inner view,
  // so the padding is now part of the height being animated rather than a constant
  // added outside it; the collapse travels the distance it actually covers.
  folderBody: { overflow: 'hidden' },
  // ── THE FOLDER'S OWN BREATHING ROOM, TOP AND BOTTOM ──
  //
  // IT WAS NEVER AN OVERLAP. A diagnostic background answered in one screenshot
  // what two rounds of reasoning got wrong: the box starts exactly where the
  // header ends and finishes exactly where the cards do. The container was right
  // the whole time and there was simply NO GAP -- the first card sat flush against
  // the underside of its own header, which reads as a card overlapping the chrome
  // above it.
  //
  // CARD_GAP BOTH WAYS, which is the gap between any two cards in this app. With
  // the list's own CARD_GAP as well, an open folder's last card clears the next
  // header by sixteen points; two shut folders are eight apart, as they were.
  folderInner: { paddingVertical: CARD_GAP },
  // THE THREAD. One pixel in the gutter, in DIM -- the same tone the duration
  // written on it takes, because the line and the label are one element. See
  // RAIL_X and RAIL_INSET for why the numbers are constants rather than literals.
  rail: {
    position: 'absolute',
    left: RAIL_X, top: 0, bottom: 0,
    width: RAIL_W,
    backgroundColor: DIM,
  },
  // INSIDE A FOLDER THE TAIL IS PULLED UP BY THE PADDING IT WOULD OTHERWISE RUN.
  // The head is left at 0 on purpose: that is what puts it against the header.
  railFolder: { bottom: CARD_GAP },
  legSlot: { marginLeft: RAIL_INSET },
  // ── THE WAIT, WRITTEN ON THE THREAD ──
  //
  // NO SURFACE AND NO INSET OF ITS OWN: the row starts at the column's left
  // edge, which is where the line is, and the label's own padding is what
  // carries its text across to the cards' margin.
  layover: { flexDirection: 'row', alignItems: 'center' },
  // PAGE_BG BEHIND IT IS THE WHOLE TRICK. The line is drawn first and this is
  // drawn over it, so the background punches a hole in the thread exactly as
  // wide as the words -- which is what makes the duration read as being ON the
  // line rather than beside it.
  //
  // paddingLeft: RAIL_INSET puts the text's own left edge level with the cards
  // above and below, while the background still reaches back over RAIL_X.
  layoverTime: {
    fontFamily: MONO_BOLD, fontSize: 13, color: DIM,
    backgroundColor: PAGE_BG,
    paddingLeft: RAIL_INSET, paddingRight: 8, paddingVertical: 2,
  },
  legHead: { flexDirection: 'row', alignItems: 'center' },
  legNum: { fontFamily: MONO_BOLD, fontSize: 13, color: '#ffffff' },
  // flex so it takes the middle and pushes the remove control to the edge.
  legRoute: {
    fontFamily: MONO, fontSize: 13, color: 'rgba(226,226,226,0.6)',
    flex: 1, marginLeft: 12,
  },

  // ── THE HAIRLINE, AS A SIBLING ──
  //
  // g.sheetEdge's PATTERN, not a border on the surface itself, and lib/glass.tsx
  // states why at SHEET_EDGE: React Native draws a border from the layer's own
  // radius as one unbroken rounded rectangle ONLY while all four sides share a
  // colour, and a border on the surface would also inset its content box by 1pt
  // on every side. An absolutely positioned sibling at the same radius costs no
  // layout and cannot split a corner arc.
  //
  // WHY THE SURFACE NEEDED ONE AT ALL: at 4.5% white on a near-black page a fill
  // alone barely registers, which is what made these read as text on the page
  // rather than as cards. One pixel of 10% white is what turns a tint into a
  // shape. See the elevation scale in lib/cards.ts.
  //
  // ONE ENTRY, FOUR SURFACES. compactLeg, addBtn, importRow and pastRow are all
  // a card on the page at CARD_RADIUS, so they take one edge rather than four
  // identical ones.
  cardEdge: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 1, borderColor: SURFACE_EDGE, borderRadius: CARD_RADIUS,
  },

  // ── THE LEG BESIDE THE CURRENT ONE ──
  //
  // importRow AND pastRow'S SURFACE, through the same three constants and no
  // new ones. The gap is 6 rather than those rows' own, because the only thing
  // that can sit under the first line here is a single belt.
  compactLeg: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 6,
  },
  // ── THE ROW'S INTERIOR, WHICH IS THE CARD'S GRID ──
  //
  // EVERY ENTRY BELOW IS components/FlightCard.tsx's, matched value for value so
  // that scanning down the trip the left column stays a left column and the
  // right stays a right one. The card's names are in brackets; nothing here is
  // a new number or a new colour. See the note at CollapsedLeg for why the rule
  // and the tile row are deliberately NOT among them.
  //
  // WHAT WENT: compactClock and compactClockFlown, which put a departure time at
  // the end of the head line -- the right column carries it now, under the
  // route; and nearRow, nearFact, nearFacts, factRow, factLabel and factValue,
  // which were the near leg's flush-left detail block and the label-and-value
  // pair it shared with the belt. All six are replaced by legTimeRow and its
  // two texts, which are the card's own pairing rather than a smaller one.
  legSplit: { flexDirection: 'row' },                                    // airportSplit
  legIdent: { gap: 3 },                                                  // airportIdent
  // 20 white with 7 under it: the date frames the number and the airline rather
  // than joining them, and better than three times their own gap is what says
  // so. airportDate's own arithmetic, unchanged.
  legDate: { fontFamily: MONO_BOLD, fontSize: 20, color: '#ffffff', marginBottom: 7 },
  legIdentNum: { fontFamily: MONO, fontSize: 13, color: DIM },           // airportIdentNum
  legIdentName: { fontFamily: SANS, fontSize: 13, color: DIM },          // airportIdentName
  // The remainder of the row, held off the identity column by 12 and off the
  // card's own padding by 8. flex-end right-aligns the boxes; the textAlign on
  // the two styles below right-aligns the lines inside them, and both are needed
  // -- without the first a single-line label sits left in a full-width column.
  // airportMovements composed with airportTimes' gap of 12.
  legTimes: { flex: 1, paddingLeft: 12, paddingRight: 8, alignItems: 'flex-end', gap: 12 },
  legTimeRow: { gap: 3, alignItems: 'flex-end', alignSelf: 'stretch' },  // airportTimeRow
  legTimeLabel: { fontFamily: SANS, fontSize: 11, color: DIM, textAlign: 'right' },
  // ALSO THE ROUTE'S STYLE, which is not a shortcut: the route is the value at
  // the head of this column and takes the column's value treatment. One entry
  // rather than two identical ones.
  legTimeValue: { fontFamily: MONO_BOLD, fontSize: 15, color: '#ffffff', textAlign: 'right' },
  // COLOUR ONLY, so the 15, the mono bold and the right alignment all still come
  // from legTimeValue above and the row cannot change size when a countdown
  // lands. It is composed on top rather than forked because every other value in
  // this column -- the route, the departure clock, the belt -- stays white, and
  // only the interval is live.
  //
  // CD_GREEN IS THE FLIGHT CARD'S OWN CONSTANT, imported rather than respelled:
  // tripCountdown over there is the same colour on the same figure from the same
  // countdown() call, and one hex written twice is how the row and the card it
  // collapses into come to disagree.
  legCountdown: { color: CD_GREEN },

  // ── THE OTHER TRIPS ──
  // gap 4 RATHER THAN 8, because the rows carry 8 of their own padding now and
  // the space between two lines of text is what the eye reads -- 4 of gap plus 16
  // of facing padding is the 20 that 8 alone used to be, near enough.
  // others AND otherLine WENT WITH THE FLAT LIST. Every trip is a folder now and
  // there is no second, quieter way of rendering one.

  // ── THE ONE ADD CONTROL ──
  //
  // CONTENT-SIZED AND CENTRED, not a full-width row. A button as wide as the
  // screen reads as a list item; this is a single act and should look like one.
  // 10 between the glyph and the word, the same gutter the card's menu row
  // leaves around its own icon.
  // PRESENT RATHER THAN A ROW. At 12 and 16 with a 15pt label this read as a
  // list item that happened to be centred; the padding, the glyph and the gap
  // above it are what make it the one act on the screen.
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'center',
    marginTop: 32,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  addLabel: { fontFamily: SANS, fontSize: 15, color: '#e2e2e2' },

  // ── THE MENU ──
  // The card's long-press menu exactly: centred so it is as wide as its longest
  // row rather than the full width the scrim would give it, with a floor so two
  // short rows do not make a stub.
  menu: { alignSelf: 'center', minWidth: 220 },
  // Tighter than g.sheetBody's 20, which is sized for a head and four groups.
  menuBody: { padding: 16, gap: 12 },
  menuRow: { paddingVertical: 4 },
  menuLabel: { fontFamily: SANS, fontSize: 15, color: '#e2e2e2' },

  // ── THE SHEETS ──
  // A floor and a ceiling, exactly as the archive sheet carries: more than half
  // the screen whatever is in it, and never so tall the scrim disappears.
  sheet: { minHeight: '62%', maxHeight: '82%' },
  sheetEmpty: {
    fontFamily: SANS, fontSize: 11, color: DIM,
    textAlign: 'center', lineHeight: 18, paddingVertical: 12,
  },
  // Negative margin then equal padding, so a row runs the full width of the
  // sheet while its text lines up with the head above it. flex: 1 completes the
  // chain from sheetBodyFill and is what gives the list a height to scroll in.
  sheetList: { marginHorizontal: -20, paddingHorizontal: 20, flex: 1 },
  importRow: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    marginBottom: CARD_GAP,
    gap: 6,
  },
  pastTrip: { marginBottom: CARD_GAP, gap: 2 },
  pastRow: {
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    padding: CARD_PAD,
    gap: 4,
  },
  pastDate: { fontFamily: MONO_BOLD, fontSize: 11, color: 'rgba(226,226,226,0.6)', marginLeft: 8 },
  // getStatusColor('landed'), and the same 11pt mono StatusLine renders at.
  landed: { fontFamily: MONO, fontSize: 11, color: LANDED_GREY },
});
