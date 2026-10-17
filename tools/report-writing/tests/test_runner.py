"""Offline contract tests for clue-report-writing."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import runner  # noqa: E402


ANALYSIS_OUTPUT = {
    "schema_version": runner.ANALYSIS_OUTPUT_SCHEMA,
    "analysis_id": "analysis-output:case-example:0000000000000000",
    "analysis_kind": "literature-review",
    "status": "final",
    "analysis_context": {
        "question": "What does the approved evidence establish?",
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
    },
    "collection_snapshot": {
        "snapshot_id": "snapshot-example",
        "sha256": "sha256:snapshot-example",
    },
    "judgments": [
        {
            "claim_id": "claim-001",
            "title": "Synthetic finding",
            "statement": "The approved source makes a synthetic statement.",
            "classification": "new",
            "status": "supported",
            "confidence": 0.9,
            "limitations": ["Only one synthetic source is available."],
            "review_decision": {"status": "approved", "note": "Synthetic confirmation."},
            "evidence": [
                {
                    "clue_id": "clue-001",
                    "observation_id": "observation-001",
                    "source_url": "https://source.example/one",
                    "quote": "Synthetic source statement.",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "locator": "paragraph=1",
                }
            ],
        }
    ],
    "rejected_claims": [],
    "unresolved": [],
}


def build_draft(report_input: dict[str, object]) -> dict[str, object]:
    sections = []
    all_claim_ids = [claim["claim_id"] for claim in report_input["evidence_registry"]]
    for section in report_input["template"]["sections"]:
        section_id = section["section_id"]
        claim_ids = list(all_claim_ids) if section["claims_required"] else []
        entry: dict[str, object] = {
            "section_id": section_id,
            "paragraphs": [f"Synthetic prose for {section_id}."],
            "claim_ids": claim_ids,
            "subsections": [],
        }
        if section_id == "findings" and claim_ids:
            entry["paragraphs"] = ["Synthetic overview of the literature."]
            entry["claim_ids"] = []
            # Inline markers are required for literature-style fused citations.
            markers = "".join(f"[@{claim_id}]" for claim_id in claim_ids)
            entry["subsections"] = [
                {
                    "heading": "Synthetic theme",
                    "paragraphs": [
                        f"Synthetic subsection prose for findings fuses the literature{markers}."
                    ],
                    "claim_ids": claim_ids,
                }
            ]
        sections.append(entry)
    return {
        "schema_version": runner.DRAFT_SCHEMA,
        "report_id": report_input["report_id"],
        "template_id": report_input["template"]["template_id"],
        "title": "Synthetic report",
        "sections": sections,
        "limitations": list(report_input["allowed_limitations"]),
    }


def passing_reviews(report_input: dict[str, object], draft: dict[str, object]) -> dict[str, object]:
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


def empty_literature_analysis_output() -> dict[str, object]:
    output = json.loads(json.dumps(ANALYSIS_OUTPUT))
    output["judgments"] = []
    output["unresolved"] = ["No successful source task produced records."]
    output["search_scope"] = {
        "record_count": 0,
        "source_tasks": [
            {"task_id": "synthetic-search", "source_type": "bibliographic-search"}
        ],
        "scope": {"time_range": "2024..2026", "include": ["synthetic topic"]},
        "information_gaps": ["No bibliographic records were returned."],
    }
    return output


class ReportWritingTests(unittest.TestCase):
    def setUp(self) -> None:
        # Default fixture is a management memo draft path, not literature auto-route.
        self.report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "decision-memo")

    def test_auto_template_routes_management_output_to_decision_memo(self) -> None:
        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        output["analysis_kind"] = "business-intelligence"
        report_input = runner.build_report_input(TOOL_ROOT, output, "auto")
        self.assertEqual(report_input["template"]["template_id"], "decision-memo")
        self.assertEqual(report_input["evidence_registry"][0]["claim_id"], "claim-001")
        self.assertEqual(len(report_input["references"]), 1)

    def test_literature_analysis_routes_to_literature_report(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "auto")
        # ANALYSIS_OUTPUT uses analysis_kind literature-review.
        self.assertEqual(report_input["template"]["template_id"], "literature-report")
        self.assertEqual(report_input["template"]["draft_prompt"], "draft-literature.v1.md")
        self.assertTrue(report_input["template"]["require_full_claim_coverage"])
        self.assertEqual(
            [section["section_id"] for section in report_input["template"]["sections"]],
            ["question", "search_scope", "findings"],
        )

    def test_workflow_prepare_freezes_the_actual_analysis_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis_path = root / "analysis-output.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            runner.write_json(analysis_path, ANALYSIS_OUTPUT)
            runner.write_json(
                request_path,
                {
                    "runId": "run-synthetic",
                    "workspaceRoot": str(root / "workspace"),
                    "input": {
                        "analysisOutputRef": str(analysis_path),
                        "reportTemplate": "literature-report",
                    },
                },
            )

            result = runner.command_workflow(
                Namespace(
                    input=str(request_path),
                    output=str(output_path),
                    step_command="prepare",
                ),
                TOOL_ROOT,
            )

            self.assertEqual(result, 0)
            output = runner.read_json(output_path, "workflow output")
            self.assertEqual(output["selectedTemplate"], "literature-report")
            frozen = runner.read_json(Path(output["reportInputRef"]), "report input")
            self.assertEqual(frozen["source"]["analysis_output_id"], ANALYSIS_OUTPUT["analysis_id"])
            self.assertEqual(frozen["report_id"], "report-run-synthetic")

    def test_zero_result_literature_input_allows_empty_references(self) -> None:
        report_input = runner.build_report_input(
            TOOL_ROOT,
            empty_literature_analysis_output(),
            "literature-report",
        )

        self.assertEqual(report_input["evidence_registry"], [])
        self.assertEqual(report_input["references"], [])
        validated_input = runner.validate_report_input(report_input, TOOL_ROOT)
        draft = runner.validate_draft(
            runner.build_empty_evidence_draft(validated_input),
            validated_input,
            TOOL_ROOT,
        )
        markdown = runner.render_markdown(validated_input, draft)
        self.assertIn("No evidence-bound findings are asserted.", markdown)
        self.assertNotIn("[@", markdown)
        self.assertEqual(runner.render_bib([]), "\n")
        self.assertIn(r"\begin{thebibliography}{99}", runner.render_latex(validated_input, draft))

    def test_zero_result_literature_run_writes_all_report_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            analysis_path = root / "analysis-output.json"
            report_input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            tex_path = root / "report.tex"
            bib_path = root / "references.bib"
            pdf_path = root / "report.pdf"
            markdown_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(analysis_path, empty_literature_analysis_output())

            result = runner.command_run(
                Namespace(
                    analysis_output=str(analysis_path),
                    template="literature-report",
                    report_input=str(report_input_path),
                    draft=str(draft_path),
                    tex=str(tex_path),
                    bib=str(bib_path),
                    output=str(pdf_path),
                    report_markdown=str(markdown_path),
                    report_manifest=str(manifest_path),
                    report_id="synthetic-empty-report",
                    claim_filter=None,
                    run_dir=None,
                ),
                TOOL_ROOT,
            )

            self.assertEqual(result, 0)
            self.assertEqual(
                json.loads(report_input_path.read_text(encoding="utf-8"))["references"],
                [],
            )
            self.assertTrue(draft_path.is_file())
            self.assertTrue(tex_path.is_file())
            self.assertTrue(bib_path.is_file())
            self.assertEqual(bib_path.read_text(encoding="utf-8"), "\n")
            self.assertTrue(pdf_path.is_file())
            self.assertGreater(pdf_path.stat().st_size, 0)
            self.assertTrue(markdown_path.is_file())
            self.assertIn(
                "No evidence-bound findings are asserted.",
                markdown_path.read_text(encoding="utf-8"),
            )
            report = json.loads(manifest_path.read_text(encoding="utf-8"))
            # An empty registry cannot publish as final (release guard R-1).
            self.assertEqual(report["status"], "degraded")
            self.assertIn("empty-registry", report["publication"]["degradedReason"])
            self.assertEqual(report["review"], {"mode": "fixed", "status": "not_run"})

    def test_explicit_report_id_is_preserved_in_the_frozen_report_input(self) -> None:
        report_input = runner.build_report_input(
            TOOL_ROOT,
            ANALYSIS_OUTPUT,
            "literature-report",
            report_id="synthetic-report-id",
        )

        self.assertEqual(report_input["report_id"], "synthetic-report-id")

    def test_report_input_copies_prompt_fields_from_analysis_context(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "literature-report")
        self.assertEqual(report_input["question_prompt"]["method"], "generate-text")
        self.assertEqual(report_input["decision_context_prompt"]["output_kind"], "text")
        self.assertEqual(report_input["audience_prompt"]["method"], "derive")

    def test_literature_draft_requires_full_claim_coverage(self) -> None:
        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        output["judgments"].append(
            {
                "claim_id": "claim-002",
                "title": "Second synthetic finding",
                "statement": "A second approved source makes another synthetic statement.",
                "classification": "new",
                "status": "supported",
                "confidence": 0.8,
                "limitations": [],
                "review_decision": {"status": "approved", "note": "Synthetic confirmation."},
                "evidence": [
                    {
                        "clue_id": "clue-002",
                        "observation_id": "observation-002",
                        "source_url": "https://source.example/two",
                        "quote": "Second synthetic source statement.",
                        "observed_at": "2026-01-01T00:00:00Z",
                        "locator": "paragraph=1",
                    }
                ],
            }
        )
        report_input = runner.build_report_input(TOOL_ROOT, output, "literature-report")
        draft = build_draft(report_input)
        findings = next(section for section in draft["sections"] if section["section_id"] == "findings")
        findings["subsections"][0]["claim_ids"] = ["claim-001"]
        with self.assertRaisesRegex(runner.CliError, "every evidence_registry claim_id"):
            runner.validate_draft(draft, report_input, TOOL_ROOT)

    def test_run_parser_accepts_one_complete_report_operation(self) -> None:
        args = runner.build_parser().parse_args(
            [
                "run",
                "--analysis-output",
                "analysis.json",
                "--report-input",
                "report-input.json",
                "--draft",
                "draft.json",
                "--tex",
                "report.tex",
                "--bib",
                "references.bib",
                "--output",
                "report.pdf",
            ]
        )

        self.assertEqual(args.command, "run")
        self.assertEqual(args.template, "auto")

    def test_risk_content_routes_to_risk_brief(self) -> None:
        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        output["analysis_kind"] = "business-intelligence"
        output["unresolved"] = ["Synthetic unresolved issue."]

        report_input = runner.build_report_input(TOOL_ROOT, output, "auto")

        self.assertEqual(report_input["template"]["template_id"], "risk-brief")

    def test_framework_routes_to_system_template_and_renders_progression(self) -> None:
        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        output["analysis_kind"] = "business-intelligence"
        output["framework"] = {
            "title": "Synthetic viewpoint framework",
            "stages": [
                {
                    "stage_id": "stage-001",
                    "sequence": 1,
                    "title": "Synthetic foundation",
                    "explanation": "The first synthetic viewpoint is established.",
                    "transition": "The next stage expands the same claim.",
                    "claim_ids": ["claim-001"],
                },
                {
                    "stage_id": "stage-002",
                    "sequence": 2,
                    "title": "Synthetic extension",
                    "explanation": "The second synthetic viewpoint extends the first.",
                    "transition": "The framework stops after this extension.",
                    "claim_ids": ["claim-001"],
                },
            ],
        }

        report_input = runner.build_report_input(TOOL_ROOT, output, "auto")
        draft = runner.validate_draft(build_draft(report_input), report_input, TOOL_ROOT)
        markdown = runner.render_markdown(report_input, draft)

        self.assertEqual(report_input["template"]["template_id"], "system-framework")
        self.assertIn("Viewpoint Framework", markdown)
        self.assertIn("Synthetic extension", markdown)

    def test_draft_rejects_unknown_claim(self) -> None:
        draft = build_draft(self.report_input)
        draft["sections"][0]["claim_ids"] = ["claim-unknown"]

        with self.assertRaisesRegex(runner.CliError, "unknown claim"):
            runner.validate_draft(draft, self.report_input, TOOL_ROOT)

    def test_passing_reviews_publish_evidence_bound_markdown(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        reviews = runner.validate_reviews(passing_reviews(self.report_input, draft), self.report_input, draft, TOOL_ROOT)

        self.assertEqual(reviews["summary"]["pass_count"], len(runner.REVIEW_DIMENSIONS))
        markdown = runner.render_markdown(self.report_input, draft)
        self.assertIn("Synthetic finding", markdown)
        self.assertIn("https://source.example/one", markdown)
        self.assertIn("Only one synthetic source is available.", markdown)
        self.assertIn("Known Limitations", markdown)

    def test_rendering_strips_markup_without_mutating_raw_evidence(self) -> None:
        report_input = json.loads(json.dumps(self.report_input))
        raw_quote = "<jats:p>Marked up <italic>source</italic> statement.</jats:p>"
        report_input["evidence_registry"][0]["evidence"][0]["quote"] = raw_quote
        draft = runner.validate_draft(build_draft(report_input), report_input, TOOL_ROOT)

        markdown = runner.render_markdown(report_input, draft)

        self.assertIn("Marked up source statement.", markdown)
        self.assertNotIn("<jats:p>", markdown)
        self.assertEqual(report_input["evidence_registry"][0]["evidence"][0]["quote"], raw_quote)

    def test_latex_uses_tex_style_english_quotation_marks(self) -> None:
        rendered = runner.latex_escape(
            'A "quoted" phrase, “another quote”, and \'an apostrophe\'.'
        )

        self.assertEqual(
            rendered,
            "A ``quoted'' phrase, ``another quote'', and ``an apostrophe''.",
        )

    def test_reviewer_pass_cannot_hide_blocking_issue(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        review = passing_reviews(self.report_input, draft)
        review["reviews"][0]["blocking_issues"] = [
            {
                "section_id": "decision-headline",
                "problem": "Synthetic issue.",
                "suggested_fix": "Synthetic fix.",
            }
        ]

        validated = runner.validate_reviews(review, self.report_input, draft, TOOL_ROOT)
        self.assertEqual(validated["reviews"][0]["status"], "revise")
        self.assertEqual(validated["summary"]["revise_count"], 1)
        self.assertEqual(
            validated["reviews"][0]["blocking_issues"][0]["problem"],
            "Synthetic issue.",
        )

    def test_reviewer_score_coerces_numeric_strings_and_invalid_values(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        review = passing_reviews(self.report_input, draft)
        review["reviews"][0]["score"] = "9"
        review["reviews"][1]["score"] = 8.0
        review["reviews"][2]["score"] = "medium"
        review["reviews"][2]["status"] = "pass"
        review["reviews"][3]["score"] = None

        validated = runner.validate_reviews(review, self.report_input, draft, TOOL_ROOT)
        self.assertEqual(validated["reviews"][0]["score"], 9)
        self.assertEqual(validated["reviews"][0]["status"], "pass")
        self.assertEqual(validated["reviews"][1]["score"], 8)
        self.assertEqual(validated["reviews"][1]["status"], "pass")
        self.assertEqual(validated["reviews"][2]["score"], 1)
        self.assertEqual(validated["reviews"][2]["status"], "revise")
        self.assertEqual(validated["reviews"][3]["score"], 1)
        self.assertEqual(validated["reviews"][3]["status"], "revise")
        self.assertEqual(validated["summary"]["revise_count"], 2)

    def test_reviewer_pass_with_low_score_and_no_issues_stays_pass(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        review = passing_reviews(self.report_input, draft)
        review["reviews"][1]["score"] = 1
        review["reviews"][1]["status"] = "pass"
        review["reviews"][1]["blocking_issues"] = []

        validated = runner.validate_reviews(review, self.report_input, draft, TOOL_ROOT)
        self.assertEqual(validated["reviews"][1]["status"], "pass")
        self.assertEqual(validated["reviews"][1]["score"], 1)
        self.assertEqual(validated["summary"]["pass_count"], len(runner.REVIEW_DIMENSIONS))
        self.assertTrue(
            any("treating as pass" in note for note in validated["reviews"][1]["notes"])
        )

    def test_publish_command_writes_markdown_and_manifest(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        reviews = runner.validate_reviews(passing_reviews(self.report_input, draft), self.report_input, draft, TOOL_ROOT)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, self.report_input)
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
            self.assertTrue(report_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            # The synthetic fixture records no collection reproduction config,
            # so the publication guard marks the manifest degraded.
            self.assertEqual(manifest["status"], "degraded")
            self.assertEqual(manifest["publication"]["status"], "degraded")
            self.assertIn("provenance-incomplete", manifest["publication"]["degradedReason"])
            self.assertEqual(manifest["review"]["status"], "passed")

    def test_publish_command_rejects_residual_reviews_unless_allowed(self) -> None:
        draft = runner.validate_draft(build_draft(self.report_input), self.report_input, TOOL_ROOT)
        reviews = passing_reviews(self.report_input, draft)
        reviews["reviews"][0]["status"] = "revise"
        reviews["reviews"][0]["score"] = 2
        reviews["reviews"][0]["blocking_issues"] = [
            {
                "section_id": "decision-headline",
                "problem": "Synthetic residual issue.",
                "suggested_fix": "Keep the residual issue in the published report.",
            }
        ]
        reviews = runner.validate_reviews(reviews, self.report_input, draft, TOOL_ROOT)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            review_path = root / "reviews.json"
            report_path = root / "report.md"
            manifest_path = root / "report.json"
            runner.write_json(input_path, self.report_input)
            runner.write_json(draft_path, draft)
            runner.write_json(review_path, reviews)

            with self.assertRaisesRegex(runner.CliError, "cannot publish"):
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
            manifest = runner.read_json(manifest_path, "manifest")
            self.assertEqual(manifest["status"], "degraded")
            self.assertEqual(manifest["review"]["status"], "residual")
            self.assertEqual(manifest["review"]["blocked_dimensions"], ["unity"])

    def test_local_codex_request_uses_an_attachment_and_persistent_session(self) -> None:
        request = runner.model_request("system prompt", {"instruction": "Return JSON."})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            input_path.write_text("{}", encoding="utf-8")
            session_path = root / "run" / "codex-session.json"

            def run(command, **_kwargs):
                response_path = Path(command[command.index("--output-last-message") + 1])
                response_path.write_text("{}", encoding="utf-8")
                thread_id = (
                    "synthetic-session-resume"
                    if "resume" in command
                    else "synthetic-session"
                )
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=f'{{"type":"thread.started","thread_id":"{thread_id}"}}\n',
                    stderr="",
                )

            with patch.object(runner.subprocess, "run", side_effect=run) as mocked_run:
                response = runner.request_codex(
                    request,
                    [("report input", input_path)],
                    session_path,
                )
                second = runner.request_codex(
                    request,
                    [("report input", input_path)],
                    session_path,
                )

            first_command = mocked_run.call_args_list[0].args[0]
            second_command = mocked_run.call_args_list[1].args[0]
            self.assertEqual(request["executor"], runner.LOCAL_EXECUTOR)
            self.assertIn("--sandbox", first_command)
            self.assertIn("read-only", first_command)
            self.assertIn("-m", first_command)
            self.assertEqual(
                first_command[first_command.index("-m") + 1],
                runner.DEFAULT_REPORT_MODEL,
            )
            self.assertIn("-c", first_command)
            self.assertIn('model_reasoning_effort="low"', first_command)
            self.assertIn("--add-dir", first_command)
            self.assertTrue(session_path.is_file())
            self.assertEqual(runner.extract_model_json(response), {})
            self.assertEqual(response.get("model"), runner.DEFAULT_REPORT_MODEL)
            self.assertEqual(response.get("model_reasoning_effort"), "low")
            self.assertFalse(response.get("session_resumed"))
            self.assertIn("resume", second_command)
            self.assertIn("synthetic-session", second_command)
            self.assertIn("--sandbox", second_command)
            self.assertIn("read-only", second_command)
            self.assertIn("--add-dir", second_command)
            self.assertNotIn(str(input_path.parent), first_command)
            self.assertTrue(any("codex-report-attachments-" in str(part) for part in first_command))
            self.assertTrue(second.get("session_resumed"))
            case_input = root / "case" / "inputs" / "input.json"
            case_input.parent.mkdir(parents=True)
            case_input.write_text("{}", encoding="utf-8")
            stable = runner.resolve_codex_session_path(report_input=case_input)
            self.assertEqual(stable, (root / "case" / "runs" / "codex-session.json").resolve())

    def test_review_reuses_completed_dimension_responses(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "decision-memo")
        draft = build_draft(report_input)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "report-input.json"
            draft_path = root / "draft.json"
            output_path = root / "reviews.json"
            run_dir = root / "runs"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, draft)
            draft_digest = runner.object_digest(draft)
            cache_dir = run_dir / f"review-{draft_digest.split(':', 1)[-1][:16]}"
            cache_dir.mkdir(parents=True)
            for dimension in ("unity", "support"):
                runner.write_json(
                    cache_dir / f"{dimension}-response.json",
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": json.dumps(
                                        {
                                            "dimension": dimension,
                                            "score": 9,
                                            "status": "pass",
                                            "blocking_issues": [],
                                            "notes": ["reused"],
                                        }
                                    )
                                }
                            }
                        ]
                    },
                )

            remaining = iter(("coherence", "sentence_skills", "depth"))

            def fake_request_codex(_request, _attachments, _session_path, **_kwargs):
                dimension = next(remaining)
                return {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "dimension": dimension,
                                        "score": 8,
                                        "status": "pass",
                                        "blocking_issues": [],
                                        "notes": ["fresh"],
                                    }
                                )
                            }
                        }
                    ]
                }

            with patch.object(runner, "request_codex", side_effect=fake_request_codex) as mocked:
                result = runner.command_review(
                    Namespace(
                        input=str(input_path),
                        draft=str(draft_path),
                        output=str(output_path),
                        run_dir=str(run_dir),
                    ),
                    TOOL_ROOT,
                )

            self.assertEqual(result, 0)
            self.assertEqual(mocked.call_count, 3)
            reviews = runner.read_json(output_path, "reviews")
            self.assertEqual([item["dimension"] for item in reviews["reviews"]], list(runner.REVIEW_DIMENSIONS))
            self.assertEqual(reviews["reviews"][0]["notes"], ["reused"])
            self.assertEqual(reviews["reviews"][1]["notes"], ["reused"])
            self.assertEqual(reviews["reviews"][2]["notes"], ["fresh"])
            self.assertEqual(reviews["reviews"][3]["notes"], ["fresh"])
            self.assertEqual(reviews["reviews"][4]["notes"], ["fresh"])

    def test_workflow_publish_rereviews_when_reviews_belong_to_old_draft(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "decision-memo")
        draft = runner.validate_draft(build_draft(report_input), report_input, TOOL_ROOT)
        stale = passing_reviews(report_input, draft)
        stale["draft_sha256"] = "sha256:stale"
        revised = json.loads(json.dumps(draft))
        revised["title"] = "Revised synthetic report"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            report_root = workspace / "report"
            report_root.mkdir(parents=True)
            input_path = report_root / "report-input.json"
            draft_path = report_root / "draft.json"
            reviews_path = report_root / "reviews.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, revised)
            runner.write_json(reviews_path, stale)
            runner.write_json(
                request_path,
                {
                    "runId": "run-synthetic",
                    "workspaceRoot": str(workspace),
                    "input": {
                        "reportInputRef": str(input_path),
                        "draftRef": str(draft_path),
                        "reviewsRef": str(reviews_path),
                    },
                },
            )

            def fake_review(args, _root):
                current = runner.read_json(Path(args.draft), "report draft")
                reviews = runner.validate_reviews(
                    passing_reviews(report_input, current),
                    report_input,
                    current,
                    TOOL_ROOT,
                )
                runner.write_json(Path(args.output), reviews)
                return 0

            def fake_revise(args, _root):
                current = runner.read_json(Path(args.draft), "report draft")
                runner.write_json(Path(args.output), current)
                return 0

            # The depth-floor gate keeps the tiny fixture draft below the
            # revise threshold, so publish runs one extra revise round.
            with (
                patch.object(runner, "command_review", side_effect=fake_review) as mocked,
                patch.object(runner, "command_revise", side_effect=fake_revise),
            ):
                result = runner.command_workflow(
                    Namespace(
                        input=str(request_path),
                        output=str(output_path),
                        step_command="publish",
                    ),
                    TOOL_ROOT,
                )

            self.assertEqual(result, 0)
            self.assertEqual(mocked.call_count, 2)
            self.assertTrue((report_root / "report.md").is_file())
            published = runner.read_json(report_root / "report.json", "manifest")
            self.assertEqual(published["status"], "degraded")
            self.assertEqual(published["draft_sha256"], runner.object_digest(revised))
            self.assertEqual(published["review"]["status"], "passed")

    def test_workflow_publish_allows_residual_reviews_after_extra_revise(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "decision-memo")
        draft = runner.validate_draft(build_draft(report_input), report_input, TOOL_ROOT)
        residual = passing_reviews(report_input, draft)
        residual["reviews"][0]["status"] = "revise"
        residual["reviews"][0]["score"] = 2
        residual["reviews"][0]["blocking_issues"] = [
            {
                "section_id": "decision-headline",
                "problem": "Synthetic residual issue.",
                "suggested_fix": "Keep the residual issue in the published report.",
            }
        ]
        residual = runner.validate_reviews(residual, report_input, draft, TOOL_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            report_root = workspace / "report"
            report_root.mkdir(parents=True)
            input_path = report_root / "report-input.json"
            draft_path = report_root / "draft.json"
            reviews_path = report_root / "reviews.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            runner.write_json(input_path, report_input)
            runner.write_json(draft_path, draft)
            runner.write_json(reviews_path, residual)
            runner.write_json(
                request_path,
                {
                    "runId": "run-synthetic",
                    "workspaceRoot": str(workspace),
                    "input": {
                        "reportInputRef": str(input_path),
                        "draftRef": str(draft_path),
                        "reviewsRef": str(reviews_path),
                    },
                },
            )

            def fake_review(args, _root):
                current = runner.read_json(Path(args.draft), "report draft")
                reviews = runner.validate_reviews(residual, report_input, current, TOOL_ROOT)
                runner.write_json(Path(args.output), reviews)
                return 0

            def fake_revise(args, _root):
                current = runner.read_json(Path(args.draft), "report draft")
                runner.write_json(Path(args.output), current)
                return 0

            with (
                patch.object(runner, "command_review", side_effect=fake_review),
                patch.object(runner, "command_revise", side_effect=fake_revise) as mocked_revise,
            ):
                result = runner.command_workflow(
                    Namespace(
                        input=str(request_path),
                        output=str(output_path),
                        step_command="publish",
                    ),
                    TOOL_ROOT,
                )

            self.assertEqual(result, 0)
            self.assertEqual(mocked_revise.call_count, 1)
            published = runner.read_json(report_root / "report.json", "manifest")
            self.assertEqual(published["status"], "degraded")
            self.assertEqual(published["review"]["status"], "residual")
            self.assertEqual(published["review"]["blocked_dimensions"], ["unity"])

    def test_literature_rejects_oversized_cite_clusters(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "literature-report")
        # Pad registry so a 6-id cluster is possible.
        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        for index in range(2, 7):
            output["judgments"].append(
                {
                    "claim_id": f"claim-00{index}",
                    "title": f"Synthetic finding {index}",
                    "statement": f"Synthetic statement {index}.",
                    "classification": "new",
                    "status": "supported",
                    "confidence": 0.8,
                    "limitations": [],
                    "review_decision": {"status": "approved", "note": "ok"},
                    "evidence": [
                        {
                            "clue_id": f"clue-00{index}",
                            "observation_id": f"observation-00{index}",
                            "source_url": f"https://source.example/{index}",
                            "quote": f"Quote {index}.",
                            "observed_at": "2026-01-01T00:00:00Z",
                            "locator": "paragraph=1",
                        }
                    ],
                }
            )
        report_input = runner.build_report_input(TOOL_ROOT, output, "literature-report")
        draft = build_draft(report_input)
        findings = next(section for section in draft["sections"] if section["section_id"] == "findings")
        claim_ids = [claim["claim_id"] for claim in report_input["evidence_registry"]]
        findings["subsections"][0]["claim_ids"] = claim_ids
        findings["subsections"][0]["paragraphs"] = [
            "Bulk dump [@" + ";".join(claim_ids) + "]."
        ]
        with self.assertRaisesRegex(runner.CliError, "oversized"):
            runner.validate_draft(draft, report_input, TOOL_ROOT)

    def test_partition_and_arguments_cover_all_claims(self) -> None:
        import literature_pipeline as pipeline

        output = json.loads(json.dumps(ANALYSIS_OUTPUT))
        for index in range(2, 25):
            output["judgments"].append(
                {
                    "claim_id": f"claim-{index:03d}",
                    "title": f"Finding {index}",
                    "statement": f"Statement {index}.",
                    "classification": "new",
                    "status": "supported" if index % 5 else "insufficient_evidence",
                    "confidence": 0.9 if index % 5 else 0.4,
                    "limitations": [],
                    "review_decision": {"status": "approved", "note": "ok"},
                    "evidence": [
                        {
                            "clue_id": f"clue-{index:03d}",
                            "observation_id": f"obs-{index:03d}",
                            "source_url": f"https://source.example/{index}",
                            "quote": f"Quote {index}.",
                            "observed_at": "2026-01-01T00:00:00Z",
                            "locator": "paragraph=1",
                        }
                    ],
                }
            )
        report_input = runner.build_report_input(TOOL_ROOT, output, "literature-report")
        cards = pipeline.claim_cards(report_input)
        batches = pipeline.partition_claim_cards(cards, report_input, batch_size=10)
        self.assertGreaterEqual(len(batches), 2)
        flat = [card["claim_id"] for batch in batches for card in batch]
        self.assertEqual(len(flat), len(cards))
        self.assertEqual(set(flat), {card["claim_id"] for card in cards})

        registry_ids = {claim["claim_id"] for claim in report_input["evidence_registry"]}
        half = sorted(registry_ids)[: len(registry_ids) // 2]
        rest = sorted(registry_ids)[len(registry_ids) // 2 :]
        arguments = pipeline.validate_arguments_document(
            {
                "schema_version": pipeline.ARGUMENTS_SCHEMA,
                "arguments": [
                    {
                        "argument_id": "A01",
                        "thesis": "First main argument.",
                        "role": "established",
                        "themes": ["a"],
                        "claim_ids": half,
                    },
                    {
                        "argument_id": "A02",
                        "thesis": "Second main argument.",
                        "role": "thin",
                        "themes": ["b"],
                        "claim_ids": rest,
                    },
                ],
            },
            registry_ids,
        )
        outline = pipeline.validate_outline_document(
            {
                "schema_version": pipeline.OUTLINE_SCHEMA,
                "title": "Synthetic outline",
                "findings": [
                    {
                        "subsection_id": "S1",
                        "heading": "Theme one",
                        "argument_ids": ["A01"],
                        "subsubsections": [
                            {
                                "subsubsection_id": "S1.1",
                                "heading": "Theme one part A",
                                "points": ["Develop first half"],
                            },
                            {
                                "subsubsection_id": "S1.2",
                                "heading": "Theme one part B",
                                "points": ["Develop second half"],
                            },
                        ],
                    },
                    {
                        "subsection_id": "S2",
                        "heading": "Theme two",
                        "argument_ids": ["A02"],
                        "subsubsections": [
                            {
                                "subsubsection_id": "S2.1",
                                "heading": "Theme two core",
                                "points": ["Develop second argument"],
                            },
                            {
                                "subsubsection_id": "S2.2",
                                "heading": "Theme two edge",
                                "points": ["Note residual limits"],
                            },
                        ],
                    },
                ],
            },
            arguments,
        )
        self.assertEqual(len(outline["findings"]), 2)
        self.assertEqual(
            set(outline["findings"][0]["claim_ids"]) | set(outline["findings"][1]["claim_ids"]),
            registry_ids,
        )
        self.assertGreaterEqual(len(outline["findings"][0]["subsubsections"]), 2)
        # Every kept subsub has at least the minimum claim budget.
        for node in outline["findings"]:
            for sub in node["subsubsections"]:
                self.assertGreaterEqual(
                    len(sub["claim_ids"]),
                    pipeline.MIN_CLAIMS_PER_SUBSUBSECTION,
                )

        # Thin themes (below 2 × MIN_CLAIMS_PER_SUBSUBSECTION) stay flat.
        thin_half = half[: max(1, pipeline.MIN_CLAIMS_PER_SUBSUBSECTION)]
        thin_args = pipeline.validate_arguments_document(
            {
                "schema_version": pipeline.ARGUMENTS_SCHEMA,
                "arguments": [
                    {
                        "argument_id": "A_thin",
                        "thesis": "Thin theme.",
                        "role": "thin",
                        "themes": ["thin"],
                        "claim_ids": thin_half,
                    },
                    {
                        "argument_id": "A_rest",
                        "thesis": "Rest of claims.",
                        "role": "established",
                        "themes": ["rest"],
                        "claim_ids": sorted(registry_ids - set(thin_half)),
                    },
                ],
            },
            registry_ids,
        )
        thin_outline = pipeline.validate_outline_document(
            {
                "schema_version": pipeline.OUTLINE_SCHEMA,
                "title": "Thin outline",
                "findings": [
                    {
                        "subsection_id": "S_thin",
                        "heading": "Thin theme",
                        "argument_ids": ["A_thin"],
                        "subsubsections": [
                            {
                                "subsubsection_id": "S_thin.1",
                                "heading": "Would be empty A",
                                "points": ["a"],
                            },
                            {
                                "subsubsection_id": "S_thin.2",
                                "heading": "Would be empty B",
                                "points": ["b"],
                            },
                        ],
                    },
                    {
                        "subsection_id": "S_rest",
                        "heading": "Rest",
                        "argument_ids": ["A_rest"],
                        "subsubsections": [
                            {
                                "subsubsection_id": "S_rest.1",
                                "heading": "Rest A",
                                "points": ["a"],
                            },
                            {
                                "subsubsection_id": "S_rest.2",
                                "heading": "Rest B",
                                "points": ["b"],
                            },
                        ],
                    },
                ],
            },
            thin_args,
        )
        self.assertEqual(thin_outline["findings"][0]["subsubsections"], [])
        self.assertGreaterEqual(len(thin_outline["findings"][1]["subsubsections"]), 2)
        self.assertEqual(
            pipeline.max_subsubsections_for_claims(2),
            0,
        )
        self.assertEqual(
            pipeline.max_subsubsections_for_claims(6),
            2,
        )

        # Assemble a dual-bound draft with nested subsubsections.
        expansions = []
        for node in outline["findings"]:
            nested = []
            for sub in node["subsubsections"]:
                paragraphs = [
                    f"The literature supports this point [@{claim_id}]."
                    for claim_id in sub["claim_ids"]
                ]
                if not paragraphs:
                    paragraphs = ["No claims were assigned to this sub-theme."]
                nested.append(
                    {
                        "heading": sub["heading"],
                        "paragraphs": paragraphs,
                        "claim_ids": sub["claim_ids"],
                        "subsections": [],
                    }
                )
            expansions.append(
                {
                    "subsection_id": node["subsection_id"],
                    "heading": node["heading"],
                    "paragraphs": [],
                    "claim_ids": [],
                    "subsections": nested,
                }
            )
        frontmatter = {
            "title": outline["title"],
            "question_paragraphs": [report_input["question"]],
            "search_scope_paragraphs": ["Synthetic search scope."],
            "findings_intro_paragraphs": [
                "This section synthesizes the approved literature against the research question.",
                "The discussion proceeds through Theme one, then Theme two.",
            ],
            "findings_summary_paragraphs": [
                "Overall the literature supports both themes as complementary.",
                "Residual uncertainty remains where evidence is thin.",
            ],
        }
        draft = pipeline.assemble_draft(report_input, frontmatter, expansions)
        validated = runner.validate_draft(draft, report_input, TOOL_ROOT)
        self.assertEqual(validated["title"], "Synthetic outline")
        self.assertEqual(runner.missing_claim_ids(validated, report_input), [])
        findings = next(section for section in validated["sections"] if section["section_id"] == "findings")
        self.assertEqual(len(findings["paragraphs"]), 2)
        self.assertTrue(findings["paragraphs"][0].startswith("This section synthesizes"))
        # Thematic subsections + closing Summary.
        self.assertEqual(len(findings["subsections"]), 3)
        self.assertEqual(findings["subsections"][-1]["heading"], pipeline.SUMMARY_SUBSECTION_HEADING)
        self.assertEqual(len(findings["subsections"][-1]["paragraphs"]), 2)
        self.assertEqual(findings["subsections"][-1]["claim_ids"], [])
        # Nested subsubsections under first theme.
        self.assertGreaterEqual(len(findings["subsections"][0]["subsections"]), 2)
        self.assertTrue(findings["subsections"][0]["subsections"][0]["paragraphs"])

        # Deterministic fallback intro when the model returns nothing.
        fallback = pipeline._fallback_findings_intro(report_input, outline)
        self.assertGreaterEqual(len(fallback), 2)
        self.assertIn("Theme one", " ".join(fallback))
        summary_fallback = pipeline._fallback_findings_summary(
            report_input, outline, arguments
        )
        self.assertGreaterEqual(len(summary_fallback), 2)

        # LaTeX emits subsubsection for nested nodes.
        tex = runner.render_latex(report_input, validated)
        self.assertIn(r"\subsection{", tex)
        self.assertIn(r"\subsubsection{", tex)

    def test_literature_pipeline_resume_requires_report_input_digest(self) -> None:
        import literature_pipeline as pipeline

        first = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "literature-report")
        second = json.loads(json.dumps(first))
        second["question"] = "What does the narrowed evidence establish?"
        first_digest = runner.object_digest(first)
        second_digest = runner.object_digest(second)
        self.assertNotEqual(first_digest, second_digest)

        with tempfile.TemporaryDirectory() as temporary:
            pipeline_dir = Path(temporary) / "pipeline"
            session_dir = Path(temporary) / "runs" / "report-input-a"
            pipeline.write_pipeline_meta(
                pipeline_dir,
                report_input_sha256=first_digest,
                session_dir=session_dir,
            )

            allowed, reason = pipeline.pipeline_resume_allowed(
                pipeline_dir,
                first_digest,
                resume=True,
            )
            self.assertTrue(allowed)
            self.assertEqual(reason, "matched")

            allowed, reason = pipeline.pipeline_resume_allowed(
                pipeline_dir,
                second_digest,
                resume=True,
            )
            self.assertFalse(allowed)
            self.assertEqual(reason, "input-hash-mismatch")
            self.assertNotEqual(
                pipeline.report_input_session_dir(Path(temporary), first_digest),
                pipeline.report_input_session_dir(Path(temporary), second_digest),
            )

    def test_reference_year_and_venue_counts(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "literature-report")
        # Synthetic fixture has one reference; year/venue come from metadata.
        report_input["references"] = [
            {
                "reference_id": "ref-a",
                "title": "Paper A",
                "authors": ["A"],
                "year": 2024,
                "venue": "arXiv.org",
                "doi": "",
                "url": "https://source.example/a",
            },
            {
                "reference_id": "ref-b",
                "title": "Paper B",
                "authors": ["B"],
                "year": 2024,
                "venue": "arXiv.org",
                "doi": "",
                "url": "https://source.example/b",
            },
            {
                "reference_id": "ref-c",
                "title": "Paper C",
                "authors": ["C"],
                "year": 2025,
                "venue": "",
                "doi": "",
                "url": "https://source.example/c",
            },
            {
                "reference_id": "ref-d",
                "title": "Paper D",
                "authors": ["D"],
                "year": "2025",
                "venue": "ICML",
                "doi": "",
                "url": "https://source.example/d",
            },
        ]
        self.assertEqual(runner.reference_year_counts(report_input), [(2024, 2), (2025, 2)])
        venues = runner.reference_venue_counts(report_input, top_n=12)
        self.assertEqual(venues[0], ("arXiv.org", 2))
        labels = {label for label, _ in venues}
        self.assertIn("ICML", labels)
        self.assertIn("Unknown / not recorded", labels)
        years, venue_labels, series = runner.reference_year_venue_matrix(report_input)
        self.assertEqual(years, [2024, 2025])
        self.assertIn("arXiv.org", venue_labels)
        self.assertEqual(series["arXiv.org"], [2, 0])
        self.assertEqual(series["ICML"], [0, 1])

    def test_search_scope_structured_body_and_figures(self) -> None:
        report_input = runner.build_report_input(TOOL_ROOT, ANALYSIS_OUTPUT, "literature-report")
        report_input["search_scope"] = {
            "record_count": 3,
            "collection_input_sha256": "sha256:input-example",
            "collection_output_sha256": "sha256:output-example",
            "rerun_command": "clue-data-collection run --input input.json",
            "source_tasks": [
                {"task_id": "t1", "source_type": "crossref-search"},
                {"task_id": "t2", "source_type": "semantic-scholar-search"},
            ],
            "scope": {
                "time_range": "2022-01-01/2026-12-31",
                "include": ["agent permissions", "isolation"],
            },
            "information_gaps": ["Synthetic gap one.", "Synthetic gap two."],
        }
        report_input["references"] = [
            {
                "reference_id": "ref-a",
                "title": "Paper A",
                "authors": ["A"],
                "year": 2024,
                "venue": "arXiv.org",
                "doi": "",
                "url": "https://source.example/a",
            },
            {
                "reference_id": "ref-b",
                "title": "Paper B",
                "authors": ["B"],
                "year": 2025,
                "venue": "ICML",
                "doi": "",
                "url": "https://source.example/b",
            },
            {
                "reference_id": "ref-c",
                "title": "Paper C",
                "authors": ["C"],
                "year": 2025,
                "venue": "ICML",
                "doi": "",
                "url": "https://source.example/c",
            },
        ]
        paragraphs = runner.search_scope_algorithm_paragraphs(report_input)
        self.assertGreaterEqual(len(paragraphs), 2)
        self.assertIn("3 bibliographic records", paragraphs[1])
        self.assertIn("2024–2025", paragraphs[1])

        md = "\n".join(runner.markdown_search_scope_body(report_input))
        self.assertIn("### Paper distribution by year and venue", md)
        self.assertIn("| 2024 |", md)
        self.assertIn("| 2025 |", md)
        self.assertIn("arXiv.org", md)
        self.assertIn("ICML", md)
        self.assertIn("### Collection Information Gaps", md)
        self.assertIn("Synthetic gap one.", md)

        draft = build_draft(report_input)
        # Free-form draft paragraphs must be replaced by structured scope body.
        scope_section = next(s for s in draft["sections"] if s["section_id"] == "search_scope")
        scope_section["paragraphs"] = ["This free-form text must not appear in the rendered scope."]
        validated = runner.validate_draft(draft, report_input, TOOL_ROOT)

        with tempfile.TemporaryDirectory() as tmp:
            figure_dir = Path(tmp)
            figures = runner.write_corpus_distribution_figures(report_input, figure_dir)
            self.assertIn("distribution", figures)
            self.assertIn("distribution_svg", figures)
            self.assertTrue((figure_dir / figures["distribution"]).is_file())
            self.assertTrue((figure_dir / figures["distribution_svg"]).is_file())
            self.assertTrue(figures["distribution_svg"].endswith(".svg"))
            self.assertNotIn("years", figures)
            self.assertNotIn("venues", figures)
            tex = runner.render_latex(report_input, validated, figure_dir=figure_dir)
            self.assertIn(r"\subsection{Paper distribution by year and venue}", tex)
            self.assertIn(r"\includegraphics", tex)
            self.assertIn(figures["distribution"], tex)
            self.assertEqual(tex.count(r"\includegraphics"), 1)
            self.assertIn(r"\subsection{Collection Information Gaps}", tex)
            self.assertIn("Synthetic gap one.", tex)
            self.assertNotIn("This free-form text must not appear", tex)
            self.assertIn(r"\usepackage{graphicx}", tex)



class PdfBrowserResolutionTests(unittest.TestCase):
    def test_prefers_browser_on_path(self) -> None:
        with patch.object(runner.shutil, "which", side_effect=lambda name: "/usr/bin/chromium" if name == "chromium" else None):
            self.assertEqual(runner.resolve_pdf_browser(), "chromium")

    def test_falls_back_to_macos_app_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            binary = home / "Applications" / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o755)
            with patch.object(runner.shutil, "which", return_value=None), patch.object(
                runner.Path, "home", return_value=home
            ), patch.object(runner, "MACOS_SYSTEM_APPS_DIR", home / "no-system-apps"):
                self.assertEqual(runner.resolve_pdf_browser(), str(binary))

    def test_returns_none_without_browser(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner.shutil, "which", return_value=None), patch.object(
            runner.Path, "home", return_value=Path(tmp)
        ), patch.object(runner, "MACOS_BROWSER_APPS", ()):
            self.assertIsNone(runner.resolve_pdf_browser())

if __name__ == "__main__":
    unittest.main()
