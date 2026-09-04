// THE FLAT SURFACES: the page, and the card that sits on it.
//
// Every line below was app/index.tsx's and every line is unchanged.
//
// NOT lib/glass.tsx, AND THAT IS THE WHOLE REASON THIS FILE EXISTS. A card is
// the app's NON-glass surface: a flat 3% white fill on the page, with no blur,
// no tint and no scrim behind it. Glass is the other treatment entirely, and the
// radii below say so out loud — a card is 12 precisely so that a card inside a
// 16pt sheet does not read as a sheet. Filing the two together would have made
// lib/glass.tsx's own first line ("THE APP'S GLASS, IN ONE PLACE") untrue and
// put two different materials behind one name.
//
// PAGE_BG comes here rather than there for the same reason: it is what a card is
// painted OVER, and two of its three readers are the card layer — the static
// fill under the flight card and the animated one a dragging row paints itself
// with. See its own note below.
import { StyleSheet } from 'react-native';

// The family names _layout registers, declared here for the same reason every
// other module in lib/ declares its own. Only the stylesheet at the foot of this
// file reads it.
const SANS_SEMI = 'Inter_600SemiBold';

// ── CARDS ────────────────────────────────────────────────────────────────────
//
// A row was a band of text with a hairline under it. It is now a shape.
//
// FILL rgba(255,255,255,0.03), which is already in the file as the pill
// triggers' background and composites over the page to about rgb(12). Seven
// levels above the page: enough to read as a raised surface, far too little to
// compete with anything written on it. The hairline goes with it — a card that
// is a distinct shape does not also need a line telling you where it ends.
//
// RADIUS 12, and the three radii in the app now read as a nesting order. The
// sheets are 16 because they are the largest shapes and hold everything else. A
// card is 12: smaller than its container, which is what stops a card inside a
// sheet looking like a sheet. The swipe buttons are 18, larger than either
// despite being the smallest things on screen, because they are CONTROLS rather
// than containers and roundness is how a control says so.
//
// GAP 8 between cards, which replaces the separator rather than adding to it.
//
// HEIGHT is unchanged, and slightly less. Every paddingVertical is exactly what
// it was — 13 on a saved row, 18 on an archive row and a route row — and the
// 1pt border has gone, so a row is 1pt SHORTER than before. The list is taller,
// but by the gaps between rows rather than by anything inside them.
//
// PADDING 14 horizontally, which the rows did not have at all: content used to
// run to the page's own margin. This is the one number that needed checking
// against the route rows, whose whole layout depends on the departure times
// starting at one x and the arrival times ending at another. It survives
// because every row takes the SAME padding, including the pinned "fastest" row
// above the list — the column moves inward by 14 as a block and stays a column.
// What does change is that the times no longer align with the group headings
// above them, which sit at the page margin. That is correct: the heading labels
// the cards, it is not one of them.
// ── THE ELEVATION SCALE ──────────────────────────────────────────────────────
//
// FOUR VALUES, AND THEY DESCRIBE WHAT SITS ON WHAT. Nine different white alphas
// were spread across the app before this -- 0.03, 0.05, 0.06, 0.07, 0.08, 0.10,
// 0.12, 0.16, 0.18 -- one of them named and the rest picked per file. The result
// was not that surfaces looked wrong individually; it was that adjacent ones sat
// at accidental distances, so nothing read as distinct from anything else, and
// the page could not be adjusted without breaking whichever literals happened to
// have been tuned against it.
//
// THE PAGE IS NOT BLACK, AND THAT IS THE FIRST THING THE SCALE BUYS. #0a0a0a
// rather than #000000, because pure black cannot show elevation: nothing sits
// below it, so a surface laid on it has nothing to lift away FROM. Ten levels of
// headroom is not enough to see on its own and is exactly enough to let a 4.5%
// white read as raised rather than as a stain.
//
// SURFACE_1 IS WHAT SITS ON THE PAGE. Cards and rows -- a watchlist row, a
// result row, a trip leg, a button on an otherwise empty screen.
//
// SURFACE_2 IS WHAT SITS ON A SURFACE_1. A control inside a card, a sheet or a
// menu over the page, a pill on the tab bar. It is defined by what is UNDER it
// rather than by which file draws it: the same control is level 2 in a card and
// level 1 on the page.
//
// SURFACE_EDGE IS TRANSPARENT, AND THAT IS A DECISION RATHER THAN AN ABSENCE.
//
// THE SURFACES SEPARATE BY TONE, NOT BY EDGE. A level 1 fill on a page that is
// no longer pure black is already a step of its own, and a level 2 on a level 1
// is another; drawing a line around each as well states the same boundary a
// second time, in a louder voice than the boundary deserves. Two devices saying
// one thing is how a card starts to read as a control.
//
// SO THE VALUE IS ZERO ALPHA AND NOT `transparent`, and it is not removed. The
// hairline is still composed, still positioned, still rendered -- every sibling
// View that draws it is in place across index, search, flights and the flight
// card -- and it draws nothing. Written this way the whole treatment comes back
// by changing one number here, which is the only reason it was worth keeping the
// render sites at all. Deleting them would have made this a decision to re-make
// rather than a value to reverse.
//
// IT WAS 0.10 AND MAY BE AGAIN. The argument for it stands on its own terms: at
// these alphas a fill alone barely registers, and one pixel of 10% white is what
// turns a tint into a shape. What settled it was seeing both at once -- tone and
// line together was more than the hierarchy needed.
//
// FLAT AND OPAQUE ONLY, AND THIS IS THE SCALE'S ONE BOUNDARY. Glass keeps its
// own edge: a blurred surface reads at a different perceived contrast than a
// flat one, so it needs its own weight, and SHEET_EDGE is tuned as a PAIR with
// SHEET_RULE rather than being free to move. See the note at SHEET_EDGE in
// lib/glass.tsx, which states the same exception from the other end.
//
// WHAT IS NOT ON THE SCALE: text, dividers, progress tracks, scrims, and any
// fill that sits BEHIND a blur for the blur to sample. Those answer different
// questions and a shared constant would only make them look related.
export const SURFACE_1 = 'rgba(255,255,255,0.045)';
export const SURFACE_2 = 'rgba(255,255,255,0.08)';
export const SURFACE_EDGE = 'rgba(255,255,255,0)';

