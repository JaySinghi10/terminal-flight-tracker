import { useEffect, useRef, useState } from 'react';
import {
  View, Pressable, StyleSheet, AccessibilityInfo, useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
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
// SHEET_EDGE IS BACK, because both surfaces draw a flat hairline again and this
// is the colour every other surface in the app draws its edge in. The material
// underneath is the shared one too; lib/glass.tsx is untouched.
import { GlassLayers, SHEET_EDGE } from '../lib/glass';

// Declared here rather than imported from a screen, for the same reason
// profile.tsx declares its own: a component reaching into a route for a string
// constant would couple the two. The value is the family name _layout registers.
const MONO = 'JetBrainsMono_400Regular';

// THE TYPE SIZE, AND IT IS THE ROOT OF TWO OTHERS NOW. 12, up from 11, because
// the wave travelling through the word could not be read at the smaller size —
// a 7pt growth on a glyph is a proportion of the glyph, and the glyph was the
// thing that needed to be bigger.
const LABEL_FS = 12;
// THE ONE MEASURED NUMBER EVERYTHING ELSE COMES FROM, AND IT IS DERIVED NOW
// RATHER THAN WRITTEN. JetBrains Mono's own metrics are ascender 1020,
// descender -300, lineGap 0 over 1000 units per em — 1.32 em — so the line box
// is exactly 1.32 times the type size: 15.84 at 12, as it was 14.52 at 11.
// OS/2's typo and win figures agree with hhea, so iOS and Android measure it the
// same. Stating it as the ratio means the size can move without this going
// stale behind it, which is what happened the last time it was a literal.
const LABEL_LINE_H = LABEL_FS * 1.32;                         // 15.84
// ONE CHARACTER'S ADVANCE, AND THIS IS WHY THE WORD CAN BE SPLIT AT ALL.
// JetBrains Mono is monospace: every Latin glyph advances 600 of its 1000 units
// per em, so at 12pt every character occupies exactly 7.2pt whatever it is.
// Character positions are therefore ARITHMETIC rather than measurement, and no
// per-glyph onLayout is needed to find them.
const LABEL_ADV = LABEL_FS * 0.6;                             // 7.2
// 22, UP FROM 20, for the same reason the type grew: the wave is a proportion of
// what it moves through.
const ICON_SIZE = 22;
const ICON_GAP = 4;
// An item is an icon over a label: 22 + 4 + 15.84 = 41.84 of content, up from
// 38.52. Every figure below is derived from that and from BAR_H.
const ITEM_CONTENT_H = ICON_SIZE + ICON_GAP + LABEL_LINE_H;   // 41.84

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
// 41.84 of content centred in 56 leaves 7.08 above and below — still
// comfortably past the 4 that keeps a glyph off a rounded edge, though 1.66
// less than the 8.74 the smaller stack had. That clearance is fixed by the two
// heights alone: item and capsule share a centre, so the padding below cannot
// change it.
//
// AND THE GROWN STACK STILL FITS. At full press the content is 41.84 + 7 =
// 48.84, which is 3.58 inside the 56 the pill gives it. The stack can grow
// without any part of it reaching the pill's edge.
//
// WHAT THE PADDING DOES SET is the touch target, and deriving it this way makes
// the item box exactly the capsule: 38.52 + 8.74 + 8.74 = 56. The thing you can
// press and the thing that lights up are the same rectangle, to the point.
const ITEM_PAD_V = (CAPSULE_H - ITEM_CONTENT_H) / 2;          // 7.08
// 8, AND IT IS AIR NOW RATHER THAN AN ALLOWANCE. It was 20 because the pill was
// 0, AND THE PILL'S WIDTH IS WHY IT CAN BE. This inset the track inside the bar,
// which meant it also divided into the slots — slot = (bar - 2 * TRACK_PAD) / 3
// — and while the pill was derived from the slot, moving this moved the pill.
// It is not any more (see PILL_W), so the track can take the bar's full inner
// width and the gap at the ends comes from the pill centring in its slot alone.
//
// KEPT AS A NAMED ZERO rather than deleted. It still expresses a real
// relationship: the track's inset inside the bar, and the offset the pill's
// `left` needs to stay in track coordinates. Both are 0 today; neither is
// meaningless.
//
// THE SLOTS ARE WHAT IS LEFT, in thirds of the bar: 105.33, and the SAME on a
// 402pt iPhone 17 as on a 375pt SE. This said 120.67 and 111.67, which were the
// figures from before DOCK_INSET_MIN existed and the inset was a constant 20;
// the inset is solved per screen now to hold the bar at BAR_INNER_W, so the
// thirds of it do not vary with the window either. 101.33 at 320, where the
// floor engages and the bar finally narrows.
const TRACK_PAD = 0;

// THE PILL'S WIDTH, STATED RATHER THAN DERIVED, and locked here deliberately.
//
// It was `max slot width - 16`, which tied it to the slots: every change to the
// bar's inset, to TRACK_PAD, or to the number of tabs resized the pill as a side
// effect. 99.33 is exactly what that expression produced at a 402pt screen, kept
// because it was CHOSEN BY EYE at that size and looked right.
//
// DO NOT RE-DERIVE THIS FROM THE SLOT. The whole point of the constant is that
// the pill is now one fixed object that moves between slots rather than a
// function of them. It centres in whichever slot is active, and that centring
// still reads the measured slot geometry — only the width is fixed.
//
// It is the same on every screen, and the bar's inset is now derived to keep the
// end gap the same with it — see DOCK_INSET_MIN.
const PILL_W = 99.33;

// THE AIR AT THE ENDS, and the one number the horizontal geometry is solved for.
// The pill rests centred in its slot, so the gap is (slot - PILL_W) / 2; asking
// for 3 fixes the slot at PILL_W + 6 and the bar's inner width at three of them.
const END_GAP = 3;
const BAR_INNER_W = 3 * (PILL_W + END_GAP * 2);               // 315.99
// A CONSTANT INSET CANNOT HOLD A CONSTANT GAP. The bar's width comes from the
// screen and the pill does not, so 20 a side gave 10.67 of gap at 402 and 6.17
// at 375. The inset is solved per screen instead, at the call site where
// useWindowDimensions can see the width:
//
//   inset = (windowWidth - BAR_INNER_W) / 2
//
// which is 43.005 at 402 and 29.505 at 375, and puts the gap at 3.00 on both.
//
// THE FLOOR IS 8, and it exists so the bar can never be wider than the screen.
// It engages below a 331.99pt window, where the raw inset would drop under 8;
// from there the bar stops growing and the gap closes instead — 1.00 at 320.
// The pill would only overflow its slot below 313.99pt, narrower than any
// iPhone that ships.
const DOCK_INSET_MIN = 8;

// THE BODY IS NOT SPELLED HERE, AND THE EDGE IS. That split is deliberate and
// worth stating, because this bar once drew all of it and that was wrong.
//
// WHAT IT USED TO DRAW: a gradient shell for the edge, a white FILL over the
// blur, and a white SHEEN over the top 45%. Three white layers. That is what
// app/index.tsx's SHEET_FILL and SHEET_EDGE comments are about — a low-alpha
// white ramp SPREAD over a surface reads as grey, and the panel stops being a
// window and becomes a card.
//
// THE FILL AND THE SHEEN ARE STILL GONE and are not coming back. The body is
// lib/glass.tsx's GlassLayers, the same blur and the same black tint every sheet
// and dropdown uses, untouched.
//
// WHAT CAME BACK IS ONE FLAT PIXEL OF IT, which is index.tsx's own hairline and
// nothing more: spreading white over 20pt integrates into a wash, while the same
// white in one row of pixels is a line. A graded version of that pixel was tried
// here and taken out again — see `edge`.
//
// AND IN FRONT OF THE BLUR, not behind it. That is the half this file got wrong
// twice: white BEHIND a blur is not an edge once the blur has sampled it, it is
// a haze over the whole surface.

// 12 off the bottom of the safe area, and EXPORTED with the height because two
// screens have to clear this bar. A literal copied into each is a number that
// goes stale the next time the bar changes size and nobody notices until a
// footer is half behind glass.
const TAB_BAR_MARGIN_V = 12;
export const TAB_BAR_HEIGHT = BAR_H;
export const TAB_BAR_MARGIN = TAB_BAR_MARGIN_V;

const CAPSULE_R = CAPSULE_H / 2;
// One id for the one mask. Two Defs sharing an id in a single tree collide.
const EDGE_MASK_ID = 'gtbEdgeMask';

// SWIFTUI'S SPRING, CONVERTED. The reference is response 0.50s with a damping
// fraction of 0.75, which is a description of the curve rather than of the
// constants; Reanimated wants the constants. With mass 1:
//
//   stiffness = (2*pi / response)^2 * mass       = (2*pi / 0.50)^2 = 157.91
//   damping   = 2 * dampingFraction * sqrt(k*m)  = 1.5 * 12.566    =  18.85
//
// 0.50s, UP FROM 0.35, AND ONLY THE RESPONSE MOVED. The damping fraction is the
// same 0.750 it always was, so the CURVE is unchanged and only its clock is
// slower: same 2.84% overshoot, same shape, 1.43 times as long to get there.
// The pill was crossing the bar faster than the eye wanted to follow it.
//
// 2.84% overshoot; 424ms to settle to 2% and 1004ms to Reanimated's own
// termination, which is an energy ratio rather than a displacement one. Home to
// profile is two slots, 210.66pt at any screen the bar is full width on, so the
// peak is 5.98pt of travel past the target — UNCHANGED by the slowdown,
// because the overshoot is a function of the damping fraction alone and that
// did not move.
//
// THAT 5.98 IS WHY THE ENDS ARE STILL CLAMPED. The pill rests 3.00 off the glass
// at either screen size, so an unclamped overshoot of 5.98 on the edge facing
// the end would cross it by 2.98. See SPRING_PINNED.
//
// AND IT IS ONLY THE HALF OF THE STORY A SPRING RELEASED FROM REST TELLS, which
// is worth leaving on the record: spring.js:115 hands a new animation the
// previous one's velocity, so an edge below starts its spring already moving at
// whatever the press-in travel had reached. The excursion that produces is
// v0 / omega_d and has nothing to do with the 5.98 — on a hard tap it is an
// order of magnitude more. That is the other reason the ends are clamped, and
// the reason a clamp cannot be traded for a smaller unclamped overshoot.
//
// SHARED WITH TWO OTHER PATHS, and both slow with it by design: the drag
// release in onFinalize and the walk-back in settlePill. One pill travelling to
// one tab should move at one speed whichever way it was sent; that principle is
// already why a release onto an end tab behaves as a tap onto one does.
const SPRING = { damping: 18.85, stiffness: 157.91 };

// THE SAME SPRING WITH THE OVERSHOOT TAKEN OFF, for the one edge that must not
// travel past its resting place: the pill's leading edge on the first and last
// tabs, which is the edge facing the capsule's own end. Same mass, same damping,
// same stiffness, so it settles on the same curve and cannot read as a different
// material — overshootClamping only stops it crossing.
const SPRING_PINNED = { ...SPRING, overshootClamping: true };

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
// rectangle in proportion, so on a pill that is 99.33 by 56 the same number
// gives nearly twice as much width as height: the 1.08 this replaced put 3.97 on
// each side horizontally and only 2.24 vertically. Asking for an equal 10 all
// round means two different factors, and they have to be derived rather than
// written down or they go wrong the moment either dimension moves.
//
//   scaleX = (99.33 + 20) / 99.33 = 1.201349  ->  119.33 wide
//   scaleY = (56    + 20) / 56    = 1.357143  ->   76.00 tall
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
// a SCROLL FLING, and a drag inside a 316pt bar cannot run anywhere near that
// because there is nowhere to go. The instrumented gesture peaked at 983.8pt/s
// and produced 4.92pt of squash, five per cent of the pill, which is a number
// you have to be told about to see.
//
// WHAT 800 GIVES, across the range a real drag covers:
//
//   275pt/s  deliberate, tab to tab        3.44pt   3.5% of PILL_W
//   440pt/s  brisk, tab to tab             5.50pt   5.5%
//   790pt/s  brisk, across the bar         9.88pt   9.9%
//  1264pt/s  fast, across the bar         10.00pt   capped
//
// so a deliberate drag deforms visibly, a brisk one very nearly maxes out, and
// anything faster is pinned. The observed 983.8 now sits at the cap. Under the
// press expansion every figure renders 1.2013 times larger again, because the
// squash is a width and the press scales whatever width it finds.
//
// THE CAP DID NOT MOVE, and 10 is still right at the steeper slope: it takes the
// pill to 89.33, which is still plainly a pill, and the binding constraint is
// the longest label rather than taste. "my flights" is ten characters of
// JetBrains Mono at 11pt, 0.6 em each, so 66.00pt wide; at 89.33 it keeps 11.67
// either side of it, and much past 14pt of squash the word starts running into
// the 28pt corner radius. 10 leaves room and stops well short of that.
const DRAG_SQUASH_MAX = 10;
const DRAG_SQUASH_VEL = 800;

const PRESS_GROW = 10;
const PRESS_SCALE_X = (PILL_W + PRESS_GROW * 2) / PILL_W;
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
// simply below the threshold. 3 on 38.52 is a 7.8% scale — 1.56pt on the glyph
// and 1.16pt on the line box, on an object already sliding under a finger. 7 is
// 18.2%, which is a size change rather than a suspicion of one.
//
// THE GAP BETWEEN THE TWO STATES IS WIDER TOO, 2 rather than 1, so that the
// drag reading distinctly lighter than the hold survives the larger numbers.
//
// ITEM_CONTENT_H IS THE HEIGHT THAT GROWS, and it is already the sum of exactly
// those three parts — icon 20, gap 4, line box 14.52 — so the factors derive
// from it and cannot go stale if any of the three moves:
//
//   held     (38.52 + 7) / 38.52 = 1.181724  ->  45.52 tall
//            icon 23.63, gap 4.73, line box 17.16
//   dragged  (38.52 + 5) / 38.52 = 1.129803  ->  43.52 tall
//            icon 22.60, gap 4.52, line box 16.40
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
// what is being expressed and the pill is 99.33 wide wherever it stands:
//
//   full growth while the slot's centre is within PILL_W / 4     = 24.83
//   nothing at all once it is beyond    PILL_W * 0.8             = 79.46
//
// and between them a SMOOTHERSTEP, 6u^5 - 15u^4 + 10u^3, whose first AND second
// derivatives are zero at both ends. That is what keeps the joins invisible: the
// curve does not just meet the flat parts, it meets them flat.
const STACK_FULL_R = PILL_W / 4;
const STACK_ZERO_R = PILL_W * 0.8;

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

// THE TRAVEL A PRESS CAUSES, which is a different journey from the one a tap
// causes and wants a different spring. A tap's travel happens after the finger
// has gone; this one happens with the finger down and WAITING on it, and 297ms
// of waiting is the difference between a control that obeys and one that thinks
// about it first.
//
// Same conversion as the others, response 0.25s and damping fraction 0.85:
//
//   stiffness = (2*pi / 0.25)^2   = 631.65
//   damping   = 1.7 * sqrt(631.65) =  42.73
//
// 183ms to settle against SPRING's 297, and 0.63% of overshoot against its
// 2.84% — deliberately flatter as well as faster, because an overshoot the
// finger is waiting through reads as slop rather than as life.
const PRESS_TRAVEL_SPRING = { damping: 42.73, stiffness: 631.65 };
// AND BOTH EDGES TAKE IT, which is the whole of how the press-in travel avoids
// squashing. It used to be the pinned half of an asymmetric pair, matching what
// the tap does; that was wrong for this path. A press is a finger held on a
// DESTINATION and the pill is coming to meet it, so there is nothing for the
// leading edge to hit and a compression there reads as an impact that did not
// happen.
//
// IDENTICAL CONFIGS ON BOTH EDGES IS THE MECHANISM, and it is the same fact the
// middle tab already relies on: two springs with the same mass, damping and
// stiffness, released together from a start width of PILL_W to a target width of
// PILL_W, trace the same normalised curve, so the gap between them never moves.
// The width is constant for the whole journey by construction rather than by
// being animated to stay put.
//
// PINNED RATHER THAN THE PLAIN SPRING for the pair, because overshooting a
// destination the finger is already resting on is the one place overshoot has
// nothing to express. The spring itself is untouched — same damping, same
// stiffness, same 183ms — so the travel's speed and feel are exactly what the
// last round set.
const PRESS_TRAVEL_PINNED = { ...PRESS_TRAVEL_SPRING, overshootClamping: true };

// WHEN THE EXPANSION JOINS THE TRAVEL, and it OVERLAPS rather than queueing.
//
// Strictly sequential was the other option and it is worse: the travel settles
// at 183ms, so nothing would answer the finger for that whole time, and a
// control that waits 183ms before acknowledging a touch reads as broken however
// fast it moves afterwards.
//
// 120ms is about two thirds of the way through the travel. The pill is still
// closing on the tab when it starts to grow, so the journey turns into the
// expansion instead of stopping and then starting again — the growth reads as
// the momentum landing. PRESS_SPRING takes 129ms on top, so the whole gesture
// resolves around 250ms.
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
// shared across two colours. All three of these follow the focused state, so all
// three are strings.
const ICON_HOME_D = 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z';
// AN AEROPLANE SEEN FROM ABOVE: nose at the top, swept wings, tailplane, and a
// notch between the tail tips. One closed outline, stroked like the other two.
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
const ICON_PERSON_HEAD_D = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z';
const ICON_PERSON_BODY_D = 'M4.5 20.5a7.5 7.5 0 0 1 15 0';

// THE LABEL AND THE ROUTE ARE NOT THE SAME STRING, and the middle tab is why:
// it reads "My Flights" and navigates to `flights`. The file is app/flights.tsx
// and the route stays `flights`; only what a person sees changed.
//
// THE CASE IS PART OF THE LABEL AND CHANGES NOTHING ELSE. JetBrains Mono is
// monospace — every glyph in all three words, upper and lower, advances 600
// of its 1000 units per em, read out of the shipped 400Regular — and the cells
// are pinned to LABEL_ADV regardless. The widths are identical either way.
const ITEMS: { label: string; route: string; paths: string[] }[] = [
  { label: 'Home', route: 'index', paths: [ICON_HOME_D] },
  { label: 'My Flights', route: 'flights', paths: [ICON_SAVED_D] },
  { label: 'Profile', route: 'profile', paths: [ICON_PERSON_HEAD_D, ICON_PERSON_BODY_D] },
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
function waveAt(index: number, offset: number, arr: Slot[], pillC: number) {
  'worklet';
  if (index >= arr.length) return 0;
  const centre = arr[index].x + arr[index].w / 2 + offset;
  const d = Math.abs(pillC - centre);
  if (d <= STACK_FULL_R) return 1;
  if (d >= STACK_ZERO_R) return 0;
  // Smootherstep, in Horner form: 6u^5 - 15u^4 + 10u^3.
  const u = (STACK_ZERO_R - d) / (STACK_ZERO_R - STACK_FULL_R);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

// The stroke is the only icon prop that moves, and a G passes it down to every
// path inside it — so one animated node colours an icon whether it is drawn
// with one path or two, and `profile` needs two. Module scope: wrapping on each
// render would remount the node.
const AnimatedG = Reanimated.createAnimatedComponent(G);

// WHERE CHARACTER k SITS, as an offset from the centre of its slot. The label is
// centred in the item, so a word of n characters spans n * 7.2 about that centre
// and character k occupies [k * 7.2, (k + 1) * 7.2] from the word's left edge:
//
//   offset(n, k) = (k + 0.5 - n / 2) * 7.2
//
// "My Flights" is 10 characters, 72.00pt wide, so its offsets run -32.4, -25.2,
// -18.0, -10.8, -3.6, +3.6, +10.8, +18.0, +25.2, +32.4. Symmetric about the
// centre by construction, which is the check that the formula is right.
const charOffset = (n: number, k: number) => (k + 0.5 - n / 2) * LABEL_ADV;

// ONE CHARACTER OF THE WAVE, and the reason this is a COMPONENT rather than a
// row of unrolled hooks in the bar.
//
// HOOKS CANNOT BE CALLED IN A LOOP, and the labels are 4, 10 and 7 characters
// long, so there is no fixed number to unroll to. A component solves it exactly:
// hooks are per INSTANCE, so mapping over the characters creates twenty-one
// instances each calling useAnimatedStyle exactly once, unconditionally. Nothing
// is looped or branched at the hook level at all.
//
// GROWTH AND COLOUR IN ONE STYLE, ON ONE NODE. They come from the same t, and
// putting them in the same object is what keeps the character count of animated
// nodes at twenty-one rather than forty-two.
//
// THE CELL AROUND IT IS A PLAIN VIEW and it is what holds the advance. The Text
// is left content-sized inside it, so a glyph whose measured width rounds up
// past 7.2 has somewhere to go instead of being clipped by its own box.
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
};

function WaveChar({ ch, index, offset, slotsSV, capX, capR, pressAmt, dragAmt }: WaveCharProps) {
  const anim = useAnimatedStyle(() => {
    const t = waveAt(index, offset, slotsSV.value, (capX.value + capR.value) / 2);
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
};

function WaveIcon({
  paths, index, slotsSV, capX, capR, pressAmt, dragAmt,
}: WaveIconProps) {
  const boxStyle = useAnimatedStyle(() => {
    const t = waveAt(index, 0, slotsSV.value, (capX.value + capR.value) / 2);
    const peak = STACK_SCALE_PRESS + dragAmt.value * (STACK_SCALE_DRAG - STACK_SCALE_PRESS);
    return { transform: [{ scale: 1 + pressAmt.value * t * (peak - 1) }] };
  });
  const strokeProps = useAnimatedProps(() => ({
    stroke: interpolateColor(
      waveAt(index, 0, slotsSV.value, (capX.value + capR.value) / 2),
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

  // SOLVED PER SCREEN, not fixed. See BAR_INNER_W: the bar's inner width is what
  // puts a 3pt gap either side of a 99.33 pill in each of three slots, so the
  // inset is whatever is left of the window after it. Floored so the bar can
  // never be wider than the screen.
  const dockInset = Math.max(DOCK_INSET_MIN, (windowW - BAR_INNER_W) / 2);

  // WHAT THE BAR IS ACTUALLY WIDE, from the same two numbers the dock lays it
  // out with: the dock spans the window and pads by dockInset a side, and the
  // shell is alignItems stretch inside it. This is the value shellBox reports a
  // frame later, computed here instead because the scale must be right on the
  // first frame of a press rather than one after it.
  const barW = windowW - dockInset * 2;
  const barScaleX = (barW + BAR_GROW * 2) / barW;

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
  // -1 while the focused screen is one this bar does not list, which is what
  // _sitemap and +not-found are. Nothing is highlighted then, rather than the
  // capsule parking under the wrong word.
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
  // IT OVERHANGS, AND IT IS ALLOWED TO. 10pt on every side against a 3pt resting
  // gap puts the pill 7pt past the bar's inner edge on the first and last
  // tabs, and 7pt above and below the bar — CAPSULE_TOP is 3.
  //
  // THE BAR NOW COMES OUT TO MEET IT, which takes the edge off that figure
  // without capping anything: the surface grows 3 on the same trigger, so the
  // pill ends up 4 past the grown bar rather than 7 past a still one. Everything
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

  // THE SHELL'S OWN BOX, measured, because the border is an SVG stroke again and
  // a Rect needs pixel dimensions: SVG has no way to say "100% minus one point",
  // and a stroke centred on a rect at the exact bounds would put half of itself
  // outside them. Compare before setting, so a layout pass reporting the same
  // numbers does not re-render.
  const [shellBox, setShellBox] = useState<{ w: number; h: number } | null>(null);
  const onShellLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setShellBox((prev) => (prev !== null && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  };

  // THE DEFERRED RELEASE. onPressOut no longer collapses the pill itself; it
  // asks for a collapse in PRESS_RELEASE_DELAY, and anything that means the
  // gesture is still alive takes that request back.
  const pressOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const schedulePressRelease = () => {
    cancelPressRelease();
    pressOutTimer.current = setTimeout(releasePress, PRESS_RELEASE_DELAY);
  };

  // A timer that outlives the component would call withSpring on a value whose
  // component has gone.
  useEffect(() => () => {
    if (pressOutTimer.current !== null) clearTimeout(pressOutTimer.current);
  }, []);
  // The fallback pill's frost, faded rather than swapped. See capsuleInner.
  const frostOpacity = useSharedValue(1);

  // THE GLASS PATH NEEDS THIS IN RENDER, not on the UI thread: glassEffectStyle
  // is a prop, so swapping it is a re-render rather than an animated value.
  // Two renders a gesture, which is why it is separate from `dragging` rather
  // than replacing it.
  const [dragActive, setDragActive] = useState(false);

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

  // THE PILL IS NOT THE SLOT ANY MORE. It is PILL_W wide wherever it stands, and
  // this places it by centring that fixed width in whichever slot is active.
  //
  // WHY IT STOPPED BEING DERIVED. While the width came from the slot, every
  // change to the bar's inset or to TRACK_PAD resized the pill as a side effect
  // — the two could not be tuned independently. Fixing the width broke that
  // coupling, which is what let TRACK_PAD go to 0 without the pill growing.
  //
  // THE CENTRING IS NOT A NO-OP, and no longer could be: the slot is 105.33
  // against a 99.33 pill, so slot.x + slot.w/2 - PILL_W/2 puts 3.00 either side.
  // That difference IS the gap at the ends of the bar, and it is END_GAP.
  useEffect(() => {
    if (activeIndex < 0) return;
    const slot = slots[activeIndex];
    if (!slot) return;
    // CENTRED IN THE SLOT, which is the one thing the measurement is still for.
    // The width is PILL_W and does not come from here; the slot only says where.
    //
    // The scan for a complete set of slots has gone with the Math.max it fed:
    // placing the pill needs the ACTIVE slot and nothing else, and the guard
    // above already establishes that one. The gesture's own copy of all three is
    // still assembled by the effect above this, untouched.
    const target = slot.x + slot.w / 2 - PILL_W / 2;
    const restR = target + PILL_W;

    if (dragging.value) return;          // the finger has it; see `dragging`
    if (capOpacity.value === 0) {
      // THE FIRST MEASUREMENT LANDS, IT DOES NOT TRAVEL. Both edges start at 0,
      // so springing to the first target would drag the pill in from the track's
      // left edge on launch. It is placed silently and then faded up instead.
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
      // pill travels and stops. This is what the middle tab always did.
      //
      // THE ENDS TAKE THE CLAMPED ONE, THE MIDDLE TAKES THE PLAIN ONE, and that
      // is not the old asymmetry in another form — it is per TAB, not per EDGE.
      // Both edges of any given arrival agree, which is the whole point.
      //
      // WHY THE ENDS CANNOT SIMPLY TAKE SPRING. An unclamped edge overshoots
      // 5.98pt on a two-slot travel against a 3.00pt END_GAP, so BOTH edges
      // would cross the bar's end by 2.98 on the way in — the width would stay
      // honest and the pill would leave the bar. Worse, the effect inherits the
      // press-in travel's velocity, which on a hard tap makes that excursion an
      // order of magnitude larger. The clamp is load-bearing at both speeds.
      //
      // THE MIDDLE KEEPS ITS OVERSHOOT because it has room for it: its resting
      // place is a full slot from either end, so 5.98pt of travel past the
      // target lands in air. Both edges take it, so the width is constant there
      // too.
      const end = activeIndex === 0 || activeIndex === ITEMS.length - 1;
      capX.value = withSpring(target, end ? SPRING_PINNED : SPRING);
      capR.value = withSpring(restR, end ? SPRING_PINNED : SPRING);
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
    // 99.33 side and 7pt on a 56 side are not the same proportion. The order is
    // what makes the two compose: the translate places the box, the scales
    // enlarge whatever box that is. See PRESS_GROW.
    transform: [
      { translateX: capX.value },
      { scaleX: 1 + pressAmt.value * (PRESS_SCALE_X - 1) },
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
    const sx = 1 + pressAmt.value * (PRESS_SCALE_X - 1);
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
  // serving the three icons and the twenty-one characters alike; what is left
  // here is the wiring.
  //
  // WHY IT FOLLOWS THE PILL RATHER THAN THE ROUTE: activeIndex is React state
  // that updates a render behind the finger, while capX and capR are where the
  // pill actually is this frame. The same two values the border mask reads,
  // asked a different question.

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
  // `press` SEPARATES THE TWO JOURNEYS, and it is an exact discriminator rather
  // than a heuristic: settlePill has exactly two call sites, and the only one
  // that passes true is onPressIn's travel. Everything else that moves the pill
  // does so somewhere else entirely — the placement effect for a tap, the pan's
  // onFinalize for a drag release — and neither goes through here at all. So
  // suppressing the squash on this flag cannot reach either of them.
  //
  // WHAT THE FLAG DECIDES IS WHICH SPRING, and that is now all it decides. It
  // used to pick whether the two edges disagreed as well, because the squash WAS
  // that disagreement; neither branch disagrees any more, so both arrive at
  // full width and the flag is back to choosing a speed. See
  // PRESS_TRAVEL_PINNED for why the press branch is the faster one.
  const settlePill = (i: number, press: boolean) => {
    if (dragging.value) return;      // the finger owns it; see `dragging`
    const slot = slots[i];
    if (!slot) return;
    const target = slot.x + slot.w / 2 - PILL_W / 2;
    if (press) {
      // NO ASYMMETRY, SO NO SQUASH. Same config on both edges, and no end-tab
      // special case: the pill arrives at its full width on every tab, first and
      // last included.
      capX.value = withSpring(target, PRESS_TRAVEL_PINNED);
      capR.value = withSpring(target + PILL_W, PRESS_TRAVEL_PINNED);
      return;
    }
    // THE WALK-BACK, and it arrives exactly as a tap does because that is what
    // it is: the press was refused, so the pill is returning to the tab that is
    // actually active by the ordinary route. Same springs the effect uses, and
    // now the same shape of branch — per TAB, both edges agreeing, so the
    // width is constant through the settle and nothing deforms.
    //
    // IT SAID "SQUASHES EXACTLY AS A TAP DOES" and that was true when it was
    // written and false the moment the tap stopped squashing. The claim was
    // always the right one; it is the behaviour that moved, and this is it
    // moving with it. All three arrival paths now say the same thing.
    const end = i === 0 || i === ITEMS.length - 1;
    capX.value = withSpring(target, end ? SPRING_PINNED : SPRING);
    capR.value = withSpring(target + PILL_W, end ? SPRING_PINNED : SPRING);
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
    const w = PILL_W;
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
  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .onStart((e) => {
      'worklet';
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
      trackFinger(e.x, e.velocityX);
    })
    .onUpdate((e) => {
      'worklet';
      trackFinger(e.x, e.velocityX);
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
      // Only if a drag actually happened, for the rest: a tap that never
      // activated the pan still finalizes here, and springing the position then
      // would move the pill from a stale index on every tap. onFinalize rather
      // than onEnd because it also runs when the gesture is cancelled, and a
      // cancelled drag must not leave the pill parked under the finger's last
      // position.
      if (!dragging.value) return;
      dragging.value = false;
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
        // unclamped edge overshoots 5.98pt against a 3.00pt END_GAP, so both
        // edges would carry the pill 2.98 past the bar's end together. The
        // middle keeps the plain spring and its overshoot, which lands in air.
        //
        // THE DRAG'S OWN SQUASH IS NOT THIS and is untouched: that one lives in
        // trackFinger, is driven by the finger's velocity, and ends when the
        // finger lifts. This is only what happens after it has.
        const restL = arr[i].x + arr[i].w / 2 - PILL_W / 2;
        const end = i === 0 || i === arr.length - 1;
        capX.value = withSpring(restL, end ? SPRING_PINNED : SPRING);
        capR.value = withSpring(restL + PILL_W, end ? SPRING_PINNED : SPRING);
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

  // IDENTICAL ON BOTH PATHS, which is what keeps the drag honest: the same row,
  // the same track, the same onLayout, the same GestureDetector. Only the
  // surface behind them changes.
  const content = (
    <View style={st.row}>
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
                onLayout={onSlotLayout(i)}
                onPress={() => {
                  // THE ANTICIPATION HAS TO BE PAID FOR. onPressIn moved the pill
                  // to this tab before knowing the navigation would be allowed,
                  // so if it was not, the pill is now sitting on a tab that is
                  // not active and something must walk it back. Nothing in this
                  // app prevents a tabPress today, which is exactly why it is
                  // handled here rather than left as an assumption.
                  const landed = enter(i);
                  if (!landed && i !== activeIndex) settlePill(activeIndex, false);
                }}
                onPressIn={() => {
                  // A stale request from the previous gesture must not collapse
                  // this one: a fast re-press can land inside the window.
                  cancelPressRelease();
                  // THE PILL GOES TO THE FINGER BEFORE IT GROWS, and this is the
                  // whole of the change. It used to expand wherever it happened
                  // to be standing and only travel on release, which put the
                  // acknowledgement on the wrong tab: you pressed home and
                  // profile lit up.
                  //
                  // THE SAME TAB IS THE UNTOUCHED CASE. There is nowhere to
                  // travel to, so it expands in place with no delay on the
                  // growth — byte for byte what it did before.
                  if (i === activeIndex) {
                    pressAmt.value = withSpring(1, PRESS_SPRING);
                    return;
                  }
                  // ANOTHER TAB: travel first, growth joins it at the tail. The
                  // navigation still does NOT happen here — it happens on
                  // release, in onPress, exactly as before. This moves the
                  // highlight in anticipation and nothing else, so a press that
                  // is dragged away or cancelled has changed no route.
                  settlePill(i, true);
                  pressAmt.value = withDelay(PRESS_TRAVEL_LEAD, withSpring(1, PRESS_SPRING));
                }}
                onPressOut={() => {
                  // NO dragging GUARD HERE. It was measured to be false at
                  // this point, whether or not a drag is about to begin, so it
                  // could only ever release. See PRESS_RELEASE_DELAY.
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
                <View style={st.stack}>
                  <WaveIcon
                    paths={item.paths}
                    index={i}
                    slotsSV={slotsSV}
                    capX={capX}
                    capR={capR}
                    pressAmt={pressAmt}
                    dragAmt={dragAmt}
                  />
                  {/* THE WORD, ONE CHARACTER PER CELL. Each cell is pinned to
                      LABEL_ADV rather than measured, which is what makes the
                      split free: the row is exactly n * 7.2 wide, the same
                      figure the shaped run produced, so no rounding can
                      accumulate across ten separate measurements and the space
                      in "My Flights" occupies its advance whatever the text
                      engine would have done with a whitespace-only Text.
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
                      />
                    ))}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      </GestureDetector>
    </View>
  );

  return (
    <View
      style={[st.dock, { bottom: insets.bottom + TAB_BAR_MARGIN_V, paddingHorizontal: dockInset }]}
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
          <GlassView glassEffectStyle="regular" style={st.glassPill}>
            {capsuleNode}
            {content}
          </GlassView>
        </GlassContainer>
      ) : (
        // THE SHEETS' OWN ORDER, and no more than it: GlassLayers then the
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
        <View style={st.shell} onLayout={onShellLayout}>
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
            <View style={st.clip}>
              <GlassLayers />
            </View>
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
            {shellBox !== null && (
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
          {capsuleNode}
          {content}
        </View>
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
  // flex: 1, SO THE THREE SLOTS ARE IDENTICAL and the pill is one shape wherever
  // it stands. The word no longer sets the width; the track divided by three
  // does.
  //
  // AND THE HORIZONTAL PADDING IS GONE WITH IT. Its only job was to give a
  // content-sized item its width, and flex owns that now. Keeping it would have
  // been a 32pt inset on the label for no reason and one real cost: it caps the
  // text at slot - 32, which is 74.33 on a 375pt screen but only 56.00 on a 320,
  // where "my flights" at 66.00 would then truncate. Without it the label has
  // the whole slot and clears even there. The touch target does not shrink —
  // the Pressable IS the slot now, which is wider than the padded box ever was.
  //
  // alignItems centre still stacks the icon over the word and centres both in
  // the slot; paddingVertical still sets the item's height. See ITEM_PAD_V.
  item: { flex: 1, paddingVertical: ITEM_PAD_V, alignItems: 'center' },
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
