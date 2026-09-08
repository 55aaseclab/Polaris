"""Literature corpus bounds: time window, CCF venues, arXiv CoRR, topic keywords.

Bounds (product rules):
  1. Last 5 calendar years (inclusive of the current year).
  2. Research papers at CCF-recommended venues (A/B/C journals & conferences
     from the 2026 CCF catalog shipped under scopes/).
  3. arXiv CoRR / cs.* preprints are allowed even when not on the CCF list.
  4. No fixed record-count cap: expand until no new in-bound papers remain
     (or an operator sets an emergency override).
  5. Topic focus: title + abstract must match keywords from the collection
     input (`scope.include` or `payload.literature_scope.topic_keywords`).
     Keywords are matched case-insensitively against text from Crossref and
     Semantic Scholar payloads.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


# Catalog lives next to the package: tools/data-collection/scopes/
SCOPES_DIR = Path(__file__).resolve().parent.parent / "scopes"
CCF_CATALOG_PATH = SCOPES_DIR / "ccf-recommended-2026.json"

# Common aliases → canonical CCF abbr (lower).
ABBR_ALIASES: dict[str, str] = {
    "sp": "s&p",
    "oakland": "s&p",
    "ieee s&p": "s&p",
    "ieee symposium on security and privacy": "s&p",
    "usenix security": "usenix security",
    "uss": "usenix security",
    "ccs": "ccs",
    "acm ccs": "ccs",
    "ndss": "ndss",
    "neurips": "neurips",
    "nips": "neurips",
    "cvpr": "cvpr",
    "iccv": "iccv",
    "aaai": "aaai",
    "ijcai": "ijcai",
    "iclr": "iclr",
    "icml": "icml",
    "acl": "acl",
    "emnlp": "emnlp",
    "naacl": "naacl",
    "osdi": "osdi",
    "sosp": "sosp",
    "nsdi": "nsdi",
    "sigcomm": "sigcomm",
    "mobicom": "mobicom",
    "icse": "icse",
    "fse": "fse",
    "esec/fse": "fse",
    "esec-fse": "fse",
    "ase": "ase",
    "pldi": "pldi",
    "popl": "popl",
    "oopsla": "oopsla",
    "asplos": "asplos",
    "isca": "isca",
    "micro": "micro",
    "hpca": "hpca",
    "sc": "sc",
    "eurocrypt": "eurocrypt",
    "crypto": "crypto",
    "ches": "ches",
    "tdsc": "tdsc",
    "tifs": "tifs",
}


@dataclass
class LiteratureBounds:
    """Runtime bounds for literature expansion."""

    from_year: int
    to_year: int
    allow_arxiv_corr: bool = True
    ccf_ranks: tuple[str, ...] = ("A", "B", "C")
    ccf_kinds: tuple[str, ...] = ("journal", "conference")
    # When False, skip the CCF venue gate (year + optional arXiv still apply).
    require_ccf_venue: bool = True
    # None = no numeric cap (stop only when frontier is empty within bounds).
    max_records: int | None = None
    catalog_path: Path = CCF_CATALOG_PATH

    @classmethod
    def last_n_years(
        cls,
        n: int = 5,
        *,
        as_of: datetime | None = None,
        allow_arxiv_corr: bool = True,
        max_records: int | None = None,
        require_ccf_venue: bool = True,
    ) -> LiteratureBounds:
        """Last *n* calendar years inclusive of the current year.

        Example as of 2026: n=5 → from_year=2022, to_year=2026.
        """
        now = as_of or datetime.now(UTC)
        to_year = now.year
        from_year = to_year - (n - 1)
        return cls(
            from_year=from_year,
            to_year=to_year,
            allow_arxiv_corr=allow_arxiv_corr,
            max_records=max_records,
            require_ccf_venue=require_ccf_venue,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "from_year": self.from_year,
            "to_year": self.to_year,
            "allow_arxiv_corr": self.allow_arxiv_corr,
            "ccf_ranks": list(self.ccf_ranks),
            "ccf_kinds": list(self.ccf_kinds),
            "require_ccf_venue": self.require_ccf_venue,
            "max_records": self.max_records,
            "catalog": str(self.catalog_path.name),
            "stop_policy": "no_new_within_bounds"
            if self.max_records is None
            else "no_new_or_max_records",
        }


def is_reliable_venue_abbr(abbr: str) -> bool:
    """True if *abbr* looks like a real venue acronym, not a PDF-split English word.

    CCF rows usually use acronyms (CCS, NDSS, ICSE, TPDS). Layout-broken lines
    sometimes leave the first English word as "abbr" (Information, Artificial).
    Those must not match arbitrary abstracts.
    """
    text = abbr.strip()
    if not text or len(text) > 28:
        return False
    lower = text.lower()
    # Explicitly reject common English / publisher words seen as false positives.
    if lower in _GENERIC_ABBR_BLOCKLIST:
        return False
    if lower in {
        "information",
        "artificial",
        "computational",
        "medical",
        "wireless",
        "networking",
        "integration",
        "applied",
        "health",
        "knowledge",
        "pattern",
        "machine",
        "neural",
        "human",
        "visual",
        "mobile",
        "parallel",
        "distributed",
        "empirical",
        "formal",
        "theoretical",
        "science",
        "scientific",
        "nature",
        "communications",
        "communication",
        "computing",
        "automation",
        "automatic",
        "multimedia",
        "graphics",
        "database",
        "databases",
        "internet",
        "web",
        "world",
        "wide",
        "european",
        "american",
        "asian",
        "pacific",
        "international",
    }:
        return False
    # Very short all-letter tokens are too ambiguous in abstracts ("AI", "ML").
    if text.isalpha() and len(text) <= 2 and text.upper() not in {"SP", "TC", "TK", "TO"}:
        return False
    # Acronym-like: all caps, has digits/&, or multi-caps camel (NeurIPS).
    if re.search(r"[&0-9/\-]", text):
        return True
    if text.isupper() and 3 <= len(text) <= 16:
        return True
    upper_count = sum(1 for char in text if char.isupper())
    if upper_count >= 2 and 3 <= len(text) <= 16:
        return True
    # Title-case single English word → unreliable as abbreviation.
    if text.isalpha() and len(text) > 3 and text[0].isupper() and text[1:].islower():
        return False
    if text.isalpha() and text.islower() and len(text) > 3:
        return False
    return len(text) <= 8


@dataclass
class VenueCatalog:
    venues: list[dict[str, Any]]
    by_abbr: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    by_dblp_key: dict[str, dict[str, Any]] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> VenueCatalog:
        catalog_path = path or CCF_CATALOG_PATH
        document = json.loads(catalog_path.read_text(encoding="utf-8"))
        venues = list(document.get("venues") or [])
        by_abbr: dict[str, list[dict[str, Any]]] = {}
        by_dblp: dict[str, dict[str, Any]] = {}
        for venue in venues:
            abbr = venue.get("abbr")
            if isinstance(abbr, str) and abbr.strip() and is_reliable_venue_abbr(abbr):
                key = abbr.strip().lower()
                by_abbr.setdefault(key, []).append(venue)
            dblp_key = venue.get("dblp_key")
            if isinstance(dblp_key, str) and dblp_key.strip():
                by_dblp[dblp_key.strip().lower()] = venue
        return cls(
            venues=venues,
            by_abbr=by_abbr,
            by_dblp_key=by_dblp,
            source=dict(document.get("source") or {}),
        )


def default_bounds() -> LiteratureBounds:
    """Product default: last 5 years, full CCF A/B/C, arXiv CoRR allowed, no cap."""
    return LiteratureBounds.last_n_years(5, allow_arxiv_corr=True, max_records=None)


def bounds_from_input(input_value: dict[str, Any] | None) -> LiteratureBounds:
    """Build bounds from collection input scope (time_range, optional caps)."""
    bounds = default_bounds()
    if not isinstance(input_value, dict):
        return bounds
    scope = input_value.get("scope") if isinstance(input_value.get("scope"), dict) else {}
    time_range = scope.get("time_range") if isinstance(scope.get("time_range"), str) else ""
    if ".." in time_range:
        start, end = time_range.split("..", 1)
        try:
            bounds.from_year = int(start.strip()[:4])
            bounds.to_year = int(end.strip()[:4])
        except ValueError:
            pass
    # Optional operator overrides under payload.literature_scope
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    override = payload.get("literature_scope") if isinstance(payload.get("literature_scope"), dict) else {}
    if "from_year" in override:
        try:
            bounds.from_year = int(override["from_year"])
        except (TypeError, ValueError):
            pass
    if "to_year" in override:
        try:
            bounds.to_year = int(override["to_year"])
        except (TypeError, ValueError):
            pass
    if "allow_arxiv_corr" in override:
        bounds.allow_arxiv_corr = bool(override["allow_arxiv_corr"])
    if "max_records" in override and override["max_records"] is not None:
        try:
            bounds.max_records = int(override["max_records"])
        except (TypeError, ValueError):
            pass
    ranks = override.get("ccf_ranks")
    if isinstance(ranks, list) and ranks:
        bounds.ccf_ranks = tuple(str(item) for item in ranks)
    # Operator opt-out of the strict CCF venue gate (alias: venue_filter=false).
    if "require_ccf_venue" in override:
        bounds.require_ccf_venue = bool(override["require_ccf_venue"])
    if override.get("venue_filter") is False:
        bounds.require_ccf_venue = False
    return bounds


def _normalize_keyword_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        text = " ".join(item.split()).strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def topic_keywords_from_input(input_value: dict[str, Any] | None) -> list[str]:
    """RQ topic keywords for title/abstract match.

    Priority:
      1. payload.literature_scope.topic_keywords
      2. payload.citation_expansion.topic_keywords
      3. scope.include (collection RQ phrases)

    Empty list means no topic filter (tests / operator opt-out).
    """
    if not isinstance(input_value, dict):
        return []
    payload = input_value.get("payload") if isinstance(input_value.get("payload"), dict) else {}
    scope_cfg = (
        payload.get("literature_scope")
        if isinstance(payload.get("literature_scope"), dict)
        else {}
    )
    if scope_cfg.get("topic_filter") is False:
        return []
    keywords = _normalize_keyword_list(scope_cfg.get("topic_keywords"))
    if keywords:
        return keywords
    expand_cfg = (
        payload.get("citation_expansion")
        if isinstance(payload.get("citation_expansion"), dict)
        else {}
    )
    keywords = _normalize_keyword_list(expand_cfg.get("topic_keywords"))
    if keywords:
        return keywords
    scope = input_value.get("scope") if isinstance(input_value.get("scope"), dict) else {}
    return _normalize_keyword_list(scope.get("include"))


_JATS_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_markup(text: str) -> str:
    """Remove Crossref JATS / HTML tags and collapse whitespace."""
    cleaned = _JATS_TAG_RE.sub(" ", text)
    return _WS_RE.sub(" ", cleaned).strip()


def _as_plain_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return strip_markup(value)
    if isinstance(value, list):
        parts = [_as_plain_text(item) for item in value]
        return " ".join(part for part in parts if part)
    if isinstance(value, dict):
        # S2 sometimes nests; Crossref abstract is usually a string.
        for key in ("text", "value", "abstract"):
            if key in value:
                return _as_plain_text(value.get(key))
    return strip_markup(str(value))


def record_title(record: dict[str, Any]) -> str:
    """Title string from Crossref / Semantic Scholar payload (or evidence)."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in ("title", "display_name", "original_title"):
        text = _as_plain_text(payload.get(key))
        if text:
            return text
    for item in record.get("evidence") or []:
        if not isinstance(item, dict):
            continue
        locator = str(item.get("locator") or "").lower()
        quote = item.get("quote")
        if "title" in locator and isinstance(quote, str) and quote.strip():
            return strip_markup(quote)
    return ""


