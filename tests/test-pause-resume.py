#!/usr/bin/env python3
"""Behavioural tests for @claude pause and @claude resume verbs (#124).

Extracts REAL shell bodies out of claude-code-review.yml and runs them against fixtures, verifying:
1. @claude pause sets paused state (emits skip with reason paused-by-request).
2. While paused, an automatic round skips with reason paused-by-request.
3. @claude review and @claude resume still run while paused and clear paused=1.
4. Liveness verdict formatting: "paused by request at <sha>; resume with @claude resume".
5. Liveness marker persists paused=1 on push, and clears it on explicit summon.
6. Lane event payload carries reason "paused-by-request".
7. Admission requirement: non-member comment is refused by admission gate.
8. paused_by (#124) is read from ACTOR_LOGIN (the event payload), not the comment body,
   and lands in the marker and the lane event's actor field.
9. A second @claude pause on an already-paused PR does not overwrite the recorded actor.
10. @claude resume clears both paused=1 and paused_by from the marker.

Run: python3 tests/test-pause-resume.py
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

OLD = "a" * 40
NEW = "b" * 40


def cleanup_tmp():
    for name in ["incremental-range.json", "claude-path-filters-result.json", "unresolved-claude-threads.json"]:
        p = pathlib.Path(f"/tmp/{name}")
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass


def extract_step_script(job_name: str, step_name: str) -> str:
    wf = yaml.safe_load(WF.read_text())
    job = wf["jobs"].get(job_name)
    if not job:
        sys.exit(f"job {job_name!r} not found in {WF}")
    for step in job.get("steps", []) or []:
        if step.get("name") == step_name:
            return step["run"]
    sys.exit(f"step {step_name!r} in job {job_name!r} not found in {WF}")


GH_STUB_MODE = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *claude-review-liveness*) printf '%s' "$FAKE_LIVENESS" ; exit 0 ;;
  *"pulls/"*"/files"*)      printf '[]' ; exit 0 ;;
  *graphql*)                printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ; exit 0 ;;
  *"compare/"*)
    printf '{"status":"ahead","files":[{"filename":"src/app.ts","additions":10,"deletions":0}]}'
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""

GH_STUB_ANNOUNCE = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"-X PATCH"*|*"-X POST"*)
    prev=""
    for a in "$@"; do
      case "$prev" in -f) case "$a" in body=*) printf '%s' "${a#body=}" > "$CAPTURE";; esac;; esac
      prev="$a"
    done
    exit 0 ;;
  *claude-review-liveness*)   printf '%s' "$FAKE_MARKER" ; exit 0 ;;
  *"pulls/"*)                 printf '0' ; exit 0 ;;
  *"## Code review"*)         printf '[]' ; exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""

CURL_STUB = r"""#!/usr/bin/env bash
args="$*"
body=""
if [[ "$args" == *"--data-binary @-"* ]]; then
  body="$(cat)"
fi
if [ -n "$CAPTURE_BODY" ]; then
  printf '%s' "$body" > "$CAPTURE_BODY"
fi
code="${CURL_HTTP_CODE:-204}"
if [[ "$args" == *"%{http_code}"* ]]; then
  printf '%s' "$code"
