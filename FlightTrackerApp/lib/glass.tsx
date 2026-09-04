import { View, StyleSheet, Easing } from 'react-native';
import { BlurView } from 'expo-blur';

// THE APP'S GLASS, IN ONE PLACE. Every value and comment below was lifted out of
// app/index.tsx unchanged; nothing here is new and nothing was reworded. It
// moved because components/GlassTabBar.tsx needs the same material, and a
// component importing it from a screen would have been the drift these comments
// spend four hundred lines guarding against.
//
// The only edit made in the move: GlassLayers read `s.sheetTint` from index's
// own stylesheet and now reads `g.sheetTint` from the one at the bottom of this
// file, which is that same entry moved with it.

// THE BLUR, inside the sheet and clipped to it.
//
// It covered the whole screen before, which softened the page everywhere and
// left nothing for the sheet to be a window ONTO. Behind the panel the page is
// blurred; a millimetre outside it, the page is sharp and merely dimmed. That
// edge is the whole effect.
//
// THE TINT is systemChromeMaterialDark, and that is the whole of this change.
//
// "dark" was not a neutral darkening. expo-blur's own table gives it as
// rgb(25,25,25) at 0.69 x intensity — at 55 that is a 38%-opaque light-grey
// wash, and over a page this dark it does not darken at all, it LIFTS. Measured
// from those numbers: the ground under the panel is rgb(2.25); "dark" takes it
// to rgb(10.88). The scrim and the fill both subtract; the tint was the only
// thing adding, and it was adding more than they were taking away.
//
// systemChromeMaterialDark is the one dark material in the set whose colour is
// rgb(0,0,0) rather than rgb(25) or rgb(37) — pure black at 0.75 x intensity.
// It blurs exactly as hard and adds no light at all, which is what lets the
// panel sit on the page colour instead of above it.
//
// The intensity is untouched. It could not have fixed this: the tint's alpha
// scales WITH intensity, so turning the blur down turns the grey down and the
// blur with it. The colour was the problem, not the amount.

// 32 of 100.
//
// 32, down from 55, and this one number is doing two jobs at once.
//
// A blur preserves the AVERAGE brightness under its kernel; what it changes is
// how far that average is spread. On Android the radius is intensity / 4, so 55
// was a radius of 13.75 against a saved row's pitch of roughly 41pt. The kernel
// was wide enough to reach from one row of text to the next, which means every
// dark gap got averaged together with the white text on either side of it and
// the whole panel settled at the page's mean brightness. That is what a uniform
// grey fog IS: a blur wide enough that nothing local survives it.
//
// At 32 the radius is 8. Still comfortably past readable — the probe at 8 gave
// a radius of 2 and the page was plainly legible, and 13pt text loses its words
// once the radius passes its x-height of about 6.5 — but only a fifth of the
// row pitch, so the gaps between rows stay as dark as they started and the text
// stays a localised blob rather than a screen-wide wash. Black where the page
// is black, soft shape where the page has something on it.
export const SHEET_BLUR = 32;

// THE SHEET SURFACE, and there is only one layer of it now.
//
// FILL is translucent black over the blur, and NOTHING else. The vertical
// gradient that used to sit on top of it has gone: white over black makes grey,
// and a grey panel on a black page reads as a card laid on the screen rather
// than as a window through it.
//
// 0.22, down from 0.34. More of the blurred page comes through and nothing
// else about the panel moves.
//
// The whole stack, from the page outward. The scrim figure below was stale —
// it still read 0.55 after routeCalDim went to 0.40 last round — and is
// corrected here:
//
//   page                        rgb(5.00)
//   through the scrim 0.40      rgb(3.00)   <- and this is also what is seen
//                                              OUTSIDE the panel
//   through the tint (black)    rgb(2.28)
//   through the fill 0.22       rgb(1.78)   <- the panel's own ground
//
// Transmission goes from 30.1% to 35.6%: (1 - 0.40)(1 - 0.24)(1 - 0.22).
//
// It cannot turn grey by going down, which is worth being explicit about since
// grey is the failure mode everything here is guarding against. The fill is
// BLACK; less of it means more of the page, and the page is rgb(5). The ground
// rises from rgb(1.51) to rgb(1.78) and stays a level and a quarter BELOW the
// rgb(3.00) around it. The panel is still the darkest thing on the screen.
export const SHEET_FILL = 'rgba(0,0,0,0.22)';

