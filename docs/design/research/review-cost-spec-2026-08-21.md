# Spec — review-lane inference cost (2026-08-21)

Origin: "can we revive a Claude Code session so we don't pay inference again?"
Explored with a 9-agent workflow (5 research → synthesis → 3 adversarial refutations).
**All three candidate designs were refuted.** What follows is what survived, plus one finding
measured after the refutations, which is the only change I'd actually ship.

## 1. The premise is dead — measured, not argued

`--resume` is a local-disk transcript replay. It rebuilds the message array and **re-sends every
token as input**. Measured in a two-turn experiment: turn 1 = 24,424 cache_read / 20,102 cache_write;
turn 2 = 44,526 cache_read / 2,051 cache_write. Turn 2 re-read turn 1's entire prefix.

Three consequences:

- Reviving a session makes the prefix **longer**, permanently, for every later turn.
- The transcript does not contain the expensive part. **Subagent conversations are not resumable** —
  only their summaries return — and subagent context is ~85% of input volume.
- Output tokens are never cached. Inference on new output is paid in full regardless.

There is no server-side conversation object to point at; the Messages API is stateless.
**The lever is fewer tokens, not cheaper tokens.**

## 2. Caching is already working — this was the other surprise

From the canary run (`32513183337`, mage-memory#176, 19 turns, 642s API, `total_cost_usd` 2.30):

| | tokens |
|---|---:|
| cache_read | 3,013,500 |
| cache_creation | 369,652 |
| output | 60,309 |
| **uncached input** | **192** |

8:1 read:write, and essentially **zero** uncached input. The 1-hour TTL is already in use. There is
no meaningful prefix-stability win left to harvest — the "optimise prompt caching" family of ideas
is chasing a problem that is already solved.

## 3. What I found after the refutations — the one shippable change

Every researcher hypothesised about the permission denials; none read them. I did.

**18 denials in one run**, and the pattern is not what was assumed (redirects/pipes). It is that the
allowlist has **no way to list the repo tree**:

| count | family | in `--allowed-tools`? |
|---:|---|---|
| 7 | `gh api …/git/trees/…`, `gh api …/contents/…` | **no** — only `gh pr *` / `gh issue *` / `gh search` |
| 5 | `git ls-tree`, `git log`, `git fetch`, **`git clone --depth 1`** ×2 | **no** |
| 2 | multi-line `set -e` scripts | no |
| 1 each | `cd`, `bash -c`, `mkdir`, `ls` | no |

**Root cause.** Vendored step 2 says *"Launch a sonnet agent to return a list of file paths for all
relevant CLAUDE.md files"*, and upstream's Notes say *"Use gh CLI to interact with GitHub."* So
agents reach for `gh api .../git/trees/...`, get denied, and retry with different quoting — twice
attempting a **full `git clone` of the repo that is already checked out beside them**.

Meanwhile `Glob` is already in the allowlist and answers the question instantly against the local
checkout.

**Fix — prompt, not allowlist.** Amend step 2 to say: use `Glob` against the checked-out repository
to find CLAUDE.md files; do not use `gh api` or `git`. One sentence.

Deliberately **not** widening `--allowed-tools`: `Bash(gh api:*)` would grant the read-only review
job the entire GitHub API surface, and the tool list is load-bearing (`#403`). Adding `git clone`
would be worse.

**Expected saving: unquantified, and I will not invent a number.** The refutation correctly showed
the earlier 10–15% estimate was unsupported arithmetic over an unobserved denial population. What is
certain: 18 wasted round trips per run, each re-sending its context, plus two attempted repo clones.

**Verification is binary, which is why this is the one worth shipping.** `permission_denials` must
go to **0** in the run log. Not an inference, not a delta on a noisy metric — a count that is either
zero or not. `show_full_output: true` is already on, so the diagnostic is free and already there.

## 4. Refuted — do not build

- **Session-transcript persistence** (`actions/cache` / artifacts). Fails on cost (resume re-sends
  everything, and a revived run is a guaranteed cold write of a *larger* prefix), on structure
  (cannot reach the ~85% that lives in subagents), on mechanics (a stable key against a stable ref
  reproduces the 409 that `claude-code-action` already documents and works around at `setup-bun`),
  and on **security** — the review job is pinned `pull-requests: read` precisely because the token
  must not hold write power over attacker-influencable diff text, and a restored transcript replays
  that text as authoritative *history* ahead of the new instructions.
- **Reordering the prompt for cross-PR prefix sharing.** The `<repo>#<n>` interpolation sits at byte
  43 of ~7,100. Hoisting it lifts the shared prefix from ~16 to ~1,635 tokens ≈ **0.27%**, and it
  would move the review *target identifier* to the tail — where my own measurement
  (`slash-command-override-unreliable`) says instructions lose 50–67% of the time.
- **Serialising the fan-out for cache hits.** True that N concurrent identical prefixes all miss, but
  subagents build their own contexts, so most of the write term is irreducible — and serialising
  four agents on a run that already takes 10+ minutes trades PR-visible latency for cents.
- **Message Batches.** No CLI path, up to 24h turnaround, the review is a dependent tool-use loop,
  and `--betas` is API-key-only.
- **`--agents <json>` to pin subagent models.** The flag *defines* agent types; it does not *bind*
  them — the orchestrator still chooses. It replaces "hope prose is obeyed" with a differently
  shaped hope, and it adds a second tool-scoping surface that can silently produce
  "No issues found" on a green run. That is `#403`/`#410` verbatim.
- **Incremental review as a *cost* lever.** It is a coverage change and is worth building, but the
  "40–70% saving" attributed to my own spec is a **fabricated citation** — that spec contains zero
  cost figures. Worse, against the real baseline it may *raise* fix-round cost: today a fix round
  runs `verify`, a single-agent prompt; the spec deletes `verify` and routes every round through the
  four-agent fan-out. Build it for correctness. Do not claim it saves money.

## 5. The question that outranks all of this

**Does this lane ever actually hit a limit?**

Auth is `CLAUDE_CODE_OAUTH_TOKEN` — a subscription seat, not a metered key. `total_cost_usd` is the
CLI's *local* computation from list rates; there is no invoice. Observed: **$2.30** (zero-finding
run) and **$4.07** (18-file run, also zero findings — so zero validation subagents fired; a
finding-rich run is materially more expensive and has never been measured).

