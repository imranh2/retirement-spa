import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { targetSpend, executeWithdrawals } from '../../src/engine/withdrawal';
import { calculateCGT, calculateIncomeTax } from '../../src/engine/tax';
import { runningCostsNominal } from '../../src/engine/property';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';
import type { ConfigBundle } from '../../src/config/configTypes';

/** Fixture tax rules, but a calm market: no volatility, no inflation, equities return 4% real. */
function calmConfig(): ConfigBundle {
  const c = structuredClone(TEST_CONFIG);
  for (const k of ['equities', 'bonds', 'cash', 'property'] as const) c.market[k] = { meanReal: 0, vol: 0 };
  c.market.equities.meanReal = 0.04;
  c.market.inflation = { mean: 0, vol: 0, floor: -0.02 };
  return c;
}

describe('reinvested GIA income is not taxed again as a gain', () => {
  it('a GIA whose whole return is taxed dividends pays no CGT when sold', () => {
    const cfg = calmConfig();
    cfg.market.equityDividendYield = 0.04;     // the entire 4% return is dividends
    const s = cashOnlyScenario({ pot: 0, spend: 60_000, horizonYears: 10 });
    s.accounts.push(account('gia', 'gia', 1_000_000, { allocation: { equities: 1, bonds: 0, cash: 0, property: 0 }, giaCostBasis: 1_000_000 }));
    const noCgt = structuredClone(cfg);
    noCgt.tax['2026/27'].cgt = { ...noCgt.tax['2026/27'].cgt, basicRate: 0, higherRate: 0 };
    const withCgt = simulate(s, cfg, { deterministic: true }).centralCase;
    const without = simulate(s, noCgt, { deterministic: true }).centralCase;
    withCgt.forEach((row, t) => expect(row.taxPaid).toBeCloseTo(without[t].taxPaid, 0));
  });
});

describe('monthly mode pays salary tax from income, not from investments', () => {
  it('a well-paid worker never draws on an ISA listed first in the order', () => {
    const cfg = calmConfig();
    cfg.market.equities.meanReal = 0;
    const s: Scenario = cashOnlyScenario({ startAge: 40, pot: 10_000, spend: 30_000, horizonYears: 5 });
    s.people[0] = { ...s.people[0], salary: 60_000, retirementAge: 60 };
    s.accounts.push(account('isa', 'isa', 100_000));
    s.withdrawalOrder = ['isa', 'cash', 'gia', 'lisa', 'dcPension'];
    const monthly = simulate({ ...s, sim: { ...s.sim, stepsPerYear: 12 } }, cfg, { deterministic: true }).centralCase;
    const annual = simulate(s, cfg, { deterministic: true }).centralCase;
    monthly.forEach((row, t) => {
      expect(row.drawIsa).toBe(0);
      expect(row.drawCash).toBe(0);
      expect(row.portfolioEnd).toBeCloseTo(annual[t].portfolioEnd, 0);
    });
  });
});

describe('guardrails', () => {
  it('restart from the initial rate after a year that began with nothing', () => {
    const strategy = { kind: 'guardrails' as const, initialPct: 0.04, upperGuard: 0.2, lowerGuard: 0.2, adjust: 0.1 };
    const W = targetSpend({ strategy, phaseSpendToday: 30_000, inflationIndex: 1, retired: true, portfolioAtStart: 500_000, prevW: 0, prevInflation: 0.02 });
    expect(W).toBeCloseTo(20_000, 6);
  });
});

describe('investment income is taxed only on money kept during the year', () => {
  it('selling most of a cash pot at the start of the year leaves tax on the rest only', () => {
    const cfg = calmConfig();
    cfg.market.equities.meanReal = 0;
    cfg.market.cash.meanReal = 0.05;
    const sells = cashOnlyScenario({ pot: 2_000_000, spend: 1_500_000, horizonYears: 1 });
    const keeps = cashOnlyScenario({ pot: 500_000, spend: 0, horizonYears: 1 });
    const a = simulate(sells, cfg, { deterministic: true }).centralCase[0];
    const b = simulate(keeps, cfg, { deterministic: true }).centralCase[0];
    expect(b.taxPaid).toBeGreaterThan(0);
    expect(a.taxPaid).toBeCloseTo(b.taxPaid, 0);
  });
});

describe('downsizing', () => {
  const home = { id: 'h', name: 'Home', value: 500_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 4_000,
    downsize: { atAge: 70, newValue: 250_000, releaseToAccountId: 'cash' } };
  it('running costs scale with the new home after downsizing', () => {
    expect(runningCostsNominal(home, 1, false)).toBe(4_000);
    expect(runningCostsNominal(home, 1.5, true)).toBeCloseTo(3_000, 9);
  });
  it('a downsize age already passed is rejected', () => {
    const s = cashOnlyScenario({ startAge: 72 });
    s.properties = [home];
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('properties[0].downsize.atAge');
  });
});

describe('net worth after a run fails', () => {
  it('holds property equity level in real terms and grows it with inflation in nominal terms', () => {
    const cfg = calmConfig();
    cfg.market.equities.meanReal = 0;
    cfg.market.inflation.mean = 0.02;
    const s = cashOnlyScenario({ pot: 100_000, spend: 40_000, horizonYears: 8 });
    s.properties = [{ id: 'h', name: 'Home', value: 300_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0 }];
    const r = simulate(s, cfg, { deterministic: true });
    const nominal = r.netWorthNominal?.p50 ?? [];
    const real = r.netWorthReal.p50;
    const last = real.length - 1;
    expect(real[last]).toBeCloseTo(real[last - 1], 6);
    expect(nominal[last] / nominal[last - 1]).toBeCloseTo(1.02, 9);
  });
});

describe('CGT on earlier gains is re-priced when later draws raise income', () => {
  it('a pension draw at settlement pushes gains made earlier in the year into the higher rate', () => {
    const tax = TEST_CONFIG.tax['2026/27'];
    const income = { nonSavings: 30_000, savings: 0, dividends: 0 };
    const priorGains = 20_000;
    const taxableBefore = calculateIncomeTax(income, tax).taxableIncome;
    const priorCgt = calculateCGT(priorGains, taxableBefore, tax);
    const pension = account('p', 'dcPension', 200_000);
    const r = executeWithdrawals({
      accounts: [pension], order: ['dcPension'], cfg: tax, pensionAccessAge: [57],
      people: [{ age: 60, income, basicBandExtension: 0, priorGains, priorCgt }],
    }, 30_000, { balances: [200_000], giaBasis: [0], lsaUsed: [0], mpaaTriggered: [false] });
    const finalTaxable = calculateIncomeTax({ ...income, nonSavings: income.nonSavings + r.pensionTaxable[0] }, tax).taxableIncome;
    expect(r.cgt).toBeCloseTo(calculateCGT(priorGains, finalTaxable, tax) - priorCgt, 0);
    expect(r.cgt).toBeGreaterThan(0);
  });
});
