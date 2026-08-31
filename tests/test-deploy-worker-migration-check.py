#!/usr/bin/env python3
"""Behavioural tests for the D1 migration check step in deploy-worker.yml.

Extracts the REAL shell body out of .github/workflows/deploy-worker.yml and runs it
against stubbed wrangler invocations to prove all three distinct states:
1. Migrations are up to date (clean schema, exit 0, no warning, no summary).
2. A migration is pending (exit 0, pending migrations warning & step summary).
3. The migration state could not be determined (exit 0, check failure warning & step summary).

Run: python3 tests/test-deploy-worker-migration-check.py
"""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/deploy-worker.yml"
STEP = "Check for pending D1 migrations"


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def run_migration_check(script: str, *, wrangler_output: str = "", wrangler_exit_code: int = 0):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        bin_dir = tdp / "node_modules" / ".bin"
        bin_dir.mkdir(parents=True)
        wrangler_bin = bin_dir / "wrangler"

        # Stub wrangler binary
        wrangler_script = f"""#!/usr/bin/env bash
cat <<'EOF_WRANGLER'
{wrangler_output}
EOF_WRANGLER
exit {wrangler_exit_code}
"""
        wrangler_bin.write_text(wrangler_script)
        wrangler_bin.chmod(0o755)

        summary_file = tdp / "step_summary.md"
        summary_file.touch()

        env = dict(os.environ)
        env.update(
            GITHUB_STEP_SUMMARY=str(summary_file),
            CLOUDFLARE_API_TOKEN="fake-token",
        )

        p = subprocess.run(
            ["bash", "-c", script],
            cwd=str(tdp),
            env=env,
            capture_output=True,
            text=True,
        )

        summary_content = summary_file.read_text()
        return p, summary_content


def test_suite():
    script = extract_step_script()
    print("=== Testing Deploy Worker Migration Check Logic ===")

    # State 1: Up to date (clean schema)
    clean_output = """
 ⛅️ wrangler 4.127.1
────────────────────
Resource location: remote 

✅ No migrations to apply!
"""
    proc, summary = run_migration_check(script, wrangler_output=clean_output, wrangler_exit_code=0)
    assert proc.returncode == 0, f"State 1 failed with non-zero exit: {proc.returncode}"
    assert "::warning::" not in proc.stdout and "::warning::" not in proc.stderr, "State 1 must not emit warning"
    assert "::error::" not in proc.stdout and "::error::" not in proc.stderr, "State 1 must not emit error"
    assert summary.strip() == "", f"State 1 step summary must be empty, got: {summary!r}"
    print("  ok    State 1 (Up to date): exit 0, no warning, no step summary")

    # State 2: Pending migration
    pending_output = """
 ⛅️ wrangler 4.127.1
────────────────────
Resource location: remote 

Migrations to be applied:
┌─────────────────────────┐
│ Name                    │
├─────────────────────────┤
│ 0002_new_columns.sql    │
└─────────────────────────┘
"""
    proc, summary = run_migration_check(script, wrangler_output=pending_output, wrangler_exit_code=0)
    assert proc.returncode == 0, f"State 2 failed with non-zero exit: {proc.returncode}"
    assert "::warning::Pending D1 migrations detected on remote database review-telemetry" in proc.stdout, "State 2 missing warning"
    assert "## ⚠️ Pending D1 Migrations" in summary, "State 2 missing step summary header"
    assert "wrangler d1 migrations apply review-telemetry --remote" in summary, "State 2 missing manual apply command in summary"
    print("  ok    State 2 (Pending migration): exit 0, pending warning emitted, step summary written")

    # State 3a: Check failed with exit code 1 (e.g. database not found or config missing)
    error_output = """
 ⛅️ wrangler 4.127.1
────────────────────
Resource location: remote 

✘ [ERROR] Couldn't find a D1 DB with the name or binding 'review-telemetry' in your wrangler.toml file.
"""
    proc, summary = run_migration_check(script, wrangler_output=error_output, wrangler_exit_code=1)
    assert proc.returncode == 0, f"State 3a must proceed with exit 0, got: {proc.returncode}"
    assert "::warning::Could not determine D1 migration state for remote database review-telemetry (wrangler d1 migrations list exited with status 1)" in proc.stdout, "State 3a missing distinct warning"
    assert "## ⚠️ D1 Migration Check Failed" in summary, "State 3a missing step summary header"
    assert "wrangler d1 migrations list review-telemetry --remote" in summary, "State 3a missing manual check command in summary"
    assert "exit status 1" in summary, "State 3a missing exit status in summary"
    print("  ok    State 3a (Check failure exit 1): exit 0, failure warning emitted, step summary written")

    # State 3b: Check failed with exit code 2 (e.g. auth / network failure)
    auth_error_output = """
 ⛅️ wrangler 4.127.1
────────────────────
Resource location: remote 

✘ [ERROR] A request to the Cloudflare API (/accounts/.../d1/database/...) failed.
Authentication error (10000)
"""
    proc, summary = run_migration_check(script, wrangler_output=auth_error_output, wrangler_exit_code=2)
    assert proc.returncode == 0, f"State 3b must proceed with exit 0, got: {proc.returncode}"
    assert "::warning::Could not determine D1 migration state for remote database review-telemetry (wrangler d1 migrations list exited with status 2)" in proc.stdout, "State 3b missing distinct warning"
    assert "## ⚠️ D1 Migration Check Failed" in summary, "State 3b missing step summary header"
    assert "exit status 2" in summary, "State 3b missing exit status in summary"
    print("  ok    State 3b (Check failure exit 2): exit 0, failure warning emitted with status 2, step summary written")

    print("\nAll migration check behavioural tests passed.")


if __name__ == "__main__":
    test_suite()
