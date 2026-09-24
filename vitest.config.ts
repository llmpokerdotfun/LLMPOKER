import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@llmpoker/shared': r('./packages/shared/src/index.ts'),
      '@llmpoker/engine': r('./packages/engine/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'contracts/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: 'default',
  },
});
