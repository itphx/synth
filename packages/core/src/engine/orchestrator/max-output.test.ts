import { describe, it, expect } from 'vitest';
import {
  AUTO_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  INPUT_ESTIMATE_MARGIN,
  OUTPUT_TOKEN_MAX,
  OUTPUT_TOKEN_MIN,
  REASONING_MIN_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from './max-output.js';

describe('resolveMaxOutputTokens — лимит вывода вызова', () => {
  it('авто (0/undefined на всех уровнях) → встроенный дефолт', () => {
    expect(resolveMaxOutputTokens({})).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({
      sessionMax: AUTO_MAX_OUTPUT_TOKENS,
      modelMax: 0,
      configMax: 0,
    })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(32768);
  });

  it('явное значение сессии приоритетнее каталога и конфига', () => {
    expect(resolveMaxOutputTokens({ sessionMax: 3000, modelMax: 100_000, configMax: 16_000 })).toBe(3000);
  });

  it('авто в сессии → лимит каталога (ModelConfig.maxOutputTokens)', () => {
    expect(resolveMaxOutputTokens({ sessionMax: 0, modelMax: 32_000, configMax: 16_000 })).toBe(32_000);
    expect(resolveMaxOutputTokens({ modelMax: 32_000 })).toBe(32_000);
  });

  it('нет каталога → конфиг llm.maxTokens', () => {
    expect(resolveMaxOutputTokens({ modelMax: 0, configMax: 12_000 })).toBe(12_000);
    expect(resolveMaxOutputTokens({ configMax: 12_000 })).toBe(12_000);
  });

  it('каталог — кап: явное значение сессии больше лимита модели не проходит', () => {
    expect(resolveMaxOutputTokens({ sessionMax: 64_000, modelMax: 8192 })).toBe(8192);
    // Конфиг тоже упирается в кап каталога.
    expect(resolveMaxOutputTokens({ configMax: 64_000, modelMax: 4096 })).toBe(4096);
  });

  it('пол reasoning: маленький лимит поднимается до REASONING_MIN_OUTPUT_TOKENS', () => {
    expect(REASONING_MIN_OUTPUT_TOKENS).toBe(8192);
    // Старые сессии с сохранённым 4096 (и такие же дефолты моделей/конфига).
    expect(resolveMaxOutputTokens({ sessionMax: 4096, requireReasoning: true })).toBe(8192);
    expect(resolveMaxOutputTokens({ configMax: 2048, requireReasoning: true })).toBe(8192);
    // Без явных лимитов база — дефолт ядра (уже выше пола), пол её не опускает.
    expect(resolveMaxOutputTokens({ requireReasoning: true })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('пол reasoning не опускает уже большой лимит', () => {
    expect(resolveMaxOutputTokens({ sessionMax: 16_000, requireReasoning: true })).toBe(16_000);
  });

  it('кап модели меньше пола reasoning — приоритет у каталога', () => {
    expect(resolveMaxOutputTokens({ modelMax: 4096, requireReasoning: true })).toBe(4096);
    expect(resolveMaxOutputTokens({ sessionMax: 1000, modelMax: 4096, requireReasoning: true })).toBe(4096);
  });

  it('без reasoning пол не применяется', () => {
    expect(resolveMaxOutputTokens({ sessionMax: 4096, requireReasoning: false })).toBe(4096);
    expect(resolveMaxOutputTokens({ modelMax: 1024 })).toBe(1024);
  });

  it('отрицательные/дробные/нечисловые значения трактуются как «не задано», результат — целое > 0', () => {
    expect(resolveMaxOutputTokens({ sessionMax: -5, modelMax: -1, configMax: 0 })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ sessionMax: Number.NaN, configMax: 1000.9 })).toBe(1000);
    expect(resolveMaxOutputTokens({ sessionMax: -5, modelMax: 0, configMax: 0, requireReasoning: true })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({})).toBeGreaterThan(0);
    expect(Number.isInteger(resolveMaxOutputTokens({ configMax: 1234.7 }))).toBe(true);
  });

  // ─── Адаптивное ужатие (паритет с opencode `session/model-request.ts`) ───
  it('потолок запроса: выше OUTPUT_TOKEN_MAX лимит не поднимается', () => {
    expect(OUTPUT_TOKEN_MAX).toBe(256_000);
    expect(resolveMaxOutputTokens({ sessionMax: 1_000_000 })).toBe(OUTPUT_TOKEN_MAX);
    expect(resolveMaxOutputTokens({ configMax: 500_000, modelMax: 400_000 })).toBe(OUTPUT_TOKEN_MAX);
  });

  it('неизвестное окно/вход — прежнее поведение (только базовый лимит)', () => {
    expect(resolveMaxOutputTokens({ configMax: 16_000 })).toBe(16_000);
    // Окно есть, входа нет → ужимать не по чему.
    expect(resolveMaxOutputTokens({ configMax: 16_000, contextWindow: 8192 })).toBe(16_000);
    // Вход есть, окно неизвестно (0) → ужимать не по чему.
    expect(resolveMaxOutputTokens({ configMax: 16_000, contextWindow: 0, inputEstimatedTokens: 100_000 }))
      .toBe(16_000);
  });

  it('маленький вход — лимит не ужимается', () => {
    // 128k окно, вход ~1k токенов: room ≈ 126k >> базовый лимит.
    expect(resolveMaxOutputTokens({
      configMax: 32_768,
      contextWindow: 128_000,
      inputEstimatedTokens: 1000,
    })).toBe(32_768);
  });

  it('большой вход — лимит ужимается до свободного места в окне', () => {
    // 32k окно, измерено 20k, оценка 8k: room = floor(32768*0.99) - 20000 - ceil(8000*1.15) = 32440-20000-9200 = 3240
    expect(resolveMaxOutputTokens({
      configMax: 32_768,
      contextWindow: 32_768,
      inputMeasuredTokens: 20_000,
      inputEstimatedTokens: 8_000,
    })).toBe(3240);
    // Без запаса на ошибку и без headroom — ровно свободное место.
    expect(resolveMaxOutputTokens({
      configMax: 32_768,
      contextWindow: 32_768,
      inputMeasuredTokens: 20_000,
      inputEstimatedTokens: 8_000,
      headroom: 0,
    })).toBe(32768 - 20_000 - Math.ceil(8_000 * INPUT_ESTIMATE_MARGIN));
  });

  it('свободного места меньше OUTPUT_TOKEN_MIN — лимит не опускается ниже пола', () => {
    expect(resolveMaxOutputTokens({
      configMax: 32_768,
      contextWindow: 16_000,
      inputEstimatedTokens: 15_900,
    })).toBe(OUTPUT_TOKEN_MIN);
  });

  it('headroom по умолчанию 1 %, для компактизации — 0', () => {
    // Окно 200k, измеренный вход 100k, оценка 20k — свободного места меньше
    // конфиг-лимита, поэтому ужатие срабатывает и видна разница в 1 % окна.
    const base = {
      configMax: 100_000,
      contextWindow: 200_000,
      inputMeasuredTokens: 100_000,
      inputEstimatedTokens: 20_000,
    };
    const withHeadroom = resolveMaxOutputTokens(base);
    const withoutHeadroom = resolveMaxOutputTokens({ ...base, headroom: 0 });
    expect(withoutHeadroom).toBeGreaterThan(withHeadroom);
    // 1 % от 200k = 2000 токенов уходит в headroom.
    expect(withoutHeadroom - withHeadroom).toBe(2000);
  });

  it('адаптивное ужатие не отменяет кап модели и пол reasoning', () => {
    // Модель умеет 4k — кап важнее свободного места.
    expect(resolveMaxOutputTokens({
      modelMax: 4096,
      contextWindow: 1_000_000,
      inputEstimatedTokens: 1000,
    })).toBe(4096);
    // Пол reasoning поднимает базу до 32768, но ужатие окна всё равно применяется:
    // room = floor(20000*0.99) - 0 - ceil(12000*1.15) = 19800 - 13800 = 6000.
    expect(resolveMaxOutputTokens({
      requireReasoning: true,
      contextWindow: 20_000,
      inputEstimatedTokens: 12_000,
    })).toBe(6000);
  });
});
