"""检查 Luz 技能的输出目录是否符合统一规范（七个技能共用，母本在 Luz-Design，其余仓库放同样的副本）。

  py -X utf8 check_output_layout.py session <会话目录> [--project-linked]
  py -X utf8 check_output_layout.py project <项目目录>

session：D:\\Codes\\skill输出\\<技能>\\NNN-主题\\ 根目录只有 raw\\ 和与目录同名的汇总页 NNN-主题.html；
         没有项目目录的任务，成品文件（PDF、XLSX 等）可放在根目录；--project-linked 表示成品在项目目录，根目录不得再放。
project：D:\\Codes\\NNN-项目名\\ 只放成果：docs 下三个平铺目录加实现目录，不放任何源文件或过程文件。
退出码：0 通过（可有提示），1 有错误。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SESSION_NAME = re.compile(r"^\d{3}-[^\\/:*?\"<>|]+$")
LEGACY_NAME = re.compile(r"^\d{2,3}[-_][^\\/:*?\"<>|]+$")
DELIVERABLE_EXT = {".pdf", ".xlsx", ".xls", ".docx", ".pptx", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".md", ".zip", ".csv"}
SESSION_PROCESS_FILES = {"BRIEF.md", "MANIFEST.json", "APPROVALS.json", "spec.json"}

DOC_DIRS = {"01-需求对接": {".pdf", ".xlsx"}, "02-产品开发": {".html"}, "03-验收交付": {".pdf", ".xlsx"}}
DOC_FILE = re.compile(r"^\d{2}-.+")
PROJECT_FORBIDDEN_DIRS = {"raw", "reviews", "uploads", "client-docs", "00-crawl", "00-rules", "99-delivery", "backup", "backups", "_backup", "tmp", "temp"}
PROJECT_FORBIDDEN_FILES = {"project.json", "MANIFEST.json", "APPROVALS.json", "README.html", "BRIEF.md"}
PROJECT_STATE_DIRS = {("data", "client"), ("data", "stages"), ("data", "ops"), ("data", "acceptance"), ("config", "paths.json"), ("config", "documents.json"), ("config", "keys.example.json")}
PROJECT_FORBIDDEN_SUFFIX = (".tmp", ".bak", ".orig", ".pyc")


def check_session(folder: Path, project_linked: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    notes: list[str] = []
    name = folder.name
    if not folder.is_dir():
        return [f"不是目录: {folder}"], notes
    if not SESSION_NAME.match(name):
        (notes if LEGACY_NAME.match(name) else errors).append(
            f"会话目录名应为“三位序号-主题”（如 001-需求说明书），当前是 {name}" + ("（旧格式，保留但新建会话不要用）" if LEGACY_NAME.match(name) else ""))
    summary = folder / f"{name}.html"
    if not (folder / "raw").is_dir():
        errors.append("缺少 raw\\（源文件与过程文件）")
    if not summary.is_file():
        errors.append(f"缺少与目录同名的汇总页 {name}.html（成品本身是 HTML 时它就是汇总页）")
    for item in sorted(folder.iterdir()):
        if item.name in {"raw", summary.name}:
            continue
        if item.is_dir():
            errors.append(f"根目录只能有 raw\\ 和汇总页，多出目录 {item.name}\\（过程文件放进 raw\\）")
        elif item.name in SESSION_PROCESS_FILES:
            errors.append(f"{item.name} 是过程文件，放进 raw 目录")
        elif project_linked:
            errors.append(f"成品已写入项目目录，根目录不要再放 {item.name}")
        elif item.suffix.lower() not in DELIVERABLE_EXT:
            errors.append(f"根目录多出 {item.name}（成品以外的文件放进 raw\\）")
    if summary.is_file():
        text = summary.read_text(encoding="utf-8", errors="replace")
        if not re.search(r"<html[^>]*lang=[\"']zh-CN[\"']", text, re.I):
            notes.append("汇总页缺少 lang=\"zh-CN\"")
        first_h = re.search(r"<h([1-6])\b", text, re.I)
        if not first_h or first_h.group(1) != "1":
            errors.append("汇总页第一个标题应是主标题 h1")
        if len(re.findall(r"<h1\b", text, re.I)) > 1:
            notes.append("汇总页有多个 h1，主标题只写一个")
        if re.search(r"(?i)user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b", text):
            errors.append("汇总页不得禁用缩放")
    return errors, notes


def check_project(folder: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    notes: list[str] = []
    if not folder.is_dir():
        return [f"不是目录: {folder}"], notes
    for item in sorted(folder.iterdir()):
        if item.name in PROJECT_FORBIDDEN_DIRS and item.is_dir():
            errors.append(f"项目目录不保存源文件或过程文件，请移到 skill输出\\Luz-Project\\{folder.name}\\raw\\：{item.name}\\")
        elif item.name in PROJECT_FORBIDDEN_FILES and item.is_file():
            errors.append(f"项目目录不放状态与台账文件，请移到 skill输出\\Luz-Project\\{folder.name}\\raw\\：{item.name}")
        elif item.is_file() and item.suffix.lower() in PROJECT_FORBIDDEN_SUFFIX:
            errors.append(f"临时或备份文件不入项目：{item.name}")
    for parent, child in PROJECT_STATE_DIRS:
        if (folder / parent / child).exists():
            errors.append(f"工具状态不放项目目录，请移到会话的 raw\\：{parent}\\{child}")
    docs = folder / "docs"
    if docs.is_dir():
        for item in sorted(docs.iterdir()):
            if item.is_file():
                errors.append(f"docs 下只有三个目录，多出文件 {item.name}")
            elif item.name not in DOC_DIRS:
                errors.append(f"docs 下只能是 01-需求对接、02-产品开发、03-验收交付，多出 {item.name}\\")
                continue
            else:
                allowed = DOC_DIRS[item.name]
                for f in sorted(item.iterdir()):
                    if f.is_dir():
                        errors.append(f"docs\\{item.name} 平铺，不建子目录：{f.name}\\")
                    elif f.suffix.lower() not in allowed:
                        errors.append(f"docs\\{item.name} 只放 {'、'.join(sorted(e[1:].upper() for e in allowed))}，多出 {f.name}")
                    elif not DOC_FILE.match(f.name):
                        errors.append(f"docs\\{item.name}\\{f.name} 应以两位序号开头，如 01-需求说明书{f.suffix}")
    else:
        notes.append("还没有 docs\\（项目还没有成果时正常）")
    return errors, notes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", choices=["session", "project"])
    ap.add_argument("folder")
    ap.add_argument("--project-linked", action="store_true", help="session：成品已写入项目目录，根目录不得再放成品")
    args = ap.parse_args(argv)
    folder = Path(args.folder)
    errors, notes = check_session(folder, args.project_linked) if args.kind == "session" else check_project(folder)
    for n in notes:
        print(f"  提示 {n}")
    for e in errors:
        print(f"  错误 {e}")
    print(("FAIL" if errors else "PASS") + f": {folder}（{len(errors)} 个错误，{len(notes)} 条提示）")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
