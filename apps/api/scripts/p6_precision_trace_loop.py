#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Callable, NamedTuple

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
EVAL_SCRIPT = API_ROOT / 'scripts' / 'graphrag_eval_gate.py'
DEFAULT_TOPIC = 'changwon-org-mgmt-diagnosis'
DEFAULT_BASELINE_PRECISION = 0.2881

Runner = Callable[..., subprocess.CompletedProcess[str]]


class EvalConfig(NamedTuple):
    raw_weight: float
    rerank_prune: int
    top_k: int

    @property
    def slug(self) -> str:
        return f'rw{int(round(self.raw_weight * 100)):03d}-prune{self.rerank_prune}-top{self.top_k}'

    def to_dict(self) -> dict[str, Any]:
        return {
            'slug': self.slug,
            'raw_weight': round(float(self.raw_weight), 4),
            'rerank_prune': int(self.rerank_prune),
            'top_k': int(self.top_k),
        }


def build_matrix(*, raw_weights: list[float], rerank_prunes: list[int], top_ks: list[int]) -> list[EvalConfig]:
    return [
        EvalConfig(raw_weight=raw_weight, rerank_prune=rerank_prune, top_k=top_k)
        for raw_weight in raw_weights
        for rerank_prune in rerank_prunes
        for top_k in top_ks
    ]


def parse_float_list(value: str) -> list[float]:
    out = [float(part.strip()) for part in value.split(',') if part.strip()]
    if not out:
        raise argparse.ArgumentTypeError('expected at least one float')
    return out


def parse_int_list(value: str) -> list[int]:
    out = [int(part.strip()) for part in value.split(',') if part.strip()]
    if not out:
        raise argparse.ArgumentTypeError('expected at least one integer')
    return out


def pg_real_embedding_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base or os.environ)
    for key in (
        'CONSULTING_EMBED_FAKE',
        'CONSULTING_EMBED_FIXTURE',
        'CONSULTING_EMBED_FIXTURE_STRICT',
        'CONSULTING_EMBED_RECORD',
    ):
        env.pop(key, None)
    env['CONSULTING_BRAIN_BACKEND'] = 'pg'
    env['CONSULTING_BRAIN_WRITE_BACKEND'] = 'pg'
    env['CONSULTING_BRAIN_STATE_BACKEND'] = 'pg'
    env.setdefault('CONSULTING_PG_DSN_DRIVER', 'psycopg')
    env['CONSULTING_RERANKER_KEEP_LOADED'] = '1'
    return env


def eval_command(config: EvalConfig, *, topic: str, output_json: Path, report_md: Path, timeout_s: float) -> list[str]:
    return [
        sys.executable,
        str(EVAL_SCRIPT),
        '--topic', topic,
        '--rerank',
        '--no-fake-embeddings',
        '--top-k', str(config.top_k),
        '--rerank-prune', str(config.rerank_prune),
        '--raw-weight', f'{config.raw_weight:.2f}',
        '--timeout-s', str(timeout_s),
        '--output', str(output_json),
        '--report-output', str(report_md),
    ]


def _tail(text: str | None, limit: int = 1200) -> str:
    if not text:
        return ''
    return text[-limit:]


def _load_summary(output_json: Path, stdout: str) -> dict[str, Any] | None:
    if output_json.exists():
        payload = json.loads(output_json.read_text(encoding='utf-8'))
        if isinstance(payload, dict) and isinstance(payload.get('summary'), dict):
            return payload['summary']
    stripped = stdout.strip()
    if stripped:
        payload = json.loads(stripped)
        if isinstance(payload, dict) and isinstance(payload.get('summary'), dict):
            return payload['summary']
        if isinstance(payload, dict):
            return payload
    return None


