"""Synthetic tests for the opt-in XHS deep-capture path."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ad_content.xhs_capture import capture_post, repair_incomplete_replies  # noqa: E402
from ad_content.xhs_knowledge import build_knowledge  # noqa: E402
from ad_content.startup_investor_simulation import compare_strategies  # noqa: E402


class Response:
    def __init__(self, data, *, success=True, code=0, message=""):
        self.success = success
        self.code = code
        self.message = message
        self.data = data
        self.raw_json = {"code": code, "data": data, "message": message}


class FakeXhs:
    def __init__(self):
        self.comment_calls: list[str | None] = []
        self.reply_calls: list[str | None] = []

    def share_url_transfer_v1(self, *, share_url):
        self.share_url = share_url
        return Response(
            {"redirect_url": "https://www.xiaohongshu.com/discovery/item/abcdef1234567890"}
        )

    def get_note_detail_v7(self, *, note_id):
        return Response(None, success=False, code=301, message="temporary provider failure")

    def get_note_detail_v4(self, *, note_id):
        return Response(
            [
                {
                    "model_type": "note",
                    "note_list": [
                        {
                            "id": note_id,
                            "title": "0—1 之后如何融资？",
                            "desc": "先验证收入和数据，再比较股权稀释与贷款利息。",
                            "time": 1780000000,
                            "type": "normal",
                            "liked_count": 10,
                            "collected_count": 4,
                            "comments_count": 4,
                            "shared_count": 2,
                            "user": {"nickname": "synthetic-author", "id": "private-id"},
                            "ip_location": "private-location",
                            "images_list": [
                                {
                                    "fileid": "image-1",
                                    "url": "https://example.test/signed-image.jpg",
                                }
                            ],
                            "share_info": {"image": "https://example.test/fallback.jpg"},
                        }
                    ],
                }
            ]
        )

    def _parent(self, ident, text, *, replies=0, image=False):
        item = {
            "id": ident,
            "content": text,
            "time": 1780000100,
            "like_count": 2,
            "sub_comment_count": replies,
            "sub_comments": [],
            "user": {"nickname": "commenter", "userid": "private-id"},
            "ip_location": "private-location",
        }
        if image:
            item["images"] = [{"url": "https://example.test/comment-image.png"}]
        return item

    def get_note_comment_v4(self, *, note_id, last_cursor=None, sort="latest"):
        self.comment_calls.append(last_cursor)
        if last_cursor is None:
            parent = self._parent("comment-1", "投资前需要看真实数据。", replies=2, image=True)
            parent["sub_comments"] = [
                self._parent("reply-1", "同意先验证再谈估值。", replies=0)
            ]
            return Response(
                {
                    "comments": [parent],
                    "comment_count": 4,
                    "comment_count_l1": 2,
                    "cursor": "cursor-1",
                    "has_more": True,
                }
            )
        return Response(
            {
                "comments": [self._parent("comment-2", "贷款保留股权，但要能还利息。")],
                "cursor": "",
                "has_more": False,
            }
        )

    def get_note_sub_comment_v2(self, *, note_id, comment_id, last_cursor=None):
        self.reply_calls.append(last_cursor)
        return Response(
            {
                "comments": [
                    self._parent("reply-2", "无限连带责任需要谨慎。", replies=0, image=True)
                ],
                "cursor": "",
                "has_more": False,
            }
        )


class FakeClient:
    def __init__(self):
        self.xiaohongshu = FakeXhs()


class BrokenReplyXhs(FakeXhs):
    def get_note_sub_comment_v2(self, *, note_id, comment_id, last_cursor=None):
        return Response(None, success=False, code=503, message="synthetic reply outage")


class BrokenReplyClient:
    def __init__(self):
        self.xiaohongshu = BrokenReplyXhs()


class CaptureTests(unittest.TestCase):
    def test_capture_paginates_threads_downloads_and_minimizes_data(self):
        fetched: list[str] = []

        def fetcher(url: str, timeout: int, max_bytes: int):
            fetched.append(url)
            if "signed-image" in url:
                raise OSError("expired signed URL")
            return (b"synthetic-image-bytes", "image/jpeg")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = capture_post(
                shared_url="https://xhslink.cn/o/synthetic",
                output_dir=output,
                client=FakeClient(),
                fetcher=fetcher,
                sleep=lambda _: None,
            )
            text = result["text"]
            self.assertEqual(text["source"]["note_id"], "abcdef1234567890")
            self.assertEqual(text["coverage"]["captured_total_comments"], 4)
            self.assertEqual(text["coverage"]["captured_first_level_comments"], 2)
            self.assertEqual(text["coverage"]["downloaded_comment_images"], 2)
            self.assertEqual(len(text["comments"]), 4)
            self.assertTrue(any("fallback.jpg" in url for url in fetched))
            self.assertTrue((output / "text.json").is_file())
            self.assertTrue((output / "media-manifest.json").is_file())
            serialized = json.dumps(text, ensure_ascii=False)
            self.assertNotIn("private-id", serialized)
            self.assertNotIn("private-location", serialized)
            self.assertEqual(text["media_manifest"], "media-manifest.json")

    def test_knowledge_and_simulation_keep_citations(self):
        capture = {
            "schema_version": "clue.xiaohongshu.post-text.v1",
            "source": {"canonical_url": "https://example.test/note", "note_id": "n1"},
            "note": {
                "title": "0—1 之后如何融资？",
                "text": "先验证数据和收入，再比较股权稀释与贷款利息。",
            },
            "comments": [
                {"id": "c1", "depth": 0, "text": "PPT创业不能替代尽调，创始人不应承担无限连带责任。"},
                {"id": "r1", "depth": 1, "text": "如果项目抢的人多，条款可能更好。"},
            ],
            "coverage": {"captured_total_comments": 2},
        }
        knowledge = build_knowledge(capture)
        self.assertGreaterEqual(knowledge["coverage"]["evidence_unit_count"], 4)
        self.assertIn("milestone_before_capital", knowledge["active_rule_ids"])
        self.assertTrue(knowledge["claims"][0]["evidence_ids"])
        comparison = compare_strategies(knowledge, seed=11, months=12)
        self.assertEqual(comparison["schema_version"], "clue.startup-investor.simulation.v1")
        self.assertEqual(set(comparison["strategy_results"]), {
            "milestone_then_equity",
            "equity_early",
            "debt_after_revenue",
        })
        for scenario in comparison["strategy_results"].values():
            outcome = scenario["outcome"]
            self.assertGreaterEqual(outcome["founder_ownership"], 0.0)
            self.assertLessEqual(outcome["founder_ownership"], 1.0)
            self.assertNotIn("personal_guarantee", scenario["config"])

    def test_one_failed_reply_thread_returns_a_partial_written_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = capture_post(
                shared_url="https://xhslink.cn/o/synthetic",
                output_dir=output,
                client=BrokenReplyClient(),
                fetcher=lambda *_: (b"image", "image/png"),
                retries=1,
                sleep=lambda _: None,
            )
            self.assertEqual(result["report"]["status"], "partial")
            self.assertTrue((output / "text.json").is_file())
            self.assertTrue(any("reply capture failed" in item for item in result["text"]["capture_errors"]))
            repaired = repair_incomplete_replies(
                output_dir=output,
                client=FakeClient(),
                fetcher=lambda *_: (b"image", "image/png"),
                retries=1,
                sleep=lambda _: None,
            )
            self.assertEqual(repaired["report"]["status"], "succeeded")
            self.assertEqual(repaired["text"]["coverage"]["captured_total_comments"], 4)


if __name__ == "__main__":
    unittest.main()
