import type { ConfigBundle } from '../../src/config/configTypes';

/**
 * FROZEN hand-typed copy of the 2026/27 values.
 * Engine tests import this, never src/defaults, so edits to the shipped defaults
 * cannot silently change what the tests check.
 */
export const TEST_CONFIG: ConfigBundle = {
  defaultsVersion: '2026-10-27',
  tax: {
    '2026/27': {
      taxYear: '2026/27',
      region: 'england-wales-ni',
      personalAllowance: 12570,
      taperThreshold: 100000,
      taperRatePerPound: 0.5,
      incomeTaxBands: [
        { upTo: 37700, rate: 0.2 },
        { upTo: 125140, rate: 0.4 },
        { upTo: null, rate: 0.45 },
      ],
      savings: { startingRateBand: 5000, startingRate: 0, psaBasic: 1000, psaHigher: 500, psaAdditional: 0, basicRate: 0.2, higherRate: 0.4, additionalRate: 0.45 },
      dividends: { allowance: 500, basicRate: 0.1075, higherRate: 0.3575, additionalRate: 0.3935 },
      ni: { primaryThreshold: 12570, upperEarningsLimit: 50270, mainRate: 0.08, upperRate: 0.02, lowerEarningsLimit: 6708 },
      cgt: { annualExempt: 3000, basicRate: 0.18, higherRate: 0.24 },
      isa: { annualAllowance: 20000 },
      lisa: { annualAllowance: 4000, bonusRate: 0.25, minAge: 18, maxOpenAge: 39, maxContributionAge: 50, penaltyFreeAge: 60 },
      pension: { annualAllowance: 60000, mpaa: 10000, taxFreeFraction: 0.25, lumpSumAllowance: 268275, reliefAtSourceRate: 0.2,
        basicAmount: 3600, taperThresholdIncome: 200000, taperAdjustedIncome: 260000, taperRate: 0.5, taperMinimumAllowance: 10000 },
    },
  },
  taxProjection: {
    thresholdsFrozenThroughTaxYear: '2030/31',
    upratingAfterFreeze: 'inflation',
    upratedItems: ['personalAllowance', 'incomeTaxBands', 'niThresholds'],
  },
  pensionAccess: { minAgeNow: 55, minAgeFuture: 57, minAgeFutureFromDate: '2028-04-06' },
  statePension: {
    fullWeeklyRate: 241.3,
    baseTaxYear: '2026/27',
    yearsForFull: 35,
    minimumYears: 10,
    growth: 'tripleLock',
    tripleLockFloorPct: 0.025,
    fixedGrowthPct: 0.025,
    deferralIncreasePerYear: 0.0578,
    ageSchedule: [
      { bornOnOrAfter: '1900-01-01', ageYears: 66, ageMonths: 0 },
      { bornOnOrAfter: '1960-04-06', ageYears: 66, ageMonths: 1 },
      { bornOnOrAfter: '1960-05-06', ageYears: 66, ageMonths: 2 },
      { bornOnOrAfter: '1960-06-06', ageYears: 66, ageMonths: 3 },
      { bornOnOrAfter: '1960-07-06', ageYears: 66, ageMonths: 4 },
      { bornOnOrAfter: '1960-08-06', ageYears: 66, ageMonths: 5 },
      { bornOnOrAfter: '1960-09-06', ageYears: 66, ageMonths: 6 },
      { bornOnOrAfter: '1960-10-06', ageYears: 66, ageMonths: 7 },
      { bornOnOrAfter: '1960-11-06', ageYears: 66, ageMonths: 8 },
      { bornOnOrAfter: '1960-12-06', ageYears: 66, ageMonths: 9 },
      { bornOnOrAfter: '1961-01-06', ageYears: 66, ageMonths: 10 },
      { bornOnOrAfter: '1961-02-06', ageYears: 66, ageMonths: 11 },
      { bornOnOrAfter: '1961-03-06', ageYears: 67, ageMonths: 0 },
      { bornOnOrAfter: '1977-04-06', ageYears: 67, ageMonths: 0 },
      { bornOnOrAfter: '1978-04-06', ageYears: 68, ageMonths: 0 },
    ],
  },
  market: {
    equities: { meanReal: 0.05, vol: 0.16 },
    bonds: { meanReal: 0.015, vol: 0.06 },
    cash: { meanReal: 0.005, vol: 0.01 },
    property: { meanReal: 0.02, vol: 0.12 },
    inflation: { mean: 0.025, vol: 0.015, floor: -0.02 },
    correlations: [
      [1.0, 0.1, 0.0, 0.5, -0.1],
      [0.1, 1.0, 0.2, 0.2, -0.4],
      [0.0, 0.2, 1.0, 0.0, -0.4],
      [0.5, 0.2, 0.0, 1.0, 0.2],
      [-0.1, -0.4, -0.4, 0.2, 1.0],
    ],
    defaultAnnualFeePct: { cash: 0, gia: 0.003, isa: 0.003, lisa: 0.003, dcPension: 0.004 },
    equityDividendYield: 0.02,
    wageGrowthRealPct: 0.01,
  },
  historicalReturns: [],
};

/** A copy of the fixture with no volatility, no inflation, zero returns and no income tax. */
export function zeroWorldConfig(): ConfigBundle {
  const c = structuredClone(TEST_CONFIG);
  for (const k of ['equities', 'bonds', 'cash', 'property'] as const) c.market[k] = { meanReal: 0, vol: 0 };
  c.market.inflation = { mean: 0, vol: 0, floor: -0.02 };
  c.market.equityDividendYield = 0;
  c.market.wageGrowthRealPct = 0;
  const y = c.tax['2026/27'];
  y.incomeTaxBands = y.incomeTaxBands.map((b) => ({ ...b, rate: 0 }));
  y.ni.mainRate = 0; y.ni.upperRate = 0;
  y.cgt.basicRate = 0; y.cgt.higherRate = 0;
  y.dividends = { ...y.dividends, basicRate: 0, higherRate: 0, additionalRate: 0 };
  c.statePension.growth = 'fixed';
  c.statePension.fixedGrowthPct = 0;
  return c;
}
