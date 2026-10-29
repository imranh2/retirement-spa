import type { AccountType, CentralCaseRow, OneOffCost, Scenario, SimulationResult } from '../model/types';
import type { ConfigBundle, TaxYearConfig } from '../config/configTypes';
import { latestDefinedYear, resolveTaxYear, thresholdFactor } from '../config/resolveTaxYear';
import { ageAt, taxYearLabel, taxYearStartYear, taxYearStartYearOf } from '../model/dates';
import { validateScenario } from '../model/validateScenario';
import { mulberry32, runSeed } from './prng';
import { accountReturn, deterministicReturns, generateMonthlyReturnsPacked, generateReturns, monthlyRate, propertyNominalReturn, unpackReturn, type YearReturns } from './returns';
import { calculateCGT, calculateIncomeTax, calculateNI, type TaxableIncome } from './tax';
import { accessAgeForAccount } from './pension';
import { annualEntitlement, deferralMultiplier, qualifyingYearsAtStart, statePensionGrowth, statePensionStartAge } from './statePension';
import { defaultStatePensionStartAge } from '../model/ageRules';
import { initialMortgageState, scheduleMonths, type MortgageState } from './mortgage';
import { downsize, rentNominal, runningCostsNominal, stampDuty } from './property';
import { grossSalary, planContributions, type PersonYear } from './contributions';
import { emptyByType, executeWithdrawals, householdNeed, plannedSpendToday, targetSpend, type ByType, type WithdrawalState } from './withdrawal';
import { earliestRetirementSteps } from './retireAge';
import type { RetireAgeOutcome } from '../model/retirement';
import { depletionHistogram, MAX_SPEND_STEPS, maxSpendSteps, percentile, percentileBands, successRate, type MaxSpendOutcome } from './stats';
import { MONTHS_PER_YEAR, QUICK_SPEND_ITERATIONS, QUICK_SPEND_RUNS, SHORTFALL_TOLERANCE_GBP } from './constants';

export { percentile } from './stats';

export interface SimOpts {
  onProgress?: (completed: number, total: number) => void;
  deterministic?: boolean;     // mean assumptions, zero volatility, one run
  spendMultiplier?: number;    // multiplies every spending phase
  runsOverride?: number;
  successOnly?: boolean;       // skip bands and the central case (used by the max-spend search)
}

/** Runs per progress callback in simulate(); the worker uses its own chunking. */
const PROGRESS_CHUNK_RUNS = 500;
const PERCENT = 100;

type IncomeKey = keyof SimulationResult['incomeBySourceMeanReal'];
const INCOME_KEYS: IncomeKey[] = ['salary', 'statePension', 'otherIncome', 'rental', 'cash', 'gia', 'isa', 'lisa', 'premiumBonds', 'dcPension'];

/** Everything about a scenario that is the same in every run. */
interface Prepared {
  scenario: Scenario;
  config: ConfigBundle;
  T: number;
  startAge0: number;
  ageOffset: number[];             // person i's age = age0 + offset
  labels: string[];                // tax year label per year
  baseTax: TaxYearConfig[];        // resolved at factor 1, per year
  freezeEndStart: number;          // start year of the last frozen tax year
  upratedBase: (string | undefined)[]; // per year: the defined year it copies, if that year is itself after the freeze
  upratedBaseT: number[];          // per year: index t of that base year in this simulation (-1 if before the start)
  spStartAge: number[];
  niEndAge: number[];              // employee NI stops at State Pension age (whole years, ignoring deferral)
  spEntitlementToday: number[];    // annual, today's money
  pensionAccessAge: number[];      // per account (NaN for non-DC)
  firstCash: number;
  /** Months of the first tax year left from the start date (12 when it starts on 6 April). */
  firstYearMonths: number;
  surplusTarget: number;            // account index for SurplusRule 'invest', else -1
  initialLsaUsed: number[];
}


/**
 * For each simulated year that is not defined in the config: the defined year it copies,
 * when that year is itself after the freeze. Its thresholds already include uprating, so
 * the year's factor must be measured from that year, not from the end of the freeze.
 */
function upratedBases(config: ConfigBundle, labels: string[], startYear: number, freezeEndStart: number): { upratedBase: (string | undefined)[]; upratedBaseT: number[] } {
  const upratedBase = labels.map((l) => {
    if (config.tax[l]) return undefined;
    const base = latestDefinedYear(config, l);
    return base !== undefined && taxYearStartYear(base) > freezeEndStart ? base : undefined;
  });
  return { upratedBase, upratedBaseT: upratedBase.map((b) => (b === undefined ? -1 : taxYearStartYear(b) - startYear)) };
}

/** Per-year record of one run (nominal unless noted). */
interface YearRecord {
  t: number;
  index: number;                   // inflation index at start of year
  indexEnd: number;
  salary: number; statePension: number; otherIncome: number; rental: number;
  draws: ByType;
  spending: number; mortgagePayments: number; mortgageInterest: number; propertyCosts: number; rentPaid: number; oneOffCosts: number; homePurchase: number;
  incomeTax: number; ni: number; cgt: number;
  savedFromPay: number; spareIncome: number;
  months: number;          // months of the tax year covered (fewer in a part first year)
  portfolioEnd: number; propertyEquityEnd: number; mortgageBalanceEnd: number;
}

interface RunFlags { pensionCapped: boolean; allowanceTapered: boolean; isaOverflow: boolean; premiumBondsOverflow: boolean; lisaIneligible: boolean; mortgageLumpSum: boolean; downsizeShortfall: boolean; lsaExhausted: boolean }

interface RunOutcome { failedAtAge: number; flags: RunFlags }

/** Whether a one-off cost falls due at `age`: at its age, then every `everyYears` before `untilAge`. */
export function oneOffDue(o: OneOffCost, age: number): boolean {
  if (age < o.atAge) return false;
  if (!o.everyYears || o.everyYears <= 0) return age === o.atAge;
  return (age - o.atAge) % o.everyYears === 0 && (o.untilAge === undefined || age < o.untilAge);
}

/** Whole months left in the tax year from `startDate` to the next 6 April (1 to 12). */
export function monthsLeftInTaxYear(startDate: string): number {
  const end = Date.UTC(taxYearStartYearOf(startDate) + 1, 3, 6);
  const [y, m, d] = startDate.split('-').map(Number);
  const days = (end - Date.UTC(y, m - 1, d)) / 86_400_000;
  const DAYS_PER_MONTH = 365.25 / MONTHS_PER_YEAR;
  return Math.min(MONTHS_PER_YEAR, Math.max(1, Math.round(days / DAYS_PER_MONTH)));
}

/** A year's returns compounded over a fraction of it. */
function partYearReturns(yr: YearReturns, frac: number): YearReturns {
  const part = (r: number) => Math.pow(1 + r, frac) - 1;
  return { equities: part(yr.equities), bonds: part(yr.bonds), cash: part(yr.cash), property: part(yr.property), inflation: part(yr.inflation) };
}

/**
 * A tax year's rules for the part of it a plan covers: tax allowances, bands and thresholds
 * scaled by `frac`, so tax on a part year's income is that share of a full year's tax. Rates,
 * ages, contribution allowances and lifetime limits (Lump Sum Allowance, Premium Bonds) are unchanged.
 */
