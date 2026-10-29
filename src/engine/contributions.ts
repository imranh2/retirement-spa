import type { Account, Contribution, Person } from '../model/types';
import type { TaxYearConfig } from '../config/configTypes';
import { MONTHS_PER_YEAR } from './constants';
import { capPensionContributions, pensionAllowance, pensionContributionCostReliefAtSource, personalContributionLimit, taperedAnnualAllowance } from './pension';

/**
 * Gross salary for year t (nominal): salary * (1 + salaryGrowthRealPct)^t * inflationIndex
 * while the person's age < retirementAge, else 0.
 */
export function grossSalary(person: Person, age: number, t: number, inflationIndex: number): number {
  if (age >= person.retirementAge) return 0;
  return person.salary * Math.pow(1 + person.salaryGrowthRealPct, t) * inflationIndex;
}

/**
 * Requested contribution for the year, nominal, before any caps.
 * From startAge, until the payer stops work and/or endAge depending on `stopsWith`
 * (default: whichever comes first).
 * fixedMonthly = amount * 12; pct types = amount * gross salary; lumpSum = amount at startAge.
 * escalatesWithInflation multiplies fixed amounts by the inflation index.
 */
export function contributionAmount(c: Contribution, person: Person, age: number, grossSalaryThisYear: number, inflationIndex: number): number {
  // Outside money (a gift or inheritance) arrives at its age whether or not the payer still works.
  if (c.type === 'lumpSum' && c.source === 'external') return age === c.startAge ? c.amount * (c.escalatesWithInflation ? inflationIndex : 1) : 0;
  const stopsWith = c.stopsWith ?? 'age';
  const stoppedWork = age >= person.retirementAge && stopsWith !== 'ageEvenAfterWork';
  const pastEndAge = age >= c.endAge && stopsWith !== 'work';
  if (age < c.startAge || stoppedWork || pastEndAge) return 0;
  switch (c.type) {
    case 'fixedMonthly': return c.amount * MONTHS_PER_YEAR * (c.escalatesWithInflation ? inflationIndex : 1);
    case 'lumpSum': return age === c.startAge ? c.amount * (c.escalatesWithInflation ? inflationIndex : 1) : 0;
    case 'pctOfSalary':
    case 'employerPctOfSalary': return c.amount * grossSalaryThisYear;
    default: return 0;   // unknown types are rejected by validation; never credit NaN
  }
}

export interface PersonYear {
  age: number;
  grossSalary: number;
  mpaaTriggered: boolean;
  /** Other taxable income this year (State Pension, taxable streams, rent), for the annual allowance taper. */
  otherTaxableIncome?: number;
}

export interface ContributionPlan {
  /** Amount to add to each account at the start of the year (index aligned with `accounts`), including LISA bonus and overflow. */
  credits: number[];
  /** One-off lump sums (and their overflow), added at the end of the tax year, after that year's returns. */
  yearEndCredits: number[];
  /** Per person: gross employee contributions under net pay (deducted from taxable pay). */
  netPayGross: number[];
  /** Per person: gross relief-at-source contributions (basic band extension). */
  reliefAtSourceGross: number[];
  /** Household outgoing paid from take-home pay: RAS outlay + ISA/LISA/GIA/cash contributions + net pay gross (not outside money). */
  fromTakeHome: number;
  /** Per person: total gross pension contributions actually made. */
  pensionGross: number[];
  pensionCapped: boolean;
  /** True if anyone's annual allowance was tapered and that cut their contributions. */
  allowanceTapered: boolean;
  isaOverflow: boolean;
  /** True if Premium Bonds payments went over the holding limit (the excess was kept as cash). */
  premiumBondsOverflow: boolean;
  lisaIneligible: boolean;
  /** LISA accounts (indexes) opened by their first contribution this year. */
  lisaOpened: number[];
  /** Per person: ISA allowance left after this year's ISA and LISA contributions. */
  isaRoomLeft: number[];
}

