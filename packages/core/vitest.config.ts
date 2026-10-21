import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // Self-reference пакета: клиент удалённого порта (`@itphx/synth-executor`)
        // импортирует `@itphx/synth-core` (ExecutionError/InlineExecutionPort/
        // egressFetch). В тестах core этот импорт должен вести в **тот же**
        // экземпляр модуля, что и исходники пакета, — иначе `instanceof
        // ExecutionError` не сойдётся между контрактным suite (src) и удалённым
        // портом (dist). Точный regexp — чтобы subpath-экспорты
        // (`@itphx/synth-core/server/app.js`) не перехватывались.
        find: /^@itphx\/synth-core$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
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
