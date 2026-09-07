#!/usr/bin/env python3
"""Behavioural tests for the liveness marker written by the `announce` job.

Extracts the REAL shell body out of claude-code-review.yml and runs it against a
stubbed `gh`, so the thing under test is the shipped code rather than a copy of it.

The property that matters: `sha=` advances only when the run posted review output.
A green run that posted nothing must leave the baseline where it was — otherwise the
next incremental range starts past those commits and swallows them permanently.

Run: python3 tests/test-liveness-marker.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP = "Upsert liveness comment"

OLD = "a" * 40
NEW = "b" * 40


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


GH_STUB = r"""#!/usr/bin/env bash
# Stub `gh`. Routes on the jq filter / path, mirroring the four real calls.
args="$*"
case "$args" in
  *"-X PATCH"*|*"-X POST"*)
    # capture the written body: -f body=<...>
    prev=""
    for a in "$@"; do
      case "$prev" in -f) case "$a" in body=*) printf '%s' "${a#body=}" > "$CAPTURE";; esac;; esac
      prev="$a"
    done
    exit 0 ;;
  *claude-review-liveness*)   printf '%s' "$FAKE_MARKER" ; exit 0 ;;
  # Must precede the 'pulls/' case: the supersession probe is a pulls/ call whose jq
  # asks for the current head, not for inline comments.
  *".head.sha"*)              printf '%s' "$FAKE_CURRENT_HEAD"; exit 0 ;;
  *"pulls/"*)
    # When FAKE_INLINE_JSON is set, return the JSON and let --jq filter it.
    if [ -n "${FAKE_INLINE_JSON:-}" ]; then
      jq_filter=""
      prev=""
      for a in "$@"; do
        case "$prev" in --jq) jq_filter="$a";; esac
        prev="$a"
      done
      if [ -n "$jq_filter" ]; then
        printf '%s' "$FAKE_INLINE_JSON" | jq -r "$jq_filter"
      else
        printf '%s' "$FAKE_INLINE_JSON"
      fi
    else
      printf '%s' "$FAKE_INLINE"
    fi
    exit 0 ;;
  # Must precede the '## Code review' case: the verify branch's filter contains both.
  *"verification round"*)     printf '%s' "$FAKE_VERIFY_SUMMARY"; exit 0 ;;
  *"## Code review"*)         printf '%s' "$FAKE_SUMMARY"; exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_case(script, *, marker_body=None, inline=0, summary=0,
             event="pull_request", skip_reason="", result="success",
             mode="review", mutate_result="skipped", resolved="", open_="",
             verify_summary="", inline_json="", draft="", current_head=None):
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        binp = td / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        capture = td / "body.txt"

        marker_json = ""
        if marker_body is not None:
            marker_json = json.dumps({"id": 12345, "body": marker_body})

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE=str(capture),
            FAKE_MARKER=marker_json,
            FAKE_INLINE=str(inline),
            FAKE_INLINE_JSON=inline_json,
            FAKE_SUMMARY=str(summary),
            FAKE_VERIFY_SUMMARY=verify_summary,
            GH_TOKEN="x", REPO="o/r", PR="1",
            HEAD_SHA=NEW, EVENT_NAME=event, MODE=mode,
            SKIP_REASON=skip_reason, REVIEW_RESULT=result,
            MUTATE_RESULT=mutate_result, RESOLVED=resolved, OPEN=open_,
            STARTED_AT="2026-01-01T00:00:00Z", RUN_URL="http://run",
            DRAFT=draft,
            # The head the PR is on right now. Unchanged unless a case moves it.
            FAKE_CURRENT_HEAD=(NEW if current_head is None else current_head),
        )
        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        if p.returncode != 0:
            return None, f"script exited {p.returncode}: {p.stderr.strip()[:300]}"
        if not capture.exists():
            return None, "script wrote no comment body"
        lines = capture.read_text().splitlines()
        return (lines[0] if lines else "", lines[1] if len(lines) > 1 else ""), None


def parse_marker(line):
    rounds = re.search(r"rounds=(\d+)", line)
    sha = re.search(r"sha=([0-9a-f]{40})", line)
    return (rounds.group(1) if rounds else None, sha.group(1) if sha else None)


# The reader in `Detect verification mode` parses rounds off the marker with this
# exact expression. Forward-compatibility of the new marker depends on it.
def reader_rounds(line):
    p = subprocess.run(
        "head -1 | grep -oE 'rounds=[0-9]+' | head -1 | cut -d= -f2 || true",
        shell=True, input=line, capture_output=True, text=True)
    return p.stdout.strip()


MOVED = "c" * 40

