"""生成汇总页 NNN-主题.html（七个技能共用，母本在 Luz-Design，其余仓库放同样的副本）。

  py -X utf8 make_summary.py spec.json <会话目录> [--stage <项目阶段>] [--check] [--project-linked]

汇总页放在会话目录根（与 raw 目录同级），文件名与目录同名。版式固定：浅色正式文档、单一字体族、Markdown 层级字阶（桌面正文 18、手机 16）、
第一行是主标题、比较用带表题的表，推理用段落。成品本身就是 HTML 的任务也遵守同一阅读版式。

spec.json：
  {"title": "主标题",
   "sections": [
     {"title": "成果", "text": "可选的一段话",
      "table": {"caption": "表 1 成果清单", "columns": ["名称", "用途", "位置"], "rows": [["…", "…", "…"]],
                "align": ["left", "left", "left"]}}]}
align 每列 left / center / right，缺省 left（长文字靠左，短值居中，金额靠右）。节内没有内容就不要写这一节。
正文/表格单元格可用 {"text": "原文标题", "href": "https://发布方/原文"}；本会话内使用 raw/... 相对链接。
每节可用 paragraphs 数组表达连续段落；无需把推理挤进表格。链接不接受脚本、凭据、绝对本地路径或上级目录。
超过八节的长文自动在首节后提供可跳转目录，桌面与窄屏均保留。
"""
from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

# Imagegen 彩色实心图标，原图与派生记录见 kit/frontend/generated-assets.json
# solid-content.webp SHA-256: 618fc056653ec49d6a8871fc0702d992761ab12efa467ef91a2c959f32bd1ff6
ICON = "data:image/webp;base64,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"

MD_TYPE = r'''/* luz-md-type:start
   阅读型网页的 Markdown 层级（母本：Luz-Design/references/md-type.css）。其他技能的样式文件里夹着同一段，
   改这里之后运行 py -X utf8 scripts/sync_md_type.py --write 同步，不要在别处手改（不带参数运行只报告 SAME 或 DIFF）。
   规则见 file-design.html 网页文件 › 排版参数（逐级数值表）与 visual-design.html 一 › 字体与字号 › 字阶表的阅读型网页一行：手机（小于 768）与桌面（768 及以上）各一套字号，
   桌面正文 18，手机 16；每一级的字号、字重、行高、上下留白固定，页面只取这些级别，不另造样式。
   只管文字层级，不管容器宽度、颜色主题与组件：颜色取页面已有的变量，缺省用下面的回退值。 */
:root {
  --md-body: 16px;  --md-body-lh: 1.75;
  --md-h1: 28px;  --md-h2: 24px;  --md-h3: 20px;  --md-h4: 16px;  --md-h5: 14px;  --md-h6: 14px;
  --md-table: 14px;  --md-aux: 14px;  --md-code: 14px;
  --md-measure: 42em;
}
@media (min-width: 768px) {
  :root {
    --md-body: 18px;  --md-body-lh: 1.8;
    --md-h1: 36px;  --md-h2: 28px;  --md-h3: 22px;  --md-h4: 18px;  --md-h5: 16px;  --md-h6: 14px;
    --md-table: 16px;  --md-aux: 14px;  --md-code: 16px;
  }
}
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { font-size: var(--md-body); line-height: var(--md-body-lh); font-weight: 400; font-kerning: normal; text-rendering: optimizeLegibility; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { font-family: inherit; font-style: normal; letter-spacing: 0; text-wrap: balance; }
h1 { margin: 0 0 24px; font-size: var(--md-h1); line-height: 1.25; font-weight: 700; }
h2 { margin: 56px 0 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line, #d7e0e8); font-size: var(--md-h2); line-height: 1.3; font-weight: 700; }
h3 { margin: 40px 0 12px; font-size: var(--md-h3); line-height: 1.4; font-weight: 600; }
h4 { margin: 28px 0 8px; font-size: var(--md-h4); line-height: 1.5; font-weight: 600; }
h5 { margin: 24px 0 8px; font-size: var(--md-h5); line-height: 1.5; font-weight: 600; color: var(--muted, var(--ink-2, #526071)); }
h6 { margin: 20px 0 8px; font-size: var(--md-h6); line-height: 1.5; font-weight: 600; color: var(--muted, var(--ink-2, #526071)); }
p { margin: 0 0 16px; }
p, ul, ol, dl, blockquote { max-width: var(--md-measure); }
ul, ol { margin: 0 0 16px; padding-left: 1.6em; }
li { margin: 0; }
li + li { margin-top: 6px; }
li > ul, li > ol { margin: 6px 0 0; }
ul { list-style: disc; }
ul ul { list-style: circle; }
ul ul ul { list-style: square; }
li::marker { color: var(--muted, var(--ink-2, #526071)); }
dt { font-weight: 600; }
dd { margin: 2px 0 12px; padding-left: 1em; }
strong, b { font-weight: 600; }
em, i, cite, address { font-style: normal; font-weight: 600; }
blockquote { margin: 0 0 16px; padding: 4px 0 4px 16px; border-left: 4px solid var(--line, #d7e0e8); color: var(--muted, var(--ink-2, #526071)); }
blockquote > :last-child { margin-bottom: 0; }
hr { margin: 40px 0; border: 0; border-top: 1px solid var(--line, #d7e0e8); }
small, figcaption, caption, time, .aux, .src { font-size: var(--md-aux); line-height: 1.6; }
caption, figcaption { margin: 0; padding: 0 0 10px; color: var(--muted, var(--ink-2, #526071)); text-align: center; }
caption { caption-side: top; }
table { font-size: var(--md-table); line-height: 1.65; font-variant-numeric: tabular-nums; }
th { font-weight: 600; }
td > :last-child, th > :last-child { margin-bottom: 0; }
code, kbd, samp, pre { font-family: "Cascadia Mono", "Consolas", "Microsoft YaHei", monospace; font-size: var(--md-code); line-height: 1.6; }
code, kbd, samp { padding: 2px 6px; border-radius: 8px; background: var(--surface-soft, var(--surface-2, #edf3f7)); overflow-wrap: anywhere; }
pre { margin: 0 0 16px; padding: 16px 20px; overflow: auto; border: 1px solid var(--line, #d7e0e8); border-radius: 8px; background: var(--surface, #f7f9fc); }
pre code { padding: 0; border-radius: 0; background: none; font-size: inherit; }
@media print {
  :root { --md-body: 11pt; --md-body-lh: 1.7; --md-h1: 22pt; --md-h2: 17pt; --md-h3: 14pt; --md-h4: 12pt; --md-h5: 11pt; --md-h6: 10.5pt; --md-table: 10.5pt; --md-aux: 10.5pt; --md-code: 10.5pt; }
}
/* luz-md-type:end */'''

