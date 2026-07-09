from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "graphrag_eval_gate.py"
spec = importlib.util.spec_from_file_location("graphrag_eval_gate", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_compute_ragas_lite_metrics_are_bounded_and_include_relation_targets() -> None:
    rows = [
        {
            "id": "q1",
            "hit": True,
            "ok": True,
            "expected": "CL-D5-01",
            "retrieved_claims": ["CL-D5-01", "CL-D4-01"],
            "warnings": [],
            "question_type": "structured_relation",
        },
        {
            "id": "q2",
            "hit": False,
            "ok": True,
            "expected": "CL-D6-01",
            "retrieved_claims": ["CL-D4-01"],
            "warnings": ["citation mismatch"],
            "question_type": "insufficient",
        },
    ]

    metrics = mod.compute_ragas_lite_metrics(rows)

    assert metrics["context_recall"] == 0.5
    assert metrics["context_precision"] == 0.25
    assert metrics["citation_correctness"] == 0.5
    assert metrics["structured_relation_questions"] == 1
    for key in ["context_recall", "context_precision", "citation_correctness"]:
        assert 0.0 <= metrics[key] <= 1.0


def test_markdown_report_contains_delta_and_metric_names(tmp_path: Path) -> None:
    summary = {
        "ok": True,
        "topic": "changwon-org-mgmt-diagnosis",
        "questions": 2,
        "hit_rate": 0.5,
        "context_precision": 0.25,
        "citation_correctness": 0.5,
        "p95_latency_s": 1.2,
        "rerank_modes": ["cross-encoder"],
    }
    out = tmp_path / "report.md"

    mod.write_markdown_report(summary, [], out, baseline={"hit_rate": 0.4, "context_precision": 0.2, "citation_correctness": 0.5})

    text = out.read_text(encoding="utf-8")
    assert "RAGAS/STaRK-lite" in text
    assert "context_precision" in text
    assert "citation_correctness" in text
    assert "Δ hit_rate" in text


def test_run_recall_reuses_in_process_backend_by_default(monkeypatch, tmp_path: Path) -> None:
    calls: list[dict] = []

    class FakeBackend:
        @staticmethod
        def recall(topic: str, query: str, *, top_k: int, rerank: bool, backend: str | None = None) -> dict:
            calls.append({"topic": topic, "query": query, "top_k": top_k, "rerank": rerank, "backend": backend})
            return {"ok": True, "hits": [], "rerank": "cross-encoder", "signals": {}}

    def fail_subprocess(*_args, **_kwargs):
        raise AssertionError("run_recall should not spawn per-question subprocesses in default mode")

    monkeypatch.delenv("CONSULTING_EVAL_RECALL_MODE", raising=False)
    monkeypatch.setenv("CONSULTING_BRAIN_BACKEND", "pg")
    monkeypatch.setattr(mod, "_load_backend", lambda _brain_root: FakeBackend)
    monkeypatch.setattr(mod.subprocess, "run", fail_subprocess)

    result, latency, error = mod.run_recall(tmp_path, "topic", "query", top_k=2, rerank=True, timeout=1)

    assert error is None
    assert latency >= 0
    assert result["ok"] is True
    assert calls == [{"topic": "topic", "query": "query", "top_k": 2, "rerank": True, "backend": "pg"}]


def test_ensure_eval_python_reexecs_to_venv_path_without_resolving_symlink(monkeypatch, tmp_path: Path) -> None:
    exec_calls: list[tuple[str, list[str]]] = []
    venv_python = tmp_path / ".venv" / "bin" / "python3"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")

    monkeypatch.setattr(mod.sys, "executable", "/usr/bin/python3")
    monkeypatch.setattr(mod.sys, "argv", ["scripts/graphrag_eval_gate.py", "--rerank"])
    monkeypatch.setattr(mod, "brain_python", lambda _root: str(venv_python))
    monkeypatch.delenv("CONSULTING_EVAL_REEXECED", raising=False)
    monkeypatch.setattr(mod.os, "execvpe", lambda path, argv, env: exec_calls.append((path, argv)))

    mod.ensure_eval_python(tmp_path)

    assert exec_calls == [(str(venv_python.absolute()), [str(venv_python.absolute()), "scripts/graphrag_eval_gate.py", "--rerank"])]
