import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/defaults/ukDefaults';
import { CONFIG_FIELDS, expandFields } from '../../src/config/configFields';
import { leafPaths } from '../../src/config/paths';
import { validateConfig } from '../../src/config/configValidate';

describe('config registry coverage', () => {
  it('every leaf path in DEFAULT_CONFIG has a configFields entry', () => {
    const registered = new Set(expandFields(DEFAULT_CONFIG).map((f) => f.path));
    const missing = leafPaths(DEFAULT_CONFIG).filter((p) => !registered.has(p));
    expect(missing).toEqual([]);
  });
  it('every registry entry has a label, tooltip, group and lastVerified', () => {
    for (const f of CONFIG_FIELDS) {
      expect(f.label, f.path).not.toBe('');
      expect(f.tooltip.length, f.path).toBeGreaterThan(10);
      expect(f.lastVerified, f.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('every UK-rule field has a gov.uk sourceUrl', () => {
    const assumptionGroups = new Set(['Market assumptions', 'Historical returns']);
    const noSource = CONFIG_FIELDS.filter((f) => !assumptionGroups.has(f.group) && !f.sourceUrl?.startsWith('https://www.gov.uk/'));
    expect(noSource.map((f) => f.path)).toEqual([]);
  });
  it('shipped defaults are valid', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });
});
