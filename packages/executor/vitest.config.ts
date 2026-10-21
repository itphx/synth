import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@itphx/synth-executor',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    // Таймауты тестов: запуск команды в воркере (spawn + ожидание) занимает
    // сотни мс; запас общий для пакета (живой HTTP-сервер в тестах клиента).
    testTimeout: 20_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
