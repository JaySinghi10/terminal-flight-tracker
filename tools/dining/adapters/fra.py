"""Frankfurt Airport.

THE BEST SOURCE FOUND SO FAR, and better than HKG in two ways. Every outlet
carries a zone object:

    "zone": {"area": "J", "level": "3", "terminal": "3",
             "landside": false, "label": "T3, Area J, Security area"}

-- an explicit boolean AND the airport's own words for it, which is exactly the
pair the schema wants. And the opening hours arrive already structured, as day
ranges with separate open and close times, rather than as prose to be guessed at.

THE ENDPOINT IS AEM's COMPONENT MODEL, reached from the eat-drink page:

    /en/at-the-airport/eat-drink/_jcr_content/root/content/
        locationfilter.model.json/locations.json

THE DATE STAMP IN THE URL IS IGNORED, and this was tested rather than assumed.
The browser requests .../locationfilter.model.json/2026090617/locations.json;
the stamp-free form, a stamp of "1", and a stamp from 2020 all return byte-
identical 247,730-byte responses. So the adapter uses the stable URL and cannot
break when their cache key rolls over.

NOTE THE INVERTED SENSE: `landside: true` means NOT airside. Reading it as
"airside" would flip the meaning of every record, which is the exact failure
security_raw exists to make visible.
"""
from schema import Dining

AIRPORT = "FRA"
SOURCE_URL = ("https://www.frankfurt-airport.com/en/at-the-airport/eat-drink/"
              "_jcr_content/root/content/locationfilter.model.json/locations.json")
PAGE_URL = "https://www.frankfurt-airport.com/en/at-the-airport/eat-drink.html"

# FRA's German-slug categories -> our vocabulary. Anything unmapped stays in
# category_raw and is reported, which is how the vocabulary grows on evidence.
CATEGORY_MAP = {
    "restaurants": "western",
    "german-food": "western",
    "italian-food": "western",
    "asia-food": "asian",
    "asian-food": "asian",
    "sushi": "asian",
    "baeckereien": "bakery",
    "snack-coffee-bars": "cafe",
    "cafe": "cafe",
    "kaffee": "cafe",
    "bars": "bar",
    "bar": "bar",
    "fastfood": "fast_food",
    "fast-food": "fast_food",
    "burger": "fast_food",
    "systemgastronomie": "fast_food",
    "fruehstueck": "cafe",
    "healthy-food": "vegetarian",
    "vegetarisch": "vegetarian",
    "vegan": "vegetarian",
    "eis": "dessert",
    "suesses": "dessert",
    "lounges": "lounge",
    "supermarkt": "other",          # REWE To Go: a food-to-go convenience shop
}

# STRUCTURAL AND LOYALTY TAGS, NOT CUISINES. "essen-and-trinken" is the parent
# node of the whole feed and is present on only 62 of 94 rows, so it is no use
# as a filter either; the Miles & More tags are a frequent-flyer programme. They
# are listed rather than left to the unmapped report, which should only ever
# name things we have not seen before.
IGNORE_CATEGORIES = {
    "essen-and-trinken", "einkaufen",
    "miles-and-more-gastronomie", "miles-and-more-shops",
}

# ── WHAT COUNTS AS BEING AT THE AIRPORT ─────────────────────────────────────
#
# THE SQUAIRE IS NOT A TERMINAL. Eleven of the 94 outlets sit in
# `Tno_terminal, Area the_squaire, Public` -- the office, hotel and conference
# block built over the long-distance railway station. It is attached to the
# airport and it is landside, outside security, and useless to a connecting
# passenger. Publishing it as "Frankfurt Airport dining" is the same mistake as
# scraping Jewel and calling it Changi.
#
# They are DROPPED and COUNTED rather than silently filtered, so that a future
# run which suddenly drops sixty records has to explain itself.
NON_TERMINAL_AREAS = {"the_squaire"}


def _hours(entry):
    """FRA's day-range windows, normalised. 0 = Monday, as the source uses."""
    out = []
    for w in entry.get("openingHours") or []:
        try:
            start, end = int(w["startDay"]), int(w["endDay"])
            op, cl = str(w["openingTime"]).strip(), str(w["closingTime"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= start <= 6 and 0 <= end <= 6) or not op or not cl:
            continue
        out.append({"start_day": start, "end_day": end, "open": op, "close": cl})
    return out


def _hours_raw(entry):
    """The human string, built from the source's own phrasings so nothing is
    invented: "Mon.-Fri. 05:30-20:30; Sat.-Sun. 06:00-21:00"."""
    parts = []
    for w in entry.get("openingHours") or []:
        days = str(w.get("startAndEndDate") or "").strip()
        times = str(w.get("openAndClosingTime") or "").strip()
        parts.append(" ".join(p for p in (days, times) if p))
    return "; ".join(p for p in parts if p)


def parse(raw, scraped_at, entry=None):
    notes = []
    rows = raw.get("results") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or not rows:
        notes.append("FATAL-SHAPE: no `results` list in the response")
        return [], notes

    out, dropped, unmapped = [], [], set()
    for e in rows:
        zone = e.get("zone") or {}
        terminal = str(zone.get("terminal") or "").strip()
        area = str(zone.get("area") or "").strip()
        landside = zone.get("landside")

        if area in NON_TERMINAL_AREAS or terminal in ("", "no_terminal"):
            dropped.append("%s (%s)" % (e.get("title"), zone.get("label")))
            continue

        cats_raw = [str(c) for c in (e.get("categories") or [])]
        cats = []
        for c in cats_raw:
            if c in CATEGORY_MAP:
                if CATEGORY_MAP[c] not in cats:
                    cats.append(CATEGORY_MAP[c])
            elif c not in IGNORE_CATEGORIES:
                unmapped.add(c)

        # landside is INVERTED relative to is_airside. Read it wrong and every
        # record flips; security_raw carries their label so it would show.
        explicit = isinstance(landside, bool)
        out.append(Dining(
            airport=AIRPORT,
            name=str(e.get("title") or "").strip(),
            source_id=str(e.get("poiId") or "").strip(),
            terminal_raw=terminal,
            terminal=("T" + terminal) if terminal.isdigit() else terminal.upper(),
            level=str(zone.get("level") or ""),
            area=area,
            gate_hint="",                    # FRA gives an area letter, never a gate
            is_airside=((not landside) if explicit else None),
            # FRA splits Public from Security area and says nothing about
            # arrivals, so the same two zones as HKG.
            zone=("departures_landside" if landside else "departures_airside")
                 if explicit else "unknown",
            security_raw=str(zone.get("label") or "") if explicit else "",
            security_basis="explicit" if explicit else "unknown",
            flight_scope="",   # this source does not distinguish
            category_raw="|".join(cats_raw),
            category="|".join(cats),
            serve_minutes=None,   # this source does not publish it
            hours_raw=_hours_raw(e),
            hours=_hours(e),
            is_24h=any(w["open"] in ("00:00",) and w["close"] in ("24:00", "00:00")
                       for w in _hours(e)),
            lat=None, lon=None,              # not published on this endpoint
            source_url=SOURCE_URL,
            scraped_at=scraped_at,
            source_updated_at="",
        ))

    if dropped:
        notes.append("dropped %d outlet(s) outside any terminal: %s"
                     % (len(dropped), "; ".join(dropped[:4])
                        + (" ..." if len(dropped) > 4 else "")))
    if unmapped:
        notes.append("categories not in CATEGORY_MAP: %s" % sorted(unmapped))
    no_hours = sum(1 for r in out if not r.hours)
    if no_hours:
        notes.append("%d outlet(s) have no structured hours" % no_hours)
    return out, notes
