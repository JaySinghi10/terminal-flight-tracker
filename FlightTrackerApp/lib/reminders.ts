// Local reminders, and the only place in the app that touches expo-notifications.
//
// index.tsx must not import expo-notifications directly. Everything the feature
// needs — permission, the Android channel, the arithmetic, the copy, the
// scheduling and the reconciliation — is behind this module, so there is one
// place to look when a reminder does not arrive.
//
// NOTHING HERE IS LIVE DATA. Every notification fires on a time that was stored
// when it was scheduled, and the copy says "Scheduled" for exactly that reason.
// If an airline retimes a flight, the reminder is wrong until the next refresh
// reconciles it, and the wording must never imply otherwise.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SavedFlight } from './storage';
import { airportByCode } from './airports';
// The one implementation. See lib/time.ts: there are two kinds of ISO in this
// app and only one may become an instant, so a copy of zonedIsoToTs anywhere
// would be a uniform, silent time shift.
import { zonedIsoToTs, clock24 } from './time';

// ── PLATFORM SETUP ───────────────────────────────────────────────────────────

// So a reminder arriving while the app is open is still shown. Without it the
// notification is delivered and silently swallowed, which reads as "reminders
// do not work" to anyone testing with the app in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export const REMINDER_CHANNEL = 'reminders';

// ANDROID DROPS NOTIFICATIONS SILENTLY without a channel — no error, no
// delivery. This must run before anything is scheduled.
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  } catch {
    // A channel that cannot be created is not worth a crash on startup. The
    // scheduling below will simply not be delivered, which is the same outcome
    // as the user denying permission.
  }
}

export async function ensurePermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    // Asking again when the user has already refused is how an app becomes
    // something people turn off entirely, but expo returns canAskAgain false in
    // that case and the request resolves immediately without a prompt.
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

// ── THE ARITHMETIC ───────────────────────────────────────────────────────────

// HOW LONG BEFORE DEPARTURE TO LEAVE, which is not the same question as when
// boarding starts — it is when to walk out of the door, and the answer depends
// on how long the airport will take.
const LEAVE_LEAD_DOMESTIC_MS = 3 * 60 * 60 * 1000;
const LEAVE_LEAD_INTERNATIONAL_MS = 4 * 60 * 60 * 1000;
const EVENING_HOUR = 18;

export type ReminderTimes = { evening: number | null; leave: number | null };

// DOMESTIC means both ends are in the same country, read from the bundled
// dataset — which already carries a country per airport, so nothing new is
// stored and nothing is inferred from a timezone.
//
// UNRESOLVED IS TREATED AS INTERNATIONAL, deliberately. A code missing from the
// dataset gets the longer four-hour lead, so the reminder is an hour EARLY
// rather than an hour late. Early is the recoverable direction: a traveller who
// leaves early waits at the airport, and one who leaves late misses the flight.
// The same reasoning is why the fallback is not "assume domestic".
function isDomestic(flight: SavedFlight): boolean {
  const from = airportByCode(flight.from.iata);
  const to = airportByCode(flight.to.iata);
  if (from === null || to === null) return false;
  return from.country === to.country;
}

// PURE. No scheduling, no permission, no clock of its own — `now` is passed in
// so this can be reasoned about and, if it ever needs to be, tested.
//
// Both are null when the flight has no scheduled departure or no origin
// timezone, because neither instant can be computed without both. A time
// already past is null rather than an error: a flight saved this afternoon for
// tonight has neither an evening-before reminder nor a leave-now one left to
// give, and saying so is better than firing one immediately.
export function reminderTimes(flight: SavedFlight, now: number): ReminderTimes {
  const iso = flight.from.scheduledIso;
  const tz = flight.from.timezone;
  if (!iso || !tz) return { evening: null, leave: null };

  const dep = zonedIsoToTs(iso, tz);
  if (dep === null) return { evening: null, leave: null };

  const leaveAt = dep - (isDomestic(flight) ? LEAVE_LEAD_DOMESTIC_MS : LEAVE_LEAD_INTERNATIONAL_MS);

  // 18:00 the CALENDAR DAY BEFORE departure, in the ORIGIN's timezone — which
  // is why the day is stepped in the ISO string rather than by subtracting 24
  // hours from the departure instant. A day is not always 24 hours long, and on
  // the two days a year it is not, arithmetic on the instant lands at 17:00 or
  // 19:00 local.
  let eveningAt: number | null = null;
  const day = iso.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [y, m, d] = day.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    const pd = `${prev.getUTCFullYear()}-`
      + `${String(prev.getUTCMonth() + 1).padStart(2, '0')}-`
      + `${String(prev.getUTCDate()).padStart(2, '0')}`;
    eveningAt = zonedIsoToTs(`${pd}T${String(EVENING_HOUR).padStart(2, '0')}:00`, tz);
  }

  return {
    evening: eveningAt !== null && eveningAt > now ? eveningAt : null,
    leave: leaveAt > now ? leaveAt : null,
  };
}

