#!/usr/bin/env python3
"""Mine a normalized XHS post corpus into cited startup/investor knowledge.

The miner deliberately separates three layers:

1. verbatim source statements and their locators;
2. conditional mechanisms inferred from repeated concepts; and
3. a bounded two-agent simulation contract.

That separation prevents a popular opinion in a comment thread from silently
becoming a financial, legal, or empirical fact.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ad_content.startup_investor_simulation import (
    KNOWLEDGE_RULES,
    compare_strategies,
    monte_carlo,
    rules_as_knowledge_nodes,
)


KNOWLEDGE_SCHEMA = "clue.startup-investor.knowledge.v1"
SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;])\s*|\n+")


# A phrase may activate more than one mechanism.  The taxonomy intentionally
# uses source-language terms instead of a generic finance ontology so every
# category can be inspected against captured evidence.
TOPIC_PATTERNS: dict[str, tuple[str, ...]] = {
    "actors_founders": ("创始人", "创业者", "创业团队", "创始团队", "博主"),
    "actors_investors": ("投资人", "投资", "天使轮", "基金", "国资", "个人投资"),
    "milestones": ("0—1", "0-1", "跑通", "数据", "验证", "收入", "商业模式", "demo", "结果"),
    "market_upside": ("蓝海", "想象空间", "市场", "硬科技", "项目", "增长"),
    "equity_and_valuation": ("股权", "股份", "稀释", "估值", "融资", "投钱", "回本"),
    "debt_and_interest": ("贷款", "借款", "债", "利息", "银行", "负债", "放贷", "高利贷"),
    "risk_allocation": ("风险", "对赌", "回购", "兜底", "连带责任", "保证", "无限"),
    "diligence_and_fraud": (
        "PPT",
        "吹牛",
        "接盘",
        "靠谱",
        "尽调",
        "骗子",
        "能力",
        "老东家",
        "职业创业人",
        "眼界",
        "不理解",
    ),
    "competition_and_bargaining": ("抢", "抢的人多", "钱来找", "谈对赌", "估值都没关系"),
    "returns_and_profitability": ("年化", "回报", "利润率", "利润", "回本", "收益"),
    "policy_and_subsidy": ("补贴", "国资", "硬科技", "政策"),
    "capital_availability": ("没有投资", "融资难", "资本", "私募"),
    "trust_and_fairness": (
        "当**",
        "不公平",
        "伯乐",
        "晴天借伞",
        "雨天收",
        "脑袋有瘤",
        "信任",
        "双赢",
        "互相骗",
        "良性循环",
        "撤梯子",
        "好处",
    ),
    "capital_intensity": (
        "砸钱",
        "烧钱",
        "几十万",
        "几百万",
        "几千万",
        "一两百万",
        "资金",
        "身家",
        "现金流",
    ),
    "network_and_reputation": (
        "熟人",
        "关系",
        "背景",
        "引荐",
        "学校",
        "清华",
        "YC",
        "4F",
        "被看到",
        "专业",
        "圈子",
        "朋友",
    ),
    "selection_and_portfolio": (
        "风控",
        "成功率",
        "货比三家",
        "赛道",
        "容错",
        "LP",
        "筛选",
        "淘汰",
        "VC很卷",
        "选择",
    ),
    "partnership_and_governance": (
        "合伙人",
        "合伙",
        "跑路",
        "股比",
        "控制权",
        "股东",
        "份额",
        "分配",
        "事业伙伴",
    ),
    "institutional_context": (
        "国内",
        "中国",
        "美国",
        "环境",
        "外资",
        "机制",
        "制度",
        "监管",
        "美元基金",
        "退出中国",
    ),
    "operating_and_go_to_market": (
        "自给自足",
        "自筹",
        "渠道",
        "营销",
        "运营",
        "商业计划书",
        "推广",
        "客户",
        "订单",
    ),
}

RULE_TOPICS: dict[str, tuple[str, ...]] = {
    "milestone_before_capital": ("milestones",),
    "evidence_increases_bargaining_power": ("milestones", "competition_and_bargaining"),
    "equity_dilution_is_a_price": ("equity_and_valuation",),
    "debt_preserves_ownership_but_adds_fixed_risk": ("debt_and_interest",),
    "risk_return_asymmetry": ("risk_allocation", "actors_founders", "actors_investors"),
    "unlimited_liability_is_red_flag": ("risk_allocation",),
    "track_record_and_execution_signal": ("diligence_and_fraud", "milestones"),
    "diligence_counters_ppt_risk": ("diligence_and_fraud",),
    "high_margin_can_pull_capital": ("returns_and_profitability",),
    "subsidy_or_hardtech_is_not_validation": ("policy_and_subsidy", "milestones"),
    "funding_is_not_the_only_growth_path": ("debt_and_interest", "equity_and_valuation"),
    "capital_intensity_requires_matching_capital": ("capital_intensity",),
    "relationship_signals_reduce_information_asymmetry": ("network_and_reputation",),
    "partnership_governance_precedes_financing": ("partnership_and_governance",),
    "institutional_context_changes_capital_supply": ("institutional_context",),
    "trust_compounds_or_erodes": ("trust_and_fairness",),
}

RELATIONS: dict[str, tuple[str, str, str]] = {
    "milestone_before_capital": ("startup_team", "reduces_uncertainty_for", "investor"),
    "evidence_increases_bargaining_power": ("market_evidence", "improves_terms_for", "startup_team"),
    "equity_dilution_is_a_price": ("equity_finance", "dilutes", "startup_team"),
    "debt_preserves_ownership_but_adds_fixed_risk": ("debt_finance", "preserves_ownership_but_adds", "fixed_obligation"),
    "risk_return_asymmetry": ("term_sheet", "can_transfer_downside_to", "startup_team"),
    "unlimited_liability_is_red_flag": ("unbounded_liability", "should_trigger", "term_rejection"),
    "track_record_and_execution_signal": ("execution_history", "raises_confidence_for", "investor"),
    "diligence_counters_ppt_risk": ("diligence", "tests", "unsupported_claims"),
    "high_margin_can_pull_capital": ("margin_and_demand", "attracts", "capital"),
    "subsidy_or_hardtech_is_not_validation": ("policy_label", "does_not_replace", "customer_evidence"),
    "funding_is_not_the_only_growth_path": ("revenue_or_debt", "can_substitute_for", "immediate_equity"),
    "capital_intensity_requires_matching_capital": ("capital_intensity", "requires", "patient_capital_or_staged_spend"),
    "relationship_signals_reduce_information_asymmetry": ("network_signal", "reduces", "information_asymmetry"),
    "partnership_governance_precedes_financing": ("partner_governance", "should_precede", "outside_financing"),
    "institutional_context_changes_capital_supply": ("institutional_context", "changes", "capital_supply_and_terms"),
    "trust_compounds_or_erodes": ("trust", "changes", "coordination_cost"),
}


class KnowledgeError(RuntimeError):
    """A safe, actionable knowledge-mining failure."""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        Path(temporary).replace(path)
    except BaseException:
        try:
            Path(temporary).unlink()
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise KnowledgeError(f"input is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise KnowledgeError("input must be a JSON object")
    return value


def normalized_sentences(text: str) -> list[str]:
    text = " ".join((text or "").split())
    return [
        item.strip()
        for item in SENTENCE_SPLIT.split(text)
        if item.strip() and re.search(r"[\w\u4e00-\u9fff]", item)
    ]


def topics_for(text: str) -> list[str]:
    return [
        topic
        for topic, phrases in TOPIC_PATTERNS.items()
        if any(phrase.lower() in text.lower() for phrase in phrases)
    ]


def stance_for(text: str) -> str:
    if "？" in text or "?" in text or text.startswith(("为什么", "是否", "要么")):
        return "question_or_uncertainty"
    if any(token in text for token in ("PPT", "吹牛", "骗子", "接盘", "不理解", "不行")):
        return "counterpoint_or_risk"
    if any(token in text for token in ("对赌", "无限", "兜底", "连带责任", "风险")):
        return "risk_allocation_concern"
    return "source_view"


def source_documents(capture: dict[str, Any]) -> list[dict[str, Any]]:
    note = capture.get("note") if isinstance(capture.get("note"), dict) else {}
    documents: list[dict[str, Any]] = []
    for field, locator in (("title", "note.title"), ("text", "note.body"), ("image_ocr_text", "note.image_ocr")):
        text = note.get(field)
        if isinstance(text, str) and text.strip():
            documents.append({"locator": locator, "text": text.strip(), "depth": 0})
    for comment in capture.get("comments", []):
        if not isinstance(comment, dict):
            continue
        comment_id = str(comment.get("id") or "").strip()
        text = comment.get("text")
        if comment_id and isinstance(text, str) and text.strip() and text != "[image attachment]":
            documents.append(
                {
                    "locator": f"comment:{comment_id}",
                    "text": text.strip(),
                    "depth": int(comment.get("depth") or 0) + 1,
                }
            )
        image_ocr = comment.get("image_ocr_text")
        if comment_id and isinstance(image_ocr, str) and image_ocr.strip():
            documents.append(
                {
                    "locator": f"comment:{comment_id}:image_ocr",
                    "text": image_ocr.strip(),
                    "depth": int(comment.get("depth") or 0) + 1,
                }
            )
    return documents


def evidence_units(capture: dict[str, Any]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    for source in source_documents(capture):
        for sentence in normalized_sentences(source["text"]):
            unit_id = f"evidence-{len(units) + 1:04d}"
            units.append(
                {
                    "id": unit_id,
                    "source_locator": source["locator"],
                    "depth": source["depth"],
                    "quote": sentence,
                    "topics": topics_for(sentence),
                    "stance": stance_for(sentence),
                }
            )
    return units


def active_rules(units: Iterable[dict[str, Any]]) -> tuple[list[str], dict[str, list[str]]]:
    units = list(units)
    by_topic: dict[str, list[str]] = {}
    for unit in units:
        for topic in unit.get("topics", []):
            by_topic.setdefault(topic, []).append(str(unit["id"]))
    active: list[str] = []
    evidence: dict[str, list[str]] = {}
    for rule in KNOWLEDGE_RULES:
        required = RULE_TOPICS[rule["id"]]
        matches = [item for topic in required for item in by_topic.get(topic, [])]
        # Mechanisms with several required concepts need evidence for every
        # concept; single-topic mechanisms need only that one.
        if all(by_topic.get(topic) for topic in required):
            active.append(rule["id"])
            evidence[rule["id"]] = list(dict.fromkeys(matches))
    return active, evidence


def parameter_adjustments(active_rule_ids: Iterable[str]) -> dict[str, float]:
    """Convert observed mechanisms to small, bounded simulation deltas."""
    active = set(active_rule_ids)
    adjustments: dict[str, float] = {}
    if "milestone_before_capital" in active:
        adjustments["confidence_floor"] = 0.04
    if "diligence_counters_ppt_risk" in active:
        adjustments["diligence_weight"] = 0.10
    if "risk_return_asymmetry" in active or "unlimited_liability_is_red_flag" in active:
        adjustments["founder_risk_aversion"] = 0.10
    if "debt_preserves_ownership_but_adds_fixed_risk" in active:
        adjustments["debt_risk"] = 0.08
    if "evidence_increases_bargaining_power" in active:
        adjustments["competition_premium"] = 0.08
    if "subsidy_or_hardtech_is_not_validation" in active:
        adjustments["upside_premium"] = 0.04
    if "capital_intensity_requires_matching_capital" in active:
        adjustments["capital_intensity"] = 0.10
    if "relationship_signals_reduce_information_asymmetry" in active:
        adjustments["network_signal"] = 0.10
    if "partnership_governance_precedes_financing" in active:
        adjustments["governance_alignment"] = 0.08
    if "institutional_context_changes_capital_supply" in active:
        adjustments["institutional_friction"] = 0.08
    if "trust_compounds_or_erodes" in active:
        adjustments["trust_penalty"] = 0.08
    return adjustments


def build_knowledge(capture: dict[str, Any]) -> dict[str, Any]:
    if capture.get("schema_version") != "clue.xiaohongshu.post-text.v1":
        raise KnowledgeError("input must be clue.xiaohongshu.post-text.v1 text JSON")
    units = evidence_units(capture)
    documents = source_documents(capture)
    active, rule_evidence = active_rules(units)
    topic_counts = Counter(topic for unit in units for topic in unit["topics"])
    stances = Counter(unit["stance"] for unit in units)
    source = capture.get("source") if isinstance(capture.get("source"), dict) else {}
    note = capture.get("note") if isinstance(capture.get("note"), dict) else {}
    source_ref_ids = sorted({unit["source_locator"] for unit in units})
    claims = []
    rules_by_id = {rule["id"]: rule for rule in KNOWLEDGE_RULES}
    for rule_id in active:
        rule = rules_by_id[rule_id]
        claims.append(
            {
                "id": f"claim:{rule_id}",
                "kind": "conditional_model_hypothesis",
                "statement": rule["description"],
                "rule_id": rule_id,
                "evidence_ids": rule_evidence[rule_id],
                "evidence_locators": list(
                    dict.fromkeys(
                        unit["source_locator"]
                        for unit in units
                        if unit["id"] in set(rule_evidence[rule_id])
                    )
                ),
                "caveat": "Derived from source-language matches; not independently verified fact.",
            }
        )
    entities = [
        {"id": "startup_team", "type": "actor", "label": "初创团队 / 创始人"},
        {"id": "investor", "type": "actor", "label": "投资人 / 资本提供者"},
        {"id": "market_evidence", "type": "state", "label": "0→1、数据、收入和验证"},
        {"id": "equity_finance", "type": "instrument", "label": "股权融资"},
        {"id": "debt_finance", "type": "instrument", "label": "债务/贷款融资"},
        {"id": "term_sheet", "type": "contract", "label": "融资条款"},
        {"id": "customer_evidence", "type": "evidence", "label": "客户与收入证据"},
        {"id": "capital_intensity", "type": "state", "label": "资本密集度与资金期限"},
        {"id": "network_signal", "type": "signal", "label": "关系、履历与可验证推荐"},
        {"id": "partner_governance", "type": "governance", "label": "合伙人股权、角色和决策权"},
        {"id": "institutional_context", "type": "context", "label": "LP、地域、监管和市场惯例"},
        {"id": "trust", "type": "state", "label": "合作信任与协调成本"},
    ] + rules_as_knowledge_nodes()
    relations = [
        {
            "id": f"relation:{rule_id}",
            "from": RELATIONS[rule_id][0],
            "relation": RELATIONS[rule_id][1],
            "to": RELATIONS[rule_id][2],
            "rule_id": rule_id,
            "evidence_ids": rule_evidence[rule_id],
        }
        for rule_id in active
    ]
    tensions: list[dict[str, Any]] = []
    active_set = set(active)
    if {"diligence_counters_ppt_risk", "risk_return_asymmetry"} <= active_set:
        tensions.append(
            {
                "id": "tension:diligence-vs-risk-transfer",
                "statement": "尽调能降低欺诈与信息不对称，但不应自动正当化将无界下行风险转给创始人。",
                "rule_ids": ["diligence_counters_ppt_risk", "risk_return_asymmetry"],
            }
        )
    if {"equity_dilution_is_a_price", "debt_preserves_ownership_but_adds_fixed_risk"} <= active_set:
        tensions.append(
            {
                "id": "tension:equity-vs-debt",
                "statement": "股权的稀释成本与债务的固定偿付风险需在现金流和证据阶段中比较。",
                "rule_ids": [
                    "equity_dilution_is_a_price",
                    "debt_preserves_ownership_but_adds_fixed_risk",
                ],
            }
        )
    if {"capital_intensity_requires_matching_capital", "debt_preserves_ownership_but_adds_fixed_risk"} <= active_set:
        tensions.append(
            {
                "id": "tension:capital-intensity-vs-fixed-repayment",
                "statement": "高投入扩张需要匹配资金期限；尚未形成稳定现金流时，固定还款可能放大失败风险。",
                "rule_ids": [
                    "capital_intensity_requires_matching_capital",
                    "debt_preserves_ownership_but_adds_fixed_risk",
                ],
            }
        )
    if {"relationship_signals_reduce_information_asymmetry", "diligence_counters_ppt_risk"} <= active_set:
        tensions.append(
            {
                "id": "tension:network-vs-diligence",
                "statement": "熟人或履历可降低信息搜寻成本，但不能替代对客户、现金流和可重复性的尽调。",
                "rule_ids": [
                    "relationship_signals_reduce_information_asymmetry",
                    "diligence_counters_ppt_risk",
                ],
            }
        )
    questions = [
        {
            "evidence_id": unit["id"],
            "source_locator": unit["source_locator"],
            "question": unit["quote"],
        }
        for unit in units
        if unit["stance"] == "question_or_uncertainty"
    ]
    unclassified = [unit["id"] for unit in units if not unit["topics"]]
    coverage = capture.get("coverage") if isinstance(capture.get("coverage"), dict) else {}
    return {
        "schema_version": KNOWLEDGE_SCHEMA,
        "generated_at": utc_now(),
        "source": {
            "platform": source.get("platform"),
            "canonical_url": source.get("canonical_url"),
            "note_id": source.get("note_id"),
            "title": note.get("title"),
            "capture_coverage": coverage,
        },
        "method": {
            "type": "citation_preserving_rule_based_mining",
            "statement": "All model hypotheses cite one or more verbatim source units; unmatched units are retained and counted.",
            "not_financial_or_legal_advice": True,
        },
        "evidence_units": units,
        "source_statements": [
            {
                "id": unit["id"],
                "source_locator": unit["source_locator"],
                "statement": unit["quote"],
                "topics": unit["topics"],
                "stance": unit["stance"],
            }
            for unit in units
        ],
        "claims": claims,
        "active_rule_ids": active,
        "knowledge_graph": {"nodes": entities, "relations": relations},
        "tensions": tensions,
        "unresolved_questions": questions,
        "simulation_parameters": {
            "numeric_adjustments": parameter_adjustments(active),
            "active_rule_ids": active,
            "guardrails": [
                "Never treat social-media opinions as verified valuation, legal, or suitability facts.",
                "Do not model unlimited personal liability as a default acceptable term.",
                "Model debt only where revenue and repayment capacity can be made explicit.",
            ],
        },
        "coverage": {
            "source_document_count": len(documents),
            "source_sentence_retention_ratio": 1.0,
            "evidence_unit_count": len(units),
            "topic_tagged_unit_count": len(units) - len(unclassified),
            "topic_tagged_ratio": round((len(units) - len(unclassified)) / len(units), 6) if units else 0.0,
            "unclassified_context_count": len(unclassified),
            "source_locator_count": len(source_ref_ids),
            "comment_locators": sum(locator.startswith("comment:") for locator in source_ref_ids),
            "active_model_rule_count": len(active),
            "unclassified_evidence_ids": unclassified,
            "topic_counts": dict(sorted(topic_counts.items())),
            "stance_counts": dict(sorted(stances.items())),
        },
        "limitations": [
            "The API may omit deleted, hidden, image-only, or provider-unavailable comments.",
            "Text matching identifies concepts, not truth, intent, legal validity, or causal proof.",
            "Image-only evidence needs OCR or human review before it enters the text corpus.",
        ],
    }


def reviewed_text_from_file(image_review_path: Path) -> str:
    """Return literal OCR when possible, otherwise an explicit visual review."""
    review = read_json(image_review_path)
    if review.get("schema_version") != "clue.image-review.v1":
        raise KnowledgeError(f"image review must use clue.image-review.v1: {image_review_path}")
    ocr_text = review.get("ocr_text")
    description = review.get("text")
    # Prefer literal OCR whenever present.  A visual description is useful only
    # when there is no readable text, otherwise it can duplicate or paraphrase
    # the source sentence.
    reviewed_text = (
        ocr_text.strip()
        if isinstance(ocr_text, str) and ocr_text.strip()
        else description.strip()
        if isinstance(description, str)
        else ""
    )
    return reviewed_text


def apply_image_reviews(
    capture: dict[str, Any],
    note_image_review_path: Path | None,
    comment_image_reviews: dict[str, Path] | None,
) -> dict[str, Any]:
    """Attach reviewed text without ever embedding pixels in the corpus."""
    copied = dict(capture)
    note = dict(copied.get("note") or {})
    if note_image_review_path is not None:
        reviewed_text = reviewed_text_from_file(note_image_review_path)
        if reviewed_text:
            note["image_ocr_text"] = reviewed_text
    copied["note"] = note
    if not comment_image_reviews:
        return copied
    comments: list[dict[str, Any]] = []
    for item in copied.get("comments", []):
        if not isinstance(item, dict):
            continue
        comment = dict(item)
        comment_id = str(comment.get("id") or "")
        review_path = comment_image_reviews.get(comment_id)
        if review_path is not None:
            reviewed_text = reviewed_text_from_file(review_path)
            if reviewed_text:
                comment["image_ocr_text"] = reviewed_text
        comments.append(comment)
    copied["comments"] = comments
    return copied


def mine_to_directory(
    capture_path: Path,
    output_dir: Path,
    *,
    seed: int = 7,
    monte_carlo_runs: int = 100,
    image_review_path: Path | None = None,
    comment_image_reviews: dict[str, Path] | None = None,
) -> dict[str, Path]:
    capture = apply_image_reviews(
        read_json(capture_path), image_review_path, comment_image_reviews
    )
    knowledge = build_knowledge(capture)
    output_dir.mkdir(parents=True, exist_ok=True)
    knowledge_path = output_dir / "knowledge.json"
    atomic_write_json(knowledge_path, knowledge)
    comparison_path = output_dir / "simulation-comparison.json"
    atomic_write_json(comparison_path, compare_strategies(knowledge, seed=seed))
    monte_carlo_path = output_dir / "simulation-monte-carlo.json"
    atomic_write_json(
        monte_carlo_path,
        monte_carlo(knowledge, seed=seed, runs=monte_carlo_runs),
    )
    return {
        "knowledge": knowledge_path,
        "comparison": comparison_path,
        "monte_carlo": monte_carlo_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mine-xhs-knowledge",
        description="Turn a normalized XHS post corpus into cited knowledge and a two-agent simulation.",
    )
    parser.add_argument("--input", required=True, help="Path to text.json from capture-xhs-post.")
    parser.add_argument("--output-dir", required=True, help="Directory for knowledge and simulation JSON.")
    parser.add_argument("--seed", type=int, default=7, help="Deterministic simulation seed.")
    parser.add_argument("--monte-carlo-runs", type=int, default=100, help="Number of simulation paths.")
    parser.add_argument(
        "--image-review",
        help="Optional clue.image-review.v1 output; OCR/visual text joins the cited corpus.",
    )
    parser.add_argument(
        "--comment-image-review",
        action="append",
        default=[],
        metavar="COMMENT_ID=PATH",
        help="Repeatable reviewed comment image mapping; OCR joins comment:<id>:image_ocr.",
    )
    args = parser.parse_args(argv)
    try:
        if args.monte_carlo_runs < 1:
            raise KnowledgeError("--monte-carlo-runs must be positive")
        comment_reviews: dict[str, Path] = {}
        for item in args.comment_image_review:
            comment_id, separator, raw_path = item.partition("=")
            if not separator or not comment_id.strip() or not raw_path.strip():
                raise KnowledgeError("--comment-image-review needs COMMENT_ID=PATH")
            comment_reviews[comment_id.strip()] = Path(raw_path).expanduser().resolve()
        paths = mine_to_directory(
            Path(args.input).expanduser().resolve(),
            Path(args.output_dir).expanduser().resolve(),
            seed=args.seed,
            monte_carlo_runs=args.monte_carlo_runs,
            image_review_path=(
                Path(args.image_review).expanduser().resolve() if args.image_review else None
            ),
            comment_image_reviews=comment_reviews,
        )
        print(
            json.dumps(
                {key: str(value) for key, value in paths.items()},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except KnowledgeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
