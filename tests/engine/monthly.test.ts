import { describe, it, expect } from 'vitest';
import { simulate, createSimulation, maxSustainableSpend } from '../../src/engine/simulate';
import { generateMonthlyReturns, generateReturns, lognormalParams } from '../../src/engine/returns';
import { initialMortgageState, scheduleMonths, scheduleYear, type MortgageState } from '../../src/engine/mortgage';
import { mulberry32 } from '../../src/engine/prng';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';
import type { ConfigBundle } from '../../src/config/configTypes';

const monthly = (s: Scenario): Scenario => ({ ...s, sim: { ...s.sim, stepsPerYear: 12 } });
const within = (a: number, b: number, rel: number, scale = Math.max(Math.abs(a), Math.abs(b), 1)) => Math.abs(a - b) / scale <= rel;

describe('monthly returns', () => {
  it('zero volatility: 12 months compound exactly to the annual means', () => {
    const market = structuredClone(TEST_CONFIG.market);
    for (const k of ['equities', 'bonds', 'cash', 'property'] as const) market[k].vol = 0;
    market.inflation.vol = 0;
    const m = generateMonthlyReturns({ market, historical: [], model: 'lognormal', years: 2, rng: mulberry32(1) });
    expect(m).toHaveLength(24);
    const annual = generateReturns({ market, historical: [], model: 'lognormal', years: 1, rng: mulberry32(1), deterministic: true })[0];
    const prod = (key: keyof typeof annual) => m.slice(0, 12).reduce((p, x) => p * (1 + x[key]), 1) - 1;
    expect(prod('equities')).toBeCloseTo(annual.equities, 12);
    expect(prod('inflation')).toBeCloseTo(annual.inflation, 12);
  });
  it('monthly draws scale to the annual assumptions (mean/12, vol/sqrt(12) on the log scale)', () => {
    const years = 20000;
    const m = generateMonthlyReturns({ market: TEST_CONFIG.market, historical: [], model: 'lognormal', years, rng: mulberry32(4) });
    const real: number[] = [];
    let infl = 0;
    for (let y = 0; y < years; y++) {
      let g = 1; let i = 1;
      for (let k = 0; k < 12; k++) { const r = m[y * 12 + k]; g *= (1 + r.equities) / (1 + r.inflation); i *= 1 + r.inflation; }
      real.push(g - 1); infl += i - 1;
    }
    const mean = real.reduce((a, b) => a + b, 0) / years;
    const sd = Math.sqrt(real.reduce((a, b) => a + (b - mean) ** 2, 0) / years);
    expect(Math.abs(mean - 0.05)).toBeLessThan(0.006);
    expect(Math.abs(sd - 0.16)).toBeLessThan(0.01);
    expect(Math.abs(infl / years - 0.025)).toBeLessThan(0.002);
    expect(lognormalParams(0.05, 0.16).sigma2).toBeGreaterThan(0);
  });
  it('deterministic and bootstrap modes split each year into 12 equal steps', () => {
    const m = generateMonthlyReturns({ market: TEST_CONFIG.market, historical: [], model: 'lognormal', years: 1, rng: mulberry32(1), deterministic: true });
    expect(new Set(m.map((x) => x.equities)).size).toBe(1);
  });
});

describe('monthly mortgage schedule', () => {
  it('12 single months equal one scheduleYear', () => {
    const mort = { balance: 200000, type: 'repayment' as const, rate: 0.04, fixedYearsRemaining: 1, reversionRate: 0.06, termYearsRemaining: 20, monthlyOverpayment: 100 };
    let a: MortgageState = initialMortgageState(mort);
    let b: MortgageState = initialMortgageState(mort);
    for (let y = 0; y < 3; y++) {
      const yr = scheduleYear(a); a = yr.endState;
      let paid = 0;
      for (let k = 0; k < 12; k++) { const m = scheduleMonths(b, 1); paid += m.payments; b = m.endState; }
      expect(paid).toBeCloseTo(yr.payments, 6);
      expect(b.balance).toBeCloseTo(a.balance, 6);
    }
  });
});

