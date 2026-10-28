import { describe, it, expect } from 'vitest';
import { targetSpend, phaseSpend, grossUp, executeWithdrawals, householdNeed, type WithdrawalContext, type WithdrawalState } from '../../src/engine/withdrawal';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { account } from '../fixtures/testScenarios';
import type { Account, WithdrawalStrategy } from '../../src/model/types';

const cfg = TEST_CONFIG.tax['2026/27'];
const ts = (strategy: WithdrawalStrategy, extra: Partial<Parameters<typeof targetSpend>[0]> = {}) =>
  targetSpend({ strategy, phaseSpendToday: 30000, inflationIndex: 1.1, retired: true, portfolioAtStart: 1000000, prevInflation: 0.03, ...extra });

describe('spending phases', () => {
  it('phase in force is the last with fromAge <= age', () => {
    const s = [{ fromAge: 0, annualSpend: 28000 }, { fromAge: 60, annualSpend: 26000 }];
    expect(phaseSpend(s, 59)).toBe(28000);
    expect(phaseSpend(s, 60)).toBe(26000);
  });
});

describe('target spend strategies', () => {
  it('fixedReal = phase * index', () => expect(ts({ kind: 'fixedReal' })).toBeCloseTo(33000, 9));
  it('percentOfPortfolio = pct * portfolio', () => expect(ts({ kind: 'percentOfPortfolio', pct: 0.035 })).toBeCloseTo(35000, 9));
  it('before retirement every strategy uses the phase', () => expect(ts({ kind: 'percentOfPortfolio', pct: 0.035 }, { retired: false })).toBeCloseTo(33000, 9));
  it('floorCeiling clamps to inflated floor and ceiling', () => {
    expect(ts({ kind: 'floorCeiling', floor: 25000, ceiling: 50000, pct: 0.02 })).toBeCloseTo(27500, 9);
    expect(ts({ kind: 'floorCeiling', floor: 25000, ceiling: 50000, pct: 0.06 })).toBeCloseTo(55000, 9);
    expect(ts({ kind: 'floorCeiling', floor: 25000, ceiling: 50000, pct: 0.04 })).toBeCloseTo(40000, 9);
  });
  const g: WithdrawalStrategy = { kind: 'guardrails', initialPct: 0.04, upperGuard: 0.2, lowerGuard: 0.2, adjust: 0.1 };
  it('guardrails first year = initialPct * portfolio', () => expect(ts(g)).toBeCloseTo(40000, 9));
  it('guardrails inflates last year’s W when inside the guards', () => {
    expect(ts(g, { prevW: 40000, portfolioAtStart: 1000000 })).toBeCloseTo(41200, 9);
  });
  it('guardrails upper-guard breach cuts W', () => {
    // W = 41,200; rate 41,200/800,000 = 5.15% > 4.8% -> cut 10%
    expect(ts(g, { prevW: 40000, portfolioAtStart: 800000 })).toBeCloseTo(41200 * 0.9, 9);
  });
  it('guardrails lower-guard trigger raises W', () => {
    // W = 41,200; rate 41,200/1,400,000 = 2.94% < 3.2% -> raise 10%
    expect(ts(g, { prevW: 40000, portfolioAtStart: 1400000 })).toBeCloseTo(41200 * 1.1, 9);
  });
  it('household need adds outgoings and subtracts inflows', () => {
    expect(householdNeed({ targetSpend: 30000, mortgagePayments: 10000, mortgageLumpSums: 1, propertyCosts: 2000, otherOutgoings: 0, taxes: 5000, contributionsFromTakeHome: 3000, inflows: 40000 })).toBe(10001);
  });
});

describe('grossUp', () => {
  it('converges within tolerance', () => {
    const r = grossUp((x) => x * 0.8, 800, 10000);
    expect(Math.abs(r.net - 800)).toBeLessThanOrEqual(1);
  });
  it('never exceeds the balance', () => {
    const r = grossUp((x) => x * 0.8, 800, 500);
    expect(r.gross).toBe(500);
  });
});

