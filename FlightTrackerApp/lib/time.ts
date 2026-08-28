// Reading the stored ISO fields. One implementation, imported by everything.
//
// THERE ARE TWO KINDS OF ISO IN THIS APP AND ONLY ONE MAY BECOME AN INSTANT.
//
// The ROUTE payload's *_iso fields carry a TRUE UTC offset, so Date.parse reads
// them correctly. The FLIGHT DTO's *_iso fields do not: they carry LOCAL
// WALL-CLOCK DIGITS under a bogus +00:00, so the offset on the string is a lie
// and the digits are the truth. `new Date(iso)` on one of those re-expresses the
// instant in the DEVICE's zone and silently shifts every time on screen — and it
// shifts the two kinds differently, which is what makes the mistake so hard to
// see once it is made.
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
