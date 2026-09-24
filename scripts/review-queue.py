#!/usr/bin/env python3
"""Hourly review queue: merges clean PRs and summons CodeRabbit on one PR per hour.

# Fine-grained PATs are scoped per owner because CodeRabbit rate limits are per operator (Sumit1993/rig#150).
"""
import argparse
import base64
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Any

import yaml

OPERATOR = "Sumit1993"
REPOS = [
    "prismalens/prismalens",
    "prismalens/sreforge",
    "prismalens/gh-workflows",
    "prismalens/prismalens.io",
    "Sumit1993/mage-memory",
    "Sumit1993/rig",
]
TOKEN_ENV = {
    "prismalens": "REVIEW_QUEUE_TOKEN_PRISMALENS",
    "Sumit1993": "REVIEW_QUEUE_TOKEN_SUMIT1993",
}
QUIET_MINUTES = 20          # head commit must be this old before a summon
SUMMON_SPACING_MINUTES = 57 # no summon if the operator's last summon anywhere is younger
HOLD_LABELS = {"blocked", "needs-operator"}
# The Claude lane's verify job resolves claude threads with GITHUB_TOKEN, so github-actions counts as that reviewer.
REVIEWER_RESOLVERS = {"claude": {"claude", "github-actions"}}


@dataclass
class Action:
    kind: str             # "merge", "enqueue", "summon", "none", "skip"
    repo: str
    pr_number: int | None
    title: str
    cls: str              # "re-review", "new", "excluded", "docs-only", "-"
    reason: str           # "merged", "enqueued", "summon", or rejection reason
    pr_id: str = ""
    head_oid: str = ""
    summon_body: str = ""
    merge_reason: str = ""
    candidate_reason: str = ""


def normalize_login(login: str | None) -> str:
    if not login:
        return ""
    if login.endswith("[bot]"):
        return login[:-5]
    return login


def parse_dt(dt_str: str | None) -> datetime | None:
    if not dt_str:
        return None
    return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))


def parse_rate_limit_wait_minutes(body: str) -> float:
    pattern = r"(?:next(?:\s+included)?\s+review\s+(?:will\s+be\s+)?available\s+in:?\s*(?:\*\*)?)(.+?)(?:\*\*|<\/details>|\.|\n|$)"
    m = re.search(pattern, body, re.IGNORECASE)
    if not m:
        m = re.search(r"available\s+in:?\s*(?:\*\*)?([0-9a-zA-Z\s]+?)(?:\*\*|<\/details>|\.|\n|$)", body, re.IGNORECASE)

    if m:
        text = m.group(1).strip()
        h_match = re.search(r"(\d+)\s*hour", text, re.IGNORECASE)
        m_match = re.search(r"(\d+)\s*minute", text, re.IGNORECASE)
        s_match = re.search(r"(\d+)\s*second", text, re.IGNORECASE)
        total_minutes = 0.0
        found = False
        if h_match:
            total_minutes += int(h_match.group(1)) * 60.0
            found = True
        if m_match:
            total_minutes += int(m_match.group(1))
            found = True
        if s_match:
            total_minutes += int(s_match.group(1)) / 60.0
            found = True
        if found:
            return total_minutes
    return 60.0


def is_rate_limit_comment(comment: dict) -> bool:
    body = comment.get("body") or ""
    return bool(re.search(r"rate\s*limit", body, re.IGNORECASE))


PR_GRAPHQL_FIELDS = """
id number title isDraft createdAt
author { login }
headRefName headRefOid baseRefName
mergeable mergeStateStatus changedFiles
labels(first: 20) { nodes { name } }
files(first: 100) { nodes { path } }
commits(last: 1) { nodes { commit { oid committedDate } } }
reviewThreads(first: 100) {
  nodes {
    isResolved
    resolvedBy { login }
    comments(first: 1) { nodes { author { login } } }
    lastComment: comments(last: 1) { nodes { author { login } createdAt } }
  }
}
reviews(last: 50) {
  nodes {
    author { login }
    commit { oid }
    body
    submittedAt
  }
}
comments(last: 100) {
  nodes {
    author { login }
    body
    createdAt
    updatedAt
  }
}
"""


