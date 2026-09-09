# Terminal — project context

For an assistant that cannot read the repository. It describes what exists, why it was built that way, and what has already been ruled out. Written 9 September 2026, replacing the version of the 8th, which is stale in almost every section. Where a number was measured it says so; where it was estimated it says that too.

---

## 1. What Terminal is

Terminal is an iPhone flight tracker. Three things distinguish it from the category. It asks the aircraft rather than the airline, so a landing is confirmed by a position feed instead of an airline's own status field. It knows the airport, including which side of security every restaurant is on, which is the difference between useful and decorative when you have ninety minutes and a passport check ahead of you. And when a flight is cancelled it tells you there is an alternative rather than telling you to contact the airline.

**The previous version of this document said the gap was notifications, and that nothing had ever been sent. That is no longer true.** The sender was built, deployed and scheduled on 8 September. Its first live pass delivered nine messages across six flights, and Expo returned a positive delivery receipt for every one of them.

**The honest gap now is narrower and differently shaped, and there are three parts to it.**

First, no human has confirmed seeing a notification on a phone. Delivery receipts prove Apple accepted the pushes; they do not prove anything appeared on a lock screen. That last step is unverified.

Second, the app on the tester's phone lags the repository. Two builds are in TestFlight: one from the stable line and one carrying the native tab bar. Both predate the notification staleness rule, the iOS 26 floor, the Apple-glass toasts, the tab bar inset fix and the whole of the Gmail screen rework, all of which exist only in the repository until the next build lands.

Third, and this is a product decision rather than a defect, notification permission is only ever requested when someone turns on a reminder for a saved flight. A person who never does that has no push token and will never be reached, no matter how well the server behaves.

The other real gap is that the whole thing has been exercised by one household. There is no second install, no other timezone, and no phone that is not on iOS 26.

---

## 2. The app

**It requires iOS 26 or later, and the build enforces it.** The deployment target is set to 26.0 through a configuration plugin, so a phone below 26 cannot install the app at all. The reason is the surface material. Every sheet, panel, menu and toast is meant to be Apple's own glass, which exists only on iOS 26 and does not degrade: below that version the view holds an empty effect and renders nothing, so a converted surface would be a transparent rectangle with its text floating over whatever is behind it. A compatibility path was considered and rejected on the grounds that no tester's phone would ever take it, which makes it code that cannot be checked. The cost is real and was accepted knowingly: most iPhones in the world cannot install this app.

React Native and Expo, file-based routing, four tabs. In tab order: Home, My Flights, Deck, Search.

**The tab bar is Apple's, not hand-built.** A hand-drawn glass tab bar of about four and a half thousand lines was deleted and replaced with the system control. It carries one unresolved defect, described in the gaps section.

**Home** is the search field and the result. You type a flight number and get a card. Under it sit the watchlist, a single-line row that pulls flights out of Gmail, a labelled section for legs the airline has not published yet, and a profile sheet holding Google sign-in. The pull used to echo its own results in a third list below the button; that list was a duplicate of the two places the legs had already gone, and it was deleted.

**My Flights** is the saved list arranged as journeys. Flights that belong together fold into a trip, and the folder for the journey you are on opens by default, computed fresh each time rather than remembered, because a set of open folders seeded at mount goes stale the moment one journey finishes and the next is promoted.

**Deck** answers where you are and what is near you. It derives the airport from your journey rather than asking, and a manual pick overrides that. For a layover it computes a reserve of time from the layover length and both terminals, using estimates for immigration, security and a terminal change. Those are estimates and the file says so; no vendor sells walking times for a set of airports this size. Under that sits the dining list split by security side, and where the data exists, a schematic of the terminal with its gates.

**Search** holds the globe map, route search and a chat assistant. The map is MapLibre running as JavaScript inside a WebView rather than a native SDK.

**How a flight gets in.** Four ways: typed on Home, bookmarked from a route search, pulled from Gmail, or tapped from a Gmail leg. Saving writes it locally, registers a watch on the server, and offers reminders. The watchlist caps at twenty.

