/**
 * Интеграционные юнит-тесты GatewayProvider (ADR-036) — декоратор над BaseProvider.
 * Мок BaseProvider со статическими capture-перехватчиками (паттерн
 * security/integration.test.ts — MockIPIProvider).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMGatewayConfig, LLMChunk, LLMResponse } from '@itphx/synth-shared';

import { BaseProvider, resolveSystemPromptText, type LLMMessage, type CancellationToken } from '../../providers/base.js';
import { ProviderError, RateLimitError } from '../../providers/exceptions.js';
import { AuditLogger, GatewayProvider, RateLimiter } from './index.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';

/** Мок-провайдер: фиксирует вход, возвращает настраиваемый контент. */
class MockCaptureProvider extends BaseProvider {
  static calls = 0;
  static capturedMessages: LLMMessage[] | null = null;
  static capturedSystemPrompt: string | null = null;
  static capturedTools: Record<string, unknown>[] | null = null;
  static responseContent = 'ok';
  /** ADR-084: decision-путь. */
  static decideCalls = 0;
  static capturedState: unknown = null;

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<LLMResponse> {
    MockCaptureProvider.calls++;
    MockCaptureProvider.capturedMessages = messages;
    MockCaptureProvider.capturedSystemPrompt = resolveSystemPromptText(systemPrompt) ?? null;
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
    MockCaptureProvider.capturedSystemPrompt = resolveSystemPromptText(systemPrompt) ?? null;
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

  /** ADR-084: decision-путь — фиксируем state, отдаём типизированный ответ. */
  async decide(state: unknown): Promise<import('@itphx/synth-shared').DecisionResponse> {
    MockCaptureProvider.decideCalls++;
    MockCaptureProvider.capturedState = state;
    return {
      model: this.model,
      answers: { q1: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    };
  }
}

function makeConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
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

describe('GatewayProvider (ADR-036)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gwprov-'));
    MockCaptureProvider.calls = 0;
    MockCaptureProvider.capturedMessages = null;
    MockCaptureProvider.capturedSystemPrompt = null;
    MockCaptureProvider.capturedTools = null;
    MockCaptureProvider.responseContent = 'ok';
    MockCaptureProvider.decideCalls = 0;
    MockCaptureProvider.capturedState = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeGateway(opts: {
    config?: Partial<LLMGatewayConfig>;
    rateLimiter?: RateLimiter;
    initialMap?: Record<string, string>;
    payloadLogPath?: string;
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
      payloadLogPath: opts.payloadLogPath,
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
    expect(res.content).toContain('Secrets detected in the request');
    expect(res.content).not.toContain(SK_KEY);
  });

