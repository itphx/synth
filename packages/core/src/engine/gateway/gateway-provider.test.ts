/**
 * Интеграционные юнит-тесты GatewayProvider (AD-036) — декоратор над BaseProvider.
 * Мок BaseProvider со статическими capture-перехватчиками (паттерн
 * security/integration.test.ts — MockIPIProvider).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMGatewayConfig, LLMChunk, LLMResponse } from '@synth/shared';

import { BaseProvider, type LLMMessage, type CancellationToken } from '../../providers/base.js';
import { AuditLogger, GatewayProvider, RateLimiter } from './index.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';

/** Мок-провайдер: фиксирует вход, возвращает настраиваемый контент. */
class MockCaptureProvider extends BaseProvider {
  static calls = 0;
  static capturedMessages: LLMMessage[] | null = null;
  static capturedSystemPrompt: string | null = null;
  static capturedTools: Record<string, unknown>[] | null = null;
  static responseContent = 'ok';

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<LLMResponse> {
    MockCaptureProvider.calls++;
    MockCaptureProvider.capturedMessages = messages;
    MockCaptureProvider.capturedSystemPrompt = systemPrompt ?? null;
    MockCaptureProvider.capturedTools = tools ?? null;
    return {
      content: MockCaptureProvider.responseContent,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    MockCaptureProvider.calls++;
    MockCaptureProvider.capturedMessages = messages;
    MockCaptureProvider.capturedSystemPrompt = systemPrompt ?? null;
    MockCaptureProvider.capturedTools = tools ?? null;
    yield {
      content: MockCaptureProvider.responseContent,
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockgw2';
  }
}

function makeConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
    ...overrides,
  };
}

function makeMessage(content: string): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
  };
}

describe('GatewayProvider (AD-036)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gwprov-'));
    MockCaptureProvider.calls = 0;
    MockCaptureProvider.capturedMessages = null;
    MockCaptureProvider.capturedSystemPrompt = null;
    MockCaptureProvider.capturedTools = null;
    MockCaptureProvider.responseContent = 'ok';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeGateway(opts: {
    config?: Partial<LLMGatewayConfig>;
    rateLimiter?: RateLimiter;
    initialMap?: Record<string, string>;
  } = {}) {
    const inner = new MockCaptureProvider({ url: 'http://mock', apiKey: 'k', model: 'm' });
    const audit = new AuditLogger(join(tmpDir, 'audit.jsonl'));
    const auditSpy = vi.spyOn(audit, 'append');
    let map = opts.initialMap ?? {};
    const rateLimiter = opts.rateLimiter ?? new RateLimiter(100, 100);
    const gw = new GatewayProvider(inner, makeConfig(opts.config), {
      getMap: async () => ({ ...map }),
      saveMap: async (m) => {
        map = { ...m };
      },
      getAudit: () => audit,
      getRateLimiter: () => rateLimiter,
      sessionId: 's1',
      userId: 'u1',
    });
    return { gw, inner, auditSpy, getMap: () => ({ ...map }) };
  }

  it('enabled + секрет: inner получает обфусцированные сообщения, в ответе плейсхолдер', async () => {
    const { gw, getMap } = makeGateway();
    MockCaptureProvider.responseContent = 'Подключение с ⟦SYNTH_SECRET_1⟧ установлено';

    const res = await gw.chat([makeMessage(`ключ ${SK_KEY}`)]);

    expect(MockCaptureProvider.calls).toBe(1);
    expect(MockCaptureProvider.capturedMessages?.[0]?.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(MockCaptureProvider.capturedMessages?.[0]?.content).not.toContain('sk-');
    // Ответ идёт как есть (деобфускация — в точках потребления)
    expect(res.content).toBe('Подключение с ⟦SYNTH_SECRET_1⟧ установлено');
    // Карта сохранена в сессию
    expect(getMap()['⟦SYNTH_SECRET_1⟧']).toBe(SK_KEY);
  });

  it('enabled + секрет: systemPrompt обфусцируется', async () => {
    const { gw } = makeGateway();

    await gw.chat([makeMessage('привет')], `системный промпт с ${SK_KEY}`);

    expect(MockCaptureProvider.capturedSystemPrompt).toContain('⟦SYNTH_SECRET_1⟧');
    expect(MockCaptureProvider.capturedSystemPrompt).not.toContain('sk-');
  });

  it('enabled=false → passthrough без изменений', async () => {
    const { gw } = makeGateway({ config: { enabled: false } });
    const msgs = [makeMessage(`ключ ${SK_KEY}`)];

    const res = await gw.chat(msgs, 'system');

    expect(MockCaptureProvider.calls).toBe(1);
    expect(MockCaptureProvider.capturedMessages).toEqual(msgs); // секрет не тронут
    expect(MockCaptureProvider.capturedSystemPrompt).toBe('system');
    expect(res.content).toBe('ok');
  });

  it('rate limit превышен → warning-ответ, inner НЕ вызван', async () => {
    const rateLimiter = new RateLimiter(1, 100);
    const { gw } = makeGateway({ rateLimiter });

    const first = await gw.chat([makeMessage('hi')]);
    expect(MockCaptureProvider.calls).toBe(1);
    expect(first.content).toBe('ok');

    const second = await gw.chat([makeMessage('hi again')]);
    expect(MockCaptureProvider.calls).toBe(1); // inner не вызван повторно
    expect(second.content).toContain('Rate limit');
  });

  it('block-режим → warning-ответ, inner НЕ вызван', async () => {
    const { gw } = makeGateway({ config: { inputMode: 'block' } });

    const res = await gw.chat([makeMessage(`мой ключ ${SK_KEY}`)]);

    expect(MockCaptureProvider.calls).toBe(0);
    expect(res.content).toContain('Обнаружены секреты');
    expect(res.content).not.toContain(SK_KEY);
  });

  it('block-режим в стриме → warning-чанки, inner НЕ вызван', async () => {
    const { gw } = makeGateway({ config: { inputMode: 'block' } });

    const chunks: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage(SK_KEY)])) {
      chunks.push(chunk.content);
    }

    expect(MockCaptureProvider.calls).toBe(0);
    expect(chunks.join('')).toContain('Обнаружены секреты');
  });

  it('стрим: чанки идут как есть, output guard на финальном собранном ответе', async () => {
    const { gw, auditSpy } = makeGateway();

    // Чанк без секрета — output guard не срабатывает
    MockCaptureProvider.responseContent = 'обычный ответ';
    const chunks1: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage('hi')])) {
      chunks1.push(chunk.content);
    }
    expect(chunks1).toEqual(['обычный ответ']); // чанки не модифицированы

    // Чанк с секретом → аудит output_guard
    MockCaptureProvider.responseContent = `здесь ключ ${SK_KEY}`;
    const chunks2: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage('hi2')])) {
      chunks2.push(chunk.content);
    }
    expect(chunks2).toEqual([`здесь ключ ${SK_KEY}`]); // чанки идут как есть
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'output_guard', reason: 'секреты в ответе модели' }),
    );
  });

  it('rate limit в стриме → warning-чанки, inner НЕ вызван', async () => {
    const rateLimiter = new RateLimiter(1, 100);
    const { gw } = makeGateway({ rateLimiter });

    await gw.chat([makeMessage('first')]);
    expect(MockCaptureProvider.calls).toBe(1);

    const chunks: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage('second')])) {
      chunks.push(chunk.content);
    }
    expect(MockCaptureProvider.calls).toBe(1); // inner не вызван
    expect(chunks.join('')).toContain('Rate limit');
  });
});
