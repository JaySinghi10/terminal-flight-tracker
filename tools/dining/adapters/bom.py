"""Mumbai, Chhatrapati Shivaji Maharaj International.

THE RICHEST SOURCE OF THE FIVE, and the only one that crosses the security zone
with the domestic/international split.

THE HOSTNAME IS csmia-mumbai.adaniairports.com. Two others are commonly cited --
csmia.adaniairports.com and csmia.aero -- and NEITHER RESOLVES. That cost a round
of "site is down" before it turned out to be a wrong name.

THE LISTING IS NOT IN THE PAGE. The dining page is a 56KB shell showing six
cards; the rest arrives from a Sitecore controller, found by reading
/assets/mumbai/js/Dining-Search.js rather than by guessing:

    POST /api/sitecore/Dining/Search        Content-Type: application/json
    {"DataSourceId": "{EC4EEF34-...}", "Category": "", "Terminal": "",
     "Area": "<guid>", "SearchText": "", "PageSize": "500",
     "PageNumber": "1", "isLoadMore": false}
    -> {"TotalItems": 84, "DiningFolderHtml": "<fragment>"}

PageSize IS OURS TO SET, so the whole list comes back in one request instead of
fourteen. That is fewer requests than a visitor clicking "Load more" makes.

A CARD IS A BRAND WITH SEVERAL ADDRESSES, exactly as at Heathrow:

    Baker Street (T2)
      P10,Level 4, Landside
      P10, Level 4, Check in Area
      Level 3 ,Post Security Hold Area
      Level 4 ,  Post Security Hold Area

-- landside AND airside at once. One is_airside for that brand would be wrong
whichever value it took, so every <li class="address"> becomes its own row.

THE ZONE IS IN THE ADDRESS STRING, in the airport's own words: "Post Security
Hold Area", "Check-in Area", "Landside", "Arrival Forecourt", "Arrival Hall".
That is per-address and explicit.

AND DOMESTIC/INTERNATIONAL IS BRAND-LEVEL, WHICH IS A REAL LIMIT. The Area filter
narrows which BRANDS come back, not which of a brand's addresses: Baker Street
returns all four counters under both Domestic Departures and International
Departures. So flight_scope says what the BRAND serves. Pretending otherwise
would invent precision the source does not have.
"""
import io
import json
import os
import re
import time
import urllib.request

from schema import Dining

AIRPORT = "BOM"
PAGE_URL = "https://csmia-mumbai.adaniairports.com/en/shop-and-dine/dining"
SOURCE_URL = "https://csmia-mumbai.adaniairports.com/api/sitecore/Dining/Search"
DATA_SOURCE_ID = "{EC4EEF34-B2E1-4A9D-95C2-4CEDF348C00C}"

# The Area dropdown's own values. The arrivals/departures half of each is NOT
# used for the zone -- the address string says that per location, and more
# precisely. Only the domestic/international half is read from these.
AREAS = {
    "Domestic Arrivals": "3f59b095-2fcb-44c1-8078-7ca90cac5983",
    "Domestic Departures": "9721056d-dd57-45e9-b460-528465992e9e",
    "International Arrivals": "9008c770-8478-4a16-b1be-8821b8dcb861",
    "International Departures": "d1f7e171-47e1-455b-9f1f-9301ea0c56f8",
}

# Address phrasing -> zone. Ordered: "post security" must be tested before the
# arrivals words, because "Post Security Hold Area" can sit in an arrivals pier
# and the security status is the more useful of the two facts.
ZONE_RULES = [
    (re.compile(r"post\s*security", re.I), "departures_airside"),
    (re.compile(r"arrival\s*(forecourt|hall)", re.I), "arrivals"),
    (re.compile(r"check[\s-]*in\s*area", re.I), "departures_landside"),
    (re.compile(r"\blandside\b", re.I), "departures_landside"),
]

