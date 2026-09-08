"""Realistic airline emails, made here so extraction can be tested without a
real inbox. Every one is synthetic: the names, PNRs and ticket numbers are
invented, and the layouts are modelled on the airlines' actual formats.

Run it to (re)generate the .eml files beside it, then run_fixtures.py to push
each one through gmail_flights with the real model.
"""
import os
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, msg):
    with open(os.path.join(HERE, name), "wb") as f:
        f.write(msg.as_bytes())


def base(subject, sender, date):
    m = EmailMessage()
    m["Subject"] = subject
    m["From"] = sender
    m["To"] = "Jay Singhi <jay@example.com>"
    m["Date"] = date
    return m


# ── 1. INDIGO: HTML ONLY, NO JSON-LD, DIGIT-LEADING NUMBER ──────────────────
# IndiGo's confirmation is one big HTML table: the "6E" in a cell of its own,
# the number beside it, a fare breakdown in INR further down, and a promo
# strip at the bottom. No plain-text alternative at all.
indigo = base("Booking Confirmation - PNR R7K3XQ | 6E 5071 | Mumbai - Bengaluru",
              "IndiGo <no-reply@goindigo.in>", "Mon, 02 Mar 2026 15:45:10 +0530")
indigo.set_content("""<!DOCTYPE html><html><head><meta charset="utf-8"><title>IndiGo</title>
<style>body{font-family:Arial} .h{background:#001B94;color:#fff}</style></head>
<body>
<table width="600" cellpadding="8"><tr class="h"><td colspan="4">Your booking is confirmed</td></tr>
<tr><td>PNR</td><td><b>R7K3XQ</b></td><td>Booking date</td><td>02 Mar 2026</td></tr>
<tr><td colspan="4">Dear Jay Singhi, thank you for choosing IndiGo.</td></tr>
<tr class="h"><td>Flight</td><td>From</td><td>To</td><td>Date</td></tr>
<tr><td><b>6E</b> 5071</td><td>Mumbai (BOM)<br>Terminal 2<br>10:35</td><td>Bengaluru (BLR)<br>Terminal 1<br>12:20</td><td>Sat, 14 Sep 2026</td></tr>
<tr><td colspan="4">Passenger: MR JAY SINGHI &nbsp; Seat: 14A &nbsp; Meal: Veg</td></tr>
<tr><td colspan="4">Fare INR 4,999 &nbsp; Convenience fee INR 350 &nbsp; Total INR 5,349</td></tr>
<tr><td colspan="4">Web check-in opens 48 hours before departure. Carry a valid photo ID.</td></tr>
<tr><td colspan="4" style="color:#888">6E Rewards: earn 500 points on this booking. Hotels from INR 1,999 on 6E Add-ons.</td></tr>
</table></body></html>""", subtype="html")
write("01_indigo_html_only.eml", indigo)

# ── 2. LUFTHANSA WITH JSON-LD ───────────────────────────────────────────────
# Lufthansa Group emails carry a schema.org FlightReservation block with the
# number alone in flightNumber and the carrier in airline.iataCode.
lh = base("Your booking confirmation Q8T4LM: Frankfurt - Bengaluru",
          "Lufthansa <noreply@lufthansa.com>", "Sat, 20 Jun 2026 09:12:00 +0200")
lh.set_content("""Booking code Q8T4LM
LH 759 Frankfurt (FRA) 05 Oct 2026 13:35 - Bengaluru (BLR) 06 Oct 2026 01:50
Passenger: Singhi, Jay
""")
lh.add_alternative("""<html><head>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"FlightReservation",
 "reservationNumber":"Q8T4LM","reservationStatus":"http://schema.org/ReservationConfirmed",
 "underName":{"@type":"Person","name":"Jay Singhi"},
 "reservationFor":{"@type":"Flight","flightNumber":"759",
   "airline":{"@type":"Airline","name":"Lufthansa","iataCode":"LH"},
   "departureAirport":{"@type":"Airport","name":"Frankfurt Airport","iataCode":"FRA"},
   "departureTime":"2026-10-05T13:35:00+02:00",
   "arrivalAirport":{"@type":"Airport","name":"Kempegowda International Airport","iataCode":"BLR"},
   "arrivalTime":"2026-10-06T01:50:00+05:30"}}
</script></head>
<body><h2>Thank you for your booking</h2><p>Booking code <b>Q8T4LM</b></p>
<table><tr><td>LH 759</td><td>FRA 05 Oct 2026 13:35</td><td>BLR 06 Oct 2026 01:50</td><td>Boeing 747-8</td></tr></table>
<p>Ticket number 220-4432198877</p></body></html>""", subtype="html")
write("02_lufthansa_jsonld.eml", lh)