**Trips and connections.** Each saved flight carries a trip identifier or none. Owning a flight, meaning you are on it rather than watching it, puts it in a trip, and nearby legs are joined into one journey. That distinction travels to the server, because a notification about a flight you are on reads "your flight to Bangalore" and one about a flight you are meeting reads "the flight from Mumbai".

**The card has phases**, because what matters changes as the journey does. Before departure it is the gate, terminal and check-in desk. Boarding is the same with a revised time. In the air it is an arc, a countdown and a pulse. After landing it is the arrival time and the belt. There is also a stale phase, which exists so a card holding old data cannot render as "in air" and draw a live pulse over information that is not live.

**The card now also shows what the booking email said**, where a flight arrived that way: the reservation reference and the operating flight number of a codeshare. Neither comes from any flight-data provider, and they are stored on the record rather than fetched. The group is absent rather than empty for a flight looked up by hand, which is most of them.

**Every row that can be removed is removed by the same gesture.** Saved flights and unpublished legs both swipe. An unpublished leg previously carried a small cross, which was the only remove control on the page that was not a swipe.

**The local storage schema is at version 13**, with migrations for every step. Three kinds of field survive a refresh from the provider: the user's own decisions, another provider's answers, and what a booking email said. Without that carry-forward an ordinary refresh would null all three, because the response it is built from has never heard of any of them.

---

## 3. The backend

Python and FastAPI on Google Cloud Run, region asia-south1, service `flight-tracker`. There is no database. Two Cloud Scheduler jobs drive it: the poller every two minutes, and the dispatcher every minute.

**Sixteen endpoints.**

Public and unauthenticated: the flight lookup that a card is built from, a route board filtered to a destination, a landing check, a quota report, a parser that turns a sentence into structured fields, and the chat assistant.

Session-authenticated by a bearer token: the Google OAuth exchange that issues a session, a sign-out that destroys it and revokes at Google, and the Gmail reader that returns flight legs. The assistant also accepts a session, which is how it can answer questions about your own next flight.

Secret-gated: three alert routes carrying their secret in the path, which receive and read back webhook deliveries from the landing provider; the watch and unwatch pair behind one header secret; the poller behind another; and the dispatcher behind a third. Every one answers a bad secret with 404 rather than 403, because a 403 confirms the route exists and tells a prober they have found something worth probing.

**Landing detection is a separate endpoint on purpose.** Folding it into the flight lookup would mean every two-minute check near an arrival also spent a unit of the scarce provider's budget, so the constrained budget would pay for the unconstrained one. It also keeps schedules, gates and route search structurally out of reach of a landing-provider outage.

**The poller** reads the watch list, assigns each flight a tier from stored state without making any call, fetches only what is due, diffs the result against what was stored, records the changes, and decides what would be worth saying. The tiers run from twelve hours out when a flight is more than two days away, through six hours, thirty minutes inside six hours, five minutes inside ninety, fifteen minutes once airborne, down to two minutes in the last half hour before arrival, and then never once it has landed.

Consecutive misses double the interval to a six-hour ceiling, and one good answer clears it entirely. That rule exists because a flight with no stored record is tiered as if it were imminent, so a number the provider cannot resolve would be polled every five minutes for ever, which is 288 units a day for one number. The live watchlist had four such numbers; alone they would have spent a month's budget in four days. Each run is capped at forty schedule calls and sixty landing calls, because Cloud Run has a request timeout and a run that died halfway would leave some state written and some not.

**The dispatcher is the half that did not exist a day ago.** The poller decides what to say and leaves it in a bounded outbox on each flight's state object; the dispatcher takes it out and sends it through Expo's push service.

It is a separate endpoint on its own schedule rather than part of the poll, and the reason is deferral. A cancellation discovered at two in the morning is held until seven so it does not wake anyone. If sending only happened inside a poll, that message would go out on the next poll of that particular flight, which for a cancelled flight in a slow tier may be hours later or never. The dispatcher needs its own clock.

Each pass collects delivery receipts first, then sends. Both live on one endpoint because the pass runs on a schedule whether or not there is anything to send, so the receipt sweep always happens without a second scheduler job. A ticket returned at send time only means Expo accepted the message; the real outcome arrives from a second call about fifteen minutes later.

