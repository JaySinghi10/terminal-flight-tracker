import { useState, useRef, useEffect } from "react";
import Svg, { Path, Rect, G } from 'react-native-svg';
import * as SecureStore from 'expo-secure-store';
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
  Dimensions,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Easing,
  PanResponder,
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

const FLIGHT_REGEX = /^[A-Z]{2}\d{2,4}$/;

// These caps protect the AviationStack quota.
const PULL_COOLDOWN_MS = 60 * 1000;
const AUTO_REFRESH_MAX_FLIGHTS = 2;
const AUTO_REFRESH_MIN_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000; // auto-refresh disabled while on the free tier; set to 12 * 60 * 60 * 1000 to re-enable
const AUTO_REFRESH_RESUME_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const COUNTDOWN_MAX_AGE_MS = 3 * 60 * 60 * 1000; // how fresh data must be to show a live countdown; lower to 30 * 60 * 1000 or 10 * 60 * 1000 for stricter honesty

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
    case "active": return "#30d158";
    case "scheduled": return "#4ade80";
    case "delayed": return "#ff9f0a";
    default: return "#ff9f0a";
  }
}

function getStatusBg(status: string) {
  switch (status) {
    case "landed": return "#8e8e9312";
    case "active": return "#30d15812";
    case "scheduled": return "#4ade8012";
    case "delayed": return "#ff9f0a12";
    default: return "#ff9f0a12";
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
    fromFull: dep.airport || "—",
    fromCity: dep.airport || "—",
    to: arr.iata || "—",
    toFull: arr.airport || "—",
    toCity: arr.airport || "—",
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

function localDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function trimAirportName(name: string) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf(' (');
  return (i >= 0 ? name.slice(0, i) : name).trim();
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={ir.row}>
      <Text style={ir.label}>{label}</Text>
      <Text style={[ir.value, highlight && ir.highlight]}>{value}</Text>
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
    borderBottomColor: "#111111",
  },
  label: { fontSize: 14, color: "rgba(226,226,226,0.4)", fontWeight: "500", fontFamily: "Courier New" },
  value: { fontSize: 14, color: "#ffffff", fontWeight: "600", textAlign: "right", flex: 1, marginLeft: 16, fontFamily: "Courier New" },
  highlight: { color: "#4ade80" },
});

// --- Live-countdown helpers -------------------------------------------------
const CD_GREEN = '#4ade80';
const CD_AGE = 'rgba(226,226,226,0.3)';
const CD_LATE = 'rgba(255,69,58,0.8)';
const CD_EARLY = '#4ade80';

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
        const segs: LineSeg[] = [statusSeg, { text: ` · ${formatCountdown(ago)} ago`, color: CD_GREEN }];
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

function StatusLine({ f, now, style, numberOfLines }: { f: SavedFlight; now: number; style?: any; numberOfLines?: number }) {
  const segs = flightLineSegments(f, now);
  return (
    <Text style={[{ fontFamily: 'Courier New', fontSize: 11 }, style]} numberOfLines={numberOfLines}>
      {segs.map((seg, i) => <Text key={i} style={{ color: seg.color }}>{seg.text}</Text>)}
    </Text>
  );
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
      <StatusLine f={flight} now={now} numberOfLines={1} style={{ fontWeight: '600', marginTop: 4 }} />
    </TouchableOpacity>
  );
}

const sf = StyleSheet.create({
  row: {
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: '#111111',
  },
  line1: { flexDirection: 'row', alignItems: 'center' },
  number: { fontSize: 13, color: '#ffffff', fontWeight: '700', fontFamily: 'Courier New' },
  route: { fontSize: 13, color: 'rgba(226,226,226,0.4)', fontWeight: '500', fontFamily: 'Courier New', flex: 1, marginLeft: 12 },
  line2: { fontSize: 11, fontWeight: '600', fontFamily: 'Courier New', marginTop: 4 },
  updated: { color: 'rgba(226,226,226,0.3)' },
  remove: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,69,58,0.75)',
    fontFamily: 'Courier New',
    paddingLeft: 12,
  },
});

