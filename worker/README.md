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
3. **Pending Migration Detection**: The deploy workflow checks for unapplied remote migrations using `wrangler d1 migrations list review-telemetry --remote` and emits a warning in the workflow run summary if pending migrations are detected.

## Local Development & Deployment

```bash
npm ci
npm run dev     # Start local worker dev server
npm run deploy  # Deploy worker to Cloudflare (requires built dashboard in ../dashboard/dist)
```
