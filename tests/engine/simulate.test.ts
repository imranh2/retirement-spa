import { describe, it, expect } from 'vitest';
import { simulate, createSimulation, maxSustainableSpend } from '../../src/engine/simulate';
import { percentile, findMaxSustainableSpend } from '../../src/engine/stats';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario, dobForAge } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

describe('(a) zero-return drawdown', () => {
  it('£1m at £40k/yr fails at exactly start + 25', () => {
    const r = simulate(cashOnlyScenario({ startAge: 60, horizonYears: 30 }), zeroWorldConfig());
    expect(r.successRate).toBe(0);
    expect(r.depletionAgeHistogram).toEqual([{ age: 85, count: 1 }]);
    expect(r.portfolioReal.p50[24]).toBeCloseTo(0, 6);
    expect(r.portfolioReal.p50[29]).toBe(0);
  });
  it('lasts exactly 25 years: horizon start + 25 succeeds', () => {
    expect(simulate(cashOnlyScenario({ startAge: 60, horizonYears: 25 }), zeroWorldConfig()).successRate).toBe(1);
  });
});

describe('(b) hand-calculated 2% return depletion', () => {
  it('£100k at 2% with £15k spend depletes in year 8 (age 67)', () => {
    // Year-end balances: B(n+1) = (B(n) - 15000) * 1.02
    // 86,700 -> 73,134 -> 59,296.68 -> 45,182.61 -> 30,786.26 -> 16,101.99 -> 1,124.03 -> year 8 short
    const cfg = zeroWorldConfig();
    cfg.market.cash.meanReal = 0.02;
    const s = cashOnlyScenario({ startAge: 60, pot: 100000, spend: 15000, horizonYears: 10 });
    const r = simulate(s, cfg);
    expect(r.portfolioReal.p50[0]).toBeCloseTo(86700, 6);
    expect(r.portfolioReal.p50[6]).toBeCloseTo(1124.03, 1);
    expect(r.depletionAgeHistogram).toEqual([{ age: 67, count: 1 }]);
  });
});

function bridgeScenario(runs: number): Scenario {
  const s = cashOnlyScenario({ startAge: 50, pot: 20000, spend: 30000, horizonYears: 30, runs });
  s.people[0].dateOfBirth = '1976-01-01';
  s.accounts = [
    account('cash', 'cash', 20000),
    account('isa', 'isa', 400000, { allocation: { equities: 0.6, bonds: 0.4, cash: 0, property: 0 } }),
    account('pen', 'dcPension', 400000, { allocation: { equities: 0.6, bonds: 0.4, cash: 0, property: 0 } }),
  ];
  return s;
}

describe('(c) locked pension', () => {
  it('a DC pension locked until 57 is never drawn before 57', () => {
    const s = bridgeScenario(30);
    const r = simulate(s, TEST_CONFIG);
    const before = r.ages.map((a, t) => ({ a, t })).filter(({ a }) => a < 57);
    for (const { t } of before) {
      expect(r.centralCase[t].drawPension).toBe(0);
      expect(r.incomeBySourceMeanReal.dcPension[t]).toBe(0);
    }
    const at57 = r.ages.indexOf(57);
    expect(r.incomeBySourceMeanReal.isa.slice(0, at57).every((v) => v > 0)).toBe(true);
    expect(r.warnings.some((w) => /can’t be used until age 57/.test(w))).toBe(true);
  });
  it('pension is used once accessible when other pots are empty', () => {
    const s = bridgeScenario(1);
    s.accounts[1].balance = 0;
    s.sim.horizonAge = 70;
    const r = simulate(s, zeroWorldConfig());
    expect(r.depletionAgeHistogram).toEqual([{ age: 50, count: 1 }]);
    s.accounts[0].balance = 30000 * 7;
    const ok = simulate(s, zeroWorldConfig());
    expect(ok.successRate).toBe(1);
    expect(ok.centralCase[7].drawPension).toBeCloseTo(30000, 0);
  });
});

/** Full 5,000-run simulations can pass the default 5s limit when the whole suite runs in parallel. */
const HEAVY_TEST_TIMEOUT_MS = 20_000;

