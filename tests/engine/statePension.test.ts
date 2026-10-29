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
    expect(statePensionGrowth(0.01, TEST_CONFIG, 2027)).toBeCloseTo(0.025, 12);
    expect(statePensionGrowth(0.05, TEST_CONFIG, 2027)).toBeCloseTo(1.01 * 1.05 - 1, 12);
  });
  it('the adjusted triple lock drops the earnings leg from its start year', () => {
    const cfg = { ...TEST_CONFIG, statePension: { ...TEST_CONFIG.statePension, growth: 'adjustedTripleLock' as const, doubleLockFromTaxYear: '2030/31' } };
    expect(statePensionGrowth(0.03, cfg, 2029)).toBeCloseTo(1.01 * 1.03 - 1, 12);   // 2029/30: still the triple lock
    expect(statePensionGrowth(0.03, cfg, 2030)).toBeCloseTo(0.03, 12);              // 2030/31: inflation
    expect(statePensionGrowth(0.01, cfg, 2030)).toBeCloseTo(0.025, 12);             // ...or the 2.5% floor
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

describe('State Pension when the plan starts after the base tax year', () => {
  it('starts at the uprated rate, not deflated back to the base year', async () => {
    const { simulate } = await import('../../src/engine/simulate');
    const { cashOnlyScenario } = await import('../fixtures/testScenarios');
    const run = (startDate: string) => {
      const s = cashOnlyScenario({ startAge: 70, pot: 1_000_000, spend: 0, horizonYears: 2 });
      s.people[0] = { ...s.people[0], dateOfBirth: `${Number(startDate.slice(0, 4)) - 70}-01-01`, niQualifyingYears: 35 };
      s.sim = { ...s.sim, startDate };
      return simulate(s, TEST_CONFIG, { runsOverride: 1 }).centralCase[0].statePension;
    };
    const base = run('2026-10-29');
    const cfg = TEST_CONFIG.statePension;
    const growth = Math.max(TEST_CONFIG.market.inflation.mean, (1 + TEST_CONFIG.market.wageGrowthRealPct) * (1 + TEST_CONFIG.market.inflation.mean) - 1, cfg.tripleLockFloorPct);
    expect(run('2027-10-29')).toBeCloseTo(base * (1 + growth), 2);
  });
});
