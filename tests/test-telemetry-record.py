#!/usr/bin/env python3
"""Behavioural tests for telemetry wave 2 record composition, lane events, and verdict fields.

Extracts the REAL shell bodies out of claude-code-review.yml and runs them against stubbed
`gh` and `curl`, verifying:
1. Composed POST usage record body is valid JSON with correct types for all wave 2 fields.
2. Empty verdict fields (e.g. skipped-author early exit) yield null rather than "".
3. Attacker-controlled pr_title containing quotes, newlines, $(id), backticks survives verbatim
   into the JSON payload without shell interpolation or code execution.
4. verdict_kind produces each of the 8 allowed values across all announce branches.
5. Non-2xx ingest responses and network failures leave the step exit code 0.
6. lane-event body carries accepted reasons (no-token, auto-paused, skip-author, fork-head),
   including rounds_used for auto-paused.
7. Fork PR runs with empty token exit 0 with a warning and do not POST.
8. Config resolution JSON is properly structured with sources and layer outcomes.

Run: python3 tests/test-telemetry-record.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"


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
args="$*"
body=""
if [[ "$args" == *"--data-binary @-"* ]]; then
  body="$(cat)"
fi

if [ -n "$CAPTURE_BODY" ]; then
  printf '%s' "$body" > "$CAPTURE_BODY"
fi

if [ "${CURL_FAIL:-0}" = "1" ]; then
  echo "curl: (7) Failed to connect to host" >&2
  exit 7
fi

code="${CURL_HTTP_CODE:-204}"
if [[ "$args" == *"%{http_code}"* ]]; then
  printf '%s' "$code"
fi
exit 0
"""

GH_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"-X PATCH"*|*"-X POST"*)
    exit 0 ;;
  *claude-review-liveness*) printf '%s' "${FAKE_MARKER:-}" ; exit 0 ;;
  *"pulls/"*"/comments"*)
    if [ -n "${FAKE_INLINE_JSON:-}" ]; then
      printf '%s' "$FAKE_INLINE_JSON"
    else
      printf '%s' "${FAKE_INLINE:-[]}"
    fi
    exit 0 ;;
  *"pulls/"*)
    if [ -n "${FAKE_PR_JSON:-}" ]; then
      printf '%s' "$FAKE_PR_JSON"
    else
      printf '{"title":"Test PR","user":{"login":"alice"},"state":"open","base":{"ref":"main","sha":"aaa"},"head":{"ref":"feat","sha":"bbb","repo":{"full_name":"o/r"}},"draft":false,"changed_files":1,"additions":5,"deletions":2}'
    fi
    exit 0 ;;
  *"verification round"*) printf '%s' "${FAKE_VERIFY_SUMMARY:-}"; exit 0 ;;
  *"## Code review"*)
    if [ -n "${FAKE_SUMMARY_JSON:-}" ]; then
      printf '%s' "$FAKE_SUMMARY_JSON"
    else
      printf '%s' "${FAKE_SUMMARY:-[]}"
    fi
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_telemetry_post_step(script, *, record=None, env_overrides=None,
                            curl_code="204", curl_fail=False):
    if record is None:
        record = {
            "session_id": "test-session-123",
            "repository": "prismalens/test-repo",
            "pr_number": 42,
            "run_id": 1001,
            "run_attempt": 1,
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_cost_usd": 0.05,
            "duration_ms": 12000,
        }
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "curl").write_text(CURL_STUB)
        (binp / "curl").chmod(0o755)

        capture_body = tdp / "captured_body.json"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_BODY=str(capture_body),
            CURL_HTTP_CODE=str(curl_code),
            CURL_FAIL="1" if curl_fail else "0",
            RECORD=json.dumps(record) if isinstance(record, dict) else str(record),
            LANE_VERSION="2",
            INGEST_URL="https://telemetry.prismalens.dev/ingest",
            INGEST_TOKEN="secret-token-xyz",
            FALLBACK_REASON="",
            RANGE_BASE="",
            RANGE_HEAD="",
            MODEL_SOURCE="default",
            CONFIG_RESOLUTION=json.dumps({"sources": {"default_model": "workflow default"}, "layers": {"workflow_inputs": {"outcome": "ok", "unconsumed": []}}}),
            JOB_CONCLUSION="success",
            ROUND_ORDINAL="1",
            VERDICT_KIND="reviewed",
            VERDICT_TEXT="reviewed `abc1234` and posted 1 inline comment.",
            INLINE_COUNT="1",
            SUMMARY_COUNT="0",
            COMMENT_NODE_IDS=json.dumps(["PRRC_kwDO123"]),
            PR_TITLE="feat: add cool feature",
            PR_AUTHOR="alice",
            PR_STATE="open",
            PR_BASE_REF="main",
            PR_HEAD_REF="feat/cool",
        )
        if env_overrides:
            env.update(env_overrides)

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        captured = None
        if capture_body.exists() and capture_body.read_text().strip():
            try:
                captured = json.loads(capture_body.read_text())
            except Exception as e:
                captured = f"MALFORMED_JSON: {e} ({capture_body.read_text()})"

        return p.returncode, captured, p.stdout, p.stderr


