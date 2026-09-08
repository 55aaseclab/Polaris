"""Synthetic checks for customer-configured preprocessing rules."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import customer_leads as runner  # noqa: E402


class GenericPreprocessTests(unittest.TestCase):
    def test_preprocess_and_matching_are_customer_configured(self) -> None:
        input_document = {
            "collection_id": "example-export-v1",
            "markets": [
                {
                    "country_code": "US",
                    "country_name": "United States",
                    "country_aliases": ["USA"],
                    "currency": "USD",
                },
                {
                    "country_code": "CA",
                    "country_name": "Canada",
                    "country_aliases": ["Canada"],
                    "currency": "CAD",
                },
            ],
            "product_portfolio": [
                {
                    "category_id": "sample-goods",
                    "match_keywords": ["retail"],
                }
            ],
            "target_buyer_types": [
                {
                    "buyer_type_id": "example_retailer",
                    "priority": 1,
                    "product_category_ids": ["sample-goods"],
                    "match_keywords": ["retail"],
                }
            ],
            "matching_rules": {
                "large_chain_domains": ["chain.example"],
                "non_business_title_keywords": ["ranking"],
            },
            "filters": {
                "exclude_large_chains_for_first_round": True,
            },
            "sources": [
                {
                    "source_type": "web_search",
                    "tasks": [
                        {
                            "task_id": "example-retail-search",
                            "market": "US",
                            "city": "Example City",
                            "buyer_type_ids": ["example_retailer"],
                        }
                    ],
                }
            ],
        }
        source_document = {
            "schema_version": "clue.data-collection.web-search-results.v1",
            "collection_id": "example-export-v1",
            "task_results": [
                {
                    "task_id": "example-retail-search",
                    "status": "succeeded",
                    "market": "US",
                    "city": "Example City",
                    "buyer_type_ids": ["example_retailer"],
                    "results": [
                        {
                            "title": "Example Retail Buyer",
                            "url": "https://buyer.example/",
                            "engines": ["example-search"],
                        }
                    ],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            input_path = temporary_root / "input.json"
            source_path = temporary_root / "web-search.json"
            output_path = temporary_root / "preprocess-run"
            input_path.write_text(
                json.dumps(input_document), encoding="utf-8"
            )
            source_path.write_text(
                json.dumps(source_document), encoding="utf-8"
            )
            args = argparse.Namespace(
                input=str(input_path),
                output=str(output_path),
                source_output=[f"web_search={source_path}"],
            )

            self.assertEqual(runner.preprocess(args, TOOL_ROOT, "test"), 0)
            result = json.loads(
                (output_path / "preprocessed-candidates.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(result["schema_version"], "clue-augmentation.preprocess.v1")
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["candidates"][0]["company_name"], "Example Retail Buyer")
        self.assertTrue(
            runner.candidate_is_in_target_market(
                {"country": "United States"}, input_document, ""
            )
        )
        self.assertEqual(
            runner.matched_target_market(
                {"target_markets": ["CA"]}, input_document, ""
            )["country_code"],
            "CA",
        )
        self.assertEqual(runner.target_country_codes(input_document), ["US", "CA"])
        self.assertEqual(
            runner.target_country_codes(
                {"market": {"country_code": "US", "country_name": "United States"}}
            ),
            ["US"],
        )
        self.assertEqual(
            runner.classify_buyer_type(
                "Retail products", [], input_document
            )[0],
            "example_retailer",
        )
        self.assertEqual(
            runner.product_fit_keyword_hits(
                "Retail products", input_document, ["sample-goods"]
            ),
            ["retail"],
        )
        self.assertEqual(
            runner.hard_filter_rejection(
                {"company_name": "Example Chain", "source_types": ["web_search"]},
                "https://chain.example/",
                [],
                input_document,
            ),
            "large_chain_first_round",
        )
        self.assertEqual(
            runner.hard_filter_rejection(
                {
                    "company_name": "Example ranking page",
                    "source_types": ["web_search"],
                },
                "https://results.example/",
                [],
                input_document,
            ),
            "not_target_buyer_type",
        )

    def test_qualified_record_uses_its_matched_market(self) -> None:
        input_document = {
            "collection_id": "example-export-v1",
            "markets": [
                {"country_code": "US", "country_name": "United States"},
                {
                    "country_code": "CA",
                    "country_name": "Canada",
                    "currency": "CAD",
                },
            ],
            "product_portfolio": [
                {
                    "category_id": "sample-goods",
                    "match_keywords": ["retail"],
                }
            ],
            "target_buyer_types": [
                {
                    "buyer_type_id": "example_retailer",
                    "priority": 1,
                    "product_category_ids": ["sample-goods"],
                    "match_keywords": ["retail"],
                }
            ],
            "offer_context": {
                "price_bands": [
                    {
                        "range": "10-20",
                        "product_category_ids": ["sample-goods"],
                    }
                ]
            },
            "sources": [],
        }
        candidate = {
            "candidate_id": "candidate_example",
            "company_name": "Example Buyer",
            "website_candidate_url": "https://buyer.example/",
            "country": "Canada",
            "city": "Example City",
            "social_links": [],
            "source_types": ["google_maps"],
            "source_traces": [
                {
                    "source_type": "google_maps",
                    "source_url": "https://maps.example/item",
                }
            ],
        }
        pages = [
            {
                "title": "Example Buyer",
                "final_url": "https://buyer.example/",
                "language": "en",
                "emails": ["info@buyer.example"],
                "phones": [],
                "social_links": [],
                "contact_page": False,
                "text": "Example Buyer retail business in Canada",
            }
        ]
        args = argparse.Namespace()

        with patch.object(runner, "fetch_candidate_pages", return_value=(pages, [])):
            _, record, rejection = runner.augment_one_candidate(
                candidate,
                input_document,
                {},
                args,
                "2026-07-12T00:00:00Z",
            )

        self.assertIsNone(rejection)
        self.assertIsNotNone(record)
        self.assertEqual(record["country"], "CA")
        self.assertLess(
            record["qualification"]["score_breakdown"]["channel_fit"], 35
        )
        self.assertEqual(
            record["commercial_fit"]["recommended_offer"][0]["currency"],
            "CAD",
        )

    def test_rejected_score_is_retained_in_evidence(self) -> None:
        input_document = {
            "collection_id": "example-export-v1",
            "markets": [{"country_code": "US", "country_name": "United States"}],
            "product_portfolio": [
                {"category_id": "sample-goods", "match_keywords": ["retail"]}
            ],
            "target_buyer_types": [
                {
                    "buyer_type_id": "example_retailer",
                    "priority": 1,
                    "product_category_ids": ["sample-goods"],
                    "match_keywords": ["retail"],
                }
            ],
            "filters": {"minimum_qualification_score": 80},
        }
        candidate = {
            "candidate_id": "candidate_example",
            "company_name": "Example Buyer",
            "website_candidate_url": "https://buyer.example/",
            "country": "United States",
            "city": "Example City",
            "social_links": [],
            "source_types": ["web_search"],
            "source_traces": [
                {
                    "source_type": "web_search",
                    "source_url": "https://search.example/result",
                }
            ],
        }
        pages = [
            {
                "title": "Example Buyer",
                "final_url": "https://buyer.example/",
                "language": "en",
                "emails": ["info@buyer.example"],
                "phones": [],
                "social_links": [],
                "contact_page": False,
                "text": "Example Buyer retail business in the United States",
            }
        ]

        with patch.object(runner, "fetch_candidate_pages", return_value=(pages, [])):
            evidence, record, rejection = runner.augment_one_candidate(
                candidate,
                input_document,
                {},
                argparse.Namespace(),
                "2026-07-12T00:00:00Z",
            )

        self.assertIsNone(record)
        self.assertEqual(
            rejection["rejection_reasons"], ["qualification_score_below_threshold"]
        )
        self.assertIsInstance(evidence["qualification_score"], int)
        self.assertLess(evidence["qualification_score"], 80)

    def test_malformed_url_port_is_discarded(self) -> None:
        self.assertIsNone(runner.normalize_url("https://buyer.example:blank/contact"))


if __name__ == "__main__":
    unittest.main()
