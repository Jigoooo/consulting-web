#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
from statistics import mean
from typing import Any, Callable

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BRAIN_ROOT = Path(os.environ.get('CONSULTING_BRAIN_ROOT', '/home/jigoo/.hermes/workspace/consulting'))
DEFAULT_TOPIC = 'changwon-org-mgmt-diagnosis'
GATE_SCRIPT = API_ROOT / 'scripts' / 'graphrag_eval_gate.py'

spec = importlib.util.spec_from_file_location('graphrag_eval_gate', GATE_SCRIPT)
assert spec and spec.loader
_eval_gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_eval_gate)

CODE_RE = re.compile(r'\b[A-Z]{1,8}-[A-Z0-9]{1,12}(?:-[A-Z0-9]{1,12})+\b')
TOKEN_RE = re.compile(r'[가-힣A-Za-z0-9]{2,}')
PARTICLE_RE = re.compile(r'(이|가|은|는|을|를|의|에|와|과|도|만|로|으로|에서|부터|까지)$')
STOPWORDS = {
    '그리고', '하지만', '위해서', '것이다', '있다', '없다', '대한', '관련', '모든', '함께', '전제로',
    '알려줘', '근거', '판단', '핵심', '이슈', '리스크', '의사결정', '포인트',
}

RecallFn = Callable[..., tuple[dict[str, Any], float, str | None]]


def normalize_sparse_scores(raw_scores: dict[str, float]) -> dict[str, float]:
    if not raw_scores:
        return {}
    max_score = max(max(float(value), 0.0) for value in raw_scores.values())
    if max_score <= 0:
        return {term: 0.0 for term in raw_scores}
    return {term: round(max(float(value), 0.0) / max_score, 4) for term, value in raw_scores.items()}


def _add_score(scores: dict[str, float], term: str, value: float) -> None:
    cleaned = term.strip()
    if len(cleaned) < 2:
        return
    scores[cleaned] = scores.get(cleaned, 0.0) + value


def sparse_term_scores(text: str) -> dict[str, float]:
    """Dependency-free SPLADE-style sparse expansion.

    This is intentionally not a real SPLADE model. It preserves Korean/code/numeric
    tokens and produces bounded lexical expansion terms for read-only comparison.
    """
    raw: dict[str, float] = {}
    for code in CODE_RE.findall(text or ''):
        _add_score(raw, code, 8.0)
        for part in code.split('-'):
            _add_score(raw, part, 2.0)
    for token in TOKEN_RE.findall(text or ''):
        token = PARTICLE_RE.sub('', token)
        if not token or token in STOPWORDS:
            continue
        numeric_parts = re.findall(r'\d+', token)
        for number in numeric_parts:
            _add_score(raw, number, 1.4)
        if token.isdigit():
            _add_score(raw, token, 1.4)
        elif re.fullmatch(r'[A-Z0-9]{2,}', token):
            _add_score(raw, token, 1.3)
        else:
            length_boost = min(len(token), 8) / 8
            _add_score(raw, token, 1.0 + length_boost)
    return normalize_sparse_scores(raw)


def build_splade_lite_query(query: str, *, max_terms: int = 12) -> str:
    scores = sparse_term_scores(query)
    original_parts = [part for part in query.split() if part]
    seen = set(original_parts)
    expansion: list[str] = []
    for term, _score in sorted(scores.items(), key=lambda item: (-item[1], item[0])):
        if term in seen:
            continue
        seen.add(term)
        expansion.append(term)
        if len(expansion) >= max_terms:
            break
    if not expansion:
        return query
    return ' '.join([query, *expansion])


def optional_real_splade_status(*, require_real: bool, import_name: str = 'splade') -> dict[str, Any]:
    if not require_real:
        return {'ok': True, 'mode': 'splade_lite', 'product_path_mutated': False}
    if importlib.util.find_spec(import_name) is None:
        return {
            'ok': False,
            'mode': 'skipped',
            'reason': 'optional_dependency_missing',
            'dependency': import_name,
            'product_path_mutated': False,
        }
    return {'ok': True, 'mode': 'real_splade_available', 'dependency': import_name, 'product_path_mutated': False}


