"""Collect a bounded UI-source catalog through the real Luz-Crawl browser CLI.

Seeds are candidates only. Save robots outcomes, actual browser results and
per-source coverage under the existing task; never turn a failed fetch into a
reusable component. Code/license admission is a separate, stricter Design step.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/luz-crawl.mjs"


def invoke(args, log, timeout=180):
    try:
        result = subprocess.run(["node", str(CLI), *map(str, args)], capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=timeout)
        try:
            value = json.loads(result.stdout)
        except ValueError:
            value = {"status": "failed", "stdout": result.stdout}
        record = {"command": args, "exit_code": result.returncode, "result": value,
                  "stderr": result.stderr}
    except subprocess.TimeoutExpired:
        record = {"command": args, "exit_code": -1, "result": {"status": "failed", "reason": "timeout"}}
    log.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--task", required=True)
    ap.add_argument("--seeds", default=str(ROOT / "references/ui-source-seeds.json"))
    ap.add_argument("--concurrency", type=int, default=4, choices=range(1, 7))
    ap.add_argument("--exclude", nargs="*", default=[])
    args = ap.parse_args(argv)
    task = Path(args.task).resolve()
    if not (task / "raw/luz-task.json").is_file():
        ap.error("先用 begin --new 创建任务，随后复用 --task")
    sources = json.loads(Path(args.seeds).read_text(encoding="utf-8-sig"))["sources"]
    sources = [s for s in sources if s["id"] not in args.exclude]
    out = task / "raw/ui-catalog"
    out.mkdir(exist_ok=True)
    if (out / "coverage.json").exists():
        ap.error("本轮覆盖记录已存在；复采请先建立新的业务任务，不覆盖旧证据")
    (out / "seeds.json").write_text(json.dumps(sources, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    robots = out / "robots"
    robots.mkdir(exist_ok=True)
    def check(source):
        record = invoke(["robots", source["url"]], robots / (source["id"] + ".json"))
        allowed = record["exit_code"] == 0 and record["result"].get("outcome") in {"allowed", "unavailable"}
        print(json.dumps({"source": source["id"], "robots": record["result"].get("outcome"), "candidate": allowed}), flush=True)
        return source, record, allowed
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        checks = list(pool.map(check, sources))
    jobs = [{"id": source["id"], "url": source["url"]} for source, _, allowed in checks if allowed]
    batch_file = out / "jobs.json"
    batch_file.write_text(json.dumps(jobs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    actual = invoke(["batch", "--file", str(batch_file), "--out", str(task),
                     "--concurrency", str(args.concurrency), "--scrolls", "6"], out / "browser-run.json", timeout=7200) if jobs else {"result": {}}
    by_id = {r.get("id"): r for r in actual["result"].get("results", [])}
    coverage = [{**source, "robots": record["result"], "browser": by_id.get(source["id"],
                {"status": "blocked", "stop_reason": "robots_not_allowed" if not allowed else "no_result"}),
                "admission": "not-reviewed"} for source, record, allowed in checks]
    (out / "coverage.json").write_text(json.dumps({"schema": 1, "task": str(task), "sources": coverage}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"file": str(out / "coverage.json"), "attempted": len(jobs), "candidates": len(sources),
                      "status": "collected-needs-body-and-license-review"}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
