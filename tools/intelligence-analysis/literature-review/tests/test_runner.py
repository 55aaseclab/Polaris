"""Offline contract tests for literature-review."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import runner  # noqa: E402


TASK = {
    "schema_version": runner.TASK_SCHEMA,
    "case_id": "case-example",
    "question": "What does the snapshot establish?",
    "question_prompt": {
        "method": "generate-text",
        "instruction": "derive question",
        "output_kind": "text",
    },
    "decision_context": "Synthetic decision context.",
    "decision_context_prompt": {
        "method": "generate-text",
        "instruction": "derive decision context",
        "output_kind": "text",
    },
    "audience": "management",
    "audience_prompt": {
        "method": "derive",
        "instruction": "derive audience",
        "output_kind": "text",
    },
    "collection_snapshot_id": "snapshot-example",
    "review_policy": {"minimum_confidence": 0.8, "review_all_claims": False},
}

SNAPSHOT = {
    "schema_version": runner.SNAPSHOT_SCHEMA,
    "snapshot_id": "snapshot-example",
    "created_at": "2026-01-01T00:00:00Z",
    "clues": [
        {
            "clue_id": "clue-001",
            "source_url": "https://source.example/one",
            "observed_at": "2026-01-01T00:00:00Z",
            "content_hash": "sha256:source-one",
            "observations": [
                {
                    "observation_id": "observation-001",
                    "quote": "Synthetic source statement.",
                    "locator": "paragraph=1",
                }
            ],
        }
    ],
}


def candidate_response() -> dict[str, object]:
    return {
        "schema_version": runner.CANDIDATES_SCHEMA,
        "case_id": "case-example",
        "snapshot_id": "snapshot-example",
        "claims": [
            {
                "claim_id": "claim-001",
                "title": "Synthetic finding",
                "statement": "The source makes a synthetic statement.",
                "classification": "contradictory",
                "status": "supported",
                "risk_level": "high",
                "confidence": 0.9,
                "evidence": [
                    {
                        "clue_id": "clue-001",
                        "observation_id": "observation-001",
                        "relation": "supports",
                        "quote": "Synthetic source statement.",
                    }
                ],
                "questions": ["Confirm the conflict scope."],
                "limitations": ["Only one synthetic source is available."],
            }
        ],
        "framework": {
            "title": "Synthetic viewpoint framework",
            "stages": [
                {
                    "stage_id": "stage-001",
                    "sequence": 1,
                    "title": "Synthetic foundation",
                    "explanation": "The source supplies the first synthetic viewpoint.",
                    "transition": "No later synthetic viewpoint is available.",
                    "claim_ids": ["claim-001"],
                }
            ],
        },
        "unresolved": ["Synthetic conflict remains."],
    }


class AnalysisContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.analysis_input = runner.build_analysis_input(TASK, SNAPSHOT)

    def test_prepare_has_stable_identity(self) -> None:
        repeated = runner.build_analysis_input(TASK, SNAPSHOT)

        self.assertEqual(self.analysis_input["input_id"], repeated["input_id"])
        self.assertEqual(self.analysis_input["input_sha256"], repeated["input_sha256"])
        self.assertEqual(self.analysis_input["task"]["review_policy"]["minimum_confidence"], 0.8)
        self.assertEqual(self.analysis_input["task"]["review_policy"]["mode"], "auto-pass")
        self.assertEqual(self.analysis_input["task"]["question_prompt"]["method"], "generate-text")

    def test_rejects_legacy_boolean_review_policy(self) -> None:
        task = {
            **TASK,
            "review_policy": {"auto_pass": True},
        }
        with self.assertRaisesRegex(runner.CliError, "unsupported"):
            runner.build_analysis_input(task, SNAPSHOT)

    def test_validation_creates_generic_manual_review_record(self) -> None:
        validated = runner.validate_candidates(candidate_response(), self.analysis_input)
        record = validated["claims"][0]

        self.assertTrue(record["review"]["required"])
        self.assertIn("high_risk", record["review"]["reasons"])
        self.assertIn("conflict_or_uncertainty", record["review"]["reasons"])

        review_list = runner.manual_review_list(validated, self.analysis_input)

        self.assertEqual(review_list["schema_version"], runner.MANUAL_REVIEW_SCHEMA)
        self.assertEqual(len(review_list["review_records"]), 1)
        review_record = review_list["review_records"][0]
        self.assertEqual(review_record["evidence"][0]["source_url"], "https://source.example/one")
        self.assertEqual(review_record["evidence"][0]["source_excerpt"], "Synthetic source statement.")

    def test_auto_pass_approves_without_fulltext_rebuild(self) -> None:
        task = {
            **TASK,
            "review_policy": {
                "minimum_confidence": 0.8,
                "review_all_claims": True,
                "mode": "auto-pass",
            },
        }
        analysis_input = runner.build_analysis_input(task, SNAPSHOT)
        validated = runner.validate_candidates(candidate_response(), analysis_input)

        with patch.object(runner, "evidence_index_with_fulltext") as fulltext_index:
            result = runner.automatic_pass_result(validated, analysis_input)
            output, _ = runner.build_final_output(
                validated,
                result,
                analysis_input,
                Path("/tmp/synthetic-auto-pass-report.md"),
            )
        fulltext_index.assert_not_called()
        self.assertEqual(result["approval_mode"], "auto_pass")
        self.assertEqual(result["summary"]["approved"], 1)
        self.assertEqual(result["approved_records"][0]["manual_review"]["status"], "approved")
        self.assertEqual(result["approved_records"][0]["record_id"], "claim-001")
        self.assertIn("validated_analysis_sha256", result["source"])
        # Lightweight records do not expand a full evidence dossier.
        self.assertNotIn("evidence", result["approved_records"][0])
        self.assertEqual(output["review"]["approval_mode"], "auto_pass")

    def test_auto_pass_rejects_evidence_not_in_validation_ledger(self) -> None:
        analysis_input = runner.build_analysis_input(TASK, SNAPSHOT)
        validated = runner.validate_candidates(candidate_response(), analysis_input)
        tampered = deepcopy(validated)
        claim = tampered["claims"][0]
        claim["evidence"][0].update(
            {
                "clue_id": "clue-not-in-snapshot",
                "observation_id": "made-up-observation",
                "quote": "Invented evidence.",
            }
        )
        revision_basis = deepcopy(claim)
        revision_basis.pop("review")
        claim["review"]["revision_hash"] = runner.claim_revision_hash(revision_basis)

        with self.assertRaisesRegex(runner.CliError, "unknown clue or observation"):
            runner.automatic_pass_result(tampered, analysis_input)

    def test_finalize_requires_completed_review_and_renders_report(self) -> None:
        validated = runner.validate_candidates(candidate_response(), self.analysis_input)
        review_list = runner.manual_review_list(validated, self.analysis_input)
        review_record = review_list["review_records"][0]
        approved = {
            **review_record,
            "manual_review": {
                "status": "approved",
                "note": "Synthetic confirmation.",
                "updated_at": "2026-01-02T00:00:00Z",
            },
        }
        review_result = {
            "schema_version": runner.MANUAL_REVIEW_RESULT_SCHEMA,
            "review_set_id": review_list["review_set_id"],
            "review_kind": "intelligence_finding",
            "summary": {"review_total": 1, "approved": 1, "rejected": 0, "pending": 0},
            "approved_records": [approved],
            "rejected_records": [],
            "pending_records": [],
        }

        output, report = runner.build_final_output(
            validated,
            review_result,
            self.analysis_input,
            Path("/tmp/synthetic-report.md"),
        )

        self.assertEqual(output["status"], "final")
        self.assertEqual(output["summary"]["judgment_total"], 1)
        self.assertEqual(output["judgments"][0]["review_decision"]["status"], "approved")
        self.assertEqual(output["review"]["approval_mode"], "manual")
        self.assertEqual(output["framework"]["stages"][0]["claim_ids"], ["claim-001"])
        self.assertNotIn("report_path", output)
        self.assertIn("Synthetic finding", report)
        self.assertIn("https://source.example/one", report)

    def test_finalize_rejects_pending_required_review(self) -> None:
        validated = runner.validate_candidates(candidate_response(), self.analysis_input)
        review_list = runner.manual_review_list(validated, self.analysis_input)
        review_record = review_list["review_records"][0]
        pending = {
            **review_record,
            "manual_review": {"status": "pending", "note": "", "updated_at": None},
        }
        review_result = {
            "schema_version": runner.MANUAL_REVIEW_RESULT_SCHEMA,
            "review_set_id": review_list["review_set_id"],
            "review_kind": "intelligence_finding",
            "summary": {"review_total": 1, "approved": 0, "rejected": 0, "pending": 1},
            "approved_records": [],
            "rejected_records": [],
            "pending_records": [pending],
        }

        with self.assertRaisesRegex(runner.CliError, "pending"):
            runner.build_final_output(validated, review_result, self.analysis_input, Path("/tmp/synthetic-report.md"))

    def test_model_request_uses_local_codex_and_fenced_json_is_parsed(self) -> None:
        request = runner.model_request("system prompt", self.analysis_input)
        user_payload = json.loads(request["messages"][1]["content"])

        self.assertEqual(request["executor"], runner.LOCAL_EXECUTOR)
        self.assertEqual(user_payload["analysis_input"]["input_id"], self.analysis_input["input_id"])
        self.assertEqual(runner.extract_model_json({"choices": [{"message": {"content": "```json\n{\"value\": 1}\n```"}}]}), {"value": 1})

    def test_request_completion_uses_persistent_local_codex_session(self) -> None:
        request = runner.model_request("system prompt", self.analysis_input)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "analysis-input.json"
            input_path.write_text(json.dumps(self.analysis_input), encoding="utf-8")

            def run(command, **_kwargs):
                response_path = Path(command[command.index("--output-last-message") + 1])
                response_path.write_text("{}", encoding="utf-8")
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout='{"type":"thread.started","thread_id":"synthetic-session"}\n',
                    stderr="",
                )

            with patch.object(runner.subprocess, "run", side_effect=run) as mocked_run:
                response = runner.request_completion(
                    request,
                    root / "run" / "codex-session.json",
                    input_path,
                )

            command = mocked_run.call_args.args[0]
            self.assertIn("--sandbox", command)
            self.assertIn("read-only", command)
            self.assertTrue((root / "run" / "codex-session.json").is_file())
        self.assertEqual(response["choices"][0]["message"]["content"], "{}")

    def test_candidate_rejects_paraphrased_evidence_quote(self) -> None:
        response = candidate_response()
        response["claims"][0]["evidence"][0]["quote"] = "Paraphrased statement."

        with self.assertRaisesRegex(runner.CliError, "exactly match"):
            runner.validate_candidate_response(response, self.analysis_input)

    def test_all_observations_coverage_is_checked_for_the_complete_claim_set(self) -> None:
        task = {**TASK, "coverage_mode": "all_observations"}
        snapshot = json.loads(json.dumps(SNAPSHOT))
        snapshot["clues"].append(
            {
                "clue_id": "clue-002",
                "source_url": "https://source.example/two",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "sha256:source-two",
                "observations": [
                    {
                        "observation_id": "observation-002",
                        "quote": "Second synthetic source statement.",
                    }
                ],
            }
        )
        analysis_input = runner.build_analysis_input(task, snapshot)
        response = candidate_response()
        response["claims"].append(
            {
                **response["claims"][0],
                "claim_id": "claim-002",
                "title": "Second synthetic finding",
                "statement": "The second source makes a synthetic statement.",
                "evidence": [
                    {
                        "clue_id": "clue-002",
                        "observation_id": "observation-002",
                        "relation": "supports",
                        "quote": "Second synthetic source statement.",
                    }
                ],
            }
        )
        response["framework"]["stages"].append(
            {
                "stage_id": "stage-002",
                "sequence": 2,
                "title": "Second synthetic foundation",
                "explanation": "The second source supplies another synthetic viewpoint.",
                "transition": "The synthetic progression is complete.",
                "claim_ids": ["claim-002"],
            }
        )

        validated = runner.validate_candidates(response, analysis_input)
        review_list = runner.manual_review_list(validated, analysis_input)

        self.assertEqual(len(review_list["review_records"]), 2)
        incomplete = json.loads(json.dumps(response))
        incomplete["claims"].pop()
        incomplete["framework"]["stages"].pop()
        with self.assertRaisesRegex(runner.CliError, "cover every observation"):
            runner.validate_candidates(incomplete, analysis_input)


if __name__ == "__main__":
    unittest.main()
