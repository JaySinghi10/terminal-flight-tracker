"""The sender, offline. No bucket, no Expo, no notification to anybody.

WHAT THIS IS ACTUALLY TESTING is the three things that can hurt somebody: a
message that goes twice, a message that never goes at all, and a message that
goes to the wrong reader with the wrong words. Everything else in dispatch.py
is plumbing between those.

The network is a function argument, so `post` here is a list of calls and a
canned answer. The two stores are module attributes, replaced with dictionaries.
"""
import sys
from datetime import datetime, timedelta, timezone

import dispatch
import notify

PASS = FAIL = 0


def check(label, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   %s" % label)
    else:
        FAIL += 1
        print("  FAIL %s   -> %r" % (label, detail))


NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)
DAY = "2026-09-09"


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


# ── FIXTURES ────────────────────────────────────────────────────────────────

def dto(number="AI505", iata="DEL", city="Delhi", when="9:30 PM", airline="Air India"):
    # `when` IS THE DEPARTURE, because that is what the subject ladder reads:
    # notify._facts maps scheduled_departure from departure.scheduled, and
    # subject() disambiguates on it. Putting it on the arrival here would make
    # the fixture and the code disagree without either being wrong.
    return {
        "flight_number": number, "flight_date": DAY, "airline": airline,
        "departure": {"iata": "BOM", "city": "Mumbai", "scheduled": when},
        "arrival": {"iata": iata, "city": city, "scheduled": "11:45 PM"},
    }


def msg(number="AI505", kind=notify.GATE, key="k1", deliver_after=None,
        iata="DEL", city="Delhi", when="9:30 PM", airline="Air India"):
    # STRAIGHT FROM _facts, with nothing overridden. A message in the real
    # outbox is built this way, so the time the envelope reads and the time the
    # reader index reads come from the same field by construction.
    facts = notify._facts(dto(number, iata, city, when=when, airline=airline))
    # A SUPERSET OF WHAT EVERY RENDERER READS. notify.render reaches into
    # `values` by key and raises on a missing one, so a fixture carrying only a
    # gate can render a gate message and nothing else. Every field any kind
    # needs is here, which is what lets one fixture stand in for all fourteen.
    facts.update({"key": key, "kind": kind, "at": iso(NOW),
                  "deliver_after": deliver_after,
                  "values": {"gate": "A12", "was": "B7", "belt": "5",
                             "terminal": "2", "by": 30, "due": "11:45 PM",
                             "time": "11:40 PM", "tz": "IST", "next": None,
                             "searching": False, "elsewhere": False}})
    return facts


def state(number="AI505", outbox=(), sent=None, flight_dto=None):
    return {"flight_number": number, "flight_date": DAY,
            "dto": flight_dto or dto(number),
            "notify": {"outbox": list(outbox)},
            "sent": dict(sent or {})}


def device(did="dev-1", token="ExponentPushToken[aaa]", owned=True):
    return {"device_id": did, "push_token": token, "platform": "ios", "owned": owned}


def watched(number="AI505", devices=None):
    return {"flight_number": number, "flight_date": DAY,
            "devices": list(devices or [device()])}


class World:
    """The two stores and the network, all fake, all inspectable."""

    def __init__(self, rows, states):
        self.rows = rows
        self.states = {(d["flight_number"], d["flight_date"]): d for d in states}
        self.calls = []
        self.forgotten = []
        self.reply = None
        self.readable = True

    # -- store / pollstate ------------------------------------------------
    def watched_flights(self):
        return self.rows if self.readable else None

    def read_state(self, number, day):
        return (self.states.get((number, day)), 1)

    def mutate_state(self, number, day, apply_fn):
        doc = self.states.get((number, day))
        new = apply_fn(doc)
        if new is not None:
            self.states[(number, day)] = new
        return True

    def forget_push_token(self, token):
        self.forgotten.append(token)
        return {"ok": True, "removed": 1, "error": None}

    # -- the wire ---------------------------------------------------------
    def post(self, url, payload):
        self.calls.append((url, payload))
        if callable(self.reply):
            return self.reply(url, payload)
        return self.reply

    def install(self):
        dispatch.store.watched_flights = self.watched_flights
        dispatch.store.forget_push_token = self.forget_push_token
        dispatch.pollstate.read_state = self.read_state
        dispatch.pollstate.mutate_state = self.mutate_state
        return self

    def slots(self, number="AI505"):
        return (self.states.get((number, DAY)) or {}).get("sent") or {}

    def sends(self):
        return [p for u, p in self.calls if u == dispatch.SEND_URL]

    def receipts(self):
        return [p for u, p in self.calls if u == dispatch.RECEIPTS_URL]


