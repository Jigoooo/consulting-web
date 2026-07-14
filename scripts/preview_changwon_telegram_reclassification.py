#!/usr/bin/env python3
"""Fail-closed read-only preview for legacy Changwon Telegram → Web reclassification."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import sync_changwon_telegram as sync  # noqa: E402

READ_ONLY_ROLE = "consulting_preview_ro"
APPLY_ROUTING_VERSION = "v3-reclassification-v1"


@dataclass(frozen=True)
class ImportRow:
    source_session_id: str
    source_message_id: int
    web_message_id: str
    old_thread_id: str
    role: str
    imported_at: str
    created_at: str
    content_sha256: str
    old_telegram_chat_id: str | None
    old_telegram_thread_id: str | None
    old_target_web_thread_id: str | None
    old_routing_version: str | None
    old_workspace_id: str = "11111111-1111-4111-8111-111111111111"
    old_project_id: str = "22222222-2222-4222-8222-222222222222"
    old_channel_id: str = "33333333-3333-4333-8333-333333333333"
    old_topic_id: str = "44444444-4444-4444-8444-444444444444"
    app_scope_valid: bool = True


@dataclass(frozen=True)
class SourceIdentity:
    source: str
    telegram_chat_id: str | None
    telegram_thread_id: str | None
    role: str
    active: bool
    compacted: bool
    timestamp: float
    content_sha256: str


@dataclass(frozen=True)
class RouteIdentity:
    target_thread_id: str
    active: bool
    workspace_id: str = "11111111-1111-4111-8111-111111111111"
    project_id: str = "22222222-2222-4222-8222-222222222222"
    channel_id: str = "33333333-3333-4333-8333-333333333333"
    topic_id: str = "44444444-4444-4444-8444-444444444444"


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _append_blocker(result: dict[str, Any], blocker: str) -> None:
    blockers = set(result.get("apply_blockers", []))
    blockers.add(blocker)
    result["apply_blockers"] = sorted(blockers)
    result["apply_blocked"] = True


def artifact_privacy_violations(payload: Any) -> list[str]:
    violations: set[str] = set()
    email = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
    phone = re.compile(r"(?<!\d)(?:\+?82[-\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)")
    allowed_top_level = {
        "schema_version", "mode", "approved_chat_id", "source_watermark", "app_watermark",
        "fixed_set", "classification_counts", "target_move_counts", "role_counts",
        "source_role_counts", "matched_app_role_counts", "source_app_role_mismatches",
        "duplicate_source_keys", "duplicate_web_message_ids", "source_content_hash_mismatches",
        "apply_blocked", "apply_blockers", "app_preimage_hash", "preimage_hash", "mapping_hash", "reverse_plan_hash",
        "preimage", "mapping", "reverse_plan", "invariants", "snapshot_fence", "generated_at",
        "privacy_violations",
    }
    forbidden_fields = {"content", "text", "prompt", "answer", "query", "state_db_path", "email", "phone"}

    if isinstance(payload, dict) and "schema_version" in payload:
        if set(payload) != allowed_top_level:
            violations.add("top_level_field_allowlist")
        if payload.get("schema_version") != "v3-5-preview-3.0" or payload.get("mode") != "read_only_preview":
            violations.add("artifact_contract_version")

    schemas = {
        "source_watermark": {"source_label", "matched_legacy_source_count", "max_message_id", "identity_hash"},
        "app_watermark": {"import_count", "legacy_import_count", "max_imported_at", "distinct_source_sessions", "snapshot_hash", "route_snapshot_hash", "approved_chat_link_thread_ids"},
        "fixed_set": {"legacy_import_count", "distinct_source_sessions", "app_preimage_hash", "preimage_hash", "mapping_hash", "reverse_plan_hash"},
        "preimage": {
            "source_session_id", "source_message_id", "web_message_id", "old_thread_id", "role",
            "old_workspace_id", "old_project_id", "old_channel_id", "old_topic_id",
            "imported_at", "created_at", "content_sha256", "old_telegram_chat_id",
            "old_telegram_thread_id", "old_target_web_thread_id", "old_routing_version",
            "source_identity_hash", "approved_source", "telegram_thread_id", "classification",
            "target_thread_id", "app_scope_valid",
        },
        "mapping": {
            "source_session_id", "source_message_id", "web_message_id", "old_thread_id",
            "classification", "target_thread_id", "proposed_telegram_chat_id",
            "proposed_telegram_thread_id", "proposed_target_web_thread_id", "proposed_routing_version",
        },
        "reverse_plan": {
            "web_message_id", "expected_current_thread_id", "reverse_target_thread_id",
            "expected_current_workspace_id", "expected_current_project_id",
            "expected_current_channel_id", "expected_current_topic_id",
            "reverse_workspace_id", "reverse_project_id", "reverse_channel_id", "reverse_topic_id",
            "source_session_id", "source_message_id", "expected_current_telegram_chat_id",
            "expected_current_telegram_thread_id", "expected_current_target_web_thread_id",
            "expected_current_routing_version", "reverse_telegram_chat_id",
            "reverse_telegram_thread_id", "reverse_target_web_thread_id", "reverse_routing_version",
        },
        "invariants": {
            "fixed_set_nonempty", "classification_total_matches_fixed_set",
            "preimage_count_matches_fixed_set", "app_legacy_count_matches_fixed_set",
            "source_match_count_matches_loaded_sources", "source_keys_unique",
            "web_message_ids_unique", "source_content_hashes_match_app",
            "source_roles_match_app_rows", "source_app_role_counts_match",
            "app_rows_match_target_scope",
            "reverse_plan_covers_all_planned_updates",
        },
        "snapshot_fence": {"app_stable", "source_stable"},
    }

    if isinstance(payload, dict) and "schema_version" in payload:
        list_containers = {"preimage", "mapping", "reverse_plan"}
        for container, allowed_keys in schemas.items():
            value = payload.get(container)
            if container in list_containers:
                if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
                    violations.add(f"{container}_container_type")
                    continue
                rows = value
            else:
                if not isinstance(value, dict):
                    violations.add(f"{container}_container_type")
                    continue
                rows = [value]
            for row in rows:
                if set(row) != allowed_keys:
                    violations.add(f"{container}_field_allowlist")
        hash_fields = {
            "app_preimage_hash", "preimage_hash", "mapping_hash", "reverse_plan_hash",
            "identity_hash", "snapshot_hash", "route_snapshot_hash", "content_sha256",
            "source_identity_hash",
        }
        count_fields = {
            "import_count", "legacy_import_count", "distinct_source_sessions",
            "matched_legacy_source_count", "source_message_id",
            "source_app_role_mismatches",
        }

        def validate_formats(value: Any, key: str | None = None) -> None:
            if isinstance(value, dict):
                for child_key, item in value.items():
                    validate_formats(item, str(child_key))
            elif isinstance(value, list):
                for item in value:
                    validate_formats(item, key)
            elif key in hash_fields and value is not None and (
                not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value, re.I) is None
            ):
                violations.add("hash_value_format")
            elif key in count_fields and (not isinstance(value, int) or isinstance(value, bool) or value < 0):
                violations.add("count_value_format")

        validate_formats(payload)

        allowed_classifications = {
            "exact", "general", "unknown_to_general", "foreign_chat", "unproven_chat",
            "source_missing", "registered_target_unavailable", "general_target_unavailable",
            "route_blocked", "route_drift", "foreign_app_scope",
        }
        allowed_roles = {"user", "assistant"}
        allowed_blockers = {
            "foreign_chat", "unproven_chat", "source_missing", "registered_target_unavailable",
            "general_target_unavailable", "route_blocked", "route_drift", "foreign_app_scope",
            "empty_fixed_set", "app_legacy_count_mismatch", "duplicate_source_key",
            "duplicate_web_message_id", "source_app_content_hash_mismatch",
            "source_app_role_mismatch", "reverse_plan_incomplete", "invariant_failure",
            "app_snapshot_drift", "source_snapshot_drift", "artifact_privacy_violation",
        }

        def validate_count_map(name: str, allowed_keys: set[str]) -> None:
            value = payload.get(name)
            if not isinstance(value, dict) or not set(value).issubset(allowed_keys) or any(
                not isinstance(item, int) or isinstance(item, bool) or item < 0 for item in value.values()
            ):
                violations.add(f"{name}_schema")

        if "schema_version" in payload:
            validate_count_map("classification_counts", allowed_classifications)
            for role_container in ("role_counts", "source_role_counts", "matched_app_role_counts"):
                validate_count_map(role_container, allowed_roles)
            move_counts = payload.get("target_move_counts")
            move_key = re.compile(
                r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}->"
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                re.I,
            )
            if not isinstance(move_counts, dict) or any(
                move_key.fullmatch(str(key)) is None
                or not isinstance(value, int)
                or isinstance(value, bool)
                or value < 0
                for key, value in (move_counts.items() if isinstance(move_counts, dict) else [])
            ):
                violations.add("target_move_counts_schema")
            blockers = payload.get("apply_blockers")
            if not isinstance(blockers, list) or any(
                not isinstance(item, str) or item not in allowed_blockers for item in (blockers or [])
            ):
                violations.add("apply_blockers_schema")
            privacy_items = payload.get("privacy_violations")
            allowed_privacy_violations = {
                "top_level_field_allowlist", "artifact_contract_version", "hash_value_format",
                "count_value_format", "classification_counts_schema", "role_counts_schema",
                "source_role_counts_schema", "matched_app_role_counts_schema",
                "target_move_counts_schema", "apply_blockers_schema", "forbidden_field",
                "sensitive_dictionary_key", "absolute_path", "email", "phone",
            } | {
                f"{container}_{suffix}"
                for container in schemas
                for suffix in ("container_type", "field_allowlist")
            }
            if not isinstance(privacy_items, list) or any(
                not isinstance(item, str) or item not in allowed_privacy_violations
                for item in (privacy_items or [])
            ):
                violations.add("privacy_violations_schema")

    def walk(value: Any, key: str | None = None) -> None:
        if isinstance(value, dict):
            for child_key, item in value.items():
                child_key_text = str(child_key)
                if child_key_text.casefold() in forbidden_fields:
                    violations.add("forbidden_field")
                if (
                    child_key_text.startswith("/home/")
                    or re.match(r"^[A-Za-z]:[\\/]", child_key_text)
                    or email.search(child_key_text)
                    or phone.search(child_key_text)
                ):
                    violations.add("sensitive_dictionary_key")
                walk(item, child_key_text)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item, key)
        elif isinstance(value, str):
            if re.fullmatch(r"[0-9a-f]{64}", value, re.I) or re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value, re.I
            ):
                return
            if value.startswith("/home/") or re.match(r"^[A-Za-z]:[\\/]", value):
                violations.add("absolute_path")
            if email.search(value):
                violations.add("email")
            if phone.search(value):
                violations.add("phone")

    walk(payload)
    return sorted(violations)


def _route_decision(
    source: SourceIdentity,
    routes: dict[str, RouteIdentity],
    approved_chat_id: str,
    approved_chat_link_threads: set[str] | None = None,
) -> tuple[str, str | None, bool]:
    approved_source = source.source == "telegram" and source.telegram_chat_id == approved_chat_id
    if source.source != "telegram" or source.telegram_chat_id is None:
        return "unproven_chat", None, False
    if source.telegram_chat_id != approved_chat_id:
        return "foreign_chat", None, False
    if (
        source.telegram_thread_id not in routes
        and source.telegram_thread_id is not None
        and source.telegram_thread_id in (approved_chat_link_threads or set())
    ):
        return "route_drift", None, approved_source
    route_targets = [
        sync.RouteTarget(approved_chat_id, thread_id, route.target_thread_id, route.active)
        for thread_id, route in routes.items()
    ]
    message = sync.SourceMessage(
        source_session_id="preview",
        source_message_id=0,
        telegram_chat_id=source.telegram_chat_id,
        telegram_thread_id=source.telegram_thread_id,
        role=source.role,
        content="",
        timestamp=source.timestamp,
    )
    decision = sync.select_route(message, route_targets, approved_chat_id=approved_chat_id)
    if decision.target_thread_id is not None:
        classification = (
            "general" if source.telegram_thread_id == sync.GENERAL_THREAD_ID
            else "unknown_to_general" if decision.route_kind == "general"
            else "exact"
        )
        return classification, decision.target_thread_id, approved_source
    if decision.blocked_reason == "exact_target_inactive":
        return "registered_target_unavailable", None, approved_source
    if decision.blocked_reason == "general_target_unavailable":
        classification = (
            "registered_target_unavailable"
            if source.telegram_thread_id in routes
            else "general_target_unavailable"
        )
        return classification, None, approved_source
    return "route_blocked", None, approved_source


def build_preview(
    *,
    imports: list[ImportRow],
    sources: dict[tuple[str, int], SourceIdentity],
    routes: dict[str, RouteIdentity],
    approved_chat_id: str,
    source_watermark: dict[str, Any],
    app_watermark: dict[str, Any],
) -> dict[str, Any]:
    preimage: list[dict[str, Any]] = []
    reverse_plan: list[dict[str, Any]] = []
    mapping_rows: list[dict[str, Any]] = []
    classifications: Counter[str] = Counter()
    moves: Counter[str] = Counter()
    source_content_mismatches = 0
    source_role_mismatches = 0

    ordered = sorted(imports, key=lambda item: (item.source_session_id, item.source_message_id, item.web_message_id))
    for row in ordered:
        source = sources.get((row.source_session_id, row.source_message_id))
        if source is None:
            classification, target_thread_id, approved_source = "source_missing", None, False
            source_thread_id = None
            source_identity_hash = None
        else:
            classification, target_thread_id, approved_source = _route_decision(
                source,
                routes,
                approved_chat_id,
                {str(item) for item in app_watermark.get("approved_chat_link_thread_ids", [])},
            )
            source_thread_id = source.telegram_thread_id if approved_source else None
            source_identity_hash = _canonical_hash(asdict(source))
            if source.content_sha256 != row.content_sha256:
                source_content_mismatches += 1
            if source.role != row.role:
                source_role_mismatches += 1

        if not row.app_scope_valid:
            classification, target_thread_id = "foreign_app_scope", None

        target_route_threads = sorted(
            route_thread_id for route_thread_id, route in routes.items()
            if target_thread_id is not None and route.active and route.target_thread_id == target_thread_id
        )
        target_route_thread_id = target_route_threads[0] if len(target_route_threads) == 1 else None
        target_route = routes.get(target_route_thread_id) if target_route_thread_id is not None else None
        if target_thread_id is not None and target_route_thread_id is None:
            classification, target_thread_id = "target_route_unbound_or_ambiguous", None

        classifications[classification] += 1
        preimage_row = {
            "source_session_id": row.source_session_id,
            "source_message_id": row.source_message_id,
            "web_message_id": row.web_message_id,
            "old_thread_id": row.old_thread_id,
            "old_workspace_id": row.old_workspace_id,
            "old_project_id": row.old_project_id,
            "old_channel_id": row.old_channel_id,
            "old_topic_id": row.old_topic_id,
            "role": row.role,
            "imported_at": row.imported_at,
            "created_at": row.created_at,
            "content_sha256": row.content_sha256,
            "old_telegram_chat_id": row.old_telegram_chat_id,
            "old_telegram_thread_id": row.old_telegram_thread_id,
            "old_target_web_thread_id": row.old_target_web_thread_id,
            "old_routing_version": row.old_routing_version,
            "source_identity_hash": source_identity_hash,
            "approved_source": approved_source,
            "telegram_thread_id": source_thread_id,
            "classification": classification,
            "target_thread_id": target_thread_id,
            "app_scope_valid": row.app_scope_valid,
        }
        preimage.append(preimage_row)
        mapping_row = {
            "source_session_id": row.source_session_id,
            "source_message_id": row.source_message_id,
            "web_message_id": row.web_message_id,
            "old_thread_id": row.old_thread_id,
            "classification": classification,
            "target_thread_id": target_thread_id,
            "proposed_telegram_chat_id": approved_chat_id if target_thread_id is not None else None,
            "proposed_telegram_thread_id": target_route_thread_id,
            "proposed_target_web_thread_id": target_thread_id,
            "proposed_routing_version": APPLY_ROUTING_VERSION if target_thread_id is not None else None,
        }
        mapping_rows.append(mapping_row)
        if target_thread_id is not None:
            moves[f"{row.old_thread_id}->{target_thread_id}"] += 1
            reverse_plan.append({
                "web_message_id": row.web_message_id,
                "expected_current_thread_id": target_thread_id,
                "reverse_target_thread_id": row.old_thread_id,
                "expected_current_workspace_id": target_route.workspace_id if target_route else None,
                "expected_current_project_id": target_route.project_id if target_route else None,
                "expected_current_channel_id": target_route.channel_id if target_route else None,
                "expected_current_topic_id": target_route.topic_id if target_route else None,
                "reverse_workspace_id": row.old_workspace_id,
                "reverse_project_id": row.old_project_id,
                "reverse_channel_id": row.old_channel_id,
                "reverse_topic_id": row.old_topic_id,
                "source_session_id": row.source_session_id,
                "source_message_id": row.source_message_id,
                "expected_current_telegram_chat_id": approved_chat_id,
                "expected_current_telegram_thread_id": target_route_thread_id,
                "expected_current_target_web_thread_id": target_thread_id,
                "expected_current_routing_version": APPLY_ROUTING_VERSION,
                "reverse_telegram_chat_id": row.old_telegram_chat_id,
                "reverse_telegram_thread_id": row.old_telegram_thread_id,
                "reverse_target_web_thread_id": row.old_target_web_thread_id,
                "reverse_routing_version": row.old_routing_version,
            })

    duplicate_source_keys = len(imports) - len({(row.source_session_id, row.source_message_id) for row in imports})
    duplicate_web_ids = len(imports) - len({row.web_message_id for row in imports})
    planned_update_count = sum(1 for row in mapping_rows if row["target_thread_id"] is not None)
    source_role_counts = Counter(
        sources[(row.source_session_id, row.source_message_id)].role
        for row in ordered if (row.source_session_id, row.source_message_id) in sources
    )
    matched_app_role_counts = Counter(
        row.role for row in ordered if (row.source_session_id, row.source_message_id) in sources
    )
    app_preimage_hash = _canonical_hash([asdict(row) for row in ordered])
    preimage_hash = _canonical_hash(preimage)
    mapping_hash = _canonical_hash(mapping_rows)
    reverse_plan_hash = _canonical_hash(reverse_plan)
    invariants = {
        "fixed_set_nonempty": len(imports) > 0,
        "classification_total_matches_fixed_set": sum(classifications.values()) == len(imports),
        "preimage_count_matches_fixed_set": len(preimage) == len(imports),
        "app_legacy_count_matches_fixed_set": app_watermark.get("legacy_import_count") == len(imports),
        "source_match_count_matches_loaded_sources": source_watermark.get("matched_legacy_source_count") == len(sources),
        "source_keys_unique": duplicate_source_keys == 0,
        "web_message_ids_unique": duplicate_web_ids == 0,
        "source_content_hashes_match_app": source_content_mismatches == 0,
        "source_roles_match_app_rows": source_role_mismatches == 0,
        "source_app_role_counts_match": source_role_counts == matched_app_role_counts,
        "app_rows_match_target_scope": all(row.app_scope_valid for row in imports),
        "reverse_plan_covers_all_planned_updates": len(reverse_plan) == planned_update_count,
    }
    blockers = {
        name for name in (
            "foreign_chat", "unproven_chat", "source_missing", "registered_target_unavailable",
            "general_target_unavailable", "route_blocked", "route_drift", "foreign_app_scope",
        ) if classifications.get(name, 0) > 0
    }
    if not invariants["fixed_set_nonempty"]:
        blockers.add("empty_fixed_set")
    if not invariants["app_legacy_count_matches_fixed_set"]:
        blockers.add("app_legacy_count_mismatch")
    if duplicate_source_keys:
        blockers.add("duplicate_source_key")
    if duplicate_web_ids:
        blockers.add("duplicate_web_message_id")
    if source_content_mismatches:
        blockers.add("source_app_content_hash_mismatch")
    if source_role_mismatches or source_role_counts != matched_app_role_counts:
        blockers.add("source_app_role_mismatch")
    if not invariants["reverse_plan_covers_all_planned_updates"]:
        blockers.add("reverse_plan_incomplete")
    if not all(invariants.values()):
        blockers.add("invariant_failure")

    return {
        "schema_version": "v3-5-preview-3.0",
        "mode": "read_only_preview",
        "approved_chat_id": approved_chat_id,
        "source_watermark": source_watermark,
        "app_watermark": app_watermark,
        "fixed_set": {
            "legacy_import_count": len(imports),
            "distinct_source_sessions": len({row.source_session_id for row in imports}),
            "app_preimage_hash": app_preimage_hash,
            "preimage_hash": preimage_hash,
            "mapping_hash": mapping_hash,
            "reverse_plan_hash": reverse_plan_hash,
        },
        "classification_counts": dict(sorted(classifications.items())),
        "target_move_counts": dict(sorted(moves.items())),
        "role_counts": dict(sorted(Counter(row.role for row in imports).items())),
        "source_role_counts": dict(sorted(source_role_counts.items())),
        "matched_app_role_counts": dict(sorted(matched_app_role_counts.items())),
        "duplicate_source_keys": duplicate_source_keys,
        "duplicate_web_message_ids": duplicate_web_ids,
        "source_content_hash_mismatches": source_content_mismatches,
        "source_app_role_mismatches": source_role_mismatches,
        "apply_blocked": bool(blockers),
        "apply_blockers": sorted(blockers),
        "app_preimage_hash": app_preimage_hash,
        "preimage_hash": preimage_hash,
        "mapping_hash": mapping_hash,
        "reverse_plan_hash": reverse_plan_hash,
        "preimage": preimage,
        "mapping": mapping_rows,
        "reverse_plan": reverse_plan,
        "invariants": invariants,
    }


def read_only_psql_cmd() -> list[str]:
    return [
        "docker", "compose", "-f", "docker-compose.prod.yml", "--env-file", ".env.docker",
        "exec", "-T", "-e", "PGOPTIONS=-c default_transaction_read_only=on", "pg",
        "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1",
        "-U", "consulting", "-d", "consulting",
    ]


def _route_snapshot_sql() -> str:
    values = ",\n          ".join(
        f"({sync.sql_literal(sync.APPROVED_CHAT_ID)}, {sync.sql_literal(thread_id)}, {sync.sql_literal(slug)}, {sync.sql_literal(web_slug)}, {sync.sql_literal(title)}, {sync.sql_literal(memory_id)})"
        for thread_id, slug, web_slug, title, memory_id in sync.EXPECTED_ROUTE_REGISTRY
    )
    return f"""
      WITH expected(telegram_chat_id, telegram_thread_id, consulting_topic_slug, web_topic_slug, thread_title, memory_topic_id) AS (
        VALUES {values}
      )
      SELECT json_agg(json_build_object(
        'telegram_thread_id', expected.telegram_thread_id,
        'target_thread_id', COALESCE(l.thread_id::text, ''),
        'workspace_id', COALESCE(l.workspace_id::text, ''),
        'project_id', COALESCE(l.project_id::text, ''),
        'channel_id', COALESCE(l.channel_id::text, ''),
        'topic_id', COALESCE(l.web_topic_id::text, ''),
        'active', (
          l.status = 'active' AND l.thread_id IS NOT NULL AND th.id IS NOT NULL
          AND th.topic_id = l.web_topic_id AND t.id = l.web_topic_id AND t.channel_id = l.channel_id
          AND c.id = l.channel_id AND c.project_id = l.project_id AND p.id = l.project_id
          AND p.workspace_id = l.workspace_id AND w.id = l.workspace_id
          AND c.workspace_id = l.workspace_id AND t.workspace_id = l.workspace_id
          AND th.workspace_id = l.workspace_id
          AND l.memory_topic_id = expected.memory_topic_id
          AND t.slug = expected.web_topic_slug
          AND t.memory_topic_id = expected.memory_topic_id
          AND th.title = expected.thread_title
          AND p.id = {sync.sql_literal(sync.PROJECT_ID)}::uuid
          AND w.name = {sync.sql_literal(sync.WORKSPACE_NAME)}
          AND p.name = {sync.sql_literal(sync.PROJECT_NAME)}
          AND c.name = {sync.sql_literal(sync.CHANNEL_NAME)}
          AND w.status = 'active' AND w.deleted_at IS NULL
          AND p.status = 'active' AND p.deleted_at IS NULL
          AND c.status = 'active' AND c.deleted_at IS NULL
          AND t.status = 'active' AND t.deleted_at IS NULL
          AND th.status = 'active' AND th.deleted_at IS NULL
        )
      ) ORDER BY expected.telegram_thread_id)
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
    """


def load_app_snapshot() -> tuple[list[ImportRow], dict[str, Any], dict[str, RouteIdentity]]:
    route_sql = _route_snapshot_sql()
    sql = f"""
    BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL ROLE {READ_ONLY_ROLE};
    WITH legacy AS (
      SELECT i.source_session_id, i.source_message_id, i.web_message_id,
             m.thread_id AS old_thread_id, m.role::text AS role,
             m.workspace_id AS old_workspace_id, p.id AS old_project_id,
             c.id AS old_channel_id, t.id AS old_topic_id,
             i.imported_at, m.created_at,
             (
               m.deleted_at IS NULL
               AND m.workspace_id = th.workspace_id
               AND th.status = 'active' AND th.deleted_at IS NULL
               AND t.id = th.topic_id AND t.workspace_id = m.workspace_id
               AND t.status = 'active' AND t.deleted_at IS NULL
               AND c.id = t.channel_id AND c.workspace_id = m.workspace_id
               AND c.status = 'active' AND c.deleted_at IS NULL
               AND p.id = c.project_id AND p.workspace_id = m.workspace_id
               AND p.status = 'active' AND p.deleted_at IS NULL
               AND p.id = {sync.sql_literal(sync.PROJECT_ID)}::uuid
               AND w.id = m.workspace_id
               AND w.status = 'active' AND w.deleted_at IS NULL
             ) AS app_scope_valid,
             encode(sha256(convert_to(
               CASE WHEN m.role::text = 'user'
                 THEN trim(regexp_replace(trim(m.content), '^\\[Emma\\]\\s*', ''))
                 ELSE trim(m.content) END,
               'UTF8')), 'hex') AS content_sha256,
             i.telegram_chat_id, i.telegram_thread_id, i.target_web_thread_id, i.routing_version
      FROM telegram_message_imports i
      JOIN chat_messages m ON m.id = i.web_message_id
      LEFT JOIN threads th ON th.id = m.thread_id
      LEFT JOIN topics t ON t.id = th.topic_id
      LEFT JOIN channels c ON c.id = t.channel_id
      LEFT JOIN projects p ON p.id = c.project_id
      LEFT JOIN workspaces w ON w.id = m.workspace_id
      WHERE i.routing_version IS NULL
      ORDER BY i.source_session_id, i.source_message_id, i.web_message_id
    ), app_counts AS (
      SELECT count(*) AS import_count,
             count(*) FILTER (WHERE routing_version IS NULL) AS legacy_import_count,
             max(imported_at) AS max_imported_at,
             count(DISTINCT source_session_id) AS distinct_source_sessions
      FROM telegram_message_imports
    )
    SELECT json_build_object(
      'imports', COALESCE((SELECT json_agg(json_build_object(
        'source_session_id', source_session_id,
        'source_message_id', source_message_id,
        'web_message_id', web_message_id,
        'old_thread_id', old_thread_id,
        'old_workspace_id', old_workspace_id,
        'old_project_id', old_project_id,
        'old_channel_id', old_channel_id,
        'old_topic_id', old_topic_id,
        'role', role,
        'imported_at', imported_at,
        'created_at', created_at,
        'content_sha256', content_sha256,
        'old_telegram_chat_id', telegram_chat_id,
        'old_telegram_thread_id', telegram_thread_id,
        'old_target_web_thread_id', target_web_thread_id,
        'old_routing_version', routing_version,
        'app_scope_valid', app_scope_valid
      ) ORDER BY source_session_id, source_message_id, web_message_id) FROM legacy), '[]'::json),
      'watermark', (SELECT json_build_object(
        'import_count', import_count,
        'legacy_import_count', legacy_import_count,
        'max_imported_at', max_imported_at,
        'distinct_source_sessions', distinct_source_sessions
      ) FROM app_counts),
      'routes', COALESCE(({route_sql}), '[]'::json),
      'approved_chat_link_thread_ids', COALESCE((
        SELECT json_agg(link_threads.telegram_thread_id ORDER BY link_threads.telegram_thread_id)
        FROM (
          SELECT DISTINCT telegram_thread_id
          FROM telegram_topic_links
          WHERE telegram_chat_id = {sync.sql_literal(sync.APPROVED_CHAT_ID)}
        ) link_threads
      ), '[]'::json)
    );
    COMMIT;
    """
    proc = subprocess.run(read_only_psql_cmd(), input=sql, text=True, capture_output=True, cwd=sync.ROOT)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "read-only app snapshot failed")
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("unexpected app snapshot shape")
    payload = json.loads(lines[0])
    import_rows = payload.get("imports")
    route_rows = payload.get("routes")
    approved_chat_link_thread_ids = payload.get("approved_chat_link_thread_ids")
    watermark = payload.get("watermark")
    if (
        not isinstance(import_rows, list)
        or not isinstance(route_rows, list)
        or not isinstance(approved_chat_link_thread_ids, list)
        or not isinstance(watermark, dict)
    ):
        raise RuntimeError("invalid app snapshot envelope")
    imports = [
        ImportRow(
            source_session_id=str(row["source_session_id"]),
            source_message_id=int(row["source_message_id"]),
            web_message_id=str(row["web_message_id"]),
            old_thread_id=str(row["old_thread_id"]),
            old_workspace_id=str(row["old_workspace_id"]),
            old_project_id=str(row["old_project_id"]),
            old_channel_id=str(row["old_channel_id"]),
            old_topic_id=str(row["old_topic_id"]),
            role=str(row["role"]),
            imported_at=str(row["imported_at"]),
            created_at=str(row["created_at"]),
            content_sha256=str(row["content_sha256"]),
            old_telegram_chat_id=None if row.get("old_telegram_chat_id") is None else str(row["old_telegram_chat_id"]),
            old_telegram_thread_id=None if row.get("old_telegram_thread_id") is None else str(row["old_telegram_thread_id"]),
            old_target_web_thread_id=None if row.get("old_target_web_thread_id") is None else str(row["old_target_web_thread_id"]),
            old_routing_version=None if row.get("old_routing_version") is None else str(row["old_routing_version"]),
            app_scope_valid=bool(row.get("app_scope_valid")),
        )
        for row in import_rows
    ]
    routes = {
        str(row["telegram_thread_id"]): RouteIdentity(
            target_thread_id=str(row.get("target_thread_id") or ""),
            workspace_id=str(row.get("workspace_id") or ""),
            project_id=str(row.get("project_id") or ""),
            channel_id=str(row.get("channel_id") or ""),
            topic_id=str(row.get("topic_id") or ""),
            active=bool(row.get("active")),
        )
        for row in route_rows
    }
    watermark["snapshot_hash"] = _canonical_hash([asdict(row) for row in imports])
    watermark["approved_chat_link_thread_ids"] = sorted(str(item) for item in approved_chat_link_thread_ids)
    watermark["route_snapshot_hash"] = _canonical_hash({
        "routes": {key: asdict(value) for key, value in sorted(routes.items())},
        "approved_chat_link_thread_ids": watermark["approved_chat_link_thread_ids"],
    })
    return imports, watermark, routes


def load_source_identities(imports: list[ImportRow]) -> tuple[dict[tuple[str, int], SourceIdentity], dict[str, Any]]:
    source_keys = {(row.source_session_id, row.source_message_id) for row in imports}
    session_ids = sorted({row.source_session_id for row in imports})
    identities: dict[tuple[str, int], SourceIdentity] = {}
    max_message_id: int | None = None
    con = sqlite3.connect(f"file:{sync.STATE_DB}?mode=ro", uri=True, timeout=2, isolation_level=None)
    try:
        con.execute("PRAGMA query_only=ON")
        con.execute("BEGIN")
        max_message_id = con.execute("SELECT max(id) FROM messages").fetchone()[0]
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            rows = con.execute(
                f"""
                SELECT m.session_id, m.id, s.source, s.chat_id, s.thread_id,
                       m.role, COALESCE(m.active, 1), COALESCE(m.compacted, 0),
                       m.timestamp, m.content
                FROM messages m JOIN sessions s ON s.id=m.session_id
                WHERE m.session_id IN ({placeholders})
                """,
                session_ids,
            ).fetchall()
            for session_id, message_id, source_name, chat_id, thread_id, role, active, compacted, timestamp, content in rows:
                key = (str(session_id), int(message_id))
                if key not in source_keys:
                    continue
                cleaned = sync.clean_content(str(role), str(content or ""))
                identities[key] = SourceIdentity(
                    source=str(source_name or ""),
                    telegram_chat_id=None if chat_id is None else str(chat_id),
                    telegram_thread_id=None if thread_id is None else str(thread_id),
                    role=str(role),
                    active=bool(active),
                    compacted=bool(compacted),
                    timestamp=float(timestamp),
                    content_sha256=hashlib.sha256(cleaned.encode("utf-8")).hexdigest(),
                )
        con.execute("COMMIT")
    except Exception:
        try:
            con.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        con.close()
    identity_rows = [
        {"source_session_id": key[0], "source_message_id": key[1], **asdict(value)}
        for key, value in sorted(identities.items())
    ]
    return identities, {
        "source_label": "hermes-state-db",
        "identity_hash": _canonical_hash(identity_rows),
        "max_message_id": max_message_id,
        "matched_legacy_source_count": len(identities),
    }


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stdout", action="store_true", help="print compact summary only")
    args = parser.parse_args()

    imports_a, app_watermark_a, routes_a = load_app_snapshot()
    sources_a, source_watermark_a = load_source_identities(imports_a)
    imports_b, app_watermark_b, routes_b = load_app_snapshot()
    sources_b, source_watermark_b = load_source_identities(imports_b)
    result = build_preview(
        imports=imports_a,
        sources=sources_a,
        routes=routes_a,
        approved_chat_id=sync.APPROVED_CHAT_ID,
        source_watermark=source_watermark_a,
        app_watermark=app_watermark_a,
    )
    if app_watermark_a != app_watermark_b or imports_a != imports_b or routes_a != routes_b:
        _append_blocker(result, "app_snapshot_drift")
    if source_watermark_a != source_watermark_b or sources_a != sources_b:
        _append_blocker(result, "source_snapshot_drift")
    result["snapshot_fence"] = {
        "app_stable": app_watermark_a == app_watermark_b and imports_a == imports_b and routes_a == routes_b,
        "source_stable": source_watermark_a == source_watermark_b and sources_a == sources_b,
    }
    result["generated_at"] = datetime.now(UTC).isoformat()
    result["privacy_violations"] = []
    privacy_violations = artifact_privacy_violations(result)
    result["privacy_violations"] = privacy_violations
    privacy_violations = sorted(set(privacy_violations) | set(artifact_privacy_violations(result)))
    result["privacy_violations"] = privacy_violations
    if privacy_violations:
        _append_blocker(result, "artifact_privacy_violation")
        print(json.dumps({
            "error": "artifact_privacy_violation",
            "privacy_violations": privacy_violations,
            "apply_blocked": True,
        }, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2

    output = args.output or sync.ROOT / "artifacts" / "v3-5" / f"telegram-reclassification-preview-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    _atomic_write_json(output, result)
    summary = {
        "output": str(output),
        "mode": result["mode"],
        "legacy_import_count": len(imports_a),
        "classification_counts": result["classification_counts"],
        "apply_blocked": result["apply_blocked"],
        "apply_blockers": result["apply_blockers"],
        "preimage_hash": result["preimage_hash"],
        "mapping_hash": result["mapping_hash"],
        "reverse_plan_hash": result["reverse_plan_hash"],
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
