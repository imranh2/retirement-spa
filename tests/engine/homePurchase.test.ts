import { describe, it, expect } from 'vitest';
import { simulate } from '../../src/engine/simulate';
import { stampDuty } from '../../src/engine/property';
import { validateScenario } from '../../src/model/validateScenario';
import { TEST_CONFIG, zeroWorldConfig } from '../fixtures/testConfig';
import { account, cashOnlyScenario } from '../fixtures/testScenarios';
import type { Mortgage, Scenario } from '../../src/model/types';

const SD = TEST_CONFIG.tax['2026/27'].stampDuty;
const LOAN_TERMS: Mortgage = { balance: 0, type: 'repayment', rate: 0.05, fixedYearsRemaining: 5, reversionRate: 0.05, termYearsRemaining: 25, monthlyOverpayment: 0 };

/** Age 35, renting at £1,000 a month, £100k cash, buying a £300k home at 37 with a 10% deposit. */
function buyer(firstTimeBuyer = true): Scenario {
  const s = cashOnlyScenario({ startAge: 35, pot: 100_000, spend: 10_000, horizonYears: 10 });
  s.rentPaid = [{ id: 'r', name: 'Rent', monthly: 1_000, growthRealPct: 0 }];
  s.properties = [{ id: 'h', name: 'Home', value: 300_000, growthRealPct: 0, isMainResidence: true, runningCostsAnnual: 0,
    buyAtAge: 37, depositPct: 0.1, buyingCosts: 2_000, firstTimeBuyer, mortgage: { ...LOAN_TERMS } }];
  return s;
}
const rows = (s: Scenario) => simulate(s, zeroWorldConfig(), { runsOverride: 1 }).centralCase;

describe('stamp duty (England and NI)', () => {
  it('is charged in slices at the normal rates', () => {
    expect(stampDuty(125_000, false, SD)).toBe(0);
    expect(stampDuty(300_000, false, SD)).toBeCloseTo(125_000 * 0.02 + 50_000 * 0.05, 6);
    expect(stampDuty(1_000_000, false, SD)).toBeCloseTo(2_500 + 675_000 * 0.05 + 75_000 * 0.10, 6);
  });
  it('has first-time buyer relief up to the price limit, and none above it', () => {
    expect(stampDuty(300_000, true, SD)).toBe(0);
    expect(stampDuty(400_000, true, SD)).toBeCloseTo(100_000 * 0.05, 6);
    expect(stampDuty(600_000, true, SD)).toBeCloseTo(stampDuty(600_000, false, SD), 6);
  });
});

describe('buying a home later', () => {
  it('pays deposit, stamp duty and fees from savings in the year of purchase, then the mortgage; rent stops', () => {
    const r = rows(buyer(false));
    expect(r[0].rentPaid).toBeCloseTo(12_000, 6);
    expect(r[1].rentPaid).toBeCloseTo(12_000, 6);
    expect(r[2].rentPaid).toBe(0);                                  // bought at 37: rent with no end age stops
    expect(r[2].homePurchase).toBeCloseTo(30_000 + 5_000 + 2_000, 6);
    expect(r[1].mortgagePayments).toBe(0);
    expect(r[2].mortgagePayments).toBeGreaterThan(0);              // the £270k mortgage starts that year
    expect(r[1].propertyEquityEnd).toBe(0);                        // not owned yet
    expect(r[2].propertyEquityEnd).toBeCloseTo(300_000 - r[2].mortgageBalanceEnd, 4);
  });
  it('a first-time buyer pays no stamp duty up to £300k and uses a LISA towards the deposit first', () => {
    const s = buyer(true);
    s.accounts.push(account('lisa', 'lisa', 20_000));
    s.withdrawalOrder = ['cash', 'lisa'];
    const r = rows(s);
    expect(r[2].homePurchase).toBeCloseTo(30_000 + 2_000, 6);
    expect(r[2].drawLisa).toBeCloseTo(20_000, 6);
  });
  it('is checked: the age must be in the future and a deposit under 100% needs a mortgage', () => {
    const s = buyer();
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    s.properties[0].buyAtAge = 35;
    expect(validateScenario(s, TEST_CONFIG).map((i) => i.path)).toContain('properties[0].buyAtAge');
    const t = buyer();
    delete t.properties[0].mortgage;
    expect(validateScenario(t, TEST_CONFIG).map((i) => i.path)).toContain('properties[0].depositPct');
  });
});

describe('pay that does not rise with inflation', () => {
  it('stays fixed in pounds, so it is worth less each year in today’s money', () => {
    const s = cashOnlyScenario({ startAge: 40, pot: 100_000, spend: 10_000, horizonYears: 5 });
    s.people[0] = { ...s.people[0], salary: 50_000, retirementAge: 60, salaryInflationLinked: false };
    const r = simulate(s, TEST_CONFIG, { runsOverride: 1 }).centralCase;
    const infl = TEST_CONFIG.market.inflation.mean;
    expect(r[3].salary * r[3].priceIndex!).toBeCloseTo(50_000, 4);
    expect(r[3].salary).toBeCloseTo(50_000 / (1 + infl) ** 3, 4);
  });
});
