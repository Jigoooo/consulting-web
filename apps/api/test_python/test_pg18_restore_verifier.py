from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "scripts" / "pg18_migration"
if str(MIGRATION) not in sys.path:
    sys.path.insert(0, str(MIGRATION))


def _audit(table_rows):
    return {
        "ok": True,
        "summary": {"base_tables": len(table_rows), "total_rows": sum(t["row_count"] for t in table_rows)},
        "tables": table_rows,
    }


def _table(name, rows, checksum="abc"):
    return {
        "schema": "public",
        "name": name,
        "row_count": rows,
        "pk_columns": ["id"],
        "pk_checksum": {"kind": "single_integer", "column": "id", "count": rows, "sum": str(rows), "min": "1", "max": str(rows), "md5": checksum},
    }


def test_compare_restore_reports_match():
    mod = importlib.import_module("verify_product_restore")
    baseline = _audit([_table("a", 2, "a" * 32), _table("b", 0, "b" * 32)])
    target = _audit([_table("b", 0, "b" * 32), _table("a", 2, "a" * 32)])

    result = mod.compare_audits(baseline, target)

    assert result["ok"] is True
    assert result["summary"]["matched_tables"] == 2
    assert result["failures"] == []


def test_compare_restore_detects_row_and_checksum_drift():
    mod = importlib.import_module("verify_product_restore")
    baseline = _audit([_table("a", 2, "a" * 32), _table("missing", 1, "m" * 32)])
    target = _audit([_table("a", 3, "z" * 32), _table("extra", 1, "e" * 32)])

    result = mod.compare_audits(baseline, target)

    assert result["ok"] is False
    failure_text = json.dumps(result["failures"], ensure_ascii=False)
    assert "row_count_mismatch" in failure_text
    assert "checksum_mismatch" in failure_text
    assert "missing_in_target" in failure_text
    assert "extra_in_target" in failure_text


def test_restore_shell_scripts_avoid_secret_printing_and_target_sidecar():
    dump_text = (ROOT / "scripts/pg18_migration/dump_product_pg16.sh").read_text()
    restore_text = (ROOT / "scripts/pg18_migration/restore_product_pg18.sh").read_text()

    assert "consulting-web-pg-1" in dump_text
    assert "consulting-web-pg18-rehearsal-pg18-1" in restore_text
    assert "PG_PASSWORD" not in dump_text
    assert "PG_PASSWORD" not in restore_text
    assert "pg_dump" in dump_text
    assert "pg_restore" in restore_text
