import argparse
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runner  # noqa: E402


class WorkspaceOutputTests(unittest.TestCase):
    def test_workspace_output_uses_configured_customer_collection_scope(self):
        with tempfile.TemporaryDirectory() as root:
            previous = os.environ.get("POLARIS_LITERATURE_WORKSPACES_ROOT")
            os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"] = root
            try:
                path = runner.output_path(argparse.Namespace(output=None, workspace="example", run_id="run-1"), "seed.json")
            finally:
                if previous is None:
                    os.environ.pop("POLARIS_LITERATURE_WORKSPACES_ROOT", None)
                else:
                    os.environ["POLARIS_LITERATURE_WORKSPACES_ROOT"] = previous
        self.assertEqual(Path(path), Path(root) / "example/acquisition/customer-data-collection/runs/run-1/seed.json")


if __name__ == "__main__":
    unittest.main()
