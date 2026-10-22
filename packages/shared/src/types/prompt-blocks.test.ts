/**
 * PROP-090 §«Точка `promptBlocks`»: контракт провайдера блока системного промпта.
 *
 * Проверяется **контракт**, а не реализация (реализация — в core):
 * - тир `stable` недопустим **на уровне типа** (граница prompt-cache, ADR-070);
 * - ключ/порядок/подпись — обязательные части контракта;
 * - `load()` может вернуть строку или расширенный объект с provenance/status;
 * - `query`/`turnId`/`timestamp` — опциональные (шаг пайплайна, саб-агент).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROMPT_BLOCK_MAX_CHARS,
  PLUGIN_PROMPT_BLOCK_KEY_PREFIX,
  PROMPT_BLOCK_PROVIDER_TIERS,
  isPluginPromptBlockKey,
} from './prompt-blocks.js';
import type { PromptBlockContext, PromptBlockProvider } from './prompt-blocks.js';

function makeCtx(over: Partial<PromptBlockContext> = {}): PromptBlockContext {
  return {
    sessionId: 's1',
    agentRole: 'assistant',
    language: 'ru',
    mode: 'act',
    ...over,
  };
}

describe('тиры провайдера блока промпта', () => {
  it('в реестре только context|volatile (stable запрещён)', () => {
    expect(PROMPT_BLOCK_PROVIDER_TIERS).toEqual(['context', 'volatile']);
    expect(PROMPT_BLOCK_PROVIDER_TIERS).not.toContain('stable');
  });

  it('тир stable не компилируется (@ts-expect-error)', () => {
    const provider: PromptBlockProvider = {
      key: 'plugin.demo.block',
      // @ts-expect-error — тир stable запрещён контрактом (ADR-070).
      tier: 'stable',
      order: 100,
      load: () => 'текст',
    };
    // Провайдер с запрещённым тиром всё равно остаётся объектом — проверка
    // уровня типов и есть контракт.
    expect(provider.key).toBe('plugin.demo.block');
  });
});

describe('контракт провайдера', () => {
  it('минимальный провайдер: key/tier/order/load', () => {
    const provider: PromptBlockProvider = {
      key: 'plugin.demo.memory',
      tier: 'context',
      order: 100,
      load: () => 'факты',
    };
    expect(provider.key).toBe('plugin.demo.memory');
    expect(provider.tier).toBe('context');
    expect(provider.order).toBe(100);
  });

  it('load может быть синхронным и асинхронным', async () => {
    const sync: PromptBlockProvider = { key: 'k1', tier: 'context', order: 1, load: () => 'a' };
    const asyncProvider: PromptBlockProvider = {
      key: 'k2',
      tier: 'volatile',
      order: 2,
      load: async () => 'b',
    };
    expect(await sync.load(makeCtx())).toBe('a');
    expect(await asyncProvider.load(makeCtx())).toBe('b');
  });

  it('load может вернуть расширенный объект (provenance/status)', async () => {
    const provider: PromptBlockProvider = {
      key: 'k3',
      tier: 'context',
      order: 3,
      load: () => ({ content: 'текст', provenance: 'plugin:demo', status: 'loaded' }),
    };
    const result = await provider.load(makeCtx());
    expect(result).toEqual({ content: 'текст', provenance: 'plugin:demo', status: 'loaded' });
  });

  it('пустой результат — null или пустая строка', async () => {
    const empty: PromptBlockProvider = { key: 'k4', tier: 'context', order: 4, load: () => null };
    expect(await empty.load(makeCtx())).toBeNull();
  });
});

describe('контекст вызова провайдера', () => {
  it('ходовые поля опциональны (шаг пайплайна, саб-агент)', () => {
    const ctx = makeCtx();
    expect(ctx.query).toBeUndefined();
    expect(ctx.turnId).toBeUndefined();
    expect(ctx.timestamp).toBeUndefined();
  });

  it('вопрос хода и метки хода задаются явно', () => {
    const ctx = makeCtx({ query: 'вопрос', turnId: 'stream-1', timestamp: '2026-10-22T00:00:00.000Z' });
    expect(ctx.query).toBe('вопрос');
    expect(ctx.turnId).toBe('stream-1');
    expect(ctx.timestamp).toBe('2026-10-22T00:00:00.000Z');
  });
});

describe('ключи плагинных блоков', () => {
  it('префикс plugin. распознаётся', () => {
    expect(PLUGIN_PROMPT_BLOCK_KEY_PREFIX).toBe('plugin.');
    expect(isPluginPromptBlockKey('plugin.demo.memory')).toBe(true);
    expect(isPluginPromptBlockKey('instructions')).toBe(false);
  });

  it('бюджет символов блока по умолчанию — 4000', () => {
    expect(DEFAULT_PROMPT_BLOCK_MAX_CHARS).toBe(4000);
  });
});
