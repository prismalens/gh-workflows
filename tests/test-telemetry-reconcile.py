#!/usr/bin/env python3
"""Behavioural tests for telemetry reconciler workflow (.github/workflows/telemetry-reconcile.yml).

Extracts the REAL shell body out of .github/workflows/telemetry-reconcile.yml and runs it
against stubbed curl and gh, verifying:
1. Workflow structure:
   - Reusable workflow (.github/workflows/telemetry-reconcile.yml): workflow_call inputs, secrets, permissions.
   - Caller stub (.github/workflows/telemetry-reconcile-caller.yml): cron schedule, workflow_dispatch, permissions.
2. Clean window: empty finding set when all runs match accounted set (exit 0).
3. One unaccounted run: non-zero exit with repo, run ID, conclusion, created_at, URL named.
4. Filtered run: cancelled run with zero jobs is filtered, named in summary, and exits 0.
5. Cancelled run with executed jobs (>0 jobs) is NOT filtered and fails the job.
6. Read API unreachable (timeout, network failure, HTTP 500) fails loudly without false clean.
7. Read API rejected (HTTP 401, 403) fails loudly with distinct diagnosis.
8. Missing REVIEW_TELEMETRY_TOKEN fails loudly and names the secret.
9. Slurped pagination and page-two fixture: runs on page two are detected and accounted for.
10. GitHub API failure on workflow runs read fails loudly with error annotation.
11. Missing repository fails loudly.
12. Security: secret token value is never echoed in stdout or stderr.

Run: python3 tests/test-telemetry-reconcile.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/telemetry-reconcile.yml"
CALLER_WF = ROOT / ".github/workflows/telemetry-reconcile-caller.yml"


def extract_step_script(job_name: str, step_name: str) -> str:
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
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

if [ "${CURL_FAIL:-0}" = "1" ]; then
  echo "curl: (28) Operation timed out after 15000 milliseconds" >&2
  exit 28
fi

code="${CURL_HTTP_CODE:-200}"

if [ -n "$headers_file" ]; then
  if [ -n "${CUSTOM_HEADERS:-}" ]; then
    printf '%s\n' "$CUSTOM_HEADERS" > "$headers_file"
  else
    cat <<EOF_HDR > "$headers_file"
HTTP/2 $code
server: cloudflare
cf-ray: 8e1234567890-SJC
content-type: application/json
EOF_HDR
  fi
fi

if [ -n "$body_file" ]; then
  if [ -n "${CUSTOM_BODY:-}" ]; then
    printf '%s' "$CUSTOM_BODY" > "$body_file"
  elif [ -n "${MOCK_ACCOUNTED_JSON:-}" ]; then
    printf '%s' "$MOCK_ACCOUNTED_JSON" > "$body_file"
  else
    printf '%s' '{"since":"2026-09-05T02:00:00Z","until":"2026-09-06T04:00:00Z","run_ids":[]}' > "$body_file"
  fi
fi

for a in "${args[@]}"; do
  if [[ "$a" == *"%{http_code}"* ]]; then
    printf '%s' "$code"
    break
  fi
done

exit 0
"""

GH_STUB = r"""#!/usr/bin/env bash
args=("$@")
endpoint=""
for a in "${args[@]}"; do
  if [[ "$a" == repos/* ]]; then
    endpoint="$a"
    break
  fi
done

mock_file="${MOCK_GH_CONFIG:-}"
if [ -z "$endpoint" ]; then
  echo "gh stub: no endpoint found in args: $*" >&2
  exit 1
fi

# 1. Workflow runs listing: repos/<owner>/<repo>/actions/workflows/claude-code-review.yml/runs...
if [[ "$endpoint" == *"actions/workflows/claude-code-review.yml/runs"* ]]; then
  repo=$(echo "$endpoint" | sed -E 's|^repos/([^/]+/[^/]+)/actions/.*|\1|')
  if [ -n "$mock_file" ] && [ -f "$mock_file" ]; then
    status=$(jq -r --arg r "$repo" '.repos[$r].status // "ok"' "$mock_file")
    if [ "$status" = "permission_denied" ] || [ "$status" = "not_found" ] || [ "$status" = "api_error" ]; then
      echo "gh: Not Found (HTTP 404)" >&2
      exit 1
    fi
    pages=$(jq -c --arg r "$repo" '.repos[$r].pages // null' "$mock_file")
    if [ "$pages" != "null" ]; then
      echo "$pages"
      exit 0
    fi
    runs=$(jq -c --arg r "$repo" '.repos[$r].runs // []' "$mock_file")
    echo "[{\"total_count\": $(echo "$runs" | jq 'length'), \"workflow_runs\": $runs}]"
    exit 0
  fi
  echo '[{"total_count": 0, "workflow_runs": []}]'
  exit 0
fi

# 2. Jobs listing for a run: repos/<owner>/<repo>/actions/runs/<run_id>/jobs
if [[ "$endpoint" == *"actions/runs/"*"/jobs"* ]]; then
  run_id=$(echo "$endpoint" | sed -E 's|.*actions/runs/([0-9]+)/jobs.*|\1|')
  if [ -n "$mock_file" ] && [ -f "$mock_file" ]; then
    job_spec=$(jq -c --arg id "$run_id" '.jobs[$id] // null' "$mock_file")
    if [ "$job_spec" != "null" ]; then
      echo "$job_spec"
      exit 0
    fi
  fi
  echo '{"total_count": 0, "jobs": []}'
  exit 0
fi

echo "gh stub: unhandled call: $*" >&2
exit 1
"""


