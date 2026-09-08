"""Offline tests for the DeepSec API client."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))
import runner  # noqa: E402


class DeepSecTests(unittest.TestCase):
    def test_encodes_repeated_search_areas_and_filters(self) -> None:
        url = runner.search_url(
            "http://api.test/search",
            "agent permissions 中文",
            ["title", "abstract"],
            "CCS",
            2024,
            10,
            20,
        )

        self.assertIn("keyword=agent+permissions+%E4%B8%AD%E6%96%87", url)
        self.assertIn("search_in=title&search_in=abstract", url)
        self.assertIn("conference=CCS", url)
        self.assertIn("year=2024", url)

    def test_search_persists_api_response(self) -> None:
        response = {"total": 1, "papers": [{"title": "Synthetic paper"}]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results.json"
            with patch("runner.request_search", return_value=response):
                result = runner.command_search(
                    Namespace(
                        keyword="agent permissions",
                        question=None,
                        search_in=["title"],
                        conference=None,
                        year=None,
                        limit=20,
                        offset=0,
                        output=str(output),
                    ),
                    TOOL_ROOT,
                )

            saved = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(result, 0)
        self.assertEqual(saved["total"], 1)
        self.assertEqual(saved["papers"][0]["title"], "Synthetic paper")

    def test_rejects_invalid_limit(self) -> None:
        with self.assertRaisesRegex(runner.CliError, "limit"):
            runner.search_url("http://api.test/search", "test", [], None, None, 101, 0)


if __name__ == "__main__":
    unittest.main()
