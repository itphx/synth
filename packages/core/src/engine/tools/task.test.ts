import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskTool } from './task.js';
import { SessionManager } from '../../sessions/manager.js';
import { computeSessionStats } from '../../sessions/stats.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { ToolCapability, MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import type { ContextOptimizer } from '../context/optimizer.js';
import { createToolRegistry } from './index.js';

/** Минимальный тип для мока AgentRegistry — только поля, используемые в taskTool */
interface MockAgentDef {
  id: string;
  agentMode: string | string[];
  subagentPrompt?: string;
  maxSteps?: number;
}

interface MockAgentRegistry {
  get(id: string): MockAgentDef | undefined;
  getSubagents(): Array<{ id: string }>;
  getToolsForAgent(): Array<Record<string, never>>;
}

function makeMockChatAsync(content: string) {
  return vi.fn().mockReturnValue(
    (async function* () {
      yield { isFinal: true, content, toolCalls: [] };
    })(),
  );
}

function makeMockAgentRegistry(subagents: string[] = ['explore']): MockAgentRegistry {
  return {
    get: (id: string) => {
      if (subagents.includes(id)) {
        return {
          id,
          agentMode: ['subagent'],
          subagentPrompt: 'You are a test subagent.',
          maxSteps: 1,
        };
      }
      return undefined;
    },
    getSubagents: () => subagents.map(id => ({ id })),
    getToolsForAgent: () => [],
  };
}

function makeMockProvider(content = 'mock response') {
  return {
    chatAsync: makeMockChatAsync(content),
    model: 'test-model',
    name: 'test-provider',
  };
}

