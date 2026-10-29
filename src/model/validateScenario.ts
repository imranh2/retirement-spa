import { defaultStatePensionStartAge } from './ageRules';
import type { Scenario, AccountType, Contribution, Mortgage, Account } from './types';
import type { ConfigBundle } from '../config/configTypes';
import { ageAt, isIsoDate } from './dates';

export interface ScenarioIssue { path: string; message: string }

export const ACCOUNT_TYPES: AccountType[] = ['cash', 'gia', 'isa', 'lisa', 'premiumBonds', 'dcPension'];
/** Above this a yearly cost as a share of a home's value is almost certainly a typo. */
const MAX_RUNNING_COST_PCT = 0.1;
/** Accounts spare income can be paid into (pensions and LISAs have their own rules). */
export const SURPLUS_ACCOUNT_TYPES: AccountType[] = ['cash', 'gia', 'isa'];
const CONTRIBUTION_TYPES: Contribution['type'][] = ['fixedMonthly', 'pctOfSalary', 'employerPctOfSalary', 'lumpSum'];
const MORTGAGE_TYPES: Mortgage['type'][] = ['repayment', 'interestOnly'];
const RELIEF_METHODS: NonNullable<Account['pensionReliefMethod']>[] = ['netPay', 'reliefAtSource'];
const MAX_PEOPLE = 2;
const MAX_RUNS = 100000;
const MAX_AGE = 120;
const ALLOCATION_TOLERANCE = 0.0001;
/** Minimum rows of history for the block bootstrap (mirrors engine MIN_BOOTSTRAP_YEARS). */
export const MIN_HISTORY_ROWS = 10;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate a scenario. Returns one issue per problem with a path the UI can show
 * inline (e.g. `accounts[2].balance`). `config` enables checks that depend on it
 * (bootstrap data). Empty result means the scenario can be simulated.
 */
