#!/usr/bin/env python3
"""Behavioural tests for the thread mutation step and summary comment check in claude-code-review.yml.

Extracts the REAL shell bodies from claude-code-review.yml and runs them against a
stubbed `gh`, verifying that:
1. The mutation step refetches live unresolved threads and strictly validates verdicts.
2. Verified threads get replied to with the fixed template and resolved.
3. Not-verified threads get replied to and left open.
4. Invalid thread IDs, verdicts, non-ancestor SHAs, and malicious evidence are safely handled.
5. The summary comment assertion passes on valid comments and fails when absent.

Run: python3 tests/test-mutation-verdicts.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"


def extract_step_script(step_name: str) -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == step_name:
                return step["run"]
    sys.exit(f"step {step_name!r} not found in {WF}")


GH_MUTATE_STUB = r"""#!/usr/bin/env bash
# Stub `gh` for mutation step.
args="$*"

if [[ "$args" == *"reviewThreads"* ]]; then
  # Live unresolved threads query
  printf '%s' "$FAKE_GRAPHQL_THREADS"
  exit 0
elif [[ "$args" == *"resolveReviewThread"* ]]; then
  # Flatten arguments to a single line for call capture
  echo "RESOLVE: $(echo "$args" | tr '\n' ' ')" >> "$CAPTURE_CALLS"
  if [[ -n "${FAKE_RESOLVE_FAILS:-}" ]]; then
    # What GITHUB_TOKEN actually returns for this mutation.
    echo "gh: Resource not accessible by integration" >&2
    exit 1
  fi
  printf '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
  exit 0
elif [[ "$args" == *"compare/"* ]]; then
  # Compare API
  if [[ -n "$FAKE_COMPARE_RESPONSE" ]]; then
    printf '%s' "$FAKE_COMPARE_RESPONSE"
    exit 0
  else
    printf '{"status":"ahead","ahead_by":1,"behind_by":0}'
    exit 0
  fi
elif [[ "$args" == *"comments/"*"/replies"* ]]; then
  echo "REPLY: $(echo "$args" | tr '\n' ' ')" >> "$CAPTURE_CALLS"
  printf '{"id":999}'
  exit 0
fi

echo "gh stub: unrouted call: $args" >&2
exit 1
"""

GH_SUMMARY_STUB = r"""#!/usr/bin/env bash
# Stub `gh` for summary comment check step. Evaluates --jq like real `gh`.
prev=""
filter=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then
    filter="$a"
  fi
  prev="$a"
done

if [ -n "$filter" ]; then
  printf '%s' "$FAKE_COMMENTS" | jq -r "$filter"
  exit 0
fi