describe('taskTool — context modes', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-test-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMsg(content: string, role: MessageRole = MessageRole.USER): Message {
    return {
      id: generateId(),
      role,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  async function createParentWithMessages(): Promise<Session> {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    await sessionManager.addMessage(parent.id, makeMsg('Привет, система'));
    await sessionManager.addMessage(parent.id, makeMsg('Здравствуйте! Чем помочь?', MessageRole.ASSISTANT));
    await sessionManager.addMessage(parent.id, makeMsg('Напиши функцию sum'));
    await sessionManager.addMessage(parent.id, makeMsg('Вот функция sum:', MessageRole.ASSISTANT));
    await sessionManager.addMessage(parent.id, makeMsg('Добавь тесты'));
    return (await sessionManager.getSession(parent.id))!;
  }

  const baseCtx = {
    sessionId: 'test-session',
    messageId: 'test-message',
    abortSignal: new AbortController().signal,
    workingDir: '/tmp',
  };

  // ─── Zod-схема: параметры ─────────────────────────────────────────

  it('принимает context_mode: none', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'none',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_mode).toBe('none');
  });

  it('принимает context_mode: inherit', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'inherit',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_mode).toBe('inherit');
  });

  it('принимает context_mode: summary', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'summary',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_mode).toBe('summary');
  });

  it('принимает context_mode: last_n', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'last_n',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_mode).toBe('last_n');
  });

  it('принимает context_count', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'last_n',
      context_count: 8,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_count).toBe(8);
  });

  it('context_mode по умолчанию optional', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_mode).toBeUndefined();
  });

  it('context_count по умолчанию optional', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'last_n',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.context_count).toBeUndefined();
  });

  it('отклоняет невалидный context_mode', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'invalid_mode',
    });
    expect(result.success).toBe(false);
  });

  it('отклоняет context_count < 1', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'last_n',
      context_count: 0,
    });
    expect(result.success).toBe(false);
  });

  it('отклоняет context_count > 50', () => {
    const result = taskTool.parameters.safeParse({
      description: 'test',
      prompt: 'hello',
      subagent_type: 'explore',
      context_mode: 'last_n',
      context_count: 51,
    });
    expect(result.success).toBe(false);
  });

  // ─── Ошибка без провайдера ────────────────────────────────────────

  it('возвращает ошибку без provider в ctx.extra', async () => {
    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore' },
      { ...baseCtx, extra: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('provider or agent registry unavailable');
  });

  // ─── SessionManager: mode 'inherit' создаёт форк с сообщениями ─────

  it('inherit mode: child session содержит все сообщения родителя с origin=inherited', async () => {
    const parent = await createParentWithMessages();
    const parentMsgCount = parent.messages.length;

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'inherit' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata!.context_mode).toBe('inherit');
    const childSessionId = result.metadata!.child_session_id as string;
    expect(childSessionId).toBeDefined();

    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.sessionOrigin).toBe('subagent');
    // Все сообщения родителя скопированы + prompt + assistant ответ
    expect(child!.messages.length).toBeGreaterThanOrEqual(parentMsgCount);
    // Первое сообщение — inherited от родителя
    const firstInherited = child!.messages.find(m => m.origin === 'inherited');
    expect(firstInherited).toBeDefined();
    expect(firstInherited!.sourceMsgId).toBeDefined();
  });

  // ─── SessionManager: mode 'last_n' — последние N ──────────────────

  it('last_n mode с context_count=2 копирует 2 последних сообщения', async () => {
    const parent = await createParentWithMessages();
    // 5 сообщений: user, assistant, user, assistant, user

    const result = await taskTool.execute(
      {
        description: 'test', prompt: 'hello', subagent_type: 'explore',
        context_mode: 'last_n', context_count: 2,
      },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata!.context_mode).toBe('last_n');
    const childSessionId = result.metadata!.child_session_id as string;
    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    // Должно быть скопировано N сообщений (или чуть больше из-за assistant на границе)
    expect(child!.messages.length).toBeGreaterThanOrEqual(2);
    expect(child!.branchPoint).toBeDefined();
  });

  // ─── SessionManager: mode 'none' создаёт сессию без inherited-сообщений ──

  it('none mode: child session создаётся с parentId, без inherited сообщений', async () => {
    const parent = await createParentWithMessages();

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    const childSessionId = result.metadata!.child_session_id as string;
    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.sessionOrigin).toBe('subagent');
    // В none режиме не должно быть inherited сообщений
    const inherited = child!.messages.filter(m => m.origin === 'inherited');
    expect(inherited).toHaveLength(0);
  });

  // ─── SessionManager: mode 'summary' — fork + summarize ───────────

  it('summary mode: child session содержит forked сообщения + summary от contextOptimizer', async () => {
    const parent = await createParentWithMessages();
    const parentMsgCount = parent.messages.length;

    const mockSummaryContent = 'Краткое резюме диалога: пользователь попросил функцию sum и тесты для неё.';
    const mockContextOptimizer = {
      summarize: vi.fn().mockResolvedValue({
        id: 'summary-1',
        role: MessageRole.SUMMARY,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(mockSummaryContent)],
        content: mockSummaryContent,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        summaryOf: [0, 1, 2, 3, 4],
        metadata: { type: 'auto_summary' },
      }),
    } satisfies Pick<ContextOptimizer, 'summarize'>;

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'summary' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          contextOptimizer: mockContextOptimizer,
        } as unknown as Record<string, unknown>,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata!.context_mode).toBe('summary');
    const childSessionId = result.metadata!.child_session_id as string;
    expect(childSessionId).toBeDefined();

    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.sessionOrigin).toBe('subagent');

    // Должны быть унаследованные сообщения от родителя (fork)
    const inherited = child!.messages.filter(m => m.origin === 'inherited');
    expect(inherited.length).toBe(parentMsgCount);

    // Должен быть summary message
    const summary = child!.messages.find(m => m.role === MessageRole.SUMMARY);
    expect(summary).toBeDefined();
    expect(summary!.content).toBe(mockSummaryContent);
  });

  it('summary mode: fallback на inherit при ошибке contextOptimizer', async () => {
    const parent = await createParentWithMessages();
    const parentMsgCount = parent.messages.length;

    const mockContextOptimizer = {
      summarize: vi.fn().mockRejectedValue(new Error('Summarization failed')),
    } satisfies Pick<ContextOptimizer, 'summarize'>;

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'summary' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          contextOptimizer: mockContextOptimizer,
        } as unknown as Record<string, unknown>,
      },
    );

    expect(result.isError).toBeFalsy();
    const childSessionId = result.metadata!.child_session_id as string;
    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    // Даже при ошибке суммаризации форк создан (полная история)
    const inherited = child!.messages.filter(m => m.origin === 'inherited');
    expect(inherited.length).toBe(parentMsgCount);
    // Summary не должно быть
    const summary = child!.messages.find(m => m.role === MessageRole.SUMMARY);
    expect(summary).toBeUndefined();
  });

  // ─── Edge case: summary mode с пустой родительской сессией ─────

  it('summary mode с пустой родительской сессией: не падает, создаёт дочернюю сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'Empty' });

    const mockContextOptimizer = {
      summarize: vi.fn().mockResolvedValue({
        id: 'summary-1',
        role: MessageRole.SUMMARY,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart('(пустой контекст)')],
        content: '(пустой контекст)',
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        summaryOf: [],
        metadata: { type: 'auto_summary' },
      }),
    } satisfies Pick<ContextOptimizer, 'summarize'>;

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'summary' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          contextOptimizer: mockContextOptimizer,
        } as unknown as Record<string, unknown>,
      },
    );

    expect(result.isError).toBeFalsy();
    const childSessionId = result.metadata!.child_session_id as string;
    const child = await sessionManager.getSession(childSessionId);
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.sessionOrigin).toBe('subagent');
    // Нет inherited сообщений (пустая родительская сессия)
    const inherited = child!.messages.filter(m => m.origin === 'inherited');
    expect(inherited).toHaveLength(0);
    // Summary всё ещё добавляется
    const summary = child!.messages.find(m => m.role === MessageRole.SUMMARY);
    expect(summary).toBeDefined();
  });

  // ─── No valid agent ──────────────────────────────────────────────

  it('возвращает ошибку при невалидном subagent_type', async () => {
    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'nonexistent' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          agentRegistry: {
            get: () => undefined,
            getSubagents: () => [{ id: 'explore' }],
            getToolsForAgent: () => [],
          } as MockAgentRegistry,
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('возвращает ошибку, если агент не имеет класса subagent', async () => {
    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'developer' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          agentRegistry: {
            get: () => ({ id: 'developer', agentMode: ['primary'] }),
            getSubagents: () => [{ id: 'explore' }],
            getToolsForAgent: () => [],
          } as unknown as MockAgentRegistry,
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cannot be used as a subagent');
  });

  // ─── EventBus: session.created публикуется в родительскую сессию ──

  it('публикует session.created в EventBus родителя', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const events: Array<{ type: string; sessionId: string }> = [];

    const unsubscribe = eventBus.subscribe(parent.id, (event) => {
      events.push({ type: event.type, sessionId: event.sessionId });
    });

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    unsubscribe();
    const createdEvent = events.find(e => e.type === 'session.created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.sessionId).toBe(parent.id);
  });

  // ─── EventBus: message.added публикуется в дочернюю сессию ─────

  it('публикует message.added в EventBus дочерней сессии во время исполнения', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const publishedSessions = new Set<string>();

    // Подписываемся на все сессии
    const origSubscribe = eventBus.subscribe.bind(eventBus);
    eventBus.subscribe = vi.fn((sessionId: string, handler: any) => {
      publishedSessions.add(sessionId);
      return origSubscribe(sessionId, handler);
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        ...baseCtx,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    // Дочерняя сессия создана
    const childSessionId = result.metadata!.child_session_id as string;
    expect(childSessionId).toBeDefined();
  });

  // ─── capabilities ──────────────────────────────────────────────

  it('имеет capability TASK', () => {
    expect(taskTool.capabilities).toContain(ToolCapability.TASK);
  });

  // ─── messageToLLMMessage conversion ────────────────────────────

  it('forkSession создаёт сообщения с origin=inherited и sourceMsgId', async () => {
    const parent = await createParentWithMessages();
    const child = await sessionManager.forkSession(parent.id, {});

    const firstMsg = child.messages[0]!;
    expect(firstMsg.origin).toBe('inherited');
    expect(firstMsg.role).toBe(MessageRole.USER);
    expect(firstMsg.sourceMsgId).toBeDefined();
    expect(firstMsg.sourceMsgId).toBe(parent.messages[0]!.id);
  });

  // ─── sessionOrigin для subagent ──────────────────────────────

  it('subagent session имеет sessionOrigin="subagent"', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const child = await sessionManager.createSession({
      title: 'Sub',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { agentRole: 'explore' },
    });
    expect(child.sessionOrigin).toBe('subagent');
    expect(child.parentId).toBe(parent.id);
  });

  // ─── Sticky notes в system prompt саб-агента ─────────────────────

  it('inherit mode: stickyNotes родителя попадают в system prompt саб-агента', async () => {
    const parent = await createParentWithMessages();
    // Добавляем заметки родителю
    parent.stickyNotes = [
      { id: 'n1', content: 'Решение: использовать SQLite', createdAt: nowISO(), updatedAt: nowISO(), disabled: false },
    ];
    await sessionManager.updateSession(parent);

    let capturedSystemMsg = '';
    const capturingProvider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: any[], systemPrompt: string) {
        // AD-070 §1.5: system — только вторым аргументом, в messages его нет.
        capturedSystemMsg = systemPrompt || '';
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'inherit' },
      {
        ...baseCtx,
        extra: {
          provider: capturingProvider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(capturedSystemMsg).toContain('[PARENT NOTES]');
    expect(capturedSystemMsg).toContain('Решение: использовать SQLite');
  });

  it('summary mode: stickyNotes родителя попадают в system prompt саб-агента', async () => {
    const parent = await createParentWithMessages();
    parent.stickyNotes = [
      { id: 'n1', content: 'Использовать PostgreSQL', createdAt: nowISO(), updatedAt: nowISO(), disabled: false },
    ];
    await sessionManager.updateSession(parent);

    let capturedSystemMsg = '';
    const capturingProvider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: any[], systemPrompt: string) {
        // AD-070 §1.5: system — только вторым аргументом, в messages его нет.
        capturedSystemMsg = systemPrompt || '';
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'summary' },
      {
        ...baseCtx,
        extra: {
          provider: capturingProvider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(capturedSystemMsg).toContain('[PARENT NOTES]');
    expect(capturedSystemMsg).toContain('Использовать PostgreSQL');
  });

  it('none mode: stickyNotes НЕ попадают в system prompt саб-агента (чистый лист)', async () => {
    const parent = await createParentWithMessages();
    parent.stickyNotes = [
      { id: 'n1', content: 'Секретные заметки', createdAt: nowISO(), updatedAt: nowISO(), disabled: false },
    ];
    await sessionManager.updateSession(parent);

    let capturedSystemMsg = '';
    const capturingProvider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: any[], systemPrompt: string) {
        // AD-070 §1.5: system — только вторым аргументом, в messages его нет.
        capturedSystemMsg = systemPrompt || '';
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        ...baseCtx,
        extra: {
          provider: capturingProvider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(capturedSystemMsg).not.toContain('[PARENT NOTES]');
    expect(capturedSystemMsg).not.toContain('Секретные заметки');
  });

  // ─── AD-069 Фаза 2b: проектные инструкции в промпте саб-агента ──────

  async function captureSubagentSystem(
    params: Record<string, unknown>,
    extraOverrides: Record<string, unknown> = {},
  ): Promise<string> {
    const parent = await createParentWithMessages();
    let captured = '';
    const provider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: unknown, systemPrompt: string) {
        captured = systemPrompt || '';
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };
    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', ...params },
      {
        ...baseCtx,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          projectInstructions: '[PROJECT INSTRUCTIONS]\nCHAIN-RULES\n[END PROJECT INSTRUCTIONS]',
          ...extraOverrides,
        },
      },
    );
    return captured;
  }

  it('AD-069: резолвнутые проектные инструкции попадают в system prompt саб-агента', async () => {
    const system = await captureSubagentSystem({});
    expect(system).toContain('[PROJECT INSTRUCTIONS]');
    expect(system).toContain('CHAIN-RULES');
  });

  it('AD-069: skip_context_files=true — проектные инструкции не добавляются', async () => {
    const system = await captureSubagentSystem({ skip_context_files: true });
    expect(system).not.toContain('CHAIN-RULES');
  });

  it('AD-069: systemPrompt override родителя — проектные инструкции не добавляются', async () => {
    const system = await captureSubagentSystem({}, {
      parentSessionSettings: { systemPrompt: 'MY-OVERRIDE' },
    });
    expect(system).not.toContain('CHAIN-RULES');
  });
});

