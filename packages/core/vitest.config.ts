import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-core',
    include: ['src/**/*.test.ts'],
    // PROP-032 (W5): загрузка модуля-драйвера БД вынесена из тестов на уровень
    // модуля (top-level preload в тест-файлах — см. `storage-context.degraded.test.ts`
    // и `maintenance/storage-migrate.test.ts`): top-level await не подчиняется
    // `testTimeout`, поэтому бюджет теста на загрузку модулей не тратится.
    // 20 c — общий запас для тяжёлых тестов (живой PG-контракт, схема/миграции)
    // под нагрузкой CI (ассерты не ослаблены).
    testTimeout: 20_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
