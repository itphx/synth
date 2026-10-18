import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-backend',
    include: ['src/**/*.test.ts'],
    // PROP-032: локальный (ignored) `packages/backend/config.yaml` — dev-настройка
    // разработчика и может указывать `storage.backend: postgres`; тесты не должны
    // зависеть от окружения. Фиксируем файловый backend: контракт PG гоняется
    // отдельно (`@itphx/synth-storage-postgres`, `SYNTH_TEST_POSTGRES_DSN`).
    env: { SYNTH_STORAGE_BACKEND: 'file' },
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
