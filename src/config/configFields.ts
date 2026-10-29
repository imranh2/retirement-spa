import type { ConfigBundle, FieldMeta } from './configTypes';
import { UPRATED_ITEMS } from './configTypes';
import { getPath } from './paths';

/** Date the seed values were last checked. Bump with `defaultsVersion`. */
export const LAST_VERIFIED = '2026-10-28';

export const GROUPS = [
  'Tax years', 'Savings & dividends', 'National Insurance', 'Capital gains', 'ISA & LISA', 'Stamp duty',
  'Pensions', 'State Pension', 'Market assumptions', 'Historical returns', 'Tax projection',
] as const;

const GOV = 'https://www.gov.uk/';
const SRC = {
  incomeTax: GOV + 'income-tax-rates',
  savings: GOV + 'apply-tax-free-interest-on-savings',
  dividends: GOV + 'tax-on-dividends',
  stampDuty: GOV + 'stamp-duty-land-tax/residential-property-rates',
  stampDutyFtb: GOV + 'stamp-duty-land-tax/residential-property-rates',
  propertyIncome: GOV + 'government/publications/changes-to-tax-rates-for-property-savings-dividend-income',
  ni: GOV + 'national-insurance-rates-letters',
  cgt: GOV + 'capital-gains-tax',
  isa: GOV + 'individual-savings-accounts',
  lisa: GOV + 'lifetime-isa',
  pension: GOV + 'tax-on-your-private-pension',
  aaTaper: GOV + 'guidance/pension-schemes-work-out-your-tapered-annual-allowance',
  pensionAccess: GOV + 'personal-pensions-your-rights',
  statePension: GOV + 'new-state-pension',
  spa: GOV + 'state-pension-age',
  freeze: GOV + 'government/publications/income-tax-personal-allowance-and-basic-rate-limit-from-6-april-2026',
};

type Opt = Partial<Omit<FieldMeta, 'path' | 'label' | 'unit' | 'tooltip' | 'group'>>;

function f(path: string, label: string, unit: FieldMeta['unit'], group: string, tooltip: string, opt: Opt = {}): FieldMeta {
  return { path, label, unit, group, tooltip, lastVerified: LAST_VERIFIED, ...opt };
}
const RATE: Opt = { min: 0, max: 1, step: 0.0001 };
const GBP: Opt = { min: 0, step: 1 };
const Y = 'tax.{year}';

/**
 * Single source of truth for every editable config value: label, unit, limits,
 * tooltip, source and grouping. The UI renders editors from this list and
 * validateConfig uses the same min/max.
 */
