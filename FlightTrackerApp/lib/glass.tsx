import { View, StyleSheet } from 'react-native';
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
export const SHEET_EDGE = 'rgba(255,255,255,0.08)';

// THE SCRIM behind every glass surface. One value, three users: the archive
// sheet, the calendar sheet and the anchored dropdown panels, plus the profile
// sheet's backdrop. It was three different values before — 0.40, 0.35 and 0.72
// — which is exactly the drift this constant exists to stop.
export const SHEET_SCRIM = 'rgba(0,0,0,0.40)';

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

const g = StyleSheet.create({
  // Over the blur, under the content. Order in the tree is what makes this a
  // tint on the blur rather than something the blur eats.
  sheetTint: { backgroundColor: SHEET_FILL },
});