// ── IDENTIFIERS ──────────────────────────────────────────────────────────────
//
// Derived, never stored. The flight's id already encodes the number and the
// date, so two identifiers per flight fall out of it and nothing has to be kept
// in sync. It is also what lets reconcile() find orphans: any scheduled
// notification whose identifier starts with the prefix and does not belong to a
// current flight is one this app left behind.
const PREFIX = 'remind:';
const idFor = (flightId: string, kind: 'evening' | 'leave') =>
  `${PREFIX}${flightId}:${kind}`;

// ── COPY ─────────────────────────────────────────────────────────────────────
//
// Sentences, so Inter's voice: plain words, ordinary punctuation, no terminal
// formatting and no emoji. Times are the ORIGIN airport's local wall clock,
// which is the clock printed on the boarding pass and the only one the traveller
// is standing in.
//
// "Scheduled" appears in both bodies deliberately. These fire on a time stored
// when the reminder was set; they are not live tracking and must not be read as
// a claim about where the aircraft is now.
function terminalClause(flight: SavedFlight): string {
  const t = flight.from.terminal;
  return t ? ` Terminal ${t}.` : '';
}

function eveningCopy(flight: SavedFlight): { title: string; body: string } {
  const at = clock24(flight.from.scheduledIso, '');
  return {
    title: `${flight.flightNumber} tomorrow`,
    body: `Departs ${flight.from.iata} at ${at}.${terminalClause(flight)} Scheduled time.`,
  };
}

function leaveCopy(flight: SavedFlight): { title: string; body: string } {
  const at = clock24(flight.from.scheduledIso, '');
  return {
    title: `${flight.flightNumber} — time to leave`,
    body: `Head to ${flight.from.iata}. Scheduled departure ${at}.${terminalClause(flight)}`,
  };
}

// ── SCHEDULING ───────────────────────────────────────────────────────────────

async function scheduleOne(
  identifier: string,
  content: { title: string; body: string },
  at: number,
): Promise<boolean> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { ...content, sound: false },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(at),
        channelId: REMINDER_CHANNEL,
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Cancel then schedule, always. Scheduling over a live identifier is not
// defined to replace it on every platform, and a flight whose departure moved
// must not end up with both the old instant and the new one pending.
export async function scheduleFor(flight: SavedFlight): Promise<number> {
  await cancelFor(flight.id);
  const times = reminderTimes(flight, Date.now());

  let n = 0;
  if (times.evening !== null) {
    if (await scheduleOne(idFor(flight.id, 'evening'), eveningCopy(flight), times.evening)) n++;
  }
  if (times.leave !== null) {
    if (await scheduleOne(idFor(flight.id, 'leave'), leaveCopy(flight), times.leave)) n++;
  }
  return n;
}

export async function cancelFor(flightId: string): Promise<void> {
  for (const kind of ['evening', 'leave'] as const) {
    try {
      await Notifications.cancelScheduledNotificationAsync(idFor(flightId, kind));
    } catch {
      // Cancelling something that is not scheduled is not a failure.
    }
  }
}

// ── RECONCILE ────────────────────────────────────────────────────────────────
//
// The only thing that keeps scheduled notifications honest, and it exists
// because two things move underneath them.
//
// A DEPARTURE TIME MOVES. Every reminder was scheduled from data that was
// current when it was set; a refresh can retime the flight by hours, and
// nothing rewrites the pending notification unless this does.
//
// AN ID CHANGES. A record saved without a usable date is filed under "unknown"
// and takes a real id the first time a refresh returns one — see makeFlightId.
// The notifications scheduled under the old id are then orphans that no flight
// will ever cancel, which is what the sweep at the end is for.
export async function reconcile(flights: SavedFlight[]): Promise<void> {
  const wanted = flights.filter(f => f.remindersSetAt !== null);

  for (const f of wanted) {
    await scheduleFor(f);
  }

  // Anything of ours that no current flight claims, including everything left
  // over from a previous id.
  const keep = new Set<string>();
  for (const f of wanted) {
    keep.add(idFor(f.id, 'evening'));
    keep.add(idFor(f.id, 'leave'));
  }
  try {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    for (const p of pending) {
      const id = p.identifier;
      if (typeof id === 'string' && id.startsWith(PREFIX) && !keep.has(id)) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    }
  } catch {
    // Reconciliation is best-effort. Failing it leaves stale reminders, which
    // is worse than nothing but not worth taking the app down for.
  }
}
