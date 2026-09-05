// WHAT A FLIGHT IS DOING, AND HOW LONG UNTIL IT DOES IT.
//
// Every line of this was app/index.tsx's and every line is unchanged. It moved
// because three surfaces read it and only one of them was ever the home screen:
// the watchlist rows, the collapsed summary line, and the flight card all render
// the same status word, the same countdown and the same "updated N ago" tail.
// The card is going to a screen of its own, and two copies of this reasoning is
// the one thing that could make the card and the rows disagree about a flight
// they are both showing.
//
// WHAT IS HERE: the status colour, the countdown arithmetic, the delay segment,
// the date and time formatters those three need, and the two components that put
// them on screen. WHAT IS NOT: anything that decides what a record IS — that is
// lib/saved.tsx's, and effectiveStatus is imported from there rather than
// restated here.
//
// THE ONLY EDIT MADE IN THE MOVE is `export` in front of the ten names another
// module still reads, and the stylesheet at the bottom, which is s.statusLineText
// lifted out of index's own `s` into a local one of the same name so that
// StatusLine's body is character-for-character what it was.
import { Text, StyleSheet } from 'react-native';
import { SavedFlight, SavedFlightEndpoint } from './storage';
// The one implementation of each, exactly as index.tsx reached them. See
// lib/time.ts: there are two kinds of ISO in this app and only one may become an
// instant.
import { zonedIsoToTs, clock24 } from './time';
// THE RULE ABOUT A STORED STATUS, imported rather than copied. It is the store's
// because the refresh loop and the archive split read it too; this file is one
// more reader.
import { effectiveStatus } from './saved';

// Declared here rather than imported from a screen, for the same reason
// profile.tsx and components/GlassTabBar.tsx declare their own: a module
// reaching into a route for a string constant would couple the two. The value is
// the family name _layout registers.
const MONO = 'JetBrainsMono_400Regular';

// HOW FRESH DATA MUST BE TO SHOW A LIVE COUNTDOWN, and the only one of these
// caps left on this screen: it is read by flightLineSegments, which renders. The
// rest protect the quota and moved to lib/saved.tsx with the loop that spends it.
const COUNTDOWN_MAX_AGE_MS = 3 * 60 * 60 * 1000; // how fresh data must be to show a live countdown; lower to 30 * 60 * 1000 or 10 * 60 * 1000 for stricter honesty

export function getStatusColor(status: string) {
  switch (status) {
    case "landed": return "#8e8e93";
    case "active": return "#4ade80";
    case "scheduled": return "#aeaeb2";
    case "delayed": return "#fbbf24";
    case "cancelled": return "#f87171";
    default: return "#fbbf24";
  }
}

