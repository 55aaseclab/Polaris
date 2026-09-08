"""Unit tests for literature_topic_judge (mocked codex CLI)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import literature.topic_judge as tj  # noqa: E402


class LiteratureTopicJudgeTests(unittest.TestCase):
    def test_config_defaults_enabled_when_criteria(self) -> None:
        cfg = tj.topic_judge_config(
            {
                "question": "Q?",
                "scope": {"include": ["a"], "topic_criteria": ["need both X and Y"]},
                "payload": {"literature_scope": {}},
            }
        )
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["stages"], ["seed", "expand"])
        self.assertEqual(cfg["criteria"][0], "need both X and Y")

    def test_expand_buffer_filters_batches(self) -> None:
        input_value = {
            "question": "Agent security?",
            "scope": {
                "include": ["AI agents"],
                "topic_criteria": ["require agent + security"],
            },
            "payload": {
                "literature_scope": {
                    "topic_criteria": ["require agent + security"],
                    "topic_judge": {
                        "enabled": True,
                        "stages": ["expand"],
                        "batch_size": 2,
                        "cache": True,
                        "model": "gpt-5.4-mini",
                    },
                }
            },
        }

        def fake_run(**kwargs):  # type: ignore[no-untyped-def]
            judgments = []
            for r in kwargs["records"]:
                rid = r["record_id"]
                judgments.append(
                    {
                        "record_id": rid,
                        "in_scope": rid.endswith("in"),
                        "confidence": 0.9,
                        "reason": "mock",
                        "matched_aspects": [],
                        "title": r["payload"]["title"],
                    }
                )
            out = {
                "judgments": judgments,
                "codex_exit_code": 0,
                "in_scope_count": sum(1 for j in judgments if j["in_scope"]),
                "parse_error": None,
            }
            Path(kwargs["output_path"]).write_text(json.dumps(out) + "\n", encoding="utf-8")
            return out

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory) / "cache"
            work = Path(directory) / "work"
            with mock.patch.object(tj, "cache_root", return_value=cache_dir):
                with mock.patch.object(tj, "run_codex_topic_judge", side_effect=fake_run):
                    buf = tj.ExpandTopicJudgeBuffer(
                        input_value, work_dir=work, config=tj.topic_judge_config(input_value)
                    )
                    self.assertTrue(buf.enabled)
                    for rid, title in (
                        ("doi:in", "Agent isolation"),
                        ("doi:out", "Android permissions"),
                    ):
                        buf.enqueue(
                            {
                                "record_id": rid,
                                "payload": {"title": title, "abstract": "x"},
                                "scope_decision": {"in_bounds": True, "year": 2024},
                            }
                        )
                    accepted, rejected = buf.flush()
                    self.assertEqual({r["record_id"] for r in accepted}, {"doi:in"})
                    self.assertEqual({r["record_id"] for r in rejected}, {"doi:out"})
                    self.assertEqual(buf.stats["accepted"], 1)
                    self.assertEqual(buf.stats["rejected"], 1)

    def test_config_disabled_without_criteria(self) -> None:
        cfg = tj.topic_judge_config({"question": "Q?", "scope": {}, "payload": {}})
        self.assertFalse(cfg["enabled"])

    def test_apply_topic_judge_filters_with_cache(self) -> None:
        records = [
            {
                "record_id": "doi:in",
                "record_kind": "paper",
                "source_url": "https://example.com/in",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "a",
                "evidence": [{"quote": "x"}],
                "payload": {
                    "title": "Agent isolation sandbox",
                    "abstract": "Permissions for LLM agents.",
                },
            },
            {
                "record_id": "doi:out",
                "record_kind": "paper",
                "source_url": "https://example.com/out",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "b",
                "evidence": [{"quote": "y"}],
                "payload": {
                    "title": "Android permission model",
                    "abstract": "OS access control only.",
                },
            },
        ]
        collection = {
            "schema_version": "clue.data-collection.output.v2",
            "collection_id": "t",
            "collection_kind": "literature",
            "status": "candidate_set",
            "records": records,
            "rejected_records": [],
            "run_artifacts": [],
            "information_gaps": [],
        }
        input_value = {
            "question": "Agent security?",
            "scope": {
                "include": ["AI agents", "isolation"],
                "exclude": ["mobile OS only"],
                "topic_criteria": ["require agent + security"],
            },
            "payload": {
                "literature_scope": {
                    "topic_criteria": ["require agent + security"],
                    "topic_judge": {
                        "enabled": True,
                        "stages": ["seed"],
                        "batch_size": 10,
                        "cache": True,
                        "model": "gpt-5.4-mini",
                    },
                }
            },
        }

        def fake_run(**kwargs):  # type: ignore[no-untyped-def]
            recs = kwargs["records"]
            judgments = []
            for r in recs:
                rid = r["record_id"]
                judgments.append(
                    {
                        "record_id": rid,
                        "in_scope": rid == "doi:in",
                        "confidence": 0.9,
                        "reason": "mock",
                        "matched_aspects": [],
                        "title": r["payload"]["title"],
                    }
                )
            out = {
                "schema_version": "clue.codex.topic-judge.v1",
                "codex_exit_code": 0,
                "judgments": judgments,
                "in_scope_count": sum(1 for j in judgments if j["in_scope"]),
                "parse_error": None,
            }
            Path(kwargs["output_path"]).write_text(
                json.dumps(out) + "\n", encoding="utf-8"
            )
            return out

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory) / "cache"
            work = Path(directory) / "work"
            with mock.patch.object(tj, "cache_root", return_value=cache_dir):
                with mock.patch.object(tj, "run_codex_topic_judge", side_effect=fake_run):
                    out1 = tj.apply_topic_judge(
                        collection, input_value, work_dir=work, stage="seed"
                    )
                    self.assertEqual({r["record_id"] for r in out1["records"]}, {"doi:in"})
                    self.assertEqual(
                        {r["record_id"] for r in out1["rejected_records"]}, {"doi:out"}
                    )
                    self.assertIn("seed", out1["topic_judgments"])
                    self.assertEqual(out1["topic_judgments"]["seed"]["cache_misses"], 2)
                    # second pass: all cache hits, no CLI
                    with mock.patch.object(
                        tj, "run_codex_topic_judge", side_effect=AssertionError("no call")
                    ):
                        out2 = tj.apply_topic_judge(
                            collection, input_value, work_dir=work, stage="seed"
                        )
                    self.assertEqual(out2["topic_judgments"]["seed"]["cache_hits"], 2)
                    self.assertEqual(out2["topic_judgments"]["seed"]["cache_misses"], 0)
                    self.assertEqual({r["record_id"] for r in out2["records"]}, {"doi:in"})


if __name__ == "__main__":
    unittest.main()
