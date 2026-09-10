"""Offline unit tests for clue-codex-cli (no codex network calls)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import runner  # noqa: E402


class CodexRunnerTests(unittest.TestCase):
    def test_paper_fields_from_record(self) -> None:
        record = {
            "record_id": "doi:10.1145/3808103",
            "payload": {
                "title": "AgentBound: Securing Execution Boundaries of AI Agents",
                "abstract": "We study MCP and agent isolation.",
            },
        }
        fields = runner._paper_fields(record)
        self.assertEqual(fields["record_id"], "doi:10.1145/3808103")
        self.assertIn("AgentBound", fields["title"])
        self.assertIn("MCP", fields["abstract"])

    def test_build_topic_prompt_includes_scope_and_papers(self) -> None:
        prompt = runner.build_topic_prompt(
            question="Agent permission isolation?",
            include=["AI agents", "permission control"],
            exclude=["non-agent work"],
            papers=[
                {
                    "record_id": "doi:10.1/x",
                    "title": "Permission control for LLM agents",
                    "abstract": "Sandbox isolation for tools.",
                }
            ],
            criteria=["Require both agent systems and access-control aspects."],
        )
        self.assertIn("Agent permission isolation?", prompt)
        self.assertIn("permission control", prompt)
        self.assertIn("doi:10.1/x", prompt)
        self.assertIn("Require both agent systems and access-control aspects.", prompt)
        # Domain rules must come from scope/criteria, not the tool.
        self.assertNotIn("MCP/tool-using agents", prompt)
        self.assertNotIn("mobile OS permissions", prompt)

    def test_build_topic_prompt_is_domain_agnostic_without_criteria(self) -> None:
        prompt = runner.build_topic_prompt(
            question="What surveys cover graph neural networks?",
            include=["graph neural networks", "survey"],
            exclude=["pure CV without graphs"],
            papers=[{"record_id": "a", "title": "GNN survey", "abstract": "..."}],
        )
        self.assertIn("graph neural networks", prompt)
        self.assertIn("do not apply extra domain assumptions", prompt)
        self.assertNotIn("AI/LLM agents", prompt)

    def test_load_records_from_collection_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.json"
            path.write_text(
                json.dumps(
                    {
                        "records": [
                            {"record_id": "a", "payload": {"title": "T"}},
                            {"record_id": "b", "payload": {"title": "U"}},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            records = runner.load_records(path, limit=1)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["record_id"], "a")

    def test_default_model(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False):
            # ensure fallback
            env = {k: v for k, v in __import__("os").environ.items() if k != "CODEX_MODEL"}
            with mock.patch.dict("os.environ", env, clear=True):
                self.assertEqual(runner.default_model(), "gpt-5.4-mini")

    def test_topic_schema_exists(self) -> None:
        schema = TOOL_ROOT / "schemas" / "topic-judgment.schema.json"
        self.assertTrue(schema.is_file())
        doc = json.loads(schema.read_text(encoding="utf-8"))
        self.assertIn("judgments", doc["properties"])

    def test_parse_judgments_json(self) -> None:
        items, err = runner.parse_judgments_json(
            '{"judgments":[{"record_id":"a","in_scope":true,"confidence":1,"reason":"ok"}]}'
        )
        self.assertIsNone(err)
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["in_scope"])
        items, err = runner.parse_judgments_json("```json\n{\"judgments\":[]}\n```")
        self.assertIsNone(err)
        self.assertEqual(items, [])

    def test_failed_codex_result_preserves_process_diagnostics(self) -> None:
        completed = __import__("subprocess").CompletedProcess(
            args=["codex"],
            returncode=1,
            stdout="",
            stderr="service unavailable",
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "plan.json"
            last_message = Path(directory) / "last-message.txt"
            with mock.patch.object(
                runner,
                "_run_topic_codex",
                return_value=(completed, "", "freeform"),
            ):
                status = runner.command_plan_search_keywords(
                    __import__("argparse").Namespace(
                        question="synthetic question",
                        scope=None,
                        output=str(output),
                        last_message=str(last_message),
                        model="synthetic-model",
                        sandbox="read-only",
                        cd=None,
                        full_auto=False,
                        timeout=10,
                        config=[],
                    ),
                    TOOL_ROOT,
                )
            self.assertEqual(status, 2)
            wrapper = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(wrapper["exit_code"], 1)
            self.assertEqual(wrapper["stderr"], "service unavailable")
            self.assertIsNone(wrapper["plan"])

if __name__ == "__main__":
    unittest.main()
