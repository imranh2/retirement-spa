import type { SimulationResult } from '../model/types';

type Depletion = Pick<SimulationResult, 'ages' | 'runs' | 'depletionAgeHistogram'>;

/** Share of all runs that have run out of money by each age (failed at or before it). */
export function cumulativeDepletion(r: Depletion): number[] {
  const sorted = [...r.depletionAgeHistogram].sort((a, b) => a.age - b.age);
  let i = 0;
  let failed = 0;
  return r.ages.map((age) => {
    while (i < sorted.length && sorted[i].age <= age) failed += sorted[i++].count;
    return r.runs > 0 ? failed / r.runs : 0;
  });
}

/**
 * How long the money lasts in `confidence` of simulated futures: the first age at which
 * more than (1 - confidence) of runs have run out. `beyond` means it lasts past the last
 * simulated age, and `age` is then the horizon (the plan's end age).
 */
export function moneyLastsUntil(r: Depletion, confidence: number): { age: number; beyond: boolean } {
  const cum = cumulativeDepletion(r);
  const allowed = 1 - confidence;
  const i = cum.findIndex((share) => share > allowed + Number.EPSILON);
  const horizon = (r.ages[r.ages.length - 1] ?? 0) + 1;
  return i < 0 ? { age: horizon, beyond: true } : { age: r.ages[i], beyond: false };
}

/** "88", or "95+" when it lasts to the end of the plan. */
export function lastsLabel(v: { age: number; beyond: boolean }): string {
  return v.beyond ? `${v.age}+` : String(v.age);
}
