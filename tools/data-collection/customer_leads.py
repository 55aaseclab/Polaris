#!/usr/bin/env python3
"""Preprocess public business candidates from independently versioned sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse, urlunparse

from website import FetchError, contact_like_links, fetch_page, host_from_url, robots_allows

# tools/data-collection/customer_leads.py — phase 2 (augmentation) customer-leads logic.
_PACKAGE_DIR = Path(__file__).resolve().parent
TOOLS_DIR = _PACKAGE_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
if str(_PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_DIR))
try:
    from paths import WorkspacePathError, collection_paths
except ImportError:
    WorkspacePathError = ValueError  # type: ignore[misc,assignment]
    collection_paths = None  # type: ignore[assignment]


EMAIL_BACKEND_ROOT = _PACKAGE_DIR / "backend" / "kichik-email-scraper"
if EMAIL_BACKEND_ROOT.is_dir():
    sys.path.insert(0, str(EMAIL_BACKEND_ROOT))
try:
    from email_scraper import scrape_emails as locked_email_scraper
except ImportError:
    locked_email_scraper = None


MARKETPLACE_DOMAINS = {
    "amazon.com",
    "amazon.de",
    "amazon.fr",
    "amazon.it",
    "ebay.com",
    "etsy.com",
    "facebook.com",
    "instagram.com",
    "pinterest.com",
    "wikipedia.org",
}

HOSTED_SOCIAL_DOMAINS = {
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "linkedin.com",
    "linktr.ee",
    "beacons.ai",
    "campsite.bio",
}

GENERIC_EMAIL_LOCAL_PARTS = {
    "admin",
    "booking",
    "boutique",
    "contact",
    "events",
    "hello",
    "help",
    "info",
    "marketing",
    "office",
    "orders",
    "partner",
    "partners",
    "sales",
    "service",
    "shop",
    "store",
    "support",
    "team",
    "wholesale",
}

PHONE_PATTERN = re.compile(
    r"(?<!\w)(?:\+|00)?(?:\(?\d{1,4}\)?[\s./-]?){2,8}\d{2,4}(?!\w)"
)

SOCIAL_CONTACT_PREFIXES = {
    "instagram.com": "instagram_dm",
    "linkedin.com": "linkedin_message",
}


class CliError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        handle.write("\n")


def clean_text(value: Any, limit: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFKC", value)
    text = re.sub(r"\s+", " ", text).strip()
    if not text or text.lower() in {"none", "null", "n/a", "na", "-"}:
        return None
    return text[:limit]


def identity_text(value: Any) -> str | None:
    text = clean_text(value, 500)
    if not text:
        return None
    text = text.casefold()
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def normalize_url(value: Any) -> str | None:
    text = clean_text(value, 2048)
    if not text:
        return None
    if text.startswith("www."):
        text = f"https://{text}"
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    hostname = parsed.hostname
    if not hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        # A page can contain malformed links such as ``https://host:blank``.
        # They are neither valid contact nor social evidence, so discard them.
        return None
    netloc = hostname.lower()
    if port:
        netloc = f"{netloc}:{port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    return urlunparse((parsed.scheme.lower(), netloc, path, "", "", ""))


def normalized_domain(url: str | None) -> str | None:
    if not url:
        return None
    hostname = urlparse(url).hostname
    if not hostname:
        return None
    return hostname.lower().removeprefix("www.")


def is_marketplace_domain(domain: str | None) -> bool:
    if not domain:
        return False
    return any(domain == item or domain.endswith(f".{item}") for item in MARKETPLACE_DOMAINS)


def is_hosted_social_domain(domain: str | None) -> bool:
    if not domain:
        return False
    return any(domain == item or domain.endswith(f".{item}") for item in HOSTED_SOCIAL_DOMAINS)


def company_website_candidate(value: Any) -> str | None:
    url = normalize_url(value)
    return None if is_hosted_social_domain(normalized_domain(url)) else url


def nonempty_list(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = clean_text(value)
        if text and text not in result:
            result.append(text)
    return result


def candidate_base(source_type: str, source_path: Path, trace: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_type": source_type,
        "source_path": str(source_path),
        "source_trace": trace,
        "company_name": None,
        "website_candidate_url": None,
        "target_market": None,
        "country": None,
        "city": None,
        "street_address": None,
        "postal_code": None,
        "public_business_phone": None,
        "social_links": [],
        "buyer_type_ids": [],
        "candidate_kind": source_type,
    }


def adapt_google_maps(document: Any, source_path: Path) -> Iterable[dict[str, Any]]:
    if not isinstance(document, list):
        raise CliError(f"google_maps output must be an array: {source_path}")
    for item in document:
        if not isinstance(item, dict):
            continue
        location = item.get("location") if isinstance(item.get("location"), dict) else {}
        trace = {
            "source_type": "google_maps",
            "source_url": normalize_url(item.get("maps_url")),
            "source_record_id": clean_text(item.get("data_id") or item.get("place_id") or item.get("cid"), 200),
        }
        candidate = candidate_base("google_maps", source_path, trace)
        candidate.update(
            {
                "company_name": clean_text(item.get("company_name")),
                "website_candidate_url": company_website_candidate(item.get("website_url")),
                "country": clean_text(location.get("country")),
                "city": clean_text(location.get("city")),
                "street_address": clean_text(location.get("street") or item.get("address")),
                "postal_code": clean_text(location.get("postal_code")),
                "public_business_phone": clean_text(item.get("phone")),
                "candidate_kind": "business_listing",
                "source_categories": nonempty_list(item.get("categories", [])),
            }
        )
        yield candidate


def adapt_web_search(document: Any, source_path: Path) -> Iterable[dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("task_results"), list):
        raise CliError(f"web_search output has no task_results array: {source_path}")
    for task in document["task_results"]:
        if not isinstance(task, dict) or task.get("status") != "succeeded":
            continue
        for result in task.get("results", []):
            if not isinstance(result, dict):
                continue
            url = normalize_url(result.get("url"))
            trace = {
                "source_type": "web_search",
                "source_url": url,
                "task_id": clean_text(task.get("task_id"), 200),
                "query": clean_text(task.get("query"), 300),
                "search_engines": nonempty_list(result.get("engines", [])),
            }
            candidate = candidate_base("web_search", source_path, trace)
            candidate.update(
                {
                    "company_name": clean_text(result.get("title")),
                    "website_candidate_url": company_website_candidate(url),
                    "target_market": clean_text(task.get("market")),
                    "city": clean_text(task.get("city")),
                    "buyer_type_ids": nonempty_list(task.get("buyer_type_ids", [])),
                    "candidate_kind": "search_result_page",
                }
            )
            yield candidate


def adapt_industry_directories(document: Any, source_path: Path) -> Iterable[dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("candidates"), list):
        raise CliError(f"industry_directories output has no candidates array: {source_path}")
    for item in document["candidates"]:
        if not isinstance(item, dict):
            continue
        listing_url = normalize_url(item.get("directory_listing_url"))
        trace = item.get("source_trace") if isinstance(item.get("source_trace"), dict) else {}
        trace = {
            "source_type": "industry_directories",
            "source_url": listing_url,
            "directory_domain": clean_text(item.get("directory_domain"), 200),
            "task_id": clean_text(item.get("parent_task_id"), 200),
            "query": clean_text(trace.get("query"), 300),
        }
        candidate = candidate_base("industry_directories", source_path, trace)
        candidate.update(
            {
                "company_name": clean_text(item.get("listing_title")),
                "directory_listing_url": listing_url,
                "target_market": clean_text(item.get("market")),
                "city": clean_text(item.get("city")),
                "buyer_type_ids": nonempty_list(item.get("buyer_type_ids", [])),
                "candidate_kind": "directory_listing_page",
            }
        )
        yield candidate


def adapt_social_media(document: Any, source_path: Path) -> Iterable[dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("candidates"), list):
        raise CliError(f"social_media output has no candidates array: {source_path}")
    for item in document["candidates"]:
        if not isinstance(item, dict):
            continue
        trace = item.get("source_trace") if isinstance(item.get("source_trace"), dict) else {}
        account_url = normalize_url(item.get("account_url"))
        trace = {
            "source_type": "social_media",
            "source_url": account_url,
            "task_id": clean_text(trace.get("task_id"), 200),
            "query": clean_text(trace.get("query"), 300),
            "platform": clean_text(item.get("platform"), 100),
            "post_url": normalize_url(item.get("post_url")),
        }
        candidate = candidate_base("social_media", source_path, trace)
        candidate.update(
            {
                "company_name": clean_text(item.get("company_name") or item.get("account_handle")),
                "website_candidate_url": company_website_candidate(item.get("public_website_url")),
                "target_market": clean_text(item.get("market")),
                "city": clean_text(item.get("city")),
                "social_links": nonempty_list([account_url, normalize_url(item.get("public_website_url"))]),
                "buyer_type_ids": nonempty_list(item.get("buyer_type_ids", [])),
                "social_account_handle": clean_text(item.get("account_handle"), 200),
                "candidate_kind": "business_social_account",
            }
        )
        yield candidate


ADAPTERS = {
    "google_maps": adapt_google_maps,
    "web_search": adapt_web_search,
    "industry_directories": adapt_industry_directories,
    "social_media": adapt_social_media,
}


def source_output_spec(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("source output must use source_type=path")
    source_type, raw_path = value.split("=", 1)
    if source_type not in ADAPTERS:
        raise argparse.ArgumentTypeError(f"unsupported source type: {source_type}")
    path = Path(raw_path).expanduser().resolve()
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"source output is missing: {path}")
    return source_type, path


def merge_key(candidate: dict[str, Any]) -> str:
    domain = normalized_domain(candidate.get("website_candidate_url"))
    if domain:
        return f"domain:{domain}"
    if candidate["source_type"] == "social_media" and candidate.get("social_account_handle"):
        return f"social:{candidate['social_account_handle'].casefold()}"
    name = identity_text(candidate.get("company_name"))
    address = identity_text(candidate.get("street_address"))
    if name and address:
        return f"name-address:{name}|{address}"
    source_url = candidate.get("directory_listing_url") or candidate["source_trace"].get("source_url")
    if source_url:
        return f"source-url:{source_url}"
    return f"orphan:{hashlib.sha256(json.dumps(candidate, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()}"


def candidate_quality(candidate: dict[str, Any]) -> tuple[int, int]:
    kind_score = {
        "business_listing": 4,
        "business_social_account": 3,
        "search_result_page": 2,
        "directory_listing_page": 1,
    }.get(candidate.get("candidate_kind"), 0)
    return kind_score, len(candidate.get("company_name") or "")


def pick_value(current: Any, incoming: Any, prefer_incoming: bool) -> Any:
    if incoming in (None, "", [], {}):
        return current
    if current in (None, "", [], {}) or prefer_incoming:
        return incoming
    return current


def merge_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        groups[merge_key(candidate)].append(candidate)

    merged: list[dict[str, Any]] = []
    for key, group in groups.items():
        group.sort(key=candidate_quality, reverse=True)
        primary = group[0]
        record = {
            "candidate_id": f"candidate_{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}",
            "company_name": primary.get("company_name"),
            "normalized_company_name": identity_text(primary.get("company_name")),
            "website_candidate_url": primary.get("website_candidate_url"),
            "normalized_domain": normalized_domain(primary.get("website_candidate_url")),
            "target_markets": [],
            "country": primary.get("country"),
            "city": primary.get("city"),
            "street_address": primary.get("street_address"),
            "postal_code": primary.get("postal_code"),
            "public_business_phone": primary.get("public_business_phone"),
            "social_links": [],
            "buyer_type_ids": [],
            "candidate_kinds": [],
            "source_types": [],
            "source_traces": [],
        }
        for candidate in group:
            prefer = candidate_quality(candidate) > candidate_quality(primary)
            for field in ("company_name", "website_candidate_url", "country", "city", "street_address", "postal_code", "public_business_phone"):
                record[field] = pick_value(record.get(field), candidate.get(field), prefer)
            for market in nonempty_list([candidate.get("target_market")]):
                if market not in record["target_markets"]:
                    record["target_markets"].append(market)
            for social in candidate.get("social_links", []):
                if social not in record["social_links"]:
                    record["social_links"].append(social)
            for buyer_type in candidate.get("buyer_type_ids", []):
                if buyer_type not in record["buyer_type_ids"]:
                    record["buyer_type_ids"].append(buyer_type)
            if candidate["candidate_kind"] not in record["candidate_kinds"]:
                record["candidate_kinds"].append(candidate["candidate_kind"])
            if candidate["source_type"] not in record["source_types"]:
                record["source_types"].append(candidate["source_type"])
            trace = candidate["source_trace"]
            if trace not in record["source_traces"]:
                record["source_traces"].append(trace)
        record["normalized_company_name"] = identity_text(record["company_name"])
        record["normalized_domain"] = normalized_domain(record["website_candidate_url"])
        missing: list[str] = []
        if not record["website_candidate_url"]:
            missing.append("website_candidate_url")
        missing.append("official_website_verification")
        if not record["public_business_phone"] and not record["social_links"]:
            missing.append("public_business_contact_path")
        if not record["buyer_type_ids"]:
            missing.append("buyer_type_classification")
        if not record["country"]:
            missing.append("country_confirmation")
        record["missing_for_augmentation"] = missing
        merged.append(record)
    return sorted(merged, key=lambda item: (item["normalized_domain"] or "~", item["normalized_company_name"] or "~"))


def structural_rejection(candidate: dict[str, Any]) -> str | None:
    if not candidate.get("company_name"):
        return "missing_company_name"
    candidate_url = candidate.get("website_candidate_url")
    if candidate_url and is_marketplace_domain(normalized_domain(candidate_url)):
        return "excluded_marketplace_domain"
    source_url = candidate["source_trace"].get("source_url")
    if not source_url and not candidate_url and not candidate.get("social_links"):
        return "missing_public_source_path"
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def identity_tokens(value: str | None) -> set[str]:
    normalized = identity_text(value) or ""
    ignored = {"ag", "gmbh", "sarl", "sa", "ltd", "llc", "inc", "shop", "store", "boutique", "the", "and", "und", "for"}
    return {token for token in normalized.split() if len(token) >= 3 and token not in ignored}


def fold_for_match(value: str) -> str:
    """Case-fold text and remove accents for configured market matching."""

    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def matching_rules(input_document: dict[str, Any]) -> dict[str, Any]:
    rules = input_document.get("matching_rules")
    return rules if isinstance(rules, dict) else {}


def configured_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return nonempty_list(value)


def target_markets(input_document: dict[str, Any]) -> list[dict[str, Any]]:
    """Return configured markets, accepting the former singular market key."""

    markets = input_document.get("markets")
    configured = (
        [market for market in markets if isinstance(market, dict)]
        if isinstance(markets, list)
        else []
    )
    if configured:
        return configured
    legacy_market = input_document.get("market")
    return [legacy_market] if isinstance(legacy_market, dict) else []


def target_market(input_document: dict[str, Any]) -> dict[str, Any]:
    """Return the first configured market for legacy single-market callers."""

    markets = target_markets(input_document)
    return markets[0] if markets else {}


def market_country_code(market: dict[str, Any]) -> str | None:
    value = clean_text(market.get("country_code"), 8)
    return value.upper() if value and len(value) == 2 and value.isalpha() else None


def target_country_code(input_document: dict[str, Any]) -> str | None:
    return market_country_code(target_market(input_document))


def target_country_codes(input_document: dict[str, Any]) -> list[str]:
    return list(
        dict.fromkeys(
            code
            for market in target_markets(input_document)
            if (code := market_country_code(market))
        )
    )


def normalize_country_code(value: Any) -> str | None:
    country = clean_text(value, 8)
    return country.upper() if country and len(country) == 2 and country.isalpha() else None


def market_country_terms(
    input_document: dict[str, Any], market: dict[str, Any]
) -> list[str]:
    rules = matching_rules(input_document)
    values = [
        market_country_code(market),
        clean_text(market.get("country_name"), 120),
        clean_text(market.get("country_name_zh"), 120),
        *configured_strings(market.get("country_aliases")),
    ]
    if len(target_markets(input_document)) == 1:
        values.extend(configured_strings(rules.get("country_aliases")))
    return list(dict.fromkeys(value for value in values if value))


def target_country_terms(input_document: dict[str, Any]) -> list[str]:
    return list(
        dict.fromkeys(
            term
            for market in target_markets(input_document)
            for term in market_country_terms(input_document, market)
        )
    )


def matched_target_market(
    candidate: dict[str, Any], input_document: dict[str, Any], all_text: str
) -> dict[str, Any] | None:
    markets = target_markets(input_document)
    if not markets:
        return {}
    candidate_values = [clean_text(candidate.get("country"), 120)]
    candidate_values.extend(configured_strings(candidate.get("target_markets")))
    folded_values = {
        fold_for_match(value) for value in candidate_values if value
    }
    for market in markets:
        if folded_values & {
            fold_for_match(term)
            for term in market_country_terms(input_document, market)
        }:
            return market
    folded_text = fold_for_match(all_text)
    for market in markets:
        terms = market_country_terms(input_document, market)
        if any(
            len(fold_for_match(term)) >= 3
            and fold_for_match(term) in folded_text
            for term in terms
        ):
            return market
    return None


def candidate_is_in_target_market(
    candidate: dict[str, Any], input_document: dict[str, Any], all_text: str
) -> bool:
    return matched_target_market(candidate, input_document, all_text) is not None


def buyer_type_entries(input_document: dict[str, Any]) -> list[dict[str, Any]]:
    values = input_document.get("target_buyer_types")
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []


def buyer_type_keywords(input_document: dict[str, Any], buyer_type: dict[str, Any]) -> list[str]:
    buyer_type_id = clean_text(buyer_type.get("buyer_type_id"), 160)
    configured = matching_rules(input_document).get("buyer_type_keywords")
    configured_values = configured.get(buyer_type_id) if isinstance(configured, dict) and buyer_type_id else None
    return configured_strings(configured_values) or configured_strings(buyer_type.get("match_keywords")) or configured_strings(
        buyer_type.get("fit_signals")
    )


def product_category_keywords(input_document: dict[str, Any], category_id: str) -> list[str]:
    configured = matching_rules(input_document).get("product_category_keywords")
    configured_values = configured.get(category_id) if isinstance(configured, dict) else None
    if configured_strings(configured_values):
        return configured_strings(configured_values)
    products = input_document.get("product_portfolio")
    if not isinstance(products, list):
        return []
    for product in products:
        if not isinstance(product, dict) or product.get("category_id") != category_id:
            continue
        return configured_strings(product.get("match_keywords")) or configured_strings(
            product.get("examples")
        ) or configured_strings(product.get("sales_roles"))
    return []


def configured_score_limit(input_document: dict[str, Any], dimension: str, fallback: int) -> int:
    policy = input_document.get("qualification_policy")
    dimensions = policy.get("score_dimensions") if isinstance(policy, dict) else None
    if isinstance(dimensions, list):
        for entry in dimensions:
            if not isinstance(entry, dict) or entry.get("dimension") != dimension:
                continue
            value = entry.get("max_points")
            if isinstance(value, int) and value >= 0:
                return value
    return fallback


def qualification_threshold(input_document: dict[str, Any]) -> int:
    filters = input_document.get("filters")
    value = filters.get("minimum_qualification_score") if isinstance(filters, dict) else None
    return value if isinstance(value, int) and value >= 0 else 0


def high_priority_threshold(input_document: dict[str, Any]) -> int | None:
    policy = input_document.get("qualification_policy")
    rules = policy.get("priority_rules") if isinstance(policy, dict) else None
    if not isinstance(rules, list):
        return None
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("priority") != "high":
            continue
        score = rule.get("score")
        if isinstance(score, int):
            return score
        if isinstance(score, str):
            match = re.search(r"\d+", score)
            if match:
                return int(match.group(0))
    return None


def collection_slug(input_document: dict[str, Any]) -> str:
    raw = clean_text(input_document.get("collection_id"), 120) or "collection"
    value = re.sub(r"[^a-z0-9]+", "-", raw.casefold()).strip("-")
    return value[:32] or "collection"


def source_task_buyer_types(input_document: dict[str, Any]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    for source in input_document.get("sources", []):
        if not isinstance(source, dict):
            continue
        for task in source.get("tasks", []):
            if not isinstance(task, dict) or not isinstance(task.get("task_id"), str):
                continue
            mapping[task["task_id"]] = nonempty_list(task.get("buyer_type_ids", []))
    return mapping


def candidate_buyer_hints(candidate: dict[str, Any], task_buyer_types: dict[str, list[str]]) -> list[str]:
    values = list(candidate.get("buyer_type_ids", []))
    for trace in candidate.get("source_traces", []):
        if isinstance(trace, dict):
            values.extend(task_buyer_types.get(trace.get("task_id"), []))
    return nonempty_list(values)


def source_trace_for_output(trace: dict[str, Any], collected_at: str) -> dict[str, Any] | None:
    source_type = clean_text(trace.get("source_type"), 100)
    source_url = normalize_url(trace.get("source_url"))
    if not source_type or not source_url:
        return None
    output: dict[str, Any] = {
        "source_type": source_type,
        "source_url": source_url,
        "collected_at": collected_at,
    }
    task_id = clean_text(trace.get("task_id"), 200)
    if task_id:
        output["task_id"] = task_id
    detail_bits = [clean_text(trace.get(field), 180) for field in ("query", "directory_domain", "platform")]
    details = [bit for bit in detail_bits if bit]
    if details:
        output["evidence_summary"] = "; ".join(details)
    return output


def source_traces_for_output(candidate: dict[str, Any], collected_at: str) -> list[dict[str, Any]]:
    traces: list[dict[str, Any]] = []
    for trace in candidate.get("source_traces", []):
        if not isinstance(trace, dict):
            continue
        transformed = source_trace_for_output(trace, collected_at)
        if transformed and transformed not in traces:
            traces.append(transformed)
    return traces


def language_from_page(language: str | None, text: str) -> str | None:
    if language:
        prefix = language.replace("_", "-").split("-", 1)[0]
        if len(prefix) == 2 and prefix.isalpha():
            return prefix
    return None


def extract_public_business_emails(email_candidates: Iterable[str]) -> list[str]:
    emails: list[str] = []
    for candidate in sorted({value for value in email_candidates if isinstance(value, str)}, key=str.casefold):
        email = clean_text(candidate, 320)
        if not email:
            continue
        email = email.lower().rstrip(".,;:")
        if "@" not in email:
            continue
        local = email.split("@", 1)[0].casefold()
        if local not in GENERIC_EMAIL_LOCAL_PARTS:
            continue
        if email not in emails:
            emails.append(email)
    return emails


def extract_public_business_phones(text: str) -> list[str]:
    phones: list[str] = []
    for match in PHONE_PATTERN.finditer(text):
        phone = re.sub(r"\s+", " ", match.group(0)).strip(" .;/")
        digits = re.sub(r"\D", "", phone)
        if len(digits) < 8 or len(digits) > 15:
            continue
        if phone not in phones:
            phones.append(phone)
    return phones


def page_social_links(links: Iterable[str]) -> list[str]:
    result: list[str] = []
    for link in links:
        normalized = normalize_url(link)
        domain = normalized_domain(normalized)
        if normalized and domain and is_hosted_social_domain(domain) and normalized not in result:
            result.append(normalized)
    return result


def keyword_in_text(text: str, keyword: str) -> bool:
    """Match terms and phrases without accepting a substring inside a word."""

    return re.search(r"(?<!\w)" + re.escape(keyword.casefold()) + r"(?!\w)", text.casefold()) is not None


def classify_buyer_type(
    text: str, hints: list[str], input_document: dict[str, Any]
) -> tuple[str | None, list[str], list[str]]:
    lowered = text.casefold()
    matches: list[tuple[int, int, str, list[str]]] = []
    for buyer_type in buyer_type_entries(input_document):
        buyer_type_id = clean_text(buyer_type.get("buyer_type_id"), 160)
        if not buyer_type_id:
            continue
        keywords = buyer_type_keywords(input_document, buyer_type)
        found = [keyword for keyword in keywords if keyword_in_text(lowered, keyword)]
        score = len(found) * 10 + (3 if buyer_type_id in hints else 0)
        if found:
            priority = buyer_type.get("priority")
            matches.append((score, priority if isinstance(priority, int) else 999, buyer_type_id, found))
    if not matches:
        return None, [], []
    matches.sort(key=lambda item: (-item[0], item[1], item[2]))
    primary_score, _, primary, primary_hits = matches[0]
    secondary = [buyer_type_id for score, _, buyer_type_id, _ in matches[1:] if score >= max(10, primary_score - 10)]
    return primary, secondary, primary_hits


def verified_company_name(candidate: dict[str, Any], title: str, text: str) -> bool:
    tokens = identity_tokens(candidate.get("company_name"))
    if not tokens:
        return False
    haystack = identity_text(f"{title} {text[:12_000]}") or ""
    matched = sum(1 for token in tokens if token in haystack)
    # A long distinctive name needs one hit; shorter/multiword names need two.
    if matched >= 2 or any(len(token) >= 8 and token in haystack for token in tokens):
        return True
    # Maps exposes the merchant-provided website link.  One distinctive name
    # token on the fetched page is enough to retain that source assertion; a
    # web-search-only candidate remains subject to the stricter rule above.
    source_types = set(candidate.get("source_types", []))
    return "google_maps" in source_types and any(len(token) >= 4 and token in haystack for token in tokens)


def derive_city(candidate: dict[str, Any], input_document: dict[str, Any], all_text: str) -> str | None:
    city = clean_text(candidate.get("city"), 120)
    if city:
        return city
    task_cities: list[str] = []
    for source in input_document.get("sources", []):
        if not isinstance(source, dict):
            continue
        for task in source.get("tasks", []):
            if isinstance(task, dict) and isinstance(task.get("task_id"), str) and task.get("city"):
                task_cities.append(str(task["city"]))
    for market in target_markets(input_document):
        market_localities = market.get("priority_localities")
        if isinstance(market_localities, list):
            for locality in market_localities:
                if isinstance(locality, dict) and locality.get("city"):
                    task_cities.append(str(locality["city"]))
    configured_aliases = matching_rules(input_document).get("city_aliases")
    folded_text = fold_for_match(all_text)
    for configured_city in task_cities:
        aliases = [configured_city]
        if isinstance(configured_aliases, dict):
            aliases.extend(configured_strings(configured_aliases.get(configured_city)))
        if any(fold_for_match(alias) in folded_text for alias in aliases):
            return configured_city
    return None


def expected_product_categories(input_document: dict[str, Any], buyer_type_id: str) -> list[str]:
    for buyer_type in input_document.get("target_buyer_types", []):
        if isinstance(buyer_type, dict) and buyer_type.get("buyer_type_id") == buyer_type_id:
            return nonempty_list(buyer_type.get("product_category_ids", []))
    return []


def product_fit_keyword_hits(
    text: str, input_document: dict[str, Any], category_ids: list[str]
) -> list[str]:
    lowered = text.casefold()
    keywords = [
        keyword
        for category_id in category_ids
        for keyword in product_category_keywords(input_document, category_id)
    ]
    return list(dict.fromkeys(keyword for keyword in keywords if keyword_in_text(lowered, keyword)))


def buyer_type_value(input_document: dict[str, Any], buyer_type_id: str, key: str) -> list[str]:
    for buyer_type in buyer_type_entries(input_document):
        if buyer_type.get("buyer_type_id") == buyer_type_id:
            return configured_strings(buyer_type.get(key))
    return []


def domain_matches(domain: str | None, domains: set[str]) -> bool:
    return bool(domain) and any(domain == item or domain.endswith(f".{item}") for item in domains)


def hard_filter_rejection(
    candidate: dict[str, Any],
    verified_url: str,
    procurement_hits: list[str],
    input_document: dict[str, Any],
) -> str | None:
    """Apply collection filters that are not score trade-offs."""

    domain = normalized_domain(verified_url)
    source_types = set(candidate.get("source_types", []))
    name = (candidate.get("company_name") or "").casefold()
    path_tokens = {part.casefold() for part in urlparse(verified_url).path.split("/") if part}
    filters = input_document.get("filters")
    filters = filters if isinstance(filters, dict) else {}
    rules = matching_rules(input_document)
    large_chain_domains = set(configured_strings(rules.get("large_chain_domains")))
    aggregator_domains = set(configured_strings(rules.get("aggregator_domains")))
    non_business_paths = set(configured_strings(rules.get("non_business_path_tokens")))
    non_business_titles = configured_strings(
        rules.get("non_business_title_keywords")
    )
    excluded_services = configured_strings(rules.get("excluded_service_keywords"))
    b2b_keywords = configured_strings(rules.get("b2b_procurement_keywords"))
    if filters.get("exclude_large_chains_for_first_round") and domain_matches(domain, large_chain_domains):
        return "large_chain_first_round"
    if domain_matches(domain, aggregator_domains):
        return "no_official_website"
    if source_types == {"web_search"} and path_tokens & non_business_paths:
        return "not_target_buyer_type"
    if source_types == {"web_search"} and any(
        keyword.casefold() in name for keyword in non_business_titles
    ):
        return "not_target_buyer_type"
    if any(term.casefold() in name for term in excluded_services):
        return "not_target_buyer_type"
    has_b2b_signal = any(keyword in b2b_keywords for keyword in procurement_hits)
    if filters.get("exclude_pure_dtc_retailers") and source_types == {"web_search"} and not has_b2b_signal:
        return "pure_dtc_retailer"
    return None


def recommended_offer(
    input_document: dict[str, Any],
    category_id: str,
    buyer_type_id: str,
    market: dict[str, Any] | None = None,
) -> dict[str, str]:
    offer_context = input_document.get("offer_context")
    offer_context = offer_context if isinstance(offer_context, dict) else {}
    bands = offer_context.get("price_bands") or offer_context.get("retail_price_bands_chf")
    for band in bands if isinstance(bands, list) else []:
        if not isinstance(band, dict) or category_id not in configured_strings(band.get("product_category_ids")):
            continue
        price_band = clean_text(band.get("range") or band.get("range_chf"), 80)
        offer: dict[str, str] = {
            "product_category_id": category_id,
            "buyer_type_id": buyer_type_id,
        }
        if price_band:
            offer["price_band"] = price_band
        currency = clean_text(
            band.get("currency") or (market or target_market(input_document)).get("currency"),
            16,
        )
        if currency:
            offer["currency"] = currency
        positioning = clean_text(band.get("positioning"), 300)
        if positioning:
            offer["positioning"] = positioning
        return offer
    return {
        "product_category_id": category_id,
        "buyer_type_id": buyer_type_id,
    }


def make_contact_methods(candidate: dict[str, Any], pages: list[dict[str, Any]], social_links: list[str]) -> list[dict[str, Any]]:
    methods: list[dict[str, Any]] = []
    for page in pages:
        for email in page["emails"]:
            method = {
                "channel": "email",
                "value": email,
                "contact_role": "general",
                "is_public_business_contact": True,
                "source_url": page["final_url"],
            }
            if method not in methods:
                methods.append(method)
        for phone in page["phones"]:
            method = {
                "channel": "phone",
                "value": phone,
                "contact_role": "general",
                "is_public_business_contact": True,
                "source_url": page["final_url"],
            }
            if method not in methods:
                methods.append(method)
        if page.get("contact_page"):
            method = {
                "channel": "contact_form",
                "value": page["final_url"],
                "contact_role": "general",
                "is_public_business_contact": True,
                "source_url": page["final_url"],
            }
            if method not in methods:
                methods.append(method)
    phone = clean_text(candidate.get("public_business_phone"), 100)
    source_url = None
    for trace in candidate.get("source_traces", []):
        if isinstance(trace, dict) and trace.get("source_type") == "google_maps":
            source_url = normalize_url(trace.get("source_url"))
            break
    if phone and source_url:
        methods.append({"channel": "phone", "value": phone, "contact_role": "general", "is_public_business_contact": True, "source_url": source_url})
    for social in social_links:
        domain = normalized_domain(social) or ""
        platform = next((value for host, value in SOCIAL_CONTACT_PREFIXES.items() if domain == host or domain.endswith(f".{host}")), None)
        if not platform:
            continue
        method = {"channel": platform, "value": social, "contact_role": "unknown", "is_public_business_contact": True, "source_url": social}
        if method not in methods:
            methods.append(method)
    return methods


def page_result(page: Any, is_contact_page: bool) -> dict[str, Any]:
    language = language_from_page(page.language, page.visible_text)
    return {
        "requested_url": page.requested_url,
        "final_url": page.final_url,
        "title": clean_text(page.title, 500),
        "language": language,
        "emails": extract_public_business_emails(page.email_candidates),
        "phones": extract_public_business_phones(page.visible_text),
        "social_links": page_social_links(page.links),
        "contact_page": is_contact_page,
        "text": page.visible_text,
    }


def fetch_candidate_pages(
    candidate: dict[str, Any], input_document: dict[str, Any], args: argparse.Namespace
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Fetch only homepage plus a bounded same-domain contact/about link set."""

    candidate_url = candidate.get("website_candidate_url")
    if not candidate_url:
        return [], [{"code": "missing_website_candidate_url", "message": "No candidate website was supplied by a source."}]
    errors: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    allowed, robots_status = robots_allows(candidate_url, args.timeout, args.user_agent) if args.respect_robots else (True, "robots_not_checked")
    if not allowed:
        return [], [{"code": robots_status, "message": "robots.txt disallows the candidate URL."}]
    try:
        home = fetch_page(candidate_url, args.timeout, args.user_agent, locked_email_scraper)
    except FetchError as error:
        return [], [{"code": error.code, "message": str(error)}]
    pages.append(page_result(home, False))
    contact_path_tokens = configured_strings(
        matching_rules(input_document).get("contact_path_tokens")
    )
    for contact_url in contact_like_links(
        home, max(0, args.max_pages_per_candidate - 1), contact_path_tokens
    ):
        allowed, contact_robots_status = robots_allows(contact_url, args.timeout, args.user_agent) if args.respect_robots else (True, "robots_not_checked")
        if not allowed:
            errors.append({"code": contact_robots_status, "message": f"robots.txt disallows {contact_url}"})
            continue
        try:
            contact = fetch_page(contact_url, args.timeout, args.user_agent, locked_email_scraper)
            pages.append(page_result(contact, True))
        except FetchError as error:
            errors.append({"code": error.code, "message": str(error)})
        time.sleep(args.request_delay)
    return pages, errors


