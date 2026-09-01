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
// -- THE FLIGHT OVERLAY'S INKS ------------------------------------------------
//
// GREEN IS RESERVED FOR WHAT IS HAPPENING NOW. The airports are already green
// because they are the map's one live class of thing; a flight in the air joins
// them and a flight that has not left yet does not. Colour carries the
// distinction so weight does not have to shout it.
const ARC_LIVE = '#4ade80';
// DELIBERATELY BELOW A COUNTRY BORDER'S 0.20. A flight that has already landed
// is the faintest mark on the map -- quieter than the coastline it crosses --
// because it is a record rather than a thing that is happening.
//
// RENAMED FROM ARC_PLANNED, and the rename is the point. Grey used to mean "not
// airborne", which put a flight scheduled for next week in the same ink as one
// that flew last month. It now means one thing: this is over.
const ARC_PAST = 'rgba(255,255,255,0.16)';

// ── THE AIRCRAFT, AS A DRAWN SHAPE ───────────────────────────────────────────
//
// A PATH RATHER THAN A FONT GLYPH OR AN IMAGE FILE. The page has no sprite sheet
// and no asset pipeline -- the whole style is authored in this file -- so an
// icon has to arrive as something the page can build for itself. A path filled
// onto a canvas is that, and it costs one rasterisation for the life of the
// page rather than a request that can fail silently.
//
// 64 UNITS, NOSE UP, CENTRED ON (32,32). Nose up is what makes icon-rotate the
// compass bearing directly rather than the bearing plus an offset nobody would
// remember; centred is what makes icon-anchor 'center' put the aircraft's own
// middle on the point, which is where the position actually is.
//
// THREE SIMPLE SUBPATHS -- FUSELAGE, WING, TAILPLANE -- AND NOT ONE OUTLINE.
// This was a single closed path first and it came out full of holes, which is
// worth writing down because the failure is not obvious. A swept wing's
// trailing edge runs FORWARD as it goes inboard, so any outline that traces
// one doubles back on itself in y; the fill rule then counts an odd number of
// crossings through the notches between the fuselage and the tailplane and
// leaves them empty. Three convex-enough pieces have no notches to get wrong.
//
// THEY ALL WIND THE SAME WAY -- clockwise, verified as three positive signed
// areas -- which is what lets canvas's default nonzero fill UNION them. Reverse
// one and it would punch itself out of the other two. The roots deliberately
// overlap the fuselage by a unit either side so the union has no hairline seam
// where a wing meets the body.
//
// SYMMETRIC ABOUT x=32 BY CONSTRUCTION: every x has a twin adding to 64, in
// every subpath. A silhouette a degree off centre reads as a bank, and a mark
// that appears to bank is claiming an attitude this knows nothing about.
const PLANE_PATH =
  'M32 3 L34 26 L34 58 L32 63 L30 58 L30 26 Z ' +
  'M35 25 L57 41 L57 45 L35 40 L29 40 L7 45 L7 41 L29 25 Z ' +
  'M35 49 L43 59 L43 62 L35 56 L29 56 L21 62 L21 59 L29 49 Z';
// The icon's natural size in CSS pixels -- what icon-size 1 draws. 20 sits where
// the old soft circle did (7 to 11px across) plus the room a silhouette needs to
// be read as one: a plane at 11px is a smudge.
const PLANE_PX = 20;
// Device pixels per CSS pixel in the raster. 3 covers every phone this runs on;
// MapLibre is told the ratio, so the icon is drawn at its CSS size and the extra
// samples are what keep the wing edges hard. This is the whole of "crisp".
const PLANE_DPR = 3;
// BLACK, NOT A DARK COLOUR. Night is the absence of light, so the bands are the
// page's own background laid over the geography at a low alpha; anything with a
// hue would tint the land rather than darken it.
const NIGHT_INK = '#050505';

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

