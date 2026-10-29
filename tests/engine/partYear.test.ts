import { describe, it, expect } from 'vitest';
import { monthsLeftInTaxYear, simulate } from '../../src/engine/simulate';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

/** Age 40, £60k salary, £20k spending, £100k cash, starting on `startDate`. */
function worker(startDate: string): Scenario {
  const s = cashOnlyScenario({ startAge: 40, pot: 100_000, spend: 20_000, horizonYears: 5 });
  s.people[0] = { ...s.people[0], dateOfBirth: `${Number(startDate.slice(0, 4)) - 40}-01-01`, salary: 60_000, retirementAge: 67 };
  s.sim = { ...s.sim, startDate };
  return s;
}
const firstRow = (startDate: string) => simulate(worker(startDate), TEST_CONFIG, { runsOverride: 1 }).centralCase[0];

describe('the first tax year counts only the months left in it', () => {
  it('counts the whole months to the next 6 April', () => {
    expect(monthsLeftInTaxYear('2026-04-06')).toBe(12);
    expect(monthsLeftInTaxYear('2026-10-06')).toBe(6);
    expect(monthsLeftInTaxYear('2026-10-29')).toBe(5);
    expect(monthsLeftInTaxYear('2027-04-05')).toBe(1);
  });
  it('salary, spending and tax are that share of a full year', () => {
    const full = firstRow('2026-04-06');
    const half = firstRow('2026-10-06');
    expect(half.salary).toBeCloseTo(full.salary / 2, 6);
    expect(half.spending).toBeCloseTo(full.spending / 2, 6);
    // Allowances are scaled too, so tax and NI halve rather than falling into a full year's allowances.
    expect(half.taxPaid).toBeCloseTo(full.taxPaid / 2, 0);
    expect(half.niPaid).toBeCloseTo(full.niPaid / 2, 0);
  });
  it('monthly steps agree with annual steps on the part year', () => {
    const annual = firstRow('2026-10-06');
    const s = worker('2026-10-06');
    s.sim.stepsPerYear = 12;
    const monthly = simulate(s, TEST_CONFIG, { runsOverride: 1 }).centralCase[0];
    expect(monthly.salary).toBeCloseTo(annual.salary, 6);
    // Monthly flows spread over the months rather than all at the start, so allow a small timing difference.
    expect(Math.abs(monthly.portfolioEnd / annual.portfolioEnd - 1)).toBeLessThan(0.002);
  });
});
