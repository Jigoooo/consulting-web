#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from statistics import mean

DEFAULT_BRAIN_ROOT = Path(os.environ.get('CONSULTING_BRAIN_ROOT', '/home/jigoo/.hermes/workspace/consulting'))
DEFAULT_TOPIC = 'changwon-org-mgmt-diagnosis'


def keywords(text: str, limit: int = 5) -> list[str]:
    stop = {'그리고', '하지만', '위해서', '것이다', '있다', '없다', '대한', '관련', '모든', '함께', '전제로', '본', '용역'}
    out: list[str] = []
    for token in re.findall(r'[가-힣A-Za-z0-9]{2,}', text or ''):
        token = re.sub(r'(이|가|은|는|을|를|의|에|와|과|도|만|로|으로|에서|부터|까지)$', '', token)
        if len(token) < 2 or token in stop or token in out:
            continue
        out.append(token)
        if len(out) >= limit:
            break
    return out


def build_questions(db_path: Path, topic: str) -> list[dict]:
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
    questions: list[dict] = []
    for row in rows:
        code = row['claim_code']
        text = row['claim_text']
        kws = keywords(text)
        head = ' '.join(kws[:4]) or code
        questions.extend([
            {'id': f'{code}-code', 'query': f'{code} 관련 핵심 판단과 근거를 알려줘', 'expected': code, 'question_type': 'claim_lookup'},
            {'id': f'{code}-terms', 'query': f'{head} 이슈의 판단 근거는?', 'expected': code, 'question_type': 'context_recall'},
            {'id': f'{code}-risk', 'query': f'{head} 관련 리스크와 창원시 의사결정 포인트', 'expected': code, 'question_type': 'structured_relation'},
        ])
    return questions