export function partYearRules(c: TaxYearConfig, frac: number): TaxYearConfig {
  const k = (v: number) => v * frac;
  return {
    ...c,
    personalAllowance: k(c.personalAllowance),
    taperThreshold: k(c.taperThreshold),
    incomeTaxBands: c.incomeTaxBands.map((b) => ({ ...b, upTo: b.upTo === null ? null : k(b.upTo) })),
    savings: { ...c.savings, startingRateBand: k(c.savings.startingRateBand), psaBasic: k(c.savings.psaBasic), psaHigher: k(c.savings.psaHigher), psaAdditional: k(c.savings.psaAdditional) },
    dividends: { ...c.dividends, allowance: k(c.dividends.allowance) },
    ni: { ...c.ni, primaryThreshold: k(c.ni.primaryThreshold), upperEarningsLimit: k(c.ni.upperEarningsLimit), lowerEarningsLimit: k(c.ni.lowerEarningsLimit) },
    cgt: { ...c.cgt, annualExempt: k(c.cgt.annualExempt) },
    // Contribution allowances (ISA, LISA, pension) are not scaled: what is left of them can all be
    // used in the rest of the tax year. The pension taper's income tests are, as income is.
    pension: { ...c.pension, taperThresholdIncome: k(c.pension.taperThresholdIncome), taperAdjustedIncome: k(c.pension.taperAdjustedIncome) },
  };
}

/**
 * Premium Bonds hold their value and pay tax-free prizes at an expected rate that does not move
 * with markets. Clear their investment mix and fees, so only that fixed rate applies.
 */
function withPremiumBondReturns(scenario: Scenario): Scenario {
  if (!scenario.accounts.some((a) => a.type === 'premiumBonds')) return scenario;
  return {
    ...scenario,
    accounts: scenario.accounts.map((a) => (a.type === 'premiumBonds'
      ? { ...a, allocation: { equities: 0, bonds: 0, cash: 1, property: 0 }, annualFeePct: 0, annualFeeFixed: undefined }
      : a)),
  };
}

