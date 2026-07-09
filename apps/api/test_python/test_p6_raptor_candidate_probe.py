from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "p6_raptor_candidate_probe.py"
spec = importlib.util.spec_from_file_location("p6_raptor_candidate_probe", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def _claims() -> list[dict]:
    return [
        {"claim_code": "CL-D5-01", "claim_text": "재정 제약 정원 인건비 재정소요 영향과 함께 제시되어야 한다."},
        {"claim_code": "CL-RP03", "claim_text": "공무직 승진체계 요구는 재정 총인건비 부담이 크다."},
        {"claim_code": "CL-RP06", "claim_text": "수당 신설 요구는 연쇄 요구 형평성 총인건비 부담을 유발한다."},
        {"claim_code": "CL-RP02", "claim_text": "공영주차장 이관은 현장운영 민원 정산 안전점검이 동반된다."},
        {"claim_code": "CL-RP09", "claim_text": "파크골프장 이관은 레포츠파크 희망사항이나 시설공단 운영이 적정하다."},
        {"claim_code": "CL-RP14", "claim_text": "신임시장 인수위 변수로 선택지 시나리오형 보고가 적합하다."},
    ]


def test_hierarchical_summaries_are_lineaged_without_claim_code_leakage() -> None:
    summaries = mod.build_hierarchical_summary_rows(_claims())

    assert summaries
    assert all(row["source"] == "raptor_lite" for row in summaries)
    assert all(row["source_claim_ids"] for row in summaries)
    assert all(row["summary_text"] for row in summaries)
    assert all("CL-" not in row["summary_text"] for row in summaries)
    assert {code for row in summaries for code in row["source_claim_ids"]} == {c["claim_code"] for c in _claims()}
    assert all(row["product_path_mutated"] is False for row in summaries)


def test_global_questions_are_multi_claim_and_non_oracle() -> None:
    questions = mod.build_global_questions(mod.build_hierarchical_summary_rows(_claims()))

    assert questions
    assert all(q["question_type"] == "global_summary" for q in questions)
    assert all(len(q["expected_claims"]) >= 1 for q in questions)
    assert all("CL-" not in q["query"] for q in questions)
    assert any(len(q["expected_claims"]) >= 2 for q in questions)


def test_raptor_lite_query_expands_only_summary_queries_and_is_bounded() -> None:
    summaries = mod.build_hierarchical_summary_rows(_claims())

    exact = mod.build_raptor_lite_query("CL-D5-01 관련 근거", summaries=summaries, max_terms=8)
    expanded = mod.build_raptor_lite_query("전체 재정 정원 인건비 흐름을 종합해줘", summaries=summaries, max_terms=8)

    assert exact == "CL-D5-01 관련 근거"
    assert expanded.startswith("전체 재정 정원 인건비 흐름을 종합해줘")
    assert "CL-" not in expanded
    assert len(expanded.split()) <= len("전체 재정 정원 인건비 흐름을 종합해줘".split()) + 8
    assert any(term in expanded for term in ["총인건비", "공무직", "수당"])


def test_global_metrics_use_expected_claim_sets_not_single_expected_claim() -> None:
    rows = [
        {"expected_claims": ["A", "B", "C"], "retrieved_claims": ["A", "X"], "ok": True, "warnings": [], "rerank": "cross-encoder", "latency_s": 1.0},
        {"expected_claims": ["D"], "retrieved_claims": ["D"], "ok": True, "warnings": [], "rerank": "cross-encoder", "latency_s": 2.0},
    ]

    summary = mod.compute_global_summary(rows, topic="t", candidate_source="baseline", fake_embeddings=False)

    assert summary["questions"] == 2
    assert summary["hit_rate"] == 1.0
    assert summary["global_coverage"] == 0.6667
    assert summary["global_precision"] == 0.75
    assert summary["cross_encoder_ok"] is True


def test_compare_holds_when_raptor_lite_does_not_clear_global_coverage_gate() -> None:
    baseline = {"global_coverage": 0.60, "global_precision": 0.80, "hit_rate": 0.90, "p95_latency_s": 4.0, "warning_count": 0, "cross_encoder_ok": True, "fake_embeddings": False}
    candidate = {"global_coverage": 0.62, "global_precision": 0.80, "hit_rate": 0.90, "p95_latency_s": 4.2, "warning_count": 0, "cross_encoder_ok": True, "fake_embeddings": False}

    decision = mod.compare_global_against_baseline(baseline, candidate)

    assert decision["decision"] == "hold"
    assert "coverage_delta_low" in decision["blockers"]
    assert decision["product_path_mutated"] is False
