// THE SWIPE, AND EVERY PIECE IT IS MADE OF.
//
// Every line of this was app/index.tsx's and every line is unchanged. It moved
// because two things wear this gesture and only one of them is the home screen:
// a watchlist row and the flight card open the same panels, with the same
// buttons, the same fills, the same threshold, the same haptic and the same
// exit. The card is going to a screen of its own, and a second copy of any of it
// is how the two would come to feel different.
//
// WHAT IS HERE: the button, the expanding box, the drag mirror, the geometry and
// the spring they share, the fills and inks, the glyphs, and the two timings a
// committed swipe animates on. WHAT IS NOT: the panels themselves. swipeGroup
// and cardSwipeGroup stay with the callers, because what goes IN a panel is the
// caller's decision and always was.
//
// THE ONLY EDIT MADE IN THE MOVE is `export` in front of the nineteen names the
// call sites still read, and the stylesheet at the bottom, which is the nine
// swipe entries lifted out of index's own `sf` into a local one of the same name
// so that SwipeAction and ExpandAction are character-for-character what they
// were.
import { TouchableOpacity, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import Svg, { Path, Circle } from 'react-native-svg';
// The same aliasing index.tsx uses: this file's animations are Reanimated's
// alone, and REasing is Reanimated's Easing rather than React Native's. The two
// are not interchangeable — see the note at EXIT_TIMING.
import Reanimated, {
  useAnimatedStyle, useAnimatedReaction, useDerivedValue,
  interpolate, runOnJS, Extrapolation, type SharedValue,
  Easing as REasing,
} from 'react-native-reanimated';

const SWIPE_SIZE = 52;
const SWIPE_MARGIN = 6;
export const SWIPE_W = SWIPE_SIZE + SWIPE_MARGIN * 2;
// 18 on a 52pt square, which is now a fixed relationship rather than one that
// depended on the row. Short of 26, which would be a circle: a circle reads as
// a floating badge, and these are buttons in a row.
const SWIPE_RADIUS = 18;

// One button: a filled rounded rectangle with a glyph on it, and nothing else.
//
// THE LABEL IS GONE. It was 11pt of SANS under the icon, and it was doing two
// things badly: forcing the button wide enough to fit the longest word in the
// set, and putting a second element in a shape too small to hold two things
// comfortably. The icons are the same five the rest of the app already uses for
// these actions, and the gesture that reveals them is itself the explanation.
//
// `label` survives as the accessibility name, which is where the word was
// always doing its real work — a screen reader has no icon to look at.
//
// `colour` has gone with the text. The glyph strokes take their colour from
// ICON_* at module scope, which is where the fill and its ink are paired.
//
// `grow` is set only by ExpandAction, and switches the button from its fixed
// square to filling whatever width the expanding box has reached.
//
// `progress` is the library's own shared value for this panel: 0 closed, 1 open,
// and it is driven by the finger during the drag and by the release spring
// after it. Reading it here is what makes the contents arrive WITH the panel
// rather than sitting fully formed inside a widening window.
//
// Opacity leads the scale, on a bent curve: nothing for the first fifth of the
// travel, then up to full by the time the panel is open. A button that fades in
// from the very first pixel reads as a smear at the edge of the row; one that
// waits until the panel is unmistakably being opened reads as a reveal.
//
// The scale was removed for one round as a probe. The theory was that animating
// a transform over react-native-svg forces a per-frame re-composite and was
// what made the drag feel rough. Taking it out changed nothing, so the theory
// was wrong and the scale is back exactly as it was. Recorded here so nobody
// removes it again for the same reason.

// THE LIBRARY'S DRAG, COPIED ONTO A VALUE THE ROW OWNS.
//
// ReanimatedSwipeable hands appliedTranslation to renderLeftActions and
// renderRightActions and nowhere else, so a style built outside those callbacks
// — childrenContainerStyle, which is the layer that has to go opaque — cannot
// read it. This is rendered inside the right panel, where the value is in hand,
// and copies it out. It draws nothing.
//
// IT LANDS ONE FRAME LATE, and that is not fixable here. useAnimatedReaction
// calls startMapper with no `outputs`, so the mapper registry cannot know this
// writes `to` and cannot sort it ahead of the style that reads it; and a mapper
// that writes during the run phase makes the registry reschedule with
// requestAnimationFrame rather than queueMicrotask. Both are in mappers.js.
//
// THE PANEL'S OWN RAMP IS WHAT COVERS THAT FRAME. See SwipeAction's `fade`.
export function DragMirror({ from, to }: { from: SharedValue<number>; to: SharedValue<number> }) {
  useAnimatedReaction(() => from.value, (v) => { to.value = v; });
  return null;
}

export function SwipeAction({
  label, fill, progress, grow: growSide, onPress, children,
}: {
  label: string; fill: string; progress: SharedValue<number>;
  grow?: 'left' | 'right';
  onPress: () => void; children: React.ReactNode;
}) {
  // THE RAMP, AND IT NOW CARRIES THE FILL AS WELL AS THE GLYPH.
  //
  // It used to sit on the inner view alone, so the button's coloured background
  // appeared at full strength the instant a drag began while the icon on it was
  // still at zero — a bare red or grey slab for several frames, which was
  // never intended and reads as a flash.
  //
  // IT IS ALSO WHAT MAKES DragMirror's LATE FRAME INVISIBLE. The dead zone runs
  // to progress 0.2, and progress is translation / panel width. The pan
  // activates at 10pt of finger, so the first frame of any drag is
  // 10 / 1.15 = 8.7pt of travel; against the NARROWEST panel here, a single
  // 64pt button, that is 0.136 — inside the dead zone, so the fill is still at
  // zero on the one frame the row behind it has not yet gone opaque. On a
  // two-button panel it is 0.068. There is nothing to see through the row.
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.2, 1], [0, 0, 1], Extrapolation.CLAMP),
  }));
  const grow = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.72, 1], Extrapolation.CLAMP) },
    ],
  }));
  return (
    <TouchableOpacity
      style={[
        sf.swipeBtn,
        growSide === undefined
          ? sf.swipeBtnFixed
          : growSide === 'right' ? sf.swipeBtnGrowRight : sf.swipeBtnGrowLeft,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {/* THE FILL IS ITS OWN LAYER NOW, not the button's background, because it
          has to fade and the touchable's own style cannot. Behind the glyph and
          out of the touch path; the touchable still hit-tests without it. */}
      <Reanimated.View
        style={[sf.swipeFill, { backgroundColor: fill }, fade]}
        pointerEvents="none"
      />
      <Reanimated.View style={[sf.swipeInner, fade, grow]}>
        <Svg width={20} height={20} viewBox="0 0 24 24">{children}</Svg>
      </Reanimated.View>
    </TouchableOpacity>
  );
}

// A SETTLE RATHER THAN A SNAP, replacing the library's release spring.
//
// Its default is mass 2, damping 1000, stiffness 700 — a damping ratio of about
// 13, which is so far overdamped that the row does not spring at all, it
// decelerates. This is mass 0.8, damping 26, stiffness 240, a ratio of 0.94:
// just inside critical, so it arrives quickly, slows into position and stops
// without ever crossing it. overshootClamping stays on as the guarantee.
// FULL-SWIPE EXPANSION, and none of it comes from the library.
//
// ReanimatedSwipeable has no expansion of any kind. Its leftThreshold and
// rightThreshold sound like this and are not: they only decide whether letting
// go OPENS the panel or lets it shut, and default to half the panel's width.
// What it does give is everything needed to build it — renderRightActions is
// handed (progress, translation, swipeableMethods), where translation is the
// row's live offset in points, and onSwipeableWillOpen fires on release.
//
// So: watch translation, expand past a threshold, and intercept the release.
//
// 0.5 OF THE ROW WIDTH. Proportional rather than absolute so it holds on any
// screen, and a half because that is where the gesture stops being ambiguous:
// the panel itself is 128pt of a 320pt row, so the threshold sits a clear 32pt
// beyond a fully open panel — far enough that nobody reaches it while merely
// opening the actions, close enough to reach without a second stroke.
const EXPAND_AT = 0.5;


// THE TAP AT THE THRESHOLD, in both directions.
//
// Medium, and the same in both. It is one boundary, so arming and disarming
// should feel identical — a different weight on the way back would read as two
// different events rather than one line being crossed twice. Light is the
// obvious alternative and is the right choice on iOS, but it is close to
// imperceptible on a good deal of Android hardware, and a threshold you cannot
// feel is a threshold that is not there.
//
// Fired and forgotten: impactAsync returns a promise nobody waits on, and a
// device without a taptic engine simply does nothing. The catch is there
// because an unhandled rejection would be a crash over a vibration.
export const EXPAND_HAPTIC = () => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
};