def ok_tickets(n, first="T0"):
    return {"data": [{"status": "ok", "id": "%s-%d" % (first, i)} for i in range(n)]}


# ── ONE MESSAGE, ONE READER ─────────────────────────────────────────────────
print("-- the ordinary case --")
w = World([watched()], [state(outbox=[msg()])]).install()
w.reply = ok_tickets(1)
out = dispatch.run_once(now=NOW, post=w.post)
sent = w.sends()
check("one send call", len(sent) == 1 and len(sent[0]) == 1, sent)
env = sent[0][0] if sent and sent[0] else {}
check("addressed to the device's token", env.get("to") == "ExponentPushToken[aaa]", env.get("to"))
check("the title leads with the destination", env.get("title") == "Your flight to Delhi", env.get("title"))
check("the body is notify's sentence", "gate" in (env.get("body") or "").lower(), env.get("body"))
check("the tap target is the flight", (env.get("data") or {}).get("screen") == "flight", env.get("data"))
check("reported as sent", out.get("sent") == 1, out)
slot = list(w.slots().values())[0] if w.slots() else {}
check("the ticket is recorded against the slot", slot.get("ticket") == "T0-0", slot)
check("and a sent time with it", bool(slot.get("sent_at")), slot)

# ── NEVER TWICE ─────────────────────────────────────────────────────────────
print("-- never twice --")
w2 = World([watched()], [state(outbox=[msg()], sent=w.slots())]).install()
w2.reply = ok_tickets(1)
out2 = dispatch.run_once(now=NOW + timedelta(minutes=1), post=w2.post)
check("a sent message is not sent again", w2.sends() == [] and out2.get("sent") == 0, w2.sends())

print("-- a claim that never came back --")
stale = {"k1|dev-1": {"claimed_at": iso(NOW - timedelta(minutes=30)),
                      "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w3 = World([watched()], [state(outbox=[msg()], sent=stale)]).install()
w3.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w3.post)
check("a stale claim is retried", len(w3.sends()) == 1, w3.sends())

fresh = {"k1|dev-1": {"claimed_at": iso(NOW - timedelta(minutes=2)),
                      "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w4 = World([watched()], [state(outbox=[msg()], sent=fresh)]).install()
w4.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w4.post)
check("a fresh claim is left alone", w4.sends() == [], w4.sends())

# ── THE NIGHT DEFERRAL ──────────────────────────────────────────────────────
print("-- deliver_after --")
later = msg(deliver_after=iso(NOW + timedelta(hours=5)))
w5 = World([watched()], [state(outbox=[later])]).install()
w5.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w5.post)
check("a deferred message waits", w5.sends() == [], w5.sends())

w6 = World([watched()], [state(outbox=[later])]).install()
w6.reply = ok_tickets(1)
dispatch.run_once(now=NOW + timedelta(hours=5, minutes=1), post=w6.post)
check("and goes once its time comes", len(w6.sends()) == 1, w6.sends())

# AN HOUR LATER IT NO LONGER DOES, and that is the two rules meeting rather than
# either misbehaving: deliver_after says the earliest it may go, STALE_AFTER
# says the latest, and a gate is worth thirty minutes from the former.
w6b = World([watched()], [state(outbox=[later])]).install()
w6b.reply = ok_tickets(1)
dispatch.run_once(now=NOW + timedelta(hours=6), post=w6b.post)
check("and stops going once it is too late", w6b.sends() == [], w6b.sends())

# ── A DEAD TOKEN ────────────────────────────────────────────────────────────
print("-- a dead token --")
w7 = World([watched()], [state(outbox=[msg()])]).install()
w7.reply = {"data": [{"status": "error", "message": "gone",
                      "details": {"error": "DeviceNotRegistered"}}]}
out7 = dispatch.run_once(now=NOW, post=w7.post)
check("the token is dropped from the watch store",
      w7.forgotten == ["ExponentPushToken[aaa]"], w7.forgotten)
check("counted", out7.get("dead_tokens") == 1, out7)
slot7 = list(w7.slots().values())[0] if w7.slots() else {}
check("the slot gives up rather than retrying", slot7.get("gave_up") is True, slot7)

w8 = World([watched()], [state(outbox=[msg()], sent=w7.slots())]).install()
w8.reply = ok_tickets(1)
dispatch.run_once(now=NOW + timedelta(hours=2), post=w8.post)
check("and a given-up slot is never retried", w8.sends() == [], w8.sends())

print("-- a transient error --")
w9 = World([watched()], [state(outbox=[msg()])]).install()
w9.reply = {"data": [{"status": "error", "message": "slow down",
                      "details": {"error": "MessageRateExceeded"}}]}
dispatch.run_once(now=NOW, post=w9.post)
check("the token is kept", w9.forgotten == [], w9.forgotten)
slot9 = list(w9.slots().values())[0] if w9.slots() else {}
check("the claim is cleared so the next pass retries at once",
      "claimed_at" not in slot9 and not slot9.get("gave_up"), slot9)

w10 = World([watched()], [state(outbox=[msg()], sent=w9.slots())]).install()
w10.reply = ok_tickets(1)
dispatch.run_once(now=NOW + timedelta(minutes=1), post=w10.post)
check("and it does", len(w10.sends()) == 1, w10.sends())

# ── THE SUBJECT LADDER ──────────────────────────────────────────────────────
print("-- the subject ladder --")
one = watched("AI505", [device()])
two = watched("6E123", [device()])
states_two = [state("AI505", outbox=[msg("AI505", key="ka")]),
              state("6E123", outbox=[], flight_dto=dto("6E123", when="7:15 AM",
                                                       airline="IndiGo"))]
w11 = World([one, two], states_two).install()
w11.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w11.post)
t11 = w11.sends()[0][0]["title"] if w11.sends() else ""
check("two flights to the same city: the time joins",
      t11 == "Your 9:30 PM flight to Delhi", t11)

