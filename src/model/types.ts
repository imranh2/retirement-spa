// Domain types. Percentages are fractions (0.2 = 20%); money is GBP.
export type AccountType = 'cash' | 'gia' | 'isa' | 'lisa' | 'dcPension' | 'premiumBonds';

export interface AssetAllocation {   // must sum to 1 (validate, tolerance 0.0001)
  equities: number;
  bonds: number;
  cash: number;
  property: number;                  // property funds / REITs. Physical property is modelled separately.
}

export interface Account {
  id: string;
  type: AccountType;
  name: string;
  ownerIndex: number;                // index into Scenario.people (tax is per person)
  balance: number;
  allocation: AssetAllocation;
  annualFeePct: number;              // e.g. 0.004
  annualFeeFixed?: number;           // flat platform fee, £ a year in today's money (rises with inflation)
  prizeRate?: number;                // Premium Bonds only: expected yearly prize rate (nominal); blank = market.premiumBondsPrizeRate
  giaCostBasis?: number;             // GIA only; defaults to balance. Used for CGT
  pensionAccessAge?: number;         // DC only; default from config.pensionAccess + DOB
  taxFreeCashTaken?: number;         // DC only; counts against the Lump Sum Allowance
  pensionReliefMethod?: 'netPay' | 'reliefAtSource';   // DC only; default 'netPay'
}

export interface Person {
  name: string;
  dateOfBirth: string;               // ISO yyyy-mm-dd
  salary: number;                    // gross annual, today's money
  salaryGrowthRealPct: number;       // above inflation
  retirementAge: number;             // employment income stops at this age
  niQualifyingYears: number;         // current qualifying years for State Pension
  statePensionStartAge?: number;     // override; default from DOB via config
  mpaaTriggered?: boolean;           // already triggered the MPAA
  niCreditsUntilAge?: number;        // added: future years before this age qualify without earnings (NI credits or voluntary NI)
}

export interface Contribution {
  id: string;
  accountId: string;
  personIndex: number;
  type: 'fixedMonthly' | 'pctOfSalary' | 'employerPctOfSalary' | 'lumpSum';
  amount: number;                    // GBP, or fraction of salary for pct types
  startAge: number;                  // inclusive; ages are the person's age
  endAge: number;                    // exclusive
  escalatesWithInflation: boolean;
  /**
   * When payments stop. 'work': when the payer stops work (endAge is ignored).
   * 'age' (default): at endAge, or when the payer stops work if sooner.
   * 'ageEvenAfterWork': at endAge, carrying on after work stops (paid from savings).
   */
  stopsWith?: 'work' | 'age' | 'ageEvenAfterWork';
  /**
   * Lump sums only. 'pay' (default): paid from take-home pay, or drawn from accounts if pay
   * does not cover it. 'external': money from outside the plan (gift, inheritance, ...), so it
   * reduces no income or account. Allowances and caps still apply.
   */
  source?: 'pay' | 'external';
}
// Meaning for pension accounts: `amount` is the GROSS amount reaching the pot (including tax relief).
// For ISA/LISA/GIA/cash: `amount` is the post-tax amount paid in (for LISA the 25% bonus is added on top).
// 'employerPctOfSalary' is paid by the employer, does not reduce take-home pay, only valid for dcPension.

export interface Mortgage {
  balance: number;                   // nominal GBP today
  type: 'repayment' | 'interestOnly';
  rate: number;                      // initial fixed rate, nominal, e.g. 0.045
  fixedYearsRemaining: number;
  reversionRate: number;             // rate after the fixed period
  termYearsRemaining: number;
  monthlyOverpayment: number;        // nominal GBP per month, not inflated
}

export interface Property {
  id: string;
  name: string;
  value: number;
  growthRealPct: number;             // replaces market.property.meanReal for this property (vol/correlation unchanged)
  isMainResidence: boolean;
  mortgage?: Mortgage;
  rentalIncomeAnnual?: number;       // today's money; rented out; taxable non-savings income, split equally between people
  runningCostsAnnual: number;        // today's money
  runningCostsPctOfValue?: number;   // extra yearly cost as a fraction of the home's current value
  downsize?: { atAge: number; newValue: number; releaseToAccountId: string }; // main residence only (v1)
}

export interface IncomeStream {      // DB pension, part-time work, annuity ...
  id: string;
  name: string;
  annualAmount: number;              // today's money
  startAge: number;
  endAge?: number;
  inflationLinked: boolean;
  taxable: boolean;
  personIndex: number;
}

