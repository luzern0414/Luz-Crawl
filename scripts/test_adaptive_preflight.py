"""Exercise adaptive routing through run, conclude and the read-only downstream gate."""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import crawl_preflight as crawl
from test_crawl_preflight import FAKE_CLI, write_review_fixture
from test_evidence_policy import payload_for


@pytest.mark.parametrize("topic", ["修复搜索框的拼写", "搜索算法的复杂度", "整理用户给定资料", "不要联网，修改索引", "Rename the search button"])
def test_local_work_never_starts_a_browser(tmp_path, topic):
    with patch.object(crawl.subprocess, "run", side_effect=AssertionError("unexpected subprocess")):
        result = crawl.run(tmp_path, "luz-dev", topic, stage="implementation")
        assert result["status"] == "not-required"
        assert crawl.validate_preflight(tmp_path, "luz-dev", "implementation") == []
        assert crawl.status(tmp_path, "luz-dev", "implementation")["next"] == []
    path = Path(result["record"])
    assert not path.with_suffix(".html").exists()
    assert not list(tmp_path.rglob("luz-task.json"))
    checked = subprocess.run([sys.executable, "-X", "utf8", crawl.__file__, "check", "--session", str(tmp_path),
                              "--caller", "luz-dev", "--stage", "implementation"], check=True, capture_output=True)
    assert json.loads(checked.stdout) == {"ok": True, "status": "not-required", "errors": []}
    other = crawl.record_path(tmp_path / "other", "luz-dev", "implementation")
    crawl.write(other, crawl.read(path))
    assert crawl.validate_preflight(tmp_path / "other", "luz-dev", "implementation")
    value = crawl.read(path)
    value["report"] = "invented.html"
    crawl.write(path, value)
    assert crawl.validate_preflight(tmp_path, "luz-dev", "implementation")


@pytest.mark.parametrize(("topic", "mode"), [
    ("请帮我联网查一下官方说明", "search"), ("please look up the release notes", "search"),
    ("请深入调研电机能耗", "deep"), ("修改搜索算法", "local"), ("搜索结果的排序为什么会变", "local"),
    ("请找三篇原文", "search"), ("Research gate configuration", "local"), ("别搜索", "local"),
])
def test_topic_routing(topic, mode):
    assert crawl.research_mode(topic, "auto", [], [], None) == mode


@pytest.mark.parametrize(("topic", "quantity"), [
    ("请找十五篇文章", 15), ("搜索五篇原文", 5), ("至少一百零二个来源", 102), ("search for 2 articles", 2),
    ("查找资料", None),
])
def test_count_from_direct_request(topic, quantity):
    assert crawl.requested_source_count(topic) == quantity


def test_contradictory_intent_and_invalid_quotas_never_start_network(tmp_path):
    with patch.object(crawl.subprocess, "run", side_effect=AssertionError("unexpected subprocess")):
        for topic, options in [("请搜索资料", {"research": "local"}), ("无需联网", {"queries": ["docs"]}),
                               ("请深入调研电机能耗", {"research": "search"}),
                               ("主题", {"research": "local", "min_sources": 2}), ("请搜索0篇资料", {})]:
            with pytest.raises(ValueError):
                crawl.run(tmp_path, "luz-crawl", topic, **options)


def test_search_floor_append_and_body_bound_chat_conclusion(tmp_path, monkeypatch):
    cli = tmp_path / "fake.mjs"
    cli.write_text(FAKE_CLI, encoding="utf-8")
    monkeypatch.setattr(crawl, "CLI", cli)
    monkeypatch.setattr(crawl, "DEFAULT_OUTPUT", str(tmp_path / "output"))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.json"))
    session = tmp_path / "session"
    topic = "请搜索4篇原文"
    result = crawl.run(session, "luz-crawl", topic)
    assert result["status"] == "needs-research" and result["floor"]["sources"] == 4
    assert crawl.validate_preflight(session, "luz-crawl")
    with pytest.raises(ValueError, match="沿用"):
        crawl.run(session, "luz-crawl", topic, append=True, min_sources=1)
    result = crawl.run(session, "luz-crawl", topic, urls=[f"https://example.org/{i}" for i in range(3)], append=True)
    assert result["status"] == "needs-conclusion" and result["floor"]["sources"] == 4
    path = Path(result["record"])
    value = crawl.read(path)
    payload = payload_for(value)
    payload["template_uses"] = []
    for row in payload["coverage"]:
        row["applies_to"] = "对话答复"
    write_review_fixture(path, value, payload)
    crawl.conclude(session, "luz-crawl", payload)
    assert crawl.validate_preflight(session, "luz-crawl") == []
    complete = crawl.read(path)
    search = next(step for step in complete["steps"] if step["command"] == "search")
    log = crawl.read(search["file"])
    log["search_performed"] = False
    crawl.write(search["file"], log)
    search["sha256"] = crawl.digest(search["file"])
    crawl.write(path, complete)
    assert any("执行状态" in error for error in crawl.validate_preflight(session, "luz-crawl"))


