#!/usr/bin/env python3
"""Sync Changwon Telegram topic conversations into consulting-web.

Source of truth for "Changwon Telegram conversation" is the consulting dialogue
binding table: brain_raw.dialogue_topic_sessions for the legacy Changwon namespace
plus the six exact Telegram topic namespaces. This preserves old sessions without
forcing new topic conversations back into one broad evidence namespace.

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
BRAIN_SESSION_BACKEND = os.environ.get("CHANGWON_SYNC_BOUND_SESSION_BACKEND", "pg").strip().lower()
BRAIN_PG_CONTAINER = os.environ.get("CONSULTING_PG18_CONTAINER", "consulting-web-pg18-rehearsal-pg18-1")
LEGACY_TOPIC_SLUG = os.environ.get("CHANGWON_TOPIC_SLUG", "changwon-org-mgmt-diagnosis")
DEFAULT_EXACT_TOPIC_SLUGS = (
    "changwon-consulting",
    "changwon-pay-system",
    "changwon-tenure-promotion",
    "changwon-agency-business",
    "changwon-budget-standards",
    "changwon-general-review",
)
_configured_topic_slugs = tuple(
    item.strip()
    for item in os.environ.get("CHANGWON_TOPIC_SLUGS", "").split(",")
    if item.strip()
)
SOURCE_TOPIC_SLUGS = tuple(dict.fromkeys(
    _configured_topic_slugs or (LEGACY_TOPIC_SLUG, *DEFAULT_EXACT_TOPIC_SLUGS)
))
WORKSPACE_NAME = os.environ.get("TARGET_WORKSPACE_NAME", "김지우's Workspace")
PROJECT_ID = os.environ.get("TARGET_PROJECT_ID", "01fba1a5-7b16-4267-93df-f9ca6cf0462f")
PROJECT_NAME = os.environ.get("TARGET_PROJECT_NAME", "창원시 컨설팅")
CHANNEL_NAME = os.environ.get("TARGET_CHANNEL_NAME", "텔레그램")
OWNER_EMAIL = os.environ.get("TARGET_OWNER_EMAIL", "jiwook97@gmail.com")
APPROVED_CHAT_ID = os.environ.get("CHANGWON_TELEGRAM_CHAT_ID", "-1004453868195")
GENERAL_THREAD_ID = "1"
ROUTING_VERSION = "v3-exact-topic-v1"
TELEGRAM_MEMORY_PREFIX = "consulting:changwon-org-mgmt-diagnosis#telegram"
EXPECTED_ROUTE_REGISTRY = (
    ("1", "changwon-general-review", "general-review-required", "일반/검토필요", f"{TELEGRAM_MEMORY_PREFIX}/general"),
    ("12", "changwon-consulting", "changwon-consulting", "창원-컨설팅", f"{TELEGRAM_MEMORY_PREFIX}/changwon-consulting"),
    ("356", "changwon-agency-business", "changwon-agency-business", "창원_대행사업", f"{TELEGRAM_MEMORY_PREFIX}/changwon-agency-business"),
    ("524", "changwon-pay-system", "changwon-pay-system", "창원_보수체계", f"{TELEGRAM_MEMORY_PREFIX}/changwon-pay-system"),
    ("533", "changwon-tenure-promotion", "changwon-tenure-promotion", "창원_근속승진", f"{TELEGRAM_MEMORY_PREFIX}/changwon-tenure-promotion"),
    ("1060", "changwon-budget-standards", "changwon-budget-standards", "창원_예산편성기준", f"{TELEGRAM_MEMORY_PREFIX}/changwon-budget-standards"),
)


@dataclass(frozen=True)
class SourceMessage:
    source_session_id: str
    source_message_id: int
    telegram_chat_id: str | None
    telegram_thread_id: str | None
    role: str
    content: str
    timestamp: float


@dataclass(frozen=True)
class RouteTarget:
    telegram_chat_id: str
    telegram_thread_id: str
    target_thread_id: str
    active: bool


@dataclass(frozen=True)
class RoutingDecision:
    route_kind: str
    target_thread_id: str | None = None
    blocked_reason: str | None = None


@dataclass(frozen=True)
class RoutedMessage:
    source: SourceMessage
    target_thread_id: str
    route_kind: str


def sql_literal(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def clean_content(role: str, content: str) -> str:
    text = content.strip()
    if role == "user":
        text = re.sub(r"^\[Emma\]\s*", "", text).strip()
    return text


def brain_psql(sql: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "docker", "exec", "-i", BRAIN_PG_CONTAINER, "sh", "-lc",
            'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAtX -v ON_ERROR_STOP=1',
        ],
        input=sql,
        text=True,
        capture_output=True,
    )


def bound_sessions_pg() -> list[str]:
    source_slugs = ",".join(sql_literal(slug) for slug in SOURCE_TOPIC_SLUGS)
    sql = f"""
    SELECT DISTINCT dts.session_id
    FROM brain_raw.dialogue_topic_sessions dts
    JOIN brain_raw.topics t ON t.id = dts.topic_id
    WHERE t.slug IN ({source_slugs})
    ORDER BY dts.session_id;
    """
    proc = brain_psql(sql)
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        raise SystemExit(proc.returncode)
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def bound_sessions_sqlite() -> list[str]:
    placeholders = ",".join("?" for _ in SOURCE_TOPIC_SLUGS)
    with sqlite3.connect(CONSULTING_DB) as con:
        rows = con.execute(
            f"""
            SELECT DISTINCT dts.session_id
            FROM dialogue_topic_sessions dts
            JOIN topics t ON t.id = dts.topic_id
            WHERE t.slug IN ({placeholders})
            ORDER BY dts.session_id
            """,
            SOURCE_TOPIC_SLUGS,
        ).fetchall()
    return [r[0] for r in rows]


def bound_sessions() -> list[str]:
    if BRAIN_SESSION_BACKEND == "pg":
        return bound_sessions_pg()
    if BRAIN_SESSION_BACKEND == "sqlite":
        return bound_sessions_sqlite()
    raise SystemExit("CHANGWON_SYNC_BOUND_SESSION_BACKEND must be pg|sqlite")


def load_messages(session_ids: list[str]) -> list[SourceMessage]:
    if not session_ids:
        return []
    placeholders = ",".join("?" for _ in session_ids)
    with sqlite3.connect(STATE_DB) as con:
        rows = con.execute(
            f"""
            SELECT m.session_id, m.id, s.chat_id, s.thread_id,
                   m.role, m.content, m.timestamp
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
    for sid, mid, chat_id, thread_id, role, content, ts in rows:
        cleaned = clean_content(role, content or "")
        if cleaned:
            out.append(
                SourceMessage(
                    source_session_id=str(sid),
                    source_message_id=int(mid),
                    telegram_chat_id=None if chat_id is None else str(chat_id),
                    telegram_thread_id=None if thread_id is None else str(thread_id),
                    role=str(role),
                    content=cleaned,
                    timestamp=float(ts),
                )
            )
    return out


