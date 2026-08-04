import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskTool } from './task.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { ToolCapability, MessageRole, generateId, makeTextPart, nowISO } from '@synth/shared';
import type { Message, Session } from '@synth/shared';
import type { ContextOptimizer } from '../context/optimizer.js';
import { createToolRegistry } from './index.js';

/** Минимальный тип для мока AgentRegistry — только поля, используемые в taskTool */
interface MockAgentDef {
  id: string;
  agentMode: string;
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
          agentMode: 'subagent' as const,
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
    expect(result.content).toContain('провайдер');
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
    expect(result.content).toContain('не найден');
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
      chatAsync: vi.fn().mockImplementation(async function* (messages: any[]) {
        capturedSystemMsg = messages[0]?.content || '';
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

    expect(capturedSystemMsg).toContain('[ЗАМЕТКИ РОДИТЕЛЬСКОЙ СЕССИИ]');
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
      chatAsync: vi.fn().mockImplementation(async function* (messages: any[]) {
        capturedSystemMsg = messages[0]?.content || '';
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

    expect(capturedSystemMsg).toContain('[ЗАМЕТКИ РОДИТЕЛЬСКОЙ СЕССИИ]');
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
      chatAsync: vi.fn().mockImplementation(async function* (messages: any[]) {
        capturedSystemMsg = messages[0]?.content || '';
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

    expect(capturedSystemMsg).not.toContain('[ЗАМЕТКИ РОДИТЕЛЬСКОЙ СЕССИИ]');
    expect(capturedSystemMsg).not.toContain('Секретные заметки');
  });
});

/** Провайдер саб-агента: первый вызов — write_file, второй — текст. */
class MockSubagentAskProvider {
  private _calls = 0;

  async *chatAsync(): AsyncGenerator<import('@synth/shared').LLMChunk> {
    this._calls++;
    if (this._calls === 1) {
      yield {
        content: '',
        isFinal: true,
        toolCalls: [{
          id: 'call_sub',
          function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'sub.txt', content: 'hello' }) },
        }],
      } as import('@synth/shared').LLMChunk;
    } else {
      yield { content: 'готово', isFinal: true, toolCalls: [] } as import('@synth/shared').LLMChunk;
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
});
