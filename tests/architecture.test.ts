import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

interface SourceFile { rel: string; content: string; code: string }

/** Remove comments so rules apply to code, not documentation. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function readTree(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|css|html)$/.test(e.name)) {
        const content = fs.readFileSync(full, 'utf8');
        out.push({ rel: path.relative(SRC, full).split(path.sep).join('/'), content, code: stripComments(content) });
      }
    }
  };
  walk(dir);
  return out;
}

const files = readTree(SRC);
const inDir = (d: string) => files.filter((f) => f.rel.startsWith(`${d}/`));
const importsOf = (f: SourceFile) => [...f.code.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
const resolveImport = (f: SourceFile, spec: string) => path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), spec));
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('import rules', () => {
  it('engine imports only model/, config/configTypes, config/resolveTaxYear and engine/', () => {
    const bad: string[] = [];
    for (const f of inDir('engine')) {
      for (const spec of importsOf(f)) {
        const target = resolveImport(f, spec);
        const ok = target.startsWith('engine/') || target.startsWith('model/') || target === 'config/configTypes' || target === 'config/resolveTaxYear';
        if (!ok) bad.push(`${f.rel} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('worker imports only engine/, model/ and config/', () => {
    const bad = inDir('worker').flatMap((f) => importsOf(f).filter((s) => !/^(engine|model|config)\//.test(resolveImport(f, s))).map((s) => `${f.rel} -> ${s}`));
    expect(bad).toEqual([]);
  });
  it('defaults imports only config/configTypes', () => {
    const bad = inDir('defaults').flatMap((f) => importsOf(f).filter((s) => resolveImport(f, s) !== 'config/configTypes').map((s) => `${f.rel} -> ${s}`));
    expect(bad).toEqual([]);
  });
  it('model and config never import from ui, worker or defaults', () => {
    const bad = [...inDir('model'), ...inDir('config')].flatMap((f) => importsOf(f).filter((s) => /^(ui|worker|defaults)\//.test(resolveImport(f, s))).map((s) => `${f.rel} -> ${s}`));
    expect(bad).toEqual([]);
  });
  it('ui never calls the engine directly (only through the worker)', () => {
    const bad = inDir('ui').flatMap((f) => importsOf(f).filter((s) => /^engine\//.test(resolveImport(f, s))).map((s) => `${f.rel} -> ${s}`));
    expect(bad).toEqual([]);
    expect(inDir('ui').filter((f) => /\b(simulate|createSimulation|findMaxSustainableSpend|maxSustainableSpend)\s*\(/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
});

describe('engine purity', () => {
  it('no Math.random in engine or worker', () => {
    expect([...inDir('engine'), ...inDir('worker')].filter((f) => /\bMath\.random\b/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
  it('engine does not touch window, document or localStorage', () => {
    expect(inDir('engine').filter((f) => /\b(window|document|localStorage)\b/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
  it('no UK tax-figure literals in engine', () => {
    const figures = ['12570', '37700', '50270', '125140', '100000', '20000', '268275', '60000', '10000', '4000', '241.30', '241.3'];
    const bad: string[] = [];
    for (const f of inDir('engine')) {
      for (const n of figures) if (new RegExp(`(?<![0-9._])${n.replace('.', '\\.')}(?![0-9])`).test(f.code)) bad.push(`${f.rel}: ${n}`);
      if (/(?<![0-9.])0\.(2|4|45|08|18|24|25)(?![0-9])/.test(f.code)) bad.push(`${f.rel}: tax-rate-like literal`);
    }
    expect(bad).toEqual([]);
  });
});

describe('static hosting rules', () => {
  it('no network API calls anywhere in src', () => {
    const re = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bWebSocket\b|\bEventSource\b|importScripts/;
    expect(files.filter((f) => re.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
  it('no History API routing', () => {
    const re = /history\.(pushState|replaceState)/;
    expect(files.filter((f) => re.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(re.test(indexHtml)).toBe(false);
  });
  it('no root-absolute asset URLs in src or index.html (except the Vite dev entry)', () => {
    const attr = /\b(?:src|href)\s*=\s*["'](\/[^"']*)["']/g;
    const cssUrl = /url\(\s*["']?(\/[^)"']*)/g;
    const workerUrl = /new\s+(?:URL|Worker)\(\s*["'](\/[^"']*)["']/g;
    const bad: string[] = [];
    for (const f of files) {
      for (const re of [attr, cssUrl, workerUrl]) for (const m of f.code.matchAll(re)) bad.push(`${f.rel}: ${m[1]}`);
    }
    for (const m of indexHtml.matchAll(attr)) if (m[1] !== '/src/main.ts') bad.push(`index.html: ${m[1]}`);
    expect(bad).toEqual([]);
  });
  it('all localStorage keys are prefixed ukplanner.', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of f.code.matchAll(/(?:getItem|setItem|removeItem)\(\s*['"`]([^'"`]+)['"`]/g)) if (!m[1].startsWith('ukplanner.')) bad.push(`${f.rel}: ${m[1]}`);
      for (const m of f.code.matchAll(/['"`](ukplanner\.[^'"`]*)['"`]/g)) if (!/^ukplanner\.[\w.-]+\.v\d+$/.test(m[1])) bad.push(`${f.rel}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
  it('the worker is created with the Vite new URL(..., import.meta.url) pattern', () => {
    const client = files.find((f) => f.rel === 'ui/simClient.ts');
    expect(client?.code).toMatch(/new Worker\(new URL\('\.\.\/worker\/simWorker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/);
  });
});
