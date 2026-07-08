#!/usr/bin/env python3
"""Compare product PG baseline and PG18 restored audit artifacts."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _key(table: dict[str, Any]) -> str:
    return f"{table.get('schema')}.{table.get('name')}"


def _checksum_relevant(checksum: dict[str, Any]) -> dict[str, Any]:
    return {
        key: checksum.get(key)
        for key in sorted(checksum)
        if key not in {"duration_ms"}
    }


def compare_audits(baseline: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    base_tables = {_key(table): table for table in baseline.get("tables", [])}
    target_tables = {_key(table): table for table in target.get("tables", [])}

    for key in sorted(base_tables.keys() - target_tables.keys()):
        failures.append({"type": "missing_in_target", "table": key})
    for key in sorted(target_tables.keys() - base_tables.keys()):
        failures.append({"type": "extra_in_target", "table": key})

    matched = 0
    for key in sorted(base_tables.keys() & target_tables.keys()):
        matched += 1
        base = base_tables[key]
        tgt = target_tables[key]
        if int(base.get("row_count", -1)) != int(tgt.get("row_count", -2)):
            failures.append(
                {
                    "type": "row_count_mismatch",
                    "table": key,
                    "baseline": base.get("row_count"),
                    "target": tgt.get("row_count"),
                }
            )
        if _checksum_relevant(base.get("pk_checksum", {})) != _checksum_relevant(tgt.get("pk_checksum", {})):
            failures.append(
                {
                    "type": "checksum_mismatch",
                    "table": key,
                    "baseline": _checksum_relevant(base.get("pk_checksum", {})),
                    "target": _checksum_relevant(tgt.get("pk_checksum", {})),
                }
            )

    return {
        "ok": not failures,
        "summary": {
            "baseline_tables": len(base_tables),
            "target_tables": len(target_tables),
            "matched_tables": matched,
            "baseline_rows": baseline.get("summary", {}).get("total_rows"),
            "target_rows": target.get("summary", {}).get("total_rows"),
        },
        "failures": failures,
    }


def _load(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify PG18 restore against PG16 baseline audit JSON")
    parser.add_argument("--baseline", required=True, help="Baseline product_pg16 audit JSON")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--target-json", help="Existing target audit JSON")
    group.add_argument("--target-container", help="Run audit_product_pg.py against this Docker container")
    parser.add_argument("--output", help="Optional output JSON path")
    args = parser.parse_args(argv)

    baseline = _load(args.baseline)
    if args.target_json:
        target = _load(args.target_json)
    else:
        from audit_product_pg import audit_product_pg, run_psql_in_container

        target = audit_product_pg(lambda sql: run_psql_in_container(args.target_container, sql), container=args.target_container)

    result = compare_audits(baseline, target)
    text = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(text + "\n")
    print(text)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
