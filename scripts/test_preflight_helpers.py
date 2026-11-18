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

import crawl_preflight as crawl
from test_crawl_preflight import fixture, write_review_fixture
from test_evidence_policy import payload_for

FAKE_CLI = r"""
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [command, ...args] = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push([command, ...args]); fs.writeFileSync(log, JSON.stringify(calls));
const out = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };
const option = (name) => args[args.indexOf(name) + 1];
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const archive = (task, label, url) => {
  const folder = path.join(task, 'raw', `${calls.length}_${label}`);
  fs.mkdirSync(path.join(folder, 'snapshots'), { recursive: true });
  const content = path.join(folder, 'content.json'), snapshot = path.join(folder, 'snapshots', '0.json');
  fs.writeFileSync(snapshot, '{"text":"offline"}');
  fs.writeFileSync(content, JSON.stringify({ status: 'captured', captured_at: new Date().toISOString(), resolved_url: url, title: label, text: 'offline body ' + url, url_check: { valid_content: true }, completeness: { scope: 'rendered_body' } }));
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ files: [{ path: 'content.json', sha256: sha(content) }, { path: 'snapshots/0.json', sha256: sha(snapshot) }] }));
  return folder;
};
if (command === 'doctor') out({ ready: false, silent_ready: true });
if (command === 'begin') { const folder = path.join(option('--out'), '001-task'); fs.mkdirSync(path.join(folder, 'raw'), { recursive: true }); fs.writeFileSync(path.join(folder, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: args[0] })); out({ folder }); }
if (command === 'experience') out({ notes: option('--query').includes('经验') ? [{ key: 'route-offline', kind: 'lesson', text: 'offline' }, { key: 'style', kind: 'preference', text: 'offline' }] : [{ key: 'style', kind: 'preference', text: 'offline' }] });
if (command === 'search') {
  if ((process.env.FAKE_EMPTY || '').split(',').includes(args[0])) out({ status: 'partial', platform: args[0], query: args[1], search_performed: true, candidates: [], sources: [] });
  const base = `https://site${calls.length}.example`;
  const folder = Number(option('--read')) > 0 ? archive(option('--out'), 'hit', `${base}/read`) : null;
  out({ status: 'partial', platform: args[0], query: args[1], search_performed: true,
    candidates: [{ url: `${base}/read`, title: 'read' }, { url: `${base}/other?utm_source=x`, title: 'other' }],
    sources: folder ? [{ status: 'captured', folder, url_check: { valid_content: true } }] : [] });
}
if (command === 'capture') { const folder = archive(option('--out'), 'page', args[0]); out({ status: 'captured', folder, title: 'page', url_check: { requested: args[0], valid_content: true } }); }
if (command === 'summary') out({ file: 'summary.html' });
out({ error: 'unknown' }, 1);
"""

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

    def test_a_query_names_its_own_entry_and_a_chain_moves_on_only_when_an_entry_brings_nothing(self):
        os.environ["FAKE_EMPTY"] = "bing"
        value = self.research(queries=["github::browser automation", "列表密度", "site:m3.material.io 表面"], platform="bing,baidu")
        self.assertEqual([c[1:3] for c in self.calls("search")],
                         [["github", "browser automation"], ["bing", "列表密度"], ["baidu", "列表密度"], ["bing", "site:m3.material.io 表面"], ["baidu", "site:m3.material.io 表面"]])
        # the lookup of experience follows the entry that is really searched
        self.assertIn(["experience", "--query", "列表密度", "--platform", "baidu"], self.calls("experience"))
        self.assertEqual(value["status"], "needs-research")  # three distinct queries are below the floor, however many entries ran
        self.assertEqual(crawl.status(self.session, "luz-design", "design")["queries"]["have"], 3)
        with self.assertRaises(ValueError):
            self.research(platform="bing, 不是入口")

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
