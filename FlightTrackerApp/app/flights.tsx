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
import { useState, useEffect, useMemo, useRef, Fragment, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TouchableOpacity,
  Modal, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import {
  SavedFlight, savedFlightFromApi, ISO_DAY_RE, MAX_MAP_ROUTES,
} from '../lib/storage';
// THE STORE AND ITS RULES. tripsOf, isOwned and isArchived are pure functions of
// a list and a clock; the two callbacks are the only things here that write.
import {
  useSaved,
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
  departureTs,
  OWN_MSG,
} from '../lib/saved';
// WHICH ROUTES ARE DRAWN, and the one conversion that builds a route from a
// record. mapRouteFor is imported rather than restated: its own note says the
// departureTs/arrivalTs conversion must never be done twice by two pieces of
// code, and a second copy here would break that on the first read.
import { useMapRoutes } from '../lib/maproutes';
import { mapRouteFor } from '../lib/flightcard';
// THE ORIGIN'S OWN WALL CLOCK, as text. clock24 rather than clockInZone or a
// Date: the stored *_iso carries the departure airport's local digits already,
// so this is a read rather than a conversion. See the note at the top of
// lib/time.ts for why the two must never be confused.
import { clock24 } from '../lib/time';
// THE COUNTRY OF AN AIRPORT, which is the only thing this screen asks of the
// dataset. airportByCode is the accessor; the rows are not exported and must
// not be. See showsBelt.
import { airportByCode } from '../lib/airports';
// formatClock IS HOME'S HEADER LINE, and it is imported rather than restated
// because this screen now wears the same header. See the note where it lives.
import { StatusLine, routeDateLabel, formatClock, CD_GREEN } from '../lib/flightstatus';
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, PAGE_BG, SURFACE_EDGE } from '../lib/cards';
import {
  GlassLayers, g,
  EASE_OUT, EASE_IN, CAL_RISE,
  CAL_IN_MS, CAL_OUT_MS, SCRIM_IN_MS, SCRIM_OUT_MS,
  // THE SMALL PANEL'S OWN MOTION. A menu is not a sheet: it travels less and
  // arrives quicker. See Menu.
  OVERLAY_RISE, PANEL_IN_MS, PANEL_OUT_MS,
} from '../lib/glass';
import { useToast } from '../lib/toast';
// THE APP'S ONE HAPTIC. components/swipe fires it when a full swipe arms and
// when a long press becomes a menu -- both moments where a gesture turns into an
// offer. Opening this menu is the same kind of moment, and a second weight for
// it would be a second vocabulary.
import { EXPAND_HAPTIC } from '../components/swipe';
// THE CARD ITSELF, one per leg, and the adapter that builds one from a stored
// record. flightDataFromSaved is what the map's own card already uses -- see the
// note there: every RULE it needs is exported and it is field mapping alone.
// hasTime IS THE APP'S ONE READING OF "IS THIS A REAL VALUE": not null, not
// blank, and not the "N/A" the backend writes for a field it has nothing for.
// The near leg shows nothing where a field is absent, and this is what decides
// absent. Imported rather than restated -- its own note calls itself the file's
// only implementation, and a second one here would be the same rule twice.
// movementTimeCell IS THE CARD'S OWN CHOICE OF WHICH TIME TO SHOW and what to
// call it: actual, then estimate, then the schedule, labelled accordingly. The
// next leg's row prints a departure and the card prints the same departure, so
// they take the same function -- a second precedence here would be the row and
// the card disagreeing about one flight on one screen.
import { FlightCard, flightDataFromSaved, hasTime, movementTimeCell } from '../components/FlightCard';

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
const RAIL_X = 6;
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

// UNDER A DAY THE FIRST LEG IS THE THING YOU ARE DOING. That is the window in
// which a trip stops being a plan and becomes a journey: bags get packed, a taxi
// gets booked, the gate gets assigned. Opening the card earlier would put a
// full-height surface on the screen for a flight there is nothing to do about.
const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
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

