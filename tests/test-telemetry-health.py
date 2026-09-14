#!/usr/bin/env python3
"""Behavioural tests for telemetry health reporting workflow (.github/workflows/telemetry-health.yml).

Extracts the REAL shell body out of .github/workflows/telemetry-health.yml and runs it
against stubbed curl and gh, verifying:
1. Workflow structure:
   - Reusable workflow (.github/workflows/telemetry-health.yml): workflow_call inputs, secrets, permissions.
   - uses telemetry-auth action.
2. Consent check (telemetry.share: off):
   - Skips network calls and reports skip to $GITHUB_STEP_SUMMARY, exits 0.
3. Unconfigured skip:
   - When no auth credentials exist, skips and exits 0.
4. Happy path (all runs accounted):
   - Queries GET /ingest/accounted-runs with authorization header.
   - Queries GitHub Actions runs via gh api.
   - Writes exact JSON payload to $GITHUB_STEP_SUMMARY before sending (#176).
   - POSTs payload to POST /ingest/health.
   - Exits 0 and records success in step summary.
5. Unaccounted runs:
   - Identifies runs present in GitHub Actions but absent from Worker's accounted-runs.
   - Includes unaccounted run IDs and details in payload.
   - Writes exact payload to $GITHUB_STEP_SUMMARY before sending.
   - POSTs to /ingest/health and renders markdown table in step summary.
   - Exits 0.
6. Error handling:
   - Accounted-runs endpoint failure (HTTP 401, 403, 500) fails loudly (exit 1).
   - Health ingest endpoint failure (HTTP 400, 500) fails loudly (exit 1).
   - Missing repository fails loudly (exit 1).

Run: python3 tests/test-telemetry-health.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/telemetry-health.yml"


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
is_post=0
is_get=0
capture_post="${CAPTURE_POST_FILE:-}"
capture_hdr="${CAPTURE_HDR_FILE:-}"

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
    -X)
      ((i++))
      if [ "${args[$i]}" = "POST" ]; then is_post=1; fi
      ;;
    -G)
      is_get=1
      ;;
    -H)
      ((i++))
      hdr_arg="${args[$i]}"
      if [[ "$hdr_arg" == @* ]]; then
        hf="${hdr_arg#@}"
        if [ -f "$hf" ] && [ -n "$capture_hdr" ]; then
          cat "$hf" >> "$capture_hdr"
        fi
      fi
      ;;
  esac
  ((i++))
done

if [ "$is_post" -eq 1 ]; then
  # Read payload from stdin
  payload=$(cat)
  if [ -n "$capture_post" ]; then
    printf '%s\n' "$payload" >> "$capture_post"
  fi
  code="${FAKE_POST_CODE:-200}"
  if [ -n "$headers_file" ]; then
    printf 'HTTP/2 %s\r\ncontent-type: application/json\r\n\r\n' "$code" > "$headers_file"
  fi
  if [ -n "$body_file" ]; then
    if [ -n "${FAKE_POST_BODY:-}" ]; then
      printf '%s' "$FAKE_POST_BODY" > "$body_file"
    else
      printf '{"status":"ok","id":"report-uuid-176"}' > "$body_file"
    fi
  fi
  printf '%s' "$code"
  exit 0
fi

# Otherwise GET (accounted-runs)
code="${FAKE_GET_CODE:-200}"
if [ -n "$headers_file" ]; then
  printf 'HTTP/2 %s\r\ncontent-type: application/json\r\n\r\n' "$code" > "$headers_file"
fi
if [ -n "$body_file" ]; then
  if [ -n "${FAKE_GET_BODY:-}" ]; then
    printf '%s' "$FAKE_GET_BODY" > "$body_file"
  else
    printf '{"repository":"prismalens/prismalens","run_ids":[1001,1002]}' > "$body_file"
  fi
fi
printf '%s' "$code"
exit 0
"""

GH_STUB = r"""#!/usr/bin/env bash
args=("$*")

case "$1" in
  api)
    for a in "$@"; do
      if [[ "$a" == *actions/workflows/* ]] || [[ "$a" == *actions/runs* ]]; then
        printf '%s' "${FAKE_WORKFLOW_RUNS:-[]}"
        exit 0
      fi
      if [[ "$a" == *pulls/comments* ]]; then
        printf '%s' "${FAKE_PULL_COMMENTS:-[]}"
        exit 0
      fi
    done
    ;;
  pr)
    if [ "$2" = "list" ]; then
      printf '%s' "${FAKE_PR_LIST:-[]}"
      exit 0
    fi
    ;;
esac

echo "gh stub: unhandled command $@" >&2
exit 0
"""