describe('monthly vs annual consistency (zero volatility, within 1%)', () => {
  it('zero-return drawdown fails at exactly the same age', () => {
    const cfg = zeroWorldConfig();
    const a = simulate(cashOnlyScenario({ horizonYears: 30 }), cfg);
    const m = simulate(monthly(cashOnlyScenario({ horizonYears: 30 })), cfg);
    expect(m.depletionAgeHistogram).toEqual(a.depletionAgeHistogram);
    expect(simulate(monthly(cashOnlyScenario({ horizonYears: 25 })), cfg).successRate).toBe(1);
  });

  it('a 3% cash pot drawn down for 10 years: year-end balances within 1%', () => {
    const cfg = zeroWorldConfig();
    cfg.market.cash.meanReal = 0.03;
    const s = cashOnlyScenario({ pot: 1_000_000, spend: 40000, horizonYears: 10 });
    const a = simulate(s, cfg).portfolioReal.p50;
    const m = simulate(monthly(s), cfg).portfolioReal.p50;
    a.forEach((v, t) => expect(within(m[t], v, 0.01)).toBe(true));
    expect(m[9]).toBeGreaterThan(a[9]);   // money stays invested for part of each year
  });

  it('pension drawdown with tax settled at year end: draws, tax and balances within 1%', () => {
    const cfg: ConfigBundle = structuredClone(TEST_CONFIG);
    for (const k of ['equities', 'bonds', 'cash', 'property'] as const) cfg.market[k] = { meanReal: 0, vol: 0 };
    cfg.market.inflation = { mean: 0, vol: 0, floor: 0 };
    const s = cashOnlyScenario({ startAge: 60, pot: 0, spend: 30000, horizonYears: 10 });
    s.accounts.push(account('pen', 'dcPension', 500000, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
    const a = simulate(s, cfg, { deterministic: true });
    const m = simulate(monthly(s), cfg, { deterministic: true });
    const sum = (r: typeof a, k: 'drawPension' | 'taxPaid') => r.centralCase.reduce((x, row) => x + row[k], 0);
    expect(sum(m, 'taxPaid')).toBeGreaterThan(0);
    expect(within(sum(m, 'taxPaid'), sum(a, 'taxPaid'), 0.01)).toBe(true);
    expect(within(sum(m, 'drawPension'), sum(a, 'drawPension'), 0.01)).toBe(true);
    a.centralCase.forEach((row, t) => expect(within(m.centralCase[t].portfolioEnd, row.portfolioEnd, 0.01, 500000)).toBe(true));
  });

  it('a working couple with a mortgage: lifetime tax and mortgage payments within 1%', async () => {
    const { buildExamples } = await import('../../src/ui/exampleScenarios');
    const s = buildExamples('2026-10-28')[1].scenario;
    const a = simulate(s, TEST_CONFIG, { deterministic: true });
    const m = simulate(monthly(s), TEST_CONFIG, { deterministic: true });
    const tot = (r: typeof a, f: (row: (typeof a.centralCase)[number]) => number) => r.centralCase.reduce((x, row) => x + f(row), 0);
    expect(within(tot(m, (r) => r.taxPaid + r.niPaid), tot(a, (r) => r.taxPaid + r.niPaid), 0.01)).toBe(true);
    expect(within(tot(m, (r) => r.mortgagePayments), tot(a, (r) => r.mortgagePayments), 0.01)).toBe(true);
    expect(m.successRate).toBe(a.successRate);
  });
});

describe('monthly rules', () => {
  it('a locked pension is never drawn before its access age', () => {
    const s = cashOnlyScenario({ startAge: 50, pot: 20000, spend: 30000, horizonYears: 20, runs: 20 });
    s.people[0].dateOfBirth = '1976-01-01';
    s.accounts = [account('cash', 'cash', 20000), account('isa', 'isa', 300000), account('pen', 'dcPension', 400000)];
    const r = simulate(monthly(s), TEST_CONFIG);
    r.ages.forEach((age, t) => { if (age < 57) expect(r.incomeBySourceMeanReal.dcPension[t]).toBe(0); });
    expect(r.incomeBySourceMeanReal.dcPension[r.ages.indexOf(60)]).toBeGreaterThan(0);
  });
  it('same seed reproduces; results are independent of chunk size', () => {
    const s = monthly(cashOnlyScenario({ pot: 800000, spend: 35000, horizonYears: 25, runs: 60 }));
    s.accounts[0] = account('cash', 'cash', 800000, { allocation: { equities: 0.6, bonds: 0.4, cash: 0, property: 0 } });
    const whole = simulate(s, TEST_CONFIG);
    const sim = createSimulation(s, TEST_CONFIG);
    for (let f = 0; f < sim.totalRuns; f += 7) sim.runChunk(f, f + 7);
    expect(sim.finish().portfolioReal).toEqual(whole.portfolioReal);
    expect(simulate(s, TEST_CONFIG).portfolioReal).toEqual(whole.portfolioReal);
  });
  it('max sustainable spend runs with annual steps and says so', () => {
    const s = monthly(cashOnlyScenario({ pot: 800000, spend: 30000, horizonYears: 20, runs: 100 }));
    const out = maxSustainableSpend(s, zeroWorldConfig());
    expect(out.warnings.some((w) => /annual time steps/.test(w))).toBe(true);
  });
});
