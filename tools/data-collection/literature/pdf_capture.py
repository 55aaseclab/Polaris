"""Capture literature PDFs via tools/browser (Camofox).

Phase 2 (augmentation) of clue-data-collection when payload.pdf_links is enabled.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen


class PdfCaptureError(Exception):
    pass


# Record-level pool size (candidate URLs within a record stay serial).
DEFAULT_MAX_WORKERS = 8


def tools_root() -> Path:
    # literature/ → data-collection/ → tools/
    return Path(__file__).resolve().parents[2]


def browser_cli() -> Path:
    path = tools_root() / "browser" / "clue-browser"
    if not path.is_file():
        raise PdfCaptureError(f"clue-browser not found: {path}")
    return path


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": utc_now(),
        "level": "info",
        "msg": message,
        "component": "pdf_capture",
    }
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def resolve_max_workers(max_workers: int | None) -> int:
    """CLI/arg wins; else PDF_CAPTURE_WORKERS env; else DEFAULT_MAX_WORKERS."""
    if max_workers is not None:
        return max(1, int(max_workers))
    env = os.environ.get("PDF_CAPTURE_WORKERS", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError as error:
            raise PdfCaptureError(
                f"PDF_CAPTURE_WORKERS must be a positive integer, got {env!r}"
            ) from error
    return DEFAULT_MAX_WORKERS


def camofox_base_url() -> str:
    port = os.environ.get("CAMOFOX_PORT") or os.environ.get("BROWSER_CAMOFOX_PORT") or "9377"
    host = os.environ.get("BROWSER_CAMOFOX_HOST") or "127.0.0.1"
    return (os.environ.get("BROWSER_CAMOFOX_URL") or f"http://{host}:{port}").rstrip("/")


def camofox_health_ok(base_url: str, timeout_s: float = 2.0) -> bool:
    try:
        with urlopen(f"{base_url.rstrip('/')}/health", timeout=timeout_s) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
        return bool(data.get("ok") is True)
    except (URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return False


def _proxy_env_for_camofox() -> dict[str, str]:
    """Map BROWSER_PROXY_* into Camofox PROXY_* when starting a shared server."""
    out: dict[str, str] = {}
    server = (os.environ.get("BROWSER_PROXY_SERVER") or "").strip()
    if not server:
        return out
    try:
        url = urlparse(server if "://" in server else f"http://{server}")
    except ValueError:
        return out
    if url.hostname:
        out["PROXY_HOST"] = url.hostname
    if url.port:
        out["PROXY_PORT"] = str(url.port)
    elif url.scheme == "https":
        out["PROXY_PORT"] = "443"
    else:
        out["PROXY_PORT"] = "80"
    user = (os.environ.get("BROWSER_PROXY_USERNAME") or "").strip()
    password = (os.environ.get("BROWSER_PROXY_PASSWORD") or "").strip()
    if user:
        out["PROXY_USERNAME"] = user
    if password:
        out["PROXY_PASSWORD"] = password
    return out


def ensure_shared_camofox_server(
    *,
    startup_timeout_s: float = 90.0,
) -> tuple[str, Callable[[], None]]:
    """Ensure one long-lived Camofox for the batch.

    Parallel clue-browser workers must not own the server process: each
    camofox-backend run that *starts* the server will kill it in finally.
    Pre-starting (or reusing a healthy server) makes every worker's stop() a
    no-op.
    """
    base = camofox_base_url()
    if camofox_health_ok(base):
        os.environ["BROWSER_CAMOFOX_URL"] = base
        log("camofox_shared", action="reuse", url=base)
        return base, lambda: None

    server_js = (
        tools_root()
        / "browser"
        / "node_modules"
        / "@askjo"
        / "camofox-browser"
        / "server.js"
    )
    if not server_js.is_file():
        log(
            "camofox_shared",
            action="skip_start",
            reason="server.js missing; workers may auto-start",
            path=str(server_js),
        )
        return base, lambda: None

    node = shutil.which("node") or "node"
    parsed = urlparse(base)
    port = str(parsed.port or os.environ.get("CAMOFOX_PORT") or "9377")
    env = os.environ.copy()
    env.update(_proxy_env_for_camofox())
    env["CAMOFOX_PORT"] = port
    env["CAMOFOX_CRASH_REPORT_ENABLED"] = env.get("CAMOFOX_CRASH_REPORT_ENABLED") or "false"
    if not env.get("DISPLAY"):
        # Camoufox may still launch; clue-browser runs usually set DISPLAY.
        pass

    log("camofox_shared", action="starting", url=base, port=port)
    proc = subprocess.Popen(
        [node, str(server_js)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.time() + startup_timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            err = ""
            if proc.stderr:
                err = proc.stderr.read()[-800:]
            raise PdfCaptureError(
                f"shared Camofox exited during startup (code {proc.returncode}): {err}"
            )
        if camofox_health_ok(base):
            os.environ["BROWSER_CAMOFOX_URL"] = base
            log("camofox_shared", action="started", url=base, pid=proc.pid)

            def stop() -> None:
                if proc.poll() is not None:
                    return
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
                log("camofox_shared", action="stopped", pid=proc.pid)

            return base, stop
        time.sleep(0.4)

    proc.kill()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    raise PdfCaptureError(
        f"shared Camofox did not become healthy within {startup_timeout_s:.0f}s at {base}"
    )


def is_pdf_bytes(data: bytes) -> bool:
    return len(data) >= 5 and data[:5] == b"%PDF-"


def _normalize_doi(value: str) -> str:
    doi = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.lower().startswith(prefix):
            doi = doi[len(prefix) :]
            break
    return doi.strip().strip("/")


def record_dois(record: dict[str, Any]) -> list[str]:
    """Distinct DOIs from payload + record_id."""
    dois: list[str] = []
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    for key in ("DOI", "doi"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            dois.append(_normalize_doi(value))
    record_id = record.get("record_id")
    if isinstance(record_id, str) and record_id.lower().startswith("doi:"):
        dois.append(_normalize_doi(record_id))
    return list(dict.fromkeys(d for d in dois if d))


def doi_is_acm(doi: str) -> bool:
    """ACM DL PDF endpoints are only valid for ACM-registered DOIs (mostly 10.1145)."""
    d = _normalize_doi(doi).lower()
    return d.startswith("10.1145/") or d.startswith("10.5455/")


def reject_candidate_url(url: str, record: dict[str, Any] | None = None) -> str | None:
    """Return a short reject reason, or None if the URL is worth trying.

    Highest-ROI filters from the parallel8 failure analysis: ACM PDF links on
    non-ACM DOIs, crossmark/policy/ORCID noise, and non-PDF OpenAlex content.
    """
    raw = (url or "").strip()
    if not raw:
        return "empty"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return "unparseable"
    lower = raw.lower()
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "").lower()

    # Author/identity / org metadata — never a paper PDF.
    if host in {"orcid.org", "ror.org"} or host.endswith(".orcid.org"):
        return "junk_identity_host"
    # License pages.
    if "creativecommons.org" in host:
        return "junk_license_host"
    # Publisher "crossmark" / policy landing pages from OpenAlex noise.
    if "crossmark" in lower:
        return "junk_crossmark"
    if re.search(r"policy-0\d+", lower) or lower.rstrip("/").endswith("/policy"):
        return "junk_publisher_policy"
    if any(
        needle in lower
        for needle in (
            "springer_crossmark_policy",
            "mdpi_crossmark_policy",
            "crossmark_policy",
        )
    ):
        return "junk_crossmark"

    # ACM synthetic / metadata PDF URLs only for real ACM DOIs.
    if "dl.acm.org" in host and "/doi/pdf/" in path:
        path_doi = ""
        marker = "/doi/pdf/"
        idx = path.find(marker)
        if idx >= 0:
            path_doi = path[idx + len(marker) :].strip("/")
        dois = record_dois(record) if record else []
        check_dois = [path_doi] if path_doi else []
        check_dois.extend(dois)
        if check_dois and not any(doi_is_acm(d) for d in check_dois if d):
            return "acm_pdf_non_acm_doi"

    # OpenAlex content CDN: only keep explicit PDFs.
    if "openalex.org" in host and not path.endswith(".pdf"):
        return "openalex_non_pdf"

    return None


def _arxiv_id_from_record(record: dict[str, Any]) -> str | None:
    """Best-effort arXiv id from S2 externalIds, DOI, or source_url."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    ext = payload.get("externalIds") if isinstance(payload.get("externalIds"), dict) else {}
    for key in ("ArXiv", "arXiv", "ARXIV"):
        value = ext.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().removeprefix("arXiv:").removeprefix("arxiv:")
    for doi in record_dois(record):
        match = re.search(r"10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})(v\d+)?", doi, re.I)
        if match:
            return match.group(1)
    source_url = str(record.get("source_url") or "")
    match = re.search(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})", source_url, re.I)
    if match:
        return match.group(1)
    return None