def record_abstract(record: dict[str, Any]) -> str:
    """Abstract string from Crossref (JATS) / Semantic Scholar payload."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in ("abstract", "Abstract", "summary"):
        text = _as_plain_text(payload.get(key))
        if text:
            # Crossref evidence may fall back to title when abstract missing;
            # only treat as abstract when it differs from title.
            title = record_title(record)
            if title and text.casefold() == title.casefold():
                continue
            return text
    for item in record.get("evidence") or []:
        if not isinstance(item, dict):
            continue
        locator = str(item.get("locator") or "").lower()
        quote = item.get("quote")
        if "abstract" in locator and isinstance(quote, str) and quote.strip():
            text = strip_markup(quote)
            title = record_title(record)
            if title and text.casefold() == title.casefold():
                continue
            return text
    return ""


def record_title_abstract_text(record: dict[str, Any]) -> str:
    """Combined title + abstract for topic keyword matching."""
    title = record_title(record)
    abstract = record_abstract(record)
    return _WS_RE.sub(" ", f"{title} {abstract}").strip()


def keyword_in_text(keyword: str, text: str) -> bool:
    """Case-insensitive phrase match; short/acronym keywords use word boundaries."""
    needle = " ".join(keyword.split()).strip()
    if not needle or not text:
        return False
    hay = text.casefold()
    needle_cf = needle.casefold()
    # Acronyms / short tokens (MCP, AI) — avoid substring false positives.
    if len(needle_cf) <= 4 or (needle.isupper() and " " not in needle):
        pattern = r"(?<![\w])" + re.escape(needle_cf) + r"(?![\w])"
        return re.search(pattern, hay) is not None
    return needle_cf in hay


def match_topic_keywords(
    record: dict[str, Any],
    keywords: list[str] | None,
) -> dict[str, Any]:
    """Match RQ keywords against title + abstract.

    Returns:
      matched: list of keywords that hit
      text_chars: length of searchable title+abstract text
      has_title / has_abstract
    """
    keywords = [k for k in (keywords or []) if isinstance(k, str) and k.strip()]
    title = record_title(record)
    abstract = record_abstract(record)
    text = _WS_RE.sub(" ", f"{title} {abstract}").strip()
    matched = [kw for kw in keywords if keyword_in_text(kw, text)]
    return {
        "matched": matched,
        "text_chars": len(text),
        "has_title": bool(title),
        "has_abstract": bool(abstract),
    }


def _normalize_year(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value if 1900 <= value <= 2100 else None
    if isinstance(value, float):
        return int(value) if 1900 <= int(value) <= 2100 else None
    if isinstance(value, str):
        match = re.search(r"(19|20)\d{2}", value)
        if match:
            return int(match.group(0))
    if isinstance(value, list) and value:
        return _normalize_year(value[0])
    if isinstance(value, dict):
        for key in ("date-parts", "year", "published-year"):
            if key in value:
                return _normalize_year(value[key])
    return None


def record_year(record: dict[str, Any]) -> int | None:
    """Best-effort publication year from a literature v2 record."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in (
        "published-print",
        "published-online",
        "published",
        "issued",
        "created",
        "publication_year",
        "publicationYear",
        "year",
    ):
        year = _normalize_year(payload.get(key))
        if year is not None:
            return year
    # OpenAlex
    year = _normalize_year(payload.get("publication_year"))
    if year is not None:
        return year
    # arXiv id yy.mm
    source_url = str(record.get("source_url") or "")
    arxiv = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{2})(\d{2})\.\d+", source_url, re.I)
    if arxiv:
        yy = int(arxiv.group(1))
        # arXiv modern ids: 07.xxxx = 2007+, 23.xxxx = 2023
        return 2000 + yy if yy < 100 else yy
    return None