export interface SpendingPhase {     // household living costs, ALL ages from now (working and retired)
  fromAge: number;                   // person 0's age
  annualSpend: number;               // today's money; excludes mortgage payments and property running costs
}

export type WithdrawalStrategy =
  | { kind: 'fixedReal' }
  | { kind: 'percentOfPortfolio'; pct: number }
  | { kind: 'guardrails'; initialPct: number; upperGuard: number; lowerGuard: number; adjust: number }
  | { kind: 'floorCeiling'; floor: number; ceiling: number; pct: number };   // floor/ceiling in today's money

export interface SimSettings {
  runs: number;                      // default 5000
  seed: number;
  horizonAge: number;                // person 0's age at which the simulation ends, default 95
  startDate: string;                 // ISO date; the simulation starts in this date's tax year
  stepsPerYear: 1 | 12;              // v1 engine supports 1 only; 12 throws "not implemented" until Phase 13
  returnModel: 'lognormal' | 'historicalBlockBootstrap';
  targetSuccessRate: number;         // default 0.9, used by the max-sustainable-spend search
}

/**
 * What happens to income left over after spending, tax, mortgage and contributions:
 * kept in the first cash account (default), invested in a cash account, GIA or ISA
 * (ISA within the owner's remaining allowance; the rest goes to their GIA, else cash),
 * or treated as spent.
 */
export type SurplusRule = { kind: 'cash' } | { kind: 'invest'; accountId: string } | { kind: 'spend' };

export interface Scenario {
  people: Person[];                  // 1 or 2; person 0 is the "primary" whose age is the simulation clock
  accounts: Account[];               // validation: at least one 'cash' account must exist
  contributions: Contribution[];
  properties: Property[];
  incomeStreams: IncomeStream[];
  spending: SpendingPhase[];         // sorted by fromAge; first phase must start at or before person 0's current age
  strategy: WithdrawalStrategy;
  withdrawalOrder: AccountType[];    // e.g. ['cash','gia','isa','lisa','dcPension']
  surplus?: SurplusRule;             // default { kind: 'cash' }
  sim: SimSettings;
}

export interface PercentileBands {
  p5: number[]; p10: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[]; p95: number[];
}

export interface CentralCaseRow {
  age: number; taxYear: string;
  salary: number; statePension: number; otherIncome: number; rentalIncome: number;
  drawCash: number; drawGia: number; drawIsa: number; drawLisa: number; drawPension: number;
  drawPremiumBonds?: number;
  spending: number; mortgagePayments: number; propertyCosts: number;
  mortgageInterest?: number;         // the interest part of mortgagePayments
  taxPaid: number; niPaid: number;
  savedFromPay?: number;             // contributions paid from take-home pay (ISA, GIA, cash, personal pension)
  spareIncome?: number;              // income left over after everything; where it goes depends on Scenario.surplus
  portfolioEnd: number; propertyEquityEnd: number; mortgageBalanceEnd: number;
}

export interface SimulationResult {
  ages: number[];                    // person 0's age at start of each simulated year
  runs: number;
  successRate: number;               // fraction of runs with no shortfall before horizon
  depletionAgeHistogram: { age: number; count: number }[];   // failed runs only
  portfolioReal: PercentileBands;    // all account balances, year end, today's money
  portfolioNominal: PercentileBands;
  netWorthReal: PercentileBands;     // portfolio + property equity
  netWorthNominal?: PercentileBands; // lets the Real/Nominal toggle apply to net worth
  taxPaidTotal: { median: number; p10: number; p90: number };       // lifetime, real
  taxPaidByAgeMeanReal: number[];
  /** Added: share of runs that met spending in full in each year; the per-age means below average over these runs. */
  fundedShareByAge?: number[];
  incomeBySourceMeanReal: Record<'salary' | 'statePension' | 'otherIncome' | 'rental' | 'cash' | 'gia' | 'isa' | 'lisa' | 'premiumBonds' | 'dcPension', number[]>;
  centralCase: CentralCaseRow[];     // deterministic: mean assumptions, zero volatility
  maxSustainable?: { multiplier: number; annualSpendReal: number; targetSuccessRate: number };
  warnings: string[];                // e.g. "Pension contributions capped by annual allowance in 12% of runs"
  meta: { seed: number; durationMs: number; defaultsVersion: string };
}
