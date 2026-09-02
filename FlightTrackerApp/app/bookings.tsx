import { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// HOME'S HEADER LINE. Imported rather than restated, and from lib rather than
// from a screen -- see the note where it lives.
import { formatClock } from '../lib/flightstatus';

// Declared here rather than imported, as profile.tsx does: a screen reaching
// into a sibling screen for a string constant would couple two routes that are
// peers. These are the family names _layout registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
// The semibold face, loaded in _layout with the rest. The title alone uses it.
const SANS_SEMI = 'Inter_600SemiBold';

const PAGE_BG = '#050505';

// THE HEADER IS REAL. THE BODY IS STILL A PLACEHOLDER.
//
// The mark, the title and the clock under it are home's own header, and they are
// meant to stay: every screen in this app wears it, and the whole point of
// putting it here was that the four read as one app rather than as one designed
// screen beside three drafts. Build on it.
//
// EVERYTHING BELOW THE CLOCK IS A STUB. The tab bar needs a route to navigate to
// and "nothing here yet" is the smallest thing that can be one. Whatever
// Bookings turns out to be -- PNRs, tickets, seats, fares -- replaces that line
// and nothing above it.
export default function Bookings() {
  const insets = useSafeAreaInsets();
  // THE MINUTE TICK, IN THE SHAPE app/flights.tsx AND lib/flightcard.tsx BOTH
  // USE. It exists for one line -- the clock under the title -- and it is not on
  // any context, for the reason stated at the top of lib/saved.tsx: a value that
  // changes every sixty seconds, read through a context, is a re-render of every
  // screen in the app for the benefit of one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick(); // run immediately on mount, not only on the first 60s tick
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      <Text style={st.brand}>{'>_'}</Text>
      <Text style={st.title}>{'Bookings'}</Text>
      <Text style={st.clock}>{formatClock(now)}</Text>
      <Text style={st.empty}>{'nothing here yet'}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  // The page margin is index.tsx's s.scroll and profile.tsx's body: 20 either
  // side, so the brand mark sits in the same column on every screen.
  root: { flex: 1, backgroundColor: PAGE_BG, paddingHorizontal: 20 },
  brand: { fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 },
  // HOME'S GREETING, EXACTLY: SANS_SEMI at 24, 10 under the >_ mark. Not MONO,
  // and that is deliberate -- these are words spoken to a person, the same as
  // the greeting on home, and the app should read as one app. See the same note
  // in app/flights.tsx.
  title: { fontFamily: SANS_SEMI, fontSize: 24, color: '#e2e2e2', marginTop: 10 },
  // index.tsx's clock line, character for character.
  clock: { fontFamily: MONO, fontSize: 15, color: 'rgba(226,226,226,0.4)', marginTop: 3 },
  empty: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)', marginTop: 10 },
});
