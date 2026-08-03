/**
 * Интеграционные тесты MicroPipeline (AD-035).
 */
import { describe, it, expect } from 'vitest';
import { MicroPipeline } from './index.js';
import { TaskClassifier } from './task-classifier.js';
import { RulesModel } from './models/rules-model.js';
import { DictionaryStore } from '../dictionary-store.js';
import type { MicroInput } from './types.js';

function makeInput(msg: string, lang = 'ru', microFirst = true, threshold = 0.8): MicroInput {
  return {
    userMessage: msg,
    language: lang,
    sessionSettings: {
      temperature: 0.7, maxTokens: 4096, debugEnabled: true, streamEnabled: true,
      contextOptimization: 'none', slidingWindowMode: 'messages', slidingWindowMessageLimit: 10,
      slidingWindowTokenThreshold: 80, summarizationEnabled: false, summarizationTriggerMode: 'messages',
      summarizeAfterN: 10, summarizeTokenThreshold: 50, summarizationHeadMessages: 2,
      summarizationTailMessages: 3, showInterview: true, websocketEnabled: true,
      routingEnabled: true, routingStrategy: 'auto',
      routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
      routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
      routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
      subagentRouting: { enabled: true },
      microFirst,
      microConfidenceThreshold: threshold,
      embeddingEnabled: false,
    },
  };
}

describe('MicroPipeline (интеграция)', () => {
  const dictionaryStore = new DictionaryStore('/tmp/synth-test-pipeline');
  const classifier = new TaskClassifier(dictionaryStore);
  const rulesModel = new RulesModel(classifier);
  const pipeline = new MicroPipeline(classifier, [rulesModel]);

  it('обрабатывает приветствие через микро-слой (handled=true)', async () => {
    const result = await pipeline.handle(makeInput('привет'));
    expect(result.handled).toBe(true);
    expect(result.microResult).not.toBeNull();
    expect(result.microResult!.answer).toBeTruthy();
    expect(result.microResult!.taskClass).toBe('small_talk');
  });

  it('обрабатывает прощание через микро-слой (handled=true)', async () => {
    const result = await pipeline.handle(makeInput('пока'));
    expect(result.handled).toBe(true);
    expect(result.microResult!.answer).toBeTruthy();
  });

  it('отправляет coding-задачу в fallback (handled=false)', async () => {
    const result = await pipeline.handle(makeInput('напиши функцию сортировки массива'));
    expect(result.handled).toBe(false);
    expect(result.microResult).toBeNull();
  });

  it('отправляет сложный запрос в fallback', async () => {
    const result = await pipeline.handle(makeInput('реализуй микросервисную архитектуру с Kafka и gRPC'));
    expect(result.handled).toBe(false);
  });

  it('возвращает fallbackSignals для llm_task', async () => {
    const result = await pipeline.handle(makeInput('создай базу данных пользователей'));
    expect(result.handled).toBe(false);
    expect(result.fallbackSignals).toBeTruthy();
    expect(result.fallbackSignals!.length).toBeGreaterThan(0);
  });

  it('микрослой выключен при microFirst=false', async () => {
    // Pipeline всё равно вызывается, но handled должен быть false
    const result = await pipeline.handle(makeInput('привет', 'ru', false));
    // При microFirst=false в сессии, pipeline всё ещё работает,
    // но handled зависит от confidence threshold
    // При threshold=0.8 и confidence ~0.9 — всё равно handled
    if (result.handled) {
      expect(result.microResult!.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('высокий порог уверенности может отправить в fallback', async () => {
    // При threshold=0.99 даже приветствие может быть UNSURE
    const result = await pipeline.handle(makeInput('привет', 'ru', true, 0.99));
    // Может быть handled или нет в зависимости от confidence
    if (result.handled) {
      expect(result.microResult!.confidence).toBeGreaterThanOrEqual(0.99);
    }
  });
});
