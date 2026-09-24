# Review Telemetry Worker

The Cloudflare Worker and D1 database service for `prismalens/gh-workflows` review telemetry and dashboard backend.

The Worker:
- Ingests telemetry payloads via `POST /ingest` (or `POST /`) and persists usage records to Cloudflare D1.
- Serves telemetry analytics API endpoints (`GET /api/summary`, `GET /api/runs`, etc.).
- Serves the Assayer dashboard SPA from `../dashboard/dist` via its `[assets]` binding.

## Database Migrations (Cloudflare D1)

Database schema evolution is managed through versioned SQL migrations using Wrangler D1 migrations located in `worker/migrations/`.

### Migration Invariants

- **Versioned files**: Migrations are ordered, numbered `.sql` files (e.g. `0001_initial_schema.sql`).
- **Idempotency / Safe on Existing Databases**: Migration `0001` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. When applied against a database where `usage_records` and its indexes already exist, it creates the `d1_migrations` bookkeeping table and records the migration without altering existing tables or mutating rows.
- **Nullable Columns**: Every subsequent column added in future migrations must be nullable (`NULL`), without exception. A column an older lane does not send must be absent (NULL), not 0 or empty string, preserving the distinction between unmeasured and zero values.

### Migration Commands

Always use the pinned Wrangler binary in `worker/node_modules/.bin/wrangler` (`npm ci` in `worker/` first):

```bash
# List unapplied migrations locally
./node_modules/.bin/wrangler d1 migrations list review-telemetry --local

# Apply unapplied migrations to the local database
./node_modules/.bin/wrangler d1 migrations apply review-telemetry --local

# Create a new migration file
./node_modules/.bin/wrangler d1 migrations create review-telemetry <migration_name>

# List unapplied migrations on remote (production)
./node_modules/.bin/wrangler d1 migrations list review-telemetry --remote

# Apply unapplied migrations to remote (production) — operator manual step
./node_modules/.bin/wrangler d1 migrations apply review-telemetry --remote
```

### Why CI Does Not Auto-Apply Migrations

The GitHub Actions deploy workflow (`.github/workflows/deploy-worker.yml`) deliberately does **not** auto-apply migrations on merge to `main`.