Delivery is at-least-once by deliberate choice. Each message-and-device pair is claimed in the flight's state before the network call and confirmed after it, so a crash in between leaves a claim that goes stale in ten minutes and is retried. The opposite ordering would make duplicates impossible and permanent silence possible, because the decision layer refuses to ever create the same message twice. For this product a rare duplicate is much cheaper than a delay nobody hears about.

**A message too old to act on is dropped rather than sent**, and the record says why. This rule was written immediately after the first live pass, which drained a backlog that had accumulated while nothing was reading the outbox and delivered a six-hour-old cancellation. Each kind of message has a useful life measured from the moment it became due: half an hour for a gate, because a stale gate is not merely useless but actively wrong, forty-five minutes for a baggage belt, an hour for a delay or a departure, two hours for a terminal change or a cancellation. The clock starts at the deferral time where there is one, so a message held overnight is not stale the moment it becomes due.

One further rule came out of writing the tests rather than from a failure: a message that cannot be rendered is dropped under its own reason instead of raising. Unguarded, a single malformed row in one flight's outbox would have ended the pass and stopped delivery for every flight, every minute, until somebody noticed.

**All state lives in one Cloud Storage bucket**, every write guarded by a generation precondition because several instances can run at once. The watch list is a single object holding a random install identifier, flight number, date, a push token where one exists, and whether the person is on the flight. Each watched flight has its own object holding the last provider record, the last landing answer, poll timestamps, the ledger of changes, the notification state with its outbox, and now the delivery record of what was sent to whom. A runtime object holds the landing provider's circuit breaker, its cache and the quota figure. Sign-in adds one object per Google account and one per live session, with the refresh token encrypted and the account identifier bound into the encryption so a record cannot be replayed under another account.

---

## 4. Data providers

**AeroDataBox, through RapidAPI.** Schedules, gates, terminals, belts, status and route boards. This is the scarce budget: five thousand units a month. A flight lookup costs two units; a dated route board costs four, because the provider refuses a range longer than twelve hours and a local day is therefore two requests. Dated single-flight lookups reach 180 days ahead on this plan, which is not a guess — the provider returned an error saying so. The route board is only evidenced to 60 days, so that is where it stops.

Where it fails: it will report a flight as landed when it has not. That is why it is not permitted to declare a landing.

**Flightradar24.** Landings only, and authoritative for them. Billing is per returned record, one credit live and two for anything historic under thirty days, and a query returning nothing still costs one. Every query therefore carries the departure instant: without it the search window is twelve hours back and thirty-six forward, which drags in every other leg that number flew and charges for all of them.

Coverage was measured rather than assumed. A 200-flight validation across six regions on 7 September 2026 put detection at 94.6 per cent, meaning 106 of the 112 flights that actually finished. Europe, India and South-East Asia were complete.

Almost the entire shortfall is one airport. Doha lost four of six arrivals; Dubai lost none of ten and Abu Dhabi none of twelve. A one-sided Fisher exact test of Doha against the other two gives a probability of 0.00073. The four lost flights were each polled eight times over about three and a half hours. Two other flights by the same airline into Doha landed normally in the same window, so it is not an airline effect; the only non-Qatar arrival enrolled was still airborne when the run ended, so airport and airline cannot be fully separated. Every failure observed was an arrival into Doha.

Nothing is done about it, deliberately. Falling back to the schedule provider for Doha would reintroduce the false-landing fault this whole design exists to prevent, at the airport we know least about. The cost to a traveller is that a Doha arrival may show no landing time until the schedule provider publishes its own, which is a delay rather than a wrong answer.

**Expo's push service** carries every notification to Apple. It is free, with no per-message cost to budget against, and the only real ceiling is a throughput limit far above anything this will produce. Unauthenticated sending was verified against the live endpoint rather than assumed. Enabling Expo's optional enhanced security later would need an access token in the environment and no code change.

**Google Gemini** extracts flights from booking emails and answers the chat assistant. **Google OAuth and the Gmail API** provide sign-in and read-only mail access.

---

## 5. Generated datasets