FRAME = """:root { color-scheme: light; --canvas: #f7f7f5; --paper: #ffffff; --ink: #202124; --muted: #5f6368; --line: #dadce0; --tint: #e9f2f5; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; }
main { width: min(960px, calc(100% - 32px)); margin: 24px auto; padding: 48px; border-radius: 8px; background: var(--paper); }
nav { margin: 32px 0; font-size: var(--md-table); } nav ul { columns: 2; column-gap: 32px; } nav li { break-inside: avoid; }
a:focus-visible, h2:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
h2[id] { scroll-margin-top: 24px; }
.table-wrap { margin: 0 0 24px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; text-align: left; }
th:first-child, td:first-child { min-width: 7em; }
th { background: var(--tint); text-align: center; }
td.center { text-align: center; } td.right { text-align: right; }
@media (max-width: 768px) { main { width: auto; margin: 0; padding: 32px 16px; border-radius: 0; } nav ul { columns: 1; } }
@media print { body { background: #fff; } main { width: auto; margin: 0; padding: 0; } nav { display: none; } tr, img { break-inside: avoid; } h2 { break-after: avoid; } }"""


def esc(value) -> str:
    return html.escape(str(value), quote=False)


def content(value) -> str:
    if not isinstance(value, dict):
        return esc(value)
    if set(value) != {"text", "href"} or not isinstance(value["text"], str) or not isinstance(value["href"], str):
        raise ValueError("链接必须只有 text 与 href 字符串")
    url = value["href"]
    decoded = unquote(url)
    parts = urlsplit(url)
    safe_chars = bool(url) and not any(ord(c) < 32 or ord(c) == 127 for c in decoded) and "\\" not in decoded
    remote = parts.scheme in {"http", "https"} and bool(parts.hostname) and not parts.username and not parts.password
    local = not parts.scheme and not parts.netloc and not decoded.startswith('/') and '..' not in decoded.split('/')
    if not safe_chars or not (remote or local):
        raise ValueError("不安全或越出会话目录的参考链接")
    return f'<a href="{html.escape(url, quote=True)}" rel="noreferrer">{esc(value["text"])}</a>'


