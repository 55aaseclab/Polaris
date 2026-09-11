#!/usr/bin/env python3
"""Build the dated, auditable API-relay pricing comparison HTML report.

The source pages are intentionally captured into ``site/public/research`` before
the report is rendered.  The report itself never invents a price: every
non-empty matrix cell is assigned an evidence identifier that appears in the
appendix with its source URL, model, channel, and observed input/output quote.

Run from ``docs``:

    python3 scripts/build-api-relay-pricing-report.py --capture
    python3 scripts/build-api-relay-pricing-report.py --check

``--capture --capture-dir <directory>`` reads already-fetched Easywok API
payloads and API Ranking pages from an explicit directory and saves dated audit
snapshots.  Subsequent normal builds only consume files kept in the workspace.
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

from bs4 import BeautifulSoup


REPORT_DATE = "2026-09-08"
USD_TO_CNY = 6.728426
USD_TO_CNY_SOURCE = "https://open.er-api.com/v6/latest/USD"
SOURCE_ROOT = Path(__file__).resolve().parent.parent
RESEARCH_ROOT = SOURCE_ROOT / "site" / "public" / "research"

CA_CANDIDATES = RESEARCH_ROOT / "api-relay-candidates-2026-09-08.json"
CA_OBSERVATIONS = (
    RESEARCH_ROOT / "api-relay-third-party-observations-2026-09-08.json"
)
EASYWOK_PRICING = RESEARCH_ROOT / "easywok-api-pricing-2026-09-08.json"
EASYWOK_STATUS = RESEARCH_ROOT / "easywok-api-status-2026-09-08.json"
API_RANKING_SNAPSHOT = (
    RESEARCH_ROOT / "api-ranking-expansion-price-observations-2026-09-08.json"
)
NORMALIZED_DATA = RESEARCH_ROOT / "api-relay-pricing-normalized-data-2026-09-08.json"
REPORT = RESEARCH_ROOT / "api-relay-pricing-comparison-2026-09-08.html"

CA_HUB = "https://www.china-ai-arbitrage.xyz/zh/api-relays"
NEW_API_PRICE_FORMULA = (
    "https://github.com/QuantumNous/new-api/blob/main/"
    "web/src/features/pricing/lib/price.ts"
)

# These are the 15 upstream/official endpoints present in the third-party
# discovery data.  They are not counted as relay stations in the 100-station
# expansion, even where the directory labels them as one.
OFFICIAL_HOSTS = {
    "api.360.cn",
    "api.anthropic.com",
    "api.deepseek.com",
    "api.minimaxi.com",
    "api.modelarts-maas.com",
    "api.moonshot.cn",
    "api.openai.com",
    "api.ppio.com",
    "api.siliconflow.cn",
    "aiplatform.googleapis.com",
    "ai.gitee.com",
    "ark.cn-beijing.volces.com",
    "dashscope.aliyuncs.com",
    "open.bigmodel.cn",
    "qianfan.baidubce.com",
}

# Exactly 35 additions are deliberately chosen from API Ranking after excluding
# known duplicate identities (LinkAPI, V-API, and Poixe) from its larger list.
# Together with 64 non-official directory candidates and Easywok this yields
# exactly 100 distinct relay identities.
API_RANKING_SPECS = [
    ("uuapi-net", "UU API"),
    ("h-api", "H API"),
    ("linkai", "LinkAI"),
    ("runapi-co", "RunAPI"),
    ("openox", "OpenOx"),
    ("cavoti-ai", "Cavoti AI"),
    ("sssaicode-com", "SSSAICode"),
    ("moacode", "MoaCode"),
    ("a6api", "A6API"),
    ("bytecatcode-org", "ByteCat"),
    ("die-ge", "Die Ge"),
    ("api-bbww-top", "旺旺中转站"),
    ("zivv-pro", "ZIVV"),
    ("open-xiaojingai-com", "xiaojing"),
    ("holysheep-ai", "HolySheep AI"),
    ("byeapi-top", "柏API"),
    ("kuaipao-pro", "Kuaipao API"),
    ("top-api", "Top-API"),
    ("yyapi-cloud", "云影 API"),
    ("yunwu-ai", "云雾AI"),
    ("aixor-org", "AiXor"),
    ("bobdong-cn", "Bob API"),
    ("user-tocodex-com", "ToCodex"),
    ("dawclaudecode-com", "DawCode"),
    ("micuapi-ai", "Micu"),
    ("nekocode-ai", "NekoCode"),
    ("api-aipaibox-com", "AI派"),
    ("kapibala-asia", "卡皮巴拉API"),
    ("ai-codepup-cn", "代码狗"),
    ("api-lmuai-com", "LMU AI · 灵眸"),
    ("deepkey-top", "deepkey"),
    ("36niu-com", "三头牛"),
    ("bearlab-ai", "PRY API"),
    ("portal-gpteamservices-com", "GPTeam"),
    ("right-codes", "RightCode"),
]

PILOT_HOSTS = [
    "easywok",
    "api.linkapi.ai",
    "nexaxis.ai",
    "llm-all.pro",
    "mzlone.top",
    "boxying.com",
    "packyapi.com",
    "api.xcode.best",
    "tian-shu.org",
    "nan.meta-api.vip",
]

MATRIX_MODELS = [
    ("gpt55", "GPT-5.5"),
    ("claudesonnet46", "Claude Sonnet 4.6"),
    ("gemini35flash", "Gemini 3.5 Flash"),
    ("deepseekv4flash", "DeepSeek V4 Flash"),
]

PRICE_RE = re.compile(r"¥\s*([0-9]+(?:\.[0-9]+)?)")
GRADE_RE = re.compile(r"(?:\s|\u00a0)+(?:低|中|高)(?=(?:\s|\u00a0|$))")


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


def model_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", normalized)


def model_label_from_slug(slug: str) -> str:
    known = {
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
        "gpt-5.5": "GPT-5.5",
        "claude-opus-5": "Claude Opus 5",
        "claude-sonnet-5": "Claude Sonnet 5",
        "claude-opus-4.8": "Claude Opus 4.8",
        "claude-opus-4.7": "Claude Opus 4.7",
        "claude-opus-4.6": "Claude Opus 4.6",
        "claude-sonnet-4.6": "Claude Sonnet 4.6",
        "claude-fable-5": "Claude Fable 5",
        "gemini-3.5-flash": "Gemini 3.5 Flash",
        "gemini-3.1-pro-preview": "Gemini 3.1 Pro (Preview)",
        "deepseek-v4-flash": "DeepSeek V4 Flash",
        "deepseek-v4-pro": "DeepSeek V4 Pro",
        "kimi-k3": "Kimi K3",
        "kimi-k2.7-code": "Kimi K2.7 Code",
        "glm-5.2": "GLM-5.2",
        "glm-5.3": "GLM-5.3",
        "minimax-m3": "MiniMax M3",
    }
    if slug in known:
        return known[slug]
    return slug.replace("-", " ").title()


def parse_cny(text: str) -> float | None:
    match = PRICE_RE.search(text)
    return float(match.group(1)) if match else None


def bundle_cost(observation: dict[str, Any]) -> float:
    return float(observation["input_cny"]) + float(observation["output_cny"])


def choose_lowest_by_model(
    observations: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Choose a normal-price route by the 1M-input + 1M-output basket."""

    selected: dict[str, dict[str, Any]] = {}
    for observation in observations:
        if observation["input_cny"] <= 0 or observation["output_cny"] <= 0:
            continue
        key = observation["model_key"]
        incumbent = selected.get(key)
        if incumbent is None or (
            bundle_cost(observation), observation["input_cny"], observation["channel"]
        ) < (
            bundle_cost(incumbent), incumbent["input_cny"], incumbent["channel"]
        ):
            selected[key] = observation
    return selected


