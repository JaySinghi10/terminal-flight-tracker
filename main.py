import requests
import os
from dotenv import load_dotenv
from datetime import datetime

load_dotenv()

API_KEY = os.getenv("AVIATIONSTACK_API_KEY")

# ──────────────────────────────────────────────
# FORMAT TIME → IST (API already returns IST)
# ──────────────────────────────────────────────
def format_time(time_str):
    if not time_str:
        return "N/A"
    dt = datetime.fromisoformat(time_str)
    period = "AM" if dt.hour < 12 else "PM"
    display_hour = dt.hour if dt.hour <= 12 else dt.hour - 12
    if display_hour == 0:
        display_hour = 12
    return f"{display_hour}:{dt.minute:02d} {period} IST"

# ──────────────────────────────────────────────
# CALL AVIATIONSTACK API BY FLIGHT NUMBER
# ──────────────────────────────────────────────
def get_flight_status(flight_number):
    url = "http://api.aviationstack.com/v1/flights"
    params = {
        "access_key": API_KEY,
        "flight_iata": flight_number.upper(),
    }
    response = requests.get(url, params=params)
    return response.json()

# ──────────────────────────────────────────────
# DISPLAY FLIGHT STATUS
# ──────────────────────────────────────────────
def display_flight_status(data, flight_number):
    if "data" not in data or len(data["data"]) == 0:
        print(f"\nNo data found for flight {flight_number.upper()}.")
        print("Make sure the flight number is correct and the flight is operating today.\n")
        return

    flight = data["data"][0]

    airline     = flight["airline"]["name"]
    flight_num  = flight["flight"]["iata"]
    flight_date = flight.get("flight_date") or "N/A"
    status      = (flight["flight_status"] or "Unknown").upper()

    dep_airport   = flight["departure"]["airport"]
    dep_iata      = flight["departure"]["iata"]
    dep_terminal  = flight["departure"].get("terminal") or "N/A"
    dep_gate      = flight["departure"].get("gate") or "N/A"
    dep_scheduled = format_time(flight["departure"].get("scheduled"))
    dep_actual    = format_time(flight["departure"].get("actual"))
    dep_delay     = flight["departure"].get("delay")

    arr_airport   = flight["arrival"]["airport"]
    arr_iata      = flight["arrival"]["iata"]
    arr_terminal  = flight["arrival"].get("terminal") or "N/A"
    arr_gate      = flight["arrival"].get("gate") or "N/A"
    arr_scheduled = format_time(flight["arrival"].get("scheduled"))
    arr_actual    = format_time(flight["arrival"].get("actual"))
    arr_delay     = flight["arrival"].get("delay")
    arr_baggage   = flight["arrival"].get("baggage") or "N/A"

    print("\n" + "=" * 55)
    print(f"  ✈  {airline}  |  Flight {flight_num}  |  {flight_date}")
    print("=" * 55)

    print(f"\n  STATUS : {status}")

    print(f"\n  DEPARTURE")
    print(f"  Airport  : {dep_airport} ({dep_iata})")
    print(f"  Terminal : {dep_terminal}  |  Gate : {dep_gate}")
    print(f"  Scheduled: {dep_scheduled}")
    print(f"  Actual   : {dep_actual}")
    if dep_delay:
        print(f"  ⚠ Delay  : {dep_delay} minutes")

    print(f"\n  ARRIVAL")
    print(f"  Airport  : {arr_airport} ({arr_iata})")
    print(f"  Terminal : {arr_terminal}  |  Gate : {arr_gate}")
    print(f"  Scheduled: {arr_scheduled}")
    print(f"  Actual   : {arr_actual}")
    if arr_delay:
        print(f"  ⚠ Delay  : {arr_delay} minutes")
    print(f"  Baggage  : {arr_baggage}")

    print("\n" + "=" * 55 + "\n")

# ──────────────────────────────────────────────
# MAIN LOOP
# ──────────────────────────────────────────────
def main():
    print("✈  Flight Status Tracker")
    print("-------------------------")
    print("Enter a flight number to get its current status.")
    print("Examples: AI2630   6E5031   QP1134   EK568")
    print("Type 'quit' to exit\n")

    while True:
        flight_number = input("Flight Number: ").strip()
        if not flight_number:
            continue
        if flight_number.lower() == "quit":
            break

        print(f"\nFetching status for {flight_number.upper()}...")
        data = get_flight_status(flight_number)
        display_flight_status(data, flight_number)

main()