// The outermost action, and the only one that can expand.
//
// It is always the outermost by construction rather than by choice: expansion
// belongs to whatever sits against the screen edge, and in both panels that is
// the real action, never a placeholder. Right panel: delete. Left panel:
// archive on the saved list, restore in the archive.
//
// `side` says which edge to stay pinned to as the box grows, so the glyph
// travels with the row's leading edge instead of drifting to the middle of an
// expanding rectangle.
//
// `others` is the total width of the buttons BESIDE this one in the same panel:
// 64 where a placeholder shares the panel, 0 where this is the only action. It
// is what stops the expansion starting before the panel is even open — see the
// width calculation below.
export function ExpandAction({
  side, translation, rowW, others, onCross, children,
}: {
  side: 'left' | 'right';
  translation: SharedValue<number>;
  rowW: SharedValue<number>;
  others: number;
  onCross: (on: boolean) => void;
  children: React.ReactNode;
}) {
  // 1 past the threshold, 0 short of it. A derived value rather than state, so
  // the whole comparison stays on the UI thread with the gesture.
  const armed = useDerivedValue(() => {
    const travelled = side === 'right' ? -translation.value : translation.value;
    return rowW.value > 0 && travelled >= rowW.value * EXPAND_AT ? 1 : 0;
  });

  // THE BOX TRACKS WHAT IS REVEALED, and this is the fix for the expanded
  // button running flush against the card.
  //
  // It used to animate to rowW — the whole row's width — the moment the
  // threshold was crossed. But the row has only translated as far as the finger
  // took it, so a box that wide ran on underneath the card: the button's inner
  // edge, its margin and its two right-hand corners were all hidden behind the
  // row, and what was left looked like a rectangle butted against it.
  //
  // The width is now exactly the strip the row has uncovered, less whatever the
  // other buttons in the panel occupy. So the box always ends where the card
  // begins, the button's own 6pt margin holds the gap open, and all four
  // corners stay on screen at every point in the drag. It is a symmetrical
  // rounded rectangle that grows, rather than a shape that is progressively
  // eaten by the row.
  //
  // No withTiming: the width follows the finger directly. There is nothing to
  // ease, because the thing it tracks is already exactly where the finger is,
  // and on release the row's own spring carries the width home with it.
  //
  // The consequence worth naming: the button no longer JUMPS to full width when
  // the threshold is crossed, it simply keeps growing. Nothing visual marks the
  // crossing any more — the haptic does, and it is the same boundary it always
  // was. Keeping the jump would mean filling the row, and filling the row is
  // what leaves no gap.
  const box = useAnimatedStyle(() => {
    const travelled = side === 'right' ? -translation.value : translation.value;
    return { width: Math.max(SWIPE_W, travelled - others) };
  });
  // The only crossing to the JS thread in the whole gesture, and it fires twice
  // per swipe at most: once on arming, once on disarming.
  useAnimatedReaction(
    () => armed.value,
    (curr, prev) => {
      if (prev !== null && curr !== prev) runOnJS(onCross)(curr === 1);
    },
  );

  return (
    <Reanimated.View
      style={[sf.swipeExpand, side === 'right' ? sf.swipeExpandRight : sf.swipeExpandLeft, box]}
    >
      {/* No separate tint layer any more. The button inside is itself a filled
          shape, so growing this box grows the fill — there is nothing left to
          fade in behind it. */}
      {children}
    </Reanimated.View>
  );
}