/** Провайдер саб-агента: первый вызов — write_file, второй — текст. */
class MockSubagentAskProvider {
  private _calls = 0;

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    this._calls++;
    if (this._calls === 1) {
      yield {
        content: '',
        isFinal: true,
        toolCalls: [{
          id: 'call_sub',
          function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'sub.txt', content: 'hello' }) },
        }],
      } as import('@itphx/synth-shared').LLMChunk;
    } else {
      yield { content: 'готово', isFinal: true, toolCalls: [] } as import('@itphx/synth-shared').LLMChunk;
    }
  }

  model = 'test-model';
  name = 'test-provider';
}

describe('taskTool × permissions саб-агента (AD-029)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-perm-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('ask саб-агента публикуется в РОДИТЕЛЬСКУЮ сессию и тул выполняется после allow', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const toolRegistry = createToolRegistry();
    const asked: Array<Record<string, unknown>> = [];
    const unsub = eventBus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') {
        asked.push(e.data as Record<string, unknown>);
        eventBus.publish(parent.id, 'permission.replied', {
          approval_id: (e.data as Record<string, unknown>).approval_id as string,
          session_id: parent.id,
          action: 'allow',
          once: true,
        });
      }
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'напиши файл', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: new MockSubagentAskProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          toolRegistry,
          permissionConfig: { rules: { write_file: 'ask' }, askTimeoutMs: 2000 },
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(asked.length).toBe(1);
    expect(asked[0]!.session_id).toBe(parent.id);
    expect(asked[0]!.tool).toBe('write_file');
    await expect(access(join(tmpDir, 'sub.txt'))).resolves.toBeUndefined();
    unsub();
  });

  it('deny на тул саб-агента — тул блокируется, ask не происходит', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const toolRegistry = createToolRegistry();
    const asked: Array<Record<string, unknown>> = [];
    const unsub = eventBus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'напиши файл', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: new MockSubagentAskProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          toolRegistry,
          permissionConfig: { rules: { write_file: 'deny' }, askTimeoutMs: 2000 },
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(asked.length).toBe(0);
    await expect(access(join(tmpDir, 'sub.txt'))).rejects.toThrow();
    // deny-результат сохранён в дочерней сессии как tool_result
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const toolMsg = child.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('Permission denied');
    unsub();
  });

  it('yolo: саб-агент наследует mode=yolo, ask выполняется без permission.asked', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    parent.mode = 'yolo';
    await sessionManager.updateSession(parent);
    const toolRegistry = createToolRegistry();
    const asked: Array<Record<string, unknown>> = [];
    const unsub = eventBus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'напиши файл', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: new MockSubagentAskProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          toolRegistry,
          permissionConfig: { rules: { write_file: 'ask' }, askTimeoutMs: 2000 },
        },
      },
    );

    expect(result.isError).toBeFalsy();
    // ask не публикуется, тул выполняется автоматически
    expect(asked.length).toBe(0);
    await expect(access(join(tmpDir, 'sub.txt'))).resolves.toBeUndefined();
    unsub();
  });
});

