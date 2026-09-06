"""Swedavia -- one adapter, four Swedish airports.

THE CLEANEST SOURCE FOUND ANYWHERE, and it says the word:

    "spotsInfo": [{
        "name": "60 Bar & Brewery",
        "securityLocation": "airside",
        "terminal": {"id": "5", "name": "Terminal 5", "shortName": "5"},
        "gateAreaName": "Gate E1",
        "businessHours": [{"businessHours": "06.00-22.00", "period": "Daily"}]
    }]

securityLocation IS LITERALLY "airside" OR "landside". No inference, no filter to
drive, no cross-referencing an address string -- the airport publishes the fact
this whole dataset is built around, per location, as a word.

THE ENDPOINT IS /services/rfb/{blockId}/{lang} AND THE BLOCK ID IS DISCOVERED,
NOT HARDCODED. Each airport's food-beverages page carries block-id="NNNNNNN" on
the listing element, and that number is the endpoint's only variable. Hardcoding
four ids would mean four silent breakages the first time Swedavia republishes a
page; reading it costs one extra request and cannot go stale.

typeOfService IS "restaurant" ON EVERY ROW of every airport checked, so unlike
JFK this feed does not mix shops in. It is still asserted rather than assumed --
if a "shop" ever appears it is dropped and reported.

WHAT THE NETWORK IS ACTUALLY WORTH, measured rather than claimed:

    ARN  Stockholm Arlanda    41 brands   <- essentially the whole value
    LLA  Lulea                 4
    MMX  Malmo                 2
    BMA  Stockholm Bromma      1
    UME, RNB, KRN              no listing block at all

Four airports from one adapter, and 85% of it is Arlanda. Worth having, but it
is not the five-airports-for-one-adapter that the network framing suggests.
"""
import io
import json
import os
import re
import time
import urllib.request

from schema import Dining

SOURCE_TMPL = "https://www.swedavia.com/services/rfb/%s/en"
PAGE_TMPL = "https://www.swedavia.com/%s/food-beverages/"
BLOCK_RE = re.compile(r'block-id="(\d{5,9})"')

# securityLocation -> zone. Swedavia publishes no arrivals concept, so these two
# are the whole vocabulary; anything else is reported rather than guessed at.
ZONE_MAP = {
    "airside": "departures_airside",
    "landside": "departures_landside",
}

# Swedavia's tags are FACETS, not a cuisine taxonomy: dietary flags, drinks,
# meal times, the terminal, and a time-to-serve estimate. Only the ones that say
# what KIND OF PLACE it is are mapped.
CATEGORY_MAP = {
    "restaurant": "western", "restaurang": "western",
    "traditional swedish food": "western", "pasta": "western",
    "pizza": "western", "tapas": "western",
    "café": "cafe", "cafe": "cafe", "kafe": "cafe", "coffee": "cafe",
    "bar": "bar", "pub": "bar", "brewery": "bar",
    "fast food": "fast_food", "snabbmat": "fast_food",
    "take away": "fast_food", "kiosk": "fast_food",
    "hamburger": "fast_food", "snacks": "fast_food",
    "bakery": "bakery", "bageri": "bakery",
    "dessert": "dessert", "icecream": "dessert", "candy": "dessert",
    "vegetarian": "vegetarian", "vegan": "vegetarian",
    "lounge": "lounge",
}

# Facets that say nothing about what kind of place it is. Listed so the unmapped
# report only ever names something genuinely new.
#
# NOTE FOR LATER: "5 minutes" / "15 minutes" / "20 minutes" is Swedavia's own
# TIME-TO-SERVE estimate -- the single most directly useful field anybody
# publishes for "what can I eat in the time I have", and the only source in the
# set that has it. Not modelled yet; worth its own field if a second airport ever
# publishes the same thing.
# THEIR OWN TIME-TO-SERVE ESTIMATE, and the only source anywhere that publishes
# one. A tag reading "15 minutes" means fifteen minutes to be served, which is
# the half of "where can I eat" that a clock decides.
SERVE_RE = re.compile(r"^\s*(\d{1,3})\s*minutes?\s*$", re.I)

IGNORE_TAGS = {
    "lactose-free", "gluten-free", "child-friendly", "food and beverages",
    "beer", "wine", "tea", "lunch", "dinner", "breakfast", "fika",
    "salad", "sandwich", "buffet",
    "5 minutes", "15 minutes", "20 minutes",
    "after security control", "before security control", "after passport control",
    "skycity", "arlanda",
}