def _text_blob(record: dict[str, Any]) -> str:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    chunks: list[str] = []
    for key in (
        "container-title",
        "short-container-title",
        "event",
        "publisher",
        "primary_location",
        "host_venue",
        "venue",
        "journal",
        "booktitle",
    ):
        value = payload.get(key)
        if isinstance(value, str):
            chunks.append(value)
        elif isinstance(value, list):
            chunks.extend(str(item) for item in value if item)
        elif isinstance(value, dict):
            for sub in ("display_name", "name", "title", "source"):
                if isinstance(value.get(sub), str):
                    chunks.append(value[sub])
                if isinstance(value.get(sub), dict) and isinstance(
                    value[sub].get("display_name"), str
                ):
                    chunks.append(value[sub]["display_name"])
    # OpenAlex locations
    for loc in payload.get("locations") or []:
        if not isinstance(loc, dict):
            continue
        source = loc.get("source") if isinstance(loc.get("source"), dict) else {}
        if isinstance(source.get("display_name"), str):
            chunks.append(source["display_name"])
        for alias in source.get("alternate_titles") or []:
            if isinstance(alias, str):
                chunks.append(alias)
    if isinstance(record.get("source_url"), str):
        chunks.append(record["source_url"])
    return " | ".join(chunks).lower()


