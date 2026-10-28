/** Engine constants. UK rules and market assumptions never live here: they come from ConfigBundle. */
export const MONTHS_PER_YEAR = 12;
export const WEEKS_PER_YEAR = 52;
/** Unmet cash need above this (GBP, nominal) fails a run. */
export const SHORTFALL_TOLERANCE_GBP = 1;
export const MAX_GROSSUP_ITERATIONS = 20;
export const GROSSUP_TOLERANCE_GBP = 1;
/**
 * Draws reserved per run. mulberry32's state advances by a fixed increment per draw, so
 * starting run r exactly r * RUN_STREAM_DRAWS draws along the cycle gives every run its own
 * non-overlapping stream (a run uses at most ~60 draws a year, i.e. well under this), for up
 * to 2^32 / RUN_STREAM_DRAWS = 131,072 runs. Runs stay independent of chunking.
 */
export const RUN_STREAM_DRAWS = 32768;
/** Diagonal jitter tried before declaring a correlation matrix not positive definite. */
export const CHOLESKY_JITTER = 1e-10;
/** Block bootstrap: consecutive years per block, and the minimum history required. */
export const BOOTSTRAP_BLOCK_YEARS = 5;
export const MIN_BOOTSTRAP_YEARS = 10;
/** Percentiles reported in PercentileBands, in key order p5..p95. */
export const PERCENTILES: readonly number[] = [5, 10, 25, 50, 75, 90, 95].map((p) => p / 100);
/** Max sustainable spend bisection. */
export const MAX_SPEND_LOWER = 0.1;
export const MAX_SPEND_UPPER = 5.0;
export const MAX_SPEND_ITERATIONS = 14;
export const MAX_SPEND_RUNS = 1000;
/** The quicker what-if version: fewer runs and iterations (to within about 1% of planned spending). */
export const QUICK_SPEND_RUNS = 500;
export const QUICK_SPEND_ITERATIONS = 9;
/** Mortgage balances below this (GBP) are treated as repaid. */
export const MORTGAGE_PAID_TOLERANCE_GBP = 0.01;
