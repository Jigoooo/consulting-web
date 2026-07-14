from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from unittest import mock
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "preview_changwon_telegram_reclassification.py"
spec = importlib.util.spec_from_file_location("preview_reclassification", SCRIPT)
assert spec and spec.loader
preview = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = preview
spec.loader.exec_module(preview)


def import_row(index: int, *, session: str = "s", old_thread: str | None = None, app_scope_valid: bool = True):
    return preview.ImportRow(
        source_session_id=session,
        source_message_id=index,
        web_message_id=f"00000000-0000-4000-8000-{index:012d}",
        old_thread_id=old_thread or f"old-{index}",
        role="user",
        imported_at="2026-01-01T00:00:00Z",
        created_at="2026-01-01T00:00:00Z",
        content_sha256=f"{'a' * 63}{index % 10}",
        old_telegram_chat_id=None,
        old_telegram_thread_id=None,
        old_target_web_thread_id=None,
        old_routing_version=None,
        app_scope_valid=app_scope_valid,
    )


def source(chat: str | None, thread: str | None, *, index: int = 1, role: str = "user"):
    return preview.SourceIdentity(
        source="telegram" if chat is not None else "unknown",
        telegram_chat_id=chat,
        telegram_thread_id=thread,
        role=role,
        active=True,
        compacted=False,
        timestamp=1_700_000_000.0 + index,
        content_sha256=f"{'b' * 63}{index % 10}",
    )


def watermark(count: int) -> dict[str, object]:
    return {
        "import_count": count,
        "legacy_import_count": count,
        "max_imported_at": "2026-01-01T00:00:00Z",
        "distinct_source_sessions": 1 if count else 0,
        "snapshot_hash": "c" * 64,
        "route_snapshot_hash": "d" * 64,
    }