/** Провайдер саб-агента: первый вызов — execute_shell с cat ~/.ssh/id_rsa. */
class MockSubagentShellProvider {
  private _calls = 0;

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    this._calls++;
    if (this._calls === 1) {
      yield {
        content: '',
        isFinal: true,
        toolCalls: [{
          id: 'call_shell',
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'cat ~/.ssh/id_rsa' }) },
        }],
      } as import('@itphx/synth-shared').LLMChunk;
    } else {
      yield { content: 'готово', isFinal: true, toolCalls: [] } as import('@itphx/synth-shared').LLMChunk;
    }
  }

  model = 'test-model';
  name = 'test-provider';
}

describe('taskTool × shellPolicy саб-агента (B3/B5)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  const SHELL_POLICY = {
    deniedPaths: ['~/.ssh/id_rsa'],
    deniedPrefixes: ['~/.ssh'],
    approvalPaths: [],
    deniedCommandPrefixes: [],
  } as import('../security/shell-guard.js').ShellPolicy;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-shell-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('B3: shellPolicy родителя применяется к execute_shell саб-агента (deny на cat ~/.ssh/id_rsa)', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const toolRegistry = createToolRegistry();

    const result = await taskTool.execute(
      { description: 'test', prompt: 'прочитай ключ', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: new MockSubagentShellProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          toolRegistry,
          shellPolicy: SHELL_POLICY,
        },
      },
    );

    expect(result.isError).toBeFalsy();
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const toolMsg = child.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('Permission denied');
    expect(toolMsg!.content).toContain('id_rsa');
  });

  it('B5: саб-агент в plan-режиме получает постоянный список тулов (без режимной фильтрации)', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    parent.mode = 'plan';
    await sessionManager.updateSession(parent);

    let capturedTools: unknown;
    const capturingProvider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: unknown, _system: unknown, tools: unknown) {
        capturedTools = tools;
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    const toolRegistry = createToolRegistry();
    const agentRegistry = {
      ...makeMockAgentRegistry(),
      getToolsForAgent: () => toolRegistry.toLLMFormat(),
    } as unknown as MockAgentRegistry;

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: capturingProvider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry,
          toolRegistry,
        },
      },
    );

    // AD-070 §2.9: definition остаётся в запросе; ограничения plan-режима
    // обеспечивает permission-слой (unavailable(mode)), а не скрытие тулов.
    const names = (capturedTools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('git_commit');
    expect(names).toContain('read_file');
    expect(names).toContain('execute_shell');
  });

  it('B5: в act-режиме список тулов не фильтруется', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    let capturedTools: unknown;
    const capturingProvider = {
      chatAsync: vi.fn().mockImplementation(async function* (_messages: unknown, _system: unknown, tools: unknown) {
        capturedTools = tools;
        yield { isFinal: true, content: 'OK', toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    const toolRegistry = createToolRegistry();
    const agentRegistry = {
      ...makeMockAgentRegistry(),
      getToolsForAgent: () => toolRegistry.toLLMFormat(),
    } as unknown as MockAgentRegistry;

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: capturingProvider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry,
          toolRegistry,
        },
      },
    );

    const names = (capturedTools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('git_commit');
    expect(names).toContain('read_file');
  });
});

describe('taskTool × runtimeDeps саб-агента (AD-070 §2.9.1)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-deps-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Реестр саб-агента с реальным набором встроенных тулов (постоянный). */
  function makeFullToolAgentRegistry(toolRegistry: ReturnType<typeof createToolRegistry>) {
    return {
      ...makeMockAgentRegistry(),
      getToolsForAgent: () => toolRegistry.toLLMFormat(),
    } as unknown as MockAgentRegistry;
  }

  it('git=false: git-тул саб-агента denied с reason dependency + [НЕДОСТУПНЫЕ ТУЛЫ] в промпте', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const toolRegistry = createToolRegistry();

    let capturedSystem: unknown;
    let calls = 0;
    const provider = {
      chatAsync: vi.fn().mockImplementation(async function* (
        _messages: unknown,
        systemPrompt: unknown,
      ) {
        capturedSystem = systemPrompt;
        calls++;
        if (calls === 1) {
          yield {
            content: '',
            isFinal: true,
            toolCalls: [{
              id: 'g1',
              function: { name: 'git_status', arguments: JSON.stringify({}) },
            }],
          };
          return;
        }
        yield { content: 'готово', isFinal: true, toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    const result = await taskTool.execute(
      { description: 'test', prompt: 'git status', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeFullToolAgentRegistry(toolRegistry),
          toolRegistry,
          runtimeDeps: { git: false, rg: true, sh: true },
        },
      },
    );

    expect(result.isError).toBeFalsy();

    // permission-слой: dependency deny (тул не исполнен)
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const toolMsg = child.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('Permission denied');
    expect(toolMsg!.content).toContain('git');
    expect(toolMsg!.content).toContain('not installed');

    // системный промпт саб-агента: секция недоступных тулов (как у родителя)
    expect(String(capturedSystem)).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(String(capturedSystem)).toContain('git_status');
  });

  it('git/rg/sh доступны: секции [НЕДОСТУПНЫЕ ТУЛЫ] в промпте нет, git-тул исполняется', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const toolRegistry = createToolRegistry();

    let capturedSystem: unknown;
    let calls = 0;
    const provider = {
      chatAsync: vi.fn().mockImplementation(async function* (
        _messages: unknown,
        systemPrompt: unknown,
      ) {
        capturedSystem = systemPrompt;
        calls++;
        if (calls === 1) {
          yield {
            content: '',
            isFinal: true,
            toolCalls: [{
              id: 'g1',
              function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'nonexistent.txt' }) },
            }],
          };
          return;
        }
        yield { content: 'готово', isFinal: true, toolCalls: [] };
      }),
      model: 'test-model',
      name: 'test-provider',
    };

    await taskTool.execute(
      { description: 'test', prompt: 'read', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeFullToolAgentRegistry(toolRegistry),
          toolRegistry,
          runtimeDeps: { git: true, rg: true, sh: true },
        },
      },
    );

    expect(String(capturedSystem)).not.toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
  });
});

