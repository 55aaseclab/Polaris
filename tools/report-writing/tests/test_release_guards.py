"""Offline tests for report release guards R-1/R-2/R-3 (PRD 3.12)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import runner  # noqa: E402


def analysis_output(claim_count: int) -> dict[str, object]:
    """Synthetic final analysis output with generic claims only."""
    return {
        "schema_version": runner.ANALYSIS_OUTPUT_SCHEMA,
        "analysis_id": "analysis-output:synthetic-case:0000000000000000",
        "analysis_kind": "literature-review",
        "status": "final",
        "analysis_context": {
            "question": "What does the synthetic evidence establish?",
            "decision_context": "Synthetic decision context.",
            "audience": "researchers",
        },
        "collection_snapshot": {
            "snapshot_id": "snapshot-synthetic",
            "sha256": "sha256:synthetic-snapshot",
        },
        "judgments": [
            {
                "claim_id": f"claim-{index:03d}",
                "title": f"Synthetic finding {index}",
                "statement": f"Synthetic statement {index}.",
                "classification": "new",
                "status": "supported",
                "confidence": 0.9,
                "limitations": [],
                "review_decision": {"status": "approved", "note": "ok"},
                "evidence": [
                    {
                        "clue_id": f"clue-{index:03d}",
                        "observation_id": f"observation-{index:03d}",
                        "source_url": f"https://source.example/{index}",
                        "quote": f"Synthetic quote {index}.",
                        "observed_at": "2026-01-01T00:00:00Z",
                        "locator": "paragraph=1",
                    }
                ],
            }
            for index in range(1, claim_count + 1)
        ],
        "rejected_claims": [],
        "unresolved": [],
        "search_scope": {
            "record_count": claim_count,
            "source_tasks": [
                {"task_id": "synthetic-task", "source_type": "bibliographic-search"}
            ],
            "rerun_command": "synthetic-collection run --input input.json",
        },
    }


def full_coverage_draft(
    report_input: dict[str, object],
    *,
    deep: bool = True,
) -> dict[str, object]:
    """Literature draft with dual-bound coverage; `deep=False` is checklist prose."""
    claim_ids = [claim["claim_id"] for claim in report_input["evidence_registry"]]
    markers = "".join(f"[@{claim_id}]" for claim_id in claim_ids)
    filler = (
        "Synthetic prose develops the thematic point with mechanisms, limits, "
        "and surrounding context stated plainly. "
    )
    if deep:
        body = [filler * 12 + markers, filler * 12, filler * 12]
    else:
        body = [
            f"Synthetic checklist sentence one.{markers}",
            "Synthetic checklist sentence two.",
            "Synthetic checklist sentence three.",
        ]
    sections = [
        {
            "section_id": "question",
            "paragraphs": [
                str(report_input["question"]),
                f"Decision context: {report_input['decision_context']}",
            ],
            "claim_ids": [],
            "subsections": [],
        },
        {
            "section_id": "search_scope",
            "paragraphs": ["Synthetic search scope paragraph."],
            "claim_ids": [],
            "subsections": [],
        },
        {
            "section_id": "findings",
            "paragraphs": [
                "Synthetic findings intro.",
                "The discussion proceeds through one synthetic theme.",
            ],
            "claim_ids": [],
            "subsections": [
                {
                    "heading": "Synthetic theme",
                    "paragraphs": body,
                    "claim_ids": claim_ids,
                    "subsections": [],
                },
                {
                    "heading": "Summary",
                    "paragraphs": [
                        "Synthetic summary paragraph.",
                        "Residual limits are stated plainly.",
                    ],
                    "claim_ids": [],
                    "subsections": [],
                },
            ],
        },
    ]
    return {
        "schema_version": runner.DRAFT_SCHEMA,
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "title": "Synthetic report",
        "sections": sections,
        "limitations": list(report_input["allowed_limitations"]),
    }


def passing_reviews(
    report_input: dict[str, object],
    draft: dict[str, object],
) -> dict[str, object]:
    return {
        "schema_version": runner.REVIEW_SCHEMA,
        "report_id": report_input["report_id"],
        "draft_sha256": runner.object_digest(draft),
        "reviews": [
            {
                "dimension": dimension,
                "score": 9,
                "status": "pass",
                "blocking_issues": [],
                "notes": ["Synthetic review pass."],
            }
            for dimension in runner.REVIEW_DIMENSIONS
        ],
    }


def gates_by_name(reviews: dict[str, object]) -> dict[str, dict[str, object]]:
    return {gate["name"]: gate for gate in reviews["gates"]}


class ReleaseGuardTests(unittest.TestCase):
    def test_r1_empty_registry_fails_review_and_marks_degraded(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, analysis_output(0), "literature-report")
        validated_input = runner.validate_report_input(report_input, TOOL_ROOT)
        draft = runner.validate_draft(
            runner.build_empty_evidence_draft(validated_input),
            validated_input,
            TOOL_ROOT,
        )
        reviews = runner.validate_reviews(
            passing_reviews(validated_input, draft),
            validated_input,
            draft,
            TOOL_ROOT,
        )

        # Model reviewers pass trivially with nothing to check, but the
        # deterministic R-1 gate fails the review.
        gates = gates_by_name(reviews)
        self.assertEqual(gates["registry-nonempty"]["status"], "fail")
        self.assertEqual(gates["registry-nonempty"]["registry_count"], 0)
        self.assertEqual(reviews["summary"]["gate_failures"], ["registry-nonempty"])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            reviews_path_out = root / "reviews-copy.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, validated_input)
            runner.write_json(draft_path, draft)
            runner.write_json(review_path, reviews)
            runner.write_json(reviews_path_out, reviews)

            passed, count = runner.workflow_report_passed(reviews_path_out)
            self.assertFalse(passed)
            self.assertEqual(count, len(runner.REVIEW_DIMENSIONS))

            # Final is not reachable: publish refuses with a stable gate code.
            with self.assertRaisesRegex(runner.CliError, "registry-nonempty"):
                runner.command_publish(
                    Namespace(
                        input=str(input_path),
                        draft=str(draft_path),
                        reviews=str(review_path),
                        output=str(report_path),
                        manifest=str(manifest_path),
                    ),
                    TOOL_ROOT,
                )

            result = runner.command_publish(
                Namespace(
                    input=str(input_path),
                    draft=str(draft_path),
                    reviews=str(review_path),
                    output=str(report_path),
                    manifest=str(manifest_path),
                    allow_residual=True,
                ),
                TOOL_ROOT,
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertNotEqual(manifest["status"], "final")
            self.assertEqual(manifest["status"], "degraded")
            publication = manifest["publication"]
            self.assertEqual(publication["status"], "degraded")
            self.assertIn("empty-registry", publication["degradedReason"])
            self.assertEqual(publication["registryCount"], 0)
            # The fixture records a reproduction config, so this failure is
            # isolated to the empty-registry guard.
            self.assertTrue(publication["provenanceComplete"])

    def test_r1_qualified_report_reaches_final(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, analysis_output(2), "literature-report")
        draft = runner.validate_draft(full_coverage_draft(report_input), report_input, TOOL_ROOT)
        reviews = runner.validate_reviews(
            passing_reviews(report_input, draft),
            report_input,
            draft,
            TOOL_ROOT,
        )

        gates = gates_by_name(reviews)
        self.assertEqual(gates["registry-nonempty"]["status"], "pass")
        self.assertEqual(gates["depth-floor"]["status"], "pass")
        self.assertEqual(reviews["summary"]["gate_failures"], [])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, draft)
            runner.write_json(review_path, reviews)

            result = runner.command_publish(
                Namespace(
                    input=str(input_path),
                    draft=str(draft_path),
                    reviews=str(review_path),
                    output=str(report_path),
                    manifest=str(manifest_path),
                ),
                TOOL_ROOT,
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "final")
            publication = manifest["publication"]
            self.assertEqual(publication["status"], "final")
            self.assertEqual(publication["registryCount"], 2)
            self.assertGreaterEqual(publication["bodyWords"], runner.MIN_BODY_WORDS)
            self.assertTrue(publication["provenanceComplete"])
            self.assertNotIn("degradedReason", publication)

    def test_r2_depth_floor_triggers_revise_without_failing_publish(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, analysis_output(2), "literature-report")
        draft = runner.validate_draft(
            full_coverage_draft(report_input, deep=False),
            report_input,
            TOOL_ROOT,
        )
        reviews = runner.validate_reviews(
            passing_reviews(report_input, draft),
            report_input,
            draft,
            TOOL_ROOT,
        )

        # Soft gate: model review items still pass; the gate records "short".
        self.assertTrue(all(item["status"] == "pass" for item in reviews["reviews"]))
        gates = gates_by_name(reviews)
        self.assertEqual(gates["registry-nonempty"]["status"], "pass")
        self.assertEqual(gates["depth-floor"]["status"], "short")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            reviews_path_out = root / "reviews-copy.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, draft)
            runner.write_json(review_path, reviews)
            runner.write_json(reviews_path_out, reviews)

            # The depth threshold enters the revise trigger.
            passed, _ = runner.workflow_report_passed(reviews_path_out)
            self.assertFalse(passed)

            # Publish still proceeds and the artifact is marked short-report.
            result = runner.command_publish(
                Namespace(
                    input=str(input_path),
                    draft=str(draft_path),
                    reviews=str(review_path),
                    output=str(report_path),
                    manifest=str(manifest_path),
                ),
                TOOL_ROOT,
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "short-report")
            publication = manifest["publication"]
            self.assertEqual(publication["status"], "short-report")
            self.assertIn("body-words-below-minimum", publication["degradedReason"])

            # After an expanded revise round the report can reach final.
            expanded = runner.validate_draft(
                full_coverage_draft(report_input),
                report_input,
                TOOL_ROOT,
            )
            expanded_path = root / "draft-expanded.json"
            runner.write_json(expanded_path, expanded)
            reviews_final = runner.validate_reviews(
                passing_reviews(report_input, expanded),
                report_input,
                expanded,
                TOOL_ROOT,
            )
            self.assertEqual(
                gates_by_name(reviews_final)["depth-floor"]["status"],
                "pass",
            )
            reviews_final_path = root / "reviews-final.json"
            runner.write_json(reviews_final_path, reviews_final)
            result = runner.command_publish(
                Namespace(
                    input=str(input_path),
                    draft=str(expanded_path),
                    reviews=str(reviews_final_path),
                    output=str(report_path),
                    manifest=str(manifest_path),
                ),
                TOOL_ROOT,
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "final")

    def test_r3_missing_provenance_marks_degraded(self) -> None:
        output = analysis_output(2)
        output["search_scope"] = {}
        report_input = runner.build_report_input(TOOL_ROOT, output, "literature-report")
        draft = runner.validate_draft(full_coverage_draft(report_input), report_input, TOOL_ROOT)
        reviews = runner.validate_reviews(
            passing_reviews(report_input, draft),
            report_input,
            draft,
            TOOL_ROOT,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, draft)
            runner.write_json(review_path, reviews)

            result = runner.command_publish(
                Namespace(
                    input=str(input_path),
                    draft=str(draft_path),
                    reviews=str(review_path),
                    output=str(report_path),
                    manifest=str(manifest_path),
                ),
                TOOL_ROOT,
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "degraded")
            publication = manifest["publication"]
            self.assertFalse(publication["provenanceComplete"])
            self.assertIn("provenance-incomplete", publication["degradedReason"])
            self.assertIn("not recorded", publication["guidance"])
            # The provenance block records the digest but not the missing config.
            provenance = manifest["provenance"]
            self.assertTrue(str(provenance["report_input_sha256"]).startswith("sha256:"))
            self.assertEqual(provenance["source_tasks"], [])
            self.assertEqual(provenance["rerun_command"], "")

    def test_publication_state_carries_data_dictionary_fields(self) -> None:
        qualified = runner.build_report_input(TOOL_ROOT, analysis_output(2), "literature-report")
        deep_draft = full_coverage_draft(qualified)
        state = runner.publication_state(qualified, deep_draft)
        for field in ("status", "registryCount", "bodyWords", "provenanceComplete"):
            self.assertIn(field, state)
        self.assertEqual(state["status"], "final")
        self.assertNotIn("degradedReason", state)

        degraded = runner.build_report_input(TOOL_ROOT, analysis_output(0), "literature-report")
        shallow_state = runner.publication_state(degraded, full_coverage_draft(degraded, deep=False))
        for field in ("status", "registryCount", "bodyWords", "provenanceComplete", "degradedReason"):
            self.assertIn(field, shallow_state)
        self.assertNotEqual(shallow_state["status"], "final")
        self.assertIn("empty-registry", shallow_state["degradedReason"])
        self.assertIn("body-words-below-minimum", shallow_state["degradedReason"])

    def test_reviews_require_all_configured_dimensions(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, analysis_output(2), "literature-report")
        draft = full_coverage_draft(report_input)
        reviews = passing_reviews(report_input, draft)
        reviews["reviews"] = reviews["reviews"][:-1]
        with self.assertRaisesRegex(runner.CliError, "reviewer dimensions"):
            runner.validate_reviews(reviews, report_input, draft, TOOL_ROOT)


if __name__ == "__main__":
    unittest.main()
