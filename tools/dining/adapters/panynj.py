"""The Port Authority of New York and New Jersey -- JFK, EWR and LGA.

ONE PLATFORM, THREE AIRPORTS. All three run the same site: the same
/api/graphql, the same "Area in Terminal" filter, the same POI shape. Only the
host, the terminal names and the list of things that are not terminals differ,
so all three come from this file and the manifest carries the differences.

THE SECURITY ZONE IS A QUESTION, NOT A FIELD, and that is what makes this
airport workable. A POI carries:

    category, description, floorName, id, images, mapUrl, name,
    nearbyLandmark, structureName

-- no security attribute anywhere. But the same response carries:

    "availableTerminalAreas": ["After Security", "Before Security"]

...which is a FILTER the client sends. So the zone is obtained by asking twice
and labelling each answer by the question: everything returned under "After
Security" is airside because JFK says so. That keeps security_basis "explicit"
and means this airport needs no inference at all -- which matters, because
inferring airside from a gate number is the thing we agreed not to ship
unmeasured.

WHY THIS ADAPTER FETCHES ITSELF. The list is the answer to a GraphQL query the
page builds and compresses, so there is no URL to hand the runner. It drives the
site's own filter UI instead, which asks exactly the questions a visitor's
browser asks, and reads the answers off the wire.

AND NOT EVERY "LOCATION" IS A TERMINAL. availableLocations includes
"Jamaica Station (AirTrain)", "Federal Circle Station" and "TWA Hotel" -- three
of eight. A station cafe is not a layover option, and shipping one as airport
dining is the Jewel mistake with a different name. They are excluded here and
the manifest's expect_terminals refuses them again if this list ever changes.
"""
import io
import json
import os
import re

from schema import Dining

# Per-airport values live in the manifest. Defaults are JFK's, so a missing
# entry fails loudly on the terminal check rather than quietly scraping Queens.
DEFAULT_PAGE = "https://www.jfkairport.com/dine-shop-relax/food"


def _cfg(entry):
    entry = entry or {}
    page = entry.get("page_url") or DEFAULT_PAGE
    host = page.split("/")[2]
    return {
        "code": entry.get("code", "JFK"),
        "page": page,
        "graphql": "https://%s/api/graphql" % host,
        # WHAT IS NOT A TERMINAL, PER AIRPORT AND MEASURED. JFK's location list
        # names eight places and three are not terminals -- Jamaica Station
        # (AirTrain), Federal Circle Station and the TWA Hotel. EWR's is
        # ["Terminal A","Terminal B","Terminal C"] and LGA's is ["Terminal B",
        # "Terminal C"]: nothing to exclude at either, checked rather than
        # assumed. The manifest may override; the default is JFK's.
        "non_terminal": {s.lower() for s in (entry.get("non_terminal") or [
            "jamaica station (airtrain)", "federal circle station", "twa hotel",
            "airtrain", "long term parking",
        ])},
    }

# JFK's own words for the two zones, and what they mean to us.
ZONE_MAP = {
    "After Security": "departures_airside",
    "Before Security": "departures_landside",
}

TERMINAL_RE = re.compile(r"^\s*Terminal\s+([0-9A-Za-z]+)\s*$", re.I)

# THE POI CATEGORY IS A DOTTED SLUG, NOT THE FILTER LABEL. The page's filter
# chips read "Pizza & Italian", "Coffee & Tea" and so on, but a POI carries a
# coarse machine value -- "eat", "eat.bar", "eat.coffee", "eat.vending", "shop".
# Mapping the chips was a guess from the wrong half of the page; this is what
# the records actually contain.
CATEGORY_MAP = {
    "eat": "other",             # no cuisine published at POI level
    "eat.bar": "bar",
    "eat.coffee": "cafe",
    # KEPT, AND DISTINGUISHABLE. A vending machine is a real option on a tight
    # connection; it is not a restaurant. Its own category is what lets the app
    # label it honestly instead of dressing it up as one -- mapping it to
    # "other" would have buried it among outlets whose cuisine merely went
    # unpublished.
    "eat.vending": "vending",
}

# ── SHOPS ARE NOT DINING ────────────────────────────────────────────────────
#
# THE ENDPOINT SERVES /dine-shop-relax AND RETURNS BOTH. Forty-four of the 201
# POIs are `shop` -- BKLYN Shopping Duty Free, Chocolate & More, Bryant Park
# Market. A duty-free counter is not somewhere to eat on a layover, and shipping
# it as dining is the same category error as shipping a landside cafe as airside.
DROP_CATEGORIES = {"shop"}


