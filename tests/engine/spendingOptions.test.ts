import { describe, it, expect } from 'vitest';
import { oneOffDue, simulate } from '../../src/engine/simulate';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

/** Retired at 60, £1m cash, £20k spending, ten years. */
const base = (): Scenario => cashOnlyScenario({ startAge: 60, pot: 1_000_000, spend: 20_000, horizonYears: 10 });
const rows = (s: Scenario, cfg = zeroWorldConfig()) => simulate(s, cfg, { runsOverride: 1 }).centralCase;

describe('spending phases that change each year', () => {
  it('a phase can fall by a set % each year from when it starts', () => {
    const s = base();
    s.spending = [{ fromAge: 0, annualSpend: 20_000 }, { fromAge: 63, annualSpend: 20_000, changePct: -0.1 }];
    const r = rows(s);
    expect(r[3].spending).toBeCloseTo(20_000, 6);          // age 63: the phase's first year
    expect(r[5].spending).toBeCloseTo(20_000 * 0.81, 6);   // age 65: two years of -10%
  });
  it('a phase not linked to inflation stays fixed in pounds, so it shrinks in today’s money', () => {
    const s = base();
    s.spending = [{ fromAge: 0, annualSpend: 20_000, inflationLinked: false }];
    const r = rows(s, TEST_CONFIG);
    const infl = TEST_CONFIG.market.inflation.mean;
    expect(r[0].spending).toBeCloseTo(20_000, 6);
    expect(r[4].spending).toBeCloseTo(20_000 / (1 + infl) ** 4, 4);
    expect(r[4].spending * r[4].priceIndex!).toBeCloseTo(20_000, 4);   // still £20,000 in actual pounds
  });
});

describe('one-off and repeating costs', () => {
  it('fall due at their age, then every N years until the end age', () => {
    const car = { id: 'c', name: 'Car', amount: 15_000, atAge: 61, everyYears: 3, untilAge: 68, inflationLinked: true };
    expect([60, 61, 62, 64, 67, 70].map((a) => oneOffDue(car, a))).toEqual([false, true, false, true, true, false]);
    const s = base();
    s.oneOffCosts = [car, { id: 'w', name: 'Wedding', amount: 10_000, atAge: 62, inflationLinked: true }];
    const r = rows(s);
    expect(r.map((x) => x.oneOffCosts)).toEqual([0, 15_000, 10_000, 0, 15_000, 0, 0, 15_000, 0, 0]);
    // Paid on top of spending: the portfolio falls by both.
    expect(r[1].portfolioEnd).toBeCloseTo(1_000_000 - 2 * 20_000 - 15_000, 4);
  });
});

describe('rent on a home', () => {
  it('is paid monthly on top of spending, rises above inflation if set, and stops at its end age', () => {
    const s = base();
    s.rentPaid = [{ id: 'r', name: 'Flat', monthly: 1_000, growthRealPct: 0.02, untilAge: 65 }];
    const r = rows(s);
    expect(r[0].rentPaid).toBeCloseTo(12_000, 6);
    expect(r[2].rentPaid).toBeCloseTo(12_000 * 1.02 ** 2, 6);
    expect(r[5].rentPaid).toBe(0);
    expect(r[0].portfolioEnd).toBeCloseTo(1_000_000 - 20_000 - 12_000, 4);
  });
  it('counts towards running out of money', () => {
    const s = cashOnlyScenario({ startAge: 60, pot: 100_000, spend: 10_000, horizonYears: 10 });
    expect(simulate(s, zeroWorldConfig(), { runsOverride: 1 }).successRate).toBe(1);
    s.rentPaid = [{ id: 'r', name: 'Flat', monthly: 1_000, growthRealPct: 0 }];
    expect(simulate(s, zeroWorldConfig(), { runsOverride: 1 }).successRate).toBe(0);
  });
});
