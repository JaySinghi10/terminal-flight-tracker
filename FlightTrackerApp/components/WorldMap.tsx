// THE MAP: GEOMETRY, PLACE NAMES, AND A FINGER.
//
// No airports, no camera fly, no place heading, no route arc. Those are step 3.
//
// ── WHAT MAKES IT FAST, IN THE ORDER IT WAS DONE ────────────────────────────
//
//   1  BOUNDING-BOX FILTER BEFORE PROJECTING. Step 1 projected all 471 features
//      at every camera and let d3's clip discard the 416 that were off screen,
//      which is where nearly all of the time went. Each feature's geographic
//      bbox is computed ONCE at module load and tested against the camera's own
//      lon/lat window, so a feature that cannot be seen is never handed to the
//      projection at all.
//   2  MEMOISED ON THE CAMERA. The paths and the labels are built inside a
//      useMemo keyed on the camera and the viewport, so a keystroke into the tab
//      bar's field or a minute tick re-renders app/search.tsx and this component
//      does no work at all.
//   3  THE STATES FILE REQUANTISED TO 1e4, 493KB -> 405KB. That is a 4km grid
//      against a camera that never goes below 100km across, where one point is
//      0.25km — the discarded precision was not reachable.
//
// ── WHAT MAKES IT MOVE ──────────────────────────────────────────────────────
//
// DURING A GESTURE NOTHING IS PROJECTED. The rendered geometry is a fixed
// Mercator plane and the finger drives a translate and a scale on it from
// Reanimated shared values, on the UI thread, at whatever rate the display runs.
// Zero JavaScript per frame.
//
// AND THAT IS EXACT RATHER THAN AN APPROXIMATION, which is the property Mercator
// buys. The projection is x = k(lambda - lambda0), y = -k(mercY(phi) - mercY(phi0)),
// linear in mercator space — so a uniform scale and a translation of the plane IS
// a real change of k and centre. There is no reprojection error to correct on
// settle, only the things that are not geometry: stroke widths and type sizes.
//
// ON SETTLE the camera state is set from the live one and the geometry is built
// again at the new scale. The transform becomes the identity in the SAME render,
// because it is derived from the live camera against the committed camera rather
// than held as a separate offset — see mapStyle. There is no frame in which new
// geometry is drawn under an old transform.
//
// ── THE GESTURE RULES, TAKEN FROM components/GlassTabBar.tsx ────────────────
//
// That file lost four separate rounds to making a mode a property of the GESTURE
// rather than of what the gesture DOES: .enabled() toggling corrupted the config,
// .onTouchesDown() with manager.fail() corrupted the native reset lifecycle, an
// early return left the recogniser open forever, and display:'none' took its view
// out of the hierarchy. Nothing here toggles .enabled(), registers a touch
// callback, or returns early from any gesture callback. Every callback runs every
// statement it has.
import { useState, useMemo, useEffect } from 'react';
import { useWindowDimensions, View, StyleSheet } from 'react-native';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedStyle, useSharedValue, runOnJS } from 'react-native-reanimated';
import { geoMercator, geoPath, geoBounds } from 'd3-geo';
import { feature } from 'topojson-client';

// Declared here rather than imported from a screen, as every other module in
// components/ and lib/ declares its own. Inter, not JetBrains Mono: these are
// place names, not machine data.
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

// COUNTRIES AT ONE OF TWO RESOLUTIONS, and this constant is the whole switch. A
// conditional require rather than two imports: both are in the bundle either way
// because Metro resolves a static path whether or not the branch is taken, but
// only the selected module FACTORY runs, so only one is decoded at startup.
const COUNTRY_RES: '110m' | '50m' = '110m';

