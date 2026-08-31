import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, AccessibilityInfo, Keyboard, Platform,
  useWindowDimensions, type LayoutChangeEvent,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, G, Defs, Mask, Rect } from 'react-native-svg';
import { BlurView } from 'expo-blur';
import {
  GlassView, GlassContainer, isLiquidGlassAvailable, isGlassEffectAPIAvailable,
} from 'expo-glass-effect';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  useAnimatedStyle, useAnimatedProps, useSharedValue, withSpring, withTiming, withDelay, runOnJS,
  interpolateColor, type SharedValue,
} from 'react-native-reanimated';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
// SHEET_EDGE ONLY NOW. Every surface in the bar draws the same flat hairline in
// the colour the rest of the app draws its edges in, and that is the one thing
// still worth sharing. SHEET_RADIUS came out with the full field's corners: 16
// is a SHEET's radius and the field is a capsule, so it takes half its own
// height instead. lib/glass.tsx is untouched and still owns the 16 for sheets.
import { SHEET_EDGE } from '../lib/glass';

// Declared here rather than imported from a screen, for the same reason
// profile.tsx declares its own: a component reaching into a route for a string
// constant would couple the two. The value is the family name _layout registers.
const MONO = 'JetBrainsMono_400Regular';

// THE TYPE SIZE, AND IT IS THE ROOT OF TWO OTHERS. 10, DOWN FROM 12, and the
// middle tab's label is what set it.
//
// "My Flights" IS BACK, and it is ten characters. At 12 that is 72.00pt of
// JetBrains Mono, which the pill holds at 402 with 8.25 either side and only
// just holds at 375 with 4.88 — but the label is not the binding constraint.
// THE DRAG SQUASH IS. The rule at DRAG_SQUASH_MAX is that a squashed pill keeps
// the label plus 8, so the ceiling is pill - (label + 8): at 12 on a 375 that is
// 81.75 - 80.00 = 1.75, against a cap of 7. The label would fit and the squash
// would put a glyph through the pill's rounded end.
//
// 10 RATHER THAN 11, and the file's own words decide it. DRAG_SQUASH_MAX says 7
// "CLEARS THE NARROWEST OF THOSE TWICE OVER". At 11 the narrowest ceiling is
// 7.75, which clears 7 by 1.11 times and makes that sentence false; at 10 it is
// 13.75, which is 1.96 times and makes it true again. 11 would pass every stated
// rule by a margin of 0.75pt on the binding one; 10 passes by 6.75.
//
// WHAT IT COSTS, and it is the thing this constant was raised to buy: the type
// went 11 -> 12 because the per-character wave could not be read at the smaller
// size, and 10 is smaller still. The growth is a SCALE, so the held peak adds
// 18.2% of the glyph — 1.82pt at 10 against 2.18 at 12. The wave will be less
// legible than at any size this bar has shipped. That is the trade "My Flights"
// costs, taken deliberately rather than discovered later.
//
// THE ICON DOES NOT MOVE WITH IT. ICON_SIZE is still 22, and the glyph is the
// dominant half of every item, so the stack does not read as having shrunk by a
// sixth — only the word does.
const LABEL_FS = 10;
// THE ONE MEASURED NUMBER EVERYTHING ELSE COMES FROM, AND IT IS DERIVED NOW
// RATHER THAN WRITTEN. JetBrains Mono's own metrics are ascender 1020,
// descender -300, lineGap 0 over 1000 units per em — 1.32 em — so the line box
// is exactly 1.32 times the type size: 13.20 at 10, as it was 15.84 at 12.
// OS/2's typo and win figures agree with hhea, so iOS and Android measure it the
// same. Stating it as the ratio means the size can move without this going
// stale behind it, which is what happened the last time it was a literal.
const LABEL_LINE_H = LABEL_FS * 1.32;                         // 13.20
// ONE CHARACTER'S ADVANCE, AND THIS IS WHY THE WORD CAN BE SPLIT AT ALL.
// JetBrains Mono is monospace: every Latin glyph advances 600 of its 1000 units
// per em, so at 10pt every character occupies exactly 6.0pt whatever it is.
// Character positions are therefore ARITHMETIC rather than measurement, and no
// per-glyph onLayout is needed to find them.
const LABEL_ADV = LABEL_FS * 0.6;                             // 6.0
// 22, UP FROM 20, for the same reason the type grew: the wave is a proportion of
// what it moves through.
const ICON_SIZE = 22;
const ICON_GAP = 4;
// An item is an icon over a label: 22 + 4 + 13.20 = 39.20 of content, down from
// 41.84 with the type. Every figure below is derived from that and from BAR_H.
const ITEM_CONTENT_H = ICON_SIZE + ICON_GAP + LABEL_LINE_H;   // 39.20

// 62, DOWN FROM 72, and the pill is what set it: CAPSULE_H is 56, so 62 leaves
// exactly 3 above and below. The pill did not move; the bar came in around it.
const BAR_H = 62;
// A capsule, so half the height. Not a number to pick.
const BAR_R = BAR_H / 2;                                      // 31
// 56, STATED RATHER THAN DERIVED, and this had to change with BAR_H.
//
// It used to be `BAR_H - CAPSULE_INSET * 2` with an inset of 8, which produced
// 56 while the bar was 72. Bringing the bar to 62 through that expression would
// have taken the pill to 46 as a side effect — silently, because nothing named
// the 56. The pill is locked, so the pill is the literal and the AIR is what
// derives from it now. CAPSULE_INSET is gone with the inversion.
const CAPSULE_H = 56;
const CAPSULE_TOP = (BAR_H - CAPSULE_H) / 2;                  // 3, by construction
// 39.20 of content centred in 56 leaves 8.40 above and below, up from the 7.08
// the 12pt stack had and comfortably past the 4 that keeps a glyph off a rounded
// edge. That clearance is fixed by the two heights alone: item and capsule share
// a centre, so the padding below cannot change it.
//
// AND THE GROWN STACK FITS WITH MORE ROOM THAN BEFORE. At full press the content
// is 39.20 + 7 = 46.20, which is 9.80 inside the 56 the pill gives it, against
// 7.16 at 12. Shrinking the type bought vertical room as well as horizontal.
//
// WHAT THE PADDING DOES SET is the touch target, and deriving it this way makes
// the item box exactly the capsule: 39.20 + 8.40 + 8.40 = 56. The thing you can
// press and the thing that lights up are the same rectangle, to the point.
const ITEM_PAD_V = (CAPSULE_H - ITEM_CONTENT_H) / 2;          // 8.40
// 8, AND IT IS AIR NOW RATHER THAN AN ALLOWANCE. It was 20 because the pill was
// 0, AND THE PILL'S WIDTH IS WHY IT CAN BE. This inset the track inside the bar,
// which meant it also divided into the slots — slot = (bar - 2 * TRACK_PAD) / 3
// — and while the pill was derived from the slot, moving this moved the pill.
// It is not any more (see pillW), so the track can take the bar's full inner
// width and the gap at the ends comes from the pill centring in its slot alone.
//
// KEPT AS A NAMED ZERO rather than deleted. It still expresses a real
// relationship: the track's inset inside the bar, and the offset the pill's
// `left` needs to stay in track coordinates. Both are 0 today; neither is
// meaningless.
//
// THE SLOTS ARE WHAT IS LEFT, in quarters of the bar, and they VARY WITH THE
// SCREEN now: 92.50 on a 402pt iPhone 17, 85.75 on a 375pt SE, 72.00 at 320.
// They were the same on every phone while the bar was pinned to a fixed inner
// width; the bar is the window minus 32 instead, so its quarters follow it.
const TRACK_PAD = 0;

// THE PILL'S WIDTH IS NOT A CONSTANT ANY MORE. It is derived per screen, in the
// component, by the same rule that used to be applied by hand here:
//
//   slot = barW / ITEMS.length
//   pill = slot - END_GAP * 2
//
// See pillW, next to the other values that follow from the bar's width.
//
// WHY IT MOVED. The bar used to be pinned to a fixed inner width with the dock
// inset solved to hold it there, which gave one bar width on every phone and
// 43pt of dead space a side on a 402. The bar is inset a fixed 16 from each
// screen edge now and takes whatever lies between, so the slot varies with the
// screen and the pill has to vary with the slot.
//
// WHAT IS HELD CONSTANT IS THE INSET RATHER THAN THE WIDTH, and that is what was
// always actually being preserved. 99.33 sat in a 105.33 slot — 3 either side,
// which is what END_GAP was then — and the eye had picked the gap rather than the
// number. It is 2 now, which widens the pill by 2 on every screen. The
// relationship is
// stated directly now instead of being re-derived by hand every time the tab
// count or the bar width moves.
//
// THE OLD 99.33 IS OUT OF REACH AT FOUR TABS, and that is worth writing down so
// nobody chases it: it needs a 105.33 slot, which is a 421.32 bar, which with 16
// either side needs a 453.32pt screen. The widest iPhone in play is 402, where
// the closest achievable is 88.50.
//
// THE HISTORY, for anyone reading the log: `max slot width - 16`, then a locked
// 99.33, then a locked 73.00 when a fourth tab arrived, and now the rule rather
// than any one of its answers.

// THE AIR AT THE ENDS, and the one number the horizontal geometry is solved for.
// The pill rests centred in its slot, so the gap is (slot - pill) / 2; asking for
// 2 is what fixes the pill at slot - 4. It was 3, and the 1pt it gave back went
// to the pill: 88.50 at 402 and 81.75 at 375, up from 86.50 and 79.75.
//
// ITS ONLY CODE CONSUMER IS pillW. Everything else that reads a 2 reads it
// through the pill, which is why widening the gap is one edit and not a sweep.
const END_GAP = 2;

// 16 FROM EACH SCREEN EDGE, AND THAT IS THE WHOLE OF THE HORIZONTAL LAYOUT.
//
// IT REPLACES A SOLVED INSET. The bar had a fixed inner width and the inset was
// whatever the window had left over, floored at 8 so the bar could never be
// wider than the screen. That held the bar to one width everywhere, which is a
// strange thing to want from a floating control: a 402pt phone got the same
// 316pt bar as a 375, with 43 of nothing on either side of it.
//
// A FIXED INSET INVERTS THAT. The bar is as wide as the screen allows and the
// slots widen with it — 370 and 92.50 at 402, 343 and 85.75 at 375. No floor is
// needed any more, because the bar can no longer outgrow the window: it is
// defined as the window minus a constant.
//
// 16 RATHER THAN A NEW NUMBER. index.tsx, profile.tsx and the placeholders all
// use 20 for their text column; the bar sits a little wider than the text, which
// is what makes it read as floating over the page rather than as part of it.
const DOCK_INSET = 16;

// THE BODY IS NOT SPELLED HERE, AND THE EDGE IS. That split is deliberate and
// worth stating, because this bar once drew all of it and that was wrong.
//
// WHAT IT USED TO DRAW: a gradient shell for the edge, a white FILL over the
// blur, and a white SHEEN over the top 45%. Three white layers. That is what
// app/index.tsx's SHEET_FILL and SHEET_EDGE comments are about — a low-alpha
// white ramp SPREAD over a surface reads as grey, and the panel stops being a
// window and becomes a card.
//
// THE FILL AND THE SHEEN ARE STILL GONE and are not coming back. The body is a
// blur under a BLACK tint and nothing else, which is what lib/glass.tsx draws
// too; only the two numbers differ now.
//
// AND THE BODY IS THIS FILE'S OWN NOW. It was lib/glass.tsx's GlassLayers, the
// same 32 of blur and the same 0.22 of black every sheet and dropdown uses. The
// bar reads greyer than a sheet does for a reason that is structural rather than
// aesthetic: a sheet sits over a 0.40 scrim and the bar sits over nothing, so
// the same material transmits 35.6% under a sheet and 59.3% here, and 59.3% of
// a dark page is not much page. BarGlass is the same two layers in the same
// order with its own two numbers. See BAR_BLUR.
//
// WHAT CAME BACK IS ONE FLAT PIXEL OF IT, which is index.tsx's own hairline and
// nothing more: spreading white over 20pt integrates into a wash, while the same
// white in one row of pixels is a line. A graded version of that pixel was tried
// here and taken out again — see `edge`.
//
// AND IN FRONT OF THE BLUR, not behind it. That is the half this file got wrong
// twice: white BEHIND a blur is not an edge once the blur has sampled it, it is
// a haze over the whole surface.

// 2 OFF THE BOTTOM OF THE SAFE AREA, down from 12 by way of 4, because the bar
// was sitting too far up the screen. It is measured from the safe-area INSET
// rather than from the screen edge, so it is air above a boundary that already
// clears the home indicator: on a 34pt inset the bar's bottom edge lands 36pt
// off the bottom of the screen and its top edge at insets.bottom + 64.
//
// IT CANNOT REACH THE INDICATOR FROM HERE. The glyph occupies roughly the
// bottom 13pt and the inset is 34, so even at 2 there are 23pt between the bar's
// bottom edge and the top of the glyph, and a margin of 0 would still leave 21.
// 2 is a choice about how much the bar floats, not a clearance.
//
// EXPORTED WITH THE HEIGHT because a screen that has to clear this bar needs
// both. A literal copied into a screen is a number that goes stale the next time
// the bar changes size and nobody notices until a footer is half behind glass.
// index.tsx deliberately does NOT clear it; profile.tsx imports neither.
const TAB_BAR_MARGIN_V = 2;
export const TAB_BAR_HEIGHT = BAR_H;
export const TAB_BAR_MARGIN = TAB_BAR_MARGIN_V;

const CAPSULE_R = CAPSULE_H / 2;
// One id for the one mask. Two Defs sharing an id in a single tree collide.
const EDGE_MASK_ID = 'gtbEdgeMask';

// THE SPRING THE PILL TRAVELS ON. Response 0.30s, damping fraction 0.90,
// mass 1:
//
//   stiffness = (2*pi / 0.30)^2 * 1        = 438.65
//   damping   = 2 * 0.90 * sqrt(438.65)    =  37.70
//
//   overshoot        0.152%   =  0.42pt on a three-slot travel at 402
//   first crossing     295ms
//   settle to 2%       208ms   against 275 at 0.375/0.85
//   termination        502ms   against 665
//
// FASTER AND FLATTER THAN WHAT IT REPLACES, and both moved for their own reason.
// The response came down from 0.375 because the travel read as slow; the damping
// went up from 0.85 because the sideways bounce on the middle tabs read as too
// much. 0.42pt of overshoot is a quarter of the 1.74 that was there.
const SPRING = { damping: 37.70, stiffness: 438.65 };

// AND EVERY TAB STOPS DEAD. Same mass, same damping, same stiffness as SPRING,
// so the pill travels at one speed and only the ARRIVAL differs;
// overshootClamping is an early termination rather than a different curve
// (springUtils.ts, isAnimationTerminatingCalculation), so the journey is
// identical and the pill simply does not carry past its target.
//
// THE NAME IS A FOSSIL, and it is left alone rather than churned: this was the
// END tabs' config while Flights and Bookings kept 0.42pt of sideways bounce.
// All four take it now, because the bounce was not wanted anywhere. What it
// means is "the arriving config", and it is the only one any call site passes.
//
// SO THE `end ? SPRING_END : SPRING` BRANCH IS GONE, and the three
// `const end = ...` lines that fed it with it. There were three: the placement
// effect, settlePill and the pan's onFinalize. Each now passes this
// unconditionally.
//
// AND PLAIN SPRING HAS EXACTLY ONE READER LEFT: the spread on the line below.
// It survives as the CURVE rather than as a config anything passes — damping
// and stiffness are stated once, and the clamp is the only thing this adds. It
// is deliberately not folded into SPRING itself, so that the two facts stay
// separable if the bounce is ever wanted back on a subset of tabs.
//
// WHY THE CLAMP IS LOAD-BEARING, whatever the damping is. A from-rest overshoot
// is small — 0.152% of a three-slot travel is 0.42pt against an END_GAP of 2.00
// — but a travel from rest is not the worst case. VELOCITY INHERITANCE IS, and
// spring.js:115 is where it lives: a re-targeted spring takes
// `previousAnimation.velocity + config.velocity`, and config.velocity is 0, so a
// spring interrupted mid-flight starts already moving at whatever the last one
// had reached. A three-slot travel peaks at 2288pt/s; injecting that into a
// fresh spring adds 43.1pt of excursion. Tightening the damping does not touch
// it. Only a clamp bounds it, and with every tab clamped the pill cannot cross
// its own resting position from any tab, at any speed, however the travel was
// interrupted.
const SPRING_END = { ...SPRING, overshootClamping: true };

// THE PRESS IS NOT THE TRAVEL, and sharing one spring was the mistake. 297ms is
// right for a pill crossing 230pt; on a 4.6pt growth under a finger it reads as
// lag, because the finger is already there and the highlight is still arriving.
//
// Same conversion, response 0.18s and damping fraction 0.9:
//
//   stiffness = (2*pi / 0.18)^2 = 1218.5, taken as 1200
//   damping   = 1.8 * sqrt(1200) = 62.35, taken as 62
//
// Ratio 0.895, 0.18% overshoot, and 129ms to settle — inside the 150 that
// separates "responded" from "responding".
const PRESS_SPRING = { damping: 62, stiffness: 1200 };

// 10 POINTS ON EVERY SIDE, WHICH IS NOT ONE SCALE. A uniform factor grows a
// rectangle in proportion, so on a pill of 88.50 by 56 the same number gives
// more width than height. Asking for an equal 10 all round means two different
// factors, and they have to be derived rather than written down — which the
// pill becoming per-screen has now made unavoidable rather than merely wise:
//
//   scaleX = (88.50 + 20) / 88.50 = 1.225989  ->  108.50 wide   at 402
//            (81.75 + 20) / 81.75 = 1.244648  ->  101.75 wide   at 375
//   scaleY = (56    + 20) / 56    = 1.357143  ->   76.00 tall   everywhere
//
// The horizontal one lives in the component as pressScaleX for exactly that
// reason; only the vertical one is still a constant here.
//
// It was 5, then 7, now 10; both factors follow the constant, so that has been
// the only line that changed each time. That is the whole point of deriving
// them — see BAR_GROW, which is the same shape of constant for the bar.
// HOW LONG THE RELEASE WAITS BEFORE IT LANDS, and the logs are what set it.
//
// onPressOut ARRIVES BEFORE onStart. Measured, not reasoned:
//
//   onPressIn   dragging=false  WRITE pressAmt <- 1
//   onPressOut  dragging=false  RELEASED  WRITE pressAmt <- 0
//   onStart     enter  dragging=false  pressAmt=1
//   onStart     WRITE dragging <- true
//
// So no flag set in onStart can be read by onPressOut — it does not exist yet.
// Two attempts assumed otherwise and neither changed anything on screen.
//
// 60ms, which is about three and a half frames at 60Hz. What has to fit inside
// it is the gap between onPressOut on the JS thread and onStart's cancellation
// coming back from the UI thread through runOnJS — one frame in the ordinary
// case, two or three under load. 60 clears that with room and is still short.
//
// WHAT IT COSTS A TAP IS LESS THAN IT LOOKS. Pressability already withholds
// onPressOut until the press has lasted its DEFAULT_MIN_PRESS_DURATION of 130ms,
// so a quick tap's expansion outlives the finger by that much whatever we do;
// and the pan's onFinalize fires on the lift and releases directly, cancelling
// this timer before it can run. The 60 is only ever spent on a gesture that has
// not finished.
const PRESS_RELEASE_DELAY = 60;

// HOW LONG THE PILL STAYS BIG AFTER IT ARRIVES, and the two halves of the wait.
//
// THE PROBLEM. The press growth came off on the release, so the pill shrank the
// instant the finger lifted and then travelled at its normal size — the
// acknowledgement ended before the journey it was acknowledging. It should stay
// grown for the whole trip and let go a beat after it lands.
//
// SO THE WAIT IS MEASURED FROM THE PRESS, NOT THE LIFT. 208 is the travel's own
// settle-to-2% at the spring above, and 150 is the beat after it. The release is
// scheduled for press-in + 358ms in absolute terms, so lifting early does not
// shorten it and holding a long time does not extend it. See scheduleRelease.
//
// 150, DOWN FROM 300. Half a second of a pill sitting grown after a tap had
// already landed read as the control being slow to let go rather than as an
// acknowledgement; the beat is the point, not its length.
//
// AND THE FLOOR IS STILL PRESS_RELEASE_DELAY. A release computed from an old
// press-in can already be in the past; the schedule takes the larger of the two,
// so the 60ms window a drag needs to take the release back is always there.
const PRESS_TRAVEL_SETTLE_MS = 208;
const PRESS_HOLD_MS = 150;

// HOW FAR THE BAR IS PUSHED OUT OF SIGHT while the full field is up, and it is a
// TRANSLATE rather than a removal for one reason: see st.offscreen.
//
// 1000 IS NOT DERIVED AND DOES NOT NEED TO BE. It only has to exceed the tallest
// screen the app runs on plus the shell's own shadow, and 1000 does that on
// every phone by a factor of better than two. A derived figure would read
// insets.bottom and BAR_H and be one more thing to keep true.
const TYPING_OFFSCREEN_SHIFT = 1000;

