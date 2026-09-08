// THE SESSION, AND THE TWO NAMES.
//
// WHAT THE SESSION IS. An opaque token our server handed back when the Google
// sign-in completed. The phone never holds a Google token any more: the
// sign-in is the authorization code flow with PKCE, the code goes to our
// server, the server exchanges it and keeps the refresh token, and this is
// what it gives the phone in return. A Gmail pull and a chat send it as a
// Bearer header, and the server turns it into a Google access token on its
// side. See auth.py on the server for the whole design.
//
// It lives here because the /chat request sends it and that request is on the
// search screen, while everything that produces it -- the sign-in and the
// logout -- is in the profile modal on home. One screen writes it, another
// reads it, and neither can see the other's state.
//
// THE NAMES ARRIVED HERE ON THE DAY THIS FILE PREDICTED. The note that used to
// stand here said, deliberately, NOT `username`, NOT `displayName`: both were
// written on home and read on home, and moving them here on the argument that
// something might want them one day was guessing. It added that if one of them
// ever had to cross a screen, that would be a smaller job then than now. Stage
// 9 of the native conversion is that day. The search field's placeholder is a
// shell prompt carrying the person's name, the same name home greets with, and
// a name typed into the profile sheet has to reach that prompt in the same
// render it reaches the greeting. Home's local state could not be subscribed
// to from another screen; a read of secure storage on the account-change
// signal was stale for exactly the case that mattered. So the two names moved
// here, with their persist functions, and home reads and writes them through
// this context exactly as it did through its own state. `profileOpen` did NOT
// move: nothing off home reads it, and the argument for leaving it stands.
//
// `email` IS STILL NOT HERE. lib/saved.tsx owns that, because the saved list
// is keyed on it, and the session and the names change nothing about that key.
//
// THE OLD TOKEN. Builds before the session stored a raw Google access token
// under 'gmailToken'. It expired within the hour anyway; at launch this file
// deletes it, so a phone updated from that build is simply signed in with no
// session, and the pull row offers to reconnect.
import {
  createContext, useContext, useState, useEffect, useCallback, useMemo,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'session';
const LEGACY_TOKEN_KEY = 'gmailToken';
// THE SAME KEYS HOME ALWAYS WROTE. Nothing about the storage changed when the
// state moved; a phone updated across this change reads its own name back.
const USERNAME_KEY = 'username';
const DISPLAY_NAME_KEY = 'displayName';

type AccountContextValue = {
  session: string | null;
  // Sets the session and puts it on disk, or clears both. One function rather
  // than a setter and a writer, so a caller cannot do half of it.
  persistSession: (session: string | null) => Promise<void>;
  // THE FIRST NAME GOOGLE GAVE AT SIGN-IN, and the name the person typed in
  // the profile sheet. Home greets with `displayName ?? username`; the search
  // prompt says the same. Each persist writes the store and sets the state
  // together, null meaning delete, so the two can never disagree -- which is
  // the property home's own pair of setters had, kept.
  username: string | null;
  displayName: string | null;
  persistUsername: (name: string | null) => Promise<void>;
  persistDisplayName: (name: string | null) => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const v = useContext(AccountContext);
  if (v === null) throw new Error('useAccount must be used inside an AccountProvider');
  return v;
}

// ONE PLACE THAT KNOWS WHERE A NAME IS KEPT ON EACH PLATFORM. Home carried the
// web/native split at every read and write; it is carried once here.
async function readName(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function writeName(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);

  // ITS OWN EFFECT, and nothing waits on it: authHydrated on home gates the
  // collapse state and the first-run ask, and neither reads the session.
  //
  // The web guard is home's own: SecureStore is native-only, and the web
  // sign-in path never produces a session.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    SecureStore.getItemAsync(SESSION_KEY).then(s => {
      if (s) setSession(s);
    });
    // The pre-session token, if this phone still has one. Gone, unread.
    void SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY).catch(() => {});
  }, []);

  // THE TWO NAMES, READ TOGETHER AND SET TOGETHER. Home's first-run ask opens
  // when a username exists and no display name does. If the two arrived in
  // separate renders, a phone that HAS a display name would see one render
  // with the username alone and open the sheet for nothing. One Promise.all
  // and two sets in the same tick is what stops that, exactly as home's own
  // hydration did it.
  useEffect(() => {
    Promise.all([readName(USERNAME_KEY), readName(DISPLAY_NAME_KEY)]).then(([u, dn]) => {
      if (u) setUsername(u);
      if (dn) setDisplayName(dn);
    }).catch(() => {});
  }, []);

  // Write, then set, the shape persistDisplayName had on the home screen.
  const persistSession = useCallback(async (next: string | null) => {
    if (Platform.OS !== 'web') {
      if (next === null) await SecureStore.deleteItemAsync(SESSION_KEY);
      else await SecureStore.setItemAsync(SESSION_KEY, next);
    }
    setSession(next);
  }, []);

  const persistUsername = useCallback(async (name: string | null) => {
    await writeName(USERNAME_KEY, name);
    setUsername(name);
  }, []);

  const persistDisplayName = useCallback(async (name: string | null) => {
    await writeName(DISPLAY_NAME_KEY, name);
    setDisplayName(name);
  }, []);

  const value = useMemo(
    () => ({ session, persistSession, username, displayName, persistUsername, persistDisplayName }),
    [session, persistSession, username, displayName, persistUsername, persistDisplayName],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
    </AccountContext.Provider>
  );
}