def api_ranking_model_title(block: Any) -> str:
    title = block.select_one(".mp-title")
    if title is None:
        return ""
    value = title.get_text(" ", strip=True)
    value = GRADE_RE.sub(" ", value)
    value = re.sub(r"\s+", " ", value).strip()
    # API Ranking's page uses a short display label for this model.  Keep the
    # canonical name aligned with the directory's model detail URL so it can be
    # compared with the other sources without fuzzy matching.
    return "Gemini 3.1 Pro (Preview)" if value == "Gemini 3.1 Pro" else value


def capture_api_ranking(capture_dir: Path) -> list[dict[str, Any]]:
    """Extract minimal listed normal-price routes from pre-fetched pages."""

    captured: list[dict[str, Any]] = []
    missing: list[str] = []
    for slug, station_name in API_RANKING_SPECS:
        source_path = capture_dir / f"apirank-{slug}.html"
        if not source_path.exists():
            missing.append(str(source_path))
            continue
        soup = BeautifulSoup(source_path.read_text(encoding="utf-8"), "html.parser")
        source_url = f"https://apiranking.com/p/{slug}"
        for block in soup.select(".mp-block"):
            label = api_ranking_model_title(block)
            if not label:
                continue
            for row in block.select("tbody tr"):
                cells = row.find_all("td")
                if len(cells) < 4:
                    continue
                input_cny = parse_cny(cells[2].get_text(" ", strip=True))
                output_cny = parse_cny(cells[3].get_text(" ", strip=True))
                if input_cny is None or output_cny is None:
                    continue
                captured.append(
                    {
                        "station_id": f"ar:{slug}",
                        "station": station_name,
                        "website": source_url,
                        "model_key": model_key(label),
                        "model_label": label,
                        "channel": cells[0].get_text(" ", strip=True),
                        "input_cny": input_cny,
                        "output_cny": output_cny,
                        "source_tier": "T3",
                        "source_label": "API Ranking（第三方价格页）",
                        "source_url": source_url,
                        "source_detail": (
                            f"{label}；渠道 {cells[0].get_text(' ', strip=True)}；"
                            "页面标示单位为 ¥/1M tokens。"
                        ),
                        "native_price": (
                            f"¥{input_cny:g} / ¥{output_cny:g}（输入 / 输出）"
                        ),
                    }
                )
    if missing:
        raise RuntimeError(
            "Missing pre-fetched API Ranking pages for --capture:\n  "
            + "\n  ".join(missing)
        )
    return captured


def capture_easywok(capture_dir: Path) -> None:
    """Copy validated JSON payloads fetched from Easywok into the audit set."""

    source_paths = {
        EASYWOK_PRICING: capture_dir / "easy-pricing.json",
        EASYWOK_STATUS: capture_dir / "easy-status.json",
    }
    missing = [str(source) for source in source_paths.values() if not source.exists()]
    if missing:
        raise RuntimeError(
            "Missing pre-fetched Easywok API payload for --capture:\n  "
            + "\n  ".join(missing)
        )
    pricing = read_json(source_paths[EASYWOK_PRICING])
    status = read_json(source_paths[EASYWOK_STATUS])
    if not pricing.get("success") or not status.get("data"):
        raise RuntimeError("Easywok capture did not contain a successful pricing/status payload")
    write_json(EASYWOK_PRICING, pricing)
    write_json(EASYWOK_STATUS, status)


