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
from dataclasses import dataclass, asdict, fields
from typing import Optional

# The normalised category vocabulary. Deliberately small: this is what a hungry
# passenger filters by, not a cuisine taxonomy. An adapter that cannot map a
# source category leaves it out of `category` and keeps it in `category_raw`,
# which is how we find out the vocabulary needs another entry.
CATEGORIES = (
    "fast_food", "cafe", "bakery", "dessert", "bar",
    "asian", "chinese", "indian", "western", "middle_eastern",
    "vegetarian", "halal", "food_court", "lounge", "other",
)

SECURITY_BASIS = ("explicit", "inferred", "unknown")


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
    security_raw: str
    security_basis: str

    # ── what it is ────────────────────────────────────────────────────────
    category_raw: str               # source vocabulary, "|"-joined
    category: str                   # CATEGORIES members, "|"-joined

    # ── when ──────────────────────────────────────────────────────────────
    hours_raw: str                  # verbatim. Never parsed into times here:
                                    # see the note in run.py on why.
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
        # THE RULE THAT MATTERS. "explicit" is a claim that the SOURCE said so,
        # so it must be backed by the source's own words and an actual answer.
        if self.security_basis == "explicit":
            if self.is_airside is None:
                bad.append("explicit basis with no is_airside")
            if not self.security_raw.strip():
                bad.append("explicit basis with empty security_raw")
        if self.security_basis == "unknown" and self.is_airside is not None:
            bad.append("unknown basis must not carry an is_airside")
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
        if not self.source_url.startswith("http"):
            bad.append("source_url is not a url")
        return bad

    def key(self):
        """What identifies this outlet across runs."""
        return (self.airport, self.source_id) if self.source_id else                (self.airport, self.name, self.terminal, self.level)

    def to_dict(self):
        return asdict(self)


FIELD_NAMES = tuple(f.name for f in fields(Dining))
