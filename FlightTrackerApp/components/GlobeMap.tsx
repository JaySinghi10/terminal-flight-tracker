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
import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { allAirports } from '../lib/airports';

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
const ROAD_LINE = 'rgba(255,255,255,0.10)';
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
const AIRPORT_FULL_ZOOM = 6;

// MOTORWAYS ONLY, AND ONLY WHEN CLOSE. At z9 the viewport is roughly 40km
// across, which is a city rather than a country — the zoom at which a road is
// telling you something about where you are instead of drawing a net over a
// continent. Nothing else from `transportation` is drawn at any zoom.
const ROAD_MIN_ZOOM = 9;

const START_LON = 72;
const START_LAT = 24;
const START_ZOOM = 2.2;

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
    // THE ONLY ROAD LAYER THERE IS. class == motorway, and not before z9.
    {
      id: 'motorway',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      minzoom: ROAD_MIN_ZOOM,
      filter: ['==', ['get', 'class'], 'motorway'],
      paint: {
        'line-color': ROAD_LINE,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
      },
    },
    // TWO CLASSES OF NAME AND NOTHING ELSE — no villages, no water names, no
    // road names. A country is the subject; a city is an annotation on one.
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
    // THE AIRPORTS, ON TOP OF EVERYTHING. The only green on the map.
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
window.addEventListener('error', function (e) {
  err(STAGE, 'uncaught: ' + (e && e.message ? e.message : 'unknown'));
});
window.addEventListener('unhandledrejection', function (e) {
  err(STAGE, 'unhandled rejection: ' + (e && e.reason ? String(e.reason) : 'unknown'));
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

export default function GlobeMap() {
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
          if (m.type === 'style') console.log('[MAP] style parsed, globe attached');
          if (m.type === 'ready') console.log('[MAP] tiles in, first idle');
        }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  web: { flex: 1, backgroundColor: OCEAN },
});
