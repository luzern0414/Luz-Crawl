"""生成汇总页 NNN-主题.html（七个技能共用，母本在 Luz-Design，其余仓库放同样的副本）。

  py -X utf8 make_summary.py spec.json <会话目录> [--check] [--project-linked]

汇总页放在会话目录根（与 raw 目录同级），文件名与目录同名。版式固定：浅色正式文档、单一字体族、Markdown 层级字阶（桌面正文 18、手机 16）、
第一行是主标题、每节一张带表题的表。成品本身就是 HTML 的任务（文章、系统设计页等）不用本脚本，成品即汇总页，但要符合同一版式。

spec.json：
  {"title": "主标题",
   "sections": [
     {"title": "成果", "text": "可选的一段话",
      "table": {"caption": "表 1 成果清单", "columns": ["名称", "用途", "位置"], "rows": [["…", "…", "…"]],
                "align": ["left", "left", "left"]}}]}
align 每列 left / center / right，缺省 left（长文字靠左，短值居中，金额靠右）。节内没有内容就不要写这一节。
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23E6F4FF'/%3E"
        "%3Cg fill='none' stroke='%230958D9' stroke-width='2.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 7h8l5 5v13H10z'/%3E"
        "%3Cpath d='M18 7v5h5M13.5 17h6M13.5 21h4'/%3E%3C/g%3E%3C/svg%3E")

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
.table-wrap { margin: 0 0 24px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; text-align: left; }
th { background: var(--tint); text-align: center; }
td.center { text-align: center; } td.right { text-align: right; }
@media (max-width: 768px) { main { width: auto; margin: 0; padding: 32px 16px; border-radius: 0; } }
@media print { body { background: #fff; } main { width: auto; margin: 0; padding: 0; } section { break-inside: avoid-table-row; } }"""


def esc(value) -> str:
    return html.escape(str(value), quote=False)


def render(spec: dict) -> str:
    title = str(spec.get("title") or "").strip()
    if not title:
        raise ValueError("spec 缺少 title")
    parts = [f"<h1>{esc(title)}</h1>"]
    for sec in spec.get("sections", []):
        body = [f"<h2>{esc(sec['title'])}</h2>"]
        if sec.get("text"):
            body.append(f"<p>{esc(sec['text'])}</p>")
        table = sec.get("table")
        if table:
            cols = table["columns"]
            align = list(table.get("align") or []) + ["left"] * len(cols)
            for row in table["rows"]:
                if len(row) != len(cols):
                    raise ValueError(f"表“{table.get('caption', sec['title'])}”有一行列数与表头不一致: {row}")
            head = "".join(f'<th scope="col">{esc(c)}</th>' for c in cols)
            rows = "".join("<tr>" + "".join(f'<td class="{align[i]}">{esc(v)}</td>' for i, v in enumerate(row)) + "</tr>" for row in table["rows"])
            caption = f"<caption>{esc(table['caption'])}</caption>" if table.get("caption") else ""
            body.append(f'<div class="table-wrap"><table>{caption}<thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>')
        parts.append("<section>" + "".join(body) + "</section>")
    return ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{esc(title)}</title>\n<link rel="icon" href="{ICON}">\n<style>\n{FRAME}\n{MD_TYPE}\n</style>\n</head>\n<body>\n<main>\n'
            + "\n".join(parts) + "\n</main>\n</body>\n</html>\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("session", help="会话目录，如 D:/Codes/skill输出/<技能>/NNN-主题")
    ap.add_argument("--check", action="store_true", help="写完后检查会话目录布局")
    ap.add_argument("--project-linked", action="store_true")
    args = ap.parse_args(argv)
    session = Path(args.session)
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    session.mkdir(parents=True, exist_ok=True)
    (session / "raw").mkdir(exist_ok=True)
    target = session / f"{session.name}.html"
    target.write_text(render(spec), encoding="utf-8")
    print(target)
    if args.check:
        import check_output_layout
        return check_output_layout.main(["session", str(session)] + (["--project-linked"] if args.project_linked else []))
    return 0


if __name__ == "__main__":
    sys.exit(main())
