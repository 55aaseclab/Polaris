import argparse
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runner  # noqa: E402


class WorkspaceOutputTests(unittest.TestCase):
    def test_output_path_requires_an_explicit_file(self):
        with self.assertRaises(runner.CliError):
            runner.output_path(argparse.Namespace(output=None), "seed.json")
        self.assertEqual(
            runner.output_path(argparse.Namespace(output="/tmp/seed.json"), "seed.json"),
            "/tmp/seed.json",
        )


if __name__ == "__main__":
    unittest.main()
