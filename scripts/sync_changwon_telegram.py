#!/usr/bin/env python3
"""Sync Changwon Telegram topic conversations into consulting-web.

Source of truth for "Changwon Telegram conversation" is the consulting dialogue
binding table: consulting.db dialogue_topic_sessions for topic slug
changwon-org-mgmt-diagnosis. That avoids accidentally importing unrelated
Telegram topics while still catching older sessions whose Telegram thread_id was
not recorded in Hermes state.db.

The script is idempotent. Imported source message ids are tracked in Postgres
telegram_message_imports.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(os.environ.get("CONSULTING_WEB_ROOT", "/home/jigoo/.hermes/workspace/consulting-web"))
STATE_DB = Path(os.environ.get("HERMES_STATE_DB", "/home/jigoo/.hermes/state.db"))
CONSULTING_DB = Path(os.environ.get("CONSULTING_DB", "/home/jigoo/.hermes/workspace/consulting/db/consulting.db"))
TOPIC_SLUG = os.environ.get("CHANGWON_TOPIC_SLUG", "changwon-org-mgmt-diagnosis")
WORKSPACE_NAME = os.environ.get("TARGET_WORKSPACE_NAME", "김지우's Workspace")
PROJECT_NAME = os.environ.get("TARGET_PROJECT_NAME", "창원시 컨설팅")
CHANNEL_NAME = os.environ.get("TARGET_CHANNEL_NAME", "텔레그램")
OWNER_EMAIL = os.environ.get("TARGET_OWNER_EMAIL", "jiwook97@gmail.com")


@dataclass(frozen=True)
class SourceMessage:
    source_session_id: str
    source_message_id: int
    role: str
    content: str
    timestamp: float


def sql_literal(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def clean_content(role: str, content: str) -> str:
    text = content.strip()
    if role == "user":
        text = re.sub(r"^\[Emma\]\s*", "", text).strip()
    return text


def bound_sessions() -> list[str]:
    with sqlite3.connect(CONSULTING_DB) as con:
        rows = con.execute(
            """
            SELECT dts.session_id
            FROM dialogue_topic_sessions dts
            JOIN topics t ON t.id = dts.topic_id
            WHERE t.slug = ?
            ORDER BY dts.session_id
            """,
            (TOPIC_SLUG,),
        ).fetchall()
    return [r[0] for r in rows]


def load_messages(session_ids: list[str]) -> list[SourceMessage]:
    if not session_ids:
        return []
    placeholders = ",".join("?" for _ in session_ids)
    with sqlite3.connect(STATE_DB) as con:
        rows = con.execute(
            f"""
            SELECT m.session_id, m.id, m.role, m.content, m.timestamp
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id IN ({placeholders})
              AND s.source = 'telegram'
              AND m.role IN ('user','assistant')
              AND COALESCE(m.active, 1) = 1
              AND m.content IS NOT NULL
              AND trim(m.content) <> ''
            ORDER BY m.timestamp, m.id
            """,
            session_ids,
        ).fetchall()
    out: list[SourceMessage] = []
    for sid, mid, role, content, ts in rows:
        cleaned = clean_content(role, content or "")
        if cleaned:
            out.append(SourceMessage(str(sid), int(mid), str(role), cleaned, float(ts)))
    return out


def build_sql(messages: list[SourceMessage]) -> str:
    header = f"""
BEGIN;
SET LOCAL client_min_messages = warning;
CREATE TABLE IF NOT EXISTS telegram_message_imports (
  source_session_id text NOT NULL,
  source_message_id integer NOT NULL,
  web_message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_session_id, source_message_id)
);

WITH w AS (
  SELECT id AS workspace_id FROM workspaces WHERE name = {sql_literal(WORKSPACE_NAME)} LIMIT 1
), owner AS (
  SELECT id AS user_id FROM users WHERE email = {sql_literal(OWNER_EMAIL)} LIMIT 1
), p AS (
  INSERT INTO projects (workspace_id, name, slug)
  SELECT workspace_id, {sql_literal(PROJECT_NAME)}, 'changwon-consulting' FROM w
  ON CONFLICT ON CONSTRAINT projects_slug_unique DO UPDATE SET name = EXCLUDED.name
  RETURNING id, workspace_id
), c AS (
  INSERT INTO channels (workspace_id, project_id, name, slug)
  SELECT workspace_id, id, {sql_literal(CHANNEL_NAME)}, 'telegram' FROM p
  ON CONFLICT ON CONSTRAINT channels_slug_unique DO UPDATE SET name = EXCLUDED.name
  RETURNING id, workspace_id
), t AS (
  INSERT INTO topics (workspace_id, channel_id, name, slug)
  SELECT workspace_id, id, '대화', 'default-chat' FROM c
  ON CONFLICT ON CONSTRAINT topics_slug_unique DO UPDATE SET name = EXCLUDED.name
  RETURNING id, workspace_id
), existing_thread AS (
  SELECT th.id, th.workspace_id
  FROM threads th
  JOIN t ON t.id = th.topic_id
  WHERE th.title = '대화' AND th.deleted_at IS NULL
  ORDER BY th.created_at
  LIMIT 1
), new_thread AS (
  INSERT INTO threads (workspace_id, topic_id, title)
  SELECT t.workspace_id, t.id, '대화'
  FROM t
  WHERE NOT EXISTS (SELECT 1 FROM existing_thread)
  RETURNING id, workspace_id
), target_thread AS (
  SELECT * FROM existing_thread
  UNION ALL
  SELECT * FROM new_thread
)
SELECT 1;
"""
    stmts = [header]
    for m in messages:
        role = m.role if m.role in {"user", "assistant"} else "assistant"
        author = "(SELECT user_id FROM owner)" if role == "user" else "NULL"
        run_id = f"telegram-sync:{m.source_session_id}:{m.source_message_id}"
        stmts.append(
            f"""
