/**
 * ADR-090: фильтры LLM-вызовов в `GatewayProvider`.
 *
 * Проверяются три фазы (`pre_request`, `post_response`, `embedding`), политика
 * вето (только доверенные), таймаут/сбой по `failMode`, аудит решений и
 * поведение при пустом реестре (регрессия: ничего не меняется).
 *
 * Мок-провайдер — по образцу `gateway-provider.test.ts` (статические
 * счётчики/перехватчики).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LLMGatewayConfig,
  LLMChunk,
  LLMResponse,
  TokenUsage,
  ProviderConfig as SharedProviderConfig,
  LlmCallFilter,
  LlmFilterInput,
  LlmFilterPhase,
  LlmFilterVerdict,
} from '@itphx/synth-shared';

import { BaseProvider, ProviderFactory, type CancellationToken, type LLMMessage } from '../../providers/base.js';
import { ProviderError } from '../../providers/exceptions.js';
import { ProviderPool } from '../router/provider-pool.js';
import {
  AuditLogger,
  GatewayProvider,
  LlmFilterRegistry,
  RateLimiter,
  type LlmFilterAuditEvent,
} from './index.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';
const USAGE: TokenUsage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };

/** Мок-провайдер: фиксирует вызовы chat/embed. */
class MockFilterProvider extends BaseProvider {
  static chatCalls = 0;
  static embedCalls = 0;
  static embedTexts: string[] = [];
  static embedError: Error | null = null;
  static responseContent = 'ответ модели';

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<LLMResponse> {
    MockFilterProvider.chatCalls++;
    return { content: MockFilterProvider.responseContent, model: this.model, usage: USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    MockFilterProvider.chatCalls++;
    yield { content: MockFilterProvider.responseContent, isFinal: true, model: this.model, usage: USAGE };
  }

  async embed(text: string): Promise<number[]> {
    MockFilterProvider.embedCalls++;
    MockFilterProvider.embedTexts.push(text);
    if (MockFilterProvider.embedError) throw MockFilterProvider.embedError;
    return [0.1, 0.2];
  }

  getProviderName(): string {
    return 'mockflt';
  }
}

function makeConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 100, providerPerMinute: 100 },
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

/** Фильтр-заглушка: заданная функция `inspect` + метаданные. */
function makeFilter(
  id: string,
  phase: LlmFilterPhase,
  inspect: (input: LlmFilterInput) => LlmFilterVerdict | Promise<LlmFilterVerdict>,
  extra: Partial<LlmCallFilter> = {},
): LlmCallFilter {
  return { id, phase, inspect, ...extra };
}

