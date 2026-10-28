import type { AssetAllocation } from '../model/types';
import type { HistoricalReturnRow, MarketAssumptions } from '../config/configTypes';
import { makeCorrelatedSampler, type Rng } from './prng';
import { BOOTSTRAP_BLOCK_YEARS, MIN_BOOTSTRAP_YEARS, MONTHS_PER_YEAR } from './constants';

/** One year's returns: the four assets are NOMINAL; inflation is the draw. */
export interface YearReturns { equities: number; bonds: number; cash: number; property: number; inflation: number }

export type ReturnModel = 'lognormal' | 'historicalBlockBootstrap';

/** Lognormal parameters for arithmetic mean real return m and volatility s. */
export function lognormalParams(m: number, s: number): { mu: number; sigma2: number } {
  const G = 1 + m;
  const sigma2 = Math.log(1 + (s * s) / (G * G));
  return { mu: Math.log(G) - sigma2 / 2, sigma2 };
}

/** Real return from lognormal parameters and a standard normal z. */
export function realReturnFromZ(mu: number, sigma2: number, z: number): number {
  return Math.exp(mu + Math.sqrt(sigma2) * z) - 1;
}

/** Nominal return from a real return and inflation. */
export function nominalFromReal(real: number, inflation: number): number {
  return (1 + real) * (1 + inflation) - 1;
}

