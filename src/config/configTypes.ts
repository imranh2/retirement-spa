/** Income tax band. `upTo` is the top of the band in TAXABLE income; null = no limit. */
export interface Band { upTo: number | null; rate: number }

export interface TaxYearConfig {
  taxYear: string;                                     // '2026/27'
  region: 'england-wales-ni' | 'scotland';             // only the first is implemented
  personalAllowance: number;
  taperThreshold: number;                              // adjusted net income above which PA is reduced
  taperRatePerPound: number;                           // 0.5 = reduce PA by £1 per £2
  incomeTaxBands: Band[];                              // ascending; last upTo is null
  savings: { startingRateBand: number; startingRate: number;
             psaBasic: number; psaHigher: number; psaAdditional: number;
             basicRate: number; higherRate: number; additionalRate: number };   // rates on savings interest by band
  dividends: { allowance: number; basicRate: number; higherRate: number; additionalRate: number };
  propertyIncome: { basicRate: number; higherRate: number; additionalRate: number };   // rates on rent, by band
  ni: { primaryThreshold: number; upperEarningsLimit: number; mainRate: number; upperRate: number;
        lowerEarningsLimit: number };                  // earnings at or above this make the year count for the State Pension
  cgt: { annualExempt: number; basicRate: number; higherRate: number };
  isa: { annualAllowance: number; cashIsaSubLimit?: number };
  premiumBonds: { holdingLimit: number };              // most one person can hold, in pounds (not uprated)
  lisa: { annualAllowance: number; bonusRate: number; minAge: number; maxOpenAge: number;
          maxContributionAge: number; penaltyFreeAge: number };
  pension: { annualAllowance: number; mpaa: number; taxFreeFraction: number;
             lumpSumAllowance: number; reliefAtSourceRate: number;
             basicAmount: number;                    // relief-at-source personal limit with low or no earnings (gross)
             taperThresholdIncome: number;           // taper applies only if threshold income is above this...
             taperAdjustedIncome: number;            // ...and adjusted income is above this
             taperRate: number;                      // 0.5 = £1 off the allowance per £2 of adjusted income over
             taperMinimumAllowance: number };        // the tapered allowance never falls below this
}

/** Arithmetic mean REAL return and annual volatility, as fractions. */
export interface AssetClassAssumption { meanReal: number; vol: number }

export interface MarketAssumptions {
  equities: AssetClassAssumption;
  bonds: AssetClassAssumption;
  cash: AssetClassAssumption;
  property: AssetClassAssumption;
  inflation: { mean: number; vol: number; floor: number };   // annual; draws floored at `floor` (e.g. -0.02)
  correlations: number[][];            // 5x5, order: equities, bonds, cash, property, inflation
  defaultAnnualFeePct: Record<'cash' | 'gia' | 'isa' | 'lisa' | 'dcPension', number>;
  premiumBondsPrizeRate: number;       // default expected yearly prize rate for Premium Bonds (nominal, tax-free)
  equityDividendYield: number;         // used only to estimate taxable dividends in a GIA
  wageGrowthRealPct: number;           // used for triple lock 'earnings' leg
}

export type UpratedItem =
  | 'personalAllowance' | 'incomeTaxBands' | 'niThresholds'
  | 'savingsAndDividendAllowances' | 'cgtExempt' | 'isaAllowance' | 'pensionAllowances';

export const UPRATED_ITEMS: UpratedItem[] = [
  'personalAllowance', 'incomeTaxBands', 'niThresholds',
  'savingsAndDividendAllowances', 'cgtExempt', 'isaAllowance', 'pensionAllowances',
];

export interface HistoricalReturnRow {
  year: number; equities: number; bonds: number; cash: number; property: number; inflation: number;
}

export interface ConfigBundle {
  defaultsVersion: string;             // e.g. '2026-10-27', used for "new defaults available"
  tax: Record<string, TaxYearConfig>;  // keyed by tax year. User can add/remove years
  taxProjection: {                     // behaviour for years after the last defined tax year
    thresholdsFrozenThroughTaxYear: string;   // e.g. '2030/31' (last frozen year). Uprating starts the year after
    upratingAfterFreeze: 'inflation' | 'wageGrowth' | 'none';
    upratedItems: UpratedItem[];       // which items get uprated after the freeze
  };
  pensionAccess: { minAgeNow: number; minAgeFuture: number; minAgeFutureFromDate: string };
  statePension: {
    fullWeeklyRate: number;            // in the base tax year's money
    baseTaxYear: string;
    yearsForFull: number;
    minimumYears: number;
    growth: 'tripleLock' | 'adjustedTripleLock' | 'inflation' | 'earnings' | 'fixed';
    doubleLockFromTaxYear: string;     // adjustedTripleLock: from this tax year the earnings leg is dropped
    tripleLockFloorPct: number;
    fixedGrowthPct: number;
    deferralIncreasePerYear: number;   // extra State Pension per year of deferral, as a fraction of the entitlement
    ageSchedule: { bornOnOrAfter: string; ageYears: number; ageMonths: number }[];  // sorted ascending
  };
  market: MarketAssumptions;
  historicalReturns: HistoricalReturnRow[];  // empty until the user pastes a CSV. Nominal annual decimal returns
}

export type PensionAccessConfig = ConfigBundle['pensionAccess'];
export type StatePensionConfig = ConfigBundle['statePension'];
export type TaxProjectionConfig = ConfigBundle['taxProjection'];

export interface FieldMeta {
  path: string;                        // pattern, e.g. 'tax.{year}.cgt.annualExempt' or 'statePension.fullWeeklyRate'
  label: string;
  unit: 'gbp' | 'pct' | 'age' | 'years' | 'weeks' | 'date' | 'count' | 'enum' | 'bool';
  min?: number; max?: number; step?: number;
  tooltip: string;                     // plain English
  sourceUrl?: string;                  // gov.uk page for the default
  lastVerified?: string;               // ISO date
  group: string;                       // section/tab heading
  options?: string[];                  // enum choices
  readOnly?: boolean;                  // shown but not editable
  multi?: boolean;                     // enum array (multi-select)
  nullable?: boolean;                  // value may be null, e.g. top band upTo
}
