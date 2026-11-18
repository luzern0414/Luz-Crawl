"""Evidence gates: a command succeeding is not the same as completed research."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import crawl_preflight
from crawl_preflight import digest, record_path, validate_preflight, conclude as real_conclude, now, plain_title, run


def evidence_dir(archive):
    """Where an archive keeps content.json and manifest.json: itself (task_folder_v2) or its raw/ child (older layout)."""
    archive = Path(archive)
    return archive if (archive / "manifest.json").is_file() else archive / "raw"


def _single_fixture(root, caller="luz-design", stage=None, source_url="https://example.org/doc", layout="v2", task_name="fixture-task", task_parent=None, source_urls=None):
    """layout "v2": <task>/raw/<archive>/content.json, marker <task>/raw/luz-task.json.
    layout "older": <task>/raw/<archive>/raw/content.json, marker <task>/luz-task.json (sibling_raw_v1).
    The task folder is <task_parent or root/raw>/<task_name>; the gate knows a task by its marker, so any name works
    (NNN-主题, the older NNN_主题, ...). The record, its logs and its pages sit where record_path(root, ...) says."""
    source_urls = source_urls or [source_url]
    source_url = source_urls[0]
    timestamp = now()
    label = f"{caller}-{stage or 'standalone'}"
    task = Path(task_parent or root / "raw") / task_name
    if layout == "v2":
        archive = task / "raw" / label
        raw = archive
        marker = task / "raw" / "luz-task.json"
        marker_value = {"kind": "task_archive", "schema_version": 1, "delivery_layout": "task_folder_v2"}
    else:
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
    path = record_path(root, caller, stage)
    logs = path.parent / "logs" / label
    logs.mkdir(parents=True, exist_ok=True)
    steps = []
    for name, result in [("doctor", {"ready": True}), ("experience", {}), ("capture", {"folder": str(archive), "status": "captured", "resolved_url": source_url, "url_check": {"requested": source_url, "valid_content": True}}), ("summary", {})]:
        p = logs / f"{name}.json"
        p.write_text(json.dumps(result), encoding="utf-8")
        args = [name, source_url, "--out", str(task)] if name == "capture" else [name]
        steps.append({"command": name, "args": args, "exit_code": 0, "file": str(p), "sha256": digest(p)})
    record = {"schema_version": 1, "caller": caller, "stage": stage, "topic": "test", "started_at": timestamp, "finished_at": now(), "task_root": str(task), "status": "captured", "steps": steps, "sources": [{"id": "SRC-001", "archive": str(archive), "manifest_sha256": digest(manifest), "url": source_url, "captured_at": timestamp}], "findings": [], "gaps": []}
    for number, url in enumerate(source_urls[1:], 2):
        extra = archive.with_name(f"{label}-{number:03d}")
        extra_raw = extra if layout == "v2" else extra / "raw"
        (extra_raw / "snapshots").mkdir(parents=True, exist_ok=True)
        extra_snapshot = extra_raw / "snapshots" / "0000.json"
        extra_snapshot.write_text(json.dumps({"text": f"Actual browser body {number}"}), encoding="utf-8")
        extra_content = extra_raw / "content.json"
        extra_content.write_text(json.dumps({"status": "captured", "captured_at": timestamp, "resolved_url": url, "text": f"Actual document body {number}", "url_check": {"valid_content": True}, "completeness": {"scope": "rendered_body_and_loaded_items"}}), encoding="utf-8")
        extra_manifest = extra_raw / "manifest.json"
        extra_manifest.write_text(json.dumps({"status": "captured", "files": [{"path": str(p.relative_to(extra)), "sha256": digest(p)} for p in (extra_content, extra_snapshot)]}), encoding="utf-8")
        log = logs / f"capture-{number:03d}.json"
        log.write_text(json.dumps({"folder": str(extra), "status": "captured", "resolved_url": url, "url_check": {"requested": url, "valid_content": True}}), encoding="utf-8")
        steps.insert(-1, {"command": "capture", "args": ["capture", url, "--out", str(task)], "exit_code": 0, "file": str(log), "sha256": digest(log)})
        record["sources"].append({"id": f"SRC-{number:03d}", "archive": str(extra), "manifest_sha256": digest(extra_manifest), "url": url, "captured_at": timestamp})
    record["finished_at"] = now()
    path.write_text(json.dumps(record), encoding="utf-8")
    return path, record, snapshot


def fixture(root, caller="luz-design", stage=None, **options):
    from test_evidence_policy import broad_fixture
    return broad_fixture(root, caller, stage, **options)


def conclude(root, caller, payload, stage=None):
    from test_evidence_policy import payload_for
    value = json.loads(record_path(root, caller, stage).read_text(encoding="utf-8"))
    payload = payload_for(value, payload)
    write_review_fixture(record_path(root, caller, stage), value, payload)
    return real_conclude(root, caller, payload, stage)


def write_review_fixture(path, value, payload=None):
    """Synthetic handoff for offline integration tests, never live research evidence."""
    if not value.get('candidate_inventory'):
        return
    inventory = crawl_preflight.read(path.parent / value['candidate_inventory'])
    if payload is None:
        from test_evidence_policy import payload_for
        payload = payload_for(value)
    from research_inventory import candidate_url
    adopted = {f['source_id'] for f in payload['findings'] if f.get('adopted') is True}
    bodies = {candidate_url(s['url']): s['id'] for s in value['sources']}
    queries = list(dict.fromkeys(s['args'][2] for s in value['steps'] if s['command'] == 'search' and s.get('exit_code') == 0))
    review = {key: value[key] for key in ('caller', 'stage', 'task_root', 'candidate_inventory_sha256')}
    review.update(
        questions=[{'id': 'OFFLINE-Q', 'question': 'Offline evidence handling', 'importance': 'required'}],
        query_groups=[{'purpose': f'Offline fixture direction {i}', 'queries': [q]} for i, q in enumerate(queries)],
        candidate_reviews=[{'url': c['url'], 'category': 'unknown', 'question_ids': ['OFFLINE-Q'],
                            'status': ('read-adopted' if bodies[c['url']] in adopted else 'read-not-adopted') if c['url'] in bodies else 'unread',
                            'priority': 'low', 'reason': 'Synthetic fixture; not an actual reviewed source'} for c in inventory['candidates']],
        rounds=[{'logs': [s['file'] for s in value['steps']], 'observation': 'Offline execution fixture', 'next_action': 'Validate gate'}],
        experience_reuse=[{'status': 'no-hit', 'log': 'offline-experience', 'impact': 'Exercise record shape only'}],
        experience_updates=[{'key': 'offline-note', 'category': 'method', 'outcome': 'unverified', 'evidence': ['offline-fixture'], 'recall_log': 'offline-recall'}],
        stop={'reason': 'sufficient', 'basis': 'Offline fixture only; does not establish live diligence', 'remaining': []})
    crawl_preflight.write(path.with_name(path.stem + '-research-review.json'), review)


def broad_routes(queries=None, urls=None):
    queries = list(queries or [])
    queries += [f"offline coverage {i}" for i in range(5 - len(queries))]
    urls = list(urls or [])
    urls += [f"https://publisher{i % 3}.example/offline-{i}" for i in range(5 - len(urls))]
    return {"queries": queries, "urls": urls}


def complete_fixture(root, caller, stage=None, *, source_urls=None):
    """Offline fixture for integration tests; never a user approval or live search."""
    _, record, _ = fixture(root, caller, stage, source_urls=source_urls)
    return conclude(root, caller, {"findings": [{"source_id": source["id"], "summary": "离线夹具中的补充信息", "applies_to": "测试场景的方案输入", "adopted": True} for source in record["sources"]], "gaps": []}, stage)


class CaptureRootUrlTests(unittest.TestCase):
    def test_browser_added_root_slash_keeps_captured_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            task = Path(directory).resolve()
            archive = task / "raw" / "page"
            step = {"command": "capture", "args": ["capture", "https://example.org", "--out", str(task)]}
            result = {"status": "captured", "folder": str(archive),
                      "url_check": {"requested": "https://example.org/", "valid_content": True}}
            self.assertEqual(crawl_preflight._observed_sources(step, result, task), [str(archive)])

    def test_other_document_identities_remain_distinct(self):
        pairs = [("https://example.org/doc", "https://example.org/doc/"),
                 ("https://example.org/?q=a", "https://example.org/?q=b"),
                 ("https://example.org/#/a", "https://example.org/#/b"),
                 ("https://example.org/#!/a", "https://example.org/#!/b"),
                 ("https://example.org/", "https://other.example.org/")]
        for left, right in pairs:
            with self.subTest(left=left, right=right):
                self.assertNotEqual(crawl_preflight._document_url(left), crawl_preflight._document_url(right))


class SourceBodyGuardTests(unittest.TestCase):
    def errors_for(self, root, title, body):
        _, value, _ = _single_fixture(root)
        source = value['sources'][0]
        archive = Path(source['archive'])
        content_path = evidence_dir(archive) / 'content.json'
        content = json.loads(content_path.read_text(encoding='utf-8'))
        content.update(title=title, text=body)
        content_path.write_text(json.dumps(content), encoding='utf-8')
        manifest_path = evidence_dir(archive) / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        for item in manifest['files']:
            item['sha256'] = digest(archive / item['path'])
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        source['manifest_sha256'] = digest(manifest_path)
        return crawl_preflight.source_errors(source, value['task_root'])

    def test_not_found_title_cannot_count_as_a_document(self):
        for title in ('Not Found', 'Not Found - docs', 'Page Not Found'):
            with self.subTest(title=title), tempfile.TemporaryDirectory() as tmp:
                errors = self.errors_for(Path(tmp), title, 'The requested documentation page is unavailable.')
                self.assertTrue(any('错误页面' in error for error in errors), errors)

    def test_short_navigation_with_whitespace_is_not_quotable_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            errors = self.errors_for(Path(tmp), 'Documentation', ' 12345 \n 67890 \t 1 ')
            self.assertTrue(any('有效逐字摘录' in error for error in errors), errors)

    def test_twelve_nonspace_characters_are_eligible_for_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.errors_for(Path(tmp), 'Documentation', ' 123456 \n 789012 '), [])


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


class TaskNameTests(unittest.TestCase):
    """The gate knows a Crawl task by its marker, never by its folder name: the current NNN-主题 and the older NNN_主题 both pass."""

    def test_current_and_older_task_names_pass(self):
        for name in ("117-B2B订货系统前置检索", "076_差旅费报销单据要素与审核要点", "fixture-task"):
            for layout in ("v2", "older"):
                with self.subTest(name=name, layout=layout), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    _, value, _ = fixture(root, layout=layout, task_name=name)
                    self.assertEqual(Path(value["task_root"]).name, name)
                    conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "任务目录名不同的结论", "applies_to": "方案", "adopted": True}], "gaps": []})
                    self.assertEqual(validate_preflight(root, "luz-design"), [])


class MovedEvidenceFolderTests(unittest.TestCase):
    """A record names its logs by absolute path; after the evidence folder moved they are read from the same place below the new 00-crawl."""

    def test_log_path_is_rebased_below_the_current_evidence_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            now_here = Path(tmp) / "state" / "00-crawl"
            (now_here / "logs").mkdir(parents=True)
            moved = now_here / "logs" / "01-doctor.json"
            moved.write_text("{}", encoding="utf-8")
            old_place = Path(tmp) / "old-project" / "raw" / "00-crawl" / "logs" / "01-doctor.json"
            self.assertEqual(crawl_preflight._log_inside(old_place, now_here), moved.resolve())

    def test_path_without_an_evidence_folder_is_still_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            now_here = Path(tmp) / "state" / "00-crawl"
            now_here.mkdir(parents=True)
            with self.assertRaises(ValueError):
                crawl_preflight._log_inside(Path(tmp) / "elsewhere" / "logs" / "01-doctor.json", now_here)


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

    def test_the_expiry_finding_keeps_the_phrase_luz_project_waives_for_an_approved_stage(self):
        """Luz-Project drops exactly this finding for a stage whose files the user approved (crawl_gate.crawl_errors(waive_expiry=True)); the other findings stay."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p, value, _ = fixture(root)
            conclude(root, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "尺寸由容器和内容决定", "applies_to": "响应式布局方案", "adopted": True}], "gaps": []})
            self.assertEqual(validate_preflight(root, "luz-design"), [])
            value = json.loads(p.read_text(encoding="utf-8"))
            old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat(timespec="microseconds").replace("+00:00", "Z")
            value["started_at"] = value["finished_at"] = old
            p.write_text(json.dumps(value), encoding="utf-8")
            expired = [e for e in validate_preflight(root, "luz-design") if "超过七天" in e]
            self.assertEqual(len(expired), 1)
            self.assertIn("检索记录超过七天", expired[0])

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
            self.assertTrue(body.lstrip().startswith("<main>\n<h1>B2B订货系统</h1><section><h2>检索结论</h2>"))
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

    def test_page_follows_the_summary_page_standard(self):
        """lang zh-CN, the h1 the first heading and the only one, zoom not disabled, and the Markdown type block is the shared one byte for byte."""
        import make_summary
        with tempfile.TemporaryDirectory() as tmp:
            _, page = self.conclude_page(Path(tmp))
        self.assertIn('<html lang="zh-CN">', page)
        self.assertEqual(re.search(r"<h([1-6])\b", page).group(1), "1")
        self.assertEqual(len(re.findall(r"<h1\b", page)), 1)
        self.assertIsNone(re.search(r"user-scalable\s*=\s*no|maximum-scale", page, re.I))
        self.assertIn('rel="icon"', page)
        self.assertEqual(len(re.findall(r"<h2>", page)), len(re.findall(r"<table>", page)))     # one captioned table per section
        self.assertEqual(re.search(r"/\* luz-md-type:start.*?/\* luz-md-type:end \*/", page, re.S).group(0), make_summary.MD_TYPE)

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
if (command === 'begin') { const folder = path.join(option('--out'), '001-task'); fs.mkdirSync(path.join(folder, 'raw'), { recursive: true }); fs.writeFileSync(path.join(folder, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: args[0] })); out({ folder, title: args[0], status: 'ready' }); }
if (command === 'experience') out({ notes: [] });
if (command === 'search') { const folder = archive(option('--out'), 'hit', `https://example.org/${args[0]}/${calls.length}`); out({ status: 'partial', search_performed: true, platform: args[0], query: args[1], sources: [{ status: 'captured', folder, url_check: { valid_content: true } }] }); }
if (command === 'capture' && process.env.FAKE_FAIL && args[0].includes(process.env.FAKE_FAIL)) out({ status: 'failed', stop_reason: 'rate_limited', url_check: { requested: args[0], valid_content: false } }, 1);
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
        first = run(self.root / "design", "luz-design", "界面信息密度", **broad_routes(["订货系统 界面"]), platform="github", read_count=3, stage="design")
        self.assertEqual(first["status"], "needs-conclusion")
        search = [c for c in self.calls() if c[0] == "search"][0]
        self.assertEqual(search[1:5], ["github", "订货系统 界面", "--read", "3"])
        second = run(self.root / "dev", "luz-dev", "订单接口", task=Path(first["task"]), **broad_routes(urls=["https://docs.example.com/api"]), stage="technical-plan")
        self.assertEqual(second["task"], first["task"])
        self.assertEqual(len([c for c in self.calls() if c[0] == "begin"]), 1)
        for session, caller, stage in ((self.root / "design", "luz-design", "design"), (self.root / "dev", "luz-dev", "technical-plan")):
            self.assertTrue(validate_preflight(session, caller, stage))  # evidence alone is not completion
            conclude(session, caller, {"findings": [{"source_id": "SRC-001", "summary": "离线结论", "applies_to": "方案", "adopted": True}], "gaps": []}, stage)
            self.assertEqual(validate_preflight(session, caller, stage), [])
        self.assertTrue(validate_preflight(self.root / "dev", "luz-design", "design"))  # another session cannot borrow it

    def test_a_failing_route_does_not_stop_the_run_while_another_brings_the_body(self):
        if not self.node:
            self.skipTest("node unavailable")
        os.environ["FAKE_FAIL"] = "limited.example"
        try:
            routes = broad_routes(urls=["https://docs.example.com/page"])
            routes["urls"].insert(0, "https://limited.example/data.json")
            value = run(self.root / "p", "luz-crawl", "来源取不到", **routes, stage="research")
            self.assertEqual(value["status"], "needs-conclusion")
            self.assertIn("https://docs.example.com/page", [s["url"] for s in value["sources"]])
            self.assertNotIn("https://limited.example/data.json", [s["url"] for s in value["sources"]])
            record = json.loads(record_path(self.root / "p", "luz-crawl", "research").read_text(encoding="utf-8"))
            captures = [s for s in record["steps"] if s["command"] == "capture"]
            self.assertEqual([s["exit_code"] for s in captures], [1, 0, 0, 0, 0, 0])  # failed route stays recorded
            conclude(self.root / "p", "luz-crawl", {"findings": [{"source_id": "SRC-001", "summary": "离线结论", "applies_to": "调研", "adopted": True}], "gaps": ["第一个网址没有读到"]}, "research")
            self.assertEqual(validate_preflight(self.root / "p", "luz-crawl", "research"), [])
            with self.assertRaises(ValueError):                                      # when every route fails there is nothing to conclude from
                run(self.root / "q", "luz-crawl", "全部取不到", urls=["https://limited.example/a", "https://limited.example/b"], stage="research")
            blocked = json.loads(record_path(self.root / "q", "luz-crawl", "research").read_text(encoding="utf-8"))
            self.assertEqual(blocked["status"], "blocked")
        finally:
            os.environ.pop("FAKE_FAIL", None)

    def test_unready_environment_and_bad_read_count_are_blocked(self):
        if not self.node:
            self.skipTest("node unavailable")
        os.environ["FAKE_DOCTOR"] = '{"ready":false,"silent_ready":false}'
        with self.assertRaises(ValueError):
            run(self.root / "ops", "luz-ops", "监控方案", research="search")
        record = json.loads(record_path(self.root / "ops", "luz-ops").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "blocked")
        self.assertTrue(validate_preflight(self.root / "ops", "luz-ops"))
        with self.assertRaises(ValueError):
            run(self.root / "ops2", "luz-ops", "监控方案", read_count=9)

    def test_cli_help_lists_the_documented_options(self):
        result = subprocess.run([sys.executable, "-X", "utf8", str(Path(crawl_preflight.__file__)), "run", "--help"], capture_output=True, text=True, encoding="utf-8")
        for option in ("--session", "--caller", "--stage", "--topic", "--task", "--query", "--url", "--platform", "--read"):
            self.assertIn(option, result.stdout)


