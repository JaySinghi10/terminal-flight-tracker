// THE SESSION, AND NOTHING ELSE.
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
// DELIBERATELY NOT `username`, `displayName` OR `profileOpen`. Nothing is broken
// about those: they are written on home and read on home, and moving them here
// on the argument that something might want them one day is guessing. `email`
// is not here either -- lib/saved.tsx owns that, because the saved list is
// keyed on it, and the session changes nothing about that key.
//
// THE OLD TOKEN. Builds before the session stored a raw Google access token
// under 'gmailToken'. It expired within the hour anyway; at launch this file
// deletes it, so a phone updated from that build is simply signed in with no
// session, and the pull row offers to reconnect. Nothing else is migrated,
// because nothing else changed.
import {
  createContext, useContext, useState, useEffect, useCallback, useMemo,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'session';
const LEGACY_TOKEN_KEY = 'gmailToken';

type AccountContextValue = {
  session: string | null;
  // Sets the session and puts it on disk, or clears both. One function rather
  // than a setter and a writer, so a caller cannot do half of it.
  persistSession: (session: string | null) => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const v = useContext(AccountContext);
  if (v === null) throw new Error('useAccount must be used inside an AccountProvider');
  return v;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<string | null>(null);

  // ITS OWN EFFECT, and nothing waits on it: authHydrated gates the collapse
  // state and the first-run ask, and neither reads the session.
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

  // Write, then set, the shape persistDisplayName has on the home screen.
  const persistSession = useCallback(async (next: string | null) => {
    if (Platform.OS !== 'web') {
      if (next === null) await SecureStore.deleteItemAsync(SESSION_KEY);
      else await SecureStore.setItemAsync(SESSION_KEY, next);
    }
    setSession(next);
  }, []);

  const value = useMemo(
    () => ({ session, persistSession }),
    [session, persistSession],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
    </AccountContext.Provider>
  );
}
