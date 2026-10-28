import { describe, it, expect } from 'vitest';
import { minimumPensionAccessAge, accessAgeForAccount, isAccessible, splitPensionWithdrawal, pensionContributionCostNetPay, pensionContributionCostReliefAtSource, capPensionContributions, pensionAllowance, personalContributionLimit, taperedAnnualAllowance } from '../../src/engine/pension';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { account } from '../fixtures/testScenarios';
import type { Person } from '../../src/model/types';

const cfg = TEST_CONFIG.tax['2026/27'];
const access = TEST_CONFIG.pensionAccess;
const person = (dob: string): Person => ({ name: 'P', dateOfBirth: dob, salary: 0, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 30 });

describe('minimum pension access age', () => {
  it('55 if you reach 57 before 6 April 2028 (access is never interrupted)', () => {
    expect(minimumPensionAccessAge('1971-04-05', access)).toBe(55);   // 57 on 5 Apr 2028
    expect(minimumPensionAccessAge('1965-01-01', access)).toBe(55);
  });
  it('57 otherwise, including people who reach 55 shortly before the change and then lose access', () => {
    expect(minimumPensionAccessAge('1971-04-06', access)).toBe(55);   // 57 on 6 Apr 2028: never loses access
    expect(minimumPensionAccessAge('1971-04-07', access)).toBe(57);   // 57 the day after
    expect(minimumPensionAccessAge('1972-06-01', access)).toBe(57);   // 55 in 2027, locked again from Apr 2028
    expect(minimumPensionAccessAge('1973-04-06', access)).toBe(57);
    expect(minimumPensionAccessAge('1976-01-01', access)).toBe(57);
  });
  it('account override wins', () => {
    expect(accessAgeForAccount(account('p', 'dcPension', 1, { pensionAccessAge: 60 }), person('1976-01-01'), access)).toBe(60);
    expect(accessAgeForAccount(account('p', 'dcPension', 1), person('1976-01-01'), access)).toBe(57);
  });
  it('locked pension and LISA report not accessible', () => {
    expect(isAccessible(account('p', 'dcPension', 1), 56, 57, cfg)).toBe(false);
    expect(isAccessible(account('p', 'dcPension', 1), 57, 57, cfg)).toBe(true);
    expect(isAccessible(account('l', 'lisa', 1), 59, NaN, cfg)).toBe(false);
    expect(isAccessible(account('i', 'isa', 1), 20, NaN, cfg)).toBe(true);
  });
});

describe('tax-free cash (hand-checked vectors)', () => {
  it('40,000 with full LSA: 10,000 tax-free', () => expect(splitPensionWithdrawal(40000, 268275, cfg)).toEqual({ taxFree: 10000, taxable: 30000 }));
  it('1,200,000 at once is capped at the LSA', () => expect(splitPensionWithdrawal(1200000, 268275, cfg).taxFree).toBe(268275));
  it('40,000 with 5,000 LSA left: 5,000 tax-free', () => expect(splitPensionWithdrawal(40000, 5000, cfg)).toEqual({ taxFree: 5000, taxable: 35000 }));
});

describe('contribution relief', () => {
  it('net pay: cost is contribution minus tax saved', () => {
    const r = pensionContributionCostNetPay(5000, { nonSavings: 60000, savings: 0, dividends: 0 }, cfg);
    expect(r.taxSaved).toBeCloseTo(2000, 6);
    expect(r.outlay).toBeCloseTo(3000, 6);
  });
  it('relief at source: outlay is 80% and the basic band extends by the gross amount', () => {
    expect(pensionContributionCostReliefAtSource(5000, cfg)).toEqual({ outlay: 4000, basicBandExtension: 5000 });
  });
});

describe('allowance caps', () => {
  it('total capped at the annual allowance, employee reduced first', () => {
    const r = capPensionContributions(50000, 20000, 200000, pensionAllowance(false, cfg));
    expect(r.capped).toBe(true);
    expect(50000 * r.employeeScale + 20000 * r.employerScale).toBeCloseTo(60000, 6);
    expect(r.employerScale).toBe(1);
  });
  it('MPAA applies once triggered', () => {
    expect(pensionAllowance(true, cfg)).toBe(10000);
    const r = capPensionContributions(8000, 5000, 100000, pensionAllowance(true, cfg));
    expect(8000 * r.employeeScale + 5000 * r.employerScale).toBeCloseTo(10000, 6);
  });
  it('personal contributions capped at 100% of earnings', () => {
    const r = capPensionContributions(30000, 0, 20000, 60000);
    expect(30000 * r.employeeScale).toBeCloseTo(20000, 6);
  });
  it('no cap needed: unchanged', () => {
    expect(capPensionContributions(5000, 3000, 50000, 60000)).toEqual({ employeeScale: 1, employerScale: 1, capped: false });
  });
});

describe('basic amount (relief at source with low or no earnings)', () => {
  const cfg = TEST_CONFIG.tax['2026/27'];
  it('someone with no earnings can pay up to 3,600 gross by relief at source, but nothing by net pay', () => {
    expect(personalContributionLimit(0, 2880, 0, cfg)).toEqual({ netPay: 0, reliefAtSource: 2880 });
    expect(personalContributionLimit(0, 5000, 0, cfg)).toEqual({ netPay: 0, reliefAtSource: 3600 });
    expect(personalContributionLimit(2000, 0, 0, cfg)).toEqual({ netPay: 0, reliefAtSource: 0 });
  });
  it('earnings above the basic amount set the limit, shared with net pay first', () => {
    expect(personalContributionLimit(0, 9000, 8000, cfg)).toEqual({ netPay: 0, reliefAtSource: 8000 });
    expect(personalContributionLimit(1000, 5000, 2000, cfg)).toEqual({ netPay: 1000, reliefAtSource: 2600 });
    expect(personalContributionLimit(6000, 5000, 8000, cfg)).toEqual({ netPay: 6000, reliefAtSource: 2000 });
  });
});

describe('tapered annual allowance', () => {
  const cfg = TEST_CONFIG.tax['2026/27'];
  it('no taper unless both threshold income and adjusted income are over their limits', () => {
    expect(taperedAnnualAllowance(200000, 400000, cfg)).toBe(60000);
    expect(taperedAnnualAllowance(250000, 260000, cfg)).toBe(60000);
  });
  it('£1 off per £2 of adjusted income over 260,000, down to 10,000', () => {
    expect(taperedAnnualAllowance(250000, 300000, cfg)).toBe(40000);
    expect(taperedAnnualAllowance(350000, 360000, cfg)).toBe(10000);
    expect(taperedAnnualAllowance(500000, 500000, cfg)).toBe(10000);
  });
  it('the MPAA still applies when it is lower', () => {
    expect(pensionAllowance(true, cfg, 40000)).toBe(10000);
    expect(pensionAllowance(false, cfg, 40000)).toBe(40000);
  });
});
