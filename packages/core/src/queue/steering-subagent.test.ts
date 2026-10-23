/**
 * ADR-104 (этап 3): очередь инъекций `steerInbox` — персистентность и
 * изоляция между родительской сессией и дочерней `task`-сессией.
 *
 * Граница осознанная: инъекция адресна **конкретной** сессии. Очередь
 * родителя и очередь дочерней сессии — разные записи сессий, поэтому
 * вмешательство в ребёнка не попадает в родителя и наоборот. Steering
 * фонового ребёнка (неблокирующая саб-агентская сессия) недоступен до
 * [PROP-096](../../../../docs/arch_decisions/prop-096-background-subagent-sessions.md)
 * — фоновых сессий в коде нет.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { enqueueSteerMessage } from './processor.js';
import { prepareChildSession, type PreparedChildSession } from '../engine/tools/task/fork.js';
import type { TaskExtra } from '../engine/tools/task/types.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeSteerMessage(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('ADR-104: steerInbox — персистентность и изоляция родителя/ребёнка', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-steer-sub-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('очередь инъекций персистится как часть записи сессии', async () => {
    const session = await sessionManager.createSession({ title: 'Родитель' });
    await enqueueSteerMessage(sessionManager, eventBus, session.id, makeSteerMessage('вмешайся'));

    // 1. В записи сессии на диске — отдельное поле очереди инъекций.
    const raw = JSON.parse(
      await readFile(join(tmpDir, 'sessions', `${session.id}.json`), 'utf-8'),
    ) as { steer_inbox?: Array<{ content?: string; metadata?: Record<string, unknown> }> };
    expect(raw.steer_inbox).toHaveLength(1);
    expect(raw.steer_inbox![0]!.content).toBe('вмешайся');
    expect(raw.steer_inbox![0]!.metadata?.steer).toBe(true);

    // 2. Свежий менеджер над тем же каталогом видит ту же очередь —
    //    очередь не «живёт» только в памяти.
    const fresh = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const reloaded = (await fresh.getSession(session.id))!;
    expect(reloaded.steerInbox).toHaveLength(1);
    expect(reloaded.steerInbox![0]!.content).toBe('вмешайся');
    expect(reloaded.steerInbox![0]!.metadata?.steer).toBe(true);
  });

  it('инъекция в дочернюю task-сессию не попадает в родительскую', async () => {
    const parent = await sessionManager.createSession({ title: 'Родитель' });
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(state, {
      extra: { sessionManager, sessionId: parent.id } as TaskExtra,
      description: 'разведка',
      subagentType: 'explore',
      contextMode: 'none',
      contextCount: 4,
      childRoutingOverrides: {},
    });
    const childId = state.childSessionId!;
    expect(childId).toBeDefined();

    await enqueueSteerMessage(sessionManager, eventBus, childId, makeSteerMessage('ребёнку'));

    const child = (await sessionManager.getSession(childId))!;
    expect(child.steerInbox).toHaveLength(1);
    expect(child.steerInbox![0]!.content).toBe('ребёнку');

    // Очередь родителя пуста — инъекция адресна ребёнку.
    const parentAfter = (await sessionManager.getSession(parent.id))!;
    expect(parentAfter.steerInbox ?? []).toHaveLength(0);

    // Вычитка родителя не забирает инъекцию ребёнка.
    const taken = await sessionManager.takeSteerMessages(parent.id);
    expect(taken.messages).toEqual([]);
    const childAfterTake = (await sessionManager.getSession(childId))!;
    expect(childAfterTake.steerInbox).toHaveLength(1);
  });

  it('инъекция в родительскую сессию не попадает в дочернюю task-сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'Родитель' });
    const state: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(state, {
      extra: { sessionManager, sessionId: parent.id } as TaskExtra,
      description: 'разведка',
      subagentType: 'explore',
      contextMode: 'none',
      contextCount: 4,
      childRoutingOverrides: {},
    });
    const childId = state.childSessionId!;

    await enqueueSteerMessage(sessionManager, eventBus, parent.id, makeSteerMessage('родителю'));

    const parentAfter = (await sessionManager.getSession(parent.id))!;
    expect(parentAfter.steerInbox).toHaveLength(1);
    expect(parentAfter.steerInbox![0]!.content).toBe('родителю');

    const child = (await sessionManager.getSession(childId))!;
    expect(child.steerInbox ?? []).toHaveLength(0);

    // Вычитка ребёнка не забирает инъекцию родителя.
    const taken = await sessionManager.takeSteerMessages(childId);
    expect(taken.messages).toEqual([]);
    const parentAfterTake = (await sessionManager.getSession(parent.id))!;
    expect(parentAfterTake.steerInbox).toHaveLength(1);
  });
});