// THE COMMIT: past the threshold the row carries on and leaves.
//
// 240ms and a full screen width, unchanged. The EASING is what changed, and it
// was the whole of why this felt laggy.
//
// It was EASE_IN — bezier(0.4, 0, 1, 1) — on the reasoning that the row is
// already moving and should not appear to stop first. The reasoning was right
// and the curve was the exact opposite of it, because the exit does not act
// alone: the library's own spring is simultaneously pulling the row BACK from
// wherever the finger left it to the panel's 128pt, and that spring is fastest
// at the start. Released at about 200pt, that is 72pt of retreat, and against an
// ease-in the first frames are a stalemate:
//
//   t=33ms   spring back 8.3pt   exit forward 10.7pt   NET  2.4pt
//   t=50ms   spring back 15.9    exit forward 22.8     NET  6.9
//   t=83ms   spring back 31.4    exit forward 55.7     NET 24.3
//
// Two and a half points in the first two frames is not slow, it is stationary.
// The row appears to hang at the release point and then leave, which is exactly
// what "laggy" describes — and no amount of moving the animation between
// threads would have touched it, because nothing was late. It was cancelled.
//
// out-cubic instead, which is fastest where the spring is:
//
//   t=33ms   spring back 8.3pt   exit forward 114.7pt  NET 106.4pt
//
// The row is a third of the way off the screen before the spring has taken back
// nine points. It leaves the instant it is let go.
const EXIT_MS = 240;
// Reanimated's Easing, not React Native's. The two are not interchangeable: a
// withTiming curve is evaluated on the UI thread and has to be a worklet, and
// the file's EASE_IN and EASE_OUT are ordinary JS functions belonging to the
// other animation system.
export const EXIT_TIMING = { duration: EXIT_MS, easing: REasing.out(REasing.cubic) } as const;
export const EXIT_BACK_TIMING = { duration: EXIT_MS, easing: REasing.out(REasing.cubic) } as const;

