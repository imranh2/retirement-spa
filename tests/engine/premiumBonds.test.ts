import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { planContributions } from '../../src/engine/contributions';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

/** Retired at 60, £20k cash plus Premium Bonds, no tax, no market returns, no inflation. */
function withBonds(bonds: number, spend: number, prizeRate = 0.04): Scenario {
  const s = cashOnlyScenario({ startAge: 60, pot: 20_000, spend, horizonYears: 5 });
  s.accounts.push(account('pb', 'premiumBonds', bonds, { prizeRate, allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
  s.withdrawalOrder = ['premiumBonds', 'cash'];
  return s;
}
const rows = (s: Scenario) => simulate(s, zeroWorldConfig(), { runsOverride: 1 }).centralCase;

describe('Premium Bonds', () => {
  it('grow at the predicted prize rate, whatever the markets do', () => {
    const r = rows(withBonds(10_000, 0));
    expect(r[0].portfolioEnd).toBeCloseTo(20_000 + 10_400, 6);
    expect(r[1].portfolioEnd).toBeCloseTo(20_000 + 10_400 * 1.04, 6);
  });
  it('use the rules’ prize rate when the account sets none', () => {
    const s = withBonds(10_000, 0);
    delete s.accounts[1].prizeRate;
    expect(rows(s)[0].portfolioEnd).toBeCloseTo(20_000 + 10_000 * (1 + zeroWorldConfig().market.premiumBondsPrizeRate), 6);
  });
  it('pay prizes above the holding limit into cash', () => {
    // At the £50k limit, the £2k of prizes goes to cash, so year 2 can draw only £50k from the bonds.
    const s = withBonds(50_000, 0);
    s.spending = [{ fromAge: 0, annualSpend: 0 }, { fromAge: 61, annualSpend: 51_000 }];
    const r = rows(s);
    expect(r[1].drawPremiumBonds).toBeCloseTo(50_000, 6);
    expect(r[1].drawCash).toBeCloseTo(1_000, 6);
  });
  it('keep payments in above the holding limit as cash', () => {
    const accounts = [account('cash', 'cash', 0), account('gia', 'gia', 0), account('pb', 'premiumBonds', 49_000)];
    const person = { name: 'A', dateOfBirth: '1980-01-01', salary: 50_000, salaryGrowthRealPct: 0, retirementAge: 67, niQualifyingYears: 20 };
    const plan = planContributions(
      [{ id: 'c', accountId: 'pb', personIndex: 0, type: 'fixedMonthly', amount: 200, startAge: 0, endAge: 120, escalatesWithInflation: false }],
      accounts, [person], [{ age: 46, grossSalary: 50_000, mpaaTriggered: false }], 0, 1, TEST_CONFIG.tax['2026/27'], undefined, [1_000]);
    expect(plan.credits).toEqual([1_400, 0, 1_000]);
    expect(plan.premiumBondsOverflow).toBe(true);
    expect(plan.fromTakeHome).toBe(2_400);
  });
  it('are limited to the holding limit per person', () => {
    const s = withBonds(60_000, 0);
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('accounts[1].balance');
    expect(validateScenario(withBonds(50_000, 0), TEST_CONFIG)).toEqual([]);
  });
});

describe('Premium Bonds limit with a year-end payment', () => {
  it('a one-off payment at the end of the year cannot take holdings over the limit', () => {
    const s = withBonds(49_000, 0);
    s.contributions = [{ id: 'l', accountId: 'pb', personIndex: 0, type: 'lumpSum', amount: 5_000, startAge: 60, endAge: 120, escalatesWithInflation: false, source: 'external' }];
    s.withdrawalOrder = ['cash', 'premiumBonds'];
    s.spending = [{ fromAge: 0, annualSpend: 0 }, { fromAge: 61, annualSpend: 100_000 }];
    // Year 2 spends everything: Premium Bonds hold at most £50k, the rest was paid into cash.
    const r = rows(s);
    expect(r[1].drawPremiumBonds).toBeLessThanOrEqual(50_000 + 1e-6);
  });
});
