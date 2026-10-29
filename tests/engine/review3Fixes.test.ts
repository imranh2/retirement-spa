import { describe, it, expect } from 'vitest';
import { earliestRetirementAgeSteps, simulate } from '../../src/engine/simulate';
import { withRetirementAge } from '../../src/model/retirement';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario, dobForAge } from '../fixtures/testScenarios';
import type { Scenario } from '../../src/model/types';

const rows = (s: Scenario, cfg = zeroWorldConfig()) => simulate(s, cfg, { runsOverride: 1 }).centralCase;

describe('review 3 fixes', () => {
  it('a stop-work age already passed counts as now when moving a couple’s stop-work ages', () => {
    const s = cashOnlyScenario({ startAge: 55, pot: 0, spend: 20_000, horizonYears: 20 });
    s.people[0] = { ...s.people[0], salary: 1, retirementAge: 45 };
    s.people.push({ name: 'B', dateOfBirth: dobForAge(55), salary: 60_000, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 0 });
    expect(withRetirementAge(s, 56).people[1].retirementAge).toBe(61);
    // The search no longer says "now" for a plan that fails.
    const steps = earliestRetirementAgeSteps(s, zeroWorldConfig());
    let n = steps.next();
    while (!n.done) n = steps.next();
    expect(n.value.status).not.toBe('now');
  });

  it('thresholds uprate by whole years after a part first year', () => {
    const cfg = zeroWorldConfig();
    cfg.tax['2026/27'].incomeTaxBands = [{ upTo: 37_700, rate: 0.2 }, { upTo: null, rate: 0.4 }];
    cfg.taxProjection = { thresholdsFrozenThroughTaxYear: '2026/27', upratingAfterFreeze: 'inflation', upratedItems: ['personalAllowance'] };
    cfg.market.inflation = { mean: 0.025, vol: 0, floor: -0.02 };
    const make = (startDate: string) => {
      // No savings and spare pay spent, so the only tax is income tax on the salary.
      const s = cashOnlyScenario({ startAge: 40, pot: 0, spend: 10_000, horizonYears: 4 });
      s.people[0] = { ...s.people[0], dateOfBirth: `${Number(startDate.slice(0, 4)) - 40}-01-01`, salary: 30_000, retirementAge: 60, salaryInflationLinked: false };
      s.sim = { ...s.sim, startDate };
      s.surplus = { kind: 'spend' };
      return rows(s, cfg);
    };
    const full = make('2026-04-06');
    const part = make('2026-10-06');
    // 2027/28 tax (second row) is the same whether the plan started on 6 April or in October.
    expect(part[1].taxPaid * part[1].priceIndex!).toBeCloseTo(full[1].taxPaid * full[1].priceIndex!, 0);
    expect(full[1].taxPaid * full[1].priceIndex!).toBeCloseTo((30_000 - 12_570 * 1.025) * 0.2, 0);
  });

  it('years before the first defined tax year use its rules without uprating', () => {
    const cfg = zeroWorldConfig();
    cfg.tax['2026/27'].incomeTaxBands = [{ upTo: 37_700, rate: 0.2 }, { upTo: null, rate: 0.4 }];
    cfg.taxProjection = { thresholdsFrozenThroughTaxYear: '2020/21', upratingAfterFreeze: 'inflation', upratedItems: ['personalAllowance'] };
    cfg.market.inflation = { mean: 0.025, vol: 0, floor: -0.02 };
    const s = cashOnlyScenario({ startAge: 40, pot: 0, spend: 10_000, horizonYears: 4 });
    s.people[0] = { ...s.people[0], dateOfBirth: '1984-01-01', salary: 30_000, retirementAge: 60, salaryInflationLinked: false };
    s.sim = { ...s.sim, startDate: '2024-04-06' };
    s.surplus = { kind: 'spend' };
    const r = rows(s, cfg);
    const tax = r.map((x) => x.taxPaid * x.priceIndex!);
    expect(tax[1]).toBeCloseTo(tax[0], 0);        // 2025/26: same as 2024/25 (frozen at the defined rules)
    expect(tax[3]).toBeLessThan(tax[2]);           // 2027/28 onwards: uprated from 2026/27
  });

  it('a LISA goes towards the deposit only, not stamp duty or fees', () => {
    const s = cashOnlyScenario({ startAge: 35, pot: 500_000, spend: 10_000, horizonYears: 5 });
    s.accounts.push(account('lisa', 'lisa', 60_000));
    s.withdrawalOrder = ['cash', 'lisa'];
    s.properties = [{ id: 'h', name: 'Home', value: 400_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0, buyAtAge: 37, depositPct: 0.1, buyingCosts: 3_000, firstTimeBuyer: true,
      mortgage: { balance: 0, type: 'repayment', rate: 0.05, fixedYearsRemaining: 0, reversionRate: 0.05, termYearsRemaining: 25, monthlyOverpayment: 0 } }];
    expect(rows(s)[2].drawLisa).toBeCloseTo(40_000, 6);
  });

  it('a yearly pay rise counts a part first year as its fraction', () => {
    const cfg = zeroWorldConfig();
    const s = cashOnlyScenario({ startAge: 40, pot: 100_000, spend: 0, horizonYears: 3 });
    s.people[0] = { ...s.people[0], dateOfBirth: '1986-01-01', salary: 100_000, salaryGrowthRealPct: 0.1, retirementAge: 60 };
    s.sim = { ...s.sim, startDate: '2027-03-06' };   // one month of the first tax year
    const r = rows(s, cfg);
    expect(r[1].salary).toBeCloseTo(100_000 * 1.1 ** (1 / 12), 0);
  });

  it('validation: a tiny mortgage term, an age over 120 and a pension access age of 0 are rejected', () => {
    const s = cashOnlyScenario({ startAge: 60 });
    s.properties = [{ id: 'h', name: 'Home', value: 300_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0,
      mortgage: { balance: 100_000, type: 'repayment', rate: 0.05, fixedYearsRemaining: 0, reversionRate: 0.05, termYearsRemaining: 0.001, monthlyOverpayment: 0 } }];
    s.people.push({ name: 'B', dateOfBirth: '1900-01-01', salary: 0, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 0 });
    s.accounts.push(account('pen', 'dcPension', 1000, { pensionAccessAge: 0 }));
    const paths = validateScenario(s, TEST_CONFIG).map((i) => i.path);
    expect(paths).toContain('properties[0].mortgage.termYearsRemaining');
    expect(paths).toContain('people[1].dateOfBirth');
    expect(paths).toContain('accounts[1].pensionAccessAge');
  });
});