def source_counts(candidates: Iterable[dict[str, Any]], qualified_ids: set[str]) -> list[dict[str, Any]]:
    counts: dict[str, dict[str, int]] = {}
    for candidate in candidates:
        for source_type in candidate.get("source_types", []):
            record = counts.setdefault(source_type, {"candidate_count": 0, "qualified_count": 0})
            record["candidate_count"] += 1
            if candidate.get("candidate_id") in qualified_ids:
                record["qualified_count"] += 1
    return [{"source_type": key, **counts[key]} for key in sorted(counts)]


def standard_rejection(
    candidate: dict[str, Any], reasons: list[str], traces: list[dict[str, Any]], rejected_at: str
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "candidate_id": candidate["candidate_id"],
        "company_name": candidate["company_name"],
        "rejection_reasons": list(dict.fromkeys(reasons)) or ["insufficient_public_evidence"],
        "source_trace": traces,
        "rejected_at": rejected_at,
    }
    website = normalize_url(candidate.get("website_candidate_url"))
    if website:
        record["website_url"] = website
    country = normalize_country_code(candidate.get("country"))
    if country:
        record["country"] = country
    return record


def augment_one_candidate(
    candidate: dict[str, Any], input_document: dict[str, Any], task_buyer_types: dict[str, list[str]], args: argparse.Namespace, collected_at: str
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    """Return safe evidence, a qualified record, or a rejected record."""

    traces = source_traces_for_output(candidate, collected_at)
    pages, fetch_errors = fetch_candidate_pages(candidate, input_document, args)
    evidence: dict[str, Any] = {
        "candidate_id": candidate["candidate_id"],
        "company_name": candidate["company_name"],
        "website_candidate_url": candidate.get("website_candidate_url"),
        "fetched_pages": [{key: value for key, value in page.items() if key != "text"} for page in pages],
        "fetch_errors": fetch_errors,
        "official_website_verified": False,
        "country_confirmed": False,
    }
    if not pages:
        reasons = ["no_official_website"]
        if not candidate.get("website_candidate_url"):
            reasons = ["no_official_website", "insufficient_public_evidence"]
        return evidence, None, standard_rejection(candidate, reasons, traces, collected_at)

    all_text = " ".join(page["text"] for page in pages)
    home = pages[0]
    evidence["official_website_verified"] = verified_company_name(candidate, home.get("title") or "", all_text)
    matched_market = matched_target_market(candidate, input_document, all_text)
    evidence["country_confirmed"] = matched_market is not None
    evidence["matched_market"] = (
        market_country_code(matched_market) if matched_market else None
    )
    if not evidence["official_website_verified"]:
        return evidence, None, standard_rejection(candidate, ["no_official_website", "insufficient_public_evidence"], traces, collected_at)
    if not evidence["country_confirmed"]:
        return evidence, None, standard_rejection(candidate, ["outside_target_market"], traces, collected_at)

    hints = candidate_buyer_hints(candidate, task_buyer_types)
    primary_buyer_type, secondary_buyer_types, buyer_hits = classify_buyer_type(
        all_text, hints, input_document
    )
    evidence["buyer_type_hints"] = hints
    evidence["buyer_type_keyword_hits"] = buyer_hits
    if not primary_buyer_type:
        return evidence, None, standard_rejection(candidate, ["not_target_buyer_type", "insufficient_public_evidence"], traces, collected_at)

    social_links = nonempty_list([*candidate.get("social_links", []), *(link for page in pages for link in page["social_links"])])
    contacts = make_contact_methods(candidate, pages, social_links)
    if not contacts:
        return evidence, None, standard_rejection(candidate, ["no_public_business_contact_path"], traces, collected_at)

    product_categories = expected_product_categories(input_document, primary_buyer_type)
    product_hits = product_fit_keyword_hits(all_text, input_document, product_categories)
    evidence["product_fit_keyword_hits"] = product_hits
    if not product_categories or not product_hits:
        return evidence, None, standard_rejection(candidate, ["no_product_category_fit"], traces, collected_at)
    language = next((page["language"] for page in pages if page.get("language")), None)
    if not language:
        return evidence, None, standard_rejection(candidate, ["insufficient_public_evidence"], traces, collected_at)
    procurement_keywords = configured_strings(
        matching_rules(input_document).get("procurement_keywords")
    )
    procurement_hits = [
        keyword for keyword in procurement_keywords if keyword_in_text(all_text, keyword)
    ]
    evidence["procurement_keyword_hits"] = procurement_hits
    hard_rejection = hard_filter_rejection(
        candidate, home["final_url"], procurement_hits, input_document
    )
    if hard_rejection:
        return evidence, None, standard_rejection(candidate, [hard_rejection], traces, collected_at)
    channel_limit = configured_score_limit(input_document, "channel_fit", 35)
    product_limit = configured_score_limit(input_document, "product_fit", 20)
    contact_limit = configured_score_limit(input_document, "contactability", 20)
    localization_limit = configured_score_limit(input_document, "localization_fit", 10)
    procurement_limit = configured_score_limit(
        input_document, "procurement_or_customization_signal", 10
    )
    evidence_limit = configured_score_limit(input_document, "evidence_quality", 5)
    contact_channels = {method["channel"] for method in contacts}
    contact_score = min(
        contact_limit,
        (10 if "contact_form" in contact_channels else 0)
        + (8 if "email" in contact_channels else 0)
        + (5 if "phone" in contact_channels else 0)
        + (4 if contact_channels - {"contact_form", "email", "phone"} else 0),
    )
    breakdown = {
        "channel_fit": min(
            channel_limit,
            len(buyer_hits) * 7 + (5 if primary_buyer_type in hints else 0),
        ),
        "product_fit": min(product_limit, len(product_hits) * 6),
        "contactability": contact_score,
        "localization_fit": localization_limit,
        "procurement_or_customization_signal": min(
            procurement_limit, len(procurement_hits) * 3
        ),
        "evidence_quality": min(evidence_limit, len(traces) * 2),
    }
    score_total = sum(breakdown.values())
    # Keep the calculated score with rejected evidence so threshold decisions
    # remain auditable and callers do not need to reconstruct the breakdown.
    evidence["qualification_score"] = score_total
    if score_total < qualification_threshold(input_document):
        return evidence, None, standard_rejection(candidate, ["qualification_score_below_threshold"], traces, collected_at)

    official_trace = {
        "source_type": "website",
        "task_id": "website-verification",
        "source_url": home["final_url"],
        "evidence_summary": "候选域名已抓取，企业名称、目标市场运营、买家类型和公开企业联系路径已在本轮有限页面集中核验。",
        "collected_at": collected_at,
    }
    if official_trace not in traces:
        traces.append(official_trace)
    city = derive_city(candidate, input_document, all_text)
    if not city:
        return evidence, None, standard_rejection(candidate, ["insufficient_public_evidence"], traces, collected_at)
    output_url = home["final_url"]
    domain = normalized_domain(output_url)
    if not domain:
        return evidence, None, standard_rejection(candidate, ["no_official_website"], traces, collected_at)
    record_id = (
        f"lead_{collection_slug(input_document)}_"
        f"{datetime.now(timezone.utc).strftime('%Y%m%d')}_"
        f"{int(hashlib.sha256(candidate['candidate_id'].encode('utf-8')).hexdigest()[:6], 16) % 1_000_000:06d}"
    )
    evidence["operating_language"] = language
    evidence["procurement_keyword_hits"] = procurement_hits
    business_summary = (
        f"官网显示其为 {primary_buyer_type} 渠道，具备与本轮产品组合相关的公开业务场景。"
    )
    high_threshold = high_priority_threshold(input_document)
    is_high_priority = high_threshold is not None and score_total >= high_threshold
    manual_questions = configured_strings(
        input_document.get("manual_review_questions")
    ) or ["确认首轮产品切入点、沟通语言及是否进入首轮触达名单。"]
    record = {
        "record_id": record_id,
        "company_name": candidate["company_name"],
        "website_url": output_url,
        "domain": domain,
        "country": market_country_code(matched_market) or normalize_country_code(
            candidate.get("country")
        ),
        "location": {key: value for key, value in {"street_address": candidate.get("street_address"), "postal_code": candidate.get("postal_code"), "city": city}.items() if value},
        "classification": {
            "primary_buyer_type_id": primary_buyer_type,
            "secondary_buyer_type_ids": secondary_buyer_types,
            "business_model": buyer_type_value(
                input_document, primary_buyer_type, "business_models"
            ) or ["other"],
            "buyer_type_evidence": f"官网页面命中买家类型证据：{', '.join(buyer_hits[:5])}。",
        },
        "contact_methods": contacts,
        "social_links": social_links,
        "localization": {"operating_languages": [language], "recommended_outreach_language": language, "language_evidence_url": home["final_url"]},
        "profile_summary": business_summary,
        "commercial_fit": {
            "matched_product_category_ids": product_categories,
            "recommended_offer": [
                recommended_offer(
                    input_document, category, primary_buyer_type, matched_market
                )
                for category in product_categories
            ],
            "use_cases": buyer_type_value(
                input_document, primary_buyer_type, "use_cases"
            ) or ["commercial_use"],
            "potential_order_model": ["customized_project" if procurement_hits else "sample_or_test_order"],
            "customization_signals": procurement_hits,
            "fit_evidence": [{"claim": f"官网公开内容命中产品/渠道证据：{', '.join(product_hits[:5])}。", "source_url": home["final_url"]}],
        },
        "qualification": {
            "score_total": score_total,
            "score_breakdown": breakdown,
            "priority": "high" if is_high_priority else "medium",
            "rationale": "官网名称、目标市场运营、目标买家类型、产品渠道匹配和公开企业联系路径均已在受控页面范围内核验。",
            "manual_review_required": is_high_priority,
            "manual_review_questions": manual_questions if is_high_priority else [],
        },
        "source_trace": traces,
        "deduplication": {"normalized_domain": domain, "duplicate_group_id": candidate["candidate_id"], "merged_record_ids": []},
        "record_status": "manual_review" if is_high_priority else "qualified",
        "last_updated_at": collected_at,
    }
    return evidence, record, None


def write_augment_log_header(output: Path, command: str, candidates_path: Path, version: str) -> None:
    lines = [
        "# 客户候选增强：执行日志",
        "",
        "本阶段只访问候选企业已给出的公开 URL，以及同域、有限数量的联系/关于页面。原始 HTML 不落盘；只保留允许的公开企业联系字段和证据 URL。",
        "",
        "## 运行命令",
        "",
        "```sh",
        command,
        "```",
        "",
        "## 输入",
        "",
        f"- 预处理候选：`{candidates_path}`",
        f"- clue-augmentation 版本：`{version}`",
        "",
        "## 结果",
        "",
    ]
    (output / "execution-log.md").write_text("\n".join(lines), encoding="utf-8")


def augment(args: argparse.Namespace, root: Path, version: str) -> int:
    input_path = Path(args.input).expanduser().resolve()
    candidates_path = Path(args.candidates).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not input_path.is_file() or not candidates_path.is_file():
        raise CliError("--input and --candidates must both point to existing JSON files")
    if not args.dry_run and locked_email_scraper is None:
        raise CliError("locked email extractor is unavailable; run clue-data-collection init")
    input_document = read_json(input_path)
    candidates_document = read_json(candidates_path)
    candidates = candidates_document.get("candidates") if isinstance(candidates_document, dict) else None
    if not isinstance(candidates, list):
        raise CliError("candidate input has no candidates array")
    if candidates_document.get("collection_id") != input_document.get("collection_id"):
        raise CliError("candidate collection_id does not match --input")
    if args.max_candidates is not None and args.max_candidates < 1:
        raise CliError("--max-candidates must be positive")
    if args.max_pages_per_candidate < 1:
        raise CliError("--max-pages-per-candidate must be positive")
    selected = candidates[:args.max_candidates] if args.max_candidates else candidates
    command = "clue-augmentation augment --input " + str(input_path) + " --candidates " + str(candidates_path) + " --output " + str(output)
    if args.max_candidates:
        command += f" --max-candidates {args.max_candidates}"
    if args.max_pages_per_candidate != 3:
        command += f" --max-pages-per-candidate {args.max_pages_per_candidate}"
    if args.timeout != 12.0:
        command += f" --timeout {args.timeout:g}"
    if args.request_delay != 0.5:
        command += f" --request-delay {args.request_delay:g}"
    if args.user_agent != "clue-augmentation/0.2 (+public-business-enrichment)":
        command += " --user-agent " + json.dumps(args.user_agent)
    if not args.respect_robots:
        command += " --no-respect-robots"
    if args.publish_dir:
        command += " --publish-dir " + str(Path(args.publish_dir).expanduser().resolve())
    if not args.publish_results:
        command += " --no-publish-results"
    if args.dry_run:
        command += " --dry-run"
    existing_run: dict[str, Any] | None = None
    if output.exists() and not (output / "run.json").is_file():
        raise CliError(f"output already exists and is not an augmentation run: {output}")
    output.mkdir(parents=True, exist_ok=True)
    run_path = output / "run.json"
    if run_path.is_file():
        existing = read_json(run_path)
        if isinstance(existing, dict):
            existing_run = existing
        expected_candidates = (
            existing.get("input", {}).get("candidates_sha256")
            if isinstance(existing, dict)
            else None
        )
        expected_input = (
            existing.get("input", {}).get("input_sha256")
            if isinstance(existing, dict)
            else None
        )
        if expected_candidates and expected_candidates != sha256_file(candidates_path):
            raise CliError("existing augmentation run uses a different candidate artifact")
        if expected_input and expected_input != sha256_file(input_path):
            raise CliError("existing augmentation run uses a different collection input")
        if not expected_input and any((output / "checkpoints").glob("*.json")):
            raise CliError(
                "existing augmentation run has no input hash; use a new run ID"
            )
    else:
        write_augment_log_header(output, command, candidates_path, version)
    checkpoint_dir = output / "checkpoints"
    checkpoint_dir.mkdir(exist_ok=True)
    task_buyer_types = source_task_buyer_types(input_document)
    backend_lock = read_json(root / "backend.lock.json")
    resume_events = (
        list(existing_run.get("resume_events", []))
        if isinstance(existing_run, dict)
        and isinstance(existing_run.get("resume_events"), list)
        else []
    )
    if existing_run:
        resume_events.append(
            {
                "resumed_at": utc_now(),
                "cli": {"name": "clue-augmentation", "version": version},
            }
        )
    initial_run = {
        "schema_version": "clue-augmentation.run.v1",
        "status": "planned" if args.dry_run else "running",
        "stage": "augment",
        "collection_id": input_document.get("collection_id"),
        "generated_at": (
            existing_run.get("generated_at") if existing_run else utc_now()
        ),
        "cli": {"name": "clue-augmentation", "version": version},
        "initial_cli": (
            existing_run.get("initial_cli")
            or existing_run.get("cli")
            if existing_run
            else {"name": "clue-augmentation", "version": version}
        ),
        "resume_events": resume_events,
        "backend": {
            "website_fetcher": {"name": "bounded_native_http", "version": "1", "raw_html_retained": False},
            "email_extractor": backend_lock["email_extractor"],
            "browser_fallback": "Crawl4AI evaluation queue",
        },
        "input": {
            "path": str(input_path),
            "input_sha256": sha256_file(input_path),
            "candidates": str(candidates_path),
            "candidates_sha256": sha256_file(candidates_path),
        },
        "limits": {"max_candidates": args.max_candidates, "max_pages_per_candidate": args.max_pages_per_candidate, "timeout_seconds": args.timeout, "request_delay_seconds": args.request_delay, "respect_robots": args.respect_robots},
        "counts": {"candidate_input": len(candidates), "selected": len(selected)},
        "resume_hint": command,
    }
    write_json(run_path, initial_run)
    if args.dry_run:
        print(json.dumps({"status": "planned", "output": str(output), "selected_candidates": len(selected)}, ensure_ascii=False, indent=2))
        return 0

    evidence_records: list[dict[str, Any]] = []
    qualified: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    processed: list[dict[str, Any]] = []
    for candidate in selected:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("candidate_id"), str):
            continue
        checkpoint_path = checkpoint_dir / f"{candidate['candidate_id']}.json"
        if checkpoint_path.is_file():
            checkpoint = read_json(checkpoint_path)
            if isinstance(checkpoint, dict) and checkpoint.get("status") in {"qualified", "rejected"}:
                processed.append(candidate)
                evidence_records.append(checkpoint["evidence"])
                if checkpoint.get("qualified_record"):
                    qualified.append(checkpoint["qualified_record"])
                if checkpoint.get("rejected_record"):
                    rejected.append(checkpoint["rejected_record"])
                continue
        collected_at = utc_now()
        evidence, record, rejection = augment_one_candidate(candidate, input_document, task_buyer_types, args, collected_at)
        checkpoint = {
            "schema_version": "clue-augmentation.augment-checkpoint.v1",
            "status": "qualified" if record else "rejected",
            "candidate_id": candidate["candidate_id"],
            "completed_at": collected_at,
            "evidence": evidence,
            "qualified_record": record,
            "rejected_record": rejection,
        }
        write_json(checkpoint_path, checkpoint)
        append_jsonl(output / "commands.jsonl", {"executed_at": collected_at, "action": "augment_candidate", "candidate_id": candidate["candidate_id"], "website_candidate_url": candidate.get("website_candidate_url"), "status": checkpoint["status"], "fetch_error_codes": [error["code"] for error in evidence.get("fetch_errors", [])]})
        processed.append(candidate)
        evidence_records.append(evidence)
        if record:
            qualified.append(record)
        if rejection:
            rejected.append(rejection)
        time.sleep(args.request_delay)

    qualified.sort(key=lambda record: (-record["qualification"]["score_total"], record["company_name"]))
    rejected.sort(key=lambda record: (record["company_name"], record["candidate_id"]))
    qualified_ids = {candidate_id for candidate_id in (record["deduplication"]["duplicate_group_id"] for record in qualified)}
    buyer_type_counts: Counter[str] = Counter(record["classification"]["primary_buyer_type_id"] for record in qualified)
    high_priority_counts: Counter[str] = Counter(record["classification"]["primary_buyer_type_id"] for record in qualified if record["qualification"]["priority"] == "high")
    all_buyer_types = [item.get("buyer_type_id") for item in input_document.get("target_buyer_types", []) if isinstance(item, dict)]
    final_output = {
        "schema_version": "clue.data-collection.customer-leads-result.v1",
        "collection_id": input_document.get("collection_id"),
        "run_id": output.name,
        "generated_at": utc_now(),
        "collection_summary": {
            "market": target_country_code(input_document),
            "markets": target_country_codes(input_document),
            "candidate_count": len(processed),
            "qualified_count": len(qualified),
            "high_priority_count": sum(1 for record in qualified if record["qualification"]["priority"] == "high"),
            "manual_review_count": sum(1 for record in qualified if record["qualification"]["manual_review_required"]),
            "rejected_count": len(rejected),
            "coverage_by_buyer_type": [{"buyer_type_id": buyer_type, "qualified_count": buyer_type_counts[buyer_type], "high_priority_count": high_priority_counts[buyer_type]} for buyer_type in all_buyer_types],
            "source_counts": source_counts(processed, qualified_ids),
        },
        "collected_lead_records": qualified,
        "rejected_records": rejected,
    }
    result_payload = {"schema_version": "clue-augmentation.augment.v1", "collection_id": input_document.get("collection_id"), "generated_at": utc_now(), "candidate_evidence": evidence_records, "qualified_count": len(qualified), "rejected_count": len(rejected)}
    write_json(output / "augmentation-results.json", result_payload)
    write_json(output / "output.json", final_output)
    published_results = None
    if args.publish_results and args.max_candidates is None:
        publish_directory = Path(args.publish_dir).expanduser().resolve() if args.publish_dir else input_path.parent
        published_results = publish_result_lists(final_output, output / "output.json", publish_directory)
        append_jsonl(output / "commands.jsonl", {"executed_at": utc_now(), "action": "publish_result_lists", "destination": str(publish_directory), "manual_review_record_count": published_results["manual_review_record_count"], "qualified_without_manual_review_count": published_results["qualified_without_manual_review_count"], "rejected_record_count": published_results["rejected_record_count"]})
    final_run = {**initial_run, "status": "succeeded", "finished_at": utc_now(), "counts": {**initial_run["counts"], "processed": len(processed), "qualified": len(qualified), "rejected": len(rejected)}, "published_results": published_results}
    write_json(run_path, final_run)
    with (output / "execution-log.md").open("a", encoding="utf-8") as handle:
        handle.write(f"- 已处理候选：`{len(processed)}`\n")
        handle.write(f"- 合格线索：`{len(qualified)}`\n")
        handle.write(f"- 拒绝记录：`{len(rejected)}`\n")
        if published_results:
            handle.write(f"- 已发布人工复核和非复核结果：`{published_results['directory']}`\n")
    print(json.dumps({"status": "succeeded", "output": str(output), "processed": len(processed), "qualified": len(qualified), "rejected": len(rejected)}, ensure_ascii=False, indent=2))
    return 0


