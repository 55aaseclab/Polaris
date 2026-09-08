"""Offline tests for iterative claim-graph absorption (no Codex calls)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import iterate  # noqa: E402
import runner as lr  # noqa: E402


def _analysis_input() -> dict:
    task = {
        "schema_version": lr.TASK_SCHEMA,
        "case_id": "case-iter",
        "question": "What about agent isolation?",
        "decision_context": "Synthetic.",
        "audience": "research",
        "collection_snapshot_id": "snap-iter",
        "coverage_mode": "selected_evidence",
        "review_policy": {
            "minimum_confidence": 0.7,
            "review_all_claims": False,
            "mode": "auto-approve",
        },
    }
    snapshot = {
        "schema_version": lr.SNAPSHOT_SCHEMA,
        "snapshot_id": "snap-iter",
        "created_at": "2026-01-01T00:00:00Z",
        "clues": [
            {
                "clue_id": "paper-seed",
                "source_url": "https://example.com/seed",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "sha256:seed",
                "observations": [
                    {
                        "observation_id": "obs-seed",
                        "quote": "We isolate agent tool calls in a sandbox.",
                        "locator": "abstract",
                    }
                ],
            },
            {
                "clue_id": "paper-b",
                "source_url": "https://example.com/b",
                "observed_at": "2026-01-02T00:00:00Z",
                "content_hash": "sha256:b",
                "observations": [
                    {
                        "observation_id": "obs-b",
                        "quote": "Sandbox isolation is required for tool-using agents.",
                        "locator": "abstract",
                    }
                ],
            },
            {
                "clue_id": "paper-c",
                "source_url": "https://example.com/c",
                "observed_at": "2026-01-03T00:00:00Z",
                "content_hash": "sha256:c",
                "observations": [
                    {
                        "observation_id": "obs-c",
                        "quote": "Agents should run without isolation for latency.",
                        "locator": "abstract",
                    }
                ],
            },
        ],
    }
    return lr.build_analysis_input(task, snapshot)


class IterateAbsorbTests(unittest.TestCase):
    def test_resolve_observation_accepts_whitespace_and_prefix(self) -> None:
        sources = {
            ("p", "o1"): {"quote": "Hello   world sandbox isolation."},
        }
        got = iterate._resolve_observation(
            paper_id="p",
            observation_id="wrong",
            quote="Hello world sandbox isolation.",
            sources=sources,
        )
        self.assertIsNotNone(got)
        assert got is not None
        self.assertEqual(got[0], "o1")

    def test_seed_then_identical_then_contradiction(self) -> None:
        graph = iterate.ClaimGraph()
        seed_ex = {
            "extraction_id": "ex-1",
            "title": "Sandbox isolation",
            "statement": "Tool-using agents require sandbox isolation.",
            "status": "supported",
            "confidence": 0.9,
            "risk_level": "medium",
            "evidence": [
                {
                    "clue_id": "paper-seed",
                    "observation_id": "obs-seed",
                    "quote": "We isolate agent tool calls in a sandbox.",
                    "relation": "supports",
                    "paper_id": "paper-seed",
                }
            ],
            "limitations": [],
        }
        actions, counts = iterate.absorb_extractions(
            graph,
            extractions=[seed_ex],
            judgments=None,
            paper_id="paper-seed",
            iteration=0,
            is_seed=True,
        )
        self.assertEqual(counts["nodes_created"], 1)
        self.assertEqual(actions[0]["action"], "create_node")
        node_id = actions[0]["node_id"]

        identical_ex = {
            "extraction_id": "ex-2",
            "title": "Sandbox needed",
            "statement": "Sandbox isolation is required for tool-using agents.",
            "status": "supported",
            "confidence": 0.85,
            "risk_level": "medium",
            "evidence": [
                {
                    "clue_id": "paper-b",
                    "observation_id": "obs-b",
                    "quote": "Sandbox isolation is required for tool-using agents.",
                    "relation": "supports",
                    "paper_id": "paper-b",
                }
            ],
            "limitations": [],
        }
        actions2, counts2 = iterate.absorb_extractions(
            graph,
            extractions=[identical_ex],
            judgments=[
                {
                    "extraction_id": "ex-2",
                    "relation": "identical",
                    "target_node_id": node_id,
                    "reason": "same claim",
                }
            ],
            paper_id="paper-b",
            iteration=1,
            is_seed=False,
        )
        self.assertEqual(counts2["identical_merges"], 1)
        self.assertEqual(actions2[0]["action"], "merge_identical")
        node = graph.get(node_id)
        assert node is not None
        self.assertEqual(set(node["support_papers"]), {"paper-seed", "paper-b"})
        self.assertEqual(len(node["evidence"]), 2)

        contra_ex = {
            "extraction_id": "ex-3",
            "title": "No isolation",
            "statement": "Agents should run without isolation for latency.",
            "status": "supported",
            "confidence": 0.7,
            "risk_level": "high",
            "evidence": [
                {
                    "clue_id": "paper-c",
                    "observation_id": "obs-c",
                    "quote": "Agents should run without isolation for latency.",
                    "relation": "supports",
                    "paper_id": "paper-c",
                }
            ],
            "limitations": [],
        }
        actions3, counts3 = iterate.absorb_extractions(
            graph,
            extractions=[contra_ex],
            judgments=[
                {
                    "extraction_id": "ex-3",
                    "relation": "contradictory",
                    "target_node_id": node_id,
                    "reason": "opposes isolation",
                }
            ],
            paper_id="paper-c",
            iteration=2,
            is_seed=False,
        )
        self.assertEqual(counts3["contradictions"], 1)
        self.assertEqual(len(graph.nodes), 2)
        self.assertEqual(len(graph.edges), 1)
        self.assertEqual(graph.edges[0]["kind"], "contradicts")
        # original supported node marked contradicted
        self.assertEqual(graph.get(node_id)["status"], "contradicted")

    def test_identical_does_not_merge_incompatible_paper_type(self) -> None:
        graph = iterate.ClaimGraph()
        seed = {
            "extraction_id": "tool-ex",
            "title": "Sandbox tool",
            "statement": "The proposed tool isolates agent calls.",
            "paper_type": "tool_paper",
            "focus": ["method"],
            "status": "supported",
            "confidence": 0.9,
            "risk_level": "medium",
            "evidence": [
                {
                    "clue_id": "tool-paper",
                    "observation_id": "tool-obs",
                    "quote": "The proposed tool isolates agent calls.",
                    "relation": "supports",
                    "paper_id": "tool-paper",
                }
            ],
            "limitations": [],
        }
        actions, _ = iterate.absorb_extractions(
            graph,
            extractions=[seed],
            judgments=None,
            paper_id="tool-paper",
            iteration=0,
            is_seed=True,
        )
        target = actions[0]["node_id"]
        measurement = {
            **seed,
            "extraction_id": "measurement-ex",
            "paper_type": "measurement_paper",
            "focus": ["conclusion"],
            "statement": "Measurements find that isolation reduces exposure.",
            "evidence": [
                {
                    **seed["evidence"][0],
                    "clue_id": "measurement-paper",
                    "observation_id": "measurement-obs",
                    "quote": "Measurements find that isolation reduces exposure.",
                    "paper_id": "measurement-paper",
                }
            ],
        }
        actions, counts = iterate.absorb_extractions(
            graph,
            extractions=[measurement],
            judgments=[
                {
                    "extraction_id": "measurement-ex",
                    "relation": "identical",
                    "target_node_id": target,
                    "reason": "similar wording",
                }
            ],
            paper_id="measurement-paper",
            iteration=1,
            is_seed=False,
        )

        self.assertEqual(counts["identical_merges"], 0)
        self.assertEqual(counts["uncertain"], 1)
        self.assertEqual(len(graph.nodes), 2)
        self.assertEqual(actions[0]["action"], "record_uncertain")
        self.assertEqual(graph.nodes[1]["paper_type"], "measurement_paper")

    def test_validate_extractions_requires_type_and_type_specific_focus(self) -> None:
        sources = {
            ("paper", "obs"): {"quote": "Measured result."},
        }
        item = {
            "extraction_id": "ex-001",
            "title": "Measured result",
            "statement": "The paper reports a measured result.",
            "focus": ["conclusion"],
            "status": "supported",
            "confidence": 0.8,
            "risk_level": "low",
            "evidence": [
                {
                    "clue_id": "paper",
                    "observation_id": "obs",
                    "relation": "supports",
                    "quote": "Measured result.",
                }
            ],
        }
        with self.assertRaisesRegex(lr.CliError, "paper_type"):
            iterate.validate_extractions(
                {"paper_id": "paper", "extractions": [item]},
                paper_id="paper",
                sources=sources,
            )

        invalid = {
            "paper_id": "paper",
            "paper_type": "measurement_paper",
            "extractions": [{**item, "focus": ["method"]}],
        }
        with self.assertRaisesRegex(lr.CliError, "not allowed"):
            iterate.validate_extractions(invalid, paper_id="paper", sources=sources)

        normalized = iterate.validate_extractions(
            {
                "paper_id": "paper",
                "paper_type": "measurement_paper",
                "extractions": [item],
            },
            paper_id="paper",
            sources=sources,
        )
        self.assertEqual(normalized[0]["paper_type"], "measurement_paper")
        self.assertEqual(normalized[0]["focus"], ["conclusion"])

    def test_run_iteration_with_mock_llm(self) -> None:
        analysis_input = _analysis_input()
        calls: list[str] = []

        def fake_caller(system_prompt: str, user_payload: dict, work_dir: Path) -> str:
            work_dir.mkdir(parents=True, exist_ok=True)
            if "paper" in user_payload:
                paper_id = user_payload["paper"]["paper_id"]
                calls.append(f"extract:{paper_id}")
                obs = user_payload["paper"]["observations"][0]
                return json.dumps(
                    {
                        "schema_version": "clue.intelligence.paper-extractions.v1",
                        "paper_id": paper_id,
                        "paper_type": "tool_paper",
                        "extractions": [
                            {
                                "extraction_id": "ex-1",
                                "title": f"Claim from {paper_id}",
                                "statement": obs["quote"],
                                "focus": ["conclusion"],
                                "status": "supported",
                                "confidence": 0.8,
                                "risk_level": "medium",
                                "evidence": [
                                    {
                                        "clue_id": paper_id,
                                        "observation_id": obs["observation_id"],
                                        "relation": "supports",
                                        "quote": obs["quote"],
                                        "paper_id": paper_id,
                                    }
                                ],
                                "limitations": [],
                            }
                        ],
                    }
                )
            # classify
            calls.append("classify")
            nodes = user_payload.get("claim_graph_nodes") or []
            target = nodes[0]["node_id"] if nodes else None
            judgments = []
            for item in user_payload.get("new_extractions") or []:
                eid = item["extraction_id"]
                statement = item.get("statement") or ""
                if "without isolation" in statement:
                    judgments.append(
                        {
                            "extraction_id": eid,
                            "relation": "contradictory",
                            "target_node_id": target,
                            "reason": "opposes sandbox",
                        }
                    )
                else:
                    judgments.append(
                        {
                            "extraction_id": eid,
                            "relation": "identical",
                            "target_node_id": target,
                            "reason": "same isolation claim",
                        }
                    )
            return json.dumps(
                {
                    "schema_version": "clue.intelligence.absorb-judgments.v1",
                    "judgments": judgments,
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            corpus = iterate.run_iteration(
                analysis_input,
                root=TOOL_ROOT,
                work_dir=work,
                seed_ids=["paper-seed"],
                codex_caller=fake_caller,
            )
            self.assertEqual(corpus["schema_version"], iterate.ITERATION_SCHEMA)
            self.assertEqual(corpus["stats"]["papers_processed"], 3)
            self.assertGreaterEqual(len(corpus["claim_graph"]["nodes"]), 2)
            self.assertEqual(
                corpus["claim_graph"]["nodes"][0]["paper_type"], "tool_paper"
            )
            self.assertTrue(any(c.startswith("extract:") for c in calls))
            self.assertIn("classify", calls)
            candidates = iterate.export_candidates(corpus)
            self.assertEqual(candidates["schema_version"], lr.CANDIDATES_SCHEMA)
            self.assertGreaterEqual(len(candidates["claims"]), 1)
            self.assertEqual(candidates["claims"][0]["paper_types"], ["tool_paper"])
            # validate against analysis input (evidence bindings)
            validated = lr.validate_candidate_response(candidates, analysis_input)
            self.assertEqual(len(validated["claims"]), len(candidates["claims"]))

    def test_run_iteration_does_not_resume_mismatched_input_digest(self) -> None:
        first_input = _analysis_input()
        second_input = json.loads(json.dumps(first_input))
        second_input["snapshot"]["clues"] = second_input["snapshot"]["clues"][1:]
        second_input = lr.build_analysis_input(
            second_input["task"], second_input["snapshot"]
        )
        calls: list[str] = []

        def fake_caller(system_prompt: str, user_payload: dict, work_dir: Path) -> str:
            work_dir.mkdir(parents=True, exist_ok=True)
            if "paper" in user_payload:
                paper_id = user_payload["paper"]["paper_id"]
                calls.append(f"extract:{paper_id}")
                obs = user_payload["paper"]["observations"][0]
                return json.dumps(
                    {
                        "schema_version": iterate.EXTRACTION_SCHEMA,
                        "paper_id": paper_id,
                        "paper_type": "tool_paper",
                        "extractions": [
                            {
                                "extraction_id": "ex-1",
                                "title": f"Claim from {paper_id}",
                                "statement": obs["quote"],
                                "focus": ["conclusion"],
                                "status": "supported",
                                "confidence": 0.8,
                                "risk_level": "medium",
                                "evidence": [
                                    {
                                        "clue_id": paper_id,
                                        "observation_id": obs["observation_id"],
                                        "relation": "supports",
                                        "quote": obs["quote"],
                                        "paper_id": paper_id,
                                    }
                                ],
                                "limitations": [],
                            }
                        ],
                    }
                )
            calls.append("classify")
            return json.dumps(
                {
                    "schema_version": iterate.JUDGMENT_SCHEMA,
                    "judgments": [
                        {
                            "extraction_id": item["extraction_id"],
                            "relation": "new",
                            "target_node_id": None,
                            "reason": "synthetic",
                        }
                        for item in user_payload.get("new_extractions") or []
                    ],
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            first = iterate.run_iteration(
                first_input,
                root=TOOL_ROOT,
                work_dir=work,
                seed_ids=["paper-seed"],
                codex_caller=fake_caller,
            )
            self.assertIn("paper-seed", first["paper_order"])
            calls.clear()

            second = iterate.run_iteration(
                second_input,
                root=TOOL_ROOT,
                work_dir=work,
                seed_ids=["paper-b"],
                codex_caller=fake_caller,
            )

            self.assertNotEqual(
                first["analysis_input_sha256"], second["analysis_input_sha256"]
            )
            self.assertNotIn("paper-seed", second["paper_order"])
            self.assertNotIn("paper-seed", second["claim_graph"]["nodes"][0]["support_papers"])
            self.assertIn("extract:paper-b", calls)


if __name__ == "__main__":
    unittest.main()
