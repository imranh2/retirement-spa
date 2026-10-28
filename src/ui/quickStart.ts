import type { Account, AccountType, Contribution, Property, Scenario } from '../model/types';
import type { Store } from './store';
import { addYears, todayIso } from '../model/dates';
import { CASH, GROWTH, sim } from './exampleScenarios';
import { h } from './dom';
import { numberField } from './fields';
import { confirmButton } from './dom';

/** The few numbers the quick start asks for; everything else takes a sensible default. */
export interface QuickStartInput {
  age: number;
  salary: number;
  stopWorkAge: number;
  spending: number;
  cash: number;
  isa: number;
  gia: number;
  pension: number;
  pensionPct: number;          // your contribution, gross, share of salary
  employerPct: number;
  isaMonthly: number;
  homeValue: number;
  mortgageBalance: number;
  mortgageYears: number;
}

export const QUICK_START_DEFAULTS: QuickStartInput = {
  age: 40, salary: 40000, stopWorkAge: 67, spending: 25000,
  cash: 10000, isa: 0, gia: 0, pension: 60000, pensionPct: 0.05, employerPct: 0.03, isaMonthly: 0,
  homeValue: 0, mortgageBalance: 0, mortgageYears: 0,
};

/** Typical mortgage rate assumed by the quick start (editable afterwards). */
const QUICK_MORTGAGE_RATE = 0.045;
const NI_START_AGE = 21;
const FULL_NI_YEARS = 35;
/** Contributions run until the payer stops work; this end age never binds. */
const NO_END_AGE = 120;
const DEFAULT_FEE = 0.004;

/** A whole scenario from the quick-start answers: one person, the accounts they have, and their home. */
export function quickStartScenario(q: QuickStartInput, startDate: string = todayIso()): Scenario {
  const accounts: Account[] = [{ id: 'cash', type: 'cash', name: 'Cash savings', ownerIndex: 0, balance: q.cash, allocation: CASH, annualFeePct: 0 }];
  const add = (type: AccountType, name: string, balance: number, extra: Partial<Account> = {}) =>
    accounts.push({ id: type, type, name, ownerIndex: 0, balance, allocation: GROWTH, annualFeePct: DEFAULT_FEE, ...extra });
  if (q.gia > 0) add('gia', 'General investment account', q.gia);
  if (q.isa > 0 || q.isaMonthly > 0) add('isa', 'Stocks & shares ISA', q.isa);
  const pensionPaid = q.salary > 0 && (q.pensionPct > 0 || q.employerPct > 0);
  if (q.pension > 0 || pensionPaid) add('dcPension', 'Workplace pension', q.pension, { pensionReliefMethod: 'netPay' });

  const contributions: Contribution[] = [];
  const contrib = (id: string, accountId: string, type: Contribution['type'], amount: number, escalates: boolean) =>
    contributions.push({ id, accountId, personIndex: 0, type, amount, startAge: 0, endAge: NO_END_AGE, escalatesWithInflation: escalates, stopsWith: 'work' });
  if (q.salary > 0 && q.pensionPct > 0) contrib('c-pension', 'dcPension', 'pctOfSalary', q.pensionPct, false);
  if (q.salary > 0 && q.employerPct > 0) contrib('c-employer', 'dcPension', 'employerPctOfSalary', q.employerPct, false);
  if (q.isaMonthly > 0) contrib('c-isa', 'isa', 'fixedMonthly', q.isaMonthly, true);

  // A mortgage without a home value still needs a home to hang on: assume it is worth the mortgage.
  const properties: Property[] = q.homeValue > 0 || q.mortgageBalance > 0 ? [{
    id: 'home', name: 'Home', value: Math.max(q.homeValue, q.mortgageBalance), growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0,
    mortgage: q.mortgageBalance > 0 ? {
      balance: q.mortgageBalance, type: 'repayment', rate: QUICK_MORTGAGE_RATE, fixedYearsRemaining: 0,
      reversionRate: QUICK_MORTGAGE_RATE, termYearsRemaining: Math.max(1, q.mortgageYears), monthlyOverpayment: 0,
    } : undefined,
  }] : [];

  const order: AccountType[] = ['cash', 'gia', 'isa', 'dcPension'];
  return {
    people: [{
      name: 'You', dateOfBirth: addYears(startDate, -q.age), salary: q.salary, salaryGrowthRealPct: 0,
      retirementAge: q.salary > 0 ? q.stopWorkAge : Math.min(q.stopWorkAge, q.age),
      niQualifyingYears: Math.min(FULL_NI_YEARS, Math.max(0, q.age - NI_START_AGE)),
    }],
    accounts, contributions, properties, incomeStreams: [],
    spending: [{ fromAge: 0, annualSpend: q.spending }],
    strategy: { kind: 'fixedReal' },
    withdrawalOrder: order.filter((t) => accounts.some((a) => a.type === t)),
    sim: sim(startDate),
  };
}

