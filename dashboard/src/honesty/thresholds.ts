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
 * time so a later screen cannot promote it by accident.
 */
export const MONEY_LABEL_PATTERN = /(\$|\busd\b|\bcost\b|\bdollar|\bspend\b|\bprice\b)/i;
