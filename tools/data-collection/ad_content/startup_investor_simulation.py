"""A transparent two-agent startup/investor simulation.

This is an educational, stylized model of the tensions expressed in the
captured note and comments.  It is deliberately not an investment, valuation,
or legal-advice engine.  The source material supplies hypotheses; the model
keeps those hypotheses visible as rule IDs and provenance rather than turning
opinions into facts.

The two bodies are:

* ``StartupTeam`` — controls product work, evidence generation, financing mix,
  dilution and founder downside.
* ``Investor`` — controls capital allocation, diligence, terms, hurdle rate and
  follow-on willingness.

Each period updates both states and records a bilateral interaction force:
capital need × investor confidence minus dilution/control/liability friction.
That makes the metaphor executable without pretending that a financial market
is a physical orbit.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Iterable


SCHEMA = "clue.startup-investor.simulation.v1"
MODEL_VERSION = "two-body-startup-investor-1"


# These rules are the executable knowledge layer.  Each rule is conditional,
# because a social comment is evidence of a viewpoint, not an independently
# verified universal law.
KNOWLEDGE_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "milestone_before_capital",
        "description": "0→1 validation, data, revenue and a defensible market reduce uncertainty before capital is priced.",
        "effects": {"confidence": 0.36, "diligence_weight": 0.28},
    },
    {
        "id": "evidence_increases_bargaining_power",
        "description": "When several investors want a proven project, founder financing terms can improve.",
        "effects": {"competition_premium": 0.18, "term_friction": -0.08},
    },
    {
        "id": "equity_dilution_is_a_price",
        "description": "Equity capital trades ownership and control for cash without scheduled interest payments.",
        "effects": {"dilution_sensitivity": 0.30, "debt_preference": 0.12},
    },
    {
        "id": "debt_preserves_ownership_but_adds_fixed_risk",
        "description": "Debt can preserve ownership after revenue appears, but interest and default risk become fixed obligations.",
        "effects": {"debt_risk": 0.28, "debt_preference": 0.22},
    },
    {
        "id": "risk_return_asymmetry",
        "description": "A term sheet may transfer downside to founders while investors retain upside; model that as a friction and a guardrail.",
        "effects": {"liability_sensitivity": 0.45, "trust_penalty": 0.20},
    },
    {
        "id": "unlimited_liability_is_red_flag",
        "description": "Unlimited personal guarantees or broad joint liability are treated as a negotiation stop signal, not a default.",
        "effects": {"liability_sensitivity": 0.75, "reject_unbounded_liability": True},
    },
    {
        "id": "track_record_and_execution_signal",
        "description": "Founder track record, execution and delivered results can substitute for some early numeric evidence.",
        "effects": {"confidence": 0.16, "diligence_weight": 0.18},
    },
    {
        "id": "diligence_counters_ppt_risk",
        "description": "A demo or pitch is not proof of a business; customer evidence, margins and repeatability must be checked.",
        "effects": {"diligence_weight": 0.35, "confidence": -0.12},
    },
    {
        "id": "high_margin_can_pull_capital",
        "description": "Sustained high margins and demand can reverse the search direction so capital seeks the company.",
        "effects": {"confidence": 0.22, "competition_premium": 0.15},
    },
    {
        "id": "subsidy_or_hardtech_is_not_validation",
        "description": "A policy-favored or hard-tech label can expand upside, but does not replace paying-customer evidence.",
        "effects": {"upside_premium": 0.16, "diligence_weight": 0.20},
    },
    {
        "id": "funding_is_not_the_only_growth_path",
        "description": "Revenue-funded growth, bank debt, customer prepayment and staged spending are alternatives to immediate equity.",
        "effects": {"debt_preference": 0.18, "milestone_threshold": -0.06},
    },
    {
        "id": "capital_intensity_requires_matching_capital",
        "description": "Capital-intensive market capture can require patient risk capital; it should not be financed with a repayment schedule the business cannot carry.",
        "effects": {"capital_intensity": 0.30, "debt_risk": 0.14},
    },
    {
        "id": "relationship_signals_reduce_information_asymmetry",
        "description": "References, prior collaboration and professional networks can improve discovery and trust, but remain inputs to diligence rather than substitutes for it.",
        "effects": {"network_signal": 0.35, "diligence_weight": 0.10},
    },
    {
        "id": "partnership_governance_precedes_financing",
        "description": "Founder and partner roles, ownership and decision rights need alignment before outside capital magnifies the conflict.",
        "effects": {"governance_alignment": 0.30, "trust_penalty": -0.08},
    },
    {
        "id": "institutional_context_changes_capital_supply",
        "description": "LP constraints, regulation, geography and market conventions can change capital availability and term pressure without changing product quality.",
        "effects": {"institutional_friction": 0.28, "competition_premium": -0.10},
    },
    {
        "id": "trust_compounds_or_erodes",
        "description": "Repeated adversarial behavior can erode trust and make later financing or partnership coordination more costly.",
        "effects": {"trust_penalty": 0.18, "governance_alignment": -0.12},
    },
)


@dataclass
class SimulationConfig:
    """All quantities are synthetic currency units (``万元`` by default)."""

    currency_unit: str = "万元"
    months: int = 24
    initial_cash: float = 1000.0
    monthly_burn: float = 80.0
    initial_revenue: float = 0.0
    monthly_revenue_growth: float = 0.16
    product_progress_per_month: float = 0.09
    market_size: float = 5000.0
    equity_raise: float = 900.0
    pre_money_valuation: float = 2400.0
    debt_interest_annual: float = 0.12
    debt_capacity_multiple: float = 4.0
    investor_hurdle_multiple: float = 2.0
    target_runway_months: int = 6
    milestone_threshold: float = 0.58
    diligence_weight: float = 0.50
    confidence_floor: float = 0.48
    founder_risk_aversion: float = 0.65
    dilution_sensitivity: float = 0.30
    debt_risk: float = 0.28
    competition_premium: float = 0.10
    upside_premium: float = 0.10
    trust_penalty: float = 0.0
    capital_intensity: float = 0.50
    network_signal: float = 0.20
    governance_alignment: float = 0.50
    institutional_friction: float = 0.10
    execution_volatility: float = 0.25
    funding_market_volatility: float = 0.20
    reject_unbounded_liability: bool = True
    strategy: str = "milestone_then_equity"

    @classmethod
    def from_knowledge(cls, knowledge: dict[str, Any]) -> "SimulationConfig":
        """Map mined evidence into bounded parameter adjustments.

        The mapping is intentionally monotone and capped.  A phrase in one
        comment cannot produce an implausible valuation or certainty spike.
        """
        config = cls()
        rule_ids = set(knowledge.get("active_rule_ids") or [])
        adjustments = knowledge.get("simulation_parameters")
        if isinstance(adjustments, dict):
            for field_name, value in adjustments.get("numeric_adjustments", {}).items():
                if not hasattr(config, field_name):
                    continue
                try:
                    current = float(getattr(config, field_name))
                    delta = float(value)
                except (TypeError, ValueError):
                    continue
                setattr(config, field_name, current + max(-0.4, min(0.4, delta)))
        # Rule defaults remain useful when a caller supplies only an evidence
        # graph rather than a fully materialized parameter section.
        for rule in KNOWLEDGE_RULES:
            if rule["id"] not in rule_ids:
                continue
            for field_name, delta in rule.get("effects", {}).items():
                if field_name in {"reject_unbounded_liability"}:
                    setattr(config, field_name, bool(delta))
                elif hasattr(config, field_name):
                    current = float(getattr(config, field_name))
                    setattr(config, field_name, current + float(delta) * 0.25)
        config.milestone_threshold = max(0.35, min(0.85, config.milestone_threshold))
        config.diligence_weight = max(0.10, min(0.95, config.diligence_weight))
        config.confidence_floor = max(0.25, min(0.85, config.confidence_floor))
        config.founder_risk_aversion = max(0.0, min(1.0, config.founder_risk_aversion))
        config.dilution_sensitivity = max(0.0, min(1.0, config.dilution_sensitivity))
        config.debt_risk = max(0.0, min(1.0, config.debt_risk))
        config.capital_intensity = max(0.0, min(1.0, config.capital_intensity))
        config.network_signal = max(0.0, min(1.0, config.network_signal))
        config.governance_alignment = max(0.0, min(1.0, config.governance_alignment))
        config.institutional_friction = max(0.0, min(1.0, config.institutional_friction))
        config.execution_volatility = max(0.0, min(0.80, config.execution_volatility))
        config.funding_market_volatility = max(
            0.0, min(0.80, config.funding_market_volatility)
        )
        return config


@dataclass
class StartupTeam:
    cash: float
    revenue: float
    product_maturity: float = 0.18
    market_evidence: float = 0.0
    founder_ownership: float = 1.0
    debt_balance: float = 0.0
    cumulative_interest: float = 0.0
    failed_months: int = 0


@dataclass
class Investor:
    available_cash: float = 5000.0
    investor_ownership: float = 0.0
    cash_deployed: float = 0.0
    cash_returned: float = 0.0
    follow_on_reserve: float = 1500.0
    trust: float = 0.50


@dataclass
class DealTerms:
    instrument: str
    amount: float
    pre_money_valuation: float
    equity_granted: float = 0.0
    annual_interest: float = 0.0
    personal_guarantee: bool = False
    liquidation_preference_multiple: float = 1.0
    board_control: str = "observer"
    rationale_rule_ids: list[str] = field(default_factory=list)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def runway_months(startup: StartupTeam, config: SimulationConfig) -> float:
    monthly_obligation = config.monthly_burn + startup.debt_balance * config.debt_interest_annual / 12
    if monthly_obligation <= 0:
        return float("inf")
    return max(0.0, startup.cash / monthly_obligation)


def evidence_score(startup: StartupTeam, config: SimulationConfig) -> float:
    """Weighted evidence: delivered product, usage/data, revenue and margin."""
    revenue_signal = clamp(startup.revenue / max(1.0, config.monthly_burn * 2.0))
    data_signal = clamp(startup.market_evidence)
    product_signal = clamp(startup.product_maturity)
    return clamp(0.35 * product_signal + 0.35 * data_signal + 0.30 * revenue_signal)


def investor_confidence(
    startup: StartupTeam,
    investor: Investor,
    config: SimulationConfig,
    rng: random.Random,
) -> float:
    signal = evidence_score(startup, config)
    noise = rng.uniform(
        -0.025 - config.funding_market_volatility * 0.18,
        0.025 + config.funding_market_volatility * 0.18,
    )
    # Diligence lowers confidence in unsupported pitch claims, while trackable
    # evidence and competitive demand raise it.
    confidence = (
        0.25
        + signal * (0.48 + config.diligence_weight * 0.22)
        + config.competition_premium * 0.15
        + config.upside_premium * 0.10
        + config.network_signal * 0.10
        - config.institutional_friction * 0.12
        - config.trust_penalty
        + investor.trust * 0.10
        + noise
    )
    return clamp(confidence)


def interaction_force(
    startup: StartupTeam,
    confidence: float,
    config: SimulationConfig,
) -> dict[str, float]:
    need = max(0.0, config.monthly_burn * config.target_runway_months - startup.cash)
    capital_need = clamp(need / max(1.0, config.equity_raise))
    evidence = clamp(confidence)
    dilution_friction = config.dilution_sensitivity * (config.equity_raise / max(1.0, config.pre_money_valuation + config.equity_raise))
    liability_friction = config.founder_risk_aversion * config.debt_risk
    control_friction = config.dilution_sensitivity * (1.0 - config.governance_alignment) * 0.50
    attraction = capital_need * evidence
    friction = clamp(dilution_friction + liability_friction * 0.35 + control_friction)
    return {
        "capital_need": round(capital_need, 6),
        "evidence_confidence": round(evidence, 6),
        "attraction": round(attraction, 6),
        "dilution_friction": round(dilution_friction, 6),
        "liability_friction": round(liability_friction, 6),
        "control_friction": round(control_friction, 6),
        "friction": round(friction, 6),
        "net_force": round(attraction - friction, 6),
    }


def negotiate_terms(
    startup: StartupTeam,
    investor: Investor,
    confidence: float,
    config: SimulationConfig,
) -> DealTerms:
    amount = config.equity_raise
    # Evidence and competition improve price discovery; an early round is
    # intentionally cheaper, making the equity_early strategy pay more
    # dilution for the same amount of cash.
    pricing_factor = 0.72 + 0.55 * confidence + config.competition_premium * 0.35
    pre_money = config.pre_money_valuation * pricing_factor
    equity = amount / max(1.0, pre_money + amount)
    return DealTerms(
        instrument="equity",
        amount=amount,
        pre_money_valuation=pre_money,
        equity_granted=equity,
        liquidation_preference_multiple=1.0 if confidence >= 0.65 else 1.5,
        board_control="observer" if confidence < 0.76 else "observer_plus_reserved_matters",
        rationale_rule_ids=["equity_dilution_is_a_price", "milestone_before_capital"],
    )


def apply_equity_deal(startup: StartupTeam, investor: Investor, terms: DealTerms) -> None:
    investor.available_cash -= terms.amount
    investor.cash_deployed += terms.amount
    startup.cash += terms.amount
    startup.founder_ownership *= 1.0 - terms.equity_granted
    investor.investor_ownership += terms.equity_granted


def apply_debt_deal(startup: StartupTeam, investor: Investor, terms: DealTerms) -> None:
    investor.available_cash -= terms.amount
    investor.cash_deployed += terms.amount
    startup.cash += terms.amount
    startup.debt_balance += terms.amount


def startup_financing_choice(
    startup: StartupTeam,
    confidence: float,
    config: SimulationConfig,
) -> str:
    """Choose an instrument with explicit guardrails and no hidden leverage."""
    if config.strategy == "equity_early":
        return "equity"
    if config.capital_intensity >= 0.72 and startup.revenue < config.monthly_burn:
        return "equity"
    if config.strategy == "debt_after_revenue":
        if startup.revenue > config.monthly_burn * 0.8:
            return "debt"
        return "wait_for_revenue"
    debt_eligible = startup.revenue > config.monthly_burn * 1.1 and startup.market_evidence > 0.45
    debt_capacity = max(0.0, startup.revenue * config.debt_capacity_multiple - startup.debt_balance)
    debt_score = (0.45 if debt_eligible else 0.0) + clamp(debt_capacity / max(1.0, config.equity_raise)) * 0.25
    equity_score = confidence * (1.0 - config.dilution_sensitivity * 0.35)
    if config.strategy == "milestone_then_equity":
        return "debt" if debt_score > equity_score and debt_eligible else "equity"
    return "debt" if debt_score > equity_score and debt_eligible else "equity"


def simulate(
    config: SimulationConfig | None = None,
    *,
    seed: int = 7,
) -> dict[str, Any]:
    """Run one reproducible interaction path."""
    config = config or SimulationConfig()
    if config.months < 1:
        raise ValueError("months must be positive")
    rng = random.Random(seed)
    startup = StartupTeam(cash=config.initial_cash, revenue=config.initial_revenue)
    investor = Investor()
    timeline: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    status = "building"
    funded = False
    funding_month: int | None = None

    for month in range(1, config.months + 1):
        previous_cash = startup.cash
        execution_multiplier = 1.0 + rng.uniform(
            -config.execution_volatility, config.execution_volatility
        )
        startup.product_maturity = clamp(
            startup.product_maturity
            + config.product_progress_per_month * max(0.15, execution_multiplier),
            0.0,
            1.0,
        )
        demand_factor = clamp(startup.product_maturity - 0.45, 0.0, 1.0)
        growth_noise = 1.0 + rng.uniform(-0.04, 0.04)
        if startup.revenue > 0:
            startup.revenue *= 1.0 + config.monthly_revenue_growth * demand_factor * growth_noise
        else:
            startup.revenue = max(
                0.0,
                config.initial_revenue + demand_factor * config.monthly_burn * 1.5 * growth_noise,
            )
        startup.market_evidence = clamp(
            startup.market_evidence
            + 0.035 * startup.product_maturity
            + (0.035 if startup.revenue > config.monthly_burn * 0.5 else 0.0)
        )
        interest = startup.debt_balance * config.debt_interest_annual / 12.0
        startup.cumulative_interest += interest
        startup.cash += startup.revenue - config.monthly_burn - interest

        confidence = investor_confidence(startup, investor, config, rng)
        force = interaction_force(startup, confidence, config)
        runway = runway_months(startup, config)
        month_events: list[dict[str, Any]] = []

        funding_trigger = config.target_runway_months * (
            1.5 if config.strategy == "equity_early" else 1.0
        )
        if not funded and runway <= funding_trigger:
            need = max(0.0, config.monthly_burn * config.target_runway_months - startup.cash)
            choice = startup_financing_choice(startup, confidence, config)
            acceptance_floor = config.confidence_floor - (
                0.08 if config.strategy == "equity_early" else 0.0
            )
            acceptance_probability = clamp(
                0.12
                + confidence * 0.58
                + config.network_signal * 0.12
                - config.institutional_friction * 0.16
                - config.funding_market_volatility * 0.10
            )
            investor_accepts = (
                confidence >= acceptance_floor and rng.random() <= acceptance_probability
            )
            term_rejection = False
            terms: DealTerms | None = None
            projected_exit = config.market_size * max(evidence_score(startup, config), 0.85) * (
                1.0 + config.upside_premium
            )
            expected_multiple = 0.0
            if choice == "wait_for_revenue":
                investor_accepts = False
            elif choice == "equity":
                terms = negotiate_terms(startup, investor, confidence, config)
                investor_accepts = investor_accepts and investor.available_cash >= terms.amount
                expected_multiple = (
                    projected_exit * terms.equity_granted / max(1.0, terms.amount)
                )
                investor_accepts = investor_accepts and expected_multiple >= config.investor_hurdle_multiple * 0.65
                # The default model never silently adds the unlimited personal
                # guarantee criticized in the source discussion.
                term_rejection = terms.personal_guarantee and config.reject_unbounded_liability
            else:
                debt_capacity = startup.revenue * config.debt_capacity_multiple - startup.debt_balance
                amount = min(config.equity_raise, max(0.0, debt_capacity))
                terms = DealTerms(
                    instrument="debt",
                    amount=amount,
                    pre_money_valuation=0.0,
                    annual_interest=config.debt_interest_annual,
                    personal_guarantee=False,
                    rationale_rule_ids=["debt_preserves_ownership_but_adds_fixed_risk"],
                )
                investor_accepts = investor_accepts and amount > 0 and investor.available_cash >= amount
            decision = {
                "month": month,
                "startup_need": round(need, 4),
                "instrument_considered": choice,
                "investor_confidence": round(confidence, 6),
                "acceptance_probability": round(acceptance_probability, 6),
                "projected_exit": round(projected_exit, 4),
                "expected_multiple": round(expected_multiple, 6),
                "runway_months": round(runway, 4),
                "accepted": bool(investor_accepts and not term_rejection),
                "term_rejected": term_rejection,
                "terms": asdict(terms) if terms else None,
                "interaction_force": force,
            }
            decisions.append(decision)
            if choice == "wait_for_revenue":
                events.append(
                    {
                        "month": month,
                        "type": "funding_deferred",
                        "reason": "strategy waits for revenue-based debt capacity",
                    }
                )
                month_events.append("funding_deferred")
            elif investor_accepts and not term_rejection and terms and terms.amount > 0:
                if terms.instrument == "equity":
                    apply_equity_deal(startup, investor, terms)
                    events.append({"month": month, "type": "equity_closed", "terms": asdict(terms)})
                else:
                    apply_debt_deal(startup, investor, terms)
                    events.append({"month": month, "type": "debt_closed", "terms": asdict(terms)})
                funded = True
                funding_month = month
                month_events.append(f"{terms.instrument}_funding_closed")
            else:
                events.append(
                    {
                        "month": month,
                        "type": "financing_rejected",
                        "instrument": choice,
                        "reason": "confidence, capacity, cash, or liability guardrail",
                    }
                )
                month_events.append("financing_rejected")

        if startup.cash < 0:
            startup.failed_months += 1
            status = "stalled" if startup.failed_months == 1 else "failed"
        elif evidence_score(startup, config) >= config.milestone_threshold:
            status = "validated" if not funded else "funded_validated"
        elif funded:
            status = "funded_building"
        else:
            status = "building"
        if status in {"validated", "funded_validated"} and startup.revenue > config.monthly_burn * 2:
            status = "scaling"

        timeline.append(
            {
                "month": month,
                "status": status,
                "startup": {
                    "cash": round(startup.cash, 4),
                    "revenue": round(startup.revenue, 4),
                    "product_maturity": round(startup.product_maturity, 6),
                    "market_evidence": round(startup.market_evidence, 6),
                    "runway_months": round(runway_months(startup, config), 4),
                    "founder_ownership": round(startup.founder_ownership, 6),
                    "debt_balance": round(startup.debt_balance, 4),
                },
                "investor": {
                    "available_cash": round(investor.available_cash, 4),
                    "investor_ownership": round(investor.investor_ownership, 6),
                    "trust": round(investor.trust, 6),
                },
                "interaction_force": force,
                "events": month_events,
                "cash_delta": round(startup.cash - previous_cash, 4),
            }
        )
        if status == "failed":
            break

    exit_value = max(0.0, startup.revenue * 24.0 * (1.0 + config.upside_premium)) if status in {"scaling", "funded_validated"} else 0.0
    investor_equity_return = exit_value * investor.investor_ownership
    debt_return = startup.debt_balance + startup.cumulative_interest if startup.debt_balance and exit_value > 0 else 0.0
    investor.cash_returned += investor_equity_return + debt_return
    founder_value = exit_value * startup.founder_ownership - startup.debt_balance
    outcome = {
        "status": status,
        "months_simulated": len(timeline),
        "funding_month": funding_month,
        "exit_value": round(exit_value, 4),
        "founder_value": round(founder_value, 4),
        "investor_value": round(investor_equity_return + debt_return, 4),
        "founder_ownership": round(startup.founder_ownership, 6),
        "investor_ownership": round(investor.investor_ownership, 6),
        "debt_balance": round(startup.debt_balance, 4),
        "cumulative_interest": round(startup.cumulative_interest, 4),
    }
    return {
        "schema_version": SCHEMA,
        "model_version": MODEL_VERSION,
        "seed": seed,
        "assumptions": {
            "currency_unit": config.currency_unit,
            "stylized_educational_model": True,
            "not_financial_or_legal_advice": True,
            "monte_carlo_probabilities_are_scenario_sensitivities_not_forecasts": True,
            "unlimited_personal_liability_rejected_by_default": config.reject_unbounded_liability,
        },
        "knowledge_rule_ids": [rule["id"] for rule in KNOWLEDGE_RULES],
        "config": asdict(config),
        "decisions": decisions,
        "events": events,
        "timeline": timeline,
        "outcome": outcome,
    }


def compare_strategies(
    knowledge: dict[str, Any] | None = None,
    *,
    seed: int = 7,
    months: int = 24,
) -> dict[str, Any]:
    """Run the principal financing strategies against the same evidence model."""
    base = SimulationConfig.from_knowledge(knowledge or {})
    base.months = months
    scenarios: dict[str, Any] = {}
    for strategy in (
        "milestone_then_equity",
        "equity_early",
        "debt_after_revenue",
    ):
        scenarios[strategy] = simulate(replace(base, strategy=strategy), seed=seed)
    return {
        "schema_version": SCHEMA,
        "model_version": MODEL_VERSION,
        "knowledge_rule_ids": [rule["id"] for rule in KNOWLEDGE_RULES],
        "strategy_results": scenarios,
        "comparison": {
            "status_counts": dict(Counter(result["outcome"]["status"] for result in scenarios.values())),
            "founder_value_by_strategy": {
                name: result["outcome"]["founder_value"] for name, result in scenarios.items()
            },
            "investor_value_by_strategy": {
                name: result["outcome"]["investor_value"] for name, result in scenarios.items()
            },
        },
    }


def monte_carlo(
    knowledge: dict[str, Any] | None = None,
    *,
    runs: int = 100,
    seed: int = 7,
    months: int = 24,
) -> dict[str, Any]:
    if runs < 1:
        raise ValueError("runs must be positive")
    config = SimulationConfig.from_knowledge(knowledge or {})
    config.months = months
    results = [simulate(config, seed=seed + index) for index in range(runs)]
    statuses = Counter(result["outcome"]["status"] for result in results)
    average_founder = sum(result["outcome"]["founder_value"] for result in results) / runs
    average_investor = sum(result["outcome"]["investor_value"] for result in results) / runs
    return {
        "schema_version": SCHEMA,
        "model_version": MODEL_VERSION,
        "runs": runs,
        "seed": seed,
        "months": months,
        "status_counts": dict(statuses),
        "probability_by_status": {key: round(value / runs, 6) for key, value in statuses.items()},
        "average_founder_value": round(average_founder, 4),
        "average_investor_value": round(average_investor, 4),
        "samples": results[: min(3, runs)],
    }


def rules_as_knowledge_nodes() -> list[dict[str, Any]]:
    return [
        {
            "id": rule["id"],
            "type": "simulation_rule",
            "label": rule["description"],
            "effects": rule["effects"],
        }
        for rule in KNOWLEDGE_RULES
    ]
