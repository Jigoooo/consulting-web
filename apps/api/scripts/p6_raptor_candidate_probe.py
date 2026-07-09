#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict
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

CODE_RE = re.compile(r'\bCL-[A-Z0-9-]+\b')
TOKEN_RE = re.compile(r'[가-힣A-Za-z0-9]{2,}')
SUMMARY_QUERY_RE = re.compile(r'(전체|전반|큰\s*그림|흐름|요약|반복|공통|종합|구조|시나리오|패키지)')
STOPWORDS = {
    '그리고', '하지만', '위해서', '것이다', '있다', '없다', '대한', '관련', '모든', '함께', '전제로',
    '전체', '전반', '흐름', '요약', '종합', '구조', '근거', '판단', '이슈', '리스크', '창원시',
    'RAPTOR', 'lite', '핵심어', '쟁점', '영향', '제시되어야', '제약', '노무',
}
SUFFIX_RE = re.compile(r'(입니다|된다|한다|했다|하는|하다|에서|으로|부터|까지|에게|보다|처럼|이며|이고|이나|거나|과|와|을|를|은|는|이|가|의|에|도|만|로)$')

RecallFn = Callable[..., tuple[dict[str, Any], float, str | None]]


def _clean_text(text: str) -> str:
    text = CODE_RE.sub('', text or '')
    text = re.sub(r'claim:[A-Z0-9-]+', '', text)
    return re.sub(r'\s+', ' ', text).strip()


def _terms(text: str, *, limit: int = 16) -> list[str]:
    out: list[str] = []
    for raw in TOKEN_RE.findall(_clean_text(text)):
        term = SUFFIX_RE.sub('', raw)
        if len(term) < 2 or term in STOPWORDS or term in out:
            continue
        out.append(term)
        if len(out) >= limit:
            break
    return out


def _theme_for_claim(text: str) -> tuple[str, str]:
    cleaned = _clean_text(text)
    if re.search(r'재정|인건비|총인건비|수당|정원|승진|공무직|처우', cleaned):
        return 'finance_workforce', '재정·정원·노무'
    if re.search(r'이관|주차장|파크골프|안전시설|시설|운영|민원|정산', cleaned):
        return 'transfer_operation', '사업이관·시설운영'
    if re.search(r'시장|인수위|정책|시나리오|선택지|원자료|재검증|통합|과업', cleaned):
        return 'governance_scenario', '정책변수·검증·시나리오'
    if re.search(r'수익|경륜|사행산업|사업재편', cleaned):
        return 'revenue_structure', '수익구조·사업재편'
    return 'general_decision', '일반 의사결정'


def load_claims(db_path: Path, topic: str) -> list[dict[str, str]]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        topic_row = con.execute('SELECT id FROM topics WHERE slug=?', (topic,)).fetchone()
        if not topic_row:
            raise SystemExit(f'unknown topic: {topic}')
        rows = con.execute(
            'SELECT claim_code, claim_text FROM claims WHERE topic_id=? AND claim_code IS NOT NULL AND claim_text IS NOT NULL ORDER BY claim_code',
            (topic_row['id'],),
        ).fetchall()
    finally:
        con.close()
    return [{'claim_code': str(row['claim_code']), 'claim_text': str(row['claim_text'])} for row in rows]


def _summary_for_group(label: str, claims: list[dict[str, str]]) -> str:
    term_pool: list[str] = []
    snippets: list[str] = []
    for claim in claims:
        cleaned = _clean_text(claim.get('claim_text') or '')
        if cleaned:
            snippets.append(cleaned[:130])
        for term in _terms(cleaned, limit=10):
            if term not in term_pool:
                term_pool.append(term)
    terms = ', '.join(term_pool[:10]) or label
    body = ' / '.join(snippets[:3])[:520]
    return f'{label} RAPTOR-lite 요약: 핵심어={terms}. 쟁점={body}'