If the aggregate is a rounding error against the seat allowance, then the real currency is not
dollars at all — it is the **10–14 minutes of PR-visible latency**, and the entire ranking should be
re-sorted by wall-clock, which promotes `--effort` and demotes everything else.

**Answer this before building anything beyond §3.** It costs nothing: read `total_cost_usd` off the
last five review runs in each of the three consumer repos and compare the aggregate to the seat
allowance.

## 6. Unresolved conflicts, recorded rather than smoothed

- **Subagent cache TTL.** Docs say subagents use the 5-minute TTL even on a subscription. The
  measured run reports `ephemeral_1h_input_tokens: 31,673` and `ephemeral_5m_input_tokens: 0` — zero
  5-minute tokens across a run with six subagents. Either the figure covers only the main thread or
  the doc is stale.
- **Whether the system prefix can be warm across runs at all.** One researcher extracted from the
  CLI binary that the dynamic system-prompt branch renders a scratchpad path containing the
  **session UUID**, which would force a cold system prefix every invocation. Another measured six
  local first-requests and found three warm — impossible if a fresh UUID sits in the cached prefix.
  Most likely breakpoint placement upstream of the dynamic section; unverified.
- **Whether `--exclude-dynamic-system-prompt-sections` is reachable.** One says it passes through
  `claude_args`; another read the action's source and found it hardcodes
  `systemPrompt = {type: "preset", preset: "claude_code"}` and drives the CLI in stream-json control
  mode, so the CLI-side flag may be ignored. One canary reading `cache_read_input_tokens` resolves
  it — and it is a ≤3% lever, so spend no more than that.