def provider_pdf_candidates(record: dict[str, Any]) -> list[dict[str, str]]:
    """PDF URLs already present in Semantic Scholar / Crossref payloads.

    Phase-1 listing and phase-2 capture both use this so API open-access links
    short-circuit browser work when possible.
    """
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(url: str, link_kind: str) -> None:
        url = (url or "").strip()
        if not url or url in seen:
            return
        if not url.lower().startswith(("http://", "https://")):
            return
        seen.add(url)
        out.append(
            {
                "url": url,
                "link_kind": link_kind,
                "validation": "not_downloaded",
            }
        )

    # Semantic Scholar open-access PDF (direct when present).
    oa = payload.get("openAccessPdf")
    if isinstance(oa, dict) and isinstance(oa.get("url"), str):
        add(oa["url"], "s2-open-access-pdf")
    elif isinstance(oa, str):
        add(oa, "s2-open-access-pdf")

    # Crossref work.link[] — prefer /pdf/ or application/pdf.
    links = payload.get("link")
    if isinstance(links, list):
        for item in links:
            if not isinstance(item, dict):
                continue
            url = item.get("URL") or item.get("url")
            if not isinstance(url, str):
                continue
            ctype = str(item.get("content-type") or "").lower()
            lower = url.lower()
            if (
                "pdf" in ctype
                or lower.endswith(".pdf")
                or "/doi/pdf/" in lower
                or "/content/pdf/" in lower
                or "/pdf/" in lower
            ):
                add(url, "crossref-pdf")
            else:
                # Still useful landing; lower priority kind.
                add(url, "crossref-link")

    # arXiv absolute PDF from provider ids.
    arxiv_id = _arxiv_id_from_record(record)
    if arxiv_id:
        add(f"https://arxiv.org/pdf/{arxiv_id}", "arxiv-pdf")
        add(f"https://arxiv.org/pdf/{arxiv_id}.pdf", "arxiv-pdf")

    return out