def run_lane_event_step(script, *, env_overrides=None,
                        curl_code="204", curl_fail=False):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "curl").write_text(CURL_STUB)
        (binp / "curl").chmod(0o755)

        capture_body = tdp / "captured_lane_event.json"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_BODY=str(capture_body),
            CURL_HTTP_CODE=str(curl_code),
            CURL_FAIL="1" if curl_fail else "0",
            IS_FORK="false",
            SKIP_REASON="no-token",
            ROUND_ORDINAL="",
            REPO="prismalens/test-repo",
            PR_NUMBER="42",
            HEAD_SHA="1234567890abcdef1234567890abcdef12345678",
            RUN_ID="999",
            RUN_ATTEMPT="1",
            RUN_URL="https://github.com/prismalens/test-repo/actions/runs/999",
            INGEST_URL="https://telemetry.prismalens.dev/ingest",
            INGEST_TOKEN="secret-token-xyz",
            LANE_VERSION="2",
        )
        if env_overrides:
            env.update(env_overrides)

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        captured = None
        if capture_body.exists() and capture_body.read_text().strip():
            try:
                captured = json.loads(capture_body.read_text())
            except Exception as e:
                captured = f"MALFORMED_JSON: {e} ({capture_body.read_text()})"

        return p.returncode, captured, p.stdout, p.stderr


def run_announce_step(script, *, env_overrides=None, fake_inline_json=None,
                      fake_summary_json=None, fake_verify_summary=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)

        out_file = tdp / "output.txt"
        out_file.touch()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="x",
            REPO="prismalens/test-repo",
            PR="42",
            HEAD_SHA="1234567890abcdef1234567890abcdef12345678",
            EVENT_NAME="pull_request",
            MODE="review",
            SKIP_REASON="",
            REVIEW_RESULT="success",
            MUTATE_RESULT="success",
            RESOLVED="0",
            OPEN="0",
            STARTED_AT="2026-01-01T00:00:00Z",
            RANGE_BASE="",
            RANGE_HEAD="",
            MODEL="claude-sonnet-5",
            MODEL_SOURCE="default",
            RUN_URL="https://github.com/prismalens/test-repo/actions/runs/999",
            FAKE_MARKER=json.dumps({"id": 1, "body": "<!-- claude-review-liveness rounds=1 -->"}),
            FAKE_INLINE_JSON=json.dumps(fake_inline_json) if fake_inline_json is not None else "",
            FAKE_SUMMARY_JSON=json.dumps(fake_summary_json) if fake_summary_json is not None else "",
            FAKE_VERIFY_SUMMARY=fake_verify_summary or "",
        )
        if env_overrides:
            env.update(env_overrides)

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)

        outputs = {}
        if out_file.exists():
            content = out_file.read_text()
            # Parse key<<DELIM heredocs and standard key=val
            lines = content.splitlines()
            i = 0
            while i < len(lines):
                line = lines[i]
                if "<<" in line:
                    k, delim = line.split("<<", 1)
                    val_lines = []
                    i += 1
                    while i < len(lines) and lines[i] != delim:
                        val_lines.append(lines[i])
                        i += 1
                    outputs[k] = "\n".join(val_lines)
                elif "=" in line:
                    k, v = line.split("=", 1)
                    outputs[k] = v
                i += 1

        return p.returncode, outputs, p.stdout, p.stderr