# ── SKYCITY IS NOT A TERMINAL ───────────────────────────────────────────────
#
# TEN OF ARLANDA'S SEVENTY-FIVE SPOTS SIT IN "skycity", the landside hotel and
# shopping complex between Terminals 4 and 5. It is the same trap as Jewel at
# Changi and The Squaire at Frankfurt: attached to the airport, outside security,
# and useless to a connecting passenger. The terminal object names it, so it is
# caught by name here and by expect_terminals in the manifest afterwards.
NON_TERMINAL_SHORTNAMES = {"skycity"}

# "06.00-22.00" -> ("06:00", "22:00"). Swedavia writes times with a full stop,
# which is Swedish convention and not a typo to normalise away silently -- and
# mixes a hyphen with an EN DASH, which is the sort of thing that quietly halves
# a dataset if only one is matched.
HOURS_RE = re.compile(r"^\s*(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2})\s*$")

# Which days a period label covers. Only the unambiguous ones: "Sunday-Friday"
# wraps the week and is left to its human string rather than guessed at.
PERIODS = {
    "daily": (0, 6), "every day": (0, 6),
    "24 hours a day, 7 days a week": (0, 6),
    "monday-friday": (0, 4), "monday–friday": (0, 4),
    "saturday-sunday": (5, 6), "saturday–sunday": (5, 6),
    "saturday": (5, 5), "sunday": (6, 6),
}


def _block_id(slug, user_agent):
    """The listing block's id, read off the airport's own food page."""
    req = urllib.request.Request(PAGE_TMPL % slug, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=45) as r:
        html = r.read().decode("utf8", errors="replace")
    m = BLOCK_RE.search(html)
    return m.group(1) if m else None


