#!/usr/bin/env python3
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / 'scripts'
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / 'consulting.db'
    os.environ['CONSULTING_DB'] = str(db_path)
    os.environ['CONSULTING_LOCK_DIR'] = tmp
    os.environ['CONSULTING_BRAIN_WRITE_BACKEND'] = 'sqlite'
    os.environ['CONSULTING_BRAIN_BACKEND'] = 'sqlite'

    import ingest_web_dialogue as web  # noqa: E402

    con = web.S.connect()
    con.execute('CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT)')
    con.execute('CREATE TABLE IF NOT EXISTS claims(id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, claim_code TEXT, claim_text TEXT)')
    con.execute('CREATE TABLE IF NOT EXISTS evidence_items(id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, item_code TEXT)')
    con.execute("INSERT INTO topics(slug, title) VALUES('fixture-topic', 'Fixture Topic')")
    con.execute("INSERT INTO claims(topic_id, claim_code, claim_text) VALUES(1, 'CL-H8-01', '정원 인건비 재정 영향 검토')")
    con.commit()
    con.close()

    web.I._contextualize = lambda raw, topic_title, recent: f'[{topic_title}] fixture scope\n{raw}'

    def fail_embed(_text: str):
        raise RuntimeError('forced embed outage')

    web.E.embed_one = fail_embed

    out = web.ingest_turn({
        'consultingTopicSlug': 'fixture-topic',
        'sessionId': 'consulting-web-thread:test-thread',
        'userText': '정원 검토해줘',
        'assistantText': 'CL-H8-01 기준으로 정원·인건비·재정 영향을 같이 봐야 합니다.',
        'scopePath': 'fixture/project/topic/thread',
        'workspaceId': 'ws',
        'projectId': 'project',
        'channelId': 'channel',
        'topicId': 'topic',
        'threadId': 'thread',
        'timestamp': 1770000000,
    })

    assert out['ok'] is True, out
    assert out['ingested'] == 1, out

    verify = sqlite3.connect(db_path)
    verify.row_factory = sqlite3.Row
    row = verify.execute('SELECT source, embed_dim, embed_model, context_text FROM dialogue_chunks').fetchone()
    assert row is not None
    assert row['source'] == 'consulting-web'
    assert row['embed_dim'] == 0
    assert str(row['embed_model']).startswith('embedding_failed:'), row['embed_model']
    assert '정원' in row['context_text']
    fts_count = verify.execute('SELECT count(*) AS c FROM dialogue_chunks_fts').fetchone()['c']
    assert fts_count == 1, fts_count
    edge = verify.execute('SELECT target_type, target_ref FROM dialogue_edges').fetchone()
    assert edge is not None
    assert edge['target_type'] == 'claim'
    assert edge['target_ref'] == 'CL-H8-01'
    verify.close()

    web.E.embed_one = lambda _text: [0.1, 0.2, 0.3, 0.4]
    backfill = web.backfill_missing_embeddings('fixture-topic', limit=10)
    assert backfill['ok'] is True, backfill
    assert backfill['updated'] == 1, backfill

    verify = sqlite3.connect(db_path)
    verify.row_factory = sqlite3.Row
    row = verify.execute('SELECT embed_dim, embed_model FROM dialogue_chunks').fetchone()
    assert row['embed_dim'] == 4, dict(row)
    assert row['embed_model'] == web.E._MODEL, dict(row)
    verify.close()
