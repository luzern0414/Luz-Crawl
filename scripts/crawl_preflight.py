#!/usr/bin/env python3
"""Shared, file-backed Luz research preflight. Browser operations use Luz-Crawl only.

run records a local decision directly, or invokes doctor -> begin/reuse -> experience -> batch for online work.
The batch runs the browser routes and writes one task summary. Its route evidence is bound to the stage record.
conclude records the specialist's findings and their intended use and writes the conclusion page.
check is read-only: it re-verifies the evidence files and the conclusion page.
status is read-only: what the stage has and what it still lacks. review-init and supplement-init write the files the
executor must fill in (every judgment left empty), so nobody copies URLs, IDs and hashes by hand; conclude --dry-run
lists everything conclude would refuse without writing.
No project scaffolding is created by this helper.

Where the record and the conclusion page go (--session):
  a skill session   <session>/raw/00-crawl/<caller>[-stage].json (+ .html)
  a Luz project     <state root>/<crawl.evidence_index of project.json>/...  (state root: see state_root)
The crawled pages themselves always stay in the Crawl task (project.json crawl.task_root); a project keeps none of them.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "luz-crawl.mjs"
CALLERS = ("luz-project", "luz-system", "luz-design", "luz-dev", "luz-ops", "luz-writing", "luz-crawl")
DEFAULT_OUTPUT = os.environ.get("LUZ_CRAWL_OUTPUT") or r"E:\Skill输出\Luz-Crawl"
PROJECT_OUTPUT = os.environ.get("LUZ_PROJECT_OUTPUT") or r"E:\Skill输出\Luz-Project"  # a project's state root is <PROJECT_OUTPUT>\<project directory name>\raw
STYLE = ROOT / "lib" / "formal-report.css"  # the one stylesheet shared with lib/formal-html.mjs
ICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%23E8F0EB%22%2F%3E%3Ccircle%20cx%3D%2214%22%20cy%3D%2214%22%20r%3D%227%22%20fill%3D%22none%22%20stroke%3D%22%231F5F46%22%20stroke-width%3D%222.6%22%2F%3E%3Cpath%20d%3D%22M19.5%2019.5%2025%2025%22%20stroke%3D%22%231F5F46%22%20stroke-width%3D%222.6%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E"
CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


@contextmanager
def record_lock(path):
    """Serialize stage mutations before inspecting or invalidating a prior conclusion."""
    lock = Path(path).with_suffix(".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        stream = lock.open("x", encoding="utf-8")
    except FileExistsError:
        raise ValueError(f"本阶段正在检索或生成结论：{lock}；异常中断后先核实原进程已退出再清理锁") from None
    try:
        with stream:
            json.dump({"pid": os.getpid(), "started_at": now()}, stream)
        yield
    finally:
        lock.unlink(missing_ok=True)


def state_root(path):
    """The project state root that a path stands for, or None when the path is no project.

    A path holding project.json is the state root (a project root from before the split works the same way); any other path is
    taken as a project directory, whose state root is <PROJECT_OUTPUT>\\<directory name>\\raw. A path that is neither is a skill session."""
    path = Path(path)
    if (path / "project.json").is_file():
        return path
    if (path / "raw" / "project.json").is_file():
        return path / "raw"
    candidate = Path(PROJECT_OUTPUT) / path.name / "raw"
    return candidate if path.name and (candidate / "project.json").is_file() else None


def evidence_dir(session):
    """The folder that keeps the preflight records, logs and conclusion pages of a session.

    A skill session: <session>/raw/00-crawl. A project: project.json's crawl.evidence_index, relative to the state root
    ("00-crawl"; a project from before the split says "raw/00-crawl" and keeps writing there). Without a usable index
    (missing, absolute, leaving the state root, or a placeholder file) the project's own layout decides."""
    state = state_root(session)
    if state is None:
        return Path(session).resolve() / "raw" / "00-crawl"
    state = state.resolve()
    try:
        crawl = read(state / "project.json").get("crawl")
    except (OSError, ValueError, AttributeError):
        crawl = None
    index = crawl.get("evidence_index") if isinstance(crawl, dict) else None
    if not _text(index) or index.lower().endswith(".json"):
        return state / "raw" / "00-crawl" if (state / "raw").is_dir() else state / "00-crawl"
    target = (state / index.strip()).resolve()
    try:
        target.relative_to(state)
    except ValueError:
        raise ValueError(f"project.json 的 crawl.evidence_index 必须是状态根内的相对路径: {index}") from None
    if target == state:
        raise ValueError("project.json 的 crawl.evidence_index 不能是状态根本身")
    return target


def selected_stage(stage):
    if stage is None:
        return os.environ.get("LUZ_CRAWL_STAGE") or None
    return stage


def record_path(session, caller, stage=None):
    stage = selected_stage(stage)
    if caller not in CALLERS or (stage and not re.fullmatch(r"[a-z][a-z0-9-]*", stage)):
        raise ValueError("无效 caller/stage")
    return evidence_dir(session) / f"{caller}{'-' + stage if stage else ''}.json"


_COMPAT = {}


def _compat():
    """The old-path map of a finished layout migration (旧路径映射.json beside its 移动记录.json), loaded once; None without one.

    A record kept by an approval cannot be rewritten, so it still names archives by the paths they had before the migration.
    The map lets the reader find where they are now. Nothing is written; a path the map does not know stays unresolved."""
    index = os.environ.get("LUZ_CRAWL_MIGRATION_INDEX") or str(Path(DEFAULT_OUTPUT) / "000_目录整理记录" / "raw" / "旧路径映射.json")
    if index not in _COMPAT:
        value = None
        try:
            if Path(index).is_file():
                data = read(index)
                spec = importlib.util.spec_from_file_location("_luz_migrate_layout", Path(__file__).resolve().with_name("migrate_layout.py"))
                module = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = module
                spec.loader.exec_module(module)
                value = {"rewriter": module.Rewriter(module.plan_from_index(data), Path(data["root"])), "hashes": data.get("hashes", {})}
        except Exception:
            value = None
        _COMPAT[index] = value
    return _COMPAT[index]


def canon(value):
    """The path as it is, when it exists; otherwise where the migration put it (when the map knows it); otherwise unchanged."""
    path = Path(str(value))
    try:
        if path.exists():
            return path
        compat = _compat()
        if compat:
            mapped, edits = compat["rewriter"].rewrite(str(value))
            if edits and Path(mapped).exists():
                return Path(mapped)
    except OSError:
        pass
    return path


def same_hash(recorded, actual):
    """A recorded hash of a file that the migration rewrote since: the map knows the hash it has now."""
    if recorded == actual:
        return True
    compat = _compat()
    return bool(compat and compat["hashes"].get(recorded) == actual)


def _inside(path, root):
    target = canon(path).resolve()
    target.relative_to(canon(root).resolve())
    return target


def _log_inside(path, root):
    """A record names its command logs by absolute path. When the evidence folder has moved (a project migrated to the state root), read the log from
    the same place below the current ``00-crawl`` folder; its hash is still checked, so nothing is accepted that was not recorded."""
    try:
        return _inside(path, root)
    except ValueError:
        parts = Path(str(path)).parts
        marks = [i for i, part in enumerate(parts) if part.lower() == "00-crawl"]
        if not marks:
            raise
        return _inside(Path(root, *parts[marks[-1] + 1:]), root)


def task_marker(task):
    """The task marker: <task>/raw/luz-task.json (task_folder_v2), else <task>/luz-task.json (sibling_raw_v1)."""
    task = Path(task)
    for candidate in (task / "raw" / "luz-task.json", task / "luz-task.json"):
        if candidate.is_file():
            return read(candidate)
    raise FileNotFoundError(f"缺少任务标记 {task / 'raw' / 'luz-task.json'}")


def archive_dir(archive):
    """Where an archive keeps content.json/manifest.json: the archive itself, else its raw/ child (older layout)."""
    archive = Path(archive)
    for candidate in (archive, archive / "raw"):
        if (candidate / "manifest.json").is_file():
            return candidate
    raise FileNotFoundError(f"缺少存档清单 {archive / 'manifest.json'}")


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _timestamp(value):
    if not _text(value):
        raise ValueError("时间必须是带时区的 ISO 字符串")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("时间缺少时区")
    return result


def doctor_ok(result):
    """doctor reports `ready` (a connected visible Edge) or `silent_ready` (the silent Edge can start).

    Neither proves a read: the search/capture steps that follow must still return a verified body.
    """
    return isinstance(result, dict) and (result.get("ready") is True or result.get("silent_ready") is True)