All three ship inside the app and are produced by scripts rather than edited by hand.

**Airports.** 1,223 entries with city, country and IANA timezone, from OurAirports for the classification joined to a public dataset for the timezone, which OurAirports does not carry. The filter is scheduled service, a real IATA code, and either a large airport or a medium one in India. That produced 1,212; eleven were added by hand, ten of them Indian airports the source calls small that nonetheless carry scheduled service, plus one that appears on live boards despite the source saying otherwise. The India bias is deliberate rather than an artefact.

**Dining.** 753 outlets across eight airports, scraped from each airport's own published source on 7 September 2026. Mumbai has the most at 149, then JFK at 139, Newark at 118, Frankfurt at 83, Hong Kong at 76, LaGuardia at 72, Stockholm at 65 and Heathrow at 51. Each outlet records which side of security it is on, and whether the airport published that explicitly or it was inferred. Opening hours are kept as verbatim strings in whatever dialect the airport publishes, deliberately unparsed, so the parsing decision belongs to the app rather than to the scraper.

This is the thinnest dataset by coverage and the richest by usefulness. Eight airports out of 1,223 means the no-data state is the common case, and the screen is built around that being normal. The two location datasets do not line up: Delhi and Bangalore have terminal outlines but no dining, and Heathrow has both.

**Terminals.** 24 terminals at ten airports, from OpenStreetMap under a licence that requires visible attribution wherever the data is drawn. JFK, Heathrow and Stockholm have four each; Mumbai, Frankfurt, Hong Kong, LaGuardia and Delhi have two; Newark and Bangalore one. Outlines are simplified to a ten-metre tolerance, which is sub-pixel at the zoom a schematic is drawn at. Each terminal carries a score for how much of its gates' spread a single straight line explains, which is the honesty field: a high score means the gate order is a walking order, and a low one means a gate can sit between two others while walking there means doubling back. Below a threshold the app must describe the order as rough rather than implying a route it has no path data for.

**Airport ICAO codes.** 3,986 pairs, needed only because the landing provider returns ICAO codes while everything else in the system speaks IATA.

---

## 6. Decisions and the reasons behind them

### Rules that exist because of a specific past bug

The landing provider is the only thing permitted to declare a landing. The schedule provider once reported a flight as landed while it was still at its gate.

A departure is announced only once the actual time is in the past and has survived two consecutive polls. The provider was observed revising an actual departure by fifty-three minutes, which means the first value was an estimate wearing the wrong label.

Every landing query carries the departure instant. One flight was recorded as landed using the previous day's rotation of the same number, which sat inside the default search window. A leg from an earlier UTC day is refused when only a date was supplied, for the same reason.

First sight of a flight is never a change. Everything about a flight is new the first time it is seen, and treating that as news would mean a notification per field at registration.

Absence is never an assertion. The landing code never returns "not landed" as a fact; a flight the feed has never heard of leaves the card exactly as it was.

An estimated time that moves by less than five minutes is not a change, because estimates are recomputed continuously upstream and a ledger full of ninety-second drift is a ledger nobody reads.

The watch store distinguishes "could not be read" from "is empty". Collapsing those is how a poller does nothing for ever without a single error in the log.

A booking email dated more than sixty days before the message that carried it has its year rolled forward, because an email received in late December for a flight on the fifteenth of January means next January. The gap is sixty days rather than something smaller so that a post-flight thank-you note, which names a date a few days in the past, is not turned into next year's flight.

A message older than its kind's useful life is dropped rather than sent. Written the same evening the first dispatch pass delivered a six-hour-old cancellation.

A message that cannot be rendered is dropped rather than raising, so one malformed row cannot silence every flight.

### Values that are deliberately absent rather than guessed

A gate we were not given is not displayed. A terminal, belt or desk the feed does not carry is shown as absent. The layover reserve is presented as an estimate. The diversion message says plainly that we do not know where the aircraft went, because the schedule provider carries no diversion airport.

### Product decisions that could reasonably have gone the other way

