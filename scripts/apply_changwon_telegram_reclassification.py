#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import sync_changwon_telegram as sync
import preview_changwon_telegram_reclassification as preview

ROOT = Path(__file__).resolve().parents[1]
ADVISORY_KEY = "consulting.telegram-sync.v1"
MAX_ARTIFACT_AGE = timedelta(hours=24)
REQUIRED_INVARIANTS = {
    "fixed_set_nonempty", "classification_total_matches_fixed_set",
    "preimage_count_matches_fixed_set", "app_legacy_count_matches_fixed_set",
    "source_match_count_matches_loaded_sources", "source_keys_unique",
    "web_message_ids_unique", "source_content_hashes_match_app",
    "source_roles_match_app_rows", "source_app_role_counts_match",
    "app_rows_match_target_scope", "reverse_plan_covers_all_planned_updates",
}
PREIMAGE_FIELDS = {
    "source_session_id", "source_message_id", "web_message_id", "old_thread_id", "role",
    "old_workspace_id", "old_project_id", "old_channel_id", "old_topic_id",
    "imported_at", "created_at", "content_sha256", "old_telegram_chat_id",
    "old_telegram_thread_id", "old_target_web_thread_id", "old_routing_version",
    "source_identity_hash", "approved_source", "telegram_thread_id", "classification",
    "target_thread_id", "app_scope_valid",
}
MAPPING_FIELDS = {
    "source_session_id", "source_message_id", "web_message_id", "old_thread_id",
    "classification", "target_thread_id", "proposed_telegram_chat_id",
    "proposed_telegram_thread_id", "proposed_target_web_thread_id", "proposed_routing_version",
}
REVERSE_FIELDS = {
    "web_message_id", "expected_current_thread_id", "reverse_target_thread_id",
    "expected_current_workspace_id", "expected_current_project_id",
    "expected_current_channel_id", "expected_current_topic_id",
    "reverse_workspace_id", "reverse_project_id", "reverse_channel_id", "reverse_topic_id",
    "source_session_id", "source_message_id", "expected_current_telegram_chat_id",
    "expected_current_telegram_thread_id", "expected_current_target_web_thread_id",
    "expected_current_routing_version", "reverse_telegram_chat_id",
    "reverse_telegram_thread_id", "reverse_target_web_thread_id", "reverse_routing_version",
}


class ApplyBlocked(RuntimeError):
    pass


