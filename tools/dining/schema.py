"""One dining record, and the rules every adapter must satisfy.

WHY THE SECURITY ANSWER IS THREE FIELDS AND NOT ONE
===================================================
A landside restaurant recommended to a connecting passenger is the failure this
whole feature exists to avoid, and a bare boolean cannot express the difference
between "the airport says so" and "we guessed from a gate number". So:

    is_airside      True | False | None      the normalised answer
    security_raw    the source's OWN words, verbatim
    security_basis  "explicit" | "inferred" | "unknown"

`security_basis` is load-bearing. HKG publishes a per-outlet boolean, so it is
`explicit`. An airport where airside is deduced from "near Gate 12" is
`inferred`, and inferred records MUST NOT be presented as fact until the
inference has been measured against a source that labels explicitly. `unknown`
records are shown as "location unclear" rather than guessed, because no answer
beats a confident wrong one when the cost is a missed flight.

`security_raw` exists so a mis-parse is VISIBLE. If a future site redesign starts
returning "Restricted Area" where it used to return "Non-restricted Area", the
raw column shows it; a boolean alone would silently invert the meaning of the
whole dataset.

WHY EVERY *_raw FIELD IS KEPT
=============================
Normalisation is a lossy guess about somebody else's vocabulary. Keeping the
original beside it costs a few bytes and is the only way to audit a mapping
after the fact -- or to fix one without re-scraping ten sites.
"""
import re
from dataclasses import dataclass, asdict, fields
from typing import Optional

# The normalised category vocabulary. Deliberately small: this is what a hungry
# passenger filters by, not a cuisine taxonomy. An adapter that cannot map a
# source category leaves it out of `category` and keeps it in `category_raw`,
# which is how we find out the vocabulary needs another entry.
CATEGORIES = (
    "fast_food", "cafe", "bakery", "dessert", "bar",
    "asian", "chinese", "indian", "western", "middle_eastern",
    "vegetarian", "halal", "food_court", "lounge", "vending", "other",
)

# "vending" IS ITS OWN CATEGORY AND NOT "other", because the app has to be able
# to say so. A vending machine is a real option on a tight connection and for
# somebody who cannot afford a sit-down meal -- so it belongs in the dataset --
# but presenting it as a restaurant would be a lie of omission. Folding it into
# "other" alongside outlets whose cuisine simply was not published would make
# the two indistinguishable, which is the same failure in a smaller place.

SECURITY_BASIS = ("explicit", "inferred", "unknown")

# ── WHERE AN OUTLET SITS IN A PASSENGER'S JOURNEY ───────────────────────────
#
# A BOOLEAN COULD NOT CARRY ARRIVALS, and Heathrow proved it: one Caffe Nero
# record lists "3/After Security" AND "3/Arrivals" -- the same terminal, twice,
# under zones the airport itself treats as different places. An arrivals outlet
# sits in baggage reclaim or the arrivals concourse. A CONNECTING PASSENGER
# CANNOT REACH IT (getting there means leaving the departures flow) and neither
# can somebody landside. It is a third place, not a shade of the other two.
#
# AND IT RECURS: BOM's own filters are Domestic/International x Arrivals/
# Departures, so this is not a Heathrow quirk to special-case.
#
# WHAT IT IS FOR: the difference between "you can eat here on your layover" and
# "you can eat here after you land" is a real difference to a traveller, and the
# dataset has to be able to say which.
ZONES = ("departures_airside", "departures_landside", "arrivals", "unknown")

# is_airside stays the boolean for the common case, and is None where no boolean
# is honest. These two fields must never disagree.
ZONE_AIRSIDE = {
    "departures_airside": True,
    "departures_landside": False,
    "arrivals": None,
    "unknown": None,
}

# 24:00 is allowed: a source may spell "closes at midnight" that way rather than
# as 00:00 of the following day, and rewriting it here would move the closing
# time back by a whole day.
TIME_RE = re.compile(r"^(?:[01]\d|2[0-4]):[0-5]\d$")


