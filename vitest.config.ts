import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { kitOptions, shared } from './vite.config.ts';

export default defineConfig({
  plugins: [sveltekit(kitOptions)],
  ...shared,
  resolve: { ...shared.resolve, conditions: ['browser'] },
  test: {
    environment: 'happy-dom',
    pool: 'threads',
    include: ['test/component/**/*.test.ts'],
  },
});
