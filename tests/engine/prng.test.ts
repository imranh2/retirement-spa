import { describe, it, expect } from 'vitest';
import { mulberry32, nextNormal, choleskyDecompose, makeCorrelatedSampler, runSeed } from '../../src/engine/prng';
import { TEST_CONFIG } from '../fixtures/testConfig';

describe('mulberry32', () => {
  it('same seed gives the same sequence; different seeds differ', () => {
    const a = mulberry32(42); const b = mulberry32(42); const c = mulberry32(43);
    const sa = Array.from({ length: 5 }, a); const sb = Array.from({ length: 5 }, b); const sc = Array.from({ length: 5 }, c);
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it('run seeds are distinct per run', () => {
    expect(runSeed(1, 0)).not.toBe(runSeed(1, 1));
  });
});

describe('nextNormal', () => {
  it('100,000 draws have mean ~0 and stdev ~1', () => {
    const rng = mulberry32(7);
    const n = 100000;
    let s = 0; let s2 = 0;
    for (let i = 0; i < n; i++) { const z = nextNormal(rng); s += z; s2 += z * z; }
    const mean = s / n;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(Math.sqrt(s2 / n - mean * mean) - 1)).toBeLessThan(0.02);
  });
  it('the cached spare belongs to one generator only', () => {
    const a = mulberry32(1); const b = mulberry32(1);
    nextNormal(a);                       // a now holds a spare
    const firstB = nextNormal(b);        // b must not receive a's spare
    const fresh = mulberry32(1);
    expect(firstB).toBe(nextNormal(fresh));
  });
});

describe('cholesky and correlated sampler', () => {
  const m = TEST_CONFIG.market.correlations;
  it('L * L^T reproduces the default matrix within 1e-9', () => {
    const L = choleskyDecompose(m);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      let s = 0; for (let k = 0; k < 5; k++) s += L[i][k] * L[j][k];
      expect(Math.abs(s - m[i][j])).toBeLessThan(1e-9);
    }
  });
  it('throws a descriptive error for a non-positive-definite matrix', () => {
    expect(() => choleskyDecompose([[1, 2], [2, 1]])).toThrow(/not positive definite/);
  });
  it('sampled correlations of 100,000 vectors are within 0.02 of target', () => {
    const sample = makeCorrelatedSampler(mulberry32(11), m);
    const n = 100000;
    const xs: number[][] = Array.from({ length: n }, sample);
    const corr = (i: number, j: number) => {
      let si = 0, sj = 0, sij = 0, sii = 0, sjj = 0;
      for (const x of xs) { si += x[i]; sj += x[j]; sij += x[i] * x[j]; sii += x[i] ** 2; sjj += x[j] ** 2; }
      const cov = sij / n - (si / n) * (sj / n);
      return cov / Math.sqrt((sii / n - (si / n) ** 2) * (sjj / n - (sj / n) ** 2));
    };
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) expect(Math.abs(corr(i, j) - m[i][j])).toBeLessThan(0.02);
  });
});

describe('run streams', () => {
  it('each run starts exactly where the previous run’s 32,768-draw block ends, so streams never overlap', () => {
    const r0 = mulberry32(runSeed(42, 0));
    for (let k = 0; k < 32768; k++) r0();
    const next = r0();
    expect(mulberry32(runSeed(42, 1))()).toBe(next);
  });
});