def fetch(cache_path, offline, user_agent, entry=None):
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return io.open(cache_path, "rb").read()

    slug = (entry or {}).get("slug")
    if not slug:
        raise RuntimeError("manifest entry needs a `slug` (the swedavia.com path segment)")

    block = _block_id(slug, user_agent)
    if block is None:
        # NOT AN EXCEPTION. An airport with no listing block is a real state --
        # Umea, Ronneby and Kiruna have none -- and it should reach the runner as
        # an empty result it can refuse, not as a crash.
        body = json.dumps({"_slug": slug, "_block_id": None, "rfbList": []}).encode("utf8")
    else:
        time.sleep(2)
        req = urllib.request.Request(SOURCE_TMPL % block, headers={
            "User-Agent": user_agent, "Accept": "application/json",
            "Referer": PAGE_TMPL % slug,
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode("utf8"))
        payload["_slug"] = slug
        payload["_block_id"] = block
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return body


def _hours(spot):
    """(structured windows, human string) from businessHours.

    ONLY THE UNAMBIGUOUS ONES ARE STRUCTURED. "Daily 06.00-22.00" maps cleanly to
    Monday-Sunday; anything with a period this does not recognise keeps its human
    string and contributes no window, because a half-understood opening time is
    worse than none -- see the note in run.py.
    """
    windows, human = [], []
    for b in spot.get("businessHours") or []:
        times = str(b.get("businessHours") or "").strip()
        period = str(b.get("period") or "").strip()
        if times:
            human.append(" ".join(p for p in (period, times) if p))
        m = HOURS_RE.match(times)
        days = PERIODS.get(period.strip().lower())
        if m and days:
            windows.append({"start_day": days[0], "end_day": days[1],
                            "open": "%02d:%s" % (int(m.group(1)), m.group(2)),
                            "close": "%02d:%s" % (int(m.group(3)), m.group(4))})
    return windows, "; ".join(human)


def parse(raw, scraped_at, entry=None):
    notes = []
    code = (entry or {}).get("code", "")
    rows = (raw or {}).get("rfbList")
    if not isinstance(rows, list):
        notes.append("FATAL-SHAPE: no rfbList in the response")
        return [], notes
    if raw.get("_block_id") is None:
        notes.append("no block-id on the food page: this airport publishes no listing")
        return [], notes
    if not rows:
        notes.append("block %s returned an empty rfbList" % raw.get("_block_id"))

    source_url = SOURCE_TMPL % raw.get("_block_id")
    out, unmapped_zone, unmapped_cat, no_spots, dropped_type = [], set(), set(), [], []
    skycity, no_zone = [], []

    for brand in rows:
        kind = str(brand.get("typeOfService") or "").strip().lower()
        if kind and kind != "restaurant":
            dropped_type.append("%s (%s)" % (brand.get("name"), kind))
            continue
        name = str(brand.get("name") or "").strip()
        spots = brand.get("spotsInfo") or []
        if not spots:
            no_spots.append(name)
            continue

        # The category vocabulary is thin here; tags are the only hint and are
        # often empty, so most rows carry "other" honestly rather than a guess.
        # TAGS ARE OBJECTS, NOT STRINGS. Each is a full node with id, parentId,
        # title and an isHidden flag; str()-ing them produced a "category" that
        # was a whole Python dict repr and matched nothing.
        tags = [str(t.get("title") or "").strip()
                for t in (brand.get("tags") or [])
                if isinstance(t, dict) and t.get("title")]
        cats = []
        for t in tags:
            key = t.strip().lower()
            if key in CATEGORY_MAP:
                if CATEGORY_MAP[key] not in cats:
                    cats.append(CATEGORY_MAP[key])
            elif key not in IGNORE_TAGS and not key.startswith("terminal"):
                unmapped_cat.add(t)
        if not cats:
            cats = ["other"]

        # SMALLEST WINS WHERE A BRAND CARRIES SEVERAL. Two tags means two counters
        # of one chain quoting different times; the quicker is the one that can
        # still feed somebody on a short connection, and claiming the slower would
        # rule out an option that exists.
        serve = None
        for t in tags:
            m = SERVE_RE.match(t)
            if m:
                v = int(m.group(1))
                serve = v if serve is None else min(serve, v)

        for i, spot in enumerate(spots):
            terminal_short = str((spot.get("terminal") or {}).get("shortName") or "").strip()
            if terminal_short.lower() in NON_TERMINAL_SHORTNAMES:
                skycity.append("%s (%s)" % (name, terminal_short))
                continue

            sec = str(spot.get("securityLocation") or "").strip().lower()
            # A SPOT WITH NO ZONE IS DROPPED, NOT SHIPPED AS "unknown". This feed
            # is otherwise complete, so a blank is a gap rather than a source that
            # does not publish the fact -- and an unplaceable outlet is exactly
            # what must not reach a connecting passenger.
            if sec not in ZONE_MAP:
                if sec:
                    unmapped_zone.add(sec)
                no_zone.append(name)
                continue
            zone = ZONE_MAP[sec]
            explicit = True

            terminal_obj = spot.get("terminal") or {}
            short = terminal_short
            terminal = ("T" + short) if short else ""
            windows, hours_human = _hours(spot)
            gate_area = str(spot.get("gateAreaName") or "").strip()
            gate = re.search(r"Gate\s*([0-9A-Z]+)", gate_area, re.I)

            out.append(Dining(
                airport=code,
                name=(str(spot.get("name") or "").strip() or name),
                # itemId names the BRAND; a brand can hold several spots, so the
                # index is what tells two counters of one chain apart.
                source_id="%s-%d" % (brand.get("itemId") or name.lower(), i),
                terminal_raw=str(terminal_obj.get("name") or ""),
                terminal=terminal,
                level="",
                area=gate_area,
                gate_hint=(gate.group(1) if gate else ""),
                is_airside={"departures_airside": True,
                            "departures_landside": False}.get(zone),
                zone=zone,
                flight_scope="",
                serve_minutes=serve,
                security_raw=sec if explicit else "",
                security_basis="explicit" if explicit else "unknown",
                category_raw="|".join(tags),
                category="|".join(cats),
                hours_raw=hours_human,
                hours=windows,
                is_24h=any(w["open"] == "00:00" and w["close"] in ("24:00", "00:00")
                           for w in windows),
                lat=None, lon=None,
                source_url=source_url,
                scraped_at=scraped_at,
                source_updated_at="",
            ))

    if dropped_type:
        notes.append("dropped %d non-restaurant row(s): %s"
                     % (len(dropped_type), ", ".join(dropped_type[:4])))
    if no_spots:
        notes.append("%d brand(s) had no spotsInfo: %s" % (len(no_spots), ", ".join(no_spots[:4])))
    if skycity:
        notes.append("dropped %d SkyCity spot(s) -- landside mall, not a terminal: %s"
                     % (len(skycity), ", ".join(skycity[:4])))
    if unmapped_zone:
        notes.append("SECURITY WORDS NOT IN ZONE_MAP: %s" % sorted(unmapped_zone))
    if no_zone:
        notes.append("dropped %d spot(s) publishing no securityLocation: %s"
                     % (len(no_zone), ", ".join(no_zone[:4])))
    if unmapped_cat:
        notes.append("tags not in CATEGORY_MAP: %s" % sorted(unmapped_cat)[:10])
    structured = sum(1 for r in out if r.hours)
    timed = sum(1 for r in out if r.serve_minutes is not None)
    notes.append("structured hours on %d/%d rows; time-to-serve on %d"
                 % (structured, len(out), timed))
    return out, notes
