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
11. The #149 withhold guard never swallows a pause or resume state transition: on a head a
    review already reported on, the marker is still written and the standing verdict carried.
12. A verb-less in-thread reply (summon=reply, #178) emits verify when claude[bot] threads
    are open and skips as reply-no-threads when none are, leaving the marker untouched, and
    a reply-triggered verify round carries paused=1 and paused_by forward rather than
    clearing them.
13. `admission: off` (#189) refuses the automatic round, every summon and every reply as
    admission-off; announce posts nothing and the lane event records admission-off.
14. The claude_review_skip label refuses everything as skip-label under any admission,
    and its verdict carries the pause marker forward unchanged.
15. `admission: label` without claude_review refuses everything as awaiting-label, and
    with the label the round is admitted.
16. `resolve` reads both labels as booleans only, gates label events to the two labels,
    and scripts/setup-repo.sh creates both.

A pause is the COMMENT layer and is therefore soft: it stops the automatic round, and
`incremental`, `full` and `resume` all lift it. A stop is `admission: off` or the skip
label, never a comment, because the comment layer is per-round and ephemeral, so a
comment-driven stop is liftable by the next comment. #191 briefly made pause refuse every
non-`resume` summon; that is reverted, and cases 4a, 4c, 6b and 14a pin the revert. The
half of #191 that stands is the marker persistence in case 14 and the carry-forward in
6a/6c: a pause must never be ERASED by a push or a reply. Ruling: #189. The stops
themselves are cases 15-18: `admission: off` and the skip label refuse summons too.

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
# A head past the one the marker records, so the reader is deciding about new commits.
MOVED_HEAD = "c" * 40


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
  *graphql*)                printf '%s\n' "${FAKE_THREADS:-[]}" ; exit 0 ;;
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


def run_mode_step(script, *, event="pull_request", summon="none", fake_liveness="", head_sha=NEW, fake_threads="[]",
                  extra_env=None):
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
                HAS_OAUTH="true",
                HAS_API_KEY="false",
                FAKE_LIVENESS=fake_liveness,
                FAKE_THREADS=fake_threads,
            )
            if extra_env:
                env.update(extra_env)

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
                      mode="review", result="success", head_sha=NEW, actor_login="",
                      draft="false", summon=None):
    if summon is None:
        if event == "issue_comment":
            summon = "incremental"
        elif event == "pull_request_review_comment":
            summon = "reply"
        else:
            summon = "none"
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
                DRAFT=draft,
                SUMMON=summon,
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


