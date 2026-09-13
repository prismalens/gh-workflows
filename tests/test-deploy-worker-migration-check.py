#!/usr/bin/env python3
"""Behavioural tests for the D1 migration guard: worker/scripts/d1-pending.sh and the
"Check for pending D1 migrations" step in deploy-worker.yml (#164).

The script is run against a stubbed wrangler that answers `d1 execute --json` with a
d1_migrations result set, proving:
1. Every file applied: exit 0, nothing on stdout.
2. Two files missing from d1_migrations: exit 2, exactly those names on stdout, in order.
3. wrangler exits non-zero: exit 1, its stderr forwarded, nothing on stdout.
4. wrangler exits 0 with a non-result body (the "did not look" case #164 measured): exit 1.
5. A clean summary line from wrangler with no rows (a fresh database): every file pending.

The guard step is run against a stubbed scripts/d1-pending.sh, proving:
6. Exit 0 from the script: step exits 0, no annotation, empty summary.
7. Exit 2: step exits 1, ::error:: names the pending files and the Apply workflow, summary too.
8. Exit 1: step exits 1, ::error:: says the state is unknown; the deploy never proceeds on
   an unread table.

Run: python3 tests/test-deploy-worker-migration-check.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/deploy-worker.yml"
SCRIPT = ROOT / "worker/scripts/d1-pending.sh"
STEP = "Check for pending D1 migrations"
MIGRATIONS = ["0001_initial_schema.sql", "0002_wave2_fields.sql", "0003_indexes.sql"]


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def run_script(*, applied=None, wrangler_stdout=None, wrangler_exit=0, wrangler_stderr=""):
    """Runs the real d1-pending.sh from a temp worker/ with a stubbed wrangler."""
    with tempfile.TemporaryDirectory() as td:
        worker = pathlib.Path(td) / "worker"
        (worker / "migrations").mkdir(parents=True)
        for name in MIGRATIONS:
            (worker / "migrations" / name).write_text("-- fixture\n")
        scripts = worker / "scripts"
        scripts.mkdir()
        (scripts / "d1-pending.sh").write_text(SCRIPT.read_text())
        (scripts / "d1-pending.sh").chmod(0o755)
        bin_dir = worker / "node_modules" / ".bin"
        bin_dir.mkdir(parents=True)
        if wrangler_stdout is None:
            wrangler_stdout = json.dumps(
                [{"results": [{"name": n} for n in (applied or [])], "success": True, "meta": {}}]
            )
        stub = f"""#!/usr/bin/env bash