// ── THE CAMERA ───────────────────────────────────────────────────────────────
//
// { lon, lat, k } AND NOT { lon, lat, spanKm }, and the difference is load
// bearing. k is the Mercator scale in pixels per radian of longitude, and it is
// what the projection actually takes. A span in km is not a property of the
// camera at all — Mercator's scale varies with latitude, so the same k shows
// 3,000km at 22N and 4,400km at the equator. Storing the span and deriving k
// from the centre's latitude would mean a PAN north or south silently rescaled
// the map, and the settle would then disagree with the transform the finger had
// just drawn. So k is stored and the span is derived for the clamp alone.
type Camera = { lon: number; lat: number; k: number };

const EARTH_R_KM = 6371;
const START_CENTRE: [number, number] = [80, 22];
const START_SPAN_KM = 3000;

// THE ZOOM CLAMP, in km across the viewport at the camera's OWN latitude.
// Below 100km there is no geometry left in these files to show — 50m admin_1 is
// a 4km grid — and above 5,000km the frame is mostly ocean with a few outlines.
const MIN_SPAN_KM = 100;
const MAX_SPAN_KM = 5000;
// AND THE PAN CLAMP. 72 rather than 85: past it Mercator's stretch makes a
// degree of latitude taller than the screen, and there is nothing up there worth
// the confusion. Longitude is the whole world.
const LAT_LIMIT = 72;
const LON_LIMIT = 180;

// HOW MUCH MORE THAN THE SCREEN IS BUILT, as a fraction of the half-window on
// each side. THIS IS THE DRAG BUDGET, and it was the bug.
//
// Nothing is projected during a gesture — that is the whole architecture — so
// the finger reveals geometry that was built for the camera it started from.
// At 0.25 the surplus was a quarter of half the screen, 50px across and 109
// down, and any ordinary drag ran past it into blank space before the settle
// could re-project. The margin IS how far a finger may travel before the map
// runs out, and nothing else sets that distance.
//
// 1.0 GIVES A FULL HALF-SCREEN IN EVERY DIRECTION: 201px across and 437px down
// at 402x874. A drag longer than that still reaches the edge — no finite margin
// can prevent it — but 437px down is more than half the screen, and the settle
// is one frame behind the lift.
//
// WHAT IT COSTS IS AREA, and area is quadratic: 1.0 builds 2x2 = four times the
// viewport's own extent, nine times at 1.25. That is why it could not simply be
// raised — see the states gate below, which is what paid for it.
const CULL_MARGIN = 1.0;

// ── THE INK ──────────────────────────────────────────────────────────────────
//
// TWO WEIGHTS, and the gap between them is the point: a country line has to read
// above a state line at a glance, and on a #050505 ground the only levers a
// hairline has are alpha and width. NO GREEN — that is the app's live-and-
// actionable colour and nothing here is either yet.
// ── LAND, AND WHY IT IS A SEPARATE FILE ──────────────────────────────────────
//
// Everything used to be an outline on black, which reads as a wire diagram
// rather than as a map: there was no way to tell sea from land except by knowing
// the shapes already.
//
// land-110m IS COASTLINE WITH NO INTERNAL BORDERS — one feature, 5,123 points,
// 53.9KB. Filling the 177 COUNTRY shapes instead would have stacked 177
// translucent surfaces with a seam on every shared border, and any alpha below 1
// would have doubled along every one of them. One closed surface has no seams to
// have.
//
// THE OCEAN IS NOT PAINTED. It is the page: this component sits on
// app/search.tsx's own #050505 root, so the sea is simply what is already there
// and the fill below is the only colour the map adds.
//
// #121212 IS THIRTEEN LEVELS ABOVE THE PAGE, a contrast ratio of 1.088:1. The
// first attempt was #0c0c0c at 1.042:1, which is below the threshold of
// visibility on anything but an OLED panel in a dark room — a separation that
// only some viewers can see is not a separation. This is still deliberately
// faint: it is a SEPARATION rather than a colour, and the brief was that this
// must still read as Terminal. No blue, no green, no map palette; land is the
// same neutral as everything else, lifted just enough to become a surface.
const LAND_FILL = '#121212';

