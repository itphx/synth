import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueProcessor, enqueueUserMessage, requeueMessages } from './processor.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { sessionMessagesToLlm } from '../engine/orchestrator/prompt-info.js';
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
    expect(events.some((e) => e.type === 'stream.error')).toBe(false);
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

/**
 * Персистентное состояние ретрая (`Session.retry`): после reload/restart клиент
 * должен видеть «повтор», а не «пусто».
 */
describe('QueueProcessor — персистентное состояние ретрая', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qretry-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function enqueue(): Promise<{ sessionId: string; streamId: string }> {
    const session = await sessionManager.createSession({ title: 'Retry' });
    const msg = makeMessage();
    await sessionManager.addPendingMessage(session.id, msg);
    return { sessionId: session.id, streamId: msg.metadata!.stream_id as string };
  }

  it('recoverable-ошибка: состояние ретрая записывается в сессию', async () => {
    const { sessionId, streamId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'timeout',
      errorType: 'timeout',
      canRetry: true,
    }));

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');

    const s = await sessionManager.getSession(sessionId);
    expect(s!.retry).toBeDefined();
    expect(s!.retry!.streamId).toBe(streamId);
    expect(s!.retry!.attempt).toBe(1);
    expect(s!.retry!.maxRetries).toBe(3);
    expect(s!.retry!.error).toBe('timeout');
    expect(Date.parse(s!.retry!.retryAt)).toBeGreaterThan(Date.now() - 1000);

    processor.requestStop();
    await startPromise;
  });

  it('успех снимает состояние ретрая', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);
    let calls = 0;

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => {
      calls += 1;
      return calls === 1 ? { error: 'timeout', errorType: 'timeout', canRetry: true } : {};
    });

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');
    processor.retryNow();
    await startPromise;

    const s = await sessionManager.getSession(sessionId);
    expect(s!.retry).toBeUndefined();
    expect(s!.currentStream).toBeUndefined();
  });

  it('терминальная ошибка снимает состояние ретрая', async () => {
    const { sessionId } = await enqueue();
    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'invalid model',
      errorType: 'model_not_found',
      canRetry: false,
    }));
    await processor.start();

    const s = await sessionManager.getSession(sessionId);
    expect(s!.retry).toBeUndefined();
  });

  it('«Стоп» во время backoff снимает состояние ретрая', async () => {
    const { sessionId } = await enqueue();
    const events = collectEvents(eventBus, sessionId);

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, async () => ({
      error: 'timeout',
      errorType: 'timeout',
      canRetry: true,
    }));

    const startPromise = processor.start();
    await waitForEvent(events, 'stream.retry');
    processor.requestStop();
    await startPromise;

    const s = await sessionManager.getSession(sessionId);
    expect(s!.retry).toBeUndefined();
  });
});

/**
 * ADR-118 §4: `queue.state` несёт состояния элементов очереди
 * (`queued`/`starting`) — без текста и автора.
 */