def run_resolve_step(script, *, pr_json_obj=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)

        out_file = tdp / "output.txt"
        out_file.touch()

        if pr_json_obj is None:
            pr_json_obj = {
                "title": "fix: resolve edge case",
                "user": {"login": "octocat"},
                "state": "open",
                "base": {"ref": "main", "sha": "0000000000000000000000000000000000000000"},
                "head": {"ref": "patch-1", "sha": "1111111111111111111111111111111111111111", "repo": {"full_name": "prismalens/test-repo"}},
                "draft": False,
                "changed_files": 3,
                "additions": 10,
                "deletions": 4,
            }

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GITHUB_REPOSITORY="prismalens/test-repo",
            GH_TOKEN="x",
            PR_NUMBER="42",
            EVENT_NAME="pull_request",
            FAKE_PR_JSON=json.dumps(pr_json_obj),
        )

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)

        outputs = {}
        if out_file.exists():
            content = out_file.read_text()
            lines = content.splitlines()
            i = 0
            while i < len(lines):
                line = lines[i]
                if "<<" in line:
                    k, delim = line.split("<<", 1)
                    val_lines = []
                    i += 1
                    while i < len(lines) and lines[i] != delim:
                        val_lines.append(lines[i])
                        i += 1
                    outputs[k] = "\n".join(val_lines)
                elif "=" in line:
                    k, v = line.split("=", 1)
                    outputs[k] = v
                i += 1

        return p.returncode, outputs, p.stdout, p.stderr


