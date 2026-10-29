import type { PercentileBands, Scenario, SimulationResult } from '../model/types';
import type { ConfigBundle } from '../config/configTypes';
import { MAX_SPEND_ITERATIONS, MAX_SPEND_LOWER, MAX_SPEND_RUNS, MAX_SPEND_UPPER, PERCENTILES } from './constants';
import { phaseSpend } from './withdrawal';
import { ageAt } from '../model/dates';

/** Percentile of an ascending-sorted array with linear interpolation; p in [0, 1]. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Fraction of runs that did not fail. */
export function successRate(failedRuns: number, runs: number): number {
  return runs > 0 ? (runs - failedRuns) / runs : 0;
}

/**
 * Percentile bands per year from a run-major matrix (index run * T + t).
 * Output arrays have length T.
 */
export function percentileBands(values: Float64Array, runs: number, T: number): PercentileBands {
  const out: PercentileBands = { p5: [], p10: [], p25: [], p50: [], p75: [], p90: [], p95: [] };
  const keys: (keyof PercentileBands)[] = ['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];
  const col = new Float64Array(runs);
  for (let t = 0; t < T; t++) {
    for (let r = 0; r < runs; r++) col[r] = values[r * T + t];
    col.sort();
    keys.forEach((k, i) => out[k].push(percentile(col, PERCENTILES[i])));
  }
  return out;
}

/** Histogram of depletion ages (failed runs only), ascending by age. */
export function depletionHistogram(failureAges: ArrayLike<number>): { age: number; count: number }[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < failureAges.length; i++) {
    const a = failureAges[i];
    if (a >= 0) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts.entries()].map(([age, count]) => ({ age, count })).sort((a, b) => a.age - b.age);
}

export type SimulateFn = (scenario: Scenario, config: ConfigBundle, opts: { spendMultiplier: number; runsOverride: number; successOnly: boolean }) => Pick<SimulationResult, 'successRate'>;

export interface MaxSpendOutcome {
  value: { multiplier: number; annualSpendReal: number; targetSuccessRate: number };
  warnings: string[];
  iterations: { multiplier: number; successRate: number }[];
}

/**
 * Largest multiplier on every spending phase that keeps success >= target.
 * Always uses fixedReal spending; bisection on [0.1, 5.0], 14 iterations, the same seed
 * each time (common random numbers), runs = the plan's own.
 * `deps.simulate` is injected so this module does not depend on simulate.ts.
 */
export function findMaxSustainableSpend(scenario: Scenario, config: ConfigBundle, target: number, deps: { simulate: SimulateFn }): MaxSpendOutcome {
  const steps = maxSpendSteps(scenario, config, target, deps);
  for (;;) {
    const n = steps.next();
    if (n.done) return n.value;
  }
}

/**
 * The same search as a generator that yields after each simulation (with the number of
 * simulations done so far, out of at most MAX_SPEND_STEPS), so a caller (the worker) can
 * report progress and handle cancellation between steps instead of blocking.
 */
/** Most simulations the max-spend search runs: both bounds, then the bisection. */
export const MAX_SPEND_STEPS = 2 + MAX_SPEND_ITERATIONS;

export function* maxSpendSteps(scenario: Scenario, config: ConfigBundle, target: number, deps: { simulate: SimulateFn },
  opts: { runs?: number; iterations?: number } = {}): Generator<number, MaxSpendOutcome> {
  const fixed: Scenario = { ...scenario, strategy: { kind: 'fixedReal' } };
  const runs = Math.min(scenario.sim.runs, opts.runs ?? MAX_SPEND_RUNS);
  const bisections = opts.iterations ?? MAX_SPEND_ITERATIONS;
  const iterations: MaxSpendOutcome['iterations'] = [];
  const rate = (multiplier: number) => {
    const r = deps.simulate(fixed, config, { spendMultiplier: multiplier, runsOverride: runs, successOnly: true }).successRate;
    iterations.push({ multiplier, successRate: r });
    return r;
  };
  const startAge = ageAt(scenario.people[0].dateOfBirth, scenario.sim.startDate);
  const baseSpend = phaseSpend(scenario.spending, startAge);
  const pct = Math.round(target * 100);
  const make = (multiplier: number, warnings: string[]): MaxSpendOutcome => ({
    value: { multiplier, annualSpendReal: baseSpend * multiplier, targetSuccessRate: target },
    warnings,
    iterations,
  });

  let done = 0;
  const lowOk = rate(MAX_SPEND_LOWER) >= target;
  yield ++done;
  if (!lowOk) {
    return make(MAX_SPEND_LOWER, [`Even ${MAX_SPEND_LOWER * 100}% of planned spending falls below ${pct}% success; the true maximum is lower.`]);
  }
  const highOk = rate(MAX_SPEND_UPPER) >= target;
  yield ++done;
  if (highOk) {
    return make(MAX_SPEND_UPPER, [`${MAX_SPEND_UPPER}x planned spending still meets ${pct}% success; the true maximum is higher.`]);
  }
  let lo = MAX_SPEND_LOWER;
  let hi = MAX_SPEND_UPPER;
  for (let k = 0; k < bisections; k++) {
    const mid = (lo + hi) / 2;
    if (rate(mid) >= target) lo = mid; else hi = mid;
    yield ++done;
  }
  return make(lo, []);
}