describe('QueueProcessor — queue.state: состояния элементов очереди', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qitems-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('элементы очереди: взят в работу → starting, остальные → queued (без текста/автора)', async () => {
    const session = await sessionManager.createSession({ title: 'Items' });
    const first = makeMessage();
    const second = makeMessage();
    await sessionManager.addPendingMessage(session.id, first);
    await sessionManager.addPendingMessage(session.id, second);

    const events = collectEvents(eventBus, session.id);
    // Врата: первый ход держится, пока тест не отпустит.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => {
      await gate;
      return {};
    });

    const startPromise = processor.start();

    // Ждём `queue.state` с элементом `starting` (ход взят в работу).
    const started = Date.now();
    let items: Array<{ id: string; status: string }> | null = null;
    while (Date.now() - started < 2000 && !items) {
      const state = events.filter((e) => e.type === 'queue.state').pop();
      const candidate = state?.data.items as Array<{ id: string; status: string }> | undefined;
      if (candidate?.some((item) => item.status === 'starting')) items = candidate;
      else await new Promise((r) => setTimeout(r, 5));
    }

    expect(items).toEqual([
      { id: first.metadata!.stream_id as string, status: 'starting' },
      { id: second.metadata!.stream_id as string, status: 'queued' },
    ]);
    // Ни текста, ни автора в элементах очереди нет (устранение утечки).
    expect(JSON.stringify(items)).not.toContain('Привет');
    const state = events.filter((e) => e.type === 'queue.state').pop()!;
    expect(state.data.content).toBeUndefined();
    expect(state.data.author).toBeUndefined();

    release();
    await startPromise;

    // После извлечения из очереди элементов не остаётся.
    const finalState = events.filter((e) => e.type === 'queue.state').pop()!;
    expect(finalState.data.items).toEqual([]);
    expect(finalState.data.pendingCount).toBe(0);
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

describe('QueueProcessor — материализация сообщения (ADR-118 §4, ADR-115)', () => {
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

  it('message.delivered: сообщение материализовано с ord, части в истории не испорчены', async () => {
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

    // ADR-118 §4: материализация сообщения в истории — `message.delivered`
    // (`messageId`, `ord`, роль, автор, принципал).
    const delivered = events.find((e) => e.type === 'message.delivered');
    expect(delivered).toBeDefined();
    expect(delivered!.data).toMatchObject({ messageId: msg.id, role: 'user', ord: 1 });

    // Сообщение в истории не испорчено: медиа-часть как есть, текст целиком.
    const s = await sessionManager.getSession(session.id);
    const saved = s!.messages.find((m) => m.id === msg.id)!;
    expect(saved.parts).toHaveLength(2);
    expect(saved.parts[0]!.type).toBe('text');
    expect((saved.parts[0]!.data as string)).toHaveLength(900);
    expect(saved.parts[1]!.type).toBe('image');
    expect(saved.parts[1]!.data).toMatchObject({
      blobPath: 'attachments/ab/abcdef',
      mime: 'image/jpeg',
      size: 2048,
      name: 'Yeti 2.jpg',
    });
  });

  it('текстовое сообщение без вложения → в истории только текстовая часть', async () => {
    const session = await sessionManager.createSession({ title: 'NoParts' });
    const msg: Message = { ...makeMessage(), parts: [] };
    await sessionManager.addPendingMessage(session.id, msg);

    const events = collectEvents(eventBus, session.id);
    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    await processor.start();

    const delivered = events.find((e) => e.type === 'message.delivered');
    expect(delivered).toBeDefined();

    const s = await sessionManager.getSession(session.id);
    const saved = s!.messages.find((m) => m.id === msg.id)!;
    expect(saved.parts.map((p) => p.type)).toEqual(['text']);
  });
});

/**
 * Шаг 2б (расширение): битая цепочка лечится перед КАЖДЫМ сообщением
 * очереди, а не только перед первым. Процессор живёт несколько ходов —
 * цепочка, оставленная предыдущим ходом, иначе роняла бы следующий LLM-вызов
 * («tool_calls must be followed by tool messages»).
 */
describe('QueueProcessor — ремонт битой цепочки перед каждым сообщением', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qrecover-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('assistant(tool_calls) без пары от первого хода лечится перед вторым сообщением', async () => {
    const session = await sessionManager.createSession({ title: 'Recover' });
    // Два pending-сообщения — процессор обработает их в одном инстансе.
    await sessionManager.addPendingMessage(session.id, makeMessage());
    await sessionManager.addPendingMessage(session.id, makeMessage());

    let calls = 0;
    /** Состояние осиротевшего assistant на момент входа в processMessage. */
    const orphanDisabledAtCall: boolean[] = [];

    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => {
      calls++;
      if (calls === 1) {
        // Первый ход оставляет assistant(tool_calls) БЕЗ tool-результата
        // (как сработавший doom-loop/сбой до персиста результата).
        await sessionManager.addMessage(session.id, {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart('')],
          content: '',
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          toolCalls: [{ id: 'call_orphan', function: { name: 'read_file', arguments: '{}' } }],
          metadata: { stream_id: 'prev-stream', tool_chain: true },
        });
      }
      const fresh = await sessionManager.getSession(session.id);
      const orphan = fresh!.messages.find(
        (m) => m.toolCalls?.some((c) => c.id === 'call_orphan'),
      );
      orphanDisabledAtCall.push(orphan?.disabled === true);
      return {};
    });

    await processor.start();

    expect(calls).toBe(2);
    // Перед ПЕРВЫМ сообщением цепочки ещё не было — ремонт нечего делать.
    expect(orphanDisabledAtCall[0]).toBe(false);
    // Перед ВТОРЫМ — битая цепочка уже помечена (recovery на каждое сообщение).
    expect(orphanDisabledAtCall[1]).toBe(true);

    const saved = (await sessionManager.getSession(session.id))!;
    const orphan = saved.messages.find((m) => m.toolCalls?.some((c) => c.id === 'call_orphan'))!;
    expect(orphan.disabled).toBe(true);
    expect(orphan.metadata?.interrupted).toBe(true);

    // LLM-диалог валиден: осиротевший assistant(toolUse) не отдаётся модели.
    const llm = sessionMessagesToLlm(saved.messages, undefined, 'user');
    expect(llm.some((m) => m.role === 'assistant' && (m.toolUse?.length ?? 0) > 0)).toBe(false);
  });
});