def _synthetic_pdf_urls(record: dict[str, Any]) -> list[dict[str, str]]:
    """Extra likely-PDF URLs derived from DOI / known landing patterns."""
    extras: list[dict[str, str]] = []
    for doi in record_dois(record):
        if not doi:
            continue
        extras.append(
            {
                "url": f"https://doi.org/{doi}",
                "link_kind": "doi-landing",
                "validation": "not_downloaded",
            }
        )
        # Only invent ACM PDF links for ACM-registered DOIs (else → 404).
        if doi_is_acm(doi):
            extras.append(
                {
                    "url": f"https://dl.acm.org/doi/pdf/{doi}",
                    "link_kind": "acm-pdf",
                    "validation": "not_downloaded",
                }
            )
    source_url = record.get("source_url")
    if isinstance(source_url, str) and "arxiv.org/abs/" in source_url:
        extras.append(
            {
                "url": source_url.replace("/abs/", "/pdf/"),
                "link_kind": "arxiv-pdf",
                "validation": "not_downloaded",
            }
        )
    # Provider URLs first so they are present even when pdf_links not yet listed.
    return provider_pdf_candidates(record) + extras


def candidate_urls_from_record(record: dict[str, Any]) -> list[dict[str, str]]:
    """Prefer provider PDF URLs, then pdf_links.candidates, then DOI/arxiv guesses.

    Drops high-noise URLs (ACM-for-non-ACM, crossmark, ORCID, …) before scoring.
    """
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    pdf_links = payload.get("pdf_links") if isinstance(payload.get("pdf_links"), dict) else None
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    rejected: list[dict[str, str]] = []

    def add(item: dict[str, str]) -> None:
        url = item.get("url", "").strip()
        if not url or url in seen:
            return
        reason = reject_candidate_url(url, record)
        if reason:
            seen.add(url)
            rejected.append({"url": url[:200], "reason": reason})
            return
        seen.add(url)
        candidates.append(
            {
                "url": url,
                "link_kind": str(item.get("link_kind") or "source-metadata"),
                "validation": str(item.get("validation") or "not_downloaded"),
            }
        )

    # 1) Semantic Scholar / Crossref explicit PDF URLs (highest value).
    for item in provider_pdf_candidates(record):
        add(item)
    # 2) Already listed phase-1 candidates.
    if pdf_links and isinstance(pdf_links.get("candidates"), list):
        for item in pdf_links["candidates"]:
            if isinstance(item, dict):
                add(item)  # type: ignore[arg-type]
    # 3) DOI / ACM / abs→pdf heuristics.
    for item in _synthetic_pdf_urls(record):
        add(item)
    if not candidates:
        source_url = record.get("source_url")
        if isinstance(source_url, str) and source_url.strip():
            add(
                {
                    "url": source_url.strip(),
                    "link_kind": "record-source",
                    "validation": "not_downloaded",
                }
            )

    def score(item: dict[str, str]) -> tuple[int, int, int]:
        url = item["url"].lower()
        path = urlparse(url).path.lower()
        kind = str(item.get("link_kind") or "").lower()
        # Prefer provider open-access / direct PDF endpoints before browser landings.
        if kind in {"s2-open-access-pdf", "arxiv-pdf"} or "arxiv.org/pdf/" in url:
            tier = 0
        elif kind == "crossref-pdf" or (
            path.endswith(".pdf") or "/doi/pdf/" in path or "/content/pdf/" in path
        ):
            tier = 1
        elif "delivery.cfm" in url and "type=2" in url:
            tier = 2
        elif "delivery.cfm" in url:
            tier = 3
        elif path.endswith(".pdf") or "/pdf/" in path or "pdf" in path.split("/")[-1]:
            tier = 4
        elif "papers.ssrn.com" in url or "ssrn.com" in url:
            tier = 5
        elif "dl.acm.org/doi/pdf/" in url:
            tier = 5  # only kept for real ACM DOIs after filter
        elif "doi.org/" in url:
            tier = 6
        elif item.get("validation") == "failed":
            tier = 8
        else:
            tier = 7
        return (tier, 0 if item.get("validation") != "failed" else 1, len(url))

    ordered = sorted(candidates, key=score)
    # Attach reject audit for optional logging by caller (not part of URL list).
    if rejected:
        # Stash on function attribute for batch stats (thread-local would be heavier).
        candidate_urls_from_record.last_rejected = rejected  # type: ignore[attr-defined]
    else:
        candidate_urls_from_record.last_rejected = []  # type: ignore[attr-defined]
    return ordered