printf '%s' {json.dumps(wrangler_stdout)}
printf '%s' {json.dumps(wrangler_stderr)} >&2
exit {wrangler_exit}
"""
        (bin_dir / "wrangler").write_text(stub)
        (bin_dir / "wrangler").chmod(0o755)
        p = subprocess.run(
            ["bash", str(scripts / "d1-pending.sh")],
            cwd=str(worker),
            capture_output=True,
            text=True,
            env={**os.environ, "CLOUDFLARE_API_TOKEN": "fake-token"},
        )
        return p


def run_guard(step: str, *, stub_stdout="", stub_exit=0):
    """Runs the real guard step body with scripts/d1-pending.sh stubbed."""
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        (tdp / "scripts").mkdir()
        stub = tdp / "scripts" / "d1-pending.sh"
        stub.write_text(f"#!/usr/bin/env bash\nprintf '%s' {json.dumps(stub_stdout)}\nexit {stub_exit}\n")
        stub.chmod(0o755)
        summary = tdp / "summary.md"
        summary.touch()
        p = subprocess.run(
            ["bash", "-c", step],
            cwd=str(tdp),
            capture_output=True,
            text=True,
            env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary), "CLOUDFLARE_API_TOKEN": "fake-token"},
        )
        return p, summary.read_text()


def test_script():
    print("=== worker/scripts/d1-pending.sh ===")

    p = run_script(applied=MIGRATIONS)
    assert p.returncode == 0, f"1: expected exit 0, got {p.returncode}: {p.stderr}"
    assert p.stdout == "", f"1: expected empty stdout, got {p.stdout!r}"
    print("  ok    1 every file applied: exit 0, silent")

    p = run_script(applied=[MIGRATIONS[0]])
    assert p.returncode == 2, f"2: expected exit 2, got {p.returncode}: {p.stderr}"
    assert p.stdout.split() == MIGRATIONS[1:], f"2: expected {MIGRATIONS[1:]}, got {p.stdout.split()}"
    print("  ok    2 two files pending: exit 2, both named in order")

    p = run_script(wrangler_stdout="", wrangler_exit=1, wrangler_stderr="Authentication error (10000)\n")
    assert p.returncode == 1, f"3: expected exit 1, got {p.returncode}"
    assert "Authentication error" in p.stderr, f"3: wrangler stderr not forwarded: {p.stderr!r}"
    assert "exited with status 1" in p.stderr, f"3: status not named: {p.stderr!r}"
    assert p.stdout == "", f"3: nothing may look pending on an unread table, got {p.stdout!r}"
    print("  ok    3 wrangler fails: exit 1, stderr forwarded, stdout empty")

    # The measured #164 case: wrangler exits 0 and prints a summary it could not know.
    p = run_script(wrangler_stdout="✅ No migrations to apply!\n", wrangler_exit=0)
    assert p.returncode == 1, f"4: a non-result body must be unknown (exit 1), got {p.returncode}"
    assert "no result set" in p.stderr, f"4: cause not named: {p.stderr!r}"
    assert p.stdout == "", f"4: stdout must be empty, got {p.stdout!r}"
    print("  ok    4 wrangler exit 0 with a prose body: exit 1, never read as clean")

    p = run_script(applied=[])
    assert p.returncode == 2, f"5: expected exit 2 on an empty table, got {p.returncode}"
    assert p.stdout.split() == MIGRATIONS, f"5: expected every file, got {p.stdout.split()}"
    print("  ok    5 empty d1_migrations: every file pending")


def test_guard_step():
    print("=== deploy-worker.yml: Check for pending D1 migrations ===")
    step = extract_step_script()
    assert "scripts/d1-pending.sh" in step, "the guard must call the script, not wrangler's list summary"
    assert "d1 migrations list" not in step, "the guard must not read `wrangler d1 migrations list` (#164)"

    p, summary = run_guard(step, stub_exit=0)
    assert p.returncode == 0, f"6: expected exit 0, got {p.returncode}: {p.stdout}{p.stderr}"
    assert "::error::" not in p.stdout and "::warning::" not in p.stdout, f"6: no annotation allowed: {p.stdout!r}"
    assert summary.strip() == "", f"6: summary must be empty, got {summary!r}"
    print("  ok    6 nothing pending: exit 0, no annotation, empty summary")

    p, summary = run_guard(step, stub_stdout="0002_wave2_fields.sql\n0003_indexes.sql\n", stub_exit=2)
    assert p.returncode == 1, f"7: expected exit 1, got {p.returncode}"
    assert "::error::Pending D1 migrations" in p.stdout, f"7: missing error: {p.stdout!r}"
    for name in ("0002_wave2_fields.sql", "0003_indexes.sql"):
        assert name in p.stdout, f"7: {name} not named in the error: {p.stdout!r}"
        assert name in summary, f"7: {name} not named in the summary: {summary!r}"
    assert "Apply D1 migrations" in p.stdout and "Apply D1 migrations" in summary, "7: the Apply workflow must be named"
    assert "## ⚠️ Pending D1 Migrations" in summary, f"7: summary header missing: {summary!r}"
    print("  ok    7 pending: exit 1, files and the Apply workflow named in error and summary")

    p, summary = run_guard(step, stub_exit=1)
    assert p.returncode == 1, f"8: an unread table must stop the deploy (exit 1), got {p.returncode}"
    assert "::error::Could not read d1_migrations" in p.stdout, f"8: missing error: {p.stdout!r}"
    assert "status 1" in p.stdout, f"8: status not named: {p.stdout!r}"
    assert "::warning::" not in p.stdout, "8: unknown state is an error now, never a warning that proceeds (#164)"
    assert "## ⚠️ D1 Migration Check Failed" in summary, f"8: summary header missing: {summary!r}"
    print("  ok    8 unknown state: exit 1, error, summary; the deploy does not proceed")


if __name__ == "__main__":
    test_script()
    test_guard_step()
    print("\nAll migration guard behavioural tests passed.")