def fetch(cache_path, offline, user_agent, entry=None):
    cfg = _cfg(entry)
    """Ask the site both questions and keep every answer.

    Returns a JSON document of our own shape -- {"After Security": [...],
    "Before Security": [...]} -- because there is no single upstream response to
    cache. That file is the raw body for every purpose downstream: it is what
    --offline replays and what a parser change is reviewed against.
    """
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return io.open(cache_path, "rb").read()

    from playwright.sync_api import sync_playwright

    collected = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(locale="en-US", user_agent=user_agent,
                                  viewport={"width": 1440, "height": 1200})
        page = ctx.new_page()
        seen = []

        def on_resp(r):
            if "/api/graphql" not in r.url:
                return
            try:
                body = r.json()
            except Exception:
                return
            pois = (((body or {}).get("data") or {}).get("getDinePOIs") or {})
            if isinstance(pois.get("results"), list):
                seen.append(pois)

        page.on("response", on_resp)
        page.goto(cfg["page"], wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)

        for label in ZONE_MAP:
            seen.clear()
            # The zone control is a native select labelled "Area in Terminal".
            try:
                page.select_option("select:below(:text('Area in Terminal'))", label=label)
            except Exception:
                page.get_by_label("Area in Terminal").select_option(label=label)
            page.wait_for_timeout(6000)

            # LOAD EVERYTHING. The list pages twelve at a time; the button is the
            # only way to reach the rest, and a partial list would look like a
            # complete one.
            for _ in range(40):
                try:
                    more = page.get_by_role("button", name=re.compile(r"load more|show more", re.I))
                    if more.count() == 0 or not more.first.is_enabled():
                        break
                    more.first.click()
                    page.wait_for_timeout(2500)
                except Exception:
                    break

            rows, ids = [], set()
            for block in seen:
                for poi in block.get("results") or []:
                    key = str(poi.get("id"))
                    if key not in ids:
                        ids.add(key)
                        rows.append(poi)
            collected[label] = rows

        browser.close()

    body = json.dumps(collected, indent=1, ensure_ascii=False).encode("utf8")
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return body


def parse(raw, scraped_at, entry=None):
    cfg = _cfg(entry)
    notes = []
    if not isinstance(raw, dict) or not raw:
        notes.append("FATAL-SHAPE: expected a map of zone label -> results")
        return [], notes

    out, dropped, unmapped, both, shops = [], [], set(), [], []
    seen_ids = {}
    for label, rows in raw.items():
        zone = ZONE_MAP.get(label)
        if zone is None:
            notes.append("unknown zone label from the filter: %r" % label)
            continue
        if not rows:
            notes.append("the %r filter returned nothing" % label)
        for poi in rows:
            structure = str(poi.get("structureName") or "").strip()
            if structure.lower() in cfg["non_terminal"]:
                dropped.append("%s (%s)" % (poi.get("name"), structure))
                continue
            m = TERMINAL_RE.match(structure)
            if not m:
                dropped.append("%s (%s)" % (poi.get("name"), structure or "no structure"))
                continue

            poi_id = str(poi.get("id") or "")
            # A POI RETURNED UNDER BOTH FILTERS WOULD BE A CONTRADICTION, and
            # silently keeping the last one would pick a zone by dict order.
            if poi_id in seen_ids and seen_ids[poi_id] != zone:
                both.append(str(poi.get("name")))
                continue
            seen_ids[poi_id] = zone

            cats_raw = [str(c) for c in (poi.get("category") or [])] \
                if isinstance(poi.get("category"), list) else \
                ([str(poi.get("category"))] if poi.get("category") else [])
            if any(c.strip().lower() in DROP_CATEGORIES for c in cats_raw):
                shops.append(str(poi.get("name")))
                continue
            cats = []
            for c in cats_raw:
                key = c.strip().lower()
                if key in CATEGORY_MAP:
                    if CATEGORY_MAP[key] not in cats:
                        cats.append(CATEGORY_MAP[key])
                else:
                    unmapped.add(c)

            landmark = str(poi.get("nearbyLandmark") or "")
            gate = re.search(r"Gates?\s+([0-9]+(?:\s*(?:and|-|–|to)\s*[0-9]+)?)", landmark, re.I)

            out.append(Dining(
                airport=cfg["code"],
                name=str(poi.get("name") or "").strip(),
                source_id=poi_id,
                terminal_raw=structure,
                terminal="T" + m.group(1).upper(),
                level=str(poi.get("floorName") or ""),
                area=landmark,
                gate_hint=(re.sub(r"\s+", "", gate.group(1)) if gate else ""),
                is_airside=(zone == "departures_airside"),
                zone=zone,
                # THE QUESTION IS THE EVIDENCE. There is no field to quote, so
                # security_raw carries the filter label the airport answered to.
                security_raw=label,
                security_basis="explicit",
                flight_scope="",   # this source does not distinguish
                category_raw="|".join(cats_raw),
                category="|".join(cats),
                serve_minutes=None,   # this source does not publish it
                hours_raw="",
                hours=[],
                is_24h=False,
                lat=None, lon=None,
                source_url=cfg["graphql"],
                scraped_at=scraped_at,
                source_updated_at="",
            ))

    if dropped:
        notes.append("dropped %d POI(s) outside a terminal: %s"
                     % (len(dropped), "; ".join(dropped[:5])))
    if both:
        notes.append("CONTRADICTION: %d POI(s) appeared under BOTH filters and were "
                     "dropped: %s" % (len(both), ", ".join(both[:5])))
    if shops:
        notes.append("dropped %d retail POI(s) -- this endpoint serves shops too: %s"
                     % (len(shops), ", ".join(shops[:4])))
    vending = sum(1 for r in out if r.category == "vending")
    if vending:
        notes.append("%d vending machine(s) kept, categorised as 'vending'" % vending)
    if unmapped:
        notes.append("categories not in CATEGORY_MAP: %s" % sorted(unmapped)[:12])
    return out, notes
