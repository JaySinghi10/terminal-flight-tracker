// ── THE PROFILE, AS A SHEET THE SYSTEM DRAWS ────────────────────────────────
//
// A ROUTE, NOT A MODAL COMPONENT. The root Stack presents this over the tabs
// as a form sheet stopped at a single detent: it comes up to 0.92 of the screen
// and leaves the tabs visible above it, which is where Apple's account sheets
// stop. The slide, the corner radius, the dimming, the swipe down to dismiss
// and the header are all UIKit's, and none of them is drawn here. See
// PROFILE_DETENT in app/_layout.tsx.
//
// THE HEADER IS THE NATIVE ONE: the title on the left, declared with the
// presentation because iOS will not move a centred title; and a circular close
// button on the right, declared here through Stack.Toolbar because only the
// route can dismiss itself.
//
// THE LIST IS SWIFTUI. @expo/ui's Form is a real inset-grouped list with real
// cells: the switch is a UISwitch, the rows press the way Settings rows press,
// and the type is the system's, Dynamic Type included. The shape is Settings
// > Apple Account's -- a header card, grouped sections of PLAIN TEXT ROWS, and
// a lone red row last. NO ICON TILES: a coloured square beside every line is a
// thing this app invented rather than inherited. The only symbols on the sheet
// are the avatar and the disclosure chevron on the two rows that leave it.
//
// WHAT THIS SHEET OWNS. The name, the notification permission, the Gmail
// state, the two legal pages, the version line and sign-out. Sign-in is
// lib/googleAuth.tsx's and is started from the Account section; Home resets
// its own state through useAccountChange when the account changes under it.
//
// iOS ONLY, and so is everything on it: every component below is a SwiftUI
// view, and Alert.prompt and ActionSheetIOS are the iOS ones. The app is an
// iPhone app; the bottom sheet this replaced was the one surface that still
// rendered on web, and this does not.
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { ActionSheetIOS, Alert, AppState, Linking, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import {
  Host, Form, Section, Toggle, Button, Text, LabeledContent, Image,
  HStack, Spacer,
} from '@expo/ui/swift-ui';
import {
  tint, foregroundStyle, foregroundColor, font, disabled, buttonStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useAccount } from '../lib/account';
import { useSaved, API_BASE } from '../lib/saved';
import { useGoogleSignIn } from '../lib/googleAuth';
// THE PERMISSION REQUEST, FROM reminders RATHER THAN watch. ensurePushToken is
// guarded by a once-per-install flag and would return without a dialog; this
// has no such guard. See the switch.
import { ensurePermission } from '../lib/reminders';
// AND THE BACKFILL. Granting permission for the first time is the one moment
// every flight already on the device can be given the token it was saved
// without, and backfillWatches is idempotent per token so calling it here
// cannot double anything the launch effect already did.
import { backfillWatches } from '../lib/watch';
import { GREEN } from '../lib/cards';
// The swipe threshold's haptic, on the switch: one medium impact, the same one
// the rest of the app answers a threshold with.
import { EXPAND_HAPTIC } from '../components/swipe';

// ── WHAT THE SHEET SAYS ABOUT NOTIFICATIONS ─────────────────────────────────
//
// THREE STATES, AND THE MIDDLE ONE IS THE REASON THIS EXISTS. Granted is
// self-explanatory. NOT ASKED is a person who has saved flights and has never
// seen the prompt -- until now there was no way to reach them, because the one
// prompt an install gets belongs to a save and is spent silently. DENIED is a
// person the app can never ask again: iOS resolves a second request with no
// dialog at all, so the only honest offer is the Settings app.
type PushState = 'granted' | 'denied' | 'unasked';

async function readPushState(): Promise<PushState> {
  try {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) return 'granted';
    // canAskAgain FALSE IS A REFUSAL THE SYSTEM IS ENFORCING. Undetermined --
    // never asked -- is the only case where a switch can still put a dialog up.
    return p.canAskAgain ? 'unasked' : 'denied';
  } catch {
    // A permission that cannot be read is reported as denied, which offers
    // Settings: the one action that works whatever the real state turns out
    // to be. Claiming 'unasked' would offer a switch that silently does
    // nothing.
    return 'denied';
  }
}

