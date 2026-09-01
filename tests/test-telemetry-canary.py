#!/usr/bin/env python3
"""Behavioural tests for telemetry canary workflow (reachability and ingest canary).

Extracts the REAL shell bodies out of .github/workflows/telemetry-canary.yml and runs them
against stubbed curl, verifying:
1. Reachability: 401 response from worker makes the reachability job exit 0.
2. Reachability: 403 response on schedule event fails (exit non-zero) and prints captured headers and body.
3. Reachability: 403 response on pull_request event succeeds (exit 0) with ::warning:: while still printing headers.
4. Reachability: 200 response fails (exit non-zero on schedule) because unauthenticated success is a security regression.
5. Reachability: 500 response fails (exit non-zero on schedule).
6. Ingest: 204 response makes the ingest canary job exit 0 with proper payload shape.
7. Ingest: 500 response makes the ingest canary job fail (exit non-zero) and print response headers.
8. Ingest: 403 response makes the ingest canary job fail (exit non-zero).
9. Ingest: 200 response makes the ingest canary job fail (exit non-zero, expected 204).
10. Ingest: empty REVIEW_TELEMETRY_TOKEN makes the ingest job fail (exit non-zero) and name the secret.
11. Security: no secret token is ever echoed in stdout or stderr by either job.
12. Workflow structure: cron trigger, permissions, job conditions, and event gating.

Run: python3 tests/test-telemetry-canary.py
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
WF = ROOT / ".github/workflows/telemetry-canary.yml"


def extract_step_script(job_name: str, step_name: str) -> str:
    wf = yaml.safe_load(WF.read_text())
    job = wf["jobs"].get(job_name)
    if not job:
        sys.exit(f"job {job_name!r} not found in {WF}")
    for step in job.get("steps", []) or []:
        if step.get("name") == step_name:
            return step["run"]
    sys.exit(f"step {step_name!r} in job {job_name!r} not found in {WF}")


CURL_STUB = r"""#!/usr/bin/env bash
args=("$@")
headers_file=""
body_file=""
post_body=""

i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    -D)
      ((i++))
      headers_file="${args[$i]}"
      ;;
    -o)
      ((i++))
      body_file="${args[$i]}"
      ;;
    -d)
      ((i++))
      post_body="${args[$i]}"
      ;;
    --data-binary)
      ((i++))
      data_arg="${args[$i]}"
      if [ "$data_arg" = "@-" ]; then
        post_body="$(cat)"
      elif [[ "$data_arg" == @* ]]; then
        file_to_read="${data_arg#@}"
        if [ -f "$file_to_read" ]; then
          post_body="$(cat "$file_to_read")"
        fi
      else
        post_body="$data_arg"
      fi
      ;;
    -H)
      ((i++))
      hdr_arg="${args[$i]}"
      if [[ "$hdr_arg" == @* ]]; then
        hdr_file="${hdr_arg#@}"
        if [ -f "$hdr_file" ] && [ -n "${CAPTURE_AUTH_HEADER:-}" ]; then
          cat "$hdr_file" >> "$CAPTURE_AUTH_HEADER"
        fi
      elif [ -n "${CAPTURE_AUTH_HEADER:-}" ]; then
        echo "$hdr_arg" >> "$CAPTURE_AUTH_HEADER"
      fi
      ;;
  esac
  ((i++))
done

if [ -n "$CAPTURE_BODY" ] && [ -n "$post_body" ]; then
  printf '%s' "$post_body" > "$CAPTURE_BODY"
fi

if [ "${CURL_FAIL:-0}" = "1" ]; then
  echo "curl: (28) Operation timed out after 15000 milliseconds" >&2
  exit 28
fi

code="${CURL_HTTP_CODE:-401}"

# Write stub headers
if [ -n "$headers_file" ]; then
  if [ -n "${CUSTOM_HEADERS:-}" ]; then
    printf '%s\n' "$CUSTOM_HEADERS" > "$headers_file"
  else
    cat <<EOF_HDR > "$headers_file"
HTTP/2 $code
server: cloudflare
cf-ray: 8e1234567890-SJC
cf-mitigated: challenge
cf-cache-status: DYNAMIC
content-type: text/html
EOF_HDR
  fi
fi