def render(spec: dict) -> str:
    title = str(spec.get("title") or "").strip()
    if not title:
        raise ValueError("spec 缺少 title")
    parts = [f"<h1>{esc(title)}</h1>"]
    sections = spec.get("sections", [])
    long_document = len(sections) > 8
    navigation = ('<nav aria-label="本页目录"><p>本页目录</p><ul>'
                  + ''.join(f'<li><a href="#section-{index}">{esc(sec["title"])}</a></li>'
                            for index, sec in enumerate(sections, 1)) + '</ul></nav>') if long_document else ''
    for index, sec in enumerate(sections, 1):
        anchor = f' id="section-{index}" tabindex="-1"' if long_document else ''
        body = [f"<h2{anchor}>{esc(sec['title'])}</h2>"]
        if sec.get("text"):
            body.append(f"<p>{content(sec['text'])}</p>")
        paragraphs = sec.get('paragraphs', [])
        if not isinstance(paragraphs, list):
            raise ValueError('paragraphs 必须是段落数组')
        body.extend(f'<p>{content(paragraph)}</p>' for paragraph in paragraphs)
        table = sec.get("table")
        if table:
            cols = table["columns"]
            align = list(table.get("align") or []) + ["left"] * len(cols)
            if any(value not in {'left', 'center', 'right'} for value in align):
                raise ValueError('表格 align 只能使用 left/center/right')
            for row in table["rows"]:
                if len(row) != len(cols):
                    raise ValueError(f"表“{table.get('caption', sec['title'])}”有一行列数与表头不一致: {row}")
            head = "".join(f'<th scope="col">{esc(c)}</th>' for c in cols)
            rows = "".join("<tr>" + "".join(f'<td class="{align[i]}">{content(v)}</td>' for i, v in enumerate(row)) + "</tr>" for row in table["rows"])
            caption = f"<caption>{esc(table['caption'])}</caption>" if table.get("caption") else ""
            body.append(f'<div class="table-wrap"><table>{caption}<thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>')
        parts.append("<section>" + "".join(body) + "</section>")
        if index == 1 and navigation:
            parts.append(navigation)
    return ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{esc(title)}</title>\n<link rel="icon" href="{ICON}">\n<style>\n{FRAME}\n{MD_TYPE}\n</style>\n</head>\n<body>\n<main>\n'
            + "\n".join(parts) + "\n</main>\n</body>\n</html>\n")