CATEGORY_MAP = {
    "qsr": "fast_food",
    "quick bites": "fast_food",
    "snacks": "fast_food",
    "bar & restaurant": "bar",
    "bar and restaurant": "bar",
    "coffee shop": "cafe",
    "cafe": "cafe",
    "bakery": "bakery",
    "dessert": "dessert",
    "food court": "food_court",
    "foodcourt": "food_court",
    "lounge": "lounge",
    "fine dining": "western",
    "restaurant": "western",
}

CARD_RE = re.compile(r'(?=<div class="terminalCard scale-anm")')
NAME_RE = re.compile(r"<h4>([^<]*)</h4>")
TAGS_RE = re.compile(r'<div class="tags">(.*?)</div>', re.S)
SPAN_RE = re.compile(r"<span>([^<]*)</span>")
TAB_RE = re.compile(r'data-bs-target="#([^"]+)"[^>]*>([^<]*)</a>')
PANE_RE = r'<div class="tab-pane[^"]*" id="%s"[^>]*>(.*?)(?=<div class="tab-pane|</div>\s*</div>\s*</div>\s*</div>)'
ADDR_RE = re.compile(r'<li class="address">(.*?)</li>', re.S)
TERM_RE = re.compile(r"Terminal\s*([0-9A-Za-z]+)", re.I)
GATE_RE = re.compile(r"Gate\s*(?:No\.?\s*)?([0-9]+(?:\s*-\s*[0-9]+)?)", re.I)
LEVEL_RE = re.compile(r"\bLevel\s*([0-9A-Za-z]+)", re.I)