# same city AND same clock time on both: the airline has to separate them
states_same = [state("AI505", outbox=[msg("AI505", key="kb")]),
               state("6E123", outbox=[], flight_dto=dto("6E123", when="9:30 PM",
                                                        airline="IndiGo"))]
w12 = World([one, two], states_same).install()
w12.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w12.post)
t12 = w12.sends()[0][0]["title"] if w12.sends() else ""
check("same city and same time: the airline joins",
      t12 == "Your 9:30 PM Air India flight to Delhi", t12)

print("-- meeting the flight --")
w13 = World([watched("AI505", [device(owned=False)])],
            [state(outbox=[msg()])]).install()
w13.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w13.post)
t13 = w13.sends()[0][0]["title"] if w13.sends() else ""
check("a person meeting it hears about the origin",
      t13 == "The flight from Mumbai", t13)

print("-- two readers, one flight --")
pair = watched("AI505", [device("dev-1", "ExponentPushToken[aaa]"),
                         device("dev-2", "ExponentPushToken[bbb]", owned=False)])
w14 = World([pair], [state(outbox=[msg()])]).install()
w14.reply = ok_tickets(2)
dispatch.run_once(now=NOW, post=w14.post)
batch = w14.sends()[0] if w14.sends() else []
check("one call carries both", len(batch) == 2, batch)
check("each hears it their own way",
      {e["title"] for e in batch} == {"Your flight to Delhi", "The flight from Mumbai"},
      [e["title"] for e in batch])
check("two slots, one per device", len(w14.slots()) == 2, w14.slots())

