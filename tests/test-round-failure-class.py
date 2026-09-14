#!/usr/bin/env python3
"""Behavioural tests for the "Classify the round's outcome" step (#174).

Extracts the REAL Python out of claude-code-review.yml and runs it against fixture
execution files, verifying the failure_class table, reset_at parsing, and message
redaction.

Run: python3 tests/test-round-failure-class.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP_NAME = "Classify the round's outcome"


def extract_step_script() -> str:
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                return step["run"]
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


def run_case(script, *, execution_file=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        out_file = tdp / "output.txt"
        out_file.touch()

        env = dict(os.environ)
        env["GITHUB_OUTPUT"] = str(out_file)
        if execution_file is not None:
            env["EXECUTION_FILE"] = str(execution_file)
        else:
            env.pop("EXECUTION_FILE", None)

        p = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v
        return p.returncode, outputs, p.stdout, p.stderr


def write_fixture(tdp, result_obj, extra_events=None):
    events = list(extra_events or [])
    events.append(result_obj)
    path = tdp / "execution.json"
    path.write_text(json.dumps(events))
    return path


def main():
    script = extract_step_script()
    fails = []

    def check(name, ok, detail=""):
        if ok:
            print(f"  ok    {name}")
        else:
            fails.append(f"{name}: {detail}")
            print(f"  FAIL  {name}: {detail}")

    print(f"=== Testing {STEP_NAME!r} (#174) ===\n")

    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)

        # 1. Real session-limit example.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 429,
            "terminal_reason": "api_error", "subtype": "success", "num_turns": 1,
            "timestamp": "2026-09-13T09:46:05Z",
            "result": "You've hit your session limit · resets 10:10am (UTC)",
        })
        rc, out, _, err = run_case(script, execution_file=fx)
        check("1 real session-limit: exits 0", rc == 0, f"rc={rc} err={err}")
        check("1 real session-limit: failure_class=account-limit", out.get("failure_class") == "account-limit", f"got {out}")
        check("1 real session-limit: retryable=0", out.get("failure_retryable") == "0", f"got {out}")
        check("1 real session-limit: reset at 10:10Z on the fixture's date", out.get("failure_reset_at") == "2026-09-13T10:10:00Z", f"got {out.get('failure_reset_at')}")
        check("1 real session-limit: api_error_status=429", out.get("api_error_status") == "429", f"got {out}")

        # 2. weekly limit.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 429,
            "timestamp": "2026-01-01T00:00:00Z",
            "result": "You've hit your weekly limit · resets January 5 at 00:00 UTC",
        })
        rc, out, _, err = run_case(script, execution_file=fx)
        check("2 weekly limit: account-limit", out.get("failure_class") == "account-limit", f"got {out} err={err}")
        check("2 weekly limit: reset_at parses the month/day form", out.get("failure_reset_at") == "2026-01-05T00:00:00Z", f"got {out.get('failure_reset_at')}")

        # 3. 429 rate_limit_error.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 429,
            "result": "Error: rate_limit_error: Number of request tokens exceeds limit",
        })
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("3 429 rate_limit_error: rate-limited", out.get("failure_class") == "rate-limited", f"got {out}")
        check("3 429 rate_limit_error: retryable=1", out.get("failure_retryable") == "1", f"got {out}")
        check("3 429 rate_limit_error: no reset_at", out.get("failure_reset_at", "") == "", f"got {out}")

        # 4. 401 authentication_error.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 401,
            "result": "Error: authentication_error: invalid x-api-key",
        })
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("4 401 authentication_error: auth-failed", out.get("failure_class") == "auth-failed", f"got {out}")
        check("4 401 authentication_error: retryable=0", out.get("failure_retryable") == "0", f"got {out}")

        # 5. Login expired text, no status.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True,
            "result": "Login expired · Please run /login",
        })
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("5 login expired: auth-failed", out.get("failure_class") == "auth-failed", f"got {out}")

        # 6. 402.
        fx = write_fixture(tdp, {"type": "result", "is_error": True, "api_error_status": 402, "result": "Payment required"})
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("6 402: billing", out.get("failure_class") == "billing", f"got {out}")

        # 7. 400 model not available.
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 400,
            "result": "Claude Opus is not available with the Claude Pro plan",
        })
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("7 400 model unavailable: model-unavailable", out.get("failure_class") == "model-unavailable", f"got {out}")

        # 8. 413.
        fx = write_fixture(tdp, {"type": "result", "is_error": True, "api_error_status": 413, "result": "Request too large"})
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("8 413: request-too-large", out.get("failure_class") == "request-too-large", f"got {out}")

        # 9. 529.
        fx = write_fixture(tdp, {"type": "result", "is_error": True, "api_error_status": 529, "result": "Overloaded"})
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("9 529: api-unavailable", out.get("failure_class") == "api-unavailable", f"got {out}")
        check("9 529: retryable=1", out.get("failure_retryable") == "1", f"got {out}")

        # 10. An unknown is_error with no matching class.
        fx = write_fixture(tdp, {"type": "result", "is_error": True, "api_error_status": 999, "result": "Something unexpected broke"})
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("10 unknown is_error: api-error", out.get("failure_class") == "api-error", f"got {out}")
        check("10 unknown is_error: retryable=0", out.get("failure_retryable") == "0", f"got {out}")

        # 11. is_error: false gives empty.
        fx = write_fixture(tdp, {"type": "result", "is_error": False, "api_error_status": None, "result": "ok"})
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("11 is_error false: empty failure_class", out.get("failure_class", "") == "", f"got {out}")

        # 12. A missing file gives empty.
        rc, out, _, err = run_case(script, execution_file=tdp / "does-not-exist.json")
        check("12 missing file: exits 0", rc == 0, f"rc={rc} err={err}")
        check("12 missing file: empty failure_class", out.get("failure_class", "") == "", f"got {out}")

        # 13. A message containing a long token-looking string is redacted.
        token = "sk-ant-" + ("a" * 40)
        fx = write_fixture(tdp, {
            "type": "result", "is_error": True, "api_error_status": 401,
            "result": f"authentication_error: key {token} rejected",
        })
        rc, out, _, _ = run_case(script, execution_file=fx)
        check("13 long token redacted", token not in out.get("failure_message", "REDACTED-CHECK-FAILED") and "[redacted]" in out.get("failure_message", ""), f"got {out.get('failure_message')!r}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all round failure classification tests passed")


if __name__ == "__main__":
    main()
