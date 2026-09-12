import json
import os
import subprocess
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]


class CheckSetupTests(unittest.TestCase):
    def test_browser_check_setup_reports_display_next_step(self):
        env = os.environ.copy()
        env["POLARIS_DATA_ROOT"] = "/tmp/polaris-isolated-browser"
        env.pop("DISPLAY", None)
        completed = subprocess.run(
            [str(TOOLS / "browser" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        display = next(item for item in report["checked"] if item["key"] == "DISPLAY")
        self.assertEqual(display["status"], "missing")
        self.assertIn("SETUP-BROWSER.md", display["next"])
        self.assertTrue(
            any(item["key"] == "DISPLAY" for item in report["missingRecommended"])
        )

    def test_semantic_scholar_accepts_short_api_key_alias(self):
        env = os.environ.copy()
        env.pop("POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY", None)
        env["SEMANTIC_SCHOLAR_API_KEY"] = "test-key"
        completed = subprocess.run(
            [str(TOOLS / "semantic-scholar" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        self.assertFalse(
            any(
                item["key"] == "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"
                for item in report["missingRecommended"]
            )
        )

    def test_deepsec_requires_api_url_and_accepts_alias(self):
        env = os.environ.copy()
        env["POLARIS_DATA_ROOT"] = "/tmp/polaris-isolated-deepsec"
        env.pop("POLARIS_LITERATURE_ENV_FILE", None)
        env.pop("POLARIS_LITERATURE_DEEPSEC_API_URL", None)
        env.pop("DEEPSEC_API_URL", None)
        missing = subprocess.run(
            [str(TOOLS / "deepsec" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(missing.stdout)
        self.assertTrue(
            any(item["key"] == "POLARIS_LITERATURE_DEEPSEC_API_URL" for item in report["missingRequired"])
        )
        env["DEEPSEC_API_URL"] = "http://deepsec.test/search"
        present = subprocess.run(
            [str(TOOLS / "deepsec" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(present.stdout)
        self.assertFalse(
            any(item["key"] == "POLARIS_LITERATURE_DEEPSEC_API_URL" for item in report["missingRequired"])
        )

    def test_web_search_reports_checked_prerequisites(self):
        env = os.environ.copy()
        completed = subprocess.run(
            [str(TOOLS / "web-search" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        keys = {item["key"] for item in report["checked"]}
        self.assertIn("docker", keys)
        self.assertIn("config/settings.yml", keys)
        self.assertTrue(all("status" in item for item in report["checked"]))

    def test_codex_accepts_path_binary_without_env(self):
        env = os.environ.copy()
        env.pop("POLARIS_LITERATURE_CODEX_BIN", None)
        env.pop("CODEX_BIN", None)
        completed = subprocess.run(
            [str(TOOLS / "codex" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        self.assertFalse(
            any(item["key"] == "POLARIS_LITERATURE_CODEX_BIN" for item in report["missingRecommended"])
        )

    def test_browser_proxy_uses_one_public_configuration(self):
        env = os.environ.copy()
        env["POLARIS_DATA_ROOT"] = "/tmp/polaris-isolated-browser-proxy"
        env["BROWSER_PROXY_SERVER"] = "http://proxy.test:33335"
        env["BROWSER_PROXY_USERNAME"] = "proxy-user"
        env["BROWSER_PROXY_PASSWORD"] = "proxy-password"
        env.pop("BROWSER_PROXY_BYPASS", None)
        env.pop("PROXY_HOST", None)
        env.pop("PROXY_PORT", None)
        env.pop("PROXY_USERNAME", None)
        env.pop("PROXY_PASSWORD", None)
        completed = subprocess.run(
            [str(TOOLS / "browser" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        self.assertFalse(
            any(
                item["key"] == "BROWSER_PROXY_SERVER"
                and item["status"] == "missing"
                for item in report["checked"]
            )
        )
        self.assertFalse(
            any(
                item["key"] in {"BROWSER_PROXY_USERNAME", "BROWSER_PROXY_PASSWORD"}
                and item["status"] == "missing"
                for item in report["checked"]
            )
        )

    def test_browser_proxy_check_rejects_partial_authentication(self):
        env = os.environ.copy()
        env["POLARIS_DATA_ROOT"] = "/tmp/polaris-isolated-browser-proxy-partial"
        env["BROWSER_PROXY_SERVER"] = "http://proxy.test:33335"
        env["BROWSER_PROXY_USERNAME"] = "proxy-user"
        env.pop("BROWSER_PROXY_PASSWORD", None)
        completed = subprocess.run(
            [str(TOOLS / "browser" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        password = next(
            item
            for item in report["checked"]
            if item["key"] == "BROWSER_PROXY_PASSWORD"
        )
        self.assertEqual(password["status"], "missing")
        self.assertIn("both", password["reason"])

    def test_common_inventory_tools_own_check_setup(self):
        inventory = json.loads((TOOLS / "tool-inventory.json").read_text(encoding="utf-8"))
        for item in inventory["tools"]:
            directory = TOOLS / Path(item["entrypoint"]).parent
            self.assertTrue((directory / "check-setup").is_file(), item["id"])
            self.assertTrue((directory / "backend.lock.json").is_file(), item["id"])


if __name__ == "__main__":
    unittest.main()