# ── 3a. BA CODESHARE, OPERATOR NAMED, NO OPERATING NUMBER ───────────────────
ba1 = base("Your booking confirmation ZK9P2Q", "British Airways <no-reply@britishairways.com>",
           "Sat, 15 Aug 2026 18:02:00 +0100")
ba1.set_content("""Booking reference: ZK9P2Q

Flight BA1502  Operated by American Airlines
London Heathrow (LHR) Terminal 3  12 Nov 2026 16:45
Los Angeles (LAX) Terminal 4     12 Nov 2026 20:10
Passenger: Mr Jay Singhi   Class: Economy (O)
e-ticket 125-2231998877
""")
ba1.add_alternative("""<html><body><p>Booking reference <b>ZK9P2Q</b></p>
<table><tr><td><b>BA1502</b></td><td>LHR T3 12 Nov 2026 16:45</td><td>LAX T4 12 Nov 2026 20:10</td></tr>
<tr><td colspan="3" style="font-size:11px;color:#666">Operated by American Airlines. Check in with the operating carrier.</td></tr></table>
<p>e-ticket 125-2231998877</p></body></html>""", subtype="html")
write("03a_ba_codeshare_no_operating_number.eml", ba1)

# ── 3b. BA CODESHARE, OPERATING NUMBER IN THE FINE PRINT ────────────────────
ba2 = base("Your booking confirmation ZK9P2Q", "British Airways <no-reply@britishairways.com>",
           "Sat, 15 Aug 2026 18:02:00 +0100")
ba2.set_content("""Booking reference: ZK9P2Q

Flight BA1502
London Heathrow (LHR) Terminal 3  12 Nov 2026 16:45
Los Angeles (LAX) Terminal 4     12 Nov 2026 20:10
Operated by American Airlines as AA 100.
Passenger: Mr Jay Singhi   Class: Economy (O)
""")
write("03b_ba_codeshare_with_operating_number.eml", ba2)

# ── 4. THREE LEGS, TWO LAYOVERS: SFO -> CPH -> BOM -> IDR ───────────────────
# An agency itinerary, the way Trip.com or MakeMyTrip lay one out: one agency
# reference, one airline PNR, three segments across two carriers, and an
# overnight crossing a date line so the second leg lands the next day.
agency = base("Trip.com | E-ticket issued | Booking 8817729043 | SFO-IDR 01 Dec",
              "Trip.com <noreply@trip.com>", "Tue, 01 Sep 2026 11:30:00 +0800")
agency.set_content("""Your e-ticket has been issued. Booking number 8817729043. Airline PNR: H8J2K1

Segment 1  SK 936   Scandinavian Airlines
  San Francisco (SFO) T1   01 Dec 2026  16:35
  Copenhagen (CPH) T3      02 Dec 2026  12:20
  Layover in Copenhagen: 2h 00m

Segment 2  AI 156   Air India
  Copenhagen (CPH) T3      02 Dec 2026  14:20
  Mumbai (BOM) T2          03 Dec 2026  02:50
  Layover in Mumbai: 3h 20m

Segment 3  AI 635   Air India
  Mumbai (BOM) T2          03 Dec 2026  06:10
  Indore (IDR)             03 Dec 2026  07:25

Passenger: SINGHI/JAY MR   Ticket 117-8890013422
Total paid USD 1,284.50
""")
write("04_multi_leg_sfo_cph_bom_idr.eml", agency)

# ── 5. A DATE WITH NO YEAR, RECEIVED IN LATE DECEMBER ───────────────────────
# Received 28 December; the flight is "Fri, 15 Jan". Correct is the following
# year. This is the rollover case.
akasa = base("Akasa Air: Booking confirmed - QP 1133 BOM-BLR", "Akasa Air <care@akasaair.com>",
             "Mon, 28 Dec 2026 20:05:00 +0530")
akasa.set_content("""Hi Jay, your booking is confirmed.

PNR  M4Q7PZ
QP 1133   Mumbai (BOM) -> Bengaluru (BLR)
Fri, 15 Jan   Departs 05:40   Arrives 07:25
Passenger: Jay Singhi   Seat 21C
Amount paid INR 6,120
""")
write("05_no_year_rollover.eml", akasa)

# ── 6. A CANCELLATION WITH A PNR AND NO FLIGHT NUMBERS ──────────────────────
cancel = base("Your booking ZK9P2Q has been cancelled", "British Airways <no-reply@britishairways.com>",
              "Fri, 04 Sep 2026 10:10:00 +0100")
cancel.set_content("""Dear Mr Singhi,

Your booking ZK9P2Q has been cancelled as requested. A refund of GBP 412.30
will be returned to your original payment method within 7 working days.
Order ID 7781. If you did not request this, contact us on the number below.

British Airways Customer Relations
""")
write("06_cancellation_no_flights.eml", cancel)

print("wrote 7 fixtures to", HERE)