// THE PAGES THE PRIVACY POLICY AND TERMS ACTUALLY LIVE AT. The site is a Vercel
// project with no custom domain -- `vercel domains ls` reports none -- and of
// its two aliases only this one is public; the other sits behind a Vercel login
// wall. Verified serving the current text rather than assumed.
const PRIVACY_URL = 'https://terminal-website-topaz.vercel.app/privacy';
const TERMS_URL = 'https://terminal-website-topaz.vercel.app/terms';

// ── THE VERSION LINE ────────────────────────────────────────────────────────
//
// app.json CARRIES ios.buildNumber NOW, so a build prints it. A development
// client has no native build number of its own, so nativeBuildVersion is
// undefined there and this reads "build dev" -- the honest answer rather than
// a number invented here.
//
// nativeApplicationVersion FIRST, because in a real build it is what the store
// shows; expoConfig.version is the manifest's own value and is what a
// development client has instead.
const APP_VERSION =
  Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '1.0.0';
const APP_BUILD = Constants.nativeBuildVersion ?? 'dev';

// ── THE ONLY COLOUR THIS SHEET SPELLS OUT ───────────────────────────────────
//
// EVERYTHING ELSE IS THE SYSTEM'S. Section titles, footers, the value beside a
// label and the avatar are all SwiftUI's own label colours, which is most of
// what makes a list look native; this is the label colour a Button would
// otherwise override with the accent. GREEN is imported rather than repeated
// and reaches three places in the whole file: the switch's tint, and the text
// of the two legal links.
const WHITE = '#ffffff';
// THE CLOSE BUTTON'S FILL, which is UIKit's own systemFill rather than a grey
// picked by eye: the translucent grey Apple fills a close button with, dark
// enough to read on this sheet and light enough for a white glyph.
const CLOSE_FILL = 'rgba(118,118,128,0.32)';

// Display-only handle. Saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

// ── WHY NO ROW IS A COMPONENT ───────────────────────────────────────────────
//
// THERE IS ALMOST NOTHING LEFT TO FACTOR OUT. A row was a tile, a label, a
// spacer and a chevron, which earned a component; without the tiles most rows
// are one Text, and a component that wraps one Text hides the one thing each
// row actually says. The two rows that NAVIGATE keep their chevron, and the
// disclosure indicator alone is the one piece still worth a name.
//
// EVERY LABEL NAMES ITS OWN COLOUR, and that is not decoration. A SwiftUI
// Button renders its label in the accent colour, and every row here is a
// Button -- so a label that says nothing renders green, which is what made the
// whole list green. buttonStyle('plain') stops the press from tinting it too.

// UIKit'S DISCLOSURE INDICATOR, on the rows that leave the sheet and on no
// others. A chevron is a promise that pressing goes somewhere, so the switch,
// the name and Log out -- which all act in place -- get none. The size, the
// weight and the tertiary tone are the system's own.
function Chevron() {
  return (
    <Image
      systemName="chevron.right"
      modifiers={[
        font({ size: 14, weight: 'semibold' }),
        foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
      ]}
    />
  );
}

