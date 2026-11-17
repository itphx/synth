/**
 * Этап 2a: точечные мутации `SessionManager` (порт `mutateMeta`/`mutateHistory`/
 * `mutateMessage` + `appendMessage`) не теряют параллельные записи.
 *
 * Инцидент, ради которого вводились мутации: `save` пишет снимок сессии целиком,
 * поэтому `load` + правка в памяти + `save` затирала точечные дозаписи
 * сообщений (`appendMessage`), сделанные параллельно (lost update).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import {
  MessageRole,
  STEER_INTERRUPT_METADATA_KEY,
  generateId,
  makeTextPart,
  nowISO,
} from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeMsg(
  role: MessageRole,
  content: string,
  extra: Partial<Message> = {},
): Message {
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
    metadata: { stream_id: generateId() },
    ...extra,
  };
}

describe('SessionManager — точечные мутации (этап 2a)', () => {
  let store: FileStore;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mut-'));
    store = new FileStore({ dataDir: tmpDir });
    // Фиксированный id процесса: recovery отличает «свой» ход от чужого.
    manager = new SessionManager(store, { instanceId: 'me' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('инцидент: параллельные appendMessage не теряются при enqueueSteerMessage (20 прогонов)', async () => {
    for (let run = 0; run < 20; run++) {
      const session = await manager.createSession({ title: `incident-${run}` });

      // Два tool-сообщения дописываются, пока пользователь отправляет steer
      // (timer steer, без `fromPending` — правка только метаданных).
      const [first, second, steered] = await Promise.all([
        manager.appendMessage(session.id, makeMsg(MessageRole.TOOL, `tool-a-${run}`)),
        manager.appendMessage(session.id, makeMsg(MessageRole.TOOL, `tool-b-${run}`)),
        manager.enqueueSteerMessage(session.id, makeMsg(MessageRole.USER, `steer-${run}`)),
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(steered).toMatchObject({ accepted: true, pending: 1 });

      const loaded = (await manager.getSession(session.id))!;
      // Оба tool-сообщения на месте — правка очереди историю не перезаписала.
      expect(loaded.messages.map((m) => m.content).sort()).toEqual([
        `tool-a-${run}`,
        `tool-b-${run}`,
      ]);
      expect(loaded.steerInbox).toHaveLength(1);
      expect(loaded.steerInbox![0]!.content).toBe(`steer-${run}`);
      expect(loaded.pendingMessages).toHaveLength(0);
    }
  });

  it('enqueueSteerMessage({fromPending}): переносит в inbox и снимает user-копию из истории', async () => {
    const session = await manager.createSession({});
    const pending = makeMsg(MessageRole.USER, 'перенос');
    const streamId = pending.metadata!.stream_id as string;
    await manager.addPendingMessage(session.id, pending);
    // User-копия уже материализована (Phase 1 прошлого запуска).
    await manager.appendMessage(session.id, { ...pending, seq: 0 });
    const witness = makeMsg(MessageRole.ASSISTANT, 'остальная история');
    await manager.appendMessage(session.id, witness);

    const result = await manager.enqueueSteerMessage(session.id, pending, 10, { fromPending: true });

    expect(result).toMatchObject({ accepted: true, pending: 1 });
    const loaded = (await manager.getSession(session.id))!;
    expect(loaded.pendingMessages).toHaveLength(0);
    expect(loaded.steerInbox!.map((m) => m.id)).toEqual([pending.id]);
    // User-копия снята, остальная история цела.
    expect(
      loaded.messages.some((m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId),
    ).toBe(false);
    expect(loaded.messages.map((m) => m.id)).toEqual([witness.id]);
  });

  it('enqueueSteerMessage({fromPending}): копию активного стрима не удаляет', async () => {
    const session = await manager.createSession({});
    const pending = makeMsg(MessageRole.USER, 'активный стрим');
    const streamId = pending.metadata!.stream_id as string;
    await manager.addPendingMessage(session.id, pending);
    await manager.appendMessage(session.id, { ...pending, seq: 0 });

    const result = await manager.enqueueSteerMessage(session.id, pending, 10, {
      fromPending: true,
      activeStreamId: streamId,
    });

    expect(result.accepted).toBe(true);
    const loaded = (await manager.getSession(session.id))!;
    expect(loaded.pendingMessages).toHaveLength(0);
    expect(loaded.steerInbox).toHaveLength(1);
    // Активный стрим не трогаем — его user-копия остаётся в истории.
    expect(
      loaded.messages.filter(
        (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
      ),
    ).toHaveLength(1);
  });

  it('enqueueSteerMessage({fromPending}): лимит — accepted:false и ничего не изменено', async () => {
    const session = await manager.createSession({});
    // Заполняем inbox до лимита (1).
    await manager.enqueueSteerMessage(session.id, makeMsg(MessageRole.USER, 'уже в inbox'), 1);
    const pending = makeMsg(MessageRole.USER, 'не должен перенестись');
    await manager.addPendingMessage(session.id, pending);
    await manager.appendMessage(session.id, { ...pending, seq: 0 });

    const before = (await manager.getSession(session.id))!;
    const result = await manager.enqueueSteerMessage(session.id, pending, 1, { fromPending: true });
    const after = (await manager.getSession(session.id))!;

    expect(result).toMatchObject({ accepted: false, reason: 'limit' });
    // Ни очередь, ни история, ни inbox не тронуты — и записи не было
    // (`shouldWrite: accepted`, `updatedAt` не двигается).
    expect(after.pendingMessages.map((m) => m.id)).toEqual(before.pendingMessages.map((m) => m.id));
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.steerInbox!.map((m) => m.id)).toEqual(before.steerInbox!.map((m) => m.id));
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('enqueueSteerMessage({fromPending}): сообщения нет в очереди → not_found, история цела', async () => {
    const session = await manager.createSession({});
    const witness = makeMsg(MessageRole.ASSISTANT, 'история');
    await manager.appendMessage(session.id, witness);
    const ghost = makeMsg(MessageRole.USER, 'исчезло');

    const before = (await manager.getSession(session.id))!;
    const result = await manager.enqueueSteerMessage(session.id, ghost, 10, { fromPending: true });
    const after = (await manager.getSession(session.id))!;

    expect(result).toMatchObject({ accepted: false, reason: 'not_found' });
    expect(after.messages.map((m) => m.id)).toEqual([witness.id]);
    expect(after.steerInbox ?? []).toHaveLength(0);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('takeSteerMessages ∥ appendMessage: ничего не теряется, порядок инъекций прежний', async () => {
    for (let run = 0; run < 20; run++) {
      const session = await manager.createSession({});
      const first = makeMsg(MessageRole.USER, `steer-1-${run}`);
      const interrupt = makeMsg(MessageRole.USER, `steer-2-${run}`, {
        metadata: {
          stream_id: generateId(),
          [STEER_INTERRUPT_METADATA_KEY]: true,
        },
      });
      const third = makeMsg(MessageRole.USER, `steer-3-${run}`);
      await manager.enqueueSteerMessage(session.id, first);
      await manager.enqueueSteerMessage(session.id, interrupt);
      await manager.enqueueSteerMessage(session.id, third);

      const [taken, toolA, toolB] = await Promise.all([
        manager.takeSteerMessages(session.id, 10),
        manager.appendMessage(session.id, makeMsg(MessageRole.TOOL, `tool-a-${run}`)),
        manager.appendMessage(session.id, makeMsg(MessageRole.TOOL, `tool-b-${run}`)),
      ]);

      // Класс `interrupt` — раньше остальных, внутри класса FIFO (ADR-104).
      expect(taken.messages.map((m) => m.id)).toEqual([interrupt.id, first.id, third.id]);
      expect(taken.dropped).toEqual([]);
      expect(toolA).not.toBeNull();
      expect(toolB).not.toBeNull();

      const loaded = (await manager.getSession(session.id))!;
      expect(loaded.steerInbox ?? []).toHaveLength(0);
      expect(loaded.messages.map((m) => m.content).sort()).toEqual([
        `tool-a-${run}`,
        `tool-b-${run}`,
      ]);
    }
  });

  it('clearSteerInbox ∥ appendMessage: инъекции возвращаются целиком, история не теряется', async () => {
    for (let run = 0; run < 10; run++) {
      const session = await manager.createSession({});
      const first = makeMsg(MessageRole.USER, `a-${run}`);
      const second = makeMsg(MessageRole.USER, `b-${run}`);
      await manager.enqueueSteerMessage(session.id, first);
      await manager.enqueueSteerMessage(session.id, second);

      const [cleared, appended] = await Promise.all([
        manager.clearSteerInbox(session.id),
        manager.appendMessage(session.id, makeMsg(MessageRole.TOOL, `tool-${run}`)),
      ]);

      expect(cleared.map((m) => m.id)).toEqual([first.id, second.id]);
      expect(appended).not.toBeNull();

      const loaded = (await manager.getSession(session.id))!;
      expect(loaded.steerInbox ?? []).toHaveLength(0);
      expect(loaded.messages.map((m) => m.content)).toEqual([`tool-${run}`]);
    }
  });

  it('recoverStreamingMessages не пишет без изменений и пишет при изменениях', async () => {
    const session = await manager.createSession({});
    await manager.appendMessage(session.id, makeMsg(MessageRole.ASSISTANT, 'готовый ответ'));
    const frozen = '2024-01-01T00:00:00.000Z';
    // Метка времени, по которой видно, была ли запись (mutateHistory её двигает).
    await manager.mutateMeta(session.id, (meta) => {
      meta.updatedAt = frozen;
    }, { touchUpdatedAt: false });

    const changed = await manager.recoverStreamingMessages(session.id);
    expect(changed).toBe(0);
    expect((await manager.getSession(session.id))!.updatedAt).toBe(frozen);

    const draft = makeMsg(MessageRole.ASSISTANT, 'частичный', {
      status: 'streaming',
      metadata: { stream_id: generateId(), streaming: true },
    });
    await manager.appendMessage(session.id, draft);

    const repaired = await manager.recoverStreamingMessages(session.id);
    expect(repaired).toBeGreaterThan(0);
    const loaded = (await manager.getSession(session.id))!;
    expect(loaded.updatedAt).not.toBe(frozen);
    const fixed = loaded.messages.find((m) => m.id === draft.id)!;
    expect(fixed.status).not.toBe('streaming');
    expect(fixed.metadata?.streaming).toBe(false);
    expect(fixed.metadata?.interrupted).toBe(true);
  });

  it('recoverInterruptedSessions сохраняет pendingMessages, снимает маркеры и ретрай', async () => {
    const session = await manager.createSession({});
    const waiting = makeMsg(MessageRole.USER, 'ждёт своей очереди');
    await manager.addPendingMessage(session.id, waiting);
    await manager.mutateMeta(session.id, (meta) => {
      meta.currentStream = {
        streamId: 'dead-stream',
        message: 'оборванный ход',
        startedAt: nowISO(),
        cancelled: false,
        owner: 'other-process',
      };
      meta.status.blocked = 'other-process';
      meta.status.blockedAt = nowISO();
      meta.status.blockedOwner = 'other-process';
      meta.status.cancelRequested = true;
      meta.status.cancelRequestedAt = nowISO();
      meta.retry = {
        streamId: 'dead-stream',
        attempt: 2,
        maxRetries: 3,
        retryAt: nowISO(),
      };
    });

    const recovered = await manager.recoverInterruptedSessions();
    const entry = recovered.find((item) => item.sessionId === session.id);
    expect(entry).toBeDefined();
    expect(entry!.streamId).toBe('dead-stream');
    expect(entry!.pendingLeft).toBe(1);

    const loaded = (await manager.getSession(session.id))!;
    // Очередь не потеряна (сообщение не участвовало в оборванном ходе).
    expect(loaded.pendingMessages.map((m) => m.id)).toEqual([waiting.id]);
    expect(loaded.currentStream).toBeUndefined();
    expect(loaded.retry).toBeUndefined();
    expect(loaded.status.blocked).toBeUndefined();
    expect(loaded.status.blockedAt).toBeUndefined();
    expect(loaded.status.blockedOwner).toBeUndefined();
    expect(loaded.status.cancelRequested).toBeUndefined();
    expect(loaded.status.cancelRequestedAt).toBeUndefined();
  });

  // --- Паритет с прежним кодом: no-op не пишет сессию и не «оживляет» её
  // (`updatedAt` не двигается, иначе список сессий переупорядочивался бы).

  const FROZEN = '2024-01-01T00:00:00.000Z';

  /** Зафиксировать `updatedAt`, чтобы увидеть любую лишнюю запись. */
  async function freeze(sessionId: string): Promise<void> {
    await manager.mutateMeta(sessionId, (meta) => {
      meta.updatedAt = FROZEN;
    }, { touchUpdatedAt: false });
  }

  it('no-op не пишет: takeSteerMessages/clearSteerInbox при пустом inbox', async () => {
    const session = await manager.createSession({});
    await freeze(session.id);

    expect(await manager.takeSteerMessages(session.id)).toEqual({ messages: [], dropped: [] });
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);

    expect(await manager.clearSteerInbox(session.id)).toEqual([]);
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
  });

  it('no-op не пишет: addPendingMessage/enqueueSteerMessage при лимите', async () => {
    const session = await manager.createSession({});
    await manager.addPendingMessage(session.id, makeMsg(MessageRole.USER, 'в очереди'), 1);
    await freeze(session.id);

    // Очередь переполнена — сообщение не принято, записи нет.
    expect(await manager.addPendingMessage(session.id, makeMsg(MessageRole.USER, 'лишнее'), 1))
      .toBeNull();
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);

    // Inbox заполнен до лимита — steer отклонён, записи нет.
    await manager.enqueueSteerMessage(session.id, makeMsg(MessageRole.USER, 'в inbox'), 1);
    await freeze(session.id);
    const rejected = await manager.enqueueSteerMessage(
      session.id,
      makeMsg(MessageRole.USER, 'лишний steer'),
      1,
    );
    expect(rejected).toMatchObject({ accepted: false, reason: 'limit' });
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
  });

  it('no-op не пишет: renameSessionIfDefault при пользовательском заголовке', async () => {
    const session = await manager.createSession({ title: 'Мой заголовок' });
    await freeze(session.id);

    expect(await manager.renameSessionIfDefault(session.id, 'Другой')).toBeNull();
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
    expect((await manager.getSession(session.id))!.title).toBe('Мой заголовок');
  });

  it('no-op не пишет: повторный archiveSession', async () => {
    const session = await manager.createSession({});
    expect(await manager.archiveSession(session.id)).not.toBeNull();
    await freeze(session.id);

    expect(await manager.archiveSession(session.id)).toBeNull();
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
  });

  it('no-op не пишет: неудачные acquireLock/releaseLock', async () => {
    const session = await manager.createSession({});
    expect(await manager.acquireLock(session.id, 'p1')).toBe(true);
    await freeze(session.id);

    expect(await manager.acquireLock(session.id, 'p2')).toBe(false);
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);

    expect(await manager.releaseLock(session.id, 'p2')).toBe(false);
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
    // Держатель прежний — неудачные попытки его не сняли.
    expect((await manager.getSession(session.id))!.status.blocked).toBe('p1');
  });

  it('no-op не пишет: takePendingInFlight без in-flight', async () => {
    const session = await manager.createSession({});
    await manager.addPendingMessage(session.id, makeMsg(MessageRole.USER, 'обычная очередь'));
    await freeze(session.id);

    expect(await manager.takePendingInFlight(session.id)).toBeUndefined();
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);

    // Повторный вызов (очередь пуста после переноса) — тоже без записи.
    const inFlightSession = await manager.createSession({});
    const pending = makeMsg(MessageRole.USER, 'in-flight');
    await manager.addPendingMessage(inFlightSession.id, pending);
    await manager.appendMessage(inFlightSession.id, { ...pending, seq: 0 });
    expect(await manager.takePendingInFlight(inFlightSession.id)).toBeDefined();
    await freeze(inFlightSession.id);
    expect(await manager.takePendingInFlight(inFlightSession.id)).toBeUndefined();
    expect((await manager.getSession(inFlightSession.id))!.updatedAt).toBe(FROZEN);
  });

  it('no-op не пишет: recoverInterruptedSessions без изменений', async () => {
    const session = await manager.createSession({});
    await manager.addPendingMessage(session.id, makeMsg(MessageRole.USER, 'ждёт'));
    await freeze(session.id);

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered.find((item) => item.sessionId === session.id)).toBeUndefined();
    expect((await manager.getSession(session.id))!.updatedAt).toBe(FROZEN);
  });
});
