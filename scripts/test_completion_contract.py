"""A completed preflight always has a verified conclusion page (offline fixtures only)."""
import json
from pathlib import Path

import pytest

import crawl_preflight as cp
from test_crawl_preflight import complete_fixture, fixture
from test_evidence_policy import payload_for


@pytest.mark.parametrize("fields", [("report_sha256",), ("report", "report_sha256")])
def test_complete_record_cannot_drop_its_report_contract(tmp_path, fields):
    path = complete_fixture(tmp_path, "luz-design")
    value = cp.read(path)
    for field in fields:
        value.pop(field, None)
    path.write_text(json.dumps(value), encoding="utf-8")
    path.with_suffix(".html").unlink()
    errors = cp.validate_preflight(tmp_path, "luz-design")
    assert any("HTML" in error for error in errors), errors


@pytest.mark.parametrize("previously_complete", [False, True])
def test_conclude_render_failure_never_leaves_complete(tmp_path, monkeypatch, previously_complete):
    if previously_complete:
        path = complete_fixture(tmp_path, "luz-design")
    else:
        path, _, _ = fixture(tmp_path)

    def fail_render(*args):
        raise OSError("simulated conclusion renderer failure")

    monkeypatch.setattr(cp, "render_report", fail_render)
    with pytest.raises(OSError, match="renderer failure"):
        cp.conclude(tmp_path, "luz-design", payload_for(cp.read(path)))
    assert cp.read(path)["status"] != "complete"
    assert cp.validate_preflight(tmp_path, "luz-design")