def review_markdown(records: list[dict[str, Any]], source: Path, generated_at: str) -> str:
    lines = [
        "# 客户信息：人工复核列表",
        "",
        "此列表按最终结果原样筛出 `qualification.manual_review_required: true` 的全部记录，按分数从高到低排列；不设置数量上限，不按城市或买家类型二次挑选。请在人工确认后再决定是否进入首轮触达名单。",
        "",
        f"- 来源：`{source}`",
        f"- 生成时间：`{generated_at}`",
        f"- 待复核记录：`{len(records)}` 条",
        "",
        "| 排名 | 分数 | 企业 | 初步买家类型 | 城市 | 建议语言 | 官网 | 公开联系路径 | 自动证据 |",
        "| ---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for index, record in enumerate(records, start=1):
        qualification = record["qualification"]
        classification = record["classification"]
        location = record.get("location", {})
        localization = record.get("localization", {})
        channels = ", ".join(dict.fromkeys(method.get("channel", "") for method in record.get("contact_methods", []) if method.get("channel")))
        evidence = "；".join(item.get("claim", "") for item in record.get("commercial_fit", {}).get("fit_evidence", [])[:1])
        values = [
            str(index),
            str(qualification["score_total"]),
            record["company_name"],
            classification["primary_buyer_type_id"],
            location.get("city", ""),
            localization.get("recommended_outreach_language", ""),
            record["website_url"],
            channels,
            evidence,
        ]
        escaped = [value.replace("|", "\\|").replace("\n", " ") for value in values]
        lines.append("| " + " | ".join(escaped) + " |")
    lines.extend(
        [
            "",
            "## 每条必答复核问题",
            "",
            "1. 这是否确实是目标买家企业，而不是内容页、品牌直营店、服务商或大型连锁？",
            "2. 官网是否有与本轮产品组合匹配的具体陈列、采购、批发、定制或礼赠场景？",
            "3. 公开联系路径是否应进入首轮触达，以及建议使用哪种渠道和语言？",
            "4. 是否进入首轮触达名单；若否，写明拒绝或后续观察原因。",
            "",
            "完整结构化记录、所有公开联系路径和 source trace 位于同目录的 `manual-review-list.json`。",
        ]
    )
    return "\n".join(lines) + "\n"


def review_list(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.is_file():
        raise CliError(f"review source is missing: {source}")
    if output.exists():
        raise CliError(f"review-list output already exists: {output}")
    document = read_json(source)
    if not isinstance(document, dict) or not isinstance(document.get("collected_lead_records"), list):
        raise CliError("review source has no collected_lead_records array")
    records = [
        record
        for record in document["collected_lead_records"]
        if isinstance(record, dict) and isinstance(record.get("qualification"), dict) and record["qualification"].get("manual_review_required") is True
    ]
    records.sort(key=lambda record: (-record["qualification"]["score_total"], record["company_name"].casefold(), record["record_id"]))
    generated_at = utc_now()
    payload = {
        "schema_version": "clue.data-collection.review-list.v1",
        "collection_id": document.get("collection_id"),
        "source_output": str(source),
        "source_run_id": document.get("run_id"),
        "generated_at": generated_at,
        "selection_policy": {
            "include_when": "qualification.manual_review_required == true",
            "sort": ["qualification.score_total descending", "company_name ascending", "record_id ascending"],
            "manual_selection_applied": False,
            "record_limit": None,
        },
        "review_record_count": len(records),
        "review_records": records,
    }
    write_json(output, payload)
    print(json.dumps({"status": "succeeded", "output": str(output), "review_record_count": len(records)}, ensure_ascii=False, indent=2))
    return 0


def non_review_markdown(
    qualified: list[dict[str, Any]], rejected: list[dict[str, Any]], source: Path, generated_at: str
) -> str:
    lines = [
        "# 客户信息：非人工复核结果",
        "",
        "此文件完整返回最终结果中不需要人工复核的自动合格记录，以及全部被拒绝记录；不做二次选择、数量限制或重新排序评分。",
        "",
        f"- 来源：`{source}`",
        f"- 生成时间：`{generated_at}`",
        f"- 自动合格且无需人工复核：`{len(qualified)}` 条",
        f"- 被拒绝：`{len(rejected)}` 条",
        "",
        "## 自动合格且无需人工复核",
        "",
        "| 排名 | 分数 | 企业 | 初步买家类型 | 城市 | 建议语言 | 官网 | 公开联系路径 |",
        "| ---: | ---: | --- | --- | --- | --- | --- | --- |",
    ]
    for index, record in enumerate(qualified, start=1):
        values = [
            str(index),
            str(record["qualification"]["score_total"]),
            record["company_name"],
            record["classification"]["primary_buyer_type_id"],
            record.get("location", {}).get("city", ""),
            record.get("localization", {}).get("recommended_outreach_language", ""),
            record["website_url"],
            ", ".join(dict.fromkeys(method.get("channel", "") for method in record.get("contact_methods", []) if method.get("channel"))),
        ]
        lines.append("| " + " | ".join(value.replace("|", "\\|").replace("\n", " ") for value in values) + " |")
    lines.extend(
        [
            "",
            "## 被拒绝记录",
            "",
            "| 排名 | 企业 | 官网候选 | 已知国家 | 拒绝原因 |",
            "| ---: | --- | --- | --- | --- |",
        ]
    )
    for index, record in enumerate(rejected, start=1):
        values = [
            str(index),
            record["company_name"],
            record.get("website_url", ""),
            record.get("country", ""),
            ", ".join(record["rejection_reasons"]),
        ]
        lines.append("| " + " | ".join(value.replace("|", "\\|").replace("\n", " ") for value in values) + " |")
    lines.extend(["", "完整结构化记录和所有 source trace 位于同目录的 `non-review-results.json`。"])
    return "\n".join(lines) + "\n"


def non_review_results(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.is_file():
        raise CliError(f"result source is missing: {source}")
    if output.exists():
        raise CliError(f"non-review output already exists: {output}")
    document = read_json(source)
    if not isinstance(document, dict) or not isinstance(document.get("collected_lead_records"), list) or not isinstance(document.get("rejected_records"), list):
        raise CliError("result source must contain collected_lead_records and rejected_records arrays")
    qualified = [
        record
        for record in document["collected_lead_records"]
        if isinstance(record, dict) and isinstance(record.get("qualification"), dict) and record["qualification"].get("manual_review_required") is False
    ]
    rejected = [record for record in document["rejected_records"] if isinstance(record, dict)]
    qualified.sort(key=lambda record: (-record["qualification"]["score_total"], record["company_name"].casefold(), record["record_id"]))
    rejected.sort(key=lambda record: (record["company_name"].casefold(), record["candidate_id"]))
    generated_at = utc_now()
    payload = {
        "schema_version": "clue.data-collection.non-review.v1",
        "collection_id": document.get("collection_id"),
        "source_output": str(source),
        "source_run_id": document.get("run_id"),
        "generated_at": generated_at,
        "selection_policy": {
            "qualified_include_when": "qualification.manual_review_required == false",
            "rejected_include_when": "all rejected_records",
            "manual_selection_applied": False,
            "record_limit": None,
        },
        "qualified_without_manual_review_count": len(qualified),
        "rejected_record_count": len(rejected),
        "qualified_without_manual_review": qualified,
        "rejected_records": rejected,
    }
    write_json(output, payload)
    print(json.dumps({"status": "succeeded", "output": str(output), "qualified_without_manual_review_count": len(qualified), "rejected_record_count": len(rejected)}, ensure_ascii=False, indent=2))
    return 0


def publish_result_lists(document: dict[str, Any], source: Path, directory: Path) -> dict[str, Any]:
    """Publish complete normal results after a full augment run.

    This is intentionally a deterministic projection of the final output: it
    never introduces a shortlist or human selection.  Existing published files
    are atomically replaced so the input-adjacent view always follows the most
    recently completed full run.
    """

    directory.mkdir(parents=True, exist_ok=True)
    manual_records = [
        record
        for record in document["collected_lead_records"]
        if isinstance(record, dict) and isinstance(record.get("qualification"), dict) and record["qualification"].get("manual_review_required") is True
    ]
    qualified_without_review = [
        record
        for record in document["collected_lead_records"]
        if isinstance(record, dict) and isinstance(record.get("qualification"), dict) and record["qualification"].get("manual_review_required") is False
    ]
    rejected = [record for record in document["rejected_records"] if isinstance(record, dict)]
    manual_records.sort(key=lambda record: (-record["qualification"]["score_total"], record["company_name"].casefold(), record["record_id"]))
    qualified_without_review.sort(key=lambda record: (-record["qualification"]["score_total"], record["company_name"].casefold(), record["record_id"]))
    rejected.sort(key=lambda record: (record["company_name"].casefold(), record["candidate_id"]))
    generated_at = utc_now()
    manual_path = directory / "manual-review-list.json"
    non_review_path = directory / "non-review-results.json"
    # Remove only legacy projections owned by this publisher.
    (directory / "manual-review-list.md").unlink(missing_ok=True)
    (directory / "non-review-results.md").unlink(missing_ok=True)
    review_payload = {
        "schema_version": "clue.data-collection.review-list.v1",
        "collection_id": document.get("collection_id"),
        "source_output": str(source),
        "source_run_id": document.get("run_id"),
        "generated_at": generated_at,
        "selection_policy": {
            "include_when": "qualification.manual_review_required == true",
            "sort": ["qualification.score_total descending", "company_name ascending", "record_id ascending"],
            "manual_selection_applied": False,
            "record_limit": None,
        },
        "review_record_count": len(manual_records),
        "review_records": manual_records,
    }
    non_review_payload = {
        "schema_version": "clue.data-collection.non-review.v1",
        "collection_id": document.get("collection_id"),
        "source_output": str(source),
        "source_run_id": document.get("run_id"),
        "generated_at": generated_at,
        "selection_policy": {
            "qualified_include_when": "qualification.manual_review_required == false",
            "rejected_include_when": "all rejected_records",
            "manual_selection_applied": False,
            "record_limit": None,
        },
        "qualified_without_manual_review_count": len(qualified_without_review),
        "rejected_record_count": len(rejected),
        "qualified_without_manual_review": qualified_without_review,
        "rejected_records": rejected,
    }
    write_json(manual_path, review_payload)
    write_json(non_review_path, non_review_payload)
    return {
        "directory": str(directory),
        "manual_review_list": str(manual_path),
        "non_review_results": str(non_review_path),
        "manual_review_record_count": len(manual_records),
        "qualified_without_manual_review_count": len(qualified_without_review),
        "rejected_record_count": len(rejected),
    }


def write_execution_log(output: Path, command: str, sources: list[tuple[str, Path]], version: str) -> None:
    lines = [
        "# 客户候选预处理：执行日志",
        "",
        "此阶段只汇总、标准化、去重和清理候选；官网核验与字段增强属于后续 augmentation 阶段。",
        "",
        "## 运行命令",
        "",
        "```sh",
        command,
        "```",
        "",
        "## 输入源产物",
        "",
    ]
    for source_type, path in sources:
        lines.append(f"- `{source_type}`：`{path}`")
    lines.extend(["", "## 结果", ""])
    (output / "execution-log.md").write_text("\n".join(lines), encoding="utf-8")


def preprocess(args: argparse.Namespace, root: Path, version: str) -> int:
    input_path = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not input_path.is_file():
        raise CliError(f"input file is missing: {input_path}")
    if output.exists():
        raise CliError(f"output directory already exists: {output}")
    source_specs = [source_output_spec(value) for value in args.source_output]
    if not source_specs:
        raise CliError("at least one --source-output is required")
    input_document = read_json(input_path)
    if not isinstance(input_document.get("sources"), list):
        raise CliError("input has no sources array")

    output.mkdir(parents=True)
    command = "clue-augmentation preprocess --input " + str(input_path) + " --output " + str(output)
    command += " " + " ".join(f"--source-output {source_type}={path}" for source_type, path in source_specs)
    write_execution_log(output, command, source_specs, version)

    raw_candidates: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    for source_type, path in source_specs:
        document = read_json(path)
        adapter = ADAPTERS[source_type]
        adapter_count = 0
        for candidate in adapter(document, path):
            adapter_count += 1
            reason = structural_rejection(candidate)
            if reason:
                rejected.append(
                    {
                        "reason": reason,
                        "source_type": candidate["source_type"],
                        "company_name": candidate.get("company_name"),
                        "source_trace": candidate["source_trace"],
                    }
                )
                continue
            raw_candidates.append(candidate)
        source_counts[source_type] += adapter_count
        append_jsonl(
            output / "commands.jsonl",
            {"executed_at": utc_now(), "action": "read_source_output", "source_type": source_type, "path": str(path), "records_read": adapter_count},
        )

    merged = merge_candidates(raw_candidates)
    for candidate in merged:
        candidate["source_trace"] = candidate["source_traces"]
    collection_id = input_document.get("collection_id")
    preprocessed = {
        "schema_version": "clue-augmentation.preprocess.v1",
        "collection_id": collection_id,
        "generated_at": utc_now(),
        "candidate_count": len(merged),
        "candidates": merged,
        "rejected_count": len(rejected),
        "rejected_candidates": rejected,
    }
    write_json(output / "preprocessed-candidates.json", preprocessed)
    run = {
        "schema_version": "clue-augmentation.run.v1",
        "status": "succeeded",
        "stage": "preprocess",
        "collection_id": collection_id,
        "generated_at": utc_now(),
        "cli": {"name": "clue-augmentation", "version": version},
        "input": {"path": str(input_path), "source_outputs": [{"source_type": source_type, "path": str(path)} for source_type, path in source_specs]},
        "counts": {"source_records_read": sum(source_counts.values()), "source_records_by_type": dict(sorted(source_counts.items())), "structurally_rejected": len(rejected), "preprocessed_candidates": len(merged)},
        "next_stage": "augment",
    }
    write_json(output / "run.json", run)
    with (output / "execution-log.md").open("a", encoding="utf-8") as handle:
        handle.write(f"- 原始 source 记录：`{sum(source_counts.values())}`\n")
        handle.write(f"- 结构性拒绝：`{len(rejected)}`\n")
        handle.write(f"- 去重后候选：`{len(merged)}`\n")
    print(json.dumps({"status": "succeeded", "output": str(output), "source_records_read": sum(source_counts.values()), "preprocessed_candidates": len(merged), "structurally_rejected": len(rejected)}, ensure_ascii=False, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    root_parser = argparse.ArgumentParser(
        prog="clue-data-collection",
        description="Customer-leads phase 2 (augmentation) commands (preprocess/augment).",
    )
    commands = root_parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="Print the CLI version.")
    preprocess_parser = commands.add_parser("preprocess", help="Aggregate, normalize, clean and deduplicate source outputs.")
    preprocess_parser.add_argument("--workspace", help="Customer workspace ID. Uses acquisition/customer-data-collection under --workspaces-root.")
    preprocess_parser.add_argument("--workspaces-root", help="Required with --workspace.")
    preprocess_parser.add_argument("--run-id", help="When used with --workspace and no --output, create this run directory under runs/.")
    preprocess_parser.add_argument("--input")
    preprocess_parser.add_argument("--output")
    preprocess_parser.add_argument("--source-output", action="append", default=[], help="Repeat source_type=path for each source artifact.")
    augment_parser = commands.add_parser("augment", help="Verify bounded public websites and build qualified lead output.")
    augment_parser.add_argument("--workspace", help="Customer workspace ID. Uses acquisition/customer-data-collection under --workspaces-root.")
    augment_parser.add_argument("--workspaces-root", help="Required with --workspace.")
    augment_parser.add_argument("--run-id", help="When used with --workspace and no --output, create this run directory under runs/.")
    augment_parser.add_argument("--input", help="Collection input JSON.")
    augment_parser.add_argument("--candidates", required=True, help="preprocessed-candidates.json from preprocess.")
    augment_parser.add_argument("--output", help="New run folder; rerun the same command to resume it.")
    augment_parser.add_argument("--max-candidates", type=int, help="Bound a test run to the first N candidates.")
    augment_parser.add_argument("--max-pages-per-candidate", type=int, default=3, help="Homepage plus this many same-domain pages at most.")
    augment_parser.add_argument("--timeout", type=float, default=12.0, help="Per-request timeout in seconds.")
    augment_parser.add_argument("--request-delay", type=float, default=0.5, help="Delay between public requests in seconds.")
    augment_parser.add_argument("--user-agent", default="clue-augmentation/0.2 (+public-business-enrichment)")
    augment_parser.add_argument("--respect-robots", action=argparse.BooleanOptionalAction, default=True)
    augment_parser.add_argument("--publish-results", action=argparse.BooleanOptionalAction, default=True, help="After a complete run, publish normal result lists beside input.json.")
    augment_parser.add_argument("--publish-dir", help="Override the default result-list directory (the directory containing --input).")
    augment_parser.add_argument("--dry-run", action="store_true", help="Write an auditable plan without visiting websites.")
    review_parser = commands.add_parser("review-list", help="Create an unselected, score-sorted human-review list from a final output JSON.")
    review_parser.add_argument("--workspace", help="Customer workspace ID. Defaults output to outputs/manual-review-list.json.")
    review_parser.add_argument("--workspaces-root", help="Required with --workspace.")
    review_parser.add_argument("--source", required=True, help="Final customer-data-collection output.json.")
    review_parser.add_argument("--output", help="New JSON review list path.")
    non_review_parser = commands.add_parser("non-review-results", help="Create all non-manual-review and rejected results from a final output JSON.")
    non_review_parser.add_argument("--workspace", help="Customer workspace ID. Defaults output to outputs/non-review-results.json.")
    non_review_parser.add_argument("--workspaces-root", help="Required with --workspace.")
    non_review_parser.add_argument("--source", required=True, help="Final customer-data-collection output.json.")
    non_review_parser.add_argument("--output", help="New JSON non-review result path.")
    return root_parser


def apply_workspace_defaults(args: argparse.Namespace) -> None:
    """Map the standard customer-data-collection scope onto legacy CLI flags."""

    workspace = getattr(args, "workspace", None)
    workspaces_root = getattr(args, "workspaces_root", None)
    run_id = getattr(args, "run_id", None)
    if workspaces_root and not workspace:
        raise CliError("--workspaces-root requires --workspace")
    if run_id and not workspace:
        raise CliError("--run-id requires --workspace")
    if run_id and getattr(args, "output", None):
        raise CliError("--output and --run-id cannot be used together")
    if workspace:
        if collection_paths is None:
            raise CliError("workspace path helper is unavailable")
        try:
            scope = collection_paths(workspace, getattr(args, "workspaces_root", None))
        except WorkspacePathError as error:
            raise CliError(str(error)) from error
        if hasattr(args, "input") and not args.input:
            args.input = str(scope.input_json)
        if args.command in {"preprocess", "augment"} and not args.output:
            if not args.run_id:
                raise CliError("--run-id is required with --workspace when --output is omitted")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.run_id):
                raise CliError("--run-id may contain only letters, numbers, dot, underscore and hyphen")
            args.output = str(scope.runs / args.run_id)
        if args.command == "augment" and not args.publish_dir:
            args.publish_dir = str(scope.outputs)
        if args.command == "review-list" and not args.output:
            args.output = str(scope.outputs / "manual-review-list.json")
        if args.command == "non-review-results" and not args.output:
            args.output = str(scope.outputs / "non-review-results.json")
    if args.command in {"preprocess", "augment"} and not args.input:
        raise CliError("--input is required unless --workspace is set")
    if args.command in {"preprocess", "augment"} and not args.output:
        raise CliError("--output is required unless --workspace is used with --run-id")
    if args.command in {"review-list", "non-review-results"} and not args.output:
        raise CliError("--output is required unless --workspace is set")


def main(argv: list[str]) -> int:
    args = parser().parse_args(argv)
    root = Path(__file__).resolve().parent
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    if args.command == "version":
        print(json.dumps({
            "cli": {"name": "clue-data-collection", "module": "customer_leads", "version": version},
            "pipeline_phase": {"phase_id": 2, "phase": "augmentation"},
            "stages": [
                "preprocess",
                "augment",
                "review-list",
                "non-review-results",
            ],
            "note": (
                "Customer-leads phase 2 lives in tools/data-collection/customer_leads.py. "
                "Literature PDF capture is tools/data-collection/pdf_capture.py + tools/browser."
            ),
        }, ensure_ascii=False, indent=2))
        return 0
    apply_workspace_defaults(args)
    if args.command == "preprocess":
        return preprocess(args, root, version)
    if args.command == "augment":
        return augment(args, root, version)
    if args.command == "review-list":
        return review_list(args)
    return non_review_results(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