// KEPT, AND POINTED AT THE SCALE RATHER THAN CARRYING ITS OWN VALUE. Five files
// import this name and every one of them means "a card on the page", which is
// SURFACE_1. Renaming it at every call site would be a large diff that changed
// nothing, and deleting it would break them all.
export const CARD_FILL = SURFACE_1;
export const CARD_RADIUS = 12;
export const CARD_GAP = 8;
export const CARD_PAD = 14;

// THE PAGE. Three things need to name this colour rather than two: the root,
// the static row fill under the flight card, and the animated one the saved
// rows now use, which spells it inside a worklet where a StyleSheet entry
// cannot be read.
export const PAGE_BG = '#0a0a0a';

// THE PAGE, AS COMPONENTS RATHER THAN AS A HEX STRING.
//
// THREE FILLS ARE "THE PAGE AT SOME OPACITY" and a hex cannot serve them: the
// map's home button, the search panel's own button, and the tab bar's. All three
// are near-opaque black laid over something that must not show through, and all
// three must move WITH the page or they band against it -- a 0.82 fill of rgb(5)
// sitting on a rgb(10) page is a rectangle you can see the edge of.
//
// A STRING OF THE THREE CHANNELS, interpolated into an rgba() by the caller,
// because that is the only form a template can compose an alpha onto. It is the
// same colour as PAGE_BG and the two are written next to each other so they
// cannot come apart.
export const PAGE_RGB = '10,10,10';

// THE TWO ENTRIES BOTH SCREENS READ, and the only reason this file now declares
// a stylesheet at all.
//
// detailsTitle heads home's watchlist and the search screen's chat response;
// headingRow is the row home puts its watchlist heading in and the search screen
// puts its route heading in. Two entries, two screens each, and neither screen
// may import from the other — so they live down here with the vocabulary they
// are made of rather than being copied twice.
//
// THE CALL SITES READ THEM AS `c.*`, which is the one edit the move forced: they
// were `s.detailsTitle` and `sf.headingRow` in app/index.tsx and are no longer
// entries of any screen's own sheet.
export const c = StyleSheet.create({
  detailsTitle: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI,
    marginBottom: 10, letterSpacing: 1, textTransform: "uppercase",
  },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
