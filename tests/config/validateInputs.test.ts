import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/configValidate';
import { validateScenario } from '../../src/model/validateScenario';
import { isIsoDate, isTaxYearLabel } from '../../src/model/dates';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import type { Contribution, Scenario } from '../../src/model/types';

const configPaths = (mutate: (c: typeof TEST_CONFIG) => void) => {
  const c = structuredClone(TEST_CONFIG);
  mutate(c);
  return validateConfig(c).map((i) => i.path);
};
const scenarioPaths = (mutate: (s: Scenario) => void) => {
  const s = cashOnlyScenario();
  mutate(s);
  return validateScenario(s, TEST_CONFIG).map((i) => i.path);
};

describe('dates', () => {
  it('rejects impossible calendar dates', () => {
    expect(isIsoDate('1966-13-45')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });
  it('requires the second half of a tax year label to be the next year', () => {
    expect(isTaxYearLabel('2026/27')).toBe(true);
    expect(isTaxYearLabel('2099/00')).toBe(true);
    expect(isTaxYearLabel('2027/29')).toBe(false);
  });
});

describe('validateConfig date and read-only fields', () => {
  it('requires a calendar date where the engine parses one', () => {
    expect(configPaths((c) => { c.pensionAccess.minAgeFutureFromDate = '2028/29'; })).toContain('pensionAccess.minAgeFutureFromDate');
    expect(configPaths((c) => { c.statePension.ageSchedule[0].bornOnOrAfter = '1900/01'; })).toContain('statePension.ageSchedule[0].bornOnOrAfter');
  });
  it('requires a tax year where the engine parses one', () => {
    expect(configPaths((c) => { c.taxProjection.thresholdsFrozenThroughTaxYear = '2030-04-05'; })).toContain('taxProjection.thresholdsFrozenThroughTaxYear');
    expect(configPaths((c) => { c.statePension.baseTaxYear = '2026'; })).toContain('statePension.baseTaxYear');
  });
  it('rejects the unimplemented Scottish region', () => {
    expect(configPaths((c) => { c.tax['2026/27'].region = 'scotland'; })).toContain('tax.2026/27.region');
  });
});

describe('validateScenario enums and whole-number ages', () => {
  const contribution = (extra: Partial<Contribution>): Contribution => ({
    id: 'c1', accountId: 'cash', personIndex: 0, type: 'fixedMonthly', amount: 100, startAge: 40, endAge: 50, escalatesWithInflation: false, ...extra,
  });
  it('rejects an unknown contribution type', () => {
    expect(scenarioPaths((s) => { s.contributions = [contribution({ type: 'monthly' as Contribution['type'] })]; })).toContain('contributions[0].type');
  });
  it('rejects a fractional contribution start age (a lump sum would never be paid)', () => {
    expect(scenarioPaths((s) => { s.contributions = [contribution({ type: 'lumpSum', startAge: 40.5 })]; })).toContain('contributions[0].startAge');
  });
  it('rejects an unknown mortgage type', () => {
    expect(scenarioPaths((s) => {
      s.properties = [{ id: 'h', name: 'Home', value: 300000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0,
        mortgage: { balance: 100000, type: 'repay' as 'repayment', rate: 0.04, fixedYearsRemaining: 2, reversionRate: 0.06, termYearsRemaining: 20, monthlyOverpayment: 0 } }];
    })).toContain('properties[0].mortgage.type');
  });
  it('rejects an impossible date of birth', () => {
    expect(scenarioPaths((s) => { s.people[0].dateOfBirth = '1966-13-45'; })).toContain('people[0].dateOfBirth');
  });
});
