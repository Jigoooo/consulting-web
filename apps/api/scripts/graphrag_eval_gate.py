#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import traceback
from pathlib import Path
from statistics import mean
from typing import Any

DEFAULT_BRAIN_ROOT = Path(os.environ.get('CONSULTING_BRAIN_ROOT', '/home/jigoo/.hermes/workspace/consulting'))
DEFAULT_TOPIC = 'changwon-org-mgmt-diagnosis'
API_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HUMAN_GLOBAL_CASES = API_ROOT / 'fixtures' / 'eval' / 'changwon_human_global_cases.json'
CLAIM_CODE_RE = re.compile(r'\bCL-[A-Z0-9-]+\b')
_BACKEND_CACHE: dict[str, Any] = {}


def can_cross_encoder(python_bin: str) -> bool:
    try:
        proc = subprocess.run(
            [python_bin, '-c', 'import onnxruntime, tokenizers, numpy'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        return proc.returncode == 0
    except Exception:
        return False


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


def load_human_global_cases(path: Path, *, topic: str) -> list[dict]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError(f'human global eval fixture must be a JSON object: {path}')
    if payload.get('topic') != topic:
        raise ValueError(f'human global eval topic mismatch: expected {topic}, got {payload.get("topic")}')
    raw_cases = payload.get('cases')
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError('human global eval fixture must include non-empty cases[]')

    seen: set[str] = set()
    cases: list[dict] = []
    for idx, raw in enumerate(raw_cases):
        if not isinstance(raw, dict):
            raise ValueError(f'human global eval case[{idx}] must be an object')
        case_id = str(raw.get('id') or '').strip()
        query = str(raw.get('query') or '').strip()
        expected_claims = raw.get('expected_claims')
        if not case_id or case_id in seen:
            raise ValueError(f'human global eval case id missing/duplicate: {case_id or idx}')
        if not query:
            raise ValueError(f'human global eval case query missing: {case_id}')
        if CLAIM_CODE_RE.search(query):
            raise ValueError(f'human global eval query leaks oracle claim code: {case_id}')
        if not isinstance(expected_claims, list) or len(expected_claims) < 2:
            raise ValueError(f'human global eval case needs at least 2 expected_claims: {case_id}')
        normalized_claims = [str(item).strip() for item in expected_claims if str(item).strip()]
        if len(normalized_claims) != len(expected_claims) or any(not CLAIM_CODE_RE.fullmatch(item) for item in normalized_claims):
            raise ValueError(f'human global eval expected_claims must be claim codes: {case_id}')
        seen.add(case_id)
        cases.append({
            'id': case_id,
            'query': query,
            'expected': normalized_claims[0],
            'expected_claims': normalized_claims,
            'question_type': 'human_global',
            'human_authored': True,
            'rationale': str(raw.get('rationale') or '').strip(),
        })
    return cases


def brain_python(brain_root: Path) -> str:
    explicit = os.environ.get('CONSULTING_EVAL_PYTHON')
    if explicit:
        return explicit

    venv_python = brain_root / '.venv' / 'bin' / 'python3'
    candidates = [str(venv_python)] if venv_python.exists() else []
    candidates.append(sys.executable)
    for candidate in candidates:
        if can_cross_encoder(candidate):
            return candidate
    return candidates[0]


def ensure_eval_python(brain_root: Path) -> None:
    """Re-exec once into the consulting-brain venv, then reuse the reranker in-process."""
    selected = Path(brain_python(brain_root)).absolute()
    current = Path(sys.executable).absolute()
    if selected != current and os.environ.get('CONSULTING_EVAL_REEXECED') != '1':
        env = dict(os.environ)
        env['CONSULTING_EVAL_REEXECED'] = '1'
        os.execvpe(str(selected), [str(selected), *sys.argv], env)


def _load_backend(brain_root: Path):
    key = str(brain_root.resolve())
    cached = _BACKEND_CACHE.get(key)
    if cached is not None:
        return cached
    scripts_dir = brain_root / 'scripts'
    memory_dir = scripts_dir / 'dialogue_memory'
    for path in (str(memory_dir), str(scripts_dir)):
        if path not in sys.path:
            sys.path.insert(0, path)
    backend_path = memory_dir / 'backend.py'
    spec = importlib.util.spec_from_file_location(f'_consulting_dialogue_backend_{abs(hash(key))}', backend_path)
    if not spec or not spec.loader:
        raise RuntimeError(f'cannot load dialogue memory backend: {backend_path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _BACKEND_CACHE[key] = module
    return module


def run_recall_subprocess(brain_root: Path, topic: str, query: str, *, top_k: int, rerank: bool, timeout: float) -> tuple[dict, float, str | None]:
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


def run_recall(brain_root: Path, topic: str, query: str, *, top_k: int, rerank: bool, timeout: float) -> tuple[dict, float, str | None]:
    if os.environ.get('CONSULTING_EVAL_RECALL_MODE') == 'subprocess':
        return run_recall_subprocess(brain_root, topic, query, top_k=top_k, rerank=rerank, timeout=timeout)
    start = time.perf_counter()
    try:
        backend = _load_backend(brain_root)
        result = backend.recall(topic, query, top_k=top_k, rerank=rerank, backend=os.environ.get('CONSULTING_BRAIN_BACKEND') or None)
        return result, time.perf_counter() - start, None
    except Exception as exc:
        err = ''.join(traceback.format_exception_only(type(exc), exc)).strip()
        return {'ok': False, 'hits': [], 'rerank': None, 'signals': {}, 'error': err}, time.perf_counter() - start, traceback.format_exc()[-500:]


def expected_claims_for_row(row: dict) -> list[str]:
    raw = row.get('expected_claims')
    if isinstance(raw, list) and raw:
        return [str(item) for item in raw if str(item)]
    expected = row.get('expected')
    return [str(expected)] if expected else []


def hit_expected(result: dict, expected: str) -> bool:
    return hit_expected_claims(result, [expected])


def hit_expected_claims(result: dict, expected_claims: list[str]) -> bool:
    expected = set(expected_claims)
    if not expected:
        return False
    retrieved = set(retrieved_claims(result))
    return bool(expected.intersection(retrieved))


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
        return {'context_recall': 0.0, 'context_precision': 0.0, 'citation_correctness': 0.0, 'structured_relation_questions': 0, 'human_global_questions': 0}
    per_row_recall = []
    per_row_precision = []
    for row in rows:
        claims = row.get('retrieved_claims') or []
        expected_claims = expected_claims_for_row(row)
        expected = set(expected_claims)
        retrieved = set(str(item) for item in claims)
        matches = expected.intersection(retrieved)
        per_row_recall.append(0.0 if not expected else len(matches) / len(expected))
        per_row_precision.append(0.0 if not retrieved else len(matches) / len(retrieved))
    context_recall = sum(per_row_recall) / len(per_row_recall)
    context_precision = sum(per_row_precision) / len(per_row_precision)
    citation_correctness = sum(1 for r in rows if not (r.get('warnings') or [])) / len(rows)
    return {
        'context_recall': _bounded_metric('context_recall', context_recall),
        'context_precision': _bounded_metric('context_precision', context_precision),
        'citation_correctness': _bounded_metric('citation_correctness', citation_correctness),
        'structured_relation_questions': sum(1 for r in rows if r.get('question_type') == 'structured_relation'),
        'human_global_questions': sum(1 for r in rows if r.get('question_type') == 'human_global'),
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
        f'- human_global_questions: {summary.get("human_global_questions", 0)}',
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
    parser.add_argument('--human-global-cases', type=Path, default=None,
                        help='Optional human-authored multi-claim global eval fixture JSON. Use "default" for the bundled Changwon fixture.')
    parser.add_argument('--only-human-global-cases', action='store_true',
                        help='Evaluate only the human-authored global fixture, without generated per-claim questions.')
    args = parser.parse_args()
    ensure_eval_python(args.brain_root)

    db_path = args.brain_root / 'db' / 'consulting.db'
    human_cases_arg = args.human_global_cases or (Path('default') if args.only_human_global_cases else None)
    human_cases_path = DEFAULT_HUMAN_GLOBAL_CASES if human_cases_arg and str(human_cases_arg) == 'default' else human_cases_arg
    questions = [] if args.only_human_global_cases else build_questions(db_path, args.topic)
    if human_cases_path:
        questions.extend(load_human_global_cases(human_cases_path, topic=args.topic))
    if len(questions) < 40 and not args.only_human_global_cases:
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
    if args.rerank:
        os.environ.setdefault('CONSULTING_RERANKER_KEEP_LOADED', '1')
    if args.raw_weight is not None:
        os.environ['CONSULTING_RECALL_RAW_WEIGHT'] = str(args.raw_weight)

    rows = []
    for q in questions:
        result, latency, err = run_recall(args.brain_root, args.topic, q['query'], top_k=args.top_k, rerank=args.rerank, timeout=args.timeout_s)
        ok = bool(result.get('ok'))
        expected_claims = expected_claims_for_row(q)
        hit = hit_expected_claims(result, expected_claims)
        rows.append({
            'id': q['id'],
            'query': q['query'],
            'expected': q.get('expected') or (expected_claims[0] if expected_claims else None),
            'expected_claims': expected_claims,
            'ok': ok,
            'hit': hit,
            'latency_s': round(latency, 4),
            'rerank': result.get('rerank'),
            'rerank_error': result.get('rerank_error'),
            'signals': result.get('signals') or {},
            'retrieved_claims': retrieved_claims(result),
            'warnings': validate_signal_breakdown(result),
            'question_type': q.get('question_type', 'claim_lookup'),
            **({'human_authored': True, 'rationale': q.get('rationale')} if q.get('human_authored') else {}),
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
            'human_global_cases': (str(human_cases_path) if human_cases_path else None),
            'only_human_global_cases': bool(args.only_human_global_cases),
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
