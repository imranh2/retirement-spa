import type { Mortgage } from './types';

const MONTHS_PER_YEAR = 12;

/** Standard annuity payment per month. r = annualRate / 12; if r == 0, balance / months. */
export function monthlyPaymentRepayment(balance: number, annualRate: number, months: number): number {
  if (months <= 0) return balance;
  const r = annualRate / MONTHS_PER_YEAR;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
}

/**
 * Contractual monthly payment now and after the fixed rate ends (`afterFix` is undefined
 * when the fix lasts the whole term or there is nothing left to pay). Matches the engine:
 * a repayment mortgage's payment is recalculated from the balance and months left when the
 * rate changes; overpayments reduce the balance. Interest-only pays interest on the balance.
 */
export function mortgagePayments(m: Mortgage): { now: number; afterFix?: number } {
  const term = Math.round(m.termYearsRemaining * MONTHS_PER_YEAR);
  const fixed = Math.min(term, Math.round(m.fixedYearsRemaining * MONTHS_PER_YEAR));
  if (m.balance <= 0 || term <= 0) return { now: 0 };
  if (m.type === 'interestOnly') {
    const now = (m.balance * m.rate) / MONTHS_PER_YEAR;
    if (fixed >= term) return { now };
    // Overpayments repay capital during the fix.
    const left = Math.max(0, m.balance - m.monthlyOverpayment * fixed);
    return { now, afterFix: (left * m.reversionRate) / MONTHS_PER_YEAR };
  }
  const now = monthlyPaymentRepayment(m.balance, fixed > 0 ? m.rate : m.reversionRate, term);
  if (fixed <= 0 || fixed >= term) return { now };
  let balance = m.balance;
  const r = m.rate / MONTHS_PER_YEAR;
  for (let k = 0; k < fixed && balance > 0; k++) balance = Math.max(0, balance * (1 + r) - now - m.monthlyOverpayment);
  return balance > 0 ? { now, afterFix: monthlyPaymentRepayment(balance, m.reversionRate, term - fixed) } : { now };
}
