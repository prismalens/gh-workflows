# Assayer dashboard

The review telemetry viewing layer for `prismalens/gh-workflows`. A Vite + React SPA served by
the telemetry Worker in `../worker` through its `[assets]` binding, reading the Worker's existing
`GET /api/summary` and `GET /api/runs` routes behind Cloudflare Access.

This slice ships two routes: `/rounds` and `/rounds/$sessionId`. The overview, `/repos`, the
failures page, compare and every PR view arrive with their own issues (#46). Recharts is not
installed: it arrives in slice 2 with the first chart that needs it.

## Commands

```bash
npm ci                      # install; the lockfile is committed
npm run build               # tsc -b && vite build, into dist/
npm test                    # vitest: honesty rules, API contract, both routes
npx tsc -b                  # typecheck alone
npm run dev                 # Vite dev server, proxying /api to 127.0.0.1:8787
VITE_FIXTURES=1 npm run dev # same, but against the in-memory fixture table
```

`dist/` is gitignored. A deploy has to build it first:

```bash
npm --prefix dashboard ci
npm --prefix dashboard run build
npm --prefix worker ci
cd worker && ./node_modules/.bin/wrangler deploy
```

Never a bare `npx wrangler`. `worker/package.json` pins wrangler because
`run_worker_first` in its array form needs 4.20.0 or later, and on an older wrangler the
assets binding silently shadows `POST /`. `.github/workflows/deploy-worker.yml` runs these
same steps on every merge to `main` that touches `worker/` or `dashboard/`, and asserts the
resolved version before it deploys. Story: #84.

## Deploy note

Attaching an `[assets]` binding would shadow the Worker's `POST /` ingest alias, because the asset
router answers a POST to the site root with 405 and never invokes the Worker. Both ingest shapes
keep working because `run_worker_first = ["/", "/ingest", "/api/*"]` puts the Worker ahead of asset
serving on exactly those paths, and `"/"` matches the root only. The Worker then serves the SPA
shell for `GET /` through its `ASSETS` binding; every other client-side route is asset-served under
`not_found_handling = "single-page-application"` without invoking the Worker at all.

So `REVIEW_TELEMETRY_URL` ending in `/ingest` is the recommendation, not a requirement: the bare
origin still reaches the ingest handler. Verified with `wrangler dev --local` against this exact
configuration.

## Where the rules live

The sparse-range rulings of #46 are code, not convention, and they live in `src/honesty/`:

- `thresholds.ts` holds every number: low-n at 10, p95 minimum at 20, tiles withheld under 10
  rounds, the 50-round / 7-day rolling window.
- `metrics.ts` returns a `Metric`, never a bare number. A `Metric` carries its own `n` and any
  flag it earned, which is what puts `n` on every tile and substitutes max for an unsupported p95.
- `Tile.tsx` is the only tile component, takes a `Metric`, and throws on a money label.
- `TileStrip.tsx` decides between tiles, the table, and "no rounds in range".
- `RangeControl.tsx` renders the four buttons from `RANGE_KEYS`. There is no date picker.
- `Degraded.tsx` renders a missing field as a permanent labelled state, and distinguishes a field
  that is not built yet from one this round's lane never sent.

## Fixtures

`src/fixtures/rounds.ts` builds rounds from `../worker/schema.sql` and the extraction step in
`.github/workflows/claude-code-review.yml`. `src/fixtures/api.ts` reimplements the Worker's
`handleRuns` and `handleSummary` filter, ordering, limit and cursor semantics so the route tests
exercise the real contract. The live deployment is behind Access and is never scraped for these.
