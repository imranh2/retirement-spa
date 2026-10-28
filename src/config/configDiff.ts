import { joinPath, type PathPart } from './paths';

export interface Change { path: string; oldValue: unknown; newValue: unknown }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function walk(a: unknown, b: unknown, path: PathPart[], out: Change[]): void {
  if (deepEqual(a, b)) return;
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(a[k], b[k], [...path, k], out);
    return;
  }
  // Arrays of the same length are compared element by element (bands, schedule, matrix rows);
  // string arrays and arrays that changed length are reported as a single change.
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && !isStringArray(a) && !isStringArray(b)) {
    a.forEach((x, i) => walk(x, b[i], [...path, i], out));
    return;
  }
  out.push({ path: joinPath(path), oldValue: a, newValue: b });
}

/** Leaf-level differences between two configs, as concrete paths. */
export function diffConfig(a: unknown, b: unknown): Change[] {
  const out: Change[] = [];
  walk(a, b, [], out);
  return out;
}