# Write stub body
if [ -n "$body_file" ]; then
  if [ -n "${CUSTOM_BODY:-}" ]; then
    printf '%s' "$CUSTOM_BODY" > "$body_file"
  else
    printf '%s' "<html><head><title>Cloudflare Response</title></head><body>Response body for HTTP $code</body></html>" > "$body_file"
  fi
fi

# Write http_code to stdout if requested
for a in "${args[@]}"; do
  if [[ "$a" == *"%{http_code}"* ]]; then
    printf '%s' "$code"
    break
  fi
done

exit 0
"""


def run_reachability_step(script, *, event_name="schedule", curl_code="401",
                          custom_headers=None, custom_body=None, curl_fail=False,
                          env_overrides=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "curl").write_text(CURL_STUB)
        (binp / "curl").chmod(0o755)

        capture_body = tdp / "captured_body.txt"
        capture_auth = tdp / "captured_auth.txt"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_BODY=str(capture_body),
            CAPTURE_AUTH_HEADER=str(capture_auth),
            CURL_HTTP_CODE=str(curl_code),
            CURL_FAIL="1" if curl_fail else "0",
            EVENT_NAME=event_name,
            INGEST_URL="https://assayer.sfun.cloud/ingest",
        )
        if custom_headers is not None:
            env["CUSTOM_HEADERS"] = custom_headers
        if custom_body is not None:
            env["CUSTOM_BODY"] = custom_body
        if env_overrides:
            env.update(env_overrides)

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)

        captured_body_content = capture_body.read_text() if capture_body.exists() else ""
        captured_auth_content = capture_auth.read_text() if capture_auth.exists() else ""
        return p.returncode, p.stdout, p.stderr, captured_body_content, captured_auth_content


def run_ingest_step(script, *, token="test-secret-token-xyz-12345",
                    curl_code="204", custom_headers=None, custom_body=None,
                    curl_fail=False, run_url="https://github.com/prismalens/gh-workflows/actions/runs/987654",
                    env_overrides=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "curl").write_text(CURL_STUB)
        (binp / "curl").chmod(0o755)

        capture_body = tdp / "captured_body.txt"
        capture_auth = tdp / "captured_auth.txt"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_BODY=str(capture_body),
            CAPTURE_AUTH_HEADER=str(capture_auth),
            CURL_HTTP_CODE=str(curl_code),
            CURL_FAIL="1" if curl_fail else "0",
            REVIEW_TELEMETRY_TOKEN=token,
            RUN_URL=run_url,
            INGEST_URL="https://assayer.sfun.cloud/ingest",
        )
        if custom_headers is not None:
            env["CUSTOM_HEADERS"] = custom_headers
        if custom_body is not None:
            env["CUSTOM_BODY"] = custom_body
        if env_overrides:
            env.update(env_overrides)

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)

        captured_body_content = capture_body.read_text() if capture_body.exists() else ""
        captured_auth_content = capture_auth.read_text() if capture_auth.exists() else ""
        return p.returncode, p.stdout, p.stderr, captured_body_content, captured_auth_content


def main():
    fails = []
    print("=== Testing Telemetry Canary Workflow Behaviour ===\n")

    # 1. Structural workflow verification
    wf_text = WF.read_text()
    wf_data = yaml.safe_load(wf_text)

    # Triggers
    on_section = wf_data.get("on") or wf_data.get(True) or {}
    if "schedule" not in on_section or not isinstance(on_section["schedule"], list):
        fails.append("workflow missing on.schedule list")
    else:
        cron_expr = on_section["schedule"][0].get("cron")
        if cron_expr != "23 */6 * * *":
            fails.append(f"cron trigger want '23 */6 * * *', got {cron_expr!r}")
        else:
            print("  ok    workflow schedule trigger: cron '23 */6 * * *'")

    if "workflow_dispatch" not in on_section:
        fails.append("workflow missing on.workflow_dispatch")
    else:
        print("  ok    workflow dispatch trigger: present")

    if "pull_request" not in on_section:
        fails.append("workflow missing on.pull_request")
    elif (on_section["pull_request"] or {}).get("branches") != ["main"]:
        fails.append(
            f"workflow pull_request trigger must pin branches: ['main'], "
            f"got {(on_section['pull_request'] or {}).get('branches')!r}"
        )
    else:
        print("  ok    workflow pull_request trigger: present, pinned to branches: [main]")

    # Permissions
    perms = wf_data.get("permissions", {})
    if perms != {"contents": "read"}:
        fails.append(f"permissions want {{'contents': 'read'}}, got {perms!r}")
    else:
        print("  ok    workflow permissions: contents: read")

    # Job split: ingest must not run on pull_request
    ingest_job = wf_data.get("jobs", {}).get("ingest", {})
    ingest_if = ingest_job.get("if", "")
    if "github.event_name != 'pull_request'" not in ingest_if and "github.event_name != \'pull_request\'" not in ingest_if:
        fails.append(f"ingest job missing condition to skip on pull_request: got if={ingest_if!r}")
    else:
        print("  ok    workflow ingest job gated: if: github.event_name != 'pull_request'")

    # Both jobs independent (no needs dependency)
    if "needs" in ingest_job:
        fails.append(f"ingest job must be independent of reachability, found needs: {ingest_job['needs']}")
    reachability_job = wf_data.get("jobs", {}).get("reachability", {})
    if "needs" in reachability_job:
        fails.append(f"reachability job must be independent, found needs: {reachability_job['needs']}")
    print("  ok    workflow jobs are independent (no mutual needs dependency)")

    reachability_script = extract_step_script("reachability", "Verify edge reachability and worker routing")
    ingest_script = extract_step_script("ingest", "Post canary telemetry record")

    # -------------------------------------------------------------
    # 2. Reachability: 401 response exits 0 (happy path)
    # -------------------------------------------------------------
    code, stdout, stderr, body, auth = run_reachability_step(reachability_script, curl_code="401", event_name="schedule")
    if code != 0:
        fails.append(f"reachability 401 (schedule): expected exit 0, got {code}: {stderr}")
        print(f"  FAIL  reachability 401 (schedule): exited {code}")
    elif "::error::" in stdout or "::error::" in stderr or "::warning::" in stdout or "::warning::" in stderr:
        fails.append("reachability 401: emitted unexpected error/warning annotations")
        print("  FAIL  reachability 401: unexpected annotations")
    else:
        print("  ok    reachability: stub answering 401 makes reachability job exit 0")

    # -------------------------------------------------------------
    # 3. Reachability: 403 on schedule event exits non-zero AND prints headers
    # -------------------------------------------------------------
    custom_hdr = "HTTP/2 403\nserver: cloudflare\ncf-ray: 8e999test-ORD\ncf-mitigated: challenge\ncf-cache-status: DYNAMIC"
    code, stdout, stderr, body, auth = run_reachability_step(
        reachability_script,
        curl_code="403",
        event_name="schedule",
        custom_headers=custom_hdr,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("reachability 403 (schedule): expected non-zero exit, got 0")
        print("  FAIL  reachability 403 (schedule): exit 0")
    elif "cf-ray: 8e999test-ORD" not in combined or "cf-mitigated: challenge" not in combined:
        fails.append("reachability 403 (schedule): did not print captured response headers")
        print("  FAIL  reachability 403 (schedule): missing headers in output")
    elif "::error::" not in combined:
        fails.append("reachability 403 (schedule): did not emit ::error:: annotation")
        print("  FAIL  reachability 403 (schedule): missing ::error:: annotation")
    elif "Cloudflare bot/WAF mitigation" not in combined or "Cloudflare Access policy" not in combined:
        fails.append("reachability 403 (schedule): error line does not name both likeliest causes")
        print("  FAIL  reachability 403 (schedule): error message missing cause details")
    else:
        print("  ok    reachability: stub answering 403 on schedule exits non-zero, prints captured headers & error")

    # -------------------------------------------------------------
    # 4. Reachability: 403 on pull_request event exits 0 with ::warning::
    # -------------------------------------------------------------
    code, stdout, stderr, body, auth = run_reachability_step(
        reachability_script,
        curl_code="403",
        event_name="pull_request",
        custom_headers=custom_hdr,
    )
    combined = stdout + "\n" + stderr
    if code != 0:
        fails.append(f"reachability 403 (pull_request): expected exit 0, got {code}: {stderr}")
        print(f"  FAIL  reachability 403 (pull_request): exited {code}")
    elif "cf-ray: 8e999test-ORD" not in combined:
        fails.append("reachability 403 (pull_request): did not print captured response headers")
        print("  FAIL  reachability 403 (pull_request): missing headers in output")
    elif "::warning::" not in combined:
        fails.append("reachability 403 (pull_request): did not emit ::warning:: annotation")
        print("  FAIL  reachability 403 (pull_request): missing ::warning:: annotation")
    elif "::error::" in combined:
        fails.append("reachability 403 (pull_request): unexpectedly emitted ::error:: annotation on PR event")
        print("  FAIL  reachability 403 (pull_request): emitted ::error:: on PR")
    else:
        print("  ok    reachability: stub answering 403 on pull_request exits 0, prints headers & warning")

    # -------------------------------------------------------------
    # 5. Reachability: 200 response fails (security regression check)
    # -------------------------------------------------------------
    code, stdout, stderr, body, auth = run_reachability_step(reachability_script, curl_code="200", event_name="schedule")
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("reachability 200 (schedule): expected non-zero exit, got 0")
        print("  FAIL  reachability 200 (schedule): exit 0")
    elif "::error::" not in combined:
        fails.append("reachability 200 (schedule): missing ::error:: annotation")
        print("  FAIL  reachability 200 (schedule): missing ::error::")
    else:
        print("  ok    reachability: stub answering 200 fails (unauthenticated POST success is security regression)")

    # -------------------------------------------------------------
    # 6. Reachability: 500 response fails on schedule event
    # -------------------------------------------------------------
    code, stdout, stderr, body, auth = run_reachability_step(reachability_script, curl_code="500", event_name="schedule")
    if code == 0:
        fails.append("reachability 500 (schedule): expected non-zero exit, got 0")
        print("  FAIL  reachability 500 (schedule): exit 0")
    else:
        print("  ok    reachability: stub answering 500 exits non-zero on schedule")

    # -------------------------------------------------------------
    # 7. Ingest: 204 response exits 0 and posts correct payload
    # -------------------------------------------------------------
    secret_token = "SECRET_TELEMETRY_BEARER_TOKEN_ABC123"
    test_run_url = "https://github.com/prismalens/gh-workflows/actions/runs/12345678"
    code, stdout, stderr, raw_payload, auth_captured = run_ingest_step(
        ingest_script,
        token=secret_token,
        curl_code="204",
        run_url=test_run_url,
    )
    if code != 0:
        fails.append(f"ingest 204: expected exit 0, got {code}: {stderr}")
        print(f"  FAIL  ingest 204: exited {code}")
    else:
        try:
            payload = json.loads(raw_payload)
            if payload.get("event_kind") != "canary":
                fails.append(f"ingest payload: event_kind want 'canary', got {payload.get('event_kind')!r}")
            if payload.get("lane_version") != "2":
                fails.append(f"ingest payload: lane_version want '2', got {payload.get('lane_version')!r}")
            if payload.get("run_url") != test_run_url:
                fails.append(f"ingest payload: run_url want {test_run_url!r}, got {payload.get('run_url')!r}")
            rec_at = payload.get("recorded_at", "")
            if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", rec_at):
                fails.append(f"ingest payload: recorded_at want ISO 8601 UTC with Z, got {rec_at!r}")
            if f"Bearer {secret_token}" not in auth_captured:
                fails.append("ingest: authorization header was not delivered to curl")
            print("  ok    ingest: stub answering 204 makes ingest job exit 0 with valid canary payload")
        except Exception as e:
            fails.append(f"ingest payload parsing failed: {e} (raw={raw_payload!r})")
            print(f"  FAIL  ingest 204: invalid payload JSON: {e}")

    # -------------------------------------------------------------
    # 8. Ingest: 500 response exits non-zero and prints headers & body
    # -------------------------------------------------------------
    custom_hdr_500 = "HTTP/2 500\nserver: cloudflare\ncf-ray: 500-ray-xyz\ncontent-type: text/plain"
    custom_body_500 = "Internal Server Error from Worker D1 execution"
    code, stdout, stderr, raw_payload, auth = run_ingest_step(
        ingest_script,
        token=secret_token,
        curl_code="500",
        custom_headers=custom_hdr_500,
        custom_body=custom_body_500,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("ingest 500: expected non-zero exit, got 0")
        print("  FAIL  ingest 500: exit 0")
    elif "cf-ray: 500-ray-xyz" not in combined:
        fails.append("ingest 500: did not print captured response headers")
        print("  FAIL  ingest 500: missing headers")
    elif custom_body_500 not in combined:
        fails.append("ingest 500: did not print captured response body")
        print("  FAIL  ingest 500: missing body")
    elif "::error::" not in combined:
        fails.append("ingest 500: missing ::error:: annotation")
        print("  FAIL  ingest 500: missing ::error::")
    else:
        print("  ok    ingest: stub answering 500 exits non-zero and prints response detail")

    # -------------------------------------------------------------
    # 9. Ingest: 403 response exits non-zero
    # -------------------------------------------------------------
    code, stdout, stderr, raw_payload, auth = run_ingest_step(ingest_script, token=secret_token, curl_code="403")
    if code == 0:
        fails.append("ingest 403: expected non-zero exit, got 0")
        print("  FAIL  ingest 403: exit 0")
    else:
        print("  ok    ingest: stub answering 403 exits non-zero")

    # -------------------------------------------------------------
    # 9b. Ingest: the diagnosis is status-specific, not "probably WAF" every time.
    # A flat edge-block message sent a session hunting Cloudflare for a 400 that
    # meant the deployed Worker was behind main. Story: #87.
    # -------------------------------------------------------------
    distinct = {}
    for status, must_contain in (("400", "behind main"), ("401", "token"), ("403", "Cloudflare")):
        _, stdout, stderr, _, _ = run_ingest_step(ingest_script, token=secret_token, curl_code=status)
        combined = stdout + "\n" + stderr
        error_line = next((l for l in combined.splitlines() if "::error::" in l), "")
        distinct[status] = error_line
        if must_contain not in error_line:
            fails.append(f"ingest {status}: error line does not name its cause ({must_contain!r})")
            print(f"  FAIL  ingest {status}: cause not named")
            break
    else:
        if len(set(distinct.values())) != 3:
            fails.append("ingest: 400, 401 and 403 do not produce distinct diagnoses")
            print("  FAIL  ingest: diagnoses not distinct")
        else:
            print("  ok    ingest: 400, 401 and 403 each name their own distinct cause")

    # -------------------------------------------------------------
    # 10. Ingest: empty REVIEW_TELEMETRY_TOKEN fails loudly and names secret
    # -------------------------------------------------------------
    code, stdout, stderr, raw_payload, auth = run_ingest_step(ingest_script, token="")
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("ingest empty token: expected non-zero exit, got 0")
        print("  FAIL  ingest empty token: exit 0")
    elif "REVIEW_TELEMETRY_TOKEN" not in combined:
        fails.append("ingest empty token: error output does not name REVIEW_TELEMETRY_TOKEN")
        print("  FAIL  ingest empty token: does not name secret")
    elif "::error::" not in combined:
        fails.append("ingest empty token: missing ::error:: annotation")
        print("  FAIL  ingest empty token: missing ::error::")
    elif raw_payload:
        fails.append("ingest empty token: unexpectedly attempted to POST")
        print("  FAIL  ingest empty token: curl was invoked")
    else:
        print("  ok    ingest: empty REVIEW_TELEMETRY_TOKEN exits non-zero and names secret in error")

    # -------------------------------------------------------------
    # 11. Security: no secret token value is ever echoed by either script
    # -------------------------------------------------------------
    canary_secret = "TOP_SECRET_CANARY_VALUE_NEVER_ECHO"
    # Reachability run
    _, r_out, r_err, _, _ = run_reachability_step(reachability_script, curl_code="401")
    # Ingest success run
    _, i_out_204, i_err_204, _, _ = run_ingest_step(ingest_script, token=canary_secret, curl_code="204")
    # Ingest error run
    _, i_out_500, i_err_500, _, _ = run_ingest_step(ingest_script, token=canary_secret, curl_code="500")

    all_outputs = [r_out, r_err, i_out_204, i_err_204, i_out_500, i_err_500]
    leaked = any(canary_secret in out for out in all_outputs)
    if leaked:
        fails.append("security: secret token value was echoed in script stdout or stderr!")
        print("  FAIL  security: token value was echoed in output")
    else:
        print("  ok    security: no secret token value is ever echoed in stdout/stderr")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)

    print("all telemetry canary tests passed")


if __name__ == "__main__":
    main()
