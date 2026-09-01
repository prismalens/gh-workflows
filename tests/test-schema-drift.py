#!/usr/bin/env python3
"""Schema-to-code drift check.

Parses worker/migrations/*.sql to build the authoritative column set for each
table, then parses the INSERT and SELECT column lists in worker/index.js and
asserts consistency in both directions:

  1. Every column an INSERT writes must exist in the schema.
  2. Every usage_records schema column must be either selected by a read path
     or listed in USAGE_RECORDS_READ_ALLOWLIST with a reason.

Story: #99 — migration 0002 added 18 columns and nothing caught that the read
API returned none of them.

Run: python3 tests/test-schema-drift.py
"""
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "worker" / "migrations"
INDEX_JS = ROOT / "worker" / "index.js"

# ── Allowlist ─────────────────────────────────────────────────
#
# Columns that exist in the schema but are intentionally NOT selected
# by any read path.  Each entry needs a one-line reason.
#
# If CI fails because a new column is not read, either:
#   • wire it into the SELECT in handleRuns() so the dashboard can use it, or
#   • add it here with a reason why it should not be exposed on the read API.
#
USAGE_RECORDS_READ_ALLOWLIST = {
    "lane_version":     "Internal lane-routing metadata; exposed only on lane_events",
    "verdict_kind":     "Review verdict detail; not yet surfaced in dashboard read API",
    "verdict_text":     "Review verdict body; not yet surfaced in dashboard read API",
    "inline_count":     "Review inline comment count; not yet surfaced in dashboard read API",
    "summary_count":    "Review summary comment count; not yet surfaced in dashboard read API",
    "comment_node_ids": "GraphQL node IDs for posted comments; internal bookkeeping",
    "fallback_reason":  "Why incremental review fell back to full; diagnostic only",
    "range_base":       "Incremental review range start SHA; diagnostic only",
    "range_head":       "Incremental review range end SHA; diagnostic only",
    "model_source":     "How the model was resolved; diagnostic only",
    "config_resolution":"Config resolution detail; diagnostic only",
    "job_conclusion":   "CI job conclusion; not yet surfaced in dashboard read API",
    "round_ordinal":    "Which review round this was; not yet surfaced in dashboard read API",
    "pr_title":         "PR title snapshot; not yet surfaced in dashboard read API",
    "pr_author":        "PR author; not yet surfaced in dashboard read API",
    "pr_state":         "PR state; not yet surfaced in dashboard read API",
    "pr_base_ref":      "PR base branch; not yet surfaced in dashboard read API",
    "pr_head_ref":      "PR head branch; not yet surfaced in dashboard read API",
}


# ── Migration parser ─────────────────────────────────────────

def parse_migrations():
    """Parse all migration SQL files and return {table_name: {col, ...}}."""
    tables = {}
    sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        sys.exit(f"No .sql files found in {MIGRATIONS_DIR}")

    for path in sql_files:
        sql = path.read_text()
        # Remove SQL comments
        sql = re.sub(r"--[^\n]*", "", sql)

        # CREATE TABLE
        for m in re.finditer(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^;]+)\)",
            sql, re.IGNORECASE | re.DOTALL,
        ):
            table = m.group(1).lower()
            body = m.group(2)
            cols = set()
            for line in body.split(","):
                line = line.strip()
                if not line:
                    continue
                first_word = line.split()[0].upper() if line.split() else ""
                if first_word in ("PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"):
                    continue
                col_name = line.split()[0].strip('"').strip("'").strip("`").lower()
                if col_name:
                    cols.add(col_name)
            tables.setdefault(table, set()).update(cols)

        # ALTER TABLE ... ADD COLUMN
        for m in re.finditer(
            r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)",
            sql, re.IGNORECASE,
        ):
            table = m.group(1).lower()
            col = m.group(2).lower()
            tables.setdefault(table, set()).add(col)

    return tables


# ── index.js parser ───────────────────────────────────────────

