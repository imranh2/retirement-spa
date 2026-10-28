import { describe, it, expect } from 'vitest';
import { bandsFromStart } from '../../src/ui/results';

describe('fan chart starts from today', () => {
  it('puts the known starting value at the start age and each year-end value at the next age', () => {
    const b = { p5: [90, 80], p10: [92, 85], p25: [95, 90], p50: [100, 100], p75: [105, 110], p90: [108, 115], p95: [110, 120] };
    const out = bandsFromStart([50, 51], b, 100);
    expect(out.ages).toEqual([50, 51, 52]);
    expect(out.bands.p5).toEqual([100, 90, 80]);
    expect(out.bands.p95).toEqual([100, 110, 120]);
    expect(b.p5).toEqual([90, 80]);   // input not mutated
  });
});
