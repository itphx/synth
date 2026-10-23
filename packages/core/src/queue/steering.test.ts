/**
 * PROP-098: очередь инъекций (`steerInbox`) — FIFO, лимит инъекций на ход
 * и отказ с понятной ошибкой (STEER_LIMIT_EXCEEDED).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { enqueueSteerMessage } from './processor.js';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  MAX_STEER_INJECTIONS_PER_TURN,
  STEERING_ERROR_CODES,
} from '@itphx/synth-shared';
import type { Message, BusEvent } from '@itphx/synth-shared';

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

describe('PROP-098: очередь инъекций (steerInbox)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-steer-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'Steer' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('FIFO: инъекции вычитываются в порядке постановки', async () => {
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('первая'));
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('вторая'));
    await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage('третья'));

    const { messages, dropped } = await sessionManager.takeSteerMessages(sessionId);
    expect(messages.map((m) => m.content)).toEqual(['первая', 'вторая', 'третья']);
    expect(dropped).toEqual([]);

    // Очередь вычищена — повторный вызов пуст.
    const second = await sessionManager.takeSteerMessages(sessionId);
    expect(second.messages).toEqual([]);
  });

  it('лимит 5 инъекций на ход: шестая отклоняется, публикуется steer.dropped', async () => {
    const events: BusEvent[] = [];
    eventBus.subscribe(sessionId, (event) => events.push(event));

    for (let i = 0; i < MAX_STEER_INJECTIONS_PER_TURN; i++) {
      const result = await enqueueSteerMessage(
        sessionManager, eventBus, sessionId, makeSteerMessage(`инъекция ${i}`),
      );
      expect(result.accepted).toBe(true);
    }

    const overflow = await enqueueSteerMessage(
      sessionManager, eventBus, sessionId, makeSteerMessage('лишняя'),
    );
    expect(overflow.accepted).toBe(false);
    expect(overflow.reason).toBe('limit');
    expect(overflow.pending).toBe(MAX_STEER_INJECTIONS_PER_TURN);

    const dropped = events.find((e) => e.type === 'steer.dropped');
    expect(dropped).toBeDefined();
    expect(dropped!.data.code).toBe(STEERING_ERROR_CODES.limitExceeded);
    expect(dropped!.data.limit).toBe(MAX_STEER_INJECTIONS_PER_TURN);

    // В очереди осталось ровно 5 сообщений (лишнее не копится).
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.steerInbox).toHaveLength(MAX_STEER_INJECTIONS_PER_TURN);
  });

  it('принятое сообщение помечено metadata.steer (признак вмешательства)', async () => {
    await enqueueSteerMessage(sessionManager, eventBus, sessionId, makeSteerMessage('вмешательство'));
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.steerInbox?.[0]?.metadata?.steer).toBe(true);
  });

  it('вычитка сверх лимита: остаток возвращается как dropped (не теряется молча)', async () => {
    // Ставим 7 сообщений напрямую (лимит store не мешает при своём max),
    // затем вычитываем с лимитом хода — 5 забираются, 2 отбрасываются.
    for (let i = 0; i < 7; i++) {
      await sessionManager.enqueueSteerMessage(sessionId, makeSteerMessage(`m${i}`), 10);
    }
    const { messages, dropped } = await sessionManager.takeSteerMessages(
      sessionId, MAX_STEER_INJECTIONS_PER_TURN,
    );
    expect(messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(dropped.map((m) => m.content)).toEqual(['m5', 'm6']);
  });
});
