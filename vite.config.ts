/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds embed a Content-Security-Policy <meta> tag so hosts that can't send headers
// (GitHub Pages) still get one. connect-src allows Supabase cloud plus the configured Supabase origin
// (custom domains, local stacks). Dev builds skip it because Vite's dev server injects inline scripts.
function cspMeta(supabaseUrl: string | undefined): Plugin {
  let extra = '';
  try {
    if (supabaseUrl) {
      const u = new URL(supabaseUrl);
      extra = ` ${u.origin} ${u.origin.replace(/^http/, 'ws')}`;
    }
  } catch {
    /* invalid URL: leave CSP at defaults */
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co${extra}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'tzml-csp-meta',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // GitHub Pages project sites live under /<repo>/; the deploy workflow sets VITE_BASE.
    base: process.env.VITE_BASE || '/',
    plugins: [react(), cspMeta(env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL)],
    test: {
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      environment: 'node',
    },
  };
});
