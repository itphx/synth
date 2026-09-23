import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskTool } from './task.js';
import {
  runSubagentResume, validateSubagentResume,
} from './task-resume.js';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from './index.js';
import { BaseProvider, ProviderFactory } from '../../providers/base.js';
import type { CancellationToken, LLMMessage } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { AgentRegistry } from '../agents/registry.js';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, ProviderConfig } from '@itphx/synth-shared';

// ─────────────────────────────────────────────────────────────────────
// B1: Retry саб-агента при ошибках провайдера (taskTool)
// ─────────────────────────────────────────────────────────────────────

function makeMockAgentRegistry(): AgentRegistry {
  return {
    get: (id: string) => {
      if (id === 'explore') {
        return { id, agentMode: ['subagent'], subagentPrompt: 'You are a test subagent.', maxSteps: 1 };
      }
      return undefined;
    },
    getSubagents: () => [{ id: 'explore' }],
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

describe('taskTool retry — recoverable/unrecoverable/abort (B1)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-retry-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const FAST_RETRY = { maxRetries: 3, delaysMs: [10, 10, 10] };

  function makeCtx(extra: Record<string, unknown>, abortSignal?: AbortSignal) {
    return {
      sessionId: 's',
      messageId: 'm1',
      abortSignal: abortSignal ?? new AbortController().signal,
      workingDir: tmpDir,
      extra,
    };
  }

  it('recoverable ошибка: успех на 2-й попытке, tool_result нормальный, публикуется subagent.retry', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    let calls = 0;
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        calls++;
        if (calls === 1) throw new Error('fetch failed: ECONNREFUSED');
        yield { isFinal: true, content: 'готово со второй попытки', toolCalls: [] };
      }),
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await taskTool.execute(
      { description: 'flaky', prompt: 'hello', subagent_type: 'explore' },
      makeCtx({
        provider,
        sessionManager,
        eventBus,
        sessionId: parent.id,
        agentRegistry: makeMockAgentRegistry(),
        retry: FAST_RETRY,
        publish: (type: string, data: Record<string, unknown>) => events.push({ type, data }),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('готово со второй попытки');
    expect(provider.chatAsync).toHaveBeenCalledTimes(2);

    const retryEvent = events.find((e) => e.type === 'subagent.retry');
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data.attempt).toBe(1);
    expect(retryEvent!.data.max_retries).toBe(3);
    expect(retryEvent!.data.retry_in).toBe(10);
    expect(retryEvent!.data.error_type).toBe('network_error');
    expect(retryEvent!.data.child_session_id).toBe(result.metadata!.child_session_id);

    // Мусорных ERROR-сообщений в истории дочерней сессии нет — только финал
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    expect(child.messages.some((m) => m.metadata?.error === true)).toBe(false);
    expect(child.messages.some((m) => m.role === MessageRole.ASSISTANT && m.content.includes('готово со второй'))).toBe(true);
  });

  it('исчерпание ретраев: isError + metadata.attempts=3, две публикации subagent.retry, ERROR в истории ребёнка один', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: '' };
        throw new Error('503 Service Unavailable');
      }),
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await taskTool.execute(
      { description: 'down', prompt: 'hello', subagent_type: 'explore' },
      makeCtx({
        provider,
        sessionManager,
        eventBus,
        sessionId: parent.id,
        agentRegistry: makeMockAgentRegistry(),
        retry: FAST_RETRY,
        publish: (type: string, data: Record<string, unknown>) => events.push({ type, data }),
      }),
    );

    expect(result.isError).toBe(true);
    expect(provider.chatAsync).toHaveBeenCalledTimes(3);
    expect(result.content).toContain('<attempts>3</attempts>');
    expect(result.metadata!.attempts).toBe(3);
    expect(result.metadata!.max_retries).toBe(3);
    expect(result.metadata!.error_type).toBe('server_error');

    const retryEvents = events.filter((e) => e.type === 'subagent.retry');
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents.map((e) => e.data.attempt)).toEqual([1, 2]);

    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const errors = child.messages.filter((m) => m.metadata?.error === true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.metadata!.attempts).toBe(3);
  });

  it('unrecoverable ошибка (invalid api key): сразу финал, без ретраев и subagent.retry', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: '' };
        throw new Error('401 Unauthorized: invalid api key');
      }),
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await taskTool.execute(
      { description: 'auth', prompt: 'hello', subagent_type: 'explore' },
      makeCtx({
        provider,
        sessionManager,
        eventBus,
        sessionId: parent.id,
        agentRegistry: makeMockAgentRegistry(),
        retry: FAST_RETRY,
        publish: (type: string, data: Record<string, unknown>) => events.push({ type, data }),
      }),
    );

    expect(result.isError).toBe(true);
    expect(provider.chatAsync).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'subagent.retry')).toHaveLength(0);
    expect(result.metadata!.attempts).toBe(1);
    expect(result.metadata!.error_type).toBe('auth_error');
    expect(result.content).toContain('<attempts>1</attempts>');
  });

  it('abort во время backoff-паузы: отмена без второй попытки, tool_result — stopped_by_user', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: 'частичный текст до падения ' };
        throw new Error('network error: connection reset');
      }),
    };
    const ac = new AbortController();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const promise = taskTool.execute(
      { description: 'slow retry', prompt: 'hello', subagent_type: 'explore' },
      makeCtx({
        provider,
        sessionManager,
        eventBus,
        sessionId: parent.id,
        agentRegistry: makeMockAgentRegistry(),
        // Длинная backoff-пауза — отмена должна прервать её, не дожидаясь
        retry: { maxRetries: 3, delaysMs: [10_000, 10_000, 10_000] },
        publish: (type: string, data: Record<string, unknown>) => events.push({ type, data }),
      }, ac.signal),
    );

    // Ждём публикации subagent.retry (начался backoff), затем «Стоп»
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'subagent.retry')).toBe(true);
    }, { timeout: 3000 });
    ac.abort();

    const result = await promise;

    expect(provider.chatAsync).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.metadata!.stopped_by).toBe('user');
    expect(result.metadata!.interrupted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// B2: Resume прерванной/ошибочной дочерней сессии
// ─────────────────────────────────────────────────────────────────────

/** Успешный провайдер для resume: финальный ответ без tool-calls. */
class MockResumeOkProvider extends BaseProvider {
  constructor() {
    super({ url: '', apiKey: '', model: 'm', name: 'mockres', type: 'mockres' });
  }
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'RESUMED OK', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as import('@itphx/synth-shared').LLMResponse;
  }
  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { isFinal: true, content: 'RESUMED OK', toolCalls: [] } as import('@itphx/synth-shared').LLMChunk;
  }
  getProviderName(): string { return 'mockres'; }
}

