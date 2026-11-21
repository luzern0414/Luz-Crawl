"""status, review-init, supplement-init, conclude --dry-run and the entry chain of run.

They save copying and never decide: every judgment stays empty until the executor writes it, and what conclude and check
accept is unchanged. The stand-in CLI is offline; nothing here is evidence of live research."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import crawl_preflight as crawl
from test_crawl_preflight import FAKE_CLI, fixture, write_review_fixture
from test_evidence_policy import payload_for


QUERIES = [f"离线方向 {i}" for i in range(5)]
URLS = [f"https://publisher{i % 3}.example/doc-{i}" for i in range(6)]


class HelperCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "fake.mjs").write_text(FAKE_CLI, encoding="utf-8")
        self.saved = (crawl.CLI, crawl.DEFAULT_OUTPUT)
        crawl.CLI = self.root / "fake.mjs"
        crawl.DEFAULT_OUTPUT = str(self.root / "crawl-output")
        os.environ["FAKE_LOG"] = str(self.root / "calls.json")
        os.environ.pop("FAKE_EMPTY", None)
        self.session = self.root / "design"
        if subprocess.run(["node", "--version"], capture_output=True).returncode != 0:
            self.skipTest("node unavailable")

    def tearDown(self):
        crawl.CLI, crawl.DEFAULT_OUTPUT = self.saved
        os.environ.pop("FAKE_EMPTY", None)
        self.tmp.cleanup()

    def calls(self, name):
        return [c for c in json.loads((self.root / "calls.json").read_text(encoding="utf-8")) if c[0] == name]

    def research(self, **options):
        options = {"queries": QUERIES, "urls": URLS, "read_count": 1, "research": "deep", **options}
        return crawl.run(self.session, "luz-design", "界面依据", stage="design", **options)

    def path(self):
        return crawl.record_path(self.session, "luz-design", "design")

    def test_one_batch_collects_multiple_queries_and_urls_and_writes_one_summary(self):
        result = self.research(queries=QUERIES[:3], urls=URLS[:2], concurrency=2)
        self.assertEqual([len(self.calls(command)) for command in ("batch", "search", "capture", "summary", "experience")],
                         [1, 0, 0, 0, 1])
        record = crawl.read(self.path())
        self.assertEqual([step["command"] for step in record["steps"]].count("summary"), 1)
        self.assertEqual(len(result["sources"]), 5)
        self.assertEqual(result["candidate_count"], 8)
        self.assertEqual(crawl.read(result["batch_file"])["concurrency"], 2)

    def test_compact_cli_keeps_research_gaps_and_points_to_all_verified_sources(self):
        from contextlib import redirect_stdout
        from io import StringIO
        argv = [str(crawl.__file__), "run", "--session", str(self.session), "--caller", "luz-design", "--stage", "design",
                "--topic", "界面依据", "--research", "search", "--read", "1", "--query", QUERIES[0], "--compact", "--concurrency", "8"]
        output = StringIO()
        with patch.object(sys, "argv", argv), redirect_stdout(output):
            self.assertEqual(crawl.main(), 1)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["status"], "needs-research")
        self.assertTrue(receipt["research_errors"])
        self.assertNotIn("sources", receipt)
        self.assertEqual(receipt["source_count"], len(crawl.read(receipt["record"])["sources"]))
        self.assertEqual(crawl.read(receipt["batch_file"])["concurrency"], 8)

    def test_a_query_names_its_own_entry_and_a_chain_moves_on_only_when_an_entry_brings_nothing(self):
        os.environ["FAKE_EMPTY"] = "bing"
        value = self.research(queries=["github::browser automation", "列表密度", "site:m3.material.io 表面"], platform="bing,baidu")
        record = crawl.read(self.path())
        self.assertEqual([s["args"][1:3] for s in record["steps"] if s["command"] == "search"],
                         [["github", "browser automation"], ["bing", "列表密度"], ["baidu", "列表密度"], ["bing", "site:m3.material.io 表面"], ["baidu", "site:m3.material.io 表面"]])
        # Prepare experience for the fallback before the browser batch starts.
        self.assertIn({"query": "列表密度", "platform": "baidu", "notes": []}, crawl.read(value["experience_logs"][0])["lookups"])
        self.assertEqual(value["status"], "needs-research")  # three distinct queries are below the floor, however many entries ran
        self.assertEqual(crawl.status(self.session, "luz-design", "design")["queries"]["have"], 3)
        with self.assertRaises(ValueError):
            self.research(platform="bing, 不是入口")

    def test_a_route_log_with_a_new_hash_still_has_to_match_the_batch(self):
        self.research()
        record = crawl.read(self.path())
        search = next(step for step in record["steps"] if step["command"] == "search")
        log = crawl.read(search["file"])
        log["candidates"] = []
        crawl.write(search["file"], log)
        search["sha256"] = crawl.digest(search["file"])
        crawl.write(self.path(), record)
        self.assertTrue(any("路线日志与批次归档不符" in error for error in
                            crawl.validate_preflight(self.session, "luz-design", "design", require_findings=False)))

    def test_a_batch_process_failure_keeps_one_receipt_and_allows_an_append(self):
        argv = [str(crawl.__file__), "run", "--session", str(self.session), "--caller", "luz-design", "--stage", "design",
                "--topic", "界面依据", "--research", "deep", "--query", QUERIES[0]]
        args = dict(queries=QUERIES, urls=URLS)
        with patch.dict(os.environ, {"FAKE_BATCH_FAIL": "1"}), patch.object(sys, "argv", argv), patch("sys.stdout") as stdout:
            self.assertEqual(crawl.main(), 1)
            result = json.loads("".join(call.args[0] for call in stdout.write.call_args_list))
            self.assertEqual(result["status"], "blocked")
        self.research(append=True, **args)
        record = crawl.read(self.path())
        self.assertEqual([step["exit_code"] for step in record["steps"] if step["command"] == "batch"], [1, 2])
        self.assertEqual(crawl.validate_preflight(self.session, "luz-design", "design", require_findings=False), [])

    def test_status_is_read_only_and_names_what_is_missing(self):
        self.assertEqual(crawl.status(self.session, "luz-design", "design")["status"], "missing")
        self.research(queries=QUERIES[:2], urls=URLS[:2])
        before = self.path().read_bytes()
        thin = crawl.status(self.session, "luz-design", "design")
        self.assertEqual((thin["queries"]["have"], thin["queries"]["need"], thin["bodies"]["need"]), (2, 5, 10))
        self.assertTrue(thin["floor_errors"])
        self.assertTrue(any("--append" in step for step in thin["next"]))
        self.research(queries=QUERIES[2:], urls=URLS[2:], append=True)
        enough = crawl.status(self.session, "luz-design", "design")
        self.assertEqual(enough["floor_errors"], [])
        self.assertEqual(enough["candidates"]["not_in_review"], enough["candidates"]["total"])
        self.assertTrue(any("review-init" in step for step in enough["next"]))
        self.assertFalse(Path(enough["review"]["file"]).exists())
        self.assertNotEqual(before, self.path().read_bytes())  # the append changed the record; status itself wrote nothing:
        after = self.path().read_bytes()
        crawl.status(self.session, "luz-design", "design")
        self.assertEqual(after, self.path().read_bytes())

    def test_review_init_binds_the_whole_pool_and_leaves_every_judgment_to_the_executor(self):
        self.research(queries=[*QUERIES[:4], "有经验的方向"])
        record = crawl.read(self.path())
        inventory = crawl.read(self.path().with_name(record["candidate_inventory"]))
        first = crawl.review_init(self.session, "luz-design", "design")
        file = Path(first["review"])
        review = crawl.read(file)
        self.assertEqual([row["url"] for row in review["candidate_reviews"]], [row["url"] for row in inventory["candidates"]])
        self.assertTrue(all(row["status"] == row["category"] == row["priority"] == row["reason"] == "" for row in review["candidate_reviews"]))
        self.assertEqual({row["url"] for row in review["candidate_reviews"] if row.get("source_ids")},
                         {row["url"] for row in inventory["candidates"] if row["status"] == "body-captured"})
        self.assertEqual({key: review[key] for key in ("caller", "stage", "task_root", "candidate_inventory_sha256")},
                         {key: record[key] for key in ("caller", "stage", "task_root", "candidate_inventory_sha256")})
        self.assertEqual([group["queries"] for group in review["query_groups"]], [[q] for q in [*QUERIES[:4], "有经验的方向"]])
        self.assertTrue(all(group["purpose"] == "" for group in review["query_groups"]))
        # what a log shows is filled in; whether a hit was used is not
        hit = next(row for row in review["experience_reuse"] if row["query"] == "有经验的方向")
        self.assertEqual((hit["keys"], hit["status"], hit["impact"]), (["route-offline"], "", ""))
        self.assertTrue(all(row["status"] == "无命中" for row in review["experience_reuse"] if not row["keys"]))
        self.assertEqual(review["stop"], {"reason": "", "basis": "", "remaining": []})
        self.assertTrue(first["to_fill"])
        # an unfilled skeleton is refused exactly like a missing review
        self.assertTrue(any("尽责复盘" in error for error in crawl.conclude_errors(self.session, "luz-design", payload_for(record), "design")))
        # running it again changes nothing, byte for byte
        before = file.read_bytes()
        self.assertFalse(crawl.review_init(self.session, "luz-design", "design")["changed"])
        self.assertEqual(before, file.read_bytes())
        # a decision the executor wrote survives the next round; the new candidates arrive empty and the hash is rebound
        review["candidate_reviews"][0].update(category="official", status="unread", priority="high", reason="待读的官方原文")
        review["query_groups"][0]["purpose"] = "核心意图"
        crawl.write(file, review)
        self.research(queries=["补搜方向"], urls=[], append=True)
        merged_result = crawl.review_init(self.session, "luz-design", "design")
        merged = crawl.read(file)
        self.assertEqual(merged_result["added"], 2)
        self.assertEqual(merged["candidate_reviews"][0]["reason"], "待读的官方原文")
        self.assertEqual(merged["query_groups"][0]["purpose"], "核心意图")
        self.assertEqual(merged["query_groups"][-1], {"purpose": "", "queries": ["补搜方向"], "platform": "bing", "question_ids": []})
        self.assertEqual(len(merged["rounds"]), 2)
        self.assertEqual(merged["candidate_inventory_sha256"], crawl.read(self.path())["candidate_inventory_sha256"])
        self.assertEqual(len(merged["candidate_reviews"]), len(crawl.read(self.path().with_name(record["candidate_inventory"]))["candidates"]))

    def test_supplement_init_lists_every_body_and_the_dry_run_writes_nothing(self):
        self.research()
        record = crawl.read(self.path())
        crawl.review_init(self.session, "luz-design", "design")
        review_file = self.path().with_name(self.path().stem + "-research-review.json")
        review = crawl.read(review_file)
        review["questions"] = [{"id": "Q-001", "question": "顶部与内容怎样过渡", "importance": "required"}]
        crawl.write(review_file, review)
        first = crawl.supplement_init(self.session, "luz-design", "design")
        payload = crawl.read(first["supplement"])
        self.assertEqual([f["source_id"] for f in payload["findings"]], [s["id"] for s in record["sources"]])
        self.assertTrue(all(f["adopted"] is None and f["quote"] == f["locator"] == f["summary"] == "" for f in payload["findings"]))
        self.assertEqual([r["source_id"] for r in payload["source_reviews"]], [s["id"] for s in record["sources"]])
        self.assertEqual(payload["coverage"], [{"question_id": "Q-001", "question": "顶部与内容怎样过渡", "applies_to": "", "finding_ids": []}])
        self.assertEqual((payload["template_uses"], payload["blocking_gaps"], payload["gaps"]), ([], [], []))
        self.assertTrue(all(Path(row["content"]).is_file() for row in first["sources"]))
        before = self.path().read_bytes()
        self.assertTrue(crawl.conclude_errors(self.session, "luz-design", payload, "design"))
        self.assertEqual(before, self.path().read_bytes())
        self.assertFalse(self.path().with_suffix(".html").exists())
        # what the executor wrote stays; a later body gets its own empty rows with the next number
        payload["findings"][0].update(kind="fact", quote="offline body", locator="正文首段", summary="离线结论", applies_to="raw/report.html", adopted=True)
        crawl.write(first["supplement"], payload)
        self.assertFalse(crawl.supplement_init(self.session, "luz-design", "design")["changed"])
        self.research(queries=[], urls=["https://publisher9.example/late"], append=True)
        later = crawl.read(crawl.supplement_init(self.session, "luz-design", "design")["supplement"])
        self.assertEqual(later["findings"][0]["summary"], "离线结论")
        self.assertEqual((later["findings"][-1]["id"], later["findings"][-1]["adopted"]), (f"F-{len(record['sources']) + 1:03d}", None))

    def test_the_cli_prints_json_and_the_dry_run_exit_code_tells_whether_conclude_would_pass(self):
        self.research()
        env = {**os.environ, "PYTHONUTF8": "1"}
        base = [sys.executable, "-X", "utf8", str(Path(crawl.__file__)), "--session", str(self.session), "--caller", "luz-design", "--stage", "design"]
        base = [*base[:4], "status", *base[4:]]
        shown = subprocess.run(base, capture_output=True, text=True, encoding="utf-8", env=env)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(json.loads(shown.stdout)["status"], "needs-conclusion")
        supplement = self.root / "supplement.json"
        supplement.write_text(json.dumps({"findings": [], "gaps": []}), encoding="utf-8")
        dry = subprocess.run([*base[:4], "conclude", *base[5:], "--file", str(supplement), "--dry-run"], capture_output=True, text=True, encoding="utf-8", env=env)
        self.assertEqual(dry.returncode, 1, dry.stdout + dry.stderr)
        result = json.loads(dry.stdout)
        self.assertTrue(result["dry_run"] and not result["ok"] and result["errors"])
        self.assertEqual(crawl.read(self.path())["status"], "needs-conclusion")


class DryRunAgreesWithConcludeTests(unittest.TestCase):
    def test_a_supplement_the_dry_run_accepts_is_one_conclude_accepts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, value, _ = fixture(root)
            payload = payload_for(value)
            write_review_fixture(path, value, payload)
            before = path.read_bytes()
            self.assertEqual(crawl.conclude_errors(root, "luz-design", payload), [])
            self.assertEqual(before, path.read_bytes())
            broken = json.loads(json.dumps(payload))
            broken["findings"][0]["quote"] = "这句话不在归档正文里，属于编造的引文"
            self.assertTrue(any("引用摘录不在本次归档正文中" in error for error in crawl.conclude_errors(root, "luz-design", broken)))
            crawl.conclude(root, "luz-design", payload)
            self.assertEqual(crawl.validate_preflight(root, "luz-design"), [])


if __name__ == "__main__":
    unittest.main()
