/**
 * Клиент PTY-сессий удалённого порта (протокол 8, план терминалов Ф2b).
 *
 * Проверяется провод и семантика хэндла:
 *
 * - признак `pty` — по `features.pty` **и** совместимости версии протокола
 *   (исполнитель протокола ≤ 7 терминалы не умеет);
 * - `openPty` открывает сессию и **читает кадры** NDJSON-потока (`onData`);
 * - `write`/`resize`/`close` дёргают свои пути (`/pty/:id/input|resize|close`);
 * - `pty_unsupported` → `ExecutionError` с кодом `EPTY` и причиной
 *   `dependency_missing` (fail-closed: тихого возврата к неинтерактивной
 *   команде нет);
 * - **недоступный пул** (ни один адрес не ответил на `/capabilities`) →
 *   `EUNREACHABLE`/`spawn_failed` — это не «нет PTY»: причина повторяемая
 *   (холодный под ещё поднимается, прогрев повторит вызов);
 * - обрыв потока → `onExit` **один раз** (`stream_lost`), сессия мёртвая.
 *
 * Транспорт подменён фейком (`fetchImpl`) — сеть в тесте не участвует.
 */

import { describe, expect, it } from 'vitest';
import { ExecutionError } from '@itphx/synth-core';
import { createRemoteExecutionPort, type ExecutorFetch } from './client.js';

const TOKEN = 'executor-pty-client-token-test-1234567890';

/** Записанный вызов фейкового транспорта. */
interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/** NDJSON-кадр потока вывода. */
const frame = (seq: number, data: string): string => `${JSON.stringify({ seq, data })}\n`;

/**
 * Фейковый исполнитель: `/capabilities`, `/pty/*` и поток вывода.
 *
 * `streamError` — поток рвётся ошибкой вместо нормального конца (обрыв
 * сети); `openStatus`/`openBody` — ответ на `POST /pty/open` (например,
 * `501 pty_unsupported`).
 */
function createFakeExecutor(opts: {
  capabilities?: Record<string, unknown>;
  openStatus?: number;
  openBody?: unknown;
  frames?: string[];
  streamError?: boolean;
  /** Поток не закрывается (терминал жив) — для проверок ввода/размера. */
  keepOpen?: boolean;
  /** Ответ `GET /pty/:id/foreground` (протокол 9). */
  foreground?: unknown;
}): { fetchImpl: ExecutorFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const capabilities = opts.capabilities ?? {
    protocol: 8,
    toolchain: { sh: 'sh 5.2' },
    features: { pty: true },
  };

  const fetchImpl: ExecutorFetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    calls.push({ url: input, method, ...(body !== undefined ? { body } : {}) });

    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (input.endsWith('/capabilities')) return json(capabilities);
    if (input.endsWith('/pty/open')) {
      if (opts.openStatus && opts.openStatus >= 400) {
        return json(opts.openBody ?? { error: { reason: 'internal_error', message: 'boom' } }, opts.openStatus);
      }
      return json({ id: 'pty_test', pid: 4242, cols: 80, rows: 24 }, 201);
    }
    if (input.includes('/stream')) {
      const frames = opts.frames ?? [frame(1, 'first'), frame(2, 'second')];
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < frames.length) {
            controller.enqueue(encoder.encode(frames[index] as string));
            index += 1;
            return;
          }
          if (opts.keepOpen) {
            // Терминал жив: поток не закрывается (закрывает его клиент).
            return new Promise<void>(() => {});
          }
          if (opts.streamError) {
            controller.error(new Error('socket hang up'));
            return;
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }
    if (input.endsWith('/foreground')) {
      return json({ foreground: opts.foreground ?? null });
    }
    if (input.endsWith('/input')) return json({ id: 'pty_test', bytes: 5 });
    if (input.endsWith('/resize')) return json({ cols: 120, rows: 40 });
    if (input.endsWith('/close')) return json({ id: 'pty_test', closed: true });
    return json({ error: { reason: 'not_found', message: 'unknown route' } }, 404);
  };

  return { fetchImpl, calls };
}

/** Порт удалённого исполнения на фейковом транспорте. */
function createPort(fetchImpl: ExecutorFetch) {
  return createRemoteExecutionPort({
    urls: ['http://exec-pty:5100'],
    token: TOKEN,
    fetchImpl,
  });
}