/** Медленный провайдер: висит в стриме, пока не отменят. */
class MockResumeSlowProvider extends BaseProvider {
  constructor() {
    super({ url: '', apiKey: '', model: 'm', name: 'mockslow', type: 'mockslow' });
  }
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('not used');
  }
  async *chatAsync(_m?: unknown, _s?: unknown, _t?: unknown, _d?: unknown, ct?: CancellationToken): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { isFinal: false, content: 'работаю... ' } as import('@itphx/synth-shared').LLMChunk;
    for (let i = 0; i < 500; i++) {
      if (ct?.cancelled) return;
      yield { isFinal: false, content: `шаг-${i} ` } as import('@itphx/synth-shared').LLMChunk;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  getProviderName(): string { return 'mockslow'; }
}

describe('resume дочерней сессии саб-агента (B2)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;
  let orchestrator: ChatOrchestrator;
  let events: Array<{ sessionId: string; type: string; data: Record<string, unknown> }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-resume-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('mockres', MockResumeOkProvider);
    ProviderFactory.register('mockslow', MockResumeSlowProvider);
    events = [];
    // Перехват publish для сбора всех событий всех сессий
    const origPublish = eventBus.publish.bind(eventBus);
    eventBus.publish = ((sessionId: string, type: never, data: Record<string, unknown>) => {
      events.push({ sessionId, type, data });
      return origPublish(sessionId, type, data);
    }) as typeof eventBus.publish;

    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: {
        buildSystemPrompt: async () => 'system prompt',
        buildBaseBlocks: async () => [
          { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
        ],
      } as unknown as ContextBuilder,
      providerLoader: (name: string) => {
        return { name, type: name, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as ProviderConfig;
      },
      defaultWorkingDir: tmpDir,
      agentRegistry: makeMockAgentRegistry(),
      toolRegistry: createToolRegistry(),
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockres');
    ProviderFactory['_providers'].delete('mockslow');
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Родитель + дочерняя сессия саб-агента с оборванной историей. */
  async function createInterruptedChild(providerType = 'mockres'): Promise<{ parent: string; child: string }> {
    const parent = await sessionManager.createSession({
      title: 'Parent',
      settings: { provider: providerType, model: 'm' },
    });
    const child = await sessionManager.createSession({
      title: 'Subtask: analyse',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { provider: providerType, model: 'm', agentRole: 'explore' },
    });
    const userMsg: Message = {
      id: generateId(), role: MessageRole.USER, seq: 1, origin: 'local',
      parts: [makeTextPart('проанализируй код')], content: 'проанализируй код',
      createdAt: nowISO(), disabled: false, pinned: false, hidden: false,
    };
    const partialMsg: Message = {
      id: generateId(), role: MessageRole.ASSISTANT, seq: 2, origin: 'local',
      parts: [makeTextPart('начал анализ...')], content: 'начал анализ...',
      createdAt: nowISO(), disabled: false, pinned: false, hidden: false,
      metadata: { partial: true, interrupted: true },
    };
    const stopMarker: Message = {
      id: generateId(), role: MessageRole.INFO, seq: 3, origin: 'local',
      parts: [makeTextPart('Task stopped by the user')], content: 'Task stopped by the user',
      createdAt: nowISO(), disabled: false, pinned: false, hidden: false,
      metadata: { stopped_by: 'user', interrupted: true },
    };
    for (const m of [userMsg, partialMsg, stopMarker]) {
      await sessionManager.addMessage(child.id, m);
    }
    return { parent: parent.id, child: child.id };
  }

  it('validateSubagentResume: не найденная сессия → NOT_FOUND, без родителя → NO_PARENT', async () => {
    await expect(validateSubagentResume({ sessionManager }, 'missing-id'))
      .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    const orphan = await sessionManager.createSession({ title: 'Orphan' });
    await expect(validateSubagentResume({ sessionManager }, orphan.id))
      .rejects.toMatchObject({ code: 'NO_PARENT', httpStatus: 400 });
  });

  it('startSubagentResume: активная (заблокированная) сессия → LOCKED (409), двойной resume → LOCKED', async () => {
    const { child } = await createInterruptedChild();

    // Захватываем блокировку — имитация активной обработки
    const acquired = await sessionManager.acquireLock(child, 'other-process');
    expect(acquired).toBe(true);
    await expect(orchestrator.startSubagentResume(child))
      .rejects.toMatchObject({ code: 'LOCKED', httpStatus: 409 });
    await sessionManager.releaseLock(child, 'other-process');

    // Двойной resume: первый захватил лок, второй получает 409
    const first = await orchestrator.startSubagentResume(child);
    await expect(orchestrator.startSubagentResume(child))
      .rejects.toMatchObject({ code: 'LOCKED', httpStatus: 409 });
    // Останавливаем первый прогон
    orchestrator.cancel(first.stream_id);
    await vi.waitFor(async () => {
      const s = await sessionManager.getSession(child);
      expect(s?.status.blocked).toBeFalsy();
    }, { timeout: 5000 });
  });

  it('happy path: маркер resume в истории ребёнка, итог — в родителе, события опубликованы, лок снят', async () => {
    const { parent, child } = await createInterruptedChild();
    const eventsBefore = events.length;

    const started = await orchestrator.startSubagentResume(child);
    expect(started.status).toBe('started');
    expect(started.child_session_id).toBe(child);
    expect(started.parent_session_id).toBe(parent);

    // Ждём завершения фонового прогона: итоговое сообщение в родителе
    await vi.waitFor(async () => {
      const p = await sessionManager.getSession(parent);
      expect(p!.messages.some((m) => m.metadata?.type === 'subagent_resumed_result')).toBe(true);
    }, { timeout: 5000 });

    // Synthetic user-маркер в истории дочерней сессии
    const c = (await sessionManager.getSession(child))!;
    const marker = c.messages.find((m) => m.metadata?.resume === true);
    expect(marker).toBeDefined();
    expect(marker!.role).toBe(MessageRole.USER);
    expect(marker!.content).toContain('Resume the interrupted task');
    // Финальный ответ саб-агента сохранён в дочерней сессии
    expect(c.messages.some((m) => m.role === MessageRole.ASSISTANT && m.content === 'RESUMED OK')).toBe(true);

    // Итог в родительской сессии: INFO + metadata
    const p = (await sessionManager.getSession(parent))!;
    const resumeResultMsg = p.messages.find((m) => m.metadata?.type === 'subagent_resumed_result');
    expect(resumeResultMsg).toBeDefined();
    expect(resumeResultMsg!.role).toBe(MessageRole.INFO);
    expect(resumeResultMsg!.metadata!.child_session_id).toBe(child);
    expect(resumeResultMsg!.metadata!.resume_status).toBe('completed');
    expect(resumeResultMsg!.content).toContain('RESUMED OK');

    // События: resume.started у ребёнка, message.added/session.updated у родителя
    const newEvents = events.slice(eventsBefore);
    expect(newEvents.some((e) => e.sessionId === child && e.type === 'subagent.resume.started')).toBe(true);
    expect(newEvents.some((e) => e.sessionId === parent && e.type === 'message.added')).toBe(true);
    expect(newEvents.some((e) => e.sessionId === parent && e.type === 'session.updated')).toBe(true);
    expect(newEvents.some((e) => e.sessionId === child && e.type === 'subagent.resume.finished')).toBe(true);

    // Блокировка и currentStream сняты
    expect(c.status.blocked).toBeFalsy();
    expect(c.currentStream).toBeUndefined();
  });

  it('abort resume (orchestrator.cancel по stream_id): статус aborted, итог в родителе — resume_aborted', async () => {
    const { parent, child } = await createInterruptedChild('mockslow');

    const started = await orchestrator.startSubagentResume(child);
    // Даём стриму начаться (маркер resume записан → message.added у ребёнка),
    // затем «Стоп» — тем же путём, что POST /sessions/:id/abort
    await vi.waitFor(() => {
      expect(events.some((e) => e.sessionId === child && e.type === 'message.added')).toBe(true);
    }, { timeout: 5000 });
    orchestrator.cancel(started.stream_id);

    await vi.waitFor(async () => {
      const p = await sessionManager.getSession(parent);
      expect(p!.messages.some((m) => m.metadata?.type === 'subagent_resumed_result')).toBe(true);
    }, { timeout: 5000 });

    const p = (await sessionManager.getSession(parent))!;
    const resumeResultMsg = p.messages.find((m) => m.metadata?.type === 'subagent_resumed_result')!;
    expect(resumeResultMsg.metadata!.resume_status).toBe('aborted');
    const s = (await sessionManager.getSession(child))!;
    expect(s.status.blocked).toBeFalsy();
    expect(s.currentStream).toBeUndefined();
  });

  it('runSubagentResume напрямую: провайдер недоступен → failed, ошибка записана в родителя', async () => {
    const { parent, child } = await createInterruptedChild();
    // Сессия с несуществующим провайдером: getProvider вернёт null
    const result = await runSubagentResume(
      {
        sessionManager,
        eventBus,
        agentRegistry: makeMockAgentRegistry(),
        getProvider: () => null,
        getWorkingDir: async () => tmpDir,
      },
      { child: (await sessionManager.getSession(child))!, parent: (await sessionManager.getSession(parent))!, streamId: 'st-1', abortSignal: new AbortController().signal },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Provider is not configured');
    const p = (await sessionManager.getSession(parent))!;
    const resumeResultMsg = p.messages.find((m) => m.metadata?.type === 'subagent_resumed_result')!;
    expect(resumeResultMsg.metadata!.resume_status).toBe('failed');
  });

  it('LLMMessage-история resume содержит маркер последним user-сообщением', async () => {    const { parent, child } = await createInterruptedChild();
    let captured: LLMMessage[] = [];
    let capturedSystem = '';
    const provider = {
      model: 'm',
      name: 'mockres',
      chatAsync: vi.fn().mockImplementation(async function* (messages: LLMMessage[], systemPrompt: string) {
        captured = messages;
        capturedSystem = systemPrompt;
        yield { isFinal: true, content: 'ok', toolCalls: [] };
      }),
    };
    await runSubagentResume(
      {
        sessionManager,
        eventBus,
        agentRegistry: makeMockAgentRegistry(),
        getProvider: () => provider as never,
        getWorkingDir: async () => tmpDir,
      },
      { child: (await sessionManager.getSession(child))!, parent: (await sessionManager.getSession(parent))!, streamId: 'st-2', abortSignal: new AbortController().signal },
    );

    // AD-070 §1.5: system — вторым аргументом chatAsync, в messages system-сообщения нет.
    expect(capturedSystem).toBe('You are a test subagent.');
    expect(captured.some((m) => m.role === 'system')).toBe(false);
    // user(промпт) + assistant(частичный) + user(маркер resume)
    const roles = captured.map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles[roles.length - 1]).toBe('user');
    expect(captured[captured.length - 1]!.content).toContain('Resume the interrupted task');
    // Частичный ответ саб-агента в контексте
    expect(captured.some((m) => m.role === 'assistant' && m.content === 'начал анализ...')).toBe(true);
  });

  it('AD-071 §2.1 + AD-070: resume наследует MCP-скоуп и modelPriceLoader', async () => {
    const { parent, child } = await createInterruptedChild();
    let capturedMcp: string[] | undefined;
    const registry = {
      get: (id: string) => (id === 'explore'
        ? { id, agentMode: ['subagent'], subagentPrompt: 'p', maxSteps: 1 }
        : undefined),
      getSubagents: () => [{ id: 'explore' }],
      getToolsForAgent: (_id: string, mcp?: string[]) => {
        capturedMcp = mcp;
        return [];
      },
    } as unknown as AgentRegistry;

    const provider = {
      model: 'm',
      name: 'mockres',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: 'x', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        yield { isFinal: true, content: 'ok', toolCalls: [] };
      }),
    };
    const loadedModels: string[] = [];

    await runSubagentResume(
      {
        sessionManager,
        eventBus,
        agentRegistry: registry,
        mcpServers: ['srvA'],
        modelPriceLoader: (m: string) => {
          loadedModels.push(m);
          return null;
        },
        getProvider: () => provider as never,
        getWorkingDir: async () => tmpDir,
      },
      {
        child: (await sessionManager.getSession(child))!,
        parent: (await sessionManager.getSession(parent))!,
        streamId: 'st-3',
        abortSignal: new AbortController().signal,
      },
    );

    expect(capturedMcp).toEqual(['srvA']);
    expect(loadedModels.length).toBeGreaterThan(0);
  });
});
