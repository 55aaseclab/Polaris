"""Unit tests for clue-image-review (dry-run only)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402


class ImageReviewTests(unittest.TestCase):
    def test_version(self):
        self.assertEqual(runner.main(["version"]), 0)

    def test_dry_run_review(self):
        with tempfile.TemporaryDirectory() as directory:
            img = Path(directory) / "slide.png"
            # Minimal valid 1x1 PNG
            img.write_bytes(
                bytes.fromhex(
                    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
                    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
                )
            )
            out = Path(directory) / "out.json"
            code = runner.main(
                [
                    "review",
                    "--image",
                    str(img),
                    "--output",
                    str(out),
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0)
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["schema_version"], runner.SCHEMA)
            self.assertTrue(doc["dry_run"])
            self.assertTrue(doc["text"])
            self.assertEqual(len(doc["images"]), 1)
            self.assertTrue(doc["evidence"])

    def test_rejects_missing_image(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "out.json"
            code = runner.main(
                ["review", "--image", str(Path(directory) / "nope.jpg"), "--output", str(out), "--dry-run"]
            )
            self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
