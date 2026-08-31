// THE TWO BANNERS, AND THEY BELONG TO THE APP RATHER THAN TO A SCREEN.
//
// Every line of this was app/index.tsx's and every line is unchanged. It moved
// because the SEARCH screen raises most of them now: saving or unsaving from a
// card, bookmarking a route row, a card that refreshed, and every undo. A banner
// drawn on home reports nothing while the user is looking at a search result, so
// the one thing these had to stop being is one screen's.
//
// MOUNTED IN app/_layout.tsx, INSIDE SavedProvider, because undo has to reach
// the store: the banner is the offer, and undoUnsave is what takes it.
//
// THEY RENDER AFTER `children`, WHICH IS THE ONE EDIT THE MOVE FORCED. On the
// home screen the toast stood BEFORE the page and the undo banner after it —
// the page was transparent, so the toast showed through. Here `children` is the
// navigator, and its sceneStyle is an opaque #050505; a banner painted under
// that is a banner nobody sees. Both now paint over it. The toast still takes no
// touches, so being on top costs it nothing, and the undo banner was already
// last for exactly this reason.
import {
  createContext, useContext, useState, useEffect, useRef, useMemo, type ReactNode,
} from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  useAnimatedStyle, useSharedValue,
  withTiming, withSequence, withDelay, Easing as REasing,
} from 'react-native-reanimated';
import { useSaved } from './saved';
import { GlassLayers, g } from './glass';
import { CARD_PAD } from './cards';

// Declared here rather than imported from a screen, exactly as every other
// module in lib/ and components/ declares its own. The values are the family
// names _layout registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

// THE CONFIRMATION, and it REPLACES the toast rather than joining it.
//
// There was already one: an Animated.Text inside the flight card's header,
// 11pt SANS, opacity only, saying "saved" or "unsaved". Its problem was where
// it lived — inside the card block, which is not on screen when the saved list
// is, and not on screen at all behind the archive sheet. A swipe on a row could
// never have shown it. So the same showToast, the same call sites, the same one
// mechanism, moved to the root and given a surface.
//
// 220 in, 1700 held, 260 out: about 2.2 seconds end to end, which is long
// enough to read a flight number and a verb without becoming something waited
// on. The old one held 900 and had four characters to carry.
// The three steps run as ONE Reanimated sequence rather than an
// Animated.sequence, and that is the fix rather than the driver.
//
// Both steps of the old one were useNativeDriver: true, so each ran on the UI
// thread — but AnimatedImplementation's sequenceImpl chains them in JavaScript:
// its onComplete is a JS callback that calls start() on the next step. So the
// end of the fade-in and the end of the 1700ms hold were both JS-thread events,
// and they arrive at the worst possible moment: right after a committed swipe,
// when the JS thread is running a storage write and re-rendering the list. The
// hold ran long and the fade-out began late, which is the lag.
//
// withSequence has no such boundary. The whole in-hold-out is described once
// and evaluated on the UI thread from beginning to end, so a busy JS thread can
// delay when it STARTS but can no longer stretch it in the middle.
const TOAST_IN_MS = 220;
const TOAST_HOLD_MS = 1700;
const TOAST_OUT_MS = 260;
// It arrives from above and leaves the same way, 12pt of travel. Small on
// purpose: it is a notice, not an entrance.
const TOAST_RISE = 12;

// THE UNDO TOAST IS A DIFFERENT JOB. An ordinary toast is a notice: it says what
// happened, it cannot be interacted with, and 2.2 seconds is generous for
// reading four words. This one holds a control, so it has to be read, decided
// on, and reached — five seconds is the shortest that leaves room for all three.
const UNDO_TOAST_MS = 5000;

// THE WINDOW ITSELF IS IN lib/saved.tsx, and it outlives this banner by six
// times over. They answer different questions: the toast asks "do you want this
// back right now", the window asks "is this decision still reversible". See
// UNDO_WINDOW_MS there, and the note that goes with it.