def run_reconciler_step(script, *, token="valid-test-telemetry-token-123",
                        curl_code="200", curl_fail=False,
                        accounted_json=None, custom_headers=None, custom_body=None,
                        gh_mocks=None, since="2026-09-05T02:00:00Z", until="2026-09-06T04:00:00Z",
                        window_hours="26", repository="prismalens/gh-workflows", env_overrides=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()

        (binp / "curl").write_text(CURL_STUB)
        (binp / "curl").chmod(0o755)

        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)

        capture_auth = tdp / "captured_auth.txt"
        summary_file = tdp / "step_summary.md"
        mock_gh_file = tdp / "mock_gh.json"

        if gh_mocks is not None:
            mock_gh_file.write_text(json.dumps(gh_mocks))

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_AUTH_HEADER=str(capture_auth),
            GITHUB_STEP_SUMMARY=str(summary_file),
            MOCK_GH_CONFIG=str(mock_gh_file) if gh_mocks is not None else "",
            CURL_HTTP_CODE=str(curl_code),
            CURL_FAIL="1" if curl_fail else "0",
            REVIEW_TELEMETRY_TOKEN=token,
            ACCOUNTED_RUNS_URL="https://assayer.sfun.cloud/api/accounted-runs",
            WINDOW_HOURS=str(window_hours),
            SINCE=since,
            UNTIL=until,
            REPOSITORY=repository,
            GITHUB_REPOSITORY=repository,
        )
        if accounted_json is not None:
            env["MOCK_ACCOUNTED_JSON"] = json.dumps(accounted_json)
        if custom_headers is not None:
            env["CUSTOM_HEADERS"] = custom_headers
        if custom_body is not None:
            env["CUSTOM_BODY"] = custom_body
        if env_overrides:
            env.update(env_overrides)

        proc = subprocess.run(["bash", "-c", script], env=env,
                              capture_output=True, text=True)

        summary_text = summary_file.read_text() if summary_file.exists() else ""
        captured_auth = capture_auth.read_text() if capture_auth.exists() else ""
        return proc.returncode, proc.stdout, proc.stderr, summary_text, captured_auth


