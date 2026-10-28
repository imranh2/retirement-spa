import type { ConfigBundle } from './configTypes';
import { taxYearStartYear } from '../model/dates';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Copy of `value` with every key that exists in `defaults` but not in `value` added (recursively). Arrays are kept as they are. */
function fillMissing(value: unknown, defaults: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(defaults)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [k, d] of Object.entries(defaults)) {
    out[k] = k in value ? fillMissing(value[k], d) : structuredClone(d);
  }
  return out;
}

/**
 * Bring a saved or imported config up to the current shape: fields added in later versions
 * (e.g. savings rates, LISA minimum age, State Pension deferral) are filled from the shipped
 * defaults. Existing values are never changed. Each tax year is filled from the same year in
 * the defaults, else the latest default year; years the user removed are not added back.
 */
export function migrateConfig(config: ConfigBundle, defaults: ConfigBundle): ConfigBundle {
  const { tax, ...rest } = config;
  const { tax: defaultTax, ...defaultRest } = defaults;
  const defaultYears = Object.keys(defaultTax).sort((a, b) => taxYearStartYear(a) - taxYearStartYear(b));
  const latestDefault = defaultTax[defaultYears[defaultYears.length - 1]];
  const filledTax: ConfigBundle['tax'] = {};
  for (const [year, rules] of Object.entries(tax)) {
    filledTax[year] = fillMissing(rules, defaultTax[year] ?? latestDefault) as ConfigBundle['tax'][string];
  }
  return { ...(fillMissing(rest, defaultRest) as Omit<ConfigBundle, 'tax'>), tax: filledTax };
}
