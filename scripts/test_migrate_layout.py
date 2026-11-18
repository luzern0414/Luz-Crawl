"""OFFLINE migration fixtures for the three older layouts; never live research or user approval."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import crawl_preflight
import migrate_layout

TASK = "026_含空格、顿号：全角冒号 (示例) 的任务"
PAGE_A = "1368_页面 A：标题、第一篇"
PAGE_B = "1369_没有网页的页面"
COLLECTION = "1370_链接合集"
PAGE_C = "1371_另一个任务里的页面"
EMPTY_TASK = "027_只有标记的任务"
GEN2 = "003_旧集合 甲"
GEN2_DASH = "001-早期集合"
GEN2_PDF = "035-资料汇总 示例"
NODE = shutil.which("node")
CLI = Path(crawl_preflight.__file__).resolve().parent / "luz-crawl.mjs"


def write(path, text=""):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def spellings(path):
    """The same absolute path the three ways records write it."""
    plain = str(path)
    return [plain, plain.replace("\\", "\\\\"), Path(path).as_posix()]


def make_archive(task, name, url, with_html_in_root=None, downloads=False):
    raw = task / "raw" / name / "raw"
    (raw / "snapshots").mkdir(parents=True)
    stamp = crawl_preflight.now()
    body = f"OFFLINE migration fixture document body: {name}"
    snapshot = write(raw / "snapshots" / "0000.json", json.dumps({"text": body}))
    content = write(raw / "content.json", json.dumps({"fixture": "OFFLINE", "status": "captured", "captured_at": stamp, "resolved_url": url, "text": body, "url_check": {"valid_content": True, "requested": url}, "completeness": {"scope": "rendered_body_and_loaded_items"}}))
    write(raw / "identity.json", json.dumps({"canonical_url": url, "serial": int(name[:4])}))
    html = f"{name}.html"
    manifest = {"schema_version": 2, "output_layout": "html_and_raw_v1", "status": "captured", "canonical_url": url, "primary_file": html,
                "files": [{"path": "raw/content.json", "bytes": content.stat().st_size, "sha256": digest(content)}, {"path": "raw/snapshots/0000.json", "bytes": snapshot.stat().st_size, "sha256": digest(snapshot)}]}
    if with_html_in_root:
        page = write(with_html_in_root / html, f"<!doctype html><title>{name}</title>\n")
        manifest["delivery"] = {"file": html, "bytes": page.stat().st_size, "sha256": digest(page)}
    else:
        manifest["delivery"] = {"file": html, "bytes": 5, "sha256": "0" * 64}
    if downloads:   # a file that names old paths, listed in the manifest: manifest and the record's manifest_sha256 change in two steps
        record = write(raw / "downloads.json", json.dumps({"files": [{"file": str(task / "raw" / name / "raw" / "media" / "图.png")}]}, ensure_ascii=False))
        manifest["files"].append({"path": "raw/downloads.json", "bytes": record.stat().st_size, "sha256": digest(record)})
    write(raw / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return task / "raw" / name


def make_preflight(session, caller, stage, archive_a, task, started):
    """Complete OFFLINE evidence, retaining archive A as SRC-001 for migration/hash-chain assertions."""
    from test_evidence_policy import payload_for

    record_dir = session / "raw" / "00-crawl"
    logs = record_dir / "logs" / f"{caller}-{stage}-1"
    source_url = "https://example.org/doc-a"
    steps = []
    for name, result in [("doctor", {"ready": True, "fixture": "OFFLINE"}), ("experience", {})]:
        log = write(logs / f"{name}.json", json.dumps(result))
        steps.append({"command": name, "args": [name], "exit_code": 0, "file": str(log), "sha256": digest(log)})
    for number in range(5):
        query = f"OFFLINE migration evidence question {number}"
        log = write(logs / f"search-{number}.json", json.dumps({"fixture": "OFFLINE", "status": "captured", "platform": "bing", "query": query, "sources": []}))
        steps.append({"command": "search", "args": ["search", "bing", query, "--out", str(task)], "exit_code": 0, "file": str(log), "sha256": digest(log)})
    sources = []
    for number in range(1, 11):
        url = source_url if number == 1 else f"https://publisher{number % 3}.example/offline-migration-{number}"
        archive = archive_a if number == 1 else task / "raw" / f"{1400 + number}_OFFLINE-迁移证据-{number}"
        if not archive.is_dir():
            make_archive(task, archive.name, url)
        evidence = archive / "raw"
        stamp = json.loads((evidence / "content.json").read_text(encoding="utf-8"))["captured_at"]
        label = "capture" if number == 1 else f"capture-{number:03d}"
        log = write(logs / f"{label}.json", json.dumps({"fixture": "OFFLINE", "folder": str(archive), "status": "captured", "resolved_url": url, "url_check": {"requested": url, "valid_content": True}, "run": f"{caller}-{stage}"}))
        steps.append({"command": "capture", "args": ["capture", url, "--out", str(task)], "exit_code": 0, "file": str(log), "sha256": digest(log)})
        sources.append({"id": f"SRC-{number:03d}", "archive": str(archive), "manifest_sha256": digest(evidence / "manifest.json"), "url": url, "captured_at": stamp})
    log = write(logs / "summary.json", json.dumps({"fixture": "OFFLINE"}))
    steps.append({"command": "summary", "args": ["summary"], "exit_code": 0, "file": str(log), "sha256": digest(log)})
    record = {"schema_version": 2, "caller": caller, "stage": stage, "topic": "OFFLINE 迁移夹具", "started_at": started, "finished_at": crawl_preflight.now(), "task_root": str(task), "status": "captured", "steps": steps,
              "sources": sources, "findings": [], "gaps": []}
    write(record_dir / f"{caller}-{stage}.json", json.dumps(record))
    crawl_preflight.conclude(session, caller, payload_for(record, {"findings": [{"source_id": "SRC-001", "summary": "OFFLINE 夹具里的结论", "applies_to": "迁移测试", "adopted": True}], "gaps": []}), stage)


PROJECT_PY = Path(crawl_preflight.__file__).resolve().parents[2] / "Luz-Project" / "scripts" / "project.py"


def make_project(base, task, archive_a, started):
    """OFFLINE legacy project: synthetic research approval freezes evidence; design stays open."""
    # Use the maintained legacy fixture rather than asking today's init to create a retired layout.
    made = subprocess.run([sys.executable, "-X", "utf8", "-c", "import sys; from legacy_fixture import legacy_project; print(legacy_project('OFFLINE-迁移项目', sys.argv[1]))", str(base / "projects")],
                          cwd=str(PROJECT_PY.parent), capture_output=True, text=True, encoding="utf-8")
    if made.returncode != 0:
        raise AssertionError("OFFLINE legacy project fixture failed: " + (made.stderr or made.stdout))
    project = Path(made.stdout.strip())
    manifest = json.loads((project / "project.json").read_text(encoding="utf-8"))
    stages = {s["id"]: s for s in manifest["stages"]}
    research_owner, design_owner = stages["research"]["owner"], stages["design"]["owner"]
    make_preflight(project, research_owner, "research", archive_a, task, started)
    make_preflight(project, design_owner, "design", archive_a, task, started)
    review = write(project / "raw" / "reviews" / "02-调研结论.html", f"<!doctype html><title>调研结论</title><p>依据 {archive_a / 'raw' / 'content.json'}</p>\n")
    write(project / "raw" / "BRIEF.md", f"任务目录 {task}\n存档 {archive_a}\n")
    crawl = project / "raw" / "00-crawl"
    registered = [("ART-001", "research", crawl / f"{research_owner}-research.json"), ("ART-002", "research", crawl / f"{research_owner}-research.html"), ("ART-003", "research", review), ("ART-004", "design", crawl / f"{design_owner}-design.json"), ("ART-005", "design", crawl / f"{design_owner}-design.html")]
    artifacts = [{"id": i, "project_id": manifest["project_id"], "stage": st, "path": f.relative_to(project).as_posix(), "kind": "html" if f.suffix == ".html" and f is review else "research-evidence", "source_ids": [], "sha256": digest(f), "version": 1} for i, st, f in registered]
    hashes = {a["id"]: a["sha256"] for a in artifacts if a["stage"] == "research"}
    stages["research"].update(status="approved", approval_id="APPROVAL-001", artifact_ids=list(hashes), approved_hashes=hashes)
    stages["design"].update(status="in-progress", artifact_ids=["ART-004", "ART-005"])
    manifest["current_stage"] = "design"
    manifest["crawl"]["task_root"] = str(task)
    for name in ("project.json", "MANIFEST.json", "data/project.json"):
        write(project / name, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    write(project / "data" / "artifacts.json", json.dumps(artifacts, ensure_ascii=False, indent=2) + "\n")
    write(project / "APPROVALS.json", json.dumps({"schema_version": "1.0", "approvals": [{"id": "APPROVAL-001", "project_id": manifest["project_id"], "stage": "research", "status": "approved", "note": "夹具", "approver": "测试", "approved_at": crawl_preflight.now(), "artifact_hashes": hashes}]}, ensure_ascii=False, indent=2) + "\n")
    return project, research_owner, design_owner


def build(tmp):
    started = crawl_preflight.now()
    out = tmp / "outputs"
    root = out / "Luz-Crawl"
    legacy = root / "raw"
    # third generation: <root>\raw\NNN_主题 with an inner raw\ per page
    task = legacy / TASK
    write(task / "luz-task.json", json.dumps({"schema_version": 1, "kind": "task_archive", "delivery_layout": "sibling_raw_v1", "title": TASK[4:]}))
    archive_a = make_archive(task, PAGE_A, "https://example.org/doc-a", with_html_in_root=root, downloads=True)
    make_archive(task, PAGE_B, "https://example.org/doc-b")
    collection = task / "raw" / COLLECTION / "raw"
    write(collection / "collection.json", json.dumps({"results": [{"out": str(collection / "sources" / "github")}]}))
    write(collection / "sources" / "github" / "raw" / "001_x" / "raw" / "content.json", "{}")
    cfiles = [{"path": "raw/collection.json", "bytes": 1, "sha256": digest(collection / "collection.json")}, {"path": "raw/sources/github/raw/001_x/raw/content.json", "bytes": 2, "sha256": digest(collection / "sources" / "github" / "raw" / "001_x" / "raw" / "content.json")}]
    write(collection / "manifest.json", json.dumps({"kind": "collection", "output_layout": "html_and_raw_v1", "primary_file": f"{COLLECTION}.html", "delivery": {"file": f"{COLLECTION}.html", "sha256": "1" * 64}, "files": cfiles}))
    write(root / f"{COLLECTION}.html", "<html>collection</html>")
    write(task / "preflight.json", json.dumps({"command": "search", "status": "ready_to_attempt"}))
    write(task / f"batch-1.json", json.dumps({"results": [{"folder": str(archive_a), "html_file": str(root / f"{PAGE_A}.html"), "status": "captured"}]}))
    # downloads.json also records the hash of the batch file: when the batch file is rewritten, downloads.json changes a second time
    downloads = archive_a / "raw" / "downloads.json"
    body = json.loads(downloads.read_text(encoding="utf-8"))
    body["batch_sha256"] = digest(task / "batch-1.json")
    write(downloads, json.dumps(body, ensure_ascii=False))
    listed = json.loads((archive_a / "raw" / "manifest.json").read_text(encoding="utf-8"))
    for entry in listed["files"]:
        if entry["path"] == "raw/downloads.json":
            entry.update(bytes=downloads.stat().st_size, sha256=digest(downloads))
    write(archive_a / "raw" / "manifest.json", json.dumps(listed, ensure_ascii=False, indent=2) + "\n")
    write(task / "search-1700000000000-aaaa.json", json.dumps({"search_archive": str(task), "search_index": str(task / "search-1700000000000-aaaa.json")}))
    write(task / "raw" / "爬取总结.html", "<html>summary</html>")
    write(task / "raw" / "tasks" / "browser-1.json", json.dumps({"result": {"folder": str(archive_a)}}))
    other = legacy / EMPTY_TASK
    write(other / "BRIEF.md", "# brief\n")
    write(other / "luz-task.json", json.dumps({"schema_version": 1, "kind": "task_archive", "delivery_layout": "sibling_raw_v1", "title": "x"}))
    task_c = legacy / "028_第二个任务"
    write(task_c / "luz-task.json", json.dumps({"schema_version": 1, "kind": "task_archive", "delivery_layout": "sibling_raw_v1", "title": "第二个任务"}))
    make_archive(task_c, PAGE_C, "https://example.org/doc-c", with_html_in_root=root)
    write(legacy / "tasks" / "old-state.json", json.dumps({"id": "old-state"}))
    # second generation (HTML + raw\) and first generation (loose pages, a folder of pages)
    write(root / GEN2 / f"{GEN2}.html", "<html>gen2</html>")
    write(root / GEN2 / "raw" / "manifest.json", json.dumps({"primary_file": f"{GEN2}.html", "files": []}))
    write(root / GEN2 / "raw" / "collection.json", json.dumps({"primary_file": f"{GEN2}.html"}))
    write(root / GEN2_DASH / "raw" / "manifest.json", "{}")
    write(root / GEN2_PDF / "清单.pdf", "pdf")
    write(root / "2000_孤立网页.html", "<html>orphan</html>")
    write(root / "旧分类" / "001_示例.html", "<html>old</html>")
    # a research session of another skill that kept proof of reading archive A (hash-bound, like the real gate expects)
    session = out / "Luz-System" / "010-演示"
    make_preflight(session, "luz-design", "research", archive_a, task, started)
    # paths in the three spellings, in a document, a knowledge file and a script
    page_html = root / f"{PAGE_A}.html"
    write(session / "BRIEF.md", "\n".join(f"- {s}" for s in spellings(archive_a / "raw" / "content.json") + spellings(page_html) + spellings(root / GEN2 / f"{GEN2}.html")) + f"\n结尾：{root / GEN2}，然后是句号。\n")
    repos = tmp / "repos"
    write(repos / "Luz-Dev" / "knowledge" / "sources.json", json.dumps({"sources": [{"archive": str(root / GEN2 / "raw" / "collection.json")}, {"archive": str(task / "raw" / PAGE_B)}]}, ensure_ascii=False, indent=2))
    write(repos / "Luz-Dev" / "SKILL.md", f"任务目录是 {task}\n")
    write(repos / "Luz-Dev" / "scripts" / "keep.py", f"PATH = r'{archive_a}'\n")   # scripts are not in scope
    return out, root, repos, session, task, archive_a


def snapshot_tree(base):
    files, dirs = {}, set()
    for current, names, entries in os.walk(base):
        for n in names:
            dirs.add(os.path.relpath(os.path.join(current, n), base))
        for e in entries:
            p = os.path.join(current, e)
            files[os.path.relpath(p, base)] = hashlib.sha256(Path(p).read_bytes()).hexdigest()
    return files, dirs


def run_main(root, out, repos, *extra):
    return migrate_layout.main(["--root", str(root), "--outputs-root", str(out), "--repos-root", str(repos), "--quiet", *extra])


class MigrateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.out, self.root, self.repos, self.session, self.task, self.archive_a = build(self.base)

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_changes_nothing_and_reports_the_plan(self):
        before = snapshot_tree(self.base)
        self.assertEqual(run_main(self.root, self.out, self.repos), 0)
        self.assertEqual(snapshot_tree(self.base), before)
        plan = migrate_layout.scan(self.root)
        self.assertEqual(plan.counts["旧版任务文件夹"], 3)
        self.assertEqual(plan.counts["页面存档"], 12)   # three migration examples plus nine distinct OFFLINE policy bodies
        self.assertEqual(plan.counts["合集存档"], 1)
        self.assertEqual(plan.counts["根目录网页 html"], 4)
        self.assertEqual(plan.counts["其中归入所属页面存档"], 3)
        self.assertEqual(plan.counts["其中归入 000_旧版散落网页存档"], 1)
        # second-generation folders are numbered after the highest task number, oldest first, and are named in the current NNN-主题 form
        self.assertTrue(all(int(new[:3]) >= 29 and new[3] == "-" for _, new in plan.gen2))

    def test_apply_builds_the_new_layout_and_keeps_every_record_verifiable(self):
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 0)
        root = self.root
        names = sorted(p.name for p in root.iterdir())
        self.assertTrue(all(p.is_dir() for p in root.iterdir()))
        self.assertNotIn("raw", names)
        self.assertEqual([n for n in names if not n[:3].isdigit() or n[3] not in "-_"], [])
        self.assertEqual(sorted(n[:4] for n in names if n[3] == "-"), ["029-", "030-", "031-"])   # renumbered folders take the new form, tasks keep their names
        task = root / TASK
        self.assertEqual(sorted(p.name for p in task.iterdir()), [f"{TASK}.html", "raw"])
        self.assertEqual((task / f"{TASK}.html").read_text(encoding="utf-8"), "<html>summary</html>")
        marker = json.loads((task / "raw" / "luz-task.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["delivery_layout"], "task_folder_v2")
        self.assertEqual({"preflight.json", "batch-1.json", "search-1700000000000-aaaa.json", "tasks"} - set(p.name for p in (task / "raw").iterdir()), set())
        page = task / "raw" / PAGE_A
        self.assertEqual(sorted(p.name for p in page.iterdir()), sorted(["content.json", "downloads.json", "identity.json", "manifest.json", "snapshots", f"{PAGE_A}.html"]))
        self.assertEqual(json.loads((page / "downloads.json").read_text(encoding="utf-8"))["files"][0]["file"], str(page / "media" / "图.png"))
        manifest = json.loads((page / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["output_layout"], "archive_html_v2")
        self.assertNotIn("delivery", manifest)
        self.assertEqual(sorted(e["path"] for e in manifest["files"]), sorted(["content.json", "downloads.json", "snapshots/0000.json", f"{PAGE_A}.html"]))
        for entry in manifest["files"]:
            self.assertEqual(digest(page / entry["path"]), entry["sha256"], entry["path"])
        self.assertFalse((root / f"{PAGE_A}.html").exists())
        page_b = json.loads((task / "raw" / PAGE_B / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotIn("output_layout", page_b)
        collection = task / "raw" / COLLECTION
        self.assertTrue((collection / "collection.json").is_file() and (collection / f"{COLLECTION}.html").is_file())
        self.assertTrue((root / EMPTY_TASK / "raw" / "BRIEF.md").is_file() and (root / EMPTY_TASK / "raw" / "luz-task.json").is_file())
        # first generation and the record folders
        self.assertTrue((root / "000_旧版散落网页存档" / "raw" / "2000_孤立网页.html").is_file())
        self.assertTrue((root / "000_旧版散落网页存档" / "raw" / "旧分类" / "001_示例.html").is_file())
        self.assertTrue((root / "000_目录整理记录" / "raw" / "旧版任务状态" / "old-state.json").is_file())
        self.assertTrue((root / "000_目录整理记录" / "raw" / "移动记录.json").is_file())
        self.assertTrue((root / "000_目录整理记录" / "000_目录整理记录.html").is_file())
        gen2 = [p for p in root.iterdir() if p.name[4:].startswith("旧集合")][0]
        self.assertTrue((gen2 / f"{gen2.name}.html").is_file() and (gen2 / "raw" / "manifest.json").is_file())
        self.assertEqual(json.loads((gen2 / "raw" / "manifest.json").read_text(encoding="utf-8"))["primary_file"], f"{gen2.name}.html")
        self.assertTrue([p for p in root.iterdir() if p.name[4:] == "早期集合"] and [p for p in root.iterdir() if p.name[4:] == "资料汇总 示例"])

        # references: gone in all three spellings, and the proof of reading stays valid
        brief = (self.session / "BRIEF.md").read_text(encoding="utf-8")
        new_content = page / "content.json"
        for spelled in spellings(new_content) + spellings(page / f"{PAGE_A}.html"):
            self.assertIn(spelled, brief)
        self.assertNotIn(str(self.root / "raw"), brief)
        self.assertNotIn(str(self.root / "raw").replace("\\", "\\\\"), brief)
        self.assertNotIn((self.root / "raw").as_posix(), brief)
        self.assertIn(f"结尾：{gen2}，然后是句号。", brief)
        sources = json.loads((self.repos / "Luz-Dev" / "knowledge" / "sources.json").read_text(encoding="utf-8"))
        self.assertEqual(sources["sources"][0]["archive"], str(gen2 / "raw" / "collection.json"))
        self.assertEqual(sources["sources"][1]["archive"], str(task / "raw" / PAGE_B))
        self.assertEqual((self.repos / "Luz-Dev" / "SKILL.md").read_text(encoding="utf-8"), f"任务目录是 {task}\n")
        self.assertIn(str(self.root / "raw"), (self.repos / "Luz-Dev" / "scripts" / "keep.py").read_text(encoding="utf-8"))   # outside the stated scope
        batch = json.loads((task / "raw" / "batch-1.json").read_text(encoding="utf-8"))
        self.assertEqual(batch["results"][0]["folder"], str(page))
        self.assertEqual(batch["results"][0]["html_file"], str(page / f"{PAGE_A}.html"))
        self.assertEqual(crawl_preflight.validate_preflight(self.session, "luz-design", "research"), [])
        record = json.loads((self.session / "raw" / "00-crawl" / "luz-design-research.json").read_text(encoding="utf-8"))
        self.assertEqual(record["sources"][0]["archive"], str(page))
        self.assertEqual(record["task_root"], str(task))
        journal = json.loads((root / "000_目录整理记录" / "raw" / "移动记录.json").read_text(encoding="utf-8"))
        self.assertEqual(journal["status"], "done")
        self.assertGreater(journal["stats"]["hash_updated_files"], 0)
        self.assertEqual(journal["verify"]["遗留旧路径（应为 0）"], "0")

    @unittest.skipUnless(NODE, "node unavailable")
    def test_the_node_side_reads_what_the_script_produced(self):
        migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"])
        page = self.root / TASK / "raw" / PAGE_A
        verified = subprocess.run([NODE, str(CLI), "verify", str(page)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
        self.assertTrue(json.loads(verified.stdout)["ok"])
        summary = subprocess.run([NODE, str(CLI), "summary", str(self.root / TASK)], capture_output=True, text=True, encoding="utf-8", env={**os.environ, "LUZ_CRAWL_STATE": str(self.base / "state")})
        self.assertEqual(summary.returncode, 0, summary.stderr)
        self.assertEqual(json.loads(summary.stdout)["file"], str(self.root / TASK / f"{TASK}.html"))

    def test_revert_puts_everything_back(self):
        before = snapshot_tree(self.base)
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 0)
        journal = self.root / "000_目录整理记录" / "raw" / "移动记录.json"
        self.assertEqual(migrate_layout.main(["--revert", str(journal), "--quiet"]), 0)
        after_files, after_dirs = snapshot_tree(self.base)
        before_files, before_dirs = before
        keep = lambda rel: rel.startswith(os.path.join("outputs", "Luz-Crawl", "000_目录整理记录"))  # noqa: E731
        self.assertEqual({k: v for k, v in after_files.items() if not keep(k)}, before_files)
        self.assertEqual({d for d in after_dirs if not keep(d)}, before_dirs)
        self.assertEqual(crawl_preflight.validate_preflight(self.session, "luz-design", "research"), [])

    def test_a_live_capture_lock_and_leftover_files_block_the_run(self):
        lock = self.task / "raw" / PAGE_B / ".capture.lock"
        write(lock, "{}")
        before = snapshot_tree(self.base)
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 1)
        self.assertEqual(snapshot_tree(self.base), before)
        os.utime(lock, (1, 1))   # a lock from long ago is only a warning
        plan = migrate_layout.scan(self.root)
        self.assertEqual(plan.blockers, [])
        self.assertTrue(plan.warnings)

    def test_a_task_that_kept_running_on_the_new_code_keeps_its_newer_files(self):
        # new-code files already sit in raw\ next to the older task-level ones; the older ones are kept under another name
        write(self.task / "raw" / "preflight.json", json.dumps({"command": "capture", "status": "newer"}))
        write(self.task / f"{TASK}.html", "<html>newer summary</html>")
        write(self.task / "raw" / "1380_新代码写的页面" / "content.json", "{}")
        write(self.task / "raw" / "1380_新代码写的页面" / "manifest.json", json.dumps({"output_layout": "archive_html_v2", "primary_file": "x.html", "files": []}))
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 0)
        raw = self.root / TASK / "raw"
        self.assertEqual(json.loads((raw / "preflight.json").read_text(encoding="utf-8"))["status"], "newer")
        self.assertEqual(json.loads((raw / "preflight.旧版.json").read_text(encoding="utf-8"))["status"], "ready_to_attempt")
        self.assertEqual((self.root / TASK / f"{TASK}.html").read_text(encoding="utf-8"), "<html>newer summary</html>")
        self.assertEqual((raw / "爬取总结.旧版.html").read_text(encoding="utf-8"), "<html>summary</html>")
        self.assertTrue((raw / "1380_新代码写的页面" / "content.json").is_file())
        journal = json.loads((self.root / "000_目录整理记录" / "raw" / "移动记录.json").read_text(encoding="utf-8"))
        self.assertTrue(journal["notes"])

    @unittest.skipUnless(PROJECT_PY.is_file(), "Luz-Project not next to this skill")
    def test_a_project_outside_the_root_is_rewritten_except_what_an_approval_binds(self):
        started = json.loads((self.archive_a / "raw" / "content.json").read_text(encoding="utf-8"))["captured_at"]
        project, research_owner, design_owner = make_project(self.base, self.task, self.archive_a, started)
        project_before = snapshot_tree(project)
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 0)
        journal = self.root / "000_目录整理记录" / "raw" / "移动记录.json"
        # the migration itself did not look at the project; its records still name the old places
        self.assertEqual(snapshot_tree(project), project_before)
        self.assertTrue(crawl_preflight.validate_preflight(project, design_owner, "design"))
        frozen = {name: (project / name).read_bytes() for name in ("APPROVALS.json", f"raw/00-crawl/{research_owner}-research.json", f"raw/00-crawl/{research_owner}-research.html", "raw/reviews/02-调研结论.html")}
        frozen_logs = {p: p.read_bytes() for p in (project / "raw" / "00-crawl" / "logs" / f"{research_owner}-research-1").iterdir()}
        args = ["--rewrite-with", str(journal), "--extra-root", str(project), "--quiet"]
        # dry run: nothing changes, and the journal is not touched
        journal_bytes = journal.read_bytes()
        self.assertEqual(migrate_layout.main(args), 0)
        self.assertEqual(snapshot_tree(project), project_before)
        self.assertEqual(journal.read_bytes(), journal_bytes)
        self.assertEqual(migrate_layout.main([*args, "--apply"]), 0)
        # what the approval is bound to stays byte for byte, together with the logs its record vouches for
        for name, data in frozen.items():
            self.assertEqual((project / name).read_bytes(), data, name)
        for path, data in frozen_logs.items():
            self.assertEqual(path.read_bytes(), data, path)
        # the rest follows the new layout, and the hashes the project keeps follow the rewritten files
        page = self.root / TASK / "raw" / PAGE_A
        design = project / "raw" / "00-crawl" / f"{design_owner}-design.json"
        self.assertEqual(json.loads(design.read_text(encoding="utf-8"))["sources"][0]["archive"], str(page))
        self.assertEqual((project / "raw" / "BRIEF.md").read_text(encoding="utf-8"), f"任务目录 {self.task.parent.parent / TASK}\n存档 {page}\n")
        self.assertEqual(crawl_preflight.validate_preflight(project, design_owner, "design"), [])
        self.assertTrue(crawl_preflight.validate_preflight(project, research_owner, "research"))   # frozen: still the old paths
        artifacts = {a["id"]: a for a in json.loads((project / "data" / "artifacts.json").read_text(encoding="utf-8"))}
        self.assertEqual(artifacts["ART-004"]["sha256"], digest(design))
        self.assertEqual(artifacts["ART-001"]["sha256"], digest(project / "raw" / "00-crawl" / f"{research_owner}-research.json"))
        mirrors = [(project / name).read_bytes() for name in ("project.json", "MANIFEST.json", "data/project.json")]
        self.assertEqual(len(set(mirrors)), 1)
        self.assertEqual(json.loads(mirrors[0].decode("utf-8"))["crawl"]["task_root"], str(self.root / TASK))
        run = json.loads(journal.read_text(encoding="utf-8"))["extra_runs"][0]
        self.assertEqual(run["root"], str(project))
        # Only frozen files that still name old paths are listed: the record, review and all ten capture logs.
        capture_names = ["capture.json", *(f"capture-{number:03d}.json" for number in range(2, 11))]
        self.assertEqual(sorted(Path(item["file"]).name for item in run["protected_with_old_paths"]), sorted([f"{research_owner}-research.json", "02-调研结论.html", *capture_names]))
        self.assertEqual(sorted(str(Path(item["file"]).parent.name) for item in run["protected_with_old_paths"] if item["file"].endswith("capture.json")), [f"{research_owner}-research-1"])
        self.assertEqual(json.loads((project / "raw" / "00-crawl" / "logs" / f"{design_owner}-design-1" / "capture.json").read_text(encoding="utf-8"))["folder"], str(page))
        self.assertEqual(run["verify"]["项目自带检查新增问题"], {})
        self.assertEqual(run["verify"]["改写后新出现的前置检索失败"], [])
        self.assertTrue(run["verify"]["项目自带检查消除的问题"])
        # undo only the project rewrite
        self.assertEqual(migrate_layout.main(["--revert", str(journal), "--extra-only", "--quiet"]), 0)
        self.assertEqual(snapshot_tree(project), project_before)
        self.assertEqual(json.loads(journal.read_text(encoding="utf-8"))["extra_runs"], [])

    def test_reconcile_repairs_hashes_that_were_left_at_an_intermediate_value(self):
        # the migration as it was first written: a file rewritten twice left others with its first new hash
        original = migrate_layout.Applier.note_change

        def forgetful(self, path, old, new, structural=False, passes=None):
            original(self, path, old, new, structural, passes)
            item = self.state[os.path.normcase(os.path.abspath(path))]
            item["history"] = {item["orig"]}

        migrate_layout.Applier.note_change = forgetful
        try:
            self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 1)
        finally:
            migrate_layout.Applier.note_change = original
        page = self.root / TASK / "raw" / PAGE_A
        manifest = json.loads((page / "manifest.json").read_text(encoding="utf-8"))
        listed = {e["path"]: e["sha256"] for e in manifest["files"]}
        self.assertNotEqual(listed["downloads.json"], digest(page / "downloads.json"))
        self.assertTrue(crawl_preflight.validate_preflight(self.session, "luz-design", "research"))
        journal = self.root / "000_目录整理记录" / "raw" / "移动记录.json"
        args = ["--reconcile-with", str(journal), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet"]
        before = snapshot_tree(self.base)
        self.assertEqual(migrate_layout.main(args), 0)             # dry run
        self.assertEqual(snapshot_tree(self.base), before)
        self.assertEqual(migrate_layout.main([*args, "--apply"]), 0)
        manifest = json.loads((page / "manifest.json").read_text(encoding="utf-8"))
        for entry in manifest["files"]:
            self.assertEqual(entry["sha256"], digest(page / entry["path"]), entry["path"])
        self.assertEqual(crawl_preflight.validate_preflight(self.session, "luz-design", "research"), [])
        run = json.loads(journal.read_text(encoding="utf-8"))["extra_runs"][-1]
        self.assertEqual(run["kind"], "哈希对账")
        self.assertTrue(run["rewrites"])
        if NODE:
            self.assertTrue(json.loads(subprocess.run([NODE, str(CLI), "verify", str(page)], capture_output=True, text=True, encoding="utf-8").stdout)["ok"])
        self.assertEqual(migrate_layout.main(["--revert", str(journal), "--extra-only", "--quiet"]), 0)
        self.assertTrue(crawl_preflight.validate_preflight(self.session, "luz-design", "research"))   # back to the broken state

    def test_a_frozen_record_with_old_paths_is_read_through_the_migration_map(self):
        started = json.loads((self.archive_a / "raw" / "content.json").read_text(encoding="utf-8"))["captured_at"]
        frozen = self.base / "frozen-session"      # outside everything the migration rewrites, like a record kept by an approval
        make_preflight(frozen, "luz-design", "research", self.archive_a, self.task, started)
        record_files = {p: p.read_bytes() for p in (frozen / "raw" / "00-crawl").rglob("*") if p.is_file()}
        self.assertEqual(crawl_preflight.validate_preflight(frozen, "luz-design", "research"), [])
        self.assertEqual(migrate_layout.main(["--root", str(self.root), "--outputs-root", str(self.out), "--repos-root", str(self.repos), "--quiet", "--apply"]), 0)
        index = self.root / "000_目录整理记录" / "raw" / "旧路径映射.json"
        self.assertTrue(index.is_file())
        previous = os.environ.get("LUZ_CRAWL_MIGRATION_INDEX")
        try:
            # no map: the old paths are simply gone
            os.environ["LUZ_CRAWL_MIGRATION_INDEX"] = str(self.base / "no-such-map.json")
            self.assertTrue(crawl_preflight.validate_preflight(frozen, "luz-design", "research"))
            # with the map the frozen record passes as it is: same bytes, same hashes
            os.environ["LUZ_CRAWL_MIGRATION_INDEX"] = str(index)
            self.assertEqual(crawl_preflight.validate_preflight(frozen, "luz-design", "research"), [])
            self.assertEqual({p: p.read_bytes() for p in record_files}, record_files)
            # old paths the map does not know stay errors, whatever their spelling
            record_path = frozen / "raw" / "00-crawl" / "luz-design-research.json"
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["sources"][0]["archive"] = str(self.root / "raw" / "999_没有的任务" / "raw" / "1_x")
            record_path.write_text(json.dumps(record), encoding="utf-8")
            self.assertTrue(crawl_preflight.validate_preflight(frozen, "luz-design", "research", require_findings=False))
            # the three spellings of a path that was moved all resolve to where it is now
            old = self.root / "raw" / TASK / "raw" / PAGE_A / "raw" / "content.json"
            now_at = self.root / TASK / "raw" / PAGE_A / "content.json"
            for spelled in (str(old), old.as_posix(), str(old).replace("\\", "\\\\")):
                self.assertEqual(crawl_preflight.canon(spelled).resolve(), now_at.resolve(), spelled)
            self.assertEqual(crawl_preflight.canon(self.root / "raw" / "999_没有的任务" / "luz-task.json"), self.root / "raw" / "999_没有的任务" / "luz-task.json")
            # an existing path is never remapped
            self.assertEqual(crawl_preflight.canon(now_at), now_at)
        finally:
            if previous is None:
                os.environ.pop("LUZ_CRAWL_MIGRATION_INDEX", None)
            else:
                os.environ["LUZ_CRAWL_MIGRATION_INDEX"] = previous

    def test_names_that_are_prefixes_of_each_other_are_not_confused(self):
        longer = TASK + " 加长"
        write(self.root / "raw" / longer / "luz-task.json", json.dumps({"schema_version": 1, "kind": "task_archive", "delivery_layout": "sibling_raw_v1"}))
        plan = migrate_layout.scan(self.root)
        rewriter = migrate_layout.Rewriter(plan, self.root)
        text = f"{self.root / 'raw' / TASK / 'raw' / PAGE_A / 'raw' / 'content.json'} | {self.root / 'raw' / longer / 'luz-task.json'} | {self.root / 'raw' / TASK}"
        new, edits = rewriter.rewrite(text)
        self.assertEqual(len(edits), 3)
        self.assertEqual(new, f"{self.root / TASK / 'raw' / PAGE_A / 'content.json'} | {self.root / longer / 'raw' / 'luz-task.json'} | {self.root / TASK}")


if __name__ == "__main__":
    unittest.main()