def _http_request(url: str, token: str, data: bytes | None = None, method: str | None = None) -> Any:
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "review-queue",
        "Accept": "application/vnd.github.v3+json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def _graphql_query(token: str, query: str, variables: dict) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    resp_bytes = _http_request("https://api.github.com/graphql", token, data=payload)
    res = json.loads(resp_bytes.decode("utf-8"))
    if "errors" in res:
        raise RuntimeError(f"GraphQL error: {res['errors']}")
    return res.get("data", {})


def collect(repo: str, token: str | None, pr_number: int | None = None) -> dict:
    owner, name = repo.split("/", 1)
    if not token:
        env_var = TOKEN_ENV.get(owner, f"REVIEW_QUEUE_TOKEN_{owner.upper()}")
        return {
            "repo": repo,
            "error": f"missing token {env_var}",
            "pull_requests": [],
        }

    # 1. REST read .github/workflows/claude-code-review.yml
    claude_lane_runs = False
    try:
        raw_wf = _http_request(
            f"https://api.github.com/repos/{owner}/{name}/contents/.github/workflows/claude-code-review.yml",
            token,
        )
        content_wf = base64.b64decode(json.loads(raw_wf.decode("utf-8"))["content"]).decode("utf-8")
        wf_yaml = yaml.safe_load(content_wf)
        if isinstance(wf_yaml, dict):
            on_val = wf_yaml.get("on") if "on" in wf_yaml else wf_yaml.get(True)
            if isinstance(on_val, dict):
                claude_lane_runs = "pull_request" in on_val or "pull_request_target" in on_val
            elif isinstance(on_val, list):
                claude_lane_runs = "pull_request" in on_val or "pull_request_target" in on_val
            elif isinstance(on_val, str):
                claude_lane_runs = on_val in ("pull_request", "pull_request_target")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    # 2. REST read .github/claude-review.yml
    admission = "auto"
    try:
        raw_cfg = _http_request(
            f"https://api.github.com/repos/{owner}/{name}/contents/.github/claude-review.yml",
            token,
        )
        content_cfg = base64.b64decode(json.loads(raw_cfg.decode("utf-8"))["content"]).decode("utf-8")
        cfg_yaml = yaml.safe_load(content_cfg)
        if isinstance(cfg_yaml, dict):
            rev = cfg_yaml.get("review")
            if isinstance(rev, dict):
                adm = rev.get("admission")
                if adm is False or adm == "off":
                    admission = "off"
                elif adm in ("auto", "label"):
                    admission = adm
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    # 3. GraphQL query for PRs and merge queue
    if pr_number is not None:
        query = f"""
        query($owner: String!, $name: String!, $number: Int!) {{
          repository(owner: $owner, name: $name) {{
            mergeQueue {{ id }}
            pullRequest(number: $number) {{
              {PR_GRAPHQL_FIELDS}
            }}
          }}
        }}
        """
        data = _graphql_query(token, query, {"owner": owner, "name": name, "number": pr_number})
        repo_data = data.get("repository") or {}
        has_merge_queue = bool(repo_data.get("mergeQueue"))
        pr_node = repo_data.get("pullRequest")
        prs = [pr_node] if pr_node else []
    else:
        prs = []
        after = None
        has_merge_queue = False
        while True:
            query = f"""
            query($owner: String!, $name: String!, $after: String) {{
              repository(owner: $owner, name: $name) {{
                mergeQueue {{ id }}
                pullRequests(first: 50, states: OPEN, after: $after) {{
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{
                    {PR_GRAPHQL_FIELDS}
                  }}
                }}
              }}
            }}
            """
            data = _graphql_query(token, query, {"owner": owner, "name": name, "after": after})
            repo_data = data.get("repository") or {}
            has_merge_queue = bool(repo_data.get("mergeQueue"))
            pr_conn = repo_data.get("pullRequests") or {}
            nodes = pr_conn.get("nodes") or []
            prs.extend(nodes)
            page_info = pr_conn.get("pageInfo") or {}
            if page_info.get("hasNextPage"):
                after = page_info.get("endCursor")
            else:
                break

    return {
        "repo": repo,
        "has_merge_queue": has_merge_queue,
        "claude_lane_runs": claude_lane_runs,
        "admission": admission,
        "pull_requests": prs,
    }