fi
exit 0
"""


def run_mode_step(script, *, event="pull_request", summon="none", fake_liveness="", head_sha=NEW):
    cleanup_tmp()
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = pathlib.Path(td)
            binp = tdp / "bin"
            binp.mkdir()
            (binp / "gh").write_text(GH_STUB_MODE)
            (binp / "gh").chmod(0o755)

            out_file = tdp / "output.txt"
            out_file.touch()

            env = dict(os.environ)
            env.update(
                PATH=f"{binp}:{env.get('PATH', '')}",
                GITHUB_OUTPUT=str(out_file),
                GH_TOKEN="fake-token",
                REPO="prismalens/test-repo",
                PR="124",
                HEAD_SHA=head_sha,
                EVENT_NAME=event,
                SUMMON=summon,
                MAX_ROUNDS="5",
                SKIP_AUTHORS="dependabot[bot]",
                PR_AUTHOR="alice",
                DIFF_LINES="100",
                MIN_DIFF_LINES="0",
                DEBOUNCE_MINUTES="0",
                HAS_TOKEN="true",
                FAKE_LIVENESS=fake_liveness,
            )

            p = subprocess.run(["bash", "-c", script], env=env,
                               capture_output=True, text=True)

            outputs = {}
            if out_file.exists():
                for line in out_file.read_text().splitlines():
                    if "=" in line:
                        k, v = line.split("=", 1)
                        outputs[k] = v

            return p.returncode, outputs, p.stdout + p.stderr
    finally:
        cleanup_tmp()


def run_announce_step(script, *, marker_body=None, skip_reason="", event="pull_request",
                      mode="review", result="success", head_sha=NEW, actor_login=""):
    cleanup_tmp()
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = pathlib.Path(td)
            binp = tdp / "bin"
            binp.mkdir()
            (binp / "gh").write_text(GH_STUB_ANNOUNCE)
            (binp / "gh").chmod(0o755)

            capture = tdp / "body.txt"
            out_file = tdp / "output.txt"
            out_file.touch()

            marker_json = ""
            if marker_body is not None:
                marker_json = json.dumps({"id": 12345, "body": marker_body})

            env = dict(os.environ)
            env.update(
                PATH=f"{binp}:{env.get('PATH', '')}",
                GITHUB_OUTPUT=str(out_file),
                CAPTURE=str(capture),
                FAKE_MARKER=marker_json,
                GH_TOKEN="fake-token",
                REPO="prismalens/test-repo",
                PR="124",
                HEAD_SHA=head_sha,
                EVENT_NAME=event,
                MODE=mode,
                SKIP_REASON=skip_reason,
                REVIEW_RESULT=result,
                MUTATE_RESULT="skipped",
                RESOLVED="0",
                OPEN="0",
                UNVERIFIED="0",
                STARTED_AT="2026-01-01T00:00:00Z",
                RANGE_BASE="",
                RANGE_HEAD="",
                MODEL="claude-sonnet-5",
                MODEL_SOURCE="default",
                RUN_URL="https://github.com/prismalens/test-repo/actions/runs/124",
                ACTOR_LOGIN=actor_login,
            )

            p = subprocess.run(["bash", "-c", script], env=env,
                               capture_output=True, text=True)

            captured_comment = ""
            if capture.exists():
                captured_comment = capture.read_text()

            outputs = {}
            if out_file.exists():
                for line in out_file.read_text().splitlines():
                    if "=" in line:
                        k, v = line.split("=", 1)
                        outputs[k] = v

            return p.returncode, captured_comment, outputs, p.stdout + p.stderr
    finally:
        cleanup_tmp()


def run_lane_event_step(script, *, skip_reason="", actor=""):
    cleanup_tmp()
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = pathlib.Path(td)
            binp = tdp / "bin"
            binp.mkdir()
            (binp / "curl").write_text(CURL_STUB)
            (binp / "curl").chmod(0o755)

            capture = tdp / "captured_lane_event.json"

            env = dict(os.environ)
            env.update(
                PATH=f"{binp}:{env.get('PATH', '')}",
                CAPTURE_BODY=str(capture),
                IS_FORK="false",
                SKIP_REASON=skip_reason,
                ROUND_ORDINAL="2",
                REPO="prismalens/test-repo",
                PR_NUMBER="124",
                HEAD_SHA=NEW,
                RUN_ID="999",
                RUN_ATTEMPT="1",
                RUN_URL="https://github.com/prismalens/test-repo/actions/runs/999",
                INGEST_URL="https://telemetry.prismalens.dev/ingest",
                INGEST_TOKEN="secret-token-xyz",
                LANE_VERSION="2",
                ACTOR=actor,
            )

            p = subprocess.run(["bash", "-c", script], env=env,
                               capture_output=True, text=True)

            payload = None
            if capture.exists() and capture.read_text().strip():
                try:
                    payload = json.loads(capture.read_text())
                except Exception as e:
                    payload = f"MALFORMED_JSON: {e}"

            return p.returncode, payload, p.stdout + p.stderr
    finally:
        cleanup_tmp()


def main():
    wf_text = WF.read_text()
    wf_yaml = yaml.safe_load(wf_text)

    mode_script = extract_step_script("review", "Detect verification mode")
    announce_script = extract_step_script("announce", "Upsert liveness comment")
    lane_event_script = extract_step_script("lane-event", "Record lane event")
    fails = []

    print("=== Testing @claude pause and @claude resume (#124) ===\n")

    # -------------------------------------------------------------
    # 1. Admission check: non-member comment is refused before review
    # -------------------------------------------------------------
    # Verify resolve job triggers require admission and summon step gates on steps.admit
    resolve_job = wf_yaml["jobs"]["resolve"]
    resolve_steps = resolve_job.get("steps", [])
    admit_step = next((s for s in resolve_steps if s.get("id") == "admit"), None)
    summon_step = next((s for s in resolve_steps if s.get("id") == "summon"), None)
    review_job = wf_yaml["jobs"]["review"]

    if not admit_step or "prismalens/gh-workflows/.github/actions/admit" not in admit_step.get("uses", ""):
        fails.append("admission: admit step missing or does not use live collaborators admit action")
    if not summon_step or "steps.admit.outputs.admitted == 'true'" not in summon_step.get("if", ""):
        fails.append("admission: summon step does not gate on steps.admit.outputs.admitted == 'true'")
    if "needs.resolve.outputs.admitted == 'true'" not in review_job.get("if", ""):
        fails.append("admission: review job does not require needs.resolve.outputs.admitted == 'true'")
    # Verify comment body stays inside contains()
    summon_env = summon_step.get("env", {}).get("SUMMON", "")
    if "contains(github.event.comment.body, '@claude pause')" not in summon_env:
        fails.append("admission: @claude pause not checked via contains() in Classify summon verb")
    if "contains(github.event.comment.body, '@claude resume')" not in summon_env:
        fails.append("admission: @claude resume not checked via contains() in Classify summon verb")
    print("  ok    admission gate: non-member comment refused; comment body stays in contains()")

    # -------------------------------------------------------------
    # 2. @claude pause summon skips review with reason paused-by-request
    # -------------------------------------------------------------
    rc, outs, err = run_mode_step(mode_script, event="issue_comment", summon="pause")
    if rc != 0:
        fails.append(f"case 2: mode step exited {rc}: {err}")
    elif outs.get("mode") != "skip" or outs.get("skip_reason") != "paused-by-request":
        fails.append(f"case 2: want mode=skip skip_reason=paused-by-request, got {outs}")
    else:
        print("  ok    @claude pause summon resolves to skip with reason paused-by-request")

    # -------------------------------------------------------------
    # 3. Paused PR skips automatic round with reason paused-by-request
    # -------------------------------------------------------------
    paused_marker = f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 -->"
    rc, outs, err = run_mode_step(mode_script, event="pull_request", fake_liveness=paused_marker)
    if rc != 0:
        fails.append(f"case 3: mode step exited {rc}: {err}")
    elif outs.get("mode") != "skip" or outs.get("skip_reason") != "paused-by-request":
        fails.append(f"case 3: want mode=skip skip_reason=paused-by-request, got {outs}")
    else:
        print("  ok    paused PR skips automatic round with reason paused-by-request")

    # -------------------------------------------------------------
    # 4. @claude review and @claude resume still run while paused
    # -------------------------------------------------------------
    # Explicit summon bypasses pause and proceeds to review
    rc, outs, err = run_mode_step(mode_script, event="issue_comment", summon="incremental", fake_liveness=paused_marker)
    if rc != 0:
        fails.append(f"case 4a: @claude review exited {rc}: {err}")
    elif outs.get("skip_reason") == "paused-by-request":
        fails.append(f"case 4a: @claude review was blocked by pause: {outs}")
    else:
        print("  ok    @claude review runs while paused (bypasses pause check)")

    rc, outs, err = run_mode_step(mode_script, event="issue_comment", summon="resume", fake_liveness=paused_marker)
    if rc != 0:
        fails.append(f"case 4b: @claude resume exited {rc}: {err}")
    elif outs.get("skip_reason") == "paused-by-request":
        fails.append(f"case 4b: @claude resume was blocked by pause: {outs}")
    else:
        print("  ok    @claude resume runs while paused (bypasses pause check)")

    # -------------------------------------------------------------
    # 5. Liveness verdict formatting and marker for paused-by-request
    # -------------------------------------------------------------
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
        skip_reason="paused-by-request",
        event="issue_comment",
        head_sha=NEW,
    )
    short_sha = NEW[:8]
    want_verdict = f"paused by request at `{short_sha}`; resume with `@claude resume`."
    if rc != 0:
        fails.append(f"case 5: announce exited {rc}: {err}")
    elif outs.get("verdict_kind") != "paused-by-request":
        fails.append(f"case 5: want verdict_kind=paused-by-request, got {outs.get('verdict_kind')!r}")
    elif want_verdict not in body:
        fails.append(f"case 5: expected verdict {want_verdict!r} not in body: {body!r}")
    elif "paused=1" not in body.splitlines()[0]:
        fails.append(f"case 5: paused=1 missing from marker: {body.splitlines()[0] if body else ''}")
    else:
        print(f"  ok    liveness verdict formatted: {want_verdict}")
        print("  ok    liveness marker includes paused=1 flag")

    # -------------------------------------------------------------
    # 6. Push to paused PR persists paused=1; summon clears paused=1
    # -------------------------------------------------------------
    # Push to paused PR: marker continues to carry paused=1
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 -->",
        skip_reason="paused-by-request",
        event="pull_request",
        head_sha=NEW,
    )
    if rc != 0 or "paused=1" not in body.splitlines()[0]:
        fails.append(f"case 6a: push to paused PR lost paused=1 flag: {body}")
    else:
        print("  ok    paused state survives push (marker keeps paused=1)")

    # Explicit summon review clears paused=1
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 -->",
        skip_reason="",  # Review ran successfully
        event="issue_comment",
        mode="review",
        result="success",
        head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 6b: announce summon exited {rc}: {err}")
    elif "paused=1" in body.splitlines()[0]:
        fails.append(f"case 6b: explicit summon did not clear paused=1: {body.splitlines()[0]}")
    else:
        print("  ok    explicit summon clears paused=1 on liveness marker")

    # -------------------------------------------------------------
    # 7. Lane Event emission: records paused-by-request
    # -------------------------------------------------------------
    rc, payload, err = run_lane_event_step(lane_event_script, skip_reason="paused-by-request")
    if rc != 0:
        fails.append(f"case 7: lane-event exited {rc}: {err}")
    elif not isinstance(payload, dict):
        fails.append(f"case 7: payload not dict: {payload}")
    else:
        if payload.get("event_kind") != "lane_event":
            fails.append(f"case 7: want event_kind=lane_event, got {payload.get('event_kind')!r}")
        if payload.get("reason") != "paused-by-request":
            fails.append(f"case 7: want reason=paused-by-request, got {payload.get('reason')!r}")
        print("  ok    lane_event row emitted with reason paused-by-request")

    # -------------------------------------------------------------
    # 8. A fresh pause records the actor from ACTOR_LOGIN (event payload), not the body
    # -------------------------------------------------------------
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",  # not yet paused
        skip_reason="paused-by-request",
        event="issue_comment",
        head_sha=NEW,
        actor_login="alice",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 8: announce exited {rc}: {err}")
    elif outs.get("paused_by") != "alice":
        fails.append(f"case 8: want output paused_by=alice, got {outs.get('paused_by')!r}")
    elif "paused_by=alice" not in marker_line:
        fails.append(f"case 8: paused_by=alice missing from marker: {marker_line!r}")
    else:
        print("  ok    fresh pause records paused_by from ACTOR_LOGIN (event payload, never the body)")

    # -------------------------------------------------------------
    # 9. A second @claude pause on an already-paused PR keeps the original actor
    # -------------------------------------------------------------
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->",
        skip_reason="paused-by-request",
        event="issue_comment",
        head_sha=NEW,
        actor_login="mallory",  # a different commenter re-pausing an already-paused PR
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 9: announce exited {rc}: {err}")
    elif outs.get("paused_by") != "alice":
        fails.append(f"case 9: second pause overwrote the actor: want alice, got {outs.get('paused_by')!r}")
    elif "paused_by=mallory" in marker_line:
        fails.append(f"case 9: second pause wrote the new commenter into the marker: {marker_line!r}")
    else:
        print("  ok    second @claude pause on an already-paused PR is a no-op on the actor")

    # A push while already paused (no comment, so no ACTOR_LOGIN) also keeps the actor.
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->",
        skip_reason="paused-by-request",
        event="pull_request",
        head_sha=NEW,
        actor_login="",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0 or "paused_by=alice" not in marker_line:
        fails.append(f"case 9b: push to already-paused PR lost the actor: {marker_line!r}")
    else:
        print("  ok    push to an already-paused PR keeps paused_by across the push")

    # -------------------------------------------------------------
    # 10. @claude resume clears both paused=1 and paused_by from the marker
    # -------------------------------------------------------------
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->",
        skip_reason="",  # review ran successfully
        event="issue_comment",
        mode="review",
        result="success",
        head_sha=NEW,
        actor_login="alice",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 10: announce exited {rc}: {err}")
    elif "paused=1" in marker_line or "paused_by=" in marker_line:
        fails.append(f"case 10: resume did not clear paused=1/paused_by: {marker_line!r}")
    elif outs.get("paused_by", "") != "":
        fails.append(f"case 10: resume left a non-empty paused_by output: {outs.get('paused_by')!r}")
    else:
        print("  ok    @claude resume clears both paused=1 and paused_by from the marker")

    # -------------------------------------------------------------
    # 11. Lane event carries the actor on a paused-by-request skip
    # -------------------------------------------------------------
    rc, payload, err = run_lane_event_step(lane_event_script, skip_reason="paused-by-request", actor="alice")
    if rc != 0:
        fails.append(f"case 11: lane-event exited {rc}: {err}")
    elif not isinstance(payload, dict):
        fails.append(f"case 11: payload not dict: {payload}")
    elif payload.get("actor") != "alice":
        fails.append(f"case 11: want actor=alice, got {payload.get('actor')!r}")
    else:
        print("  ok    lane_event row carries actor=alice on a paused-by-request skip")

    # An unrelated skip reason (no announce-side pause) carries no actor at all.
    rc, payload, err = run_lane_event_step(lane_event_script, skip_reason="skipped-author", actor="")
    if rc != 0:
        fails.append(f"case 11b: lane-event exited {rc}: {err}")
    elif not isinstance(payload, dict):
        fails.append(f"case 11b: payload not dict: {payload}")
    elif payload.get("actor") is not None:
        fails.append(f"case 11b: want actor=null on skip-author, got {payload.get('actor')!r}")
    else:
        print("  ok    lane_event row carries actor=null on a non-pause skip")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
