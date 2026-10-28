import type { ConfigBundle, TaxYearConfig } from './configTypes';
import { taxYearStartYear } from '../model/dates';

/** Deep copy of a tax year (explicit, so it stays cheap inside the simulation loop). */
function copyTaxYear(c: TaxYearConfig): TaxYearConfig {
  return {
    ...c,
    incomeTaxBands: c.incomeTaxBands.map((b) => ({ ...b })),
    savings: { ...c.savings },
    dividends: { ...c.dividends },
    ni: { ...c.ni },
    cgt: { ...c.cgt },
    isa: { ...c.isa },
    premiumBonds: { ...c.premiumBonds },
    lisa: { ...c.lisa },
    pension: { ...c.pension },
  };
}

/** Latest defined tax year label at or before `taxYear`, or undefined. */
export function latestDefinedYear(config: ConfigBundle, taxYear: string): string | undefined {
  const target = taxYearStartYear(taxYear);
  let best: string | undefined;
  for (const y of Object.keys(config.tax)) {
    const s = taxYearStartYear(y);
    if (s <= target && (best === undefined || s > taxYearStartYear(best))) best = y;
  }
  return best;
}

/**
 * Tax rules for `taxYear`.
 * If the year is defined, returns a copy of it. Otherwise copies the latest year
 * before it and multiplies the thresholds named in `taxProjection.upratedItems`
 * by `thresholdFactor`. Rates never change. `config` is never mutated.
 * If no earlier year exists, the earliest defined year is used.
 */
export function resolveTaxYear(config: ConfigBundle, taxYear: string, thresholdFactor = 1): TaxYearConfig {
  const existing = config.tax[taxYear];
  if (existing) return copyTaxYear(existing);

  let baseYear = latestDefinedYear(config, taxYear);
  if (baseYear === undefined) {
    const all = Object.keys(config.tax).sort((a, b) => taxYearStartYear(a) - taxYearStartYear(b));
    if (all.length === 0) throw new Error('No tax years are defined');
    baseYear = all[0];
  }
  const out = copyTaxYear(config.tax[baseYear]);
  out.taxYear = taxYear;
  const k = thresholdFactor;
  if (k === 1) return out;

  const items = new Set(config.taxProjection.upratedItems);
  if (items.has('personalAllowance')) {
    out.personalAllowance *= k;
    out.taperThreshold *= k;
  }
  if (items.has('incomeTaxBands')) {
    out.incomeTaxBands = out.incomeTaxBands.map((b) => ({ ...b, upTo: b.upTo === null ? null : b.upTo * k }));
  }
  if (items.has('niThresholds')) {
    out.ni.primaryThreshold *= k;
    out.ni.upperEarningsLimit *= k;
    out.ni.lowerEarningsLimit *= k;
  }
  if (items.has('savingsAndDividendAllowances')) {
    out.savings.startingRateBand *= k;
    out.savings.psaBasic *= k;
    out.savings.psaHigher *= k;
    out.savings.psaAdditional *= k;
    out.dividends.allowance *= k;
  }
  if (items.has('cgtExempt')) out.cgt.annualExempt *= k;
  if (items.has('isaAllowance')) {
    out.isa.annualAllowance *= k;
    out.lisa.annualAllowance *= k;
    if (out.isa.cashIsaSubLimit != null) out.isa.cashIsaSubLimit *= k;   // null = no sub-limit
  }
  if (items.has('pensionAllowances')) {
    out.pension.annualAllowance *= k;
    out.pension.mpaa *= k;
    out.pension.lumpSumAllowance *= k;
    out.pension.basicAmount *= k;
    out.pension.taperThresholdIncome *= k;
    out.pension.taperAdjustedIncome *= k;
    out.pension.taperMinimumAllowance *= k;
  }
  return out;
}

/**
 * Threshold uprating factor for `taxYear`.
 * Returns 1 up to and including `thresholdsFrozenThroughTaxYear`. Afterwards:
 * 'inflation' = inflationIndexAtYear / inflationIndexAtFreezeEnd;
 * 'wageGrowth' = ((1 + inflation.mean) * (1 + wageGrowthRealPct)) ^ yearsSinceFreeze;
 * 'none' = 1.
 */
export function thresholdFactor(config: ConfigBundle, taxYear: string, inflationIndexAtYear: number, inflationIndexAtFreezeEnd: number): number {
  const freezeEnd = taxYearStartYear(config.taxProjection.thresholdsFrozenThroughTaxYear);
  const year = taxYearStartYear(taxYear);
  if (year <= freezeEnd) return 1;
  switch (config.taxProjection.upratingAfterFreeze) {
    case 'inflation':
      return inflationIndexAtFreezeEnd > 0 ? inflationIndexAtYear / inflationIndexAtFreezeEnd : 1;
    case 'wageGrowth': {
      const g = (1 + config.market.inflation.mean) * (1 + config.market.wageGrowthRealPct);
      return Math.pow(g, year - freezeEnd);
    }
    case 'none':
      return 1;
  }
}
