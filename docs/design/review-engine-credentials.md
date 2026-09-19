# Research: is a subscription-backed, subprocess-driven review runner with the flow? (2026-09-19)
Copied from the operator's draft on 2026-09-19 for prismalens/gh-workflows#184. Edit here; the draft is not maintained.

Reopened by the operator on 2026-09-19 after the #184 day-one plan (VPS, `claude -p
--output-format stream-json` under `claude setup-token`, per-engine driver). Sources: two
surveys (prismalens hub and repo; vendor docs and competitors), primary pages re-fetched by
the Fable seat where a claim conflicted. Earlier research: the review engine options research of 2026-09-14, `docs/design/self-hosted-review.md` (2026-09-18), the ACP verification note of 2026-09-11, the prismalens laptop handoff of 2026-09-16.

## 1. Vendor policy, primary text

Anthropic, `code.claude.com/docs/en/legal-and-compliance` (fetched 2026-09-19):
- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
  and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
  other native Anthropic applications."
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own
  applications, or to route requests through Free, Pro, or Max plan credentials on behalf of
  their users." "developers may not collect, store, or intermediate Claude.ai credentials or
  session tokens."
- Carve-out: "Nor does it prevent an end user from signing in to the unmodified Claude Code
  binary with their own Claude subscription, including where a platform hosts Claude Code."
- Hosting Claude Code in a product requires Commercial Terms, unmodified binary, each end user
  on their own credential, billed to them, no intermediation.

Anthropic, `docs/en/authentication` and `docs/en/github-actions`: `claude setup-token` is the
documented CI path for a subscription. The Actions doc adds: for a secret shared across
repositories use an API key, "since an OAuth token is tied to the subscription of the person
who ran claude setup-token." `claude-code-action` accepts `claude_code_oauth_token`.

Anthropic Agent SDK overview: "Unless previously approved, Anthropic does not allow third
party developers to offer claude.ai login or rate limits for their products, including agents
built on the Claude Agent SDK."

Anthropic, 2026-04-04 cutoff (The Register 2026-04-06): third-party harnesses lost
subscription limits; spokesperson: "Using Claude subscriptions with third-party tools isn't
permitted under our Terms of Service, and they put an outsized strain on our systems."

OpenAI, `learn.chatgpt.com/docs/auth/ci-cd-auth`: "The right way to authenticate automation
is with an API key." ChatGPT-login CI is for "trusted private infrastructure," one serialized
stream per `auth.json`, and "Do not use this workflow for public or open-source repositories."
`openai/codex-action` takes only `openai-api-key`.

Google: consumer-account OAuth for Gemini Code Assist on GitHub was deprecated 2026-06-18; it
now needs a paid Code Assist tier or an API key.

## 2. What products do

No reviewed product accepts a user's personal Claude or ChatGPT subscription as a
third-party credential. Three models exist: vendor key (CodeRabbit, Greptile, Sourcery,
Ellipsis, Graphite, Cursor Bugbot), first-party subscription for the vendor's own product
(Copilot code review, Codex cloud `@codex review`), BYOK API key for self-hosted (Qodo
PR-Agent, Continue.dev, Kilo Code). CodeRabbit self-hosted customers "must supply their own
credentials ... for all Third-Party AI Model Providers." Subscription-multiplying proxies
(CC-Router) carry their own ban warnings in the README.

## 3. What prismalens already ruled (hub, `prismalens-kb/projects/prismalens-platform`)

- ADR 0003 (accepted, reviewed 2026-09-11): "ACP is the harness seam. Every harness runs as a
  child of the API speaking the Agent Client Protocol over stdio." §8: a native adapter only
  against a recorded ACP gap on the registry row. §9: "Cloud and VM placements are the same
  ACP child in a container with the key in env; subscription logins are a laptop feature."
  Forbids: "routing a subscription through prismalens code," "a patched, vendored or wrapped
  Claude Code binary."
- ADR 0004 §7: "The product never embeds a Claude subscription."
- Hub memory `never-use-operator-claude-auth` (2026-09-14), the operator's words: using their
  Claude Code auth for automated runs "will get me banned."
- prismalens#639 (open): ACP passes the harness gate for Claude Code and OpenCode; native SDK
  costs about 2x commits and 4x code; Codex fails permission gating on both transports.
- The pre-pivot `claude -p` / `codex exec --json` design (GAP-ANALYSIS.md, 2026-03-18) is
  archived and superseded.

## 4. ACP, verified

- `session/update` carries `usage_update` with `used`, `size` and `cost {amount, currency}`,
  stabilized June 2026 (agentclientprotocol.com/rfds/session-usage). The 2026-09-11 note that
  ACP has no usage field is out of date.
- `@agentclientprotocol/claude-agent-acp` `src/auth-status.ts` (main, fetched 2026-09-19)
  reports "Claude subscription, API key" as the identity the agent process uses and tracks the
  claude.ai login; it inherits whatever the binary is signed into. The Zed issue "ACP uses API
  key directly, no login option" is stale.
- Adapter honours `CLAUDE_CODE_EXECUTABLE`, so the user's installed `claude` is reused.
- Registry of agent implementations: Claude, Codex, Gemini CLI, Copilot, Cursor, Cline,
  OpenCode, Goose, Qwen, Kimi and more. Remote transport is work in progress; stdio child on
  a server is the supported shape.
- `PromptResponse` has only `stopReason`; findings arrive as tool calls (`rawInput`) or text.

## 5. State of the lane today

`prismalens/prismalens` and `prismalens/sreforge` carry `CLAUDE_CODE_OAUTH_TOKEN` and no
`ANTHROPIC_API_KEY` (gh secret list, 2026-09-19). The workflow falls back to the API key only
when the OAuth secret is empty. When the subscription lapses (about 2026-09-23) the lane stops
on both repos unless an API key is added and the OAuth secret removed.

## 6. Verdict

Two separate questions were fused in #184 day one.

The runner is with the flow. A self-hosted, engine-agnostic runner that pulls jobs and emits
one normalized event stream is the PR-Agent shape with tool use. Keep it.

The credential and the seam are against the flow. Every vendor either bars or restricts a
subscription behind automation, every product uses keys, the operator said the same on
2026-09-14, and prismalens has an accepted ADR that forbids exactly this. The legal carve-out
covers a person signing into the binary; it does not cover a service on a box doing 250
reviews a month on a personal plan, and Anthropic's stated reason (workload shape) points at
that case. `claude setup-token` in the first-party Action is the only named sanctioned form.

Amend #184: the engine seam is ACP, one client that reuses prismalens's `acp-adapter.ts`
canonical stream, with a per-engine driver only for a recorded gap (0003 §8). Credential on
the box is an API key. Day one runs on this machine with `claude-agent-acp` or `opencode`
against an API key, so no VPS and no deadline. Subscription use stays where Anthropic names
it: the Action, or a laptop where the user signs in themselves. Public docs never mention
subscriptions on the runner.
