from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "p6_splade_candidate_probe.py"
spec = importlib.util.spec_from_file_location("p6_splade_candidate_probe", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_sparse_terms_preserve_korean_codes_and_numeric_tokens() -> None:
    scores = mod.sparse_term_scores("CL-D5-01 2026년 창원시 조직진단 KPI 3단계 리스크")

    assert scores["CL-D5-01"] == 1.0
    assert "D5" in scores
    assert "01" in scores
    assert "2026" in scores
    assert "창원시" in scores
    assert "조직진단" in scores
    assert "KPI" in scores
    assert all(0.0 <= value <= 1.0 for value in scores.values())


def test_sparse_scores_are_normalized_before_rrf_merge() -> None:
    normalized = mod.normalize_sparse_scores({"창원": 5.0, "조직": 2.5, "리스크": 0.0})

    assert normalized == {"창원": 1.0, "조직": 0.5, "리스크": 0.0}

    merged = mod.rrf_merge_rankings(
        ["A", "B", "C"],
        {"B": 1.0, "A": 0.5, "D": 0.25},
        limit=4,
    )

    assert [row["id"] for row in merged] == ["B", "A", "C", "D"]
    assert all(0.0 <= row["rrf_score"] <= 1.0 for row in merged)


def test_dependency_missing_returns_structured_skip_without_product_mutation() -> None:
    status = mod.optional_real_splade_status(require_real=True, import_name="definitely_missing_splade_module")

    assert status["ok"] is False
    assert status["mode"] == "skipped"
    assert status["reason"] == "optional_dependency_missing"
    assert status["product_path_mutated"] is False


def test_build_splade_lite_query_is_non_oracle_and_deduplicated() -> None:
    expanded = mod.build_splade_lite_query("조직진단 리스크 근거", max_terms=8)

    assert "CL-SECRET-99" not in expanded
    assert expanded.count("조직진단") == 1
    assert expanded.startswith("조직진단 리스크 근거")
    assert len(expanded.split()) <= 11  # original terms + bounded sparse expansion


def test_compare_summaries_holds_when_splade_lite_does_not_clear_delta_gate() -> None:
    baseline = {"context_precision": 0.831, "context_recall": 0.9111, "hit_rate": 0.9111, "p95_latency_s": 4.0, "warning_count": 0, "cross_encoder_ok": True}
    candidate = {"context_precision": 0.84, "context_recall": 0.90, "hit_rate": 0.90, "p95_latency_s": 5.0, "warning_count": 0, "cross_encoder_ok": True}

    decision = mod.compare_against_baseline(baseline, candidate)

    assert decision["decision"] == "hold"
    assert "precision_delta_low" in decision["blockers"]
    assert decision["product_path_mutated"] is False
