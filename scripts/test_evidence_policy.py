"""Offline policy tests. Synthetic pages are test inputs, never live research evidence."""
import copy
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import crawl_preflight as crawl
from test_crawl_preflight import _single_fixture as fixture


def template_ref(identifier="reading-html", target="raw/report.html"):
    design = Path(__file__).resolve().parents[2] / "Luz-Design"
    file = design / "scripts" / "make_summary.py"
    return {"id": identifier, "applies_to": target,
            "files": [{"path": "scripts/make_summary.py", "sha256": crawl.digest(file)}]}


def broad_fixture(root, caller="luz-design", stage=None, source_urls=None, **options):
    urls = list(source_urls or [])
    if not urls:
        urls.append(options.get("source_url", "https://example.org/doc"))
    for number in range(10 - len(urls)):
        urls.append(f"https://publisher{number % 3}.example/document-{number}")
    path, value, snapshot = fixture(root, caller, stage, source_urls=urls, **options)
    logs = path.parent / "logs" / f"policy-{caller}-{stage or 'standalone'}"
    logs.mkdir(parents=True, exist_ok=True)
    for number in range(5):
        query = f"offline question {number}"
        log = logs / f"search-{number}.json"
        log.write_text(json.dumps({"status": "captured", "platform": "bing", "query": query, "sources": []}), encoding="utf-8")
        value["steps"].insert(-1, {"command": "search", "args": ["search", "bing", query, "--out", value["task_root"]],
                                  "exit_code": 0, "file": str(log), "sha256": crawl.digest(log)})
    value["schema_version"] = 2
    crawl.write(path, value)
    return path, value, snapshot


def payload_for(value, initial=None):
    """Fill evidence fields for offline integration fixtures; never changes real records."""
    payload = copy.deepcopy(initial) if initial is not None else {"findings": [], "gaps": []}
    if not isinstance(payload, dict) or not isinstance(payload.get("findings"), list):
        return payload
    sources = {s["id"]: s for s in value["sources"]}
    for number, finding in enumerate(payload["findings"], 1):
        if not isinstance(finding, dict) or finding.get("source_id") not in sources:
            continue
        content = crawl.read(crawl.archive_dir(sources[finding["source_id"]]["archive"]) / "content.json")
        finding.setdefault("id", f"F-{number:03d}")
        finding.setdefault("quote", content["text"])
        finding.setdefault("locator", "offline fixture body")
        finding.setdefault("kind", "fact")
    described = {f.get("source_id") for f in payload["findings"] if isinstance(f, dict)}
    for source in value["sources"]:
        if source["id"] in described:
            continue
        body = crawl.read(crawl.archive_dir(source["archive"]) / "content.json")["text"]
        payload["findings"].append({"id": f'F-{len(payload["findings"]) + 1:03d}', "source_id": source["id"],
                                    "quote": body, "locator": "offline fixture body", "kind": "reference",
                                    "summary": "离线测试正文", "applies_to": "raw/report.html",
                                    "adopted": initial is None, "reason": "离线测试的补充候选"})
    from evidence_policy import site_key
    payload.setdefault("source_reviews", [{"source_id": source["id"], "publisher": site_key(source["url"]),
                                           "authority": "primary", "reason": "明确标记为离线测试夹具"}
                                          for i, source in enumerate(value["sources"])])
    adopted = [f["id"] for f in payload["findings"] if isinstance(f, dict) and f.get("adopted") is True and "id" in f]
    payload.setdefault("coverage", [{"question_id": "OFFLINE-Q", "question": "offline requirement", "applies_to": "raw/report.html", "finding_ids": adopted}])
    payload.setdefault("blocking_gaps", [])
    payload.setdefault("template_uses", [template_ref()])
    return payload


class EvidencePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path, self.value, _ = broad_fixture(self.root)
        self.payload = payload_for(self.value)

    def tearDown(self):
        self.tmp.cleanup()

    def refused(self, payload=None):
        with self.assertRaises(ValueError):
            crawl.conclude(self.root, "luz-design", self.payload if payload is None else payload)
        self.assertNotEqual(crawl.read(self.path).get("status"), "complete")

    def test_a_single_body_and_one_adoption_cannot_pass(self):
        single = self.root / "single"
        fixture(single)
        with self.assertRaises(ValueError):
            crawl.conclude(single, "luz-design", {"findings": [{"source_id": "SRC-001", "summary": "thin",
                "applies_to": "report", "adopted": True}], "gaps": []})

    def test_unobserved_quote_cannot_pass_even_with_many_sources(self):
        self.payload["findings"][0]["quote"] = "This quotation is fabricated and absent from the actual captured page."
        self.refused()

    def test_every_finding_needs_a_real_excerpt_and_locator(self):
        for key in ("quote", "locator"):
            payload = copy.deepcopy(self.payload)
            payload["findings"][0].pop(key)
            self.refused(payload)

    def test_uncovered_decision_blocks_completion(self):
        self.payload["coverage"][0]["finding_ids"] = ["F-missing"]
        self.refused()

    def test_blocking_gap_cannot_be_hidden_by_sufficient_counts(self):
        self.payload["blocking_gaps"] = ["关键需求尚无来源"]
        self.refused()

    def test_no_template_or_an_unregistered_path_is_rejected(self):
        for replacement in ([], [{"id": "invented", "applies_to": "report", "files": []}],
                            [{**template_ref(), "files": [{"path": "../Luz-Crawl/SKILL.md", "sha256": "0" * 64}]}]):
            payload = copy.deepcopy(self.payload)
            payload["template_uses"] = replacement
            self.refused(payload)

    def test_declared_template_hash_is_verified(self):
        self.payload["template_uses"][0]["files"][0]["sha256"] = "0" * 64
        self.refused()

    def test_all_sources_must_be_assessed_and_three_publishers_are_needed(self):
        for reviews in (self.payload["source_reviews"][:1],
                        [{**review, "publisher": "same publisher"} for review in self.payload["source_reviews"]],
                        [{**review, "authority": "secondary"} for review in self.payload["source_reviews"]]):
            payload = copy.deepcopy(self.payload)
            payload["source_reviews"] = reviews
            self.refused(payload)

    def test_duplicate_queries_do_not_satisfy_breadth(self):
        for step in self.value["steps"]:
            if step["command"] == "search":
                step["args"][2] = "same query"
                crawl.write(step["file"], {"status": "captured", "platform": "bing", "query": "same query", "sources": []})
                step["sha256"] = crawl.digest(step["file"])
        crawl.write(self.path, self.value)
        self.refused()

    def test_repeated_body_at_different_urls_does_not_count_as_more_evidence(self):
        for source in self.value["sources"]:
            archive = Path(source["archive"])
            content = crawl.archive_dir(archive) / "content.json"
            body = crawl.read(content)
            body["text"] = "Identical copied document body for every mirror."
            crawl.write(content, body)
            manifest = content.parent / "manifest.json"
            record = crawl.read(manifest)
            for file in record["files"]:
                if file["path"].replace("\\", "/") == "content.json":
                    file["sha256"] = crawl.digest(content)
            crawl.write(manifest, record)
            source["manifest_sha256"] = crawl.digest(manifest)
        crawl.write(self.path, self.value)
        self.payload = payload_for(self.value)
        self.refused()

    def test_valid_evidence_completes_and_check_revalidates_it(self):
        crawl.conclude(self.root, "luz-design", self.payload)
        self.assertEqual(crawl.validate_preflight(self.root, "luz-design"), [])
        value = crawl.read(self.path)
        value["template_uses"][0]["files"][0]["sha256"] = "0" * 64
        crawl.write(self.path, value)
        self.assertTrue(crawl.validate_preflight(self.root, "luz-design"))

    def test_summary_must_follow_every_search_or_capture(self):
        summary = self.value["steps"].pop()
        self.assertEqual(summary["command"], "summary")
        self.value["steps"].insert(0, summary)
        crawl.write(self.path, self.value)
        with self.assertRaisesRegex(ValueError, "顺序"):
            crawl.conclude(self.root, "luz-design", self.payload)

    def test_standalone_builders_can_bind_an_explicit_stage_via_environment(self):
        stage = "technical-plan"
        path = crawl.record_path(self.root, "luz-design", stage)
        self.value["stage"] = stage
        crawl.write(path, self.value)
        self.path.unlink()
        with patch.dict("os.environ", {"LUZ_CRAWL_STAGE": stage}):
            crawl.conclude(self.root, "luz-design", self.payload)
            self.assertEqual(crawl.validate_preflight(self.root, "luz-design"), [])
            self.assertTrue(crawl.validate_preflight(self.root, "luz-design", "implementation"))

    def test_migrated_archive_paths_use_the_shared_resolver(self):
        mapping = {}
        for number, source in enumerate(self.value["sources"]):
            old = self.root / "old-layout" / str(number)
            mapping[str(old)] = Path(source["archive"])
            source["archive"] = str(old)
        crawl.write(self.path, self.value)
        with patch.object(crawl, "canon", side_effect=lambda path: mapping.get(str(path), Path(path))):
            crawl.conclude(self.root, "luz-design", self.payload)
            self.assertEqual(crawl.validate_preflight(self.root, "luz-design"), [])

    def test_append_invalidates_before_doctor_and_locks_the_stage(self):
        crawl.conclude(self.root, "luz-design", self.payload)

        def doctor(*args, **kwargs):
            current = crawl.read(self.path)
            self.assertEqual(current["status"], "running")
            self.assertEqual(current["findings"], [])
            self.assertNotIn("report_sha256", current)
            self.assertTrue(crawl.validate_preflight(self.root, "luz-design"))
            with self.assertRaisesRegex(ValueError, "正在"):
                crawl.run(self.root, "luz-design", self.value["topic"], append=True)
            with self.assertRaisesRegex(ValueError, "正在"):
                crawl.conclude(self.root, "luz-design", self.payload)
            raise ValueError("offline doctor stop")

        with patch.object(crawl.subprocess, "run", side_effect=doctor):
            with self.assertRaisesRegex(ValueError, "offline doctor stop"):
                crawl.run(self.root, "luz-design", self.value["topic"], append=True)
        self.assertFalse(self.path.with_suffix(".lock").exists())

    def test_missing_policy_fields_cannot_be_downgraded_to_legacy(self):
        crawl.conclude(self.root, "luz-design", self.payload)
        value = crawl.read(self.path)
        value["schema_version"] = 1
        for key in ("source_reviews", "coverage", "template_uses"):
            value.pop(key, None)
        crawl.write(self.path, value)
        self.assertTrue(crawl.validate_preflight(self.root, "luz-design"))

    def test_malformed_evidence_fields_are_reported_without_a_traceback(self):
        for key, replacement in (("id", []), ("quote", {}), ("locator", [])):
            payload = copy.deepcopy(self.payload)
            payload["findings"][0][key] = replacement
            self.refused(payload)

    def test_known_duplicate_or_unusable_sources_do_not_count(self):
        for review in self.payload["source_reviews"]:
            review["exclude_from_count"] = True
        self.refused()

    def test_404_title_is_rejected_even_when_the_page_contains_navigation_text(self):
        source = self.value["sources"][0]
        archive = Path(source["archive"])
        content = archive / "content.json"
        value = crawl.read(content)
        value["title"] = "404 | Page not found | Navigation and sign-in"
        crawl.write(content, value)
        manifest = archive / "manifest.json"
        data = crawl.read(manifest)
        for entry in data["files"]:
            if entry["path"].replace("\\", "/") == "content.json":
                entry["sha256"] = crawl.digest(content)
        crawl.write(manifest, data)
        source["manifest_sha256"] = crawl.digest(manifest)
        self.assertTrue(any("错误页面" in e for e in crawl.source_errors(source, Path(self.value["task_root"]))))