1. **No Transactional Rollback**: Cloudflare D1 executes migration statements sequentially without multi-statement atomic rollback across migration statements. If a migration fails midway on remote, the live database can be left in an inconsistent state with no automated rollback.
2. **Production Data Integrity**: The production `review-telemetry` database stores real recorded telemetry rounds that cannot be regenerated. Schema migrations must be applied deliberately by the operator with explicit confirmation and pre-migration verification.
3. **Pending Migration Detection**: The deploy workflow checks for unapplied remote migrations using `wrangler d1 migrations list review-telemetry --remote` and fails closed (`::error::` and exit 1) if pending migrations are detected (#87), or emits a warning if the migration state cannot be determined.

## Ingest Contract (v2)

Telemetry payloads are ingested via `POST /ingest` (or `POST /`) authenticated with `Authorization: Bearer <REVIEW_TELEMETRY_TOKEN>`.

### Discriminator (`event_kind`)

The payload discriminator routes to one of two ingest targets:
1. `event_kind` absent or `"usage_record"` (#70, #72, #87): Records a completed review round into `usage_records`.
2. `event_kind: "lane_event"` (#71): Records a round that was skipped or not executed into `lane_events`.
3. Any other `event_kind` value is rejected with 400.

### Compatibility Invariant

Backward and forward compatibility is permanent (#70 amendment). Payload fields are never rejected for being unknown (unmapped fields are dropped). Older payload shapes omitting new columns insert cleanly with `NULL` for missing columns.

### Share Levels (#183)

A repository chooses how much it sends with `telemetry.share` in `.github/claude-review.yml`,
and the Worker enforces it: a row never holds more than its `share_level` says.

- Every ingest payload (`POST /ingest`, `POST /pr-state`, `POST /ingest/findings`) may carry
  `share_level`: `rounds` or `full`. Absent means `full`, which is what a lane pinned before
  #183 meant. `counts` is refused with 400 until its key columns are ruled on (#183, comment
  5787138299). So is `off`, which a sender never sends, and any other value:
  `{"error": "invalid share_level"}`.
- The tier map is `worker/tiers.js`. Every column of `usage_records`, `lane_events`,
  `review_findings`, `prs` and `round_agents` sits in exactly one tier (counts, rounds,
  text), which a Worker test pins against the migrations.
- At `rounds`, every text-tier field is stored `NULL`: `pr_title`, `pr_author`,
  `verdict_text`, `raw_result`, `pr_base_ref` and `pr_head_ref`, a lane event's `actor`, a
  finding's `resolved_by_login`, `header_raw`, `body_excerpt` and `diff_hunk`, and a pull
  request's `title` and `author`. A `rounds` write to `prs` also clears title and author
  stored by an earlier `full` write.
- `share_level` is stored on each of the four tables (migration 0017) and returned by
  `GET /api/runs` and `GET /api/findings`.
- `POST /ingest/health` accepts `share` of `full`, `rounds` or `off`.

### Retention (#183)

A daily cron (`23 4 * * *`) runs `purgeExpired`. Text-tier fields on rows older than
`TEXT_RETENTION_DAYS` (default 30) are set to `NULL`, and the row's `share_level` drops from
`full` to `rounds`. The clock is `recorded_at` for `usage_records` and `lane_events`,
`thread_created_at` for `review_findings`, and `updated_at` for `prs`. The purge is
idempotent. Ingest applies the same cutoff: a row whose clock is already past it is written
at `rounds` at most, so a sweep of an old thread cannot put purged text back. The 180-day rounds-tier purge lowers rows to `counts`, so it waits on the same
ruling.

`scripts/audit-telemetry-text.py --remote` reports what `raw_result` and `verdict_text` hold
across stored rows, as field names and lengths, never contents.

### Truncation Rule

Attacker-influencable strings (`pr_title`, `pr_author`, `pr_base_ref`, `pr_head_ref`) are length-capped to 512 characters at ingest rather than rejected (#72).

### Field Specifications

#### `usage_record` (default)
- **Required**: `session_id` (TEXT), `repository` (TEXT).
- **Core Numeric Fields** (INTEGER / REAL): `pr_number`, `run_id`, `run_attempt`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `permission_denials`, `changed_files`, `diff_lines`.
- **Core String Fields** (TEXT): `recorded_at` (ISO string, defaults to current time), `pr_url`, `head_sha`, `run_url`, `round_type`, `model`.
- **JSON Blobs** (TEXT): `per_model_usage` (defaults to `{}`), `subagent_stats`, `raw_result`.
- **Wave 2 Additions**:
  - `lane_version` (TEXT): Workflow lane version (#70 amendment).
  - `verdict_kind` (TEXT): Round verdict category (#70 M1).
  - `verdict_text` (TEXT): Round verdict text (#70 M1).
  - `inline_count` (INTEGER): Count of inline findings (#70 M1).
  - `summary_count` (INTEGER): Count of summary findings (#70 M1).
  - `comment_node_ids` (TEXT, JSON array): Node IDs of GitHub comments (#70 M1). Validated: must be a JSON array, or a string that parses to one; absent/`null` stores `NULL`; anything else is a 400 (#98).
  - `fallback_reason` (TEXT): Reason for model fallback (#70 M2).
  - `range_base` (TEXT): Base commit SHA for incremental range (#70 M2).
  - `range_head` (TEXT): Head commit SHA for incremental range (#70 M2).
  - `model_source` (TEXT): Model resolution source (#70 M3).
  - `config_resolution` (TEXT, JSON object): Snapshot of config layer resolutions (#70 M4). Validated: must be a JSON object, or a string that parses to one; absent/`null` stores `NULL`; anything else is a 400 (#98).
  - `job_conclusion` (TEXT): Workflow job conclusion (#70 M8).
  - `round_ordinal` (INTEGER): Round sequence number per PR (#87).
  - `pr_title` (TEXT, capped to 512): Pull request title (#72).
  - `pr_author` (TEXT, capped to 512): Pull request author login (#72).
  - `pr_state` (TEXT): Pull request state (#72).
  - `pr_base_ref` (TEXT, capped to 512): Pull request base branch name (#72).
  - `pr_head_ref` (TEXT, capped to 512): Pull request head branch name (#72).
  - `agents_status` (TEXT): Rollup outcome for the round's agent fan-out, distinct from an empty
    `agents` array (#89).
- **Wave 3 Additions**:
  - `reviewable_lines` (INTEGER): Reviewable lines this round covered — additions plus modified hunk lines, after path and file-size filtering (#105). Ingested and stored; not yet in the `GET /api/runs` response (allowlisted in `tests/test-schema-drift.py`).
  - `size_override` (INTEGER): 1 when `@claude full review` ran a round that would otherwise have exceeded `max_reviewable_lines`; absent otherwise (#105). Same not-yet-exposed status as `reviewable_lines`.
  - `level` (TEXT): Review effort level the lane resolved for the round (#101). Stored as-is; the worker does not enum it, so a value the workflow schema does not yet accept for this release still stores cleanly.
  - `level_source` (TEXT): `config` or `escalation` — whether `level` came from resolved config or was floored by an `escalation_paths` match (#101).
  - `config_effective` (TEXT, JSON object): `{key: {value, layer}}` for every config key the lane resolved on this round, `layer` one of `workflow`/`org`/`repo`/`summon` (#75). Validated the same as `config_resolution`: must be a JSON object, or a string that parses to one; absent/`null` stores `NULL`; anything else is a 400 (#98).

#### `lane_event`
- **Required**:
  - `repository` (TEXT)
  - `reason` (TEXT, must be exactly one of `no-token`, `auto-paused`, `paused-by-request`, `fork-head`, `skip-author`, `refused-size`, `draft`, `skip-trivial`, `superseded`)
  - `run_id` (INTEGER, finite number)
  - `run_attempt` (INTEGER, finite number)
- **Optional**:
  - `recorded_at` (TEXT, ISO string, defaults to current time)
  - `pr_number` (INTEGER)
  - `head_sha` (TEXT)
  - `run_url` (TEXT)
  - `rounds_used` (INTEGER)
  - `lane_version` (TEXT)
  - `reviewable_lines` (INTEGER): Reviewable-line count on a `refused-size` event (#105).
  - `max_reviewable_lines` (INTEGER): The cap that count was checked against (#105).
  - `actor` (TEXT): The login that issued `@claude pause`, read from the event payload, never from comment text. Null on every reason but `paused-by-request` (#124).

---

## PR State Ingest (`POST /pr-state`) (#136)

Ingests current pull request facts into the `prs` table, authenticated with `Authorization: Bearer <REVIEW_TELEMETRY_TOKEN>`.

### Request Body

- **Required**:
  - `repository` (TEXT, capped to 512): `owner/repo` string.
  - `pr_number` (INTEGER): Pull request number.
  - `source` (TEXT): Exactly one of `round`, `hook`, or `reconciler`.
- **Optional**:
  - `state` (TEXT): Validated against normalised set `open`, `closed`, `merged`.
  - `title` (TEXT, capped to 512): Pull request title.
  - `author` (TEXT, capped to 512): PR author login.
  - `base_ref` (TEXT, capped to 512): PR base branch.
  - `head_ref` (TEXT, capped to 512): PR head branch.
  - `head_sha` (TEXT, capped to 512): PR head commit SHA.
  - `merged_at` (TEXT, capped to 512): ISO 8601 merge timestamp.
  - `closed_at` (TEXT, capped to 512): ISO 8601 close timestamp.
  - `updated_at` (TEXT, capped to 512): ISO 8601 event timestamp from GitHub; falls back to receipt time if omitted.

### Behaviour & Invariants

- **Upsert on `(repository, pr_number)`**: An absent field leaves the stored value alone rather than nulling it. Only what the caller actually knows gets written.
- **Monotonic `updated_at`**: `updated_at` records when the event occurred (from GitHub's `pull_request.updated_at`), falling back to receipt time if omitted.
- **Stale-Write Protection**: A later write with an older `updated_at` cannot overwrite a newer stored row.

## Review Findings Ingest (`POST /ingest/findings`) (#47, #111)

Ingests `claude[bot]` review threads swept from consumer repositories into `review_findings`, authenticated with `Authorization: Bearer <REVIEW_TELEMETRY_TOKEN>` and rate-limited like every other ingest route. The caller is `review-findings-sweep.yml`; gh-workflows itself is never a source, since it hosts no Claude lane.

### Request Body

`{"findings": [...]}` — an array of finding objects, validated individually; the whole request is rejected on the first invalid one. An empty array is accepted and returns 204 with nothing written.

Per finding:
- **Required**: `thread_node_id` (TEXT, non-empty — the primary key), `repository` (TEXT), `pr_number` (INTEGER), `thread_created_at` (TEXT), `body_excerpt` (TEXT), `diff_hunk` (TEXT), `is_resolved` (INTEGER), `is_outdated` (INTEGER), `human_reply_count` (INTEGER), `head_sha_reviewed` (TEXT), `last_swept_at` (TEXT), `row_set_incomplete` (INTEGER). These are required at the application layer even though several are nullable in the schema itself (migration 0009) — the sweep is expected to always know them.
- **Optional / nullable**: `path` (TEXT, capped 1024), `original_line` (INTEGER), `line` (INTEGER), `resolved_by_login` (TEXT, capped 512), `header_raw` (TEXT, capped 1024), `human_reply_sha` (TEXT, capped 128), `fix_sha` (TEXT, capped 128), `fix_sha_source` (TEXT, must be `verify_table` or `human_reply` when present), `verify_verdict` (TEXT, must be `fixed`, `still_applies` or `cannot_verify` when present).

### Behaviour & Invariants

- **Upsert on `thread_node_id`**: A thread is mutable state, not an immutable event. Every column is overwritten from the latest sweep pass rather than only filled in when null, so an edited comment or a newly-resolved thread settles here on the very next sweep.
- **No severity, no `addressed` boolean, no lane column**: Only the Claude lane is ever swept, so nothing here distinguishes lanes and no CodeRabbit row can land in this table.
- **`row_set_incomplete`**: Set by the sweep when a GraphQL throttle stopped its pagination partway through a pull request, so that PR's rows are known partial rather than silently read as a complete sweep.

## Read Contract (v2)

Read endpoints are served under `/api/*` and gated behind Cloudflare Access JWT validation (`verifyAccess`).

### Authentication & Access Control

- Read routes require a valid Cloudflare Access JWT passed in the `Cf-Access-Jwt-Assertion` header.
- If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is not configured in the Worker environment, read endpoints fail closed with **503 Service Unavailable** (`{"error": "read API not configured"}`).
- If the `Cf-Access-Jwt-Assertion` header is missing, expired, signed with an untrusted key, or targeted at a different audience, read endpoints reject the request with **403 Forbidden** (`{"error": "forbidden"}`).

---

### `GET /api/summary`

Returns aggregate metrics and telemetry status over all stored usage records.

#### Response Shape

```json
{
  "rows": 42,
  "repositories": ["prismalens/gh-workflows"],
  "wall_clock_ms": {
    "mean": 5400,
    "p95": 8200
  },
  "denials_per_run": 0.05,
  "cache_hit_rate": 0.82,
  "caching_multiplier": 3.4,
  "total_cost_usd": 1.25,
  "first_recorded_at": "2026-08-01T00:00:00.000Z",
  "last_recorded_at": "2026-08-31T22:00:00.000Z",
  "verdict_kinds": {
    "clean": 35,
    "findings": 7
  },
  "fallback_reasons": {
    "none": 42
  },
  "model_sources": {
    "workflow-default": 42
  }
}
```

- **Aggregated breakdowns** (`verdict_kinds`, `fallback_reasons`, `model_sources`): Computed using aggregate SQL `GROUP BY` counts. Empty object `{}` when no records match.

---

### `GET /api/runs`

Returns paginated telemetry review rounds from `usage_records`.

#### Query Parameters

- `limit` (optional): Integer `1`..`1000` (default `100`). When `include=blobs`, `limit` is capped to at most `50`.
- `repository` (optional): Filter by exact repository string (e.g. `prismalens/gh-workflows`).
- `round_type` (optional): Filter by round type (e.g. `review`, `incremental`, `verify`).
- `since` (optional): ISO timestamp lower bound on `recorded_at` (`recorded_at >= ?`).
- `until` (optional): ISO timestamp upper bound on `recorded_at` (`recorded_at <= ?`).
- `cursor` (optional): Composite cursor `<recorded_at>|<session_id>` for pagination.
- `include` (optional): Must be `"blobs"`. Includes heavy JSON/text blob columns and caps limit at 50.

#### Selected Columns

- **Default Response**:
  - v1 columns: `session_id`, `recorded_at`, `repository`, `pr_number`, `pr_url`, `head_sha`, `run_id`, `run_attempt`, `run_url`, `round_type`, `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `permission_denials`, `changed_files`, `diff_lines`.
  - 16 Wave 2 columns: `lane_version`, `verdict_kind`, `inline_count`, `summary_count`, `round_ordinal`, `fallback_reason`, `range_base`, `range_head`, `model_source`, `job_conclusion`, `pr_title`, `pr_author`, `pr_state`, `pr_base_ref`, `pr_head_ref`, `agents_status`.
  - 2 Wave 3 columns: `level`, `level_source`. `reviewable_lines` and `size_override` are ingested (see the `usage_record` field spec above) but not yet selected here — allowlisted in `tests/test-schema-drift.py` as not yet surfaced.
- **Behind `include=blobs`**:
  - v1 blobs: `per_model_usage`, `subagent_stats`, `raw_result`.
  - Wave 2 blobs: `verdict_text`, `comment_node_ids`, `config_resolution`.
  - Wave 3 blob: `config_effective`.

#### Response Shape

```json
{
  "rows": [ ... ],
  "next_cursor": "2026-08-31T12:00:00.000Z|session-123"
}
```

---

### `GET /api/lane-events`

Returns paginated lane lifecycle events from `lane_events` (skipped or non-executed rounds).

#### Query Parameters

- `limit` (optional): Integer `1`..`1000` (default `100`).
- `repository` (optional): Filter by exact repository string.
- `since` (optional): ISO timestamp lower bound on `recorded_at` (`recorded_at >= ?`).
- `until` (optional): ISO timestamp upper bound on `recorded_at` (`recorded_at <= ?`).
- `cursor` (optional): Composite cursor `<recorded_at>|<run_id>` for pagination.

#### Columns

- `run_id`, `run_attempt`, `recorded_at`, `repository`, `reason`, `pr_number`, `head_sha`, `run_url`, `rounds_used`, `lane_version`, `reviewable_lines`, `max_reviewable_lines`, `actor`.

#### Response Shape

```json
{
  "rows": [
    {
      "run_id": 123456,
      "run_attempt": 1,
      "recorded_at": "2026-08-31T14:20:00.000Z",
      "repository": "prismalens/gh-workflows",
      "reason": "auto-paused",
      "pr_number": 88,
      "head_sha": "aabbccddeeff00112233445566778899aabbccdd",
      "run_url": "https://github.com/prismalens/gh-workflows/actions/runs/123456",
      "rounds_used": 3,
      "lane_version": "v2.0.0",
      "reviewable_lines": null,
      "max_reviewable_lines": null,
      "actor": null
    }
  ],
  "next_cursor": "2026-08-31T14:20:00.000Z|123456"
}
```

---

### `GET /api/findings`

Returns paginated `claude[bot]` review findings from `review_findings`, newest first by `thread_created_at` (#111, #75). Same shape family as `GET /api/lane-events`: explicit column list, cursor pagination, `verifyAccess` applied by the caller. A findings inbox and a PR-scoped panel are the same query with `pr_number` added.

#### Query Parameters

- `limit` (optional): Integer `1`..`1000` (default `1000`).
- `repository` (optional): Filter by exact repository string.
- `pr_number` (optional): Filter by exact pull request number.
- `cursor` (optional): Composite cursor `<thread_created_at>|<thread_node_id>` for pagination.

#### Columns

Every `review_findings` column (`tests/test-schema-drift.py`'s `REVIEW_FINDINGS_READ_ALLOWLIST` is deliberately empty, so a migration that adds one and forgets the `SELECT` fails CI): `thread_node_id`, `repository`, `pr_number`, `path`, `original_line`, `line`, `is_resolved`, `is_outdated`, `resolved_by_login`, `thread_created_at`, `header_raw`, `body_excerpt`, `diff_hunk`, `human_reply_count`, `human_reply_sha`, `fix_sha`, `fix_sha_source`, `verify_verdict`, `head_sha_reviewed`, `last_swept_at`, `row_set_incomplete`.

#### Response Shape

```json
{
  "rows": [ ... ],
  "next_cursor": "2026-08-31T14:20:00.000Z|PRRT_kwABC123"
}
```

---

### `GET /api/health-reports`

Returns the weekly rows `telemetry-health.yml` posts to `POST /ingest/health`, from `health_reports` (#176, #179), newest `window_start` first. Every row comes back as it arrived: an oversize week lands as several tiling rows and a re-run inserts again, and the route merges none of them.

#### Query Parameters

- `limit` (optional): Integer `1`..`200` (default `52`, a year of weeks). Not capped lower under `include=blobs`: unlike `/api/runs`, this route's blob columns are bounded by a report's own run count, and the Weekly health tab is the one caller and always wants every row it can get.
- `repository` (optional): Filter by exact repository string.
- `cursor` (optional): Composite cursor `<window_start>|<id>` for pagination.
- `include` (optional): Must be `"blobs"`. Adds the two JSON blob columns below.

#### Columns

Every `health_reports` column except the two blob columns: `id`, `repository`, `repository_id`, `window_start`, `window_end`, `runs_seen`, `runs_accounted`, `startup_failures`, `findings_swept`, `share`, `ingest_auth`, `received_at`. With `include=blobs`, also `unaccounted_runs` (an array of `{ id, conclusion, created_at }`) and `lane_events_by_reason` (reason to count), both JSON strings as stored.

#### Response Shape

```json
{
  "rows": [ ... ],
  "next_cursor": "2026-09-14T00:00:00Z|7"
}
```

---

### `GET /api/round-agents`

Returns per-agent rows for one round from `round_agents`, ordered by `agent_id` ascending (#131, #89).

#### Query Parameters

- `session_id` (required): Exact match on the round's `session_id`. Missing returns 400.
- `limit` (optional): Integer `1`..`1000` (default `64`).

#### Columns

- `session_id`, `agent_id`, `subagent_type`, `spawn_depth`, `status`, `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `duration_ms`, `tool_uses`, `tool_uses_by_name`, `file_paths`.

#### Response Shape

```json
{
  "rows": [ ... ],
  "next_cursor": null
}
```

This route has no cursor pagination; `next_cursor` is always `null` and `limit` is the only cap.

---

### `GET /api/prs`

Returns paginated pull request state records from `prs`.

#### Query Parameters

- `limit` (optional): Integer `1`..`1000` (default `100`).
- `repository` (optional): Filter by exact repository string.
- `state` (optional): Filter by state (`open`, `closed`, `merged`).
- `cursor` (optional): Composite cursor `<updated_at>|<repository>|<pr_number>` for pagination.

#### Columns

- `repository`, `pr_number`, `state`, `title`, `author`, `base_ref`, `head_ref`, `head_sha`, `merged_at`, `closed_at`, `updated_at`, `source`.

#### Response Shape

```json
{
  "rows": [
    {
      "repository": "prismalens/gh-workflows",
      "pr_number": 136,
      "state": "open",
      "title": "feat: a prs table",
      "author": "alice",
      "base_ref": "main",
      "head_ref": "feat/prs-table",
      "head_sha": "abc1234",
      "merged_at": null,
      "closed_at": null,
      "updated_at": "2026-09-06T12:00:00.000Z",
      "source": "hook"
    }
  ],
  "next_cursor": "2026-09-06T12:00:00.000Z|prismalens/gh-workflows|136"
}
```

---

### `GET /api/accounted-runs`

Programmatic read route for the scheduled telemetry reconciler (#87). Returns the distinct `run_id` values appearing in either `usage_records` or `lane_events` inside the requested window.

#### Authentication

Authenticated via `Authorization: Bearer <REVIEW_TELEMETRY_TOKEN>`, using the same shared secret as telemetry ingest.

#### Query Parameters

- `repository` (required): Filter by exact repository string (`owner/repo`).
- `since` (required): ISO 8601 UTC timestamp lower bound on `recorded_at` (`recorded_at >= ?`).
- `until` (required): ISO 8601 UTC timestamp upper bound on `recorded_at` (`recorded_at <= ?`).
- Capped at a maximum window of 30 days.

#### Response Shape

```json
{
  "repository": "prismalens/gh-workflows",
  "since": "2026-08-30T00:00:00Z",
  "until": "2026-08-31T02:00:00Z",
  "run_ids": [1001, 1002, 1003]
}
```

---

### `GET /api/changes`

Returns paginated named changes from `changes`, ordered newest `at` first.

#### Query Parameters

- `limit` (optional): Integer `1`..`1000` (default `100`).
- `cursor` (optional): Composite cursor `<at>|<id>` for pagination.

#### Response Shape

```json
{
  "rows": [
    {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "name": "Upgrade reviewer to Claude 3.7 Sonnet",
      "at": "2026-08-31T12:00:00.000Z",
      "source_url": "https://github.com/prismalens/gh-workflows/pull/73",
      "scope": "repo",
      "repository": "prismalens/gh-workflows",
      "created_at": "2026-08-31T12:05:00.000Z"
    }
  ],
  "next_cursor": "2026-08-31T12:00:00.000Z|f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

---

### `POST /api/changes`

Creates a named change row with server-generated `id` (`crypto.randomUUID()`) and server-stamped `created_at` (`new Date().toISOString()`).

#### Validation Rules

- `name` (required, string): Non-empty, capped at 200 characters.
- `at` (required, string): ISO 8601 instant, normalized and stored in UTC.
- `scope` (required, string): Exactly `"repo"` or `"fleet"`.
- `repository` (string): Required when `scope` is `"repo"`; must be absent or `null` when `scope` is `"fleet"`.
- `source_url` (optional, string): Must start with `https://` and be capped at 500 characters when present.

#### Authentication & Service Token Dependency

The write route uses `verifyAccess`, the same Cloudflare Access check as all `/api/*` read routes. It does not reuse the ingest token.

Writing a change row via `curl` requires a Cloudflare Access **Service Token** configured on the application by the operator. Cloudflare Access is a browser authentication flow by default; the service token must exist on the Access application before non-browser HTTP requests can authenticate.

```bash
# Writing a change requires an Access Service Token configured on the application first.
curl -X POST https://assayer.sfun.cloud/api/changes \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: <SERVICE_TOKEN_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <SERVICE_TOKEN_CLIENT_SECRET>" \
  -d '{
    "name": "Upgrade reviewer to Claude 3.7 Sonnet",
    "at": "2026-08-31T12:00:00Z",
    "scope": "repo",
    "repository": "prismalens/gh-workflows",
    "source_url": "https://github.com/prismalens/gh-workflows/pull/73"
  }'
```

---

### `DELETE /api/changes/:id`

Removes a change row by `id`. Returns 204. Idempotent when the `id` does not exist.

#### Deliberate Omission of `PATCH`

Editing a change row silently rewrites the anchor of every comparison already drawn against it, and nothing would say so.
A mis-entered change is deleted and re-added.

---

### `GET /api/fleet/repos`

Serves the dashboard's `/repos` page from aggregates alone (#185). A fleet route carries counts and
identifiers, never a name, a title or a body: its SQL never names `pr_title`, `pr_author`,
`verdict_text`, `header_raw`, `body_excerpt`, `raw_result` or `diff_hunk`, which
`tests/test-fleet-wall.py` and the Worker tests pin.

#### Query Parameters

- `range` (required): one of `rolling`, `30d`, `90d`, `all`. Anything else is **400** (`{"error": "invalid range"}`).

#### Window

The Worker computes the window, so the label always agrees with the rows counted:

- `30d` / `90d`: `recorded_at >= now - N days`, labelled `the last N days`.
- `all`: no predicate, labelled `all recorded rounds`.
- `rolling`: the last 50 rounds or the last 7 days, whichever holds more, the same rule as
  `applyRange` in `dashboard/src/honesty/range.ts`. When the last 7 days hold at least as many
  rounds as the 50-round side, the window is 7 days (`the last 7 days`). Otherwise it starts at
  the 50th most recent round (`the last 50 rounds`), or, when fewer than 50 rounds exist, keeps
  every round under the same label with `since: null`.

#### Response Shape

```json
{
  "window": { "range": "rolling", "since": "2026-09-14T00:00:00.000Z", "label": "the last 7 days" },
  "rounds": 12,
  "repositories": [
    {
      "repository": "prismalens/gh-workflows",
      "rounds": 3,
      "denials": 1,
      "last_round": { "session_id": "s-1", "recorded_at": "2026-09-20T00:00:00.000Z", "round_type": "full", "verdict_kind": "reviewed" },
      "last_recorded_at": "2026-09-20T00:00:00.000Z"
    }
  ],
  "malformed_configs": [{ "repository": "prismalens/gh-workflows", "layer": "repo_config" }]
}
```

- `repositories` lists every repository that has ever posted, sorted. One quiet in the window has
  `rounds: 0`, `denials: 0` and `last_round: null`; `last_recorded_at` is its all-time latest round.
- `rounds` is the sum across `repositories`. `window.since` is `null` for `all`, and for `rolling` when fewer than 50 rounds exist.
- `malformed_configs` names each repository and layer where the newest round in the window carrying
  that layer recorded it as `unparseable` or `schema-rejected`, decided in SQL over
  `config_resolution`, sorted by repository and then layer order `repo_config`, `org_defaults`,
  `workflow_inputs`.
- A D1 error is **500** (`{"error": "query failed"}`).

### `GET /api/fleet/findings`

Serves the dashboard's `/findings?view=counts` from counts alone (#185 F3). It decodes the fates
that `decodeFate` and `decodeDivergence` in `dashboard/src/features/findings/findings.ts` decode,
as SQL sums over `review_findings`, and never selects a header, body, hunk or path. The
workflow-actor logins behind `self-graded` are one list in both places, pinned by
`tests/test-fleet-wall.py`.

#### Query Parameters

- `pr_state` (optional): `open`, `merged`, `closed` or `all`. Matched against `prs.state`; a
  finding whose pull request has no `prs` row counts only when `pr_state` is absent or `all`.
- `repository` (optional): one repository. The dashboard does not send it.

Anything else is **400** (`{"error": "invalid pr_state"}` or `{"error": "invalid repository"}`).

#### Response Shape

```json
{
  "filter": { "repository": null, "pr_state": "merged" },
  "totals": {
    "findings": 8, "never_answered": 3, "pushback_open": 1, "resolved_by_human": 1, "self_graded": 3,
    "fix_cited": 1, "still_applies": 1, "verified_fixed_but_open": 1, "not_addressed_but_resolved": 1,
    "incomplete_prs": 1
  },
  "repositories": [{ "repository": "o/a", "findings": 7, "...": "the same counts", "review_to_merge_hours": [12] }],
  "review_to_merge_hours": [12]
}
```

- The four fates partition `findings`. `fix_cited` counts a non-empty `fix_sha` whatever the fate.
- `incomplete_prs` counts pull requests with any `row_set_incomplete = 1` row.
- `review_to_merge_hours` has one entry per merged pull request that has a finding: hours from its
  earliest `thread_created_at` to `merged_at`, floored at zero, ascending.
- A D1 error is **500** (`{"error": "query failed"}`).

---

## Control plane (#184)

The runner pulls review jobs from these routes. A runner authenticates with its own runner token
(`Authorization: Bearer asr_…`); the admin routes sit behind Cloudflare Access, the same check
and the same service-token dependency as `POST /api/changes`. Every `/runner/*` route is rate
limited before the token is looked up, and every error body is `{"error": "<code>"}`.

| Route | Auth | Body or query | Responses |
|---|---|---|---|
| `POST /api/runners` | Access | `{name}`, 1 to 100 chars | 201 `{id, name, token}`; 400 |
| `GET /api/runners` | Access | none | 200 `{rows: [{id, name, created_at, revoked_at, last_seen_at, placement, credentials: [...]}]}` |
| `DELETE /api/runners/:id` | Access | none | 204, idempotent; 400 `invalid-id` |
| `POST /api/jobs` | Access | `{repository, pr_number, base_sha, head_sha, mode, engine, credential_kind, level?, model?, config_effective?}` | 201 `{job_id}`; 200 `{job_id, state, duplicate: true}`; 400 |
| `POST /runner/register` | runner token | `{placement: box, credentials: [{engine, kind, fingerprint, concurrency}]}` | 200 `{runner_id, credentials, heartbeat_timeout_s, lease_wait_max_s}`; 400; 409 `duplicate-fingerprint` |
| `GET /runner/lease?engine=&kind=&wait=` | runner token | `wait` 0 to 20 s, default 20 | 200 `{job, installation_token, installation_token_expires_at, heartbeat_timeout_s}`; 204 no job; 400; 409 `unregistered-credential`; 502 `token-mint-failed`; 503 `app-unconfigured` |
| `POST /runner/jobs/:id/events` | runner token | `{events: [assayer/v1 ...]}`, `[]` is a heartbeat | 204; 400 `invalid-event`; 403 `not-lease-holder`; 404; 409 `lease-lost`; 413 `too-many-events` or `event-too-large` |

Every runner route also answers 401 with an empty body for a missing, malformed, unknown or
revoked token, 413 for a body over 1 MB and 429 when rate limited.

### Runner tokens

`POST /api/runners` returns the token once. D1 holds its SHA-256 only, so a lost token is
revoked and a new runner created. One token per registration: revoking a runner
(`DELETE /api/runners/:id`) stops that runner alone and releases its credential fingerprints.

```bash
curl -X POST https://assayer.sfun.cloud/api/runners \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: <SERVICE_TOKEN_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <SERVICE_TOKEN_CLIENT_SECRET>" \
  -d '{"name": "vps-1"}'
```

Registration refuses a fingerprint a different, unrevoked runner holds (design §7). The same
runner re-registering after a restart replaces its own set. There is no subscription credential
kind and no laptop placement: a subscription runs only in the author's own harness (#184).

### Jobs

One active job per pull request. `POST /api/jobs` with the head an active job already has is
idempotent; a new head marks the queued job `superseded` and enqueues; a leased or running job is
left to finish. The webhook (bullet 4) enqueues through the same `enqueueJob`.

```
queued ──lease──▶ leased ──first event──▶ running ──finished event──▶ finished
  ▲                  │                       │
  └── heartbeat timeout, first expiry ───────┘   second expiry ──▶ failed (heartbeat-timeout)
queued ──new head──▶ superseded
leased ──App not installed on the repository──▶ failed (app-not-installed)
```

The heartbeat sweep runs at the top of `GET /runner/lease` and `POST /runner/register`, not on a
cron: it only matters while a runner is polling. A lease is claimed only for an
`(engine, credential_kind)` pair the runner registered.

On `finished`, the events route writes the round: one `usage_records` row keyed by the job id
(`ingest_auth = 'runner'`, `engine`, repository and range from the job) and one `round_agents` row
per `agent` event. `finding` and `summary` events stay in `job_events` for the poster (bullet 5).

### The installation token

The lease mints a token scoped to the job's one repository with `contents`, `metadata`,
`pull_requests` and `issues` read (`worker/github-app.js`) and returns it to the runner.
The control plane never stores the installation token and cannot revoke it. The runner revokes it on every exit path; a runner that dies without revoking leaves a read-only, one-repository token that lapses at GitHub's fixed one-hour expiry. Revoke a suspect runner with `DELETE /api/runners/:id`, which ends its leases and events immediately.

### Rate-limit budget

`INGEST_RATE_LIMITER` allows 30 requests a minute per IP, shared with ingest. A runner long-polls
the lease at 20 s and batches events at 10 s or more, which stays inside it.

### Known limits

- The Worker does not enforce `concurrency`; the runner leases one job per slot (design §3.2).
- `credential_type` on a runner round is the job's `credential_kind` verbatim (`api-key`, ...),
  while the Actions lane writes `oauth` or `api_key`. Bullet 6 reconciles the vocabulary.

### Secrets and vars

| Name | Kind | Purpose |
|---|---|---|
| `GITHUB_APP_ID` | secret | The App's numeric id |
| `GITHUB_APP_PRIVATE_KEY` | secret | The App's key in PKCS#8. GitHub hands out PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem` |
| `GITHUB_WEBHOOK_SECRET` | secret | Reserved for `POST /webhook/github` (bullet 4) |
| `RUNNER_HEARTBEAT_TIMEOUT_S` | var | Seconds without a heartbeat before a lease expires; default 300 |
| `LEASE_POLL_MS` | var | Interval between claim attempts inside one long-poll; default 2000 |

### Registering the App

`worker/github-app.manifest.json` pins the App's permissions (`tests/test-app-manifest.py`).
One App per install; there is no shared App.

1. Replace `CONTROL_PLANE_HOST` in the manifest's `hook_attributes.url` with the Worker's host.
2. Submit the JSON as the `manifest` field of a form POST to
   `https://github.com/organizations/prismalens/settings/apps/new`, and confirm on GitHub.
3. Within an hour, exchange the returned `code`:
   `gh api -X POST /app-manifests/<code>/conversions`. The response carries `id`, `pem` and
   `webhook_secret`.
4. Convert `pem` to PKCS#8 (the openssl line above), then `wrangler secret put` each of
   `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`.
5. Install the App on sreforge only.
6. Apply migration 0016 with the **Apply D1 migrations** workflow.

---

## Local Development & Deployment

```bash
npm ci
npm run dev     # Start local worker dev server
npm run deploy  # Deploy worker to Cloudflare (requires built dashboard in ../dashboard/dist)
```
