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
