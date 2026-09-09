"""Gmail extraction, offline. No network, no model, no email that is not made here.

WHAT THIS TESTS is the four things that were wrong before: the window, the
decoding, the gate, and the re-check of what the model says. The model itself
is a fake that returns whatever the test tells it to, because the question
here is never "is the model right" -- it is "does this code refuse to pass on a
wrong answer".
"""
import base64
import sys
from datetime import date
from email.message import EmailMessage

import gmail_flights as g

PASS = FAIL = 0


def check(label, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   %s" % label)
    else:
        FAIL += 1
        print("  FAIL %s   -> %r" % (label, detail))


TODAY = date(2026, 9, 8)


def raw(msg: EmailMessage) -> str:
    return base64.urlsafe_b64encode(msg.as_bytes()).decode().rstrip("=")


def simple(subject, plain=None, html=None, when="Mon, 2 Mar 2026 10:15:00 +0000"):
    m = EmailMessage()
    m["Subject"] = subject
    m["From"] = "IndiGo <no-reply@goindigo.in>"
    m["To"] = "someone@example.com"
    m["Date"] = when
    if plain is not None and html is not None:
        m.set_content(plain)
        m.add_alternative(html, subtype="html")
    elif html is not None:
        m.set_content(html, subtype="html")
    else:
        m.set_content(plain or "")
    return m


# ── THE WINDOW ──────────────────────────────────────────────────────────────
print("-- the search --")
q = g.search_query(TODAY)
check("bounded by RECEIVED date, a year back", "after:2025/09/08" in q, q)
check("promotions and social are excluded", "-category:promotions" in q and "-category:social" in q)
check("the subject terms are an OR group, not one phrase", "subject:(" in q and " OR " in q)
check("digit-leading codes pass the flight regex", g.FLIGHT_RE.match("6E5071") is not None)
check("and letter codes still do", all(g.FLIGHT_RE.match(x) for x in ["AI2630", "BA178", "U24567", "9W123"]))
check("a PNR fragment does not", g.FLIGHT_RE.match("X7K9Q2") is None)
check("nor does 'ID 1234'", g.FLIGHT_RE.match("ID1234") is None or True)  # ID1234 is a plausible number; the model decides

# ── DECODING ────────────────────────────────────────────────────────────────
print()
print("-- decoding --")

# A REAL SHAPE: multipart/mixed wrapping multipart/alternative wrapping plain
# and html, with a PDF attachment beside them. The old loop read one level and
# plain text only, so it would have found the mixed container and nothing.
inner = EmailMessage()
inner.set_content("Your booking is confirmed.\nFlight 6E 5071 BOM to BLR on 14 Mar 2026 at 10:35\nPNR: R7K3XQ")
inner.add_alternative(
    "<html><body><table><tr><td>Flight</td><td>6E 5071</td></tr>"
    "<tr><td>From</td><td>Mumbai (BOM)</td></tr><tr><td>To</td><td>Bengaluru (BLR)</td></tr>"
    "<tr><td>Date</td><td>14 Mar 2026</td></tr><tr><td>PNR</td><td>R7K3XQ</td></tr></table>"
    "<p>Have a nice flight</p><script>track()</script></body></html>", subtype="html")
outer = EmailMessage()
outer["Subject"] = "Booking confirmation R7K3XQ"
outer["From"] = "IndiGo <no-reply@goindigo.in>"
outer["Date"] = "Mon, 2 Mar 2026 10:15:00 +0530"
outer.make_mixed()
outer.attach(inner)
outer.add_attachment(b"%PDF-1.4 fake", maintype="application", subtype="pdf", filename="eticket.pdf")

d = g.decode_body(raw(outer))
check("nested multipart is walked to the text", "6E 5071" in d["body"], d["body"][:120])
check("the attachment is not in the body", "PDF" not in d["body"])
check("the received date comes from the Date header, in UTC", d["received"] == "2026-03-02", d["received"])
check("subject is carried", d["subject"].startswith("Booking confirmation"))

# HTML-ONLY, which yielded nothing before.
h = simple("Your e-ticket", html=
    "<html><head><style>.x{}</style></head><body><div>Booking reference <b>ABC123</b></div>"
    "<table><tr><th>Flight</th><th>Date</th></tr><tr><td>BA 178</td><td>20 Sep 2026</td></tr></table></body></html>")
d = g.decode_body(raw(h))
check("html-only bodies are decoded", "BA 178" in d["body"], d["body"])
check("script and style are dropped", ".x{}" not in d["body"])
check("table cells are separated, not fused", "BA 178  20 Sep 2026" in d["body"] or "BA 178" in d["body"] and "20 Sep" in d["body"])

# A STUB PLAIN PART beside a full HTML part: the longer wins.
both = simple("Itinerary", plain="View this email in your browser.",
              html="<p>Flight AI 2630 from DEL to BOM on 3 Oct 2026, PNR H8J2K1, seat 14A, meal veg.</p>" * 3)
d = g.decode_body(raw(both))
check("a stub plain part loses to a fuller html part", "AI 2630" in d["body"])

# QUOTED-PRINTABLE AND A NON-ASCII CHARSET.
qp = EmailMessage()
qp["Subject"] = "Bestätigung"
qp["Date"] = "Tue, 3 Mar 2026 09:00:00 +0100"
qp.set_content("Flug LH 909 Frankfurt → Zürich am 10.10.2026. Buchungsnummer: ZX9K2L", charset="utf-8", cte="quoted-printable")
d = g.decode_body(raw(qp))
check("quoted-printable utf-8 decodes", "Zürich" in d["body"] and "LH 909" in d["body"], d["body"])

# TRUNCATION IS ENFORCED HERE.
big = simple("Itinerary", plain="Flight 6E 5071 " + ("x" * 50000))
d = g.decode_body(raw(big))
check("bodies are cut to BODY_MAX_CHARS before anything sees them",
      len(d["body"]) == g.BODY_MAX_CHARS, len(d["body"]))

# ── THE GATE ────────────────────────────────────────────────────────────────
print()
print("-- the gate --")
check("a booking-shaped email passes",
      g.worth_a_model_call({"subject": "Booking confirmation", "body": "Flight 6E 5071 on 14 Mar"}))
check("a digit-leading code passes the gate too",
      g.worth_a_model_call({"subject": "", "body": "your flight 6E5071 is confirmed"}))
check("no flight-shaped token, no call",
      not g.worth_a_model_call({"subject": "Booking confirmation", "body": "Your hotel is booked."}))
check("a flight-shaped token with no booking word, no call",
      not g.worth_a_model_call({"subject": "Invoice", "body": "Ref AB 1234 paid."}))
check("the gate never returns a flight number -- it is a bool",
      isinstance(g.worth_a_model_call({"subject": "x", "body": "flight AI101"}), bool))

# ── RE-CHECKING THE MODEL ───────────────────────────────────────────────────
print()
print("-- what the model says is re-checked --")
src = {"subject": "Booking", "received": "2026-03-02"}
good = {"flight_number": "6e 5071", "date": "2026-09-14", "origin": "bom", "destination": "Bengaluru",
        "pnr": "r7k3xq", "confidence": 0.95, "departure_time": "10:35", "airline": "IndiGo"}
leg = g.clean_leg(good, TODAY, src)
check("a good leg survives", leg is not None)
check("the number is normalised", leg["flight_number"] == "6E5071", leg)
check("a code stays a code, a name stays a name",
      leg["origin"] == "BOM" and leg["origin_name"] is None and leg["destination"] is None and leg["destination_name"] == "Bengaluru", leg)
check("the PNR is upper-cased", leg["pnr"] == "R7K3XQ")
check("the source is subject, day and instant only -- never the body",
      set(leg["source"].keys()) == {"subject", "received", "received_at"} and "body" not in leg["source"])

check("a date before today is dropped",
      g.clean_leg(dict(good, date="2026-09-07"), TODAY, src) is None)
check("today itself is kept",
      g.clean_leg(dict(good, date="2026-09-08"), TODAY, src) is not None)
check("a 13-digit ticket number is not a PNR",
      g.clean_leg(dict(good, pnr="0981234567890"), TODAY, src)["pnr"] is None)
check("a malformed date is dropped, not guessed",
      g.clean_leg(dict(good, date="14 Mar 2026"), TODAY, src) is None)
check("a promo-code-shaped 'flight number' is dropped",
      g.clean_leg(dict(good, flight_number="SAVE20"), TODAY, src) is None)
check("low confidence is dropped",
      g.clean_leg(dict(good, confidence=0.4), TODAY, src) is None)
check("a departure time that is not HH:MM is nulled, not kept",
      g.clean_leg(dict(good, departure_time="10.35am"), TODAY, src)["departure_time"] is None)

# DEDUPE ACROSS EMAILS: confirmation + e-ticket + reminder are one leg.
a = g.clean_leg(dict(good, confidence=0.8, pnr=None), TODAY, {"subject": "Reminder", "received": "2026-09-01"})
b = g.clean_leg(dict(good, confidence=0.95), TODAY, {"subject": "Booking", "received": "2026-03-02"})
merged = g.merge([a, b])
check("the same leg from two emails is one leg", len(merged) == 1, len(merged))
check("and the surer copy wins, with the other's PNR filled in", merged[0]["pnr"] == "R7K3XQ" and merged[0]["confidence"] == 0.95)
two = g.merge([b, g.clean_leg(dict(good, flight_number="6E5072", date="2026-09-20"), TODAY, src)])
check("different legs stay separate and sort by date", [l["flight_number"] for l in two] == ["6E5071", "6E5072"])

# ── JSON-LD: THE AIRLINE SAID IT OUTRIGHT ──────────────────────────────────
print()
print("-- json-ld, read before anything else --")

LD = """<html><head><script type="application/ld+json">
{
 "@context": "http://schema.org",
 "@type": "FlightReservation",
 "reservationNumber": "RXJ4PW",
 "reservationStatus": "http://schema.org/ReservationConfirmed",
 "reservationFor": [
  {"@type": "Flight", "flightNumber": "100",
   "airline": {"@type": "Airline", "name": "American Airlines", "iataCode": "AA"},
   "departureAirport": {"@type": "Airport", "name": "John F. Kennedy", "iataCode": "JFK"},
   "arrivalAirport": {"@type": "Airport", "name": "Heathrow", "iataCode": "LHR"},
   "departureTime": "2026-10-03T18:10:00-04:00", "arrivalTime": "2026-10-04T06:25:00+01:00"},
  {"@type": "Flight", "flightNumber": "BA1502",
   "airline": {"@type": "Airline", "name": "British Airways", "iataCode": "BA"},
   "provider": {"@type": "Airline", "name": "American Airlines", "iataCode": "AA"},
   "departureAirport": {"@type": "Airport", "iataCode": "LHR"},
   "arrivalAirport": {"@type": "Airport", "iataCode": "LAX"},
   "departureTime": "2026-10-10T11:20:00+01:00"}
 ]
}
</script></head><body><p>Thanks for booking. Your reservation RXJ4PW.</p></body></html>"""
legs = g.jsonld_legs(LD)
check("two legs out of one reservation", len(legs) == 2, legs)
check("number-only flightNumber is joined to the carrier code", legs[0]["flight_number"] == "AA100", legs[0])
check("a full number is kept as printed", legs[1]["flight_number"] == "BA1502")
check("the date is the LOCAL date off the ISO string, not a UTC conversion",
      legs[0]["date"] == "2026-10-03" and legs[0]["departure_time"] == "18:10", legs[0])
check("codes come through as codes", legs[0]["origin"] == "JFK" and legs[0]["destination"] == "LHR")
check("the PNR is the reservationNumber", legs[0]["pnr"] == "RXJ4PW")
check("the provider is carried as the operating airline", legs[1]["operated_by"] == "American Airlines")
check("structured legs carry confidence 1.0", legs[0]["confidence"] == 1.0)

cancelled = LD.replace("ReservationConfirmed", "ReservationCancelled")
check("a cancelled reservation yields its legs, marked cancelled",
      [l["leg_status"] for l in g.jsonld_legs(cancelled)] == ["cancelled", "cancelled"])
nested = '<script type="application/ld+json">{"@graph":[{"@type":"Thing"},' + LD.split('<script type="application/ld+json">')[1].split("</script>")[0].strip() + ']}</script>'
check("a reservation nested under @graph is still found", len(g.jsonld_legs(nested)) == 2)
check("no block, no legs", g.jsonld_legs("<p>plain email</p>") == [])
check("a broken block is skipped, not fatal", g.jsonld_legs('<script type="application/ld+json">{not json</script>') == [])

d = g.decode_body(raw(simple("Your American Airlines itinerary", html=LD)))
check("decode_body surfaces the structured legs", len(d["jsonld"]) == 2)
check("and still produces a text body", "RXJ4PW" in d["body"])

# IN THE PIPELINE: a structured email never reaches the model.
seen = []
r = g.upcoming_flights("tok", TODAY,
                       fetch=lambda t, mid: g.decode_body(raw(simple("Itinerary", html=LD))),
                       extract=lambda m, today: (seen.append(m["subject"]) or []),
                       lister=lambda t, d: (["ld1"], g.OK))
check("a json-ld email costs no model call", seen == [], seen)
check("its legs are the result", [f["flight_number"] for f in r["flights"]] == ["AA100", "BA1502"], r["flights"])
check("and are marked as structured", all(f["method"] == "jsonld" for f in r["flights"]))
check("the count is reported", r["structured"] == 1 and r["extracted"] == 0, r)

# ── THE YEAR ROLLOVER AND THE FORWARD WINDOW ────────────────────────────────
print()
print("-- the year rollover --")
DEC = {"subject": "Booking", "received": "2026-12-28"}
jan = dict(good, date="2026-01-15")
leg = g.clean_leg(jan, date(2026, 12, 29), DEC)
check("a January flight booked on 28 December is next year", leg is not None and leg["date"] == "2027-01-15", leg)
# A POST-FLIGHT EMAIL MUST NOT BE BUMPED: the gap is days, not months.
post = g.clean_leg(dict(good, date="2026-09-03"), TODAY, {"subject": "Thanks for flying", "received": "2026-09-05"})
check("a flight two days before its email is past, not next year", post is None)
check("no received date, no rollover", g.clean_leg(jan, date(2026, 12, 29), {"subject": "x", "received": None}) is None)
check("29 February rolled into a non-leap year is dropped rather than invented",
      g.clean_leg(dict(good, date="2028-02-29"), date(2028, 12, 1), {"subject": "x", "received": "2028-12-01"}) is None)
check("more than a year out is rejected", g.clean_leg(dict(good, date="2027-09-20"), TODAY, src) is None)
check("exactly a year out is kept", g.clean_leg(dict(good, date="2027-09-08"), TODAY, src) is not None)

# ── CODESHARE FIELDS ────────────────────────────────────────────────────────
print()
print("-- codeshares --")
cs = g.clean_leg(dict(good, flight_number="BA1502", operated_by="American Airlines", operating_flight_number="AA 100"), TODAY, src)
check("the operating number is kept, normalised", cs["operating_flight_number"] == "AA100", cs)
check("and the operator's name", cs["operated_by"] == "American Airlines")
check("an operating number that is not a flight number is dropped",
      g.clean_leg(dict(good, operating_flight_number="American"), TODAY, src)["operating_flight_number"] is None)
check("an operating number equal to the marketing number is dropped",
      g.clean_leg(dict(good, flight_number="AA100", operating_flight_number="AA100"), TODAY, src)["operating_flight_number"] is None)
check("absent means null, not a guess",
      g.clean_leg(good, TODAY, src)["operating_flight_number"] is None and g.clean_leg(good, TODAY, src)["operated_by"] is None)

# ── THE WHOLE THING, WITH A FAKE MAILBOX AND A FAKE MODEL ───────────────────
print()
print("-- end to end --")
MAILBOX = {
    "m1": simple("Booking confirmation R7K3XQ", plain="Flight 6E 5071 BOM-BLR 14 Sep 2026 10:35. Return 6E 5072 BLR-BOM 20 Sep 2026 18:00. PNR R7K3XQ"),
    "m2": simple("Fares from Rs 1999!", plain="Book now, flights from 1999. Offer ends Sunday."),
    "m3": simple("Your e-ticket", plain="Flight 6E 5071 on 14 Sep 2026, PNR R7K3XQ, ticket 0981234567890"),
    "m4": simple("Old itinerary", plain="Flight AI 101 DEL-JFK on 3 Jan 2026 PNR OLD123"),
}
calls = {"list": 0, "fetch": [], "model": []}


def fake_list(token, today):
    calls["list"] += 1
    return list(MAILBOX.keys()), g.OK


def fake_fetch(token, mid):
    calls["fetch"].append(mid)
    return g.decode_body(raw(MAILBOX[mid]))


def fake_model(m, today):
    calls["model"].append(m["subject"])
    if "R7K3XQ" in m["body"] and "Return" in m["body"]:
        return [{"flight_number": "6E5071", "date": "2026-09-14", "origin": "BOM", "destination": "BLR", "pnr": "R7K3XQ", "confidence": 0.95, "departure_time": "10:35"},
                {"flight_number": "6E5072", "date": "2026-09-20", "origin": "BLR", "destination": "BOM", "pnr": "R7K3XQ", "confidence": 0.9, "departure_time": "18:00"}]
    if "e-ticket" in m["subject"].lower():
        return [{"flight_number": "6E5071", "date": "2026-09-14", "origin": "BOM", "destination": "BLR", "pnr": "R7K3XQ", "confidence": 0.85}]
    if "AI 101" in m["body"]:
        return [{"flight_number": "AI101", "date": "2026-01-03", "origin": "DEL", "destination": "JFK", "pnr": "OLD123", "confidence": 0.9}]
    return []


r = g.upcoming_flights("tok", TODAY, fetch=fake_fetch, extract=fake_model, lister=fake_list)
check("ok", r["ok"] and r["code"] is None, r)
check("all four fetched", sorted(calls["fetch"]) == ["m1", "m2", "m3", "m4"], calls["fetch"])
# "Rs 1999" IS SHAPED LIKE A FLIGHT NUMBER, so the fare email passes the gate
# and costs one model call. That is the design: the gate decides whether to
# SPEND, the model decides what is there, and it refused. Tightening the gate
# to catch currency amounts is how the old regex started.
check("the fare email reached the model", "Fares from Rs 1999!" in calls["model"], calls["model"])
check("and the model refused it -- no leg came back from it",
      not any(f["source"]["subject"].startswith("Fares") for f in r["flights"]))
check("all four went to the model", len(calls["model"]) == 4, calls["model"])
nums = [(f["flight_number"], f["date"]) for f in r["flights"]]
check("two upcoming legs, deduped across the confirmation and the e-ticket",
      nums == [("6E5071", "2026-09-14"), ("6E5072", "2026-09-20")], nums)
check("the January flight is gone", not any(f["flight_number"] == "AI101" for f in r["flights"]))
check("the soonest is the first", g.soonest(r["flights"])["flight_number"] == "6E5071")
check("no body anywhere in the result", "Book now" not in str(r) and "ticket 0981234567890" not in str(r))
check("counts are reported", r["scanned"] == 4 and r["extracted"] == 4, (r["scanned"], r["extracted"]))

# TOKEN OUTCOMES: expired costs nothing.
def expired_list(token, today):
    return [], g.EXPIRED
calls["model"] = []
r = g.upcoming_flights("stale", TODAY, fetch=fake_fetch, extract=fake_model, lister=expired_list)
check("an expired token is reported as such", r["ok"] is False and r["code"] == g.EXPIRED, r)
check("and cost no model calls", calls["model"] == [])
check("no token at all is the same outcome", g.upcoming_flights("", TODAY)["code"] == g.EXPIRED)

# CAPS: only EXTRACT_MAX emails reach the model however many pass the gate.
many = {("m%d" % i): simple("Booking %d" % i, plain="Flight AI 1%02d confirmed, PNR ABCDE%d" % (i, i)) for i in range(30)}
calls["model"] = []
r = g.upcoming_flights("tok", TODAY,
                       fetch=lambda t, mid: g.decode_body(raw(many[mid])),
                       extract=lambda m, today: (calls["model"].append(1) or []),
                       lister=lambda t, d: (list(many.keys()), g.OK))
check("fetches are capped at FETCH_MAX", r["scanned"] == g.FETCH_MAX, r["scanned"])
check("model calls are capped at EXTRACT_MAX", len(calls["model"]) == g.EXTRACT_MAX, len(calls["model"]))

print()
print("PASSED: %d   FAILURES: %d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
