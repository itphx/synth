/**
 * Тесты classify-intent handler (AD-035).
 */
import { describe, it, expect } from 'vitest';
import { handleClassifyIntent } from './classify-intent.js';
import type { MicroResult } from '../types.js';

describe('handleClassifyIntent', () => {
  it('добавляет сигналы для известного интента', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'question',
      confidence: 0.9,
      latencyMs: 10,
      signals: ['keyword:что'],
    };
    const result = handleClassifyIntent(input);
    expect(result.signals).toContain('intent:question');
    expect(result.signals.length).toBeGreaterThan(input.signals.length);
  });

  it('добавляет описание для review', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'review',
      confidence: 0.85,
      latencyMs: 10,
      signals: ['keyword:проверь'],
    };
    const result = handleClassifyIntent(input);
    expect(result.signals.some((s) => s.includes('Ревью'))).toBe(true);
  });

  it('работает с неизвестным интентом', () => {
    const input: MicroResult = {
      status: 'UNSURE',
      taskClass: 'classify',
      label: 'unknown',
      confidence: 0.3,
      latencyMs: 10,
      signals: [],
    };
    const result = handleClassifyIntent(input);
    expect(result.signals).toContain('intent:unknown');
  });

  it('не меняет confidence', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'command',
      confidence: 0.92,
      latencyMs: 10,
      signals: ['keyword:сделай'],
    };
    const result = handleClassifyIntent(input);
    expect(result.confidence).toBe(0.92);
  });

  it('обрабатывает интент debug', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'debug',
      confidence: 0.88,
      latencyMs: 10,
      signals: ['keyword:ошибка'],
    };
    const result = handleClassifyIntent(input);
    expect(result.signals).toContain('intent:debug');
  });

  it('генерирует осмысленный answer для валидного интента "review"', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'review',
      confidence: 0.99,
      latencyMs: 50,
      signals: ['embedding:review'],
    };
    const result = handleClassifyIntent(input);
    expect(result.answer).toBeTruthy();
    expect(result.answer).toContain('ревью');
  });

  it('генерирует answer для "fix", а не эхо запроса', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'fix',
      confidence: 0.9,
      latencyMs: 10,
      signals: ['keyword:исправь'],
    };
    const result = handleClassifyIntent(input);
    expect(result.answer).toBeTruthy();
    expect(result.answer).toContain('исправить');
  });

  it('генерирует fallback answer для неизвестного интента', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'classify',
      label: 'unknown',
      confidence: 0.3,
      latencyMs: 10,
      signals: [],
    };
    const result = handleClassifyIntent(input);
    expect(result.answer).toBe('Интент: unknown');
  });
});
