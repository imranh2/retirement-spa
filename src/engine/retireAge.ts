import type { Scenario } from '../model/types';
import type { ConfigBundle } from '../config/configTypes';
import { canChooseStopWork, currentAges, withRetirementAge, type RetireAgeOutcome } from '../model/retirement';
import type { SimulateFn } from './stats';

/** Runs per simulation in the search (the same seed every time: common random numbers). */
const RETIRE_SEARCH_RUNS = 1000;

/**
 * Earliest age at which person 1 can stop work and still meet the target success rate
 * with the planned spending. Bisection over whole ages from now to the year before the
 * horizon, assuming success rises with each extra year of work. Yields the number of
 * simulations done so far so the worker can report progress and cancel between them.
 */
export function* earliestRetirementSteps(scenario: Scenario, config: ConfigBundle, deps: { simulate: SimulateFn }): Generator<number, RetireAgeOutcome> {
  const target = scenario.sim.targetSuccessRate;
  const now = currentAges(scenario)[0];
  const latest = scenario.sim.horizonAge - 1;
  const base = { targetSuccessRate: target, latestTried: latest };
  if (!canChooseStopWork(scenario)) return { ...base, status: 'notWorking' };

  const runs = Math.min(scenario.sim.runs, RETIRE_SEARCH_RUNS);
  const rate = (age: number) => deps.simulate(withRetirementAge(scenario, age), config, { spendMultiplier: 1, runsOverride: runs, successOnly: true }).successRate;
  let done = 0;

  const nowRate = rate(now);
  yield ++done;
  if (nowRate >= target) return { ...base, status: 'now', age: now, successRate: nowRate };
  const latestRate = rate(latest);
  yield ++done;
  if (latestRate < target) return { ...base, status: 'notReachable', successRate: latestRate };

  let lo = now;          // fails
  let hi = latest;       // meets the target
  let hiRate = latestRate;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = rate(mid);
    if (r >= target) { hi = mid; hiRate = r; } else lo = mid;
    yield ++done;
  }
  return { ...base, status: 'found', age: hi, successRate: hiRate };
}