def decide(snapshots: Any, now: datetime, config: dict | None = None) -> list[Action]:
    if config is None:
        config = {}
    operator = config.get("operator", OPERATOR)
    quiet_minutes = config.get("quiet_minutes", QUIET_MINUTES)
    summon_spacing_minutes = config.get("summon_spacing_minutes", SUMMON_SPACING_MINUTES)
    hold_labels = set(config.get("hold_labels", HOLD_LABELS))

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    if isinstance(snapshots, list):
        snapshot_map = {s["repo"]: s for s in snapshots if isinstance(s, dict) and "repo" in s}
    elif isinstance(snapshots, dict):
        if "repo" in snapshots and "pull_requests" in snapshots:
            snapshot_map = {snapshots["repo"]: snapshots}
        else:
            snapshot_map = snapshots
    else:
        snapshot_map = {}

    actions: list[Action] = []
    candidates: list[dict] = []

    # 1. Check rate limit and operator summon spacing budget across all PRs
    all_rate_limit_notices = []
    all_operator_summons = []

    for repo, snap in snapshot_map.items():
        if snap.get("error"):
            continue
        for pr in snap.get("pull_requests", []):
            for c in pr.get("comments", {}).get("nodes", []):
                c_author = normalize_login(c.get("author", {}).get("login"))
                c_body = c.get("body") or ""
                if c_author == "coderabbitai" and is_rate_limit_comment(c):
                    dt = parse_dt(c.get("updatedAt") or c.get("createdAt"))
                    if dt:
                        all_rate_limit_notices.append((dt, c))
                if c_author == operator and (c_body.lstrip().startswith("@coderabbitai review") or c_body.lstrip().startswith("@coderabbitai full review")):
                    dt = parse_dt(c.get("createdAt"))
                    if dt:
                        all_operator_summons.append((dt, c))

    budget_blocked = False
    budget_reason = ""

    if all_rate_limit_notices:
        all_rate_limit_notices.sort(key=lambda x: x[0])
        newest_rl_dt, newest_rl_comment = all_rate_limit_notices[-1]
        wait_m = parse_rate_limit_wait_minutes(newest_rl_comment.get("body") or "")
        expiry = newest_rl_dt + timedelta(minutes=wait_m)
        if expiry > now:
            budget_blocked = True
            budget_reason = f"budget: rate-limit active until {expiry.strftime('%H:%M:%SZ')}"

    if not budget_blocked and all_operator_summons:
        all_operator_summons.sort(key=lambda x: x[0])
        newest_summon_dt, _ = all_operator_summons[-1]
        age_m = (now - newest_summon_dt).total_seconds() / 60.0
        if age_m < summon_spacing_minutes:
            budget_blocked = True
            budget_reason = f"budget: operator summon was {int(age_m)}m ago (< {summon_spacing_minutes}m)"

    # 2. Evaluate each repo and PR
    for repo, snap in snapshot_map.items():
        if snap.get("error"):
            actions.append(
                Action(
                    kind="skip",
                    repo=repo,
                    pr_number=None,
                    title="-",
                    cls="-",
                    reason=f"skipped: {snap['error']}",
                )
            )
            continue

        has_merge_queue = snap.get("has_merge_queue", False)
        claude_lane_runs = snap.get("claude_lane_runs", False)
        admission = snap.get("admission", "auto")

        for pr in snap.get("pull_requests", []):
            pr_id = pr.get("id", "")
            pr_number = pr.get("number")
            title = pr.get("title") or ""
            is_draft = bool(pr.get("isDraft"))
            author = normalize_login(pr.get("author", {}).get("login"))
            head_ref_name = pr.get("headRefName") or ""
            head_oid = pr.get("headRefOid") or ""
            mergeable = pr.get("mergeable") or ""
            merge_state_status = pr.get("mergeStateStatus") or ""
            changed_files = pr.get("changedFiles") or 0

            commits = pr.get("commits", {}).get("nodes", [])
            head_commit = commits[0].get("commit", {}) if commits else {}
            head = head_commit.get("oid") or head_oid
            committed_date = parse_dt(head_commit.get("committedDate"))
            head_age_minutes = (now - committed_date).total_seconds() / 60.0 if committed_date else 0.0

            labels = {l.get("name") for l in pr.get("labels", {}).get("nodes", []) if l.get("name")}
            files = [f.get("path") for f in pr.get("files", {}).get("nodes", []) if f.get("path")]

            # Exclusion checks
            is_excluded = False
            excluded_reason = ""
            if author == "dependabot":
                is_excluded = True
                excluded_reason = "dependabot PR"
            elif author != operator:
                is_excluded = True
                excluded_reason = f"author is {author}, not operator"
            elif is_draft:
                is_excluded = True
                excluded_reason = "draft PR"
            elif head_ref_name.startswith("release-please--"):
                is_excluded = True
                excluded_reason = "release-please branch"

            # cr_reviewed_head
            cr_reviewed_head = False
            for rev in pr.get("reviews", {}).get("nodes", []):
                rev_author = normalize_login(rev.get("author", {}).get("login"))
                rev_oid = rev.get("commit", {}).get("oid")
                rev_body = rev.get("body") or ""
                if rev_author == "coderabbitai" and rev_oid == head:
                    if re.search(r"Actionable comments posted:\s*\d+", rev_body):
                        cr_reviewed_head = True
                        break
            if not cr_reviewed_head:
                for c in pr.get("comments", {}).get("nodes", []):
                    c_author = normalize_login(c.get("author", {}).get("login"))
                    c_body = c.get("body") or ""
                    if c_author == "coderabbitai":
                        if re.search(r"between\s+[0-9a-fA-F]{40}\s+and\s+" + re.escape(head), c_body):
                            cr_reviewed_head = True
                            break

            # cr_reviewed_before
            cr_reviewed_before = False
            for rev in pr.get("reviews", {}).get("nodes", []):
                rev_author = normalize_login(rev.get("author", {}).get("login"))
                rev_oid = rev.get("commit", {}).get("oid")
                rev_body = (rev.get("body") or "").strip()
                if rev_author == "coderabbitai" and rev_body:
                    if rev_oid and rev_oid != head:
                        cr_reviewed_before = True
                        break
            if not cr_reviewed_before:
                for c in pr.get("comments", {}).get("nodes", []):
                    c_author = normalize_login(c.get("author", {}).get("login"))
                    c_body = c.get("body") or ""
                    if c_author == "coderabbitai":
                        m = re.search(r"between\s+[0-9a-fA-F]{40}\s+and\s+([0-9a-fA-F]{40})", c_body)
                        if m and m.group(1).lower() != head.lower():
                            cr_reviewed_before = True
                            break

            # threads_clean
            threads = pr.get("reviewThreads", {}).get("nodes", [])
            unresolved_threads_count = 0
            thread_not_reviewer_reason = ""
            for t in threads:
                if not t.get("isResolved", False):
                    unresolved_threads_count += 1
                else:
                    first_comments = t.get("comments", {}).get("nodes", [])
                    first_author = normalize_login(first_comments[0].get("author", {}).get("login")) if first_comments else ""
                    resolved_by = normalize_login(t.get("resolvedBy", {}).get("login")) if t.get("resolvedBy") else ""
                    if resolved_by not in REVIEWER_RESOLVERS.get(first_author, {first_author}):
                        if not thread_not_reviewer_reason:
                            thread_not_reviewer_reason = f"thread resolved by {resolved_by}, not its reviewer"

            if unresolved_threads_count > 0:
                threads_clean = False
                threads_reason = f"{unresolved_threads_count} unresolved review thread{'s' if unresolved_threads_count > 1 else ''}"
            elif thread_not_reviewer_reason:
                threads_clean = False
                threads_reason = thread_not_reviewer_reason
            else:
                threads_clean = True
                threads_reason = ""

            # unresolved_cr_threads_all_replied
            unresolved_cr_threads_all_replied = True
            for t in threads:
                if not t.get("isResolved", False):
                    first_comments = t.get("comments", {}).get("nodes", [])
                    first_author = normalize_login(first_comments[0].get("author", {}).get("login")) if first_comments else ""
                    if first_author == "coderabbitai":
                        last_comments = t.get("lastComment", {}).get("nodes", [])
                        last_author = normalize_login(last_comments[0].get("author", {}).get("login")) if last_comments else ""
                        if last_author != operator:
                            unresolved_cr_threads_all_replied = False
                            break

            # docs_only
            docs_only = (
                bool(files)
                and changed_files <= 100
                and changed_files == len(files)
                and all(p.endswith(".md") or p.endswith(".mdx") or p.startswith("docs/") for p in files)
            )

            # claude_lane_required
            claude_lane_required = (
                claude_lane_runs
                and ("claude_review_skip" not in labels)
                and (admission == "auto" or (admission == "label" and "claude_review" in labels))
            )

            # claude_reviewed_head
            claude_comments = []
            for c in pr.get("comments", {}).get("nodes", []):
                c_author = normalize_login(c.get("author", {}).get("login"))
                c_body = c.get("body") or ""
                if c_author == "github-actions" and "<!-- claude-review-liveness" in c_body:
                    claude_comments.append(c)
            claude_comments.sort(key=lambda c: c.get("createdAt") or "")
            claude_reviewed_head = False
            if claude_comments:
                newest_claude = claude_comments[-1]
                m = re.search(r"reviewed\s+`?([0-9a-fA-F]{7,40})", newest_claude.get("body") or "")
                if m:
                    sha = m.group(1).lower()
                    if head.lower().startswith(sha):
                        claude_reviewed_head = True

            # checks_ok
            checks_ok = (mergeable == "MERGEABLE" and merge_state_status in {"CLEAN", "UNSTABLE", "HAS_HOOKS"})

            # Merge evaluation
            should_merge = False
            merge_reason = ""
            held_by_label = ""
            for hl in sorted(hold_labels):
                if hl in labels:
                    held_by_label = hl
                    break

            if is_excluded:
                merge_reason = excluded_reason
            elif held_by_label:
                merge_reason = f"held by label {held_by_label}"
            elif not checks_ok:
                if merge_state_status == "BLOCKED":
                    merge_reason = "checks not green (BLOCKED)"
                elif mergeable != "MERGEABLE":
                    merge_reason = f"checks not green (mergeable: {mergeable})"
                else:
                    merge_reason = f"checks not green ({merge_state_status})"
            elif not threads_clean:
                merge_reason = threads_reason
            elif docs_only:
                should_merge = True
                merge_reason = "docs-only"
            elif not cr_reviewed_head:
                merge_reason = f"CodeRabbit has not reviewed {head[:7]}"
            elif claude_lane_required and not claude_reviewed_head:
                merge_reason = f"Claude lane has not reviewed {head[:7]}"
            else:
                should_merge = True
                merge_reason = "clean"

            if should_merge:
                action_kind = "enqueue" if has_merge_queue else "merge"
                action_reason = "enqueued" if has_merge_queue else "merged"
                actions.append(
                    Action(
                        kind=action_kind,
                        repo=repo,
                        pr_number=pr_number,
                        title=title,
                        cls="docs-only" if docs_only else "-",
                        reason=action_reason,
                        pr_id=pr_id,
                        head_oid=head,
                        merge_reason=merge_reason,
                    )
                )
                continue

            # Candidate evaluation (never for merged, excluded or docs-only PRs)
            candidate_class = None
            candidate_reason = ""
            summon_body = "@coderabbitai review"
            is_cand = False

            if is_excluded:
                candidate_reason = excluded_reason
            elif docs_only:
                candidate_reason = "docs-only"
            elif cr_reviewed_head:
                candidate_reason = f"CodeRabbit already reviewed {head[:7]}"
            elif head_age_minutes < quiet_minutes:
                candidate_reason = f"head younger than {quiet_minutes}m"
            else:
                # Check pending summon on this head
                operator_summons = []
                for c in pr.get("comments", {}).get("nodes", []):
                    c_author = normalize_login(c.get("author", {}).get("login"))
                    c_body = (c.get("body") or "").lstrip()
                    c_dt = parse_dt(c.get("createdAt"))
                    if c_author == operator and c_dt and committed_date and c_dt > committed_date:
                        if c_body.startswith("@coderabbitai review") or c_body.startswith("@coderabbitai full review"):
                            operator_summons.append((c_dt, c))
                operator_summons.sort(key=lambda x: x[0])

                has_pending_summon = False
                if operator_summons:
                    latest_summon_dt, _ = operator_summons[-1]
                    cr_after = []
                    for c in pr.get("comments", {}).get("nodes", []):
                        c_author = normalize_login(c.get("author", {}).get("login"))
                        c_dt = parse_dt(c.get("createdAt"))
                        if c_author == "coderabbitai" and c_dt and c_dt > latest_summon_dt:
                            cr_after.append((c_dt, c))
                    cr_after.sort(key=lambda x: x[0])
                    first_cr_reply = cr_after[0][1] if cr_after else None

                    if first_cr_reply is not None:
                        reply_body = first_cr_reply.get("body") or ""
                        if "does not re-review already reviewed commits" in reply_body:
                            has_pending_summon = False
                            summon_body = "@coderabbitai full review"
                        elif is_rate_limit_comment(first_cr_reply):
                            has_pending_summon = False
                        elif "initiate chat" in reply_body:
                            has_pending_summon = False
                        else:
                            has_pending_summon = True
                    else:
                        has_pending_summon = True

                if has_pending_summon:
                    candidate_reason = "summon already pending on this head"
                else:
                    if cr_reviewed_before:
                        if unresolved_cr_threads_all_replied:
                            candidate_class = "re-review"
                            is_cand = True
                        else:
                            candidate_reason = "fixes pending: unresolved CodeRabbit threads without a reply"
                    else:
                        candidate_class = "new"
                        is_cand = True

            action_cls = "excluded" if is_excluded else (candidate_class or "-")
            action_item = Action(
                kind="none",
                repo=repo,
                pr_number=pr_number,
                title=title,
                cls=action_cls,
                reason=candidate_reason if (candidate_reason and not is_cand and not is_excluded and not cr_reviewed_head) else merge_reason,
                pr_id=pr_id,
                head_oid=head,
                summon_body=summon_body,
                merge_reason=merge_reason,
                candidate_reason=candidate_reason,
            )
            actions.append(action_item)

            if is_cand:
                candidates.append({
                    "action": action_item,
                    "candidate_class": candidate_class,
                    "committed_date": committed_date or datetime.min.replace(tzinfo=timezone.utc),
                    "created_at": parse_dt(pr.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc),
                    "summon_body": summon_body,
                })

    # 3. Pick at most one summon across all repos
    if budget_blocked:
        for cand in candidates:
            cand["action"].reason = budget_reason
            cand["action"].candidate_reason = budget_reason
    elif candidates:
        re_reviews = [c for c in candidates if c["candidate_class"] == "re-review"]
        news = [c for c in candidates if c["candidate_class"] == "new"]

        re_reviews.sort(key=lambda c: c["committed_date"])
        news.sort(key=lambda c: c["created_at"])

        ordered_candidates = re_reviews + news
        picked = ordered_candidates[0]
        picked_action = picked["action"]
        picked_action.kind = "summon"
        picked_action.reason = "summon"
        picked_action.summon_body = picked["summon_body"]

    return actions


