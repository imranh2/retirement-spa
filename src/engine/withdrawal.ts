import type { Account, AccountType, SpendingPhase, WithdrawalStrategy } from '../model/types';
import type { TaxYearConfig } from '../config/configTypes';
import { calculateCGT, calculateIncomeTax, type TaxableIncome } from './tax';
import { isAccessible, splitPensionWithdrawal } from './pension';
import { GROSSUP_TOLERANCE_GBP, MAX_GROSSUP_ITERATIONS, SHORTFALL_TOLERANCE_GBP } from './constants';

/** Annual spend (today's money) of the phase in force at `age`: the last phase with fromAge <= age. */
export function phaseSpend(spending: SpendingPhase[], age: number): number {
  let amount = spending.length > 0 ? spending[0].annualSpend : 0;
  for (const p of spending) if (p.fromAge <= age) amount = p.annualSpend;
  return amount;
}

export interface TargetSpendInput {
  strategy: WithdrawalStrategy;
  phaseSpendToday: number;        // phaseSpend(age0), today's money
  inflationIndex: number;         // index at the start of this year
  retired: boolean;               // person 0's age >= retirementAge
  portfolioAtStart: number;       // all account balances before this year's cash flows, nominal
  prevW?: number;                 // previous retirement year's W (guardrails), nominal
  prevInflation: number;          // last year's inflation draw
}

/**
 * Household discretionary living spend for the year, nominal.
 * Before retirement every strategy uses the spending phases. fixedReal always does.
 */
export function targetSpend(i: TargetSpendInput): number {
  const planned = i.phaseSpendToday * i.inflationIndex;
  const s = i.strategy;
  if (s.kind === 'fixedReal' || !i.retired) return planned;
  const P = Math.max(0, i.portfolioAtStart);
  switch (s.kind) {
    case 'percentOfPortfolio':
      return s.pct * P;
    case 'floorCeiling':
      return Math.min(Math.max(s.pct * P, s.floor * i.inflationIndex), s.ceiling * i.inflationIndex);
    case 'guardrails': {
      // No usable previous withdrawal (first retired year, or a year that started with nothing): restart from initialPct.
      if (i.prevW === undefined || i.prevW <= 0) return s.initialPct * P;
      let W = i.prevW * (1 + i.prevInflation);
      if (P <= 0) return W;
      const rate = W / P;
      if (rate > s.initialPct * (1 + s.upperGuard)) W *= 1 - s.adjust;
      else if (rate < s.initialPct * (1 - s.lowerGuard)) W *= 1 + s.adjust;
      return W;
    }
  }
}

export interface NeedInput {
  targetSpend: number;
  mortgagePayments: number;
  mortgageLumpSums: number;
  propertyCosts: number;
  otherOutgoings: number;          // e.g. downsize shortfall
  taxes: number;                   // baseline income tax (incl. investment income tax) + NI
  contributionsFromTakeHome: number;
  inflows: number;                 // salary + State Pension + income streams + rent
}

/** Household cash need after all non-portfolio inflows. Negative = surplus. */
export function householdNeed(n: NeedInput): number {
  return n.targetSpend + n.mortgagePayments + n.mortgageLumpSums + n.propertyCosts + n.otherOutgoings
    + n.taxes + n.contributionsFromTakeHome - n.inflows;
}

/**
 * Find gross G with net(G) ~= targetNet: start G = N, then G += N - net(G), up to
 * MAX_GROSSUP_ITERATIONS, stopping within GROSSUP_TOLERANCE_GBP. G never exceeds maxGross.
 */
export function grossUp(netFn: (gross: number) => number, targetNet: number, maxGross: number): { gross: number; net: number } {
  const cap = Math.max(0, maxGross);
  let gross = Math.min(Math.max(0, targetNet), cap);
  let net = netFn(gross);
  for (let k = 0; k < MAX_GROSSUP_ITERATIONS; k++) {
    if (Math.abs(net - targetNet) <= GROSSUP_TOLERANCE_GBP) break;
    const next = Math.min(cap, Math.max(0, gross + (targetNet - net)));
    if (next === gross) break;
    gross = next;
    net = netFn(gross);
  }
  return { gross, net };
}

