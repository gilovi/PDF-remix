import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// Strict CSP for production builds: the page may only talk to its own origin,
// so file contents cannot be sent anywhere even by accident.
// (Not applied in dev, where Vite's HMR needs a websocket.)
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// For hosts that read a `_headers` file (Cloudflare Pages). GitHub Pages ignores it.
export const HEADERS = `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()
`;

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
    },
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cspPlugin()],
  // pdf.js is large by nature; it is loaded once and cached.
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**'] },
});
