// THE MAP'S CDN LOADER, UNDER PLAIN NODE.
//
// WHY THIS EXISTS. The loader is JavaScript inside a template literal inside a
// .tsx file: it is a string as far as TypeScript is concerned, so tsc checks
// nothing about it and the compiler cannot see a typo in it. It also only ever
// runs inside a WebView on a phone, against network conditions that cannot be
// produced on demand. Both of those are reasons to test it here rather than
// reasons to leave it untested.
//
// WHAT IS TESTED IS THE REAL SOURCE. The loader region is cut out of
// components/GlobeMap.tsx verbatim, its three interpolations are filled in with
// test values, and it runs against a fake document whose script tags succeed,
// fail, stall or serve rubbish on command. Nothing is retyped here, so this
// cannot drift from what ships.
//
//   node tools/test_map_loader.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'components', 'GlobeMap.tsx'), 'utf8');

// ── CUTTING THE LOADER OUT ──────────────────────────────────────────────────
const OPEN = 'var CDNS = ${JSON.stringify(CDNS)};';
const CLOSE = '\nfunction start() {';
const a = SRC.indexOf(OPEN);
const b = SRC.indexOf(CLOSE, a);
if (a < 0 || b < 0) {
  console.log('FAILED: could not find the loader region in GlobeMap.tsx');
  process.exit(1);
}
// The timers are scaled down so the suite runs in under a second. The values
// are the only thing changed; every branch and every guard is the shipped one.
const STAGGER = 60;
const GIVE_UP = 260;
const LOADER = SRC.slice(a, b)
  .replace('${JSON.stringify(CDNS)}', JSON.stringify([['first', 'https://first/x.js'], ['second', 'https://second/x.js']]))
  .replace('${CDN_STAGGER_MS}', String(STAGGER))
  .replace('${CDN_GIVE_UP_MS}', String(GIVE_UP));

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '   -> ' + JSON.stringify(detail)); }
};

// ── THE FAKE PAGE ───────────────────────────────────────────────────────────
//
// outcomes: what each host does, by name.
//   {kind:'ok', ms}       serves a usable library after ms
//   {kind:'broken', ms}   serves a 200 that leaves no namespace behind
//   {kind:'error', ms}    the request fails outright
//   {kind:'stall'}        connects and is never heard from again
function run(outcomes) {
  return new Promise(resolve => {
    const log = { posts: [], errors: [], starts: 0, diagnosed: 0, appended: [] };
    const win = {};
    const lib = { Map: function () {}, getVersion: () => '5.24.0' };

    const doc = {
      head: {
        appendChild(s) {
          log.appended.push(s.src);
          const host = s.src.includes('first') ? 'first' : 'second';
          const o = outcomes[host];
          if (o.kind === 'stall') return;
          setTimeout(() => {
            if (o.kind === 'error') { if (s.onerror) s.onerror(); return; }
            if (o.kind === 'ok') win.maplibregl = lib;
            if (s.onload) s.onload();
          }, o.ms);
        },
      },
      createElement: () => ({ src: '', async: undefined, crossOrigin: '', onload: null, onerror: null }),
    };

    const scope = {
      window: win,
      document: doc,
      setTimeout,
      Date,
      post: o => log.posts.push(o),
      err: (stage, message) => log.errors.push(stage + ': ' + message),
      diagnose: () => { log.diagnosed++; },
      start: () => { log.starts++; },
      STAGE: 'boot',
    };
    const names = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    new Function(...names, LOADER + '\nloadFrom(0);')(...names.map(k => scope[k]));
    setTimeout(() => resolve(log), GIVE_UP + 160);
  });
}

const cdn = log => log.posts.find(p => p.type === 'cdn');

console.log('-- both hosts healthy --');
let r = await run({ first: { kind: 'ok', ms: 10 }, second: { kind: 'ok', ms: 10 } });
check('the map starts once', r.starts === 1, r.starts);
check('the first host serves it', cdn(r) && cdn(r).host === 'first', r.posts);
check('the second host is never asked', r.appended.length === 1, r.appended);
check('nothing is reported as an error', r.errors.length === 0, r.errors);
check('the report carries how long it took', cdn(r) && typeof cdn(r).ms === 'number', cdn(r));

console.log('\n-- THE BUG: the first host connects and never answers --');
r = await run({ first: { kind: 'stall' }, second: { kind: 'ok', ms: 10 } });
check('the map still starts, exactly once', r.starts === 1, r.starts);
check('the second host is started alongside it', r.appended.length === 2, r.appended);
check('and it is the one that serves the library', cdn(r) && cdn(r).host === 'second', r.posts);
check('the stall is reported rather than passed over in silence',
  r.errors.some(e => e.includes('has not answered')), r.errors);
check('the first host is not abandoned before the stagger expires',
  cdn(r) && cdn(r).ms >= STAGGER, cdn(r));

console.log('\n-- the first host fails outright --');
r = await run({ first: { kind: 'error', ms: 5 }, second: { kind: 'ok', ms: 5 } });
check('the second is tried at once, not after the stagger',
  r.starts === 1 && cdn(r).host === 'second' && cdn(r).ms < STAGGER, cdn(r));
check('the failure names the host', r.errors.some(e => e.includes('fetch failed from first')), r.errors);

console.log('\n-- the first host serves a 200 with no library in it --');
r = await run({ first: { kind: 'broken', ms: 5 }, second: { kind: 'ok', ms: 5 } });
check('the second rescues it', r.starts === 1 && cdn(r).host === 'second', r.posts);
check('and the useless 200 is called what it is',
  r.errors.some(e => e.includes('is not a function')), r.errors);

console.log('\n-- a slow first host still wins if it beats the second --');
r = await run({ first: { kind: 'ok', ms: STAGGER + 20 }, second: { kind: 'ok', ms: 400 } });
check('the map starts once', r.starts === 1, r.starts);
check('the slow host is not cancelled, and it wins', cdn(r) && cdn(r).host === 'first', r.posts);
check('both were in flight', r.appended.length === 2, r.appended);

console.log('\n-- the loser arriving late cannot start a second map --');
r = await run({ first: { kind: 'stall' }, second: { kind: 'ok', ms: 10 } });
check('one start, one cdn report', r.starts === 1 && r.posts.filter(p => p.type === 'cdn').length === 1, r.posts);

console.log('\n-- nothing answers at all --');
r = await run({ first: { kind: 'stall' }, second: { kind: 'stall' } });
check('no map is started', r.starts === 0, r.starts);
check('it gives up rather than waiting for ever',
  r.errors.some(e => e.includes('no CDN produced a usable library')), r.errors);
check('and runs the diagnostic probes once', r.diagnosed === 1, r.diagnosed);

console.log('\n-- both hosts fail outright --');
r = await run({ first: { kind: 'error', ms: 5 }, second: { kind: 'error', ms: 5 } });
check('no map', r.starts === 0, r.starts);
check('the give-up still fires', r.diagnosed === 1, r.diagnosed);

console.log('\n-- the property that makes the race a race --');
check('scripts are async, so the second does not wait for the first to execute',
  /\bs\.async = true\b/.test(LOADER), 'async is not true');
check('jsdelivr leads', /\['jsdelivr'/.test(SRC.slice(SRC.indexOf('const CDNS'), SRC.indexOf('const CDNS') + 200)));

console.log(`\nPASSED: ${pass}   FAILURES: ${fail}`);
process.exit(fail ? 1 : 0);
