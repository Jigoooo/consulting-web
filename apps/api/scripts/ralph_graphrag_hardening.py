#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRAIN_ROOT = Path('/home/jigoo/.hermes/workspace/consulting')
API_TESTS = [
    'test/consulting-web-ingest-outbox.test.ts',
    'test/consulting-web-ingest-worker.test.ts',
    'test/consulting-web-ingest-python.test.ts',
    'test/consulting-memory-context.builder.test.ts',
    'test/evidence-sufficiency-evaluator.test.ts',
    'test/citation-post-check.service.test.ts',
    'test/outbox-relay-options.test.ts',
    'test/outbox-relay-lifecycle.test.ts',
    'test/consulting-graphrag-bridge-advanced.test.ts',
    'test/consulting-graphrag-bridge.test.ts',
]
BRAIN_TESTS = [
    str(BRAIN_ROOT / 'scripts/tests/test_dialogue_memory_graph_terms.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_cross_topic_links_persist.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_dialogue_memory_embedding_degradation.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_advanced_graphrag_write_guard.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_raptor_summary_layer.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_community_report_layer.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_tog2_deep_layer.py'),
    str(BRAIN_ROOT / 'scripts/tests/test_dialogue_memory_tog2_deep.py'),
]


def run(cmd: list[str], *, timeout: int, cwd: Path = ROOT) -> dict:
    start = time.perf_counter()
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    return {
        'cmd': cmd,
        'cwd': str(cwd),
        'exit_code': proc.returncode,
        'latency_s': round(time.perf_counter() - start, 3),
        'output_tail': proc.stdout[-4000:],
    }


def assert_static_contracts() -> list[str]:
    failures: list[str] = []
    bridge = (ROOT / 'apps/api/src/consulting/consulting-graphrag-bridge.service.ts').read_text(encoding='utf-8')
    context_builder = (ROOT / 'apps/api/src/consulting/consulting-memory-context.builder.ts').read_text(encoding='utf-8')
    controller = (ROOT / 'apps/api/src/chat/chat-stream.controller.ts').read_text(encoding='utf-8')
    dockerfile = (ROOT / 'apps/api/Dockerfile').read_text(encoding='utf-8')
    req = (ROOT / 'apps/api/requirements-graphrag.txt').read_text(encoding='utf-8')
    brain_search = (BRAIN_ROOT / 'scripts/dialogue_memory/search.py').read_text(encoding='utf-8')
    brain_phase3 = (BRAIN_ROOT / 'scripts/consulting_phase3_os.py').read_text(encoding='utf-8')
    brain_advanced_guard = (BRAIN_ROOT / 'scripts/advanced_graphrag_write_guard.py').read_text(encoding='utf-8')
    brain_advanced_layers = (BRAIN_ROOT / 'scripts/advanced_graphrag_layers.py').read_text(encoding='utf-8')

    forbidden = [
        ('bridge must not force --no-rerank', '--no-rerank', bridge),
        ('bridge must not keep 5s timeout', 'timeout: 5_000', bridge),
        ('controller must not fire-and-forget web ingest', 'void this.webIngest', controller),
        ('memory context must not use single-topic recall directly', 'this.bridge.recall({ topicSlug:', context_builder),
    ]
    for label, needle, haystack in forbidden:
        if needle in haystack:
            failures.append(label)
    if re.search(r'catch\s*\{\s*\}', controller):
        failures.append('controller has empty catch block')
    for needle in ['node:22-bookworm-slim', 'python:3.12-slim-bookworm']:
        if needle not in dockerfile:
            failures.append(f'Dockerfile missing {needle}')
    for needle in ['onnxruntime', 'sentence-transformers', 'google-generativeai', 'torch==2.5.1+cpu']:
        if needle not in req:
            failures.append(f'GraphRAG requirements missing {needle}')
    if '_term_set(query)' not in brain_search:
        failures.append('consulting brain graph search missing normalized term matching')
    if 'degraded_signals' not in brain_search or '_degradation_error' not in brain_search:
        failures.append('consulting brain recall missing embedding degradation observability')
    if 'tog2_deep' not in brain_search or 'search_tog2_deep' not in brain_search:
        failures.append('consulting brain recall missing ToG-2 deep signal integration')
    if 'insert into cross_topic_links' not in brain_phase3:
        failures.append('consulting brain cross-topic suggestions are not persisted')
    for needle in ['CONSULTING_ADVANCED_GRAPHRAG_WRITE_APPROVED', 'CONSULTING_ADVANCED_GRAPHRAG_DEPS_APPROVED', 'source_chunk_ids']:
        if needle not in brain_advanced_guard:
            failures.append(f'advanced GraphRAG write guard missing {needle}')
    for needle in ['write_raptor_summaries', 'write_community_reports', 'search_tog2_deep', 'source_chunk_ids', 'connected_components_no_dep']:
        if needle not in brain_advanced_layers:
            failures.append(f'advanced GraphRAG layer missing {needle}')
    return failures