WITH target_thread AS (
  SELECT th.id AS thread_id, th.workspace_id
  FROM workspaces w
  JOIN projects p ON p.workspace_id = w.id AND p.name = {sql_literal(PROJECT_NAME)} AND p.deleted_at IS NULL
  JOIN channels c ON c.project_id = p.id AND c.name = {sql_literal(CHANNEL_NAME)} AND c.deleted_at IS NULL
  JOIN topics t ON t.channel_id = c.id AND t.slug = 'default-chat' AND t.deleted_at IS NULL
  JOIN threads th ON th.topic_id = t.id AND th.title = '대화' AND th.deleted_at IS NULL
  WHERE w.name = {sql_literal(WORKSPACE_NAME)}
  ORDER BY th.created_at
  LIMIT 1
), owner AS (
  SELECT id AS user_id FROM users WHERE email = {sql_literal(OWNER_EMAIL)} LIMIT 1
), ins AS (
  INSERT INTO chat_messages (workspace_id, thread_id, role, author_user_id, content, run_id, finish_state, created_at, updated_at)
  SELECT workspace_id, thread_id, {sql_literal(role)}::chat_role, {author}, {sql_literal(m.content)}, {sql_literal(run_id)}, 'complete', to_timestamp({m.timestamp}), to_timestamp({m.timestamp})
  FROM target_thread
  WHERE NOT EXISTS (
    SELECT 1 FROM telegram_message_imports
    WHERE source_session_id = {sql_literal(m.source_session_id)}
      AND source_message_id = {m.source_message_id}
  )
  RETURNING id
)
INSERT INTO telegram_message_imports (source_session_id, source_message_id, web_message_id)
SELECT {sql_literal(m.source_session_id)}, {m.source_message_id}, id FROM ins
ON CONFLICT DO NOTHING;
"""
        )
    stmts.append("COMMIT;\n")
    stmts.append(
        f"""
SELECT
  COUNT(*) FILTER (WHERE i.imported_at >= now() - interval '5 minutes') AS recently_imported,
  COUNT(*) AS total_imported
FROM telegram_message_imports i
WHERE i.source_session_id IN ({','.join(sql_literal(s) for s in sorted({m.source_session_id for m in messages})) or "NULL"});
"""
    )
    return "\n".join(stmts)


def psql_cmd(*extra: str) -> list[str]:
    return [
        "docker", "compose", "-f", "docker-compose.prod.yml", "--env-file", ".env.docker",
        "exec", "-T", "pg", "psql", "-v", "ON_ERROR_STOP=1", "-U", "consulting", "-d", "consulting",
        *extra,
    ]


def run_psql(sql: str, *, quiet: bool = False) -> int:
    proc = subprocess.run(psql_cmd("-q"), input=sql, text=True, cwd=ROOT, capture_output=True)
    if proc.stdout.strip() and not quiet:
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode


def imported_count(session_ids: list[str]) -> int:
    if not session_ids:
        return 0
    source_list = ",".join(sql_literal(s) for s in sorted(set(session_ids)))
    sql = f"""
    SELECT CASE
      WHEN to_regclass('public.telegram_message_imports') IS NULL THEN 0
      ELSE (SELECT count(*) FROM telegram_message_imports WHERE source_session_id IN ({source_list}))
    END;
    """
    proc = subprocess.run(psql_cmd("-q", "-t", "-A"), input=sql, text=True, cwd=ROOT, capture_output=True)
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        return 0
    return int((proc.stdout.strip() or "0").splitlines()[-1])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="Only print when new messages are imported or errors occur")
    args = parser.parse_args()

    sessions = bound_sessions()
    messages = load_messages(sessions)
    if args.dry_run:
        print(f"bound_sessions={len(sessions)} candidate_messages={len(messages)}")
        for m in messages[:5]:
            print(m.source_session_id, m.source_message_id, m.role, m.content[:90].replace("\n", " "))
        return 0

    before = imported_count(sessions)
    sql = build_sql(messages)
    rc = run_psql(sql, quiet=args.quiet)
    after = imported_count(sessions) if rc == 0 else before
    delta = after - before
    if rc == 0 and (not args.quiet or delta > 0):
        print(f"sync_ok bound_sessions={len(sessions)} candidate_messages={len(messages)} imported_delta={delta} total_imported={after}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
