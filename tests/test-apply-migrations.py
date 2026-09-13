#!/usr/bin/env python3
"""Behavioural and structural tests for apply-migrations workflow (#164).

Run: python3 tests/test-apply-migrations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/apply-migrations.yml"


def extract_step(wf_data: dict, step_name: str) -> dict:
    steps = wf_data.get("jobs", {}).get("apply", {}).get("steps", [])
    for step in steps:
        if step.get("name") == step_name:
            return step
    raise KeyError(f"step {step_name!r} not found in apply job")


def check_structure(wf_data: dict) -> tuple[bool, str]:
    # Never on push: applying a migration is irreversible on D1 (#164).
    on_section = wf_data.get("on") or wf_data.get(True) or {}
    on_keys = set(on_section.keys())
    if on_keys != {"workflow_dispatch"}:
        return False, f"on trigger want exactly {{'workflow_dispatch'}}, got {on_keys!r}"

    perms = wf_data.get("permissions", {})
    if perms != {"contents": "read", "actions": "write"}:
        return False, f"permissions want {{'contents': 'read', 'actions': 'write'}}, got {perms!r}"

    concurrency = wf_data.get("concurrency", {})
    if concurrency.get("group") != "deploy-worker":
        return False, f"concurrency.group want 'deploy-worker', got {concurrency.get('group')!r}"
    if concurrency.get("cancel-in-progress") is not False:
        return False, f"concurrency.cancel-in-progress want False, got {concurrency.get('cancel-in-progress')!r}"

    apply_step = extract_step(wf_data, "Apply pending D1 migrations")
    apply_run = apply_step.get("run", "")
    if "wrangler d1 migrations apply review-telemetry --remote" not in apply_run:
        return False, f"Apply pending step missing wrangler apply command: {apply_run!r}"

    deploy_step = extract_step(wf_data, "Dispatch Deploy Worker")
    deploy_if = str(deploy_step.get("if", ""))
    if deploy_if != "${{ inputs.deploy_after }}":
        return False, f"Dispatch Deploy Worker if want '${{{{ inputs.deploy_after }}}}', got {deploy_if!r}"
    deploy_run = deploy_step.get("run", "")
    if "gh workflow run deploy-worker.yml --ref main" not in deploy_run:
        return False, f"Dispatch Deploy Worker missing gh workflow run command: {deploy_run!r}"

    return True, "workflow structure verified"


def run_step_script(script: str, stub_body: str, stub_exit_code: int) -> tuple[int, str, str, str]:
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        scripts_dir = tdp / "scripts"
        scripts_dir.mkdir()
        stub_file = scripts_dir / "d1-pending.sh"
        stub_file.write_text(
            f"#!/usr/bin/env bash\n{stub_body}\nexit {stub_exit_code}\n",
            encoding="utf-8",
        )
        stub_file.chmod(0o755)

        summary_file = tdp / "step_summary.md"
        env = dict(os.environ)
        env["GITHUB_STEP_SUMMARY"] = str(summary_file)

        proc = subprocess.run(
            ["bash", "-c", script],
            cwd=str(tdp),
            env=env,
            capture_output=True,
            text=True,
        )
        summary = summary_file.read_text(encoding="utf-8") if summary_file.exists() else ""
        return proc.returncode, proc.stdout, proc.stderr, summary


def main():
    fails = []
    print("=== Testing Apply Migrations Workflow Behaviour (#164) ===\n")

    if not WF.exists():
        sys.exit(f"workflow file not found at {WF}")

    wf_data = yaml.safe_load(WF.read_text(encoding="utf-8"))

    # 1. Structure assertions
    ok, msg = check_structure(wf_data)
    if not ok:
        fails.append(f"structure check: {msg}")
        print(f"  FAIL  structure check: {msg}")
    else:
        print(f"  ok    structure check: {msg}")

    verify_script = extract_step(wf_data, "Verify d1_migrations lists every file in worker/migrations")["run"]
    say_script = extract_step(wf_data, "Say what is pending before applying")["run"]

    # 2. Verify step - stub exits 0: script exits 0, summary contains ## D1 migrations applied
    code, out, err, summary = run_step_script(verify_script, "", 0)
    if code != 0:
        fails.append(f"verify step stub 0: expected exit 0, got {code} (stdout: {out!r})")
        print(f"  FAIL  verify step stub 0: exit {code}")
    elif "## D1 migrations applied" not in summary:
        fails.append(f"verify step stub 0: summary missing '## D1 migrations applied' (summary: {summary!r})")
        print("  FAIL  verify step stub 0: missing summary heading")
    else:
        print("  ok    verify step stub 0: exits 0, summary contains '## D1 migrations applied'")

    # 3. Verify step - stub prints 0012_next.sql and exits 2: script exits 1, stdout has ::error:: naming 0012_next.sql
    code, out, err, summary = run_step_script(verify_script, 'echo "0012_next.sql"', 2)
    if code != 1:
        fails.append(f"verify step stub 2: expected exit 1, got {code}")
        print(f"  FAIL  verify step stub 2: exit {code}")
    elif "::error::" not in out or "0012_next.sql" not in out:
        fails.append(f"verify step stub 2: stdout missing '::error::' or '0012_next.sql' (stdout: {out!r})")
        print("  FAIL  verify step stub 2: output missing annotation or file")
    else:
        print("  ok    verify step stub 2: exits 1, stdout has ::error:: naming 0012_next.sql")

    # 4. Verify step - stub exits 1: script exits 1, stdout has ::error:: containing exit status 1
    code, out, err, summary = run_step_script(verify_script, "", 1)
    if code != 1:
        fails.append(f"verify step stub 1: expected exit 1, got {code}")
        print(f"  FAIL  verify step stub 1: exit {code}")
    elif "::error::" not in out or "exit status 1" not in out:
        fails.append(f"verify step stub 1: stdout missing '::error::' or 'exit status 1' (stdout: {out!r})")
        print("  FAIL  verify step stub 1: output missing annotation or exit status")
    else:
        print("  ok    verify step stub 1: exits 1, stdout has ::error:: containing exit status 1")

    # 5. Say pending step - stub exits 0: exit 0 and prints Nothing pending
    code, out, err, summary = run_step_script(say_script, "", 0)
    if code != 0:
        fails.append(f"say step stub 0: expected exit 0, got {code}")
        print(f"  FAIL  say step stub 0: exit {code}")
    elif "Nothing pending" not in out:
        fails.append(f"say step stub 0: stdout missing 'Nothing pending' (stdout: {out!r})")
        print("  FAIL  say step stub 0: missing 'Nothing pending'")
    else:
        print("  ok    say step stub 0: exits 0 and prints 'Nothing pending'")

    # 6. Say pending step - stub prints 0012_next.sql and exits 2: exit 0 and prints 0012_next.sql under Pending:
    code, out, err, summary = run_step_script(say_script, 'echo "0012_next.sql"', 2)
    if code != 0:
        fails.append(f"say step stub 2: expected exit 0, got {code}")
        print(f"  FAIL  say step stub 2: exit {code}")
    elif "Pending:" not in out or "0012_next.sql" not in out:
        fails.append(f"say step stub 2: stdout missing 'Pending:' or '0012_next.sql' (stdout: {out!r})")
        print("  FAIL  say step stub 2: missing 'Pending:' or '0012_next.sql'")
    else:
        print("  ok    say step stub 2: exits 0 and prints 0012_next.sql under 'Pending:'")

    # 7. Say pending step - stub exits 1: exit 1 with ::error::
    code, out, err, summary = run_step_script(say_script, "", 1)
    if code != 1:
        fails.append(f"say step stub 1: expected exit 1, got {code}")
        print(f"  FAIL  say step stub 1: exit {code}")
    elif "::error::" not in out:
        fails.append(f"say step stub 1: stdout missing '::error::' (stdout: {out!r})")
        print("  FAIL  say step stub 1: missing '::error::'")
    else:
        print("  ok    say step stub 1: exits 1 with ::error::")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all apply-migrations tests passed")


if __name__ == "__main__":
    main()