def brain_python(brain_root: Path) -> str:
    explicit = os.environ.get('CONSULTING_EVAL_PYTHON')
    if explicit:
        return explicit

    def can_cross_encoder(python_bin: str) -> bool:
        try:
            proc = subprocess.run(
                [python_bin, '-c', 'import onnxruntime, tokenizers'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            return proc.returncode == 0
        except Exception:
            return False

    venv_python = brain_root / '.venv' / 'bin' / 'python3'
    candidates = [str(venv_python)] if venv_python.exists() else []
    candidates.append(sys.executable)
    for candidate in candidates:
        if can_cross_encoder(candidate):
            return candidate
    return candidates[0]


def run_recall(brain_root: Path, topic: str, query: str, *, top_k: int, rerank: bool, timeout: float) -> tuple[dict, float, str | None]:
    cmd = [
        brain_python(brain_root),
        str(brain_root / 'scripts' / 'dialogue_memory_cli.py'),
        'recall',
        '--topic', topic,
        '--q', query,
        '--top-k', str(top_k),
        '--format', 'json',
    ]
    cmd.append('--rerank' if rerank else '--no-rerank')
    start = time.perf_counter()
    try:
        proc = subprocess.run(cmd, cwd=str(brain_root), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        return {'ok': False, 'hits': [], 'rerank': None, 'signals': {}, 'error': 'timeout'}, timeout, str(exc)
    latency = time.perf_counter() - start
    if proc.returncode != 0:
        return {'ok': False, 'hits': [], 'rerank': None, 'signals': {}, 'error': proc.stderr[-500:]}, latency, proc.stderr[-500:]
    try:
        return json.loads(proc.stdout), latency, None
    except json.JSONDecodeError as exc:
        return {'ok': False, 'hits': [], 'rerank': None, 'signals': {}, 'error': f'json:{exc}'}, latency, proc.stdout[:500]


def hit_expected(result: dict, expected: str) -> bool:
    needle = f'claim:{expected}'
    for hit in result.get('hits') or []:
        linked = hit.get('linked') or []
        if needle in linked:
            return True
    return False


def retrieved_claims(result: dict) -> list[str]:
    claims: list[str] = []
    for hit in result.get('hits') or []:
        for link in hit.get('linked') or []:
            if isinstance(link, str) and link.startswith('claim:'):
                code = link.split(':', 1)[1]
                if code not in claims:
                    claims.append(code)
    return claims


def _bounded_metric(name: str, value: float) -> float:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f'{name} out of [0,1]: {value}')
    return round(value, 4)


def compute_ragas_lite_metrics(rows: list[dict]) -> dict:
    if not rows:
        return {'context_recall': 0.0, 'context_precision': 0.0, 'citation_correctness': 0.0, 'structured_relation_questions': 0}
    context_recall = sum(1 for r in rows if r.get('hit')) / len(rows)
    per_row_precision = []
    for row in rows:
        claims = row.get('retrieved_claims') or []
        expected = row.get('expected')
        per_row_precision.append(0.0 if not claims else sum(1 for c in claims if c == expected) / len(claims))
    context_precision = sum(per_row_precision) / len(per_row_precision)
    citation_correctness = sum(1 for r in rows if not (r.get('warnings') or [])) / len(rows)
    return {
        'context_recall': _bounded_metric('context_recall', context_recall),
        'context_precision': _bounded_metric('context_precision', context_precision),
        'citation_correctness': _bounded_metric('citation_correctness', citation_correctness),
        'structured_relation_questions': sum(1 for r in rows if r.get('question_type') == 'structured_relation'),
    }


def write_markdown_report(summary: dict, rows: list[dict], output: Path, *, baseline: dict | None = None) -> None:
    def delta_line(key: str) -> str:
        if not baseline or key not in baseline or key not in summary:
            return f'- {key}: {summary.get(key)}'
        delta = float(summary[key]) - float(baseline[key])
        return f'- {key}: {summary.get(key)} (Δ {key} {delta:+.4f})'

    failed = [r for r in rows if not r.get('hit') or r.get('warnings')]
    lines = [
        '# GraphRAG RAGAS/STaRK-lite 평가 리포트', '',
        f'- topic: {summary.get("topic")}',
        f'- ok: {summary.get("ok")}',
        f'- questions: {summary.get("questions")}',
        f'- rerank_modes: {", ".join(str(x) for x in summary.get("rerank_modes", []))}',
        '', '## Metrics',
        delta_line('hit_rate'),
        delta_line('context_recall'),
        delta_line('context_precision'),
        delta_line('citation_correctness'),
        f'- p95_latency_s: {summary.get("p95_latency_s")}',
        f'- structured_relation_questions: {summary.get("structured_relation_questions")}',
        '', '## Failures / warnings',
    ]
    if failed:
        for row in failed[:20]:
            lines.append(f'- {row.get("id")}: hit={row.get("hit")} warnings={row.get("warnings")} expected={row.get("expected")} retrieved={row.get("retrieved_claims")}')
    else:
        lines.append('- none')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def validate_signal_breakdown(result: dict) -> list[str]:
    warnings: list[str] = []
    for idx, hit in enumerate(result.get('hits') or []):
        breakdown = hit.get('signal_breakdown')
        if not isinstance(breakdown, dict):
            warnings.append(f'hit[{idx}] missing signal_breakdown')
            continue
        for name, detail in breakdown.items():
            if not isinstance(detail, dict):
                warnings.append(f'hit[{idx}] {name} detail not object')
                continue
            rrf = detail.get('rrf')
            rank = detail.get('rank')
            if not isinstance(rrf, (int, float)) or rrf < 0 or rrf > 1:
                warnings.append(f'hit[{idx}] {name} rrf out of range: {rrf}')
            if rank is not None and (not isinstance(rank, int) or rank < 1):
                warnings.append(f'hit[{idx}] {name} rank invalid: {rank}')
    return warnings


def main() -> None:
    parser = argparse.ArgumentParser(description='Deterministic GraphRAG evaluation gate for consulting-web bridge')
    parser.add_argument('--brain-root', type=Path, default=DEFAULT_BRAIN_ROOT)
    parser.add_argument('--topic', default=DEFAULT_TOPIC)
    parser.add_argument('--top-k', type=int, default=5)
    parser.add_argument('--timeout-s', type=float, default=45.0)
    parser.add_argument('--rerank', action='store_true')
    parser.add_argument('--require-cross-encoder', action='store_true', default=True)
    parser.add_argument('--fake-embeddings', action=argparse.BooleanOptionalAction, default=True,
                        help='Use deterministic fake embeddings (default: on, for CI determinism). '
                             'Pass --no-fake-embeddings to measure with real Gemini query embeddings.')
    parser.add_argument('--rerank-prune', type=int, default=None,
                        help='Override CONSULTING_RERANK_PRUNE (candidates kept before cross-encoder rerank). '
                             'Lower = tighter precision, higher = better recall. Default keeps 4 for CI.')
    parser.add_argument('--raw-weight', type=float, default=None,
                        help='Override CONSULTING_RECALL_RAW_WEIGHT for noise-filter experiments. '
                             '0.0 excludes raw/unverified file chunks; unset keeps the recall default.')
    parser.add_argument('--min-hit-rate', type=float, default=0.60)
    parser.add_argument('--max-p95-latency-s', type=float, default=20.0)
    parser.add_argument('--output', type=Path, default=Path('artifacts/graphrag-eval-baseline.json'))
    parser.add_argument('--report-output', type=Path, default=None)
    parser.add_argument('--baseline-json', type=Path, default=None)
    args = parser.parse_args()

    db_path = args.brain_root / 'db' / 'consulting.db'
    questions = build_questions(db_path, args.topic)
    if len(questions) < 40:
        raise SystemExit(f'eval set too small: {len(questions)} < 40')

    if args.fake_embeddings:
        os.environ['CONSULTING_EMBED_FAKE'] = '1'
    else:
        # Real-embedding measurement: ensure the fake flag is not inherited from the env.
        os.environ.pop('CONSULTING_EMBED_FAKE', None)
    if args.rerank_prune is not None:
        os.environ['CONSULTING_RERANK_PRUNE'] = str(args.rerank_prune)
    else:
        os.environ.setdefault('CONSULTING_RERANK_PRUNE', '4')
    if args.raw_weight is not None:
        os.environ['CONSULTING_RECALL_RAW_WEIGHT'] = str(args.raw_weight)

    rows = []
    for q in questions:
        result, latency, err = run_recall(args.brain_root, args.topic, q['query'], top_k=args.top_k, rerank=args.rerank, timeout=args.timeout_s)
        ok = bool(result.get('ok'))
        hit = hit_expected(result, q['expected'])
        rows.append({
            'id': q['id'],
            'query': q['query'],
            'expected': q['expected'],
            'ok': ok,
            'hit': hit,
            'latency_s': round(latency, 4),
            'rerank': result.get('rerank'),
            'rerank_error': result.get('rerank_error'),
            'signals': result.get('signals') or {},
            'retrieved_claims': retrieved_claims(result),
            'warnings': validate_signal_breakdown(result),
            'question_type': q.get('question_type', 'claim_lookup'),
            **({'error': err or result.get('error')} if err or result.get('error') else {}),
        })

    latencies = sorted(r['latency_s'] for r in rows)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    hit_rate = sum(1 for r in rows if r['hit']) / len(rows)
    failures = [r for r in rows if not r['ok']]
    warning_count = sum(len(r['warnings']) for r in rows)
    cross_encoder_required = bool(args.rerank and args.require_cross_encoder)
    cross_encoder_ok = (not cross_encoder_required) or all(r['rerank'] == 'cross-encoder' for r in rows)
    ragas_lite = compute_ragas_lite_metrics(rows)
    summary = {
        'ok': not failures and hit_rate >= args.min_hit_rate and p95 <= args.max_p95_latency_s and warning_count == 0 and cross_encoder_ok,
        'topic': args.topic,
        'questions': len(rows),
        'hit_rate': round(hit_rate, 4),
        **ragas_lite,
        'mean_latency_s': round(mean(latencies), 4),
        'p95_latency_s': round(p95, 4),
        'failures': len(failures),
        'warning_count': warning_count,
        'rerank_modes': sorted({str(r['rerank']) for r in rows}),
        'cross_encoder_required': cross_encoder_required,
        'cross_encoder_ok': cross_encoder_ok,
        'fake_embeddings': bool(args.fake_embeddings),
        'evaluation_config': {
            'top_k': args.top_k,
            'rerank': bool(args.rerank),
            'rerank_prune': int(os.environ.get('CONSULTING_RERANK_PRUNE', '16')),
            'raw_weight': (args.raw_weight if args.raw_weight is not None else os.environ.get('CONSULTING_RECALL_RAW_WEIGHT', 'default')),
        },
        'gates': {
            'min_hit_rate': args.min_hit_rate,
            'max_p95_latency_s': args.max_p95_latency_s,
            'no_failures': True,
            'no_signal_warnings': True,
            'cross_encoder_when_rerank': cross_encoder_required,
        },
    }
    out = {'summary': summary, 'rows': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    baseline = None
    if args.baseline_json and args.baseline_json.exists():
        baseline_payload = json.loads(args.baseline_json.read_text(encoding='utf-8'))
        baseline = baseline_payload.get('summary') if isinstance(baseline_payload, dict) else None
    write_markdown_report(summary, rows, args.report_output or args.output.with_suffix('.md'), baseline=baseline)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not summary['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
