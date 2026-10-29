import type { Account, AccountType, AssetAllocation, Contribution, Property, Scenario } from '../model/types';
import type { Store } from './store';
import { ageAt, isIsoDate, todayIso } from '../model/dates';
import { CASH, sim } from './exampleScenarios';
import { h, confirmButton } from './dom';
import { numberField, selectField, textField } from './fields';

/** How the ISA, GIA and pension are invested. */
export const QUICK_MIXES = {
  equities: { label: 'All shares (100% equities)', allocation: { equities: 1, bonds: 0, cash: 0, property: 0 } },
  growth: { label: 'Mostly shares (80% equities, 20% bonds and cash)', allocation: { equities: 0.8, bonds: 0.15, cash: 0.05, property: 0 } },
  balanced: { label: 'Balanced (60% equities, 40% bonds and cash)', allocation: { equities: 0.6, bonds: 0.3, cash: 0.1, property: 0 } },
  cautious: { label: 'Cautious (40% equities, 60% bonds and cash)', allocation: { equities: 0.4, bonds: 0.5, cash: 0.1, property: 0 } },
} satisfies Record<string, { label: string; allocation: AssetAllocation }>;
export type QuickMix = keyof typeof QUICK_MIXES;

/** The numbers the quick start asks for; everything else takes a sensible default. */
export interface QuickStartInput {
  dateOfBirth: string;
  salary: number;
  stopWorkAge: number;
  spending: number;
  leftover: 'spend' | 'cash' | 'invest';
  cash: number;
  premiumBonds: number;
  isa: number;
  gia: number;
  pension: number;
  pensionType: 'workplace' | 'personal';
  pensionPct: number;          // your contribution, gross, share of salary
  employerPct: number;
  isaMonthly: number;
  homeValue: number;
  homeCostsPct: number;        // upkeep, insurance and similar, as a share of the home's value each year
  mortgageBalance: number;
  mortgageYears: number;
  mortgageRate: number;
  mortgageFixedYears: number;
  mortgageRateAfterFix: number | null;   // null = the same as now
  mix: QuickMix;
  feePct: number;
  feeFixed: number;            // flat £ a year on each of the ISA, GIA and pension
  niYears: number | null;      // null = estimate from age
  lumpSum: number;             // one-off money coming in (inheritance, bonus) into the GIA
  lumpSumAge: number | null;   // null = now
}

/** Starting answers. The date of birth is left blank so nobody builds a plan on a made-up one. */
export function quickStartDefaults(): QuickStartInput {
  return {
    dateOfBirth: '', salary: 40000, stopWorkAge: 67, spending: 25000, leftover: 'spend',
    cash: 10000, premiumBonds: 0, isa: 0, gia: 0, pension: 60000, pensionType: 'workplace',
    pensionPct: 0.05, employerPct: 0.03, isaMonthly: 0,
    homeValue: 0, homeCostsPct: 0.01, mortgageBalance: 0, mortgageYears: 0, mortgageRate: 0.045, mortgageFixedYears: 2, mortgageRateAfterFix: null,
    mix: 'growth', feePct: 0.003, feeFixed: 0, niYears: null, lumpSum: 0, lumpSumAge: null,
  };
}

const NI_START_AGE = 21;
const FULL_NI_YEARS = 35;
/** Contributions run until the payer stops work; this end age never binds. */
const NO_END_AGE = 120;
/** More runs than the examples: steadier figures for a plan people will act on. */
const QUICK_START_RUNS = 10000;

