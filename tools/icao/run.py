"""IATA -> ICAO airport codes, for matching a Flightradar24 leg to our own.

WHY THIS EXISTS AT ALL. Flightradar24's flight-summary LIGHT endpoint returns
ICAO airport codes and nothing else -- origin_icao, destination_icao. Every
record this app stores is IATA. To confirm that a leg FR24 handed back is the
leg we asked about, the two vocabularies have to meet somewhere.

WHY NOT JUST PAY FR24 FOR THE IATA CODES. The FULL variant of the same endpoint
returns orig_iata/dest_iata and costs one more credit per returned record --
2 instead of 1 live, 3 instead of 2 historic. That is 50-100% more, for ever, to
buy a field that a static public dataset answers for free. Full also carries
runway_landed, flight_time and category, none of which the landing decision
uses. Buying a tier for one field is the wrong trade.

WHY THE MATCH IS NEEDED IN THE FIRST PLACE -- TAG FLIGHTS. One flight number can
operate two consecutive legs on one day, and a date-range query returns both.
This repository already fights that exact problem on the AeroDataBox side, where
fetch_flight_full filters on the departure IATA and deliberately refuses to fall
back to an unfiltered list. Picking the wrong leg here means reporting the wrong
landing time, which is worse than reporting none.

SERVER-SIDE ONLY. The app never sees this; FlightTrackerApp/lib/airports.ts is
IATA-keyed and carries no ICAO, and it stays that way. The comparison happens in
fr24.py, where both codes are already in hand.

SOURCE: OurAirports (public domain), the same dataset airports.ts was generated
from. The columns used are icao_code, ident, iata_code and scheduled_service.

    python tools/icao/run.py            # writes airport_icao.py at the repo root
"""
import csv
import io
import os
import re
import sys
import urllib.request

SOURCE = "https://davidmegginson.github.io/ourairports-data/airports.csv"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "airport_icao.py")
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "airports.csv")

IATA_RE = re.compile(r"^[A-Z]{3}$")
ICAO_RE = re.compile(r"^[A-Z]{4}$")

# Airports the landing check must be able to resolve. Not a filter -- a
# post-generation assertion, so a source change that quietly drops one of them
# fails the run instead of shipping a map with a hole in it.
MUST_RESOLVE = {
    "BOM": "VABB", "BLR": "VOBL", "DEL": "VIDP", "MAA": "VOMM", "HYD": "VOHS",
    "DXB": "OMDB", "AUH": "OMAA", "DOH": "OTHH",
    "LHR": "EGLL", "FRA": "EDDF", "CDG": "LFPG", "AMS": "EHAM", "ZRH": "LSZH",
    "JFK": "KJFK", "EWR": "KEWR", "SFO": "KSFO", "ORD": "KORD",
    "SIN": "WSSS", "HKG": "VHHH", "BKK": "VTBS", "NRT": "RJAA",
    "ARN": "ESSA", "SYD": "YSSY",
}


def load():
    """The dataset, from disk if it has already been fetched."""
    if os.path.exists(RAW) and os.path.getsize(RAW) > 1_000_000:
        return io.open(RAW, encoding="utf8", newline="").read()
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "flight-tracker-tools/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read().decode("utf8")
    io.open(RAW, "w", encoding="utf8", newline="").write(body)
    return body


def build(text):
    rows = list(csv.DictReader(io.StringIO(text)))
    out = {}
    # An IATA code claimed by more than one airport. Recorded rather than
    # silently resolved: the winner would otherwise depend on file order.
    clashes = {}
    skipped_no_icao = 0

    for row in rows:
        # SCHEDULED SERVICE ONLY. A dormant airfield that shares a code with a
        # real one is worse than an absent entry, because it can be matched --
        # the same reasoning airports.ts records for its own trim.
        if (row.get("scheduled_service") or "").strip().lower() != "yes":
            continue
        iata = (row.get("iata_code") or "").strip().upper()
        if not IATA_RE.match(iata):
            continue
        # icao_code IS THE AUTHORITATIVE COLUMN and `ident` is a fallback.
        # OurAirports uses ident as a primary key, and for airports without an
        # ICAO assignment it holds a local code that merely looks like one.
        # Taking ident first would invent ICAO codes for airports that have none.
        icao = (row.get("icao_code") or "").strip().upper()
        if not ICAO_RE.match(icao):
            ident = (row.get("ident") or "").strip().upper()
            icao = ident if ICAO_RE.match(ident) else ""
        if not icao:
            skipped_no_icao += 1
            continue
        if iata in out and out[iata] != icao:
            clashes.setdefault(iata, {out[iata]}).add(icao)
            continue
        out[iata] = icao
    return out, clashes, skipped_no_icao


def emit(mapping):
    lines = [
        '"""IATA -> ICAO airport codes. GENERATED -- do not edit by hand.',
        "",
        "Regenerate with:  python tools/icao/run.py",
        "",
        "Source: OurAirports (public domain), scheduled-service airports carrying",
        "both a three-letter IATA code and a four-letter ICAO code.",
        "",
        "WHAT IT IS FOR: Flightradar24's flight-summary/light returns ICAO airport",
        "codes only. Every record this app stores is IATA. fr24.py uses this to",
        "confirm that a leg FR24 returned is the leg that was asked about -- which",
        "matters because one flight number can operate two legs in a day and a",
        "date-range query returns both.",
        '"""',
        "",
        "IATA_TO_ICAO = {",
    ]
    for iata in sorted(mapping):
        lines.append('    "%s": "%s",' % (iata, mapping[iata]))
    lines.append("}")
    lines.append("")
    lines.append("# The reverse, built once at import rather than spelled twice. An ICAO code")
    lines.append("# maps to at most one IATA code here, because the forward map refuses")
    lines.append("# duplicates on either side.")
    lines.append("ICAO_TO_IATA = {v: k for k, v in IATA_TO_ICAO.items()}")
    lines.append("")
    lines.append("")
    lines.append("def icao_for(iata):")
    lines.append('    """The ICAO code for a IATA code, or None. Case-insensitive."""')
    lines.append("    return IATA_TO_ICAO.get(str(iata or \"\").strip().upper())")
    lines.append("")
    lines.append("")
    lines.append("def iata_for(icao):")
    lines.append('    """The IATA code for an ICAO code, or None. Case-insensitive."""')
    lines.append("    return ICAO_TO_IATA.get(str(icao or \"\").strip().upper())")
    lines.append("")
    io.open(OUT, "w", encoding="utf8", newline="\n").write("\n".join(lines))


def main():
    text = load()
    mapping, clashes, no_icao = build(text)

    print("scheduled-service airports with IATA+ICAO : %d" % len(mapping))
    print("skipped, IATA but no ICAO                 : %d" % no_icao)
    if clashes:
        print("IATA codes claimed by more than one airport: %d" % len(clashes))
        for k in sorted(clashes):
            print("  %s -> %s" % (k, ", ".join(sorted(clashes[k]))))

    missing = {k: v for k, v in MUST_RESOLVE.items() if mapping.get(k) != v}
    if missing:
        print()
        print("FAILED: these must resolve and did not:")
        for k in sorted(missing):
            print("  %s expected %s, got %r" % (k, MUST_RESOLVE[k], mapping.get(k)))
        return 1

    emit(mapping)
    print("wrote %s (%d bytes)" % (OUT, os.path.getsize(OUT)))
    print("all %d required airports resolve" % len(MUST_RESOLVE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
