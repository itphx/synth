/**
 * Тесты enum-decision handler (ADR-035).
 */
import { describe, it, expect } from 'vitest';
import { handleEnumDecision } from './enum-decision.js';
import type { MicroResult } from '../types.js';

describe('handleEnumDecision', () => {
  it('пропускает валидный лейбл "yes"', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'yes',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:да'],
    };
    const result = handleEnumDecision(input);
    expect(result.status).toBe('OK');
    expect(result.label).toBe('yes');
  });

  it('пропускает валидный лейбл "approve"', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'approve',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:утверждаю'],
    };
    const result = handleEnumDecision(input);
    expect(result.status).toBe('OK');
  });

  it('понижает до UNSURE для невалидного лейбла', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'invalid',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:test'],
    };
    const result = handleEnumDecision(input);
    expect(result.status).toBe('UNSURE');
    expect(result.confidence).toBe(0.3);
  });

  it('понижает до UNSURE для пустого лейбла', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: '',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:test'],
    };
    const result = handleEnumDecision(input);
    expect(result.status).toBe('UNSURE');
  });

  it('добавляет сигнал valid_enum для валидного решения', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'mode_plan',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:план'],
    };
    const result = handleEnumDecision(input);
    expect(result.signals.some((s) => s.includes('valid_enum'))).toBe(true);
  });

  it('генерирует осмысленный answer для валидного лейбла "yes"', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'yes',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:да'],
    };
    const result = handleEnumDecision(input);
    expect(result.answer).toBeTruthy();
    expect(['Yes.', 'Confirmed.', 'Accepted.']).toContain(result.answer);
  });

  it('генерирует answer для mode_plan, а не эхо запроса', () => {
    const input: MicroResult = {
      status: 'OK',
      taskClass: 'enum_decision',
      label: 'mode_plan',
      confidence: 0.9,
      latencyMs: 5,
      signals: ['keyword:план'],
    };
    const result = handleEnumDecision(input);
    expect(result.answer).toBeTruthy();
    expect(result.answer).toContain('planning mode');
  });
});
