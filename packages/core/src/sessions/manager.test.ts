import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Message } from '@synth/shared';
import { MessageRole } from '@synth/shared';

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
      role,
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
