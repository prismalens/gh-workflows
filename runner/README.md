# runner

Runs one review round over the [Agent Client Protocol](https://agentclientprotocol.com): spawns
an engine, opens a session on a checkout, offers the lane's two comment tools as MCP servers,
sends the lane's prompt, answers every permission request from the lane's tool allowlist, and
writes the round as assayer/v1 events. The design is `docs/design/self-hosted-review.md`; this
is its section 3.2 and 3.3, day one.

Nothing here posts to GitHub, leases jobs or holds a credential of its own. The engine's
credential is an API key in the environment, or on a laptop the engine's own sign-in. Which
placements may run which credential is section 6 of the design.

## Run one round

```bash
cd runner && npm ci
node src/run.js --cwd /path/to/checkout --prompt rendered-prompt.md --out ./round-1 \
  --engine opencode --model opencode/mimo-v2.5-free
```

`--cwd` must be a git checkout at the PR head. `--prompt` is the lane template already rendered.
`scripts/render-prompt.mjs --repo owner/name --pr N [--level high] [--mode review-full |
incremental --range-base A --range-head B] [--path-instructions]` renders it the way the
workflow's `build-prompt` step does and prints the prompt hash on stderr; `prompt/README.md`
has the template's provenance and re-sync rule. A file still carrying `@@TOKEN@@` is refused. `--engine` is a row in
`src/engines.js`; `--model` defaults to the row's `defaultModel`, for OpenCode the newest free
tool-calling model in the models.dev catalog (`opencode models opencode` lists them; the free
tier needs no key or login). `--timeout-min` (default 20) bounds the round and `--idle-min` (default 8) cuts an engine that has sent no update for that long; either cancels the session, then kills the engine if it does not stop.
`GH_TOKEN` in the environment is passed through to the engine for the `gh` read commands the
prompt allows.

The output directory holds:

| File | What |
|---|---|
| `events.jsonl` | assayer/v1: `started`, `read`, `agent`, `finding`, `summary`, `usage`, `error`, `finished` |
| `raw.jsonl` | every ACP message: initialize, session, each `session/update`, each permission request with its decision, the stop |
| `tool-log.jsonl` | every call the engine made to `create_inline_comment` or `update_claude_comment`, as recorded by `src/finding-tools.js` |
| `summary.json` | conclusion, stop reason, turns, tool calls, reads, findings, permissions allowed and rejected, usage, errors, dropped items, wall clock |
| `engine-stderr.log`, `engine-config/`, `engine-xdg/` | the engine's own noise and the per-run config the runner wrote for it |

Exit code 0 is `completed`, 3 an engine error, 4 a timeout, 2 bad usage.

## What the pieces are

- `src/events.js`: the contract. Eight event types with fixed field lists, the lane's eight
  failure classes, and the same text tests `classify-failure` runs in the workflow.
- `src/policy.js`: the lane's `--allowed-tools` list as an ACP permission policy. Read, search
  and think are allowed; execute only for the listed `gh` read commands and only as a single
  command; edit, delete, move and fetch are refused; the two comment tools are allowed.
- `src/finding-tools.js`: one MCP server per comment tool. Each call is appended to the tool
  log and answered with success. Findings and the summary are read from that log, never from
  what the engine narrated, so a call the model only described is not a finding.
- `src/gh-shim.sh`: the `gh` the engine sees. The lane's prompt posts its summary with
  `gh pr comment`, which is on the allowlist, so the runner puts this shim first on PATH: `pr
  comment` is recorded to the tool log as the summary and answered as gh would, `pr review`,
  `pr merge`, `pr close`, `pr edit` and `api` are refused, everything else runs the real gh.
  Nothing a round does reaches GitHub except reads.
- `src/acp-map.js`: `session/update` to events. One `read` per path per round from tool-call
  locations, flagged when outside the checkout. The last `update_claude_comment` wins, as the
  lane's comment does. `usage_update` gives context size and cost, not input and output
  tokens; those fields stay null and the gap is recorded in `_meta`. Stop reasons map to
  `completed`, `truncated`, `refused`, `cancelled`; an error or an engine exit before the stop
  is `failed`; the timeout is `timed-out`.
- `src/engines.js`: the registry. A row names the binary, its ACP arguments, the environment
  allowlist it receives (never the runner's whole environment), the credential kinds, and
  `prepare()`, which writes the engine's per-run config.

## The permission finding, and why the engine config matters

OpenCode 1.18.30 in ACP mode edits files and runs shell commands without a permission request
unless its own config says `ask`. Verified 2026-09-19: with a bare config, an edit, a delete
and a redirect into `/tmp` all landed with no `session/request_permission`. With the config
the registry row writes (`edit: ask`, `bash: ask`, `webfetch`, `websearch` and
`external_directory: deny`, `continue_loop_on_deny`), every edit and every command comes to
the runner first, the policy answers, and a refusal does not end the turn. That config, and
`--pure` with the project's own `opencode.json` disabled, is copied from the prismalens
registry row that passed prismalens#561.

The ACP policy is therefore a guardrail, not a boundary, which is what prismalens ADR 0003 §3
says of every harness. The box placement adds the container: read-only checkout, egress to
two hosts, non-root. The laptop placement has no container and is opt-in for that reason.

`scripts/permission-probe.sh <checkout>` repeats the check against the real binary: an allowed
command, a disallowed one, an edit and a delete, then proves nothing landed. Run it before
adding or bumping an engine row.

## Tests

`npm test` runs the unit tests: the contract's field lists and failure classes, the policy
on chained and disguised commands, the mapper on partial updates, duplicate reads, paths
outside the checkout, malformed findings, repeated summaries, every stop reason, non-USD
cost, and a corrupt tool log. The engine itself is covered by the probe script, not by CI,
because it needs a model.
