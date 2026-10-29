import { describe, it, expect } from 'vitest';
import { calculateIncomeTax, calculateNI, calculateCGT } from '../../src/engine/tax';
import { TEST_CONFIG } from '../fixtures/testConfig';
import { DEFAULT_CONFIG } from '../../src/defaults/ukDefaults';

const cfg = TEST_CONFIG.tax['2026/27'];
const tax = (nonSavings: number, savings = 0, dividends = 0) => calculateIncomeTax({ nonSavings, savings, dividends }, cfg);

describe('income tax (hand-checked vectors)', () => {
  it('12,570 non-savings: 0', () => expect(tax(12570).total).toBe(0));
  it('50,000: 7,486', () => expect(tax(50000).total).toBeCloseTo(7486, 2));
  it('110,000: PA used 7,570; tax 33,432', () => {
    const r = tax(110000);
    expect(r.personalAllowanceUsed).toBeCloseTo(7570, 2);
    expect(r.total).toBeCloseTo(33432, 2);
  });
  it('30,000 + 2,000 savings: 3,686', () => expect(tax(30000, 2000).total).toBeCloseTo(3686, 2));
  it('savings interest uses the savings rates, which can differ from the income tax rates', () => {
    const cfg27 = { ...cfg, savings: { ...cfg.savings, basicRate: 0.22, higherRate: 0.42, additionalRate: 0.47 } };
    // 30,000 + 2,000 savings: 3,486 on earnings + (2,000 - 1,000 PSA) at 22%
    expect(calculateIncomeTax({ nonSavings: 30000, savings: 2000, dividends: 0 }, cfg27).total).toBeCloseTo(3706, 2);
  });
  it('0 + 4,000 savings: 0', () => expect(tax(0, 4000).total).toBe(0));
  it('110,000 with 10,000 gross relief-at-source contributions: full allowance (adjusted net income 100,000)', () => {
    const r = calculateIncomeTax({ nonSavings: 110000, savings: 0, dividends: 0 }, cfg, { basicBandExtension: 10000 });
    expect(r.personalAllowanceUsed).toBeCloseTo(12570, 2);
    // 47,700 extended basic band at 20% + 49,730 at 40%
    expect(r.total).toBeCloseTo(29432, 2);
  });
  it('125,140: personal allowance 0', () => expect(tax(125140).personalAllowanceUsed).toBe(0));
  it('marginal band', () => {
    expect(tax(30000).marginalBand).toBe('basic');
    expect(tax(60000).marginalBand).toBe('higher');
    expect(tax(200000).marginalBand).toBe('additional');
  });
});

describe('savings and dividends', () => {
  it('starting rate band applies when non-savings is low', () => {
    // nonSavings 14,570 -> taxable 2,000; starting band 3,000; savings 4,000 -> 3,000 at 0%, PSA 1,000 at 0%
    expect(tax(14570, 4000).savingsTax).toBe(0);
  });
  it('higher-rate PSA is 500', () => {
    // taxable non-savings 47,430 (higher band); savings 1,000 -> 500 PSA, 500 at 40%
    expect(tax(60000, 1000).savingsTax).toBeCloseTo(200, 6);
  });
  it('dividends: allowance uses band space; rates follow the band they fall in', () => {
    // taxable ns 37,000 (700 basic left). Dividends 2,000: 500 allowance (in basic), 200 basic, 1,300 higher
    const r = tax(49570, 0, 2000);
    expect(r.dividendTax).toBeCloseTo(200 * 0.1075 + 1300 * 0.3575, 6);
  });
  it('basic band extension widens the basic rate band', () => {
    const r = calculateIncomeTax({ nonSavings: 60000, savings: 0, dividends: 0 }, cfg, { basicBandExtension: 10000 });
    expect(r.total).toBeCloseTo(47430 * 0.2, 6);
  });
});

describe('NI (hand-checked vectors)', () => {
  it('12,570: 0', () => expect(calculateNI(12570, cfg)).toBe(0));
  it('50,000: 2,994.40', () => expect(calculateNI(50000, cfg)).toBeCloseTo(2994.4, 2));
  it('60,000: 3,210.60', () => expect(calculateNI(60000, cfg)).toBeCloseTo(3210.6, 2));
});

describe('CGT (hand-checked vectors)', () => {
  it('3,000 gain: 0', () => expect(calculateCGT(3000, 50000, cfg)).toBe(0));
  it('10,000 gain, 7,430 other: 1,260', () => expect(calculateCGT(10000, 7430, cfg)).toBeCloseTo(1260, 2));
  it('10,000 gain, 37,700 other: 1,680', () => expect(calculateCGT(10000, 37700, cfg)).toBeCloseTo(1680, 2));
  it('splits a gain across the remaining basic band', () => {
    // 2,000 of basic band left: 2,000 at 18%, 5,000 at 24%
    expect(calculateCGT(10000, 35700, cfg)).toBeCloseTo(2000 * 0.18 + 5000 * 0.24, 6);
  });
});

describe('nothing hardcoded', () => {
  it('changing the personal allowance and basic rate changes the result', () => {
    const c = structuredClone(cfg);
    c.personalAllowance = 15000;
    c.incomeTaxBands[0].rate = 0.25;
    expect(calculateIncomeTax({ nonSavings: 50000, savings: 0, dividends: 0 }, c).total).toBeCloseTo(35000 * 0.25, 6);
    c.ni.mainRate = 0.1;
    expect(calculateNI(50000, c)).toBeCloseTo((50000 - 12570) * 0.1, 6);
  });
});

describe('2027/28 rates on savings and rent (Autumn Budgets 2025 and 2026)', () => {
  const y26 = DEFAULT_CONFIG.tax['2026/27'];
  const y27 = DEFAULT_CONFIG.tax['2027/28'];
  it('rent is taxed like other income in 2026/27', () => {
    const asRent = calculateIncomeTax({ nonSavings: 20_000, savings: 0, dividends: 0, property: 10_000 }, y26).total;
    const asOther = calculateIncomeTax({ nonSavings: 30_000, savings: 0, dividends: 0 }, y26).total;
    expect(asRent).toBeCloseTo(asOther, 6);
  });
  it('rent above other income is taxed at 24% in the basic band from 2027/28', () => {
    // £20k salary uses the personal allowance; £10k rent sits in the basic band at 24%.
    const r = calculateIncomeTax({ nonSavings: 20_000, savings: 0, dividends: 0, property: 10_000 }, y27);
    expect(r.total).toBeCloseTo((20_000 - 12_570) * 0.20 + 10_000 * 0.24, 6);
  });
  it('the personal allowance covers other income before rent', () => {
    // £5k pension and £10k rent: the allowance covers the £5k, then £7,570 of the rent.
    const r = calculateIncomeTax({ nonSavings: 5_000, savings: 0, dividends: 0, property: 10_000 }, y27);
    expect(r.total).toBeCloseTo((15_000 - 12_570) * 0.24, 6);
  });
  it('savings interest above the allowances is taxed at 24% / 44% from 2027/28', () => {
    // £30k salary: £17,430 taxable, so no starting rate; £1,000 PSA; £4,000 interest at 24%.
    const r = calculateIncomeTax({ nonSavings: 30_000, savings: 5_000, dividends: 0 }, y27);
    expect(r.savingsTax).toBeCloseTo(4_000 * 0.24, 6);
  });
});
