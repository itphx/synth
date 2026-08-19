import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueProcessor } from './processor.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import type { BusEvent } from '@itphx/synth-shared';

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('Привет')],
    content: 'Привет',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function collectEvents(bus: EventBus, sessionId: string): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe(sessionId, (event) => events.push(event));
  return events;
}

function waitForEvent(
  events: BusEvent[],
  type: string,
  timeoutMs = 2000,
): Promise<BusEvent> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timeout waiting for ${type}`));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('QueueProcessor — очистка состояния при ошибке LLM', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qerr-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function enqueue(): Promise<{ sessionId: string; streamId: string }> {
    const session = await sessionManager.createSession({ title: 'Q' });
    const msg = makeMessage();
    await sessionManager.addPendingMessage(session.id, msg);
    return { sessionId: session.id, streamId: msg.metadata!.stream_id as string };
  }

  it('при result.error (unrecoverable) сессия полностью разблокируется', async () => {
    const { sessionId } = await enqueue();
    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'invalid model',
      errorType: 'model_not_found',
      canRetry: false,
    }));
    await processor.start();

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    const userMsg = s!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBe('invalid model');
  });

  it('при исключении processMessage сессия полностью разблокируется (не зависает навсегда)', async () => {
    const { sessionId } = await enqueue();
    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => {
      throw new Error('boom');
    });
    await processor.start();

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    const userMsg = s!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBe('Error: boom');
  });

  it('при recoverable-ошибке публикует stream.retry и ретраит после retryNow()', async () => {
    const { sessionId, streamId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);
    let calls = 0;

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => {
      calls += 1;
      if (calls === 1) {
        return { error: 'timeout', errorType: 'timeout', canRetry: true };
      }
      return {};
    });

    const startPromise = processor.start();
    const retryEvent = await waitForEvent(events, 'stream.retry');

    expect(retryEvent.data).toMatchObject({
      stream_id: streamId,
      attempt: 1,
      max_retries: 3,
      retry_in: 5000,
    });

    // «Повторить сейчас» — прерываем backoff, процессор ретраит немедленно
    processor.retryNow();
    await startPromise;

    expect(calls).toBe(2);
    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(events.some((e) => e.type === 'stream.done' || e.type === 'stream.error')).toBe(false);
  });

  it('cancelRetry() снимает pending, разблокирует сессию и публикует финальный stream.error', async () => {
    const { sessionId, streamId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'timeout',
      errorType: 'timeout',
      canRetry: true,
    }));

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');

    await processor.cancelRetry();
    await startPromise;

    const errorEvent = events.find((e) => e.type === 'stream.error')!;
    expect(errorEvent.data).toMatchObject({
      stream_id: streamId,
      can_retry: false,
      error_type: 'retry_cancelled',
    });

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    // Гонка: после отмены не должен публиковаться queue.stalled (иначе UI мигает
    // панелью «Обработка остановлена»).
    expect(events.some((e) => e.type === 'queue.stalled')).toBe(false);
  });

  it('ошибка с errorType provider_not_found не ретраится', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'Провайдер mocktimeout не найден или не настроен',
      errorType: 'provider_not_found',
      canRetry: false,
    }));
    await processor.start();

    const errorEvent = events.find((e) => e.type === 'stream.error');
    expect(errorEvent).toBeDefined();
    expect(events.some((e) => e.type === 'stream.retry')).toBe(false);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
  });
});

describe('QueueProcessor — дедупликация в Phase 1', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qdedup-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('повторный запуск Phase 1 с тем же stream_id не дублирует сообщение в истории', async () => {
    const session = await sessionManager.createSession({ title: 'Dedup' });
    const msg = makeMessage();
    const streamId = msg.metadata!.stream_id as string;
    await sessionManager.addPendingMessage(session.id, msg);

    // Имитируем, что сообщение уже помещено в историю первым проходом Phase 1
    // (например, после отмены/зависания), но осталось в очереди.
    await sessionManager.addMessage(session.id, msg);

    const events = collectEvents(eventBus, session.id);
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    await processor.start();

    const s = await sessionManager.getSession(session.id);
    const userMsgs = s!.messages.filter(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
    );
    expect(userMsgs).toHaveLength(1);
    // message.added не публикуется повторно для уже существующего сообщения
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(0);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.currentStream).toBeUndefined();
  });

  it('resume зависшей сессии (сообщение уже в истории) не создаёт второй экземпляр', async () => {
    const session = await sessionManager.createSession({ title: 'Resume' });
    const msg = makeMessage();
    const streamId = msg.metadata!.stream_id as string;
    await sessionManager.addPendingMessage(session.id, msg);

    // Зависшая сессия: Phase 1 уже запушил сообщение в историю, но оно осталось в очереди.
    await sessionManager.addMessage(session.id, msg);

    // «Resume»: новый процессор с тем же pending-сообщением и тем же stream_id.
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    await processor.start();

    const s = await sessionManager.getSession(session.id);
    const userMsgs = s!.messages.filter(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
    );
    expect(userMsgs).toHaveLength(1);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
  });
});
