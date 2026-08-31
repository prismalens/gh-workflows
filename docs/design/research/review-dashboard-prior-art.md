# Prior Art: Code-Review & LLM Observability Dashboards

## 1. Verdict Up Front

No off-the-shelf product should replace our custom Looker Studio and Cloudflare D1 build: commercial AI review products (Family A) do not provide ingestion APIs for external review lanes, while LLM observability platforms (Family B) either mandate always-on servers or enforce restrictive 14–30 day retention limits on free tiers. Furthermore, LLM observability tools are architected around high-overhead, per-request span waterfalls rather than pre-aggregated CI session records. We should proceed with our planned storage/viewing architecture while adopting three key industry conventions: breaking prompt tokens into stacked base vs. cache segments, pairing p95 duration with turn count as operational health tiles, and demoting USD cost to a secondary table column.

---

## 2. Family A: AI Code-Review Products

| Product | Has Dashboard? | Exact Metrics Shown (Headline vs. Table) | Shows Cost / Tokens? | Per-PR Drill-Down |
| :--- | :--- | :--- | :--- | :--- |
| **CodeRabbit** | Yes (Web Portal & API) | **Headline:** `Reviewer Time Saved`, `Merged Pull Requests`, `Time to Merge`, `Time to Last Commit`, `CodeRabbit Review Comments`, `Acceptance Rate`, `Active Repositories & Users`, `Chat Usage`.<br>**Table:** PR Title, Author, Repo, Status, Comments, Time Saved. | **No** (Tokens/costs hidden; coarse overage credits shown only in Billing tab) | **Yes** (PR list linking directly to GitHub/GitLab PRs) |
| **Greptile** | Yes (Web Portal) | **Headline:** `PRs Reviewed`, `Avg Merge Time`, `Addressed Rate`, `Critical Bugs Caught` (P0/P1/P2), `Comment Engagement` (Upvote/Downvote ratio).<br>**Sidebar/Table:** Top repo leaderboards (by review count & merge speed). | **No** (Zero token counts or inference costs surfaced) | **Partial** (Aggregate trends and repo leaderboards; PRs inspected via MCP/Git) |
| **Qodo** *(Codium)* | Yes (Findings & Analytics) | **Headline (Findings):** `Total critical findings`, `Critical findings resolved %`, `Average critical findings per PR`.<br>**Table:** Finding Category, Repository, PR Author, Severity / Action Level, Status.<br>**Billing:** `PRs reviewed`, `Credits consumed`. | **No** (Review findings track defect counts; costs tracked only as account credits) | **Yes** (Findings table filters by repository, PR author, and action level) |
| **Graphite Diamond** | Yes (AI Review Dashboard) | **Headline:** `Issues found` (by category), `Issues accepted`, `Acceptance rate`, `PRs reviewed`, `Downvote rate`.<br>**Sub-tabs:** `Rules & exclusions` performance (flagged vs accepted), `Comment feed`, `Author/Reviewer stats`. | **No** (Flat seat subscription; zero token or API dollar tracking) | **Yes** (Live comment stream with direct links to PR comment threads) |
| **Cursor Bugbot** | Minimal UI (Admin API) | **Admin API / Metrics:** `bugbotUsages` (daily invocations), `Active Users`, review effort level (`Default`/`High`/`Custom`). | **No** (No per-review token or dollar cost breakdown on customer UI) | **No** (Review output lives strictly within PR comments and autofix branches) |
| **Sourcery** | Yes (Team Analytics) | **Headline:** `Overview` throughput, `PR Lifecycle` stage times, `Code Reviews` (AI vs human count), `Developers` breakdown, `Security findings`. | **No** (Tracks cycle time and defect volume, not tokens or API spend) | **Yes** (Drilldown into security findings and lifecycle stages per PR) |

*Primary sources: Official documentation (coderabbit.ai/docs, greptile.com/docs, qodo.ai/docs, graphite.dev/docs, docs.cursor.com, docs.sourcery.ai).*

---

## 3. Family B: LLM Observability Tools