/**
 * Провайдер саб-агента, реагирующий на отмену (cancelToken):
 * итерация 0 — текст + вызов read_file; итерация 1 — длинный стрим,
 * который прекращается сразу после отмены (раньше игнорировал её).
 */
function makeAbortableSubagentProvider(state: { calls: number }) {
  return {
    model: 'test-model',
    name: 'test-provider',
    chatAsync: vi.fn().mockImplementation(async function* (
      _messages: unknown,
      _systemPrompt: unknown,
      _tools: unknown,
      _debugCollector: unknown,
      ct?: { cancelled: boolean },
    ) {
      const n = state.calls++;
      if (n === 0) {
        yield {
          isFinal: true,
          content: 'Изучаю файлы проекта...',
          toolCalls: [{
            id: 'sub_call_1',
            function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
          }],
        };
        return;
      }
      yield { isFinal: false, content: 'Частичный ответ: начал работу. ' };
      for (let i = 0; i < 300; i++) {
        if (ct?.cancelled) return;
        yield { isFinal: false, content: `фрагмент-${i} ` };
        await new Promise((r) => setTimeout(r, 5));
      }
      yield { isFinal: true, content: 'РАБОТА ЗАВЕРШЕНА ПОЛНОСТЬЮ', toolCalls: [] };
    }),
  };
}

