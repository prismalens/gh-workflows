#!/usr/bin/env python3
"""Behavioural tests for the vendored prompt drift check workflow.

Extracts the REAL script from .github/workflows/vendored-prompt-drift.yml and executes
it against a stubbed `gh` CLI across all drift, repeat-drift, re-drift, resolution,
and failure scenarios.

Run: python3 tests/test-vendored-prompt-drift.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/vendored-prompt-drift.yml"
TRACKING = ROOT / ".github/vendored-prompt.json"
STEP_NAME = "Check vendored prompt drift"

RECORDED_SHA = "0b27765f17635137853df05bb7c122d39f1af3d7"
DRIFT_SHA_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DRIFT_SHA_2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                run_text = step["run"]
                # Extract python script inside `python3 (-u)? - <<'PY' ... PY`
                m = re.search(r"python3(?:\s+-u)?\s+-\s+<<'PY'\n(.*)\nPY", run_text, re.DOTALL)
                if m:
                    return m.group(1)
                return run_text
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


GH_DRIFT_STUB = r"""#!/usr/bin/env bash
args="$*"

# Route 1: Upstream contents fetch
if [[ "$args" == *"contents/"* ]]; then
  if [[ -n "${FAKE_FETCH_FAILS:-}" ]]; then
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
  fi
  printf '{"sha":"%s","path":"plugins/code-review/commands/code-review.md"}\n' "${FAKE_UPSTREAM_SHA:-0b27765f17635137853df05bb7c122d39f1af3d7}"
  exit 0
fi

# Route 2: Repo view
if [[ "$args" == *"repo view"* ]]; then
  printf '{"nameWithOwner":"prismalens/gh-workflows"}\n'
  exit 0
fi

# Route 3: Issue list
if [[ "$args" == *"issue list"* ]]; then
  if [[ -n "${FAKE_ISSUE_LIST_FAILS:-}" ]]; then
    echo "gh: API error listing issues" >&2
    exit 1
  fi
  printf '%s\n' "${FAKE_OPEN_ISSUES:-[]}"
  exit 0
fi

# Route 4: Comments fetch
if [[ "$args" == *"issues/"*"/comments"* ]]; then
  if [[ "$args" == *"--paginate"* ]]; then
    printf '%s\n' "${FAKE_ISSUE_COMMENTS:-}"
    exit 0
  fi
fi

# Route 5: Issue creation
if [[ "$args" == *"issue create"* ]]; then
  echo "CREATE_ISSUE: $(echo "$args" | tr '\n' ' ')" >> "$CAPTURE_CALLS"
  # Capture body
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "--body" ]]; then
      printf '%s' "$a" > "$CAPTURE_ISSUE_BODY"
    elif [[ "$prev" == "--title" ]]; then
      printf '%s' "$a" > "$CAPTURE_ISSUE_TITLE"
    fi
    prev="$a"
  done
  printf 'https://github.com/prismalens/gh-workflows/issues/100\n'
  exit 0
fi

# Route 6: Issue comment
if [[ "$args" == *"issue comment"* ]]; then
  echo "COMMENT_ISSUE: $(echo "$args" | tr '\n' ' ')" >> "$CAPTURE_CALLS"
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "--body" ]]; then
      printf '%s' "$a" >> "$CAPTURE_COMMENT_BODY"
    fi
    prev="$a"
  done
  exit 0
fi

# Route 7: Issue close
if [[ "$args" == *"issue close"* ]]; then
  echo "CLOSE_ISSUE: $(echo "$args" | tr '\n' ' ')" >> "$CAPTURE_CALLS"
  exit 0
fi

echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_drift_case(
    script: str,
    *,
    tracking_content: str | None = None,
    upstream_sha: str = RECORDED_SHA,
    open_issues: list | None = None,
    issue_comments: str = "",
    fail_fetch: bool = False,
    fail_issue_list: bool = False,
    remove_tracking: bool = False,
):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_DRIFT_STUB)
        (binp / "gh").chmod(0o755)

        gh_dir = tdp / ".github"
        gh_dir.mkdir()

        if not remove_tracking:
            if tracking_content is not None:
                (gh_dir / "vendored-prompt.json").write_text(tracking_content)
            else:
                (gh_dir / "vendored-prompt.json").write_text(TRACKING.read_text())

        capture_calls = tdp / "calls.txt"
        capture_calls.touch()
        capture_issue_body = tdp / "issue_body.txt"
        capture_issue_title = tdp / "issue_title.txt"
        capture_comment_body = tdp / "comment_body.txt"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            REPO="prismalens/gh-workflows",
            CAPTURE_CALLS=str(capture_calls),
            CAPTURE_ISSUE_BODY=str(capture_issue_body),
            CAPTURE_ISSUE_TITLE=str(capture_issue_title),
            CAPTURE_COMMENT_BODY=str(capture_comment_body),
            FAKE_UPSTREAM_SHA=upstream_sha,
            FAKE_OPEN_ISSUES=json.dumps(open_issues if open_issues is not None else []),
            FAKE_ISSUE_COMMENTS=issue_comments,
        )
        if fail_fetch:
            env["FAKE_FETCH_FAILS"] = "1"
        if fail_issue_list:
            env["FAKE_ISSUE_LIST_FAILS"] = "1"

        proc = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(tdp),
            env=env,
            capture_output=True,
            text=True,
        )

        calls = [c.strip() for c in capture_calls.read_text().splitlines() if c.strip()]
        issue_body = capture_issue_body.read_text() if capture_issue_body.exists() else ""
        issue_title = capture_issue_title.read_text() if capture_issue_title.exists() else ""
        comment_body = capture_comment_body.read_text() if capture_comment_body.exists() else ""

        return proc, calls, issue_title, issue_body, comment_body


