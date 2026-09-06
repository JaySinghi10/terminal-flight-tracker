"""Hong Kong International Airport.

THE PAGE IS A SHELL AND THE DATA IS A FILE, which is the opposite of what this
airport is usually reported to be. hongkongairport.com/en/shop-dine/dining/
contains no restaurants at all -- "Restricted", "Terminal" and every outlet name
are absent from the HTML. The trail is:

    the page loads /iwov-resources/js/shopping_categories.js?dining
      which calls HKIA.API.load('snd_categories')
        whose url is defined in /iwov-resources/js/hkia.js as
          /iwov-resources/custom/json/shops_en.json

...a single 489KB static JSON file holding every shop and restaurant at HKIA,
stamped with its own file-last-updated-date. No DOM selectors, no browser, and
nothing to break when they restyle the page.

WHAT MAKES IT THE RIGHT FIRST AIRPORT: it publishes `restricted` as a boolean on
every outlet, so security_basis is "explicit" for all 77 records. Getting the
schema right against a source that KNOWS the answer is what lets us later
measure an inferred one against something.
"""
import re
from datetime import datetime, timezone

from schema import Dining

AIRPORT = "HKG"
SOURCE_URL = "https://www.hongkongairport.com/iwov-resources/custom/json/shops_en.json"
PAGE_URL = "https://www.hongkongairport.com/en/shop-dine/dining/"

# HKG's own category codes -> our vocabulary. Their `kind.dining.cat` map gives
# the human names; these are the codes it is keyed by.
#
# A BRAND CARRIES SEVERAL, e.g. ["fastf", "veget"], and all of them are kept:
# "fast food, and there is something vegetarian" is two useful facts and picking
# one primary would throw the other away.
CATEGORY_MAP = {
    "fastf": "fast_food",       # Fast Food & Food Courts
    "desse": "dessert",         # Dessert
    "asian": "asian",           # Asian Restaurants
    "chine": "chinese",         # Chinese Restaurants & Hong Kong Style Coffee Shops
    "veget": "vegetarian",      # Vegetarian Choices
    "halal": "halal",           # Halal
    "weste": "western",         # Western Restaurants, Bars & Coffee Shops
    "baker": "bakery",          # Bakery
}

# "Food Court near Gate 40-80, Departures Level (L6)" -> "40-80"
# "Near Gate 6, Departures Level (L6)"                -> "6"
#
# THE DEDICATED `gate` FIELD IS EMPTY ON ALL 77 OUTLETS, measured. The gate is
# only ever in the address prose, so this regex is the sole source of it and its
# failure mode is an empty string rather than a wrong gate.
GATE_RE = re.compile(r"Gate\s+(\d+(?:\s*-\s*\d+)?)", re.I)

# Areas that are worth naming separately from the terminal building, because a
# passenger at Gate 201 is a shuttle ride from Terminal 1's main concourse.
AREA_RE = re.compile(r"(Midfield Concourse|SkyPier|North Satellite Concourse)", re.I)


def _hours(shop):
    """The opening string, verbatim.

    NOT PARSED INTO TIMES, and that is deliberate -- see run.py. Note the source
    mixes a hyphen and an EN DASH ("07:00 - 23:00" and "07:00 – 23:00") and
    appends free text ("(Last order: 20:30)"), so a naive split on "-" would
    quietly produce garbage on a fifth of the rows.
    """
    return str(shop.get("open") or "").strip()


