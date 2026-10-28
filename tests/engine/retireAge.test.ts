import { describe, it, expect } from 'vitest';
import { earliestRetirementAgeSteps, quickMaxSpendSteps } from '../../src/engine/simulate';
import { withRetirementAge, type RetireAgeOutcome } from '../../src/model/retirement';
import { zeroWorldConfig } from '../fixtures/testConfig';
import { cashOnlyScenario, dobForAge } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

const run = (s: Scenario): RetireAgeOutcome => {
  const steps = earliestRetirementAgeSteps(s, zeroWorldConfig());
  for (;;) { const n = steps.next(); if (n.done) return n.value; }
};

/** Age 40, £50k salary, £30k spending, nothing saved, no tax or returns, plan until 61. */
function worker(): Scenario {
  const s = cashOnlyScenario({ startAge: 40, pot: 0, spend: 30_000, horizonYears: 21 });
  s.people[0] = { ...s.people[0], salary: 50_000, retirementAge: 60 };
  return s;
}

describe('earliest retirement age', () => {
  it('finds the first age where savings cover spending to the horizon (hand-checked)', () => {
    // Working years save £20k; retired years cost £30k. 20k(R-40) >= 30k(61-R) => R >= 52.6.
    const r = run(worker());
    expect(r.status).toBe('found');
    expect(r.age).toBe(53);
    expect(r.successRate).toBe(1);
  });
  it('says "now" when stopping today already works', () => {
    const s = worker();
    s.accounts[0].balance = 1_000_000;
    expect(run(s)).toMatchObject({ status: 'now', age: 40 });
  });
  it('says it is not reachable when even working to the horizon falls short', () => {
    const s = worker();
    s.spending = [{ fromAge: 0, annualSpend: 60_000 }];
    expect(run(s).status).toBe('notReachable');
  });
  it('does nothing for someone who has already stopped work', () => {
    expect(run(cashOnlyScenario({ startAge: 60 })).status).toBe('notWorking');
  });
});

describe('withRetirementAge', () => {
  it('moves a working partner by the same number of years, never before their current age', () => {
    const s = worker();
    s.people.push({ ...s.people[0], name: 'B', dateOfBirth: dobForAge(38), retirementAge: 58 });
    const moved = withRetirementAge(s, 55);
    expect(moved.people.map((p) => p.retirementAge)).toEqual([55, 53]);
    expect(withRetirementAge(s, 40).people[1].retirementAge).toBe(38);
    expect(s.people[0].retirementAge).toBe(60);   // input not mutated
  });
});

describe('what can I spend if I stop work at a given age', () => {
  it('quick max-spend search matches the hand calculation to within about 1% of planned spending', () => {
    // Stop at 55: 15 working years save (50k - S) each and 6 retired years cost S each.
    // 15 * (50k - S) >= 6S  =>  S <= 750k / 21 = £35,714.
    const steps = quickMaxSpendSteps(withRetirementAge(worker(), 55), zeroWorldConfig());
    let n = steps.next();
    while (!n.done) n = steps.next();
    const spend = n.value.value.annualSpendReal;
    expect(spend).toBeLessThanOrEqual(750_000 / 21 + 1e-6);
    expect(spend).toBeGreaterThan(750_000 / 21 - 0.01 * 30_000);
  });
});