// THE DRAG'S OWN DEFORMATION, which is the arrival squash asked of a finger
// instead of a spring. The leading edge lags and the trailing edge keeps coming,
// so the pill shortens along the direction it is going.
//
// FROM VELOCITY, NOT FROM DISTANCE. The other candidate was the gap between the
// finger and the pill's settled position, and it is wrong here for a simple
// reason: the pill tracks the finger EXACTLY during a drag, so that gap is not a
// measure of how hard the pill is being pulled — it is a measure of how far the
// nearest slot is, which peaks in the middle between two tabs and vanishes on
// top of one. It would deform most where nothing is happening. Velocity is the
// thing that actually says "this is being dragged hard", which is also the
// behaviour asked for: fast gives more, slow gives almost none.
//
// 10 POINTS AT 800pt/s, AND THE 800 IS MEASURED RATHER THAN GUESSED. It was
// 2000, which was calibrated for the wrong gesture entirely: 2000 to 3000pt/s is
// a SCROLL FLING, and a drag inside a bar 370pt wide at 402 (343 at 375)
// cannot run anywhere near that because there is nowhere to go. The
// instrumented gesture peaked at 983.8pt/s and produced 4.92pt of squash, five
// per cent of the pill, which is a number you have to be told about to see.
//
// WHAT 800 GIVES, across the range a real drag covers:
//
//   275pt/s  deliberate, tab to tab        2.41pt   2.7% of the pill at 402
//   440pt/s  brisk, tab to tab             3.85pt   4.4%
//   790pt/s  brisk, across the bar         6.91pt   7.8%
//  1264pt/s  fast, across the bar          7.00pt   7.9%, capped
//
// so a deliberate drag deforms visibly, a brisk one very nearly maxes out, and
// anything faster is pinned. The observed 983.8 still sits at the cap. The
// SHARES fall as the pill widens, because the cap is absolute and the pill is
// not. Under the press expansion every figure renders 1.2260 times larger again
// at 402, because the squash is a width and the press scales whatever width it
// finds.
//
// 7, DOWN FROM 10, BECAUSE THE PILL GOT NARROWER. The cap was never a taste
// call: the binding constraint is the longest label, and the rule is that a
// glyph keeps 4pt off the pill's rounded end, so the squashed pill has to be at
// least the label plus 8.
//
// THE CEILING IS PER SCREEN NOW, because the pill is: it is pill - (label + 8),
// and the longest label is "My Flights" at ten characters of 6.0 = 60.00.
//
//                 label      402      375
//   Home          24.00    56.50    49.75
//   My Flights    60.00    20.50    13.75   <- binding
//   Bookings      48.00    32.50    25.75
//   Search        36.00    44.50    37.75
//
// 7 CLEARS THE NARROWEST OF THOSE TWICE OVER — 13.75 against 7 is 1.96 times —
// and that sentence is why LABEL_FS is 10 rather than 11. At 11 the binding
// ceiling is 7.75, which clears the cap by 1.11 times and would leave this note
// claiming something it no longer did. See LABEL_FS.
//
// THE BINDING LABEL CHANGED WITH THE TYPE. It was "Bookings" at eight
// characters while the middle tab read "Flights"; "My Flights" is ten, so it
// binds now even at the smaller size. 7 leaves 10.88 either side of it at rest
// on a 375 and 7.38 at full squash, which is the margin the 4pt rule asks for
// with room to spare.
//
// IT DOES NOT HOLD BELOW 375. At a 320pt window the pill is 68.00 and the
// ceiling is 0.00: "My Flights" at 60.00 plus its two 4pt clearances is exactly
// the pill, so there is no room for a squash of any size at all — not merely
// too little for a useful one. That is a property of a screen-derived pill and
// not of this number; if a 320 phone ever matters, the label is what has to
// give, not the squash.
//
// 2.40 WAS THE FIGURE HERE, AND IT IS WHERE THE TYPE SIZE SHOWS. It was
// 68.00 - (57.60 + 8), where 57.60 is "Bookings" at eight characters of 7.2 —
// LABEL_ADV at a 12pt type, from when Bookings was the binding label. Both
// halves have moved since: the type is 10 and the longest label is ten
// characters, which is why the ceiling closed the rest of the way.
const DRAG_SQUASH_MAX = 7;
const DRAG_SQUASH_VEL = 800;

const PRESS_GROW = 10;
// ONLY THE VERTICAL FACTOR IS A CONSTANT NOW. The horizontal one divides by the
// pill's width, which is a per-screen value, so it moved into the component as
// pressScaleX; the height has not moved and neither has this. Both of its
// readers — capsuleStyle and edgeHoleProps — were already in the component, so
// nothing had to be restructured to let it go.
const PRESS_SCALE_Y = (CAPSULE_H + PRESS_GROW * 2) / CAPSULE_H;

// THE STACK GROWS AS ONE THING, which is the whole point of these two and the
// reason they are a single scale on a single wrapper rather than a scale on the
// glyph and another on the word. The growth is asked of the PAIR: the icon and
// the label keep their proportions and their gap, and the block they make gets
// taller. Two separate growths would be double, and the gap between them would
// not grow at all, so the stack would come apart as it went.
//
// 7 AND 5, UP FROM 3 AND 2, BECAUSE 3 COULD NOT BE SEEN. The instrumentation
// settled that rather than taste: the peaks came back at the designed values, so
// the falloff and the transform were both doing their job and the amplitude was
// simply below the threshold. 3 on 39.20 is a 7.7% scale — 1.68pt on the glyph
// and 1.01pt on the line box, on an object already sliding under a finger. 7 is
// 17.9%, which is a size change rather than a suspicion of one.
//
// THE GAP BETWEEN THE TWO STATES IS WIDER TOO, 2 rather than 1, so that the
// drag reading distinctly lighter than the hold survives the larger numbers.
//
// ITEM_CONTENT_H IS THE HEIGHT THAT GROWS, and it is already the sum of exactly
// those three parts — icon 22, gap 4, line box 13.20 — so the factors derive
// from it and cannot go stale if any of the three moves:
//
//   held     (39.20 + 7) / 39.20 = 1.178571  ->  46.20 tall
//            icon 25.93, gap 4.71, line box 15.56
//   dragged  (39.20 + 5) / 39.20 = 1.127551  ->  44.20 tall
//            icon 24.81, gap 4.51, line box 14.88
//
// A SCALE, NOT A SIZE, and that distinction is load-bearing rather than stylistic.
// Changing fontSize or the Svg's width would REFLOW: the label's measured width
// feeds the item's box, the item's box is what onSlotLayout reports, and those
// measurements are what the drag clamp and the crossing detection both read. A
// transform is applied after layout and Yoga never sees it, so the slots stay
// exactly where they were measured.
const STACK_GROW_PRESS = 7;
const STACK_GROW_DRAG = 5;
const STACK_SCALE_PRESS = (ITEM_CONTENT_H + STACK_GROW_PRESS) / ITEM_CONTENT_H;
const STACK_SCALE_DRAG = (ITEM_CONTENT_H + STACK_GROW_DRAG) / ITEM_CONTENT_H;

// HOW TIGHTLY THE GROWTH SITS UNDER THE PILL, and these two replace a falloff
// that was far too broad. It used to be a linear tent normalised by the SLOT
// width, which reached zero only a whole slot away — so at the moment the pill
// sat between two tabs both were grown to exactly half, and the bar read as
// everything swelling slightly rather than as the pill lighting up what it was
// over. A linear tent cannot do better: it is a partition of unity, so the two
// neighbours ALWAYS sum to one and the midpoint is ALWAYS half and half.
//
// SO THE PARTITION IS GIVEN UP DELIBERATELY. Concentrating the response means
// the two neighbours no longer sum to one through the crossover; the total dips
// as the growth hands over. That dip IS the effect asked for — the light
// passes across rather than being shared out — and it costs nothing in
// smoothness, because a dip is still continuous. Only a step would be a snap.
//
// MEASURED IN THE PILL'S OWN TERMS, not the slot's, because "under the pill" is
// what is being expressed and the pill is whatever the screen makes it:
//
//   full growth while the slot's centre is within pill / 4    22.13 at 402
//   nothing at all once it is beyond              pill * 0.8  70.80 at 402
//                                                             20.44 / 65.40 at 375
//
// STATING THEM IN THE PILL'S TERMS IS WHY THIS SURVIVED the pill becoming
// per-screen with no change of shape at all: both radii scale with it, so the
// curve is the same curve on every phone. A resting pill still lights its own
// tab and nothing else, because the neighbouring slot centre is 92.50 away at
// 402 against a 70.80 zero radius, and 85.75 against 65.40 at 375. The slot
// pitch did not move when the gap narrowed; only the pill inside it did.
//
// They are computed in the component as stackFullR and stackZeroR and handed to
// waveAt, which is module scope and cannot see a render value.
//
// and between them a SMOOTHERSTEP, 6u^5 - 15u^4 + 10u^3, whose first AND second
// derivatives are zero at both ends. That is what keeps the joins invisible: the
// curve does not just meet the flat parts, it meets them flat.
// THESE TWO ARE IN THE COMPONENT NOW, as stackFullR and stackZeroR, and this is
// the one place where the pill becoming per-screen forced a change of shape
// rather than a change of value.
//
// WHY. waveAt is a MODULE-SCOPE worklet, and it read both of these out of module
// scope. A module-scope function cannot see a render value, so once the radii
// moved they had to be handed to it: waveAt takes them as arguments, and the two
// components that call it — WaveChar and WaveIcon — take them as props and pass
// them down. Nothing else about any of the three changed.
//
// THE ALTERNATIVE WAS WORSE. Keeping the radii at module scope would have meant
// keeping a constant pill, and moving waveAt into the component would have given
// each of the twenty-nine cells its own copy of the falloff instead of one
// shared by all of them.

// THE TWO ENDS OF THE WAVE'S COLOUR. They were an inline ternary on `focused`,
// which is exactly what had to go: a tab was one colour or the other with
// nothing in between, so the colour could only ever snap while the growth slid.
// Named, because two components need them and neither is the bar.
//
// THE COLOUR RIDES t, NOT THE PRESS. Growth is pressAmt * t; colour is t alone.
// That is the difference between the two: a tab is green because the pill is
// SITTING on it, which is true at rest, while it only grows because a finger is
// down. Tie the colour to pressAmt as well and the active tab would go grey
// whenever nobody was touching the bar.
//
// #e2e2e2 IS RETIRED BY THIS. It was the active ink and green replaces it; the
// inactive ink is unchanged, and its 0.45 alpha now interpolates up to 1 as the
// wave arrives, so the word gains weight as well as hue.
const INK_INACTIVE = 'rgba(226,226,226,0.45)';
const INK_WAVE = '#4ade80';

// THE X'S OWN INK, and it is app/index.tsx's destructive red at that file's own
// alpha: the route sheet's dismiss button draws the same two paths in exactly
// this. One glyph, one colour, copied rather than approximated.
//
// IT IS A DIM RED ON PURPOSE. 0.55 over the pill's ground composites to
// rgb(142, 67, 67), which is 2.84:1 — under the 3:1 a large glyph is usually
// held to. That is index.tsx's register rather than an oversight of this file's:
// the same stroke on the same alpha is what dismisses a sheet three screens
// away, and a close mark that shouts is worse than one that is quiet. The mark
// is also 14 by 14 of 1.75 stroke, which is well past the 24 CSS pixels that
// makes a graphic "large".
//
// INK_FULL WENT WITH THE CHANGE. It was declared for exactly two readers — this
// glyph and Home's — and both have moved off it, so it is deleted rather than
// left sitting unused. #e2e2e2 is still the app's ink; it is simply not spelled
// in this file any more.
const INK_CLOSE = 'rgba(248,113,113,0.55)';

// THE PRESS-IN TRAVEL IS NOT A DIFFERENT JOURNEY ANY MORE, and its two configs
// are gone. PRESS_TRAVEL_SPRING ran response 0.25 because the finger is already
// down and waiting; PRESS_TRAVEL_PINNED was that with the overshoot clamped off.
//
// WHAT UNIFYING THEM COSTS, and it is a real cost rather than a tidy-up: a held
// finger now waits 275ms for the pill to reach it instead of 183, and 293ms to
// the first crossing instead of 195. That is about 90ms more of a control not
// yet having answered, on the one path where the user is demonstrably still
// there watching it.
//
// IT IS PAID DELIBERATELY. The press-in travel is the ONLY thing that made
// entering search mode feel faster than leaving it, so keeping it fast would
// have kept exactly the asymmetry this round exists to remove. One pill, one
// distance, one speed, whichever direction and however the journey was started.

// WHEN THE EXPANSION JOINS THE TRAVEL, and it OVERLAPS rather than queueing.
//
// Strictly sequential was the other option and it is worse: the travel settles
// at 275ms, so nothing would answer the finger for that whole time, and a
// control that waits 275ms before acknowledging a touch reads as broken however
// fast it moves afterwards.
//
// 120ms IS NOT TWO THIRDS OF THE WAY THROUGH ANY MORE, and the figure is
// corrected rather than the constant retuned. The travel it overlaps went from
// 183ms to 275, so 120 is 44% of it rather than 66%: the growth now starts
// nearer the middle of the journey than its tail. The pill is still closing on
// the tab when it begins, which is the property that matters — the growth
// reads as the momentum landing rather than as a second event. PRESS_SPRING
// takes 129ms on top, so the whole gesture resolves around 400ms.
//
// LEFT AT 120 ON PURPOSE. Scaling it to hold the same fraction would be 181,
// and retuning the press response was not what this round was asked to do.
//
// IT CANNOT OUTLIVE A QUICK TAP. Pressability holds onPressOut to a 130ms floor
// and PRESS_RELEASE_DELAY adds 60 on top, so the release lands at 190ms at the
// earliest — after this. And if anything did release first, assigning a new
// animation to pressAmt supersedes a pending delayed one, which is the same
// mechanism onFinalize already relies on to override an in-flight expansion.
const PRESS_TRAVEL_LEAD = 120;

// 3 POINTS ON EVERY SIDE, FOR THE BAR ITSELF, on the same trigger and the same
// progress value. The whole control answers the finger, not just the highlight
// inside it: the pill comes up 10 and the surface it sits on comes up 3.
//
// A VISUAL SCALE AND NOTHING ELSE. This is a transform on the rendered surface.
// It does not touch BAR_H, BAR_R, dockInset or anything Yoga reads, and it must
// not: TAB_BAR_HEIGHT is exported and profile.tsx derives its footer clearance
// from it, so a bar whose LAYOUT height moved under a finger would shift a
// screen's content every time somebody pressed a tab.
//
// TWO FACTORS AGAIN, for the reason at PRESS_GROW: 3 on a 62 height and 3 on a
// ~316 width are not the same proportion, and one factor would give about 10pt
// of width for the 3pt of height asked for.
//
//   scaleY = (62 + 6) / 62 = 1.096774
//
// THE HORIZONTAL ONE CANNOT BE A CONSTANT, and that is not a wrinkle here but
// the same fact DOCK_INSET_MIN exists for: the bar's width comes from the
// window. It is computed per render at the call site, where useWindowDimensions
// can see it. Above a 331.99pt window the inset is solved to hold the bar at
// BAR_INNER_W, so the factor is 321.99 / 315.99 = 1.018988 on every iPhone that
// ships — 402 and 375 give the identical number, which is the design working
// rather than a coincidence. Below that the floor engages and the bar narrows
// with the screen, so the factor rises: 310 / 304 = 1.019737 at 320.
const BAR_GROW = 3;
const BAR_SCALE_Y = (BAR_H + BAR_GROW * 2) / BAR_H;           // 1.096774

// ── THE REAL THING, OR OURS ────────────────────────────────────────────────
//
// WHAT YOU WILL ACTUALLY SEE WHILE DEVELOPING: the BlurView stack, not this.
// VERIFIED HERE: this is a native module, so it needs a development build on
// SDK 54. REPORTED, NOT VERIFIED HERE: bundling into Expo Go begins at SDK 56.
// Either way, in Expo Go both checks below return false and the fallback
// renders, which is correct rather than broken. Build a dev client for Apple's
// glass.
//
// TWO CHECKS, AND THEY ANSWER DIFFERENT QUESTIONS. Both are in this version:
//
//   isLiquidGlassAvailable()   "the app is using the Liquid Glass design" —
//                              component availability. Its own doc note warns
//                              this can be true even when the user has turned
//                              the effect down in accessibility settings, and
//                              points at AccessibilityInfo for that half.
//   isGlassEffectAPIAvailable() the API is actually there at runtime. Added
//                              because some iOS 26 betas ship without it and
//                              CRASH when the view is used (expo#40911).
//
// Both, therefore, and in that order. On every non-iOS platform both are
// hardcoded `return false` in the package's own .js, so Android needs no
// platform test of its own here.
//
// Module scope: these are runtime constants for the life of the process, not
// state, and calling them per render would be per-frame work for an answer that
// cannot change.
const GLASS_SUPPORTED = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

// A FIXED LIST OF THREE, NOT THE NAVIGATOR'S STATE, and this is a deliberate
// choice rather than a shortcut. state.routes is the wrong source because it
// HOLDS MORE THAN THE SCREENS: expo-router adds `_sitemap` and `+not-found` to
// the route tree (getRoutesCore.js:594,604), so a bar built from it would show
// tabs for both.
//
// The list also fixes the ORDER — home, flights, profile — which state cannot:
// expo-router sorts `index` first and the rest by name length, which would put
// flights last rather than in the middle.
//
// `route` is the navigator's screen name, which expo-router sets to the route
// node's path (useScreens.js:247, `name={route.route}`) — so app/index.tsx is
// "index", app/flights.tsx is "flights" and app/profile.tsx is "profile".
// PATH DATA RATHER THAN FINISHED ELEMENTS, which is index.tsx's own rule: a
// glyph whose colour is fixed is written there as a complete <Path>, and one
// whose colour varies is written as a `d` string because the element cannot be
// shared across two colours. Every one of these follows the wave rather than a
// fixed colour, so every one is a string.
//
// THE PERSON WENT WITH THE PROFILE TAB. It was two paths, a head and a
// shoulder line, and ITEMS was its only consumer; with Profile out of the bar
// there was nothing left referencing it. Recover it from git if Profile ever
// comes back rather than redrawing it.
const ICON_HOME_D = 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z';
// AN AEROPLANE SEEN FROM ABOVE: nose at the top, swept wings, tailplane, and a
// notch between the tail tips. One closed outline, stroked like the others.
//
// THE PATH IS THE SPECIFIED ONE WITH TWO NUMBERS CORRECTED, and the correction
// is not cosmetic: as given, seven of its eight left-hand vertices sat exactly
// 1.70 units above their mirror on the right, because the tail notch was placed
// at y=20 while the right tail tip reached y=21. At 20pt over a 24 viewBox that
// is 1.42pt of lift on one wing and one tailplane — a plane drawn crooked
// rather than one banking, since the two halves stayed congruent instead of
// rotating about a common centre. `l-4 -.7` became `l-4 1` and `L3 13.8` became
// `L3 15.5`, which puts every vertex on its mirror. Nothing else moved.
const ICON_SAVED_D = 'M12 3c.9 0 1.5 1.2 1.5 3v3.2l7.5 4.3v2l-7.5-2.3v4.3l2.5 1.8v1.7L12 20l-4 1v-1.7l2.5-1.8v-4.3L3 15.5v-2l7.5-4.3V6c0-1.8.6-3 1.5-3z';

// A BACKPACK, THREE STROKES: the body, the top handle, and one pocket line.
// Three is what reads at 22pt; a zip or a strap buckle turns to mush.
//
// TRACED BEFORE SHIPPING, because a path that looks plausible is not one that
// is. Every vertex mirrors about x=12 — body 7/17, 20/4, 17/7; handle 9/15;
// pocket 4/20 — the body closes back on its start, and all four corner arcs are
// r=3 with a chord of 4.2426, comfortably inside the 6.00 that a radius-3 arc
// can span. The handle's arc is a chord of exactly 6.0000 on r=3: a true
// semicircle rather than a nearly-one.
//
// The ink runs x 4..20 and y 3..21 — the 3 is the handle's apex, which is an
// arc extreme rather than a vertex and is easy to miss when checking. With the
// 1.75 stroke that is 3.125..20.875 and 2.125..21.875, inside the 24 box, and
// centred on (12, 12).
const ICON_BAG_BODY_D = 'M7 7 H17 A3 3 0 0 1 20 10 V18 A3 3 0 0 1 17 21 H7 A3 3 0 0 1 4 18 V10 A3 3 0 0 1 7 7 Z';
const ICON_BAG_HANDLE_D = 'M9 7 V6 A3 3 0 0 1 15 6 V7';
const ICON_BAG_POCKET_D = 'M4 15 H20';

// A MAGNIFIER, TWO STROKES. It is the one glyph here with no mirror symmetry to
// check, because it is a diagonal object; the checks that replace it are that
// the circle is a circle and that the handle points at its centre.
//
// TRACED: the circle is two arcs of r=6, each with a chord of exactly 12.0000,
// so both are true semicircles and the centre is (10.5, 10.5). The handle
// starts at (14.74, 14.74), which is 5.99627 from that centre against a radius
// of 6 — 0.0037 out, or 0.0034pt at 22pt. Its cross product with the radius
// is 0.000000: exactly collinear, so the handle points through the centre
// rather than merely near it. Length 6.7317 at 45.00 degrees.
//
// Ink runs 4.5..19.5 on both axes, so it is centred on (12, 12) like the others,
// and 3.625..20.375 with the stroke.
const ICON_LENS_D = 'M4.5 10.5 A6 6 0 1 0 16.5 10.5 A6 6 0 1 0 4.5 10.5 Z';
const ICON_LENS_HANDLE_D = 'M14.74 14.74 L19.5 19.5';

// THE APP'S OWN CLOSE X, character for character out of app/index.tsx, where the
// route-detail sheet's dismiss button draws exactly these two `d` strings.
//
// TRACED, as every other glyph here has been. Both strokes span 5..19 on both
// axes, so the mark is 14 by 14 centred on (12, 12) like the rest of the set,
// and 3.125..20.875 once the 1.75 stroke is added — inside the 24 box. The two
// diagonals cross at the centre at exactly 90 degrees, each 19.7990 long.
//
// THE SECOND ONE IS RELATIVE and is left that way rather than normalised: `l14
// 14` from (5,5) is (19,19), which is the same line index.tsx draws. Rewriting
// it as an absolute would be a silent divergence from the file this is copied
// from, and the point of copying is that the two cannot differ.
//
// NO strokeLinejoin. Each path is a single segment, so there is no join to
// round; index.tsx sets only the cap and this matches it.
const ICON_CLOSE_A_D = 'M19 5 5 19';
const ICON_CLOSE_B_D = 'M5 5l14 14';

// THE LABEL AND THE ROUTE ARE NOT THE SAME STRING, and the flights tab is why:
// it reads "Flights" and navigates to `flights`. The file is app/flights.tsx and
// the route stays `flights`.
//
// IT READS "My Flights" AGAIN, and the type came down to let it. It was
// shortened to "Flights" when a fourth tab took the pill to 73.00 and ten
// characters of 12pt type would not fit; the pill is 88.50 at 402 and 81.75 at
// 375 now, and at 10pt the label is 60.00, which leaves 14.25 and 10.88 a side.
// Both are past the 4pt a glyph wants off a rounded end by better than double.
//
// AND THE SCREEN'S OWN HEADING NEVER CHANGED. app/flights.tsx has said
// "My Flights" at 20pt throughout; only the tab shortened, because only the tab
// has to fit inside a pill. The two agree again.
//
// SEE LABEL_FS for why the type is 10 rather than 11, which is the drag squash's
// ceiling rather than this label's width.
//
// PROFILE IS NOT HERE ANY MORE. It is still a route and still reachable — the
// header's >// button navigates to it — it is simply not one of the four. See
// activeIndex for what the bar does while a route it does not list is open.
//
// JetBrains Mono is monospace, so every glyph in every one of these advances
// 600 of its 1000 units per em, read out of the shipped 400Regular, and the
// cells are pinned to LABEL_ADV regardless.
const ITEMS: { label: string; route: string; paths: string[] }[] = [
  { label: 'Home', route: 'index', paths: [ICON_HOME_D] },
  { label: 'My Flights', route: 'flights', paths: [ICON_SAVED_D] },
  { label: 'Bookings', route: 'bookings', paths: [ICON_BAG_BODY_D, ICON_BAG_HANDLE_D, ICON_BAG_POCKET_D] },
  { label: 'Search', route: 'search', paths: [ICON_LENS_D, ICON_LENS_HANDLE_D] },
];