def _browser_actions_for_landing(url: str, timeout_ms: int) -> list[dict[str, Any]]:
    """After Cloudflare, probe for publisher PDF download links (e.g. SSRN Delivery.cfm)."""
    challenge_ms = min(timeout_ms, 90_000)
    actions: list[dict[str, Any]] = [
        {"type": "solve-challenge", "timeout_ms": challenge_ms},
    ]
    # SSRN and similar: abstract page → click real PDF delivery link after CF.
    lower = url.lower()
    if "ssrn.com" in lower or "papers.ssrn.com" in lower or "doi.org/10.2139" in lower:
        actions.extend(
            [
                {
                    "type": "extract-attribute",
                    "selector": "a[href*='Delivery.cfm'][href*='type=2']",
                    "attribute": "href",
                    "name": "ssrn_open_pdf",
                    "timeout_ms": 10_000,
                },
                {
                    "type": "extract-attribute",
                    "selector": "a[href*='Delivery.cfm']",
                    "attribute": "href",
                    "name": "ssrn_delivery",
                    "timeout_ms": 5_000,
                },
                # Prefer "Open PDF in Browser" (type=2) → PDF.js exportable.
                {
                    "type": "click",
                    "selector": "a[href*='Delivery.cfm']",
                    "timeout_ms": 10_000,
                },
            ]
        )
    else:
        actions.extend(
            [
                {
                    "type": "extract-attribute",
                    "selector": "a[href*='Delivery.cfm']",
                    "attribute": "href",
                    "name": "ssrn_delivery",
                    "timeout_ms": 3_000,
                },
                {
                    "type": "extract-attribute",
                    "selector": "a[href*='.pdf']",
                    "attribute": "href",
                    "name": "pdf_href",
                    "timeout_ms": 3_000,
                },
                {
                    "type": "extract-attribute",
                    "selector": "a[href*='download']",
                    "attribute": "href",
                    "name": "download_href",
                    "timeout_ms": 3_000,
                },
            ]
        )
    actions.append({"type": "screenshot", "name": "page", "full_page": False})
    return actions


def _pdfs_from_browser_output(document: dict[str, Any]) -> list[dict[str, Any]]:
    artifacts = document.get("artifacts") if isinstance(document.get("artifacts"), list) else []
    pdfs: list[dict[str, Any]] = []
    for item in artifacts:
        if not isinstance(item, dict) or item.get("kind") != "download":
            continue
        path = Path(str(item.get("path") or ""))
        name = str(item.get("filename") or path.name).lower()
        if name.endswith(".pdf") or (path.is_file() and is_pdf_bytes(path.read_bytes()[:8])):
            pdfs.append(item)
    return pdfs


