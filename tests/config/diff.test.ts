import { describe, it, expect } from 'vitest';
import { diffConfig } from '../../src/config/configDiff';
import { DEFAULT_CONFIG } from '../../src/defaults/ukDefaults';

describe('diffConfig', () => {
  it('no changes gives no paths', () => {
    expect(diffConfig(DEFAULT_CONFIG, structuredClone(DEFAULT_CONFIG))).toEqual([]);
  });
  it('lists exactly the changed paths', () => {
    const m = structuredClone(DEFAULT_CONFIG);
    m.tax['2026/27'].personalAllowance = 15000;
    m.tax['2026/27'].incomeTaxBands[1].rate = 0.41;
    m.market.correlations[0][1] = 0.2;
    m.taxProjection.upratedItems = ['personalAllowance'];
    const d = diffConfig(DEFAULT_CONFIG, m).map((c) => c.path).sort();
    expect(d).toEqual([
      'market.correlations[0][1]',
      'tax.2026/27.incomeTaxBands[1].rate',
      'tax.2026/27.personalAllowance',
      'taxProjection.upratedItems',
    ]);
  });
});
