// Тестовое окружение не должно зависеть от ambient NODE_ENV (аудит 0.13.4, F11):
// при NODE_ENV=production Vite переключается в прод-режим резолва, `react`
// грузится как `react.production.js` (там нет `act` → ~1 900 ложных падений),
// а `node:*`-импорты тестов считаются «браузерными» и не резолвятся.
// Выставляется при загрузке конфига — до того, как Vite разрешит опции.
// `test.env` ниже дополнительно фиксирует NODE_ENV внутри тестового окружения.
process.env.NODE_ENV = 'test';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    name: '@itphx/synth-ui',
    environment: 'jsdom',
    // Пиннинг окружения теста (см. комментарий в начале файла): без него
    // `NODE_ENV=production` давал прод-сборку React без `act`.
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
    },
  },
});
