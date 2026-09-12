"""Contract tests for generic data collection v2."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runner  # noqa: E402


V2_INPUT = {
    "schema_version": runner.INPUT_V2,
    "collection_id": "example",
    "collection_kind": "literature",
    "question": "What is known?",
    "decision_context": "research",
    "scope": {},
    "evidence_policy": {
        "required_fields": ["source_url", "quote", "observed_at", "content_hash"]
    },
    "source_tasks": [{"task_id": "seed", "source_type": "crossref-search", "config": {"query": "example"}}],
    "payload": {},
}


def literature_output(count: int = 1) -> dict:
    records = []
    for index in range(count):
        record_id = f"doi:example-{index}"
        records.append(
            {
                "record_id": record_id,
                "record_kind": "literature-candidate",
                "source_url": f"https://doi.example/{index}",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "sha256:metadata",
                "evidence": [{"quote": "Metadata only.", "locator": "title"}],
                "payload": {"title": f"Synthetic paper {index}"},
            }
        )
    return {
        "schema_version": runner.OUTPUT_V2,
        "collection_id": "example",
        "collection_kind": "literature",
        "status": "candidate_set",
        "records": records,
        "rejected_records": [],
        "run_artifacts": [],
        "information_gaps": [],
    }


class ContractTests(unittest.TestCase):
    def test_workflow_prepare_builds_a_valid_collection_input_from_the_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_path = root / "plan.json"
            request_path = root / "request.json"
            output_path = root / "output.json"
            plan_path.write_text(
                json.dumps(
                    {
                        "plan": {
                            "keywords": ["synthetic alpha", "synthetic beta"],
                            "queries": ["synthetic alpha synthetic beta"],
                            "year_from": 2020,
                            "year_to": 2026,
                        }
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
                            "question": "Synthetic research question",
                            "keywordPlanRef": str(plan_path),
                            "decisionContext": "Synthetic decision",
                            "audience": "Synthetic audience",
                        },
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
                        "step_command": "prepare-literature-input",
                    },
                )()
            )

            self.assertEqual(result, 0)
            output = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertTrue(output["inputValid"])
            prepared = runner.read_json(Path(output["collectionInputRef"]), "prepared input")
            runner.validate_v2_input(prepared)
            self.assertEqual(
                prepared["payload"]["literature_scope"]["topic_keywords"],
                ["synthetic alpha", "synthetic beta"],
            )
            self.assertEqual(prepared["pipeline"]["skip_augmentation"], False)

    def test_pipeline_uses_a_three_state_review_mode(self):
        self.assertEqual(
            runner.pipeline_options(V2_INPUT, None)["review_mode"],
            "auto-pass",
        )
        for legacy_field in ("auto_approve", "auto_pass"):
            with self.subTest(legacy_field=legacy_field):
                with self.assertRaisesRegex(runner.CliError, "replaced"):
                    runner.pipeline_options(
                        {**V2_INPUT, "pipeline": {legacy_field: False}},
                        None,
                    )

    def test_pipeline_rejects_unknown_fields_and_invalid_augmentation_flag(self):
        with self.assertRaisesRegex(runner.CliError, "unsupported"):
            runner.pipeline_options(
                {**V2_INPUT, "pipeline": {"unrecognized": True}},
                None,
            )
        with self.assertRaisesRegex(runner.CliError, "must be a boolean"):
            runner.pipeline_options(
                {**V2_INPUT, "pipeline": {"skip_augmentation": "false"}},
                None,
            )

    def test_schema_enum_includes_ad_content_intel(self):
        schema_path = (
            Path(__file__).resolve().parents[3]
            / "schemas"
            / "clue.data-collection.input.v2.schema.json"
        )
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        kinds = schema["properties"]["collection_kind"]["enum"]
        self.assertIn("ad-content-intel", kinds)
        self.assertIn("literature", kinds)
        self.assertIn("customer-leads", kinds)

    def test_ad_content_scope_only_for_ad_content_intel(self):
        value = {
            "schema_version": runner.INPUT_V2,
            "collection_id": "demo-ad",
            "collection_kind": "literature",
            "question": "q",
            "decision_context": "d",
            "scope": {},
            "evidence_policy": {
                "required_fields": ["source_url", "quote", "observed_at", "content_hash"]
            },
            "source_tasks": [
                {"task_id": "t1", "source_type": "web-search", "config": {}}
            ],
            "payload": {"ad_content_scope": {"platforms": ["xiaohongshu"]}},
        }
        with self.assertRaises(runner.CliError):
            runner.validate_v2_input(value)
        value["collection_kind"] = "ad-content-intel"
        runner.validate_v2_input(value)

    def test_pipeline_schema_declares_only_supported_fields(self):
        schema_path = (
            Path(__file__).resolve().parents[3]
            / "schemas"
            / "clue.data-collection.input.v2.schema.json"
        )
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        pipeline = schema["properties"]["pipeline"]
        self.assertEqual(
            pipeline["properties"]["review_mode"]["enum"],
            ["auto-pass", "auto-approve", "manual-review"],
        )
        self.assertEqual(
            pipeline["properties"]["review_mode"]["default"],
            "auto-pass",
        )
        self.assertEqual(
            pipeline["properties"]["skip_augmentation"]["default"],
            False,
        )
        self.assertFalse(pipeline["additionalProperties"])

    def test_seed_scope_filters_out_of_window_and_non_ccf(self):
        collection = {
            "schema_version": runner.OUTPUT_V2,
            "collection_id": "example",
            "collection_kind": "literature",
            "status": "candidate_set",
            "records": [
                {
                    "record_id": "doi:10.1145/in-scope",
                    "record_kind": "literature-candidate",
                    "source_url": "https://doi.org/10.1145/in-scope",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": "sha256:a",
                    "evidence": [{"quote": "ok"}],
                    "payload": {
                        "title": "In scope CCS paper",
                        "DOI": "10.1145/in-scope",
                        "year": 2024,
                        "container-title": ["Proceedings of the ACM Conference on Computer and Communications Security"],
                        "short-container-title": ["CCS"],
                    },
                },
                {
                    "record_id": "doi:10.9999/old",
                    "record_kind": "literature-candidate",
                    "source_url": "https://doi.org/10.9999/old",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": "sha256:b",
                    "evidence": [{"quote": "old"}],
                    "payload": {
                        "title": "Ancient paper",
                        "DOI": "10.9999/old",
                        "year": 2010,
                        "container-title": ["CCS"],
                        "short-container-title": ["CCS"],
                    },
                },
                {
                    "record_id": "doi:10.9999/random",
                    "record_kind": "literature-candidate",
                    "source_url": "https://doi.org/10.9999/random",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": "sha256:c",
                    "evidence": [{"quote": "no venue"}],
                    "payload": {
                        "title": "Random blog post styled as paper",
                        "DOI": "10.9999/random",
                        "year": 2024,
                    },
                },
            ],
            "rejected_records": [],
            "run_artifacts": [],
            "information_gaps": [],
        }
        input_value = {
            **V2_INPUT,
            "scope": {"time_range": "2022..2026"},
            "payload": {},
        }
        filtered = runner.apply_seed_literature_scope(collection, input_value)
        accepted_ids = {r["record_id"] for r in filtered["records"]}
        rejected_ids = {r["record_id"] for r in filtered["rejected_records"]}
        self.assertIn("doi:10.1145/in-scope", accepted_ids)
        self.assertIn("doi:10.9999/old", rejected_ids)
        self.assertIn("doi:10.9999/random", rejected_ids)
        self.assertEqual(filtered["literature_scope"]["stage"], "seed")
        self.assertTrue(
            any("year_out_of_range" in str(r.get("scope_decision", {}).get("reasons"))
                for r in filtered["rejected_records"]
                if r["record_id"] == "doi:10.9999/old")
        )

    def test_seed_scope_can_be_disabled(self):
        collection = literature_output(2)
        input_value = {
            **V2_INPUT,
            "payload": {"literature_scope": {"enabled": False}},
        }
        filtered = runner.apply_seed_literature_scope(collection, input_value)
        self.assertEqual(len(filtered["records"]), 2)
        self.assertNotIn("literature_scope", filtered)

    def test_search_plan_does_not_imply_ccf_only_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_path = root / "plan.json"
            output_path = root / "input.json"
            plan_path.write_text(
                json.dumps(
                    {
                        "keywords": ["synthetic topic", "synthetic model"],
                        "queries": ["synthetic topic model"],
                        "year_from": 2015,
                        "year_to": 2025,
                    }
                ),
                encoding="utf-8",
            )
            args = type(
                "Args",
                (),
                {
                    "input": None,
                    "plan": str(plan_path),
                    "question": "Review synthetic topic models.",
                    "collection_id": "synthetic",
                    "decision_context": "test",
                    "audience": "test",
                    "output": str(output_path),
                },
            )()
            runner.prepare_literature_input(args)
            prepared = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertFalse(
                prepared["payload"]["literature_scope"]["require_ccf_venue"]
            )
            self.assertFalse(
                prepared["payload"]["citation_expansion"]["enabled"]
            )

            record = literature_output(1)["records"][0]
            record["payload"].update(
                {
                    "title": "Synthetic topic model",
                    "abstract": "A synthetic model for the topic.",
                    "year": 2024,
                }
            )
            filtered = runner.apply_seed_literature_scope(
                {**literature_output(0), "records": [record]},
                prepared,
            )
            self.assertEqual(len(filtered["records"]), 1)

    def test_source_timeout_is_bounded_and_configurable(self):
        self.assertEqual(runner.source_timeout_seconds({}), 90.0)
        self.assertEqual(runner.source_timeout_seconds({"timeout_seconds": 30}), 30.0)
        self.assertEqual(runner.source_timeout_seconds({"timeout_seconds": 1}), 5.0)
        self.assertEqual(runner.source_timeout_seconds({"timeout_seconds": 900}), 600.0)

    def test_accepts_v2_literature_input(self):
        self.assertEqual(runner.input_version(V2_INPUT), "v2")

    def test_accepts_pdf_links_as_literature_content(self):
        value = json.loads(json.dumps(V2_INPUT))
        value["payload"]["pdf_links"] = {
            "enabled": True,
        }
        self.assertEqual(runner.input_version(value), "v2")

    def test_rejects_non_v2_input(self):
        with self.assertRaises(runner.CliError):
            runner.input_version({"collection_id": "legacy", "sources": []})
        with self.assertRaises(runner.CliError):
            runner.input_version({"schema_version": "clue.data-collection.input.v1"})


    def test_rejects_v2_missing_evidence_field(self):
        invalid = {**V2_INPUT, "evidence_policy": {"required_fields": ["source_url"]}}
        with self.assertRaises(runner.CliError):
            runner.input_version(invalid)

    def test_cybersecurity_catalog_selects_named_sources(self):
        selected = runner.selected_catalog_sources(
            {"topic": "cybersecurity", "source_ids": ["defcon", "phrack-news"]}
        )
        self.assertEqual([item["source_id"] for item in selected], ["defcon", "phrack-news"])

    def test_cybersecurity_catalog_includes_security_publications(self):
        selected = runner.selected_catalog_sources(
            {
                "topic": "cybersecurity",
                "source_ids": ["mlsec-top-100", "microsoft-security-research"],
            }
        )
        self.assertEqual(len(selected), 2)

    def test_cybersecurity_catalog_rejects_unrelated_source(self):
        with self.assertRaisesRegex(runner.CliError, "not available"):
            runner.selected_catalog_sources(
                {"topic": "cybersecurity", "source_ids": ["not-a-source"]}
            )

    def test_research_funding_catalog_contains_grant_sources(self):
        selected = runner.selected_catalog_sources(
            {
                "topic": "research-funding",
                "source_ids": [
                    "swiss-national-science-foundation-grants",
                    "us-national-science-foundation-awards",
                ],
            }
        )
        self.assertEqual(len(selected), 2)

    def test_catalog_search_tasks_are_unique_for_multiple_domains(self):
        sources = runner.selected_catalog_sources(
            {"topic": "cybersecurity", "source_ids": ["chaos-communication-congress"]}
        )
        tasks, source_by_task_id = runner.catalog_search_tasks(
            "conference-search", "agent permissions", "en-US", sources
        )
        self.assertEqual(len(tasks), 2)
        self.assertEqual(len(source_by_task_id), 2)
        self.assertEqual(len({task["task_id"] for task in tasks}), 2)

    def test_normalizes_curated_web_results_as_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "results.json"
            result_path.write_text(
                json.dumps(
                    {
                        "task_results": [{
                            "task_id": "site-search--defcon--1",
                            "status": "succeeded",
                            "searched_at": "2026-01-01T00:00:00Z",
                            "results": [{
                                "title": "Synthetic conference talk",
                                "url": "https://example.test/talk",
                                "content": "Synthetic result snippet.",
                            }],
                        }]
                    }
                ),
                encoding="utf-8",
            )
            normalized = runner.normalize_curated_web_search(
                V2_INPUT,
                str(result_path),
                {
                    "site-search--defcon--1": {
                        "source_id": "defcon",
                        "title": "DEF CON",
                        "topic_ids": ["cybersecurity"],
                        "seed_urls": ["https://example.test/archive"],
                    }
                },
            )
        self.assertEqual(normalized["records"][0]["record_kind"], "web-candidate")
        self.assertEqual(
            normalized["records"][0]["evidence"][0]["quote"], "Synthetic result snippet."
        )

    def test_normalizes_deepsec_papers_as_literature_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "results.json"
            result_path.write_text(
                json.dumps(
                    {
                        "schema_version": "clue.deepsec.search.v1",
                        "total": 1,
                        "papers": [{
                            "title": "Synthetic security paper",
                            "url": "https://example.test/paper",
                            "abstract": "Synthetic paper abstract.",
                            "conference": "CCS",
                            "year": 2024,
                        }],
                    }
                ),
                encoding="utf-8",
            )
            normalized = runner.normalize_deepsec(V2_INPUT, str(result_path))
        self.assertEqual(normalized["records"][0]["record_kind"], "literature-candidate")
        self.assertEqual(normalized["records"][0]["payload"]["conference"], "CCS")

    def test_collects_unvalidated_record_and_metadata_links(self):
        output = literature_output()
        output["records"][0]["payload"].update(
            {
                "URL": "https://source.example/landing",
                "link": [{"URL": "https://source.example/paper.pdf"}],
                "download_link": "https://source.example/download",
                "abstract": "https://not-a-link.example/ignored",
            }
        )

        linked = runner.collect_paper_links(output)
        links = linked["records"][0]["payload"]["pdf_links"]

        self.assertEqual(links["status"], "listed")
        self.assertEqual(links["validation"], "not_downloaded")
        urls = [item["url"] for item in links["candidates"]]
        self.assertIn("https://doi.example/0", urls)
        self.assertIn("https://source.example/landing", urls)
        self.assertIn("https://source.example/paper.pdf", urls)
        self.assertIn("https://source.example/download", urls)
        runner.validate_v2_output(linked)

    def test_exposes_s2_and_crossref_pdf_urls_for_phase2(self):
        output = literature_output()
        output["records"][0]["record_id"] = "doi:10.1145/3808103"
        output["records"][0]["source_url"] = "https://doi.org/10.1145/3808103"
        output["records"][0]["payload"].update(
            {
                "DOI": "10.1145/3808103",
                "source_tool": "semantic-scholar",
                "openAccessPdf": {"url": "https://arxiv.org/pdf/2510.21236"},
                "externalIds": {"DOI": "10.1145/3808103", "ArXiv": "2510.21236"},
                "link": [
                    {
                        "URL": "https://dl.acm.org/doi/pdf/10.1145/3808103",
                        "content-type": "unspecified",
                        "intended-application": "similarity-checking",
                    }
                ],
            }
        )
        linked = runner.collect_paper_links(output)
        candidates = linked["records"][0]["payload"]["pdf_links"]["candidates"]
        by_kind = {}
        for item in candidates:
            by_kind.setdefault(item["link_kind"], []).append(item["url"])
        self.assertIn("s2-open-access-pdf", by_kind)
        self.assertEqual(by_kind["s2-open-access-pdf"][0], "https://arxiv.org/pdf/2510.21236")
        self.assertIn("crossref-pdf", by_kind)
        self.assertTrue(any("arxiv.org/pdf/2510.21236" in u for u in by_kind.get("arxiv-pdf", [])))
        # Phase-2 scorer should rank provider PDF first.
        from literature.pdf_capture import candidate_urls_from_record

        ordered = candidate_urls_from_record(linked["records"][0])
        self.assertTrue(ordered)
        self.assertIn(
            ordered[0]["link_kind"],
            {"s2-open-access-pdf", "arxiv-pdf", "crossref-pdf"},
        )

    def test_accepts_retrieved_pdf_link_inventory(self):
        output = literature_output()
        output["records"][0]["payload"]["pdf_links"] = {
            "status": "listed",
            "validation": "retrieved",
            "local_pdf": "/tmp/example.pdf",
            "candidates": [
                {
                    "url": "https://source.example/paper.pdf",
                    "link_kind": "source-metadata",
                    "validation": "retrieved",
                    "local_path": "/tmp/example.pdf",
                    "bytes": 12,
                }
            ],
        }
        runner.validate_v2_output(output)

    def test_pipeline_phase_order_is_collection_then_augmentation_then_review(self):
        self.assertEqual(
            [name for _phase_id, name in runner.PIPELINE_PHASES],
            ["collection", "augmentation", "manual-review"],
        )
        self.assertEqual(runner.PHASE_COLLECTION, 1)
        self.assertEqual(runner.PHASE_AUGMENTATION, 2)
        self.assertEqual(runner.PHASE_MANUAL_REVIEW, 3)

    def test_pipeline_auto_pass_skips_the_review_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collection_base = root / "example-workspace" / "data-collections" / "example"
            collection_base.mkdir(parents=True)
            collected = literature_output(2)
            augmented, aug_phase = runner.phase_augmentation(
                V2_INPUT,
                collected,
                collection_base,
                "run-prefix",
                skip=False,
            )
            self.assertEqual(aug_phase["phase"], "augmentation")
            self.assertEqual(aug_phase["phase_id"], runner.PHASE_AUGMENTATION)
            self.assertEqual(aug_phase["status"], "succeeded")
            self.assertTrue(
                augmented["records"][0]["payload"]["qualification"]["manual_review_required"]
            )
            final, review_phase = runner.phase_manual_review(
                V2_INPUT,
                augmented,
                collection_base,
                review_mode="auto-pass",
            )
            self.assertEqual(review_phase["phase"], "manual-review")
            self.assertEqual(review_phase["phase_id"], runner.PHASE_MANUAL_REVIEW)
            self.assertEqual(review_phase["status"], "auto_passed")
            self.assertEqual(final["status"], "final")
            self.assertEqual(
                final["records"][0]["payload"]["manual_review"]["status"],
                "not_required",
            )
            self.assertEqual(
                final["records"][0]["payload"]["manual_review"]["mode"],
                "auto_pass",
            )
            self.assertEqual(
                final["records"][0]["payload"]["manual_review"]["phase"],
                "manual-review",
            )

    def test_pipeline_auto_approve_records_an_automatic_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = "example-workspace"
            (root / workspace).mkdir()
            collection_base = root / workspace / "data-collections" / "example"
            collection_base.mkdir(parents=True)
            augmented, _ = runner.phase_augmentation(
                V2_INPUT,
                literature_output(1),
                collection_base,
                "run-prefix",
                skip=False,
            )

            final, review_phase = runner.phase_manual_review(
                V2_INPUT,
                augmented,
                collection_base,
                review_mode="auto-approve",
            )

            self.assertEqual(review_phase["status"], "auto_approved")
            self.assertEqual(final["pipeline"]["review_mode"], "auto-approve")
            self.assertEqual(
                final["records"][0]["payload"]["manual_review"]["status"],
                "approved",
            )
            review_list = (
                root
                / workspace
                / "data-collections"
                / "example"
                / "outputs"
                / "manual-review-list.json"
            )
            self.assertTrue(review_list.is_file())

    def test_pipeline_manual_review_writes_portal_consumable_lists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = "example-workspace"
            (root / workspace).mkdir()
            collection_base = root / workspace / "data-collections" / "example"
            collection_base.mkdir(parents=True)
            collected = literature_output(1)
            augmented, _ = runner.phase_augmentation(
                V2_INPUT,
                collected,
                collection_base,
                "run-prefix",
                skip=False,
            )
            final, review_phase = runner.phase_manual_review(
                V2_INPUT,
                augmented,
                collection_base,
                review_mode="manual-review",
            )
            self.assertEqual(review_phase["phase"], "manual-review")
            self.assertEqual(review_phase["phase_id"], 3)
            self.assertEqual(review_phase["status"], "pending")
            self.assertEqual(final["status"], "pending_manual_review")
            review_list = (
                root
                / workspace
                / "data-collections"
                / "example"
                / "outputs"
                / "manual-review-list.json"
            )
            self.assertTrue(review_list.is_file())
            payload = json.loads(review_list.read_text(encoding="utf-8"))
            self.assertEqual(payload["review_mode"], "manual-review")
            self.assertEqual(len(payload["review_records"]), 1)

    def test_rejects_invalid_pdf_link_inventory(self):
        output = literature_output()
        output["records"][0]["payload"]["pdf_links"] = {
            "status": "listed",
            "validation": "not_downloaded",
            "candidates": [
                {
                    "url": "https://source.example/paper.pdf",
                    "link_kind": "source-metadata",
                    "validation": "downloaded",  # invalid enum value
                }
            ],
        }

        with self.assertRaisesRegex(runner.CliError, "validation"):
            runner.validate_v2_output(output)

    def test_normalizes_web_search_as_ad_content_social_posts(self):
        ad_input = {
            **V2_INPUT,
            "collection_id": "ad-demo",
            "collection_kind": "ad-content-intel",
            "source_tasks": [
                {
                    "task_id": "web1",
                    "source_type": "web-search",
                    "config": {"query": "护肤 种草"},
                }
            ],
            "payload": {"ad_content_scope": {"platforms": ["web"]}},
        }
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "results.json"
            result_path.write_text(
                json.dumps(
                    {
                        "task_results": [
                            {
                                "task_id": "web1",
                                "status": "succeeded",
                                "searched_at": "2026-01-01T00:00:00Z",
                                "query": "护肤 种草",
                                "results": [
                                    {
                                        "title": "Synthetic note title",
                                        "url": "https://example.test/note/1",
                                        "content": "Synthetic discovery snippet.",
                                    }
                                ],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            normalized = runner.normalize_web_search(ad_input, str(result_path))
        self.assertEqual(normalized["collection_kind"], "ad-content-intel")
        self.assertEqual(normalized["records"][0]["record_kind"], "social_post")
        self.assertEqual(
            normalized["records"][0]["payload"]["platform"], "web"
        )
        self.assertEqual(
            normalized["records"][0]["evidence"][0]["quote"],
            "Synthetic discovery snippet.",
        )
        runner.validate_v2_output(normalized)

    def test_normalizes_social_media_xiaohongshu_as_xhs_note(self):
        ad_input = {
            **V2_INPUT,
            "collection_id": "ad-xhs",
            "collection_kind": "ad-content-intel",
            "source_tasks": [
                {
                    "task_id": "xhs1",
                    "source_type": "social_media",
                    "config": {"platform": "xiaohongshu", "query": "口红"},
                }
            ],
            "payload": {"ad_content_scope": {"platforms": ["xiaohongshu"]}},
        }
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "social-media-candidates.json"
            result_path.write_text(
                json.dumps(
                    {
                        "schema_version": "clue.data-collection.social-media-candidates.v1",
                        "generated_at": "2026-01-01T00:00:00Z",
                        "candidates": [
                            {
                                "platform": "xiaohongshu",
                                "account_handle": "brand_demo",
                                "account_url": "https://www.xiaohongshu.com/user/profile/abc",
                                "post_url": "https://www.xiaohongshu.com/explore/note123",
                                "company_name": "Demo beauty brand",
                                "content": {
                                    "note_id": "note123",
                                    "title": "口红试色笔记",
                                    "note_type": "image",
                                    "author_handle": "brand_demo",
                                    "author_id": "abc",
                                    "engagement": {"likes": 9},
                                },
                                "source_trace": {
                                    "task_id": "xhs1",
                                    "query": "口红",
                                },
                            },
                            {
                                "platform": "instagram",
                                "account_handle": "ig_brand",
                                "account_url": "https://www.instagram.com/ig_brand/",
                                "post_url": "https://www.instagram.com/p/CODE/",
                                "company_name": "IG brand",
                                "public_business_evidence": ["explicit_business_flag:is_business_account"],
                                "source_trace": {"task_id": "ig1", "query": "beauty"},
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            normalized = runner.normalize_social_media(ad_input, str(result_path))
        kinds = {r["record_kind"] for r in normalized["records"]}
        self.assertIn("xhs_note", kinds)
        self.assertIn("social_post", kinds)
        xhs = next(r for r in normalized["records"] if r["record_kind"] == "xhs_note")
        self.assertEqual(xhs["payload"]["platform"], "xiaohongshu")
        self.assertEqual(xhs["payload"]["title"], "口红试色笔记")
        self.assertEqual(xhs["payload"]["note_id"], "note123")
        self.assertEqual(xhs["payload"]["engagement"]["likes"], 9)
        self.assertTrue(
            any("platform-routes" in gap for gap in normalized["information_gaps"])
        )
        runner.validate_v2_output(normalized)

    def test_ad_content_intel_augmentation_attaches_review_flags(self):
        ad_input = {
            **V2_INPUT,
            "collection_id": "ad-aug",
            "collection_kind": "ad-content-intel",
            "source_tasks": [
                {
                    "task_id": "web1",
                    "source_type": "web-search",
                    "config": {"query": "q"},
                }
            ],
            "payload": {},
        }
        collected = {
            "schema_version": runner.OUTPUT_V2,
            "collection_id": "ad-aug",
            "collection_kind": "ad-content-intel",
            "status": "candidate_set",
            "records": [
                {
                    "record_id": "url:abc",
                    "record_kind": "social_post",
                    "source_url": "https://example.test/post",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": "sha256:demo",
                    "evidence": [{"quote": "snippet", "locator": "search"}],
                    "payload": {
                        "platform": "web",
                        "title": "Demo",
                        "text": "snippet",
                    },
                }
            ],
            "rejected_records": [],
            "run_artifacts": [],
            "information_gaps": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = "example-workspace"
            (root / workspace).mkdir()
            collection_base = root / workspace / "data-collections" / "example"
            collection_base.mkdir(parents=True)
            augmented, aug_phase = runner.phase_augmentation(
                ad_input,
                collected,
                collection_base,
                "run-prefix",
                skip=False,
            )
            self.assertEqual(aug_phase["status"], "succeeded")
            self.assertEqual(aug_phase["mode"], "ad-content-intel")
            self.assertEqual(augmented["status"], "augmented_candidate_set")
            self.assertTrue(
                augmented["records"][0]["payload"]["qualification"][
                    "manual_review_required"
                ]
            )
            final, review_phase = runner.phase_manual_review(
                ad_input,
                augmented,
                collection_base,
                review_mode="auto-pass",
            )
            self.assertEqual(review_phase["status"], "auto_passed")
            self.assertEqual(final["status"], "final")
            self.assertEqual(final["collection_kind"], "ad-content-intel")
            runner.validate_v2_output(final)

    def test_ad_content_source_types_exclude_literature_providers(self):
        self.assertIn("social_media", runner.AD_CONTENT_SOURCE_TYPES)
        self.assertIn("web-search", runner.AD_CONTENT_SOURCE_TYPES)
        self.assertNotIn("crossref-search", runner.AD_CONTENT_SOURCE_TYPES)
        self.assertNotIn("deepsec-search", runner.AD_CONTENT_SOURCE_TYPES)

    def test_ad_content_phase2_media_enrich_image_dry_run(self):
        from ad_content.phase2 import run_augmentation

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            img = root / "slide.png"
            img.write_bytes(
                bytes.fromhex(
                    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
                    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
                )
            )
            ad_input = {
                **V2_INPUT,
                "collection_id": "ad-media",
                "collection_kind": "ad-content-intel",
                "source_tasks": [
                    {
                        "task_id": "t1",
                        "source_type": "social_media",
                        "config": {"platform": "xiaohongshu", "query": "q"},
                    }
                ],
                "payload": {
                    "ad_content_enrich": {"enabled": True, "dry_run": True},
                },
            }
            collected = {
                "schema_version": runner.OUTPUT_V2,
                "collection_id": "ad-media",
                "collection_kind": "ad-content-intel",
                "status": "candidate_set",
                "records": [
                    {
                        "record_id": "post:img1",
                        "record_kind": "xhs_note",
                        "source_url": "https://www.xiaohongshu.com/explore/img1",
                        "observed_at": "2026-01-01T00:00:00Z",
                        "content_hash": "sha256:img1",
                        "evidence": [{"quote": "caption", "locator": "title"}],
                        "payload": {
                            "platform": "xiaohongshu",
                            "title": "caption",
                            "text": "caption",
                            "note_type": "image",
                            "media": {"local_paths": [str(img)]},
                        },
                    }
                ],
                "rejected_records": [],
                "run_artifacts": [],
                "information_gaps": [],
            }
            work = root / "work"
            augmented, phase = run_augmentation(
                input_value=ad_input,
                collection_output=collected,
                work_dir=work,
                run_prefix="run1",
            )
            self.assertEqual(phase["status"], "succeeded")
            media = phase.get("media_enrich") or {}
            self.assertEqual(media.get("succeeded"), 1)
            self.assertEqual(media.get("image_reviews"), 1)
            rec = augmented["records"][0]
            self.assertIn("image_review_text", rec["payload"])
            self.assertTrue(
                any(
                    "image@" in str(e.get("locator")) or "carousel@" in str(e.get("locator"))
                    or e.get("locator") == "image@0"
                    for e in rec["evidence"]
                    if isinstance(e, dict)
                )
            )
            self.assertTrue(rec["payload"]["qualification"]["manual_review_required"])

    def test_ad_content_phase2_media_enrich_video_dry_run(self):
        import subprocess

        from ad_content.phase2 import run_augmentation
        from ad_content.support import tools_root

        ffmpeg = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, check=False
        )
        if ffmpeg.returncode != 0:
            self.skipTest("ffmpeg not available")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "clip.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=160x120:d=0.5",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880:duration=0.5",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(video),
                ],
                check=True,
                capture_output=True,
            )
            # Ensure video-review / image-review CLIs exist under tools/.
            self.assertTrue((tools_root() / "video-review" / "clue-video-review").is_file())
            ad_input = {
                **V2_INPUT,
                "collection_id": "ad-vid",
                "collection_kind": "ad-content-intel",
                "source_tasks": [
                    {
                        "task_id": "t1",
                        "source_type": "social_media",
                        "config": {"platform": "xiaohongshu", "query": "q"},
                    }
                ],
                "payload": {
                    "ad_content_enrich": {
                        "enabled": True,
                        "dry_run": True,
                        "skip_understand": False,
                    },
                },
            }
            collected = {
                "schema_version": runner.OUTPUT_V2,
                "collection_id": "ad-vid",
                "collection_kind": "ad-content-intel",
                "status": "candidate_set",
                "records": [
                    {
                        "record_id": "post:vid1",
                        "record_kind": "xhs_video",
                        "source_url": "https://www.xiaohongshu.com/explore/vid1",
                        "observed_at": "2026-01-01T00:00:00Z",
                        "content_hash": "sha256:vid1",
                        "evidence": [{"quote": "vid title", "locator": "title"}],
                        "payload": {
                            "platform": "xiaohongshu",
                            "title": "vid title",
                            "note_type": "video",
                            "media": {"local_video": str(video)},
                        },
                    }
                ],
                "rejected_records": [],
                "run_artifacts": [],
                "information_gaps": [],
            }
            augmented, phase = run_augmentation(
                input_value=ad_input,
                collection_output=collected,
                work_dir=root / "work",
                run_prefix="vrun",
            )
            media = phase.get("media_enrich") or {}
            self.assertEqual(media.get("video_reviews"), 1)
            self.assertEqual(media.get("succeeded"), 1)
            rec = augmented["records"][0]
            self.assertIn("transcript", rec["payload"])
            self.assertTrue(rec["payload"]["transcript"].get("text"))

    def test_pdf_capture_reuses_a_stable_camofox_session(self):
        from literature.pdf_capture import camofox_session_user_id

        previous = os.environ.get("BROWSER_CAMOFOX_USER_ID")
        try:
            os.environ.pop("BROWSER_CAMOFOX_USER_ID", None)
            self.assertEqual(camofox_session_user_id(), "polaris")
            os.environ["BROWSER_CAMOFOX_USER_ID"] = "polaris-host"
            self.assertEqual(camofox_session_user_id(), "polaris-host")
        finally:
            if previous is None:
                os.environ.pop("BROWSER_CAMOFOX_USER_ID", None)
            else:
                os.environ["BROWSER_CAMOFOX_USER_ID"] = previous


if __name__ == "__main__":
    unittest.main()
