#!/usr/bin/env python3
"""Behavioural tests for the hourly review queue script (Sumit1993/rig#150).

Covers all 16 specified behavioural cases plus dry-run mutation isolation.
"""
import importlib.util
import json
import pathlib
import sys
from datetime import datetime, timezone, timedelta

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts/review-queue.py"

spec = importlib.util.spec_from_file_location("review_queue", SCRIPT_PATH)
rq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rq)
decide = rq.decide
apply = rq.apply
normalize_login = rq.normalize_login


def make_pr(
    number=1,
    title="Test PR",
    author="Sumit1993",
    head_oid="a" * 40,
    head_ref="feat/test",
    is_draft=False,
    created_at="2026-09-24T12:00:00Z",
    committed_date="2026-09-24T12:00:00Z",
    mergeable="MERGEABLE",
    merge_state_status="CLEAN",
    changed_files=1,
    files=None,
    labels=None,
    review_threads=None,
    reviews=None,
    comments=None,
):
    if files is None:
        files = ["src/index.ts"]
    if labels is None:
        labels = []
    if review_threads is None:
        review_threads = []
    if reviews is None:
        reviews = []
    if comments is None:
        comments = []

    return {
        "id": f"pr_{number}",
        "number": number,
        "title": title,
        "isDraft": is_draft,
        "createdAt": created_at,
        "author": {"login": author},
        "headRefName": head_ref,
        "headRefOid": head_oid,
        "baseRefName": "main",
        "mergeable": mergeable,
        "mergeStateStatus": merge_state_status,
        "changedFiles": changed_files,
        "labels": {"nodes": [{"name": l} for l in labels]},
        "files": {"nodes": [{"path": f} for f in files]},
        "commits": {"nodes": [{"commit": {"oid": head_oid, "committedDate": committed_date}}]},
        "reviewThreads": {"nodes": review_threads},
        "reviews": {"nodes": reviews},
        "comments": {"nodes": comments},
    }


def make_snapshot(
    repo="Sumit1993/rig",
    has_merge_queue=False,
    claude_lane_runs=False,
    admission="auto",
    prs=None,
    error=None,
):
    if error:
        return {repo: {"repo": repo, "error": error, "pull_requests": []}}
    return {
        repo: {
            "repo": repo,
            "has_merge_queue": has_merge_queue,
            "claude_lane_runs": claude_lane_runs,
            "admission": admission,
            "pull_requests": prs or [],
        }
    }


