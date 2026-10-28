import { describe, it, expect } from 'vitest';
import { planContributions, contributionAmount, grossSalary } from '../../src/engine/contributions';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { account } from '../fixtures/testScenarios';
import type { Contribution, Person } from '../../src/model/types';

const cfg = TEST_CONFIG.tax['2026/27'];
const person: Person = { name: 'P', dateOfBirth: '1990-01-01', salary: 50000, salaryGrowthRealPct: 0.01, retirementAge: 60, niQualifyingYears: 10 };
const c = (id: string, accountId: string, type: Contribution['type'], amount: number, extra: Partial<Contribution> = {}): Contribution =>
  ({ id, accountId, personIndex: 0, type, amount, startAge: 0, endAge: 100, escalatesWithInflation: false, ...extra });

describe('contribution amounts', () => {
  it('salary grows with real growth and inflation; stops at retirement', () => {
    expect(grossSalary(person, 40, 2, 1.1)).toBeCloseTo(50000 * 1.01 ** 2 * 1.1, 6);
    expect(grossSalary(person, 60, 2, 1.1)).toBe(0);
  });
  it('fixed monthly x12, escalation, lump sum only at start age, nothing after retirement', () => {
    expect(contributionAmount(c('a', 'x', 'fixedMonthly', 100), person, 40, 0, 1.2)).toBe(1200);
    expect(contributionAmount(c('a', 'x', 'fixedMonthly', 100, { escalatesWithInflation: true }), person, 40, 0, 1.2)).toBeCloseTo(1440, 9);
    expect(contributionAmount(c('a', 'x', 'lumpSum', 5000, { startAge: 40 }), person, 40, 0, 1)).toBe(5000);
    expect(contributionAmount(c('a', 'x', 'lumpSum', 5000, { startAge: 40 }), person, 41, 0, 1)).toBe(0);
    expect(contributionAmount(c('a', 'x', 'fixedMonthly', 100), person, 60, 0, 1)).toBe(0);
  });
});

