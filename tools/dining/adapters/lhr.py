"""London Heathrow.

A RECORD HERE IS A BRAND, NOT AN OUTLET, and missing that would have produced a
dataset that is wrong in the most dangerous direction. One Caffe Nero record
carries:

    "terminalArea": ["2/Arrivals", "3/After Security", "3/Arrivals",
                     "5/Arrivals", "2/Before Security", "5/Before Security",
                     "2/After Security"]

-- seven locations, four terminals, three zones, one row. There is no single
is_airside for that. Reducing it to one value would have labelled a landside
counter as airside somewhere, which is precisely the failure this whole feature
exists to prevent.

SO EVERY terminalArea ENTRY BECOMES ITS OWN ROW. The format is "terminal/zone"
and it is the airport's own pairing, so exploding it invents nothing: it just
stops collapsing what they already separated.

AND "Arrivals" IS A THIRD ZONE, NOT A SYNONYM. The same Caffe Nero row lists
BOTH "3/After Security" and "3/Arrivals" -- the same terminal, twice, under
labels Heathrow itself treats as different places. See the zone note in
schema.py for why that cannot be a boolean.

THE ENDPOINT ANSWERS 403 TO A PLAIN REQUEST and 200 to the same URL asked for by
their own page, because of the Origin and Referer a browser attaches. It is
fetched through the page for that reason -- see fetch_browser in run.py.
"""
import re

from schema import Dining

AIRPORT = "LHR"
PAGE_URL = "https://www.heathrow.com/at-the-airport/restaurants-a-z?type=restaurant"
SOURCE_URL = ("https://api-dp-prod.dp.heathrow.com/enterprisesearch/prod/combined"
              "?query=*&page=1&limit=300&type=restaurant")

# Heathrow's own zone words -> ours. These are the three values their own
# "Airport Area" filter offers, so the mapping is theirs, not a guess.
ZONE_MAP = {
    "after security": "departures_airside",
    "before security": "departures_landside",
    "arrivals": "arrivals",
}

CATEGORY_MAP = {
    "pubs and bars": "bar",
    "bars": "bar",
    "casual dining": "western",
    "dine in style": "western",
    "family favourites": "western",
    "fine dining": "western",
    "takeout": "fast_food",
    "fast food": "fast_food",
    "quick bites": "fast_food",
    "coffee shops": "cafe",
    "cafes": "cafe",
    "coffee": "cafe",
    "bakery": "bakery",
    "desserts": "dessert",
    "asian": "asian",
    "indian": "indian",
    "vegetarian": "vegetarian",
    "vegan": "vegetarian",
    "lounges": "lounge",
    # Surfaced by the first run's unmapped report, which is what it is for.
    "coffeehouse and café": "cafe",
    "international cuisine": "asian",
    "in-flight picnic": "fast_food",     # food bought to take on board
}

# "3/After Security" -> ("3", "After Security")
PAIR_RE = re.compile(r"^\s*([0-9A-Za-z]+)\s*/\s*(.+?)\s*$")


def _terminals(doc):
    """Every (terminal, zone) this brand occupies, de-duplicated.

    terminalArea is the pairing to trust. The separate `terminal` and `area`
    lists are the same information flattened -- ["2","3"] with
    ["After Security","Arrivals"] cannot say WHICH terminal is which zone, and
    guessing the cross product would invent locations that do not exist.
    """
    out = []
    for entry in doc.get("terminalArea") or []:
        m = PAIR_RE.match(str(entry))
        if not m:
            continue
        terminal, zone_words = m.group(1), m.group(2)
        out.append((terminal, zone_words))
    # stable, and unique
    seen, uniq = set(), []
    for t, z in out:
        if (t, z) not in seen:
            seen.add((t, z))
            uniq.append((t, z))
    return uniq


def parse(raw, scraped_at, entry=None):
    notes = []
    results = (raw or {}).get("results")
    docs = None
    if isinstance(results, dict):
        for key, block in results.items():
            if isinstance(block, dict) and isinstance(block.get("documents"), list):
                # the product block is the shop's catalogue, not places
                if key != "product":
                    docs = block["documents"]
                    break
    if not docs:
        notes.append("FATAL-SHAPE: no non-product documents block in results")
        return [], notes

    out, unmapped_zone, unmapped_cat, no_pairs = [], set(), set(), []
    for doc in docs:
        # `title` is the outlet name. `cmsTag.headline` repeats it and is the
        # one I first mistook for the field -- it sits nested inside the CMS
        # block and is not always present.
        name = str(doc.get("title") or "").strip()
        if not name:
            continue
        pairs = _terminals(doc)
        if not pairs:
            no_pairs.append(name)
            continue

        cats_raw = [str(c) for c in (doc.get("category") or [])]
        cats = []
        for c in cats_raw:
            key = c.strip().lower()
            if key in CATEGORY_MAP:
                if CATEGORY_MAP[key] not in cats:
                    cats.append(CATEGORY_MAP[key])
            else:
                unmapped_cat.add(c)

        slug = str(doc.get("id") or doc.get("url") or name).strip()
        for terminal, zone_words in pairs:
            zone = ZONE_MAP.get(zone_words.strip().lower())
            if zone is None:
                unmapped_zone.add(zone_words)
                zone = "unknown"
            explicit = zone != "unknown"
            out.append(Dining(
                airport=AIRPORT,
                name=name,
                # THE BRAND'S OWN SLUG PLUS THE PAIR. A brand appears once per
                # location, so the id has to name the location too or the diff
                # cannot tell seven Caffe Neros apart.
                source_id="%s|%s/%s" % (slug, terminal, zone_words.replace(" ", "")),
                terminal_raw=terminal,
                terminal=("T" + terminal) if terminal.isdigit() else terminal.upper(),
                level="",
                area="",
                gate_hint="",
                is_airside={"departures_airside": True,
                            "departures_landside": False}.get(zone),
                zone=zone,
                security_raw=zone_words if explicit else "",
                security_basis="explicit" if explicit else "unknown",
                flight_scope="",   # this source does not distinguish
                category_raw="|".join(cats_raw),
                category="|".join(cats),
                serve_minutes=None,   # this source does not publish it
                hours_raw="",       # not on this endpoint; the detail page has it
                hours=[],
                is_24h=False,
                lat=None, lon=None,
                source_url=SOURCE_URL,
                scraped_at=scraped_at,
                source_updated_at="",
            ))

    if no_pairs:
        notes.append("%d brand(s) had no terminalArea and were dropped: %s"
                     % (len(no_pairs), ", ".join(no_pairs[:4])))
    if unmapped_zone:
        notes.append("ZONE WORDS NOT IN ZONE_MAP (recorded as unknown): %s"
                     % sorted(unmapped_zone))
    if unmapped_cat:
        notes.append("categories not in CATEGORY_MAP: %s" % sorted(unmapped_cat)[:12])
    arrivals = sum(1 for r in out if r.zone == "arrivals")
    if arrivals:
        notes.append("%d row(s) are arrivals-zone: reachable after landing, "
                     "not on a layover" % arrivals)
    return out, notes