def _load_gate(path: Path):
    spec = importlib.util.spec_from_file_location(f"_summary_{path.parent.parent.name.replace('-', '_')}_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"无法加载 Crawl 校验器: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_summary_preflight(session: Path, stage: str | None = None) -> dict:
    """Gate only this CLI; upstream writers keep using the pure render API.

    The repository owns the caller identity. Linked sessions use project-stage
    evidence, including the owning skill of a Luz-Project stage.
    """
    session = Path(session).resolve()
    scripts = Path(__file__).resolve().parent
    caller = scripts.parent.name.lower()
    saved_path = sys.path[:]
    try:
        sys.path.insert(0, str(scripts))
        if caller == "luz-design":
            gate = _load_gate(scripts / "crawl_gate.py")
            _, context = gate._context(session, stage=stage)
            effective = (context["stage"] if context["project"] is not None
                         else stage or os.environ.get("LUZ_CRAWL_STAGE") or "summary")
            context = gate.require_session_preflight(session, stage=effective)
            if context["session"] != session:
                raise ValueError("汇总页目标必须是完整 Design 会话根目录")
            return {**context, "template_root": session, "stage": effective}
        crawl_root = Path(os.environ.get("LUZ_CRAWL_ROOT") or scripts.parents[1] / "Luz-Crawl")
        crawl = _load_gate(crawl_root / "scripts" / "crawl_preflight.py")
        if caller not in crawl.CALLERS:
            raise ValueError(f"未知汇总页所属技能: {caller}")
        state = crawl.state_root(session)
        if state is None and (session / "raw" / "project.json").is_file():
            state = session / "raw"
        linked_stage = None
        for relative in ("raw/99-delivery/MANIFEST.json", "raw/manifest.json", "raw/plan.json"):
            manifest = session / relative
            if not manifest.is_file():
                continue
            data = crawl.read(manifest)
            if not isinstance(data, dict):
                raise ValueError(f"会话记录必须是 JSON 对象: {manifest}")
            link = data.get("project")
            if link is None:
                continue
            reference = link if isinstance(link, str) else (link.get("state_root") or link.get("stateRoot")) if isinstance(link, dict) else None
            if not reference:
                raise ValueError(f"会话缺少有效 project.state_root: {manifest}")
            state = crawl.state_root(Path(reference))
            if state is None:
                raise ValueError(f"关联项目缺少 project.json: {reference}")
            linked_stage = link.get("stage") if isinstance(link, dict) else None
            break
        if state is None and os.environ.get("LUZ_PROJECT_ROOT"):
            state = crawl.state_root(Path(os.environ["LUZ_PROJECT_ROOT"]))
            if state is None:
                raise ValueError("LUZ_PROJECT_ROOT 没有对应项目状态根")
        evidence, owner = session, caller
        if state is not None:
            evidence = Path(state).resolve()
            project = crawl.read(evidence / "project.json")
            if stage and linked_stage and stage != linked_stage:
                raise ValueError("--stage 与会话关联的项目阶段不一致")
            legacy_stage = None
            if project.get("workflow") != "commercial-v1":
                legacy_stage = {"luz-system": "architecture", "luz-dev": "technical-plan"}.get(caller)
            stage = stage or linked_stage or legacy_stage or project.get("current_stage")
            if not stage:
                raise ValueError("项目汇总页需要会话中的阶段或 --stage")
            if project.get("workflow") == "commercial-v1":
                owner = crawl.stage_evidence_caller(evidence, caller, stage)
            if caller == "luz-project":
                owner = next((item.get("owner") for item in project.get("stages", []) if item.get("id") == stage), None)
                if owner not in crawl.CALLERS:
                    raise ValueError(f"项目阶段没有有效负责技能: {stage}")
        if state is None:
            stage = stage or os.environ.get("LUZ_CRAWL_STAGE") or "summary"
        if caller in {"luz-system", "luz-dev", "luz-ops", "luz-writing"}:
            filename = "08-crawl_gate.py" if caller == "luz-writing" else "crawl_gate.py"
            errors = _load_gate(scripts / filename).crawl_errors(evidence, stage, caller=owner, state_root=state)
        elif caller == "luz-project" and state is not None:
            errors = _load_gate(scripts / "project_crawl_gate.py").crawl_errors(evidence, stage, caller=owner)
        else:
            errors = crawl.validate_preflight(evidence, owner, stage)
        if errors:
            raise ValueError("; ".join(errors))
        return {"session": session, "raw": session / "raw", "project": state and str(crawl.read(Path(state) / "project.json").get("deliver_root") or "") or None,
                "evidence_root": evidence, "template_root": session, "caller": caller, "stage": stage}
    finally:
        sys.path[:] = saved_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("session", help="会话目录，如 E:/Skill输出/<技能>/NNN-主题")
    ap.add_argument("--check", action="store_true", help="写完后检查会话目录布局")
    ap.add_argument("--project-linked", action="store_true")
    ap.add_argument("--stage", help="项目阶段；优先使用会话已关联的阶段，不能以此覆盖它")
    args = ap.parse_args(argv)
    session = Path(args.session).resolve()
    try:
        context = require_summary_preflight(session, args.stage)
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        target = session / f"{session.name}.html"
        design_scripts = Path(__file__).resolve().parents[1].parent / "Luz-Design" / "scripts"
        library = _load_gate(design_scripts / "template_library.py")
        template_root = Path(context.get("template_root") or session)
        template_stage = str(context["stage"])
        library.require_selected(template_root, context["caller"], template_stage, target, "reading-html")
        document = render(spec)
        target.write_text(document, encoding="utf-8")
        library.record_output(template_root, context["caller"], template_stage, target, "reading-html",
                              generator="Luz-Design/scripts/make_summary.py")
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"ERROR 汇总页前置检查: {exc}", file=sys.stderr)
        return 1
    print(target)
    if args.check:
        import check_output_layout
        return check_output_layout.main(["session", str(session)] + (["--project-linked"] if args.project_linked else []))
    return 0


if __name__ == "__main__":
    sys.exit(main())