def rrf_merge_rankings(baseline_ids: list[str], sparse_scores: dict[str, float], *, limit: int = 10) -> list[dict[str, Any]]:
    baseline_weight: dict[str, float] = {}
    total = max(len(baseline_ids), 1)
    for idx, item_id in enumerate(baseline_ids):
        baseline_weight[item_id] = (total - idx) / total
    combined: dict[str, float] = {}
    for item_id, score in baseline_weight.items():
        combined[item_id] = combined.get(item_id, 0.0) + score
    normalized_sparse = normalize_sparse_scores(sparse_scores)
    for item_id, score in normalized_sparse.items():
        combined[item_id] = combined.get(item_id, 0.0) + score
    max_score = max(combined.values(), default=1.0)
    rows = [
        {
            'id': item_id,
            'rrf_score': round(score / max_score, 4) if max_score else 0.0,
            'baseline_score': round(baseline_weight.get(item_id, 0.0), 4),
            'sparse_score': round(float(normalized_sparse.get(item_id, 0.0)), 4),
        }
        for item_id, score in combined.items()
    ]
    return sorted(rows, key=lambda row: (-row['rrf_score'], row['id']))[:limit]


def _bounded_metric(name: str, value: float) -> float:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f'{name} out of [0,1]: {value}')
    return round(value, 4)


def _summarize_rows(rows: list[dict[str, Any]], *, topic: str, candidate_source: str, fake_embeddings: bool) -> dict[str, Any]:
    if not rows:
        return {
            'ok': False,
            'topic': topic,
            'candidate_source': candidate_source,
            'questions': 0,
            'hit_rate': 0.0,
            'context_recall': 0.0,
            'context_precision': 0.0,
            'citation_correctness': 0.0,
            'mean_latency_s': 0.0,
            'p95_latency_s': 999.0,
            'failures': 0,
            'warning_count': 0,
            'rerank_modes': [],
            'cross_encoder_ok': False,
            'fake_embeddings': fake_embeddings,
        }
    latencies = sorted(float(row.get('latency_s') or 0.0) for row in rows)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    hit_rate = sum(1 for row in rows if row.get('hit')) / len(rows)
    failures = [row for row in rows if not row.get('ok')]
    warning_count = sum(len(row.get('warnings') or []) for row in rows)
    cross_encoder_ok = all(row.get('rerank') == 'cross-encoder' for row in rows)
    ragas = _eval_gate.compute_ragas_lite_metrics(rows)
    return {
        'ok': not failures and warning_count == 0 and cross_encoder_ok,
        'topic': topic,
        'candidate_source': candidate_source,
        'questions': len(rows),
        'hit_rate': _bounded_metric('hit_rate', hit_rate),
        **ragas,
        'mean_latency_s': round(mean(latencies), 4),
        'p95_latency_s': round(p95, 4),
        'failures': len(failures),
        'warning_count': warning_count,
        'rerank_modes': sorted({str(row.get('rerank')) for row in rows}),
        'cross_encoder_ok': cross_encoder_ok,
        'fake_embeddings': fake_embeddings,
    }


def compare_against_baseline(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    *,
    min_precision_delta: float = 0.03,
    min_recall_delta: float = -0.02,
    min_hit_delta: float = -0.02,
    max_latency_multiplier: float = 1.5,
) -> dict[str, Any]:
    precision_delta = round(float(candidate.get('context_precision') or 0.0) - float(baseline.get('context_precision') or 0.0), 4)
    recall_delta = round(float(candidate.get('context_recall') or 0.0) - float(baseline.get('context_recall') or 0.0), 4)
    hit_delta = round(float(candidate.get('hit_rate') or 0.0) - float(baseline.get('hit_rate') or 0.0), 4)
    latency_ratio = round(float(candidate.get('p95_latency_s') or 999.0) / max(float(baseline.get('p95_latency_s') or 0.001), 0.001), 4)
    blockers: list[str] = []
    if precision_delta < min_precision_delta:
        blockers.append('precision_delta_low')
    if recall_delta < min_recall_delta:
        blockers.append(f'recall_regression:{recall_delta:+.4f}<{min_recall_delta:+.4f}')
    if hit_delta < min_hit_delta:
        blockers.append(f'hit_rate_regression:{hit_delta:+.4f}<{min_hit_delta:+.4f}')
    if latency_ratio > max_latency_multiplier:
        blockers.append(f'latency_regression:{latency_ratio:.4f}>{max_latency_multiplier:.4f}')
    if int(candidate.get('warning_count') or 0) > 0:
        blockers.append(f'warnings:{candidate.get("warning_count")}')
    if not bool(candidate.get('cross_encoder_ok')):
        blockers.append('reranker_fallback')
    if bool(candidate.get('fake_embeddings')):
        blockers.append('fake_embeddings')
    return {
        'decision': 'adopt_candidate' if not blockers else 'hold',
        'blockers': blockers,
        'precision_delta': precision_delta,
        'recall_delta': recall_delta,
        'hit_rate_delta': hit_delta,
        'latency_ratio': latency_ratio,
        'product_path_mutated': False,
    }