Green means live or actionable, amber means late, red means cancelled, and nothing else is coloured. Never send the user to the airline: a cancellation says an alternative exists and a tap opens the route list. Notifications lead with the destination and never with the flight number, because nobody remembers their flight number and everybody remembers where they are going. A notification adds the departure time to its subject only when the reader is watching two flights to the same city that day, and adds the airline only when two of those share a time.

Gate changes are notified only inside four hours of departure, with a baseline taken when that window opens, after a value has held for two polls, and capped at three messages. Seven gate changes in twelve hours, seventeen hours before departure, produce nothing at all.

There are no accounts. Google sign-in exists only to reach Gmail. The Deck's "I am here" pin is tapped rather than detected, because there is no indoor positioning, and it is not persisted, because it is true only while you stand still. The Doha weakness is recorded and not worked around. Sorting by cheapest waits for a fare provider, because none of the current providers carries a fare.

Push permission is never requested by the code that registers watches. It is asked for only when someone sets a reminder, at the moment the question makes sense. The consequence, stated plainly in the code, is that a user who never sets a reminder has no push token and will never be reached. That is a real product cost accepted on purpose, and it is now the single most likely reason a notification will not arrive.

The poller and the dispatcher have separate secrets even though one scheduler drives both, so either can be rotated without silencing the other pass, and a job pointed at the wrong endpoint fails closed rather than running the wrong work.

---

## 7. State of play

**Verified on a real device.** The app runs from TestFlight on an iPhone. Google sign-in completes end to end, which was unverified two days ago. A Gmail pull against a real inbox works: a set of five deliberately constructed test emails produced exactly the six legs predicted, including a three-leg itinerary, a codeshare filed under its marketing number, and a leg whose details were carried in structured data rather than prose. The email dated in the past was correctly rejected and did not appear. Two of the six resolved against the provider and were saved; four did not and were queued as unpublished, which is the designed behaviour and not a failure.

**Verified in production, on the server.** The poller runs live against a real watchlist. The dispatcher runs every minute, and its first pass sent nine messages for which Expo returned a positive delivery receipt in every case. Later passes correctly send nothing, which is the never-twice guarantee holding against real storage rather than against a test double. Landing detection, flight lookup and the route board all work. The refresh-token sign-in works. The public website carries a privacy policy and terms at real URLs.

**Built, deployed, and not yet exercised.** The staleness rule is live but no message has been old enough to trip it since. The dead-token path has never fired, because no token has died. The unrenderable-message guard has never fired outside its tests.

**Built and never on a device at all.** Everything in the last seven commits: the Apple-glass toasts, the iOS 26 deployment floor, the tab bar inset fix, the removal of the Gmail echo, the booking details on the card, and the swipe on unpublished legs. All of it is in the repository and none of it is in any build.

**Half-built.** The conversion of the app's surfaces to Apple's glass. Two of fourteen sites are converted, both toasts. The remaining twelve are the sheets, panels and menus across four files, plus three map controls. The plan for the rest is written and the material choice is settled.

**Not started.** Fare data of any kind. Indoor positioning. Any App Store release, as opposed to TestFlight.

**Deliberately deferred.** Bundling the map library rather than fetching a megabyte from a CDN at first paint. Sorting by cheapest. Deleting poll state after a flight finishes. Replacing the custom sheet presentations with native ones, which would change dismissal, drag and the back gesture and is a larger job than the material.

---

## 8. Known gaps

**Secrets that need rotating, and this is the most urgent item here.** Three values have been exposed in chat transcripts and none has been rotated. The landing provider's API token was pasted some days ago. The dispatcher's secret was pasted yesterday, and it currently protects the endpoint that sends notifications to people. The fixture-inbox token is set to a trivially guessable development value; it gates a test path rather than real mail, but it is on the production service. Rotation is the owner's decision and has been flagged each time.

**The build tooling reported a submission failure that did not happen.** Build 4 was submitted twice; both runs ended with a generic message saying something had gone wrong at Apple's end, with no detail surfaced. App Store Connect shows that build as complete, ready to submit, and already installed once. So the binary arrived and the tooling misreported the outcome. The practical lesson is that this submission step cannot be trusted to say whether it worked, and App Store Connect is the only reliable check.

