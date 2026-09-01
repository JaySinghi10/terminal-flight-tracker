// THE MAP: MAPLIBRE GL JS ON A GLOBE, INSIDE A WEBVIEW.
//
// WHAT REPLACED WHAT. This is the successor to components/WorldMap.tsx, which
// drew the world as SVG paths projected in JavaScript. That approach worked and
// was fast to build, but it ended up trading one cost against another with no
// good answer: geometry culled per camera meant a rebuild on every settle, and
// geometry mounted permanently meant react-native-svg re-rasterising the whole
// canvas every frame. Neither is a problem a tile renderer has, because a tile
// renderer keeps the scene on the GPU and the camera is a matrix.
//
// WHAT WENT WITH IT: d3-geo, topojson-client, world-atlas, topojson-server and
// assets/map/states-50m.json. Nothing else imported any of them.
//
// THE COST IS THE NETWORK. The SVG map shipped its geometry in the bundle and
// worked offline; this one fetches vector tiles, so the first paint depends on
// the connection and there is no map at all without one. That is the trade.
//
// ── WHY A WEBVIEW ───────────────────────────────────────────────────────────
//
// MapLibre's native bindings are not in Expo Go, and adding them means a custom
// dev client. MapLibre GL JS in a WebView needs neither: it is WebGL on a canvas
// with its own gesture handling, and the whole map is one native view.
//
// THE BRIDGE IS ONE-WAY FOR NOW. The page posts errors out; nothing is sent in.
// The camera fly, the city heading and the route arc are deliberately NOT ported
// yet.
import { useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { allAirports, airportByCode } from '../lib/airports';
import {
  timezoneHome, HOME_ZOOM_POSITION, HOME_ZOOM_FALLBACK, HOME_ZOOM_MAX,
  type HomeView,
} from '../lib/home';

// ── THE INK ─────────────────────────────────────────────────────────────────
//
// THE SAME PALETTE THE REST OF THE APP USES, so the map is a surface of this app
// rather than a map someone embedded in it. #050505 is the page, which is also
// the sea; #121212 is land, thirteen levels above it and deliberately at the
// edge of visible. No blue, no green, no map palette — green is reserved for
// live and actionable, which here is exactly one thing: an airport.
const OCEAN = '#050505';
const LAND = '#121212';
const COUNTRY_LINE = 'rgba(255,255,255,0.20)';
const ADMIN1_LINE = 'rgba(255,255,255,0.07)';
// The road inks are not here: they are a six-step ramp and belong beside the
// hierarchy they express. See ROAD_TIERS.
const LABEL_COUNTRY = 'rgba(226,226,226,0.72)';
const LABEL_CITY = 'rgba(226,226,226,0.42)';
const LABEL_HALO = '#050505';
const AIRPORT_INK = '#4ade80';

// PINNED, AND DELIBERATELY 5.x RATHER THAN 6.x.
//
// 6.4.0 DID NOT WORK AND THE REASON IS STRUCTURAL. maplibre-gl 6.x ships no UMD
// build at all — dist/maplibre-gl.js is a 404 and dist/maplibre-gl.mjs is the
// only entry — so the page had to use <script type="module"> with a dynamic
// import. On device that produced "undefined is not an object (evaluating 'new
// maplibregl.Map')": the import resolved to something without a usable default.
//
// 5.24.0 IS THE NEWEST 5.x AND IT SHIPS A REAL UMD BUILD, verified: the wrapper
// ends `global.maplibregl = factory()`, so a plain <script src> puts the
// namespace on window with no module semantics involved at all. Globe arrived in
// 5.0.0 and everything this file needs is present in 5.24.0 — setProjection,
// setSky, atmosphere-blend, sky-horizon-blend all verified in the bundle.
//
// WHAT THAT REMOVES: module CORS under the synthesised baseUrl origin, top-level
// await support, and the namespace-shape question. Three failure modes for one
// version number.
const MAPLIBRE = '5.24.0';

// TWO HOSTS, TRIED IN ORDER. If unpkg is unreachable or blocked under the
// synthesised origin, the page falls through to jsdelivr and says which one
// served it, so "the CDN is blocked" and "the library is broken" stop looking
// like the same failure.
const CDNS: [string, string][] = [
  ['unpkg', `https://unpkg.com/maplibre-gl@${MAPLIBRE}/dist/maplibre-gl.js`],
  ['jsdelivr', `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE}/dist/maplibre-gl.js`],
];

// THE VECTOR SOURCE, AND ONLY THE SOURCE. OpenFreeMap serves the OpenMapTiles
// schema; positron is their light stylesheet over it, and none of positron's 55
// layers are used here — see the report. What is taken is the tile endpoint and
// the glyph endpoint, both public and both free.
const OFM_TILES = 'https://tiles.openfreemap.org/planet';
const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
// The one fontstack OpenFreeMap serves that is safe to assume; a missing font
// makes every label silently vanish rather than fall back.
const FONT = ['Noto Sans Regular'];

// ── WHEN THE AIRPORTS APPEAR ────────────────────────────────────────────────
//
// z4.5 TO z6, AND THE NUMBER IS CARRIED OVER RATHER THAN GUESSED. The SVG map
// measured the point where the dots stop being places and become a texture:
// Europe holds 46 airports on screen at a 600km viewport and 430 at 5,000km.
//
// MapLibre zoom is not km, so the conversion is done rather than eyeballed. With
// 512px tiles the viewport spans 402 * 40075 / (512 * 2^z) * cos(lat) km, which
// at 50N is 316km at z6, 632km at z5 and 1,265km at z4. So z5 is the old 600km
// threshold almost exactly, and the band is put around it: nothing below z4.5,
// full ink by z6.
const AIRPORT_MIN_ZOOM = 4.5;
// The invisible tap target, in screen pixels at every zoom. 22 is a 44px
// diameter, the usual floor for something a finger has to hit.
const AIRPORT_HIT_R = 22;
const AIRPORT_FULL_ZOOM = 6;

// ── THE ROAD NETWORK ────────────────────────────────────────────────────────
//
// A TABLE RATHER THAN SIX NEAR-IDENTICAL LAYER OBJECTS, because the hierarchy IS
// the design and it should be readable in one glance. Each row is a class of
// road, the zoom it earns its place at, its ink, and how wide it gets.
//
// EACH CLASS ARRIVES WHERE IT STARTS MEANING SOMETHING, which is the whole
// point of not drawing them all at once. A motorway at z5 is the shape of a
// country's spine; a residential street at z5 is noise on a continent. The
// viewport is roughly 40,000/2^z km across, so z5 is a country, z9 a large
// metro, z13 a district and z16 a street.
//
// THE INK IS NEUTRAL WHITE AT SIX ALPHAS ON #121212 LAND. Alpha rather than six
// mixed greys so the ramp is monotone by construction and cannot drift; a road
// can never be brighter than the class above it because the numbers say so.
//
// AND THEY ALL PAINT UNDER THE BORDERS. The brightest road, a motorway at 0.30,
// is brighter than a country line at 0.20 — which is right at z14 where roads
// are the subject, and wrong at a frontier where the border must still read as
// the stronger fact. Order settles it rather than colour: boundaries are drawn
// after, so they win the shared pixel.
type RoadTier = {
  id: string;
  classes: string[];
  minzoom: number;
  color: string;
  // [zoom, px] stops, interpolated linearly between.
  width: [number, number][];
};

const ROAD_TIERS: RoadTier[] = [
  { id: 'road-minor', classes: ['minor'], minzoom: 13,
    color: 'rgba(255,255,255,0.08)', width: [[13, 0.4], [16, 0.9], [18, 1.8]] },
  { id: 'road-tertiary', classes: ['tertiary'], minzoom: 11,
    color: 'rgba(255,255,255,0.11)', width: [[11, 0.4], [14, 1.0], [18, 2.5]] },
  { id: 'road-secondary', classes: ['secondary'], minzoom: 9,
    color: 'rgba(255,255,255,0.15)', width: [[9, 0.4], [12, 0.9], [15, 1.8], [18, 3.5]] },
  { id: 'road-primary', classes: ['primary'], minzoom: 7,
    color: 'rgba(255,255,255,0.19)', width: [[7, 0.5], [11, 1.0], [14, 2.0], [18, 4.5]] },
  { id: 'road-trunk', classes: ['trunk'], minzoom: 6,
    color: 'rgba(255,255,255,0.24)', width: [[6, 0.5], [10, 1.2], [14, 2.4], [18, 5]] },
  { id: 'road-motorway', classes: ['motorway'], minzoom: 5,
    color: 'rgba(255,255,255,0.30)', width: [[5, 0.5], [10, 1.4], [14, 3.0], [18, 6]] },
];

// ROAD NAMES ARE A CLOSE-ZOOM LUXURY. Below this the labels collide with each
// other and with the city names, and a street name on a map of a country tells
// nobody anything.
const ROAD_LABEL_MIN_ZOOM = 14;
const ROAD_LABEL_INK = 'rgba(226,226,226,0.38)';

// Turns a tier's [zoom, px] table into a MapLibre interpolate expression.
function roadWidth(stops: [number, number][]): unknown[] {
  const out: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (const [z, w] of stops) { out.push(z, w); }
  return out;
}

// ── WHERE IT OPENS ──────────────────────────────────────────────────────────
//
// BAKED INTO THE PAGE, NOT JUMPED TO AFTERWARDS. timezoneHome() is synchronous
// precisely so the opening camera can be part of the HTML the WebView loads,
// which means the map's very first painted frame is already over the user's
// country. Resolving it afterwards would open somewhere arbitrary and visibly
// correct itself.
//
// THE 402x874 VIEWPORT IS ASSUMED HERE and nowhere else. The page is a module
// constant, so it cannot read useWindowDimensions; the error is a fraction of a
// zoom level on an unusual screen, and applyHome re-fits properly against the
// real viewport as soon as the style loads.
const OPENING = timezoneHome();
const OPENING_ZOOM = openingZoom(OPENING);

function openingZoom(h: HomeView): number {
  if (h.kind === 'position') return HOME_ZOOM_POSITION;
  if (h.kind === 'fallback') return HOME_ZOOM_FALLBACK;
  const [w, s, e, n] = h.bbox;
  // The zoom at which a span of degrees exactly fills the viewport. World width
  // at zoom z is 512 * 2^z px covering 360 degrees, so the fit is a log2.
  const dLon = Math.max(e - w, 1e-6);
  const zLon = Math.log2((402 * 360) / (512 * dLon));
  const my = (d: number) => Math.log(Math.tan(Math.PI / 4 + (d * Math.PI / 180) / 2));
  const dMy = Math.max(Math.abs(my(n) - my(s)), 1e-6);
  const zLat = Math.log2((874 * 2 * Math.PI) / (512 * dMy));
  const z = Math.min(zLon, zLat);
  if (!Number.isFinite(z)) return HOME_ZOOM_FALLBACK;
  return Math.max(0, Math.min(z, HOME_ZOOM_MAX));
}

const START_LON = OPENING.lon;
const START_LAT = OPENING.lat;
const START_ZOOM = OPENING_ZOOM;

// ── THE PIN ─────────────────────────────────────────────────────────────────
//
// IT IS NOT AN AIRPORT AND MUST NOT LOOK LIKE ONE. The airports are flat green
// discs, and green in this app means live and actionable. The user's position is
// neither — it is a fact about the view — so it differs in COLOUR and in
// STRUCTURE, not just in size:
//
//   a wide, barely-there white halo   the accuracy idiom every map user knows
//   a small white disc inside it      the point itself
//   a dark ring around the disc       so it holds against pale land and labels
//
// Two marks rather than one is what makes it read as a position rather than as
// a large airport. Nothing else on this map has a halo.
const PIN_INK = '#e2e2e2';
const PIN_HALO = 'rgba(255,255,255,0.07)';
const PIN_RING = '#050505';

// ── THE TWO CAMERA MOTIONS ──────────────────────────────────────────────────
//
// SINGLE AIRPORT: pull out to the whole globe, turn until the target faces the
// viewer, come down onto it. ONE flyTo AND NOT THREE CHAINED ANIMATIONS, and
// that is a correctness requirement rather than a style preference — see the
// note at onGrab for why chaining would survive an interruption.
//
// flyTo ALREADY FLIES THAT SHAPE. Its Van Wijk path arcs out and back in on its
// own; what it does not do by default is arc out far enough to show the whole
// planet. minZoom is the apex of the flight, and passing it makes MapLibre
// derive the path curvature from the apex instead of from the default curve —
// verified in handleFlyTo, where scaleOfMinZoom overwrites rho. 0 is the whole
// globe, and MapLibre clamps the apex to be no closer than the start or end
// zoom, so a short hop does not perversely fly outward.
const AIRPORT_ZOOM = 9;
const GLOBE_APEX_ZOOM = 0;
const AIRPORT_FLY_MS = 3000;

// ── WHEN THE PULL-BACK IS EARNED ────────────────────────────────────────────
//
// 1,500km, AND THE NUMBER COMES FROM WHAT THE MOTION IS FOR. Rising to the whole
// globe and turning it says "the world is bigger than this screen and we are
// crossing it". Delhi to Mumbai is 1,150km — a domestic hop where that sentence
// is false, and the animation reads as three seconds of theatre for a move you
// could have made by dragging. Delhi to Dubai is 2,200km and genuinely is a
// crossing.
//
// 1,500 SITS IN THE GAP between those two cases rather than on top of either, so
// neither is decided by a rounding error. Below it the camera simply goes, at
// half the duration: a short move should not take as long as a long one.
//
// THE ROUTE ARC IS NOT SUBJECT TO THIS. Travelling the great circle IS the
// motion there, whatever the distance — see flyRoute, which is untouched.
const AIRPORT_PULLBACK_KM = 1500;
const AIRPORT_NEAR_MS = 1400;
// The ceiling on a direct airport flight. Delhi to New York is 11,700km, which
// would otherwise run to 2.6s; this holds the longest move to roughly what the
// pull-back used to cost without the pull-back's theatre.
const AIRPORT_FAR_MS = 2400;

// ROUTE: follow the great circle from origin to destination.
//
// NOT flyTo, BECAUSE flyTo DOES NOT GO THAT WAY. Its path is a straight line in
// projected Mercator space, which on a globe is not the route an aircraft takes
// — the whole point of the motion is that the camera travels the arc. So this
// one is driven frame by frame from a spherical interpolation.
//
// THE DURATION AND THE PULL-BACK BOTH SCALE WITH THE ANGLE, so Delhi to Mumbai
// is a short low skim and Delhi to New York is a long high one, from the same
// code and without a special case.
const ROUTE_END_ZOOM = 5;
const ROUTE_PULLBACK = 3;
const ROUTE_MS_MIN = 2500;
const ROUTE_MS_MAX = 6000;

// GOING HOME IS SHORTER THAN FLYING TO AN AIRPORT, because it is a return rather
// than an arrival: the user pressed it to get back, not to be shown something.
const HOME_FLY_MS = 1600;

type Feat = {
  type: 'Feature';
  properties: { iata: string };
  geometry: { type: 'Point'; coordinates: [number, number] };
};

// EVERY AIRPORT, BUILT ONCE AT MODULE SCOPE. Rebuilding it per render would put
// a new HTML string into the WebView, and a new HTML string reloads the page —
// which would reset the camera on every keystroke typed into the tab bar.
//
// FOUR DECIMAL PLACES is about 11 metres, far finer than a dot 3px wide will
// ever show, and it takes roughly a third off the embedded JSON.
const AIRPORT_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: allAirports().map((a): Feat => ({
    type: 'Feature',
    properties: { iata: a.iata },
    geometry: {
      type: 'Point',
      coordinates: [Math.round(a.lon * 1e4) / 1e4, Math.round(a.lat * 1e4) / 1e4],
    },
  })),
});