describe('GatewayProvider × llmFilters (ADR-090)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gwfilter-'));
    MockFilterProvider.chatCalls = 0;
    MockFilterProvider.embedCalls = 0;
    MockFilterProvider.embedTexts = [];
    MockFilterProvider.embedError = null;
    MockFilterProvider.responseContent = 'ответ модели';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeGateway(opts: {
    config?: Partial<LLMGatewayConfig>;
    registry?: LlmFilterRegistry;
    defaultTimeoutMs?: number;
  } = {}) {
    const inner = new MockFilterProvider({ url: 'http://mock', apiKey: 'k', model: 'm' });
    const audit = new AuditLogger(join(tmpDir, 'audit.jsonl'));
    const auditSpy = vi.spyOn(audit, 'append');
    const registry = opts.registry
      ?? new LlmFilterRegistry(
        opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {},
      );
    let map: Record<string, string> = {};
    const gw = new GatewayProvider(inner, makeConfig(opts.config), {
      getMap: async () => ({ ...map }),
      saveMap: async (m) => {
        map = { ...m };
      },
      getAudit: () => audit,
      getRateLimiter: () => new RateLimiter(100, 100),
      sessionId: 's1',
      userId: 'u1',
      filters: registry,
    });
    return { gw, inner, registry, auditSpy };
  }

  /** Записи аудита типа `plugin_filter`. */
  function filterEntries(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((entry) => entry.type === 'plugin_filter');
  }

  describe('фаза pre_request', () => {
    it('deny доверенного фильтра: провайдер НЕ вызван, причина в аудите и в ответе', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:dlp:block', 'pre_request', () => ({ verdict: 'deny', reason: 'DLP: запрещено' })),
        { trustLevel: 'trusted', pluginName: 'dlp' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(0);
      expect(res.content).toContain('denied by an extension filter');
      expect(res.content).toContain('DLP: запрещено');

      const entries = filterEntries(auditSpy);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'plugin_filter',
        filterId: 'plugin:dlp:block',
        filterPhase: 'pre_request',
        filterTrust: 'trusted',
        filterVerdict: 'deny',
        filterEffectiveVerdict: 'deny',
        filterCode: 'plugin_filter.denied',
      });
      // Текст запроса в аудит не пишется
      expect(JSON.stringify(entries[0])).not.toContain('привет');
    });

    it('allow: провайдер вызван, в аудите вердикт allow', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:watch:allow', 'pre_request', () => ({ verdict: 'allow' })),
        { trustLevel: 'trusted', pluginName: 'watch' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
      expect(res.content).toBe('ответ модели');
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.allowed',
        filterVerdict: 'allow',
        filterEffectiveVerdict: 'allow',
      });
    });

    it('фильтр видит уже обфусцированные сообщения (после input guard)', async () => {
      const { gw, registry } = makeGateway();
      let seen: LlmFilterInput | null = null;
      registry.register(
        makeFilter('plugin:watch:see', 'pre_request', (input) => {
          seen = input;
          return { verdict: 'allow' };
        }),
        { trustLevel: 'trusted' },
      );

      await gw.chat([makeMessage(`ключ ${SK_KEY}`)], `система ${SK_KEY}`);

      expect(seen).not.toBeNull();
      const captured = seen as unknown as LlmFilterInput;
      expect(captured.phase).toBe('pre_request');
      expect(captured.provider).toBe('mockflt');
      expect(captured.sessionId).toBe('s1');
      expect(captured.messages?.[0]?.content).toContain('⟦SYNTH_SECRET_1⟧');
      expect(captured.messages?.[0]?.content).not.toContain('sk-');
      expect(captured.systemPrompt).toContain('⟦SYNTH_SECRET_1⟧');
    });

    it('community-deny понижается хостом до allow: провайдер вызван, событие в журнале плагинов', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      const onAudit = vi.fn<(event: LlmFilterAuditEvent) => void>();
      registry.register(
        makeFilter('plugin:community:block', 'pre_request', () => ({ verdict: 'deny', reason: 'хочу блок' })),
        { trustLevel: 'community', pluginName: 'community', onAudit },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
      expect(res.content).toBe('ответ модели');

      const entry = filterEntries(auditSpy)[0];
      expect(entry).toMatchObject({
        filterCode: 'plugin_filter.deny_downgraded',
        filterVerdict: 'deny',
        filterEffectiveVerdict: 'allow',
        filterDowngraded: true,
        filterTrust: 'community',
      });

      // Журнал плагинов (действие `filter`) — код понижения
      expect(onAudit).toHaveBeenCalledTimes(1);
      expect(onAudit.mock.calls[0]![0]).toMatchObject({
        filterId: 'plugin:community:block',
        phase: 'pre_request',
        verdict: 'deny',
        effectiveVerdict: 'allow',
        downgraded: true,
        code: 'plugin_filter.deny_downgraded',
      });
    });

    it('redact в pre_request не реализован: вердикт отклоняется, провайдер вызван', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:anon:redact', 'pre_request', () => ({
          verdict: 'redact',
          redactedContent: 'иное',
        })),
        { trustLevel: 'trusted' },
      );

      await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterVerdict: 'redact',
        filterEffectiveVerdict: 'ignored',
        filterCode: 'plugin_filter.redact_unsupported',
      });
    });

    it('таймаут при failMode=closed: провайдер НЕ вызван, причина в ответе', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter(
          'plugin:slow:block',
          'pre_request',
          () => new Promise<LlmFilterVerdict>((resolve) => setTimeout(() => resolve({ verdict: 'allow' }), 200)),
          { timeoutMs: 5 },
        ),
        { trustLevel: 'trusted' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(0);
      expect(res.content).toContain('extension filter unavailable');
      expect(res.content).toContain('plugin_filter.timeout');
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.unavailable',
        filterEffectiveVerdict: 'deny',
        reason: 'plugin_filter.timeout',
      });
    });

    it('таймаут при failMode=open: провайдер вызван, факт в аудите', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter(
          'plugin:slow:watch',
          'pre_request',
          () => new Promise<LlmFilterVerdict>((resolve) => setTimeout(() => resolve({ verdict: 'deny' }), 200)),
          { timeoutMs: 5, failMode: 'open' },
        ),
        { trustLevel: 'trusted' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
      expect(res.content).toBe('ответ модели');
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.unavailable',
        filterEffectiveVerdict: 'allow',
        reason: 'plugin_filter.timeout',
      });
    });

    it('сбой (throw) при failMode=closed: провайдер НЕ вызван', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:broken:block', 'pre_request', () => {
          throw new Error('boom');
        }),
        { trustLevel: 'trusted', failMode: 'closed' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(0);
      expect(res.content).toContain('extension filter unavailable');
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.unavailable',
        reason: 'plugin_filter.error',
      });
    });

    it('сбой (throw) при failMode=open: провайдер вызван', async () => {
      const { gw, registry } = makeGateway();
      registry.register(
        makeFilter('plugin:broken:watch', 'pre_request', () => {
          throw new Error('boom');
        }),
        { trustLevel: 'community' },
      );

      await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
    });

    it('стрим: deny → warning-чанки, провайдер НЕ вызван', async () => {
      const { gw, registry } = makeGateway();
      registry.register(
        makeFilter('plugin:dlp:block', 'pre_request', () => ({ verdict: 'deny', reason: 'DLP' })),
        { trustLevel: 'trusted' },
      );

      const chunks: string[] = [];
      for await (const chunk of gw.chatAsync([makeMessage('привет')])) {
        chunks.push(chunk.content);
      }

      expect(MockFilterProvider.chatCalls).toBe(0);
      expect(chunks.join('')).toContain('denied by an extension filter');
    });

    it('порядок обхода — порядок регистрации (первый deny останавливает)', async () => {
      const { gw, registry } = makeGateway();
      const order: string[] = [];
      registry.register(
        makeFilter('plugin:a:first', 'pre_request', () => {
          order.push('a');
          return { verdict: 'allow' };
        }),
        { trustLevel: 'trusted' },
      );
      registry.register(
        makeFilter('plugin:b:second', 'pre_request', () => {
          order.push('b');
          return { verdict: 'deny', reason: 'b' };
        }),
        { trustLevel: 'trusted' },
      );
      registry.register(
        makeFilter('plugin:c:third', 'pre_request', () => {
          order.push('c');
          return { verdict: 'allow' };
        }),
        { trustLevel: 'trusted' },
      );

      await gw.chat([makeMessage('привет')]);

      expect(order).toEqual(['a', 'b']);
      expect(MockFilterProvider.chatCalls).toBe(0);
    });
  });

  describe('фаза post_response', () => {
    it('фильтр видит полный текст и usage, ответ НЕ изменён, событие в аудите', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      let seen: LlmFilterInput | null = null;
      registry.register(
        makeFilter('plugin:ml:observe', 'post_response', (input) => {
          seen = input;
          return { verdict: 'allow' };
        }),
        { trustLevel: 'trusted', pluginName: 'ml' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(res.content).toBe('ответ модели');
      const captured = seen as unknown as LlmFilterInput;
      expect(captured.phase).toBe('post_response');
      expect(captured.content).toBe('ответ модели');
      expect(captured.usage).toEqual(USAGE);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterPhase: 'post_response',
        filterCode: 'plugin_filter.allowed',
        filterVerdict: 'allow',
      });
    });

    it('deny/redact в post_response не блокируют и не переписывают ответ (только аудит)', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:dlp:deny', 'post_response', () => ({ verdict: 'deny', reason: 'DLP' })),
        { trustLevel: 'trusted' },
      );
      registry.register(
        makeFilter('plugin:anon:redact', 'post_response', () => ({
          verdict: 'redact',
          redactedContent: 'подменённый текст',
        })),
        { trustLevel: 'trusted' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(res.content).toBe('ответ модели');
      const entries = filterEntries(auditSpy);
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          filterCode: 'plugin_filter.buffering_required',
          filterEffectiveVerdict: 'ignored',
        });
      }
    });

    it('сбой фильтра ответа не влияет на вызов (ответ уже отдан)', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:broken:post', 'post_response', () => {
          throw new Error('boom');
        }),
        { trustLevel: 'trusted' },
      );

      const res = await gw.chat([makeMessage('привет')]);

      expect(res.content).toBe('ответ модели');
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.unavailable',
        filterEffectiveVerdict: 'allow',
      });
    });
  });

  describe('фаза embedding', () => {
    it('deny доверенного фильтра: `_inner.embed` НЕ вызван', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:dlp:emb', 'embedding', () => ({ verdict: 'deny', reason: 'DLP' })),
        { trustLevel: 'trusted' },
      );

      await expect(gw.embed('секретный корпус')).rejects.toBeInstanceOf(ProviderError);
      expect(MockFilterProvider.embedCalls).toBe(0);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterPhase: 'embedding',
        filterCode: 'plugin_filter.denied',
        filterEffectiveVerdict: 'deny',
      });
    });

    it('redact: эмбеддинг вызван с заменёнными текстами', async () => {
      const { gw, registry } = makeGateway();
      registry.register(
        makeFilter('plugin:pii:redact', 'embedding', () => ({
          verdict: 'redact',
          redactedTexts: ['[PII]'],
        })),
        { trustLevel: 'trusted' },
      );

      const vector = await gw.embed('Иван Иванов');

      expect(vector).toEqual([0.1, 0.2]);
      expect(MockFilterProvider.embedTexts).toEqual(['[PII]']);
    });

    it('несовпадение длины redactedTexts → deny (fail-closed)', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      registry.register(
        makeFilter('plugin:pii:broken', 'embedding', () => ({
          verdict: 'redact',
          redactedTexts: [],
        })),
        { trustLevel: 'trusted' },
      );

      await expect(gw.embed('Иван Иванов')).rejects.toBeInstanceOf(ProviderError);
      expect(MockFilterProvider.embedCalls).toBe(0);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterVerdict: 'redact',
        filterEffectiveVerdict: 'deny',
        filterCode: 'plugin_filter.redact_invalid',
      });
    });

    it('community-deny понижается до allow: эмбеддинг вызван', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      const onAudit = vi.fn<(event: LlmFilterAuditEvent) => void>();
      registry.register(
        makeFilter('plugin:community:emb', 'embedding', () => ({ verdict: 'deny' })),
        { trustLevel: 'community', onAudit },
      );

      await gw.embed('текст');

      expect(MockFilterProvider.embedCalls).toBe(1);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterCode: 'plugin_filter.deny_downgraded',
        filterDowngraded: true,
      });
      expect(onAudit).toHaveBeenCalledTimes(1);
    });

    it('allow: эмбеддинг идёт как есть, в аудите — вызов фильтра', async () => {
      const { gw, registry, auditSpy } = makeGateway();
      let seenTexts: readonly string[] | undefined;
      registry.register(
        makeFilter('plugin:watch:emb', 'embedding', (input) => {
          seenTexts = input.texts;
          return { verdict: 'allow' };
        }),
        { trustLevel: 'trusted' },
      );

      await gw.embed('текст');

      expect(seenTexts).toEqual(['текст']);
      expect(MockFilterProvider.embedTexts).toEqual(['текст']);
      expect(filterEntries(auditSpy)[0]).toMatchObject({
        filterPhase: 'embedding',
        filterCode: 'plugin_filter.allowed',
      });
    });

    it('gateway выключен → прежнее поведение: `_inner.embed` напрямую, фильтры не выполняются', async () => {
      const { gw, registry, auditSpy } = makeGateway({ config: { enabled: false } });
      const inspect = vi.fn(() => ({ verdict: 'deny' as const }));
      registry.register(makeFilter('plugin:dlp:emb', 'embedding', inspect), { trustLevel: 'trusted' });

      await gw.embed('текст');

      expect(MockFilterProvider.embedCalls).toBe(1);
      expect(inspect).not.toHaveBeenCalled();
      expect(filterEntries(auditSpy)).toHaveLength(0);
    });

    it('потребитель микро-слоя (ProviderPool) отдаёт провайдера, обёрнутого в Gateway — фильтр видит вызов', async () => {
      // EmbeddingModel зовёт `provider.embed` у провайдера из пула; пул
      // оборачивает его в GatewayProvider через фабрику — значит embedding-фаза
      // фильтров работает и на этом пути (инвариант 3: вызов через gateway).
      ProviderFactory.register('mockfltpool', MockFilterProvider);
      const registry = new LlmFilterRegistry();
      const inspect = vi.fn((input: LlmFilterInput) => {
        expect(input.texts).toEqual(['пул']);
        return { verdict: 'redact' as const, redactedTexts: ['[REDACTED]'] };
      });
      registry.register(makeFilter('plugin:dlp:pool', 'embedding', inspect), { trustLevel: 'trusted' });

      const audit = new AuditLogger(join(tmpDir, 'audit-pool.jsonl'));
      const loader = (name: string): SharedProviderConfig | null =>
        name === 'mockfltpool'
          ? ({
              name: 'mockfltpool',
              type: 'mockfltpool',
              baseUrl: 'http://mock',
              apiKey: 'k',
              defaultModel: 'm',
            } as unknown as SharedProviderConfig)
          : null;
      const pool = new ProviderPool(loader, makeConfig(), (inner) =>
        new GatewayProvider(inner, makeConfig(), {
          getMap: async () => ({}),
          saveMap: async () => {},
          getAudit: () => audit,
          getRateLimiter: () => new RateLimiter(100, 100),
          sessionId: '',
          userId: '',
          filters: registry,
        }),
      );

      const provider = pool.getProvider('mockfltpool', 'm');
      expect(provider).toBeInstanceOf(GatewayProvider);
      const vector = await provider!.embed('пул');

      expect(vector).toEqual([0.1, 0.2]);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(MockFilterProvider.embedTexts).toEqual(['[REDACTED]']);
    });
  });

  describe('регрессия: пустой реестр', () => {
    it('chat: поведение прежнее, записей plugin_filter нет', async () => {
      const { gw, auditSpy } = makeGateway();

      const res = await gw.chat([makeMessage('привет')]);

      expect(MockFilterProvider.chatCalls).toBe(1);
      expect(res.content).toBe('ответ модели');
      expect(filterEntries(auditSpy)).toHaveLength(0);
    });

    it('embed: прямой вызов inner, без фильтров', async () => {
      const { gw, auditSpy } = makeGateway();

      const vector = await gw.embed('текст');

      expect(vector).toEqual([0.1, 0.2]);
      expect(MockFilterProvider.embedTexts).toEqual(['текст']);
      expect(filterEntries(auditSpy)).toHaveLength(0);
    });

    it('после disposer фильтр не виден следующему вызову', async () => {
      const { gw, registry } = makeGateway();
      const dispose = registry.register(
        makeFilter('plugin:dlp:block', 'pre_request', () => ({ verdict: 'deny' })),
        { trustLevel: 'trusted' },
      );

      await gw.chat([makeMessage('первый')]);
      expect(MockFilterProvider.chatCalls).toBe(0);

      dispose();
      await gw.chat([makeMessage('второй')]);
      expect(MockFilterProvider.chatCalls).toBe(1);
    });
  });

  describe('бюджет времени по умолчанию (runtime-политика)', () => {
    it('setDefaultTimeoutMs меняет бюджет только последующих регистраций', async () => {
      const registry = new LlmFilterRegistry({ defaultTimeoutMs: 50 });
      expect(registry.defaultTimeoutMs).toBe(50);

      const first = registry.register(
        makeFilter('plugin:watch:first', 'pre_request', () => ({ verdict: 'allow' })),
        { trustLevel: 'trusted' },
      );
      expect(registry.get('plugin:watch:first')!.timeoutMs).toBe(50);

      registry.setDefaultTimeoutMs(2000);
      expect(registry.defaultTimeoutMs).toBe(2000);

      registry.register(
        makeFilter('plugin:watch:second', 'pre_request', () => ({ verdict: 'allow' })),
        { trustLevel: 'trusted' },
      );
      // Уже зарегистрированный фильтр сохраняет бюджет регистрации…
      expect(registry.get('plugin:watch:first')!.timeoutMs).toBe(50);
      // …новый получает актуальную политику.
      expect(registry.get('plugin:watch:second')!.timeoutMs).toBe(2000);

      first();
      expect(registry.size).toBe(1);
    });

    it('явный timeoutMs фильтра приоритетнее бюджета реестра', () => {
      const registry = new LlmFilterRegistry({ defaultTimeoutMs: 50 });
      registry.setDefaultTimeoutMs(2000);
      registry.register(
        makeFilter('plugin:watch:own', 'pre_request', () => ({ verdict: 'allow' }), {
          timeoutMs: 300,
        }),
        { trustLevel: 'trusted' },
      );
      expect(registry.get('plugin:watch:own')!.timeoutMs).toBe(300);
    });

    it('невалидный бюджет отклоняется (RangeError), текущий сохраняется', () => {
      const registry = new LlmFilterRegistry({ defaultTimeoutMs: 500 });
      expect(() => registry.setDefaultTimeoutMs(0)).toThrow(RangeError);
      expect(() => registry.setDefaultTimeoutMs(-1)).toThrow(RangeError);
      expect(() => registry.setDefaultTimeoutMs(Number.NaN)).toThrow(RangeError);
      expect(registry.defaultTimeoutMs).toBe(500);
    });
  });
});
