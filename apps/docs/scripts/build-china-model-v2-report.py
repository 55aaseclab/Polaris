#!/usr/bin/env python3
"""Build V2 of the relay-price ranking around Chinese foundation models.

V1 remains untouched. V2 uses the existing V1 public-price snapshot plus
separate dated snapshots for DeepSeek V4 Pro and direct public API quotes for
Qwen, Hy3 Preview, and Doubao Seed 1.6.

Usage from ``docs``:

    python3 scripts/build-china-model-v2-report.py --capture --capture-dir /tmp
    python3 scripts/build-china-model-v2-report.py --check
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup


REPORT_DATE = "2026-09-08"
USD_TO_CNY = 6.728426
SOURCE_ROOT = Path(__file__).resolve().parent.parent
RESEARCH_ROOT = SOURCE_ROOT / "site" / "public" / "research"

V1_NORMALIZED = RESEARCH_ROOT / "api-relay-pricing-normalized-data-2026-09-08.json"
EASYWOK_PRICING = RESEARCH_ROOT / "easywok-api-pricing-2026-09-08.json"
EASYWOK_STATUS = RESEARCH_ROOT / "easywok-api-status-2026-09-08.json"
TAISURE_PRICING = RESEARCH_ROOT / "taisure-api-pricing-2026-09-08.json"
TAISURE_STATUS = RESEARCH_ROOT / "taisure-api-status-2026-09-08.json"
DEEPSEEK_PRO_SNAPSHOT = (
    RESEARCH_ROOT / "china-model-v2-deepseek-v4-pro-observations-2026-09-08.json"
)
DIRECT_API_SNAPSHOT = (
    RESEARCH_ROOT / "china-model-v2-direct-api-observations-2026-09-08.json"
)
REPORT = RESEARCH_ROOT / "china-model-price-ranking-v2-2026-09-08.html"
NORMALIZED_DATA = RESEARCH_ROOT / "china-model-price-ranking-v2-2026-09-08.json"
REPORT_URL = "/research/china-model-price-ranking-v2-2026-09-08.html"
MARKDOWN_EVIDENCE = (
    SOURCE_ROOT / "site" / "business-model" / "china-model-price-ranking-v2-2026-09-08.md"
)
PINNED_STATION_ID = "taisure-v2"
PINNED_STATION_NAME = "Taisure"

MODEL_ORDER = [
    "qwen38max",
    "deepseekv4pro",
    "deepseekv4flash",
    "glm53",
    "glm52",
    "kimik3",
    "kimik27code",
    "minimaxm3",
    "hy3preview",
    "doubaoseed16",
]
MODEL_LABELS = {
    "qwen38max": "Qwen 3.8 Max",
    "deepseekv4pro": "DeepSeek V4 Pro",
    "deepseekv4flash": "DeepSeek V4 Flash",
    "glm53": "GLM-5.3",
    "glm52": "GLM-5.2",
    "kimik3": "Kimi K3",
    "kimik27code": "Kimi K2.7 Code",
    "minimaxm3": "MiniMax M3",
    "hy3preview": "Hy3 Preview",
    "doubaoseed16": "Doubao Seed 1.6",
}
V1_LABEL_TO_MODEL = {
    "DeepSeek V4 Flash": "deepseekv4flash",
    "GLM-5.3": "glm53",
    "GLM-5.2": "glm52",
    "Kimi K3": "kimik3",
    "Kimi K2.7 Code": "kimik27code",
    "MiniMax M3": "minimaxm3",
}
EASYWOK_MODEL_NAMES = {
    "qwen38max": "qwen3.8-max",
    "deepseekv4pro": "deepseek-v4-pro",
    "glm53": "glm-5.3",
    "kimik3": "kimi-k3",
    "kimik27code": "kimi-k2.7-code",
    "minimaxm3": "minimax-m3",
}
TAISURE_MODEL_NAMES = {
    "deepseekv4pro": "deepseek-v4-pro",
    "deepseekv4flash": "deepseek-v4-flash",
    "glm52": "glm-5.2",
    "kimik27code": "kimi-k2.7-code",
    "minimaxm3": "MiniMax-M3",
    "hy3preview": "hy3",
}
DIRECT_MODEL_ALIASES = {
    "qwen38max": {"qwen38max"},
    "hy3preview": {"hy3", "hy3preview", "tencenthy3preview"},
    "doubaoseed16": {"doubaoseed16251015"},
}
PRICE_RE = re.compile(r"¥\s*([0-9]+(?:\.[0-9]+)?)")
EXCLUDED_GROUP_MARKERS = ("test", "测试", "free", "免费")


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", normalized)


def parse_cny(value: str) -> float | None:
    match = PRICE_RE.search(value)
    return float(match.group(1)) if match else None


def basket(observation: dict[str, Any]) -> float:
    return float(observation["input_cny"]) + float(observation["output_cny"])


def capture_deepseek_pro(capture_dir: Path) -> list[dict[str, Any]]:
    source = capture_dir / "relay-deepseek-v4-pro.html"
    if not source.exists():
        raise RuntimeError(f"Missing DeepSeek V4 Pro source page: {source}")
    soup = BeautifulSoup(source.read_text(encoding="utf-8"), "html.parser")
    table = soup.find("table")
    if table is None:
        raise RuntimeError("DeepSeek V4 Pro source page does not contain a price table")
    observations = []
    for row in table.find_all("tr")[1:]:
        cells = row.find_all("td")
        if len(cells) < 8:
            continue
        link = cells[0].find("a", href=True)
        if link is None:
            continue
        input_cny = parse_cny(cells[6].get_text(" ", strip=True))
        output_cny = parse_cny(cells[7].get_text(" ", strip=True))
        if input_cny is None or output_cny is None or input_cny <= 0 or output_cny <= 0:
            continue
        host = urlparse(link["href"]).netloc.lower().removeprefix("www.")
        observations.append(
            {
                "host": host,
                "station": cells[0].get_text(" ", strip=True).replace("↗", "").strip(),
                "website": link["href"],
                "model_id": "deepseekv4pro",
                "model_label": MODEL_LABELS["deepseekv4pro"],
                "channel": cells[1].get_text(" ", strip=True),
                "input_cny": input_cny,
                "output_cny": output_cny,
                "source_label": "AI 比价 DeepSeek V4 Pro 线路表",
                "source_url": "https://www.china-ai-arbitrage.xyz/zh/api-relays/deepseek-v4-pro",
            }
        )
    if not observations:
        raise RuntimeError("DeepSeek V4 Pro source page yielded no positive token quotes")
    return observations


def group_price_factor(payload: dict[str, Any], model_name: str, group: str) -> float:
    group_ratio = payload.get("group_ratio", {})
    base = group_ratio.get(group, 1) if isinstance(group_ratio, dict) else 1
    overrides = payload.get("model_group_ratio", {})
    if isinstance(overrides, dict):
        model_overrides = overrides.get(group, {})
        if isinstance(model_overrides, dict):
            value = model_overrides.get(model_name)
            if isinstance(value, (int, float)):
                return float(value)
    return float(base) if isinstance(base, (int, float)) else 1.0


def select_public_group(payload: dict[str, Any], model: dict[str, Any]) -> tuple[str, float] | None:
    model_name = str(model.get("model_name", ""))
    groups = model.get("enable_groups", [])
    if not isinstance(groups, list):
        return None
    eligible = []
    for group in groups:
        if not isinstance(group, str):
            continue
        lowered = group.lower()
        if any(marker in lowered for marker in EXCLUDED_GROUP_MARKERS):
            continue
        factor = group_price_factor(payload, model_name, group)
        if factor > 0:
            eligible.append((group, factor))
    if not eligible:
        return None
    return min(eligible, key=lambda item: (item[1], item[0]))


def capture_direct_api_quotes(capture_dir: Path) -> list[dict[str, Any]]:
    probe_dir = capture_dir / "relay-api-probe"
    status_dir = probe_dir / "status"
    if not probe_dir.exists() or not status_dir.exists():
        raise RuntimeError(f"Missing public API probe capture under {probe_dir}")
    observations = []
    for pricing_path in sorted(probe_dir.glob("*.body")):
        host = pricing_path.stem
        status_path = status_dir / f"{host}.json"
        try:
            payload = read_json(pricing_path)
            status = read_json(status_path).get("data", {})
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        if not isinstance(payload, dict) or not isinstance(status, dict):
            continue
        display_type = status.get("quota_display_type")
        if display_type not in {"USD", "CNY"}:
            continue
        conversion = (
            USD_TO_CNY
            if display_type == "USD"
            else float(status.get("usd_exchange_rate", 1) or 1)
        )
        models = payload.get("data", [])
        if not isinstance(models, list):
            continue
        for model in models:
            if not isinstance(model, dict):
                continue
            normalized_name = normalize(str(model.get("model_name", "")))
            model_id = next(
                (
                    candidate
                    for candidate, aliases in DIRECT_MODEL_ALIASES.items()
                    if normalized_name in aliases
                ),
                None,
            )
            if model_id is None:
                continue
            ratio = model.get("model_ratio")
            completion = model.get("completion_ratio")
            if not isinstance(ratio, (int, float)) or not isinstance(completion, (int, float)):
                continue
            if ratio <= 0 or completion <= 0:
                continue
            group = select_public_group(payload, model)
            if group is None:
                continue
            group_name, group_ratio = group
            input_native = float(ratio) * 2 * group_ratio
            output_native = input_native * float(completion)
            observations.append(
                {
                    "host": host,
                    "model_id": model_id,
                    "model_label": MODEL_LABELS[model_id],
                    "raw_model_name": model.get("model_name"),
                    "channel": group_name,
                    "input_cny": input_native * conversion,
                    "output_cny": output_native * conversion,
                    "native_price": (
                        f"{'$' if display_type == 'USD' else '¥'}{input_native:g} / "
                        f"{'$' if display_type == 'USD' else '¥'}{output_native:g}"
                    ),
                    "source_label": "中转站公开 API",
                    "source_url": f"https://{host}/api/pricing",
                    "source_status_url": f"https://{host}/api/status",
                }
            )
    if not observations:
        raise RuntimeError("Direct public API capture yielded no V2 model quotes")
    return observations


def capture(capture_dir: Path) -> None:
    write_json(DEEPSEEK_PRO_SNAPSHOT, capture_deepseek_pro(capture_dir))
    write_json(DIRECT_API_SNAPSHOT, capture_direct_api_quotes(capture_dir))
    pricing_source = capture_dir / "taisure-pricing.json"
    status_source = capture_dir / "taisure-status.json"
    if not pricing_source.exists() or not status_source.exists():
        raise RuntimeError("Missing Taisure pricing/status capture")
    pricing = read_json(pricing_source)
    status = read_json(status_source)
    if not pricing.get("success") or not status.get("data"):
        raise RuntimeError("Taisure capture did not contain a successful pricing/status payload")
    write_json(TAISURE_PRICING, pricing)
    write_json(TAISURE_STATUS, status)


def observation_from_v1(source: dict[str, Any], model_id: str) -> dict[str, Any]:
    result = dict(source)
    result["model_id"] = model_id
    result["model_label"] = MODEL_LABELS[model_id]
    return result


def build_gateway_observations(
    pricing_path: Path,
    status_path: Path,
    station_id: str,
    station_name: str,
    website: str,
    model_names: dict[str, str],
    api_base_url: str,
) -> list[dict[str, Any]]:
    pricing = read_json(pricing_path)
    status = read_json(status_path).get("data", {})
    display_type = status.get("quota_display_type")
    if display_type not in {"USD", "CNY"}:
        raise RuntimeError(f"Unexpected {station_name} display currency: {display_type}")
    groups = pricing.get("group_ratio", {})
    by_name = {item.get("model_name"): item for item in pricing.get("data", [])}
    observations = []
    conversion = (
        USD_TO_CNY
        if display_type == "USD"
        else float(status.get("usd_exchange_rate", 1) or 1)
    )
    for model_id, source_name in model_names.items():
        model = by_name.get(source_name)
        if not isinstance(model, dict):
            continue
        ratio = model.get("model_ratio")
        completion = model.get("completion_ratio")
        if not isinstance(ratio, (int, float)) or not isinstance(completion, (int, float)):
            continue
        model_groups = model.get("enable_groups", [])
        if not isinstance(model_groups, list) or not model_groups:
            continue
        group = "MIX分组" if "MIX分组" in model_groups else model_groups[0]
        factor = float(groups.get(group, 1)) if isinstance(groups, dict) else 1.0
        input_usd = float(ratio) * 2 * factor
        output_usd = input_usd * float(completion)
        if input_usd <= 0 or output_usd <= 0:
            continue
        observations.append(
            {
                "station_id": station_id,
                "station": station_name,
                "website": website,
                "model_id": model_id,
                "model_label": MODEL_LABELS[model_id],
                "channel": group,
                "input_cny": input_usd * conversion,
                "output_cny": output_usd * conversion,
                "source_label": f"{station_name} 公开 API",
                "source_url": f"{api_base_url.rstrip('/')}/api/pricing",
                "source_status_url": f"{api_base_url.rstrip('/')}/api/status",
            }
        )
    return observations


def build_easywok_observations() -> list[dict[str, Any]]:
    return build_gateway_observations(
        EASYWOK_PRICING,
        EASYWOK_STATUS,
        "easywok-v2",
        "Easywok",
        "https://ai.easywok.net/keys",
        EASYWOK_MODEL_NAMES,
        "https://ai.easywok.net",
    )


def build_taisure_observations() -> list[dict[str, Any]]:
    return build_gateway_observations(
        TAISURE_PRICING,
        TAISURE_STATUS,
        PINNED_STATION_ID,
        PINNED_STATION_NAME,
        "https://taisure.com/pricing",
        TAISURE_MODEL_NAMES,
        "https://taisure.com",
    )


def select_lowest(observations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for observation in observations:
        if observation["input_cny"] <= 0 or observation["output_cny"] <= 0:
            continue
        model_id = observation["model_id"]
        current = result.get(model_id)
        if current is None or (
            basket(observation), observation["input_cny"], observation["channel"]
        ) < (
            basket(current), current["input_cny"], current["channel"]
        ):
            result[model_id] = observation
    return result


def build_stations() -> list[dict[str, Any]]:
    v1 = read_json(V1_NORMALIZED)
    metadata = {
        station["id"]: {
            "id": station["id"],
            "name": station["name"],
            "website": station["website"],
            "tier": station["tier"],
        }
        for station in v1["stations"]
        if station["tier"] == "T2"
    }
    metadata["easywok-v2"] = {
        "id": "easywok-v2",
        "name": "Easywok",
        "website": "https://ai.easywok.net/keys",
        "tier": "T1",
    }
    by_station: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for station in v1["stations"]:
        if station["id"] not in metadata:
            continue
        for observation in station["selected"]:
            model_id = V1_LABEL_TO_MODEL.get(observation.get("model_label"))
            if model_id:
                by_station[station["id"]].append(observation_from_v1(observation, model_id))
    for observation in read_json(DEEPSEEK_PRO_SNAPSHOT):
        station_id = f"ca:{observation['host']}"
        if station_id not in metadata:
            continue
        by_station[station_id].append(
            {
                "station_id": station_id,
                "station": metadata[station_id]["name"],
                "website": metadata[station_id]["website"],
                **{key: value for key, value in observation.items() if key not in {"host", "station", "website"}},
            }
        )
    for observation in read_json(DIRECT_API_SNAPSHOT):
        station_id = f"ca:{observation['host']}"
        if station_id not in metadata:
            continue
        by_station[station_id].append(
            {
                "station_id": station_id,
                "station": metadata[station_id]["name"],
                "website": metadata[station_id]["website"],
                **{key: value for key, value in observation.items() if key != "host"},
            }
        )
    by_station["easywok-v2"].extend(build_easywok_observations())
    metadata[PINNED_STATION_ID] = {
        "id": PINNED_STATION_ID,
        "name": PINNED_STATION_NAME,
        "website": "https://taisure.com/pricing",
        "tier": "T1",
    }
    by_station[PINNED_STATION_ID].extend(build_taisure_observations())

    stations = []
    for station_id, observations in by_station.items():
        selected = select_lowest(observations)
        if not selected:
            continue
        stations.append({**metadata[station_id], "selected": selected})
    return stations


def rank(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    values: dict[str, list[float]] = defaultdict(list)
    for station in stations:
        for model_id, observation in station["selected"].items():
            values[model_id].append(basket(observation))
    medians = {
        model_id: statistics.median(prices)
        for model_id, prices in values.items()
        if len(prices) >= 2
    }
    ranked = []
    for station in stations:
        ratios = []
        used = []
        for model_id, observation in station["selected"].items():
            median = medians.get(model_id)
            if median is None:
                continue
            ratios.append(basket(observation) / median)
            used.append(model_id)
        if not ratios:
            continue
        station["index_models"] = sorted(used, key=MODEL_ORDER.index)
        station["model_coverage"] = len(used)
        station["price_index"] = 100 * math.exp(sum(math.log(value) for value in ratios) / len(ratios))
        ranked.append(station)
    ranked.sort(
        key=lambda item: (
            item["price_index"],
            -item["model_coverage"],
            item["name"].lower(),
        )
    )
    for position, station in enumerate(ranked, start=1):
        station["market_rank"] = position
    return ranked


def evidence_links_html(station: dict[str, Any]) -> str:
    links = []
    for model_id in station["index_models"]:
        observation = station["selected"][model_id]
        links.append(
            f'<a href="{esc(observation["source_url"])}" target="_blank" rel="noreferrer">'
            f"{esc(MODEL_LABELS[model_id])}</a>"
        )
    return "<br>".join(links)


def evidence_links_markdown(station: dict[str, Any]) -> str:
    return "<br>".join(
        f"[{MODEL_LABELS[model_id]}]({station['selected'][model_id]['source_url']})"
        for model_id in station["index_models"]
    )


def station_link_html(station: dict[str, Any], pinned: bool = False) -> str:
    pin = f'<span class="pin">{esc(PINNED_STATION_NAME)} 置顶</span>' if pinned else ""
    return (
        f'<a href="{esc(station["website"])}" target="_blank" rel="noreferrer">'
        f"{esc(station['name'])}</a>{pin}"
    )


def build_ranking_views(ranked: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    pinned = next(station for station in ranked if station["id"] == PINNED_STATION_ID)
    overall_display = [pinned] + [station for station in ranked if station["id"] != PINNED_STATION_ID]
    overall_rows = []
    for display_rank, station in enumerate(overall_display, start=1):
        overall_rows.append(
            {
                "pinned": station["id"] == PINNED_STATION_ID,
                "cells": [
                    str(display_rank),
                    station_link_html(station, station["id"] == PINNED_STATION_ID),
                    str(station["market_rank"]),
                    f"{station['price_index']:.2f}",
                    f"{station['model_coverage']}/{len(MODEL_ORDER)}",
                    evidence_links_html(station),
                ],
            }
        )
    views: dict[str, dict[str, Any]] = {
        "overall": {
            "headers": ["展示序", "中转站", "市场排名", "价格指数", "可比模型", "证据"],
            "rows": overall_rows,
        }
    }
    for model_id in MODEL_ORDER:
        candidates = [station for station in ranked if model_id in station["selected"]]
        candidates.sort(
            key=lambda station: (
                basket(station["selected"][model_id]),
                station["selected"][model_id]["input_cny"],
                station["name"].lower(),
            )
        )
        model_ranks = {station["id"]: index for index, station in enumerate(candidates, start=1)}
        model_pinned = next(
            (station for station in candidates if station["id"] == PINNED_STATION_ID),
            None,
        )
        model_display = ([model_pinned] if model_pinned else []) + [
            station for station in candidates if station["id"] != PINNED_STATION_ID
        ]
        model_rows = []
        for display_rank, station in enumerate(model_display, start=1):
            observation = station["selected"][model_id]
            model_rows.append(
                {
                    "pinned": station["id"] == PINNED_STATION_ID,
                    "cells": [
                        str(display_rank),
                        station_link_html(station, station["id"] == PINNED_STATION_ID),
                        str(model_ranks[station["id"]]),
                        f"¥{observation['input_cny']:.2f} / ¥{observation['output_cny']:.2f}",
                        f"¥{basket(observation):.2f}",
                        f'<a href="{esc(observation["source_url"])}" target="_blank" rel="noreferrer">'
                        f"{esc(MODEL_LABELS[model_id])}</a>",
                    ],
                }
            )
        views[model_id] = {
            "headers": ["展示序", "中转站", "模型排名", "输入 / 输出", "合计", "证据"],
            "rows": model_rows,
        }
    return views


def render_interactive_report(ranked: list[dict[str, Any]]) -> str:
    views = build_ranking_views(ranked)
    serialized_views = json.dumps(views, ensure_ascii=False).replace("</", "<\\/")
    options = "".join(
        f'<option value="{model_id}">{esc(MODEL_LABELS[model_id])}</option>'
        for model_id in MODEL_ORDER
    )
    models = " · ".join(MODEL_LABELS[model_id] for model_id in MODEL_ORDER)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>中国大模型中转价格排名 V2（{REPORT_DATE}）</title>
  <style>
    :root {{ color-scheme: light; --ink: #17202a; --muted: #687580; --line: #d9e1db; --accent: #0c6b58; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; color: var(--ink); background: #f4f6f3; font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }}
    main {{ width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }}
    h1 {{ margin: 0; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.045em; line-height: 1.08; }}
    .meta {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 12px; color: var(--muted); }}
    .meta span, .pin {{ padding: .2rem .55rem; border: 1px solid var(--line); border-radius: 999px; background: #fff; font-size: .8rem; font-weight: 700; }}
    .models {{ margin: 0 0 16px; color: var(--muted); font-size: .86rem; }}
    .controls {{ display: flex; align-items: center; gap: 10px; margin: 0 0 20px; }}
    label {{ color: var(--muted); font-size: .9rem; font-weight: 700; }}
    select {{ min-width: 220px; padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); font: inherit; }}
    .table-wrap {{ overflow: auto; border: 1px solid var(--line); border-radius: 14px; background: #fff; box-shadow: 0 12px 38px rgba(23, 32, 42, .08); }}
    table {{ width: 100%; min-width: 980px; border-collapse: collapse; }}
    th, td {{ padding: 13px 16px; border-bottom: 1px solid #e8ede8; text-align: left; vertical-align: top; }}
    thead th {{ position: sticky; top: 0; background: #e7f0e9; color: #244337; font-size: .84rem; }}
    tbody tr:hover {{ background: #f4fbf7; }}
    tbody tr.pinned {{ background: #fff5d8; }}
    tbody tr:last-child td {{ border-bottom: 0; }}
    td:first-child, td:nth-child(3), td:nth-child(4), td:nth-child(5) {{ font-variant-numeric: tabular-nums; white-space: nowrap; }}
    a {{ color: #075e4d; font-weight: 750; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    td:last-child a {{ font-size: .79rem; font-weight: 650; }}
    .pin {{ margin-left: 7px; border-color: #e7c36d; background: #ffe7aa; color: #684100; }}
    @media (max-width: 640px) {{ main {{ width: min(100% - 20px, 1280px); padding-top: 28px; }} th, td {{ padding: 11px 12px; }} }}
  </style>
</head>
<body>
  <main>
    <h1>中国大模型中转价格排名 V2</h1>
    <div class="meta"><span>{REPORT_DATE}</span><span>{len(ranked)} 个中转站</span></div>
    <p class="models">{esc(models)}</p>
    <div class="controls"><label for="model-selector">排名：</label><select id="model-selector"><option value="overall">整体</option>{options}</select></div>
    <div class="table-wrap"><table id="ranking-table"></table></div>
  </main>
  <script>
    const views = {serialized_views};
    const selector = document.getElementById("model-selector");
    const table = document.getElementById("ranking-table");
    const requestedModel = new URLSearchParams(window.location.search).get("model");
    if (requestedModel && views[requestedModel]) {{
      selector.value = requestedModel;
    }}
    const render = () => {{
      const view = views[selector.value];
      table.innerHTML = `<thead><tr>${{view.headers.map((header) => `<th>${{header}}</th>`).join("")}}</tr></thead><tbody>${{view.rows.map((row) => `<tr class="${{row.pinned ? "pinned" : ""}}">${{row.cells.map((cell) => `<td>${{cell}}</td>`).join("")}}</tr>`).join("")}}</tbody>`;
    }};
    selector.addEventListener("change", () => {{
      const url = new URL(window.location.href);
      if (selector.value === "overall") {{
        url.searchParams.delete("model");
      }} else {{
        url.searchParams.set("model", selector.value);
      }}
      window.history.replaceState(null, "", url);
      render();
    }});
    render();
  </script>
</body>
</html>
"""