def main():
    fails = []
    print("=== Testing Telemetry Wave 2 Records and Lane Events ===\n")

    telemetry_script = extract_step_script("telemetry", "Post the review round record")
    lane_event_script = extract_step_script("lane-event", "Record lane event")
    announce_script = extract_step_script("announce", "Upsert liveness comment")
    resolve_script = extract_step_script("resolve", "Fetch PR metadata and validate origin")

    # -------------------------------------------------------------
    # 1. Telemetry Post Step: happy path full record composition
    # -------------------------------------------------------------
    ret, payload, stdout, stderr = run_telemetry_post_step(telemetry_script)
    if ret != 0:
        fails.append(f"telemetry happy path: step exited {ret}: {stderr}")
        print(f"  FAIL  telemetry happy path (exited {ret})")
    elif not isinstance(payload, dict):
        fails.append(f"telemetry happy path: captured body is not dict: {payload}")
        print(f"  FAIL  telemetry happy path: invalid payload")
    else:
        # Check all Wave 2 fields and types
        type_checks = [
            ("lane_version", "2", str),
            ("verdict_kind", "reviewed", str),
            ("verdict_text", "reviewed `abc1234` and posted 1 inline comment.", str),
            ("inline_count", 1, int),
            ("summary_count", 0, int),
            ("comment_node_ids", ["PRRC_kwDO123"], list),
            ("fallback_reason", None, type(None)),
            ("range_base", None, type(None)),
            ("range_head", None, type(None)),
            ("model_source", "default", str),
            ("config_resolution", {"sources": {"default_model": "workflow default"}, "layers": {"workflow_inputs": {"outcome": "ok", "unconsumed": []}}}, dict),
            ("job_conclusion", "success", str),
            ("round_ordinal", 1, int),
            ("pr_title", "feat: add cool feature", str),
            ("pr_author", "alice", str),
            ("pr_state", "open", str),
            ("pr_base_ref", "main", str),
            ("pr_head_ref", "feat/cool", str),
        ]
        all_ok = True
        for field, want_val, want_type in type_checks:
            if field not in payload:
                fails.append(f"telemetry happy path: missing field {field!r}")
                all_ok = False
            elif not isinstance(payload[field], want_type):
                fails.append(f"telemetry happy path: field {field!r} has type {type(payload[field])}, want {want_type}")
                all_ok = False
            elif want_val is not None and payload[field] != want_val:
                fails.append(f"telemetry happy path: field {field!r} = {payload[field]!r}, want {want_val!r}")
                all_ok = False
        if all_ok:
            print("  ok    telemetry happy path: carries all wave 2 fields with correct types")

    # -------------------------------------------------------------
    # 2. Empty verdict fields yield null (not "")
    # -------------------------------------------------------------
    ret, payload, stdout, stderr = run_telemetry_post_step(
        telemetry_script,
        env_overrides={
            "VERDICT_KIND": "",
            "VERDICT_TEXT": "",
            "INLINE_COUNT": "",
            "SUMMARY_COUNT": "",
            "COMMENT_NODE_IDS": "",
            "ROUND_ORDINAL": "",
            "CONFIG_RESOLUTION": "",
            "FALLBACK_REASON": "",
        }
    )
    if ret != 0 or not isinstance(payload, dict):
        fails.append(f"telemetry empty verdict fields: step failed or returned invalid JSON")
        print("  FAIL  telemetry empty verdict fields")
    else:
        null_fields = ["verdict_kind", "verdict_text", "inline_count", "summary_count", "comment_node_ids", "round_ordinal", "config_resolution", "fallback_reason"]
        bad = [f for f in null_fields if payload.get(f) is not None]
        if bad:
            fails.append(f"telemetry empty verdict fields: expected null for {bad}, got {[payload[f] for f in bad]}")
            print(f"  FAIL  telemetry empty verdict fields: non-null values for {bad}")
        else:
            print("  ok    telemetry empty verdict fields: empty inputs yield JSON null")

    # -------------------------------------------------------------
    # 3. Attacker PR title injection test
    # -------------------------------------------------------------
    malicious_title = 'feat: inject"; $(echo INJECTED_CODE > /tmp/pwned_marker); `echo PWNED`; echo "x'
    pwn_marker = pathlib.Path("/tmp/pwned_marker")
    if pwn_marker.exists():
        pwn_marker.unlink()

    ret, payload, stdout, stderr = run_telemetry_post_step(
        telemetry_script,
        env_overrides={"PR_TITLE": malicious_title}
    )
    if pwn_marker.exists():
        pwn_marker.unlink()
        fails.append("telemetry injection: code execution occurred from pr_title!")
        print("  FAIL  telemetry pr_title injection: attacker code executed")
    elif ret != 0 or not isinstance(payload, dict):
        fails.append(f"telemetry injection: step exited {ret}: {stderr}")
        print("  FAIL  telemetry pr_title injection: execution failed")
    elif payload.get("pr_title") != malicious_title:
        fails.append(f"telemetry injection: pr_title was corrupted: {payload.get('pr_title')!r}")
        print("  FAIL  telemetry pr_title injection: title corrupted")
    else:
        print("  ok    telemetry injection: attacker-controlled pr_title survives verbatim without execution")

    # -------------------------------------------------------------
    # 4. Ingest non-2xx and curl error never fail the step
    # -------------------------------------------------------------
    ret, _, stdout, stderr = run_telemetry_post_step(telemetry_script, curl_code="500")
    if ret != 0:
        fails.append(f"telemetry HTTP 500: expected exit 0, got {ret}")
        print(f"  FAIL  telemetry HTTP 500 returned non-zero ({ret})")
    else:
        print("  ok    telemetry HTTP 500: warns and exits 0")

    ret, _, stdout, stderr = run_telemetry_post_step(telemetry_script, curl_fail=True)
    if ret != 0:
        fails.append(f"telemetry curl network fail: expected exit 0, got {ret}")
        print(f"  FAIL  telemetry curl network fail returned non-zero ({ret})")
    else:
        print("  ok    telemetry curl network failure: warns and exits 0")

    ret, _, stdout, stderr = run_telemetry_post_step(telemetry_script, env_overrides={"INGEST_URL": "http://insecure.url"})
    if ret != 0:
        fails.append(f"telemetry non-https INGEST_URL: expected exit 0, got {ret}")
        print(f"  FAIL  telemetry non-https INGEST_URL returned non-zero ({ret})")
    else:
        print("  ok    telemetry non-https INGEST_URL: warns and exits 0")

    # -------------------------------------------------------------
    # 5. Announce verdict_kind 8-branch mapping test
    # -------------------------------------------------------------
    announce_cases = [
        ("paused skip", {"SKIP_REASON": "paused"}, "auto-paused"),
        ("no-token skip", {"SKIP_REASON": "no-token"}, "no-token"),
        ("no-new-commits skip", {"SKIP_REASON": "no-new-commits"}, "no-new-commits"),
        ("verify rechecked", {"MODE": "verify"}, "verify-rechecked", {"fake_verify_summary": '{"id": 1}'}),
        ("verify silent", {"MODE": "verify"}, "verify-silent", {"fake_verify_summary": ""}),
        ("reviewed full", {"MODE": "review"}, "reviewed", {"fake_inline_json": [{"node_id": "PRRC_1", "user": {"login": "claude[bot]"}, "original_commit_id": "1234567890abcdef1234567890abcdef12345678"}]}),
        ("reviewed incremental", {"MODE": "incremental", "RANGE_BASE": "0000000000000000000000000000000000000000"}, "reviewed-incremental", {"fake_inline_json": [{"node_id": "PRRC_2", "user": {"login": "claude[bot]"}, "original_commit_id": "1234567890abcdef1234567890abcdef12345678"}]}),
        ("reviewed silent", {"MODE": "review"}, "silent", {"fake_inline_json": [], "fake_summary_json": []}),
    ]
    for case_name, env_over, want_verdict, *rest in announce_cases:
        kw = rest[0] if rest else {}
        ret, outputs, stdout, stderr = run_announce_step(announce_script, env_overrides=env_over, **kw)
        got_verdict = outputs.get("verdict_kind")
        if ret != 0:
            fails.append(f"announce {case_name}: exited {ret}: {stderr}")
            print(f"  FAIL  announce {case_name}: exit {ret}")
        elif got_verdict != want_verdict:
            fails.append(f"announce {case_name}: got verdict_kind={got_verdict!r}, want {want_verdict!r}")
            print(f"  FAIL  announce {case_name}: verdict_kind={got_verdict!r} != {want_verdict!r}")
        else:
            print(f"  ok    announce {case_name}: verdict_kind={got_verdict}")

    # Announce skipped-author early exit produces empty outputs
    ret, outputs, stdout, stderr = run_announce_step(announce_script, env_overrides={"SKIP_REASON": "skipped-author"})
    if ret != 0:
        fails.append(f"announce skipped-author: exited {ret}")
        print(f"  FAIL  announce skipped-author exited {ret}")
    elif outputs.get("verdict_kind") is not None:
        fails.append(f"announce skipped-author: expected no verdict_kind, got {outputs.get('verdict_kind')!r}")
        print(f"  FAIL  announce skipped-author produced outputs: {outputs}")
    else:
        print("  ok    announce skipped-author: exits early with empty outputs")

    # -------------------------------------------------------------
    # 6. Resolve PR metadata extraction & heredoc safety test
    # -------------------------------------------------------------
    pr_test_obj = {
        "title": "PR with \"quotes\", \nnewline, and $(id) `whoami`",
        "user": {"login": "attacker"},
        "state": "open",
        "base": {"ref": "release/1.0", "sha": "aaaa"},
        "head": {"ref": "feature/hack\"; rm -rf /", "sha": "bbbb", "repo": {"full_name": "prismalens/test-repo"}},
        "draft": False,
        "changed_files": 5,
        "additions": 20,
        "deletions": 10,
    }
    ret, outputs, stdout, stderr = run_resolve_step(resolve_script, pr_json_obj=pr_test_obj)
    if ret != 0:
        fails.append(f"resolve step: exited {ret}: {stderr}")
        print(f"  FAIL  resolve step exited {ret}")
    elif outputs.get("pr_title") != pr_test_obj["title"]:
        fails.append(f"resolve step: pr_title corrupted: got {outputs.get('pr_title')!r}")
        print(f"  FAIL  resolve step pr_title corrupted")
    elif outputs.get("pr_head_ref") != pr_test_obj["head"]["ref"]:
        fails.append(f"resolve step: pr_head_ref corrupted: got {outputs.get('pr_head_ref')!r}")
        print(f"  FAIL  resolve step pr_head_ref corrupted")
    elif outputs.get("pr_author") != "attacker" or outputs.get("pr_state") != "open" or outputs.get("pr_base_ref") != "release/1.0":
        fails.append(f"resolve step: PR metadata mismatch: {outputs}")
        print(f"  FAIL  resolve step metadata mismatch: {outputs}")
    else:
        print("  ok    resolve step: extracts all PR metadata safely with heredoc delimiter")

    # -------------------------------------------------------------
    # 7. Lane Event Step: reasons and payloads
    # -------------------------------------------------------------
    lane_event_cases = [
        ("no-token", {"SKIP_REASON": "no-token", "IS_FORK": "false"}, "no-token", None),
        ("auto-paused", {"SKIP_REASON": "paused", "ROUND_ORDINAL": "5", "IS_FORK": "false"}, "auto-paused", 5),
        ("skip-author", {"SKIP_REASON": "skipped-author", "IS_FORK": "false"}, "skip-author", None),
        ("fork-head (summon)", {"SKIP_REASON": "", "IS_FORK": "true", "INGEST_TOKEN": "valid-token"}, "fork-head", None),
    ]
    for case_name, env_over, want_reason, want_rounds in lane_event_cases:
        ret, payload, stdout, stderr = run_lane_event_step(lane_event_script, env_overrides=env_over)
        if ret != 0:
            fails.append(f"lane-event {case_name}: exited {ret}: {stderr}")
            print(f"  FAIL  lane-event {case_name}: exit {ret}")
        elif not isinstance(payload, dict):
            fails.append(f"lane-event {case_name}: captured body is not dict: {payload}")
            print(f"  FAIL  lane-event {case_name}: invalid payload")
        else:
            if payload.get("event_kind") != "lane_event":
                fails.append(f"lane-event {case_name}: event_kind = {payload.get('event_kind')!r}")
            if payload.get("reason") != want_reason:
                fails.append(f"lane-event {case_name}: reason = {payload.get('reason')!r}, want {want_reason!r}")
            if payload.get("rounds_used") != want_rounds:
                fails.append(f"lane-event {case_name}: rounds_used = {payload.get('rounds_used')!r}, want {want_rounds!r}")
            if payload.get("lane_version") != "2":
                fails.append(f"lane-event {case_name}: lane_version = {payload.get('lane_version')!r}")
            if not isinstance(payload.get("run_id"), int) or not isinstance(payload.get("run_attempt"), int):
                fails.append(f"lane-event {case_name}: run_id/run_attempt not int")
            print(f"  ok    lane-event {case_name}: posts event_kind=lane_event reason={want_reason}")

    # Fork PR run with empty token exits 0 with warning without posting
    ret, payload, stdout, stderr = run_lane_event_step(
        lane_event_script,
        env_overrides={"IS_FORK": "true", "INGEST_TOKEN": ""}
    )
    if ret != 0:
        fails.append(f"lane-event fork empty token: expected exit 0, got {ret}")
        print(f"  FAIL  lane-event fork empty token exited {ret}")
    elif payload is not None:
        fails.append(f"lane-event fork empty token: unexpectedly attempted to POST: {payload}")
        print(f"  FAIL  lane-event fork empty token posted payload")
    elif "REVIEW_TELEMETRY_TOKEN is empty" not in stdout and "REVIEW_TELEMETRY_TOKEN is empty" not in stderr:
        fails.append(f"lane-event fork empty token: did not emit expected warning message")
        print(f"  FAIL  lane-event fork empty token did not warn")
    else:
        print("  ok    lane-event fork PR with empty token: warns and exits 0 without posting")

    # Lane event HTTP 500 exit 0
    ret, _, stdout, stderr = run_lane_event_step(lane_event_script, curl_code="500")
    if ret != 0:
        fails.append(f"lane-event HTTP 500: expected exit 0, got {ret}")
        print(f"  FAIL  lane-event HTTP 500 exited {ret}")
    else:
        print("  ok    lane-event HTTP 500: warns and exits 0")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)

    print("all telemetry record and lane event tests passed")


if __name__ == "__main__":
    main()