def build_hierarchical_summary_rows(claims: list[dict[str, str]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    labels: dict[str, str] = {}
    for claim in claims:
        code = str(claim.get('claim_code') or '').strip()
        text = str(claim.get('claim_text') or '').strip()
        if not code or not text:
            continue
        theme, label = _theme_for_claim(text)
        grouped[theme].append({'claim_code': code, 'claim_text': text})
        labels[theme] = label

    rows: list[dict[str, Any]] = []
    for idx, theme in enumerate(sorted(grouped), start=1):
        cluster = sorted(grouped[theme], key=lambda item: item['claim_code'])
        rows.append({
            'node_id': f'raptor-lite:{idx}:{theme}',
            'node_type': 'raptor_lite_summary',
            'source': 'raptor_lite',
            'theme': theme,
            'label': labels[theme],
            'source_claim_ids': [item['claim_code'] for item in cluster],
            'summary_text': _summary_for_group(labels[theme], cluster),
            'level': 1,
            'product_path_mutated': False,
        })

    all_claims = sorted(
        [{'claim_code': str(c.get('claim_code')), 'claim_text': str(c.get('claim_text'))} for c in claims if c.get('claim_code') and c.get('claim_text')],
        key=lambda item: item['claim_code'],
    )
    if len(all_claims) > 1:
        root_text = ' / '.join(f"{row['label']}: {', '.join(_terms(row['summary_text'], limit=5))}" for row in rows)
        rows.insert(0, {
            'node_id': 'raptor-lite:0:root',
            'node_type': 'raptor_lite_root_summary',
            'source': 'raptor_lite',
            'theme': 'root',
            'label': '전체 의사결정 구조',
            'source_claim_ids': [item['claim_code'] for item in all_claims],
            'summary_text': _clean_text(f'전체 의사결정 구조 RAPTOR-lite 요약: {root_text}'),
            'level': 2,
            'product_path_mutated': False,
        })
    return rows


def build_global_questions(summary_rows: list[dict[str, Any]], *, max_questions: int = 6) -> list[dict[str, Any]]:
    candidates = [row for row in summary_rows if row.get('source_claim_ids')]
    candidates = sorted(candidates, key=lambda row: (-int(row.get('level') or 0), -len(row.get('source_claim_ids') or []), str(row.get('node_id'))))
    questions: list[dict[str, Any]] = []
    for row in candidates[:max_questions]:
        terms = _terms(row.get('summary_text') or '', limit=5)
        head = ' '.join(terms[:4]) or str(row.get('label') or '의사결정')
        query = _clean_text(f'전체 {head} 흐름을 종합해줘')
        questions.append({
            'id': f"global-{row.get('theme') or len(questions)}",
            'query': query,
            'expected_claims': list(row.get('source_claim_ids') or []),
            'question_type': 'global_summary',
            'summary_node_id': row.get('node_id'),
        })
    return questions


def prefers_summary_query(query: str) -> bool:
    return bool(SUMMARY_QUERY_RE.search(query or '')) and CODE_RE.search(query or '') is None


def build_raptor_lite_query(query: str, *, summaries: list[dict[str, Any]], max_terms: int = 12) -> str:
    if not prefers_summary_query(query):
        return query
    qterms = _terms(query, limit=12)
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for row in summaries:
        sterms = _terms(row.get('summary_text') or '', limit=16)
        overlap = sum(1 for term in qterms if term in sterms or any(term in s for s in sterms))
        level = int(row.get('level') or 0)
        scored.append((overlap, level, row))
    scored.sort(key=lambda item: (item[0], item[1], len(item[2].get('source_claim_ids') or [])), reverse=True)
    original_parts = [part for part in query.split() if part]
    seen = set(original_parts)
    expansion: list[str] = []
    for _overlap, _level, row in scored[:3]:
        for term in _terms(row.get('summary_text') or '', limit=20):
            if CODE_RE.search(term) or term in seen:
                continue
            seen.add(term)
            expansion.append(term)
            if len(expansion) >= max_terms:
                break
        if len(expansion) >= max_terms:
            break
    if not expansion:
        return query
    return ' '.join([query, *expansion])


def _bounded_metric(name: str, value: float) -> float:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f'{name} out of [0,1]: {value}')
    return round(value, 4)


def compute_global_summary(rows: list[dict[str, Any]], *, topic: str, candidate_source: str, fake_embeddings: bool) -> dict[str, Any]:
    if not rows:
        return {
            'ok': False,
            'topic': topic,
            'candidate_source': candidate_source,
            'questions': 0,
            'hit_rate': 0.0,
            'global_coverage': 0.0,
            'global_precision': 0.0,
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
    coverages: list[float] = []
    precisions: list[float] = []
    hits = 0
    for row in rows:
        expected = list(row.get('expected_claims') or [])
        retrieved = list(row.get('retrieved_claims') or [])
        matched = [claim for claim in expected if claim in retrieved]
        coverages.append(0.0 if not expected else len(matched) / len(expected))
        precisions.append(0.0 if not retrieved else len([claim for claim in retrieved if claim in expected]) / len(retrieved))
        if matched:
            hits += 1
    latencies = sorted(float(row.get('latency_s') or 0.0) for row in rows)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    failures = [row for row in rows if not row.get('ok')]
    warning_count = sum(len(row.get('warnings') or []) for row in rows)
    cross_encoder_ok = all(row.get('rerank') == 'cross-encoder' for row in rows)
    global_coverage = _bounded_metric('global_coverage', sum(coverages) / len(coverages))
    global_precision = _bounded_metric('global_precision', sum(precisions) / len(precisions))
    citation_correctness = _bounded_metric('citation_correctness', sum(1 for row in rows if not (row.get('warnings') or [])) / len(rows))
    return {
        'ok': not failures and warning_count == 0 and cross_encoder_ok,
        'topic': topic,
        'candidate_source': candidate_source,
        'questions': len(rows),
        'hit_rate': _bounded_metric('hit_rate', hits / len(rows)),
        'global_coverage': global_coverage,
        'global_precision': global_precision,
        'context_recall': global_coverage,
        'context_precision': global_precision,
        'citation_correctness': citation_correctness,
        'mean_latency_s': round(mean(latencies), 4),
        'p95_latency_s': round(p95, 4),
        'failures': len(failures),
        'warning_count': warning_count,
        'rerank_modes': sorted({str(row.get('rerank')) for row in rows}),
        'cross_encoder_ok': cross_encoder_ok,
        'fake_embeddings': fake_embeddings,
    }


def compare_global_against_baseline(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    *,
    min_coverage_delta: float = 0.05,
    min_precision_delta: float = -0.02,
    min_hit_delta: float = -0.02,
    max_latency_multiplier: float = 1.5,
) -> dict[str, Any]:
    coverage_delta = round(float(candidate.get('global_coverage') or 0.0) - float(baseline.get('global_coverage') or 0.0), 4)
    precision_delta = round(float(candidate.get('global_precision') or 0.0) - float(baseline.get('global_precision') or 0.0), 4)
    hit_delta = round(float(candidate.get('hit_rate') or 0.0) - float(baseline.get('hit_rate') or 0.0), 4)
    latency_ratio = round(float(candidate.get('p95_latency_s') or 999.0) / max(float(baseline.get('p95_latency_s') or 0.001), 0.001), 4)
    blockers: list[str] = []
    if coverage_delta < min_coverage_delta:
        blockers.append('coverage_delta_low')
    if precision_delta < min_precision_delta:
        blockers.append(f'precision_regression:{precision_delta:+.4f}<{min_precision_delta:+.4f}')
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
        'coverage_delta': coverage_delta,
        'precision_delta': precision_delta,
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


def evaluate_global_variant(
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
        retrieved = _eval_gate.retrieved_claims(result)
        expected = list(q.get('expected_claims') or [])
        hit = any(claim in retrieved for claim in expected)
        rows.append({
            'id': q['id'],
            'query': query,
            'original_query': original_query,
            'expected_claims': expected,
            'ok': bool(result.get('ok')),
            'hit': hit,
            'latency_s': round(float(latency), 4),
            'rerank': result.get('rerank'),
            'rerank_error': result.get('rerank_error'),
            'signals': result.get('signals') or {},
            'retrieved_claims': retrieved,
            'warnings': _eval_gate.validate_signal_breakdown(result),
            'question_type': q.get('question_type', 'global_summary'),
            'candidate_source': candidate_source,
            'expansion_terms': [term for term in query.split() if term not in original_query.split()] if candidate_source != 'baseline' else [],
            **({'error': err or result.get('error')} if err or result.get('error') else {}),
        })
    return {
        'summary': compute_global_summary(rows, topic=topic, candidate_source=candidate_source, fake_embeddings=fake_embeddings),
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
) -> dict[str, Any]:
    _configure_eval_env(fake_embeddings=fake_embeddings, rerank_prune=rerank_prune, raw_weight=raw_weight, rerank=rerank)
    _eval_gate.ensure_eval_python(brain_root)
    claims = load_claims(brain_root / 'db' / 'consulting.db', topic)
    summaries = build_hierarchical_summary_rows(claims)
    questions = build_global_questions(summaries)
    if not questions:
        return {
            'ok': False,
            'topic': topic,
            'summary_rows': summaries,
            'global_questions': [],
            'decision': {'decision': 'hold', 'blockers': ['no_global_questions'], 'product_path_mutated': False},
            'product_path_mutated': False,
        }
    baseline = evaluate_global_variant(
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
    raptor_lite = evaluate_global_variant(
        questions,
        brain_root=brain_root,
        topic=topic,
        candidate_source='raptor_lite',
        query_transform=lambda query: build_raptor_lite_query(query, summaries=summaries),
        top_k=top_k,
        rerank=rerank,
        timeout=timeout,
        fake_embeddings=fake_embeddings,
    )
    decision = compare_global_against_baseline(baseline['summary'], raptor_lite['summary'])
    return {
        'ok': True,
        'topic': topic,
        'evaluation_config': {
            'top_k': top_k,
            'rerank': rerank,
            'rerank_prune': rerank_prune,
            'raw_weight': raw_weight,
            'fake_embeddings': fake_embeddings,
            'question_class': 'global_summary',
        },
        'summary_rows': summaries,
        'global_questions': questions,
        'baseline': baseline,
        'raptor_lite': raptor_lite,
        'decision': decision,
        'product_path_mutated': False,
    }


def write_report(payload: dict[str, Any], output: Path) -> None:
    baseline = (payload.get('baseline') or {}).get('summary') or {}
    candidate = (payload.get('raptor_lite') or {}).get('summary') or {}
    decision = payload.get('decision') or {}
    lines = [
        '# P6 RAPTOR-lite Read-only Spike',
        '',
        f'- ok: {payload.get("ok")}',
        f'- decision: {decision.get("decision")}',
        f'- product_path_mutated: {payload.get("product_path_mutated")}',
        f'- summary_rows: {len(payload.get("summary_rows") or [])}',
        f'- global_questions: {len(payload.get("global_questions") or [])}',
        '',
        '| method | global_coverage | global_precision | hit_rate | p95 | warnings | decision |',
        '|---|---:|---:|---:|---:|---:|---|',
        f"| baseline | {baseline.get('global_coverage')} | {baseline.get('global_precision')} | {baseline.get('hit_rate')} | {baseline.get('p95_latency_s')} | {baseline.get('warning_count')} | keep |",
        f"| raptor_lite | {candidate.get('global_coverage')} | {candidate.get('global_precision')} | {candidate.get('hit_rate')} | {candidate.get('p95_latency_s')} | {candidate.get('warning_count')} | {decision.get('decision')} |",
        '',
        '## Blockers',
    ]
    blockers = decision.get('blockers') or []
    lines.extend([f'- {blocker}' for blocker in blockers] or ['- none'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description='Read-only RAPTOR-lite hierarchical summary comparison for P6 GraphRAG')
    parser.add_argument('--brain-root', type=Path, default=DEFAULT_BRAIN_ROOT)
    parser.add_argument('--topic', default=DEFAULT_TOPIC)
    parser.add_argument('--top-k', type=int, default=3)
    parser.add_argument('--timeout-s', type=float, default=45.0)
    parser.add_argument('--rerank', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--fake-embeddings', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--rerank-prune', type=int, default=8)
    parser.add_argument('--raw-weight', type=float, default=0.20)
    parser.add_argument('--output', type=Path, default=REPO_ROOT / 'artifacts' / 'p6-raptor-lite' / 'latest' / 'comparison.json')
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
