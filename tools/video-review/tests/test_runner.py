"""Unit tests for clue-video-review (ffmpeg + dry-run ASR)."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402


def _make_silent_mp4(path: Path, seconds: float = 1.0) -> None:
    ffmpeg = runner.find_ffmpeg()
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s=320x240:d={seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


class VideoReviewTests(unittest.TestCase):
    def test_version(self):
        self.assertEqual(runner.main(["version"]), 0)

    def test_extract_audio_and_keyframes(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "clip.mp4"
            _make_silent_mp4(video)
            audio = Path(directory) / "a.wav"
            frames = Path(directory) / "frames"
            self.assertEqual(
                runner.main(
                    ["extract-audio", "--video", str(video), "--output", str(audio)]
                ),
                0,
            )
            self.assertTrue(audio.is_file() and audio.stat().st_size > 32)
            self.assertEqual(
                runner.main(
                    [
                        "extract-keyframes",
                        "--video",
                        str(video),
                        "--output-dir",
                        str(frames),
                        "--count",
                        "3",
                    ]
                ),
                0,
            )
            self.assertGreaterEqual(len(list(frames.glob("frame-*.jpg"))), 1)

    def test_review_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "clip.mp4"
            _make_silent_mp4(video, seconds=1.2)
            work = Path(directory) / "work"
            out = Path(directory) / "review.json"
            code = runner.main(
                [
                    "review",
                    "--video",
                    str(video),
                    "--work-dir",
                    str(work),
                    "--output",
                    str(out),
                    "--dry-run",
                    "--frame-count",
                    "2",
                ]
            )
            self.assertEqual(code, 0)
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["schema_version"], runner.SCHEMA)
            self.assertTrue(doc["dry_run"])
            self.assertTrue(doc["audio_path"])
            self.assertIn("transcript", doc)
            self.assertTrue(doc["evidence"])
            self.assertIsNotNone(doc.get("understand"))


if __name__ == "__main__":
    unittest.main()