def _post(area_guid, ua):
    body = json.dumps({
        "DataSourceId": DATA_SOURCE_ID, "Category": "", "Terminal": "",
        "Area": area_guid, "SearchText": "",
        "PageSize": "500", "PageNumber": "1", "isLoadMore": False,
    }).encode("utf8")
    req = urllib.request.Request(SOURCE_URL, data=body, headers={
        "User-Agent": ua, "Content-Type": "application/json",
        "Accept": "application/json", "Referer": PAGE_URL,
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf8"))


def fetch(cache_path, offline, user_agent, entry=None):
    """One unfiltered request for the list, then one per Area for the scope.

    Five requests, spaced. A visitor clicking through "Load more" and the four
    filters makes more than that.
    """
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return io.open(cache_path, "rb").read()

    out = {"all": _post("", user_agent)}
    for label, guid in AREAS.items():
        time.sleep(3)
        out[label] = _post(guid, user_agent)

    body = json.dumps(out, ensure_ascii=False).encode("utf8")
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return body


def _text(fragment):
    import html as H
    return " ".join(H.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def _brands(payload):
    """{brand name: card html} from one response."""
    html_blob = (payload or {}).get("DiningFolderHtml") or ""
    out = {}
    for card in CARD_RE.split(html_blob)[1:]:
        m = NAME_RE.search(card)
        if m:
            # UNESCAPED, like the tags. The h4 holds raw HTML, so an apostrophe
            # arrives as &#39; and "Foody's" was being stored -- and keyed -- as
            # "Foody&#39;s".
            out[_text(m.group(1))] = card
    return out


def parse(raw, scraped_at, entry=None):
    notes = []
    if not isinstance(raw, dict) or "all" not in raw:
        notes.append("FATAL-SHAPE: expected the 'all' response plus one per Area")
        return [], notes

    everything = _brands(raw["all"])
    total = (raw["all"] or {}).get("TotalItems")
    if total is not None and len(everything) != total:
        notes.append("TotalItems says %s but %d cards parsed" % (total, len(everything)))

    # Which brands each Area returned -> the domestic/international half only.
    scope = {}
    for label in AREAS:
        payload = raw.get(label)
        if payload is None:
            notes.append("no response captured for area %r" % label)
            continue
        kind = "domestic" if label.startswith("Domestic") else "international"
        for name in _brands(payload):
            scope.setdefault(name, set()).add(kind)

    out, unmapped_zone, unmapped_cat, no_addr = [], set(), set(), []
    for name, card in everything.items():
        tags_block = TAGS_RE.search(card)
        # UNESCAPED. The tags arrive as raw HTML, so "Bar &amp; Restaurant" would
        # never match a map keyed on "bar & restaurant" and would be reported as
        # a new category on every single run.
        cats_raw = ([_text(t) for t in SPAN_RE.findall(tags_block.group(1))]
                    if tags_block else [])
        cats = []
        for c in cats_raw:
            key = c.strip().lower()
            if key in CATEGORY_MAP:
                if CATEGORY_MAP[key] not in cats:
                    cats.append(CATEGORY_MAP[key])
            else:
                unmapped_cat.add(c)

        kinds = scope.get(name, set())
        flight_scope = ("both" if len(kinds) == 2
                        else (next(iter(kinds)) if kinds else ""))

        # Each terminal tab holds that terminal's addresses.
        tabs = TAB_RE.findall(card)
        found_any = False
        for pane_id, tab_label in tabs:
            pane = re.search(PANE_RE % re.escape(pane_id), card, re.S)
            if not pane:
                continue
            tm = TERM_RE.search(tab_label)
            terminal = ("T" + tm.group(1).upper()) if tm else ""
            for addr_html in ADDR_RE.findall(pane.group(1)):
                addr = _text(addr_html)
                if not addr:
                    continue
                found_any = True
                zone = "unknown"
                for rule, value in ZONE_RULES:
                    if rule.search(addr):
                        zone = value
                        break
                if zone == "unknown":
                    unmapped_zone.add(addr)

                gate = GATE_RE.search(addr)
                level = LEVEL_RE.search(addr)
                explicit = zone != "unknown"
                out.append(Dining(
                    airport=AIRPORT,
                    name=name,
                    # THE WHOLE ADDRESS, NOT A PREFIX OF IT. Truncating to 28
                    # characters collapsed seven pairs of outlets at Mumbai:
                    # "Level 3, Post Security Hold Area - Gate 41" and the same
                    # string ending "Gate 45" share their first 28 characters, so
                    # two real counters became one key and the diff went blind to
                    # both. The runner said so on every run -- "CANNOT DIFF: 7
                    # records share a key" -- and it was read past twice.
                    source_id="%s|%s|%s" % (name.lower().replace(" ", "-"),
                                            terminal, re.sub(r"\W+", "", addr)),
                    terminal_raw=tab_label.strip(),
                    terminal=terminal,
                    level=("Level " + level.group(1)) if level else "",
                    area=addr,
                    gate_hint=(re.sub(r"\s+", "", gate.group(1)) if gate else ""),
                    is_airside={"departures_airside": True,
                                "departures_landside": False}.get(zone),
                    zone=zone,
                    flight_scope=flight_scope,
                    security_raw=addr if explicit else "",
                    security_basis="explicit" if explicit else "unknown",
                    category_raw="|".join(cats_raw),
                    category="|".join(cats),
                    serve_minutes=None,   # this source does not publish it
                    hours_raw="",
                    hours=[],
                    is_24h=False,
                    lat=None, lon=None,
                    source_url=SOURCE_URL,
                    scraped_at=scraped_at,
                    source_updated_at="",
                ))
        if not found_any:
            no_addr.append(name)

    if no_addr:
        notes.append("%d brand(s) had no address rows and were dropped: %s"
                     % (len(no_addr), ", ".join(no_addr[:5])))
    if unmapped_zone:
        notes.append("ADDRESS PHRASINGS NOT IN ZONE_RULES (recorded as unknown): %s"
                     % sorted(unmapped_zone)[:6])
    if unmapped_cat:
        notes.append("categories not in CATEGORY_MAP: %s" % sorted(unmapped_cat)[:12])
    scoped = sum(1 for r in out if r.flight_scope)
    notes.append("flight_scope set on %d/%d rows (brand-level: %s)"
                 % (scoped, len(out),
                    ", ".join("%s=%d" % (k, sum(1 for r in out if r.flight_scope == k))
                              for k in ("domestic", "international", "both"))))
    return out, notes
