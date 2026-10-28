// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { Scenario, SimulationResult } from '../../src/model/types';
import { costsOnTop, verdictText, whatMustBePaid } from '../../src/ui/verdict';
import { EXAMPLE_SCENARIOS } from '../../src/ui/exampleScenarios';

const base = (): Scenario => ({ ...structuredClone(EXAMPLE_SCENARIOS[0].scenario), properties: [] });
const home = { id: 'h', name: 'Home', value: 400000, growthRealPct: 0, runningCostsAnnual: 0, isMainResidence: true } as Scenario['properties'][number];

describe('costs paid on top of the spending plan', () => {
  it('names the mortgage and running costs only when there are any', () => {
    expect(costsOnTop(base())).toBeNull();
    expect(costsOnTop({ ...base(), properties: [{ ...home, runningCostsAnnual: 2000 }] })).toBe('property running costs');
    const mortgage = { balance: 200000, type: 'repayment', rate: 0.04, fixedYearsRemaining: 0, reversionRate: 0.04, termYearsRemaining: 20, monthlyOverpayment: 0 } as const;
    expect(costsOnTop({ ...base(), properties: [{ ...home, mortgage }] })).toBe('mortgage payments');
    expect(costsOnTop({ ...base(), properties: [{ ...home, runningCostsPctOfValue: 0.01, mortgage }] })).toBe('mortgage payments and property running costs');
    expect(whatMustBePaid({ ...base(), properties: [{ ...home, runningCostsPctOfValue: 0.01, mortgage }] })).toBe('spending, mortgage payments, property running costs and tax');
    expect(whatMustBePaid(base())).toBe('spending and tax');
  });
  it('says the max spend is on top of the mortgage in the verdict', () => {
    const s = { ...base(), properties: [{ ...home, mortgage: { balance: 1, type: 'repayment', rate: 0, fixedYearsRemaining: 0, reversionRate: 0, termYearsRemaining: 1, monthlyOverpayment: 0 } as const }] };
    const v = verdictText({} as SimulationResult, s, { multiplier: 1.5, annualSpendReal: 45000, targetSuccessRate: 0.9, warnings: [] });
    expect(v.spend).toContain('£45,000 a year (plus your mortgage payments)');
    expect(verdictText({} as SimulationResult, base(), { multiplier: 1.5, annualSpendReal: 45000, targetSuccessRate: 0.9, warnings: [] }).spend).not.toContain('plus your');
  });
});
