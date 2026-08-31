# Assayer dashboard

The review telemetry viewing layer for `prismalens/gh-workflows`. A Vite + React SPA served by
the telemetry Worker in `../worker` through its `[assets]` binding, reading the Worker's existing
`GET /api/summary` and `GET /api/runs` routes behind Cloudflare Access.

This slice ships two routes: `/rounds` and `/rounds/$sessionId`. The overview, `/repos`, the
failures page, compare and every PR view arrive with their own issues (#46).

## Commands

```
npm ci                      # install; the lockfile is committed
npm run build               # tsc -b && vite build, into dist/
npm test                    # vitest: honesty rules, API contract, both routes
npx tsc -b                  # typecheck alone
npm run dev                 # Vite dev server, proxying /api to 127.0.0.1:8787
VITE_FIXTURES=1 npm run dev # same, but against the in-memory fixture table
```

`dist/` is gitignored. A deploy has to build it first:

```
npm --prefix dashboard ci
npm --prefix dashboard run build
cd worker && npx wrangler deploy
```

## Deploy note

Attaching the `[assets]` binding shadows the Worker's `POST /` ingest alias: the asset router
answers a POST to the site root with 405 and never reaches the Worker. `POST /ingest` is
unaffected, so `REVIEW_TELEMETRY_URL` must end in `/ingest`. Verified with `wrangler dev --local`
against this configuration.

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
