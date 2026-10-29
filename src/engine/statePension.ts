import type { Person } from '../model/types';
import type { ConfigBundle, StatePensionConfig } from '../config/configTypes';
import { defaultStatePensionStartAge, statePensionAge } from '../model/ageRules';
import { taxYearStartYear } from '../model/dates';

import { WEEKS_PER_YEAR } from './constants';

export { statePensionAge };

/**
 * Whole-year age at which State Pension starts in the model: the person's override,
 * else State Pension age rounded UP to whole years (simplification).
 */
export function statePensionStartAge(person: Person, config: Pick<ConfigBundle, 'statePension'>): number {
  return person.statePensionStartAge ?? defaultStatePensionStartAge(person.dateOfBirth, config.statePension.ageSchedule);
}

/**
 * Deferral uplift: 1 + deferralIncreasePerYear for each whole year the State Pension starts
 * after the model's default start age (State Pension age rounded up). Starting earlier is
 * not allowed (validation rejects it), so the multiplier is never below 1.
 */
export function deferralMultiplier(startAge: number, defaultStartAge: number, sp: StatePensionConfig): number {
  return 1 + sp.deferralIncreasePerYear * Math.max(0, startAge - defaultStartAge);
}

/** Full new State Pension per year in base-year money. */
export function fullAnnualAmount(sp: StatePensionConfig): number {
  return sp.fullWeeklyRate * WEEKS_PER_YEAR;
}

/** Annual entitlement for a number of qualifying years at State Pension age. */
export function annualEntitlement(qualifyingYears: number, sp: StatePensionConfig): number {
  if (qualifyingYears < sp.minimumYears) return 0;
  return fullAnnualAmount(sp) * Math.min(1, qualifyingYears / sp.yearsForFull);
}

/**
 * Qualifying years at State Pension age: current years plus each future year before the start
 * age that qualifies, capped at yearsForFull. A year qualifies if the person works (age <
 * retirementAge) and earns at least `lowerEarningsLimit` (both in today's money, with real
 * salary growth), or if it is before `niCreditsUntilAge` (NI credits or voluntary NI).
 */
export function qualifyingYearsAtStart(person: Person, currentAge: number, startAge: number, sp: StatePensionConfig, lowerEarningsLimit = 0): number {
  let future = 0;
  for (let age = currentAge; age < startAge; age++) {
    const salary = person.salary * Math.pow(1 + person.salaryGrowthRealPct, age - currentAge);
    const earns = age < person.retirementAge && salary >= lowerEarningsLimit && salary > 0;
    const credited = person.niCreditsUntilAge !== undefined && age < person.niCreditsUntilAge;
    if (earns || credited) future++;
  }
  return Math.min(Math.max(person.niQualifyingYears, 0) + future, Math.max(sp.yearsForFull, person.niQualifyingYears));
}

/**
 * State Pension increase applied at the start of the tax year beginning in `taxYearStart`,
 * given the simulated inflation. tripleLock = max(inflation, earnings growth, floor);
 * adjustedTripleLock drops the earnings leg from `doubleLockFromTaxYear`.
 */
export function statePensionGrowth(inflation: number, config: Pick<ConfigBundle, 'statePension' | 'market'>, taxYearStart: number): number {
  const sp = config.statePension;
  const earnings = (1 + config.market.wageGrowthRealPct) * (1 + inflation) - 1;
  switch (sp.growth) {
    case 'inflation': return inflation;
    case 'earnings': return earnings;
    case 'tripleLock': return Math.max(inflation, earnings, sp.tripleLockFloorPct);
    case 'adjustedTripleLock': return taxYearStart >= taxYearStartYear(sp.doubleLockFromTaxYear)
      ? Math.max(inflation, sp.tripleLockFloorPct)
      : Math.max(inflation, earnings, sp.tripleLockFloorPct);
    case 'fixed': return sp.fixedGrowthPct;
  }
}
