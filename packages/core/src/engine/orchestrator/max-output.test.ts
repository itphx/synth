import { describe, it, expect } from 'vitest';
import {
  AUTO_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
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
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8192);
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
    expect(resolveMaxOutputTokens({ requireReasoning: true })).toBe(8192);
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
    expect(resolveMaxOutputTokens({ sessionMax: -5, modelMax: 0, configMax: 0, requireReasoning: true })).toBe(8192);
    expect(resolveMaxOutputTokens({})).toBeGreaterThan(0);
    expect(Number.isInteger(resolveMaxOutputTokens({ configMax: 1234.7 }))).toBe(true);
  });
});