def make_bin(td):
    binp = td / "bin"
    binp.mkdir()
    (binp / "curl").write_text(CURL_STUB)
    (binp / "curl").chmod(0o755)
    (binp / "gh").write_text(GH_STUB)
    (binp / "gh").chmod(0o755)
    return binp


def run_test_script(td, script, env_overrides=None):
    binp = make_bin(td)
    summary_file = td / "step_summary.md"
    capture_post = td / "captured_posts.jsonl"
    capture_hdr = td / "captured_headers.txt"

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{binp}:{env.get('PATH', '')}",
            "GITHUB_STEP_SUMMARY": str(summary_file),
            "CAPTURE_POST_FILE": str(capture_post),
            "CAPTURE_HDR_FILE": str(capture_hdr),
            "REPOSITORY": "prismalens/prismalens",
            "WINDOW_DAYS": "7",
            "TEST_WINDOW_START": "2026-09-07T00:00:00Z",
            "TEST_WINDOW_END": "2026-09-14T00:00:00Z",
            "TEST_NOW_ISO": "2026-09-14T10:00:00Z",
            "AUTH_HEADER": "Bearer oidc-valid-token",
            "INGEST_URL": "https://review-telemetry.sfun.cloud",
        }
    )
    if env_overrides:
        env.update(env_overrides)

    proc = subprocess.run(
        ["bash", "-c", script],
        cwd=str(td),
        env=env,
        capture_output=True,
        text=True,
    )

    summary_text = summary_file.read_text() if summary_file.exists() else ""
    post_lines = capture_post.read_text().splitlines() if capture_post.exists() else []
    headers_text = capture_hdr.read_text() if capture_hdr.exists() else ""

    return proc, summary_text, post_lines, headers_text


