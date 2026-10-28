const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbpCompact = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', notation: 'compact', maximumFractionDigits: 1 });
const pct1 = new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });
const num = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** £1,234 */
export function formatMoney(v: number): string { return gbp.format(Number.isFinite(v) ? v : 0); }
/** £1.2M (axis labels) */
export function formatMoneyCompact(v: number): string { return gbpCompact.format(Number.isFinite(v) ? v : 0); }
/** 12.5% from a fraction */
export function formatPct(v: number): string { return pct1.format(Number.isFinite(v) ? v : 0); }
export function formatNum(v: number): string { return num.format(v); }

/** Fraction -> percent number for an input, without float noise (0.07 -> 7). */
export function toPercentInput(fraction: number): number {
  return Number((fraction * 100).toFixed(6));
}