function ProgressBar({ progress, color, from, to }: { progress: number; color: string; from: string; to: string }) {
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
      <View style={pg.endpoints}>
        <Text style={pg.endpoint}>{from}</Text>
        <Text style={pg.endpoint}>{to}</Text>
      </View>
    </View>
  );
}

const pg = StyleSheet.create({
  wrap: { marginVertical: 24, position: "relative" },
  track: { height: 3, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 2, marginBottom: 14 },
  fill: { height: 3, borderRadius: 2 },
  plane: { position: "absolute", top: -11, fontSize: 20, color: "#ffffff" },
  endpoints: { flexDirection: "row", justifyContent: "space-between" },
  endpoint: { fontSize: 12, color: "#48484a", fontWeight: "700", letterSpacing: 1, fontFamily: "Courier New" },
});

function WebDotGrid() {
  const ref = useRef<any>(null);

  useEffect(() => {
    const style = document.createElement('style');
    style.id = 'dot-grid-style';
    style.textContent = `
      #dot-grid-bg {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background-color: #050505;
        z-index: 0;
        overflow: hidden;
        pointer-events: none;
      }
      #dot-grid-bg::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background-image: radial-gradient(rgba(255,255,255,0.22) 1px, transparent 1px);
        background-size: 20px 20px;
        -webkit-mask-image: radial-gradient(circle 400px at var(--mouse-x, 50%) var(--mouse-y, 50%), black 0%, transparent 100%);
        mask-image: radial-gradient(circle 400px at var(--mouse-x, 50%) var(--mouse-y, 50%), black 0%, transparent 100%);
      }
    `;
    if (!document.getElementById('dot-grid-style')) {
      document.head.appendChild(style);
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (ref.current) {
        ref.current.style.setProperty('--mouse-x', `${e.clientX}px`);
        ref.current.style.setProperty('--mouse-y', `${e.clientY}px`);
      }
    };
    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.getElementById('dot-grid-style')?.remove();
    };
  }, []);

  return <View ref={ref} nativeID="dot-grid-bg" pointerEvents="none" />;
}

function MobileDotGrid() {
  const { width, height } = Dimensions.get('window');
  const touchX = useRef(new Animated.Value(0)).current;
  const touchY = useRef(new Animated.Value(0)).current;
  const touchOpacity = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: () => false,
      onPanResponderTerminationRequest: () => true,
      onPanResponderGrant: (e) => {
        touchX.setValue(e.nativeEvent.pageX);
        touchY.setValue(e.nativeEvent.pageY);
        Animated.timing(touchOpacity, { toValue: 0.18, duration: 150, useNativeDriver: false }).start();
      },
      onPanResponderMove: (e) => {
        touchX.setValue(e.nativeEvent.pageX);
        touchY.setValue(e.nativeEvent.pageY);
      },
      onPanResponderRelease: () => {
        Animated.timing(touchOpacity, { toValue: 0, duration: 300, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => {
        Animated.timing(touchOpacity, { toValue: 0, duration: 300, useNativeDriver: false }).start();
      },
    })
  ).current;

  const cols = Math.ceil(width / 20);
  const rows = Math.ceil(height / 20);

  return (
    <View style={[StyleSheet.absoluteFillObject, { pointerEvents: 'none' }]} {...panResponder.panHandlers} pointerEvents="none">
      <View style={[StyleSheet.absoluteFillObject, { opacity: 0.06 }]} pointerEvents="none">
        {Array.from({ length: rows }).map((_, r) => (
          <View key={r} style={{ flexDirection: 'row', position: 'absolute', top: r * 20 }}>
            {Array.from({ length: cols }).map((_, c) => (
              <View key={c} style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: '#ffffff', marginRight: 18 }} />
            ))}
          </View>
        ))}
      </View>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: 400,
          height: 400,
          borderRadius: 200,
          backgroundColor: '#ffffff',
          opacity: touchOpacity,
          left: -200,
          top: -200,
          transform: [{ translateX: touchX }, { translateY: touchY }],
        }}
      />
    </View>
  );
}

