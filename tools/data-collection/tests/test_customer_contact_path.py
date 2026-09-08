"""Synthetic checks for configurable public contact-page discovery."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import website  # noqa: E402


class ContactPathMatchingTests(unittest.TestCase):
    def page_with_links(self, *links: str) -> website.FetchedPage:
        return website.FetchedPage(
            requested_url="https://buyer.example/",
            final_url="https://buyer.example/",
            status_code=200,
            content_type="text/html",
            title="Example Buyer",
            language="en",
            visible_text="",
            links=links,
            email_candidates=(),
        )

    def test_default_terms_cover_multiple_languages(self) -> None:
        page = self.page_with_links(
            "https://buyer.example/contacto",
            "https://buyer.example/products",
        )

        self.assertEqual(
            list(website.contact_like_links(page, 2)),
            ["https://buyer.example/contacto"],
        )

    def test_customer_can_add_a_path_term(self) -> None:
        page = self.page_with_links("https://buyer.example/reach-us")

        self.assertEqual(
            list(website.contact_like_links(page, 1, ["reach-us"])),
            ["https://buyer.example/reach-us"],
        )


if __name__ == "__main__":
    unittest.main()
