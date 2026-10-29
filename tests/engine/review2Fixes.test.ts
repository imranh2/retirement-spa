import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { stampDuty } from '../../src/engine/property';
import { qualifyingYearsAtStart } from '../../src/engine/statePension';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Mortgage, Scenario } from '../../src/model/types';

const rows = (s: Scenario, cfg = zeroWorldConfig()) => simulate(s, cfg, { runsOverride: 1 }).centralCase;
const monthly = (s: Scenario): Scenario => ({ ...s, sim: { ...s.sim, stepsPerYear: 12 } });
const taxOn = () => {
  const cfg = zeroWorldConfig();
  cfg.tax['2026/27'].incomeTaxBands = [{ upTo: 37_700, rate: 0.2 }, { upTo: 125_140, rate: 0.4 }, { upTo: null, rate: 0.45 }];
  return cfg;
};

describe('review fixes', () => {
  it('monthly steps keep pension-first draws within the year’s allowance, as annual steps do', () => {
    const s = cashOnlyScenario({ startAge: 66, pot: 50_000, spend: 20_000, horizonYears: 3 });
    s.accounts.push(account('pen', 'dcPension', 500_000, { pensionAccessAge: 57 }));
    s.withdrawalOrder = ['cash', 'dcPension'];
    s.pensionDrawdown = 'allowance';
    const a = rows(s, taxOn())[0];
    const m = rows(monthly(s), taxOn())[0];
    expect(a.taxPaid).toBeCloseTo(0, 6);
    expect(m.taxPaid).toBeCloseTo(0, 0);
    expect(m.drawPension).toBeCloseTo(a.drawPension, -1);
  });

  it('a buy-to-let bought later earns rent from the year it is bought', () => {
    const s = cashOnlyScenario({ startAge: 50, pot: 500_000, spend: 10_000, horizonYears: 5 });
    s.properties = [{ id: 'btl', name: 'Flat', value: 200_000, growthRealPct: 0, isMainResidence: false, runningCostsAnnual: 1_000, rentalIncomeAnnual: 12_000, buyAtAge: 52, depositPct: 1 }];
    const r = rows(s);
    expect(r[1].rentalIncome).toBe(0);
    expect(r[2].rentalIncome).toBeCloseTo(12_000, 6);
  });

  it('a part first year does not cut the next State Pension rise in monthly steps', () => {
    const cfg = zeroWorldConfig();
    cfg.market.inflation = { mean: 0.05, vol: 0, floor: -0.02 };
    cfg.statePension.growth = 'inflation';
    const s = cashOnlyScenario({ startAge: 70, pot: 1_000_000, spend: 0, horizonYears: 3 });
    s.people[0] = { ...s.people[0], dateOfBirth: '1956-01-01', niQualifyingYears: 35 };
    s.sim = { ...s.sim, startDate: '2026-10-06' };
    const a = rows(s, cfg);
    const m = rows(monthly(s), cfg);
    expect(m[1].statePension).toBeCloseTo(a[1].statePension, 0);
  });

  it('guardrails spending does not jump after a part first year', () => {
    const cfg = zeroWorldConfig();
    cfg.market.inflation = { mean: 0.05, vol: 0, floor: -0.02 };
    const s = cashOnlyScenario({ startAge: 65, pot: 1_000_000, spend: 40_000, horizonYears: 4 });
    s.sim = { ...s.sim, startDate: '2026-10-06' };
    s.strategy = { kind: 'guardrails', initialPct: 0.04, upperGuard: 0.5, lowerGuard: 0.5, adjust: 0.1 };
    const r = rows(s, cfg);
    // Whole-year rate in year 2 equals the first year's (half-year amounts are annualised).
    expect(r[1].spending).toBeCloseTo(r[0].spending * 2, 0);
  });

  it('a one-off ISA payment in a part first year can use the whole ISA allowance', () => {
    const s = cashOnlyScenario({ startAge: 40, pot: 50_000, spend: 0, horizonYears: 3 });
    s.sim = { ...s.sim, startDate: '2026-10-06' };
    s.accounts.push(account('isa', 'isa', 0), account('gia', 'gia', 0));
    s.withdrawalOrder = ['cash', 'gia', 'isa'];
    s.contributions = [{ id: 'l', accountId: 'isa', personIndex: 0, type: 'lumpSum', amount: 20_000, startAge: 40, endAge: 120, escalatesWithInflation: false, source: 'external' }];
    expect(simulate(s, zeroWorldConfig(), { runsOverride: 1 }).warnings.some((w) => /above the allowance/.test(w))).toBe(false);
  });

  it('monthly and annual steps agree when spare income is spent and a big cost falls mid-plan', () => {
    const s = cashOnlyScenario({ startAge: 35, pot: 200_000, spend: 20_000, horizonYears: 6 });
    s.people[0] = { ...s.people[0], salary: 60_000, retirementAge: 60 };
    s.surplus = { kind: 'spend' };
    s.oneOffCosts = [{ id: 'c', name: 'Car', amount: 25_000, atAge: 36, everyYears: 2, inflationLinked: true }];
    const a = rows(s, taxOn());
    const m = rows(monthly(s), taxOn());
    expect(Math.abs(m[5].portfolioEnd / a[5].portfolioEnd - 1)).toBeLessThan(0.01);
  });

  it('rent that starts after a home purchase is paid', () => {
    const terms: Mortgage = { balance: 0, type: 'repayment', rate: 0.05, fixedYearsRemaining: 0, reversionRate: 0.05, termYearsRemaining: 25, monthlyOverpayment: 0 };
    const s = cashOnlyScenario({ startAge: 35, pot: 500_000, spend: 10_000, horizonYears: 8 });
    s.properties = [{ id: 'h', name: 'Home', value: 200_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0, buyAtAge: 37, depositPct: 0.2, mortgage: terms }];
    s.rentPaid = [{ id: 'r', name: 'Later rent', monthly: 1_000, growthRealPct: 0, fromAge: 40 }];
    const r = rows(s);
    expect(r[4].rentPaid).toBe(0);
    expect(r[5].rentPaid).toBeCloseTo(12_000, 6);
  });

  it('stamp duty: an additional home pays the surcharge and gets no first-time relief', () => {
    const sd = TEST_CONFIG.tax['2026/27'].stampDuty;
    expect(stampDuty(300_000, true, sd, true)).toBeCloseTo(5_000 + 300_000 * 0.05, 6);
    const s = cashOnlyScenario({ startAge: 50, pot: 500_000, spend: 10_000, horizonYears: 4 });
    s.properties = [
      { id: 'home', name: 'Home', value: 400_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0 },
      { id: 'btl', name: 'Flat', value: 300_000, growthRealPct: 0, isMainResidence: false, runningCostsAnnual: 0, buyAtAge: 52, depositPct: 1, firstTimeBuyer: true },
    ];
    expect(rows(s)[2].homePurchase).toBeCloseTo(300_000 + 20_000, 6);
  });

  it('State Pension years: pay fixed in pounds falls below the lower earnings limit in real terms', () => {
    const sp = TEST_CONFIG.statePension;
    const p = { name: 'A', dateOfBirth: '1980-01-01', salary: 7_000, salaryGrowthRealPct: 0, retirementAge: 68, niQualifyingYears: 0 };
    const linked = qualifyingYearsAtStart(p, 46, 68, sp, 6_708, 0.025);
    const fixed = qualifyingYearsAtStart({ ...p, salaryInflationLinked: false }, 46, 68, sp, 6_708, 0.025);
    expect(linked).toBe(22);
    expect(fixed).toBe(2);   // £7,000 / 1.025^n stays above £6,708 only for n = 0 and 1
  });
});