@dataclass
class Dining:
    # ── identity ──────────────────────────────────────────────────────────
    airport: str                    # IATA, upper case. The join key to airports.ts.
    name: str                       # As published. Never title-cased or cleaned.
    # THE SOURCE'S OWN OUTLET ID, and the diff depends on it. Name+terminal+level
    # is NOT unique -- HKG's 76 outlets collapse to 71 such tuples, because a
    # brand can run two counters on one level -- so a diff keyed on it silently
    # merges five records and could hide a removal behind an addition. Empty when
    # a source publishes no id, and the tuple is the fallback then.
    source_id: str

    # ── where ─────────────────────────────────────────────────────────────
    terminal_raw: str               # "T1", "Terminal 2", "Concourse D", ""
    terminal: str                   # normalised: "T1", "T2", "" when unknown
    level: str                      # "L6", "Level 3", "" -- as published
    area: str                       # "Terminal 1", "Midfield Concourse", ""
    gate_hint: str                  # "40-80", "6", "" -- gates it sits near

    # ── the fact that decides everything ──────────────────────────────────
    is_airside: Optional[bool]
    zone: str                       # one of ZONES; see the note above
    security_raw: str
    security_basis: str

    # ── what it is ────────────────────────────────────────────────────────
    category_raw: str               # source vocabulary, "|"-joined
    category: str                   # CATEGORIES members, "|"-joined

    # ── when ──────────────────────────────────────────────────────────────
    #
    # TWO FIELDS, BECAUSE THE SOURCES ARE NOT EQUALLY GOOD AND FLATTENING TO THE
    # WORST ONE THROWS AWAY THE BEST. HKG publishes freeform strings mixing a
    # hyphen with an en dash and appending "(Last order: 20:30)"; FRA publishes
    # day ranges with open and close times already separated. Parsing HKG's
    # dialect into FRA's shape would be a guess, and squashing FRA's into HKG's
    # would discard structure somebody already did correctly.
    #
    # hours_raw is ALWAYS populated -- something a human can read.
    # hours is populated ONLY where the source is already structured, and is
    # empty otherwise. A consumer uses `hours` when it is there and falls back
    # to showing `hours_raw` when it is not.
    hours_raw: str
    hours: list                     # [{start_day, end_day, open, close}], 0=Mon
    is_24h: bool

    # ── position, when the source gives it ────────────────────────────────
    lat: Optional[float]
    lon: Optional[float]

    # ── provenance ────────────────────────────────────────────────────────
    source_url: str
    scraped_at: str                 # ISO 8601 Z, when WE fetched
    source_updated_at: str          # when THEY last changed it, if published

    def check(self):
        """Every rule that must hold for a record to be publishable.

        Returns a list of problems. An empty list means the record is sound.
        Raising instead would abort a whole run over one bad row, and one bad
        row is exactly the thing we want counted and reported rather than fatal.
        """
        bad = []
        if len(self.airport) != 3 or not self.airport.isupper():
            bad.append("airport must be a 3-letter upper IATA code, got %r" % self.airport)
        if not self.name.strip():
            bad.append("name is empty")
        if self.security_basis not in SECURITY_BASIS:
            bad.append("security_basis %r not in %s" % (self.security_basis, SECURITY_BASIS))
        if self.zone not in ZONES:
            bad.append("zone %r not in %s" % (self.zone, ZONES))
        # THE TWO MUST AGREE. is_airside is a convenience derived from the zone,
        # so a record where they disagree is one where a consumer reading either
        # one gets a different answer -- which is worse than having neither.
        elif self.is_airside is not ZONE_AIRSIDE[self.zone]:
            bad.append("zone %r implies is_airside %r, got %r"
                       % (self.zone, ZONE_AIRSIDE[self.zone], self.is_airside))
        # THE RULE THAT MATTERS. "explicit" is a claim that the SOURCE said so,
        # so it must be backed by the source's own words and a real zone. Note it
        # does NOT require a boolean: "arrivals" is an explicit answer that
        # happens to have no true/false, and refusing it would push a fact the
        # airport stated into "unknown".
        if self.security_basis == "explicit":
            if self.zone == "unknown":
                bad.append("explicit basis with an unknown zone")
            if not self.security_raw.strip():
                bad.append("explicit basis with empty security_raw")
        if self.security_basis == "unknown" and self.zone != "unknown":
            bad.append("unknown basis must not carry a zone")
        for c in filter(None, self.category.split("|")):
            if c not in CATEGORIES:
                bad.append("category %r not in the vocabulary" % c)
        # elif, NOT a second if: with one half missing the range test below
        # would compare a number against None and raise, turning a bad record
        # into a crashed run. A record is allowed to have no position at all.
        if (self.lat is None) != (self.lon is None):
            bad.append("half a coordinate")
        elif self.lat is not None and not (-90 <= self.lat <= 90 and -180 <= self.lon <= 180):
            bad.append("coordinate out of range: %s,%s" % (self.lat, self.lon))
        for w in self.hours:
            if not isinstance(w, dict):
                bad.append("hours window is not an object: %r" % (w,))
                continue
            missing = [k for k in ("start_day", "end_day", "open", "close") if k not in w]
            if missing:
                bad.append("hours window missing %s" % missing)
                continue
            if not (0 <= w["start_day"] <= 6 and 0 <= w["end_day"] <= 6):
                bad.append("hours window day out of range: %r" % (w,))
            for t in (w["open"], w["close"]):
                if not isinstance(t, str) or not TIME_RE.match(t):
                    bad.append("hours window time is not HH:MM: %r" % (t,))
        if not self.source_url.startswith("http"):
            bad.append("source_url is not a url")
        return bad

    def key(self):
        """What identifies this outlet across runs."""
        return (self.airport, self.source_id) if self.source_id else                (self.airport, self.name, self.terminal, self.level)

    def to_dict(self):
        return asdict(self)


FIELD_NAMES = tuple(f.name for f in fields(Dining))