// ── THE STYLE ───────────────────────────────────────────────────────────────
//
// AUTHORED, NOT INHERITED. Every layer below is written here; positron is not
// fetched, not extended and not stripped. Starting from a light stylesheet and
// deleting from it would leave 55 layers' worth of decisions in place to be
// discovered later — the roads would be gone but their casings, shields and
// bridge variants would still be there to trip over.
//
// SEVEN LAYERS, and the list is the whole design: sea, land, two weights of
// border, one road class, two classes of name, and the airports.
const STYLE = {
  version: 8,
  name: 'Terminal',
  glyphs: OFM_GLYPHS,
  sources: {
    ofm: { type: 'vector', url: OFM_TILES },
    airports: { type: 'geojson', data: '__AIRPORTS__' },
    // EMPTY UNTIL THERE IS A POSITION. Declaring it in the style rather than
    // adding the source later means the layers exist from the first frame and
    // the pin appears by setting data, with no addLayer at runtime and no
    // question about paint order.
    pin: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    // THE AIRPORTS THIS USER HAS ACTUALLY FLOWN THROUGH. Empty until React
    // Native reads the saved flights and sends them; declared here for the same
    // reason the pin is — the layer exists from the first frame, paint order is
    // fixed, and marking one is a setData rather than an addLayer at runtime.
    //
    // A SECOND SOURCE RATHER THAN A FLAG ON THE FIRST. The airports source is
    // 1,223 features baked into the page as a constant; adding a `visited`
    // property would mean rebuilding and re-sending all of it every time a
    // flight is saved. This one carries only the handful that have been visited.
    visited: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  // ── THE SKY CONTRIBUTES NOTHING, ON PURPOSE ───────────────────────────────
  //
  // atmosphere-blend IS THE MASTER OPACITY of the whole atmosphere pass. At 0
  // nothing from this block is drawn — not the sky colour, not the fog and not
  // the horizon — so every other sky property would be dead configuration. They
  // are deleted rather than left at plausible-looking values, because a value
  // that does nothing is worse than an absent one: it invites a later change
  // that has no effect and cannot be debugged.
  //
  // WHAT WAS HERE: sky-color #050505, horizon-color #262626, fog-color #050505,
  // and the three blend factors, with atmosphere-blend interpolating 0.5 at z0
  // down to 0 at z5.5. That produced a grey rim that read as a colour on an
  // otherwise black globe.
  //
  // AND THERE IS NO REPLACEMENT. A drawn hairline on the silhouette was tried
  // and removed too: the globe now has NO edge treatment of any kind. What
  // separates the planet from the page is the land itself and the borders on it,
  // and where an ocean meets space there is simply nothing to see — which is the
  // intended reading rather than a gap in it.
  sky: { 'atmosphere-blend': 0 },
  layers: [
    // LAND IS THE BACKGROUND AND THE SEA IS PAINTED ON TOP, which is the way
    // round the OpenMapTiles schema requires: there is no land polygon, only
    // water, so land is what is left where water is not.
    { id: 'land', type: 'background', paint: { 'background-color': LAND } },
    {
      id: 'water',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'water',
      paint: { 'fill-color': OCEAN },
    },
    // THE ROADS, UNDER EVERY BOUNDARY. Least important first so a motorway
    // paints over a lane where they meet. See ROAD_TIERS for the hierarchy.
    //
    // line-opacity FADES EACH CLASS IN over its first zoom level rather than
    // switching it on: minzoom alone makes a whole network of streets appear
    // between one frame and the next, which reads as a glitch rather than as
    // detail arriving.
    ...ROAD_TIERS.map((t) => ({
      id: t.id,
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      minzoom: t.minzoom,
      filter: ['in', ['get', 'class'], ['literal', t.classes]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.color,
        'line-width': roadWidth(t.width),
        'line-opacity': ['interpolate', ['linear'], ['zoom'],
          t.minzoom, 0, t.minzoom + 1, 1],
      },
    })),
    // ADMIN-1 UNDER COUNTRY, so a national border that is also a state border
    // is drawn at the heavier weight. maritime is excluded on both: a maritime
    // boundary is a line drawn across open sea and it reads as an error.
    {
      id: 'admin1',
      type: 'line',
      source: 'ofm',
      'source-layer': 'boundary',
      minzoom: 3,
      filter: ['all',
        ['>=', ['get', 'admin_level'], 3],
        ['<=', ['get', 'admin_level'], 4],
        ['!=', ['get', 'maritime'], 1]],
      paint: {
        'line-color': ADMIN1_LINE,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 0.8],
      },
    },
    {
      id: 'country',
      type: 'line',
      source: 'ofm',
      'source-layer': 'boundary',
      filter: ['all',
        ['<=', ['get', 'admin_level'], 2],
        ['!=', ['get', 'maritime'], 1]],
      paint: {
        'line-color': COUNTRY_LINE,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 5, 0.9, 10, 1.2],
      },
    },
    // ROAD NAMES, AND ONLY WHEN CLOSE. symbol-placement line makes the name
    // follow the road rather than sit beside a point on it, which is the only
    // way a street name reads as belonging to that street.
    //
    // BELOW THE PLACE NAMES IN THE STACK, so a city name always wins a
    // collision: at z14 you may need the street, but you must never lose the
    // city while looking for it.
    {
      id: 'label-road',
      type: 'symbol',
      source: 'ofm',
      'source-layer': 'transportation_name',
      minzoom: ROAD_LABEL_MIN_ZOOM,
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 11],
        'symbol-placement': 'line',
        'text-anchor': 'center',
        'text-max-angle': 30,
        'text-padding': 2,
      },
      paint: {
        'text-color': ROAD_LABEL_INK,
        'text-halo-color': LABEL_HALO,
        'text-halo-width': 1,
      },
    },
    // TWO CLASSES OF PLACE NAME — no villages and no water names. A country is
    // the subject; a city is an annotation on one.
    {
      id: 'label-country',
      type: 'symbol',
      source: 'ofm',
      'source-layer': 'place',
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 13],
        'text-max-width': 7,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': LABEL_COUNTRY,
        'text-halo-color': LABEL_HALO,
        'text-halo-width': 1,
      },
    },
    {
      id: 'label-city',
      type: 'symbol',
      source: 'ofm',
      'source-layer': 'place',
      minzoom: 4,
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 10, 12],
        'text-max-width': 8,
      },
      paint: {
        'text-color': LABEL_CITY,
        'text-halo-color': LABEL_HALO,
        'text-halo-width': 1,
      },
    },
    // ── VISITED: A RING, NOT A BIGGER DOT ────────────────────────────────────
    //
    // SIZE MEANS IMPORTANCE AND MUST KEEP MEANING IT. Every airport on this map
    // is the same 2.2-to-4.5px dot because they are all the same KIND of thing;
    // growing the ones this user has flown through would say Heathrow matters
    // more than Gatwick to the map, which is not what is being recorded. History
    // is a different axis from importance and needs a different mark.
    //
    // SO: THE SAME GREEN, DRAWN AS AN ORBIT. A hairline ring three pixels clear
    // of the dot, at 45% of the dot's own alpha. The dot underneath is
    // untouched — same position, same size, same colour — and the ring reads as
    // an annotation on it rather than as a change to it. At a glance the visited
    // airports are the ones with something around them; at rest it is quiet
    // enough not to turn a well-travelled map into a field of targets.
    //
    // UNDER THE DOTS, so the solid centre always wins its own pixels and the
    // ring cannot make the dot look hollow.
    {
      id: 'airport-visited',
      type: 'circle',
      source: 'visited',
      minzoom: AIRPORT_MIN_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 5.2, 10, 7.5],
        // A circle layer always fills; the fill is made invisible and the mark
        // is entirely the stroke, which is what makes this a ring.
        //
        // THE STROKE SURVIVES A ZERO FILL, AND THIS WAS READ RATHER THAN
        // ASSUMED — the whole layer depends on it, and if a zero fill opacity
        // suppressed the stroke the rings would be invisible with no error.
        // maplibre-gl 5.24.0's circle fragment shader ends:
        //
        //   fragColor = v_visibility * opacity_t
        //             * mix(color*opacity, stroke_color*stroke_opacity, color_t)
        //
        // and mix(a,b,t) is a*(1-t) + b*t. In the stroke band color_t goes to 1,
        // so the fragment IS stroke_color*stroke_opacity and the fill's opacity
        // is weighted to nothing. The two terms never multiply.
        //
        // The shader forces color_t to 0 only when stroke_width < 0.01, and the
        // trailing discard fires only when all four channels are under 0.5/255 —
        // true of the transparent interior, false of a green stroke at 0.45. So
        // the middle is thrown away and the ring is kept, which is the intent.
        'circle-opacity': 0,
        'circle-stroke-width': 1,
        'circle-stroke-color': AIRPORT_INK,
        // Fades in on the same ramp as the dots, so a ring never arrives before
        // the thing it is annotating.
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'],
          AIRPORT_MIN_ZOOM, 0, AIRPORT_FULL_ZOOM, 0.45],
      },
    },
    // THE AIRPORTS, ON TOP OF THE GEOGRAPHY. The only green on the map.
    {
      id: 'airports',
      type: 'circle',
      source: 'airports',
      minzoom: AIRPORT_MIN_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 10, 4.5],
        'circle-color': AIRPORT_INK,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'],
          AIRPORT_MIN_ZOOM, 0, AIRPORT_FULL_ZOOM, 1],
      },
    },
    // ── THE TAP TARGET, INVISIBLE AND A CONSTANT SIZE ────────────────────────
    //
    // A SECOND LAYER RATHER THAN A BIGGER DOT, because the two have different
    // jobs. The visible dot is 2.2px at z5 growing to 4.5 at z10 — correct as a
    // data point and hopeless as a target, since a finger covers about 44px and
    // the dot it is aiming at is two. Taps missed at exactly the zoom where the
    // airports first appear.
    //
    // 22px AT EVERY ZOOM. circle-radius is already in SCREEN pixels, so a plain
    // number is a constant on-screen size regardless of how far out the camera
    // is — the zoom interpolation on the visible dot was the only reason its
    // target ever changed. 22 gives a 44px diameter, which is the standard
    // minimum touch target, centred on the dot.
    //
    // circle-opacity 0 STILL ANSWERS A QUERY, AND THIS WAS READ RATHER THAN
    // ASSUMED — it is load-bearing, because if a transparent circle were skipped
    // the dots would stop being tappable altogether rather than degrading.
    // Verified in maplibre-gl 5.24.0's source:
    //
    //   CircleStyleLayer.queryIntersectsFeature reads circle-radius,
    //   circle-stroke-width, circle-translate and the two pitch properties.
    //   It never consults circle-opacity.
    //
    //   StyleLayer.isHidden returns true only for the minzoom/maxzoom bounds and
    //   visibility === 'none'. No paint property can hide a layer from a query.
    //
    //   The query pipeline itself filters by the spatial grid, the layer's own
    //   `filter`, and the requested layer list, and applies no opacity gate.
    //
    // The same reading also confirms why the handler below sorts by distance:
    // the pipeline ends in matching.sort(topDownFeatureComparator), so results
    // arrive in RENDER order and features[0] is the topmost, not the nearest.
    {
      id: 'airport-hit',
      type: 'circle',
      source: 'airports',
      minzoom: AIRPORT_MIN_ZOOM,
      paint: {
        'circle-radius': AIRPORT_HIT_R,
        'circle-color': AIRPORT_INK,
        'circle-opacity': 0,
      },
    },
    // THE PIN, ABOVE EVEN THE AIRPORTS, and drawn at EVERY zoom — unlike the
    // airports, which fade in at z4.5. Where the user is standing is worth
    // marking on the globe itself, and it is one feature rather than 1,223.
    {
      id: 'pin-halo',
      type: 'circle',
      source: 'pin',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 9, 8, 16],
        'circle-color': PIN_HALO,
      },
    },
    {
      id: 'pin-dot',
      type: 'circle',
      source: 'pin',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3, 8, 4.5],
        'circle-color': PIN_INK,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': PIN_RING,
      },
    },
  ],
};

