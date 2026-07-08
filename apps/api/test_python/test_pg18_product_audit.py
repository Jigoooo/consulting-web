from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "scripts" / "pg18_migration"
if str(MIGRATION) not in sys.path:
    sys.path.insert(0, str(MIGRATION))


def test_mask_secret_redacts_url_passwords():
    mod = importlib.import_module("audit_product_pg")

    assert mod.mask_secret("postgres://user:secret@example/db") == "postgres://user:***@example/db"
    assert mod.mask_secret("postgresql://u:p@localhost:5432/x") == "postgresql://u:***@localhost:5432/x"
    assert "secret" not in mod.mask_secret("prefix postgres://user:secret@example/db suffix")


def test_quote_identifier_rejects_bad_names():
    mod = importlib.import_module("audit_product_pg")

    assert mod.quote_ident("chat_messages") == '"chat_messages"'
    assert mod.quote_ident('weird"name') == '"weird""name"'
    try:
        mod.quote_ident("bad\x00name")
    except ValueError as exc:
        assert "NUL" in str(exc)
    else:
        raise AssertionError("expected NUL identifier to fail")


def test_checksum_sql_uses_real_pk_shape_not_hardcoded_id():
    mod = importlib.import_module("audit_product_pg")
    table = {
        "schema": "public",
        "name": "topic_memberships",
        "columns": [
            {"name": "workspace_id", "type": "uuid"},
            {"name": "topic_id", "type": "uuid"},
            {"name": "role", "type": "text"},
        ],
        "pk_columns": ["workspace_id", "topic_id"],
    }

    sql = mod.build_pk_checksum_sql(table)

    assert '"workspace_id"' in sql
    assert '"topic_id"' in sql
    assert '"id"' not in sql
    assert "composite" in sql
    assert "'columns', '[\"workspace_id\", \"topic_id\"]'::json" in sql
    assert "'columns', [" not in sql
    assert 'COLLATE "C"' in sql


def test_single_pk_json_field_uses_sql_literal_not_identifier():
    mod = importlib.import_module("audit_product_pg")
    table = {
        "schema": "public",
        "name": "_migrations",
        "columns": [{"name": "name", "type": "text"}],
        "pk_columns": ["name"],
    }

    sql = mod.build_pk_checksum_sql(table)

    assert "'column', 'name'" in sql
    assert "'column', \"name\"" not in sql
    assert 'COLLATE "C"' in sql


def test_audit_with_fake_runner_summarizes_tables_and_extensions():
    mod = importlib.import_module("audit_product_pg")

    calls: list[str] = []

    def fake_runner(sql: str) -> str:
        calls.append(sql)
        if "server_version" in sql:
            return json.dumps({"server_version": "16.14", "version": "PostgreSQL 16.14"})
        if "pg_extension" in sql:
            return json.dumps([{"name": "plpgsql", "version": "1.0"}])
        if "pg_class" in sql and "columns" in sql:
            return json.dumps([
                {
                    "schema": "public",
                    "name": "alpha",
                    "columns": [{"name": "code", "type": "text"}],
                    "pk_columns": ["code"],
                },
                {
                    "schema": "public",
                    "name": "beta",
                    "columns": [{"name": "a", "type": "integer"}, {"name": "b", "type": "integer"}],
                    "pk_columns": ["a", "b"],
                },
            ])
        if 'FROM "public"."alpha"' in sql:
            return json.dumps({"kind": "single_text", "column": "code", "count": 2, "distinct": 2, "md5": "a" * 32})
        if 'FROM "public"."beta"' in sql:
            return json.dumps({"kind": "composite", "columns": ["a", "b"], "count": 3, "md5": "b" * 32})
        raise AssertionError(sql)

    result = mod.audit_product_pg(fake_runner, container="fake-pg")

    assert result["ok"] is True
    assert result["container"] == "fake-pg"
    assert result["server"]["server_version"] == "16.14"
    assert result["summary"]["base_tables"] == 2
    assert result["summary"]["total_rows"] == 5
    assert result["tables"][0]["pk_checksum"]["kind"] == "single_text"
    assert calls
