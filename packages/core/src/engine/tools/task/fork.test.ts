/**
 * Тесты `task/fork.ts` (ADR-095, шаг 5): создание дочерней сессии саб-агента —
 * режимы контекста (ADR-026), наследование permissions (ADR-029), заметки
 * родителя, funnel-создание (ADR-089), публикация `session.created` (ADR-030).
 *
 * Изолированно: реальные FileStore/SessionManager в tmp-каталоге, mock-заглушки
 * для ошибочных/функциональных веток; без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { Message, Session, SessionOrigin, SessionSettings } from '@itphx/synth-shared';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import { HookBus } from '../../hooks/hook-bus.js';
import { prepareChildSession, type PreparedChildSession } from './fork.js';
import type { ContextMode, TaskExtra } from './types.js';

let tmpDir: string;
let store: FileStore;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-fork-'));
  store = new FileStore({ dataDir: tmpDir });
  sessionManager = new SessionManager(store);
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
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
  };
}

async function makeParent(messages = 5): Promise<Session> {
  const parent = await sessionManager.createSession({ title: 'Parent' });
  for (let i = 0; i < messages; i++) {
    await sessionManager.addMessage(
      parent.id,
      makeMsg(`msg ${i}`, i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT),
    );
  }
  return (await sessionManager.getSession(parent.id))!;
}

function opts(extra: Partial<TaskExtra>, over: {
  contextMode?: ContextMode;
  contextCount?: number;
  childRoutingOverrides?: Partial<SessionSettings>;
} = {}) {
  return {
    extra: extra as TaskExtra,
    description: 'do the thing',
    subagentType: 'explore',
    contextMode: over.contextMode ?? 'none',
    contextCount: over.contextCount ?? 4,
    childRoutingOverrides: over.childRoutingOverrides ?? {},
  };
}

describe('prepareChildSession — жизненный цикл / отсутствие зависимостей', () => {
  it('без sessionManager и sessionId — no-op (состояние не меняется)', async () => {
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(state, opts({}));
    expect(state.childSessionId).toBeUndefined();
    expect(state.childMessages).toEqual([]);
    expect(state.parentNotesText).toBe('');
  });

  it('родительская сессия не найдена — дочерняя не создаётся', async () => {
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    const missing = {
      getSession: vi.fn(async () => null),
    };
    await prepareChildSession(state, opts({ sessionManager: missing as unknown as SessionManager, sessionId: 'nope' }));
    expect(state.childSessionId).toBeUndefined();
  });

  it('ошибка SessionManager проглатывается — саб-агент продолжает без дочерней сессии', async () => {
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    const broken = {
      getSession: vi.fn(async () => { throw new Error('storage down'); }),
    };
    await expect(
      prepareChildSession(state, opts({ sessionManager: broken as unknown as SessionManager, sessionId: 'x' })),
    ).resolves.toBeUndefined();
    expect(state.childSessionId).toBeUndefined();
  });
});

describe('prepareChildSession — none mode (default)', () => {
  it('создаёт дочернюю сессию напрямую (createSession) с наследованием настроек и permissions', async () => {
    const parent = await makeParent();
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts(
      { sessionManager, sessionId: parent.id },
      { childRoutingOverrides: { model: 'child-model', provider: 'child-provider' } },
    ));

    expect(state.childSessionId).toBeDefined();
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.parentId).toBe(parent.id);
    expect(child.sessionOrigin).toBe('subagent');
    expect(child.title).toBe('Subtask: do the thing');
    expect(child.userId).toBe(parent.userId);
    expect(child.ownerId).toBe(parent.ownerId);
    // None-режим не копирует историю.
    expect(child.messages).toEqual([]);
    expect(state.childMessages).toEqual([]);
    // Наследование permissions (ADR-029): deny-дополнения саб-агента.
    expect(child.settings.agentRole).toBe('explore');
    expect(child.settings.planMode).toBe('auto');
    expect(child.settings.model).toBe('child-model');
    expect(child.settings.provider).toBe('child-provider');
  });

  // Регрессия: none-режим передаёт `permission` в `SessionManager.createSession`,
  // который раньше собирал settings по whitelist и НЕ копировал `permission`.
  // В итоге `child.settings.permission` у none-ребёнка был undefined (в отличие
  // от fork-детей), а `task-resume.ts` (`child.settings.permission ??
  // deps.permissionConfig`) при resume терял наследуемые правила родителя.
  // Инвариант (ADR-029): permission ребёнка = deriveSubagentPermission(родитель)
  // во всех четырёх режимах контекста.
  it('none mode: child.settings.permission сохраняет derivedPermission родителя', async () => {
    const parent = await makeParent();
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(state, opts({
      sessionManager,
      sessionId: parent.id,
      permissionConfig: { rules: { write_file: 'deny' }, askTimeoutMs: 1000 },
    }));
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.settings.permission!.rules).toMatchObject({
      write_file: 'deny',
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
      task: 'deny',
    });
    expect(child.settings.permission!.askTimeoutMs).toBe(1000);
  });

  it('none mode через funnel: permission сохраняется (тот же инвариант)', async () => {
    const parent = await makeParent(0);
    const request = vi.fn(async (req: { settings?: Partial<SessionSettings> }) => sessionManager.createSession({
      settings: req.settings,
    }));
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(state, opts({
      sessionManager,
      sessionId: parent.id,
      getRequestSessionService: () => ({ request }) as never,
      permissionConfig: { rules: { execute_shell: 'deny' }, askTimeoutMs: 500 },
    }));
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.settings.permission!.rules).toMatchObject({ execute_shell: 'deny', task: 'deny' });
  });

  it('ADR-089: при наличии funnel создаёт сессию через request(initiator=agent)', async () => {
    const parent = await makeParent(0);
    interface CreateReq {
      title?: string;
      projectId?: string;
      parentId?: string;
      sessionOrigin?: SessionOrigin;
      settings?: Partial<SessionSettings>;
    }
    const request = vi.fn(async (req: CreateReq, o?: { userId?: string; ownerId?: string }) => sessionManager.createSession({
      title: req.title,
      projectId: req.projectId,
      parentId: req.parentId,
      sessionOrigin: req.sessionOrigin,
      settings: req.settings,
      userId: o?.userId,
      ownerId: o?.ownerId,
    }));
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({
      sessionManager,
      sessionId: parent.id,
      getRequestSessionService: () => ({ request }) as never,
    }));

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      initiator: 'agent',
      intent: 'explicit',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      title: 'Subtask: do the thing',
    });
    expect(request.mock.calls[0]![1]).toEqual({ userId: parent.userId, ownerId: parent.ownerId });
    expect(state.childSessionId).toBeDefined();
  });

  it('funnel вернул null → ошибка проглатывается, дочерней сессии нет', async () => {
    const parent = await makeParent(0);
    const request = vi.fn(async () => null);
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({
      sessionManager,
      sessionId: parent.id,
      getRequestSessionService: () => ({ request }) as never,
    }));

    expect(state.childSessionId).toBeUndefined();
  });
});

describe('prepareChildSession — режимы с контекстом', () => {
  it('inherit: форкает историю, копирует mode/userId/ownerId и не трогает сообщения напрямую', async () => {
    const parent = await makeParent();
    await sessionManager.updateSession({ ...parent, mode: 'plan' });
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({ sessionManager, sessionId: parent.id }, { contextMode: 'inherit' }));

    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.mode).toBe('plan');
    expect(child.messages.length).toBeGreaterThan(0);
    expect(child.messages.every((m) => m.origin === 'inherited')).toBe(true);
    expect(state.childMessages.map((m) => m.content)).toEqual(child.messages.map((m) => m.content));
  });

  it('fork-режимы сохраняют permission саб-агента (правила родителя + deny-дополнения)', async () => {
    const parent = await makeParent();
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts(
      {
        sessionManager,
        sessionId: parent.id,
        permissionConfig: { rules: { write_file: 'deny' }, askTimeoutMs: 1000 },
      },
      { contextMode: 'inherit' },
    ));

    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.settings.permission!.rules).toMatchObject({
      write_file: 'deny',
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
      task: 'deny',
    });
    expect(child.settings.permission!.askTimeoutMs).toBe(1000);
  });

  it.each(['inherit', 'last_n', 'summary'] as const)(
    '%s: permission ребёнка = derivedPermission родителя (поведение не изменилось)',
    async (mode) => {
      const parent = await makeParent(3);
      const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

      await prepareChildSession(state, opts(
        {
          sessionManager,
          sessionId: parent.id,
          permissionConfig: { rules: { write_file: 'deny' }, askTimeoutMs: 1000 },
          // summary без оптимизатора откатывается к none — даём заглушку.
          contextOptimizer: { summarize: async () => makeMsg('s', MessageRole.SUMMARY) } as never,
        },
        { contextMode: mode },
      ));

      const child = (await sessionManager.getSession(state.childSessionId!))!;
      expect(child.settings.permission!.rules).toMatchObject({
        write_file: 'deny',
        question: 'deny',
        plan_enter: 'deny',
        plan_exit: 'deny',
        task: 'deny',
      });
      expect(child.settings.permission!.askTimeoutMs).toBe(1000);
    },
  );

  it('last_n: форк с messageIndex = max(0, messages.length - contextCount)', async () => {
    const parent = await makeParent(5);
    const forkSpy = vi.spyOn(sessionManager, 'forkSession');
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts(
      { sessionManager, sessionId: parent.id },
      { contextMode: 'last_n', contextCount: 2 },
    ));

    expect(forkSpy).toHaveBeenCalledTimes(1);
    expect(forkSpy.mock.calls[0]![1]).toMatchObject({ messageIndex: 3 });
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.branchPoint).toBe(parent.messages[3]!.id);
    expect(state.childMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('summary c contextOptimizer: добавляет SUMMARY и отключает унаследованные сообщения', async () => {
    const parent = await makeParent(3);
    const summaryMsg = makeMsg('compressed history', MessageRole.SUMMARY);
    const summarize = vi.fn(async () => summaryMsg);
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts(
      { sessionManager, sessionId: parent.id, contextOptimizer: { summarize } as never },
      { contextMode: 'summary' },
    ));

    expect(summarize).toHaveBeenCalledTimes(1);
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    const summaries = child.messages.filter((m) => m.role === MessageRole.SUMMARY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.content).toBe('compressed history');
    // Все прочие (унаследованные) сообщения отключены — контекст заменён саммари.
    expect(child.messages.filter((m) => m.role !== MessageRole.SUMMARY).every((m) => m.disabled)).toBe(true);
    expect(state.childMessages.map((m) => m.content)).toEqual(child.messages.map((m) => m.content));
  });

  it('summary без contextOptimizer → откат к none (форк НЕ делается)', async () => {
    const parent = await makeParent(3);
    const forkSpy = vi.spyOn(sessionManager, 'forkSession');
    const createSpy = vi.spyOn(sessionManager, 'createSession');
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts(
      { sessionManager, sessionId: parent.id },
      { contextMode: 'summary' },
    ));

    expect(forkSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const child = (await sessionManager.getSession(state.childSessionId!))!;
    expect(child.messages).toEqual([]);
  });
});

describe('prepareChildSession — заметки родителя / события / хуки', () => {
  it('parentNotesText собирает только активные sticky notes', async () => {
    const parent = await makeParent(0);
    await sessionManager.updateSession({
      ...parent,
      stickyNotes: [
        { id: 'n1', content: 'active note', createdAt: nowISO(), updatedAt: nowISO(), disabled: false },
        { id: 'n2', content: 'disabled note', createdAt: nowISO(), updatedAt: nowISO(), disabled: true },
      ],
    });
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({ sessionManager, sessionId: parent.id }));

    expect(state.parentNotesText).toBe('active note');
  });

  it('публикует session.created в канал родителя при наличии eventBus', async () => {
    const parent = await makeParent(0);
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe(parent.id, (e) => events.push(e.type));
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({ sessionManager, sessionId: parent.id, eventBus: bus }));

    expect(events).toEqual(['session.created']);
  });

  it('эмитит agent_spawned (async) с agentId дочерней сессии (ADR-030)', async () => {
    const parent = await makeParent(0);
    const hooks = new HookBus();
    const spawned = vi.fn();
    hooks.on('agent_spawned', spawned, { mode: 'async' });
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };

    await prepareChildSession(state, opts({ sessionManager, sessionId: parent.id, hooks }));

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    expect(spawned.mock.calls[0]![0]).toMatchObject({
      agentId: state.childSessionId,
      agentType: 'explore',
      parentId: parent.id,
    });
  });
});
