"""Fetch, validate, diff, and only then publish.

    python tools/dining/run.py            # every airport in the manifest
    python tools/dining/run.py hkg        # one
    python tools/dining/run.py --offline  # re-derive from the cached raw file

THE ONE RULE THIS FILE EXISTS FOR: A RUN MUST NEVER REPLACE GOOD DATA WITH
NOTHING. Ten airport websites will be redesigned, rate-limited, moved and broken
over the life of this dataset, and the dangerous failure is not a crash -- a
crash is loud. It is a selector that starts matching zero elements and quietly
ships an empty list, or a source that starts returning "Non-restricted" where it
used to say "Restricted" and silently inverts the one fact the feature depends
on. So every run is staged, checked against the previous run, and promoted only
if it passes:

  * MINIMUM COUNT. The manifest records what each airport returned when it last
    worked. A run yielding under `min_ratio` of that keeps the old data.
  * FIELD COVERAGE. Fields that are 100% populated today must stay populated.
    A parser that starts returning "" everywhere fails here rather than shipping.
  * SCHEMA. Every record is checked; a run with any invalid record is refused.
  * A DIFF, printed every time. "77 -> 3" is visible; a quiet shrink is not.

HOURS ARE STORED VERBATIM AND NEVER PARSED HERE. HKG alone mixes a hyphen with
an en dash and appends "(Last order: 20:30)"; ten airports will have ten
dialects, in local time, with holiday exceptions. Turning that into open/close
instants is a decision about a passenger's evening, and it belongs in the app
against a known airport timezone -- not in a scraper that would bake a wrong
guess into a static file.

POLITENESS IS NOT OPTIONAL. One request per source, a real browser User-Agent, a
pause between airports, and the raw response cached so re-deriving costs nobody
anything. This produces a static file that ships with the app; there is no
reason at all to be fast.
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "adapters"))

from schema import Dining, FIELD_NAMES          # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(DATA, "raw")
MANIFEST = os.path.join(HERE, "manifest.json")
TS_OUT = os.path.join(REPO, "FlightTrackerApp", "lib", "dining.ts")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
PAUSE_BETWEEN_AIRPORTS_S = 8


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch(url, cache_path, offline):
    """The response body, from the network or from the cache.

    The cache is committed. It is what makes a parser change reviewable without
    touching anybody's servers, and what lets a failed run be diagnosed after
    the fact against exactly the bytes that caused it.
    """
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return io.open(cache_path, "rb").read()
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return body


def fetch_browser(url, page_url, cache_path, offline):
    """Fetch a JSON endpoint FROM INSIDE the site's own page.

    WHY A BROWSER IS NEEDED AT ALL: Heathrow's search API answers 403 to a plain
    request and 200 to the same URL asked for by their own page. The difference
    is the Origin and Referer a browser attaches, not a token -- so the honest
    way to ask is to be the page. This navigates there and runs the site's own
    fetch, which sends exactly the headers their API expects.

    It is not a workaround for a block on scraping: the endpoint is public, the
    page calls it on every visit, and this makes one request where a visitor
    makes one request.
    """
    if offline:
        if not os.path.exists(cache_path):
            raise RuntimeError("--offline but no cached body at %s" % cache_path)
        return io.open(cache_path, "rb").read()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(locale="en-GB", user_agent=UA)
        page = ctx.new_page()
        page.goto(page_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)
        text = page.evaluate(
            """async (u) => { const r = await fetch(u, {headers: {'Accept': 'application/json'}});
                              return await r.text(); }""", url)
        browser.close()
    body = text.encode("utf8")
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    io.open(cache_path, "wb").write(body)
    return body


def load_previous(code):
    path = os.path.join(DATA, code.lower() + ".json")
    if not os.path.exists(path):
        return None
    return json.load(io.open(path, encoding="utf8"))


def coverage(records, field):
    if not records:
        return 0.0
    filled = sum(1 for r in records
                 if str(r.get(field) if isinstance(r, dict) else getattr(r, field) or "").strip()
                 not in ("", "None"))
    return filled / len(records)


def check_guardrails(code, records, rules, previous):
    """Every reason to refuse a run. Returns a list of failures."""
    fail = []
    n = len(records)

    floor = rules.get("min_records", 0)
    if previous is not None:
        # The previous GOOD run is a stronger floor than a number written down
        # months ago, so take whichever is higher.
        floor = max(floor, int(len(previous["records"]) * rules.get("min_ratio", 0.6)))
    if n < floor:
        fail.append("only %d records, floor is %d (previous run had %s)"
                    % (n, floor, len(previous["records"]) if previous else "none"))

    for field, want in (rules.get("coverage") or {}).items():
        got = coverage(records, field)
        if got + 1e-9 < want:
            fail.append("coverage of %s is %.0f%%, expected at least %.0f%%"
                        % (field, got * 100, want * 100))

    # ── DOES THIS SOURCE ACTUALLY COVER THE TERMINALS? ──────────────────
    #
    # THE NEAR-MISS THIS EXISTS FOR: a homepage crawl of Changi followed the
    # site's own navigation to jewelchangiairport.com and produced a clean,
    # parseable list of restaurants -- all of them in Jewel, the landside mall.
    # Every guardrail above would have passed it. FRA has the same trap in its
    # own feed (eleven outlets in The Squaire, an office block over the railway
    # station) and JFK's location list includes an AirTrain station and a hotel.
    #
    # SO THE TERMINALS ARE PINNED. The manifest says which terminals an airport
    # has; a run whose terminals do not match has scraped somewhere else, and
    # that is a refusal rather than a warning.
    if rules.get("require_terminal"):
        homeless = [r for r in records if not str(r.get("terminal") or "").strip()]
        if homeless:
            fail.append("%d record(s) belong to no terminal (e.g. %r)"
                        % (len(homeless), homeless[0]["name"]))
    expected = rules.get("expect_terminals")
    if expected:
        got = sorted({str(r.get("terminal") or "") for r in records})
        unexpected = sorted(set(got) - set(expected))
        missing = sorted(set(expected) - set(got))
        if unexpected:
            fail.append("terminals not in the manifest: %s (found %s, expected %s)"
                        % (unexpected, got, expected))
        if missing:
            fail.append("expected terminals absent: %s (found %s)" % (missing, got))

    # THE SECURITY COLUMN IS CHECKED SEPARATELY because it is the one the feature
    # lives on. An airport declared explicit in the manifest must stay explicit:
    # if a source stops publishing its own labels we want a refusal, not a
    # dataset that quietly degrades to guesswork.
    want_basis = rules.get("security_basis")
    if want_basis:
        wrong = [r for r in records if r["security_basis"] != want_basis]
        if wrong:
            fail.append("%d record(s) are not security_basis=%s (e.g. %r)"
                        % (len(wrong), want_basis, wrong[0]["name"]))
    return fail


# Fields that change on every single run and say nothing about the DATA. Comparing
# them made an identical fetch report all 71 records as changed, which is the same
# as reporting nothing: a real change would have been one line in seventy-one.
VOLATILE = ("scraped_at",)


def _key(r):
    if r.get("source_id"):
        return (r["airport"], r["source_id"])
    return (r["airport"], r["name"], r["terminal"], r["level"])


def _stable(r):
    return {k: v for k, v in r.items() if k not in VOLATILE}


def diff(previous, records):
    if previous is None:
        return "  first run: %d records, no previous to compare" % len(records)
    old = {_key(r): r for r in previous["records"]}
    new = {_key(r): r for r in records}
    # A KEY COLLISION MEANS THE DIFF IS BLIND, so it is reported rather than
    # tolerated: two outlets sharing a key hide each other's changes.
    lost = len(records) - len(new)
    if lost:
        return ("  CANNOT DIFF: %d record(s) share a key with another -- "
                "the source id is missing or not unique" % lost)
    added = sorted(set(new) - set(old))
    gone = sorted(set(old) - set(new))
    changed = [k for k in set(old) & set(new) if _stable(old[k]) != _stable(new[k])]
    lines = ["  %d -> %d records  (+%d  -%d  ~%d)"
             % (len(old), len(new), len(added), len(gone), len(changed))]
    for k in added[:5]:
        lines.append("    + %s" % (new[k]["name"],))
    for k in gone[:5]:
        lines.append("    - %s" % (old[k]["name"],))
    # A FLIPPED SECURITY FLAG IS ALWAYS SHOWN, however many there are. It is the
    # one change that can be wrong without looking wrong.
    flips = [k for k in changed if old[k]["is_airside"] != new[k]["is_airside"]]
    for k in flips:
        lines.append("    ! AIRSIDE FLIPPED %s: %s -> %s"
                     % (new[k]["name"], old[k]["is_airside"], new[k]["is_airside"]))
    return "\n".join(lines)


def emit_ts(all_records, per_airport_meta):
    """FlightTrackerApp/lib/dining.ts, in the shape lib/airports.ts already uses.

    ROWS RATHER THAN OBJECTS, for the same reason airports.ts uses them: the key
    names repeat once per record and cost more than the values. At a few hundred
    records this is readable as well as small; if it grows past a couple of
    thousand, intern `terminal`, `category` and `security_raw` into lookup tables
    the way HKG's own file does.
    """
    def camel(s):
        a, *b = s.split("_")
        return a + "".join(w.title() for w in b)

    def cell(v):
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return repr(v)
        # NESTED KEYS GET CAMEL-CASED TOO. The record fields are renamed on the
        # way out; the hours windows inside them have to be renamed with the
        # same rule, or the emitted objects will not match the type declared
        # above them -- which tsc catches, loudly, once per row.
        if isinstance(v, list):
            return json.dumps(
                [{camel(k): x[k] for k in x} if isinstance(x, dict) else x for x in v],
                ensure_ascii=False)
        return json.dumps(v, ensure_ascii=False)

    order = [f for f in FIELD_NAMES if f not in ("scraped_at", "source_url", "source_updated_at")]
    rows = []
    for r in all_records:
        rows.append("  [" + ", ".join(cell(r[f]) for f in order) + "],")

    provenance = "\n".join(
        "//   %-4s %4d outlets   source: %s   their last update: %s   fetched: %s"
        % (m["airport"], m["count"], m["source_url"], m["source_updated_at"] or "-", m["scraped_at"])
        for m in per_airport_meta)

    head = '''// Airport dining, scraped. Generated by tools/dining/run.py -- do not edit.
//
// WHAT THIS IS FOR: telling somebody with a layover what they can actually eat,
// which is a question about SECURITY ZONES before it is a question about food.
// A restaurant on the wrong side of passport control is not a lunch option for a
// connecting passenger, it is a missed flight.
//
// SO READ isAirside WITH securityBasis, ALWAYS:
//
// flightScope IS BRAND-LEVEL WHERE IT IS SET AT ALL (only BOM today): it says
// what the BRAND serves, not what this counter does, because Mumbai's filter
// narrows brands rather than addresses. Empty means the source did not say.
//
// AND READ zone WHEN isAirside IS null. "arrivals" is not a missing answer: it
// is baggage reclaim or the arrivals concourse, which a CONNECTING passenger
// cannot reach and a landside visitor cannot either. "You can eat here after you
// land" is a different sentence from "you can eat here on your layover".
//
//   "explicit"  the airport publishes the zone per outlet. Trust it.
//   "inferred"  we deduced it, e.g. from a gate number. DO NOT present as fact
//               until the inference has been measured against an explicit source.
//   "unknown"   nobody knows. Show "location unclear"; never guess.
//
// securityRaw is the source's own words, kept beside the boolean so a mis-parse
// is visible rather than silently inverting what the column means.
//
// HOURS ARE VERBATIM STRINGS in the airport's local time, with whatever dialect
// the source uses -- "07:00 - 23:00", en dashes, "(Last order: 20:30)". They are
// deliberately not parsed by the scraper. Parse them here, against the airport's
// timezone from airports.ts, or show them as they came.
//
// SOURCES
%s
''' % provenance

    ts_fields = {
        "airport": "string", "name": "string", "source_id": "string",
        "terminal_raw": "string",
        "terminal": "string", "level": "string", "area": "string",
        "gate_hint": "string", "is_airside": "boolean | null",
        "zone": "'departures_airside' | 'departures_landside' | 'arrivals' | 'unknown'",
        "security_raw": "string", "security_basis": "'explicit' | 'inferred' | 'unknown'",
        "flight_scope": "'' | 'domestic' | 'international' | 'both'",
        "category_raw": "string", "category": "string", "hours_raw": "string",
        "hours": "HoursWindow[]",
        "is_24h": "boolean", "lat": "number | null", "lon": "number | null",
    }

    type_lines = "\n".join("  %s: %s;" % (camel(f), ts_fields[f]) for f in order)
    row_type = ", ".join(ts_fields[f] for f in order)

    body = '''%s
export type HoursWindow = {
  startDay: number;   // 0 = Monday
  endDay: number;
  open: string;       // "HH:MM", local to the airport
  close: string;      // "HH:MM"; "24:00" means midnight at the end of the day
};

export type Dining = {
%s
};

type Row = [%s];

const ROWS: Row[] = [
%s
];

const FIELDS = [%s] as const;

// BUILT ONCE, LAZILY. The rows are the storage format; this is the shape the
// screen reads. Nothing here runs until something asks for dining.
let cache: Dining[] | null = null;

export function allDining(): Dining[] {
  if (cache !== null) return cache;
  cache = ROWS.map(r => {
    const o: any = {};
    FIELDS.forEach((f, i) => { o[f] = r[i]; });
    return o as Dining;
  });
  return cache;
}

// EVERYTHING AT ONE AIRPORT. The caller filters by terminal and by isAirside,
// because only the caller knows whether this passenger has cleared security.
export function diningAt(iata: string): Dining[] {
  const code = iata.toUpperCase();
  return allDining().filter(d => d.airport === code);
}
''' % (head, type_lines, row_type, "\n".join(rows),
       ", ".join("'%s'" % camel(f) for f in order))

    os.makedirs(os.path.dirname(TS_OUT), exist_ok=True)
    io.open(TS_OUT, "w", encoding="utf8", newline="\n").write(body)
    return len(body)


def main():
    args = [a for a in sys.argv[1:]]
    offline = "--offline" in args
    wanted = [a.lower() for a in args if not a.startswith("-")]

    manifest = json.load(io.open(MANIFEST, encoding="utf8"))
    airports = [a for a in manifest["airports"]
                if not wanted or a["code"].lower() in wanted]
    if not airports:
        print("no matching airport in the manifest")
        return 1

    scraped_at = now_iso()
    published, meta, refused = [], [], []

    for i, entry in enumerate(airports):
        code = entry["code"]
        print("\n=== %s ===" % code)
        module = __import__(entry["adapter"])
        cache_path = os.path.join(RAW, entry["cache"])

        try:
            kind = entry.get("kind", "json")
            if kind == "custom":
                # THE ADAPTER FETCHES ITSELF. JFK's list only exists as the
                # answer to a compressed GraphQL query the page builds, and it
                # has to be asked twice -- once per security filter -- so the
                # adapter owns the conversation. Everything after it is the same.
                body = module.fetch(cache_path, offline, UA)
            elif kind == "browser_json":
                body = fetch_browser(entry["url"], entry["page_url"], cache_path, offline)
            else:
                body = fetch(entry["url"], cache_path, offline)
        except (urllib.error.URLError, RuntimeError, OSError, Exception) as exc:
            # A SOURCE THAT WILL NOT LOAD IS REPORTED, NOT WORKED AROUND. The
            # previously published data stays exactly as it is.
            print("  FETCH FAILED: %s: %s" % (type(exc).__name__, exc))
            refused.append((code, "fetch failed"))
            continue

        print("  fetched %d bytes%s" % (len(body), " (cached)" if offline else ""))
        raw = (json.loads(body.decode("utf8"))
               if entry.get("kind", "json") in ("json", "browser_json", "custom")
               else body.decode("utf8", "replace"))
        records, notes = module.parse(raw, scraped_at)
        for n in notes:
            print("  note: %s" % n)

        problems = []
        for r in records:
            for p in r.check():
                problems.append("%s: %s" % (r.name, p))
        if problems:
            print("  SCHEMA FAILURES (%d):" % len(problems))
            for p in problems[:8]:
                print("    %s" % p)
            refused.append((code, "%d schema failures" % len(problems)))
            continue

        rows = [r.to_dict() for r in records]
        previous = load_previous(code)
        print(diff(previous, rows))

        fails = check_guardrails(code, rows, entry.get("guardrails") or {}, previous)
        if fails:
            print("  REFUSED, previous data kept:")
            for f in fails:
                print("    - %s" % f)
            refused.append((code, fails[0]))
            continue

        io.open(os.path.join(DATA, code.lower() + ".json"), "w", encoding="utf8", newline="\n").write(
            json.dumps({"airport": code, "scraped_at": scraped_at,
                        "source_url": entry["url"], "records": rows},
                       indent=1, ensure_ascii=False))
        published.append((code, rows))
        meta.append({"airport": code, "count": len(rows), "source_url": entry["url"],
                     "scraped_at": scraped_at,
                     "source_updated_at": rows[0]["source_updated_at"] if rows else ""})
        # THREE BUCKETS, NOT TWO. Counting "not airside" as landside would file
        # every arrivals row under a zone it is not in -- the exact collapse the
        # zone field was added to stop.
        from collections import Counter
        z = Counter(r["zone"] for r in rows)
        print("  OK: %d records  |  airside %d, landside %d, arrivals %d, unknown %d"
              % (len(rows), z["departures_airside"], z["departures_landside"],
                 z["arrivals"], z["unknown"]))

        if i + 1 < len(airports) and not offline:
            time.sleep(PAUSE_BETWEEN_AIRPORTS_S)

    # THE TYPESCRIPT IS REBUILT FROM EVERY COMMITTED FILE, not just this run's
    # airports, so refreshing one airport cannot drop the other nine.
    all_rows = []
    all_meta = []
    for entry in manifest["airports"]:
        prev = load_previous(entry["code"])
        if prev is None:
            continue
        all_rows.extend(prev["records"])
        all_meta.append({"airport": entry["code"], "count": len(prev["records"]),
                         "source_url": prev["source_url"], "scraped_at": prev["scraped_at"],
                         "source_updated_at": prev["records"][0]["source_updated_at"]
                                              if prev["records"] else ""})
    if all_rows:
        size = emit_ts(all_rows, all_meta)
        print("\nwrote %s (%d records, %.0f KB)"
              % (os.path.relpath(TS_OUT, REPO), len(all_rows), size / 1024))

    if refused:
        print("\nREFUSED: " + "; ".join("%s (%s)" % r for r in refused))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