/** Real return from a nominal return and inflation. */
export function realFromNominal(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/** Mean-assumption returns used every year in deterministic mode. */
export function deterministicReturns(m: MarketAssumptions): YearReturns {
  const i = m.inflation.mean;
  return {
    equities: nominalFromReal(m.equities.meanReal, i),
    bonds: nominalFromReal(m.bonds.meanReal, i),
    cash: nominalFromReal(m.cash.meanReal, i),
    property: nominalFromReal(m.property.meanReal, i),
    inflation: i,
  };
}

export interface GenerateReturnsInput {
  market: MarketAssumptions;
  historical: HistoricalReturnRow[];
  model: ReturnModel;
  years: number;
  rng: Rng;
  deterministic?: boolean;
}

/**
 * Returns for `years` consecutive years of one run.
 * lognormal: correlated draws. Bootstrap: random 5-year contiguous
 * blocks of the history (no wrapping), concatenated. Deterministic: means every year.
 * Throws if the bootstrap has fewer than 10 history rows.
 */
export function generateReturns(input: GenerateReturnsInput): YearReturns[] {
  const { market, historical, model, years, rng } = input;
  if (input.deterministic) {
    const r = deterministicReturns(market);
    return Array.from({ length: years }, () => ({ ...r }));
  }
  if (model === 'historicalBlockBootstrap') return bootstrapReturns(historical, years, rng);

  const sampler = makeCorrelatedSampler(rng, market.correlations);
  const assets = [market.equities, market.bonds, market.cash, market.property];
  const params = assets.map((a) => lognormalParams(a.meanReal, a.vol));
  const out: YearReturns[] = new Array(years);
  for (let t = 0; t < years; t++) {
    const z = sampler();
    const inflation = Math.max(market.inflation.floor, market.inflation.mean + market.inflation.vol * z[4]);
    const nom = params.map((p, k) => nominalFromReal(realReturnFromZ(p.mu, p.sigma2, z[k]), inflation));
    out[t] = { equities: nom[0], bonds: nom[1], cash: nom[2], property: nom[3], inflation };
  }
  return out;
}

/** Monthly equivalent of an annual rate: (1 + r)^(1/12) - 1. */
export function monthlyRate(annual: number): number {
  return Math.pow(1 + annual, 1 / MONTHS_PER_YEAR) - 1;
}

/**
 * Monthly returns for `years * 12` months of one run (Phase 13).
 * lognormal: each month draws correlated normals; assets use the annual lognormal
 * parameters scaled to mu/12 and sigma2/12 (vol / sqrt(12) on the log scale). Inflation
 * uses log mean ln(1 + mean)/12 and log vol vol/sqrt(12); the floor applies to each
 * year's compounded inflation (as in annual mode): if a year compounds below it, every
 * month of that year is set to the monthly equivalent of the floor. With zero volatility,
 * 12 months compound exactly to the annual means. Bootstrap and deterministic modes split each annual value into 12
 * equal geometric monthly steps.
 */
export function generateMonthlyReturns(input: GenerateReturnsInput): YearReturns[] {
  const packed = generateMonthlyReturnsPacked(input);
  return Array.from({ length: packed.length / RETURN_FIELDS }, (_, k) => unpackReturn(packed, k, { equities: 0, bonds: 0, cash: 0, property: 0, inflation: 0 }));
}

/** Values per month in a packed return array: equities, bonds, cash, property, inflation. */
export const RETURN_FIELDS = 5;

/** Copy month `k` of a packed array into `into` (reused to avoid allocation) and return it. */
export function unpackReturn(packed: Float64Array, k: number, into: YearReturns): YearReturns {
  const o = k * RETURN_FIELDS;
  into.equities = packed[o]; into.bonds = packed[o + 1]; into.cash = packed[o + 2]; into.property = packed[o + 3]; into.inflation = packed[o + 4];
  return into;
}

/** As generateMonthlyReturns, packed into a Float64Array (5 values per month) for speed. */
export function generateMonthlyReturnsPacked(input: GenerateReturnsInput): Float64Array {
  const { market, years, rng } = input;
  const months = years * MONTHS_PER_YEAR;
  const out = new Float64Array(months * RETURN_FIELDS);
  if (input.deterministic || input.model === 'historicalBlockBootstrap') {
    generateReturns(input).forEach((y, t) => {
      const m = [monthlyRate(y.equities), monthlyRate(y.bonds), monthlyRate(y.cash), monthlyRate(y.property), monthlyRate(y.inflation)];
      for (let k = 0; k < MONTHS_PER_YEAR; k++) out.set(m, (t * MONTHS_PER_YEAR + k) * RETURN_FIELDS);
    });
    return out;
  }
  const sampler = makeCorrelatedSampler(rng, market.correlations);
  const params = [market.equities, market.bonds, market.cash, market.property].map((a) => lognormalParams(a.meanReal, a.vol));
  const scale = Math.sqrt(1 / MONTHS_PER_YEAR);
  const mu = params.map((p) => p.mu / MONTHS_PER_YEAR);
  const sd = params.map((p) => Math.sqrt(p.sigma2) * scale);
  const inflMu = Math.log(1 + market.inflation.mean) / MONTHS_PER_YEAR;
  const inflSd = market.inflation.vol * scale;
  const inflFloor = monthlyRate(market.inflation.floor);
  const realGrowth = new Float64Array(MONTHS_PER_YEAR * 4);
  const infl = new Float64Array(MONTHS_PER_YEAR);
  for (let y = 0; y < years; y++) {
    let yearInflation = 1;
    for (let k = 0; k < MONTHS_PER_YEAR; k++) {
      const z = sampler();
      for (let a = 0; a < 4; a++) realGrowth[k * 4 + a] = Math.exp(mu[a] + sd[a] * z[a]);
      infl[k] = Math.exp(inflMu + inflSd * z[4]) - 1;
      yearInflation *= 1 + infl[k];
    }
    if (yearInflation - 1 < market.inflation.floor) infl.fill(inflFloor);
    for (let k = 0; k < MONTHS_PER_YEAR; k++) {
      const o = (y * MONTHS_PER_YEAR + k) * RETURN_FIELDS;
      const g = 1 + infl[k];
      for (let a = 0; a < 4; a++) out[o + a] = realGrowth[k * 4 + a] * g - 1;
      out[o + 4] = infl[k];
    }
  }
  return out;
}

/** Block bootstrap of nominal history. Throws with fewer than MIN_BOOTSTRAP_YEARS rows. */
export function bootstrapReturns(history: HistoricalReturnRow[], years: number, rng: Rng): YearReturns[] {
  if (history.length < MIN_BOOTSTRAP_YEARS) throw new Error(`Need at least ${MIN_BOOTSTRAP_YEARS} years of historical data`);
  const rows = [...history].sort((a, b) => a.year - b.year);
  const block = Math.min(BOOTSTRAP_BLOCK_YEARS, rows.length);
  const starts = rows.length - block + 1;
  const out: YearReturns[] = [];
  while (out.length < years) {
    const s = Math.floor(rng() * starts);
    for (let k = 0; k < block && out.length < years; k++) {
      const r = rows[s + k];
      out.push({ equities: r.equities, bonds: r.bonds, cash: r.cash, property: r.property, inflation: r.inflation });
    }
  }
  return out;
}

/** Account return for the year: allocation-weighted nominal return, then the fee multiplicatively. */
export function accountReturn(allocation: AssetAllocation, yr: YearReturns, annualFeePct: number): number {
  const gross = allocation.equities * yr.equities + allocation.bonds * yr.bonds
    + allocation.cash * yr.cash + allocation.property * yr.property;
  return (1 + gross) * (1 - annualFeePct) - 1;
}

/** Nominal return of a specific property: market property real draw shifted by its own growth assumption. */
export function propertyNominalReturn(yr: YearReturns, growthRealPct: number, marketPropertyMeanReal: number): number {
  const real = realFromNominal(yr.property, yr.inflation) + (growthRealPct - marketPropertyMeanReal);
  return nominalFromReal(real, yr.inflation);
}
