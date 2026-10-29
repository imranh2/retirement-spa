import type { Scenario } from './types';
import { ageAt, isIsoDate } from './dates';

/** Each person's whole-year age at the start date (NaN while a date of birth is not yet valid). */
export function currentAges(s: Scenario): number[] {
  return s.people.map((p) => (isIsoDate(p.dateOfBirth) && isIsoDate(s.sim.startDate) ? ageAt(p.dateOfBirth, s.sim.startDate) : Number.NaN));
}

/**
 * The scenario with person 1 stopping work at `age`. Anyone else still working moves their
 * stop-work age by the same number of years (never before their current age), so a couple
 * retires together in the same pattern they planned.
 */
export function withRetirementAge(s: Scenario, age: number): Scenario {
  const now = currentAges(s);
  // A stop-work age already passed means stopping now, so the partner moves relative to that.
  const delta = age - Math.max(s.people[0].retirementAge, now[0]);
  return {
    ...s,
    people: s.people.map((p, i) => (i === 0 || p.retirementAge > now[i] ? { ...p, retirementAge: Math.max(now[i], p.retirementAge + delta) } : p)),
  };
}

/**
 * Whether person 1's stop-work age is a choice worth exploring: they have a salary (even if the
 * plan stops it this year), or a stop-work age still ahead of them.
 */
export function canChooseStopWork(s: Scenario): boolean {
  const p = s.people[0];
  return p !== undefined && (p.salary > 0 || p.retirementAge > currentAges(s)[0]);
}

/** Result of the earliest stop-work age search (engine/retireAge.ts). */
export interface RetireAgeOutcome {
  /**
   * 'now': stopping work now already meets the target. 'found': `age` is the earliest age
   * that does. 'notReachable': even working until `latestTried` falls short.
   * 'notWorking': person 1 has no salary and has already stopped work, so there is nothing to search.
   */
  status: 'now' | 'found' | 'notReachable' | 'notWorking';
  age?: number;
  successRate?: number;
  targetSuccessRate: number;
  latestTried: number;
}
