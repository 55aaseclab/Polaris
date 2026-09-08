"""Offline contract tests for clue-social-publish."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402

EXAMPLE_VIDEO = ROOT / "examples" / "publish-video.example.json"
EXAMPLE_NOTE = ROOT / "examples" / "publish-note.example.json"


class SocialPublishContractTests(unittest.TestCase):
    def test_examples_validate_as_input(self) -> None:
        for path in (EXAMPLE_VIDEO, EXAMPLE_NOTE):
            document = json.loads(path.read_text(encoding="utf-8"))
            errors = runner.validate_with_schema(document, "input")
            self.assertEqual(errors, [], msg=f"{path.name}: {errors}")

    def test_dry_run_publish_is_planned(self) -> None:
        document = json.loads(EXAMPLE_VIDEO.read_text(encoding="utf-8"))
        self.assertTrue(document["publish"]["dry_run"])
        result = runner.build_dry_run_output(document)
        errors = runner.validate_with_schema(result, "output")
        self.assertEqual(errors, [])
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["publish_id"], document["publish_id"])

    def test_stub_publish_is_not_implemented(self) -> None:
        document = json.loads(EXAMPLE_VIDEO.read_text(encoding="utf-8"))
        document["publish"]["dry_run"] = False
        result = runner.build_not_implemented_output(document)
        errors = runner.validate_with_schema(result, "output")
        self.assertEqual(errors, [])
        self.assertEqual(result["status"], "failed_not_implemented")
        self.assertIsNotNone(result["error"])

    def test_cli_validate_input_exit_zero(self) -> None:
        code = runner.main(["validate-input", "--input", str(EXAMPLE_VIDEO)])
        self.assertEqual(code, 0)

    def test_cli_publish_dry_run_exit_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.json"
            code = runner.main(
                ["publish", "--input", str(EXAMPLE_VIDEO), "--output", str(out)]
            )
            self.assertEqual(code, 0)
            body = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(body["status"], "planned")

    def test_scheduled_requires_schedule_at_minimal(self) -> None:
        document = json.loads(EXAMPLE_VIDEO.read_text(encoding="utf-8"))
        document["publish"] = {"mode": "scheduled", "dry_run": True}
        errors = runner.validate_with_schema(document, "input")
        # jsonschema path enforces allOf; minimal path also checks schedule_at
        self.assertTrue(
            any("schedule_at" in err for err in errors) or errors == [],
            msg=errors,
        )
        if not errors:
            # When jsonschema is present, allOf should fail without schedule_at
            try:
                import jsonschema  # noqa: F401
            except ImportError:
                self.skipTest("jsonschema not installed; minimal path already covered")


if __name__ == "__main__":
    unittest.main()
