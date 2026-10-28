import type { Account, Person } from '../model/types';
import type { PensionAccessConfig, TaxYearConfig } from '../config/configTypes';
import { minimumPensionAccessAge } from '../model/ageRules';
import { calculateIncomeTax, type TaxableIncome } from './tax';

export { minimumPensionAccessAge };

/** Access age for a DC account: its own override if set, else the minimum age for the owner. */
export function accessAgeForAccount(account: Account, owner: Person, access: PensionAccessConfig): number {
  return account.pensionAccessAge ?? minimumPensionAccessAge(owner.dateOfBirth, access);
}

/**
 * Can this account be drawn from at the owner's `age`?
 * dcPension: age >= access age. lisa: age >= lisa.penaltyFreeAge. Others: always.
 */
export function isAccessible(account: Account, age: number, pensionAccessAge: number, cfg: TaxYearConfig): boolean {
  if (account.type === 'dcPension') return age >= pensionAccessAge;
  if (account.type === 'lisa') return age >= cfg.lisa.penaltyFreeAge;
  return true;
}

/**
 * Split a gross UFPLS-style withdrawal: tax-free = min(gross * taxFreeFraction, lsaRemaining).
 * `lsaRemaining` is never treated as below zero.
 */
export function splitPensionWithdrawal(gross: number, lsaRemaining: number, cfg: TaxYearConfig): { taxFree: number; taxable: number } {
  const taxFree = Math.min(Math.max(0, gross) * cfg.pension.taxFreeFraction, Math.max(0, lsaRemaining));
  return { taxFree, taxable: Math.max(0, gross) - taxFree };
}

/** Lump Sum Allowance left after `taxFreeCashTaken` (never below 0). */
export function lsaRemaining(taxFreeCashTaken: number, cfg: TaxYearConfig): number {
  return Math.max(0, cfg.pension.lumpSumAllowance - taxFreeCashTaken);
}

/**
 * Net pay arrangement: the gross employee contribution is deducted from taxable pay.
 * Inputs: gross contribution, the person's taxable income before the deduction.
 * Output: take-home cost (contribution - income tax saved) and the tax saved. NI is unaffected.
 */
export function pensionContributionCostNetPay(contribution: number, incomeBefore: TaxableIncome, cfg: TaxYearConfig): { outlay: number; taxSaved: number } {
  const before = calculateIncomeTax(incomeBefore, cfg).total;
  const after = calculateIncomeTax({ ...incomeBefore, nonSavings: Math.max(0, incomeBefore.nonSavings - contribution) }, cfg).total;
  const taxSaved = before - after;
  return { outlay: contribution - taxSaved, taxSaved };
}

/**
 * Relief at source: you pay contribution * (1 - reliefAtSourceRate) from take-home pay;
 * the provider adds the rest. Higher-rate relief arrives by extending the basic band by
 * the gross contribution (pass `basicBandExtension` to calculateIncomeTax).
 */
export function pensionContributionCostReliefAtSource(contribution: number, cfg: TaxYearConfig): { outlay: number; basicBandExtension: number } {
  return { outlay: contribution * (1 - cfg.pension.reliefAtSourceRate), basicBandExtension: contribution };
}

/**
 * Tapered annual allowance. Applies only when threshold income (income minus personal pension
 * contributions) is above taperThresholdIncome AND adjusted income (income plus employer
 * contributions) is above taperAdjustedIncome: the allowance falls by taperRate per £1 over
 * the adjusted-income limit, but never below taperMinimumAllowance.
 */
export function taperedAnnualAllowance(thresholdIncome: number, adjustedIncome: number, cfg: TaxYearConfig): number {
  const p = cfg.pension;
  if (thresholdIncome <= p.taperThresholdIncome || adjustedIncome <= p.taperAdjustedIncome) return p.annualAllowance;
  return Math.max(Math.min(p.taperMinimumAllowance, p.annualAllowance), p.annualAllowance - (adjustedIncome - p.taperAdjustedIncome) * p.taperRate);
}

/** The annual allowance in force: MPAA once triggered (or a lower tapered allowance), otherwise the (tapered) allowance. */
export function pensionAllowance(mpaaTriggered: boolean, cfg: TaxYearConfig, annualAllowance: number = cfg.pension.annualAllowance): number {
  return mpaaTriggered ? Math.min(cfg.pension.mpaa, annualAllowance) : annualAllowance;
}

/**
 * Personal (employee) contributions that get tax relief, given gross earnings.
 * Net pay contributions come out of pay, so they are limited to earnings. Relief-at-source
 * contributions may use the higher of earnings and the basic amount (£3,600 gross), so
 * someone with no earnings can still pay in, less whatever net pay has used.
 */
export function personalContributionLimit(netPay: number, reliefAtSource: number, grossEarnings: number, cfg: TaxYearConfig): { netPay: number; reliefAtSource: number } {
  const earnings = Math.max(0, grossEarnings);
  const np = Math.min(netPay, earnings);
  const rasLimit = Math.max(earnings, reliefAtSource > 0 ? cfg.pension.basicAmount : 0) - np;
  return { netPay: np, reliefAtSource: Math.min(reliefAtSource, Math.max(0, rasLimit)) };
}

export interface PensionCapResult {
  employeeScale: number;      // multiply each employee contribution by this
  employerScale: number;      // multiply each employer contribution by this
  capped: boolean;            // true if anything was reduced
}

/**
 * Cap one person's gross pension contributions for the year.
 * Personal (employee) contributions are first capped at 100% of gross earnings,
 * then the total (employee + employer) is capped at `allowance`, reducing employee
 * contributions before employer ones. Excess contributions are simply not made.
 */
export function capPensionContributions(employeeGross: number, employerGross: number, grossEarnings: number, allowance: number): PensionCapResult {
  let employee = Math.min(employeeGross, Math.max(0, grossEarnings));
  let employer = employerGross;
  const total = employee + employer;
  if (total > allowance) {
    const excess = total - allowance;
    const cutEmployee = Math.min(employee, excess);
    employee -= cutEmployee;
    employer -= Math.min(employer, excess - cutEmployee);
  }
  const tol = 1e-9;
  return {
    employeeScale: employeeGross > 0 ? employee / employeeGross : 1,
    employerScale: employerGross > 0 ? employer / employerGross : 1,
    capped: employee < employeeGross - tol || employer < employerGross - tol,
  };
}
