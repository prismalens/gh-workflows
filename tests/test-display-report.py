#!/usr/bin/env python3
"""Behavioural tests for the Display review report step (Step Summary).

Extracts the REAL shell body out of claude-code-review.yml and runs it against
fixture data, so the thing under test is the shipped code rather than a copy.

Covers: well-formed execution file → expected table; missing file → warning,
no failure; malformed file → warning, no failure.

Run: python3 tests/test-display-report.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP = "Display review report in Step Summary"


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


WELL_FORMED = [
    {"message": {"role": "assistant", "content": [{"type": "text", "text": "Reviewing the code."}],
                 "usage": {"input_tokens": 1000, "output_tokens": 200,
                           "cache_read_input_tokens": 500, "cache_creation_input_tokens": 100},
                 "model": "claude-sonnet-5"}, "type": "assistant"},
    {"message": {"role": "assistant", "content": [{"type": "text", "text": "Found one issue."}],
                 "usage": {"input_tokens": 800, "output_tokens": 150,
                           "cache_read_input_tokens": 300, "cache_creation_input_tokens": 50},
                 "model": "claude-sonnet-5"}, "type": "assistant"},
    {"type": "result", "total_cost_usd": 0.042, "duration_ms": 12345,
     "num_turns": 3, "permission_denials": 0, "session_id": "sess-abc"},
]


def run_report(script, *, execution_file_content=None, execution_file_path=None):
    """Run the step script and return (summary_content, stderr, returncode)."""
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        summary = td / "step-summary.md"

        env = dict(os.environ)
        env.update(
            REPO="o/r", PR="42", HEAD_SHA="a" * 40,
            MODE="review", MODEL="claude-sonnet-5",
            RUN_ID="123456", SESSION_ID="sess-abc",
            GITHUB_STEP_SUMMARY=str(summary),
        )

        if execution_file_path is not None:
            env["EXECUTION_FILE"] = execution_file_path
        elif execution_file_content is not None:
            ef = td / "execution.json"
            ef.write_text(execution_file_content)
            env["EXECUTION_FILE"] = str(ef)
        else:
            env["EXECUTION_FILE"] = ""

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        content = summary.read_text() if summary.exists() else ""
        return content, p.stdout + p.stderr, p.returncode


def main():
    script = extract_step_script()
    fails = []

    print("running display-report tests against the real step body\n")

    # Case 1: well-formed execution file
    content, stderr, rc = run_report(script, execution_file_content=json.dumps(WELL_FORMED))
    ok = True
    if rc != 0:
        ok = False
        fails.append(f"well-formed: exited {rc}")
    if "| Input tokens | 1800 |" not in content:
        ok = False
        fails.append(f"well-formed: missing input_tokens sum in table")
    if "| Output tokens | 350 |" not in content:
        ok = False
        fails.append(f"well-formed: missing output_tokens sum in table")
    if "| Cache read tokens | 800 |" not in content:
        ok = False
        fails.append(f"well-formed: missing cache_read sum")
    if "| Total cost (USD) |" not in content:
        ok = False
        fails.append(f"well-formed: missing total cost row")
    if "| Turns | 3 |" not in content:
        ok = False
        fails.append(f"well-formed: missing turns row")
    if "Reviewing the code." not in content:
        ok = False
        fails.append(f"well-formed: missing reasoning text")
    if "Found one issue." not in content:
        ok = False
        fails.append(f"well-formed: missing second reasoning text")
    if "### Review Round Report" not in content:
        ok = False
        fails.append(f"well-formed: missing context header")
    if "| Session ID | `sess-abc` |" not in content:
        ok = False
        fails.append(f"well-formed: missing session_id")
    print(f"  {'ok  ' if ok else 'FAIL'}  well-formed execution file")

    # Case 2: missing file — must warn, exit 0
    content, stderr, rc = run_report(script, execution_file_path="/tmp/nonexistent-file-xyz.json")
    ok = True
    if rc != 0:
        ok = False
        fails.append(f"missing file: exited {rc}, expected 0")
    if "::warning::" not in stderr:
        ok = False
        fails.append(f"missing file: no warning emitted")
    if "missing" not in stderr.lower():
        ok = False
        fails.append(f"missing file: warning does not mention 'missing'")
    print(f"  {'ok  ' if ok else 'FAIL'}  missing execution file")

    # Case 3: empty file — must warn, exit 0
    content, stderr, rc = run_report(script, execution_file_content="")
    ok = True
    if rc != 0:
        ok = False
        fails.append(f"empty file: exited {rc}, expected 0")
    if "::warning::" not in stderr:
        ok = False
        fails.append(f"empty file: no warning emitted")
    if "empty" not in stderr.lower():
        ok = False
        fails.append(f"empty file: warning does not mention 'empty'")
    print(f"  {'ok  ' if ok else 'FAIL'}  empty execution file")

    # Case 4: malformed JSON — must warn, exit 0
    content, stderr, rc = run_report(script, execution_file_content="not json {{{")
    ok = True
    if rc != 0:
        ok = False
        fails.append(f"malformed: exited {rc}, expected 0")
    if "::warning::" not in stderr:
        ok = False
        fails.append(f"malformed: no warning emitted")
    if "parse" not in stderr.lower():
        ok = False
        fails.append(f"malformed: warning does not mention 'parse'")
    print(f"  {'ok  ' if ok else 'FAIL'}  malformed execution file")

    # Case 5: empty EXECUTION_FILE env var — must warn, exit 0
    content, stderr, rc = run_report(script, execution_file_path="")
    ok = True
    if rc != 0:
        ok = False
        fails.append(f"empty path: exited {rc}, expected 0")
    if "::warning::" not in stderr:
        ok = False
        fails.append(f"empty path: no warning emitted")
    print(f"  {'ok  ' if ok else 'FAIL'}  empty execution file path")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