const COUNTRY_STROKE = 'rgba(255,255,255,0.18)';
const COUNTRY_WIDTH = 1;
const STATE_STROKE = 'rgba(255,255,255,0.07)';
const STATE_WIDTH = 0.75;

// ── WHEN THE STATES APPEAR ───────────────────────────────────────────────────
//
// THE STATED REASON DOES NOT HOLD, and the measurement is worth keeping rather
// than quietly substituting another one. State outlines do NOT stop being
// legible anywhere in this camera's range: the median state's smaller dimension
// is 37px at 5,000km, 62px at 3,000km and 187px at 1,000km, and even the
// smallest decile is 11px at the widest camera. On size alone there is no
// threshold to find.
//
// THE REASON THAT DOES HOLD IS COVERAGE. This file has states for NINE
// countries. At 5,000km the frame holds 72 of them and six have any internal
// detail at all, so the layer draws provinces across India, China and Russia and
// leaves everything between them blank — which reads as data missing rather than
// as a layer. It is only coherent once the frame is mostly a country that HAS
// states, and that is what the threshold is for.
//
// AND IT IS WHAT PAID FOR THE MARGIN ABOVE. States are 80% of the build: with
// them gone the widest camera went from 22.5ms to 5.9ms, which is what let
// CULL_MARGIN go from 0.25 to 1.0 and still come in under budget.
//
// A BAND RATHER THAN A LINE, so the layer arrives rather than appearing.
const STATES_FULL_KM = 1800;
const STATES_GONE_KM = 2200;

// ── THE TWO CLASSES OF NAME ──────────────────────────────────────────────────
//
// THEY WERE TOO ALIKE: 11 and 8.5, one regular weight, two alphas a fifth apart.
// At a glance that is one list of names in two sizes rather than two kinds of
// thing.
//
// A COUNTRY IS THE SUBJECT. Semibold, 13, and close to full ink — it should be
// the first thing read on the map and the last thing to go.
//
// A STATE IS AN ANNOTATION ON ONE. Regular, 8, a third of the ink, UPPERCASE
// with a point and a fifth of tracking. The case change is what does most of the
// work: it separates the two classes by SHAPE rather than by degree, so a state
// name never reads as a small country name — and tracking is what stops small
// caps closing up into a block. This is the same device app/index.tsx uses for
// its section headings, at the same 1-ish tracking.
//
// INTER FOR BOTH. These are place names, not machine data; nothing here is a
// code, a clock or a registration.
const COUNTRY_LABEL_FAMILY = SANS_SEMI;
const COUNTRY_LABEL_FS = 13;
const COUNTRY_LABEL_INK = 'rgba(226,226,226,0.72)';
const STATE_LABEL_FAMILY = SANS;
const STATE_LABEL_FS = 8;
const STATE_LABEL_INK = 'rgba(226,226,226,0.34)';
const STATE_LABEL_LS = 1.2;
// UPPERCASE INTER, so caps rather than the 0.52 a mixed-case average gives.
// Proportional, so this is an estimate, and it is used for one decision only:
// whether a state is wide enough to hold its own name. The tracking is added per
// character because it is paid per character.
const LABEL_ADV_CAPS = 0.6;

// ── MERCATOR, BY HAND ────────────────────────────────────────────────────────
//
// d3 cannot be called from a worklet, so the two lines of forward and inverse
// mercator are written out. They are the SAME functions d3 uses — y = ln(tan(pi/4
// + phi/2)) and its inverse — so the transform the finger draws and the
// projection the settle builds cannot disagree.
const DEG = Math.PI / 180;
function mercY(latDeg: number) {
  'worklet';
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));
}
function invMercY(y: number) {
  'worklet';
  return (2 * (Math.atan(Math.exp(y)) - Math.PI / 4)) / DEG;
}
// k for a given span at a given latitude, and its inverse. One relationship,
// spelled once, used by the initial camera and by both ends of the zoom clamp.
function kForSpan(widthPx: number, latDeg: number, spanKm: number) {
  'worklet';
  return (widthPx * EARTH_R_KM * Math.cos(latDeg * DEG)) / spanKm;
}

