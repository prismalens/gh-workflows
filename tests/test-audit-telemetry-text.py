#!/usr/bin/env python3
"""scripts/audit-telemetry-text.py reports field names and lengths, never a value (#183).

Builds a SQLite database from worker/migrations, seeds rows whose text carries a
marker, runs the script against it and checks the report names the fields, counts
them, and prints no marker.
"""

import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/audit-telemetry-text.py"
MARKER = "SECRET-CONTENT-7f3a"


def main() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as td:
        db = pathlib.Path(td) / "t.db"
        conn = sqlite3.connect(db)
        for migration in sorted((ROOT / "worker/migrations").glob("*.sql")):
            conn.executescript(migration.read_text())
        insert = (
            "INSERT INTO usage_records (session_id, recorded_at, repository, per_model_usage, raw_result, verdict_text, share_level)"
            " VALUES (?, '2026-09-01T00:00:00Z', 'o/a', '{}', ?, ?, ?)"
        )
        conn.execute(insert, ("s1", json.dumps({"result": MARKER * 3, "num_turns": 4}), f"reviewed {MARKER}", "full"))
        conn.execute(insert, ("s2", json.dumps({"result": MARKER}), None, "full"))
        conn.execute(insert, ("s3", "not json " + MARKER, None, "full"))
        conn.execute(insert, ("s4", None, None, "rounds"))
        conn.commit()
        conn.close()

        proc = subprocess.run([sys.executable, str(SCRIPT), "--sqlite", str(db)], capture_output=True, text=True)
        out = proc.stdout

    def check(name, cond):
        print(f"  {'ok  ' if cond else 'FAIL'}  {name}")
        if not cond:
            fails.append(name)

    check("exits 0", proc.returncode == 0)
    check("no stored value is printed", MARKER not in out and MARKER not in proc.stderr)
    check("names the result field with its row count", "| result | text | 2 |" in out)
    check("names the num_turns field", "| num_turns | integer | 1 |" in out)
    check("counts raw_result rows that are not JSON", "not valid JSON: 1" in out)
    check("reports rows by share level", "| full | 3 | 3 | 1 |" in out and "| rounds | 1 | 0 | 0 |" in out)
    verdict_len = len(f"reviewed {MARKER}")
    check("reports verdict_text lengths", f"| 1 | {verdict_len} | {verdict_len} | {verdict_len} |" in out)

    if fails:
        print(f"\n{len(fails)} FAILED\n{out}")
        return 1
    print("\nall audit script tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
