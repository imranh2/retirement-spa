import type { Band, TaxYearConfig } from '../config/configTypes';

export interface TaxableIncome { nonSavings: number; savings: number; dividends: number }

export interface TaxResult {
  total: number;
  incomeTax: number;          // tax on non-savings income
  savingsTax: number;
  dividendTax: number;
  personalAllowanceUsed: number;
  marginalBand: 'basic' | 'higher' | 'additional';
  taxableIncome: number;      // total income after the personal allowance
}

export interface TaxOptions {
  /** Gross relief-at-source contributions: extends every band's upTo equally. */
  basicBandExtension?: number;
}

export const ZERO_INCOME: TaxableIncome = { nonSavings: 0, savings: 0, dividends: 0 };

/** Band tops after applying a basic band extension. Last band stays unlimited. */
function bandTops(bands: Band[], extension: number): number[] {
  return bands.map((b) => (b.upTo === null ? Infinity : b.upTo + extension));
}

/** Index of the band containing taxable-income position `pos` (the band where pos < top). */
function bandIndexAt(tops: number[], pos: number): number {
  for (let i = 0; i < tops.length; i++) if (pos < tops[i]) return i;
  return tops.length - 1;
}

function bandName(index: number, count: number): TaxResult['marginalBand'] {
  if (index === 0) return 'basic';
  if (index === count - 1 && count > 2) return 'additional';
  return 'higher';
}

/**
 * Walk `amount` of income up the band stack from `start`, calling rateFor(bandIndex)
 * for the rate in each band. Returns tax due.
 */
function taxThroughBands(amount: number, start: number, tops: number[], rateFor: (i: number) => number): number {
  let tax = 0;
  let pos = start;
  let left = amount;
  for (let i = 0; i < tops.length && left > 0; i++) {
    if (pos >= tops[i]) continue;
    const inBand = Math.min(left, tops[i] - pos);
    tax += inBand * rateFor(i);
    pos += inBand;
    left -= inBand;
  }
  return tax;
}

/** Personal allowance after the taper for a given adjusted net income. */
export function personalAllowanceAfterTaper(adjustedIncome: number, cfg: TaxYearConfig): number {
  return Math.max(0, cfg.personalAllowance - cfg.taperRatePerPound * Math.max(0, adjustedIncome - cfg.taperThreshold));
}

/**
 * Income tax for one person for one tax year (England/Wales/NI).
 * Order: personal allowance against non-savings, then savings, then dividends;
 * savings starting rate band and Personal Savings Allowance; dividends on top
 * with the dividend allowance using band space. All amounts GBP for the year.
 */
export function calculateIncomeTax(income: TaxableIncome, cfg: TaxYearConfig, opts: TaxOptions = {}): TaxResult {
  const ns = Math.max(0, income.nonSavings);
  const sav = Math.max(0, income.savings);
  const div = Math.max(0, income.dividends);
  const tops = bandTops(cfg.incomeTaxBands, opts.basicBandExtension ?? 0);
  const rates = cfg.incomeTaxBands.map((b) => b.rate);
  const n = tops.length;

  // Adjusted net income for the taper is reduced by gross relief-at-source pension contributions
  // (the same amount that extends the basic band).
  const pa = personalAllowanceAfterTaper(Math.max(0, ns + sav + div - (opts.basicBandExtension ?? 0)), cfg);
  let paLeft = pa;
  const nsTaxable = Math.max(0, ns - paLeft); paLeft = Math.max(0, paLeft - ns);
  const savTaxable = Math.max(0, sav - paLeft); paLeft = Math.max(0, paLeft - sav);
  const divTaxable = Math.max(0, div - paLeft); paLeft = Math.max(0, paLeft - div);
  const totalTaxable = nsTaxable + savTaxable + divTaxable;

  // Non-savings
  const incomeTax = taxThroughBands(nsTaxable, 0, tops, (i) => rates[i]);
  let pos = nsTaxable;

  // Savings: starting rate band, then PSA (both 0%-ish but use band space), then band rates
  let savingsTax = 0;
  let savLeft = savTaxable;
  const startingBand = Math.max(0, cfg.savings.startingRateBand - nsTaxable);
  const inStarting = Math.min(savLeft, startingBand);
  savingsTax += inStarting * cfg.savings.startingRate;
  savLeft -= inStarting; pos += inStarting;
  const bandForPsa = bandName(bandIndexAt(tops, Math.max(0, totalTaxable - 1e-9)), n);
  const psa = totalTaxable <= 0 ? cfg.savings.psaBasic
    : bandForPsa === 'basic' ? cfg.savings.psaBasic : bandForPsa === 'higher' ? cfg.savings.psaHigher : cfg.savings.psaAdditional;
  const inPsa = Math.min(savLeft, psa);
  savLeft -= inPsa; pos += inPsa;
  const savRate = (i: number) => {
    const name = bandName(i, n);
    return name === 'basic' ? cfg.savings.basicRate : name === 'higher' ? cfg.savings.higherRate : cfg.savings.additionalRate;
  };
  savingsTax += taxThroughBands(savLeft, pos, tops, savRate);
  pos += savLeft;

  // Dividends: allowance at 0% (uses band space), rest at dividend rates by band
  const inAllowance = Math.min(divTaxable, cfg.dividends.allowance);
  pos += inAllowance;
  const divRate = (i: number) => {
    const name = bandName(i, n);
    return name === 'basic' ? cfg.dividends.basicRate : name === 'higher' ? cfg.dividends.higherRate : cfg.dividends.additionalRate;
  };
  const dividendTax = taxThroughBands(divTaxable - inAllowance, pos, tops, divRate);

  return {
    total: incomeTax + savingsTax + dividendTax,
    incomeTax,
    savingsTax,
    dividendTax,
    personalAllowanceUsed: pa - paLeft,
    marginalBand: bandName(bandIndexAt(tops, Math.max(0, totalTaxable - 1e-9)), n),
    taxableIncome: totalTaxable,
  };
}

/** Employee Class 1 NI on employment earnings for the year. Never negative. */
export function calculateNI(employmentEarnings: number, cfg: TaxYearConfig): number {
  const { primaryThreshold: pt, upperEarningsLimit: uel, mainRate, upperRate } = cfg.ni;
  if (employmentEarnings <= pt) return 0;
  const main = mainRate * (Math.min(employmentEarnings, uel) - pt);
  const upper = employmentEarnings > uel ? upperRate * (employmentEarnings - uel) : 0;
  return Math.max(0, main + upper);
}

/**
 * Capital Gains Tax on `gain` given the person's other taxable income (after the
 * personal allowance). Gain inside the unused basic band is taxed at the basic rate,
 * the rest at the higher rate. `basicBandExtension` widens the basic band (relief at source).
 */
export function calculateCGT(gain: number, otherTaxableIncome: number, cfg: TaxYearConfig, basicBandExtension = 0): number {
  const taxableGain = Math.max(0, gain - cfg.cgt.annualExempt);
  if (taxableGain <= 0) return 0;
  const firstTop = cfg.incomeTaxBands[0]?.upTo;
  const basicTop = firstTop === null || firstTop === undefined ? Infinity : firstTop + basicBandExtension;
  const remainingBasic = Math.max(0, basicTop - Math.max(0, otherTaxableIncome));
  const atBasic = Math.min(taxableGain, remainingBasic);
  return atBasic * cfg.cgt.basicRate + (taxableGain - atBasic) * cfg.cgt.higherRate;
}
