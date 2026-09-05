// Reading the stored ISO fields. One implementation, imported by everything.
//
// EVERY *_iso IN THIS APP CARRIES LOCAL WALL-CLOCK DIGITS, AND THE DIGITS ARE
// THE TRUTH.
//
// THIS NOTE USED TO SAY THE FLIGHT DTO ATTACHED A BOGUS +00:00. It does not, and
// has not for some time: mcp_server.py's _to_wire_iso builds these strings with
// the TRUE local offset -- '2026-09-05T21:40+04:00' -- and says so in its own
// docstring. The route payload does the same. Both kinds now agree, which is
// what that function means by "both readings agree and nothing here is
// deliberately wrong".
//
// THE RULE BELOW IS UNCHANGED AND IS STILL THE POINT. `new Date(iso)` would
// re-express the instant in the DEVICE's zone and silently shift every time on
// screen. zonedIsoToTs reads the digits and re-derives the offset from the
// airport's IANA zone rather than trusting the one on the string -- so a record
// saved before the offset was correct, or one whose offset and zone disagree,
// still resolves to the airport's own clock.
//
// So there are exactly two questions to ask of these fields, and one function
// for each:
//
//   zonedIsoToTs  "what INSTANT is this"  — digits + the airport's IANA zone
//   clock24       "what does the CLOCK on the wall say" — the digits, as text
//
// They live together because they are the pair, and they live in their own
// module because both app/index.tsx and lib/reminders.ts need them. A second
// implementation of zonedIsoToTs anywhere would be a uniform, silent time shift
// that no test in this repo would catch.

// ONE FORMATTER PER TIMEZONE, FOREVER.
//
// Constructing an Intl.DateTimeFormat builds an ICU formatter, which is among
// the most expensive routine operations in JavaScript — and zonedIsoToTs used to
// build a fresh one on every single call. It is called from arrivalTs, hasFlown,
// savedSortKey, flightLineSegments and delaySegment, which between them run once
// per saved flight in each of two filters, twice per comparison in each of two
// sorts, and up to three times per rendered row. Twenty saved flights came to
// something on the order of two to four hundred constructions PER RENDER of the
// screen — tens of milliseconds — and every one of them was for one of a handful
// of distinct timezone strings.
//
// A Map keyed on the timezone reduces that to one construction per distinct zone
// for the life of the process, and a hash lookup thereafter.
//
// Failures are cached too, as null. An invalid timezone throws at construction;
// without storing the miss, a record carrying a bad zone would pay the throw on
// every call forever, which is the expensive case made permanent.
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function tzFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (TZ_FORMATTERS.has(timeZone)) return TZ_FORMATTERS.get(timeZone) ?? null;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    made = null;
  }
  TZ_FORMATTERS.set(timeZone, made);
  return made;
}

// The INSTANT a naive local datetime represents in a given IANA zone.
//
// Strip the offset, treat the digits as naive, interpret them in the zone. Never
// use `new Date(iso)` on a flight DTO field directly — see the note at the top.
export function zonedIsoToTs(iso: string | null, timeZone: string | null): number | null {
  if (!iso || !timeZone) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  const fmt = tzFormatter(timeZone);
  if (fmt === null) return null;
  try {
    const parts = fmt.formatToParts(new Date(guess));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asZoned = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return guess - (asZoned - guess); // subtract the zone offset at that instant
  } catch {
    return null;
  }
}

const ISO_CLOCK_RE = /T(\d{2}:\d{2})/;

// The airport's own wall clock, as text, which is precisely the value being
// rendered. This never computes an instant, which is exactly why one of it can
// serve both kinds of ISO: it reads the digits and nothing else.
//
// Already zero-padded upstream, so every result is exactly five characters —
// which is what lets both route time cells share one fixed width.
export function clock24(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const m = ISO_CLOCK_RE.exec(iso);
  // Unparseable, or a record saved before the schema carried ISO at all: show
  // what was stored, untouched. A pre-v3 saved flight has no ISO to convert
  // from and would otherwise render nothing; a stale 12-hour value is worse
  // than the rest of the card but far better than a blank, and it corrects
  // itself the first time that flight is refreshed.
  return m ? m[1] : fallback;
}

// -- AND THE THIRD QUESTION, WHICH IS ASKED OF AN INSTANT RATHER THAN A FIELD --
//
// zonedIsoToTs AND clock24 BOTH READ AN ISO STRING: one turns the digits into an
// instant, the other reads them as text. The two questions at the top of this
// file are about the stored FIELDS, and both of them still are -- this is a third
// question, and it is asked of something that was COMPUTED rather than stored.
//
// IT EXISTS BECAUSE reminderTimes RETURNS EPOCH MILLISECONDS. The evening before
// and the moment to leave are both derived from the departure and the origin's
// zone, and there is no ISO anywhere for clock24 to read. Handing clock24 one of
// those is not a mistake it can catch; there is simply nothing to give it.
//
// THE CALLER NAMES THE ZONE, exactly as it does for zonedIsoToTs, because an
// instant has no zone of its own -- and a function that picked one here would be
// picking the device's on behalf of every caller.
//
// THE SAME FORMATTER CACHE, and that is not an optimisation but the reason this
// is six lines rather than sixty. tzFormatter already holds one
// Intl.DateTimeFormat per distinct zone for the life of the process, already
// caches a failure as null, and already formats hour and minute in 24-hour form.
// A second map, or a fresh formatter built here, would be a second answer to a
// question this file already answers -- see the note above TZ_FORMATTERS for what
// constructing one costs.
//
// % 24 ON THE HOUR, for the reason zonedIsoToTs applies it: hour12: false reports
// midnight as "24" on some ICU versions, and "24:05" is not a clock.
//
// NULL ON EVERY FAILURE, matching zonedIsoToTs's treatment exactly: a missing
// instant, a missing zone, a zone with no formatter, or a throw from
// formatToParts. A caller that cannot be told the time renders nothing rather
// than a time from somewhere else.
export function clockInZone(ts: number | null, timeZone: string | null): string | null {
  if (ts === null || !timeZone) return null;
  const fmt = tzFormatter(timeZone);
  if (fmt === null) return null;
  try {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
    if (p.hour === undefined || p.minute === undefined) return null;
    return `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute.padStart(2, '0')}`;
  } catch {
    return null;
  }
}
