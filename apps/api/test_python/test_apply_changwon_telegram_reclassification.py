from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "apply_changwon_telegram_reclassification.py"
SCRIPTS = str(ROOT / "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
spec = importlib.util.spec_from_file_location("apply_reclassification_test", SCRIPT)
assert spec and spec.loader
apply = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = apply
spec.loader.exec_module(apply)


def reverse_row() -> dict[str, object]:
    return {
        "source_session_id": "session-1",
        "source_message_id": 7,
        "web_message_id": "11111111-1111-4111-8111-111111111111",
        "expected_current_thread_id": "22222222-2222-4222-8222-222222222222",
        "reverse_target_thread_id": "33333333-3333-4333-8333-333333333333",
        "expected_current_workspace_id": "44444444-4444-4444-8444-444444444444",
        "expected_current_project_id": "55555555-5555-4555-8555-555555555555",
        "expected_current_channel_id": "66666666-6666-4666-8666-666666666666",
        "expected_current_topic_id": "77777777-7777-4777-8777-777777777777",
        "reverse_workspace_id": "88888888-8888-4888-8888-888888888888",
        "reverse_project_id": "99999999-9999-4999-8999-999999999999",
        "reverse_channel_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "reverse_topic_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "expected_current_telegram_chat_id": "-1004453868195",
        "reverse_telegram_chat_id": None,
        "expected_current_telegram_thread_id": "524",
        "reverse_telegram_thread_id": None,
        "expected_current_target_web_thread_id": "22222222-2222-4222-8222-222222222222",
        "reverse_target_web_thread_id": None,
        "expected_current_routing_version": "v3-reclassification-v1",
        "reverse_routing_version": None,
    }


def artifact() -> dict[str, Any]:
    preimage = [{
        "source_session_id": "session-1", "source_message_id": 7,
        "web_message_id": "11111111-1111-4111-8111-111111111111",
        "old_thread_id": "33333333-3333-4333-8333-333333333333", "role": "user",
        "old_workspace_id": "88888888-8888-4888-8888-888888888888",
        "old_project_id": "99999999-9999-4999-8999-999999999999",
        "old_channel_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "old_topic_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "imported_at": "2026-07-13T00:00:00Z", "created_at": "2026-07-13T00:00:00Z",
        "content_sha256": "a" * 64, "old_telegram_chat_id": None,
        "old_telegram_thread_id": None, "old_target_web_thread_id": None,
        "old_routing_version": None, "source_identity_hash": "b" * 64,
        "approved_source": True, "telegram_thread_id": "524", "classification": "exact",
        "target_thread_id": "22222222-2222-4222-8222-222222222222", "app_scope_valid": True,
    }]
    mapping = [{
        "classification": "exact",
        "old_thread_id": "33333333-3333-4333-8333-333333333333",
        "proposed_routing_version": "v3-reclassification-v1",
        "proposed_target_web_thread_id": "22222222-2222-4222-8222-222222222222",
        "proposed_telegram_chat_id": "-1004453868195",
        "proposed_telegram_thread_id": "524",
        "source_message_id": 7,
        "source_session_id": "session-1",
        "target_thread_id": "22222222-2222-4222-8222-222222222222",
        "web_message_id": "11111111-1111-4111-8111-111111111111",
    }]
    reverse = [reverse_row()]
    preimage_hash = apply.canonical_hash(preimage)
    mapping_hash = apply.canonical_hash(mapping)
    reverse_hash = apply.canonical_hash(reverse)
    return {
        "schema_version": "v3-5-preview-3.0",
        "mode": "read_only_preview",
        "approved_chat_id": "-1004453868195",
        "source_watermark": {
            "source_label": "test", "matched_legacy_source_count": 1,
            "max_message_id": 7, "identity_hash": "c" * 64,
        },
        "app_watermark": {
            "import_count": 1, "legacy_import_count": 1,
            "max_imported_at": "2026-07-13T00:00:00Z", "distinct_source_sessions": 1,
            "snapshot_hash": "d" * 64, "route_snapshot_hash": "e" * 64,
            "approved_chat_link_thread_ids": ["524"],
        },
        "fixed_set": {
            "legacy_import_count": 1, "distinct_source_sessions": 1,
            "app_preimage_hash": "f" * 64, "preimage_hash": preimage_hash,
            "mapping_hash": mapping_hash, "reverse_plan_hash": reverse_hash,
        },
        "classification_counts": {"exact": 1},
        "target_move_counts": {"33333333-3333-4333-8333-333333333333->22222222-2222-4222-8222-222222222222": 1},
        "role_counts": {"user": 1}, "source_role_counts": {"user": 1},
        "matched_app_role_counts": {"user": 1}, "source_app_role_mismatches": 0,
        "duplicate_source_keys": [], "duplicate_web_message_ids": [],
        "source_content_hash_mismatches": [],
        "privacy_violations": [],
        "snapshot_fence": {"app_stable": True, "source_stable": True},
        "invariants": {name: True for name in apply.REQUIRED_INVARIANTS},
        "apply_blocked": False,
        "apply_blockers": [],
        "app_preimage_hash": "f" * 64,
        "preimage": preimage,
        "preimage_hash": preimage_hash,
        "mapping": mapping,
        "mapping_hash": mapping_hash,
        "reverse_plan": reverse,
        "reverse_plan_hash": reverse_hash,
        "generated_at": datetime.now(UTC).isoformat(),
    }


def write_artifact(path: Path, payload: dict[str, object]) -> str:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o600)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def subprocess_result(returncode: int, stdout: str, stderr: str) -> SimpleNamespace:
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class ApplyReclassificationTests(unittest.TestCase):
    def test_artifact_hash_blocker_and_plan_integrity_fail_closed(self) -> None:
        with self.subTest("valid and hash-bound"):
            import tempfile
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "artifact.json"
                payload = artifact()
                digest = write_artifact(path, payload)
                self.assertFalse(apply.load_approved_artifact(path, digest)["apply_blocked"])
                with self.assertRaisesRegex(apply.ApplyBlocked, "sha256"):
                    apply.load_approved_artifact(path, "0" * 64)
                payload["apply_blocked"] = True
                payload["apply_blockers"] = ["unproven_chat"]
                digest = write_artifact(path, payload)
                with self.assertRaisesRegex(apply.ApplyBlocked, "unproven_chat"):
                    apply.load_approved_artifact(path, digest)

    def test_apply_and_reverse_sql_bind_shared_lock_cas_and_transaction_mode(self) -> None:
        import base64
        import re
        forward = apply.build_sql([reverse_row()], direction="apply", commit=False)
        self.assertIn("consulting.telegram-sync.v1", forward)
        self.assertIn("message.thread_id IS NOT DISTINCT FROM plan.old_thread_id", forward)
        self.assertIn("ledger.routing_version IS NOT DISTINCT FROM plan.old_routing_version", forward)
        encoded = re.search(r"decode\('([^']+)', 'base64'\)", forward)
        self.assertIsNotNone(encoded)
        assert encoded is not None
        rows = json.loads(base64.b64decode(encoded.group(1)))
        self.assertEqual(rows[0]["old_thread_id"], "33333333-3333-4333-8333-333333333333")
        self.assertEqual(rows[0]["new_thread_id"], "22222222-2222-4222-8222-222222222222")
        self.assertNotIn("$v3$", forward)
        self.assertIn("telegram_topic_links", forward)
        self.assertIn("FOR SHARE OF", forward)
        self.assertIn("v3_reclassification_parent_lock_mismatch", forward)
        self.assertIn("v3_reclassification_old_route_lock_mismatch", forward)
        self.assertIn("v3_reclassification_new_route_lock_mismatch", forward)
        self.assertIn("message.workspace_id=plan.old_workspace_id", forward)
        self.assertIn("SET workspace_id=plan.new_workspace_id", forward)
        self.assertIn("WHERE message.workspace_id=plan.new_workspace_id", forward)
        self.assertIn("FOR UPDATE OF message", forward)
        self.assertLess(forward.index("FOR SHARE OF"), forward.index("SELECT count(*) INTO scope_count"))
        self.assertNotIn("updated_at=now()", forward)
        self.assertTrue(forward.rstrip().endswith("ROLLBACK;"))
        payload = artifact()
        reverse = apply.build_sql(
            [reverse_row()], direction="reverse", commit=True,
            artifact=payload, artifact_sha256="a" * 64,
            sync_job_id="42050479fd10", quiesce_nonce="11111111-1111-4111-8111-111111111111",
        )
        encoded = re.search(r"decode\('([^']+)', 'base64'\)", reverse)
        assert encoded is not None
        rows = json.loads(base64.b64decode(encoded.group(1)))
        self.assertEqual(rows[0]["old_thread_id"], "22222222-2222-4222-8222-222222222222")
        self.assertEqual(rows[0]["new_thread_id"], "33333333-3333-4333-8333-333333333333")
        self.assertIn("INSERT INTO telegram_reclassification_runs", reverse)
        self.assertIn("v3_reclassification_prior_apply_receipt_missing", reverse)
        self.assertTrue(reverse.rstrip().endswith("COMMIT;"))

        injected_row = reverse_row()
        injected_row["source_session_id"] = "session-$v3$';ROLLBACK;--"
        injected_sql = apply.build_sql([injected_row], direction="apply", commit=False)
        self.assertNotIn("session-$v3$", injected_sql)
        encoded = re.search(r"decode\('([^']+)', 'base64'\)", injected_sql)
        assert encoded is not None
        self.assertEqual(
            json.loads(base64.b64decode(encoded.group(1)))[0]["source_session_id"],
            "session-$v3$';ROLLBACK;--",
        )
        malformed = reverse_row()
        malformed.pop("expected_current_thread_id")
        with self.assertRaisesRegex(apply.ApplyBlocked, "row_invalid"):
            apply.build_sql([malformed], direction="apply", commit=False)

    def test_scheduler_state_is_read_directly_and_must_be_paused(self) -> None:
        from unittest import mock
        paused = subprocess_result(0, "  42050479fd10 [paused]\n", "")
        with mock.patch.object(apply.subprocess, "run", return_value=paused):
            apply.verify_sync_job_paused("42050479fd10")
        active = subprocess_result(0, "  42050479fd10 [active]\n", "")
        with mock.patch.object(apply.subprocess, "run", return_value=active):
            with self.assertRaisesRegex(apply.ApplyBlocked, "not_paused"):
                apply.verify_sync_job_paused("42050479fd10")

    def test_relational_mismatch_and_symlink_fail_closed(self) -> None:
        import tempfile
        payload = artifact()
        payload["reverse_plan"][0]["source_message_id"] = 8
        payload["reverse_plan_hash"] = apply.canonical_hash(payload["reverse_plan"])
        payload["fixed_set"]["reverse_plan_hash"] = payload["reverse_plan_hash"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.json"
            digest = write_artifact(path, payload)
            with self.assertRaisesRegex(apply.ApplyBlocked, "coverage|identity"):
                apply.load_approved_artifact(path, digest)
            target = Path(directory) / "target.json"
            digest = write_artifact(target, artifact())
            link = Path(directory) / "link.json"
            link.symlink_to(target)
            with self.assertRaisesRegex(apply.ApplyBlocked, "open_failed"):
                apply.load_approved_artifact(link, digest)

    def test_emit_json_fails_closed_on_flush_and_closed_stream(self) -> None:
        import io

        class FlushFails(io.StringIO):
            def flush(self) -> None:
                raise BrokenPipeError("pipe closed")

        self.assertFalse(apply.emit_json({"committed": True}, stream=FlushFails()))
        closed = io.StringIO()
        closed.close()
        self.assertFalse(apply.emit_json({"committed": True}, stream=closed))

        code = f'''\nimport importlib.util, sys\nfrom pathlib import Path\nsys.path.insert(0, {str(SCRIPT.parent)!r})\nspec = importlib.util.spec_from_file_location("apply_exit_flush_test", Path({str(SCRIPT)!r}))\nmodule = importlib.util.module_from_spec(spec)\nsys.modules[spec.name] = module\nspec.loader.exec_module(module)\nclass LateFlushFailure:\n    def write(self, value): return len(value)\n    def flush(self): raise BrokenPipeError("late pipe failure")\nstream = LateFlushFailure()\nsys.stdout = stream\nsys.__stdout__ = stream\nassert module.emit_json({{"committed": True}}) is False\nraise SystemExit(3)\n'''
        child = apply.subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
        self.assertEqual(child.returncode, 3, child.stderr)

    def test_transaction_receipt_readback_is_three_state(self) -> None:
        from unittest import mock
        nonce = "11111111-1111-4111-8111-111111111111"
        with mock.patch.object(
            apply.subprocess, "run", return_value=subprocess_result(0, "1\n", ""),
        ) as run:
            self.assertTrue(apply.transactional_receipt_exists("a" * 64, "apply", nonce))
            self.assertEqual(run.call_args.args[0][-3:], ["-q", "-t", "-A"])
        with mock.patch.object(apply.subprocess, "run", return_value=subprocess_result(0, "0\n", "")):
            self.assertFalse(apply.transactional_receipt_exists("a" * 64, "apply", nonce))
        with mock.patch.object(apply.subprocess, "run", return_value=subprocess_result(0, "0\n1\n", "")):
            with self.assertRaisesRegex(apply.CommitOutcomeUnknown, "invalid_shape"):
                apply.transactional_receipt_exists("a" * 64, "apply", nonce)
        with mock.patch.object(
            apply.subprocess, "run", side_effect=apply.subprocess.TimeoutExpired(["psql"], 30),
        ):
            with self.assertRaises(apply.CommitOutcomeUnknown):
                apply.transactional_receipt_exists("a" * 64, "apply", nonce)

    def test_commit_receipt_failure_reports_committed_true(self) -> None:
        import contextlib
        import io
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "artifact.json"
            digest = write_artifact(artifact_path, artifact())
            stderr = io.StringIO()
            argv = [
                "apply", "--artifact", str(artifact_path), "--approved-sha256", digest,
                "--direction", "apply", "--commit", "--receipt", str(Path(directory) / "receipt.json"),
                "--sync-job-id", "42050479fd10", "--quiesce-nonce",
                "11111111-1111-4111-8111-111111111111",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(apply, "verify_sync_job_paused"),
                mock.patch.object(apply, "verify_fresh_snapshot"),
                mock.patch.object(apply.subprocess, "run", return_value=subprocess_result(0, "", "")),
                mock.patch.object(apply, "atomic_write_receipt", side_effect=OSError(28, "disk full")),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(apply.main(), 3)
            report = json.loads(stderr.getvalue())
            self.assertTrue(report["committed"])
            self.assertIn("receipt_error", report)

    def test_commit_timeout_without_receipt_reports_unknown(self) -> None:
        import contextlib
        import io
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.json"
            digest = write_artifact(path, artifact())
            receipt = Path(directory) / "receipt.json"
            argv = [
                "apply", "--artifact", str(path), "--approved-sha256", digest,
                "--direction", "apply", "--sync-job-id", "420625c17e09",
                "--quiesce-nonce", "11111111-1111-4111-8111-111111111111",
                "--receipt", str(receipt), "--commit",
            ]
            stderr = io.StringIO()
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(apply, "verify_sync_job_paused"),
                mock.patch.object(apply, "verify_fresh_snapshot"),
                mock.patch.object(apply.subprocess, "run", side_effect=apply.subprocess.TimeoutExpired("psql", 180)),
                mock.patch.object(apply, "transactional_receipt_exists", return_value=False),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(apply.main(), 4)
            payload = json.loads(stderr.getvalue())
            self.assertIsNone(payload["committed"])
            self.assertIn("timeout_receipt_absent", payload["error"])

    def test_commit_nonzero_without_receipt_is_unknown_and_stdout_failure_is_committed(self) -> None:
        import contextlib
        import io
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.json"
            digest = write_artifact(path, artifact())
            receipt = Path(directory) / "receipt.json"
            argv = [
                "apply", "--artifact", str(path), "--approved-sha256", digest,
                "--direction", "apply", "--sync-job-id", "420625c17e09",
                "--quiesce-nonce", "11111111-1111-4111-8111-111111111111",
                "--receipt", str(receipt), "--commit",
            ]
            stderr = io.StringIO()
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(apply, "verify_sync_job_paused"),
                mock.patch.object(apply, "verify_fresh_snapshot"),
                mock.patch.object(apply.subprocess, "run", return_value=subprocess_result(1, "", "transport")),
                mock.patch.object(apply, "transactional_receipt_exists", return_value=False),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(apply.main(), 4)
            self.assertIsNone(json.loads(stderr.getvalue())["committed"])

            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(apply, "verify_sync_job_paused"),
                mock.patch.object(apply, "verify_fresh_snapshot"),
                mock.patch.object(apply.subprocess, "run", return_value=subprocess_result(0, "", "")),
                mock.patch.object(apply, "emit_json", return_value=False),
            ):
                self.assertEqual(apply.main(), 3)
            self.assertTrue(json.loads(receipt.read_text(encoding="utf-8"))["committed"])


if __name__ == "__main__":
    unittest.main()
