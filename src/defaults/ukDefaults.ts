import type { ConfigBundle } from '../config/configTypes';

/**
 * Seed values for the UK rules and market assumptions.
 * These are the starting point only: every value is editable in the app.
 * The human maintainer verifies each figure against gov.uk before release.
 * To add a new tax year: add an entry under `tax`, then bump `defaultsVersion`.
 */
export const DEFAULT_CONFIG: ConfigBundle = {
  defaultsVersion: '2026-10-28',
  tax: {
    '2026/27': {
      taxYear: '2026/27',
      region: 'england-wales-ni',
      personalAllowance: 12570,                 // verified gov.uk 2026-10-28
      taperThreshold: 100000,                   // verified gov.uk 2026-10-28
      taperRatePerPound: 0.5,                   // verified gov.uk 2026-10-28
      incomeTaxBands: [
        { upTo: 37700, rate: 0.20 },            // verified gov.uk 2026-10-28
        { upTo: 125140, rate: 0.40 },           // verified gov.uk 2026-10-28
        { upTo: null, rate: 0.45 },             // verified gov.uk 2026-10-28
      ],
      savings: {
        startingRateBand: 5000,                 // verified gov.uk 2026-10-28
        startingRate: 0,                        // verified gov.uk 2026-10-28
        psaBasic: 1000,                         // verified gov.uk 2026-10-28
        psaHigher: 500,                         // verified gov.uk 2026-10-28
        psaAdditional: 0,                       // verified gov.uk 2026-10-28
        basicRate: 0.20,                        // verified gov.uk 2026-10-28. From 6 Apr 2027: 22% (Budget 2025), +2pp more announced in Budget 2026
        higherRate: 0.40,                       // verified gov.uk 2026-10-28. From 6 Apr 2027: 42% (Budget 2025), +2pp more announced in Budget 2026
        additionalRate: 0.45,                   // verified gov.uk 2026-10-28. From 6 Apr 2027: 47% (Budget 2025), +2pp more announced in Budget 2026
      },
      dividends: {
        allowance: 500,                         // verified gov.uk 2026-10-28
        basicRate: 0.1075,                      // verified gov.uk 2026-10-28 (raised by 2pp from 6 Apr 2026)
        higherRate: 0.3575,                     // verified gov.uk 2026-10-28 (raised by 2pp from 6 Apr 2026)
        additionalRate: 0.3935,                 // verified gov.uk 2026-10-28
      },
      ni: {
        primaryThreshold: 12570,                // verified gov.uk 2026-10-28
        upperEarningsLimit: 50270,              // verified gov.uk 2026-10-28
        mainRate: 0.08,                         // verified gov.uk 2026-10-28
        upperRate: 0.02,                        // verified gov.uk 2026-10-28
        lowerEarningsLimit: 6708,               // verified gov.uk 2026-10-28 (£129 a week)
      },
      cgt: {
        annualExempt: 3000,                     // verified gov.uk 2026-10-28
        basicRate: 0.18,                        // verified gov.uk 2026-10-28
        higherRate: 0.24,                       // verified gov.uk 2026-10-28
      },
      // The planned £12,000 cash ISA limit from April 2027 was reversed in Budget 2026 (stays £20,000), so no cashIsaSubLimit.
      isa: { annualAllowance: 20000 },          // verified gov.uk 2026-10-28
      lisa: {
        annualAllowance: 4000,                  // verified gov.uk 2026-10-28
        bonusRate: 0.25,                        // verified gov.uk 2026-10-28
        minAge: 18,                             // verified gov.uk 2026-10-28
        maxOpenAge: 39,                         // verified gov.uk 2026-10-28
        maxContributionAge: 50,                 // verified gov.uk 2026-10-28
        penaltyFreeAge: 60,                     // verified gov.uk 2026-10-28
      },
      pension: {
        annualAllowance: 60000,                 // verified gov.uk 2026-10-28
        mpaa: 10000,                            // verified gov.uk 2026-10-28
        taxFreeFraction: 0.25,                  // verified gov.uk 2026-10-28
        lumpSumAllowance: 268275,               // verified gov.uk 2026-10-28
        reliefAtSourceRate: 0.20,               // verified gov.uk 2026-10-28
        basicAmount: 3600,                      // verified gov.uk 2026-10-28
        taperThresholdIncome: 200000,           // verified gov.uk 2026-10-28
        taperAdjustedIncome: 260000,            // verified gov.uk 2026-10-28
        taperRate: 0.5,                         // verified gov.uk 2026-10-28
        taperMinimumAllowance: 10000,           // verified gov.uk 2026-10-28
      },
    },
  },
  taxProjection: {
    thresholdsFrozenThroughTaxYear: '2030/31',  // verified gov.uk 2026-10-28
    upratingAfterFreeze: 'inflation',
    upratedItems: ['personalAllowance', 'incomeTaxBands', 'niThresholds'],
  },
  pensionAccess: {
    minAgeNow: 55,                              // verified gov.uk 2026-10-28
    minAgeFuture: 57,                           // verified gov.uk 2026-10-28
    minAgeFutureFromDate: '2028-04-06',         // verified gov.uk 2026-10-28
  },
  statePension: {
    fullWeeklyRate: 241.30,                     // verified gov.uk 2026-10-28
    baseTaxYear: '2026/27',
    yearsForFull: 35,                           // verified gov.uk 2026-10-28
    minimumYears: 10,                           // verified gov.uk 2026-10-28
    growth: 'tripleLock',
    tripleLockFloorPct: 0.025,                  // verified gov.uk 2026-10-28; Budget 2026 adjusts the triple lock from April 2030
    fixedGrowthPct: 0.025,
    deferralIncreasePerYear: 0.0578,            // verified gov.uk 2026-10-28 (1% for every 9 weeks deferred)
    // verified against the gov.uk State Pension age timetable 2026-10-28 (Tables 4 and 5)
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
      // Pensions Act 2007 phasing: SPA dates 6 May 2044 .. 6 Mar 2046, two months apart per birth month.
      { bornOnOrAfter: '1977-04-06', ageYears: 67, ageMonths: 1 },
      { bornOnOrAfter: '1977-05-06', ageYears: 67, ageMonths: 2 },
      { bornOnOrAfter: '1977-06-06', ageYears: 67, ageMonths: 3 },
      { bornOnOrAfter: '1977-07-06', ageYears: 67, ageMonths: 4 },
      { bornOnOrAfter: '1977-08-06', ageYears: 67, ageMonths: 5 },
      { bornOnOrAfter: '1977-09-06', ageYears: 67, ageMonths: 6 },
      { bornOnOrAfter: '1977-10-06', ageYears: 67, ageMonths: 7 },
      { bornOnOrAfter: '1977-11-06', ageYears: 67, ageMonths: 8 },
      { bornOnOrAfter: '1977-12-06', ageYears: 67, ageMonths: 9 },
      { bornOnOrAfter: '1978-01-06', ageYears: 67, ageMonths: 10 },
      { bornOnOrAfter: '1978-02-06', ageYears: 67, ageMonths: 11 },
      { bornOnOrAfter: '1978-03-06', ageYears: 68, ageMonths: 0 },
      { bornOnOrAfter: '1978-04-06', ageYears: 68, ageMonths: 0 },
    ],
  },
  // Editable assumptions, not predictions.
  market: {
    equities: { meanReal: 0.05, vol: 0.16 },
    bonds: { meanReal: 0.015, vol: 0.06 },
    cash: { meanReal: 0.005, vol: 0.01 },
    property: { meanReal: 0.02, vol: 0.12 },
    inflation: { mean: 0.025, vol: 0.015, floor: -0.02 },
    // Placeholder values. Order: equities, bonds, cash, property, inflation.
    correlations: [
      [1.00, 0.10, 0.00, 0.50, -0.10],
      [0.10, 1.00, 0.20, 0.20, -0.40],
      [0.00, 0.20, 1.00, 0.00, -0.40],
      [0.50, 0.20, 0.00, 1.00, 0.20],
      [-0.10, -0.40, -0.40, 0.20, 1.00],
    ],
    defaultAnnualFeePct: { cash: 0, gia: 0.003, isa: 0.003, lisa: 0.003, dcPension: 0.004 },
    equityDividendYield: 0.02,
    wageGrowthRealPct: 0.01,
  },
  historicalReturns: [],
};
