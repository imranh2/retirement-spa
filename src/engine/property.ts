import type { Property } from '../model/types';


/**
 * Property value after one year: value * (1 + realDraw + growthAdjustment) * (1 + inflation).
 * `realDraw` is the market property real return; `growthAdjustment` is
 * property.growthRealPct - market.property.meanReal.
 */
export function propertyValueNext(value: number, realDraw: number, inflation: number, growthAdjustment: number): number {
  return value * (1 + realDraw + growthAdjustment) * (1 + inflation);
}

/** Gross rent for the year in nominal terms (0 if not let). */
export function rentNominal(property: Property, inflationIndex: number): number {
  return (property.rentalIncomeAnnual ?? 0) * inflationIndex;
}

/**
 * Running costs for the year in nominal terms: the fixed amount (today's money, inflated),
 * plus `runningCostsPctOfValue` of the home's current nominal value. After downsizing the
 * fixed amount scales with the new home's value relative to the old one (both today's money);
 * the percentage follows the new value by itself.
 */
export function runningCostsNominal(property: Property, inflationIndex: number, downsized = false, currentValue = property.value * inflationIndex): number {
  const d = property.downsize;
  const scale = downsized && d && property.value > 0 ? d.newValue / property.value : 1;
  return property.runningCostsAnnual * scale * inflationIndex + (property.runningCostsPctOfValue ?? 0) * currentValue;
}

/**
 * Downsize the main residence: sell at `currentValue`, buy at `newValueToday * inflationIndex`,
 * clear `mortgageBalance`. Positive releasedEquity is paid into an account; negative is a
 * shortfall added to that year's spending need. Main residence sale is CGT-exempt.
 */
export function downsize(currentValue: number, newValueToday: number, inflationIndex: number, mortgageBalance: number): { releasedEquity: number; newValue: number } {
  const newValue = newValueToday * inflationIndex;
  return { releasedEquity: currentValue - newValue - mortgageBalance, newValue };
}

/** Property equity: value minus outstanding mortgage. Counts towards net worth, never the portfolio. */
export function propertyEquity(value: number, mortgageBalance: number): number {
  return value - mortgageBalance;
}

export { stampDuty } from '../model/stampDuty';
