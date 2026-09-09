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
# 6E5071 flies BOM-BLR at 15:35 on Tuesday 15 September 2026 (checked against
# the provider); it does not operate on the 14th, which the first draft used.
indigo.set_content("""<!DOCTYPE html><html><head><meta charset="utf-8"><title>IndiGo</title>
<style>body{font-family:Arial} .h{background:#001B94;color:#fff}</style></head>
<body>
<table width="600" cellpadding="8"><tr class="h"><td colspan="4">Your booking is confirmed</td></tr>
<tr><td>PNR</td><td><b>R7K3XQ</b></td><td>Booking date</td><td>02 Mar 2026</td></tr>
<tr><td colspan="4">Dear Jay Singhi, thank you for choosing IndiGo.</td></tr>
<tr class="h"><td>Flight</td><td>From</td><td>To</td><td>Date</td></tr>
<tr><td><b>6E</b> 5071</td><td>Mumbai (BOM)<br>Terminal 1<br>15:35</td><td>Bengaluru (BLR)<br>Terminal 1<br>17:25</td><td>Tue, 15 Sep 2026</td></tr>
<tr><td colspan="4">Passenger: MR JAY SINGHI &nbsp; Seat: 14A &nbsp; Meal: Veg</td></tr>
<tr><td colspan="4">Fare INR 4,999 &nbsp; Convenience fee INR 350 &nbsp; Total INR 5,349</td></tr>
<tr><td colspan="4">Web check-in opens 48 hours before departure. Carry a valid photo ID.</td></tr>
<tr><td colspan="4" style="color:#888">6E Rewards: earn 500 points on this booking. Hotels from INR 1,999 on 6E Add-ons.</td></tr>
</table></body></html>""", subtype="html")
write("01_indigo_html_only.eml", indigo)

# ── 2. LUFTHANSA WITH JSON-LD ───────────────────────────────────────────────
# Lufthansa Group emails carry a schema.org FlightReservation block with the
# number alone in flightNumber and the carrier in airline.iataCode.
lh = base("Your booking confirmation Q8T4LM: Chennai - Frankfurt",
          "Lufthansa <noreply@lufthansa.com>", "Sat, 20 Jun 2026 09:12:00 +0200")
