import { CHOLESKY_JITTER, RUN_STREAM_DRAWS } from './constants';

export type Rng = () => number;

const UINT32 = 4294967296;
const MULBERRY_INC = 0x6d2b79f5;
/** State distance between consecutive runs' starting points (RUN_STREAM_DRAWS increments). */
const RUN_STRIDE = Math.imul(MULBERRY_INC, RUN_STREAM_DRAWS) >>> 0;

/** Seeded uniform generator on [0, 1). Same seed gives the same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + MULBERRY_INC) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/**
 * Seed for run `runIndex`: the start of its own block of RUN_STREAM_DRAWS draws on the
 * mulberry32 cycle, so no two runs (up to 131,072) ever reuse each other's numbers.
 */
export function runSeed(seed: number, runIndex: number): number {
  return (seed + Math.imul(runIndex, RUN_STRIDE)) >>> 0;
}

/** Box-Muller spare values, kept per generator so separate runs never share state. */
const spares = new WeakMap<Rng, number>();

/** One standard normal draw from `rng` (Box-Muller; the second value is cached per rng). */
export function nextNormal(rng: Rng): number {
  const spare = spares.get(rng);
  if (spare !== undefined) {
    spares.delete(rng);
    return spare;
  }
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  const theta = 2 * Math.PI * v;
  spares.set(rng, r * Math.sin(theta));
  return r * Math.cos(theta);
}

function tryCholesky(m: number[][], jitter: number): number[][] | string {
  const n = m.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];
      if (i === j) {
        const d = m[i][i] + jitter - s;
        if (!(d > 0)) return `pivot ${i + 1} is ${d.toExponential(3)}`;
        L[i][j] = Math.sqrt(d);
      } else {
        L[i][j] = (m[i][j] - s) / L[j][j];
      }
    }
  }
  return L;
}

/**
 * Lower-triangular L with L * L^T = matrix. Retries with a 1e-10 diagonal jitter,
 * then throws a descriptive error if the matrix is not positive definite.
 */
export function choleskyDecompose(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (n === 0 || matrix.some((row) => row.length !== n)) throw new Error('Correlation matrix must be square');
  const first = tryCholesky(matrix, 0);
  if (typeof first !== 'string') return first;
  const second = tryCholesky(matrix, CHOLESKY_JITTER);
  if (typeof second !== 'string') return second;
  throw new Error(`Correlation matrix is not positive definite (${second}). Reduce the off-diagonal correlations.`);
}

/**
 * Returns a function producing a vector of correlated standard normals.
 * Uses the same Box-Muller sequence as nextNormal(rng) but keeps the spare locally
 * (hot path: millions of draws per simulation with monthly steps).
 */
export function makeCorrelatedSampler(rng: Rng, matrix: number[][]): () => number[] {
  const L = choleskyDecompose(matrix);
  const n = L.length;
  const z = new Array<number>(n).fill(0);
  let spare = 0;
  let hasSpare = false;
  const normal = (): number => {
    if (hasSpare) { hasSpare = false; return spare; }
    let u = 0;
    while (u === 0) u = rng();
    const v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    hasSpare = true;
    return r * Math.cos(theta);
  };
  return function sample(): number[] {
    for (let i = 0; i < n; i++) z[i] = normal();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = L[i];
      for (let k = 0; k <= i; k++) s += row[k] * z[k];
      out[i] = s;
    }
    return out;
  };
}