function ctx(accounts: Account[], age: number, nonSavings = 0): WithdrawalContext {
  return {
    accounts,
    order: ['cash', 'gia', 'isa', 'lisa', 'dcPension'],
    cfg,
    people: [{ age, income: { nonSavings, savings: 0, dividends: 0 }, basicBandExtension: 0 }],
    pensionAccessAge: accounts.map((a) => (a.type === 'dcPension' ? 57 : NaN)),
  };
}
const st = (accounts: Account[]): WithdrawalState => ({
  balances: accounts.map((a) => a.balance),
  giaBasis: accounts.map((a) => a.giaCostBasis ?? a.balance),
  lsaUsed: [0],
  mpaaTriggered: [false],
});

describe('executeWithdrawals', () => {
  it('a locked pension is never drawn; ISA bridges until it unlocks', () => {
    const accs = [account('c', 'cash', 0), account('i', 'isa', 100000), account('p', 'dcPension', 500000)];
    const locked = executeWithdrawals(ctx(accs, 55), 30000, st(accs));
    expect(locked.net.dcPension).toBe(0);
    expect(locked.net.isa).toBe(30000);
    const short = executeWithdrawals(ctx(accs, 56), 150000, st(accs));
    expect(short.gross.dcPension).toBe(0);
    expect(short.unmet).toBeCloseTo(50000, 6);
    const open = executeWithdrawals(ctx([accs[0], account('i', 'isa', 0), accs[2]], 57), 30000, st([accs[0], account('i', 'isa', 0), accs[2]]));
    expect(open.net.dcPension).toBeCloseTo(30000, 0);
  });
  it('splits need across accounts of a type in proportion to balance', () => {
    const accs = [account('c1', 'cash', 30000), account('c2', 'cash', 10000)];
    const r = executeWithdrawals(ctx(accs, 60), 20000, st(accs));
    expect(r.state.balances).toEqual([15000, 5000]);
  });
  it('moves an unmet part to the next account type', () => {
    const accs = [account('c', 'cash', 5000), account('i', 'isa', 50000)];
    const r = executeWithdrawals(ctx(accs, 60), 20000, st(accs));
    expect(r.net.cash).toBe(5000);
    expect(r.net.isa).toBe(15000);
    expect(r.unmet).toBe(0);
  });
  it('GIA gains are re-priced when later pension draws push income into the higher rate', () => {
    const accs = [account('c', 'cash', 0), account('g', 'gia', 40000, { giaCostBasis: 20000 }), account('p', 'dcPension', 400000)];
    const r = executeWithdrawals(ctx(accs, 60, 30000), 80000, st(accs));
    // Whole GIA sold (gain 20,000); the pension's taxable part fills the basic band, so the
    // gain above the 3,000 exemption is taxed at 24%.
    expect(r.gross.gia).toBeCloseTo(40000, 6);
    expect(r.cgt).toBeCloseTo((20000 - 3000) * 0.24, 0);
    expect(r.unmet).toBeLessThanOrEqual(1);
  });
  it('GIA CGT uses the cost basis and the basis falls proportionally', () => {
    const accs = [account('c', 'cash', 0), account('g', 'gia', 100000, { giaCostBasis: 50000 })];
    const s = st(accs);
    const r = executeWithdrawals(ctx(accs, 60, 50000), 20000, s);
    // gain fraction 50%; other taxable income 37,430 -> 270 basic band left
    const sold = r.gross.gia;
    const gain = sold * 0.5;
    const expectedCgt = 270 * 0.18 + (gain - 3000 - 270) * 0.24;
    expect(r.cgt).toBeCloseTo(expectedCgt, 6);
    expect(Math.abs(r.net.gia - 20000)).toBeLessThanOrEqual(1);
    expect(r.state.giaBasis[1]).toBeCloseTo(50000 * (1 - sold / 100000), 6);
    expect(s.balances[1]).toBe(100000); // input not mutated
  });
  it('pension draw triggers the MPAA, uses tax-free cash and grosses up for tax', () => {
    const accs = [account('c', 'cash', 0), account('p', 'dcPension', 500000)];
    const r = executeWithdrawals(ctx(accs, 60, 20000), 20000, st(accs));
    expect(r.state.mpaaTriggered[0]).toBe(true);
    expect(r.taxFree).toBeCloseTo(r.gross.dcPension * 0.25, 6);
    expect(r.state.lsaUsed[0]).toBeCloseTo(r.taxFree, 6);
    expect(r.pensionTax).toBeCloseTo(r.gross.dcPension * 0.75 * 0.2, 0);
    expect(Math.abs(r.net.dcPension - 20000)).toBeLessThanOrEqual(1);
  });
});
