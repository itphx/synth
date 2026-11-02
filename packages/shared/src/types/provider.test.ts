import { describe, it, expect } from 'vitest';
import {
  detectCompatibilityHeuristics,
  isRouterAiUrl,
  mergeModelCompatibility,
  nativeAudioFormatForMime,
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
      requireFinishReason: true,
      supportsEffortUpdates: false,
      // ADR-115: без эвристики (её считает `detectCompatibilityHeuristics`)
      // нативных медиа нет.
      supportsNativeVideo: false,
      nativeAudioFormats: [],
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

  it('requireFinishReason: дефолт true, явный false сильнее дефолта и эвристики', () => {
    expect(resolveModelCompatibility().requireFinishReason).toBe(true);
    expect(resolveModelCompatibility(undefined, { requireFinishReason: false }).requireFinishReason).toBe(false);
    // Модель перекрывает провайдера.
    expect(
      resolveModelCompatibility({ requireFinishReason: false }, { requireFinishReason: true }).requireFinishReason,
    ).toBe(true);
    expect(resolveModelCompatibility({ requireFinishReason: false }).requireFinishReason).toBe(false);
  });

  it('cacheFormat: не задан → undefined (маркеры не ставятся), модель перекрывает провайдера', () => {
    expect(resolveModelCompatibility().cacheFormat).toBeUndefined();
    expect(resolveModelCompatibility({ cacheFormat: 'anthropic' }).cacheFormat).toBe('anthropic');
    expect(
      resolveModelCompatibility({ cacheFormat: 'anthropic' }, { cacheFormat: 'alibaba' }).cacheFormat,
    ).toBe('alibaba');
    // Эвристики cacheFormat не задают — поведение существующих записей не меняется.
    const heuristics = detectCompatibilityHeuristics({ providerType: 'openai', modelId: 'claude-sonnet-4' });
    expect(resolveModelCompatibility(undefined, undefined, heuristics).cacheFormat).toBeUndefined();
  });

  it('supportsEffortUpdates: дефолт false, только явное значение, модель перекрывает провайдера', () => {
    expect(resolveModelCompatibility().supportsEffortUpdates).toBe(false);
    expect(resolveModelCompatibility({ supportsEffortUpdates: true }).supportsEffortUpdates).toBe(true);
    expect(
      resolveModelCompatibility(
        { supportsEffortUpdates: true },
        { supportsEffortUpdates: false },
      ).supportsEffortUpdates,
    ).toBe(false);
    // Авто-эвристики нет: даже «effort-модель» из каталога остаётся false.
    const heuristics = detectCompatibilityHeuristics({
      providerType: 'anthropic',
      providerName: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      modelId: 'claude-sonnet-5',
    });
    expect(resolveModelCompatibility(undefined, undefined, heuristics).supportsEffortUpdates).toBe(false);
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

  it('minimax: провайдер/URL, но не имя модели', () => {
    expect(detectCompatibilityHeuristics({ providerName: 'MiniMax' }).requireReasoning).toBe(true);
    expect(detectCompatibilityHeuristics({ baseUrl: 'https://api.minimax.io/v1' }).requireReasoning).toBe(true);
    // Сторонние видео-модели с именем `minimax` не делают провайдера reasoning.
    expect(detectCompatibilityHeuristics({ modelId: 'minimax-video-01' }).requireReasoning).toBe(false);
    expect(detectCompatibilityHeuristics({ providerType: 'openai', modelId: 'gpt-4o' }).requireReasoning).toBe(false);
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

  it('cacheFormat: принимаются только anthropic/alibaba', () => {
    expect(parseModelCompatibilityInput({ cacheFormat: 'anthropic' })).toEqual({
      ok: true,
      value: { cacheFormat: 'anthropic' },
    });
    expect(parseModelCompatibilityInput({ cacheFormat: 'alibaba' })).toEqual({
      ok: true,
      value: { cacheFormat: 'alibaba' },
    });
    for (const bad of ['openai', 'qwen', '', null, 1]) {
      const result = parseModelCompatibilityInput({ cacheFormat: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('cacheFormat');
    }
  });

  it('requireFinishReason: boolean, false сохраняется явно', () => {
    expect(parseModelCompatibilityInput({ requireFinishReason: false })).toEqual({
      ok: true,
      value: { requireFinishReason: false },
    });
    expect(parseModelCompatibilityInput({ requireFinishReason: true })).toEqual({
      ok: true,
      value: { requireFinishReason: true },
    });
    expect(parseModelCompatibilityInput({ requireFinishReason: 'no' }).ok).toBe(false);
  });

  it('supportsEffortUpdates: boolean, false сохраняется явно', () => {
    expect(parseModelCompatibilityInput({ supportsEffortUpdates: true })).toEqual({
      ok: true,
      value: { supportsEffortUpdates: true },
    });
    expect(parseModelCompatibilityInput({ supportsEffortUpdates: false })).toEqual({
      ok: true,
      value: { supportsEffortUpdates: false },
    });
    expect(parseModelCompatibilityInput({ supportsEffortUpdates: 'yes' }).ok).toBe(false);
  });

  it('supportsNativeVideo: только boolean', () => {
    expect(parseModelCompatibilityInput({ supportsNativeVideo: true })).toEqual({
      ok: true,
      value: { supportsNativeVideo: true },
    });
    expect(parseModelCompatibilityInput({ supportsNativeVideo: false })).toEqual({
      ok: true,
      value: { supportsNativeVideo: false },
    });
    for (const bad of ['true', 1, null, {}]) {
      expect(parseModelCompatibilityInput({ supportsNativeVideo: bad }).ok).toBe(false);
    }
  });

  it('nativeAudioFormats: массив из wav|mp3|ogg, неизвестное значение → ошибка', () => {
    expect(parseModelCompatibilityInput({ nativeAudioFormats: ['wav', 'mp3'] })).toEqual({
      ok: true,
      value: { nativeAudioFormats: ['wav', 'mp3'] },
    });
    expect(parseModelCompatibilityInput({ nativeAudioFormats: ['ogg'] })).toEqual({
      ok: true,
      value: { nativeAudioFormats: ['ogg'] },
    });
    // Пустой массив — валидное явное значение («ни одного формата»).
    expect(parseModelCompatibilityInput({ nativeAudioFormats: [] })).toEqual({
      ok: true,
      value: { nativeAudioFormats: [] },
    });
    // Не массив / неизвестный формат / неверный тип элемента → ошибка.
    for (const bad of ['wav', { wav: true }, [1], ['flac'], ['wav', 'flac'], [null]]) {
      const result = parseModelCompatibilityInput({ nativeAudioFormats: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('nativeAudioFormats');
    }
  });

  it('пустой объект — нет совместимости', () => {
    expect(parseModelCompatibilityInput({})).toEqual({ ok: true, value: undefined });
  });
});

describe('detectCompatibilityHeuristics — нативные медиа (ADR-115 × ADR-117)', () => {
  const routerAi = { baseUrl: 'https://routerai.ru/api/v1/chat/completions' };
  const plainOpenAi = { baseUrl: 'https://api.openai.com/v1' };

  it('openai/generic + RouterAI: wav/mp3/ogg и нативное видео', () => {
    for (const providerType of ['openai', 'generic']) {
      const h = detectCompatibilityHeuristics({ providerType, ...routerAi });
      expect(h.nativeAudioFormats).toEqual(['wav', 'mp3', 'ogg']);
      expect(h.supportsNativeVideo).toBe(true);
    }
  });

  it('openai/generic без RouterAI: wav/mp3, видео нет', () => {
    for (const providerType of ['openai', 'generic']) {
      const h = detectCompatibilityHeuristics({ providerType, ...plainOpenAi });
      expect(h.nativeAudioFormats).toEqual(['wav', 'mp3']);
      expect(h.supportsNativeVideo).toBe(false);
    }
  });

  it('anthropic: только wav у RouterAI, иначе — ни одного формата; видео нет', () => {
    const withRouterAi = detectCompatibilityHeuristics({ providerType: 'anthropic', ...routerAi });
    expect(withRouterAi.nativeAudioFormats).toEqual(['wav']);
    expect(withRouterAi.supportsNativeVideo).toBe(false);

    const withoutRouterAi = detectCompatibilityHeuristics({
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    expect(withoutRouterAi.nativeAudioFormats).toEqual([]);
    expect(withoutRouterAi.supportsNativeVideo).toBe(false);
  });

  it('прочие типы провайдера: ни аудио, ни видео — независимо от хоста', () => {
    for (const providerType of ['ollama', 'decision', 'systemone', 'remote', '']) {
      const h = detectCompatibilityHeuristics({ providerType, ...routerAi });
      expect(h.nativeAudioFormats).toEqual([]);
      expect(h.supportsNativeVideo).toBe(false);
    }
  });

  it('не-routerai прокси (itphx) по умолчанию — без нативного видео', () => {
    // Живой тест 2026-11-03 показал, что `itphx` видео умеет: это решается
    // данными (`compatibility.supportsNativeVideo: true`), а не host-проверкой.
    const h = detectCompatibilityHeuristics({
      providerType: 'openai',
      baseUrl: 'https://ai.itphx.ru/api/',
    });
    expect(h.supportsNativeVideo).toBe(false);
    expect(h.nativeAudioFormats).toEqual(['wav', 'mp3']);
  });
});

describe('resolveModelCompatibility — нативные медиа (ADR-117)', () => {
  it('явное значение модели перекрывает провайдера и эвристику', () => {
    const resolved = resolveModelCompatibility(
      { nativeAudioFormats: ['wav'], supportsNativeVideo: true },
      { nativeAudioFormats: ['mp3'], supportsNativeVideo: false },
      { nativeAudioFormats: ['wav', 'mp3', 'ogg'], supportsNativeVideo: true },
    );
    expect(resolved.nativeAudioFormats).toEqual(['mp3']);
    expect(resolved.supportsNativeVideo).toBe(false);
  });

  it('явное значение провайдера перекрывает эвристику', () => {
    const resolved = resolveModelCompatibility(
      { nativeAudioFormats: [], supportsNativeVideo: false },
      undefined,
      { nativeAudioFormats: ['wav', 'mp3', 'ogg'], supportsNativeVideo: true },
    );
    expect(resolved.nativeAudioFormats).toEqual([]);
    expect(resolved.supportsNativeVideo).toBe(false);
  });

  it('явный пустой массив перекрывает эвристику (не «не задано»)', () => {
    // `??` не схлопывает `[]` — пустой перечень форматов остаётся пустым.
    const resolved = resolveModelCompatibility(
      { nativeAudioFormats: [] },
      undefined,
      { nativeAudioFormats: ['wav', 'mp3', 'ogg'], supportsNativeVideo: true },
    );
    expect(resolved.nativeAudioFormats).toEqual([]);
  });

  it('без явных значений берётся эвристика, затем дефолт', () => {
    const withHeuristic = resolveModelCompatibility(undefined, undefined, {
      nativeAudioFormats: ['wav'],
      supportsNativeVideo: true,
    });
    expect(withHeuristic.nativeAudioFormats).toEqual(['wav']);
    expect(withHeuristic.supportsNativeVideo).toBe(true);

    const withoutHeuristic = resolveModelCompatibility();
    expect(withoutHeuristic.nativeAudioFormats).toEqual([]);
    expect(withoutHeuristic.supportsNativeVideo).toBe(false);
  });
});

describe('isRouterAiUrl / nativeAudioFormatForMime — единственный источник истины', () => {
  it('RouterAI-хост определяется по домену (поддомены — тоже)', () => {
    expect(isRouterAiUrl('https://routerai.ru/api/v1/chat/completions')).toBe(true);
    expect(isRouterAiUrl('https://sub.routerai.ru/v1')).toBe(true);
    expect(isRouterAiUrl('https://ai.itphx.ru/api/')).toBe(false);
    expect(isRouterAiUrl('https://routerai.ru.evil.example/v1')).toBe(false);
    expect(isRouterAiUrl('не-url')).toBe(false);
  });

  it('MIME → нативный аудио-контейнер', () => {
    expect(nativeAudioFormatForMime('audio/wav')).toBe('wav');
    expect(nativeAudioFormatForMime('audio/x-wav')).toBe('wav');
    expect(nativeAudioFormatForMime('audio/wave')).toBe('wav');
    expect(nativeAudioFormatForMime('audio/mpeg')).toBe('mp3');
    expect(nativeAudioFormatForMime('audio/mp3')).toBe('mp3');
    expect(nativeAudioFormatForMime('audio/ogg')).toBe('ogg');
    expect(nativeAudioFormatForMime('audio/opus')).toBe('ogg');
    expect(nativeAudioFormatForMime('audio/oga')).toBe('ogg');
    expect(nativeAudioFormatForMime('video/mp4')).toBeNull();
    expect(nativeAudioFormatForMime('audio/flac')).toBeNull();
  });
});
