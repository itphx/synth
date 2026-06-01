import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@synth/runner',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
