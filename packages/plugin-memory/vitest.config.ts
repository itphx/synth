import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-plugin-memory',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support.ts'],
    },
  },
});
