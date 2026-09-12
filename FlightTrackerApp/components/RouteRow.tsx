// ONE ROW OF THE ROUTE LIST.
//
// IT WAS routeRow, A CLOSURE INSIDE THE SEARCH SCREEN, and every line of the
// markup and every style is unchanged. It became a component because the list
// is about to be drawn in two places -- the search screen's drawer today, a
// native sheet next -- and a closure over one screen's state cannot be drawn by
// the other. Everything it used to read from the screen it reads from
// lib/routeResults now, which both screens are under.
//
// THE ONE THING THAT STAYED OUTSIDE IS THE TAP. What choosing a row DOES --
// select it, and shut the drawer, or whatever the sheet decides -- is the
// caller's business, so it arrives as onPress. The bookmark is not: saving is
// the list's own action wherever the list is drawn.
//
// Flat rows, not cards. Line one carries everything variable-width; line two
// carries the two times and the connector between them, and nothing else may
// join it. The times are sized to their own content and pinned to opposite
// edges of the row, so departures start at the same x and arrivals end at the
// same x while the connector absorbs every point of slack.
// `pinned` only suppresses the in-row "fastest" tag, because the heading
// directly above the pinned row already says the word. Same component, same
// layout, one boolean — there is no second row renderer.
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { airlineFromFlightNumber } from '../lib/airlines';
import { makeFlightId } from '../lib/storage';
import { clock24 } from '../lib/time';
import { getStatusColor, stripZoneLabel, formatCountdown } from '../lib/flightstatus';
import { CARD_FILL, CARD_RADIUS, CARD_GAP, CARD_PAD, SURFACE_EDGE } from '../lib/cards';
import {
  useRouteResults, routeDayOf, ROUTE_STATUS_ROUTINE, ROUTE_NO_TIME,
  type RouteFlight,
} from '../lib/routeResults';

const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

// Ceiling on the DRAWN line only. The connector's box still spans everything
// between the two times; the line is centred inside it, so the gap either side
// is equal by construction at any width.
//
// This replaces a duration-proportional left inset, which was a defect: pushing
// the line right grew the left gap while the right gap stayed fixed, so only the
// single longest flight in a list ever showed equal gaps.
const ROUTE_CONNECTOR_MAX = 120;

type Props = {
  r: RouteFlight;
  pinned?: boolean;
  onPress: (r: RouteFlight) => void;
};

