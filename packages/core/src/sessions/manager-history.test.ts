/**
 * Этап 3a-1: HISTORY-пути `SessionManager` — контрольные точки, ссылки,
 * слияние истории и batch-операции — правятся **точечной мутацией истории**
 * (`mutateHistory`), а не полной записью снимка.
 *
 * Контракты (паритет с прежним `withLock`+`save`):
 *  - возвраты прежние (`Session`/`SessionReference`/`Message[]`/`{results}`);
 *  - `updatedAt` двигается (это настоящие изменения истории);
 *  - параллельная дозапись сообщения не теряется (lost update исключён);
 *  - `seq` — позиционный `1..n`, `ord` ранее выданных записей не
 *    перенумеровывается (ADR-118 §2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';

const FROZEN_AT = '2024-01-01T00:00:00.000Z';

function makeMsg(role: MessageRole, content: string): Message {
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

describe('SessionManager — HISTORY-пути через mutateHistory (этап 3a-1)', () => {
  let store: FileStore;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-history-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Зафиксировать `updatedAt`, чтобы bump был виден детерминированно. */
  async function freezeUpdatedAt(sessionId: string): Promise<void> {
    const session = (await store.load(sessionId))!;
    session.updatedAt = FROZEN_AT;
    await store.save(session);
    expect((await store.load(sessionId))!.updatedAt).toBe(FROZEN_AT);
  }

  describe('контрольные точки', () => {
    it('createCheckpoint добавляет точку и двигает updatedAt', async () => {
      const session = await manager.createSession({ title: 'cp' });
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'one'));
      await freezeUpdatedAt(session.id);

      const withCheckpoint = await manager.createCheckpoint(session.id);
      expect(withCheckpoint).not.toBeNull();
      expect(withCheckpoint!.checkpoints).toHaveLength(1);
      const checkpointId = withCheckpoint!.checkpoints[0]!.id;
      expect(withCheckpoint!.messages.map((m) => m.content)).toEqual(['one']);

      const stored = (await manager.getSession(session.id))!;
      expect(stored.checkpoints.map((c) => c.id)).toEqual([checkpointId]);
      // Настоящее изменение истории — время сессии двигается.
      expect(stored.updatedAt).not.toBe(FROZEN_AT);
    });

    it('restoreCheckpoint заменяет историю (bump), seq 1..n, ord не перенумеровывается', async () => {
      const session = await manager.createSession({ title: 'cp' });
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'one'));
      await manager.addMessage(session.id, makeMsg(MessageRole.ASSISTANT, 'two'));

      // Заданные вручную `ord` — снимок для проверки иммутабельности.
      const snapshot = (await store.load(session.id))!;
      snapshot.messages[0]!.ord = 10;
      snapshot.messages[1]!.ord = 11;
      await store.save(snapshot);

      const withCheckpoint = await manager.createCheckpoint(session.id);
      const checkpointId = withCheckpoint!.checkpoints[0]!.id;

      // Между созданием точки и восстановлением: ещё сообщение и «свидетель».
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'three'));
      const witness = await manager.addMessage(session.id, makeMsg(MessageRole.TOOL, 'свидетель'));
      expect(witness!.messages.map((m) => m.content)).toContain('свидетель');

      await freezeUpdatedAt(session.id);
      const restored = await manager.restoreCheckpoint(session.id, checkpointId);
      expect(restored).not.toBeNull();

      // История заменена снимком точки: `seq` — позиционный, `ord` — прежний.
      expect(restored!.messages.map((m) => m.content)).toEqual(['one', 'two']);
      expect(restored!.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(restored!.messages.map((m) => m.ord)).toEqual([10, 11]);
      expect(restored!.updatedAt).not.toBe(FROZEN_AT);
      // Точка остаётся в сессии.
      expect(restored!.checkpoints.map((c) => c.id)).toEqual([checkpointId]);
    });

    it('createCheckpoint ∥ appendMessage: дописанное сообщение не теряется', async () => {
      const session = await manager.createSession({ title: 'cp' });
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'one'));
      const witness = makeMsg(MessageRole.TOOL, 'свидетель');

      await Promise.all([
        manager.createCheckpoint(session.id),
        manager.appendMessage(session.id, witness),
      ]);

      const stored = (await manager.getSession(session.id))!;
      expect(stored.messages.map((m) => m.id)).toContain(witness.id);
      expect(stored.checkpoints).toHaveLength(1);
    });
  });

  describe('ссылки', () => {
    it('addReference: ссылка и сообщение добавляются, updatedAt сдвинут, свидетель цел', async () => {
      const target = await manager.createSession({ title: 'target' });
      await manager.addMessage(target.id, makeMsg(MessageRole.USER, 'target-1'));
      const witness = await manager.addMessage(target.id, makeMsg(MessageRole.TOOL, 'свидетель'));

      const source = await manager.createSession({ title: 'source' });
      await manager.addMessage(source.id, makeMsg(MessageRole.USER, 'source-1'));

      await freezeUpdatedAt(target.id);
      const ref = await manager.addReference(target.id, source.id, {});

      expect(ref).toMatchObject({
        type: 'session_reference',
        sessionId: source.id,
        messageRange: [1, 1],
      });

      const stored = (await manager.getSession(target.id))!;
      expect(stored.references).toHaveLength(1);
      expect(stored.references![0]!.sessionId).toBe(source.id);
      const refMessage = stored.messages.at(-1)!;
      expect(refMessage.metadata?.type).toBe('session_reference');
      expect(refMessage.metadata?.session_id).toBe(source.id);
      // Новая запись истории получает свежий `ord`, свидетель не тронут.
      expect(refMessage.ord).toBe(3);
      expect(stored.messages.map((m) => m.id)).toContain(witness!.messages[1]!.id);
      expect(stored.updatedAt).not.toBe(FROZEN_AT);
    });

    it('addReference(position:before) вставляет в начало, нумерация позиционная', async () => {
      const target = await manager.createSession({ title: 'target' });
      await manager.addMessage(target.id, makeMsg(MessageRole.USER, 'target-1'));
      const source = await manager.createSession({ title: 'source' });
      await manager.addMessage(source.id, makeMsg(MessageRole.USER, 'source-1'));

      await manager.addReference(target.id, source.id, { position: 'before' });

      const stored = (await manager.getSession(target.id))!;
      expect(stored.messages[0]!.metadata?.type).toBe('session_reference');
      expect(stored.messages.map((m) => m.seq)).toEqual([1, 2]);
    });

    it('removeReference удаляет ссылку и её сообщение, updatedAt сдвинут', async () => {
      const target = await manager.createSession({ title: 'target' });
      await manager.addMessage(target.id, makeMsg(MessageRole.USER, 'target-1'));
      const witness = await manager.addMessage(target.id, makeMsg(MessageRole.TOOL, 'свидетель'));
      const source = await manager.createSession({ title: 'source' });
      await manager.addMessage(source.id, makeMsg(MessageRole.USER, 'source-1'));
      await manager.addReference(target.id, source.id, {});

      await freezeUpdatedAt(target.id);
      await manager.removeReference(target.id, source.id);

      const stored = (await manager.getSession(target.id))!;
      expect(stored.references ?? []).toHaveLength(0);
      expect(stored.messages.some((m) => m.metadata?.type === 'session_reference')).toBe(false);
      expect(stored.messages.map((m) => m.id)).toEqual([
        witness!.messages[0]!.id,
        witness!.messages[1]!.id,
      ]);
      expect(stored.updatedAt).not.toBe(FROZEN_AT);
    });
  });

  describe('слияние истории', () => {
    it('mergeMessages: порядок и новые ord прежние, updatedAt сдвинут, свидетель цел', async () => {
      const target = await manager.createSession({ title: 'target' });
      await manager.addMessage(target.id, makeMsg(MessageRole.USER, 'target-1'));
      await manager.addMessage(target.id, makeMsg(MessageRole.ASSISTANT, 'target-2'));
      const witness = await manager.addMessage(target.id, makeMsg(MessageRole.TOOL, 'свидетель'));

      const source = await manager.createSession({ title: 'source' });
      await manager.addMessage(source.id, makeMsg(MessageRole.USER, 'вставка'));

      await freezeUpdatedAt(target.id);
      const merged = await manager.mergeMessages(target.id, source.id, {
        sourceRange: [1, 1],
        position: 'before',
      });
      expect(merged).toHaveLength(1);

      const stored = (await manager.getSession(target.id))!;
      expect(stored.messages.map((m) => m.content)).toEqual([
        'вставка',
        'target-1',
        'target-2',
        'свидетель',
      ]);
      // Копия получила свежий `ord` сессии-получателя, прежние не сдвинуты.
      expect(stored.messages.map((m) => m.ord)).toEqual([4, 1, 2, 3]);
      expect(stored.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
      expect(stored.messages.map((m) => m.id)).toContain(witness!.messages[2]!.id);
      expect(stored.updatedAt).not.toBe(FROZEN_AT);
    });

    it('mergeMessages с summarize: одно summary-сообщение', async () => {
      const target = await manager.createSession({ title: 'target' });
      await manager.addMessage(target.id, makeMsg(MessageRole.USER, 'target-1'));
      const source = await manager.createSession({ title: 'source' });
      await manager.addMessage(source.id, makeMsg(MessageRole.USER, 'раз'));
      await manager.addMessage(source.id, makeMsg(MessageRole.ASSISTANT, 'два'));

      const merged = await manager.mergeMessages(target.id, source.id, {
        sourceRange: [1, 2],
        position: 'after',
        summarize: true,
      });
      expect(merged).toHaveLength(1);
      expect(merged[0]!.role).toBe(MessageRole.SUMMARY);

      const stored = (await manager.getSession(target.id))!;
      expect(stored.messages.map((m) => m.role)).toEqual([MessageRole.USER, MessageRole.SUMMARY]);
      expect(stored.messages.map((m) => m.seq)).toEqual([1, 2]);
    });
  });

  describe('batch-операции', () => {
    it('pin/toggle/delete: результаты, порядок и ord прежние, updatedAt сдвинут', async () => {
      const session = await manager.createSession({ title: 'batch' });
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'one'));
      await manager.addMessage(session.id, makeMsg(MessageRole.ASSISTANT, 'two'));
      await manager.addMessage(session.id, makeMsg(MessageRole.TOOL, 'three'));
      const witness = await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'свидетель'));

      const ids = witness!.messages.map((m) => m.id);
      await freezeUpdatedAt(session.id);

      const pinned = await manager.batchMessageOperation(session.id, 'pin', [ids[1]!]);
      expect(pinned.results).toEqual([{ messageId: ids[1], success: true, state: true }]);

      const toggled = await manager.batchMessageOperation(session.id, 'toggle', [ids[2]!]);
      expect(toggled.results).toEqual([{ messageId: ids[2], success: true, state: true }]);

      const deleted = await manager.batchMessageOperation(session.id, 'delete', [ids[0]!, ids[3]!]);
      // Удаление идёт от конца к началу — результаты в порядке обработки
      // (прежнее поведение: адресация по позициям, не по порядку запроса).
      expect(deleted.results).toEqual([
        { messageId: ids[3], success: true },
        { messageId: ids[0], success: true },
      ]);

      const stored = (await manager.getSession(session.id))!;
      expect(stored.messages.map((m) => m.content)).toEqual(['two', 'three']);
      expect(stored.messages[0]!.pinned).toBe(true);
      expect(stored.messages[1]!.disabled).toBe(true);
      // Позиции пересчитаны, `ord` остатков — прежние.
      expect(stored.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(stored.messages.map((m) => m.ord)).toEqual([2, 3]);
      expect(stored.updatedAt).not.toBe(FROZEN_AT);
    });

    it('batch по несуществующему id: success:false, остальные применяются', async () => {
      const session = await manager.createSession({ title: 'batch' });
      await manager.addMessage(session.id, makeMsg(MessageRole.USER, 'one'));
      const storedBefore = (await manager.getSession(session.id))!;
      const id = storedBefore.messages[0]!.id;

      const result = await manager.batchMessageOperation(session.id, 'pin', ['missing', id], true);
      // Найденное сообщение обрабатывается первым (сортировка по позиции),
      // ненайденное — в конце: прежний порядок результатов сохранён.
      expect(result.results).toEqual([
        { messageId: id, success: true, state: true },
        { messageId: 'missing', success: false },
      ]);
      expect((await manager.getSession(session.id))!.messages[0]!.pinned).toBe(true);
    });
  });
});
