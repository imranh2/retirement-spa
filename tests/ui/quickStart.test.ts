// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { quickStartDefaults, quickStartScenario, type QuickStartInput } from '../../src/ui/quickStart';
import { validateScenario } from '../../src/model/validateScenario';
import { simulate } from '../../src/engine/simulate';
import { TEST_CONFIG } from '../fixtures/testConfig';

const START = '2026-10-29';
// The form starts with no date of birth; these tests answer as a 40-year-old unless they say otherwise.
const answers = (over: Partial<QuickStartInput> = {}): QuickStartInput => ({ ...quickStartDefaults(), dateOfBirth: '1986-10-29', ...over });
const build = (over: Partial<QuickStartInput> = {}) => quickStartScenario(answers(over), START, 50_000);

describe('quick start', () => {
  it('builds a valid plan from the default answers', () => {
    const s = build();
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    expect(s.accounts.map((a) => a.type)).toEqual(['cash', 'dcPension']);
    expect(s.contributions.map((c) => c.type)).toEqual(['pctOfSalary', 'employerPctOfSalary']);
    expect(s.surplus).toEqual({ kind: 'spend' });
    expect(s.sim.runs).toBe(10_000);
    expect(simulate(s, TEST_CONFIG, { runsOverride: 50 }).runs).toBe(50);
  });
  it('builds the plan from the answers that used to need changing afterwards', () => {
    const s = build({
      dateOfBirth: '1994-05-18', salary: 156_000, stopWorkAge: 33, spending: 24_000,
      cash: 70_000, premiumBonds: 50_000, gia: 170_000, isa: 350_000, pension: 250_000, pensionType: 'personal',
      pensionPct: 0.14, employerPct: 0.06, isaMonthly: 1_666,
      homeValue: 460_000, homeCostsPct: 0.01, mortgageBalance: 300_000, mortgageYears: 30, mortgageRate: 0.0475, mortgageFixedYears: 5, mortgageRateAfterFix: 0.075,
      mix: 'equities', feePct: 0, feeFixed: 90, niYears: 10, lumpSum: 85_000,
    });
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    expect(s.people[0]).toMatchObject({ dateOfBirth: '1994-05-18', niQualifyingYears: 10, retirementAge: 33 });
    const isa = s.accounts.find((a) => a.type === 'isa')!;
    expect(isa).toMatchObject({ allocation: { equities: 1 }, annualFeePct: 0, annualFeeFixed: 90 });
    expect(s.accounts.find((a) => a.type === 'dcPension')).toMatchObject({ name: 'SIPP', pensionReliefMethod: 'reliefAtSource' });
    expect(s.properties[0]).toMatchObject({ runningCostsPctOfValue: 0.01, mortgage: { rate: 0.0475, fixedYearsRemaining: 5, reversionRate: 0.075, termYearsRemaining: 30 } });
    expect(s.contributions.find((c) => c.id === 'c-lump')).toMatchObject({ type: 'lumpSum', source: 'external', amount: 85_000, startAge: 32, accountId: 'gia' });
    expect(s.withdrawalOrder).toEqual(['cash', 'gia', 'isa', 'dcPension', 'premiumBonds']);
  });
  it('a blank rate after the fix means the same rate; a blank NI figure is estimated from age', () => {
    const s = build({ mortgageBalance: 100_000, mortgageYears: 20, mortgageRate: 0.04 });
    expect(s.properties[0].mortgage).toMatchObject({ rate: 0.04, reversionRate: 0.04 });
    expect(s.people[0].niQualifyingYears).toBe(40 - 21);
  });
  it('investing left-over money sends it to the ISA', () => {
    const s = build({ leftover: 'invest' });
    expect(s.surplus).toEqual({ kind: 'invest', accountId: 'isa' });
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
  });
  it('handles someone not working, and a mortgage given without a home value', () => {
    const s = build({ dateOfBirth: '1964-01-01', salary: 0, stopWorkAge: 67, mortgageBalance: 50_000, mortgageYears: 5 });
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    expect(s.people[0].retirementAge).toBe(62);
    expect(s.contributions).toEqual([]);
    expect(s.properties[0].value).toBe(50_000);
  });
  it('Premium Bonds above the holding limit are counted as cash', () => {
    const s = build({ premiumBonds: 60_000 });
    expect(s.accounts.find((a) => a.type === 'premiumBonds')!.balance).toBe(50_000);
    expect(s.accounts.find((a) => a.type === 'cash')!.balance).toBe(10_000 + 10_000);
  });
  it('a renter gets rent paid and no home', () => {
    const s = build({ housing: 'rent', rentMonthly: 1_250, homeValue: 400_000, mortgageBalance: 100_000 });
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    expect(s.properties).toEqual([]);
    expect(s.rentPaid).toEqual([{ id: 'rent', name: 'Rent', monthly: 1_250, growthRealPct: 0 }]);
  });
  it('renting now and buying later builds a home bought at that age, with rent until then', () => {
    const s = build({ salary: 80_000, cash: 120_000, housing: 'rentThenBuy', rentMonthly: 1_100, buyAtAge: 43, buyPrice: 350_000, depositPct: 0.15, mortgageRate: 0.045, mortgageFixedYears: 5 });
    expect(validateScenario(s, TEST_CONFIG)).toEqual([]);
    expect(s.rentPaid?.[0]).toMatchObject({ monthly: 1_100 });
    expect(s.properties[0]).toMatchObject({ value: 350_000, buyAtAge: 43, depositPct: 0.15, firstTimeBuyer: true, mortgage: { termYearsRemaining: 25, rate: 0.045 } });
    const r = simulate(s, TEST_CONFIG, { runsOverride: 20 }).centralCase;
    const at43 = r.find((row) => row.age === 43)!;
    expect(at43.homePurchase).toBeGreaterThan(350_000 * 0.15);
    expect(at43.rentPaid).toBe(0);
  });
  it('assumes pay stays the same in pounds unless a rise is given', () => {
    expect(build().people[0]).toMatchObject({ salaryInflationLinked: false, salaryGrowthRealPct: 0 });
    expect(build({ payRisePct: 0.02 }).people[0].salaryGrowthRealPct).toBe(0.02);
  });
});