describe('(d) reproducibility', () => {
  const s = bridgeScenario(1200);
  it('same seed gives identical results; different seed differs', () => {
    const a = simulate(s, TEST_CONFIG);
    const b = simulate(s, TEST_CONFIG);
    expect(b.portfolioReal).toEqual(a.portfolioReal);
    const c = simulate({ ...s, sim: { ...s.sim, seed: 2 } }, TEST_CONFIG);
    expect(c.portfolioReal.p50).not.toEqual(a.portfolioReal.p50);
  }, HEAVY_TEST_TIMEOUT_MS);
  it('results are independent of chunk size', () => {
    const whole = simulate(s, TEST_CONFIG);
    const sim = createSimulation(s, TEST_CONFIG);
    for (let from = 0; from < sim.totalRuns; from += 7) sim.runChunk(from, from + 7);
    const chunked = sim.finish();
    expect(chunked.portfolioReal).toEqual(whole.portfolioReal);
    expect(chunked.successRate).toBe(whole.successRate);
    expect(chunked.incomeBySourceMeanReal).toEqual(whole.incomeBySourceMeanReal);
  });
});

describe('(e) max sustainable spend', () => {
  it('returns a multiplier meeting the target; 5% more falls below', () => {
    const s = cashOnlyScenario({ startAge: 60, pot: 800000, spend: 30000, horizonYears: 30, runs: 300 });
    s.accounts[0] = account('cash', 'cash', 800000, { allocation: { equities: 0.6, bonds: 0.4, cash: 0, property: 0 } });
    s.strategy = { kind: 'guardrails', initialPct: 0.04, upperGuard: 0.2, lowerGuard: 0.2, adjust: 0.1 };
    const out = maxSustainableSpend(s, TEST_CONFIG);
    const m = out.value.multiplier;
    const fixed = { ...s, strategy: { kind: 'fixedReal' as const } };
    const at = (k: number) => simulate(fixed, TEST_CONFIG, { spendMultiplier: k, runsOverride: 300, successOnly: true }).successRate;
    expect(at(m)).toBeGreaterThanOrEqual(0.9);
    expect(at(m * 1.05)).toBeLessThan(0.9);
    expect(out.value.annualSpendReal).toBeCloseTo(30000 * m, 6);
    expect(out.warnings).toEqual([]);
  });
  it('warns when even the lower bound fails', () => {
    const s = cashOnlyScenario({ pot: 1000, spend: 40000, horizonYears: 30 });
    const out = findMaxSustainableSpend(s, zeroWorldConfig(), 0.9, { simulate: (a, b, o) => simulate(a, b, o) });
    expect(out.value.multiplier).toBe(0.1);
    expect(out.warnings).toHaveLength(1);
  });
});

describe('(f) percentile', () => {
  it('known arrays give known results', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([7], 0.9)).toBe(7);
  });
});

describe('(g) config changes tax', () => {
  it('a higher personal allowance lowers total tax paid', () => {
    const s = cashOnlyScenario({ startAge: 40, pot: 50000, spend: 20000, horizonYears: 5, runs: 20 });
    s.people[0].salary = 40000;
    s.people[0].retirementAge = 60;
    const a = simulate(s, TEST_CONFIG);
    const cfg = structuredClone(TEST_CONFIG);
    cfg.tax['2026/27'].personalAllowance = 20000;
    const b = simulate(s, cfg);
    expect(b.taxPaidTotal.median).toBeLessThan(a.taxPaidTotal.median);
  });
});

