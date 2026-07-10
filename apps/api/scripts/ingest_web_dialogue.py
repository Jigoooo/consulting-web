#!/usr/bin/env python3
"""Ingest one consulting-web chat turn into the shared consulting brain GraphRAG store.

Input JSON is read from stdin. This keeps Postgres/web concerns in NestJS and lets this
small bridge reuse the consulting brain dialogue_memory modules for contextualization, embeddings,
claim/evidence edge extraction, and FTS triggers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_CONSULTING_ROOT = '/brain/consulting' if Path('/brain/consulting').exists() else '/home/jigoo/.hermes/workspace/consulting'
CONSULTING_ROOT = Path(os.environ.get('CONSULTING_BRAIN_ROOT', DEFAULT_CONSULTING_ROOT))
os.environ.setdefault('CONSULTING_BRAIN_WRITE_BACKEND', 'pg')
os.environ.setdefault('CONSULTING_BRAIN_BACKEND', 'pg')
DIALOGUE_MEMORY = CONSULTING_ROOT / 'scripts' / 'dialogue_memory'
if str(DIALOGUE_MEMORY) not in sys.path:
    sys.path.insert(0, str(DIALOGUE_MEMORY))

import store as S  # type: ignore  # noqa: E402
import embeddings as E  # type: ignore  # noqa: E402
import ingest as I  # type: ignore  # noqa: E402

SCOPES_DDL = """
CREATE TABLE IF NOT EXISTS dialogue_session_scopes (
  topic_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'consulting-web',
  workspace_id TEXT,
  project_id TEXT,
  channel_id TEXT,
  web_topic_id TEXT,
  thread_id TEXT,
  scope_path TEXT NOT NULL DEFAULT '',
  bound_at TEXT NOT NULL,
  PRIMARY KEY(topic_id, session_id)
);
"""


def _require_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'missing required string: {key}')
    return value.strip()


def _optional_str(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _allowed_segments(data: dict[str, Any]) -> list[tuple[str, str]]:
    """Return only memory-approved text segments.

    P0 Memory Write Guard: assistant output is a quarantine candidate, not a
    shared-brain fact. Older pending outbox rows may still carry top-level
    assistantText, but this bridge must never ingest that field.
    """
    out: list[tuple[str, str]] = []
    raw_segments = data.get('allowedSegments')
    if isinstance(raw_segments, list):
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            kind = item.get('kind')
            text = item.get('text')
            if kind in {'user', 'document', 'tool'} and isinstance(text, str) and text.strip():
                out.append((str(kind), text.strip()))
    if out:
        return out
    user_text = _require_str(data, 'userText')
    return [('user', user_text)]


def _segment_label(kind: str) -> str:
    return {'user': '사용자', 'document': '문서', 'tool': '도구'}.get(kind, kind)


def _write_scope(con: sqlite3.Connection | None, tid: int, data: dict[str, Any], session_id: str) -> None:
    if S.resolve_write_backend() == 'pg':
        return
    assert con is not None
    con.executescript(SCOPES_DDL)
    con.execute(
        """
        INSERT INTO dialogue_session_scopes(
          topic_id, session_id, source, workspace_id, project_id, channel_id, web_topic_id, thread_id, scope_path, bound_at
        ) VALUES (?, ?, 'consulting-web', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(topic_id, session_id) DO UPDATE SET
          workspace_id=excluded.workspace_id,
          project_id=excluded.project_id,
          channel_id=excluded.channel_id,
          web_topic_id=excluded.web_topic_id,
          thread_id=excluded.thread_id,
          scope_path=excluded.scope_path,
          bound_at=excluded.bound_at
        """,
        (
            tid,
            session_id,
            _optional_str(data, 'workspaceId'),
            _optional_str(data, 'projectId'),
            _optional_str(data, 'channelId'),
            _optional_str(data, 'topicId'),
            _optional_str(data, 'threadId'),
            _optional_str(data, 'scopePath') or '',
            S.now(),
        ),
    )


def _topic_title_seed(data: dict[str, Any], topic_slug: str) -> str:
    """Human-readable creation title for auto-provisioned brain topics.

    scopePath comes from ConsultingTopicResolver as `프로젝트 / 채널 / 토픽 [/ 스레드]`;
    the first segment (project display name) is the best creation-time title.
    """
    scope_path = _optional_str(data, 'scopePath')
    if scope_path:
        first = scope_path.split('/')[0].strip()
        if first:
            return first
    return topic_slug


def _verified_contradictions(data: dict[str, Any]) -> list[dict[str, Any]]:
    raw = data.get('verifiedContradictions')
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError('verifiedContradictions must be a list')
    out: list[dict[str, Any]] = []
    string_fields = (
        'verdictRef', 'claimId', 'claimText', 'rationale',
        'evidenceItemId', 'evidenceRef', 'evidenceText',
    )
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError('verified contradiction must be an object')
        normalized: dict[str, Any] = {}
        for field in string_fields:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f'verified contradiction missing {field}')
            normalized[field] = value.strip()
        verdict = item.get('verdict')
        confidence = item.get('confidence')
        if verdict not in {'refutes', 'mixed'}:
            raise ValueError('verified contradiction verdict must be refutes or mixed')
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
            raise ValueError('verified contradiction confidence must be between 0 and 1')
        normalized['verdict'] = verdict
        normalized['confidence'] = float(confidence)
        out.append(normalized)
    return out


def _stable_ref(prefix: str, seed: str, size: int = 16) -> str:
    digest = hashlib.sha256(seed.encode('utf-8')).hexdigest()[:size].upper()
    return f'{prefix}-{digest}'


def _write_verified_contradictions(
    con: sqlite3.Connection | None,
    *,
    tid: int,
    topic_slug: str,
    data: dict[str, Any],
    timestamp: float,
) -> int:
    items = _verified_contradictions(data)
    if not items:
        return 0
    assistant_message_id = _require_str(data, 'assistantMessageId')
    observed_at = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    for item in items:
        source_ref = item['verdictRef']
        from_code = _stable_ref('WEB-CLAIM', f"{topic_slug}|{assistant_message_id}|{item['claimId']}")
        to_code = _stable_ref('WEB-EVID', f"{topic_slug}|{item['evidenceItemId']}")
        edge_hash = hashlib.sha256(f'{topic_slug}|{source_ref}'.encode('utf-8')).hexdigest()[:24]
        S.upsert_verified_contradiction(
            con,
            tid=tid,
            from_claim_code=from_code,
            from_claim_text=item['claimText'],
            to_claim_code=to_code,
            to_claim_text=item['evidenceText'],
            edge_key=f'web-verdict:{edge_hash}',
            source_ref=source_ref,
            logic_note=item['rationale'],
            metadata={
                'source': 'consulting-web-claim-verifier',
                'workspaceId': _optional_str(data, 'workspaceId'),
                'threadId': _optional_str(data, 'threadId'),
                'assistantMessageId': assistant_message_id,
                'claimId': item['claimId'],
                'evidenceItemId': item['evidenceItemId'],
                'evidenceRef': item['evidenceRef'],
                'verdict': item['verdict'],
                'confidence': item['confidence'],
            },
            observed_at=observed_at,
        )
    return len(items)


def ingest_turn(data: dict[str, Any], *, no_embed: bool = False) -> dict[str, Any]:
    topic_slug = _require_str(data, 'consultingTopicSlug')
    session_id = _require_str(data, 'sessionId')
    segments = _allowed_segments(data)
    scope_path = _optional_str(data, 'scopePath') or topic_slug
    ts = float(data.get('timestamp') or time.time())
    raw = "\n".join(f"{_segment_label(kind)}: {text}" for kind, text in segments)
    content_hash = hashlib.sha256((topic_slug + '|consulting-web|' + session_id + '|' + raw).encode('utf-8')).hexdigest()[:24]
    assistant_quarantined = isinstance(data.get('assistantCandidate'), dict)

    con = S.connect_optional()
    main = None
    if S.resolve_write_backend() != 'pg':
        main = sqlite3.connect(S.DB)
        main.row_factory = sqlite3.Row
    try:
        # P1: a new web project has a consulting_topic_links row but no brain topic
        # yet — auto-provision it here so the first turn ingests instead of dying
        # with `unknown topic` (idempotent; existing topics are returned as-is).
        tid = S.ensure_topic(
            con,
            topic_slug,
            title=_topic_title_seed(data, topic_slug),
            description=f'consulting-web auto-provisioned ({scope_path})',
        )
        _write_scope(con, tid, data, session_id)
        S.bind_session(con, tid, session_id)
        contradiction_count = _write_verified_contradictions(
            con,
            tid=tid,
            topic_slug=topic_slug,
            data=data,
            timestamp=ts,
        )
        if S.chunk_exists(con, content_hash):
            S.commit_optional(con)
            return {
                "ok": True,
                "topic": topic_slug,
                "ingested": 0,
                "duplicate": True,
                "verified_contradictions": contradiction_count,
                **S.stats(con, tid),
            }

        topic_title = S.topic_title(con, tid, topic_slug)
        if no_embed:
            context_text = f"[{topic_title}] {scope_path}\n{raw}"
        else:
            context_text = I._contextualize(raw, topic_title, [scope_path])
        entities, edges = I._extract_entities(main, tid, raw + ' ' + context_text)
        embed_model = 'none' if no_embed else E._MODEL
        if no_embed:
            embedding = []
        else:
            try:
                embedding = E.embed_one(context_text)
            except Exception as exc:  # noqa: BLE001
                # H8 fail-open: a transient Gemini/embedding outage must not erase the
                # web turn. Store the chunk without a vector so FTS + graph recall still
                # work, and make the missing vector observable for later backfill.
                embedding = []
                embed_model = f'embedding_failed:{E._MODEL}'
                sys.stderr.write(
                    f"[consulting-web-ingest] embedding failed; stored FTS-only chunk for retry/backfill: {type(exc).__name__}: {exc}\n"
                )
        cid = S.insert_chunk(
            con,
            tid=tid,
            content_hash=content_hash,
            source='consulting-web',
            session_id=session_id,
            ts=ts,
            role_mix='+'.join(kind for kind, _ in segments),
            raw_text=raw,
            context_text=context_text,
            entities=entities,
            embedding=embedding,
            embed_model=embed_model,
        )
        for target_type, target_ref in edges:
            S.add_edge(
                con,
                tid=tid,
                chunk_id=cid,
                target_type=target_type,
                target_ref=target_ref,
                relation='about' if target_type == 'claim' else 'mentions',
            )
        S.set_checkpoint(con, tid, 'consulting-web', ts)
        S.commit_optional(con)
        return {"ok": True, "topic": topic_slug, "ingested": 1, "chunk_id": cid,
                "allowed_segments": len(segments), "assistant_quarantined": assistant_quarantined,
                "verified_contradictions": contradiction_count,
                **S.stats(con, tid)}
    finally:
        if main is not None:
            main.close()
        if con is not None:
            con.close()


def backfill_missing_embeddings(topic_slug: str, *, limit: int = 100) -> dict[str, Any]:
    """Fill vectors for legacy SQLite consulting-web chunks after an outage.

    PG-only runtime writes new web turns straight to PostgreSQL. The old SQLite
    backfill path is intentionally disabled there so this maintenance command
    cannot keep consulting.db as a hidden write dependency.
    """
    con = S.connect_optional()
    try:
        tid = S.topic_id(con, topic_slug)
        if S.resolve_write_backend() == 'pg':
            return {"ok": True, "topic": topic_slug, "scanned": 0, "updated": 0, "failed": 0,
                    "note": "pg-only runtime: SQLite embedding backfill is disabled", **S.stats(con, tid)}
        assert con is not None
        rows = con.execute(
            """
            SELECT id, context_text
            FROM dialogue_chunks
            WHERE topic_id=?
              AND source='consulting-web'
              AND embed_dim=0
              AND (embed_model IS NULL OR embed_model LIKE 'embedding_failed:%')
            ORDER BY id
            LIMIT ?
            """,
            (tid, max(1, limit)),
        ).fetchall()
        updated = 0
        failed = 0
        for row in rows:
            try:
                vec = E.embed_one(row['context_text'])
                con.execute(
                    "UPDATE dialogue_chunks SET embedding=?, embed_dim=?, embed_model=? WHERE id=?",
                    (S.pack_vec(vec), len(vec), E._MODEL, row['id']),
                )
                updated += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                sys.stderr.write(
                    f"[consulting-web-ingest] embedding backfill failed for chunk {row['id']}: {type(exc).__name__}: {exc}\n"
                )
        con.commit()
        return {"ok": True, "topic": topic_slug, "scanned": len(rows), "updated": updated, "failed": failed, **S.stats(con, tid)}
    finally:
        if con is not None:
            con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='consulting-web turn → existing consulting.db GraphRAG')
    parser.add_argument('--no-embed', action='store_true')
    parser.add_argument('--backfill-missing-embeddings', action='store_true')
    parser.add_argument('--topic')
    parser.add_argument('--limit', type=int, default=100)
    args = parser.parse_args()
    if args.backfill_missing_embeddings:
        if not args.topic:
            raise SystemExit('--topic is required with --backfill-missing-embeddings')
        out = backfill_missing_embeddings(args.topic, limit=args.limit)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    data = json.load(sys.stdin)
    out = ingest_turn(data, no_embed=args.no_embed)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
