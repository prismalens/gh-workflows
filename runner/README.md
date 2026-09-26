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
this runs on the operator's machine before any sandbox. The same rule is in the workflow's
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

`src/daemon.js` (bin `assayer-runner`) proves the job container, registers with the control plane
(#196's `/runner/*` routes), leases jobs for its credentials, and runs each job in two containers
behind the key proxy. It then posts the round's events, revokes the token and posts `finished`.

**Before any register, on every start:**
1. It detects the runtime: `container.runtime`, else podman, else docker.
2. It resolves `assayer-runner:<input hash>` built from this checkout, and refuses to start as root.
3. It runs `src/probe.js` in a probe container.

Any failure exits 1 before a single control-plane call. `--check` runs the same three steps and prints
the image and the probe report. It exits 2 naming the field on a bad file.

```bash
cd runner && node scripts/build-image.mjs  # once per checkout; tags assayer-runner:<hash>
export ASSAYER_RUNNER_TOKEN=asr_...        # from POST /api/runners
node src/daemon.js --config assayer-runner.json --check
node src/daemon.js --config assayer-runner.json
```

```json
{
  "control_plane": "https://assayer.sfun.cloud",
  "runner_token": "${ASSAYER_RUNNER_TOKEN}",
  "placement": "box",
  "container": { "runtime": "podman", "memory": "4g" },
  "credentials": [
    { "name": "zen", "engine": "opencode", "kind": "keyless", "upstream": "https://opencode.ai/zen/v1", "concurrency": 1 },
    { "name": "anthropic", "engine": "claude-code", "kind": "api-key", "env": "ANTHROPIC_API_KEY",
      "upstream": "https://api.anthropic.com", "upstream_auth": "x-api-key", "concurrency": 1 }
  ]
}
```

- **Secrets never sit in the file.** `runner_token` is a `${VAR}` reference, and an `api-key`
  credential names its variable in `env`. The fingerprint the runner registers is the first 12 hex
  of the key's SHA-256. A `keyless` fingerprint is stable per host and engine.
- **`upstream`** is where the key proxy forwards that credential's model requests: https, with no query
  or trailing slash. `upstream_auth` says how an `api-key` travels (`x-api-key` or `bearer`). A keyless
  credential has none.
- **`placement`** takes `box` only. `user-login`, `bedrock`, `vertex` and `foundry` are refused.
- **Runtime choice.** Rootless podman is preferred. Docker works, but its group is root-equivalent on
  the box. The runtime is driven by its CLI only; no API socket is opened or mounted.

| Step | Container | `/checkout` | Proxy lets through |
|---|---|---|---|
| Staging | `src/stage.js`: shallow fetch of head and base, then the manifest and diff | read-write | `CONNECT` to `github.com`, `api.github.com` |
| Engine | `src/run.js` and the engine | read-only | model requests to `upstream` with the key set; `CONNECT` to `api.github.com` |

Every container runs with `--network none --read-only --cap-drop ALL`, no new privileges, pid and
memory limits, and the daemon's uid. Tokens travel as `-e NAME` with the value in the CLI's
environment, never in argv. The engine sees `GH_TOKEN`, the proxy URL and the round's nonce. No
configured key is ever in its environment.

- **The heartbeat** is an empty events post every `min(60, heartbeat_timeout_s / 5)` seconds.
  Events post after the round in batches of at most 100, each event cut to 16 KiB.

| Exit path | Posted before revoke | Last call |
|---|---|---|
| Success | the round's events | `finished{completed}` |
| Engine failure or crash | the round's events, or a synthesized `started` + `error` | `finished{failed \| timed-out}` |
| SIGTERM | whatever the round wrote | `finished{cancelled}` |
| Staging failure | `started` + `error` | `finished{failed}` |
| Lease lost (409 or 403) | stops at the first 409 | none; the revoke still runs |

`finished._meta` carries `token_revoked` and `exit`. `test/daemon.test.js` pins revoke before the
last events call on every path, and that the proxy closes exactly once on each.

**Acceptance for a box**, run once per box and after every image rebuild:
`GH_READ_TOKEN=... scripts/live-test.sh assayer-runner.json owner/repo <pr>`. It builds the image,
runs `--check` and one real round with no control plane, then fails if any configured key appears
in the round directory.

Deferred: GHCR publishing, signing and arm64 for the image; `bedrock`, `vertex` and `foundry`;
streaming events mid-round; a lease-release route, so a restart requeues instead of finishing
`cancelled`; and incremental jobs.

## The job image and the key proxy

- **The image.** `image/Dockerfile` builds from node 24 pinned by digest. It adds git, gh,
  actionlint 1.7.12, shellcheck and socat, each download checked by sha256, plus `opencode-ai`,
  Claude Code and `claude-agent-acp` at exact versions.
  - `scripts/build-image.mjs` tags it `assayer-runner:<hash>` and stores the hash as the
    `assayer.input_sha256` label. The hash covers the Dockerfile, the entrypoint, `src/`, `prompt/`
    and the lockfile.
  - `tests/test-runner-image-pin-drift.py` keeps the pins honest, and the `Runner image` workflow
    builds the image on any PR that touches `runner/`.
- **The proxy.** `image/entrypoint.sh` bridges `127.0.0.1:8787` in the container to
  `src/key-proxy.js` on a unix socket. The daemon switches the proxy's phase between the two steps,
  so nothing inside a container can widen it.
  - The engine's "key" is a per-round nonce.
  - The proxy checks the nonce, then forwards to the one configured upstream with the real key set on the wire.

**What this cannot stop:**
- exfiltration through the allowed upstreams;
- the engine appending to the shared round directory;
- kernel and runtime escapes;
- resource abuse beyond the memory, pids and wall-clock limits.

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

The ACP policy is therefore a guardrail, not a boundary, which is what prismalens ADR 0003 §3
says of every harness. The container is the boundary: read-only checkout, egress to two hosts,
non-root.

`scripts/permission-probe.sh <checkout>` repeats the check against the real binary: an allowed
command, a disallowed one, an edit and a delete, then proves nothing landed. Run it before
adding or bumping an engine row.

## Tests

`npm test` runs the unit tests: the contract's field lists and failure classes, the policy
on chained and disguised commands, the mapper on partial updates, duplicate reads, paths
outside the checkout, malformed findings, repeated summaries, every stop reason, non-USD
cost, and a corrupt tool log. The engine itself is covered by the probe script, not by CI,
because it needs a model.
