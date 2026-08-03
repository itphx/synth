/**
 * Тесты TaskClassifier (AD-035).
 */
import { describe, it, expect } from 'vitest';
import { TaskClassifier } from './task-classifier.js';
import { DictionaryStore } from '../dictionary-store.js';
import type { MicroInput } from './types.js';

function makeInput(msg: string, lang = 'ru'): MicroInput {
  return {
    userMessage: msg,
    language: lang,
    sessionSettings: {
      temperature: 0.7,
      maxTokens: 4096,
      debugEnabled: true,
      streamEnabled: true,
      contextOptimization: 'none',
      slidingWindowMode: 'messages',
      slidingWindowMessageLimit: 10,
      slidingWindowTokenThreshold: 80,
      summarizationEnabled: false,
      summarizationTriggerMode: 'messages',
      summarizeAfterN: 10,
      summarizeTokenThreshold: 50,
      summarizationHeadMessages: 2,
      summarizationTailMessages: 3,
      showInterview: true,
      websocketEnabled: true,
      routingEnabled: true,
      routingStrategy: 'auto',
      routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
      routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
      routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
      subagentRouting: { enabled: true },
      microFirst: true,
      microConfidenceThreshold: 0.8,
      embeddingEnabled: false,
    },
  };
}

describe('TaskClassifier', () => {
  // Используем реальную директорию словарей из проекта
  const dictionaryStore = new DictionaryStore('/tmp/synth-test-dicts');
  const classifier = new TaskClassifier(dictionaryStore);

  it('классифицирует "привет" как small_talk', () => {
    const result = classifier.classify(makeInput('привет'));
    expect(result.taskClass).toBe('small_talk');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('классифицирует "пока" как small_talk', () => {
    const result = classifier.classify(makeInput('пока'));
    expect(result.taskClass).toBe('small_talk');
  });

  it('классифицирует "спасибо" как small_talk', () => {
    const result = classifier.classify(makeInput('спасибо'));
    expect(result.taskClass).toBe('small_talk');
  });

  it('классифицирует "да" как enum_decision (короткий запрос)', () => {
    const result = classifier.classify(makeInput('да'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует "нет" как enum_decision', () => {
    const result = classifier.classify(makeInput('нет'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует "утверждаю" как enum_decision', () => {
    const result = classifier.classify(makeInput('утверждаю'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует "отклоняю" как enum_decision', () => {
    const result = classifier.classify(makeInput('отклоняю'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует вопрос "что такое программирование?" как classify', () => {
    const result = classifier.classify(makeInput('что такое программирование?'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "почини ошибку" как classify (fix)', () => {
    const result = classifier.classify(makeInput('почини ошибку'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "напиши тесты" как classify (test)', () => {
    const result = classifier.classify(makeInput('напиши тесты'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "объясни" как classify (explain)', () => {
    const result = classifier.classify(makeInput('объясни'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "проанализируй архитектуру" как classify (review, не enum!)', () => {
    const result = classifier.classify(makeInput('проанализируй архитектуру'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "проанализируй архитектуру проекта" как classify (review, не enum!)', () => {
    const result = classifier.classify(makeInput('проанализируй архитектуру проекта'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "проведи ревью этого кода" как classify (review, не enum!)', () => {
    const result = classifier.classify(makeInput('проведи ревью этого кода'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "почему падает сборка" как classify (debug, не enum!)', () => {
    const result = classifier.classify(makeInput('почему падает сборка'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "почини ошибку в коде" как classify (fix)', () => {
    const result = classifier.classify(makeInput('почини ошибку в коде'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует "отменяю" как enum_decision (reject)', () => {
    const result = classifier.classify(makeInput('отменяю'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует "перейди в режим планирования" как enum_decision (mode_plan)', () => {
    const result = classifier.classify(makeInput('перейди в режим планирования'));
    expect(result.taskClass).toBe('enum_decision');
  });

  it('классифицирует coding-задачу с intent-словом как classify', () => {
    const result = classifier.classify(makeInput('напиши функцию сложения двух чисел на TypeScript'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует сложный запрос с intent-словом как classify', () => {
    const result = classifier.classify(makeInput('создай полноценный REST API с авторизацией и валидацией'));
    expect(result.taskClass).toBe('classify');
  });

  it('классифицирует запрос без intent-слов как llm_task', () => {
    const result = classifier.classify(makeInput('проведи рефакторинг модуля аутентификации'));
    expect(result.taskClass).toBe('llm_task');
  });

  it('классифицирует "hi" с lang=en как small_talk', () => {
    const result = classifier.classify(makeInput('hi', 'en'));
    expect(result.taskClass).toBe('small_talk');
  });
});