def test_suite():
    script = extract_step_script()
    print("=== Testing Vendored Prompt Drift Check Logic ===")

    # Scenario 1: No drift (recorded SHA == fetched SHA, no open issues)
    proc, calls, _, _, _ = run_drift_case(script, upstream_sha=RECORDED_SHA, open_issues=[])
    assert proc.returncode == 0, f"Scenario 1 failed with exit {proc.returncode}: {proc.stderr}"
    assert len(calls) == 0, f"Expected 0 calls, got {calls}"
    print("  ok    No drift: recorded SHA == fetched SHA (exit 0, no issue action)")

    # Scenario 2: First drift (recorded != fetched, no open issue)
    proc, calls, title, body, _ = run_drift_case(script, upstream_sha=DRIFT_SHA_1, open_issues=[])
    assert proc.returncode == 0, f"Scenario 2 failed with exit {proc.returncode}: {proc.stderr}"
    assert len(calls) == 1 and calls[0].startswith("CREATE_ISSUE:"), f"Expected 1 create call, got {calls}"
    assert DRIFT_SHA_1[:8] in title, f"Title {title!r} should carry new SHA prefix"
    assert RECORDED_SHA in body, "Body must carry recorded SHA"
    assert DRIFT_SHA_1 in body, "Body must carry new fetched SHA"
    assert f"<!-- prompt-drift sha={DRIFT_SHA_1} -->" in body, "Body must carry marker"
    print("  ok    First drift: recorded != fetched, no open issue (exit 0, created 1 issue with marker)")

    # Scenario 3: Repeat drift, same SHA (open issue whose marker SHA == fetched)
    open_issue = {
        "number": 42,
        "title": f"Vendored prompt drift: upstream changed to {DRIFT_SHA_1[:8]}",
        "body": f"Drift details\n<!-- prompt-drift sha={DRIFT_SHA_1} -->",
    }
    proc, calls, _, _, _ = run_drift_case(
        script,
        upstream_sha=DRIFT_SHA_1,
        open_issues=[open_issue],
        issue_comments="",
    )
    assert proc.returncode == 0, f"Scenario 3 failed with exit {proc.returncode}: {proc.stderr}"
    assert len(calls) == 0, f"Expected NO comment posted on same drift, got {calls}"
    print("  ok    Repeat drift, same SHA: marker SHA == fetched (exit 0, NO comment posted)")

    # Scenario 4: Re-drift, new SHA (open issue whose marker SHA != fetched)
    proc, calls, _, _, comment_body = run_drift_case(
        script,
        upstream_sha=DRIFT_SHA_2,
        open_issues=[open_issue],
        issue_comments="",
    )
    assert proc.returncode == 0, f"Scenario 4 failed with exit {proc.returncode}: {proc.stderr}"
    assert len(calls) == 1 and calls[0].startswith("COMMENT_ISSUE:"), f"Expected 1 comment call, got {calls}"
    assert DRIFT_SHA_2 in comment_body, "Comment must carry new SHA"
    assert f"<!-- prompt-drift sha={DRIFT_SHA_2} -->" in comment_body, "Comment must carry updated marker"
    print("  ok    Re-drift, new SHA: marker SHA != fetched (exit 0, posted 1 comment with updated marker)")

    # Scenario 5: Repeat drift on multi-comment issue (last comment marker == fetched SHA)
    comments_text = (
        f"Older update\n<!-- prompt-drift sha={DRIFT_SHA_1} -->\n"
        f"Newer update\n<!-- prompt-drift sha={DRIFT_SHA_2} -->"
    )
    proc, calls, _, _, _ = run_drift_case(
        script,
        upstream_sha=DRIFT_SHA_2,
        open_issues=[open_issue],
        issue_comments=comments_text,
    )
    assert proc.returncode == 0, f"Scenario 5 failed: {proc.stderr}"
    assert len(calls) == 0, f"Expected 0 calls for repeated drift matching latest comment, got {calls}"
    print("  ok    Repeat drift after comments: latest comment marker == fetched (exit 0, NO comment posted)")

    # Scenario 6: Re-drift after comments (latest comment marker != fetched SHA)
    DRIFT_SHA_3 = "cccccccccccccccccccccccccccccccccccccccc"
    proc, calls, _, _, comment_body = run_drift_case(
        script,
        upstream_sha=DRIFT_SHA_3,
        open_issues=[open_issue],
        issue_comments=comments_text,
    )
    assert proc.returncode == 0, f"Scenario 6 failed: {proc.stderr}"
    assert len(calls) == 1 and calls[0].startswith("COMMENT_ISSUE:"), f"Expected 1 comment call, got {calls}"
    assert DRIFT_SHA_3 in comment_body, "Comment must carry newest SHA"
    assert f"<!-- prompt-drift sha={DRIFT_SHA_3} -->" in comment_body, "Comment must carry newest marker"
    print("  ok    Re-drift after comments: latest comment marker != fetched (exit 0, posted 1 comment)")

    # Scenario 7: Drift resolved (recorded SHA == fetched SHA, open issue exists)
    proc, calls, _, _, comment_body = run_drift_case(
        script,
        upstream_sha=RECORDED_SHA,
        open_issues=[open_issue],
        issue_comments="",
    )
    assert proc.returncode == 0, f"Scenario 7 failed: {proc.stderr}"
    assert any("COMMENT_ISSUE:" in c for c in calls), f"Expected resolution comment, got {calls}"
    assert any("CLOSE_ISSUE:" in c for c in calls), f"Expected issue close, got {calls}"
    print("  ok    Drift resolved: recorded == fetched, open issue exists (exit 0, posted resolve comment & closed issue)")

    # Failure Path 1: Fetch fails (API error / 404)
    proc, calls, _, _, _ = run_drift_case(script, fail_fetch=True)
    assert proc.returncode != 0, "Fetch failure must exit non-zero"
    assert "Failed to fetch" in proc.stderr or "error" in proc.stderr, f"Stderr missing error: {proc.stderr}"
    print("  ok    Failure path: fetch API failure exits non-zero")

    # Failure Path 2: Missing tracking file
    proc, calls, _, _, _ = run_drift_case(script, remove_tracking=True)
    assert proc.returncode != 0, "Missing tracking file must exit non-zero"
    assert "Tracking file .github/vendored-prompt.json not found" in proc.stderr
    print("  ok    Failure path: missing tracking file exits non-zero")

    # Failure Path 3: Malformed JSON in tracking file
    proc, calls, _, _, _ = run_drift_case(script, tracking_content="{bad_json: true,")
    assert proc.returncode != 0, "Malformed JSON must exit non-zero"
    assert "Failed to parse" in proc.stderr
    print("  ok    Failure path: malformed tracking file JSON exits non-zero")

    # Failure Path 4: Missing required keys in tracking file
    proc, calls, _, _, _ = run_drift_case(script, tracking_content='{"upstream_repo": "anthropics/claude-code"}')
    assert proc.returncode != 0, "Missing keys must exit non-zero"
    assert "missing required fields" in proc.stderr
    print("  ok    Failure path: missing required keys exits non-zero")

    print("\nAll 11 test cases passed successfully.")


if __name__ == "__main__":
    test_suite()