export const CONFIG_FIELDS: FieldMeta[] = [
  // Tax years
  f(`${Y}.taxYear`, 'Tax year label', 'date', 'Tax years', 'The tax year these rules apply to, e.g. 2026/27.', { readOnly: true, sourceUrl: SRC.incomeTax }),
  f(`${Y}.region`, 'Tax region', 'enum', 'Tax years', 'Only England, Wales and Northern Ireland bands are modelled in this version.', { options: ['england-wales-ni', 'scotland'], readOnly: true, sourceUrl: SRC.incomeTax }),
  f(`${Y}.personalAllowance`, 'Personal allowance', 'gbp', 'Tax years', 'Income you can receive each year before paying income tax.', { ...GBP, sourceUrl: SRC.incomeTax }),
  f(`${Y}.taperThreshold`, 'Allowance taper threshold', 'gbp', 'Tax years', 'Above this adjusted net income the personal allowance is reduced.', { ...GBP, sourceUrl: SRC.incomeTax }),
  f(`${Y}.taperRatePerPound`, 'Allowance taper rate', 'pct', 'Tax years', 'How much allowance is lost per £1 over the threshold. 50% means £1 lost for every £2.', { ...RATE, sourceUrl: SRC.incomeTax }),
  f(`${Y}.incomeTaxBands[].upTo`, 'Band top (taxable income)', 'gbp', 'Tax years', 'Top of this band measured in taxable income (after the personal allowance). Leave blank on the last band for no limit.', { ...GBP, nullable: true, sourceUrl: SRC.incomeTax }),
  f(`${Y}.incomeTaxBands[].rate`, 'Band rate', 'pct', 'Tax years', 'Income tax rate for income falling in this band.', { ...RATE, sourceUrl: SRC.incomeTax }),

  // Savings & dividends
  f(`${Y}.savings.startingRateBand`, 'Savings starting rate band', 'gbp', 'Savings & dividends', 'Savings interest in this band is taxed at the starting rate. Reduced £1 for £1 by taxable non-savings income.', { ...GBP, sourceUrl: SRC.savings }),
  f(`${Y}.savings.startingRate`, 'Savings starting rate', 'pct', 'Savings & dividends', 'Tax rate on savings interest within the starting rate band.', { ...RATE, sourceUrl: SRC.savings }),
  f(`${Y}.savings.psaBasic`, 'Personal Savings Allowance (basic rate)', 'gbp', 'Savings & dividends', 'Tax-free savings interest for basic-rate taxpayers.', { ...GBP, sourceUrl: SRC.savings }),
  f(`${Y}.savings.psaHigher`, 'Personal Savings Allowance (higher rate)', 'gbp', 'Savings & dividends', 'Tax-free savings interest for higher-rate taxpayers.', { ...GBP, sourceUrl: SRC.savings }),
  f(`${Y}.savings.psaAdditional`, 'Personal Savings Allowance (additional rate)', 'gbp', 'Savings & dividends', 'Tax-free savings interest for additional-rate taxpayers.', { ...GBP, sourceUrl: SRC.savings }),
  f(`${Y}.savings.basicRate`, 'Savings basic rate', 'pct', 'Savings & dividends', 'Tax on savings interest falling in the basic rate band (above the starting rate band and Personal Savings Allowance).', { ...RATE, sourceUrl: SRC.savings }),
  f(`${Y}.savings.higherRate`, 'Savings higher rate', 'pct', 'Savings & dividends', 'Tax on savings interest falling in the higher rate band.', { ...RATE, sourceUrl: SRC.savings }),
  f(`${Y}.savings.additionalRate`, 'Savings additional rate', 'pct', 'Savings & dividends', 'Tax on savings interest falling in the additional rate band.', { ...RATE, sourceUrl: SRC.savings }),
  f(`${Y}.dividends.allowance`, 'Dividend allowance', 'gbp', 'Savings & dividends', 'Dividends up to this amount are taxed at 0% (they still use up band space).', { ...GBP, sourceUrl: SRC.dividends }),
  f(`${Y}.dividends.basicRate`, 'Dividend basic rate', 'pct', 'Savings & dividends', 'Tax on dividends falling in the basic rate band.', { ...RATE, sourceUrl: SRC.dividends }),
  f(`${Y}.dividends.higherRate`, 'Dividend higher rate', 'pct', 'Savings & dividends', 'Tax on dividends falling in the higher rate band.', { ...RATE, sourceUrl: SRC.dividends }),
  f(`${Y}.dividends.additionalRate`, 'Dividend additional rate', 'pct', 'Savings & dividends', 'Tax on dividends falling in the additional rate band.', { ...RATE, sourceUrl: SRC.dividends }),
  f(`${Y}.propertyIncome.basicRate`, 'Rental income basic rate', 'pct', 'Savings & dividends', 'Tax on rental income in the basic rate band (England, Wales and NI). Rent is taxed after other non-savings income.', { ...RATE, sourceUrl: SRC.propertyIncome }),
  f(`${Y}.propertyIncome.higherRate`, 'Rental income higher rate', 'pct', 'Savings & dividends', 'Tax on rental income in the higher rate band.', { ...RATE, sourceUrl: SRC.propertyIncome }),
  f(`${Y}.propertyIncome.additionalRate`, 'Rental income additional rate', 'pct', 'Savings & dividends', 'Tax on rental income in the additional rate band.', { ...RATE, sourceUrl: SRC.propertyIncome }),

  // NI
  f(`${Y}.ni.primaryThreshold`, 'Primary threshold', 'gbp', 'National Insurance', 'Employee NI is paid on earnings above this.', { ...GBP, sourceUrl: SRC.ni }),
  f(`${Y}.ni.upperEarningsLimit`, 'Upper earnings limit', 'gbp', 'National Insurance', 'Earnings above this pay the lower upper rate.', { ...GBP, sourceUrl: SRC.ni }),
  f(`${Y}.ni.mainRate`, 'Main rate', 'pct', 'National Insurance', 'Employee NI rate between the primary threshold and upper earnings limit.', { ...RATE, sourceUrl: SRC.ni }),
  f(`${Y}.ni.upperRate`, 'Upper rate', 'pct', 'National Insurance', 'Employee NI rate above the upper earnings limit.', { ...RATE, sourceUrl: SRC.ni }),
  f(`${Y}.ni.lowerEarningsLimit`, 'Lower earnings limit', 'gbp', 'National Insurance', 'A year of salary at or above this counts as a qualifying year for the State Pension, even though no NI is paid below the primary threshold.', { ...GBP, sourceUrl: SRC.ni }),

  // CGT
  f(`${Y}.cgt.annualExempt`, 'Annual exempt amount', 'gbp', 'Capital gains', 'Gains up to this amount each year are tax-free.', { ...GBP, sourceUrl: SRC.cgt }),
  f(`${Y}.cgt.basicRate`, 'Basic rate', 'pct', 'Capital gains', 'CGT rate on gains falling within the unused basic rate band.', { ...RATE, sourceUrl: SRC.cgt }),
  f(`${Y}.cgt.higherRate`, 'Higher rate', 'pct', 'Capital gains', 'CGT rate on gains above the basic rate band.', { ...RATE, sourceUrl: SRC.cgt }),

  // ISA & LISA
  f(`${Y}.isa.annualAllowance`, 'ISA annual allowance', 'gbp', 'ISA & LISA', 'Total that can be paid into ISAs (including a LISA) per person per tax year.', { ...GBP, sourceUrl: SRC.isa }),
  f(`${Y}.isa.cashIsaSubLimit`, 'Cash ISA sub-limit', 'gbp', 'ISA & LISA', 'Optional cap on cash ISA subscriptions. Not modelled yet; recorded for future use.', { ...GBP, nullable: true, sourceUrl: SRC.isa }),
  f(`${Y}.premiumBonds.holdingLimit`, 'Premium Bonds holding limit', 'gbp', 'ISA & LISA', 'The most one person can hold in NS&I Premium Bonds. Payments in above it go to their GIA, or cash.', { ...GBP, sourceUrl: 'https://www.nsandi.com/products/premium-bonds' }),
  f(`${Y}.lisa.homePriceCap`, 'LISA first-home price cap', 'gbp', 'ISA & LISA', 'A LISA can pay towards a first home up to this price without the withdrawal charge.', { ...GBP, sourceUrl: SRC.lisa }),
  f(`${Y}.stampDuty.nilBand`, 'Stamp duty: 0% up to', 'gbp', 'Stamp duty', 'Stamp Duty Land Tax on buying a home (England and NI) is charged in slices: none on the part of the price up to this.', { ...GBP, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band2Top`, 'Stamp duty: second band up to', 'gbp', 'Stamp duty', 'Top of the second slice.', { ...GBP, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band2Rate`, 'Stamp duty: second band rate', 'pct', 'Stamp duty', 'Rate on the second slice.', { ...RATE, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band3Top`, 'Stamp duty: third band up to', 'gbp', 'Stamp duty', 'Top of the third slice.', { ...GBP, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band3Rate`, 'Stamp duty: third band rate', 'pct', 'Stamp duty', 'Rate on the third slice.', { ...RATE, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band4Top`, 'Stamp duty: fourth band up to', 'gbp', 'Stamp duty', 'Top of the fourth slice.', { ...GBP, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.band4Rate`, 'Stamp duty: fourth band rate', 'pct', 'Stamp duty', 'Rate on the fourth slice.', { ...RATE, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.topRate`, 'Stamp duty: top rate', 'pct', 'Stamp duty', 'Rate on the part of the price above the fourth band.', { ...RATE, sourceUrl: SRC.stampDuty }),
  f(`${Y}.stampDuty.ftbNilBand`, 'First-time buyers: 0% up to', 'gbp', 'Stamp duty', 'First-time buyer relief: no stamp duty on the price up to this.', { ...GBP, sourceUrl: SRC.stampDutyFtb }),
  f(`${Y}.stampDuty.ftbRate`, 'First-time buyers: rate above that', 'pct', 'Stamp duty', 'Rate on the part of the price above the first-time buyer 0% band.', { ...RATE, sourceUrl: SRC.stampDutyFtb }),
  f(`${Y}.stampDuty.ftbMaxPrice`, 'First-time buyer relief: price limit', 'gbp', 'Stamp duty', 'Above this price there is no first-time buyer relief: the normal rates apply.', { ...GBP, sourceUrl: SRC.stampDutyFtb }),
  f(`${Y}.lisa.annualAllowance`, 'LISA annual allowance', 'gbp', 'ISA & LISA', 'Maximum paid into a Lifetime ISA each tax year (counts towards the ISA allowance).', { ...GBP, sourceUrl: SRC.lisa }),
  f(`${Y}.lisa.bonusRate`, 'LISA bonus rate', 'pct', 'ISA & LISA', 'Government bonus added to each LISA contribution.', { ...RATE, sourceUrl: SRC.lisa }),
  f(`${Y}.lisa.minAge`, 'LISA minimum age', 'age', 'ISA & LISA', 'You must be at least this age to open or pay into a LISA.', { min: 0, max: 120, step: 1, sourceUrl: SRC.lisa }),
  f(`${Y}.lisa.maxOpenAge`, 'LISA latest opening age', 'age', 'ISA & LISA', 'You must open a LISA (make the first payment) at or before this age. A LISA with no balance at the start is treated as opened by its first contribution.', { min: 0, max: 120, step: 1, sourceUrl: SRC.lisa }),
  f(`${Y}.lisa.maxContributionAge`, 'LISA contributions stop at age', 'age', 'ISA & LISA', 'No LISA contributions from this age.', { min: 0, max: 120, step: 1, sourceUrl: SRC.lisa }),
  f(`${Y}.lisa.penaltyFreeAge`, 'LISA penalty-free age', 'age', 'ISA & LISA', 'LISA money can be withdrawn without penalty from this age. Before it, the LISA is treated as locked.', { min: 0, max: 120, step: 1, sourceUrl: SRC.lisa }),

  // Pensions
  f(`${Y}.pension.annualAllowance`, 'Annual allowance', 'gbp', 'Pensions', 'Maximum gross pension contributions (you + employer) per year with tax relief.', { ...GBP, sourceUrl: SRC.pension }),
  f(`${Y}.pension.mpaa`, 'Money Purchase Annual Allowance', 'gbp', 'Pensions', 'Lower contribution limit that applies after you first take taxable money from a DC pension.', { ...GBP, sourceUrl: SRC.pension }),
  f(`${Y}.pension.taxFreeFraction`, 'Tax-free fraction of withdrawals', 'pct', 'Pensions', 'Share of each pension withdrawal that is tax-free, until the Lump Sum Allowance is used up.', { ...RATE, sourceUrl: SRC.pension }),
  f(`${Y}.pension.lumpSumAllowance`, 'Lump Sum Allowance', 'gbp', 'Pensions', 'Lifetime cap on tax-free cash from pensions.', { ...GBP, sourceUrl: SRC.pension }),
  f(`${Y}.pension.reliefAtSourceRate`, 'Relief-at-source rate', 'pct', 'Pensions', 'Basic-rate relief the provider adds to personal contributions under relief at source.', { ...RATE, sourceUrl: SRC.pension }),
  f(`${Y}.pension.basicAmount`, 'Basic amount (no or low earnings)', 'gbp', 'Pensions', 'Anyone can pay up to this much a year (gross, including the relief) into a relief-at-source pension, even with no earnings. Above it, personal contributions are limited to 100% of earnings.', { ...GBP, sourceUrl: SRC.pension }),
  f(`${Y}.pension.taperThresholdIncome`, 'Taper: threshold income', 'gbp', 'Pensions', 'The annual allowance is tapered only if income minus your own pension contributions is above this.', { ...GBP, sourceUrl: SRC.aaTaper }),
  f(`${Y}.pension.taperAdjustedIncome`, 'Taper: adjusted income', 'gbp', 'Pensions', 'Income plus employer pension contributions above this reduces the annual allowance.', { ...GBP, sourceUrl: SRC.aaTaper }),
  f(`${Y}.pension.taperRate`, 'Taper rate', 'pct', 'Pensions', 'Reduction in the annual allowance per £1 of adjusted income over the limit (50% = £1 for every £2).', { ...RATE, sourceUrl: SRC.aaTaper }),
  f(`${Y}.pension.taperMinimumAllowance`, 'Taper: minimum allowance', 'gbp', 'Pensions', 'The tapered annual allowance never falls below this.', { ...GBP, sourceUrl: SRC.aaTaper }),
  f('pensionAccess.minAgeNow', 'Minimum access age (now)', 'age', 'Pensions', 'Earliest age you can take money from a DC pension today.', { min: 0, max: 120, step: 1, sourceUrl: SRC.pensionAccess }),
  f('pensionAccess.minAgeFuture', 'Minimum access age (future)', 'age', 'Pensions', 'Minimum access age after the change date. Anyone who has not reached this age by the change date uses it, even if they reached the current minimum age earlier (they lose access until this age).', { min: 0, max: 120, step: 1, sourceUrl: SRC.pensionAccess }),
  f('pensionAccess.minAgeFutureFromDate', 'Future access age applies from', 'date', 'Pensions', 'The current minimum age applies only to people who reach the future minimum age before this date. A protected pension age can be set on each pension account.', { sourceUrl: SRC.pensionAccess }),

  // State Pension
  f('statePension.fullWeeklyRate', 'Full weekly rate', 'gbp', 'State Pension', 'Full new State Pension per week in the base tax year.', { min: 0, step: 0.01, sourceUrl: SRC.statePension }),
  f('statePension.baseTaxYear', 'Base tax year', 'date', 'State Pension', 'Tax year the weekly rate applies to.', { readOnly: true, sourceUrl: SRC.statePension }),
  f('statePension.yearsForFull', 'Qualifying years for full pension', 'years', 'State Pension', 'National Insurance qualifying years needed for the full amount.', { min: 1, max: 60, step: 1, sourceUrl: SRC.statePension }),
  f('statePension.minimumYears', 'Minimum qualifying years', 'years', 'State Pension', 'Fewer qualifying years than this gives no State Pension.', { min: 0, max: 60, step: 1, sourceUrl: SRC.statePension }),
  f('statePension.growth', 'Annual increase rule', 'enum', 'State Pension', 'Triple lock: the highest of inflation, earnings growth and the floor. Adjusted triple lock: the same until the year below, then the higher of inflation and the floor (announced for April 2030, not yet law). Or follow inflation, earnings, or a fixed rate.', { options: ['adjustedTripleLock', 'tripleLock', 'inflation', 'earnings', 'fixed'], sourceUrl: SRC.statePension }),
  f('statePension.doubleLockFromTaxYear', 'Earnings link ends from', 'date', 'State Pension', 'With the adjusted triple lock: the first tax year whose increase ignores earnings growth.', { sourceUrl: SRC.statePension }),
  f('statePension.tripleLockFloorPct', 'Triple lock floor', 'pct', 'State Pension', 'Minimum annual increase under the triple lock.', { ...RATE, sourceUrl: SRC.statePension }),
  f('statePension.deferralIncreasePerYear', 'Deferral increase per year', 'pct', 'State Pension', 'Extra State Pension for each year you put off claiming it after State Pension age (1% for every 9 weeks is about 5.78% a year).', { min: 0, max: 1, step: 0.0001, sourceUrl: GOV + 'deferring-state-pension' }),
  f('statePension.fixedGrowthPct', 'Fixed annual increase', 'pct', 'State Pension', 'Used only when the increase rule is "fixed".', { min: -1, max: 1, step: 0.0001, sourceUrl: SRC.statePension }),
  f('statePension.ageSchedule[].bornOnOrAfter', 'Born on or after', 'date', 'State Pension', 'Rows apply to people born on or after this date (until the next row).', { sourceUrl: SRC.spa }),
  f('statePension.ageSchedule[].ageYears', 'State Pension age (years)', 'age', 'State Pension', 'Years part of State Pension age.', { min: 0, max: 120, step: 1, sourceUrl: SRC.spa }),
  f('statePension.ageSchedule[].ageMonths', 'State Pension age (months)', 'count', 'State Pension', 'Extra months on top of the years. The model rounds up to the next whole year.', { min: 0, max: 11, step: 1, sourceUrl: SRC.spa }),

  // Market assumptions (assumptions, not gov.uk figures)
  ...(['equities', 'bonds', 'cash', 'property'] as const).flatMap((k) => {
    const name = k[0].toUpperCase() + k.slice(1);
    return [
      f(`market.${k}.meanReal`, `${name}: mean real return`, 'pct', 'Market assumptions', `Average annual return of ${k} above inflation (arithmetic). An assumption, not a prediction.`, { min: -0.5, max: 0.5, step: 0.0005 }),
      f(`market.${k}.vol`, `${name}: volatility`, 'pct', 'Market assumptions', `Annual standard deviation of ${k} returns.`, { min: 0, max: 1, step: 0.0005 }),
    ];
  }),
  f('market.inflation.mean', 'Inflation: mean', 'pct', 'Market assumptions', 'Average annual inflation.', { min: -0.1, max: 0.5, step: 0.0005 }),
  f('market.inflation.vol', 'Inflation: volatility', 'pct', 'Market assumptions', 'Annual standard deviation of inflation.', { min: 0, max: 0.5, step: 0.0005 }),
  f('market.inflation.floor', 'Inflation: floor', 'pct', 'Market assumptions', 'Simulated inflation is never below this.', { min: -0.5, max: 0.5, step: 0.0005 }),
  f('market.correlations[][]', 'Correlation', 'count', 'Market assumptions', 'Correlation between two return series (-1 to 1). The matrix is kept symmetric.', { min: -1, max: 1, step: 0.01 }),
  ...(['cash', 'gia', 'isa', 'lisa', 'dcPension'] as const).map((k) =>
    f(`market.defaultAnnualFeePct.${k}`, `Default fee: ${k === 'dcPension' ? 'DC pension' : k.toUpperCase()}`, 'pct', 'Market assumptions', 'Annual fee suggested when you add a new account of this type.', { min: 0, max: 0.1, step: 0.0001 })),
  f('market.premiumBondsPrizeRate', 'Premium Bonds: expected prize rate', 'pct', 'Market assumptions', 'Yearly return assumed for Premium Bonds that do not set their own rate: prizes, tax-free, the same every year. NS&I publishes its prize fund rate; a typical holder wins somewhat less, as a few big prizes lift the average.', { min: 0, max: 0.2, step: 0.0005, sourceUrl: 'https://www.nsandi.com/products/premium-bonds' }),
  f('market.equityDividendYield', 'Equity dividend yield', 'pct', 'Market assumptions', 'Used only to estimate taxable dividends from equities held in a GIA.', { min: 0, max: 0.2, step: 0.0005 }),
  f('market.wageGrowthRealPct', 'Wage growth above inflation', 'pct', 'Market assumptions', 'Used for the earnings leg of the triple lock and for wage-linked threshold uprating.', { min: -0.1, max: 0.1, step: 0.0005 }),

  // Historical returns
  ...(['year', 'equities', 'bonds', 'cash', 'property', 'inflation'] as const).map((k) =>
    f(`historicalReturns[].${k}`, k === 'year' ? 'Year' : `${k[0].toUpperCase()}${k.slice(1)} (nominal)`, k === 'year' ? 'count' : 'pct', 'Historical returns',
      'Pasted historical data used by the block bootstrap return model.', k === 'year' ? { min: 1800, max: 2200, step: 1 } : { min: -1, max: 5, step: 0.0001 })),

  // Tax projection
  f('taxProjection.thresholdsFrozenThroughTaxYear', 'Thresholds frozen through', 'date', 'Tax projection', 'Last tax year in which thresholds stay frozen. Uprating starts the following year.', { sourceUrl: SRC.freeze }),
  f('taxProjection.upratingAfterFreeze', 'Uprating after the freeze', 'enum', 'Tax projection', 'How thresholds grow after the freeze for tax years you have not defined.', { options: ['inflation', 'wageGrowth', 'none'], sourceUrl: SRC.freeze }),
  f('taxProjection.upratedItems', 'Items uprated after the freeze', 'enum', 'Tax projection', 'Which thresholds grow after the freeze. Rates never change.', { options: UPRATED_ITEMS, multi: true, sourceUrl: SRC.freeze }),
  f('defaultsVersion', 'Defaults version', 'date', 'Tax projection', 'Version of the shipped default values your rules are based on.', { readOnly: true, sourceUrl: SRC.incomeTax }),
];

const BY_PATTERN = new Map(CONFIG_FIELDS.map((fm) => [fm.path, fm]));

/** Turn a concrete path into its registry pattern (tax year key -> {year}, indices -> []). */
export function patternOf(path: string): string {
  const withYear = path.startsWith('tax.') ? path.replace(/^tax\.[^.[]+/, 'tax.{year}') : path;
  return withYear.replace(/\[\d+\]/g, '[]');
}

/** Registry entry for a concrete path, if any. */
export function fieldFor(path: string): FieldMeta | undefined {
  return BY_PATTERN.get(patternOf(path));
}

function expandPattern(pattern: string, config: ConfigBundle): string[] {
  const yearAt = pattern.indexOf('{year}');
  const arrAt = pattern.indexOf('[]');
  if (yearAt < 0 && arrAt < 0) return [pattern];
  if (yearAt >= 0 && (arrAt < 0 || yearAt < arrAt)) {
    return Object.keys(config.tax).flatMap((y) => expandPattern(pattern.replace('{year}', y), config));
  }
  const arr = getPath(config, pattern.slice(0, arrAt));
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((_, i) => expandPattern(pattern.slice(0, arrAt) + `[${i}]` + pattern.slice(arrAt + 2), config));
}

/** Expand registry patterns into concrete field entries for the current config. */
export function expandFields(config: ConfigBundle): FieldMeta[] {
  return CONFIG_FIELDS.flatMap((fm) => expandPattern(fm.path, config).map((path) => ({ ...fm, path })));
}