def main():
    fails = []
    print("=== Testing Telemetry Reconciler Workflow Behaviour ===\n")

    # 1. Structural workflow verification
    if not WF.exists():
        sys.exit(f"workflow file not found at {WF}")

    wf_data = yaml.safe_load(WF.read_text(encoding="utf-8"))

    # Reusable workflow triggers: workflow_call
    on_section = wf_data.get("on") or wf_data.get(True) or {}
    if "workflow_call" not in on_section:
        fails.append("reusable workflow missing on.workflow_call")
    else:
        call_inputs = (on_section.get("workflow_call") or {}).get("inputs", {})
        window_in = call_inputs.get("window_hours", {})
        if str(window_in.get("default", "")) != "26":
            fails.append(f"workflow_call.inputs.window_hours default want '26', got {window_in.get('default')!r}")
        else:
            print("  ok    reusable workflow trigger: workflow_call with window_hours default 26")

        call_secrets = (on_section.get("workflow_call") or {}).get("secrets", {})
        if not call_secrets.get("REVIEW_TELEMETRY_TOKEN", {}).get("required"):
            fails.append("workflow_call.secrets.REVIEW_TELEMETRY_TOKEN missing or not required")
        else:
            print("  ok    reusable workflow secrets: REVIEW_TELEMETRY_TOKEN required")

    # Permissions on reusable workflow
    perms = wf_data.get("permissions", {})
    if perms.get("actions") != "read" or perms.get("contents") != "read":
        fails.append(f"permissions want actions: read, contents: read, got {perms!r}")
    else:
        print("  ok    reusable workflow permissions: actions: read, contents: read")

    # Caller stub verification
    if not CALLER_WF.exists():
        fails.append(f"caller workflow file not found at {CALLER_WF}")
    else:
        caller_data = yaml.safe_load(CALLER_WF.read_text(encoding="utf-8"))
        caller_on = caller_data.get("on") or caller_data.get(True) or {}
        if "schedule" not in caller_on or not isinstance(caller_on["schedule"], list):
            fails.append("caller workflow missing on.schedule list")
        else:
            cron_expr = caller_on["schedule"][0].get("cron")
            if cron_expr != "23 4 * * *":
                fails.append(f"caller workflow schedule cron want '23 4 * * *', got {cron_expr!r}")
            else:
                print(f"  ok    caller workflow schedule trigger: cron '{cron_expr}'")

        if "workflow_dispatch" not in caller_on:
            fails.append("caller workflow missing on.workflow_dispatch")
        else:
            caller_inputs = (caller_on.get("workflow_dispatch") or {}).get("inputs", {})
            window_in = caller_inputs.get("window_hours", {})
            if str(window_in.get("default", "")) != "26":
                fails.append(f"caller workflow_dispatch.inputs.window_hours default want '26', got {window_in.get('default')!r}")
            else:
                print("  ok    caller workflow dispatch trigger: present with window_hours default '26'")

        caller_perms = caller_data.get("permissions", {})
        if caller_perms.get("actions") != "read" or caller_perms.get("contents") != "read":
            fails.append(f"caller permissions want actions: read, contents: read, got {caller_perms!r}")
        else:
            print("  ok    caller workflow permissions: actions: read, contents: read")

        caller_job = caller_data.get("jobs", {}).get("reconcile", {})
        if caller_job.get("uses") != "./.github/workflows/telemetry-reconcile.yml":
            fails.append(f"caller job uses want './.github/workflows/telemetry-reconcile.yml', got {caller_job.get('uses')!r}")
        else:
            print("  ok    caller job invokes reusable workflow: uses ./.github/workflows/telemetry-reconcile.yml")

    script = extract_step_script("reconcile", "Reconcile review telemetry")

    # Common mock fixture data
    SINCE = "2026-09-05T02:00:00Z"
    UNTIL = "2026-09-06T04:00:00Z"

    # -------------------------------------------------------------
    # 2. Clean window: empty finding set and exit 0 (happy path)
    # -------------------------------------------------------------
    gh_clean_mocks = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "ok",
                "runs": [
                    {
                        "id": 1001,
                        "conclusion": "success",
                        "created_at": "2026-09-05T12:00:00Z",
                        "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/1001",
                    }
                ],
            },
        },
        "jobs": {},
    }
    accounted_clean = {
        "since": SINCE,
        "until": UNTIL,
        "run_ids": [1001],
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_clean,
        gh_mocks=gh_clean_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code != 0:
        fails.append(f"clean window: expected exit 0, got {code}:\n{combined}")
        print(f"  FAIL  clean window: exited {code}")
    elif "::error::" in combined:
        fails.append(f"clean window: unexpected ::error:: annotation emitted:\n{combined}")
        print("  FAIL  clean window: emitted ::error::")
    elif "All review runs accounted for" not in summary:
        fails.append("clean window: step summary missing clean status")
        print("  FAIL  clean window: missing clean message in summary")
    else:
        print("  ok    clean window: all runs accounted for, exits 0, summary updated")

    # -------------------------------------------------------------
    # 3. One unaccounted run produces non-zero exit with run named (failure path)
    # -------------------------------------------------------------
    gh_unacc_mocks = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "ok",
                "runs": [
                    {
                        "id": 2001,
                        "conclusion": "success",
                        "created_at": "2026-09-05T12:00:00Z",
                        "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/2001",
                    },
                    {
                        "id": 2002,
                        "conclusion": "failure",
                        "created_at": "2026-09-05T15:30:00Z",
                        "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/2002",
                    },
                ],
            },
        },
        "jobs": {},
    }
    accounted_missing_2002 = {
        "since": SINCE,
        "until": UNTIL,
        "run_ids": [2001],  # 2002 is unaccounted!
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_missing_2002,
        gh_mocks=gh_unacc_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("unaccounted run: expected non-zero exit, got 0")
        print("  FAIL  unaccounted run: exit 0")
    elif "2002" not in combined or "prismalens/gh-workflows" not in combined:
        fails.append("unaccounted run: output does not name run 2002 and repository prismalens/gh-workflows")
        print("  FAIL  unaccounted run: missing run details in output")
    elif "https://github.com/prismalens/gh-workflows/actions/runs/2002" not in combined:
        fails.append("unaccounted run: output missing run URL")
        print("  FAIL  unaccounted run: missing run URL in output")
    elif "::error::" not in combined:
        fails.append("unaccounted run: missing ::error:: annotation")
        print("  FAIL  unaccounted run: missing ::error::")
    elif "2002" not in summary or "prismalens/gh-workflows" not in summary:
        fails.append("unaccounted run: step summary does not include unaccounted run 2002")
        print("  FAIL  unaccounted run: missing run in summary")
    else:
        print("  ok    unaccounted run: fails with exit non-zero, prints run details and URL, annotates ::error::")

    # -------------------------------------------------------------
    # 4. Cancelled run with zero jobs is filtered, named, and exits 0
    # -------------------------------------------------------------
    gh_cancelled_zero_jobs = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "ok",
                "runs": [
                    {
                        "id": 3001,
                        "conclusion": "cancelled",
                        "created_at": "2026-09-05T17:00:00Z",
                        "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/3001",
                    }
                ],
            },
        },
        "jobs": {
            "3001": {"total_count": 0, "jobs": []},
        },
    }
    accounted_empty = {
        "since": SINCE,
        "until": UNTIL,
        "run_ids": [],
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_empty,
        gh_mocks=gh_cancelled_zero_jobs,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code != 0:
        fails.append(f"cancelled zero jobs: expected exit 0, got {code}:\n{combined}")
        print(f"  FAIL  cancelled zero jobs: exited {code}")
    elif "::error::" in combined:
        fails.append("cancelled zero jobs: unexpectedly emitted ::error:: annotation")
        print("  FAIL  cancelled zero jobs: emitted ::error::")
    elif "3001" not in combined and "3001" not in summary:
        fails.append("cancelled zero jobs: run 3001 not named in output or summary")
        print("  FAIL  cancelled zero jobs: run 3001 not named")
    elif "cancelled" not in summary or "0 jobs" not in summary:
        fails.append("cancelled zero jobs: summary missing explanation for filtered run")
        print("  FAIL  cancelled zero jobs: reason not in summary")
    else:
        print("  ok    cancelled run with zero jobs: filtered, named in summary, exits 0")

    # -------------------------------------------------------------
    # 5. Cancelled run with executed jobs (>0) is NOT filtered and fails
    # -------------------------------------------------------------
    gh_cancelled_with_jobs = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "ok",
                "runs": [
                    {
                        "id": 4001,
                        "conclusion": "cancelled",
                        "created_at": "2026-09-05T19:00:00Z",
                        "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/4001",
                    }
                ],
            },
        },
        "jobs": {
            "4001": {
                "total_count": 1,
                "jobs": [{"name": "review", "status": "completed", "conclusion": "cancelled"}],
            },
        },
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_empty,
        gh_mocks=gh_cancelled_with_jobs,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("cancelled run with executed jobs: expected non-zero exit, got 0")
        print("  FAIL  cancelled with jobs: exit 0")
    elif "4001" not in combined:
        fails.append("cancelled run with executed jobs: run 4001 not named as unaccounted")
        print("  FAIL  cancelled with jobs: run 4001 not in output")
    elif "::error::" not in combined:
        fails.append("cancelled run with executed jobs: missing ::error:: annotation")
        print("  FAIL  cancelled with jobs: missing ::error::")
    else:
        print("  ok    cancelled run with executed jobs: not filtered, correctly fails the job")

    # -------------------------------------------------------------
    # 6. Read API unreachable (CURL_FAIL=1 or HTTP 500) fails loudly (CRITICAL CASE)
    # -------------------------------------------------------------
    # 6a: curl failure
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        curl_fail=True,
        gh_mocks=gh_clean_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("read API unreachable (curl_fail): expected non-zero exit, got 0")
        print("  FAIL  read API unreachable: exit 0")
    elif "All review runs accounted for" in summary:
        fails.append("read API unreachable: falsely reported all runs accounted for!")
        print("  FAIL  read API unreachable: falsely reported clean in summary")
    elif "::error::" not in combined:
        fails.append("read API unreachable: missing ::error:: annotation")
        print("  FAIL  read API unreachable: missing ::error::")
    else:
        print("  ok    read API network failure: exits non-zero, emits error, never false-clean")

    # 6b: HTTP 500 response
    custom_hdr_500 = "HTTP/2 500\nserver: cloudflare\ncf-ray: 500-error-ray\ncontent-type: application/json"
    custom_body_500 = '{"error":"database error"}'
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        curl_code="500",
        custom_headers=custom_hdr_500,
        custom_body=custom_body_500,
        gh_mocks=gh_clean_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("read API HTTP 500: expected non-zero exit, got 0")
        print("  FAIL  read API HTTP 500: exit 0")
    elif "All review runs accounted for" in summary:
        fails.append("read API HTTP 500: falsely reported all runs accounted for!")
        print("  FAIL  read API HTTP 500: falsely reported clean in summary")
    elif "cf-ray: 500-error-ray" not in combined:
        fails.append("read API HTTP 500: captured response headers not printed")
        print("  FAIL  read API HTTP 500: missing headers")
    elif "database error" not in combined:
        fails.append("read API HTTP 500: captured response body not printed")
        print("  FAIL  read API HTTP 500: missing body")
    else:
        print("  ok    read API HTTP 500: exits non-zero, prints headers & body, never false-clean")

    # -------------------------------------------------------------
    # 7. Read API rejected (HTTP 401 & 403)
    # -------------------------------------------------------------
    code, stdout, stderr, summary, auth = run_reconciler_step(script, curl_code="401", since=SINCE, until=UNTIL)
    combined = stdout + "\n" + stderr
    if code == 0 or "token" not in combined:
        fails.append("read API HTTP 401: expected non-zero exit and token diagnostic")
        print("  FAIL  read API HTTP 401")
    else:
        print("  ok    read API HTTP 401: exits non-zero and diagnoses token mismatch")

    code, stdout, stderr, summary, auth = run_reconciler_step(script, curl_code="403", since=SINCE, until=UNTIL)
    combined = stdout + "\n" + stderr
    if code == 0 or "Cloudflare" not in combined:
        fails.append("read API HTTP 403: expected non-zero exit and Cloudflare diagnostic")
        print("  FAIL  read API HTTP 403")
    else:
        print("  ok    read API HTTP 403: exits non-zero and diagnoses edge/WAF block")

    # -------------------------------------------------------------
    # 8. Missing REVIEW_TELEMETRY_TOKEN fails loudly and names secret
    # -------------------------------------------------------------
    code, stdout, stderr, summary, auth = run_reconciler_step(script, token="", since=SINCE, until=UNTIL)
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("empty token: expected non-zero exit, got 0")
        print("  FAIL  empty token: exit 0")
    elif "REVIEW_TELEMETRY_TOKEN" not in combined:
        fails.append("empty token: error output does not name REVIEW_TELEMETRY_TOKEN")
        print("  FAIL  empty token: does not name secret")
    elif "::error::" not in combined:
        fails.append("empty token: missing ::error:: annotation")
        print("  FAIL  empty token: missing ::error::")
    else:
        print("  ok    empty REVIEW_TELEMETRY_TOKEN: exits non-zero and names secret in error")

    # -------------------------------------------------------------
    # 9. Slurped pagination and page-two fixture (finding 3944010366)
    # -------------------------------------------------------------
    gh_paginated_mocks = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "ok",
                "pages": [
                    {
                        "total_count": 2,
                        "workflow_runs": [
                            {
                                "id": 5001,
                                "conclusion": "success",
                                "created_at": "2026-09-05T10:00:00Z",
                                "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/5001",
                            }
                        ],
                    },
                    {
                        "total_count": 2,
                        "workflow_runs": [
                            {
                                "id": 5002,
                                "conclusion": "success",
                                "created_at": "2026-09-05T12:00:00Z",
                                "html_url": "https://github.com/prismalens/gh-workflows/actions/runs/5002",
                            }
                        ],
                    },
                ],
            },
        },
        "jobs": {},
    }
    # 9a: Both runs on both pages accounted for -> exit 0 (happy path)
    accounted_both_pages = {
        "since": SINCE,
        "until": UNTIL,
        "run_ids": [5001, 5002],
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_both_pages,
        gh_mocks=gh_paginated_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code != 0:
        fails.append(f"slurped pagination (all accounted): expected exit 0, got {code}:\n{combined}")
        print(f"  FAIL  slurped pagination (all accounted): exited {code}")
    elif "All review runs accounted for" not in summary:
        fails.append("slurped pagination (all accounted): summary missing clean report")
        print("  FAIL  slurped pagination (all accounted): summary missing clean report")
    elif "| `prismalens/gh-workflows` | 2 | 2 | 0 | ✅ Clean |" not in summary:
        fails.append("slurped pagination (all accounted): summary table missing 2 runs in window")
        print("  FAIL  slurped pagination (all accounted): summary table missing 2 runs")
    else:
        print("  ok    slurped pagination (all accounted): run on page two detected and accounted for (exit 0)")

    # 9b: Run on page two unaccounted -> exit 1 (failure path)
    accounted_missing_page2 = {
        "since": SINCE,
        "until": UNTIL,
        "run_ids": [5001],  # 5002 on page 2 is missing!
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_missing_page2,
        gh_mocks=gh_paginated_mocks,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("slurped pagination (page 2 unaccounted): expected exit 1, got 0")
        print("  FAIL  slurped pagination (page 2 unaccounted): exit 0")
    elif "5002" not in combined or "::error::" not in combined:
        fails.append("slurped pagination (page 2 unaccounted): run 5002 not reported as error")
        print("  FAIL  slurped pagination (page 2 unaccounted): run 5002 not in error output")
    else:
        print("  ok    slurped pagination (page 2 unaccounted): run on page two detected as unaccounted (exit 1)")

    # -------------------------------------------------------------
    # 10. Read workflow runs API failure emits ::error:: and fails
    # -------------------------------------------------------------
    gh_api_fail_mock = {
        "repos": {
            "prismalens/gh-workflows": {
                "status": "api_error",
            },
        },
        "jobs": {},
    }
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        accounted_json=accounted_clean,
        gh_mocks=gh_api_fail_mock,
        since=SINCE,
        until=UNTIL,
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("gh api failure: expected non-zero exit, got 0")
        print("  FAIL  gh api failure: exit 0")
    elif "::error::Failed to read workflow runs for prismalens/gh-workflows" not in combined:
        fails.append("gh api failure: missing ::error::Failed to read workflow runs annotation")
        print("  FAIL  gh api failure: missing error annotation")
    else:
        print("  ok    gh api failure: exits non-zero and emits error annotation")

    # -------------------------------------------------------------
    # 11. Missing repository fails loudly
    # -------------------------------------------------------------
    code, stdout, stderr, summary, auth = run_reconciler_step(
        script,
        repository="",
        env_overrides={"REPOSITORY": "", "GITHUB_REPOSITORY": ""},
    )
    combined = stdout + "\n" + stderr
    if code == 0:
        fails.append("missing repository: expected non-zero exit, got 0")
        print("  FAIL  missing repository: exit 0")
    elif "Repository cannot be determined" not in combined:
        fails.append("missing repository: missing error diagnostic")
        print("  FAIL  missing repository: missing error diagnostic")
    else:
        print("  ok    missing repository: exits non-zero and warns repository cannot be determined")

    # -------------------------------------------------------------
    # 12. Security: secret token value is never echoed in output
    # -------------------------------------------------------------
    secret_val = "SUPER_SECRET_VALUE_NEVER_ECHO_ABC789"
    _, out_clean, err_clean, _, _ = run_reconciler_step(script, token=secret_val, accounted_json=accounted_clean, gh_mocks=gh_clean_mocks)
    _, out_err, err_err, _, _ = run_reconciler_step(script, token=secret_val, curl_code="500")

    all_outputs = [out_clean, err_clean, out_err, err_err]
    if any(secret_val in out for out in all_outputs):
        fails.append("security: secret token value was echoed in script stdout or stderr!")
        print("  FAIL  security: secret token was leaked in output")
    else:
        print("  ok    security: secret token value is never echoed in stdout or stderr")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print("  -", f)
        sys.exit(1)

    print("all telemetry reconciler tests passed")


if __name__ == "__main__":
    main()
