#!/usr/bin/env python3
"""Behavioural tests for .github/actions/telemetry-auth/action.yml (#176).

Extracts the real shell body from action.yml and runs it in a subprocess with
stubs for curl and gh, verifying:
  1. OIDC token minting with audience and mask
  2. Fallback to bearer on OIDC mint failure
  3. Fallback to bearer when ACTIONS_ID_TOKEN_REQUEST_URL is unset
  4. Output method=none when neither is available
  5. Resolution of telemetry.share (override, local config, default full)

Run: python3 tests/test-telemetry-auth-action.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTION_FILE = ROOT / ".github" / "actions" / "telemetry-auth" / "action.yml"


def extract_script():
    action = yaml.safe_load(ACTION_FILE.read_text())
    for step in action.get("runs", {}).get("steps", []):
        if step.get("id") == "auth":
            return step["run"]
    sys.exit(f"step 'auth' not found in {ACTION_FILE}")


def run_action_step(script, *, env_vars=None, local_config=None, stub_curl_resp=None, stub_curl_fail=False):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()

        if local_config is not None:
            gh_dir = tdp / ".github"
            gh_dir.mkdir(parents=True, exist_ok=True)
            (gh_dir / "claude-review.yml").write_text(local_config)

        # Stub curl
        curl_script = f"""#!/usr/bin/env bash
if [ "{1 if stub_curl_fail else 0}" = "1" ]; then
  echo "curl: 500 Internal Server Error" >&2
  exit 1
fi
cat << 'EOF'
{stub_curl_resp or '{"value": "mock-jwt-token"}'}
EOF
exit 0
"""
        curl_bin = binp / "curl"
        curl_bin.write_text(curl_script)
        curl_bin.chmod(0o755)

        # Stub gh
        gh_script = """#!/usr/bin/env bash
exit 1
"""
        gh_bin = binp / "gh"
        gh_bin.write_text(gh_script)
        gh_bin.chmod(0o755)

        output_file = tdp / "github_output.txt"
        output_file.touch()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(output_file),
            RUNNER_TEMP=str(tdp),
            TARGET_URL="https://review-telemetry.sfun.cloud",
            BEARER_TOKEN="",
            SHARE_OVERRIDE="",
        )
        if env_vars:
            env.update(env_vars)

        proc = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(tdp),
        )

        outputs = {}
        if output_file.exists():
            for line in output_file.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    outputs[k] = v

        return proc, outputs


def main():
    script = extract_script()
    fails = []
    print("=== Testing Telemetry Auth Action (#176) ===\n")

    # Case 1: Successful OIDC token mint
    proc, outputs = run_action_step(
        script,
        env_vars={
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://actions.github.com/token?foo=bar",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "mock-runner-token",
            "BEARER_TOKEN": "fallback-bearer",
        },
        stub_curl_resp='{"value": "minted-oidc-token-123"}',
    )
    if proc.returncode != 0:
        fails.append(f"Case 1 exited non-zero: {proc.stderr}")
        print("  FAIL  Case 1: exited non-zero")
    elif outputs.get("method") != "oidc" or outputs.get("authorization") != "Bearer minted-oidc-token-123":
        fails.append(f"Case 1 invalid outputs: {outputs}")
        print("  FAIL  Case 1: unexpected outputs")
    elif "::add-mask::minted-oidc-token-123" not in proc.stdout:
        fails.append("Case 1: token was not masked")
        print("  FAIL  Case 1: token not masked")
    else:
        print("  ok    Case 1: successful OIDC token mint and mask")

    # Case 2: OIDC mint failure falls back to bearer
    proc, outputs = run_action_step(
        script,
        env_vars={
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://actions.github.com/token?foo=bar",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "mock-runner-token",
            "BEARER_TOKEN": "fallback-bearer-secret",
        },
        stub_curl_fail=True,
    )
    if proc.returncode != 0:
        fails.append(f"Case 2 exited non-zero: {proc.stderr}")
        print("  FAIL  Case 2: exited non-zero")
    elif outputs.get("method") != "bearer" or outputs.get("authorization") != "Bearer fallback-bearer-secret":
        fails.append(f"Case 2 invalid outputs: {outputs}")
        print("  FAIL  Case 2: unexpected outputs")
    elif "::warning::" not in proc.stdout:
        fails.append("Case 2: expected warning on mint failure")
        print("  FAIL  Case 2: missing warning")
    elif "::add-mask::fallback-bearer-secret" not in proc.stdout:
        fails.append("Case 2: bearer was not masked")
        print("  FAIL  Case 2: bearer not masked")
    else:
        print("  ok    Case 2: OIDC mint failure falls back to bearer with warning")

    # Case 3: ACTIONS_ID_TOKEN_REQUEST_URL unset uses bearer
    proc, outputs = run_action_step(
        script,
        env_vars={
            "BEARER_TOKEN": "my-bearer-secret",
        },
    )
    if proc.returncode != 0:
        fails.append(f"Case 3 exited non-zero: {proc.stderr}")
        print("  FAIL  Case 3: exited non-zero")
    elif outputs.get("method") != "bearer" or outputs.get("authorization") != "Bearer my-bearer-secret":
        fails.append(f"Case 3 invalid outputs: {outputs}")
        print("  FAIL  Case 3: unexpected outputs")
    else:
        print("  ok    Case 3: unset OIDC URL falls back to bearer")

    # Case 4: Neither OIDC nor bearer available
    proc, outputs = run_action_step(script)
    if proc.returncode != 0:
        fails.append(f"Case 4 exited non-zero: {proc.stderr}")
        print("  FAIL  Case 4: exited non-zero")
    elif outputs.get("method") != "none" or outputs.get("authorization") != "":
        fails.append(f"Case 4 invalid outputs: {outputs}")
        print("  FAIL  Case 4: unexpected outputs")
    else:
        print("  ok    Case 4: neither available outputs method=none")

    # Case 5: share override
    proc, outputs = run_action_step(script, env_vars={"SHARE_OVERRIDE": "off"})
    if outputs.get("share") != "off":
        fails.append(f"Case 5 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 5: share override 'off'")
    else:
        print("  ok    Case 5: share override 'off' respected")

    # Case 6: share resolved from local config file
    proc, outputs = run_action_step(
        script,
        local_config="telemetry:\n  share: off\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 6 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 6: local config share=off")
    else:
        print("  ok    Case 6: local config share=off respected")

    # Case 7: share defaults to full
    proc, outputs = run_action_step(script)
    if outputs.get("share") != "full":
        fails.append(f"Case 7 expected share=full, got {outputs.get('share')}")
        print("  FAIL  Case 7: default share=full")
    else:
        print("  ok    Case 7: share defaults to full")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all telemetry auth action tests passed")


if __name__ == "__main__":
    main()