describe('taskTool × отмена и ошибки (abort / provider error)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-abort-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMultiStepRegistry(): MockAgentRegistry {
    return {
      get: (id: string) => {
        if (id === 'explore') {
          return { id, agentMode: ['subagent'], subagentPrompt: 'You are a test subagent.', maxSteps: 5 };
        }
        return undefined;
      },
      getSubagents: () => [{ id: 'explore' }],
      getToolsForAgent: () => [],
    };
  }

  it('abort во время работы task: сабагент останавливается, tool_result содержит маркер отмены, частичный текст, шаги и child_session_id', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const state = { calls: 0 };
    const provider = makeAbortableSubagentProvider(state);
    const ac = new AbortController();

    const promise = taskTool.execute(
      { description: 'long task', prompt: 'hello', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: ac.signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMultiStepRegistry(),
          toolRegistry: createToolRegistry(),
        },
      },
    );

    // Ждём запуска второй итерации (долгий стрим), затем «Стоп»
    await vi.waitFor(() => expect(state.calls).toBe(2), { timeout: 3000 });
    ac.abort();
    const result = await promise;

    // Сабагент НЕ прошёл все итерации: третья LLM-итерация не началась
    expect(state.calls).toBe(2);
    expect(result.isError).toBeFalsy();

    // tool_result: маркер отмены + частичный текст + шаги + child_session_id
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain('<child_session_id>');
    expect(result.content).toContain('Частичный ответ: начал работу');
    expect(result.content).toContain('<steps_completed>');
    expect(result.content).toContain('read_file');
    expect(result.content).not.toContain('РАБОТА ЗАВЕРШЕНА ПОЛНОСТЬЮ');

    // metadata-маркеры
    expect(result.metadata!.stopped_by).toBe('user');
    expect(result.metadata!.interrupted).toBe(true);
    expect(result.metadata!.child_session_id).toBeDefined();
    const toolCalls = result.metadata!.tool_calls as Array<{ name: string }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe('read_file');

    // Частичный стрим оборванной итерации сохранён в истории дочерней сессии
    const childSessionId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childSessionId))!;
    expect(child).toBeDefined();
    const partialMsg = child.messages.find((m) => m.metadata?.partial === true);
    expect(partialMsg).toBeDefined();
    expect(partialMsg!.content).toContain('Частичный ответ: начал работу');
    // Промпт и выполненный tool-call тоже в истории дочерней сессии
    expect(child.messages.some((m) => m.role === MessageRole.USER && m.content === 'hello')).toBe(true);
    expect(child.messages.some((m) => m.role === MessageRole.TOOL)).toBe(true);
    // Маркер прерывания
    const stopMarker = child.messages.find((m) => m.metadata?.stopped_by === 'user');
    expect(stopMarker).toBeDefined();
    // Последним сообщением должен быть маркер остановки (частичный текст перед ним)
    expect(child.messages[child.messages.length - 1]!.metadata?.stopped_by).toBe('user');
  });

  it('abort по внешнему сигналу уже в aborted-состоянии: task немедленно останавливается', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const state = { calls: 0 };
    const provider = makeAbortableSubagentProvider(state);
    const ac = new AbortController();
    ac.abort();

    const result = await taskTool.execute(
      { description: 'pre-aborted', prompt: 'hello', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: ac.signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMultiStepRegistry(),
          toolRegistry: createToolRegistry(),
        },
      },
    );

    // Провайдер вообще не вызван — отмена наступила до первого стрима
    expect(state.calls).toBe(0);
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain('<child_session_id>');
    expect(result.metadata!.stopped_by).toBe('user');
  });

  it('ошибка провайдера внутри task: tool_result содержит описание ошибки + child_session_id, история дочерней сессии сохранена', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: '' };
        throw new Error('provider down');
      }),
    };

    const result = await taskTool.execute(
      { description: 'broken task', prompt: 'hello', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMultiStepRegistry(),
          toolRegistry: createToolRegistry(),
          // Быстрый backoff — дефолтные 5/15/30с сделали бы тест медленным
          retry: { maxRetries: 3, delaysMs: [10, 10, 10] },
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('provider down');
    expect(result.content).toContain('<status>error</status>');
    expect(result.content).toContain('<child_session_id>');
    // Retry исчерпан: 3 попытки прежде чем вернуть ошибку
    expect(provider.chatAsync).toHaveBeenCalledTimes(3);
    expect(result.metadata!.attempts).toBe(3);
    expect(result.metadata!.max_retries).toBe(3);

    const childSessionId = result.metadata!.child_session_id as string;
    expect(childSessionId).toBeDefined();
    expect(result.metadata!.error).toBe(true);

    // История дочерней сессии сохранена: промпт + сообщение об ошибке
    const child = (await sessionManager.getSession(childSessionId))!;
    expect(child.messages.some((m) => m.role === MessageRole.USER && m.content === 'hello')).toBe(true);
    const errMsg = child.messages.find((m) => m.metadata?.error === true);
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toContain('provider down');
    expect(errMsg!.metadata!.attempts).toBe(3);
  });

  it('обычный (не прерванный) результат содержит child_session_id в content внутри <task_result>', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: makeMockProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<task_result>');
    expect(result.content).toContain('</task_result>');
    const match = result.content.match(/<child_session_id>([^<]+)<\/child_session_id>/);
    expect(match).not.toBeNull();
    // id из content совпадает с id из metadata
    expect(match![1]).toBe(result.metadata!.child_session_id);
  });

  it('AD-070 §2.6: usage саб-агента сохраняется и подтягивается rollup-статистикой', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      chatAsync: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            isFinal: true,
            content: 'sub answer',
            toolCalls: [],
            model: 'test-model',
            usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168, cacheReadTokens: 20 },
          };
        })(),
      ),
      model: 'test-model',
      name: 'test-provider',
    };

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    const childSessionId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childSessionId))!;
    const assistant = [...child.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.usage?.inputTokens).toBe(123);
    expect(assistant.usage?.outputTokens).toBe(45);
    expect(assistant.usage?.cacheReadTokens).toBe(20);
    expect(typeof assistant.metadata?.duration_ms).toBe('number');

    // Rollup: как _persistToolChain родителя — tool-сообщение с child_session_id.
    await sessionManager.addMessage(parent.id, {
      id: generateId(),
      role: MessageRole.TOOL,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('task result')],
      content: 'task result',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      agentRole: 'developer',
      metadata: { tool_name: 'task', child_session_id: childSessionId },
    });

    const stats = await computeSessionStats((await sessionManager.getSession(parent.id))!, {
      getSession: (id) => sessionManager.getSession(id),
    });
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    expect(dev.subagent_sessions).toBe(1);
    expect(dev.subagent_tokens).toBe(168);
  });

  it('usage накапливается только по финальным чанкам итераций, а не по всем чанкам', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    // Провайдеры отдают в каждом чанке НАКОПИТЕЛЬНЫЙ usage; суммировать нужно
    // только финальный чанк каждой итерации (30 + 50), а не все (10+20+30+40+50).
    let call = 0;
    const provider = {
      chatAsync: vi.fn().mockImplementation(async function* () {
        call++;
        if (call === 1) {
          yield { isFinal: false, content: 'часть ', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } };
          yield { isFinal: false, content: 'ответа ', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } };
          yield {
            isFinal: true,
            content: 'ответ ',
            model: 'test-model',
            usage: { inputTokens: 30, outputTokens: 3, totalTokens: 33 },
            toolCalls: [{ id: 'c1', function: { name: 'noop', arguments: '{}' } }],
          };
          return;
        }
        yield { isFinal: false, content: 'финал ', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } };
        yield {
          isFinal: true,
          content: 'финал',
          model: 'test-model',
          usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
          toolCalls: [],
        };
      }),
      model: 'test-model',
      name: 'test-provider',
    };
    const registry = {
      get: () => ({ id: 'explore', agentMode: ['subagent'], subagentPrompt: 'test', maxSteps: 3 }),
      getSubagents: () => [{ id: 'explore' }],
      getToolsForAgent: () => [],
    };

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: registry,
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(provider.chatAsync).toHaveBeenCalledTimes(2);
    const usage = result.metadata!.subagent_usage as { inputTokens: number; outputTokens: number };
    expect(usage.inputTokens).toBe(80); // 30 + 50, а не 150
    expect(usage.outputTokens).toBe(8); // 3 + 5

    const childSessionId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childSessionId))!;
    const assistant = [...child.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.usage?.inputTokens).toBe(80);
  });

  it('дочерняя сессия наследует projectId и её session-счётчики попадают в project stats', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent', projectId: 'proj-1' });
    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: {
            chatAsync: vi.fn().mockReturnValue(
              (async function* () {
                yield {
                  isFinal: true,
                  content: 'sub answer',
                  toolCalls: [],
                  model: 'test-model',
                  usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168, cacheReadTokens: 20 },
                };
              })(),
            ),
            model: 'test-model',
            name: 'test-provider',
          },
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    const childSessionId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childSessionId))!;
    // projectId проброшен → ребёнок попадает в listSessions({ projectId }).
    expect(child.projectId).toBe('proj-1');
    // session-счётчики обновлены вручную (task.ts пишет через addMessage).
    expect(child.inputTokens).toBe(123);
    expect(child.outputTokens).toBe(45);
    expect(child.totalTokens).toBe(168);
    expect(child.cacheReadTokens).toBe(20);

    const projectSessions = await sessionManager.listSessions({ projectId: 'proj-1' });
    expect(projectSessions.map((s) => s.id)).toContain(childSessionId);
    const totalInput = projectSessions.reduce((sum, s) => sum + s.inputTokens, 0);
    expect(totalInput).toBe(123);
  });
});

