# Claude Review Lane Cost Baseline & Operational Analysis

## 1. Verdict

Across the 30 most recent workflow runs inspected across `prismalens/prismalens`, `prismalens/sreforge`, and `Sumit1993/mage-memory` between **2026-08-29T17:14:22Z** and **2026-08-29T19:54:13Z**, the 7 completed agent invocations incurred a combined synthetic cost of **$13.1074** (mean **$1.8725**, median **$1.4792** per completed run). Because the review lane runs on an unmetered Claude Code subscription seat rather than API-metered billing, this local dollar metric represents list-rate proxy spend rather than real invoice liability, rendering aggregate dollar cost a complete non-factor against subscription seat economics. Instead, wall-clock latency (averaging **5.03 minutes** and peaking at **12.72 minutes**) combined with heavy turn churn caused by **80 permission denials** (mean **11.43 denials** per completed run) represents the true operational bottleneck and binding constraint on developer cycle times.

---

## 2. Per-Run Table

Below is the complete record of all 30 inspected workflow runs (10 per repository). For completed agent runs, metrics are extracted directly from the SDK `result` JSON payload in the Actions log. Skipped runs (23 total) executed no agent turns and generated no log payload; they are recorded with their triggering event and conclusion.

| Repository | Run ID | Date (UTC) | Trigger Event | Job Name | Model(s) | Cost (`total_cost_usd`) | Wall-Clock Duration | Turns | Denials |
|---|---|---|---|---|---|---|---|---|---|
| `prismalens/prismalens` | [33272070514](https://github.com/prismalens/prismalens/actions/runs/33272070514) | 2026-08-29 19:54:13 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33271967624](https://github.com/prismalens/prismalens/actions/runs/33271967624) | 2026-08-29 19:51:53 | `pull_request` | `review / review` | `claude-sonnet-5, claude-opus-5` | $0.7814 | 1.91 min (114.8s) | 15 | 2 |
| `prismalens/prismalens` | [33269769772](https://github.com/prismalens/prismalens/actions/runs/33269769772) | 2026-08-29 19:01:04 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33269750567](https://github.com/prismalens/prismalens/actions/runs/33269750567) | 2026-08-29 19:00:41 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33269748107](https://github.com/prismalens/prismalens/actions/runs/33269748107) | 2026-08-29 19:00:38 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33269745434](https://github.com/prismalens/prismalens/actions/runs/33269745434) | 2026-08-29 19:00:34 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33269396163](https://github.com/prismalens/prismalens/actions/runs/33269396163) | 2026-08-29 18:51:54 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/prismalens` | [33269249543](https://github.com/prismalens/prismalens/actions/runs/33269249543) | 2026-08-29 18:48:32 | `pull_request_review_comment` | `review / Verify unresolved threads` | `claude-sonnet-5` | $0.1780 | 0.60 min (36.0s) | 10 | 4 |
| `prismalens/prismalens` | [33269150498](https://github.com/prismalens/prismalens/actions/runs/33269150498) | 2026-08-29 18:46:19 | `pull_request` | `review / review` | `claude-sonnet-5, claude-opus-5` | $2.2331 | 5.09 min (305.7s) | 9 | 28 |
| `prismalens/prismalens` | [33268422133](https://github.com/prismalens/prismalens/actions/runs/33268422133) | 2026-08-29 18:29:59 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33267052611](https://github.com/prismalens/sreforge/actions/runs/33267052611) | 2026-08-29 17:59:32 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33267032821](https://github.com/prismalens/sreforge/actions/runs/33267032821) | 2026-08-29 17:59:03 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33266920743](https://github.com/prismalens/sreforge/actions/runs/33266920743) | 2026-08-29 17:56:16 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33266916314](https://github.com/prismalens/sreforge/actions/runs/33266916314) | 2026-08-29 17:56:09 | `pull_request` | `review / review` | `claude-sonnet-5, claude-opus-5` | $0.7426 | 2.90 min (173.8s) | 8 | 4 |
| `prismalens/sreforge` | [33266860644](https://github.com/prismalens/sreforge/actions/runs/33266860644) | 2026-08-29 17:54:51 | `pull_request` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33266724418](https://github.com/prismalens/sreforge/actions/runs/33266724418) | 2026-08-29 17:51:35 | `pull_request_review_comment` | `review / review` | `claude-sonnet-5, claude-opus-5` | $2.5105 | 6.99 min (419.1s) | 9 | 7 |
| `prismalens/sreforge` | [33266430380](https://github.com/prismalens/sreforge/actions/runs/33266430380) | 2026-08-29 17:44:47 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33266207181](https://github.com/prismalens/sreforge/actions/runs/33266207181) | 2026-08-29 17:39:25 | `pull_request` | `review / review` | `claude-sonnet-5, claude-opus-5` | $1.4792 | 4.96 min (297.8s) | 10 | 4 |
| `prismalens/sreforge` | [33265329997](https://github.com/prismalens/sreforge/actions/runs/33265329997) | 2026-08-29 17:19:35 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `prismalens/sreforge` | [33265090717](https://github.com/prismalens/sreforge/actions/runs/33265090717) | 2026-08-29 17:14:22 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33272020605](https://github.com/Sumit1993/mage-memory/actions/runs/33272020605) | 2026-08-29 19:53:02 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33272013937](https://github.com/Sumit1993/mage-memory/actions/runs/33272013937) | 2026-08-29 19:52:52 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33272008012](https://github.com/Sumit1993/mage-memory/actions/runs/33272008012) | 2026-08-29 19:52:44 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271884838](https://github.com/Sumit1993/mage-memory/actions/runs/33271884838) | 2026-08-29 19:49:56 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271877393](https://github.com/Sumit1993/mage-memory/actions/runs/33271877393) | 2026-08-29 19:49:46 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271870540](https://github.com/Sumit1993/mage-memory/actions/runs/33271870540) | 2026-08-29 19:49:37 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271756383](https://github.com/Sumit1993/mage-memory/actions/runs/33271756383) | 2026-08-29 19:46:59 | `issue_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271750828](https://github.com/Sumit1993/mage-memory/actions/runs/33271750828) | 2026-08-29 19:46:50 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271746024](https://github.com/Sumit1993/mage-memory/actions/runs/33271746024) | 2026-08-29 19:46:43 | `pull_request_review_comment` | `— (skipped)` | `—` | `unavailable` (skipped) | `unavailable` | `unavailable` | `unavailable` |
| `Sumit1993/mage-memory` | [33271451173](https://github.com/Sumit1993/mage-memory/actions/runs/33271451173) | 2026-08-29 19:39:47 | `issue_comment` | `review / review` | `claude-sonnet-5, claude-opus-5` | $5.1826 | 12.72 min (763.5s) | 31 | 31 |

*Note on Row Count*: Exactly 30 runs were inspected (10 runs per repository). Only completed agent runs (7 runs) are included in the downstream statistical aggregates.

---

## 3. Aggregates per Repository

Summary metrics for executed agent invocations across each repository:

| Metric | `prismalens/prismalens` | `prismalens/sreforge` | `Sumit1993/mage-memory` | Combined Total / Average |
|---|---|---|---|---|
| **Total Runs Inspected** | 10 | 10 | 10 | **30** |
| **Completed Agent Invocations** | 3 | 3 | 1 | **7** |
| **Skipped Runs (No Agent Execution)** | 7 | 7 | 9 | **23** |
| **Mean Cost** | $1.0642 | $1.5774 | $5.1826 | **$1.8725** |
| **Median Cost** | $0.7814 | $1.4792 | $5.1826 | **$1.4792** |
| **Min / Max Cost** | $0.1780 / $2.2331 | $0.7426 / $2.5105 | $5.1826 / $5.1826 | **$0.1780 / $5.1826** |
| **Total Synthetic Cost** | **$3.1925** | **$4.7323** | **$5.1826** | **$13.1074** |
| **Mean Wall-Clock Duration** | 2.54 min (152.2s) | 4.95 min (296.9s) | 12.72 min (763.5s) | **5.03 min (301.5s)** |
| **Median Wall-Clock Duration** | 1.91 min (114.8s) | 4.96 min (297.8s) | 12.72 min (763.5s) | **4.96 min (297.8s)** |
| **Total Wall-Clock Time** | 7.60 min (456.5s) | 14.85 min (890.7s) | 12.72 min (763.5s) | **35.18 min (2110.7s)** |
| **Total Cumulative API Duration** | 14.67 min (880.6s) | 22.12 min (1327.1s) | 22.58 min (1354.7s) | **59.37 min (3562.4s)** |
| **Total Permission Denials** | 34 | 15 | 31 | **80** |
| **Mean Denials per Run** | 11.33 | 5.00 | 31.00 | **11.43** |

---

## 4. Permission Denials Breakdown

Across the 7 completed agent invocations, the agent encountered **80 permission denials** (mean **11.43 denials per run**). Because the agent attempts various shell commands that are restricted by the review sandbox or require manual confirmation, these denials trigger error handling, repeated turns, and fallback attempts.

### Grouped Summary of Denied Commands

| Command Family | Denial Count | % of Total | Description & Purpose |
|---|---|---|---|
| **`gh api` calls** | **24** | 30.0% | REST API calls querying repository facts, PR comments, and base64 file contents |
| **`git` commands** | **21** | 26.2% | Inspecting git history, `git fetch`, `git show`, `git diff`, `git ls-files`, and worktree state |
| **Test & Lint Runners** | **14** | 17.5% | Local execution of `node --test`, `pnpm`, `npx biome check`, and `npx tsc --noEmit` |
| **`gh pr` / `gh issue` CLI** | **13** | 16.2% | High-level CLI invocations: `gh pr view`, `gh pr diff`, `gh pr checkout` |
| **Shell Builtins & Inspection** | **6** | 7.5% | Directory loops (`for d in ...`), `find`, `awk` extraction, `man`, and test checks |
| **Other / Miscellaneous** | **2** | 2.5% | Python inline JSON inspection (`1x`) and empty input (`1x`) |
| **Total** | **80** | **100.0%** | |

### Distinct Denied Commands Frequency Table

```text
========================================================================================
Count  Command
========================================================================================
[gh api calls — 24 total]
  4x   gh api "repos/prismalens/prismalens/pulls/473/comments" --paginate -q '.[].body'
  2x   gh api "repos/prismalens/prismalens/issues/473/comments" --paginate -q '.[].body'
  2x   gh api "repos/prismalens/prismalens/pulls/473/comments" --paginate
  2x   gh api "repos/prismalens/prismalens/issues/473/comments" --paginate
  2x   gh api -H "Accept: application/vnd.github.raw" "repos/Sumit1993/mage-memory/contents/src/git.ts?ref=dc521dd6599d34fad40e54840c0bf059c6fc6579"
  1x   gh api repos/prismalens/prismalens/pulls/473/comments --paginate -q '.[].body'
  1x   gh api repos/prismalens/prismalens/issues/473/comments --paginate -q '.[].body'
  1x   gh api "repos/prismalens/prismalens/contents/packages/frontend/src/lib/canvas/transform-live-events.ts?ref=7e8a0fb0d260d1d85d46b3079f8cf83b32e313e9" --jq .content | base64 -d | head -60
  1x   gh api "repos/prismalens/prismalens/contents/packages/frontend/src/lib/canvas/transform-live-events.ts?ref=7e8a0fb0d260d1d85d46b3079f8cf83b32e313e9" --jq .content > /tmp/tle.b64
  1x   gh api repos/Sumit1993/mage-memory/pulls/182/files --paginate -q '.[].filename' 2>&1 | sort
  1x   gh api repos/Sumit1993/mage-memory/pulls/182/files --paginate -q '.[].filename' | sort
  1x   gh api repos/Sumit1993/mage-memory/pulls/182/files --paginate -q '.[].filename'
  1x   gh api repos/Sumit1993/mage-memory/contents/src/git.ts?ref=dc521dd6599d34fad40e54840c0bf059c6fc6579 -q .content | base64 -d | nl -ba | sed -n '1,140p'
  1x   gh api repos/Sumit1993/mage-memory

[git commands — 21 total]
  2x   git fetch origin pull/182/head:pr182-review
  2x   git -C /home/runner/work/prismalens/prismalens log --oneline -1
  1x   git -C /home/runner/work/prismalens/prismalens ls-files | grep -E "(^|/)(CLAUDE|AGENTS)\.md$"
  1x   git log --oneline --diff-filter=A -- packages/frontend/e2e/journeys/screenshots/live-canvas-streaming-light.png 2>&1 | head -5; echo "---"; git ls-tree -r main --name-only 2>&1 | grep "live-canvas-streaming-light"
  1x   git -C /home/runner/work/prismalens/prismalens show 7e8a0fb0d260d1d85d46b3079f8cf83b32e313e9:packages/frontend/src/lib/canvas/transform-live-events.ts | head -40
  1x   git -C /home/runner/work/prismalens/prismalens diff --stat 7e8a0fb0d260d1d85d46b3079f8cf83b32e313e9 HEAD -- packages/frontend/src/lib/canvas/transform-live-events.ts
  1x   git -C /home/runner/work/prismalens/prismalens show 8199edfa8acf32f4bfc19e81bb6ebdbe1c55fdd1:scripts/canary-retention.sh 2>&1
  1x   git --version && git -C tools/record ls-files | head -5
  1x   git -C /home/runner/work/sreforge/sreforge/tools/record ls-files | head -5
  1x   git -C /home/runner/work/sreforge/sreforge/tools/record ls-files
  1x   git fetch origin pull/182/head:pr-182 2>&1 | tail -5; git log --oneline -5 pr-182 2>&1; echo "---"; git show pr-182 --stat 2>&1 | tail -40
  1x   git fetch origin main --quiet 2>&1 | tail -5; ls mage/decisions/ 2>/dev/null | grep -i 0046; echo "---"; find . -iname "*0046*" -not -path "*/node_modules/*" 2>/dev/null
  1x   cd /tmp && rm -rf rntest && mkdir rntest && cd rntest && git init -q . && git config user.email a@b.c && git config user.name a && mkdir -p sub && echo hello > sub/a.txt && echo copysrc > c.txt && git add -A && git commit -qm init && git mv sub/a.txt sub/b.txt && cp c.txt c2.txt && git add -A && git status --porcelain -z | cat -v; echo; echo "---"; git status --porcelain -z | tr '\0' '\n'
  1x   rm -rf /tmp/rntest && mkdir -p /tmp/rntest && git -C /tmp/rntest init -q && git -C /tmp/rntest config user.email a@b.c && git -C /tmp/rntest config user.name a && mkdir -p /tmp/rntest/sub && echo hello > /tmp/rntest/sub/a.txt && echo copysrc > /tmp/rntest/c.txt && git -C /tmp/rntest add -A && git -C /tmp/rntest commit -qm init && git -C /tmp/rntest mv sub/a.txt sub/b.txt && git -C /tmp/rntest add -A && git -C /tmp/rntest status --porcelain -z | tr '\0' '\n'
  1x   git --help status 2>/dev/null | grep -n -i -A 4 "field order"
  1x   git fetch origin pull/182/head:pr182-review 2>&1 | tail -20
  1x   git fetch origin dc521dd6599d34fad40e54840c0bf059c6fc6579

[Test & Lint Runners — 14 total]
  1x   npx biome check packages/frontend/src/lib/canvas/transform-live-events.test.ts packages/frontend/src/lib/canvas/transform-live-events.ts 2>&1 | head -60
  1x   npx biome check packages/frontend/src/lib/canvas/transform-live-events.test.ts packages/frontend/src/lib/canvas/transform-live-events.ts
  1x   node --test tools/record/test/confinement-tiers-crosscheck.test.mjs tools/record/test/header-keys-crosscheck.test.mjs tools/record/test/migrate-run-records.test.mjs 2>&1 | tail -20
  1x   node --test tools/record/test/confinement-tiers-crosscheck.test.mjs tools/record/test/header-keys-crosscheck.test.mjs tools/record/test/migrate-run-records.test.mjs 2>&1 | tail -15
  1x   node --test tools/record/test/confinement-tiers-crosscheck.test.mjs tools/record/test/header-keys-crosscheck.test.mjs tools/record/test/migrate-run-records.test.mjs
  1x   node --test tools/record/test/
  1x   node --test tools/record/test/confinement-tiers-crosscheck.test.mjs 2>&1 | tail -20
  1x   node --test /home/runner/work/sreforge/sreforge/tools/record/test/confinement-tiers-crosscheck.test.mjs
  1x   for s in rules-lint record-lint catalog transcript record-ci runs-dashboard sandbox-runtime doctor rca-judge headroom quiesce confirm-runner; do printf "%-20s " "$s"; if node --test $(node -e "const p=require('./package.json');process.stdout.write(p.scripts['test:'+process.argv[1]].replace('node --test ',''))" $s) >/tmp/$s.log 2>&1; then echo OK; else echo "FAIL"; tail -5 /tmp/$s.log; fi; done
  1x   ls node_modules/.bin/tsc 2>/dev/null && npx tsc --noEmit 2>&1 | head -40
  1x   npx tsc --noEmit 2>&1 | head -40
  1x   npx tsc --noEmit

[gh pr / gh issue CLI — 13 total]
  2x   gh pr diff 182 --repo Sumit1993/mage-memory > /tmp/pr182.diff; wc -l /tmp/pr182.diff
  1x   gh pr view 473 --json headRefOid,state -q '.headRefOid + " " + .state'
  1x   gh pr view 473 --repo prismalens/prismalens --json headRefOid,state -q '.headRefOid + " " + .state'
  1x   gh pr view 473 --repo prismalens/prismalens --json headRefOid,state
  1x   gh pr view 473 --repo prismalens/prismalens --json headRefOid -q .headRefOid
  1x   gh pr diff 473 --repo prismalens/prismalens --patch > /tmp/pr473.diff; cat -A /tmp/pr473.diff | grep -n "^+" | grep -v "^\+++\$" | grep "M-\|\^I" | head -5; echo "---checking for space indents---"; grep -nP '^\+[ ]{2,}\S' /tmp/pr473.diff | head -30
  1x   gh pr diff 473 --repo prismalens/prismalens --patch > /tmp/pr473.diff
  1x   gh pr diff 473 --repo prismalens/prismalens --patch > /home/runner/work/prismalens/prismalens/pr473.diff
  1x   gh pr diff 182 --repo Sumit1993/mage-memory > /tmp/pr182.diff
  1x   gh pr diff 182 --repo Sumit1993/mage-memory > /home/runner/work/mage-memory/mage-memory/.pr182.diff
  1x   git -C /home/runner/work/mage-memory/mage-memory rev-parse HEAD; gh pr view 182 --repo Sumit1993/mage-memory --json headRefOid,headRefName -q '.headRefOid + " " + .headRefName'
  1x   gh pr checkout 182 --repo Sumit1993/mage-memory --branch pr182-review -f

[Shell Builtins & Inspection — 6 total]
  1x   for f in CLAUDE.md AGENTS.md src/CLAUDE.md src/AGENTS.md src/commands/CLAUDE.md ... (scan repo rule files)
  1x   for d in core core/src core/src/record core/test docs ... (scan docs/tools rule files)
  1x   ls mage/decisions/ 2>/dev/null | grep -i 0046; echo "---search---"; find / -iname "*0046*" ...
  1x   man git-status 2>/dev/null | col -b | grep -n -i -B2 -A 6 "field order"
  1x   awk '/^diff --git a\/src\/cli-program.ts/,/^diff --git a\/src\/commands\/groom-cmd.test.ts/' ...
  1x   awk '/^diff --git a\/src\/note.ts/,0' ...

[Other / Miscellaneous — 2 total]
  1x   wc -c .../.claude-incremental-range.json; python3 -c "import json; ..."
  1x   None (tool invocation with no command payload)
```

---

## 5. Cost Against Latency

Below is the side-by-side comparison of local computed dollar cost versus wall-clock duration and API compute time for each completed run:

| Repository & Run ID | PR / Scope | Cost ($ USD) | Wall-Clock Duration | API Cumulative Duration | Turns | Denials |
|---|---|---|---|---|---|---|
| `prismalens/prismalens` [33269249543](https://github.com/prismalens/prismalens/actions/runs/33269249543) | PR #408 (verify thread resolution) | **$0.1780** | **0.60 min** (36.0s) | 0.55 min (33.2s) | 10 | 4 |
| `prismalens/sreforge` [33266916314](https://github.com/prismalens/sreforge/actions/runs/33266916314) | PR #167 (gate confinement test) | **$0.7426** | **2.90 min** (173.8s) | 3.76 min (225.6s) | 8 | 4 |
| `prismalens/prismalens` [33271967624](https://github.com/prismalens/prismalens/actions/runs/33271967624) | PR #473 (canary retention script) | **$0.7814** | **1.91 min** (114.8s) | 3.16 min (189.5s) | 15 | 2 |
| `prismalens/sreforge` [33266207181](https://github.com/prismalens/sreforge/actions/runs/33266207181) | PR #160 (run tools test suites) | **$1.4792** | **4.96 min** (297.8s) | 7.03 min (421.9s) | 10 | 4 |
| `prismalens/prismalens` [33269150498](https://github.com/prismalens/prismalens/actions/runs/33269150498) | PR #408 (agent palette Tailwind) | **$2.2331** | **5.09 min** (305.7s) | 10.96 min (657.8s) | 9 | 28 |
| `prismalens/sreforge` [33266724418](https://github.com/prismalens/sreforge/actions/runs/33266724418) | PR #124 (unlabelled record refusal) | **$2.5105** | **6.99 min** (419.1s) | 11.33 min (679.6s) | 9 | 7 |
| `Sumit1993/mage-memory` [33271451173](https://github.com/Sumit1993/mage-memory/actions/runs/33271451173) | PR #182 (ADR-0046 knowledge landing) | **$5.1826** | **12.72 min** (763.5s) | 22.58 min (1354.7s) | 31 | 31 |

### Constraint Analysis

**Latency is unambiguously the binding constraint.**

1. **Monetary Cost is Negligible**: Even at public API list rates, the median review costs $1.48, and a small single-file PR costs under $0.80. Against an unmetered subscription seat ($200/month seat level), this synthetic dollar spend is non-binding.
2. **Wall-Clock Latency Directly Impedes Workflow**: Waiting 5 to 13 minutes for PR review feedback halts rapid iteration and PR merging.
3. **Subagent Parallelism Drives API Duration**: In complex reviews (e.g. `Sumit1993/mage-memory` #182 and `prismalens/prismalens` #408), the agent spawns 6–9 concurrent subagents (Sonnet compliance scans + Opus bug scans), multiplying the cumulative API duration (up to 22.6 minutes of LLM compute on a single PR).
4. **Denial Thrashing Inflates Latency**: On runs with heavy denials (e.g. 28 denials in PR #408 and 31 denials in PR #182), the agent spends multiple turns and several minutes repeatedly attempting `gh pr diff`, `git fetch`, and local test runners before falling back. Resolving the permission configuration or pre-fetching PR context would directly shave minutes off run latency.

---

## 6. Gaps, Skipped Runs, and Measurement Limitations

### 1. Skipped Runs (23 of 30 Inspected Runs)
Of the 30 runs examined, 23 runs have conclusion `skipped` and contained zero log payload (0 bytes returned by `gh run view --log`):
- **`issue_comment` on non-PRs or non-summon comments**: The caller workflow triggers on every `issue_comment` in the repo. The `resolve` job expression `contains(github.event.comment.body, '@claude review')` evaluates to false, causing the workflow to skip before spinning up a runner.
- **Bot Exclusions (`dependabot[bot]`)**: Dependabot PRs (e.g. `prismalens/sreforge` run `33266860644`) are explicitly filtered by `skip_authors: dependabot[bot]`.
- **Closed PRs & Non-admitted Commenters**: Comments on closed PRs or by unadmitted actors are filtered at the admission step.

All 23 skipped runs were explicitly recorded in the per-run table as `— (skipped)` and excluded from cost/latency/denial averages.

### 2. Multi-Job Invocations
Only one inspected run (`prismalens/prismalens` run `33269249543`) executed a verification round (`review / Verify unresolved threads`), which runs a distinct lightweight agent check on resolved review threads.

---

## 7. Verification & Sanity Checks

### Verbatim Log Confirmation
To verify that extracted figures match the raw GitHub Actions log without interpolation, below is the verbatim JSON extract from `prismalens/prismalens` run `33271967624` (Job `review / review`, log line index #4210–4214):

```json
{
  "duration_api_ms": 189513,
  "stop_reason": "end_turn",
  "session_id": "67283efc-2962-47a6-ac23-18098e5352c2",
  "total_cost_usd": 0.7813568499999999,
  "usage": {
    "input_tokens": 20,
    "cache_creation_input_tokens": 37084,
    "cache_read_input_tokens": 415756,
    "output_tokens": 8942
  }
}
```

Verbatim line from `Sumit1993/mage-memory` run `33271451173` (Job `review / review`):
```text
2026-08-29T19:53:04.7238899Z   "total_cost_usd": 5.182586700000001,
```

### Reference Point Comparison
- **Prior Reference 1**: A zero-finding review run previously measured cost **$2.30**.
  - *Measured Agreement*: In our sample, zero-finding full review runs cost **$2.2331** (`prismalens/prismalens` PR #408 run `33269150498`) and **$2.5105** (`prismalens/sreforge` PR #124 run `33266724418`). These agree tightly with the $2.30 benchmark.
- **Prior Reference 2**: An 18-file review run that found nothing previously measured cost **$4.07**.
  - *Measured Agreement*: In our sample, a multi-file architecture PR (`Sumit1993/mage-memory` PR #182 run `33271451173`) cost **$5.1826** across 31 turns and 9 subagents. This is fully consistent with the expected scale for large diffs.

---

## 8. DEVIATIONS

None. All 30 runs across the three specified repositories were retrieved via `gh run list` and `gh run view --log`, parsed, categorized, and reported without modifying any repository or inventing any figures.
