import { describe, it, expect } from 'vitest';
import { validateConfig, validateAllocations } from '../../src/config/configValidate';
import { TEST_CONFIG } from '../fixtures/testConfig';

const paths = (c: typeof TEST_CONFIG) => validateConfig(c).map((i) => i.path);

describe('validateConfig', () => {
  it('accepts the fixture', () => {
    expect(validateConfig(TEST_CONFIG)).toEqual([]);
  });
  it('flags bands not ascending', () => {
    const c = structuredClone(TEST_CONFIG);
    c.tax['2026/27'].incomeTaxBands[1].upTo = 30000;
    expect(paths(c)).toContain('tax.2026/27.incomeTaxBands[1].upTo');
  });
  it('flags last band upTo not null', () => {
    const c = structuredClone(TEST_CONFIG);
    c.tax['2026/27'].incomeTaxBands[2].upTo = 200000;
    expect(validateConfig(c).some((i) => i.path === 'tax.2026/27.incomeTaxBands[2].upTo' && /last band/i.test(i.message))).toBe(true);
  });
  it('flags rate outside 0..1', () => {
    const c = structuredClone(TEST_CONFIG);
    c.tax['2026/27'].incomeTaxBands[0].rate = 1.5;
    c.tax['2026/27'].cgt.basicRate = -0.1;
    expect(paths(c)).toContain('tax.2026/27.incomeTaxBands[0].rate');
    expect(paths(c)).toContain('tax.2026/27.cgt.basicRate');
  });
  it('flags asymmetric correlation matrix and bad diagonal', () => {
    const c = structuredClone(TEST_CONFIG);
    c.market.correlations[0][1] = 0.3;
    c.market.correlations[2][2] = 0.9;
    const ps = paths(c);
    expect(ps).toContain('market.correlations[0][1]');
    expect(ps).toContain('market.correlations[2][2]');
  });
  it('warns (not errors) when the matrix is not positive semi-definite', () => {
    const c = structuredClone(TEST_CONFIG);
    const m = [[1, 0.9, -0.9, 0, 0], [0.9, 1, 0.9, 0, 0], [-0.9, 0.9, 1, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]];
    c.market.correlations = m;
    const issues = validateConfig(c);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });
  it('flags an unsorted State Pension age schedule', () => {
    const c = structuredClone(TEST_CONFIG);
    c.statePension.ageSchedule[3].bornOnOrAfter = '1950-01-01';
    expect(paths(c)).toContain('statePension.ageSchedule[3].bornOnOrAfter');
  });
  it('flags allocation not summing to 1', () => {
    const issues = validateAllocations([{ allocation: { equities: 0.5, bonds: 0.3, cash: 0.1, property: 0 } }]);
    expect(issues).toHaveLength(1);
    expect(validateAllocations([{ allocation: { equities: 0.5, bonds: 0.4, cash: 0.1, property: 0 } }])).toEqual([]);
  });
});
