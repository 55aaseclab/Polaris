"""Offline unit tests for clue-semantic-scholar-cli."""

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


class SemanticScholarRunnerTests(unittest.TestCase):
    def test_normalize_doi(self) -> None:
        self.assertEqual(runner.normalize_doi("https://doi.org/10.1145/3808103"), "10.1145/3808103")
        self.assertEqual(runner.normalize_doi("doi:10.1109/OJCS.2025.3589638"), "10.1109/OJCS.2025.3589638")
        self.assertEqual(runner.normalize_doi("DOI:10.1145/3808103"), "10.1145/3808103")

    def test_paper_external_doi(self) -> None:
        paper = {"externalIds": {"DOI": "10.1145/3808103", "ArXiv": "2510.21236"}}
        self.assertEqual(runner.paper_external_doi(paper), "10.1145/3808103")

    def test_search_uses_http_helper(self) -> None:
        fake = {"data": [{"paperId": "abc", "title": "Example", "externalIds": {"DOI": "10.1/x"}}]}
        with mock.patch.object(runner, "http_get_json", return_value=fake) as get:
            papers = runner.search_papers("agent isolation", limit=5)
        self.assertEqual(len(papers), 1)
        self.assertIn("paper/search", get.call_args[0][0])

    def test_http_json_caches_successful_get(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            runner._CACHE_ROOT = cache_dir  # noqa: SLF001
            runner._MEM_CACHE.clear()  # noqa: SLF001
            url = "https://api.semanticscholar.org/graph/v1/paper/abc?fields=title"
            payload = {"paperId": "abc", "title": "Cached"}

            class _Resp:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def read(self):
                    return json.dumps(payload).encode("utf-8")

            with mock.patch.object(runner.time, "sleep", lambda *_: None):
                with mock.patch.object(runner.urllib.request, "urlopen", return_value=_Resp()) as open_mock:
                    first = runner.http_json("GET", url)
                    second = runner.http_json("GET", url)
            self.assertEqual(first["title"], "Cached")
            self.assertEqual(second["title"], "Cached")
            self.assertEqual(open_mock.call_count, 1)
            # disk file written
            files = list(cache_dir.rglob("*.json"))
            self.assertEqual(len(files), 1)
            runner._CACHE_ROOT = None  # noqa: SLF001
            runner._MEM_CACHE.clear()  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