// THE GEOJSON IS SPLICED IN AS RAW JSON rather than nested into the object and
// stringified whole, so 1,223 features are serialised once here instead of
// being re-escaped as a string inside a string.
//
// A FUNCTION AS THE REPLACEMENT, not the string itself. String.replace treats
// $& and $' in a replacement STRING as substitution patterns; a function is
// handed over verbatim. Nothing in this data contains a dollar sign today, and
// that is exactly the kind of thing that stops being true quietly.
const STYLE_JSON = JSON.stringify(STYLE).replace('"__AIRPORTS__"', () => AIRPORT_GEOJSON);

// NO BACKTICKS AND NO ${} INSIDE THIS PAGE'S OWN SCRIPT — it lives in a template
// literal, and the only interpolations are the deliberate ones.
//
// NO REMOTE STYLESHEET. maplibre-gl.css exists to style controls and the
// attribution bar, and this map has neither. The four rules that actually
// position the canvas are inlined below, which removes a request and a failure
// mode: a stylesheet that fails to load is silent, and the symptom would have
// been a map that is present but zero pixels tall.
const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #map { margin:0; padding:0; height:100%; width:100%;
                     background:${OCEAN}; overflow:hidden; }
  .maplibregl-map { position:relative; overflow:hidden; }
  .maplibregl-canvas-container, .maplibregl-canvas {
    position:absolute; top:0; left:0; width:100%; height:100%; }
  .maplibregl-ctrl-attrib, .maplibregl-ctrl-logo { display:none !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
// ── REPORTING ──────────────────────────────────────────────────────────────
//
// EVERY STAGE NAMES ITSELF. The previous version surfaced a CDN problem as a
// downstream "undefined is not an object", because the only thing that threw was
// the first use of a namespace that had never arrived. Each step below reports
// its own success or its own failure, so the next thing that breaks says what it
// was rather than what happened afterwards.
var STAGE = 'boot';
function post(o) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
}
function err(stage, message) { post({ type: 'error', stage: stage, message: message }); }
// THE FULL ErrorEvent, NOT JUST ITS MESSAGE.
//
// "Script error." IS WHAT A BROWSER SAYS WHEN IT IS WITHHOLDING THE DETAIL. An
// error thrown by a script from another origin is reported with the message,
// filename, line and column all stripped, because letting a page read them would
// leak the contents of a cross-origin resource. Six of those told us only that
// something threw somewhere in MapLibre.
//
// crossorigin="anonymous" ON THE SCRIPT TAG IS THE OPT-OUT. It makes the fetch a
// CORS request, and once the server agrees — unpkg and jsdelivr both send
// Access-Control-Allow-Origin: * — the browser stops treating the script as
// opaque and fills these fields in.
window.addEventListener('error', function (e) {
  if (!e) { err(STAGE, 'uncaught: unknown'); return; }
  var parts = [];
  parts.push(e.message || 'no message');
  if (e.filename) parts.push('at ' + e.filename + ':' + e.lineno + ':' + e.colno);
  if (e.error && e.error.stack) parts.push('stack: ' + String(e.error.stack).slice(0, 600));
  else if (e.error) parts.push('error: ' + String(e.error));
  // STILL OPAQUE IS ITSELF A FINDING. If the message is bare "Script error." even
  // with crossorigin set, the throw did not come from the tagged script — a Web
  // Worker built from a blob is the usual candidate — and that narrows it.
  if (!e.filename && (e.message === 'Script error.' || e.message === 'Script error')) {
    parts.push('(still opaque with crossorigin set - not from the tagged script)');
  }
  err(STAGE, 'uncaught: ' + parts.join(' | '));
});
// THE SAME TREATMENT FOR REJECTIONS. A failed tile fetch is a rejected promise
// before it is anything else, and String(reason) throws away the stack that says
// which stage of the pipeline dropped it.
window.addEventListener('unhandledrejection', function (e) {
  var r = e ? e.reason : null;
  if (!r) { err(STAGE, 'unhandled rejection: unknown'); return; }
  var msg = r.message ? r.message : String(r);
  if (r.status) msg = msg + ' [http ' + r.status + ']';
  if (r.url) msg = msg + ' [url ' + r.url + ']';
  if (r.stack) msg = msg + ' | stack: ' + String(r.stack).slice(0, 600);
  err(STAGE, 'unhandled rejection: ' + msg);
});

