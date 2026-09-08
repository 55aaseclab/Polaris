"""Bounded, public-website fetching for customer-leads phase 2 (customer_leads.augment).

The module deliberately stores no raw HTML.  It fetches a small public page
set, rejects local/private network destinations, performs a narrow robots.txt
check, and returns only the parsed page facts needed for business enrichment.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 1_500_000
EMAIL_MARKER_PATTERN = re.compile(
    r"mailto:|[a-z0-9._%+-]{1,64}@|\(at\)|\[at\]|atob\(|&#64;|&commat;", re.IGNORECASE
)


class FetchError(RuntimeError):
    """A safe, classified public-web fetch failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def host_from_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise FetchError("invalid_url", "URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise FetchError("unsafe_url", "URL credentials are not allowed")
    return parsed.hostname.lower().rstrip(".")


def assert_public_host(url: str) -> None:
    """Reject loopback and non-public address targets before every request."""

    host = host_from_url(url)
    try:
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise FetchError("dns_failure", f"Could not resolve host: {host}") from error
    if not addresses:
        raise FetchError("dns_failure", f"Could not resolve host: {host}")
    for address in addresses:
        raw_ip = address[4][0]
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError as error:
            raise FetchError("dns_failure", f"Host resolved to an invalid address: {host}") from error
        if not ip.is_global:
            raise FetchError("unsafe_url", f"Host resolves to a non-public address: {host}")


class SafeRedirectHandler(HTTPRedirectHandler):
    """Validate every redirect target to avoid redirect-based SSRF."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        assert_public_host(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class PageFactsParser(HTMLParser):
    """Extract visible text and links while excluding scripts and markup noise."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.language: str | None = None
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.text_length = 0
        self.links: list[tuple[str, str]] = []
        self._in_title = False
        self._suppressed_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): value or "" for name, value in attrs}
        if tag.lower() == "html" and attributes.get("lang"):
            self.language = attributes["lang"].strip().lower()
        if tag.lower() == "title":
            self._in_title = True
        if tag.lower() in {"script", "style", "noscript", "template", "svg"}:
            self._suppressed_depth += 1
        href = attributes.get("href")
        if href and len(self.links) < 250:
            self.links.append((href.strip(), ""))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False
        if tag.lower() in {"script", "style", "noscript", "template", "svg"} and self._suppressed_depth:
            self._suppressed_depth -= 1

    def handle_data(self, data: str) -> None:
        text = " ".join(unescape(data).split())
        if not text:
            return
        if self._in_title:
            self.title_parts.append(text)
        if not self._suppressed_depth and self.text_length < 40_000:
            remaining = 40_000 - self.text_length
            retained = text[:remaining]
            self.text_parts.append(retained)
            self.text_length += len(retained) + 1

    def text(self) -> str:
        return " ".join(self.text_parts)

    def title(self) -> str:
        return " ".join(self.title_parts)


@dataclass(frozen=True)
class FetchedPage:
    requested_url: str
    final_url: str
    status_code: int
    content_type: str
    title: str
    language: str | None
    visible_text: str
    links: tuple[str, ...]
    email_candidates: tuple[str, ...]


def email_extractor_input(html: str, max_markers: int = 120, context: int = 512) -> str:
    """Bound third-party email parsing to HTML regions that can contain email.

    ``kichik/email-scraper`` remains the sole email recognizer.  This narrow
    preselection simply prevents a large product page's unrelated script and
    style content from producing a pathological full-document regex workload.
    """

    spans: list[tuple[int, int]] = []
    for marker_index, marker in enumerate(EMAIL_MARKER_PATTERN.finditer(html)):
        if marker_index >= max_markers:
            break
        start = max(0, marker.start() - context)
        end = min(len(html), marker.end() + context)
        if spans and start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return "\n".join(html[start:end] for start, end in spans)


