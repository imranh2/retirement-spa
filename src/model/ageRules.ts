import type { PensionAccessConfig, StatePensionConfig } from '../config/configTypes';
import { addYears, compareIso } from './dates';

/**
 * Minimum pension access age from date of birth. `minAgeNow` applies only if the person
 * reaches `minAgeFuture` on or before `minAgeFutureFromDate` (so they keep access when the rule
 * changes); otherwise `minAgeFuture`. Someone who reaches 55 shortly before 6 April 2028
 * loses access on that date until 57, so they get 57. People with a protected pension age
 * set their own access age on the account.
 */
export function minimumPensionAccessAge(dob: string, access: PensionAccessConfig): number {
  const reachesFuture = addYears(dob, access.minAgeFuture);
  return compareIso(reachesFuture, access.minAgeFutureFromDate) <= 0 ? access.minAgeNow : access.minAgeFuture;
}

/** State Pension age from DOB: the last schedule row with bornOnOrAfter <= dob. */
export function statePensionAge(dob: string, schedule: StatePensionConfig['ageSchedule']): { years: number; months: number } {
  if (schedule.length === 0) throw new Error('State Pension age schedule is empty');
  let row = schedule[0];
  for (const r of schedule) if (compareIso(r.bornOnOrAfter, dob) <= 0) row = r;
  return { years: row.ageYears, months: row.ageMonths };
}

/** Whole-year age the model starts the State Pension at by default: State Pension age rounded up. */
export function defaultStatePensionStartAge(dob: string, schedule: StatePensionConfig['ageSchedule']): number {
  const { years, months } = statePensionAge(dob, schedule);
  const MONTHS_PER_YEAR = 12;
  return Math.ceil(years + months / MONTHS_PER_YEAR);
}