// ── DECODE, ONCE, AT MODULE SCOPE ────────────────────────────────────────────
const tReq0 = performance.now();
const COUNTRIES_TOPO: any = COUNTRY_RES === '110m'
  ? require('world-atlas/countries-110m.json')
  : require('world-atlas/countries-50m.json');
const tReqCountries = performance.now() - tReq0;

const tReq1 = performance.now();
const STATES_TOPO: any = require('../assets/map/states-50m.json');
const tReqStates = performance.now() - tReq1;

const tReq2 = performance.now();
const LAND_TOPO: any = require('world-atlas/land-110m.json');
const tReqLand = performance.now() - tReq2;

// THE UNIT MERCATOR PLANE, AND IT IS WHAT MAKES THE LABELS FREE.
//
// The camera's projection is an AFFINE map of this one: with the same raw
// projection underneath, P(p) = k * (P1(p) - P1(centre)) + viewport centre. A
// centroid and a bounding box both commute with an affine map — an area-weighted
// centroid because affine maps preserve area RATIOS, a bbox because scale and
// translate are monotone per axis.
//
// SO BOTH ARE PROPERTIES OF THE SHAPE RATHER THAN OF THE CAMERA, and both can be
// computed once here. The label pass then projects ONE POINT per feature instead
// of walking every coordinate twice more.
//
// AND IT IS EXACT, not an approximation. This is the same number path.centroid
// would return under the live projection, reached by the identity above rather
// than by re-deriving it — so no label moves by so much as a pixel.
const UNIT = geoMercator().scale(1).translate([0, 0]);
const UNIT_PATH = geoPath(UNIT);

// THE GEOGRAPHIC BBOX, AND IT IS ALL THE VISIBILITY FILTER READS. Split out
// because the land layer carries nothing else: a landmass has no name and takes
// no label, so it has no use for the centroid or the width below.
type Box = { w: number; s: number; e: number; n: number; wraps: boolean };

// A FEATURE PLUS EVERYTHING ABOUT IT THAT DOES NOT DEPEND ON THE CAMERA.
// geoBounds and the two unit-plane measurements all walk every coordinate, so
// all three are paid once here rather than per camera.
type Cell = Box & {
  f: any; name: string;
  // Unit-mercator centroid, and the unit-mercator width of the bbox.
  mcx: number; mcy: number; mbw: number;
};

// A LANDMASS. The fill is opaque and unlabelled, so the bbox is the whole of it.
type LandCell = Box & { f: any };

function prepare(topo: any, objectName: string): Cell[] {
  const fc: any = feature(topo, topo.objects[objectName]);
  const out: Cell[] = [];
  for (const f of fc.features) {
    const b = geoBounds(f);
    const c = UNIT_PATH.centroid(f);
    const ub = UNIT_PATH.bounds(f);
    // A feature crossing the antimeridian comes back with west > east. There are
    // two of them and they are marked rather than reasoned about: `wraps` skips
    // the longitude test entirely, so such a feature is always projected.
    out.push({
      f,
      name: f.properties?.name ?? '',
      w: b[0][0], s: b[0][1], e: b[1][0], n: b[1][1],
      wraps: b[0][0] > b[1][0],
      mcx: c[0], mcy: c[1],
      mbw: ub[1][0] - ub[0][0],
    });
  }
  return out;
}

