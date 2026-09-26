# runner

Runs one review round over the [Agent Client Protocol](https://agentclientprotocol.com): spawns
an engine, opens a session on a checkout, offers the lane's two comment tools as MCP servers,
sends the lane's prompt, answers every permission request from the lane's tool allowlist, and
writes the round as assayer/v1 events. The design is `docs/design/self-hosted-review.md`; this
is its section 3.2 and 3.3, day one.

`run.js` posts nothing to GitHub. The daemon ("Run the daemon" below) leases jobs from the
control plane and holds each job's installation token only for that job. The engine's
credential is an API key in the environment, or none for OpenCode's free models.

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

Staging never executes a binary the checkout brought with it: a committed `./actionlint` or
`node_modules/.bin/*` is skipped and the skip is recorded in the manifest's tool notes, since
staging runs on the runner's machine. The same rule is in the workflow's
own step.

The prompt tells the engine to read `.claude-review-manifest.json` and `.claude-review.diff`
from the checkout root. The Actions lane writes them before the review; so does the runner
with `--stage-manifest --repo owner/name --pr N [--head-sha SHA] [--mode review]`, which
runs `src/manifest.py`, the workflow's own manifest and context builders copied verbatim
(`src/manifest.js` wraps them with the workflow's defaults). Without it the engine has no
diff to review and says so in its summary. A staging failure is a round that never ran: the
engine is not spawned, and `events.jsonl` carries one `error` and a `failed` finish.

The output directory holds:

| File | What |
|---|---|
| `events.jsonl` | assayer/v1: `started`, `read`, `agent`, `finding`, `summary`, `usage`, `error`, `finished` |
| `raw.jsonl` | every ACP message: initialize, session, each `session/update`, each permission request with its decision, the stop |
| `tool-log.jsonl` | every call the engine made to `create_inline_comment` or `update_claude_comment`, as recorded by `src/finding-tools.js` |
| `summary.json` | conclusion, stop reason, turns, tool calls, reads, findings, permissions allowed and rejected, usage, errors, dropped items, wall clock |
| `engine-stderr.log`, `engine-config/`, `engine-xdg/` | the engine's own noise and the per-run config the runner wrote for it |

Exit code 0 is `completed`, 3 an engine error, 4 a timeout, 2 bad usage.

## Run the daemon

`src/daemon.js` (bin `assayer-runner`) registers with the control plane (#196's `/runner/*`
routes), leases jobs for its credentials, checks each pull request out with the job's
installation token, runs one round through `run.js`, posts the round's events, revokes the token
and posts `finished`. The engine runs as it would in a terminal on this machine: its own config
and sign-in, or the key its credential names (prismalens ADR 0003). `--check` prints each
credential's fingerprint and exits 0, or exits 2 naming the field on a bad file.

```bash
export ASSAYER_RUNNER_TOKEN=asr_...        # from POST /api/runners
node src/daemon.js --config assayer-runner.json --check
node src/daemon.js --config assayer-runner.json
```

```json
{
  "control_plane": "https://assayer.sfun.cloud",
  "runner_token": "${ASSAYER_RUNNER_TOKEN}",
  "credentials": [{ "name": "zen", "engine": "opencode", "kind": "keyless", "concurrency": 1 }]
}
```

In a container, with the engines and staging tools at the versions `Dockerfile` pins:

```bash
docker build -t assayer-runner runner/
docker run -it --rm -v assayer-home:/home/assayer --entrypoint claude assayer-runner   # once, for a user-login credential
docker run -d -v assayer-home:/home/assayer -v "$PWD/assayer-runner.json:/etc/assayer/runner.json:ro" \
  -e ASSAYER_RUNNER_TOKEN assayer-runner
```

- Secrets never sit in the file. `runner_token` is a `${VAR}` reference, and an `api-key`
  credential names its variable in `env`. The fingerprint the runner registers is the first 12 hex
  of the key's SHA-256, so the key never leaves the process. A `keyless` or `user-login` one is
  stable per host and engine.
- `user-login` is the engine's own sign-in on this machine (`claude` or `opencode auth login`,
  under `HOME`); the runner reads nothing of it. A runner may offer several credentials, each
  with its own `concurrency`. `bedrock`, `vertex` and `foundry` are refused as deferred.
- The checkout is a shallow fetch of the head and the base into a fresh temp dir, deleted on every
  path. The token goes to git in `GIT_CONFIG_VALUE_0` as an extraheader, never in argv or a URL.
- **The heartbeat** is an empty events post every `min(60, heartbeat_timeout_s / 5)` seconds.
  Events post after the round in batches of at most 100, each event cut to 16 KiB.

| Exit path | Posted before revoke | Last call |
|---|---|---|
| Success | the round's events | `finished{completed}` |
| Engine failure or crash | the round's events, or a synthesized `started` + `error` | `finished{failed \| timed-out}` |
| SIGTERM | whatever the round wrote | `finished{cancelled}` |
| Checkout failure | `started` + `error` | `finished{failed}` |
| Lease lost (409 or 403) | stops at the first 409 | none; the revoke still runs |

`finished._meta` carries `token_revoked` and `exit`. `test/daemon.test.js` pins revoke before the
last events call on every path.

Deferred: `bedrock`, `vertex` and `foundry`, streaming events mid-round, a lease-release route (so a
restart requeues instead of finishing `cancelled`), and incremental jobs.

## What the pieces are

- `src/events.js`: the contract. Eight event types with fixed field lists, the lane's eight
  failure classes, and the same text tests `classify-failure` runs in the workflow.
- `src/policy.js`: the lane's `--allowed-tools` list as an ACP permission policy. Read, search
  and think are allowed; execute only for the listed `gh` read commands and only as a single
  command on a single line, with any control character refused outright; edit, delete, move
  and fetch are refused; the two comment tools are allowed.
- `src/finding-tools.js`: one MCP server per comment tool. Each call is appended to the tool
  log and answered with success. Findings and the summary are read from that log, never from
  what the engine narrated, so a call the model only described is not a finding.
- `src/gh-shim.sh`: the `gh` the engine sees. The lane's prompt posts its summary with
  `gh pr comment`, which is on the allowlist, so the runner puts this shim first on PATH: `pr
  comment` is recorded to the tool log as the summary and answered as gh would, `pr review`,
  `pr merge`, `pr close`, `pr edit` and `api` are refused, everything else runs the real gh.
  `--body-file` takes only `-` (stdin): a path would let a steered engine record any readable
  file, a token store or `/proc/self/environ`, as the summary the poster publishes. Nothing a
  round does reaches GitHub except reads.
- `src/acp-map.js`: `session/update` to events. One `read` per path per round from tool-call
  locations, flagged when outside the checkout. The last `update_claude_comment` wins, as the
  lane's comment does. A finding or summary body that carries a credential-shaped token (a
  GitHub, Anthropic, OpenAI, AWS or Slack token, a private key, a `TOKEN=` line) is dropped
  and counted, never recorded, since those bodies are what the poster publishes.
  `usage_update` gives context size and cost, not input and output tokens; those fields stay
  null and the gap is recorded in `_meta`. Stop reasons map to
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

The ACP policy is therefore a guardrail, not a boundary, as prismalens ADR 0003 says of every
agent. The runner adds no sandbox of its own: what the engine allows and blocks is the posture.

`scripts/permission-probe.sh <checkout>` repeats the check against the real binary: an allowed
command, a disallowed one, an edit and a delete, then proves nothing landed. Run it before
adding or bumping an engine row.

## Tests

`npm test` runs the unit tests: the contract's field lists and failure classes, the policy
on chained and disguised commands, the mapper on partial updates, duplicate reads, paths
outside the checkout, malformed findings, repeated summaries, every stop reason, non-USD
cost, and a corrupt tool log. The engine itself is covered by the probe script, not by CI,
because it needs a model.
