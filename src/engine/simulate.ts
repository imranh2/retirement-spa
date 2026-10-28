import type { AccountType, CentralCaseRow, Scenario, SimulationResult } from '../model/types';
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
import { initialMortgageState, scheduleMonths, scheduleYear, type MortgageState } from './mortgage';
import { downsize, rentNominal, runningCostsNominal } from './property';
import { grossSalary, planContributions, type PersonYear } from './contributions';
import { emptyByType, executeWithdrawals, householdNeed, phaseSpend, targetSpend, type ByType, type WithdrawalState } from './withdrawal';
import { earliestRetirementSteps } from './retireAge';
import type { RetireAgeOutcome } from '../model/retirement';
import { depletionHistogram, MAX_SPEND_STEPS, maxSpendSteps, percentile, percentileBands, successRate, type MaxSpendOutcome } from './stats';
import { MONTHS_PER_YEAR, SHORTFALL_TOLERANCE_GBP } from './constants';

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
const INCOME_KEYS: IncomeKey[] = ['salary', 'statePension', 'otherIncome', 'rental', 'cash', 'gia', 'isa', 'lisa', 'dcPension'];

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
  spending: number; mortgagePayments: number; propertyCosts: number;
  incomeTax: number; ni: number; cgt: number;
  portfolioEnd: number; propertyEquityEnd: number; mortgageBalanceEnd: number;
}

interface RunFlags { pensionCapped: boolean; allowanceTapered: boolean; isaOverflow: boolean; lisaIneligible: boolean; mortgageLumpSum: boolean; downsizeShortfall: boolean; lsaExhausted: boolean }