**The native tab bar has an unresolved minimise defect.** It shrinks correctly when a list is scrolled down but only expands again when the list returns to the very top, rather than on the first upward scroll. It affects all four screens. The cause has been narrowed: the behaviour setting is not responsible, the library's own scroll-view registration is working, and an upstream patch that appeared to address it was closed rather than merged, does not compile as written, and targets a different symptom. An experiment removing the registration and applying that patch is preserved in a git stash and has not been built. The defect is cosmetic in the sense that navigation is never unreachable.

**The search field rejects most Indian flight numbers.** The pattern requires two letters followed by digits, so the numbers used by the two largest carriers on the routes this app is built for cannot be typed. This has been flagged repeatedly and not fixed. The Gmail path handles those numbers correctly, which makes the inconsistency worse rather than better.

**Poll state objects are never deleted.** The function to delete one exists and nothing calls it, so an object outlives its flight indefinitely. The privacy policy says this outright and calls it a gap in the code rather than a policy, which is honest but does not make it less of a gap.

**No human has confirmed a notification appearing on a phone.** Delivery receipts are strong evidence and are not proof.

**The app lints dirty.** About 150 problems, most of them a rule that objects to the way this codebase writes animation values, which is the pattern the animation library itself documents. The count is stable and known rather than growing unnoticed.

**Sign-out revoking access at Google has never run on a device.** The code is written and tested against a fake. If it is broken, the privacy policy describes something that does not happen.

**A test helper sits untracked in the repository root.** It sends the five Gmail test emails. It is a throwaway tool rather than project code and should be moved or deleted.

**Dead code.** A client-side landing sweep and parts of an auto-refresh path were superseded by the poller and have not been removed. A pending-leg retry reports the wrong trigger name on one path, which is harmless and will confuse whoever reads the events.

**Android is untested.** Permissions are declared and the code paths exist, but this is an iPhone product and nothing has been run on Android. The iOS 26 floor does not apply there, so the surface material would simply be absent.

---

## 9. Native modules and the Swift boundary

**There is still no custom native code.** No iOS or Android project directory exists in the repository; the app is managed and the native projects are generated in the cloud at build time. Every dependency with a native side is an off-the-shelf Expo or React Native package. Nothing here is Swift, Objective-C, Kotlin or Java.

What has changed is that the build is now configured rather than merely generated. A build-properties plugin sets the minimum iOS version, which is the first time this project has reached into the native build at all. That is configuration rather than code, but it is the same boundary being touched.

**What the development build unlocked.** Expo Go is a single pre-built container, so it can only run what its own binary already contains. Moving to a real build changed four things. Push became possible at all, because the build carries a genuine entitlement and its own bundle identifier, and a push token cannot be issued to a project running inside Expo Go. Capabilities driven by build-time configuration plugins became available, which is what the iOS floor now depends on. Custom native modules became possible for the first time. And the app got its own storage sandbox under its own identifier, which is why the watchlist appeared empty on first launch: a genuinely fresh install rather than data loss.

**What is still out of reach, and why.** Mapbox indoor maps, floor level from CoreLocation and the pedometer are all discussed and none is installed. The development build is a precondition for each, not a delivery of any. Indoor maps would need the Mapbox native SDK, its plugin and an access token, and would replace the WebView map rather than sit beside it. Floor level is carried by CoreLocation but not exposed by the location package in use, so it needs a small native module. The pedometer would need the sensors package added.

**Where the boundary sits, and it is a deliberate line.** Everything about what to show and when is JavaScript or Python: the notification decision, the staleness rule, all three datasets, the trip logic, the layover arithmetic, the terminal schematic. Native code is reserved for what the operating system will not expose any other way, which today means sensors, floor level, background execution, and any future Live Activity on the lock screen. That last is the most likely first piece of real Swift, because a flight card on the lock screen is exactly what this product is for and there is no way to build one in JavaScript.

**The map is the one thing that could legitimately go either way.** It runs as a JavaScript library inside a WebView, which keeps it cross-platform and the styling in one file, at the cost of a megabyte at first paint and no native gesture handling. Replacing it with a native SDK is a real decision that has not been made.
