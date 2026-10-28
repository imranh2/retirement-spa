import { describe, it, expect } from 'vitest';
import { monthlyPaymentRepayment, initialMortgageState, scheduleYear, type MortgageState } from '../../src/engine/mortgage';
import type { Mortgage } from '../../src/model/types';

const base: Mortgage = { balance: 200000, type: 'repayment', rate: 0.05, fixedYearsRemaining: 25, reversionRate: 0.05, termYearsRemaining: 25, monthlyOverpayment: 0 };

function runYears(m: Mortgage, years: number) {
  let s: MortgageState = initialMortgageState(m);
  const out = [];
  for (let y = 0; y < years; y++) { const r = scheduleYear(s); out.push(r); s = r.endState; }
  return out;
}

describe('mortgage', () => {
  it('£200,000, 25 years, 5%: payment about £1,169.18 and about 0 after 300 months', () => {
    expect(monthlyPaymentRepayment(200000, 0.05, 300)).toBeCloseTo(1169.18, 2);
    const ys = runYears(base, 25);
    expect(ys[24].endBalance).toBeLessThan(1);
    expect(ys[0].payments).toBeCloseTo(1169.18 * 12, 0);
    expect(ys.every((y) => y.lumpSumDue === 0)).toBe(true);
  });
  it('zero rate divides evenly', () => {
    expect(monthlyPaymentRepayment(1200, 0, 12)).toBe(100);
  });
  it('interest-only: about £833.33/month and balance never falls', () => {
    const io: Mortgage = { ...base, type: 'interestOnly' };
    const ys = runYears(io, 3);
    expect(ys[0].payments / 12).toBeCloseTo(833.33, 2);
    expect(ys[2].endBalance).toBe(200000);
  });
  it('interest-only balance becomes a lump sum at the end of the term', () => {
    const ys = runYears({ ...base, type: 'interestOnly', termYearsRemaining: 2 }, 3);
    expect(ys[1].lumpSumDue).toBeCloseTo(200000, 6);
    expect(ys[1].endBalance).toBe(0);
    expect(ys[2].payments).toBe(0);
  });
  it('reversion rate changes the payment at the correct month', () => {
    const ys = runYears({ ...base, fixedYearsRemaining: 2, reversionRate: 0.07 }, 3);
    expect(ys[1].payments).toBeCloseTo(ys[0].payments, 6);
    expect(ys[2].payments).toBeGreaterThan(ys[1].payments + 1000);
    const balAfter24 = ys[1].endBalance;
    expect(ys[2].payments / 12).toBeCloseTo(monthlyPaymentRepayment(balAfter24, 0.07, 276), 6);
  });
  it('overpayments shorten the term and early payoff stops payments', () => {
    const ys = runYears({ ...base, monthlyOverpayment: 500 }, 25);
    const paidOffYear = ys.findIndex((y) => y.endBalance === 0);
    expect(paidOffYear).toBeGreaterThan(0);
    expect(paidOffYear).toBeLessThan(20);
    expect(ys[paidOffYear + 1].payments).toBe(0);
  });
});
