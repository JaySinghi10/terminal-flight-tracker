// THE HAND-DRAWN GLYPHS THAT OUTLIVED THE BAR THEY WERE DRAWN FOR.
//
// components/GlassTabBar.tsx was deleted in Stage 8 of the native conversion
// and every SVG path in it went with it, except this one. The My Flights tab
// was meant to keep it and could not -- a native tab icon takes a bitmap, a
// font glyph or a loader, never an SVG element -- and the owner chose the SF
// Symbol 'airplane' over rasterising. The path lives on here, character for
// character, with the tracing notes that justified its two corrected numbers,
// because Stage 10 converts the swipe glyphs to symbols and some of those may
// have no equivalent either; whatever draws a hand-made glyph next starts
// from the same outline and not from a redraw.
//
// DRAWN TO index.tsx's ICON CONVENTION: a 24-unit viewBox, no fill, a 1.75
// stroke with round caps and joins, 22 points on screen. A renderer that
// produces a bitmap from it must keep that stroke, because the outline is a
// stroked path and a filled one is a different (and solid) aeroplane.

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
export const ICON_SAVED_D = 'M12 3c.9 0 1.5 1.2 1.5 3v3.2l7.5 4.3v2l-7.5-2.3v4.3l2.5 1.8v1.7L12 20l-4 1v-1.7l2.5-1.8v-4.3L3 15.5v-2l7.5-4.3V6c0-1.8.6-3 1.5-3z';

// The convention the path was traced against, so a rasteriser has the numbers
// beside the outline rather than in a deleted file's comments.
export const ICON_VIEWBOX = 24;
export const ICON_STROKE = 1.75;