// WHICH LEG OPENS, BY THE JOURNEY'S OWN RECKONING, or -1 for none.
//
// TWO RULES, AND THE FIRST ONE WINS. A leg whose PREVIOUS leg has landed is the
// one the traveller has arrived for, whatever the clock says -- that is the
// handover from one flight to the next and it is a fact rather than a threshold.
// Only when no such leg exists does the window apply, and it applies to the
// FIRST leg alone: a middle leg does not open early just because its departure
// is near, because the leg before it has not put the traveller there yet.
//
// -1 IS A REAL ANSWER. A trip five days out has no open card at all, and neither
// does one whose every leg has landed. Both are correct: there is nothing to be
// at an airport for, and a screen that always opens something would be opening
// it for the sake of the layout.
function currentLegIndex(legs: SavedFlight[], now: number): number {
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].landedAt === null && legs[i - 1].landedAt !== null) return i;
  }
  if (legs.length > 0 && legs[0].landedAt === null) {
    const t = departureTs(legs[0]);
    if (t !== null && t - now < CURRENT_WINDOW_MS) return 0;
  }
  return -1;
}

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
function legState(leg: SavedFlight, i: number, openIdx: number, nextIdx: number): LegState {
  if (i === openIdx) return 'current';
  if (leg.landedAt !== null) return 'landed';
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
// AN HOUR AFTER LANDING. The belt is the one fact on a finished leg that is
// still actionable, and it stops being actionable once the bags are off it.
const BAG_WINDOW_MS = 60 * 60 * 1000;
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
  if (now - leg.landedAt >= BAG_WINDOW_MS) return false;
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

  // ONLY THE NEXT LEG PRINTS A CLOCK. Further out it would be a timetable entry
  // quoted as though it were settled; the countdown says the same thing without
  // claiming a precision the provider has not committed to. See NEXT_WINDOW_MS.
  const depCell = state === 'next'
    ? movementTimeCell(
        clock24(leg.from.actualIso, leg.from.actual),
        clock24(leg.from.estimatedIso, leg.from.estimated),
        clock24(leg.from.scheduledIso, leg.from.scheduled),
        true,
      )
    : null;

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
          {depCell !== null && hasTime(depCell.value) && (
            <View style={st.legTimeRow}>
              <Text style={st.legTimeLabel}>{depCell.label}</Text>
              <Text style={st.legTimeValue}>{depCell.value}</Text>
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

export default function Flights() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { savedFlights, ownFlight, disownFlight, refreshOne } = useSaved();
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

  // ── AND WHICH TRIP, WHICH IS A SEPARATE DECISION AT A SEPARATE LEVEL ──────
  //
  // A SECOND STATE AND NOT A SECOND MEANING FOR focusOverride, which is per-LEG:
  // it holds a leg id, it is looked up inside the focus trip's own leg list, and
  // its clearing effect asks whether that leg is still showing. "Which leg is
  // open" and "which trip is open" are different questions one level apart, and
  // one state answering both would make that effect ambiguous about which
  // decision it was discarding.
  //
  // A tripId, NOT AN INDEX INTO current, for exactly the reason focusOverride is
  // an id rather than an index: tripsOf re-sorts as legs fly -- a trip whose last
  // leg lands drops to rank 1 and moves -- so a stored index would silently come
  // to name a different journey.
  //
  // NULL IS THE ORDINARY STATE AND MEANS "FOLLOW THE ORDERING". tripsOf puts the
  // journey with the earliest leg still to fly first, which is almost always the
  // one being taken; this is the user saying otherwise.
  //
  // IT DOES NOT SURVIVE A RELAUNCH, AND THAT IS THE DECISION RATHER THAN AN
  // OMISSION. A persisted override would open a trip glanced at last week with
  // nothing on screen saying an override existed or how to clear it -- silently
  // wrong, and self-perpetuating. Resetting means every launch starts by
  // following the journey, which is what currentLegIndex and nextLegIndex are
  // built around. It also keeps one lifetime for one idea: focusOverride is
  // in-memory and this is the same idea one level up.
  const [tripOverride, setTripOverride] = useState<string | null>(null);

  // THE TRIP THE SCREEN IS OPENED ON. current[0] unless the user has said
  // otherwise and the trip they named is still showing.
  //
  // A MISS FALLS THROUGH TO current[0] HERE rather than waiting for the effect
  // below to clear the override, so the render is already correct on the frame
  // the trip stops existing. Same shape as openIdx.
  //
  // NULL WHEN THERE IS NOTHING, which the render already gates on.
  const focus = useMemo(() => {
    if (current.length === 0) return null;
    if (tripOverride !== null) {
      const t = current.find(legs => legs[0].tripId === tripOverride);
      if (t !== undefined) return t;
    }
    return current[0];
  }, [current, tripOverride]);

  // EVERY TRIP THAT IS NOT THE ONE OPEN, AND IT IS NO LONGER slice(1). The focus
  // can sit anywhere in the ordering now, so the others are whatever is left
  // after it is taken out -- by identity, since these are the very arrays `focus`
  // was chosen from.
  const others = useMemo(
    () => current.filter(legs => legs !== focus),
    [current, focus],
  );

  // AND THE OVERRIDE IS DROPPED WHEN THE TRIP IT NAMES STOPS SHOWING -- every leg
  // archived, or the last one disowned. The memo above already falls through, so
  // this only tidies; it is here for the same reason its sibling below is, which
  // is that a render must not write state.
  useEffect(() => {
    if (tripOverride === null) return;
    if (!current.some(legs => legs[0].tripId === tripOverride)) setTripOverride(null);
  }, [current, tripOverride]);

  // WHERE THE FOCUS TRIP'S ATTENTION SITS, and it is asked once rather than
  // inside a map. `focus` is the journey being shown -- tripsOf ordered them and
  // the user may have overruled that -- and every leg's state is measured
  // against it.
  //
  // AN INDEX, because NEXT is the leg after this one and "after" is a position.
  // It was an id while the states were decided per leg from the clock; now that
  // one of them is defined relative to another, the list order is the thing both
  // questions are asked of.
  //
  // THE OVERRIDE ONLY WINS WHILE IT NAMES A LEG THAT IS SHOWING. A miss falls
  // through to currentLegIndex here rather than waiting for the effect below to
  // clear it, so the render is already correct on the frame the trip changes.
  //
  // -1 WHEN NOTHING OPENS, which is an ordinary outcome rather than an empty-list
  // guard: a trip more than a day out opens no card at all. See currentLegIndex.
  //
  // `now` IS A DEPENDENCY, because the window is a clock reading. It moves once a
  // minute, which is exactly how often the answer can change.
  const openIdx = useMemo(() => {
    if (focus === null) return -1;
    const legs = focus;
    if (focusOverride !== null) {
      const i = legs.findIndex(l => l.id === focusOverride);
      if (i >= 0) return i;
    }
    return currentLegIndex(legs, now);
  }, [focus, focusOverride, now]);

  // AND THE ONE AFTER IT, WHICH IS THE ONLY LEG THAT MAY BE NEXT. Derived from
  // openIdx rather than computed alongside it, so the two cannot disagree about
  // which leg is open. See nextLegIndex.
  const nextIdx = useMemo(
    () => (focus === null ? -1 : nextLegIndex(focus, now, openIdx)),
    [focus, now, openIdx],
  );

  // AND IT IS DROPPED WHEN IT STOPS MEANING ANYTHING. The trip can change under
  // it: a leg is removed, the whole journey finishes and leaves `current`, or
  // tripsOf puts a different trip first. Holding an id that names nothing on
  // screen would pin the screen to a leg the user cannot see, and the next trip
  // to contain that id would inherit somebody else's decision.
  //
  // IN AN EFFECT RATHER THAN IN THE MEMO ABOVE, because a render must not write
  // state. The memo already falls through, so this only tidies up.
  useEffect(() => {
    if (focusOverride === null) return;
    const showing = focus !== null && focus.some(l => l.id === focusOverride);
    if (!showing) setFocusOverride(null);
  }, [focus, focusOverride]);

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

  // ── AND TAPPING ANOTHER TRIP OPENS IT ─────────────────────────────────────
  //
  // openLeg's SHAPE ONE LEVEL UP, INCLUDING THE HALF THAT LOOKS REDUNDANT.
  // Choosing the trip the ordering would have chosen anyway sets the override to
  // NULL rather than to that trip's own id: the two would look identical on the
  // frame they happen and are different states afterwards, because an override
  // pinned to the natural choice stops the screen following. When that journey
  // finishes and tripsOf promotes the next one, a pinned id would hold the screen
  // on the trip behind it.
  //
  // AND IT CLEARS THE LEG OVERRIDE IN THE SAME BREATH. A leg id from the trip
  // being left cannot be found in the trip being opened, so openIdx would fall
  // through to currentLegIndex and the effect would tidy up a render later --
  // correct either way. It is stated here rather than relied upon because a
  // fall-through that is load-bearing is a fall-through somebody later simplifies
  // away.
  const chooseTrip = (legs: SavedFlight[]) => {
    setFocusOverride(null);
    setTripOverride(current.length > 0 && current[0] === legs
      ? null
      : legs[0].tripId);
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
      <ScrollView
        contentContainerStyle={[st.scroll, st.scrollFill, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={st.brand}>{'>_'}</Text>
        {/* THE TITLE AND THE ONE ACTION, ON ONE LINE. The plus is only here while
            there is a trip: on an empty screen the act is the subject and it
            takes the full button in the middle of the page instead. */}
        <View style={st.titleRow}>
          <Text style={st.title}>{'My Flights'}</Text>
          {focus !== null && headerAdd}
        </View>
        {/* HOME'S OWN CLOCK LINE, character for character: 15pt MONO at 0.4,
            3 under the title. It reads the tick this screen already keeps for
            the phases and the countdowns -- see `now` -- rather than starting a
            second one. */}
        <Text style={st.clock}>{formatClock(now)}</Text>

        {/* focus === null RATHER THAN current.length === 0, and the two are the
            same condition -- focus is null exactly when there is no trip to show.
            Written this way it also NARROWS: everything in the other branch reads
            `focus` as a leg list rather than as a maybe-null, so the render needs
            no assertions of its own. */}
        {focus === null ? (
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
            {/* ── THE FOCUS TRIP, AT THREE LEVELS OF ATTENTION ──
                `focus` is the journey with the earliest leg still to fly —
                tripsOf decided that — or whichever one the user has tapped, and
                it is the only one this screen opens out.

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
            <View style={st.tripWrap}>
              <View style={st.rail} pointerEvents="none" />
              <View style={st.trip}>
              {focus.map((leg, i) => {
                // ONE ANSWER PER LEG, ASKED ONCE. legState reads the two
                // indices and the landing; nothing below re-derives any of them,
                // and no clock is consulted here at all -- both windows were
                // spent deciding openIdx and nextIdx above.
                //
                // showsBelt IS ASKED UNCONDITIONALLY AND NEEDS NO STATE GUARD:
                // its own first two conditions are a belt number and a landing,
                // so it is already false on every state but landed. Gating it
                // here would be the same rule written twice.
                const state = legState(leg, i, openIdx, nextIdx);
                const card = state !== 'current' ? (
                    <CollapsedLeg
                      leg={leg}
                      state={state}
                      belt={showsBelt(focus, i, now)}
                      now={now}
                      onPress={() => openLeg(focus, leg)}
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
                  bagsClaimedHere={bagEligible(focus, i)}
                  // WHERE THIS LEG SITS IN THE JOURNEY, and both numbers were
                  // already here -- `i` is the map index and `focus` is the
                  // ordered leg list bagEligible above is reading. Nothing is
                  // derived and no trip model crosses the boundary; the card
                  // gets a position and a total, which is all a header tag is.
                  //
                  // legsOfTrip SORTED THEM BY DEPARTURE INSTANT before any of
                  // this saw them, so "leg 2 of 4" means the second flight taken
                  // rather than the second record stored.
                  legIndex={i}
                  legCount={focus.length}
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
                    {i < focus.length - 1 && (
                      <Layover prev={leg} next={focus[i + 1]} />
                    )}
                  </Fragment>
                );
              })}
              </View>
            </View>

            {/* EVERY OTHER TRIP, AS ONE LINE, AND EACH ONE OPENS. They were
                inert, and the note here said a tap that swapped the focus was a
                decision this screen had not been asked to make. It has been now.

                NOT slice(1) ANY MORE. The focus can sit anywhere in tripsOf's
                ordering once the user has overruled it, so these are whatever is
                left after it is removed -- see `others`.

                THE DIM ON PRESS IS THE WHOLE AFFORDANCE, at the same 0.7 every
                other surface in this app uses, and there is no chevron: the route
                card's own note makes the argument, and a marker here would be
                chrome on a line that is one line precisely because it is not the
                subject.

                THE ROW IS PADDED RATHER THAN hitSlop'd. At 11pt the text is about
                14 points tall, which is not a target; 8 above and below makes 30,
                and padding does it without the overlapping touch regions hitSlop
                would create against an 8pt gap. It is still under the 44 a
                primary control should have -- accepted, because the same journey
                is reachable by scrolling and this is the secondary way in. */}
            {others.length > 0 && (
              <View style={st.others}>
                {others.map((legs, i) => (
                  <TouchableOpacity
                    key={legs[0].tripId ?? String(i)}
                    activeOpacity={0.7}
                    onPress={() => chooseTrip(legs)}
                    accessibilityRole="button"
                    accessibilityLabel={`open ${legs[0].from.iata} to ${legs[legs.length - 1].to.iata}`}
                  >
                    <Text style={st.otherLine} numberOfLines={1}>
                      {`${legs[0].flightNumber}  ${legs[0].from.iata} → ${legs[legs.length - 1].to.iata}  ${routeDateLabel(legs[0].flightDate)}`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

          </>
        )}

        {/* The past-flights sheet is still mounted above and has no way in yet. */}

      </ScrollView>
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
  // THE THREAD. One pixel in the gutter, in DIM -- the same tone the duration
  // written on it takes, because the line and the label are one element. See
  // RAIL_X and RAIL_INSET for why the numbers are constants rather than literals.
  rail: {
    position: 'absolute',
    left: RAIL_X, top: 0, bottom: 0,
    width: RAIL_W,
    backgroundColor: DIM,
  },
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
  others: { marginTop: 20, gap: 4 },
  // paddingVertical 8 IS THE TOUCH TARGET. See the note at the rows: 14pt of text
  // and 16 of padding is 30, which is what a secondary control gets here.
  otherLine: {
    fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.5)',
    paddingVertical: 8,
  },

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
