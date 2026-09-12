// THE BOOKING REFERENCE, BIG ENOUGH TO READ ACROSS A DESK.
//
// WHAT IT IS FOR. A booking reference is not something you read, it is something
// you HAND OVER -- to a check-in agent, to a gate desk, to somebody typing it
// into their own system. At 13pt in the corner of a card it is a fact about the
// leg; six characters at that size, read upside down by somebody standing over
// you, is where a P becomes an R and a 0 becomes an O. Full screen it is the one
// thing on the display.
//
// A COMPONENT RATHER THAN TWO INLINE MODALS, and that is not a preference. Two
// screens show an unpublished leg -- My Flights inside the journey, Home for a
// leg with no journey to sit in -- and a screen may never be the place another
// screen imports from; that rule is stated at the top of half the modules in
// this app. So the shared thing lives here, which is where the flight card and
// the swipe already live for the same reason.
//
// NO BARCODE, DELIBERATELY. A reference is not a boarding pass: nothing here is
// scannable, no airline would accept it, and drawing something that LOOKS
// scannable at a gate is worse than drawing nothing. The characters are the
// whole content.
//
// NO NEW COLOURS. PAGE_BG is the page this app is painted on, white is what the
// card already gives a reference value, and DIM is the tone every label and
// secondary line on both screens already takes.
import { Modal, Pressable, Text, View, StyleSheet } from 'react-native';
import { PAGE_BG, DIM } from '../lib/cards';

// Declared here rather than imported from a screen, exactly as every module in
// lib/ declares its own. These are the family names _layout registers.
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

// ── THE SIZE, AND WHY IT IS NOT LARGER ──────────────────────────────────────
//
// 56pt IN JETBRAINS MONO, WHICH ADVANCES 0.6em. Six characters -- the length of
// every airline record locator -- is 6 x 33.6 = 202pt, inside the 280pt a 320pt
// screen leaves after the padding below. A seven-character reference still fits
// at 235; adjustsFontSizeToFit catches anything longer rather than wrapping,
// because a reference broken across two lines is two strings, not one.
//
// letterSpacing 4 IS NOT DECORATION EITHER. It is what stops a monospaced run
// of six capitals reading as one word when somebody is copying it a character
// at a time.
const PNR_SIZE = 56;

export function BigPnr({ pnr, airline, route, onClose }: {
  pnr: string;
  // BOTH MAY BE NULL AND BOTH ARE THEN ABSENT, not blank. A leg from an email
  // that printed no carrier has no airline; one with neither endpoint resolved
  // has no route. An empty line under the reference would be a slot held open
  // for nothing.
  airline: string | null;
  route: string | null;
  onClose: () => void;
}) {
  const sub = [airline, route].filter(Boolean).join(' · ');
  return (
    // TRANSPARENT false AND PAGE_BG ON THE SURFACE: this is the page, full
    // screen, rather than a sheet over it. There is nothing behind it worth
    // seeing through to -- the point is that the reference is the only thing on
    // the display.
    //
    // onRequestClose CARRIES THE ANDROID BACK BUTTON. The app is iPhone-only
    // today, but a modal with no way out on a platform the code can run on is
    // the kind of thing that is found by somebody stuck in it.
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* TAP ANYWHERE. The whole page is the dismiss target, so there is no
          close control to find and nothing to aim at -- which is right for a
          surface whose entire job is to be held up and then put away. */}
      <Pressable style={p.page} onPress={onClose} accessibilityRole="button">
        <View style={p.stack}>
          <Text
            style={p.pnr}
            numberOfLines={1}
            adjustsFontSizeToFit
            // The reference is read aloud as often as it is read, and a
            // screen reader spelling it as a word is useless at a desk.
            accessibilityLabel={pnr.split('').join(' ')}
          >
            {pnr}
          </Text>
          {sub !== '' && <Text style={p.sub}>{sub}</Text>}
        </View>
      </Pressable>
    </Modal>
  );
}

const p = StyleSheet.create({
  // CENTRED ON BOTH AXES, with enough side padding that the reference never
  // runs to the edge of the glass on a small phone.
  page: {
    flex: 1,
    backgroundColor: PAGE_BG,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  stack: { alignItems: 'center' },
  pnr: {
    fontFamily: MONO_BOLD,
    fontSize: PNR_SIZE,
    color: '#ffffff',
    letterSpacing: 4,
    textAlign: 'center',
  },
  // THE SAME 13pt SANS AT DIM the leg's own secondary line takes, so the
  // subtitle here and the sentence on the card are plainly the same voice.
  // 20 under a 56pt line is about a third of its height: far enough to be a
  // caption rather than a second line of the same block.
  sub: {
    fontFamily: SANS,
    fontSize: 13,
    color: DIM,
    marginTop: 20,
    textAlign: 'center',
  },
});
