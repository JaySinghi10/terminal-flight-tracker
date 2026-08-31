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

// HOW MUCH MORE THAN THE SCREEN IS KEPT, as a fraction of the window either
// side. It is not an optimisation dial: a feature whose bbox misses the viewport
// by a point still has EDGES crossing it, and a margin is what stops a coastline
// vanishing when its centroid leaves. 0.25 is generous at a cost of a handful of
// extra features.
const CULL_MARGIN = 0.25;

// ── THE INK ──────────────────────────────────────────────────────────────────
//
// TWO WEIGHTS, and the gap between them is the point: a country line has to read
// above a state line at a glance, and on a #050505 ground the only levers a
// hairline has are alpha and width. NO GREEN — that is the app's live-and-
// actionable colour and nothing here is either yet.
const COUNTRY_STROKE = 'rgba(255,255,255,0.18)';
const COUNTRY_WIDTH = 1;
const STATE_STROKE = 'rgba(255,255,255,0.07)';
const STATE_WIDTH = 0.75;
const COUNTRY_LABEL_INK = 'rgba(226,226,226,0.5)';
const COUNTRY_LABEL_FS = 11;
const STATE_LABEL_INK = 'rgba(226,226,226,0.3)';
const STATE_LABEL_FS = 8.5;
// Inter is proportional, so this is an estimate and is used for one decision
// only: whether a state is wide enough to hold its own name.
const LABEL_ADV_EM = 0.52;

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

// A FEATURE PLUS EVERYTHING ABOUT IT THAT DOES NOT DEPEND ON THE CAMERA.
// geoBounds and the two unit-plane measurements all walk every coordinate, so
// all three are paid once here rather than per camera.
type Cell = {
  f: any; name: string;
  // Geographic bbox, for the visibility filter.
  w: number; s: number; e: number; n: number; wraps: boolean;
  // Unit-mercator centroid, and the unit-mercator width of the bbox.
  mcx: number; mcy: number; mbw: number;
};

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

const tPrep0 = performance.now();
const COUNTRY_CELLS = prepare(COUNTRIES_TOPO, 'countries');
const STATE_CELLS = prepare(STATES_TOPO, 'states');
const tPrep = performance.now() - tPrep0;

console.log(
  `[MAP] decode countries(${COUNTRY_RES}) ${tReqCountries.toFixed(1)}ms`
  + ` states ${tReqStates.toFixed(1)}ms`
  + ` | feature+geoBounds ${tPrep.toFixed(1)}ms`
  + ` | ${COUNTRY_CELLS.length} countries, ${STATE_CELLS.length} states`,
);

type Built = {
  countries: string[];
  states: string[];
  labels: { x: number; y: number; name: string; fs: number; ink: string }[];
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

    const visible = (c: Cell) =>
      c.n >= s && c.s <= n && (c.wraps || (c.e >= w && c.w <= e));

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
    for (const c of STATE_CELLS) {
      if (!visible(c)) continue;
      stateKept++;
      const d = path(c.f);
      if (d) states.push(d);
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
    const labels: Built['labels'] = [];
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
      labels.push({ x, y, name: c.name, fs: COUNTRY_LABEL_FS, ink: COUNTRY_LABEL_INK });
    }
    for (const c of STATE_CELLS) {
      if (!visible(c)) continue;
      const [x, y] = toScreen(c.mcx, c.mcy);
      if (!Number.isFinite(x) || !onScreen(x, y)) continue;
      // The bbox's projected width is k times its unit-plane width, by the same
      // identity. No second walk of the geometry.
      if (camera.k * c.mbw < c.name.length * STATE_LABEL_FS * LABEL_ADV_EM) continue;
      labels.push({ x, y, name: c.name, fs: STATE_LABEL_FS, ink: STATE_LABEL_INK });
    }

    const ms = performance.now() - t0;
    const span = (width * EARTH_R_KM * Math.cos(camera.lat * DEG)) / camera.k;
    return {
      countries,
      states,
      labels,
      stats: `[MAP] build ${ms.toFixed(1)}ms | span ${span.toFixed(0)}km`
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
            {/* STATES FIRST, so the country lines paint over them where the two
                coincide: a national border is also a state border, and the
                heavier line should win that pixel. */}
            {built.states.map((d, i) => (
              <Path key={`s${i}`} d={d} fill="none" stroke={STATE_STROKE} strokeWidth={STATE_WIDTH} />
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
                fontFamily={SANS}
                textAnchor="middle"
              >
                {l.name}
              </SvgText>
            ))}
          </Svg>
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}
