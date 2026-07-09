from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "p6_precision_trace_loop.py"
spec = importlib.util.spec_from_file_location("p6_precision_trace_loop", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def _summary(*, precision: float, recall: float = 0.86, hit_rate: float = 0.86, p95: float = 4.0, ok: bool = True) -> dict:
    return {
        "ok": ok,
        "questions": 45,
        "failures": 0 if ok else 1,
        "warning_count": 0,
        "cross_encoder_ok": True,
        "context_precision": precision,
        "context_recall": recall,
        "hit_rate": hit_rate,
        "p95_latency_s": p95,
        "fake_embeddings": False,
        "evaluation_config": {"top_k": 2, "rerank": True, "rerank_prune": 4, "raw_weight": 0.2},
    }


def test_build_matrix_uses_stable_slug_and_cartesian_product() -> None:
    matrix = mod.build_matrix(raw_weights=[0.0, 0.2], rerank_prunes=[4], top_ks=[2, 3])

    assert [item.slug for item in matrix] == [
        "rw000-prune4-top2",
        "rw000-prune4-top3",
        "rw020-prune4-top2",
        "rw020-prune4-top3",
    ]
    assert matrix[2].raw_weight == 0.2
    assert matrix[2].rerank_prune == 4
    assert matrix[2].top_k == 2


def test_run_matrix_forces_pg_real_embeddings_and_captures_each_repeat(tmp_path: Path) -> None:
    calls: list[dict] = []

    def fake_runner(cmd, *, cwd, text, stdout, stderr, timeout, check, env):
        calls.append({"cmd": list(cmd), "env": dict(env), "cwd": cwd, "timeout": timeout, "check": check})
        output_path = Path(cmd[cmd.index("--output") + 1])
        payload = {"summary": _summary(precision=0.46), "rows": []}
        output_path.write_text(json.dumps(payload), encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload["summary"]), stderr="")

    matrix = [mod.EvalConfig(raw_weight=0.2, rerank_prune=4, top_k=2)]
    result = mod.run_matrix(
        matrix,
        repeat=2,
        output_dir=tmp_path,
        topic="changwon-org-mgmt-diagnosis",
        timeout_s=12,
        runner=fake_runner,
    )

    assert len(result["runs"]) == 2
    assert result["aggregates"][0]["runs"] == 2
    assert result["aggregates"][0]["successful_runs"] == 2
    assert result["aggregates"][0]["mean_context_precision"] == 0.46
    assert len(calls) == 2
    first = calls[0]
    assert first["check"] is False
    assert first["env"]["CONSULTING_BRAIN_BACKEND"] == "pg"
    assert first["env"]["CONSULTING_BRAIN_WRITE_BACKEND"] == "pg"
    assert first["env"]["CONSULTING_BRAIN_STATE_BACKEND"] == "pg"
    assert first["env"]["CONSULTING_PG_DSN_DRIVER"] == "psycopg"
    assert first["env"]["CONSULTING_RERANKER_KEEP_LOADED"] == "1"
    assert "CONSULTING_EMBED_FAKE" not in first["env"]
    assert "--no-fake-embeddings" in first["cmd"]
    assert "--rerank" in first["cmd"]
    assert first["cmd"][first["cmd"].index("--raw-weight") + 1] == "0.20"


def test_pg_real_embedding_env_scrubs_fake_fixture_and_recording_controls() -> None:
    env = mod.pg_real_embedding_env(
        {
            "CONSULTING_EMBED_FAKE": "1",
            "CONSULTING_EMBED_FIXTURE": "/tmp/fixture.json",
            "CONSULTING_EMBED_FIXTURE_STRICT": "1",
            "CONSULTING_EMBED_RECORD": "/tmp/record.json",
            "KEEP_ME": "yes",
        }
    )

    assert "CONSULTING_EMBED_FAKE" not in env
    assert "CONSULTING_EMBED_FIXTURE" not in env
    assert "CONSULTING_EMBED_FIXTURE_STRICT" not in env
    assert "CONSULTING_EMBED_RECORD" not in env
    assert env["KEEP_ME"] == "yes"
    assert env["CONSULTING_BRAIN_BACKEND"] == "pg"


def test_decision_blocks_when_precision_or_trace_gate_is_missing() -> None:
    aggregate = mod.aggregate_runs(
        [
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.30)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.31)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.32)},
        ]
    )[0]

    decision = mod.decide_p6_entry(
        [aggregate],
        baseline_precision=0.2881,
        required_repeats=3,
        trace_probe={"checked": False, "trace_rows": 0, "leakage_count": 0},
    )

    assert decision["allowed"] is False
    reasons = "\n".join(decision["blockers"])
    assert "precision" in reasons
    assert "trace" in reasons


def test_decision_blocks_when_trace_ledger_rows_are_missing_even_if_metrics_pass() -> None:
    aggregate = mod.aggregate_runs(
        [
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.46)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.47)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.45)},
        ]
    )[0]

    decision = mod.decide_p6_entry(
        [aggregate],
        baseline_precision=0.2881,
        required_repeats=3,
        trace_probe={"checked": True, "trace_rows": 1, "retrieval_rows": 0, "eval_rows": 0, "leakage_count": 0},
    )

    assert decision["allowed"] is False
    reasons = "\n".join(decision["blockers"])
    assert "retrieval_rows" in reasons
    assert "eval_rows" in reasons


def test_decision_allows_repeatable_precision_gain_when_trace_is_clean() -> None:
    aggregate = mod.aggregate_runs(
        [
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.46)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.47)},
            {"config_slug": "rw020-prune4-top2", "returncode": 0, "summary": _summary(precision=0.45)},
        ]
    )[0]

    decision = mod.decide_p6_entry(
        [aggregate],
        baseline_precision=0.2881,
        required_repeats=3,
        trace_probe={"checked": True, "trace_rows": 4, "retrieval_rows": 2, "eval_rows": 1, "leakage_count": 0},
    )

    assert decision["allowed"] is True
    assert decision["selected_config"] == "rw020-prune4-top2"
    assert decision["selected_metrics"]["mean_context_precision"] == 0.46
    assert decision["blockers"] == []


def test_write_outputs_persists_matrix_and_decision_markdown(tmp_path: Path) -> None:
    matrix_result = {
        "generated_at": "2026-07-09T00:00:00+09:00",
        "matrix": [{"slug": "rw020-prune4-top2"}],
        "runs": [],
        "aggregates": [{"config_slug": "rw020-prune4-top2", "runs": 3, "successful_runs": 3, "mean_context_precision": 0.46}],
    }
    decision = {"allowed": True, "selected_config": "rw020-prune4-top2", "selected_metrics": {"mean_context_precision": 0.46}, "blockers": []}

    mod.write_outputs(tmp_path, matrix_result, decision)

    assert (tmp_path / "matrix.json").exists()
    assert (tmp_path / "matrix.md").read_text(encoding="utf-8").startswith("# P6 Precision/Trace Matrix")
    assert json.loads((tmp_path / "p6_entry_decision.json").read_text(encoding="utf-8"))["allowed"] is True
    assert "P6 Entry Decision" in (tmp_path / "p6_entry_decision.md").read_text(encoding="utf-8")
