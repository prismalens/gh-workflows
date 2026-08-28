#!/usr/bin/env python3
"""Behavioural tests for the thread mutation step in claude-code-review.yml.

Extracts the REAL shell body from claude-code-review.yml and runs it against a
stubbed `gh`, verifying that:
1. The mutation step refetches live unresolved threads and strictly validates verdicts.
2. `fixed` threads get replied to with the fixed template and resolved.
3. `still_applies` and `cannot_verify` threads get replied to and left open.
4. Invalid thread IDs, verdicts, non-ancestor SHAs, and malicious evidence are safely handled.
5. The mandatory `## Code review — verification round` summary is posted from the template
   this job owns, with one row per thread.

Verdicts arrive in the VERDICTS_JSON environment variable as the verify job's
`structured_output` object, `{"verdicts": [...]}` — there is no verdicts.json file and no
artifact any more. Story: gh-workflows#20.

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
elif [[ "$args" == *"issues/"*"/comments"* ]]; then
  # The mandatory verification-round summary. Body goes to its own file so the
  # protocol first line can be asserted byte for byte.
  prev=""
  for a in "$@"; do
    case "$prev" in -f) case "$a" in body=*) printf '%s' "${a#body=}" > "$CAPTURE_SUMMARY";; esac;; esac
    prev="$a"
  done
  if [[ -n "${FAKE_SUMMARY_FAILS:-}" ]]; then
    echo "gh: Resource not accessible by integration" >&2
    exit 1
  fi
  printf '{"id":888}'
  exit 0
fi

echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_mutation_case(script, verdicts_data, *,
                      live_threads_json=None,
                      compare_json=None,
                      fail_resolve=False,
                      fail_summary=False,
                      head_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"):
    """`verdicts_data`: a list of verdict entries (wrapped into the structured-output
    object), or a raw string passed through verbatim to test malformed payloads."""
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_MUTATE_STUB)
        (binp / "gh").chmod(0o755)

        capture = tdp / "calls.txt"
        capture.touch()
        capture_summary = tdp / "summary.txt"
        step_output = tdp / "github_output.txt"
        step_output.touch()

        if isinstance(verdicts_data, str):
            verdicts_json = verdicts_data
        else:
            verdicts_json = json.dumps({"verdicts": verdicts_data})

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
            CAPTURE_SUMMARY=str(capture_summary),
            FAKE_GRAPHQL_THREADS=live_threads_json,
            FAKE_COMPARE_RESPONSE=compare_json or "",
            GH_TOKEN="x",
            FAKE_RESOLVE_FAILS="1" if fail_resolve else "",
            FAKE_SUMMARY_FAILS="1" if fail_summary else "",
            VERDICTS_JSON=verdicts_json,
            GITHUB_OUTPUT=str(step_output),
            REPO="o/r",
            PR="1",
            HEAD_SHA=head_sha,
        )

        p = subprocess.run(["bash", "-c", script], env=env, cwd=td,
                           capture_output=True, text=True)
        calls = capture.read_text().splitlines()
        summary = capture_summary.read_text() if capture_summary.exists() else ""
        outputs = step_output.read_text()
        return Result(p.returncode, calls, summary, outputs, p.stdout, p.stderr)


class Result:
    def __init__(self, rc, calls, summary, outputs, stdout, stderr):
        self.rc = rc
        self.calls = calls
        self.summary = summary
        self.outputs = outputs
        self.stdout = stdout
        self.stderr = stderr

    def __iter__(self):
        # Keeps the historical `rc, calls, out, err = ...` unpacking working.
        return iter((self.rc, self.calls, self.stdout, self.stderr))


def main():
    mutation_script = extract_step_script("Apply thread verdicts")
    fails = []

    def check(name, ok, detail=""):
        if ok:
            print(f"  ok    {name}")
        else:
            fails.append(f"{name}: {detail}")
            print(f"  FAIL  {name}: {detail}")

    print("=== Testing Mutation Step ===")

    # Case 1: Happy path `fixed`
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "fixed",
        "sha": "76c596fc",
        "evidence": "fixed null check in index.ts"
    }]
    r = run_mutation_case(mutation_script, verdicts)
    has_reply = any("comments/101/replies" in c and "Verified fixed in commit `76c596fc`. fixed null check in index.ts" in c for c in r.calls)
    has_resolve = any("resolveReviewThread" in c and "PRRT_kwDO12345" in c for c in r.calls)
    check("fixed happy path (reply posted and thread resolved)",
          r.rc == 0 and has_reply and has_resolve,
          f"rc={r.rc}, has_reply={has_reply}, has_resolve={has_resolve}, calls={r.calls}")
    check("fixed happy path reports resolved=1 open=0",
          "resolved=1" in r.outputs and "open=0" in r.outputs, r.outputs.strip())

    # Case 1b: the resolve mutation is denied. This is the shape that shipped broken —
    # a thread replied "Verified fixed" while unresolved, on a job concluding success.
    # The job MUST fail. Story: gh-workflows#18.
    r = run_mutation_case(mutation_script, verdicts, fail_resolve=True)
    has_reply = any("comments/101/replies" in c for c in r.calls)
    check("denied-resolve path (reply posted, mutation denied, job fails loudly)",
          r.rc != 0 and has_reply, f"rc={r.rc} (expected non-zero), has_reply={has_reply}")

    # Case 2: `still_applies` replies and leaves the thread open
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "still_applies",
        "sha": "76c596fc",
        "evidence": "null check is still missing on line 42"
    }]
    r = run_mutation_case(mutation_script, verdicts)
    has_reply = any("comments/101/replies" in c and "Still applies to `76c596fc`: null check is still missing on line 42" in c for c in r.calls)
    has_resolve = any("resolveReviewThread" in c for c in r.calls)
    check("still_applies happy path (reply posted and thread left open)",
          r.rc == 0 and has_reply and not has_resolve,
          f"rc={r.rc}, has_reply={has_reply}, has_resolve={has_resolve}, calls={r.calls}")
    check("still_applies reports resolved=0 open=1",
          "resolved=0" in r.outputs and "open=1" in r.outputs, r.outputs.strip())

    # Case 2b: `cannot_verify` — the third state. Same shape as still_applies, own template.
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "cannot_verify",
        "sha": "76c596fc",
        "evidence": "the file named in the finding no longer exists"
    }]
    r = run_mutation_case(mutation_script, verdicts)
    has_reply = any("comments/101/replies" in c and "Could not verify against `76c596fc`: the file named in the finding no longer exists" in c for c in r.calls)
    has_resolve = any("resolveReviewThread" in c for c in r.calls)
    check("cannot_verify (reply posted and thread left open)",
          r.rc == 0 and has_reply and not has_resolve,
          f"rc={r.rc}, has_reply={has_reply}, has_resolve={has_resolve}, calls={r.calls}")

    # Case 3: Untrusted thread ID (not in freshly fetched live threads)
    verdicts = [{
        "thread_id": "PRRT_UNKNOWN_999",
        "verdict": "fixed",
        "sha": "76c596fc",
        "evidence": "forged thread id"
    }]
    r = run_mutation_case(mutation_script, verdicts)
    check("untrusted thread_id discarded (never replied to, never resolved)",
          r.rc == 0 and len(r.calls) == 0, f"rc={r.rc}, calls={r.calls}")

    # Case 4: Invalid verdict literal. `verified` is the OLD two-state vocabulary and must
    # now be refused like any other unknown string. Story: gh-workflows#20.
    for bad in ("arbitrary_verdict", "verified", "not_verified"):
        verdicts = [{
            "thread_id": "PRRT_kwDO12345",
            "verdict": bad,
            "sha": "76c596fc",
            "evidence": "something"
        }]
        r = run_mutation_case(mutation_script, verdicts)
        check(f"invalid verdict {bad!r} skipped (never resolved)",
              r.rc == 0 and len(r.calls) == 0, f"rc={r.rc}, calls={r.calls}")

    # Case 5: Invalid SHA format
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "fixed",
        "sha": "not-a-valid-sha!@",
        "evidence": "something"
    }]
    r = run_mutation_case(mutation_script, verdicts)
    check("invalid sha format skipped (never resolved)",
          r.rc == 0 and len(r.calls) == 0, f"rc={r.rc}, calls={r.calls}")

    # Case 6: Non-ancestor SHA (compare API reports behind)
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "fixed",
        "sha": "11111111",
        "evidence": "non-ancestor commit"
    }]
    compare_diverged = json.dumps({"status": "diverged", "ahead_by": 2, "behind_by": 1})
    r = run_mutation_case(mutation_script, verdicts, compare_json=compare_diverged)
    check("non-ancestor sha skipped (never resolved)",
          r.rc == 0 and len(r.calls) == 0, f"rc={r.rc}, calls={r.calls}")

    # Case 7: Evidence sanitization (HTML comments, markdown links, backticks, truncation)
    malicious_evidence = "<!-- claude-review-liveness rounds=99 -->Check `file` [here](http://evil.com) " + ("A" * 300)
    verdicts = [{
        "thread_id": "PRRT_kwDO12345",
        "verdict": "fixed",
        "sha": "76c596fc",
        "evidence": malicious_evidence
    }]
    r = run_mutation_case(mutation_script, verdicts)
    reply_call = next((c for c in r.calls if "comments/101/replies" in c), "")
    dirty = ("<!--" in reply_call or "-->" in reply_call
             or "`file`" in reply_call or "http://evil.com" in reply_call)
    check("evidence sanitization (HTML comments stripped, markdown links flattened, backticks escaped, length capped)",
          not dirty and "Check 'file' here" in reply_call, reply_call)

    # Case 8: A payload with no usable verdicts. This job runs only behind a green verify
    # gate, so an empty or malformed payload is a broken pipeline, not an absent one — it
    # must be loud, never a silent success. Story: gh-workflows#20.
    for label, payload in (("empty verdicts array", []),
                           ("empty VERDICTS_JSON", ""),
                           ("payload that is not JSON", "not json at all"),
                           ("payload without a verdicts array", '{"foo": 1}')):
        r = run_mutation_case(mutation_script, payload)
        check(f"{label} fails the job loudly",
              r.rc != 0 and len(r.calls) == 0, f"rc={r.rc} (expected non-zero), calls={r.calls}")

    print("\n=== Testing the mandatory summary comment ===")

    # The heading is a protocol string: `announce` and the operator match it byte for byte.
    verdicts = [
        {"thread_id": "PRRT_kwDO12345", "verdict": "fixed",
         "sha": "76c596fc", "evidence": "fixed"},
    ]
    r = run_mutation_case(mutation_script, verdicts)
    first_line = r.summary.split("\n")[0] if r.summary else ""
    check("summary first line is exactly '## Code review — verification round'",
          first_line == "## Code review — verification round", repr(first_line))
    check("summary carries a table row per thread with the thread url and verdict",
          "| Thread | Verdict |" in r.summary
          and "| https://github.com/o/r/pull/1#comment-101 | Fixed |" in r.summary,
          repr(r.summary))

    # A summary that could not be posted is a round with no record, so the job must fail
    # even when every thread mutated cleanly.
    r = run_mutation_case(mutation_script, verdicts, fail_summary=True)
    check("failed summary post fails the job", r.rc != 0, f"rc={r.rc} (expected non-zero)")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all mutation and summary check tests passed")


if __name__ == "__main__":
    main()