export interface WithdrawalPerson {
  age: number;
  income: TaxableIncome;           // baseline taxable income for the year (incl. investment income)
  basicBandExtension: number;      // relief-at-source gross contributions
  priorPensionTaxable?: number;    // taxable pension already drawn this tax year (stacks on income)
  priorGains?: number;             // GIA gains already realised this tax year
  priorCgt?: number;               // CGT already charged on priorGains (re-priced against final income)
}

export interface WithdrawalContext {
  accounts: Account[];
  order: AccountType[];
  cfg: TaxYearConfig;
  people: WithdrawalPerson[];
  pensionAccessAge: number[];      // per account; ignored for non-DC accounts
  /** Monthly steps: take pension/GIA money gross, record taxable amounts and gains, tax at year end. */
  deferTax?: boolean;
}

export interface WithdrawalState {
  balances: number[];              // per account, nominal
  giaBasis: number[];              // per account (GIA only meaningful)
  lsaUsed: number[];               // per person: tax-free cash taken so far
  mpaaTriggered: boolean[];        // per person
}

export type ByType = Record<AccountType, number>;
export const emptyByType = (): ByType => ({ cash: 0, gia: 0, isa: 0, lisa: 0, dcPension: 0 });

export interface WithdrawalResult {
  state: WithdrawalState;
  net: ByType;                     // cash delivered to the household, by account type
  gross: ByType;                   // taken from balances, by account type
  pensionTax: number;              // extra income tax caused by pension draws
  cgt: number;
  taxFree: number;                 // pension tax-free cash taken this year
  unmet: number;                   // need left after all accessible accounts
  pensionTaxable: number[];        // per person: taxable pension drawn in this call
  gains: number[];                 // per person: GIA gains realised in this call
}

/**
 * Cover `need` (nominal, net of tax) by drawing from accounts in `order`.
 * Inaccessible accounts (locked pension, LISA before penalty-free age) are never touched.
 * Within a type, the need is split across accounts in proportion to balance; any part an
 * account cannot meet moves on. GIA sales pay CGT on the gain implied by the cost basis;
 * pension draws pay income tax on the taxable part, stacked on the owner's other income.
 * Returns a new state; inputs are not mutated.
 */