// ONE FEATURE PER LANDMASS, SO THE LAND CAN BE CULLED LIKE EVERYTHING ELSE.
//
// land-110m ships as ONE feature whose geometry is a MultiPolygon of every
// landmass on earth, and one feature has one bbox: the whole world. Nothing
// could ever be rejected, so every camera change projected all 125 landmasses
// and let d3's clip throw away the ones off screen — exactly the bug the country
// layer had before its bbox filter, surviving here only because this layer
// arrived later and inherited none of the fix.
//
// SPLITTING IT CHANGES NO PIXEL. The landmasses are separated by ocean and do
// not overlap, so filling them as 125 paths paints precisely what filling them
// as one path painted. The fill is opaque, so there is no alpha to double even
// if two did touch. What changes is only how many are handed to the projection.
function prepareLand(topo: any, objectName: string): LandCell[] {
  const fc: any = feature(topo, topo.objects[objectName]);
  const out: LandCell[] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    for (const coordinates of polys) {
      const g: any = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } };
      const b = geoBounds(g);
      out.push({
        f: g,
        w: b[0][0], s: b[0][1], e: b[1][0], n: b[1][1],
        wraps: b[0][0] > b[1][0],
      });
    }
  }
  return out;
}

const tPrep0 = performance.now();
const COUNTRY_CELLS = prepare(COUNTRIES_TOPO, 'countries');
const STATE_CELLS = prepare(STATES_TOPO, 'states');
const LAND_CELLS = prepareLand(LAND_TOPO, 'land');
const tPrep = performance.now() - tPrep0;

console.log(
  `[MAP] decode countries(${COUNTRY_RES}) ${tReqCountries.toFixed(1)}ms`
  + ` states ${tReqStates.toFixed(1)}ms land ${tReqLand.toFixed(1)}ms`
  + ` | feature+geoBounds ${tPrep.toFixed(1)}ms`
  + ` | ${COUNTRY_CELLS.length} countries, ${STATE_CELLS.length} states`
  + `, ${LAND_CELLS.length} landmasses`,
);

type Label = {
  x: number; y: number; text: string;
  fs: number; ink: string; family: string; ls: number; op: number;
};

type Built = {
  land: string[];
  countries: string[];
  states: string[];
  stateOpacity: number;
  labels: Label[];
  stats: string;
};