describe('cash flow details', () => {
  it('working surplus is paid into cash; ISA contributions come out of take-home pay', () => {
    const cfg = zeroWorldConfig();
    const s = cashOnlyScenario({ startAge: 40, pot: 0, spend: 20000, horizonYears: 2 });
    s.people[0].salary = 50000;
    s.people[0].retirementAge = 60;
    s.accounts.push(account('isa', 'isa', 0));
    s.contributions = [{ id: 'c', accountId: 'isa', personIndex: 0, type: 'fixedMonthly', amount: 1000, startAge: 0, endAge: 100, escalatesWithInflation: false }];
    const r = simulate(s, cfg);
    // 50,000 salary - 20,000 spend - 12,000 ISA = 18,000 to cash; total portfolio 30,000
    expect(r.portfolioReal.p50[0]).toBeCloseTo(30000, 6);
  });
  it('State Pension is paid from the start age and taxed', () => {
    const s = cashOnlyScenario({ startAge: 66, pot: 0, spend: 0, horizonYears: 2 });
    s.people[0].niQualifyingYears = 35;
    s.people[0].dateOfBirth = '1960-01-01';
    const r = simulate(s, TEST_CONFIG, { deterministic: true });
    expect(r.centralCase[0].statePension).toBeCloseTo(12547.6, 2);
    expect(r.centralCase[0].taxPaid).toBe(0);
  });
  it('deferring the State Pension adds the deferral increase for each year deferred', () => {
    const sp = (startAt?: number) => {
      const s = cashOnlyScenario({ startAge: 70, pot: 0, spend: 0, horizonYears: 1 });
      s.people[0].niQualifyingYears = 35;
      s.people[0].statePensionStartAge = startAt;
      return simulate(s, TEST_CONFIG, { deterministic: true }).centralCase[0].statePension;
    };
    // Born 1956: State Pension age 66; starting at 69 is 3 years' deferral.
    expect(sp(69) / sp()).toBeCloseTo(1 + 3 * TEST_CONFIG.statePension.deferralIncreasePerYear, 9);
  });
  it('the State Pension cannot be set to start before State Pension age', () => {
    const s = cashOnlyScenario({ startAge: 60 });
    s.people[0].statePensionStartAge = 64;
    expect(() => simulate(s, TEST_CONFIG)).toThrow(/before State Pension age/);
  });
  it('employee NI stops at State Pension age', () => {
    const working = (age: number) => {
      const s = cashOnlyScenario({ startAge: age, pot: 0, spend: 0, horizonYears: 1 });
      s.people[0].salary = 40000; s.people[0].retirementAge = 75;
      return simulate(s, TEST_CONFIG, { deterministic: true }).centralCase[0].niPaid;
    };
    expect(working(60)).toBeGreaterThan(0);
    expect(working(68)).toBe(0);
  });
  it('couples: each person is taxed separately and ages use the DOB offset', () => {
    const s = cashOnlyScenario({ startAge: 60, pot: 0, spend: 0, horizonYears: 1 });
    s.people.push({ name: 'B', dateOfBirth: dobForAge(55), salary: 30000, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 0 });
    s.people[0].salary = 30000; s.people[0].retirementAge = 65;
    const r = simulate(s, TEST_CONFIG, { deterministic: true });
    expect(r.centralCase[0].taxPaid).toBeCloseTo(2 * (30000 - 12570) * 0.2, 6);
  });
  it('rejects invalid scenarios', () => {
    const s = cashOnlyScenario();
    expect(() => simulate({ ...s, accounts: [] }, TEST_CONFIG)).toThrow(/cash account/);
  });
});

describe('example scenarios run', () => {
  it('5,000 runs x 60 years finishes in a few seconds', async () => {
    const { EXAMPLE_SCENARIOS } = await import('../../src/ui/exampleScenarios');
    const s = structuredClone(EXAMPLE_SCENARIOS[2].scenario);
    s.sim.runs = 5000;
    s.sim.horizonAge = (2026 - 1996) + 60;
    const t0 = performance.now();
    const r = simulate(s, TEST_CONFIG);
    const ms = performance.now() - t0;
    expect(r.ages).toHaveLength(60);
    expect(ms).toBeLessThan(15000);
    console.log(`5000 runs x 60 years: ${Math.round(ms)} ms`);
  }, HEAVY_TEST_TIMEOUT_MS);
  it('all three examples simulate without errors', async () => {
    const { EXAMPLE_SCENARIOS } = await import('../../src/ui/exampleScenarios');
    for (const ex of EXAMPLE_SCENARIOS) {
      const r = simulate(ex.scenario, TEST_CONFIG, { runsOverride: 200 });
      expect(r.successRate).toBeGreaterThanOrEqual(0);
      expect(r.centralCase.length).toBe(r.ages.length);
    }
  });
});