GH_STUB_PR = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"pulls?state=open"*) printf '' ; exit 0 ;;
  *"pulls/"*)           printf '%s' "$FAKE_PR" ; exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_pr_step(script, *, pr_json):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB_PR)
        (binp / "gh").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()
        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env.get('PATH', '')}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="fake-token",
            PR_NUMBER="124",
            EVENT_NAME="pull_request",
            GITHUB_REPOSITORY="prismalens/test-repo",
            LABEL_OPT_IN="claude_review",
            LABEL_SKIP="claude_review_skip",
            FAKE_PR=json.dumps(pr_json),
        )
        p = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs.setdefault(k, v)
        return p.returncode, outputs, p.stdout + p.stderr


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
    if "'reply'" not in summon_env:
        fails.append("admission: 'reply' literal missing from Classify summon verb (#178)")
    if "contains(github.event.comment.body, '@claude review') && 'incremental'" not in summon_env:
        fails.append("admission: incremental not gated by contains(@claude review) in Classify summon verb (#178)")
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
    # A pause is the COMMENT layer and therefore soft (#189): it stops the AUTOMATIC round
    # (case 3 above) and any summon lifts it. #191 briefly refused summons here, which made
    # the comment layer a stop; a stop is `admission: off` or the skip label, never a
    # comment. These two cases pin the revert from the read side.
    rc, outs, err = run_mode_step(mode_script, event="issue_comment", summon="incremental", fake_liveness=paused_marker)
    if rc != 0:
        fails.append(f"case 4a: @claude review exited {rc}: {err}")
    elif outs.get("skip_reason") == "paused-by-request":
        fails.append(f"case 4a: @claude review was refused by a pause, which is a stop not a pause: {outs}")
    else:
        print("  ok    @claude review runs while paused, and lifts it (#189)")

    # A verb-less reply carries summon=reply (#178) and is not refused by the pause either.
    # It does not CLEAR the pause: the marker carry-forward is the write side, asserted in
    # case 6c, and the full reply semantics (verify vs reply-no-threads) in case 13.
    rc, outs, err = run_mode_step(mode_script, event="pull_request_review_comment", summon="reply", fake_liveness=paused_marker, fake_threads='[{"id":"T_1"}]')
    if rc != 0:
        fails.append(f"case 4c: reply exited {rc}: {err}")
    elif outs.get("skip_reason") == "paused-by-request":
        fails.append(f"case 4c: a reply was refused by a pause: {outs}")
    else:
        print("  ok    an in-thread reply is not refused by a pause (#178)")

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

    # Every summon clears the marker, not `@claude resume` alone: `incremental`, `full` and
    # `resume` all lift a pause, because a pause is the comment layer (#189). A PUSH and a
    # verb-less reply carry it forward instead — cases 6a and 6c.
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 -->",
        skip_reason="",  # as if the round had run to completion
        event="issue_comment",
        mode="review",
        result="success",
        head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 6b: announce summon exited {rc}: {err}")
    elif "paused=1" in body.splitlines()[0]:
        fails.append(f"case 6b: a summon did not lift the pause, so the pause is acting as a stop: {body.splitlines()[0]}")
    else:
        print("  ok    a summon lifts the pause (#189)")

    # The second half of the reported bug: the carry-forward branch was gated on
    # `EVENT_NAME = pull_request`, so a reply reached none of the branches, `is_paused`
    # stayed 0 and the marker was rewritten WITHOUT paused=1 -- the pause was erased, not
    # merely bypassed, and every later push ran normally. `skip_reason` is empty here on
    # purpose: the carry-forward must hold on its own, not as a side effect of exiting
    # through `paused-by-request`.
    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->",
        skip_reason="",
        event="pull_request_review_comment",
        mode="verify",
        result="success",
        head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 6c: announce reply exited {rc}: {err}")
    elif "paused=1" not in body.splitlines()[0]:
        fails.append(f"case 6c: an in-thread reply erased the pause: {body.splitlines()[0]}")
    elif "paused_by=alice" not in body.splitlines()[0]:
        fails.append(f"case 6c: an in-thread reply lost paused_by: {body.splitlines()[0]}")
    else:
        print("  ok    an in-thread reply carries paused=1 and paused_by forward")

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
    elif "paused_by=alice" not in marker_line:
        fails.append(f"case 9: second pause did not retain alice in the marker: {marker_line!r}")
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
        # The resume verb is what lifts the pause, and the announce step reads it from
        # `summon`, never from the comment body (#124). Without it this case would be an
        # ordinary summon, which now carries the pause forward.
        summon="resume",
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

    # -------------------------------------------------------------
    # 12. A pause on a draft is recorded, and stops the ready_for_review round
    # -------------------------------------------------------------
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=None, event="issue_comment", mode="",
        result="skipped", draft="true", summon="pause", actor_login="alice",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 12: announce exited {rc}: {err}")
    elif "paused=1" not in marker_line or "paused_by=alice" not in marker_line:
        fails.append(f"case 12: draft pause did not write paused=1 paused_by=alice: {marker_line!r}")
    elif outs.get("verdict_kind") != "paused-by-request":
        fails.append(f"case 12: draft pause verdict_kind: want paused-by-request, got {outs.get('verdict_kind')!r}")
    else:
        rc2, mouts, err2 = run_mode_step(mode_script, event="pull_request", fake_liveness=marker_line)
        if mouts.get("skip_reason") != "paused-by-request":
            fails.append(f"case 12: ready round after a draft pause did not skip: {mouts!r} {err2}")
        else:
            print("  ok    @claude pause on a draft is recorded and skips the ready_for_review round")

    paused_marker = f"<!-- claude-review-liveness rounds=0 paused=1 paused_by=alice -->"
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_marker, event="issue_comment", mode="",
        result="skipped", draft="true", summon="resume", actor_login="alice",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0 or "paused=1" in marker_line:
        fails.append(f"case 12b: resume on a draft did not clear the pause: {marker_line!r} {err}")
    else:
        print("  ok    @claude resume on a draft clears the pause")

    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_marker, event="issue_comment", mode="",
        result="skipped", draft="true", summon="review", actor_login="bob",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0 or "paused=1 paused_by=alice" not in marker_line:
        fails.append(f"case 12c: @claude review on a draft dropped the pause: {marker_line!r} {err}")
    elif outs.get("verdict_kind") != "draft":
        fails.append(f"case 12c: want draft verdict, got {outs.get('verdict_kind')!r}")
    else:
        print("  ok    @claude review on a draft reviews nothing and keeps the pause")

    # -------------------------------------------------------------
    # 13. An in-thread reply on a paused PR (#178)
    # -------------------------------------------------------------
    # 13a. With no unresolved claude threads: mode skip, skip_reason=reply-no-threads,
    # and announce leaves the marker unchanged.
    paused_marker = f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->"
    rc, outs, err = run_mode_step(
        mode_script,
        event="pull_request_review_comment",
        summon="reply",
        fake_liveness=paused_marker,
        fake_threads="[]",
    )
    if rc != 0:
        fails.append(f"case 13a: mode step exited {rc}: {err}")
    elif outs.get("mode") != "skip" or outs.get("skip_reason") != "reply-no-threads":
        fails.append(f"case 13a: want mode=skip skip_reason=reply-no-threads, got {outs}")
    else:
        print("  ok    paused PR plus reply with no open claude threads emits skip reply-no-threads (#178)")

    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=paused_marker,
        event="pull_request_review_comment",
        summon="reply",
        skip_reason="reply-no-threads",
        head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 13a announce: exited {rc}: {err}")
    elif body:
        fails.append(f"case 13a announce: expected no comment upsert (leaves marker unchanged), got {body!r}")
    else:
        print("  ok    announce for reply-no-threads leaves marker untouched (#178)")

    # 13b. With an unresolved claude thread: mode verify, and announce keeps paused=1 paused_by=alice.
    threads_fixture = json.dumps([
        {"thread_id": "T1", "path": "src/app.ts", "root_id": 101, "url": "u1", "body": "b1"}
    ])
    rc, outs, err = run_mode_step(
        mode_script,
        event="pull_request_review_comment",
        summon="reply",
        fake_liveness=paused_marker,
        fake_threads=threads_fixture,
    )
    if rc != 0:
        fails.append(f"case 13b: mode step exited {rc}: {err}")
    elif outs.get("mode") != "verify":
        fails.append(f"case 13b: want mode=verify, got {outs}")
    else:
        print("  ok    paused PR plus reply with open claude thread emits verify (#178)")

    rc, body, outs, err = run_announce_step(
        announce_script,
        marker_body=paused_marker,
        event="pull_request_review_comment",
        summon="reply",
        mode="verify",
        result="success",
        head_sha=NEW,
        actor_login="bob",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 13b announce: exited {rc}: {err}")
    elif "paused=1 paused_by=alice" not in marker_line:
        fails.append(f"case 13b announce: verify round lost paused=1 paused_by=alice: {marker_line!r}")
    elif outs.get("paused_by") != "alice":
        fails.append(f"case 13b announce: want paused_by=alice output, got {outs.get('paused_by')!r}")
    else:
        print("  ok    verify round on paused PR keeps paused=1 and paused_by=alice (#178)")

    # 14. The #149 withhold guard must not swallow a pause state transition
    # -------------------------------------------------------------
    # `sha=` equal to this head means a real review already reported here, and the guard
    # withholds the write so a later no-output round cannot replace that verdict with the
    # absence of one. The marker rides in the same comment, and withholding it dropped the
    # operator's instruction outright: `@claude pause` never wrote paused=1 (every later
    # event ran normally) and `@claude resume` never cleared it (kind `silent`: a resume
    # that finds nothing to review posts nothing). Both directions are asserted here, and
    # the standing verdict must survive both.
    reviewed_here = (
        f"<!-- claude-review-liveness rounds=2 sha={NEW} -->\n"
        "**Claude review lane** — [run](https://x/1): reviewed `bbbbbbbb` and posted 3 inline / 1 summary comment(s)."
    )
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=reviewed_here, skip_reason="paused-by-request",
        event="issue_comment", summon="pause", head_sha=NEW, actor_login="alice",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 14a: announce exited {rc}: {err}")
    elif not body:
        fails.append("case 14a: pause on an already-reviewed head was withheld, so paused=1 was never written")
    elif "paused=1 paused_by=alice" not in marker_line:
        fails.append(f"case 14a: pause on an already-reviewed head lost the state: {marker_line!r}")
    elif "posted 3 inline / 1 summary" not in body:
        fails.append(f"case 14a: the standing review verdict was replaced, not carried: {body!r}")
    elif "_Lane state: paused by @alice" not in body:
        fails.append(f"case 14a: the pause was recorded but never acknowledged to a reader: {body!r}")
    else:
        # The reported symptom was rounds running on a paused PR, so the written comment is
        # fed back to the reader that decides. `head -1` there sees the marker only, which is
        # also why the carried verdict and the state line cannot confuse it.
        # The written marker is fed back to the reader that decides, `head -1` there seeing
        # the marker line only. A pause is the COMMENT layer and therefore soft (#189): the
        # AUTOMATIC round is refused, and a summon lifts it. #191 briefly refused summons
        # too, which made the comment layer a stop; these assertions pin the revert.
        wrong = []
        _, auto, _ = run_mode_step(mode_script, event="pull_request", summon="none",
                                   fake_liveness=body, head_sha=MOVED_HEAD)
        if auto.get("skip_reason") != "paused-by-request":
            wrong.append(f"automatic round ran on a paused PR: {auto.get('skip_reason', '')!r}")
        for verb in ("review", "full", "resume"):
            _, mouts, _ = run_mode_step(mode_script, event="issue_comment",
                                        summon="incremental" if verb == "review" else verb,
                                        fake_liveness=body, head_sha=MOVED_HEAD)
            if mouts.get("skip_reason") == "paused-by-request":
                wrong.append(f"@claude {verb} was refused by a pause, which is a stop not a pause")
        if wrong:
            fails.append("case 14a: " + "; ".join(wrong))
        else:
            print("  ok    a pause on an already-reviewed head is written, and keeps the standing verdict")
            print("  ok    that pause stops the automatic round and every summon still lifts it (#189)")

    paused_here = body
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_here, skip_reason="",
        event="issue_comment", summon="resume", mode="review", result="success",
        head_sha=NEW, actor_login="bob",
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 14b: announce exited {rc}: {err}")
    elif not body:
        fails.append("case 14b: resume on an already-reviewed head was withheld, so the pause could never be lifted")
    elif "paused=" in marker_line:
        fails.append(f"case 14b: resume did not clear the pause: {marker_line!r}")
    elif "posted 3 inline / 1 summary" not in body:
        fails.append(f"case 14b: resume replaced the standing verdict: {body!r}")
    elif "no machine review on record" in body:
        fails.append(f"case 14b: resume asserted no review on a head whose sha= says otherwise: {body!r}")
    elif body.count("_Lane state:") != 1:
        fails.append(f"case 14b: state lines stacked instead of being rebuilt: {body!r}")
    else:
        print("  ok    a resume on an already-reviewed head is written, and stacks no state line")

    # A push while already paused changes nothing the marker does not already say, so the
    # guard still holds: this is the #149 case, and the pause is not at risk.
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_here, skip_reason="trivial",
        event="pull_request", head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 14c: announce exited {rc}: {err}")
    elif body:
        fails.append(f"case 14c: a no-transition skip on an already-reviewed head overwrote the verdict: {body!r}")
    else:
        print("  ok    a skip that changes no pause state is still withheld (#149 holds)")

    # -------------------------------------------------------------
    # 15-18. Admission (#189): `off` and the skip label are stops, `label` delegates
    # admission to the opt-in label alone. Every summon and reply is refused too.
    # -------------------------------------------------------------
    paused_old = f"<!-- claude-review-liveness rounds=2 sha={OLD} paused=1 paused_by=alice -->"
    summon_matrix = [
        ("pull_request", "none", "[]"),
        ("issue_comment", "incremental", "[]"),
        ("issue_comment", "full", "[]"),
        ("issue_comment", "pause", "[]"),
        ("issue_comment", "resume", "[]"),
        ("pull_request_review_comment", "reply", '[{"id":"T_1"}]'),
    ]

    def refused_everywhere(case, extra, want):
        wrong = []
        for ev, verb, threads in summon_matrix:
            rc, outs, err = run_mode_step(mode_script, event=ev, summon=verb,
                                          fake_threads=threads, extra_env=extra)
            if rc != 0 or outs.get("mode") != "skip" or outs.get("skip_reason") != want:
                wrong.append(f"{ev}/{verb}: rc={rc} mode={outs.get('mode')!r} skip_reason={outs.get('skip_reason')!r}")
        if wrong:
            fails.append(f"case {case}: want skip {want} on every event, got " + "; ".join(wrong))
        else:
            print(f"  ok    {want}: the automatic round, all four summons and a reply are refused (#189)")

    def lane_event_records(case, reason):
        rc, payload, err = run_lane_event_step(lane_event_script, skip_reason=reason)
        if rc != 0 or not isinstance(payload, dict) or payload.get("reason") != reason:
            fails.append(f"case {case}: lane event want reason={reason}, got rc={rc} payload={payload!r} {err}")
        else:
            print(f"  ok    lane event records {reason} (#189)")

    # 15. admission: off
    refused_everywhere("15", {"ADMISSION": "off"}, "admission-off")
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_old, skip_reason="admission-off",
        event="pull_request", mode="skip", head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 15 announce: exited {rc}: {err}")
    elif body:
        fails.append(f"case 15 announce: an off repository got a liveness comment: {body!r}")
    else:
        print("  ok    admission-off: announce writes no liveness comment (#189)")
    lane_event_records("15", "admission-off")

    # 16. claude_review_skip label
    refused_everywhere("16", {"HAS_SKIP_LABEL": "true"}, "skip-label")
    rc, outs, err = run_mode_step(
        mode_script, event="pull_request",
        extra_env={"ADMISSION": "label", "HAS_SKIP_LABEL": "true", "HAS_OPT_IN_LABEL": "true"},
    )
    if outs.get("skip_reason") != "skip-label":
        fails.append(f"case 16: skip label must beat the opt-in label, got {outs}")
    else:
        print("  ok    skip-label beats the opt-in label (#189)")
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_old, skip_reason="skip-label",
        event="pull_request", mode="skip", head_sha=NEW,
    )
    marker_line = body.splitlines()[0] if body else ""
    if rc != 0:
        fails.append(f"case 16 announce: exited {rc}: {err}")
    elif outs.get("verdict_kind") != "skip-label":
        fails.append(f"case 16 announce: want verdict_kind=skip-label, got {outs.get('verdict_kind')!r}")
    elif "`claude_review_skip`" not in body or "no machine review on record" not in body:
        fails.append(f"case 16 announce: verdict does not name the label or the missing review: {body!r}")
    elif f"rounds=2 sha={OLD} paused=1 paused_by=alice" not in marker_line:
        fails.append(f"case 16 announce: a label skip changed the pause state: {marker_line!r}")
    else:
        print("  ok    skip-label verdict names the label and carries paused=1 paused_by=alice forward (#189)")
    lane_event_records("16", "skip-label")

    # 17. admission: label without the opt-in label
    refused_everywhere("17", {"ADMISSION": "label"}, "awaiting-label")
    rc, outs, err = run_mode_step(
        mode_script, event="pull_request", fake_liveness="",
        extra_env={"ADMISSION": "label", "HAS_OPT_IN_LABEL": "true"},
    )
    if rc != 0 or outs.get("mode") != "review":
        fails.append(f"case 17: labelled pull request under admission: label was not admitted: rc={rc} {outs}")
    else:
        print("  ok    admission: label with claude_review admits the round (#189)")
    rc, outs, err = run_mode_step(
        mode_script, event="issue_comment", summon="incremental",
        extra_env={"ADMISSION": "label", "HAS_OPT_IN_LABEL": "true"},
    )
    if outs.get("skip_reason") == "awaiting-label":
        fails.append(f"case 17: a summon on a labelled pull request was refused as awaiting-label: {outs}")
    else:
        print("  ok    admission: label with claude_review admits a summon (#189)")
    rc, body, outs, err = run_announce_step(
        announce_script, marker_body=paused_old, skip_reason="awaiting-label",
        event="pull_request", mode="skip", head_sha=NEW,
    )
    if rc != 0:
        fails.append(f"case 17 announce: exited {rc}: {err}")
    elif outs.get("verdict_kind") != "awaiting-label":
        fails.append(f"case 17 announce: want verdict_kind=awaiting-label, got {outs.get('verdict_kind')!r}")
    elif "`claude_review`" not in body or "admission: label" not in body:
        fails.append(f"case 17 announce: verdict does not name the label and the admission mode: {body!r}")
    else:
        print("  ok    awaiting-label verdict names claude_review and admission: label (#189)")
    lane_event_records("17", "awaiting-label")

    # 18c. A refused summon changes no state (#189 ruling): under skip-label or
    # awaiting-label, review, full review and resume must not lift a standing pause,
    # and a pause still records. admission-off never reaches the marker at all (case 15).
    wrong = []
    for reason in ("skip-label", "awaiting-label"):
        for verb in ("incremental", "full", "resume", "pause"):
            rc, body, outs, err = run_announce_step(
                announce_script, marker_body=paused_old, skip_reason=reason,
                event="issue_comment", summon=verb, mode="skip", head_sha=NEW, actor_login="bob",
            )
            marker_line = body.splitlines()[0] if body else ""
            if rc != 0 or "paused=1 paused_by=alice" not in marker_line:
                wrong.append(f"{reason}/{verb}: rc={rc} marker={marker_line!r}")
    if wrong:
        fails.append("case 18c: a refused summon changed the pause state: " + "; ".join(wrong))
    else:
        print("  ok    a summon refused by a label skip leaves paused=1 paused_by=alice standing (#189)")

    # 18a. resolve turns labels into booleans, and nothing else.
    pr_script = extract_step_script("resolve", "Fetch PR metadata and validate origin")
    base_pr = {"head": {"sha": NEW, "repo": {"full_name": "prismalens/test-repo"}},
               "base": {"sha": OLD, "ref": "main"}, "draft": False}
    for labels, want_opt, want_skip in [
        ([{"name": "claude_review_skip"}], "false", "true"),
        ([{"name": "claude_review"}, {"name": "bug"}], "true", "false"),
        (None, "false", "false"),
    ]:
        pr_json = dict(base_pr)
        if labels is not None:
            pr_json["labels"] = labels
        rc, outs, err = run_pr_step(pr_script, pr_json=pr_json)
        got = (outs.get("has_opt_in_label"), outs.get("has_skip_label"))
        if rc != 0 or got != (want_opt, want_skip):
            fails.append(f"case 18a: labels={labels!r}: want opt_in={want_opt} skip={want_skip}, got {got} rc={rc} {err}")
        else:
            print(f"  ok    resolve reads labels={labels!r} as opt_in={want_opt} skip={want_skip} (#189)")

    # 18b. Label events are gated to the two labels, the names are pinned, and setup-repo creates both.
    resolve_if = resolve_job.get("if", "")
    for needle in ("github.event.label.name == 'claude_review'",
                   "github.event.label.name == 'claude_review_skip'",
                   "github.event.action != 'labeled'"):
        if needle not in resolve_if:
            fails.append(f"case 18b: resolve job if lacks {needle!r}")
    pr_step = next((st for st in resolve_steps if st.get("id") == "pr"), {})
    pr_env = pr_step.get("env", {})
    if pr_env.get("LABEL_OPT_IN") != "claude_review" or pr_env.get("LABEL_SKIP") != "claude_review_skip":
        fails.append(f"case 18b: pr step env pins the wrong label names: {pr_env!r}")
    setup_text = (ROOT / "scripts/setup-repo.sh").read_text()
    for label in ("claude_review", "claude_review_skip"):
        if not re.search(rf'^\s*"{label}\|', setup_text, re.M):
            fails.append(f"case 18b: scripts/setup-repo.sh REQUIRED_LABELS does not create {label}")
    if not any(f.startswith("case 18b") for f in fails):
        print("  ok    label events gated to the two labels; names pinned; setup-repo creates both (#189)")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
