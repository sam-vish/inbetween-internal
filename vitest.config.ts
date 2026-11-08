import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts', 'apps/premium/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/dashboard/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
