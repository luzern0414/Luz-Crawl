#!/usr/bin/env python3
"""Shared, file-backed Luz research preflight. Browser operations use Luz-Crawl only.

run invokes doctor -> begin/reuse -> experience -> search/capture -> summary.
conclude records the specialist's findings and their intended use and writes the conclusion page.
check is read-only: it re-verifies the evidence files and the conclusion page.
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
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "luz-crawl.mjs"
CALLERS = ("luz-project", "luz-system", "luz-design", "luz-dev", "luz-ops", "luz-writing", "luz-crawl")
DEFAULT_OUTPUT = os.environ.get("LUZ_CRAWL_OUTPUT") or r"D:\Codes\skill输出\Luz-Crawl"
PROJECT_OUTPUT = os.environ.get("LUZ_PROJECT_OUTPUT") or r"D:\Codes\skill输出\Luz-Project"  # a project's state root is <PROJECT_OUTPUT>\<project directory name>\raw
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


def state_root(path):
    """The project state root that a path stands for, or None when the path is no project.

    A path holding project.json is the state root (a project root from before the split works the same way); any other path is
    taken as a project directory, whose state root is <PROJECT_OUTPUT>\\<directory name>\\raw. A path that is neither is a skill session."""
    path = Path(path)
    if (path / "project.json").is_file():
        return path
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


def record_path(session, caller, stage=None):
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
        if len(args) < 2 or result.get("url_check", {}).get("requested") != args[1]:
            raise ValueError("采集命令网址与返回日志不符")
        candidates = [result]
    else:
        if len(args) < 3 or result.get("query") != args[2] or result.get("platform") != args[1]:
            raise ValueError("搜索命令关键词/平台与返回日志不符")
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


def report_errors(path, value):
    """A record written by conclude names its conclusion page and that page's SHA-256; the page must still match."""
    if "report_sha256" not in value:
        return []
    page = Path(path).with_suffix(".html")
    if value.get("report") != page.name or not page.is_file() or digest(page) != value["report_sha256"]:
        return ["检索结论 HTML 缺失或与记录不符，请重新运行 conclude 生成"]
    return []


def validate_preflight(session, caller, stage=None, *, require_findings=True):
    """Check real body evidence AND the caller's supplements, never just a passed label."""
    path = record_path(session, caller, stage)
    prefix = f"Crawl 前置检索 {caller}{'/' + stage if stage else ''}"
    if not path.is_file():
        return [f"{prefix}: 缺少记录 {path}；先运行 crawl_preflight.py run，再 conclude"]
    try:
        value = read(path)
        if not isinstance(value, dict):
            raise ValueError("记录必须是 JSON 对象")
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
        if any(type(s.get("exit_code")) is not int for s in steps):
            errors.append("命令退出码必须是整数")
        names = [s.get("command") for s in steps if s.get("exit_code") == 0]
        if not all(n in names for n in ("doctor", "experience", "summary")) or not any(n in names for n in ("search", "capture")):
            errors.append("必须执行 doctor → experience → search/capture → summary，不能只有连通检查")
        elif names.index("doctor") > names.index("experience") or names.index("experience") > min(names.index(n) for n in ("search", "capture") if n in names):
            errors.append("前置检索执行顺序错误")
        observed_archives = set()
        for step in steps:
            log = _log_inside(step["file"], path.parent)
            if not log.is_file() or digest(log) != step.get("sha256"):
                errors.append("命令日志哈希不符/丢失")
            elif step.get("command") == "doctor" and not doctor_ok(read(log)):
                errors.append("Crawl 未就绪")
            elif step.get("command") in {"search", "capture"} and step.get("exit_code") == 0:
                observed_archives.update(_observed_sources(step, read(log), task))
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
            if value.get("status") != "complete" or not findings:
                errors.append("尚未填写检索补充信息及采用位置（conclude）")
            errors.extend(findings_errors(value, ids))
            errors.extend(report_errors(path, value))
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
    page = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta http-equiv="Content-Security-Policy" content="{esc(CSP)}"><meta name="referrer" content="no-referrer">'
            f'<link rel="icon" href="{ICON}"><title>{esc(heading)}</title><style>{css}</style></head>'
            f'<body><main><h1>{esc(heading)}</h1>{body}</main></body></html>\n')
    target = Path(path).with_suffix(".html")
    target.write_text(page, encoding="utf-8")
    return target


def conclude(session, caller, findings, stage=None):
    errors = validate_preflight(session, caller, stage, require_findings=False)
    if errors:
        raise ValueError("; ".join(errors))
    path = record_path(session, caller, stage)
    value = read(path)
    errors = findings_errors(findings, {s["id"] for s in value["sources"]})
    if errors:
        raise ValueError("; ".join(errors))
    for key in ("report", "report_sha256"):
        value.pop(key, None)
    value.update({"findings": findings.get("findings", []), "gaps": findings.get("gaps", []), "scope": findings.get("scope", value["topic"]), "status": "complete", "concluded_at": now()})
    write(path, value)
    errors = validate_preflight(session, caller, stage)
    if errors:
        value["status"] = "needs-conclusion"
        write(path, value)
        raise ValueError("; ".join(errors))
    page = render_report(path, value)
    value.update({"report": page.name, "report_sha256": digest(page)})
    write(path, value)
    return path