def test_reading_one_url_requires_verified_body_but_no_search_groups(tmp_path, monkeypatch):
    cli = tmp_path / "fake.mjs"
    cli.write_text(FAKE_CLI, encoding="utf-8")
    monkeypatch.setattr(crawl, "CLI", cli)
    monkeypatch.setattr(crawl, "DEFAULT_OUTPUT", str(tmp_path / "output"))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.json"))
    result = crawl.run(tmp_path, "luz-crawl", "阅读原文",
                       urls=["https://example.org/guide", "https://example.org/guide?utm_source=other#intro"])
    assert result["research_mode"] == "urls" and result["status"] == "needs-conclusion"
    path = Path(result["record"])
    value = crawl.read(path)
    assert "search" not in [step["command"] for step in value["steps"]]
    assert [step["command"] for step in value["steps"]].count("capture") == 1
    assert result["floor"]["sources"] == 1
    payload = payload_for(value)
    write_review_fixture(path, value, payload)
    crawl.conclude(tmp_path, "luz-crawl", payload)
    assert crawl.validate_preflight(tmp_path, "luz-crawl") == []


def test_one_requested_article_limits_browser_reads_and_repeated_query(tmp_path, monkeypatch):
    cli = tmp_path / "fake.mjs"
    cli.write_text(FAKE_CLI, encoding="utf-8")
    monkeypatch.setattr(crawl, "CLI", cli)
    monkeypatch.setattr(crawl, "DEFAULT_OUTPUT", str(tmp_path / "output"))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.json"))
    result = crawl.run(tmp_path, "luz-crawl", "请搜索一篇原文", queries=["guide", "guide"])
    calls = [step["args"] for step in crawl.read(result["record"])["steps"] if step["command"] == "search"]
    assert len(calls) == 1 and calls[0][calls[0].index("--read") + 1] == "1"

def test_commercial_scope_needs_search_only_in_its_project_context(tmp_path):
    root = tmp_path / "session" / "raw"
    root.mkdir(parents=True)
    manifest = root / "project.json"
    manifest.write_text(json.dumps({"workflow": "commercial-v1"}), encoding="utf-8")
    assert crawl.state_root(root.parent) == root
    for options in ({"research": "local"}, {"research": "urls", "urls": ["https://example.org"]}):
        with pytest.raises(ValueError, match="真实搜索"):
            crawl.run(root, "luz-system", "仓储业务", stage="scope", **options)
    path = crawl.record_path(root, "luz-system", "scope")
    crawl.write(path, crawl.local_record(path, "luz-system", "scope", "仓储业务", "既有业务说明"))
    assert any("真实搜索" in error for error in crawl.validate_preflight(root, "luz-system", "scope"))
    project = {"workflow": "commercial-v1", "stages": [{"id": "scope", "owner": "luz-system",
                                                       "contributors": ["luz-writing"]}]}
    manifest.write_text(json.dumps(project), encoding="utf-8")
    crawl.run(root, "luz-writing", "初稿核对", stage="scope")
    assert crawl.stage_evidence_caller(root, "luz-writing", "scope") == "luz-system"
    assert crawl.run(root, "luz-system", "合同复核", stage="design")["research_mode"] == "local"
    manifest.write_text("{}", encoding="utf-8")
    assert crawl.validate_preflight(root, "luz-system", "scope") == []
