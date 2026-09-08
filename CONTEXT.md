# Terminal — project context

For an assistant that cannot read the repository. It describes what exists, why it was built that way, and what has already been ruled out. Written 8 September 2026. Where a number was measured it says so; where it was estimated it says that too.

---

## 1. What Terminal is

Terminal is an iPhone flight tracker. Three things distinguish it from the category. It asks the aircraft rather than the airline, so a landing is confirmed by a position feed instead of an airline's own status field. It knows the airport, including which side of security every restaurant is on, which is the difference between useful and decorative when you have ninety minutes and a passport check ahead of you. And when a flight is cancelled it is supposed to tell you what to do next rather than telling you to contact the airline.

What works today: you can look up a flight, save it, group saved flights into trips, pull upcoming flights out of your Gmail, see a globe map with your routes on it, and get a Deck screen that answers "where am I and what is near me". A server polls every watched flight and records what changed.

What it is meant to become is that plus notifications that arrive before the airline's, indoor guidance inside a terminal, and real disruption recovery.

**The gap is notifications, and it is large.** No push notification has ever been sent by this product. The layer that decides which changes are worth waking someone for is built and tested, and it writes messages into an outbox that nothing drains. The sending is not written. Until it is, the poller is an expensive way of keeping a record nobody reads. Everything else in this document should be read against that.

The app also ran on real hardware for the first time this week. Before that everything was written against Expo Go or not run at all.

---

## 2. The app

React Native and Expo, file-based routing, four tabs. In tab order: **Home**, **My Flights**, **Deck**, **Search**.

**Home** is the search field and the result. You type a flight number and get a card. Under it sits the watchlist, a row that pulls flights out of Gmail, a section for legs the airline has not published yet, and a profile sheet holding Google sign-in.

**My Flights** is the saved list arranged as journeys. Flights that belong together are folded into a trip; the folder for the trip you are on opens by default, computed fresh each time rather than remembered, because a set of open folders seeded at mount goes stale the moment a journey finishes and the next is promoted.

**Deck** answers where you are and what is near you. It derives the airport from your journey rather than asking, and a manual pick overrides that. For a layover it computes a reserve of time from the layover length and both terminals, using estimates for immigration, security and a terminal change. Those are estimates and the file says so; no vendor sells walking times for a set of airports this size. Under that sits the dining list split by security side, and where the data exists, a schematic of the terminal with the gates on it.

**Search** holds the globe map, route search, and a chat assistant. The map is MapLibre running as JavaScript inside a WebView, not a native SDK.

**How a flight gets in.** Four ways: typed on Home, bookmarked from a route search, pulled from Gmail, or tapped from a Gmail leg. Saving does three things: writes it locally, registers a watch on the server, and offers reminders. The watchlist caps at twenty.

**Trips and connections.** Each saved flight carries a trip identifier or none. Owning a flight, meaning you are on it rather than watching it, puts it in a trip; detection joins nearby legs into one journey. This distinction now travels to the server, because a notification for a flight you are on reads "your flight to Bangalore" and one for a flight you are meeting reads "the flight from Mumbai".

**The card has phases** because the useful information changes as the journey does. Before departure it is the gate, the terminal and the check-in desk. Boarding is the same with a revised time. In the air it is an arc, a countdown and a pulse. After landing it is the arrival time and the baggage belt. There is also a stale phase, which exists specifically so a card with old data cannot render as "in air" and draw a live pulse over information that is not live.

---

## 3. The backend

Python and FastAPI on Google Cloud Run, region asia-south1, service `flight-tracker`. Cloud Scheduler calls the poller every two minutes. There is no database.

**Fifteen endpoints.**

Public, unauthenticated: `/flight/{number}` returns the record a card is built from. `/route/{origin}/{destination}` returns a departure board filtered to a destination. `/landing/{number}` answers whether an aircraft is down. `/quota` reports remaining provider units. `/parse` turns a sentence into structured fields. `/chat` is the assistant.

Session-authenticated by a bearer token: `/auth/google` exchanges an OAuth code and issues the session, `/auth/signout` destroys it and revokes at Google, `/gmail/flights` reads booking emails and returns flight legs. `/chat` accepts a session too, which is how the assistant can answer questions about your own next flight.

Secret-gated: three `/alerts` routes carrying the secret in the path, which receive and read back webhook deliveries from Flightradar24; `/watch` and `/unwatch` behind an `X-Watch-Secret` header; and `/poll` behind `X-Poll-Secret`. Every one of these answers a bad secret with 404 rather than 403, because a 403 confirms the route exists and tells a prober they have found something worth probing.

