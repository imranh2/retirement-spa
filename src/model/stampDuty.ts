import type { TaxYearConfig } from '../config/configTypes';

type StampDutyRules = TaxYearConfig['stampDuty'];

/**
 * Stamp Duty Land Tax on buying a home for `price` (England and NI), charged in slices of the
 * price. First-time buyers pay nothing up to the relief band and the relief rate above it, but
 * only on homes up to the relief price limit; above that the normal rates apply.
 */
export function stampDuty(price: number, firstTimeBuyer: boolean, sd: StampDutyRules): number {
  const slice = (from: number, to: number, rate: number) => Math.max(0, Math.min(price, to) - from) * rate;
  if (firstTimeBuyer && price <= sd.ftbMaxPrice) return slice(sd.ftbNilBand, sd.ftbMaxPrice, sd.ftbRate);
  return slice(sd.nilBand, sd.band2Top, sd.band2Rate) + slice(sd.band2Top, sd.band3Top, sd.band3Rate)
    + slice(sd.band3Top, sd.band4Top, sd.band4Rate) + slice(sd.band4Top, Number.POSITIVE_INFINITY, sd.topRate);
}