def source_errors(source, task):
    errors = []
    try:
        archive = _inside(source["archive"], task)
        evidence = archive_dir(archive)
        manifest_path = evidence / "manifest.json"
        if not same_hash(source["manifest_sha256"], digest(manifest_path)):
            return [f"来源清单哈希已变化: {source.get('id')}"]
        manifest = read(manifest_path)
        content = read(evidence / "content.json")
        title = str(content.get("title") or "").strip()
        if re.match(r"^(?:[45]\d\d\b|(?:page )?not found\b|access denied\b|找不到网页|页面不存在|访问被拒绝)", title, re.I):
            errors.append(f"来源是错误页面，不能作为正文依据: {source.get('id')}")
        if _timestamp(source.get("captured_at")) != _timestamp(content.get("captured_at")):
            errors.append(f"来源时间与本次抓取正文不符: {source.get('id')}")
        if source.get("url") not in {content.get("resolved_url"), content.get("canonical_url")} or not re.match(r"^https?://", str(source.get("url", ""))):
            errors.append(f"来源网址与抓取正文不符: {source.get('id')}")
        if content.get("status") not in {"captured", "partial"} or content.get("url_check", {}).get("valid_content") is not True:
            errors.append(f"来源正文未确认: {source.get('id')}")
        post = content.get("post") or {}
        if not (_text(content.get("text")) or isinstance(post, dict) and _text(post.get("text"))):
            errors.append(f"来源正文为空: {source.get('id')}")
        body = content.get("text") if _text(content.get("text")) else post.get("text", "") if isinstance(post, dict) else ""
        if len(re.sub(r"\s+", "", str(body))) < 12:
            errors.append(f"来源正文不足以形成有效逐字摘录: {source.get('id')}")
        if isinstance(body, str) and re.fullmatch(r"\s*(?:HTTP\s*)?(?:[45]\d\d[\s:-]*)?(?:service unavailable|bad gateway|gateway time[ -]?out|internal server error|access denied|forbidden|not found|too many requests|服务不可用|访问被拒绝|请求过于频繁)[\s.!。]*", body, re.I):
            errors.append(f"来源只是错误响应，未取得正文: {source.get('id')}")
        if content.get("completeness", {}).get("scope") == "search_candidates":
            errors.append(f"搜索候选不能充当正文: {source.get('id')}")
        files = manifest.get("files", [])
        if not isinstance(files, list) or not files:
            raise ValueError("来源清单 files 必须是非空数组")
        snapshot_root = evidence / "snapshots"
        if not any(_inside(archive / f["path"], archive).is_relative_to(snapshot_root) and _inside(archive / f["path"], archive).is_file() for f in files):
            errors.append(f"来源缺少浏览器快照: {source.get('id')}")
        content_path = evidence.relative_to(archive).joinpath("content.json").as_posix()
        if not any(str(f.get("path", "")).replace("\\", "/") == content_path for f in files):
            errors.append(f"来源缺少正文哈希: {source.get('id')}")
        for item in files:
            file = _inside(archive / item["path"], archive)
            if not file.is_file() or digest(file) != item.get("sha256"):
                errors.append(f"来源证据哈希不符/丢失: {source.get('id')} / {item.get('path')}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        errors.append(f"来源证据无效: {source.get('id') if isinstance(source, dict) else '?'} ({exc})")
    return errors


def findings_errors(value, source_ids):
    errors = []
    if not isinstance(value, dict):
        return ["补充信息必须是 JSON 对象"]
    findings = value.get("findings")
    if not isinstance(findings, list) or not findings:
        return ["缺少补充信息 findings 数组"]
    for f in findings:
        if not isinstance(f, dict) or not _text(f.get("source_id")) or f["source_id"] not in source_ids or not _text(f.get("summary")) or not _text(f.get("applies_to")) or not isinstance(f.get("adopted"), bool):
            errors.append("补充信息缺少有效来源、结论、采用位置或采用决定")
        elif not f["adopted"] and not _text(f.get("reason")):
            errors.append("未采用的参考须说明原因")
    if not any(isinstance(f, dict) and f.get("adopted") is True for f in findings):
        errors.append("缺少实际采用的补充信息")
    if not isinstance(value.get("gaps"), list) or any(not _text(g) for g in value.get("gaps", [])):
        errors.append("未覆盖范围 gaps 必须是文字数组（可为空）")
    if "scope" in value and not _text(value["scope"]):
        errors.append("检索范围 scope 必须是非空文字")
    return errors


def _document_url(value):
    """Match browser root paths and ordinary anchors; retain SPA routes and queries."""
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.path:
        parsed = parsed._replace(path="/")
    return parsed.geturl() if parsed.fragment.startswith(("/", "!/")) else parsed._replace(fragment="").geturl()


def _observed_sources(step, result, task):
    """Archive folders (in log order) that a successful search/capture step really read; only documented success fields count."""
    args = step.get("args")
    if not isinstance(args, list) or not all(_text(a) for a in args) or not args or args[0] != step["command"]:
        raise ValueError("检索命令参数无效")
    if "--out" not in args or canon(args[args.index("--out") + 1]).resolve() != task:
        raise ValueError("检索命令未绑定本次任务目录")
    if not isinstance(result, dict):
        raise ValueError("检索返回日志必须是 JSON 对象")
    if result.get("status") not in {"captured", "partial"} or result.get("error"):
        return []  # An unsuccessful route supplies no evidence; another route may succeed.
    if step["command"] == "capture":
        if len(args) < 2 or _document_url(result.get("url_check", {}).get("requested")) != _document_url(args[1]):
            raise ValueError("采集命令网址与返回日志不符")
        candidates = [result]
    else:
        if len(args) < 3 or result.get("query") != args[2] or result.get("platform") != args[1]:
            raise ValueError("搜索命令关键词/平台与返回日志不符")
        if result.get("search_performed") is False:
            return []
        candidates = result.get("sources", [])
        if not isinstance(candidates, list):
            raise ValueError("搜索正文来源不是数组")
    observed = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or candidate.get("status") not in {"captured", "partial"} or candidate.get("error"):
            continue
        folder = candidate.get("folder")
        if _text(folder) and candidate.get("url_check", {}).get("valid_content") is True:
            archive = str(_inside(folder, task))
            if archive not in observed:
                observed.append(archive)
    return observed


def _batch_records(step, receipt, evidence_root, task):
    """Read the archived batch once and extract only the fields needed for the stage audit."""
    if not isinstance(receipt, dict) or not _text(receipt.get("batch_file")):
        raise ValueError("批次未返回采集归档")
    plan = _log_inside(step["args"][step["args"].index("--file") + 1], evidence_root)
    batch_file = _inside(receipt["batch_file"], task / "raw")
    if digest(plan) != step.get("plan_sha256") or digest(batch_file) != receipt.get("batch_sha256"):
        raise ValueError("批次计划或采集归档哈希不符")
    jobs, batch = read(plan), read(batch_file)
    results = batch["results"]
    if _log_inside(batch["plan_file"], evidence_root) != plan or len(results) != len(jobs):
        raise ValueError("采集归档与本次批次计划不符")
    rows = []
    fields = ("folder", "html_file", "status", "resolved_url", "url_check", "stop_reason", "title",
              "error", "failure", "task_id", "awaiting_reason", "blocked_by", "browser_opened",
              "started_at", "finished_at", "second_pass")
    for job, result in zip(jobs, results):
        attempts = [*result.get("previous_routes", []), result]
        platforms = [job.get("platform"), *job.get("fallbacks", [])]
        current_platform = 0
        for attempt in attempts:
            if attempt.get("id") != job["id"]:
                raise ValueError("批次结果的任务编号与计划不符")
            log = {field: attempt[field] for field in fields if field in attempt}
            if "query" in job:
                name = "search"
                if attempt.get("platform") != platforms[current_platform]:
                    current_platform += 1
                    if current_platform >= len(platforms) or attempt.get("platform") != platforms[current_platform]:
                        raise ValueError("批次搜索入口与回退计划不符")
                if attempt.get("query") != job["query"] or attempt.get("read") != job["read"]:
                    raise ValueError("批次搜索的关键词或阅读数与计划不符")
                args = [name, attempt["platform"], job["query"], "--read", str(job["read"]), "--out", str(task)]
                log.update(platform=attempt["platform"], query=job["query"], search_performed=attempt.get("search_performed") is True)
                if attempt.get("resolved_platform"):
                    log["resolved_platform"] = attempt["resolved_platform"]
                log["candidates"] = [{key: item[key] for key in ("url", "title", "text") if key in item}
                                     for item in attempt.get("candidates", []) if isinstance(item, dict)]
                log["sources"] = [{key: item[key] for key in fields if key in item}
                                  for item in attempt.get("sources", []) if isinstance(item, dict)]
            else:
                name = "capture"
                if _policy().canonical(attempt.get("url")) != _policy().canonical(job["url"]):
                    raise ValueError("批次采集网址与计划不符")
                args = [name, attempt["url"], "--out", str(task)]
            if "--no-screenshot" in step["args"] or job.get("screenshot") is False:
                args.append("--no-screenshot")
            exit_code = 0 if attempt.get("status") in {"captured", "partial", "awaiting_user"} else 1
            rows.append((name, args, exit_code, log))
    summary = batch.get("summary_report")
    rows.append(("summary", ["summary", str(task), "--keep-raw"], 0 if summary else 1,
                 summary or {"error": batch.get("summary_error", "批次未生成汇总")}))
    return rows


def report_errors(path, value, session=None):
    """A record written by conclude names its conclusion page and that page's SHA-256; the page must still match."""
    page = Path(path).with_suffix(".html")
    if value.get("report") != page.name or not page.is_file() or digest(page) != value.get("report_sha256"):
        return ["检索结论 HTML 缺失或与记录不符，请重新运行 conclude 生成"]
    library = _policy().design_library()
    errors = []
    if session is not None:
        try:
            item = library.require_selected(state_root(session) or session, value["caller"], value.get("stage") or "research",
                                            page, "reading-html", phase="post")
            expected = {"id": "reading-html", "applies_to": page.name, "files": item["files"]}
            if value.get("report_template") != expected:
                errors.append("检索结论的模板引用与准确原选择不符")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            errors.append(f"检索结论的真实模板或最终输出未通过：{exc}")
    else:
        errors.extend(library.validate_references([value.get("report_template")]))
    return errors


@cache
def _policy():
    file = ROOT / "scripts" / "evidence_policy.py"
    spec = importlib.util.spec_from_file_location("_luz_evidence_policy", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@cache
def _inventory_module():
    spec = importlib.util.spec_from_file_location("_luz_research_inventory", ROOT / "scripts" / "research_inventory.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def research_review_errors(path, value, *, sealed=False, payload=None):
    # Historical records without an inventory remain readable. Every new run
    # writes an inventory, and therefore must carry the executor's actual review.
    if not value.get("candidate_inventory"):
        return []
    review_path = path.with_name(path.stem + "-research-review.json")
    if not review_path.is_file():
        return [f"缺少尽责复盘 {review_path.name}；填写候选分类、轮次、经验闭环和停止依据"]
    try:
        errors = _inventory_module().review_errors(value, read(_inside(path.parent / value["candidate_inventory"], path.parent)),
                                                   read(review_path), payload=value if sealed else payload)
        if sealed and (value.get("research_review") != review_path.name or value.get("research_review_sha256") != digest(review_path)):
            errors.append("尽责复盘未绑定或哈希变化，请复核后重新 conclude")
        return errors
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return [f"尽责复盘无效: {exc}"]


def requested_research(topic):
    """Recognize direct imperatives. The caller supplies the mode for context-dependent requests."""
    request = re.sub(r"^(?:(?:请|麻烦|帮我|先|please\b)\s*)+", "", topic.strip(), flags=re.I)
    if re.match(r"(?:不要|不用|无需|无须|不必|不需要|别|禁止|跳过)\s*(?:上网|联网|搜索|检索)|(?:do not|don't|no) (?:web )?(?:search|browse)\b", request, re.I):
        return "local"
    if re.match(r"(?:深入|广泛|大量|全面)(?:搜索|检索|调研)|(?:deep research|thoroughly research)\b", request, re.I):
        return "deep"
    if re.match(r"(?:上网|联网|网上)(?:查|搜|检索|调研)|搜一下|搜一搜|查一下资料|(?:查找|找)\s*(?:资料|原文|(?:\d+|[一二两三四五六七八九十百千]+)篇)"
                r"|(?:搜索|检索)(?!\s*(?:框|栏|页|功能|算法|模块|门禁|策略|组件|引擎|结果|按钮|接口|本地|仓库|代码库))"
                r"|(?:search (?:the web|online|for)|look up|browse the web|research(?! (?:mode|gate|workflow|button|tool)\b))\b", request, re.I):
        return "search"
    return None


def requested_source_count(topic):
    match = re.search(r"(\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:篇|条(?:来源|正文)|个来源|(?:distinct\s+)?sources?\b|articles?\b)", topic, re.I)
    if not match:
        return None
    number = match[1]
    if number.isdecimal():
        return int(number)
    digits = {char: index for index, char in enumerate("零一二三四五六七八九")}
    digits.update({"〇": 0, "两": 2})
    units = {"十": 10, "百": 100, "千": 1000}
    total = pending = 0
    for char in number:
        if char in units:
            total += (pending or 1) * units[char]
            pending = 0
        else:
            pending = digits[char]
    return total + pending


def research_mode(topic, mode, queries, urls, min_sources):
    if mode not in ("auto", "local", "urls", "search", "deep"):
        raise ValueError("无效的 --research 模式")
    if min_sources is not None and (type(min_sources) is not int or min_sources < 1):
        raise ValueError("--min-sources 必须是正整数")
    intent = requested_research(topic)
    if mode == "auto":
        if intent:
            mode = intent
        elif urls and not queries:
            mode = "urls"
        elif queries or min_sources is not None:
            mode = "search"
        else:
            mode = "local"
    if ((intent == "local" and mode != "local") or (intent == "deep" and mode != "deep")
            or (intent == "search" and mode in {"local", "urls"})):
        raise ValueError("检索模式与主题中的明确联网要求冲突")
    if mode == "local" and (queries or urls or min_sources is not None):
        raise ValueError("本地模式与查询、网址或正文数量要求冲突")
    if mode == "urls" and (not urls or queries):
        raise ValueError("指定网址模式需要 --url，提出查询时请用 search")
    return mode


def stage_evidence_caller(session, caller, stage):
    """A named contributor can use its commercial stage's owner record."""
    state = state_root(session)
    if not state or not stage:
        return caller
    project = read(state / "project.json")
    if project.get("workflow") != "commercial-v1":
        return caller
    row = next((r for r in project.get("stages", []) if r.get("id") == stage), {})
    if caller in row.get("contributors", []) and row.get("owner") in CALLERS:
        if stage == "scope" or not record_path(state, caller, stage).exists():
            return row["owner"]
    return caller

def commercial_scope_search(session, caller, stage):
    if caller != "luz-system" or stage != "scope":
        return False
    state = state_root(session)
    return state is not None and read(state / "project.json").get("workflow") == "commercial-v1"


SCOPE_SEARCH_MESSAGE = "商业项目首次范围确认需要真实搜索和原文依据；用 --research search 或 deep 并提交本阶段的查询。"

def local_record(path, caller, stage, topic, reason):
    return {"schema_version": 3, "research_mode": "local", "status": "not-required",
            "caller": caller, "stage": stage, "session_evidence": str(path.parent.resolve()),
            "topic": topic, "reason": reason, "sources": [], "findings": [], "steps": []}


def validate_preflight(session, caller, stage=None, *, require_findings=True):
    """Check real body evidence AND the caller's supplements, never just a passed label."""
    stage = selected_stage(stage)
    path = record_path(session, caller, stage)
    prefix = f"Crawl 前置检索 {caller}{'/' + stage if stage else ''}"
    if require_findings and path.with_suffix(".lock").exists():
        return [f"{prefix}: 本阶段正在检索或生成结论，旧结论不可用"]
    if not path.is_file():
        return [f"{prefix}: 缺少记录 {path}；先用 crawl_preflight.py run 判定本阶段，联网阶段再 conclude"]
    try:
        value = read(path)
        if not isinstance(value, dict):
            raise ValueError("记录必须是 JSON 对象")
        needs_search = commercial_scope_search(session, caller, stage)
        if needs_search and value.get("research_mode") not in {"search", "deep"}:
            return [f"{prefix}: {SCOPE_SEARCH_MESSAGE}"]
        if value.get("research_mode") == "local":
            valid = (_text(value.get("topic")) and requested_research(value["topic"]) in (None, "local") and _text(value.get("reason"))
                     and value == local_record(path, caller, stage, value["topic"], value["reason"]))
            return [] if valid else [f"{prefix}: 本地判定与会话、阶段或记录内容不符"]
        errors = []
        if value.get("caller") != caller or value.get("stage") != stage:
            errors.append("调用者/阶段不匹配")
        started = finished = None
        if not _text(value.get("topic")) or not _text(value.get("started_at")) or not _text(value.get("finished_at")):
            errors.append("缺少主题/检索时间")
        else:
            started = _timestamp(value["started_at"])
            finished = _timestamp(value["finished_at"])
            if finished < started or finished > datetime.now(timezone.utc):
                errors.append("检索时间无效")
            if (datetime.now(timezone.utc) - finished).total_seconds() > 7 * 86400:
                errors.append("检索记录超过七天，请按当前需求复核")
        task = canon(value["task_root"]).resolve()
        marker = task_marker(task)
        if marker.get("kind") != "task_archive":
            errors.append("缺少真实 Crawl 任务")
        steps = value.get("steps", [])
        if not isinstance(steps, list) or any(not isinstance(s, dict) for s in steps):
            raise ValueError("命令 steps 必须是对象数组")
        if needs_search and not any(s.get("command") == "search" and s.get("search_performed") is True for s in steps):
            errors.append(SCOPE_SEARCH_MESSAGE)
        if any(type(s.get("exit_code")) is not int for s in steps):
            errors.append("命令退出码必须是整数")
        names = [s.get("command") for s in steps if s.get("exit_code") == 0]
        if not all(n in names for n in ("doctor", "experience", "summary")) or not any(n in names for n in ("search", "capture")):
            errors.append("必须执行 doctor → experience → search/capture → summary，不能只有连通检查")
        elif names.index("doctor") > names.index("experience") or names.index("experience") > min(names.index(n) for n in ("search", "capture") if n in names):
            errors.append("前置检索执行顺序错误")
        elif max(i for i, s in enumerate(steps) if s.get("command") == "summary" and s.get("exit_code") == 0) < max(i for i, s in enumerate(steps) if s.get("command") in {"search", "capture"}):
            errors.append("前置检索执行顺序错误：summary 必须晚于所有 search/capture 路线")
        observed_archives, batch_records = set(), {}
        for index, step in enumerate(steps):
            log = _log_inside(step["file"], path.parent)
            if not log.is_file() or digest(log) != step.get("sha256"):
                errors.append("命令日志哈希不符/丢失")
                continue
            if step["command"] == "batch":
                receipt = read(log)
                if step.get("exit_code") == 0 or receipt.get("batch_file"):
                    batch_records[index] = iter(_batch_records(step, receipt, path.parent, task))
                continue
            result = None
            if "batch_step" in step:
                result = read(log)
                expected = next(batch_records.get(step["batch_step"], iter(())), None)
                if expected != (step["command"], step["args"], step["exit_code"], result):
                    errors.append("路线日志与批次归档不符")
            if step.get("command") == "doctor" and not doctor_ok(read(log)):
                errors.append("Crawl 未就绪")
            elif step.get("command") in {"search", "capture"}:
                if step["command"] == "search" and (step.get("exit_code") == 0 or result is not None):
                    result = read(log) if result is None else result
                    if ("search_performed" in step or value.get("research_mode") and "search_performed" in result):
                        if step.get("search_performed") is not (result.get("search_performed") is True):
                            errors.append("查询执行状态与浏览器日志不符")
                if step.get("exit_code") != 0:
                    continue
                result = read(log) if result is None else result
                observed_archives.update(_observed_sources(step, result, task))
        if any(next(rows, None) is not None for rows in batch_records.values()):
            errors.append("阶段记录缺少批次路线或汇总日志")
        if value.get("candidate_inventory"):
            inventory_file = _inside(path.parent / value["candidate_inventory"], path.parent)
            if not inventory_file.is_file() or digest(inventory_file) != value.get("candidate_inventory_sha256"):
                errors.append("候选清单丢失或哈希变化，请按实际检索日志重新生成")
        sources = value.get("sources", [])
        if not isinstance(sources, list) or any(not isinstance(s, dict) for s in sources):
            raise ValueError("来源 sources 必须是对象数组")
        if not sources:
            errors.append("缺少有效正文来源；失败或零结果不能算完成")
        for source in sources:
            errors.extend(source_errors(source, task))
            if str(canon(source["archive"]).resolve()) not in observed_archives:
                errors.append(f"来源未绑定本次 search/capture 日志: {source.get('id')}")
            captured = _timestamp(source.get("captured_at"))
            if started is not None and finished is not None and (captured < started or captured > finished):
                errors.append(f"来源不是本次调用读取的内容: {source.get('id')}")
        if any(not _text(s.get("id")) for s in sources):
            errors.append("来源 ID 必须是非空文字")
        ids = {s["id"] for s in sources if _text(s.get("id"))}
        if len(ids) != len(sources):
            errors.append("来源 ID 不唯一或无效")
        findings = value.get("findings", [])
        if require_findings:
            errors.extend(research_review_errors(path, value, sealed=True))
            if value.get("status") != "complete" or not findings:
                errors.append("尚未填写检索补充信息及采用位置（conclude）")
            shape_errors = findings_errors(value, ids)
            errors.extend(shape_errors)
            if not shape_errors:
                errors.extend(_policy().research_errors(value, value, resolve=canon,
                              template_context=(state_root(session) or session, caller, stage or "research")))
            errors.extend(report_errors(path, value, session))
            if path.with_suffix(".lock").exists():
                errors.append("本阶段正在检索或生成结论，旧结论不可用")
        return [f"{prefix}: {e}" for e in dict.fromkeys(errors)]
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
        return [f"{prefix}: 记录无效 ({exc})"]


_PLATFORM_NAMES = {"bing": "Bing", "github": "GitHub", "gitee": "Gitee", "gitcn": "GitCN", "hellogithub": "HelloGitHub", "codeberg": "Codeberg", "xhs": "小红书", "douyin": "抖音", "web": "网页"}


def esc(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def plain_title(value):
    """A heading carries no bracketed explanation; the full wording stays in the record."""
    text = str(value or "").strip()
    return re.sub(r"\s+", " ", re.sub(r"\s*[（(][^（()）]*[)）]", "", text)).strip() or text


def link(url, text):
    if not re.match(r"^https?://", str(url or "")):
        return esc(text)
    return f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{esc(text)}</a>'


def formal_table(number, caption, head, rows, centered=(), widths=()):
    """rows hold the cells each row owns; a cell is text or {"html"/"text", "class", "rowspan"}."""
    def cell(item, index):
        value = item if isinstance(item, dict) else {"text": item}
        classes = " ".join(c for c in (value.get("class"), "c" if index in centered else "") if c)
        class_attr = ' class="%s"' % classes if classes else ""
        span = ' rowspan="%d"' % value["rowspan"] if value.get("rowspan", 1) > 1 else ""
        inner = value["html"] if "html" in value else esc(value.get("text", ""))
        return "<td%s%s>%s</td>" % (class_attr, span, inner)

    def head_cell(index, name):
        width = ' style="width:%s"' % esc(widths[index]) if index < len(widths) and widths[index] else ""
        return '<th scope="col"%s>%s</th>' % (width, esc(name))

    header = "".join(head_cell(i, name) for i, name in enumerate(head))
    body = "".join("<tr>" + "".join(cell(item, index + len(head) - len(row)) for index, item in enumerate(row)) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table><caption>表 {number}　{esc(caption)}</caption><thead><tr>{header}</tr></thead><tbody>{body}</tbody></table></div>'


def _routes(value):
    """One row per executed search/capture step: how it was read and how many bodies it really delivered."""
    rows = []
    task = Path(value.get("task_root", ".")).resolve()
    for step in value.get("steps", []):
        args = step.get("args") or []
        if step.get("command") not in {"search", "capture"} or len(args) < 2:
            continue
        if step["command"] == "search":
            way, target = _PLATFORM_NAMES.get(args[1], args[1]), args[2] if len(args) > 2 else ""
        else:
            way, target = "网址", args[1]
        try:
            count = len(_observed_sources(step, read(step["file"]), task)) if step.get("exit_code") == 0 else None
        except (OSError, ValueError, KeyError, TypeError):
            count = None
        result = "执行失败" if step.get("exit_code") != 0 else ("取得 %d 篇正文" % count if count else "未取得正文") if count is not None else "无法核对"
        rows.append((way, target, result))
    return rows


def render_report(path, value):
    """The conclusion page: a formal document with the title first, then numbered tables and no decoration."""
    sources = {s["id"]: s for s in value.get("sources", [])}
    findings = []
    for f in value.get("findings", []):
        s = sources.get(f.get("source_id"), {})
        decision = "采用" if f.get("adopted") else "未采用，" + str(f.get("reason", ""))
        host = (urlparse(str(s.get("url", ""))).hostname or "").removeprefix("www.")
        origin = '<span class="src">%s</span>' % esc(host) if host else ""
        findings.append([f.get("summary", ""), f.get("applies_to", ""), decision, {"html": link(s.get("url"), s.get("title") or s.get("url") or f.get("source_id", "")) + origin}])
    routes = _routes(value)
    scope = value.get("scope") or value.get("topic", "")
    route_rows = [[{"text": scope, "rowspan": len(routes), "class": "g"}, *routes[0]], *[list(r) for r in routes[1:]]] if routes else [[scope, "", "", ""]]
    gaps = value.get("gaps") or ["本次声明的范围内暂无待补项"]
    body = (
        "<section><h2>检索结论</h2>" + formal_table(1, "检索结论", ["结论", "用途", "决定", "来源"], findings, widths=["36%", "20%", "16%", "28%"]) + "</section>"
        + "<section><h2>检索范围</h2>" + formal_table(2, "检索范围与路线", ["范围", "方式", "关键词或网址", "结果"], route_rows, centered=(1, 3), widths=["28%", "10%", "42%", "20%"]) + "</section>"
        + "<section><h2>未覆盖范围</h2>" + formal_table(3, "未覆盖范围", ["内容"], [[g] for g in gaps]) + "</section>"
    )
    heading = plain_title(value.get("topic", "前置检索"))
    css = STYLE.read_text(encoding="utf-8").strip()
    page = _policy().design_library().render_reading(heading, body, style=css)
    page = page.replace('</head>', f'<meta http-equiv="Content-Security-Policy" content="{esc(CSP)}"><meta name="referrer" content="no-referrer"></head>', 1)
    target = Path(path).with_suffix(".html")
    temp = target.with_suffix(target.suffix + ".tmp")
    try:
        temp.write_text(page, encoding="utf-8")
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
    return target


def conclude(session, caller, findings, stage=None):
    stage = selected_stage(stage)
    with record_lock(record_path(session, caller, stage)):
        return _conclude(session, caller, findings, stage)


def _conclude(session, caller, findings, stage=None):
    errors = validate_preflight(session, caller, stage, require_findings=False)
    if errors:
        raise ValueError("; ".join(errors))
    path = record_path(session, caller, stage)
    value = read(path)
    if value.get("research_mode") == "local":
        raise ValueError("本阶段使用本地依据，直接运行 check")
    errors = research_review_errors(path, value, payload=findings)
    if errors:
        raise ValueError("; ".join(errors))
    errors = findings_errors(findings, {s["id"] for s in value["sources"]})
    if errors:
        raise ValueError("; ".join(errors))
    errors = _policy().research_errors(value, findings, resolve=canon)
    if errors:
        raise ValueError("; ".join(errors))
    for key in ("report", "report_sha256", "concluded_at"):
        value.pop(key, None)
    if value.get("candidate_inventory"):
        review_path = path.with_name(path.stem + "-research-review.json")
        value.update(research_review=review_path.name, research_review_sha256=digest(review_path))
    value.update({key: findings[key] for key in ("source_reviews", "coverage", "blocking_gaps", "template_uses")})
    value.update({"schema_version": 3 if "research_mode" in value else 2, "findings": findings.get("findings", []), "gaps": findings.get("gaps", []), "scope": findings.get("scope", value["topic"]), "status": "needs-conclusion"})
    # This is the framework's internal research conclusion, not a new business
    # research stage. Select its real shell and bind its final bytes directly.
    library = _policy().design_library()
    template_root, template_stage = state_root(session) or Path(session), stage or "research"
    library.select(template_root, caller, template_stage, "reading-html", str(path.with_suffix(".html").resolve()))
    library.require_selected(template_root, caller, template_stage, path.with_suffix(".html"), "reading-html")
    write(path, value)
    page = render_report(path, value)
    library.record_output(template_root, caller, template_stage, page, "reading-html",
                          generator="Luz-Crawl/scripts/crawl_preflight.py:render_report")
    value.update({"report": page.name, "report_sha256": digest(page), "report_template": _policy().design_library().reference("reading-html", page.name)})
    # Recheck the real evidence after rendering. Only the last atomic write may
    # advertise completion; a renderer or filesystem failure leaves it pending.
    errors = validate_preflight(session, caller, stage, require_findings=False) + research_review_errors(path, value, sealed=True) + report_errors(path, value, session)
    if errors:
        raise ValueError("; ".join(errors))
    value.update({"status": "complete", "concluded_at": now()})
    write(path, value)
    return path


def conclude_errors(session, caller, findings, stage=None):
    """Everything conclude would refuse, in one pass and without writing: the record, the review, the supplement, the floor."""
    stage = selected_stage(stage)
    errors = validate_preflight(session, caller, stage, require_findings=False)
    path = record_path(session, caller, stage)
    if not path.is_file():
        return errors
    try:
        value = read(path)
        if value.get("research_mode") == "local":
            return errors + ["本阶段使用本地依据，直接运行 check"]
        errors += research_review_errors(path, value, payload=findings)
        shape = findings_errors(findings, {s["id"] for s in value.get("sources", []) if isinstance(s, dict) and _text(s.get("id"))})
        errors += shape
        if not shape:
            errors += _policy().research_errors(value, findings, resolve=canon)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        errors.append(f"补充信息无法核对: {exc}")
    return list(dict.fromkeys(errors))


def _query_key(value):
    return " ".join(str(value).split()).casefold()


def _executed_queries(value):
    """The distinct queries of the successful search steps, in order, each with the entry it ran on."""
    seen, rows = set(), []
    for step in value.get("steps", []):
        args = step.get("args") or []
        if _policy().executed_search(step) and _query_key(args[2]) not in seen:
            seen.add(_query_key(args[2]))
            rows.append({"platform": args[1], "query": args[2]})
    return rows


def _stage_files(session, caller, stage):
    stage = selected_stage(stage)
    path = record_path(session, caller, stage)
    if not path.is_file():
        raise ValueError(f"缺少本阶段记录 {path}；先运行 crawl_preflight.py run")
    value = read(path)
    if not isinstance(value, dict):
        raise ValueError("记录必须是 JSON 对象")
    inventory = None
    if value.get("candidate_inventory"):
        inventory = read(_inside(path.parent / value["candidate_inventory"], path.parent))
    return path, value, inventory


def status(session, caller, stage=None):
    """Read-only: what this stage's research has and what it still lacks. Counts are the floor, never the finish line."""
    stage = selected_stage(stage)
    path = record_path(session, caller, stage)
    if not path.is_file():
        return {"record": str(path), "status": "missing", "next": ["运行 crawl_preflight.py run 建立本阶段记录"]}
    path, value, inventory = _stage_files(session, caller, stage)
    if value.get("research_mode") == "local":
        errors = validate_preflight(session, caller, stage)
        return {"record": str(path), "status": "invalid" if errors else "not-required", "research_mode": "local",
                "topic": value.get("topic"), "reason": value.get("reason"), "errors": errors, "next": []}
    policy = _policy()
    floor = policy.research_floor(value)
    try:
        counts = policy.breadth_counts(value, resolve=canon)
        floor_errors = policy.breadth_errors(value, counts=counts)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        counts = {"sources": None, "publishers": None}
        floor_errors = [f"无法核对正文: {exc}"]
    review_path = path.with_name(path.stem + "-research-review.json")
    review = read(review_path) if review_path.is_file() else None
    reviewed = {row.get("url") for row in (review or {}).get("candidate_reviews", []) if isinstance(row, dict)}
    candidates = [row["url"] for row in (inventory or {}).get("candidates", [])]
    review_errors = research_review_errors(path, value) if inventory is not None else []
    questions = [q for q in (review or {}).get("questions", []) if isinstance(q, dict)]
    age = None
    if _text(value.get("finished_at")):
        age = round((datetime.now(timezone.utc) - _timestamp(value["finished_at"])).total_seconds() / 86400, 1)
    steps = []
    if path.with_suffix(".lock").exists():
        steps.append("本阶段正在检索或生成结论；等它结束，或核实原进程已退出后清理锁")
    if floor_errors:
        steps.append("补搜：run --append 加新的 --query 或 --url（同一 caller、session、stage、topic），先 --read 0 建候选池再读选中的正文")
    if inventory is not None and (review is None or set(candidates) != reviewed):
        steps.append("review-init：生成或合并尽责复盘，再逐项填写候选分类、问题、轮次、经验与停止依据")
    elif review_errors:
        steps.append("补全尽责复盘中的空项（见 review.errors）")
    if not floor_errors and not review_errors and value.get("status") != "complete":
        steps.append("supplement-init → 读全部正文并填写补充信息 → conclude --dry-run → conclude → check")
    if value.get("status") == "complete":
        steps.append("已 conclude；交付前运行 check")
    return {
        "record": str(path), "status": value.get("status"), "topic": value.get("topic"), "age_days": age,
        "research_mode": value.get("research_mode", "deep"),
        "queries": {"have": len(_executed_queries(value)), "need": floor["queries"], "list": _executed_queries(value)},
        "bodies": {"have": counts["sources"], "need": floor["sources"]},
        "sites": {"have": counts["publishers"], "need": floor["publishers"],
                  "note": "按站点估算；真实发布主体和一手来源数在补充信息的 source_reviews 里核定"},
        "primary": {"need": floor["primary"]},
        "floor_errors": floor_errors,
        "candidates": {"total": len(candidates), "with_body": sum(1 for row in (inventory or {}).get("candidates", []) if row.get("status") == "body-captured"),
                       "not_in_review": len([u for u in candidates if u not in reviewed])},
        "review": {"file": str(review_path), "exists": review is not None, "errors": review_errors,
                   "required_questions": [q.get("id") for q in questions if q.get("importance") == "required"]},
        "next": steps,
    }


def _experience_rows(value, known_logs):
    """Expand lookups in each round's shared experience log for review."""
    rows = []
    for step in value.get("steps", []):
        if step.get("command") != "experience" or step.get("exit_code") != 0 or step.get("file") in known_logs:
            continue
        args = step.get("args") or []
        query = args[args.index("--query") + 1] if "--query" in args and args.index("--query") + 1 < len(args) else ""
        try:
            log = read(step["file"])
        except (OSError, ValueError, AttributeError):
            log = {}
        for lookup in log.get("lookups", [log]):
            keys = [n.get("key") for n in lookup.get("notes", []) if isinstance(n, dict) and n.get("kind") != "preference" and n.get("key")][:8]
            row = {"query": lookup.get("query", query), "log": step["file"], "keys": keys, "status": "", "impact": ""}
            if lookup.get("platform"):
                row["platform"] = lookup["platform"]
            keywords = [item["query"] for item in lookup.get("keywords", []) if item.get("readable") and _text(item.get("query"))][:5]
            hosts = list(dict.fromkeys(hint["source_host"] for hint in lookup.get("source_hints", []) if _text(hint.get("source_host"))))[:5]
            if keywords:
                row["previous_keywords"] = keywords
            if hosts:
                row["previous_source_hosts"] = hosts
            if not (keys or keywords or hosts):
                row.update(status="无命中", impact="没有可复用的路线、来源或失败经验，按问题计划查询")
            rows.append(row)
    return rows


def review_init(session, caller, stage=None):
    """Write or update <record>-research-review.json: bound to the record and the current candidate pool, one row per
    candidate, per executed query, per run and per experience lookup. Decisions already written are kept; every new
    judgment is left empty, so conclude refuses the file until the executor has really reviewed it."""
    stage = selected_stage(stage)
    with record_lock(record_path(session, caller, stage)):
        path, value, inventory = _stage_files(session, caller, stage)
        if inventory is None:
            raise ValueError("本阶段记录没有候选清单；先运行 run（历史记录不需要复盘）")
        review_path = path.with_name(path.stem + "-research-review.json")
        old = read(review_path) if review_path.is_file() else {}
        if not isinstance(old, dict):
            raise ValueError("现有尽责复盘不是 JSON 对象")
        review = json.loads(json.dumps(old))
        review.update({field: value.get(field) for field in ("caller", "stage", "task_root", "candidate_inventory_sha256")})
        review.setdefault("questions", [])
        by_url = {row.get("url"): row for row in review.get("candidate_reviews", []) if isinstance(row, dict)}
        rows, added = [], 0
        for item in inventory["candidates"]:
            row = by_url.get(item["url"])
            if row is None:
                added += 1
                row = {"url": item["url"], "title": item.get("title", ""), "category": "", "question_ids": [], "status": "", "priority": "", "reason": ""}
            if item.get("source_ids"):
                row["source_ids"] = item["source_ids"]  # an archived body of this stage exists; reading it is still the executor's
            rows.append(row)
        current = {item["url"] for item in inventory["candidates"]}
        review["candidate_reviews"] = rows
        groups = [g for g in review.get("query_groups", []) if isinstance(g, dict)]
        grouped = {_query_key(q) for g in groups for q in (g.get("queries") if isinstance(g.get("queries"), list) else []) if isinstance(q, str)}
        for item in _executed_queries(value):
            if _query_key(item["query"]) not in grouped:
                groups.append({"purpose": "", "queries": [item["query"]], "platform": item["platform"], "question_ids": []})
        review["query_groups"] = groups
        rounds = [r for r in review.get("rounds", []) if isinstance(r, dict)]
        known = {str(log) for r in rounds for log in (r["logs"] if isinstance(r.get("logs"), list) else [r.get("logs")])}
        for folder in dict.fromkeys(str(Path(s["file"]).parent) for s in value.get("steps", []) if s.get("command") in {"search", "capture"}):
            if folder not in known:
                rounds.append({"logs": [folder], "observation": "", "next_action": ""})
        review["rounds"] = rounds
        reuse = [r for r in review.get("experience_reuse", []) if isinstance(r, dict)]
        review["experience_reuse"] = reuse + _experience_rows(value, {r.get("log") for r in reuse})
        review.setdefault("experience_updates", [])
        review.setdefault("stop", {"reason": "", "basis": "", "remaining": []})
        if review != old:
            write(review_path, review)
        errors = research_review_errors(path, value)
        return {"review": str(review_path), "changed": review != old, "candidates": len(rows), "added": added,
                "removed": sorted(url for url in by_url if url not in current), "to_fill": errors,
                "protocol": str(ROOT / "references" / "research-diligence.md"),
                "next": "逐项填写空项：问题、查询组目的、每个候选的分类／状态／优先级／理由、每轮观察与下一步、经验采用与更新、停止依据；填完运行 status。"}


def supplement_init(session, caller, stage=None, out=None):
    """Write or update the supplement that conclude takes: one finding and one review row per body of this stage, one
    coverage row per question of the review. Quotes, locators, conclusions, publishers and decisions are left empty."""
    path, value, _ = _stage_files(session, caller, stage)
    if value.get("research_mode") == "local":
        raise ValueError("本阶段使用本地依据，无需生成检索补充信息")
    target = Path(out) if out else path.with_name(path.stem + "-supplement.json")
    old = read(target) if target.is_file() else {}
    if not isinstance(old, dict):
        raise ValueError("现有补充信息不是 JSON 对象")
    payload = json.loads(json.dumps(old))
    sources = [s for s in value.get("sources", []) if isinstance(s, dict) and _text(s.get("id"))]
    findings = [f for f in payload.get("findings", []) if isinstance(f, dict)]
    numbers = [int(m.group(1)) for f in findings if (m := re.fullmatch(r"F-(\d+)", str(f.get("id", ""))))]
    number = max(numbers, default=0)
    covered = {f.get("source_id") for f in findings}
    for source in sources:
        if source["id"] not in covered:
            number += 1
            findings.append({"id": f"F-{number:03d}", "source_id": source["id"], "kind": "", "quote": "", "locator": "", "summary": "", "applies_to": "", "adopted": None, "reason": ""})
    reviews = [r for r in payload.get("source_reviews", []) if isinstance(r, dict)]
    reviewed = {r.get("source_id") for r in reviews}
    reviews += [{"source_id": s["id"], "publisher": "", "authority": "", "reason": ""} for s in sources if s["id"] not in reviewed]
    review_path = path.with_name(path.stem + "-research-review.json")
    questions = [q for q in (read(review_path).get("questions", []) if review_path.is_file() else []) if isinstance(q, dict) and _text(q.get("id"))]
    coverage = [c for c in payload.get("coverage", []) if isinstance(c, dict)]
    asked = {c.get("question_id") for c in coverage}
    coverage += [{"question_id": q["id"], "question": q.get("question", ""), "applies_to": "", "finding_ids": []} for q in questions if q["id"] not in asked]
    payload.update({"scope": payload.get("scope") or value.get("topic", ""), "findings": findings, "source_reviews": reviews, "coverage": coverage})
    for field in ("template_uses", "blocking_gaps", "gaps"):
        payload.setdefault(field, [])
    if payload != old:
        write(target, payload)
    bodies = []
    for source in sources:
        try:
            body = str(archive_dir(canon(source["archive"])) / "content.json")
        except (OSError, FileNotFoundError):
            body = None
        bodies.append({"id": source["id"], "title": source.get("title"), "url": source.get("url"), "content": body})
    return {"supplement": str(target), "changed": payload != old, "sources": bodies, "contract": str(ROOT / "references" / "evidence-policy.md"),
            "next": "读每篇 content.json 的正文，再填 kind、逐字 quote、locator、summary、applies_to、adopted（未采用写 reason）、"
                    "publisher、authority 与理由、coverage 的输出位置和 finding_ids、template_uses；conclude --dry-run 无错误后 conclude。"}


def _query_route(query, platforms):
    """A query may name its own entry as "入口::关键词" (github::browser automation); otherwise it runs on the --platform chain."""
    head, mark, rest = query.partition("::")
    if mark and re.fullmatch(r"[a-z0-9][a-z0-9-]*", head.strip()) and rest.strip():
        return [head.strip()], rest.strip()
    return platforms, query


def run(session, caller, topic, task=None, queries=None, urls=None, stage=None, platform="bing", read_count=3, append=False, screenshot=True,
        *, research="auto", min_sources=None, reason=None, concurrency=6):
    stage = selected_stage(stage)
    with record_lock(record_path(session, caller, stage)):
        return _run(session, caller, topic, task, queries, urls, stage, platform, read_count, append, screenshot,
                    research, min_sources, reason, concurrency)


def _run(session, caller, topic, task, queries, urls, stage, platform, read_count, append, screenshot, research, min_sources, reason, concurrency):
    if not _text(topic):
        raise ValueError("--topic 需要非空主题")
    if type(read_count) is not int or not 0 <= read_count <= 5:
        raise ValueError("--read 须为 0 到 5；0 只发现候选，不代表已读正文")
    if type(concurrency) is not int or not 1 <= concurrency <= 8:
        raise ValueError("--concurrency 须为 1 到 8")
    platforms = list(dict.fromkeys(name.strip() for name in str(platform).split(",") if name.strip()))
    if not platforms or any(not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) for name in platforms):
        raise ValueError("--platform 是检索入口，或用逗号分隔的回退顺序，如 bing,baidu")
    path = record_path(session, caller, stage)
    value = {"schema_version": 3, "caller": caller, "stage": stage, "topic": topic, "started_at": now(), "finished_at": None, "status": "running", "sources": [], "findings": [], "gaps": [], "steps": []}
    if append:
        if not path.is_file():
            raise ValueError("--append 需要本调用者、本阶段的现有检索记录")
        previous = read(path)
        if previous.get("caller") != caller or previous.get("stage") != stage or previous.get("topic") != topic:
            raise ValueError("--append 的调用者、阶段与主题必须匹配，不能借用另一阶段")
        old_mode = previous.get("research_mode", "deep")
        if old_mode == "local":
            raise ValueError("本地判定没有可追加的检索；用新的 run 开始联网检索")
        if research not in ("auto", old_mode) or min_sources is not None and min_sources != _policy().research_floor(previous)["sources"]:
            raise ValueError("--append 须沿用本阶段原定检索模式和数量")
        research, min_sources = old_mode, previous.get("min_sources")
        if previous.get("status") == "running":
            raise ValueError("本阶段仍在检索，不能并发追加")
        if task is not None and previous.get("task_root") and canon(task).resolve() != canon(previous["task_root"]).resolve():
            raise ValueError("--append 不能更换 Crawl 任务")
        if previous.get("task_root"):
            task = canon(previous["task_root"])
        value.update({key: previous[key] for key in ("started_at", "steps")})
    mode = research_mode(topic, research, queries, urls, min_sources)
    if commercial_scope_search(session, caller, stage) and mode not in {"search", "deep"}:
        raise ValueError(SCOPE_SEARCH_MESSAGE)
    if mode == "local":
        if path.is_file():
            old = read(path)
            if old.get("research_mode") != "local" and old.get("topic") == topic:
                raise ValueError("本阶段已有此主题的联网记录；用 --append 沿用原检索要求")
        value = local_record(path, caller, stage, topic, reason or "本阶段可用已有材料、代码或测试直接核对")
        write(path, value)
        return {"record": str(path), "status": value["status"], "research_mode": mode, "reason": value["reason"], "sources": []}
    value["research_mode"] = mode
    if min_sources is None and not append:
        if requested_research(topic) in ("search", "deep"):
            min_sources = requested_source_count(topic)
        elif mode == "urls":
            min_sources = len({_policy().canonical(url) for url in urls})
    if min_sources is not None:
        value["min_sources"] = min_sources
        read_count = min(read_count, min_sources)
    _policy().research_floor(value)  # Validate the requested count before starting any browser process.
    # Invalidate completion before any subprocess can run or block.
    write(path, value)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    logs = path.parent / "logs" / f"{path.stem}-{run_id}"
    logs.mkdir(parents=True)

    def record_step(name, args, code, output):
        index = len(value["steps"])
        log = logs / f"{index:02d}-{name}.json"
        log.write_text(output or "{}", encoding="utf-8")
        step = {"command": name, "args": args, "exit_code": code, "file": str(log), "sha256": digest(log)}
        value["steps"].append(step)
        return step

    def command(name, *args, timeout=300):
        index = len(value["steps"])
        print(f"[preflight] {caller}: {name}", file=sys.stderr, flush=True)
        args = [name, *map(str, args)]
        try:
            result = subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, shell=False)
            code, stdout, stderr = result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            code, stdout, stderr = 124, "", f"timeout after {timeout} s"
        (logs / f"{index:02d}-{name}.stderr.txt").write_text(stderr, encoding="utf-8")
        step = record_step(name, args, code, stdout)
        write(path, value)
        if code and not (name == "batch" and code == 2):
            raise ValueError(f"{name} 失败；详情 {step['file']}")
        return json.loads(stdout)

    try:
        if not doctor_ok(command("doctor")):
            raise ValueError("Crawl 未就绪：本机 Edge、桥接服务或扩展文件不可用，先按 references/install.md 处理")
        state = state_root(session)
        if task is None and state is not None:
            crawl = read(state / "project.json").get("crawl")
            task = crawl.get("task_root") if isinstance(crawl, dict) else None
        if task is None:
            task = command("begin", topic, "--out", DEFAULT_OUTPUT, "--new")["folder"]
        task = Path(task).resolve()
        if task_marker(task).get("kind") != "task_archive":
            raise ValueError("--task 必须是 begin 返回的任务目录")
        value["task_root"] = str(task)
        jobs, lookups = [], [(topic, None)]
        search_items = queries or ([] if mode == "urls" or append and urls else [topic])
        unique_queries = set()
        for item in search_items:
            entries, query = _query_route(item.strip(), platforms)
            identity = (tuple(entries), _query_key(query))
            if identity in unique_queries:
                continue
            unique_queries.add(identity)
            jobs.append({"id": f"search-{len(jobs) + 1:03d}", "platform": entries[0], "fallbacks": entries[1:],
                         "query": query, "read": read_count, "screenshot": read_count > 0 and screenshot})
            lookups.extend((query, entry) for entry in entries)
        checked_urls = set()
        for url in urls or []:
            document_url = _policy().canonical(url)
            if document_url in checked_urls:
                continue
            checked_urls.add(document_url)
            host = urlparse(url).hostname
            if host:
                lookups.append((host, None))
            jobs.append({"id": f"capture-{len(jobs) + 1:03d}", "url": url})
        lookups_path = logs / "experience-plan.json"
        write(lookups_path, [{"query": query, **({"platform": entry} if entry else {})} for query, entry in dict.fromkeys(lookups)])
        command("experience", "--file", lookups_path, "--out", task)
        plan = logs / "research-plan.json"
        write(plan, jobs)
        plan_hash = digest(plan)
        batch_index = len(value["steps"])
        # A larger batch gets the same time allowance the old separate route calls had in total.
        receipt = command("batch", "--file", plan, "--out", task, "--compact", "--concurrency", concurrency,
                          *([] if screenshot else ["--no-screenshot"]),
                          timeout=300 * sum(1 + len(job.get("fallbacks", [])) for job in jobs))
        batch_step = value["steps"][batch_index]
        batch_step["plan_sha256"] = plan_hash
        if isinstance(receipt, dict) and _text(receipt.get("batch_file")):
            value["batch_file"] = receipt["batch_file"]
            value["awaiting_user"] = receipt.get("awaiting_user", [])
        batch_records = _batch_records(batch_step, receipt, path.parent, task)
        for name, args, exit_code, result in batch_records:
            step = record_step(name, args, exit_code, json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
            step["batch_step"] = batch_index
            if name == "search":
                step["search_performed"] = result["search_performed"]
        write(path, value)
        if batch_records[-1][2] != 0:
            raise ValueError(f"任务汇总失败；详情 {batch_step['file']}")
        value["summary_file"] = batch_records[-1][3]["file"]

        route_logs, archives = [], []
        for step in value["steps"]:
            if step.get("command") not in {"search", "capture"}:
                continue
            log = _log_inside(step["file"], path.parent)
            if digest(log) != step.get("sha256"):
                raise ValueError("候选清单的检索日志哈希不符")
            try:
                result = read(log)
            except json.JSONDecodeError:
                if step.get("exit_code") == 0:
                    raise
                result = {"status": "failed", "stop_reason": "invalid_command_output"}
            route_logs.append((step, result))
            if step.get("exit_code") == 0:
                if step["command"] == "search" and "search_performed" in result:
                    step.setdefault("search_performed", result["search_performed"] is True)
                archives.extend(_observed_sources(step, result, task))
        seen_urls = set()
        for archive in dict.fromkeys(archives):
            archive = Path(archive)
            try:
                evidence = archive_dir(archive)
            except FileNotFoundError:
                continue
            manifest, content_path = evidence / "manifest.json", evidence / "content.json"
            if not content_path.is_file():
                continue
            content = read(content_path)
            source = {"id": f'SRC-{len(value["sources"]) + 1:03d}', "archive": str(archive), "manifest_sha256": digest(manifest), "url": content.get("resolved_url") or content.get("canonical_url"), "title": content.get("title"), "captured_at": content.get("captured_at")}
            document_url = _policy().canonical(source["url"])
            if document_url not in seen_urls and not source_errors(source, task):
                seen_urls.add(document_url)
                value["sources"].append(source)
        # Keep the whole observed pool across append runs; candidate links never
        # enter sources or satisfy the existing body/quotation evidence gates.
        inventory_module = _inventory_module()
        inventory = inventory_module.build_inventory(route_logs, value["sources"])
        inventory_path = path.with_name(path.stem + "-candidates.json")
        write(inventory_path, inventory)
        value.update(candidate_inventory=inventory_path.name, candidate_inventory_sha256=digest(inventory_path))
        discovered = any(step.get("command") == "search" and result.get("search_performed") is True and result.get("candidates")
                         for step, result in route_logs if isinstance(result, dict))
        policy_errors = _policy().breadth_errors(value, resolve=canon)
        value["status"] = ("needs-research" if policy_errors else "needs-conclusion") if value["sources"] or discovered else "blocked"
        value["research_errors"] = policy_errors
        value["finished_at"] = now()
        write(path, value)
        if not value["sources"] and not discovered:
            raise ValueError("没有取得有效正文，不能标记完成；请补充网址或缩小查询后重跑")
        return {"record": str(path), "status": value["status"], "research_mode": mode, "floor": _policy().research_floor(value),
                "task": str(task), "sources": value["sources"], "research_errors": policy_errors,
                "candidate_inventory": str(inventory_path), "candidate_count": inventory["candidate_count"], "site_count": inventory["site_count"],
                "batch_file": value["batch_file"], "summary_file": value["summary_file"], "awaiting_user": value["awaiting_user"], "concurrency": concurrency,
                "experience_logs": [step["file"] for step in value["steps"] if step.get("command") == "experience"],
                "research_protocol": str(ROOT / "references" / "research-diligence.md"),
                "research_review": str(path.with_name(path.stem + "-research-review.json")),
                "next": "读尽责调查协议与经验日志，分类完整候选池；按问题覆盖与新发现决定下一轮 --append。数量是下限，不能据此停止。读正文、记录逐轮判断及经验沉淀，再登记摘录、来源评估、coverage 与模板，conclude/check。"}
    except KeyboardInterrupt:
        value.update(status="blocked", finished_at=now(), error="检索被中断；已完成日志保留，恢复后使用 --append")
        write(path, value)
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
        value.update(status="blocked", finished_at=now(), error=str(exc))
        write(path, value)
        raise ValueError(f"{exc}；记录 {path}") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "conclude", "check", "status", "review-init", "supplement-init"):
        p = sub.add_parser(name)
        p.add_argument("--session", type=Path, required=True, help="本技能会话目录（记录写在其 raw/00-crawl/），或项目目录/状态根（写在状态根下 project.json 的 crawl.evidence_index）")
        p.add_argument("--caller", choices=CALLERS, required=True, help="实际执行检索的技能")
        p.add_argument("--stage", help="独立业务或项目阶段，如 research、design；缺省用 LUZ_CRAWL_STAGE，三条命令必须一致")
        if name == "run":
            p.add_argument("--topic", required=True, help="这次缺什么信息；不含密钥或真实用户数据")
            p.add_argument("--research", choices=("auto", "local", "urls", "search", "deep"), default="auto",
                           help="本地可解用 local，指定网页用 urls，要求搜索用 search，大量调研用 deep。auto 按输入分流")
            p.add_argument("--min-sources", type=int, help="用户指定的去重正文数量（正整数）")
            p.add_argument("--reason", help="本地判定依据，如涉及的源码、测试或用户给定材料")
            p.add_argument("--task", type=Path, help="begin 返回的任务目录；同一需求的各技能、各阶段共用")
            p.add_argument("--query", action="append", help="可重复；缺省用 --topic")
            p.add_argument("--url", action="append", help="可重复；已知官方原文")
            p.add_argument("--platform", default="bing", help="--query 使用的检索入口，默认 bing；也可用 github、gitee、xhs、douyin 等。"
                           "逗号分隔表示回退顺序（bing,baidu：前一个既没有正文也没有候选才用下一个）；单条查询可写成 入口::关键词 指定自己的入口")
            p.add_argument("--read", type=int, default=3, help="每个查询打开的详情数，0 到 5，默认 3；0 只建候选池，之后 --append --url 读选中的正文")
            p.add_argument("--concurrency", type=int, default=6, help="不同站点并发数，1 到 8，默认 6")
            p.add_argument("--compact", action="store_true", help="返回计数、限制与归档位置，完整来源在阶段记录中")
            p.add_argument("--append", action="store_true", help="本阶段补搜，保留原路线与来源；仍须重新 conclude/check")
            p.add_argument("--no-screenshot", action="store_true", help="技术正文跳过图片采集，仍保留正文与 DOM 快照；UI 视觉依据必须另行截图并实际查看")
        if name == "conclude":
            p.add_argument("--file", type=Path, required=True)
            p.add_argument("--dry-run", action="store_true", help="只列出 conclude 会拒绝的全部问题，不写记录、不生成结论页")
        if name == "supplement-init":
            p.add_argument("--out", type=Path, help="补充信息文件，缺省是记录旁的 <caller>[-stage]-supplement.json")
    a = parser.parse_args()
    try:
        if a.command == "run":
            value = run(a.session, a.caller, a.topic, a.task, a.query, a.url, a.stage, a.platform, a.read, a.append,
                        screenshot=not a.no_screenshot, research=a.research, min_sources=a.min_sources, reason=a.reason, concurrency=a.concurrency)
            if a.compact:
                value["source_count"] = len(value.pop("sources", []))
                value.pop("experience_logs", None)
        elif a.command == "conclude" and a.dry_run:
            errors = conclude_errors(a.session, a.caller, read(a.file), a.stage)
            print(json.dumps({"ok": not errors, "errors": errors, "dry_run": True}, ensure_ascii=False, indent=2))
            return 1 if errors else 0
        elif a.command == "conclude":
            record = conclude(a.session, a.caller, read(a.file), a.stage)
            value = {"record": str(record), "report": str(record.with_suffix(".html")), "status": "complete"}
        elif a.command == "status":
            value = status(a.session, a.caller, a.stage)
        elif a.command == "review-init":
            value = review_init(a.session, a.caller, a.stage)
        elif a.command == "supplement-init":
            value = supplement_init(a.session, a.caller, a.stage, a.out)
        else:
            errors = validate_preflight(a.session, a.caller, a.stage)
            value = {"ok": not errors, "errors": errors}
            if not errors:
                path = record_path(a.session, a.caller, a.stage)
                record = read(path)
                value["status"] = record["status"]
                if record["status"] == "complete":
                    value["report"] = str(path.with_suffix(".html"))
            print(json.dumps(value, ensure_ascii=False, indent=2))
            return 1 if errors else 0
        compact = a.command == "run" and a.compact
        print(json.dumps(value, ensure_ascii=False, indent=None if compact else 2, separators=(",", ":") if compact else None))
        return 1 if a.command == "run" and value.get("status") == "needs-research" else 0
    except (OSError, ValueError) as exc:
        if a.command == "run":
            result = {"status": "blocked", "error": str(exc)}
            try:
                path = record_path(a.session, a.caller, selected_stage(a.stage))
                record = read(path)
                if isinstance(record, dict) and record.get("status") == "blocked":
                    fields = ("task_root", "batch_file", "summary_file", "awaiting_user")
                    result.update({key: record[key] for key in fields if key in record})
                    result["record"] = str(path)
            except (OSError, ValueError):
                pass
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
