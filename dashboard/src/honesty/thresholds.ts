/**
 * The numbers behind the sparse-range rules of #46. They are rulings, not tuning
 * knobs: changing one changes what the dashboard is allowed to claim.
 */

/** Averages computed over fewer rounds than this carry a low-n flag. */
export const LOW_N_THRESHOLD = 10;

/** Below this many rounds a p95 is a coin flip, so max is shown instead. */
export const P95_MIN_N = 20;

/** Below this many rounds the round table replaces aggregate tiles entirely. */
export const TILES_MIN_ROUNDS = 10;

/** The rolling window is the last 50 rounds or 7 days, whichever is larger. */
export const ROLLING_ROUNDS = 50;
export const ROLLING_DAYS = 7;

/** The label `total_cost_usd` carries everywhere it is shown. */
export const LIST_RATE_EQUIVALENT = "list-rate equivalent";

/**
 * `total_cost_usd` is counterfactual on a subscription seat, so it is a sortable
 * column and never a headline. Tile labels are matched against this at render
 * time so a later screen cannot promote it by accident. Deliberately unanchored:
 * \bcost\b misses "costs" and \bspend\b misses "spending", which is how a money
 * headline gets through a green build.
 *
 * `bill` carries the one exception, because a billable token count is a count and
 * not money: "billable" is excluded so "Billable tokens" can headline, while
 * bill, billed and billing still fail.
 */
export const MONEY_LABEL_PATTERN =
  /\$|usd|dollar|cost|spend|spent|money|burn|price|pricing|bill(?!able)|charge|expense|list-rate|per-token|rate eq/i;

/**
 * The billed-equivalent weights behind the caching multiplier. Cache creation is
 * charged above base input and a cache read far below it, so the ratio of
 * uncached-equivalent to billed-equivalent input is an arithmetic identity over
 * the recorded counts rather than an estimate. Whether 1.25 and 0.1 are the right
 * constants is the operator's question. Story: #46.
 */
export const CACHE_CREATION_WEIGHT = 1.25;
export const CACHE_READ_WEIGHT = 0.1;
