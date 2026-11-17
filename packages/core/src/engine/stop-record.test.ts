/**
 * PROP-143: общий писатель durable-записи причины остановки
 * (`engine/stop-record.ts`).
 *
 * Контракты:
 *  - запись добавляется в историю сессии как служебное сообщение
 *    (`role: 'user'`, `author: 'System'`, `metadata.type = 'execution_stopped'`);
 *  - повтор с тем же `dedupeKey` **не** дублирует запись;
 *  - обфускация тела вызывается и её результат сохраняется (маркер записи при
 *    этом не теряется);
 *  - запись публикуется в шине как `message.added`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole } from '@itphx/synth-shared';
import type { BusEvent, Message } from '@itphx/synth-shared';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from '../sessions/manager.js';
import { EventBus } from '../events/bus.js';
import { STOP_MESSAGE_TYPE } from './stop-reason.js';
import { appendStopRecord, hasStopRecord } from './stop-record.js';

describe('appendStopRecord (PROP-143)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-stop-record-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Stop' });
    return session.id;
  }

  /** Записи остановки в истории сессии. */
  async function stopRecords(sessionId: string): Promise<Message[]> {
    const session = await sessionManager.getSession(sessionId);
    return (session?.messages ?? []).filter((m) => m.metadata?.type === STOP_MESSAGE_TYPE);
  }

  it('добавляет запись: role=user, author=System, metadata.type=execution_stopped', async () => {
    const sessionId = await makeSession();

    const result = await appendStopRecord({
      sessionManager,
      eventBus,
      sessionId,
      input: { reason: 'provider_error', errorType: 'rate_limit', retryable: false, attempts: 3 },
      dedupeKey: 'stream-1',
    });

    expect(result.appended).toBe(true);
    const records = await stopRecords(sessionId);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.role).toBe(MessageRole.USER);
    expect(record.author).toBe('System');
    expect(record.metadata?.type).toBe(STOP_MESSAGE_TYPE);
    expect(record.metadata?.reason).toBe('provider_error');
    expect(record.metadata?.error_type).toBe('rate_limit');
    expect(record.metadata?.attempts).toBe(3);
    // Конверт — то, что видит модель.
    expect(record.content).toContain('<execution_stopped');
    expect(record.content).toContain('reason="provider_error"');
  });

  it('повтор с тем же dedupeKey не дублирует запись', async () => {
    const sessionId = await makeSession();

    const first = await appendStopRecord({
      sessionManager,
      eventBus,
      sessionId,
      input: { reason: 'provider_error' },
      dedupeKey: 'stream-1',
    });
    const second = await appendStopRecord({
      sessionManager,
      eventBus,
      sessionId,
      input: { reason: 'provider_error' },
      dedupeKey: 'stream-1',
    });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(await stopRecords(sessionId)).toHaveLength(1);
    expect(await hasStopRecord(sessionManager, sessionId, 'stream-1')).toBe(true);
    expect(await hasStopRecord(sessionManager, sessionId, 'stream-2')).toBe(false);
  });

  it('обфускация вызвана и применена, маркер записи не потерян', async () => {
    const sessionId = await makeSession();
    const obfuscate = vi.fn(async (message: Message): Promise<Message> => ({
      ...message,
      content: message.content.replace('секрет', '[REDACTED]'),
      parts: [{ id: 'p1', type: 'text', data: message.content.replace('секрет', '[REDACTED]') }],
      // Обфускация теряет метаданные — писатель обязан их восстановить.
      metadata: undefined,
    }));

    const result = await appendStopRecord({
      sessionManager,
      eventBus,
      sessionId,
      input: { reason: 'provider_error', error: 'ключ секрет утек' },
      dedupeKey: 'stream-1',
      obfuscate,
    });

    expect(obfuscate).toHaveBeenCalledTimes(1);
    expect(result.appended).toBe(true);
    const records = await stopRecords(sessionId);
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toContain('[REDACTED]');
    expect(records[0]!.content).not.toContain('секрет');
    // Метаданные восстановлены: маркер и ключ дедупликации на месте.
    expect(records[0]!.metadata?.type).toBe(STOP_MESSAGE_TYPE);
    expect(records[0]!.metadata?.dedupe_key).toBe('stream-1');
  });

  it('публикует message.added в шине сессии', async () => {
    const sessionId = await makeSession();

    await appendStopRecord({
      sessionManager,
      eventBus,
      sessionId,
      input: { reason: 'stopped_by_user' },
      dedupeKey: 'stream-1',
    });

    const added = events.filter((e) => e.type === 'message.added');
    expect(added).toHaveLength(1);
    const payload = added[0]!.data as { message?: { id?: string }; index?: number };
    expect(payload.index).toBeGreaterThanOrEqual(0);
    expect(payload.message?.id).toBeTruthy();

    const records = await stopRecords(sessionId);
    expect(payload.message?.id).toBe(records[0]!.id);
  });

  it('без dedupeKey запись добавляется каждый раз', async () => {
    const sessionId = await makeSession();

    await appendStopRecord({ sessionManager, sessionId, input: { reason: 'internal' } });
    await appendStopRecord({ sessionManager, sessionId, input: { reason: 'internal' } });

    expect(await stopRecords(sessionId)).toHaveLength(2);
  });
});