function ProfileModal({ visible, onClose, onGoogleSignIn, onLogout, username }: { visible: boolean; onClose: () => void; onGoogleSignIn: () => void; onLogout: () => void; username: string | null }) {
  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={onClose}>
      <View style={pm.backdrop}>
        <View style={pm.sheet}>
          <TouchableOpacity style={pm.closeBtn} onPress={onClose}>
            <Text style={pm.closeTxt}>X</Text>
          </TouchableOpacity>

          <View style={pm.avatar}>
            <Text style={pm.avatarTxt}>{'//'}</Text>
          </View>
          <Text style={pm.name}>{username ?? 'Guest User'}</Text>
          <Text style={pm.sub}>{username ? `signed in as ${username}` : 'Sign in to sync your flights'}</Text>

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
              style={{ borderWidth: 1, borderColor: '#ff453a', borderRadius: 4, padding: 12, marginTop: 16, alignItems: 'center', width: '100%' }}
            >
              <Text style={{ fontFamily: 'Courier New', color: '#ff453a' }}> Log out </Text>
            </TouchableOpacity>
          )}

          <Text style={pm.version}>{'// terminal v0.1.0'}</Text>
        </View>
      </View>
    </Modal>
  );
}

function AnimatedLogo() {
  const VARIABLE = 'Terminal';
  const [text, setText] = useState(VARIABLE);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setCursorVisible(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>(r => { timer = setTimeout(r, ms); });

    const loop = async () => {
      while (!cancelled) {
        await sleep(2000);
        if (cancelled) break;

        for (let i = VARIABLE.length - 1; i >= 0 && !cancelled; i--) {
          await sleep(150);
          setText(VARIABLE.slice(0, i));
        }
        if (cancelled) break;

        await sleep(400);
        if (cancelled) break;

        for (let i = 1; i <= VARIABLE.length && !cancelled; i++) {
          await sleep(150);
          setText(VARIABLE.slice(0, i));
        }
      }
    };

    loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const ts = { fontSize: 28, fontFamily: 'Courier New', fontWeight: '700' as const };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={[ts, { color: '#4ade80' }]}>{'> '}</Text>
      {text.length > 0 && <Text style={[ts, { color: '#e2e2e2' }]}>{text}</Text>}
      <Text style={[ts, { color: '#4ade80', opacity: cursorVisible ? 1 : 0 }]}>{'_'}</Text>
    </View>
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
      style={{ position: 'absolute', left: 0, right: 0, top: 0, color: '#2c2c2e', fontFamily: 'Courier New', fontSize: 15 }}
      pointerEvents="none"
    >
      {text}
    </Text>
  );
}

function DotGrid({ scrollY }: { scrollY: Animated.Value }) {
  void scrollY;
  if (Platform.OS === 'web') return <WebDotGrid />;
  return <MobileDotGrid />;
}