/**
 * Apply one year's contributions with all caps (Sections 8.4 and 8.7).
 * - Pension: per person, personal contributions capped at 100% of gross earnings (relief at
 *   source: at least the basic amount), then employee + employer capped at the annual
 *   allowance, tapered for high incomes (MPAA once triggered).
 * - LISA: capped at lisa.annualAllowance, only from lisa.minAge and while age < maxContributionAge,
 *   and only into a LISA that is already open (`lisaOpen`) or is opened now at or before
 *   lisa.maxOpenAge; 25% bonus added. Ineligible payments go to the overflow account instead.
 * - ISA + LISA together capped at isa.annualAllowance per person. Overflow goes to the
 *   same person's GIA, else the household's first cash account.
 * Inputs are not mutated.
 */
export function planContributions(
  contributions: Contribution[],
  accounts: Account[],
  people: Person[],
  personYears: PersonYear[],
  t: number,
  inflationIndex: number,
  cfg: TaxYearConfig,
  lisaOpen?: readonly boolean[],       // per account; omitted = every LISA is already open
  premiumBondsRoom?: readonly number[], // per person: holding limit less current holdings; omitted = no limit
): ContributionPlan {
  const n = people.length;
  const credits = new Array<number>(accounts.length).fill(0);
  const yearEndCredits = new Array<number>(accounts.length).fill(0);
  const netPayGross = new Array<number>(n).fill(0);
  const reliefAtSourceGross = new Array<number>(n).fill(0);
  const pensionGross = new Array<number>(n).fill(0);
  let fromTakeHome = 0;
  let pensionCapped = false;
  let allowanceTapered = false;
  let isaOverflow = false;
  let premiumBondsOverflow = false;
  let lisaIneligible = false;
  const lisaOpened: number[] = [];
  const isaRoomLeft = new Array<number>(n).fill(cfg.isa.annualAllowance);

  const idxById = new Map(accounts.map((a, i) => [a.id, i]));
  const firstCash = accounts.findIndex((a) => a.type === 'cash');
  const overflowTarget = (person: number) => {
    const gia = accounts.findIndex((a) => a.type === 'gia' && a.ownerIndex === person);
    return gia >= 0 ? gia : firstCash;
  };

  interface Req { acc: number; amount: number; employer: boolean; external: boolean; atYearEnd: boolean }
  /** Add to an account now, or at the end of the year for a one-off lump sum. */
  const credit = (r: Pick<Req, 'atYearEnd'>, acc: number, amount: number) => { (r.atYearEnd ? yearEndCredits : credits)[acc] += amount; };
  /** Charge a contribution to take-home pay, unless the money comes from outside the plan. */
  const fromPay = (r: Pick<Req, 'external'>, amount: number) => { if (!r.external) fromTakeHome += amount; };
  const pensionReqs: Req[][] = Array.from({ length: n }, () => []);
  const isaReqs: Req[][] = Array.from({ length: n }, () => []);
  const lisaReqs: Req[][] = Array.from({ length: n }, () => []);
  const bondReqs: Req[][] = Array.from({ length: n }, () => []);

  for (const c of contributions) {
    const ai = idxById.get(c.accountId);
    const py = personYears[c.personIndex];
    if (ai === undefined || !py) continue;
    const amount = contributionAmount(c, people[c.personIndex], py.age, py.grossSalary, inflationIndex);
    if (amount <= 0) continue;
    const acc = accounts[ai];
    const req: Req = { acc: ai, amount, employer: c.type === 'employerPctOfSalary', external: c.type === 'lumpSum' && c.source === 'external', atYearEnd: c.type === 'lumpSum' };
    if (acc.type === 'dcPension') pensionReqs[c.personIndex].push(req);
    else if (acc.type === 'isa') isaReqs[c.personIndex].push(req);
    else if (acc.type === 'lisa') lisaReqs[c.personIndex].push(req);
    else if (acc.type === 'premiumBonds') bondReqs[acc.ownerIndex].push(req);
    else { credit(req, ai, amount); fromPay(req, amount); }
  }

  for (let p = 0; p < n; p++) {
    const py = personYears[p];
    // Pensions
    const reqs = pensionReqs[p];
    if (reqs.length > 0) {
      const isRas = (r: Req) => accounts[r.acc].pensionReliefMethod === 'reliefAtSource';
      const total = (keep: (r: Req) => boolean) => reqs.filter(keep).reduce((s, r) => s + r.amount, 0);
      const netPay = total((r) => !r.employer && !isRas(r));
      const ras = total((r) => !r.employer && isRas(r));
      const employer = total((r) => r.employer);
      // Personal contributions: 100% of earnings, or the basic amount for relief at source.
      const personal = personalContributionLimit(netPay, ras, py.grossSalary, cfg);
      const income = py.grossSalary + (py.otherTaxableIncome ?? 0);
      const tapered = taperedAnnualAllowance(income - personal.netPay - personal.reliefAtSource, income + employer, cfg);
      const allowance = pensionAllowance(py.mpaaTriggered, cfg, tapered);
      const cap = capPensionContributions(personal.netPay + personal.reliefAtSource, employer, Number.POSITIVE_INFINITY, allowance);
      const TOL = 1e-9;
      if (cap.capped || personal.netPay < netPay - TOL || personal.reliefAtSource < ras - TOL) pensionCapped = true;
      if (cap.capped && tapered < cfg.pension.annualAllowance && allowance === tapered) allowanceTapered = true;
      const scale = (r: Req) => {
        if (r.employer) return cap.employerScale;
        const before = isRas(r) ? (ras > 0 ? personal.reliefAtSource / ras : 1) : (netPay > 0 ? personal.netPay / netPay : 1);
        return before * cap.employeeScale;
      };
      for (const r of reqs) {
        const gross = r.amount * scale(r);
        if (gross <= 0) continue;
        credit(r, r.acc, gross);
        pensionGross[p] += gross;
        if (r.employer) continue;
        if (accounts[r.acc].pensionReliefMethod === 'reliefAtSource') {
          reliefAtSourceGross[p] += gross;
          fromPay(r, pensionContributionCostReliefAtSource(gross, cfg).outlay);
        } else {
          netPayGross[p] += gross;
          fromPay(r, gross);
        }
      }
    }

    // LISA first (it counts towards the ISA allowance), then ISA
    let isaRoom = cfg.isa.annualAllowance;
    let lisaRoom = py.age < cfg.lisa.maxContributionAge ? cfg.lisa.annualAllowance : 0;
    const overflowTo = overflowTarget(p);
    const sendOverflow = (r: Req, amount: number) => {
      if (amount <= 0) return;
      isaOverflow = true;
      if (overflowTo >= 0) credit(r, overflowTo, amount);
      fromPay(r, amount);
    };
    for (const r of lisaReqs[p]) {
      const open = lisaOpen === undefined || lisaOpen[r.acc] || lisaOpened.includes(r.acc);
      const eligible = py.age >= cfg.lisa.minAge && py.age < cfg.lisa.maxContributionAge && (open || py.age <= cfg.lisa.maxOpenAge);
      if (!eligible) {
        // Not allowed into a LISA at this age: the money is saved in the overflow account instead.
        lisaIneligible = true;
        if (overflowTo >= 0) credit(r, overflowTo, r.amount);
        fromPay(r, r.amount);
        continue;
      }
      if (!open) lisaOpened.push(r.acc);
      const take = Math.max(0, Math.min(r.amount, lisaRoom, isaRoom));
      lisaRoom -= take; isaRoom -= take;
      credit(r, r.acc, take * (1 + cfg.lisa.bonusRate));
      fromPay(r, take);
      sendOverflow(r, r.amount - take);
    }
    for (const r of isaReqs[p]) {
      const take = Math.max(0, Math.min(r.amount, isaRoom));
      isaRoom -= take;
      credit(r, r.acc, take);
      fromPay(r, take);
      sendOverflow(r, r.amount - take);
    }
    isaRoomLeft[p] = isaRoom;

    // Premium Bonds: up to the holding limit; the rest is kept as cash.
    let bondRoom = premiumBondsRoom?.[p] ?? Number.POSITIVE_INFINITY;
    for (const r of bondReqs[p]) {
      const take = Math.max(0, Math.min(r.amount, bondRoom));
      bondRoom -= take;
      credit(r, r.acc, take);
      fromPay(r, take);
      const rest = r.amount - take;
      if (rest > 0) {
        premiumBondsOverflow = true;
        if (firstCash >= 0) credit(r, firstCash, rest);
        fromPay(r, rest);
      }
    }
  }

  return { credits, yearEndCredits, netPayGross, reliefAtSourceGross, fromTakeHome, pensionGross, pensionCapped, allowanceTapered, isaOverflow, premiumBondsOverflow, lisaIneligible, lisaOpened, isaRoomLeft };
}