def format_markdown_table(actions: list[Action]) -> str:
    lines = [
        "| PR | Title | Class | Action or Reason |",
        "| :--- | :--- | :--- | :--- |",
    ]
    for a in actions:
        pr_str = f"{a.repo}#{a.pr_number}" if a.pr_number else a.repo
        title = (a.title[:57] + "...") if len(a.title) > 60 else a.title
        title = title.replace("|", "\\|")
        lines.append(f"| {pr_str} | {title} | {a.cls} | {a.reason} |")
    return "\n".join(lines)


def apply(actions: list[Action], tokens: dict[str, str], dry_run: bool = False, http_client: Any = None) -> int:
    if dry_run:
        for a in actions:
            if a.kind == "merge":
                print(f"[dry-run] Would merge {a.repo}#{a.pr_number} (expectedHeadOid: {a.head_oid[:7]})")
            elif a.kind == "enqueue":
                print(f"[dry-run] Would enqueue {a.repo}#{a.pr_number} (expectedHeadOid: {a.head_oid[:7]})")
            elif a.kind == "summon":
                print(f"[dry-run] Would post comment to {a.repo}#{a.pr_number}: {a.summon_body}")
        return 0

    # Real mutation calls happen strictly below this point.
    failures = 0
    for a in actions:
        owner = a.repo.split("/", 1)[0]
        token = tokens.get(owner)
        if not token:
            print(f"Skipping {a.repo}#{a.pr_number}: missing token for owner {owner}", file=sys.stderr)
            continue

        try:
            if a.kind == "merge":
                mutation = """
                mutation($input: MergePullRequestInput!) {
                  mergePullRequest(input: $input) { clientMutationId }
                }
                """
                _graphql_query(token, mutation, {
                    "input": {
                        "pullRequestId": a.pr_id,
                        "mergeMethod": "SQUASH",
                        "expectedHeadOid": a.head_oid,
                    }
                })
                print(f"Merged {a.repo}#{a.pr_number}")
            elif a.kind == "enqueue":
                mutation = """
                mutation($input: EnqueuePullRequestInput!) {
                  enqueuePullRequest(input: $input) { clientMutationId }
                }
                """
                _graphql_query(token, mutation, {
                    "input": {
                        "pullRequestId": a.pr_id,
                        "expectedHeadOid": a.head_oid,
                    }
                })
                print(f"Enqueued {a.repo}#{a.pr_number}")
            elif a.kind == "summon":
                owner, name = a.repo.split("/", 1)
                url = f"https://api.github.com/repos/{owner}/{name}/issues/{a.pr_number}/comments"
                payload = json.dumps({"body": a.summon_body}).encode("utf-8")
                _http_request(url, token, data=payload)
                print(f"Summoned on {a.repo}#{a.pr_number}: {a.summon_body}")
        except (urllib.error.URLError, RuntimeError) as e:
            failures += 1
            print(f"Failed {a.kind} on {a.repo}#{a.pr_number}: {e}", file=sys.stderr)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Hourly review queue runner")
    parser.add_argument("--dry-run", action="store_true", help="Run without posting mutations")
    parser.add_argument("--repos", help="Comma-separated repo list (default: standard repos)")
    parser.add_argument("--snapshots", help="Path to JSON snapshots file to load")
    parser.add_argument("--dump-snapshots", help="Path to save captured snapshots JSON")
    parser.add_argument("--pr", help="Debug flag: collect single PR in any state (owner/repo#n)")
    args = parser.parse_args()

    tokens = {}
    for owner, env_var in TOKEN_ENV.items():
        val = os.environ.get(env_var)
        if val:
            tokens[owner] = val

    pr_filter_repo = None
    pr_filter_num = None
    if args.pr:
        if "#" not in args.pr or "/" not in args.pr:
            sys.exit("Error: --pr must be in format owner/repo#number")
        pr_filter_repo, num_str = args.pr.split("#", 1)
        pr_filter_num = int(num_str)

    if args.snapshots:
        with open(args.snapshots, "r", encoding="utf-8") as f:
            snapshots = json.load(f)
    else:
        if pr_filter_repo:
            target_repos = [pr_filter_repo]
        elif args.repos:
            target_repos = [r.strip() for r in args.repos.split(",") if r.strip()]
        else:
            target_repos = REPOS

        snapshots = {}
        for r in target_repos:
            owner = r.split("/", 1)[0]
            token = tokens.get(owner)
            num = pr_filter_num if r == pr_filter_repo else None
            try:
                snapshots[r] = collect(r, token, pr_number=num)
            except (urllib.error.URLError, RuntimeError, ValueError) as e:
                snapshots[r] = {"repo": r, "error": f"collect failed: {e}", "pull_requests": []}

    if args.dump_snapshots:
        dump_path = pathlib.Path(args.dump_snapshots)
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dump_path, "w", encoding="utf-8") as f:
            json.dump(snapshots, f, indent=2)

    now = datetime.now(timezone.utc)
    actions = decide(snapshots, now)

    table = format_markdown_table(actions)
    print(table)

    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write(table + "\n")

    failures = apply(actions, tokens, dry_run=args.dry_run)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