**Landing detection is its own endpoint on purpose.** Folding it into the flight lookup would mean every two-minute check near an arrival also spent a unit of the scarce provider's budget, so the constrained budget would be paying for the unconstrained one. It also means an outage at the landing provider cannot slow or break schedules, gates and route search.

**The poller** reads the watch list, assigns each flight a tier from stored state without making a call, fetches only what is due, diffs the result against what was stored, records the changes, and decides what would be worth notifying.

| Tier | Interval | When |
|---|---|---|
| Distant | 12 h | more than 48 h before departure |
| Far | 6 h | between 48 h and 6 h |
| Day | 30 min | inside 6 h |
| Near | 5 min | inside 90 min |
| Airborne | 15 min | after departure |
| Arrival | 2 min | inside 30 min of arrival |
| Done | never | landed, or three hours past arrival |

Consecutive misses double the interval up to a six-hour cap, and one good answer resets it entirely. That rule exists because a flight with no stored record is tiered Near, so a flight number the provider cannot resolve would be polled every five minutes for ever, which is 288 units a day for one number. The live watchlist had four such numbers; alone they would have spent a whole month's budget in four days. Each run is capped at forty schedule calls and sixty landing calls, because Cloud Run has a request timeout and a run that died halfway would leave some state written and some not.

**All state is in one Cloud Storage bucket,** every write guarded by a generation precondition because several instances can poll at once. The watch list is a single JSON object holding a random install identifier, flight number, date, a push token where one exists, and now whether the person is on the flight. Each watched flight has its own object under `state/`, holding the last provider record, the last landing answer, poll timestamps, the ledger of changes, and the notification state with its outbox. A runtime object holds the landing provider's circuit breaker, its landings cache and the quota figure. Sign-in adds one object per Google account and one per live session.

---

## 4. Data providers

**AeroDataBox, through RapidAPI.** Schedules, gates, terminals, baggage belts, status and route boards. This is the scarce budget: five thousand units a month. A flight lookup costs two units. A dated route board costs four, because the provider refuses any time range longer than twelve hours, so a local day is two requests. Dated single-flight lookups reach 180 days ahead on this plan, which is not a guess: the provider returned a 400 saying so. The route board is only evidenced to 60 days, so that is where it stops.

Where it fails: it will tell you a flight has landed when it has not. That is why it is not allowed to declare a landing.

**Flightradar24.** Landings only, and authoritative for them. Billing is per returned record, one credit live and two for anything historic under thirty days, and a query that returns nothing still costs one. That is why every query carries the departure instant: without it the search window is twelve hours back and thirty-six forward, which drags back every other leg that number flew and charges for all of them.

Its coverage was measured rather than assumed. A 200-flight validation across six regions on 7 September 2026 put detection at **94.6 per cent, 106 of the 112 flights that actually finished**. Europe, India and South-East Asia were 100 per cent.

Almost the entire shortfall is one airport.

| Airport | Landed | Lost | Lost |
|---|---|---|---|
| Doha | 2 | 4 | 66.7% |
| Dubai | 10 | 0 | 0% |
| Abu Dhabi | 12 | 0 | 0% |

Fisher exact, one-sided, Doha against the other two: **p = 0.00073**. The four lost were QR515, QR615, QR8230 and QR8623, each polled eight times over about three and a half hours. Two other Qatar Airways flights into Doha landed normally in the same window, so it is not an airline effect; the only non-Qatar arrival enrolled was still airborne when the run ended, so airline and airport cannot be fully separated. Every failure observed was an arrival into Doha.

Nothing is done about it deliberately. Falling back to the schedule provider for Doha would reintroduce exactly the false-landing fault that this design exists to prevent, at the one airport we know least about. The cost to a traveller is that a Doha arrival may show no landing time until the schedule provider publishes its own, which is a delay rather than a wrong answer.

**Google Gemini** does two jobs: extracting flights from booking emails, and answering the chat assistant. **Google's OAuth and Gmail API** provide sign-in and read-only mail access.

---

## 5. Generated datasets

All three ship inside the app and are generated by scripts, not edited by hand.

**Airports.** 1,223 entries with city, country and IANA timezone, from OurAirports for the classification joined to a public dataset for the timezone, which OurAirports does not carry. The filter is scheduled service, a real IATA code, and either a large airport or a medium one in India. That produced 1,212; eleven were added by hand, ten of them Indian airports the source calls "small" that nonetheless carry scheduled service, plus one that appears on live boards despite the source saying otherwise. **The India bias is deliberate**, not an artefact.

