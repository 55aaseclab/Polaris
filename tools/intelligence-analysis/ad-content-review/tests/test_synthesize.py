"""Tests for ad-content-review synthesize (lexical-only offline path)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402
from synthesize import synthesize_judgments  # noqa: E402


class SynthesizeTests(unittest.TestCase):
    def test_lexical_emits_judgments_with_evidence(self):
        clues = [
            {
                "clue_id": "post:1",
                "source_url": "https://www.xiaohongshu.com/explore/1",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "sha256:1",
                "source_metadata": {
                    "platform": "xiaohongshu",
                    "title": "护肤 种草 精华",
                    "note_type": "image",
                    "engagement": {"likes": 120},
                },
                "observations": [
                    {
                        "observation_id": "post:1:evidence-1",
                        "quote": "这款精华真的好用 护肤种草",
                        "locator": "title",
                    }
                ],
            },
            {
                "clue_id": "post:2",
                "source_url": "https://www.xiaohongshu.com/explore/2",
                "observed_at": "2026-01-01T00:00:00Z",
                "content_hash": "sha256:2",
                "source_metadata": {
                    "platform": "xiaohongshu",
                    "title": "夏季防晒",
                    "note_type": "video",
                },
                "observations": [
                    {
                        "observation_id": "post:2:evidence-1",
                        "quote": "防晒分享",
                        "locator": "title",
                    }
                ],
            },
        ]
        result = synthesize_judgments(
            case_id="case-ad",
            question="小红书护肤种草内容在讲什么",
            decision_context="内容情报 电商",
            audience="ops",
            clues=clues,
            snapshot_id="snap-1",
            snapshot_sha256="sha256:snap",
            policy={"minimum_confidence": 0.5},
            lexical_only=True,
        )
        self.assertEqual(result["status"], "final")
        self.assertEqual(result["review"]["summary"]["executor_status"], "lexical-only")
        self.assertGreaterEqual(len(result["judgments"]), 1)
        claim = result["judgments"][0]
        self.assertTrue(claim["evidence"][0]["source_url"])
        self.assertEqual(claim["review_decision"]["status"], "approved")

    def test_cli_lexical_synthesize_and_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            prepared = {
                "task": {
                    "case_id": "c1",
                    "question": "护肤 种草",
                    "decision_context": "content",
                    "audience": "ops",
                    "review_policy": {"minimum_confidence": 0.5},
                },
                "collection_snapshot": {
                    "snapshot_id": "s1",
                    "clues": [
                        {
                            "clue_id": "post:a",
                            "source_url": "https://example.test/a",
                            "observed_at": "2026-01-01T00:00:00Z",
                            "source_metadata": {"platform": "web", "title": "护肤笔记"},
                            "observations": [
                                {
                                    "observation_id": "post:a:1",
                                    "quote": "护肤种草分享",
                                    "locator": "title",
                                }
                            ],
                        }
                    ],
                },
            }
            inp = Path(directory) / "in.json"
            out = Path(directory) / "out.json"
            md = Path(directory) / "out.md"
            inp.write_text(json.dumps(prepared), encoding="utf-8")
            self.assertEqual(
                runner.main(
                    [
                        "synthesize",
                        "--input",
                        str(inp),
                        "--output",
                        str(out),
                        "--lexical-only",
                    ]
                ),
                0,
            )
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertTrue(doc["judgments"])
            self.assertEqual(doc["review"]["summary"]["executor_status"], "lexical-only")
            self.assertEqual(
                runner.main(
                    ["render-markdown", "--input", str(out), "--output", str(md)]
                ),
                0,
            )
            self.assertTrue(md.is_file())


if __name__ == "__main__":
    unittest.main()