/**
 * ADR-104 × ADR-111/ADR-113: возврат уведомлений в обычную очередь.
 * Маркеры инъекции снимаются (это уже не «вмешательство в ход»), а
 * переполнение `pendingMessages` не теряется молча — публикуется `steer.dropped`.
 */
describe('requeueMessages — маркеры и переполнение очереди', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-requeue-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('снимает маркеры steer/interrupt перед постановкой в pendingMessages', async () => {
    const session = await sessionManager.createSession({ title: 'R' });
    const message = makeMessage();
    message.metadata = { ...message.metadata, steer: true, interrupt: true, type: 'background_run_result' };
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const result = await requeueMessages({
      sessionManager,
      eventBus,
      sessionId: session.id,
      messages: [message],
    });

    expect(result).toEqual({ requeued: 1, dropped: 0 });
    // ADR-118 §4: очередь изменилась — `queue.state` (только счётчики).
    const state = events.find((e) => e.type === 'queue.state');
    expect(state).toBeDefined();
    expect(state!.data).toMatchObject({ pendingCount: 1, steerCount: 0 });
    // Ни текста, ни автора в `queue.state` нет (устранение утечки `message.queued`).
    expect(state!.data.content).toBeUndefined();
    expect(state!.data.author).toBeUndefined();
    const saved = (await sessionManager.getSession(session.id))!;
    expect(saved.pendingMessages).toHaveLength(1);
    expect(saved.pendingMessages[0]!.metadata?.steer).toBeUndefined();
    expect(saved.pendingMessages[0]!.metadata?.interrupt).toBeUndefined();
    expect(saved.pendingMessages[0]!.metadata?.type).toBe('background_run_result');
  });

  it('переполнение pending: steer.dropped, элемент не добавлен', async () => {
    const session = await sessionManager.createSession({ title: 'R' });
    for (let i = 0; i < 5; i++) {
      await sessionManager.addPendingMessage(session.id, makeMessage());
    }
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const result = await requeueMessages({
      sessionManager,
      eventBus,
      sessionId: session.id,
      messages: [makeMessage()],
    });

    expect(result).toEqual({ requeued: 0, dropped: 1 });
    expect((await sessionManager.getSession(session.id))!.pendingMessages).toHaveLength(5);
    const dropped = events.find((e) => e.type === 'steer.dropped');
    expect(dropped).toBeDefined();
    expect(dropped!.data.reason).toBe('limit');
    expect(dropped!.data.dropped_count).toBe(1);
    expect(events.some((e) => e.type === 'queue.state')).toBe(false);
  });
});

/**
 * «Стоп» очищает очередь, но уведомления о завершении фоновых прогонов
 * (ADR-111/ADR-113) не теряются — иначе результат фоновой работы исчез бы.
 */
describe('QueueProcessor — «Стоп» сохраняет background_run_result', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qstop-notice-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('после стопа уведомление остаётся в pending, остальное снято', async () => {
    const session = await sessionManager.createSession({ title: 'Q' });
    await sessionManager.addPendingMessage(session.id, makeMessage());
    const notice: Message = {
      ...makeMessage(),
      author: 'Process',
      metadata: { type: 'background_run_result', kind: 'process' },
    };
    await sessionManager.addPendingMessage(session.id, notice);

    const processor = new QueueProcessor(session.id, sessionManager, eventBus, async () => ({}));
    const run = processor.start();
    processor.requestStop();
    await run;

    const saved = (await sessionManager.getSession(session.id))!;
    expect(saved.pendingMessages.map((m) => m.metadata?.type)).toEqual(['background_run_result']);
    expect(saved.pendingMessages[0]!.author).toBe('Process');
    expect(saved.status.blocked).toBeUndefined();
    expect(saved.currentStream).toBeUndefined();
  });
});

/** ADR-118 §4: `message.accepted` — подтверждение приёма (`messageId`/`mode`/`position`). */
describe('enqueueUserMessage — message.accepted в событии приёма', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-qenqueue-id-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('message.accepted: messageId = id сообщения, mode = queue, position = 1', async () => {
    const session = await sessionManager.createSession({ title: 'Q' });
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));
    const message = makeMessage();

    await enqueueUserMessage(
      sessionManager,
      eventBus,
      session.id,
      message,
      { createProcessor: vi.fn() } as never,
      (async () => ({})) as never,
    );

    const accepted = events.find((e) => e.type === 'message.accepted');
    expect(accepted).toBeDefined();
    expect(accepted!.data.messageId).toBe(message.id);
    expect(accepted!.data.mode).toBe('queue');
    expect(accepted!.data.position).toBe(1);
    // Состояние очереди — только счётчики.
    const state = events.find((e) => e.type === 'queue.state');
    expect(state).toBeDefined();
    expect(state!.data).toMatchObject({ pendingCount: 1, steerCount: 0 });
  });
});