export function validateScenario(s: Scenario, config?: ConfigBundle): ScenarioIssue[] {
  const out: ScenarioIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  const nonNeg = (path: string, v: unknown, label = 'Value') => {
    if (!finite(v)) add(path, `${label} must be a number`);
    else if (v < 0) add(path, `${label} cannot be negative`);
  };

  /** "Sam is 40", or "you are 40" for the quick start's "You". */
  const isAge = (name: string, age: number) => (name === 'You' ? `you are ${age}` : `${name} is ${age}`);
  if (!isIsoDate(s.sim.startDate)) add('sim.startDate', 'Start date must be yyyy-mm-dd');
  const startOk = isIsoDate(s.sim.startDate);
  const age0Now = startOk && s.people[0] && isIsoDate(s.people[0].dateOfBirth) ? ageAt(s.people[0].dateOfBirth, s.sim.startDate) : undefined;

  if (s.people.length < 1 || s.people.length > MAX_PEOPLE) add('people', 'Add one or two people');
  s.people.forEach((p, i) => {
    const pre = `people[${i}]`;
    if (!isIsoDate(p.dateOfBirth)) add(`${pre}.dateOfBirth`, 'Date of birth must be yyyy-mm-dd');
    else if (startOk && ageAt(p.dateOfBirth, s.sim.startDate) < 0) add(`${pre}.dateOfBirth`, 'Date of birth is after the start date');
    nonNeg(`${pre}.salary`, p.salary, 'Salary');
    if (!finite(p.salaryGrowthRealPct) || p.salaryGrowthRealPct < -0.5 || p.salaryGrowthRealPct > 0.5) add(`${pre}.salaryGrowthRealPct`, 'Salary growth must be between -50% and 50%');
    if (!finite(p.retirementAge) || p.retirementAge < 0 || p.retirementAge > MAX_AGE) add(`${pre}.retirementAge`, 'Retirement age must be between 0 and 120');
    if (!finite(p.niQualifyingYears) || p.niQualifyingYears < 0 || p.niQualifyingYears > MAX_AGE) add(`${pre}.niQualifyingYears`, 'Qualifying years must be 0 or more');
    if (p.niCreditsUntilAge !== undefined && (!finite(p.niCreditsUntilAge) || p.niCreditsUntilAge < 0 || p.niCreditsUntilAge > MAX_AGE)) {
      add(`${pre}.niCreditsUntilAge`, 'Age must be between 0 and 120');
    }
    if (p.statePensionStartAge !== undefined && (!Number.isInteger(p.statePensionStartAge) || p.statePensionStartAge < 0 || p.statePensionStartAge > MAX_AGE)) {
      add(`${pre}.statePensionStartAge`, 'State Pension start age must be a whole number between 0 and 120');
    } else if (p.statePensionStartAge !== undefined && config && isIsoDate(p.dateOfBirth) && config.statePension.ageSchedule.length > 0) {
      const earliest = defaultStatePensionStartAge(p.dateOfBirth, config.statePension.ageSchedule);
      if (p.statePensionStartAge < earliest) add(`${pre}.statePensionStartAge`, `The State Pension cannot start before State Pension age (${earliest} in this model). Leave blank to start then, or enter a later age to defer.`);
    }
  });
  const nPeople = s.people.length;
  const validPerson = (i: number) => Number.isInteger(i) && i >= 0 && i < nPeople;

  const ids = new Set<string>();
  if (!s.accounts.some((a) => a.type === 'cash')) add('accounts', 'At least one cash account is required (surpluses are paid into it)');
  s.accounts.forEach((a, i) => {
    const pre = `accounts[${i}]`;
    if (!a.id) add(`${pre}.id`, 'Account needs an id');
    else if (ids.has(a.id)) add(`${pre}.id`, `Duplicate account id '${a.id}'`);
    ids.add(a.id);
    if (!ACCOUNT_TYPES.includes(a.type)) add(`${pre}.type`, 'Unknown account type');
    if (!validPerson(a.ownerIndex)) add(`${pre}.ownerIndex`, 'Owner must be one of the people');
    nonNeg(`${pre}.balance`, a.balance, 'Balance');
    if (!finite(a.annualFeePct) || a.annualFeePct < 0 || a.annualFeePct > 1) add(`${pre}.annualFeePct`, 'Fee must be between 0% and 100%');
    if (a.annualFeeFixed !== undefined) nonNeg(`${pre}.annualFeeFixed`, a.annualFeeFixed, 'Fixed fee');
    if (a.prizeRate !== undefined && (!finite(a.prizeRate) || a.prizeRate < 0 || a.prizeRate > 1)) add(`${pre}.prizeRate`, 'Prize rate must be between 0% and 100%');
    const al = a.allocation;
    const parts = [al.equities, al.bonds, al.cash, al.property];
    if (parts.some((x) => !finite(x) || x < 0)) add(`${pre}.allocation`, 'Allocation shares must be 0% or more');
    else {
      const sum = parts.reduce((x, y) => x + y, 0);
      if (Math.abs(sum - 1) > ALLOCATION_TOLERANCE) add(`${pre}.allocation`, `Allocation must add up to 100% (currently ${(sum * 100).toFixed(1)}%)`);
    }
    if (a.type === 'gia' && a.giaCostBasis !== undefined) nonNeg(`${pre}.giaCostBasis`, a.giaCostBasis, 'Cost basis');
    if (a.type === 'dcPension') {
      if (a.pensionAccessAge !== undefined && (!finite(a.pensionAccessAge) || a.pensionAccessAge < 0 || a.pensionAccessAge > MAX_AGE)) add(`${pre}.pensionAccessAge`, 'Access age must be between 0 and 120');
      if (a.taxFreeCashTaken !== undefined) nonNeg(`${pre}.taxFreeCashTaken`, a.taxFreeCashTaken, 'Tax-free cash taken');
      if (a.pensionReliefMethod !== undefined && !RELIEF_METHODS.includes(a.pensionReliefMethod)) add(`${pre}.pensionReliefMethod`, 'Choose net pay or relief at source');
    }
  });
  // Premium Bonds: each person's holdings must be within the holding limit.
  const bondLimit = config ? Math.min(...Object.values(config.tax).map((y) => y.premiumBonds?.holdingLimit ?? Number.POSITIVE_INFINITY)) : Number.POSITIVE_INFINITY;
  s.people.forEach((p, i) => {
    const held = s.accounts.reduce((sum, a) => sum + (a.type === 'premiumBonds' && a.ownerIndex === i && finite(a.balance) ? a.balance : 0), 0);
    const first = s.accounts.findIndex((a) => a.type === 'premiumBonds' && a.ownerIndex === i);
    if (first >= 0 && held > bondLimit) add(`accounts[${first}].balance`, `Premium Bonds are limited to £${bondLimit.toLocaleString('en-GB')} per person (${p.name || `person ${i + 1}`} holds £${held.toLocaleString('en-GB')})`);
  });
  const accById = new Map(s.accounts.map((a) => [a.id, a]));

  s.contributions.forEach((c, i) => {
    const pre = `contributions[${i}]`;
    const acc = accById.get(c.accountId);
    if (!acc) add(`${pre}.accountId`, 'Choose an account');
    if (!validPerson(c.personIndex)) add(`${pre}.personIndex`, 'Choose a person');
    nonNeg(`${pre}.amount`, c.amount, 'Amount');
    if ((c.type === 'pctOfSalary' || c.type === 'employerPctOfSalary') && finite(c.amount) && c.amount > 1) add(`${pre}.amount`, 'Percentage of salary cannot exceed 100%');
    if (c.type === 'employerPctOfSalary' && acc && acc.type !== 'dcPension') add(`${pre}.type`, 'Employer contributions can only go into a DC pension');
    if (!CONTRIBUTION_TYPES.includes(c.type)) add(`${pre}.type`, 'Unknown contribution type');
    if (!Number.isInteger(c.startAge)) add(`${pre}.startAge`, 'Start age must be a whole number');
    // A one-off payment is made only in the year the payer is that age, so a past age would never pay.
    const payer = validPerson(c.personIndex) ? s.people[c.personIndex] : undefined;
    const payerNow = startOk && payer && isIsoDate(payer.dateOfBirth) ? ageAt(payer.dateOfBirth, s.sim.startDate) : undefined;
    if (c.type === 'lumpSum' && payerNow !== undefined && c.startAge < payerNow) add(`${pre}.startAge`, `This age has passed (${isAge(payer?.name || `person ${c.personIndex + 1}`, payerNow)}), so it would never be paid. Leave it blank for this year, or add money already paid in to the account balance.`);
    if (c.stopsWith !== undefined && !['work', 'age', 'ageEvenAfterWork'].includes(c.stopsWith)) add(`${pre}.stopsWith`, 'Choose when payments stop');
    if (c.source !== undefined && !['pay', 'external'].includes(c.source)) add(`${pre}.source`, 'Choose where the money comes from');
    else if (c.source === 'external' && c.type !== 'lumpSum') add(`${pre}.source`, 'Only a one-off lump sum can come from outside money');
    else if (c.source === 'external' && acc?.type === 'dcPension' && (acc.pensionReliefMethod ?? 'netPay') === 'netPay') add(`${pre}.source`, 'Outside money cannot go through net pay (that only works via payroll). Set this pension to relief at source on the Accounts tab, or pay it into another account.');
    const outside = c.type === 'lumpSum' && c.source === 'external';
    if (c.stopsWith !== 'work' && !outside && (!finite(c.startAge) || !finite(c.endAge) || c.endAge <= c.startAge)) add(`${pre}.endAge`, 'End age must be after start age');
    if (acc && validPerson(c.personIndex) && acc.type !== 'cash' && acc.type !== 'gia' && acc.ownerIndex !== c.personIndex) {
      add(`${pre}.accountId`, 'ISA, LISA and pension contributions must go into the contributor’s own account');
    }
  });

  s.properties.forEach((p, i) => {
    const pre = `properties[${i}]`;
    nonNeg(`${pre}.value`, p.value, 'Value');
    nonNeg(`${pre}.runningCostsAnnual`, p.runningCostsAnnual, 'Running costs');
    if (p.runningCostsPctOfValue !== undefined && (!finite(p.runningCostsPctOfValue) || p.runningCostsPctOfValue < 0 || p.runningCostsPctOfValue > MAX_RUNNING_COST_PCT)) add(`${pre}.runningCostsPctOfValue`, 'Must be between 0% and 10% of the home’s value');
    if (p.rentalIncomeAnnual !== undefined) nonNeg(`${pre}.rentalIncomeAnnual`, p.rentalIncomeAnnual, 'Rent');
    if (!finite(p.growthRealPct) || p.growthRealPct < -0.5 || p.growthRealPct > 0.5) add(`${pre}.growthRealPct`, 'Growth must be between -50% and 50%');
    const m = p.mortgage;
    if (m) {
      if (!MORTGAGE_TYPES.includes(m.type)) add(`${pre}.mortgage.type`, 'Choose repayment or interest-only');
      nonNeg(`${pre}.mortgage.balance`, m.balance, 'Mortgage balance');
      if (!finite(m.rate) || m.rate < 0 || m.rate > 1) add(`${pre}.mortgage.rate`, 'Rate must be between 0% and 100%');
      if (!finite(m.reversionRate) || m.reversionRate < 0 || m.reversionRate > 1) add(`${pre}.mortgage.reversionRate`, 'Rate must be between 0% and 100%');
      nonNeg(`${pre}.mortgage.fixedYearsRemaining`, m.fixedYearsRemaining, 'Fixed years');
      if (!finite(m.termYearsRemaining) || m.termYearsRemaining <= 0) add(`${pre}.mortgage.termYearsRemaining`, 'Term must be more than 0 years');
      nonNeg(`${pre}.mortgage.monthlyOverpayment`, m.monthlyOverpayment, 'Overpayment');
    }
    if (p.downsize) {
      if (!p.isMainResidence) add(`${pre}.downsize`, 'Downsizing is only supported for the main residence');
      const release = accById.get(p.downsize.releaseToAccountId);
      if (!release) add(`${pre}.downsize.releaseToAccountId`, 'Choose an account for the released money');
      else if (release.type !== 'cash' && release.type !== 'gia') add(`${pre}.downsize.releaseToAccountId`, 'Released money can only go into a cash account or GIA (ISA and pension allowances would apply)');
      if (!Number.isInteger(p.downsize.atAge)) add(`${pre}.downsize.atAge`, 'Enter a whole-number age');
      else if (age0Now !== undefined && p.downsize.atAge < age0Now) add(`${pre}.downsize.atAge`, `This age has passed (${isAge(s.people[0]?.name || 'person 1', age0Now)}). Enter the current value of the home you live in now instead.`);
      nonNeg(`${pre}.downsize.newValue`, p.downsize.newValue, 'New home value');
    }
  });
  if (s.surplus !== undefined) {
    if (!['cash', 'invest', 'spend'].includes(s.surplus.kind)) add('surplus', 'Choose what happens to spare income');
    else if (s.surplus.kind === 'invest') {
      const target = accById.get(s.surplus.accountId);
      if (!target) add('surplus', 'Choose an account for spare income');
      else if (!SURPLUS_ACCOUNT_TYPES.includes(target.type)) add('surplus', 'Spare income can only go into a cash account, GIA or ISA');
    }
  }
  if (s.properties.filter((p) => p.isMainResidence).length > 1) add('properties', 'Only one property can be the main residence');

  s.incomeStreams.forEach((st, i) => {
    const pre = `incomeStreams[${i}]`;
    nonNeg(`${pre}.annualAmount`, st.annualAmount, 'Amount');
    if (!validPerson(st.personIndex)) add(`${pre}.personIndex`, 'Choose a person');
    if (!Number.isInteger(st.startAge)) add(`${pre}.startAge`, 'Enter a whole-number age');
    if (st.endAge !== undefined && (!finite(st.endAge) || st.endAge <= st.startAge)) add(`${pre}.endAge`, 'End age must be after start age');
  });

  if (s.spending.length === 0) add('spending', 'Add at least one spending phase');
  s.spending.forEach((ph, i) => {
    nonNeg(`spending[${i}].annualSpend`, ph.annualSpend, 'Spending');
    if (!Number.isInteger(ph.fromAge)) add(`spending[${i}].fromAge`, 'Enter a whole-number age');
    else if (i > 0 && ph.fromAge <= s.spending[i - 1].fromAge) add(`spending[${i}].fromAge`, 'Phases must be in ascending order of age');
  });
  const p0 = s.people[0];
  if (p0 && startOk && isIsoDate(p0.dateOfBirth) && s.spending.length > 0) {
    const age0 = ageAt(p0.dateOfBirth, s.sim.startDate);
    if (s.spending[0].fromAge > age0) add('spending[0].fromAge', `The first phase must start at or before ${p0.name || 'person 1'}'s current age (${age0})`);
    if (!finite(s.sim.horizonAge) || !Number.isInteger(s.sim.horizonAge)) add('sim.horizonAge', 'Horizon age must be a whole number');
    else if (s.sim.horizonAge <= age0) add('sim.horizonAge', `Horizon age must be above the current age (${age0})`);
    else if (s.sim.horizonAge > MAX_AGE) add('sim.horizonAge', 'Horizon age must be 120 or less');
  }

  const st = s.strategy;
  const pct = (path: string, v: number) => { if (!finite(v) || v < 0 || v > 1) add(path, 'Must be between 0% and 100%'); };
  if (!['fixedReal', 'percentOfPortfolio', 'guardrails', 'floorCeiling'].includes(st.kind)) add('strategy', 'Unknown withdrawal strategy');
  if (st.kind === 'percentOfPortfolio') pct('strategy.pct', st.pct);
  if (st.kind === 'guardrails') {
    pct('strategy.initialPct', st.initialPct); pct('strategy.upperGuard', st.upperGuard);
    pct('strategy.lowerGuard', st.lowerGuard); pct('strategy.adjust', st.adjust);
  }
  if (st.kind === 'floorCeiling') {
    pct('strategy.pct', st.pct);
    nonNeg('strategy.floor', st.floor, 'Floor');
    if (!finite(st.ceiling) || st.ceiling < st.floor) add('strategy.ceiling', 'Ceiling must be at least the floor');
  }

  if (s.withdrawalOrder.some((t) => !ACCOUNT_TYPES.includes(t))) add('withdrawalOrder', 'Unknown account type in withdrawal order');
  if (new Set(s.withdrawalOrder).size !== s.withdrawalOrder.length) add('withdrawalOrder', 'Each account type may appear only once');
  for (const t of new Set(s.accounts.map((a) => a.type))) {
    if (!s.withdrawalOrder.includes(t)) add('withdrawalOrder', `Add ${t} to the withdrawal order, or its accounts will never be drawn`);
  }

  if (!Number.isInteger(s.sim.runs) || s.sim.runs < 1 || s.sim.runs > MAX_RUNS) add('sim.runs', 'Runs must be a whole number from 1 to 100,000');
  if (!Number.isInteger(s.sim.seed)) add('sim.seed', 'Seed must be a whole number');
  if (!finite(s.sim.targetSuccessRate) || s.sim.targetSuccessRate <= 0 || s.sim.targetSuccessRate >= 1) add('sim.targetSuccessRate', 'Target must be between 0% and 100%');
  if (s.sim.stepsPerYear !== 1 && s.sim.stepsPerYear !== 12) add('sim.stepsPerYear', 'Steps per year must be 1 or 12');
  if (s.sim.returnModel !== 'lognormal' && s.sim.returnModel !== 'historicalBlockBootstrap') add('sim.returnModel', 'Unknown return model');
  if (s.sim.returnModel === 'historicalBlockBootstrap' && config && config.historicalReturns.length < MIN_HISTORY_ROWS) {
    add('sim.returnModel', `Historical bootstrap needs at least ${MIN_HISTORY_ROWS} years of data (Rules & Assumptions > Historical returns)`);
  }
  return out;
}