// THERE IS NO OUTLINE. The stroked SVG rounded rectangle that used to sit here,
// and the per-side border before it, are both gone.
//
// What replaces them is nothing, and that is the point: the panel's boundary is
// the place where the page stops being blurred. Outside the radius the page is
// sharp and merely dimmed; a pixel inside it, the same content is soft. Over
// anything with content behind it that transition is unmistakable, and it costs
// no ink at all — it is the edge FELT rather than an edge drawn.
//
// Where there is genuinely nothing behind the panel the boundary does vanish,
// and no fill can rescue it: the surroundings are already rgb(2.25), so even a
// fully opaque black panel would differ by two levels. There is not enough
// light out there to take any more of away. The alternative was a stroke, and a
// stroke is the thing being removed.
//
// SHEET_RADIUS survives because sheetShell still rounds and still clips — the
// clip is what confines the blur, which is now the only thing marking the edge.
export const SHEET_RADIUS = 16;
// The rule under the heading is NOT an edge treatment. It separates two pieces
// of content and keeps its own weight accordingly.
export const SHEET_RULE = 'rgba(255,255,255,0.07)';

// A HAIRLINE, and the fifth attempt at this edge is the first that is not a
// gradient. Four soft falloffs — top stroke, top wash, bottom wash — all read
// as grey rather than as light, and they read that way because that is what a
// low-alpha white ramp over black IS. Spread any small amount of white over
// 20pt and the eye integrates it into a haze; put the same white in one row of
// pixels and it is a line with a lit edge.
//
// So: one pixel, one opacity, all four sides the same. Nothing to integrate.
//
// 0.08 white, down from the 0.12 this was first written for. Against the page
// outside at rgb(3.0) that renders at rgb(23) rather than rgb(33) — still a
// definite line, but a quiet one, and confined to a single pixel so it cannot
// wash anything whatever its opacity.
//
// That puts it within a hair of SHEET_RULE's 0.07 above. At 0.12 the panel's
// outline was plainly the heavier of the two; at 0.08 the edge of the sheet and
// the rule under its heading carry about the same weight, which is a choice
// rather than an oversight — nothing here is meant to outrank the content.
//
// A hairline is also the one treatment where lowering the opacity costs no
// crispness: there is no falloff to go hazy, so it stays a line all the way
// down. rgb(23) is roughly the floor at which it still reads on a dark panel.
//
// Uniform on every side ON PURPOSE, and this is the one thing that must not
// change. React Native draws a border from the layer's own corner radius as a
// single unbroken rounded rectangle only while all four sides share a colour;
// give one side its own and RN switches to drawing four separate edges and
// splits every corner arc between two of them. That is what broke the corners
// two rounds ago. A lit-from-above asymmetry is not available here at any
// price, and trying to fake it with a gradient is what this replaces.
//
// It is a sibling rather than a border on sheetShell so that adding it costs no
// layout: a border there would inset the content box by 1pt on every side.
//
// ── AND IT IS A DELIBERATE EXCEPTION TO THE ELEVATION SCALE ─────────────────
//
// lib/cards.ts now names one edge for every flat surface in the app, at 0.10.
// This is NOT that value and must not be moved to it.
//
// A BLURRED SURFACE READS AT A DIFFERENT PERCEIVED CONTRAST THAN A FLAT ONE.
// Behind a hairline on a card there is one colour, so the line has one thing to
// be measured against. Behind this one there is a blur of whatever the page
// happens to be showing, which is brighter and busier and varies as the surface
// moves -- so the same white reads heavier here than it does on a card. An edge
// weight that is right on flat is wrong on glass.
//
// AND IT IS HALF OF A PAIR. The paragraphs above set 0.08 against SHEET_RULE's
// 0.07 on purpose, so the outline of a sheet and the rule under its heading
// carry about the same weight and neither outranks the content. Moving this to
// 0.10 to make a constant tidy would break that pair and make every sheet in
// the app look wrong in exchange for a consistent number.
export const SHEET_EDGE = 'rgba(255,255,255,0.08)';

// THE SCRIM behind every glass surface. One value, three users: the archive
// sheet, the calendar sheet and the anchored dropdown panels, plus the profile
// sheet's backdrop. It was three different values before — 0.40, 0.35 and 0.72
// — which is exactly the drift this constant exists to stop.
export const SHEET_SCRIM = 'rgba(0,0,0,0.40)';

// Declared here rather than imported from a screen, for the same reason
// components/GlassTabBar.tsx and lib/flightstatus.tsx declare their own: a module
// reaching into a route for a string constant would couple the two. The value is
// the family name _layout registers. sheetTitle below is its only reader.
const MONO_BOLD = 'JetBrainsMono_700Bold';

