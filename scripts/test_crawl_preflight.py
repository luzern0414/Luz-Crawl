"""Evidence gates: a command succeeding is not the same as completed research."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import crawl_preflight
from crawl_preflight import digest, record_path, validate_preflight, conclude, now, plain_title, run


def evidence_dir(archive):
    """Where an archive keeps content.json and manifest.json: itself (task_folder_v2) or its raw/ child (older layout)."""
    archive = Path(archive)
    return archive if (archive / "manifest.json").is_file() else archive / "raw"


def fixture(root, caller="luz-design", stage=None, source_url="https://example.org/doc", layout="v2"):
    """layout "v2": <task>/raw/<archive>/content.json, marker <task>/raw/luz-task.json.
    layout "older": <task>/raw/<archive>/raw/content.json, marker <task>/luz-task.json (sibling_raw_v1)."""
    timestamp = now()
    label = f"{caller}-{stage or 'standalone'}"
    if layout == "v2":
        task = root / "raw" / "fixture-task"
        archive = task / "raw" / label
        raw = archive
        marker = task / "raw" / "luz-task.json"
        marker_value = {"kind": "task_archive", "schema_version": 1, "delivery_layout": "task_folder_v2"}
    else:
        task = root / "raw" / "fixture-task"
        archive = task / "raw" / label
        raw = archive / "raw"
        marker = task / "luz-task.json"
        marker_value = {"kind": "task_archive", "schema_version": 1, "delivery_layout": "sibling_raw_v1"}
    (raw / "snapshots").mkdir(parents=True, exist_ok=True)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(marker_value), encoding="utf-8")
    snapshot = raw / "snapshots" / "0000.json"
    snapshot.write_text('{"text":"Actual browser body"}', encoding="utf-8")
    content = raw / "content.json"
    content.write_text(json.dumps({"status": "captured", "captured_at": timestamp, "resolved_url": source_url, "text": "Actual document body", "url_check": {"valid_content": True}, "completeness": {"scope": "rendered_body_and_loaded_items"}}), encoding="utf-8")
    manifest = raw / "manifest.json"
    manifest.write_text(json.dumps({"status": "captured", "files": [{"path": str(p.relative_to(archive)), "sha256": digest(p)} for p in (content, snapshot)]}), encoding="utf-8")
    logs = root / "raw" / "00-crawl" / "logs" / label
    logs.mkdir(parents=True, exist_ok=True)
    steps = []
    for name, result in [("doctor", {"ready": True}), ("experience", {}), ("capture", {"folder": str(archive), "status": "captured", "resolved_url": source_url, "url_check": {"requested": source_url, "valid_content": True}}), ("summary", {})]:
        p = logs / f"{name}.json"
        p.write_text(json.dumps(result), encoding="utf-8")
        args = [name, source_url, "--out", str(task)] if name == "capture" else [name]
        steps.append({"command": name, "args": args, "exit_code": 0, "file": str(p), "sha256": digest(p)})
    record = {"schema_version": 1, "caller": caller, "stage": stage, "topic": "test", "started_at": timestamp, "finished_at": now(), "task_root": str(task), "status": "captured", "steps": steps, "sources": [{"id": "SRC-001", "archive": str(archive), "manifest_sha256": digest(manifest), "url": source_url, "captured_at": timestamp}], "findings": [], "gaps": []}
    path = record_path(root, caller, stage)
    path.write_text(json.dumps(record), encoding="utf-8")
    return path, record, snapshot


def complete_fixture(root, caller, stage=None):
    """Offline fixture for integration tests; never a user approval or live search."""
    fixture(root, caller, stage)
    return conclude(root, caller, {"findings": [{"source_id": "SRC-001", "summary": "离线夹具中的补充信息", "applies_to": "测试场景的方案输入", "adopted": True}], "gaps": []}, stage)


class OlderLayoutTests(unittest.TestCase):
    """Records and archives written before task_folder_v2 (marker beside raw/, files under <archive>/raw/) still pass the gate."""

    def test_older_archive_passes_and_drift_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, snapshot = fixture(root, layout="older")
            self.assertTrue((Path(value["sources"][0]["archive"]) / "raw" / "content.json").is_file())
            self.assertTrue((Path(value["task_root"]) / "luz-task.json").is_file())
            conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "旧布局存档的结论", "applies_to": "响应式布局方案", "adopted": True}], "gaps": []})
            self.assertEqual(validate_preflight(root, "luz-design"), [])
            snapshot.write_text("changed", encoding="utf-8")
            self.assertTrue(any("哈希" in e for e in validate_preflight(root, "luz-design")))

    def test_current_archive_files_are_found_without_raw(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, _ = fixture(root)
            archive = Path(value["sources"][0]["archive"])
            self.assertTrue((archive / "content.json").is_file() and not (archive / "raw").exists())
            self.assertEqual(crawl_preflight.archive_dir(archive), archive)
            self.assertTrue((Path(value["task_root"]) / "raw" / "luz-task.json").is_file())
            self.assertEqual(crawl_preflight.task_marker(value["task_root"])["delivery_layout"], "task_folder_v2")
            conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "新布局存档的结论", "applies_to": "响应式布局方案", "adopted": True}], "gaps": []})
            self.assertEqual(validate_preflight(root, "luz-design"), [])

    def test_missing_marker_or_manifest_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, _ = fixture(root)
            (Path(value["task_root"]) / "raw" / "luz-task.json").unlink()
            self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))
            root2 = Path(tmp) / "second"
            _, value2, _ = fixture(root2)
            (Path(value2["sources"][0]["archive"]) / "manifest.json").unlink()
            self.assertTrue(validate_preflight(root2, "luz-design", require_findings=False))


class PreflightTests(unittest.TestCase):
    def test_missing_and_doctor_only_are_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertTrue(validate_preflight(root, "luz-design"))
            p, value, _ = fixture(root)
            value["steps"] = value["steps"][:1]
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design"))

    def test_body_without_applied_findings_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            self.assertTrue(any("补充信息" in e for e in validate_preflight(root, "luz-design")))

    def test_valid_findings_and_snapshot_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, _, snapshot = fixture(root)
            conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "尺寸由容器和内容决定", "applies_to": "响应式布局方案", "adopted": True}], "gaps": []})
            self.assertEqual(validate_preflight(root, "luz-design"), [])
            snapshot.write_text("changed", encoding="utf-8")
            self.assertTrue(any("哈希" in e for e in validate_preflight(root, "luz-design")))

    def test_another_caller_or_stage_cannot_reuse_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            self.assertTrue(validate_preflight(root, "luz-dev"))
            self.assertTrue(validate_preflight(root, "luz-design", "design"))

    def test_search_candidates_are_not_detail_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            content = evidence_dir(value["sources"][0]["archive"]) / "content.json"
            data = json.loads(content.read_text(encoding="utf-8"))
            data["completeness"]["scope"] = "search_candidates"
            content.write_text(json.dumps(data), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design"))

    def test_error_response_is_not_readable_research(self):
        from crawl_preflight import source_errors
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, value, _ = fixture(root)
            source = value["sources"][0]
            archive = Path(source["archive"])
            content = evidence_dir(archive) / "content.json"
            data = json.loads(content.read_text(encoding="utf-8"))
            data["text"] = "Service Unavailable"
            content.write_text(json.dumps(data), encoding="utf-8")
            manifest = evidence_dir(archive) / "manifest.json"
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["files"][0]["sha256"] = digest(content)
            manifest.write_text(json.dumps(data), encoding="utf-8")
            source["manifest_sha256"] = digest(manifest)
            self.assertTrue(source_errors(source, Path(value["task_root"])))

    def test_unrelated_url_and_stale_capture_are_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            value["sources"][0]["url"] = "https://unrelated.example/doc"
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(any("网址" in e for e in validate_preflight(root, "luz-design")))
            value["sources"][0]["captured_at"] = "2020-01-01T00:00:00Z"
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(any("本次" in e for e in validate_preflight(root, "luz-design")))

    def test_metadata_cannot_refresh_old_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            archive = Path(value["sources"][0]["archive"])
            content = evidence_dir(archive) / "content.json"
            body = json.loads(content.read_text(encoding="utf-8"))
            body["captured_at"] = "2025-01-01T00:00:00Z"
            content.write_text(json.dumps(body), encoding="utf-8")
            manifest = evidence_dir(archive) / "manifest.json"
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["files"][0]["sha256"] = digest(content)
            manifest.write_text(json.dumps(data), encoding="utf-8")
            value["sources"][0]["manifest_sha256"] = digest(manifest)
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))

    def test_failed_or_unrelated_command_logs_cannot_supply_sources(self):
        for mutation in ("failed", "wrong_url", "wrong_task"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                p, value, _ = fixture(root)
                step = value["steps"][2]
                log = Path(step["file"])
                if mutation == "failed":
                    log.write_text(json.dumps({"status": "failed", "error": {"archive": value["sources"][0]["archive"]}}), encoding="utf-8")
                    step["sha256"] = digest(log)
                elif mutation == "wrong_url":
                    step["args"][1] = "https://other.example/doc"
                else:
                    step["args"][-1] = str(root / "other-task")
                p.write_text(json.dumps(value), encoding="utf-8")
                self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))

    def test_malformed_records_and_findings_fail_without_tracebacks(self):
        for field, replacement in [("topic", 123), ("started_at", None), ("sources", []), ("steps", {}), ("sources", [None])]:
            with self.subTest(field=field, value=replacement), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                p, value, _ = fixture(root)
                value[field] = replacement
                p.write_text(json.dumps(value), encoding="utf-8")
                self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            for payload in ([], {"findings": [{"source_id": "SRC-001", "summary": {}, "applies_to": [], "adopted": True}]}):
                with self.assertRaises(ValueError):
                    conclude(root, "luz-design", payload)

    def test_duplicate_source_ids_are_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            value["sources"].append(dict(value["sources"][0]))
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))

    def test_shared_task_keeps_stage_evidence_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            complete_fixture(root, "luz-project", "requirements")
            complete_fixture(root, "luz-system", "architecture")
            self.assertEqual(validate_preflight(root, "luz-project", "requirements"), [])
            self.assertEqual(validate_preflight(root, "luz-system", "architecture"), [])

    def test_snapshot_alias_cannot_substitute_for_a_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, snapshot = fixture(root)
            snapshot.unlink()
            archive = Path(value["sources"][0]["archive"])
            manifest = evidence_dir(archive) / "manifest.json"
            content = evidence_dir(archive) / "content.json"
            manifest.write_text(json.dumps({"files": [{"path": "content.json", "sha256": digest(content)}, {"path": "snapshots/../content.json", "sha256": digest(content)}]}), encoding="utf-8")
            value["sources"][0]["manifest_sha256"] = digest(manifest)
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))

    def test_exit_code_must_be_integer_and_additional_blocked_route_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            value["steps"][2]["exit_code"] = False
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertTrue(validate_preflight(root, "luz-design", require_findings=False))
            value["steps"][2]["exit_code"] = 0
            extra = Path(value["steps"][2]["file"]).with_name("blocked.json")
            extra.write_text('{"status":"awaiting_user"}', encoding="utf-8")
            value["steps"].insert(3, {**value["steps"][2], "file": str(extra), "sha256": digest(extra)})
            p.write_text(json.dumps(value), encoding="utf-8")
            self.assertEqual(validate_preflight(root, "luz-design", require_findings=False), [])

    def test_doctor_gate_accepts_ready_or_silent_ready_only(self):
        for payload, expected in (({"ready": False, "silent_ready": True}, True), ({"ready": True}, True), ({"ready": False, "silent_ready": False}, False), ({"silent_ready": "yes"}, False)):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                p, value, _ = fixture(root)
                log = Path(value["steps"][0]["file"])
                log.write_text(json.dumps(payload), encoding="utf-8")
                value["steps"][0]["sha256"] = digest(log)
                p.write_text(json.dumps(value), encoding="utf-8")
                self.assertEqual(validate_preflight(root, "luz-design", require_findings=False) == [], expected)


class ConclusionPageTests(unittest.TestCase):
    def conclude_page(self, root, topic="B2B订货系统（含经销商端）", gaps=None):
        fixture(root)
        record = record_path(root, "luz-design")
        value = json.loads(record.read_text(encoding="utf-8"))
        value["topic"] = topic
        value["sources"][0]["title"] = "订货系统功能说明 <b>"
        record.write_text(json.dumps(value), encoding="utf-8")
        conclude(root, "luz-design", {"scope": "订货流程与价格规则", "findings": [
            {"source_id": "SRC-001", "summary": "价格按客户等级取值 <script>x</script>", "applies_to": "价格模块", "adopted": True},
            {"source_id": "SRC-001", "summary": "另一种做法", "applies_to": "候选比较", "adopted": False, "reason": "超出本期范围"}],
            "gaps": gaps if gaps is not None else ["信用账期的行业差异"]})
        return record, record.with_suffix(".html").read_text(encoding="utf-8")

    def test_page_is_a_formal_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            record, page = self.conclude_page(Path(tmp))
            body = page.split("<body>", 1)[1]
            self.assertTrue(body.startswith("<main><h1>B2B订货系统</h1><section><h2>检索结论</h2>"))
            self.assertEqual(re.findall(r"<caption>(表 \d+　[^<]+)</caption>", page), ["表 1　检索结论", "表 2　检索范围与路线", "表 3　未覆盖范围"])
            self.assertEqual(re.findall(r"<h2>([^<]+)</h2>", page), ["检索结论", "检索范围", "未覆盖范围"])
            self.assertNotIn("<script", page.replace("&lt;script&gt;", ""))
            self.assertIn("价格按客户等级取值 &lt;script&gt;x&lt;/script&gt;", page)
            self.assertIn("订货系统功能说明 &lt;b&gt;", page)
            self.assertIn("未采用，超出本期范围", page)
            self.assertIn("订货流程与价格规则", page)
            self.assertIn('<span class="src">example.org</span>', page)
            self.assertIn('rel="noopener noreferrer"', page)
            style = page.split("<style>", 1)[1].split("</style>", 1)[0]
            block = re.search(r"/\* luz-md-type:start.*?/\* luz-md-type:end \*/", style, re.S)
            self.assertIsNotNone(block)
            self.assertIn("--md-body: 16px", block.group(0))
            self.assertIn("--md-body: 18px", block.group(0))
            rest = style.replace(block.group(0), "")
            self.assertEqual(len(re.findall(r"font-family:", rest)), 1)
            self.assertIsNone(re.search(r"font:|font-size:|line-height:", rest))
            self.assertNotRegex(page, r"生成时间|采集日期|sha256|SHA-256|luz-design")
            self.assertEqual(validate_preflight(Path(tmp), "luz-design"), [])
            self.assertEqual(json.loads(record.read_text(encoding="utf-8"))["report_sha256"], digest(record.with_suffix(".html")))

    def test_empty_gaps_and_title_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, page = self.conclude_page(Path(tmp), topic="支付回调幂等", gaps=[])
            self.assertIn("本次声明的范围内暂无待补项", page)
        self.assertEqual(plain_title("一天的运转（以午餐为例）"), "一天的运转")
        self.assertEqual(plain_title("（仅括号）"), "（仅括号）")

    def test_editing_or_deleting_the_conclusion_page_fails_the_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            record, _ = self.conclude_page(root)
            page = record.with_suffix(".html")
            page.write_text(page.read_text(encoding="utf-8") + "<!-- edited -->", encoding="utf-8")
            self.assertTrue(any("检索结论 HTML" in e for e in validate_preflight(root, "luz-design")))
            page.unlink()
            self.assertTrue(any("检索结论 HTML" in e for e in validate_preflight(root, "luz-design")))
            conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "重新结论", "applies_to": "方案", "adopted": True}], "gaps": []})
            self.assertEqual(validate_preflight(root, "luz-design"), [])

    def test_stylesheet_is_shared_with_the_javascript_renderer(self):
        node_side = (Path(crawl_preflight.__file__).resolve().parents[1] / "lib" / "formal-html.mjs").read_text(encoding="utf-8")
        self.assertIn(crawl_preflight.ICON, node_side)
        self.assertIn(crawl_preflight.CSP, node_side)
        self.assertTrue(crawl_preflight.STYLE.is_file())


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
if (command === 'doctor') out(JSON.parse(process.env.FAKE_DOCTOR || '{"ready":false,"silent_ready":true}'));
if (command === 'begin') { const folder = path.join(option('--out'), '001_task'); fs.mkdirSync(path.join(folder, 'raw'), { recursive: true }); fs.writeFileSync(path.join(folder, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: args[0] })); out({ folder, title: args[0], status: 'ready' }); }
if (command === 'experience') out({ notes: [] });
if (command === 'search') { const folder = archive(option('--out'), 'hit', `https://example.org/${args[0]}/${calls.length}`); out({ status: 'partial', platform: args[0], query: args[1], sources: [{ status: 'captured', folder, url_check: { valid_content: true } }] }); }
if (command === 'capture') { const folder = archive(option('--out'), 'page', args[0]); out({ status: 'captured', folder, url_check: { requested: args[0], valid_content: true } }); }
if (command === 'summary') out({ file: 'summary.html' });
out({ error: 'unknown' }, 1);
"""