lh.set_content("""Booking code Q8T4LM
LH 759 Chennai (MAA) 05 Oct 2026 01:55 - Frankfurt (FRA) 05 Oct 2026 08:40
Passenger: Singhi, Jay
""")
lh.add_alternative("""<html><head>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"FlightReservation",
 "reservationNumber":"Q8T4LM","reservationStatus":"http://schema.org/ReservationConfirmed",
 "underName":{"@type":"Person","name":"Jay Singhi"},
 "reservationFor":{"@type":"Flight","flightNumber":"759",
   "airline":{"@type":"Airline","name":"Lufthansa","iataCode":"LH"},
   "departureAirport":{"@type":"Airport","name":"Chennai International Airport","iataCode":"MAA"},
   "departureTime":"2026-10-05T01:55:00+05:30",
   "arrivalAirport":{"@type":"Airport","name":"Frankfurt Airport","iataCode":"FRA"},
   "arrivalTime":"2026-10-05T08:40:00+02:00"}}
</script></head>
<body><h2>Thank you for your booking</h2><p>Booking code <b>Q8T4LM</b></p>
<table><tr><td>LH 759</td><td>MAA 05 Oct 2026 01:55</td><td>FRA 05 Oct 2026 08:40</td><td>Airbus A340-300</td></tr></table>
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

# ── 4. THREE LEGS, TWO LAYOVERS: SFO -> CPH -> DEL -> IDR ───────────────────
# An agency itinerary, the way Trip.com or MakeMyTrip lay one out: one agency
# reference, one airline PNR, three segments across three carriers, and an
# overnight crossing a date line so the second leg lands the next day.
#
# EVERY LEG IS A REAL FLIGHT ON ITS REAL ROUTE, with the provider's own
# scheduled times for these dates (checked 8 Sep 2026). An earlier draft put
# AI156 on CPH-BOM and invented AI635 BOM-IDR; AI156 is AMS-DEL and AI635 does
# not exist, so the lookup with the email's origin refused both -- correctly,
# but that tests the origin guard, not extraction. The fixture must be a
# booking a person could hold.
agency = base("Trip.com | E-ticket issued | Booking 8817729043 | SFO-IDR 01 Dec",
              "Trip.com <noreply@trip.com>", "Tue, 01 Sep 2026 11:30:00 +0800")
agency.set_content("""Your e-ticket has been issued. Booking number 8817729043. Airline PNR: H8J2K1

Segment 1  SK 936   Scandinavian Airlines
  San Francisco (SFO) Intl Terminal   01 Dec 2026  16:45
  Copenhagen (CPH) T3                 02 Dec 2026  12:15
  Layover in Copenhagen: 8h 10m

Segment 2  AI 158   Air India
  Copenhagen (CPH) T2      02 Dec 2026  20:25
  New Delhi (DEL) T3       03 Dec 2026  10:10
  Layover in New Delhi: 1h 55m

Segment 3  6E 6488   IndiGo
  New Delhi (DEL) T1       03 Dec 2026  12:05
  Indore (IDR)             03 Dec 2026  13:35

Passenger: SINGHI/JAY MR   Ticket 117-8890013422
Total paid USD 1,284.50
""")
write("04_multi_leg_sfo_cph_del_idr.eml", agency)

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
write("06_cancellation_named_legs.eml", cancel)

# ── 7. AN AIRLINE CANCELLATION THAT NAMES THE FLIGHT ────────────────────────
# The notice an airline sends when IT cancels: one flight, its date and route
# printed plainly, a rebooking offer, and no itinerary restated. This is the
# email the merge exists for -- classified as a cancellation, it must return
# the one leg it names, carrying cancelled.
ai_cancel = base("Flight cancellation: AI 605 Mumbai - Delhi on 17 Oct 2026",
                 "Air India <noreply@airindia.com>", "Mon, 07 Sep 2026 11:20:00 +0530")
ai_cancel.set_content("""Dear Mr Singhi,

We regret to inform you that the following flight on your booking has been
cancelled due to operational reasons.

Booking reference  T6V2RD
AI 605   Mumbai (BOM) -> New Delhi (DEL)
Sat, 17 Oct 2026   Scheduled departure 07:00

You may rebook on an alternative Air India flight at no extra charge, or
request a full refund, at airindia.com/manage or by calling us.

We apologise for the inconvenience.
Air India Customer Support
""")
write("07_cancellation_named_flight.eml", ai_cancel)

# ── 8. A DOMESTIC RETURN: ONE LEG OUT, ONE LEG BACK A WEEK LATER ────────────
# The commonest booking there is, and the suite had none: two legs under one
# reference that are NOT a connection -- seven days apart, and the second flies
# the first backwards. The return is a red-eye, so it lands on the day after it
# leaves and the email prints that day: the only fixture besides the agency
# itinerary that exercises an arrival date of its own.
indigo_rt = base("Booking Confirmation - PNR K4L9WD | 6E 2134 / 6E 2137 | Mumbai - Delhi - Mumbai",
                 "IndiGo <no-reply@goindigo.in>", "Tue, 25 Aug 2026 11:20:00 +0530")
indigo_rt.set_content("""Dear Jay Singhi, your return booking is confirmed.

PNR  K4L9WD

ONWARD
6E 2134   Mumbai (BOM) Terminal 1  ->  Delhi (DEL) Terminal 2
Mon, 12 Oct 2026   Departs 06:15   Arrives 08:25

RETURN
6E 2137   Delhi (DEL) Terminal 2  ->  Mumbai (BOM) Terminal 1
Departs Mon, 19 Oct 2026 23:50   Arrives Tue, 20 Oct 2026 02:05

Passenger: MR JAY SINGHI   Seat 9C / 14A
Fare INR 10,240   Convenience fee INR 350   Total INR 10,590
Web check-in opens 48 hours before departure.
""")
write("08_domestic_return.eml", indigo_rt)

# ── 9. A STOPOVER, NOT A CONNECTION ────────────────────────────────────────
# Two legs on one reference where the second leaves the NEXT DAY from a
# DIFFERENT AIRPORT than the first landed at. Nothing joins them but the
# booking: there is no airport in common and no gap a connection rule would
# recognise, because the traveller drives between the two cities overnight.
multicity = base("Air India: multi-city booking confirmed - R2M8ZC",
                 "Air India <noreply@airindia.com>", "Thu, 27 Aug 2026 16:05:00 +0530")
multicity.set_content("""Dear Mr Singhi,

Your multi-city booking is confirmed.

Booking reference  R2M8ZC

Segment 1
AI 2914   Mumbai (BOM) Terminal 2  ->  Ahmedabad (AMD)
Tue, 03 Nov 2026   Departs 17:55   Arrives 19:20

Segment 2
AI 476    Udaipur (UDR)  ->  New Delhi (DEL) Terminal 3
Wed, 04 Nov 2026   Departs 11:30   Arrives 12:55

Surface travel between Ahmedabad and Udaipur is not included in this booking.
Passenger: SINGHI/JAY MR   Ticket 098-7712340099
Total INR 14,860
""")
write("09_stopover_two_cities.eml", multicity)

# ── 10a. A CONFIRMATION THAT WILL BE SUPERSEDED ────────────────────────────
# One leg, so the change notice beside it has exactly one thing to move.
change_conf = base("Your booking is confirmed - H3P7QK - AI 2986 Delhi to Bengaluru",
                   "Air India <noreply@airindia.com>", "Mon, 24 Aug 2026 09:15:00 +0530")
change_conf.set_content("""Dear Mr Singhi,

Thank you for booking with Air India. Your booking is confirmed.

Booking reference  H3P7QK

AI 2986   New Delhi (DEL) Terminal 3  ->  Bengaluru (BLR) Terminal 2
Fri, 20 Nov 2026   Departs 09:40   Arrives 12:25

Passenger: SINGHI/JAY MR   Seat 18F   Ticket 098-7712345566
Fare INR 8,140
""")
write("10a_change_original.eml", change_conf)

# ── 10b. THE CHANGE, SIXTEEN DAYS LATER, SAME REFERENCE ────────────────────
# A schedule revision that moves the leg to a different NUMBER and a different
# DAY, and names the flight it replaces the way an airline actually writes one.
# The merge keys on number and date, so what this fixture is really asking is
# whether a leg whose identity changed can supersede the leg it replaced.
change_notice = base("Important: schedule change to your booking H3P7QK",
                     "Air India <noreply@airindia.com>", "Fri, 04 Sep 2026 08:45:00 +0530")
change_notice.set_content("""Dear Mr Singhi,

Due to a schedule revision, one flight on your booking has changed.

Booking reference  H3P7QK

Previously   AI 2986   New Delhi (DEL) -> Bengaluru (BLR)   Fri, 20 Nov 2026   09:40
Now          AI 2992   New Delhi (DEL) Terminal 3 -> Bengaluru (BLR) Terminal 2
             Sat, 21 Nov 2026   Departs 14:15   Arrives 17:05

Your seat assignment and baggage allowance carry over to the new flight. No
action is required. If the new timing does not suit you, a full refund is
available at airindia.com/manage.

Air India Customer Support
""")
write("10b_change_notice.eml", change_notice)

print("wrote 12 fixtures to", HERE)