export function executeWithdrawals(ctx: WithdrawalContext, need: number, input: WithdrawalState): WithdrawalResult {
  const state: WithdrawalState = {
    balances: [...input.balances],
    giaBasis: [...input.giaBasis],
    lsaUsed: [...input.lsaUsed],
    mpaaTriggered: [...input.mpaaTriggered],
  };
  const net = emptyByType();
  const gross = emptyByType();
  let pensionTax = 0;
  let cgt = 0;
  let taxFree = 0;
  const extraNonSavings = ctx.people.map((p) => p.priorPensionTaxable ?? 0);
  const gains = ctx.people.map((p) => p.priorGains ?? 0);
  const cgtCharged = ctx.people.map(() => 0);
  const defer = ctx.deferTax === true;
  const { cfg } = ctx;

  const incomeOf = (p: number): TaxableIncome => {
    const base = ctx.people[p].income;
    return { nonSavings: base.nonSavings + extraNonSavings[p], savings: base.savings, dividends: base.dividends };
  };
  const taxOf = (inc: TaxableIncome, p: number) => calculateIncomeTax(inc, cfg, { basicBandExtension: ctx.people[p].basicBandExtension });

  const drawOne = (ai: number, target: number): number => {
    const acc = ctx.accounts[ai];
    const bal = state.balances[ai];
    const p = acc.ownerIndex;
    if (acc.type === 'dcPension') {
      const inc = incomeOf(p);
      const baseTax = defer ? 0 : taxOf(inc, p).total;
      const lsaLeft = Math.max(0, cfg.pension.lumpSumAllowance - state.lsaUsed[p]);
      const extraTax = (g: number) => {
        if (defer) return 0;
        const { taxable } = splitPensionWithdrawal(g, lsaLeft, cfg);
        return taxOf({ ...inc, nonSavings: inc.nonSavings + taxable }, p).total - baseTax;
      };
      const g = grossUp((x) => x - extraTax(x), target, bal);
      if (g.gross <= 0) return 0;
      const split = splitPensionWithdrawal(g.gross, lsaLeft, cfg);
      const tax = extraTax(g.gross);
      state.balances[ai] = bal - g.gross;
      state.lsaUsed[p] += split.taxFree;
      if (split.taxable > 0) state.mpaaTriggered[p] = true;
      extraNonSavings[p] += split.taxable;
      pensionTax += tax; taxFree += split.taxFree;
      gross.dcPension += g.gross;
      net.dcPension += g.gross - tax;
      return g.gross - tax;
    }
    if (acc.type === 'gia') {
      const basis = state.giaBasis[ai];
      const gainFrac = bal > 0 ? 1 - basis / bal : 0;
      const other = defer ? 0 : taxOf(incomeOf(p), p).taxableIncome;
      const ext = ctx.people[p].basicBandExtension;
      const baseCgt = defer ? 0 : calculateCGT(gains[p], other, cfg, ext);
      const cgtFor = (s: number) => (defer ? 0 : calculateCGT(gains[p] + s * gainFrac, other, cfg, ext) - baseCgt);
      const g = grossUp((s) => s - cgtFor(s), target, bal);
      if (g.gross <= 0) return 0;
      const tax = cgtFor(g.gross);
      state.balances[ai] = bal - g.gross;
      state.giaBasis[ai] = bal > 0 ? basis * (1 - g.gross / bal) : 0;
      gains[p] += g.gross * gainFrac;
      cgt += tax; cgtCharged[p] += tax;
      gross.gia += g.gross;
      net.gia += g.gross - tax;
      return g.gross - tax;
    }
    const take = Math.min(target, bal);
    if (take <= 0) return 0;
    state.balances[ai] = bal - take;
    gross[acc.type] += take;
    net[acc.type] += take;
    return take;
  };

  /** Draw up to `amount` (net) from accounts in withdrawal order; returns the amount delivered. */
  const drawInOrder = (amount: number): number => {
    let remaining = amount;
    for (const type of ctx.order) {
      if (remaining <= SHORTFALL_TOLERANCE_GBP) break;
      for (let pass = 0; pass <= ctx.accounts.length; pass++) {
        const eligible: number[] = [];
        for (let ai = 0; ai < ctx.accounts.length; ai++) {
          const acc = ctx.accounts[ai];
          if (acc.type !== type || state.balances[ai] <= 0) continue;
          if (!isAccessible(acc, ctx.people[acc.ownerIndex].age, ctx.pensionAccessAge[ai], cfg)) continue;
          eligible.push(ai);
        }
        if (eligible.length === 0) break;
        const total = eligible.reduce((sum, ai) => sum + state.balances[ai], 0);
        const passNeed = remaining;
        const shares = eligible.map((ai) => state.balances[ai] / total);
        let delivered = 0;
        eligible.forEach((ai, k) => { delivered += drawOne(ai, passNeed * shares[k]); });
        remaining -= delivered;
        if (remaining <= SHORTFALL_TOLERANCE_GBP || delivered <= GROSSUP_TOLERANCE_GBP) break;
      }
    }
    return amount - remaining;
  };

  let remaining = need - drawInOrder(need);

  // CGT on a GIA sale was priced against the owner's income at the time of the sale. Pension
  // draws later in the order raise that income (and can push gains into the higher rate), so
  // re-price each person's gains against their final income and draw any extra tax due.
  // Drawing the extra can add income again, so repeat a few times.
  const CGT_SETTLE_ROUNDS = 3;
  for (let round = 0; !defer && round < CGT_SETTLE_ROUNDS; round++) {
    let topUp = 0;
    ctx.people.forEach((person, p) => {
      if (gains[p] <= 0) return;
      const other = taxOf(incomeOf(p), p).taxableIncome;
      // Earlier gains this year are re-priced too: draws here can push them into the higher rate.
      const charged = person.priorCgt ?? calculateCGT(person.priorGains ?? 0, other, cfg, person.basicBandExtension);
      const due = calculateCGT(gains[p], other, cfg, person.basicBandExtension) - charged;
      const extra = due - cgtCharged[p];
      if (extra > 0) { cgtCharged[p] += extra; topUp += extra; }
    });
    if (topUp <= 0) break;
    cgt += topUp;
    net.gia -= topUp;
    remaining += topUp;
    remaining -= drawInOrder(remaining);
    if (topUp <= SHORTFALL_TOLERANCE_GBP) break;
  }

  return {
    state, net, gross, pensionTax, cgt, taxFree, unmet: Math.max(0, remaining),
    pensionTaxable: extraNonSavings.map((v, i) => v - (ctx.people[i].priorPensionTaxable ?? 0)),
    gains: gains.map((v, i) => v - (ctx.people[i].priorGains ?? 0)),
  };
}