export default function Index() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [flight, setFlight] = useState<FlightData | null>(null);
  const [focused, setFocused] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [resultHeight, setResultHeight] = useState(0);
  const [errorCounter, setErrorCounter] = useState(0);
  const [chatResponse, setChatResponse] = useState<string | null>(null);
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  const [flightRecord, setFlightRecord] = useState<SavedFlight | null>(null);
  const [saveError, setSaveError] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshMsgCounter, setRefreshMsgCounter] = useState(0);
  const [refreshTone, setRefreshTone] = useState<'error' | 'info'>('error');
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
          setProfileOpen(false);
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
      setAuthHydrated(true);
    } else {
      Promise.all([
        SecureStore.getItemAsync('username'),
        SecureStore.getItemAsync('gmailToken'),
        SecureStore.getItemAsync('email'),
      ]).then(([u, t, e]) => {
        if (u) setUsername(u);
        if (t) setGmailToken(t);
        if (e) setEmail(e);
        setAuthHydrated(true);
      });
    }
  }, []);

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
          setProfileOpen(false);
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
  const scrollY = useRef(new Animated.Value(0)).current;
  const cardBorderAnim = useRef(new Animated.Value(0)).current;
  const btnBorderAnim = useRef(new Animated.Value(0)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;
  const scanlineAnim = useRef(new Animated.Value(0)).current;
  const errorMsgOpacity = useRef(new Animated.Value(0)).current;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const lastAutoRefreshRef = useRef(0);
  const dayRef = useRef(localDayKey(Date.now()));
  const refreshMsgOpacity = useRef(new Animated.Value(0)).current;
  const refreshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cardBorderAnim.stopAnimation();
    btnBorderAnim.stopAnimation();
    if (loading) {
      const fastPulse = (anim: Animated.Value) => Animated.loop(Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 200, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: false }),
      ]));
      fastPulse(cardBorderAnim).start();
      fastPulse(btnBorderAnim).start();
    } else if (focused) {
      Animated.loop(Animated.sequence([
        Animated.timing(cardBorderAnim, { toValue: 1, duration: 530, useNativeDriver: false }),
        Animated.timing(cardBorderAnim, { toValue: 0, duration: 530, useNativeDriver: false }),
      ])).start();
      btnBorderAnim.setValue(0);
    } else {
      cardBorderAnim.setValue(0);
      btnBorderAnim.setValue(0);
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
    scanlineAnim.setValue(0);
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
    Animated.timing(scanlineAnim, {
      toValue: 1, duration: 600,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
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
    setFlight({
      flight: saved.flightNumber,
      airline: saved.airline,
      status: savedStatus.toUpperCase(),
      statusColor: getStatusColor(savedStatus),
      statusBg: getStatusBg(savedStatus),
      from: saved.from.iata,
      fromFull: saved.from.airport,
      fromCity: saved.from.airport,
      to: saved.to.iata,
      toFull: saved.to.airport,
      toCity: saved.to.airport,
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
      setError("Please enter a flight number.");
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

  const isSaved = !!flightRecord && savedFlights.some(f => f.id === flightRecord.id);
  // Recomputed every render, so the bar tracks the ticking `now` state.
  const progressValue = computeProgress(flightRecord, now);

  const handleToggleSave = async () => {
    if (!flightRecord) return;
    setSaveError("");
    if (isSaved) {
      setSavedFlights(await unsaveFlight(email, flightRecord.id));
      return;
    }
    const result = await saveFlight(email, flightRecord);
    setSavedFlights(result.flights);
    if (!result.ok) {
      setSaveError('saved flight limit reached — unsave one first');
    }
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
        onLogout={async () => {
          if (Platform.OS === 'web') {
            localStorage.removeItem('username');
            localStorage.removeItem('email');
          } else {
            await SecureStore.deleteItemAsync('username');
            await SecureStore.deleteItemAsync('gmailToken');
            await SecureStore.deleteItemAsync('email');
          }
          setUsername(null);
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
      <DotGrid scrollY={scrollY} />
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, paddingTop: insets.top + 12 }}>
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4ade80" colors={["#4ade80"]} />
          }
        >

          {/* ── HEADER ── */}
          <View style={s.header}>
            <View>
              <AnimatedLogo />
              <Text style={s.appSub}>{'// flight intelligence'}</Text>
            </View>
            {username !== null && (
              <TouchableOpacity style={s.profileBtn} onPress={() => setProfileOpen(true)}>
                <Text style={s.profileTxt}>{'>//'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ── SEARCH ── */}
          <Text style={s.inputLabel}>Flight Number</Text>

          <Animated.View style={{ transform: [{ translateX: errorShake }] }}>
            <Animated.View style={[s.searchCard, { borderColor: cardBorderAnim.interpolate({ inputRange: [0, 1, 2], outputRange: ['rgba(74,222,128,0.3)', '#4ade80', 'rgba(255,69,58,0.6)'] }) }]}>
              <View style={s.inputContainer}>
                <Text style={s.prompt}>{username !== null ? `~/${username}:-$` : '~/terminal:-$'}</Text>
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
                    multiline
                    scrollEnabled={false}
                    textAlignVertical="top"
                    blurOnSubmit={true}
                  />
                  {query.length === 0 && <AnimatedPlaceholder />}
                </View>
              </View>
            </Animated.View>
          </Animated.View>

          {error !== "" && (
            <Animated.View style={{ opacity: errorMsgOpacity }}>
              <Text style={{ color: 'rgba(255,69,58,0.8)', fontFamily: 'Courier New', fontSize: 12, marginTop: 4, marginBottom: 6, paddingLeft: 18 }}>{`> ${error}`}</Text>
            </Animated.View>
          )}

          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Animated.View style={{ transform: [{ scale: btnScale }] }}>
              <Animated.View style={{ borderRadius: 4, borderWidth: 1, borderColor: query.trim() ? btnBorderAnim.interpolate({ inputRange: [0, 1], outputRange: ['rgba(74,222,128,0.3)', '#4ade80'] }) : 'rgba(255,255,255,0.07)' }}>
                <TouchableOpacity
                  style={[s.searchBtn, query.trim() ? s.searchBtnOn : s.searchBtnOff]}
                  onPress={handleSearch}
                  activeOpacity={0.85}
                >
                  {loading
                    ? <ActivityIndicator color="#ffffff" />
                    : <Text style={[s.searchBtnTxt, !query.trim() && s.searchBtnTxtOff]}>{'Execute'}</Text>
                  }
                </TouchableOpacity>
              </Animated.View>
            </Animated.View>
          </View>

          {username === null && (
            <View style={{ alignItems: 'center', marginBottom: 24, marginTop: 0 }}>
              <Text style={{ color: 'rgba(226,226,226,0.5)', fontFamily: 'Courier New', fontSize: 12, marginBottom: 12, textAlign: 'center' }}>
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
                <Text style={{ color: '#e3e3e3', fontSize: 14, fontWeight: '500' }}>Sign in with Google</Text>
              </TouchableOpacity>
            </View>
          )}

          {savedFlights.length > 0 && (
            <View style={[s.detailsCard, { marginBottom: 14 }]}>
              <Text style={s.detailsTitle}>{'> saved flights'}</Text>
              {refreshMsg !== '' && (
                <Animated.View style={{ opacity: refreshMsgOpacity }}>
                  <Text style={{
                    fontFamily: 'Courier New',
                    fontSize: 12,
                    marginTop: 4,
                    marginBottom: 2,
                    color: refreshTone === 'info' ? 'rgba(226,226,226,0.3)' : 'rgba(255,69,58,0.8)',
                  }}>{refreshMsg}</Text>
                </Animated.View>
              )}
              {savedFlights.map(f => (
                <SavedFlightRow
                  key={f.id}
                  flight={f}
                  now={now}
                  onPress={() => renderSavedFlight(f)}
                  onUnsave={async () => setSavedFlights(await unsaveFlight(email, f.id))}
                />
              ))}
            </View>
          )}

          {chatResponse && (
            <Animated.View style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}>
              <View style={s.detailsCard}>
                <Text style={s.detailsTitle}>{'> response'}</Text>
                <Text style={{ color: '#e2e2e2', fontFamily: 'Courier New', fontSize: 14, lineHeight: 22 }}>{chatResponse}</Text>
              </View>
            </Animated.View>
          )}

          {/* ── RESULT ── */}
          {flight && (
            <Animated.View
              style={[s.resultWrap, { opacity: resultOpacity, transform: [{ translateY: resultTranslate }] }]}
              onLayout={(e) => setResultHeight(e.nativeEvent.layout.height)}
            >
              <Animated.View
                pointerEvents="none"
                style={{
                  position: 'absolute', left: 0, right: 0, height: 2, zIndex: 10,
                  backgroundColor: '#4ade80', opacity: 0.4,
                  transform: [{ translateY: scanlineAnim.interpolate({ inputRange: [0, 1], outputRange: [0, resultHeight] }) }],
                }}
              />

              {/* Flight header */}
              <View style={s.flightHeader}>
                <View>
                  <Text style={s.flightNumber}>{flight.flight}</Text>
                  <Text style={s.flightAirline}>{flight.airline}</Text>
                </View>
                <Animated.View style={[s.statusBadge, { backgroundColor: flight.statusBg, borderColor: flight.statusColor + "50", opacity: flight.status === 'ACTIVE' ? badgePulse : 1 }]}>
                  <Text style={[s.statusTxt, { color: flight.statusColor }]}>{flight.status}</Text>
                </Animated.View>
              </View>

              <View style={{ flexDirection: 'column', gap: 4 }}>
                {saveError !== '' ? (
                  <Text style={{ fontFamily: 'Courier New', fontSize: 11, color: 'rgba(255,69,58,0.8)', marginBottom: 10 }}>{`> ${saveError}`}</Text>
                ) : flightRecord ? (
                  <StatusLine f={flightRecord} now={now} style={{ marginBottom: 10 }} />
                ) : (
                  <Text style={{ fontFamily: 'Courier New', fontSize: 11, color: 'rgba(226,226,226,0.3)', marginBottom: 10 }}>{lastUpdated !== null ? `updated ${timeAgo(lastUpdated, now)}` : ''}</Text>
                )}
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 14 }}>
                  <TouchableOpacity
                    onPress={handleToggleSave}
                    activeOpacity={0.7}
                    style={{
                      borderWidth: 1,
                      borderColor: isSaved ? 'rgba(226,226,226,0.2)' : 'rgba(74,222,128,0.3)',
                      borderRadius: 4,
                      paddingVertical: 6,
                      paddingHorizontal: 14,
                    }}
                  >
                    <Text style={{
                      fontFamily: 'Courier New',
                      fontSize: 13,
                      fontWeight: '700',
                      color: isSaved ? 'rgba(226,226,226,0.4)' : '#4ade80',
                    }}>
                      {isSaved ? 'saved' : 'save'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { if (flightRecord) runFlightLookup(flightRecord.flightNumber, true); }}
                    activeOpacity={0.7}
                    disabled={loading}
                    style={{
                      borderWidth: 1,
                      borderColor: 'rgba(226,226,226,0.15)',
                      borderRadius: 4,
                      paddingVertical: 6,
                      paddingHorizontal: 14,
                    }}
                  >
                    <Text style={{
                      fontFamily: 'Courier New',
                      fontSize: 13,
                      fontWeight: '700',
                      color: loading ? 'rgba(226,226,226,0.22)' : 'rgba(226,226,226,0.4)',
                    }}>
                      {'refresh'}
                    </Text>
                  </TouchableOpacity>
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
              {progressValue !== null && (
                <ProgressBar
                  progress={progressValue}
                  color={flight.statusColor}
                  from={flight.from}
                  to={flight.to}
                />
              )}

              {/* Flight details */}
              <View style={s.detailsCard}>
                <Text style={s.detailsTitle}>Flight Details</Text>
                <InfoRow label="Date" value={flight.date} />
                <InfoRow label="Scheduled Departure" value={flight.dep} highlight />
                <InfoRow label={flight.depTimeLabel} value={flight.depTimeValue} />
                <InfoRow label="Scheduled Arrival" value={flight.arr} highlight />
                <InfoRow label={flight.arrTimeLabel} value={flight.arrTimeValue} />
                <InfoRow label="Terminal" value={flight.terminal} />
                <InfoRow label="Gate" value={flight.gate} highlight />
                {flight.checkinDesk !== null && <InfoRow label="Check-in Desk" value={flight.checkinDesk} />}
                {flight.delayLabel !== null && flight.delayValue !== null && (
                  <InfoRow label={flight.delayLabel} value={flight.delayValue} />
                )}
                <InfoRow label="Baggage Belt" value={flight.baggage} />
                {flight.aircraft !== null && <InfoRow label="Aircraft" value={flight.aircraft} />}
                {flight.registration !== null && <InfoRow label="Registration" value={flight.registration} />}
              </View>

              {/* Airports */}
              <View style={s.detailsCard}>
                <Text style={s.detailsTitle}>Airports</Text>
                <InfoRow label="Departing From" value={flight.fromFull} />
                <InfoRow label="Arriving At" value={flight.toFull} />
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

  header: { marginBottom: 36, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  profileBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)',
    backgroundColor: 'rgba(74,222,128,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  profileTxt: { color: '#4ade80', fontSize: 12, fontFamily: 'Courier New' },
  appName: { fontSize: 32, fontWeight: "700", color: "#ffffff", letterSpacing: -0.5, fontFamily: "Courier New" },
  appSub: { fontSize: 14, color: "rgba(226,226,226,0.4)", fontWeight: "400", marginTop: 5, letterSpacing: 0.2, fontFamily: "Courier New" },

  inputLabel: {
    fontSize: 13, fontWeight: "700",
    color: "#4ade80", letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 10,
    fontFamily: "Courier New",
  },

  searchCard: {
    backgroundColor: "transparent",
    borderRadius: 4,
    borderWidth: 1, borderColor: "#4ade80",
    paddingHorizontal: 18,
    marginBottom: 12,
  },

  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 18,
  },
  prompt: {
    color: "#4ade80",
    fontFamily: "Courier New",
    fontSize: 13,
    marginRight: 8,
    paddingTop: 2,
  },

  input: {
    fontSize: 15,
    fontWeight: "400",
    color: "#ffffff",
    fontFamily: "Courier New",
    textAlignVertical: "top",
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
    borderRadius: 4, paddingVertical: 8, paddingHorizontal: 30,
    alignItems: "center", justifyContent: "center", alignSelf: "center",
  },
  searchBtnOn: {
    backgroundColor: "transparent",
  },
  searchBtnOff: { backgroundColor: "rgba(255,255,255,0.03)" },
  searchBtnTxt: { fontSize: 16, fontWeight: "700", color: "#4ade80", fontFamily: "Courier New" },
  searchBtnTxtOff: { color: "#3a3a3c" },

  resultWrap: { gap: 14 },

  flightHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 12, padding: 20,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.07)",
  },
  flightNumber: { fontSize: 32, fontWeight: "900", color: "#ffffff", letterSpacing: 1, fontFamily: "Courier New" },
  flightAirline: { fontSize: 14, color: "#636366", fontWeight: "500", marginTop: 3, fontFamily: "Courier New" },
  statusBadge: {
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1,
  },
  statusTxt: { fontSize: 13, fontWeight: "800", letterSpacing: 0.5, fontFamily: "Courier New" },

  routeCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 12, padding: 20,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.07)",
  },
  routeLeft: { flex: 1 },
  routeRight: { flex: 1, alignItems: "flex-end" },
  routeMid: { alignItems: "center", paddingHorizontal: 8 },
  routeIATA: { fontSize: 36, fontWeight: "900", color: "#ffffff", letterSpacing: -0.5, fontFamily: "Courier New" },
  routeCity: { fontSize: 11, color: "#636366", fontWeight: "500", marginTop: 2, fontFamily: "Courier New" },
  routeTime: { fontSize: 15, fontWeight: "700", color: "#aeaeb2", marginTop: 8, fontFamily: "Courier New" },
  routeDuration: { fontSize: 11, color: "#48484a", fontWeight: "600", marginBottom: 6 },
  routeArrow: { fontSize: 16, color: "#3a3a3c" },
  routeDirect: { fontSize: 10, color: "#48484a", fontWeight: "600", marginTop: 6 },

  detailsCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 12, padding: 20,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.07)",
    marginBottom: 2,
  },
  detailsTitle: {
    fontSize: 16, fontWeight: "800", color: "#4ade80",
    marginBottom: 4, letterSpacing: -0.2, fontFamily: "Courier New",
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
  closeTxt: { color: '#4ade80', fontSize: 16, fontWeight: '700', fontFamily: 'Courier New' },
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
  avatarTxt: { color: '#4ade80', fontSize: 22, fontFamily: 'Courier New' },
  name: { fontSize: 22, fontWeight: '700', color: '#ffffff', fontFamily: 'Courier New', marginBottom: 8 },
  sub: {
    fontSize: 14,
    color: 'rgba(226,226,226,0.4)',
    fontFamily: 'Courier New',
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
  authBtnTxt: { color: '#ffffff', fontSize: 15, fontWeight: '600', fontFamily: 'Courier New' },
  version: {
    marginTop: 20,
    fontSize: 12,
    color: 'rgba(226,226,226,0.22)',
    fontFamily: 'Courier New',
  },
});