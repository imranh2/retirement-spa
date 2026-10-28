/**
 * Calendar helpers working on ISO date strings (yyyy-mm-dd), with no time zones.
 * UK tax years start on 6 April and are labelled like '2026/27'.
 */

export interface YMD { y: number; m: number; d: number }

const TAX_YEAR_START_MONTH = 4;
const TAX_YEAR_START_DAY = 6;
const CENTURY = 100;

/** Parse 'yyyy-mm-dd'. Throws on malformed input. */
export function parseIsoDate(iso: string): YMD {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid date '${iso}' (expected yyyy-mm-dd)`);
  const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (ymd.m < 1 || ymd.m > MONTHS || ymd.d < 1 || ymd.d > daysInMonth(ymd.y, ymd.m)) throw new Error(`Invalid date '${iso}' (no such day)`);
  return ymd;
}

const MONTHS = 12;
const FEBRUARY = 2;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isLeapYear(y: number): boolean { return (y % 4 === 0 && y % CENTURY !== 0) || y % 400 === 0; }
function daysInMonth(y: number, m: number): number { return m === FEBRUARY && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1]; }

/** True if `iso` is a well-formed yyyy-mm-dd date. */
export function isIsoDate(iso: string): boolean {
  try { parseIsoDate(iso); return true; } catch { return false; }
}

function compareYmd(a: YMD, b: YMD): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** Whole years of age on `onDate` for someone born on `dob`. */
export function ageAt(dob: string, onDate: string): number {
  const b = parseIsoDate(dob);
  const o = parseIsoDate(onDate);
  let age = o.y - b.y;
  if (o.m < b.m || (o.m === b.m && o.d < b.d)) age -= 1;
  return age;
}

/** ISO date `years` after `iso` (29 Feb rolls to 28 Feb). */
export function addYears(iso: string, years: number): string {
  const p = parseIsoDate(iso);
  const y = p.y + years;
  const d = p.m === FEBRUARY && p.d === 29 && !isLeapYear(y) ? 28 : p.d;
  return `${String(y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Compare two ISO dates: negative if a < b. */
export function compareIso(a: string, b: string): number {
  return compareYmd(parseIsoDate(a), parseIsoDate(b));
}

/** Calendar year in which the tax year containing `iso` starts. */
export function taxYearStartYearOf(iso: string): number {
  const p = parseIsoDate(iso);
  const beforeStart = p.m < TAX_YEAR_START_MONTH || (p.m === TAX_YEAR_START_MONTH && p.d < TAX_YEAR_START_DAY);
  return beforeStart ? p.y - 1 : p.y;
}

/** Label such as '2026/27' for a tax year starting in `startYear`. */
export function taxYearLabel(startYear: number): string {
  return `${startYear}/${String((startYear + 1) % CENTURY).padStart(2, '0')}`;
}

/** Start calendar year of a label like '2026/27'. The second part must be the following year. */
export function taxYearStartYear(label: string): number {
  const m = /^(\d{4})\/(\d{2})$/.exec(label);
  if (!m || Number(m[2]) !== (Number(m[1]) + 1) % CENTURY) throw new Error(`Invalid tax year '${label}' (expected e.g. 2026/27)`);
  return Number(m[1]);
}

/** True if `label` is a well-formed tax year label such as '2026/27'. */
export function isTaxYearLabel(label: string): boolean {
  try { taxYearStartYear(label); return true; } catch { return false; }
}

/** Today's date as yyyy-mm-dd (UI only; the engine always receives dates explicitly). */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