def _configure_eval_env(*, fake_embeddings: bool, rerank_prune: int, raw_weight: float | None, rerank: bool) -> None:
    if fake_embeddings:
        os.environ['CONSULTING_EMBED_FAKE'] = '1'
    else:
        os.environ.pop('CONSULTING_EMBED_FAKE', None)
        for key in ('CONSULTING_EMBED_FIXTURE', 'CONSULTING_EMBED_FIXTURE_STRICT', 'CONSULTING_EMBED_RECORD'):
            os.environ.pop(key, None)
    os.environ['CONSULTING_BRAIN_BACKEND'] = 'pg'
    os.environ['CONSULTING_BRAIN_WRITE_BACKEND'] = 'pg'
    os.environ['CONSULTING_BRAIN_STATE_BACKEND'] = 'pg'
    os.environ.setdefault('CONSULTING_PG_DSN_DRIVER', 'psycopg')
    os.environ['CONSULTING_RERANK_PRUNE'] = str(rerank_prune)
    if raw_weight is not None:
        os.environ['CONSULTING_RECALL_RAW_WEIGHT'] = str(raw_weight)
    if rerank:
        os.environ.setdefault('CONSULTING_RERANKER_KEEP_LOADED', '1')


def evaluate_variant(
    questions: list[dict[str, Any]],
    *,
    brain_root: Path,
    topic: str,
    candidate_source: str,
    query_transform: Callable[[str], str],
    top_k: int,
    rerank: bool,
    timeout: float,
    fake_embeddings: bool,
    recall_fn: RecallFn | None = None,
) -> dict[str, Any]:
    recall = recall_fn or _eval_gate.run_recall
    rows: list[dict[str, Any]] = []
    for q in questions:
        original_query = str(q['query'])
        query = query_transform(original_query)
        start = time.perf_counter()
        result, latency, err = recall(brain_root, topic, query, top_k=top_k, rerank=rerank, timeout=timeout)
        latency = latency if latency is not None else time.perf_counter() - start
        rows.append({
            'id': q['id'],
            'query': query,
            'original_query': original_query,
            'expected': q['expected'],
            'ok': bool(result.get('ok')),
            'hit': _eval_gate.hit_expected(result, q['expected']),
            'latency_s': round(float(latency), 4),
            'rerank': result.get('rerank'),
            'rerank_error': result.get('rerank_error'),
            'signals': result.get('signals') or {},
            'retrieved_claims': _eval_gate.retrieved_claims(result),
            'warnings': _eval_gate.validate_signal_breakdown(result),
            'question_type': q.get('question_type', 'claim_lookup'),
            'candidate_source': candidate_source,
            'expansion_terms': [term for term in query.split() if term not in original_query.split()] if candidate_source != 'baseline' else [],
            **({'error': err or result.get('error')} if err or result.get('error') else {}),
        })
    return {
        'summary': _summarize_rows(rows, topic=topic, candidate_source=candidate_source, fake_embeddings=fake_embeddings),
        'rows': rows,
    }