def parse(raw, scraped_at, entry=None):
    """(records, notes) from the decoded shops JSON.

    `notes` is everything a human should know about this run that is not a
    record: outlets skipped, fields that came back empty, vocabulary we could
    not map. It is printed by the runner and is how a silent change becomes a
    loud one.
    """
    notes = []
    area_labels = raw.get("area") or {}
    restricted_label = area_labels.get("ra", "Restricted Area")
    open_label = area_labels.get("nr", "Non-restricted Area")
    # IF THEIR OWN LEGEND STOPS SAYING WHAT WE EXPECT, SAY SO. The labels are
    # carried into every record as security_raw, so a change here silently
    # rewrites the meaning of the column unless it is called out.
    if restricted_label != "Restricted Area" or open_label != "Non-restricted Area":
        notes.append("area legend changed: ra=%r nr=%r" % (restricted_label, open_label))

    dining_cats = set((raw.get("kind", {}).get("dining", {}).get("cat") or {}))
    if not dining_cats:
        notes.append("FATAL-SHAPE: kind.dining.cat is missing or empty")
        return [], notes
    unmapped = dining_cats - set(CATEGORY_MAP)
    if unmapped:
        notes.append("new HKG categories not in CATEGORY_MAP: %s" % sorted(unmapped))

    source_updated = str(raw.get("file-last-updated-date") or "").strip()

    out, skipped_inactive = [], 0
    mismatched = 0
    for brand_id, brand in (raw.get("brand") or {}).items():
        cats = [c for c in (brand.get("cat") or []) if c in dining_cats]
        # TWO INDEPENDENT SAYS ON WHETHER THIS IS FOOD, and both are used. The
        # brand carries category == "dining", and its cat codes intersect the
        # dining vocabulary. They agree on every record today; a disagreement
        # means the source has reorganised and is reported rather than resolved
        # silently in either direction.
        says_dining = str(brand.get("category") or "").strip().lower() == "dining"
        if says_dining != bool(cats):
            mismatched += 1
        if not (says_dining and cats):
            continue                                    # retail or entertainment
        name = str(brand.get("name") or brand_id).strip()
        cat_norm = [CATEGORY_MAP[c] for c in cats if c in CATEGORY_MAP]

        for shop_id, shop in (brand.get("shop") or {}).items():
            # ACTIVE ONLY. One outlet is flagged inactive today; shipping a
            # closed restaurant is the same failure as shipping a landside one.
            if shop.get("active") is False:
                skipped_inactive += 1
                continue

            addr = str(shop.get("addr") or "").strip()
            gate = GATE_RE.search(addr)
            area = AREA_RE.search(addr)
            restricted = shop.get("restricted")

            lat = lon = None
            try:
                lat = float(shop["location-lat"])
                lon = float(shop["location-long"])
            except (KeyError, TypeError, ValueError):
                pass

            out.append(Dining(
                airport=AIRPORT,
                name=name,
                # The outlet key from the source, e.g. "6W524C". Stable across
                # refreshes and unique where name+level is not.
                source_id=str(shop.get("external-id") or shop_id or ""),
                terminal_raw=str(shop.get("term") or ""),
                terminal=str(shop.get("term") or "").upper(),
                level=str(shop.get("floor") or ""),
                area=(area.group(1) if area else str(shop.get("building") or "")),
                gate_hint=(re.sub(r"\s+", "", gate.group(1)) if gate else ""),
                # EXPLICIT, because the source states it per outlet as a boolean.
                is_airside=(bool(restricted) if isinstance(restricted, bool) else None),
                # HKG's boolean covers only the departures split; it has no
                # arrivals concept, so every labelled outlet is one or the other.
                zone=("departures_airside" if restricted else "departures_landside")
                     if isinstance(restricted, bool) else "unknown",
                security_raw=(restricted_label if restricted else open_label)
                             if isinstance(restricted, bool) else "",
                security_basis="explicit" if isinstance(restricted, bool) else "unknown",
                flight_scope="",   # this source does not distinguish
                category_raw="|".join(cats),
                category="|".join(cat_norm),
                serve_minutes=None,   # this source does not publish it
                hours_raw=_hours(shop),
                # EMPTY ON PURPOSE. HKG's hours are prose -- mixed dashes and
                # "(Last order: 20:30)" -- so there is nothing here that was
                # already structured. Inventing windows from that would be a
                # guess wearing the clothes of data. See the note in schema.py.
                hours=[],
                is_24h=bool(shop.get("24-hours")),
                lat=lat, lon=lon,
                source_url=SOURCE_URL,
                scraped_at=scraped_at,
                source_updated_at=source_updated,
            ))

    if mismatched:
        notes.append("%d brand(s) disagree between category=='dining' and their cat codes"
                     % mismatched)
    if skipped_inactive:
        notes.append("skipped %d inactive outlet(s)" % skipped_inactive)
    missing_sec = sum(1 for r in out if r.security_basis != "explicit")
    if missing_sec:
        notes.append("%d outlet(s) had no `restricted` boolean" % missing_sec)
    return out, notes
