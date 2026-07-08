from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_pg18_rehearsal_compose_is_sidecar_not_prod_mutation():
    text = (ROOT / "docker-compose.pg18-rehearsal.yml").read_text()

    assert "name: consulting-web-pg18-rehearsal" in text
    assert "pgvector/pgvector:pg18" in text
    assert "127.0.0.1:55418:5432" in text
    assert "pg18-rehearsal-data:/var/lib/postgresql" in text
    assert "/var/lib/postgresql/data" not in text
    assert "pg-data:/var/lib/postgresql/data" not in text
    assert "postgres:16" not in text


def test_pg18_extension_sql_is_additive_only():
    text = (ROOT / "scripts/pg18_migration/create_extensions.sql").read_text()
    lowered = text.lower()

    for ext in ["vector", "pg_trgm", "uuid-ossp", "btree_gin"]:
        assert f"create extension if not exists" in lowered
        assert ext in text
    for destructive in ["drop ", "truncate ", "delete ", "alter table"]:
        assert destructive not in lowered
