"""The shared research floor. Counts never substitute for relevance or semantic review."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MIN_QUERIES = 5
MIN_SOURCES = 10
MIN_PUBLISHERS = 3
MIN_PRIMARY = 3

# Historical stages have no policy field and retain their original floor.
def research_floor(record):
    mode = record.get("research_mode", "deep")
    defaults = {"search": (1, 3, 1, 1), "deep": (MIN_QUERIES, MIN_SOURCES, MIN_PUBLISHERS, MIN_PRIMARY),
                "urls": (0, 1, 1, 0)}
    if mode not in defaults:
        raise ValueError("无效的联网检索模式")
    queries, sources, publishers, primary = defaults[mode]
    requested = record.get("min_sources", sources)
    if type(requested) is not int or requested < 1:
        raise ValueError("--min-sources 必须是正整数")
    return {"queries": min(queries, requested), "sources": requested, "publishers": min(publishers, requested),
            "primary": min(primary, requested)}


def normalized(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(text or ""))).strip()


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def canonical(url):
    parts = urlsplit(str(url))
    query = [(k, v) for k, v in parse_qsl(parts.query) if not k.lower().startswith("utm_") and k.lower() not in {"ref", "fbclid", "gclid"}]
    route = parts.fragment if parts.fragment.startswith(("/", "!/")) else ""
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), urlencode(sorted(query)), route))


def site_key(url):
    parts = urlsplit(str(url))
    host = (parts.hostname or "").lower()
    labels = host.split(".")
    # GitHub is a multi-tenant host. Its customers are publishers, not GitHub
    # itself; repository and Pages URLs of the same owner must still group.
    if host.endswith(".github.io") and len(labels) >= 3:
        return labels[-3] + ".github-owner"
    if host in {"github.com", "www.github.com"}:
        path = [part for part in parts.path.split("/") if part]
        if len(path) >= 2 and path[0].lower() not in {"features", "topics", "collections", "orgs", "settings", "login", "signup"}:
            return path[0].lower() + ".github-owner"
    domain = ".".join(labels[-3:]) if ".".join(labels[-2:]) in {"co.uk", "com.cn", "org.cn", "com.au", "co.jp"} else ".".join(labels[-2:])
    return {"claude.com": "anthropic.com", "chatgpt.com": "openai.com"}.get(domain, domain)


def body(source, *, resolve=Path):
    archive = resolve(source["archive"])
    file = archive / "content.json"
    if not file.is_file():
        file = archive / "raw" / "content.json"
    content = json.loads(file.read_text(encoding="utf-8-sig"))
    return content.get("text") or (content.get("post") or {}).get("text") or ""


def executed_search(step):
    return (step.get("command") == "search" and step.get("exit_code") == 0 and
            step.get("search_performed", True) is True and len(step.get("args") or []) >= 3)


def breadth_counts(value, *, resolve=Path, bodies_by_id=None):
    queries = {normalized(s["args"][2]).casefold() for s in value.get("steps", []) if executed_search(s)}
    sources = value.get("sources", [])
    urls, bodies, sites = set(), set(), set()
    for source in sources:
        urls.add(canonical(source.get("url")))
        sites.add(site_key(source.get("url")))
        text = bodies_by_id[source["id"]] if bodies_by_id is not None else normalized(body(source, resolve=resolve))
        bodies.add(hashlib.sha256(text.encode("utf-8")).hexdigest())
    return {"queries": len(queries - {""}), "sources": min(len(urls), len(bodies)), "publishers": len(sites - {""})}


def breadth_errors(value, *, resolve=Path, bodies_by_id=None, counts=None):
    counts = counts or breadth_counts(value, resolve=resolve, bodies_by_id=bodies_by_id)
    floor = research_floor(value)
    errors = []
    if counts["queries"] < floor["queries"]:
        errors.append(f"必须完成至少 {floor['queries']} 组不同查询；本阶段只有 {counts['queries']} 组")
    if counts["sources"] < floor["sources"]:
        errors.append(f"必须阅读至少 {floor['sources']} 篇去重正文；本阶段只有 {counts['sources']} 篇，镜像与重复正文不重复计数")
    if counts["publishers"] < floor["publishers"]:
        errors.append(f"正文至少覆盖 {floor['publishers']} 个独立站点主体；同主体的子域不能重复计数")
    return errors


def design_library():
    root = Path(os.environ.get("LUZ_DESIGN_ROOT") or Path(__file__).resolve().parents[2] / "Luz-Design")
    file = root / "scripts" / "template_library.py"
    spec = importlib.util.spec_from_file_location("_luz_required_design_library", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def research_errors(value, payload, *, resolve=Path, template_context=None):
    sources = {s["id"]: s for s in value["sources"]}
    bodies = {key: normalized(body(source, resolve=resolve)) for key, source in sources.items()}
    floor = research_floor(value)
    errors = []
    findings = payload.get("findings", [])
    by_id = {}
    for finding in findings:
        identifier = finding.get("id")
        if not _text(identifier) or identifier in by_id:
            errors.append("每条结论必须有唯一 id")
            continue
        by_id[identifier] = finding
        if finding.get("kind") not in ("fact", "reference", "decision"):
            errors.append("结论 kind 必须区分 fact、reference 或 decision，方案决定不得冒充来源事实")
        quote = finding.get("quote")
        source = sources.get(finding.get("source_id"))
        if not _text(quote) or len(normalized(quote)) < 12 or not _text(finding.get("locator")):
            errors.append("每条结论必须有不少于 12 字符的逐字 quote 与原文定位 locator")
        elif source is not None and normalized(quote) not in bodies[source["id"]]:
            errors.append(f"引用摘录不在本次归档正文中：{identifier}；禁止编造或改写原文后冒充引文")
    reviews = payload.get("source_reviews")
    reviewed, publishers, primary, excluded = set(), set(), set(), set()
    site_publishers = {}
    if not isinstance(reviews, list):
        errors.append("缺少全部来源的 source_reviews 权威性与发布主体评估")
        reviews = []
    for review in reviews:
        if not isinstance(review, dict) or not _text(review.get("source_id")) or review.get("source_id") not in sources or not _text(review.get("publisher")) or not _text(review.get("reason")) or review.get("authority") not in ("primary", "first_party", "secondary"):
            errors.append("来源评估缺少有效来源、真实发布主体、级别或判断理由")
            continue
        identifier = review["source_id"]
        if identifier in reviewed:
            errors.append("source_reviews 的来源不能重复")
        reviewed.add(identifier)
        publisher = normalized(review["publisher"]).casefold()
        site = site_key(sources[identifier]["url"])
        if site in site_publishers and site_publishers[site] != publisher:
            errors.append("同一站点主体不能用不同发布方名称凑数")
        site_publishers[site] = publisher
        if "exclude_from_count" in review and type(review["exclude_from_count"]) is not bool:
            errors.append("exclude_from_count 必须为布尔值，并在 reason 说明排除依据")
        if review.get("exclude_from_count") is True:
            excluded.add(identifier)
            continue
        publishers.add(publisher)
        if review["authority"] in {"primary", "first_party"}:
            primary.add(identifier)
    counted = [s for s in value["sources"] if s["id"] not in excluded]
    errors.extend(breadth_errors({**value, "sources": counted}, bodies_by_id=bodies))
    if any(f.get("source_id") in excluded and f.get("adopted") is True for f in findings):
        errors.append("排除的重复、无关或不可用来源不能作为已采用依据")
    if reviewed != set(sources):
        errors.append("每篇正文都须评估，不能抓取后不读或只列链接凑数")
    if len(publishers) < floor["publishers"]:
        errors.append(f"至少需要 {floor['publishers']} 个经核实的独立发布主体")
    if min(len({bodies[i] for i in primary}), len({canonical(sources[i]["url"]) for i in primary})) < floor["primary"]:
        errors.append(f"至少需要 {floor['primary']} 篇官方、标准或一手原文；转载不能充当一手依据")
    if {f.get("source_id") for f in findings} != set(sources):
        errors.append("每篇已读正文都须有带摘录的采用或排除记录")
    blocking = payload.get("blocking_gaps")
    if not isinstance(blocking, list) or blocking:
        errors.append("blocking_gaps 必须是空数组；关键缺口未核实前禁止成稿、设计与开发")
    templates = payload.get("template_uses")
    coverage = payload.get("coverage")
    chat_answer = (value.get("caller") == "luz-crawl" and value.get("research_mode") in {"search", "urls", "deep"}
                   and templates == [] and isinstance(coverage, list) and bool(coverage)
                   and all(isinstance(row, dict) and row.get("applies_to") == "对话答复" for row in coverage))
    if not chat_answer:
        if template_context is None:
            errors.extend(design_library().validate_references(templates))
        else:
            # A concluded record's selection context only audits the original references.
            session, caller, stage = template_context
            errors.extend(design_library().validate_selected_references(session, caller, stage, templates))
    targets = {t.get("applies_to") for t in templates or [] if isinstance(t, dict) and _text(t.get("applies_to"))}
    if not isinstance(coverage, list) or not coverage:
        errors.append("缺少需求／章节／页面／开发决定到来源结论的 coverage 表")
        coverage = []
    for row in coverage:
        if not isinstance(row, dict) or not _text(row.get("question")) or not _text(row.get("applies_to")):
            errors.append("覆盖项须写清待回答问题和实际采用位置")
            continue
        identifiers = row.get("finding_ids")
        if not isinstance(identifiers, list) or not identifiers or any(not isinstance(i, str) or i not in by_id or by_id[i].get("adopted") is not True for i in identifiers):
            errors.append("覆盖项必须关联实际采用的有效结论，未采用或不存在的结论不能支撑决定")
        if not chat_answer and row["applies_to"] not in targets:
            errors.append("每个覆盖项的输出必须绑定已核验的 Luz-Design 模板")
    return list(dict.fromkeys(errors))