describe('taskTool — live-статистика саб-агента (AD-070)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-live-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUsageProvider() {
    return {
      chatAsync: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            isFinal: true,
            content: 'sub answer',
            toolCalls: [],
            model: 'test-model',
            usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 },
          };
        })(),
      ),
      model: 'test-model',
      name: 'test-provider',
    };
  }

  it('subagent.progress несёт usage/cost; stream.usage публикуется в дочернюю сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const progress: Array<Record<string, unknown>> = [];
    const published: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribeAll((e) => {
      published.push({ type: e.type, sessionId: e.sessionId, data: e.data });
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: makeUsageProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          publish: (type: string, data: Record<string, unknown>) =>
            progress.push({ type, ...data }),
          streamId: 'stream-1',
          callId: 'call-1',
          modelPriceLoader: (m: string) =>
            (m === 'test-model' ? { inputPrice: 1, outputPrice: 2 } : null),
        },
      },
    );
    unsubscribe();

    expect(result.isError).toBeFalsy();
    const childId = result.metadata!.child_session_id as string;

    // parent-событие несёт usage/cost/model/provider/estimated
    const progressWithUsage = progress.find(
      (p) => p.type === 'subagent.progress' && p.usage,
    );
    expect(progressWithUsage).toBeDefined();
    expect((progressWithUsage!.usage as TokenUsage).inputTokens).toBe(123);
    expect(progressWithUsage!.estimated).toBe(false);
    expect(progressWithUsage!.model).toBe('test-model');
    expect(progressWithUsage!.provider).toBe('test-provider');
    // 123*1/1e6 + 45*2/1e6 = 0.000213
    expect(progressWithUsage!.cost_usd as number).toBeCloseTo(0.000213, 12);
    expect(progressWithUsage!.cost_currency).toBe('USD');

    // live-событие уходит в дочернюю сессию
    const childUsage = published.find(
      (e) => e.type === 'stream.usage' && e.sessionId === childId,
    );
    expect(childUsage).toBeDefined();
    expect(childUsage!.data.session_id).toBe(childId);
    expect((childUsage!.data.usage as TokenUsage).inputTokens).toBe(123);
    expect(childUsage!.data.estimated).toBe(false);
    expect(childUsage!.data.agent_role).toBe('explore');
    expect(childUsage!.data.cost_usd as number).toBeCloseTo(0.000213, 12);
    expect(childUsage!.data.cost_currency).toBe('USD');
  });

  it('по завершении саб-агента в дочернюю сессию публикуется stream.ended', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const published: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribeAll((e) => {
      published.push({ type: e.type, sessionId: e.sessionId, data: e.data });
    });

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: makeUsageProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          publish: () => {},
          streamId: 'stream-ended-1',
          callId: 'call-ended-1',
        },
      },
    );
    unsubscribe();

    const childId = result.metadata!.child_session_id as string;
    const ended = published.filter(
      (e) => e.type === 'stream.ended' && e.sessionId === childId,
    );
    // Ровно одно терминальное событие на прогон (finalizeChildSession).
    expect(ended).toHaveLength(1);
    expect(ended[0]!.data.stream_id).toBe('stream-ended-1');
    // Терминальное событие не создаёт сообщений — только сбрасывает live.
    const childSession = await sessionManager.getSession(childId);
    const assistantCount = childSession!.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT,
    ).length;
    expect(assistantCount).toBe(1);
  });

  it('Anthropic: input>0/output=0 → live estimated с растущим output, финал output>0 → exact', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const published: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribeAll((e) => {
      published.push({ type: e.type, sessionId: e.sessionId, data: e.data });
    });

    const provider = {
      chatAsync: vi.fn().mockReturnValue(
        (async function* () {
          // Anthropic-подобный стрим: input в message_start, output ещё 0.
          yield {
            isFinal: false,
            content: 'Hello',
            toolCalls: [],
            usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
          };
          // Даём пройти окну троттлинга, чтобы финальный exact тоже опубликовался.
          await new Promise((r) => setTimeout(r, 350));
          yield {
            isFinal: true,
            content: 'Hello world',
            toolCalls: [],
            model: 'test-model',
            usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          };
        })(),
      ),
      model: 'test-model',
      name: 'test-provider',
    };

    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          publish: () => {},
          streamId: 'stream-live-1',
          callId: 'call-live-1',
        },
      },
    );
    unsubscribe();

    expect(result.isError).toBeFalsy();
    const childId = result.metadata!.child_session_id as string;
    const childUsage = published.filter(
      (e) => e.type === 'stream.usage' && e.sessionId === childId,
    );

    // Промежуточная оценка: точный input сохранён, output оценён из контента.
    const estimated = childUsage.find((e) => e.data.estimated === true);
    expect(estimated).toBeDefined();
    expect((estimated!.data.usage as TokenUsage).inputTokens).toBe(100);
    expect((estimated!.data.usage as TokenUsage).outputTokens).toBeGreaterThan(0);

    // Финал: точный output, estimated снят.
    const exact = childUsage.find((e) => e.data.estimated === false);
    expect(exact).toBeDefined();
    expect((exact!.data.usage as TokenUsage).outputTokens).toBe(5);
  });

  it('без modelPriceLoader cost_usd не пишется', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const progress: Array<Record<string, unknown>> = [];

    await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: makeUsageProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          publish: (type: string, data: Record<string, unknown>) =>
            progress.push({ type, ...data }),
          streamId: 'stream-2',
          callId: 'call-2',
        },
      },
    );

    const progressWithUsage = progress.find(
      (p) => p.type === 'subagent.progress' && p.usage,
    );
    expect(progressWithUsage).toBeDefined();
    expect(progressWithUsage!.cost_usd).toBeUndefined();
    expect(progressWithUsage!.cost_breakdown).toBeUndefined();
  });
});