def run(session, caller, topic, task=None, queries=None, urls=None, stage=None, platform="bing", read_count=1):
    if not isinstance(read_count, int) or not 1 <= read_count <= 5:
        raise ValueError("--read 须为 1 到 5")
    path = record_path(session, caller, stage)
    value = {"schema_version": 1, "caller": caller, "stage": stage, "topic": topic, "started_at": now(), "finished_at": None, "status": "running", "sources": [], "findings": [], "gaps": [], "steps": []}
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    logs = path.parent / "logs" / f"{path.stem}-{run_id}"
    logs.mkdir(parents=True)

    def command(name, *args, route=False):
        """Run one Crawl command and log it. A ``route`` (one search or one capture) that fails keeps its log and its exit code and the run goes on:
        another route may still bring the body (references/preflight.md 判定); every other command failing stops the run."""
        index = len(value["steps"])
        output = logs / f"{index:02d}-{name}.json"
        print(f"[preflight] {caller}: {name}", file=sys.stderr, flush=True)
        try:
            result = subprocess.run(["node", str(CLI), name, *map(str, args)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300, shell=False)
            code, stdout, stderr = result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            if not route:
                raise
            code, stdout, stderr = 124, "", "timeout after 300 s"
        output.write_text(stdout or "{}", encoding="utf-8")
        (logs / f"{index:02d}-{name}.stderr.txt").write_text(stderr, encoding="utf-8")
        value["steps"].append({"command": name, "args": [name, *map(str, args)], "exit_code": code, "file": str(output), "sha256": digest(output)})
        write(path, value)
        if code:
            if not route:
                raise ValueError(f"{name} 失败；详情 {output}")
            print(f"[preflight] {caller}: {name} 没有取得正文（退出码 {code}），保留日志，继续其他路线", file=sys.stderr, flush=True)
            try:
                parsed = json.loads(stdout)
            except ValueError:
                return {}
            return parsed if isinstance(parsed, dict) else {}
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
        command("experience", "--query", topic)
        archives = []
        for query in (queries or ([] if urls else [topic])):
            result = command("search", platform, query, "--read", read_count, "--out", task, route=True)
            archives += _observed_sources(value["steps"][-1], result, task)
        for url in urls or []:
            result = command("capture", url, "--out", task, route=True)
            archives += _observed_sources(value["steps"][-1], result, task)
        command("summary", task)
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
            if source["url"] not in seen_urls and not source_errors(source, task):
                seen_urls.add(source["url"])
                value["sources"].append(source)
        value["status"] = "needs-conclusion" if value["sources"] else "blocked"
        value["finished_at"] = now()
        write(path, value)
        if not value["sources"]:
            raise ValueError("没有取得有效正文，不能标记完成；请补充网址或缩小查询后重跑")
        return {"record": str(path), "status": value["status"], "task": str(task), "sources": value["sources"], "next": "阅读 sources[].archive 里 content.json 的正文后，用 conclude --file 记录补充信息、采用位置和未覆盖范围"}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        value.update(status="blocked", finished_at=now(), error=str(exc))
        write(path, value)
        raise ValueError(f"{exc}；记录 {path}") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "conclude", "check"):
        p = sub.add_parser(name)
        p.add_argument("--session", type=Path, required=True, help="本技能会话目录（记录写在其 raw/00-crawl/），或项目目录/状态根（写在状态根下 project.json 的 crawl.evidence_index）")
        p.add_argument("--caller", choices=CALLERS, required=True, help="实际执行检索的技能")
        p.add_argument("--stage", help="项目阶段，如 research、design；三条命令必须一致")
        if name == "run":
            p.add_argument("--topic", required=True, help="这次缺什么信息；不含密钥或真实用户数据")
            p.add_argument("--task", type=Path, help="begin 返回的任务目录；同一需求的各技能、各阶段共用")
            p.add_argument("--query", action="append", help="可重复；缺省用 --topic")
            p.add_argument("--url", action="append", help="可重复；已知官方原文")
            p.add_argument("--platform", default="bing", help="--query 使用的检索入口，默认 bing；也可用 github、gitee、xhs、douyin 等")
            p.add_argument("--read", type=int, default=1, help="每个查询打开的详情数，1 到 5，默认 1")
        if name == "conclude":
            p.add_argument("--file", type=Path, required=True)
    a = parser.parse_args()
    try:
        if a.command == "run":
            value = run(a.session, a.caller, a.topic, a.task, a.query, a.url, a.stage, a.platform, a.read)
        elif a.command == "conclude":
            record = conclude(a.session, a.caller, read(a.file), a.stage)
            value = {"record": str(record), "report": str(record.with_suffix(".html")), "status": "complete"}
        else:
            errors = validate_preflight(a.session, a.caller, a.stage)
            value = {"ok": not errors, "errors": errors}
            if not errors:
                value["report"] = str(record_path(a.session, a.caller, a.stage).with_suffix(".html"))
            print(json.dumps(value, ensure_ascii=False, indent=2))
            return 1 if errors else 0
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