def select_route(
    message: SourceMessage,
    routes: list[RouteTarget],
    *,
    approved_chat_id: str = APPROVED_CHAT_ID,
) -> RoutingDecision:
    if message.telegram_chat_id != approved_chat_id:
        return RoutingDecision(route_kind="blocked", blocked_reason="foreign_or_unproven_chat")

    by_thread = {
        route.telegram_thread_id: route
        for route in routes
        if route.telegram_chat_id == approved_chat_id
    }
    source_thread_id = message.telegram_thread_id
    if source_thread_id is not None and source_thread_id in by_thread:
        exact = by_thread[source_thread_id]
        if not exact.active:
            reason = (
                "general_target_unavailable"
                if source_thread_id == GENERAL_THREAD_ID
                else "exact_target_inactive"
            )
            return RoutingDecision(route_kind="blocked", blocked_reason=reason)
        return RoutingDecision(
            route_kind="general" if source_thread_id == GENERAL_THREAD_ID else "exact",
            target_thread_id=exact.target_thread_id,
        )

    general = by_thread.get(GENERAL_THREAD_ID)
    if general is None or not general.active:
        return RoutingDecision(route_kind="blocked", blocked_reason="general_target_unavailable")
    return RoutingDecision(route_kind="general", target_thread_id=general.target_thread_id)