**Dining.** 753 outlets across eight airports, scraped from each airport's own published source on 7 September 2026. Mumbai 149, JFK 139, Newark 118, Frankfurt 83, Hong Kong 76, LaGuardia 72, Stockholm 65, Heathrow 51. Each outlet carries which side of security it is on, and the data records whether the airport published that explicitly or it was inferred. Opening hours are kept as verbatim strings in whatever dialect the airport publishes, deliberately not parsed by the scraper, so the parsing decision belongs to the app.

This is the thinnest dataset by coverage and the richest by usefulness. Eight airports out of 1,223 means the no-data state is the common case, and the screen is built around that being normal. Note that the two datasets do not line up: Delhi and Bangalore have terminal outlines but no dining, and Heathrow has both.

**Terminals.** 24 terminals at ten airports, from OpenStreetMap under ODbL, which requires visible attribution wherever it is drawn. JFK, Heathrow and Stockholm have four each; Mumbai, Frankfurt, Hong Kong, LaGuardia and Delhi two; Newark and Bangalore one. Outlines are simplified to a ten-metre tolerance because that is sub-pixel at the zoom a schematic is drawn at. Each terminal carries a number saying how much of its gates' spread a single straight line explains, which is the honesty field: a high score means the gate order is a walking order, and a low one means a gate can sit "between" two others while walking there means doubling back. Below a threshold the app must describe the order as rough rather than implying a route it has no path data for.

**Airport ICAO codes.** 3,986 pairs, needed only because the landing provider returns ICAO codes and everything else in the system is IATA.

---

## 6. Decisions and the reasons behind them

### Rules that exist because of a specific past bug

The landing provider is the only thing permitted to declare a landing. The schedule provider once reported a flight as landed while it was still at its gate.

A departure is only announced once the actual time is in the past **and** has survived two consecutive polls. The provider was observed revising an "actual" departure by fifty-three minutes, which means the first value was an estimate wearing the wrong label.

Every landing query carries the departure instant. Flight 6E6188 on 7 September was recorded as landed using the previous day's rotation of the same flight number, which sat inside the default search window.

A leg from an earlier UTC day is refused when only a date was supplied, for the same reason.

First sight of a flight is never a change. Everything about a flight is new the first time it is seen, and treating that as news would mean a notification per field at registration.

Absence is never an assertion. The landing code never returns "not landed" as a fact; a flight the feed has never heard of leaves the card exactly as it was.

An estimated time that moves by less than five minutes is not a change, because estimates are recomputed continuously upstream and a ledger full of ninety-second drift is a ledger nobody reads.

The watch store distinguishes "could not be read" from "is empty". Collapsing those two is how a poller does nothing for ever without a single error in the log.

Scripts loaded into the map's WebView are asynchronous, which is load-bearing: the default the code previously used puts scripts in an execution queue where the second waits for the first, which would have made the CDN fallback serial and useless.

### Values that are deliberately absent rather than guessed

A gate we were not given is not displayed. A terminal, belt or desk that the feed does not carry is shown as absent. The layover reserve is presented as an estimate. The diversion notification says plainly that we do not know where the aircraft went, because the schedule provider carries no diversion airport.

### Product decisions, which could reasonably have gone the other way

Green means live or actionable, amber means late, red means cancelled, and nothing else is coloured. **Never send the user to the airline**: a cancellation names the next departure on the route instead, found with the same route board the app already uses. **Notifications lead with the destination, never the flight number**, because nobody remembers their flight number and everybody remembers where they are going.

Gate changes are only notified inside four hours of departure, with a baseline taken when that window opens, after a value has held for two polls, capped at three messages. Seven gate changes in twelve hours, seventeen hours before departure, produce nothing at all.

There are no accounts. Google sign-in exists only to reach Gmail. The Deck's "I am here" pin is tapped rather than detected, because there is no indoor positioning, and it is not persisted, because it is true only while you stand still. The Doha weakness is recorded and not worked around. Sorting by cheapest waits for a fare provider, because none of the current providers carries a fare.

Push permission is never requested by the code that registers watches; it is only asked for when the user sets a reminder, at the moment the question makes sense. The consequence, stated plainly in the code, is that a user who never sets a reminder has no push token and will never receive alerts. That is a real product cost accepted on purpose.

---

## 7. State of play

