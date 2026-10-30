import { describe, it, expect } from 'vitest';
import {
  detectCompatibilityHeuristics,
  mergeModelCompatibility,
  parseModelCompatibilityInput,
  resolveModelCompatibility,
  type ModelCompatibility,
} from './provider.js';

describe('resolveModelCompatibility — порядок «модель → провайдер → эвристика»', () => {
  it('без явных значений применяет встроенные дефолты (max_tokens, streamUsage=true)', () => {
    expect(resolveModelCompatibility()).toEqual({
      reasoningField: 'reasoning_content',
      requireReasoning: false,
      maxTokensField: 'max_tokens',
      requireAssistantAfterTool: false,
      streamUsage: true,
      supportsToolChoice: true,
    });
  });

  it('явное значение модели перекрывает провайдера, провайдер — эвристику', () => {
    const providerCompat: ModelCompatibility = {
      reasoningField: 'reasoning',
      requireReasoning: true,
      maxTokensField: 'max_completion_tokens',
      streamUsage: false,
    };
    const modelCompat: ModelCompatibility = {
      maxTokensField: 'max_tokens',
      streamUsage: true,
      requireAssistantAfterTool: true,
    };
    const resolved = resolveModelCompatibility(providerCompat, modelCompat, {
      requireReasoning: false,
      supportsToolChoice: false,
    });
    expect(resolved.reasoningField).toBe('reasoning');
    // requireReasoning не переопределён моделью — провайдерский true.
    expect(resolved.requireReasoning).toBe(true);
    // maxTokensField/streamUsage — модель победила.
    expect(resolved.maxTokensField).toBe('max_tokens');
    expect(resolved.streamUsage).toBe(true);
    expect(resolved.requireAssistantAfterTool).toBe(true);
    // supportsToolChoice — только эвристика.
    expect(resolved.supportsToolChoice).toBe(false);
  });

  it('явный reasoningField включает requireReasoning, если requireReasoning не задан', () => {
    expect(resolveModelCompatibility(undefined, { reasoningField: 'reasoning' }).requireReasoning).toBe(true);
  });

  it('явный requireReasoning=false сильнее явного reasoningField', () => {
    const resolved = resolveModelCompatibility(undefined, {
      reasoningField: 'reasoning',
      requireReasoning: false,
    });
    expect(resolved.requireReasoning).toBe(false);
  });

  it('maxTokensField по умолчанию max_tokens (намеренное отличие от opencode)', () => {
    const heuristics = detectCompatibilityHeuristics({
      providerType: 'openai',
      providerName: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5',
    });
    expect(resolveModelCompatibility(undefined, undefined, heuristics).maxTokensField).toBe('max_tokens');
  });
});

describe('detectCompatibilityHeuristics — эвристики opencode', () => {
  it('deepseek: тип/имя/URL/модель', () => {
    expect(detectCompatibilityHeuristics({ providerType: 'deepseek' }).requireReasoning).toBe(true);
    expect(detectCompatibilityHeuristics({ providerName: 'DeepSeek' }).requireReasoning).toBe(true);
    expect(detectCompatibilityHeuristics({ baseUrl: 'https://api.deepseek.com/v1' }).requireReasoning).toBe(true);
    expect(detectCompatibilityHeuristics({ modelId: 'deepseek-reasoner' }).requireReasoning).toBe(true);
    expect(detectCompatibilityHeuristics({ modelId: 'gpt-4o' }).requireReasoning).toBe(false);
  });

  it('Mistral-семейство требует assistant-турн после tool-результатов', () => {
    for (const model of ['mistral-large', 'devstral-small', 'codestral-2501', 'pixtral-12b', 'mixtral-8x7b']) {
      expect(detectCompatibilityHeuristics({ modelId: model }).requireAssistantAfterTool).toBe(true);
    }
    expect(detectCompatibilityHeuristics({ modelId: 'gpt-4o' }).requireAssistantAfterTool).toBe(false);
  });

  it('нативный Ollama не понимает tool_choice; прочие — понимают', () => {
    expect(detectCompatibilityHeuristics({ providerType: 'ollama' }).supportsToolChoice).toBe(false);
    expect(detectCompatibilityHeuristics({ providerType: 'openai' }).supportsToolChoice).toBe(true);
  });
});

describe('mergeModelCompatibility — наложение слоёв', () => {
  it('undefined-поля не перетирают значение, поздний слой приоритетнее', () => {
    const merged = mergeModelCompatibility(
      { requireReasoning: true, streamUsage: false },
      { requireReasoning: false },
      { reasoningField: 'reasoning' },
    );
    expect(merged).toEqual({
      requireReasoning: false,
      streamUsage: false,
      reasoningField: 'reasoning',
    });
  });

  it('пустые слои дают пустой объект', () => {
    expect(mergeModelCompatibility(undefined, {}, undefined)).toEqual({});
  });
});

describe('parseModelCompatibilityInput — API-контракт', () => {
  it('undefined — сохранить existing; null — сброс; объект — замена', () => {
    const existing: ModelCompatibility = { requireReasoning: true, streamUsage: false };
    expect(parseModelCompatibilityInput(undefined, existing)).toEqual({ ok: true, value: existing });
    expect(parseModelCompatibilityInput(null, existing)).toEqual({ ok: true, value: undefined });
    expect(parseModelCompatibilityInput({ maxTokensField: 'max_completion_tokens' }, existing)).toEqual({
      ok: true,
      value: { maxTokensField: 'max_completion_tokens' },
    });
  });

  it('частичный объект заменяет прежние поля, а не накладывается на них', () => {
    const existing: ModelCompatibility = { requireReasoning: true, maxTokensField: 'max_tokens' };
    expect(parseModelCompatibilityInput({ requireReasoning: false }, existing)).toEqual({
      ok: true,
      value: { requireReasoning: false },
    });
    // Пустой объект — полная очистка (как `null`).
    expect(parseModelCompatibilityInput({}, existing)).toEqual({ ok: true, value: undefined });
  });

  it('неизвестное поле → ошибка (опечатка не теряется молча)', () => {
    const result = parseModelCompatibilityInput({ reasoningFeild: 'reasoning' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('reasoningFeild');
  });

  it('неверные типы значений → ошибка', () => {
    expect(parseModelCompatibilityInput({ requireReasoning: 'yes' }).ok).toBe(false);
    expect(parseModelCompatibilityInput({ maxTokensField: 'max_new_tokens' }).ok).toBe(false);
    expect(parseModelCompatibilityInput({ reasoningField: '' }).ok).toBe(false);
    expect(parseModelCompatibilityInput([]).ok).toBe(false);
    expect(parseModelCompatibilityInput('x').ok).toBe(false);
  });

  it('пустой объект — нет совместимости', () => {
    expect(parseModelCompatibilityInput({})).toEqual({ ok: true, value: undefined });
  });
});
