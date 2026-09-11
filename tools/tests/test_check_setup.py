import json
import os
import subprocess
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]


class CheckSetupTests(unittest.TestCase):
    def test_browser_check_setup_reports_display_next_step(self):
        env = os.environ.copy()
        env.pop("DISPLAY", None)
        completed = subprocess.run(
            [str(TOOLS / "browser" / "check-setup"), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        report = json.loads(completed.stdout)
        display = next(item for item in report["missingRecommended"] if item["key"] == "DISPLAY")
        self.assertIn("SETUP-DISPLAY.md", display["next"])

    def test_common_inventory_tools_own_check_setup(self):
        inventory = json.loads((TOOLS / "tool-inventory.json").read_text(encoding="utf-8"))
        for item in inventory["tools"]:
            directory = TOOLS / Path(item["entrypoint"]).parent
            self.assertTrue((directory / "check-setup").is_file(), item["id"])
            self.assertTrue((directory / "backend.lock.json").is_file(), item["id"])


if __name__ == "__main__":
    unittest.main()
