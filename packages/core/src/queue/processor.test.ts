import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueProcessor } from './processor.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { generateId, MessageRole, nowISO, makeTextPart, makeMediaPart } from '@itphx/synth-shared';
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

describe('QueueProcessor — «Стоп» (requestStop / cancelRequested)', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qstop-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function enqueue(): Promise<{ sessionId: string; streamId: string }> {
    const session = await sessionManager.createSession({ title: 'Stop' });
    const msg = makeMessage();
    await sessionManager.addPendingMessage(session.id, msg);
    return { sessionId: session.id, streamId: msg.metadata!.stream_id as string };
  }

  async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('waitUntil: timeout');
  }

  it('graceful-отмена (processMessage сам публикует stream.cancelled) — без дубля', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async (_s, _m, signal, publish) => {
      return new Promise((resolve) => {
        const gracefulCancel = () => {
          // Имитация graceful-отмены оркестратором: он публикует stream.cancelled
          // и возвращает {} (успешная ветка снимет currentStream).
          publish('stream.cancelled', { stream_id: 'orchestrator', content: 'partial', status: 'cancelled' });
          resolve({});
        };
        // Корректный потребитель AbortSignal: УЖЕ аборченный сигнал не
        // выстрелит событие 'abort' позднему подписчику — проверяем флаг и
        // завершаемся сразу, иначе промис повиснет навсегда.
        if (signal.aborted) {
          gracefulCancel();
          return;
        }
        signal.addEventListener('abort', gracefulCancel, { once: true });
      });
    });

    const startPromise = processor.start();
    await waitUntil(async () => (await sessionManager.getSession(sessionId))!.currentStream !== undefined);

    // «Стоп» на активном стриме
    processor.requestStop();
    await startPromise;

    // Ровно один stream.cancelled (от оркестратора) — очередь НЕ дублирует.
    expect(events.filter((e) => e.type === 'stream.cancelled')).toHaveLength(1);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(events.some((e) => e.type === 'queue.stalled')).toBe(false);
  });

  it('гонка: «Стоп» в окне между Phase 1 и Phase 2 не теряется (requestStop до старта LLM-вызова)', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    let processMessageCalled = false;

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => {
      processMessageCalled = true;
      return {};
    });

    // Триггер гонки: `stream.start` публикуется ВНУТРИ Phase 1 — до создания
    // контроллера в Phase 2. Вызываем «Стоп» прямо из обработчика события:
    // запрос попадает ровно в уязвимое окно (детерминированно, без угадывания
    // таймингов). Раньше здесь запрос «Стоп» ТЕРЯЛСЯ: `abort()` уходил в
    // пустоту (`_activeController` ещё не создан), и LLM-вызов уходил до конца.
    const unsubscribe = eventBus.subscribe(sessionId, (event) => {
      if (event.type === 'stream.start') processor.requestStop();
    });

    await processor.start();
    unsubscribe();

    // Стоп не потерян: LLM-вызов не стартовал вовсе (контроллер аборчен до
    // вызова — потребитель получил бы уже aborted-сигнал).
    expect(processMessageCalled).toBe(false);

    // Ровно один stream.cancelled — его публикует обработчик остановки.
    const cancelled = events.filter((e) => e.type === 'stream.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data).toMatchObject({ status: 'cancelled' });

    // Сессия полностью разблокирована, очередь очищена.
    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(s!.status.cancelRequestedAt).toBeUndefined();
    // Гонка: после отмены не должен публиковаться queue.stalled (иначе UI
    // мигает панелью «Обработка остановлена»).
    expect(events.some((e) => e.type === 'queue.stalled')).toBe(false);
  });

  it('backoff: requestStop будит паузу, очередь чистится, stream.cancelled один раз', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'timeout',
      errorType: 'timeout',
      canRetry: true,
    }));

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');

    const startedAt = Date.now();
    processor.requestStop();
    await startPromise;
    // backoff (5 c) прерван немедленно, а не по таймеру
    expect(Date.now() - startedAt).toBeLessThan(2000);

    const cancelled = events.filter((e) => e.type === 'stream.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data).toMatchObject({ status: 'cancelled' });
    // Повтора нет
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.blocked).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(s!.status.cancelRequestedAt).toBeUndefined();
  });

  it('персистентный флаг cancelRequested (abort без стрима) останавливает процессор', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    // Имитация abort-роута: флаг выставлен до запуска, стрима/токена ещё нет.
    await sessionManager.safeUpdate(sessionId, (s) => {
      s.status.cancelRequested = true;
      s.status.cancelRequestedAt = nowISO();
    });

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => {
      throw new Error('processMessage не должен вызываться при активном Стопе');
    });
    await processor.start();

    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.currentStream).toBeUndefined();
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(s!.status.cancelRequestedAt).toBeUndefined();
    expect(events.some((e) => e.type === 'stream.error')).toBe(false);
    expect(events.some((e) => e.type === 'stream.start')).toBe(false);
    expect(events.some((e) => e.type === 'queue.stalled')).toBe(false);
  });

  it('персистентный флаг перечитывается на границе цикла (backoff без requestStop)', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'timeout',
      errorType: 'timeout',
      canRetry: true,
    }));

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');

    // Флаг выставлен «снаружи» (другой инстанс/шлюз), requestStop не вызывался —
    // будим backoff и проверяем, что граница цикла видит флаг.
    await sessionManager.safeUpdate(sessionId, (s) => {
      s.status.cancelRequested = true;
    });
    processor.retryNow();
    await startPromise;

    expect(events.filter((e) => e.type === 'stream.cancelled')).toHaveLength(1);
    const s = await sessionManager.getSession(sessionId);
    expect(s!.pendingMessages).toHaveLength(0);
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
  });
});

