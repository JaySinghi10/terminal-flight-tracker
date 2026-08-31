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
export const CARD_FILL = 'rgba(255,255,255,0.03)';
export const CARD_RADIUS = 12;
export const CARD_GAP = 8;
export const CARD_PAD = 14;

// THE PAGE. Three things need to name this colour rather than two: the root,
// the static row fill under the flight card, and the animated one the saved
// rows now use, which spells it inside a worklet where a StyleSheet entry
// cannot be read.
export const PAGE_BG = '#050505';
