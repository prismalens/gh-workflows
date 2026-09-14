#!/usr/bin/env python3
"""Behavioural tests for incremental review mode resolution in `Detect verification mode`.

Extracts the REAL shell body out of claude-code-review.yml and runs it against a
stubbed `gh`, verifying mode resolution, range extraction, and fallback paths.

Run: python3 tests/test-incremental-mode.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP = "Detect verification mode"

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
# Stub `gh`. Routes on args for comments, graphql, and compare calls.
args="$*"
case "$args" in
  *claude-review-liveness*)
    printf '%s\n' "$FAKE_LIVENESS"
    exit 0 ;;
  *graphql*)
    printf '%s\n' "$FAKE_THREADS"
    exit 0 ;;
  *head.sha*)
    printf '%s\n' "${FAKE_DEBOUNCED_HEAD:-$HEAD_SHA}"
    exit 0 ;;
  *compare*)
    if [ "${FAKE_COMPARE_404:-0}" = "1" ]; then
      case "$args" in
        *"-i"*) printf 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}\n' ; exit 1 ;;
        *) exit 1 ;;
      esac
    fi
    case "$args" in
      *"-i"*) printf 'HTTP/2.0 200 OK\r\n\r\n%s\n' "$FAKE_COMPARE_JSON" ; exit 0 ;;
      *) printf '%s\n' "$FAKE_COMPARE_JSON" ; exit 0 ;;
    esac ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_case(script, *, event="pull_request", has_oauth="true", has_api_key="false", summon="none",
             max_rounds="5", head_sha=NEW, fake_liveness="", fake_threads="[]",
             fake_compare_json="{}", fake_compare_404="0",
             skip_authors="dependabot[bot]", pr_author="",
             diff_lines="", min_diff_lines="0", debounce_minutes="0",
             debounced_head="", patch_fingerprint=""):
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        binp = td / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        # The debounce sleeps in whole minutes, so the real sleep is stubbed out. The
        # code path under test is unchanged; only the waiting is skipped (#113).
        (binp / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
        (binp / "sleep").chmod(0o755)
        out_file = td / "output.txt"
        out_file.touch()

        range_file = pathlib.Path("/tmp/incremental-range.json")
        if range_file.exists():
            range_file.unlink()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="x",
            REPO="o/r",
            PR="1",
            HEAD_SHA=head_sha,
            EVENT_NAME=event,
            SUMMON=summon,
            MAX_ROUNDS=str(max_rounds),
            HAS_OAUTH=has_oauth,
            HAS_API_KEY=has_api_key,
            DIFF_LINES=diff_lines,
            MIN_DIFF_LINES=min_diff_lines,
            DEBOUNCE_MINUTES=debounce_minutes,
            DEBOUNCED_HEAD=debounced_head or head_sha,
            FAKE_DEBOUNCED_HEAD=debounced_head or head_sha,
            PATCH_FINGERPRINT=patch_fingerprint,
            SKIP_AUTHORS=str(skip_authors),
            PR_AUTHOR=str(pr_author),
            FAKE_LIVENESS=fake_liveness,
            FAKE_THREADS=fake_threads,
            FAKE_COMPARE_JSON=fake_compare_json,
            FAKE_COMPARE_404=fake_compare_404,
        )
        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        if p.returncode != 0:
            return None, f"script exited {p.returncode}: {p.stderr.strip()[:300]}"

        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        return outputs, None


CASES = [
    # name, kwargs, want_mode, want_fallback_reason, want_skip_reason, want_range
    ("no token",
     dict(has_oauth="false"),
     "skip", "", "no-token", False),

    ("pull_request, rounds at limit",
     dict(fake_liveness="<!-- claude-review-liveness rounds=5 sha=" + OLD + " -->", max_rounds=5),
     "skip", "", "paused", False),

    ("pull_request, marker has no sha=",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 -->"),
     "review", "no-baseline", "", False),

    ("pull_request, compare ahead, 3 files",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}, {}, {}]})),
     "incremental", "", "", True),

    ("pull_request, baseline == head",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "skip", "no-new-commits", "no-new-commits", False),

    ("pull_request, compare diverged",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]})),
     "review", "diverged", "", False),

    ("pull_request, compare diverged with equal patch fingerprint gives unchanged-patch skip (#162)",
     dict(fake_liveness=f"<!-- claude-review-liveness rounds=1 sha={OLD} patch={'e' * 64} -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]}),
          patch_fingerprint="e" * 64),
     "skip", "unchanged-patch", "unchanged-patch", False),

    ("pull_request, compare diverged with different patch fingerprint gives full review (#162)",
     dict(fake_liveness=f"<!-- claude-review-liveness rounds=1 sha={OLD} patch={'e' * 64} -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]}),
          patch_fingerprint="f" * 64),
     "review", "diverged", "", False),

    ("pull_request, compare diverged with empty stored patch fingerprint gives full review (#162)",
     dict(fake_liveness=f"<!-- claude-review-liveness rounds=1 sha={OLD} -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]}),
          patch_fingerprint="e" * 64),
     "review", "diverged", "", False),

    ("issue_comment summon, compare diverged with equal patch fingerprint still reviews (#162)",
     dict(event="issue_comment", summon="incremental",
          fake_threads="[]",
          fake_liveness=f"<!-- claude-review-liveness rounds=1 sha={OLD} patch={'e' * 64} -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]}),
          patch_fingerprint="e" * 64),
     "review", "diverged", "", False),

    ("pull_request, compare behind",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "behind", "files": [{}]})),
     "review", "diverged", "", False),

    ("pull_request, compare 404",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_404="1"),
     "review", "baseline-gone", "", False),

    ("pull_request, compare ahead, 300 files",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}] * 300})),
     "review", "range-too-large", "", False),

    ("pull_request, compare status weird",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "weird", "files": [{}]})),
     "review", "unexpected-status-weird", "", False),

    ("pull_request, compare malformed response",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json="<html>502 Bad Gateway</html>"),
     "review", "unexpected-status-", "", False),

    ("pull_request, author matches skip_authors exact",
     dict(skip_authors="dependabot[bot]", pr_author="dependabot[bot]"),
     "skip", "", "skipped-author", False),

    ("pull_request, author matches skip_authors with whitespace",
     dict(skip_authors="dependabot[bot], renovate[bot] ", pr_author="renovate[bot]"),
     "skip", "", "skipped-author", False),

    ("pull_request, dependabot author skipped by default skip_authors (#115)",
     dict(pr_author="dependabot[bot]"),
     "skip", "", "skipped-author", False),

    ("issue_comment summon on dependabot author bypasses skip_authors (#115)",
     dict(event="issue_comment", summon="incremental", pr_author="dependabot[bot]",
          fake_threads="[]",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "review", "identical-summon", "", False),

    # A dependabot pull_request gets no secrets, so both guards fire. The author reason is
    # the honest one; reporting no-token sends a reader hunting for broken credentials (#121).
    ("pull_request, dependabot author with no token reports the author reason (#121)",
     dict(has_oauth="false", pr_author="dependabot[bot]"),
     "skip", "", "skipped-author", False),

    ("pull_request, no token and a non-skipped author still reports no-token (#121)",
     dict(has_oauth="false", pr_author="Sumit1993"),
     "skip", "", "no-token", False),

    # #113: the debounce re-reads the head after waiting.
    ("head moved during the debounce, so the round is superseded (#113)",
     dict(debounce_minutes="5", debounced_head="c" * 40),
     "skip", "", "superseded", False),

    ("head unchanged through the debounce, so the round proceeds (#113)",
     dict(debounce_minutes="5",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}]})),
     "incremental", "", "", True),

    ("a summon is never debounced (#113)",
     dict(event="issue_comment", summon="incremental", debounce_minutes="5",
          debounced_head="c" * 40,
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "review", "identical-summon", "", False),

    # #114: the floor applies to automatic rounds only.
    ("pull_request below the diff floor skips as trivial (#114)",
     dict(diff_lines="2", min_diff_lines="20"),
     "skip", "", "trivial", False),

    ("pull_request at the diff floor is reviewed (#114)",
     dict(diff_lines="20", min_diff_lines="20",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}]})),
     "incremental", "", "", True),

    ("a summon is never skipped by the diff floor (#114)",
     dict(event="issue_comment", summon="incremental", diff_lines="2", min_diff_lines="20",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "review", "identical-summon", "", False),

    ("min_diff_lines=0 disables the floor (#114)",
     dict(diff_lines="1", min_diff_lines="0",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}]})),
     "incremental", "", "", True),

    ("an absent diff_lines never trips the floor (#114)",
     dict(diff_lines="", min_diff_lines="20",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}]})),
     "incremental", "", "", True),

    ("pull_request, graphql author login app/dependabot does not match skip_authors (#115)",
     dict(skip_authors="dependabot[bot]", pr_author="app/dependabot",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}]})),
     "incremental", "", "", True),

    ("summon full",
     dict(event="issue_comment", summon="full"),
     "review-full", "", "", False),

    ("summon review, 2 unresolved threads",
     dict(event="issue_comment", summon="incremental",
          fake_threads=json.dumps([
              {"thread_id": "T1", "path": "a.js", "root_id": 1, "url": "u1", "body": "b1"},
              {"thread_id": "T2", "path": "b.js", "root_id": 2, "url": "u2", "body": "b2"}
          ])),
     "verify", "", "", False),

    ("summon review, no threads, baseline == head",
     dict(event="issue_comment", summon="incremental", fake_threads="[]",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "review", "identical-summon", "", False),

    ("in-thread reply, 2 unresolved threads (#178)",
     dict(event="pull_request_review_comment", summon="reply",
          fake_threads=json.dumps([
              {"thread_id": "T1", "path": "a.js", "root_id": 1, "url": "u1", "body": "b1"},
              {"thread_id": "T2", "path": "b.js", "root_id": 2, "url": "u2", "body": "b2"}
          ])),
     "verify", "", "", False),

    ("in-thread reply, no threads skips with reply-no-threads (#178)",
     dict(event="pull_request_review_comment", summon="reply", fake_threads="[]"),
     "skip", "", "reply-no-threads", False),
]


def main():
    script = extract_step_script()
    fails = []

    print(f"running {len(CASES)} cases against the real step body\n")
    for name, kw, want_mode, want_fallback, want_skip, want_range in CASES:
        outputs, err = run_case(script, **kw)
        if err:
            fails.append(f"{name}: {err}")
            print(f"  ERROR  {name}: {err}")
            continue

        got_mode = outputs.get("mode")
        got_fallback = outputs.get("fallback_reason", "")
        got_skip = outputs.get("skip_reason", "")

        ok = (got_mode == want_mode)
        if want_fallback and got_fallback != want_fallback:
            ok = False
        if not want_fallback and got_fallback != "":
            ok = False
        if want_skip and got_skip != want_skip:
            ok = False
        if not want_skip and got_skip != "":
            ok = False

        if want_range:
            got_base = outputs.get("range_base")
            got_head = outputs.get("range_head")
            range_file = pathlib.Path("/tmp/incremental-range.json")
            if got_base != OLD or got_head != NEW:
                ok = False
            if not range_file.exists():
                ok = False

        if not ok:
            fails.append(
                f"{name}: want mode={want_mode!r} fallback={want_fallback!r} skip={want_skip!r}, "
                f"got mode={got_mode!r} fallback={got_fallback!r} skip={got_skip!r}"
            )
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<48} mode={got_mode} fallback={got_fallback or '-'}")

    # credential_type (#174): OAuth wins when both are set; either alone authenticates;
    # neither is the existing no-token skip, unchanged by the new credential.
    print("\ncredential_type combinations\n")
    CREDENTIAL_CASES = [
        ("oauth only", dict(has_oauth="true", has_api_key="false"), "oauth", "review"),
        ("api key only", dict(has_oauth="false", has_api_key="true"), "api_key", "review"),
        ("both set: oauth wins", dict(has_oauth="true", has_api_key="true"), "oauth", "review"),
        ("neither set: no-token skip, empty credential_type", dict(has_oauth="false", has_api_key="false"), "", "skip"),
    ]
    for name, kw, want_credential, want_mode in CREDENTIAL_CASES:
        outputs, err = run_case(script, **kw)
        if err:
            fails.append(f"{name}: {err}")
            print(f"  ERROR  {name}: {err}")
            continue
        got_credential = outputs.get("credential_type", "")
        got_mode = outputs.get("mode")
        ok = got_credential == want_credential and got_mode == want_mode
        if not ok:
            fails.append(f"{name}: want credential_type={want_credential!r} mode={want_mode!r}, got credential_type={got_credential!r} mode={got_mode!r}")
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<48} credential_type={got_credential or '-'} mode={got_mode}")

    # The API key's VALUE must reach the action only through `with:`, never a `run:`
    # shell body where it could be echoed, logged, or shell-expanded. A step's own env
    # block can carry it (e.g. as HAS_API_KEY presence, never the value); the literal
    # `secrets.ANTHROPIC_API_KEY` expression is what actually yields the value (#174).
    import yaml as _yaml
    wf = _yaml.safe_load(WF.read_text())
    leaks = []
    for job_name, job in wf["jobs"].items():
        for step in job.get("steps", []) or []:
            run_body = step.get("run")
            if run_body and "secrets.ANTHROPIC_API_KEY" in run_body:
                leaks.append(f"{job_name}/{step.get('name', step.get('id', '?'))}")
    if leaks:
        fails.append(f"secrets.ANTHROPIC_API_KEY referenced in a run: body: {leaks}")
        print(f"  FAIL  the key's value never appears in a run: body: {leaks}")
    else:
        print("  ok    the key's value never appears in any run: body")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
