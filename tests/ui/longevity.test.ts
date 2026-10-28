import { describe, it, expect } from 'vitest';
import { cumulativeDepletion, lastsLabel, moneyLastsUntil } from '../../src/ui/longevity';

const r = { ages: Array.from({ length: 35 }, (_, i) => 60 + i), runs: 100, depletionAgeHistogram: [{ age: 80, count: 10 }, { age: 70, count: 5 }] };

describe('how long the money lasts', () => {
  it('accumulates failures by age', () => {
    const cum = cumulativeDepletion(r);
    expect(cum[9]).toBe(0);
    expect(cum[10]).toBeCloseTo(0.05, 12);
    expect(cum[20]).toBeCloseTo(0.15, 12);
    expect(cum[34]).toBeCloseTo(0.15, 12);
  });
  it('finds the first age where more than (1 - confidence) of futures have run out', () => {
    expect(moneyLastsUntil(r, 0.9)).toEqual({ age: 80, beyond: false });
    expect(moneyLastsUntil(r, 0.95)).toEqual({ age: 80, beyond: false });   // exactly 5% by 70 is allowed
    expect(moneyLastsUntil(r, 0.96)).toEqual({ age: 70, beyond: false });
  });
  it('reports lasting beyond the plan when it never crosses', () => {
    const v = moneyLastsUntil(r, 0.5);
    expect(v).toEqual({ age: 95, beyond: true });
    expect(lastsLabel(v)).toBe('95+');
    expect(lastsLabel({ age: 80, beyond: false })).toBe('80');
  });
});
