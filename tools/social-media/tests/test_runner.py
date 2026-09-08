"""Unit tests for JustOneAPI social-media route adapters (no live API)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402


def load_routes() -> dict:
    return json.loads((ROOT / "config" / "platform-routes.json").read_text(encoding="utf-8"))


class XiaohongshuRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.routes = load_routes()
        self.xhs = self.routes["platforms"]["xiaohongshu"]
        self.ig = self.routes["platforms"]["instagram"]

    def test_xiaohongshu_route_is_enabled_content_adapter(self):
        self.assertTrue(self.xhs["enabled"])
        self.assertEqual(self.xhs["resource"], "xiaohongshu")
        self.assertEqual(self.xhs["method"], "search_note_v4")
        self.assertEqual(self.xhs["candidate_adapter"], "content_note")
        self.assertEqual(self.xhs["pagination_style"], "page")
        self.assertEqual(self.xhs["query_parameter"], "keyword")

    def test_page_request_parameters_include_static_and_session(self):
        params = runner.request_parameters_for_route(
            self.xhs,
            "护肤 种草",
            "",
            {"search_id": "sid-1", "session_id": "sess-9"},
        )
        self.assertEqual(params["keyword"], "护肤 种草")
        self.assertEqual(params["page"], 1)
        self.assertEqual(params["sort_type"], "general")
        self.assertEqual(params["note_type"], "ALL")
        self.assertEqual(params["search_id"], "sid-1")
        self.assertEqual(params["session_id"], "sess-9")

        page2 = runner.request_parameters_for_route(self.xhs, "护肤 种草", "2", None)
        self.assertEqual(page2["page"], 2)

    def test_instagram_cursor_parameters_unchanged(self):
        first = runner.request_parameters_for_route(self.ig, "beauty", "", None)
        self.assertEqual(first, {"hashtag": "beauty"})
        nxt = runner.request_parameters_for_route(self.ig, "beauty", "CURSOR", None)
        self.assertEqual(nxt["end_cursor"], "CURSOR")

    def test_next_pagination_token_page_style(self):
        self.assertEqual(
            runner.next_pagination_token({"items": [1]}, self.xhs, "", 3),
            "2",
        )
        self.assertEqual(
            runner.next_pagination_token({}, self.xhs, "2", 0),
            "",
        )
        self.assertEqual(
            runner.next_pagination_token({}, self.xhs, "2", 5),
            "3",
        )

    def test_find_xhs_notes_from_search_payload(self):
        data = {
            "items": [
                {
                    "model_type": "note",
                    "id": "note-aaa",
                    "note_card": {
                        "display_title": "夏日护肤分享",
                        "type": "normal",
                        "user": {
                            "nickname": "美妆小店",
                            "user_id": "user-111",
                        },
                        "interact_info": {
                            "liked_count": 12,
                            "collected_count": 3,
                            "comment_count": 1,
                        },
                    },
                },
                {
                    "model_type": "user",
                    "id": "user-only",
                    "user": {"nickname": "not a note"},
                },
            ],
            "api_info": {"search_id": "S1", "session_id": "T1"},
        }
        records = runner.find_post_records(data, self.xhs)
        self.assertGreaterEqual(len(records), 1)
        task_state = {
            "platform": "xiaohongshu",
            "task_id": "t1",
            "query": "护肤",
            "normalized_query": "护肤",
            "market": None,
            "city": None,
            "buyer_type_ids": [],
        }
        candidate, exclusion = runner.build_candidate(
            records[0], task_state, self.xhs, "2026-01-01T00:00:00Z"
        )
        self.assertIsNone(exclusion)
        assert candidate is not None
        self.assertEqual(candidate["platform"], "xiaohongshu")
        self.assertIn("explore/note-aaa", candidate["post_url"])
        self.assertEqual(candidate["content"]["note_id"], "note-aaa")
        self.assertEqual(candidate["content"]["title"], "夏日护肤分享")
        self.assertEqual(candidate["account_handle"], "美妆小店")
        self.assertEqual(candidate["content"]["engagement"]["likes"], 12)
        self.assertEqual(
            runner.extract_pagination_session(data, self.xhs),
            {"search_id": "S1", "session_id": "T1"},
        )

    def test_content_notes_merge_by_post_not_account(self):
        task_state = {
            "platform": "xiaohongshu",
            "task_id": "t1",
            "candidates": [
                {
                    "platform": "xiaohongshu",
                    "account_handle": "same_author",
                    "post_url": "https://www.xiaohongshu.com/explore/n1",
                    "content": {"note_id": "n1"},
                    "buyer_type_ids": [],
                    "public_business_evidence": [],
                    "source_trace": {"task_id": "t1"},
                },
                {
                    "platform": "xiaohongshu",
                    "account_handle": "same_author",
                    "post_url": "https://www.xiaohongshu.com/explore/n2",
                    "content": {"note_id": "n2"},
                    "buyer_type_ids": [],
                    "public_business_evidence": [],
                    "source_trace": {"task_id": "t1"},
                },
            ],
        }
        merged = runner.merge_candidates(
            [task_state], {"xiaohongshu": self.xhs}
        )
        self.assertEqual(len(merged), 2)

    def test_normalize_query_strip_for_xhs(self):
        self.assertEqual(
            runner.normalize_query("  口红试色  ", self.xhs),
            "口红试色",
        )
        self.assertEqual(
            runner.normalize_query("#beauty", self.ig),
            "beauty",
        )

    def test_candidate_policy_for_content_route(self):
        policy = runner.candidate_policy_from_routes([self.xhs])
        self.assertFalse(policy["retain_only_explicit_business_accounts"])
        self.assertTrue(policy["retain_public_notes"])
        self.assertIn("content_note", policy["candidate_adapters"])


class InstagramRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ig = load_routes()["platforms"]["instagram"]

    def test_business_candidate_still_requires_evidence(self):
        record = {
            "code": "AbC123",
            "caption": "hello shop",
            "user": {
                "username": "demo_shop",
                "is_business_account": True,
                "external_url": "https://example.test",
                "biography": "gift shop boutique",
            },
        }
        task_state = {
            "platform": "instagram",
            "task_id": "ig1",
            "query": "#shop",
            "normalized_query": "shop",
            "buyer_type_ids": [],
        }
        candidate, exclusion = runner.build_candidate(
            record, task_state, self.ig, "2026-01-01T00:00:00Z"
        )
        self.assertIsNone(exclusion)
        assert candidate is not None
        self.assertTrue(candidate["public_business_evidence"])
        self.assertNotIn("content", candidate)


class TaskCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.routes = load_routes()
        self.xhs = self.routes["platforms"]["xiaohongshu"]
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.tmp.name)
        self.env = mock.patch.dict(
            os.environ, {"SOCIAL_MEDIA_CACHE": str(self.cache_root)}, clear=False
        )
        self.env.start()
        runner.reset_cache_stats()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def _task_state(self, task_id: str = "t-cache") -> dict:
        return {
            "schema_version": "clue-justoneapi-cli.task.v1",
            "task_id": task_id,
            "platform": "xiaohongshu",
            "query": "珀莱雅 红宝石 精华 种草",
            "normalized_query": "珀莱雅 红宝石 精华 种草",
            "status": "succeeded",
            "pages_completed": 1,
            "records_seen": 2,
            "excluded_record_counts": {},
            "next_cursor": "",
            "pagination_session": {},
            "pagination_truncated": False,
            "candidate_count": 1,
            "candidates": [
                {
                    "platform": "xiaohongshu",
                    "account_handle": "demo",
                    "post_url": "https://www.xiaohongshu.com/explore/n-cache-1",
                    "content": {"note_id": "n-cache-1", "title": "cached note"},
                    "public_business_evidence": [],
                    "source_trace": {
                        "task_id": "original-task",
                        "query": "old",
                        "normalized_query": "old",
                    },
                }
            ],
            "attempts": [],
            "last_error": None,
        }

    def test_cache_key_stable_and_ignores_max_pages(self):
        key_a = runner.task_cache_key(
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query="护肤 种草",
        )
        key_b = runner.task_cache_key(
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query="护肤 种草",
        )
        key_c = runner.task_cache_key(
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query="不同查询",
        )
        self.assertEqual(key_a, key_b)
        self.assertNotEqual(key_a, key_c)
        self.assertEqual(len(key_a), 64)

    def test_put_get_full_hit_and_rebind_task_id(self):
        state = self._task_state("writer")
        key = runner.cache_put_task(
            tool_root=ROOT,
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query=state["normalized_query"],
            max_pages=1,
            task_state=state,
        )
        self.assertIsNotNone(key)
        self.assertEqual(runner.cache_stats()["puts"], 1)

        entry = runner.cache_get_task(
            tool_root=ROOT,
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query=state["normalized_query"],
            max_pages=1,
        )
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(runner.cache_stats()["hits"], 1)

        fresh = runner.task_template(
            {
                "task_id": "reader-task",
                "platform": "xiaohongshu",
                "query": state["query"],
            },
            self.xhs,
            state["normalized_query"],
        )
        hit = runner.apply_task_cache_hit(fresh, entry, max_pages=1)
        self.assertEqual(hit["status"], "succeeded")
        self.assertEqual(hit["candidate_count"], 1)
        self.assertEqual(hit["candidates"][0]["source_trace"]["task_id"], "reader-task")
        self.assertEqual(hit["attempts"][-1]["status"], "cache_hit")
        self.assertTrue(hit["cache"]["hit"])

    def test_execute_task_uses_cache_without_provider(self):
        state = self._task_state("seed")
        runner.cache_put_task(
            tool_root=ROOT,
            platform="xiaohongshu",
            route=self.xhs,
            normalized_query=state["normalized_query"],
            max_pages=1,
            task_state=state,
        )
        runner.reset_cache_stats()
        fresh = runner.task_template(
            {
                "task_id": "from-cache",
                "platform": "xiaohongshu",
                "query": state["query"],
            },
            self.xhs,
            state["normalized_query"],
        )
        with tempfile.TemporaryDirectory() as run_dir:
            commands = Path(run_dir) / "commands.jsonl"
            result = runner.execute_task(
                client=object(),  # must not be called
                task_state=fresh,
                route=self.xhs,
                max_pages=1,
                commands_path=commands,
                token="unused-token",
                tool_root=ROOT,
                use_cache=True,
                refresh_cache=False,
            )
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["candidate_count"], 1)
            self.assertEqual(result["attempts"][-1]["status"], "cache_hit")
            self.assertEqual(runner.cache_stats()["hits"], 1)
            self.assertTrue(commands.is_file())
            line = commands.read_text(encoding="utf-8").strip()
            self.assertIn("cache_hit", line)

    def test_no_cache_env_disables(self):
        with mock.patch.dict(os.environ, {"SOCIAL_MEDIA_CACHE": "0"}, clear=False):
            self.assertFalse(runner.cache_enabled())
            state = self._task_state()
            key = runner.cache_put_task(
                tool_root=ROOT,
                platform="xiaohongshu",
                route=self.xhs,
                normalized_query=state["normalized_query"],
                max_pages=1,
                task_state=state,
            )
            self.assertIsNone(key)


if __name__ == "__main__":
    unittest.main()
