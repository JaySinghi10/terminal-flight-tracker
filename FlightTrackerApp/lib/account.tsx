// THE GMAIL TOKEN, AND NOTHING ELSE.
//
// It moved because the /chat request sends it and that request is on the search
// screen now, while everything that produces the token — the Google sign-in and
// the logout — is in the profile modal on home. One screen writes it, another
// reads it, and neither can see the other's state.
//
// DELIBERATELY NOT `username`, `displayName` OR `profileOpen`. Nothing is broken
// about those: they are written on home and read on home, and moving them here
// on the argument that something might want them one day is guessing. If one of
// them ever has to cross a screen, that is a smaller job then than it is now.
//
// SO THIS FILE IS ONE VALUE. It holds the token, reads it back at launch, and
// writes it through on the two occasions it changes. `email` is not here either
// — lib/saved.tsx owns that, because the saved list is keyed on it.
import {
  createContext, useContext, useState, useEffect, useCallback, useMemo,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

type AccountContextValue = {
  gmailToken: string | null;
  // Sets the token and puts it on disk, or clears both. One function rather than
  // a setter and a writer, so a caller cannot do half of it.
  persistGmailToken: (token: string | null) => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
  const v = useContext(AccountContext);
  if (v === null) throw new Error('useAccount must be used inside an AccountProvider');
  return v;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [gmailToken, setGmailToken] = useState<string | null>(null);

  // ITS OWN EFFECT NOW, where it was one member of home's four-way Promise.all.
  // Nothing waited on it: authHydrated gates the collapse state and the first-run
  // ask, and neither reads the token, so taking it out of that batch changes when
  // the flag is set by one storage read and changes nothing that reads the flag.
  //
  // The web guard is home's own: SecureStore is native-only, and the web sign-in
  // path never produced a token to store.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    SecureStore.getItemAsync('gmailToken').then(t => {
      if (t) setGmailToken(t);
    });
  }, []);

  // THE SHAPE persistDisplayName ALREADY HAS on the home screen: write, then set.
  //
  // ONE GUARD RATHER THAN TWO DIFFERENT ONES, and it is the only edit the move
  // forced. index.tsx wrote the token on sign-in with no Platform test and
  // deleted it on logout inside one, which was an asymmetry rather than a
  // decision: the unguarded write sits in the expo-auth-session path, and that
  // path is native-only because the web sign-in button calls Google's own script
  // instead. So the write could never reach a browser, and guarding it changes
  // nothing that can happen while keeping the clear exactly as guarded as it was.
  const persistGmailToken = useCallback(async (token: string | null) => {
    if (Platform.OS !== 'web') {
      if (token === null) await SecureStore.deleteItemAsync('gmailToken');
      else await SecureStore.setItemAsync('gmailToken', token);
    }
    setGmailToken(token);
  }, []);

  const value = useMemo(
    () => ({ gmailToken, persistGmailToken }),
    [gmailToken, persistGmailToken],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
    </AccountContext.Provider>
  );
}
