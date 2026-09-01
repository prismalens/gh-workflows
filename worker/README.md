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

The payload discriminator routes to one of three ingest targets:
1. `event_kind` absent or `"usage_record"` (#70, #72, #87): Records a completed review round into `usage_records`.
2. `event_kind: "lane_event"` (#71): Records a round that was skipped or not executed into `lane_events`.
3. `event_kind: "canary"` (#87): Upserts a single heartbeat row in `canary_pings` (`id = 'canary'`) to verify end-to-end write availability. Returns 204.
4. Any other `event_kind` value is rejected with 400.

### Compatibility Invariant

Backward and forward compatibility is permanent (#70 amendment). Payload fields are never rejected for being unknown (unmapped fields are dropped). Older payload shapes omitting new columns insert cleanly with `NULL` for missing columns.

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

#### `lane_event`
- **Required**:
  - `repository` (TEXT)
  - `reason` (TEXT, must be exactly one of `no-token`, `auto-paused`, `fork-head`, `skip-author`)
  - `run_id` (INTEGER, finite number)
  - `run_attempt` (INTEGER, finite number)
- **Optional**:
  - `recorded_at` (TEXT, ISO string, defaults to current time)
  - `pr_number` (INTEGER)
  - `head_sha` (TEXT)
  - `run_url` (TEXT)
  - `rounds_used` (INTEGER)
  - `lane_version` (TEXT)

#### `canary`
- **Optional**:
  - `last_seen_at` / `recorded_at` (TEXT, ISO string, defaults to current time)
  - `run_url` (TEXT)
  - `lane_version` (TEXT)

## Read Contract (v2)

Read endpoints are served under `/api/*` and gated behind Cloudflare Access JWT validation (`verifyAccess`).

### Authentication & Access Control

- Read routes require a valid Cloudflare Access JWT passed in the `Cf-Access-Jwt-Assertion` header.
- If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is not configured in the Worker environment, read endpoints fail closed with **503 Service Unavailable** (`{"error": "read API not configured"}`).
- If the `Cf-Access-Jwt-Assertion` header is missing, expired, signed with an untrusted key, or targeted at a different audience, read endpoints reject the request with **403 Forbidden** (`{"error": "forbidden"}`).

---

### `GET /api/summary`

Returns aggregate metrics and telemetry status over all stored usage records and canary health.

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
  },
  "canary_last_seen_at": "2026-08-31T22:30:00.000Z"
}
```

- **Aggregated breakdowns** (`verdict_kinds`, `fallback_reasons`, `model_sources`): Computed using aggregate SQL `GROUP BY` counts. Empty object `{}` when no records match.
- **`canary_last_seen_at`**: Read directly from the singleton `canary_pings` row (`id = 'canary'`). Returns `null` when `canary_pings` is empty (never `0` and never a fabricated timestamp). Returns the last canary timestamp even if `usage_records` is empty.

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
  - 15 Wave 2 columns: `lane_version`, `verdict_kind`, `inline_count`, `summary_count`, `round_ordinal`, `fallback_reason`, `range_base`, `range_head`, `model_source`, `job_conclusion`, `pr_title`, `pr_author`, `pr_state`, `pr_base_ref`, `pr_head_ref`.
- **Behind `include=blobs`**:
  - v1 blobs: `per_model_usage`, `subagent_stats`, `raw_result`.
  - Wave 2 blobs: `verdict_text`, `comment_node_ids`, `config_resolution`.

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

- `run_id`, `run_attempt`, `recorded_at`, `repository`, `reason`, `pr_number`, `head_sha`, `run_url`, `rounds_used`, `lane_version`.

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
      "lane_version": "v2.0.0"
    }
  ],
  "next_cursor": "2026-08-31T14:20:00.000Z|123456"
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
curl -X POST https://review-telemetry.sfun.cloud/api/changes \
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

## Local Development & Deployment

```bash
npm ci
npm run dev     # Start local worker dev server
npm run deploy  # Deploy worker to Cloudflare (requires built dashboard in ../dashboard/dist)
```