// ── WHAT A LABEL SAYS, AND IN WHICH LANGUAGE ────────────────────────────────
//
// name:en FIRST. OpenMapTiles carries the local name in `name` and an English
// one in `name:en` where it exists, and the map was reading neither — it asked
// for `name:latin`, which is the local name transliterated into Latin script.
// That is why Spain read Espana and Germany Deutschland: both were already Latin
// script, so the transliteration returned them unchanged. The map was in the
// local language and looked like a rendering bug.
//
// THREE STEPS, NOT TWO, and the middle one earns its place. Falling straight
// from name:en to name would put Cyrillic, Greek, Han or Devanagari on a map
// whose only fontstack is Noto Sans Regular — glyphs it cannot draw. name:latin
// is the transliteration, so an unnamed-in-English place still renders as
// letters this font has. `name` is the last resort and is right there: better a
// local name than an empty label.
//
// ONE EXPRESSION FOR ALL THREE LAYERS. Countries, cities and road names had the
// same spelling three times, which is three places for them to drift apart.
const LABEL_NAME = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name:latin'],
  ['get', 'name'],
];

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
// 3,000km, AND THE NUMBER COMES FROM WHAT THE MOTION IS FOR. Rising to the whole
// globe and turning it says "the world is bigger than this screen and we are
// crossing it". That sentence has to be TRUE, or the animation is three seconds
// of theatre for a move the user could have made by dragging.
//
// WHAT 3,000 PUTS ON EACH SIDE. Delhi to Mumbai is 1,150km, Delhi to Dubai
// 2,200km, Delhi to Bangkok 2,900km — a region, its neighbours, and the near
// abroad, all of which the camera now simply travels to. Delhi to Singapore is
// 3,900km and Delhi to London 6,700km, which are crossings and get the globe.
// The line falls in the gap between Bangkok and Singapore rather than on top of
// either, so no realistic pair is decided by a rounding error.
//
// IT WAS 1,500 AND THAT WAS TOO EAGER: it put Dubai and Bangkok on the far side
// of a threshold they do not belong on, and the pull-back fired for moves that
// read as regional.
//
// NAMED FOR ITS ONE CALLER. It was AIRPORT_PULLBACK_KM, from a time when
// flyAirport shared the gate; flyAirport stopped pulling back at any distance
// and the name kept pointing at the motion that no longer reads it. Two other
// motions look similar and are not gated by this:
//
//   flyAirport  never pulls back at any distance, because a user who tapped a
//               dot has already been shown where it is.
//   flyRoute    pulls back CONTINUOUSLY rather than at a threshold — its apex is
//               ROUTE_END_ZOOM minus the route's angular fraction of a
//               half-turn, so a long route rises further than a short one with
//               no step anywhere. There is no gate in it to move.
const HOME_PULLBACK_KM = 3000;
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
    // -- THE FLIGHT OVERLAY'S THREE SOURCES ---------------------------------
    //
    // ALL THREE ARE FILLED BY THE PAGE, NOT BY REACT NATIVE. React Native sends
    // a flight list when it changes and a timestamp once a minute; the page
    // turns those into geometry. Declared empty here for the same reason the
    // pin is -- the layers exist from the first frame, so paint order is
    // settled once and an update is a setData rather than an addLayer.
    arcs: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    planes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    night: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
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
    // -- THE TERMINATOR, AS THREE NESTED BANDS -------------------------------
    //
    // ABOVE THE GEOGRAPHY AND BELOW EVERY LABEL. Night darkens the land and the
    // sea; it must not darken a place name, because a name is not lit by the
    // sun and dimming it would read as the map losing confidence rather than as
    // the world turning.
    //
    // THREE LAYERS, NOT ONE POLYGON WITH THREE RINGS. A fill layer composites
    // its own overlapping parts once, so three nested rings inside a single
    // layer would come out as a flat 0.10 with two hard creases in it. Separate
    // layers each composite against what is already on the canvas, and that is
    // what makes the alphas accumulate to 0.10 / 0.20 / 0.30.
    //
    // A FILL HAS NO BLUR IN MAPLIBRE, which is the whole reason for the stack.
    // One polygon would put a drawn line across the planet -- precisely what a
    // terminator is not.
    //
    // fill-antialias: false FOR THE SAME REASON. Antialiasing a fill draws an
    // outline pass around it, which on a shape this size is a faint hairline
    // tracing the terminator -- the exact edge the three bands exist to avoid.
    { id: 'night-0', type: 'fill', source: 'night', filter: ['==', ['get', 'band'], 0],
      paint: { 'fill-color': NIGHT_INK, 'fill-opacity': 0.1, 'fill-antialias': false } },
    { id: 'night-1', type: 'fill', source: 'night', filter: ['==', ['get', 'band'], 1],
      paint: { 'fill-color': NIGHT_INK, 'fill-opacity': 0.1, 'fill-antialias': false } },
    { id: 'night-2', type: 'fill', source: 'night', filter: ['==', ['get', 'band'], 2],
      paint: { 'fill-color': NIGHT_INK, 'fill-opacity': 0.1, 'fill-antialias': false } },
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
        'text-field': LABEL_NAME,
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
        'text-field': LABEL_NAME,
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
        'text-field': LABEL_NAME,
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
    // -- SAVED FLIGHTS, ONE LAYER AT TWO WEIGHTS -----------------------------
    //
    // GREEN MEANS THE FLIGHT IS STILL AHEAD OF YOU OR IN THE AIR; GREY MEANS IT
    // IS OVER. The line used to be drawn at whether the aircraft was airborne
    // right now, which made a flight scheduled for next week look exactly like
    // one that landed last month -- and of the two, the one you are about to
    // take is obviously the live thing on the map. Green is this app's word for
    // live everywhere else, and a booked flight is live.
    //
    // SO THE PROPERTY IS `past`, NOT `live`. It answers one question -- has the
    // arrival time gone by -- and the colour, the width and the opacity all read
    // the same answer, which is what stops them from ever disagreeing.
    //
    // AN UNKNOWN ARRIVAL IS NOT PAST. A route whose record carried no ISO time
    // cannot be shown to be over, and the honest default for "we do not know" is
    // the same one an unflown flight gets. See rebuild.
    //
    // ONE LAYER RATHER THAN TWO, with the difference expressed as a data-driven
    // paint. Two layers would fix the paint order between them for all time --
    // past always over current, or the reverse -- when what should decide which
    // arc wins a shared pixel is nothing at all, since they are the same class
    // of object. One layer lets them interleave.
    //
    // UNDER THE AIRPORT DOTS, so an arc terminates behind its endpoint rather
    // than crossing it. Above the labels, because the flight overlay is one
    // block of foreground and splitting it around the place names would read as
    // two unrelated things.
    {
      id: 'arcs',
      type: 'line',
      source: 'arcs',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'past'], 1], ARC_PAST, ARC_LIVE],
        // THE WEIGHT READS THE SAME RULE AS THE COLOUR, which is the whole of
        // this change: whatever is green is also the wider of the two. At z1 a
        // hairline is near the limit of what a phone screen resolves, so hue
        // alone would not separate them when zoomed out -- the weight carries
        // the distinction before the colour is even readable.
        'line-width': ['interpolate', ['linear'], ['zoom'],
          1, ['case', ['==', ['get', 'past'], 1], 0.6, 1.0],
          6, ['case', ['==', ['get', 'past'], 1], 1.0, 1.8]],
        'line-opacity': ['case', ['==', ['get', 'past'], 1], 1, 0.85],
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
    // -- THE AIRCRAFT --------------------------------------------------------
    //
    // A DRAWN AEROPLANE, HARD-EDGED, POINTING WHERE IT IS GOING. It was a soft
    // circle, and the blur was defended as honesty about an interpolated
    // position. That argument does not survive the rest of the map: every other
    // mark here -- a 2.2px airport dot, a 0.6px border, a hairline arc -- is
    // drawn crisply and none of them is more certain than this. A blur among
    // them read as a rendering fault rather than as a claim about precision,
    // and the uncertainty is a fact about the DATA, which is not something a
    // fuzzy edge can say and a caption can.
    //
    // THE HEADING IS NOT INVENTED. It is the bearing between the arc samples
    // either side of the aircraft's own index, so the nose follows the same
    // great circle the line under it is drawn from -- see rebuild. Nothing is
    // asserted that the arc does not already assert.
    //
    // icon-rotation-alignment 'map' TIES THE ROTATION TO THE WORLD. The default
    // for a rotatable icon is 'viewport', which would hold the nose at a fixed
    // angle on the screen while the globe turned underneath it.
    //
    // ALLOW-OVERLAP AND IGNORE-PLACEMENT, BOTH TRUE. Symbol layers run a
    // collision pass and drop what does not fit; an aircraft is a position
    // rather than a label, and one silently omitted because a city name got
    // there first would be a flight missing from the map with no error.
    //
    // ABOVE THE AIRPORTS, BELOW THE PIN. The aircraft is the one moving thing
    // on the map and must not be occluded by a static dot it happens to
    // overfly; the user's own location still outranks it.
    {
      id: 'planes',
      type: 'symbol',
      source: 'planes',
      layout: {
        'icon-image': 'aircraft',
        // 0.7 to 1.1 of PLANE_PX, so 14px zoomed out to 22px close in. The old
        // circle ran 7 to 11px across; a silhouette needs about twice a dot's
        // width before the wings and the tail separate at all.
        'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.7, 8, 1.1],
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-anchor': 'center',
      },
      paint: {
        // 0.9, THE SAME VALUE THE SOFT CIRCLE CARRIED. The colour itself is
        // baked into the raster -- an ordinary (non-SDF) image cannot be tinted
        // by icon-color -- so this is the only paint left on the layer.
        'icon-opacity': 0.9,
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
  /* ── NOTHING IN HERE IS TEXT, SO NOTHING IN HERE IS SELECTABLE ──
     A long press on the canvas was raising the WebView's own selection UI: the
     blue wash and a copy-paste bar, over a map with nothing to copy. The map is
     a canvas and its labels are painted pixels, so selection has nothing to
     select and only gets in the way of holding a finger down.

     THE UNIVERSAL SELECTOR IS DELIBERATE. The old rule set was scoped to html,
     body and #map, and the canvas MapLibre creates at runtime is none of those;
     a child element is what the long press actually lands on.

     -webkit-touch-callout IS THE iOS HALF and user-select the Android half —
     the two platforms raise this through different mechanisms and neither
     property covers both. tap-highlight-color removes Android's grey flash on
     touch, which is the same class of browser affordance on a surface that is
     not a document. */
  * { -webkit-user-select: none; user-select: none;
      -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
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
// AND THE SAME THING AGAIN IN JAVASCRIPT, because CSS is not always enough.
// Android's WebView has been observed to begin a selection on a canvas whatever
// user-select says, and the gesture that starts it is a long press — exactly the
// gesture a map wants for itself. Cancelling the events is the belt to the CSS's
// braces; both are cheap and neither is sufficient alone on both platforms.
//
// passive:false IS REQUIRED. A passive listener cannot preventDefault, and these
// exist for nothing else.
['selectstart', 'contextmenu', 'dragstart'].forEach(function (n) {
  document.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false });
});

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
// -- THE FOUR VALUES THE PAGE IS HANDED --------------------------------------
//
// DELIBERATE INTERPOLATIONS, and the only ones in this script besides the style
// itself. The aircraft is drawn in here but DESIGNED up there, alongside every
// other colour and size decision in this file; spelling its green a second time
// as a literal is how the arcs and the aircraft would come apart the first time
// one of them changed.
//
// JSON.stringify RATHER THAN QUOTES AROUND THE VALUE, and that is what makes the
// interpolation safe: a colour or a path that happened to contain a quote would
// otherwise end the string it was pasted into, silently, at build time.
var PLANE_PATH = ${JSON.stringify(PLANE_PATH)};
var PLANE_INK = ${JSON.stringify(ARC_LIVE)};
var PLANE_PX = ${PLANE_PX};
var PLANE_DPR = ${PLANE_DPR};

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
  // ── THE AIRCRAFT ICON, RASTERISED ONCE ─────────────────────────────────────
  //
  // A CANVAS, BECAUSE THE STYLE HAS NO SPRITE. Every other mark on this map is a
  // circle or a line, which MapLibre draws from the style directly; a symbol
  // layer needs a bitmap in the image registry, and this page ships no sprite
  // sheet and fetches nothing. So the shape is filled onto an offscreen canvas
  // and handed over as pixels.
  //
  // THREE DEVICE PIXELS PER CSS PIXEL, DECLARED AS pixelRatio. The bitmap is 60
  // square and MapLibre is told it represents a 20pt icon, so it draws at 20pt
  // with three samples per pixel to draw it from. Getting the ratio wrong here
  // is the one way this comes out soft: the same 60px bitmap declared at ratio 1
  // would be drawn at 60pt and be three times too large, and declared without a
  // ratio at all would be scaled down by the renderer with no extra detail to
  // show for it.
  //
  // ON style.load AND NOT ON load, for the same reason setProjection is: the
  // image registry belongs to the style, and a style reload would take the image
  // with it. hasImage guards the re-entry.
  //
  // A FAILURE HERE IS REPORTED, NOT SWALLOWED. Without the image the symbol
  // layer draws nothing at all and MapLibre says so only in its own console, so
  // an aircraft that silently stopped appearing would look like a data problem.
  function addPlaneImage() {
    try {
      if (map.hasImage('aircraft')) return;
      var n = PLANE_PX * PLANE_DPR;
      var cv = document.createElement('canvas');
      cv.width = n;
      cv.height = n;
      var cx = cv.getContext('2d');
      // The path is authored in a 64-unit box; this maps that box onto the
      // bitmap, so the shape's own coordinates never have to know the raster
      // size and PLANE_PX can change without touching the path.
      cx.scale(n / 64, n / 64);
      cx.fillStyle = PLANE_INK;
      // 'nonzero' SPELLED OUT, though it is the default. It is what unions the
      // three subpaths into one silhouette; 'evenodd' would cut the wings and
      // the tailplane out of the fuselage where they overlap it.
      cx.fill(new Path2D(PLANE_PATH), 'nonzero');
      map.addImage('aircraft', cx.getImageData(0, 0, n, n), { pixelRatio: PLANE_DPR });
    } catch (e) {
      err('icon', 'aircraft image failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // AND THE BELT TO THAT BRACES. MapLibre fires styleimagemissing when a symbol
  // layer asks for an image the registry does not have, which is exactly the
  // failure mode the eager call above exists to avoid -- and if the ordering
  // ever changes under us, this is what keeps the aircraft on the map instead of
  // leaving a warning in a console nobody is reading. hasImage makes it a no-op
  // in the ordinary case.
  map.on('styleimagemissing', function (e) {
    if (e && e.id === 'aircraft') addPlaneImage();
  });

  map.on('style.load', function () {
    STAGE = 'projection';
    try {
      map.setProjection({ type: 'globe' });
    } catch (e) {
      err('projection', 'setProjection failed: ' + (e && e.message ? e.message : String(e)));
    }
    addPlaneImage();
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
    var far = km > ${HOME_PULLBACK_KM};
    post({ type: 'flyHome', km: Math.round(km), far: far });
    var opts = { center: [h.lon, h.lat], zoom: z, duration: far ? dur : ${AIRPORT_NEAR_MS} };
    if (far) opts.minZoom = ${GLOBE_APEX_ZOOM};
    map.flyTo(opts);
  }

  // ── GOING HOME, AS A JOURNEY OR AS A FACT ─────────────────────────────────
  //
  // TWO CALLERS THAT MEAN DIFFERENT THINGS, so they get different motions.
  //
  //   PRESSING THE BUTTON IS ASKING TO TRAVEL. The user is somewhere, chose to
  //   go home, and the flight is the answer to that choice — it shows them the
  //   distance they just crossed.
  //
  //   COMING BACK TO THE TAB IS NOT. They left from one place, did something
  //   else, and returned; playing a three second flight from wherever the camera
  //   was abandoned is a journey nobody asked to watch, and it happens on every
  //   single return. The camera should simply already BE home.
  //
  // cancelCamera FIRST IN BOTH CASES, so a press or a return during a route
  // flight stops that flight rather than racing it — the rAF loop would
  // otherwise keep writing the centre underneath the new motion.
  function goHome(animate) {
    cancelCamera();
    // WHETHER THE PAGE KNOWS WHERE HOME IS, reported rather than silently
    // skipped. homeView is null until React Native has called setHome, which it
    // only does once the style has parsed AND the home has resolved; if either
    // never happens this is a no-op and used to say nothing at all.
    post({ type: 'homeGo', known: !!homeView, animate: !!animate });
    // applyHome's second argument is the same flag setHome already passes as
    // false for the opening view — a jump there and a jump here are the same
    // operation, so there is one code path and not two.
    if (homeView) applyHome(homeView, !!animate);
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

  // ── SAVED FLIGHTS, THE AIRCRAFT ON THEM, AND THE TERMINATOR ────────────────
  //
  // ALL THREE ARE COMPUTED IN HERE, NOT IN REACT NATIVE, and that is a decision
  // about the bridge. React Native sends the flight list once when it changes,
  // and after that sends nothing but a timestamp once a minute. If the arcs were
  // built on the other side they would be re-sent every minute — twenty flights
  // at 64 points each is about 30KB of JSON per tick, for geometry that has not
  // moved. The page holds the list and recomputes what the clock actually
  // changes: which arcs are live, where the aircraft are, and where night is.
  var FLIGHTS = [];
  var NOW = Date.now();
  var RAD = Math.PI / 180;

  function fc(features) { return { type: 'FeatureCollection', features: features }; }

  // ── GREAT CIRCLES, SAMPLED ─────────────────────────────────────────────────
  //
  // SLERP ON UNIT VECTORS, the same construction the camera's route flight uses.
  // A two-point LineString is NOT enough: MapLibre draws the segment between two
  // vertices as a straight line in whatever projection is current, so a
  // Delhi-to-New-York pair would render as a straight Mercator gash rather than
  // the arc an aircraft flies. Sixty-four samples is smooth at every zoom this
  // map allows and is computed once per flight, not per frame.
  function arcPoints(a, b, n) {
    var av = [Math.cos(a[1] * RAD) * Math.cos(a[0] * RAD),
              Math.cos(a[1] * RAD) * Math.sin(a[0] * RAD),
              Math.sin(a[1] * RAD)];
    var bv = [Math.cos(b[1] * RAD) * Math.cos(b[0] * RAD),
              Math.cos(b[1] * RAD) * Math.sin(b[0] * RAD),
              Math.sin(b[1] * RAD)];
    var d = av[0] * bv[0] + av[1] * bv[1] + av[2] * bv[2];
    d = d > 1 ? 1 : (d < -1 ? -1 : d);
    var om = Math.acos(d);
    var so = Math.sin(om);
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var p;
      if (so < 1e-8) { p = av; } else {
        var s1 = Math.sin((1 - t) * om) / so, s2 = Math.sin(t * om) / so;
        p = [av[0] * s1 + bv[0] * s2, av[1] * s1 + bv[1] * s2, av[2] * s1 + bv[2] * s2];
      }
      out.push([Math.atan2(p[1], p[0]) / RAD,
                Math.atan2(p[2], Math.sqrt(p[0] * p[0] + p[1] * p[1])) / RAD]);
    }
    return out;
  }

  // ── WHICH WAY IS IT POINTING ───────────────────────────────────────────────
  //
  // THE INITIAL BEARING FROM a TO b, in degrees clockwise from north, which is
  // exactly what icon-rotate wants for an icon drawn nose-up.
  //
  // A GREAT CIRCLE'S BEARING CHANGES ALONG IT, which is the whole reason this is
  // computed per position rather than once per flight: a London-to-Tokyo track
  // leaves on one heading and arrives on a very different one, and an aircraft
  // holding the departure bearing would visibly disagree with the curve drawn
  // underneath it. Taking the bearing between the two samples either side of the
  // aircraft is the tangent to that curve at the point it is standing on.
  //
  // THE ANTIMERIDIAN NEEDS NO SPECIAL CASE HERE. dlo can come out near a full
  // turn when the pair straddles 180, and sin and cos do not care -- they are
  // periodic, so sin(-359 degrees) is sin(1 degree). The line splitting below
  // exists because a RENDERER joins vertices in a straight line; trigonometry
  // has no such problem.
  function bearing(a, b) {
    var la1 = a[1] * RAD, la2 = b[1] * RAD, dlo = (b[0] - a[0]) * RAD;
    var y = Math.sin(dlo) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // ── THE ANTIMERIDIAN ───────────────────────────────────────────────────────
  //
  // A LINE THAT CROSSES 180 HAS TO BE CUT. Longitudes wrap, so consecutive
  // samples either side of the date line differ by nearly 360 — and a renderer
  // told to join them draws a line the whole way back across the map. Splitting
  // wherever a step exceeds half a turn leaves two segments that each behave.
  function splitArc(pts) {
    var segs = [], cur = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i][0] - pts[i - 1][0]) > 180) { segs.push(cur); cur = []; }
      cur.push(pts[i]);
    }
    if (cur.length > 1) segs.push(cur);
    return segs.filter(function (s) { return s.length > 1; });
  }

  // ── WHERE THE SUN IS ───────────────────────────────────────────────────────
  //
  // STANDARD LOW-PRECISION SOLAR POSITION, good to about a minute of arc, which
  // is far finer than a terminator drawn as a soft band can show. No data source
  // and no network: the date is the whole input.
  function subsolar(ms) {
    var n = ms / 86400000 + 2440587.5 - 2451545.0;      // days since J2000
    var L = (280.460 + 0.9856474 * n) % 360;            // mean longitude
    var g = ((357.528 + 0.9856003 * n) % 360) * RAD;    // mean anomaly
    var lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    var eps = (23.439 - 0.0000004 * n) * RAD;           // obliquity
    var dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    var lon = ((ra / RAD - gmst * 15) % 360 + 540) % 360 - 180;
    return { dec: dec, lon: lon };
  }

  // ── THE NIGHT SIDE, AS THREE NESTED BANDS ──────────────────────────────────
  //
  // THE TERMINATOR IS lat = atan(-cos(lon - subsolar) / tan(declination)), the
  // great circle ninety degrees from the sun. The night polygon is that curve
  // closed to whichever pole the sun is not over.
  //
  // THREE BANDS BECAUSE A FILL HAS A HARD EDGE. MapLibre gives no blur on a
  // fill, so a single polygon would put a drawn line across the planet — exactly
  // what a terminator is not. Three polygons, each pushed a few degrees further
  // into night and each at a tenth of an alpha, accumulate to a soft ramp
  // instead: 0.10 at the edge, 0.20 behind it, 0.30 deep in the dark.
  //
  // THE OFFSET IS A LATITUDE SHIFT AND THEREFORE AN APPROXIMATION. A true
  // parallel circle at 96 or 102 degrees from the sun is not a constant latitude
  // offset from the one at 90. For a soft edge nobody measures, the error is
  // invisible; for anything claiming to be civil or nautical twilight it would
  // not be, and this does not claim that.
  //
  // THE DECLINATION IS CLAMPED AWAY FROM ZERO. At an equinox tan(dec) goes to
  // nothing and the formula sends every longitude to a pole — a degenerate
  // polygon. Half a degree of floor keeps the shape valid for the few hours
  // twice a year when it would otherwise collapse.
  function nightBands(ms) {
    var s = subsolar(ms);
    var dec = s.dec;
    if (Math.abs(dec) < 0.5 * RAD) dec = (dec < 0 ? -1 : 1) * 0.5 * RAD;
    var pole = dec > 0 ? -90 : 90;
    var dir = dec > 0 ? -1 : 1;
    var out = [];
    for (var band = 0; band < 3; band++) {
      var off = band * 6 * dir;
      var ring = [];
      for (var lon = -180; lon <= 180; lon += 3) {
        var lat = Math.atan(-Math.cos((lon - s.lon) * RAD) / Math.tan(dec)) / RAD + off;
        if (lat > 89.5) lat = 89.5;
        if (lat < -89.5) lat = -89.5;
        ring.push([lon, lat]);
      }
      ring.push([180, pole], [-180, pole], ring[0]);
      out.push({ type: 'Feature', properties: { band: band },
                 geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    return out;
  }

  // ── REBUILD, ON A FLIGHT LIST CHANGE OR A MINUTE TICK ──────────────────────
  //
  // BOTH QUESTIONS ARE READ FROM THE CLOCK, not sent as flags. A flag would be
  // true for as long as it took the next tick to arrive and would need
  // re-sending on every one; the departure and arrival instants do not move, so
  // the page can answer for itself and the arc, the aircraft and the tick all
  // agree by construction rather than by being kept in step.
  //
  // TWO QUESTIONS, NOT ONE, AND THEY ARE NOT OPPOSITES. 'past' decides how the
  // ARC is drawn -- green until the arrival time goes by, grey after it. 'live'
  // decides whether there is an AIRCRAFT to draw at all, which needs the flight
  // to be between its two instants. A flight departing on Friday is not past and
  // not live: a green arc with nothing on it, which is the right picture.
  function rebuild() {
    var arcs = [], planes = [];
    for (var i = 0; i < FLIGHTS.length; i++) {
      var f = FLIGHTS[i];
      // AN UNKNOWN ARRIVAL IS NOT PAST. A route whose record carried no ISO time
      // cannot be shown to be over, and the null must be tested rather than
      // compared: null coerces to 0 in a numeric comparison, so NOW > f.arr
      // alone would file every timeless route as having landed at the epoch.
      var past = f.arr !== null && NOW > f.arr;
      var live = f.dep !== null && f.arr !== null && NOW >= f.dep && NOW <= f.arr;
      for (var s = 0; s < f.segs.length; s++) {
        arcs.push({ type: 'Feature', properties: { past: past ? 1 : 0 },
                    geometry: { type: 'LineString', coordinates: f.segs[s] } });
      }
      if (live) {
        // LINEAR IN TIME, AND THAT IS THE HONEST CHOICE. A real flight climbs,
        // cruises, descends, holds and is pushed about by wind, so its position
        // is not a constant fraction of a great circle. Modelling a climb
        // profile would move the aircraft somewhere equally wrong while implying
        // the opposite.
        var t = (NOW - f.dep) / (f.arr - f.dep);
        if (t < 0) t = 0; if (t > 1) t = 1;
        var idx = Math.round(t * (f.pts.length - 1));
        // THE TANGENT AT THE POINT IT IS STANDING ON, taken across the sample
        // before and the sample after so the nose follows the curve rather than
        // the chord from the airport it left. At the ends the window is clamped
        // and becomes one-sided, which is the same tangent measured over half
        // the span -- a 64-sample arc has no segment long enough for that to
        // show.
        var i0 = idx > 0 ? idx - 1 : 0;
        var i1 = idx < f.pts.length - 1 ? idx + 1 : f.pts.length - 1;
        planes.push({ type: 'Feature',
                      properties: { heading: bearing(f.pts[i0], f.pts[i1]) },
                      geometry: { type: 'Point', coordinates: f.pts[idx] } });
      }
    }
    map.getSource('arcs').setData(fc(arcs));
    map.getSource('planes').setData(fc(planes));
    map.getSource('night').setData(fc(nightBands(NOW)));
    post({ type: 'overlay', arcs: FLIGHTS.length, planes: planes.length });
  }

  function setFlights(list) {
    FLIGHTS = list.map(function (f) {
      var pts = arcPoints(f.a, f.b, 64);
      return { a: f.a, b: f.b, dep: f.dep, arr: f.arr, pts: pts, segs: splitArc(pts) };
    });
    rebuild();
  }

  function tick(ms) { NOW = ms; rebuild(); }

  // ── HIDING WHAT IS OVER ────────────────────────────────────────────────────
  //
  // A LAYER FILTER, NOT A REBUILD AND NOT A SECOND LAYER. The features are
  // already tagged with the answer, so this is the renderer skipping some of
  // them -- no geometry is recomputed, nothing crosses the bridge but a boolean,
  // and a filter SURVIVES setData, so the next minute tick does not put the
  // hidden arcs back.
  //
  // null CLEARS THE FILTER rather than setting one that matches everything.
  // MapLibre treats a null filter as "no filtering at all" and skips the
  // per-feature evaluation entirely.
  function setShowPast(on) {
    map.setFilter('arcs', on ? null : ['!=', ['get', 'past'], 1]);
    post({ type: 'showPast', on: !!on });
  }

  window.__cam = {
    airport: flyAirport,
    route: flyRoute,
    setHome: function (h) { applyHome(h, false); },
    home: function () { goHome(true); },
    homeNow: function () { goHome(false); },
    probe: probe,
    flights: setFlights,
    tick: tick,
    past: setShowPast
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

// -- A FLIGHT, AS THE MAP NEEDS IT --------------------------------------------
//
// COORDINATES, NOT CODES. The page has no index from IATA to a position -- its
// airport data is one baked GeoJSON blob, and searching 1,223 features per
// flight to rebuild something this side already knows would be work done twice
// in the slower place. Resolution happens here, where airportByCode is the same
// lookup the search and the panel use.
//
// TWO INSTANTS AND NOTHING ELSE. No status flag, no "is it airborne". Departure
// and arrival do not move, so the page can answer that question itself against
// whatever clock it was last given, and the arc, the aircraft and the tick then
// agree by construction rather than by being kept in step.
//
// EITHER INSTANT MAY BE NULL, and that is a real state rather than a defensive
// one. A saved record from before the schema carried ISO times has nothing to
// read, and a flight whose airports have no IANA zone cannot be put on a clock
// at all — see lib/time. Such a route still HAS two ends, so it still draws;
// what it cannot claim is that anything is flying along it. The page reads a
// null as "not live", which means the planned weight and no aircraft.
export type MapFlight = {
  a: [number, number];
  b: [number, number];
  dep: number | null;
  arr: number | null;
};

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
  // The button. Takes nothing, because the page already knows where home is.
  goHome: () => void;
  // THE SAME PLACE WITHOUT THE JOURNEY, for returning to the tab: the camera is
  // put home with no animation at all, so a user coming back finds it there
  // rather than watching it arrive.
  jumpHome: () => void;
  // THE FLIGHTS DRAWN ON THE GLOBE. Replaced whole on every change, because the
  // set is small and a diff would be more code than the work it saves.
  setFlights: (flights: MapFlight[]) => void;
  // THE CLOCK, ONCE A MINUTE. The page holds the flight list and recomputes what
  // time actually changes -- which arcs are live, where the aircraft are, and
  // where night is -- so a tick is one number across the bridge rather than
  // several kilobytes of geometry that has not moved.
  tick: (ms: number) => void;
  // WHETHER ARCS OF FLIGHTS THAT HAVE LANDED ARE DRAWN AT ALL. A filter on a
  // layer whose features are already tagged, so this costs one boolean across
  // the bridge and no geometry -- see setShowPast in the page.
  setShowPast: (on: boolean) => void;
  // DIAGNOSTIC. Asks the page to report what it is actually holding, which is
  // the one thing React cannot see: homeView and the pin source live in the
  // WebView and survive anything that happens on this side.
  probe: (tag: string) => void;
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
      jumpHome() {
        console.log('[HOME] jump home (focus return, no animation)');
        call('window.__cam&&window.__cam.homeNow()');
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
      setFlights(flights: MapFlight[]) {
        call(`window.__cam&&window.__cam.flights(${JSON.stringify(flights)})`);
      },
      tick(ms: number) {
        call(`window.__cam&&window.__cam.tick(${ms})`);
      },
      setShowPast(on: boolean) {
        call(`window.__cam&&window.__cam.past(${on ? 'true' : 'false'})`);
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
        // ── THE NATIVE HALF OF THE SAME FIX ──
        //
        // menuItems={[]} IS THE CROSS-PLATFORM LEVER. react-native-webview
        // documents an empty array as suppressing the selection menu outright,
        // and it is the one selection prop marked for both ios and android;
        // suppressMenuItems is iOS-only and would have left Android as it was.
        //
        // allowsLinkPreview AND dataDetectorTypes ARE iOS ONLY and close the two
        // remaining long-press behaviours there: the link preview that a long
        // press can raise, and the automatic linkifying of anything that looks
        // like a phone number or address, which a map full of place names is
        // well placed to trip.
        //
        // NONE OF THIS REACHES THE AIRPORT PANEL. That is React Native text
        // outside the WebView entirely; these props end at the web view's
        // boundary and cannot make it unselectable.
        menuItems={[]}
        allowsLinkPreview={false}
        dataDetectorTypes="none"
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
          if (m.type === 'showPast') {
            console.log(`[MAP] past arcs ${m.on ? 'shown' : 'hidden'}`);
          }
          if (m.type === 'overlay') {
            console.log(`[MAP] overlay: ${m.arcs} flights, ${m.planes} in the air`);
          }
          if (m.type === 'homeGo') {
            console.log(m.known
              ? `[HOME] 7. page going home (${m.animate ? 'flight' : 'jump'})`
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