interface RunOutcome { failedAtAge: number; flags: RunFlags }

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
  // Bring the base-year rate to the start year with mean assumptions, then express it in today's money.
  const baseToToday = Math.pow((1 + statePensionGrowth(config.market.inflation.mean, config)) / (1 + config.market.inflation.mean), yearsFromBase);
  const spStartAge = people.map((p) => statePensionStartAge(p, config));
  // State Pension age in whole years (ignoring deferral): NI stops and qualifying years stop accruing here.
  const niEndAge = people.map((p) => defaultStatePensionStartAge(p.dateOfBirth, sp.ageSchedule));
  const spEntitlementToday = people.map((p, i) => annualEntitlement(qualifyingYearsAtStart(p, startAges[i], niEndAge[i], sp, resolveTaxYear(config, labels[0], 1).ni.lowerEarningsLimit), sp)
    * deferralMultiplier(spStartAge[i], niEndAge[i], sp) * baseToToday);

  const lsa = people.map(() => 0);
  for (const a of scenario.accounts) if (a.type === 'dcPension') lsa[a.ownerIndex] += a.taxFreeCashTaken ?? 0;

  return {
    scenario,
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
  const monthly = scenario.sim.stepsPerYear === MONTHS_PER_YEAR;
  const returnInput = { market, historical: config.historicalReturns, model: scenario.sim.returnModel, years: T, rng: mulberry32(runSeed(scenario.sim.seed, runIndex)), deterministic };
  // Annual steps: one entry per year. Monthly steps: packed monthly rates (12 per year).
  const returns: YearReturns[] = monthly ? []
    : deterministic ? Array.from({ length: T }, () => deterministicReturns(market)) : generateReturns(returnInput);
  const monthlyReturns = monthly ? generateMonthlyReturnsPacked(returnInput) : new Float64Array(0);
  const mr: YearReturns = { equities: 0, bonds: 0, cash: 0, property: 0, inflation: 0 };
  const monthlyFee = accounts.map((a) => 1 - Math.pow(1 - a.annualFeePct, 1 / MONTHS_PER_YEAR));
  const monthlyGrowth = properties.map((p) => ({ own: monthlyRate(p.growthRealPct), market: monthlyRate(market.property.meanReal) }));

  let ws: WithdrawalState = {
    balances: accounts.map((a) => a.balance),
    giaBasis: accounts.map((a) => (a.type === 'gia' ? a.giaCostBasis ?? a.balance : 0)),
    lsaUsed: [...prep.initialLsaUsed],
    mpaaTriggered: people.map((p) => p.mpaaTriggered === true),
  };
  const propValue = properties.map((p) => p.value);
  const mort: (MortgageState | null)[] = properties.map((p) => (p.mortgage && p.mortgage.balance > 0 ? initialMortgageState(p.mortgage) : null));
  const pendingLump = properties.map(() => 0);
  const downsized = properties.map(() => false);
  const lisaOpen = accounts.map((a) => a.type === 'lisa' && a.balance > 0);   // a LISA with money in it is already open
  /** New money paid into a GIA is not a gain: raise its cost basis by the amount credited. */
  const creditGiaBasis = (a: number, amount: number) => { if (accounts[a].type === 'gia' && amount > 0) ws.giaBasis[a] += amount; };
  const flags: RunFlags = { pensionCapped: false, allowanceTapered: false, isaOverflow: false, lisaIneligible: false, mortgageLumpSum: false, downsizeShortfall: false, lsaExhausted: false };

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
    const cfg = factor === 1 ? prep.baseTax[t] : resolveTaxYear(config, label, factor);
    const ages = prep.ageOffset.map((o) => age0 + o);
    const portfolioAtStart = ws.balances.reduce((s, b) => s + b, 0);

    // Income
    let rentTotal = 0;
    for (const p of properties) rentTotal += rentNominal(p, index);
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
    const rentShare = rentTotal / nP;

    // Property events: downsize, last year's mortgage lump sums, this year's mortgage schedule
    const balances = [...ws.balances];
    let mortgagePayments = 0;
    let lumpSums = 0;
    let propertyCosts = 0;
    let downsizeShortfall = 0;
    properties.forEach((p, pi) => {
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
        const y = scheduleYear(m);
        mortgagePayments += y.payments;
        if (y.lumpSumDue > 0) { pendingLump[pi] = y.lumpSumDue; flags.mortgageLumpSum = true; }
        mort[pi] = y.endBalance > 0 ? y.endState : null;
      }
      propertyCosts += runningCostsNominal(p, index, downsized[pi]);
    });

    // Contributions (start of year, before returns)
    const personYears: PersonYear[] = people.map((_, i) => ({ age: ages[i], grossSalary: salary[i], mpaaTriggered: ws.mpaaTriggered[i], otherTaxableIncome: statePension[i] + taxableStreams[i] + rentShare }));
    const plan = planContributions(scenario.contributions, accounts, people, personYears, t, index, cfg, lisaOpen);
    for (const a of plan.lisaOpened) lisaOpen[a] = true;
    if (!monthly) for (let a = 0; a < balances.length; a++) { balances[a] += plan.credits[a]; creditGiaBasis(a, plan.credits[a]); }
    flags.pensionCapped ||= plan.pensionCapped;
    flags.allowanceTapered ||= plan.allowanceTapered;
    flags.isaOverflow ||= plan.isaOverflow;
    flags.lisaIneligible ||= plan.lisaIneligible;

    // Baseline tax per person (non-savings income + estimated investment income) and NI
    const incomes: TaxableIncome[] = [];
    // Estimated GIA income per £ held (interest on bonds/cash + equity dividends). It is taxed
    // below, and as it is reinvested it is added to the cost basis at year end (so it is not taxed again as a gain).
    const giaIncomeRate = accounts.map((acc) => (acc.type === 'gia'
      ? (acc.allocation.bonds + acc.allocation.cash) * Math.max(0, lastCash) + acc.allocation.equities * market.equityDividendYield : 0));
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
      return { savings, dividends };
    };
    /** Money kept all year: the smaller of the start balance and the balance after withdrawals. */
    const keptOf = (after: number[]) => (a: number) => Math.min(giaStart[a], after[a]);
    let baselineTax = 0;
    let incomeTaxTotal = 0;
    let niTotal = 0;
    for (let i = 0; i < nP; i++) {
      const income: TaxableIncome = {
        nonSavings: Math.max(0, salary[i] - plan.netPayGross[i]) + statePension[i] + taxableStreams[i] + rentShare,
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
      phaseSpendToday: phaseSpend(scenario.spending, age0) * spendMultiplier,
      inflationIndex: index,
      retired,
      portfolioAtStart,
      prevW,
      prevInflation,
    });
    if (retired) prevW = W;

    let inflows = rentTotal;
    for (let i = 0; i < nP; i++) inflows += salary[i] + statePension[i] + taxableStreams[i] + otherStreams[i];
    const need = householdNeed({
      targetSpend: W, mortgagePayments, mortgageLumpSums: lumpSums, propertyCosts, otherOutgoings: downsizeShortfall,
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
    const wctx = { accounts, order: scenario.withdrawalOrder, cfg, people: wPeople, pensionAccessAge: prep.pensionAccessAge };

    if (!monthly) {
      if (need <= 0) {
        if (prep.firstCash >= 0) balances[prep.firstCash] += -need;
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
          ws = { ...ws, balances: ws.balances.map((b, a) => (a === prep.firstCash ? b + refund : b)) };
          incomeTaxTotal -= refund;
        }
        for (let a = 0; a < accounts.length; a++) creditGiaBasis(a, giaIncomeRate[a] * kept(a));
      }
      // Returns on what is left, then property growth
      const yr = returns[t];
      nextBalances = failed ? ws.balances.map(() => 0) : ws.balances.map((b, a) => b * (1 + accountReturn(accounts[a].allocation, yr, accounts[a].annualFeePct)));
      ws = { ...ws, balances: nextBalances };
      properties.forEach((p, pi) => { propValue[pi] *= 1 + propertyNominalReturn(yr, p.growthRealPct, market.property.meanReal); });
      indexEnd = index * (1 + yr.inflation);
      yearInflation = yr.inflation;
      yearCash = yr.cash;
    } else {
      // Monthly steps (Phase 13): a twelfth of the year's flows each month, monthly returns,
      // pension/GIA draws taken gross with tax settled at the end of the tax year.
      const pensionTaxable = people.map(() => 0);
      const gains = people.map(() => 0);
      const deferCtx = { ...wctx, deferTax: true };
      // Baseline income tax and NI are paid as they go (PAYE-style); only the extra is settled at year end.
      const regular = (W + propertyCosts + plan.fromTakeHome + baselineTax - inflows) / MONTHS_PER_YEAR;
      const creditM = plan.credits.map((c) => c / MONTHS_PER_YEAR);
      const nA = accounts.length;
      let bal = balances;            // owned by this loop; updated in place
      let monthIndex = index;
      let cashGrowth = 1;
      for (let k = 0; k < MONTHS_PER_YEAR && !failed; k++) {
        let mortgageMonth = 0;
        for (let pi = 0; pi < properties.length; pi++) {
          const m = mort[pi];
          if (!m) continue;
          const y = scheduleMonths(m, 1);
          mortgageMonth += y.payments;
          if (y.lumpSumDue > 0) { pendingLump[pi] = y.lumpSumDue; flags.mortgageLumpSum = true; }
          mort[pi] = y.endBalance > 0 ? y.endState : null;
        }
        mortgagePayments += mortgageMonth;
        for (let a = 0; a < nA; a++) { bal[a] += creditM[a]; creditGiaBasis(a, creditM[a]); }
        const needM = regular + mortgageMonth + (k === 0 ? lumpSums + downsizeShortfall : 0);
        if (needM <= 0) {
          if (prep.firstCash >= 0) bal[prep.firstCash] += -needM;
        } else {
          const res = executeWithdrawals(deferCtx, needM, { ...ws, balances: bal });
          ws = res.state;
          bal = ws.balances;
          draws.cash += res.net.cash; draws.gia += res.net.gia; draws.isa += res.net.isa; draws.lisa += res.net.lisa; draws.dcPension += res.net.dcPension;
          for (let i = 0; i < nP; i++) { pensionTaxable[i] += res.pensionTaxable[i]; gains[i] += res.gains[i]; }
          failed = res.unmet > SHORTFALL_TOLERANCE_GBP;
        }
        unpackReturn(monthlyReturns, t * MONTHS_PER_YEAR + k, mr);
        if (failed) bal.fill(0);
        else for (let a = 0; a < nA; a++) bal[a] *= 1 + accountReturn(accounts[a].allocation, mr, monthlyFee[a]);
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
        if (prep.firstCash >= 0) ws = { ...ws, balances: ws.balances.map((b, a) => (a === prep.firstCash ? b - bill : b)) };
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
      yearInflation = monthIndex / index - 1;
      yearCash = cashGrowth - 1;
    }
    if (ws.lsaUsed.some((u) => u >= cfg.pension.lumpSumAllowance)) flags.lsaExhausted = true;

    if (record) {
      const mortgageBalanceEnd = mort.reduce((s, m) => s + (m?.balance ?? 0), 0) + pendingLump.reduce((s, v) => s + v, 0);
      record({
        t, index, indexEnd,
        salary: salary.reduce((s, v) => s + v, 0),
        statePension: statePension.reduce((s, v) => s + v, 0),
        otherIncome: taxableStreams.reduce((s, v) => s + v, 0) + otherStreams.reduce((s, v) => s + v, 0),
        rental: rentTotal,
        draws,
        spending: W,
        mortgagePayments: mortgagePayments + lumpSums,
        propertyCosts,
        incomeTax: incomeTaxTotal + extraTax,
        ni: niTotal,
        cgt,
        portfolioEnd: nextBalances.reduce((s, v) => s + v, 0),
        propertyEquityEnd: propValue.reduce((s, v) => s + v, 0) - mortgageBalanceEnd,
        mortgageBalanceEnd,
      });
    }
    if (failed) return { failedAtAge: age0, flags };

    spIndex *= 1 + statePensionGrowth(yearInflation, config);
    prevInflation = yearInflation;
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
  const taxByAge = new Float64Array(T);
  const income: Record<IncomeKey, Float64Array> = Object.fromEntries(INCOME_KEYS.map((k) => [k, new Float64Array(T)])) as Record<IncomeKey, Float64Array>;
  // Per-age means average over runs that met spending in full that year, so failed runs
  // (and the partial year they fail in) do not drag the averages towards zero.
  const funded = new Float64Array(T);
  const runIncome: Record<IncomeKey, Float64Array> = Object.fromEntries(INCOME_KEYS.map((k) => [k, new Float64Array(T)])) as Record<IncomeKey, Float64Array>;
  const runTax = new Float64Array(T);
  const flagCounts: Record<keyof RunFlags, number> = { pensionCapped: 0, allowanceTapered: 0, isaOverflow: 0, lisaIneligible: 0, mortgageLumpSum: 0, downsizeShortfall: 0, lsaExhausted: 0 };
  let completed = 0;

  const runChunk = (from: number, to: number) => {
    for (let r = from; r < Math.min(to, runs); r++) {
      let lastNetWorthReal = 0;
      let lastNetWorthNominal = 0;
      let lastT = -1;
      const out = runOne(prep, r, deterministic, mult, full ? (y) => {
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
        for (const k of ['cash', 'gia', 'isa', 'lisa', 'dcPension'] as AccountType[]) runIncome[k][y.t] = y.draws[k] / y.index;
        const tax = (y.incomeTax + y.ni + y.cgt) / y.index;
        runTax[y.t] = tax;
        taxPerRun[r] += tax;
      } : null);
      if (full) {
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
    if (flagCounts.isaOverflow) warnings.push(`ISA/LISA contributions above the allowance were redirected to a GIA or cash account in ${share(flagCounts.isaOverflow)}.`);
    if (flagCounts.lisaIneligible) warnings.push('Some LISA contributions were outside the allowed ages (minimum age, latest opening age or contribution end age in Rules & Assumptions), so they were saved in a GIA or cash account instead, without the bonus.');
    if (flagCounts.mortgageLumpSum) warnings.push(`A mortgage balance remained at the end of its term and was paid as a lump sum in ${share(flagCounts.mortgageLumpSum)}.`);
    if (flagCounts.downsizeShortfall) warnings.push(`Downsizing released less than the new home and mortgage cost in ${share(flagCounts.downsizeShortfall)}; the shortfall was added to spending.`);
    if (flagCounts.lsaExhausted) warnings.push(`The Lump Sum Allowance was used up in ${share(flagCounts.lsaExhausted)}; later pension withdrawals are fully taxable.`);
    scenario.accounts.forEach((a, ai) => {
      if (a.type !== 'dcPension') return;
      const age = prep.pensionAccessAge[ai];
      const ownerAgeNow = prep.startAge0 + prep.ageOffset[a.ownerIndex];
      if (age > ownerAgeNow) warnings.push(`${a.name || 'DC pension'} is locked until age ${age}; it is not used before then.`);
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
          spending: y.spending / y.index,
          mortgagePayments: y.mortgagePayments / y.index,
          propertyCosts: y.propertyCosts / y.index,
          taxPaid: (y.incomeTax + y.cgt) / y.index,
          niPaid: y.ni / y.index,
          portfolioEnd: y.portfolioEnd / y.indexEnd,
          propertyEquityEnd: y.propertyEquityEnd / y.indexEnd,
          mortgageBalanceEnd: y.mortgageBalanceEnd / y.indexEnd,
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
export function* maxSustainableSpendSteps(scenario: Scenario, config: ConfigBundle): Generator<number, MaxSpendOutcome> {
  // The search runs ~16 simulations; with monthly steps that is slow, so it uses annual steps
  // (start-of-year cash flows, slightly more conservative) and says so.
  const monthly = scenario.sim.stepsPerYear === MONTHS_PER_YEAR;
  const s = monthly ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  const out = yield* maxSpendSteps(s, config, scenario.sim.targetSuccessRate, {
    simulate: (sc, c, o) => simulate(sc, c, o),
  });
  return monthly ? { ...out, warnings: [...out.warnings, 'Estimated with annual time steps for speed (slightly conservative compared with monthly).'] } : out;
}

/** Earliest stop-work age at the target success rate, wired to this simulator (annual steps for speed). */
export function* earliestRetirementAgeSteps(scenario: Scenario, config: ConfigBundle): Generator<number, RetireAgeOutcome> {
  const s = scenario.sim.stepsPerYear === MONTHS_PER_YEAR ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  return yield* earliestRetirementSteps(s, config, { simulate: (sc, c, o) => simulate(sc, c, o) });
}

/**
 * A quick success-rate check for what-if sliders: up to `runs` runs, annual steps, no bands.
 * Returns the success rate and depletion histogram (enough for "how long the money lasts").
 */
export function quickCheck(scenario: Scenario, config: ConfigBundle, runs: number): Pick<SimulationResult, 'ages' | 'runs' | 'successRate' | 'depletionAgeHistogram'> {
  const s = scenario.sim.stepsPerYear === MONTHS_PER_YEAR ? { ...scenario, sim: { ...scenario.sim, stepsPerYear: 1 as const } } : scenario;
  const r = simulate(s, config, { runsOverride: Math.min(scenario.sim.runs, runs), successOnly: true });
  return { ages: r.ages, runs: r.runs, successRate: r.successRate, depletionAgeHistogram: r.depletionAgeHistogram };
}

export { MAX_SPEND_STEPS };