type ToastContextValue = {
  showToast: (msg: string) => void;
  showUndo: (msg: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const v = useContext(ToastContext);
  if (v === null) throw new Error('useToast must be used inside a ToastProvider');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { undoUnsave } = useSaved();
  const insets = useSafeAreaInsets();
  // Session only, never persisted. Counter retriggers the fade on repeat taps.
  const [toastMsg, setToastMsg] = useState("");
  const [undoMsg, setUndoMsg] = useState("");
  const [undoCounter, setUndoCounter] = useState(0);
  const [toastCounter, setToastCounter] = useState(0);
  // One value for both opacity and travel, so they cannot drift apart, and a
  // Reanimated shared value so the whole sequence stays on the UI thread.
  const toastAnim = useSharedValue(0);
  const toastStyle = useAnimatedStyle(() => ({
    opacity: toastAnim.value,
    transform: [{ translateY: (toastAnim.value - 1) * TOAST_RISE }],
  }));
  // The same value doing the same job, and now in the same place: the banner
  // shares the toast's position, so it shares its entrance too — down from above
  // rather than up from below.
  const undoAnim = useSharedValue(0);
  const undoStyle = useAnimatedStyle(() => ({
    opacity: undoAnim.value,
    transform: [{ translateY: (undoAnim.value - 1) * TOAST_RISE }],
  }));
  const undoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // In, hold, out — as one sequence rather than a delayed fade, so a second
  // message arriving mid-flight restarts cleanly instead of inheriting whatever
  // the first one had got to. toastCounter is what makes an identical message
  // twice in a row re-run this.
  useEffect(() => {
    if (toastMsg === '') return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    // Assigning over a running animation cancels it, so a second message
    // restarts from 0 without needing a stopAnimation call first.
    toastAnim.value = 0;
    toastAnim.value = withSequence(
      withTiming(1, { duration: TOAST_IN_MS, easing: REasing.out(REasing.cubic) }),
      withDelay(
        TOAST_HOLD_MS,
        withTiming(0, { duration: TOAST_OUT_MS, easing: REasing.in(REasing.cubic) }),
      ),
    );
    // Cleared a beat after the fade finishes, so the text is never blanked out
    // from under a banner that is still on screen.
    toastTimerRef.current = setTimeout(
      () => setToastMsg(''),
      TOAST_IN_MS + TOAST_HOLD_MS + TOAST_OUT_MS + 40,
    );
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toastMsg, toastCounter]);

  // The same sequence the toast above runs, with its own hold. Kept separate
  // rather than parameterised because the two banners can be on screen at once —
  // "restored" at the top while the undo banner is still fading at the bottom —
  // and one shared animation value could not express that.
  useEffect(() => {
    if (undoMsg === '') return;
    if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
    undoAnim.value = 0;
    undoAnim.value = withSequence(
      withTiming(1, { duration: TOAST_IN_MS, easing: REasing.out(REasing.cubic) }),
      withDelay(
        UNDO_TOAST_MS,
        withTiming(0, { duration: TOAST_OUT_MS, easing: REasing.in(REasing.cubic) }),
      ),
    );
    undoToastTimerRef.current = setTimeout(
      () => setUndoMsg(''),
      TOAST_IN_MS + UNDO_TOAST_MS + TOAST_OUT_MS + 40,
    );
    return () => { if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current); };
  }, [undoMsg, undoCounter]);

  // ONE SLOT AT THE TOP, AND THE NEWEST MESSAGE WINS. The two banners now share
  // a position, so they cannot both be shown: stacking them would put a notice
  // over a control, and a control under a notice is a control nobody presses.
  //
  // Newest wins rather than "the actionable one wins", because that is already
  // how this slot behaves — showToast has always replaced a toast still on
  // screen — and because a rule about which KIND of message outranks which would
  // have to be re-decided every time a message is added.
  //
  // DISMISSING THE BANNER DOES NOT CLOSE THE WINDOW. The banner is a five-second
  // offer; the window is thirty seconds of reversibility and lives in a ref that
  // none of this touches. Someone whose banner is displaced by a "saved" toast
  // can still bring the flight back from the bookmark for another twenty-five
  // seconds. That was the point of keeping the two durations apart.
  const showToast = (msg: string) => {
    setUndoMsg('');
    setToastMsg(msg);
    setToastCounter(c => c + 1);
  };

  const showUndo = (msg: string) => {
    setToastMsg('');
    setUndoMsg(msg);
    setUndoCounter(c => c + 1);
  };

  const handleUndo = async () => {
    // onTaken RUNS THE MOMENT THE RECORD IS IN HAND and before the restore is
    // awaited, which is where setUndoMsg('') always was: the banner goes when
    // undo is pressed, not when storage comes back.
    const r = await undoUnsave(() => setUndoMsg(''));
    if (r === 'restored') showToast('restored');
    else if (r === 'limit') showToast('watchlist limit reached — unsave one first');
  };

  // The two are handed out as one object, memoised on the same rule the saved
  // and query contexts follow: the array is the object's fields, one for one.
  // Neither identity ever changes, so in practice this value is created once.
  const value = useMemo(() => ({ showToast, showUndo }), []);

  return (
    <ToastContext.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
      {/* THE BANNER. Absolutely positioned against the root, which is the whole
          of why it cannot shift anything: it is out of flow, so nothing above or
          below it moves when it arrives or leaves, and the list underneath does
          not reflow by a pixel. pointerEvents none so it never intercepts a tap
          meant for what it is covering.

          Rendered after the navigator rather than before the page, because the
          scene it sits over is opaque now; the modals are their own host views
          and sit above it, which is correct — a sheet is a thing you are in,
          and this is a note about something you just did to the page behind it.

          The surface is the app's glass, from the same constants and the same
          GlassLayers every sheet and panel uses, so it cannot drift from them:
          sheetShell for the radius and the clip, GlassLayers for the blur and
          the tint, sheetEdge for the hairline. */}
      {toastMsg !== '' && (
        <Reanimated.View
          pointerEvents="none"
          style={[s.toastWrap, { top: insets.top + 12 }, toastStyle]}
        >
          <View style={[g.sheetShell, s.toastCard]}>
            <GlassLayers />
            <View style={g.sheetEdge} pointerEvents="none" />
            <Text style={s.toastText} numberOfLines={1}>{toastMsg}</Text>
          </View>
        </Reanimated.View>
      )}
      {/* THE UNDO BANNER. Same material as every other surface in the app —
          sheetShell for the radius and the clip, GlassLayers for the blur and
          the tint, sheetEdge for the hairline — because a second glass would be
          a second thing to keep in step with the first.

          THE TOAST'S OWN POSITION, top and insets.top + 12, sharing s.toastWrap
          so the two cannot drift apart. It sat at the bottom on the reasoning
          that a control should be near the thumb, which is true in general and
          wrong here: it was the only thing at the bottom of this app, and the
          one place nobody was looking. Every other message arrives at the top,
          so this one is found by arriving where they do.

          STILL TAPPABLE and still five seconds — those were the actual reasons
          for the move and neither of them was about where it sat. No
          pointerEvents="none", unlike the toast: it holds a control.

          STILL AFTER THE PAGE in document order, and now that matters more than
          it did: absolutely-positioned siblings paint in document order, and a
          control that paints under the page is a control that cannot be tapped.
          The ordinary toast stays where it is, before the page, because it takes
          no touches and has nothing to lose. */}
      {undoMsg !== '' && (
        <Reanimated.View
          style={[s.toastWrap, { top: insets.top + 12 }, undoStyle]}
        >
          <View style={[g.sheetShell, s.undoCard]}>
            <GlassLayers />
            <View style={g.sheetEdge} pointerEvents="none" />
            <Text style={s.toastText} numberOfLines={1}>{undoMsg}</Text>
            {/* #4ade80 because this is live and actionable, which is the one
                thing the green is for in this app. hitSlop rather than padding:
                the target grows, the line does not. */}
            <TouchableOpacity
              onPress={handleUndo}
              activeOpacity={0.7}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
            >
              <Text style={s.undoAction}>{'undo'}</Text>
            </TouchableOpacity>
          </View>
        </Reanimated.View>
      )}
      </View>
    </ToastContext.Provider>
  );
}