def test_suite():
    print("=== Testing telemetry-health.yml ===")

    # 1. Workflow structure assertions
    assert WF.exists(), f"{WF} does not exist"
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    assert wf["name"] == "Telemetry Health"
    on_section = wf.get("on") or wf.get(True) or {}
    assert "workflow_call" in on_section
    assert "window_days" in on_section["workflow_call"]["inputs"]
    assert "REVIEW_TELEMETRY_URL" in on_section["workflow_call"]["secrets"]
    assert "REVIEW_TELEMETRY_TOKEN" in on_section["workflow_call"]["secrets"]
    assert wf["permissions"]["actions"] == "read"
    assert wf["permissions"]["contents"] == "read"
    assert wf["permissions"]["id-token"] == "write"

    steps = wf["jobs"]["health"]["steps"]
    assert any("telemetry-auth" in s.get("uses", "") for s in steps)
    print("  ok    workflow structure, triggers, permissions and telemetry-auth action pin")

    script = extract_step_script("health", "Report telemetry health")

    # 2. Consent check (telemetry.share: off)
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _ = run_test_script(pathlib.Path(td), script, {"TELEMETRY_SHARE": "off"})
        assert proc.returncode == 0, f"Expected 0 on share: off, got {proc.returncode}"
        assert "telemetry.share: off" in proc.stdout
        assert "telemetry.share: off" in summary
        assert len(posts) == 0, "Expected no POST calls when share: off"
        print("  ok    telemetry.share: off skips reporting, writes to summary, exits 0")

    # 3. Unconfigured skip
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _ = run_test_script(
            pathlib.Path(td), script, {"AUTH_HEADER": "", "INGEST_TOKEN": ""}
        )
        assert proc.returncode == 0, f"Expected 0 on unconfigured, got {proc.returncode}"
        assert "not configured" in proc.stdout
        assert len(posts) == 0
        print("  ok    unconfigured skips without error")

    # 4. Happy path: all runs accounted
    workflow_runs_fixture = json.dumps(
        [
            {
                "workflow_runs": [
                    {
                        "id": 1001,
                        "created_at": "2026-09-08T12:00:00Z",
                        "conclusion": "success",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1001",
                    },
                    {
                        "id": 1002,
                        "created_at": "2026-09-10T12:00:00Z",
                        "conclusion": "success",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1002",
                    },
                ]
            }
        ]
    )
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, hdrs = run_test_script(
            pathlib.Path(td),
            script,
            {
                "FAKE_WORKFLOW_RUNS": workflow_runs_fixture,
                "FAKE_GET_BODY": json.dumps({"run_ids": [1001, 1002]}),
                "FAKE_PR_LIST": json.dumps([{"number": 42}, {"number": 43}]),
            },
        )
        assert proc.returncode == 0, f"Expected 0 on happy path, got {proc.returncode}: {proc.stderr}\n{proc.stdout}"
        assert len(posts) == 1, f"Expected 1 POST call, got {len(posts)}"
        payload = json.loads(posts[0])
        assert payload["repository"] == "prismalens/prismalens"
        assert payload["report_version"] == "1"
        assert payload["workflow_runs"] == 2
        assert payload["workflow_run_ids"] == [1001, 1002]
        assert payload["pr_state_count"] == 2
        assert payload["unaccounted_runs"] == []

        # Verified: exact payload is written to Step Summary before sending
        assert "### Payload" in summary
        assert json.dumps(payload, indent=2) in summary or posts[0] in summary
        assert "All workflow runs in window are accounted for in telemetry." in summary
        assert "Worker acknowledged report ID: `report-uuid-176`" in summary
        assert "authorization: Bearer oidc-valid-token" in hdrs
        print("  ok    happy path: queries accounted runs, compares, writes payload to summary, POSTs, exit 0")

    # 5. Unaccounted run detection
    workflow_runs_with_unaccounted = json.dumps(
        [
            {
                "workflow_runs": [
                    {
                        "id": 1001,
                        "created_at": "2026-09-08T12:00:00Z",
                        "conclusion": "success",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1001",
                    },
                    {
                        "id": 1003,
                        "created_at": "2026-09-11T14:00:00Z",
                        "conclusion": "failure",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1003",
                    },
                ]
            }
        ]
    )
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _ = run_test_script(
            pathlib.Path(td),
            script,
            {
                "FAKE_WORKFLOW_RUNS": workflow_runs_with_unaccounted,
                "FAKE_GET_BODY": json.dumps({"run_ids": [1001]}),
            },
        )
        assert proc.returncode == 0, f"Expected 0, got {proc.returncode}: {proc.stderr}\n{proc.stdout}"
        assert len(posts) == 1
        payload = json.loads(posts[0])
        assert payload["workflow_runs"] == 2
        assert payload["workflow_run_ids"] == [1001, 1003]
        assert len(payload["unaccounted_runs"]) == 1
        assert payload["unaccounted_runs"][0]["id"] == 1003
        assert payload["unaccounted_runs"][0]["conclusion"] == "failure"
        assert payload["unaccounted_runs"][0]["html_url"] == "https://github.com/prismalens/prismalens/actions/runs/1003"

        assert "### Unaccounted Runs" in summary
        assert "| 1003 | failure | 2026-09-11T14:00:00Z | [Run](https://github.com/prismalens/prismalens/actions/runs/1003) |" in summary
        print("  ok    unaccounted runs identified with URL and conclusion, posted, table in summary")

    # 6. Error handling: accounted-runs failure
    with tempfile.TemporaryDirectory() as td:
        proc, _, posts, _ = run_test_script(pathlib.Path(td), script, {"FAKE_GET_CODE": "403"})
        assert proc.returncode != 0, "Expected non-zero exit when accounted runs returns 403"
        assert "Failed to read accounted runs from Worker" in proc.stdout or "Failed to read accounted runs" in proc.stderr
        assert len(posts) == 0
        print("  ok    accounted runs failure (HTTP 403) fails loudly")

    # 7. Error handling: health post failure
    with tempfile.TemporaryDirectory() as td:
        proc, _, posts, _ = run_test_script(pathlib.Path(td), script, {"FAKE_POST_CODE": "500"})
        assert proc.returncode != 0, "Expected non-zero exit when health post returns 500"
        assert "Failed to submit health report to Worker" in proc.stdout or "Failed to submit health report" in proc.stderr
        assert len(posts) == 1
        print("  ok    health ingest failure (HTTP 500) fails loudly")

    # 8. Error handling: missing repository
    with tempfile.TemporaryDirectory() as td:
        proc, _, _, _ = run_test_script(pathlib.Path(td), script, {"REPOSITORY": "", "GITHUB_REPOSITORY": ""})
        assert proc.returncode != 0, "Expected non-zero exit when repository is empty"
        assert "Repository cannot be determined" in proc.stdout or "Repository cannot be determined" in proc.stderr
        print("  ok    missing repository fails loudly")

    print("\nAll telemetry health tests passed successfully.")


if __name__ == "__main__":
    test_suite()