| Tool | Panels & Metrics | Cache Treatment | Arbitrary Metadata? | Fits Pre-Aggregated Records? | Self-Host / Free Tier | Always-On Host Needed? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Langfuse** | `Cost (USD)`, `Total Tokens`, `Input / Output Tokens`, `Latency` (mean, p50, p95, p99), `Time to First Token` | Separate `input_cached_tokens`; pricing tiers compute cached cost; no rate-free multiplier tile | **Yes** (JSON `metadata` & `tags`) | **Yes** (Can ingest flat trace/generation via `POST /api/public/ingestion`) | Free Cloud (Hobby); Open-source self-host | **Yes** (Cloud drops data after 30d; self-host needs Postgres/ClickHouse) |
| **Helicone** | `Total Spend ($)`, `Cost per Request`, `Average Latency`, `p95 Latency`, `Prompt / Completion Tokens`, `Error Rate` | Dedicated `Cache Dashboard` for proxy cache hit/miss; tracks prompt cache tokens if logged | **Yes** (`Helicone-Property-*` headers / dict) | **Poor** (Optimized for per-LLM request proxying / manual logger pairs) | Free Cloud (10k req/mo); Open-source self-host | **Yes** (Self-host needs ClickHouse/Postgres; cloud free has retention caps) |
| **Arize Phoenix** | `Estimated Cost (USD)`, `Trace Latency Percentiles`, `Prompt Tokens (input/cache)`, `Completion Tokens (output/reasoning)` | Explicit `cache` token breakdown segment in prompt token charts | **Yes** (OTLP span attributes / `metadata`) | **Poor** (Requires OpenTelemetry / OpenInference span wrapper hierarchy) | Free Cloud; Open-source container | **Yes** (Requires running OTLP collector server on Docker/VM) |
| **Braintrust** | `Cost ($)`, `Total Tokens`, `Prompt / Completion Tokens`, `Latency` (p50/p90/p99), `Trace Counts`, waterfall spans | Records cached tokens in span details; calculates tier cost | **Yes** (JSON metadata on spans/events) | **Partial** (Requires dataset/experiment event or span structure) | Free Cloud (Starter 1GB); Enterprise self-host | **Yes** (Cloud limits data/retention; self-host requires AWS/GCP data plane) |

*Primary sources: Official documentation (langfuse.com/docs, docs.helicone.ai, arize.com/docs, braintrust.dev/docs).*

---

## 4. Conventions Worth Stealing

1. **Stacked Prompt Composition Bars (Langfuse & Phoenix)**: Display input token volume as a stacked time series with three distinct segments: `Base Input`, `Cache Read`, and `Cache Creation`. This visualizes prompt cache leverage immediately without requiring pricing conversions.
2. **P95 Latency Beside Turn Count (Phoenix & CodeRabbit)**: CI review performance is governed by tail latency and agent thrashing. Pairing `P95 Duration` with `Average Turns per Run` on headline scorecards highlights slow runs and multi-turn loops.
3. **Rule / Severity Quality Breakdown (Graphite & Greptile)**: Graphite tracks acceptance rates per configured rule, while Greptile categorizes `Critical Bugs Caught` (P0/P1/P2). Categorizing our review rounds by `round_type` (review vs bug-fix vs summary) alongside `permission_denials` exposes lane reliability trends.
4. **Direct PR & Run Hyperlinks in Table Rows (CodeRabbit & Qodo)**: Rendering linked PR numbers (`#41`) and workflow run IDs (`33271...`) directly in the drill-down table allows instant jump-to-context on abnormal runs.

---

## 5. Conventions Worth Rejecting

1. **Vanity "Time / Dollar Saved" Scorecards (CodeRabbit & Helicone)**: Heuristic claims of "hours saved" or "dollars saved vs un-cached API calls" represent unprovable counterfactuals. On flat-rate subscription seats, claiming cash savings damages dashboard credibility. We reject dollar savings in favor of rate-free token reduction percentages.
2. **Prominent Hero Dollar Costs (Langfuse & Helicone)**: LLM observability tools design their hero scorecard around total spend because they serve metered API customers. On flat-rate plans, dollar cost must be demoted to a secondary sortable column ("list-rate equivalent proxy") to avoid implying variable billing.
3. **Full Trace Span Waterfalls (Phoenix, Langfuse, Braintrust)**: Rendering nested LLM HTTP calls and individual message spans creates massive payload overhead and requires continuous infrastructure. Pre-aggregated session records capture all necessary CI metrics at near-zero storage cost.
4. **Developer Productivity / Leaderboard Rankings (Greptile & Sourcery)**: Ranking repositories or developers by AI suggestion acceptance creates perverse gamification. Dashboards should measure lane execution health, not author compliance.

---

## 6. What Was Undetermined & What Was Checked

- **CodeRabbit / Greptile Internal Prompt Cache Breakdown**: Checked `coderabbit.ai/docs/analytics` and `greptile.com/docs/api-reference`. Could not determine whether their internal engines distinguish 5-minute from 1-hour TTL Anthropic cache writes; user-facing APIs and dashboards strictly expose abstract credits.
- **Cursor Bugbot Standalone Web Drill-Down**: Checked `docs.cursor.com/context` and Admin API schemas. Confirmed Bugbot lacks a web-based per-PR review browser; metrics are accessible only via Admin REST endpoints or PR comments.
- **Serverless Scale-to-Zero for Family B Collectors**: Checked GitHub repositories and deployment guides for `langfuse`, `phoenix`, and `helicone`. Confirmed none support an unmanaged, serverless HTTP webhook endpoint (like Google Apps Script or Cloudflare Workers) capable of receiving CI POSTs without an active backend instance.
