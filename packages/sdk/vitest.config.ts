import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-sdk',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