function prepare(scenario: Scenario, config: ConfigBundle): Prepared {
  const issues = validateScenario(scenario, config);
  if (issues.length > 0) throw new Error(`Scenario is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  const people = scenario.people;
  const startAges = people.map((p) => ageAt(p.dateOfBirth, scenario.sim.startDate));
  const startAge0 = startAges[0];
  const T = scenario.sim.horizonAge - startAge0;
  const startYear = taxYearStartYearOf(scenario.sim.startDate);
  const labels = Array.from({ length: T }, (_, t) => taxYearLabel(startYear + t));
  const freezeEndStart = taxYearStartYear(config.taxProjection.thresholdsFrozenThroughTaxYear);

  const sp = config.statePension;
  const yearsFromBase = Math.max(0, startYear - taxYearStartYear(sp.baseTaxYear));
  // Bring the base-year rate up to the start year with mean assumptions. The start year's prices
  // are "today's money" (the price index is 1 then), so the uprated rate needs no deflating.
  let baseToToday = 1;
  for (let k = 1; k <= yearsFromBase; k++) {
    baseToToday *= 1 + statePensionGrowth(config.market.inflation.mean, config, taxYearStartYear(sp.baseTaxYear) + k);
  }
  const spStartAge = people.map((p) => statePensionStartAge(p, config));
  // State Pension age in whole years (ignoring deferral): NI stops and qualifying years stop accruing here.
  const niEndAge = people.map((p) => defaultStatePensionStartAge(p.dateOfBirth, sp.ageSchedule));
  const spEntitlementToday = people.map((p, i) => annualEntitlement(qualifyingYearsAtStart(p, startAges[i], niEndAge[i], sp, resolveTaxYear(config, labels[0], 1).ni.lowerEarningsLimit, config.market.inflation.mean), sp)
    * deferralMultiplier(spStartAge[i], niEndAge[i], sp) * baseToToday);

  const lsa = people.map(() => 0);
  for (const a of scenario.accounts) if (a.type === 'dcPension') lsa[a.ownerIndex] += a.taxFreeCashTaken ?? 0;

  return {
    scenario: withPremiumBondReturns(scenario),
    config,
    T,
    startAge0,
    ageOffset: startAges.map((a) => a - startAge0),
    labels,
    baseTax: labels.map((l) => resolveTaxYear(config, l, 1)),
    freezeEndStart,
    ...upratedBases(config, labels, startYear, freezeEndStart),
    spStartAge,
    niEndAge,
    spEntitlementToday,
    pensionAccessAge: scenario.accounts.map((a) => (a.type === 'dcPension' ? accessAgeForAccount(a, people[a.ownerIndex], config.pensionAccess) : Number.NaN)),
    firstCash: scenario.accounts.findIndex((a) => a.type === 'cash'),
    firstYearMonths: monthsLeftInTaxYear(scenario.sim.startDate),
    surplusTarget: scenario.surplus?.kind === 'invest' ? scenario.accounts.findIndex((a) => scenario.surplus?.kind === 'invest' && a.id === scenario.surplus.accountId) : -1,
    initialLsaUsed: lsa,
  };
}

/**
 * Simulate one run. Calls `record` once per simulated year, including
 * the year of failure; stops after a failure.
 */
function runOne(prep: Prepared, runIndex: number, deterministic: boolean, spendMultiplier: number, record: ((r: YearRecord) => void) | null): RunOutcome {
  const { scenario, config, T } = prep;
  const { people, accounts, properties } = scenario;
  const nP = people.length;
  const market = config.market;
  const surplusRule = scenario.surplus ?? { kind: 'cash' as const };
  const monthly = scenario.sim.stepsPerYear === MONTHS_PER_YEAR;
  const returnInput = { market, historical: config.historicalReturns, model: scenario.sim.returnModel, years: T, rng: mulberry32(runSeed(scenario.sim.seed, runIndex)), deterministic };
  // Annual steps: one entry per year. Monthly steps: packed monthly rates (12 per year).
  const returns: YearReturns[] = monthly ? []
    : deterministic ? Array.from({ length: T }, () => deterministicReturns(market)) : generateReturns(returnInput);
  const monthlyReturns = monthly ? generateMonthlyReturnsPacked(returnInput) : new Float64Array(0);
  const mr: YearReturns = { equities: 0, bonds: 0, cash: 0, property: 0, inflation: 0 };
  const firstTaxYear = taxYearStartYear(prep.labels[0]);
  const monthlyFee = accounts.map((a) => 1 - Math.pow(1 - a.annualFeePct, 1 / MONTHS_PER_YEAR));
  /** Flat fees come out of the balance after returns, never taking it below zero. */
  const fixedFee = accounts.map((a) => a.annualFeeFixed ?? 0);
  const afterFixedFee = (b: number, a: number, fee: number) => (fee > 0 ? Math.max(0, b - fee) : b);
  // Premium Bonds grow at a fixed expected prize rate instead of market returns.
  const prizeRate = accounts.map((a) => (a.type === 'premiumBonds' ? a.prizeRate ?? market.premiumBondsPrizeRate : null));
  const prizeRateMonthly = prizeRate.map((r) => (r === null ? null : Math.pow(1 + r, 1 / MONTHS_PER_YEAR) - 1));
  /** Growth of account `a` over one step: prizes for Premium Bonds, else the market return less fees. */
  const grow = (b: number, a: number, yr: YearReturns, fee: number, prize: (number | null)[]) => {
    const p = prize[a];
    return p !== null ? b * (1 + p) : b * (1 + accountReturn(accounts[a].allocation, yr, fee));
  };
  /** Prizes that take someone over the Premium Bonds holding limit are paid out into cash. */
  const capBonds = (b: number[], limit: number) => {
    if (prep.firstCash < 0) return;
    for (let i = 0; i < nP; i++) {
      let over = -limit;
      for (let a = 0; a < accounts.length; a++) if (prizeRate[a] !== null && accounts[a].ownerIndex === i) over += b[a];
      for (let a = accounts.length - 1; a >= 0 && over > 0; a--) {
        if (prizeRate[a] === null || accounts[a].ownerIndex !== i) continue;
        const take = Math.min(over, b[a]);
        b[a] -= take; b[prep.firstCash] += take; over -= take;
      }
    }
  };
  const monthlyGrowth = properties.map((p) => ({ own: monthlyRate(p.growthRealPct), market: monthlyRate(market.property.meanReal) }));

  let ws: WithdrawalState = {
    balances: accounts.map((a) => a.balance),
    giaBasis: accounts.map((a) => (a.type === 'gia' ? a.giaCostBasis ?? a.balance : 0)),
    lsaUsed: [...prep.initialLsaUsed],
    mpaaTriggered: people.map((p) => p.mpaaTriggered === true),
  };
  const propValue = properties.map((p) => p.value);   // a home still to buy: its price, growing until bought
  const owned = properties.map((p) => p.buyAtAge === undefined || p.buyAtAge <= prep.startAge0);
  const mort: (MortgageState | null)[] = properties.map((p, pi) => (owned[pi] && p.mortgage && p.mortgage.balance > 0 ? initialMortgageState(p.mortgage) : null));
  // Rent with no end age stops when a main home is bought.
  const firstPurchaseAge = Math.min(...properties.filter((p) => p.isMainResidence && p.buyAtAge !== undefined && p.buyAtAge > prep.startAge0).map((p) => p.buyAtAge as number));
  const pendingLump = properties.map(() => 0);
  const downsized = properties.map(() => false);
  const lisaOpen = accounts.map((a) => a.type === 'lisa' && a.balance > 0);   // a LISA with money in it is already open
  /** New money paid into a GIA is not a gain: raise its cost basis by the amount credited. */
  const creditGiaBasis = (a: number, amount: number) => { if (accounts[a].type === 'gia' && amount > 0) ws.giaBasis[a] += amount; };
  const flags: RunFlags = { pensionCapped: false, allowanceTapered: false, isaOverflow: false, premiumBondsOverflow: false, lisaIneligible: false, mortgageLumpSum: false, downsizeShortfall: false, lsaExhausted: false };

  let index = 1;
  let spIndex = 1;
  let freezeIndex = prep.freezeEndStart < taxYearStartYear(prep.labels[0]) ? 1 : Number.NaN;
  let prevW: number | undefined;
  let prevInflation = market.inflation.mean;
  let lastCash = deterministicReturns(market).cash;
  const salary = new Array<number>(nP).fill(0);
  const statePension = new Array<number>(nP).fill(0);
  const taxableStreams = new Array<number>(nP).fill(0);
  const otherStreams = new Array<number>(nP).fill(0);
  const yearStartIndex = new Array<number>(T).fill(1);

  for (let t = 0; t < T; t++) {
    const age0 = prep.startAge0 + t;
    const label = prep.labels[t];
    if (taxYearStartYear(label) === prep.freezeEndStart) freezeIndex = index;
    yearStartIndex[t] = index;
    const fi = Number.isNaN(freezeIndex) ? 1 : freezeIndex;
    const base = prep.upratedBase[t];
    const bt = prep.upratedBaseT[t];
    const baseFactor = base === undefined ? 1 : thresholdFactor(config, base, bt >= 0 ? yearStartIndex[bt] : 1, fi);
    const factor = thresholdFactor(config, label, index, fi) / baseFactor;
    // The first tax year is usually part-way through: count only the months left in it. Flows and
    // annual allowances are scaled together, so tax is that share of a full year's tax.
    const months = t === 0 ? prep.firstYearMonths : MONTHS_PER_YEAR;
    const frac = months / MONTHS_PER_YEAR;
    const fullCfg = factor === 1 ? prep.baseTax[t] : resolveTaxYear(config, label, factor);
    const cfg = frac < 1 ? partYearRules(fullCfg, frac) : fullCfg;
    const ages = prep.ageOffset.map((o) => age0 + o);
    const portfolioAtStart = ws.balances.reduce((s, b) => s + b, 0);

    // Income
    let rentTotal = 0;
    properties.forEach((p, pi) => { if (owned[pi]) rentTotal += rentNominal(p, index); });
    for (let i = 0; i < nP; i++) {
      salary[i] = grossSalary(people[i], ages[i], t, index);
      statePension[i] = ages[i] >= prep.spStartAge[i] ? prep.spEntitlementToday[i] * spIndex : 0;
      taxableStreams[i] = 0; otherStreams[i] = 0;
    }
    for (const s of scenario.incomeStreams) {
      const a = ages[s.personIndex];
      if (a < s.startAge || (s.endAge !== undefined && a >= s.endAge)) continue;
      const amt = s.annualAmount * (s.inflationLinked ? index : 1);
      if (s.taxable) taxableStreams[s.personIndex] += amt; else otherStreams[s.personIndex] += amt;
    }
    if (frac < 1) {
      rentTotal *= frac;
      for (let i = 0; i < nP; i++) { salary[i] *= frac; statePension[i] *= frac; taxableStreams[i] *= frac; otherStreams[i] *= frac; }
    }

    // Property events: downsize, last year's mortgage lump sums, this year's mortgage schedule
    const balances = [...ws.balances];
    let mortgagePayments = 0;
    let mortgageInterest = 0;
    let lumpSums = 0;
    let propertyCosts = 0;
    let downsizeShortfall = 0;
    let homePurchase = 0;
    let lisaHomeOk = false;
    properties.forEach((p, pi) => {
      if (!owned[pi]) {
        if (p.buyAtAge === undefined || age0 < p.buyAtAge) return;
        // Buying now: the deposit, stamp duty and fees come from savings; the rest is the new mortgage.
        owned[pi] = true;
        const price = propValue[pi];
        const deposit = price * Math.min(1, Math.max(0, p.depositPct ?? 1));
        // First-time relief (and a LISA) only for a main home bought with no other home owned; owning another adds the surcharge.
        const ownsAnother = owned.some((o, k) => o && k !== pi);
        const ftb = p.firstTimeBuyer === true && p.isMainResidence && !ownsAnother;
        homePurchase += deposit + stampDuty(price, ftb, cfg.stampDuty, ownsAnother) + (p.buyingCosts ?? 0) * index;
        if (ftb && price <= cfg.lisa.homePriceCap) lisaHomeOk = true;
        const loan = price - deposit;
        if (p.mortgage && loan > 0) mort[pi] = initialMortgageState({ ...p.mortgage, balance: loan });
        rentTotal += rentNominal(p, index) * frac;   // a let property earns rent from the year it is bought
      }
      const d = p.downsize;
      if (d && p.isMainResidence && !downsized[pi] && age0 >= d.atAge) {
        downsized[pi] = true;
        const debt = (mort[pi]?.balance ?? 0) + pendingLump[pi];
        const res = downsize(propValue[pi], d.newValue, index, debt);
        propValue[pi] = res.newValue;
        mort[pi] = null;
        pendingLump[pi] = 0;
        const target = accounts.findIndex((a) => a.id === d.releaseToAccountId);
        if (res.releasedEquity > 0 && target >= 0) { balances[target] += res.releasedEquity; creditGiaBasis(target, res.releasedEquity); }
        else if (res.releasedEquity < 0) { downsizeShortfall += -res.releasedEquity; flags.downsizeShortfall = true; }
      }
      lumpSums += pendingLump[pi];
      pendingLump[pi] = 0;
      const m = mort[pi];
      if (m && !monthly) {
        const y = scheduleMonths(m, months);
        mortgagePayments += y.payments;
        mortgageInterest += y.interest;
        if (y.lumpSumDue > 0) { pendingLump[pi] = y.lumpSumDue; flags.mortgageLumpSum = true; }
        mort[pi] = y.endBalance > 0 ? y.endState : null;
      }
      propertyCosts += runningCostsNominal(p, index, downsized[pi], propValue[pi]) * frac;
    });
    const rentShare = rentTotal / nP;
    // Rent on a home and one-off costs: paid on top of the spending plan, like a mortgage.
    let rentPaid = 0;
    for (const r of scenario.rentPaid ?? []) {
      const rentEnd = r.untilAge ?? ((r.fromAge ?? 0) < firstPurchaseAge ? firstPurchaseAge : Number.POSITIVE_INFINITY);
      if (age0 < (r.fromAge ?? 0) || age0 >= rentEnd) continue;
      rentPaid += r.monthly * MONTHS_PER_YEAR * index * Math.pow(1 + r.growthRealPct, t) * frac;
    }
    let oneOffCosts = 0;
    for (const o of scenario.oneOffCosts ?? []) if (oneOffDue(o, age0)) oneOffCosts += o.amount * (o.inflationLinked ? index : 1);

    // Contributions (start of year, before returns)
    const personYears: PersonYear[] = people.map((_, i) => ({ age: ages[i], grossSalary: salary[i], mpaaTriggered: ws.mpaaTriggered[i], otherTaxableIncome: statePension[i] + taxableStreams[i] + rentShare }));
    // Premium Bonds room per person: the holding limit less what they hold now (the limit is not uprated).
    const bondRoom = people.map((_, i) => Math.max(0, cfg.premiumBonds.holdingLimit - accounts.reduce((s, acc, a) => s + (acc.type === 'premiumBonds' && acc.ownerIndex === i ? ws.balances[a] : 0), 0)));
    const plan = planContributions(scenario.contributions, accounts, people, personYears, t, index, cfg, lisaOpen, bondRoom, frac);
    for (const a of plan.lisaOpened) lisaOpen[a] = true;
    // Spare income this year and where it goes (Scenario.surplus).
    let spareIncome = 0;
    const isaRoom = [...plan.isaRoomLeft];
    const overflowAccount = (person: number) => {
      const gia = accounts.findIndex((acc) => acc.type === 'gia' && acc.ownerIndex === person);
      return gia >= 0 ? gia : prep.firstCash;
    };
    /** Pay `amount` of spare income into `bal` (mutated) following the surplus rule. */
    const routeSurplus = (amount: number, bal: number[]) => {
      if (amount <= 0) return;
      spareIncome += amount;
      const credit = (a: number, x: number) => { if (a >= 0 && x > 0) { bal[a] += x; creditGiaBasis(a, x); } };
      if (surplusRule.kind === 'spend') return;
      if (surplusRule.kind === 'cash' || prep.surplusTarget < 0) { credit(prep.firstCash, amount); return; }
      const target = accounts[prep.surplusTarget];
      if (target.type !== 'isa') { credit(prep.surplusTarget, amount); return; }
      const take = Math.min(amount, Math.max(0, isaRoom[target.ownerIndex]));
      isaRoom[target.ownerIndex] -= take;
      credit(prep.surplusTarget, take);
      if (amount - take > 0) { flags.isaOverflow = true; credit(overflowAccount(target.ownerIndex), amount - take); }
    };
    if (!monthly) for (let a = 0; a < balances.length; a++) { balances[a] += plan.credits[a]; creditGiaBasis(a, plan.credits[a]); }
    /** One-off lump sums go in at the end of the tax year, after its returns. */
    const addYearEnd = (b: number[]) => { for (let a = 0; a < b.length; a++) { b[a] += plan.yearEndCredits[a]; creditGiaBasis(a, plan.yearEndCredits[a]); } };
    flags.pensionCapped ||= plan.pensionCapped;
    flags.allowanceTapered ||= plan.allowanceTapered;
    flags.isaOverflow ||= plan.isaOverflow;
    flags.premiumBondsOverflow ||= plan.premiumBondsOverflow;
    flags.lisaIneligible ||= plan.lisaIneligible;

    // Baseline tax per person (non-savings income + estimated investment income) and NI
    const incomes: TaxableIncome[] = [];
    // Estimated GIA income per £ held (interest on bonds/cash + equity dividends). It is taxed
    // below, and as it is reinvested it is added to the cost basis at year end (so it is not taxed again as a gain).
    const giaIncomeRate = accounts.map((acc) => (acc.type === 'gia'
      ? ((acc.allocation.bonds + acc.allocation.cash) * Math.max(0, lastCash) + acc.allocation.equities * market.equityDividendYield) * frac : 0));
    const giaStart = [...balances];
    /**
     * Estimated savings interest and dividends for person i on the amounts `held` in each
     * cash account and GIA. The baseline uses start-of-year balances; once the year's
     * withdrawals are known it is re-estimated on what was actually kept (see below).
     */
    const investmentIncome = (i: number, held: (a: number) => number): { savings: number; dividends: number } => {
      let savings = 0;
      let dividends = 0;
      accounts.forEach((acc, a) => {
        if (acc.ownerIndex !== i) return;
        if (acc.type === 'cash') savings += held(a) * Math.max(0, lastCash);
        else if (acc.type === 'gia') {
          savings += held(a) * (acc.allocation.bonds + acc.allocation.cash) * Math.max(0, lastCash);
          dividends += held(a) * acc.allocation.equities * market.equityDividendYield;
        }
      });
      return { savings: savings * frac, dividends: dividends * frac };
    };
    /** Money kept all year: the smaller of the start balance and the balance after withdrawals. */
    const keptOf = (after: number[]) => (a: number) => Math.min(giaStart[a], after[a]);
    let baselineTax = 0;
    let incomeTaxTotal = 0;
    let niTotal = 0;
    for (let i = 0; i < nP; i++) {
      const income: TaxableIncome = {
        nonSavings: Math.max(0, salary[i] - plan.netPayGross[i]) + statePension[i] + taxableStreams[i],
        property: rentShare,
        ...investmentIncome(i, (a) => balances[a]),
      };
      incomes.push(income);
      const tax = calculateIncomeTax(income, cfg, { basicBandExtension: plan.reliefAtSourceGross[i] }).total;
      const ni = ages[i] >= prep.niEndAge[i] ? 0 : calculateNI(salary[i], cfg);
      incomeTaxTotal += tax; niTotal += ni;
      baselineTax += tax + ni;
    }

    // Spending strategy
    const retired = age0 >= people[0].retirementAge;
    const W = targetSpend({
      strategy: scenario.strategy,
      phaseSpendToday: plannedSpendToday(scenario.spending, age0, prep.startAge0, index) * spendMultiplier,
      inflationIndex: index,
      retired,
      portfolioAtStart,
      prevW,
      prevInflation,
    });
    if (retired) prevW = W;
    const spend = W * frac;   // the strategy works in whole years; the first year spends its share

    // A first-time buyer's LISA goes towards the deposit first (no charge within the price cap).
    let lisaForHome = 0;
    if (homePurchase > 0 && lisaHomeOk) {
      accounts.forEach((acc, a) => {
        if (acc.type !== 'lisa') return;
        const take = Math.min(balances[a], homePurchase - lisaForHome);
        balances[a] -= take; lisaForHome += take;
      });
    }
    let inflows = rentTotal;
    for (let i = 0; i < nP; i++) inflows += salary[i] + statePension[i] + taxableStreams[i] + otherStreams[i];
    const need = householdNeed({
      targetSpend: spend, mortgagePayments, mortgageLumpSums: lumpSums, propertyCosts, rentPaid, oneOffCosts, otherOutgoings: downsizeShortfall + homePurchase - lisaForHome,
      taxes: baselineTax, contributionsFromTakeHome: plan.fromTakeHome, inflows,
    });

    let draws = emptyByType();
    let extraTax = 0;
    let cgt = 0;
    let failed = false;
    let indexEnd: number;
    let yearInflation: number;
    let yearCash: number;
    let nextBalances: number[];
    const wPeople = people.map((_, i) => ({ age: ages[i], income: incomes[i], basicBandExtension: plan.reliefAtSourceGross[i] }));
    const pensionFirst = scenario.pensionDrawdown === 'allowance' || scenario.pensionDrawdown === 'basicRate' ? scenario.pensionDrawdown : undefined;
    const wctx = { accounts, order: scenario.withdrawalOrder, cfg, people: wPeople, pensionAccessAge: prep.pensionAccessAge, pensionFirst };

    if (!monthly) {
      if (need <= 0) {
        routeSurplus(-need, balances);
        ws = { ...ws, balances };
      } else {
        const res = executeWithdrawals(wctx, need, { ...ws, balances });
        ws = res.state;
        draws = res.net;
        extraTax = res.pensionTax;
        cgt = res.cgt;
        failed = res.unmet > SHORTFALL_TOLERANCE_GBP;
      }
      if (!failed) {
        // The baseline taxed interest and dividends on start-of-year balances, but money sold at the
        // start of the year earns none: re-estimate on what was kept and refund the difference to cash.
        // The refund itself is kept in cash, so re-estimate a few times (it converges quickly).
        const REFUND_ROUNDS = 3;
        let refund = 0;
        let kept = keptOf(ws.balances);
        for (let round = 0; round < REFUND_ROUNDS && prep.firstCash >= 0; round++) {
          refund = 0;
          for (let i = 0; i < nP; i++) {
            const opts = { basicBandExtension: plan.reliefAtSourceGross[i] };
            refund += calculateIncomeTax(incomes[i], cfg, opts).total - calculateIncomeTax({ ...incomes[i], ...investmentIncome(i, kept) }, cfg, opts).total;
          }
          const withRefund = ws.balances.map((b, a) => (a === prep.firstCash ? b + Math.max(0, refund) : b));
          kept = keptOf(withRefund);
        }
        if (refund > 0 && prep.firstCash >= 0) {
          const bal = [...ws.balances];
          routeSurplus(refund, bal);
          ws = { ...ws, balances: bal };
          incomeTaxTotal -= refund;
        }
        for (let a = 0; a < accounts.length; a++) creditGiaBasis(a, giaIncomeRate[a] * kept(a));
      }
      // Returns on what is left, then property growth
      const yr = frac < 1 ? partYearReturns(returns[t], frac) : returns[t];
      const prize = frac < 1 ? prizeRate.map((r) => (r === null ? null : Math.pow(1 + r, frac) - 1)) : prizeRate;
      nextBalances = failed ? ws.balances.map(() => 0) : ws.balances.map((b, a) => afterFixedFee(grow(b, a, yr, 1 - Math.pow(1 - accounts[a].annualFeePct, frac), prize), a, fixedFee[a] * index * frac));
      if (!failed) addYearEnd(nextBalances);
      capBonds(nextBalances, cfg.premiumBonds.holdingLimit);   // after year-end payments, so they cannot exceed the limit
      ws = { ...ws, balances: nextBalances };
      properties.forEach((p, pi) => { propValue[pi] *= 1 + propertyNominalReturn(yr, p.growthRealPct, market.property.meanReal); });
      indexEnd = index * (1 + yr.inflation);
      yearInflation = returns[t].inflation;   // a full year's rate, for the State Pension increase and guardrails
      yearCash = returns[t].cash;
    } else {
      // Monthly steps (Phase 13): a twelfth of the year's flows each month, monthly returns,
      // pension/GIA draws taken gross with tax settled at the end of the tax year.
      const pensionTaxable = people.map(() => 0);
      const gains = people.map(() => 0);
      const deferCtx = { ...wctx, deferTax: true };
      // Baseline income tax and NI are paid as they go (PAYE-style); only the extra is settled at year end.
      const regular = (spend + propertyCosts + rentPaid + plan.fromTakeHome + baselineTax - inflows) / months;
      const creditM = plan.credits.map((c) => c / months);
      const firstMonth = MONTHS_PER_YEAR - months;   // a part year runs its last `months` months
      let drawnThisYear = 0;
      const nA = accounts.length;
      let bal = balances;            // owned by this loop; updated in place
      let monthIndex = index;
      let cashGrowth = 1;
      for (let k = firstMonth; k < MONTHS_PER_YEAR && !failed; k++) {
        let mortgageMonth = 0;
        for (let pi = 0; pi < properties.length; pi++) {
          const m = mort[pi];
          if (!m) continue;
          const y = scheduleMonths(m, 1);
          mortgageMonth += y.payments;
          mortgageInterest += y.interest;
          if (y.lumpSumDue > 0) { pendingLump[pi] = y.lumpSumDue; flags.mortgageLumpSum = true; }
          mort[pi] = y.endBalance > 0 ? y.endState : null;
        }
        mortgagePayments += mortgageMonth;
        for (let a = 0; a < nA; a++) { bal[a] += creditM[a]; creditGiaBasis(a, creditM[a]); }
        const needM = regular + mortgageMonth + (k === firstMonth ? lumpSums + downsizeShortfall + oneOffCosts + homePurchase - lisaForHome : 0);
        if (needM <= 0) {
          // Like annual steps, a later month's spare money first replaces what was drawn earlier this
          // year (kept in cash); only the rest is spare income.
          const repay = prep.firstCash >= 0 ? Math.min(-needM, drawnThisYear) : 0;
          if (repay > 0) { bal[prep.firstCash] += repay; drawnThisYear -= repay; }
          routeSurplus(-needM - repay, bal);
        } else {
          // Earlier months' taxable pension counts against this year's allowance room.
          const monthCtx = { ...deferCtx, people: wPeople.map((p, i) => ({ ...p, priorPensionTaxable: pensionTaxable[i] })) };
          const res = executeWithdrawals(monthCtx, needM, { ...ws, balances: bal });
          ws = res.state;
          bal = ws.balances;
          draws.cash += res.net.cash; draws.gia += res.net.gia; draws.isa += res.net.isa; draws.lisa += res.net.lisa; draws.premiumBonds += res.net.premiumBonds; draws.dcPension += res.net.dcPension;
          for (let i = 0; i < nP; i++) { pensionTaxable[i] += res.pensionTaxable[i]; gains[i] += res.gains[i]; }
          failed = res.unmet > SHORTFALL_TOLERANCE_GBP;
          drawnThisYear += needM - res.unmet;
        }
        unpackReturn(monthlyReturns, t * MONTHS_PER_YEAR + k, mr);
        if (failed) bal.fill(0);
        else {
          for (let a = 0; a < nA; a++) bal[a] = afterFixedFee(grow(bal[a], a, mr, monthlyFee[a], prizeRateMonthly), a, fixedFee[a] * index / MONTHS_PER_YEAR);
          capBonds(bal, cfg.premiumBonds.holdingLimit);
        }
        if (k === MONTHS_PER_YEAR - 1 && !failed) { addYearEnd(bal); capBonds(bal, cfg.premiumBonds.holdingLimit); }
        for (let pi = 0; pi < properties.length; pi++) propValue[pi] *= 1 + propertyNominalReturn(mr, monthlyGrowth[pi].own, monthlyGrowth[pi].market);
        monthIndex *= 1 + mr.inflation;
        cashGrowth *= 1 + mr.cash;
      }
      ws = { ...ws, balances: bal };
      // Year-end tax settlement: income tax on the whole year's income including taxable
      // pension draws, CGT on the year's gains, NI; then draw the bill like any other need.
      // The tax is recorded even if the run failed during the year (it is just not paid).
      let bill = niTotal - baselineTax;   // the baseline (income tax + NI) was paid monthly
      const baselineIncomeTax = incomeTaxTotal;
      // Interest and dividends re-estimated on the money kept all year (sold money earns none).
      const kept = keptOf(bal);
      const settledIncomes = incomes.map((inc, i) => ({ ...inc, ...investmentIncome(i, kept) }));
      const cgtByPerson = people.map(() => 0);
      let keptIncomeTax = 0;
      incomeTaxTotal = 0;
      people.forEach((_, i) => {
        const opts = { basicBandExtension: plan.reliefAtSourceGross[i] };
        keptIncomeTax += calculateIncomeTax(settledIncomes[i], cfg, opts).total;
        const r = calculateIncomeTax({ ...settledIncomes[i], nonSavings: settledIncomes[i].nonSavings + pensionTaxable[i] }, cfg, opts);
        incomeTaxTotal += r.total;
        cgtByPerson[i] = calculateCGT(gains[i], r.taxableIncome, cfg, plan.reliefAtSourceGross[i]);
        cgt += cgtByPerson[i];
      });
      const pensionIncomeTax = incomeTaxTotal - keptIncomeTax;
      void baselineIncomeTax;
      bill += incomeTaxTotal + cgt;
      if (failed) {
        draws.dcPension = Math.max(0, draws.dcPension - pensionIncomeTax);
        draws.gia = Math.max(0, draws.gia - cgt);
      } else if (bill <= 0) {
        // Less tax due than was paid monthly (investment income was over-estimated): refund to cash.
        const refundBal = [...ws.balances];
        routeSurplus(-bill, refundBal);
        ws = { ...ws, balances: refundBal };
        draws.dcPension = Math.max(0, draws.dcPension - pensionIncomeTax);
        draws.gia = Math.max(0, draws.gia - cgt);
      } else {
        const settlePeople = wPeople.map((p, i) => ({ ...p, income: settledIncomes[i], priorPensionTaxable: pensionTaxable[i], priorGains: gains[i], priorCgt: cgtByPerson[i] }));
        const settle = executeWithdrawals({ ...wctx, people: settlePeople }, bill, ws);
        ws = settle.state;
        for (const key of Object.keys(draws) as AccountType[]) draws[key] += settle.net[key];
        extraTax = settle.pensionTax;
        cgt += settle.cgt;
        // Report withdrawals net of the tax they caused, as annual mode does.
        // (settle.net already excludes the tax on the settlement draw itself.)
        draws.dcPension = Math.max(0, draws.dcPension - pensionIncomeTax);
        draws.gia = Math.max(0, draws.gia - (cgt - settle.cgt));
        failed = settle.unmet > SHORTFALL_TOLERANCE_GBP;
        if (failed) ws = { ...ws, balances: ws.balances.map(() => 0) };
      }
      nextBalances = ws.balances;
      // Reinvested GIA income was taxed this year: add it to the cost basis.
      if (!failed) for (let a = 0; a < accounts.length; a++) creditGiaBasis(a, giaIncomeRate[a] * kept(a));
      indexEnd = monthIndex;
      // Whole-year rates (a part year is annualised) for next year's State Pension rise and cash estimate.
      yearInflation = Math.pow(monthIndex / index, MONTHS_PER_YEAR / months) - 1;
      yearCash = Math.pow(cashGrowth, MONTHS_PER_YEAR / months) - 1;
    }
    if (ws.lsaUsed.some((u) => u >= cfg.pension.lumpSumAllowance)) flags.lsaExhausted = true;

    if (record) {
      const mortgageBalanceEnd = mort.reduce((s, m) => s + (m?.balance ?? 0), 0) + pendingLump.reduce((s, v) => s + v, 0);
      draws.lisa += lisaForHome;
      record({
        t, index, indexEnd,
        salary: salary.reduce((s, v) => s + v, 0),
        statePension: statePension.reduce((s, v) => s + v, 0),
        otherIncome: taxableStreams.reduce((s, v) => s + v, 0) + otherStreams.reduce((s, v) => s + v, 0),
        rental: rentTotal,
        draws,
        spending: spend,
        rentPaid,
        oneOffCosts,
        homePurchase,
        months,
        mortgagePayments: mortgagePayments + lumpSums,
        mortgageInterest,
        propertyCosts,
        incomeTax: incomeTaxTotal + extraTax,
        ni: niTotal,
        cgt,
        savedFromPay: plan.fromTakeHome,
        spareIncome,
        portfolioEnd: nextBalances.reduce((s, v) => s + v, 0),
        propertyEquityEnd: propValue.reduce((s, v, pi) => s + (owned[pi] ? v : 0), 0) - mortgageBalanceEnd,
        mortgageBalanceEnd,
      });
    }
    if (failed) return { failedAtAge: age0, flags };

    spIndex *= 1 + statePensionGrowth(yearInflation, config, firstTaxYear + t + 1);   // the increase for next tax year
    prevInflation = indexEnd / index - 1;   // prices over the year actually simulated (part of one, at first)
    lastCash = yearCash;
    index = indexEnd;
  }
  return { failedAtAge: -1, flags };
}

/** A simulation that can be run in chunks (the worker yields between chunks to allow cancel). */
export interface Simulation {
  totalRuns: number;
  /** Run runs [from, to). Results are identical however the runs are chunked. */
  runChunk(from: number, to: number): void;
  /** Aggregate everything run so far into a SimulationResult. */
  finish(durationMs?: number): SimulationResult;
}

/** Set up a Monte Carlo simulation (validates; throws on an invalid scenario). */
export function createSimulation(scenario: Scenario, config: ConfigBundle, opts: SimOpts = {}): Simulation {
  const prep = prepare(scenario, config);
  const { T } = prep;
  const deterministic = opts.deterministic === true;
  const runs = deterministic ? 1 : Math.max(1, Math.floor(opts.runsOverride ?? scenario.sim.runs));
  const mult = opts.spendMultiplier ?? 1;
  const full = opts.successOnly !== true;

  const failedAt = new Int32Array(runs).fill(-1);
  const portfolioReal = full ? new Float64Array(runs * T) : new Float64Array(0);
  const portfolioNominal = full ? new Float64Array(runs * T) : new Float64Array(0);
  const netWorthReal = full ? new Float64Array(runs * T) : new Float64Array(0);
  const netWorthNominal = full ? new Float64Array(runs * T) : new Float64Array(0);
  const taxPerRun = new Float64Array(runs);
  // Lowest yearly spending in retirement per run (today's money, whole-year rate); 0 if the money ran out.
  const lowSpendPerRun = new Float64Array(runs);
  const retireAge0 = prep.scenario.people[0].retirementAge;
  const taxByAge = new Float64Array(T);
  const income: Record<IncomeKey, Float64Array> = Object.fromEntries(INCOME_KEYS.map((k) => [k, new Float64Array(T)])) as Record<IncomeKey, Float64Array>;
  // Per-age means average over runs that met spending in full that year, so failed runs
  // (and the partial year they fail in) do not drag the averages towards zero.
  const funded = new Float64Array(T);
  const runIncome: Record<IncomeKey, Float64Array> = Object.fromEntries(INCOME_KEYS.map((k) => [k, new Float64Array(T)])) as Record<IncomeKey, Float64Array>;
  const runTax = new Float64Array(T);
  const flagCounts: Record<keyof RunFlags, number> = { pensionCapped: 0, allowanceTapered: 0, isaOverflow: 0, premiumBondsOverflow: 0, lisaIneligible: 0, mortgageLumpSum: 0, downsizeShortfall: 0, lsaExhausted: 0 };
  let completed = 0;

  const runChunk = (from: number, to: number) => {
    for (let r = from; r < Math.min(to, runs); r++) {
      let lastNetWorthReal = 0;
      let lastNetWorthNominal = 0;
      let lastT = -1;
      let lowSpend = Number.POSITIVE_INFINITY;
      const out = runOne(prep, r, deterministic, mult, full ? (y) => {
        if (prep.startAge0 + y.t >= retireAge0) lowSpend = Math.min(lowSpend, (y.spending / y.index) * (MONTHS_PER_YEAR / y.months));
        const i = r * T + y.t;
        portfolioReal[i] = y.portfolioEnd / y.indexEnd;
        portfolioNominal[i] = y.portfolioEnd;
        netWorthReal[i] = (y.portfolioEnd + y.propertyEquityEnd) / y.indexEnd;
        netWorthNominal[i] = y.portfolioEnd + y.propertyEquityEnd;
        lastNetWorthReal = y.propertyEquityEnd / y.indexEnd;
        lastNetWorthNominal = y.propertyEquityEnd;
        lastT = y.t;
        // Flows are in today's money at the start of the year they happen.
        runIncome.salary[y.t] = y.salary / y.index;
        runIncome.statePension[y.t] = y.statePension / y.index;
        runIncome.otherIncome[y.t] = y.otherIncome / y.index;
        runIncome.rental[y.t] = y.rental / y.index;
        for (const k of ['cash', 'gia', 'isa', 'lisa', 'premiumBonds', 'dcPension'] as AccountType[]) runIncome[k][y.t] = y.draws[k] / y.index;
        const tax = (y.incomeTax + y.ni + y.cgt) / y.index;
        runTax[y.t] = tax;
        taxPerRun[r] += tax;
      } : null);
      if (full) {
        lowSpendPerRun[r] = out.failedAtAge >= 0 ? 0 : Number.isFinite(lowSpend) ? lowSpend : 0;
        const fundedYears = out.failedAtAge >= 0 ? lastT : lastT + 1;   // the failure year was not funded in full
        for (let t = 0; t < fundedYears; t++) {
          funded[t] += 1;
          taxByAge[t] += runTax[t];
          for (const k of INCOME_KEYS) income[k][t] += runIncome[k][t];
        }
      }
      failedAt[r] = out.failedAtAge;
      if (full && out.failedAtAge >= 0) {
        // After failure: zero portfolio; net worth keeps the remaining property equity, held
        // level in today's money and grown at mean inflation in nominal terms (the run has stopped).
        const inflate = 1 + config.market.inflation.mean;
        for (let t = lastT + 1; t < T; t++) {
          netWorthReal[r * T + t] = lastNetWorthReal;
          netWorthNominal[r * T + t] = lastNetWorthNominal * inflate ** (t - lastT);
        }
      }
      for (const k of Object.keys(flagCounts) as (keyof RunFlags)[]) if (out.flags[k]) flagCounts[k] += 1;
      completed = Math.max(completed, r + 1);
    }
  };

  const finish = (durationMs = 0): SimulationResult => {
    const n = completed;
    let failed = 0;
    for (let r = 0; r < n; r++) if (failedAt[r] >= 0) failed++;
    const meanFunded = (arr: Float64Array) => Array.from(arr, (v, t) => (funded[t] > 0 ? v / funded[t] : 0));
    const sortedTax = Float64Array.from(taxPerRun.subarray(0, n)).sort();

    const warnings: string[] = [];
    const share = (c: number) => `${Math.round((c / Math.max(1, n)) * PERCENT)}% of runs`;
    if (flagCounts.pensionCapped) warnings.push(`Pension contributions were capped by the annual allowance (or MPAA, or 100% of earnings, or the basic amount with no earnings) in ${share(flagCounts.pensionCapped)}.`);
    if (flagCounts.allowanceTapered) warnings.push(`A high income tapered the pension annual allowance and cut contributions in ${share(flagCounts.allowanceTapered)}. Carry-forward of unused allowance from earlier years is not modelled.`);
    if (flagCounts.premiumBondsOverflow) warnings.push(`Premium Bonds payments above the holding limit were kept as cash instead in ${share(flagCounts.premiumBondsOverflow)}.`);
    if (flagCounts.isaOverflow) warnings.push(`ISA/LISA contributions above the allowance were redirected to a GIA or cash account in ${share(flagCounts.isaOverflow)}.`);
    if (flagCounts.lisaIneligible) warnings.push('Some LISA contributions were outside the allowed ages (minimum age, latest opening age or contribution end age in Rules & Assumptions), so they were saved in a GIA or cash account instead, without the bonus.');
    if (flagCounts.mortgageLumpSum) warnings.push(`A mortgage balance remained at the end of its term and was paid as a lump sum in ${share(flagCounts.mortgageLumpSum)}.`);
    if (flagCounts.downsizeShortfall) warnings.push(`Downsizing released less than the new home and mortgage cost in ${share(flagCounts.downsizeShortfall)}; the shortfall was added to spending.`);
    if (flagCounts.lsaExhausted) warnings.push(`The Lump Sum Allowance was used up in ${share(flagCounts.lsaExhausted)}; later pension withdrawals are fully taxable.`);
    scenario.accounts.forEach((a, ai) => {
      if (a.type !== 'dcPension') return;
      const age = prep.pensionAccessAge[ai];
      const ownerAgeNow = prep.startAge0 + prep.ageOffset[a.ownerIndex];
      if (age > ownerAgeNow) warnings.push(`The pension “${a.name || 'DC pension'}” can’t be used until age ${age}, so it is not drawn before then.`);
    });

    let centralCase: CentralCaseRow[] = [];
    if (full) {
      const rows: CentralCaseRow[] = [];
      runOne(prep, 0, true, mult, (y) => {
        rows.push({
          age: prep.startAge0 + y.t,
          taxYear: prep.labels[y.t],
          salary: y.salary / y.index,
          statePension: y.statePension / y.index,
          otherIncome: y.otherIncome / y.index,
          rentalIncome: y.rental / y.index,
          drawCash: y.draws.cash / y.index,
          drawGia: y.draws.gia / y.index,
          drawIsa: y.draws.isa / y.index,
          drawLisa: y.draws.lisa / y.index,
          drawPension: y.draws.dcPension / y.index,
          drawPremiumBonds: y.draws.premiumBonds / y.index,
          spending: y.spending / y.index,
          mortgagePayments: y.mortgagePayments / y.index,
          mortgageInterest: y.mortgageInterest / y.index,
          propertyCosts: y.propertyCosts / y.index,
          rentPaid: y.rentPaid / y.index,
          oneOffCosts: y.oneOffCosts / y.index,
          homePurchase: y.homePurchase / y.index,
          taxPaid: (y.incomeTax + y.cgt) / y.index,
          niPaid: y.ni / y.index,
          savedFromPay: y.savedFromPay / y.index,
          spareIncome: y.spareIncome / y.index,
          portfolioEnd: y.portfolioEnd / y.indexEnd,
          propertyEquityEnd: y.propertyEquityEnd / y.indexEnd,
          mortgageBalanceEnd: y.mortgageBalanceEnd / y.indexEnd,
          priceIndex: y.index,
          months: y.months,
          priceIndexEnd: y.indexEnd,
        });
      });
      centralCase = rows;
    }

    const empty = { p5: [], p10: [], p25: [], p50: [], p75: [], p90: [], p95: [] };
    return {
      ages: Array.from({ length: T }, (_, t) => prep.startAge0 + t),
      runs: n,
      successRate: successRate(failed, n),
      depletionAgeHistogram: depletionHistogram(failedAt.subarray(0, n)),
      portfolioReal: full ? percentileBands(portfolioReal, n, T) : empty,
      portfolioNominal: full ? percentileBands(portfolioNominal, n, T) : empty,
      netWorthReal: full ? percentileBands(netWorthReal, n, T) : empty,
      netWorthNominal: full ? percentileBands(netWorthNominal, n, T) : empty,
      taxPaidTotal: { median: percentile(sortedTax, 0.5), p10: percentile(sortedTax, 0.1), p90: percentile(sortedTax, 0.9) },
      retirementSpendLow: full ? percentile(Float64Array.from(lowSpendPerRun.subarray(0, n)).sort(), 0.1) : undefined,
      fundedShareByAge: full ? Array.from(funded, (v) => (n > 0 ? v / n : 0)) : undefined,
      taxPaidByAgeMeanReal: meanFunded(taxByAge),
      incomeBySourceMeanReal: Object.fromEntries(INCOME_KEYS.map((k) => [k, meanFunded(income[k])])) as SimulationResult['incomeBySourceMeanReal'],
      centralCase,
      warnings,
      meta: { seed: scenario.sim.seed, durationMs, defaultsVersion: config.defaultsVersion },
    };
  };

  return { totalRuns: runs, runChunk, finish };
}

/**
 * Run the whole Monte Carlo simulation synchronously.
 * The UI never calls this directly: it goes through the Web Worker.
 */
export function simulate(scenario: Scenario, config: ConfigBundle, opts: SimOpts = {}): SimulationResult {
  const sim = createSimulation(scenario, config, opts);
  for (let from = 0; from < sim.totalRuns; from += PROGRESS_CHUNK_RUNS) {
    sim.runChunk(from, from + PROGRESS_CHUNK_RUNS);
    opts.onProgress?.(Math.min(from + PROGRESS_CHUNK_RUNS, sim.totalRuns), sim.totalRuns);
  }
  return sim.finish();
}

/** Max sustainable spend wired to this simulator. */
export function maxSustainableSpend(scenario: Scenario, config: ConfigBundle): MaxSpendOutcome {
  const steps = maxSustainableSpendSteps(scenario, config);
  for (;;) {
    const n = steps.next();
    if (n.done) return n.value;
  }
}

/** maxSustainableSpend as a generator that yields between simulations (used by the worker). */
export function* maxSustainableSpendSteps(scenario: Scenario, config: ConfigBundle, opts: { runs?: number; iterations?: number } = {}): Generator<number, MaxSpendOutcome> {
  // The search runs ~16 simulations; with monthly steps that is slow, so it uses annual steps
  // (start-of-year cash flows, slightly more conservative) and says so.
  const monthly = scenario.sim.stepsPerYear === MONTHS_PER_YEAR;
  const s = monthly ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  const out = yield* maxSpendSteps(s, config, scenario.sim.targetSuccessRate, {
    simulate: (sc, c, o) => simulate(sc, c, o),
  }, opts);
  return monthly ? { ...out, warnings: [...out.warnings, 'Estimated with annual time steps for speed (slightly conservative compared with monthly).'] } : out;
}

/** Earliest stop-work age at the target success rate, wired to this simulator (annual steps for speed). */
export function* earliestRetirementAgeSteps(scenario: Scenario, config: ConfigBundle): Generator<number, RetireAgeOutcome> {
  const s = scenario.sim.stepsPerYear === MONTHS_PER_YEAR ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  return yield* earliestRetirementSteps(s, config, { simulate: (sc, c, o) => simulate(sc, c, o) });
}

/** The quicker max-spend search for the what-if panel; yields between simulations. */
export function quickMaxSpendSteps(scenario: Scenario, config: ConfigBundle): Generator<number, MaxSpendOutcome> {
  return maxSustainableSpendSteps(scenario, config, { runs: QUICK_SPEND_RUNS, iterations: QUICK_SPEND_ITERATIONS });
}

/**
 * A quick check for the what-if sliders: up to `runs` runs, annual steps. Returns the success
 * rate, the depletion histogram ("how long the money lasts") and the portfolio bands for the preview chart.
 */
export function quickCheck(scenario: Scenario, config: ConfigBundle, runs: number): Pick<SimulationResult, 'ages' | 'runs' | 'successRate' | 'depletionAgeHistogram' | 'portfolioReal'> {
  const s = scenario.sim.stepsPerYear === MONTHS_PER_YEAR ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  const r = simulate(s, config, { runsOverride: Math.min(scenario.sim.runs, runs) });
  return { ages: r.ages, runs: r.runs, successRate: r.successRate, depletionAgeHistogram: r.depletionAgeHistogram, portfolioReal: r.portfolioReal };
}

export { MAX_SPEND_STEPS };
