/**
 * ADR-107: тесты CLI `synth memory …`.
 *
 * Команды вызываются **программно** (`program.parseAsync`) на отдельном
 * `Command`, транспорт — подменённый `fetchImpl` (сети нет): проверяются
 * URL/метод/тело запроса, заголовок `Authorization`, разбор ответа, вывод в
 * `stdout`/`stderr` и код выхода (`process.exitCode`).
 *
 * Ожидание `--wait` детерминировано: `now` и `sleep` инъектированы, поэтому
 * тест не ждёт реального времени (таймаут «вечного building» срабатывает за
 * один опрос).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Command } from 'commander';

import { createMemoryCommand } from './memory-commands.js';

/** Зафиксированный запрос к API. */
interface FetchCall {
  url: string;
  method: string;
  authorization?: string;
  body?: unknown;
}

/** Ответчик на запрос (очередь — по порядку вызовов). */
type Responder = (call: FetchCall) => Response;

/** Прежний `process.exitCode` — восстанавливается после каждого теста. */
const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

/** JSON-ответ сервера. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Подменённый `fetch`: пишет вызовы и отвечает по очереди ответчиков. */
function makeFetch(responders: Responder[]): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) throw new Error(`Неожиданный запрос: ${call.method} ${call.url}`);
    return responder(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Параметры прогона CLI. */
interface RunOptions {
  /** Очередь ответов сервера. */
  responders: Responder[];
  /** Токен подключения (пустой — «не задан API-ключ»). */
  token?: string;
  /** Базовый URL инстанса. */
  baseUrl?: string;
  /** Инъекция времени (дедлайн `--wait`). */
  now?: () => number;
  /** Инъекция паузы между опросами. */
  sleep?: (ms: number) => Promise<void>;
  /** Интервал опроса, мс. */
  pollIntervalMs?: number;
}

/** Итог прогона CLI. */
interface RunResult {
  code: number;
  out: string;
  err: string;
  calls: FetchCall[];
}

/** Выполнить `synth memory …` программно на стенде. */
async function runMemory(args: string[], opts: RunOptions): Promise<RunResult> {
  const { impl, calls } = makeFetch(opts.responders);
  const outLines: string[] = [];
  const errLines: string[] = [];

  const program = new Command().name('synth');
  program.exitOverride();
  program.addCommand(
    createMemoryCommand({
      resolveConnection: async () => ({
        baseUrl: opts.baseUrl ?? 'http://127.0.0.1:5000',
        token: opts.token ?? 'test-token',
      }),
      fetchImpl: impl,
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    }),
  );

  await program.parseAsync(['node', 'synth', 'memory', ...args]);

  return {
    code: typeof process.exitCode === 'number' ? process.exitCode : 0,
    out: outLines.join('\n'),
    err: errLines.join('\n'),
    calls,
  };
}

/** Снимок статуса портала памяти (ответ `GET /memory/status`). */
const STATUS_BODY = {
  provider: { id: 'plugin:synth-plugin-memory', mode: 'inline', active: true },
  readiness: 'ready',
  namespace: 'plugin:synth-plugin-memory',
  facts: { total: 12, active: 8 },
  indexes: { total: 2, ready: 1, stale: 1, failed: 0, building: 0 },
};

describe('synth memory status', () => {
  it('--json → запрос к /api/v2/memory/status с Bearer и печать JSON', async () => {
    const result = await runMemory(['status', '--json'], {
      responders: [() => json(200, STATUS_BODY)],
    });

    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.url).toBe('http://127.0.0.1:5000/api/v2/memory/status');
    expect(result.calls[0]?.method).toBe('GET');
    expect(result.calls[0]?.authorization).toBe('Bearer test-token');
    expect(JSON.parse(result.out)).toEqual(STATUS_BODY);
  });

  it('человекочитаемый вывод: готовность, провайдер, счётчики', async () => {
    const result = await runMemory(['status'], {
      responders: [() => json(200, STATUS_BODY)],
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain('Готовность: ready');
    expect(result.out).toContain('активен');
    expect(result.out).toContain('Факты: всего 12, активных 8');
    expect(result.out).toContain('Индексы: всего 2');
  });
});

describe('synth memory list', () => {
  it('фильтры проекта и состояния уходят в query, печатается таблица', async () => {
    const result = await runMemory(['list', '--project', 'p1', '--state', 'ready'], {
      responders: [
        () =>
          json(200, {
            items: [
              {
                id: 'idx_1',
                name: 'docs',
                projectId: 'p1',
                source: { kind: 'files', filter: '**/*.md' },
                state: 'ready',
                generation: 3,
                stats: { chunks: 7 },
                updatedAt: '2026-10-25T10:00:00.000Z',
              },
            ],
            total: 1,
          }),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]?.url).toBe(
      'http://127.0.0.1:5000/api/v2/memory/indexes?projectId=p1&state=ready',
    );
    expect(result.out).toContain('idx_1');
    expect(result.out).toContain('docs');
    expect(result.out).toContain('Всего: 1');
  });
});

describe('synth memory index', () => {
  it('создание индекса: тело {name, source:{kind,filter}, projectId}, печать id', async () => {
    const result = await runMemory(
      ['index', 'p1', '--name', 'docs', '--source', 'files', '--filter', '**/*.md'],
      {
        responders: [
          () =>
            json(202, {
              index: { id: 'idx_1', state: 'building' },
              message: 'Индекс памяти создан',
            }),
        ],
      },
    );

    expect(result.code).toBe(0);
    expect(result.calls[0]?.method).toBe('POST');
    expect(result.calls[0]?.url).toBe('http://127.0.0.1:5000/api/v2/memory/indexes');
    expect(result.calls[0]?.body).toEqual({
      name: 'docs',
      source: { kind: 'files', filter: '**/*.md' },
      projectId: 'p1',
    });
    expect(result.out).toContain('idx_1');
    expect(result.out).toContain('building');
  });

  it('--wait: опрос состояния building → ready, не менее двух обращений', async () => {
    const result = await runMemory(['index', 'p1', '--wait'], {
      responders: [
        () => json(202, { index: { id: 'idx_1', state: 'building' } }),
        () => json(200, { items: [{ id: 'idx_1', state: 'building' }], total: 1 }),
        () =>
          json(200, {
            items: [{ id: 'idx_1', state: 'ready', generation: 2, stats: { chunks: 5 } }],
            total: 1,
          }),
      ],
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    expect(result.code).toBe(0);
    const polls = result.calls.filter((call) => call.method === 'GET');
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(result.out).toContain('Индекс готов');
  });

  it('--wait --timeout 1 при вечном building → код 1 и сообщение о таймауте', async () => {
    let clock = 0;
    const result = await runMemory(['index', 'p1', '--wait', '--timeout', '1'], {
      responders: [
        () => json(202, { index: { id: 'idx_1', state: 'building' } }),
        () => json(200, { items: [{ id: 'idx_1', state: 'building' }], total: 1 }),
        () => json(200, { items: [{ id: 'idx_1', state: 'building' }], total: 1 }),
      ],
      now: () => (clock += 1000),
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('TIMEOUT');
    expect(result.err).toContain('таймаут');
  });

  it('неизвестный вид источника → код 1 и перечень допустимых значений', async () => {
    const result = await runMemory(['index', 'p1', '--source', 'wiki'], {
      responders: [],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('VALIDATION_ERROR');
    expect(result.err).toContain('files | facts');
    expect(result.calls).toHaveLength(0);
  });
});

describe('synth memory rebuild', () => {
  it('пересборка: POST /memory/indexes/:id/rebuild', async () => {
    const result = await runMemory(['rebuild', 'idx_1'], {
      responders: [() => json(202, { index: { id: 'idx_1', state: 'building' } })],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]?.method).toBe('POST');
    expect(result.calls[0]?.url).toBe(
      'http://127.0.0.1:5000/api/v2/memory/indexes/idx_1/rebuild',
    );
    expect(result.out).toContain('idx_1');
  });
});

describe('synth memory drop', () => {
  it('без --yes → отказ (код 1) и DELETE не отправляется', async () => {
    const result = await runMemory(['drop', 'idx_1'], { responders: [] });

    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(0);
    expect(result.err).toContain('--yes');
  });

  it('с --yes → DELETE /memory/indexes/:id (204)', async () => {
    const result = await runMemory(['drop', 'idx_1', '--yes'], {
      responders: [() => new Response(null, { status: 204 })],
    });

    expect(result.code).toBe(0);
    expect(result.calls[0]?.method).toBe('DELETE');
    expect(result.calls[0]?.url).toBe('http://127.0.0.1:5000/api/v2/memory/indexes/idx_1');
    expect(result.out).toContain('idx_1');
  });

  it('--json → печать JSON без украшений', async () => {
    const result = await runMemory(['drop', 'idx_1', '--yes', '--json'], {
      responders: [() => new Response(null, { status: 204 })],
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ id: 'idx_1', deleted: true });
  });
});

describe('synth memory: ошибки', () => {
  it('HTTP 409 → код и сообщение из тела в stderr, код выхода 1', async () => {
    const result = await runMemory(['status'], {
      responders: [
        () =>
          json(409, {
            error: {
              code: 'MEMORY_PROVIDER_UNAVAILABLE',
              message: 'Провайдер памяти недоступен: плагин памяти не активен',
            },
          }),
      ],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('MEMORY_PROVIDER_UNAVAILABLE');
    expect(result.err).toContain('Провайдер памяти недоступен');
  });

  it('сетевая ошибка → сообщение в stderr, код выхода 1', async () => {
    const result = await runMemory(['status'], {
      responders: [
        () => {
          throw new Error('connection refused');
        },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('NETWORK_ERROR');
    expect(result.err).toContain('connection refused');
  });

  it('без токена → понятная ошибка «не задан API-ключ», запросов нет', async () => {
    const result = await runMemory(['status'], { responders: [], token: '' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('API-ключ');
    expect(result.calls).toHaveLength(0);
  });
});