// THE HEADER CARD, AND IT IS ONE ROW RATHER THAN A BLOCK. The placeholder
// avatar on the left and the name beside it, and nothing else -- the email was
// under it and is gone, because the card is who you are and the address is a
// detail the Gmail section already states.
//
// 44pt, AND NO PADDING OF ITS OWN. A 58pt avatar with six points added above
// and below made this nearly three standard rows tall for a name and a circle,
// which read as a banner the list had to get past rather than as its first row.
// 44 is the row height iOS builds lists out of, and the cell's own insets are
// the only vertical space here now -- so this sits level with every row under
// it instead of towering over them.
//
// AND THE NAME IS headline, NOT title2. At 22pt the name set the row's height
// rather than the avatar did, which made this a heading with a list under it;
// headline is the style iOS sets a row's PRIMARY LABEL in, so the name now sits
// at the size every other row on the sheet uses, one weight up from them.
//
// The Spacer makes the whole row the tap target when a Button wraps it.
function Card({ name }: { name: string }) {
  return (
    <HStack spacing={12}>
      <Image
        systemName="person.crop.circle.fill"
        modifiers={[font({ size: 44 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}
      />
      <Text modifiers={[font({ textStyle: 'headline' }), foregroundColor(WHITE)]}>{name}</Text>
      <Spacer />
    </HStack>
  );
}

export default function Profile() {
  const router = useRouter();
  const {
    session, persistSession, username, displayName, persistUsername, persistDisplayName,
  } = useAccount();
  // THE SAVED LIST, FOR THE BACKFILL; the email, for the card and for logout.
  const { email, setEmail, savedFlights } = useSaved();
  const { signIn } = useGoogleSignIn();
  const effectiveName = displayName ?? username;
  // The first-run ask: signed in, no display name yet. Skipping fills it with
  // the username, so it asks once.
  const askName = username !== null && displayName === null;

  // ── THE PERMISSION, RE-READ RATHER THAN REMEMBERED ────────────────────────
  //
  // IT CHANGES OUTSIDE THIS APP. Somebody sent to Settings turns notifications
  // on there and comes back, and a value read once when the sheet mounted would
  // still say "off". So it is read when the sheet MOUNTS and again whenever the
  // app returns to the foreground -- which is exactly the round trip the
  // switch starts when it opens Settings.
  const [push, setPush] = useState<PushState | null>(null);
  // THE SWITCH'S OWN POSITION WHILE A REQUEST IS UP. The Toggle is controlled
  // and sits where isOn says, so while the system dialog is open this says
  // "on" -- the flip is seen -- and the read afterwards decides where it
  // settles.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  useEffect(() => {
    let gone = false;
    const read = () => { void readPushState().then(s => { if (!gone) setPush(s); }); };
    read();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') read(); });
    return () => { gone = true; sub.remove(); };
  }, []);

  const onToggle = async (isOn: boolean) => {
    EXPAND_HAPTIC();
    if (push === 'unasked' && isOn) {
      setOptimistic(true);
      // ensurePermission, NOT ensurePushToken. The latter is guarded by a
      // once-per-install flag -- see watch.ts -- and would return without
      // ever showing a dialog.
      const ok = await ensurePermission();
      setPush(await readPushState());
      setOptimistic(null);
      // AND EVERY FLIGHT ALREADY ON THE DEVICE GETS THE TOKEN. A flight saved
      // before this moment was registered with a null token and nothing
      // revisits a row; this is the one moment that can be put right.
      if (ok) void backfillWatches(API_BASE, savedFlights);
      return;
    }
    // DENIED, OR GRANTED AND FLIPPED OFF: neither changes from inside the app.
    // iOS answers a second request with no dialog, and nothing revokes a grant
    // but the person, in Settings. So Settings is the one honest offer; the
    // switch stays where the permission is, and the foreground read above
    // catches up when they come back.
    void Linking.openSettings();
  };

  // ── THE NAME, THROUGH THE SYSTEM'S TEXT ALERT ─────────────────────────────
  //
  // Alert.prompt is UIAlertController with a text field, and React Native
  // presents it in an alert window of its own, above everything -- a sheet
  // still sliding in included, which is why the first-run ask below can fire
  // the moment this mounts.
  const editName = () => {
    Alert.prompt(
      'Your name',
      'Home greets you by it. Letters, numbers, - and _ only, up to 14.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          // On the first-run ask, cancelling is skipping: the username fills
          // in, so it is not asked again. On an ordinary edit it is nothing.
          onPress: () => { if (askName && username !== null) void persistDisplayName(username); },
        },
        {
          text: 'Save',
          onPress: (value?: string) => {
            const cleaned = sanitiseDisplayName(value ?? '');
            if (cleaned) { void persistDisplayName(cleaned); return; }
            // Empty after sanitising: the old value stands, and on the
            // first-run ask the old value is the username.
            if (askName && username !== null) void persistDisplayName(username);
          },
        },
      ],
      'plain-text',
      effectiveName ?? '',
    );
  };

  // THE FIRST-RUN ASK, once per username. A sheet Home opened for this purpose
  // asks here; so does one that was already open when the sign-in happened
  // from its own row. The ref is what makes "once" true across re-renders.
  const ask = useEffectEvent(() => { editName(); });
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!askName) return;
    if (askedFor.current === username) return;
    askedFor.current = username;
    ask();
  }, [askName, username]);

  // ── SIGN-OUT, CONFIRMED BY THE SYSTEM'S ACTION SHEET ──────────────────────
  const logout = async () => {
    // THE SAME THREE DELETIONS IN THE SAME ORDER: username, email,
    // displayName. The two persists clear the store and the state together;
    // email is the saved store's to delete, and setEmail below is still the
    // signal, fired after every store is clear.
    await persistUsername(null);
    if (Platform.OS === 'web') localStorage.removeItem('email');
    else await SecureStore.deleteItemAsync('email');
    await persistDisplayName(null);
    // THE SERVER FIRST. Sign-out deletes the account's record, every session
    // and the refresh token there, and revokes the grant at Google, so
    // "disconnect" is true from Google's side too. Best effort: a phone with
    // no signal still signs out locally, and the server's record dies with
    // its next refresh or on the next sign-in.
    if (session !== null && !session.startsWith('fixture:')) {
      try {
        await fetch(`${API_BASE}/auth/signout`, {
          method: 'POST',
          // An explicit empty body: Google's front end answers 411 to a POST
          // that carries no Content-Length at all.
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
          body: '{}',
        });
      } catch {
        // See above.
      }
    }
    await persistSession(null);
    // THE SIGNAL. Home resets its Gmail pull and closes an open card on it;
    // the search screen clears its query. See useAccountChange.
    setEmail(null);
    router.back();
  };

  const confirmLogout = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: email ?? undefined,
        options: ['Log out', 'Cancel'],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      index => { if (index === 0) void logout(); },
    );
  };

  // The footer under the switch says what the switch cannot: what the alerts
  // are, and -- when the system will not show a dialog -- where the control
  // actually is. Nothing while the read is in flight.
  const pushFooter =
    push === 'granted' ? 'Gate changes, delays and arrivals for your saved flights.'
    : push === 'unasked' ? 'iOS asks once. Gate changes, delays and arrivals for your saved flights.'
    : push === 'denied' ? 'Turned off in Settings. Flip the switch to open Settings.'
    : null;

  return (
    <>
      {/* ── THE CLOSE BUTTON ──────────────────────────────────────────
          A CIRCLE WITH AN X, NOT A WORD. It is what Apple's account sheets
          put in this corner, and it says "close" without claiming anything
          was confirmed -- which "Done" did, over a sheet where every control
          has already taken effect by the time it is pressed.

          variant 'prominent' IS WHAT MAKES IT ROUND. From iOS 26 a prominent
          bar button item draws a filled background behind its glyph, which
          for an icon with no label is a circle; tintColor is that fill, and
          UIKit picks the contrasting glyph. An icon-only item is converted
          with an empty label and is never dropped, so accessibilityLabel is
          what actually names it.

          The header, the title and their colours are declared where the
          sheet is: app/_layout.tsx. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          variant="prominent"
          icon="xmark"
          tintColor={CLOSE_FILL}
          accessibilityLabel="Close"
          onPress={() => router.back()}
        />
      </Stack.Toolbar>

      {/* THE HOST fills the sheet and proposes the viewport to SwiftUI, which
          is what a Form needs to scroll rather than size to its content.

          NO seedColor. It set the environment tint for everything below, so
          every Button's label came out green; the two things that are meant
          to be green name it themselves. */}
      <Host style={{ flex: 1 }} useViewportSizeMeasurement>
        <Form>
          {/* ── ACCOUNT ── The card is the name row: tapping it edits the name
              through the system alert. Signed out, it is a plain card with a
              sign-in row under it. */}
          <Section>
            {username !== null ? (
              <Button onPress={editName} modifiers={[buttonStyle('plain')]}>
                <Card name={effectiveName ?? 'Guest User'} />
              </Button>
            ) : (
              <Card name="Guest User" />
            )}
            {username === null && (
              <Button onPress={signIn} modifiers={[buttonStyle('plain')]}>
                <Text modifiers={[foregroundColor(WHITE)]}>Sign in with Google</Text>
              </Button>
            )}
          </Section>

          {/* ── NOTIFICATIONS ── One switch, controlled: on when the permission
              is granted, and every flip is answered by the permission rather
              than by the switch. Disabled until the first read lands rather
              than flashing "off" at somebody who has it on. */}
          <Section title="Notifications" footer={pushFooter !== null ? <Text>{pushFooter}</Text> : undefined}>
            <Toggle
              isOn={optimistic ?? push === 'granted'}
              onIsOnChange={onToggle}
              modifiers={[tint(GREEN), disabled(push === null)]}
            >
              <Text modifiers={[foregroundColor(WHITE)]}>Notifications</Text>
            </Toggle>
          </Section>

          {/* ── GMAIL ── A session is a Gmail grant; no session on a signed-in
              account is a phone updated from the build that held a raw Google
              token, and the row offers the sign-in that mints one. */}
          {username !== null && (
            <Section
              title="Gmail"
              footer={<Text>{session !== null
                ? (email !== null ? `Connected as ${email}.` : 'Connected.')
                : 'Sign in again to pull your bookings.'}</Text>}
            >
              {/* A LABEL AND A VALUE, which is the one row here that is not a
                  Button -- so both take the system's own colours, primary
                  and secondary, with nothing named. */}
              {session !== null ? (
                <LabeledContent label="Gmail">
                  <Text>Connected</Text>
                </LabeledContent>
              ) : (
                <Button onPress={signIn} modifiers={[buttonStyle('plain')]}>
                  <Text modifiers={[foregroundColor(WHITE)]}>Reconnect Gmail</Text>
                </Button>
              )}
            </Section>
          )}

          {/* ── ABOUT ── The two pages the app is obliged to link to, in the
              system browser: openBrowserAsync presents Safari over the sheet
              and returns to it on dismiss. The version line is the group's
              footer, where Settings prints the facts a row is too much for. */}
          <Section title="About" footer={<Text>{`Terminal ${APP_VERSION} (build ${APP_BUILD})`}</Text>}>
            {/* THE TWO GREEN THINGS THAT ARE NOT THE SWITCH, and the only two
                rows with a chevron. Both read as links because they leave the
                app -- the accent says so, and the disclosure indicator says
                where. */}
            <Button onPress={() => { void WebBrowser.openBrowserAsync(PRIVACY_URL); }} modifiers={[buttonStyle('plain')]}>
              <HStack>
                <Text modifiers={[foregroundColor(GREEN)]}>Privacy Policy</Text>
                <Spacer />
                <Chevron />
              </HStack>
            </Button>
            <Button onPress={() => { void WebBrowser.openBrowserAsync(TERMS_URL); }} modifiers={[buttonStyle('plain')]}>
              <HStack>
                <Text modifiers={[foregroundColor(GREEN)]}>Terms of Use</Text>
                <Spacer />
                <Chevron />
              </HStack>
            </Button>
          </Section>

          {/* ── LOG OUT ── A lone row in a group of its own, centred and red.
              THE ROLE COLOURS IT, which is why this is the one Button with no
              colour named and no plain style: both would take the red off.
              The system's action sheet confirms. */}
          {username !== null && (
            <Section>
              <Button role="destructive" onPress={confirmLogout}>
                <HStack>
                  <Spacer />
                  <Text>Log out</Text>
                  <Spacer />
                </HStack>
              </Button>
            </Section>
          )}
        </Form>
      </Host>
    </>
  );
}
