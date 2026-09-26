# A self-hosted review service built on the lane's contract
Copied from the operator's draft on 2026-09-19 for prismalens/gh-workflows#184. Edit here; the draft is not maintained.

Written 2026-09-19 in the gh-workflows session. Inputs: the lane invariants and Worker
contract (verified against main), a survey of Kodus, Qodo PR-Agent, CodeRabbit self-hosted,
Bito and OpenHands (their own docs), the vendor terms and competitor survey of 2026-09-19
(`docs/design/review-engine-credentials.md`), prismalens ADR 0003 and
prismalens#639, and the #59 / #80 / #81 / #77 rulings. Placement and credentials follow the
#184 ruling of 2026-09-23: trigger and credential decide policy, and the runner has one
placement, `box`.

## 1. What this is for

Three pressures point the same way:

- The lane is Claude-shaped because Anthropic's action was the only way to run it, and the
  second engine ends that. Nothing else in the lane wants Claude: the prompt, the envelope,
  the verdicts and the sweep are engine-agnostic already.
- The lane runs on one person's subscription token, which lapses around 2026-09-23. A service
  that takes an API key with a spend cap, or a free model, does not depend on any one plan.
- #59 wants an open-source product with a named adopter. The hosted-app path in #80 was parked
  behind it. A self-hosted runner a solo engineer runs on a box, at no cost on a free model, is
  a better open-source story than a reusable workflow that only runs inside GitHub Actions.

The design keeps everything #59 says is worth publishing, and only moves where it runs.

## 2. Prior art, and where this differs

The proven self-hosting shape is a persistent webhook listener: one container (Bito,
CodeRabbit) or web + worker + queue + Postgres + vector store (Kodus, 8 GB RAM, public domain
required). Every one of them is BYOK by API key; LiteLLM or an OpenAI-compatible base URL is the
provider abstraction. Only PR-Agent and CodeRabbit read config from the default branch only, and
only PR-Agent says why. Only OpenHands sandboxes the agent. None posts a verdict when the
reviewer fails to run. None tracks cost per review. None compares two engines on one PR. None
takes a subscription credential, and neither does this as a service credential; the
first-party reviewers on a plan, Claude's action and Codex cloud review, are reviewers, and
this is the layer around any reviewer.

Kodus is AGPL-3.0 with a paid enterprise tier and a heavy stack. It is the wrong base to build
on: its value is AST and RAG plumbing, and its gaps (no base-ref trust rule while auto-ingesting
`AGENTS.md` and `CLAUDE.md`, no sandboxing, no cost tracking) are the lane's strengths.

This design differs from the standard shape in one deliberate way: the box has no inbound port.
The control plane already exists on Cloudflare, so the runner pulls, and the box needs no
public address.

## 3. Components

```
GitHub ──webhook──▶ Control plane (Cloudflare Worker + D1, exists today as the telemetry Worker)
                      • verifies HMAC, dedupes by delivery id
                      • admits or refuses (size, draft, fork, author, pause), records lane_event
                      • fetches config at base sha, resolves four layers
                      • enqueues a job, owns the liveness comment
                      • mints per-job read-only installation tokens
                      • posts findings and the summary (the only GitHub writer)
                      • ingests usage, findings, pr-state (unchanged routes)
                      • serves Assayer
                            ▲                     │
                 events, findings,                │ lease (long-poll)
                 usage, heartbeat                 ▼
                   Runner (a daemon on the adopter's box, one container per job)
                      • registers its credentials: engine, kind, fingerprint, concurrency
                      • leases one job per credential slot
                      • checks out base..head into a per-job engine container
                      • runs the engine adapter, streams normalized events
                      • never holds a GitHub write token
```

### 3.1 Control plane

The telemetry Worker grows a job queue and a poster. It keeps every existing route. New:

- `POST /webhook/github`: HMAC check with the App webhook secret, `X-GitHub-Delivery` dedupe,
  `pull_request` and `issue_comment` events, then the admission logic that lives in the
  `resolve` job today (fork guard, draft, author skip, pause, summon grammar, size refusal at
  the 6000 / 2000 line defaults from #105). Every refusal writes a `lane_event` with the same
  `reason` vocabulary the Worker already accepts.
- `jobs` table: `job_id`, `repository`, `pr_number`, `base_sha`, `head_sha`, `mode`
  (`review`, `review-full`, `incremental`), `level`, `model`, `config_effective`,
  `credential_fingerprint` (assigned at lease), `state` (`queued`, `leased`, `running`,
  `posted`, `failed`, `no-runner`), `leased_at`, `heartbeat_at`, `reset_at`.
- `GET /runner/lease` (long-poll, runner token): returns the oldest queued job whose engine and
  credential kind match a slot the runner offered, a read-only installation token scoped to
  that repository (`contents: read`, `pull_requests: read`, `issues: read`), the resolved
  config, the prompt template hash, and the manifest inputs the `build-prompt` step assembles
  today (profile, linked issues, CI failures, dependencies, base pull request). The control
  plane never stores the installation token and cannot revoke it. The runner revokes it on
  every exit path; a runner that dies without revoking leaves a read-only, one-repository
  token that lapses at GitHub's fixed one-hour expiry. Revoke a suspect runner with
  `DELETE /api/runners/:id`, which ends its leases and events immediately.
- `POST /runner/jobs/:id/events`: the normalized event stream (section 4). The control plane
  updates `heartbeat_at`, writes `round_agents`, and on `finished` writes `usage_records` with
  `credential_type`, `failure_class`, `level`, `config_effective` and the new nullable `engine`
  column.
- Poster: on `finished`, posts each finding as the existing four-part envelope through the
  installation's write token, posts the `## Code review` summary, and upserts the
  `<!-- claude-review-liveness` marker. The runner never sees the write token. This is the
  verify / mutate split from #20 moved off the box entirely.
- Liveness: the 18 verdicts today stay. Two are added: `no-runner` when no runner leases the
  job within `runner_timeout` (default 15 minutes), and `credential-cooldown` when
  `classify-failure` returned `rate-limited` or `account-limit` with a `reset_at`, in which
  case the job requeues for that time instead of failing. The cooldown is what makes a rate
  limit survivable: jobs wait, they do not die.
- Config: the resolver that is Python inside YAML today (lines 430 to 1130 and 1422 to 1560)
  becomes a package the Worker imports. Base-ref invariant kept: repo config is fetched at
  `base_sha`, never head, per #33. The shared layer is named by the repository itself, an
  optional `extends: owner/repo[@ref]` in that base-ref config, so neither the caller stub nor
  the control plane carries an org setting; without `extends` there is no shared layer (#182). The summon layer resolves here too, so all four layers
  land in `config_effective` (the migration 0010 comment already names `summon`).
- Telemetry provenance (#176) is solved structurally: the control plane is the only writer to
  D1 from GitHub events, and the runner authenticates with a runner token bound to its
  registration. `repository` on a usage record comes from the job, not from the payload.

### 3.2 Runner

One process that leases jobs, spawns an engine as an ACP child, maps the ACP session stream
onto assayer/v1 and streams it back. Config in a file:

```yaml
control_plane: https://assayer.example.workers.dev
runner_token: ${RUNNER_TOKEN}
placement: box                   # the only placement
credentials:
  - name: anthropic-capped
    engine: claude-code
    kind: api-key                # env ANTHROPIC_API_KEY, spend-capped in the console
    concurrency: 2
  - name: openrouter
    engine: opencode
    kind: api-key
    concurrency: 4
```

- On start it fingerprints each credential (SHA-256 of the material, first 12 hex) and
  registers `{engine, kind, fingerprint, concurrency, placement}`. The control plane stores
  metadata only. This is #77 built the cheap way: the registry is what runners declare.
- **Every job runs in two fresh containers** from an image built on the box and pinned by a hash
  of its inputs. Each runs with `--network none`, non-root and no runtime socket. Its only way
  out is the daemon's key proxy on a unix socket.
  - **Staging** checks the head out read-write and may reach `github.com` and `api.github.com`.
  - **The engine** gets the checkout read-only. It reaches the model only through the proxy,
    which sets the key on the wire, and `api.github.com` for `gh`.

  The permission policy is the lane's tool allowlist, answered by the ACP client, with no
  unrestricted shell. The policy is a guardrail; the container is the boundary.
- **No job runs without the container.** On every start, before it registers, the daemon
  resolves the image and runs a probe container. The probe proves: non-root, a read-only
  checkout, no runtime socket, no direct egress, the proxy refusing and allowing as it should,
  and no configured key in the environment. Any failure exits before a single control-plane
  call (`runner/README.md`).
- **The free path** is the same container with OpenCode on a free provider, or Claude Code
  behind an Anthropic-compatible local endpoint such as Ollama. It proves every part of the
  product at no cost.
- **The Actions lane** stays the zero-infrastructure path for adopters who bring an API key and
  will not run a box, reduced over time to "lease, run, stream". Inside Anthropic's own action
  it also accepts a `claude setup-token` credential, the form Anthropic documents there.


### 3.3 Engines

The engine seam is the Agent Client Protocol. The runner is one ACP client, built on
`@agentclientprotocol/sdk`, and prismalens's canonical stream adapter
(`packages/@prismalens/engine/src/adapter/acp-adapter.ts`) is the mapping it reuses. Adding
an engine is a registry row naming the adapter binary, its capabilities and the admission
record that passed. A native driver for an engine exists only against a gap recorded on that
row, the rule prismalens ADR 0003 §8 already applies.

| Engine | ACP adapter | Credential kinds | State |
|---|---|---|---|
| `opencode` | `opencode acp` | `api-key` for 75+ providers, free tiers and Ollama | verified green in prismalens#561; the day-one engine |
| `claude-code` | `claude-agent-acp` over the user's installed `claude` (`CLAUDE_CODE_EXECUTABLE`) | `api-key`, an Anthropic-compatible base URL; `bedrock`, `vertex`, `foundry` planned, refused by the runner today | passes the prismalens#639 gate |
| `codex` | `codex-acp` | `api-key` | deferred: permission gating fails on both transports in prismalens#639 |
| `diff-only` | none, one request to any OpenAI-compatible endpoint | `api-key`, keyless local | the PR-Agent shape; the zero-vendor floor |

What ACP carries, verified 2026-09-19: `session/update` with tool calls (`locations`,
`rawInput`, `rawOutput`), agent text, and since June 2026 `usage_update` with tokens and
`cost {amount, currency}`. `PromptResponse` carries only a stop reason. Findings therefore
travel as a tool call the client exposes: the runner offers the lane's comment tool as an MCP
server in `session/new`, and each call's `rawInput` is one `finding`. The subagent surfacing
is negotiated per the adapter's capability, flat by default.


## 4. The contract: assayer/v1

The event stream every engine emits and the control plane consumes. This is #81's contract,
written down as what a runner sends rather than what a dashboard shows.

```
started      {engine, model, credential_fingerprint, prompt_hash, lane_version}
read         {path}                                  # what the round read, for round_agents
agent        {agent_id, role, model, usage}          # subagent rows, as today
finding      {path, line, side, category, severity, effort, body,
              verification_note, ai_prompt, confirmed}
summary      {header, body}                          # header is the STEP9_HEADER value
usage        {input, output, cache_read, cache_write, cost_estimate_usd, model}
error        {failure_class, retryable, reset_at, message}
finished     {conclusion}
```

The poster renders `finding` into the four-part envelope the sweep already parses, and
`summary` into the `## Code review` comment. `review-findings-sweep.yml` filters threads by the
lane's bot login today; it gains an `engine` column on `review_findings` and matches the App's
login as well. The fate taxonomy on `/findings` is untouched.

## 5. Security model, mapped

| Lane invariant today | Service mechanism |
|---|---|
| Base-ref config (#33) | Control plane fetches at `base_sha`; runner never reads config from the checkout |
| Read-only review job (#20) | Per-job installation token with read scopes only, minted by the control plane |
| Verify / mutate split, id-token tripwire (#20) | Runner has no write token at all; the poster is the control plane; there is no OIDC path to trip |
| Fork guard | Admission refuses fork heads, `fork-notice` posted by the poster |
| Concurrency group per PR (#12) | `jobs` unique on `(repository, pr_number, state in queued/leased/running)`; a new head supersedes, as today |
| Admission from REST, not prose (#403, #410) | Webhook payload plus a REST re-read before enqueue |
| Size refusal, never trim (#105) | Same limits, same `refused-size` event and verdict |
| Prompt-injection blast radius | Engine container: read-only checkout, no shell, `--network none` with the key proxy as the only way out (the model upstream, and `api.github.com`), no key in its environment, non-root |
| Credential exfiltration through a finding | Poster refuses any finding body containing a registered credential fingerprint prefix or a secret-shaped token; findings are schema-validated and size-capped |
| Telemetry provenance (#176) | Runner token bound to registration; `repository` from the job |
| Adopter isolation | Each adopter creates their own GitHub App through the manifest flow; there is no shared app and no tenancy, per the 2026-08-31 self-host ruling |

The runner's key never enters the container. The engine holds a per-round nonce, and the daemon's
proxy swaps it for the key on the wire (#184, F1). The Actions lane still has its token in env.
What the table does not cover: exfiltration through the allowed upstreams, the engine appending
to the shared round directory, and kernel or runtime escapes. Rootful docker is root-equivalent,
so rootless podman is preferred.

## 6. Credentials the runner takes

The runner takes an API key or no credential at all. Cloud identities (`bedrock`, `vertex`,
`foundry`) are the planned next kinds: `runner/src/config.js` refuses them today as deferred.
It takes no subscription credential: the runner refuses `user-login` and the control plane has
no such kind.
The vendor terms behind that are in `docs/design/review-engine-credentials.md`.

- **Anthropic.** The legal page (code.claude.com/docs/en/legal-and-compliance) bars third
  parties from routing requests "through Free, Pro, or Max plan credentials" on users' behalf,
  and bars tools that "collect, store, or intermediate" the credential. `claude-code` rows take
  an API key or an Anthropic-compatible base URL, and a cloud identity once that kind lands. The Actions lane accepts
  `claude setup-token` inside Anthropic's own action, the automated form the docs name.
- **OpenAI.** "The right way to authenticate automation is with an API key"
  (learn.chatgpt.com/docs/auth/ci-cd-auth). `codex-acp` takes a key.
- **Keys and cloud identity** are the portable layer and the OSS default. Bedrock, Vertex and
  Foundry through the Claude CLI's env vars, once the runner accepts those kinds; OpenAI-compatible base URLs through Codex and
  OpenCode; keyless local models through `diff-only`, OpenCode, and Claude Code behind an
  Anthropic-compatible endpoint such as Ollama.
- The control plane never stores key material. It stores fingerprints and the observed health
  of rounds, which is what `Keys.dc.html` already specifies.
- No reviewed product takes a personal subscription as a third-party credential. The only
  subscription-backed review lanes are first-party: Claude's action and Codex cloud review.


## 7. Failure modes a stranger will hit

| Failure | Who notices | What is posted |
|---|---|---|
| Runner down | Control plane, `runner_timeout` | `no-runner` verdict; job stays queued |
| Rate limit or account limit hit | `classify-failure` on the runner | `credential-cooldown` with `reset_at`; requeue |
| Credential rejected | Same | `api-error` with the existing "replace the credential" text |
| Control plane down | Nobody, automatically: GitHub never redelivers a failed delivery, and manual redelivery reaches only the past 3 days | Nothing until it returns. Boot-time reconciliation is the recovery path for any outage past that window: list open PRs, which `pr-state.yml` already does |
| Engine crashes mid-round | Missing `finished` before heartbeat timeout | `api-error`, job retried once on another slot |
| Two runners, same credential | Registration refuses a fingerprint another live runner holds | Startup error |
| D1 write limits (100k rows/day free) | Weekly health report (#176) | Well above current volume of about 250 rounds a month |

## 8. Is it really open source someone can rely on

Yes, with three conditions stated plainly:

1. **The control plane requires a Cloudflare account.** Free tier is enough for any solo team
   (100k requests a day, 10k queue ops a day, 5 GB D1). It is still a dependency Kodus and
   PR-Agent do not impose. Define the runner API as the contract so a SQLite control plane can
   follow; do not build it for v1.
2. **The docs lead with the API key and the free model.** Those are the credentials the runner
   takes; section 6 lists them.
3. **The #59 checklist still applies.** Name, `@v1` tags, changelog, quickstart against a
   fixture repo, SECURITY.md. None of that is engineering; all of it is what makes "reliable"
   true for a stranger.

What a stranger does: `wrangler deploy` the control plane, click through the GitHub App
manifest flow, `docker compose up` the runner with one key or with none on a free model. Three
steps, no public IP.

What they get that nothing surveyed offers: a reviewer that says when it did not run, a cost
per review, finding fates, config that a PR cannot rewrite, and one envelope over any engine
including a free local one. Those are the product.

## 9. Relationship to what exists

- The Actions lane stays, and becomes a thin runner over time. Two runners for one contract is
  the honest offer: run a box, or do not.
- The telemetry Worker is the control plane; nothing moves off Cloudflare.
- An author-side plugin (#184) runs the lane's prompt as a skill in the author's own harness
  and submits its events to the control plane as an advisory round. It never posts through the
  App, never gates and never changes admission.
- Assayer gains an `engine` filter on existing views. Compare stays refused (#119); per-engine
  columns on `/findings` fates is the most #81 asked for, and its wording already forbids
  winner banners.
- prismalens is unaffected. Its harness selection is a different seam (ACP), and Codex stays
  inadmissible there on #639's grounds.

## 10. Day one here, then the same steps, and one rotation

Nothing on the runner has a deadline. The one dated item is the Actions lane's secret.

1. **Prove the engine here.** On this machine, an ACP client on `@agentclientprotocol/sdk`
   against `opencode acp` (pinned 1.18.30, the row prismalens verified) or `claude-agent-acp`
   with `ANTHROPIC_BASE_URL` at Ollama. One real sreforge PR range fetched with a read-only
   token, the lane's prompt template, the lane's tool allowlist as the permission policy, the
   comment tool offered as an MCP server. Capture `session/update`, map it to assayer/v1,
   record turns, usage and wall clock. No posting. No key bought.
2. **Lease and stream.** `jobs` table, `/runner/lease`, `/runner/jobs/:id/events`, runner
   token, heartbeat. Webhook receiver for `pull_request` on sreforge only, through a GitHub
   App created with the manifest flow. Admission ported from `resolve` for the three cheapest
   refusals (draft, fork, size). Everything else refuses to `queued-unsupported` for now.
3. **Post.** Poster renders the envelope and the summary, upserts liveness. Run one sreforge PR
   end to end with the Actions lane still on, so the PR carries both rounds and the sweep
   records both. Fix whatever the sweep cannot attribute.
4. **Telemetry and config.** `engine` column, usage record from `usage_update`,
   `credential_type` filled from registration. Extract
   the config resolver into a package with its tests, used by the control plane; the Actions
   lane keeps its inline copy until the next release.
5. **Second engine and docs.** The other ACP row on a key. Codex only once prismalens#639's
   permission gate passes. Write `docs/design/self-hosted-review.md` from this file, and the
   rulings for #59, #80, #81 and #77. Do not post them until the operator reads them.
6. **Rotate the lane.** Independent of 1 to 5 and the only item with a date: prismalens and
   sreforge hold `CLAUDE_CODE_OAUTH_TOKEN` and no `ANTHROPIC_API_KEY`. The lane stops when
   the subscription lapses, around 2026-09-23, unless an API key secret is added and the
   OAuth secret removed before then.


## 11. Open questions

1. Name. It is public-facing; "claude-review" cannot survive the second engine.
2. Whether the box earns its keep at API rates. Today's volume is $150 to $370 a month at list
   price wherever it runs, so the box's case is sandboxing, engine choice and the product
   shape, not price.
3. Answered (#184): the runner image bundles the vendor CLIs at pinned versions, built on the box
   from `runner/image/Dockerfile`. Registry publishing, signing and arm64 are deferred.
4. What "level" means for `diff-only`, which has no subagents to spend.
5. Whether GitHub-hosted runners remain a supported runner in v1 or only in the current lane.
6. Whether prismalens's canonical stream adapter is imported as a package or copied; #182's
   resolver package is the precedent for importing.


## 12. Does it fit the existing issues

Verified against the issue bodies on 2026-09-18.

**The conflict.** The 2026-09-02 comment on #59 parks #77, #78, #79, #80, #81, #92 and #106
behind the extraction trigger with "no rulings, no design passes, no comments on them until
the trigger fires". The trigger is a named non-prismalens consumer or a launch date. The
operator's own need for a runner that outlives one vendor's plan is neither, and the ruling's
anti-trigger list is explicit that the itch of the hardcodes and readiness are not triggers.
So the architecture cannot be filed as un-parking those issues without amending the ruling.

**The fit.** #176 set the precedent: "Built in gh-workflows for today's consumers, in the shape
a standalone product keeps." The service is the same kind of thing. It is internal
infrastructure that the operator needs now, built in the shape extraction will ship, under
its own umbrella, and the parked issues stay parked and untouched. When the trigger fires,
each parked issue is re-scoped against what then exists.

| Issue | State | What the architecture does to it |
|---|---|---|
| #59 extraction | parked, hosts rulings | Trigger unchanged. One comment: the runner API becomes the extraction contract, and the `org_defaults_repo` "Done when" bullet is done as `extends:` in the repository's own config (#182), neither a control-plane setting nor a workflow input. |
| #176 telemetry provenance | open, in progress | Its OIDC path stays for GitHub-hosted runners. The service adds a per-runner token, which satisfies its "no shared secret" principle. Its did-not-run bucket map and `test-verdict-kind-drift.py` gain `no-runner` and `credential-cooldown`. Sequence #176's bearer-token deletion after the runner token exists. |
| #12 lane roadmap | open | Unchanged. #90's cross-repo sparse checkout and #162's stack semantics must land once in the shared package, so the Actions lane and the runner do not diverge. |
| #47 variant identity | closed | The variant key gains `engine`. Recorded in the umbrella, not reopened. |
| #119 compare refused | merged | Respected. No compare page; per-engine columns on existing views only. |
| #81 assayer/v1 contract | parked | Untouched. When un-parked: the event stream in section 4 is the contract, the `agents` table is runner registration, and its compare bullet is dead under #119. |
| #77 credential registry | parked | Untouched. When un-parked: the registry is what runners declare, fingerprints only, duplicate refusal at registration. |
| #79 installer and wizard | parked | Untouched. When un-parked: the wizard is the GitHub App manifest flow plus `docker compose up`. |
| #80 GitHub App | parked | Untouched. The App itself is created by the umbrella because the service needs webhooks and tokens; roles and fleet discovery stay here. |
| #78, #92, #106 | parked | Untouched. #78 gains a prerequisite in the resolver package; #106's `telemetry.share` reading moves to the control plane. |
| prismalens | | Nothing. The harness seam is ACP and Codex stays inadmissible there (#639). |
| rig (formerly agent-rig) | `skills/claude-review-lane` and its `references/verdicts.md`, `data/repo-meta.json`, `hooks/pr-created.sh` | Nothing carries the subscription or subprocess premise; the skill states the callee's OAuth-or-key rule as it is. When #184 lands: the skill's verdict table is hand-pinned to a gh-workflows commit and must be re-pinned for `no-runner`, `credential-cooldown` and the `engine` field on the liveness line; rounds from the runner post under the App's login, not `claude[bot]`, so the liveness parsing and the sweep filter both match two logins; `repo-meta.json` gains which lane reviews a repo. At the #59 cut: the product ships its own plugin (the lane skill, a verdicts reference generated from the vocabulary and pinned by a drift test in the product repo, the liveness parser) and rig imports it from that marketplace the way it already vendors CodeRabbit's `autofix` and the pstack skills. `coderabbit-lane`, `autofix`, `cr-reply.sh` and the hooks stay in rig; they are the operator's working style, not the product. |

**New issues, filed only when the operator says so.**

1. Umbrella, in #176's shape: the lane runs as a service. Control plane on the Worker (webhook,
   admission, jobs, lease, poster, liveness), a runner that pulls, engines behind one event
   stream. Done-when bullets are the six steps in section 10 plus: `engine` column on
   `usage_records` and `review_findings`; the sweep attributes by engine and bot login; the
   two new verdicts in the vocabulary, the Worker and the dashboard map.
2. The config resolver leaves the YAML: one package with its tests, imported by the Worker and
   vendored into the lane until the next release. Prerequisite for the service and for #78.
3. The name. A decision issue, because "claude-review" is in the config file name, the
   liveness marker, the comment headers and the workflow file, and the second engine ends it.

Nothing above is posted. The `triage` skill applies before any of it is.