export default function WorldMap() {
  const { width, height } = useWindowDimensions();

  const [camera, setCamera] = useState<Camera>(() => ({
    lon: START_CENTRE[0],
    lat: START_CENTRE[1],
    k: kForSpan(402, START_CENTRE[1], START_SPAN_KM),
  }));

  // THE LIVE CAMERA, ON THE UI THREAD. The gesture writes this and nothing else;
  // it is the same three numbers as `camera` and is seeded from it. Three plain
  // shared values rather than one object, because Reanimated compares object
  // identity and three numbers cannot be partially written.
  const liveLon = useSharedValue(camera.lon);
  const liveLat = useSharedValue(camera.lat);
  const liveK = useSharedValue(camera.k);
  // Where the camera stood when the finger landed. The pinch anchors to these
  // rather than to the running values, so a scale and a drag compose instead of
  // feeding each other.
  const startLon = useSharedValue(0);
  const startLat = useSharedValue(0);
  const startK = useSharedValue(0);
  const anchorMx = useSharedValue(0);
  const anchorMy = useSharedValue(0);
  const anchorFx = useSharedValue(0);
  const anchorFy = useSharedValue(0);

  // The committed camera, mirrored for the clamps. A frame of staleness here
  // cannot matter: it bounds a gesture that has not finished.
  useEffect(() => {
    liveLon.value = camera.lon;
    liveLat.value = camera.lat;
    liveK.value = camera.k;
  }, [camera, liveLon, liveLat, liveK]);

  // ── THE GEOMETRY, BUILT ONLY WHEN THE CAMERA CHANGES ───────────────────────
  //
  // The dependency list is the camera and the viewport and nothing else. Every
  // other reason app/search.tsx re-renders — a keystroke, the minute tick, a
  // result arriving — returns this same object untouched.
  const built = useMemo<Built>(() => {
    const t0 = performance.now();
    // THE SPAN THIS CAMERA ACTUALLY SHOWS, at its own latitude, and the states'
    // opacity from it. At 0 they are not built at all, which is where the widest
    // camera's saving comes from — the gate is a cost decision as much as a
    // drawing one.
    const spanKm = (width * EARTH_R_KM * Math.cos(camera.lat * DEG)) / camera.k;
    const stateOpacity = spanKm <= STATES_FULL_KM ? 1
      : spanKm >= STATES_GONE_KM ? 0
        : (STATES_GONE_KM - spanKm) / (STATES_GONE_KM - STATES_FULL_KM);
    const projection = geoMercator()
      .center([camera.lon, camera.lat])
      .scale(camera.k)
      .translate([width / 2, height / 2]);
    const path = geoPath(projection);

    // THE CAMERA'S OWN WINDOW, in degrees, from k alone. Half the viewport in
    // pixels is half of it in radians once divided by k, which is what makes
    // this exact rather than a guess at what might be visible.
    const halfLon = ((width / 2) / camera.k) / DEG;
    const halfMy = (height / 2) / camera.k;
    const myC = mercY(camera.lat);
    const w = camera.lon - halfLon * (1 + CULL_MARGIN);
    const e = camera.lon + halfLon * (1 + CULL_MARGIN);
    const s = invMercY(myC - halfMy * (1 + CULL_MARGIN));
    const n = invMercY(myC + halfMy * (1 + CULL_MARGIN));

    const visible = (c: Box) =>
      c.n >= s && c.s <= n && (c.wraps || (c.e >= w && c.w <= e));

    // THE FILL FIRST, and only the landmasses that can be seen — see the note at
    // prepareLand for why this is one path per landmass rather than one path.
    const tLand0 = performance.now();
    const land: string[] = [];
    let landKept = 0;
    for (const c of LAND_CELLS) {
      if (!visible(c)) continue;
      landKept++;
      const d = path(c.f);
      if (d) land.push(d);
    }
    const tLand = performance.now() - tLand0;

    const countries: string[] = [];
    let countryKept = 0;
    for (const c of COUNTRY_CELLS) {
      if (!visible(c)) continue;
      countryKept++;
      const d = path(c.f);
      if (d) countries.push(d);
    }

    const states: string[] = [];
    let stateKept = 0;
    if (stateOpacity > 0) {
      for (const c of STATE_CELLS) {
        if (!visible(c)) continue;
        stateKept++;
        const d = path(c.f);
        if (d) states.push(d);
      }
    }

    // ── LABELS ───────────────────────────────────────────────────────────────
    //
    // AT THE PROJECTED CENTROID, which d3 takes on the projected geometry rather
    // than on the sphere — so it is the centre of the shape as drawn.
    //
    // ON SCREEN OR NOT AT ALL. There is no edge-anchoring and nothing is pushed
    // inwards; a centroid outside the viewport produces no label.
    //
    // "WHERE THEY FIT" IS A TEST ON THE SHAPE'S OWN WIDTH and only states take
    // it: the projected bounding box has to be wider than the name would be, or
    // the name is dropped. That is what stops Goa and Sikkim carrying words
    // several times their own size. Countries are not tested — at these cameras
    // the ones on screen are large, and a country name is the layer that has to
    // survive.
    //
    // COLLISIONS ARE STILL NOT RESOLVED. Nothing here knows about any other
    // label: two names whose centroids are close overlap, and the later one in
    // feature order paints on top. No displacement, no priority, no hiding.
    //
    // ONE POINT PROJECTED PER FEATURE, and no geometry walked. `origin` is the
    // camera centre in the unit plane, and everything below is the affine
    // identity from the note at UNIT: screen = k * (unit - origin) + centre.
    const labels: Label[] = [];
    const onScreen = (x: number, y: number) => x >= 0 && x <= width && y >= 0 && y <= height;
    const origin = UNIT([camera.lon, camera.lat]) as [number, number];
    const toScreen = (mcx: number, mcy: number): [number, number] => [
      camera.k * (mcx - origin[0]) + width / 2,
      camera.k * (mcy - origin[1]) + height / 2,
    ];
    for (const c of COUNTRY_CELLS) {
      if (!visible(c)) continue;
      const [x, y] = toScreen(c.mcx, c.mcy);
      if (!Number.isFinite(x) || !onScreen(x, y)) continue;
      labels.push({
        x, y, text: c.name,
        fs: COUNTRY_LABEL_FS, ink: COUNTRY_LABEL_INK,
        family: COUNTRY_LABEL_FAMILY, ls: 0, op: 1,
      });
    }
    if (stateOpacity > 0) {
      for (const c of STATE_CELLS) {
        if (!visible(c)) continue;
        const [x, y] = toScreen(c.mcx, c.mcy);
        if (!Number.isFinite(x) || !onScreen(x, y)) continue;
        // The bbox's projected width is k times its unit-plane width, by the
        // same identity. No second walk of the geometry. The estimate is of the
        // UPPERCASE name plus its tracking, because that is what will be drawn.
        const est = c.name.length * (STATE_LABEL_FS * LABEL_ADV_CAPS + STATE_LABEL_LS);
        if (camera.k * c.mbw < est) continue;
        labels.push({
          x, y, text: c.name.toUpperCase(),
          fs: STATE_LABEL_FS, ink: STATE_LABEL_INK,
          family: STATE_LABEL_FAMILY, ls: STATE_LABEL_LS, op: stateOpacity,
        });
      }
    }

    const ms = performance.now() - t0;
    const span = spanKm;
    return {
      land,
      countries,
      states,
      stateOpacity,
      labels,
      stats: `[MAP] build ${ms.toFixed(1)}ms (land ${tLand.toFixed(1)}ms)`
        + ` | span ${span.toFixed(0)}km`
        + ` | stateOpacity ${stateOpacity.toFixed(2)}`
        + ` | land ${landKept}/${LAND_CELLS.length} kept, ${land.length} drawn`
        + ` | countries ${countryKept}/${COUNTRY_CELLS.length} kept, ${countries.length} drawn`
        + ` | states ${stateKept}/${STATE_CELLS.length} kept, ${states.length} drawn`
        + ` | labels ${labels.length}`,
    };
  }, [camera, width, height]);

  console.log(built.stats);

  // ── THE TRANSFORM ────────────────────────────────────────────────────────
  //
  // Derived from the LIVE camera against the COMMITTED one, which is what makes
  // the settle seamless: `camera` is captured in this worklet's closure, so when
  // it changes the worklet is rebuilt and re-evaluated in the same commit as the
  // geometry it describes. At that moment live and committed are equal and the
  // transform is exactly the identity. Nothing is reset and there is no frame in
  // which the two disagree.
  //
  // SCALE ABOUT THE VIEW'S CENTRE, then translate — which is the order React
  // Native applies a transform list in, and the order the algebra below assumes:
  //
  //     screen_live = s * (screen_committed - centre) + centre + t
  //     s  = kLive / kCommitted
  //     tx = kLive * (mxCommitted - mxLive)
  //     ty = kLive * (myLive - myCommitted)
  const mapStyle = useAnimatedStyle(() => {
    const s = liveK.value / camera.k;
    const tx = liveK.value * ((camera.lon - liveLon.value) * DEG);
    const ty = liveK.value * (mercY(liveLat.value) - mercY(camera.lat));
    return { transform: [{ translateX: tx }, { translateY: ty }, { scale: s }] };
  });

  const commit = (lon: number, lat: number, k: number) => {
    setCamera({ lon, lat, k });
  };

  // ── PAN ────────────────────────────────────────────────────────────────────
  //
  // NO RETURN IN ANY CALLBACK, and no condition on the gesture's configuration.
  // The clamps are conditions on VALUES, applied where the value is computed.
  const pan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      startLon.value = liveLon.value;
      startLat.value = liveLat.value;
      startK.value = liveK.value;
    })
    .onUpdate((e) => {
      'worklet';
      const k = liveK.value;
      // A drag right moves the content right, which is to look further west.
      const lon = startLon.value - (e.translationX / k) / DEG;
      const my = mercY(startLat.value) + e.translationY / k;
      const lat = invMercY(my);
      liveLon.value = lon < -LON_LIMIT ? -LON_LIMIT : lon > LON_LIMIT ? LON_LIMIT : lon;
      liveLat.value = lat < -LAT_LIMIT ? -LAT_LIMIT : lat > LAT_LIMIT ? LAT_LIMIT : lat;
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commit)(liveLon.value, liveLat.value, liveK.value);
    });

  // ── PINCH ──────────────────────────────────────────────────────────────────
  //
  // ZOOM ABOUT THE POINT THE FINGERS LANDED ON, and only zoom: the focal is
  // frozen at onStart so a two-finger drag is left to the pan running beside it
  // rather than being counted twice.
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      startK.value = liveK.value;
      anchorFx.value = e.focalX;
      anchorFy.value = e.focalY;
      // The geography under the focal, in mercator, at the moment of the touch.
      anchorMx.value = liveLon.value * DEG + (e.focalX - width / 2) / liveK.value;
      anchorMy.value = mercY(liveLat.value) - (e.focalY - height / 2) / liveK.value;
    })
    .onUpdate((e) => {
      'worklet';
      const kMin = kForSpan(width, liveLat.value, MAX_SPAN_KM);
      const kMax = kForSpan(width, liveLat.value, MIN_SPAN_KM);
      const raw = startK.value * e.scale;
      const k = raw < kMin ? kMin : raw > kMax ? kMax : raw;
      liveK.value = k;
      // Put the anchored geography back under the focal at the new scale.
      const lon = (anchorMx.value - (anchorFx.value - width / 2) / k) / DEG;
      const lat = invMercY(anchorMy.value + (anchorFy.value - height / 2) / k);
      liveLon.value = lon < -LON_LIMIT ? -LON_LIMIT : lon > LON_LIMIT ? LON_LIMIT : lon;
      liveLat.value = lat < -LAT_LIMIT ? -LAT_LIMIT : lat > LAT_LIMIT ? LAT_LIMIT : lat;
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commit)(liveLon.value, liveLat.value, liveK.value);
    });

  // BOTH AT ONCE. A pinch that drifts is a pinch and a pan, and the two write
  // different halves of the same camera: the pinch owns k and the anchor, the
  // pan owns the translation from its own start.
  const gesture = Gesture.Simultaneous(pan, pinch);

  return (
    <GestureDetector gesture={gesture}>
      <View style={StyleSheet.absoluteFill}>
        <Reanimated.View style={[StyleSheet.absoluteFill, mapStyle]}>
          <Svg width={width} height={height}>
            {/* LAND FIRST, AND IT IS THE ONLY FILL ON THE MAP. Everything below
                is a stroke drawn over it. The ocean is not painted at all — it
                is app/search.tsx's own root showing through, which is why the
                two cannot drift apart. */}
            {built.land.map((d, i) => (
              <Path key={`L${i}`} d={d} fill={LAND_FILL} stroke="none" />
            ))}
            {/* STATES NEXT, so the country lines paint over them where the two
                coincide: a national border is also a state border, and the
                heavier line should win that pixel. */}
            {built.states.map((d, i) => (
              <Path
                key={`s${i}`}
                d={d}
                fill="none"
                stroke={STATE_STROKE}
                strokeWidth={STATE_WIDTH}
                strokeOpacity={built.stateOpacity}
              />
            ))}
            {built.countries.map((d, i) => (
              <Path key={`c${i}`} d={d} fill="none" stroke={COUNTRY_STROKE} strokeWidth={COUNTRY_WIDTH} />
            ))}
            {built.labels.map((l, i) => (
              <SvgText
                key={`l${i}`}
                x={l.x}
                y={l.y}
                fill={l.ink}
                fontSize={l.fs}
                fontFamily={l.family}
                letterSpacing={l.ls}
                opacity={l.op}
                textAnchor="middle"
              >
                {l.text}
              </SvgText>
            ))}
          </Svg>
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}