// THE FALLOFF, AND THERE IS EXACTLY ONE OF IT. Both components below call this
// and nothing else computes a shoulder: the growth and the colour are two
// readings of the SAME t, taken at the same distance from the same centre.
//
// AT MODULE SCOPE, which babel-preset-expo 54 supports here because it wires
// react-native-worklets/plugin automatically when the package is installed, and
// it is (0.5.1). That is what lets one copy serve two components; a
// component-scope helper could only have served one.
//
// RETURNS t RATHER THAN A SCALE. The amplitude is applied by the caller, so the
// colour can use the bare curve while the growth multiplies it by pressAmt.
function waveAt(
  index: number, offset: number, arr: Slot[], pillC: number, fullR: number, zeroR: number,
) {
  'worklet';
  if (index >= arr.length) return 0;
  const centre = arr[index].x + arr[index].w / 2 + offset;
  const d = Math.abs(pillC - centre);
  if (d <= fullR) return 1;
  if (d >= zeroR) return 0;
  // Smootherstep, in Horner form: 6u^5 - 15u^4 + 10u^3.
  const u = (zeroR - d) / (zeroR - fullR);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

// The stroke is the only icon prop that moves, and a G passes it down to every
// path inside it — so one animated node colours an icon whether it is drawn
// with one path or two, and `profile` needs two. Module scope: wrapping on each
// render would remount the node.
const AnimatedG = Reanimated.createAnimatedComponent(G);

// WHERE CHARACTER k SITS, as an offset from the centre of its slot. The label is
// centred in the item, so a word of n characters spans n * 6.0 about that centre
// and character k occupies [k * 6.0, (k + 1) * 6.0] from the word's left edge:
//
//   offset(n, k) = (k + 0.5 - n / 2) * 6.0
//
// "My Flights" is the longest at 10 characters, 60.00pt wide, so its offsets run
// -27.0, -21.0, -15.0, -9.0, -3.0, +3.0, +9.0, +15.0, +21.0, +27.0. Symmetric
// about the centre by construction, which is the check that the formula is
// right. THE SPACE IS A CELL LIKE ANY OTHER — it takes its 6.0 of advance and
// draws nothing, which is exactly what the fixed cell was for.
const charOffset = (n: number, k: number) => (k + 0.5 - n / 2) * LABEL_ADV;

// THE SEARCH TAB'S INDEX, named because three separate things test for it: the
// press that enters search mode, the guard that leaves it when the route changes
// underneath, and the pill's resting slot while it is inert.
const SEARCH_INDEX = 3;

// THE PROMPT AND THE FIELD, at index.tsx's own sizes. The prompt is 13 there and
// 13 here; the full field's input is 15 there and 15 here.
const PROMPT_FS = 13;
const INPUT_FS = 15;
// 12, AND ONLY FOR THE BAR'S PLACEHOLDER. The prompt beside it stays at 13 and
// the full field's input stays at 15; this is the one piece of type that had to
// give, and it gave because of arithmetic rather than taste. See
// SEARCH_PROMPTS_BAR: at 13 the collapsed field holds 20 characters on a 375,
// and the shortest prompt in the list is 21. At 12 it holds 22, which is enough
// for the two shortest to appear WHOLE on every screen the bar supports.
const BAR_PROMPT_FS = 12;
// Air between the full field and the top of the keyboard.
const FIELD_GAP = 8;

// THE BAR'S OWN MATERIAL, and the reason it is not lib/glass.tsx's.
//
// SAME STRUCTURE, SAME ORDER, TWO DIFFERENT NUMBERS. The sheets run 32 of blur
// under a 0.22 black fill, which is right for a panel sitting over a 0.40 scrim:
// (1 - 0.40)(1 - 0.24)(1 - 0.22) = 35.6% of the page comes through. THE BAR HAS
// NO SCRIM. The same material over nothing transmits (1 - 0.24)(1 - 0.22) =
// 59.3%, and 59.3% of a rgb(5) page is rgb(2.96) — dark enough to read as a
// grey slab rather than a window.
//
// 18 AND 0.12 GIVE 76.1%: (1 - 0.135)(1 - 0.12). The 0.24 is lib/glass.tsx's own
// observed darkening for systemChromeMaterialDark at intensity 32, and scaling
// it with the intensity is an estimate rather than a measurement — worth saying,
// since it is the one figure here that was not derived. The bar's ground goes
// from rgb(2.96) to rgb(3.81) against a rgb(5) page.
//
// THE FILL IS BLACK AND STAYS BLACK. This file has gone grey four times and
// every one of them was white behind the blur. Less black is MORE page, not
// more white: 0.12 of rgb(0) cannot lighten anything. The only white in the bar
// is SHEET_EDGE's hairline, and that is drawn OVER the blur as a sibling, never
// behind it.
const BAR_BLUR = 18;
const BAR_FILL = 'rgba(0,0,0,0.12)';

// THE TWO OBJECTS HAVE NO COLOUR OF THEIR OWN, and CIRCLE_FILL and CIRCLE_INK
// are deleted rather than left unused.
//
// WHAT THEY WERE. A solid #4ade80 fill on the Home pill and the magnifier, and
// a #050505 ink on top of it, which is the pairing a solid green forces: the
// colour's relative luminance is 0.553, so #e2e2e2 on it is 1.35:1 and white is
// 1.74:1, and only a near-black clears 4.5. Two saturated green slabs turned out
// to be the wrong object in a bar whose whole material is a dark blur.
//
// WHAT THEY ARE INSTEAD is the glass they were before it: BarGlass, the pill's
// own fill over it, and the SHEET_EDGE hairline over that. Nothing here has to
// name a colour, because nothing about them is coloured any more. See searchObj.
//
// AND THE INK WENT BACK WITH THE FILL. The magnifier's glyph is INK_WAVE again,
// the green the prompt beside it uses, and Home's icon and label are back to
// being whatever the wave gives them — which in search mode is INK_INACTIVE,
// because the pill has travelled to the Search slot and is nowhere near Home.
// That is the same ink they carried before the green fill existed, reached by
// the same path, which is why the tintAmt override could come out whole.

// THE TWO ROUND PILLS IN SEARCH MODE, at the pill's own height so they read as
// the same family of object: width equals height equals CAPSULE_H, which is
// what makes them circles rather than short ovals.
//
// 56 HOLDS THE HOME STACK COMFORTABLY. The icon, its gap and the label line are
// 39.20 together, leaving 8.40 above and below — the same clearance
// ITEM_PAD_V gives them in a slot. Across, "Home" is four characters of 6.0 =
// 24.00, which leaves 16.00 either side. Nothing has to be dropped or shrunk.
const SEARCH_CIRCLE = CAPSULE_H;
// THE AIR BETWEEN THE THREE OBJECTS, and it is what makes them three. END_GAP's
// 2 is the pill's inset inside its own slot, which is a different measurement:
// this is the distance between two separate surfaces, and at 2 they would read
// as one surface with seams in it.
const SEARCH_OBJ_GAP = 8;

// HOME'S PRESS GROWTH, AND IT IS 5 RATHER THAN THE PILL'S 10.
//
// THE GAP IS WHAT SETS IT. Home's circle and the oval are SEARCH_OBJ_GAP apart,
// which is 8, so anything at or above 8 puts the circle into the field beside
// it. At PRESS_SCALE_Y — 10 a side — it crossed by 2.00 and read as a collision
// rather than as a press. 5 leaves 3.00 of clear glass between them at full
// press, on every screen, because both numbers are absolute.
//
// 5 RATHER THAN 6 OR 7. It is half of PRESS_GROW, which is the relation worth
// having: the smaller surface answers with the smaller bulge, and the two are
// tied so that moving one moves the other. It is also exactly what PRESS_GROW
// itself was two revisions ago, so it is a growth this bar has already been
// shown to read at.
//
// ONE FACTOR ON BOTH AXES, because the circle is square: equal points all round
// on a box whose width equals its height is a UNIFORM scale. 56 becomes 66 about
// a centre that does not move.
const SEARCH_PRESS_GROW = 5;
const SEARCH_PRESS_SCALE = (SEARCH_CIRCLE + SEARCH_PRESS_GROW * 2) / SEARCH_CIRCLE;

// THE SEARCH PILL KEEPS THE PILL'S OWN 10, and that is a decision rather than an
// oversight. It IS the tracking pill: pressScaleX by PRESS_SCALE_Y, 1.225989 by
// 1.357143 at 402 and 1.244648 by 1.357143 at 375. Giving it a different growth
// in search mode would mean branching capsuleStyle on the mode, which is a
// second press behaviour for the one object that must feel the same in both.
//
// SO IT STILL CROSSES ONTO THE OVAL BY 2.00, on every screen, and that is
// recorded rather than hidden. It reads as the button pressing into the field,
// which is the same overhang the pill already takes 8 points past the bar's own
// end on every normal press. SEARCH_OBJ_GAP at 10 would zero it, at a cost of 4
// points of oval width, and the oval has none to spare.
//
// THE TWO OBJECTS STILL CANNOT REACH EACH OTHER. Their centres are three whole
// slots apart — 277.50 at 402 and 257.25 at 375 — so even at the pill's 10 and
// Home's 5 their facing edges are 190.25 and 173.38 apart.

// THERE IS NO TRANSITION BETWEEN THE TWO MODES ANY MORE, and COLLAPSE_UNMOUNT_MS
// went with it. It held the two glass objects in the tree for 500ms after search
// mode ended so their opacity could finish falling; nothing fades now, so there
// is nothing to hold anything for. objectsUp, the timer that lowered it and the
// searchAmt spring that all of it served are gone together. See the note at
// `searchMode` for what replaced them.

// THE MATERIAL, as one component for the same reason lib/glass.tsx makes one:
// so it cannot be spelled differently in two places. The blur samples what is
// behind the surface, then the black fill darkens the result. Order is the whole
// of it — the fill is a SIBLING AFTER the blur, so it tints the blur rather
// than being something the blur samples.
function BarGlass() {
  return (
    <>
      <BlurView
        intensity={BAR_BLUR}
        tint="systemChromeMaterialDark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, st.barFill]} pointerEvents="none" />
    </>
  );
}

// TODO: DEDUPLICATE THIS AGAINST app/index.tsx.
//
// SEARCH_PROMPTS below is a copy of PLACEHOLDER_PROMPTS in app/index.tsx, and
// TabBarPlaceholder below it is a copy of that file's AnimatedPlaceholder. They
// are line-for-line the same text and the same timings.
//
// EDITING ONE MEANS EDITING BOTH. There is no import binding them and nothing
// that will fail if they drift; a prompt changed here and not there simply
// produces two different sets of suggestions in two parts of one app.
//
// THE FIX IS TO LIFT BOTH INTO lib/ — the prompts and the component — and have
// app/index.tsx import them back, the way both files still import SHEET_EDGE
// from lib/glass.tsx. It is DEFERRED rather than rejected: doing it means
// editing app/index.tsx, which was out of scope for the change that introduced
// this copy. It is a small change and it should be made.
//
// WHY THE COPY AND NOT AN IMPORT IN THE MEANTIME: a route file is not a module
// source. Importing a component out of app/index.tsx would couple this bar to
// that screen's module, which is the coupling lib/ exists to prevent.
const SEARCH_PROMPTS = [
  'what is the status of EK500...',
  'is my flight on time?',
  'when does the next flight to New York leave?',
  'what gate is BA178 at?',
  'is there a delay on my LA flight?',
  'track my connecting flight to Chicago...',
  'when does the next flight to Dubai leave?',
  'is my Mumbai flight delayed?',
  'what time does AA101 land in JFK?',
];

// THE BAR'S OWN SHORTLIST, and it is a SUBSET of the list above rather than new
// text. The full list runs from 21 characters to 44, and the collapsed oval has
// nothing like the room for most of it.
//
// TWO ENTRIES, WHICH WAS ALL THAT FIT. Nothing in the list is 20 characters or
// under — the shortest is 21 — so these were the only two that finished inside
// the narrow field on both screen sizes when it was chosen:
//
//   'is my flight on time?'    21 characters
//   'what gate is BA178 at?'   22 characters
//
// AND THEY NO LONGER QUITE FIT, which is worth recording rather than quietly
// leaving to be rediscovered. Splitting search mode into three objects took two
// 56pt circles and two 8pt gaps out of the bar, so the oval is 39.50 narrower
// than the single field it replaced at 402 and 46.25 narrower at 375. That
// leaves room for 19 characters and 16, against entries of 21 and 22: both now
// clip, by two characters and by five, which is the exact problem this shortlist
// was chosen to avoid.
//
// ACCEPTED FOR NOW, deliberately: it is a cycling teaser that types out and
// runs off, not information anyone needs to finish reading. IF IT NEEDS FIXING
// there are two levers and neither is new prompt text. Dropping the prompt from
// the collapsed oval frees its 70.40 and gives 29 characters and 25, which fits
// both entries with room over; shrinking the circles gives the oval back
// whatever is taken off them, at the cost of the "Home" label's 13.60 of
// clearance inside a 56pt circle.
//
// THE FULL FIELD KEEPS THE WHOLE LIST. It spans the screen less 32 and has room
// for all nine, so the short list is a property of the collapsed bar and not of
// the feature. Anything added to SEARCH_PROMPTS at 22 characters or fewer
// belongs here too.
const SEARCH_PROMPTS_BAR = [
  'is my flight on time?',
  'what gate is BA178 at?',
];

// index.tsx's AnimatedPlaceholder, with two additions: a size and a list. The
// same component serves the collapsed field at 12 with two prompts and the full
// one at 15 with all nine. The timing is its — 80ms a character in, 1500 held,
// 50ms a character out, 400 between — so both fields type at exactly the rate
// the home screen's does.
//
// BOTH ARRAYS ARE MODULE CONSTANTS, so `prompts` is stable across renders and
// the effect below does not restart its loop on every one.
function TabBarPlaceholder({ size, prompts }: { size: number; prompts: string[] }) {
  const [text, setText] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((r) => { timer = setTimeout(r, ms); });

    let idx = 0;
    const loop = async () => {
      while (!cancelled) {
        const prompt = prompts[idx];
        for (let i = 1; i <= prompt.length && !cancelled; i++) {
          await sleep(80);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;
        await sleep(1500);
        if (cancelled) break;
        for (let i = prompt.length - 1; i >= 0 && !cancelled; i--) {
          await sleep(50);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;
        await sleep(400);
        if (cancelled) break;
        idx = (idx + 1) % prompts.length;
      }
    };

    loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [prompts]);

  return (
    <Text
      style={[st.placeholder, { fontSize: size }]}
      numberOfLines={1}
      pointerEvents="none"
    >
      {text}
    </Text>
  );
}

// ONE CHARACTER OF THE WAVE, and the reason this is a COMPONENT rather than a
// row of unrolled hooks in the bar.
//
// HOOKS CANNOT BE CALLED IN A LOOP, and the labels are 4, 7, 8 and 6 characters
// long, so there is no fixed number to unroll to. A component solves it exactly:
// hooks are per INSTANCE, so mapping over the characters creates twenty-five
// instances each calling useAnimatedStyle exactly once, unconditionally. Nothing
// is looped or branched at the hook level at all. Adding the fourth tab needed
// no change here, which is the whole reason it is a component.
//
// GROWTH AND COLOUR IN ONE STYLE, ON ONE NODE. They come from the same t, and
// putting them in the same object is what keeps the character count of animated
// nodes at twenty-five rather than fifty.
//
// THE CELL AROUND IT IS A PLAIN VIEW and it is what holds the advance. The Text
// is left content-sized inside it, so a glyph whose measured width rounds up
// past 6.0 has somewhere to go instead of being clipped by its own box.
//
// SHARED VALUES ARRIVE AS PROPS, which is the ordinary way to do this: they are
// the same objects the bar holds, so reading .value here registers the same
// dependencies it would there.
type WaveCharProps = {
  ch: string;
  index: number;
  offset: number;
  slotsSV: SharedValue<Slot[]>;
  capX: SharedValue<number>;
  capR: SharedValue<number>;
  pressAmt: SharedValue<number>;
  dragAmt: SharedValue<number>;
  // THE FALLOFF'S TWO RADII, as props rather than module constants, because they
  // derive from the pill and the pill derives from the screen. See STACK radii.
  fullR: number;
  zeroR: number;
  // THERE IS NO SEARCH-MODE OVERRIDE ANY MORE, and this note is what is left of
  // it because the reason it went is worth keeping.
  //
  // IT EXISTED to paint Home's icon a colour of its own while the bar was
  // collapsed: first green, then a full-weight grey. Home is INK_INACTIVE in
  // search mode now, and INK_INACTIVE is where the wave ALREADY leaves it — the
  // pill is on the Search slot, 277.50 away against a zeroR of 70.80, so t is 0
  // at Home and the first branch returns exactly that colour. An interpolation
  // from INK_INACTIVE to INK_INACTIVE is not merely equivalent to doing nothing;
  // it is a longer way of writing it.
  //
  // AND THE WAVE'S VERSION IS BETTER, which is the part that makes this a
  // simplification rather than a tidy-up. The override cut to its colour as soon
  // as its own value left 0; the wave FADES, because t falls as the pill travels
  // away from Home. Leaving search mode now looks exactly like leaving any tab.
  //
  // IF A COLOUR IS EVER WANTED THERE AGAIN it is two props and one ternary, and
  // the shape is in the history.
};

function WaveChar({
  ch, index, offset, slotsSV, capX, capR, pressAmt, dragAmt, fullR, zeroR,
}: WaveCharProps) {
  const anim = useAnimatedStyle(() => {
    const t = waveAt(index, offset, slotsSV.value, (capX.value + capR.value) / 2, fullR, zeroR);
    // 7pt held, 5pt dragged, and every value between while dragAmt is moving.
    const peak = STACK_SCALE_PRESS + dragAmt.value * (STACK_SCALE_DRAG - STACK_SCALE_PRESS);
    return {
      transform: [{ scale: 1 + pressAmt.value * t * (peak - 1) }],
      color: interpolateColor(t, [0, 1], [INK_INACTIVE, INK_WAVE]),
    };
  });
  return (
    <View style={st.cell}>
      <Reanimated.Text style={[st.label, anim]}>{ch}</Reanimated.Text>
    </View>
  );
}

// THE ICON, WHICH CANNOT BE SPLIT, so it takes the wave as one unit at offset 0
// — the slot's own centre, which is where it is drawn. Same falloff, same
// radii, same amplitudes as every character; only its centre differs.
//
// TWO ANIMATED NODES RATHER THAN ONE, and that is forced rather than chosen: the
// scale is a STYLE on a view and the colour is a PROP on an SVG element, and
// Reanimated cannot carry both on one node. The stroke therefore needs
// createAnimatedComponent — a plain <G stroke={...}> would take a colour but not
// an animated one — which is the same pattern AnimatedRect already uses for the
// border mask. waveAt is called in both hooks: one implementation, evaluated
// twice, because they are two different animated targets.
type WaveIconProps = {
  paths: string[];
  index: number;
  slotsSV: SharedValue<Slot[]>;
  capX: SharedValue<number>;
  capR: SharedValue<number>;
  pressAmt: SharedValue<number>;
  dragAmt: SharedValue<number>;
  // As WaveChar's, and for the same reason.
  fullR: number;
  zeroR: number;
};

function WaveIcon({
  paths, index, slotsSV, capX, capR, pressAmt, dragAmt, fullR, zeroR,
}: WaveIconProps) {
  const boxStyle = useAnimatedStyle(() => {
    const t = waveAt(index, 0, slotsSV.value, (capX.value + capR.value) / 2, fullR, zeroR);
    const peak = STACK_SCALE_PRESS + dragAmt.value * (STACK_SCALE_DRAG - STACK_SCALE_PRESS);
    return { transform: [{ scale: 1 + pressAmt.value * t * (peak - 1) }] };
  });
  const strokeProps = useAnimatedProps(() => ({
    stroke: interpolateColor(
      waveAt(index, 0, slotsSV.value, (capX.value + capR.value) / 2, fullR, zeroR),
      [0, 1],
      [INK_INACTIVE, INK_WAVE],
    ),
  }));
  return (
    <Reanimated.View style={boxStyle}>
      {/* index.tsx's icon convention exactly: 22 over a 24 viewBox, no fill,
          1.75 stroke, round caps and joins. Matching it is what stops the bar's
          glyphs reading as a different set from the swipe actions'. The stroke
          is set on the G and inherited, so `profile`'s two paths cannot drift
          apart in colour. */}
      <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24">
        <AnimatedG
          animatedProps={strokeProps}
          fill="none"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {paths.map((d) => (
            <Path key={d} d={d} />
          ))}
        </AnimatedG>
      </Svg>
    </Reanimated.View>
  );
}

// The mask's hole is the only SVG geometry here that has to move every frame,
// so it is the only element that needs wrapping. Module scope: wrapping on each
// render would remount the node.
const AnimatedRect = Reanimated.createAnimatedComponent(Rect);

type Slot = { x: number; w: number };

export default function GlassTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width: windowW } = useWindowDimensions();
  const [slots, setSlots] = useState<(Slot | null)[]>(() => ITEMS.map(() => null));

  // WHAT THE BAR IS ACTUALLY WIDE, and the root of the whole horizontal layout
  // now rather than something derived from one. The dock spans the window and
  // pads by DOCK_INSET a side, and the shell is alignItems stretch inside it.
  // shellBox reports the same number a frame later; it is computed here because
  // the press scale has to be right on the FIRST frame of a press.
  //
  // EVERYTHING BELOW FOLLOWS FROM IT, and every one of these was a module
  // constant until the bar stopped being a fixed width. They are ordinary render
  // values now, which is the correct shape for them: the component re-renders
  // when useWindowDimensions reports a change, so a rotation or a split view
  // recomputes the lot without anything having to invalidate a cache.
  const barW = windowW - DOCK_INSET * 2;
  const barScaleX = (barW + BAR_GROW * 2) / barW;
  const slotW = barW / ITEMS.length;
  // THE 2pt INSET, EXPRESSED. See the note where PILL_W used to be declared.
  const pillW = slotW - END_GAP * 2;
  // The wave's two radii, in the pill's own terms exactly as before: full growth
  // within a quarter of the pill, nothing beyond four fifths of it. At 402 that
  // is 22.13 and 70.80 against a 92.50 slot pitch, so a resting pill still
  // reaches no further than its own tab.
  const stackFullR = pillW / 4;
  const stackZeroR = pillW * 0.8;
  // 10pt on every side is a bigger SHARE of a narrower pill, which is why this
  // was always derived rather than written down: 1.225989 at 402, 1.244648 at
  // 375. The overhang past the bar's inner edge stays PRESS_GROW - END_GAP = 8
  // at any width, because both of those are absolute.
  const pressScaleX = (pillW + PRESS_GROW * 2) / pillW;

  // THE OTHER HALF OF THE AVAILABILITY QUESTION, which the package's own doc
  // comment sends us here for: Reduce Transparency can be on while
  // isLiquidGlassAvailable() still reports true. Someone who has asked the
  // system for less transparency should get our flat stack, not a live glass
  // effect the OS has been told to tone down.
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    let alive = true;
    // iOS-only in the typings; on Android it is allowed to reject, and a
    // rejection here must not take the bar down with it.
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => { if (alive) setReduceTransparency(v); })
      .catch(() => {});
    // VERIFIED PRESENT rather than assumed: 'reduceTransparencyChanged' is in
    // this RN's AccessibilityChangeEventName union, and addEventListener is
    // typed to return an EmitterSubscription, so there is a .remove() to call.
    const sub = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (v) => setReduceTransparency(v),
    );
    return () => { alive = false; sub.remove(); };
  }, []);

  const useGlass = GLASS_SUPPORTED && !reduceTransparency;

  const focusedRoute = state.routes[state.index]?.name;
  // -1 while the focused screen is one this bar does not list — PROFILE, now
  // that it has left the bar, and _sitemap and +not-found.
  //
  // NOTHING IS HIGHLIGHTED THEN, and this comment used to claim that while the
  // code did the opposite. The placement effect returned early on -1 without
  // touching anything, so the pill stayed exactly where it was, at full opacity,
  // with the wave still green under it: open Profile from Home and Home went on
  // looking selected. The effect fades it out now. See there.
  const activeIndex = ITEMS.findIndex((it) => it.route === focusedRoute);

  // TWO EDGES, NOT A POSITION AND A WIDTH, and that choice is what makes the
  // squash fall out instead of being staged.
  //
  // A pill described as (x, width) has to be TOLD to compress: something must
  // decide that this arrival is an end arrival, hold x still, and drive width
  // through a separate curve. Described as two edges, each with its own spring,
  // the compression is just what happens when one edge is allowed to overshoot
  // and the other is not. The middle tab needs no special case at all: both
  // edges take the same spring, so they move identically and the width between
  // them never changes.
  //
  // The style derives width as capR - capX. Neither value is the width; the
  // width is the gap between them.
  const capX = useSharedValue(0);   // left edge, in track coordinates
  const capR = useSharedValue(0);   // right edge
  const capOpacity = useSharedValue(0);

  // THE GESTURE'S COPY OF WHAT THE LAYOUT MEASURED. The pan runs on the UI
  // thread and cannot read React state, so the same measurements are mirrored
  // into a shared value. This is NOT a second measurement path: onSlotLayout is
  // still the only thing that measures anything, and this is written from it.
  const slotsSV = useSharedValue<Slot[]>([]);
  const trackW = useSharedValue(0);
  const activeSV = useSharedValue(-1);
  // Which index the drag has already acted on. The navigation fires when this
  // CHANGES, so a finger sitting still inside one item's range does not
  // re-navigate on every frame.
  const lastCommitted = useSharedValue(-1);
  // While true the effect below leaves the capsule alone: during a drag the
  // finger owns its position, and navigating mid-drag would otherwise spring it
  // away from the finger it is supposed to be following.
  const dragging = useSharedValue(false);
  // The press response. It EXPANDS under the finger rather than shrinking, so
  // the highlight comes up to meet the press. Its own value rather than a branch
  // inside the position style, so a press and a move compose instead of one
  // overwriting the other.
  //
  // A PROGRESS, NOT A SCALE. It runs 0 at rest to 1 held down and the style
  // interpolates each axis from it. One spring rather than two: two values on
  // one config would stay in step by coincidence, and this way they cannot drift
  // at all. The factors themselves are at PRESS_GROW.
  //
  // IT OVERHANGS, AND IT IS ALLOWED TO. 10pt on every side against a 2pt resting
  // gap puts the pill 8pt past the bar's inner edge on the first and last
  // tabs, and 7pt above and below the bar — CAPSULE_TOP is 3, and unaffected by
  // END_GAP, which is horizontal.
  //
  // THE BAR NOW COMES OUT TO MEET IT, which takes the edge off that figure
  // without capping anything: the surface grows 3 on the same trigger, so the
  // pill ends up 5 past the grown bar rather than 8 past a still one. Everything
  // else the pill does happens on its own and must stay off the glass; a press
  // is a finger held on the control, so a highlight that grows past the edge
  // under it reads as the control answering rather than as a bug. It is
  // therefore NOT clamped and NOT reduced on the end tabs — identical on all
  // three, which is the point.
  //
  // NOTHING CLIPS IT. The pill is a sibling of the clip inside st.shell, and
  // neither the shell nor the dock sets overflow; the shell's own shadow already
  // paints well outside its bounds, which is the proof no ancestor masks it.
  //
  // IT COMPOSES WITH THE SQUASH rather than contending with it. The squash moves
  // the edges, which is width and translateX; these are scales, applied after
  // both in the same transform list. A press mid-squash scales whatever width
  // the pill happens to have at that instant rather than fighting it.
  const pressAmt = useSharedValue(0);
  // WHETHER THIS IS A DRAG, AS A PROGRESS RATHER THAN A FLAG. pressAmt cannot
  // answer it — it is 1 for a press, a hold and a drag alike, which is correct
  // for everything else that reads it and useless here. `dragging` DOES answer
  // it, but it is a boolean that flips in onStart and onFinalize, and reading it
  // directly would step the stack between 3pt and 2pt in one frame.
  //
  // SO IT IS THE SAME QUESTION, SPRUNG. Written from exactly the two places
  // `dragging` is written, on PRESS_SPRING, so the 3-to-2 change eases over its
  // 129ms instead of snapping. Nothing else reads it and nothing branches on it;
  // it is only ever an interpolation weight.
  const dragAmt = useSharedValue(0);
  // SEARCH MODE, ON THE UI THREAD, for the same reason activeSV exists: the
  // pan's callbacks are worklets and cannot read React state. Written by an
  // effect below, read by the touch guard that replaced .enabled().
  const searchSV = useSharedValue(false);

  // THE SHELL'S OWN BOX, measured, because the border is an SVG stroke again and
  // a Rect needs pixel dimensions: SVG has no way to say "100% minus one point",
  // and a stroke centred on a rect at the exact bounds would put half of itself
  // outside them. Compare before setting, so a layout pass reporting the same
  // numbers does not re-render.
  const [shellBox, setShellBox] = useState<{ w: number; h: number } | null>(null);
  const onShellLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    // A ZERO BOX IS NEVER WORTH REPORTING. A 0 by 0 report would size the
    // border's mask to nothing and leave it there until the next real pass,
    // and the last real measurement is always still correct.
    //
    // IT IS A SAFETY NET NOW RATHER THAN LOAD-BEARING. It was added when the
    // shell took display: 'none' while the full field was up, which removed it
    // from layout; the shell is translated off-screen instead now, so it stays
    // in layout and reports its true box in every state. Kept because a guard
    // against a degenerate measurement costs nothing.
    if (width === 0 || height === 0) return;
    setShellBox((prev) => (prev !== null && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  };

  // THE DEFERRED RELEASE. onPressOut no longer collapses the pill itself; it
  // asks for a collapse in PRESS_RELEASE_DELAY, and anything that means the
  // gesture is still alive takes that request back.
  const pressOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WHEN THE PILL IS ALLOWED TO SHRINK, as an absolute timestamp rather than a
  // duration, because the wait belongs to the PRESS and the release handler runs
  // at an unknown time after it. Written on every press-in; read once on the way
  // out. See PRESS_TRAVEL_SETTLE_MS.
  const releaseAt = useRef(0);

  // WHETHER THIS PRESS FOUND THE BAR ALREADY COLLAPSED, and it exists because
  // the Search tab now changes that answer between its own press-in and its own
  // release.
  //
  // WHAT IT DISAMBIGUATES. Pressing Search in normal mode collapses the bar at
  // touch-down; by the time onPress runs, searchMode is true and the handler
  // takes the search-mode branch, where pressing the pill OPENS THE FULL FIELD.
  // Without this the one press would collapse the bar and raise the keyboard.
  //
  // WRITTEN ON EVERY PRESS-IN, which is what keeps it honest: it is a snapshot
  // of the mode at the moment the finger landed, not a flag anything has to
  // remember to clear. A press that is cancelled leaves it stale for exactly as
  // long as it takes the next press to begin.
  const pressBeganInSearch = useRef(false);

  const cancelPressRelease = () => {
    if (pressOutTimer.current === null) return;
    clearTimeout(pressOutTimer.current);
    pressOutTimer.current = null;
  };

  // THE GUARD LIVES HERE, NOT IN onPressOut, and that is the whole trick. By the
  // time this runs the ordering has resolved: if a drag started at all, onStart
  // has been through and `dragging` is true. It is the same test that could not
  // work earlier, asked 60ms later, when the answer is finally available.
  //
  // IT IS NOT REDUNDANT WITH THE CANCEL. A fast flick reverses the order — the
  // pan can activate inside 40ms while Pressability is still holding onPressOut
  // back to its 130ms floor, so onStart runs FIRST, cancels nothing, and then
  // onPressOut schedules a release into the middle of a live drag. This is what
  // catches that one.
  const releasePress = () => {
    pressOutTimer.current = null;
    if (dragging.value) return;
    pressAmt.value = withSpring(0, PRESS_SPRING);
  };

  // THE LARGER OF THE TWO WAITS, and never less than the drag's window.
  //
  // IT CANNOT STRAND THE PILL AT FULL SIZE, and that is four separate paths
  // rather than one guarantee:
  //   - a normal lift schedules this, and releasePress springs pressAmt to 0;
  //   - a CANCELLED press still calls onPressOut, because Pressability
  //     deactivates on a cancellation as well as on a lift;
  //   - a press that becomes a DRAG has its timer cancelled in the pan's
  //     onStart, and the pan's onFinalize then releases pressAmt
  //     unconditionally, above its own guard, on a lift AND on a cancellation;
  //   - a fast re-press cancels the pending timer in onPressIn before arming a
  //     new one, so two presses cannot leave two timers.
  // The longer wait widens the window in which all four matter; it does not add
  // a way out of them.
  const schedulePressRelease = () => {
    cancelPressRelease();
    const wait = Math.max(releaseAt.current - Date.now(), PRESS_RELEASE_DELAY);
    pressOutTimer.current = setTimeout(releasePress, wait);
  };

  // A timer that outlives the component would call withSpring on a value whose
  // component has gone.
  useEffect(() => () => {
    if (pressOutTimer.current !== null) clearTimeout(pressOutTimer.current);
  }, []);
  // The fallback pill's frost, faded rather than swapped. See capsuleInner.
  const frostOpacity = useSharedValue(1);

  // SEARCH MODE, AND IT LIVES HERE BECAUSE IT IS A STATE OF THE BAR. Nothing
  // navigates to it and no screen owns it: the bar is showing four tabs or it is
  // showing one tab and a field, and that is a fact about the bar.
  //
  // THREE PIECES, not one. `searchMode` is whether the bar has collapsed;
  // `typing` is whether the full field is up, which is a strictly smaller state
  // inside it; `query` is what has been typed. Collapsing them would make
  // dismissing the keyboard indistinguishable from leaving search mode, and
  // those are deliberately different things.
  const [searchMode, setSearchMode] = useState(false);
  const [typing, setTyping] = useState(false);
  // NOT PERSISTED AND NOT READ BY ANYTHING. It is here so the field is
  // controlled and the placeholder knows whether to show; submitting does
  // nothing yet, by design. When a provider is wired in, this is what it reads.
  const [query, setQuery] = useState('');
  // The keyboard's height, from its own events. See the listener below.
  const [kbH, setKbH] = useState(0);
  // THE NAME IN THE PROMPT, read the way profile.tsx reads it rather than passed
  // in: the bar is not a child of any screen and has nobody to be handed it by.
  // 'terminal' is index.tsx's own fallback and is what shows before the read
  // lands, so the prompt never renders empty.
  const [searchName, setSearchName] = useState('terminal');
  // THE TRANSITION IS A BOOLEAN NOW, AND searchAmt IS GONE.
  //
  // WHAT IT WAS. A 0-to-1 spring that four styles read: the bar's glass and its
  // hairline faded out on 1 - searchAmt, the oval and Home's circle faded in on
  // searchAmt, and two of the four tab items faded out on it as well. One value,
  // one cross-fade, both modes on screen for the length of it.
  //
  // WHY IT COULD NOT WORK. THREE of those five surfaces are BlurViews, and on
  // iOS a UIVisualEffectView does not honour an animated ancestor's alpha —
  // Apple documents that a visual-effect view has to be composited with the
  // content it overlays and warns against alpha below 1. The objects had already
  // been moved off opacity onto an unmount for exactly that reason; the shell's
  // own glass never was, so it went on painting under the search objects and
  // came back a second later when something forced a recomposite.
  //
  // SO NOTHING FADES. Every element of each mode is gated on `searchMode` and
  // nothing else. One render ends one mode and begins the other, and React
  // commits a render atomically, so there is no frame in which any part of both
  // exists — which is a guarantee about the tree rather than about opacity, and
  // therefore one a BlurView cannot break.
  //
  // IT IS ABRUPT, and that is the trade, taken deliberately: a cut that is
  // always right beats a cross-fade that is right on paper and wrong on glass.
  //
  // THE PILL IS NOT PART OF THIS. It still travels between slots and still fades
  // on capOpacity, which is its own value and has nothing to do with the mode.
  // HOME'S PRESS, and it is NOT pressAmt. pressAmt belongs to the tracking pill,
  // which in search mode is the OTHER object; writing it from Home would bulge
  // the search pill when Home was pressed. One value each, and neither can move
  // the other. See the note at SEARCH_OBJ_GAP for the factors.
  const homeAmt = useSharedValue(0);
  // THE X'S PRESS, and a third value for the same reason there is a second: the
  // X is its own object and must bulge alone. Nothing else reads it.
  const closeAmt = useSharedValue(0);

  // THE GLASS PATH NEEDS THIS IN RENDER, not on the UI thread: glassEffectStyle
  // is a prop, so swapping it is a re-render rather than an animated value.
  // Two renders a gesture, which is why it is separate from `dragging` rather
  // than replacing it.
  const [dragActive, setDragActive] = useState(false);

  // WHERE THE FULL FIELD LEARNS TO SIT. The Will events on iOS fire before the
  // keyboard moves, so the field travels with it rather than after it; Android
  // only has the Did pair, which is why the name is chosen per platform rather
  // than hardcoded.
  //
  // HIDING IS ALSO HOW TYPING ENDS. Dismissing the keyboard — by the accessory
  // button, by a swipe, by anything — closes the full field and leaves the bar in
  // search mode, which is the behaviour asked for: the keyboard going away is
  // not the same as leaving search.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvt, (e) => setKbH(e.endCoordinates.height));
    const onHide = Keyboard.addListener(hideEvt, () => { setKbH(0); setTyping(false); });
    return () => { onShow.remove(); onHide.remove(); };
  }, []);

  // READ WHEN SEARCH OPENS rather than once at mount, so a name set on the
  // profile screen is in the prompt the next time the field is used rather than
  // the next time the app is launched. The same two branches profile.tsx uses,
  // and the same precedence index.tsx uses: the display name if there is one,
  // the username otherwise, lowercased.
  useEffect(() => {
    if (!searchMode) return;
    let alive = true;
    const take = (dn: string | null, un: string | null) => {
      if (!alive) return;
      const n = dn ?? un;
      setSearchName(n !== null && n !== '' ? n.toLowerCase() : 'terminal');
    };
    if (Platform.OS === 'web') {
      take(localStorage.getItem('displayName'), localStorage.getItem('username'));
    } else {
      Promise.all([
        SecureStore.getItemAsync('displayName'),
        SecureStore.getItemAsync('username'),
      ]).then(([dn, un]) => take(dn, un)).catch(() => {});
    }
    return () => { alive = false; };
  }, [searchMode]);

  // THE X COMES BACK DOWN WHEN THE FIELD GOES, and it has to be done from here
  // rather than from the button's own onPressOut.
  //
  // WHAT WAS WRONG. Tapping the X calls setTyping(false), which unmounts the
  // button that was pressed. Pressability's release path runs _deactivate FIRST
  // and, for a press shorter than its DEFAULT_MIN_PRESS_DURATION of 130ms, does
  // not call onPressOut at all — it schedules it on _pressOutDelayTimeout
  // (Pressability.js:786) and then calls onPress synchronously. Our onPress
  // unmounts the Pressable, whose reset() cancels that timeout and freezes the
  // config, so onPressOut never arrives. closeAmt is a shared value on the BAR,
  // which does not unmount, so it stayed at 1 and the X came back next time at
  // its pressed size. A press held past 130ms fixed it, because then
  // delayPressOut is 0 and onPressOut fires before onPress — which is exactly
  // the "only if pressed and held again" that was reported.
  //
  // THE FIELD'S LIFECYCLE IS THE HONEST OWNER. `typing` false means the button
  // does not exist, and a button that does not exist is not pressed. This covers
  // every way the field closes rather than the one the X takes: the keyboard
  // swiped away, Home leaving search mode, the route guard, and the X itself.
  //
  // A PLAIN ASSIGNMENT, NOT A SPRING. There is nothing on screen to animate —
  // the button has already gone — and springing a value nobody is watching is
  // just a value that is briefly wrong.
  useEffect(() => {
    if (!typing) closeAmt.value = 0;
  }, [typing, closeAmt]);

  // IT SHOULD NOT BE POSSIBLE TO SIT HERE, and this is what happens if it is.
  //
  // HOME CHANGES THE ROUTE NOW, so the bar itself can reach this state where it
  // could not before: pressing Home navigates to `index` AND leaves search mode,
  // in one batch. This effect sees the render where both have landed and returns
  // on its first test, so it does not fire and there is nothing to race. What it
  // still catches is the two coming APART, which only something outside the bar
  // can do — a deep link, a back gesture, a notification. If the focused route
  // stops being `search` while the bar has not been told, the bar is showing a
  // field for a screen that is no longer open. So it leaves search mode and puts
  // the keyboard away, rather than sitting in a state its own exit no longer
  // matches.
  // AND IT LEAVES EXACTLY THE STATE THE OTHER EXIT LEAVES. It used to reset two
  // of the four and rely on a keyboard event for the rest, which is how the two
  // ways out came to differ: `query` survived this path, and `kbH` survived
  // both, so what the field did next depended on which exit had been taken and
  // whether a hide event had actually arrived. Neither is a thing to leave to an
  // event. See the note on kbH.
  useEffect(() => {
    if (!searchMode || activeIndex === SEARCH_INDEX) return;
    setSearchMode(false);
    setTyping(false);
    setQuery('');
    setKbH(0);
    Keyboard.dismiss();
  }, [searchMode, activeIndex]);

  // MEASURED, NOT ASSUMED. Each label reports its own box, so the capsule fits
  // the word rather than a guess at the word's width — which would be wrong the
  // moment a label changes or the font metrics differ by a point.
  const onSlotLayout = (i: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setSlots((prev) => {
      const cur = prev[i];
      if (cur !== null && cur.x === x && cur.w === width) return prev;   // same box: no re-render
      const next = prev.slice();
      next[i] = { x, w: width };
      return next;
    });
  };

  const onTrackLayout = (e: LayoutChangeEvent) => { trackW.value = e.nativeEvent.layout.width; };

  useEffect(() => {
    activeSV.value = activeIndex;
    const done = slots.filter((s): s is Slot => s !== null);
    if (done.length === ITEMS.length) slotsSV.value = done;
  }, [activeIndex, slots, activeSV, slotsSV]);

  // AND THE MODE ITSELF, mirrored for the pan. Its own effect rather than a line
  // in the one above, because it answers a different question and has one
  // dependency.
  useEffect(() => { searchSV.value = searchMode; }, [searchMode, searchSV]);

  // THE PILL IS NOT THE SLOT ANY MORE. It is pillW wide wherever it stands, and
  // this places it by centring that fixed width in whichever slot is active.
  //
  // WHY IT STOPPED BEING DERIVED. While the width came from the slot, every
  // change to the bar's inset or to TRACK_PAD resized the pill as a side effect
  // — the two could not be tuned independently. Fixing the width broke that
  // coupling, which is what let TRACK_PAD go to 0 without the pill growing.
  //
  // THE CENTRING IS NOT A NO-OP, and no longer could be: the slot is 92.50
  // against an 88.50 pill at 402, so slot.x + slot.w/2 - pillW/2 puts END_GAP
  // either side at any screen size.
  // That difference IS the gap at the ends of the bar, and it is END_GAP.
  useEffect(() => {
    // NOT ONE OF OURS, SO NOTHING IS LIT. The pill is faded out rather than
    // moved, because there is nowhere correct to move it to: every slot belongs
    // to a tab that is not the open route.
    //
    // A TIMING, NOT A SPRING. Nothing is travelling, so there is no momentum to
    // express and nothing for an overshoot to mean; 140ms is what capOpacity
    // already fades in over at launch, and using the same number means
    // appearing and disappearing take the same time.
    // AND SEARCH MODE IS NO LONGER ONE OF THOSE CASES. It used to be: the pill
    // faded out here on the way in while a separate magnifier circle faded in
    // three slots away, which read as the pill shooting off and an unrelated
    // object arriving to replace it. THE PILL IS THE SEARCH OBJECT. It is
    // already standing on the Search slot when that tab is tapped — the press
    // travel put it there — so it stays exactly where it is and the bar
    // collapses around it.
    //
    // NOTHING WAS ADDED TO DO THAT: a condition was removed. `|| searchMode`
    // came out of the test below and out of this effect's dependency list with
    // it, because nothing in here reads it any more. THE UNLISTED-ROUTE FADE IS
    // UNTOUCHED and is now the only thing that empties the bar.
    //
    // WHAT IT COSTS ON THE WAY OUT is that the pill TRAVELS back rather than
    // landing: capOpacity stays at 1 through search mode, so leaving it takes
    // the else branch below and springs the pill from the Search slot to
    // whichever tab the exit navigated to. That is the correct reading of the
    // new premise rather than a regression — the search object turns back into
    // the pill and slides home, which is the same journey any tab press makes.
    if (activeIndex < 0) {
      capOpacity.value = withTiming(0, { duration: 140 });
      return;
    }
    const slot = slots[activeIndex];
    if (!slot) return;
    // CENTRED IN THE SLOT, which is the one thing the measurement is still for.
    // The width is pillW and does not come from here; the slot only says where.
    //
    // The scan for a complete set of slots has gone with the Math.max it fed:
    // placing the pill needs the ACTIVE slot and nothing else, and the guard
    // above already establishes that one. The gesture's own copy of all three is
    // still assembled by the effect above this, untouched.
    const target = slot.x + slot.w / 2 - pillW / 2;
    const restR = target + pillW;

    if (dragging.value) return;          // the finger has it; see `dragging`
    if (capOpacity.value < 1) {
      // THE FIRST MEASUREMENT LANDS, IT DOES NOT TRAVEL. Both edges start at 0,
      // so springing to the first target would drag the pill in from the track's
      // left edge on launch. It is placed silently and then faded up instead.
      //
      // AND COMING BACK FROM AN UNLISTED ROUTE TAKES THE SAME PATH, which is why
      // the test is `< 1` rather than `=== 0`. Returning from Profile the pill
      // is invisible and has no meaningful position, so it should land on the
      // new tab rather than slide there from a stale one. `=== 0` would have
      // missed the case where the fade-out was still in flight: capOpacity would
      // be a fraction, the else branch would spring the pill while it sat at
      // partial opacity, and nothing would ever restore it to 1.
      capX.value = target;
      capR.value = restR;
      capOpacity.value = withTiming(1, { duration: 140 });
    } else {
      // NO SQUASH ON ARRIVAL, AND THE WAY TO GET THAT IS TO STOP ASKING THE TWO
      // EDGES TO DISAGREE. The compression was never staged: it fell out of the
      // leading edge taking the pinned spring while the trailing edge took the
      // ordinary one, so one stopped dead and the other carried past. Give both
      // edges the SAME config and they trace the same normalised curve from the
      // same width to the same width, so the gap between them cannot move. The
      // pill travels and stops.
      //
      // AND THERE IS ONLY ONE CONFIG LEFT TO GIVE THEM. The per-tab branch is
      // gone with SPRING_PINNED: every tab, end or middle, arrives on SPRING,
      // overshoots 0.629% and settles. The ends can afford it now — 1.745pt
      // against an END_GAP of 2.00 at 402, and less on every narrower screen.
      // See SPRING for the table.
      capX.value = withSpring(target, SPRING_END);
      capR.value = withSpring(restR, SPRING_END);
    }
  }, [activeIndex, slots, capX, capR, capOpacity, dragging]);

  // translateX THEN scale, in that order: a transform list is applied in order
  // and scale takes the element's own centre, so the pill grows about its own
  // middle rather than sliding as it grows. Width comes from the two edges.
  const capsuleStyle = useAnimatedStyle(() => ({
    opacity: capOpacity.value,
    width: capR.value - capX.value,
    // Translate, then the scales about the element's own centre, so the pill
    // grows where it stands — and, during a drag, grows around wherever the
    // finger has put it. scaleX and scaleY rather than scale, because 7pt on a
    // 88.50 side and 7pt on a 56 side are not the same proportion. The order is
    // what makes the two compose: the translate places the box, the scales
    // enlarge whatever box that is. See PRESS_GROW.
    transform: [
      { translateX: capX.value },
      { scaleX: 1 + pressAmt.value * (pressScaleX - 1) },
      { scaleY: 1 + pressAmt.value * (PRESS_SCALE_Y - 1) },
    ],
  }));

  // THE SAME MOTION WITHOUT THE OPACITY, and the omission is the point. See the
  // note at the glass capsule.
  //
  // AND WITHOUT THE PRESS SCALE. isInteractive is already true on the glass
  // pill, which is Apple's own press response for this material; a scale of
  // ours on top would be two reactions to one finger. The fallback has no
  // native response of its own, so there the scale IS the response.
  const capsuleGlassStyle = useAnimatedStyle(() => ({
    width: capR.value - capX.value,
    transform: [{ translateX: capX.value }],
  }));

  // Fades the fallback pill's blur out for the length of a drag. Separate from
  // the position style so a press, a move and the frost never contend for one
  // style object.
  const frostStyle = useAnimatedStyle(() => ({ opacity: frostOpacity.value }));

  // THE BAR'S OWN ANSWER TO THE FINGER, on the SAME pressAmt the pill uses. One
  // progress value, two surfaces reading it: a second spring would stay in step
  // only by coincidence, and the two would drift the first time either config
  // was touched. See BAR_GROW.
  //
  // SCALES ONLY, no translate: the surface is absoluteFill inside the shell, so
  // it already sits where it belongs and scaling takes its own centre. That
  // centre is what edgeHoleProps below inverts against.
  const barSurfaceStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleX: 1 + pressAmt.value * (barScaleX - 1) },
      { scaleY: 1 + pressAmt.value * (BAR_SCALE_Y - 1) },
    ],
  }));

  // THE HOLE IN THE BAR'S BORDER, and it is the pill's LIVE box rather than its
  // resting one. It reads the same three values the pill's own style reads —
  // capX, capR and pressAmt — so it follows the drag, the squash and the press
  // expansion frame for frame, on the UI thread, with no re-render.
  //
  // THE SCALES ARE APPLIED THE SAME WAY THE TRANSFORM APPLIES THEM: about the
  // box's own centre. That is why this works out the centre first and grows from
  // it, rather than scaling the left edge and the width independently.
  //
  // TRACK_PAD converts track coordinates to the shell's, which is what the Svg
  // is laid out in. It is 0 today and written anyway, for the same reason
  // st.capsule's `left` is.
  //
  // AND THEN IT UNDOES THE SURFACE'S SCALE, which is the whole reason this got
  // longer. The Svg now lives INSIDE the scaled surface, so everything drawn in
  // it is scaled again on the way to the screen; the pill does not, because it
  // is a sibling of the surface rather than a child. Left alone, the hole would
  // drift off the pill the moment a press began — by 1.9% of the distance from
  // the bar's centre horizontally and 9.7% vertically, which at the end tabs is
  // several points.
  //
  // SO THE HOLE IS DRAWN AT THE PRE-IMAGE of where it has to land. A scale about
  // a known centre is an invertible affine map, so the correction is exact
  // rather than approximate: divide the offset from the centre by the factor,
  // and the surface's own scale multiplies it straight back. An axis-aligned
  // scale also takes a rounded rect to a rounded rect, with rx and ry scaling
  // independently, so the shape survives the round trip too — which is why rx
  // and ry are divided by DIFFERENT factors here and come out equal on screen.
  const shellW = shellBox !== null ? shellBox.w : 0;
  const shellH = shellBox !== null ? shellBox.h : BAR_H;
  const edgeHoleProps = useAnimatedProps(() => {
    const w = capR.value - capX.value;
    const sx = 1 + pressAmt.value * (pressScaleX - 1);
    const sy = 1 + pressAmt.value * (PRESS_SCALE_Y - 1);
    const halfW = (w * sx) / 2;
    const halfH = (CAPSULE_H * sy) / 2;
    // Where the hole has to END UP, in the shell's coordinates: the pill's live
    // box, exactly as before.
    const cx = TRACK_PAD + capX.value + w / 2;
    const cy = CAPSULE_TOP + CAPSULE_H / 2;
    // The surface's scale, about the shell's centre.
    const bsx = 1 + pressAmt.value * (barScaleX - 1);
    const bsy = 1 + pressAmt.value * (BAR_SCALE_Y - 1);
    const ox = shellW / 2;
    const oy = shellH / 2;
    // The pre-image of that box under the surface's scale.
    const lcx = ox + (cx - ox) / bsx;
    const lcy = oy + (cy - oy) / bsy;
    const lHalfW = halfW / bsx;
    const lHalfH = halfH / bsy;
    return {
      x: lcx - lHalfW,
      y: lcy - lHalfH,
      width: lHalfW * 2,
      height: lHalfH * 2,
      rx: halfH / bsx,
      ry: halfH / bsy,
    };
  });

  // THE GROWTH FOLLOWS THE PILL, and it is now measured PER CELL rather than per
  // item. The falloff, its radii and its amplitudes live at waveAt now, one copy
  // serving the four icons and the twenty-five characters alike; what is left
  // here is the wiring.
  //
  // WHY IT FOLLOWS THE PILL RATHER THAN THE ROUTE: activeIndex is React state
  // that updates a render behind the finger, while capX and capR are where the
  // pill actually is this frame. The same two values the border mask reads,
  // asked a different question.

  // WHERE THE THREE OBJECTS SIT, in track coordinates. Plain numbers rather than
  // animated values, because none of them moves: the geometry is final from the
  // first frame and the only thing that animates at all is a press scale.
  //
  //   home   slotW/2 - 28 .. slotW/2 + 28     18.25 ..  74.25 at 402
  //                                           14.88 ..  70.88 at 375
  //   oval   home + 8 .. pill's RIGHT edge   82.25 .. 368.00 at 402, 285.75 wide
  //                                           78.88 .. 341.00 at 375, 262.13 wide
  //   pill   3*slotW + END_GAP, pillW wide   279.50 .. 368.00 at 402
  //                                          259.25 .. 341.00 at 375
  //
  // THE PILL IS INSIDE THE OVAL, not beside it. The oval is one continuous
  // surface from its left edge to the end of the track, and the pill lies on its
  // last pillW points — 197.25 .. 285.75 in the oval's own coordinates at 402.
  // They share that span; nothing is flush with anything.
  //
  // HOME IS A CIRCLE ON ITS OWN CONTENT, not a pill on its own slot. The content
  // is centred in the slot, so the circle is centred there too and the icon and
  // the label need no shift of any kind: 56 about slotW/2 puts the ground
  // exactly under where normal mode already draws them.
  //
  // THE GAP AT THE BAR'S LEFT END IS WHAT THAT COSTS, and it is not small —
  // 18.25 at 402 and 14.88 at 375, against the 0 a slot-wide pill left. That is
  // the price of a circle whose centre is fixed by its contents rather than by
  // the track, and it is the geometry that was asked for.
  //
  // THE MAGNIFIER CIRCLE IS GONE. The TRACKING PILL stands in its place, at the
  // Search slot's own centred position, which is exactly 3*slotW + END_GAP —
  // pillW is slotW - 2*END_GAP, so the centring cancels to the gap. It is not
  // spelled here because any object reads it; it is spelled here because the
  // OVAL has to stop short of it.
  //
  // THE OVAL RUNS THE WHOLE LENGTH AND THE PILL SITS ON IT. Its right edge is
  // the PILL'S right edge, not the pill's left one: the field is a single
  // continuous surface to the end of the track, and the pill overlaps its last
  // pillW points completely.
  //
  // searchPillLeft + pillW IS barW - END_GAP, and the second form is the one to
  // recognise — 3*slotW + END_GAP + (slotW - 2*END_GAP) collapses to
  // 4*slotW - END_GAP. So the oval ends exactly where a resting pill ends, which
  // is the track's own end less the gap every tab leaves. It is written the long
  // way because the INTENT is "as far as the pill reaches", and that is what has
  // to stay true if the pill's width ever moves again.
  //
  // IT WENT THROUGH THREE ARRANGEMENTS to get here: 8 short of the pill, then
  // flush against it, and now under it. The first two both drew a seam across a
  // field that is one control; this draws none.
  //
  // THE LAYERING IS WHAT MAKES IT POSSIBLE and it was already in place: ovalNode
  // renders BEFORE capsuleNode on both paths, so the pill paints over the oval
  // rather than under it. That was done when the oval was merely flush; it is
  // what an overlap actually requires.
  //
  // THE HIT AREA DOES NOT FOLLOW THE SURFACE, and that is deliberate — see
  // ovalTapW. A press must still reach the pill.
  const homeLeft = slotW / 2 - SEARCH_CIRCLE / 2;
  const ovalLeft = homeLeft + SEARCH_CIRCLE + SEARCH_OBJ_GAP;
  const searchPillLeft = SEARCH_INDEX * slotW + END_GAP;
  const ovalW = searchPillLeft + pillW - ovalLeft;
  // THE OVAL'S TOUCHES STOP WHERE THE PILL BEGINS, which is the oval's old full
  // width. The tap target is drawn AFTER the detector, so it is above everything
  // including the Search item's own Pressable; letting it run the surface's full
  // length would swallow every press on the pill and the pill would stop
  // bulging. Two spans, one for paint and one for touch, and the pill keeps its
  // own press.
  const ovalTapW = searchPillLeft - ovalLeft;

  // NOTHING IN SEARCH MODE ANIMATES ITS POSITION, and that rule outlived the
  // cross-fade that used to sit beside it. A SCALE is allowed where a translate
  // is not: a scale about a fixed centre cannot carry a box anywhere its resting
  // box was not already pointing, and both objects' centres are constants.
  //
  // AND NOW NOTHING ANIMATES ITS OPACITY EITHER. The objects are laid out at
  // their final left, width and height and simply exist or do not; there is no
  // in-between state for a frame to catch. Home occupies 18.25..74.25 and the
  // oval 82.25..279.50 for as long as they are on screen at all.
  //
  // AT FULL PRESS THE TWO OBJECTS STILL CANNOT MEET. Their centres are three
  // whole slots apart, 277.50 at 402 and 257.25 at 375; grown by the pill's 10
  // and Home's 5 their facing edges are still 190.25 and 173.38 apart. What each
  // does to the OVAL is answered at SEARCH_PRESS_GROW: Home clears it by 3.00,
  // and the pill crosses onto it by 10.00 and draws on top of it.

  // HOME'S BULGE, and it is all this style does now. The opacity that used to
  // ride searchAmt here is gone with the cross-fade; the circle is either in the
  // tree at full strength or not in it.
  //
  // ONE FACTOR ON BOTH AXES — see SEARCH_PRESS_SCALE. The scale takes the view's
  // own centre, and that centre is homeLeft + 28, a render constant that is
  // never animated, so the bulge grows symmetrically about the icon and the
  // label instead of dragging them anywhere.
  const homeObjStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + homeAmt.value * (SEARCH_PRESS_SCALE - 1) }],
  }));

  // THE X'S BULGE, and it is Home's exactly: the same SEARCH_PRESS_SCALE about
  // a centre that is a layout constant. NO OPACITY HERE, for the same reason
  // nothing else has one any more — the X belongs to the full field rather than
  // to the collapsed bar, and it is mounted and unmounted with `typing`. Its one
  // visibility rule is the kbH guard the field itself uses.
  const closeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + closeAmt.value * (SEARCH_PRESS_SCALE - 1) }],
  }));

  // THE ONE PLACE A TAB IS ENTERED, whether by tap or by drag. Both paths do the
  // same two things in the same order, so a tab reached by sliding is
  // indistinguishable from one reached by tapping.
  //
  // THE HAPTIC IS GONE, and the `haptic` parameter with it. It was the only
  // thing the two callers ever disagreed about — a crossing ticked, a tap did
  // not — so with it removed there is nothing left to tell them apart and a
  // flag that is always the same value is worse than no flag.
  //
  // AND IT NOW REPORTS WHETHER THE PILL BELONGS AT i, which the press path needs
  // and the drag path ignores. True means "i is, or is about to become, the
  // active tab"; false means the navigation did not happen and whatever moved
  // the pill in anticipation has to put it back. The CONDITION is unchanged —
  // it still navigates exactly when i is not already active and nobody
  // prevented it — only spelled as two guards so each can answer separately.
  const enter = (i: number): boolean => {
    const item = ITEMS[i];
    if (!item) return false;
    const target = state.routes.find((r) => r.name === item.route);
    if (!target) return false;
    // The event is emitted whether or not we navigate, so a screen listening for
    // tabPress still hears the press on its own tab — which is how scroll-to-top
    // is usually wired.
    const event = navigation.emit({ type: 'tabPress', target: target.key, canPreventDefault: true });
    if (i === activeIndex) return true;              // already there, nothing to do
    if (event.defaultPrevented) return false;        // a screen said no
    navigation.navigate(target.name, target.params);
    return true;
  };

  // WHERE THE PILL COMES TO REST, spelled once for the two JS-thread callers
  // that need it. The placement effect still inlines its own copy and is left
  // alone deliberately: it is the authority on the resting position and nothing
  // here should be able to change what it does.
  //
  // IT TAKES NO FLAG ANY MORE. `press` used to pick between the fast press-in
  // spring and the ordinary one, and with a single spring there is nothing left
  // to pick: both call sites — onPressIn's anticipation travel and onPress's
  // walk-back — want the pill to go to a slot at the pill's one speed. The
  // parameter and the branch went together.
  //
  // NO ASYMMETRY, SO NO SQUASH. Same config on both edges and no end-tab special
  // case: the pill arrives at its full width on every tab, first and last
  // included.
  const settlePill = (i: number) => {
    if (dragging.value) return;      // the finger owns it; see `dragging`
    const slot = slots[i];
    if (!slot) return;
    const target = slot.x + slot.w / 2 - pillW / 2;
    capX.value = withSpring(target, SPRING_END);
    capR.value = withSpring(target + pillW, SPRING_END);
  };

  // WHAT THE FINGER DOES, on the UI thread. Declared before the gesture that
  // calls it, as a worklet, so the gesture's own worklets capture a workletized
  // binding rather than a JS-thread closure.
  const trackFinger = (fx: number, vx: number) => {
    'worklet';
    const arr = slotsSV.value;
    if (arr.length !== ITEMS.length) return;

    // THE PILL IS ON THE FINGER, not springing after it. A spring here would lag
    // the touch by its own settling time, which reads as the bar being slow
    // rather than as the pill being weighty.
    //
    // THE CLAMP IS THE RESTING RANGE, exactly. It used to be +/- TRACK_PAD
    // around the track's edges, which at TRACK_PAD 0 collapses to the track
    // itself and would let a hard drag put the pill's edge flush against the
    // glass. Bounding it to where the pill can actually COME TO REST instead is
    // both tighter and self-maintaining: the two ends are the first and last
    // slots' centred positions, computed from the same measurements the settle
    // uses, so the drag can never reach anywhere a release could not leave it.
    //
    // A release therefore never travels backwards. The finger stops somewhere in
    // [lo, hi] and the spring goes to another point in the same interval.
    //
    // THE CLAMP USES THE RESTING WIDTH, not the deformed one, so how hard the
    // pill is being squashed cannot change how far it may travel.
    const w = pillW;
    const lo = arr[0].x + arr[0].w / 2 - w / 2;
    const hi = arr[arr.length - 1].x + arr[arr.length - 1].w / 2 - w / 2;
    let x = fx - w / 2;
    if (x < lo) x = lo;
    if (x > hi) x = hi;

    // AND NOW IT DEFORMS UNDER THE FINGER. The leading edge is held back by the
    // squash and the trailing edge is left where the finger put it, so the pill
    // shortens along the direction of travel — the same shape the arrival
    // squash makes, driven by the drag instead of by a spring.
    //
    // The cap is a hard clamp rather than a curve: past DRAG_SQUASH_VEL there is
    // no more to give.
    const speed = vx < 0 ? -vx : vx;
    let d = (speed / DRAG_SQUASH_VEL) * DRAG_SQUASH_MAX;
    if (d > DRAG_SQUASH_MAX) d = DRAG_SQUASH_MAX;

    let left = x;
    let right = x + w;
    if (vx > 0) right -= d;
    else if (vx < 0) left += d;
    capX.value = left;
    capR.value = right;

    // WHICH ITEM THE FINGER IS OVER, and the clamping is free. "The first item
    // whose right edge is past the finger" is the containing one; a finger left
    // of everything falls to 0 and one right of everything falls through the
    // loop to the last.
    //
    // THERE ARE GAPS NOW that space-between opens between the items, and this
    // rule already handles them: a finger in a gap is past the previous item's
    // right edge and short of the next one's, so it selects the one to its
    // RIGHT. Monotone either way, and there is no dead zone.
    let idx = arr.length - 1;
    for (let i = 0; i < arr.length; i++) {
      if (fx < arr[i].x + arr[i].w) { idx = i; break; }
    }

    if (idx !== lastCommitted.value) {
      lastCommitted.value = idx;
      // NOTHING RESIZES ON A CROSSING ANY MORE. The pill is one width, so
      // crossing into a wider word changes only which word is lit. The spring
      // that used to carry the width is gone; the one on the position at
      // release is the only one left, and it is unchanged.
      //
      // THE CROSSING TEST ITSELF IS UNTOUCHED by the haptic coming out. The
      // comparison above, the write to lastCommitted and this hop are what
      // detect and act on a crossing; the tick was only ever a passenger.
      runOnJS(enter)(idx);
    }
  };

  // DRAG TO SELECT. activeOffsetX is the whole reason taps still work: the pan
  // stays in BEGAN until the finger has travelled 8pt horizontally, so a tap —
  // which travels nothing — never activates it and the Pressable underneath
  // handles the touch normally. Once it does activate, gesture-handler cancels
  // the React Native responder, so the press is dropped rather than also firing
  // on release. One gesture wins outright; there is no simultaneity to arbitrate.
  //
  // onStart, NOT onBegin. onBegin fires on touch-down for every touch including
  // taps, so committing there would navigate on finger-down and make a tap mean
  // something different from what it means today.
  //
  // ——— THE RULE, AND THE TWO BUGS THAT BOUGHT IT ———
  //
  // THE GESTURE'S CONFIGURATION AND STATE MUST NEVER DEPEND ON searchMode. ONLY
  // WHAT ITS CALLBACKS DO MAY. The handler is created once, enabled, with no
  // touch callbacks, and nothing about the mode ever reaches it again. Two
  // separate bugs came from breaking that rule in two different ways, and both
  // presented identically: the recogniser stopped receiving touches PERMANENTLY
  // after one trip through search mode, with the Pressables underneath still
  // getting every press.
  //
  // THE FIRST WAS .enabled(!searchMode). Toggling it false and back to true left
  // the handler receiving nothing, and the JS side of the library does its part:
  // `enabled` is in commonProps and so in ALLOWED_PROPS (gestureHandlerCommon.ts
  // :14, :43); needsToReattach compares only the gesture COUNT, handlerName and
  // shouldUseReanimated, so toggling it never takes the reattach path
  // (needsToReattach.ts) and always takes the config-update one
  // (useDetectorUpdater.ts:34-58); and that update runs on EVERY render, because
  // the effect driving it depends on `props`, a fresh object each time
  // (GestureDetector/index.tsx:170-176). updateGestureHandler is called with
  // enabled: true (updateHandlers.ts:68) and the handler still receives nothing.
  // The failure is below JS and was not chased further, because the toggle can
  // simply stop happening.
  //
  // THE SECOND WAS onTouchesDown + stateManager.fail(), which replaced it and
  // failed in a DIFFERENT WAY IN THE SAME CLASS. This one is understood exactly:
  //
  //   1. onTouchesDown's first line is `config.needsPointerData = true`
  //      (gesture.ts:236). Registering the callback is not passive.
  //   2. That flag gates the native reset. RNGestureHandler.reset
  //      (apple/RNGestureHandler.mm:602) only clears _state and _lastState
  //      `if (!_needsPointerData || _pointerTracker.trackedPointersCount == 0)`.
  //      Without a touch callback that reset is UNCONDITIONAL; with one it is
  //      conditional on the tracker being empty. reset is what
  //      gestureRecognizerShouldBegin calls to make the handler ready for the
  //      next touch (:637).
  //   3. manager.fail() is setGestureState(tag, FAILED)
  //      (gestureStateManager.ts:45-52), and we called it from onTouchesDown —
  //      that is, WHILE A POINTER IS DOWN.
  //   4. The library documents what that can do, in a comment on its own
  //      recovery path (apple/RNGestureHandlerPointerTracker.m:200-204): "the
  //      gesture may be made to fail without calling touchesCancelled — in that
  //      case there are still tracked pointers but the recognizer state is
  //      already set to UIGestureRecognizerStateFailed". The recovery
  //      (cancelPointers) only runs if the TRACKER's reset is reached, and its
  //      route in is touchesCancelled: (:183-189) — the very callback that
  //      comment says may not arrive.
  //   5. So the tracker keeps its pointers, trackedPointersCount never returns
  //      to 0, and step 2's reset is a no-op from then on. The handler stays
  //      FAILED forever.
  //
  // WHAT WAS RULED OUT ALONG THE WAY, so nobody re-runs it: the GestureDetector
  // is NOT remounted between modes — st.row's children are a static three-slot
  // array and a `false` child holds its slot, so the detector is index 1 in both
  // modes; unmounting its DESCENDANTS cannot sever the binding, which is by the
  // track's view tag (attachHandlers.ts); the Pressables keep stable keys off a
  // module constant; and onBegin's presence or absence changes nothing, because
  // shouldUseReanimated reads `isWorklet.includes(false)` over a SPARSE array
  // (gesture.ts:422) and holes read as undefined, not false.
  //
  // THE THIRD BUG WAS THE EARLY RETURNS, and it is the same mistake once more.
  // onStart began `if (searchSV.value) return;` — before setting dragging — so
  // in search mode the gesture ACTIVATED and then onFinalize hit its own
  // `if (!dragging.value) return` and returned without finishing. The gesture
  // was left OPEN, holding the recogniser, and every touch after it was dead.
  // The log is unambiguous: onBegin #2 with no onFinalize #2, then nothing ever
  // again.
  //
  // AND THE FOURTH WAS THE VIEW ITSELF. The shell carried display: 'none' while
  // the full field was up, and the shell is the GestureDetector's ANCESTOR — so
  // opening the keyboard took the recogniser's view out of the native hierarchy
  // underneath an open gesture. It can never finalize after that:
  // handleGesture: bails on `if (view.reactTag == nil) return;`
  // (apple/RNGestureHandler.mm:287-291) and sends no event at all, so onFinalize
  // is never called and the gesture stays open forever, holding the recogniser.
  // The log named it exactly: onBegin #9 with no onFinalize #9, and every touch
  // after it dead. Entering search mode was never the trigger; opening the
  // keyboard field was.
  //
  // SO THE RULE IS WIDER THAN CONFIG AND STATE. SEARCH MODE MAY NEVER AFFECT THE
  // GESTURE'S CONFIGURATION, ITS STATE, WHETHER ITS CALLBACKS RUN TO COMPLETION,
  // OR THE PRESENCE OF ITS VIEW IN THE HIERARCHY. IT MAY ONLY AFFECT WHAT THE
  // CALLBACKS DO TO THE PILL. Four bugs, one shape: .enabled() reached into the
  // CONFIG, onTouchesDown + manager.fail() reached into the STATE, the early
  // returns reached into the LIFECYCLE, and display: 'none' reached into the
  // VIEW IDENTITY. Each time search mode was made a property of the gesture
  // rather than of what the gesture does.
  //
  // WHAT THAT MEANS IN PRACTICE. All three callbacks now run every statement
  // they have, in both modes, with NO return of any kind in any of them. The
  // ONLY thing the mode changes is whether trackFinger is called — and
  // trackFinger is the entirety of what moves the pill: the position write, the
  // drag squash and the crossing detection all live inside it. Search mode
  // therefore changes what the drag DOES and nothing else about it.
  //
  // WHAT RUNNING THE WHOLE LIFECYCLE IN SEARCH MODE COSTS, stated rather than
  // discovered later: a drag on the collapsed bar now sets dragging, raises
  // dragAmt, clears the fallback pill's frost and flips dragActive for its
  // duration, then puts all four back on release. They are the drag's own
  // bookkeeping and they are visible on the search pill. That is the price of a
  // gesture that always closes, and it is a great deal cheaper than one that
  // does not.
  //
  // WHAT THAT COSTS, and it is the honest price of the rule: the pan can now
  // ACTIVATE in search mode if a finger travels 8pt, and an activated pan
  // cancels the React Native responder, so a DRAG on the collapsed bar swallows
  // the press underneath it — Home's exit or the pill's open-field tap would
  // not fire for that one gesture. A TAP never crosses activeOffsetX and is
  // untouched, and both guards return immediately so nothing moves. Widening
  // activeOffsetX in search mode would close it, and is exactly the kind of
  // mode-dependent config this note exists to forbid.
  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .onStart((e) => {
      'worklet';
      // NO RETURN HERE, IN EITHER MODE. Everything below runs every time, so
      // the gesture that activated is always one onFinalize can close. See the
      // rule above.
      //
      // THE DRAG TAKES THE RELEASE BACK. onPressOut has already asked for one by
      // now in the common case; this is what stops it landing.
      runOnJS(cancelPressRelease)();
      dragging.value = true;
      // THE STACK EASES FROM 3pt TO 2pt from here. Same place as the flag, so the
      // two can never disagree about whether a drag is happening.
      dragAmt.value = withSpring(1, PRESS_SPRING);
      // THE PRESS IS NOT RELEASED HERE, and it used to be. A drag is a hold that
      // moved: the finger has not lifted, so the thing it is holding should not
      // shrink out from under it. The expansion now lasts the whole gesture and
      // comes off only when the touch actually ends — see onFinalize below.
      //
      // Clear glass for the length of the move, frosted again when it settles.
      frostOpacity.value = withTiming(0, { duration: 120 });
      runOnJS(setDragActive)(true);
      // Seed from the current tab so the first crossing is measured against
      // where the selection actually is.
      lastCommitted.value = activeSV.value;
      // THE ONE STATEMENT SEARCH MODE GUARDS, and it is a condition on a CALL
      // rather than on the callback. trackFinger is what writes capX and capR,
      // applies the drag squash and detects a crossing, so not calling it is
      // the whole of "the drag does nothing" — and everything above has still
      // happened, so the lifecycle is intact.
      if (!searchSV.value) trackFinger(e.x, e.velocityX);
    })
    .onUpdate((e) => {
      'worklet';
      // THE SAME GUARD IN THE SAME SHAPE: a condition on the call, not a
      // return from the callback. onUpdate has nothing else to do, so this is
      // the whole of its body either way.
      if (!searchSV.value) trackFinger(e.x, e.velocityX);
    })
    .onFinalize(() => {
      'worklet';
      // The touch is over however it ended, so a pending request is moot: cancel
      // it and do the release here and now instead.
      runOnJS(cancelPressRelease)();
      // THE TOUCH IS OVER, WHATEVER IT TURNED OUT TO BE. onFinalize runs on a
      // lift and on a cancellation, and for a gesture that never activated as
      // well as one that did — so this is the one place that catches every way
      // a finger can leave. The press comes off here, ABOVE the guard, because a
      // tap returns early below it and a tap must still un-expand.
      //
      // onPressOut does the same job for the ordinary cases and they are
      // idempotent together: both spring the same value to the same 0.
      pressAmt.value = withSpring(0, PRESS_SPRING);
      // UNCONDITIONAL, AND ABOVE THE GUARD, for the same reason pressAmt is: a
      // tap returns early below and must still come back to rest. On a tap this
      // is a no-op, because nothing ever raised it.
      dragAmt.value = withSpring(0, PRESS_SPRING);
      // DRAGGING IS CLEARED FIRST AND UNCONDITIONALLY, so no path out of this
      // callback can leave it set. It is read into a local before it is cleared
      // because the rest of the body still needs to know whether a drag
      // actually happened.
      const wasDragging = dragging.value;
      dragging.value = false;
      // AND THE REST IS A BLOCK RATHER THAN AN EARLY RETURN. The distinction it
      // draws is "did the pan activate", NOT "what mode are we in": a tap
      // finalizes here too, having never run onStart, and springing the position
      // then would move the pill from a stale index on every tap. onFinalize
      // rather than onEnd because it also runs on a cancellation, and a
      // cancelled drag must not leave the pill parked under the finger.
      //
      // WRITTEN AS `if (wasDragging) { ... }` ON PURPOSE. There is no return in
      // any of these three callbacks now, in any mode, which is the property the
      // rule above is about and the one that is easy to check by eye.
      if (wasDragging) {
      frostOpacity.value = withTiming(1, { duration: 160 });
      runOnJS(setDragActive)(false);
      const arr = slotsSV.value;
      const i = lastCommitted.value;
      if (i >= 0 && i < arr.length) {
        // THE SAME CENTRING AND THE SAME ARRIVAL the resting effect does,
        // spelled again here because a worklet cannot call it. NEITHER SQUASHES
        // NOW: both edges take one config, so the width is constant through the
        // settle, and a release onto an end tab arrives exactly as a tap onto
        // one does. There is one behaviour, not one for each way of arriving —
        // which is why this had to move when the effect did. Leaving the
        // release compressing while the tap did not would have made how you got
        // to a tab visible in how the pill landed on it.
        //
        // THE CLAMP IS STILL THE ENDS' though, for the reason it always was: an
        // unclamped edge overshoots 7.88pt against a 2.00pt END_GAP, so both
        // edges would carry the pill 5.88 past the bar's end together. The
        // middle keeps the plain spring and its overshoot, which lands in air.
        //
        // THE DRAG'S OWN SQUASH IS NOT THIS and is untouched: that one lives in
        // trackFinger, is driven by the finger's velocity, and ends when the
        // finger lifts. This is only what happens after it has.
        const restL = arr[i].x + arr[i].w / 2 - pillW / 2;
        capX.value = withSpring(restL, SPRING_END);
        capR.value = withSpring(restL + pillW, SPRING_END);
      }
      // AND A DRAG THAT ENDS ON SEARCH COLLAPSES THE BAR, exactly as a tap on
      // that tab does. Dragging there used to navigate and stop, which left the
      // search ROUTE open under a bar still showing four tabs.
      //
      // HERE RATHER THAN AT THE CROSSING, AND THAT IS THE WHOLE OF THE CARE
      // THIS NEEDED. The pan is `.enabled(!searchMode)`, so setting search mode
      // while the finger is still down would disable the very recogniser that
      // is running: gesture-handler drops a disabled handler, the gesture is
      // cancelled mid-flight, and the cancellation comes back through this same
      // onFinalize with the drag half-resolved. Committing at the END of the
      // gesture cannot do that — by the time this state update lands the
      // gesture is already finalized, and disabling something that has finished
      // costs nothing.
      //
      // IT TOUCHES NOTHING ELSE. The crossing detection, the navigation it
      // fires and the settle above are all exactly as they were; this reads
      // lastCommitted, which they had already written, and adds one call.
      //
      // PAST THE SLOT THERE IS NOTHING. Search is the last tab, so a finger
      // carried to the far right is clamped by trackFinger's `hi` — the last
      // slot's own resting position — and the index loop falls through to
      // arr.length - 1. It commits to Search and stays there, so lifting
      // anywhere right of the Bookings boundary enters search mode.
      //
      // ON A CANCELLED DRAG IT STILL FIRES, which is deliberate: the settle
      // above already treats a cancellation as a release, and the two should
      // not disagree about where the drag ended.
      //
      // IF THE NAVIGATION WAS REFUSED the route is not `search`, and the guard
      // effect sees searchMode true with activeIndex not SEARCH_INDEX and puts
      // it straight back. The drag path cannot read enter()'s answer from a
      // worklet, and this is the mechanism that already exists for exactly that
      // disagreement.
      if (i === SEARCH_INDEX) runOnJS(setSearchMode)(true);
      }
    });

  // ONE PILL THAT MOVES, not three that fade. A single element sliding between
  // measured positions is what makes the change read as one thing travelling
  // rather than two blinking.
  //
  // A Reanimated.View EITHER WAY, and on the glass path that is not a
  // preference. Reanimated animates the components it has wrapped; GlassView is
  // a bare native view and would need createAnimatedComponent to take an
  // animated style directly. Rather than wrap a native view whose prop handling
  // I cannot verify from a .d.ts — and animate `width` on the glass effect
  // itself every frame — the Reanimated.View carries the motion and the
  // GlassView sits inside it at absoluteFill. The measured geometry, the spring
  // and the drag are identical on both paths; only what is painted differs.
  //
  // MOUNTED ONLY ONCE PLACED, instead of faded in. The fallback capsule starts
  // at opacity 0 so it does not fly in from x=0 before the first measurement;
  // here it simply is not rendered until there is a measurement to render it
  // at, which achieves the same thing with NO opacity anywhere above the
  // GlassView. Worth stating plainly: I could not find that opacity caveat
  // anywhere in this version's typings — see the report — so this is caution,
  // not a documented rule.
  //
  // isInteractive is a CONSTANT true. The typings do not mark it mount-only, but
  // they do not promise it is live either; setting it to a literal means nothing
  // depends on the answer.
  const capsuleNode = useGlass ? (
    activeIndex >= 0 && slots[activeIndex] !== null ? (
      <Reanimated.View style={[st.capsuleBox, capsuleGlassStyle]} pointerEvents="none">
        {/* APPLE'S OWN TWO STATES, which is why this path needs no blur of its
            own: 'regular' is the frosted material and 'clear' is the same glass
            without the frost, so the effect the fallback fakes with a BlurView
            is a documented value here.

            NOT MOUNT-ONLY, and the typings say so rather than my assuming it:
            glassEffectStyle also accepts a GlassEffectStyleConfig whose
            `animate` field is documented as "Whether to animate the style
            change". A prop that could only be set at mount would have no style
            change to animate. GlassView.ios.js spreads its props onto the
            native view on every render, so the new value does reach it. The
            config form is available if this should ease rather than cut; the
            plain string cuts, which is what a drag starting wants. */}
        <GlassView
          glassEffectStyle={dragActive ? 'clear' : 'regular'}
          isInteractive
          style={st.capsuleGlass}
        />
      </Reanimated.View>
    ) : null
  ) : (
    <Reanimated.View style={[st.capsule, capsuleStyle]} pointerEvents="none">
      {/* FROST AT REST, CLEAR WHILE IT MOVES. A low blur of the pill's own, over
          the bar's glass, so the highlight reads as a thicker piece of the same
          material rather than a painted rectangle. It fades out for the length
          of a drag: a pane you are pushing around should not also be frosting
          what is under it.

          THE OPACITY CAVEAT DOES NOT APPLY HERE, and this is the one place in
          this file where animating opacity over a glass surface is fine: this
          is expo-blur's BlurView, not expo-glass-effect's GlassView. The rule
          we keep elsewhere — never put opacity on a GlassView or an ancestor of
          one — is about Apple's material. Do not copy this onto the glass path.

          intensity 12 rather than lib/glass.tsx's 32: that one is a window onto
          the page, this is a thickening of a surface already blurred once. The
          tint and method are spelled exactly as GlassLayers spells them.

          THE CLIP IS capsuleClip, and this layer is absoluteFill and an
          opacity and nothing else. The hairline is drawn OVER both of them,
          not around them. */}
      <View style={st.capsuleClip}>
        <Reanimated.View style={[StyleSheet.absoluteFill, frostStyle]} pointerEvents="none">
          <BlurView
            intensity={12}
            tint="systemChromeMaterialDark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        </Reanimated.View>
      </View>
      <View style={st.capsuleEdge} pointerEvents="none" />
    </Reanimated.View>
  );

  // THE OVAL'S SURFACE, LIFTED OUT OF content SO IT CAN GO UNDER THE PILL.
  //
  // WHAT MOVED AND WHAT DID NOT. This is the same glass, hairline, prompt and
  // placeholder it always was, in the same box; only its place in the sibling
  // order changed, from inside st.row to a sibling of capsuleNode. The pill
  // itself was not touched, which is deliberate: it is the load-bearing element
  // and the ordering around it — surface, pill, labels — is what normal mode
  // depends on. Moving the OVAL down rather than the pill up leaves that intact.
  //
  // THE FRAME IS THE SAME FRAME. st.row is flex: 1 inside a shell of height
  // BAR_H with TRACK_PAD of 0, so its box is the shell's box exactly, and an
  // absolutely positioned child at the same left and top lands in the same
  // place either side of the move. The glass path is the same again: st.row
  // fills st.glassPill.
  //
  // AND NORMAL MODE IS UNCHANGED BY ANY OF IT. searchMode is false there, so
  // this renders nothing at all and the shell's children are surface, pill,
  // content — pill under labels, exactly as before.
  //
  // pointerEvents none THROUGHOUT: there is a separate Pressable for that, after
  // the detector. See the note at the tap target.
  const ovalNode = searchMode ? (
    <View
      style={[st.searchOval, { left: ovalLeft, width: ovalW }]}
      pointerEvents="none"
    >
      <View style={st.searchOvalClip}><BarGlass /></View>
      <View style={st.searchOvalEdge} pointerEvents="none" />
      {/* THE TEXT STOPS BEFORE THE PILL. The pill lies on the oval's last
          pillW points, so the row is padded by exactly that on the right and
          the prompt and the placeholder end at the pill's left edge. */}
      <View style={[st.barFieldRow, { paddingRight: pillW }]}>
        <Text style={st.prompt}>{`~/${searchName}:-$`}</Text>
        <View style={st.barFieldBody}>
          {query.length === 0
            ? <TabBarPlaceholder size={BAR_PROMPT_FS} prompts={SEARCH_PROMPTS_BAR} />
            : <Text style={st.barQuery} numberOfLines={1}>{query}</Text>}
        </View>
      </View>
    </View>
  ) : null;

  // IDENTICAL ON BOTH PATHS, which is what keeps the drag honest: the same row,
  // the same track, the same onLayout, the same GestureDetector. Only the
  // surface behind them changes.
  const content = (
    <View style={st.row}>
      {/* THE HOME CIRCLE'S SURFACE, and it is BEFORE the detector so it sits
          BEHIND the Home item rather than over it. The icon and the label are
          still the item's own, drawn by WaveIcon and WaveChar exactly as in
          normal mode; all this adds is the ground they stand on, and the press
          that makes the ground answer a finger.

          MOUNTED OR NOT, AND NOTHING IN BETWEEN. It holds a BlurView, and a
          BlurView asked to be transparent is not a BlurView that has gone, so
          the only reliable way to remove it is to remove it. searchMode is the
          whole of the condition now — there is no fade for a flag to have to
          outlive. See the note at searchMode.

          pointerEvents none THROUGHOUT. The tap target is the Home item's own
          Pressable underneath, which is the same rectangle the circle is drawn
          on; this is a backdrop and never a button. */}
      {searchMode && (
        <Reanimated.View
          style={[st.searchObj, { left: homeLeft, width: SEARCH_CIRCLE }, homeObjStyle]}
          pointerEvents="none"
        >
          <View style={st.searchObjClip}><BarGlass /></View>
          <View style={st.searchObjFill} pointerEvents="none" />
          <View style={st.searchObjEdge} pointerEvents="none" />
        </Reanimated.View>
      )}
      <GestureDetector gesture={pan}>
        {/* THE TRACK CARRIES NO PADDING, and that is what makes the arithmetic
            honest. Two things are measured against it and they have to agree:
            the slots, whose x each Pressable reports through onLayout, and the
            finger, whose event.x the pan reports relative to the view the
            detector wraps. Padding here would move one and not the other.

            The 8 that holds the pill off the glass lives on the row outside
            instead. The pill itself is no longer in here at all — it is a
            sibling of this whole block now, offset by that same padding. See
            the note at `capsule`. */}
        <View style={st.track} onLayout={onTrackLayout}>
          {ITEMS.map((item, i) => {
            // STILL NEEDED, but only for the accessibility state now. The
            // colour used to hang off this too; it hangs off the wave instead,
            // so there is no longer an `ink` for the whole item — every glyph
            // and every character works its own out. See INK_INACTIVE.
            const focused = i === activeIndex;
            // THE PILL ANSWERS THE PRESS, not the item: there is one highlight
            // and it is the thing that looks pressable, so it is the thing that
            // grows. On the glass path pressAmt is not read at all — see
            // capsuleGlassStyle.
            //
            // onPressOut IS GUARDED, and this is the bug the last round left.
            // Taking the release out of the pan's onStart changed nothing that
            // anyone could see, because onPressOut fires at the same instant for
            // a reason that is not obvious: RNGestureHandler sets
            // `cancelsTouchesInView = YES` on its recognizer (RNGestureHandler.mm
            // :116), so the moment the pan activates UIKit sends touchesCancelled
            // to the view underneath. React Native turns that into
            // RESPONDER_TERMINATED, Pressability transitions to NOT_RESPONDER and
            // calls _deactivate, and _deactivate calls onPressOut. The finger is
            // still down; the press has only been taken away from the Pressable.
            //
            // `dragging` IS ALREADY TRUE BY THEN, which is what makes the guard
            // work. It is set in the pan's onStart worklet, which runs on the UI
            // thread as part of the activation itself; onPressOut is the JS-side
            // consequence of that same activation and cannot precede its own
            // cause. Pressability may also hold onPressOut back by up to its
            // DEFAULT_MIN_PRESS_DURATION of 130ms, which only widens the margin.
            //
            // NOTHING IS LEFT EXPANDED by skipping it: the pan's onFinalize
            // releases unconditionally, above its own guard, and fires on a lift
            // and on a cancellation alike.
            return (
              <Pressable
                key={item.label}
                // THE MEASUREMENT IS NEVER TORN DOWN. The three items stay
                // MOUNTED in search mode and only fade, so onSlotLayout keeps
                // reporting the same boxes and slots never goes stale. Unmounting
                // them would leave the pill with no slot to sit on and the wave
                // with no centres to measure against.
                onLayout={onSlotLayout(i)}
                // TWO ITEMS ARE REACHABLE once the bar has collapsed, and they
                // are the two that still have an object drawn on them: Home,
                // which leaves, and Search, which is the pill and opens the
                // field. Flights and Bookings are faded out and inert.
                disabled={searchMode && i !== 0 && i !== SEARCH_INDEX}
                onPress={() => {
                  // HOME IS THE WAY OUT, and it is the only item that can be
                  // pressed in search mode. IT NAVIGATES AS WELL AS EXITING, and
                  // it used to do only the second: the bar went back to four tabs
                  // while the route stayed `search`, so pressing the home button
                  // left you on the search screen looking at a bar that said
                  // otherwise. A tab drawn as Home and labelled Home goes to Home.
                  //
                  // THE EXIT IS UNCONDITIONAL AND COMES FIRST, which is the whole
                  // of the ordering. Home is the ONLY way out of search mode, so
                  // an exit that depended on the navigation being allowed would
                  // let a screen vetoing a tabPress trap the bar in a state with
                  // no exit at all. Doing it first makes that impossible by
                  // construction rather than by remembering to handle a refusal.
                  //
                  // AND ON SCREEN THERE IS NO ORDER AT ALL. Both are updates
                  // inside one event handler, so they batch into a single render:
                  // the bar never draws a frame where search mode has ended but
                  // the route has not changed, or the reverse.
                  //
                  // enter() IS THE ONE NAVIGATION PATH, exactly as the ordinary
                  // press below uses it: the same tabPress emit with
                  // canPreventDefault, the same defaultPrevented check, the same
                  // navigation.navigate to ITEMS[0].route. Nothing new was
                  // introduced to reach the home screen, and a screen listening
                  // for tabPress hears this press as it hears any other.
                  //
                  // NO WALK-BACK, AND NOTHING TO WALK BACK. The refused-press
                  // path below exists because onPressIn moves the pill in
                  // anticipation; in search mode onPressIn returns before
                  // touching anything, so the pill has not moved and nothing is
                  // owed. It is faded out entirely, and the placement effect
                  // lands it on whichever route is actually active while
                  // capOpacity is below 1 — Home if the navigation went
                  // through, Search if it was refused. Either way it appears
                  // where it belongs rather than travelling there.
                  if (searchMode) {
                    // THE PILL IS THE SEARCH BUTTON. Pressing it opens the full
                    // field and changes nothing else: the route is already
                    // `search`, the pill is already where it belongs, and there
                    // is nothing here to navigate to. This is the same thing the
                    // oval's own Pressable does, reached from the other half of
                    // the collapsed bar.
                    if (i === SEARCH_INDEX) {
                      // AND ONLY IF THE BAR WAS ALREADY COLLAPSED WHEN THE
                      // FINGER LANDED. The press that collapsed it arrives here
                      // too, because search mode is on by now; it must not also
                      // raise the keyboard. See pressBeganInSearch.
                      if (pressBeganInSearch.current) setTyping(true);
                      return;
                    }
                    setSearchMode(false);
                    setTyping(false);
                    setQuery('');
                    // AND kbH GOES WITH THEM rather than waiting for an event.
                    // See the note where it is declared: leaving it to
                    // keyboardWillHide is what made the second entry into
                    // search behave differently from the first.
                    setKbH(0);
                    Keyboard.dismiss();
                    enter(0);
                    return;
                  }
                  // THE SEARCH TAB HAS ALREADY DONE ALL OF THIS, at press-in.
                  // It navigated and collapsed the bar there; reaching this line
                  // would emit a second tabPress for the same touch. In practice
                  // the branch above catches it, because search mode is on by
                  // now; this is the belt to that pair of braces.
                  if (i === SEARCH_INDEX) return;
                  // THE ANTICIPATION HAS TO BE PAID FOR. onPressIn moved the pill
                  // to this tab before knowing the navigation would be allowed,
                  // so if it was not, the pill is now sitting on a tab that is
                  // not active and something must walk it back. Nothing in this
                  // app prevents a tabPress today, which is exactly why it is
                  // handled here rather than left as an assumption.
                  const landed = enter(i);
                  if (!landed && i !== activeIndex) settlePill(activeIndex);
                }}
                onPressIn={() => {
                  // A stale request from the previous gesture must not collapse
                  // this one: a fast re-press can land inside the window.
                  cancelPressRelease();
                  // SNAPSHOT THE MODE BEFORE THIS PRESS CAN CHANGE IT. See the
                  // note where this ref is declared.
                  pressBeganInSearch.current = searchMode;
                  // BOTH OBJECTS ANSWER THE PRESS IN SEARCH MODE, and they
                  // answer it on two different values because they are two
                  // different objects. The search pill IS the tracking pill, so
                  // it takes pressAmt and grows exactly as pressing the active
                  // tab grows it in normal mode, content and all. Home takes
                  // homeAmt, which nothing else reads.
                  //
                  // NEITHER MOVES. settlePill is not called on either branch, so
                  // capX and capR are untouched and the pill bulges where it
                  // stands. That is the one thing search mode still forbids.
                  if (searchMode) {
                    if (i === 0) {
                      homeAmt.value = withSpring(1, PRESS_SPRING);
                      // AND THE PILL COMES WITH IT. Pressing Home here ends
                      // search mode and sends the pill back across the bar on
                      // release, so this press causes a TRAVEL exactly as any
                      // other cross-bar press does — and it was the only one
                      // whose pill made that journey at its resting size,
                      // because this branch used to raise homeAmt alone. Same
                      // delay and same hold as every travelling press.
                      releaseAt.current = Date.now() + PRESS_HOLD_MS + PRESS_TRAVEL_SETTLE_MS;
                      pressAmt.value = withDelay(PRESS_TRAVEL_LEAD, withSpring(1, PRESS_SPRING));
                    } else if (i === SEARCH_INDEX) {
                      pressAmt.value = withSpring(1, PRESS_SPRING);
                      // Nowhere to travel: the pill is already on this slot, so
                      // it takes the same hold a press on the active tab takes.
                      releaseAt.current = Date.now() + PRESS_HOLD_MS;
                    }
                    return;
                  }
                  // THE PILL GOES TO THE FINGER BEFORE IT GROWS, and this is the
                  // whole of the change. It used to expand wherever it happened
                  // to be standing and only travel on release, which put the
                  // acknowledgement on the wrong tab: you pressed home and
                  // profile lit up.
                  //
                  // THE SAME TAB IS THE UNTOUCHED CASE. There is nowhere to
                  // travel to, so it expands in place with no delay on the
                  // growth — byte for byte what it did before.
                  // THE PILL KEEPS ITS SIZE UNTIL THE TRAVEL HAS LANDED AND
                  // SAT THERE A BEAT. Armed here rather than on the way out,
                  // because the wait is measured from the press. A press with
                  // nowhere to travel still gets the beat; it just does not get
                  // the travel's share of it.
                  releaseAt.current = Date.now() + PRESS_HOLD_MS
                    + (i === activeIndex ? 0 : PRESS_TRAVEL_SETTLE_MS);
                  if (i === activeIndex) {
                    pressAmt.value = withSpring(1, PRESS_SPRING);
                  } else {
                    // ANOTHER TAB: travel first, growth joins it at the tail.
                    // For every tab but Search the navigation still does NOT
                    // happen here — it happens on release, in onPress, exactly
                    // as before, so a press that is dragged away or cancelled
                    // has changed no route.
                    settlePill(i);
                    pressAmt.value = withDelay(PRESS_TRAVEL_LEAD, withSpring(1, PRESS_SPRING));
                  }
                  // AND SEARCH COMMITS HERE, ON TOUCH-DOWN. It was the last line
                  // of onPress, which is a RELEASE callback, so the bar did not
                  // collapse until the finger lifted — press and hold and you
                  // watched the pill travel, arrive and grow with the four tabs
                  // still showing. The wait was never the travel; it was the
                  // lift.
                  //
                  // enter() COMES WITH IT, AND HAS TO. The route guard fires
                  // whenever searchMode is true and the focused route is not
                  // `search`, so setting the mode here while the navigation
                  // waited for the release would have the guard switch it
                  // straight back off. Both in one handler is one batch, so the
                  // mode and the route land in the same render and the guard
                  // returns on its first test, exactly as it does today.
                  //
                  // TWO THINGS ARE GIVEN UP FOR IT, and both are accepted rather
                  // than overlooked. Pressing Search changes the ROUTE on
                  // touch-down, which no other tab does. And the pan is
                  // .enabled(!searchMode), so the recogniser is disabled before
                  // it can activate: YOU CAN NO LONGER DRAG AWAY FROM THE SEARCH
                  // TAB. Those are the same loss twice over — once the bar has
                  // collapsed under the finger there is nothing left to drag to.
                  //
                  // DRAGGING ONTO SEARCH IS UNAFFECTED. That commits in the
                  // pan's onFinalize, from a gesture that began on another tab
                  // where the pan was enabled, and it ends by calling
                  // setSearchMode itself.
                  if (i === SEARCH_INDEX) {
                    enter(i);
                    setSearchMode(true);
                  }
                }}
                onPressOut={() => {
                  // NO MODE BRANCH LEFT HERE, and that is the point. Every
                  // press releases the same way: Home's circle comes down at
                  // once, and the PILL's growth goes through the schedule, so
                  // the hold armed at press-in is the hold every press gets
                  // whichever mode it began in. This used to return early in
                  // search mode and discard that hold.
                  //
                  // HOME'S CIRCLE IS DIRECT because it has no travel to outlive:
                  // it is the object under the finger, and search mode is ending
                  // anyway, so it should let go when the finger does.
                  homeAmt.value = withSpring(0, PRESS_SPRING);
                  // AND UNCONDITIONALLY. Springing a value already at 0 to 0 is
                  // a no-op, so this needs no test for which object was pressed
                  // and cannot strand the one that was not.
                  //
                  // NO dragging GUARD HERE either. It was measured to be false
                  // at this point, whether or not a drag is about to begin, so
                  // it could only ever release. See PRESS_RELEASE_DELAY.
                  //
                  // AND THE SCHEDULE IS RIGHT IN BOTH MODES NOW. The immediate
                  // release was justified by "the pan is disabled in search
                  // mode, so no drag can want the window" — the pan is never
                  // disabled any more, so a drag CAN begin there and the 60ms
                  // floor it needs applies in both.
                  schedulePressRelease();
                }}
                accessibilityRole="button"
                accessibilityState={focused ? { selected: true } : {}}
                accessibilityLabel={item.label}
                style={st.item}
              >
                {/* A PLAIN VIEW AGAIN. It used to carry the one scale for the
                    whole stack; the scales are on the cells inside it now, and
                    all this does is centre the icon over the word. It is still
                    INSIDE the Pressable, which is what keeps the measurements
                    honest: the Pressable is flex: 1, so its box comes from the
                    row rather than from its contents, and onSlotLayout reports
                    that box. Nothing in here can move it. */}
                {/* TWO ITEMS STAY WHOLE, AND NEITHER MOVES. Home has its
                    circle drawn around it and Search has the pill standing on
                    it, so both keep their icon AND their word exactly where
                    normal mode puts them; only Flights and Bookings fade.

                    AND THEY READ DIFFERENTLY, which is the whole of what search
                    mode says with colour now. Search is green because the pill
                    is ON it and the wave says so. Home is INK_INACTIVE because
                    the pill is not, and the wave says that too. Neither is
                    overridden by anything; see WaveCharProps for what used to
                    be here. */}
                {/* FLIGHTS AND BOOKINGS LEAVE THE TREE IN SEARCH MODE rather
                    than fading out of it. They are Text and Svg, so an opacity
                    would have worked on them — but the mode is one boolean now
                    and every element of it answers that boolean the same way.
                    Two fewer animated nodes, and no state where a tab is half
                    on.

                    THE MEASUREMENT SURVIVES, which is the one thing that had to
                    be checked. onSlotLayout reads the PRESSABLE's box, and the
                    Pressable is flex: 1, so its x and width come from the row
                    rather than from these children. Emptying it changes only its
                    height, which nothing reads.

                    A PLAIN View AGAIN, because there is no animated style left
                    to carry. In normal mode this is what it always rendered:
                    all four stacks at full opacity. */}
                {(!searchMode || i === 0 || i === SEARCH_INDEX) && (
                <View style={st.stack}>
                  <WaveIcon
                    paths={item.paths}
                    index={i}
                    slotsSV={slotsSV}
                    capX={capX}
                    capR={capR}
                    pressAmt={pressAmt}
                    dragAmt={dragAmt}
                    fullR={stackFullR}
                    zeroR={stackZeroR}
                  />
                  {/* THE WORD, ONE CHARACTER PER CELL. Each cell is pinned to
                      LABEL_ADV rather than measured, which is what makes the
                      split free: the row is exactly n * 6.0 wide, the same
                      figure the shaped run produced, so no rounding can
                      accumulate across ten separate measurements. "My Flights"
                      CARRIES A SPACE AGAIN, and this is the arrangement that
                      makes that free: the cell is pinned to LABEL_ADV whatever
                      the text engine would have done with a whitespace-only
                      Text, so the space advances 6.0 and draws nothing. The note
                      that used to sit here said no label carried one any more
                      and that a fixed cell would handle it if one ever did —
                      which is now the case rather than the hypothesis.
                      NO COLOUR PASSED DOWN. Each character interpolates its own
                      from the wave, so the word is not one colour at all while
                      the pill is crossing it. */}
                  <View style={st.word}>
                    {item.label.split('').map((ch, k) => (
                      <WaveChar
                        key={k}
                        ch={ch}
                        index={i}
                        offset={charOffset(item.label.length, k)}
                        slotsSV={slotsSV}
                        capX={capX}
                        capR={capR}
                        pressAmt={pressAmt}
                        dragAmt={dragAmt}
                        fullR={stackFullR}
                        zeroR={stackZeroR}
                      />
                    ))}
                  </View>
                </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </GestureDetector>
      {/* THE OVAL'S TAP TARGET, AND NOTHING ELSE. The glass, the hairline, the
          prompt and the placeholder are all in ovalNode, which is drawn BEFORE
          the pill; this is the same rectangle with no paint in it, drawn AFTER
          the detector so its touches land.

          WHY THE OVAL HAD TO BE SPLIT IN TWO. Three orderings are each required
          and they cannot all hold for one element:

            the labels must draw over the pill      (normal mode, load-bearing)
            the pill must draw over the oval        (this round)
            the oval must take touches over the track

          The first two put the oval BELOW the track and the third puts it ABOVE.
          One view cannot be both, so the surface goes low and the hit area goes
          high. Home already worked this way: its circle is drawn before the
          detector and its taps are the item's own Pressable.

          GATED ON searchMode, like everything else in the mode now. It used to
          be the one thing that was, while the surfaces were held on past the
          end of search mode to fade; there is no such window any more, so the
          two conditions have become the same condition.

          IT STILL HAS TO BE ABSENT RATHER THAN DISABLED. An invisible hit area
          left over the tabs would swallow their taps, and a disabled Pressable
          swallows them too: React Native's responder walks ANCESTORS from the
          hit view rather than siblings beneath it. Not being in the tree is the
          only thing that reliably lets a touch through. */}
      {searchMode && (
        <Pressable
          style={[st.ovalTap, { left: ovalLeft, width: ovalTapW }]}
          onPress={() => setTyping(true)}
          accessibilityRole="button"
          accessibilityLabel="Open the search field"
        />
      )}
    </View>
  );

  return (
    <View
      style={[st.dock, { bottom: insets.bottom + TAB_BAR_MARGIN_V, paddingHorizontal: DOCK_INSET }]}
      pointerEvents="box-none"
    >
      {useGlass ? (
        // GlassContainer EXISTS in this version and both glass views are inside
        // it, which is what lets their effects merge the way Apple's do rather
        // than reading as one pane stacked on another. `spacing` is left at its
        // default: the capsule is already inside the pill, so there is no gap to
        // tune between them.
        //
        // NO GRADIENT SHELL, NO FILL, NO SHEEN on this path. GlassView produces
        // the edge, the body and the highlight natively, and painting ours over
        // the top would be two materials arguing about the same pixels.
        <GlassContainer>
          <GlassView glassEffectStyle="regular" style={[st.glassPill, typing && st.offscreen]}>
            {ovalNode}
            {capsuleNode}
            {content}
          </GlassView>
        </GlassContainer>
      ) : (
        // THE SHEETS' OWN ORDER, and no more than it: BarGlass then the
        // hairline, both inside a clip. That is sheetShell's structure with a
        // capsule radius — one material, spelled once, in lib/glass.tsx.
        //
        // THE CLIP NOW HOLDS THE MATERIAL AND NOTHING ELSE. It used to wrap the
        // content too, which put the pill inside an overflow: hidden box and cut
        // anything that grew past the bar's edge. The clip has to stay, because
        // it is what confines the blur to the rounded rectangle; so the pill and
        // the content came out instead and the clip became an absolute layer
        // behind them.
        //
        // THE ORDER IS THE POINT, and it is the one thing to preserve here:
        // glass, then pill, then labels. The pill has to paint over the material
        // and under the text, and in React Native that is sibling order — a
        // child of the clip could not be raised above the clip's own siblings by
        // any zIndex, which is exactly why the labels had to come out with it.
        // Nothing is lost by unclipping them: the labels sit well inside the
        // radius and never reach a corner.
        // THE BAR IS PUSHED OUT OF SIGHT WHILE THE FULL FIELD IS UP, and both
        // paths take it. It is a transform rather than a removal, because this
        // view is the GestureDetector's ancestor. See st.offscreen.
        <View style={[st.shell, typing && st.offscreen]} onLayout={onShellLayout}>
          {/* THE SURFACE, AND IT IS ONE NODE SO IT CAN GROW AS ONE. The material,
              its border and its shadow are the three things that are the bar; the
              pill and the labels are things ON the bar and must not scale with
              it. Sibling order therefore does double duty now — it is still
              glass, then pill, then labels, and the first of those three is also
              the only one inside the transform.

              NOTHING WHITE BEHIND THE BLUR. The clip and its material are the
              outermost thing, and the hairline is drawn over them rather than
              wrapped around them. Both orders put the edge in front of the blur;
              only a gradient SHELL put white behind it, and that is the mistake
              this arrangement exists to avoid.

              MEASURED, because the border is an SVG stroke and a Rect needs
              pixel dimensions. See shellBox. */}
          <Reanimated.View style={[st.surface, barSurfaceStyle]} pointerEvents="none">
            {/* THE BAR'S GLASS IS UNMOUNTED IN SEARCH MODE, and this is the
                half that was missing. It was faded on 1 - searchAmt, which a
                BlurView does not honour, so the bar's slab went on painting
                underneath the search objects and reappeared whenever something
                forced a recomposite. Nothing here is asked to be transparent
                any more; it is in the tree or it is not. */}
            {!searchMode && (
              <View style={st.clip}>
                <BarGlass />
              </View>
            )}
            {/* THE BORDER, WITH A HOLE WHERE THE PILL IS. It was a plain View
                with a borderWidth, which cannot have a hole cut in it; an SVG
                stroke can, because a mask is a paint operation rather than a
                layout one.
                WHITE SHOWS, BLACK HIDES. The mask is a white rectangle over the
                whole bar with a black rounded rect at the pill's live box
                punched out of it, so the stroke paints everywhere except under
                the pill.
                IN FRONT OF THE BLUR, exactly where the View it replaces was —
                this is a sibling AFTER the clip, so nothing white has moved
                behind a BlurView.
                Rendered only once measured, so no half-sized border flashes. */}
            {!searchMode && shellBox !== null && (
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                <Defs>
                  <Mask
                    id={EDGE_MASK_ID}
                    maskUnits="userSpaceOnUse"
                    maskContentUnits="userSpaceOnUse"
                    x={0}
                    y={0}
                    width={shellBox.w}
                    height={shellBox.h}
                  >
                    <Rect x={0} y={0} width={shellBox.w} height={shellBox.h} fill="#ffffff" />
                    <AnimatedRect animatedProps={edgeHoleProps} fill="#000000" />
                  </Mask>
                </Defs>
                {/* UNCHANGED BY THE GROWTH, and deliberately. The stroke is
                    drawn in the surface's own coordinates, so the surface's
                    scale grows it and thickens it without a single animated
                    value here. The mask's bounds do not move either: the
                    border stays inside them whatever the scale, because both
                    are in that same space. */}
                <Rect
                  x={0.5}
                  y={0.5}
                  width={shellBox.w - 1}
                  height={shellBox.h - 1}
                  rx={BAR_R - 0.5}
                  ry={BAR_R - 0.5}
                  fill="none"
                  stroke={SHEET_EDGE}
                  strokeWidth={1}
                  mask={`url(#${EDGE_MASK_ID})`}
                />
              </Svg>
            )}
          </Reanimated.View>
          {ovalNode}
          {capsuleNode}
          {content}
        </View>
      )}
      {/* THE FULL FIELD, ABOVE THE KEYBOARD. Mounted only while typing, so its
          autoFocus fires on the way in and there is no input holding focus the
          rest of the time.

          POSITIONED FROM THE KEYBOARD'S OWN HEIGHT rather than by a
          KeyboardAvoidingView, and the dock is why: KeyboardAvoidingView works
          by padding or translating a container it wraps, and this container is
          absolutely positioned at the bottom of the screen with no flow to push.
          Reading endCoordinates.height and placing the field is direct, exact,
          and travels with the keyboard on iOS because the Will event fires
          before it moves.

          THE ARITHMETIC IS AGAINST THE DOCK, NOT THE SCREEN. `bottom` here is
          measured from the dock's own bottom edge, which already sits
          insets.bottom + TAB_BAR_MARGIN_V up from the screen; subtracting that
          back off puts the field FIELD_GAP above the keyboard in screen terms.

          THE INSET IS THE FIELD'S OWN, AND THE NOTE HERE USED TO BE WRONG.
          It claimed left: 0 inherited the dock's DOCK_INSET padding because an
          absolutely positioned child resolves against its parent's padding box.
          It does not. Yoga's AbsoluteLayout.cpp adds the parent's border and the
          child's own margin to a defined inset and NO PADDING TERM at all
          (positionAbsoluteChild, the isInlineStartPositionDefined branch); the
          padding is added only for children with no insets, which take the
          parent's justify and align rules instead. So left: 0 was the dock's
          outer edge, which is the screen's, and the field really was running
          edge to edge.

          IT IS SPELLED OUT NOW, in the stylesheet rather than here, and it is
          the same 16 the bar takes. The right inset carries the X's 56 and its
          8 of gap on top of it. See st.fullField. */}
      {typing && (
        <View
          style={[
            st.fullField,
            {
              bottom: kbH + FIELD_GAP - (insets.bottom + TAB_BAR_MARGIN_V),
              // IT DOES NOT SHOW UNTIL IT KNOWS WHERE IT IS. kbH is 0 on the
              // frame this mounts, because the thing that opens the keyboard is
              // the autoFocus on the input INSIDE it, which cannot run before
              // the mount. `bottom` is therefore 0 + 8 - 36 = -28 on that first
              // frame: a full-width blurred field drawn across the bottom of the
              // screen, over the bar and into the strip the keyboard is about to
              // cover. Through a translucent keyboard that reads as a second
              // copy of the field, which is exactly what it is.
              //
              // OPACITY RATHER THAN A MOUNT GUARD, and the difference matters.
              // Not rendering until kbH > 0 would be a deadlock: no field means
              // no input, no input means no autoFocus, and no autoFocus means
              // the keyboard never opens to report a height. The field has to
              // EXIST to raise the keyboard; it just must not be seen doing it.
              opacity: kbH > 0 ? 1 : 0,
            },
          ]}
          // An invisible view still catches touches, and this one is briefly
          // sitting on top of the tab bar.
          pointerEvents={kbH > 0 ? 'auto' : 'none'}
        >
          {/* THE BAR'S OWN ORDER: the material inside a clip, the hairline drawn
              over it as a sibling. Nothing white goes behind the blur. */}
          <View style={st.fullClip}>
            <BarGlass />
          </View>
          <View style={st.fullEdge} pointerEvents="none" />
          <View style={st.fullRow}>
            <Text style={st.prompt}>{`~/${searchName}:-$`}</Text>
            <View style={st.fullBody}>
              <TextInput
                style={st.fullInput}
                value={query}
                onChangeText={setQuery}
                autoFocus
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={200}
                selectionColor="#4ade80"
                multiline={false}
                blurOnSubmit
              />
              {query.length === 0 && <TabBarPlaceholder size={INPUT_FS} prompts={SEARCH_PROMPTS} />}
            </View>
          </View>
        </View>
      )}
      {/* THE WAY OUT OF THE FIELD, and it is a SIBLING of the field rather than
          a child of its row.

          WHY BESIDE IT AND NOT INSIDE IT. Two reasons, and the first is
          arithmetic: the field is SEARCH_CIRCLE tall and the circle is
          SEARCH_CIRCLE wide, so a circle inside the field would be flush with
          its top and bottom edges with nowhere to breathe. The second is that
          the field's row, its padding and its metrics are not this round's to
          touch. Outside, the field keeps every one of them and simply ends
          sooner.

          AND IT IS THE BAR'S OWN VOCABULARY. A glass capsule with a glass circle
          SEARCH_OBJ_GAP beside it is exactly what the collapsed bar already is;
          this is that arrangement moved above the keyboard.

          THE SAME TREATMENT AS HOME'S CIRCLE, to the style: searchObjClip holds
          BarGlass, searchObjFill is the 0.03 white over it, searchObjEdge is the
          hairline over that. Three shared styles, so the two objects cannot
          drift apart. Nothing white goes behind the blur.

          IT LEAVES THE FIELD, NOT SEARCH MODE. The keyboard goes away and
          `typing` goes false, which is precisely what dismissing the keyboard by
          any other means already does; searchMode is untouched, so the bar comes
          back collapsed with its objects and whatever has been typed. Home is
          still the only thing that leaves search mode altogether.

          Keyboard.dismiss() AND setTyping(false) TOGETHER. The hide listener
          would set typing false on its own, but only if a hide event actually
          arrives; saying it here as well is the same belt-and-braces the two
          exit paths already use. */}
      {typing && (
        <Reanimated.View
          style={[
            st.closeBtn,
            {
              bottom: kbH + FIELD_GAP - (insets.bottom + TAB_BAR_MARGIN_V),
              // The field's own guard, for the field's own reason: on the frame
              // this mounts kbH is 0 and `bottom` is -28. See there.
              opacity: kbH > 0 ? 1 : 0,
            },
            closeStyle,
          ]}
          pointerEvents={kbH > 0 ? 'auto' : 'none'}
        >
          <View style={st.searchObjClip}><BarGlass /></View>
          <View style={st.searchObjFill} pointerEvents="none" />
          <View style={st.searchObjEdge} pointerEvents="none" />
          <Pressable
            style={st.closeTap}
            onPress={() => { Keyboard.dismiss(); setTyping(false); }}
            onPressIn={() => { closeAmt.value = withSpring(1, PRESS_SPRING); }}
            onPressOut={() => { closeAmt.value = withSpring(0, PRESS_SPRING); }}
            accessibilityRole="button"
            accessibilityLabel="Close the search field"
          >
            {/* THE RED, and it is index.tsx's own. That file draws these two
                paths in rgba(248,113,113,0.55) for the sheet's dismiss button,
                and this is the same control doing the same job, so it is the
                same colour rather than a grey chosen to argue with it. See
                INK_CLOSE for what it costs in contrast and why that is the
                app's register rather than a slip.

                AT ICON_SIZE, not index.tsx's 20. The geometry is that file's to
                the character; the SIZE is this bar's, and every other glyph here
                is 22 over a 24 box. */}
            <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24">
              <G fill="none" stroke={INK_CLOSE} strokeWidth={1.75} strokeLinecap="round">
                <Path d={ICON_CLOSE_A_D} />
                <Path d={ICON_CLOSE_B_D} />
              </G>
            </Svg>
          </Pressable>
        </Reanimated.View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  // A FULL-WIDTH DOCK HOLDING A CONTENT-SIZED PILL, rather than an absolutely
  // positioned pill centring itself. Both were possible; this one does not
  // depend on how Yoga applies a parent's align rules to an absolutely
  // positioned child, which is the subtle half of the alternative. Here the
  // pill is an ordinary in-flow child and alignItems centres it the way it
  // centres anything.
  //
  // BottomTabView renders whatever tabBar returns as a direct child of its own
  // full-screen column, with no wrapper of its own, so these offsets are the
  // screen's.
  //
  // box-none: the dock spans the whole width but is not a touch target, so a
  // tap outside the pill falls through to the page.
  //
  // THE 20 IS THE PAGE MARGIN, and it is on the DOCK rather than the pill
  // because of what the two are. The dock is absolutely positioned, so left and
  // right on IT are insets from the screen; the pill is an ordinary in-flow
  // child, where left and right would be relative OFFSETS that shift it without
  // resizing it. Padding here and stretch below is the only combination that
  // makes the pill actually span. It matches s.scroll's 20 on the pages behind.
  //
  // alignItems STRETCH, replacing the 'center' that was here while the pill was
  // content-sized. There is nothing left to centre: the pill now fills the
  // dock's content box.
  // NO paddingHorizontal HERE. It is solved per screen and applied at the call
  // site, where useWindowDimensions can see the width. See dockInset.
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'stretch',
  },
  // THE GLASS PILL. borderRadius comes through `style` because there is no
  // standalone borderRadius prop in this version — GlassViewProps is its own
  // four keys `& ViewProps`, so style, children, onLayout and pointerEvents all
  // arrive the ordinary way and the native view spreads them straight through.
  //
  // NO SHADOW HERE, unlike the fallback shell: the native effect carries its own
  // shading, and stacking ours under it would be a second, flatter drop shadow
  // fighting the real one.
  glassPill: { height: BAR_H, borderRadius: BAR_R },
  // THE BAR'S LAYOUT BOX, AND IT DOES NOT MOVE. BAR_H here is what Yoga lays
  // the row out against and what TAB_BAR_HEIGHT exports to profile.tsx; the
  // press grows the SURFACE inside it and leaves this alone, so no screen's
  // content shifts when a tab is pressed.
  //
  // ELEVATION STAYS HERE while the iOS shadow moved down to the surface, and
  // that split is not tidiness. On Android elevation also orders siblings, and
  // the surface IS a sibling of the pill and the labels — elevating it would
  // draw the glass over both of them. Kept on the parent, it orders nothing
  // against anything and the Android z-order is exactly what it was.
  shell: {
    height: BAR_H,
    borderRadius: BAR_R,
    elevation: 12,
  },
  // THE BAR, OUT OF SIGHT, WHILE THE FULL FIELD IS UP.
  //
  // WHAT IT IS FOR. The dock sits at the bottom of the screen and the keyboard
  // covers the bottom of the screen, but an iOS keyboard is TRANSLUCENT: it
  // shows what is behind it. So Home's circle, the search pill and the oval's
  // prompt were all legible through it, three objects belonging to a bar the
  // user had already left behind.
  //
  // A TRANSLATE, NOT display: 'none', AND THAT IS THE WHOLE OF THE FOURTH BUG.
  // display took this view — the GestureDetector's ANCESTOR — out of the native
  // hierarchy, and an open gesture whose view has gone can never finalize:
  // handleGesture: returns early on `view.reactTag == nil`
  // (apple/RNGestureHandler.mm:287-291) and emits nothing, so onFinalize never
  // runs and the recogniser is held open forever. See the rule at the gesture.
  //
  // A TRANSFORM CHANGES NOTHING BUT WHERE PIXELS LAND. The view stays mounted,
  // stays in the hierarchy, keeps its tag, and keeps every handler attached to
  // it; Yoga never sees a transform, so the layout is identical too. It is the
  // one way to hide this subtree that the gesture cannot notice.
  //
  // AND NOT OPACITY, for the reason this file has learned four times: two of the
  // three objects inside are BlurViews, and a BlurView asked to be transparent
  // is not a BlurView that has gone. Off-screen it genuinely is not drawn.
  //
  // THE FULL FIELD IS NOT AFFECTED. It is an absolutely positioned sibling of
  // the shell inside the dock, and a transform on the shell cannot move a
  // sibling. Nothing about the field's geometry is touched by this.
  offscreen: { transform: [{ translateY: TYPING_OFFSCREEN_SHIFT }] },
  // THE SURFACE, which is everything that IS the bar rather than everything on
  // it, gathered into one node so one transform can grow all of it. See
  // BAR_GROW.
  //
  // THE SHADOW IS HERE, not on the dock, because the dock is full-width and
  // invisible: a shadow cast by it would be a rectangle the width of the screen.
  // Being here rather than on the shell also means it GROWS WITH THE SURFACE,
  // which is what a control coming up to meet a finger should do; and it is now
  // cast by the rounded rectangle alone instead of by the union of that with the
  // labels, which is a cleaner shape than it was.
  //
  // AND overflow IS NOT HERE, which is why there are two views rather than one.
  // On iOS `overflow: hidden` sets masksToBounds, and a layer that masks to its
  // bounds clips its own drop shadow away with everything else outside them. The
  // shadow needs an unclipped node; the blur needs a clipped one. They cannot be
  // the same node, so the clip is the child below.
  surface: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: BAR_R,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  // sheetShell's job exactly: round, and CLIP, because the clip is what confines
  // the blur to the rounded rectangle. absoluteFill and the FULL radius, as the
  // outermost layer: the hairline is drawn over it and takes no layout at all.
  clip: { ...StyleSheet.absoluteFillObject, borderRadius: BAR_R, overflow: 'hidden' },

  // The track's inset inside the bar. 0 today — see TRACK_PAD — and kept as the
  // expression because it is where that inset would go if it ever returns.
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: TRACK_PAD },
  // BOTH, and they do different jobs: flex grows the track along the row's main
  // axis so it fills the pill's width, and alignSelf stretch gives it the row's
  // full HEIGHT on the cross axis. It was content-sized while the pill was.
  //
  // NO justifyContent. The items are flex: 1 and divide the track exactly
  // between them, so there is no free space for a distribution rule to place and
  // space-between had become inert.
  track: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  // A STATIC left PLUS AN ANIMATED translateX, rather than animating `left`
  // itself: the transform runs on the UI thread and does not lay the row out
  // again on every frame.
  //
  // 0.03, DOWN FROM 0.10, and it is CARD_FILL's value rather than a new one.
  // This sits ON the glass, and a tenth of white over a surface whose whole
  // design is a black tint is the same wash the shell used to be. Over the bar's
  // own ground of about rgb(3.0) it lands at rgb(10.6): seven and a half levels,
  // which is exactly the separation CARD_FILL buys a card on the page.
  //
  // THE HAIRLINE IS WHAT YOU ACTUALLY SEE. A 0.08 line over that ground renders
  // at rgb(23) — the same figure the sheet's own edge is specified at — and a
  // defined outline reads at a glance where seven levels of fill does not. It
  // matters more here than on a sheet, because content scrolls under this bar
  // and lifts the ground beneath the fill while leaving the line untouched.
  // left: TRACK_PAD, AND THAT IS THE WHOLE COST OF MOVING OUT OF THE TRACK.
  // capX is measured in track coordinates, and the track begins exactly
  // TRACK_PAD inside the shell because that is the row's own padding. Starting
  // the pill there keeps every position calculation, the drag clamp and the
  // settle spring reading the same numbers. TRACK_PAD is 0 today, so this
  // resolves to 0 — written as the relationship rather than the value, because
  // it is the relationship that has to stay true.
  capsule: {
    position: 'absolute',
    left: TRACK_PAD,
    top: CAPSULE_TOP,
    height: CAPSULE_H,
    borderRadius: CAPSULE_R,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  // Rounds the frost and stops a rectangular BlurView showing at the corners.
  // absoluteFill and the full radius, for the same reason the bar's clip is:
  // the hairline sits over it rather than around it.
  capsuleClip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: CAPSULE_R,
    overflow: 'hidden',
  },
  // The same hairline at the pill's own radius, for the same reasons.
  capsuleEdge: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: CAPSULE_R,
  },
  // The same box, minus the paint: on the glass path the GlassView inside does
  // the painting, so this is geometry and motion only.
  // left: TRACK_PAD for the reason given at `capsule`.
  capsuleBox: {
    position: 'absolute',
    left: TRACK_PAD,
    top: CAPSULE_TOP,
    height: CAPSULE_H,
  },
  capsuleGlass: { ...StyleSheet.absoluteFillObject, borderRadius: CAPSULE_R },
  // flex: 1, SO THE FOUR SLOTS ARE IDENTICAL and the pill is one shape wherever
  // it stands. The word no longer sets the width; the track divided by four
  // does.
  //
  // AND THE HORIZONTAL PADDING IS GONE WITH IT. Its only job was to give a
  // content-sized item its width, and flex owns that now. Keeping it would have
  // been a 32pt inset on the label for no reason and one real cost: it caps the
  // text at slot - 32, and the slot is (windowW - DOCK_INSET * 2) / 4, so that
  // ceiling is 60.50 at 402, 53.75 at 375 and 40.00 at 320. "My Flights" is ten
  // characters of LABEL_ADV, 60.00, so the padded box clears the 402 by half a
  // point and TRUNCATES ON EVERY SCREEN BELOW IT. Without it the label has the
  // whole slot — 92.50, 85.75 and 72.00 — and clears all three. The touch
  // target does not shrink — the Pressable IS the slot now, which is wider than
  // the padded box ever was.
  //
  // THE FIGURES HERE WERE THREE-SLOT ONES, and all three parts of them moved.
  // 74.33 and 56.00 were slot - 32 over THREE tabs at a 28pt dock inset, and
  // "my flights" at 66.00 was ten characters at an 11pt type. The bar has four
  // tabs, DOCK_INSET is 16, and LABEL_FS is 10.
  //
  // alignItems centre still stacks the icon over the word and centres both in
  // the slot; paddingVertical still sets the item's height. See ITEM_PAD_V.
  item: { flex: 1, paddingVertical: ITEM_PAD_V, alignItems: 'center' },
  // BarGlass's second layer. Black, and over the blur rather than under it.
  barFill: { backgroundColor: BAR_FILL },

  // ── SEARCH MODE ──────────────────────────────────────────────────────────
  // THE TWO GLASS OBJECTS, and one style serves both because only their width
  // differs: Home is a pill the width of its slot, the magnifier is a circle of
  // SEARCH_CIRCLE, and `left` and `width` both come from the call site.
  //
  // THREE LAYERS, IN THE PILL'S OWN ORDER. This box paints nothing: the clip
  // below holds BarGlass, the fill tints it, the hairline draws over both. That
  // is st.capsule's structure with BarGlass in place of its own intensity-12
  // blur, which is the one thing here that is the OVAL's material rather than
  // the pill's — see the report. The oval beside them is the same three
  // layers minus the fill.
  //
  // THE RADIUS IS HALF THE HEIGHT ON ALL THREE, which makes the magnifier round
  // and Home a capsule from the same number, and it is on the LAYERS rather than
  // on this box because this box has nothing left to round.
  searchObj: {
    position: 'absolute',
    top: CAPSULE_TOP,
    height: SEARCH_CIRCLE,
  },
  searchObjClip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: SEARCH_CIRCLE / 2,
    overflow: 'hidden',
  },
  // st.capsule's OWN FILL, to the value: a thirtieth of white, which is
  // CARD_FILL's 0.03 rather than a number chosen for this. It is spelled here
  // rather than shared with st.capsule because lifting it into a constant would
  // mean editing a normal-mode style to change nothing about it.
  //
  // AND IT IS IN FRONT OF THE BLUR, which is the one place this deliberately
  // does NOT copy st.capsule: there the 0.03 is a backgroundColor on the parent,
  // so the pill's own BlurView samples it. Four separate greyings in this file
  // have come from white behind a blur, and there is no reason to add a fifth
  // for a layer order that composites to the same thing either way.
  searchObjFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: SEARCH_CIRCLE / 2,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  // The same hairline the pill and the oval draw, at the same radius.
  searchObjEdge: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: SEARCH_CIRCLE / 2,
  },

  // THE OVAL. Same height and the same top as the circles, so the three sit on
  // one line; `left` and `width` come from the call site. Its own glass is a
  // child rather than a background on this box, because the glass animates and
  // the text inside this box must not.
  searchOval: {
    position: 'absolute',
    top: CAPSULE_TOP,
    height: SEARCH_CIRCLE,
    justifyContent: 'center',
  },
  searchOvalClip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: SEARCH_CIRCLE / 2,
    overflow: 'hidden',
  },
  searchOvalEdge: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: SEARCH_CIRCLE / 2,
  },
  // THE OVAL'S TEXT ROW, and it is a row rather than a tap area: the Pressable
  // that used to wear this style is a separate, empty one after the detector.
  //
  // ONLY THE LEFT IS HERE. The right is pillW and comes from the call site,
  // because the pill's width is a per-screen render value and this is a
  // StyleSheet. Spelled as paddingLeft rather than paddingHorizontal so the two
  // edges cannot argue about which one wins.
  //
  // AND A PRESSED PILL DOES REACH PAST IT. The text ends exactly at the pill's
  // resting left edge, and a press grows the pill PRESS_GROW = 10 further left,
  // so the last 10 points of a full placeholder sit under it while a finger is
  // down. That is the padding that was asked for; SEARCH_OBJ_GAP more would
  // clear it, at the cost of a character and a half of room.
  barFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
  },
  // THE OVAL'S HIT AREA, drawn after the detector and painting nothing. Same
  // top and height as the surface, and the same left — but a SHORTER width, so
  // it ends where the pill begins. See ovalTapW.
  ovalTap: {
    position: 'absolute',
    top: CAPSULE_TOP,
    height: SEARCH_CIRCLE,
  },
  // flex so the placeholder takes what the prompt leaves, and hidden so a long
  // one is clipped at the field's edge rather than pushing it wider.
  barFieldBody: { flex: 1, overflow: 'hidden' },
  barQuery: { fontFamily: MONO, fontSize: BAR_PROMPT_FS, color: '#ffffff' },

  // index.tsx's own prompt, to the point: same colour, same family, same 13,
  // same 8 of margin and 2 of optical lift off the baseline.
  prompt: {
    color: '#4ade80',
    fontFamily: MONO,
    fontSize: PROMPT_FS,
    marginRight: 8,
    paddingTop: 2,
  },
  // index.tsx's fakePlaceholder: absolute so it sits under the caret rather than
  // displacing it, and the same near-black grey.
  placeholder: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    color: '#2c2c2e',
    fontFamily: MONO,
  },

  // THE FULL FIELD, AND IT IS A CAPSULE. Same material and same hairline as the
  // bar, at the bar's own object height so it reads as the same family of thing
  // rather than as a panel that happens to be nearby. The shadow is the shell's,
  // so the two sit off the page by the same amount.
  //
  // THE HEIGHT IS STATED, and that is the whole fix. It had none: the box was
  // sized by its contents, which came to about 47.80 on iOS and roughly three
  // points more on Android, where includeFontPadding adds to a TextInput. A
  // radius of 16 against a half-height of 23.90 is 67% of a capsule, which is
  // exactly what "slightly rounded corners" looks like — and it was a different
  // 67% on each platform.
  //
  // SEARCH_CIRCLE, NOT A NEW NUMBER. 56 is the bar's own object height, so the
  // radius is half of it and the field is the same capsule the oval is. It holds
  // the content easily: the prompt's line box is 19.16 and the input's 19.80, so
  // there is better than 18 above and below.
  //
  // AND NOT SHEET_RADIUS. That 16 belongs to lib/glass.tsx and to the sheets in
  // app/index.tsx, which are panels and should stay panels. It is no longer read
  // in this file at all; see the import.
  fullField: {
    position: 'absolute',
    // 16 FROM THE SCREEN ON THE LEFT, and it has to be said rather than
    // inherited: Yoga does not add a parent's padding to a defined inset, so the
    // dock's DOCK_INSET does nothing for this box. See the note at the call site
    // for the source reference.
    left: DOCK_INSET,
    // AND THE X'S SPACE ON THE RIGHT. Same 16 off the screen, plus the circle
    // and the gap it needs, so the field and the button together span exactly
    // what the bar spans: 370 at 402 and 343 at 375, of which the field is
    // 306.00 and 279.00.
    right: DOCK_INSET + SEARCH_CIRCLE + SEARCH_OBJ_GAP,
    height: SEARCH_CIRCLE,
    borderRadius: SEARCH_CIRCLE / 2,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  fullClip: { ...StyleSheet.absoluteFillObject, borderRadius: SEARCH_CIRCLE / 2, overflow: 'hidden' },
  fullEdge: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: SHEET_EDGE,
    borderRadius: SEARCH_CIRCLE / 2,
  },
  // flex AND centre, because the height is the field's now rather than this
  // row's. The vertical padding went with it: a fixed 56 with the row filling it
  // centres the content by construction, and 14 on top of that would have made
  // the field 28 taller than the capsule it is supposed to be.
  fullRow: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  fullBody: { flex: 1 },
  // index.tsx's input, minus the textAlign it did not need: 15pt mono in white.
  fullInput: { fontFamily: MONO, fontSize: INPUT_FS, color: '#ffffff', padding: 0 },

  // THE X BESIDE THE FIELD. Square at the field's own height, so half of it is
  // the radius and the three shared layers inside make it a circle; `bottom`
  // comes from the call site because it tracks the keyboard exactly as the field
  // does. 16 off the screen on the right, which is where the bar's own edge is.
  closeBtn: {
    position: 'absolute',
    right: DOCK_INSET,
    width: SEARCH_CIRCLE,
    height: SEARCH_CIRCLE,
  },
  closeTap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // WHAT THE SCALE IS APPLIED TO. It carries the centring the item used to do
  // for these two directly; the item still centres this wrapper inside the slot,
  // so the glyph sits over the middle of the word exactly as before. No height
  // and no width: it is content-sized, which is what makes ITEM_CONTENT_H the
  // real number the growth is derived against.
  stack: { alignItems: 'center' },
  // THE WORD'S ROW, and it is where ICON_GAP lives now. The gap used to be a
  // marginTop on the label itself; with the label split into cells that margin
  // would have sat INSIDE each animated box and been scaled with the glyph,
  // sliding the character down as it grew. On the row it is outside every scale,
  // so the whole word keeps its distance from the icon however the wave moves
  // through it. The VALUE is untouched — only which node carries it.
  word: { flexDirection: 'row', marginTop: ICON_GAP },
  // ONE CHARACTER'S BOX, fixed at the advance rather than measured. See the note
  // at the word above: this is what guarantees the split costs no width.
  cell: { width: LABEL_ADV, alignItems: 'center' },
  // The gap between the glyph and the word. A margin rather than a `gap` on the
  // item, because the item's only other child is the icon and one number in one
  // place is easier to find than a container property that governs it.
  // THE INACTIVE INK IS THE BASE, and the animated style paints over it. A Text
  // with no colour at all would flash at the default before the first style
  // frame lands; starting where the wave starts means the first frame is
  // already right.
  label: { fontFamily: MONO, fontSize: LABEL_FS, color: INK_INACTIVE },
});