describe('GIA cost basis', () => {
  // Zero returns and inflation: selling money that was paid in can never be a gain.
  const giaSaver = (stepsPerYear: 1 | 12) => {
    const s = cashOnlyScenario({ startAge: 40, pot: 150000, spend: 40000, horizonYears: 3 });
    s.people[0].retirementAge = 41;
    s.accounts.push(account('gia', 'gia', 0, { giaCostBasis: 0 }));
    s.contributions = [{ id: 'c', accountId: 'gia', personIndex: 0, type: 'lumpSum', amount: 100000, startAge: 40, endAge: 41, escalatesWithInflation: false }];
    s.withdrawalOrder = ['cash', 'gia'];
    s.sim.stepsPerYear = stepsPerYear;
    return s;
  };
  for (const steps of [1, 12] as const) {
    it(`money paid into a GIA is not taxed as a gain when sold (${steps === 1 ? 'annual' : 'monthly'})`, () => {
      const cfg = zeroWorldConfig();
      cfg.tax['2026/27'].cgt = { ...TEST_CONFIG.tax['2026/27'].cgt };   // real CGT rates
      const r = simulate(giaSaver(steps), cfg, { deterministic: true });
      expect(r.successRate).toBe(1);
      expect(r.centralCase.reduce((sum, row) => sum + row.drawGia, 0)).toBeGreaterThan(0);
      expect(r.centralCase.every((row) => row.taxPaid < 1)).toBe(true);
    });
  }
});

describe('scenario validation guards the engine', () => {
  it('rejects a fractional horizon age instead of crashing the run', async () => {
    const { validateScenario } = await import('../../src/model/validateScenario');
    const s = cashOnlyScenario();
    s.sim.horizonAge = 90.5;
    expect(validateScenario(s, TEST_CONFIG).some((i) => i.path === 'sim.horizonAge')).toBe(true);
  });
  it('only lets downsizing release money into cash or a GIA', async () => {
    const { validateScenario } = await import('../../src/model/validateScenario');
    const s = cashOnlyScenario();
    s.accounts.push(account('isa', 'isa', 0));
    s.properties = [{ id: 'h', name: 'Home', value: 500000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0, downsize: { atAge: 70, newValue: 300000, releaseToAccountId: 'isa' } }];
    expect(validateScenario(s, TEST_CONFIG).some((i) => i.path === 'properties[0].downsize.releaseToAccountId')).toBe(true);
    s.properties[0].downsize!.releaseToAccountId = 'cash';
    expect(validateScenario(s, TEST_CONFIG).some((i) => i.path.startsWith('properties'))).toBe(false);
  });
});

describe('income by source averages over funded runs', () => {
  it('years after a run fails do not pull the averages towards zero', () => {
    // Volatile returns and a pot that lasts about 25 years: many runs fail before the horizon.
    const s = cashOnlyScenario({ startAge: 60, pot: 1_000_000, spend: 40_000, horizonYears: 35, runs: 400 });
    s.accounts[0].allocation = { equities: 1, bonds: 0, cash: 0, property: 0 };
    const r = simulate(s, TEST_CONFIG);
    expect(r.successRate).toBeLessThan(0.9);
    const funded = r.fundedShareByAge!;
    expect(funded[0]).toBe(1);
    expect(funded[funded.length - 1]).toBeCloseTo(r.successRate, 9);
    for (let t = 1; t < funded.length; t++) expect(funded[t]).toBeLessThanOrEqual(funded[t - 1]);
    // Spending is fixed in real terms, so a funded year's net draws stay near 40k to the end.
    const last = r.incomeBySourceMeanReal.cash[r.ages.length - 1];
    expect(last).toBeGreaterThan(39_000);
  });
});

describe('State Pension with no earnings', () => {
  it('a non-earner builds no extra qualifying years unless NI credits are entered', () => {
    const s = cashOnlyScenario({ startAge: 50, horizonYears: 20 });
    s.people[0].niQualifyingYears = 20;
    s.people[0].retirementAge = 67;
    const at = (sc: typeof s) => { const r = simulate(sc, zeroWorldConfig(), { deterministic: true }); return r.centralCase[r.ages.indexOf(68)].statePension; };
    const none = at(s);
    s.people[0].niCreditsUntilAge = 60;
    const credited = at(s);
    expect(credited / none).toBeCloseTo(30 / 20, 6);
  });
});

describe('how low spending gets with a flexible strategy', () => {
  it('reports the 1-in-10 lowest retirement spending, below the plan when markets fall', () => {
    const s = bridgeScenario(300);
    s.strategy = { kind: 'percentOfPortfolio', pct: 0.04 };
    const r = simulate(s, TEST_CONFIG);
    expect(r.retirementSpendLow).toBeGreaterThan(0);
    expect(r.retirementSpendLow).toBeLessThan(r.centralCase[r.centralCase.length - 1].spending * 2);
  });
});
