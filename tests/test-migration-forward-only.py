#!/usr/bin/env python3
"""Behavioural tests for the forward-only migration guard in tests.yml.

Extracts the REAL shell body out of .github/workflows/tests.yml and runs it
against a stubbed git, proving:
  1. A new migration file passes.
  2. A modified existing migration fails.
  3. A deleted existing migration fails.

Run: python3 tests/test-migration-forward-only.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/tests.yml"
STEP = "Forward-only migration guard"


def extract_step_script():
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def run_guard(script, *, diff_output="", env_extras=None):
    """Run the forward-only guard step with a stubbed git.

    diff_output: newline-separated lines in the format git diff --name-status
    produces, e.g. "A\tworker/migrations/0003_foo.sql"
    """
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()

        diff_file = tdp / "diff_output.txt"
        diff_file.write_text(diff_output)

        git_stub = binp / "git"
        git_stub.write_text(f"""#!/usr/bin/env bash
# Stub git.  Routes on the first meaningful argument.
args="$*"

# git fetch — no-op
if [[ "$args" == *"fetch"* ]]; then
  exit 0
fi

# git merge-base — return a fake SHA
if [[ "$args" == *"merge-base"* ]]; then
  echo "abc123def456"
  exit 0
fi

# git diff --name-status — return the configured output
if [[ "$args" == *"--name-status"* ]]; then
  cat "{diff_file}"
  exit 0
fi

echo "git stub: unrouted call: $args" >&2
exit 1
""")
        git_stub.chmod(0o755)

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_BASE_REF="main",
        )
        if env_extras:
            env.update(env_extras)

        p = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(tdp),
        )
        return p


def main():
    script = extract_step_script()
    fails = []
    print("=== Testing Forward-Only Migration Guard ===\n")

    # Case 1: New migration file → pass
    proc = run_guard(script, diff_output="A\tworker/migrations/0003_new_table.sql\n")
    if proc.returncode != 0:
        fails.append(f"new migration: expected exit 0, got {proc.returncode}: {proc.stderr[:200]}")
        print(f"  FAIL  new migration: exited {proc.returncode}")
    else:
        print("  ok    new migration file: passes")

    # Case 2: No migration changes → pass
    proc = run_guard(script, diff_output="")
    if proc.returncode != 0:
        fails.append(f"no changes: expected exit 0, got {proc.returncode}: {proc.stderr[:200]}")
        print(f"  FAIL  no changes: exited {proc.returncode}")
    else:
        print("  ok    no migration changes: passes")

    # Case 3: Modified existing migration → fail
    proc = run_guard(script, diff_output="M\tworker/migrations/0001_initial_schema.sql\n")
    combined = proc.stdout + "\n" + proc.stderr
    if proc.returncode == 0:
        fails.append("modified migration: expected non-zero exit, got 0")
        print("  FAIL  modified migration: exit 0")
    elif "0001_initial_schema.sql" not in combined:
        fails.append("modified migration: error does not name the offending file")
        print("  FAIL  modified migration: missing filename in error")
    else:
        print("  ok    modified existing migration: fails and names the file")

    # Case 4: Deleted existing migration → fail
    proc = run_guard(script, diff_output="D\tworker/migrations/0001_initial_schema.sql\n")
    combined = proc.stdout + "\n" + proc.stderr
    if proc.returncode == 0:
        fails.append("deleted migration: expected non-zero exit, got 0")
        print("  FAIL  deleted migration: exit 0")
    elif "0001_initial_schema.sql" not in combined:
        fails.append("deleted migration: error does not name the offending file")
        print("  FAIL  deleted migration: missing filename in error")
    else:
        print("  ok    deleted existing migration: fails and names the file")

    # Case 5: Mix — one new, one modified → fail (the modified one is the problem)
    diff = "A\tworker/migrations/0003_new_table.sql\nM\tworker/migrations/0001_initial_schema.sql\n"
    proc = run_guard(script, diff_output=diff)
    combined = proc.stdout + "\n" + proc.stderr
    if proc.returncode == 0:
        fails.append("mixed changes: expected non-zero exit, got 0")
        print("  FAIL  mixed changes: exit 0")
    elif "0001_initial_schema.sql" not in combined:
        fails.append("mixed changes: error does not name the modified file")
        print("  FAIL  mixed changes: missing filename in error")
    else:
        print("  ok    mixed new + modified: fails and names the modified file")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all forward-only migration guard tests passed")


if __name__ == "__main__":
    main()
