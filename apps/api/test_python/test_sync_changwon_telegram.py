from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "sync_changwon_telegram.py"
MIGRATION = ROOT / "packages" / "db-schema" / "drizzle" / "0039_telegram_message_import_ledger.sql"
SCOPE_BINDING_MIGRATION = ROOT / "packages" / "db-schema" / "drizzle" / "0046_telegram_exact_consulting_scope_links.sql"
PREVIEW_ROLE_MIGRATION = ROOT / "packages" / "db-schema" / "drizzle" / "0047_consulting_preview_read_only_role.sql"
PREVIEW_ROLE_OPTIONS_MIGRATION = ROOT / "packages" / "db-schema" / "drizzle" / "0050_consulting_preview_role_membership_options.sql"
TOPIC_SYNC_SCRIPT = ROOT / "apps" / "api" / "scripts" / "sync_telegram_topics_to_web.ts"
MIGRATION_RUNNERS = [
    ROOT / "packages" / "db-schema" / "scripts" / "migrate.ts",
    ROOT / "apps" / "api" / "docker-migrate.mjs",
]
SPEC = importlib.util.spec_from_file_location("sync_changwon_telegram", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class ChangwonTelegramRoutingTest(unittest.TestCase):
    def test_topic_provisioning_validates_full_existing_scope_chain(self) -> None:
        script = TOPIC_SYNC_SCRIPT.read_text(encoding="utf-8")
        for fragment in (
            "telegram channel scope mismatch", "topic scope mismatch", "thread scope mismatch",
            "telegram topic workspace mismatch", "telegram topic parent chain mismatch",
            "telegram topic final chain mismatch", "web_topic_id::text", "thread_id::text",
            "for update", "consulting.telegram-sync.v1",
        ):
            self.assertIn(fragment, script)

    def test_migration_runners_fail_closed_on_checksum_drift(self) -> None:
        for path in MIGRATION_RUNNERS:
            script = path.read_text(encoding="utf-8")
            self.assertIn("createHash('sha256')", script)
            self.assertIn("ADD COLUMN IF NOT EXISTS checksum", script)
            self.assertIn("migration checksum mismatch", script)
            self.assertIn("INSERT INTO _migrations(name, checksum)", script)
            self.assertIn("RETURNING checksum", script)
            self.assertIn("checksums.json", script)
            self.assertIn("consulting.schema-migrations.v1", script)
            self.assertIn("baseline missing or mismatched", script)
            self.assertIn("pendingSeals", script)
            self.assertIn("defer ${file}", script)

        hardening = (ROOT / "packages/db-schema/drizzle/0052_migration_checksum_baseline_hardening.sql").read_text()
        self.assertIn("BEFORE TRUNCATE", hardening)
        self.assertIn("REVOKE INSERT, UPDATE, DELETE, TRUNCATE", hardening)
    def _message(self, *, chat_id: str | None = "-1004453868195", thread_id: str | None = "524"):
        return sync.SourceMessage(
            source_session_id="session-1",
            source_message_id=101,
            telegram_chat_id=chat_id,
            telegram_thread_id=thread_id,
            role="user",
            content="질문",
            timestamp=1_700_000_000.0,
        )

    def _target(self, thread_id: str, target_thread_id: str, *, active: bool = True):
        return sync.RouteTarget(
            telegram_chat_id="-1004453868195",
            telegram_thread_id=thread_id,
            target_thread_id=target_thread_id,
            active=active,
        )

    def test_exact_active_thread_routes_exactly(self) -> None:
        decision = sync.select_route(
            self._message(thread_id="524"),
            [self._target("1", "web-general"), self._target("524", "web-pay")],
        )
        self.assertEqual(decision.route_kind, "exact")
        self.assertEqual(decision.target_thread_id, "web-pay")
        self.assertIsNone(decision.blocked_reason)

    def test_unknown_and_null_thread_route_to_general_review(self) -> None:
        routes = [self._target("1", "web-general")]
        unknown = sync.select_route(self._message(thread_id="9999"), routes)
        null_thread = sync.select_route(self._message(thread_id=None), routes)
        self.assertEqual((unknown.route_kind, unknown.target_thread_id), ("general", "web-general"))
        self.assertEqual((null_thread.route_kind, null_thread.target_thread_id), ("general", "web-general"))

    def test_foreign_or_unproven_chat_is_blocked(self) -> None:
        routes = [self._target("1", "web-general")]
        for chat_id in ("-1000000000000", None):
            decision = sync.select_route(self._message(chat_id=chat_id, thread_id="1"), routes)
            self.assertEqual(decision.route_kind, "blocked")
            self.assertEqual(decision.blocked_reason, "foreign_or_unproven_chat")
            self.assertIsNone(decision.target_thread_id)

    def test_inactive_exact_target_blocks_without_general_fallback(self) -> None:
        routes = [
            self._target("1", "web-general"),
            self._target("524", "web-pay-archived", active=False),
        ]
        decision = sync.select_route(self._message(thread_id="524"), routes)
        self.assertEqual(decision.route_kind, "blocked")
        self.assertEqual(decision.blocked_reason, "exact_target_inactive")
        self.assertIsNone(decision.target_thread_id)

    def test_missing_or_inactive_general_target_blocks_unknown_thread(self) -> None:
        for routes in ([], [self._target("1", "web-general", active=False)]):
            decision = sync.select_route(self._message(thread_id="9999"), routes)
            self.assertEqual(decision.route_kind, "blocked")
            self.assertEqual(decision.blocked_reason, "general_target_unavailable")

    def test_sql_uses_preselected_thread_and_formal_ledger_without_runtime_ddl(self) -> None:
        source = self._message(thread_id="524")
        routed = sync.RoutedMessage(source=source, target_thread_id="web-pay", route_kind="exact")
        sql = sync.build_sql([routed])
        self.assertNotIn("CREATE TABLE", sql)
        self.assertIn("telegram_chat_id", sql)
        self.assertIn("telegram_thread_id", sql)
        self.assertIn("target_web_thread_id", sql)
        self.assertIn("routing_version", sql)
        self.assertIn("v3-exact-topic-v1", sql)
        self.assertIn("'web-pay'::uuid", sql)
        self.assertIn("pg_advisory_xact_lock", sql)
        self.assertIn("telegram_sync_route_drift", sql)
        self.assertIn("FOR SHARE OF link", sql)
        self.assertIn("JOIN memberships", sql)
        self.assertIn("membership.scope_type = 'workspace'", sql)
        self.assertIn("project.workspace_id = membership.workspace_id", sql)
        self.assertIn("telegram_sync_owner_membership_invalid", sql)

    def test_general_fallback_requires_original_thread_link_absence(self) -> None:
        routed = sync.RoutedMessage(self._message(thread_id="9999"), "web-general", "general")
        sql = sync.build_sql([routed])
        self.assertIn("$fallback_guard$", sql)
        self.assertIn("link.telegram_thread_id = '9999'", sql)
        self.assertIn("IF FOUND", sql)
        self.assertIn("telegram_sync_route_drift", sql)

    def test_source_namespaces_cover_legacy_and_all_exact_topics(self) -> None:
        self.assertEqual(set(sync.SOURCE_TOPIC_SLUGS), {
            "changwon-org-mgmt-diagnosis",
            "changwon-consulting",
            "changwon-pay-system",
            "changwon-tenure-promotion",
            "changwon-agency-business",
            "changwon-budget-standards",
            "changwon-general-review",
        })

    def test_formal_ledger_migration_does_not_rewrite_or_relabel_legacy_rows(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8")
        self.assertNotIn("UPDATE telegram_message_imports", sql)
        self.assertNotRegex(sql, r"routing_version\s+text\s+NOT\s+NULL\s+DEFAULT")
        self.assertIn("ADD COLUMN IF NOT EXISTS routing_version text;", sql)

    def test_exact_scope_binding_migration_is_additive_active_and_idempotent(self) -> None:
        sql = SCOPE_BINDING_MIGRATION.read_text(encoding="utf-8")
        self.assertIn("INSERT INTO consulting_topic_links", sql)
        self.assertIn("FROM telegram_topic_links", sql)
        self.assertIn("l.status = 'active'", sql)
        self.assertIn("l.telegram_thread_id IS NOT NULL", sql)
        self.assertIn("l.web_topic_id IS NOT NULL", sql)
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("existing.link_level = 'topic'", sql)
        self.assertNotRegex(sql, r"\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?telegram_message_imports\b")

    def test_preview_role_migration_is_no_login_and_select_only(self) -> None:
        sql = PREVIEW_ROLE_MIGRATION.read_text(encoding="utf-8")
        self.assertIn("CREATE ROLE consulting_preview_ro", sql)
        self.assertIn("NOLOGIN", sql)
        self.assertIn("NOSUPERUSER", sql)
        self.assertIn("NOCREATEDB", sql)
        self.assertIn("NOCREATEROLE", sql)
        self.assertIn("GRANT SELECT ON TABLE", sql)
        self.assertNotRegex(sql, r"GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)")
        self.assertIn("ALTER ROLE consulting_preview_ro", sql)
        self.assertIn("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public", sql)
        options_sql = PREVIEW_ROLE_OPTIONS_MIGRATION.read_text(encoding="utf-8")
        self.assertIn("WITH ADMIN FALSE, INHERIT FALSE, SET TRUE", options_sql)
        self.assertIn("membership.admin_option = false", options_sql)
        self.assertIn("membership.inherit_option = false", options_sql)
        self.assertIn("membership.set_option = true", options_sql)
        self.assertIn("member = 'consulting_preview_ro'::regrole", options_sql)

    def test_route_targets_come_from_exact_link_ledger_and_preserve_inactive_rows(self) -> None:
        completed = sync.subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=(
                "-1004453868195\t524\t00000000-0000-4000-8000-000000000524\tt\n"
                "-1004453868195\t533\t00000000-0000-4000-8000-000000000533\tf\n"
            ),
            stderr="",
        )
        with mock.patch.object(sync.subprocess, "run", return_value=completed) as run:
            routes = sync.load_route_targets()

        self.assertEqual([(route.telegram_thread_id, route.active) for route in routes], [("524", True), ("533", False)])
        sql = run.call_args.kwargs["input"]
        self.assertIn("LEFT JOIN telegram_topic_links", sql)
        self.assertIn("WITH expected", sql)
        self.assertIn(f"p.id = '{sync.PROJECT_ID}'::uuid", sql)
        self.assertIn("th.status = 'active'", sql)
        self.assertIn("c.workspace_id = l.workspace_id", sql)
        self.assertIn("t.workspace_id = l.workspace_id", sql)
        self.assertIn("th.workspace_id = l.workspace_id", sql)
        self.assertIn("l.status = 'active'", sql)

    def test_main_loads_route_targets_and_builds_sql_only_from_routed_messages(self) -> None:
        message = self._message(thread_id="524")
        route = self._target("524", "00000000-0000-4000-8000-000000000524")
        with (
            mock.patch.object(sync, "bound_sessions", return_value=[message.source_session_id]),
            mock.patch.object(sync, "load_messages", return_value=[message]),
            mock.patch.object(sync, "load_route_targets", return_value=[route]) as load_routes,
            mock.patch.object(sync, "imported_count", side_effect=[0, 1]),
            mock.patch.object(sync, "build_sql", return_value="SELECT 1;") as build_sql,
            mock.patch.object(sync, "run_psql", return_value=0),
            mock.patch.object(sys, "argv", [str(SCRIPT)]),
        ):
            self.assertEqual(sync.main(), 0)

        load_routes.assert_called_once_with()
        routed = build_sql.call_args.args[0]
        self.assertEqual(len(routed), 1)
        self.assertIsInstance(routed[0], sync.RoutedMessage)
        self.assertEqual(routed[0].target_thread_id, route.target_thread_id)

    def test_main_fails_closed_before_any_write_when_registered_target_is_unavailable(self) -> None:
        message = self._message(thread_id="524")
        inactive = sync.RouteTarget(
            telegram_chat_id=sync.APPROVED_CHAT_ID,
            telegram_thread_id="524",
            target_thread_id="",
            active=False,
        )
        with (
            mock.patch.object(sync, "bound_sessions", return_value=[message.source_session_id]),
            mock.patch.object(sync, "load_messages", return_value=[message]),
            mock.patch.object(sync, "load_route_targets", return_value=[inactive]),
            mock.patch.object(sync, "build_sql") as build_sql,
            mock.patch.object(sync, "run_psql") as run_psql,
            mock.patch.object(sys, "argv", [str(SCRIPT)]),
        ):
            self.assertNotEqual(sync.main(), 0)
        build_sql.assert_not_called()
        run_psql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