class ProjectModeTests(unittest.TestCase):
    """A project keeps no crawled content: its task is in the Crawl output root, its records are in the state root's 00-crawl."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.saved = (crawl_preflight.CLI, crawl_preflight.DEFAULT_OUTPUT, crawl_preflight.PROJECT_OUTPUT)
        crawl_preflight.DEFAULT_OUTPUT = str(self.root / "skill-output" / "Luz-Crawl")
        crawl_preflight.PROJECT_OUTPUT = str(self.root / "skill-output" / "Luz-Project")
        self.crawl_output = Path(crawl_preflight.DEFAULT_OUTPUT)
        self.projects = self.root / "Codes"                                   # where project directories live (outside the state roots)

    def tearDown(self):
        crawl_preflight.CLI, crawl_preflight.DEFAULT_OUTPUT, crawl_preflight.PROJECT_OUTPUT = self.saved
        os.environ.pop("FAKE_LOG", None)
        self.tmp.cleanup()

    def new_project(self, name="014-Demo", crawl=None):
        """A project directory with results only, and its state root <PROJECT_OUTPUT>/<name>/raw holding project.json."""
        project = self.projects / name
        (project / "docs" / "01-需求对接").mkdir(parents=True)
        state = Path(crawl_preflight.PROJECT_OUTPUT) / name / "raw"
        state.mkdir(parents=True)
        (state / "project.json").write_text(json.dumps({"name": name, "crawl": {"task_id": None, "task_root": None, "evidence_index": "00-crawl", "reuse_policy": "reuse-within-project", **(crawl or {})}}), encoding="utf-8")
        return project, state

    def test_a_path_resolves_to_the_state_root_by_project_json_or_by_the_project_directory_name(self):
        project, state = self.new_project()
        self.assertEqual(crawl_preflight.state_root(state), state)                                 # holds project.json
        self.assertEqual(crawl_preflight.state_root(project), state)                               # project directory -> <PROJECT_OUTPUT>/<name>/raw
        self.assertEqual(crawl_preflight.state_root(state.parent), state)                          # the Luz-Project session directory of the project
        self.assertIsNone(crawl_preflight.state_root(self.projects / "015-Other"))                 # no such project: a plain skill session
        legacy = self.projects / "009-Legacy"                                                      # a project root from before the split holds project.json itself
        legacy.mkdir()
        (legacy / "project.json").write_text("{}", encoding="utf-8")
        self.assertEqual(crawl_preflight.state_root(legacy), legacy)

    def test_records_and_pages_go_to_the_state_root_whichever_way_the_project_is_named(self):
        project, state = self.new_project()
        task_parent = self.crawl_output
        for target, caller, stage in ((state, "luz-project", "requirements"), (project, "luz-system", "architecture")):
            path, value, _ = fixture(target, caller, stage, task_parent=task_parent, task_name="117-B2B订货系统")
            self.assertEqual(path, (state / "00-crawl" / f"{caller}-{stage}.json").resolve())
            self.assertEqual(Path(value["task_root"]).parent, task_parent)
            conclude(target, caller, {"findings": [{"source_id": "SRC-001", "summary": "项目阶段的结论", "applies_to": "阶段方案", "adopted": True}], "gaps": []}, stage)
            self.assertTrue(path.with_suffix(".html").is_file())
            for session in (state, project):                                                       # both spellings reach the same records
                self.assertEqual(validate_preflight(session, caller, stage), [])
        self.assertEqual(sorted(p.name for p in state.iterdir()), ["00-crawl", "00-design", "project.json"])  # template snapshots are process evidence, too
        self.assertEqual([p.name for p in project.iterdir()], ["docs"])                            # the project directory gets nothing
        self.assertEqual([p.name for p in self.crawl_output.iterdir()], ["117-B2B订货系统"])
        self.assertEqual(crawl_preflight.evidence_dir(project), (state / "00-crawl").resolve())

    def test_a_project_from_before_the_split_keeps_writing_to_raw_00_crawl(self):
        for index in ("raw/00-crawl", None, "raw/crawl/evidence.json"):                             # the index, none, or the old placeholder file
            with self.subTest(index=index), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "raw").mkdir()
                crawl = {"task_root": None} if index is None else {"task_root": None, "evidence_index": index}
                (root / "project.json").write_text(json.dumps({"crawl": crawl}), encoding="utf-8")
                path, _, _ = fixture(root, "luz-dev", "technical-plan")
                self.assertEqual(path, (root / "raw" / "00-crawl" / "luz-dev-technical-plan.json").resolve())
                conclude(root, "luz-dev", {"findings": [{"source_id": "SRC-001", "summary": "旧项目的结论", "applies_to": "方案", "adopted": True}], "gaps": []}, "technical-plan")
                self.assertEqual(validate_preflight(root, "luz-dev", "technical-plan"), [])

    def test_a_skill_session_and_an_unusable_evidence_index(self):
        session = self.root / "skill-output" / "Luz-Dev" / "003-订单接口方案"
        self.assertEqual(crawl_preflight.evidence_dir(session), (session / "raw" / "00-crawl").resolve())
        for number, bad in enumerate(("../outside", str(self.root / "elsewhere"), ".", "a/../../b"), start=20):
            with self.subTest(index=bad):
                _, state = self.new_project(f"0{number}-Bad", crawl={"evidence_index": bad})
                with self.assertRaises(ValueError):
                    record_path(state, "luz-ops")

    def test_run_in_a_project_uses_its_crawl_task_and_leaves_no_raw_content_in_it(self):
        if subprocess.run(["node", "--version"], capture_output=True).returncode != 0:
            self.skipTest("node unavailable")
        (self.root / "fake.mjs").write_text(FAKE_CLI, encoding="utf-8")
        crawl_preflight.CLI = self.root / "fake.mjs"
        os.environ["FAKE_LOG"] = str(self.root / "calls.json")
        task = self.crawl_output / "117-B2B订货系统"
        (task / "raw").mkdir(parents=True)
        (task / "raw" / "luz-task.json").write_text(json.dumps({"schema_version": 1, "kind": "task_archive", "delivery_layout": "task_folder_v2", "title": "B2B订货系统"}), encoding="utf-8")
        project, state = self.new_project(crawl={"task_root": str(task)})
        value = run(project, "luz-project", "行业范围", **broad_routes(["订货系统"]), stage="requirements")  # project directory is enough
        self.assertEqual(value["task"], str(task.resolve()))
        self.assertEqual(Path(value["record"]), (state / "00-crawl" / "luz-project-requirements.json").resolve())
        calls = json.loads((self.root / "calls.json").read_text(encoding="utf-8"))
        self.assertNotIn("begin", [c[0] for c in calls])                                           # the project's own task is reused, none is begun
        self.assertEqual([p.name for p in project.iterdir()], ["docs"])
        self.assertEqual(sorted(p.name for p in state.iterdir()), ["00-crawl", "project.json"])
        self.assertTrue(any(p.parent.parent == task / "raw" for p in task.glob("raw/*/content.json")))   # the pages are in the Crawl task
        conclude(state, "luz-project", {"findings": [{"source_id": "SRC-001", "summary": "项目阶段结论", "applies_to": "需求", "adopted": True}], "gaps": []}, "requirements")
        self.assertEqual(validate_preflight(state, "luz-project", "requirements"), [])


if __name__ == "__main__":
    unittest.main()
