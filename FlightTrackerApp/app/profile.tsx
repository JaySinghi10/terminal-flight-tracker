// ── THE PROFILE, AS A PAGE SHEET THE SYSTEM DRAWS ───────────────────────────
//
// A ROUTE, NOT A MODAL COMPONENT. The root Stack presents this over the tabs
// with presentation 'modal', which on an iPhone is UIKit's page sheet: the
// slide, the corner radius, the parent dimming and shrinking behind it, the
// swipe down to dismiss and the header are all UIKit's, and none of them is
// drawn here. The header is the native one -- a title, and a Done item on the
// right -- declared through Stack.Toolbar at the top of the render.
//
// THE LIST IS SWIFTUI. @expo/ui's Form is a real inset-grouped list with real
// cells: the switch is a UISwitch, the rows press the way Settings rows press,
// and the type is the system's, Dynamic Type included. The shape is Settings
// > Apple Account's -- a header card, grouped sections, a lone red row last.
// The icon tiles are Settings' too: a 29pt square with continuous corners and
// a white glyph, in this app's green.
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
  HStack, VStack, Spacer, type ImageProps,
} from '@expo/ui/swift-ui';
import {
  tint, frame, background, foregroundStyle, font, padding, disabled, shapes,
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

// Display-only handle. Saved flights are keyed on email, never on this.
function sanitiseDisplayName(raw: string) {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
}

// ── THE ICON TILE ───────────────────────────────────────────────────────────
//
// SETTINGS' OWN: a 29pt square, continuous corners at 6.5, a white .fill glyph
// at 16 medium, on a solid colour. Modifiers apply in order, as SwiftUI's do:
// the font sizes the glyph, the frame is the tile, the background fills it.
type Symbol = NonNullable<ImageProps['systemName']>;
const TILE = shapes.roundedRectangle({ cornerRadius: 6.5, roundedCornerStyle: 'continuous' });

function Tile({ symbol }: { symbol: Symbol }) {
  return (
    <Image
      systemName={symbol}
      color="#ffffff"
      modifiers={[
        font({ size: 16, weight: 'medium' }),
        frame({ width: 29, height: 29 }),
        background(GREEN, TILE),
      ]}
    />
  );
}

// A ROW: the tile, the label in the primary label colour -- set outright,
// because inside a Button the default would be the tint -- and, on a row that
// goes somewhere, the space and the chevron. The chevron is UIKit's disclosure
// indicator by size, weight and tone; a row that acts in place gets none.
function Row({ symbol, label, chevron }: { symbol: Symbol; label: string; chevron?: boolean }) {
  return (
    <HStack spacing={12}>
      <Tile symbol={symbol} />
      <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}>{label}</Text>
      {chevron && <Spacer />}
      {chevron && (
        <Image
          systemName="chevron.right"
          modifiers={[
            font({ size: 14, weight: 'semibold' }),
            foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
          ]}
        />
      )}
    </HStack>
  );
}

// THE HEADER CARD. Settings > Apple Account's: the placeholder avatar on the
// left, the name at title2, the second line in the secondary colour at
// footnote. The Spacer makes the row the tap target when a Button wraps it.
function Card({ name, line }: { name: string; line: string }) {
  return (
    <HStack spacing={14} modifiers={[padding({ vertical: 6 })]}>
      <Image
        systemName="person.crop.circle.fill"
        modifiers={[font({ size: 58 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}
      />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: 'title2' }), foregroundStyle({ type: 'hierarchical', style: 'primary' })]}>
          {name}
        </Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          {line}
        </Text>
      </VStack>
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
      {/* THE DONE ITEM. A UIBarButtonItem in the sheet's own header, in the
          prominent style iOS 26 gives a sheet's confirming action. The
          header itself, the title and the tint are declared where the sheet
          is: app/_layout.tsx. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>Done</Stack.Toolbar.Button>
      </Stack.Toolbar>

      {/* THE HOST fills the screen and proposes the viewport to SwiftUI, which
          is what a Form needs to scroll rather than size to its content. The
          seed colour is the environment tint every control below inherits;
          the switch names it again because the spec names it there. */}
      <Host style={{ flex: 1 }} useViewportSizeMeasurement seedColor={GREEN}>
        <Form>
          {/* ── ACCOUNT ── The card is the name row: tapping it edits the name
              through the system alert. Signed out, it is a plain card with a
              sign-in row under it. */}
          <Section>
            {username !== null ? (
              <Button onPress={editName}>
                <Card name={effectiveName ?? 'Guest User'} line={email ?? 'Signed in'} />
              </Button>
            ) : (
              <Card name="Guest User" line="Sign in to sync your flights" />
            )}
            {username === null && <Button label="Sign in with Google" onPress={signIn} />}
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
              <Row symbol="bell.fill" label="Notifications" />
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
              {session !== null ? (
                <LabeledContent label={<Row symbol="envelope.fill" label="Gmail" />}>
                  <Text>Connected</Text>
                </LabeledContent>
              ) : (
                <Button onPress={signIn}>
                  <Row symbol="envelope.fill" label="Reconnect Gmail" chevron />
                </Button>
              )}
            </Section>
          )}

          {/* ── ABOUT ── The two pages the app is obliged to link to, in the
              system browser: openBrowserAsync presents Safari over the sheet
              and returns to it on dismiss. The version line is the group's
              footer, where Settings prints the facts a row is too much for. */}
          <Section title="About" footer={<Text>{`Terminal ${APP_VERSION} (build ${APP_BUILD})`}</Text>}>
            <Button onPress={() => { void WebBrowser.openBrowserAsync(PRIVACY_URL); }}>
              <Row symbol="hand.raised.fill" label="Privacy Policy" chevron />
            </Button>
            <Button onPress={() => { void WebBrowser.openBrowserAsync(TERMS_URL); }}>
              <Row symbol="doc.text.fill" label="Terms of Use" chevron />
            </Button>
          </Section>

          {/* ── LOG OUT ── A lone row in a group of its own, centred, red by
              role; no tile, no chevron. The system's action sheet confirms. */}
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
