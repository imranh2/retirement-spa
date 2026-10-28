import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { initialMortgageState, scheduleYear } from '../../src/engine/mortgage';
import { zeroWorldConfig } from '../fixtures/testConfig';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import type { Mortgage, Scenario } from '../../src/model/types';

const MORTGAGE: Mortgage = { balance: 200_000, type: 'repayment', rate: 0.045, fixedYearsRemaining: 0, reversionRate: 0.045, termYearsRemaining: 30, monthlyOverpayment: 0 };

function withMortgage(pot: number, stepsPerYear: 1 | 12 = 1): Scenario {
  const s = cashOnlyScenario({ startAge: 40, pot, spend: 10_000, horizonYears: 35 });
  s.properties = [{ id: 'h', name: 'Home', value: 300_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0, mortgage: { ...MORTGAGE } }];
  s.sim = { ...s.sim, stepsPerYear };
  return s;
}

describe('mortgage in the year-by-year table', () => {
  it('a 30-year repayment mortgage is mostly interest at first and is paid off in year 30', () => {
    const y1 = scheduleYear(initialMortgageState(MORTGAGE));
    expect(y1.interest / y1.payments).toBeGreaterThan(0.7);
    const rows = simulate(withMortgage(2_000_000), zeroWorldConfig(), { runsOverride: 1 }).centralCase;
    expect(rows[0].mortgageInterest).toBeCloseTo(y1.interest, 2);
    const paying = rows.filter((r) => r.mortgagePayments > 0);
    expect(paying.length).toBe(30);
    expect(paying[29].mortgageInterest! / paying[29].mortgagePayments).toBeLessThan(0.03);
    expect(rows[29].mortgageBalanceEnd).toBeCloseTo(0, 2);
  });
  it('records interest with monthly steps too', () => {
    const rows = simulate(withMortgage(2_000_000, 12), zeroWorldConfig(), { runsOverride: 1 }).centralCase;
    expect(rows[0].mortgageInterest).toBeCloseTo(scheduleYear(initialMortgageState(MORTGAGE)).interest, 2);
  });
  it('the table stops in the year the money runs out, with the mortgage still owed', () => {
    const rows = simulate(withMortgage(30_000), zeroWorldConfig(), { runsOverride: 1 }).centralCase;
    expect(rows.length).toBeLessThan(5);
    expect(rows[rows.length - 1].mortgageBalanceEnd).toBeGreaterThan(150_000);
  });
});