def build_easywok_station() -> dict[str, Any]:
    pricing = read_json(EASYWOK_PRICING)
    status = read_json(EASYWOK_STATUS)
    status_data = status["data"]
    display_type = status_data.get("quota_display_type")
    if display_type != "USD":
        raise RuntimeError(f"Unexpected Easywok display currency: {display_type}")
    groups = pricing.get("group_ratio", {})
    by_name = {item["model_name"]: item for item in pricing.get("data", [])}
    observations: list[dict[str, Any]] = []
    for model_name, label in (
        ("gpt-5.5", "GPT-5.5"),
        ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    ):
        item = by_name.get(model_name)
        if item is None:
            continue
        group = "MIX分组" if "MIX分组" in item.get("enable_groups", []) else item["enable_groups"][0]
        group_ratio = float(groups.get(group, 1))
        input_usd = float(item["model_ratio"]) * 2 * group_ratio
        output_usd = input_usd * float(item["completion_ratio"])
        observations.append(
            {
                "station_id": "easywok",
                "station": "Easywok",
                "website": "https://ai.easywok.net/keys",
                "model_key": model_key(label),
                "model_label": label,
                "channel": group,
                "input_cny": input_usd * USD_TO_CNY,
                "output_cny": output_usd * USD_TO_CNY,
                "source_tier": "T1",
                "source_label": "Easywok 公开 API",
                "source_url": "https://ai.easywok.net/api/pricing",
                "source_url_2": "https://ai.easywok.net/api/status",
                "source_detail": (
                    f"model_ratio={item['model_ratio']}，completion_ratio="
                    f"{item['completion_ratio']}，分组 {group} ratio={group_ratio}；"
                    f"/api/status 显示 USD。按公开前端公式 ratio × 2 × group "
                    f"计算，随后以 1 USD = ¥{USD_TO_CNY:.6f} 归一化。"
                ),
                "native_price": f"${input_usd:g} / ${output_usd:g}（输入 / 输出）",
                "formula_source": NEW_API_PRICE_FORMULA,
            }
        )
    if len(observations) != 2:
        raise RuntimeError("Easywok snapshot lacks one of the two canonical models")
    return {
        "id": "easywok",
        "name": "Easywok",
        "website": "https://ai.easywok.net/keys",
        "tier": "T1",
        "source": "公开 /api/pricing + /api/status",
        "observations": observations,
    }


def build_ca_stations() -> list[dict[str, Any]]:
    candidates = read_json(CA_CANDIDATES)
    observations = read_json(CA_OBSERVATIONS)
    retained = [candidate for candidate in candidates if candidate["host"] not in OFFICIAL_HOSTS]
    if len(retained) != 64:
        raise RuntimeError(f"Expected 64 non-official directory candidates, got {len(retained)}")
    by_host: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in observations:
        if record["host"] in OFFICIAL_HOSTS:
            continue
        input_cny = parse_cny(record["input_text"])
        output_cny = parse_cny(record["output_text"])
        if input_cny is None or output_cny is None:
            continue
        slug = record["model_slug"]
        label = model_label_from_slug(slug)
        by_host[record["host"]].append(
            {
                "station_id": f"ca:{record['host']}",
                "station": record["station"],
                "website": record["website"],
                "model_key": model_key(label),
                "model_label": label,
                "channel": record["channel"],
                "input_cny": input_cny,
                "output_cny": output_cny,
                "source_tier": "T2",
                "source_label": "AI 比价实时线路观察（第三方）",
                "source_url": record["comparison_url"],
                "source_detail": (
                    f"{label}；{record['station']}；渠道 {record['channel']}；"
                    f"评级 {record['rating']}；读取公开表中的挂牌输入 / 输出价格，"
                    "未采用“充值后折合”字样后的促销价。"
                ),
                "native_price": f"¥{input_cny:g} / ¥{output_cny:g}（输入 / 输出）",
            }
        )
    stations: list[dict[str, Any]] = []
    for candidate in retained:
        host = candidate["host"]
        station_observations = by_host.get(host, [])
        if not station_observations:
            raise RuntimeError(f"No usable observation for retained candidate {host}")
        stations.append(
            {
                "id": f"ca:{host}",
                "name": candidate["station"],
                "website": candidate["website"],
                "tier": "T2",
                "source": "AI 比价第三方线路表",
                "observations": station_observations,
            }
        )
    return stations


def build_api_ranking_stations() -> list[dict[str, Any]]:
    observations = read_json(API_RANKING_SNAPSHOT)
    by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    meta: dict[str, dict[str, str]] = {}
    for observation in observations:
        by_id[observation["station_id"]].append(observation)
        meta[observation["station_id"]] = {
            "name": observation["station"],
            "website": observation["website"],
        }
    expected = {f"ar:{slug}" for slug, _ in API_RANKING_SPECS}
    if set(by_id) != expected:
        missing = expected - set(by_id)
        unexpected = set(by_id) - expected
        raise RuntimeError(f"API Ranking snapshot mismatch; missing={missing}, unexpected={unexpected}")
    return [
        {
            "id": station_id,
            "name": meta[station_id]["name"],
            "website": meta[station_id]["website"],
            "tier": "T3",
            "source": "API Ranking 第三方价格页",
            "observations": by_id[station_id],
        }
        for station_id in sorted(by_id)
    ]


def make_station_views(stations: list[dict[str, Any]]) -> None:
    for station in stations:
        station["selected"] = choose_lowest_by_model(station["observations"])
        if not station["selected"]:
            raise RuntimeError(f"Station without a positive listed quote: {station['name']}")