/** A whole scenario from the quick-start answers: one person, the accounts they have, and their home. */
export function quickStartScenario(q: QuickStartInput, startDate: string = todayIso(), bondLimit = Number.POSITIVE_INFINITY): Scenario {
  const age = ageAt(q.dateOfBirth, startDate);
  // Premium Bonds above the holding limit could not be held: count the excess as cash.
  const bonds = Math.min(q.premiumBonds, bondLimit);
  const accounts: Account[] = [{ id: 'cash', type: 'cash', name: 'Cash savings', ownerIndex: 0, balance: q.cash + q.premiumBonds - bonds, allocation: CASH, annualFeePct: 0 }];
  const invested = (type: AccountType, name: string, balance: number, extra: Partial<Account> = {}) =>
    accounts.push({ id: type, type, name, ownerIndex: 0, balance, allocation: { ...QUICK_MIXES[q.mix].allocation }, annualFeePct: q.feePct, ...(q.feeFixed > 0 ? { annualFeeFixed: q.feeFixed } : {}), ...extra });
  if (bonds > 0) accounts.push({ id: 'premiumBonds', type: 'premiumBonds', name: 'Premium Bonds', ownerIndex: 0, balance: bonds, allocation: CASH, annualFeePct: 0 });
  const leftoverToIsa = q.leftover === 'invest';
  if (q.gia > 0 || q.lumpSum > 0 || leftoverToIsa) invested('gia', 'General investment account', q.gia);
  if (q.isa > 0 || q.isaMonthly > 0 || leftoverToIsa) invested('isa', 'Stocks & shares ISA', q.isa);
  const pensionPaid = q.salary > 0 && (q.pensionPct > 0 || q.employerPct > 0);
  if (q.pension > 0 || pensionPaid) {
    invested('dcPension', q.pensionType === 'personal' ? 'SIPP' : 'Workplace pension', q.pension, { pensionReliefMethod: q.pensionType === 'personal' ? 'reliefAtSource' : 'netPay' });
  }

  const contributions: Contribution[] = [];
  const contrib = (id: string, accountId: string, type: Contribution['type'], amount: number, escalates: boolean) =>
    contributions.push({ id, accountId, personIndex: 0, type, amount, startAge: 0, endAge: NO_END_AGE, escalatesWithInflation: escalates, stopsWith: 'work' });
  if (q.salary > 0 && q.pensionPct > 0) contrib('c-pension', 'dcPension', 'pctOfSalary', q.pensionPct, false);
  // Employer contributions only exist in a workplace scheme.
  if (q.salary > 0 && q.employerPct > 0) contrib('c-employer', 'dcPension', 'employerPctOfSalary', q.employerPct, false);
  if (q.isaMonthly > 0) contrib('c-isa', 'isa', 'fixedMonthly', q.isaMonthly, true);
  if (q.lumpSum > 0) {
    contributions.push({ id: 'c-lump', accountId: 'gia', personIndex: 0, type: 'lumpSum', amount: q.lumpSum, startAge: Math.max(age, q.lumpSumAge ?? age), endAge: NO_END_AGE, escalatesWithInflation: false, source: 'external' });
  }

  // A mortgage without a home value still needs a home to hang on: assume it is worth the mortgage.
  const properties: Property[] = q.homeValue > 0 || q.mortgageBalance > 0 ? [{
    id: 'home', name: 'Home', value: Math.max(q.homeValue, q.mortgageBalance), growthRealPct: 0, isMainResidence: true,
    runningCostsAnnual: 0, ...(q.homeCostsPct > 0 ? { runningCostsPctOfValue: q.homeCostsPct } : {}),
    mortgage: q.mortgageBalance > 0 ? {
      balance: q.mortgageBalance, type: 'repayment', rate: q.mortgageRate, fixedYearsRemaining: Math.min(q.mortgageFixedYears, Math.max(1, q.mortgageYears)),
      reversionRate: q.mortgageRateAfterFix ?? q.mortgageRate, termYearsRemaining: Math.max(1, q.mortgageYears), monthlyOverpayment: 0,
    } : undefined,
  }] : [];

  // Premium Bonds are kept as an emergency reserve, drawn only after everything else.
  const order: AccountType[] = ['cash', 'gia', 'isa', 'dcPension', 'premiumBonds'];
  return {
    people: [{
      name: 'You', dateOfBirth: q.dateOfBirth, salary: q.salary, salaryGrowthRealPct: 0,
      retirementAge: q.salary > 0 ? q.stopWorkAge : Math.min(q.stopWorkAge, age),
      niQualifyingYears: q.niYears ?? Math.min(FULL_NI_YEARS, Math.max(0, age - NI_START_AGE)),
    }],
    accounts, contributions, properties, incomeStreams: [],
    spending: [{ fromAge: 0, annualSpend: q.spending }],
    strategy: { kind: 'fixedReal' },
    withdrawalOrder: order.filter((t) => accounts.some((a) => a.type === t)),
    sim: { ...sim(startDate), runs: QUICK_START_RUNS },
    // Spare income: spent, kept as cash, or invested in the ISA (overflow to the GIA).
    pensionDrawdown: 'allowance',
    surplus: q.leftover === 'spend' ? { kind: 'spend' } : q.leftover === 'cash' ? { kind: 'cash' } : { kind: 'invest', accountId: 'isa' },
  };
}