def render_report(ranked: list[dict[str, Any]]) -> str:
    return render_interactive_report(ranked)


def render_report_legacy(ranked: list[dict[str, Any]]) -> str:
    pinned = next(station for station in ranked if station["id"] == PINNED_STATION_ID)
    display = [pinned] + [station for station in ranked if station["id"] != PINNED_STATION_ID]
    rows = []
    for display_rank, station in enumerate(display, start=1):
        pinned = f'<span class="pin">{PINNED_STATION_NAME} 置顶</span>' if station["id"] == PINNED_STATION_ID else ""
        rows.append(
            "<tr" + (" class=\"pinned\"" if station["id"] == PINNED_STATION_ID else "") + ">"
            f"<td>{display_rank}</td>"
            f"<td><a href=\"{esc(station['website'])}\" target=\"_blank\" rel=\"noreferrer\">"
            f"{esc(station['name'])}</a>{pinned}</td>"
            f"<td>{station['market_rank']}</td>"
            f"<td>{station['price_index']:.2f}</td>"
            f"<td>{station['model_coverage']}/{len(MODEL_ORDER)}</td>"
            f"<td>{evidence_links_html(station)}</td>"
            "</tr>"
        )
    models = " · ".join(MODEL_LABELS[model_id] for model_id in MODEL_ORDER)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>中国大模型中转价格排名 V2（{REPORT_DATE}）</title>
  <style>
    :root {{ color-scheme: light; --ink: #17202a; --muted: #687580; --line: #d9e1db; --accent: #0c6b58; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; color: var(--ink); background: #f4f6f3; font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }}
    main {{ width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }}
    h1 {{ margin: 0; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.045em; line-height: 1.08; }}
    .meta {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 12px; color: var(--muted); }}
    .meta span, .pin {{ padding: .2rem .55rem; border: 1px solid var(--line); border-radius: 999px; background: #fff; font-size: .8rem; font-weight: 700; }}
    .models {{ margin: 0 0 24px; color: var(--muted); font-size: .86rem; }}
    .table-wrap {{ overflow: auto; border: 1px solid var(--line); border-radius: 14px; background: #fff; box-shadow: 0 12px 38px rgba(23, 32, 42, .08); }}
    table {{ width: 100%; min-width: 980px; border-collapse: collapse; }}
    th, td {{ padding: 13px 16px; border-bottom: 1px solid #e8ede8; text-align: left; vertical-align: top; }}
    thead th {{ position: sticky; top: 0; background: #e7f0e9; color: #244337; font-size: .84rem; }}
    tbody tr:hover {{ background: #f4fbf7; }}
    tbody tr.pinned {{ background: #fff5d8; }}
    tbody tr:last-child td {{ border-bottom: 0; }}
    td:first-child, td:nth-child(3), td:nth-child(4), td:nth-child(5) {{ font-variant-numeric: tabular-nums; white-space: nowrap; }}
    a {{ color: #075e4d; font-weight: 750; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    td:last-child a {{ font-size: .79rem; font-weight: 650; }}
    .pin {{ margin-left: 7px; border-color: #e7c36d; background: #ffe7aa; color: #684100; }}
    @media (max-width: 640px) {{ main {{ width: min(100% - 20px, 1280px); padding-top: 28px; }} th, td {{ padding: 11px 12px; }} }}
  </style>
</head>
<body>
  <main>
    <h1>中国大模型中转价格排名 V2</h1>
    <div class="meta"><span>{REPORT_DATE}</span><span>{len(ranked)} 个中转站</span></div>
    <p class="models">{esc(models)}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>展示序</th><th>中转站</th><th>市场排名</th><th>价格指数</th><th>可比模型</th><th>证据</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
    </div>
  </main>
</body>
</html>
"""


def render_markdown_evidence(ranked: list[dict[str, Any]]) -> str:
    pinned = next(station for station in ranked if station["id"] == PINNED_STATION_ID)
    display = [pinned] + [station for station in ranked if station["id"] != PINNED_STATION_ID]
    rows = []
    for display_rank, station in enumerate(display, start=1):
        name = f"[{station['name']}]({station['website']})"
        if station["id"] == PINNED_STATION_ID:
            name += f"（{PINNED_STATION_NAME} 置顶）"
        rows.append(
            f"| {display_rank} | {name} | {station['market_rank']} | "
            f"{station['price_index']:.2f} | {station['model_coverage']}/{len(MODEL_ORDER)} | "
            f"{evidence_links_markdown(station)} |"
        )
    models = "、".join(MODEL_LABELS[model_id] for model_id in MODEL_ORDER)
    model_links = " · ".join(
        f"[{MODEL_LABELS[model_id]}]({REPORT_URL}?model={model_id})"
        for model_id in MODEL_ORDER
    )
    return "\n".join(
        [
            f"# 中国大模型中转价格排名 V2（{REPORT_DATE}）",
            "",
            f"模型：{models}",
            "",
            f"单模型排名：{model_links}",
            "",
            "| 展示序 | 中转站 | 市场排名 | 价格指数 | 可比模型 | 证据 |",
            "| ---: | --- | ---: | ---: | ---: | --- |",
            *rows,
            "",
        ]
    )


def normalized_output(ranked: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": "v2",
        "focus": "Chinese foundation models",
        "report_date": REPORT_DATE,
        "models": [
            {"id": model_id, "label": MODEL_LABELS[model_id]}
            for model_id in MODEL_ORDER
        ],
        "stations": [
            {
                "id": station["id"],
                "name": station["name"],
                "website": station["website"],
                "tier": station["tier"],
                "market_rank": station["market_rank"],
                "price_index": round(station["price_index"], 8),
                "model_coverage": station["model_coverage"],
                "selected": [station["selected"][model_id] for model_id in station["index_models"]],
            }
            for station in ranked
        ],
    }


def build(capture_dir: Path | None, check: bool) -> None:
    if capture_dir is not None:
        capture(capture_dir)
    required = [V1_NORMALIZED, TAISURE_PRICING, TAISURE_STATUS, DEEPSEEK_PRO_SNAPSHOT, DIRECT_API_SNAPSHOT]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Required V2 input is missing:\n  " + "\n  ".join(missing))
    ranked = rank(build_stations())
    if not ranked:
        raise RuntimeError("No stations have comparable Chinese-model prices")
    report = render_report(ranked)
    markdown = render_markdown_evidence(ranked)
    normalized = normalized_output(ranked)
    if check:
        if REPORT.read_text(encoding="utf-8") != report:
            raise RuntimeError("V2 HTML report is not reproducible")
        if MARKDOWN_EVIDENCE.read_text(encoding="utf-8") != markdown:
            raise RuntimeError("V2 Markdown evidence is not reproducible")
        if read_json(NORMALIZED_DATA) != normalized:
            raise RuntimeError("V2 normalized data is not reproducible")
        print(f"verified V2: {len(ranked)} stations and {len(MODEL_ORDER)} Chinese models")
        return
    REPORT.write_text(report, encoding="utf-8")
    MARKDOWN_EVIDENCE.write_text(markdown, encoding="utf-8")
    write_json(NORMALIZED_DATA, normalized)
    print(f"wrote V2: {len(ranked)} stations and {len(MODEL_ORDER)} Chinese models")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", action="store_true")
    parser.add_argument("--capture-dir", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.capture and args.check:
        parser.error("--capture and --check cannot be combined")
    if args.capture and args.capture_dir is None:
        parser.error("--capture requires --capture-dir")
    if args.capture_dir is not None and not args.capture:
        parser.error("--capture-dir requires --capture")
    try:
        build(capture_dir=args.capture_dir if args.capture else None, check=args.check)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