def _absolute_url(base: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href:
        return None
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if href.startswith("//"):
        return "https:" + href
    try:
        from urllib.parse import urljoin

        return urljoin(base, href)
    except Exception:
        return None


def _download_urls_from_document(document: dict[str, Any], page_url: str) -> list[str]:
    """Collect Delivery.cfm / .pdf hrefs from extractions after challenge."""
    found: list[str] = []
    seen: set[str] = set()
    for item in document.get("extractions") or []:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if not isinstance(value, str) or not value.strip():
            continue
        abs_url = _absolute_url(page_url, value.strip())
        if not abs_url or abs_url in seen:
            continue
        lower = abs_url.lower()
        if (
            "delivery.cfm" in lower
            or lower.endswith(".pdf")
            or "/pdf/" in lower
            or "download" in lower and ".pdf" in lower
        ):
            seen.add(abs_url)
            found.append(abs_url)
    # Prefer Delivery.cfm and explicit .pdf
    def score(u: str) -> tuple[int, int]:
        lower = u.lower()
        if "delivery.cfm" in lower and ".pdf" in lower:
            return (0, len(u))
        if lower.endswith(".pdf") or "delivery.cfm" in lower:
            return (1, len(u))
        return (2, len(u))

    return sorted(found, key=score)


def camofox_session_user_id() -> str:
    """Stable Camofox userId so cookies persist across PDF captures."""
    value = (os.environ.get("BROWSER_CAMOFOX_USER_ID") or "").strip()
    return value or "polaris-literature"


def _run_browser(url: str, run_id: str, work_dir: Path, timeout_ms: int, actions: list[dict[str, Any]]) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    input_path = work_dir / "browser.input.json"
    output_path = work_dir / "browser.output.json"
    # clue-browser caps timeout_ms at 120000.
    timeout_ms = max(1, min(int(timeout_ms), 120_000))
    challenge_ms = max(1, min(timeout_ms, 90_000))
    browser_options: dict[str, Any] = {
        "backend": "camofox",
        "session_user_id": camofox_session_user_id(),
        "humanize": False,
        "timeout_ms": timeout_ms,
        "wait_for_challenge": True,
        "challenge_timeout_ms": challenge_ms,
        "pacing": {"delay_ms": 0},
    }
    cookies_path = (os.environ.get("BROWSER_IMPORT_COOKIES_PATH") or "").strip()
    if cookies_path:
        browser_options["import_cookies_path"] = cookies_path
    browser_input = {
        "schema_version": "clue.browser.input.v1",
        "run_id": run_id,
        "start_url": url,
        "browser": browser_options,
        "actions": actions,
    }
    input_path.write_text(json.dumps(browser_input, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    env = os.environ.copy()
    log("browser_start", run_id=run_id, url=url, timeout_ms=timeout_ms)
    try:
        completed = subprocess.run(
            [str(browser_cli()), "run", "--input", str(input_path), "--output", str(output_path)],
            cwd=str(tools_root().parent),
            text=True,
            capture_output=True,
            check=False,
            env=env,
            timeout=max(timeout_ms / 1000 + 60, 180),
        )
    except subprocess.TimeoutExpired:
        return {
            "url": url,
            "status": "failed",
            "error": "clue-browser timed out",
            "exit_code": -1,
        }
    result: dict[str, Any] = {
        "url": url,
        "exit_code": completed.returncode,
        "stdout": (completed.stdout or "")[-2000:],
        "stderr": (completed.stderr or "")[-2000:],
    }
    if completed.returncode != 0 or not output_path.is_file():
        result["status"] = "failed"
        result["error"] = "clue-browser run failed"
        log(
            "browser_done",
            run_id=run_id,
            url=url,
            status="failed",
            exit_code=completed.returncode,
            error=result["error"],
        )
        return result
    try:
        document = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        result["status"] = "failed"
        result["error"] = f"invalid browser output: {error}"
        return result
    result["document"] = document
    result["status"] = "ok"
    return result


def _finalize_pdf_result(
    result: dict[str, Any],
    pdfs: list[dict[str, Any]],
    work_dir: Path,
    run_id: str,
    url: str,
) -> dict[str, Any]:
    source_pdf = Path(str(pdfs[0]["path"]))
    if not source_pdf.is_file() or not is_pdf_bytes(source_pdf.read_bytes()[:8]):
        result["status"] = "failed"
        result["error"] = "download artifact is not a PDF file"
        log("browser_done", run_id=run_id, url=url, status="failed", error=result["error"])
        return result
    dest_name = Path(str(pdfs[0].get("filename") or source_pdf.name)).name
    if not dest_name.lower().endswith(".pdf"):
        dest_name = f"{dest_name}.pdf"
    dest = work_dir / dest_name.replace("/", "_")
    shutil.copy2(source_pdf, dest)
    result.update(
        {
            "status": "retrieved",
            "path": str(dest),
            "filename": dest.name,
            "bytes": dest.stat().st_size,
            "sha256": pdfs[0].get("sha256"),
            "source": pdfs[0].get("source") or "browser",
            "page_title": ((result.get("document") or {}).get("page") or {}).get("title"),
        }
    )
    log(
        "browser_done",
        run_id=run_id,
        url=url,
        status="retrieved",
        bytes=result["bytes"],
        path=str(dest),
        page_title=result.get("page_title"),
    )
    return result


def capture_one_pdf(
    url: str,
    *,
    run_id: str,
    work_dir: Path,
    timeout_ms: int = 120_000,
) -> dict[str, Any]:
    """Run clue-browser (camofox) against one URL; follow SSRN Delivery.cfm after CF."""
    work_dir.mkdir(parents=True, exist_ok=True)
    challenge_ms = min(timeout_ms, 90_000)

    # Pass 1: land, clear challenge, try click/extract download links.
    first = _run_browser(
        url,
        run_id=run_id,
        work_dir=work_dir / "pass1",
        timeout_ms=timeout_ms,
        actions=_browser_actions_for_landing(url, timeout_ms),
    )
    if first.get("status") != "ok":
        return first

    document = first["document"]
    pdfs = _pdfs_from_browser_output(document)
    if pdfs:
        return _finalize_pdf_result(first, pdfs, work_dir, run_id, url)

    page_url = str(document.get("final_url") or url)
    follow_urls = _download_urls_from_document(document, page_url)
    # Always prefer Delivery.cfm / direct pdf over staying on abstract HTML.
    log(
        "browser_follow_candidates",
        run_id=run_id,
        page_url=page_url[:160],
        candidates=follow_urls[:5],
        page_title=((document.get("page") or {}).get("title") or "")[:120],
    )

    for index, follow in enumerate(follow_urls[:3]):
        second = _run_browser(
            follow,
            run_id=f"{run_id}-dl{index}",
            work_dir=work_dir / f"pass2-{index}",
            timeout_ms=timeout_ms,
            actions=[
                {"type": "solve-challenge", "timeout_ms": challenge_ms},
                {"type": "screenshot", "name": "download-page", "full_page": False},
            ],
        )
        if second.get("status") != "ok":
            continue
        pdfs = _pdfs_from_browser_output(second["document"])
        if pdfs:
            second["followed_from"] = url
            second["download_url"] = follow
            return _finalize_pdf_result(second, pdfs, work_dir, run_id, follow)

    first["status"] = "failed"
    first["error"] = "no PDF artifact from clue-browser"
    first["browser_status"] = document.get("status")
    first["page_title"] = (document.get("page") or {}).get("title")
    first["follow_candidates"] = follow_urls[:5]
    log(
        "browser_done",
        run_id=run_id,
        url=url,
        status="failed",
        error=first["error"],
        page_title=first.get("page_title"),
        follow_candidates=follow_urls[:3],
    )
    return first


def _process_one_record(
    index: int,
    record: dict[str, Any],
    *,
    limit: int,
    pdf_dir: Path,
    runs_dir: Path,
    max_urls_per_record: int,
    timeout_ms: int,
) -> dict[str, Any]:
    """Process a single literature record (candidates stay serial).

    Returns a result dict for the pool reducer:
      index, record, skipped, attempted, retrieved, failed, retrieved_file
    """
    empty = {
        "index": index,
        "record": record,
        "skipped": 0,
        "attempted": 0,
        "retrieved": 0,
        "failed": 0,
        "retrieved_file": None,
    }
    if not isinstance(record, dict):
        return {**empty, "skipped": 1, "record": record}

    record_id = str(record.get("record_id") or f"record-{index}")
    safe_id = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in record_id)[:80]
    candidates = candidate_urls_from_record(record)
    rejected = list(getattr(candidate_urls_from_record, "last_rejected", []) or [])
    if rejected:
        reason_counts: dict[str, int] = {}
        for item in rejected:
            key = str(item.get("reason") or "unknown")
            reason_counts[key] = reason_counts.get(key, 0) + 1
        log(
            "capture_candidates_filtered",
            index=index + 1,
            total=limit,
            record_id=record_id,
            rejected=len(rejected),
            kept=len(candidates),
            reasons=reason_counts,
            samples=rejected[:5],
        )
    if not candidates:
        log(
            "capture_record_skip",
            index=index + 1,
            total=limit,
            record_id=record_id,
            reason="no_candidates_after_filter" if rejected else "no_candidates",
            rejected=len(rejected),
        )
        return {**empty, "skipped": 1, "record": record}

    payload = dict(record.get("payload") or {})
    pdf_links = dict(payload.get("pdf_links") or {})
    # Resume: keep records that already have a local PDF on disk.
    existing_local = pdf_links.get("local_pdf")
    if isinstance(existing_local, str) and Path(existing_local).is_file() and is_pdf_bytes(
        Path(existing_local).read_bytes()[:8]
    ):
        log(
            "capture_record_skip",
            index=index + 1,
            total=limit,
            record_id=record_id,
            reason="already_retrieved",
            local_pdf=existing_local,
        )
        return {
            **empty,
            "skipped": 1,
            "retrieved": 1,
            "retrieved_file": existing_local,
            "record": record,
        }
    existing_dest = pdf_dir / f"{safe_id}.pdf"
    if existing_dest.is_file() and is_pdf_bytes(existing_dest.read_bytes()[:8]):
        pdf_links["validation"] = "retrieved"
        pdf_links["local_pdf"] = str(existing_dest)
        payload["pdf_links"] = pdf_links
        # Keep global cache warm when workspace already has the file.
        try:
            from literature.pdf_cache import store_pdf

            store_pdf(record, existing_dest, source_url=str(record.get("source_url") or ""))
        except Exception:
            pass
        log(
            "capture_record_skip",
            index=index + 1,
            total=limit,
            record_id=record_id,
            reason="pdf_on_disk",
            local_pdf=str(existing_dest),
        )
        return {
            **empty,
            "skipped": 1,
            "retrieved": 1,
            "retrieved_file": str(existing_dest),
            "record": {**record, "payload": payload},
        }

    # Shared cache (POLARIS_LITERATURE_CACHE_ROOT/literature-pdfs): share PDFs across workspaces.
    try:
        from literature.pdf_cache import materialize_cached_pdf, resolve_pdf_cache_root

        cached_dest = materialize_cached_pdf(record, existing_dest)
    except Exception:
        cached_dest = None
    if cached_dest is not None and is_pdf_bytes(cached_dest.read_bytes()[:8]):
        pdf_links["validation"] = "retrieved"
        pdf_links["local_pdf"] = str(cached_dest)
        pdf_links["cache"] = {
            "hit": True,
            "root": str(resolve_pdf_cache_root()),
        }
        payload["pdf_links"] = pdf_links
        log(
            "capture_record_skip",
            index=index + 1,
            total=limit,
            record_id=record_id,
            reason="pdf_cache_hit",
            local_pdf=str(cached_dest),
            cache_root=str(resolve_pdf_cache_root()),
        )
        return {
            **empty,
            "skipped": 1,
            "retrieved": 1,
            "retrieved_file": str(cached_dest),
            "record": {**record, "payload": payload},
        }

    log(
        "capture_record_start",
        index=index + 1,
        total=limit,
        record_id=record_id,
        candidates=len(candidates),
        first_url=candidates[0]["url"][:160],
    )
    new_candidates: list[dict[str, Any]] = []
    retrieved_path: str | None = None
    attempts: list[dict[str, Any]] = []

    for candidate in candidates[: max(1, max_urls_per_record)]:
        if retrieved_path:
            # Keep remaining candidates as not_downloaded once one PDF is stored.
            new_candidates.append(dict(candidate))
            continue
        # Skip candidates that already failed hard this batch (same url).
        if candidate.get("validation") == "failed" and candidate.get("link_kind") not in {
            "acm-pdf",
            "arxiv-pdf",
        }:
            new_candidates.append(dict(candidate))
            continue
        run_dir = runs_dir / f"{safe_id}-{len(attempts)}"
        capture = capture_one_pdf(
            candidate["url"],
            run_id=f"pdf-{safe_id}-{len(attempts)}",
            work_dir=run_dir,
            timeout_ms=timeout_ms,
        )
        attempts.append(capture)
        if capture.get("status") == "retrieved" and capture.get("path"):
            source = Path(str(capture["path"]))
            dest = pdf_dir / f"{safe_id}.pdf"
            shutil.copy2(source, dest)
            retrieved_path = str(dest)
            try:
                from literature.pdf_cache import store_pdf

                store_pdf(
                    record,
                    dest,
                    source_url=str(candidate.get("url") or record.get("source_url") or ""),
                )
            except Exception:
                pass
            new_candidates.append(
                {
                    **candidate,
                    "validation": "retrieved",
                    "local_path": str(dest),
                    "bytes": dest.stat().st_size,
                    "sha256": capture.get("sha256"),
                    "captured_at": utc_now(),
                    "capture_source": "clue-browser",
                }
            )
        else:
            new_candidates.append(
                {
                    **candidate,
                    "validation": "failed",
                    "error": capture.get("error") or "capture_failed",
                    "captured_at": utc_now(),
                    "capture_source": "clue-browser",
                }
            )

    # Preserve any candidates beyond max_urls_per_record
    for candidate in candidates[max(1, max_urls_per_record) :]:
        new_candidates.append(dict(candidate))

    any_retrieved = any(item.get("validation") == "retrieved" for item in new_candidates)
    any_failed = any(item.get("validation") == "failed" for item in new_candidates)
    if any_retrieved and not any(item.get("validation") == "not_downloaded" for item in new_candidates):
        overall = "retrieved"
    elif any_retrieved:
        overall = "partial"
    elif any_failed:
        overall = "failed"
    else:
        overall = "not_downloaded"

    pdf_links.update(
        {
            "status": "listed",
            "validation": overall if overall != "partial" else "partial",
            "candidates": new_candidates,
            "capture_attempts": len(attempts),
        }
    )
    if retrieved_path:
        pdf_links["local_pdf"] = retrieved_path
    payload["pdf_links"] = pdf_links
    if attempts:
        payload["pdf_capture"] = {
            "status": "retrieved" if retrieved_path else "failed",
            "attempts": [
                {
                    "url": item.get("url"),
                    "status": item.get("status"),
                    "error": item.get("error"),
                    "path": item.get("path"),
                    "bytes": item.get("bytes"),
                }
                for item in attempts
            ],
        }
    return {
        "index": index,
        "record": {**record, "payload": payload},
        "skipped": 0,
        "attempted": 1,
        "retrieved": 1 if retrieved_path else 0,
        "failed": 0 if retrieved_path else 1,
        "retrieved_file": retrieved_path,
        "record_id": record_id,
        "status": "retrieved" if retrieved_path else "failed",
        "local_pdf": retrieved_path,
    }


def capture_pdfs_for_collection(
    collection: dict[str, Any],
    *,
    output_dir: Path,
    max_records: int | None = None,
    max_urls_per_record: int = 2,
    timeout_ms: int = 120_000,
    max_workers: int | None = None,
) -> dict[str, Any]:
    """Capture PDFs for literature records and update pdf_links validation.

    Record-level parallelism via ThreadPoolExecutor (default 8 workers).
    Candidate URLs within a record remain serial (stop on first PDF).
    Starts or reuses a shared Camofox HTTP server so concurrent clue-browser
    processes do not start/kill the server per URL.
    """
    if collection.get("collection_kind") != "literature":
        raise PdfCaptureError("capture-pdfs requires literature collection output")
    records_in = collection.get("records")
    if not isinstance(records_in, list):
        raise PdfCaptureError("collection.records must be an array")

    workers = resolve_max_workers(max_workers)
    output_dir.mkdir(parents=True, exist_ok=True)
    pdf_dir = output_dir / "pdfs"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    runs_dir = output_dir / "browser-runs"
    runs_dir.mkdir(parents=True, exist_ok=True)

    try:
        from literature.pdf_cache import ensure_cache_dirs, resolve_pdf_cache_root

        pdf_cache_root = str(ensure_cache_dirs())
    except Exception:
        pdf_cache_root = None

    summary: dict[str, Any] = {
        "attempted_records": 0,
        "retrieved_records": 0,
        "failed_records": 0,
        "skipped_records": 0,
        "retrieved_files": [],
        "max_workers": workers,
        "pdf_cache_root": pdf_cache_root,
    }

    limit = len(records_in) if max_records is None else min(len(records_in), max_records)
    camofox_url, stop_camofox = ensure_shared_camofox_server()
    log(
        "capture_batch_start",
        total_records=len(records_in),
        limit=limit,
        max_urls_per_record=max_urls_per_record,
        max_workers=workers,
        camofox_url=camofox_url,
        pdf_cache_root=pdf_cache_root,
        output_dir=str(output_dir),
    )

    jobs = list(enumerate(records_in[:limit]))
    results_by_index: dict[int, dict[str, Any]] = {}
    progress_lock = threading.Lock()

    def run_job(index: int, record: Any) -> dict[str, Any]:
        if not isinstance(record, dict):
            return {
                "index": index,
                "record": record,
                "skipped": 1,
                "attempted": 0,
                "retrieved": 0,
                "failed": 0,
                "retrieved_file": None,
            }
        return _process_one_record(
            index,
            record,
            limit=limit,
            pdf_dir=pdf_dir,
            runs_dir=runs_dir,
            max_urls_per_record=max_urls_per_record,
            timeout_ms=timeout_ms,
        )

    def apply_result(result: dict[str, Any]) -> None:
        summary["skipped_records"] += int(result.get("skipped") or 0)
        summary["attempted_records"] += int(result.get("attempted") or 0)
        summary["retrieved_records"] += int(result.get("retrieved") or 0)
        summary["failed_records"] += int(result.get("failed") or 0)
        retrieved_file = result.get("retrieved_file")
        if retrieved_file:
            summary["retrieved_files"].append(retrieved_file)
        if result.get("attempted"):
            log(
                "capture_record_done",
                index=int(result["index"]) + 1,
                total=limit,
                record_id=result.get("record_id"),
                status=result.get("status"),
                attempted=summary["attempted_records"],
                retrieved=summary["retrieved_records"],
                failed=summary["failed_records"],
                local_pdf=result.get("local_pdf"),
                max_workers=workers,
            )

    try:
        if workers == 1 or len(jobs) <= 1:
            for index, record in jobs:
                result = run_job(index, record)
                results_by_index[result["index"]] = result
                apply_result(result)
        else:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(run_job, index, record): index for index, record in jobs
                }
                for future in as_completed(futures):
                    result = future.result()
                    with progress_lock:
                        results_by_index[result["index"]] = result
                        apply_result(result)

        updated: list[dict[str, Any]] = [
            results_by_index[i]["record"] for i in range(limit) if i in results_by_index
        ]

        # Append unprocessed remaining records unchanged
        for record in records_in[limit:]:
            summary["skipped_records"] += 1
            updated.append(record)

        output_document = {
            **collection,
            "records": updated,
            "status": collection.get("status") or "augmented_candidate_set",
            "pdf_capture": {
                "tool": "clue-data-collection phase 2 (pdf_capture)",
                "browser": "tools/browser (camofox)",
                "generated_at": utc_now(),
                "summary": summary,
                "output_dir": str(output_dir),
                "max_workers": workers,
                "camofox_url": camofox_url,
            },
        }
        output_path = output_dir / "output.json"
        output_path.write_text(
            json.dumps(output_document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        summary_path = output_dir / "pdf-capture-summary.json"
        summary_path.write_text(
            json.dumps(
                {
                    "generated_at": utc_now(),
                    "summary": summary,
                    "output": str(output_path),
                    "max_workers": workers,
                    "camofox_url": camofox_url,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        log(
            "capture_batch_done",
            output=str(output_path),
            pdf_dir=str(pdf_dir),
            summary=summary,
            max_workers=workers,
            camofox_url=camofox_url,
        )
        return {
            "status": "succeeded",
            "output": str(output_path),
            "summary": summary,
            "pdf_dir": str(pdf_dir),
            "max_workers": workers,
            "camofox_url": camofox_url,
        }
    finally:
        stop_camofox()