export function RouteRow({ r, pinned = false, onPress }: Props) {
  const {
    savedFlights, routeResult, routeDurationMs, routeRowKey, routeLastKey,
    routeFastestKeys, routeSavingKey, saveFromRoute,
  } = useRouteResults();
  const ms = routeDurationMs(r);
  const origin = routeResult?.origin ?? '';
  // The APPLIED date, never routeDate: that can hold a selection the list has
  // not been re-fetched for, which would open a card for a day the row on
  // screen is not from. Null for an undated board, which is today.
  const rowDate = routeResult?.date ?? null;
  const airline = airlineFromFlightNumber(r.flight_number);
  // Number AND date, so a row shows saved only when THAT instance is saved.
  //
  // The local calendar date a board row DEPARTS on, read from its own ISO.
  // Not the board's date. An undated board is a rolling twelve hours from now,
  // so its late rows belong to tomorrow — and a record saved from one of those
  // is keyed on the date the backend reports, which is the row's own. Matching
  // the indicator on the board's date instead would leave those rows showing
  // unsaved forever.
  const rowDay = routeDayOf(r);
  const saved = savedFlights.some(f => f.id === makeFlightId(r.flight_number, rowDay));
  const pending = routeSavingKey === r.flight_number;
  const busy = routeSavingKey !== null;
  const showStatus = r.status !== ROUTE_STATUS_ROUTINE;
  return (
    <TouchableOpacity
      style={[s.routeFlatRow, routeRowKey(r) === routeLastKey && s.routeFlatRowLast]}
      activeOpacity={0.7}
      // Same reasoning as handleSearch and renderSavedFlight: keyboardShouldPersistTaps
      // lets this tap through with the keyboard still up. What the tap MEANS is
      // the caller's -- see onPress at the top of this file.
      onPress={() => onPress(r)}
    >
      <View style={s.routeFlatRowEdge} pointerEvents="none" />
      <View style={s.routeFlatBody}>
        {/* Identity and flags. Everything variable-width lives on this line so
            the times below keep the whole row to flex into; the airline is the
            only cell allowed to shrink, and may be absent entirely. */}
        <View style={s.routeFlatHead}>
          <View style={s.routeFlatIdent}>
            {airline !== null && (
              <Text style={s.routeFlatAirline} numberOfLines={1}>{airline}</Text>
            )}
            <Text style={s.routeFlatNumber} numberOfLines={1}>{r.flight_number}</Text>
          </View>
          <View style={s.routeFlatTags}>
            {/* No "Direct" label: it printed identically on every row, and the
                note under the heading already says the whole list is direct.
                It earns a place here only once connections can appear. */}
            {!pinned && routeFastestKeys.has(routeRowKey(r)) && (
              <Text style={s.routeFastest}>{'fastest'}</Text>
            )}
            {showStatus && (
              <Text style={[s.routeFlatStatus, { color: getStatusColor(r.status) }]} numberOfLines={1}>
                {r.status}
              </Text>
            )}
          </View>
        </View>

        {/* Both cells are the same fixed width, because every 24-hour time is
            exactly five characters. The connector is the only flexed element
            between them, so the gap either side of it is equal by construction
            rather than by tuning. */}
        <View style={s.routeFlatTop}>
          <Text style={s.routeFlatTime} numberOfLines={1}>
            {clock24(r.departure_scheduled_iso, r.departure_scheduled)}
          </Text>
          <View style={s.routeConn}>
            {ms !== null && (
              <Text style={s.routeConnDur} numberOfLines={1}>{formatCountdown(ms)}</Text>
            )}
            <View style={s.routeConnLineRow}>
              <View style={s.routeConnLine} />
              <View style={s.routeConnHead} />
            </View>
          </View>
          {/* The iso is still preferred; the fallback is the only thing that
              changes. A row with neither value gets the dash, which occupies
              the same 60pt cell a time does, so the arrival still ends on the
              row's right edge and the connector's share is unchanged. */}
          <Text style={[s.routeFlatTime, s.routeFlatTimeEnd]} numberOfLines={1}>
            {clock24(
              r.arrival_scheduled_iso,
              r.arrival_scheduled === null ? ROUTE_NO_TIME : stripZoneLabel(r.arrival_scheduled),
            )}
          </Text>
        </View>

        {/* Its own row, repeating routeFlatTop's geometry exactly, so each code
            sits under its own time. Putting them INSIDE routeFlatTop would have
            grown the box the connector centres itself in, dragging the line
            below the times it belongs to. */}
        <View style={s.routeFlatCodes}>
          <Text style={s.routeFlatCode} numberOfLines={1}>{origin}</Text>
          <View style={s.routeConnSpacer} />
          <Text style={[s.routeFlatCode, s.routeFlatCodeEnd]} numberOfLines={1}>
            {/* Never null in practice — a recovered row carries the code its
                name resolved to — but the wire type allows it, and the answer
                is knowable anyway: every row here is for this destination. */}
            {r.destination_iata ?? routeResult?.destination ?? ''}
          </Text>
        </View>
      </View>

      {/* Nested Touchable: React Native gives the responder to the deepest view
          that claims it, so this never triggers the row's own onPress. */}
      <TouchableOpacity
        style={s.routeFlatMark}
        activeOpacity={0.7}
        disabled={saved || busy}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={() => saveFromRoute(r.flight_number, rowDay ?? rowDate, origin || null)}
      >
        <View style={s.routeFlatMarkBox}>
          {pending ? (
            <ActivityIndicator size="small" color="rgba(226,226,226,0.5)" />
          ) : (
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"
                fill={saved ? '#4ade80' : 'none'}
                stroke={saved
                  ? '#4ade80'
                  : busy ? 'rgba(226,226,226,0.25)' : 'rgba(226,226,226,0.5)'}
                strokeWidth={1.75}
              />
            </Svg>
          )}
        </View>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// THE ROW'S OWN STYLES, EXACTLY AS THEY WERE IN THE SEARCH SCREEN'S SHEET.
const s = StyleSheet.create({
  // Flat rows. Separation is the file's existing hairline, the same one sf.row
  // and ir.row use; the breathing room comes from paddingVertical, not a box.
  // The same card as a saved row, and the same padding, which is what keeps the
  // times in their columns. See CARD_PAD.
  routeFlatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 18,
    paddingHorizontal: CARD_PAD,
    backgroundColor: CARD_FILL,
    borderRadius: CARD_RADIUS,
    marginBottom: CARD_GAP,
  },
  // ── THE HAIRLINE, AS A SIBLING ──
  //
  // g.sheetEdge's PATTERN, not a border on the surface itself, and lib/glass.tsx
  // states why at SHEET_EDGE: React Native draws a border from the layer's own
  // radius as one unbroken rounded rectangle ONLY while all four sides share a
  // colour, and a border on the surface would also inset its content box by 1pt
  // on every side. An absolutely positioned sibling at the same radius costs no
  // layout and cannot split a corner arc.
  //
  // WHY THE SURFACE NEEDED ONE AT ALL: at 4.5% white on a near-black page a fill
  // alone barely registers, which is what made these read as text on the page
  // rather than as cards. One pixel of 10% white is what turns a tint into a
  // shape. See the elevation scale in lib/cards.ts.
  routeFlatRowEdge: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 1, borderColor: SURFACE_EDGE, borderRadius: CARD_RADIUS,
  },
  // See routeLastKey. The hidden-count and truncation notes below the list keep
  // their own spacing, so dropping the gap leaves nothing touching.
  routeFlatRowLast: { marginBottom: 0 },
  routeFlatBody: { flex: 1 },
  routeFlatHead: { flexDirection: "row", alignItems: "center" },
  routeFlatIdent: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  routeFlatAirline: { fontSize: 13, color: "rgba(226,226,226,0.6)", fontFamily: SANS, flexShrink: 1 },
  routeFlatNumber: { fontSize: 13, color: "rgba(226,226,226,0.4)", fontFamily: MONO },
  // Content-width, never reserved: these are flags, and a fixed cell for a
  // status that almost never renders would leave a permanent hole. The identity
  // group flexes, so nothing here can push the row wider than the screen.
  routeFlatTags: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  // No width: the cell that collided with the duration was 62pt against a 63.9pt
  // "scheduled" once letterSpacing was counted. Sized to content, it cannot.
  routeFlatStatus: { fontSize: 11, fontFamily: MONO_BOLD, letterSpacing: 0.5 },
  // No width of any kind. As a stretched child of the column body this spans the
  // full row, so the departure sits on the row's left edge and the arrival on its
  // right edge — the same right edge line one's flags end at. Constraining this
  // width was what left the arrival floating mid-row.
  // marginTop clears the duration, which hangs above the connector line without
  // taking layout height.
  routeFlatTop: { flexDirection: "row", alignItems: "center", marginTop: 14 },
  // minWidth, not width: a five-character 24-hour time fits exactly, so both
  // cells match and the connector is centred. Should a row ever fall back to a
  // backend-formatted string, the cell grows and the connector yields instead of
  // the time truncating.
  routeFlatTime: { fontSize: 20, color: "#ffffff", fontFamily: MONO_BOLD, minWidth: 60 },
  routeFlatTimeEnd: { textAlign: "right" },
  // The box spans everything between the times; alignItems centres the drawn
  // line inside it, so the gap either side is equal at every width.
  routeConn: { flex: 1, justifyContent: "center", alignItems: "center", marginHorizontal: 12 },
  // Absolutely positioned so it labels the line without adding row height or
  // shifting the line off the times' vertical centre.
  // MONO_BOLD at 0.75 rather than MONO at 0.4. It labels the connector it sits
  // on, and at 0.4 it read as a watermark rather than as the block time.
  routeConnDur: {
    position: "absolute", left: 0, right: 0, bottom: 7,
    fontSize: 11, color: "rgba(226,226,226,0.75)", fontFamily: MONO_BOLD, textAlign: "center",
  },
  routeConnLineRow: {
    flexDirection: "row", alignItems: "center",
    width: "100%", maxWidth: ROUTE_CONNECTOR_MAX,
  },
  routeConnLine: { flex: 1, height: 1, backgroundColor: "rgba(226,226,226,0.45)" },
  // Two borders of a square turned 45 degrees: an arrowhead with no SVG.
  routeConnHead: {
    width: 5, height: 5,
    borderTopWidth: 1, borderRightWidth: 1,
    borderColor: "rgba(226,226,226,0.45)",
    transform: [{ rotate: "45deg" }],
    marginLeft: -1,
  },
  // 60pt each end and a flexed middle with the same 12pt margins routeConn
  // carries, so a code lands directly under its own time at every width. The
  // times themselves are untouched: departures still start on the row's left
  // edge and arrivals still end on its right.
  routeFlatCodes: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  routeFlatCode: {
    fontSize: 11, color: "rgba(226,226,226,0.4)", fontFamily: MONO, minWidth: 60,
  },
  routeFlatCodeEnd: { textAlign: "right" },
  routeConnSpacer: { flex: 1, marginHorizontal: 12 },

  // Icon only, no container. hitSlop carries the tap target.
  routeFlatMark: { marginLeft: 14 },
  routeFlatMarkBox: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  // Its own size and family: it sits in the row's flag group, not inside a
  // parent Text it could inherit from.
  routeFastest: { fontSize: 11, color: "#4ade80", fontFamily: MONO },
});
