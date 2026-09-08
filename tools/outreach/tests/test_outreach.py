"""Unit tests for clue-outreach state machine and strategy."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import email_channel  # noqa: E402
import runner  # noqa: E402
import state  # noqa: E402
import strategy  # noqa: E402


def sample_ready_record(
    *,
    company: str = "Example Buyer GmbH",
    record_id: str = "lead-001",
    group: str = "example-buyer",
    emails: list[str] | None = None,
    linkedin: bool = True,
) -> dict:
    methods = []
    for email in emails if emails is not None else ["info@buyer.example"]:
        methods.append(
            {
                "channel": "email",
                "value": email,
                "contact_role": "general",
                "is_public_business_contact": True,
                "source_url": "https://buyer.example/contact",
            }
        )
    if linkedin:
        methods.append(
            {
                "channel": "linkedin_message",
                "value": "https://www.linkedin.com/company/example-buyer",
                "contact_role": "unknown",
                "is_public_business_contact": True,
                "source_url": "https://www.linkedin.com/company/example-buyer",
            }
        )
    return {
        "record_id": record_id,
        "company_name": company,
        "language": "en",
        "country": "CH",
        "city": "Zurich",
        "website_candidate_url": "https://buyer.example",
        "deduplication": {"duplicate_group_id": group},
        "contact_methods": methods,
        "classification": {"buyer_type": "gift_shop"},
    }


class OutreachStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws_root = self.root / "workspaces"
        self.ws_root.mkdir()
        self.workspace = "demo-ws"
        collection = (
            self.ws_root
            / self.workspace
            / "acquisition"
            / "customer-data-collection"
        )
        (collection / "outputs").mkdir(parents=True)
        (collection / "work").mkdir(parents=True)
        self.output_path = collection / "outputs" / "output.json"
        self.state_path = collection / "work" / "outreach-state.json"
        self.output_path.write_text(
            json.dumps(
                {
                    "schema_version": "clue.data-collection.review-output.v1",
                    "outreach_ready_records": [
                        sample_ready_record(),
                        sample_ready_record(
                            company="Second Shop",
                            record_id="lead-002",
                            group="second-shop",
                            emails=["hello@second.example"],
                            linkedin=False,
                        ),
                    ],
                }
            ),
            encoding="utf-8",
        )
        os.environ["POLARIS_BUSINESS_WORKSPACES_ROOT"] = str(self.ws_root)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        os.environ.pop("POLARIS_BUSINESS_WORKSPACES_ROOT", None)

    def test_import_creates_leads_with_contact_points(self) -> None:
        st = state.empty_state(self.workspace)
        document = json.loads(self.output_path.read_text(encoding="utf-8"))
        result = state.import_ready_records(
            st,
            document,
            self.workspace,
            actor="synthetic-operator",
        )
        self.assertEqual(result["created"], 2)
        lead = st["leads"]["candidate:example-buyer"]
        channels = {p["channel"] for p in lead["contact_points"]}
        self.assertIn("email", channels)
        self.assertIn("linkedin_message", channels)
        self.assertEqual(lead["relationship"], "new")
        self.assertEqual(st["audit"][-1]["actor"], "synthetic-operator")

    def test_import_reads_customer_lead_from_v2_record_payload(self) -> None:
        wrapped = {
            "record_id": "v2-wrapper-001",
            "record_kind": "customer-lead",
            "payload": {"customer_lead": sample_ready_record()},
        }
        st = state.empty_state(self.workspace)
        state.import_ready_records(
            st,
            {"outreach_ready_records": [wrapped]},
            self.workspace,
        )

        lead = st["leads"]["candidate:example-buyer"]
        self.assertEqual(lead["company_name"], "Example Buyer GmbH")
        self.assertTrue(lead["contact_points"])

    def test_import_is_idempotent_and_preserves_suppression(self) -> None:
        st = state.empty_state(self.workspace)
        document = json.loads(self.output_path.read_text(encoding="utf-8"))
        state.import_ready_records(st, document, self.workspace)
        state.suppress_lead(st, "candidate:example-buyer", reason="opt_out")
        result = state.import_ready_records(st, document, self.workspace)
        self.assertEqual(result["created"], 0)
        self.assertEqual(
            st["leads"]["candidate:example-buyer"]["relationship"], "suppressed"
        )
        email_points = [
            p
            for p in st["leads"]["candidate:example-buyer"]["contact_points"]
            if p["channel"] == "email"
        ]
        self.assertTrue(all(p["status"] == "unsubscribed" for p in email_points))

    def test_draft_approve_send_dry_run_and_reply_stops_followups(self) -> None:
        st = state.empty_state(self.workspace)
        document = json.loads(self.output_path.read_text(encoding="utf-8"))
        state.import_ready_records(st, document, self.workspace)
        eng = state.create_draft(st, "candidate:example-buyer", channel="email")
        self.assertEqual(eng["status"], "draft")
        state.approve_engagement(st, eng["engagement_id"], actor="alice")
        state.mark_sent(
            st,
            eng["engagement_id"],
            message_id="msg-1",
            dry_run=True,
            actor="alice",
        )
        lead = st["leads"]["candidate:example-buyer"]
        self.assertEqual(lead["relationship"], "waiting")
        self.assertIsNotNone(lead["next_eligible_at"])

        # Open another draft then reply should cancel it.
        other = state.create_draft(
            st, "candidate:example-buyer", channel="email", intent="follow_up"
        )
        state.mark_replied(st, eng["engagement_id"], actor="system")
        self.assertEqual(lead["relationship"], "engaged")
        refreshed = next(
            e for e in lead["engagements"] if e["engagement_id"] == other["engagement_id"]
        )
        self.assertEqual(refreshed["status"], "cancelled")

    def test_hard_bounce_marks_contact_point(self) -> None:
        st = state.empty_state(self.workspace)
        document = json.loads(self.output_path.read_text(encoding="utf-8"))
        state.import_ready_records(st, document, self.workspace)
        eng = state.create_draft(st, "candidate:example-buyer")
        state.approve_engagement(st, eng["engagement_id"])
        state.mark_sent(st, eng["engagement_id"], dry_run=True)
        state.mark_bounce(st, eng["engagement_id"], hard=True)
        lead = st["leads"]["candidate:example-buyer"]
        email = next(p for p in lead["contact_points"] if p["channel"] == "email")
        self.assertEqual(email["status"], "bounced")

    def test_manual_outcome_can_suppress(self) -> None:
        st = state.empty_state(self.workspace)
        document = json.loads(self.output_path.read_text(encoding="utf-8"))
        state.import_ready_records(st, document, self.workspace)
        state.log_manual_outcome(
            st,
            "candidate:example-buyer",
            channel="linkedin_message",
            outcome="refused",
            actor="bob",
        )
        self.assertEqual(
            st["leads"]["candidate:example-buyer"]["relationship"], "suppressed"
        )


class StrategyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.st = state.empty_state("strategy-ws")
        document = {
            "outreach_ready_records": [
                sample_ready_record(),
                sample_ready_record(
                    company="No Email Co",
                    record_id="lead-ne",
                    group="no-email",
                    emails=[],
                    linkedin=True,
                ),
            ]
        }
        state.import_ready_records(self.st, document, "strategy-ws")

    def test_next_suggests_first_touch_for_new_email_lead(self) -> None:
        tasks = strategy.compute_next_tasks(self.st)
        kinds = {t["kind"] for t in tasks}
        self.assertIn("suggest_first_touch", kinds)
        first = next(t for t in tasks if t["kind"] == "suggest_first_touch")
        self.assertEqual(first["lead_id"], "candidate:example-buyer")
        self.assertEqual(first["channel"], "email")

    def test_tick_materializes_drafts_then_approve_queue(self) -> None:
        result = strategy.tick(self.st)
        self.assertGreaterEqual(result["drafts_created"], 1)
        tasks = strategy.compute_next_tasks(self.st)
        self.assertTrue(any(t["kind"] == "approve_draft" for t in tasks))
        eng_id = next(t["engagement_id"] for t in tasks if t["kind"] == "approve_draft")
        state.approve_engagement(self.st, eng_id)
        tasks = strategy.compute_next_tasks(self.st)
        self.assertTrue(any(t["kind"] == "send_engagement" for t in tasks))

    def test_after_send_and_wait_elapsed_suggests_manual_channel(self) -> None:
        eng = state.create_draft(self.st, "candidate:example-buyer")
        state.approve_engagement(self.st, eng["engagement_id"])
        state.mark_sent(self.st, eng["engagement_id"], dry_run=True)
        lead = self.st["leads"]["candidate:example-buyer"]
        # Force wait window elapsed.
        lead["next_eligible_at"] = "2000-01-01T00:00:00Z"
        tasks = strategy.compute_next_tasks(self.st)
        self.assertTrue(any(t["kind"] == "suggest_manual_channel" for t in tasks))
        manual = next(t for t in tasks if t["kind"] == "suggest_manual_channel")
        self.assertEqual(manual["channel"], "linkedin_message")

    def test_suppressed_leads_have_no_tasks(self) -> None:
        state.suppress_lead(self.st, "candidate:example-buyer", reason="stop")
        tasks = [
            t
            for t in strategy.compute_next_tasks(self.st)
            if t["lead_id"] == "candidate:example-buyer"
        ]
        self.assertEqual(tasks, [])


class EmailChannelTests(unittest.TestCase):
    def test_build_message_sets_trace_headers(self) -> None:
        msg, message_id = email_channel.build_message(
            to_email="info@buyer.example",
            subject="Hello",
            body_text="Body",
            lead_id="candidate:x",
            engagement_id="eng-1",
            config={
                "from_email": "contact@jianxiaoyitech.com",
                "from_name": "Jianxiaoyi Technology",
                "reply_to": "contact@jianxiaoyitech.com",
            },
        )
        self.assertIn("outreach-candidate:x-", message_id)
        self.assertEqual(msg["X-Jianxiaoyi-Lead-ID"], "candidate:x")
        self.assertEqual(msg["To"], "info@buyer.example")

    def test_dry_run_send_does_not_require_smtp(self) -> None:
        lead = {"lead_id": "candidate:x"}
        engagement = {
            "engagement_id": "eng-1",
            "channel": "email",
            "recipient": "info@buyer.example",
            "subject": "Hi",
            "body_text": "Hello",
        }
        result = email_channel.send_engagement_email(lead, engagement, dry_run=True)
        self.assertTrue(result["dry_run"])
        self.assertTrue(str(result["message_id"]).startswith("dry-run-"))


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws_root = self.root / "workspaces"
        self.workspace = "cli-ws"
        collection = (
            self.ws_root
            / self.workspace
            / "acquisition"
            / "customer-data-collection"
        )
        (collection / "outputs").mkdir(parents=True)
        (collection / "work").mkdir(parents=True)
        self.output_path = collection / "outputs" / "output.json"
        self.output_path.write_text(
            json.dumps({"outreach_ready_records": [sample_ready_record()]}),
            encoding="utf-8",
        )
        os.environ["POLARIS_BUSINESS_WORKSPACES_ROOT"] = str(self.ws_root)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        os.environ.pop("POLARIS_BUSINESS_WORKSPACES_ROOT", None)

    def test_cli_import_tick_next(self) -> None:
        code = runner.main(["import", "--workspace", self.workspace])
        self.assertEqual(code, 0)
        code = runner.main(["tick", "--workspace", self.workspace])
        self.assertEqual(code, 0)
        # Capture next via function rather than stdout parsing complexity.
        st = state.load_state(state.default_paths(self.workspace)["state"], self.workspace)
        tasks = strategy.compute_next_tasks(st)
        self.assertTrue(any(t["kind"] == "approve_draft" for t in tasks))
        code = runner.main(["status", "--workspace", self.workspace, "--tasks"])
        self.assertEqual(code, 0)

    def test_cli_rejects_live_send_in_polaris_mode_before_state_mutation(self) -> None:
        previous_mode = os.environ.get("POLARIS_BUSINESS_RUNTIME_MODE")
        os.environ["POLARIS_BUSINESS_RUNTIME_MODE"] = "polaris"
        try:
            code = runner.main(
                [
                    "send",
                    "--workspace",
                    self.workspace,
                    "--engagement-id",
                    "synthetic-engagement",
                    "--live",
                ]
            )
        finally:
            if previous_mode is None:
                os.environ.pop("POLARIS_BUSINESS_RUNTIME_MODE", None)
            else:
                os.environ["POLARIS_BUSINESS_RUNTIME_MODE"] = previous_mode

        self.assertEqual(code, 2)
        self.assertFalse(state.default_paths(self.workspace)["state"].exists())

    def test_cli_sync_writes_a_workflow_stage_output(self) -> None:
        collection_output = (
            self.ws_root
            / self.workspace
            / "data-collections"
            / "example-collection"
            / "outputs"
            / "output.json"
        )
        collection_output.parent.mkdir(parents=True)
        collection_output.write_text(
            json.dumps(
                {
                    "collection_id": "example-collection",
                    "outreach_ready_records": [sample_ready_record()],
                }
            ),
            encoding="utf-8",
        )
        outreach_root = (
            self.ws_root
            / self.workspace
            / "outreach"
            / "example-collection"
        )

        code = runner.main(
            [
                "sync",
                "--workspace",
                self.workspace,
                "--collection-output",
                str(collection_output),
                "--outreach-root",
                str(outreach_root),
                "--outreach-id",
                "example-collection",
            ]
        )

        self.assertEqual(code, 0)
        output = json.loads(
            (outreach_root / "outputs" / "output.json").read_text(encoding="utf-8")
        )
        self.assertEqual(output["schema_version"], "clue.outreach.output.v1")
        self.assertEqual(output["outreach_id"], "example-collection")
        self.assertTrue(output["collection_ref"]["collection_output_sha256"].startswith("sha256:"))
        synced = state.load_state(
            outreach_root / "work" / "outreach-state.json",
            self.workspace,
        )
        self.assertIn("candidate:example-buyer", synced["leads"])


if __name__ == "__main__":
    unittest.main()
