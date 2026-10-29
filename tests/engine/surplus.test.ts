import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Scenario, SurplusRule } from '../../src/model/types';
import type { ConfigBundle } from '../../src/config/configTypes';

/** Age 40, earning `salary`, spending £30k, empty cash/ISA/GIA, plan for 3 years. */
function earner(salary: number, surplus?: SurplusRule): Scenario {
  const s = cashOnlyScenario({ startAge: 40, pot: 0, spend: 30_000, horizonYears: 3 });
  s.people[0] = { ...s.people[0], salary, retirementAge: 60 };
  s.accounts.push(account('isa', 'isa', 0, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
  s.accounts.push(account('gia', 'gia', 0, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
  s.surplus = surplus;
  return s;
}
const run = (s: Scenario, cfg: ConfigBundle = zeroWorldConfig()) => simulate(s, cfg, { deterministic: true }).centralCase;

describe('spare income', () => {
  it('is kept as cash by default and shown in the table', () => {
    const rows = run(earner(50_000));
    expect(rows[0].spareIncome).toBeCloseTo(20_000, 6);
    expect(rows.map((r) => r.portfolioEnd)).toEqual([20_000, 40_000, 60_000].map((v) => expect.closeTo(v, 6)));
  });
  it('can be treated as spent, so nothing builds up', () => {
    const rows = run(earner(50_000, { kind: 'spend' }));
    expect(rows[0].spareIncome).toBeCloseTo(20_000, 6);
    expect(rows.every((r) => r.portfolioEnd === 0)).toBe(true);
  });
  it('can be invested in an ISA up to the allowance, with the rest going to the owner’s GIA', () => {
    // £30k spare: £20k fills the ISA allowance, £10k overflows to the GIA.
    const s = earner(60_000, { kind: 'invest', accountId: 'isa' });
    const r = simulate(s, zeroWorldConfig(), { deterministic: true });
    expect(r.centralCase[0].portfolioEnd).toBeCloseTo(30_000, 6);
    expect(r.warnings.some((w) => /ISA/.test(w))).toBe(true);
    // The allowance left after the person's own ISA contributions is what spare income can use.
    const withContribution = earner(60_000, { kind: 'invest', accountId: 'isa' });
    withContribution.contributions = [{ id: 'c', accountId: 'isa', personIndex: 0, type: 'fixedMonthly', amount: 1_000, startAge: 0, endAge: 99, escalatesWithInflation: false }];
    const row = run(withContribution)[0];
    expect(row.savedFromPay).toBeCloseTo(12_000, 6);
    expect(row.spareIncome).toBeCloseTo(18_000, 6);
  });
  it('gives the same answer with monthly steps', () => {
    for (const rule of [undefined, { kind: 'spend' as const }, { kind: 'invest' as const, accountId: 'isa' }]) {
      const s = earner(60_000, rule);
      const annual = run(s);
      const monthly = run({ ...s, sim: { ...s.sim, stepsPerYear: 12 } });
      monthly.forEach((row, t) => {
        expect(row.portfolioEnd).toBeCloseTo(annual[t].portfolioEnd, 4);
        expect(row.spareIncome ?? 0).toBeCloseTo(annual[t].spareIncome ?? 0, 4);
      });
    }
  });
  it('makes each row of the central case add up when tax and interest are switched on', () => {
    const cfg = structuredClone(TEST_CONFIG);
    for (const k of ['equities', 'bonds', 'cash', 'property'] as const) cfg.market[k].vol = 0;
    cfg.market.inflation.vol = 0;
    const s = earner(156_000);
    s.contributions = [{ id: 'c', accountId: 'isa', personIndex: 0, type: 'fixedMonthly', amount: 1_000, startAge: 0, endAge: 99, escalatesWithInflation: true }];
    for (const r of run(s, cfg)) {
      const outgoings = r.spending + r.mortgagePayments + r.propertyCosts + r.taxPaid + r.niPaid + (r.savedFromPay ?? 0) + (r.spareIncome ?? 0);
      expect(outgoings).toBeCloseTo(r.salary, 4);
    }
  });
  it('only accepts a cash account, GIA or ISA as the destination', () => {
    const s = earner(50_000, { kind: 'invest', accountId: 'pension' });
    s.accounts.push(account('pension', 'dcPension', 0));
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('surplus');
    expect(validateScenario(earner(50_000, { kind: 'invest', accountId: 'missing' }), TEST_CONFIG).map((i) => i.path)).toContain('surplus');
  });
});

describe('contributions after stopping work', () => {
  it('are paid from savings when set to carry on, and the stop-work default follows a later retirement', () => {
    const s = cashOnlyScenario({ startAge: 58, pot: 100_000, spend: 0, horizonYears: 4 });
    s.people[0] = { ...s.people[0], salary: 40_000, retirementAge: 60 };
    s.accounts.push(account('isa', 'isa', 0, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
    s.surplus = { kind: 'spend' };
    const isaTopUp = { id: 'c', accountId: 'isa', personIndex: 0, type: 'fixedMonthly' as const, amount: 1_000, startAge: 0, endAge: 62, escalatesWithInflation: false };
    s.contributions = [{ ...isaTopUp, stopsWith: 'ageEvenAfterWork' }];
    const rows = run(s);
    expect(rows.map((r) => r.savedFromPay)).toEqual([12_000, 12_000, 12_000, 12_000].map((v) => expect.closeTo(v, 6)));
    expect(rows[2].drawCash).toBeCloseTo(12_000, 6);   // after stopping work, the payments come out of cash
    // 'work' ignores the end age, so working to 61 keeps paying in at 60.
    const later = { ...s, people: [{ ...s.people[0], retirementAge: 61 }], contributions: [{ ...isaTopUp, endAge: 60, stopsWith: 'work' as const }] };
    expect(run(later).map((r) => r.savedFromPay)).toEqual([12_000, 12_000, 12_000, 0].map((v) => expect.closeTo(v, 6)));
  });
});

describe('one-off lump sums from outside money', () => {
  const lump = (accountId: string, amount: number, startAge: number, source?: 'pay' | 'external') =>
    ({ id: 'l', accountId, personIndex: 0, type: 'lumpSum' as const, amount, startAge, endAge: startAge + 1, escalatesWithInflation: false, source });

  it('adds to the account without coming out of income or other accounts, even after stopping work', () => {
    // Retired at 60, with £100k cash; an inheritance of £15k arrives into the ISA at 61.
    const s = cashOnlyScenario({ startAge: 60, pot: 100_000, spend: 0, horizonYears: 3 });
    s.accounts.push(account('isa', 'isa', 0, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } }));
    s.contributions = [lump('isa', 15_000, 61, 'external')];
    const rows = run(s);
    expect(rows[1].savedFromPay).toBe(0);
    expect(rows[1].drawCash).toBe(0);
    expect(rows.map((r) => r.portfolioEnd)).toEqual([100_000, 115_000, 115_000].map((v) => expect.closeTo(v, 6)));
    // Paid from savings instead, the same lump sum is not made at all once retired (the default rule).
    const fromPay = { ...s, contributions: [lump('isa', 15_000, 61, 'pay')] };
    expect(run(fromPay)[1].portfolioEnd).toBeCloseTo(100_000, 6);
  });

  it('still respects the ISA allowance: the excess goes to the GIA', () => {
    const s = earner(30_000, { kind: 'spend' });
    s.contributions = [lump('isa', 30_000, 40, 'external')];
    const row = run(s)[0];
    expect(row.portfolioEnd).toBeCloseTo(30_000, 6);
    expect(row.savedFromPay).toBe(0);
  });

  it('into a relief-at-source pension: gets the relief, counts towards the caps, costs no take-home pay', () => {
    const s = earner(50_000, { kind: 'spend' });
    s.accounts.push(account('sipp', 'dcPension', 0, { allocation: { equities: 0, bonds: 0, cash: 1, property: 0 }, pensionReliefMethod: 'reliefAtSource' }));
    s.contributions = [lump('sipp', 8_000, 40, 'external')];
    const row = run(s)[0];
    expect(row.portfolioEnd).toBeCloseTo(8_000, 6);           // gross amount reaches the pot
    expect(row.savedFromPay).toBe(0);
    s.contributions = [lump('sipp', 80_000, 40, 'external')];
    expect(run(s)[0].portfolioEnd).toBeCloseTo(50_000, 6);     // capped at 100% of earnings
  });

  it('is rejected for net pay pensions and for anything but a lump sum', () => {
    const s = earner(50_000);
    s.accounts.push(account('pen', 'dcPension', 0));
    s.contributions = [lump('pen', 5_000, 40, 'external')];
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('contributions[0].source');
    s.contributions = [{ ...lump('isa', 100, 40, 'external'), type: 'fixedMonthly' }];
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('contributions[0].source');
  });
});

describe('one-off payments at a past age', () => {
  it('are flagged, since they would never be paid', () => {
    const s = cashOnlyScenario({ startAge: 40 });
    s.contributions = [{ id: 'l', accountId: 'cash', personIndex: 0, type: 'lumpSum', amount: 1000, startAge: 39, endAge: 120, escalatesWithInflation: false, source: 'external' }];
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('contributions[0].startAge');
    s.contributions[0].startAge = 40;
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).not.toContain('contributions[0].startAge');
  });
});

describe('one-off payments arrive at the end of the tax year', () => {
  it('so they earn nothing in the year they arrive (annual and monthly steps)', () => {
    // £10k cash earning 10%, plus £1,000 of outside money this year: £10k × 1.1 + £1,000, not £11k × 1.1.
    const cfg = zeroWorldConfig();
    cfg.market.cash = { meanReal: 0.10, vol: 0 };
    for (const stepsPerYear of [1, 12] as const) {
      const s = cashOnlyScenario({ startAge: 40, pot: 10_000, spend: 0, horizonYears: 2 });
      s.sim.stepsPerYear = stepsPerYear;
      s.contributions = [{ id: 'l', accountId: 'cash', personIndex: 0, type: 'lumpSum', amount: 1000, startAge: 40, endAge: 120, escalatesWithInflation: false, source: 'external' }];
      const rows = simulate(s, cfg, { runsOverride: 1 }).centralCase;
      expect(rows[0].portfolioEnd).toBeCloseTo(10_000 * 1.1 + 1000, 4);
      expect(rows[1].portfolioEnd).toBeCloseTo((10_000 * 1.1 + 1000) * 1.1, 4);
    }
  });
});
