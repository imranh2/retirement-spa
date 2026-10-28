// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { QUICK_START_DEFAULTS, quickStartScenario } from '../../src/ui/quickStart';
import { validateScenario } from '../../src/model/validateScenario';
import { simulate } from '../../src/engine/simulate';
import { TEST_CONFIG } from '../fixtures/testConfig';

const START = '2026-10-28';
const errors = (s: ReturnType<typeof quickStartScenario>) => validateScenario(s, TEST_CONFIG);

describe('quick start', () => {
  it('builds a valid plan from the default answers', () => {
    const s = quickStartScenario(QUICK_START_DEFAULTS, START);
    expect(errors(s)).toEqual([]);
    expect(s.accounts.map((a) => a.type)).toEqual(['cash', 'dcPension']);
    expect(s.contributions.map((c) => c.type)).toEqual(['pctOfSalary', 'employerPctOfSalary']);
    expect(s.withdrawalOrder).toEqual(['cash', 'dcPension']);
    expect(simulate(s, TEST_CONFIG, { runsOverride: 50 }).runs).toBe(50);
  });
  it('adds only the accounts, savings and home that were given', () => {
    const s = quickStartScenario({ ...QUICK_START_DEFAULTS, isa: 5000, isaMonthly: 200, gia: 1000, homeValue: 300000, mortgageBalance: 150000, mortgageYears: 20 }, START);
    expect(errors(s)).toEqual([]);
    expect(s.withdrawalOrder).toEqual(['cash', 'gia', 'isa', 'dcPension']);
    expect(s.contributions.find((c) => c.accountId === 'isa')).toMatchObject({ type: 'fixedMonthly', amount: 200, stopsWith: 'work' });
    expect(s.properties[0]).toMatchObject({ value: 300000, isMainResidence: true, mortgage: { balance: 150000, termYearsRemaining: 20 } });
  });
  it('handles someone not working, and a mortgage given without a home value', () => {
    const s = quickStartScenario({ ...QUICK_START_DEFAULTS, age: 62, salary: 0, stopWorkAge: 67, pensionPct: 0.05, mortgageBalance: 50000, mortgageYears: 5 }, START);
    expect(errors(s)).toEqual([]);
    expect(s.people[0].retirementAge).toBe(62);
    expect(s.contributions).toEqual([]);
    expect(s.properties[0].value).toBe(50000);
  });
});
