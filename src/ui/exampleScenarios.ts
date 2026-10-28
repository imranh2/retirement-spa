import type { AssetAllocation, Scenario } from '../model/types';
import { addYears, todayIso } from '../model/dates';

const GROWTH: AssetAllocation = { equities: 0.8, bonds: 0.15, cash: 0.05, property: 0 };
const BALANCED: AssetAllocation = { equities: 0.6, bonds: 0.3, cash: 0.1, property: 0 };
const CASH: AssetAllocation = { equities: 0, bonds: 0, cash: 1, property: 0 };

export interface ExampleScenario { id: string; name: string; description: string; scenario: Scenario }

function sim(startDate: string): Scenario['sim'] {
  return { runs: 5000, seed: 20261027, horizonAge: 95, startDate, stepsPerYear: 1, returnModel: 'lognormal', targetSuccessRate: 0.9 };
}

/** The three example scenarios, starting on `startDate`. */
export function buildExamples(startDate: string = todayIso()): ExampleScenario[] {
  return [
    {
      id: 'early-retiree',
      name: 'Early retiree at 50 with ISA bridge',
      description: 'One person retiring at 50, living on cash, GIA and ISA until the pension unlocks at 57.',
      scenario: {
        people: [{ name: 'Alex', dateOfBirth: '1976-01-01', salary: 0, salaryGrowthRealPct: 0, retirementAge: 50, niQualifyingYears: 25 }],
        accounts: [
          { id: 'cash', type: 'cash', name: 'Cash savings', ownerIndex: 0, balance: 30000, allocation: CASH, annualFeePct: 0 },
          { id: 'isa', type: 'isa', name: 'Stocks & shares ISA', ownerIndex: 0, balance: 450000, allocation: GROWTH, annualFeePct: 0.003 },
          { id: 'gia', type: 'gia', name: 'General investment account', ownerIndex: 0, balance: 120000, allocation: GROWTH, annualFeePct: 0.003, giaCostBasis: 80000 },
          { id: 'pension', type: 'dcPension', name: 'Workplace pension', ownerIndex: 0, balance: 400000, allocation: GROWTH, annualFeePct: 0.004, pensionAccessAge: 57, pensionReliefMethod: 'netPay' },
        ],
        contributions: [],
        properties: [],
        incomeStreams: [],
        spending: [{ fromAge: 50, annualSpend: 30000 }],
        strategy: { kind: 'fixedReal' },
        withdrawalOrder: ['cash', 'gia', 'isa', 'dcPension'],
        sim: sim(startDate),
      },
    },
    {
      id: 'couple-mortgage',
      name: 'Couple with mortgage retiring at 60',
      description: 'Two earners saving into pensions and ISAs, paying off a mortgage, using guardrails in retirement.',
      scenario: {
        people: [
          { name: 'Sam', dateOfBirth: '1972-01-01', salary: 60000, salaryGrowthRealPct: 0.005, retirementAge: 60, niQualifyingYears: 28 },
          { name: 'Jo', dateOfBirth: '1974-01-01', salary: 35000, salaryGrowthRealPct: 0.005, retirementAge: 60, niQualifyingYears: 30 },
        ],
        accounts: [
          { id: 'cash', type: 'cash', name: 'Joint cash', ownerIndex: 0, balance: 25000, allocation: CASH, annualFeePct: 0 },
          { id: 'isa-sam', type: 'isa', name: 'Sam ISA', ownerIndex: 0, balance: 80000, allocation: BALANCED, annualFeePct: 0.003 },
          { id: 'isa-jo', type: 'isa', name: 'Jo ISA', ownerIndex: 1, balance: 80000, allocation: BALANCED, annualFeePct: 0.003 },
          { id: 'pen-sam', type: 'dcPension', name: 'Sam pension', ownerIndex: 0, balance: 250000, allocation: GROWTH, annualFeePct: 0.004, pensionReliefMethod: 'netPay' },
          { id: 'pen-jo', type: 'dcPension', name: 'Jo pension', ownerIndex: 1, balance: 120000, allocation: GROWTH, annualFeePct: 0.004, pensionReliefMethod: 'netPay' },
          { id: 'gia-sam', type: 'gia', name: 'Sam GIA', ownerIndex: 0, balance: 40000, allocation: BALANCED, annualFeePct: 0.003, giaCostBasis: 30000 },
        ],
        contributions: [
          { id: 'c1', accountId: 'pen-sam', personIndex: 0, type: 'pctOfSalary', amount: 0.10, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c2', accountId: 'pen-sam', personIndex: 0, type: 'employerPctOfSalary', amount: 0.05, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c3', accountId: 'pen-jo', personIndex: 1, type: 'pctOfSalary', amount: 0.08, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c4', accountId: 'pen-jo', personIndex: 1, type: 'employerPctOfSalary', amount: 0.05, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c5', accountId: 'isa-sam', personIndex: 0, type: 'fixedMonthly', amount: 500, startAge: 0, endAge: 60, escalatesWithInflation: true },
          { id: 'c6', accountId: 'isa-jo', personIndex: 1, type: 'fixedMonthly', amount: 500, startAge: 0, endAge: 60, escalatesWithInflation: true },
        ],
        properties: [{
          id: 'home', name: 'Home', value: 450000, growthRealPct: 0.01, isMainResidence: true, runningCostsAnnual: 3000,
          mortgage: { balance: 150000, type: 'repayment', rate: 0.045, fixedYearsRemaining: 2, reversionRate: 0.06, termYearsRemaining: 15, monthlyOverpayment: 200 },
        }],
        incomeStreams: [],
        spending: [
          { fromAge: 0, annualSpend: 45000 },
          { fromAge: 60, annualSpend: 40000 },
          { fromAge: 75, annualSpend: 32000 },
        ],
        strategy: { kind: 'guardrails', initialPct: 0.04, upperGuard: 0.2, lowerGuard: 0.2, adjust: 0.1 },
        withdrawalOrder: ['cash', 'gia', 'isa', 'dcPension'],
        sim: sim(startDate),
      },
    },
    {
      id: 'accumulator',
      name: 'Accumulator age 30 building pots',
      description: 'A 30-year-old renter saving into a pension, LISA and ISA, retiring at 60.',
      scenario: {
        people: [{ name: 'Riley', dateOfBirth: '1996-01-01', salary: 42000, salaryGrowthRealPct: 0.01, retirementAge: 60, niQualifyingYears: 9 }],
        accounts: [
          { id: 'cash', type: 'cash', name: 'Cash savings', ownerIndex: 0, balance: 8000, allocation: CASH, annualFeePct: 0 },
          { id: 'lisa', type: 'lisa', name: 'Lifetime ISA', ownerIndex: 0, balance: 10000, allocation: GROWTH, annualFeePct: 0.003 },
          { id: 'isa', type: 'isa', name: 'Stocks & shares ISA', ownerIndex: 0, balance: 15000, allocation: GROWTH, annualFeePct: 0.003 },
          { id: 'pension', type: 'dcPension', name: 'Workplace pension', ownerIndex: 0, balance: 22000, allocation: GROWTH, annualFeePct: 0.004, pensionReliefMethod: 'netPay' },
        ],
        contributions: [
          { id: 'c1', accountId: 'pension', personIndex: 0, type: 'pctOfSalary', amount: 0.08, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c2', accountId: 'pension', personIndex: 0, type: 'employerPctOfSalary', amount: 0.04, startAge: 0, endAge: 60, escalatesWithInflation: false },
          { id: 'c3', accountId: 'lisa', personIndex: 0, type: 'fixedMonthly', amount: 4000 / 12, startAge: 0, endAge: 50, escalatesWithInflation: false },
          { id: 'c4', accountId: 'isa', personIndex: 0, type: 'fixedMonthly', amount: 300, startAge: 0, endAge: 60, escalatesWithInflation: true },
        ],
        properties: [],
        incomeStreams: [],
        spending: [
          { fromAge: 0, annualSpend: 28000 },
          { fromAge: 60, annualSpend: 26000 },
        ],
        strategy: { kind: 'fixedReal' },
        withdrawalOrder: ['cash', 'isa', 'lisa', 'dcPension'],
        sim: sim(startDate),
      },
    },
  ];
}

export const EXAMPLE_SCENARIOS: ExampleScenario[] = buildExamples();

/**
 * A simple one-person template to edit from scratch: a 40-year-old employee with a workplace
 * pension and some cash. Every figure is a placeholder to replace with your own.
 */
export function starterScenario(startDate: string = todayIso()): Scenario {
  const START_AGE = 40;
  const RETIRE_AT = 67;
  return {
    people: [{ name: 'You', dateOfBirth: addYears(startDate, -START_AGE), salary: 40000, salaryGrowthRealPct: 0, retirementAge: RETIRE_AT, niQualifyingYears: 18 }],
    accounts: [
      { id: 'cash', type: 'cash', name: 'Cash savings', ownerIndex: 0, balance: 10000, allocation: CASH, annualFeePct: 0 },
      { id: 'pension', type: 'dcPension', name: 'Workplace pension', ownerIndex: 0, balance: 60000, allocation: GROWTH, annualFeePct: 0.004, pensionReliefMethod: 'netPay' },
    ],
    contributions: [
      { id: 'c1', accountId: 'pension', personIndex: 0, type: 'pctOfSalary', amount: 0.05, startAge: 0, endAge: RETIRE_AT, escalatesWithInflation: false },
      { id: 'c2', accountId: 'pension', personIndex: 0, type: 'employerPctOfSalary', amount: 0.03, startAge: 0, endAge: RETIRE_AT, escalatesWithInflation: false },
    ],
    properties: [],
    incomeStreams: [],
    spending: [{ fromAge: 0, annualSpend: 25000 }],
    strategy: { kind: 'fixedReal' },
    withdrawalOrder: ['cash', 'dcPension'],
    sim: sim(startDate),
  };
}
