import { useCallback, useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

// DECLARED HERE RATHER THAN IMPORTED FROM index. Both files name the same four
// faces _layout loads, and a screen reaching into a sibling screen for a string
// constant would couple two routes that are otherwise peers. The values are the
// font family names themselves, so there is nothing to keep in step beyond what
// useFonts already registers.
const MONO = 'JetBrainsMono_400Regular';
const MONO_BOLD = 'JetBrainsMono_700Bold';
const SANS = 'Inter_400Regular';
const SANS_SEMI = 'Inter_600SemiBold';

const PAGE_BG = '#050505';

// index.tsx's own, copied for the same reason the fonts are: this screen owns
// the name input now, so it owns the rule that cleans it. Display-only handle;
// saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

export default function Profile() {
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [editing, setEditing] = useState(false);

  const effectiveName = displayName ?? username;
  // The first-run ask, on the same condition index.tsx used to open the modal on.
  const askName = username !== null && displayName === null;
  // The ask forces the input open; otherwise the pencil does.
  const showInput = askName || editing;

  // index.tsx's hydration, minus the pieces that belong to the home screen —
  // gmailToken is not read here because nothing on this screen uses it, and
  // savedCollapsed is home's. No shared context: this screen reads storage
  // itself, which is what keeps it a peer of home rather than a child of it.
  const readAuth = useCallback(() => {
    if (Platform.OS === 'web') {
      const u = localStorage.getItem('username');
      const e = localStorage.getItem('email');
      const dn = localStorage.getItem('displayName');
      setUsername(u);
      setEmail(e);
      setDisplayName(dn);
      setNameDraft(dn ?? u ?? '');
    } else {
      Promise.all([
        SecureStore.getItemAsync('username'),
        SecureStore.getItemAsync('email'),
        SecureStore.getItemAsync('displayName'),
      ]).then(([u, e, dn]) => {
        setUsername(u);
        setEmail(e);
        setDisplayName(dn);
        setNameDraft(dn ?? u ?? '');
      });
    }
  }, []);

  // index.tsx's persistDisplayName, same two branches and same order: write,
  // then set state.
  const persistDisplayName = useCallback(async (name: string) => {
    if (Platform.OS === 'web') localStorage.setItem('displayName', name);
    else await SecureStore.setItemAsync('displayName', name);
    setDisplayName(name);
  }, []);

  // WHAT THE CLEANUP NEEDS, held in a ref because it cannot read state.
  // useFocusEffect's callback is memoised on [] so the effect does not re-run
  // on every keystroke, which means its cleanup closes over the FIRST render's
  // values. This is written on every render, so the cleanup reads the last ones.
  const skipRef = useRef<{ askName: boolean; username: string | null }>({ askName: false, username: null });
  skipRef.current = { askName, username };

  // ON BLUR, NOT ON UNMOUNT, and the navigator is why. The tab screens do not
  // unmount when they lose focus: @react-navigation/bottom-tabs 7 has no
  // unmountOnBlur option at all, and `lazy` only defers the FIRST render. So an
  // unmount-based commit would never fire on a tab switch — it would wait for
  // the whole navigator to tear down, by which point the app is closing. The
  // cleanup of a focus effect fires exactly when the user leaves the screen,
  // which is what "leaving without picking a name" means.
  //
  // This is the old onSkipName: the ask fills displayName with username so it
  // is only ever asked once. It cannot fire after a real save, because saving
  // sets displayName and askName goes false before the blur.
  useFocusEffect(
    useCallback(() => {
      readAuth();
      return () => {
        const { askName: stillAsking, username: u } = skipRef.current;
        if (stillAsking && u !== null) void persistDisplayName(u);
      };
    }, [readAuth, persistDisplayName]),
  );

  const commitName = () => {
    const cleaned = sanitiseDisplayName(nameDraft);
    if (!cleaned) return;            // empty after sanitising: keep the old value and stay open
    setEditing(false);
    void persistDisplayName(cleaned);
  };

  // index.tsx's onLogout, unchanged apart from the navigation at the end. The
  // web branch has no gmailToken to clear because the web sign-in never stores
  // one — that asymmetry is index.tsx's and is preserved rather than tidied.
  const logout = async () => {
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
    setEmail(null);
    router.navigate('/');
  };

  return (
    <View style={st.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[st.fill, { paddingTop: insets.top + 12 }]}
      >
        {/* THE BODY TAKES THE SLACK. It used to do that in order to pin a
            footer against the bottom; with the footer gone it is simply what
            gives the KeyboardAvoidingView something to shrink, and it keeps
            the content top-aligned rather than centred in the leftover space.
            NOTHING RESERVES BOTTOM CLEARANCE ANY MORE, which is correct while
            this screen ends at the log out row: the content stops well short
            of the floating bar. Anything added below it would run under the
            glass, as home's list deliberately does. */}
        <View style={st.body}>
          <View style={st.header}>
            <Text style={st.brand}>{'>_'}</Text>
          </View>

          {showInput ? (
            <>
              <Text style={st.nameLabel}>{askName ? 'pick a name' : 'username'}</Text>
              <View style={st.nameRow}>
                <TextInput
                  style={st.nameInput}
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
                <TouchableOpacity style={st.nameBtn} activeOpacity={0.75} onPress={commitName}>
                  <Text style={st.nameBtnTxt}>{'save'}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={st.nameLine}>
              <Text style={st.name}>{effectiveName ?? 'Guest User'}</Text>
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={() => setEditing(true)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={st.pencil}>{'✎'}</Text>
              </TouchableOpacity>
            </View>
          )}

          <Text style={st.sub}>{email ? `signed in as ${email}` : 'signed in'}</Text>

          {/* A SIBLING VIEW, not a border: a hairline is a thing on the page
              here, not an edge belonging to either neighbour. */}
          <View style={st.rule} />

          <TouchableOpacity activeOpacity={0.75} onPress={logout} style={st.logoutRow}>
            <Text style={st.logout}>{'log out'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: PAGE_BG },
  fill: { flex: 1 },
  // The page margin is index.tsx's s.scroll: 20 either side, so the brand mark
  // sits in the same column on both screens.
  body: { flex: 1, paddingHorizontal: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 36,
  },
  brand: { fontFamily: MONO_BOLD, color: '#4ade80', fontSize: 15 },

  // 20pt Inter, matching home's greeting rather than the modal's 20pt mono:
  // this is the same fact in the same weight, one screen over.
  name: { fontFamily: SANS_SEMI, fontSize: 20, color: '#e2e2e2' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  pencil: { fontFamily: SANS, fontSize: 13, color: 'rgba(226,226,226,0.4)' },

  // The modal's four, unchanged: the input, its label, the save button and the
  // row holding them. alignSelf is gone from the label because this screen is
  // left-aligned throughout and there is no centring left to opt out of.
  nameLabel: {
    fontFamily: SANS,
    fontSize: 11,
    color: 'rgba(226,226,226,0.4)',
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

  // The modal's sub, minus its centring and its 32pt bottom margin: the rule
  // below now does that spacing.
  sub: { fontFamily: MONO, fontSize: 13, color: 'rgba(226,226,226,0.4)' },
  rule: { height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginTop: 24, marginBottom: 20 },

  logoutRow: { alignSelf: 'flex-start', paddingVertical: 8 },
  logout: { fontFamily: SANS, fontSize: 13, color: 'rgba(248,113,113,0.7)' },

});