def _venue_label_strings(record: dict[str, Any]) -> list[str]:
    """Bibliographic venue labels only (not title/abstract text)."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    labels: list[str] = []
    for key in (
        "container-title",
        "short-container-title",
        "conference",
        "venue",
        "event",
        "journal-title",
    ):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            labels.append(value.strip())
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    labels.append(item.strip())
                elif isinstance(item, dict):
                    for sub in ("name", "title", "display_name"):
                        if isinstance(item.get(sub), str) and item[sub].strip():
                            labels.append(item[sub].strip())
    return labels


def _venue_is_arxiv_corr_label(label: str) -> bool:
    """True when a venue string is the arXiv/CoRR preprint unit (not a peer venue)."""
    text = label.strip().lower()
    if not text:
        return False
    if "arxiv" in text:
        return True
    # CoRR as a series/venue name (Computing Research Repository).
    if re.fullmatch(r"corr", text) or re.search(r"\bcorr\b", text):
        return True
    if "computing research repository" in text:
        return True
    return False


def is_arxiv_corr_record(record: dict[str, Any]) -> bool:
    """True for the arXiv + CoRR preprint unit (kept together).

    Detection uses **host / identifier / venue label**, not title/abstract text
    (abstracts often cite arXiv without being preprints). Peer-reviewed records
    that merely list an arXiv id alongside a real conference/journal venue are
    still arxiv_corr when the *primary* source_url or record_id is arXiv, or the
    venue label itself is arXiv/CoRR, or the DOI is 10.48550/arXiv.*.
    """
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    source_url = str(record.get("source_url") or "").lower()
    record_id = str(record.get("record_id") or "").lower()
    doi = str(payload.get("DOI") or payload.get("doi") or "").lower()
    venues = _venue_label_strings(record)

    if any(_venue_is_arxiv_corr_label(label) for label in venues):
        return True
    if "arxiv.org" in source_url:
        return True
    if record_id.startswith("arxiv:") or record_id.startswith("http://arxiv.org") or record_id.startswith(
        "https://arxiv.org"
    ):
        return True
    if "10.48550" in doi:
        return True
    # ids.arxiv without a peer venue label → treat as preprint unit.
    inv = payload.get("ids") if isinstance(payload.get("ids"), dict) else {}
    arxiv_id = inv.get("arxiv") if isinstance(inv.get("arxiv"), str) else ""
    if arxiv_id.strip() and not venues:
        return True
    return False


# Tokens that appear in many papers but are not reliable venue abbreviations.
_GENERIC_ABBR_BLOCKLIST = frozenset(
    {
        "ieee",
        "acm",
        "journal",
        "journals",
        "conference",
        "conferences",
        "transactions",
        "proceedings",
        "symposium",
        "workshop",
        "workshops",
        "springer",
        "elsevier",
        "wiley",
        "press",
        "society",
        "international",
        "annual",
        "letter",
        "letters",
        "review",
        "reviews",
        "computer",
        "computers",
        "computing",
        "system",
        "systems",
        "software",
        "science",
        "sciences",
        "security",  # too broad alone; use CCS/NDSS/S&P/…
        "of",
        "on",
        "and",
        "the",
        "for",
        "in",
        "to",
        "with",
        "from",
        "vol",
        "volume",
        "pp",
        "doi",
    }
)


def _venue_allowed(venue: dict[str, Any], bounds: LiteratureBounds) -> bool:
    return (
        venue.get("rank") in bounds.ccf_ranks and venue.get("kind") in bounds.ccf_kinds
    )


def extract_arxiv_id(record: dict[str, Any]) -> str | None:
    """Best-effort arXiv id (e.g. 2406.09187) from record_id / URL / DOI / externalIds."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    rid = str(record.get("record_id") or "")
    if rid.lower().startswith("arxiv:"):
        return rid.split(":", 1)[1].split("v")[0].strip() or None
    url = str(record.get("source_url") or "")
    match = re.search(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})", url, re.I)
    if match:
        return match.group(1)
    doi = str(payload.get("DOI") or payload.get("doi") or "")
    match = re.search(r"10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})", doi, re.I)
    if match:
        return match.group(1)
    external = payload.get("externalIds") if isinstance(payload.get("externalIds"), dict) else {}
    for key in ("ArXiv", "arXiv", "arxiv"):
        value = external.get(key)
        if isinstance(value, str) and re.match(r"^[0-9]{4}\.[0-9]{4,5}", value.strip()):
            return value.strip().split("v")[0]
    inv = payload.get("ids") if isinstance(payload.get("ids"), dict) else {}
    value = inv.get("arxiv") if isinstance(inv.get("arxiv"), str) else ""
    if value.strip() and re.match(r"^[0-9]{4}\.[0-9]{4,5}", value.strip()):
        return value.strip().split("v")[0]
    return None


