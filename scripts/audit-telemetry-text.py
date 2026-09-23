#!/usr/bin/env python3
"""What the text-tier blobs hold, as field names and lengths, never contents (#183).

`raw_result` is the action's result object stored verbatim and `verdict_text` is the
liveness verdict. Nobody has audited what either carries, so the tier map puts both in
the text tier. This reports, across stored usage_records rows, which top-level keys
`raw_result` has, how often, and how long their values run, plus the length spread of
`verdict_text`. Every number is computed in SQL; no value leaves the database.

Usage:
  scripts/audit-telemetry-text.py --remote            # production D1, via wrangler
  scripts/audit-telemetry-text.py --sqlite path.db    # a local SQLite file (tests)
"""

import argparse
import json
import pathlib
import sqlite3
import subprocess
import sys

DATABASE = "review-telemetry"
WORKER_DIR = pathlib.Path(__file__).resolve().parents[1] / "worker"

QUERIES = {
    "rows": """
        SELECT share_level, COUNT(*) AS rows,
          SUM(CASE WHEN raw_result IS NOT NULL THEN 1 ELSE 0 END) AS with_raw_result,
          SUM(CASE WHEN verdict_text IS NOT NULL THEN 1 ELSE 0 END) AS with_verdict_text
        FROM usage_records GROUP BY share_level ORDER BY share_level""",
    "raw_result_keys": """
        SELECT j.key AS field, j.type AS type, COUNT(*) AS rows,
          MIN(length(j.value)) AS min_len, MAX(length(j.value)) AS max_len,
          CAST(AVG(length(j.value)) AS INTEGER) AS avg_len
        FROM usage_records u, json_each(u.raw_result) j
        WHERE u.raw_result IS NOT NULL AND json_valid(u.raw_result)
        GROUP BY j.key, j.type ORDER BY rows DESC, field""",
    "raw_result_unparseable": """
        SELECT COUNT(*) AS rows FROM usage_records
        WHERE raw_result IS NOT NULL AND NOT json_valid(raw_result)""",
    "verdict_text": """
        SELECT COUNT(*) AS rows, MIN(length(verdict_text)) AS min_len,
          MAX(length(verdict_text)) AS max_len, CAST(AVG(length(verdict_text)) AS INTEGER) AS avg_len
        FROM usage_records WHERE verdict_text IS NOT NULL""",
}


def run_sqlite(path: str, sql: str) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql).fetchall()]
    finally:
        conn.close()


def run_wrangler(sql: str) -> list[dict]:
    proc = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DATABASE, "--remote", "--json", "--command", " ".join(sql.split())],
        cwd=WORKER_DIR,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"wrangler d1 execute failed: {proc.stderr.strip()[-400:]}")
    return json.loads(proc.stdout)[0]["results"]


def table(rows: list[dict]) -> str:
    if not rows:
        return "_none_\n"
    headers = list(rows[0].keys())
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    lines += ["| " + " | ".join("" if r[h] is None else str(r[h]) for h in headers) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--remote", action="store_true", help="query production D1 through wrangler")
    source.add_argument("--sqlite", metavar="PATH", help="query a local SQLite file")
    args = parser.parse_args()

    run = (lambda sql: run_sqlite(args.sqlite, sql)) if args.sqlite else run_wrangler
    results = {name: run(sql) for name, sql in QUERIES.items()}

    print("## Text-tier audit: field names and lengths, no contents (#183)\n")
    print("### Rows by share level\n")
    print(table(results["rows"]))
    print("### `raw_result` top-level fields\n")
    print(table(results["raw_result_keys"]))
    unparseable = results["raw_result_unparseable"][0]["rows"] if results["raw_result_unparseable"] else 0
    print(f"`raw_result` rows that are not valid JSON: {unparseable}\n")
    print("### `verdict_text` lengths\n")
    print(table(results["verdict_text"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