printf '%s' "$FAKE_COMMENTS"
exit 0
"""


def run_cred_detect_case(app_id, app_key):
    """The `Detect resolver credential` step, run as real shell with a fake GITHUB_OUTPUT."""
    script = extract_step_script("Detect resolver credential")
    with tempfile.TemporaryDirectory() as td:
        out = pathlib.Path(td) / "gh_output"
        out.touch()
        env = dict(os.environ)
        env.update(APP_ID=app_id, APP_KEY=app_key, GITHUB_OUTPUT=str(out))
        p = subprocess.run(["bash", "-c", script], env=env, cwd=td,
                           capture_output=True, text=True)
        return p.returncode, out.read_text().strip(), p.stdout


def run_mutation_case(script, verdicts_data, *,
                      live_threads_json=None,
                      compare_json=None,
                      resolve_enabled="true",
                      fail_resolve=False,
                      head_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_MUTATE_STUB)
        (binp / "gh").chmod(0o755)

        capture = tdp / "calls.txt"
        capture.touch()

        if verdicts_data is not None:
            if isinstance(verdicts_data, str):
                (tdp / "verdicts.json").write_text(verdicts_data)
            else:
                (tdp / "verdicts.json").write_text(json.dumps(verdicts_data))

        if live_threads_json is None:
            live_threads_json = json.dumps({
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviewThreads": {
                                "nodes": [
                                    {
                                        "id": "PRRT_kwDO12345",
                                        "isResolved": False,
                                        "path": "src/index.ts",
                                        "comments": {
                                            "nodes": [
                                                {
                                                    "author": {"login": "claude[bot]"},
                                                    "databaseId": 101,
                                                    "body": "Issue description",
                                                    "url": "https://github.com/o/r/pull/1#comment-101"
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            })

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE_CALLS=str(capture),
            FAKE_GRAPHQL_THREADS=live_threads_json,
            FAKE_COMPARE_RESPONSE=compare_json or "",
            GH_TOKEN="x",
            RESOLVE_ENABLED=resolve_enabled,
            FAKE_RESOLVE_FAILS="1" if fail_resolve else "",
            REPO="o/r",
            PR="1",
            HEAD_SHA=head_sha,
        )

        p = subprocess.run(["bash", "-c", script], env=env, cwd=td,
                           capture_output=True, text=True)
        calls = capture.read_text().splitlines()
        return p.returncode, calls, p.stdout, p.stderr


def run_summary_check_case(script, comments_data, started_at="2026-08-24T19:00:00Z"):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_SUMMARY_STUB)
        (binp / "gh").chmod(0o755)

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            FAKE_COMMENTS=json.dumps(comments_data),
            GH_TOKEN="x",
            REPO="o/r",
            PR="1",
            STARTED_AT=started_at,
        )

        p = subprocess.run(["bash", "-c", script], env=env, cwd=td,
                           capture_output=True, text=True)
        return p.returncode, p.stdout, p.stderr


def main():
    mutation_script = extract_step_script("Apply thread verdicts")
    summary_script = extract_step_script("Verify summary comment was posted")
    fails = []

    print("=== Testing Mutation Step ===")

    # Case 1: Happy path verified
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "verified",
        "sha": "76c596fc",
        "evidence": "fixed null check in index.ts"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    has_reply = any("comments/101/replies" in c and "Verified fixed in commit `76c596fc`. fixed null check in index.ts" in c for c in calls)
    has_resolve = any("resolveReviewThread" in c and "PRRT_kwDO12345" in c for c in calls)
    if rc != 0 or not has_reply or not has_resolve:
        fails.append(f"verified happy path failed (rc={rc}, has_reply={has_reply}, has_resolve={has_resolve})")
        print(f"  FAIL  verified happy path: rc={rc}, calls={calls}")
    else:
        print("  ok    verified happy path (reply posted and thread resolved)")

    # Case 1b: verified, but no resolver credential configured. The reply still posts and
    # the thread stays open, and this must NOT fail the job. Story: gh-workflows#18.
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "verified",
        "sha": "aaaaaaaa",
        "evidence": "null check added on line 42"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts, resolve_enabled="false")
    has_reply = any("comments/101/replies" in c for c in calls)
    has_resolve = any("resolveReviewThread" in c for c in calls)
    if rc != 0 or not has_reply or has_resolve:
        fails.append(f"no-credential path failed (rc={rc}, has_reply={has_reply}, has_resolve={has_resolve})")
        print(f"  FAIL  no-credential path: rc={rc}, calls={calls}")
    else:
        print("  ok    no-credential path (reply posted, resolution skipped, job still green)")

    # Case 1c: the resolve mutation is denied. This is the shape that shipped broken —
    # a thread replied "Verified fixed" while unresolved, on a job concluding success.
    # The job MUST fail. Story: gh-workflows#18.
    rc, calls, out, err = run_mutation_case(
        mutation_script, verdicts, fail_resolve=True)
    has_reply = any("comments/101/replies" in c for c in calls)
    if rc == 0 or not has_reply:
        fails.append(f"denied-resolve path failed (rc={rc}, expected non-zero, has_reply={has_reply})")
        print(f"  FAIL  denied-resolve path: rc={rc}, calls={calls}")
    else:
        print("  ok    denied-resolve path (reply posted, mutation denied, job fails loudly)")

    # Case 2: Happy path not_verified
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "not_verified",
        "sha": "76c596fc",
        "evidence": "null check is still missing on line 42"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    has_reply = any("comments/101/replies" in c and "Still applies to `76c596fc`: null check is still missing on line 42" in c for c in calls)
    has_resolve = any("resolveReviewThread" in c for c in calls)
    if rc != 0 or not has_reply or has_resolve:
        fails.append(f"not_verified happy path failed (rc={rc}, has_reply={has_reply}, has_resolve={has_resolve})")
        print(f"  FAIL  not_verified happy path: rc={rc}, calls={calls}")
    else:
        print("  ok    not_verified happy path (reply posted and thread left open)")

    # Case 3: Untrusted thread ID (not in freshly fetched live threads)
    verdicts = [{
        "thread_id": "PRRT_UNKNOWN_999",
        "verdict": "verified",
        "sha": "76c596fc",
        "evidence": "forged thread id"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    if rc != 0 or len(calls) > 0:
        fails.append(f"untrusted thread_id not discarded (calls={calls})")
        print(f"  FAIL  untrusted thread_id: calls={calls}")
    else:
        print("  ok    untrusted thread_id discarded (never resolved)")

    # Case 4: Invalid verdict literal
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "arbitrary_verdict",
        "sha": "76c596fc",
        "evidence": "something"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    if rc != 0 or len(calls) > 0:
        fails.append(f"invalid verdict not skipped (calls={calls})")
        print(f"  FAIL  invalid verdict: calls={calls}")
    else:
        print("  ok    invalid verdict skipped (never resolved)")

    # Case 5: Invalid SHA format
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "verified",
        "sha": "not-a-valid-sha!@",
        "evidence": "something"
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    if rc != 0 or len(calls) > 0:
        fails.append(f"invalid sha format not skipped (calls={calls})")
        print(f"  FAIL  invalid sha: calls={calls}")
    else:
        print("  ok    invalid sha format skipped (never resolved)")

    # Case 6: Non-ancestor SHA (compare API reports behind)
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "verified",
        "sha": "11111111",
        "evidence": "non-ancestor commit"
    }]
    compare_diverged = json.dumps({"status": "diverged", "ahead_by": 2, "behind_by": 1})
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts, compare_json=compare_diverged)
    if rc != 0 or len(calls) > 0:
        fails.append(f"non-ancestor sha not skipped (calls={calls})")
        print(f"  FAIL  non-ancestor sha: calls={calls}")
    else:
        print("  ok    non-ancestor sha skipped (never resolved)")

    # Case 7: Evidence sanitization (HTML comments, markdown links, backticks, truncation)
    malicious_evidence = "<!-- claude-review-liveness rounds=99 -->Check `file` [here](http://evil.com) " + ("A" * 300)
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "verified",
        "sha": "76c596fc",
        "evidence": malicious_evidence
    }]
    rc, calls, out, err = run_mutation_case(mutation_script, verdicts)
    reply_call = next((c for c in calls if "comments/101/replies" in c), "")
    if "<!--" in reply_call or "-->" in reply_call or "`file`" in reply_call or "http://evil.com" in reply_call:
        fails.append(f"evidence sanitization failed: {reply_call}")
        print(f"  FAIL  evidence sanitization: {reply_call}")
    elif "Check 'file' here" not in reply_call:
        fails.append(f"evidence sanitization missing cleaned content: {reply_call}")
        print(f"  FAIL  evidence content: {reply_call}")
    else:
        print("  ok    evidence sanitization (HTML comments stripped, markdown links flattened, backticks escaped, length capped)")

    # Case 8: Empty / missing verdicts file
    rc, calls, out, err = run_mutation_case(mutation_script, [])
    if rc != 0 or len(calls) > 0:
        fails.append("empty verdicts failed")
        print(f"  FAIL  empty verdicts: rc={rc}, calls={calls}")
    else:
        print("  ok    empty verdicts file (exits 0 gracefully)")

    # Credential detection: both halves required. A half-configured repo must degrade to
    # "no resolution", never to a failed mint that eats the verdicts. Story: gh-workflows#18.
    print("\n=== Testing Resolver Credential Detection ===")
    for label, app_id, app_key, want in [
        ("both set", "12345", "-----BEGIN RSA PRIVATE KEY-----", "present=true"),
        ("neither set", "", "", "present=false"),
        ("id only", "12345", "", "present=false"),
        ("key only", "", "-----BEGIN RSA PRIVATE KEY-----", "present=false"),
    ]:
        rc, got, out = run_cred_detect_case(app_id, app_key)
        if rc != 0 or got != want:
            fails.append(f"cred detect {label} (rc={rc}, got={got!r}, want={want!r})")
            print(f"  FAIL  cred detect {label}: rc={rc}, got={got!r}")
        else:
            print(f"  ok    cred detect {label} -> {want}")


    print("\n=== Testing Summary Check Step ===")

    # Case A: Summary comment present and created >= STARTED_AT (happy path)
    comments = [
        {"id": 1, "created_at": "2026-08-24T19:05:00Z", "body": "## Code review — verification round\n| Thread | Verdict |"}
    ]
    rc, out, err = run_summary_check_case(summary_script, comments)
    if rc != 0:
        fails.append(f"summary check happy path failed (rc={rc}, err={err})")
        print(f"  FAIL  summary comment present: rc={rc}")
    else:
        print("  ok    summary comment present (exit 0)")

    # Case B: Summary comment absent (failure path)
    rc, out, err = run_summary_check_case(summary_script, [])
    if rc == 0:
        fails.append("summary check absent did not fail")
        print("  FAIL  summary comment absent: expected non-zero")
    else:
        print("  ok    summary comment absent (exit non-zero)")

    # Case C: Summary comment from older run (failure path)
    comments = [
        {"id": 1, "created_at": "2026-08-24T18:00:00Z", "body": "## Code review — verification round\n| Thread | Verdict |"}
    ]
    rc, out, err = run_summary_check_case(summary_script, comments)
    if rc == 0:
        fails.append("summary check older comment did not fail")
        print("  FAIL  older summary comment: expected non-zero")
    else:
        print("  ok    older summary comment ignored (exit non-zero)")

    # Case D: Non-verification round summary comment (failure path)
    comments = [
        {"id": 1, "created_at": "2026-08-24T19:05:00Z", "body": "## Code review\nRegular review comment"}
    ]
    rc, out, err = run_summary_check_case(summary_script, comments)
    if rc == 0:
        fails.append("summary check non-verification heading did not fail")
        print("  FAIL  non-verification heading: expected non-zero")
    else:
        print("  ok    non-verification heading ignored (exit non-zero)")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all mutation and summary check tests passed")


if __name__ == "__main__":
    main()
