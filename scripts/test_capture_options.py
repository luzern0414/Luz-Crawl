"""Offline transport regression tests; these are not live research evidence."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import crawl_preflight as crawl
from test_crawl_preflight import _single_fixture


class CaptureOptionsTests(unittest.TestCase):
    def test_document_anchor_does_not_break_command_binding_but_spa_route_does(self):
        with tempfile.TemporaryDirectory() as tmp:
            task = Path(tmp).resolve()
            result = {"folder": str(task / "article"), "status": "captured", "url_check": {
                "requested": "https://example.org/document", "valid_content": True}}
            step = {"command": "capture", "args": ["capture", "https://example.org/document#section", "--out", str(task)]}
            self.assertEqual(crawl._observed_sources(step, result, task), [str(task / "article")])
            for different in ("https://example.org/other#section", "https://example.org/document#/admin", "https://example.org/document?q=other"):
                step["args"][1] = different
                with self.assertRaises(ValueError):
                    crawl._observed_sources(step, result, task)

    def test_text_research_can_disable_images_without_skipping_body_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, _ = _single_fixture(root, caller="luz-dev")
            source = value["sources"][0]
            commands = []

            def execute(args, **kwargs):
                commands.append(args)
                name = args[2]
                result = {"ready": True} if name == "doctor" else {}
                if name == "capture":
                    result = {"folder": source["archive"], "status": "captured",
                              "resolved_url": source["url"], "url_check": {"requested": source["url"], "valid_content": True}}
                return SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr="")

            with patch.object(crawl.subprocess, "run", side_effect=execute):
                result = crawl.run(root, "luz-dev", "offline capture options", task=value["task_root"],
                                   urls=[source["url"]], screenshot=False)
            captures = [cmd for cmd in commands if cmd[2] == "capture"]
            self.assertEqual(len(captures), 1)
            self.assertIn("--no-screenshot", captures[0])
            self.assertEqual(len(result["sources"]), 1)
            record = crawl.read(crawl.record_path(root, "luz-dev"))
            self.assertIn("--no-screenshot", next(s["args"] for s in record["steps"] if s["command"] == "capture"))
            self.assertNotEqual(result["status"], "complete")

    def test_interrupt_leaves_recoverable_blocked_state_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, _ = _single_fixture(root, caller="luz-dev")
            with patch.object(crawl.subprocess, "run", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    crawl.run(root, "luz-dev", "offline interrupted research", task=value["task_root"], urls=["https://example.org/doc"])
            path = crawl.record_path(root, "luz-dev")
            self.assertEqual(crawl.read(path)["status"], "blocked")
            self.assertFalse(path.with_suffix(".lock").exists())


if __name__ == "__main__":
    unittest.main()