# ── RECEIPTS ────────────────────────────────────────────────────────────────
print("-- receipts --")
young = {"k1|dev-1": {"sent_at": iso(NOW - timedelta(minutes=5)), "ticket": "T-1",
                      "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w15 = World([watched()], [state(outbox=[msg()], sent=young)]).install()
w15.reply = {"data": {}}
dispatch.run_once(now=NOW, post=w15.post)
check("a young ticket is not asked about", w15.receipts() == [], w15.receipts())

ripe = {"k1|dev-1": {"sent_at": iso(NOW - timedelta(minutes=20)), "ticket": "T-1",
                     "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w16 = World([watched()], [state(outbox=[msg()], sent=ripe)]).install()
w16.reply = {"data": {"T-1": {"status": "ok"}}}
out16 = dispatch.run_once(now=NOW, post=w16.post)
check("a ripe ticket is asked about",
      w16.receipts() == [{"ids": ["T-1"]}], w16.receipts())
check("a good receipt is recorded", out16.get("receipts_ok") == 1, out16)
check("and not asked again",
      bool((w16.slots().get("k1|dev-1") or {}).get("receipt_at")), w16.slots())

w17 = World([watched()], [state(outbox=[msg()], sent=ripe)]).install()
w17.reply = {"data": {"T-1": {"status": "error", "message": "gone",
                              "details": {"error": "DeviceNotRegistered"}}}}
out17 = dispatch.run_once(now=NOW, post=w17.post)
check("a dead token found in a receipt is dropped too",
      w17.forgotten == ["ExponentPushToken[aaa]"], w17.forgotten)
check("counted once", out17.get("dead_tokens") == 1, out17)

old = {"k1|dev-1": {"sent_at": iso(NOW - timedelta(hours=30)), "ticket": "T-1",
                    "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w18 = World([watched()], [state(outbox=[msg()], sent=old)]).install()
w18.reply = {"data": {}}
dispatch.run_once(now=NOW, post=w18.post)
check("a ticket nobody answers for is eventually closed",
      (w18.slots().get("k1|dev-1") or {}).get("receipt_status") == "expired",
      w18.slots())

print("-- receipts come before sends --")
both = {"k1|dev-1": {"sent_at": iso(NOW - timedelta(minutes=20)), "ticket": "T-1",
                     "token": "ExponentPushToken[aaa]", "device_id": "dev-1"}}
w19 = World([watched()], [state(outbox=[msg(), msg(key="k2")], sent=both)]).install()
w19.reply = lambda url, payload: ({"data": {"T-1": {"status": "ok"}}}
                                  if url == dispatch.RECEIPTS_URL else ok_tickets(1))
dispatch.run_once(now=NOW, post=w19.post)
check("the receipt call is first",
      w19.calls and w19.calls[0][0] == dispatch.RECEIPTS_URL,
      [u for u, _p in w19.calls])

# ── BATCHING ────────────────────────────────────────────────────────────────
print("-- batching --")
many = watched("AI505", [device("dev-%d" % i, "ExponentPushToken[t%d]" % i)
                         for i in range(250)])
w20 = World([many], [state(outbox=[msg()])]).install()
w20.reply = lambda url, payload: ok_tickets(len(payload))
dispatch.run_once(now=NOW, post=w20.post)
sizes = [len(p) for p in w20.sends()]
check("split at a hundred", sizes == [100, 100, 50], sizes)
check("the batch size is Expo's documented ceiling", dispatch.SEND_BATCH == 100)

# ── THE STORE ITSELF ────────────────────────────────────────────────────────
print("-- the store --")
w21 = World([], []).install()
w21.readable = False
out21 = dispatch.run_once(now=NOW, post=w21.post)
check("an unreadable watch store is not an empty one",
      out21.get("ok") is False and w21.calls == [], out21)

w22 = World([], []).install()
w22.reply = ok_tickets(0)
out22 = dispatch.run_once(now=NOW, post=w22.post)
check("nobody watching is a quiet success",
      out22.get("ok") is True and w22.calls == [], out22)

print("-- a flight with no outbox --")
w23 = World([watched()], [state(outbox=[])]).install()
w23.reply = ok_tickets(0)
dispatch.run_once(now=NOW, post=w23.post)
check("nothing to say means no call at all", w23.calls == [], w23.calls)

print("-- a device with no token --")
w24 = World([watched("AI505", [device(token=None)])],
            [state(outbox=[msg()])]).install()
w24.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w24.post)
check("a reader who never granted permission is skipped", w24.calls == [], w24.calls)

print("-- the delivery record is bounded --")
w25 = World([watched()], [state(outbox=[msg()],
                               sent={"gone|dev-1": {"sent_at": iso(NOW)}})]).install()
w25.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w25.post)
check("a slot whose message left the outbox is pruned",
      "gone|dev-1" not in w25.slots(), w25.slots())
check("and the live one is kept", "k1|dev-1" in w25.slots(), w25.slots())

print("-- an old state object written before this module existed --")
w26 = World([watched()], [state(outbox=[msg()])]).install()
w26.states[("AI505", DAY)]["sent"] = []       # blank_state's original shape
w26.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w26.post)
check("a list `sent` reads as empty rather than breaking",
      len(w26.sends()) == 1, w26.sends())

# -- TOO OLD TO BE WORTH SENDING --------------------------------------------
# The first live pass drained a backlog and delivered a six-hour-old
# cancellation. This is the rule written after it.
print("-- stale --")


def aged(hours=0, minutes=0, **kw):
    m = msg(**kw)
    m["at"] = iso(NOW - timedelta(hours=hours, minutes=minutes))
    return m


w30 = World([watched()], [state(outbox=[aged(hours=6, kind=notify.CANCELLED)])]).install()
w30.reply = ok_tickets(1)
out30 = dispatch.run_once(now=NOW, post=w30.post)
check("a six-hour-old cancellation is not sent", w30.sends() == [], w30.sends())
check("it is counted as dropped", out30.get("dropped_stale") == 1, out30)
slot30 = list(w30.slots().values())[0] if w30.slots() else {}
check("the reason is recorded", slot30.get("drop_reason") == "stale", slot30)
check("with the kind and how late it was",
      slot30.get("kind") == notify.CANCELLED and slot30.get("age_s") == 6 * 3600, slot30)

w31 = World([watched()], [state(outbox=[aged(hours=1, kind=notify.CANCELLED)])]).install()
w31.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w31.post)
check("an hour-old cancellation still goes", len(w31.sends()) == 1, w31.sends())

print("-- a dropped slot is final --")
w32 = World([watched()], [state(outbox=[aged(hours=6, kind=notify.CANCELLED)],
                               sent=w30.slots())]).install()
w32.reply = ok_tickets(1)
out32 = dispatch.run_once(now=NOW + timedelta(minutes=1), post=w32.post)
check("it is never reconsidered, not even to re-drop it",
      w32.sends() == [] and out32.get("dropped_stale") == 0, out32)

print("-- each kind has its own life --")
for kind, mins, should_send in [
    (notify.GATE, 20, True), (notify.GATE, 40, False),
    (notify.BELT, 40, True), (notify.BELT, 50, False),
    (notify.DELAY, 50, True), (notify.DELAY, 70, False),
    (notify.TERMINAL, 110, True), (notify.TERMINAL, 130, False),
]:
    wk = World([watched()], [state(outbox=[aged(minutes=mins, kind=kind)])]).install()
    wk.reply = ok_tickets(1)
    dispatch.run_once(now=NOW, post=wk.post)
    check("%-17s at %3d min -> %s" % (kind, mins, "sent" if should_send else "dropped"),
          (len(wk.sends()) == 1) == should_send, wk.sends())

print("-- an unrecognised kind errs towards silence --")
w33 = World([watched()], [state(outbox=[aged(minutes=90, kind="something_new")])]).install()
w33.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w33.post)
check("it takes the default life", w33.sends() == [], w33.sends())
check("and the default is an hour", dispatch.STALE_DEFAULT == timedelta(hours=1))

print("-- a deferred message is not stale on arrival --")
# Written at 02:00 and held to 07:00 for the night. It is five hours old the
# moment it becomes due, and dropping it would defeat the deferral notify gave
# it on purpose.
night = msg(kind=notify.CANCELLED)
night["at"] = iso(NOW - timedelta(hours=5))
night["deliver_after"] = iso(NOW - timedelta(minutes=1))
w34 = World([watched()], [state(outbox=[night])]).install()
w34.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w34.post)
check("the clock starts at deliver_after, not at", len(w34.sends()) == 1, w34.sends())

