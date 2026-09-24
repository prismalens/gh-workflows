#!/usr/bin/env python3
"""Behavioural tests for .github/actions/telemetry-auth/action.yml (#176).

Extracts the real shell body from action.yml and runs it in a subprocess with
stubs for curl and gh, verifying:
  1. OIDC token minting with audience and mask
  2. Fallback to bearer on OIDC mint failure
  3. Fallback to bearer when ACTIONS_ID_TOKEN_REQUEST_URL is unset
  4. Output method=none when neither is available
  5. An empty url mints nothing and resolves method=none
  6. Resolution of telemetry.share: override, repository file over org
     defaults, org defaults with no repository file, a local working-tree
     file ignored, and default full

Run: python3 tests/test-telemetry-auth-action.py
"""
import base64
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTION_FILE = ROOT / ".github" / "actions" / "telemetry-auth" / "action.yml"
TEST_URL = "https://telemetry.example.test/ingest"


def extract_script():
    action = yaml.safe_load(ACTION_FILE.read_text())
    for step in action.get("runs", {}).get("steps", []):
        if step.get("id") == "auth":
            return step["run"]
    sys.exit(f"step 'auth' not found in {ACTION_FILE}")


def wrap_base64(data, width=60):
    """Wrap a base64 string with a newline every `width` characters plus a
    trailing newline, matching the shape of the GitHub contents API's
    `.content` field (#177 follow-up: the wrap was mistaken for garbage)."""
    lines = [data[i : i + width] for i in range(0, len(data), width)]
    return "\n".join(lines) + "\n"


