import json
import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "review.py"
SPEC = importlib.util.spec_from_file_location(
    "polaris_literature_analysis_review_test_module", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
AnalysisReview = MODULE.AnalysisReview
AnalysisReviewError = MODULE.AnalysisReviewError
ReviewPaths = MODULE.ReviewPaths


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def manual_document(revision_hash: str) -> dict:
    return {
        "schema_version": "clue.manual-review.v2",
        "review_set_id": "analysis:synthetic:snapshot",
        "review_kind": "intelligence_finding",
        "generated_at": "2026-01-01T00:00:00Z",
        "review_records": [
            {
                "record_id": "claim-001",
                "review_key": "claim:synthetic:claim-001",
                "revision_hash": revision_hash,
                "title": "Synthetic claim",
                "summary": "A claim requiring confirmation.",
                "evidence": [
                    {
                        "source_url": "https://source.example/paper",
                        "source_excerpt": "Synthetic evidence.",
                        "observed_at": "2026-01-01T00:00:00Z",
                    }
                ],
            }
        ],
    }


class AnalysisReviewTests(unittest.TestCase):
    def make_case(self) -> tuple[tempfile.TemporaryDirectory, ReviewPaths, Path]:
        temporary = tempfile.TemporaryDirectory(prefix="polaris-analysis-review-")
        root = Path(temporary.name)
        manual = root / "outputs" / "manual-review-list.json"
        state = root / "work" / "manual-review" / "review-state.json"
        output = root / "work" / "manual-review" / "review-result.json"
        write_json(manual, manual_document("sha256:revision-a"))
        return temporary, ReviewPaths(manual, state, output), manual

    def test_save_and_export_bind_decisions_to_revision(self) -> None:
        temporary, paths, _manual = self.make_case()
        try:
            review = AnalysisReview(paths)
            self.assertEqual(review.bootstrap()["summary"]["pending"], 1)
            saved = review.save("claim-001", "approved", "Synthetic approval.")
            self.assertEqual(saved["review"]["revision_hash"], "sha256:revision-a")
            exported = review.export()
            self.assertEqual(exported["approved_count"], 1)
            result = json.loads(paths.output.read_text(encoding="utf-8"))
            self.assertEqual(result["schema_version"], "clue.manual-review.result.v2")
            self.assertEqual(result["producer"]["name"], "polaris-literature-review")
            self.assertEqual(
                result["approved_records"][0]["manual_review"]["revision_hash"],
                "sha256:revision-a",
            )
        finally:
            temporary.cleanup()

    def test_input_revision_invalidates_existing_decision(self) -> None:
        temporary, paths, manual = self.make_case()
        try:
            review = AnalysisReview(paths)
            review.save("claim-001", "approved", "Approved before revision.")
            write_json(manual, manual_document("sha256:revision-b"))
            refreshed = AnalysisReview(paths)
            self.assertEqual(refreshed.bootstrap()["summary"]["pending"], 1)
            self.assertEqual(refreshed.bootstrap()["reviews"], {})
            self.assertTrue(
                any(
                    item["action"] == "review_revision_invalidated"
                    for item in refreshed.state["audit"]
                )
            )
        finally:
            temporary.cleanup()

    def test_missing_required_finding_fields_fail_closed(self) -> None:
        temporary, paths, manual = self.make_case()
        try:
            document = manual_document("sha256:revision-a")
            del document["review_records"][0]["evidence"]
            write_json(manual, document)
            with self.assertRaisesRegex(AnalysisReviewError, "evidence"):
                AnalysisReview(paths)
        finally:
            temporary.cleanup()


if __name__ == "__main__":
    unittest.main()
