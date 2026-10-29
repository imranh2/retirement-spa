import type { ConfigBundle } from './configTypes';
import { expandFields } from './configFields';
import { getPath } from './paths';
import { choleskyDecompose } from '../engine/prng';
import { isIsoDate, isTaxYearLabel } from '../model/dates';

export interface ValidationIssue {
  path: string;
  message: string;
  severity?: 'error' | 'warning';     // default 'error'. Warnings never block a run.
}

const MATRIX_SIZE = 5;
/** 'date' fields holding a tax-year label rather than a calendar date. */
const TAX_YEAR_FIELD = /(?:^|\.)(?:taxYear|baseTaxYear|thresholdsFrozenThroughTaxYear|doubleLockFromTaxYear)$/;
/** Regions the engine implements; other registry options are placeholders. */
const IMPLEMENTED_REGIONS = ['england-wales-ni'];

/** Only issues that block a simulation run. */
export function blockingIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity !== 'warning');
}

/**
 * Validate a config bundle. Uses the registry's min/max for every field, then
 * structural rules: bands ascending with a null top, schedule sorted, and a
 * 5x5 symmetric correlation matrix with unit diagonal (PSD failure is a warning).
 * Inputs: config. Output: list of {path, message}; empty means valid.
 */
export function validateConfig(config: ConfigBundle): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of expandFields(config)) {
    // Read-only fields are still checked: imported or stored configs can hold anything.
    const v = getPath(config, field.path);
    if (v === undefined) continue;
    if (field.path === 'defaultsVersion') continue;
    if (field.unit === 'date') {
      const taxYear = TAX_YEAR_FIELD.test(field.path);
      const ok = typeof v === 'string' && (taxYear ? isTaxYearLabel(v) : isIsoDate(v));
      if (!ok) issues.push({ path: field.path, message: taxYear ? 'Enter a tax year such as 2026/27' : 'Enter a real date as yyyy-mm-dd' });
      continue;
    }
    if (field.path.endsWith('.region') && !IMPLEMENTED_REGIONS.includes(String(v))) {
      issues.push({ path: field.path, message: 'Only England, Wales and Northern Ireland tax is modelled in this version' });
      continue;
    }
    if (field.unit === 'enum') {
      const values = Array.isArray(v) ? v : [v];
      if (field.options && values.some((x) => typeof x !== 'string' || !field.options?.includes(x))) {
        issues.push({ path: field.path, message: `Must be one of: ${field.options.join(', ')}` });
      }
      continue;
    }
    if (v === null && field.nullable) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ path: field.path, message: 'Must be a number' });
      continue;
    }
    if (field.min !== undefined && v < field.min) issues.push({ path: field.path, message: `Must be at least ${field.min}` });
    if (field.max !== undefined && v > field.max) issues.push({ path: field.path, message: `Must be at most ${field.max}` });
  }

  const years = Object.keys(config.tax);
  if (years.length === 0) issues.push({ path: 'tax', message: 'At least one tax year is required' });
  for (const year of years) {
    const cfg = config.tax[year];
    const prefix = `tax.${year}`;
    if (!isTaxYearLabel(year)) issues.push({ path: prefix, message: 'Tax year key must look like 2026/27' });
    const bands = cfg.incomeTaxBands;
    if (bands.length === 0) issues.push({ path: `${prefix}.incomeTaxBands`, message: 'At least one band is required' });
    let prev = -Infinity;
    bands.forEach((band, i) => {
      if (band.rate < 0 || band.rate > 1) {
        issues.push({ path: `${prefix}.incomeTaxBands[${i}].rate`, message: 'Rate must be between 0% and 100%' });
      }
      const isLast = i === bands.length - 1;
      if (isLast && band.upTo !== null) {
        issues.push({ path: `${prefix}.incomeTaxBands[${i}].upTo`, message: 'The last band must have no upper limit' });
      }
      if (!isLast && band.upTo === null) {
        issues.push({ path: `${prefix}.incomeTaxBands[${i}].upTo`, message: 'Only the last band can have no upper limit' });
      }
      if (band.upTo !== null) {
        if (band.upTo <= prev) issues.push({ path: `${prefix}.incomeTaxBands[${i}].upTo`, message: 'Bands must be in ascending order' });
        prev = band.upTo;
      }
    });
    if (cfg.ni.upperEarningsLimit < cfg.ni.primaryThreshold) {
      issues.push({ path: `${prefix}.ni.upperEarningsLimit`, message: 'Must be at least the primary threshold' });
    }
  }

  const schedule = config.statePension.ageSchedule;
  if (schedule.length === 0) issues.push({ path: 'statePension.ageSchedule', message: 'At least one row is required' });
  for (let i = 1; i < schedule.length; i++) {
    if (schedule[i].bornOnOrAfter <= schedule[i - 1].bornOnOrAfter) {
      issues.push({ path: `statePension.ageSchedule[${i}].bornOnOrAfter`, message: 'Rows must be sorted by date, oldest first' });
    }
  }
  if (config.statePension.minimumYears > config.statePension.yearsForFull) {
    issues.push({ path: 'statePension.minimumYears', message: 'Cannot exceed the years needed for a full pension' });
  }

  issues.push(...validateCorrelations(config.market.correlations));

  const hist = config.historicalReturns;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].year !== hist[i - 1].year + 1) {
      issues.push({ path: `historicalReturns[${i}].year`, message: 'Years must be consecutive and ascending', severity: 'warning' });
      break;
    }
  }

  return issues;
}

/** Check the correlation matrix shape, symmetry, diagonal, range and positive semi-definiteness. */
export function validateCorrelations(m: number[][]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (m.length !== MATRIX_SIZE || m.some((row) => row.length !== MATRIX_SIZE)) {
    return [{ path: 'market.correlations', message: 'Correlation matrix must be 5x5' }];
  }
  for (let i = 0; i < MATRIX_SIZE; i++) {
    for (let j = 0; j < MATRIX_SIZE; j++) {
      const v = m[i][j];
      const p = `market.correlations[${i}][${j}]`;
      if (!Number.isFinite(v) || v < -1 || v > 1) issues.push({ path: p, message: 'Correlation must be between -1 and 1' });
      if (i === j && v !== 1) issues.push({ path: p, message: 'Diagonal must be 1' });
      if (j > i && m[j][i] !== v) issues.push({ path: p, message: 'Matrix must be symmetric' });
    }
  }
  if (issues.length === 0) {
    try {
      choleskyDecompose(m);
    } catch {
      issues.push({ path: 'market.correlations', message: 'Matrix is not positive semi-definite; correlated sampling will fail. Reduce the off-diagonal values.', severity: 'warning' });
    }
  }
  return issues;
}

/** Check each account allocation sums to 1 (tolerance 0.0001). */
export function validateAllocations(accounts: { allocation: { equities: number; bonds: number; cash: number; property: number } }[], prefix = 'accounts'): ValidationIssue[] {
  const ALLOCATION_TOLERANCE = 0.0001;
  const issues: ValidationIssue[] = [];
  accounts.forEach((acc, idx) => {
    const a = acc.allocation;
    const sum = a.equities + a.bonds + a.cash + a.property;
    if (Math.abs(sum - 1) > ALLOCATION_TOLERANCE) {
      issues.push({ path: `${prefix}[${idx}].allocation`, message: `Allocation must add up to 100% (currently ${(sum * 100).toFixed(1)}%)` });
    }
    if ([a.equities, a.bonds, a.cash, a.property].some((x) => x < 0)) {
      issues.push({ path: `${prefix}[${idx}].allocation`, message: 'Allocation shares cannot be negative' });
    }
  });
  return issues;
}