def run_one_eval(
    config: EvalConfig,
    *,
    repeat_index: int,
    output_dir: Path,
    topic: str,
    timeout_s: float,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    output_json = output_dir / 'runs' / f'{config.slug}-run{repeat_index}.json'
    report_md = output_dir / 'runs' / f'{config.slug}-run{repeat_index}.md'
    output_json.parent.mkdir(parents=True, exist_ok=True)
    cmd = eval_command(config, topic=topic, output_json=output_json, report_md=report_md, timeout_s=timeout_s)
    try:
        proc = runner(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(int(timeout_s) * 90, 120),
            check=False,
            env=pg_real_embedding_env(),
        )
        summary = _load_summary(output_json, proc.stdout) or {}
        return {
            'config_slug': config.slug,
            'config': config.to_dict(),
            'repeat_index': repeat_index,
            'returncode': proc.returncode,
            'summary': summary,
            'output_json': str(output_json),
            'report_md': str(report_md),
            'stdout_tail': _tail(proc.stdout),
            'stderr_tail': _tail(proc.stderr),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            'config_slug': config.slug,
            'config': config.to_dict(),
            'repeat_index': repeat_index,
            'returncode': 124,
            'summary': {},
            'output_json': str(output_json),
            'report_md': str(report_md),
            'stdout_tail': _tail(exc.stdout if isinstance(exc.stdout, str) else ''),
            'stderr_tail': f'timeout: {exc}',
        }
    except Exception as exc:  # measurement must report failure, not hide it
        return {
            'config_slug': config.slug,
            'config': config.to_dict(),
            'repeat_index': repeat_index,
            'returncode': 1,
            'summary': {},
            'output_json': str(output_json),
            'report_md': str(report_md),
            'stdout_tail': '',
            'stderr_tail': f'{type(exc).__name__}: {exc}',
        }


def _as_float(summary: dict[str, Any], key: str, default: float = 0.0) -> float:
    value = summary.get(key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(summary: dict[str, Any], key: str, default: int = 0) -> int:
    value = summary.get(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _max_consecutive_successes(runs: list[dict[str, Any]]) -> int:
    best = 0
    cur = 0
    for run in sorted(runs, key=lambda item: int(item.get('repeat_index', 0))):
        summary = run.get('summary') or {}
        success = run.get('returncode') == 0 and bool(summary.get('ok')) and not bool(summary.get('fake_embeddings'))
        if success:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def aggregate_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for run in runs:
        grouped.setdefault(str(run.get('config_slug')), []).append(run)

    aggregates: list[dict[str, Any]] = []
    for slug, items in grouped.items():
        summaries = [item.get('summary') or {} for item in items]
        successful = [item for item in items if item.get('returncode') == 0 and bool((item.get('summary') or {}).get('ok')) and not bool((item.get('summary') or {}).get('fake_embeddings'))]
        precisions = [_as_float(summary, 'context_precision') for summary in summaries]
        recalls = [_as_float(summary, 'context_recall') for summary in summaries]
        hit_rates = [_as_float(summary, 'hit_rate') for summary in summaries]
        p95s = [_as_float(summary, 'p95_latency_s', 999.0) for summary in summaries]
        config = items[0].get('config') or {'slug': slug}
        aggregates.append({
            'config_slug': slug,
            'config': config,
            'runs': len(items),
            'successful_runs': len(successful),
            'max_consecutive_successes': _max_consecutive_successes(items),
            'returncode_failures': sum(1 for item in items if item.get('returncode') != 0),
            'summary_failures': sum(_as_int(summary, 'failures') for summary in summaries),
            'warning_count': sum(_as_int(summary, 'warning_count') for summary in summaries),
            'cross_encoder_failures': sum(1 for summary in summaries if not bool(summary.get('cross_encoder_ok'))),
            'fake_embedding_runs': sum(1 for summary in summaries if bool(summary.get('fake_embeddings'))),
            'min_questions': min((_as_int(summary, 'questions') for summary in summaries), default=0),
            'mean_context_precision': round(mean(precisions), 4) if precisions else 0.0,
            'mean_context_recall': round(mean(recalls), 4) if recalls else 0.0,
            'mean_hit_rate': round(mean(hit_rates), 4) if hit_rates else 0.0,
            'mean_p95_latency_s': round(mean(p95s), 4) if p95s else 999.0,
            'worst_p95_latency_s': round(max(p95s), 4) if p95s else 999.0,
        })
    return aggregates


def run_matrix(
    matrix: list[EvalConfig],
    *,
    repeat: int,
    output_dir: Path,
    topic: str,
    timeout_s: float,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    runs: list[dict[str, Any]] = []
    for config in matrix:
        for idx in range(1, repeat + 1):
            runs.append(run_one_eval(config, repeat_index=idx, output_dir=output_dir, topic=topic, timeout_s=timeout_s, runner=runner))
    return {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'topic': topic,
        'repeat': repeat,
        'matrix': [config.to_dict() for config in matrix],
        'runs': runs,
        'aggregates': aggregate_runs(runs),
    }


LEAK_PATTERNS = [
    re.compile(r'-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----'),
    re.compile(r'\b(?:sk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_\-]{20,}\b'),
    re.compile(r'(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*["\']?[A-Za-z0-9_\-./+=]{16,}'),
    re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
]


def leakage_count_from_samples(samples: list[Any]) -> int:
    count = 0
    for sample in samples:
        text = sample if isinstance(sample, str) else json.dumps(sample, ensure_ascii=False, sort_keys=True)
        if any(pattern.search(text) for pattern in LEAK_PATTERNS):
            count += 1
    return count


def load_trace_probe(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {'checked': False, 'trace_rows': 0, 'retrieval_rows': 0, 'eval_rows': 0, 'leakage_count': 0, 'note': 'trace readback not supplied; CLI eval is metric-only'}
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError(f'trace probe must be a JSON object: {path}')
    raw_samples = payload.get('samples')
    samples: list[Any] = raw_samples if isinstance(raw_samples, list) else []
    leakage = int(payload.get('leakage_count', leakage_count_from_samples(samples)) or 0)
    return {
        'checked': bool(payload.get('checked', True)),
        'trace_rows': int(payload.get('trace_rows', 0) or 0),
        'retrieval_rows': int(payload.get('retrieval_rows', 0) or 0),
        'eval_rows': int(payload.get('eval_rows', 0) or 0),
        'leakage_count': leakage,
        **({'note': payload.get('note')} if payload.get('note') else {}),
    }


def _trace_blockers(trace_probe: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not trace_probe.get('checked'):
        blockers.append('trace_missing: trace readback was not checked')
    if int(trace_probe.get('trace_rows') or 0) <= 0:
        blockers.append('trace_missing: trace_spans rows are 0')
    if int(trace_probe.get('retrieval_rows') or 0) <= 0:
        blockers.append('trace_missing: retrieval_rows are 0')
    if int(trace_probe.get('eval_rows') or 0) <= 0:
        blockers.append('trace_missing: eval_rows are 0')
    if int(trace_probe.get('leakage_count') or 0) > 0:
        blockers.append(f'trace_leakage: leakage_count={trace_probe.get("leakage_count")}')
    return blockers


def config_blockers(
    aggregate: dict[str, Any],
    *,
    baseline_precision: float,
    required_repeats: int,
    trace_probe: dict[str, Any],
    min_questions: int = 40,
    min_precision: float = 0.45,
    min_precision_delta: float = 0.15,
    min_recall: float = 0.80,
    min_hit_rate: float = 0.80,
    max_p95_latency_s: float = 8.0,
) -> list[str]:
    blockers: list[str] = []
    if aggregate.get('runs', 0) < required_repeats or aggregate.get('max_consecutive_successes', 0) < required_repeats:
        blockers.append(f'runtime_failure: needs {required_repeats} consecutive successful real runs, got {aggregate.get("max_consecutive_successes", 0)}')
    if aggregate.get('returncode_failures', 0) > 0 or aggregate.get('summary_failures', 0) > 0:
        blockers.append(f'runtime_failure: returncode_failures={aggregate.get("returncode_failures", 0)}, summary_failures={aggregate.get("summary_failures", 0)}')
    if aggregate.get('fake_embedding_runs', 0) > 0:
        blockers.append('embedding_mode: fake embeddings are not valid for P6 entry')
    if aggregate.get('min_questions', 0) < min_questions:
        blockers.append(f'eval_set_too_small: questions={aggregate.get("min_questions", 0)} < {min_questions}')
    if aggregate.get('warning_count', 0) > 0:
        blockers.append(f'signal_breakdown_warning: warning_count={aggregate.get("warning_count", 0)}')
    if aggregate.get('cross_encoder_failures', 0) > 0:
        blockers.append(f'reranker_fallback: cross_encoder_failures={aggregate.get("cross_encoder_failures", 0)}')
    if float(aggregate.get('mean_context_recall', 0.0)) < min_recall:
        blockers.append(f'recall_low: mean_context_recall={aggregate.get("mean_context_recall")} < {min_recall}')
    if float(aggregate.get('mean_hit_rate', 0.0)) < min_hit_rate:
        blockers.append(f'hit_rate_low: mean_hit_rate={aggregate.get("mean_hit_rate")} < {min_hit_rate}')
    precision = float(aggregate.get('mean_context_precision', 0.0))
    precision_delta = precision - baseline_precision
    if precision < min_precision and precision_delta < min_precision_delta:
        blockers.append(f'precision_low: mean_context_precision={precision:.4f}, delta={precision_delta:+.4f}; need >= {min_precision} or +{min_precision_delta}')
    if float(aggregate.get('worst_p95_latency_s', 999.0)) > max_p95_latency_s:
        blockers.append(f'latency_high: worst_p95_latency_s={aggregate.get("worst_p95_latency_s")} > {max_p95_latency_s}')
    blockers.extend(_trace_blockers(trace_probe))
    return blockers


def decide_p6_entry(
    aggregates: list[dict[str, Any]],
    *,
    baseline_precision: float,
    required_repeats: int,
    trace_probe: dict[str, Any],
    min_questions: int = 40,
    min_precision: float = 0.45,
    min_precision_delta: float = 0.15,
    min_recall: float = 0.80,
    min_hit_rate: float = 0.80,
    max_p95_latency_s: float = 8.0,
) -> dict[str, Any]:
    evaluated = []
    for aggregate in aggregates:
        blockers = config_blockers(
            aggregate,
            baseline_precision=baseline_precision,
            required_repeats=required_repeats,
            trace_probe=trace_probe,
            min_questions=min_questions,
            min_precision=min_precision,
            min_precision_delta=min_precision_delta,
            min_recall=min_recall,
            min_hit_rate=min_hit_rate,
            max_p95_latency_s=max_p95_latency_s,
        )
        evaluated.append({'aggregate': aggregate, 'blockers': blockers})

    passing = [item for item in evaluated if not item['blockers']]
    sort_key = lambda item: (float(item['aggregate'].get('mean_context_precision', 0.0)), -float(item['aggregate'].get('worst_p95_latency_s', 999.0)))
    if passing:
        selected = sorted(passing, key=sort_key, reverse=True)[0]['aggregate']
        return {
            'allowed': True,
            'selected_config': selected.get('config_slug'),
            'selected_metrics': selected,
            'blockers': [],
            'trace_probe': trace_probe,
            'baseline_precision': baseline_precision,
        }

    best = sorted(evaluated, key=sort_key, reverse=True)[0] if evaluated else {'aggregate': None, 'blockers': ['no_measurements: matrix produced no aggregates']}
    blockers: list[str] = []
    for blocker in best['blockers']:
        if blocker not in blockers:
            blockers.append(blocker)
    return {
        'allowed': False,
        'selected_config': None,
        'best_config': (best['aggregate'] or {}).get('config_slug') if isinstance(best.get('aggregate'), dict) else None,
        'best_metrics': best.get('aggregate'),
        'blockers': blockers,
        'trace_probe': trace_probe,
        'baseline_precision': baseline_precision,
    }


def _json_dump(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def matrix_markdown(matrix_result: dict[str, Any]) -> str:
    lines = [
        '# P6 Precision/Trace Matrix',
        '',
        f'- generated_at: {matrix_result.get("generated_at")}',
        f'- topic: {matrix_result.get("topic")}',
        f'- repeat: {matrix_result.get("repeat")}',
        '',
        '| config | runs | success | precision | recall | hit | worst p95 | warnings |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for row in matrix_result.get('aggregates') or []:
        lines.append(
            f"| {row.get('config_slug')} | {row.get('runs')} | {row.get('successful_runs')} | "
            f"{row.get('mean_context_precision')} | {row.get('mean_context_recall')} | {row.get('mean_hit_rate')} | "
            f"{row.get('worst_p95_latency_s')} | {row.get('warning_count')} |"
        )
    if not matrix_result.get('aggregates'):
        lines.append('| none | 0 | 0 | - | - | - | - | - |')
    return '\n'.join(lines) + '\n'


def decision_markdown(decision: dict[str, Any]) -> str:
    lines = [
        '# P6 Entry Decision',
        '',
        f'- allowed: {str(decision.get("allowed")).lower()}',
        f'- selected_config: {decision.get("selected_config")}',
        f'- best_config: {decision.get("best_config")}',
        f'- baseline_precision: {decision.get("baseline_precision")}',
        '',
        '## Blockers',
    ]
    blockers = decision.get('blockers') or []
    if blockers:
        lines.extend(f'- {blocker}' for blocker in blockers)
    else:
        lines.append('- none')
    trace = decision.get('trace_probe') or {}
    lines.extend([
        '',
        '## Trace probe',
        f'- checked: {trace.get("checked")}',
        f'- trace_rows: {trace.get("trace_rows")}',
        f'- retrieval_rows: {trace.get("retrieval_rows")}',
        f'- eval_rows: {trace.get("eval_rows")}',
        f'- leakage_count: {trace.get("leakage_count")}',
    ])
    return '\n'.join(lines) + '\n'


def write_outputs(output_dir: Path, matrix_result: dict[str, Any], decision: dict[str, Any]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    _json_dump(output_dir / 'matrix.json', matrix_result)
    (output_dir / 'matrix.md').write_text(matrix_markdown(matrix_result), encoding='utf-8')
    _json_dump(output_dir / 'p6_entry_decision.json', decision)
    (output_dir / 'p6_entry_decision.md').write_text(decision_markdown(decision), encoding='utf-8')


def baseline_precision_from(path: Path | None, fallback: float) -> float:
    if path is None or not path.exists():
        return fallback
    payload = json.loads(path.read_text(encoding='utf-8'))
    if isinstance(payload, dict):
        raw_summary = payload.get('summary')
        summary: dict[str, Any] = raw_summary if isinstance(raw_summary, dict) else payload
        try:
            value = summary.get('context_precision')
            if value is None:
                return fallback
            return float(value)
        except (TypeError, ValueError, AttributeError):
            return fallback
    return fallback


def dry_run_matrix(matrix: list[EvalConfig], *, output_dir: Path, topic: str, repeat: int) -> dict[str, Any]:
    return {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'topic': topic,
        'repeat': repeat,
        'dry_run': True,
        'matrix': [config.to_dict() for config in matrix],
        'runs': [],
        'aggregates': [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='P6 entry measurement loop over GraphRAG precision and trace gates')
    parser.add_argument('--topic', default=DEFAULT_TOPIC)
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--required-repeats', type=int, default=None)
    parser.add_argument('--raw-weights', type=parse_float_list, default=parse_float_list('0.00,0.10,0.20,0.30'))
    parser.add_argument('--rerank-prunes', type=parse_int_list, default=parse_int_list('4,8,16'))
    parser.add_argument('--top-ks', type=parse_int_list, default=parse_int_list('2,3'))
    parser.add_argument('--timeout-s', type=float, default=45.0)
    parser.add_argument('--output-dir', type=Path, default=REPO_ROOT / 'artifacts' / 'p6-entry' / 'latest')
    parser.add_argument('--baseline-json', type=Path, default=None)
    parser.add_argument('--baseline-precision', type=float, default=DEFAULT_BASELINE_PRECISION)
    parser.add_argument('--trace-json', type=Path, default=None, help='Optional redacted trace readback JSON with trace_rows/retrieval_rows/eval_rows/leakage_count')
    parser.add_argument('--dry-run', action='store_true', help='Write planned matrix only; do not run real embeddings')
    parser.add_argument('--fail-on-blocked', action='store_true', help='Exit 1 when P6 remains blocked')
    parser.add_argument('--min-questions', type=int, default=40)
    parser.add_argument('--min-precision', type=float, default=0.45)
    parser.add_argument('--min-precision-delta', type=float, default=0.15)
    parser.add_argument('--min-recall', type=float, default=0.80)
    parser.add_argument('--min-hit-rate', type=float, default=0.80)
    parser.add_argument('--max-p95-latency-s', type=float, default=8.0)
    args = parser.parse_args()

    if args.repeat < 1:
        raise SystemExit('--repeat must be >= 1')
    output_dir = args.output_dir.resolve()
    matrix = build_matrix(raw_weights=args.raw_weights, rerank_prunes=args.rerank_prunes, top_ks=args.top_ks)
    baseline_precision = baseline_precision_from(args.baseline_json, args.baseline_precision)
    trace_probe = load_trace_probe(args.trace_json)

    if args.dry_run:
        matrix_result = dry_run_matrix(matrix, output_dir=output_dir, topic=args.topic, repeat=args.repeat)
    else:
        matrix_result = run_matrix(matrix, repeat=args.repeat, output_dir=output_dir, topic=args.topic, timeout_s=args.timeout_s)

    decision = decide_p6_entry(
        matrix_result.get('aggregates') or [],
        baseline_precision=baseline_precision,
        required_repeats=args.required_repeats or args.repeat,
        trace_probe=trace_probe,
        min_questions=args.min_questions,
        min_precision=args.min_precision,
        min_precision_delta=args.min_precision_delta,
        min_recall=args.min_recall,
        min_hit_rate=args.min_hit_rate,
        max_p95_latency_s=args.max_p95_latency_s,
    )
    write_outputs(output_dir, matrix_result, decision)
    print(json.dumps({
        'ok': True,
        'allowed': decision.get('allowed'),
        'selected_config': decision.get('selected_config'),
        'best_config': decision.get('best_config'),
        'blockers': decision.get('blockers'),
        'output_dir': str(output_dir),
    }, ensure_ascii=False, indent=2))
    if args.fail_on_blocked and not decision.get('allowed'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
