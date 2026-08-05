import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Message } from '@synth/shared';
import { MessageRole, generateId, makeTextPart, TsmState, nowISO } from '@synth/shared';

describe('SessionManager', () => {
  let store: FileStore;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store);
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

  it('createSession создаёт сессию с дефолтными настройками', async () => {
    const session = await manager.createSession({ title: 'Test' });
    expect(session.id).toBeDefined();
    expect(session.title).toBe('Test');
    expect(session.engine).toBe('synth');
    expect(session.status.state).toBe('planning');
    expect(session.settings.temperature).toBe(0.7);
  });

  it('createSession по умолчанию выключает маршрутизацию (согласовано с UI-дефолтом)', async () => {
    const session = await manager.createSession({});
    expect(session.settings.routingEnabled).toBe(false);
    expect(session.settings.routingEscalation.enabled).toBe(false);
    expect(session.settings.subagentRouting.enabled).toBe(false);
  });

  it('createSession сохраняет явно переданные настройки маршрутизации', async () => {
    const session = await manager.createSession({
      settings: {
        routingEnabled: true,
        routingEscalation: { enabled: true, fallbackProvider: 'itphx', fallbackModel: 'local.qwen3:14b', checks: ['min_length'] as const, minLength: 5 },
      },
    });
    expect(session.settings.routingEnabled).toBe(true);
    expect(session.settings.routingEscalation.enabled).toBe(true);
    expect(session.settings.routingEscalation.minLength).toBe(5);
  });

  it('createSession копирует глобальные mcpToolSettings, если сессия их не задала', async () => {
    const global = {
      github: { default: { plan: false, act: true } },
    };
    const managerWithGlobal = new SessionManager(store, {
      mcpSettingsProvider: async () => global,
    });
    const session = await managerWithGlobal.createSession({});
    expect(session.settings.mcpToolSettings).toEqual(global);
  });

  it('createSession объединяет глобальные и сессионные mcpToolSettings (сессия приоритетнее)', async () => {
    const global = {
      github: { default: { plan: false, act: true } },
      gitlab: { default: { plan: true, act: true } },
    };
    const local = {
      github: { default: { plan: true, act: false }, tools: { list_issues: { plan: true, act: false } } },
    };
    const managerWithGlobal = new SessionManager(store, {
      mcpSettingsProvider: async () => global,
    });
    const session = await managerWithGlobal.createSession({ settings: { mcpToolSettings: local } });
    expect(session.settings.mcpToolSettings).toEqual({
      github: {
        default: { plan: true, act: false },
        tools: { list_issues: { plan: true, act: false } },
      },
      gitlab: { default: { plan: true, act: true } },
    });
  });

  it('createSession без провайдера и без сессионных mcpToolSettings не задаёт их', async () => {
    const session = await manager.createSession({});
    expect(session.settings.mcpToolSettings).toBeUndefined();
  });

  it('getSession возвращает созданную сессию', async () => {
    const created = await manager.createSession({});
    const loaded = await manager.getSession(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
  });

  it('deleteSession удаляет сессию и очищает лок', async () => {
    const session = await manager.createSession({});
    await manager.deleteSession(session.id);
    const loaded = await manager.getSession(session.id);
    expect(loaded).toBeNull();
  });

  it('withLock сериализует операции на одной сессии', async () => {
    const session = await manager.createSession({ title: 'Lock' });
    const order: string[] = [];

    const p1 = manager.withLock(session.id, async (_s) => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });

    const p2 = manager.withLock(session.id, async () => {
      order.push('b');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('acquireLock / releaseLock работают', async () => {
    const session = await manager.createSession({});

    const ok = await manager.acquireLock(session.id, 'proc-1');
    expect(ok).toBe(true);

    const loaded = await manager.getSession(session.id);
    expect(loaded!.status.blocked).toBe('proc-1');

    const released = await manager.releaseLock(session.id, 'proc-1');
    expect(released).toBe(true);

    const afterRelease = await manager.getSession(session.id);
    expect(afterRelease!.status.blocked).toBeUndefined();
  });

  it('acquireLock возвращает false если сессия уже заблокирована', async () => {
    const session = await manager.createSession({});
    await manager.acquireLock(session.id, 'proc-1');
    const second = await manager.acquireLock(session.id, 'proc-2');
    expect(second).toBe(false);
  });

  it('forceReleaseLock снимает любую блокировку', async () => {
    const session = await manager.createSession({});
    await manager.acquireLock(session.id, 'proc-1');
    const released = await manager.forceReleaseLock(session.id);
    expect(released).toBe(true);
    const loaded = await manager.getSession(session.id);
    expect(loaded!.status.blocked).toBeUndefined();
  });

  it('addPendingMessage ограничивает очередь maxPending', async () => {
    const session = await manager.createSession({});
    const maxPending = 2;

    for (let i = 0; i < maxPending; i++) {
      const result = await manager.addPendingMessage(session.id, makeMsg(`msg-${i}`), maxPending);
      expect(result).not.toBeNull();
    }

    const overflow = await manager.addPendingMessage(session.id, makeMsg('overflow'), maxPending);
    expect(overflow).toBeNull();
  });

  it('addPendingMessage при maxPending=5 по умолчанию', async () => {
    const session = await manager.createSession({});
    for (let i = 0; i < 5; i++) {
      const result = await manager.addPendingMessage(session.id, makeMsg(`msg-${i}`));
      expect(result).not.toBeNull();
    }
    const overflow = await manager.addPendingMessage(session.id, makeMsg('overflow'));
    expect(overflow).toBeNull();
  });

  it('safeUpdate сохраняет изменения', async () => {
    const session = await manager.createSession({ title: 'Before' });
    await manager.safeUpdate(session.id, (_s) => {
      _s.title = 'After';
    });
    const loaded = await manager.getSession(session.id);
    expect(loaded!.title).toBe('After');
  });

  it('cleanupStaleLocks снимает истёкшие блокировки', async () => {
    const session = await manager.createSession({});
    await manager.acquireLock(session.id, 'old');
    // Искусственно ставим blockedAt в прошлое
    await manager.safeUpdate(session.id, (_s) => {
      _s.status.blockedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    });

    const stale = await manager.cleanupStaleLocks(15);
    expect(stale).toContain(session.id);
  });

  it('createCheckpoint создаёт и восстанавливается', async () => {
    const session = await manager.createSession({});
    await manager.addMessage(session.id, makeMsg('hello'));

    const withCheckpoint = await manager.createCheckpoint(session.id);
    expect(withCheckpoint!.checkpoints).toHaveLength(1);
    const cpId = withCheckpoint!.checkpoints[0]!.id;

    // Добавляем ещё сообщение
    await manager.addMessage(session.id, makeMsg('world'));

    // Восстанавливаем чекпоинт
    const restored = await manager.restoreCheckpoint(session.id, cpId);
    expect(restored).not.toBeNull();
    expect(restored!.messages).toHaveLength(1);
    expect(restored!.messages[0]!.content).toBe('hello');
  });
});

describe('AD-033: Session forking and branching', () => {
  let store: FileStore;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fork-test-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMsg(content: string, role: MessageRole = MessageRole.USER): Message {
    return {
      id: generateId(),
      role,
      seq: 0,
      origin: 'local' as const,
      parts: [makeTextPart(content)],
      content,
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  // ─── Слой 2: Ветвление (fork) ─────────────────────────────────────

  it('forkSession создаёт дочернюю сессию с parentId', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('Сообщение 1'));

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.id).toBeDefined();
    expect(fork.parentId).toBe(parent.id);
    expect(fork.sessionOrigin).toBe('fork');
  });

  it('forkSession копирует сообщения с origin=inherited и sourceMsgId', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('Привет'));
    await manager.addMessage(parent.id, makeMsg('Как дела?', MessageRole.ASSISTANT));

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.messages).toHaveLength(2);
    expect(fork.messages[0]!.origin).toBe('inherited');
    expect(fork.messages[1]!.origin).toBe('inherited');
    expect(fork.messages[0]!.sourceMsgId).toBeDefined();
    expect(fork.messages[1]!.sourceMsgId).toBeDefined();
    expect(fork.messages[0]!.content).toBe('Привет');
    expect(fork.messages[1]!.content).toBe('Как дела?');
  });

  it('forkSession нумерует seq последовательно с 1', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('A'));
    await manager.addMessage(parent.id, makeMsg('B'));
    await manager.addMessage(parent.id, makeMsg('C'));

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.messages).toHaveLength(3);
    expect(fork.messages[0]!.seq).toBe(1);
    expect(fork.messages[1]!.seq).toBe(2);
    expect(fork.messages[2]!.seq).toBe(3);
  });

  it('forkSession устанавливает branchPoint в messageId при options.messageId', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const result = await manager.addMessage(parent.id, makeMsg('Первый'));
    await manager.addMessage(parent.id, makeMsg('Второй'));

    const fork = await manager.forkSession(parent.id, { messageId: result!.messages[0]!.id });
    expect(fork.branchPoint).toBe(result!.messages[0]!.id);
  });

  it('forkSession устанавливает branchPoint по messageIndex если messageId не указан', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const msg1 = await manager.addMessage(parent.id, makeMsg('Первый'));
    await manager.addMessage(parent.id, makeMsg('Второй'));

    const fork = await manager.forkSession(parent.id, { messageIndex: 0 });
    // branchPoint должен быть id сообщения на индексе 0
    expect(fork.branchPoint).toBe(msg1!.messages[0]!.id);
  });

  it('forkSession обрезает сообщения по messageIndex — не включает user-сообщение на границе', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('User 1'));
    await manager.addMessage(parent.id, makeMsg('Assistant 1', MessageRole.ASSISTANT));
    await manager.addMessage(parent.id, makeMsg('User 2'));

    // обрезаем до индекса 2 (User 2) — не включаем его (role=USER)
    const fork = await manager.forkSession(parent.id, { messageIndex: 2 });
    expect(fork.messages).toHaveLength(2);
    expect(fork.messages[0]!.content).toBe('User 1');
    expect(fork.messages[1]!.content).toBe('Assistant 1');
  });

  it('forkSession обрезает сообщения по messageIndex — включает assistant-сообщение на границе', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('User 1'));
    await manager.addMessage(parent.id, makeMsg('Assistant 1', MessageRole.ASSISTANT));
    await manager.addMessage(parent.id, makeMsg('User 2'));
    await manager.addMessage(parent.id, makeMsg('Assistant 2', MessageRole.ASSISTANT));

    // обрезаем до индекса 3 (Assistant 2) — включаем его (role=ASSISTANT)
    const fork = await manager.forkSession(parent.id, { messageIndex: 3 });
    expect(fork.messages).toHaveLength(4);
    expect(fork.messages[3]!.content).toBe('Assistant 2');
  });

  it('forkSession без точки обрезки копирует все сообщения', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('A'));
    await manager.addMessage(parent.id, makeMsg('B'));
    await manager.addMessage(parent.id, makeMsg('C'));

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.messages).toHaveLength(3);
    expect(fork.messages[0]!.content).toBe('A');
    expect(fork.messages[1]!.content).toBe('B');
    expect(fork.messages[2]!.content).toBe('C');
  });

  it('forkSession сбрасывает TSM в PLANNING', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.updateTsmState(parent.id, TsmState.EXECUTION);

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.status.state).toBe('planning');
    expect(fork.status.iteration).toBe(0);
    expect(fork.status.validationAttempts).toBe(0);
  });

  it('forkSession очищает pendingMessages', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addPendingMessage(parent.id, makeMsg('pending'));

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.pendingMessages).toHaveLength(0);
  });

  it('forkSession копирует настройки из родительской сессии', async () => {
    const parent = await manager.createSession({
      title: 'Parent',
      settings: { ...(await manager.createSession({})).settings, model: 'gpt-4', temperature: 0.3 },
    });

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.settings.model).toBe(parent.settings.model);
    expect(fork.settings.temperature).toBe(parent.settings.temperature);
  });

  it('forkSession из пустой сессии создаёт пустую дочернюю', async () => {
    const parent = await manager.createSession({ title: 'Empty' });
    const fork = await manager.forkSession(parent.id, {});
    expect(fork.messages).toHaveLength(0);
    expect(fork.parentId).toBe(parent.id);
  });

  it('forkSession с кастомным названием', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const fork = await manager.forkSession(parent.id, { title: 'Мой форк' });
    expect(fork.title).toBe('Мой форк');
  });

  it('forkSession генерирует уникальное название с нумерацией', async () => {
    const parent = await manager.createSession({ title: 'Исследование' });
    const fork1 = await manager.forkSession(parent.id, {});
    expect(fork1.title).toBe('Исследование (fork #1)');

    const fork2 = await manager.forkSession(parent.id, {});
    expect(fork2.title).toBe('Исследование (fork #2)');
  });

  it('forkSession выбрасывает ошибку для несуществующей сессии', async () => {
    await expect(manager.forkSession('non-existent', {})).rejects.toThrow('Session non-existent not found');
  });

  it('forkSession проставляет новые id у скопированных сообщений', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const msg = await manager.addMessage(parent.id, makeMsg('test'));
    const originalId = msg!.messages[0]!.id;

    const fork = await manager.forkSession(parent.id, {});
    expect(fork.messages[0]!.id).not.toBe(originalId);
    expect(fork.messages[0]!.sourceMsgId).toBe(originalId);
  });

  // ─── createSession с parentId ─────────────────────────────────────

  it('createSession принимает parentId', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const child = await manager.createSession({
      title: 'Child',
      parentId: parent.id,
      sessionOrigin: 'subagent',
    });
    expect(child.parentId).toBe(parent.id);
    expect(child.sessionOrigin).toBe('subagent');
  });

  // ─── getChildren / getSessionTree ─────────────────────────────────

  it('getChildren возвращает дочерние сессии', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.forkSession(parent.id, { title: 'Fork 1' });
    await manager.forkSession(parent.id, { title: 'Fork 2' });

    const children = await manager.getChildren(parent.id);
    expect(children).toHaveLength(2);
    const titles = children.map((c) => c.title).sort();
    expect(titles).toEqual(['Fork 1', 'Fork 2']);
  });

  it('getChildren не возвращает сессии других родителей', async () => {
    const parent1 = await manager.createSession({ title: 'P1' });
    const parent2 = await manager.createSession({ title: 'P2' });
    await manager.forkSession(parent1.id, { title: 'Fork of P1' });
    await manager.forkSession(parent2.id, { title: 'Fork of P2' });

    const children = await manager.getChildren(parent1.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.title).toBe('Fork of P1');
  });

  it('getSessionTree строит дерево сессий', async () => {
    const root = await manager.createSession({ title: 'Root' });
    const fork1 = await manager.forkSession(root.id, { title: 'Fork 1' });
    await manager.forkSession(root.id, { title: 'Fork 2' });
    await manager.forkSession(fork1.id, { title: 'Subfork' });

    const tree = await manager.getSessionTree(root.id);
    expect(tree.session).not.toBeNull();
    expect(tree.session!.id).toBe(root.id);
    expect(tree.children).toHaveLength(2);
    // Находим Fork 1 в детях
    const fork1Node = tree.children.find((c) => c.session?.title === 'Fork 1');
    expect(fork1Node).toBeDefined();
    expect(fork1Node!.children).toHaveLength(1);
    expect(fork1Node!.children[0]!.session?.title).toBe('Subfork');
  });

  it('getSessionTree возвращает null session для несуществующей', async () => {
    const tree = await manager.getSessionTree('nonexistent');
    expect(tree.session).toBeNull();
    expect(tree.children).toHaveLength(0);
  });

  // ─── addMessage origin tracking (Слой 2) ─────────────────────────

  it('addMessage проставляет origin=local по умолчанию', async () => {
    const session = await manager.createSession({});
    const result = await manager.addMessage(session.id, makeMsg('test'));
    expect(result!.messages[0]!.origin).toBe('local');
  });

  it('addMessage проставляет seq автоматически', async () => {
    const session = await manager.createSession({});
    await manager.addMessage(session.id, makeMsg('first'));
    await manager.addMessage(session.id, makeMsg('second'));
    const r3 = await manager.addMessage(session.id, makeMsg('third'));
    expect(r3!.messages[2]!.seq).toBe(3);
  });

  // ─── Subagent session (Слой 1) ────────────────────────────────────

  it('createSession с sessionOrigin=subagent создаёт сессию саб-агента', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    const sub = await manager.createSession({
      title: 'Подзадача: анализ',
      projectId: parent.projectId,
      engine: parent.engine,
      parentId: parent.id,
      sessionOrigin: 'subagent',
      settings: { ...parent.settings, agentRole: 'explore' },
    });
    expect(sub.parentId).toBe(parent.id);
    expect(sub.sessionOrigin).toBe('subagent');
    expect(sub.settings.agentRole).toBe('explore');
  });

  // ─── Persistence: parent_id и branch_point ──────────────────────

  it('parent_id и branch_point сохраняются через FileStore save/load', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('user-msg'));
    await manager.addMessage(parent.id, makeMsg('assistant-reply', MessageRole.ASSISTANT));
    const fork = await manager.forkSession(parent.id, { messageIndex: 1 });
    const forkId = fork.id;

    // загружаем заново из стора
    const loaded = await manager.getSession(forkId);
    expect(loaded).not.toBeNull();
    expect(loaded!.parentId).toBe(parent.id);
    expect(loaded!.branchPoint).toBeDefined();
    expect(loaded!.sessionOrigin).toBe('fork');

    // messageIndex:1 — assistant сообщение на границе включается (2 сообщения скопированы)
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]!.origin).toBe('inherited');
    expect(loaded!.messages[0]!.sourceMsgId).toBeDefined();
    expect(loaded!.messages[0]!.seq).toBe(1);
  });

  // ─── Message origin enum coverage ────────────────────────────────

  it('MessageOrigin поддерживает все 4 значения из AD-033', async () => {
    // Проверяем что тип MessageOrigin включает все нужные литералы
    const origins: Array<'local' | 'inherited' | 'merged' | 'crosspost'> = ['local', 'inherited', 'merged', 'crosspost'];
    expect(origins).toHaveLength(4);

    // Проверяем что message может принять merged/crosspost (хотя логика ещё не реализована)
    const session = await manager.createSession({});
    const mergedMsg: Message = { ...makeMsg('merged'), origin: 'merged', sourceMsgId: 'orig-123' };
    await manager.addMessage(session.id, mergedMsg);
    const loaded = await manager.getSession(session.id);
    expect(loaded!.messages[0]!.origin).toBe('merged');
    expect(loaded!.messages[0]!.sourceMsgId).toBe('orig-123');

    const crossMsg: Message = { ...makeMsg('crosspost'), origin: 'crosspost' };
    await manager.addMessage(session.id, crossMsg);
    const loaded2 = await manager.getSession(session.id);
    expect(loaded2!.messages[1]!.origin).toBe('crosspost');
  });

  // ─── SessionOrigin enum coverage ─────────────────────────────────

  it('SessionOrigin поддерживает user/fork/subagent из AD-033', () => {
    const origins: Array<'user' | 'fork' | 'subagent'> = ['user', 'fork', 'subagent'];
    expect(origins).toHaveLength(3);
  });

  // ─── Слой 3: подготовка структур данных (данные могут храниться) ──

  it('sourceMsgId может быть установлен на произвольное значение', async () => {
    const session = await manager.createSession({});
    const msg: Message = {
      ...makeMsg('сообщение со ссылкой'),
      origin: 'merged',
      sourceMsgId: 'session-abc::msg-42',
    };
    await manager.addMessage(session.id, msg);
    const loaded = await manager.getSession(session.id);
    expect(loaded!.messages[0]!.sourceMsgId).toBe('session-abc::msg-42');
    expect(loaded!.messages[0]!.origin).toBe('merged');
  });

  // ─── Edge cases ─────────────────────────────────────────────────

  it('forkSession с отрицательным messageIndex копирует все сообщения', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('A'));
    await manager.addMessage(parent.id, makeMsg('B'));

    const fork = await manager.forkSession(parent.id, { messageIndex: -1 });
    expect(fork.messages).toHaveLength(2);
  });

  it('forkSession с messageIndex больше чем сообщений копирует все', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    await manager.addMessage(parent.id, makeMsg('A'));

    const fork = await manager.forkSession(parent.id, { messageIndex: 99 });
    expect(fork.messages).toHaveLength(1);
  });

  it('forkSession копирует активные stickyNotes из родительской сессии', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    // Добавляем заметки: одна активная, одна disabled
    parent.stickyNotes = [
      { id: 'n1', content: 'Важное решение: использовать SQLite', createdAt: nowISO(), updatedAt: nowISO(), disabled: false },
      { id: 'n2', content: 'Игнорируемая заметка', createdAt: nowISO(), updatedAt: nowISO(), disabled: true },
    ];
    await manager.updateSession(parent);

    const fork = await manager.forkSession(parent.id, {});

    // Только активная заметка скопирована
    expect(fork.stickyNotes).toHaveLength(1);
    expect(fork.stickyNotes[0]!.content).toBe('Важное решение: использовать SQLite');
    // ID регенерирован
    expect(fork.stickyNotes[0]!.id).not.toBe('n1');
    // Флаг disabled сброшен у копии
    expect(fork.stickyNotes[0]!.disabled).toBe(false);
  });

  it('forkSession копирует пустые stickyNotes без ошибок', async () => {
    const parent = await manager.createSession({ title: 'Parent' });
    // stickyNotes уже пустые по умолчанию
    const fork = await manager.forkSession(parent.id, {});
    expect(fork.stickyNotes).toEqual([]);
  });
});
