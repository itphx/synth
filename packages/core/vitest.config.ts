import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-core',
    include: ['src/**/*.test.ts'],
    // PROP-032 (W5): тесты, поднимающие PG-драйвер через динамический `import()`
    // (`@itphx/synth-storage-postgres` + `pg`), под параллельной нагрузкой полного
    // прогона превышают дефолтные 5 c на загрузку модулей и подключение. Таймаут
    // поднят, чтобы прогон был стабильным (ассерты не ослаблены).
    testTimeout: 20_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