export const SWIPE_SPRING = {
  mass: 0.8,
  damping: 26,
  stiffness: 240,
  overshootClamping: true,
} as const;

// FILLS, and the ink that sits on them. Every value is an opacity of a ramp
// already in the file.
//
// The red at 0.7 rather than the 0.55 the strokes used. Over the page it
// composites to rgb(175,81,81), which is solid enough to read as a
// painted button while staying inside this app's muted register — a fully
// opaque 248,113,113 would be the brightest thing on any screen it appears on.
//
// CONTRAST, since the ink now sits on a fill rather than on black. White on
// that red is 5.1:1, which carries an 11pt label comfortably. Going the
// other way is worth knowing: raising the red towards opaque makes it LIGHTER
// over a black page and the white on it worse — 0.9 would drop to 3.3:1.
//
// The grey at 0.12 composites to rgb(32), twenty-seven levels above the
// page, which is enough to read as a shape without competing with the row. The
// ink on it is #e2e2e2, the file's existing near-white, at 12.6:1.
export const SWIPE_FILL_RED = 'rgba(248,113,113,0.7)';
export const SWIPE_FILL_DIM = 'rgba(226,226,226,0.12)';
const SWIPE_INK_RED = '#ffffff';
export const SWIPE_INK_DIM = '#e2e2e2';

// THE GLYPHS, as module constants rather than JSX rebuilt inside the row.
//
// Twelve Path elements across the four buttons, every one of them static, and
// every one of them was allocated afresh on each render of each row. Built once
// here they are the same objects for the life of the process, which also lets
// React bail out of reconciling them.
// The bookmark, as path data rather than a finished element: the card header's
// copy of it is gone and the swipe button that replaces it needs the SHAPE with
// its own colours, which change with the save state. Every other glyph here is a
// finished element because none of them varies.
export const BOOKMARK_D = 'M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z';

