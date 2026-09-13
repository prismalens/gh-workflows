#!/usr/bin/env python3
"""Behavioural tests for the fleet failure reporter (.github/workflows/ci-failure-report.yml, #169).

Extracts the REAL shell body of "Collect failed runs across the fleet" and runs it against a
stubbed gh that answers from fixture files with the caller's own --jq applied, proving:
1. The window is [last successful poll, this run's created_at): a run that completed inside
   it with conclusion failure, startup_failure or timed_out is reported; success, cancelled,
   in_progress, before-the-window and at-the-boundary runs are not.
2. A startup_failure says no job ran; a failure names its failed job and first failed step.
3. Titles are escaped for Slack mrkdwn, the headline names every repository and the
   "@Claude triage this" reply, and an unreadable repository is warned about and named in
   the payload rather than silently skipped.
4. Nothing failed and no heartbeat: post=false. Heartbeat: post=true with a liveness line.
5. window_hours overrides the watermark; no prior poll falls back to the 24h cap.
6. Missing webhook secret fails loudly and names it.
7. Structure: the Slack step is SHA-pinned, gated on post, errors on; permissions are
   contents: read only; two cron entries; never pull_request.

Run: python3 tests/test-ci-failure-report.py
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
WF = ROOT / ".github/workflows/ci-failure-report.yml"
STEP = "Collect failed runs across the fleet"
UNTIL = "2026-09-13T08:23:10Z"
LAST_POLL = "2026-09-13T07:23:05Z"

GH_STUB = r"""#!/usr/bin/env bash
# gh api [--paginate] [-X GET] <path>[?query] [-f k=v]... [--jq EXPR]
path=""; jqexpr="."
args=("$@"); i=1
while [ $i -lt ${#args[@]} ]; do
  a="${args[$i]}"
  case "$a" in
    --paginate) ;;
    -X) i=$((i+1)) ;;
    -f) i=$((i+1)); echo "${args[$i]}" >> "${GH_ARGS_LOG:-/dev/null}" ;;
    --jq) i=$((i+1)); jqexpr="${args[$i]}" ;;
    *) path="$a" ;;
  esac
  i=$((i+1))
done
path="${path%%\?*}"
file="$GH_FIXTURES/$(echo "$path" | tr '/' '_').json"
if [ ! -f "$file" ]; then
  echo "gh stub: no fixture for $path" >&2
  exit 1
