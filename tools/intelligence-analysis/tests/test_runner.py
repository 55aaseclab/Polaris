import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner


class Tests(unittest.TestCase):
    def test_workflow_prepare_uses_the_real_collection_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collection_path = root / "collection.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            collection_path.write_text(
                json.dumps(
                    {
                        "collection_id": "collection-synthetic",
                        "collection_kind": "literature",
                        "status": "final",
                        "records": [],
                        "rejected_records": [],
                        "run_artifacts": [],
                        "information_gaps": [],
                    }
                ),
                encoding="utf-8",
            )
            request_path.write_text(
                json.dumps(
                    {
                        "runId": "run-synthetic",
                        "workspaceRoot": str(root / "workspace"),
                        "input": {
                            "collectionOutputRef": str(collection_path),
                            "question": "Synthetic question",
                            "decisionContext": "Synthetic decision",
                            "audience": "Synthetic audience",
                        },
                    }
                ),
                encoding="utf-8",
            )
            prepared = {
                "status": "prepared",
                "snapshot": str(root / "workspace" / "analysis" / "work" / "snapshot.json"),
                "analysis_input": str(
                    root / "workspace" / "analysis" / "work" / "analysis-input.json"
                ),
                "clue_count": 0,
            }

            with patch.object(runner, "run", return_value=prepared) as run_mock:
                result = runner.command_workflow(
                    type(
                        "Args",
                        (),
                        {
                            "input": str(request_path),
                            "output": str(output_path),
                            "step_command": "prepare",
                        },
                    )()
                )

            self.assertEqual(result, 0)
            document = run_mock.call_args.args[0]
            self.assertEqual(
                document["collection_ref"]["collection_output_path"],
                str(collection_path),
            )
            self.assertEqual(
                document["collection_ref"]["collection_output_sha256"],
                runner.digest(collection_path),
            )
            output = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(output["clueCount"], 0)

    def test_workflow_validate_output_uses_the_published_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis_path = root / "analysis.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            analysis_path.write_text(
                json.dumps(
                    {
                        "schema_version": runner.OUTPUT_SCHEMA,
                        "analysis_id": "analysis-synthetic",
                        "analysis_kind": "literature-review",
                        "status": "final",
                        "judgments": [],
                        "unresolved": [],
                        "run_artifacts": [],
                    }
                ),
                encoding="utf-8",
            )
            request_path.write_text(
                json.dumps(
                    {
                        "workspaceRoot": str(root / "workspace"),
                        "input": {"analysisOutputRef": str(analysis_path)},
                    }
                ),
                encoding="utf-8",
            )

            result = runner.command_workflow(
                type(
                    "Args",
                    (),
                    {
                        "input": str(request_path),
                        "output": str(output_path),
                        "step_command": "validate-output",
                    },
                )()
            )

            self.assertEqual(result, 0)
            self.assertEqual(
                json.loads(output_path.read_text(encoding="utf-8")),
                {"analysisValid": True},
            )

    def test_polaris_mode_allows_only_validation_commands(self):
        with patch.dict(os.environ, {"POLARIS_LITERATURE_RUNTIME_MODE": "polaris"}):
            for command in runner.POLARIS_SAFE_COMMANDS:
                runner.assert_polaris_command_is_safe(command)
            with self.assertRaisesRegex(runner.CliError, "Polaris durable job service"):
                runner.assert_polaris_command_is_safe("complete-review")

    def test_polaris_mode_rejects_completion_before_filesystem_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "analysis"
            with patch.dict(os.environ, {"POLARIS_LITERATURE_RUNTIME_MODE": "polaris"}):
                code = runner.main(
                    ["complete-review", "--analysis-root", str(root)]
                )

            self.assertEqual(code, 2)
            self.assertFalse((root / "outputs" / "output.json").exists())

    def test_review_policy_uses_one_of_three_explicit_modes(self):
        policy = runner.normalize_review_policy({})

        self.assertEqual(policy["mode"], "auto-pass")
        self.assertEqual(
            runner.normalize_review_policy({"mode": "auto-approve"})["mode"],
            "auto-approve",
        )
        self.assertEqual(
            runner.normalize_review_policy({"mode": "manual-review"})["mode"],
            "manual-review",
        )
        with self.assertRaisesRegex(runner.CliError, "mode"):
            runner.normalize_review_policy({"mode": "automatic"})
        with self.assertRaisesRegex(runner.CliError, "unsupported"):
            runner.normalize_review_policy({"auto_pass": True})
        with self.assertRaisesRegex(runner.CliError, "unsupported"):
            runner.normalize_review_policy({"unexpected": True})

    def test_v2_input(self):
        runner.validate_input(
            {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "a",
                "analysis_kind": "literature-review",
                "question": "q",
                "question_prompt": {
                    "method": "generate-text",
                    "instruction": "derive q",
                    "output_kind": "text",
                },
                "decision_context": "d",
                "decision_context_prompt": {
                    "method": "generate-text",
                    "instruction": "derive d",
                    "output_kind": "text",
                },
                "audience": "a",
                "audience_prompt": {
                    "method": "derive",
                    "instruction": "derive audience",
                    "output_kind": "text",
                },
                "collection_ref": {
                    "collection_id": "c",
                    "collection_output_sha256": "sha256:x",
                    "collection_output_path": "/tmp/output.json",
                },
                "screening": {"included_record_ids": ["r"]},
                "review_policy": {},
            }
        )

    def test_final_output_document_copies_prompt_fields(self):
        analysis_input = {
            "task": {
                "case_id": "case-1",
                "question": "q",
                "question_prompt": {
                    "method": "generate-text",
                    "instruction": "derive q",
                    "output_kind": "text",
                },
                "decision_context": "d",
                "decision_context_prompt": {
                    "method": "generate-text",
                    "instruction": "derive d",
                    "output_kind": "text",
                },
                "audience": "a",
                "audience_prompt": {
                    "method": "derive",
                    "instruction": "derive audience",
                    "output_kind": "text",
                },
            }
        }
        literature_output = {
            "status": "final",
            "collection_snapshot": {"snapshot_id": "snap-1", "sha256": "sha256:snap-1"},
            "judgments": [],
            "unresolved": [],
            "review": {
                "status": "completed",
                "approval_mode": "auto_pass",
                "review_set_id": "review-1",
                "review_result_sha256": "sha256:review-1",
                "summary": {},
            },
        }

        output = runner.final_output_document(analysis_input, literature_output, [])

        self.assertEqual(output["analysis_context"]["question_prompt"]["method"], "generate-text")
        self.assertEqual(output["analysis_context"]["decision_context_prompt"]["output_kind"], "text")
        self.assertEqual(output["analysis_context"]["audience_prompt"]["method"], "derive")

    def test_v2_input_uses_all_collection_records_without_screening(self):
        runner.validate_input(
            {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "a",
                "analysis_kind": "literature-review",
                "question": "q",
                "decision_context": "d",
                "audience": "a",
                "collection_ref": {
                    "collection_id": "c",
                    "collection_output_sha256": "sha256:x",
                    "collection_output_path": "/tmp/output.json",
                },
                "review_policy": {},
            }
        )

    def test_rejects_v1(self):
        with self.assertRaises(runner.CliError):
            runner.validate_input({"schema_version": "clue.intelligence.analysis-task.v1"})

    def test_accepts_ad_content_review_kind(self):
        runner.validate_input(
            {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "ad-a",
                "analysis_kind": "ad-content-review",
                "question": "What creatives appear for the query?",
                "decision_context": "content intel",
                "audience": "ops",
                "collection_ref": {
                    "collection_id": "c",
                    "collection_output_sha256": "sha256:x",
                    "collection_output_path": "/tmp/output.json",
                },
                "review_policy": {"mode": "auto-pass"},
            }
        )
        self.assertIn("ad-content-review", runner.KINDS)
        self.assertIn("ad-content-review", runner.WIRED_KINDS)

    def test_ia_schemas_live_in_repo_root_schemas(self):
        for name in (
            "clue.intelligence-analysis.input.v2.schema.json",
            "clue.intelligence-analysis.output.v2.schema.json",
        ):
            path = runner.contract_schema_path(name)
            self.assertTrue(path.is_file(), msg=str(path))
            schema = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("properties", schema)
        kinds = json.loads(
            runner.contract_schema_path(
                "clue.intelligence-analysis.input.v2.schema.json"
            ).read_text(encoding="utf-8")
        )["properties"]["analysis_kind"]["enum"]
        self.assertIn("ad-content-review", kinds)
        self.assertIn("literature-review", kinds)

    def test_ad_content_review_run_emits_judgments(self):
        """IA ad-content path with synthesize stubbed to lexical (no live Codex)."""

        def fake_synth(prepared, snapshot, output, *, doc=None, work_dir=None):
            del doc, work_dir
            # Invoke executor CLI in lexical mode for offline unit tests.
            completed = subprocess.run(
                [
                    str(runner.ad_content_review_bin()),
                    "synthesize",
                    "--input",
                    str(prepared),
                    "--snapshot",
                    str(snapshot),
                    "--output",
                    str(output),
                    "--lexical-only",
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            if completed.returncode != 0 or not Path(output).is_file():
                raise runner.CliError(
                    f"lexical synthesize failed: {(completed.stderr or '')[:400]}"
                )
            return runner.read(str(output))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collection = root / "collection" / "outputs" / "output.json"
            collection.parent.mkdir(parents=True)
            body = {
                "schema_version": "clue.data-collection.output.v2",
                "collection_id": "c",
                "collection_kind": "ad-content-intel",
                "status": "final",
                "records": [
                    {
                        "record_id": "post:demo",
                        "record_kind": "xhs_note",
                        "source_url": "https://www.xiaohongshu.com/explore/demo",
                        "observed_at": "2026-01-01T00:00:00Z",
                        "content_hash": "sha256:demo",
                        "evidence": [{"quote": "护肤种草笔记", "locator": "title"}],
                        "payload": {
                            "platform": "xiaohongshu",
                            "title": "护肤种草笔记",
                            "text": "护肤种草笔记",
                        },
                    }
                ],
                "rejected_records": [],
                "run_artifacts": [],
                "information_gaps": [],
            }
            collection.write_text(json.dumps(body) + "\n", encoding="utf-8")
            digest = "sha256:" + hashlib.sha256(collection.read_bytes()).hexdigest()
            analysis_root = root / "ia"
            doc = {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "ad-run",
                "analysis_kind": "ad-content-review",
                "question": "护肤种草",
                "decision_context": "内容情报",
                "audience": "ops",
                "collection_ref": {
                    "collection_id": "c",
                    "collection_output_sha256": digest,
                    "collection_output_path": str(collection),
                },
                "review_policy": {"mode": "auto-pass", "minimum_confidence": 0.5},
            }
            with patch.object(runner, "run_ad_content_synthesize", side_effect=fake_synth):
                result = runner.run(doc, analysis_root, True)
            self.assertEqual(result["status"], "final")
            self.assertEqual(result["executor"], "ad-content-review")
            self.assertGreaterEqual(result.get("judgment_count", 0), 1)
            output = json.loads(Path(result["output"]).read_text(encoding="utf-8"))
            runner.validate_output(output)
            self.assertEqual(output["analysis_kind"], "ad-content-review")
            self.assertTrue(output["judgments"])
            claim = output["judgments"][0]
            self.assertIn("claim_id", claim)
            self.assertTrue(claim.get("evidence"))
            self.assertEqual(claim["review_decision"]["status"], "approved")
            self.assertIn("source_url", claim["evidence"][0])
            self.assertTrue((analysis_root / "outputs" / "report.md").is_file())

    def test_prepare_ignores_non_evidence_pdf_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content_hash = "sha256:metadata"
            collection = root / "collection" / "outputs" / "output.json"
            collection.parent.mkdir(parents=True)
            collection.write_text(
                json.dumps(
                    {
                        "records": [
                            {
                                "record_id": "r",
                                "record_kind": "literature-candidate",
                                "source_url": "https://source.example/record",
                                "observed_at": "2026-01-01T00:00:00Z",
                                "content_hash": content_hash,
                                "evidence": [
                                    {
                                        "quote": "Synthetic metadata.",
                                        "locator": "abstract",
                                    }
                                ],
                                "payload": {
                                    "title": "Synthetic paper",
                                    "pdf_links": {
                                        "status": "listed",
                                        "candidates": [
                                            {
                                                "url": "https://source.example/paper.pdf",
                                                "link_kind": "source-metadata",
                                                "validation": "not_downloaded",
                                            }
                                        ],
                                        "validation": "not_downloaded",
                                    },
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            doc = {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "a",
                "analysis_kind": "literature-review",
                "question": "q",
                "decision_context": "d",
                "audience": "a",
                "collection_ref": {
                    "collection_id": "c",
                    "collection_output_sha256": (
                        "sha256:" + hashlib.sha256(collection.read_bytes()).hexdigest()
                    ),
                    "collection_output_path": str(collection),
                },
                "review_policy": {},
            }
            with patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0),
            ):
                runner.run(doc, root / "analysis", False)
            snapshot = json.loads(
                (root / "analysis" / "work" / "collection-snapshot.json").read_text()
            )
            self.assertNotIn("attachments", snapshot["clues"][0])
            task = json.loads((root / "analysis" / "work" / "task.json").read_text())
            self.assertEqual(task["review_policy"]["mode"], "auto-pass")

    def test_run_uses_auto_pass_and_publishes_its_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collection = root / "collection" / "outputs" / "output.json"
            collection.parent.mkdir(parents=True)
            collection.write_text(
                json.dumps(
                    {
                        "records": [
                            {
                                "record_id": "record-001",
                                "source_url": "https://source.example/record",
                                "observed_at": "2026-01-01T00:00:00Z",
                                "content_hash": "sha256:record",
                                "evidence": [{"quote": "Synthetic evidence.", "locator": "abstract"}],
                                "payload": {"title": "Synthetic paper"},
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            doc = {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "analysis-example",
                "analysis_kind": "literature-review",
                "question": "What does the evidence establish?",
                "decision_context": "Synthetic testing.",
                "audience": "testers",
                "literature_method": "propose",
                "collection_ref": {
                    "collection_id": "collection-example",
                    "collection_output_sha256": "sha256:" + hashlib.sha256(collection.read_bytes()).hexdigest(),
                    "collection_output_path": str(collection),
                },
                "review_policy": {},
            }
            calls: list[str] = []

            def fake_run_lr(args):
                calls.append(args[0])
                output = Path(args[args.index("--output") + 1])
                if args[0] == "prepare":
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_text(
                        json.dumps(
                            {
                                "task": {
                                    "case_id": "analysis-example",
                                    "question": "What does the evidence establish?",
                                    "decision_context": "Synthetic testing.",
                                    "audience": "testers",
                                }
                            }
                        ),
                        encoding="utf-8",
                    )
                elif args[0] == "finalize":
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_text(
                        json.dumps(
                            {
                                "status": "final",
                                "collection_snapshot": {
                                    "snapshot_id": "analysis-example-snapshot",
                                    "sha256": "sha256:snapshot",
                                },
                                "judgments": [],
                                "rejected_claims": [],
                                "unresolved": [],
                                "review": {
                                    "status": "completed",
                                    "approval_mode": "auto_pass",
                                    "review_set_id": "analysis:example:snapshot",
                                    "review_result_sha256": "sha256:review",
                                    "summary": {},
                                },
                            }
                        ),
                        encoding="utf-8",
                    )

            with patch.object(runner, "run_lr", side_effect=fake_run_lr):
                result = runner.run(doc, root / "analysis", True)

            self.assertEqual(calls, ["prepare", "propose", "validate", "auto-pass", "finalize"])
            self.assertEqual(result["review_mode"], "auto_pass")
            output = json.loads(Path(result["output"]).read_text())
            self.assertEqual(output["review"]["approval_mode"], "auto_pass")
            artifacts = [Path(item["path"]).name for item in output["run_artifacts"]]
            self.assertIn("automatic-review-result.json", artifacts)

    def test_manual_review_mode_publishes_manual_review_list(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collection = root / "collection" / "outputs" / "output.json"
            collection.parent.mkdir(parents=True)
            collection.write_text(
                json.dumps(
                    {
                        "records": [
                            {
                                "record_id": "record-001",
                                "source_url": "https://source.example/record",
                                "observed_at": "2026-01-01T00:00:00Z",
                                "content_hash": "sha256:record",
                                "evidence": [{"quote": "Synthetic evidence.", "locator": "abstract"}],
                                "payload": {"title": "Synthetic paper"},
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            doc = {
                "schema_version": runner.INPUT_SCHEMA,
                "analysis_id": "analysis-example",
                "analysis_kind": "literature-review",
                "question": "What does the evidence establish?",
                "decision_context": "Synthetic testing.",
                "audience": "testers",
                "literature_method": "propose",
                "collection_ref": {
                    "collection_id": "collection-example",
                    "collection_output_sha256": "sha256:" + hashlib.sha256(collection.read_bytes()).hexdigest(),
                    "collection_output_path": str(collection),
                },
                "review_policy": {"mode": "manual-review"},
            }
            calls: list[str] = []

            def fake_run_lr(args):
                calls.append(args[0])
                output = Path(args[args.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                if args[0] == "prepare":
                    output.write_text(
                        json.dumps(
                            {
                                "task": {
                                    "case_id": "analysis-example",
                                    "question": doc["question"],
                                    "decision_context": doc["decision_context"],
                                    "audience": doc["audience"],
                                }
                            }
                        ),
                        encoding="utf-8",
                    )
                elif args[0] == "validate":
                    output.write_text(json.dumps({"claims": [], "unresolved": []}), encoding="utf-8")
                elif args[0] == "review-list":
                    output.write_text(
                        json.dumps({"schema_version": "clue.manual-review.v2", "review_records": []}),
                        encoding="utf-8",
                    )

            with patch.object(runner, "run_lr", side_effect=fake_run_lr):
                result = runner.run(doc, root / "analysis", True)

            self.assertEqual(calls, ["prepare", "propose", "validate", "review-list"])
            self.assertEqual(result["status"], "pending_manual_review")
            self.assertTrue((root / "analysis" / "outputs" / "manual-review-list.json").is_file())

    def test_complete_manual_review_finalizes_portal_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "analysis"
            work = root / "work"
            outputs = root / "outputs"
            work.mkdir(parents=True)
            outputs.mkdir(parents=True)
            prepared = work / "analysis-input.json"
            prepared.write_text(
                json.dumps(
                    {
                        "task": {
                            "case_id": "analysis-example",
                            "question": "What does the evidence establish?",
                            "decision_context": "Synthetic testing.",
                            "audience": "testers",
                        }
                    }
                ),
                encoding="utf-8",
            )
            (work / "validated.json").write_text(json.dumps({"claims": []}), encoding="utf-8")
            (outputs / "manual-review-list.json").write_text(
                json.dumps({"schema_version": "clue.manual-review.v2", "review_records": []}),
                encoding="utf-8",
            )
            review_result = work / "manual-review" / "review-result.json"
            review_result.parent.mkdir(parents=True)
            review_result.write_text(json.dumps({"approved_records": []}), encoding="utf-8")
            (outputs / "output.json").write_text(
                json.dumps({"literature_method": "propose"}),
                encoding="utf-8",
            )

            def fake_run_lr(args):
                output = Path(args[args.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    json.dumps(
                        {
                            "status": "final",
                            "collection_snapshot": {"snapshot_id": "snapshot", "sha256": "sha256:snapshot"},
                            "judgments": [],
                            "rejected_claims": [],
                            "unresolved": [],
                            "review": {"approval_mode": "manual"},
                        }
                    ),
                    encoding="utf-8",
                )

            with patch.object(runner, "run_lr", side_effect=fake_run_lr):
                result = runner.complete_manual_review(root, review_result)

            self.assertEqual(result["status"], "succeeded")
            output = json.loads((outputs / "output.json").read_text(encoding="utf-8"))
            self.assertEqual(output["status"], "final")
            self.assertEqual(output["review"]["approval_mode"], "manual")

    def test_finalize_preserves_review_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis_input = root / "analysis-input.json"
            literature_output = root / "literature-output.json"
            output = root / "output.json"
            analysis_input.write_text(
                json.dumps(
                    {
                        "task": {
                            "case_id": "analysis-example",
                            "question": "What does the evidence establish?",
                            "decision_context": "Synthetic testing.",
                            "audience": "testers",
                        }
                    }
                ),
                encoding="utf-8",
            )
            literature_output.write_text(
                json.dumps(
                    {
                        "status": "final",
                        "collection_snapshot": {
                            "snapshot_id": "analysis-example-snapshot",
                            "sha256": "sha256:snapshot",
                        },
                        "judgments": [],
                        "rejected_claims": [],
                        "unresolved": [],
                        "review": {
                            "status": "completed",
                            "approval_mode": "auto_pass",
                            "review_set_id": "analysis:example:snapshot",
                            "review_result_sha256": "sha256:review",
                            "summary": {},
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                runner.main(
                    [
                        "finalize",
                        "--analysis-input",
                        str(analysis_input),
                        "--literature-output",
                        str(literature_output),
                        "--output",
                        str(output),
                    ]
                ),
                0,
            )
            self.assertEqual(json.loads(output.read_text())["review"]["approval_mode"], "auto_pass")


if __name__ == "__main__":
    unittest.main()
