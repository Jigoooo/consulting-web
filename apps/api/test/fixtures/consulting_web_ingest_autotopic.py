#!/usr/bin/env python3
"""P1 regression: unknown consulting topic must be auto-provisioned at web-turn ingest.

Before this fix, ingest_turn() died with SystemExit `unknown topic: <slug>` for any
project whose brain topic was never created (every non-Changwon project), so web
turns silently never reached the shared consulting brain.
"""
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
    # Real consulting.db schema subset. NOTE: no topic row is inserted — that is the point.
    con.execute(
        'CREATE TABLE IF NOT EXISTS topics('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, '
        "description TEXT, status TEXT NOT NULL DEFAULT 'active', "
        'discord_channel_id TEXT, workspace_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'
    )
    con.execute('CREATE TABLE IF NOT EXISTS claims(id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, claim_code TEXT, claim_text TEXT)')
    con.execute('CREATE TABLE IF NOT EXISTS evidence_items(id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, item_code TEXT)')
    con.commit()
    con.close()

    web.I._contextualize = lambda raw, topic_title, recent: f'[{topic_title}] fixture scope\n{raw}'
    web.E.embed_one = lambda _text: [0.1, 0.2, 0.3, 0.4]

    payload = {
        'consultingTopicSlug': 'auto-provision-e2e',
        'sessionId': 'consulting-web-thread:autotopic-thread',
        'userText': '신규 프로젝트 첫 질문입니다',
        'allowedSegments': [
            {'kind': 'user', 'text': '신규 프로젝트 첫 질문입니다'},
        ],
        'assistantCandidate': {
            'kind': 'assistant',
            'text': '격리 대상 어시스턴트 답변',
            'status': 'quarantined',
        },
        'scopePath': 'NEW-PROJECT / 자료수집 / 초기자료',
        'workspaceId': 'ws',
        'projectId': 'project',
        'channelId': 'channel',
        'topicId': 'topic',
        'threadId': 'thread',
        'timestamp': 1770000001,
    }

    # 1) Unknown topic must be auto-created, then the turn ingested in the same call.
    out = web.ingest_turn(dict(payload))
    assert out['ok'] is True, out
    assert out['ingested'] == 1, out
    assert out['topic'] == 'auto-provision-e2e', out

    verify = sqlite3.connect(db_path)
    verify.row_factory = sqlite3.Row
    topics = verify.execute('SELECT slug, title, status FROM topics').fetchall()
    assert len(topics) == 1, [dict(t) for t in topics]
    assert topics[0]['slug'] == 'auto-provision-e2e', dict(topics[0])
    assert topics[0]['status'] == 'active', dict(topics[0])
    # Title should be human-readable (project segment of scopePath), not the raw slug.
    assert topics[0]['title'] == 'NEW-PROJECT', dict(topics[0])
    chunk = verify.execute('SELECT source, session_id FROM dialogue_chunks').fetchone()
    assert chunk is not None
    assert chunk['source'] == 'consulting-web'
    verify.close()

    # 2) Idempotent: same turn again → duplicate, and no second topic row.
    out2 = web.ingest_turn(dict(payload))
    assert out2['ok'] is True, out2
    assert out2.get('duplicate') is True, out2

    verify = sqlite3.connect(db_path)
    verify.row_factory = sqlite3.Row
    n_topics = verify.execute('SELECT count(*) AS c FROM topics').fetchone()['c']
    assert n_topics == 1, n_topics
    n_chunks = verify.execute('SELECT count(*) AS c FROM dialogue_chunks').fetchone()['c']
    assert n_chunks == 1, n_chunks
    verify.close()

    # 3) A different turn on the SAME now-existing topic ingests without creating another topic.
    payload3 = dict(payload)
    payload3['userText'] = '두 번째 질문'
    payload3['allowedSegments'] = [{'kind': 'user', 'text': '두 번째 질문'}]
    payload3['timestamp'] = 1770000002
    out3 = web.ingest_turn(payload3)
    assert out3['ok'] is True, out3
    assert out3['ingested'] == 1, out3

    verify = sqlite3.connect(db_path)
    verify.row_factory = sqlite3.Row
    n_topics = verify.execute('SELECT count(*) AS c FROM topics').fetchone()['c']
    assert n_topics == 1, n_topics
    verify.close()

print('autotopic fixture OK')
