import type { Mortgage } from '../model/types';
import { MONTHS_PER_YEAR, MORTGAGE_PAID_TOLERANCE_GBP } from './constants';

import { monthlyPaymentRepayment } from '../model/mortgageMath';
export { monthlyPaymentRepayment };

/** Mortgage state carried between simulated years. All money nominal GBP. */
export interface MortgageState {
  mortgage: Mortgage;       // static terms (rates, type, overpayment, original term/fixed period)
  balance: number;
  monthsElapsed: number;    // months since the simulation start
  payment: number;          // current contractual monthly payment (repayment type)
  paymentRate: number;      // rate the payment was last computed at; NaN forces recompute
}

export interface MortgageYear {
  payments: number;         // total paid this year (contractual + overpayments), excluding lump sum
  interest: number;
  capital: number;          // contractual capital repaid
  overpayments: number;
  lumpSumDue: number;       // balance left at the end of the term, due as a one-off outgoing
  endBalance: number;
  endState: MortgageState;
}

/** Initial state for a mortgage at the simulation start. */
export function initialMortgageState(mortgage: Mortgage): MortgageState {
  return { mortgage, balance: mortgage.balance, monthsElapsed: 0, payment: 0, paymentRate: Number.NaN };
}

/** Annual rate in force in month `m` counted from now. */
export function rateAtMonth(mortgage: Mortgage, m: number): number {
  return m < mortgage.fixedYearsRemaining * MONTHS_PER_YEAR ? mortgage.rate : mortgage.reversionRate;
}

/** Simulate 12 months of a mortgage. See scheduleMonths. */
export function scheduleYear(state: MortgageState): MortgageYear {
  return scheduleMonths(state, MONTHS_PER_YEAR);
}

/**
 * Simulate `months` months of a mortgage (12 for annual steps, 1 for monthly steps).
 * Repayment: the payment is recomputed from the current balance, rate and remaining
 * months at the start and whenever the rate changes; each month pays payment +
 * overpayment, capped at balance + interest. Interest-only: pays interest; overpayments
 * reduce capital. If the term ends with a balance, it is reported as `lumpSumDue` in the
 * year the term ends and the balance is cleared (the caller treats it as an outgoing).
 */
export function scheduleMonths(state: MortgageState, months: number): MortgageYear {
  const mort = state.mortgage;
  const termMonths = Math.round(mort.termYearsRemaining * MONTHS_PER_YEAR);
  let { balance, payment, paymentRate } = state;
  let interestSum = 0;
  let capitalSum = 0;
  let overSum = 0;
  let lumpSumDue = 0;
  let m = state.monthsElapsed;

  for (let k = 0; k < months; k++, m++) {
    if (balance <= MORTGAGE_PAID_TOLERANCE_GBP) { balance = 0; break; }
    const remaining = termMonths - m;
    if (remaining <= 0) { lumpSumDue = balance; balance = 0; break; }
    const rate = rateAtMonth(mort, m);
    const r = rate / MONTHS_PER_YEAR;
    const interest = balance * r;
    if (mort.type === 'repayment') {
      if (rate !== paymentRate) {
        payment = monthlyPaymentRepayment(balance, rate, remaining);
        paymentRate = rate;
      }
      const contractual = Math.min(payment, balance + interest);
      const capital = contractual - interest;
      const over = Math.min(mort.monthlyOverpayment, Math.max(0, balance - capital));
      balance -= capital + over;
      interestSum += interest; capitalSum += capital; overSum += over;
    } else {
      const over = Math.min(mort.monthlyOverpayment, balance);
      balance -= over;
      interestSum += interest; overSum += over;
    }
    if (balance <= MORTGAGE_PAID_TOLERANCE_GBP) { balance = 0; break; }
    if (m + 1 >= termMonths && balance > MORTGAGE_PAID_TOLERANCE_GBP) {
      lumpSumDue = balance; balance = 0; break;
    }
  }
  const endState: MortgageState = { mortgage: mort, balance, monthsElapsed: state.monthsElapsed + months, payment, paymentRate };
  return {
    payments: interestSum + capitalSum + overSum,
    interest: interestSum,
    capital: capitalSum,
    overpayments: overSum,
    lumpSumDue,
    endBalance: balance,
    endState,
  };
}