// ON FAILURE ONLY. These are requests MapLibre would make anyway, so running
// them up front would just duplicate them; running them when something has
// already gone wrong turns "it did not work" into an HTTP status.
function diagnose() {
  var probes = [
    ['tilejson', '${OFM_TILES}'],
    ['glyphs', 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf']
  ];
  probes.forEach(function (p) {
    fetch(p[1], { method: 'GET' })
      .then(function (r) { post({ type: 'probe', what: p[0], status: r.status }); })
      .catch(function (e) { post({ type: 'probe', what: p[0], status: 'threw: ' + e.message }); });
  });
}

// ── THE LIBRARY ────────────────────────────────────────────────────────────
//
// A CLASSIC <script> ELEMENT BUILT BY HAND rather than written into the markup,
// because a hand-built one has an onerror. A <script src> tag in the HTML that
// fails to fetch does so silently and the page carries on to the next statement
// with the namespace missing — which is exactly the failure being fixed.
var CDNS = ${JSON.stringify(CDNS)};

function loadFrom(i) {
  if (i >= CDNS.length) {
    err('script', 'no CDN reachable: tried ' + CDNS.map(function (c) { return c[0]; }).join(', '));
    diagnose();
    return;
  }
  STAGE = 'script:' + CDNS[i][0];
  var s = document.createElement('script');
  s.src = CDNS[i][1];
  s.async = false;
  // SAFE BECAUSE BOTH HOSTS AGREE. crossorigin on a script whose server does NOT
  // send Access-Control-Allow-Origin makes it fail to load outright rather than
  // load opaquely, so this was checked first: unpkg and jsdelivr both send *.
  s.crossOrigin = 'anonymous';
  s.onerror = function () {
    err('script', 'fetch failed from ' + CDNS[i][0] + ' (' + CDNS[i][1] + ')');
    loadFrom(i + 1);
  };
  s.onload = function () {
    // LOADED IS NOT THE SAME AS USABLE. A 200 that returns an error page, or a
    // build whose namespace is not where it is expected, both land here — and
    // both used to become "undefined is not an object" several lines later.
    if (!window.maplibregl || typeof window.maplibregl.Map !== 'function') {
      err('script', CDNS[i][0] + ' served the script but window.maplibregl.Map is not a function');
      loadFrom(i + 1);
      return;
    }
    post({ type: 'cdn', host: CDNS[i][0], version: window.maplibregl.getVersion ? window.maplibregl.getVersion() : 'unknown' });
    start();
  };
  document.head.appendChild(s);
}

function start() {
  STAGE = 'map';
  var map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: ${STYLE_JSON},
      center: [${START_LON}, ${START_LAT}],
      zoom: ${START_ZOOM},
      attributionControl: false,
      // The globe has no meaningful upside-down, and a pitched globe is a
      // different product. Rotation and pitch are off; pan and pinch are all.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: true
    });
  } catch (e) {
    err('map', 'constructor threw: ' + (e && e.message ? e.message : String(e)));
    diagnose();
    return;
  }
  map.touchZoomRotate.disableRotation();

  // THE ERROR EVENT CARRIES WHICH SOURCE FAILED, and that is the difference
  // between "the style is wrong" and "the tiles will not come". sourceId is set
  // for tile and geojson failures and absent for style and runtime ones.
  var reported = 0;
  map.on('error', function (ev) {
    var m = (ev && ev.error && ev.error.message) ? ev.error.message : 'unknown';
    var where = (ev && ev.sourceId) ? ('source:' + ev.sourceId) : STAGE;
    // Tile errors arrive one per failed tile; a hundred identical lines is not
    // more information than three.
    reported = reported + 1;
    if (reported <= 3) err(where, m);
    if (reported === 1) diagnose();
  });

  // ON style.load AND NOT ON load. setProjection needs a style to attach to, and
  // 'load' also waits for the first tiles — which would leave the map flat for
  // as long as the network takes and then snap it into a sphere.
  map.on('style.load', function () {
    STAGE = 'projection';
    try {
      map.setProjection({ type: 'globe' });
    } catch (e) {
      err('projection', 'setProjection failed: ' + (e && e.message ? e.message : String(e)));
    }
    STAGE = 'tiles';
    post({ type: 'style' });
  });

  // ── CAMERA MOTIONS ─────────────────────────────────────────────────────────
  //
  // ONE TOKEN, AND IT BELONGS TO THE CAMERA ALONE. Every frame-driven motion
  // checks its own token before doing anything, so cancelling is a single flag
  // rather than a search for what might be running.
  //
  // THE ARC WILL NOT SHARE IT. When the route line is added it gets a SECOND,
  // separate token that onGrab never touches, because the line must finish
  // drawing whether or not the camera was grabbed. Coupling them would be one
  // line of code and the wrong behaviour, so the separation is written down here
  // before there is anything to separate.
  var camToken = null;

  function cancelCamera() {
    if (!camToken) return;
    camToken.alive = false;
    if (camToken.raf) cancelAnimationFrame(camToken.raf);
    camToken = null;
  }

  // ── INTERRUPTION ───────────────────────────────────────────────────────────
  //
  // A TOUCH STOPS THE CAMERA DEAD. No easing out, no finishing, no reframing.
  //
  // THIS HANDLER DOES NOT CALL map.stop(), AND THAT IS DELIBERATE. stop() runs
  // _stop() with allowGestures undefined, which then calls handlers.stop(false)
  // -> handler.reset() on every handler. Fired from a capture-phase touchstart
  // that is EARLIER than MapLibre's own processing, that would wipe the
  // TouchPanHandler's touch bookkeeping and break the very gesture the user just
  // started. MapLibre stops its own flyTo without help: TouchPanHandler sets
  // _active on touchstart before any movement, so HandlerManager sees an active
  // handler and calls _stop(true) itself, which spares the gestures.
  //
  // SO WHAT IS LEFT TO CANCEL IS ONLY THE ROUTE LOOP, which MapLibre knows
  // nothing about because it is jumpTo called from requestAnimationFrame.
  // Without this the loop would keep writing the centre every frame and fight
  // the finger for the map.
  function onGrab() { cancelCamera(); }
  var el = map.getCanvasContainer();
  el.addEventListener('touchstart', onGrab, { capture: true, passive: true });
  el.addEventListener('mousedown', onGrab, { capture: true, passive: true });

  // ── MOTION 1: OUT, AROUND, DOWN ────────────────────────────────────────────
  //
  // NOTE ON REDUCED MOTION: essential is deliberately not set, so a device with
  // the OS "reduce motion" setting on gets an instant jump instead of a three
  // second flight. That is the accessible behaviour and it is a real decision,
  // not an omission.
  // GREAT-CIRCLE KILOMETRES between two lon/lat pairs. Haversine rather than the
  // slerp used by the route, because this needs one scalar and not a path.
  function kmBetween(lon1, lat1, lon2, lat2) {
    var R = 6371, D = Math.PI / 180;
    var dLat = (lat2 - lat1) * D, dLon = (lon2 - lon1) * D;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── AN AIRPORT FLIGHT NEVER PULLS BACK, AT ANY DISTANCE ────────────────────
  //
  // THE PULL-BACK ANSWERS A QUESTION THE USER HAS ALREADY ANSWERED. Rising to
  // the globe and turning it exists to say "here is where that is, relative to
  // everything else" — and someone who just tapped a dot can see where it is.
  // They pointed at it. Showing them the planet first is the app explaining
  // something they demonstrated they already knew.
  //
  // THE GATE STAYS WHERE IT IS EARNED: goHome, where the target is off screen by
  // definition, and the route arc, where travelling the great circle IS the
  // motion. See applyHome and flyRoute.
  //
  // THE DURATION STILL SCALES, because a direct move is not a teleport: crossing
  // an ocean should take longer than crossing a city, or the distance stops
  // being legible. Clamped so the shortest hop is not instant and the longest
  // does not outstay the pull-back it replaced.
  function flyAirport(lon, lat) {
    cancelCamera();
    var c = map.getCenter();
    var km = kmBetween(c.lng, c.lat, lon, lat);
    var dur = ${AIRPORT_NEAR_MS} + km * 0.1;
    if (dur > ${AIRPORT_FAR_MS}) dur = ${AIRPORT_FAR_MS};
    post({ type: 'flyAirport', km: Math.round(km), ms: Math.round(dur) });
    // NO minZoom, EVER, AND THAT IS THE WHOLE MECHANISM. With it MapLibre
    // derives the flight curvature from the apex and arcs out to the globe;
    // without it the default curve keeps the camera low and simply travels.
    map.flyTo({ center: [lon, lat], zoom: ${AIRPORT_ZOOM}, duration: dur });
  }

  // ── MOTION 2: ALONG THE GREAT CIRCLE ───────────────────────────────────────
  //
  // SLERP ON UNIT VECTORS, which is the great circle by construction: the
  // interpolant stays on the sphere and moves at a constant angular rate, so the
  // path IS the shortest route and needs no special case for crossing the
  // antimeridian or passing near a pole.
  function toVec(lon, lat) {
    var a = lon * Math.PI / 180, b = lat * Math.PI / 180, c = Math.cos(b);
    return [c * Math.cos(a), c * Math.sin(a), Math.sin(b)];
  }
  function toLngLat(v) {
    return [
      Math.atan2(v[1], v[0]) * 180 / Math.PI,
      Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1])) * 180 / Math.PI
    ];
  }

  function flyRoute(lon1, lat1, lon2, lat2) {
    cancelCamera();
    var a = toVec(lon1, lat1), b = toVec(lon2, lat2);
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    d = d > 1 ? 1 : (d < -1 ? -1 : d);
    var om = Math.acos(d);
    var frac = om / Math.PI;
    var dur = ${ROUTE_MS_MIN} + frac * (${ROUTE_MS_MAX} - ${ROUTE_MS_MIN});
    var apex = ${ROUTE_END_ZOOM} - frac * ${ROUTE_PULLBACK};
    if (apex < 0) apex = 0;
    var sinOm = Math.sin(om);
    map.jumpTo({ center: [lon1, lat1], zoom: ${ROUTE_END_ZOOM} });
    var t0 = performance.now();
    var tok = { alive: true, raf: 0 };
    camToken = tok;
    function step(now) {
      // THE TOKEN IS CHECKED FIRST, EVERY FRAME. A cancelled flight must not
      // write the camera even once more, which is what "stops dead" means.
      if (!tok.alive) return;
      var t = (now - t0) / dur;
      if (t > 1) t = 1;
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var p;
      if (sinOm < 1e-8) {
        p = a;
      } else {
        var s1 = Math.sin((1 - e) * om) / sinOm, s2 = Math.sin(e * om) / sinOm;
        p = [a[0] * s1 + b[0] * s2, a[1] * s1 + b[1] * s2, a[2] * s1 + b[2] * s2];
      }
      // Out and back within the one motion: sin(pi*e) is 0 at both ends and 1 in
      // the middle, so the camera rises off the origin and settles onto the
      // destination without a seam.
      map.jumpTo({
        center: toLngLat(p),
        zoom: ${ROUTE_END_ZOOM} + (apex - ${ROUTE_END_ZOOM}) * Math.sin(Math.PI * e)
      });
      if (t < 1) {
        tok.raf = requestAnimationFrame(step);
      } else {
        tok.alive = false;
        if (camToken === tok) camToken = null;
      }
    }
    tok.raf = requestAnimationFrame(step);
  }

  // ── EVERY TAP ON THE MAP, IN ONE HANDLER ───────────────────────────────────
  //
  // ONE GLOBAL LISTENER RATHER THAN A LAYER-SCOPED ONE, because a tap on empty
  // map has to be an event too — it is what dismisses the panel. A layer-scoped
  // handler only ever fires on a hit, so "the user tapped nothing" would be
  // unobservable and the panel could never be closed by the map.
  //
  // THE NEAREST DOT WINS, AND THAT MATTERS AT LOW ZOOM. With a 22px target,
  // Delhi and its neighbours overlap well before z6, and queryRenderedFeatures
  // returns everything under the point in RENDER order — which is the order the
  // features happen to sit in the source, not the order a person would expect.
  // Taking features[0] therefore picked an arbitrary one of the overlapping
  // dots, and the same tap could select a different airport at a different zoom.
  //
  // SO EACH CANDIDATE IS PROJECTED BACK TO THE SCREEN and the one closest to the
  // touch point is chosen. That is the dot the user was aiming at, by
  // definition, and it is stable: the same tap always resolves to the same
  // airport.
  map.on('click', function (e) {
    var hits = map.queryRenderedFeatures(e.point, { layers: ['airport-hit'] });
    if (!hits || hits.length === 0) {
      post({ type: 'mapTap' });
      return;
    }
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < hits.length; i++) {
      var c = hits[i].geometry.coordinates;
      var p = map.project(c);
      var dx = p.x - e.point.x, dy = p.y - e.point.y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = hits[i]; }
    }
    if (best === null) { post({ type: 'mapTap' }); return; }
    // THE GRAB HANDLER HAS ALREADY CANCELLED whatever was running by the time
    // this fires, so a tap during a flight redirects it rather than queueing.
    var bc = best.geometry.coordinates;
    flyAirport(bc[0], bc[1]);
    post({
      type: 'airport',
      iata: best.properties.iata,
      candidates: hits.length,
      px: Math.round(Math.sqrt(bestD))
    });
  });

  // ── HOME ───────────────────────────────────────────────────────────────────
  //
  // THE PAGE REMEMBERS IT so the button is one call with no arguments. React
  // Native sets home once, when it has resolved it; after that "go home" needs
  // no knowledge of where home is, and the two cannot drift apart.
  //
  // A BOX IS FITTED AND A POINT IS ZOOMED, which is the whole reason HomeView is
  // a union. fitBounds solves for the camera that contains a region; a position
  // has no extent to solve for and gets the country zoom directly.
  var homeView = null;

  function applyHome(h, animate) {
    var was = homeView;
    homeView = h;
    // WHAT THE PAGE HELD BEFORE AND AFTER, and how many pin features it is about
    // to draw. The page's homeView and its pin source live entirely inside this
    // WebView: if React changes account and nothing calls in here, the old pin
    // stays drawn whatever storage says, and no amount of key logging on the
    // other side would show it.
    post({
      type: 'homeSet',
      kind: h.kind,
      was: was ? was.kind : 'none',
      wasLon: was ? Math.round(was.lon * 100) / 100 : null,
      lon: Math.round(h.lon * 100) / 100,
      lat: Math.round(h.lat * 100) / 100,
      pins: h.kind === 'position' ? 1 : 0
    });
    // THE PIN IS THE POSITION AND NOTHING ELSE. A country derived from a
    // timezone is not a place the user is standing, so it gets no mark.
    map.getSource('pin').setData({
      type: 'FeatureCollection',
      features: h.kind === 'position'
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }]
        : []
    });
    var dur = animate ? ${HOME_FLY_MS} : 0;
    if (h.kind === 'zone') {
      map.fitBounds([[h.bbox[0], h.bbox[1]], [h.bbox[2], h.bbox[3]]], {
        padding: 48,
        maxZoom: ${HOME_ZOOM_MAX},
        duration: dur,
        linear: false
      });
      return;
    }
    var z = h.kind === 'position' ? ${HOME_ZOOM_POSITION} : ${HOME_ZOOM_FALLBACK};
    if (dur === 0) {
      map.jumpTo({ center: [h.lon, h.lat], zoom: z });
      return;
    }
    // THE SAME GATE flyAirport USES, and for the same reason: pressing home from
    // the next city over should not rise to the whole globe and turn it. The
    // zone branch above needs no gate — fitBounds solves for a camera and never
    // arcs out on its own.
    var c = map.getCenter();
    var km = kmBetween(c.lng, c.lat, h.lon, h.lat);
    var far = km > ${AIRPORT_PULLBACK_KM};
    post({ type: 'flyHome', km: Math.round(km), far: far });
    var opts = { center: [h.lon, h.lat], zoom: z, duration: far ? dur : ${AIRPORT_NEAR_MS} };
    if (far) opts.minZoom = ${GLOBE_APEX_ZOOM};
    map.flyTo(opts);
  }

  // THE BUTTON'S CALL. cancelCamera first so pressing home during a route
  // flight stops that flight rather than racing it — the rAF loop would
  // otherwise keep writing the centre underneath the new motion.
  function goHome() {
    cancelCamera();
    // WHETHER THE PAGE KNOWS WHERE HOME IS, reported rather than silently
    // skipped. homeView is null until React Native has called setHome, which it
    // only does once the style has parsed AND the home has resolved; if either
    // never happens this is a no-op and used to say nothing at all.
    post({ type: 'homeGo', known: !!homeView });
    if (homeView) applyHome(homeView, true);
  }

  // THE ONLY WAY IN FROM REACT NATIVE. injectJavaScript calls these; the page
  // holds no other public surface.
  // ASKS THE PAGE WHAT IT ACTUALLY HOLDS, rather than inferring it from what
  // React believes it sent. The pin count is read back off the live source, so a
  // pin that is still drawn after a scope change shows up here even if every
  // storage key on the other side is correct.
  function probe(tag) {
    var src = map.getSource('pin');
    var data = src && src._data ? src._data : null;
    post({
      type: 'probe',
      tag: tag,
      home: homeView ? homeView.kind : 'none',
      homeLon: homeView ? Math.round(homeView.lon * 100) / 100 : null,
      pins: data && data.features ? data.features.length : -1
    });
  }

  // THE VISITED SET, REPLACED WHOLE. React Native sends the features rather than
  // a list of codes, because the page has no index from IATA to coordinates —
  // its airport data is one baked GeoJSON blob, and searching 1,223 features per
  // update to rebuild something React Native already knows would be work done
  // twice in the slower place.
  function setVisited(features) {
    map.getSource('visited').setData({ type: 'FeatureCollection', features: features });
    post({ type: 'visited', n: features.length });
  }

  window.__cam = {
    airport: flyAirport,
    route: flyRoute,
    setHome: function (h) { applyHome(h, false); },
    home: goHome,
    probe: probe,
    visited: setVisited
  };

  var idled = false;
  map.on('idle', function () {
    if (idled) return;
    idled = true;
    STAGE = 'idle';
    post({ type: 'ready' });
  });
}