def route_messages(
    messages: list[SourceMessage], routes: list[RouteTarget]
) -> tuple[list[RoutedMessage], list[tuple[SourceMessage, RoutingDecision]]]:
    routed: list[RoutedMessage] = []
    blocked: list[tuple[SourceMessage, RoutingDecision]] = []
    for message in messages:
        decision = select_route(message, routes)
        if decision.target_thread_id is None:
            blocked.append((message, decision))
            continue
        routed.append(
            RoutedMessage(
                source=message,
                target_thread_id=decision.target_thread_id,
                route_kind=decision.route_kind,
            )
        )
    return routed, blocked


def build_sql(messages: list[RoutedMessage]) -> str:
    stmts = [
        "BEGIN ISOLATION LEVEL SERIALIZABLE;\nSET LOCAL client_min_messages = warning;\n"
        "SELECT pg_advisory_xact_lock(hashtextextended('consulting.telegram-sync.v1', 0));\n"
    ]
    user_candidates = [item.source for item in messages if item.source.role == "user"]
    if user_candidates:
        candidate_values = ",\n      ".join(
            f"({sql_literal(message.source_session_id)}, {message.source_message_id})"
            for message in user_candidates
        )
        stmts.append(f"""
DO $owner_guard$
DECLARE owner_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      {candidate_values}
    ) AS candidate(source_session_id, source_message_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM telegram_message_imports imported
      WHERE imported.source_session_id = candidate.source_session_id
        AND imported.source_message_id = candidate.source_message_id
    )
  ) THEN
    SELECT count(*) INTO owner_count FROM (
      SELECT DISTINCT u.id
      FROM users u
      JOIN memberships membership ON membership.user_id = u.id
      JOIN projects project ON project.id = {sql_literal(PROJECT_ID)}::uuid
        AND project.workspace_id = membership.workspace_id
      JOIN workspaces workspace ON workspace.id = project.workspace_id
      WHERE u.email = {sql_literal(OWNER_EMAIL)}
        AND u.status = 'active' AND u.deleted_at IS NULL
        AND membership.scope_type = 'workspace' AND membership.scope_id = workspace.id
        AND workspace.name = {sql_literal(WORKSPACE_NAME)}
        AND workspace.status = 'active' AND workspace.deleted_at IS NULL
        AND project.name = {sql_literal(PROJECT_NAME)}
        AND project.status = 'active' AND project.deleted_at IS NULL
    ) valid_owner;
    IF owner_count <> 1 THEN
      RAISE EXCEPTION 'telegram_sync_owner_membership_invalid';
    END IF;
    PERFORM u.id
    FROM users u
    JOIN memberships membership ON membership.user_id = u.id
    JOIN projects project ON project.id = {sql_literal(PROJECT_ID)}::uuid
      AND project.workspace_id = membership.workspace_id
    JOIN workspaces workspace ON workspace.id = project.workspace_id
    WHERE u.email = {sql_literal(OWNER_EMAIL)}
      AND u.status = 'active' AND u.deleted_at IS NULL
      AND membership.scope_type = 'workspace' AND membership.scope_id = workspace.id
      AND workspace.name = {sql_literal(WORKSPACE_NAME)}
      AND workspace.status = 'active' AND workspace.deleted_at IS NULL
      AND project.name = {sql_literal(PROJECT_NAME)}
      AND project.status = 'active' AND project.deleted_at IS NULL
    FOR SHARE OF u, membership, workspace, project;
  END IF;
END
$owner_guard$;
""")
    registry = {row[0]: row[1:] for row in EXPECTED_ROUTE_REGISTRY}
    fallback_sources = {
        (str(item.source.telegram_chat_id), item.source.telegram_thread_id)
        for item in messages
        if item.route_kind == "general" and item.source.telegram_thread_id != GENERAL_THREAD_ID
    }
    for chat_id, source_thread_id in sorted(fallback_sources, key=lambda item: (item[0], item[1] or "")):
        thread_predicate = (
            "link.telegram_thread_id IS NULL" if source_thread_id is None
            else f"link.telegram_thread_id = {sql_literal(str(source_thread_id))}"
        )
        stmts.append(f"""
DO $fallback_guard$
BEGIN
  PERFORM link.id
  FROM telegram_topic_links link
  WHERE link.telegram_chat_id = {sql_literal(chat_id)}
    AND {thread_predicate}
  FOR SHARE OF link;
  IF FOUND THEN
    RAISE EXCEPTION 'telegram_sync_route_drift';
  END IF;
END
$fallback_guard$;
""")
    guarded_routes: set[tuple[str, str, str, str, str, str, str]] = set()
    for item in messages:
        route_thread_id = item.source.telegram_thread_id if item.route_kind == "exact" else GENERAL_THREAD_ID
        route_contract = registry.get(str(route_thread_id))
        if route_contract is None:
            raise ValueError(f"route registry missing thread {route_thread_id}")
        route_slug, web_topic_slug, thread_title, memory_topic_id = route_contract
        guarded_routes.add((APPROVED_CHAT_ID, str(route_thread_id), route_slug, web_topic_slug, thread_title, memory_topic_id, item.target_thread_id))
    for chat_id, route_thread_id, route_slug, web_topic_slug, thread_title, memory_topic_id, target_thread_id in sorted(guarded_routes):
        stmts.append(f"""
DO $route_guard$
BEGIN
  PERFORM link.id
  FROM telegram_topic_links link
  JOIN workspaces workspace ON workspace.id = link.workspace_id
  JOIN projects project ON project.id = link.project_id AND project.workspace_id = workspace.id
  JOIN channels channel ON channel.id = link.channel_id AND channel.project_id = project.id
    AND channel.workspace_id = workspace.id
  JOIN topics topic ON topic.id = link.web_topic_id AND topic.channel_id = channel.id
    AND topic.workspace_id = workspace.id
  JOIN threads thread ON thread.id = link.thread_id AND thread.topic_id = topic.id
    AND thread.workspace_id = workspace.id
  WHERE link.telegram_chat_id = {sql_literal(chat_id)}
    AND link.telegram_thread_id = {sql_literal(route_thread_id)}
    AND link.consulting_topic_slug = {sql_literal(route_slug)}
    AND link.memory_topic_id = {sql_literal(memory_topic_id)}
    AND link.thread_id = {sql_literal(target_thread_id)}::uuid
    AND link.status = 'active'
    AND project.id = {sql_literal(PROJECT_ID)}::uuid
    AND workspace.name = {sql_literal(WORKSPACE_NAME)}
    AND project.name = {sql_literal(PROJECT_NAME)}
    AND channel.name = {sql_literal(CHANNEL_NAME)}
    AND topic.slug = {sql_literal(web_topic_slug)}
    AND topic.memory_topic_id = {sql_literal(memory_topic_id)}
    AND thread.title = {sql_literal(thread_title)}
    AND workspace.status = 'active' AND workspace.deleted_at IS NULL
    AND project.status = 'active' AND project.deleted_at IS NULL
    AND channel.status = 'active' AND channel.deleted_at IS NULL
    AND topic.status = 'active' AND topic.deleted_at IS NULL
    AND thread.status = 'active' AND thread.deleted_at IS NULL
  FOR SHARE OF link, workspace, project, channel, topic, thread;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telegram_sync_route_drift';
  END IF;
END
$route_guard$;
""")
    for item in messages:
        m = item.source
        role = m.role if m.role in {"user", "assistant"} else "assistant"
        author = "(SELECT user_id FROM owner)" if role == "user" else "NULL"
        run_id = f"telegram-sync:{m.source_session_id}:{m.source_message_id}"
        stmts.append(
            f"""
WITH target_thread AS (
  SELECT th.id AS thread_id, th.workspace_id
  FROM threads th
  JOIN topics t ON t.id = th.topic_id AND t.workspace_id = th.workspace_id
  JOIN channels c ON c.id = t.channel_id AND c.workspace_id = th.workspace_id
  JOIN projects p ON p.id = c.project_id AND p.workspace_id = th.workspace_id
  JOIN workspaces w ON w.id = th.workspace_id
  WHERE th.id = {sql_literal(item.target_thread_id)}::uuid
    AND p.id = {sql_literal(PROJECT_ID)}::uuid
    AND w.name = {sql_literal(WORKSPACE_NAME)}
    AND p.name = {sql_literal(PROJECT_NAME)}
    AND c.name = {sql_literal(CHANNEL_NAME)}
    AND w.status = 'active' AND w.deleted_at IS NULL
    AND p.status = 'active' AND p.deleted_at IS NULL
    AND c.status = 'active' AND c.deleted_at IS NULL
    AND t.status = 'active' AND t.deleted_at IS NULL
    AND th.status = 'active' AND th.deleted_at IS NULL
), owner AS (
  SELECT DISTINCT u.id AS user_id
  FROM users u
  JOIN memberships membership ON membership.user_id = u.id
  JOIN projects project ON project.id = {sql_literal(PROJECT_ID)}::uuid
    AND project.workspace_id = membership.workspace_id
  JOIN workspaces workspace ON workspace.id = project.workspace_id
  WHERE u.email = {sql_literal(OWNER_EMAIL)}
    AND u.status = 'active' AND u.deleted_at IS NULL
    AND membership.scope_type = 'workspace' AND membership.scope_id = workspace.id
    AND workspace.name = {sql_literal(WORKSPACE_NAME)}
    AND workspace.status = 'active' AND workspace.deleted_at IS NULL
    AND project.name = {sql_literal(PROJECT_NAME)}
    AND project.status = 'active' AND project.deleted_at IS NULL
), ins AS (
  INSERT INTO chat_messages (workspace_id, thread_id, role, author_user_id, content, run_id, finish_state, created_at, updated_at)
  SELECT workspace_id, thread_id, {sql_literal(role)}::chat_role, {author}, {sql_literal(m.content)}, {sql_literal(run_id)}, 'complete', to_timestamp({m.timestamp}), to_timestamp({m.timestamp})
  FROM target_thread
  WHERE NOT EXISTS (
    SELECT 1 FROM telegram_message_imports
    WHERE source_session_id = {sql_literal(m.source_session_id)}
      AND source_message_id = {m.source_message_id}
  )
  RETURNING id, thread_id
)
INSERT INTO telegram_message_imports (
  source_session_id,
  source_message_id,
  web_message_id,
  telegram_chat_id,
  telegram_thread_id,
  target_web_thread_id,
  routing_version
)
SELECT
  {sql_literal(m.source_session_id)},
  {m.source_message_id},
  id,
  {sql_literal(m.telegram_chat_id)},
  {sql_literal(m.telegram_thread_id)},
  thread_id,
  {sql_literal(ROUTING_VERSION)}
FROM ins
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
WHERE i.source_session_id IN ({','.join(sql_literal(s) for s in sorted({item.source.source_session_id for item in messages})) or "NULL"});
"""
    )
    return "\n".join(stmts)