def brain_db_contracts() -> dict:
    db = Path('/home/jigoo/.hermes/workspace/consulting/db/consulting.db')
    if not db.exists():
        return {'ok': False, 'error': f'missing {db}'}
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    try:
        failed_embeddings = con.execute("""
            SELECT COUNT(*) AS c
            FROM dialogue_chunks
            WHERE source='consulting-web'
              AND embed_dim=0
              AND (embed_model IS NULL OR embed_model LIKE 'embedding_failed:%')
        """).fetchone()['c']
        fts_orphans = con.execute("""
            SELECT COUNT(*) AS c
            FROM dialogue_chunks dc
            LEFT JOIN dialogue_chunks_fts fts ON fts.rowid=dc.id
            WHERE fts.rowid IS NULL
        """).fetchone()['c']
        claims = con.execute("""
            SELECT COUNT(*) AS c
            FROM claims c JOIN topics t ON t.id=c.topic_id
            WHERE t.slug='changwon-org-mgmt-diagnosis'
        """).fetchone()['c']
        cross_topic_links = con.execute("""
            SELECT COUNT(*) AS c
            FROM cross_topic_links
            WHERE import_status='context_only' AND review_status='pending'
        """).fetchone()['c']
    finally:
        con.close()
    return {
        'ok': failed_embeddings == 0 and fts_orphans == 0 and claims >= 15 and cross_topic_links >= 2,
        'failed_consulting_web_embeddings': failed_embeddings,
        'dialogue_fts_orphans': fts_orphans,
        'changwon_claims': claims,
        'context_only_cross_topic_links': cross_topic_links,
    }


def docker_runtime_probe() -> dict:
    cmd = [
        'docker', 'run', '--rm',
        '-e', 'CONSULTING_BRAIN_ROOT=/brain/consulting',
        '-e', 'HERMES_ENV_FILE=/brain/hermes.env',
        '-e', 'CONSULTING_EMBED_FAKE=1',
        '-e', 'CONSULTING_RERANK_PRUNE=4',
        '-v', '/home/jigoo/.hermes/workspace/consulting:/brain/consulting',
        '-v', '/home/jigoo/.hermes/.env:/brain/hermes.env:ro',
        'consulting-web-api:latest',
        'sh', '-lc',
        "python3 - <<'PY'\nimport numpy, onnxruntime, sentence_transformers, google.generativeai, torch, tokenizers\nprint('imports-ok')\nPY\ncd /brain/consulting && python3 scripts/dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis --q '정원 인건비 조직진단' --top-k 2 --format json --rerank | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get(\"rerank\")==\"cross-encoder\", j; assert not j.get(\"rerank_error\"), j; h=(j.get(\"hits\") or [{}])[0]; assert \"signal_breakdown\" in h, h; print(json.dumps({\"rerank\":j.get(\"rerank\"),\"hits\":len(j.get(\"hits\") or [])}, ensure_ascii=False))'"
    ]
    return run(cmd, timeout=300)


def main() -> None:
    parser = argparse.ArgumentParser(description='Ralph-like repeated hardening gate for consulting GraphRAG bridge')
    parser.add_argument('--iterations', type=int, default=3)
    parser.add_argument('--output', type=Path, default=Path('artifacts/ralph-graphrag-hardening.json'))
    parser.add_argument('--skip-docker', action='store_true')
    args = parser.parse_args()

    all_runs = []
    overall_ok = True
    for i in range(1, args.iterations + 1):
        iteration: dict = {'iteration': i, 'checks': []}
        static_failures = assert_static_contracts()
        db_contract = brain_db_contracts()
        iteration['static_failures'] = static_failures
        iteration['brain_db'] = db_contract
        if static_failures or not db_contract.get('ok'):
            overall_ok = False

        checks = [
            ['pnpm', '--filter', '@consulting/api', 'exec', 'vitest', 'run', *API_TESTS, '--reporter=dot'],
            [str(BRAIN_ROOT / '.venv/bin/python3'), '-m', 'pytest', *BRAIN_TESTS, '-q'],
            ['pnpm', '--filter', '@consulting/api', 'typecheck'],
            ['pnpm', '--filter', '@consulting/api', 'test:graphrag'],
        ]
        for cmd in checks:
            result = run(cmd, timeout=600)
            iteration['checks'].append(result)
            if result['exit_code'] != 0:
                overall_ok = False
        if i == 1 and not args.skip_docker:
            result = docker_runtime_probe()
            iteration['checks'].append(result)
            if result['exit_code'] != 0:
                overall_ok = False
        all_runs.append(iteration)

    out = {
        'ok': overall_ok,
        'iterations': args.iterations,
        'runs': all_runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'ok': overall_ok, 'iterations': args.iterations, 'output': str(args.output)}, ensure_ascii=False, indent=2))
    if not overall_ok:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