// index.tsx's own entries, read above as `s.*` exactly as they were.
const s = StyleSheet.create({
  // OUT OF FLOW, which is the layout guarantee. `top` is set at the call site
  // from the safe-area inset. alignItems centre so the card is only as wide as
  // its message rather than a full-width bar.
  toastWrap: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  toastCard: { paddingVertical: 10, paddingHorizontal: 16 },
  // MONO because the thing being confirmed is usually a flight number, and
  // every flight number in this app is mono. 13 rather than the old 11: this is
  // now the only report of what happened, not a footnote under a card.
  toastText: { fontFamily: MONO, fontSize: 13, color: '#e2e2e2' },
  // toastCard plus a row. The gap is what holds the message off the control;
  // 14 is the same rhythm resultWrap uses between blocks.
  //
  // CARD_PAD, not toastCard's 16, and the two points either side are the reason
  // the longest message fits. WIDTH, at 320pt: the wrap's 20 either side and
  // this card's 14 either side leave 252pt inside. JetBrains Mono advances
  // 0.6em, so 13pt is 7.8pt a character — "undo" is 31.2 and the gap is 14,
  // which leaves the message 206.8pt, or twenty-six characters and change.
  //
  // The longest message this banner can produce is a six-character flight number
  // and the reminder clause, "6E5031 unsaved · reminders", at exactly
  // twenty-six. At 16 of padding that was 202.8pt against 202.8 needed — no
  // slack at all, and one rounding away from an ellipsis.
  undoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: CARD_PAD,
  },
  undoAction: { fontFamily: MONO_BOLD, fontSize: 13, color: '#4ade80' },
});