/** Answers survive re-renders of the Overview tab within a visit. */
const answers: QuickStartInput = quickStartDefaults();

/** "Start with your own numbers": a short form that builds a whole plan in one go. */
export function quickStartSection(store: Store, open: boolean, rerender: () => void): HTMLElement {
  type NumKey = { [K in keyof QuickStartInput]: QuickStartInput[K] extends number ? K : never }[keyof QuickStartInput];
  type OptKey = { [K in keyof QuickStartInput]: QuickStartInput[K] extends number | null ? (QuickStartInput[K] extends number ? never : K) : never }[keyof QuickStartInput];
  const set = (k: NumKey) => (v: number | null) => { answers[k] = v ?? 0; };
  const money = (k: NumKey, label: string, help?: string, unit: 'gbp' | 'gbpMonth' = 'gbp') =>
    numberField({ label, unit, min: 0, step: 100, value: answers[k], help, onChange: set(k) });
  const pct = (k: NumKey, label: string, help?: string, step = 0.005) =>
    numberField({ label, unit: 'pct', min: 0, max: 1, step, value: answers[k], help, onChange: set(k) });
  const optional = (k: OptKey, label: string, unit: 'pct' | 'age' | 'years', placeholder: string, help?: string) =>
    numberField({ label, unit, nullable: true, min: 0, max: unit === 'pct' ? 1 : 120, step: unit === 'pct' ? 0.0025 : 1, value: answers[k], placeholder, help, onChange: (v) => { answers[k] = v; } });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const build = () => {
    if (!isIsoDate(answers.dateOfBirth)) { error.textContent = 'Enter your date of birth first.'; error.hidden = false; return; }
    const limit = Math.min(...Object.values(store.getState().config.tax).map((y) => y.premiumBonds.holdingLimit));
    store.replaceScenario(quickStartScenario(answers, todayIso(), limit));
    store.dismissNotice('welcome');
    location.hash = '#/results';
    rerender();
  };
  const group = (title: string, ...fields: HTMLElement[]) => h('fieldset', { class: 'quick-group' }, h('legend', {}, title), h('div', { class: 'grid' }, ...fields));
  return h('details', { class: 'panel-section quick-start', id: 'quickstart', open },
    h('summary', {}, h('h3', {}, 'Start with your own numbers'), h('span', { class: 'muted' }, ' — about two minutes')),
    h('p', { class: 'muted' }, 'Answer a few questions and we build a plan for one person. Amounts are in today’s money; leave anything you don’t have at 0. You can add a partner, more accounts and details on the tabs afterwards.'),
    group('You',
      textField({ label: 'Date of birth', type: 'date', value: answers.dateOfBirth, help: 'Sets your State Pension age and when you can use your pension.', onChange: (v) => { answers.dateOfBirth = v; error.hidden = true; } }),
      money('salary', 'Salary (gross, per year)', 'Before tax. 0 if you are not working.'),
      numberField({ label: 'Stop work at', unit: 'age', min: 16, max: 100, step: 1, value: answers.stopWorkAge, help: 'When your salary and contributions stop.', onChange: set('stopWorkAge') }),
      money('spending', 'Living costs per year', 'Everything except mortgage payments and home running costs, which go below.'),
      selectField({ label: 'Money left over each year', value: answers.leftover,
        help: 'In years when income is more than you spend, pay and save. Most people spend it, so the cautious choice is to assume that.',
        options: [{ value: 'spend', label: 'It gets spent' }, { value: 'cash', label: 'I keep it as cash' }, { value: 'invest', label: 'I invest it (ISA, then GIA)' }],
        onChange: (v) => { answers.leftover = v; } })),
    group('Savings and investments today',
      money('cash', 'Cash savings'),
      money('premiumBonds', 'Premium Bonds', 'NS&I Premium Bonds you hold (up to £50,000). Kept as an emergency reserve: used only after everything else.'),
      money('isa', 'Stocks & shares ISA'),
      money('gia', 'Other investments (GIA)', 'Investments outside an ISA or pension.'),
      money('pension', 'Pension pots', 'The total of your defined contribution (DC) pension pots. Add final salary (DB) pensions afterwards under People & Income → Other income.')),
    group('Saving each month while working',
      selectField({ label: 'Pension type', value: answers.pensionType,
        help: 'Workplace: paid from salary before tax (net pay). SIPP or personal pension: you pay in after tax and the provider adds basic-rate relief (relief at source).',
        options: [{ value: 'workplace', label: 'Workplace pension' }, { value: 'personal', label: 'SIPP or personal pension' }],
        onChange: (v) => { answers.pensionType = v; } }),
      pct('pensionPct', 'Your pension contribution', 'Share of salary, including tax relief.'),
      pct('employerPct', 'Employer pension contribution'),
      money('isaMonthly', 'Into your ISA', undefined, 'gbpMonth')),
    group('Home (optional)',
      money('homeValue', 'Home value'),
      pct('homeCostsPct', 'Upkeep and running costs', 'A year, as a share of the home’s value: repairs, insurance, service charges. 1% is a common rule of thumb.', 0.001),
      money('mortgageBalance', 'Mortgage left to pay'),
      numberField({ label: 'Mortgage years left', unit: 'years', min: 0, max: 40, step: 1, value: answers.mortgageYears, onChange: set('mortgageYears') }),
      pct('mortgageRate', 'Mortgage rate now', 'A repayment mortgage is assumed; change it under Property & Mortgage.', 0.0005),
      numberField({ label: 'Years left on the fixed rate', unit: 'years', min: 0, max: 40, step: 1, value: answers.mortgageFixedYears, help: '0 if it is not fixed.', onChange: set('mortgageFixedYears') }),
      optional('mortgageRateAfterFix', 'Rate after the fix', 'pct', 'same as now', 'Blank assumes you remortgage at about the same rate. Enter your lender’s standard variable rate to be cautious.')),
    h('details', { class: 'quick-more' },
      h('summary', {}, 'More details (optional)'),
      group('Investments',
        selectField({ label: 'How your ISA, GIA and pension are invested', value: answers.mix,
          options: (Object.keys(QUICK_MIXES) as QuickMix[]).map((k) => ({ value: k, label: QUICK_MIXES[k].label })), onChange: (v) => { answers.mix = v; } }),
        pct('feePct', 'Fees a year', 'Fund charges plus any percentage platform fee, on each of them.', 0.0005),
        money('feeFixed', 'Flat platform fee a year', 'On each of the ISA, GIA and pension, e.g. a £90 a year flat-fee platform.')),
      group('Other',
        optional('niYears', 'NI qualifying years so far', 'years', 'estimate from age', 'From your State Pension forecast on gov.uk. Blank estimates it from your age.'),
        money('lumpSum', 'One-off money coming in', 'An inheritance, gift or bonus not yet received. It goes into the GIA at the end of that tax year, without coming out of your pay.'),
        optional('lumpSumAge', 'Arriving at age', 'age', 'now'))),
    error,
    h('p', { class: 'row-btns' }, confirmButton('Build my plan', 'Replace my current plan', build, 'btn primary')),
    h('p', { class: 'muted small' }, 'This replaces the plan you have now (your rules and assumptions are kept). Export first if you want to keep it.'));
}
