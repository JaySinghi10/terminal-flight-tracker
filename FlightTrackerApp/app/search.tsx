import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Declared here rather than imported, as profile.tsx does: a screen reaching
// into a sibling screen for a string constant would couple two routes that are
// peers. These are the family names _layout registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';

const PAGE_BG = '#050505';

// A PLACEHOLDER, and deliberately nothing more. The tab bar needs a route to
// navigate to; this is the smallest thing that can be one. The real screen
// replaces this file wholesale, so there is nothing here worth building on.
export default function Search() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.root, { paddingTop: insets.top + 12 }]}>
      <Text style={st.brand}>{'>_'}</Text>
      <Text style={st.title}>{'Search'}</Text>
      <Text style={st.empty}>{'nothing here yet'}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  // The page margin is index.tsx's s.scroll and profile.tsx's body: 20 either
  // side, so the brand mark sits in the same column on every screen.
  root: { flex: 1, backgroundColor: PAGE_BG, paddingHorizontal: 20 },
  brand: { fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 },
  title: { fontFamily: MONO, fontSize: 20, color: '#e2e2e2', marginTop: 36 },
  empty: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)', marginTop: 10 },
});
