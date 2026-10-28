import { describe, it, expect } from 'vitest';
import { downsize, propertyEquity, propertyValueNext, rentNominal } from '../../src/engine/property';
import { simulate } from '../../src/engine/simulate';
import { cashOnlyScenario } from '../fixtures/testScenarios';
import { zeroWorldConfig } from '../fixtures/testConfig';

describe('property', () => {
  it('value grows with real draw, adjustment and inflation', () => {
    expect(propertyValueNext(100000, 0.02, 0.03, -0.01)).toBeCloseTo(100000 * 1.01 * 1.03, 6);
  });
  it('downsize releases value - newValue - mortgageBalance', () => {
    expect(downsize(500000, 300000, 1.1, 50000)).toEqual({ releasedEquity: 500000 - 330000 - 50000, newValue: 330000 });
  });
  it('rent inflates with the index', () => {
    expect(rentNominal({ id: 'p', name: 'p', value: 1, growthRealPct: 0, isMainResidence: false, runningCostsAnnual: 0, rentalIncomeAnnual: 10000 }, 1.2)).toBeCloseTo(12000, 9);
    expect(propertyEquity(300000, 100000)).toBe(200000);
  });
  it('main residence is excluded from the portfolio but included in net worth', () => {
    const s = cashOnlyScenario({ pot: 100000, spend: 0, horizonYears: 3 });
    s.properties = [{ id: 'home', name: 'Home', value: 400000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0 }];
    const r = simulate(s, zeroWorldConfig());
    expect(r.portfolioReal.p50[0]).toBeCloseTo(100000, 6);
    expect(r.netWorthReal.p50[0]).toBeCloseTo(500000, 6);
  });
  it('downsizing pays released equity into the chosen account once', () => {
    const s = cashOnlyScenario({ pot: 10000, spend: 0, horizonYears: 4 });
    s.properties = [{ id: 'home', name: 'Home', value: 400000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0,
      mortgage: { balance: 50000, type: 'interestOnly', rate: 0, fixedYearsRemaining: 0, reversionRate: 0, termYearsRemaining: 20, monthlyOverpayment: 0 },
      downsize: { atAge: 62, newValue: 250000, releaseToAccountId: 'cash' } }];
    const r = simulate(s, zeroWorldConfig());
    expect(r.portfolioReal.p50[1]).toBeCloseTo(10000, 6);
    expect(r.portfolioReal.p50[2]).toBeCloseTo(10000 + 400000 - 250000 - 50000, 6);
    expect(r.portfolioReal.p50[3]).toBeCloseTo(110000, 6);
    expect(r.centralCase[3].mortgageBalanceEnd).toBe(0);
    expect(r.netWorthReal.p50[3]).toBeCloseTo(110000 + 250000, 6);
  });
});
