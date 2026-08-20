import { useState, useRef, useEffect } from "react";
import Svg, { Path, Rect, G } from 'react-native-svg';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Google from 'expo-auth-session/providers/google';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Animated,
  AppState,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Easing,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SavedFlight,
  SavedFlightEndpoint,
  getSavedFlights,
  saveFlight,
  unsaveFlight,
  touchSavedFlight,
  savedFlightFromApi,
  migrateLegacyIfNeeded,
  mergeGuestInto,
} from '../lib/storage';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

const FLIGHT_REGEX = /^[A-Z]{2}\d{2,4}$/;

// These caps protect the AeroDataBox quota.
const PULL_COOLDOWN_MS = 60 * 1000;
const AUTO_REFRESH_MAX_FLIGHTS = 2;
const AUTO_REFRESH_MIN_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000; // auto-refresh disabled while on the free tier; set to 12 * 60 * 60 * 1000 to re-enable
const AUTO_REFRESH_RESUME_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const COUNTDOWN_MAX_AGE_MS = 3 * 60 * 60 * 1000; // how fresh data must be to show a live countdown; lower to 30 * 60 * 1000 or 10 * 60 * 1000 for stricter honesty
// The provider's BASIC plan caps requests at one per second and rejects the rest
// with HTTP 429, so consecutive saved-flight lookups are spaced past that ceiling.
const REFRESH_SPACING_MS = 1300;

type FlightData = {
  flight: string;
  airline: string;
  status: string;
  statusColor: string;
  statusBg: string;
  from: string;
  fromFull: string;
  fromCity: string;
  to: string;
  toFull: string;
  toCity: string;
  dep: string;
  arr: string;
  depTimeLabel: string;
  depTimeValue: string;
  arrTimeLabel: string;
  arrTimeValue: string;
  duration: string | null;
  terminal: string;
  gate: string;
  checkinDesk: string | null;
  aircraft: string | null;
  registration: string | null;
  baggage: string;
  delayLabel: string | null;
  delayValue: string | null;
  date: string;
};

function getStatusColor(status: string) {
  switch (status) {
    case "landed": return "#8e8e93";
    case "active": return "#4ade80";
    case "scheduled": return "#aeaeb2";
    case "delayed": return "#fbbf24";
    case "cancelled": return "#f87171";
    default: return "#fbbf24";
  }
}

function getStatusBg(status: string) {
  switch (status) {
    case "landed": return "#8e8e9312";
    case "active": return "#4ade8012";
    case "scheduled": return "#aeaeb212";
    case "delayed": return "#fbbf2412";
    case "cancelled": return "#f8717112";
    default: return "#fbbf2412";
  }
}

// The backend uses "N/A" for a time that does not exist yet, and saved records
// default to the same string, so neither may be treated as a real value.
function hasTime(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '' && v !== 'N/A';
}

type TimeCell = { label: string; value: string };

// Decides the "what happened / what is expected" row for one movement. Shared by
// the fresh-search card and the saved-record card so the two cannot drift.
function movementTimeCell(
  actual: string | null | undefined,
  estimated: string | null | undefined,
  actualSource: string | null | undefined,
  estimatedSource: string | null | undefined,
  isDeparture: boolean,
): TimeCell {
  const noun = isDeparture ? 'Departure' : 'Arrival';
  if (hasTime(actual)) {
    const suffix = actualSource === 'runway'
      ? (isDeparture ? ' (wheels up)' : ' (touchdown)')
      : '';
    return { label: `Actual ${noun}`, value: `${actual}${suffix}` };
  }
  if (hasTime(estimated)) {
    const suffix = estimatedSource === 'predicted' ? ' (predicted)' : '';
    return { label: `Estimated ${noun}`, value: `${estimated}${suffix}` };
  }
  return {
    label: `Actual ${noun}`,
    value: isDeparture ? 'Not departed yet' : 'Not arrived yet',
  };
}

// Signed minutes -> row label and value. Zero and null hide the row entirely.
function delayCell(delay: number | null | undefined): { label: string | null; value: string | null } {
  if (typeof delay !== 'number' || delay === 0) return { label: null, value: null };
  const magnitude = Math.abs(delay);
  const unit = magnitude === 1 ? 'minute' : 'minutes';
  return delay > 0
    ? { label: 'Delay', value: `${magnitude} ${unit}` }
    : { label: 'Early', value: `${magnitude} ${unit}` };
}

// A not-yet-departed flight already running late reads better as "delayed" than
// as "scheduled". Display only — the stored status vocabulary is unchanged.
function displayStatus(status: string, departureDelay: number | null | undefined): string {
  if (status === 'scheduled' && typeof departureDelay === 'number' && departureDelay > 0) {
    return 'delayed';
  }
  return status;
}