CASES = [
    # name,                              kwargs,                                          rounds, sha
    ("first review, posted output",      dict(inline=1, summary=1),                       "1",  NEW),
    ("first review, posted NOTHING",     dict(inline=0, summary=0),                       "1",  None),
    ("later review, posted output",      dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              inline=3, summary=1),                       "3",  NEW),
    ("later review, posted NOTHING",     dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              inline=0, summary=0),                       "3",  OLD),
    ("skip: paused",                     dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              skip_reason="paused"),                      "5",  OLD),
    ("skip: no-token",                   dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              skip_reason="no-token"),                    "5",  OLD),
    ("no-new-commits skip, prior inline at head",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={NEW} -->",
                                              mode="skip", skip_reason="no-new-commits",
                                              inline=3),                                  "2",  NEW,
                                         lambda v: not re.search(r"reviewed.*?\d+\s+inline", v)),
    ("no-new-commits skip, no prior inline",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={NEW} -->",
                                              mode="skip", skip_reason="no-new-commits",
                                              inline=0),                                  "2",  NEW),
    ("review job failed",                dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              inline=0, summary=0, result="failure"),     "2",  OLD),
    # A successful review summon IS the resume, so it clears the auto-pause counter.
    # Story: gh-workflows#28.
    ("summon posts: sha moves, rounds reset",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              event="issue_comment", inline=2),           "0",  NEW),
    ("summon full review: rounds reset",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              event="issue_comment", mode="review-full",
                                              inline=2),                                  "0",  NEW),
    # A summon that reviewed nothing is not a resume. Both shapes must hold, and the
    # green one is the one that matters: `result=success` proves the JOB succeeded, not
    # that the reviewer posted. Resetting on job result would hand back a full quota of
    # automatic rounds for a review nobody got. Story: #28, and invariant 1 in #12.
    ("summon SUCCEEDS but posts NOTHING: no reset",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              event="issue_comment", inline=0, summary=0,
                                              result="success"),                          "5",  OLD),
    ("summon job failed: no reset",      dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              event="issue_comment", inline=0, summary=0,
                                              result="failure"),                          "5",  OLD),
    ("legacy marker (no sha), posted",   dict(marker_body="<!-- claude-review-liveness rounds=4 -->",
                                              inline=1),                                  "5",  NEW),
    ("legacy marker (no sha), nothing",  dict(marker_body="<!-- claude-review-liveness rounds=4 -->",
                                              inline=0, summary=0),                       "5",  None),
    # Nothing reviews a draft, summons included, and a summon still reaches this job
    # because `issue_comment` carries no `pull_request` object for the caller stub's
    # guard to see. The counter and the baseline both hold: no round happened.
    # Story: gh-workflows#153.
    ("summon on a draft: says so, moves nothing",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=3 sha={OLD} -->",
                                              event="issue_comment", result="skipped",
                                              draft="true"),                              "3",  OLD,
                                         lambda v: "is a draft" in v and "ready for review" in v),
    # Supersession by a newer push and a mutate that genuinely failed to post both leave
    # the round with no record, and the old text sent both readers to the run log.
    # Story: gh-workflows#149.
    ("verify cancelled, head moved: says so",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              event="pull_request_review_comment",
                                              mode="verify", mutate_result="cancelled",
                                              verify_summary="",
                                              current_head=MOVED),                        "2",  OLD,
                                         lambda v: "head moved to" in v and MOVED[:8] in v
                                                   and "run log" not in v),
    # A cancelled mutate is not proof a push caused it, so with the head where the round
    # left it the verdict says the cause is not recorded rather than inventing one.
    ("verify cancelled, head unmoved: no cause claimed",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              event="pull_request_review_comment",
                                              mode="verify", mutate_result="cancelled",
                                              verify_summary=""),                         "2",  OLD,
                                         lambda v: "cause is not recorded" in v
                                                   and "superseded" not in v),
    ("verify round genuinely silent",    dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              event="pull_request_review_comment",
                                              mode="verify", mutate_result="failure",
                                              verify_summary=""),                         "2",  OLD,
                                         lambda v: "posted **nothing**" in v and "run log" in v),
    # The auto-pause verdict names a remedy the operator may already have applied, and it
    # is upserted in place, so for a minute it is the only thing visible. Story: #149.
    ("auto-pause verdict says it is transient",
                                         dict(marker_body=f"<!-- claude-review-liveness rounds=5 sha={OLD} -->",
                                              skip_reason="paused"),                      "5",  OLD,
                                         lambda v: "already summoned" in v),
    # A verify round reviews no code, so the baseline must not move even though the round
    # posted output. Story: gh-workflows#20.
    ("verify round, summary posted",     dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              event="issue_comment", mode="verify",
                                              mutate_result="success", resolved="1", open_="1",
                                              verify_summary='{"id":9}'),                 "2",  OLD),
    ("verify round, posted NOTHING",     dict(marker_body=f"<!-- claude-review-liveness rounds=2 sha={OLD} -->",
                                              event="issue_comment", mode="verify",
                                              mutate_result="failure"),                   "2",  OLD),
    # A carried-forward comment has commit_id rewritten to the current head but
    # original_commit_id still pointing at the SHA it was posted against. The jq
    # filter must use original_commit_id; matching commit_id overcounts. Story: #29.
    ("carried-forward comment counts as zero",
                                         dict(inline_json=json.dumps([
                                              {"user": {"login": "claude[bot]"},
                                               "commit_id": NEW,
                                               "original_commit_id": OLD}]),
                                              summary=0),                                "1",  None,
                                         lambda v: "posted **nothing**" in v),
]


def main():
    script = extract_step_script()
    fails = []

    print(f"running {len(CASES)} cases against the real step body\n")
    for case in CASES:
        name, kw, want_rounds, want_sha = case[:4]
        verdict_check = case[4] if len(case) > 4 else None
        res, err = run_case(script, **kw)
        if err:
            fails.append(f"{name}: {err}")
            print(f"  ERROR  {name}: {err}")
            continue
        line, verdict = res
        got_rounds, got_sha = parse_marker(line)
        ok = got_rounds == want_rounds and got_sha == want_sha
        # the existing reader must still see the same rounds value
        if reader_rounds(line) != (want_rounds or ""):
            ok = False
            err = f"reader parsed rounds={reader_rounds(line)!r}"
        if verdict_check and not verdict_check(verdict):
            ok = False
            fails.append(f"{name}: verdict assertion failed on {verdict!r}")
        elif not ok:
            fails.append(f"{name}: want rounds={want_rounds} sha={_s(want_sha)}, "
                         f"got rounds={got_rounds} sha={_s(got_sha)}")
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<42} rounds={got_rounds} sha={_s(got_sha)}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


def _s(sha):
    if sha is None:
        return "-"
    return "OLD" if sha == OLD else ("NEW" if sha == NEW else sha[:8])


if __name__ == "__main__":
    main()