describe('planContributions', () => {
  const accounts = [account('cash', 'cash', 0), account('isa', 'isa', 0), account('gia', 'gia', 0), account('lisa', 'lisa', 0), account('pen', 'dcPension', 0)];
  const py = (age: number, salary = 50000, mpaa = false) => [{ age, grossSalary: salary, mpaaTriggered: mpaa }];

  it('ISA cap enforced; overflow goes to the same person’s GIA', () => {
    const p = planContributions([c('i', 'isa', 'fixedMonthly', 2000)], accounts, [person], py(36), 0, 1, cfg);
    expect(p.credits[1]).toBe(20000);
    expect(p.credits[2]).toBe(4000);
    expect(p.isaOverflow).toBe(true);
    expect(p.fromTakeHome).toBe(24000);
  });
  it('overflow goes to cash when there is no GIA', () => {
    const noGia = accounts.filter((a) => a.type !== 'gia');
    const p = planContributions([c('i', 'isa', 'lumpSum', 25000)], noGia, [person], py(0), 0, 1, cfg);
    expect(p.credits[0]).toBe(5000);
  });
  it('LISA bonus is added; LISA counts towards the ISA allowance; stops at max contribution age', () => {
    const p = planContributions([c('l', 'lisa', 'fixedMonthly', 500), c('i', 'isa', 'fixedMonthly', 2000)], accounts, [person], py(36), 0, 1, cfg);
    expect(p.credits[3]).toBeCloseTo(4000 * 1.25, 9);
    expect(p.credits[1]).toBe(16000);
    expect(p.credits[2]).toBe(2000 + 8000);   // LISA excess 2,000 + ISA excess 8,000
    const late = planContributions([c('l', 'lisa', 'fixedMonthly', 100)], accounts, [person], py(50), 0, 1, cfg);
    expect(late.credits[3]).toBe(0);
    expect(late.lisaIneligible).toBe(true);
  });
  it('LISA: no payments under the minimum age; they are saved in the GIA without the bonus', () => {
    const young = planContributions([c('l', 'lisa', 'fixedMonthly', 100)], accounts, [person], py(17), 0, 1, cfg, accounts.map(() => false));
    expect(young.credits[3]).toBe(0);
    expect(young.credits[2]).toBe(1200);
    expect(young.lisaIneligible).toBe(true);
    expect(young.lisaOpened).toEqual([]);
  });
  it('LISA: an empty LISA opens with its first payment at or before the latest opening age, not after', () => {
    const closed = accounts.map(() => false);
    const at39 = planContributions([c('l', 'lisa', 'fixedMonthly', 100)], accounts, [person], py(39), 0, 1, cfg, closed);
    expect(at39.credits[3]).toBeCloseTo(1500, 9);
    expect(at39.lisaOpened).toEqual([3]);
    const at40 = planContributions([c('l', 'lisa', 'fixedMonthly', 100)], accounts, [person], py(40), 0, 1, cfg, closed);
    expect(at40.credits[3]).toBe(0);
    expect(at40.lisaIneligible).toBe(true);
    const openAt40 = planContributions([c('l', 'lisa', 'fixedMonthly', 100)], accounts, [person], py(40), 0, 1, cfg, accounts.map((a) => a.type === 'lisa'));
    expect(openAt40.credits[3]).toBeCloseTo(1500, 9);
    expect(openAt40.lisaIneligible).toBe(false);
  });
  it('pension: net pay reduces taxable pay; employer is not from take-home; relief at source costs 80%', () => {
    const p = planContributions([c('e', 'pen', 'pctOfSalary', 0.1), c('r', 'pen', 'employerPctOfSalary', 0.05)], accounts, [person], py(36), 0, 1, cfg);
    expect(p.credits[4]).toBeCloseTo(7500, 9);
    expect(p.netPayGross[0]).toBeCloseTo(5000, 9);
    expect(p.fromTakeHome).toBeCloseTo(5000, 9);
    const ras = accounts.map((a) => (a.id === 'pen' ? { ...a, pensionReliefMethod: 'reliefAtSource' as const } : a));
    const q = planContributions([c('e', 'pen', 'pctOfSalary', 0.1)], ras, [person], py(36), 0, 1, cfg);
    expect(q.reliefAtSourceGross[0]).toBeCloseTo(5000, 9);
    expect(q.fromTakeHome).toBeCloseTo(4000, 9);
  });
  it('pension annual allowance and MPAA caps', () => {
    const p = planContributions([c('e', 'pen', 'lumpSum', 80000)], accounts, [person], py(0, 200000), 0, 1, cfg);
    expect(p.credits[4]).toBeCloseTo(60000, 9);
    expect(p.pensionCapped).toBe(true);
    const m = planContributions([c('e', 'pen', 'lumpSum', 20000)], accounts, [person], py(0, 200000, true), 0, 1, cfg);
    expect(m.credits[4]).toBeCloseTo(10000, 9);
  });
  it('a non-earner can pay 2,880 net (3,600 gross) into a relief-at-source pension, but not by net pay', () => {
    const ras = accounts.map((a) => (a.id === 'pen' ? { ...a, pensionReliefMethod: 'reliefAtSource' as const } : a));
    const p = planContributions([c('e', 'pen', 'fixedMonthly', 300)], ras, [person], py(36, 0), 0, 1, cfg);
    expect(p.credits[4]).toBeCloseTo(3600, 9);
    expect(p.fromTakeHome).toBeCloseTo(2880, 9);
    expect(p.pensionCapped).toBe(false);
    const netPay = planContributions([c('e', 'pen', 'fixedMonthly', 300)], accounts, [person], py(36, 0), 0, 1, cfg);
    expect(netPay.credits[4]).toBe(0);
    expect(netPay.pensionCapped).toBe(true);
  });
  it('a high income tapers the annual allowance, counting other income and employer contributions', () => {
    // Salary 300k + employer 20k = adjusted income 320k: allowance 60k - 30k = 30k.
    const p = planContributions([c('e', 'pen', 'lumpSum', 40000), c('r', 'pen', 'employerPctOfSalary', 20000 / 300000)], accounts, [person], py(0, 300000), 0, 1, cfg);
    expect(p.credits[4]).toBeCloseTo(30000, 6);
    expect(p.allowanceTapered).toBe(true);
    // 250k salary alone is under the adjusted limit; 30k of rent pushes it over: 60k - (280k + 0 - 260k)/2 = 50k.
    const q = planContributions([c('e', 'pen', 'lumpSum', 55000)], accounts, [person], [{ age: 0, grossSalary: 250000, mpaaTriggered: false }], 0, 1, cfg);
    expect(q.credits[4]).toBeCloseTo(55000, 6);
    const r = planContributions([c('e', 'pen', 'lumpSum', 55000)], accounts, [person], [{ age: 0, grossSalary: 250000, mpaaTriggered: false, otherTaxableIncome: 30000 }], 0, 1, cfg);
    expect(r.credits[4]).toBeCloseTo(50000, 6);
    expect(r.allowanceTapered).toBe(true);
  });
});

describe('when contributions stop', () => {
  const person = { name: 'A', dateOfBirth: '1980-01-01', salary: 50_000, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 0 };
  const monthly = (extra: Partial<Contribution>): Contribution => ({ id: 'c', accountId: 'isa', personIndex: 0, type: 'fixedMonthly', amount: 100, startAge: 30, endAge: 65, escalatesWithInflation: false, ...extra });
  const paidAt = (c: Contribution, age: number) => contributionAmount(c, person, age, 50_000, 1);
  it('by default (old saved plans): at the end age or on stopping work, whichever is first', () => {
    expect(paidAt(monthly({}), 59)).toBe(1_200);
    expect(paidAt(monthly({}), 60)).toBe(0);
    expect(paidAt(monthly({ endAge: 50 }), 55)).toBe(0);
  });
  it("'work': on stopping work, whatever the end age says", () => {
    expect(paidAt(monthly({ stopsWith: 'work', endAge: 40 }), 55)).toBe(1_200);
    expect(paidAt(monthly({ stopsWith: 'work', endAge: 40 }), 60)).toBe(0);
  });
  it("'ageEvenAfterWork': carries on after stopping work until the end age", () => {
    expect(paidAt(monthly({ stopsWith: 'ageEvenAfterWork' }), 62)).toBe(1_200);
    expect(paidAt(monthly({ stopsWith: 'ageEvenAfterWork' }), 65)).toBe(0);
    expect(paidAt(monthly({ stopsWith: 'ageEvenAfterWork', type: 'lumpSum', amount: 5_000, startAge: 62 }), 62)).toBe(5_000);
  });
});