// HOW A GLASS SURFACE ARRIVES AND LEAVES, moved here whole from app/index.tsx.
//
// THE WHOLE BLOCK CAME, including the three figures the anchored dropdown panel
// uses, because the two comments in it describe the named constants and the
// unnamed ones TOGETHER — "the panel travels less than the calendar" is one
// sentence about OVERLAY_RISE and CAL_RISE at once — and splitting it would have
// meant either orphaning a comment or writing a second copy of it. The dropdown
// panel is a glass surface too: it renders GlassLayers behind its options and
// wears SHEET_EDGE and SHEET_RADIUS, so its motion belongs beside the sheets'.
// Overlay motion. Entry decelerates hard and settles; exit accelerates away and
// is shorter. The asymmetry is the point: a surface arriving should look like it
// is coming to rest, and one leaving should not make you wait for it.
//
// EASE_OUT is the standard expo-out bezier. Easing.out(Easing.cubic), which
// these used before, spends too much of its budget near the end to read as
// motion at all over 140ms.
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN = Easing.bezier(0.4, 0, 1, 1);

// The panel travels less than the calendar because it starts beside its trigger
// and only has to look like it came out of it.
export const OVERLAY_RISE = 10;
export const CAL_RISE = 28;

export const PANEL_IN_MS = 220;
export const PANEL_OUT_MS = 150;
export const CAL_IN_MS = 260;
export const CAL_OUT_MS = 170;
// Its own timing, on its own value. Slightly ahead going in and slightly behind
// coming out, so the backdrop never looks welded to the surface it sits under.
export const SCRIM_IN_MS = 200;
export const SCRIM_OUT_MS = 150;

// THE MATERIAL, as one component, so it cannot be spelled differently in two
// places. Every glass surface renders this pair behind its content and nothing
// else: the blur samples what is behind the surface, then the tint darkens the
// result.
//
// Both layers are position: absolute, which matters more here than it does in
// the sheets. The dropdown panel is measured by onLayout to decide whether it
// flips above its trigger, and Yoga skips absolutely-positioned children when
// it collects a container's flex lines — FlexLine.cpp continues past any child
// whose positionType is Absolute — so neither layer can contribute to the size
// the panel reports.
//
// dimezisBlurView is not optional on Android. expo-blur's own default is
// 'none', which paints a flat colour and no blur at all.
//
// EVERY glass surface goes through here: both centred sheets, the anchored
// dropdown panels and the profile sheet. The two sheets used to spell the pair
// out inline, which is the drift this exists to stop — there is no second copy
// of the material left to fall out of step.
//
// A fragment, so it contributes no host view of its own and the layers stay
// direct children of whatever renders them. The output is the same two views
// in the same order that each caller had before.
export function GlassLayers() {
  return (
    <>
      <BlurView
        intensity={SHEET_BLUR}
        tint="systemChromeMaterialDark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, g.sheetTint]} pointerEvents="none" />
    </>
  );
}

