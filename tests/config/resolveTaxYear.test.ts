import { describe, it, expect } from 'vitest';
import { resolveTaxYear, thresholdFactor } from '../../src/config/resolveTaxYear';
import { TEST_CONFIG } from '../fixtures/testConfig';

describe('resolveTaxYear', () => {
  it('returns a defined year unchanged and does not mutate config', () => {
    const before = structuredClone(TEST_CONFIG);
    const r = resolveTaxYear(TEST_CONFIG, '2026/27', 2);
    expect(r).toEqual(TEST_CONFIG.tax['2026/27']);
    r.personalAllowance = 1;
    expect(TEST_CONFIG).toEqual(before);
  });

  it('during the freeze, later years copy the latest year with thresholds unchanged', () => {
    const r = resolveTaxYear(TEST_CONFIG, '2029/30', thresholdFactor(TEST_CONFIG, '2029/30', 1.1, 1));
    expect(r.taxYear).toBe('2029/30');
    expect(r.personalAllowance).toBe(12570);
    expect(r.incomeTaxBands[0].upTo).toBe(37700);
  });

  it('after the freeze, uprated thresholds scale; rates and other items do not', () => {
    const f = thresholdFactor(TEST_CONFIG, '2032/33', 1.21, 1.1);
    expect(f).toBeCloseTo(1.1, 12);
    const r = resolveTaxYear(TEST_CONFIG, '2032/33', f);
    expect(r.personalAllowance).toBeCloseTo(12570 * 1.1, 6);
    expect(r.incomeTaxBands[1].upTo).toBeCloseTo(125140 * 1.1, 6);
    expect(r.incomeTaxBands[2].upTo).toBeNull();
    expect(r.ni.primaryThreshold).toBeCloseTo(12570 * 1.1, 6);
    expect(r.incomeTaxBands.map((b) => b.rate)).toEqual([0.2, 0.4, 0.45]);
    expect(r.ni.mainRate).toBe(0.08);
    expect(r.cgt.annualExempt).toBe(3000);          // not in upratedItems
    expect(r.isa.annualAllowance).toBe(20000);
    expect(r.dividends.allowance).toBe(500);
  });

  it('thresholdFactor: 1 during freeze, wage growth compounds, none is 1', () => {
    expect(thresholdFactor(TEST_CONFIG, '2030/31', 2, 1)).toBe(1);
    const w = structuredClone(TEST_CONFIG);
    w.taxProjection.upratingAfterFreeze = 'wageGrowth';
    expect(thresholdFactor(w, '2032/33', 9, 9)).toBeCloseTo((1.025 * 1.01) ** 2, 12);
    w.taxProjection.upratingAfterFreeze = 'none';
    expect(thresholdFactor(w, '2040/41', 9, 1)).toBe(1);
  });
});
