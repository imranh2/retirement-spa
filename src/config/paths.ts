/**
 * Path helpers for config and scenario objects.
 * Path syntax: dot-separated keys with numeric indices in brackets,
 * e.g. `tax.2026/27.incomeTaxBands[0].upTo` or `market.correlations[1][2]`.
 */

export type PathPart = string | number;

/** Split a path string into keys and numeric indices. */
export function parsePath(path: string): PathPart[] {
  const parts: PathPart[] = [];
  for (const segment of path.split('.')) {
    if (segment === '') continue;
    const re = /\[(\d+)\]/g;
    const head = segment.split('[')[0];
    if (head !== '') parts.push(head);
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) parts.push(Number(m[1]));
  }
  return parts;
}

/** Join parts back into a path string (inverse of parsePath). */
export function joinPath(parts: PathPart[]): string {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out === '' ? p : `.${p}`;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Read the value at `path`, or undefined if any step is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of parsePath(path)) {
    if (!isRecord(cur)) return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

/** True if every step of `path` exists in `obj`. */
export function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const p of parsePath(path)) {
    if (!isRecord(cur) || !(p in cur)) return false;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return true;
}

/**
 * Return a copy of `obj` with `value` set at `path`. Objects along the path are
 * shallow-copied; the input is never mutated. Missing intermediate steps are created.
 */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const parts = parsePath(path);
  if (parts.length === 0) return value as T;
  const write = (node: unknown, i: number): unknown => {
    const key = parts[i];
    const base: Record<string | number, unknown> | unknown[] = Array.isArray(node)
      ? [...node]
      : isRecord(node) ? { ...node } : typeof key === 'number' ? [] : {};
    const container = base as Record<string | number, unknown>;
    container[key] = i === parts.length - 1 ? value : write(container[key], i + 1);
    return base;
  };
  return write(obj, 0) as T;
}

/** Return a copy of `obj` with the key at `path` removed (array items are spliced out). */
export function deletePath<T>(obj: T, path: string): T {
  const parts = parsePath(path);
  if (parts.length === 0) return obj;
  const parentPath = joinPath(parts.slice(0, -1));
  const parent = parts.length === 1 ? obj : getPath(obj, parentPath);
  const key = parts[parts.length - 1];
  let next: unknown;
  if (Array.isArray(parent) && typeof key === 'number') {
    next = parent.filter((_, i) => i !== key);
  } else if (isRecord(parent)) {
    const copy: Record<string | number, unknown> = { ...parent };
    delete copy[key];
    next = copy;
  } else {
    return obj;
  }
  return parts.length === 1 ? (next as T) : setPath(obj, parentPath, next);
}

/**
 * List every leaf path in `obj`. Arrays of strings count as a single leaf
 * (e.g. `taxProjection.upratedItems`); other arrays are walked element by element.
 */
export function leafPaths(obj: unknown, prefix: PathPart[] = []): string[] {
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every((x) => typeof x === 'string')) return [joinPath(prefix)];
    return obj.flatMap((v, i) => leafPaths(v, [...prefix, i]));
  }
  if (isRecord(obj)) {
    return Object.keys(obj).flatMap((k) => leafPaths(obj[k], [...prefix, k]));
  }
  return [joinPath(prefix)];
}