// Scheduled block time, from the two scheduled ISO values in their own zones.
function scheduledDuration(
  depIso: string | null,
  depTz: string | null,
  arrIso: string | null,
  arrTz: string | null,
): string | null {
  const dep = zonedIsoToTs(depIso, depTz);
  const arr = zonedIsoToTs(arrIso, arrTz);
  if (dep == null || arr == null) return null;
  const totalMin = Math.round((arr - dep) / 60000);
  if (totalMin <= 0) return null;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Fraction of the flight elapsed, or null meaning "do not draw the bar at all".
// Called at render time from the live `now` so it advances with the clock.
function computeProgress(f: SavedFlight | null, now: number): number | null {
  if (!f) return null;
  const s = f.status.toLowerCase();
  if (s === 'landed') return 1;
  if (s === 'scheduled') return 0;
  if (s !== 'active') return null; // cancelled, diverted, unknown, anything else
  const depIso = f.from.actualIso ?? f.from.estimatedIso ?? f.from.scheduledIso;
  const arrIso = f.to.estimatedIso ?? f.to.scheduledIso;
  const dep = zonedIsoToTs(depIso, f.from.timezone);
  const arr = zonedIsoToTs(arrIso, f.to.timezone);
  if (dep == null || arr == null || arr <= dep) return null;
  return Math.min(0.98, Math.max(0.02, (now - dep) / (arr - dep)));
}

function flightDataFromApi(data: any): FlightData {
  const dep = data?.departure ?? {};
  const arr = data?.arrival ?? {};
  const status = displayStatus((data?.status || "unknown").toLowerCase(), dep.delay);
  const depCell = movementTimeCell(dep.actual, dep.estimated, dep.actual_source, dep.estimated_source, true);
  const arrCell = movementTimeCell(arr.actual, arr.estimated, arr.actual_source, arr.estimated_source, false);
  const delay = delayCell(dep.delay);
  return {
    flight: data?.flight_number || "—",
    airline: data?.airline || "—",
    status: status.toUpperCase(),
    statusColor: getStatusColor(status),
    statusBg: getStatusBg(status),
    from: dep.iata || "—",
    fromFull: airportFullLabel(dep.short_name ?? null, dep.city ?? null, dep.airport || "—"),
    // City where there is one, airport name where there is not: the provider
    // omits municipalityName on plenty of airports.
    fromCity: dep.city || dep.airport || "—",
    to: arr.iata || "—",
    toFull: airportFullLabel(arr.short_name ?? null, arr.city ?? null, arr.airport || "—"),
    toCity: arr.city || arr.airport || "—",
    dep: dep.scheduled || "N/A",
    arr: arr.scheduled || "N/A",
    depTimeLabel: depCell.label,
    depTimeValue: depCell.value,
    arrTimeLabel: arrCell.label,
    arrTimeValue: arrCell.value,
    duration: scheduledDuration(dep.scheduled_iso ?? null, dep.timezone ?? null, arr.scheduled_iso ?? null, arr.timezone ?? null),
    terminal: dep.terminal || "N/A",
    gate: dep.gate || "N/A",
    checkinDesk: dep.checkin_desk ?? null,
    aircraft: data?.aircraft_model ?? null,
    registration: data?.aircraft_registration ?? null,
    baggage: arr.baggage || "N/A",
    delayLabel: delay.label,
    delayValue: delay.value,
    date: data?.flight_date || "N/A",
  };
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Header line, e.g. "Sat, 16 Aug · 2:04 AM". Fixed arrays rather than Intl so
// the output never shifts with locale.
function formatClock(ts: number) {
  const d = new Date(ts);
  const hours = d.getHours();
  const period = hours < 12 ? 'AM' : 'PM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  const time = `${display}:${String(d.getMinutes()).padStart(2, '0')} ${period}`;
  const day = String(d.getDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]}, ${day} ${MONTHS[d.getMonth()]} · ${time}`;
}

// WEEKDAYS holds abbreviations for the clock line; "Happy Sat" reads clipped in
// a greeting, so the full names live here. Only the weekend entries reach it.
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Greeting prefixes, keyed by the situation greetingPrefix resolves to. Every
// entry renders as "<prefix>, <name>", so each has to read naturally in front of
// a comma and a first name. '{day}' is substituted with the weekday name.
const GREETINGS = {
  morning: ['Good morning', 'Morning', 'Up early'],
  afternoon: ['Good afternoon', 'Afternoon'],
  evening: ['Good evening', 'Evening', 'Winding down'],
  night: ['Still up', 'Late one'],
  mondayMorning: ['Monday again', 'New week', 'Good morning'],
  weekendMorning: ['Happy {day}', 'Slow start', 'Weekend mode'],
  weekendAfternoon: ['Enjoy the weekend', 'Good afternoon'],
};

// Pure and total. Day-specific cases resolve first, then the plain hour buckets.
// The night bucket spans 22-04 and so wraps past midnight, which is why it is
// the fallthrough rather than a range. Evenings and nights are deliberately
// shared across every day: a Saturday 2am is not different from a Tuesday 2am.
// The double modulo keeps the lookup total for a negative index.
function greetingPrefix(ts: number, index: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const h = d.getHours();
  const isWeekend = day === 0 || day === 6;
  const pool =
    day === 1 && h >= 5 && h <= 11 ? GREETINGS.mondayMorning :
    isWeekend && h >= 5 && h <= 11 ? GREETINGS.weekendMorning :
    isWeekend && h >= 12 && h <= 16 ? GREETINGS.weekendAfternoon :
    h >= 5 && h <= 11 ? GREETINGS.morning :
    h >= 12 && h <= 16 ? GREETINGS.afternoon :
    h >= 17 && h <= 21 ? GREETINGS.evening :
    GREETINGS.night;
  const prefix = pool[((index % pool.length) + pool.length) % pool.length];
  // No-op for every entry without the token.
  return prefix.replace('{day}', WEEKDAYS_LONG[day]);
}

// Display-only handle. Saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

function localDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function trimAirportName(name: string) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf(' (');
  return (i >= 0 ? name.slice(0, i) : name).trim();
}

// "Chhatrapati Shivaji, Mumbai" when the provider supplies both parts and they
// differ, otherwise the full airport name alone. Single-name airports return
// shortName === city — DXB is "Dubai"/"Dubai" — and must not read "Dubai,
// Dubai". Compared case-insensitively after trimming.
function airportFullLabel(shortName: string | null, city: string | null, airport: string): string {
  const s = (shortName ?? '').trim();
  const c = (city ?? '').trim();
  if (s && c && s.toLowerCase() !== c.toLowerCase()) return `${s}, ${c}`;
  return airport;
}

function InfoRow({ label, value, sans }: { label: string; value: string; sans?: boolean }) {
  return (
    <View style={ir.row}>
      <Text style={ir.label}>{label}</Text>
      <Text style={[ir.value, sans && ir.valueSans]}>{value}</Text>
    </View>
  );
}

const ir = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  label: { fontSize: 13, color: "rgba(226,226,226,0.45)", fontFamily: SANS },
  value: { fontSize: 13, color: "#ffffff", textAlign: "right", flex: 1, marginLeft: 16, fontFamily: MONO },
  valueSans: { fontFamily: SANS },
});

// --- Live-countdown helpers -------------------------------------------------
const CD_GREEN = '#4ade80';
const CD_AGE = 'rgba(226,226,226,0.3)';
const CD_LATE = '#fbbf24';
const CD_EARLY = 'rgba(226,226,226,0.5)';

type LineSeg = { text: string; color: string };

// The backend's *_iso fields carry a bogus "+00:00"; the value is the airport's
// LOCAL wall clock. Strip the offset, treat as naive, interpret in the IANA zone.
// Never use `new Date(iso)` on these directly.
function zonedIsoToTs(iso: string | null, timeZone: string | null): number | null {
  if (!iso || !timeZone) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asZoned = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return guess - (asZoned - guess); // subtract the zone offset at that instant
  } catch {
    return null;
  }
}

function formatCountdown(ms: number): string {
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

function absoluteTime(f: SavedFlight): string {
  const s = f.status.toLowerCase();
  if (s === 'landed') return f.to.actual && f.to.actual !== 'N/A' ? f.to.actual : f.to.scheduled;
  if (s === 'active') return f.to.scheduled;
  return f.from.scheduled;
}

// Line-2 / card status line. Always leads with the coloured status word so the
// row still says what the flight is doing when the countdown falls away.
function flightLineSegments(f: SavedFlight, now: number): LineSeg[] {
  const s = f.status.toLowerCase();
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

  // Fallback: status · updated <age> [· absolute time]
  const abs = absoluteTime(f);
  const tail = abs && abs !== 'N/A'
    ? ` · updated ${timeAgo(f.updatedAt, now)} · ${abs}`
    : ` · updated ${timeAgo(f.updatedAt, now)}`;
  return [statusSeg, { text: tail, color: CD_AGE }];
}

function StatusLine({ f, now, style, numberOfLines, hideStatus }: { f: SavedFlight; now: number; style?: any; numberOfLines?: number; hideStatus?: boolean }) {
  const all = flightLineSegments(f, now);
  // The status word is always the first segment, and everything after it opens
  // with " · ". Dropping the word means dropping that separator too.
  const segs = hideStatus
    ? all.slice(1).map((seg, i) => (i === 0 ? { ...seg, text: seg.text.replace(/^ · /, '') } : seg))
    : all;
  return (
    <Text style={[{ fontFamily: MONO, fontSize: 11 }, style]} numberOfLines={numberOfLines}>
      {segs.map((seg, i) => <Text key={i} style={{ color: seg.color }}>{seg.text}</Text>)}
    </Text>
  );
}

// Relevance order: in the air, then upcoming, then finished. Unparseable times
// sink to the end of their own group rather than the end of the list.
const SAVED_RANK: Record<string, number> = { active: 0, scheduled: 1, delayed: 1 };
const RANK_LAST = 2;
const NO_TIME = Number.MAX_SAFE_INTEGER;

function savedSortKey(f: SavedFlight): { rank: number; when: number } {
  const s = f.status.toLowerCase();
  const rank = SAVED_RANK[s] ?? RANK_LAST;
  if (rank === 0) {
    // Same precedence flightLineSegments uses for an active flight.
    return { rank, when: zonedIsoToTs(f.to.estimatedIso ?? f.to.scheduledIso, f.to.timezone) ?? NO_TIME };
  }
  if (rank === 1) {
    return { rank, when: zonedIsoToTs(f.from.estimatedIso ?? f.from.scheduledIso, f.from.timezone) ?? NO_TIME };
  }
  return { rank, when: -f.updatedAt };   // negated so the newest sorts first
}

// Pure: returns a new array, never mutates the input.
function sortSavedByRelevance(list: SavedFlight[]): SavedFlight[] {
  return [...list].sort((a, b) => {
    const ka = savedSortKey(a);
    const kb = savedSortKey(b);
    return ka.rank !== kb.rank ? ka.rank - kb.rank : ka.when - kb.when;
  });
}

function SavedFlightRow({
  flight,
  onPress,
  onUnsave,
  now,
}: { flight: SavedFlight; onPress: () => void; onUnsave: () => void; now: number }) {
  return (
    <TouchableOpacity style={sf.row} onPress={onPress} activeOpacity={0.7}>
      <View style={sf.line1}>
        <Text style={sf.number}>{flight.flightNumber}</Text>
        <Text style={sf.route} numberOfLines={1}>{`${flight.from.iata} → ${flight.to.iata}`}</Text>
        <TouchableOpacity
          onPress={onUnsave}
          activeOpacity={0.7}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={sf.remove}>{'×'}</Text>
        </TouchableOpacity>
      </View>
      <StatusLine f={flight} now={now} numberOfLines={1} style={{ marginTop: 4 }} />
    </TouchableOpacity>
  );
}

const sf = StyleSheet.create({
  row: {
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  line1: { flexDirection: 'row', alignItems: 'center' },
  number: { fontSize: 13, color: '#ffffff', fontFamily: MONO_BOLD },
  // Deliberately outside the type scale: this is a hit target, not text.
  chevron: { fontFamily: MONO, fontSize: 24, color: 'rgba(226,226,226,0.75)' },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  collapsedLine: { paddingVertical: 10 },
  collapsedNumber: { fontFamily: MONO, fontSize: 11, color: '#ffffff' },
  collapsedDim: { fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.45)' },
  route: { fontSize: 13, color: 'rgba(226,226,226,0.6)', fontFamily: MONO, flex: 1, marginLeft: 12 },
  updated: { color: 'rgba(226,226,226,0.3)' },
  remove: {
    fontSize: 20,
    color: 'rgba(248,113,113,0.55)',
    fontFamily: MONO,
    paddingLeft: 12,
  },
});

function ProgressBar({ progress, color }: { progress: number; color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  const planeAnim = useRef(new Animated.Value(0)).current;

  // Keyed on `progress` so the bar re-animates as the flight advances. The old
  // useState-callback form ran once and never again.
  useEffect(() => {
    Animated.parallel([
      Animated.timing(anim, {
        toValue: progress,
        duration: 1400,
        delay: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(planeAnim, {
        toValue: progress,
        duration: 1400,
        delay: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  }, [progress]);

  return (
    <View style={pg.wrap}>
      <View style={pg.track}>
        <Animated.View
          style={[
            pg.fill,
            {
              width: anim.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
              backgroundColor: color,
            },
          ]}
        />
      </View>
      <Animated.Text
        style={[
          pg.plane,
          {
            left: planeAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ["0%", "88%"],
            }),
          },
        ]}
      >
        ✈
      </Animated.Text>
    </View>
  );
}

const pg = StyleSheet.create({
  wrap: { marginVertical: 24, position: "relative" },
  track: { height: 3, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 2, marginBottom: 14 },
  fill: { height: 3, borderRadius: 2 },
  plane: { position: "absolute", top: -11, fontSize: 20, color: "#ffffff" },
});

function ProfileModal({
  visible, onClose, onGoogleSignIn, onLogout, username,
  email, effectiveName, askName, onSaveName, onSkipName,
}: {
  visible: boolean; onClose: () => void; onGoogleSignIn: () => void; onLogout: () => void;
  username: string | null; email: string | null; effectiveName: string | null; askName: boolean;
  onSaveName: (name: string) => void; onSkipName: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(effectiveName ?? '');
  const [editing, setEditing] = useState(false);

  // Re-seed each time the sheet opens so a discarded edit does not linger.
  useEffect(() => {
    if (visible) {
      setNameDraft(effectiveName ?? '');
      setEditing(false);
    }
  }, [visible, effectiveName]);

  // The first-run ask forces the input open; otherwise the pencil does.
  const showInput = askName || editing;

  const commitName = () => {
    const cleaned = sanitiseDisplayName(nameDraft);
    if (!cleaned) return;            // empty after sanitising: keep the old value and stay open
    setEditing(false);
    onSaveName(cleaned);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={askName ? onSkipName : onClose}>
      <View style={pm.backdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={pm.sheet}>
            <TouchableOpacity style={pm.closeBtn} onPress={askName ? onSkipName : onClose}>
              <Text style={pm.closeTxt}>X</Text>
            </TouchableOpacity>

            <View style={pm.avatar}>
              <Text style={pm.avatarTxt}>{'//'}</Text>
            </View>
            {username !== null && showInput && (
              <>
                <Text style={pm.nameLabel}>{askName ? 'pick a name' : 'username'}</Text>
                <View style={pm.nameRow}>
                  <TextInput
                    style={pm.nameInput}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    onSubmitEditing={commitName}
                    placeholder="terminal"
                    placeholderTextColor="rgba(226,226,226,0.25)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={14}
                    selectionColor="#4ade80"
                    returnKeyType="done"
                  />
                  <TouchableOpacity style={pm.nameBtn} activeOpacity={0.75} onPress={commitName}>
                    <Text style={pm.nameBtnTxt}>{'save'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {username !== null && !showInput && (
              <View style={pm.nameLine}>
                <Text style={pm.name}>{effectiveName ?? 'Guest User'}</Text>
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => setEditing(true)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Text style={pm.pencil}>{'\u270E'}</Text>
                </TouchableOpacity>
              </View>
            )}

            {username === null && (
              <Text style={[pm.name, { marginBottom: 8 }]}>{effectiveName ?? 'Guest User'}</Text>
            )}

            <Text style={pm.sub}>{username ? (email ? `signed in as ${email}` : 'signed in') : 'Sign in to sync your flights'}</Text>

            {!username && (
              <>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75} onPress={onGoogleSignIn}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 24 24">
                      <G>
                        <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                        <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </G>
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Google </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={pm.authBtn} activeOpacity={0.75}>
                  <View style={pm.authBtnInner}>
                    <Svg width="20" height="20" viewBox="0 0 21 21">
                      <Rect x="1" y="1" width="9" height="9" fill="#F25022" />
                      <Rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                      <Rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                      <Rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                    </Svg>
                    <Text style={pm.authBtnTxt}> Sign in with Microsoft </Text>
                  </View>
                </TouchableOpacity>
              </>
            )}

            {username && (
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={onLogout}
                style={{ alignSelf: 'center', marginTop: 20, paddingVertical: 8 }}
              >
                <Text style={{ fontFamily: SANS, fontSize: 13, color: 'rgba(248,113,113,0.7)' }}> Log out </Text>
              </TouchableOpacity>
            )}

          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const PLACEHOLDER_PROMPTS = [
  'what is the status of EK500...',
  'is my flight on time?',
  'when does the next flight to New York leave?',
  'what gate is BA178 at?',
  'is there a delay on my LA flight?',
  'track my connecting flight to Chicago...',
  'when does the next flight to Dubai leave?',
  'is my Mumbai flight delayed?',
  'what time does AA101 land in JFK?',
];

function AnimatedPlaceholder() {
  const [text, setText] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>(r => { timer = setTimeout(r, ms); });

    let idx = 0;
    const loop = async () => {
      while (!cancelled) {
        const prompt = PLACEHOLDER_PROMPTS[idx];

        for (let i = 1; i <= prompt.length && !cancelled; i++) {
          await sleep(80);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;

        await sleep(1500);
        if (cancelled) break;

        for (let i = prompt.length - 1; i >= 0 && !cancelled; i--) {
          await sleep(50);
          setText(prompt.slice(0, i));
        }
        if (cancelled) break;

        await sleep(400);
        if (cancelled) break;

        idx = (idx + 1) % PLACEHOLDER_PROMPTS.length;
      }
    };

    loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <Text
      style={{ position: 'absolute', left: 0, right: 0, top: 0, color: '#2c2c2e', fontFamily: MONO, fontSize: 15 }}
      numberOfLines={1}
      pointerEvents="none"
    >
      {text}
    </Text>
  );
}

export default function Index() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [flight, setFlight] = useState<FlightData | null>(null);
  const [focused, setFocused] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [errorCounter, setErrorCounter] = useState(0);
  const [chatResponse, setChatResponse] = useState<string | null>(null);
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  // Persisted under 'savedCollapsed'. Starts true so an absent key means
  // collapsed; hydration only overrides it when the key exists.
  const [savedCollapsed, setSavedCollapsed] = useState(true);
  // Session only, never persisted: has the user revealed the saved section for
  // the result currently on screen?
  const [savedRevealed, setSavedRevealed] = useState(false);
  const [flightRecord, setFlightRecord] = useState<SavedFlight | null>(null);
  const [saveError, setSaveError] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Picked on mount, re-picked only by onRefresh. The header re-renders every
  // 60s on the `now` tick, so choosing this during render would reshuffle the
  // greeting every minute. 60 is a whole multiple of every pool length (3 and
  // 2), so the modulo stays uniform.
  const [greetingIndex, setGreetingIndex] = useState(() => Math.floor(Math.random() * 60));
  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshMsgCounter, setRefreshMsgCounter] = useState(0);
  const [refreshTone, setRefreshTone] = useState<'error' | 'info'>('error');
  // Session only, never persisted. Counter retriggers the fade on repeat taps.
  const [toastMsg, setToastMsg] = useState("");
  const [toastCounter, setToastCounter] = useState(0);
  const insets = useSafeAreaInsets();

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    iosClientId: '970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e.apps.googleusercontent.com',
    androidClientId: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
    redirectUri: 'com.googleusercontent.apps.970706733452-fmqtgg1doc0n14g8ibb8qsrsmcaot83e:/oauth2redirect',
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  });

  useEffect(() => {
    console.log('[Auth] response:', JSON.stringify(response));
    if (response?.type === 'success') {
      const accessToken = response.authentication?.accessToken;
      if (!accessToken) return;
      (async () => {
        try {
          const userInfo = await fetch('https://www.googleapis.com/userinfo/v2/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const user = await userInfo.json();
          const name = user.email.split('@')[0].match(/^[a-zA-Z]+/)[0];
          const validEmail = typeof user.email === 'string' && user.email.trim() ? user.email : null;
          await SecureStore.setItemAsync('username', name);
          await SecureStore.setItemAsync('gmailToken', accessToken);
          if (validEmail) await SecureStore.setItemAsync('email', validEmail);
          setUsername(name);
          setGmailToken(accessToken);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        } catch (err) {
          console.log('[Auth] userinfo fetch error:', err);
        }
      })();
    }
  }, [response]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const u = localStorage.getItem('username');
      if (u) setUsername(u);
      const e = localStorage.getItem('email');
      if (e) setEmail(e);
      const dn = localStorage.getItem('displayName');
      if (dn) setDisplayName(dn);
      // Resolved before authHydrated, which gates the saved-list load, so the
      // section never renders expanded and then snaps shut.
      AsyncStorage.getItem('savedCollapsed').then(c => {
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    } else {
      Promise.all([
        SecureStore.getItemAsync('username'),
        SecureStore.getItemAsync('gmailToken'),
        SecureStore.getItemAsync('email'),
        SecureStore.getItemAsync('displayName'),
        AsyncStorage.getItem('savedCollapsed'),
      ]).then(([u, t, e, dn, c]) => {
        if (u) setUsername(u);
        if (t) setGmailToken(t);
        if (e) setEmail(e);
        if (dn) setDisplayName(dn);
        if (c !== null) setSavedCollapsed(c === 'true');
        setAuthHydrated(true);
      });
    }
  }, []);

  // First-run ask. Only after hydration, only when signed in, and only while
  // displayName is still unset — which skipping also fills, so it asks once.
  useEffect(() => {
    if (!authHydrated) return;
    if (username === null) return;
    if (displayName !== null) return;
    setProfileOpen(true);
  }, [authHydrated, username, displayName]);

  useEffect(() => {
    if (!authHydrated) return;
    let cancelled = false;
    (async () => {
      await migrateLegacyIfNeeded();
      const list = email
        ? await mergeGuestInto(email)
        : await getSavedFlights(null);
      if (!cancelled) {
        setSavedFlights(list);
        autoRefresh(list, () => cancelled);
      }
    })();
    return () => { cancelled = true; };
  }, [authHydrated, email]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      (window as any).google.accounts.id.initialize({
        client_id: '970706733452-n7ki9no870k7ad1bpkb86eu7rec0an7d.apps.googleusercontent.com',
        scope: 'profile email https://www.googleapis.com/auth/gmail.readonly',
        callback: (credentialResponse: any) => {
          const payload = JSON.parse(atob(credentialResponse.credential.split('.')[1]));
          const firstName = (payload.email as string).split('@')[0].match(/^[a-zA-Z]+/)?.[0] || 'user';
          const validEmail = typeof payload.email === 'string' && payload.email.trim() ? payload.email : null;
          localStorage.setItem('username', firstName);
          if (validEmail) localStorage.setItem('email', validEmail);
          setUsername(firstName);
          if (validEmail) setEmail(validEmail);
          clearResultView();
          // Sheet stays open: displayName is null here, so the first-run ask
          // effect takes over and it transitions in place.
        },
      });
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);


  const errorShake = useRef(new Animated.Value(0)).current;
  const resultOpacity = useRef(new Animated.Value(0)).current;
  const resultTranslate = useRef(new Animated.Value(30)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const cardBorderAnim = useRef(new Animated.Value(0)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  const errorMsgOpacity = useRef(new Animated.Value(0)).current;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const lastAutoRefreshRef = useRef(0);
  const dayRef = useRef(localDayKey(Date.now()));
  const refreshMsgOpacity = useRef(new Animated.Value(0)).current;
  const refreshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cardBorderAnim.stopAnimation();
    if (loading) {
      const fastPulse = (anim: Animated.Value) => Animated.loop(Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 200, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: false }),
      ]));
      fastPulse(cardBorderAnim).start();
    } else if (focused) {
      Animated.loop(Animated.sequence([
        Animated.timing(cardBorderAnim, { toValue: 1, duration: 530, useNativeDriver: false }),
        Animated.timing(cardBorderAnim, { toValue: 0, duration: 530, useNativeDriver: false }),
      ])).start();
    } else {
      cardBorderAnim.setValue(0);
    }
  }, [focused, loading]);

  useEffect(() => {
    if (flight?.status === 'ACTIVE') {
      Animated.loop(Animated.sequence([
        Animated.timing(badgePulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
        Animated.timing(badgePulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])).start();
    } else {
      badgePulse.stopAnimation();
      badgePulse.setValue(1);
    }
  }, [flight]);

  // The reveal belongs to one result. clearResultView is shared with sign-in and
  // logout and must not be modified, so the reset hangs off the result going null
  // rather than living inside it.
  useEffect(() => {
    if (flight === null) setSavedRevealed(false);
  }, [flight]);

  useEffect(() => {
    if (error === '') return;
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorMsgOpacity.stopAnimation();
    errorMsgOpacity.setValue(1);
    cardBorderAnim.stopAnimation();
    cardBorderAnim.setValue(2);
    Animated.parallel([
      Animated.sequence([
        Animated.delay(2500),
        Animated.timing(cardBorderAnim, { toValue: 0, duration: 500, useNativeDriver: false }),
      ]),
      Animated.timing(errorMsgOpacity, { toValue: 0, duration: 500, delay: 2500, useNativeDriver: false }),
    ]).start();
    errorTimerRef.current = setTimeout(() => setError(''), 3000);
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, [error, errorCounter]);

  useEffect(() => {
    if (saveError === '') return;
    const t = setTimeout(() => setSaveError(''), 3000);
    return () => clearTimeout(t);
  }, [saveError]);

  useEffect(() => {
    if (refreshMsg === '') return;
    if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current);
    refreshMsgOpacity.stopAnimation();
    refreshMsgOpacity.setValue(1);
    Animated.timing(refreshMsgOpacity, { toValue: 0, duration: 500, delay: 4500, useNativeDriver: false }).start();
    refreshMsgTimerRef.current = setTimeout(() => setRefreshMsg(''), 5000);
    return () => { if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current); };
  }, [refreshMsg, refreshMsgCounter]);

  useEffect(() => {
    if (toastMsg === '') return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastOpacity.stopAnimation();
    toastOpacity.setValue(1);
    Animated.timing(toastOpacity, { toValue: 0, duration: 300, delay: 900, useNativeDriver: false }).start();
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 1200);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toastMsg, toastCounter]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastCounter(c => c + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const d = localDayKey(t);
      if (d !== dayRef.current) {
        dayRef.current = d;
        getSavedFlights(email).then(list => { if (!cancelled) setSavedFlights(list); });
      }
    };
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        tick();
        if (Date.now() - lastAutoRefreshRef.current > AUTO_REFRESH_RESUME_COOLDOWN_MS) {
          getSavedFlights(email).then(l => { if (!cancelled) autoRefresh(l, () => cancelled); });
        }
      }
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      sub.remove();
    };
  }, [email]);

  const shake = () => {
    Animated.sequence([
      Animated.timing(errorShake, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(errorShake, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const showResult = () => {
    resultOpacity.setValue(0);
    resultTranslate.setValue(30);
    Animated.parallel([
      Animated.timing(resultOpacity, {
        toValue: 1, duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(resultTranslate, {
        toValue: 0, tension: 80, friction: 10,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const renderSavedFlight = (saved: SavedFlight) => {
    setError("");
    setSaveError("");
    setChatResponse(null);
    setFlightRecord(saved);
    const savedStatus = displayStatus(saved.status.toLowerCase(), saved.from.delay);
    const depCell = movementTimeCell(saved.from.actual, saved.from.estimated, saved.from.actualSource, saved.from.estimatedSource, true);
    const arrCell = movementTimeCell(saved.to.actual, saved.to.estimated, saved.to.actualSource, saved.to.estimatedSource, false);
    const savedDelay = delayCell(saved.from.delay);
    setSavedRevealed(false);
    setFlight({
      flight: saved.flightNumber,
      airline: saved.airline,
      status: savedStatus.toUpperCase(),
      statusColor: getStatusColor(savedStatus),
      statusBg: getStatusBg(savedStatus),
      from: saved.from.iata,
      fromFull: airportFullLabel(saved.from.shortName, saved.from.city, saved.from.airport),
      // Records saved before v5 carry city: null and fall back until refreshed.
      fromCity: saved.from.city || saved.from.airport,
      to: saved.to.iata,
      toFull: airportFullLabel(saved.to.shortName, saved.to.city, saved.to.airport),
      toCity: saved.to.city || saved.to.airport,
      dep: saved.from.scheduled || "N/A",
      arr: saved.to.scheduled || "N/A",
      depTimeLabel: depCell.label,
      depTimeValue: depCell.value,
      arrTimeLabel: arrCell.label,
      arrTimeValue: arrCell.value,
      duration: scheduledDuration(saved.from.scheduledIso, saved.from.timezone, saved.to.scheduledIso, saved.to.timezone),
      terminal: saved.from.terminal || "N/A",
      gate: saved.from.gate || "N/A",
      checkinDesk: saved.from.checkinDesk ?? null,
      aircraft: saved.aircraftModel ?? null,
      registration: saved.aircraftRegistration ?? null,
      baggage: saved.to.baggage ?? "N/A",
      delayLabel: savedDelay.label,
      delayValue: savedDelay.value,
      date: saved.flightDate === 'unknown' ? "N/A" : saved.flightDate,
    });
    setLastUpdated(saved.updatedAt);
    showResult();
  };

  const runFlightLookup = async (flightNumber: string, keepVisible = false): Promise<boolean> => {
    setError("");
    setSaveError("");
    if (!keepVisible) {
      setFlight(null);
      setChatResponse(null);
      setFlightRecord(null);
    }
    setLoading(true);
    try {
      const response = await fetch(`https://flight-tracker-970706733452.asia-south1.run.app/flight/${flightNumber}`);
      const data = await response.json();

      if (data.error || !response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return false;
      }

      setSavedRevealed(false);
      setFlight(flightDataFromApi(data));

      const record = savedFlightFromApi(data);
      setFlightRecord(record);
      const refreshed = await touchSavedFlight(email, record);
      if (refreshed) setSavedFlights(refreshed);

      setLastUpdated(Date.now());
      if (!keepVisible) showResult();
      return true;
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    const cleaned = query.trim().toUpperCase().replace(/\s/g, "");
    setError("");
    setFlight(null);
    setChatResponse(null);
    setFlightRecord(null);
    setSaveError("");

    if (!cleaned) {
      setError("enter a flight number or ask a question");
      setErrorCounter(c => c + 1);
      shake();
      return;
    }

    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.95, duration: 80, useNativeDriver: true }),
      Animated.spring(btnScale, { toValue: 1, tension: 200, friction: 8, useNativeDriver: true }),
    ]).start();

    if (FLIGHT_REGEX.test(cleaned)) {
      await runFlightLookup(cleaned);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch('https://flight-tracker-970706733452.asia-south1.run.app/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query, gmail_token: gmailToken }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setErrorCounter(c => c + 1);
        shake();
        return;
      }

      setChatResponse(data.response);
      if (data.flight) {
        setSavedRevealed(false);
        setFlight(flightDataFromApi(data.flight));
        const record = savedFlightFromApi(data.flight);
        setFlightRecord(record);
        const refreshed = await touchSavedFlight(email, record);
        if (refreshed) setSavedFlights(refreshed);
        setLastUpdated(Date.now());
      }
      showResult();
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setErrorCounter(c => c + 1);
      shake();
    } finally {
      setLoading(false);
    }
  };

  // Shared fetch-and-store loop. Sequential; per-flight try/catch; touchSavedFlight on
  // success; captures the open card's fresh data. Returns counts only — no UI side effects.
  const refreshFlights = async (list: SavedFlight[], maxAttempts: number): Promise<{ failures: number; openCardFresh: any }> => {
    const openCardNumber = flightRecord?.flightNumber ?? null;
    let openCardFresh: any = null;
    let failures = 0;
    let attempts = 0;

    for (const f of list) {                                   // sequential — never parallel
      if (attempts >= maxAttempts) break;
      // Between attempts only — never before the first, never after the last, so
      // a single saved flight waits no longer than it does today.
      if (attempts > 0) await new Promise(resolve => setTimeout(resolve, REFRESH_SPACING_MS));
      attempts++;
      try {
        const response = await fetch(`https://flight-tracker-970706733452.asia-south1.run.app/flight/${f.flightNumber}`);
        const data = await response.json();
        if (data.error || !response.ok) { failures++; continue; }
        await touchSavedFlight(email, savedFlightFromApi(data));
        if (openCardNumber && f.flightNumber === openCardNumber) openCardFresh = data;
      } catch {
        failures++;                                           // one failure must not abort the loop
      }
    }
    return { failures, openCardFresh };
  };

  // Silent background refresh: no spinner, no message. Failures are invisible — the row age tells the truth.
  const autoRefresh = async (list: SavedFlight[], isCancelled: () => boolean) => {
    if (refreshingRef.current) return;
    const stale = list.filter(f => Date.now() - f.updatedAt > AUTO_REFRESH_MIN_AGE_MS);
    if (stale.length === 0) return;
    refreshingRef.current = true;
    try {
      await refreshFlights(stale, AUTO_REFRESH_MAX_FLIGHTS);
      const fresh = await getSavedFlights(email);             // re-read once, set state once
      if (isCancelled()) return;                              // account switched / unmounted mid-flight
      setSavedFlights(fresh);
      lastAutoRefreshRef.current = Date.now();
    } finally {
      refreshingRef.current = false;
    }
  };

  const onRefresh = async () => {
    if (refreshingRef.current) return;                        // synchronous guard; iOS can double-fire the pull
    setGreetingIndex(Math.floor(Math.random() * 60));         // past the double-fire guard, above the cooldown: a throttled pull still rerolls
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshMsg("");
    try {
      if (savedFlights.length === 0) return;                  // spinner alone acknowledges; message can't render here

      if (Date.now() - lastRefreshRef.current < PULL_COOLDOWN_MS) {
        setRefreshMsg('> already up to date');
        setRefreshTone('info');
        setRefreshMsgCounter(c => c + 1);
        return;
      }
      lastRefreshRef.current = Date.now();

      const { failures, openCardFresh } = await refreshFlights(savedFlights, 5);

      const list = await getSavedFlights(email);              // read once, set state once
      setSavedFlights(list);

      if (openCardFresh) {
        const openCardNumber = flightRecord?.flightNumber ?? null;
        setFlight(flightDataFromApi(openCardFresh));
        const stored = list.find(f => f.flightNumber === openCardNumber);
        if (stored) setFlightRecord(stored);                  // from disk, so savedAt stays in sync
        setLastUpdated(Date.now());
      }

      if (failures > 0) {
        setRefreshMsg(`> ${failures} ${failures === 1 ? 'flight' : 'flights'} could not be updated`);
        setRefreshTone('error');
        setRefreshMsgCounter(c => c + 1);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  // Everything on screen reads this; `username` stays exactly as sign-in derived it.
  const effectiveName = displayName ?? username;

  // Derived per render from a copy; savedFlights itself is never reordered.
  const sortedSaved = sortSavedByRelevance(savedFlights);

  // Auto-collapse can only hide, never reveal: an open result overrides a
  // persisted expand until the user reveals it for that result.
  const savedShowCollapsed = savedCollapsed || (flight !== null && !savedRevealed);

  const persistCollapsed = async (next: boolean) => {
    setSavedCollapsed(next);
    try { await AsyncStorage.setItem('savedCollapsed', next ? 'true' : 'false'); } catch {}
  };

  const persistDisplayName = async (name: string) => {
    if (Platform.OS === 'web') localStorage.setItem('displayName', name);
    else await SecureStore.setItemAsync('displayName', name);
    setDisplayName(name);
  };

  const isSaved = !!flightRecord && savedFlights.some(f => f.id === flightRecord.id);
  // Recomputed every render, so the bar tracks the ticking `now` state.
  const progressValue = computeProgress(flightRecord, now);

  const handleToggleSave = async () => {
    if (!flightRecord) return;
    setSaveError("");
    if (isSaved) {
      setSavedFlights(await unsaveFlight(email, flightRecord.id));
      showToast('unsaved');
      return;
    }
    const result = await saveFlight(email, flightRecord);
    setSavedFlights(result.flights);
    if (!result.ok) {
      setSaveError('saved flight limit reached — unsave one first');
      return;   // saveError owns this case; no toast
    }
    showToast('saved');
  };

  const clearResultView = () => {
    setFlight(null);
    setFlightRecord(null);
    setChatResponse(null);
    setSaveError("");
    setError("");
    setQuery("");
  };

  return (
    <View style={s.root}>
      <ProfileModal
        visible={profileOpen}
        onClose={() => setProfileOpen(false)}
        username={username}
        email={email}
        effectiveName={effectiveName}
        askName={username !== null && displayName === null}
        onSaveName={async (name) => { await persistDisplayName(name); setProfileOpen(false); }}
        onSkipName={async () => { if (username) await persistDisplayName(username); setProfileOpen(false); }}
        onLogout={async () => {
          if (Platform.OS === 'web') {
            localStorage.removeItem('username');
            localStorage.removeItem('email');
            localStorage.removeItem('displayName');
          } else {
            await SecureStore.deleteItemAsync('username');
            await SecureStore.deleteItemAsync('gmailToken');
            await SecureStore.deleteItemAsync('email');
            await SecureStore.deleteItemAsync('displayName');
          }
          setUsername(null);
          setDisplayName(null);
          setGmailToken(null);
          setEmail(null);
          clearResultView();
          setProfileOpen(false);
        }}
        onGoogleSignIn={async () => {
          console.log('Google sign in tapped, platform: ' + Platform.OS);
          setProfileOpen(false);
          if (Platform.OS === 'web') {
            (window as any).google?.accounts?.id?.prompt();
          } else {
            promptAsync();
          }
        }}
      />
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, paddingTop: insets.top + 12 }}>
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4ade80" colors={["#4ade80"]} />
          }
        >

          {/* ── HEADER ── */}
          <View style={[s.header, effectiveName === null && { marginBottom: 16 }]}>
            <View>
              <Text style={{ fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 }}>{'>_'}</Text>
              {effectiveName !== null && (
                <Text style={{ fontFamily: SANS_SEMI, fontSize: 20, color: '#e2e2e2', marginTop: 10 }}>{`${greetingPrefix(now, greetingIndex)}, ${effectiveName}`}</Text>
              )}
              {effectiveName !== null && (
                <Text style={{ fontFamily: MONO, fontSize: 13, color: 'rgba(226,226,226,0.4)', marginTop: 3 }}>{formatClock(now)}</Text>
              )}
            </View>
            {username !== null && (
              <TouchableOpacity style={s.profileBtn} onPress={() => setProfileOpen(true)}>
                <Text style={s.profileTxt}>{'>//'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ── SEARCH ── */}
          <Animated.View style={{ transform: [{ translateX: errorShake }] }}>
            <Animated.View style={{ marginBottom: 12, borderBottomWidth: 1, borderBottomColor: cardBorderAnim.interpolate({ inputRange: [0, 1, 2], outputRange: ['rgba(255,255,255,0.12)', '#4ade80', 'rgba(248,113,113,0.6)'] }) }}>
              <View style={s.inputContainer}>
                <Text style={s.prompt}>{`~/${effectiveName !== null ? effectiveName.toLowerCase() : 'terminal'}:-$`}</Text>
                <View style={{ flex: 1 }}>
                  <TextInput
                    style={s.input}
                    value={query}
                    onChangeText={(t) => { setQuery(t); setError(""); }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onSubmitEditing={handleSearch}
                    returnKeyType="search"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={200}
                    selectionColor="#4ade80"
                    multiline={false}
                    blurOnSubmit={true}
                  />
                  {query.length === 0 && <AnimatedPlaceholder />}
                </View>
              </View>
            </Animated.View>
          </Animated.View>

          {error !== "" && (
            <Animated.View style={{ opacity: errorMsgOpacity }}>
              <Text style={{ fontFamily: SANS, color: 'rgba(248,113,113,0.8)', fontSize: 11, marginTop: 4, marginBottom: 6, paddingLeft: 18 }}>{`> ${error}`}</Text>
            </Animated.View>
          )}

          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Animated.View style={{ transform: [{ scale: btnScale }] }}>
              <TouchableOpacity
                style={s.searchBtn}
                onPress={handleSearch}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#4ade80" />
                  : <Text style={[s.searchBtnTxt, !query.trim() && s.searchBtnTxtOff]}>{'Execute'}</Text>
                }
              </TouchableOpacity>
            </Animated.View>
          </View>

          {username === null && (
            <View style={{ alignItems: 'center', marginBottom: 24, marginTop: 0 }}>
              <Text style={{ fontFamily: SANS, color: 'rgba(226,226,226,0.5)', fontSize: 11, marginBottom: 12, textAlign: 'center' }}>
                {'// sign in to pull your flights straight from gmail'}
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (Platform.OS === 'web') {
                    (window as any).google?.accounts?.id?.prompt();
                  } else {
                    promptAsync();
                  }
                }}
                style={{ backgroundColor: '#131314', borderWidth: 1, borderColor: '#5f6368', borderRadius: 4, paddingVertical: 11, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' }}
              >
                <Svg width={18} height={18} viewBox="0 0 48 48" style={{ marginRight: 10 }}>
                  <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </Svg>
                <Text style={{ fontFamily: SANS, color: '#e3e3e3', fontSize: 13 }}>Sign in with Google</Text>
              </TouchableOpacity>
            </View>
          )}

          {savedFlights.length > 0 && (
            <View style={{ marginBottom: 24 }}>
              {/* Above the collapse branch: a refresh failure must never be silent. */}
              {refreshMsg !== '' && (
                <Animated.View style={{ opacity: refreshMsgOpacity }}>
                  <Text style={{
                    fontFamily: SANS,
                    fontSize: 11,
                    marginTop: 4,
                    marginBottom: 2,
                    color: refreshTone === 'info' ? 'rgba(226,226,226,0.3)' : 'rgba(248,113,113,0.8)',
                  }}>{refreshMsg}</Text>
                </Animated.View>
              )}
              {savedShowCollapsed ? (
                <TouchableOpacity
                  style={sf.collapsedLine}
                  activeOpacity={0.7}
                  onPress={() => {
                    // Only a persisted collapse writes to storage; a collapse
                    // caused by an open result is revealed in memory.
                    if (savedCollapsed) persistCollapsed(false);
                    else setSavedRevealed(true);
                  }}
                >
                  <Text numberOfLines={1}>
                    <Text style={sf.chevron}>{'\u25B8 '}</Text>
                    <Text style={sf.collapsedNumber}>{sortedSaved[0].flightNumber}</Text>
                    <Text style={sf.collapsedDim}>{' '}</Text>
                    <StatusLine f={sortedSaved[0]} now={now} hideStatus />
                    {savedFlights.length > 1 && (
                      <Text style={sf.collapsedDim}>{` · +${savedFlights.length - 1} more`}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={sf.headingRow}
                    activeOpacity={0.7}
                    onPress={() => {
                      // Collapsing a section that was only revealed for this
                      // result must not overwrite the stored preference.
                      if (flight !== null && !savedCollapsed) setSavedRevealed(false);
                      else persistCollapsed(true);
                    }}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Text style={s.detailsTitle}>{'saved flights'}</Text>
                    <Text style={sf.chevron}>{'\u25BE'}</Text>
                  </TouchableOpacity>
                  {sortedSaved.map(f => (
                    <SavedFlightRow
                      key={f.id}
                      flight={f}
                      now={now}
                      onPress={() => renderSavedFlight(f)}
                      onUnsave={async () => setSavedFlights(await unsaveFlight(email, f.id))}
                    />
                  ))}
                </>
              )}
            </View>
          )}

          {chatResponse && (
            <Animated.View style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View style={{ marginBottom: 4 }}>
                <Text style={s.detailsTitle}>{'response'}</Text>
                <Text style={{ fontFamily: SANS, color: '#e2e2e2', fontSize: 13, lineHeight: 22 }}>{chatResponse}</Text>
              </View>
            </Animated.View>
          )}

          {/* ── RESULT ── */}
          {flight && (
            <Animated.View
              style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}
            >
              {/* Flight header + status line, ruled off from the route block */}
              <View style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)', paddingBottom: 16, marginBottom: 4 }}>
                <View style={s.flightHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.flightNumber} numberOfLines={1}>{flight.flight}</Text>
                    <Text style={s.flightAirline}>{flight.airline}</Text>
                  </View>
                  <Animated.View style={[s.statusBadge, { backgroundColor: flight.statusBg, borderColor: flight.statusColor + "50", opacity: flight.status === 'ACTIVE' ? badgePulse : 1 }]}>
                    <Text style={[s.statusTxt, { color: flight.statusColor }]}>{flight.status}</Text>
                  </Animated.View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <TouchableOpacity
                      onPress={handleToggleSave}
                      activeOpacity={0.7}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                      }}
                    >
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path
                          d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"
                          fill={isSaved ? '#4ade80' : 'none'}
                          stroke={isSaved ? '#4ade80' : 'rgba(226,226,226,0.5)'}
                          strokeWidth={1.75}
                        />
                      </Svg>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={async () => {
                        if (!flightRecord) return;
                        const ok = await runFlightLookup(flightRecord.flightNumber, true);
                        if (ok) showToast('updated');
                      }}
                      activeOpacity={0.7}
                      disabled={loading}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                      }}
                    >
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path
                          d="M21 12a9 9 0 1 1-3.5-7.1"
                          fill="none"
                          stroke={loading ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.6)'}
                          strokeWidth={1.75}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <Path
                          d="M21 3v6h-6"
                          fill="none"
                          stroke={loading ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.6)'}
                          strokeWidth={1.75}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </Svg>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={clearResultView}
                      activeOpacity={0.7}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 4,
                        // Cancels this control's own right padding so the ink
                        // sits on the content edge, flush with the arrival IATA
                        // code below it. hitSlop keeps the tap area intact.
                        marginRight: -4,
                      }}
                    >
                      {/* Spans 5..19 of the 24-unit box to match the bookmark's
                          3..21; the old 6..18 read visibly smaller at the same
                          nominal size. */}
                      <Svg width={20} height={20} viewBox="0 0 24 24">
                        <Path
                          d="M19 5 5 19"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                        <Path
                          d="M5 5l14 14"
                          fill="none"
                          stroke="rgba(248,113,113,0.55)"
                          strokeWidth={1.75}
                          strokeLinecap="round"
                        />
                      </Svg>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={{ flexDirection: 'column', gap: 4 }}>
                  {saveError !== '' ? (
                    <Text style={{ fontFamily: SANS, fontSize: 11, color: 'rgba(248,113,113,0.8)' }}>{`> ${saveError}`}</Text>
                  ) : flightRecord ? (
                    <StatusLine f={flightRecord} now={now} hideStatus />
                  ) : (
                    <Text style={{ fontFamily: MONO, fontSize: 11, color: 'rgba(226,226,226,0.3)' }}>{lastUpdated !== null ? `updated ${timeAgo(lastUpdated, now)}` : ''}</Text>
                  )}
                </View>

                {/* Fixed height reserves the line so the block never reflows. */}
                <View style={{ minHeight: 16, alignItems: 'flex-start' }}>
                  {saveError === '' && toastMsg !== '' && (
                    <Animated.Text style={{
                      opacity: toastOpacity,
                      fontFamily: SANS,
                      fontSize: 11,
                      color: 'rgba(226,226,226,0.5)',
                    }}>{toastMsg}</Animated.Text>
                  )}
                </View>
              </View>

              {/* Route card — fixed overflow */}
              <View style={s.routeCard}>
                <View style={s.routeLeft}>
                  <Text style={s.routeIATA}>{flight.from}</Text>
                  <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.fromCity)}</Text>
                  <Text style={s.routeTime}>{flight.dep}</Text>
                </View>
                <View style={s.routeMid}>
                  {flight.duration !== null && <Text style={s.routeDuration}>{flight.duration}</Text>}
                  <Text style={s.routeArrow}>· ✈ ·</Text>
                  <Text style={s.routeDirect}>Direct</Text>
                </View>
                <View style={s.routeRight}>
                  <Text style={s.routeIATA}>{flight.to}</Text>
                  <Text style={s.routeCity} numberOfLines={2}>{trimAirportName(flight.toCity)}</Text>
                  <Text style={s.routeTime}>{flight.arr}</Text>
                </View>
              </View>

              {/* Progress bar — hidden entirely when the flight state cannot place it */}
              {progressValue !== null && (flight.status === 'ACTIVE' || flight.status === 'LANDED') && (
                <ProgressBar
                  progress={progressValue}
                  color={flight.statusColor}
                />
              )}

              {/* Flight details */}
              <View style={{ marginTop: 8 }}>
                <Text style={s.detailsTitle}>Flight Details</Text>
                <InfoRow label="Date" value={flight.date} />
                <InfoRow label="Scheduled Departure" value={flight.dep} />
                <InfoRow label={flight.depTimeLabel} value={flight.depTimeValue} />
                <InfoRow label="Scheduled Arrival" value={flight.arr} />
                <InfoRow label={flight.arrTimeLabel} value={flight.arrTimeValue} />
                <InfoRow label="Terminal" value={flight.terminal} />
                <InfoRow label="Gate" value={flight.gate} />
                {flight.checkinDesk !== null && <InfoRow label="Check-in Desk" value={flight.checkinDesk} />}
                {flight.delayLabel !== null && flight.delayValue !== null && (
                  <InfoRow label={flight.delayLabel} value={flight.delayValue} />
                )}
                <InfoRow label="Baggage Belt" value={flight.baggage} />
                {flight.aircraft !== null && <InfoRow label="Aircraft" value={flight.aircraft} />}
                {flight.registration !== null && <InfoRow label="Registration" value={flight.registration} />}
              </View>

              {/* Airports */}
              <View style={{ marginTop: 8 }}>
                <Text style={s.detailsTitle}>Airports</Text>
                <InfoRow label="Departing From" value={flight.fromFull} sans />
                <InfoRow label="Arriving At" value={flight.toFull} sans />
              </View>

            </Animated.View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050505" },
  scroll: { paddingHorizontal: 20, paddingBottom: 48 },

  header: { marginBottom: 36, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  profileBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },
  profileTxt: { color: 'rgba(226,226,226,0.5)', fontSize: 11, fontFamily: MONO },

  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 20,
  },
  prompt: {
    color: "#4ade80",
    fontFamily: MONO,
    fontSize: 13,
    marginRight: 8,
    paddingTop: 2,
  },

  input: {
    fontSize: 15,
    color: "#ffffff",
    fontFamily: MONO,
    textAlign: "left",
  },

  fakePlaceholder: {
    position: "absolute",
    left: 0,
    fontSize: 15,
    fontWeight: "300",
    color: "#2c2c2e",
    letterSpacing: 1,
  },

  searchBtn: {
    paddingVertical: 8, paddingHorizontal: 0,
    // Pinned so swapping the label for the spinner cannot resize the row.
    minHeight: 40,
    alignItems: "center", justifyContent: "center",
  },
  searchBtnTxt: { fontSize: 15, color: "#4ade80", fontFamily: MONO_BOLD },
  searchBtnTxtOff: { color: "rgba(226,226,226,0.25)" },

  resultWrap: { gap: 14 },

  flightHeader: {
    flexDirection: "row", justifyContent: "flex-start", alignItems: "flex-start",
    paddingVertical: 4,
  },
  flightNumber: { fontSize: 32, color: "#ffffff", letterSpacing: 1, fontFamily: MONO_BOLD },
  flightAirline: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 3, fontFamily: SANS },
  statusBadge: {
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1,
    flexShrink: 0,
    marginRight: 16,
  },
  statusTxt: { fontSize: 11, letterSpacing: 0.5, fontFamily: MONO_BOLD },

  routeCard: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 4,
  },
  routeLeft: { flex: 1 },
  routeRight: { flex: 1, alignItems: "flex-end" },
  routeMid: { alignItems: "center", paddingHorizontal: 8 },
  routeIATA: { fontSize: 32, color: "#ffffff", letterSpacing: -0.5, fontFamily: MONO_BOLD },
  routeCity: { fontSize: 13, color: "rgba(226,226,226,0.55)", marginTop: 2, fontFamily: SANS },
  routeTime: { fontSize: 13, color: "#aeaeb2", marginTop: 8, fontFamily: MONO_BOLD },
  routeDuration: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginBottom: 6, fontFamily: MONO },
  routeArrow: { fontSize: 20, color: "rgba(226,226,226,0.45)", fontFamily: MONO },
  routeDirect: { fontSize: 13, color: "rgba(226,226,226,0.5)", marginTop: 6, fontFamily: MONO },

  detailsTitle: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: SANS_SEMI,
    marginBottom: 10, letterSpacing: 1, textTransform: "uppercase",
  },
});

const pm = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#050505',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 52,
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 20,
    right: 24,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeTxt: { color: '#4ade80', fontSize: 15, fontFamily: MONO },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1.5,
    borderColor: 'rgba(74,222,128,0.4)',
    backgroundColor: 'rgba(74,222,128,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 4,
  },
  avatarTxt: { color: '#4ade80', fontSize: 20, fontFamily: MONO },
  name: { fontSize: 20, color: '#ffffff', fontFamily: MONO },
  sub: {
    fontSize: 13,
    color: 'rgba(226,226,226,0.4)',
    fontFamily: MONO,
    marginBottom: 32,
    textAlign: 'center',
  },
  authBtn: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  authBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameLabel: {
    fontFamily: SANS,
    fontSize: 11,
    color: 'rgba(226,226,226,0.4)',
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', marginBottom: 8 },
  nameInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 13,
    color: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  nameBtn: {
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.4)',
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  nameBtnTxt: { fontFamily: MONO, fontSize: 13, color: '#4ade80' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  pencil: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)' },
  authBtnTxt: { color: '#ffffff', fontSize: 15, fontFamily: MONO },
});