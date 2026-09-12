import json
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "review.py"
SPEC = importlib.util.spec_from_file_location(
    "polaris_manual_review_test_module", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
COLLECTION_RESULT_SCHEMA = MODULE.COLLECTION_RESULT_SCHEMA
ManualReview = MODULE.ManualReview
ManualReviewError = MODULE.ManualReviewError
ManualReviewPaths = MODULE.ManualReviewPaths


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def record(record_id: str, *, duplicate_group_id: str | None = None) -> dict:
    value = {
        "record_id": record_id,
        "record_kind": "literature-candidate",
        "source_url": f"https://source.example/{record_id}",
        "observed_at": "2026-01-01T00:00:00Z",
        "content_hash": f"sha256:{record_id}",
        "evidence": [{"quote": f"Evidence for {record_id}."}],
        "payload": {"title": f"Synthetic paper {record_id}"},
    }
    if duplicate_group_id:
        value["deduplication"] = {"duplicate_group_id": duplicate_group_id}
    return value


class ManualReviewTests(unittest.TestCase):
    def make_case(self) -> tuple[tempfile.TemporaryDirectory, ManualReviewPaths]:
        temporary = tempfile.TemporaryDirectory(prefix="polaris-manual-review-")
        root = Path(temporary.name)
        outputs = root / "data-collections" / "synthetic" / "outputs"
        manual = outputs / "manual-review-list.json"
        non_review = outputs / "non-review-results.json"
        state = outputs.parent / "work" / "review-state.json"
        result = outputs / "review-output.json"
        write_json(
            manual,
            {
                "schema_version": "clue.data-collection.review-list.v1",
                "collection_id": "synthetic",
                "collection_kind": "literature",
                "review_records": [
                    record("paper-alpha", duplicate_group_id="group-alpha"),
                    record("paper-beta"),
                ],
            },
        )
        write_json(
            non_review,
            {
                "schema_version": "clue.data-collection.non-review.v1",
                "collection_id": "synthetic",
                "collection_kind": "literature",
                "qualified_without_manual_review": [record("paper-auto")],
                "rejected_records": [record("paper-source-rejected")],
            },
        )
        return temporary, ManualReviewPaths.from_values(
            manual_list=manual,
            non_review=non_review,
            state=state,
            output=result,
        )

    def test_state_update_and_export_preserve_stable_review_identity(self) -> None:
        temporary, paths = self.make_case()
        try:
            review = ManualReview(paths)
            bootstrapped = review.bootstrap()
            self.assertEqual(bootstrapped["summary"]["manual_review_pending"], 2)
            self.assertEqual(bootstrapped["tool"]["name"], "polaris-manual-review")

            review.save("paper-alpha", "approved", "Synthetic approval.")
            review.save("paper-beta", "rejected", "Synthetic rejection.")
            exported = review.export()
            self.assertEqual(exported["outreach_ready_count"], 2)
            self.assertEqual(exported["manually_rejected_count"], 1)
            self.assertEqual(exported["pending_manual_review_count"], 0)

            document = json.loads(paths.output.read_text(encoding="utf-8"))
            self.assertEqual(document["schema_version"], COLLECTION_RESULT_SCHEMA)
            self.assertEqual(document["producer"]["name"], "polaris-manual-review")
            self.assertEqual(document["summary"]["manual_review_approved"], 1)
            self.assertEqual(document["summary"]["manual_review_rejected"], 1)
            state = json.loads(paths.state.read_text(encoding="utf-8"))
            self.assertEqual(state["reviews"]["candidate:group-alpha"]["status"], "approved")
            self.assertEqual(state["reviews"]["record:paper-beta"]["status"], "rejected")
        finally:
            temporary.cleanup()

    def test_legacy_record_id_state_is_migrated_without_losing_decision(self) -> None:
        temporary, paths = self.make_case()
        try:
            write_json(
                paths.state,
                {
                    "schema_version": "clue.data-collection.review-state.v1",
                    "collection_id": "synthetic",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "reviews": {
                        "paper-alpha": {
                            "status": "approved",
                            "note": "Legacy synthetic decision.",
                            "updated_at": "2026-01-01T00:00:00Z",
                        }
                    },
                    "sources": {},
                    "audit": [],
                },
            )
            review = ManualReview(paths)
            self.assertEqual(review.bootstrap()["reviews"]["paper-alpha"]["status"], "approved")
            self.assertEqual(review.bootstrap()["summary"]["manual_review_pending"], 1)
            self.assertTrue(any(item["action"] == "review_identity_migrated" for item in review.state["audit"]))
        finally:
            temporary.cleanup()

    def test_completed_review_reconstitutes_a_final_literature_v2_handoff(self) -> None:
        temporary, paths = self.make_case()
        try:
            review = ManualReview(paths)
            base = {
                "schema_version": "clue.data-collection.output.v2",
                "collection_id": "synthetic",
                "collection_kind": "literature",
                "status": "pending_manual_review",
                "records": [record("paper-alpha"), record("paper-beta"), record("paper-auto")],
                "rejected_records": [record("paper-source-rejected")],
                "run_artifacts": [],
                "information_gaps": [],
                "pipeline": {
                    "phases": [{"phase": "manual-review", "status": "pending"}]
                },
            }
            with self.assertRaisesRegex(ManualReviewError, "still pending"):
                review.finalize_collection_output(base)
            review.save("paper-alpha", "approved", "Approved.")
            review.save("paper-beta", "rejected", "Rejected.")
            exported = review.build_export()
            final = review.finalize_collection_output(base, review_output=exported)
            self.assertEqual(final["status"], "final")
            self.assertEqual([item["record_id"] for item in final["records"]], ["paper-auto", "paper-alpha"])
            self.assertEqual(
                [item["record_id"] for item in final["rejected_records"]],
                ["paper-source-rejected", "paper-beta"],
            )
            self.assertEqual(final["pipeline"]["manual_review"], "completed")
            self.assertEqual(final["pipeline"]["phases"][0]["status"], "completed")
        finally:
            temporary.cleanup()


if __name__ == "__main__":
    unittest.main()
