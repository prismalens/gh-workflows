#!/usr/bin/env python3
"""Behavioural tests for actions/npm-install-retry (#250).

Runs the action's real step script against a fake install command, verifying:
1. A clean install runs once and exits 0.
2. E404 then ETARGET then success: two retry warnings, exit 0.
3. A failure that is not a propagation error is not retried and keeps its exit code.
4. A retry budget spent on E404 ends with the command's exit code and an error.

Run: python3 tests/test-npm-install-retry.py
"""
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _composite_action import extract_composite_step_script  # noqa: E402
from _bash_step import run_step, write_fake  # noqa: E402

SCRIPT = extract_composite_step_script(ROOT / "actions/npm-install-retry/action.yml")

# The fake reads its scripted outcomes, one per call, from $PLAN.
FAKE = """n=$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$COUNT"
line=$(sed -n "${n}p" "$PLAN")
case "$line" in
  ok) echo installed; exit 0 ;;
  *) echo "npm error code $line" >&2; exit 1 ;;
esac
"""


def run(plan, delays="0 0 0"):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        write_fake(t / "bin", "fake-install", FAKE)
        (t / "plan").write_text("\n".join(plan) + "\n")
        r = run_step(SCRIPT, {"COMMAND": "fake-install", "DELAYS": delays,
                              "PLAN": str(t / "plan"), "COUNT": str(t / "count")}, t / "bin")
        calls = int((t / "count").read_text())
        return r, calls


failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(f"{name}: {detail}")


r, calls = run(["ok"])
check("1 clean install runs once", r.returncode == 0 and calls == 1, r.stdout + r.stderr)

r, calls = run(["E404", "ETARGET", "ok"])
check("2 propagation errors retried then succeed",
      r.returncode == 0 and calls == 3 and r.stdout.count("::warning::") == 2, r.stdout + r.stderr)
check("2 warning names the error and the count", "npm hit E404" in r.stdout and "retry 1/3" in r.stdout, r.stdout)

r, calls = run(["EACCES"])
check("3 other failure not retried", r.returncode == 1 and calls == 1 and "::warning::" not in r.stdout,
      r.stdout + r.stderr)

r, calls = run(["E404", "E404", "E404"], delays="0 0")
check("4 spent budget fails", r.returncode == 1 and calls == 3 and "::error::fake-install exited 1" in r.stdout,
      r.stdout + r.stderr)

if failures:
    sys.exit("\n".join(failures))
print("all npm-install-retry checks passed")
