# Research: Review-Lane Usage Records Storage & Viewing Architecture

## 1. Recommendation Up Front

- **Storage Winner: Option C (Google Apps Script Web App backed by Google Sheets)**
  - *Single reason it wins*: Solves small-data storage (<50 rows/day) with zero maintenance, permanent retention (no cold-start pauses or hard-deletes), a trivial 8-line `doPost(e)` endpoint, and 1 URL secret across repository owners.
- **Viewing Winner: Looker Studio (connected directly to the Google Sheet)**
  - *Single reason it wins*: Zero-code BI dashboard built in under 30 minutes that natively supports date range filtering, repository/round dropdowns, time-series charts, and clickable PR/Run URLs via `HYPERLINK()`.
- **Second Choice: Option B (Cloudflare Workers + D1 with Pages UI)**
  - *Why it is second*: True serverless SQL with zero-cost scale-to-zero and no inactivity deletion, but requires building and maintaining ~150 lines of custom HTML/Chart.js/SQL frontend.
  - *What would change the call*: If Google Apps Script execution latency (>2s) or Google ecosystem lock-in becomes unacceptable, or if multi-dimensional SQL querying across millions of rows is ever required.

---

## 2. Cache Arithmetic (Question 1)

Primary sources checked on 2026-08-30:
- [Anthropic Prompt Caching Docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Pricing Overview](https://www.anthropic.com/pricing)

### Multipliers & Base Rates
- **Cache Read Cost**: **0.10x** base input rate (90% discount on cache hits).
- **Cache Write Cost**:
  - **5-minute TTL**: **1.25x** base input rate (+25% creation premium).
  - **1-hour TTL**: **2.00x** base input rate (+100% creation premium).
- **Base Model Rates**:
  - `claude-sonnet-5`: **$2.00 / MTok** input ($0.000002/tok), **$10.00 / MTok** output ($0.000010/tok).
  - `claude-opus-5`: **$10.00 / MTok** input ($0.000010/tok), **$50.00 / MTok** output ($0.000050/tok).

### Exact Formula: Money Saved Versus No-Cache Request
Let $R_{in}$ be the base input token price ($/token). Without cache, all input tokens $(\text{input} + \text{cache\_creation} + \text{cache\_read})$ are billed at $R_{in}$. With cache, reads receive a 90% discount while writes incur a 25% (5m) or 100% (1h) premium:

$$\text{Savings} = R_{in} \times \left[ 0.90 \times \text{cache\_read\_input\_tokens} - 0.25 \times \text{cache\_creation}_{5m} - 1.00 \times \text{cache\_creation}_{1h} \right]$$

If the payload aggregates creation tokens under default 5m TTL:
$$\text{Savings}_{5m} = R_{in} \times \left( 0.90 \times \text{cache\_read\_input\_tokens} - 0.25 \times \text{cache\_creation\_input\_tokens} \right)$$

### What the Formula Does NOT Account For / Wrinkles
1. **Subagent Token Isolation**: In measured runs, subagents reported `ephemeral_1h_input_tokens: 31,673` with `ephemeral_5m_input_tokens: 0`. If subagent turns are excluded from top-level `execution_file` usage aggregation, cache savings are undercounted.
2. **TTL Expiration & Re-writes**: If multi-turn reviews exceed the TTL window (e.g. >5 min gap), cache re-writes re-incur the +25%/+100% penalty; the formula treats these as independent prompt variants rather than cache churn.
3. **Multi-Model Mixed Runs**: Runs mixing Sonnet subagents and Opus lead reviews cannot use a single $R_{in}$; savings must be calculated per turn using `message.model`.
4. **Subscription Economics**: Dollar savings represent *counterfactual API-equivalent list-price savings*, not cash refunded by Anthropic on fixed subscription seats.

---

## 3. Storage Options Comparison (Question 2)

| Option | Cost | Credential Needed | Queryable History | Retention & Deletion Policy | Viewing Effort | Failure Mode |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Git Branch / Data Repo** | $0 | Write PAT / Deploy Key in 3 repos | Append-only flat file (JSONL/CSV) | Permanent git history; no auto-delete | Medium-High (custom JS parser) | Git push race conflicts on concurrent CI runs |
| **B. Cloudflare D1 + Worker** | $0 | 1 Bearer Secret in CI | Full SQL (SQLite) | Permanent; **no inactivity pause/delete** (5 GB free) | Medium (build custom web UI) | Transient HTTP 5xx / timeout on curl |
| **C. Google Sheets + Apps Script** | $0 | 1 Webhook URL/Secret | Spreadsheets + SQL in Looker | Permanent in Drive (10M cell limit; >30 yrs) | **Near Zero** (Looker Studio BI) | Apps Script cold-start latency (1-3s) |
| **D. Grafana Cloud OTLP** | $0 | OTLP URL + API Key | PromQL / LogQL | **14-day hard retention** on free tier (drops history) | High (custom Grafana panels) | **Silently loses data >14 days**; series churn |
| **E. Hosted Postgres (Supabase/Neon)** | $0 | Postgres URL / Key | Full SQL | **Supabase pauses after 7d inactivity**; Neon scales to 0 | High (build custom frontend) | **Supabase pauses silently**; gross over-engineering |
| **F. Actions Artifacts Only** | $0 | Built-in `GITHUB_TOKEN` | Non-queryable; isolated runs | **Hard-deleted after 90 days** | N/A (cannot aggregate runs) | **Fails historical persistence requirement** |

*Volume verdict*: For <50 runs/day, Options D, E, and A are over-engineered or fail retention constraints (Grafana drops at 14d; Supabase pauses at 7d; Git push risks merge conflicts). Options B and C are the only zero-maintenance candidates with permanent data retention.

---

## 4. Viewing Layer Evaluation (Question 3)

| Viewing Layer | Backing Storage | Effort to Build | Filtering (Repo/Date) | Time Series | Per-PR Drilldown | PR & Run Links |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Looker Studio** *(Recommended)* | Google Sheet (Option C) | **30 mins (Zero Code)** | Native UI dropdowns & date picker | Native line/bar charts | Table with search & sorting | Native `HYPERLINK(url, text)` |
| **Cloudflare Pages / Worker** | Cloudflare D1 (Option B) | **2–4 hours (Code)** | Custom HTML/JS select inputs | Chart.js integration | Custom table component | `<a>` tags via SQL query |
| **Static HTML + GitHub raw** | Git JSONL (Option A) | **2–3 hours (Code)** | Client-side array filtering | Chart.js integration | Client-side map/filter | `<a>` tags via parsed JSON |

- **Looker Studio**: Point-and-click setup. Add Google Sheet as data source, map columns, insert Scorecards (Total Spend, Cache Hit Rate, Money Saved), Time Series (Cost & Tokens over Time), and a Table with `HYPERLINK(pr_url, CONCAT("#", pr_number))` and `HYPERLINK(run_url, run_id)`.
- **Cloudflare Pages**: Requires authoring `/index.html`, `/api/stats` Worker route executing `SELECT * FROM reviews WHERE ...`, and binding Chart.js. High polish, but requires code maintenance.

---

## 5. Ingestion Design & Security (Question 4)

### Smallest Reliable Ingestion Step
Placed at the end of the `review` job in GitHub Actions:
```yaml
- name: Record Review Usage
  if: always() && steps.run.outputs.execution_file != ''
  run: |
    curl -fsS -m 10 -X POST "${{ secrets.USAGE_INGEST_URL }}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${{ secrets.USAGE_INGEST_KEY }}" \
      -d @${{ steps.run.outputs.execution_file }} \
      || echo "::warning::Usage telemetry export failed; review unaffected."
```
- `-m 10` hard-caps timeout at 10 seconds.
- `|| echo "::warning..."` emits a GitHub warning annotation and exits 0, ensuring CI never fails on telemetry write errors.

### Credential & Endpoint Security
- **Bearer Token in Repository Secret**: `USAGE_INGEST_KEY` mapped into CI caller stubs. Scope is write-only ingestion into telemetry; zero read access or system privileges. Blast radius of a leak is limited to inserting bogus review rows.
- **Unguessable URL**: Apps Script deployment ID acts as a secret URL. Mapping it via `${{ secrets.USAGE_INGEST_URL }}` prevents URL indexing in public workflow files while requiring only 1 secret per repository.

### Idempotency Key
- **Key**: `idempotency_key = "${run_id}-${round_type}"` (e.g. `33271967624-review`).
- **Mechanism**: On CI re-runs, `run_id` remains identical.
  - In D1 / SQL: `UNIQUE(run_id, round_type)` with `INSERT OR REPLACE INTO usage_records ...`.
  - In Google Sheet / Apps Script: `doPost(e)` locks via `LockService.getScriptLock()`, scans column A for matching key, and updates in-place instead of appending duplicate rows.

### Fork Pull Request Security
- On standard `pull_request` triggers from external forks, GitHub Actions **never passes repository secrets** to the runner.
- The step receives empty strings for `${{ secrets.USAGE_INGEST_URL }}` and `${{ secrets.USAGE_INGEST_KEY }}`.
- External contributors **cannot reach the endpoint or exfiltrate secrets**.
- If unauthenticated endpoints were used, outsiders could only inject spoofed telemetry records; they cannot read database history or mutate repositories.

---

## 6. Verification & Limitations

1. **Anthropic Pricing & Multipliers**: Verified on 2026-08-30 from official documentation ([Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) / [Pricing](https://www.anthropic.com/pricing)). Rates: Sonnet 5 ($2/$10 MTok), Opus 5 ($10/$50 MTok); 5m write 1.25x, 1h write 2.0x, read 0.1x.
2. **Grafana Cloud Free Retention**: Confirmed 14-day limit on 2026-08-30 from [Grafana Pricing](https://grafana.com/pricing/). Drops all metric/log data >14 days old.
3. **Cloudflare D1 Free Limits**: Confirmed 5 GB storage, 100k daily writes, 5M daily reads, **0 inactivity deletion** on 2026-08-30 from [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/platform/pricing/).
4. **Supabase Free Policy**: Confirmed projects **pause after 7 days of inactivity** on 2026-08-30 from [Supabase Docs](https://supabase.com/pricing).
5. **Undetermined / Open Limitations**:
   - Whether `anthropics/claude-code-action` aggregates subagent tokens into top-level `execution_file` `usage` across all execution paths or omits nested background worker tokens.
   - Exact breakdown between 5m vs 1h TTL tokens when both are reported in session logs (`ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`).