def run_comparison(
    *,
    brain_root: Path,
    topic: str,
    top_k: int,
    rerank: bool,
    timeout: float,
    fake_embeddings: bool,
    rerank_prune: int,
    raw_weight: float | None,
    require_real_splade: bool,
) -> dict[str, Any]:
    dependency = optional_real_splade_status(require_real=require_real_splade)
    if not dependency.get('ok'):
        return {
            'ok': False,
            'dependency': dependency,
            'decision': {'decision': 'hold', 'blockers': [dependency.get('reason')], 'product_path_mutated': False},
            'product_path_mutated': False,
        }
    _configure_eval_env(fake_embeddings=fake_embeddings, rerank_prune=rerank_prune, raw_weight=raw_weight, rerank=rerank)
    _eval_gate.ensure_eval_python(brain_root)
    questions = _eval_gate.build_questions(brain_root / 'db' / 'consulting.db', topic)
    baseline = evaluate_variant(
        questions,
        brain_root=brain_root,
        topic=topic,
        candidate_source='baseline',
        query_transform=lambda query: query,
        top_k=top_k,
        rerank=rerank,
        timeout=timeout,
        fake_embeddings=fake_embeddings,
    )
    splade_lite = evaluate_variant(
        questions,
        brain_root=brain_root,
        topic=topic,
        candidate_source='splade_lite',
        query_transform=build_splade_lite_query,
        top_k=top_k,
        rerank=rerank,
        timeout=timeout,
        fake_embeddings=fake_embeddings,
    )
    decision = compare_against_baseline(baseline['summary'], splade_lite['summary'])
    return {
        'ok': True,
        'dependency': dependency,
        'topic': topic,
        'evaluation_config': {
            'top_k': top_k,
            'rerank': rerank,
            'rerank_prune': rerank_prune,
            'raw_weight': raw_weight,
            'fake_embeddings': fake_embeddings,
        },
        'baseline': baseline,
        'splade_lite': splade_lite,
        'decision': decision,
        'product_path_mutated': False,
    }


def write_report(payload: dict[str, Any], output: Path) -> None:
    baseline = (payload.get('baseline') or {}).get('summary') or {}
    candidate = (payload.get('splade_lite') or {}).get('summary') or {}
    decision = payload.get('decision') or {}
    lines = [
        '# P6 SPLADE-lite Read-only Spike',
        '',
        f'- ok: {payload.get("ok")}',
        f'- decision: {decision.get("decision")}',
        f'- product_path_mutated: {payload.get("product_path_mutated")}',
        '',
        '| method | precision | recall | hit_rate | p95 | warnings | decision |',
        '|---|---:|---:|---:|---:|---:|---|',
        f"| baseline | {baseline.get('context_precision')} | {baseline.get('context_recall')} | {baseline.get('hit_rate')} | {baseline.get('p95_latency_s')} | {baseline.get('warning_count')} | keep |",
        f"| splade_lite | {candidate.get('context_precision')} | {candidate.get('context_recall')} | {candidate.get('hit_rate')} | {candidate.get('p95_latency_s')} | {candidate.get('warning_count')} | {decision.get('decision')} |",
        '',
        '## Blockers',
    ]
    blockers = decision.get('blockers') or []
    lines.extend([f'- {blocker}' for blocker in blockers] or ['- none'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description='Read-only SPLADE-style sparse expansion comparison for P6 GraphRAG')
    parser.add_argument('--brain-root', type=Path, default=DEFAULT_BRAIN_ROOT)
    parser.add_argument('--topic', default=DEFAULT_TOPIC)
    parser.add_argument('--top-k', type=int, default=1)
    parser.add_argument('--timeout-s', type=float, default=45.0)
    parser.add_argument('--rerank', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--fake-embeddings', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--rerank-prune', type=int, default=4)
    parser.add_argument('--raw-weight', type=float, default=0.20)
    parser.add_argument('--require-real-splade', action='store_true')
    parser.add_argument('--output', type=Path, default=REPO_ROOT / 'artifacts' / 'p6-splade-lite' / 'latest' / 'comparison.json')
    parser.add_argument('--report-output', type=Path, default=None)
    parser.add_argument('--fail-on-hold', action='store_true')
    args = parser.parse_args()

    payload = run_comparison(
        brain_root=args.brain_root,
        topic=args.topic,
        top_k=args.top_k,
        rerank=bool(args.rerank),
        timeout=args.timeout_s,
        fake_embeddings=bool(args.fake_embeddings),
        rerank_prune=args.rerank_prune,
        raw_weight=args.raw_weight,
        require_real_splade=bool(args.require_real_splade),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    write_report(payload, args.report_output or args.output.with_suffix('.md'))
    print(json.dumps({
        'ok': payload.get('ok'),
        'decision': (payload.get('decision') or {}).get('decision'),
        'blockers': (payload.get('decision') or {}).get('blockers'),
        'output': str(args.output),
        'product_path_mutated': payload.get('product_path_mutated'),
    }, ensure_ascii=False, indent=2))
    if args.fail_on_hold and (payload.get('decision') or {}).get('decision') != 'adopt_candidate':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
