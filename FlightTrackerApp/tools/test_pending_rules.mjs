// THE PENDING RULES, UNDER PLAIN NODE. lib/pendingRules.ts imports nothing
// from React Native, so it is compiled to a temp directory with the project's
// own tsc and exercised here. No storage, no network, no app.
//
//   node tools/test_pending_rules.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'pending-rules-'));
execSync(`npx tsc lib/pendingRules.ts --outDir "${out}" --module es2022 --target es2022 --moduleResolution node --skipLibCheck`, { stdio: 'inherit' });
const R = await import(pathToFileURL(join(out, 'pendingRules.js')).href);

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '   -> ' + JSON.stringify(detail)); }
};

const leg = (over = {}) => R.pendingFromLeg({
  flight_number: 'qp1133', date: '2027-01-15', departure_time: '05:40',
  origin: 'BOM', origin_name: null, destination: 'BLR', destination_name: null,
  airline: 'Akasa Air', operated_by: null, operating_flight_number: null, pnr: 'M4Q7PZ',
  source: { subject: 'Booking confirmed', received: '2026-12-28' }, ...over,
}, 1000);

console.log('-- shape --');
const p = leg();
check('the id is the marketing number and the date, as makeFlightId spells it', p.id === 'QP1133|2027-01-15', p.id);
check('the number is upper-cased', p.flightNumber === 'QP1133');
check('untried on arrival', p.tries === 0 && p.lastTriedAt === null);

console.log('-- past --');
check('yesterday is past', R.isPast(leg({ date: '2026-09-07' }), '2026-09-08'));
check('today is not', !R.isPast(leg({ date: '2026-09-08' }), '2026-09-08'));
check('a malformed date is never past', !R.isPast(leg({ date: 'unknown' }), '2026-09-08'));

console.log('-- once a day --');
check('never retried is due', R.dueToday(null, '2026-09-08'));
check('retried today is not', !R.dueToday('2026-09-08', '2026-09-08'));
check('retried yesterday is', R.dueToday('2026-09-07', '2026-09-08'));

console.log('-- lookup order --');
check('marketing only when no operating number', JSON.stringify(R.lookupOrder(leg())) === '["QP1133"]');
check('operating first, then marketing', JSON.stringify(R.lookupOrder(leg({ flight_number: 'BA1502', operating_flight_number: 'AA100' }))) === '["AA100","BA1502"]');
check('an operating number equal to the marketing one is not tried twice', JSON.stringify(R.lookupOrder(leg({ operating_flight_number: 'QP1133' }))) === '["QP1133"]');

console.log('-- adding --');
let list = [];
let r = R.addToPending(list, leg(), '2026-09-08');
check('a future leg is added', r.ok && r.pending.length === 1);
list = r.pending;
r = R.addToPending(list, leg(), '2026-09-08');
check('the same leg again is a dup, and the stored copy is kept', !r.ok && r.reason === 'dup' && r.pending === list);
r = R.addToPending(list, leg({ date: '2026-09-01' }), '2026-09-08');
check('a past leg is refused at the door', !r.ok && r.reason === 'past');
let full = [];
for (let i = 0; i < R.MAX_PENDING; i++) full = R.addToPending(full, leg({ flight_number: 'AI' + (100 + i) }), '2026-09-08').pending;
r = R.addToPending(full, leg({ flight_number: 'AI999' }), '2026-09-08');
check('the cap holds at MAX_PENDING', !r.ok && r.reason === 'limit' && full.length === R.MAX_PENDING);

console.log('-- the retry batch --');
const mixed = [
  { ...leg({ flight_number: 'AA1' }), date: '2026-09-01' },                  // past: dropped
  { ...leg({ flight_number: 'AA2' }), lastTriedAt: 5000, tries: 3 },          // tried recently
  { ...leg({ flight_number: 'AA3' }), lastTriedAt: null, tries: 0 },          // never tried: first
  { ...leg({ flight_number: 'AA4' }), lastTriedAt: 100, tries: 1 },           // tried long ago: second
];
const b = R.retryBatch(mixed, '2026-09-08', new Set());
check('past legs are dropped, not retried', b.dropped.length === 1 && b.dropped[0].flightNumber === 'AA1');
check('the rest are kept', b.kept.length === 3);
check('oldest-tried first, never-tried before that', b.batch.map(x => x.flightNumber).join() === 'AA3,AA4,AA2', b.batch.map(x => x.flightNumber));
const skipped = R.retryBatch(mixed, '2026-09-08', new Set(['AA3|2027-01-15']));
check('skipIds leaves a leg the pull just tried alone', !skipped.batch.some(x => x.flightNumber === 'AA3'));
const capped = R.retryBatch(full, '2026-09-08', new Set(), 3);
check('the batch is capped', capped.batch.length === 3);

console.log('-- the trigger --');
let events = [];
const ev = { id: 'QP1133|2027-01-15', flightNumber: 'QP1133', savedFlightNumber: 'QP1133', savedId: 'QP1133|2027-01-15',
  date: '2027-01-15', origin: 'BOM', destination: 'BLR', pnr: 'M4Q7PZ', resolvedAt: 1, how: 'daily', delivered: false };
events = R.appendResolved(events, ev);
check('a resolution is recorded undelivered', events.length === 1 && events[0].delivered === false);
events = R.appendResolved(events, { ...ev, resolvedAt: 2, how: 'pull' });
check('the same leg resolving twice is one event, not two notifications', events.length === 1);
let many = [];
for (let i = 0; i < R.MAX_RESOLVED_EVENTS + 5; i++) many = R.appendResolved(many, { ...ev, id: 'X' + i });
check('the queue is bounded', many.length === R.MAX_RESOLVED_EVENTS);
check('and keeps the newest', many[many.length - 1].id === 'X' + (R.MAX_RESOLVED_EVENTS + 4));

console.log(`\nPASSED: ${pass}   FAILURES: ${fail}`);
process.exit(fail ? 1 : 0);