describe('taskTool — metadata финального child-сообщения (AD-070)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-child-meta-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUsageProvider() {
    return {
      chatAsync: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            isFinal: true,
            content: 'sub answer',
            toolCalls: [],
            model: 'test-model',
            usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 },
          };
        })(),
      ),
      model: 'test-model',
      name: 'test-provider',
    };
  }

  function makeMultiStepRegistry(): MockAgentRegistry {
    return {
      get: (id: string) => {
        if (id === 'explore') {
          return { id, agentMode: ['subagent'], subagentPrompt: 'You are a test subagent.', maxSteps: 5 };
        }
        return undefined;
      },
      getSubagents: () => [{ id: 'explore' }],
      getToolsForAgent: () => [],
    };
  }

  /** Провайдер: 1-я итерация с usage+tool, затем долгий стрим для abort. */
  function makeAbortableUsageProvider(state: { calls: number }) {
    return {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* (
        _messages: unknown,
        _systemPrompt: unknown,
        _tools: unknown,
        _debugCollector: unknown,
        ct?: { cancelled: boolean },
      ) {
        const n = state.calls++;
        if (n === 0) {
          yield {
            isFinal: true,
            content: 'шаг 1',
            toolCalls: [{
              id: 'sub_call_1',
              function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
            }],
            model: 'test-model',
            usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          };
          return;
        }
        yield { isFinal: false, content: 'Частичный ответ: начал работу. ' };
        for (let i = 0; i < 300; i++) {
          if (ct?.cancelled) return;
          yield { isFinal: false, content: `фрагмент-${i} ` };
          await new Promise((r) => setTimeout(r, 5));
        }
      }),
    };
  }

  const priceLoader = (m: string) =>
    (m === 'test-model' ? { inputPrice: 1, outputPrice: 2 } : null);

  async function runSuccess(
    modelPriceLoader?: (m: string) => { inputPrice: number; outputPrice: number; currency?: 'RUB' | 'USD' | 'CNY' } | null,
    published?: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>,
  ) {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const unsubscribe = published
      ? eventBus.subscribeAll((e) => published.push({ type: e.type, sessionId: e.sessionId, data: e.data }))
      : undefined;
    const result = await taskTool.execute(
      { description: 'test', prompt: 'hello', subagent_type: 'explore', context_mode: 'none' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider: makeUsageProvider(),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMockAgentRegistry(),
          publish: () => {},
          streamId: 'stream-meta',
          callId: 'call-meta',
          ...(modelPriceLoader ? { modelPriceLoader } : {}),
        },
      },
    );
    unsubscribe?.();
    return result;
  }

  it('успешный ответ: status=completed и cost_usd/cost_breakdown при заданных ценах', async () => {
    const result = await runSuccess(priceLoader);
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const assistant = [...child.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.metadata?.status).toBe('completed');
    // 123*1/1e6 + 45*2/1e6 = 0.000213
    expect(assistant.metadata?.cost_usd as number).toBeCloseTo(0.000213, 12);
    expect(assistant.metadata?.cost_currency).toBe('USD');
    expect(assistant.metadata?.cost_breakdown).toBeDefined();
    // usage из финальных чанков точен — оценка не помечается
    expect(assistant.metadata?.usage_estimated).toBeUndefined();
  });

  it('сабагент в RUB: cost_currency в child metadata и live-событии', async () => {
    const published: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
    const result = await runSuccess(
      (m) => (m === 'test-model' ? { inputPrice: 1, outputPrice: 2, currency: 'RUB' } : null),
      published,
    );
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const assistant = [...child.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.metadata?.cost_currency).toBe('RUB');

    const childUsage = published.find(
      (e) => e.type === 'stream.usage' && e.sessionId === childId,
    );
    expect(childUsage?.data.cost_currency).toBe('RUB');
  });

  it('без modelPriceLoader: cost_usd отсутствует, status=completed', async () => {
    const result = await runSuccess();
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const assistant = [...child.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.metadata?.status).toBe('completed');
    expect(assistant.metadata?.cost_usd).toBeUndefined();
    expect(assistant.metadata?.cost_breakdown).toBeUndefined();
  });

  it('metadata финального ответа попадает в message.added/child.message.added', async () => {
    const published: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
    const result = await runSuccess(priceLoader, published);
    const childId = result.metadata!.child_session_id as string;

    const isFinalAssistant = (e: { data: Record<string, unknown> }) => {
      const message = e.data.message as { role?: string; metadata?: Record<string, unknown> } | undefined;
      return message?.role === MessageRole.ASSISTANT
        && message.metadata?.status === 'completed'
        && typeof message.metadata?.cost_usd === 'number';
    };
    expect(published.some((e) => e.type === 'message.added' && e.sessionId === childId && isFinalAssistant(e))).toBe(true);
    expect(published.some((e) => e.type === 'child.message.added' && e.data.child_session_id === childId && isFinalAssistant(e))).toBe(true);
  });

  it('abort: partial-сообщение child несёт status=cancelled и cost', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const state = { calls: 0 };
    const ac = new AbortController();
    const promise = taskTool.execute(
      { description: 'long task', prompt: 'hello', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: ac.signal,
        workingDir: tmpDir,
        extra: {
          provider: makeAbortableUsageProvider(state),
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMultiStepRegistry(),
          toolRegistry: createToolRegistry(),
          publish: () => {},
          streamId: 'stream-abort-meta',
          callId: 'call-abort-meta',
          modelPriceLoader: priceLoader,
        },
      },
    );
    await vi.waitFor(() => expect(state.calls).toBe(2), { timeout: 3000 });
    ac.abort();
    const result = await promise;

    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const partialMsg = child.messages.find((m) => m.metadata?.partial === true);
    expect(partialMsg).toBeDefined();
    expect(partialMsg!.metadata?.status).toBe('cancelled');
    // 100*1/1e6 + 10*2/1e6 = 0.00012 (usage первой итерации)
    expect(partialMsg!.metadata?.cost_usd as number).toBeCloseTo(0.00012, 12);
    expect(partialMsg!.metadata?.usage_estimated).toBeUndefined();
  });

  it('error: сообщение child несёт status=error', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const provider = {
      model: 'test-model',
      name: 'test-provider',
      chatAsync: vi.fn().mockImplementation(async function* () {
        yield { isFinal: false, content: '' };
        throw new Error('provider down');
      }),
    };

    const result = await taskTool.execute(
      { description: 'broken task', prompt: 'hello', subagent_type: 'explore' },
      {
        sessionId: parent.id,
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: tmpDir,
        extra: {
          provider,
          sessionManager,
          eventBus,
          sessionId: parent.id,
          agentRegistry: makeMultiStepRegistry(),
          toolRegistry: createToolRegistry(),
          retry: { maxRetries: 3, delaysMs: [10, 10, 10] },
          streamId: 'stream-error-meta',
          callId: 'call-error-meta',
          modelPriceLoader: priceLoader,
        },
      },
    );

    expect(result.isError).toBe(true);
    const childId = result.metadata!.child_session_id as string;
    const child = (await sessionManager.getSession(childId))!;
    const errMsg = child.messages.find((m) => m.metadata?.error === true);
    expect(errMsg).toBeDefined();
    expect(errMsg!.metadata?.status).toBe('error');
  });
});
