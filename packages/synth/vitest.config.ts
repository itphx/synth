import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth',
    include: ['src/**/*.test.ts'],
    // Smoke-тест запускает CLI в дочернем процессе (`node --import tsx
    // src/cli.ts --version`): подъём ESM-графа core занимает ~2–3 c, поэтому
    // дефолтных 5 c мало. 30 c — запас под нагрузку CI; бюджет самого
    // запуска ограничен `execFileSync({ timeout })` в тесте.
    testTimeout: 30_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