def main():
    now = datetime(2026, 9, 24, 15, 0, 0, tzinfo=timezone.utc)
    head_sha = "a" * 40
    print("Running review queue tests against scripts/review-queue.py\n")

    # 1. Clean CodeRabbit summary on head, no threads, checks CLEAN, no Claude lane: merge.
    pr1 = make_pr(
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 0"}],
    )
    snap1 = make_snapshot(repo="Sumit1993/rig", has_merge_queue=False, claude_lane_runs=False, prs=[pr1])
    res1 = decide(snap1, now)
    assert len(res1) == 1, f"Case 1 failed: expected 1 action, got {len(res1)}"
    assert res1[0].kind == "merge", f"Case 1 failed: expected merge, got {res1[0].kind}"
    assert res1[0].reason == "merged", f"Case 1 failed: reason {res1[0].reason}"
    print("✓ Case 1: Clean CodeRabbit summary merges on repo without merge queue")

    # 2. Same on a merge-queue repo: enqueue.
    snap2 = make_snapshot(repo="prismalens/prismalens", has_merge_queue=True, claude_lane_runs=False, prs=[pr1])
    res2 = decide(snap2, now)
    assert len(res2) == 1
    assert res2[0].kind == "enqueue", f"Case 2 failed: expected enqueue, got {res2[0].kind}"
    assert res2[0].reason == "enqueued", f"Case 2 failed: reason {res2[0].reason}"
    print("✓ Case 2: Clean CodeRabbit summary enqueues on merge-queue repo")

    # 3. CodeRabbit review on head with Actionable comments posted: 2 and two unresolved threads:
    # no merge, reason names the threads; not a summon candidate (fixes pending).
    t3_1 = {
        "isResolved": False,
        "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
        "lastComment": {"nodes": [{"author": {"login": "someone_else"}, "createdAt": "2026-09-24T12:05:00Z"}]},
    }
    t3_2 = {
        "isResolved": False,
        "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
        "lastComment": {"nodes": [{"author": {"login": "someone_else"}, "createdAt": "2026-09-24T12:06:00Z"}]},
    }
    pr3 = make_pr(
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 2"}],
        review_threads=[t3_1, t3_2],
    )
    res3 = decide(make_snapshot(prs=[pr3]), now)
    assert len(res3) == 1
    assert res3[0].kind != "merge", "Case 3 failed: expected no merge"
    assert "thread" in res3[0].reason and "unresolved" in res3[0].reason, f"Case 3 failed: reason {res3[0].reason}"
    assert res3[0].kind != "summon", "Case 3 failed: expected not summon candidate"
    assert "CodeRabbit already reviewed" in res3[0].candidate_reason or "fixes pending" in res3[0].candidate_reason
    print("✓ Case 3: Actionable comments and unresolved threads block merge, reason names threads")

    # 4. Same PR after fixes: head moved, both threads have an operator reply as last comment:
    # re-review candidate; picked ahead of an older new PR.
    new_head_sha = "b" * 40
    t4_1 = {
        "isResolved": False,
        "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
        "lastComment": {"nodes": [{"author": {"login": "Sumit1993"}, "createdAt": "2026-09-24T13:30:00Z"}]},
    }
    t4_2 = {
        "isResolved": False,
        "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
        "lastComment": {"nodes": [{"author": {"login": "Sumit1993"}, "createdAt": "2026-09-24T13:31:00Z"}]},
    }
    pr4_rereview = make_pr(
        number=4,
        head_oid=new_head_sha,
        committed_date="2026-09-24T13:20:00Z",
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 2"}],
        review_threads=[t4_1, t4_2],
    )
    pr4_new = make_pr(
        number=5,
        created_at="2026-09-24T10:00:00Z",
        committed_date="2026-09-24T10:00:00Z",
        head_oid="c" * 40,
        reviews=[],
        review_threads=[],
    )
    snap4 = make_snapshot(prs=[pr4_new, pr4_rereview])
    res4 = decide(snap4, now)
    act4_rereview = next(a for a in res4 if a.pr_number == 4)
    act4_new = next(a for a in res4 if a.pr_number == 5)
    assert act4_rereview.cls == "re-review"
    assert act4_rereview.kind == "summon", f"Case 4 failed: re-review not picked for summon: {act4_rereview}"
    assert act4_new.kind != "summon", "Case 4 failed: older new PR should not be picked over re-review"
    print("✓ Case 4: Re-review candidate picked ahead of older new candidate")

    # 5. Thread resolved by Sumit1993 instead of coderabbitai: no merge.
    t5 = {
        "isResolved": True,
        "resolvedBy": {"login": "Sumit1993"},
        "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
    }
    pr5 = make_pr(
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 0"}],
        review_threads=[t5],
    )
    res5 = decide(make_snapshot(prs=[pr5]), now)
    assert res5[0].kind != "merge"
    assert "thread resolved by Sumit1993, not its reviewer" in res5[0].reason, f"Case 5 failed: {res5[0].reason}"
    print("✓ Case 5: Thread resolved by non-reviewer blocks merge")

    # 6. UNSTABLE merges; BLOCKED does not.
    pr6_unstable = make_pr(
        merge_state_status="UNSTABLE",
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 0"}],
    )
    pr6_blocked = make_pr(
        number=62,
        merge_state_status="BLOCKED",
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 0"}],
    )
    res6 = decide(make_snapshot(prs=[pr6_unstable, pr6_blocked]), now)
    assert res6[0].kind == "merge", f"Case 6 failed: UNSTABLE should merge, got {res6[0].kind}"
    assert res6[1].kind != "merge", f"Case 6 failed: BLOCKED should not merge, got {res6[1].kind}"
    assert "checks not green (BLOCKED)" in res6[1].reason
    print("✓ Case 6: UNSTABLE merges, BLOCKED does not")

    # 7. Docs-only PR, never reviewed, checks CLEAN: merge, never summoned.
    pr7 = make_pr(
        changed_files=2,
        files=["README.md", "docs/architecture.mdx"],
        reviews=[],
    )
    res7 = decide(make_snapshot(prs=[pr7]), now)
    assert res7[0].kind == "merge", f"Case 7 failed: docs-only should merge: {res7[0]}"
    assert res7[0].cls == "docs-only"
    print("✓ Case 7: Docs-only PR merges without review and is never summoned")

    # 8. Draft, release-please, dependabot, other author: excluded.
    pr8_draft = make_pr(number=81, is_draft=True)
    pr8_rp = make_pr(number=82, head_ref="release-please--branches--main")
    pr8_dep = make_pr(number=83, author="dependabot")
    pr8_other = make_pr(number=84, author="someoneelse")
    res8 = decide(make_snapshot(prs=[pr8_draft, pr8_rp, pr8_dep, pr8_other]), now)
    for a in res8:
        assert a.cls == "excluded", f"Case 8 failed: {a.pr_number} cls is {a.cls}"
        assert a.kind not in ("merge", "enqueue", "summon")
    print("✓ Case 8: Draft, release-please, dependabot, other authors excluded")

    # 9. blocked label: no merge, still a summon candidate.
    pr9 = make_pr(labels=["blocked"])
    res9 = decide(make_snapshot(prs=[pr9]), now)
    assert res9[0].merge_reason == "held by label blocked"
    assert res9[0].kind == "summon", f"Case 9 failed: expected summon candidate to be summoned: {res9[0]}"
    print("✓ Case 9: blocked label prevents merge but PR remains summon candidate")

    # 10. Claude lane auto repo, CodeRabbit clean on head, liveness says reviewed `<older sha>`: no merge.
    # Liveness for head: merge. Admission label without the label: Claude not required, merges on CodeRabbit alone.
    pr10_base = make_pr(
        head_oid=head_sha,
        reviews=[{"author": {"login": "coderabbitai"}, "commit": {"oid": head_sha}, "body": "Actionable comments posted: 0"}],
    )
    # 10a: older sha
    c_older = {
        "author": {"login": "github-actions"},
        "body": "<!-- claude-review-liveness rounds=1 -->\n**Claude review lane** — [run](x): reviewed `deadbeef1234` and posted 0 findings.",
        "createdAt": "2026-09-24T14:00:00Z",
    }
    pr10_a = dict(pr10_base, comments={"nodes": [c_older]})
    res10_a = decide(make_snapshot(claude_lane_runs=True, admission="auto", prs=[pr10_a]), now)
    assert res10_a[0].kind != "merge", f"Case 10a failed: expected no merge: {res10_a[0]}"
    assert f"Claude lane has not reviewed {head_sha[:7]}" in res10_a[0].reason

    # 10b: liveness for head
    c_head = {
        "author": {"login": "github-actions"},
        "body": f"<!-- claude-review-liveness rounds=1 -->\n**Claude review lane** — [run](x): reviewed `{head_sha[:10]}` and posted 0 findings.",
        "createdAt": "2026-09-24T14:30:00Z",
    }
    pr10_b = dict(pr10_base, comments={"nodes": [c_head]})
    res10_b = decide(make_snapshot(claude_lane_runs=True, admission="auto", prs=[pr10_b]), now)
    assert res10_b[0].kind == "merge", f"Case 10b failed: expected merge: {res10_b[0]}"

    # 10c: admission label without the label
    res10_c = decide(make_snapshot(claude_lane_runs=True, admission="label", prs=[pr10_base]), now)
    assert res10_c[0].kind == "merge", f"Case 10c failed: expected merge on CodeRabbit alone: {res10_c[0]}"
    print("✓ Case 10: Claude lane requirements and admission modes evaluated correctly")

    # 11. Head younger than 20 minutes: not summoned.
    pr11 = make_pr(committed_date="2026-09-24T14:45:00Z")  # 15m old
    res11 = decide(make_snapshot(prs=[pr11]), now)
    assert res11[0].kind != "summon", "Case 11 failed: head younger than 20m should not summon"
    assert "head younger than 20m" in res11[0].candidate_reason
    print("✓ Case 11: Head younger than quiet period not summoned")

    # 12. Pending summon (operator comment after head, CodeRabbit replied Review triggered): not summoned again.
    # Summon answered by a rate-limit notice: candidate again.
    # Answered with does not re-review already reviewed commits: body becomes @coderabbitai full review.
    # 12a: Review triggered
    c12_summon = {
        "author": {"login": "Sumit1993"},
        "body": "@coderabbitai review",
        "createdAt": "2026-09-24T14:10:00Z",
    }
    c12_cr_triggered = {
        "author": {"login": "coderabbitai"},
        "body": "Review triggered.",
        "createdAt": "2026-09-24T14:11:00Z",
    }
    pr12_a = make_pr(committed_date="2026-09-24T14:00:00Z", comments=[c12_summon, c12_cr_triggered])
    res12_a = decide(make_snapshot(prs=[pr12_a]), now)
    assert res12_a[0].kind != "summon", "Case 12a failed: should not summon when already triggered"

    # 12b: Answered by rate-limit notice: candidate again
    c12_summon_old = {
        "author": {"login": "Sumit1993"},
        "body": "@coderabbitai review",
        "createdAt": "2026-09-24T13:50:00Z",
    }
    c12_cr_ratelimit = {
        "author": {"login": "coderabbitai"},
        "body": "Review rate limited. Next included review available in 1 minutes",
        "createdAt": "2026-09-24T13:51:00Z",
        "updatedAt": "2026-09-24T13:51:00Z",
    }
    pr12_b = make_pr(committed_date="2026-09-24T13:40:00Z", comments=[c12_summon_old, c12_cr_ratelimit])
    res12_b = decide(make_snapshot(prs=[pr12_b]), now)
    # Rate limit notice wait (1m from 13:51 = 13:52) expired before now (15:00), and summon was 70m ago (> 57m), so candidate is summoned
    assert res12_b[0].kind == "summon", f"Case 12b failed: expected summon candidate again, got {res12_b[0]}"

    # 12c: Answered with does not re-review already reviewed commits: body becomes @coderabbitai full review
    c12_cr_noreview = {
        "author": {"login": "coderabbitai"},
        "body": "Review finished.\n> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.",
        "createdAt": "2026-09-24T13:51:00Z",
    }
    pr12_c = make_pr(committed_date="2026-09-24T13:40:00Z", comments=[c12_summon_old, c12_cr_noreview])
    res12_c = decide(make_snapshot(prs=[pr12_c]), now)
    assert res12_c[0].kind == "summon"
    assert res12_c[0].summon_body == "@coderabbitai full review", f"Case 12c failed: summon body {res12_c[0].summon_body}"
    print("✓ Case 12: Summon states (pending, rate-limited, and full review escalation) handled")

    # 13. Budget: a rate-limit notice 10 minutes old stating 30 minutes: no summon anywhere.
    # Operator summon 30 minutes ago: no summon.
    # 13a: rate-limit notice 10m old stating 30m
    c13_rl = {
        "author": {"login": "coderabbitai"},
        "body": "Rate limit: Next included review available in 30 minutes",
        "createdAt": "2026-09-24T14:50:00Z",
        "updatedAt": "2026-09-24T14:50:00Z",
    }
    pr13_cand_a = make_pr(number=131, committed_date="2026-09-24T14:00:00Z", comments=[])
    pr13_with_rl = make_pr(number=132, committed_date="2026-09-24T14:00:00Z", comments=[c13_rl])
    res13_a = decide(make_snapshot(prs=[pr13_cand_a, pr13_with_rl]), now)
    assert all(a.kind != "summon" for a in res13_a), "Case 13a failed: summon occurred during active rate limit"
    act13_a = next(a for a in res13_a if a.pr_number == 131)
    assert "budget: rate-limit active" in act13_a.reason

    # 13b: operator summon 30m ago (spacing is 57m)
    c13_sm = {
        "author": {"login": "Sumit1993"},
        "body": "@coderabbitai review",
        "createdAt": "2026-09-24T14:30:00Z",
    }
    pr13_cand_b = make_pr(number=133, committed_date="2026-09-24T14:00:00Z", comments=[])
    pr13_with_sm = make_pr(number=134, committed_date="2026-09-24T14:00:00Z", comments=[c13_sm])
    res13_b = decide(make_snapshot(prs=[pr13_cand_b, pr13_with_sm]), now)
    assert all(a.kind != "summon" for a in res13_b), "Case 13b failed: operator summon too recent"
    act13_b = next(a for a in res13_b if a.pr_number == 133)
    assert "budget: operator summon was 30m ago" in act13_b.reason
    print("✓ Case 13: Budget checks (active rate-limit and operator spacing) prevent summons")

    # 14. Summon with a footer (@coderabbitai review\n\n---\n_Generated by ..._) counts as a summon.
    c14_footer = {
        "author": {"login": "Sumit1993"},
        "body": "@coderabbitai review\n\n---\n_Generated by Claude Code_",
        "createdAt": "2026-09-24T14:10:00Z",
    }
    pr14 = make_pr(committed_date="2026-09-24T14:00:00Z", comments=[c14_footer, c12_cr_triggered])
    res14 = decide(make_snapshot(prs=[pr14]), now)
    assert res14[0].kind != "summon", "Case 14 failed: summon with footer was not recognized"
    print("✓ Case 14: Summon with footer recognized as pending summon")

    # 15. Missing token for an owner: that owner's repos reported as skipped, others still decided.
    snap15 = {
        "prismalens/prismalens": {"repo": "prismalens/prismalens", "error": "missing token REVIEW_QUEUE_TOKEN_PRISMALENS", "pull_requests": []},
        "Sumit1993/rig": {"repo": "Sumit1993/rig", "pull_requests": [pr1]},
    }
    res15 = decide(snap15, now)
    assert len(res15) == 2
    act15_p = next(a for a in res15 if a.repo == "prismalens/prismalens")
    act15_r = next(a for a in res15 if a.repo == "Sumit1993/rig")
    assert act15_p.kind == "skip" and "missing token" in act15_p.reason
    assert act15_r.kind == "merge"
    print("✓ Case 15: Missing token skips owner's repos while deciding others")

    # 16. The two captured real fixtures (V3) go through decide() and classify as reviewed on head.
    def decide_fixture(name, repo):
        with open(ROOT / "tests/fixtures/review-queue" / name, "r", encoding="utf-8") as f:
            snap = json.load(f)
        pr = snap[repo]["pull_requests"][0]
        pr["mergeable"], pr["mergeStateStatus"] = "MERGEABLE", "CLEAN"
        pr["isDraft"] = False
        for t in pr["reviewThreads"]["nodes"]:
            t["isResolved"], t["resolvedBy"] = True, t["comments"]["nodes"][0]["author"]
        return decide(snap, now)[0]

    a194 = decide_fixture("gh-workflows-194.json", "prismalens/gh-workflows")
    assert a194.kind == "merge", f"Case 16: PR 194 (clean CodeRabbit summary on head) should merge: {a194.reason}"
    a704 = decide_fixture("prismalens-704.json", "prismalens/prismalens")
    assert "has not reviewed" not in a704.reason, f"Case 16: PR 704 (actionable review on head) not seen as reviewed: {a704.reason}"
    print("✓ Case 16: Real fixtures (PR 194 and PR 704) classify as reviewed on head through decide()")

    # 17. Dry run never reaches the HTTP layer; a live run does.
    calls = []
    real_http = rq._http_request
    rq._http_request = lambda *args, **kwargs: calls.append(args) or b'{"data": {}}'
    try:
        test_actions = [
            rq.Action(kind="merge", repo="o/r", pr_number=1, title="T", cls="-", reason="merged", pr_id="p1", head_oid="a" * 40),
            rq.Action(kind="enqueue", repo="o/r", pr_number=2, title="T", cls="-", reason="enqueued", pr_id="p2", head_oid="a" * 40),
            rq.Action(kind="summon", repo="o/r", pr_number=3, title="T", cls="new", reason="summon", summon_body="@coderabbitai review"),
        ]
        apply(test_actions, {"o": "token"}, dry_run=True)
        assert calls == [], f"Case 17: dry run made HTTP calls: {calls}"
        apply(test_actions, {"o": "token"}, dry_run=False)
        assert len(calls) == 3, f"Case 17: live run should make 3 calls, made {len(calls)}"
    finally:
        rq._http_request = real_http
    print("✓ Case 17: dry run makes no HTTP call; live run makes one per action")

    # 18. A claude thread resolved by the verify job (github-actions) is resolved by its reviewer.
    t_claude = {"isResolved": True, "resolvedBy": {"login": "github-actions"},
                "comments": {"nodes": [{"author": {"login": "claude"}}]}, "lastComment": {"nodes": []}}
    cr_clean = {"author": {"login": "coderabbitai"}, "body": f"between {'b' * 40} and {'a' * 40}",
                "createdAt": "2026-09-24T12:30:00Z", "updatedAt": "2026-09-24T12:30:00Z"}
    res18 = decide(make_snapshot(prs=[make_pr(review_threads=[t_claude], comments=[cr_clean])]), now)
    assert res18[0].kind == "merge", f"Case 18 failed: {res18[0].reason}"
    print("✓ Case 18: claude thread resolved by github-actions counts as its reviewer")

    # 19. A PR with no changed files is not docs-only.
    res19 = decide(make_snapshot(prs=[make_pr(files=[], changed_files=0)]), now)
    assert res19[0].kind != "merge", f"Case 19 failed: {res19[0].reason}"
    print("✓ Case 19: empty PR is not docs-only")

    # 20. A comment from a deleted account (author: null) does not crash decide().
    ghost = {"author": None, "body": "hello", "createdAt": "2026-09-24T12:10:00Z", "updatedAt": "2026-09-24T12:10:00Z"}
    res20 = decide(make_snapshot(prs=[make_pr(comments=[ghost, cr_clean])]), now)
    assert res20[0].kind == "merge", f"Case 20 failed: {res20[0].reason}"
    print("✓ Case 20: null author is tolerated")

    # 21. More threads than one page: unread threads block the merge.
    pr21 = make_pr(comments=[cr_clean])
    pr21["reviewThreads"]["totalCount"] = 101
    res21 = decide(make_snapshot(prs=[pr21]), now)
    assert res21[0].kind != "merge" and "not all were read" in res21[0].reason, f"Case 21 failed: {res21[0].reason}"
    print("✓ Case 21: unread thread pages block the merge")

    print("\nAll review queue tests passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