def psql_cmd(*extra: str) -> list[str]:
    return [
        "docker", "compose", "-f", "docker-compose.prod.yml", "--env-file", ".env.docker",
        "exec", "-T", "pg", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "consulting", "-d", "consulting",
        *extra,
    ]


def load_route_targets() -> list[RouteTarget]:
    registry_rows = ",\n      ".join(
        f"({sql_literal(APPROVED_CHAT_ID)}, {sql_literal(thread_id)}, {sql_literal(slug)}, {sql_literal(web_slug)}, {sql_literal(title)}, {sql_literal(memory_id)})"
        for thread_id, slug, web_slug, title, memory_id in EXPECTED_ROUTE_REGISTRY
    )
    sql = f"""
    WITH expected(telegram_chat_id, telegram_thread_id, consulting_topic_slug, web_topic_slug, thread_title, memory_topic_id) AS (
      VALUES
      {registry_rows}
    )
    SELECT
      expected.telegram_chat_id,
      expected.telegram_thread_id,
      COALESCE(l.thread_id::text, ''),
      (
        l.status = 'active'
        AND l.thread_id IS NOT NULL
        AND th.id IS NOT NULL
        AND th.topic_id = l.web_topic_id
        AND t.id = l.web_topic_id
        AND t.channel_id = l.channel_id
        AND c.id = l.channel_id
        AND c.project_id = l.project_id
        AND p.id = l.project_id
        AND p.workspace_id = l.workspace_id
        AND w.id = l.workspace_id
        AND c.workspace_id = l.workspace_id
        AND t.workspace_id = l.workspace_id
        AND th.workspace_id = l.workspace_id
        AND l.memory_topic_id = expected.memory_topic_id
        AND t.slug = expected.web_topic_slug
        AND t.memory_topic_id = expected.memory_topic_id
        AND th.title = expected.thread_title
        AND p.id = {sql_literal(PROJECT_ID)}::uuid
        AND w.name = {sql_literal(WORKSPACE_NAME)}
        AND p.name = {sql_literal(PROJECT_NAME)}
        AND c.name = {sql_literal(CHANNEL_NAME)}
        AND w.status = 'active' AND w.deleted_at IS NULL
        AND p.status = 'active' AND p.deleted_at IS NULL
        AND c.status = 'active' AND c.deleted_at IS NULL
        AND t.status = 'active' AND t.deleted_at IS NULL
        AND th.status = 'active' AND th.deleted_at IS NULL
      ) AS active
    FROM expected
    LEFT JOIN telegram_topic_links l
      ON l.telegram_chat_id = expected.telegram_chat_id
     AND l.telegram_thread_id = expected.telegram_thread_id
     AND l.consulting_topic_slug = expected.consulting_topic_slug
    LEFT JOIN workspaces w ON w.id = l.workspace_id
    LEFT JOIN projects p ON p.id = l.project_id
    LEFT JOIN channels c ON c.id = l.channel_id
    LEFT JOIN topics t ON t.id = l.web_topic_id
    LEFT JOIN threads th ON th.id = l.thread_id
    ORDER BY expected.telegram_thread_id;
    """
    proc = subprocess.run(
        psql_cmd("-q", "-t", "-A", "-F", "\t"),
        input=sql,
        text=True,
        cwd=ROOT,
        capture_output=True,
    )
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        raise SystemExit(proc.returncode)
    routes: list[RouteTarget] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 4:
            raise SystemExit("invalid telegram_topic_links route row")
        chat_id, thread_id, target_thread_id, active = parts
        routes.append(RouteTarget(
            telegram_chat_id=chat_id,
            telegram_thread_id=thread_id,
            target_thread_id=target_thread_id,
            active=active == "t",
        ))
    return routes


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
    routes = load_route_targets()
    routed, blocked = route_messages(messages, routes)
    blocked_counts: dict[str, int] = {}
    for _, decision in blocked:
        reason = decision.blocked_reason or "unknown"
        blocked_counts[reason] = blocked_counts.get(reason, 0) + 1
    fatal_reasons = {"exact_target_inactive", "general_target_unavailable"}
    fatal_counts = {reason: count for reason, count in blocked_counts.items() if reason in fatal_reasons}
    if fatal_counts:
        print(f"telegram_sync_fatal_route_unavailable={fatal_counts}", file=sys.stderr)
        return 2
    if args.dry_run:
        print(
            f"bound_sessions={len(sessions)} candidate_messages={len(messages)} "
            f"route_targets={len(routes)} routed={len(routed)} blocked={len(blocked)}"
        )
        for item in routed[:5]:
            message = item.source
            print(
                message.source_session_id,
                message.source_message_id,
                message.telegram_chat_id,
                message.telegram_thread_id,
                item.route_kind,
                item.target_thread_id,
            )
        if blocked_counts:
            print(f"blocked_reasons={blocked_counts}")
        return 0

    if blocked_counts:
        print(f"telegram_sync_blocked={blocked_counts}", file=sys.stderr)
    routed_sessions = sorted({item.source.source_session_id for item in routed})
    if not routed:
        if not args.quiet:
            print(
                f"sync_ok bound_sessions={len(sessions)} candidate_messages={len(messages)} "
                f"routed=0 blocked={len(blocked)} imported_delta=0 total_imported=0"
            )
        return 0
    before = imported_count(routed_sessions)
    sql = build_sql(routed)
    rc = run_psql(sql, quiet=args.quiet)
    after = imported_count(routed_sessions) if rc == 0 else before
    delta = after - before
    if rc == 0 and (not args.quiet or delta > 0):
        print(
            f"sync_ok bound_sessions={len(sessions)} candidate_messages={len(messages)} "
            f"routed={len(routed)} blocked={len(blocked)} imported_delta={delta} total_imported={after}"
        )
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
