import type { HistoricalReturnRow } from './configTypes';

export interface CsvLineError { line: number; message: string }
export interface CsvParseResult { rows: HistoricalReturnRow[]; errors: CsvLineError[] }

const COLUMNS = ['year', 'equities', 'bonds', 'cash', 'property', 'inflation'] as const;
const MAX_ABS_RETURN = 5;

/**
 * Parse pasted CSV of historical returns.
 * Format: `year,equities,bonds,cash,property,inflation`, nominal annual decimal returns
 * (0.07 = 7%). A header row is optional; blank lines and lines starting with # are ignored.
 * Returns rows sorted by year plus one error per bad line (1-based line numbers).
 */
export function parseHistoricalCsv(text: string): CsvParseResult {
  const rows: HistoricalReturnRow[] = [];
  const errors: CsvLineError[] = [];
  const seen = new Set<number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const cells = trimmed.split(/[,\t;]/).map((c) => c.trim());
    if (i === 0 && cells[0].toLowerCase() === 'year') return;
    if (cells.length !== COLUMNS.length) {
      errors.push({ line, message: `Expected ${COLUMNS.length} values (${COLUMNS.join(', ')}), found ${cells.length}` });
      return;
    }
    const nums = cells.map((c) => (c === '' ? NaN : Number(c.replace(/%$/, ''))));
    const bad = nums.findIndex((n) => !Number.isFinite(n));
    if (bad >= 0) {
      errors.push({ line, message: `'${cells[bad]}' in column ${COLUMNS[bad]} is not a number` });
      return;
    }
    const [year, equities, bonds, cash, property, inflation] = nums;
    if (!Number.isInteger(year)) {
      errors.push({ line, message: 'Year must be a whole number' });
      return;
    }
    if (seen.has(year)) {
      errors.push({ line, message: `Year ${year} appears more than once` });
      return;
    }
    if (cells.some((c) => c.endsWith('%')) || [equities, bonds, cash, property, inflation].some((v) => Math.abs(v) > MAX_ABS_RETURN)) {
      errors.push({ line, message: 'Values must be decimal fractions (0.07 for 7%), not percentages' });
      return;
    }
    seen.add(year);
    rows.push({ year, equities, bonds, cash, property, inflation });
  });
  rows.sort((a, b) => a.year - b.year);
  return { rows, errors };
}

/** Serialise rows back to CSV with a header. */
export function historicalToCsv(rows: HistoricalReturnRow[]): string {
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => r[c]).join(','))].join('\n');
}
