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
 * Running costs for the year in nominal terms. After downsizing they scale with the new
 * home's value relative to the old one (both in today's money).
 */
export function runningCostsNominal(property: Property, inflationIndex: number, downsized = false): number {
  const d = property.downsize;
  const scale = downsized && d && property.value > 0 ? d.newValue / property.value : 1;
  return property.runningCostsAnnual * scale * inflationIndex;
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