**Built and verified.** The poller runs live against a real watchlist, and its first polls were checked call by call. Landing detection, flight lookup and the route board all work in production. Gmail extraction works end to end, verified both through seven synthetic fixture emails and against the live service. The pending-leg store, which keeps a booked flight the airline has not published yet and retries it, has unit tests. The refresh-token sign-in works server side, confirmed on the live service. The public website has a privacy policy and terms at real URLs.

**Built but never run on a device.** Until this week, that was everything. Still unverified on hardware: the Google sign-in flow end to end, push token registration, a Gmail pull from a real inbox, and the notification tap that opens the route list.

**Half-built.** Notifications. The decision layer knows which changes matter, in what window, and what each message says, with sixty tests including a replay of the one real change ledger the poller has produced. Messages accumulate in a bounded outbox on each flight's state object. **Nothing drains it.** Similarly, when a pending leg finally resolves, that event is recorded for a sender that does not exist.

**Not started.** The push sender. Fare data of any kind. Indoor positioning. App Store submission.

**Deliberately deferred.** Bundling the map library into the app instead of fetching a megabyte from a CDN at first paint. Sorting by cheapest. Deleting poll state after a flight has finished.

---

## 8. Known gaps

**The search field rejects most Indian flight numbers.** In `app/search.tsx` line 220 the pattern requires two letters followed by digits, so 6E5071 and QP1133 cannot be typed. IndiGo and Akasa are the two largest carriers on the routes this app is built for. This has been flagged repeatedly and not fixed.

**Poll state files are never deleted.** The function to delete one exists and nothing calls it, so a state object outlives its flight indefinitely. The privacy policy says this outright and calls it a gap in the code rather than a policy, which is honest but does not make it less of a gap.

**Push tokens are stored and no push is ever sent.** The policy says so.

**The landing provider's API token was pasted into a chat transcript** and has not been rotated. That is the owner's call and has been flagged.

**Dead code.** A client-side landing sweep and parts of an auto-refresh path were superseded by the poller and have not been removed.

**A pending-leg retry reports the wrong trigger name** on one path. Harmless, and it will confuse whoever reads the events.

**Android is untested.** Permissions are declared and the code paths exist, but this is an iPhone product and nothing has been run on Android.

**Where policy and code could drift.** The privacy policy is currently accurate, having been rewritten when the refresh-token flow shipped. The one thing it describes that has never actually executed is sign-out revoking access at Google: the code is written and tested against a fake, but it has not run on a device. If that path is broken, the policy is describing something that does not happen.

---

## 9. Native modules and the Swift boundary

**There is no custom native code at all today.** No iOS or Android project directory exists in the repository; the app is managed, and the native projects are generated in the cloud at build time. Of thirty-six dependencies, thirty-one have a native side, and every one of them is an off-the-shelf Expo or React Native package. Nothing in this codebase is Swift, Objective-C, Kotlin or Java.

**What the development build unlocked.** Expo Go is a single pre-built container app, so it can only run what its own binary already contains. Moving to a development build changed four things. Push notifications became possible at all, because the build carries a real push entitlement and a bundle identifier of its own, and a push token cannot be issued to a project inside Expo Go. Any capability driven by a build-time configuration plugin became available. Custom native modules became possible for the first time. And the app got its own storage sandbox under its own identifier, which is why the watchlist appeared empty on first launch: it was a genuinely fresh install, not data loss.

**What is still out of reach, and why.** Mapbox indoor maps, floor level from CoreLocation, and the pedometer are all frequently discussed and none is installed. The development build is a precondition for each, not a delivery of any. Indoor maps would need the Mapbox native SDK, its configuration plugin and an access token, and would replace the current WebView map rather than sit beside it. Floor level is carried by CoreLocation but not exposed by the location package in use, so it needs a small native module. The pedometer is available on iOS through the system motion framework and would need the sensors package added.

**Where the boundary sits, and it is a deliberate line.** Everything about what to show and when is JavaScript: the notification decision, all three datasets, the trip logic, the layover arithmetic, the terminal schematic. Native code is reserved for what the operating system will not expose any other way, which today means sensors, floor level, background execution and any future Live Activity on the lock screen. That last one is the most likely first piece of real Swift, because a flight card on the lock screen is exactly what this product is for and there is no way to build one in JavaScript.

**The map is the one thing that could legitimately go either way.** It runs as a JavaScript library inside a WebView, which keeps it cross-platform and keeps the styling in one file, at the cost of fetching a megabyte at first paint and being unable to use native gesture handling. Replacing it with a native SDK is a real decision that has not been made.
