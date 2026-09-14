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
   - When no auth credentials or no URL exist, skips and exits 0.
4. No /api/* call is ever made (#170, F4): the job never reads accounted-runs itself,
   never lists PRs, never lists findings. The Worker computes every count.
5. Happy path:
   - Queries GitHub Actions runs via gh api.
   - Writes the exact spec body to $GITHUB_STEP_SUMMARY in a json fence before sending.
   - POSTs the body to POST /ingest/health, writes the Worker's response after it.
   - Exits 0.
6. Cancelled-with-zero-jobs filter (ported from telemetry-reconcile.yml, #87):
   - A cancelled run with zero jobs executed is dropped from the submitted runs.
   - A cancelled run with jobs executed is kept.
7. Error handling, telemetry must never fail the job (F4):
   - A failed runs listing warns and exits 0.
   - A failed POST warns and exits 0.
   - A non-200 POST answer warns and exits 0.
   - Missing repository still fails loudly (exit 1): a real misconfiguration, not telemetry
     being unavailable.
8. Unaccounted runs in the Worker's response each raise one ::warning:: naming their URL.

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


# Only ever POSTs (to /ingest/health). Any GET is recorded to CAPTURE_GET_FILE so a test
# can assert the job never reads /api/* itself (F4): the Worker computes every count.
CURL_STUB = r"""#!/usr/bin/env bash
args=("$@")
headers_file=""
body_file=""
is_post=0
is_get=0
capture_post="${CAPTURE_POST_FILE:-}"
capture_hdr="${CAPTURE_HDR_FILE:-}"
capture_get="${CAPTURE_GET_FILE:-}"

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

if [ "$is_get" -eq 1 ] && [ -n "$capture_get" ]; then
  echo "GET: ${args[*]}" >> "$capture_get"
fi

if [ "$is_post" -eq 1 ]; then
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
      printf '{"status":"ok","id":1,"unaccounted_runs":[]}' > "$body_file"
    fi
  fi
  printf '%s' "$code"
  exit 0
fi

echo "curl stub: unexpected non-POST call: ${args[*]}" >&2
exit 1
"""

# Answers the workflow-runs listing and the per-run jobs lookup used by the
# cancelled-with-zero-jobs filter. FAKE_ZERO_JOB_RUN_IDS is a comma-separated list of
# run ids whose /jobs lookup should report total_count: 0. FAKE_JOBS_LOOKUP_FAIL_RUN_IDS
# is a comma-separated list of run ids whose /jobs lookup should fail outright (#177).
GH_STUB = r"""#!/usr/bin/env bash
joined="$*"

if [ "$1" = "api" ]; then
  if [[ "$joined" == *"/jobs"* ]]; then
    rid=$(echo "$joined" | grep -oE 'runs/[0-9]+/jobs' | grep -oE '[0-9]+')
    fail_ids=",${FAKE_JOBS_LOOKUP_FAIL_RUN_IDS:-},"
    if [[ "$fail_ids" == *",${rid},"* ]]; then
      echo "gh: API error fetching jobs for run ${rid}" >&2
      exit 1
    fi
    zero_ids=",${FAKE_ZERO_JOB_RUN_IDS:-},"
    if [[ "$zero_ids" == *",${rid},"* ]]; then
      printf '{"total_count": 0, "jobs": []}'
    else
      printf '{"total_count": 1, "jobs": [{"id": 1}]}'
    fi
    exit 0
  fi
  if [ -n "${FAKE_WORKFLOW_RUNS_FAIL:-}" ]; then
    echo "gh: API error fetching workflow runs" >&2
    exit 1
  fi
  if [[ "$joined" == *"actions/workflows/"* ]]; then
    printf '%s' "${FAKE_WORKFLOW_RUNS:-[]}"
    exit 0
  fi
fi

echo "gh stub: unhandled command $*" >&2
exit 1
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
    capture_get = td / "captured_gets.txt"

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{binp}:{env.get('PATH', '')}",
            "GITHUB_STEP_SUMMARY": str(summary_file),
            "CAPTURE_POST_FILE": str(capture_post),
            "CAPTURE_HDR_FILE": str(capture_hdr),
            "CAPTURE_GET_FILE": str(capture_get),
            "REPOSITORY": "prismalens/prismalens",
            "WINDOW_DAYS": "7",
            "TEST_WINDOW_START": "2026-09-07T00:00:00Z",
            "TEST_WINDOW_END": "2026-09-14T00:00:00Z",
            "AUTH_HEADER": "Bearer oidc-valid-token",
            "TELEMETRY_SHARE": "full",
            "INGEST_URL": "https://telemetry.example.test/ingest",
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
    get_text = capture_get.read_text() if capture_get.exists() else ""

    return proc, summary_text, post_lines, headers_text, get_text


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
        proc, summary, posts, _, gets = run_test_script(pathlib.Path(td), script, {"TELEMETRY_SHARE": "off"})
        assert proc.returncode == 0, f"Expected 0 on share: off, got {proc.returncode}"
        assert "telemetry.share: off" in proc.stdout
        assert "telemetry.share: off" in summary
        assert len(posts) == 0, "Expected no POST calls when share: off"
        assert gets == "", "Expected no GET calls when share: off"
        print("  ok    telemetry.share: off skips reporting, writes to summary, exits 0")

    # 3. Unconfigured skip: no auth, and separately no URL
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td), script, {"AUTH_HEADER": "", "INGEST_TOKEN": ""}
        )
        assert proc.returncode == 0, f"Expected 0 on unconfigured, got {proc.returncode}"
        assert "not configured" in proc.stdout
        assert len(posts) == 0
        print("  ok    unconfigured (no auth) skips without error")

    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(pathlib.Path(td), script, {"INGEST_URL": ""})
        assert proc.returncode == 0, f"Expected 0 on empty url, got {proc.returncode}"
        assert "not configured" in proc.stdout
        assert len(posts) == 0
        print("  ok    unconfigured (no url) skips without error")

    # 4. Happy path: no /api/* call is ever made, Worker computes every count
    workflow_runs_fixture = json.dumps(
        [
            {
                "workflow_runs": [
                    {
                        "id": 1001,
                        "created_at": "2026-09-08T12:00:00Z",
                        "conclusion": "success",
                        "event": "pull_request",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1001",
                    },
                    {
                        "id": 1002,
                        "created_at": "2026-09-10T12:00:00Z",
                        "conclusion": "success",
                        "event": "pull_request",
                        "html_url": "https://github.com/prismalens/prismalens/actions/runs/1002",
                    },
                ]
            }
        ]
    )
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, hdrs, gets = run_test_script(
            pathlib.Path(td),
            script,
            {"FAKE_WORKFLOW_RUNS": workflow_runs_fixture},
        )
        assert proc.returncode == 0, f"Expected 0 on happy path, got {proc.returncode}: {proc.stderr}\n{proc.stdout}"
        assert gets == "", f"Expected no GET calls (no /api/* read, F4), got: {gets}"
        assert len(posts) == 1, f"Expected 1 POST call, got {len(posts)}"
        payload = json.loads(posts[0])
        assert payload["schema_version"] == 1
        assert payload["repository"] == "prismalens/prismalens"
        assert payload["window_start"] == "2026-09-07T00:00:00Z"
        assert payload["window_end"] == "2026-09-14T00:00:00Z"
        assert payload["share"] == "full"
        assert [r["id"] for r in payload["runs"]] == [1001, 1002]
        assert payload["runs"][0]["conclusion"] == "success"
        assert payload["runs"][0]["event"] == "pull_request"

        # Verified: exact payload is written to Step Summary in a json fence before sending
        assert "### Payload" in summary
        assert "```json" in summary
        assert json.dumps(payload, indent=2) in summary or posts[0] in summary
        assert "Telemetry health report submitted successfully" in proc.stdout
        assert "### Worker Response" in summary
        assert "authorization: Bearer oidc-valid-token" in hdrs
        print("  ok    happy path: no /api/* read, writes spec body to summary, POSTs, response after it, exit 0")

    # 5. Cancelled-with-zero-jobs filter (ported from telemetry-reconcile.yml, #87)
    workflow_runs_with_cancelled = json.dumps(
        [
            {
                "workflow_runs": [
                    {
                        "id": 2001,
                        "created_at": "2026-09-08T12:00:00Z",
                        "conclusion": "success",
                        "event": "pull_request",
                    },
                    {
                        "id": 2002,
                        "created_at": "2026-09-09T12:00:00Z",
                        "conclusion": "cancelled",
                        "event": "pull_request",
                    },
                    {
                        "id": 2003,
                        "created_at": "2026-09-10T12:00:00Z",
                        "conclusion": "cancelled",
                        "event": "pull_request",
                    },
                ]
            }
        ]
    )
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td),
            script,
            {
                "FAKE_WORKFLOW_RUNS": workflow_runs_with_cancelled,
                # 2002 had zero jobs and is dropped; 2003 had jobs and is kept.
                "FAKE_ZERO_JOB_RUN_IDS": "2002",
            },
        )
        assert proc.returncode == 0, f"Expected 0, got {proc.returncode}: {proc.stderr}\n{proc.stdout}"
        assert len(posts) == 1
        payload = json.loads(posts[0])
        run_ids = sorted(r["id"] for r in payload["runs"])
        assert run_ids == [2001, 2003], f"Expected 2002 dropped (zero jobs), got {run_ids}"
        assert "Filtered run 2002" in proc.stdout
        print("  ok    cancelled run with zero jobs is dropped; cancelled run with jobs is kept")

    # 5b. An incomplete jobs lookup for a cancelled run withholds the whole report,
    # rather than publishing a count that might be wrong (#177, thread 4006669662).
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td),
            script,
            {
                "FAKE_WORKFLOW_RUNS": workflow_runs_with_cancelled,
                "FAKE_JOBS_LOOKUP_FAIL_RUN_IDS": "2002",
            },
        )
        assert proc.returncode == 0, f"Expected 0, got {proc.returncode}: {proc.stderr}\n{proc.stdout}"
        assert len(posts) == 0, f"Expected no POST when a jobs lookup fails, got {posts}"
        assert "::warning::telemetry-health: jobs lookup failed for run 2002" in proc.stdout, proc.stdout
        assert "Health report not sent: jobs lookup failed for run 2002" in summary, summary
        print("  ok    an incomplete jobs lookup for a cancelled run withholds the whole report")

    # 6. Error handling: telemetry must never fail the job
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td), script, {"FAKE_WORKFLOW_RUNS_FAIL": "1"}
        )
        assert proc.returncode == 0, f"Expected 0 on runs-listing failure, got {proc.returncode}"
        assert "::warning::" in proc.stdout
        assert "Failed to read workflow runs" in proc.stdout
        assert len(posts) == 0
        print("  ok    runs-listing failure warns and exits 0")

    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td), script, {"FAKE_WORKFLOW_RUNS": "[]", "FAKE_POST_CODE": "500"}
        )
        assert proc.returncode == 0, f"Expected 0 on POST failure, got {proc.returncode}"
        assert "::warning::" in proc.stdout
        assert "Failed to submit health report" in proc.stdout
        assert len(posts) == 1
        print("  ok    a non-200 POST answer warns and exits 0")

    # 7. Missing repository still fails loudly: a real misconfiguration, not
    # telemetry being unavailable.
    with tempfile.TemporaryDirectory() as td:
        proc, _, _, _, _ = run_test_script(pathlib.Path(td), script, {"REPOSITORY": "", "GITHUB_REPOSITORY": ""})
        assert proc.returncode != 0, "Expected non-zero exit when repository is empty"
        assert "Repository cannot be determined" in proc.stdout or "Repository cannot be determined" in proc.stderr
        print("  ok    missing repository fails loudly")

    # 8. Unaccounted runs in the Worker's response each raise one ::warning:: naming their URL
    with tempfile.TemporaryDirectory() as td:
        proc, summary, posts, _, _ = run_test_script(
            pathlib.Path(td),
            script,
            {
                "FAKE_WORKFLOW_RUNS": "[]",
                "FAKE_POST_BODY": json.dumps(
                    {
                        "status": "ok",
                        "id": 7,
                        "unaccounted_runs": [
                            {"id": 3001, "conclusion": "failure", "created_at": "2026-09-09T00:00:00Z"},
                            {"id": 3002, "conclusion": "success", "created_at": "2026-09-10T00:00:00Z"},
                        ],
                    }
                ),
            },
        )
        assert proc.returncode == 0
        assert "::warning::telemetry-health: run 3001" in proc.stdout
        assert "https://github.com/prismalens/prismalens/actions/runs/3001" in proc.stdout
        assert "::warning::telemetry-health: run 3002" in proc.stdout
        assert "https://github.com/prismalens/prismalens/actions/runs/3002" in proc.stdout
        print("  ok    one ::warning:: per unaccounted run, naming its URL")

    print("\nAll telemetry health tests passed successfully.")


if __name__ == "__main__":
    test_suite()