class RunFlowTests(unittest.TestCase):
    """The whole run -> conclude -> check chain against a scripted stand-in for the Crawl CLI."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "fake.mjs").write_text(FAKE_CLI, encoding="utf-8")
        self.saved = (crawl_preflight.CLI, crawl_preflight.DEFAULT_OUTPUT)
        crawl_preflight.CLI = self.root / "fake.mjs"
        crawl_preflight.DEFAULT_OUTPUT = str(self.root / "crawl-output")
        os.environ["FAKE_LOG"] = str(self.root / "calls.json")
        os.environ.pop("FAKE_DOCTOR", None)
        self.node = subprocess.run(["node", "--version"], capture_output=True).returncode == 0

    def tearDown(self):
        crawl_preflight.CLI, crawl_preflight.DEFAULT_OUTPUT = self.saved
        os.environ.pop("FAKE_DOCTOR", None)
        self.tmp.cleanup()

    def calls(self):
        return json.loads((self.root / "calls.json").read_text(encoding="utf-8"))

    def test_shared_task_stage_and_search_options(self):
        if not self.node:
            self.skipTest("node unavailable")
        first = run(self.root / "design", "luz-design", "界面信息密度", queries=["订货系统 界面"], platform="github", read_count=3, stage="design")
        self.assertEqual(first["status"], "needs-conclusion")
        search = [c for c in self.calls() if c[0] == "search"][0]
        self.assertEqual(search[1:5], ["github", "订货系统 界面", "--read", "3"])
        second = run(self.root / "dev", "luz-dev", "订单接口", task=Path(first["task"]), urls=["https://docs.example.com/api"], stage="technical-plan")
        self.assertEqual(second["task"], first["task"])
        self.assertEqual(len([c for c in self.calls() if c[0] == "begin"]), 1)
        for session, caller, stage in ((self.root / "design", "luz-design", "design"), (self.root / "dev", "luz-dev", "technical-plan")):
            self.assertTrue(validate_preflight(session, caller, stage))  # evidence alone is not completion
            conclude(session, caller, {"findings": [{"source_id": "SRC-001", "summary": "离线结论", "applies_to": "方案", "adopted": True}], "gaps": []}, stage)
            self.assertEqual(validate_preflight(session, caller, stage), [])
        self.assertTrue(validate_preflight(self.root / "dev", "luz-design", "design"))  # another session cannot borrow it

    def test_unready_environment_and_bad_read_count_are_blocked(self):
        if not self.node:
            self.skipTest("node unavailable")
        os.environ["FAKE_DOCTOR"] = '{"ready":false,"silent_ready":false}'
        with self.assertRaises(ValueError):
            run(self.root / "ops", "luz-ops", "监控方案")
        record = json.loads(record_path(self.root / "ops", "luz-ops").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "blocked")
        self.assertTrue(validate_preflight(self.root / "ops", "luz-ops"))
        with self.assertRaises(ValueError):
            run(self.root / "ops2", "luz-ops", "监控方案", read_count=9)

    def test_cli_help_lists_the_documented_options(self):
        result = subprocess.run([sys.executable, "-X", "utf8", str(Path(crawl_preflight.__file__)), "run", "--help"], capture_output=True, text=True, encoding="utf-8")
        for option in ("--session", "--caller", "--stage", "--topic", "--task", "--query", "--url", "--platform", "--read"):
            self.assertIn(option, result.stdout)


if __name__ == "__main__":
    unittest.main()
