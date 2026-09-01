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

## Local Development & Deployment

```bash
npm ci
npm run dev     # Start local worker dev server
npm run deploy  # Deploy worker to Cloudflare (requires built dashboard in ../dashboard/dist)
```
