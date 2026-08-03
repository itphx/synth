/**
 * Тесты small-talk handler (AD-035).
 */
import { describe, it, expect } from 'vitest';
import { handleSmallTalk } from './small-talk.js';
import type { MicroResult } from '../types.js';

describe('handleSmallTalk', () => {
  it('добавляет ответ для greeting если его нет', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'greeting',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:привет'],
    };
    const result = handleSmallTalk(input);
    expect(result.answer).toBeTruthy();
    expect(result.answer!.length).toBeGreaterThan(0);
    expect(result.status).toBe('OK');
  });

  it('сохраняет существующий ответ', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'greeting',
      confidence: 0.9,
      answer: 'Кастомный ответ',
      latencyMs: 5,
      signals: ['keyword:привет'],
    };
    const result = handleSmallTalk(input);
    expect(result.answer).toBe('Кастомный ответ');
  });

  it('генерирует ответ для farewell', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'farewell',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:пока'],
    };
    const result = handleSmallTalk(input);
    expect(result.answer).toBeTruthy();
  });

  it('генерирует ответ для thanks', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'thanks',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:спасибо'],
    };
    const result = handleSmallTalk(input);
    expect(result.answer).toBeTruthy();
  });

  it('возвращает greeting answer по умолчанию для неизвестного label', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'unknown_label',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:test'],
    };
    const result = handleSmallTalk(input);
    expect(result.answer).toBeTruthy();
  });
});