describe('клиент удалённого порта: PTY (протокол 8, Ф2b)', () => {
  it('признак pty — по features.pty и протоколу ≥ 8', async () => {
    const { fetchImpl } = createFakeExecutor({});
    const port = createPort(fetchImpl);

    // До первого снимка инвентаря — «состав пула неизвестен» (undefined),
    // а не «не умеет»: неизвестное не значит «нет».
    expect(port.pty).toBeUndefined();

    await port.probe?.('sh');
    expect(port.pty).toBe(true);
  });

  it('исполнитель протокола 7: pty не выставляется, openPty → EPTY', async () => {
    const { fetchImpl } = createFakeExecutor({
      capabilities: { protocol: 7, toolchain: { sh: 'sh 5.2' }, features: { pty: true } },
    });
    const port = createPort(fetchImpl);

    await port.probe?.('sh');
    expect(port.pty).toBe(false);

    const err = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 }).catch((e: unknown) => e);    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EPTY');
    expect((err as ExecutionError).reason).toBe('dependency_missing');
  });

  it('все адреса недоступны: openPty → EUNREACHABLE (не EPTY), причина повторяемая', async () => {
    // Холодный пул: под стартует / тянется образ — `/capabilities` не отвечает.
    const fetchImpl: ExecutorFetch = async (input) => {
      if (input.endsWith('/capabilities')) {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5100'), {
          code: 'ECONNREFUSED',
        });
      }
      return new Response(JSON.stringify({ error: { reason: 'not_found', message: 'unknown' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    const port = createPort(fetchImpl);

    const err = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    // Недоступность ≠ отсутствие PTY: `EPTY` не повторяется, `EUNREACHABLE` —
    // повторяется прогревом пула.
    expect((err as ExecutionError).code).toBe('EUNREACHABLE');
    expect((err as ExecutionError).reason).toBe('spawn_failed');
  });

  it('openPty открывает сессию и читает кадры потока', async () => {
    const { fetchImpl, calls } = createFakeExecutor({});
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    expect(handle.id).toBe('pty_test');
    expect(handle.pid).toBe(4242);

    const chunks: string[] = [];
    handle.onData((chunk) => chunks.push(chunk));

    // Кадры приходят из потока — дожидаемся их.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks).toEqual(['first', 'second']);

    const openCall = calls.find((call) => call.url.endsWith('/pty/open'));
    expect(openCall?.method).toBe('POST');
    // Клиентский `id` не передаётся: идентификатор выдаёт исполнитель.
    expect(openCall?.body).toEqual({ cwd: '/workspace', cols: 80, rows: 24 });

    const streamCall = calls.find((call) => call.url.includes('/stream'));
    expect(streamCall?.url).toBe('http://exec-pty:5100/pty/pty_test/stream?since=0');
  });

  it('write/resize/close дёргают свои пути', async () => {
    const { fetchImpl, calls } = createFakeExecutor({ keepOpen: true });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    handle.write('ls\n');
    handle.resize(120, 40);
    await handle.close();

    const input = calls.find((call) => call.url.endsWith('/pty/pty_test/input'));
    expect(input?.method).toBe('POST');
    expect(input?.body).toEqual({ data: 'ls\n' });

    const resize = calls.find((call) => call.url.endsWith('/pty/pty_test/resize'));
    expect(resize?.method).toBe('POST');
    expect(resize?.body).toEqual({ cols: 120, rows: 40 });

    const close = calls.find((call) => call.url.endsWith('/pty/pty_test/close'));
    expect(close?.method).toBe('POST');
  });

  it('close идемпотентен (повторный вызов не дублирует запрос)', async () => {
    const { fetchImpl, calls } = createFakeExecutor({ keepOpen: true });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    await handle.close();
    await handle.close();

    expect(calls.filter((call) => call.url.endsWith('/pty/pty_test/close'))).toHaveLength(1);
  });

  it('pty_unsupported (501) → EPTY/dependency_missing', async () => {
    const { fetchImpl } = createFakeExecutor({
      openStatus: 501,
      openBody: {
        error: {
          reason: 'pty_unsupported',
          code: 'EPTY',
          message: 'PTY-контур исполнителя выключен',
        },
      },
    });
    const port = createPort(fetchImpl);

    const err = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EPTY');
    expect((err as ExecutionError).reason).toBe('dependency_missing');
  });

  it('исполнитель протокола 8: метода inspect нет (проба не поддерживается)', async () => {
    const { fetchImpl, calls } = createFakeExecutor({ keepOpen: true });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    // Исполнитель 8 маршрута `/pty/:id/foreground` не знает: поля нет, и
    // вызывающий работает по прежним эвристикам (а не получает тихий `null`).
    expect(handle.inspect).toBeUndefined();
    expect(calls.some((call) => call.url.endsWith('/foreground'))).toBe(false);
    await handle.close();
  });

  it('протокол 9: inspect дёргает /pty/:id/foreground и отдаёт факт', async () => {
    const foreground = {
      shellPid: 4242,
      foregroundPgid: 555,
      command: 'vim',
      isShell: false,
    };
    const { fetchImpl, calls } = createFakeExecutor({
      capabilities: { protocol: 9, toolchain: { sh: 'sh 5.2' }, features: { pty: true } },
      foreground,
      keepOpen: true,
    });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    expect(handle.inspect).toBeTypeOf('function');
    expect(await handle.inspect?.()).toEqual(foreground);

    const call = calls.find((entry) => entry.url.endsWith('/pty/pty_test/foreground'));
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('http://exec-pty:5100/pty/pty_test/foreground');

    await handle.close();
    // Закрытая сессия на пробу отвечает `null` (транспорт не дёргается).
    expect(await handle.inspect?.()).toBeNull();
  });

  it('протокол 9, foreground: null — «неизвестно» (не ошибка)', async () => {
    const { fetchImpl } = createFakeExecutor({
      capabilities: { protocol: 9, toolchain: { sh: 'sh 5.2' }, features: { pty: true } },
      foreground: null,
      keepOpen: true,
    });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    expect(await handle.inspect?.()).toBeNull();
    await handle.close();
  });

  it('обрыв потока → onExit один раз (stream_lost), сессия мёртвая', async () => {
    const { fetchImpl } = createFakeExecutor({ streamError: true });
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    const exits: Array<{ exitCode?: number; signal?: string }> = [];
    handle.onExit((info) => exits.push(info));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exits).toHaveLength(1);
    expect(exits[0]?.signal).toBe('stream_lost');

    // Второй сигнал не приходит: событие выхода — одно.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toHaveLength(1);
  });

  it('вывод, пришедший до подписки, не теряется', async () => {
    const { fetchImpl } = createFakeExecutor({});
    const port = createPort(fetchImpl);

    const handle = await port.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    // Подписка — после чтения кадров (буфер ожидания).
    await new Promise((resolve) => setTimeout(resolve, 20));

    const chunks: string[] = [];
    handle.onData((chunk) => chunks.push(chunk));
    expect(chunks).toEqual(['first', 'second']);
  });
});
