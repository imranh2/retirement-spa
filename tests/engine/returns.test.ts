import { describe, it, expect } from 'vitest';
import { lognormalParams, realReturnFromZ, generateReturns, accountReturn, propertyNominalReturn, deterministicReturns } from '../../src/engine/returns';
import { mulberry32, nextNormal } from '../../src/engine/prng';
import { TEST_CONFIG } from '../fixtures/testConfig';
import type { HistoricalReturnRow } from '../../src/config/configTypes';

describe('lognormal returns', () => {
  it('conversion matches the hand-checked value', () => {
    const { mu, sigma2 } = lognormalParams(0.05, 0.16);
    // About 0.02296; exact ln(1 + 0.0256 / 1.1025) = 0.0229545
    expect(sigma2).toBeCloseTo(0.02296, 4);
    expect(sigma2).toBeCloseTo(Math.log(1 + 0.0256 / 1.1025), 12);
    expect(mu).toBeCloseTo(0.0373, 4);
  });
  it('200,000 real returns have mean ~0.05 and stdev ~0.16', () => {
    const { mu, sigma2 } = lognormalParams(0.05, 0.16);
    const rng = mulberry32(3);
    const n = 200000;
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const r = realReturnFromZ(mu, sigma2, nextNormal(rng)); s += r; s2 += r * r; }
    const mean = s / n;
    expect(Math.abs(mean - 0.05)).toBeLessThan(0.005);
    expect(Math.abs(Math.sqrt(s2 / n - mean * mean) - 0.16)).toBeLessThan(0.01);
  });
  it('each year of a run is a fresh draw', () => {
    const r = generateReturns({ market: TEST_CONFIG.market, historical: [], model: 'lognormal', years: 10, rng: mulberry32(5) });
    expect(new Set(r.map((y) => y.equities)).size).toBe(10);
    expect(r.every((y) => y.inflation >= TEST_CONFIG.market.inflation.floor)).toBe(true);
  });
});

describe('deterministic mode', () => {
  it('returns exactly the mean assumptions', () => {
    const r = generateReturns({ market: TEST_CONFIG.market, historical: [], model: 'lognormal', years: 3, rng: mulberry32(1), deterministic: true });
    for (const y of r) {
      expect(y.inflation).toBe(0.025);
      expect(y.equities).toBeCloseTo(1.05 * 1.025 - 1, 12);
      expect(y.cash).toBeCloseTo(1.005 * 1.025 - 1, 12);
    }
  });
});

describe('block bootstrap', () => {
  const rows: HistoricalReturnRow[] = Array.from({ length: 20 }, (_, i) => ({ year: 2000 + i, equities: i / 100, bonds: 0, cash: 0, property: 0, inflation: 0 }));
  it('throws a clear error with fewer than 10 rows', () => {
    expect(() => generateReturns({ market: TEST_CONFIG.market, historical: rows.slice(0, 9), model: 'historicalBlockBootstrap', years: 30, rng: mulberry32(1) }))
      .toThrow('Need at least 10 years of historical data');
  });
  it('returns contiguous 5-year blocks without wrapping', () => {
    const r = generateReturns({ market: TEST_CONFIG.market, historical: rows, model: 'historicalBlockBootstrap', years: 30, rng: mulberry32(9) });
    expect(r).toHaveLength(30);
    for (let b = 0; b < 30; b += 5) {
      const idx = r.slice(b, b + 5).map((y) => Math.round(y.equities * 100));
      for (let k = 1; k < 5; k++) expect(idx[k]).toBe(idx[0] + k);
      expect(idx[4]).toBeLessThan(20);
    }
  });
});

describe('account and property returns', () => {
  it('fee is applied multiplicatively once a year', () => {
    const yr = { equities: 0.1, bonds: 0.02, cash: 0.01, property: 0, inflation: 0.02 };
    const g = 0.6 * 0.1 + 0.4 * 0.02;
    expect(accountReturn({ equities: 0.6, bonds: 0.4, cash: 0, property: 0 }, yr, 0.01)).toBeCloseTo((1 + g) * 0.99 - 1, 12);
  });
  it('property growth substitutes the property’s own real growth for the market mean', () => {
    const yr = deterministicReturns(TEST_CONFIG.market);
    expect(propertyNominalReturn(yr, 0.01, 0.02)).toBeCloseTo(1.01 * 1.025 - 1, 12);
  });
});
