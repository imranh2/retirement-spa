import { describe, it, expect } from 'vitest';
import { migrateConfig } from '../../src/config/configMigrate';
import { TEST_CONFIG } from '../fixtures/testConfig';
import type { ConfigBundle } from '../../src/config/configTypes';

describe('migrateConfig', () => {
  it('fills fields added in later versions and never changes existing values', () => {
    const old = structuredClone(TEST_CONFIG) as unknown as { tax: Record<string, { savings: Record<string, unknown>; personalAllowance: number }>; statePension: Record<string, unknown> };
    delete old.tax['2026/27'].savings.basicRate;
    delete old.statePension.deferralIncreasePerYear;
    old.tax['2026/27'].personalAllowance = 15000;
    old.tax['2030/31'] = structuredClone(old.tax['2026/27']);
    const m = migrateConfig(old as unknown as ConfigBundle, TEST_CONFIG);
    expect(m.tax['2026/27'].savings.basicRate).toBe(0.2);
    expect(m.tax['2030/31'].savings.basicRate).toBe(0.2);         // filled from the latest default year
    expect(m.statePension.deferralIncreasePerYear).toBe(TEST_CONFIG.statePension.deferralIncreasePerYear);
    expect(m.tax['2026/27'].personalAllowance).toBe(15000);
    expect(Object.keys(m.tax).sort()).toEqual(['2026/27', '2030/31']);
  });
  it('does not add back tax years the user removed', () => {
    const defaults = structuredClone(TEST_CONFIG);
    defaults.tax['2027/28'] = { ...structuredClone(defaults.tax['2026/27']), taxYear: '2027/28' };
    expect(Object.keys(migrateConfig(structuredClone(TEST_CONFIG), defaults).tax)).toEqual(['2026/27']);
  });
});
