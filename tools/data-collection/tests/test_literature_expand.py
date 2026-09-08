"""Contract tests for Crossref + Semantic Scholar dual expansion."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import literature.expand as literature_expand  # noqa: E402
from literature.scope import default_bounds  # noqa: E402


class LiteratureExpandDualSourceTests(unittest.TestCase):
    def test_expands_from_doi_with_s2_and_crossref(self) -> None:
        collection = {
            "schema_version": "clue.data-collection.output.v2",
            "collection_id": "example",
            "collection_kind": "literature",
            "status": "candidate_set",
            "records": [
                {
                    "record_id": "doi:10.1145/3808103",
                    "record_kind": "literature-candidate",
                    "source_url": "https://doi.org/10.1145/3808103",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": "sha256:seed",
                    "evidence": [{"quote": "Seed."}],
                    "payload": {
                        "title": "AgentBound: Securing Execution Boundaries of AI Agents",
                        "DOI": "10.1145/3808103",
                        "year": 2025,
                        "source_tool": "crossref",
                    },
                }
            ],
        }

        s2_citing = [
            {
                "paperId": "cite1",
                "title": "Citing AI agent permission isolation paper",
                "year": 2025,
                "venue": "IEEE S&P",
                "abstract": "We study LLM agent permission isolation and access control.",
                "externalIds": {"DOI": "10.1109/example.cite"},
                "authors": [{"name": "A Author"}],
            }
        ]
        s2_refs = [
            {
                "paperId": "ref1",
                "title": "Referenced agent sandbox survey",
                "year": 2024,
                "venue": "CCS",
                "abstract": "Survey of AI agents and execution isolation sandboxes.",
                "externalIds": {"DOI": "10.1145/example.ref"},
                "authors": [{"name": "B Author"}],
            }
        ]
        crossref_seed = {
            "DOI": "10.1145/3808103",
            "title": ["AgentBound: Securing Execution Boundaries of AI Agents"],
            "reference": [{"DOI": "10.1145/example.ref"}, {"DOI": "10.1007/example.other"}],
        }
        crossref_ref = {
            "DOI": "10.1007/example.other",
            "title": ["Other agent security governance work"],
            "abstract": "<jats:p>Agentic system security architecture and governance.</jats:p>",
            "published-print": {"date-parts": [[2023]]},
            "container-title": ["Some Journal"],
        }

        def fake_crossref(doi: str):
            d = doi.lower()
            if "3808103" in d:
                return crossref_seed
            if "example.other" in d:
                return crossref_ref
            if "example.ref" in d:
                return {
                    "DOI": "10.1145/example.ref",
                    "title": ["Referenced survey"],
                    "published-print": {"date-parts": [[2024]]},
                }
            return None

        def fake_eval(record, *, bounds, catalog, topic_keywords=None):
            return {
                "in_bounds": True,
                "year": 2025,
                "venue": {"abbr": "S&P"},
                "reasons": [],
                "topic": {"matched": list(topic_keywords or [])},
            }

        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            stream = io.StringIO()
            with (
                patch.object(
                    literature_expand,
                    "fetch_s2_graph",
                    lambda *a, **k: (s2_citing, s2_refs),
                ),
                patch.object(literature_expand, "fetch_crossref_work", fake_crossref),
                patch.object(literature_expand, "fetch_s2_paper", lambda *a, **k: None),
                patch.object(literature_expand, "evaluate_record", fake_eval),
                patch.object(literature_expand.time, "sleep", lambda *_: None),
                redirect_stderr(stream),
            ):
                output = literature_expand.expand_collection(
                    collection,
                    work_dir=work_dir,
                    bounds=default_bounds(),
                    catalog=object(),
                    checkpoint_every=1,
                    max_rounds=1,
                    sleep_s=0,
                    topic_keywords=["AI agents", "permission control"],
                )
            # seed + citing + s2 ref + crossref other ref (s2 ref and crossref ref share DOI → merge)
            self.assertGreaterEqual(len(output["records"]), 3)
            ids = {r["record_id"] for r in output["records"]}
            self.assertIn("doi:10.1145/3808103", ids)
            self.assertIn("doi:10.1109/example.cite", ids)
            self.assertTrue((work_dir / "progress.json").is_file())
            self.assertTrue((work_dir / "literature-graph.dot").is_file())
            self.assertIn("expand_done", stream.getvalue())
            stats = output["literature_expansion"]["stats"]
            self.assertEqual(stats["source"], "crossref+semantic-scholar")

    def test_resume_trusts_empty_frontier_from_state(self) -> None:
        """Finished expand (frontier=[]) must not reopen all corpus DOIs."""
        collection = {
            "schema_version": "clue.data-collection.output.v2",
            "collection_id": "example",
            "collection_kind": "literature",
            "status": "candidate_set",
            "records": [
                {
                    "record_id": f"doi:10.1145/seed{i}",
                    "record_kind": "literature-candidate",
                    "source_url": f"https://doi.org/10.1145/seed{i}",
                    "observed_at": "2026-01-01T00:00:00Z",
                    "content_hash": f"sha256:seed{i}",
                    "evidence": [{"quote": "Seed."}],
                    "payload": {
                        "title": f"Seed paper {i} on AI agent isolation",
                        "DOI": f"10.1145/seed{i}",
                        "year": 2025,
                        "source_tool": "crossref",
                    },
                }
                for i in range(3)
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            # Pretend expand already finished: all seeds seen, empty frontier.
            literature_expand._atomic_write_json(
                work_dir / "expand-state.json",
                {
                    "ts": "2026-01-01T00:00:00Z",
                    "round": 2,
                    "seen": ["10.1145/seed0", "10.1145/seed1", "10.1145/seed2"],
                    "frontier": [],
                    "stats": {"accepted": 3, "rounds": 2},
                },
            )
            literature_expand._atomic_write_json(
                work_dir / "expanded-collection.checkpoint.json",
                {**collection, "literature_expansion": {"stats": {"accepted": 3}}},
            )
            fetch_calls: list[str] = []

            def boom_fetch(doi: str):
                fetch_calls.append(doi)
                raise AssertionError(f"should not fetch on finished expand: {doi}")

            stream = io.StringIO()
            with (
                patch.object(literature_expand, "fetch_s2_graph", lambda *a, **k: ([], [])),
                patch.object(literature_expand, "fetch_crossref_work", boom_fetch),
                patch.object(literature_expand, "fetch_s2_paper", lambda *a, **k: None),
                patch.object(literature_expand.time, "sleep", lambda *_: None),
                redirect_stderr(stream),
            ):
                output = literature_expand.expand_collection(
                    collection,
                    work_dir=work_dir,
                    bounds=default_bounds(),
                    catalog=object(),
                    max_rounds=5,
                    sleep_s=0,
                    use_semantic_scholar=False,
                )
            self.assertEqual(len(output["records"]), 3)
            self.assertEqual(fetch_calls, [])
            self.assertIn("expand_resume_state", stream.getvalue())
            self.assertIn("expand_done", stream.getvalue())

    def test_normalize_doi_rejects_garbage(self) -> None:
        self.assertIsNone(literature_expand.normalize_doi("10.1016/j"))
        self.assertEqual(literature_expand.normalize_doi("https://doi.org/10.1145/3808103"), "10.1145/3808103")

    def test_crossref_strips_jats_abstract(self) -> None:
        rec = literature_expand.crossref_work_to_record(
            {
                "DOI": "10.1145/example",
                "title": ["AgentBound: Securing Execution Boundaries of AI Agents"],
                "abstract": "<jats:p>LLM agents and MCP permission isolation.</jats:p>",
            },
            observed_at="2026-01-01T00:00:00Z",
            source_role="reference",
        )
        assert rec is not None
        self.assertEqual(
            rec["payload"]["abstract"],
            "LLM agents and MCP permission isolation.",
        )
        self.assertIn("abstract", rec["evidence"][0]["locator"])

    def test_topic_keywords_reject_off_rq_paper(self) -> None:
        from literature.scope import VenueCatalog, evaluate_record, match_topic_keywords

        catalog = VenueCatalog.load()
        off_topic = {
            "record_id": "doi:10.1/x",
            "payload": {
                "title": "A graph neural network for image classification",
                "abstract": "We train CNNs on ImageNet benchmarks.",
                "year": 2024,
                "container-title": ["CCS"],
                "short-container-title": ["CCS"],
            },
        }
        on_topic = {
            "record_id": "doi:10.1/y",
            "payload": {
                "title": "Permission control for LLM agents",
                "abstract": "We isolate agent tool calls with sandbox policies.",
                "year": 2024,
                "container-title": ["CCS"],
                "short-container-title": ["CCS"],
            },
        }
        keywords = ["AI agents", "LLM agents", "permission control"]
        self.assertEqual(match_topic_keywords(off_topic, keywords)["matched"], [])
        self.assertIn(
            "permission control", match_topic_keywords(on_topic, keywords)["matched"]
        )
        decision = evaluate_record(
            on_topic,
            bounds=default_bounds(),
            catalog=catalog,
            topic_keywords=keywords,
        )
        self.assertTrue(decision["in_bounds"], decision)
        decision_off = evaluate_record(
            off_topic,
            bounds=default_bounds(),
            catalog=catalog,
            topic_keywords=keywords,
        )
        self.assertFalse(decision_off["in_bounds"])
        self.assertIn("topic_keyword_miss", decision_off["reasons"])

    def test_allow_arxiv_corr_false_excludes_preprint_unit(self) -> None:
        """arxiv + CoRR are one unit; allow_arxiv_corr=false drops them at DC."""
        from literature.scope import (
            LiteratureBounds,
            VenueCatalog,
            evaluate_record,
            is_arxiv_corr_record,
        )

        catalog = VenueCatalog.load()
        bounds = LiteratureBounds.last_n_years(5, allow_arxiv_corr=False)
        pure_arxiv = {
            "record_id": "arxiv:2401.00001",
            "source_url": "https://arxiv.org/abs/2401.00001",
            "payload": {
                "title": "Agent sandbox preprint",
                "abstract": "LLM agent permission isolation on arXiv only.",
                "year": 2024,
                "container-title": ["arXiv.org"],
                "DOI": "10.48550/arXiv.2401.00001",
            },
        }
        pure_corr = {
            "record_id": "s2:corr-1",
            "source_url": "https://example.test/corr",
            "payload": {
                "title": "Agent harness note",
                "abstract": "Runtime isolation for LLM agents.",
                "year": 2024,
                "container-title": ["CoRR"],
            },
        }
        # Peer venue + arXiv host still matches CCF (ICML/CCS-style) when catalog hits.
        ccs_peer = {
            "record_id": "doi:10.1145/example",
            "source_url": "https://doi.org/10.1145/example",
            "payload": {
                "title": "Permission control for LLM agents",
                "abstract": "We isolate agent tool calls with sandbox policies.",
                "year": 2024,
                "container-title": ["CCS"],
                "short-container-title": ["CCS"],
                "DOI": "10.1145/example",
            },
        }
        # Abstract may mention arXiv without being a preprint.
        cites_arxiv = {
            "record_id": "doi:10.1145/other",
            "source_url": "https://doi.org/10.1145/other",
            "payload": {
                "title": "Permission control for LLM agents",
                "abstract": "Prior work on arXiv.org is incomplete; we use CCS evaluation.",
                "year": 2024,
                "container-title": ["CCS"],
                "short-container-title": ["CCS"],
                "DOI": "10.1145/other",
            },
        }
        self.assertTrue(is_arxiv_corr_record(pure_arxiv))
        self.assertTrue(is_arxiv_corr_record(pure_corr))
        self.assertFalse(is_arxiv_corr_record(ccs_peer))
        self.assertFalse(is_arxiv_corr_record(cites_arxiv))

        rejected = evaluate_record(pure_arxiv, bounds=bounds, catalog=catalog)
        self.assertFalse(rejected["in_bounds"], rejected)
        self.assertIn("arxiv_corr_excluded", rejected["reasons"])

        rejected_corr = evaluate_record(pure_corr, bounds=bounds, catalog=catalog)
        self.assertFalse(rejected_corr["in_bounds"], rejected_corr)
        self.assertIn("arxiv_corr_excluded", rejected_corr["reasons"])

        kept = evaluate_record(ccs_peer, bounds=bounds, catalog=catalog)
        self.assertTrue(kept["in_bounds"], kept)

        kept_cite = evaluate_record(cites_arxiv, bounds=bounds, catalog=catalog)
        self.assertTrue(kept_cite["in_bounds"], kept_cite)
        self.assertFalse(kept_cite["arxiv_corr"])

    def test_dblp_external_id_recovers_peer_venue_on_arxiv_doi(self) -> None:
        """S2 often keeps conf/emnlp/… on 10.48550 records — treat as peer venue."""
        from literature.scope import (
            LiteratureBounds,
            VenueCatalog,
            dblp_keys_from_record,
            evaluate_record,
            parse_arxiv_publication_hints,
        )

        catalog = VenueCatalog.load()
        bounds = LiteratureBounds.last_n_years(5, allow_arxiv_corr=False)
        dual = {
            "record_id": "doi:10.48550/arXiv.2505.14590",
            "source_url": "https://doi.org/10.48550/arXiv.2505.14590",
            "payload": {
                "title": "MCIP: Protecting MCP Safety",
                "abstract": "LLM agent tool safety.",
                "year": 2025,
                "container-title": "Conference on Empirical Methods in Natural Language Processing",
                "DOI": "10.48550/arXiv.2505.14590",
                "externalIds": {
                    "ArXiv": "2505.14590",
                    "DBLP": "conf/emnlp/JingLHHXCHS25",
                    "DOI": "10.48550/arXiv.2505.14590",
                },
            },
        }
        self.assertEqual(dblp_keys_from_record(dual), ["conf/emnlp"])
        decision = evaluate_record(dual, bounds=bounds, catalog=catalog)
        self.assertTrue(decision["in_bounds"], decision)
        self.assertEqual((decision.get("venue") or {}).get("abbr"), "EMNLP")
        self.assertTrue(decision["arxiv_corr"])  # still hosted as arXiv DOI

        hints = parse_arxiv_publication_hints(comment="Accepted to ICML 2025")
        self.assertTrue(any("ICML" in h for h in hints))
        bare = parse_arxiv_publication_hints(comment="ICML 2025")
        self.assertTrue(any("ICML" in h for h in bare))


if __name__ == "__main__":
    unittest.main()
