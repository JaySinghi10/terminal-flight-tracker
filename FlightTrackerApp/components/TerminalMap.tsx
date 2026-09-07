// The terminal, drawn as a map you can move around in.
//
// ── WHY THIS IS NOT SVG ANY MORE ────────────────────────────────────────────
//
// THE OLD ONE DREW A BUILDING OUTLINE AND UNLABELLED DOTS and nothing on it
// told anyone where anything was. Making it useful means markers, gate numbers,
// pan, zoom and tapping things -- and pan and zoom is the requirement that ends
// the SVG version. react-native-svg re-rasterises its mounted nodes when props
// change, and this is fifty gates plus a hundred outlets plus a hundred-point
// polygon; a pinch would re-rasterise all of it every frame. That is the same
// reason GlobeMap is a WebView and not SVG.
//
// AND THE DATA IS ALREADY GEOGRAPHIC. Rings, gates and -- at Hong Kong -- the
// restaurants themselves all carry longitude and latitude. Projecting that by
// hand into a viewBox was work being done to avoid using a map engine.
//
// ── WHAT IT DOES NOT LOAD, WHICH IS THE POINT ───────────────────────────────
//
// NO TILES AND NO BASEMAP. There is nothing under the building worth drawing --
// an apron and some grass -- and a tile source would mean a network round trip
// per pan at an airport, which is where wifi is worst.
//
// NO GLYPH SERVER, AND THAT IS WHY LABELS ARE HTML MARKERS RATHER THAN SYMBOL
// LAYERS. MapLibre renders text-field by fetching signed-distance-field glyph
// PBFs from a URL; GlobeMap takes those from OpenFreeMap. A gate number that
// needs a download is a gate number that vanishes on a bad connection, so every
// label here is a DOM element the page already has. It also makes hit-testing
// free: a marker is an element, and elements take click handlers.
//
// WHAT IS STILL REMOTE is the MapLibre library itself, from the same two CDNs
// GlobeMap uses and pinned to the same version. Offline on a cold start, the
// map does not come up -- and the screen below it still lists every outlet,
// which is why the list is not merely a fallback.
import { useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { Terminal, Gate } from '../lib/terminals';
import { ORDER_IS_ROUGH } from '../lib/terminals';
import type { Placed } from '../lib/terminalgeo';
import { centreOf } from '../lib/terminalgeo';

export type { Placed } from '../lib/terminalgeo';
export { placeDining } from '../lib/terminalgeo';

// The same pin GlobeMap makes, for the same reasons -- see its note. 6.x ships
// no UMD build, so a plain <script src> cannot put the namespace on window.
const MAPLIBRE = '5.24.0';
const CDNS: [string, string][] = [
  ['unpkg', `https://unpkg.com/maplibre-gl@${MAPLIBRE}/dist/maplibre-gl.js`],
  ['jsdelivr', `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE}/dist/maplibre-gl.js`],
];

const INK = '#e2e2e2';
const DIM = 'rgba(226,226,226,0.4)';
const DIMMER = 'rgba(226,226,226,0.28)';
const GREEN = '#4ade80';
const AMBER = '#fbbf24';
const PAGE = '#0b0b0c';

export type MapPick =
  | { kind: 'outlet'; id: string }
  | { kind: 'here'; lon: number; lat: number };

type Props = {
  terminal: Terminal;
  placed: Placed[];
  /** Outlets in this terminal we could not put anywhere. Counted, not drawn. */
  unplacedCount: number;
  arrival: Gate | null;
  departure: Gate | null;
  here: { lon: number; lat: number } | null;
  onPick: (p: MapPick) => void;
};

// JSON INTO A <script> BLOCK. A restaurant called something with "</script>" in
// it would end the block early; escaping the angle bracket is the one-line
// defence and costs nothing.
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildHtml(
  t: Terminal, placed: Placed[], arrival: Gate | null, departure: Gate | null,
  here: { lon: number; lat: number } | null,
): string {
  const centre = centreOf(t);
  const data = {
    rings: t.rings,
    bbox: t.bbox,
    // ONE ENTRY PER GATE WITH ITS INDEX AS THE KEY, and the index is not
    // decoration. OpenStreetMap has three separate stands signed A6 at JFK
    // Terminal 4 and two signed A7, so `ref` is not unique and using it as a
    // React key raised a duplicate-key warning on screen. The index is unique
    // by construction.
    gates: t.gates.map((g, i) => ({
      i, ref: g.ref, lon: g.lon, lat: g.lat,
      role: arrival !== null && g === arrival ? 'arr'
        : departure !== null && g === departure ? 'dep' : '',
    })),
    outlets: placed.map(p => ({
      id: p.d.sourceId, name: p.d.name, lon: p.lon, lat: p.lat,
      // A GATE-DERIVED POSITION IS DRAWN DIFFERENTLY FROM A REAL ONE. See
      // lib/terminalgeo: one is where the outlet is, the other is where the
      // aircraft parks, and a map that draws them identically is claiming a
      // precision it does not have.
      loose: p.source === 'gate' ? 1 : 0,
      span: p.gateSpan,
    })),
    here,
    centre,
  };

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:${PAGE};overflow:hidden;
    -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
  #m{position:absolute;inset:0;}
  .maplibregl-ctrl-attrib,.maplibregl-ctrl-logo{display:none!important;}
  .mk{display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;}
  .lbl{font:11px -apple-system,system-ui,sans-serif;color:${INK};
    text-shadow:0 0 3px ${PAGE},0 0 3px ${PAGE},0 0 3px ${PAGE};display:none;}
  body.zoomed .lbl{display:inline;}
  .g .dot{width:5px;height:5px;background:${DIMMER};}
  .g .lbl{font:10px ui-monospace,monospace;color:${DIM};}
  .g.arr .dot,.g.dep .dot{width:9px;height:9px;background:${GREEN};}
  .g.dep .dot{background:${AMBER};}
  .g.arr .lbl,.g.dep .lbl{display:inline;color:${INK};}
  .o .dot{background:${INK};box-shadow:0 0 0 2px ${PAGE};}
  /* A HOLLOW DOT FOR A GATE-DERIVED POSITION. Filled means "this is where it
     is"; hollow means "it is near this gate", and the difference is the whole
     honesty of the layer. */
  .o.loose .dot{background:transparent;border:2px solid ${INK};width:10px;height:10px;}
  .here{width:16px;height:16px;border-radius:50%;background:${GREEN};
    border:3px solid ${PAGE};box-shadow:0 0 0 2px ${GREEN};}
</style></head><body>
<div id="m"></div>
<script>
var D = ${embed(data)};
var CDNS = ${embed(CDNS)};
function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function err(stage,msg){post({type:'error',stage:stage,message:String(msg)});}
window.onerror=function(m,f,l){err('window',m+' @'+l);};

function loadFrom(i){
  if(i>=CDNS.length){err('script','every CDN failed');return;}
  var s=document.createElement('script');
  s.src=CDNS[i][1];s.async=false;s.crossOrigin='anonymous';
  s.onerror=function(){err('script','fetch failed from '+CDNS[i][0]);loadFrom(i+1);};
  s.onload=function(){
    if(!window.maplibregl||typeof window.maplibregl.Map!=='function'){
      err('script',CDNS[i][0]+' served the script but maplibregl.Map is missing');
      loadFrom(i+1);return;
    }
    post({type:'cdn',host:CDNS[i][0]});
    start();
  };
  document.head.appendChild(s);
}

function start(){
  var map=new maplibregl.Map({
    container:'m',
    // NO TILES AND NO GLYPHS. A background layer and our own GeoJSON. See the
    // note at the top of the component.
    style:{version:8,sources:{},layers:[
      {id:'bg',type:'background',paint:{'background-color':'${PAGE}'}}]},
    center:[D.centre.lon,D.centre.lat],
    zoom:15,
    attributionControl:false,
    // A SCHEMATIC HAS NO NORTH THE READER CARES ABOUT, but rotating it makes
    // the concourse unreadable against the labels. Pan and zoom only.
    pitchWithRotate:false,
    dragRotate:false,
    touchZoomRotate:true
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'bottom-right');

  map.on('load',function(){
    map.addSource('term',{type:'geojson',data:{type:'Feature',properties:{},
      geometry:{type:'Polygon',coordinates:D.rings}}});
    map.addLayer({id:'fill',type:'fill',source:'term',
      paint:{'fill-color':'#1b1b1e','fill-opacity':0.9}});
    map.addLayer({id:'edge',type:'line',source:'term',
      paint:{'line-color':'${DIM}','line-width':1.5}});

    D.gates.forEach(function(g){
      var el=document.createElement('div');
      el.className='mk g '+(g.role||'');
      el.innerHTML='<span class="dot"></span><span class="lbl"></span>';
      el.querySelector('.lbl').textContent=g.ref;
      new maplibregl.Marker({element:el,anchor:'center'})
        .setLngLat([g.lon,g.lat]).addTo(map);
    });

    D.outlets.forEach(function(o){
      var el=document.createElement('div');
      el.className='mk o '+(o.loose?'loose':'');
      el.innerHTML='<span class="dot"></span><span class="lbl"></span>';
      el.querySelector('.lbl').textContent=o.name;
      el.addEventListener('click',function(ev){
        // WITHOUT THIS THE MAP ALSO SEES THE TAP and moves the "you are here"
        // pin to whatever the reader was trying to read.
        ev.stopPropagation();
        post({type:'pick',id:o.id});
      });
      new maplibregl.Marker({element:el,anchor:'center'})
        .setLngLat([o.lon,o.lat]).addTo(map);
    });

    window.__here=null;
    window.setHere=function(lon,lat){
      if(window.__here){window.__here.remove();window.__here=null;}
      if(lon===null)return;
      var el=document.createElement('div');el.className='here';
      window.__here=new maplibregl.Marker({element:el,anchor:'center'})
        .setLngLat([lon,lat]).addTo(map);
    };
    if(D.here) window.setHere(D.here.lon,D.here.lat);

    map.on('click',function(e){post({type:'here',lon:e.lngLat.lng,lat:e.lngLat.lat});});

    // LABELS APPEAR WHEN THERE IS ROOM FOR THEM. Every gate number and every
    // restaurant name at once, zoomed out, is a grey smear; the dots alone
    // still show the shape of the concourse.
    function zoomClass(){
      document.body.classList.toggle('zoomed',map.getZoom()>=16.4);
    }
    map.on('zoom',zoomClass);zoomClass();

    map.fitBounds([[D.bbox[0],D.bbox[1]],[D.bbox[2],D.bbox[3]]],
      {padding:36,duration:0,maxZoom:17});
    post({type:'ready',gates:D.gates.length,outlets:D.outlets.length});
  });
  map.on('error',function(e){err('map',(e&&e.error&&e.error.message)||'unknown');});
}
loadFrom(0);
</script></body></html>`;
}

export default function TerminalMap({
  terminal, placed, unplacedCount, arrival, departure, here, onPick,
}: Props) {
  const webRef = useRef<WebView>(null);

  // THE PAGE IS REBUILT ONLY WHEN THE TERMINAL OR ITS MARKERS CHANGE. `here` is
  // deliberately NOT in here: a new html string reloads the WebView, and
  // reloading the map every time somebody moves their own pin would throw away
  // their zoom and position -- see the injected call below, which moves one
  // marker instead.
  const html = useMemo(
    () => buildHtml(terminal, placed, arrival, departure, here),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminal, placed, arrival, departure],
  );

  // ── MOVING THE PIN WITHOUT RELOADING THE MAP ──────────────────────────────
  //
  // A NEW html STRING RELOADS THE WEBVIEW, which would throw away the reader's
  // zoom and position every time they told us where they are -- the one gesture
  // that has to feel immediate. So `here` is injected as a call into the page
  // that already exists, and the html memo above deliberately omits it.
  //
  // GUARDED ON window.setHere BECAUSE THE PAGE MAY NOT BE UP. An injection that
  // lands before 'load' finds nothing and does nothing, which is correct: the
  // html was built with the current `here` in it and will place it itself.
  useEffect(() => {
    const js = here === null
      ? 'window.setHere&&window.setHere(null,null)'
      : `window.setHere&&window.setHere(${here.lon},${here.lat})`;
    webRef.current?.injectJavaScript(`try{${js}}catch(e){}; true;`);
  }, [here]);

  const rough = terminal.axisShare < ORDER_IS_ROUGH;

  return (
    <View style={st.wrap}>
      <View style={st.head}>
        <Text style={st.name}>{terminal.key}</Text>
        <Text style={st.count}>
          {placed.length === 0
            ? `${terminal.gates.length} gates`
            : `${placed.length} places · ${terminal.gates.length} gates`}
        </Text>
      </View>

      <View style={st.frame}>
        <WebView
          ref={webRef}
          source={{ html }}
          originWhitelist={['*']}
          androidLayerType="hardware"
          javaScriptEnabled
          domStorageEnabled
          // The map handles its own gestures; the WebView must not also try to
          // scroll, or a drag fights two recognisers.
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          setSupportMultipleWindows={false}
          menuItems={[]}
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          style={st.web}
          onMessage={(e) => {
            let m: { type?: string; id?: string; lon?: number; lat?: number;
              stage?: string; message?: string } | null = null;
            try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
            if (m === null || typeof m !== 'object') return;
            if (m.type === 'error') { console.warn(`[TMAP] ${m.stage}: ${m.message}`); return; }
            if (m.type === 'pick' && typeof m.id === 'string') {
              onPick({ kind: 'outlet', id: m.id });
            }
            if (m.type === 'here' && typeof m.lon === 'number' && typeof m.lat === 'number') {
              onPick({ kind: 'here', lon: m.lon, lat: m.lat });
            }
          }}
        />
      </View>

      {/* ── WHAT THE MAP CANNOT SHOW, SAID ON THE MAP ─────────────────────
          AN EMPTY MAP READS AS BROKEN. FRA, LHR and EWR have terminal
          geometry and no dining coordinates and no gate hints -- 0 of 83,
          0 of 51, 1 of 118 -- so their maps can draw the building and the
          gates and no food at all. That is a gap in what we have scraped,
          not a fault in the map, and the difference has to be on screen or
          somebody will reasonably conclude the feature is broken. */}
      {placed.length === 0 ? (
        <Text style={st.note}>
          {'We have no positions for food in this terminal yet — the airport does not '
            + 'publish them. The map shows the building and its gates; everything to '
            + 'eat is in the list below.'}
        </Text>
      ) : unplacedCount > 0 ? (
        <Text style={st.note}>
          {`${placed.length} of ${placed.length + unplacedCount} places could be put on the map. `
            + 'The rest are in the list below.'}
        </Text>
      ) : null}

      {rough && placed.length > 0 && (
        <Text style={st.note}>
          {'Hollow markers sit at the gate a place names rather than at its own '
            + 'door, so treat them as nearby rather than exact.'}
        </Text>
      )}

      {/* ODbL IS NOT OPTIONAL. Anything that draws this data carries it. */}
      <Text style={st.attrib}>{'Terminal outlines © OpenStreetMap contributors'}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { marginTop: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    paddingHorizontal: 16, marginBottom: 6 },
  name: { fontFamily: 'JetBrainsMono_700Bold', fontSize: 13, color: INK, letterSpacing: 1 },
  count: { fontFamily: 'JetBrainsMono_400Regular', fontSize: 11, color: DIM },
  frame: { height: 320, marginHorizontal: 16, borderRadius: 14, overflow: 'hidden',
    backgroundColor: PAGE },
  web: { flex: 1, backgroundColor: PAGE },
  note: { fontFamily: 'Inter_400Regular', fontSize: 11, color: DIM,
    paddingHorizontal: 16, marginTop: 8, lineHeight: 16 },
  attrib: { fontFamily: 'Inter_400Regular', fontSize: 9, color: DIMMER,
    paddingHorizontal: 16, marginTop: 6 },
});
