import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from '../events/bus.js';
import { RemoteEventBridge } from './event-bridge.js';
import type { RemoteBackendClient } from './client.js';
import type { BusEvent } from '@itphx/synth-shared';

/** Response с SSE-блоками (каждый блок заканчивается \n\n). */
function sseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(encoder.encode(b));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Response с телом-стримом, который немедленно закрывается (без событий). */
function closedResponse(): Response {
  return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
}

/** Response с телом-стримом, который падает при чтении (обрыв сети). */
function errorResponse(): Response {
  return new Response(new ReadableStream({
    start(c) { c.error(new Error('network drop')); },
  }), { status: 200 });
}

function makeClient(request: ReturnType<typeof vi.fn>): RemoteBackendClient {
  return { request } as unknown as RemoteBackendClient;
}

/** Флеш микрозадач (для тестов с fake timers). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteEventBridge', () => {
  it('публикует события в eventBus с remote:<id> и переписанными вложенными id', async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    const client = makeClient(vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"stream.chunk","sessionId":"ses-1","data":{"stream_id":"st1","content":"привет"},"timestamp":"t1"}\n\n',
      'data: {"type":"session.updated","sessionId":"ses-1","data":{"id":"ses-1","project_id":"prj-1","parent_id":"ses-0"},"timestamp":"t2"}\n\n',
      'data: {"type":"subagent.resume.started","sessionId":"ses-1","data":{"child_session_id":"ses-2","parent_session_id":"ses-1"},"timestamp":"t3"}\n\n',
    ])));

    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
    });
    bridge.start();

    await vi.waitFor(() => expect(received.length).toBe(3));
    expect(received[0]!).toMatchObject({ type: 'stream.chunk', sessionId: 'remote:ses-1' });
    expect(received[1]!).toMatchObject({ type: 'session.updated', sessionId: 'remote:ses-1' });
    expect(received[1]!.data.id).toBe('remote:ses-1');
    expect(received[1]!.data.project_id).toBe('remote:prj-1');
    expect(received[1]!.data.parent_id).toBe('remote:ses-0');
    expect(received[2]!.data.child_session_id).toBe('remote:ses-2');
    expect(received[2]!.data.parent_session_id).toBe('remote:ses-1');

    // Повторный вызов не дублирует префикс (идемпотентность).
    expect(received[1]!.data.id).toBe('remote:ses-1');
    bridge.stop();
  });

  it('игнорирует keepalive-комментарии и невалидный JSON', async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    const client = makeClient(vi.fn().mockResolvedValue(sseResponse([
      ':keepalive\n\n',
      'data: {"type":"stream.start","sessionId":"ses-1","data":{"stream_id":"st1"},"timestamp":"t"}\n\n',
      ':keepalive\n\n',
      'data: not-json\n\n',
    ])));

    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
    });
    bridge.start();

    await vi.waitFor(() => expect(received.length).toBe(1));
    expect(received[0]!.type).toBe('stream.start');
    expect(received[0]!.sessionId).toBe('remote:ses-1');
    bridge.stop();
  });

  it('переподключается с backoff при разрыве стрима (fake timers)', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    // Первый стрим падает при чтении, второй — успешный с событием.
    const request = vi.fn()
      .mockResolvedValueOnce(errorResponse())
      .mockResolvedValueOnce(sseResponse([
        'data: {"type":"stream.chunk","sessionId":"ses-1","data":{"stream_id":"st1","content":"ok"},"timestamp":"t"}\n\n',
      ]));

    const client = makeClient(request);
    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
      reconnectDelayMs: 2000,
      maxReconnectDelayMs: 10000,
    });
    bridge.start();

    // Дожидаемся первого запроса и падения стрима (таймер реконнекта запланирован).
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    // Проходит базовая задержка → второй запрос.
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(2);

    // Второй стрим успешен → событие опубликовано.
    await flush();
    expect(received.length).toBe(1);
    expect(received[0]!.sessionId).toBe('remote:ses-1');

    bridge.stop();
  });

  it('backoff растёт экспоненциально до max', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const request = vi.fn().mockResolvedValue(errorResponse());
    const client = makeClient(request);
    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 4000,
    });
    bridge.start();

    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    // Попытка 1: 1000 мс → запрос 2
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    // Попытка 2: 2000 мс → запрос 3
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(request).toHaveBeenCalledTimes(3);

    // Попытка 3: 4000 мс (cap) → запрос 4
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(request).toHaveBeenCalledTimes(4);

    // Дальше задержка упирается в max 4000 — попытка 5 после ещё 4000 мс.
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(request).toHaveBeenCalledTimes(5);

    bridge.stop();
  });

  it('stop() отменяет реконнект', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const request = vi.fn().mockResolvedValue(errorResponse());
    const client = makeClient(request);
    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
      reconnectDelayMs: 2000,
      maxReconnectDelayMs: 10000,
    });
    bridge.start();

    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    bridge.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1); // реконнект отменён
  });

  it('shouldForward фильтрует события', async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    const client = makeClient(vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"stream.chunk","sessionId":"ses-1","data":{"stream_id":"st1","content":"x"},"timestamp":"t"}\n\n',
      'data: {"type":"stream.done","sessionId":"ses-1","data":{"stream_id":"st1"},"timestamp":"t"}\n\n',
    ])));

    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
      shouldForward: (e) => e.type !== 'stream.chunk',
    });
    bridge.start();

    await vi.waitFor(() => expect(received.length).toBe(1));
    expect(received[0]!.type).toBe('stream.done');
    bridge.stop();
  });

  it('onStatusChange вызывается при подключении и разрыве', async () => {
    const bus = new EventBus();
    const statuses: boolean[] = [];

    const request = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        'data: {"type":"stream.start","sessionId":"ses-1","data":{"stream_id":"st1"},"timestamp":"t"}\n\n',
      ]))
      .mockResolvedValue(closedResponse()); // последующие стримы просто закрываются

    const client = makeClient(request);
    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
      reconnectDelayMs: 60_000, // большая задержка, чтобы не мешал реконнект
    });
    bridge.onStatusChange = (c) => statuses.push(c);

    bridge.start();
    await vi.waitFor(() => expect(statuses.length).toBe(2), { timeout: 3000 });

    expect(statuses).toEqual([true, false]);
    bridge.stop();
  });

  it('события без sessionId игнорируются (не роняют стрим)', async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    const client = makeClient(vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"connected","data":{},"timestamp":"t"}\n\n',
      'data: {"type":"stream.chunk","sessionId":"ses-1","data":{"stream_id":"st1","content":"x"},"timestamp":"t"}\n\n',
    ])));

    const bridge = new RemoteEventBridge({
      client,
      getToken: async () => 'tok',
      eventBus: bus,
      backendUrl: 'http://backend.test',
    });
    bridge.start();

    await vi.waitFor(() => expect(received.length).toBe(1));
    expect(received[0]!.type).toBe('stream.chunk');
    bridge.stop();
  });
});