// THE CHROME EVERY GLASS SURFACE WEARS, and the entries are index.tsx's own,
// unchanged. They came here because three surfaces already share them — the
// archive sheet, the details sheet and the calendar — and two of those three are
// leaving for the search screen. A second copy is how the sheet that stays and
// the sheets that go would come to sit, pad and rule differently.
//
// THE ONE EDIT THE MOVE FORCED IS AT THE CALL SITES, not here: index.tsx read
// these as `s.sheetShell` and now reads them as `g.sheetShell`, because they are
// no longer entries of its own stylesheet. Every declaration below is verbatim.
//
// sheetHeadTitle IS DELIBERATELY NOT HERE. It composes with airportTitle, which
// is the flight card's typography rather than the glass's, so it stays with the
// card and travels with it.
export const g = StyleSheet.create({
  // Over the blur, under the content. Order in the tree is what makes this a
  // tint on the blur rather than something the blur eats.
  sheetTint: { backgroundColor: SHEET_FILL },
  // Centred, unlike pm.backdrop which anchors its sheet to the bottom.
  routeCalScrim: {
    flex: 1,
    justifyContent: "center", paddingHorizontal: 16,
  },
  // 0.55. It went to 0.88 to do a job that was not its own: with nothing
  // blurring the page, only brute darkness could stop the text behind competing
  // with the text in front, and the result was a black rectangle on a black
  // screen. The blur does that job properly now, so the scrim can go back to
  // what a scrim is for — pushing one plane behind another — and the page is
  // allowed to be visible again.
  //
  // 0.40, down from 0.55, and it is the panel this is for rather than the page.
  //
  // A subtractive panel can only be as dark as the light behind it lets it be.
  // At 0.55 the page outside sat at rgb(2.25) and the panel at rgb(1.13): the
  // panel was removing 50% of nothing, so there was nothing to see. Turning the
  // scrim DOWN puts light back outside for the panel to take away.
  //
  // Where the page is empty this is bounded and stays small — even at no scrim
  // at all the gap tops out at 2.5 levels, because the page itself is only
  // rgb(5). Where the page has content it is the whole effect: a line of white
  // text outside goes from rgb(102) to rgb(138) while the same line inside,
  // blurred and taken through the tint and the fill, stays near rgb(23).
  //
  // An earlier note here claimed 0.45 would "start competing with the sheet".
  // That was asserted, not worked out. At 0.40 the page's text renders at
  // rgb(138) against the sheet's own rgb(255) — 25% of its relative luminance,
  // which recedes clearly. 0.30 would be rgb(161) and 35%, which would not.
  //
  // It is also NOT deleted in favour of the blur's own tint. This layer is the
  // one whose value is known exactly on every platform; if a device renders no
  // blur at all, this is what still separates the sheet from the page.
  //
  // Shared with the calendar sheet, deliberately: both are centred sheets that
  // take over the screen, and a scrim that means one thing on one and another
  // on the other would be a bug in waiting. The dropdown panels now take this
  // same value through SHEET_SCRIM rather than the lighter one of their own
  // they used to carry.
  routeCalDim: { backgroundColor: SHEET_SCRIM },
  // THE SHELL. Deliberately generic: the dropdown panels take this same
  // treatment by swapping routePanel's background, border and radius for these
  // and putting the same GlassLayers pair in behind their content.
  // Nothing here knows anything about archives.
  sheetShell: {
    borderRadius: SHEET_RADIUS,
    // Clips the blur — and the rows — to the radius. This is now doing real
    // work: it is what confines the blur to the panel's own rounded rectangle
    // instead of the whole screen.
    overflow: "hidden",
    // NO backgroundColor. The blur samples what is drawn behind it, and an
    // ancestor's background counts as behind it — a fill here would be blurred
    // into the result and flatten it. The fill is a sibling drawn AFTER the
    // blur instead: see GlassLayers in lib/glass.tsx.
    //
    // NO border and no stroke. The overflow above is the whole edge treatment:
    // it is what stops the blur at the radius, and that stop is what the eye
    // reads as the boundary. See SHEET_RADIUS.
  },
  // Fills the shell exactly and carries the border, so the shell's own layout
  // is untouched. Its radius MATCHES the shell's, which is what puts the line on
  // the shell's edge rather than floating inside it, and what makes the corners
  // curve instead of meeting.
  sheetEdge: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 1, borderColor: SHEET_EDGE, borderRadius: SHEET_RADIUS,
  },
  // Padding only.
  sheetBody: { padding: 20 },
  // FILL, because there is now a height to fill. The shell has a definite
  // minimum, so the body takes all of it and the list takes what is left after
  // the header — which is what bounds the list, and an unbounded ScrollView
  // does not scroll. Only a sheet with a fixed height may use this: flex: 1 in
  // an auto-height parent collapses to nothing.
  sheetBodyFill: { flex: 1 },
  // More above than below. sheetBody's 20 put the title the same distance from
  // the top edge as the rule was from the title, so the header read as pinned
  // to the ceiling rather than seated under it. 8 more above makes it 28 and 18.
  sheetHead: {
    flexDirection: "row", alignItems: "center",
    marginTop: 8,
    paddingBottom: 14, marginBottom: 4,
    borderBottomWidth: 1, borderBottomColor: SHEET_RULE,
  },
  // The close button's LAYOUT width: 20pt glyph + 4pt padding each side, less
  // the 4pt it outdents. Matching it exactly is what centres the title on the
  // sheet rather than on the space left beside the button.
  sheetHeadSpacer: { width: 24 },
  sheetTitle: {
    flex: 1, fontSize: 13, color: "#ffffff", fontFamily: MONO_BOLD,
    textAlign: "center",
  },
  // Identical to routeCalClose. The padding is the touch target the ring used
  // to imply, and the negative margin lets the glyph sit level with the edge of
  // the content rather than one padding-width inside it.
  sheetClose: { paddingVertical: 4, paddingHorizontal: 4, marginRight: -4 },
});
