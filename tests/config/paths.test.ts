import { describe, it, expect } from 'vitest';
import { getPath, setPath, deletePath, parsePath } from '../../src/config/paths';
import { parseHistoricalCsv } from '../../src/config/historicalCsv';

describe('paths', () => {
  it('parses keys containing slashes and indices', () => {
    expect(parsePath('tax.2026/27.incomeTaxBands[1].upTo')).toEqual(['tax', '2026/27', 'incomeTaxBands', 1, 'upTo']);
    expect(parsePath('market.correlations[1][2]')).toEqual(['market', 'correlations', 1, 2]);
  });
  it('setPath copies along the path and never mutates', () => {
    const o = { a: { b: [{ c: 1 }, { c: 2 }] }, z: { y: 1 } };
    const n = setPath(o, 'a.b[1].c', 5);
    expect(getPath(n, 'a.b[1].c')).toBe(5);
    expect(o.a.b[1].c).toBe(2);
    expect(n.z).toBe(o.z);
  });
  it('deletePath removes keys and array items', () => {
    const o = { a: [1, 2, 3], b: { c: 1, d: 2 } };
    expect(deletePath(o, 'a[1]')).toEqual({ a: [1, 3], b: { c: 1, d: 2 } });
    expect(deletePath(o, 'b.c')).toEqual({ a: [1, 2, 3], b: { d: 2 } });
  });
});

describe('parseHistoricalCsv', () => {
  it('parses rows with a header and reports bad lines', () => {
    const r = parseHistoricalCsv('year,equities,bonds,cash,property,inflation\n2001,0.1,0.02,0.01,0.05,0.02\n2000,-0.05,0.03,0.04,0.02,0.03\nbad,1\n2002,7%,0,0,0,0');
    expect(r.rows.map((x) => x.year)).toEqual([2000, 2001]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
  });
});