def run_action_step(
    script,
    *,
    env_vars=None,
    local_config=None,
    repo_config=None,
    org_config=None,
    stub_curl_resp=None,
    stub_curl_fail=False,
    repo_fetch_fail=False,
    repo_bad_base64=None,
    wrap_repo_base64=False,
):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()

        # A local working-tree config file. F2: the action must never read this;
        # it is only here to prove that (#176).
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

        # Stub gh: answers repository-contents lookups for the repository's own
        # claude-review.yml (default branch, no ref) and for the org defaults
        # file at prismalens/gh-workflows@main. Anything else 404s.
        repo_b64 = base64.b64encode(repo_config.encode()).decode() if repo_config is not None else ""
        if wrap_repo_base64 and repo_b64:
            repo_b64 = wrap_base64(repo_b64)
        org_b64 = base64.b64encode(org_config.encode()).decode() if org_config is not None else ""
        gh_script = f"""#!/usr/bin/env bash
path="$2"
case "$path" in
  repos/*/contents/.github/claude-review.yml)
    if [ "{1 if repo_fetch_fail else 0}" = "1" ]; then
      echo "HTTP 500: Internal Server Error" >&2
      exit 1
    fi
    if [ -n "{repo_bad_base64 or ''}" ]; then
      echo "{repo_bad_base64 or ''}"
      exit 0
    fi
    if [ -n "{repo_b64}" ]; then
      echo "{repo_b64}"
      exit 0
    fi
    echo "404: Not Found" >&2
    exit 1
    ;;
  repos/prismalens/gh-workflows/contents/.github/claude-review-defaults.yml?ref=main)
    if [ -n "{org_b64}" ]; then
      echo "{org_b64}"
      exit 0
    fi
    echo "404: Not Found" >&2
    exit 1
    ;;
  *)
    echo "404: Not Found" >&2
    exit 1
    ;;
esac
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
            TARGET_URL=TEST_URL,
            BEARER_TOKEN="",
            SHARE_OVERRIDE="",
            GITHUB_REPOSITORY="acme/widgets",
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

    # Case 5: an empty url mints nothing and gives method=none
    proc, outputs = run_action_step(
        script,
        env_vars={
            "TARGET_URL": "",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://actions.github.com/token?foo=bar",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "mock-runner-token",
            "BEARER_TOKEN": "fallback-bearer",
        },
        stub_curl_resp='{"value": "minted-oidc-token-123"}',
    )
    if proc.returncode != 0:
        fails.append(f"Case 5 exited non-zero: {proc.stderr}")
        print("  FAIL  Case 5: exited non-zero")
    elif outputs.get("method") != "none" or outputs.get("authorization") != "":
        fails.append(f"Case 5 invalid outputs: {outputs}")
        print("  FAIL  Case 5: unexpected outputs")
    else:
        print("  ok    Case 5: empty url mints nothing, method=none")

    # Case 6: share override
    proc, outputs = run_action_step(script, env_vars={"SHARE_OVERRIDE": "off"})
    if outputs.get("share") != "off":
        fails.append(f"Case 6 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 6: share override 'off'")
    else:
        print("  ok    Case 6: share override 'off' respected")

    # Case 7: a local .github/claude-review.yml is never read (#33); with no
    # repository or org file reachable, share still resolves to the default.
    proc, outputs = run_action_step(
        script,
        local_config="telemetry:\n  share: 'off'\n",
    )
    if outputs.get("share") != "full":
        fails.append(f"Case 7 expected share=full (local file ignored), got {outputs.get('share')}")
        print("  FAIL  Case 7: local config is ignored")
    else:
        print("  ok    Case 7: local .github/claude-review.yml is ignored")

    # Case 8: the repository file's share wins over an org default of 'full'
    proc, outputs = run_action_step(
        script,
        repo_config="telemetry:\n  share: 'off'\n",
        org_config="telemetry:\n  share: full\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 8 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 8: repository share overrides org default")
    else:
        print("  ok    Case 8: repository share overrides org default")

    # Case 9: org default of 'off' applies with no repository file
    proc, outputs = run_action_step(
        script,
        org_config="telemetry:\n  share: 'off'\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 9 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 9: org default applies with no repository file")
    else:
        print("  ok    Case 9: org default applies with no repository file")

    # Case 10: share defaults to full when nothing is configured anywhere
    proc, outputs = run_action_step(script)
    if outputs.get("share") != "full":
        fails.append(f"Case 10 expected share=full, got {outputs.get('share')}")
        print("  FAIL  Case 10: default share=full")
    else:
        print("  ok    Case 10: default share=full")

    # Case 12: unquoted 'off' is the YAML boolean False, and still resolves off (#176)
    proc, outputs = run_action_step(
        script,
        repo_config="telemetry:\n  share: off\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 12 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 12: unquoted 'off' resolves off")
    else:
        print("  ok    Case 12: unquoted 'off' resolves off")

    # Case 13: an explicit 'false' also resolves off (#176)
    proc, outputs = run_action_step(
        script,
        repo_config="telemetry:\n  share: false\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 13 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 13: 'false' resolves off")
    else:
        print("  ok    Case 13: 'false' resolves off")

    # Case 14: an explicit 'true' resolves full (#176)
    proc, outputs = run_action_step(
        script,
        repo_config="telemetry:\n  share: true\n",
    )
    if outputs.get("share") != "full":
        fails.append(f"Case 14 expected share=full, got {outputs.get('share')}")
        print("  FAIL  Case 14: 'true' resolves full")
    else:
        print("  ok    Case 14: 'true' resolves full")

    # Case 15: an invalid value fails closed to off, with a warning naming it (#176)
    proc, outputs = run_action_step(
        script,
        repo_config="telemetry:\n  share: maybe\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 15 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 15: invalid value resolves off")
    elif "::warning::telemetry.share has invalid value" not in proc.stdout and "::warning::telemetry.share has invalid value" not in proc.stderr:
        fails.append(f"Case 15: expected an invalid-value warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 15: missing invalid-value warning")
    else:
        print("  ok    Case 15: invalid value resolves off with a warning")

    # Case 16: no telemetry key in the repository file falls through to an org
    # default of off (#176)
    proc, outputs = run_action_step(
        script,
        repo_config="review:\n  level: medium\n",
        org_config="telemetry:\n  share: off\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 16 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 16: repo file with no telemetry key falls through to org off")
    else:
        print("  ok    Case 16: repo file with no telemetry key falls through to org off")

    # Case 17: a 500 on the repository fetch resolves off, with a warning (#177,
    # thread 4006669598)
    proc, outputs = run_action_step(
        script,
        repo_fetch_fail=True,
        org_config="telemetry:\n  share: full\n",
    )
    if outputs.get("share") != "off":
        fails.append(f"Case 17 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 17: repo fetch failure resolves off")
    elif "::warning::failed to fetch" not in proc.stdout and "::warning::failed to fetch" not in proc.stderr:
        fails.append(f"Case 17: expected a fetch-failure warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 17: missing fetch-failure warning")
    else:
        print("  ok    Case 17: a 500 on the repository fetch resolves off with a warning")

    # Case 18: bad base64 in the repository file resolves off (#177, thread 4006669598).
    # `!!!!` not `abc`: `abc` is refused on PADDING, which permissive and validating
    # b64decode both reject, so it never exercised the alphabet. `!!!!` is correctly
    # padded and entirely outside the alphabet, so a permissive decode DISCARDS it and
    # returns b'' — which reads as an empty config, then as an unset key, and falls
    # through every layer to the `full` default. A corrupt config would have silently
    # resolved to maximum sharing, with no warning. Requires validate=True.
    proc, outputs = run_action_step(script, repo_bad_base64="!!!!")
    if outputs.get("share") != "off":
        fails.append(f"Case 18 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 18: bad base64 resolves off")
    elif "::warning::failed to decode" not in proc.stdout and "::warning::failed to decode" not in proc.stderr:
        fails.append(f"Case 18: expected a decode-failure warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 18: missing decode-failure warning")
    else:
        print("  ok    Case 18: bad base64 resolves off with a warning")

    # Case 19: malformed YAML resolves off (#177, thread 4006669598)
    proc, outputs = run_action_step(script, repo_config="telemetry: [unterminated\n")
    if outputs.get("share") != "off":
        fails.append(f"Case 19 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 19: malformed YAML resolves off")
    elif "::warning::malformed YAML" not in proc.stdout and "::warning::malformed YAML" not in proc.stderr:
        fails.append(f"Case 19: expected a malformed-YAML warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 19: missing malformed-YAML warning")
    else:
        print("  ok    Case 19: malformed YAML resolves off with a warning")

    # Case 19b: a PRESENT config whose root is not a mapping resolves off (#177,
    # thread 4006669598 follow-up). Three root shapes, all of which parse cleanly and
    # none of which is a mapping, so none can carry a consent key. Falling through sent
    # each of them to the `full` default — a broken consent file resolving to maximum
    # sharing, the same failure as the permissive base64 decode. An ABSENT file is a
    # different case and still falls through; fetch_layer answers a 404 that way.
    for label, root in (("null root", "null\n"), ("scalar root", "just-a-string\n"), ("list root", "- a\n- b\n")):
        proc, outputs = run_action_step(script, repo_config=root)
        if outputs.get("share") != "off":
            fails.append(f"Case 19b ({label}) expected share=off, got {outputs.get('share')}")
            print(f"  FAIL  Case 19b: {label} did not resolve off")
        elif "::warning::config root is" not in proc.stdout and "::warning::config root is" not in proc.stderr:
            fails.append(f"Case 19b ({label}): expected a non-mapping-root warning, stderr={proc.stderr!r}")
            print(f"  FAIL  Case 19b: {label} missing warning")
        else:
            print(f"  ok    Case 19b: {label} resolves off with a warning")

    # Case 20: telemetry present but not a mapping resolves off (#177, thread 4006669598)
    proc, outputs = run_action_step(script, repo_config='telemetry: "off"\n')
    if outputs.get("share") != "off":
        fails.append(f"Case 20 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 20: non-mapping telemetry resolves off")
    elif "::warning::telemetry is not a mapping" not in proc.stdout and "::warning::telemetry is not a mapping" not in proc.stderr:
        fails.append(f"Case 20: expected a non-mapping warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 20: missing non-mapping warning")
    else:
        print("  ok    Case 20: telemetry present but not a mapping resolves off with a warning")

    # Case 21: a 404 on the repository file plus an org default of full resolves
    # full (#177, thread 4006669598)
    proc, outputs = run_action_step(script, org_config="telemetry:\n  share: full\n")
    if outputs.get("share") != "full":
        fails.append(f"Case 21 expected share=full, got {outputs.get('share')}")
        print("  FAIL  Case 21: 404 repo plus org full resolves full")
    else:
        print("  ok    Case 21: a 404 on the repository file plus an org default of full resolves full")

    # Case 22: an invalid share override on the action resolves off, with a
    # warning (#177, thread 4006669598)
    proc, outputs = run_action_step(script, env_vars={"SHARE_OVERRIDE": "maybe"})
    if outputs.get("share") != "off":
        fails.append(f"Case 22 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 22: invalid override resolves off")
    elif "::warning::telemetry.share override" not in proc.stdout and "::warning::telemetry.share override" not in proc.stderr:
        fails.append(f"Case 22: expected an invalid-override warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 22: missing invalid-override warning")
    else:
        print("  ok    Case 22: an invalid share override resolves off with a warning")

    # Case 23: repository content whose base64 decodes to invalid UTF-8 resolves
    # off with the invalid-UTF-8 warning (#177, thread 4006669598)
    invalid_utf8_b64 = base64.b64encode(b"\xff\xfetelemetry:\n  share: full\n").decode("ascii")
    proc, outputs = run_action_step(script, repo_bad_base64=invalid_utf8_b64)
    if outputs.get("share") != "off":
        fails.append(f"Case 23 expected share=off, got {outputs.get('share')}")
        print("  FAIL  Case 23: invalid UTF-8 resolves off")
    elif "::warning::config content is not valid UTF-8; resolving telemetry.share as off (#177)" not in proc.stdout and "::warning::config content is not valid UTF-8; resolving telemetry.share as off (#177)" not in proc.stderr:
        fails.append(f"Case 23: expected an invalid-UTF-8 warning, stdout={proc.stdout!r} stderr={proc.stderr!r}")
        print("  FAIL  Case 23: missing invalid-UTF-8 warning")
    else:
        print("  ok    Case 23: invalid UTF-8 decodes strictly and resolves off with a warning")

    # Case 24: the contents API wraps .content with a newline every 60
    # characters plus a trailing newline; that wrap must not be mistaken for
    # the non-alphabet garbage validate=True exists to catch (#177 follow-up,
    # live evidence: prismalens/sreforge run 35942791242).
    proc, outputs = run_action_step(
        script,
        # Padded so the base64 form is long enough to actually wrap at 60
        # characters (a short config's base64 fits on one line and would
        # not exercise the wrap at all).
        repo_config=(
            "# padding so the base64 form wraps across multiple lines like the real contents API\n"
            "telemetry:\n  share: full\n"
        ),
        wrap_repo_base64=True,
    )
    if outputs.get("share") != "full":
        fails.append(f"Case 24 expected share=full, got {outputs.get('share')}")
        print("  FAIL  Case 24: wrapped base64 (as the contents API returns it) resolves full")
    else:
        print("  ok    Case 24: wrapped base64 (as the contents API returns it) resolves full")

    # Case 11: the action's url input is required, with no invented default host
    action = yaml.safe_load(ACTION_FILE.read_text())
    url_input = action.get("inputs", {}).get("url", {})
    if not url_input.get("required") or "default" in url_input:
        fails.append(f"Case 11: url input must be required with no default, got {url_input}")
        print("  FAIL  Case 11: url input is not a bare required input")
    else:
        print("  ok    Case 11: url input is required with no default")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all telemetry auth action tests passed")


if __name__ == "__main__":
    main()