class PreviewReclassificationTests(unittest.TestCase):
    def test_route_snapshot_requires_denormalized_workspace_chain(self) -> None:
        sql = preview._route_snapshot_sql()
        self.assertIn("c.workspace_id = l.workspace_id", sql)
        self.assertIn("t.workspace_id = l.workspace_id", sql)
        self.assertIn("th.workspace_id = l.workspace_id", sql)

    def test_source_role_mismatch_is_a_blocker(self) -> None:
        row = import_row(1)
        source_row = preview.SourceIdentity(
            source="telegram", telegram_chat_id="approved", telegram_thread_id="1",
            role="assistant", active=True, compacted=False, timestamp=1_700_000_001.0,
            content_sha256=row.content_sha256,
        )
        result = preview.build_preview(
            imports=[row], sources={("s", 1): source_row},
            routes={"1": preview.RouteIdentity("general", True)}, approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 1},
            app_watermark=watermark(1),
        )
        self.assertEqual(result["source_app_role_mismatches"], 1)
        self.assertFalse(result["invariants"]["source_roles_match_app_rows"])
        self.assertFalse(result["invariants"]["source_app_role_counts_match"])
        self.assertIn("source_app_role_mismatch", result["apply_blockers"])

    def test_existing_unregistered_link_blocks_general_fallback(self) -> None:
        row = import_row(1)
        result = preview.build_preview(
            imports=[row], sources={("s", 1): source("approved", "999")},
            routes={"1": preview.RouteIdentity("general", True)}, approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 1},
            app_watermark=watermark(1) | {"approved_chat_link_thread_ids": ["1", "999"]},
        )
        self.assertEqual(result["classification_counts"], {"route_drift": 1})
        self.assertIn("route_drift", result["apply_blockers"])

    def test_foreign_app_scope_is_retained_and_blocked(self) -> None:
        row = import_row(1, app_scope_valid=False)
        result = preview.build_preview(
            imports=[row], sources={("s", 1): source("approved", "1")},
            routes={"1": preview.RouteIdentity("general", True)}, approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 1},
            app_watermark=watermark(1),
        )
        self.assertEqual(result["classification_counts"], {"foreign_app_scope": 1})
        self.assertFalse(result["invariants"]["app_rows_match_target_scope"])
        self.assertFalse(result["preimage"][0]["app_scope_valid"])
        self.assertIn("foreign_app_scope", result["apply_blockers"])

    def test_classifies_with_shared_route_parity_and_tombstone_without_raw_content(self) -> None:
        imports = [import_row(i) for i in range(1, 8)]
        sources = {
            ("s", 1): source("approved", "10", index=1),
            ("s", 2): source("approved", "999", index=2),
            ("s", 3): source("approved", "30", index=3),
            ("s", 4): source("foreign", "10", index=4),
            ("s", 5): source(None, None, index=5),
            ("s", 7): source("approved", "1", index=7),
        }
        routes = {
            "10": preview.RouteIdentity("new-10", True),
            "30": preview.RouteIdentity("", False),
            "1": preview.RouteIdentity("general", True),
        }
        result = preview.build_preview(
            imports=imports,
            sources=sources,
            routes=routes,
            approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 6},
            app_watermark=watermark(7),
        )

        self.assertEqual(result["classification_counts"], {
            "exact": 1,
            "foreign_chat": 1,
            "general": 1,
            "registered_target_unavailable": 1,
            "source_missing": 1,
            "unknown_to_general": 1,
            "unproven_chat": 1,
        })
        self.assertTrue(result["apply_blocked"])
        self.assertIn("registered_target_unavailable", result["apply_blockers"])
        self.assertEqual(len(result["preimage"]), 7)
        self.assertEqual(len(result["reverse_plan"]), 3)
        self.assertEqual(len(result["reverse_plan_hash"]), 64)
        self.assertEqual(len(result["app_preimage_hash"]), 64)
        self.assertNotEqual(result["app_preimage_hash"], result["preimage_hash"])
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("/home/", serialized)
        self.assertNotIn("질문", serialized)
        result["preimage"][0]["api_token"] = "opaque-secret-without-known-pattern"
        self.assertIn("preimage_field_allowlist", preview.artifact_privacy_violations(result))
        result["preimage"] = "opaque customer memo"
        self.assertIn("preimage_container_type", preview.artifact_privacy_violations(result))

    def test_mapping_and_reverse_hashes_are_stable_for_input_order(self) -> None:
        rows = [import_row(2, session="b", old_thread="old-b"), import_row(1, session="a", old_thread="old-a")]
        sources = {("a", 1): source("approved", "1", index=1), ("b", 2): source("approved", "1", index=2)}
        routes = {"1": preview.RouteIdentity("general", True)}
        app = watermark(2) | {"distinct_source_sessions": 2}
        kwargs = dict(
            sources=sources,
            routes=routes,
            approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 2},
            app_watermark=app,
        )
        first = preview.build_preview(imports=rows, **kwargs)
        second = preview.build_preview(imports=list(reversed(rows)), **kwargs)
        self.assertEqual(first["mapping_hash"], second["mapping_hash"])
        self.assertEqual(first["preimage_hash"], second["preimage_hash"])
        self.assertEqual(first["reverse_plan_hash"], second["reverse_plan_hash"])

    def test_empty_or_watermark_mismatch_is_blocked(self) -> None:
        empty = preview.build_preview(
            imports=[], sources={}, routes={}, approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 0},
            app_watermark=watermark(0),
        )
        self.assertIn("empty_fixed_set", empty["apply_blockers"])
        mismatch = preview.build_preview(
            imports=[import_row(1)], sources={("s", 1): source("approved", "1")},
            routes={"1": preview.RouteIdentity("general", True)}, approved_chat_id="approved",
            source_watermark={"identity_hash": "e" * 64, "matched_legacy_source_count": 1},
            app_watermark=watermark(2),
        )
        self.assertIn("app_legacy_count_mismatch", mismatch["apply_blockers"])

    def test_read_only_psql_disables_startup_files_and_writes_at_connection(self) -> None:
        cmd = preview.read_only_psql_cmd()
        self.assertIn("-X", cmd)
        self.assertIn("PGOPTIONS=-c default_transaction_read_only=on", cmd)
        self.assertIn("consulting_preview_ro", preview.READ_ONLY_ROLE)

    def test_artifact_privacy_allowlist_rejects_paths_and_pii_values(self) -> None:
        self.assertFalse(preview.artifact_privacy_violations({"source_label": "hermes-state-db", "hash": "a" * 64}))
        self.assertIn("absolute_path", preview.artifact_privacy_violations({"path": "/home/person/state.db"}))
        self.assertIn("email", preview.artifact_privacy_violations({"value": "person@example.com"}))
        self.assertIn("phone", preview.artifact_privacy_violations({"value": "010-1234-5678"}))
        self.assertIn(
            "sensitive_dictionary_key",
            preview.artifact_privacy_violations({"owner@example.com": 1}),
        )

    def test_main_does_not_write_artifact_when_privacy_gate_fails(self) -> None:
        row = import_row(1)
        source_row = source("approved", "1")
        source_row = preview.SourceIdentity(**({**source_row.__dict__, "content_sha256": row.content_sha256}))
        app = watermark(1) | {"approved_chat_link_thread_ids": ["1"]}
        app_snapshot = ([row], app, {"1": preview.RouteIdentity("general", True)})
        source_snapshot = ({("s", 1): source_row}, {"identity_hash": "e" * 64, "matched_legacy_source_count": 1})
        with (
            mock.patch.object(preview, "load_app_snapshot", side_effect=[app_snapshot, app_snapshot]),
            mock.patch.object(preview, "load_source_identities", side_effect=[source_snapshot, source_snapshot]),
            mock.patch.object(preview, "artifact_privacy_violations", return_value=["email"]),
            mock.patch.object(preview, "_atomic_write_json") as writer,
            mock.patch.object(sys, "argv", ["preview", "--output", "/tmp/must-not-exist.json"]),
        ):
            self.assertEqual(preview.main(), 2)
            writer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