class CommitOutcomeUnknown(RuntimeError):
    pass


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_approved_artifact(path: Path, approved_sha256: str, *, allow_expired: bool = False) -> dict[str, Any]:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ApplyBlocked(f"artifact_open_failed:{exc.errno}") from exc
    try:
        info = os.fstat(fd)
        mode = stat.S_IMODE(info.st_mode)
        if not stat.S_ISREG(info.st_mode) or mode != 0o600 or info.st_uid != os.getuid():
            raise ApplyBlocked(f"artifact_file_contract_invalid:{mode:04o}")
        chunks: list[bytes] = []
        while chunk := os.read(fd, 1024 * 1024):
            chunks.append(chunk)
        raw_bytes = b"".join(chunks)
    finally:
        os.close(fd)
    actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    if actual_sha256 != approved_sha256:
        raise ApplyBlocked("artifact_sha256_mismatch")
    payload = json.loads(raw_bytes.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ApplyBlocked("artifact_must_be_object")
    if payload.get("schema_version") != "v3-5-preview-4.0" or payload.get("mode") != "read_only_preview":
        raise ApplyBlocked("artifact_contract_mismatch")
    if payload.get("privacy_violations") != [] or preview.artifact_privacy_violations(payload):
        raise ApplyBlocked("artifact_privacy_violation")
    generated_at = datetime.fromisoformat(str(payload.get("generated_at")))
    age = datetime.now(UTC) - generated_at.astimezone(UTC) if generated_at.tzinfo else MAX_ARTIFACT_AGE * 2
    if generated_at.tzinfo is None or age < timedelta(minutes=-5) or (not allow_expired and age > MAX_ARTIFACT_AGE):
        raise ApplyBlocked("artifact_expired")
    if payload.get("approved_chat_id") != sync.APPROVED_CHAT_ID:
        raise ApplyBlocked("approved_chat_mismatch")
    fence = payload.get("snapshot_fence")
    if fence != {"app_stable": True, "source_stable": True}:
        raise ApplyBlocked("snapshot_fence_unstable")
    invariants = payload.get("invariants")
    if not isinstance(invariants, dict) or set(invariants) != REQUIRED_INVARIANTS or not all(value is True for value in invariants.values()):
        raise ApplyBlocked("artifact_invariant_failure")
    blockers = payload.get("apply_blockers")
    if payload.get("apply_blocked") is not False or blockers != []:
        names = ",".join(str(item) for item in blockers) if isinstance(blockers, list) else "invalid"
        raise ApplyBlocked(f"artifact_apply_blocked:{names}")
    preimage = payload.get("preimage")
    mapping = payload.get("mapping")
    reverse_plan = payload.get("reverse_plan")
    if not isinstance(preimage, list) or not isinstance(mapping, list) or not isinstance(reverse_plan, list):
        raise ApplyBlocked("artifact_plan_type_invalid")
    if canonical_hash(preimage) != payload.get("preimage_hash"):
        raise ApplyBlocked("preimage_hash_mismatch")
    if canonical_hash(mapping) != payload.get("mapping_hash"):
        raise ApplyBlocked("mapping_hash_mismatch")
    if canonical_hash(reverse_plan) != payload.get("reverse_plan_hash"):
        raise ApplyBlocked("reverse_plan_hash_mismatch")
    fixed_set = payload.get("fixed_set")
    if not isinstance(fixed_set, dict) or any(
        fixed_set.get(name) != payload.get(name)
        for name in (
            "app_preimage_hash", "preimage_hash", "mapping_hash", "reverse_plan_hash",
            "manual_adjudication_hash",
        )
    ):
        raise ApplyBlocked("fixed_set_hash_mismatch")
    if (
        fixed_set.get("legacy_import_count") != len(preimage)
        or payload.get("app_watermark", {}).get("legacy_import_count") != len(preimage)
        or len(mapping) != len(preimage)
    ):
        raise ApplyBlocked("fixed_set_count_mismatch")

    def key(row: dict[str, Any]) -> tuple[str, int, str]:
        session_id = row.get("source_session_id")
        message_id = row.get("source_message_id")
        web_id = row.get("web_message_id")
        if not isinstance(session_id, str) or not session_id or not isinstance(message_id, int) or isinstance(message_id, bool):
            raise ApplyBlocked("artifact_identity_type_invalid")
        try:
            uuid.UUID(str(web_id))
        except (ValueError, TypeError) as exc:
            raise ApplyBlocked("artifact_web_message_id_invalid") from exc
        return session_id, message_id, str(web_id)

    def indexed(rows: list[Any], fields: set[str], name: str) -> dict[tuple[str, int, str], dict[str, Any]]:
        result: dict[tuple[str, int, str], dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != fields:
                raise ApplyBlocked(f"{name}_row_schema_invalid")
            row_key = key(row)
            if row_key in result:
                raise ApplyBlocked(f"{name}_duplicate_identity")
            result[row_key] = row
        return result

    pre_by_key = indexed(preimage, PREIMAGE_FIELDS, "preimage")
    map_by_key = indexed(mapping, MAPPING_FIELDS, "mapping")
    reverse_by_key = indexed(reverse_plan, REVERSE_FIELDS, "reverse")
    manual_rows = payload.get("manual_adjudications")
    manual_hash = payload.get("manual_adjudication_hash")
    manual_artifact_sha = payload.get("manual_adjudication_artifact_sha256")
    manual_fields = {
        "source_session_id", "target_chat_id", "target_thread_id",
        "evidence_fingerprint", "evidence_basis",
    }
    if not isinstance(manual_rows, list) or canonical_hash(manual_rows) != manual_hash:
        raise ApplyBlocked("manual_adjudication_hash_mismatch")
    seen_manual_sessions: set[str] = set()
    preimage_sessions = {key[0] for key in pre_by_key}
    for row in manual_rows:
        if not isinstance(row, dict) or set(row) != manual_fields:
            raise ApplyBlocked("manual_adjudication_row_invalid")
        session_id = row.get("source_session_id")
        if (
            not isinstance(session_id, str) or not session_id
            or session_id in seen_manual_sessions
            or session_id not in preimage_sessions
            or row.get("target_chat_id") != sync.APPROVED_CHAT_ID
            or not isinstance(row.get("target_thread_id"), str) or not row["target_thread_id"]
            or row.get("evidence_basis") != "manual_source_review"
            or not isinstance(row.get("evidence_fingerprint"), str)
            or re.fullmatch(r"[0-9a-f]{64}", row["evidence_fingerprint"], re.I) is None
        ):
            raise ApplyBlocked("manual_adjudication_value_invalid")
        seen_manual_sessions.add(session_id)
    if manual_rows:
        if not isinstance(manual_artifact_sha, str) or re.fullmatch(r"[0-9a-f]{64}", manual_artifact_sha, re.I) is None:
            raise ApplyBlocked("manual_adjudication_artifact_sha_invalid")
    elif manual_artifact_sha is not None:
        raise ApplyBlocked("manual_adjudication_artifact_without_rows")
    if set(pre_by_key) != set(map_by_key):
        raise ApplyBlocked("preimage_mapping_identity_mismatch")
    planned_keys = {row_key for row_key, row in map_by_key.items() if row["target_thread_id"] is not None}
    if planned_keys != set(reverse_by_key):
        raise ApplyBlocked("reverse_plan_coverage_mismatch")
    for row_key, mapping_row in map_by_key.items():
        preimage_row = pre_by_key[row_key]
        if (
            mapping_row["old_thread_id"] != preimage_row["old_thread_id"]
            or mapping_row["classification"] != preimage_row["classification"]
            or mapping_row["target_thread_id"] != preimage_row["target_thread_id"]
        ):
            raise ApplyBlocked("preimage_mapping_value_mismatch")
        if row_key not in planned_keys:
            if any(mapping_row[name] is not None for name in (
                "proposed_telegram_chat_id", "proposed_telegram_thread_id",
                "proposed_target_web_thread_id", "proposed_routing_version",
            )):
                raise ApplyBlocked("unplanned_mapping_has_provenance")
            continue
        reverse_row = reverse_by_key[row_key]
        ancestor_fields = (
            "expected_current_workspace_id", "expected_current_project_id",
            "expected_current_channel_id", "expected_current_topic_id",
            "reverse_workspace_id", "reverse_project_id", "reverse_channel_id", "reverse_topic_id",
        )
        try:
            for field in ancestor_fields:
                uuid.UUID(reverse_row[field])
        except (ValueError, TypeError) as exc:
            raise ApplyBlocked("reverse_ancestor_id_invalid") from exc
        required_new = (
            mapping_row["target_thread_id"], mapping_row["proposed_telegram_chat_id"],
            mapping_row["proposed_telegram_thread_id"], mapping_row["proposed_target_web_thread_id"],
            mapping_row["proposed_routing_version"],
        )
        if any(not isinstance(value, str) or not value for value in required_new):
            raise ApplyBlocked("planned_mapping_target_invalid")
        if (
            reverse_row["expected_current_thread_id"] != mapping_row["target_thread_id"]
            or reverse_row["expected_current_telegram_chat_id"] != mapping_row["proposed_telegram_chat_id"]
            or reverse_row["expected_current_telegram_thread_id"] != mapping_row["proposed_telegram_thread_id"]
            or reverse_row["expected_current_target_web_thread_id"] != mapping_row["proposed_target_web_thread_id"]
            or reverse_row["expected_current_routing_version"] != mapping_row["proposed_routing_version"]
            or reverse_row["reverse_target_thread_id"] != preimage_row["old_thread_id"]
            or reverse_row["reverse_workspace_id"] != preimage_row["old_workspace_id"]
            or reverse_row["reverse_project_id"] != preimage_row["old_project_id"]
            or reverse_row["reverse_channel_id"] != preimage_row["old_channel_id"]
            or reverse_row["reverse_topic_id"] != preimage_row["old_topic_id"]
            or reverse_row["reverse_telegram_chat_id"] != preimage_row["old_telegram_chat_id"]
            or reverse_row["reverse_telegram_thread_id"] != preimage_row["old_telegram_thread_id"]
            or reverse_row["reverse_target_web_thread_id"] != preimage_row["old_target_web_thread_id"]
            or reverse_row["reverse_routing_version"] != preimage_row["old_routing_version"]
        ):
            raise ApplyBlocked("mapping_reverse_value_mismatch")
    return payload


def verify_sync_job_paused(sync_job_id: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{12}", sync_job_id):
        raise ApplyBlocked("sync_job_id_invalid")
    result = subprocess.run(
        ["hermes", "cron", "list", "--all"], cwd=ROOT, text=True, capture_output=True, timeout=30,
    )
    if result.returncode != 0 or not re.search(rf"^\s{{2}}{re.escape(sync_job_id)} \[paused\]\s*$", result.stdout, re.M):
        raise ApplyBlocked("sync_job_not_paused")


def transactional_receipt_exists(artifact_sha256: str, direction: str, quiesce_nonce: str) -> bool:
    query = (
        "SELECT count(*) FROM telegram_reclassification_runs "
        f"WHERE artifact_sha256='{artifact_sha256}' AND direction='{direction}' "
        f"AND quiesce_nonce='{uuid.UUID(quiesce_nonce)}';\n"
    )
    try:
        result = subprocess.run(
            sync.psql_cmd("-q", "-t", "-A"), cwd=ROOT, input=query,
            text=True, capture_output=True, timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise CommitOutcomeUnknown("transaction_receipt_readback_timeout") from exc
    if result.returncode != 0:
        raise CommitOutcomeUnknown("transaction_receipt_readback_failed")
    lines = result.stdout.splitlines()
    if len(lines) != 1 or lines[0] not in {"0", "1"}:
        raise CommitOutcomeUnknown("transaction_receipt_readback_invalid_shape")
    return lines[0] == "1"


def verify_fresh_snapshot(artifact: dict[str, Any]) -> None:
    manual_rows = artifact.get("manual_adjudications")
    if not isinstance(manual_rows, list):
        raise ApplyBlocked("manual_adjudication_plan_invalid")
    try:
        manual_adjudications = [preview.ManualAdjudication(**row) for row in manual_rows]
    except (TypeError, ValueError) as exc:
        raise ApplyBlocked("manual_adjudication_plan_invalid") from exc
    imports_a, app_a, routes_a = preview.load_app_snapshot()
    raw_sources_a, source_a = preview.load_source_identities(imports_a)
    imports_b, app_b, routes_b = preview.load_app_snapshot()
    raw_sources_b, source_b = preview.load_source_identities(imports_b)
    fingerprints_a = preview.load_manual_session_fingerprints(imports_a) if manual_adjudications else {}
    fingerprints_b = preview.load_manual_session_fingerprints(imports_b) if manual_adjudications else {}
    sources_a = preview.apply_manual_adjudications(
        sources=raw_sources_a, adjudications=manual_adjudications,
        session_fingerprints=fingerprints_a, routes=routes_a,
        approved_chat_id=sync.APPROVED_CHAT_ID,
    )
    sources_b = preview.apply_manual_adjudications(
        sources=raw_sources_b, adjudications=manual_adjudications,
        session_fingerprints=fingerprints_b, routes=routes_b,
        approved_chat_id=sync.APPROVED_CHAT_ID,
    )
    if (
        app_a != app_b or imports_a != imports_b or routes_a != routes_b
        or source_a != source_b or raw_sources_a != raw_sources_b
        or fingerprints_a != fingerprints_b or sources_a != sources_b
    ):
        raise ApplyBlocked("fresh_snapshot_unstable")
    fresh = preview.build_preview(
        imports=imports_a, sources=sources_a, routes=routes_a,
        approved_chat_id=sync.APPROVED_CHAT_ID, source_watermark=source_a, app_watermark=app_a,
        manual_adjudications=manual_adjudications,
        manual_adjudication_artifact_sha256=artifact.get("manual_adjudication_artifact_sha256"),
    )
    if fresh.get("apply_blocked") or fresh.get("apply_blockers"):
        raise ApplyBlocked("fresh_snapshot_apply_blocked")
    comparisons = (
        (fresh.get("source_watermark", {}).get("identity_hash"), artifact.get("source_watermark", {}).get("identity_hash")),
        (fresh.get("app_watermark", {}).get("snapshot_hash"), artifact.get("app_watermark", {}).get("snapshot_hash")),
        (fresh.get("app_watermark", {}).get("route_snapshot_hash"), artifact.get("app_watermark", {}).get("route_snapshot_hash")),
        (fresh.get("preimage_hash"), artifact.get("preimage_hash")),
        (fresh.get("mapping_hash"), artifact.get("mapping_hash")),
        (fresh.get("reverse_plan_hash"), artifact.get("reverse_plan_hash")),
        (fresh.get("manual_adjudication_hash"), artifact.get("manual_adjudication_hash")),
        (
            fresh.get("manual_adjudication_artifact_sha256"),
            artifact.get("manual_adjudication_artifact_sha256"),
        ),
    )
    if any(current != approved for current, approved in comparisons):
        raise ApplyBlocked("fresh_snapshot_mismatch")


def _sql_rows(reverse_plan: list[dict[str, Any]], *, direction: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in reverse_plan:
        if not isinstance(raw, dict) or set(raw) != REVERSE_FIELDS:
            raise ApplyBlocked("reverse_plan_row_invalid")
        if direction == "apply":
            old_thread = raw["reverse_target_thread_id"]
            new_thread = raw["expected_current_thread_id"]
            old_workspace, old_project = raw["reverse_workspace_id"], raw["reverse_project_id"]
            old_channel, old_topic = raw["reverse_channel_id"], raw["reverse_topic_id"]
            new_workspace, new_project = raw["expected_current_workspace_id"], raw["expected_current_project_id"]
            new_channel, new_topic = raw["expected_current_channel_id"], raw["expected_current_topic_id"]
            old_chat = raw["reverse_telegram_chat_id"]
            new_chat = raw["expected_current_telegram_chat_id"]
            old_telegram_thread = raw["reverse_telegram_thread_id"]
            new_telegram_thread = raw["expected_current_telegram_thread_id"]
            old_target = raw["reverse_target_web_thread_id"]
            new_target = raw["expected_current_target_web_thread_id"]
            old_version = raw["reverse_routing_version"]
            new_version = raw["expected_current_routing_version"]
        else:
            old_thread = raw["expected_current_thread_id"]
            new_thread = raw["reverse_target_thread_id"]
            old_workspace, old_project = raw["expected_current_workspace_id"], raw["expected_current_project_id"]
            old_channel, old_topic = raw["expected_current_channel_id"], raw["expected_current_topic_id"]
            new_workspace, new_project = raw["reverse_workspace_id"], raw["reverse_project_id"]
            new_channel, new_topic = raw["reverse_channel_id"], raw["reverse_topic_id"]
            old_chat = raw["expected_current_telegram_chat_id"]
            new_chat = raw["reverse_telegram_chat_id"]
            old_telegram_thread = raw["expected_current_telegram_thread_id"]
            new_telegram_thread = raw["reverse_telegram_thread_id"]
            old_target = raw["expected_current_target_web_thread_id"]
            new_target = raw["reverse_target_web_thread_id"]
            old_version = raw["expected_current_routing_version"]
            new_version = raw["reverse_routing_version"]
        if not isinstance(old_thread, str) or not old_thread or not isinstance(new_thread, str) or not new_thread:
            raise ApplyBlocked("plan_thread_id_invalid")
        if direction == "apply" and any(
            not isinstance(value, str) or not value
            for value in (new_chat, new_telegram_thread, new_target, new_version)
        ):
            raise ApplyBlocked("apply_provenance_target_invalid")
        rows.append({
            "source_session_id": raw["source_session_id"],
            "source_message_id": raw["source_message_id"],
            "web_message_id": raw["web_message_id"],
            "old_thread_id": old_thread,
            "new_thread_id": new_thread,
            "old_workspace_id": old_workspace,
            "old_project_id": old_project,
            "old_channel_id": old_channel,
            "old_topic_id": old_topic,
            "new_workspace_id": new_workspace,
            "new_project_id": new_project,
            "new_channel_id": new_channel,
            "new_topic_id": new_topic,
            "old_chat_id": old_chat,
            "new_chat_id": new_chat,
            "old_telegram_thread_id": old_telegram_thread,
            "new_telegram_thread_id": new_telegram_thread,
            "old_target_web_thread_id": old_target,
            "new_target_web_thread_id": new_target,
            "old_routing_version": old_version,
            "new_routing_version": new_version,
        })
    if len({(row["source_session_id"], row["source_message_id"]) for row in rows}) != len(rows):
        raise ApplyBlocked("duplicate_source_key")
    if len({row["web_message_id"] for row in rows}) != len(rows):
        raise ApplyBlocked("duplicate_web_message_id")
    return rows


def build_sql(
    reverse_plan: list[dict[str, Any]], *, direction: str, commit: bool,
    artifact: dict[str, Any] | None = None, artifact_sha256: str | None = None,
    sync_job_id: str | None = None, quiesce_nonce: str | None = None,
) -> str:
    if direction not in {"apply", "reverse"}:
        raise ValueError("direction must be apply or reverse")
    rows = _sql_rows(reverse_plan, direction=direction)
    payload = base64.b64encode(
        json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    ledger_sql = ""
    if commit:
        if artifact is None or artifact_sha256 is None or sync_job_id is None or quiesce_nonce is None:
            raise ApplyBlocked("commit_ledger_metadata_missing")
        hashes = {
            "artifact_sha256": artifact_sha256,
            "mapping_hash": artifact.get("mapping_hash"),
            "reverse_plan_hash": artifact.get("reverse_plan_hash"),
            "source_identity_hash": artifact.get("source_watermark", {}).get("identity_hash"),
            "app_snapshot_hash": artifact.get("app_watermark", {}).get("snapshot_hash"),
            "route_snapshot_hash": artifact.get("app_watermark", {}).get("route_snapshot_hash"),
        }
        if any(not isinstance(value, str) or len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value) for value in hashes.values()):
            raise ApplyBlocked("commit_ledger_hash_invalid")
        if len(sync_job_id) != 12 or any(ch not in "0123456789abcdef" for ch in sync_job_id):
            raise ApplyBlocked("commit_sync_job_id_invalid")
        try:
            nonce = str(uuid.UUID(quiesce_nonce))
        except ValueError as exc:
            raise ApplyBlocked("commit_quiesce_nonce_invalid") from exc
        reverse_precondition = ""
        if direction == "reverse":
            reverse_precondition = f"""
DO $receipt_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM telegram_reclassification_runs
    WHERE artifact_sha256='{hashes['artifact_sha256']}' AND direction='apply'
  ) THEN RAISE EXCEPTION 'v3_reclassification_prior_apply_receipt_missing'; END IF;
END
$receipt_guard$;
"""
        ledger_sql = f"""
{reverse_precondition}
INSERT INTO telegram_reclassification_runs(
  artifact_sha256,direction,mapping_hash,reverse_plan_hash,source_identity_hash,
  app_snapshot_hash,route_snapshot_hash,row_count,sync_job_id,quiesce_nonce
) VALUES (
  '{hashes['artifact_sha256']}','{direction}','{hashes['mapping_hash']}',
  '{hashes['reverse_plan_hash']}','{hashes['source_identity_hash']}',
  '{hashes['app_snapshot_hash']}','{hashes['route_snapshot_hash']}',
  {len(rows)},'{sync_job_id}','{nonce}'
);
"""
    terminator = "COMMIT" if commit else "ROLLBACK"
    return f"""\
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('{ADVISORY_KEY}', 0));
CREATE TEMP TABLE v3_reclassification_plan ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset(convert_from(decode('{payload}', 'base64'), 'UTF8')::jsonb) AS row(
  source_session_id text,
  source_message_id bigint,
  web_message_id uuid,
  old_thread_id uuid,
  new_thread_id uuid,
  old_workspace_id uuid,
  old_project_id uuid,
  old_channel_id uuid,
  old_topic_id uuid,
  new_workspace_id uuid,
  new_project_id uuid,
  new_channel_id uuid,
  new_topic_id uuid,
  old_chat_id text,
  new_chat_id text,
  old_telegram_thread_id text,
  new_telegram_thread_id text,
  old_target_web_thread_id uuid,
  new_target_web_thread_id uuid,
  old_routing_version text,
  new_routing_version text
);
DO $body$
DECLARE
  expected_count integer; changed_messages integer; changed_ledger integer; verified_count integer;
  scope_count integer; locked_parent_count integer; locked_old_route_count integer;
  locked_new_route_count integer; expected_old_route_count integer; expected_new_route_count integer;
  locked_message_count integer;
BEGIN
  SELECT count(*) INTO expected_count FROM v3_reclassification_plan;
  IF expected_count = 0 THEN RAISE EXCEPTION 'v3_reclassification_empty_plan'; END IF;
  PERFORM 1
  FROM v3_reclassification_plan plan
  JOIN threads old_thread ON old_thread.id=plan.old_thread_id AND old_thread.workspace_id=plan.old_workspace_id
  JOIN topics old_topic ON old_topic.id=plan.old_topic_id AND old_topic.id=old_thread.topic_id AND old_topic.workspace_id=plan.old_workspace_id
  JOIN channels old_channel ON old_channel.id=plan.old_channel_id AND old_channel.id=old_topic.channel_id AND old_channel.workspace_id=plan.old_workspace_id
  JOIN projects old_project ON old_project.id=plan.old_project_id AND old_project.id=old_channel.project_id AND old_project.workspace_id=plan.old_workspace_id
  JOIN workspaces old_workspace ON old_workspace.id=plan.old_workspace_id
  JOIN threads new_thread ON new_thread.id=plan.new_thread_id AND new_thread.workspace_id=plan.new_workspace_id
  JOIN topics new_topic ON new_topic.id=plan.new_topic_id AND new_topic.id=new_thread.topic_id AND new_topic.workspace_id=plan.new_workspace_id
  JOIN channels new_channel ON new_channel.id=plan.new_channel_id AND new_channel.id=new_topic.channel_id AND new_channel.workspace_id=plan.new_workspace_id
  JOIN projects new_project ON new_project.id=plan.new_project_id AND new_project.id=new_channel.project_id AND new_project.workspace_id=plan.new_workspace_id
  JOIN workspaces new_workspace ON new_workspace.id=plan.new_workspace_id
  WHERE old_workspace.status='active' AND old_workspace.deleted_at IS NULL
    AND new_workspace.status='active' AND new_workspace.deleted_at IS NULL
    AND old_thread.status='active' AND old_thread.deleted_at IS NULL
    AND old_topic.status='active' AND old_topic.deleted_at IS NULL
    AND old_channel.status='active' AND old_channel.deleted_at IS NULL
    AND old_project.status='active' AND old_project.deleted_at IS NULL
    AND new_thread.status='active' AND new_thread.deleted_at IS NULL
    AND new_topic.status='active' AND new_topic.deleted_at IS NULL
    AND new_channel.status='active' AND new_channel.deleted_at IS NULL
    AND new_project.status='active' AND new_project.deleted_at IS NULL
    AND old_thread.workspace_id=new_thread.workspace_id AND old_project.id=new_project.id
    AND old_topic.workspace_id=old_thread.workspace_id
    AND old_channel.workspace_id=old_thread.workspace_id
    AND old_project.workspace_id=old_thread.workspace_id
    AND new_topic.workspace_id=new_thread.workspace_id
    AND new_channel.workspace_id=new_thread.workspace_id
    AND new_project.workspace_id=new_thread.workspace_id
  FOR SHARE OF old_workspace,old_thread,old_topic,old_channel,old_project,new_workspace,new_thread,new_topic,new_channel,new_project;
  GET DIAGNOSTICS locked_parent_count = ROW_COUNT;
  IF locked_parent_count <> expected_count THEN RAISE EXCEPTION 'v3_reclassification_parent_lock_mismatch'; END IF;

  SELECT count(*) INTO expected_old_route_count FROM v3_reclassification_plan WHERE old_chat_id IS NOT NULL;
  PERFORM 1 FROM v3_reclassification_plan plan
  JOIN threads old_thread ON old_thread.id=plan.old_thread_id AND old_thread.workspace_id=plan.old_workspace_id
  JOIN topics old_topic ON old_topic.id=plan.old_topic_id AND old_topic.id=old_thread.topic_id AND old_topic.workspace_id=plan.old_workspace_id
  JOIN channels old_channel ON old_channel.id=plan.old_channel_id AND old_channel.id=old_topic.channel_id AND old_channel.workspace_id=plan.old_workspace_id
  JOIN projects old_project ON old_project.id=plan.old_project_id AND old_project.id=old_channel.project_id AND old_project.workspace_id=plan.old_workspace_id
  JOIN workspaces old_workspace ON old_workspace.id=plan.old_workspace_id
  JOIN telegram_topic_links link ON link.thread_id=plan.old_thread_id
  WHERE plan.old_chat_id IS NOT NULL AND link.status='active'
    AND link.telegram_chat_id=plan.old_chat_id AND link.telegram_thread_id=plan.old_telegram_thread_id
    AND link.workspace_id=old_thread.workspace_id AND link.project_id=old_project.id
    AND link.channel_id=old_channel.id AND link.web_topic_id=old_topic.id
  FOR SHARE OF link;
  GET DIAGNOSTICS locked_old_route_count = ROW_COUNT;
  IF locked_old_route_count <> expected_old_route_count THEN RAISE EXCEPTION 'v3_reclassification_old_route_lock_mismatch'; END IF;

  SELECT count(*) INTO expected_new_route_count FROM v3_reclassification_plan WHERE new_chat_id IS NOT NULL;
  PERFORM 1 FROM v3_reclassification_plan plan
  JOIN threads new_thread ON new_thread.id=plan.new_thread_id AND new_thread.workspace_id=plan.new_workspace_id
  JOIN topics new_topic ON new_topic.id=plan.new_topic_id AND new_topic.id=new_thread.topic_id AND new_topic.workspace_id=plan.new_workspace_id
  JOIN channels new_channel ON new_channel.id=plan.new_channel_id AND new_channel.id=new_topic.channel_id AND new_channel.workspace_id=plan.new_workspace_id
  JOIN projects new_project ON new_project.id=plan.new_project_id AND new_project.id=new_channel.project_id AND new_project.workspace_id=plan.new_workspace_id
  JOIN workspaces new_workspace ON new_workspace.id=plan.new_workspace_id
  JOIN telegram_topic_links link ON link.thread_id=plan.new_thread_id
  WHERE plan.new_chat_id IS NOT NULL AND link.status='active'
    AND link.telegram_chat_id=plan.new_chat_id AND link.telegram_thread_id=plan.new_telegram_thread_id
    AND link.workspace_id=new_thread.workspace_id AND link.project_id=new_project.id
    AND link.channel_id=new_channel.id AND link.web_topic_id=new_topic.id
  FOR SHARE OF link;
  GET DIAGNOSTICS locked_new_route_count = ROW_COUNT;
  IF locked_new_route_count <> expected_new_route_count THEN RAISE EXCEPTION 'v3_reclassification_new_route_lock_mismatch'; END IF;

  SELECT count(*) INTO scope_count
  FROM v3_reclassification_plan plan
  JOIN threads old_thread ON old_thread.id=plan.old_thread_id AND old_thread.workspace_id=plan.old_workspace_id
  JOIN topics old_topic ON old_topic.id=plan.old_topic_id AND old_topic.id=old_thread.topic_id AND old_topic.workspace_id=plan.old_workspace_id
  JOIN channels old_channel ON old_channel.id=plan.old_channel_id AND old_channel.id=old_topic.channel_id AND old_channel.workspace_id=plan.old_workspace_id
  JOIN projects old_project ON old_project.id=plan.old_project_id AND old_project.id=old_channel.project_id AND old_project.workspace_id=plan.old_workspace_id
  JOIN workspaces old_workspace ON old_workspace.id=plan.old_workspace_id
  JOIN threads new_thread ON new_thread.id=plan.new_thread_id AND new_thread.workspace_id=plan.new_workspace_id
  JOIN topics new_topic ON new_topic.id=plan.new_topic_id AND new_topic.id=new_thread.topic_id AND new_topic.workspace_id=plan.new_workspace_id
  JOIN channels new_channel ON new_channel.id=plan.new_channel_id AND new_channel.id=new_topic.channel_id AND new_channel.workspace_id=plan.new_workspace_id
  JOIN projects new_project ON new_project.id=plan.new_project_id AND new_project.id=new_channel.project_id AND new_project.workspace_id=plan.new_workspace_id
  JOIN workspaces new_workspace ON new_workspace.id=plan.new_workspace_id
  WHERE old_workspace.status='active' AND old_workspace.deleted_at IS NULL
    AND new_workspace.status='active' AND new_workspace.deleted_at IS NULL
    AND old_thread.status='active' AND old_thread.deleted_at IS NULL
    AND old_topic.status='active' AND old_topic.deleted_at IS NULL
    AND old_channel.status='active' AND old_channel.deleted_at IS NULL
    AND old_project.status='active' AND old_project.deleted_at IS NULL
    AND new_thread.status='active' AND new_thread.deleted_at IS NULL
    AND new_topic.status='active' AND new_topic.deleted_at IS NULL
    AND new_channel.status='active' AND new_channel.deleted_at IS NULL
    AND new_project.status='active' AND new_project.deleted_at IS NULL
    AND old_thread.workspace_id=new_thread.workspace_id
    AND old_project.id=new_project.id
    AND old_topic.workspace_id=old_thread.workspace_id
    AND old_channel.workspace_id=old_thread.workspace_id
    AND old_project.workspace_id=old_thread.workspace_id
    AND new_topic.workspace_id=new_thread.workspace_id
    AND new_channel.workspace_id=new_thread.workspace_id
    AND new_project.workspace_id=new_thread.workspace_id
    AND (plan.old_target_web_thread_id IS NULL OR plan.old_target_web_thread_id=plan.old_thread_id)
    AND (
      (plan.old_chat_id IS NULL AND plan.old_telegram_thread_id IS NULL
       AND plan.old_target_web_thread_id IS NULL AND plan.old_routing_version IS NULL)
      OR EXISTS (
        SELECT 1 FROM telegram_topic_links old_link
        WHERE old_link.thread_id=plan.old_thread_id AND old_link.status='active'
          AND old_link.telegram_chat_id=plan.old_chat_id
          AND old_link.telegram_thread_id=plan.old_telegram_thread_id
          AND old_link.workspace_id=old_thread.workspace_id
          AND old_link.project_id=old_project.id
          AND old_link.channel_id=old_channel.id
          AND old_link.web_topic_id=old_topic.id
      )
    )
    AND (plan.new_target_web_thread_id IS NULL OR plan.new_target_web_thread_id=plan.new_thread_id)
    AND (
      (plan.new_chat_id IS NULL AND plan.new_telegram_thread_id IS NULL
       AND plan.new_target_web_thread_id IS NULL AND plan.new_routing_version IS NULL)
      OR EXISTS (
        SELECT 1 FROM telegram_topic_links link
        WHERE link.thread_id=plan.new_thread_id AND link.status='active'
          AND link.telegram_chat_id=plan.new_chat_id
          AND link.telegram_thread_id=plan.new_telegram_thread_id
          AND link.workspace_id=new_thread.workspace_id
          AND link.project_id=new_project.id
          AND link.channel_id=new_channel.id
          AND link.web_topic_id=new_topic.id
      )
    );
  IF scope_count <> expected_count THEN RAISE EXCEPTION 'v3_reclassification_target_scope_or_route_mismatch'; END IF;

  PERFORM 1 FROM chat_messages message
  JOIN v3_reclassification_plan plan ON plan.web_message_id=message.id
  WHERE message.workspace_id=plan.old_workspace_id
    AND message.thread_id IS NOT DISTINCT FROM plan.old_thread_id AND message.deleted_at IS NULL
  FOR UPDATE OF message;
  GET DIAGNOSTICS locked_message_count = ROW_COUNT;
  IF locked_message_count <> expected_count THEN
    RAISE EXCEPTION 'v3_reclassification_message_lock_mismatch';
  END IF;
  IF (SELECT count(*) FROM chat_messages message JOIN v3_reclassification_plan plan ON plan.web_message_id=message.id
      WHERE message.workspace_id=plan.old_workspace_id
        AND message.thread_id IS NOT DISTINCT FROM plan.old_thread_id AND message.deleted_at IS NULL) <> expected_count THEN
    RAISE EXCEPTION 'v3_reclassification_message_preimage_mismatch';
  END IF;
  IF (SELECT count(*) FROM telegram_message_imports ledger JOIN v3_reclassification_plan plan
      ON plan.source_session_id=ledger.source_session_id AND plan.source_message_id=ledger.source_message_id
      WHERE ledger.web_message_id=plan.web_message_id
        AND ledger.telegram_chat_id IS NOT DISTINCT FROM plan.old_chat_id
        AND ledger.telegram_thread_id IS NOT DISTINCT FROM plan.old_telegram_thread_id
        AND ledger.target_web_thread_id IS NOT DISTINCT FROM plan.old_target_web_thread_id
        AND ledger.routing_version IS NOT DISTINCT FROM plan.old_routing_version) <> expected_count THEN
    RAISE EXCEPTION 'v3_reclassification_ledger_preimage_mismatch';
  END IF;
  UPDATE chat_messages message SET workspace_id=plan.new_workspace_id, thread_id=plan.new_thread_id
  FROM v3_reclassification_plan plan WHERE message.id=plan.web_message_id
    AND message.workspace_id=plan.old_workspace_id
    AND message.thread_id IS NOT DISTINCT FROM plan.old_thread_id AND message.deleted_at IS NULL;
  GET DIAGNOSTICS changed_messages = ROW_COUNT;
  UPDATE telegram_message_imports ledger SET
    telegram_chat_id=plan.new_chat_id,
    telegram_thread_id=plan.new_telegram_thread_id,
    target_web_thread_id=plan.new_target_web_thread_id,
    routing_version=plan.new_routing_version
  FROM v3_reclassification_plan plan
  WHERE ledger.source_session_id=plan.source_session_id AND ledger.source_message_id=plan.source_message_id
    AND ledger.web_message_id=plan.web_message_id
    AND ledger.telegram_chat_id IS NOT DISTINCT FROM plan.old_chat_id
    AND ledger.telegram_thread_id IS NOT DISTINCT FROM plan.old_telegram_thread_id
    AND ledger.target_web_thread_id IS NOT DISTINCT FROM plan.old_target_web_thread_id
    AND ledger.routing_version IS NOT DISTINCT FROM plan.old_routing_version;
  GET DIAGNOSTICS changed_ledger = ROW_COUNT;
  IF changed_messages <> expected_count OR changed_ledger <> expected_count THEN
    RAISE EXCEPTION 'v3_reclassification_affected_row_mismatch messages=% ledger=% expected=%', changed_messages, changed_ledger, expected_count;
  END IF;
  SELECT count(*) INTO verified_count FROM v3_reclassification_plan plan
  JOIN chat_messages message ON message.id=plan.web_message_id
  JOIN telegram_message_imports ledger ON ledger.source_session_id=plan.source_session_id AND ledger.source_message_id=plan.source_message_id
  WHERE message.workspace_id=plan.new_workspace_id
    AND message.thread_id IS NOT DISTINCT FROM plan.new_thread_id
    AND ledger.web_message_id=plan.web_message_id
    AND ledger.telegram_chat_id IS NOT DISTINCT FROM plan.new_chat_id
    AND ledger.telegram_thread_id IS NOT DISTINCT FROM plan.new_telegram_thread_id
    AND ledger.target_web_thread_id IS NOT DISTINCT FROM plan.new_target_web_thread_id
    AND ledger.routing_version IS NOT DISTINCT FROM plan.new_routing_version;
  IF verified_count <> expected_count THEN RAISE EXCEPTION 'v3_reclassification_readback_mismatch'; END IF;
  RAISE NOTICE 'v3_reclassification_ok direction={direction} rows=%', expected_count;
END
$body$;
{ledger_sql}
{terminator};
"""


def atomic_write_receipt(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temp.exists():
            temp.unlink()


def _quarantine_failed_standard_stream(stream: Any) -> None:
    names = [
        name for name in ("stdout", "__stdout__", "stderr", "__stderr__")
        if getattr(sys, name, None) is stream
    ]
    if not names:
        return
    try:
        replacement = open(os.devnull, "w", encoding="utf-8")
    except OSError:
        return
    for name in names:
        setattr(sys, name, replacement)


def emit_json(payload: dict[str, Any], *, stream: Any | None = None) -> bool:
    output = sys.stdout if stream is None else stream
    try:
        output.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
        output.flush()
        return True
    except (OSError, ValueError):
        _quarantine_failed_standard_stream(output)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Guarded V3-7 Telegram mirror reclassification apply/reverse")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--approved-sha256", required=True)
    parser.add_argument("--direction", choices=("apply", "reverse"), required=True)
    parser.add_argument("--sync-job-id")
    parser.add_argument("--quiesce-nonce")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        artifact = load_approved_artifact(
            args.artifact, args.approved_sha256, allow_expired=args.direction == "reverse",
        )
        if args.commit:
            if args.receipt is None or args.sync_job_id is None or args.quiesce_nonce is None:
                raise ApplyBlocked("commit_requires_receipt_job_id_and_nonce")
            verify_sync_job_paused(args.sync_job_id)
            if args.direction == "apply":
                verify_fresh_snapshot(artifact)
        sql = build_sql(
            artifact["reverse_plan"], direction=args.direction, commit=args.commit,
            artifact=artifact, artifact_sha256=args.approved_sha256,
            sync_job_id=args.sync_job_id, quiesce_nonce=args.quiesce_nonce,
        )
        transaction_recovered_from_ledger = False
        try:
            result = subprocess.run(
                sync.psql_cmd(), cwd=ROOT, input=sql, text=True, capture_output=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            if not args.commit:
                raise CommitOutcomeUnknown("database_transaction_timeout")
            if transactional_receipt_exists(args.approved_sha256, args.direction, args.quiesce_nonce):
                result = None
                transaction_recovered_from_ledger = True
            else:
                raise CommitOutcomeUnknown("database_transaction_timeout_receipt_absent")
        if result is not None and result.returncode != 0:
            if not args.commit:
                raise ApplyBlocked(f"database_transaction_failed:{result.stderr.strip()[-500:]}")
            if transactional_receipt_exists(args.approved_sha256, args.direction, args.quiesce_nonce):
                transaction_recovered_from_ledger = True
            else:
                raise CommitOutcomeUnknown("database_transaction_nonzero_receipt_absent")
        receipt = {
            "schema_version": "v3-7-receipt-1.0",
            "artifact_sha256": args.approved_sha256,
            "direction": args.direction,
            "committed": args.commit,
            "row_count": len(artifact["reverse_plan"]),
            "sync_job_id": args.sync_job_id,
            "quiesce_nonce": args.quiesce_nonce,
            "mapping_hash": artifact["mapping_hash"],
            "reverse_plan_hash": artifact["reverse_plan_hash"],
            "transaction_recovered_from_ledger": transaction_recovered_from_ledger,
            "completed_at": datetime.now(UTC).isoformat(),
        }
        if args.receipt:
            try:
                atomic_write_receipt(args.receipt, receipt)
            except OSError as exc:
                if args.commit:
                    emit_json({
                        **receipt, "receipt_error": f"{type(exc).__name__}:{exc.errno}",
                    }, stream=sys.stderr)
                    return 3
                raise
        if not emit_json(receipt):
            if args.commit:
                emit_json({**receipt, "output_error": "stdout_write_failed"}, stream=sys.stderr)
                return 3
            raise OSError("stdout_write_failed")
        return 0
    except CommitOutcomeUnknown as exc:
        print(json.dumps({"committed": None, "error": str(exc)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 4
    except (ApplyBlocked, OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"applied": False, "error": str(exc)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
