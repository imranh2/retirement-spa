// Post-build check that dist/ is a host-agnostic static site.
// Plain Node ES module, no dependencies. Exits non-zero with a message on failure.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';
const FAIL_BYTES = 5 * 1024 * 1024;
const WARN_BYTES = 2 * 1024 * 1024;
const failures = [];
const fail = (msg) => failures.push(msg);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('static check failed: dist/index.html is missing (run npm run build first)');
  process.exit(1);
}
if (!existsSync(join(DIST, '.nojekyll'))) fail('dist/.nojekyll is missing (add an empty public/.nojekyll)');

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const tagRe = /<(script|link|img)\b[^>]*>/gi;
const attrRe = /\b(src|href)\s*=\s*["']([^"']*)["']/gi;
const referenced = [];
for (const tag of html.match(tagRe) ?? []) {
  for (const m of tag.matchAll(attrRe)) {
    const url = m[2];
    if (/^(\/|https?:)/i.test(url)) fail(`index.html: ${m[1]}="${url}" on <${tag.slice(1).split(/\s/)[0]}> is not relative`);
    else if (!url.startsWith('data:') && !/^<img/i.test(tag)) referenced.push(url.split(/[?#]/)[0]);
  }
}
for (const ref of referenced) {
  if (!existsSync(join(DIST, ref))) fail(`index.html references ${ref}, which does not exist in dist/`);
}

const files = walk(DIST);
for (const f of files.filter((p) => p.endsWith('.css'))) {
  const css = readFileSync(f, 'utf8');
  for (const m of css.matchAll(/url\(\s*["']?([^)"']*)/g)) {
    if (/^(\/|https?:)/i.test(m[1])) fail(`${relative(DIST, f)}: url(${m[1]}) is not relative`);
  }
}

const assets = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : [];
if (!assets.some((n) => n.startsWith('simWorker'))) fail('no worker bundle (dist/assets/simWorker*) found');

const total = files.reduce((s, f) => s + statSync(f).size, 0);
if (total > FAIL_BYTES) fail(`dist/ is ${(total / 1048576).toFixed(2)} MB (limit 5 MB)`);
else if (total > WARN_BYTES) console.warn(`warning: dist/ is ${(total / 1048576).toFixed(2)} MB (over 2 MB)`);

if (failures.length > 0) {
  console.error('static check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`${files.length} files, ${(total / 1024).toFixed(1)} KB total. static check passed`);