/** Answers survive re-renders of the Overview tab within a visit. */
const answers: QuickStartInput = { ...QUICK_START_DEFAULTS };

/** "Start with your own numbers": a short form that builds a whole plan in one go. */
export function quickStartSection(store: Store, open: boolean, rerender: () => void): HTMLElement {
  const set = (k: keyof QuickStartInput) => (v: number | null) => { answers[k] = v ?? 0; };
  const money = (k: keyof QuickStartInput, label: string, help?: string, unit: 'gbp' | 'gbpMonth' = 'gbp') =>
    numberField({ label, unit, min: 0, step: 100, value: answers[k], help, onChange: set(k) });
  const pct = (k: keyof QuickStartInput, label: string, help?: string) =>
    numberField({ label, unit: 'pct', min: 0, max: 1, step: 0.005, value: answers[k], help, onChange: set(k) });
  const age = (k: keyof QuickStartInput, label: string, help?: string) =>
    numberField({ label, unit: 'age', min: 16, max: 100, step: 1, value: answers[k], help, onChange: set(k) });
  const build = () => {
    store.replaceScenario(quickStartScenario(answers));
    store.dismissNotice('welcome');
    location.hash = '#/results';
    rerender();
  };
  const group = (title: string, ...fields: HTMLElement[]) => h('fieldset', { class: 'quick-group' }, h('legend', {}, title), h('div', { class: 'grid' }, ...fields));
  return h('details', { class: 'panel-section quick-start', id: 'quickstart', open },
    h('summary', {}, h('h3', {}, 'Start with your own numbers'), h('span', { class: 'muted' }, ' — about two minutes')),
    h('p', { class: 'muted' }, 'Answer a few questions and we build a plan for one person. Amounts are in today’s money; leave anything you don’t have at 0. You can add a partner, more accounts and details on the tabs afterwards.'),
    group('You',
      age('age', 'Your age'),
      money('salary', 'Salary (gross, per year)', 'Before tax. 0 if you are not working.'),
      age('stopWorkAge', 'Stop work at', 'When your salary and contributions stop.'),
      money('spending', 'Living costs per year', 'Everything except mortgage payments, which go below.')),
    group('Savings and investments today',
      money('cash', 'Cash savings'),
      money('isa', 'Stocks & shares ISA'),
      money('gia', 'Other investments (GIA)', 'Investments outside an ISA or pension.'),
      money('pension', 'Pension pots', 'The total of your defined contribution (DC) pension pots. Add final salary (DB) pensions afterwards under People & Income → Other income.')),
    group('Saving each month while working',
      pct('pensionPct', 'Your pension contribution', 'Share of salary, including tax relief.'),
      pct('employerPct', 'Employer pension contribution'),
      money('isaMonthly', 'Into your ISA', undefined, 'gbpMonth')),
    group('Home (optional)',
      money('homeValue', 'Home value'),
      money('mortgageBalance', 'Mortgage left to pay'),
      numberField({ label: 'Mortgage years left', unit: 'years', min: 0, max: 40, step: 1, value: answers.mortgageYears, help: `A repayment mortgage at ${QUICK_MORTGAGE_RATE * 100}% is assumed; adjust it under Property & Mortgage.`, onChange: set('mortgageYears') })),
    h('p', { class: 'row-btns' }, confirmButton('Build my plan', 'Replace my current plan', build, 'btn primary')),
    h('p', { class: 'muted small' }, 'This replaces the plan you have now (your rules and assumptions are kept). Export first if you want to keep it.'));
}
