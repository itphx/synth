/**
 * Тесты RulesModel (AD-035).
 */
import { describe, it, expect } from 'vitest';
import { RulesModel } from './rules-model.js';
import { TaskClassifier } from '../task-classifier.js';
import { DictionaryStore } from '../../dictionary-store.js';
import type { MicroInput } from '../types.js';

function makeInput(msg: string, lang = 'ru'): MicroInput {
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
      microFirst: true, microConfidenceThreshold: 0.8,
      embeddingEnabled: false,
    },
  };
}

describe('RulesModel', () => {
  const dictionaryStore = new DictionaryStore('/tmp/synth-test-rules');
  const classifier = new TaskClassifier(dictionaryStore);
  const rulesModel = new RulesModel(classifier);

  // Debug: проверим парсинг словарей
  const stCat = dictionaryStore.getCategorizedKeywords('small-talk', 'ru');
  const enumCat = dictionaryStore.getCategorizedKeywords('enum', 'ru');
  console.log('small-talk categorized keys:', Object.keys(stCat));
  console.log('farewell_keywords:', stCat.farewell_keywords);
  console.log('enum categorized keys:', Object.keys(enumCat));
  console.log('yes_keywords:', enumCat.yes_keywords);

  it('canHandle возвращает true для small_talk', () => {
    expect(rulesModel.canHandle('small_talk')).toBe(true);
  });

  it('canHandle возвращает false для llm_task', () => {
    expect(rulesModel.canHandle('llm_task')).toBe(false);
  });

  it('обрабатывает приветствие с OK статусом', async () => {
    const result = await rulesModel.handle(makeInput('привет'), 'small_talk');
    expect(result.status).toBe('OK');
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.answer).toBeTruthy();
    expect(result.taskClass).toBe('small_talk');
  });

  it('обрабатывает прощание с OK статусом', async () => {
    const result = await rulesModel.handle(makeInput('пока'), 'small_talk');
    expect(result.status).toBe('OK');
    expect(result.answer).toBeTruthy();
    expect(result.label).toBe('farewell');
  });

  it('обрабатывает благодарность с OK статусом', async () => {
    const result = await rulesModel.handle(makeInput('спасибо'), 'small_talk');
    expect(result.status).toBe('OK');
    expect(result.answer).toBeTruthy();
  });

  it('возвращает UNSURE для неизвестного classify', async () => {
    const result = await rulesModel.handle(makeInput('xyzabc123'), 'classify');
    expect(result.status).toBe('UNSURE');
  });

  it('обрабатывает "да" как enum_decision', async () => {
    const result = await rulesModel.handle(makeInput('да'), 'enum_decision');
    expect(result.status).toBe('OK');
    expect(result.label).toBe('yes');
  });

  it('latencyMs > 0 для всех запросов', async () => {
    const result = await rulesModel.handle(makeInput('привет'), 'small_talk');
    expect(result.latencyMs).toBeGreaterThan(0);
  });
});
