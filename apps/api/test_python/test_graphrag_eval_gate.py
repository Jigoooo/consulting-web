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