class AppendResearchTests(unittest.TestCase):
    def test_append_preserves_logs_and_requires_a_new_conclusion(self):
        from test_crawl_preflight import FAKE_CLI, broad_routes, write_review_fixture
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "fake.mjs"
            fake.write_text(FAKE_CLI, encoding="utf-8")
            with patch.object(crawl, "CLI", fake), patch.dict("os.environ", {"FAKE_LOG": str(root / "calls.json"), "LUZ_CRAWL_OUTPUT": str(root / "output")}):
                with patch.object(crawl, "DEFAULT_OUTPUT", str(root / "output")):
                    first = crawl.run(root / "session", "luz-crawl", "offline append", queries=["first query"])
                    self.assertEqual(first["status"], "needs-research")
                    path = Path(first["record"])
                    before = crawl.read(path)
                    result = crawl.run(root / "session", "luz-crawl", "offline append", append=True, **broad_routes())
                    self.assertEqual(result["status"], "needs-conclusion")
                    value = crawl.read(path)
                    self.assertEqual(value["steps"][:len(before["steps"])], before["steps"])
                    self.assertEqual(value["started_at"], before["started_at"])
                    write_review_fixture(path, value)
                    crawl.conclude(root / "session", "luz-crawl", payload_for(value))
                    self.assertEqual(crawl.validate_preflight(root / "session", "luz-crawl"), [])
                    review_path = path.with_name(path.stem + '-research-review.json')
                    review = crawl.read(review_path)
                    review['stop']['basis'] = 'Changed after conclusion'
                    crawl.write(review_path, review)
                    self.assertTrue(any('尽责复盘' in e and '哈希' in e for e in crawl.validate_preflight(root / "session", "luz-crawl")))
                    crawl.run(root / "session", "luz-crawl", "offline append", append=True, queries=["new question"])
                    self.assertTrue(crawl.validate_preflight(root / "session", "luz-crawl"))
                    with self.assertRaises(ValueError):
                        crawl.run(root / "session", "luz-crawl", "different topic", append=True)


class HostedPublisherTests(unittest.TestCase):
    def test_hosted_repositories_are_grouped_by_owner_not_hosting_provider(self):
        from evidence_policy import site_key
        self.assertNotEqual(site_key("https://awslabs.github.io/atlas"), site_key("https://openai.github.io/guardrails"))
        self.assertEqual(site_key("https://openai.github.io/guardrails"), site_key("https://github.com/openai/guardrails"))
        self.assertNotEqual(site_key("https://github.com/learner/example"), site_key("https://docs.github.com/en/actions"))
        self.assertEqual(site_key("https://learn.microsoft.com/one"), site_key("https://www.microsoft.com/two"))


if __name__ == "__main__":
    unittest.main()
