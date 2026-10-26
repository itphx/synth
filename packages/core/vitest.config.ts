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
    // ADR-097 (W5): загрузка модуля-драйвера БД вынесена из тестов на уровень
    // модуля (top-level preload в тест-файлах — см. `storage-context.degraded.test.ts`
    // и `maintenance/storage-migrate.test.ts`): top-level await не подчиняется
    // `testTimeout`, поэтому бюджет теста на загрузку модулей не тратится.
    // 20 c — общий запас для тяжёлых тестов (живой PG-контракт, схема/миграции)
    // под нагрузкой CI (ассерты не ослаблены).
    testTimeout: 20_000,
    // Хуки с тем же классом нагрузки: динамический импорт **опционального**
    // пакета внутри `beforeAll` (`execution/remote-dispatch.test.ts` —
    // `@itphx/synth-executor`, ADR-077). Импорт тянет transitive-граф
    // (ESM-пакеты MCP-SDK/zod инлайнятся и трансформируются vite'ом), и под
    // нагрузкой CI (446 файлов параллельно) он занимает 11–12 c — больше
    // дефолтных 10 c, из-за чего хук отваливался по таймауту, а тест — нет.
    // 30 c — запас на ту же нагрузку (ассерты не ослаблены).
    hookTimeout: 30_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
