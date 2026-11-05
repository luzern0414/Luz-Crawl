#!/usr/bin/env python3
"""Move a Luz-Crawl output root to the task_folder_v2 layout (Python standard library only).

    <root>\\NNN-主题\\raw\\...            everything crawled and every machine record
    <root>\\NNN-主题\\NNN-主题.html       the summary page, beside raw\\

A task keeps the name it has (an older NNN_主题 stays NNN_主题: nothing is renamed that a record may point at); only a folder
that has to be renumbered gets the current NNN-主题 form. Three older shapes are folded in:
  1. <root>\\raw\\NNN_主题\\ (marker beside raw\\, page archives with an inner raw\\)  -> <root>\\NNN_主题\\raw\\, pages flattened,
     each page's HTML moved from <root> into its page folder (task numbers and names stay as they are);
  2. <root>\\NNN-主题\\ (HTML + raw\\) from the first collections                   -> renumbered after the highest task number (as NNN-主题);
  3. loose pages and folders in <root>                                              -> 000_旧版散落网页存档\\raw\\.
raw\\tasks\\ goes to 000_目录整理记录\\raw\\旧版任务状态, together with 移动记录.json and a one-page report.

Default is a dry run that only prints the plan. --apply moves things; --revert <移动记录.json> puts everything back.
Every moved path, every rewritten file (as edit lists) and every changed hash is recorded in 移动记录.json.
After the moves, absolute archive paths written into text files (three spellings: D:\\..., D:\\\\... and D:/...) are rewritten
from the exact old names, and the SHA-256 values that other records keep of rewritten files are updated to match.

Afterwards, with the 移动记录.json of a finished migration:
  --rewrite-with <移动记录.json> --extra-root <dir> [--extra-root ...] [--discover-projects <dir>]
      rewrites the same absolute paths in folders outside the output root (Luz projects in D:\\Codes and the like), from the
      exact old names the journal kept. In a Luz project nothing an approval is bound to is changed: the artifacts of approved
      stages, the files whose hash APPROVALS.json or an approved stage records, and what those files vouch for by hash are listed
      instead. project.py check and gate run before and after and must not report anything new. The work is appended to the
      journal (extra_runs); --revert <移动记录.json> --extra-only undoes just that.
  --reconcile-with <移动记录.json>
      updates every hash that another file still keeps of a rewritten file to the hash the file has now.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import itertools
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = r"D:\Codes\skill输出\Luz-Crawl"
LEGACY_PAGES = "000_旧版散落网页存档"
RECORD_DIR = "000_目录整理记录"
RECORD_NAME = "移动记录.json"
INDEX_NAME = "旧路径映射.json"
OLD_TASK_STATE = "旧版任务状态"
SUMMARY_OLD = "爬取总结.html"
TEXT_EXT = {".json", ".md", ".html", ".htm", ".py", ".log", ".txt", ".yaml", ".yml", ".mjs", ".js", ".csv"}
MAX_BYTES = 20 * 1024 * 1024
BIG_FILE = 1024 * 1024
PRUNE = {"_work", "node_modules", ".git", "__pycache__", ".venv", "venv", ".pytest_cache"}
CRAWL_SKIP_DIRS = {"snapshots", "media", "downloads", "browser-actions", "platform-probes", RECORD_DIR}
CRAWL_SKIP_FILES = {"content.json", "identity.json"}
SEP = re.compile(r"[\\/]+")
BOUNDARY = set("\\/\"'`<>)]},;|*:#?&、，。；：）】」』”’ \t\r\n") | {""}
HEX64 = re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])")
LIVE_SECONDS = 30 * 60


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def lp(path) -> str:
    """Long-path safe string for os calls on Windows."""
    text = os.path.abspath(str(path))
    if os.name == "nt" and len(text) > 240 and not text.startswith("\\\\?\\"):
        return "\\\\?\\" + text
    return text


def serial_of(name: str) -> int:
    match = re.match(r"^(\d+)[_-]", name)
    return int(match.group(1)) if match else 0


# ----------------------------------------------------------------------------------------------- journal
class Journal:
    """移动记录.json: ordered operations plus the rewritten files, written as the work proceeds."""

    def __init__(self, root: Path):
        self.root = root
        self.data = {"schema_version": 1, "tool": "migrate_layout.py", "root": str(root), "created_at": now(), "status": "planned", "ops": [], "rewrites": [], "notes": [], "stats": {}}
        self.file = None

    def save(self):
        if self.file is not None:
            self.file.parent.mkdir(parents=True, exist_ok=True)
            temp = self.file.with_suffix(".tmp")
            temp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            os.replace(temp, self.file)


def rename(src, dst):
    last = None
    for _ in range(5):
        try:
            os.rename(lp(src), lp(dst))
            return
        except PermissionError as error:
            last = error
            time.sleep(0.4)
    raise last


# ----------------------------------------------------------------------------------------------- plan
class TaskPlan:
    def __init__(self, name):
        self.name = name
        self.moved = {}        # task-level entries that go into raw\ : name -> "file"|"dir"
        self.stay = {}         # task-level entries that stay beside raw\ (loose htmls of odd folders)
        self.summary_at = None  # "raw" | "top" | None: where an old 爬取总结.html sits
        self.archives = {}     # archive folder name -> {"primary": str|None, "has_inner_raw": bool}
        self.raw_other = {}    # other entries inside T\raw (tasks, 00-crawl, tmp ...): name -> kind
        self.has_raw = False
        self.marker = False


class Plan:
    def __init__(self, root: Path):
        self.root = root
        self.tasks: dict[str, TaskPlan] = {}
        self.gen2: list[tuple[str, str]] = []          # (old name, new name)
        self.gen2_html: dict[str, str] = {}            # old dir -> old html name when present
        self.loose: dict[str, tuple] = {}              # file name -> (task, archive) | None
        self.other_dirs: list[str] = []
        self.other_files: list[str] = []
        self.has_legacy_raw = False
        self.has_task_state = False
        self.blockers: list[str] = []
        self.warnings: list[str] = []
        self.locks: list[str] = []
        self.counts: dict[str, int] = {}


def read_json(path):
    try:
        return json.loads(Path(lp(path)).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def scan(root: Path, workers: int = 16, progress=None) -> Plan:
    plan = Plan(root)
    entries = sorted(os.listdir(lp(root)))
    legacy_raw = root / "raw"
    plan.has_legacy_raw = legacy_raw.is_dir()
    html_names = {e for e in entries if e.lower().endswith(".html") and (root / e).is_file()}
    manifest_jobs = []
    if plan.has_legacy_raw:
        for name in sorted(os.listdir(lp(legacy_raw))):
            path = legacy_raw / name
            if not path.is_dir():
                plan.blockers.append(f"旧 raw\\ 里有散落文件，需要人工确认：{name}")
                continue
            if name == "tasks":
                plan.has_task_state = True
                continue
            task = TaskPlan(name)
            plan.tasks[name] = task
            top = sorted(os.listdir(lp(path)))
            task.marker = "luz-task.json" in top
            task.has_raw = "raw" in top and (path / "raw").is_dir()
            for entry in top:
                if entry == "raw":
                    continue
                if entry == SUMMARY_OLD:
                    task.summary_at = "top"
                elif entry.lower().endswith(".html") and (path / entry).is_file():
                    task.stay[entry] = "file"      # loose pages of a folder that never was a task stay where they are
                else:
                    task.moved[entry] = "dir" if (path / entry).is_dir() else "file"
            if task.has_raw:
                for entry in sorted(os.listdir(lp(path / "raw"))):
                    inner = path / "raw" / entry
                    if entry == SUMMARY_OLD and inner.is_file():
                        task.summary_at = "raw"
                    elif inner.is_dir() and (inner / "raw" / "manifest.json").is_file():
                        task.archives[entry] = {"primary": None, "has_inner_raw": True}
                        manifest_jobs.append((name, entry, inner / "raw" / "manifest.json"))
                    else:
                        task.raw_other[entry] = "dir" if inner.is_dir() else "file"
            if "raw" in top and not task.has_raw:
                plan.blockers.append(f"{name}\\raw 不是文件夹")
    # page manifests: which root HTML belongs to which archive
    def primary(job):
        task, archive, manifest = job
        data = read_json(manifest) or {}
        folder = manifest.parent.parent
        clash = (set(os.listdir(lp(folder))) - {"raw"}) & set(os.listdir(lp(manifest.parent)))
        return task, archive, data.get("primary_file"), data.get("kind"), sorted(clash)

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for task, archive, primary_file, kind, clash in pool.map(primary, manifest_jobs):
            plan.tasks[task].archives[archive]["primary"] = primary_file
            plan.tasks[task].archives[archive]["kind"] = kind
            if clash:
                plan.blockers.append(f"页面存档里外有同名文件，无法展平：{task}\\raw\\{archive}（{'、'.join(clash)}）")
            done += 1
            if progress and done % 500 == 0:
                progress(f"  读取页面清单 {done}/{len(manifest_jobs)}")
    claimed: dict[str, tuple] = {}
    for task in plan.tasks.values():
        for archive, info in task.archives.items():
            for candidate in (info["primary"], archive + ".html"):
                if candidate and candidate in html_names and candidate not in claimed:
                    claimed[candidate] = (task.name, archive)
                    info["html"] = candidate
                    break
    # root level
    gen2_dirs = []
    for entry in entries:
        path = root / entry
        if entry == "raw":
            continue
        if path.is_dir():
            if re.match(r"^\d+[-_]", entry) and entry not in (LEGACY_PAGES, RECORD_DIR):
                gen2_dirs.append(entry)
            elif entry in (LEGACY_PAGES, RECORD_DIR):
                plan.blockers.append(f"输出根里已有 {entry}，可能已经迁移过")
            else:
                plan.other_dirs.append(entry)
        elif entry in html_names:
            plan.loose[entry] = claimed.get(entry)
        else:
            plan.other_files.append(entry)
    first = max((serial_of(n) for n in plan.tasks), default=0) + 1
    ordered = sorted(gen2_dirs, key=lambda n: ((root / n).stat().st_ctime, n))
    used = {n for n in plan.tasks}
    for index, old in enumerate(ordered):
        rest = re.sub(r"^\d+[-_]", "", old)
        new = f"{first + index:03d}-{rest}"
        if new in used or (root / new).exists():
            plan.blockers.append(f"改号后的名字已存在：{new}")
        used.add(new)
        plan.gen2.append((old, new))
        if (root / old / (old + ".html")).is_file():
            plan.gen2_html[old] = old + ".html"
    # locks and temp files that say another crawl is running
    cutoff = time.time() - LIVE_SECONDS
    for task in plan.tasks.values():
        base = legacy_raw / task.name
        for archive in task.archives:
            lock = base / "raw" / archive / ".capture.lock"
            if lock.exists():
                (plan.blockers if lock.stat().st_mtime >= cutoff else plan.warnings).append(f"{'进行中' if lock.stat().st_mtime >= cutoff else '遗留'}的采集锁：{lock}")
                plan.locks.append(str(lock))
        if task.has_raw:
            for entry in task.raw_other:
                if entry.endswith(".tmp") and (base / "raw" / entry).stat().st_mtime >= cutoff:
                    plan.blockers.append(f"最近写入的临时文件：{base / 'raw' / entry}")
    for name in (".archive-allocation.lock", ".raw.archive-allocation.lock"):
        if (root / name).exists():
            plan.blockers.append(f"分配锁存在：{root / name}")
    plan.counts = {
        "旧版任务文件夹": len(plan.tasks),
        "页面存档": sum(1 for t in plan.tasks.values() for a in t.archives.values() if a.get("kind") != "collection"),
        "合集存档": sum(1 for t in plan.tasks.values() for a in t.archives.values() if a.get("kind") == "collection"),
        "根目录网页 html": len(plan.loose),
        "其中归入所属页面存档": sum(1 for v in plan.loose.values() if v),
        "其中归入 000_旧版散落网页存档": sum(1 for v in plan.loose.values() if not v),
        "根目录其他文件": len(plan.other_files),
        "根目录其他文件夹": len(plan.other_dirs),
        "第二代任务文件夹（改号）": len(plan.gen2),
        "旧任务状态 json": len(os.listdir(lp(legacy_raw / "tasks"))) if plan.has_task_state else 0,
        "任务级文件移入 raw": sum(len(t.moved) for t in plan.tasks.values()),
        "任务总结 html 移到任务目录": sum(1 for t in plan.tasks.values() if t.summary_at),
    }
    return plan


# ----------------------------------------------------------------------------------------------- path rewriting
class NameIndex:
    """Exact names, found by their first characters, longest first."""

    def __init__(self, names):
        self.by_key: dict[str, list[str]] = {}
        for name in sorted(set(names), key=len, reverse=True):
            self.by_key.setdefault(name[:2], []).append(name)

    def match(self, text: str, position: int):
        for name in self.by_key.get(text[position:position + 2], ()):
            end = position + len(name)
            if text.startswith(name, position) and (end >= len(text) or text[end] in BOUNDARY):
                return name, end
        return None


def json_escape(text: str) -> str:
    return json.dumps(text, ensure_ascii=True)[1:-1]


class Mode:
    """Rewrites the paths of one spelling of non-ASCII text: as it is, or as \\uXXXX escapes (JSON written with ensure_ascii)."""

    def __init__(self, plan: Plan, root: Path, esc):
        self.plan, self.root, self.esc = plan, root, esc
        E = esc
        parent, name = re.escape(E(root.parent.name)), re.escape(E(root.name))
        self.root_re = re.compile(rf"(?:{parent}[\\/]+{name}|(?<![\w:.\\/-]){name})(?=[\\/])", re.I)
        folder = E(root.name)
        self.needles = {folder, folder.lower(), folder.upper(), folder.title()}
        self.summary = E(SUMMARY_OLD)
        self.legacy_pages, self.record_dir, self.task_state = E(LEGACY_PAGES), E(RECORD_DIR), E(OLD_TASK_STATE)
        self.gen2 = {E(o): E(n) for o, n in plan.gen2}
        self.gen2_html = {E(o): E(h) for o, h in plan.gen2_html.items()}
        self.other = {E(n) for n in [*plan.other_dirs, *plan.other_files]}
        self.loose = {E(n): ((E(h[0]), E(h[1])) if h else None) for n, h in plan.loose.items()}
        self.top = NameIndex(["raw", *self.gen2, *self.other, *self.loose])
        self.tasks = {E(n): t for n, t in plan.tasks.items()}
        self.task_index = NameIndex([*self.tasks, *(["tasks"] if plan.has_task_state else [])])
        self.moved, self.stay, self.archives = {}, {}, {}
        self.children, self.raw_children = {}, {}
        for original, t in plan.tasks.items():
            n = E(original)
            self.moved[n] = {E(x) for x in t.moved}
            self.stay[n] = {E(x) for x in t.stay}
            self.archives[n] = {E(x) for x in t.archives}
            self.children[n] = NameIndex(["raw", *self.moved[n], *self.stay[n], *([self.summary] if t.summary_at == "top" else [])])
            self.raw_children[n] = NameIndex([*self.archives[n], *{E(x) for x in t.raw_other}, *([self.summary] if t.summary_at == "raw" else [])])

    def _after(self, text, i, base):
        """Map the path that follows the root prefix at text[i:]. Returns (end, replacement) or None."""
        sep = SEP.match(text, i)
        if not sep:
            return None
        s = sep.group(0)
        hit = self.top.match(text, sep.end())
        if not hit:
            return None
        name, k = hit
        if name == "raw":
            if not self.plan.has_legacy_raw:
                return None
            sep2 = SEP.match(text, k)
            hit2 = self.task_index.match(text, sep2.end()) if sep2 else None
            if not hit2:
                return None
            task, k2 = hit2
            if task not in self.tasks:     # raw\tasks, the browser task state
                return k2, f"{base}{s}{self.record_dir}{s}raw{s}{self.task_state}"
            return self._task(text, k2, base, s, task)
        if name in self.gen2:
            new = self.gen2[name]
            end, out = k, f"{base}{s}{new}"
            old_html = self.gen2_html.get(name)
            if old_html:
                sep3 = SEP.match(text, k)
                if sep3 and text.startswith(old_html, sep3.end()):
                    after = sep3.end() + len(old_html)
                    if after >= len(text) or text[after] in BOUNDARY:
                        end, out = after, f"{out}{s}{new}.html"
            return end, out
        if name in self.other:
            return k, f"{base}{s}{self.legacy_pages}{s}raw{s}{name}"
        if name in self.loose:
            home = self.loose[name]
            if home:
                return k, f"{base}{s}{home[0]}{s}raw{s}{home[1]}{s}{name}"
            return k, f"{base}{s}{self.legacy_pages}{s}raw{s}{name}"
        return None

    def _task(self, text, k, base, s, task):
        plan_task = self.tasks[task]
        root_task = f"{base}{s}{task}"
        sep = SEP.match(text, k)
        if not sep:
            return k, root_task
        hit = self.children[task].match(text, sep.end())
        if not hit:
            return k, root_task
        name, k2 = hit
        if name == "raw":
            sep2 = SEP.match(text, k2)
            hit2 = self.raw_children[task].match(text, sep2.end()) if sep2 else None
            if not hit2:
                return k2, f"{root_task}{s}raw"
            inner, k3 = hit2
            if inner == self.summary and plan_task.summary_at == "raw":
                return k3, f"{root_task}{s}{task}.html"
            if inner in self.archives[task]:
                # <task>\raw\<page>\raw\... becomes <task>\raw\<page>\...
                sep3 = SEP.match(text, k3)
                if sep3 and text.startswith("raw", sep3.end()) and (sep3.end() + 3 >= len(text) or text[sep3.end() + 3] in BOUNDARY):
                    return sep3.end() + 3, f"{root_task}{s}raw{s}{inner}"
            return k3, f"{root_task}{s}raw{s}{inner}"
        if name == self.summary and plan_task.summary_at == "top":
            return k2, f"{root_task}{s}{task}.html"
        if name in self.stay[task]:
            return k2, f"{root_task}{s}{name}"
        return k2, f"{root_task}{s}raw{s}{name}"

    def rewrite(self, text: str):
        out, edits = [], []
        pos = written = 0
        # a plain substring test is far cheaper than the case-insensitive regex over a large page that never names the folder
        if not any(needle in text for needle in self.needles):
            return text, []
        for m in self.root_re.finditer(text):
            if m.start() < pos:
                continue
            found = self._after(text, m.end(), m.group(0))
            if not found:
                continue
            end, replacement = found
            old = text[m.start():end]
            if old == replacement:
                continue
            out.append(text[pos:m.start()])
            written += m.start() - pos
            edits.append((written, old, replacement))
            out.append(replacement)
            written += len(replacement)
            pos = end
        if not edits:
            return text, []
        out.append(text[pos:])
        return "".join(out), edits


class Rewriter:
    """Both spellings: plain text and \\uXXXX-escaped JSON. rewrite_passes() keeps one edit list per pass so it can be undone."""

    def __init__(self, plan: Plan, root: Path):
        self.plan, self.root = plan, root
        self.modes = [Mode(plan, root, lambda s: s)]
        names = [root.parent.name, root.name, *plan.tasks, *plan.loose, *plan.other_dirs, *plan.other_files, *(o for o, _ in plan.gen2), *(n for _, n in plan.gen2), SUMMARY_OLD]
        if any(json_escape(n) != n for n in names):
            self.modes.append(Mode(plan, root, json_escape))
        self.root_re = self.modes[0].root_re
        self.needle_bytes = tuple(sorted({needle.encode("utf-8") for mode in self.modes for needle in mode.needles}))

    def worth_reading(self, data: bytes) -> bool:
        """A large file (a crawled page, say) that never names the output folder is neither rewritten nor does it record a hash we changed."""
        return len(data) <= BIG_FILE or any(needle in data for needle in self.needle_bytes)

    def rewrite_passes(self, text: str):
        passes = []
        for mode in self.modes:
            text, edits = mode.rewrite(text)
            if edits:
                passes.append(edits)
        return text, passes

    def rewrite(self, text: str):
        text, passes = self.rewrite_passes(text)
        return text, [e for edits in passes for e in edits]


def replace_hashes(text: str, mapping: dict[str, str]):
    """Swap recorded SHA-256 values for the ones of the files rewritten since; returns (text, edits)."""
    out, edits = [], []
    pos = 0
    written = 0
    for m in HEX64.finditer(text):
        new = mapping.get(m.group(0))
        if not new or new == m.group(0):
            continue
        out.append(text[pos:m.start()])
        written += m.start() - pos
        edits.append((written, m.group(0), new))
        out.append(new)
        written += len(new)
        pos = m.end()
    if not edits:
        return text, []
    out.append(text[pos:])
    return "".join(out), edits


def undo_edits(text: str, passes: list) -> str | None:
    """Reverse recorded edit passes; None when the file no longer holds what was written."""
    for edits in reversed(passes):
        for offset, old, new in reversed(edits):
            if text[offset:offset + len(new)] != new:
                return None
            text = text[:offset] + old + text[offset + len(new):]
    return text


# ----------------------------------------------------------------------------------------------- text files in scope
def decode(data: bytes):
    bom = data.startswith(b"\xef\xbb\xbf")
    try:
        return data[3:].decode("utf-8") if bom else data.decode("utf-8"), bom
    except UnicodeDecodeError:
        return None, bom


def encode(text: str, bom: bool) -> bytes:
    return (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")


def walk_files(base: Path, skip_dirs=frozenset(), skip_files=frozenset(), exts=TEXT_EXT):
    for current, dirs, files in os.walk(lp(base)):
        dirs[:] = [d for d in dirs if d not in PRUNE and d not in skip_dirs]
        for name in files:
            if name in skip_files or os.path.splitext(name)[1].lower() not in exts:
                continue
            yield os.path.join(current, name)


def scope_files(root: Path, repos_root: Path, outputs_root: Path, crawl_root_final: Path, include_content: bool, part: str = "all"):
    """Yield (path, group) for every text file whose paths may need rewriting.

    part "external" is everything outside the Luz-Crawl output (other skills' outputs, skill documents, local memory); it does
    not move during a migration, so callers may list it once. part "internal" is the records inside the Luz-Crawl output."""
    seen = set()

    def emit(path, group):
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            return (path, group)
        return None

    # 1. every other output folder next to the Luz-Crawl root
    if part != "internal" and outputs_root.is_dir():
        for entry in sorted(os.listdir(lp(outputs_root))):
            base = outputs_root / entry
            if entry in PRUNE or not base.is_dir() or os.path.normcase(str(base)) == os.path.normcase(str(root)):
                continue
            for path in walk_files(base):
                item = emit(path, "其他技能的输出")
                if item:
                    yield item
    # 2. the skill repositories: experience, knowledge, references and the main documents
    if part != "internal" and repos_root.is_dir():
        for entry in sorted(os.listdir(lp(repos_root))):
            repo = repos_root / entry
            if not (entry.lower().startswith("luz-") and repo.is_dir()):
                continue
            for name in ("SKILL.md", "README.md", "WORKFLOW.md"):
                if (repo / name).is_file():
                    item = emit(str(repo / name), "技能文档")
                    if item:
                        yield item
            for sub in ("experience", "knowledge", "references"):
                if (repo / sub).is_dir():
                    for path in walk_files(repo / sub):
                        item = emit(path, "技能文档")
                        if item:
                            yield item
            if entry.lower() == "luz-crawl" and (repo / "data" / "memory").is_dir():
                memory = repo / "data" / "memory"
                for sub in sorted(os.listdir(lp(memory))):
                    target = memory / sub
                    if target.is_file() and target.suffix == ".json":
                        item = emit(str(target), "Crawl 本机记忆")
                        if item:
                            yield item
                    elif target.is_dir() and sub in ("events", "pending", "active-tasks", "task-bindings", "execution"):
                        for path in walk_files(target, exts={".json"}):
                            item = emit(path, "Crawl 本机记忆")
                            if item:
                                yield item
    # 3. the records inside the Luz-Crawl output itself
    skip = set(CRAWL_SKIP_FILES) if not include_content else set()
    for path in walk_files(root, skip_dirs=CRAWL_SKIP_DIRS, skip_files=skip, exts={".json"}) if part != "external" else ():
        item = emit(path, "Crawl 自身记录")
        if item:
            yield item


def collect_hits(files, rewriter: Rewriter, progress=None):
    """Dry-run scan: how many files and references would change."""
    stats: dict[str, list[int]] = {}
    samples = []
    count = 0
    for path, group in files:
        count += 1
        if progress and count % 2000 == 0:
            progress(f"  已扫描 {count} 个文件")
        try:
            if os.path.getsize(path) > MAX_BYTES:
                continue
            data = Path(path).read_bytes()
        except OSError:
            continue
        text, _ = decode(data)
        if text is None or "Luz-Crawl" not in text and rewriter.root.name not in text:
            continue
        _, edits = rewriter.rewrite(text)
        if edits:
            row = stats.setdefault(group, [0, 0])
            row[0] += 1
            row[1] += len(edits)
            if len(samples) < 8:
                samples.append((path, edits[0][1], edits[0][2]))
    return stats, samples, count


# ----------------------------------------------------------------------------------------------- applying
class Applier:
    def __init__(self, plan: Plan, root: Path, args):
        self.plan = plan
        self.root = root
        self.args = args
        self.journal = Journal(root)
        self.record_raw = root / RECORD_DIR / "raw"
        self.journal.file = self.record_raw / RECORD_NAME
        self.backup = None   # folder with the manifests and markers as they were (needed to revert)
        self.state: dict[str, dict] = {}   # final path -> {"orig": sha, "cur": sha, "passes": [...], "bom": bool}
        self.say = args.say
        self.stats = {}

    # -- journalled primitives
    def op(self, **item):
        self.journal.data.setdefault("ops", []).append(item)

    def mkdir(self, path):
        if not Path(lp(path)).exists():
            os.makedirs(lp(path), exist_ok=True)
            self.op(t="mkdir", path=str(path))

    def move(self, src, dst, kind):
        if Path(lp(dst)).exists():
            raise RuntimeError(f"目标已存在，停止：{dst}")
        parent = Path(dst).parent
        if not Path(lp(parent)).exists():
            self.mkdir(parent)
        rename(src, dst)
        self.op(t="move", **{"from": str(src), "to": str(dst)}, kind=kind)

    def move_aside(self, src, dst, kind, aside_dir):
        """Like move(), but when a current-layout file of that name is already there (a task that kept running on the new
        code), the older file is kept next to it as '<name>.旧版<ext>' instead of stopping the migration."""
        if not Path(lp(dst)).exists():
            return self.move(src, dst, kind)
        name = Path(src).name
        suffix = Path(name).suffix
        stem = name[: len(name) - len(suffix)]
        number, target = 0, Path(aside_dir) / f"{stem}.旧版{suffix}"
        while Path(lp(target)).exists():
            number += 1
            target = Path(aside_dir) / f"{stem}.旧版{number}{suffix}"
        self.move(src, target, kind + "（目标已有同名文件，旧文件改名保留）")
        self.journal.data["notes"].append(f"{dst} 已存在，旧文件保存为 {target}")

    def rmdir(self, path):
        try:
            os.rmdir(lp(path))
        except OSError:
            return False
        self.op(t="rmdir", path=str(path))
        return True

    # -- phases
    def run(self):
        plan, root, say = self.plan, self.root, self.say
        self.mkdir(root / RECORD_DIR)
        self.mkdir(self.record_raw)
        self.backup = self.record_raw / "原清单备份"
        self.journal.data["status"] = "running"
        self.journal.data["plan_counts"] = plan.counts
        self.journal.save()
        legacy_raw = root / LEGACY_PAGES / "raw"
        self.mkdir(root / LEGACY_PAGES)
        self.mkdir(legacy_raw)
        say("1/6 第二代任务文件夹改号")
        for old, new in plan.gen2:
            self.move(root / old, root / new, "第二代改号")
            html_name = plan.gen2_html.get(old)
            if html_name:
                self.move(root / new / html_name, root / new / f"{new}.html", "第二代网页改名")
                self.fix_gen2_names(root / new, html_name, f"{new}.html")
        self.journal.save()
        say("2/6 第三代任务文件夹移到输出根，页面存档展平")
        done = 0
        for task in plan.tasks.values():
            self.convert_task(task)
            done += 1
            if done % 10 == 0:
                self.journal.save()
        say("3/6 散落网页与其他条目归档")
        for name, home in plan.loose.items():
            if not home and (root / name).exists():
                self.move(root / name, legacy_raw / name, "散落网页")
        for name in plan.other_dirs + plan.other_files:
            if (root / name).exists():
                self.move(root / name, legacy_raw / name, "其他条目")
        if plan.has_task_state:
            self.move(root / "raw" / "tasks", self.record_raw / OLD_TASK_STATE, "旧任务状态")
        if plan.has_legacy_raw and not self.rmdir(root / "raw"):
            self.journal.data["notes"].append("输出根下的 raw 文件夹没有清空，已保留，请人工检查")
        self.journal.save()

    def fix_gen2_names(self, folder, old_html, new_html):
        pairs = [(json.dumps(old_html, ensure_ascii=ascii_only), json.dumps(new_html, ensure_ascii=ascii_only)) for ascii_only in (False, True)]
        for name in ("manifest.json", "collection.json"):
            path = folder / "raw" / name
            if path.is_file():
                data = path.read_bytes()
                text, bom = decode(data)
                if text is None:
                    continue
                fixed = text
                for quoted_old, quoted_new in pairs:
                    fixed = fixed.replace(quoted_old, quoted_new)
                if fixed != text:
                    self.store_original(path, data)
                    path.write_bytes(encode(fixed, bom))
                    self.note_change(path, data, encode(fixed, bom), structural=True)

    def convert_task(self, task: TaskPlan):
        root = self.root
        folder = root / task.name
        self.move(root / "raw" / task.name, folder, "第三代任务")
        raw = folder / "raw"
        if not Path(lp(raw)).exists():
            self.mkdir(raw)
        for entry in task.moved:
            self.move_aside(folder / entry, raw / entry, "任务级记录", raw)
        if "luz-task.json" in task.moved and (raw / "luz-task.json").is_file():
            self.rewrite_marker(raw / "luz-task.json")
        if task.summary_at == "top":
            self.move_aside(folder / SUMMARY_OLD, folder / f"{task.name}.html", "任务总结", raw)
        elif task.summary_at == "raw":
            self.move_aside(raw / SUMMARY_OLD, folder / f"{task.name}.html", "任务总结", raw)
        for archive, info in task.archives.items():
            self.flatten(raw / archive, archive, info, task.name)

    def rewrite_marker(self, path: Path):
        data = path.read_bytes()
        text, bom = decode(data)
        try:
            value = json.loads(text)
        except (TypeError, ValueError):
            self.journal.data["notes"].append(f"任务标记无法解析，未改写：{path}")
            return
        if not isinstance(value, dict) or value.get("delivery_layout") == "task_folder_v2":
            return
        value["delivery_layout"] = "task_folder_v2"
        new = encode(json.dumps(value, ensure_ascii=False, indent=2) + "\n", bom)
        self.store_original(path, data)
        path.write_bytes(new)
        self.note_change(path, data, new, structural=True)

    def flatten(self, archive_dir: Path, archive: str, info: dict, task: str):
        inner = archive_dir / "raw"
        for entry in sorted(os.listdir(lp(inner))):
            self.move(inner / entry, archive_dir / entry, "页面存档展平")
        self.rmdir(inner)
        html_name = info.get("html")
        moved_html = None
        if html_name and (self.root / html_name).is_file():
            self.move(self.root / html_name, archive_dir / html_name, "页面网页")
            moved_html = archive_dir / html_name
        self.convert_manifest(archive_dir, archive, task, moved_html)

    def convert_manifest(self, archive_dir: Path, archive: str, task: str, html_path):
        path = archive_dir / "manifest.json"
        data = path.read_bytes()
        text, bom = decode(data)
        try:
            manifest = json.loads(text)
        except (TypeError, ValueError):
            self.journal.data["notes"].append(f"页面清单无法解析，未改写：{path}")
            return
        for key in ("files", "pruned_files"):
            for item in manifest.get(key) or []:
                if isinstance(item, dict) and str(item.get("path", "")).startswith("raw/"):
                    item["path"] = item["path"][4:]
        delivery = manifest.pop("delivery", None)
        manifest.pop("related_deliveries", None)
        primary = manifest.get("primary_file")
        if html_path is not None and primary:
            if manifest.get("delivery_media") or (delivery or {}).get("sha256") is None:
                self.fix_html_links(html_path, task, archive)
                delivery = None
            size = html_path.stat().st_size
            digest = (delivery or {}).get("sha256") or sha(html_path.read_bytes())
            if not any(isinstance(i, dict) and i.get("path") == html_path.name for i in manifest.get("files") or []):
                manifest.setdefault("files", []).append({"path": html_path.name, "bytes": size, "sha256": digest})
            else:
                for item in manifest["files"]:
                    if item.get("path") == html_path.name:
                        item.update(bytes=size, sha256=digest)
            manifest["output_layout"] = "archive_html_v2"
        elif manifest.get("output_layout") == "html_and_raw_v1":
            manifest.pop("output_layout", None)
        new = encode(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", bom)
        self.store_original(path, data)
        path.write_bytes(new)
        self.note_change(path, data, new, structural=True)

    def fix_html_links(self, html_path: Path, task: str, archive: str):
        """Links the old page wrote relative to the output root point into the page folder now."""
        from urllib.parse import quote

        def enc(value):
            return quote(value, safe="-_.!~*'()")

        prefix = f"raw/{enc(task)}/raw/{enc(archive)}/raw/"
        data = html_path.read_bytes()
        text, bom = decode(data)
        if text is None or prefix not in text:
            return
        edits, out, pos, written = [], [], 0, 0
        for m in re.finditer(re.escape(prefix), text):
            out.append(text[pos:m.start()])
            written += m.start() - pos
            edits.append((written, prefix, ""))
            pos = m.end()
        out.append(text[pos:])
        new = encode("".join(out), bom)
        html_path.write_bytes(new)
        self.note_change(html_path, data, new, passes=[edits])

    # -- bookkeeping of what changed and what its hash used to be
    def store_original(self, path, data):
        target = self.backup / Path(path).relative_to(self.root)
        target.parent.mkdir(parents=True, exist_ok=True)
        Path(lp(target)).write_bytes(data)

    def note_change(self, path, old: bytes, new: bytes, structural=False, passes=None):
        key = os.path.normcase(os.path.abspath(path))
        item = self.state.setdefault(key, {"file": str(path), "orig": sha(old), "passes": [], "structural": False, "bom": old.startswith(b"\xef\xbb\xbf"), "history": set()})
        item["history"].add(sha(old))
        item["cur"] = sha(new)
        item["structural"] = item["structural"] or structural
        if passes:
            item["passes"].extend(passes)

    # -- references written as absolute paths in text files
    def rewrite_references(self, rewriter: Rewriter, files, seed=None, skip=None):
        """seed: {old sha: new sha} of files rewritten by an earlier run; skip(path): files that must stay as they are."""
        say = self.say
        seed = seed or {}
        tokens: dict[str, tuple] = {}
        group_stats: dict[str, list[int]] = {}
        samples: list[tuple] = []
        skipped: dict[str, list[str]] = {}
        seen = 0
        rng = random.Random(20261104)
        record_dir = os.path.normcase(str(self.root / RECORD_DIR))
        for path, group in files:
            if os.path.normcase(os.path.abspath(path)).startswith(record_dir):
                continue
            if skip and skip(path):
                continue
            try:
                if os.path.getsize(path) > MAX_BYTES:
                    skipped.setdefault("超过 20 MB", []).append(path)
                    continue
                data = Path(path).read_bytes()
            except OSError:
                skipped.setdefault("读取失败", []).append(path)
                continue
            if not rewriter.worth_reading(data):
                continue
            text, bom = decode(data)
            if text is None:
                skipped.setdefault("不是 UTF-8 文本", []).append(path)
                continue
            new_text, passes = rewriter.rewrite_passes(text)
            if passes:
                new = encode(new_text, bom)
                Path(path).write_bytes(new)
                self.note_change(path, data, new, passes=passes)
                edits = [e for p in passes for e in p]
                row = group_stats.setdefault(group, [0, 0])
                row[0] += 1
                row[1] += len(edits)
                for edit in edits:
                    seen += 1
                    if len(samples) < 400:
                        samples.append((path, edit))
                    elif rng.random() < 400 / seen:
                        samples[rng.randrange(400)] = (path, edit)
            found = set(HEX64.findall(new_text))
            if found:
                tokens[os.path.normcase(os.path.abspath(path))] = (path, found)
        say(f"  路径改写：{sum(v[0] for v in group_stats.values())} 个文件，{seen} 处")
        rounds = 0
        hash_files = set()
        while rounds < 8:
            mapping = {**seed, **{h: st["cur"] for st in self.state.values() for h in st["history"] if h != st["cur"]}}
            todo = [(key, path) for key, (path, found) in tokens.items() if found & mapping.keys()]
            if not todo:
                break
            changed = False
            for key, path in todo:
                data = Path(path).read_bytes()
                text, bom = decode(data)
                new_text, edits = replace_hashes(text, mapping)
                if edits:
                    new = encode(new_text, bom)
                    Path(path).write_bytes(new)
                    self.note_change(path, data, new, passes=[edits])
                    hash_files.add(key)
                    changed = True
                tokens[key] = (path, set(HEX64.findall(new_text)))
            rounds += 1
            if not changed:
                break
        say(f"  哈希同步：{len(hash_files)} 个文件，{rounds} 轮")
        self.stats = {"reference_files": {k: {"files": v[0], "references": v[1]} for k, v in group_stats.items()},
                      "skipped_files": {k: {"count": len(v), "examples": v[:5]} for k, v in skipped.items()},
                      "hash_updated_files": len(hash_files), "hash_rounds": rounds}
        return samples

    def hash_changes(self):
        """{earlier hash: latest hash} of the files rewritten in this run, for the later parts of a project run."""
        return {h: st["cur"] for st in self.state.values() for h in st["history"] if h != st["cur"]}

    def collect_rewrites(self):
        records = []
        for item in self.state.values():
            if item["passes"] or item["structural"]:
                records.append({"file": item["file"], "orig_sha256": item["orig"], "sha256": item["cur"], "structural": item["structural"], "bom": item["bom"], "passes": item["passes"]})
        return records

    def write_rewrites(self):
        self.journal.data["rewrites"] = self.collect_rewrites()


# ----------------------------------------------------------------------------------------------- checks
def load_preflight():
    sys.path.insert(0, str(HERE))
    try:
        import crawl_preflight
        return crawl_preflight
    except Exception:
        return None


def find_records(files):
    records = []
    for path, _ in files:
        p = Path(path)
        if p.suffix == ".json" and p.parent.name == "00-crawl" and p.parent.parent.name == "raw":
            records.append(p)
    return sorted(set(records))


def check_records(records, module):
    """Run the real gate on every preflight record found; returns {record: [errors]} and a list of archive problems."""
    result, archives = {}, []
    for record in records:
        value = read_json(record)
        if not isinstance(value, dict) or "caller" not in value or "sources" not in value:
            continue
        session = record.parent.parent.parent
        stage = value.get("stage")
        try:
            errors = module.validate_preflight(session, value["caller"], stage) if module else []
        except Exception as error:  # a record that cannot even be read counts as failing
            errors = [f"检查异常：{error}"]
        result[str(record)] = errors
        for source in value.get("sources") or []:
            archive = Path(str(source.get("archive", "")))
            ok = archive.is_dir() and any((archive / n / "content.json").is_file() for n in ("", "raw"))
            archives.append((str(record), str(archive), ok))
    return result, archives


def sample_exists(samples, root: Path, count=30):
    """Pick references we rewrote and make sure the file they now name is really there."""
    rng = random.Random(7)
    picked = rng.sample(samples, min(count, len(samples)))
    rows = []

    def absolute(text):
        text = re.sub(r"[\\/]+", lambda _: os.sep, text)
        lowered = text.lower()
        if lowered.startswith(root.parent.name.lower() + os.sep):
            return str(root.parent.parent / text)
        if lowered.startswith(root.name.lower() + os.sep):
            return str(root.parent / text)
        return text

    for path, (offset, old, new) in picked:
        text, _ = decode(Path(path).read_bytes())
        if text is None or "\\u" in new:
            continue
        start = offset + len(new)
        tail = re.split(r"[\"'<>|\r\n]", text[start:start + 260], maxsplit=1)[0]
        base = absolute(new)
        full = absolute(new + tail)
        while len(full) > len(base) and not os.path.exists(lp(full)):
            full = full[:-1]
        rows.append((path, new, full, os.path.exists(lp(full))))
    return rows


# ----------------------------------------------------------------------------------------------- report page
def render_report(root: Path, plan: Plan, journal: Journal, verify: dict, samples_ok):
    module = load_preflight()
    moves = [o for o in journal.data.get("ops", []) if o["t"] == "move"]
    kinds: dict[str, int] = {}
    for o in moves:
        kinds[o["kind"]] = kinds.get(o["kind"], 0) + 1
    esc = (module.esc if module else html.escape)
    table = module.formal_table if module else None
    css = module.STYLE.read_text(encoding="utf-8").strip() if module else ""
    rows_count = [[k, str(v)] for k, v in plan.counts.items()]
    rows_moves = [[k, str(v)] for k, v in sorted(kinds.items())]
    stats = journal.data["stats"]
    rows_refs = [[k, str(v["files"]), str(v["references"])] for k, v in (stats.get("reference_files") or {}).items()] or [["（没有需要改写的引用）", "0", "0"]]
    rows_gen2 = [[old, new] for old, new in plan.gen2] or [["（无）", ""]]
    rows_verify = [[k, str(v)] for k, v in verify.items()]
    before = "<pre>" + esc("<输出根>\\\n  raw\\NNN_主题\\{luz-task.json, preflight.json, search-*.json, raw\\{NNNN_标题\\raw\\*, 爬取总结.html}}\n  NNN-主题\\{NNN-主题.html, raw\\}\n  NNNN_标题.html × 数千 + 分类文件夹\\\n  raw\\tasks\\") + "</pre>"
    after = "<pre>" + esc("<输出根>\\\n  NNN_主题\\raw\\{luz-task.json, preflight.json, search-*.json, NNNN_标题\\{content.json, manifest.json, …, NNNN_标题.html}}（已有任务保留原名）\n  NNN_主题\\NNN_主题.html\n  NNN-主题\\{raw\\, NNN-主题.html}（改号的任务）\n  000_旧版散落网页存档\\raw\\{无存档的旧网页, 分类文件夹\\}\n  000_目录整理记录\\{raw\\{移动记录.json, 旧版任务状态\\}, 000_目录整理记录.html}") + "</pre>"
    if table is None:
        body = "<p>未找到 crawl_preflight.py，报告只含文字。</p>"
    else:
        body = (
            "<section><h2>迁移前后结构</h2>" + before + after + "</section>"
            + "<section><h2>条目数量</h2>" + table(1, "迁移前各类条目", ["类别", "数量"], rows_count, centered=(1,)) + "</section>"
            + "<section><h2>实际移动</h2>" + table(2, "按类别统计的移动次数", ["类别", "次数"], rows_moves or [["（无）", "0"]], centered=(1,)) + "</section>"
            + "<section><h2>第二代任务改号</h2>" + table(3, "旧名与新名", ["旧文件夹", "新文件夹"], rows_gen2) + "</section>"
            + "<section><h2>引用改写</h2>" + table(4, "按来源统计", ["范围", "文件数", "引用处数"], rows_refs, centered=(1, 2)) + "</section>"
            + "<section><h2>核对结果</h2>" + table(5, "迁移后的核对", ["项目", "结果"], rows_verify) + "</section>"
            + f"<section><h2>映射文件</h2><p>全部移动、改写与哈希变化记录在 {esc(RECORD_NAME)}（同一文件夹）。撤回：py -X utf8 scripts/migrate_layout.py --root &lt;输出根&gt; --revert &lt;{esc(RECORD_NAME)}&gt;。</p></section>"
        )
    icon = module.ICON if module else ""
    csp = module.CSP if module else "default-src 'none'; style-src 'unsafe-inline'"
    page = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="{esc(csp)}"><meta name="referrer" content="no-referrer">'
            f'<link rel="icon" href="{icon}"><title>目录整理记录</title><style>{css}\npre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head>'
            f'<body><main><h1>目录整理记录</h1>{body}</main></body></html>\n')
    target = root / RECORD_DIR / f"{RECORD_DIR}.html"
    target.write_text(page, encoding="utf-8")
    return target


# ----------------------------------------------------------------------------------------------- projects outside the output root
# Luz projects (<dir>\NNN-名称, with project.json) and other folders keep absolute archive paths in their records. After a
# migration they are rewritten from the exact old names kept in 移动记录.json, without touching what an approval is bound to.
def plan_from_journal(data: dict) -> Plan:
    """The old names of a finished migration, rebuilt from the moves it recorded."""
    root = Path(data["root"])
    plan = Plan(root)
    plan.has_legacy_raw = True
    for op in data.get("ops", []):
        if op.get("t") != "move":
            continue
        kind = op.get("kind", "")
        src, dst = Path(op["from"]), Path(op["to"])
        try:
            a = src.relative_to(root).parts
            b = dst.relative_to(root).parts
        except ValueError:
            continue
        if kind.startswith("第二代改号"):
            plan.gen2.append((a[0], b[0]))
        elif kind.startswith("第二代网页改名"):
            plan.gen2_html[a[1][: -len(".html")]] = a[1]
        elif kind.startswith("第三代任务"):
            plan.tasks.setdefault(a[1], TaskPlan(a[1]))
        elif kind.startswith("任务级记录") and len(a) == 2 and a[0] in plan.tasks:
            plan.tasks[a[0]].moved[a[1]] = "file"
        elif kind.startswith("任务总结") and a[0] in plan.tasks:
            plan.tasks[a[0]].summary_at = "top" if len(a) == 2 else "raw"
        elif kind.startswith("页面存档展平") and len(a) >= 5 and a[0] in plan.tasks:
            plan.tasks[a[0]].archives.setdefault(a[2], {"primary": None})
        elif kind.startswith("页面网页") and len(a) == 1 and len(b) >= 4:
            plan.loose[a[0]] = (b[0], b[2])
        elif kind.startswith("散落网页") and len(a) == 1:
            plan.loose[a[0]] = None
        elif kind.startswith("其他条目") and len(a) == 1:
            (plan.other_dirs if dst.is_dir() else plan.other_files).append(a[0])
        elif kind.startswith("旧任务状态"):
            plan.has_task_state = True
    return plan


def norm(path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def discover_projects(base: Path):
    """Folders directly under base that are Luz projects (project.json with stages)."""
    found = []
    if base.is_dir():
        for entry in sorted(os.listdir(lp(base))):
            candidate = base / entry
            manifest = read_json(candidate / "project.json") if (candidate / "project.json").is_file() else None
            if isinstance(manifest, dict) and isinstance(manifest.get("stages"), list):
                found.append(candidate)
    return found


def bound_info(project: Path):
    """What the approvals of a Luz project are tied to: artifact files of approved stages, tracked sources, the ledger itself."""
    manifest = read_json(project / "project.json")
    if not (isinstance(manifest, dict) and isinstance(manifest.get("stages"), list)):
        return None
    artifacts = read_json(project / "data" / "artifacts.json")
    artifacts = artifacts if isinstance(artifacts, list) else []
    stages = [s for s in manifest["stages"] if isinstance(s, dict)]
    approved = {str(s.get("id")) for s in stages if s.get("status") in ("approved", "completed") or s.get("approval_id") or s.get("approved_hashes")}
    paths: dict[str, str] = {norm(project / "APPROVALS.json"): "审批台账"}
    for item in artifacts:
        if isinstance(item, dict) and str(item.get("stage")) in approved and item.get("path"):
            paths[norm(project / str(item["path"]))] = f"{item.get('stage')} 阶段已审批产物（{item.get('kind')}）"
    ledger: set[str] = set()
    ledger_file = project / "APPROVALS.json"
    if ledger_file.is_file():
        text, _ = decode(ledger_file.read_bytes())
        ledger |= set(HEX64.findall(text or ""))
    for stage in stages:
        if str(stage.get("id")) not in approved:
            continue
        for rel, digest in (stage.get("approved_sources") or {}).items():
            paths[norm(project / rel)] = f"{stage.get('id')} 阶段已审批的来源数据"
            ledger.add(str(digest))
        ledger |= {str(v) for v in (stage.get("approved_hashes") or {}).values()}
    return {"paths": paths, "ledger": ledger, "approved": sorted(approved), "stages": [str(s.get("id")) for s in stages],
            "artifacts": [{"path": a.get("path"), "stage": a.get("stage"), "kind": a.get("kind")} for a in artifacts if isinstance(a, dict) and str(a.get("stage")) in approved]}


def protect(files_info: dict, bound: dict):
    """Files that must stay as they are: bound by path or by hash to an approval, and everything those files vouch for by hash
    (the logs of a frozen preflight record, the data a frozen document was made from)."""
    protected = dict(bound["paths"])
    for key, item in files_info.items():
        if item["sha"] in bound["ledger"] and key not in protected:
            protected[key] = "哈希被审批台账记录"
    changed = True
    while changed:
        changed = False
        vouched = set()
        for key in protected:
            if key in files_info:
                vouched |= files_info[key]["tokens"]
        for key, item in files_info.items():
            if key not in protected and item["sha"] in vouched:
                protected[key] = "被已冻结文件按哈希引用（如日志、文档的数据来源）"
                changed = True
    return protected


def prepass(paths, rewriter: Rewriter):
    """Hash, hex tokens and number of old paths for every text file (nothing is written)."""
    info, skipped = {}, {}
    for path in paths:
        try:
            if os.path.getsize(path) > MAX_BYTES:
                skipped.setdefault("超过 20 MB", []).append(path)
                continue
            data = Path(path).read_bytes()
        except OSError:
            skipped.setdefault("读取失败", []).append(path)
            continue
        if not rewriter.worth_reading(data):
            info[norm(path)] = {"path": path, "sha": sha(data), "tokens": set(), "hits": 0}
            continue
        text, _ = decode(data)
        if text is None:
            skipped.setdefault("不是 UTF-8 文本", []).append(path)
            continue
        _, edits = rewriter.rewrite(text)
        info[norm(path)] = {"path": path, "sha": sha(data), "tokens": set(HEX64.findall(text)), "hits": len(edits)}
    return info, skipped


def project_checks(project: Path, project_py: Path, stages):
    """The project's own gates: check, and gate for every stage. Returns {name: [errors]}."""
    results = {}

    def call(name, *argv):
        done = subprocess.run([sys.executable, "-X", "utf8", str(project_py), *argv], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, cwd=str(project_py.parent))
        try:
            results[name] = list(json.loads(done.stdout).get("errors", []))
        except ValueError:
            results[name] = [f"无法解析输出：{(done.stdout or done.stderr)[:200]}"]

    call("check", "check", str(project))
    for stage in stages:
        call(f"gate:{stage}", "gate", str(project), stage)
    return results


def _plain(error: str) -> str:
    return re.sub(r"[A-Za-z]:[\\/][^\s'\"，。；）]*", "<路径>", re.sub(r"\\\\+", r"\\", str(error)))


def compare_checks(before: dict, after: dict):
    """New problems = messages (paths blanked out) that were not there before; fixed = the other way round."""
    new, fixed = {}, {}
    for name in sorted(set(before) | set(after)):
        a = {_plain(e) for e in before.get(name, [])}
        b = {_plain(e) for e in after.get(name, [])}
        if b - a:
            new[name] = sorted(b - a)
        if a - b:
            fixed[name] = sorted(a - b)
    return new, fixed


def rewrite_extra(args, say):
    journal_path = Path(args.rewrite_with).resolve()
    data = json.loads(journal_path.read_text(encoding="utf-8"))
    root = Path(data["root"])
    plan = plan_from_journal(data)
    rewriter = Rewriter(plan, root)
    seed = {}
    for record in journal_records(data):
        if record.get("orig_sha256") and record.get("orig_sha256") != record.get("sha256"):
            seed[record["orig_sha256"]] = record["sha256"]
    seed = chain_closure(seed)
    roots = [Path(p).resolve() for p in (args.extra_root or [])]
    for base in args.discover_projects or []:
        roots += [p.resolve() for p in discover_projects(Path(base)) if p.resolve() not in roots]
    if not roots:
        print("没有指定要改写的目录：用 --extra-root 或 --discover-projects", file=sys.stderr)
        return 2
    say(f"映射来自 {journal_path}：{len(plan.tasks)} 个任务、{len(plan.gen2)} 个改号、{len(plan.loose)} 个网页；已有 {len(seed)} 条哈希变化")
    module = None if args.skip_checks else load_preflight()
    project_py = Path(args.project_py) if args.project_py else HERE.parent.parent / "Luz-Project" / "scripts" / "project.py"
    if args.apply:
        shutil.copyfile(journal_path, journal_path.with_name(f"移动记录.追加前-{datetime.now().strftime('%Y%m%dT%H%M%S')}.json"))
    exit_code = 0
    for project in roots:
        if not project.is_dir():
            print(f"目录不存在，跳过：{project}", file=sys.stderr)
            continue
        say(f"\n=== {project}")
        started = time.time()
        paths = list(walk_files(project))
        info, skipped = prepass(paths, rewriter)
        bound = bound_info(project)
        protected = protect(info, bound) if bound else {}
        blocked = [{"file": info[k]["path"], "reason": why, "references": info[k]["hits"]} for k, why in protected.items() if k in info and info[k]["hits"]]
        loose_hits = sum(v["hits"] for k, v in info.items() if k not in protected)
        loose_files = sum(1 for k, v in info.items() if k not in protected and v["hits"])
        say(f"  文本文件 {len(info)} 个；含旧路径且可改写 {loose_files} 个、{loose_hits} 处；被审批绑定或冻结而不改 {len(blocked)} 个、{sum(b['references'] for b in blocked)} 处")
        for item in blocked[:12]:
            say(f"    未改：{item['file']}（{item['reason']}，{item['references']} 处）")
        if len(blocked) > 12:
            say(f"    …另有 {len(blocked) - 12} 个")
        if bound:
            say(f"  已审批阶段：{'、'.join(bound['approved']) or '无'}；审批绑定的产物 {len(bound['artifacts'])} 个")
        records = find_records(((p, "") for p in paths)) if module else []
        before_records, _ = check_records(records, module) if module else ({}, [])
        before_project = {}
        if bound and not args.skip_project_checks:
            before_project = project_checks(project, project_py, bound["stages"])
            say(f"  项目自带检查（改写前）：{sum(1 for v in before_project.values() if not v)}/{len(before_project)} 项无问题")
        say(f"  前置检索记录：{len(before_records)} 条，当前通过 {sum(1 for v in before_records.values() if not v)} 条")
        if not args.apply:
            continue
        applier = Applier(plan, root, args)
        applier.journal.data = data
        applier.journal.file = journal_path
        samples = applier.rewrite_references(rewriter, ((p, "项目") for p in paths), seed=seed, skip=lambda p: norm(p) in protected)
        run = {"root": str(project), "kind": "项目" if bound else "目录", "started_at": now(), "rewrites": applier.collect_rewrites(), "protected_with_old_paths": blocked,
               "bound_artifacts": bound["artifacts"] if bound else [], "approved_stages": bound["approved"] if bound else [], "stats": applier.stats}
        for record in run["rewrites"]:
            if record.get("orig_sha256") != record.get("sha256"):
                seed[record["orig_sha256"]] = record["sha256"]
        seed = chain_closure(seed)
        after_info, _ = prepass(list(walk_files(project)), rewriter)
        left = sum(v["hits"] for k, v in after_info.items() if k not in protected)
        rows = sample_exists(samples, root)
        after_records, _ = check_records(find_records(((p, "") for p in walk_files(project))), module) if module else ({}, [])
        broke = [r for r, errors in after_records.items() if errors and not before_records.get(r, ["未检查"])]
        after_project = project_checks(project, project_py, bound["stages"]) if bound and not args.skip_project_checks else {}
        new_problems, fixed = compare_checks(before_project, after_project) if before_project else ({}, {})
        run["verify"] = {"遗留旧路径（未冻结的文件，应为 0）": left, "抽查引用指向的文件存在": f"{sum(1 for r in rows if r[3])}/{len(rows)}",
                         "前置检索记录通过数（改写前 → 后）": f"{sum(1 for v in before_records.values() if not v)} → {sum(1 for v in after_records.values() if not v)}（共 {len(after_records)} 条）",
                         "改写后新出现的前置检索失败": broke, "项目自带检查新增问题": new_problems, "项目自带检查消除的问题": fixed}
        run["checks"] = {"before": before_project, "after": after_project}
        run["finished_at"] = now()
        data.setdefault("extra_runs", []).append(run)
        applier.journal.save()
        write_compat_index(journal_path, data)
        for key, value in run["verify"].items():
            say(f"  {key}: {value if not isinstance(value, (dict, list)) else (len(value) if value else 0)}")
        say(f"  用时 {time.time() - started:.0f} 秒")
        if left or new_problems or broke:
            exit_code = 1
    return exit_code


def chain_closure(mapping: dict) -> dict:
    """{a: b, b: c} becomes {a: c, b: c}: whoever kept an earlier hash gets the latest one."""
    out = {}
    for key, value in mapping.items():
        for _ in range(32):
            if value in mapping and mapping[value] != value:
                value = mapping[value]
            else:
                break
        out[key] = value
    return {k: v for k, v in out.items() if k != v}


def journal_records(data: dict):
    return [*data.get("rewrites", []), *(r for run in data.get("extra_runs", []) for r in run.get("rewrites", []))]


def reconcile(args, say):
    """Brings every hash that other files kept of a rewritten file up to the hash the file has now.

    A file rewritten in two steps (paths, then a hash it contained) has an intermediate hash; whoever recorded that one is
    found through the edit lists of the journal, which let each earlier state of the file be rebuilt."""
    journal_path = Path(args.reconcile_with).resolve()
    data = json.loads(journal_path.read_text(encoding="utf-8"))
    root = Path(data["root"])
    plan = plan_from_journal(data)
    rewriter = Rewriter(plan, root)
    applier = Applier(plan, root, args)
    applier.journal.data = data
    applier.journal.file = journal_path
    missing = changed_outside = 0
    for record in journal_records(data):
        path = Path(record["file"])
        if not path.is_file():
            missing += 1
            continue
        raw = path.read_bytes()
        history = {record["orig_sha256"], record["sha256"]}
        text, bom = decode(raw)
        if text is not None and sha(raw) == record["sha256"] and record.get("passes"):
            state = text
            for edits in reversed(record["passes"]):
                state = undo_edits(state, [edits])
                if state is None:
                    break
                history.add(sha(encode(state, bom)))
        elif sha(raw) != record["sha256"]:
            changed_outside += 1
        applier.state[norm(path)] = {"file": str(path), "orig": record["orig_sha256"], "passes": [], "structural": False, "bom": bom, "history": history | {sha(raw)}, "cur": sha(raw)}
    stale = {h: st["cur"] for st in applier.state.values() for h in st["history"] if h != st["cur"]}
    say(f"移动记录里改写过的文件 {len(applier.state)} 个（已不在 {missing} 个，迁移后又被改过 {changed_outside} 个）；曾经出现过、现在已不同的哈希 {len(stale)} 个")
    outputs_root = Path(args.outputs_root).resolve() if args.outputs_root else root.parent
    repos_root = Path(args.repos_root).resolve() if args.repos_root else HERE.parent.parent
    external = list(scope_files(root, repos_root, outputs_root, root, args.include_content, "external"))
    files = lambda: itertools.chain(external, scope_files(root, repos_root, outputs_root, root, args.include_content, "internal"))  # noqa: E731
    module = None if args.skip_checks else load_preflight()
    records = find_records(files()) if module else []
    before, _ = check_records(records, module) if module else ({}, [])

    def listed_mismatches():
        """Rewritten files whose own manifest (in the same folder) records another hash."""
        found, manifests = [], {}
        for st in applier.state.values():
            path = Path(st["file"])
            if path.name == "manifest.json" or not path.is_file() or not (path.parent / "manifest.json").is_file():
                continue
            manifest = manifests.get(path.parent)
            if manifest is None:
                manifest = manifests[path.parent] = read_json(path.parent / "manifest.json") or {}
            current = sha(path.read_bytes())
            for entry in manifest.get("files", []) or []:
                if isinstance(entry, dict) and entry.get("path") == path.name and entry.get("sha256") != current:
                    found.append(str(path))
        return found

    before_listed = listed_mismatches()
    say(f"清单里登记的哈希与文件现状不符：{len(before_listed)} 个")
    if not args.apply:
        stats, examples, scanned = collect_stale(files(), stale, say)
        say(f"扫描 {scanned} 个文本文件：含过期哈希的 {stats} 个文件会被更新")
        say(f"前置检索记录：共 {len(before)} 条，当前通过 {sum(1 for v in before.values() if not v)} 条")
        return 0
    shutil.copyfile(journal_path, journal_path.with_name(f"移动记录.追加前-{datetime.now().strftime('%Y%m%dT%H%M%S')}.json"))
    started = now()
    applier.rewrite_references(rewriter, files())
    after_listed = listed_mismatches()
    after, _ = check_records(find_records(files()), module) if module else ({}, [])
    broke = [r for r, errors in after.items() if errors and not before.get(r, ["未检查"])]
    run = {"kind": "哈希对账", "root": str(root), "started_at": started, "finished_at": now(), "rewrites": applier.collect_rewrites(), "stats": applier.stats,
           "verify": {"清单登记的哈希与文件不符（对账前 → 后）": f"{len(before_listed)} → {len(after_listed)}", "前置检索记录通过数（对账前 → 后）": f"{sum(1 for v in before.values() if not v)} → {sum(1 for v in after.values() if not v)}（共 {len(after)} 条）", "对账后新出现的前置检索失败": broke}}
    data.setdefault("extra_runs", []).append(run)
    applier.journal.save()
    write_compat_index(journal_path, data)
    for key, value in run["verify"].items():
        say(f"  {key}: {value}")
    say(f"  更新了 {len(run['rewrites'])} 个文件")
    return 1 if after_listed or broke else 0


def collect_stale(files, stale: dict, say=None):
    """Read-only: how many files hold a hash that has been superseded."""
    count = scanned = 0
    for path, _ in files:
        scanned += 1
        if say and scanned % 4000 == 0:
            say(f"  已扫描 {scanned} 个文件")
        try:
            if os.path.getsize(path) > MAX_BYTES:
                continue
            text, _ = decode(Path(path).read_bytes())
        except OSError:
            continue
        if text and any(token in stale for token in HEX64.findall(text)):
            count += 1
    return count, [], scanned


def compat_index(data: dict) -> dict:
    """What a reader needs to find, from an old path, where the file lives now: the old names of the migration and the hash changes."""
    plan = plan_from_journal(data)
    hashes = {}
    for record in journal_records(data):
        if record.get("orig_sha256") and record.get("orig_sha256") != record.get("sha256"):
            hashes[record["orig_sha256"]] = record["sha256"]
    return {"schema_version": 1, "root": data["root"], "created_at": now(),
            "tasks": {name: {"moved": sorted(task.moved), "summary_at": task.summary_at, "archives": sorted(task.archives)} for name, task in plan.tasks.items()},
            "gen2": [list(pair) for pair in plan.gen2], "gen2_html": plan.gen2_html, "loose": {name: (list(home) if home else None) for name, home in plan.loose.items()},
            "other_dirs": plan.other_dirs, "other_files": plan.other_files, "has_task_state": plan.has_task_state, "hashes": chain_closure(hashes)}


def plan_from_index(index: dict) -> Plan:
    plan = Plan(Path(index["root"]))
    plan.has_legacy_raw = True
    for name, item in index["tasks"].items():
        task = plan.tasks.setdefault(name, TaskPlan(name))
        task.moved = {entry: "file" for entry in item["moved"]}
        task.summary_at = item["summary_at"]
        task.archives = {entry: {"primary": None} for entry in item["archives"]}
    plan.gen2 = [tuple(pair) for pair in index["gen2"]]
    plan.gen2_html = dict(index["gen2_html"])
    plan.loose = {name: (tuple(home) if home else None) for name, home in index["loose"].items()}
    plan.other_dirs, plan.other_files = list(index["other_dirs"]), list(index["other_files"])
    plan.has_task_state = bool(index["has_task_state"])
    return plan


def write_compat_index(journal_path: Path, data: dict | None = None) -> Path:
    """旧路径映射.json beside the journal: crawl_preflight.py reads it to resolve the old paths a frozen record still holds."""
    data = data or json.loads(journal_path.read_text(encoding="utf-8"))
    target = journal_path.with_name(INDEX_NAME)
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(compat_index(data), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(temp, target)
    return target


# ----------------------------------------------------------------------------------------------- revert
def revert(journal_path: Path, say=print, extra_only=False):
    data = json.loads(journal_path.read_text(encoding="utf-8"))
    root = Path(data["root"])
    warnings = []
    say(f"撤回 {journal_path}" + ("（只撤回追加的项目改写）" if extra_only else ""))

    def undo_rewrites(records):
        for item in reversed(records):
            path = Path(item["file"])
            if not path.is_file():
                warnings.append(f"改写过的文件已不在：{path}")
                continue
            raw = path.read_bytes()
            text, bom = decode(raw)
            restored = undo_edits(text, item["passes"]) if text is not None and item["passes"] else text
            if restored is None:
                warnings.append(f"文件在迁移后又被改过，未撤回文字改写：{path}")
                continue
            path.write_bytes(encode(restored, bom))

    for run in reversed(data.get("extra_runs", [])):
        undo_rewrites(run.get("rewrites", []))
        say(f"  已撤回对 {run.get('root')} 的改写")
    if extra_only:
        data["extra_runs_reverted_at"] = now()
        data["extra_runs_reverted"] = data.get("extra_runs", [])
        data["extra_runs"] = []
        journal_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        for line in warnings:
            say("警告：" + line)
        say("撤回完成" + ("，有警告" if warnings else ""))
        return warnings
    undo_rewrites(data.get("rewrites", []))
    backup = journal_path.parent / "原清单备份"
    if backup.is_dir():
        for current, _, names in os.walk(backup):
            for name in names:
                source = Path(current) / name
                target = root / source.relative_to(backup)
                if target.parent.is_dir():
                    Path(lp(target)).write_bytes(Path(lp(source)).read_bytes())
    for item in reversed(data.get("ops", [])):
        if item["t"] == "move":
            if os.path.exists(lp(item["to"])) and not os.path.exists(lp(item["from"])):
                rename(item["to"], item["from"])
            else:
                warnings.append(f"无法移回：{item['to']} → {item['from']}")
        elif item["t"] == "rmdir":
            os.makedirs(lp(item["path"]), exist_ok=True)
        elif item["t"] == "mkdir":
            try:
                os.rmdir(lp(item["path"]))
            except OSError:
                if Path(item["path"]).name != RECORD_DIR and Path(item["path"]).name != "raw":
                    warnings.append(f"文件夹不为空，保留：{item['path']}")
    data["status"] = "reverted"
    data["reverted_at"] = now()
    data["revert_warnings"] = warnings
    target = journal_path
    if journal_path.exists():
        journal_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for line in warnings:
        say("警告：" + line)
    say("撤回完成" + ("，有警告" if warnings else ""))
    return warnings


# ----------------------------------------------------------------------------------------------- command line
def print_plan(plan: Plan, say):
    say("\n计划")
    for key, value in plan.counts.items():
        say(f"  {key}: {value}")
    if plan.gen2:
        say("  第二代改号：")
        for old, new in plan.gen2:
            say(f"    {old}  ->  {new}")
    if plan.warnings:
        say(f"\n提示（{len(plan.warnings)}）")
        for line in plan.warnings[:12]:
            say("  " + line)
    if plan.blockers:
        say(f"\n阻止执行的问题（{len(plan.blockers)}）")
        for line in plan.blockers[:20]:
            say("  " + line)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=DEFAULT_ROOT, help="Luz-Crawl 输出根（默认 D:\\Codes\\skill输出\\Luz-Crawl）")
    parser.add_argument("--apply", action="store_true", help="真正移动并改写；不加只预览")
    parser.add_argument("--revert", metavar="移动记录.json", help="按映射文件撤回一次迁移")
    parser.add_argument("--outputs-root", help="其他技能输出所在目录，默认是输出根的上一级")
    parser.add_argument("--repos-root", help="各 Luz 技能仓库所在目录，默认是本技能的上一级")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--include-content", action="store_true", help="改写时也读取各页面的 content.json（很慢，默认跳过）")
    parser.add_argument("--allow-live", action="store_true", help="忽略进行中的采集锁（不建议）")
    parser.add_argument("--skip-checks", action="store_true", help="跳过前置检索记录复核")
    parser.add_argument("--rewrite-with", metavar="移动记录.json", help="只改写模式：用已完成迁移的移动记录里的旧名，改写输出根之外的目录（见 --extra-root）里的绝对路径")
    parser.add_argument("--reconcile-with", metavar="移动记录.json", help="对账模式：把其他文件里记着的、已被取代的哈希更新为改写文件现在的哈希（修复清单登记的哈希与文件不符）")
    parser.add_argument("--write-index", metavar="移动记录.json", help="按移动记录生成（或刷新）同一文件夹里的 旧路径映射.json，供 crawl_preflight.py 把冻结记录里的旧路径解析到新位置")
    parser.add_argument("--extra-root", action="append", metavar="目录", help="只改写模式：要改写的目录，可重复；按给出的顺序处理")
    parser.add_argument("--discover-projects", action="append", metavar="目录", help="只改写模式：把该目录下带 project.json 的项目根也加进来，可重复")
    parser.add_argument("--project-py", help="Luz-Project 的 project.py，默认在本技能旁边的 Luz-Project/scripts")
    parser.add_argument("--skip-project-checks", action="store_true", help="只改写模式：不运行 project.py check/gate")
    parser.add_argument("--extra-only", action="store_true", help="与 --revert 合用：只撤回追加的项目改写，不动迁移本身")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    args.say = (lambda text: None) if args.quiet else (lambda text: print(text, flush=True))
    say = args.say
    if args.revert:
        return 1 if revert(Path(args.revert), say, args.extra_only) else 0
    if args.write_index:
        target = write_compat_index(Path(args.write_index).resolve())
        say(f"已写入 {target}")
        return 0
    if args.rewrite_with:
        return rewrite_extra(args, say)
    if args.reconcile_with:
        return reconcile(args, say)
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"输出根不存在：{root}", file=sys.stderr)
        return 2
    outputs_root = Path(args.outputs_root).resolve() if args.outputs_root else root.parent
    repos_root = Path(args.repos_root).resolve() if args.repos_root else HERE.parent.parent
    say(f"输出根：{root}\n模式：{'执行' if args.apply else '预览（不改动任何文件）'}")
    started = time.time()
    plan = scan(root, args.workers, say)
    if args.allow_live:
        plan.blockers = [b for b in plan.blockers if "采集锁" not in b and "临时文件" not in b]
    rewriter = Rewriter(plan, root)
    external = list(scope_files(root, repos_root, outputs_root, root, args.include_content, "external"))
    files = lambda: itertools.chain(external, scope_files(root, repos_root, outputs_root, root, args.include_content, "internal"))  # noqa: E731
    module = None if args.skip_checks else load_preflight()
    records = find_records(files()) if module else []
    before, before_archives = check_records(records, module) if module else ({}, [])
    if not args.apply:
        stats, examples, scanned = collect_hits(files(), rewriter, say)
        print_plan(plan, say)
        say(f"\n引用改写预览（扫描 {scanned} 个文本文件）")
        for group, (count, refs) in stats.items():
            say(f"  {group}: {count} 个文件，{refs} 处")
        for path, old, new in examples[:4]:
            say(f"  例：{path}\n      {old}\n   -> {new}")
        passing = sum(1 for v in before.values() if not v)
        say(f"\n前置检索记录：共 {len(before)} 条，当前通过 {passing} 条；存档路径 {len(before_archives)} 个，存在 {sum(1 for _, _, ok in before_archives if ok)} 个")
        say(f"用时 {time.time() - started:.0f} 秒；这是预览，没有改动任何文件。要执行请加 --apply。")
        return 1 if plan.blockers else 0
    print_plan(plan, say)
    if plan.blockers:
        print("存在阻止执行的问题，已停止（没有改动任何文件）。", file=sys.stderr)
        return 1
    applier = Applier(plan, root, args)
    try:
        applier.run()
        say("4/6 改写文本里的绝对路径并同步哈希")
        samples = applier.rewrite_references(rewriter, files())
        applier.journal.data["stats"].update(applier.stats)
        applier.write_rewrites()
        say("5/6 核对")
        verify = {}
        left, _, scanned = collect_hits(files(), rewriter)
        verify["遗留旧路径（应为 0）"] = sum(v[1] for v in left.values())
        rows = sample_exists(samples, root)
        verify["抽查引用（30 条）指向的文件存在"] = f"{sum(1 for r in rows if r[3])}/{len(rows)}"
        if module:
            after, after_archives = check_records(find_records(files()), module)
            verify["前置检索记录通过数（迁移前 → 迁移后）"] = f"{sum(1 for v in before.values() if not v)} → {sum(1 for v in after.values() if not v)}（共 {len(after)} 条）"
            broken = [r for r, errors in after.items() if errors and not before.get(r)]
            verify["迁移后新出现的检查失败（应为 0）"] = len(broken)
            verify["sources[].archive 存在（迁移前 → 迁移后）"] = f"{sum(1 for _, _, ok in before_archives if ok)} → {sum(1 for _, _, ok in after_archives if ok)}（共 {len(after_archives)} 个）"
            applier.journal.data["check_broken"] = broken
        leftovers = sorted(p.name for p in root.iterdir() if not (p.is_dir() and re.match(r"^\d{3}[-_]", p.name)))
        verify["输出根下不是“序号-主题”（或旧写法“序号_主题”）文件夹的条目（应为空）"] = "、".join(leftovers) or "无"
        applier.journal.data["verify"] = {k: str(v) for k, v in verify.items()}
        applier.journal.data["status"] = "done"
        applier.journal.data["finished_at"] = now()
        applier.journal.save()
        write_compat_index(applier.journal.file, applier.journal.data)
        say("6/6 生成记录页")
        page = render_report(root, plan, applier.journal, verify, rows)
        applier.journal.save()
        for key, value in verify.items():
            say(f"  {key}: {value}")
        say(f"映射文件：{applier.journal.file}\n记录页：{page}\n用时 {time.time() - started:.0f} 秒")
        bad = verify["遗留旧路径（应为 0）"] or leftovers or (module and verify.get("迁移后新出现的检查失败（应为 0）"))
        return 1 if bad else 0
    except BaseException as error:
        applier.write_rewrites()
        applier.journal.data["status"] = f"failed: {error}"
        applier.journal.save()
        print(f"迁移中断：{error}\n已执行的步骤记录在 {applier.journal.file}，可用 --revert 撤回。", file=sys.stderr)
        raise


if __name__ == "__main__":
    sys.exit(main())
