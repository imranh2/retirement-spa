import { defineConfig } from 'vitest/config';

// Production-only: add a Content Security Policy so the page cannot make network requests.
// Not applied in `vite dev` because the dev server needs inline scripts for hot reload.
const cspPlugin = () => ({
  name: 'inject-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join('; ');
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  },
});

export default defineConfig({
  base: './',                       // REQUIRED: relative URLs so it works under /repo-name/
  plugins: [cspPlugin()],
  build: { target: 'es2020', outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 600 },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
