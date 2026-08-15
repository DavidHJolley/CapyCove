import { defineConfig } from 'vite';

/**
 * DEBUG-GLOBAL GUARD (wave 11B, AUDIT F-11 / N-16).
 *
 * `window.__game` was the entire exploit: open devtools, paste four lines, mint
 * 12,000 coins an hour. src/core/game.js now hides its handle behind
 * `import.meta.env.DEV` so esbuild folds the statement away — but that is one
 * file remembering to do it, and the audit found a second handle
 * (`window.__cards`) that had not. Trusting every future author to remember is
 * how the first one shipped.
 *
 * So this checks the artefact instead of the source: after the bundle is built,
 * every emitted chunk is scanned for a surviving `window.__x = ` (or
 * `globalThis.__x = `) and each survivor is reported by name and file.
 *
 * `__THREE__` and `__THREE_DEVTOOLS__` are three.js's own markers — a revision
 * string and a devtools handshake, nothing reachable — so they pass.
 *
 * A survivor is a loud warning by default, because a check that hard-fails the
 * build cannot land until every offender is already fixed, and this one is
 * landing first on purpose. Set COVE_STRICT_BUILD=1 (what CI should do, wave
 * 11D) and it fails the build instead.
 */
const ALLOWED_GLOBALS = new Set(['__THREE__', '__THREE_DEVTOOLS__']);
// `= null` / `= undefined` / `= void 0` are CLEARING assignments (a dispose
// path scrubbing a handle), which is exactly what we want shipped - only an
// assignment that installs something real is a leak.
const DEBUG_GLOBAL_RE = /\b(?:window|globalThis)\.(__[A-Za-z0-9_$]+)\s*=\s*(?!=|null\b|undefined\b|void 0)/g;

function debugGlobalGuard() {
  return {
    name: 'cove-debug-global-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const found = new Set();
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk') continue;
        for (const m of out.code.matchAll(DEBUG_GLOBAL_RE)) {
          if (!ALLOWED_GLOBALS.has(m[1])) found.add(`${file}: window.${m[1]}`);
        }
      }
      if (!found.size) return;
      const msg = [
        'debug globals survived into the production bundle:',
        ...[...found].map((f) => `  ${f}`),
        'Wrap the assignment in `if (import.meta.env && import.meta.env.DEV)` so',
        'esbuild folds it away (see the note at the foot of src/core/game.js).',
      ].join('\n');
      if (process.env.COVE_STRICT_BUILD === '1') this.error(msg);
      else this.warn(msg);
    },
  };
}

export default defineConfig({
  plugins: [debugGlobalGuard()],
  server: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
