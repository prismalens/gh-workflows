#!/usr/bin/env python3
"""Behavioural tests for the ingest sweep in review-findings-sweep.yml (#47).

Extracts the REAL shell body (bash orchestration plus the embedded python parser) out of
the workflow YAML and runs it against stubbed `gh` and `curl` binaries, so the thing under
test is the shipped code rather than a copy of it. Same extraction pattern as
tests/test-liveness-marker.py and tests/test-mutation-verdicts.py.

Covers, at minimum, the three properties #47's amendments exist to guarantee:
  - a GraphQL throttle mid-sweep leaves rows already written for other pull requests intact
    (amendment 2: write incrementally, never once at the end; amendment 3: any GraphQL
    failure is throttling, never trusted against the rate_limit endpoint)
  - a SHA quoted in a human reply that is NOT one of the PR's real commit oids is rejected,
    leaving both human_reply_sha and fix_sha null rather than a guess (amendment 8)
  - author logins are normalized ("claude" -> "claude[bot]", "github-actions" ->
    "github-actions[bot]") at write time (amendment 5)

Plus (amendment 11, this pass): reviewThreads pagination follows pageInfo/endCursor to
exhaustion instead of silently truncating at 100 -- a PR whose threads span two GraphQL
pages yields rows from both, and a throttle on page 2 still leaves page 1's row written
(with the row's row_set_incomplete field set, and a ::warning:: naming the PR). Also: a
thread whose own comments span two pages gets the overflow fetched via a separate
node(id:)-scoped query and merged in.

Plus the pre-existing properties: the verify round's own reply template is read as
fix_sha_source=verify_table (amendment 8), a CodeRabbit thread never becomes a row
(amendment 10 / scope correction), and original_line is populated and never dropped in
favor of the display-only line (amendment 4).

Plus (defect hunt over this branch's .github/workflows/ surface): `gh pr list --limit N`
is not itself paginated to exhaustion by this workflow -- it silently drops anything past
N with no signal of its own. A PR count landing exactly on the limit now gets a loud
::warning:: and the completion line says so, rather than a quietly incomplete sweep that
still reports success.

Run: python3 tests/test-review-findings-sweep.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/review-findings-sweep.yml"
STEP = "Sweep review findings"

OID_A = "a" * 40
OID_B = "b" * 40
OID_C = "c" * 40
BAD_SHA = "deadbeef" * 5  # well-formed hex, 40 chars, but never a real commit oid below


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "_", key)


# `gh` is routed on argument content: `pr list` returns the canned PR list; `graphql` calls
# carrying `-F number=<pr>` are a main_query page for that PR, keyed by an incrementing
# per-PR call counter (so page 1, page 2, ... each read a distinct FAKE_GQL_MAIN_<pr>_<n>
# fixture); `graphql` calls carrying `-F threadId=<id>` instead are a thread_comments_query
# overflow page, keyed the same way off FAKE_GQL_OVERFLOW_<safe id>_<n>. A call whose
# fixture variable is unset fails (exit 1), simulating a permanent throttle on that page.
GH_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"pr list"*)
    printf '%s' "$FAKE_PR_LIST"
    exit 0
    ;;
  *"graphql"*)
    num=""
    threadid=""
    prev=""
    for a in "$@"; do
      case "$prev" in
        -F) case "$a" in
              number=*) num="${a#number=}";;
              threadId=*) threadid="${a#threadId=}";;
            esac;;
      esac
      prev="$a"
    done

    if [ -n "$num" ]; then
      key="main_${num}"
      prefix="MAIN_${num}"
    else
      safe_tid=$(printf '%s' "$threadid" | tr -c 'A-Za-z0-9' '_')
      key="overflow_${safe_tid}"
      prefix="OVERFLOW_${safe_tid}"
    fi

    counter_file="${CALL_COUNTERS_DIR}/${key}"
    count=0
    [ -f "$counter_file" ] && count=$(cat "$counter_file")
    count=$((count + 1))
    echo "$count" > "$counter_file"

    var="FAKE_GQL_${prefix}_${count}"
    val="${!var:-}"
    if [ -z "$val" ]; then
      echo "no fixture for ${var}: simulated throttle" >&2
      exit 1
    fi
    printf '%s' "$val"
    exit 0
    ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""

# `curl` stubs the ingest POST: reads the request body from stdin (the `--data-binary @-`
# body), appends it as one line to $CAPTURE, and reports success unless $FAKE_HTTP_CODE
# says otherwise. Every POST call appends, so the capture file's line count is the number
# of PRs that actually got an incremental write.
CURL_STUB = r"""#!/usr/bin/env bash
body="$(cat)"
printf '%s\n' "$body" >> "$CAPTURE"
printf '%s' "${FAKE_HTTP_CODE:-200}"
"""


def make_bin(td):
    binp = td / "bin"
    binp.mkdir()
    (binp / "gh").write_text(GH_STUB)
    (binp / "gh").chmod(0o755)
    (binp / "curl").write_text(CURL_STUB)
    (binp / "curl").chmod(0o755)
    return binp


def comment(login, body, *, typename="Bot", diff_hunk=None, created_at="2026-01-01T00:00:00Z"):
    return {
        "body": body,
        "diffHunk": diff_hunk,
        "createdAt": created_at,
        "author": {"login": login, "__typename": typename},
    }


def thread(node_id, comments, *, resolved=True, outdated=False, path="f.py",
           line=None, original_line=1, resolved_by=("github-actions", "Bot"),
           comments_has_next=False, comments_end_cursor=None):
    return {
        "id": node_id,
        "isResolved": resolved,
        "isOutdated": outdated,
        "path": path,
        "line": line,
        "originalLine": original_line,
        "resolvedBy": ({"login": resolved_by[0], "__typename": resolved_by[1]}
                       if resolved_by else None),
        "comments": {
            "pageInfo": {"hasNextPage": comments_has_next, "endCursor": comments_end_cursor},
            "nodes": comments,
        },
    }


def main_page(*, head_sha, commit_oids, threads, commits_has_next=False,
              commits_end_cursor=None, threads_has_next=False, threads_end_cursor=None):
    """One page of the combined commits+reviewThreads query."""
    return json.dumps({
        "data": {
            "repository": {
                "pullRequest": {
                    "headRefOid": head_sha,
                    "commits": {
                        "pageInfo": {"hasNextPage": commits_has_next, "endCursor": commits_end_cursor},
                        "nodes": [{"commit": {"oid": o}} for o in commit_oids],
                    },
                    "reviewThreads": {
                        "pageInfo": {"hasNextPage": threads_has_next, "endCursor": threads_end_cursor},
                        "nodes": threads,
                    },
                }
            }
        }
    })


def overflow_page(*, comments, has_next=False, end_cursor=None):
    """One page of the per-thread comment-overflow query (node(id:) scoped)."""
    return json.dumps({
        "data": {
            "node": {
                "comments": {
                    "pageInfo": {"hasNextPage": has_next, "endCursor": end_cursor},
                    "nodes": comments,
                }
            }
        }
    })


def run_sweep(script, *, pr_list, main_fixtures, overflow_fixtures=None, http_code="200",
              max_attempts=2, backoff=0, full_history="false", window_days="3"):
    """
    main_fixtures: {pr_number: [page1_json, page2_json, ...]}. A PR whose list runs out
    before pagination is done (or an empty list) leaves later calls with no fixture, which
    the stub treats as a permanent throttle on that page.

    overflow_fixtures: {thread_id: [page1_json, page2_json, ...]} for the node(id:)-scoped
    comment-overflow query, keyed by the thread's own id.
    """
    with tempfile.TemporaryDirectory() as tmp:
        td = pathlib.Path(tmp)
        binp = make_bin(td)
        capture = td / "capture.jsonl"
        capture.write_text("")
        call_dir = td / "calls"
        call_dir.mkdir()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            CAPTURE=str(capture),
            CALL_COUNTERS_DIR=str(call_dir),
            GH_TOKEN="x",
            REPOSITORY="prismalens/prismalens",
            FULL_HISTORY=full_history,
            WINDOW_DAYS=window_days,
            INGEST_URL="https://example.com",
            INGEST_TOKEN="tok",
            FAKE_PR_LIST=json.dumps([{"number": n} for n in pr_list]),
            FAKE_HTTP_CODE=http_code,
            SWEEP_MAX_ATTEMPTS=str(max_attempts),
            SWEEP_BACKOFF_BASE_SECONDS=str(backoff),
        )
        for n, pages in main_fixtures.items():
            for i, fx in enumerate(pages, start=1):
                if fx is not None:
                    env[f"FAKE_GQL_MAIN_{n}_{i}"] = fx
        for tid, pages in (overflow_fixtures or {}).items():
            safe = _safe(tid)
            for i, fx in enumerate(pages, start=1):
                if fx is not None:
                    env[f"FAKE_GQL_OVERFLOW_{safe}_{i}"] = fx

        p = subprocess.run(["bash", "-c", script], env=env,
                            capture_output=True, text=True, timeout=60)
        rows = []
        for line in capture.read_text().splitlines():
            if not line.strip():
                continue
            rows.extend(json.loads(line)["findings"])
        return p, rows


def main():
    script = extract_step_script()
    fails = []

    def check(name, cond, detail=""):
        status = "ok  " if cond else "FAIL"
        print(f"  {status}  {name}")
        if not cond:
            fails.append(f"{name}: {detail}")

    # ── 1. Throttle mid-sweep leaves already-written rows intact ──────────────────
    good_pr_thread = thread(
        "PRT_GOOD",
        [comment("claude", "**Bug**: leaks a handle")],
        resolved_by=("claude", "Bot"),
    )
    fx_good = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[good_pr_thread])
    proc, rows = run_sweep(
        script,
        pr_list=[5, 6],
        main_fixtures={5: [fx_good], 6: []},  # PR 6: no fixture at all, gh fails every attempt
    )
    check("throttle: run never fails (telemetry must never fail a run)",
          proc.returncode == 0, f"exit {proc.returncode}: {proc.stderr[-400:]}")
    check("throttle: PR 6 warned as throttled, not silently dropped",
          "PR #6" in proc.stdout and "throttl" in proc.stdout.lower())
    check("throttle: PR 5's row still made it (written before PR 6 was even attempted)",
          any(r["thread_node_id"] == "PRT_GOOD" for r in rows), rows)
    check("throttle: PR 6 produced no row at all",
          not any(r.get("pr_number") == 6 for r in rows), rows)

    # ── 2. Human-reply SHA not among real commit oids: rejected, fix_sha stays null ──
    bad_thread = thread(
        "PRT_BAD_SHA",
        [
            comment("claude", "**Bug**: off-by-one"),
            comment("octocat", f"fixed in `{BAD_SHA}`", typename="User"),
        ],
        resolved_by=("claude", "Bot"),
    )
    fx_bad = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[bad_thread])
    _, rows = run_sweep(script, pr_list=[9], main_fixtures={9: [fx_bad]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_BAD_SHA"), None)
    check("unverified human-reply sha: row was still written", row is not None, rows)
    if row:
        check("unverified human-reply sha: human_reply_sha is null",
              row["human_reply_sha"] is None, row)
        check("unverified human-reply sha: fix_sha is null (no guess)",
              row["fix_sha"] is None, row)
        check("unverified human-reply sha: fix_sha_source is null",
              row["fix_sha_source"] is None, row)

    # ── 2b. Human-reply SHA that DOES match a real commit oid (prefix quoted) ───────
    good_sha_thread = thread(
        "PRT_GOOD_SHA",
        [
            comment("claude", "**Style**: rename this"),
            comment("octocat", f"pushed a fix in `{OID_B[:10]}`", typename="User"),
        ],
        resolved_by=("claude", "Bot"),
    )
    fx_good_sha = main_page(head_sha=OID_B, commit_oids=[OID_A, OID_B], threads=[good_sha_thread])
    _, rows = run_sweep(script, pr_list=[10], main_fixtures={10: [fx_good_sha]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_GOOD_SHA"), None)
    check("verified human-reply sha: resolved to the full 40-char oid",
          row is not None and row["human_reply_sha"] == OID_B, row)
    check("verified human-reply sha: fix_sha_source is human_reply",
          row is not None and row["fix_sha_source"] == "human_reply", row)

    # ── 3. Login normalization ──────────────────────────────────────────────────────
    norm_thread = thread(
        "PRT_NORM",
        [comment("claude", "**Nit**: spacing")],
        resolved_by=("github-actions", "Bot"),
    )
    fx_norm = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[norm_thread])
    _, rows = run_sweep(script, pr_list=[11], main_fixtures={11: [fx_norm]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_NORM"), None)
    check("login normalization: claude -> claude[bot] would be seen (thread admitted)",
          row is not None, rows)
    check("login normalization: github-actions -> github-actions[bot]",
          row is not None and row["resolved_by_login"] == "github-actions[bot]", row)

    # A non-bot resolver's login must NOT gain a suffix.
    human_resolver_thread = thread(
        "PRT_HUMAN_RESOLVER",
        [comment("claude", "**Nit**: spacing")],
        resolved_by=("octocat", "User"),
    )
    fx_hr = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[human_resolver_thread])
    _, rows = run_sweep(script, pr_list=[12], main_fixtures={12: [fx_hr]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_HUMAN_RESOLVER"), None)
    check("login normalization: a human login is left unchanged, no suffix added",
          row is not None and row["resolved_by_login"] == "octocat", row)

    # ── 4. verify_table fix_sha source (the lane's own reply template) ─────────────
    verify_thread = thread(
        "PRT_VERIFIED",
        [
            comment("claude", "**Bug**: null deref"),
            comment("github-actions", f"Verified fixed in commit `{OID_C}`. Added a guard.",
                    typename="Bot"),
        ],
        resolved_by=("github-actions", "Bot"),
    )
    fx_verify = main_page(head_sha=OID_C, commit_oids=[OID_C], threads=[verify_thread])
    _, rows = run_sweep(script, pr_list=[13], main_fixtures={13: [fx_verify]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_VERIFIED"), None)
    check("verify_table: fix_sha_source is verify_table",
          row is not None and row["fix_sha_source"] == "verify_table", row)
    check("verify_table: fix_sha is the full oid", row is not None and row["fix_sha"] == OID_C, row)
    check("verify_table: verify_verdict is fixed",
          row is not None and row["verify_verdict"] == "fixed", row)

    # ── 4b. CodeRabbit #161 finding: an unverified sha in the verify template must
    # not be stored as fix_sha_source="verify_table" -- that source name is the
    # caller's promise it was checked against a real commit oid (amendment 8). The
    # verdict still stands even when the quoted sha resolves to nothing on this PR
    # (most likely after a throttled commits page left commit_oids incomplete).
    unverified_verify_thread = thread(
        "PRT_VERIFY_UNRESOLVED",
        [
            comment("claude", "**Bug**: null deref"),
            comment("github-actions", f"Verified fixed in commit `{BAD_SHA}`. Added a guard.",
                    typename="Bot"),
        ],
        resolved_by=("github-actions", "Bot"),
    )
    fx_verify_unresolved = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[unverified_verify_thread])
    _, rows = run_sweep(script, pr_list=[14], main_fixtures={14: [fx_verify_unresolved]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_VERIFY_UNRESOLVED"), None)
    check("verify_table with an unresolved sha: fix_sha is null, never the raw regex capture",
          row is not None and row["fix_sha"] is None, row)
    check("verify_table with an unresolved sha: fix_sha_source is null",
          row is not None and row["fix_sha_source"] is None, row)
    check("verify_table with an unresolved sha: verify_verdict is still fixed",
          row is not None and row["verify_verdict"] == "fixed", row)

    # ── 5. CodeRabbit threads never become rows ─────────────────────────────────────
    cr_thread = thread("PRT_CODERABBIT", [comment("coderabbitai", "**nit**: x")],
                        resolved_by=None)
    claude_thread = thread("PRT_CLAUDE", [comment("claude", "**Bug**: y")],
                           resolved_by=("claude", "Bot"))
    fx_mixed = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[cr_thread, claude_thread])
    _, rows = run_sweep(script, pr_list=[14], main_fixtures={14: [fx_mixed]})
    check("CodeRabbit thread excluded", not any(r["thread_node_id"] == "PRT_CODERABBIT" for r in rows), rows)
    check("Claude thread on the same PR still admitted",
          any(r["thread_node_id"] == "PRT_CLAUDE" for r in rows), rows)

    # ── 6. original_line is the durable key; line stays display-only ───────────────
    moved_thread = thread("PRT_MOVED", [comment("claude", "**Bug**: z")],
                          resolved_by=("claude", "Bot"), line=None, original_line=99)
    fx_moved = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[moved_thread])
    _, rows = run_sweep(script, pr_list=[15], main_fixtures={15: [fx_moved]})
    row = next((r for r in rows if r["thread_node_id"] == "PRT_MOVED"), None)
    check("original_line populated even when line is null",
          row is not None and row["original_line"] == 99 and row["line"] is None, row)

    # ── 7. reviewThreads spans two pages: rows come from both pages ────────────────
    thread_p1 = thread("PRT_PAGE1", [comment("claude", "**Bug**: page one")],
                        resolved_by=("claude", "Bot"))
    thread_p2 = thread("PRT_PAGE2", [comment("claude", "**Bug**: page two")],
                        resolved_by=("claude", "Bot"))
    page1 = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[thread_p1],
                       threads_has_next=True, threads_end_cursor="TCUR1")
    page2 = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[thread_p2],
                       threads_has_next=False)
    _, rows = run_sweep(script, pr_list=[20], main_fixtures={20: [page1, page2]})
    check("pagination: page 1's thread is a row",
          any(r["thread_node_id"] == "PRT_PAGE1" for r in rows), rows)
    check("pagination: page 2's thread is also a row",
          any(r["thread_node_id"] == "PRT_PAGE2" for r in rows), rows)
    check("pagination: both rows report a complete row set",
          all(r["row_set_incomplete"] == 0 for r in rows
              if r["thread_node_id"] in ("PRT_PAGE1", "PRT_PAGE2")), rows)

    # ── 8. Throttle on page 2 leaves page 1's row written (and marked incomplete) ──
    thread_only_page1 = thread("PRT_ONLY_PAGE1", [comment("claude", "**Bug**: survives")],
                                resolved_by=("claude", "Bot"))
    page1_then_throttle = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[thread_only_page1],
                                     threads_has_next=True, threads_end_cursor="TCUR1")
    proc, rows = run_sweep(script, pr_list=[21], main_fixtures={21: [page1_then_throttle]})  # no page 2 fixture
    row = next((r for r in rows if r["thread_node_id"] == "PRT_ONLY_PAGE1"), None)
    check("page-2 throttle: page 1's row was still written",
          row is not None, rows)
    if row:
        check("page-2 throttle: row is marked incomplete",
              row["row_set_incomplete"] == 1, row)
    check("page-2 throttle: PR #21 named in a warning",
          "PR #21" in proc.stdout and "throttl" in proc.stdout.lower())

    # ── 9. A thread's own comments span two pages: the overflow is fetched and merged ──
    overflow_thread = thread(
        "PRT_OVERFLOW",
        [comment("claude", "**Bug**: needs a second comment page")],
        resolved_by=("claude", "Bot"),
        comments_has_next=True,
        comments_end_cursor="CCUR1",
    )
    fx_overflow_main = main_page(head_sha=OID_A, commit_oids=[OID_A], threads=[overflow_thread])
    fx_overflow_page2 = overflow_page(
        comments=[comment("octocat", f"fixed in `{OID_A[:10]}`", typename="User")],
        has_next=False,
    )
    _, rows = run_sweep(
        script,
        pr_list=[22],
        main_fixtures={22: [fx_overflow_main]},
        overflow_fixtures={"PRT_OVERFLOW": [fx_overflow_page2]},
    )
    row = next((r for r in rows if r["thread_node_id"] == "PRT_OVERFLOW"), None)
    check("comment overflow: row was written", row is not None, rows)
    if row:
        check("comment overflow: the second page's reply raised human_reply_count",
              row["human_reply_count"] == 1, row)
        check("comment overflow: the second page's sha was resolved as human_reply_sha",
              row["human_reply_sha"] == OID_A, row)
        check("comment overflow: row set is complete",
              row["row_set_incomplete"] == 0, row)

    # ── 10. Defect hunt: `gh pr list --limit N` truncates silently at N with no
    # signal of its own. A pull-request count equal to the (windowed, non-full-history)
    # 500-item limit must be recorded loudly, not just silently under-swept.
    truncated_pr_list = list(range(1, 501))  # exactly the windowed PR_LIST_LIMIT
    proc, rows = run_sweep(
        script, pr_list=truncated_pr_list, main_fixtures={}, max_attempts=1, backoff=0,
    )
    check("PR-list truncation: a full-limit listing emits a warning naming the limit",
          "::warning::" in proc.stdout and "500" in proc.stdout and "truncat" in proc.stdout.lower(),
          proc.stdout[-2000:])
    check("PR-list truncation: the completion line says the list was truncated",
          "TRUNCATED" in proc.stdout, proc.stdout[-500:])

    # ── 11. A comfortably-under-the-limit listing gets no truncation warning ──
    proc, rows = run_sweep(script, pr_list=[1, 2, 3], main_fixtures={}, max_attempts=1, backoff=0)
    check("PR-list truncation: a small listing gets no truncation warning",
          "truncat" not in proc.stdout.lower(), proc.stdout)

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