  it('block-режим в стриме → warning-чанки, inner НЕ вызван', async () => {
    const { gw } = makeGateway({ config: { inputMode: 'block' } });

    const chunks: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage(SK_KEY)])) {
      chunks.push(chunk.content);
    }

    expect(MockCaptureProvider.calls).toBe(0);
    expect(chunks.join('')).toContain('Secrets detected in the request');
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
      expect.objectContaining({ type: 'output_guard', reason: 'secrets in the model response' }),
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

  it('logPayloads + payloadLogPath: chat пишет полный лог (запрос после обфускации)', async () => {
    const payloadPath = join(tmpDir, 'payloads.jsonl');
    const { gw } = makeGateway({ config: { logPayloads: true }, payloadLogPath: payloadPath });
    MockCaptureProvider.responseContent = 'ответ';

    await gw.chat([makeMessage(`ключ ${SK_KEY}`)], 'система');

    const raw = await readFile(payloadPath, 'utf8');
    const entry = JSON.parse(raw.trim()) as {
      ts: string;
      sessionId: string;
      userId: string;
      provider: string;
      request: { messages: Array<{ content: string }>; systemPrompt?: string };
      response: { content: string; usage?: { inputTokens?: number } };
    };
    expect(entry.sessionId).toBe('s1');
    expect(entry.userId).toBe('u1');
    expect(entry.provider).toBe('mockgw2');
    // Запрос сохранён ПОСЛЕ обфускации — секрета в логе нет
    expect(entry.request.messages[0]?.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(entry.request.messages[0]?.content).not.toContain(SK_KEY);
    expect(entry.request.systemPrompt).toBe('система');
    expect(entry.response.content).toBe('ответ');
    expect(entry.response.usage?.inputTokens).toBe(1);
  });

  it('logPayloads + payloadLogPath: chatAsync пишет накопленный ответ', async () => {
    const payloadPath = join(tmpDir, 'payloads.jsonl');
    const { gw } = makeGateway({ config: { logPayloads: true }, payloadLogPath: payloadPath });
    MockCaptureProvider.responseContent = 'стрим-ответ';

    const chunks: string[] = [];
    for await (const chunk of gw.chatAsync([makeMessage('hi')])) {
      chunks.push(chunk.content);
    }
    expect(chunks.join('')).toBe('стрим-ответ');

    const raw = await readFile(payloadPath, 'utf8');
    const entry = JSON.parse(raw.trim()) as { response: { content: string } };
    expect(entry.response.content).toBe('стрим-ответ');
  });

  it('logPayloads выключен — полный лог НЕ пишется', async () => {
    const payloadPath = join(tmpDir, 'payloads.jsonl');
    const { gw } = makeGateway({ config: { logPayloads: false }, payloadLogPath: payloadPath });

    await gw.chat([makeMessage('hi')]);

    await expect(readFile(payloadPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('payloadLogPath не задан — полный лог НЕ пишется', async () => {
    const { gw } = makeGateway({ config: { logPayloads: true } });

    await gw.chat([makeMessage('hi')]);

    // Никаких файлов в tmpDir не создано (audit.jsonl тоже отсутствует — аудит не сработал)
    const entries = await readdir(tmpDir);
    expect(entries).toHaveLength(0);
  });

  it('chatAsync с финальным чанком полного контента НЕ дублирует ответ в payload (регрессия)', async () => {
    const payloadPath = join(tmpDir, 'payloads.jsonl');
    const { gw } = makeGateway({ config: { logPayloads: true }, payloadLogPath: payloadPath });

    // Реальный openai.ts: delta-чанки («т», «ест») + финальный чанк с ПОЛНЫМ контентом («тест»).
    const inner = gw as unknown as { _inner: MockCaptureProvider };
    const originalChatAsync = inner._inner.chatAsync.bind(inner._inner);
    inner._inner.chatAsync = async function* () {
      yield { content: 'т', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { content: 'ест', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { content: 'тест', isFinal: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };

    // Потребитель (оркестратор) обрабатывает финальный чанк заменой — контент не дублируется.
    let accumulated = '';
    for await (const chunk of gw.chatAsync([makeMessage('hi')])) {
      accumulated = chunk.isFinal && chunk.content ? chunk.content : accumulated + chunk.content;
    }
    expect(accumulated).toBe('тест');

    const raw = await readFile(payloadPath, 'utf8');
    const entry = JSON.parse(raw.trim()) as { response: { content: string } };
    expect(entry.response.content).toBe('тест');
    void originalChatAsync;
  });

  it('decide: guard обфусцирует секрет в state, аудит записан', async () => {
    const { gw, auditSpy, getMap } = makeGateway();

    const res = await gw.decide(`ключ ${SK_KEY}`, { q1: { type: 'noul' } });

    expect(MockCaptureProvider.decideCalls).toBe(1);
    expect(String(MockCaptureProvider.capturedState)).toContain('⟦SYNTH_SECRET_1⟧');
    expect(String(MockCaptureProvider.capturedState)).not.toContain('sk-');
    expect(getMap()['⟦SYNTH_SECRET_1⟧']).toBe(SK_KEY);
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'obfuscated' }));
    expect(res.answers.q1).toEqual({ type: 'noul', noul: 1 });
  });

  it('decide: state-объект обфусцируется и восстанавливается как объект', async () => {
    const { gw } = makeGateway();

    await gw.decide({ token: SK_KEY }, { q1: { type: 'noul' } });

    expect(MockCaptureProvider.capturedState).toEqual({ token: '⟦SYNTH_SECRET_1⟧' });
  });

  it('decide: block-режим → ProviderError, inner НЕ вызван', async () => {
    const { gw } = makeGateway({ config: { inputMode: 'block' } });

    await expect(gw.decide(`мой ключ ${SK_KEY}`, {})).rejects.toBeInstanceOf(ProviderError);
    expect(MockCaptureProvider.decideCalls).toBe(0);
  });

  it('decide: rate limit → RateLimitError, inner НЕ вызван', async () => {
    const rateLimiter = new RateLimiter(1, 100);
    const { gw } = makeGateway({ rateLimiter });

    await gw.chat([makeMessage('first')]);
    expect(MockCaptureProvider.calls).toBe(1);

    await expect(gw.decide('state', {})).rejects.toBeInstanceOf(RateLimitError);
    expect(MockCaptureProvider.decideCalls).toBe(0);
  });

  it('decide: enabled=false → guard no-op, state без обфускации', async () => {
    const { gw } = makeGateway({ config: { enabled: false } });

    await gw.decide(`ключ ${SK_KEY}`, {});

    expect(MockCaptureProvider.capturedState).toBe(`ключ ${SK_KEY}`);
  });
});
