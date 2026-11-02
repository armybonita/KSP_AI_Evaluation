import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    env: { AIEAS_AUTH_MODE: 'local' },
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['tests/it/**', 'node_modules/**'],
    // The mandated mounted TMPDIR can make filesystem-heavy DB tests take over a minute.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Bound fork fan-out so the full suite does not lose two workers to VM parse errors under this mounted TMPDIR.
    minWorkers: 1,
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