def dblp_keys_from_record(record: dict[str, Any]) -> list[str]:
    """DBLP venue keys such as conf/emnlp or journals/isci (not paper-level paths).

    Semantic Scholar often stores ``externalIds.DBLP = conf/emnlp/Author25`` even
    when ``source_url`` is an arXiv/10.48550 link. That key is the strongest
    peer-venue signal for dual-published preprints.
    """
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    raw_values: list[str] = []
    external = payload.get("externalIds") if isinstance(payload.get("externalIds"), dict) else {}
    for key in ("DBLP", "Dblp", "dblp"):
        value = external.get(key)
        if isinstance(value, str) and value.strip():
            raw_values.append(value.strip())
    for key in ("DBLP", "dblp", "dblp_key"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            raw_values.append(value.strip())
    urls: list[str] = []
    if isinstance(record.get("source_url"), str):
        urls.append(record["source_url"])
    for key in ("URL", "url", "resource"):
        value = payload.get(key)
        if isinstance(value, str):
            urls.append(value)
    for url in urls:
        match = re.search(
            r"dblp\.(?:org|uni-trier\.de)/db/(journals|conf)/([^/\s\.]+)",
            url.lower(),
        )
        if match:
            raw_values.append(f"{match.group(1)}/{match.group(2)}")

    keys: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        text = raw.strip().lstrip("/").replace("db/", "")
        # conf/emnlp/Jing25 → conf/emnlp ; journals/corr/abs-… → journals/corr
        match = re.match(r"^(conf|journals)/([^/\s]+)", text, re.I)
        if not match:
            continue
        key = f"{match.group(1).lower()}/{match.group(2)}"
        if key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


_ARXIV_ACCEPT_COMMENT = re.compile(
    r"(?i)(?:accepted\s+(?:to|at|by|for)|to\s+appear\s+in|published\s+(?:in|at)|"
    r"appears?\s+in|proc(?:eedings)?\s+of)\s*[:\s]*"
    r"([A-Za-z0-9][A-Za-z0-9 &/\-.]{1,80}?)(?:\s+\d{4})?(?:[.;,]|$)"
)
# Bare "ICML 2025" / "NeurIPS'25" style comments (common on arXiv).
_ARXIV_BARE_VENUE_COMMENT = re.compile(
    r"(?i)^\s*([A-Za-z][A-Za-z0-9&]{1,15})(?:\s*'\s*\d{2}|\s+\d{4})?\s*$"
)


def parse_arxiv_publication_hints(
    *,
    comment: str | None = None,
    journal_ref: str | None = None,
) -> list[str]:
    """Extract peer-venue hint strings from arXiv comment / journal_ref fields."""
    hints: list[str] = []
    seen: set[str] = set()

    def add(text: str) -> None:
        cleaned = re.sub(r"\s+", " ", text).strip(" .:;,")
        if len(cleaned) < 2:
            return
        key = cleaned.casefold()
        if key in seen:
            return
        # Skip pure page-count comments.
        if re.fullmatch(r"\d+\s*pages?(?:\s*,\s*\d+\s*figures?)?", cleaned, re.I):
            return
        seen.add(key)
        hints.append(cleaned)

    if isinstance(journal_ref, str) and journal_ref.strip():
        add(journal_ref)
    if isinstance(comment, str) and comment.strip():
        # Workshop acceptances must not promote to the parent CCF main track
        # (e.g. "Accepted to NeurIPS 2025 Workshop on …" ≠ NeurIPS CCF-A).
        if re.search(r"(?i)\bworkshop\b", comment):
            add(comment)
            return hints
        for match in _ARXIV_ACCEPT_COMMENT.finditer(comment):
            add(match.group(1))
        bare = _ARXIV_BARE_VENUE_COMMENT.match(comment.strip())
        if bare:
            add(bare.group(1))
        # Also keep full comment as a weak blob hint when it names a venue.
        if re.search(
            r"(?i)\b(ICML|ICLR|NeurIPS|NIPS|ACL|EMNLP|NDSS|CCS|S&P|IEEE|"
            r"USENIX|AAAI|CVPR|KDD|WWW|SOSP|OSDI|EuroSys|CHI|FSE|ICSE)\b",
            comment,
        ):
            add(comment)
    return hints


def fetch_arxiv_atom_metadata(arxiv_id: str, *, timeout_s: float = 20.0) -> dict[str, Any]:
    """Fetch arXiv Atom metadata (journal_ref, doi, comment). Cached under POLARIS_LITERATURE_CACHE_ROOT/arxiv-meta/."""
    import urllib.request

    aid = arxiv_id.strip()
    shared = (os.environ.get("POLARIS_LITERATURE_CACHE_ROOT") or "").strip()
    if not shared:
        raise RuntimeError("POLARIS_LITERATURE_CACHE_ROOT is required for arXiv metadata cache")
    cache_root = Path(shared).expanduser().resolve() / "arxiv-meta"
    cache_path = cache_root / f"{aid.replace('/', '_')}.json"
    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached.get("arxiv_id") == aid:
                return cached
        except (OSError, json.JSONDecodeError):
            pass

    url = f"http://export.arxiv.org/api/query?id_list={aid}"
    request = urllib.request.Request(
        url, headers={"User-Agent": "polaris-literature-scope/0.2 (research)"}
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        raw = response.read()
    ns = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(raw)
    entry = root.find("a:entry", ns)
    result: dict[str, Any] = {"arxiv_id": aid, "fetched": True}
    if entry is None:
        result["error"] = "no_entry"
        return result

    def _text(path: str) -> str | None:
        node = entry.find(path, ns)
        if node is None or node.text is None:
            return None
        text = re.sub(r"\s+", " ", node.text).strip()
        return text or None

    result["title"] = _text("a:title")
    result["journal_ref"] = _text("arxiv:journal_ref")
    result["doi"] = _text("arxiv:doi")
    result["comment"] = _text("arxiv:comment")
    result["primary_category"] = None
    primary = entry.find("arxiv:primary_category", ns)
    if primary is not None:
        result["primary_category"] = primary.attrib.get("term")
    result["publication_hints"] = parse_arxiv_publication_hints(
        comment=result.get("comment") if isinstance(result.get("comment"), str) else None,
        journal_ref=(
            result.get("journal_ref") if isinstance(result.get("journal_ref"), str) else None
        ),
    )
    try:
        cache_root.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return result


def enrich_record_from_arxiv_api(
    record: dict[str, Any],
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge arXiv journal_ref/comment/doi hints into payload for venue matching.

    Does not remove arXiv host identity; it only adds peer-publication signals so
    ``_match_venue`` / CCF can accept dual-published preprints.
    """
    import copy as copy_mod

    aid = extract_arxiv_id(record)
    if not aid:
        return record
    meta = metadata if isinstance(metadata, dict) else fetch_arxiv_atom_metadata(aid)
    updated = copy_mod.deepcopy(record)
    payload = updated.get("payload") if isinstance(updated.get("payload"), dict) else {}
    payload = dict(payload)
    if meta.get("comment"):
        payload["arxiv_comment"] = meta["comment"]
    if meta.get("journal_ref"):
        payload["arxiv_journal_ref"] = meta["journal_ref"]
    if meta.get("doi") and not (payload.get("DOI") or payload.get("doi")):
        payload["DOI"] = meta["doi"]
    comment = meta.get("comment") if isinstance(meta.get("comment"), str) else None
    journal_ref = meta.get("journal_ref") if isinstance(meta.get("journal_ref"), str) else None
    # Workshops are not CCF main-track; keep comment for audit only.
    if comment and re.search(r"(?i)\bworkshop\b", comment) and not journal_ref:
        payload["arxiv_is_workshop"] = True
        updated["payload"] = payload
        return updated
    hints = meta.get("publication_hints") if isinstance(meta.get("publication_hints"), list) else []
    if not hints:
        hints = parse_arxiv_publication_hints(comment=comment, journal_ref=journal_ref)
    if hints:
        payload["arxiv_publication_hints"] = hints
        # If the only venue label is arXiv/CoRR, promote first hint for matching.
        labels = _venue_label_strings(updated)
        if not labels or all(_venue_is_arxiv_corr_label(label) for label in labels):
            payload["container-title"] = hints[0]
            payload["venue"] = hints[0]
    updated["payload"] = payload
    return updated


def _match_venue(
    record: dict[str, Any],
    catalog: VenueCatalog,
    bounds: LiteratureBounds,
) -> dict[str, Any] | None:
    """Return matching CCF venue dict if record is in-scope by venue."""
    blob = _text_blob(record)
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    # Peer-publication hints from arXiv Atom (not raw workshop comments — those
    # would false-hit parent CCF abbrs like NeurIPS).
    if not payload.get("arxiv_is_workshop"):
        for key in ("arxiv_journal_ref", "arxiv_publication_hints"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                blob = f"{blob} | {value.lower()}"
            elif isinstance(value, list):
                blob = f"{blob} | " + " | ".join(
                    str(item).lower() for item in value if item
                )
        # Main-track accept comments only (workshop flag cleared above).
        comment = payload.get("arxiv_comment")
        if isinstance(comment, str) and comment.strip():
            blob = f"{blob} | {comment.lower()}"

    # 0) PACMSE / Proceedings of the ACM on Software Engineering → FSE (sigsoft),
    # not the crypto "Fast Software Encryption" conference that also uses abbr FSE.
    if (
        "proceedings of the acm on software engineering" in blob
        or "pacmse" in blob
        or "proc. acm softw. eng" in blob
    ):
        for venue in catalog.venues:
            if venue.get("dblp_key") == "conf/sigsoft" and _venue_allowed(venue, bounds):
                return venue

    # 1) DBLP keys from externalIds / URLs (strongest peer-venue signal).
    # Skip journals/corr — that is the arXiv CoRR bucket, not a CCF peer venue.
    for key in dblp_keys_from_record(record):
        if key == "journals/corr" or key.startswith("journals/corr/"):
            continue
        venue = catalog.by_dblp_key.get(key)
        if venue and _venue_allowed(venue, bounds):
            return venue

    # 1b) DBLP key from URLs in payload / source_url.
    urls: list[str] = []
    if isinstance(record.get("source_url"), str):
        urls.append(record["source_url"])
    for key in ("URL", "url", "resource"):
        value = payload.get(key)
        if isinstance(value, str):
            urls.append(value)
    for url in urls:
        lower = url.lower()
        match = re.search(
            r"dblp\.(?:org|uni-trier\.de)/db/(journals|conf)/([^/\s\.]+)", lower
        )
        if match:
            key = f"{match.group(1)}/{match.group(2)}"
            if key == "journals/corr":
                continue
            venue = catalog.by_dblp_key.get(key)
            if venue and _venue_allowed(venue, bounds):
                return venue

    # 2) Explicit short titles / event fields before free-token scan.
    explicit: list[str] = []
    for key in ("short-container-title", "event", "abbreviated-container-title"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            explicit.append(value.strip().lower())
        elif isinstance(value, list):
            explicit.extend(str(item).strip().lower() for item in value if item)
    for raw in explicit:
        token = ABBR_ALIASES.get(raw, raw)
        # Also try last segment after comma.
        for candidate in {token, token.split(",")[0].strip()}:
            if candidate in _GENERIC_ABBR_BLOCKLIST:
                continue
            for venue in catalog.by_abbr.get(candidate, []):
                if _venue_allowed(venue, bounds):
                    return venue

    # multi-word aliases anywhere in blob (e.g. "ieee symposium on security and privacy")
    alias_hits: list[tuple[int, str]] = []
    for alias, canonical in ABBR_ALIASES.items():
        if " " in alias and alias in blob:
            alias_hits.append((len(alias), canonical))
    for _, canonical in sorted(alias_hits, reverse=True):
        for venue in catalog.by_abbr.get(canonical, []):
            if _venue_allowed(venue, bounds):
                return venue

    # 3) Abbreviation tokens — longer / distinctive first; block generics.
    tokens: list[str] = []
    for raw in re.findall(r"\b[A-Za-z][A-Za-z0-9&]{1,24}\b", blob):
        tokens.append(raw.lower())
    # Include S&P-style
    if "s&p" in blob or re.search(r"\bs\s*&\s*p\b", blob):
        tokens.append("s&p")

    ranked: list[tuple[int, str]] = []
    seen: set[str] = set()
    for token in tokens:
        token = ABBR_ALIASES.get(token, token)
        if token in seen or token in _GENERIC_ABBR_BLOCKLIST:
            continue
        if token not in catalog.by_abbr:
            continue
        # Prefer longer abbreviations (CCS, NDSS, USENIX-like).
        ranked.append((len(token), token))
        seen.add(token)
    for _, token in sorted(ranked, reverse=True):
        for venue in catalog.by_abbr.get(token, []):
            if _venue_allowed(venue, bounds):
                return venue

    # 4) Full-name substring — require a reasonably long, distinctive name.
    for venue in catalog.venues:
        if not _venue_allowed(venue, bounds):
            continue
        name = venue.get("full_name")
        if not isinstance(name, str):
            continue
        needle = name.lower().strip()
        if len(needle) < 24:
            continue
        # Skip obviously broken multi-merged PDF lines.
        if needle.count("ieee") + needle.count("acm") + needle.count("conference") > 3:
            continue
        if needle in blob:
            return venue
    return None


def evaluate_record(
    record: dict[str, Any],
    *,
    bounds: LiteratureBounds | None = None,
    catalog: VenueCatalog | None = None,
    topic_keywords: list[str] | None = None,
) -> dict[str, Any]:
    """Evaluate whether a literature record is inside product bounds.

    Returns a decision object:
      in_bounds: bool
      reasons: list[str]  (reject reasons if not in bounds)
      year, venue_match, arxiv_corr, topic
    """
    bounds = bounds or default_bounds()
    catalog = catalog or VenueCatalog.load(bounds.catalog_path)
    reasons: list[str] = []

    year = record_year(record)
    if year is None:
        reasons.append("year_unknown")
    elif year < bounds.from_year or year > bounds.to_year:
        reasons.append(f"year_out_of_range:{year}")

    arxiv = is_arxiv_corr_record(record)
    venue = _match_venue(record, catalog, bounds) if bounds.require_ccf_venue else None
    if bounds.require_ccf_venue:
        # CCF venue wins: peer-reviewed hit is in-bounds even if also on arXiv.
        # Pure arXiv/CoRR is only admitted when allow_arxiv_corr is true.
        if venue is None and not (bounds.allow_arxiv_corr and arxiv):
            if arxiv and not bounds.allow_arxiv_corr:
                reasons.append("arxiv_corr_excluded")
            else:
                reasons.append("venue_not_in_ccf_and_not_arxiv")
    else:
        # Venue gate off: still honor allow_arxiv_corr as an explicit exclude.
        if arxiv and not bounds.allow_arxiv_corr:
            reasons.append("arxiv_corr_excluded")
        else:
            # Optional soft match for diagnostics only (does not reject).
            venue = _match_venue(record, catalog, bounds)

    keywords = [k for k in (topic_keywords or []) if isinstance(k, str) and k.strip()]
    topic = match_topic_keywords(record, keywords) if keywords else {
        "matched": [],
        "text_chars": 0,
        "has_title": bool(record_title(record)),
        "has_abstract": bool(record_abstract(record)),
        "skipped": True,
    }
    if keywords:
        if not topic.get("has_title") and not topic.get("has_abstract"):
            reasons.append("topic_text_missing")
        elif not topic.get("matched"):
            reasons.append("topic_keyword_miss")

    in_bounds = not reasons
    # Year unknown: still reject by default (strict bound 1). Callers may soft-accept.
    return {
        "in_bounds": in_bounds,
        "reasons": reasons,
        "year": year,
        "arxiv_corr": arxiv,
        "venue": {
            "abbr": venue.get("abbr"),
            "rank": venue.get("rank"),
            "kind": venue.get("kind"),
            "field": venue.get("field"),
            "dblp_key": venue.get("dblp_key"),
            "full_name": venue.get("full_name"),
        }
        if venue
        else None,
        "topic": {
            "keywords": keywords,
            "matched": list(topic.get("matched") or []),
            "has_title": bool(topic.get("has_title")),
            "has_abstract": bool(topic.get("has_abstract")),
            "text_chars": int(topic.get("text_chars") or 0),
            "skipped": bool(topic.get("skipped")),
        },
        "bounds": bounds.to_dict(),
    }


def filter_records(
    records: list[dict[str, Any]],
    *,
    bounds: LiteratureBounds | None = None,
    catalog: VenueCatalog | None = None,
    topic_keywords: list[str] | None = None,
) -> dict[str, Any]:
    """Split records into accepted / rejected under bounds + topic keywords."""
    bounds = bounds or default_bounds()
    catalog = catalog or VenueCatalog.load(bounds.catalog_path)
    keywords = [k for k in (topic_keywords or []) if isinstance(k, str) and k.strip()]
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        decision = evaluate_record(
            record, bounds=bounds, catalog=catalog, topic_keywords=keywords
        )
        item = {**record, "scope_decision": decision}
        if decision["in_bounds"]:
            accepted.append(item)
        else:
            rejected.append(item)
    return {
        "bounds": bounds.to_dict(),
        "topic_keywords": keywords,
        "accepted": accepted,
        "rejected": rejected,
        "accepted_count": len(accepted),
        "rejected_count": len(rejected),
    }
