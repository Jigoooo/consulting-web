#!/usr/bin/env python3
"""Read-only auditor for consulting-web product PostgreSQL containers.

The script executes psql inside the target Docker container using POSTGRES_USER and
POSTGRES_DB already present in that container. It never prints or requires the DB
password/DSN.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

PASSWORD_URL_RE = re.compile(r"(postgres(?:ql)?://[^:\s/@]+:)([^@\s]+)(@)")


def mask_secret(text: str) -> str:
    return PASSWORD_URL_RE.sub(r"\1***\3", text)


def quote_ident(identifier: str) -> str:
    if "\x00" in identifier:
        raise ValueError("NUL byte in SQL identifier")
    return '"' + identifier.replace('"', '""') + '"'


def sql_literal(value: str) -> str:
    if "\x00" in value:
        raise ValueError("NUL byte in SQL literal")
    return "'" + value.replace("'", "''") + "'"


def _parse_json(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        raise RuntimeError("psql returned empty output")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"psql did not return JSON: {stripped[:300]!r}") from exc


def run_psql_in_container(container: str, sql: str) -> str:
    cmd = [
        "docker",
        "exec",
        "-i",
        container,
        "sh",
        "-lc",
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtX -v ON_ERROR_STOP=1',
    ]
    proc = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "psql failed "
            + json.dumps(
                {
                    "container": container,
                    "returncode": proc.returncode,
                    "stdout": mask_secret(proc.stdout[-1000:]),
                    "stderr": mask_secret(proc.stderr[-2000:]),
                },
                ensure_ascii=False,
            )
        )
    return proc.stdout.strip()


def server_sql() -> str:
    return """
SELECT json_build_object(
  'server_version', current_setting('server_version'),
  'version', version(),
  'database', current_database(),
  'user', current_user
)::text;
"""


def extensions_sql() -> str:
    return """
SELECT COALESCE(json_agg(json_build_object('name', extname, 'version', extversion) ORDER BY extname), '[]'::json)::text
FROM pg_extension;
"""


def tables_sql() -> str:
    return """
SELECT COALESCE(json_agg(table_doc ORDER BY table_doc->>'schema', table_doc->>'name'), '[]'::json)::text
FROM (
  SELECT json_build_object(
    'schema', n.nspname,
    'name', c.relname,
    'columns', COALESCE((
      SELECT json_agg(json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'not_null', a.attnotnull
      ) ORDER BY a.attnum)
      FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    ), '[]'::json),
    'pk_columns', COALESCE((
      SELECT json_agg(a.attname ORDER BY k.ord)
      FROM pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = c.oid AND i.indisprimary
    ), '[]'::json)
  ) AS table_doc
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
) s;
"""


def _column_type(table: dict[str, Any], column: str) -> str:
    for col in table.get("columns", []):
        if col.get("name") == column:
            return str(col.get("type") or "")
    return ""


def _table_ref(table: dict[str, Any]) -> str:
    return f"{quote_ident(str(table['schema']))}.{quote_ident(str(table['name']))}"


def build_pk_checksum_sql(table: dict[str, Any]) -> str:
    table_ref = _table_ref(table)
    pk_columns = [str(col) for col in table.get("pk_columns", [])]
    if not pk_columns:
        return f"""
SELECT json_build_object(
  'kind', 'no_pk',
  'count', COUNT(*)::bigint,
  'row_md5', md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text COLLATE "C"), ''))
)::text
FROM {table_ref} t;
"""
    if len(pk_columns) == 1:
        col = pk_columns[0]
        col_ref = quote_ident(col)
        col_type = _column_type(table, col).lower()
        if any(token in col_type for token in ("int", "serial", "numeric", "decimal")):
            return f"""
SELECT json_build_object(
  'kind', 'single_integer',
  'column', {sql_literal(col)},
  'count', COUNT({col_ref})::bigint,
  'sum', COALESCE(SUM({col_ref}::numeric), 0)::text,
  'min', MIN({col_ref})::text,
  'max', MAX({col_ref})::text,
  'md5', md5(COALESCE(string_agg({col_ref}::text, E'\\n' ORDER BY {col_ref}), ''))
)::text
FROM {table_ref};
"""
        return f"""
SELECT json_build_object(
  'kind', 'single_text',
  'column', {sql_literal(col)},
  'count', COUNT({col_ref})::bigint,
  'distinct', COUNT(DISTINCT {col_ref})::bigint,
  'md5', md5(COALESCE(string_agg({col_ref}::text, E'\\n' ORDER BY {col_ref}::text COLLATE "C"), ''))
)::text
FROM {table_ref};
"""

    expr = "concat_ws(E'\\t', " + ", ".join(f"{quote_ident(col)}::text" for col in pk_columns) + ")"
    order = ", ".join(f"{quote_ident(col)}::text COLLATE \"C\"" for col in pk_columns)
    return f"""
SELECT json_build_object(
  'kind', 'composite',
  'columns', {sql_literal(json.dumps(pk_columns))}::json,
  'count', COUNT(*)::bigint,
  'md5', md5(COALESCE(string_agg({expr}, E'\\n' ORDER BY {order}), ''))
)::text
FROM {table_ref};
"""


def audit_product_pg(runner: Callable[[str], str], container: str) -> dict[str, Any]:
    server = _parse_json(runner(server_sql()))
    extensions = _parse_json(runner(extensions_sql()))
    tables = _parse_json(runner(tables_sql()))
    audited_tables: list[dict[str, Any]] = []
    for table in tables:
        checksum = _parse_json(runner(build_pk_checksum_sql(table)))
        row_count = int(checksum.get("count", 0))
        audited_tables.append({**table, "row_count": row_count, "pk_checksum": checksum})

    return {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "container": container,
        "server": server,
        "extensions": extensions,
        "summary": {
            "base_tables": len(audited_tables),
            "total_rows": sum(int(table.get("row_count", 0)) for table in audited_tables),
            "extensions": [item.get("name") for item in extensions],
        },
        "tables": sorted(audited_tables, key=lambda item: (item.get("schema", ""), item.get("name", ""))),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only PostgreSQL product DB auditor")
    parser.add_argument("--container", required=True, help="Docker container name, e.g. consulting-web-pg-1")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    args = parser.parse_args(argv)

    def runner(sql: str) -> str:
        return run_psql_in_container(args.container, sql)

    result = audit_product_pg(runner, container=args.container)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
