import type { Account, AccountType, Scenario } from '../../src/model/types';

export const START_DATE = '2026-04-06';

/** Person 0 born so they are exactly `age` on START_DATE. */
export function dobForAge(age: number): string {
  return `${2026 - age}-01-01`;
}

export function account(id: string, type: AccountType, balance: number, extra: Partial<Account> = {}): Account {
  const allocation = type === 'cash' ? { equities: 0, bonds: 0, cash: 1, property: 0 } : { equities: 0.6, bonds: 0.3, cash: 0.1, property: 0 };
  return { id, type, name: id, ownerIndex: 0, balance, allocation, annualFeePct: 0, ...extra };
}

/**
 * One retired person aged `startAge` with a single cash pot, fixedReal spending and
 * no State Pension (0 qualifying years). Horizon defaults to startAge + 30.
 */
export function cashOnlyScenario(opts: { startAge?: number; pot?: number; spend?: number; horizonYears?: number; runs?: number } = {}): Scenario {
  const startAge = opts.startAge ?? 60;
  return {
    people: [{ name: 'A', dateOfBirth: dobForAge(startAge), salary: 0, salaryGrowthRealPct: 0, retirementAge: startAge, niQualifyingYears: 0 }],
    accounts: [account('cash', 'cash', opts.pot ?? 1_000_000)],
    contributions: [],
    properties: [],
    incomeStreams: [],
    spending: [{ fromAge: 0, annualSpend: opts.spend ?? 40_000 }],
    strategy: { kind: 'fixedReal' },
    withdrawalOrder: ['cash', 'gia', 'isa', 'lisa', 'dcPension'],
    sim: { runs: opts.runs ?? 1, seed: 1, horizonAge: startAge + (opts.horizonYears ?? 30), startDate: START_DATE, stepsPerYear: 1, returnModel: 'lognormal', targetSuccessRate: 0.9 },
  };
}