def fetch_page(
    url: str, timeout_seconds: float, user_agent: str, email_extractor: Callable[[str], Iterable[str]] | None = None
) -> FetchedPage:
    """Fetch a bounded public HTML document and discard its raw bytes."""

    assert_public_host(url)
    request = Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Language": "en;q=0.9,*;q=0.5",
        },
    )
    opener = build_opener(SafeRedirectHandler())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            final_url = response.geturl()
            assert_public_host(final_url)
            content_type = response.headers.get_content_type().lower()
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise FetchError("unsupported_content_type", f"Expected HTML, got {content_type}")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise FetchError("response_too_large", f"Response exceeds {MAX_RESPONSE_BYTES} bytes")
            charset = response.headers.get_content_charset() or "utf-8"
            html = raw.decode(charset, errors="replace")
            try:
                email_input = email_extractor_input(html)
                email_candidates = tuple(sorted(set(email_extractor(email_input)))) if email_extractor and email_input else ()
            except Exception as error:
                raise FetchError("email_extractor_failure", "Locked email extractor failed for an approved HTML page") from error
            parser = PageFactsParser()
            parser.feed(html)
            parser.close()
            links = tuple(urljoin(final_url, href) for href, _ in parser.links)
            return FetchedPage(
                requested_url=url,
                final_url=final_url,
                status_code=getattr(response, "status", 200),
                content_type=content_type,
                title=parser.title(),
                language=parser.language,
                visible_text=parser.text(),
                links=links,
                email_candidates=email_candidates,
            )
    except FetchError:
        raise
    except HTTPError as error:
        raise FetchError(f"http_{error.code}", f"HTTP {error.code} for {url}") from error
    except URLError as error:
        raise FetchError("network_error", f"Network failure for {url}: {error.reason}") from error
    except TimeoutError as error:
        raise FetchError("timeout", f"Timed out fetching {url}") from error


def robots_allows(url: str, timeout_seconds: float, user_agent: str) -> tuple[bool, str]:
    """Return a conservative robots decision without persisting robots content.

    A missing or unreadable robots file does not block a request.  An explicit
    ``User-agent: *`` + matching ``Disallow`` rule does.  This is intentionally
    narrow; the augmentation crawler never discovers arbitrary site paths.
    """

    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        assert_public_host(robots_url)
        request = Request(robots_url, headers={"User-Agent": user_agent, "Accept": "text/plain,*/*;q=0.1"})
        opener = build_opener(SafeRedirectHandler())
        with opener.open(request, timeout=timeout_seconds) as response:
            if getattr(response, "status", 200) >= 400:
                return True, "robots_unavailable"
            raw = response.read(200_000)
            content = raw.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    except (FetchError, HTTPError, URLError, TimeoutError):
        return True, "robots_unavailable"

    path = parsed.path or "/"
    applies = False
    for raw_line in content.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        name, value = (item.strip() for item in line.split(":", 1))
        lower_name = name.lower()
        if lower_name == "user-agent":
            applies = value == "*"
        elif applies and lower_name == "disallow" and value and path.startswith(value):
            return False, "robots_disallow"
    return True, "robots_allowed"


DEFAULT_CONTACT_PATH_TOKENS = (
    "about",
    "about-us",
    "booking",
    "contact",
    "contacto",
    "contat",
    "contato",
    "contatti",
    "contatto",
    "impressum",
    "kontakt",
    "o-nas",
    "om-oss",
    "over-ons",
    "qui-sommes-nous",
    "rendez-vous",
    "service",
    "sobre",
    "support",
    "team",
    "termin",
    "ueber-uns",
)


def contact_path_pattern(extra_tokens: Iterable[str] = ()) -> re.Pattern[str]:
    """Build a bounded path matcher with optional customer-configured terms."""

    terms = list(DEFAULT_CONTACT_PATH_TOKENS)
    terms.extend(
        token.strip().casefold()
        for token in extra_tokens
        if isinstance(token, str) and token.strip()
    )
    return re.compile(
        r"(?:" + "|".join(re.escape(token) for token in dict.fromkeys(terms)) + r")",
        re.IGNORECASE,
    )


def contact_like_links(
    page: FetchedPage, limit: int, extra_path_tokens: Iterable[str] = ()
) -> Iterable[str]:
    """Yield a small same-host contact/about link set in discovery order."""

    page_host = host_from_url(page.final_url).removeprefix("www.")
    path_pattern = contact_path_pattern(extra_path_tokens)
    seen: set[str] = set()
    for link in page.links:
        parsed = urlparse(link)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        host = parsed.hostname.lower().removeprefix("www.")
        if host != page_host or not path_pattern.search(parsed.path):
            continue
        canonical = parsed._replace(fragment="").geturl()
        if canonical not in seen:
            seen.add(canonical)
            yield canonical
            if len(seen) >= limit:
                return