def parse_index_js():
    """Parse INSERT and SELECT column lists from worker/index.js.

    Returns:
        inserts: {table_name: {col, ...}}
        selects: {table_name: {col, ...}}
    """
    source = INDEX_JS.read_text()
    inserts = {}
    selects = {}

    # Find INSERT INTO statements with explicit column lists
    for m in re.finditer(
        r"INSERT\s+INTO\s+(\w+)\s*\(\s*([^)]+)\)",
        source, re.IGNORECASE | re.DOTALL,
    ):
        table = m.group(1).lower()
        cols_raw = m.group(2)
        cols = {c.strip().lower() for c in cols_raw.split(",") if c.strip()}
        inserts.setdefault(table, set()).update(cols)

    # Find SELECT column lists — two strategies:
    #
    # Strategy A: Literal SELECT ... FROM table (catches handleSummary aggregates
    # and any direct SQL).  We extract individual column references from the
    # select-list, skipping aggregate wrappers.
    for m in re.finditer(
        r"SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)",
        source, re.IGNORECASE,
    ):
        cols_raw = m.group(1).strip()
        table = m.group(2).lower()

        cols = set()
        for part in cols_raw.split(","):
            part = part.strip()
            if not part or part == "*":
                continue
            # Extract column names from aggregate expressions like AVG(duration_ms)
            agg_match = re.findall(r"(?:AVG|SUM|MIN|MAX|COUNT)\s*\(\s*(\w+)\s*\)", part, re.IGNORECASE)
            if agg_match:
                for col in agg_match:
                    if col.upper() != "*":
                        cols.add(col.lower())
                continue
            # Plain column reference
            col_match = re.match(r"(\w+)", part)
            if col_match:
                col = col_match.group(1).lower()
                if col.upper() in ("SELECT", "DISTINCT", "COUNT", "AVG", "SUM",
                                    "MIN", "MAX", "AS", "CASE", "WHEN", "NULL"):
                    continue
                cols.add(col)
        if cols:
            selects.setdefault(table, set()).update(cols)

    # Strategy B: JS-constructed SELECTs via const columns = [...] arrays
    # followed by columns.push(...) and then FROM table_name in a template.
    # This catches handleRuns() which builds its column list programmatically.
    #
    # Look for patterns: `FROM usage_records` in template literals, and trace
    # back to find the columns array and push calls in the same function scope.
    #
    # Simpler approach: find all quoted string literals that look like column
    # names in array contexts near SELECT/FROM patterns.

    # Find the columns array in handleRuns (lines with `const columns = [`)
    # and the push call.
    columns_match = re.search(
        r'const\s+columns\s*=\s*\[(.*?)\]\s*;',
        source, re.DOTALL,
    )
    if columns_match:
        arr_body = columns_match.group(1)
        arr_cols = set(re.findall(r'"(\w+)"', arr_body))

        # Find push calls on columns: columns.push("col1", "col2", ...)
        for pm in re.finditer(r'columns\.push\(([^)]+)\)', source):
            push_body = pm.group(1)
            arr_cols.update(re.findall(r'"(\w+)"', push_body))

        # Find which table this SELECT is FROM
        # Look for template literal: FROM <table>
        table_match = re.search(
            r'FROM\s+(\w+)',
            source[columns_match.end():columns_match.end() + 500],
            re.IGNORECASE,
        )
        if table_match:
            table = table_match.group(1).lower()
            selects.setdefault(table, set()).update(
                c.lower() for c in arr_cols
            )

    return inserts, selects


# ── Test logic ────────────────────────────────────────────────

def main():
    fails = []
    print("=== Schema-to-Code Drift Check ===\n")

    schema = parse_migrations()
    inserts, selects = parse_index_js()

    print(f"  Schema tables:  {', '.join(sorted(schema))}")
    print(f"  INSERT tables:  {', '.join(sorted(inserts))}")
    print(f"  SELECT tables:  {', '.join(sorted(selects))}")
    print()

    # ── Check 1: every INSERT column exists in the schema ─────
    print("  Check 1: INSERT columns exist in schema")
    for table, cols in sorted(inserts.items()):
        schema_cols = schema.get(table, set())
        if not schema_cols:
            fails.append(f"INSERT into unknown table '{table}': no migration creates it")
            print(f"    FAIL  table '{table}' has no schema")
            continue
        extra = cols - schema_cols
        if extra:
            fails.append(
                f"INSERT into '{table}' writes columns that no migration creates: "
                f"{', '.join(sorted(extra))}"
            )
            print(f"    FAIL  {table}: INSERT writes columns not in schema: {', '.join(sorted(extra))}")
        else:
            print(f"    ok    {table}: all {len(cols)} INSERT columns exist in schema")

    # ── Check 2: every usage_records schema column is read or allowlisted ─
    print("\n  Check 2: usage_records schema columns are read or allowlisted")
    ur_schema = schema.get("usage_records", set())
    ur_selects = selects.get("usage_records", set())
    allowlisted = set(USAGE_RECORDS_READ_ALLOWLIST.keys())

    # Verify allowlist entries are actual schema columns
    phantom = allowlisted - ur_schema
    if phantom:
        fails.append(
            f"USAGE_RECORDS_READ_ALLOWLIST names columns not in the schema: "
            f"{', '.join(sorted(phantom))}. Remove stale allowlist entries."
        )
        print(f"    FAIL  allowlist names phantom columns: {', '.join(sorted(phantom))}")

    unread = ur_schema - ur_selects - allowlisted
    if unread:
        fails.append(
            f"usage_records columns exist in schema but are neither read nor "
            f"allowlisted: {', '.join(sorted(unread))}. Either:\n"
            f"  • Add them to the SELECT in handleRuns() so the dashboard can use them, or\n"
            f"  • Add them to USAGE_RECORDS_READ_ALLOWLIST in tests/test-schema-drift.py "
            f"with a reason."
        )
        print(f"    FAIL  unread and un-allowlisted columns: {', '.join(sorted(unread))}")
    else:
        print(f"    ok    all {len(ur_schema)} usage_records columns are read or allowlisted")

    # ── Summary ───────────────────────────────────────────────
    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all schema drift checks passed")


if __name__ == "__main__":
    main()
