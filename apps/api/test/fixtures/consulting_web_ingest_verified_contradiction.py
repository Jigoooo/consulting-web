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
    con.commit()
    con.close()

    web.I._contextualize = lambda raw, topic_title, recent: f'[{topic_title}] fixture scope\n{raw}'
    writes: list[dict] = []
    web.S.upsert_verified_contradiction = lambda _con, **kwargs: writes.append(kwargs) or {'ok': True, 'edge_id': 1}

    payload = {
        'consultingTopicSlug': 'fixture-topic',
        'sessionId': 'consulting-web-thread:test-thread',
        'userText': '정원 검토해줘',
        'allowedSegments': [{'kind': 'user', 'text': '정원 검토해줘'}],
        'assistantCandidate': {
            'kind': 'assistant',
            'text': '기본급은 2,100,000원이다.',
            'status': 'quarantined',
        },
        'verifiedContradictions': [{
            'verdictRef': 'assistant:message-1:MSG-1',
            'claimId': 'MSG-1',
            'claimText': '기본급은 2,100,000원이다.',
            'verdict': 'refutes',
            'confidence': 0.91,
            'rationale': '공식 표와 다름',
            'evidenceItemId': 'evidence-1',
            'evidenceRef': 'EV-PAY-01',
            'evidenceText': '공식 표의 기본급은 2,000,000원이다.',
        }],
        'scopePath': 'fixture/project/topic/thread',
        'workspaceId': 'ws',
        'projectId': 'project',
        'channelId': 'channel',
        'topicId': 'topic',
        'threadId': 'thread',
        'assistantMessageId': 'message-1',
        'timestamp': 1770000000,
    }

    out = web.ingest_turn(dict(payload), no_embed=True)
    assert out['ok'] is True, out
    assert len(writes) == 1, writes
    write = writes[0]
    assert write['from_claim_code'].startswith('WEB-CLAIM-'), write
    assert write['to_claim_code'].startswith('WEB-EVID-'), write
    assert write['edge_key'].startswith('web-verdict:'), write
    assert write['source_ref'] == 'assistant:message-1:MSG-1', write
    assert write['metadata']['verdict'] == 'refutes', write
    assert write['metadata']['confidence'] == 0.91, write

    verify = sqlite3.connect(db_path)
    raw_text = verify.execute('SELECT raw_text FROM dialogue_chunks').fetchone()[0]
    verify.close()
    assert '정원 검토해줘' in raw_text
    assert '2,100,000' not in raw_text
    assert '2,000,000' not in raw_text

    duplicate = web.ingest_turn(dict(payload), no_embed=True)
    assert duplicate.get('duplicate') is True, duplicate
    assert len(writes) == 2, writes
    assert writes[0]['edge_key'] == writes[1]['edge_key'], writes

print('verified contradiction fixture OK')