fi
jq -r "$jqexpr" "$file"
"""


def extract_step():
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    for step in wf["jobs"]["report"]["steps"]:
        if step.get("name") == STEP:
            return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def run_row(id_, conclusion, updated_at, *, status="completed", name="Claude Code Review",
            repo="prismalens/sreforge", title="fix: something", event="pull_request"):
    return {
        "id": id_, "name": name, "status": status, "conclusion": conclusion,
        "updated_at": updated_at, "created_at": updated_at, "event": event,
        "head_branch": "feat/x", "display_title": title, "run_attempt": 1,
        "html_url": f"https://github.com/{repo}/actions/runs/{id_}",
        "repository": {"full_name": repo},
    }


SREFORGE_RUNS = [
    run_row(555, "failure", "2026-09-13T08:00:00Z", title="fix: a <b> & c"),
    run_row(556, "startup_failure", "2026-09-13T07:50:00Z"),
    run_row(557, "success", "2026-09-13T08:01:00Z"),
    run_row(558, "failure", "2026-09-13T07:00:00Z"),
    run_row(559, None, "2026-09-13T08:10:00Z", status="in_progress"),
    run_row(560, "failure", UNTIL),
    run_row(561, "cancelled", "2026-09-13T08:05:00Z"),
]
GHW_RUNS = [
    run_row(700, "timed_out", "2026-09-13T08:05:00Z", name="Telemetry Reconciler",
            repo="prismalens/gh-workflows", event="schedule"),
]
JOBS_555 = {"jobs": [
    {"name": "review", "conclusion": "success", "steps": []},
    {"name": "test", "conclusion": "failure", "steps": [
        {"name": "Checkout", "conclusion": "success"},
        {"name": "Run tests", "conclusion": "failure"},
    ]},
]}
JOBS_700 = {"jobs": [{"name": "reconcile", "conclusion": "timed_out", "steps": [
    {"name": "Reconcile review telemetry", "conclusion": "timed_out"}]}]}


def run_collect(step, *, repos, window_hours="0", heartbeat="false", webhook="https://hooks.slack.com/services/T/B/x",
                last_poll=LAST_POLL, sreforge_runs=SREFORGE_RUNS, ghw_runs=GHW_RUNS, args_log=os.devnull):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        fixtures = tdp / "fixtures"
        fixtures.mkdir()
        bin_dir = tdp / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(GH_STUB)
        (bin_dir / "gh").chmod(0o755)

        def fixture(path, obj):
            (fixtures / (path.replace("/", "_") + ".json")).write_text(json.dumps(obj))

        fixture("repos/prismalens/gh-workflows/actions/runs/999", {"created_at": UNTIL})
        fixture("repos/prismalens/gh-workflows/actions/workflows/ci-failure-report.yml/runs",
                {"workflow_runs": [{"created_at": last_poll}] if last_poll else []})
        fixture("repos/prismalens/sreforge/actions/runs", {"workflow_runs": sreforge_runs})
        fixture("repos/prismalens/gh-workflows/actions/runs", {"workflow_runs": ghw_runs})
        fixture("repos/prismalens/sreforge/actions/runs/555/jobs", JOBS_555)
        fixture("repos/prismalens/gh-workflows/actions/runs/700/jobs", JOBS_700)

        payload = tdp / "slack-payload.json"
        output = tdp / "output.txt"
        output.touch()
        env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "GH_FIXTURES": str(fixtures),
            "GH_TOKEN": "fake",
            "GH_ARGS_LOG": str(args_log),
            "GITHUB_REPOSITORY": "prismalens/gh-workflows",
            "GITHUB_RUN_ID": "999",
            "GITHUB_OUTPUT": str(output),
            "REPOSITORIES": "\n".join(repos) + "\n",
            "WORKFLOW_FILE": "ci-failure-report.yml",
            "WINDOW_HOURS": window_hours,
            "HEARTBEAT": heartbeat,
            "SLACK_CI_WEBHOOK": webhook,
            "PAYLOAD_FILE": str(payload),
        }
        p = subprocess.run(["bash", "-c", step], cwd=td, env=env, capture_output=True, text=True)
        outputs = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
        body = json.loads(payload.read_text()) if payload.exists() else None
        return p, outputs, body


def section_texts(body):
    return [b["text"]["text"] for b in body["blocks"] if b["type"] == "section"]


def test_window_and_content(step):
    repos = ["prismalens/gh-workflows", "prismalens/sreforge", "acme/unreadable"]
    p, out, body = run_collect(step, repos=repos)
    assert p.returncode == 0, f"1: expected exit 0, got {p.returncode}\n{p.stdout}\n{p.stderr}"
    assert out.get("post") == "true", f"1: post must be true, outputs {out}"
    assert out.get("count") == "3", f"1: expected 3 failures, outputs {out}\n{p.stdout}"
    text = json.dumps(body)
    for id_ in (555, 556, 700):
        assert f"/actions/runs/{id_}|run {id_}" in text, f"1: run {id_} missing from payload: {text}"
    for id_ in (557, 558, 559, 560, 561):
        assert f"/actions/runs/{id_}" not in text, f"1: run {id_} must be excluded: {text}"
    assert f"since {LAST_POLL} (last successful poll)" in body["text"], f"1: headline window wrong: {body['text']}"
    print("  ok    1 window [last poll, created_at): 555, 556, 700 in; success, cancelled, in_progress, early and boundary out")

    sections = section_texts(body)
    s555 = next(s for s in sections if "/runs/555|" in s)
    s556 = next(s for s in sections if "/runs/556|" in s)
    s700 = next(s for s in sections if "/runs/700|" in s)
    assert "no job ran" in s556 and "run page shows the error" in s556, f"2: startup_failure text wrong: {s556}"
    assert "`startup_failure`" in s556, f"2: conclusion missing: {s556}"
    assert "• test → Run tests" in s555, f"2: failed job and step not named: {s555}"
    assert "• reconcile → Reconcile review telemetry" in s700 and "`timed_out`" in s700, f"2: timed_out job wrong: {s700}"
    print("  ok    2 startup_failure says no job ran; failure and timed_out name job → step")

    assert "fix: a &lt;b&gt; &amp; c" in s555, f"3: title not escaped for mrkdwn: {s555}"
    assert "*prismalens/sreforge*" in s555 and "*prismalens/gh-workflows*" in s700, "3: repo must lead each block"
    assert "prismalens/gh-workflows, prismalens/sreforge" in body["text"], f"3: headline must list repos: {body['text']}"
    assert "@Claude triage this" in body["text"], f"3: headline must say how to triage: {body['text']}"
    assert "::warning::Could not read runs for acme/unreadable" in p.stdout, f"3: unreadable repo not warned: {p.stdout}"
    contexts = [e["text"] for b in body["blocks"] if b["type"] == "context" for e in b["elements"]]
    assert any("could not read runs for: acme/unreadable" in c for c in contexts), f"3: unreadable repo not in payload: {contexts}"
    print("  ok    3 mrkdwn escaped, repos and triage reply in headline, unreadable repo warned and named")


def test_quiet_and_heartbeat(step):
    quiet = [run_row(557, "success", "2026-09-13T08:01:00Z")]
    p, out, body = run_collect(step, repos=["prismalens/sreforge"], sreforge_runs=quiet)
    assert p.returncode == 0, f"4: exit {p.returncode}\n{p.stdout}{p.stderr}"
    assert out.get("post") == "false", f"4: nothing failed and no heartbeat must not post, outputs {out}"
    assert out.get("count") == "0", f"4: count wrong: {out}"
    assert "0 failures" in body["text"], f"4: payload must still describe the window: {body['text']}"

    p, out, body = run_collect(step, repos=["prismalens/sreforge"], sreforge_runs=quiet, heartbeat="true")
    assert out.get("post") == "true", f"4: heartbeat must post, outputs {out}"
    assert "The poller is alive" in body["text"] and "1 repositories read" in body["text"], f"4: heartbeat text: {body['text']}"
    assert len(body["blocks"]) == 1, f"4: heartbeat carries the headline only, got {len(body['blocks'])} blocks"

    p, out, body = run_collect(step, repos=["prismalens/sreforge", "acme/unreadable"], sreforge_runs=quiet)
    assert out.get("post") == "true", f"4: an unreadable repo is itself reportable, outputs {out}"
    print("  ok    4 quiet window posts nothing; heartbeat posts liveness; an unreadable repo always posts")


def test_window_override_and_cap(step):
    p, out, body = run_collect(step, repos=["prismalens/sreforge"], window_hours="2")
    assert out.get("count") == "3", f"5: window_hours=2 must admit run 558 at 07:00, outputs {out}\n{p.stdout}"
    assert "/runs/558|" in json.dumps(body), "5: run 558 missing under window_hours=2"
    assert "(window_hours=2)" in body["text"], f"5: headline must say the window source: {body['text']}"

    p, out, body = run_collect(step, repos=["prismalens/sreforge"], last_poll=None)
    assert "(24h cap)" in body["text"], f"5: no prior poll must fall back to the cap: {body['text']}"
    assert "since 2026-09-12T08:23:10Z" in body["text"], f"5: cap is until minus 24h: {body['text']}"

    with tempfile.TemporaryDirectory() as td:
        for hours, want in (("48", "created=>=2026-09-11"), ("0", "created=>=2026-09-12")):
            log = pathlib.Path(td) / f"args-{hours}.log"
            run_collect(step, repos=["prismalens/sreforge"], window_hours=hours, args_log=log)
            got = [l for l in log.read_text().splitlines() if l.startswith("created=")]
            assert got == [want], f"5: window_hours={hours} must query {want}, got {got}"
    print("  ok    5 window_hours overrides the watermark; no prior poll uses the 24h cap; created= covers a 48h window")


def test_missing_webhook(step):
    p, out, body = run_collect(step, repos=["prismalens/sreforge"], webhook="")
    assert p.returncode == 1, f"6: missing webhook must exit 1, got {p.returncode}"
    assert "::error::SLACK_CI_WEBHOOK is not set" in p.stdout, f"6: secret not named: {p.stdout!r}"
    assert body is None, "6: no payload may be written without a webhook"
    print("  ok    6 missing SLACK_CI_WEBHOOK: exit 1, named")


def test_structure():
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    on = wf.get("on") or wf.get(True)
    assert set(on) == {"schedule", "workflow_dispatch"}, f"7: triggers {list(on)}"
    crons = [e["cron"] for e in on["schedule"]]
    assert len(crons) == 2 and "37 7 * * 1" in crons, f"7: expected hourly plus heartbeat crons, got {crons}"
    assert wf["permissions"] == {"contents": "read"}, f"7: permissions {wf['permissions']}"
    steps = wf["jobs"]["report"]["steps"]
    post = next(s for s in steps if s.get("name") == "Post to Slack")
    assert re.fullmatch(r"slackapi/slack-github-action@[0-9a-f]{40}", post["uses"]), f"7: unpinned {post['uses']}"
    assert post["if"] == "steps.collect.outputs.post == 'true'", f"7: gate {post['if']!r}"
    assert post["with"]["errors"] is True, "7: a failed post must fail the job"
    assert post["with"]["webhook-type"] == "incoming-webhook", "7: webhook mode"
    collect = next(s for s in steps if s.get("name") == STEP)
    assert collect.get("id") == "collect", "7: collect step id"
    print("  ok    7 structure: SHA-pinned Slack step gated on post with errors on; contents: read; two crons")


if __name__ == "__main__":
    print("=== ci-failure-report.yml: Collect failed runs across the fleet ===")
    body = extract_step()
    test_window_and_content(body)
    test_quiet_and_heartbeat(body)
    test_window_override_and_cap(body)
    test_missing_webhook(body)
    test_structure()
    print("\nAll fleet failure reporter tests passed.")
