import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/it/**/*.it.test.ts'],
    testTimeout: 1800000, // 지표당 10분 (3개 지표 총 30분 허용)
    hookTimeout: 300000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
