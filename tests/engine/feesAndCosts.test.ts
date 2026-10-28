import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { runningCostsNominal } from '../../src/engine/property';
import { initialMortgageState, scheduleMonths } from '../../src/engine/mortgage';
import { mortgagePayments } from '../../src/model/mortgageMath';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import type { Mortgage, Property } from '../../src/model/types';

describe('fixed account fee', () => {
  const withFee = (stepsPerYear: 1 | 12) => {
    const s = cashOnlyScenario({ pot: 100_000, spend: 0, horizonYears: 5 });
    s.accounts[0].annualFeeFixed = 120;
    s.sim.stepsPerYear = stepsPerYear;
    return simulate(s, zeroWorldConfig(), { deterministic: true }).centralCase.map((r) => r.portfolioEnd);
  };
  it('takes the flat fee from the balance every year (annual and monthly agree)', () => {
    expect(withFee(1)).toEqual([99_880, 99_760, 99_640, 99_520, 99_400].map((v) => expect.closeTo(v, 6)));
    withFee(12).forEach((v, t) => expect(v).toBeCloseTo(100_000 - 120 * (t + 1), 6));
  });
  it('rises with inflation and never takes a balance below zero', () => {
    const cfg = zeroWorldConfig();
    cfg.market.inflation.mean = 0.1;
    const s = cashOnlyScenario({ pot: 150, spend: 0, horizonYears: 3 });
    s.accounts[0].annualFeeFixed = 100;
    const ends = simulate(s, cfg, { deterministic: true }).centralCase.map((r) => r.portfolioEnd);
    // Cash earns inflation: £150 grows to £165, less the £100 fee; real terms divide by 1.1.
    expect(ends[0]).toBeCloseTo((150 * 1.1 - 100) / 1.1, 6);
    // Next year £65 grows to £71.50 but the fee is now £110: emptied, not negative.
    expect(ends[1]).toBe(0);
  });
  it('rejects a negative fixed fee', () => {
    const s = cashOnlyScenario();
    s.accounts[0].annualFeeFixed = -5;
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('accounts[0].annualFeeFixed');
  });
});

describe('running costs as a percentage of the home value', () => {
  const home: Property = { id: 'h', name: 'Home', value: 300_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 2_000, runningCostsPctOfValue: 0.01 };
  it('adds the percentage of the current value to the fixed amount', () => {
    expect(runningCostsNominal(home, 1)).toBeCloseTo(5_000, 9);
    expect(runningCostsNominal(home, 1.1, false, 400_000)).toBeCloseTo(2_200 + 4_000, 9);
  });
  it('follows the home value in the simulation', () => {
    const cfg = zeroWorldConfig();
    const s = cashOnlyScenario({ pot: 1_000_000, spend: 0, horizonYears: 2 });
    s.properties = [home];
    expect(simulate(s, cfg, { deterministic: true }).centralCase[0].propertyCosts).toBeCloseTo(5_000, 6);
  });
  it('rejects an implausible percentage', () => {
    const s = cashOnlyScenario();
    s.properties = [{ ...home, runningCostsPctOfValue: 0.5 }];
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('properties[0].runningCostsPctOfValue');
  });
});

describe('mortgage payment calculator', () => {
  const base: Mortgage = { balance: 200_000, type: 'repayment', rate: 0.05, fixedYearsRemaining: 0, reversionRate: 0.05, termYearsRemaining: 25, monthlyOverpayment: 0 };
  it('repayment: £200,000 over 25 years at 5% is about £1,169.18 a month', () => {
    expect(mortgagePayments(base).now).toBeCloseTo(1169.18, 2);
    expect(mortgagePayments(base).afterFix).toBeUndefined();
  });
  it('interest-only: £200,000 at 5% is about £833.33 a month', () => {
    expect(mortgagePayments({ ...base, type: 'interestOnly' }).now).toBeCloseTo(833.33, 2);
  });
  it('after the fix it matches the payment the engine recalculates', () => {
    const m: Mortgage = { ...base, rate: 0.045, fixedYearsRemaining: 2, reversionRate: 0.065, termYearsRemaining: 15, monthlyOverpayment: 200 };
    const pay = mortgagePayments(m);
    expect(pay.now).toBeCloseTo(scheduleMonths(initialMortgageState(m), 1).endState.payment, 6);
    const afterFix = scheduleMonths(initialMortgageState(m), 25).endState.payment;
    expect(pay.afterFix).toBeCloseTo(afterFix, 2);
    expect(pay.afterFix).toBeGreaterThan(pay.now * 0.9);   // higher rate, smaller balance
  });
});
