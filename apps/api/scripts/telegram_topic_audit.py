#!/usr/bin/env python3
"""Read-only audit for Telegram topic/session bindings.

Order-07 guardrail: expose Changwon Telegram topic split before any registry/backfill
mutation. The script opens SQLite databases with mode=ro and never calls Telegram or
Postgres write paths.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

DEFAULT_CHAT_ID = "-1004453868195"
DEFAULT_TOPIC_SLUG = "changwon-org-mgmt-diagnosis"
DEFAULT_EXPECTED_THREADS = ["12", "524", "533", "356", "1"]
DEFAULT_STATE_DB = Path("/home/jigoo/.hermes/state.db")
DEFAULT_CONSULTING_DB = Path("/home/jigoo/.hermes/workspace/consulting/db/consulting.db")
DEFAULT_CONFIG = Path("/home/jigoo/.hermes/config.yaml")


@dataclass(frozen=True)
class SessionRow:
    id: str
    session_key: str | None
    chat_id: str | None
    thread_id: str | None
    title: str | None
    message_count: int
    started_at: float | None


@dataclass(frozen=True)
class BoundSessionRow:
    topic_slug: str
    session_id: str
    bound_at: str | None


@dataclass(frozen=True)
class Issue:
    code: str
    severity: str
    detail: str
    evidence: dict[str, Any]


def sqlite_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise FileNotFoundError(f"SQLite DB not found: {path}")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def load_state_sessions(path: Path, chat_id: str) -> list[SessionRow]:
    with sqlite_ro(path) as con:
        rows = con.execute(
            """
            SELECT id, session_key, chat_id, thread_id, title, COALESCE(message_count, 0), started_at
            FROM sessions
            WHERE source = 'telegram'
              AND chat_id = ?
              AND COALESCE(archived, 0) = 0
            ORDER BY started_at, id
            """,
            (chat_id,),
        ).fetchall()
    return [SessionRow(str(r[0]), r[1], r[2], None if r[3] is None else str(r[3]), r[4], int(r[5] or 0), r[6]) for r in rows]


def load_bound_sessions(path: Path, topic_slug: str) -> list[BoundSessionRow]:
    with sqlite_ro(path) as con:
        rows = con.execute(
            """
            SELECT t.slug, dts.session_id, dts.bound_at
            FROM dialogue_topic_sessions dts
            JOIN topics t ON t.id = dts.topic_id
            WHERE t.slug = ?
            ORDER BY dts.bound_at, dts.session_id
            """,
            (topic_slug,),
        ).fetchall()
    return [BoundSessionRow(str(r[0]), str(r[1]), r[2]) for r in rows]


def parse_config_prompt_threads(path: Path, chat_id: str) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    escaped = re.escape(chat_id)
    pattern = re.compile(rf"[\'\"]?{escaped}:(\d+)[\'\"]?\s*:")
    return sorted(set(pattern.findall(text)), key=lambda x: int(x))


def summarize_by_thread(sessions: list[SessionRow]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = defaultdict(lambda: {"thread_id": None, "sessions": 0, "messages": 0, "session_ids": []})
    for row in sessions:
        key = row.thread_id if row.thread_id is not None else "__NULL__"
        item = grouped[key]
        item["thread_id"] = row.thread_id
        item["sessions"] += 1
        item["messages"] += row.message_count
        item["session_ids"].append(row.id)
    def sort_key(item: dict[str, Any]) -> int:
        tid = item["thread_id"]
        return -1 if tid is None else int(tid) if str(tid).isdigit() else 10**9
    return sorted(grouped.values(), key=sort_key)


def build_issues(
    *,
    expected_threads: set[str],
    configured_prompt_threads: set[str],
    sessions: list[SessionRow],
    bound_sessions: list[BoundSessionRow],
    chat_id: str,
) -> list[Issue]:
    by_id = {row.id: row for row in sessions}
    issues: list[Issue] = []

    observed_threads = {row.thread_id for row in sessions if row.thread_id is not None and row.message_count > 0}
    missing_prompt_threads = sorted(
        (thread for thread in observed_threads if thread not in configured_prompt_threads),
        key=lambda x: int(x) if str(x).isdigit() else 10**9,
    )
    if missing_prompt_threads:
        issues.append(Issue(
            code="PROMPT_MISSING_FOR_OBSERVED_THREAD",
            severity="warning",
            detail="Telegram sessions exist in threads that do not have explicit channel_prompts entries.",
            evidence={"threads": missing_prompt_threads, "configured_prompt_threads": sorted(configured_prompt_threads)},
        ))

    missing_expected = sorted((thread for thread in expected_threads if thread not in observed_threads), key=lambda x: int(x))
    if missing_expected:
        issues.append(Issue(
            code="EXPECTED_THREAD_HAS_NO_OBSERVED_SESSION",
            severity="info",
            detail="Expected thread id has no observed Telegram session in state.db.",
            evidence={"threads": missing_expected},
        ))

    bound_missing_state = [row.session_id for row in bound_sessions if row.session_id not in by_id]
    if bound_missing_state:
        issues.append(Issue(
            code="BOUND_SESSION_STATE_MISSING",
            severity="info",
            detail="dialogue_topic_sessions contains session ids not present in the current Hermes state.db target chat scan.",
            evidence={"session_ids": bound_missing_state},
        ))

    broad_null = [row.session_id for row in bound_sessions if (state := by_id.get(row.session_id)) and state.chat_id == chat_id and state.thread_id is None]
    if broad_null:
        issues.append(Issue(
            code="BROAD_NULL_THREAD_BINDING",
            severity="blocker_for_autobind",
            detail="Changwon dialogue binding includes Telegram sessions whose state.thread_id is NULL; exact topic binding must replace this before new auto-bind behavior.",
            evidence={"session_ids": broad_null},
        ))

    unexpected_bound = sorted({state.thread_id for row in bound_sessions if (state := by_id.get(row.session_id)) and state.thread_id and state.thread_id not in expected_threads})
    if unexpected_bound:
        issues.append(Issue(
            code="BOUND_SESSION_UNEXPECTED_THREAD",
            severity="warning",
            detail="Changwon dialogue binding includes target-chat sessions outside the expected topic ids.",
            evidence={"threads": unexpected_bound},
        ))

    if not configured_prompt_threads:
        issues.append(Issue(
            code="NO_CHANNEL_PROMPT_FOR_CHAT",
            severity="warning",
            detail="No channel_prompts entry was found for this Telegram chat id in the config file.",
            evidence={"chat_id": chat_id},
        ))

    return issues


def audit(args: argparse.Namespace) -> dict[str, Any]:
    expected_threads = {str(item) for item in args.expected_thread}
    sessions = load_state_sessions(Path(args.state_db), args.chat_id)
    bound = load_bound_sessions(Path(args.consulting_db), args.topic_slug)
    configured = set(parse_config_prompt_threads(Path(args.config), args.chat_id))
    issues = build_issues(
        expected_threads=expected_threads,
        configured_prompt_threads=configured,
        sessions=sessions,
        bound_sessions=bound,
        chat_id=args.chat_id,
    )
    return {
        "read_only": True,
        "chat_id": args.chat_id,
        "topic_slug": args.topic_slug,
        "expected_threads": sorted(expected_threads, key=lambda x: int(x)),
        "configured_prompt_threads": sorted(configured, key=lambda x: int(x)),
        "state_sessions_by_thread": summarize_by_thread(sessions),
        "bound_sessions": [asdict(row) for row in bound],
        "issues": [asdict(issue) for issue in issues],
    }


def print_text(result: dict[str, Any]) -> None:
    print(f"read_only: {result['read_only']}")
    print(f"chat_id: {result['chat_id']}")
    print(f"topic_slug: {result['topic_slug']}")
    print(f"expected_threads: {','.join(result['expected_threads'])}")
    print(f"configured_prompt_threads: {','.join(result['configured_prompt_threads']) or '-'}")
    for item in result["state_sessions_by_thread"]:
        tid = item["thread_id"] if item["thread_id"] is not None else "NULL"
        print(f"state_thread: {tid} sessions={item['sessions']} messages={item['messages']} ids={','.join(item['session_ids'])}")
    print(f"bound_sessions: {len(result['bound_sessions'])}")
    if result["issues"]:
        for issue in result["issues"]:
            print(f"issue: {issue['severity']} {issue['code']} {json.dumps(issue['evidence'], ensure_ascii=False, sort_keys=True)}")
    else:
        print("issues: -")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Read-only Changwon Telegram topic binding audit")
    p.add_argument("--state-db", default=str(DEFAULT_STATE_DB))
    p.add_argument("--consulting-db", default=str(DEFAULT_CONSULTING_DB))
    p.add_argument("--config", default=str(DEFAULT_CONFIG))
    p.add_argument("--chat-id", default=DEFAULT_CHAT_ID)
    p.add_argument("--topic-slug", default=DEFAULT_TOPIC_SLUG)
    p.add_argument("--expected-thread", action="append", default=list(DEFAULT_EXPECTED_THREADS))
    p.add_argument("--json", action="store_true")
    return p


def main() -> int:
    args = parser().parse_args()
    result = audit(args)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print_text(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