def compute_indices(stations: list[dict[str, Any]]) -> None:
    values_by_model: dict[str, list[float]] = defaultdict(list)
    labels: dict[str, str] = {}
    for station in stations:
        for key, observation in station["selected"].items():
            values_by_model[key].append(bundle_cost(observation))
            labels.setdefault(key, observation["model_label"])
    medians = {
        key: statistics.median(values)
        for key, values in values_by_model.items()
        if len(values) >= 3
    }
    for station in stations:
        ratios = []
        used = []
        for key, observation in station["selected"].items():
            median = medians.get(key)
            if median is None:
                continue
            ratios.append(bundle_cost(observation) / median)
            used.append(key)
        station["index_models"] = used
        station["index_coverage"] = len(used)
        station["matrix_coverage"] = sum(
            1 for key, _ in MATRIX_MODELS if key in station["selected"]
        )
        station["price_index"] = 100 * math.exp(sum(map(math.log, ratios)) / len(ratios))
        station["ranking_group"] = "稳健" if len(used) >= 4 else "探索性"
    # Persist a minimal view for auditability and later recomputation.
    for station in stations:
        station["index_model_labels"] = [labels[key] for key in station["index_models"]]


def attach_evidence(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for station in sorted(stations, key=lambda item: (item["name"].lower(), item["id"])):
        for observation in sorted(
            station["selected"].values(),
            key=lambda item: (item["model_label"].lower(), item["channel"]),
        ):
            observation["evidence_id"] = len(evidence) + 1
            evidence.append(observation)
    return evidence


def price_cell(station: dict[str, Any], key: str) -> str:
    observation = station["selected"].get(key)
    if observation is None:
        return '<span class="missing">—</span>'
    evidence_id = observation["evidence_id"]
    return (
        '<span class="price-value">'
        f"¥{observation['input_cny']:.2f} / ¥{observation['output_cny']:.2f}"
        "</span>"
        f'<a class="evidence-ref" href="#e-{evidence_id}" title="查看价格证据">'
        f"E{evidence_id}</a>"
        f'<span class="channel">{esc(observation["channel"])}</span>'
    )


def matrix_html(title: str, stations: list[dict[str, Any]], table_id: str) -> str:
    header = [
        '<th class="sticky model-column" scope="col">模型</th>',
    ]
    for station in stations:
        pinned = '<span class="pin">置顶</span>' if station["id"] == "easywok" else ""
        header.append(
            '<th class="station-column" scope="col">'
            f'<a href="#station-{esc(station["id"])}">{esc(station["name"])}</a>{pinned}'
            f'<span class="tier {station["tier"].lower()}">{station["tier"]}</span>'
            "</th>"
        )
    rows = []
    for key, label in MATRIX_MODELS:
        cells = [f'<th class="sticky model-column" scope="row">{esc(label)}</th>']
        cells.extend(f"<td>{price_cell(station, key)}</td>" for station in stations)
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return (
        f'<section class="panel" id="{table_id}">'
        f"<h2>{esc(title)}</h2>"
        '<p class="subtle">单元格格式为 <code>输入 / 输出</code>；均为 '
        '人民币、每百万 tokens。每一个非空价格后的 E 编号都跳至证据附录。</p>'
        '<div class="table-scroll matrix-scroll"><table class="matrix">'
        f"<thead><tr>{''.join(header)}</tr></thead><tbody>{''.join(rows)}</tbody>"
        "</table></div></section>"
    )


def source_badge(tier: str) -> str:
    return f'<span class="tier {tier.lower()}">{tier}</span>'


def ranked_stations(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranking = sorted(
        stations,
        key=lambda item: (
            item["ranking_group"] != "稳健",
            item["price_index"],
            -item["index_coverage"],
            item["name"].lower(),
        ),
    )
    for rank, station in enumerate(ranking, start=1):
        station["market_rank"] = rank
    return ranking


def index_table_html(stations: list[dict[str, Any]]) -> str:
    ranking = ranked_stations(stations)
    easywok = next(station for station in stations if station["id"] == "easywok")
    display = [easywok] + [station for station in ranking if station["id"] != "easywok"]
    rows = []
    for position, station in enumerate(display, start=1):
        pinned = " <span class=\"pin\">固定首位</span>" if station["id"] == "easywok" else ""
        first_evidence = min(
            station["selected"].values(), key=lambda item: item["evidence_id"]
        )
        source = (
            f'<a href="{esc(first_evidence["source_url"])}" target="_blank" rel="noreferrer">'
            f"{esc(station['source'])}</a>"
        )
        rows.append(
            "<tr"
            + (" class=\"pinned-row\"" if station["id"] == "easywok" else "")
            + ">"
            f"<td>{position}</td>"
            f"<td id=\"station-{esc(station['id'])}\"><strong>"
            f'<a href="{esc(station["website"])}" target="_blank" rel="noreferrer">'
            f"{esc(station['name'])}</a></strong>{pinned}</td>"
            f"<td>{station['market_rank']}</td>"
            f"<td>{station['price_index']:.2f}</td>"
            f"<td>{station['ranking_group']} · {station['index_coverage']} 模型</td>"
            f"<td>{station['matrix_coverage']}/4</td>"
            f"<td>{source_badge(station['tier'])} {source}</td>"
            f"<td><a href=\"#station-evidence-{esc(station['id'])}\">"
            f"{len(station['selected'])} 条</a></td>"
            "</tr>"
        )
    return (
        '<section class="panel" id="index"><h2>100 站价格指数与排序</h2>'
        '<p class="subtle">指数以每个同名模型的样本中位数为 100；'
        '每站对其可用的同名模型取 <code>1M 输入 + 1M 输出</code>价格相对中位数的几何平均。'
        '数值越低代表公开挂牌价更低。覆盖少于 4 个模型的站点标为“探索性”，'
        '排序时先列“稳健”组、组内再按指数升序。Easywok 依要求固定在第一行，'
        '其真实市场排序另列显示。</p>'
        '<div class="table-scroll"><table class="index-table"><thead><tr>'
        '<th>展示序</th><th>中转站</th><th>市场排序</th><th>价格指数 ↓</th>'
        '<th>指数覆盖</th><th>四模型覆盖</th><th>主要证据</th><th>证据</th>'
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table></div></section>"
    )


def station_evidence_html(stations: list[dict[str, Any]]) -> str:
    groups = []
    for station in sorted(stations, key=lambda item: item["market_rank"]):
        refs = []
        for observation in sorted(
            station["selected"].values(), key=lambda item: item["evidence_id"]
        ):
            refs.append(
                f'<a href="#e-{observation["evidence_id"]}">E{observation["evidence_id"]}'
                f" · {esc(observation['model_label'])}</a>"
            )
        groups.append(
            f'<details id="station-evidence-{esc(station["id"])}">'
            f"<summary><strong>{esc(station['name'])}</strong>：{len(refs)} 个计入指数的模型报价</summary>"
            f"<p>{' · '.join(refs)}</p></details>"
        )
    return (
        '<section class="panel" id="station-evidence"><h2>按站点展开的指数证据</h2>'
        '<p class="subtle">此处列出每一站计入指数的同名模型报价。点击编号查看其'
        '原始来源、渠道、币种与计算说明。</p>'
        f"<div class=\"details-grid\">{''.join(groups)}</div></section>"
    )


def evidence_table_html(evidence: list[dict[str, Any]]) -> str:
    rows = []
    for observation in evidence:
        second_link = ""
        if observation.get("source_url_2"):
            second_link = (
                '；<a href="'
                + esc(observation["source_url_2"])
                + '" target="_blank" rel="noreferrer">币种状态</a>'
            )
        formula_link = ""
        if observation.get("formula_source"):
            formula_link = (
                '；<a href="'
                + esc(observation["formula_source"])
                + '" target="_blank" rel="noreferrer">计算公式</a>'
            )
        rows.append(
            f'<tr id="e-{observation["evidence_id"]}">'
            f"<td>E{observation['evidence_id']}</td>"
            f"<td>{esc(observation['station'])}</td>"
            f"<td>{esc(observation['model_label'])}</td>"
            f"<td>{esc(observation['channel'])}</td>"
            f"<td>{esc(observation['native_price'])}</td>"
            f"<td>¥{observation['input_cny']:.2f} / ¥{observation['output_cny']:.2f}</td>"
            f"<td>{source_badge(observation['source_tier'])} "
            f'<a href="{esc(observation["source_url"])}" target="_blank" rel="noreferrer">'
            f"{esc(observation['source_label'])}</a>{second_link}{formula_link}<br>"
            f"<span class=\"subtle\">{esc(observation['source_detail'])}</span></td>"
            "</tr>"
        )
    return (
        '<section class="panel" id="evidence"><h2>价格证据附录</h2>'
        '<p class="subtle">E 编号既是矩阵单元的脚注，也是指数的逐项审计记录。'
        'T1 为站点公开 API；T2、T3 为第三方公开比较页，不能替代下单前的站点核对。</p>'
        '<div class="table-scroll evidence-scroll"><table class="evidence-table"><thead><tr>'
        '<th>证据</th><th>站点</th><th>模型</th><th>渠道 / 分组</th><th>原币种报价</th>'
        '<th>矩阵报价（CNY）</th><th>来源与说明</th>'
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table></div></section>"
    )


def search_terms_html() -> str:
    terms = [
        '"API中转站" "价格"',
        '"API中转站" "模型价格"',
        '"API中转站" "价格表"',
        "API中转站 价格表 Claude GPT Gemini",
        "API中转站 模型价格 OpenAI Claude Gemini 价格",
        "OpenAI API 中转站 价格",
        "Claude API 中转 价格",
        "GPT API 中转 价格",
        "API 中转站 模型价格 OpenAI Claude Gemini 价格",
        "AI API relay pricing China Claude GPT Gemini",
        "GPT API relay pricing China",
        "site:linux.do API 中转 价格",
        'site:github.com "API中转" "价格"',
        'site:github.com "API中转站" "价格"',
        "大模型 API 聚合平台 价格",
        "OpenAI API relay pricing provider",
    ]
    return "".join(f"<li><code>{esc(term)}</code></li>" for term in terms)


def render_detailed_report(stations: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> str:
    by_id = {station["id"]: station for station in stations}
    pilot = [by_id[f"ca:{host}"] if host != "easywok" else by_id[host] for host in PILOT_HOSTS]
    ranking = sorted(
        stations,
        key=lambda item: (
            item["ranking_group"] != "稳健",
            item["price_index"],
            -item["index_coverage"],
            item["name"].lower(),
        ),
    )
    easywok = by_id["easywok"]
    expanded_columns = [easywok] + [station for station in ranking if station["id"] != "easywok"]
    ca_count = sum(station["tier"] == "T2" for station in stations)
    ar_count = sum(station["tier"] == "T3" for station in stations)
    source_counts = {tier: sum(station["tier"] == tier for station in stations) for tier in ("T1", "T2", "T3")}
    html_body = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="2026-09-08 API 中转站价格证据比较：Easywok 置顶、10站先导、100站扩展与可审计价格指数。">
  <title>API 中转站价格比较（{REPORT_DATE}）</title>
  <style>
    :root {{
      color-scheme: light;
      --ink: #17202a;
      --muted: #687580;
      --paper: #fffdf7;
      --canvas: #f2f4ef;
      --line: #d8ded7;
      --accent: #0c6b58;
      --accent-soft: #dff4eb;
      --gold: #b7791f;
      --red: #b6403c;
      --blue: #245b9c;
      --shadow: 0 18px 50px rgba(27, 42, 34, .10);
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 20% -15%, #d6efe3 0, transparent 30rem),
        radial-gradient(circle at 95% 5%, #f3e4bd 0, transparent 28rem),
        var(--canvas);
      font: 15px/1.58 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
    }}
    a {{ color: #075e4d; text-decoration-color: #8dbeb2; text-underline-offset: 2px; }}
    a:hover {{ color: #043f34; }}
    code {{
      padding: .08rem .35rem;
      border-radius: .28rem;
      background: #edf1ed;
      color: #38453e;
      font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }}
    .page {{ width: min(1780px, calc(100% - 32px)); margin: 0 auto 80px; }}
    .hero {{ padding: 56px 0 30px; max-width: 1040px; }}
    .eyebrow {{
      margin: 0 0 12px;
      color: var(--accent);
      font-size: .78rem;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }}
    h1 {{ margin: 0; font-size: clamp(2rem, 5vw, 4.2rem); line-height: 1.04; letter-spacing: -.05em; }}
    h2 {{ margin: 0 0 10px; font-size: clamp(1.25rem, 2vw, 1.75rem); letter-spacing: -.025em; }}
    h3 {{ margin: 22px 0 8px; font-size: 1.05rem; }}
    p {{ margin: 8px 0; }}
    .lede {{ max-width: 875px; margin-top: 18px; color: #405047; font-size: 1.08rem; }}
    .meta {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }}
    .meta span, .tier, .pin {{
      display: inline-block;
      padding: .17rem .52rem;
      border-radius: 999px;
      font-size: .75rem;
      font-weight: 750;
      letter-spacing: .015em;
      white-space: nowrap;
    }}
    .meta span {{ border: 1px solid #b9c9bc; background: rgba(255,255,255,.63); }}
    .tier {{ margin-top: 4px; color: #fff; background: #687580; }}
    .tier.t1 {{ background: var(--accent); }}
    .tier.t2 {{ background: var(--blue); }}
    .tier.t3 {{ background: var(--gold); }}
    .pin {{ margin-left: 5px; color: #5b3a00; background: #ffe5a8; }}
    .toc {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0 26px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,.68);
    }}
    .toc a {{ padding: .26rem .48rem; font-weight: 650; text-decoration: none; }}
    .facts {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0 26px; }}
    .fact, .panel {{ border: 1px solid var(--line); background: rgba(255,253,247,.92); box-shadow: var(--shadow); }}
    .fact {{ padding: 16px; border-radius: 14px; }}
    .fact b {{ display: block; margin-bottom: 3px; color: var(--accent); font-size: 1.65rem; line-height: 1; }}
    .fact span {{ color: var(--muted); font-size: .88rem; }}
    .panel {{ margin: 18px 0; padding: 22px; border-radius: 18px; overflow: hidden; }}
    .panel.critical {{ border-left: 5px solid var(--gold); }}
    .subtle {{ color: var(--muted); font-size: .91rem; }}
    .warning {{ color: #6d3f0b; background: #fff2cf; border: 1px solid #edcf86; border-radius: 10px; padding: 11px 13px; }}
    .two-col {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }}
    ul, ol {{ margin: 8px 0; padding-left: 1.25rem; }}
    li {{ margin: 4px 0; }}
    .table-scroll {{ overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: #fff; }}
    table {{ border-collapse: separate; border-spacing: 0; width: 100%; font-size: .84rem; }}
    th, td {{ padding: 9px 10px; border-bottom: 1px solid #e5e9e4; border-right: 1px solid #edf0ec; vertical-align: top; text-align: left; }}
    thead th {{ position: sticky; top: 0; z-index: 3; background: #e8efe8; color: #294136; font-weight: 800; }}
    tbody tr:nth-child(even) td, tbody tr:nth-child(even) th {{ background: #fcfdfa; }}
    tbody tr:hover td, tbody tr:hover th {{ background: #f3faf6; }}
    .matrix {{ min-width: max-content; }}
    .matrix .station-column {{ min-width: 142px; max-width: 180px; white-space: normal; }}
    .matrix .station-column a {{ font-weight: 800; text-decoration: none; }}
    .sticky {{ position: sticky; left: 0; z-index: 2; }}
    thead .sticky {{ z-index: 5; background: #dce9dd; }}
    .model-column {{ min-width: 170px; background: #f7faf5; font-weight: 800; }}
    .price-value {{ display: block; color: #142d24; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }}
    .channel {{ display: block; max-width: 150px; margin-top: 4px; color: var(--muted); font-size: .72rem; line-height: 1.25; overflow-wrap: anywhere; }}
    .evidence-ref {{ margin-left: 5px; color: #b6403c; font-size: .74rem; font-weight: 850; text-decoration: none; }}
    .missing {{ color: #9aa39d; }}
    .index-table {{ min-width: 1050px; }}
    .index-table td:nth-child(1), .index-table td:nth-child(3), .index-table td:nth-child(4), .index-table td:nth-child(5), .index-table td:nth-child(6) {{ font-variant-numeric: tabular-nums; white-space: nowrap; }}
    .pinned-row td {{ background: #fff7d8 !important; }}
    .evidence-table {{ min-width: 1250px; font-size: .78rem; }}
    .evidence-table td:nth-child(1), .evidence-table td:nth-child(5), .evidence-table td:nth-child(6) {{ white-space: nowrap; font-variant-numeric: tabular-nums; }}
    details {{ border: 1px solid #dce5dc; border-radius: 9px; background: #fbfdf9; padding: 8px 10px; }}
    summary {{ cursor: pointer; color: #244d3e; }}
    .details-grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }}
    .details-grid p {{ margin: 8px 0 2px; font-size: .84rem; }}
    .details-grid a {{ margin-right: 4px; }}
    .search-terms {{ columns: 2; column-gap: 30px; }}
    .footer {{ margin-top: 28px; color: var(--muted); font-size: .84rem; }}
    @media (max-width: 880px) {{
      .page {{ width: min(100% - 20px, 1780px); }}
      .hero {{ padding-top: 32px; }}
      .facts, .two-col, .details-grid {{ grid-template-columns: 1fr; }}
      .panel {{ padding: 16px; border-radius: 14px; }}
      .search-terms {{ columns: 1; }}
    }}
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">可审计的公开价格快照 · API Relay Pricing</p>
      <h1>API 中转站价格比较<br>Easywok 置顶，扩展至 100 站</h1>
      <p class="lede">这是一个日期固定为 {REPORT_DATE} 的公开报价比较，而非可用性或模型真实性背书。
      所有比较都以同名模型、每百万 tokens、输入 / 输出分列处理；任何显示出来的价格单元都带有可点击的 E 证据脚注。</p>
      <div class="meta">
        <span>采集日：{REPORT_DATE}</span>
        <span>归一化货币：CNY</span>
        <span>USD/CNY：{USD_TO_CNY:.6f}</span>
        <span>Easywok：固定首列 / 首行</span>
        <span>100 个非官方中转身份</span>
      </div>
    </header>

    <nav class="toc" aria-label="本报告目录">
      <a href="#scope">口径</a><a href="#pilot">10 站先导</a><a href="#reflection">复盘与扩展</a>
      <a href="#expanded">100 站矩阵</a><a href="#index">价格指数</a><a href="#sources">来源等级</a>
      <a href="#station-evidence">指数证据</a><a href="#evidence">价格附录</a><a href="#search">搜索关键词</a>
    </nav>

    <section class="facts" aria-label="研究规模">
      <div class="fact"><b>10</b><span>先导比较站点；Easywok 固定第一列</span></div>
      <div class="fact"><b>100</b><span>扩展后的非官方中转身份</span></div>
      <div class="fact"><b>{len(evidence)}</b><span>计入指数的可审计模型报价</span></div>
      <div class="fact"><b>T1/T2/T3</b><span>{source_counts['T1']} / {source_counts['T2']} / {source_counts['T3']} 站来源层级</span></div>
    </section>

    <section class="panel critical" id="scope">
      <h2>口径、边界与如何读表</h2>
      <div class="two-col">
        <div>
          <h3>价格口径</h3>
          <ul>
            <li>矩阵单元是同一渠道的 <strong>输入 / 输出</strong>公开挂牌价，单位为 <strong>¥/1M tokens</strong>。</li>
            <li>同一站同一模型有多个渠道时，选择 <strong>1M 输入 + 1M 输出</strong>合计最低的可见渠道；不把“充值后折合”促销价混入常规挂牌价。</li>
            <li>Easywok 原生显示为 USD，使用 <a href="{USD_TO_CNY_SOURCE}" target="_blank" rel="noreferrer">{USD_TO_CNY_SOURCE}</a> 的 {REPORT_DATE} 参考汇率换算为 CNY。其他当前矩阵报价原本以 ¥ 显示。</li>
          </ul>
        </div>
        <div>
          <h3>不能从价格推断的事情</h3>
          <ul>
            <li>低价不等于模型真实、稳定、可退款、数据不留存或符合原厂条款。</li>
            <li>渠道名可能表示订阅号池、反向、官方直连或不同路由；本报告不将其视为同等服务等级。</li>
            <li>价格会随分组、充值门槛、活动、时段和模型别名变化。付款前应再次打开 E 链接核对。</li>
          </ul>
        </div>
      </div>
      <p class="warning">建议：敏感数据、生产工作负载和受合规约束的请求不要仅以本表的低价作决策。价格指数只量化报价，不量化风险。</p>
    </section>

    {matrix_html("10 站先导比较", pilot, "pilot")}

    <section class="panel" id="reflection">
      <h2>先完成 10 站后的复盘，再扩展至 100 站</h2>
      <div class="two-col">
        <div>
          <h3>先导阶段验证到的有效方法</h3>
          <ol>
            <li>Easywok 的公开 <code>/api/pricing</code> 与 <code>/api/status</code> 可提供原始模型倍率、分组倍率和显示币种；其计算过程因此可复算。</li>
            <li>公开比较页可以发现同名模型、站点和分组，适合覆盖多个中转身份，但只应作为次级证据。</li>
            <li>输入与输出必须并列。只比较输入价会系统性误导高输出模型的成本。</li>
          </ol>
        </div>
        <div>
          <h3>扩展时修正的风险</h3>
          <ol>
            <li>不把目录中指向 OpenAI、Anthropic、Google 等的 <strong>15 个官方上游端点</strong>计入“中转站”数量。</li>
            <li>不因模型别名相近而强行补价；四模型矩阵没有精确同名报价时显示 <strong>—</strong>。</li>
            <li>不以单一模型给完整站点下结论；指数表显示覆盖模型数，少于 4 个模型时降为“探索性”。</li>
          </ol>
        </div>
      </div>
      <p>扩展构成：从第三方线路目录保留 {ca_count} 个非官方身份，加入 Easywok 1 个，再加入 API Ranking 的 {ar_count} 个未与前者重复的身份，合计 <strong>{len(stations)}</strong>。原始目录观察与提取后的价格快照均附在本目录中。</p>
    </section>

    {matrix_html("100 站扩展矩阵：四个精确同名的共同模型", expanded_columns, "expanded")}

    {index_table_html(stations)}

    <section class="panel" id="sources">
      <h2>来源等级与可复现材料</h2>
      <div class="two-col">
        <div>
          <h3>证据等级</h3>
          <ul>
            <li><strong>T1</strong>：站点公开 API。这里只有 Easywok，且可查看 <a href="https://ai.easywok.net/api/pricing" target="_blank" rel="noreferrer">pricing</a>、<a href="https://ai.easywok.net/api/status" target="_blank" rel="noreferrer">status</a> 与 <a href="{NEW_API_PRICE_FORMULA}" target="_blank" rel="noreferrer">前端公式</a>。</li>
            <li><strong>T2</strong>：<a href="{CA_HUB}" target="_blank" rel="noreferrer">AI 比价</a>公开的模型线路比较表；用于 64 个候选，报告将其标为第三方观测。</li>
            <li><strong>T3</strong>：<a href="https://apiranking.com/" target="_blank" rel="noreferrer">API Ranking</a>公开价格页；用于扩展身份，亦仅作第三方观测。</li>
          </ul>
        </div>
        <div>
          <h3>本地快照</h3>
          <ul>
            <li><a href="easywok-api-pricing-2026-09-08.json">Easywok pricing 快照</a> 与 <a href="easywok-api-status-2026-09-08.json">status 快照</a></li>
            <li><a href="api-relay-candidates-2026-09-08.json">第三方目录候选（原始 79 个 endpoint 身份）</a></li>
            <li><a href="api-relay-third-party-observations-2026-09-08.json">第三方线路原始观测（2,428 条）</a></li>
            <li><a href="api-ranking-expansion-price-observations-2026-09-08.json">API Ranking 扩展报价快照</a></li>
            <li><a href="api-relay-pricing-normalized-data-2026-09-08.json">本报告的归一化价格与指数输入</a></li>
          </ul>
        </div>
      </div>
    </section>

    {station_evidence_html(stations)}
    {evidence_table_html(evidence)}

    <section class="panel" id="search">
      <h2>实际使用的搜索关键词</h2>
      <p class="subtle">关键词用于发现候选和比较页面；价格结论只使用本报告中列出的 T1/T2/T3 证据源。检索时使用了 Brave Search、DuckDuckGo、Bing、Google 及站点内公开页面；部分搜索引擎对自动请求给出挑战或泛化结果，未将搜索摘要当作价格证据。</p>
      <ul class="search-terms">{search_terms_html()}</ul>
    </section>

    <p class="footer">生成日期：{REPORT_DATE}。此文件是一次可审计的价格快照；不构成购买建议、服务质量承诺或对任何中转站的安全背书。</p>
  </main>
</body>
</html>
"""
    return html_body


def render_report(stations: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> str:
    return render_detailed_report(stations, evidence)


def normalized_output(stations: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "report_date": REPORT_DATE,
        "currency": "CNY",
        "usd_to_cny": USD_TO_CNY,
        "method": {
            "matrix": "same exact model; lowest listed channel by 1M input + 1M output basket",
            "index": "per-model median = 100; geometric mean across listed exact-model baskets",
            "promotion_policy": "recharge-equivalent promotional text excluded",
        },
        "stations": [
            {
                "id": station["id"],
                "name": station["name"],
                "website": station["website"],
                "tier": station["tier"],
                "price_index": round(station["price_index"], 8),
                "index_coverage": station["index_coverage"],
                "matrix_coverage": station["matrix_coverage"],
                "market_rank": station.get("market_rank"),
                "selected": list(station["selected"].values()),
            }
            for station in stations
        ],
        "evidence_count": len(evidence),
    }


def build(capture: bool, check: bool, capture_dir: Path | None) -> None:
    if capture:
        if capture_dir is None:
            raise RuntimeError("--capture requires --capture-dir")
        capture_easywok(capture_dir)
        write_json(API_RANKING_SNAPSHOT, capture_api_ranking(capture_dir))
    required = [CA_CANDIDATES, CA_OBSERVATIONS, EASYWOK_PRICING, EASYWOK_STATUS, API_RANKING_SNAPSHOT]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Required audit input is missing:\n  " + "\n  ".join(missing))
    stations = [build_easywok_station(), *build_ca_stations(), *build_api_ranking_stations()]
    if len(stations) != 100:
        raise RuntimeError(f"Expected exactly 100 relay identities, got {len(stations)}")
    station_ids = [station["id"] for station in stations]
    if len(station_ids) != len(set(station_ids)):
        raise RuntimeError("Station identity collision")
    make_station_views(stations)
    compute_indices(stations)
    evidence = attach_evidence(stations)
    if any(station["price_index"] <= 0 for station in stations):
        raise RuntimeError("Non-positive price index")
    report = render_report(stations, evidence)
    normalized = normalized_output(stations, evidence)
    if check:
        if not REPORT.exists() or not NORMALIZED_DATA.exists():
            raise RuntimeError("Generated report or normalized data is missing")
        if REPORT.read_text(encoding="utf-8") != report:
            raise RuntimeError("HTML report is not reproducible; rebuild it")
        if read_json(NORMALIZED_DATA) != normalized:
            raise RuntimeError("Normalized data is not reproducible; rebuild it")
        print(
            f"verified {len(stations)} stations, {len(evidence)} evidence rows, "
            f"and {len(MATRIX_MODELS)} matrix models"
        )
        return
    REPORT.write_text(report, encoding="utf-8")
    write_json(NORMALIZED_DATA, normalized)
    print(
        f"wrote {REPORT.relative_to(SOURCE_ROOT)} and "
        f"{NORMALIZED_DATA.relative_to(SOURCE_ROOT)} "
        f"({len(stations)} stations, {len(evidence)} evidence rows)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--capture",
        action="store_true",
        help="capture pre-fetched Easywok/API Ranking evidence into dated audit snapshots",
    )
    parser.add_argument(
        "--capture-dir",
        type=Path,
        help="directory containing easy-pricing.json, easy-status.json, and apirank-<slug>.html files",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed/generated output is deterministic and complete",
    )
    args = parser.parse_args()
    if args.capture and args.check:
        parser.error("--capture and --check cannot be combined")
    if args.capture_dir and not args.capture:
        parser.error("--capture-dir requires --capture")
    try:
        build(capture=args.capture, check=args.check, capture_dir=args.capture_dir)
    except Exception as error:  # Keep CI-friendly failures concise.
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