night2 = dict(night)
night2["deliver_after"] = iso(NOW - timedelta(hours=3))
w35 = World([watched()], [state(outbox=[night2])]).install()
w35.reply = ok_tickets(1)
dispatch.run_once(now=NOW, post=w35.post)
check("but it is not exempt for ever", w35.sends() == [], w35.sends())

print("-- every kind notify can emit has a life --")
KINDS = [getattr(notify, n) for n in dir(notify)
         if n.isupper() and isinstance(getattr(notify, n), str)
         and getattr(notify, n).replace("_", "").isalpha()
         and getattr(notify, n).islower()]
missing = sorted(k for k in KINDS if k not in dispatch.STALE_AFTER)
check("no kind falls through to the default by accident", missing == [], missing)

print("-- a message that cannot be rendered --")
# notify's renderers read `values` by key. A message written by an older notify,
# or by a kind whose shape has changed, raises rather than returning a sentence.
# Unguarded that would leave _plan, leave send_due, and end the pass -- so one
# malformed row in one flight's outbox would stop delivery for EVERY flight,
# every minute, until somebody noticed.
broken = msg(kind=notify.TERMINAL)
broken["values"] = {}
w36 = World([watched("AI505"), watched("6E123")],
            [state("AI505", outbox=[broken]),
             state("6E123", outbox=[msg("6E123", key="ok1")])]).install()
w36.reply = ok_tickets(1)
out36 = dispatch.run_once(now=NOW, post=w36.post)
check("the pass survives it", out36.get("ok") is True, out36)
check("the other flight is still delivered", len(w36.sends()) == 1, w36.sends())
check("and the bad one is recorded, not retried for ever",
      (list(w36.slots("AI505").values())[0] if w36.slots("AI505") else {}).get("drop_reason")
      == "unrenderable", w36.slots("AI505"))

print("\nPASSED: %d   FAILURES: %d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
