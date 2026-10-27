import { describe, it, expect } from 'vitest';
import { lookupContextWindow, KNOWN_MODEL_WINDOWS, resolveModelModalities } from './model-metadata.js';

describe('lookupContextWindow', () => {
  it('находит точное совпадение по ID модели', () => {
    const result = lookupContextWindow('gpt-4o');
    expect(result).toEqual({ window: 128_000, source: 'reference' });
  });

  it('игнорирует регистр', () => {
    const result = lookupContextWindow('GPT-4O');
    expect(result).toEqual({ window: 128_000, source: 'reference' });
  });

  it('отрезает префикс провайдера (openai/gpt-4o)', () => {
    const result = lookupContextWindow('openai/gpt-4o');
    expect(result).toEqual({ window: 128_000, source: 'reference' });
  });

  it('отрезает двойной префикс (openrouter/openai/gpt-4o)', () => {
    const result = lookupContextWindow('openrouter/openai/gpt-4o');
    expect(result).toEqual({ window: 128_000, source: 'reference' });
  });

  it('отсекает суффиксы дат через :', () => {
    const result = lookupContextWindow('gpt-4o:2024-08-06');
    expect(result).toEqual({ window: 128_000, source: 'reference' });
  });

  it('находит по префиксу (claude-sonnet-4 → claude-sonnet-4-20250514)', () => {
    const result = lookupContextWindow('claude-sonnet-4');
    expect(result).toEqual({ window: 200_000, source: 'reference' });
  });

  it('возвращает unknown для неизвестной модели', () => {
    const result = lookupContextWindow('my-fictional-model-v999');
    expect(result).toEqual({ window: 0, source: 'unknown' });
  });

  it('находит gemini модели', () => {
    const result = lookupContextWindow('gemini-2.5-pro');
    expect(result.window).toBe(1_048_576);
    expect(result.source).toBe('reference');
  });

  it('находит deepseek модели', () => {
    const result = lookupContextWindow('deepseek-v3');
    expect(result.window).toBe(128_000);
  });

  it('находит mistral модели', () => {
    const result = lookupContextWindow('codestral-latest');
    expect(result.window).toBe(256_000);
  });

  it('находит llama модели', () => {
    const result = lookupContextWindow('llama-3.3-70b');
    expect(result.window).toBe(128_000);
  });

  it('KNOWN_MODEL_WINDOWS содержит хотя бы 50 записей', () => {
    expect(Object.keys(KNOWN_MODEL_WINDOWS).length).toBeGreaterThanOrEqual(50);
  });
});

/**
 * ADR-115: модальности входа модели (какие вложения она принимает).
 */
describe('resolveModelModalities', () => {
  it('известная vision-модель: текст + изображения (+ pdf)', () => {
    expect(resolveModelModalities('openai', 'gpt-4o')).toEqual(['text', 'image', 'pdf']);
  });

  it('id с префиксом провайдера и суффиксом даты распознаётся', () => {
    expect(resolveModelModalities('openai', 'openai/gpt-4o-2024-08-06')).toEqual([
      'text',
      'image',
      'pdf',
    ]);
    expect(resolveModelModalities('anthropic', 'claude-sonnet-4-20250514')).toEqual([
      'text',
      'image',
      'pdf',
    ]);
  });

  it('Gemini: текст + изображения + pdf + аудио + видео', () => {
    expect(resolveModelModalities('google', 'gemini-2.5-pro')).toEqual([
      'text',
      'image',
      'pdf',
      'audio',
      'video',
    ]);
  });

  it('аудио-модель OpenAI — отдельная запись', () => {
    expect(resolveModelModalities('openai', 'gpt-4o-audio-preview')).toEqual([
      'text',
      'audio',
      'image',
    ]);
  });

  it('неизвестная модель — консервативный фолбэк (только текст)', () => {
    expect(resolveModelModalities('custom', 'my-fictional-model-v999')).toEqual(['text']);
    expect(resolveModelModalities(undefined, 'gpt-4o')).toEqual(['text', 'image', 'pdf']);
  });

  it('возвращается копией — мутация результата не трогает справочник', () => {
    const modalities = resolveModelModalities('openai', 'gpt-4o');
    modalities.push('audio');
    expect(resolveModelModalities('openai', 'gpt-4o')).toEqual(['text', 'image', 'pdf']);
  });

  it('побеждает самый длинный ключ, а не порядок в объекте (deepseek)', () => {
    expect(resolveModelModalities('deepseek', 'deepseek-v4.1-flash-1017')).toEqual(['text', 'image']);
    expect(resolveModelModalities('routerai', 'deepseek/deepseek-v4.1-flash-1017')).toEqual([
      'text',
      'image',
    ]);
    expect(resolveModelModalities('deepseek', 'deepseek-v4-flash-vision-exp')).toEqual([
      'text',
      'image',
    ]);
    // Остальные семейства по-прежнему только текст.
    expect(resolveModelModalities('deepseek', 'deepseek-v4-pro')).toEqual(['text']);
  });

  it('MiniMax M3 — vision (каталог RouterAI: text+image+video)', () => {
    expect(resolveModelModalities('routerai-anthropic', 'minimax/minimax-m3.1-flash')).toEqual([
      'text',
      'image',
      'video',
    ]);
    // Более короткий ключ семейства тоже vision.
    expect(resolveModelModalities('minimax', 'minimax-m3')).toEqual(['text', 'image', 'video']);
    // M2 — текстовая модель: ключа M3 в её id нет, картинки не «протекают».
    expect(resolveModelModalities('minimax', 'minimax-m2.7')).toEqual(['text']);
  });

  it('локальные vision-семейства: VL / multimodal', () => {
    expect(resolveModelModalities('ollama', 'qwen2.5-vl-32b')).toEqual(['text', 'image']);
    expect(resolveModelModalities('ollama', 'qwen3-vl:8b')).toEqual(['text', 'image']);
    expect(resolveModelModalities('ollama', 'llava-1.6')).toEqual(['text', 'image']);
    expect(resolveModelModalities('ollama', 'phi-4-multimodal')).toEqual([
      'text',
      'image',
      'audio',
    ]);
    expect(resolveModelModalities('ollama', 'mistral-small-3.1')).toEqual(['text', 'image']);
    expect(resolveModelModalities('ollama', 'gemma-3-27b')).toEqual(['text', 'image']);
    // Обычные (текстовые) семейства не задеты.
    expect(resolveModelModalities('ollama', 'qwen2.5-coder-32b')).toEqual(['text']);
    expect(resolveModelModalities('ollama', 'mistral-small-latest')).toEqual(['text']);
  });
});
