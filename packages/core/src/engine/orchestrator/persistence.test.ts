/**
 * ADR-095 (шаг 6a): собственные тесты персистентности сообщений оркестратора.
 *
 * Контракты:
 *  - `resolveAssistantStatus` — единая точка `metadata.status` (ADR-070 §2.6):
 *    ни один путь сохранения не пропускает поле;
 *  - `saveAssistantMessage` — счётчики сессии, стоимость, secrets (ADR-036),
 *    статистика сабагентов, `message.added` (кроме `skipEvent`), promptMeta;
 *  - `persistToolChain` — реальные пары «assistant(toolCalls) + tool-результаты»,
 *    совместимые с `sessionMessagesToLlm` (нет осиротевших tool);
 *  - `joinAccumulatedTexts`, `getAssistantSecrets`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole } from '@itphx/synth-shared';
import type { BusEvent, Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { ObfuscationMapStore } from '../gateway/obfuscation-map-store.js';
import {
  resolveAssistantStatus,
  isAssistantMessageStatus,
  joinAccumulatedTexts,
  getAssistantSecrets,
  saveAssistantMessage,
  persistToolChain,
  type AssistantMessageStatus,
  type SaveAssistantMessageDeps,
} from './persistence.js';
import { sessionMessagesToLlm } from './prompt-info.js';
import { serializeMessage } from '../../server/serialize.js';

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  cacheReadTokens: 40,
  cacheWriteTokens: 20,
  reasoningTokens: 5,
};

describe('resolveAssistantStatus / isAssistantMessageStatus', () => {
  it('отмена приоритетнее любого i18n-ключа', () => {
    expect(resolveAssistantStatus(true, { i18n: { key: 'session.empty_response' } })).toBe('cancelled');
    expect(resolveAssistantStatus(true)).toBe('cancelled');
  });

  it('i18n-ключ отображается в статус (stopped/limit/error), прочее — completed', () => {
    const cases: Array<[string, AssistantMessageStatus]> = [
      ['session.stopped', 'stopped'],
      ['session.denied_blocked', 'stopped'],
      ['session.role_tool_blocked', 'stopped'],
      ['session.max_iterations', 'limit'],
      ['session.empty_response', 'error'],
      ['router.timeout', 'error'],
      ['router.network_error', 'error'],
      ['router.rate_limit_exceeded', 'error'],
      ['router.context_length_exceeded', 'error'],
      ['router.no_user_query', 'error'],
      ['router.escalation', 'completed'],
    ];
    for (const [key, status] of cases) {
      expect(resolveAssistantStatus(false, { i18n: { key } })).toBe(status);
    }
    expect(resolveAssistantStatus(false)).toBe('completed');
    expect(resolveAssistantStatus(false, { i18n: 'строка' })).toBe('completed');
  });

  it('валидация значения статуса (защита от произвольного metadata.status)', () => {
    expect(isAssistantMessageStatus('error')).toBe(true);
    expect(isAssistantMessageStatus('cancelled')).toBe(true);
    expect(isAssistantMessageStatus('bogus')).toBe(false);
    expect(isAssistantMessageStatus(undefined)).toBe(false);
    expect(isAssistantMessageStatus(42)).toBe(false);
  });
});

describe('joinAccumulatedTexts', () => {
  it('склеивает завершённые итерации с текущей, пропуская пустые/пробельные', () => {
    expect(
      joinAccumulatedTexts(
        [
          { text: 'первая', iteration: 0 },
          { text: '   ', iteration: 1 },
          { text: '', iteration: 2 },
          { text: 'третья', iteration: 3 },
        ],
        'текущая',
      ),
    ).toBe('первая\n\nтретья\n\nтекущая');
  });

  it('без накопленных текстов и без текущего — пустая строка', () => {
    expect(joinAccumulatedTexts([], '')).toBe('');
  });
});

describe('getAssistantSecrets (ADR-036)', () => {
  function store(impl: (sessionId: string) => Promise<Record<string, string>>): ObfuscationMapStore {
    return { get: impl } as unknown as ObfuscationMapStore;
  }

  it('возвращает только реально присутствующие в тексте плейсхолдеры', async () => {
    const secrets = await getAssistantSecrets(
      's1',
      'тут ⟦SYNTH_SECRET_1⟧ и снова ⟦SYNTH_SECRET_1⟧',
      store(async () => ({ '⟦SYNTH_SECRET_1⟧': 'sk-1', '⟦SYNTH_SECRET_2⟧': 'sk-2' })),
    );
    expect(secrets).toEqual({ '⟦SYNTH_SECRET_1⟧': 'sk-1' });
  });

  it('пустой текст, отсутствие store и пустая карта → {}', async () => {
    expect(await getAssistantSecrets('s1', '', store(async () => ({ '⟦SYNTH_SECRET_1⟧': 'x' })))).toEqual({});
    expect(await getAssistantSecrets('s1', '⟦SYNTH_SECRET_1⟧', null)).toEqual({});
    expect(await getAssistantSecrets('s1', '⟦SYNTH_SECRET_1⟧', store(async () => ({})))).toEqual({});
  });

  it('ошибка store не пробрасывается наружу', async () => {
    const failing = store(async () => {
      throw new Error('store unavailable');
    });
    await expect(getAssistantSecrets('s1', '⟦SYNTH_SECRET_1⟧', failing)).resolves.toEqual({});
  });
});

describe('saveAssistantMessage / persistToolChain', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  let debugCollector: DebugCollector;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-persist-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    debugCollector = new DebugCollector(false);
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<SaveAssistantMessageDeps> = {}): SaveAssistantMessageDeps {
    return {
      sessionManager,
      eventBus,
      obfMapStore: null,
      modelPriceLoader: null,
      ...overrides,
    };
  }

  async function newSession(settings: Record<string, unknown> = {}) {
    return sessionManager.createSession({ title: 'T', settings: settings as never });
  }

  it('пишет metadata.status, stream_id, события и накапливает счётчики сессии', async () => {
    const session = await newSession();

    const returned = await saveAssistantMessage(
      deps(), session.id, 'ответ', 'stream1', 'developer', USAGE, 'm', undefined,
      debugCollector, false, 'prov',
    );

    expect(returned).toBe('ответ');
    const updated = (await sessionManager.getSession(session.id))!;
    const saved = updated.messages[0]!;
    expect(saved).toMatchObject({
      role: MessageRole.ASSISTANT,
      content: 'ответ',
      agentRole: 'developer',
      provider: 'prov',
      model: 'm',
      metadata: { stream_id: 'stream1', status: 'completed' },
    });

    expect(updated.inputTokens).toBe(100);
    expect(updated.outputTokens).toBe(10);
    expect(updated.totalTokens).toBe(110);
    expect(updated.cacheReadTokens).toBe(40);
    expect(updated.cacheWriteTokens).toBe(20);
    expect(updated.reasoningTokens).toBe(5);
    expect(updated.cacheHitRate).toBeCloseTo(0.4, 12);

    const added = events.filter((e) => e.type === 'message.added');
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({ message_index: 0, role: MessageRole.ASSISTANT, content: 'ответ' });
  });

  it('явный metadataExtra.status приоритетнее вывода из i18n; невалидный — отбрасывается', async () => {
    const session = await newSession();

    await saveAssistantMessage(
      deps(), session.id, 'ошибка', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, undefined, undefined, undefined,
      { status: 'error', i18n: { key: 'router.rate_limit_exceeded' } },
    );
    await saveAssistantMessage(
      deps(), session.id, 'мусор', 'stream2', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, undefined, undefined, undefined,
      { status: 'bogus', i18n: { key: 'session.stopped' } },
    );

    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.messages[0]!.metadata!.status).toBe('error');
    expect(updated.messages[1]!.metadata!.status).toBe('stopped');
  });

  it('отмена: status=cancelled, стоимость по цене модели, reasonings, длительность', async () => {
    const session = await newSession();
    const modelPriceLoader = vi.fn(() => ({ inputPrice: 1, outputPrice: 2 }));

    await saveAssistantMessage(
      deps({ modelPriceLoader }), session.id, 'частичный', 'stream1', 'developer', USAGE, 'm', 'думал',
      debugCollector, true, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, undefined, undefined, undefined, { duration_ms: 42 },
    );

    const updated = (await sessionManager.getSession(session.id))!;
    const saved = updated.messages[0]!;
    expect(saved.metadata).toMatchObject({ status: 'cancelled', duration_ms: 42 });
    expect(saved.metadata!.cost_usd).toBeCloseTo((100 * 1 + 10 * 2) / 1_000_000, 12);
    expect(saved.reasoning).toBe('думал');
    expect(updated.inputCost).toBeCloseTo(100 / 1_000_000, 12);
    expect(updated.outputCost).toBeCloseTo(20 / 1_000_000, 12);
  });

  it('precomputedCost используется без пересчёта, cache-цены идут в счётчики сессии', async () => {
    const session = await newSession();
    const modelPriceLoader = vi.fn(() => ({ inputPrice: 1, cacheReadPrice: 0.5, cacheWritePrice: 1.5 }));

    await saveAssistantMessage(
      deps({ modelPriceLoader }), session.id, 'ответ', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { costUsd: 7, breakdown: { input: 1, output: 2, cacheRead: 3, cacheWrite: 1 }, currency: 'RUB' },
    );

    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.metadata).toMatchObject({ cost_usd: 7, cost_currency: 'RUB' });
    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.cacheReadCost).toBeCloseTo((40 * 0.5) / 1_000_000, 12);
    expect(updated.cacheWriteCost).toBeCloseTo((20 * 1.5) / 1_000_000, 12);
  });

  it('toolResults: metadata.tool_results + агрегат subagents; без task-результатов subagents нет', async () => {
    const session = await newSession();
    const taskResult = {
      name: 'task',
      result: {
        metadata: {
          child_session_id: 'child1',
          subagent_usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          subagent_model: 'sub',
        },
      },
    };

    await saveAssistantMessage(
      deps({ modelPriceLoader: () => ({ inputPrice: 1 }) }), session.id, 'ответ', 'stream1', undefined,
      USAGE, 'm', undefined, debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      [taskResult, { name: 'read_file', result: {} }],
    );

    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.metadata!.tool_results).toHaveLength(2);
    expect(saved.metadata!.subagents).toMatchObject({ sessions: 1, input_tokens: 7, output_tokens: 3 });
    expect(events.find((e) => e.type === 'message.added')!.data.tool_calls).toHaveLength(2);
  });

  it('intermediateTextBlocks и promptMeta (cachedTokens/validated) попадают в сообщение', async () => {
    const session = await newSession();

    await saveAssistantMessage(
      deps(), session.id, 'ответ', 'stream1', 'developer', USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, [{ text: 'промежуточный', iteration: 0 }], undefined, undefined, undefined,
      { agentRole: 'developer', generation: 2, expected: 'hit', cachedTokens: 0, validated: false },
    );

    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.metadata!.intermediate_text_blocks).toEqual([{ text: 'промежуточный', iteration: 0 }]);
    expect(saved.promptMeta).toEqual({
      agentRole: 'developer', generation: 2, expected: 'hit', cachedTokens: 40, validated: true,
    });
  });

  it('secrets: раскрытие плейсхолдеров только для role=ASSISTANT', async () => {
    const session = await newSession();
    const obfMapStore = new ObfuscationMapStore(sessionManager);
    await obfMapStore.set(session.id, { '⟦SYNTH_SECRET_1⟧': 'sk-secret' });

    await saveAssistantMessage(
      deps({ obfMapStore }), session.id, 'ключ ⟦SYNTH_SECRET_1⟧', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov',
    );
    await saveAssistantMessage(
      deps({ obfMapStore }), session.id, 'summary ⟦SYNTH_SECRET_1⟧', 'stream2', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.SUMMARY, [0], true,
    );

    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.messages[0]!.metadata!.secrets).toEqual({ '⟦SYNTH_SECRET_1⟧': 'sk-secret' });
    expect(updated.messages[1]!.metadata!.secrets).toBeUndefined();
    // skipEvent=true у summary — событие только одно (по assistant)
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(1);
  });

  it('skipEvent=true не публикует message.added', async () => {
    const session = await newSession();
    await saveAssistantMessage(
      deps(), session.id, 'ответ', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, true,
    );
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(0);
  });

  it('summaryOf/qa_pass/qa_reason/provided role сохраняются в сообщении (контракт модуля)', async () => {
    const session = await newSession();
    // Перехватываем ровно то сообщение, которое модуль передаёт в addMessage:
    // контракт модуля проверяем независимо от сериализации хранилища.
    let captured: Message | undefined;
    const intercepting = {
      addMessage: async (sessionId: string, message: Message) => {
        captured = message;
        return sessionManager.addMessage(sessionId, message);
      },
      withLock: <T>(sessionId: string, fn: (s: never) => Promise<T>) => sessionManager.withLock(sessionId, fn as never),
      saveSession: (s: never) => sessionManager.saveSession(s as never),
      getSession: (sessionId: string) => sessionManager.getSession(sessionId),
    } as unknown as SessionManager;

    await saveAssistantMessage(
      { sessionManager: intercepting, eventBus, obfMapStore: null, modelPriceLoader: null },
      session.id, 'итог', 'stream1', 'summary', USAGE, 'm', 'r',
      debugCollector, false, 'prov', MessageRole.SUMMARY, [1, 2], true,
      undefined, undefined, true, 'qc.all_passed',
    );

    expect(captured).toMatchObject({
      role: MessageRole.SUMMARY,
      summaryOf: [1, 2],
      qa_pass: true,
      qa_reason: 'qc.all_passed',
      reasoning: 'r',
    });

    // Round-trip через хранилище: персистятся role/summaryOf/reasoning и
    // QC-поля (qa_pass/qa_reason) — бейдж качества переживает перезагрузку.
    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.role).toBe(MessageRole.SUMMARY);
    expect(saved.summaryOf).toEqual([1, 2]);
    expect(saved.reasoning).toBe('r');
    expect(saved.qa_pass).toBe(true);
    expect(saved.qa_reason).toBe('qc.all_passed');
  });

  it('qa_pass/qa_reason персистятся в FileStore и отдаются serializeMessage (ADR-034)', async () => {
    const session = await newSession();
    await saveAssistantMessage(
      deps(), session.id, 'итог', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov', MessageRole.ASSISTANT, undefined, false,
      undefined, undefined, true, 'qc.all_passed',
    );

    // FileStore: поля переживают save → load.
    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.qa_pass).toBe(true);
    expect(saved.qa_reason).toBe('qc.all_passed');

    // Ответ API (GET /sessions/:id/messages) — сериализация отдаёт те же поля.
    const out = serializeMessage(saved, 0) as Record<string, unknown>;
    expect(out.qa_pass).toBe(true);
    expect(out.qa_reason).toBe('qc.all_passed');
  });

  it('сообщение без QC не получает qa-полей (без дефолтов)', async () => {
    const session = await newSession();
    await saveAssistantMessage(
      deps(), session.id, 'без qc', 'stream1', undefined, USAGE, 'm', undefined,
      debugCollector, false, 'prov',
    );

    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.qa_pass).toBeUndefined();
    expect(saved.qa_reason).toBeUndefined();
    const out = serializeMessage(saved, 0) as Record<string, unknown>;
    expect('qa_pass' in out).toBe(false);
    expect('qa_reason' in out).toBe(false);
  });

  it('persistToolChain: пары assistant(toolCalls)+tool совместимы с sessionMessagesToLlm', async () => {
    const session = await newSession();

    await persistToolChain(
      sessionManager, session.id, 'stream1', 'prov', 'developer', 'final-model',
      [
        { iteration: 0, calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { iteration: 1, calls: [{ id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
      ],
      [
        { iteration: 0, id: 'call_a', name: 'read_file', args: { file_path: 'a.ts' }, result: { content: 'содержимое', metadata: { i18n: { key: 'fsread.empty_directory' } } } },
        { iteration: 1, id: 'call_b', name: 'write_file', args: { file_path: 'b.ts' }, result: { content: 'готово' } },
      ],
      [{ text: 'думаю №1', iteration: 0 }, { text: 'думаю №2', iteration: 1 }],
      [{ text: 'reasoning №1', iteration: 0 }],
    );

    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.messages).toHaveLength(4);

    const [assistant0, tool0, assistant1, tool1] = updated.messages;
    expect(assistant0).toMatchObject({
      role: MessageRole.ASSISTANT,
      content: 'думаю №1',
      provider: 'prov',
      model: 'final-model',
      agentRole: 'developer',
      reasoning: 'reasoning №1',
      metadata: { stream_id: 'stream1', tool_chain: true },
    });
    expect(assistant0!.toolCalls).toHaveLength(1);
    expect(tool0).toMatchObject({
      role: MessageRole.TOOL,
      content: 'содержимое',
      toolCallId: 'call_a',
      metadata: { stream_id: 'stream1', tool_chain: true, tool_name: 'read_file', args: { file_path: 'a.ts' } },
    });
    // metadata ToolResult (в т.ч. i18n) пробрасывается в metadata сообщения
    expect(tool0!.metadata!.i18n).toEqual({ key: 'fsread.empty_directory' });
    expect(assistant1!.reasoning).toBeUndefined();
    expect(tool1!.toolCallId).toBe('call_b');

    // Инвариант: сохранённая история даёт валидный OpenAI-совместимый диалог
    const llm = sessionMessagesToLlm(updated.messages, 'developer', updated.userId);
    expect(llm.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(llm[0]!.toolUse).toHaveLength(1);
    expect(llm[1]!.toolCallId).toBe('call_a');
    expect(llm[3]!.toolCallId).toBe('call_b');
  });

  it('persistToolChain: итерация без tool-результатов сохраняет только assistant', async () => {
    const session = await newSession();
    await persistToolChain(
      sessionManager, session.id, 'stream1', 'prov', 'developer', 'm',
      [{ iteration: 0, calls: [{ id: 'call_a', function: { name: 'read_file' } }] }],
      [],
      [],
      [],
    );

    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]!.metadata!.tool_chain).toBe(true);
    expect(updated.messages[0]!.content).toBe('');
  });

  it('пустой tool-chain ничего не пишет', async () => {
    const session = await newSession();
    await persistToolChain(sessionManager, session.id, 's', 'p', undefined, undefined, [], [], [], []);
    expect((await sessionManager.getSession(session.id))!.messages).toHaveLength(0);
  });
});

describe('saveAssistantMessage — debug-коллектор', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-persist-dbg-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('сырой ответ модели не попадает в debug при отмене', async () => {
    const collectRaw = vi.fn();
    const collector = { enabled: false, captureRawModelResponse: collectRaw, captureReasoning: vi.fn(), getDebugInfo: () => null } as unknown as DebugCollector;

    const cancelled = await sessionManager.createSession({ title: 'C' });
    await saveAssistantMessage(
      { sessionManager, eventBus: new EventBus(), obfMapStore: null, modelPriceLoader: null },
      cancelled.id, 'частичный', 's1', undefined, USAGE, 'm', undefined,
      collector, true, 'prov',
    );
    expect(collectRaw).not.toHaveBeenCalled();

    const normal = await sessionManager.createSession({ title: 'N' });
    await saveAssistantMessage(
      { sessionManager, eventBus: new EventBus(), obfMapStore: null, modelPriceLoader: null },
      normal.id, 'полный', 's2', undefined, USAGE, 'm', undefined,
      collector, false, 'prov',
    );
    expect(collectRaw).toHaveBeenCalledWith('полный');
  });

  it('debugData попадает в сообщение, если коллектор включён', async () => {
    const collector = new DebugCollector(true);
    collector.captureRawModelResponse('ответ');
    const session = await sessionManager.createSession({ title: 'N' });

    await saveAssistantMessage(
      { sessionManager, eventBus: new EventBus(), obfMapStore: null, modelPriceLoader: null },
      session.id, 'ответ', 's1', undefined, USAGE, 'm', undefined, collector, false, 'prov',
    );

    const saved = (await sessionManager.getSession(session.id))!.messages[0]!;
    expect(saved.debugData).toMatchObject({ raw_model_response: 'ответ' });
  });
});