export const ICON_NOTIFY = (
  <>
    <Path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinejoin="round" />
    <Path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
export const ICON_DELETE = (
  <>
    <Path d="M19 5 5 19" fill="none" stroke={SWIPE_INK_RED} strokeWidth={1.75} strokeLinecap="round" />
    <Path d="M5 5 19 19" fill="none" stroke={SWIPE_INK_RED} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
export const ICON_RESTORE = (
  <>
    <Path d="M12 19V7" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
    <Path d="M6 13l6-6 6 6" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
  </>
);
export const ICON_ARCHIVE = (
  <>
    <Path d="M3 5h18v4H3z" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M5 9v10h14V9" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M10 13h4" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" />
  </>
);
export const ICON_REMIND = (
  <>
    <Path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} />
    <Path d="M12 7v5l3 2" fill="none" stroke={SWIPE_INK_DIM} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
  </>
);

// THE MAP'S OWN MARK, RESTATED AT BUTTON SIZE, and it is deliberately not a
// folded-paper map or a globe. The pin on the globe is a translucent halo with a
// solid dot in it and the home button on the search screen already restates that
// as a stroked ring around a dot; this is the third statement of the same idea,
// at the same geometry, so a control that puts something ON the map and the mark
// that appears THERE read as one thing.
//
// TWO FINISHED ELEMENTS RATHER THAN PATH DATA. The bookmark exports its `d`
// because the call site computes its two colours from the save state; this glyph
// has exactly two states and no third, so naming them here costs less than
// threading a pair of colours through every call.
//
// GREEN FOR ON, and it is AIRPORT_INK's green -- the same value the bookmark
// uses for a saved flight and the map uses for everything live. On the map means
// drawn, and drawn on this map means green.
const mapPin = (ink: string) => (
  <>
    <Circle cx={12} cy={12} r={7.5} fill="none" stroke={ink} strokeWidth={1.75} />
    <Circle cx={12} cy={12} r={3.2} fill={ink} />
  </>
);
export const ICON_MAP = mapPin(SWIPE_INK_DIM);
export const ICON_MAP_ON = mapPin('#4ade80');

// PLACEHOLDERS. They render, they are tappable, and they deliberately do
// nothing: there is no notification scheduling in this app yet and no reminder
// store. They are here so the gesture's shape is settled before the features
// land. Do not wire either to a toast or an alert to make them feel finished —
// silence is the honest response until they do something.
//
// At module scope so it is one function rather than one per row per render.
export const notImplemented = () => {};

// THE REFRESH GLYPH, lifted verbatim out of the card's header button when that
// button became a swipe action. Same two paths, same geometry.
//
// IT NO LONGER DIMS ITSELF WHILE LOADING. In the header it took a paler stroke
// from `loading` and the button carried disabled={loading}; a swipe panel closes
// on press and there is nothing left on screen to grey out, so the state has
// nowhere to show. SWIPE_INK is what every other action glyph uses.
export const ICON_REFRESH = (
  <>
    <Path
      d="M21 12a9 9 0 1 1-3.5-7.1"
      fill="none"
      stroke={SWIPE_INK_DIM}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M21 3v6h-6"
      fill="none"
      stroke={SWIPE_INK_DIM}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
);

// SwipeAction and ExpandAction read these as `sf.*`, exactly as they did when
// `sf` was index.tsx's own stylesheet. The name is kept so neither component's
// body had to change to move. The panels those two sit in — swipeGroup and
// cardSwipeGroup — stayed behind with the call sites that build them.
const sf = StyleSheet.create({
  // The growing box. alignItems centre for the same reason swipeGroup uses it:
  // the button has a height and should keep it. justifyContent holds the button
  // against the edge the row is being dragged away from.
  swipeExpand: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  swipeExpandRight: { justifyContent: 'flex-end' },
  swipeExpandLeft: { justifyContent: 'flex-start' },

  // THE BUTTON, and its height is its own rather than the row's. See SWIPE_SIZE.
  swipeBtn: {
    height: SWIPE_SIZE,
    marginHorizontal: SWIPE_MARGIN,
    borderRadius: SWIPE_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeBtnFixed: { width: SWIPE_SIZE },
  // Expanding. flex rather than a width, so the fill follows the animated box
  // around it.
  //
  // AND NOTHING ELSE. These used to carry alignItems: 'flex-end' with a padding
  // that held the glyph against the outer edge however wide the button became.
  // Dropping both leaves swipeBtn's own alignItems: 'center' in force, which is
  // the whole of this change: a centred glyph in a box that is widening IS a
  // glyph travelling to the centre.
  //
  // Nothing new is animated to do it. The only animated value in this component
  // is the box's width in ExpandAction's useAnimatedStyle, which Reanimated
  // evaluates on the UI thread; the glyph's position is Yoga laying that width
  // out in the same pass, on the same thread, in the same frame. There is no
  // second animation to fall behind the first, and no runOnJS anywhere in the
  // path — the only JS crossing in the gesture remains the threshold's onCross.
  //
  // At rest the two agree exactly: the button is a 52pt square and the glyph is
  // 20pt, so centred and edge-pinned are the same 16pt of clearance. The travel
  // starts from zero rather than from a jump.
  //
  // The right and left variants are now identical and kept apart anyway, since
  // ExpandAction still chooses between them by side and a future difference
  // belongs here rather than in a new pair.
  swipeBtnGrowRight: { flex: 1 },
  swipeBtnGrowLeft: { flex: 1 },
  // THE PAINTED HALF. Carries the radius itself, because it is the layer that
  // paints now: the touchable behind it is a transparent touch target and its
  // own borderRadius has nothing left to clip.
  swipeFill: { ...StyleSheet.absoluteFillObject, borderRadius: SWIPE_RADIUS },
  // The scaling half of the button. Kept separate from swipeBtn so the touch
  // target stays a fixed 64pt however small the contents are drawn.
  swipeInner: { alignItems: 'center', justifyContent: 'center' },
});