loadFrom(0);
</script>
</body>
</html>`;

// ── WHAT THE SCREEN CAN ASK THE MAP TO DO ───────────────────────────────────
//
// TWO VERBS AND NOTHING ELSE. Both take IATA codes rather than coordinates,
// because every caller already has a code and none of them should have to know
// that a camera wants degrees. The lookup happens here, through the same
// lib/airports the search uses, so the map cannot fly to a different Delhi from
// the one the results list found.
//
// THE HEADING IS NOT BUILT YET but needs nothing new: tapping a code in it is
// flyToAirport, which is the same call a dot tap and a search make.
export type GlobeMapHandle = {
  flyToAirport: (iata: string) => void;
  flyRoute: (from: string, to: string) => void;
  // Set once, when the screen has resolved where home is. Jumps rather than
  // flies: this is the opening view, not a journey to it.
  setHome: (h: HomeView) => void;
  // The button. Takes nothing, because the page already knows.
  goHome: () => void;
  // DIAGNOSTIC. Asks the page to report what it is actually holding, which is
  // the one thing React cannot see: homeView and the pin source live in the
  // WebView and survive anything that happens on this side.
  probe: (tag: string) => void;
  // THE AIRPORTS THIS USER HAS FLOWN THROUGH. Replaced whole on every change,
  // because the set is small and a diff would be more code than the work it
  // saves.
  setVisited: (iatas: string[]) => void;
};

// FIRED WHEN THE STYLE HAS PARSED, which is BEFORE the first tiles arrive. That
// is the moment home can be applied without anything visibly moving: the camera
// is set while the map is still blank, so the user's first painted frame is
// already the right one.
type GlobeMapProps = {
  onReady?: () => void;
  // A DOT WAS TAPPED, and this is the airport it resolved to — the nearest to
  // the touch point, not merely one of the overlapping candidates.
  onAirport?: (iata: string) => void;
  // THE MAP WAS TAPPED AND NOTHING WAS THERE. Distinct from onAirport rather
  // than inferred from its absence, because "nothing was hit" is the event that
  // dismisses the panel and it has to be observable.
  onMapTap?: () => void;
};

const GlobeMap = forwardRef<GlobeMapHandle, GlobeMapProps>(
  function GlobeMap({ onReady, onAirport, onMapTap }, ref) {
    const webRef = useRef<WebView>(null);

    // injectJavaScript RETURNS THE LAST EXPRESSION and warns when that is not a
    // primitive, so every call ends in `true` — the standard idiom, and without
    // it the console fills with warnings about the return value.
    //
    // GUARDED ON __cam BECAUSE THE PAGE MAY NOT BE READY. A call that lands
    // before style.load has run finds nothing and does nothing, which is the
    // right outcome: there is no camera yet to move.
    const call = useCallback((js: string) => {
      webRef.current?.injectJavaScript(`try{${js}}catch(e){}; true;`);
    }, []);

    useImperativeHandle(ref, () => ({
      flyToAirport(iata: string) {
        const a = airportByCode(iata);
        if (a === null) return;
        call(`window.__cam&&window.__cam.airport(${a.lon},${a.lat})`);
      },
      flyRoute(from: string, to: string) {
        const a = airportByCode(from);
        const b = airportByCode(to);
        if (a === null || b === null) return;
        call(`window.__cam&&window.__cam.route(${a.lon},${a.lat},${b.lon},${b.lat})`);
      },
      setHome(h: HomeView) {
        console.log(`[HOME] 4. injecting setHome (${h.kind}), webview=${webRef.current !== null}`);
        call(`window.__cam&&window.__cam.setHome(${JSON.stringify(h)})`);
      },
      goHome() {
        // THE LAST THING REACT NATIVE CAN SEE. Past this the call is a string in
        // another runtime, and if window.__cam is missing it evaluates to
        // undefined and does nothing — silently, which is what made this hard.
        // The page answers with homeGo, so the pair of lines brackets the bridge.
        console.log(`[HOME] 6. injecting goHome, webview=${webRef.current !== null}`);
        call('window.__cam&&window.__cam.home()');
      },
      probe(tag: string) {
        call(`window.__cam&&window.__cam.probe(${JSON.stringify(tag)})`);
      },
      setVisited(iatas: string[]) {
        // RESOLVED HERE, NOT IN THE PAGE. airportByCode is the same lookup the
        // search and the panel use, so a visited ring cannot land on a different
        // airport from the one the saved flight names. Unknown codes are dropped
        // silently: a saved flight can carry an IATA this dataset does not have,
        // and a missing ring is the right outcome for one.
        const features = iatas
          .map((c) => airportByCode(c))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .map((a) => ({
            type: 'Feature',
            properties: { iata: a.iata },
            geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
          }));
        call(`window.__cam&&window.__cam.visited(${JSON.stringify(features)})`);
      },
    }), [call]);

  // THE HTML IS CONSTANT, and useMemo says so to the WebView. `source` compared
  // by identity is what decides whether the page reloads, and a page reload is a
  // camera reset plus a fresh round of tile fetches.
  const source = useMemo(
    () => ({ html: HTML, baseUrl: 'https://tiles.openfreemap.org/' }),
    [],
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={webRef}
        // THE ORIGIN MATTERS. An inline html string loads as about:blank on
        // Android, and a null origin makes some hosts refuse the CORS preflight
        // for the style JSON and the tiles. baseUrl puts the document on the tile
        // host so those are same-origin; the unpkg module import is cross-origin
        // and relies on unpkg's own Access-Control-Allow-Origin, which it sends.
        source={source}
        originWhitelist={['*']}
        // WebGL wants a hardware layer on Android; without it MapLibre either
        // falls back to something very slow or refuses to start.
        androidLayerType="hardware"
        domStorageEnabled
        javaScriptEnabled
        // The map does its own gesture handling. The WebView must not also try to
        // scroll or bounce the page around it, or a drag fights two recognisers.
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        // The page is black from the first frame, so there is no white flash
        // between the WebView mounting and MapLibre painting.
        style={st.web}
        // EVERYTHING GOES TO THE CONSOLE AND NOWHERE ELSE. There is no debug
        // panel and no readout; a failure here is a developer's problem, not
        // something to put a red box over the user's map for.
        //
        // THE PROGRESS LINES ARE NOT NOISE. `cdn` says which host actually
        // served the library, `style` that the stylesheet parsed and the globe
        // attached, `ready` that tiles arrived. When something breaks, the last
        // line printed is the stage it got to — which is the whole point of the
        // staged reporting on the other side of the bridge.
        onMessage={(e) => {
          let m: any = null;
          try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
          if (m === null || typeof m !== 'object') return;
          if (m.type === 'error') console.warn(`[MAP] ${m.stage}: ${m.message}`);
          if (m.type === 'probe') console.warn(`[MAP] probe ${m.what}: ${m.status}`);
          if (m.type === 'cdn') console.log(`[MAP] library from ${m.host} (v${m.version})`);
          if (m.type === 'style') {
            console.log('[MAP] style parsed, globe attached');
            // BEFORE THE FIRST TILE. Applying home here means the camera is set
            // while the map is still blank, so nothing is seen to move.
            onReady?.();
          }
          if (m.type === 'ready') console.log('[MAP] tiles in, first idle');
          if (m.type === 'airport') {
            console.log(`[MAP] dot tapped: ${m.iata} (nearest of ${m.candidates}, ${m.px}px from touch)`);
            onAirport?.(String(m.iata));
          }
          if (m.type === 'mapTap') onMapTap?.();
          if (m.type === 'visited') console.log(`[MAP] visited airports: ${m.n}`);
          if (m.type === 'flyAirport') console.log(`[MAP] flyAirport ${m.km}km direct, ${m.ms}ms`);
          if (m.type === 'flyHome') {
            console.log(`[MAP] flyHome ${m.km}km -> ${m.far ? 'pull back to globe' : 'direct move'}`);
          }
          if (m.type === 'homeSet') {
            console.log(`[HOME][PAGE] setHome ${m.was} -> ${m.kind} at ${m.lon},${m.lat} (pins now ${m.pins}, was at ${m.wasLon})`);
          }
          if (m.type === 'probe') {
            console.log(`[HOME][PAGE] probe(${m.tag}): holds ${m.home} at ${m.homeLon}, pin features = ${m.pins}`);
          }
          if (m.type === 'homeGo') {
            console.log(m.known
              ? '[HOME] 7. page flying home'
              : '[HOME] 7. FAILED - page reached but it has no home stored');
          }
        }}
      />
    </View>
  );
});

export default GlobeMap;

const st = StyleSheet.create({
  web: { flex: 1, backgroundColor: OCEAN },
});
