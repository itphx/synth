/**
 * ADR-095 (шаг 6b-1): собственные тесты фазы `runProcessEarly` — ранние выходы
 * `_processMessage` (системные сообщения, `/`-команды, micro-first).
 *
 * Контракты:
 *  - порядок проверок: системное сообщение → `/`-команда → micro-first → LLM;
 *  - возврат `null` = «продолжаем обычный путь»; непустой результат вызывающий
 *    обязан вернуть как есть;
 *  - micro-first: события стрима, сохранение ответа и токенов, авто-тайтл,
 *    метрики decision-уровня (ADR-084), фоллбек-сигналы в debug-контексте.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { DecisionConfig, Message, Session } from '@itphx/synth-shared';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { DebugCollector } from '../../../debug.js';
import { t as sm } from '../../system-messages.js';
import type { PermissionEvaluator } from '../../permission/evaluator.js';
import type { MicroPipeline } from '../../router/micro/index.js';
import { runProcessEarly, type ProcessEarlyArgs, type ProcessEarlyDeps } from './process-early.js';

const USER_MESSAGE_CONTENT = 'привет';

function makeMessage(overrides: Partial<Message> & { role: MessageRole }): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    content: USER_MESSAGE_CONTENT,
    parts: [makeTextPart(USER_MESSAGE_CONTENT)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: 'stream1' },
    ...overrides,
  };
}

function handledMicro(overrides: Record<string, unknown> = {}) {
  return {
    handled: true,
    microResult: {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'greeting',
      confidence: 0.95,
      answer: 'Привет! Как я могу помочь?',
      i18nKey: 'micro.greeting',
      usage: { inputTokens: 3, outputTokens: 4 },
      latencyMs: 7,
      signals: ['rules'],
      ...overrides,
    },
  };
}

describe('runProcessEarly', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let debugCollector: DebugCollector;
  let published: Array<{ event: string; data: Record<string, unknown> }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-early-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    debugCollector = new DebugCollector(true);
    published = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<ProcessEarlyDeps> = {}): ProcessEarlyDeps {
    return {
      handleSummarization: vi.fn(async () => ({})) as never,
      handleDebugSystemMessage: vi.fn(async () => ({})) as never,
      handleCommand: vi.fn(async () => null) as never,
      microPipeline: null,
      decisionConfig: null,
      publishLocalCompletion: vi.fn(),
      sessionManager,
      ...overrides,
    };
  }

  function args(session: Session, message: Message, overrides: Partial<ProcessEarlyArgs> = {}): ProcessEarlyArgs {
    return {
      session,
      message,
      signal: new AbortController().signal,
      publishChunk: (event, data) => published.push({ event, data }),
      debugCollector,
      streamId: 'stream1',
      effectiveAgentRole: session.settings.agentRole,
      effectiveReasoningLevel: 'medium',
      workingDir: tmpDir,
      attempt: undefined,
      permissionEvaluator: {} as PermissionEvaluator,
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
      streamStartedAt: Date.now() - 5,
      ...overrides,
    };
  }

  /** Сессия с одним пользовательским сообщением (как перед первым ходом). */
  async function sessionWithUserMessage(settings: Record<string, unknown> = {}) {
    const created = await sessionManager.createSession({ title: 'E', settings: settings as never });
    const userMessage = makeMessage({ role: MessageRole.USER });
    const session = (await sessionManager.addMessage(created.id, userMessage))!;
    return { session, userMessage };
  }

  it('SYSTEM summarization_request → handleSummarization с теми же аргументами, остальные ветки не трогаются', async () => {
    const { session } = await sessionWithUserMessage();
    const message = makeMessage({ role: MessageRole.SYSTEM, content: 'sum', metadata: { type: 'summarization_request' } });
    const d = deps();
    const signal = new AbortController().signal;
    const publishChunk = () => {};

    const result = await runProcessEarly(
      args(session, message, { signal, publishChunk, attempt: 2 }), d,
    );

    expect(result).toEqual({});
    expect(d.handleSummarization).toHaveBeenCalledWith(session, message, signal, publishChunk, debugCollector, 'stream1', 2);
    expect(d.handleDebugSystemMessage).not.toHaveBeenCalled();
    expect(d.handleCommand).not.toHaveBeenCalled();
  });

  it('SYSTEM debug_system_message → handleDebugSystemMessage с уровнем размышлений', async () => {
    const { session } = await sessionWithUserMessage();
    const message = makeMessage({ role: MessageRole.SYSTEM, content: 'dbg', metadata: { type: 'debug_system_message' } });
    const d = deps();

    await runProcessEarly(args(session, message), d);

    expect(d.handleDebugSystemMessage).toHaveBeenCalledWith(
      session, message, expect.anything(), expect.any(Function), debugCollector, 'stream1', 'medium', undefined,
    );
    expect(d.handleSummarization).not.toHaveBeenCalled();
  });

  it('SYSTEM-сообщение другого типа игнорируется (идём обычным путём)', async () => {
    const { session } = await sessionWithUserMessage();
    const d = deps();
    const result = await runProcessEarly(
      args(session, makeMessage({ role: MessageRole.SYSTEM, content: 'x', metadata: { type: 'other' } })), d,
    );

    expect(result).toBeNull();
    expect(d.handleSummarization).not.toHaveBeenCalled();
    expect(d.handleDebugSystemMessage).not.toHaveBeenCalled();
  });

  it('/-команда с локальным ответом прерывает путь: micro-first не вызывается', async () => {
    const { session } = await sessionWithUserMessage();
    const message = makeMessage({ role: MessageRole.USER, content: '/help' });
    const microHandle = vi.fn();
    const d = deps({
      handleCommand: vi.fn(async () => ({ error: undefined })) as never,
      microPipeline: { handle: microHandle } as unknown as MicroPipeline,
    });

    const result = await runProcessEarly(args(session, message), d);

    expect(result).toEqual({ error: undefined });
    expect(microHandle).not.toHaveBeenCalled();
    // Аргументы резолвинга команды
    expect(d.handleCommand).toHaveBeenCalledWith(expect.objectContaining({
      session, message, streamId: 'stream1', effectiveAgentRole: session.settings.agentRole,
      sessionMode: 'act', planMode: 'auto', planApproved: false,
    }));
  });

  it('prompt-команда (handleCommand → null) продолжает путь обычным способом', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const message = makeMessage({ role: MessageRole.USER, content: '/init' });
    const microHandle = vi.fn(async () => ({ handled: false, microResult: null }));
    const d = deps({
      handleCommand: vi.fn(async () => null) as never,
      microPipeline: { handle: microHandle } as unknown as MicroPipeline,
    });

    const result = await runProcessEarly(args(session, message), d);

    expect(result).toBeNull();
    expect(d.handleCommand).toHaveBeenCalled();
    expect(microHandle).toHaveBeenCalled();
  });

  it('команда после пробелов в начале распознаётся (trimStart)', async () => {
    const { session } = await sessionWithUserMessage();
    const d = deps({ handleCommand: vi.fn(async () => ({})) as never });

    const result = await runProcessEarly(
      args(session, makeMessage({ role: MessageRole.USER, content: '   \n/help' })), d,
    );

    expect(result).toEqual({});
    expect(d.handleCommand).toHaveBeenCalled();
  });

  it('TOOL-сообщение не перехватывается командами/micro', async () => {
    const { session } = await sessionWithUserMessage();
    const d = deps({ microPipeline: { handle: vi.fn() } as unknown as MicroPipeline });

    const result = await runProcessEarly(
      args(session, makeMessage({ role: MessageRole.TOOL, content: 'результат' })), d,
    );

    expect(result).toBeNull();
    expect(d.handleCommand).not.toHaveBeenCalled();
  });

  it('micro-first: события стрима, ответ и токены сохраняются, авто-тайтл проставлен', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const message = makeMessage({ role: MessageRole.USER });
    const publishLocalCompletion = vi.fn();
    const d = deps({
      microPipeline: { handle: vi.fn(async () => handledMicro()) } as unknown as MicroPipeline,
      publishLocalCompletion,
    });

    const result = await runProcessEarly(args(session, message), d);

    expect(result).toEqual({});

    // 1. Завершение стрима без LLM: model=micro:<taskClass>, provider=micro
    expect(publishLocalCompletion).toHaveBeenCalledTimes(1);
    const opts = publishLocalCompletion.mock.calls[0]![3];
    expect(opts).toMatchObject({
      model: 'micro:small_talk',
      provider: 'micro',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(opts.durationMs).toBeGreaterThanOrEqual(0);

    // 2. Ответ ассистента персистится в историю (UI/GET messages)
    const stored = (await sessionManager.getSession(session.id))!;
    const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant).toMatchObject({
      content: 'Привет! Как я могу помочь?',
      model: 'micro:small_talk',
      provider: 'micro',
      agentRole: session.settings.agentRole,
      metadata: {
        stream_id: 'stream1',
        i18n: { key: 'micro.greeting' },
        micro_first: { label: 'greeting', confidence: 0.95, taskClass: 'small_talk', signals: ['rules'] },
      },
    });

    // 3. Авто-тайтл первого сообщения
    expect(stored.title).toBe(sm('session.dialog_title', { id: session.id.slice(0, 8) }));

    // 4. debug-контекст хода доступен через карточку сообщения
    expect(assistant.debugData).not.toBeNull();
  });

  it('micro-first: токены сессии учитываются', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const d = deps({
      microPipeline: { handle: vi.fn(async () => handledMicro()) } as unknown as MicroPipeline,
    });

    await runProcessEarly(args(session, makeMessage({ role: MessageRole.USER })), d);

    const stored = (await sessionManager.getSession(session.id))!;
    expect({
      input: stored.inputTokens,
      output: stored.outputTokens,
      total: stored.totalTokens,
    }).toEqual({ input: 3, output: 4, total: 7 });
  });

  it('micro-first: decision-сигнал попадает в debug-контекст (ADR-084)', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const decisionConfig = { model: 'clef-flash' } as unknown as DecisionConfig;
    const d = deps({
      decisionConfig,
      microPipeline: {
        handle: vi.fn(async () => handledMicro({ signals: ['decision:approve'], label: 'approve' })),
      } as unknown as MicroPipeline,
    });

    await runProcessEarly(args(session, makeMessage({ role: MessageRole.USER })), d);

    const stored = (await sessionManager.getSession(session.id))!;
    const assistant = stored.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.metadata!.micro_first).toMatchObject({
      decision: { label: 'approve', confidence: 0.95, model: 'clef-flash' },
    });
    expect(assistant.debugData).toMatchObject({
      extra_context: { decision: { where: 'micro', label: 'approve', model: 'clef-flash' } },
    });
  });

  it('micro-first фоллбек: null + debug-контекст с сигналами (decision_disabled отфильтрован)', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const d = deps({
      microPipeline: {
        handle: vi.fn(async () => ({
          handled: false,
          microResult: { status: 'UNSURE', taskClass: 'llm_task', confidence: 0.2, latencyMs: 3, signals: [] },
          fallbackSignals: ['decision_disabled', 'decision_low_confidence', 'keyword:coding'],
        })),
      } as unknown as MicroPipeline,
    });

    const result = await runProcessEarly(args(session, makeMessage({ role: MessageRole.USER })), d);

    expect(result).toBeNull();
    const info = debugCollector.getDebugInfo();
    expect(info).toMatchObject({
      extra_context: {
        micro_first: { status: 'fallback', taskClass: 'llm_task' },
        decision: { where: 'micro', status: 'fallback', signals: ['decision_low_confidence'] },
      },
    });
  });

  it('microFirst=false: микрослой не вызывается', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: false });
    const microHandle = vi.fn();
    const d = deps({ microPipeline: { handle: microHandle } as unknown as MicroPipeline });

    const result = await runProcessEarly(args(session, makeMessage({ role: MessageRole.USER })), d);

    expect(result).toBeNull();
    expect(microHandle).not.toHaveBeenCalled();
  });

  it('micro-first не отвечает, если answer пуст (handled=true без ответа)', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    const d = deps({
      microPipeline: {
        handle: vi.fn(async () => ({ handled: true, microResult: { status: 'OK', taskClass: 'small_talk', confidence: 0.9, latencyMs: 1, signals: [] } })),
      } as unknown as MicroPipeline,
    });

    const result = await runProcessEarly(args(session, makeMessage({ role: MessageRole.USER })), d);

    expect(result).toBeNull();
    expect((await sessionManager.getSession(session.id))!.messages).toHaveLength(1);
  });

  it('второй ход micro-first не переименовывает сессию', async () => {
    const { session } = await sessionWithUserMessage({ microFirst: true });
    await sessionManager.addMessage(session.id, makeMessage({ role: MessageRole.USER, content: 'второе' }));
    const fresh = (await sessionManager.getSession(session.id))!;
    const d = deps({
      microPipeline: { handle: vi.fn(async () => handledMicro()) } as unknown as MicroPipeline,
    });

    await runProcessEarly(args(fresh, makeMessage({ role: MessageRole.USER })), d);

    expect((await sessionManager.getSession(session.id))!.title).toBe('E');
  });
});
