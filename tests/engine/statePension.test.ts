import { describe, it, expect } from 'vitest';
import { statePensionAge, statePensionStartAge, fullAnnualAmount, annualEntitlement, qualifyingYearsAtStart, statePensionGrowth } from '../../src/engine/statePension';
import { TEST_CONFIG } from '../fixtures/testConfig';
import type { Person } from '../../src/model/types';

const sp = TEST_CONFIG.statePension;
const person = (dob: string, extra: Partial<Person> = {}): Person => ({ name: 'P', dateOfBirth: dob, salary: 0, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 20, ...extra });

describe('State Pension amounts (hand-checked vectors)', () => {
  it('full amount 12,547.60', () => expect(fullAnnualAmount(sp)).toBeCloseTo(12547.6, 2));
  it('20 years: 7,170.06', () => expect(annualEntitlement(20, sp)).toBeCloseTo(7170.06, 2));
  it('9 years: 0', () => expect(annualEntitlement(9, sp)).toBe(0));
  it('35+ years: full', () => expect(annualEntitlement(40, sp)).toBeCloseTo(12547.6, 2));
});

describe('State Pension age', () => {
  it('uses the last schedule row on or before the DOB', () => {
    expect(statePensionAge('1955-01-01', sp.ageSchedule)).toEqual({ years: 66, months: 0 });
    expect(statePensionAge('1960-06-10', sp.ageSchedule)).toEqual({ years: 66, months: 3 });
    expect(statePensionAge('1980-01-01', sp.ageSchedule)).toEqual({ years: 68, months: 0 });
  });
  it('start age rounds up to whole years; override wins', () => {
    expect(statePensionStartAge(person('1960-06-10'), TEST_CONFIG)).toBe(67);
    expect(statePensionStartAge(person('1965-01-01'), TEST_CONFIG)).toBe(67);
    expect(statePensionStartAge(person('1965-01-01', { statePensionStartAge: 70 }), TEST_CONFIG)).toBe(70);
  });
  it('qualifying years add working years before SPA, capped at 35', () => {
    const earner = { salary: 30000 };
    expect(qualifyingYearsAtStart(person('1980-01-01', { ...earner, niQualifyingYears: 20, retirementAge: 50 }), 46, 68, sp, 6708)).toBe(24);
    expect(qualifyingYearsAtStart(person('1980-01-01', { ...earner, niQualifyingYears: 20, retirementAge: 68 }), 46, 68, sp, 6708)).toBe(35);
  });
  it('a working year qualifies only if salary reaches the lower earnings limit', () => {
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 0, retirementAge: 68 }), 46, 68, sp, 6708)).toBe(20);
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 6000, retirementAge: 68 }), 46, 68, sp, 6708)).toBe(20);
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 6708, retirementAge: 50 }), 46, 68, sp, 6708)).toBe(24);
    // Real pay growth lifts a salary over the limit part-way: 6,000 x 1.05^3 = 6,946 at age 49.
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 6000, salaryGrowthRealPct: 0.05, retirementAge: 52 }), 46, 68, sp, 6708)).toBe(23);
  });
  it('NI credits count years without earnings until the given age', () => {
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 0, niCreditsUntilAge: 52 }), 46, 68, sp, 6708)).toBe(26);
    // Credits and earnings for the same year count once.
    expect(qualifyingYearsAtStart(person('1980-01-01', { salary: 30000, retirementAge: 50, niCreditsUntilAge: 52 }), 46, 68, sp, 6708)).toBe(26);
  });
  it('triple lock is the max of inflation, earnings and floor', () => {
    expect(statePensionGrowth(0.01, TEST_CONFIG)).toBeCloseTo(0.025, 12);
    expect(statePensionGrowth(0.05, TEST_CONFIG)).toBeCloseTo(1.01 * 1.05 - 1, 12);
  });
});

describe('State Pension age phasing to 68 (shipped defaults)', () => {
  it('everyone born 6 Apr 1977 – 5 Apr 1978 has a State Pension age above 67, so the model starts it at 68', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/defaults/ukDefaults');
    const { statePensionAge, defaultStatePensionStartAge } = await import('../../src/model/ageRules');
    const sched = DEFAULT_CONFIG.statePension.ageSchedule;
    expect(statePensionAge('1977-04-06', sched)).toEqual({ years: 67, months: 1 });
    expect(statePensionAge('1978-03-10', sched)).toEqual({ years: 68, months: 0 });
    for (const dob of ['1977-04-06', '1977-06-01', '1977-12-25', '1978-04-05']) expect(defaultStatePensionStartAge(dob, sched)).toBe(68);
    expect(defaultStatePensionStartAge('1977-04-05', sched)).toBe(67);
  });
});