describe('QueueProcessor — message.added с вложением (ADR-115)', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qparts-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('публикует parts: медиа-часть как есть, текст обрезан до 500', async () => {
    const longText = 'а'.repeat(900);
    const session = await sessionManager.createSession({ title: 'Parts' });
    const msg: Message = {
      ...makeMessage(),
      parts: [
        makeTextPart(longText),
        makeMediaPart('image', {
          blobPath: 'attachments/ab/abcdef',
          sha256: 'abcdef',
          mime: 'image/jpeg',
          size: 2048,
          name: 'Yeti 2.jpg',
        }),
      ],
      content: `[image: Yeti 2.jpg] ${longText}`,
    };
    await sessionManager.addPendingMessage(session.id, msg);

    const events = collectEvents(eventBus, session.id);
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    await processor.start();

    const added = events.find((e) => e.type === 'message.added');
    expect(added).toBeDefined();
    const parts = added!.data.parts as Array<{ type: string; data: unknown }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe('text');
    expect(parts[0]!.data).toHaveLength(500);
    expect(parts[1]!.type).toBe('image');
    expect(parts[1]!.data).toMatchObject({
      blobPath: 'attachments/ab/abcdef',
      mime: 'image/jpeg',
      size: 2048,
      name: 'Yeti 2.jpg',
    });
    // content события по-прежнему обрезан (отдельная задача — не раздувать событие).
    expect((added!.data.content as string).length).toBeLessThanOrEqual(500);
    // Сообщение в истории не испорчено снимком для события.
    const s = await sessionManager.getSession(session.id);
    const saved = s!.messages.find((m) => m.id === msg.id)!;
    expect((saved.parts[0]!.data as string)).toHaveLength(900);
  });

  it('текстовое сообщение без вложения → parts содержит только текст', async () => {
    const session = await sessionManager.createSession({ title: 'NoParts' });
    const msg: Message = { ...makeMessage(), parts: [] };
    await sessionManager.addPendingMessage(session.id, msg);

    const events = collectEvents(eventBus, session.id);
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    await processor.start();

    const added = events.find((e) => e.type === 'message.added');
    expect(added).toBeDefined();
    const parts = added!.data.parts as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text']);
  });
});
