// Vite config shared by app and tests: one plugin instance, one set of shims.
//
// The `process`/`buffer` shims are required by the onchain dependencies, not by
// app code: @safe-global/protocol-kit imports Node's `Buffer`, and
// @trezor/connect-web's transport bundles Node stream/readable-stream code that
// reads `process.browser`, `process.version` and `process.nextTick` at load time.
// Without them both fail during hydration, before any component runs.

import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export const kitOptions = {
  adapter: adapter({ fallback: 'index.html' }),
} as const;

export const shared = {
  resolve: {
    alias: {
      buffer: 'buffer/',
      stream: 'stream-browserify',
      util: 'util/',
    },
  },
  define: { global: 'globalThis' },
} as const;

export default defineConfig({
  plugins: [sveltekit(kitOptions)],
  ...shared,
});