function timeAgo(ts: number, now: number) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Sat, 29 Aug" from a YYYY-MM-DD string, or the string itself if unparseable.
// Built from the fixed WEEKDAYS/MONTHS arrays so it never shifts with locale.
export function routeDateLabel(iso: string | null): string {
  if (!iso) return 'Today';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// Header line, e.g. "Sat, 16 Aug - 02:04". Fixed arrays rather than Intl so
// the output never shifts with locale.
//
// 24-hour, matching the route rows. Both parts are zero-padded, so the line is
// the same nineteen characters at every hour and no longer changes width as the
// meridiem comes and goes.
//
// IT WAS app/index.tsx's AND IS UNCHANGED. It moved because THREE screens read
// it now -- home's greeting, My Flights and Bookings -- and a screen must never
// be the place another screen imports from. WEEKDAYS and MONTHS are already
// here, which is the other half of the reason: the helper and the two arrays it
// is built from were on opposite sides of a screen boundary.
export function formatClock(ts: number) {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = String(d.getDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]}, ${day} ${MONTHS[d.getMonth()]} · ${time}`;
}

// "6:40 PM IST" -> "6:40 PM". A departure board omits the origin airport
// object, so departure times arrive with no zone label while arrivals have one;
// dropping the label restores symmetry. Anything without AM/PM is returned
// untouched rather than guessed at — trimming the last token would corrupt an
// unlabelled value like "18:40" or "N/A".
export function stripZoneLabel(t: string): string {
  if (typeof t !== 'string') return '';
  const m = /^(.*?[AP]M)\b/.exec(t);
  return m ? m[1] : t;
}

// THE OTHER HALF OF THE SAME STRING, and it exists because the label is already
// there. stripZoneLabel drops "GMT+4" off "9:40 PM GMT+4"; this returns it.
//
// THE PROVIDER'S OWN LABEL, NOT A DERIVED ONE, which is the whole reason to read
// it rather than compute it: the backend emits a real letter code where the zone
// has one -- "IST", "GMT+4" otherwise -- and an Intl-derived short name would be
// a SECOND answer to the same question, free to disagree with the string printed
// beside it.
//
// THE SAME ANCHOR AS ITS PAIR. Both key on the meridiem, so a value the provider
// sent without one -- an unlabelled "18:40", or the "N/A" it writes for a time
// that does not exist -- yields null here exactly as it passes through
// unchanged there. Null means "no label to show", not "no zone".
//
// ONE ZONE PER ENDPOINT, WHICH IS WHY ANY OF THE THREE STRINGS WILL DO. The
// scheduled, estimated and actual times of one movement are all read at the same
// airport, so the caller can take the label off whichever it has -- and the
// scheduled one is always present.
export function zoneLabel(t: string | null | undefined): string | null {
  if (typeof t !== 'string') return null;
  const m = /[AP]M\s+(\S.*)$/.exec(t.trim());
  return m ? m[1].trim() : null;
}

// --- Live-countdown helpers -------------------------------------------------
export const CD_GREEN = '#4ade80';
const CD_AGE = 'rgba(226,226,226,0.3)';
export const CD_LATE = '#fbbf24';
const CD_EARLY = 'rgba(226,226,226,0.5)';

type LineSeg = { text: string; color: string };

// The backend's *_iso fields carry a bogus "+00:00"; the value is the airport's
// LOCAL wall clock. Strip the offset, treat as naive, interpret in the IANA zone.
// Never use `new Date(iso)` on these directly.
export function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

// scheduled/active: estimated vs scheduled. landed: actual (else estimated) vs scheduled.
function delaySegment(ep: SavedFlightEndpoint, status: string): LineSeg | null {
  const sch = zonedIsoToTs(ep.scheduledIso, ep.timezone);
  const cmpIso = status === 'landed' ? (ep.actualIso ?? ep.estimatedIso) : ep.estimatedIso;
  const cmp = zonedIsoToTs(cmpIso, ep.timezone);
  if (cmp == null || sch == null) return null;
  const diffMin = Math.round((cmp - sch) / 60000);
  if (Math.abs(diffMin) < 5) return null;
  return diffMin > 0
    ? { text: ` · ${diffMin}m late`, color: CD_LATE }
    : { text: ` · ${Math.abs(diffMin)}m early`, color: CD_EARLY };
}

// The status is the CALLER'S, not f.status. Re-reading the record here would let
// this pick the arrival endpoint for a row whose word says scheduled, which is
// precisely the disagreement effectiveStatus exists to remove.
function absoluteTime(f: SavedFlight, status: string): string {
  const s = status;
  if (s === 'landed') {
    return f.to.actual && f.to.actual !== 'N/A'
      ? clock24(f.to.actualIso, f.to.actual)
      : clock24(f.to.scheduledIso, f.to.scheduled);
  }
  if (s === 'active') return clock24(f.to.scheduledIso, f.to.scheduled);
  return clock24(f.from.scheduledIso, f.from.scheduled);
}

// Line-2 / card status line. Always leads with the coloured status word so the
// row still says what the flight is doing when the countdown falls away.
// hideAbsolute IS THE CALLER'S, and it has to be: this function feeds three
// places and only one of them wants the change. The watchlist rows and the
// collapsed summary both show a flight the reader is scanning past, where "dep
// 00:15" is the only clock on the line; the merged card has the whole route
// underneath it and printing the departure again in 11pt grey said nothing the
// 32pt IATA column was not already saying.
//
// Cutting it here for everyone would have taken it off the rows too, which is
// why it is a parameter rather than a deletion.
function flightLineSegments(f: SavedFlight, now: number, hideAbsolute?: boolean): LineSeg[] {
  // NOT f.status. A record claiming to have landed six hours before its own
  // arrival time would otherwise take the landed branch below, read the arrival
  // endpoint, and print a grey "landed" on a flight still sitting at the gate.
  const s = effectiveStatus(f, now);
  const statusSeg: LineSeg = { text: s, color: getStatusColor(s) };
  const fresh = now - f.updatedAt < COUNTDOWN_MAX_AGE_MS;

  let ep: SavedFlightEndpoint | null = null;
  let iso: string | null = null;
  let verb: 'departs in' | 'lands in' | null = null;
  if (s === 'scheduled') { ep = f.from; iso = f.from.estimatedIso ?? f.from.scheduledIso; verb = 'departs in'; }
  else if (s === 'active') { ep = f.to; iso = f.to.estimatedIso ?? f.to.scheduledIso; verb = 'lands in'; }
  else if (s === 'landed') { ep = f.to; iso = f.to.actualIso ?? f.to.estimatedIso ?? f.to.scheduledIso; }

  const ts = fresh && ep ? zonedIsoToTs(iso, ep.timezone) : null;

  if (fresh && ep && ts != null) {
    if (s === 'landed') {
      const ago = now - ts;
      if (ago >= 0) {
        const segs: LineSeg[] = [statusSeg, { text: ` · ${formatCountdown(ago)} ago`, color: 'rgba(226,226,226,0.5)' }];
        const d = delaySegment(ep, s); if (d) segs.push(d);
        return segs;
      }
    } else if (verb) {
      const diff = ts - now;
      if (diff >= 0) {
        const segs: LineSeg[] = [statusSeg, { text: ` · ${verb} ${formatCountdown(diff)}`, color: CD_GREEN }];
        const d = delaySegment(ep, s); if (d) segs.push(d);
        return segs;
      }
    }
  }

  // Fallback: status · updated <age> [· dep|arr <absolute time>]
  const abs = absoluteTime(f, s);
  // WHAT THAT TIME IS. The same slot carries a scheduled departure on one row
  // and an arrival on the next, and unlabelled they are indistinguishable — a
  // bare "21:12" on a landed row and a bare "19:50" on a scheduled one look like
  // the same kind of fact and are not. Airport-board vocabulary, three
  // characters, because the row has to stay one line.
  //
  // Derived from the SAME branch absoluteTime takes, so the label can never name
  // an endpoint the time did not come from.
  const absLabel = s === 'landed' || s === 'active' ? 'arr' : 'dep';
  const tail = abs && abs !== 'N/A' && hideAbsolute !== true
    ? ` · updated ${timeAgo(f.updatedAt, now)} · ${absLabel} ${abs}`
    : ` · updated ${timeAgo(f.updatedAt, now)}`;
  return [statusSeg, { text: tail, color: CD_AGE }];
}

// THE STATUS WORD ON ITS OWN, in the colour that segment carries.
//
// flightLineSegments' FIRST SEGMENT, which is where StatusLine gets it too, so
// the word in the card's heading and the line under the route cannot say
// different things about one flight. Nothing is forked: this reads the same list
// the watchlist rows read and takes the head of it.
//
// The colour is the segment's own — getStatusColor's, applied inline, because it
// varies with the word and a style cannot.
export function StatusWord({ f, now, style }: { f: SavedFlight; now: number; style?: any }) {
  const [head] = flightLineSegments(f, now);
  return <Text style={[style, { color: head.color }]} numberOfLines={1}>{head.text}</Text>;
}

export function StatusLine({ f, now, style, numberOfLines, hideStatus, hideAbsolute }: { f: SavedFlight; now: number; style?: any; numberOfLines?: number; hideStatus?: boolean; hideAbsolute?: boolean }) {
  const all = flightLineSegments(f, now, hideAbsolute);
  // The status word is always the first segment, and everything after it opens
  // with " · ". Dropping the word means dropping that separator too.
  const segs = hideStatus
    ? all.slice(1).map((seg, i) => (i === 0 ? { ...seg, text: seg.text.replace(/^ · /, '') } : seg))
    : all;
  return (
    <Text style={[s.statusLineText, style]} numberOfLines={numberOfLines}>
      {segs.map((seg, i) => <Text key={i} style={{ color: seg.color }}>{seg.text}</Text>)}
    </Text>
  );
}

// StatusLine reads this as `s.statusLineText`, exactly as it did when `s` was
// index.tsx's own stylesheet. The name is kept so the component's body did not
// have to change to move.
const s = StyleSheet.create({
  // StatusLine's own type, extracted because the stacked branch renders it on
  // two Texts and an inline object would have been the same literal twice.
  statusLineText: { fontFamily: MONO, fontSize: 11 },
});
