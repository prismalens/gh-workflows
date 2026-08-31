# Assayer dashboard

The review telemetry viewing layer for `prismalens/gh-workflows`. A Vite + React SPA served by
the telemetry Worker in `../worker` through its `[assets]` binding, reading the Worker's existing
`GET /api/summary` and `GET /api/runs` routes behind Cloudflare Access.

Four routes ship: `/` overview, `/rounds`, `/rounds/$sessionId` and `/repos`. The failures page,
compare and every PR view arrive with their own issues (#46).

The overview's altitude is a ruling, not a layout preference. The first screenful is throughput
and adoption: the activity band, then the verdict strip directly under it, because the strip is
what makes the band's counts trustworthy. Lane health and the diagnostics charts sit below.
**Counts headline at every volume**, because a count is true at any n; only the line under a
count switches, from an all-time cumulative to a per-day mean at
`PER_DAY_RATE_MIN_ROUNDS`.

`/repos` lists every repository that has ever posted, whether or not it posted inside the
selected window. Its "active over total" figure counts repositories that have posted, and says
so: no fleet registry exists, so the denominator a real adoption number would need is not
capturable yet.

## Commands

Run from `dashboard/`. The suite needs **Node `^22.22.2 || ^24.15.0 || >=26.0.0`**, which is
jsdom 30's floor. On an older Node, `npm ci` prints one `EBADENGINE` warning and the suite still
runs, so a green result there proves less than it looks like. CI pins Node 24, which resolves
above the floor.

```bash
npm ci                      # install; the lockfile is committed
npm run build               # tsc -b && vite build, into dist/
npm test                    # vitest: honesty rules, API contract, both routes
npx tsc -b                  # typecheck alone
npm run dev                 # Vite dev server, proxying /api to 127.0.0.1:8787
VITE_FIXTURES=1 npm run dev # same, but against the in-memory fixture table
```

`dist/` is gitignored. A deploy has to build it first. Unlike the block above, these run
**from the repository root**, not from `dashboard/`:

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
- `Tile.tsx` holds both tiles. `Tile` takes a `Metric` and is the only way to render an
  aggregate. `CountTile` takes a count, carries no `n` because the count is its own `n`, and
  never collapses at low volume. Both throw on a money label.
- `TileStrip.tsx` decides between tiles, the table, and "no rounds in range".
- `verdict.ts` is the two-state decoding. `reviewed` is claimed only from a round type that reads
  the head; everything else, verify rounds included, says `unknown`. Four-state verdicts arrive
  with issue 02, and for a lane older than the Worker they never arrive at all.
- `RangeControl.tsx` renders the four buttons from `RANGE_KEYS`. There is no date picker.
- `Degraded.tsx` renders a missing field as a permanent labelled state, and distinguishes a field
  that is not built yet from one this round's lane never sent.

## Fixtures

`src/fixtures/rounds.ts` builds rounds from `../worker/schema.sql` and the extraction step in
`.github/workflows/claude-code-review.yml`. `src/fixtures/api.ts` reimplements the Worker's
`handleRuns` and `handleSummary` filter, ordering, limit and cursor semantics so the route tests
exercise the real contract. The live deployment is behind Access and is never scraped for these.
