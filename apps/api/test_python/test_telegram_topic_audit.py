from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "telegram_topic_audit.py"


class TelegramTopicAuditTest(unittest.TestCase):
    def test_flags_prompt_gaps_and_broad_null_binding_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            state = tmpdir / "state.db"
            consulting = tmpdir / "consulting.db"
            config = tmpdir / "config.yaml"
            self._make_state_db(state)
            self._make_consulting_db(consulting)
            config.write_text(
                "telegram:\n"
                "  channel_prompts:\n"
                "    '-1004453868195:12': '창원 기본 토픽'\n",
                encoding="utf-8",
            )
            before_state = self._counts(state, "sessions")
            before_bindings = self._counts(consulting, "dialogue_topic_sessions")

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--json",
                    "--state-db",
                    str(state),
                    "--consulting-db",
                    str(consulting),
                    "--config",
                    str(config),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = json.loads(proc.stdout)

            self.assertTrue(result["read_only"])
            self.assertEqual(result["configured_prompt_threads"], ["12"])
            self.assertEqual(before_state, self._counts(state, "sessions"))
            self.assertEqual(before_bindings, self._counts(consulting, "dialogue_topic_sessions"))

            issues = {issue["code"]: issue for issue in result["issues"]}
            self.assertIn("PROMPT_MISSING_FOR_OBSERVED_THREAD", issues)
            self.assertEqual(issues["PROMPT_MISSING_FOR_OBSERVED_THREAD"]["evidence"]["threads"], ["1", "356", "524", "533"])
            self.assertIn("BROAD_NULL_THREAD_BINDING", issues)
            self.assertEqual(issues["BROAD_NULL_THREAD_BINDING"]["evidence"]["session_ids"], ["s-null"])

    def test_exact_thread_bindings_shadow_legacy_null_binding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            state = tmpdir / "state.db"
            consulting = tmpdir / "consulting.db"
            config = tmpdir / "config.yaml"
            self._make_state_db(state)
            self._make_consulting_db(consulting)
            self._add_exact_bindings(consulting)
            config.write_text(
                "telegram:\n"
                "  channel_prompts:\n"
                "    '-1004453868195:1': '창원 일반'\n"
                "    '-1004453868195:12': '창원 기본 토픽'\n"
                "    '-1004453868195:356': '창원 기관'\n"
                "    '-1004453868195:524': '창원 임금'\n"
                "    '-1004453868195:533': '창원 승진'\n"
                "    '-1004453868195:1060': '창원 확인'\n",
                encoding="utf-8",
            )

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--json",
                    "--state-db",
                    str(state),
                    "--consulting-db",
                    str(consulting),
                    "--config",
                    str(config),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = json.loads(proc.stdout)
            issues = {issue["code"]: issue for issue in result["issues"]}

            self.assertNotIn("PROMPT_MISSING_FOR_OBSERVED_THREAD", issues)
            self.assertNotIn("BROAD_NULL_THREAD_BINDING", issues)
            self.assertIn("LEGACY_NULL_THREAD_BINDING_SHADOWED", issues)
            self.assertEqual(issues["LEGACY_NULL_THREAD_BINDING_SHADOWED"]["evidence"]["session_ids"], ["s-null"])

    def test_enforces_exact_prompt_namespaces_general_quarantine_and_topic_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            state = tmpdir / "state.db"
            consulting = tmpdir / "consulting.db"
            config = tmpdir / "config.yaml"
            self._make_state_db(state)
            self._make_consulting_db(consulting)
            self._add_exact_bindings(consulting)
            slugs = {
                "1": "changwon-general-review",
                "12": "changwon-consulting",
                "356": "changwon-agency-business",
                "524": "changwon-pay-system",
                "533": "changwon-tenure-promotion",
                "1060": "changwon-budget-standards",
            }
            prompts = {}
            for thread_id, slug in slugs.items():
                prompt = f'dialogue_memory_cli.py ingest --topic {slug} --session-id "$HERMES_SESSION_ID"'
                if thread_id != "1":
                    prompt += f' dialogue_memory_cli.py recall --topic {slug}'
                prompts[f"-1004453868195:{thread_id}"] = prompt
            config.write_text(yaml.safe_dump({
                "telegram": {
                    "allowed_topics": "1,12,356,524,533,1060",
                    "channel_prompts": prompts,
                },
            }, allow_unicode=True, sort_keys=False), encoding="utf-8")

            clean = self._run_audit(state, consulting, config)
            clean_codes = {issue["code"] for issue in clean["issues"]}
            self.assertFalse(clean_codes & {
                "ALLOWED_TOPICS_SCOPE_MISMATCH",
                "PROMPT_TOPIC_NAMESPACE_MISMATCH",
                "PROMPT_SESSION_INGEST_GUARD_MISSING",
                "GENERAL_AUTO_RECALL_ENABLED",
            })

            prompts["-1004453868195:1"] += " dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis"
            prompts["-1004453868195:524"] = prompts["-1004453868195:524"].replace(
                "changwon-pay-system", "changwon-org-mgmt-diagnosis",
            )
            config.write_text(yaml.safe_dump({
                "telegram": {
                    "allowed_topics": "1,12,356,524,533",
                    "channel_prompts": prompts,
                },
            }, allow_unicode=True, sort_keys=False), encoding="utf-8")
            broken = self._run_audit(state, consulting, config)
            broken_codes = {issue["code"] for issue in broken["issues"]}
            self.assertTrue({
                "ALLOWED_TOPICS_SCOPE_MISMATCH",
                "PROMPT_TOPIC_NAMESPACE_MISMATCH",
                "GENERAL_AUTO_RECALL_ENABLED",
            }.issubset(broken_codes))

    def _run_audit(self, state: Path, consulting: Path, config: Path) -> dict[str, Any]:
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--json",
                "--state-db",
                str(state),
                "--consulting-db",
                str(consulting),
                "--config",
                str(config),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(proc.stdout)

    def _make_state_db(self, path: Path) -> None:
        con = sqlite3.connect(path)
        con.execute(
            """
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY,
              source TEXT,
              session_key TEXT,
              chat_id TEXT,
              thread_id TEXT,
              title TEXT,
              message_count INTEGER,
              started_at REAL,
              archived INTEGER DEFAULT 0
            )
            """
        )
        rows = [
            ("s-null", "telegram", "agent:main:telegram:group:-1004453868195:5557055657", "-1004453868195", None, "old broad", 4, 1.0, 0),
            ("s-12", "telegram", "agent:main:telegram:group:-1004453868195:12", "-1004453868195", "12", "configured", 45, 2.0, 0),
            ("s-1", "telegram", "agent:main:telegram:group:-1004453868195:1", "-1004453868195", "1", "general", 20, 3.0, 0),
            ("s-356", "telegram", "agent:main:telegram:group:-1004453868195:356", "-1004453868195", "356", "agency", 119, 4.0, 0),
            ("s-524", "telegram", "agent:main:telegram:group:-1004453868195:524", "-1004453868195", "524", "pay", 70, 5.0, 0),
            ("s-533", "telegram", "agent:main:telegram:group:-1004453868195:533", "-1004453868195", "533", "promotion", 141, 6.0, 0),
        ]
        con.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        con.commit()
        con.close()

    def _make_consulting_db(self, path: Path) -> None:
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE topics (id INTEGER PRIMARY KEY, slug TEXT, title TEXT)")
        con.execute("CREATE TABLE dialogue_topic_sessions (topic_id INTEGER, session_id TEXT, bound_at TEXT)")
        con.execute("INSERT INTO topics VALUES (5, 'changwon-org-mgmt-diagnosis', '창원')")
        con.executemany(
            "INSERT INTO dialogue_topic_sessions VALUES (5, ?, '2026-07-07T00:00:00+09:00')",
            [(sid,) for sid in ["s-null", "s-12", "s-1", "s-356", "s-524", "s-533"]],
        )
        con.commit()
        con.close()

    def _add_exact_bindings(self, path: Path) -> None:
        con = sqlite3.connect(path)
        con.execute(
            """
            CREATE TABLE dialogue_telegram_thread_bindings (
              topic_id INTEGER,
              telegram_user_id TEXT,
              chat_id TEXT,
              thread_id TEXT,
              status TEXT
            )
            """
        )
        con.executemany(
            "INSERT INTO dialogue_telegram_thread_bindings VALUES (5, '5557055657', '-1004453868195', ?, 'active')",
            [(thread,) for thread in ["1", "12", "356", "524", "533", "1060"]],
        )
        con.commit()
        con.close()

    def _counts(self, db: Path, table: str) -> int:
        con = sqlite3.connect(db)
        value = int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        con.close()
        return value


if __name__ == "__main__":
    unittest.main()
