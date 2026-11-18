"""The seven shared summary CLIs are business writers; their render API stays pure."""
import importlib.util
import json
from pathlib import Path

import pytest

from test_crawl_preflight import complete_fixture

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ("Luz-Project", "Luz-System", "Luz-Design", "Luz-Dev", "Luz-Ops", "Luz-Writing", "Luz-Crawl")
STAGES = {"Luz-Project": "implementation", "Luz-System": "architecture", "Luz-Design": "design", "Luz-Dev": "technical-plan",
          "Luz-Ops": "release", "Luz-Writing": "requirements", "Luz-Crawl": "research"}


def module_for(skill):
    spec = importlib.util.spec_from_file_location("summary_" + skill.replace("-", "_"), ROOT / skill / "scripts" / "make_summary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source(tmp_path):
    path = tmp_path / "spec.json"
    path.write_text(json.dumps({"title": "检索后的汇总", "sections": [{"title": "结论", "text": "SOURCE_BACKED_RESULT"}]}), encoding="utf-8")
    return path


def design_manifest(session, project=None):
    raw = session / "raw"
    (raw / "99-delivery").mkdir(parents=True, exist_ok=True)
    (raw / "00-rules").mkdir(exist_ok=True)
    (raw / "BRIEF.md").write_text("# Offline test session", encoding="utf-8")
    (raw / "00-rules" / "reading-html.md").write_text("Offline rule-card fixture", encoding="utf-8")
    data = {"schema_version": "3.0", "session_id": "SES-001", "folder": session.name, "title": "Offline summary", "created_at": "2026-11-06T00:00:00Z",
            "modes": ["document"], "session_kind": "general", "project": project}
    (raw / "99-delivery" / "MANIFEST.json").write_text(json.dumps(data), encoding="utf-8")


@pytest.mark.parametrize("skill", SKILLS)
@pytest.mark.parametrize("flags", [[], ["--check", "--project-linked"]])
def test_no_summary_cli_writes_without_research(tmp_path, capsys, skill, flags):
    session = tmp_path / "001-unresearched"
    code = module_for(skill).main([str(source(tmp_path)), str(session), *flags])
    assert code != 0, skill
    assert not session.exists(), skill
    captured = capsys.readouterr()
    assert any(name in captured.out + captured.err for name in ("Crawl", "Design 会话")), skill


@pytest.mark.parametrize("skill", SKILLS)
def test_summary_cli_accepts_its_own_verified_standalone_evidence(tmp_path, skill):
    session = tmp_path / "001-researched"
    if skill == "Luz-Design":
        design_manifest(session)
    complete_fixture(session, skill.lower(), "summary")
    library = module_for(skill)._load_gate(ROOT / "Luz-Design/scripts/template_library.py")
    library.select(session, skill.lower(), "summary", "reading-html", f"{session.name}.html")
    assert module_for(skill).main([str(source(tmp_path)), str(session)]) == 0
    assert "SOURCE_BACKED_RESULT" in (session / f"{session.name}.html").read_text(encoding="utf-8")


@pytest.mark.parametrize("skill", SKILLS)
def test_project_summary_requires_the_declared_stage_in_project_storage(tmp_path, skill):
    session = tmp_path / "001-project-summary"
    raw = session / "raw"
    raw.mkdir(parents=True)
    state = raw if skill == "Luz-Project" else tmp_path / "state"
    state.mkdir(exist_ok=True)
    stage = STAGES[skill]
    owner = "luz-dev" if skill == "Luz-Project" else skill.lower()
    (state / "project.json").write_text(json.dumps({"name": "offline project", "deliver_root": str(tmp_path / "deliver"), "current_stage": stage,
                                                   "stages": [{"id": stage, "owner": owner}], "crawl": {"evidence_index": "00-crawl"}}), encoding="utf-8")
    link = {"state_root": str(state), "deliver_root": str(tmp_path / "deliver"), "stage": stage}
    if skill == "Luz-Design":
        design_manifest(session, link)
    elif skill == "Luz-Dev":
        (raw / "plan.json").write_text(json.dumps({"project": {"stateRoot": str(state)}}), encoding="utf-8")
    elif skill == "Luz-System":
        (raw / "99-delivery").mkdir()
        (raw / "99-delivery" / "MANIFEST.json").write_text(json.dumps({"project": link, "modes": ["hardware"]}), encoding="utf-8")
    elif skill != "Luz-Project":
        (raw / "manifest.json").write_text(json.dumps({"project": link}), encoding="utf-8")
    complete_fixture(session, skill.lower())
    complete_fixture(state, owner, "wrong-stage")
    module = module_for(skill)
    args = [str(source(tmp_path)), str(session)]
    before = {p: p.read_bytes() for p in session.rglob("*") if p.is_file()}
    assert module.main(args) != 0, skill
    assert {p: p.read_bytes() for p in session.rglob("*") if p.is_file()} == before
    complete_fixture(state, owner, stage)
    library = module._load_gate(ROOT / "Luz-Design/scripts/template_library.py")
    library.select(session, skill.lower(), stage, "reading-html", f"{session.name}.html")
    assert module.main(args) == 0, skill


@pytest.mark.parametrize("skill", SKILLS)
def test_shared_render_stays_available_to_upstream_checked_callers(tmp_path, monkeypatch, skill):
    module = module_for(skill)
    monkeypatch.setattr(module, "require_summary_preflight", lambda *a, **k: (_ for _ in ()).throw(AssertionError("renderer entered a business gate")), raising=False)
    assert "already checked upstream" in module.render({"title": "already checked upstream", "sections": []})
    assert not list(tmp_path.iterdir())


def test_all_seven_summary_copies_match_the_design_master():
    master = (ROOT / "Luz-Design" / "scripts" / "make_summary.py").read_bytes()
    assert all((ROOT / skill / "scripts" / "make_summary.py").read_bytes() == master for skill in SKILLS)
