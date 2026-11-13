import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egressFetch, ExecutionError } from '@itphx/synth-core';
import type {
  BrowserCallRequest,
  ExecBackgroundProcess,
  ExecutionMetricsSink,
  ExecutionPort,
} from '@itphx/synth-core';
import { MAX_EXECUTION_BROWSER_TIMEOUT_MS } from '@itphx/synth-shared';
import {
  ExecutionFsUnavailableError,
  FsPathError,
  isFsPathError,
} from '@itphx/synth-core';
import {
  BROWSER_MCP_CALL_TIMEOUT_MS,
  createRemoteExecutionPort,
  REMOTE_TIMEOUT_GRACE_MS,
  RemoteExecutionPort,
  type ExecutorFetch,
} from './client.js';
import { startExecutorServer, type ExecutorHandle } from './server.js';

const TOKEN = 'executor-client-token-test-1234567890';

// Фикстура: PEM собирается в рантайме, чтобы в исходниках не было литерала
// заголовка приватного ключа (secret-scan); тело — заведомая заглушка.
const pem = (body: string): string => {
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

let workspace: string;
let handles: ExecutorHandle[] = [];
/** «Старые» исполнители (протокол v2 — без фоновых процессов). */
let legacyServers: Server[] = [];

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-client-')));
});

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles = [];
  for (const server of legacyServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  legacyServers = [];
  await rm(workspace, { recursive: true, force: true });
});

/** Поднять исполнитель на случайном порту. */
async function startExecutor(): Promise<ExecutorHandle> {
  const handle = await startExecutorServer({
    token: TOKEN,
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    toolchain: {},
  });
  handles.push(handle);
  return handle;
}

/** Порт, на котором никто не слушает (соединение отклоняется). */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * «Старый» исполнитель: отвечает на `/capabilities` заданным телом.
 *
 * Нужен для аддитивных полей: у старого исполнителя поля `limits` нет —
 * это норма, а не ошибка.
 */
async function startLegacyExecutor(body: Record<string, unknown>): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  legacyServers.push(server);
  return `http://127.0.0.1:${port}`;
}

/**
 * Исполнитель протокола v6 **без** признака `features.secretsSpawn`:
 * фоновые процессы умеет, а секреты вызова в фоне — нет (PROP-124 §7).
 */
async function startLegacySecretsSpawnExecutor(): Promise<{
  url: string;
  spawnCalls: () => number;
}> {
  let spawnCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocol: 6,
          toolchain: { sh: 'sh 5.2' },
          os: process.platform,
          arch: process.arch,
          node: process.version,
          features: { background: true, secrets: true, sshAgent: true },
        }),
      );
      return;
    }
    if (req.url === '/exec/spawn') {
      spawnCalls += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ processId: 'proc_legacy' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  legacyServers.push(server);
  return { url: `http://127.0.0.1:${port}`, spawnCalls: () => spawnCalls };
}

/**
 * Ответ FS-роута в фейковом исполнителе.
 *
 * `body` — JSON-ответ (как у прочих FS-роутов); `raw` — **бинарный** ответ
 * (как у `/fs/download`): тело отдаётся как есть, заголовки — `content-type`
 * `application/octet-stream`, `content-length` и `x-synth-size` (размер,
 * известный до чтения тела). `headers` перекрывают их (например, чтобы
 * объявить размер больше фактического — как «файл не влез»).
 */
type FsAnswer = {
  status: number;
  body?: unknown;
  raw?: Buffer;
  headers?: Record<string, string>;
};

/**
 * Исполнитель с FS-операциями (`features.fs`, протокол 7, PROP-135).
 *
 * Отвечает на `/capabilities` и на FS-роуты; ответ FS-роута задаётся
 * параметром: либо один общий ответ, либо карта «роут → ответ» (для
 * разных операций — разные тела).
 */
async function startFsExecutor(
  capabilities: Record<string, unknown>,
  fsResponse?:
    | FsAnswer
    | Record<string, FsAnswer>,
): Promise<{
  url: string;
  fsCalls: () => string[];
  fsBodies: () => Array<{ url: string; body: unknown }>;
  fsRawBodies: () => string[];
}> {
  const calls: string[] = [];
  const bodies: Array<{ url: string; body: unknown }> = [];
  const rawBodies: string[] = [];
  const single: FsAnswer | undefined =
    fsResponse && typeof (fsResponse as FsAnswer).status === 'number'
      ? (fsResponse as FsAnswer)
      : undefined;
  const byRoute: Record<string, FsAnswer> | undefined =
    fsResponse && !single ? (fsResponse as Record<string, FsAnswer>) : undefined;
  const server = createServer((req, res) => {
    if (req.url === '/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(capabilities));
      return;
    }
    if (req.url?.startsWith('/fs/')) {
      calls.push(req.url);
      let raw = '';
      req.on('data', (chunk: Buffer | string) => {
        raw += chunk;
      });
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          parsed = undefined;
        }
        bodies.push({ url: req.url as string, body: parsed });
        rawBodies.push(raw);
        const answer: FsAnswer =
          byRoute?.[req.url as string]
          ?? single
          ?? { status: 200, body: { stat: { kind: 'file', size: 42, mtimeMs: 1 } } };
        if (answer.raw !== undefined) {
          res.writeHead(answer.status, {
            'content-type': 'application/octet-stream',
            'content-length': String(answer.raw.length),
            'x-synth-size': String(answer.raw.length),
            ...(answer.headers ?? {}),
          });
          res.end(answer.raw);
          return;
        }
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  legacyServers.push(server);
  return {
    url: `http://127.0.0.1:${port}`,
    fsCalls: () => calls,
    fsBodies: () => bodies,
    fsRawBodies: () => rawBodies,
  };
}

/** Состав capabilities исполнителя с FS-операциями. */
function fsCapabilities(): Record<string, unknown> {
  return {
    protocol: 7,
    toolchain: { sh: 'sh 5.2' },
    os: process.platform,
    arch: process.arch,
    node: process.version,
    features: {
      background: true,
      secrets: true,
      mcpAttachments: true,
      sshAgent: true,
      secretsSpawn: true,
      fs: true,
    },
  };
}

describe('клиент удалённого порта', () => {
  it('успешный вызов — stdout/exitCode/durationMs', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf out' } });
    expect(res.stdout).toBe('out');
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ненулевой код выхода — ExecutionError с reason nonzero_exit', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    await expect(
      port.execute({ command: { kind: 'shell', command: 'printf o; exit 7' } }),
    ).rejects.toMatchObject({ reason: 'nonzero_exit', code: 7, stdout: 'o' });
  });

  it('адреса перебираются по кругу (round-robin)', async () => {
    const first = await startExecutor();
    const second = await startExecutor();
    const hits: string[] = [];
    const counting: ExecutorFetch = async (url, init) => {
      hits.push(new URL(url).port);
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [first.url, second.url],
      token: TOKEN,
      fetchImpl: counting,
    });
    await port.execute({ command: { kind: 'shell', command: 'printf 1' } });
    await port.execute({ command: { kind: 'shell', command: 'printf 2' } });
    await port.execute({ command: { kind: 'shell', command: 'printf 3' } });
    expect(hits).toEqual([String(first.port), String(second.port), String(first.port)]);
  });

  it('ошибка соединения — переход на следующий адрес', async () => {
    const handle = await startExecutor();
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`, handle.url],
      token: TOKEN,
    });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf ok' } });
    expect(res.stdout).toBe('ok');
  });

  it('failMode "fail" — все адреса недоступны → ExecutionError (fail-closed)', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'fail',
    });
    const err = await port.execute({ command: { kind: 'shell', command: 'printf ok' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('spawn_failed');
    expect((err as ExecutionError).code).toBe('EUNREACHABLE');
  });

  it('failMode "inline-fallback" — исполнение в процессе', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'inline-fallback',
    });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf local' } });
    expect(res.stdout).toBe('local');
  });

  it('отмена по AbortSignal — ExecutionError с reason aborted', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const ac = new AbortController();
    const promise = port.execute({
      command: { kind: 'shell', command: 'sleep 5' },
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('aborted');
  });

  it('лимит одновременных вызовов — остальные ждут в очереди', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      concurrency: 1,
    });
    const started = Date.now();
    await Promise.all([
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
    ]);
    // Второй вызов ждал завершения первого (лимит — одна одновременная команда).
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('неверный токен — ошибка сервера реконструируется в ExecutionError', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: 'wrong-token' });
    const err = await port.execute({ command: { kind: 'shell', command: 'printf x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EAUTH');
  });

  it('cwd вне workspace — ошибка cwd_outside_workspace', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const err = await port
      .execute({ command: { kind: 'shell', command: 'pwd' }, cwd: '/etc' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EWORKSPACE');
  });
});

/**
 * ADR-094/ADR-077: приёмник метрик исполнения на стороне control plane.
 *
 * Клиент удалённого порта **не знает** про реестр метрик — он получает узкий
 * приёмник (`ExecutionMetricsSink`) и сообщает о событиях: постановка в
 * очередь, получение слота (с временем ожидания), старт и завершение (исход).
 */
describe('клиент удалённого порта: приёмник метрик исполнения', () => {
  /** События приёмника в порядке поступления. */
  interface SinkEvent {
    kind: 'queued' | 'dequeued' | 'started' | 'finished';
    waitMs?: number;
    outcome?: string;
  }

  /** Приёмник, пишущий события в список. */
  function recordingSink(events: SinkEvent[]): ExecutionMetricsSink {
    return {
      onQueued: () => events.push({ kind: 'queued' }),
      onDequeued: (waitMs) => events.push({ kind: 'dequeued', waitMs }),
      onStarted: () => events.push({ kind: 'started' }),
      onFinished: (outcome) => events.push({ kind: 'finished', outcome }),
    };
  }

  it('успешный вызов: очередь → слот → старт → успех', async () => {
    const handle = await startExecutor();
    const events: SinkEvent[] = [];
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      metricsSink: recordingSink(events),
    });

    await port.execute({ command: { kind: 'shell', command: 'printf ok' } });

    expect(events.map((e) => e.kind)).toEqual(['queued', 'dequeued', 'started', 'finished']);
    expect(events[1]!.waitMs).toBeGreaterThanOrEqual(0);
    expect(events[3]!.outcome).toBe('ok');
  });

  it('ненулевой код выхода — исход error', async () => {
    const handle = await startExecutor();
    const events: SinkEvent[] = [];
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      metricsSink: recordingSink(events),
    });

    await expect(
      port.execute({ command: { kind: 'shell', command: 'exit 7' } }),
    ).rejects.toBeInstanceOf(ExecutionError);

    const finished = events.find((e) => e.kind === 'finished');
    expect(finished?.outcome).toBe('error');
  });

  it('таймаут команды — исход timeout', async () => {
    const handle = await startExecutor();
    const events: SinkEvent[] = [];
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      metricsSink: recordingSink(events),
    });

    await expect(
      port.execute({ command: { kind: 'shell', command: 'sleep 5' }, timeoutMs: 200 }),
    ).rejects.toMatchObject({ reason: 'timeout' });

    const finished = events.find((e) => e.kind === 'finished');
    expect(finished?.outcome).toBe('timeout');
  });

  it('отмена по AbortSignal — исход cancelled', async () => {
    const handle = await startExecutor();
    const events: SinkEvent[] = [];
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      metricsSink: recordingSink(events),
    });
    const controller = new AbortController();

    const pending = port.execute({
      command: { kind: 'shell', command: 'sleep 5' },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });

    const finished = events.find((e) => e.kind === 'finished');
    expect(finished?.outcome).toBe('cancelled');
  });

  it('очередь: второй вызов ждёт слот и попадает в гистограмму ожидания', async () => {
    const handle = await startExecutor();
    const events: SinkEvent[] = [];
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      concurrency: 1,
      metricsSink: recordingSink(events),
    });

    await Promise.all([
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
    ]);

    const dequeued = events.filter((e) => e.kind === 'dequeued');
    expect(dequeued).toHaveLength(2);
    // Второй вызов ждал слот — ожидание измеримо (больше нуля).
    expect(dequeued[1]!.waitMs).toBeGreaterThan(0);
  });

  it('приёмник не задан — вызов работает как прежде (метрики не обязательны)', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf ok' } });
    expect(res.stdout).toBe('ok');
  });
});

/**
 * ADR-077: инвентарь пула (`GET /capabilities`) и маршрутизация команды по
 * бинарным требованиям (`ExecRequest.requires`).
 */
describe('клиент удалённого порта: инвентарь пула и маршрутизация', () => {
  /** Исполнитель с заданным составом toolchain'а. */
  async function startExecutorWithToolchain(toolchain: Record<string, string>): Promise<ExecutorHandle> {
    const handle = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain,
    });
    handles.push(handle);
    return handle;
  }

  it('инвентарь строится по /capabilities: probe отвечает по составу пула', async () => {
    const withGit = await startExecutorWithToolchain({ git: 'git version 2.39.2' });
    const withoutGit = await startExecutorWithToolchain({ sh: 'sh 5.2' });
    const port = createRemoteExecutionPort({
      urls: [withGit.url, withoutGit.url],
      token: TOKEN,
    });

    // `git` есть у одного из двух адресов → доступен (команда уйдёт туда).
    expect(await port.probe?.('git')).toBe(true);
    // `rg` нет ни у кого → недоступен.
    expect(await port.probe?.('rg')).toBe(false);
  });

  it('команда с requires уходит в адрес, где есть нужная программа', async () => {
    const withGit = await startExecutorWithToolchain({ git: 'git version 2.39.2' });
    const withoutGit = await startExecutorWithToolchain({ sh: 'sh 5.2' });
    const hits: string[] = [];
    const counting: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec')) hits.push(new URL(url).port);
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [withoutGit.url, withGit.url],
      token: TOKEN,
      fetchImpl: counting,
    });

    const res = await port.execute({
      command: { kind: 'shell', command: 'printf ok' },
      requires: ['git'],
    });
    expect(res.stdout).toBe('ok');
    // Исполнение — только у адреса с `git`.
    expect(hits).toEqual([String(withGit.port)]);
  });

  it('нет ни одного адреса с требуемой программой — различимая ошибка', async () => {
    const first = await startExecutorWithToolchain({ sh: 'sh 5.2' });
    const second = await startExecutorWithToolchain({ sh: 'sh 5.2' });
    const port = createRemoteExecutionPort({
      urls: [first.url, second.url],
      token: TOKEN,
    });

    const err = await port
      .execute({
        command: { kind: 'shell', command: 'printf ok' },
        requires: ['git'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('dependency_missing');
    expect((err as ExecutionError).code).toBe('EDEPENDENCY');
    expect((err as ExecutionError).message).toContain('git');
  });

  it('адрес, не ответивший на /capabilities, выпадает из маршрутизации', async () => {
    const alive = await startExecutorWithToolchain({ git: 'git version 2.39.2' });
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`, alive.url],
      token: TOKEN,
    });

    // Состав мёртвого адреса неизвестен → в маршрутизации он не участвует,
    // команда уходит живому адресу (у него `git` есть).
    const res = await port.execute({
      command: { kind: 'shell', command: 'printf ok' },
      requires: ['git'],
    });
    expect(res.stdout).toBe('ok');
    expect(await port.probe?.('git')).toBe(true);
  });

  it('пул целиком недоступен — поведение по failMode (fail-closed)', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'fail',
    });
    const err = await port
      .execute({
        command: { kind: 'shell', command: 'printf ok' },
        requires: ['git'],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EUNREACHABLE');
  });

  it('сводка о составе пула — сколько адресов без программы', async () => {
    const withGit = await startExecutorWithToolchain({ git: 'git version 2.39.2' });
    const withoutGit = await startExecutorWithToolchain({ sh: 'sh 5.2' });
    const port = createRemoteExecutionPort({
      urls: [withGit.url, withoutGit.url],
      token: TOKEN,
    });

    const summary = await port.capabilitySummary?.('git');
    expect(summary?.available).toBe(true);
    expect(summary?.missing).toBe(1);
    expect(summary?.total).toBe(2);
    expect(summary?.unreachable).toBe(0);
  });
});

/**
 * ADR-077: лимиты исполнителя (`limits` в `/capabilities`) — **аддитивное**
 * поле: снимает «тихий» потолок (control plane видит потолок заранее, а не
 * узнаёт об усечении по факту).
 *
 * Разбор в клиенте — **терпимый**: у старого исполнителя поля нет, и тогда
 * лимиты пула неизвестны (`undefined`), а поведение прежнее.
 */
describe('клиент удалённого порта: лимиты исполнителя', () => {
  it('исполнитель объявляет лимиты — клиент их читает', async () => {
    const handle = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: {},
      maxTimeoutMs: 600_000,
      maxOutputBytes: 10 * 1024 * 1024,
    });
    handles.push(handle);
    const port = new RemoteExecutionPort({ urls: [handle.url], token: TOKEN });

    const limits = await port.poolLimits();
    expect(limits?.timeoutMs).toBe(600_000);
    expect(limits?.maxOutputBytes).toBe(10 * 1024 * 1024);
  });

  it('старый исполнитель без поля limits — разбор терпимый (undefined)', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 5,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
            features: { background: true, secrets: true, mcpAttachments: true },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port: serverPort } = server.address() as AddressInfo;
    legacyServers.push(server);

    const port = new RemoteExecutionPort({
      urls: [`http://127.0.0.1:${serverPort}`],
      token: TOKEN,
    });
    // Поля нет → лимиты неизвестны, но клиент работает как прежде.
    expect(await port.poolLimits()).toBeUndefined();
  });

  it('нечисловые лимиты игнорируются (нет поля — нет и лимитов)', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 5,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
            limits: { timeoutMs: 'много', maxOutputBytes: -1 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port: serverPort } = server.address() as AddressInfo;
    legacyServers.push(server);

    const port = new RemoteExecutionPort({
      urls: [`http://127.0.0.1:${serverPort}`],
      token: TOKEN,
    });
    expect(await port.poolLimits()).toBeUndefined();
  });

  it('пул — минимум по ответившим адресам (команда может уйти на любой)', async () => {
    const withBigLimit = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: {},
      maxTimeoutMs: 1_800_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    handles.push(withBigLimit);
    const withSmallLimit = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: {},
      maxTimeoutMs: 600_000,
      maxOutputBytes: 10 * 1024 * 1024,
    });
    handles.push(withSmallLimit);

    const port = new RemoteExecutionPort({
      urls: [withBigLimit.url, withSmallLimit.url],
      token: TOKEN,
    });
    const limits = await port.poolLimits();
    expect(limits?.timeoutMs).toBe(600_000);
    expect(limits?.maxOutputBytes).toBe(10 * 1024 * 1024);
  });

  it('смешанный пул — лимиты неизвестны (адрес без limits не считается)', async () => {
    const withLimits = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: {},
      maxTimeoutMs: 600_000,
    });
    handles.push(withLimits);
    // Старый исполнитель: адрес отвечает, но поля `limits` у него нет.
    const legacyUrl = await startLegacyExecutor({
      protocol: 5,
      toolchain: { sh: 'sh 5.2' },
      os: process.platform,
      arch: process.arch,
      node: process.version,
    });

    const port = new RemoteExecutionPort({
      urls: [withLimits.url, legacyUrl],
      token: TOKEN,
    });
    // Команда может уйти на старый адрес (потолок 120 c) — потолок пула
    // неизвестен, поэтому лимиты пула не объявляем вовсе.
    expect(await port.poolLimits()).toBeUndefined();
  });

  it('пул целиком недоступен — лимиты неизвестны (undefined)', async () => {
    const port = new RemoteExecutionPort({
      urls: [`http://127.0.0.1:${await deadPort()}`],
      token: TOKEN,
    });
    expect(await port.poolLimits()).toBeUndefined();
  });
});

/**
 * ADR-077 (протокол 4): доставка секретов вызова исполнителю.
 *
 * Секрет уходит **значением** в теле `POST /exec` (путь control plane в
 * контейнере исполнителя не существует). Исполнитель, который секретов не
 * принимает (протокол < 4 и без `features.secrets`), — **fail-closed**:
 * выполнять команду без ключа нельзя (операция упала бы с невнятной ошибкой
 * аутентификации).
 */
describe('клиент удалённого порта: секреты вызова', () => {
  /** Исполнитель протокола v3 — секреты вызова не принимает. */
  async function startLegacySecretsExecutor(): Promise<{ url: string; execCalls: () => number }> {
    let execCalls = 0;
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 3,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
            features: { background: true },
          }),
        );
        return;
      }
      if (req.url === '/exec') {
        execCalls += 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { reason: 'internal_error', message: 'no' } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    legacyServers.push(server);
    return { url: `http://127.0.0.1:${port}`, execCalls: () => execCalls };
  }

  it('секрет уходит в теле POST /exec значением (не путём к файлу)', async () => {
    const handle = await startExecutor();
    const bodies: unknown[] = [];
    const capturing: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec') && typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body));
      }
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      fetchImpl: capturing,
    });

    const secret = {
      kind: 'ssh-key' as const,
      privateKey: pem('remote-secret'),
    };
    const res = await port.execute({
      command: { kind: 'shell', command: 'printf ok' },
      secrets: [secret],
    });
    expect(res.stdout).toBe('ok');

    const body = bodies.at(-1) as { secrets?: Array<{ kind: string; privateKey: string }> };
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets?.[0]?.kind).toBe('ssh-key');
    expect(body.secrets?.[0]?.privateKey).toBe(secret.privateKey);
  });

  it('исполнитель без поддержки секретов — fail-closed ESECRETS, команда не выполняется', async () => {
    const legacy = await startLegacySecretsExecutor();
    const port = createRemoteExecutionPort({ urls: [legacy.url], token: TOKEN });

    const err = await port
      .execute({
        command: { kind: 'shell', command: 'printf should-not-run' },
        secrets: [{ kind: 'ssh-key', privateKey: 'key-material' }],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('ESECRETS');
    // Команда не должна была выполниться «без ключа».
    expect(legacy.execCalls()).toBe(0);
  });

  it('фоновый запуск с секретами — fail-closed ESECRETS у адреса без features.secretsSpawn', async () => {
    // Исполнитель умеет фоновые процессы, но секреты в фоне **не принимает**
    // (признака `features.secretsSpawn` нет) — адрес в кандидаты не попадает.
    const legacy = await startLegacySecretsSpawnExecutor();
    const port = createRemoteExecutionPort({ urls: [legacy.url], token: TOKEN });

    const spawn = port.spawnBackground;
    if (!spawn) throw new Error('ожидалась поддержка фонового запуска');
    const err = await spawn
      .call(port, {
        command: { kind: 'shell', command: 'sleep 1' },
        secrets: [{ kind: 'ssh-key', privateKey: 'key-material' }],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('ESECRETS');
    // Процесс не должен был запуститься «без ключа».
    expect(legacy.spawnCalls()).toBe(0);
  });
});

/**
 * PROP-124 §2: секрет в режиме `agent` (`mode:'agent'`) — эфемерный
 * `ssh-agent` у точки исполнения.
 *
 * Исполнитель без признака `features.sshAgent` (протокол < 6) материализует
 * ключ **файлом** — вызов, ожидающий `SSH_AUTH_SOCK`, поехал бы «не как
 * заказано». Поэтому адрес не выбирается, а отказ — `ESECRETS`.
 */
describe('клиент удалённого порта: агентный режим секрета вызова', () => {
  /** Исполнитель протокола 4: секреты принимает, агентный режим — нет. */
  async function startLegacyAgentSecretsExecutor(): Promise<{
    url: string;
    execCalls: () => number;
  }> {
    let execCalls = 0;
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 4,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
            features: { secrets: true },
          }),
        );
        return;
      }
      if (req.url === '/exec') {
        execCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    legacyServers.push(server);
    return { url: `http://127.0.0.1:${port}`, execCalls: () => execCalls };
  }

  it('адрес без features.sshAgent не выбирается — fail-closed ESECRETS', async () => {
    const legacy = await startLegacyAgentSecretsExecutor();
    const port = createRemoteExecutionPort({ urls: [legacy.url], token: TOKEN });

    const err = await port
      .execute({
        command: { kind: 'shell', command: 'printf should-not-run' },
        secrets: [{ kind: 'ssh-key', privateKey: pem('agent-secret'), mode: 'agent' }],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('ESECRETS');
    // Текст отказа — внятный (про признак, а не «что-то сломалось»).
    expect((err as ExecutionError).message).toContain('sshAgent');
    // Команда не должна была выполниться «без ключа».
    expect(legacy.execCalls()).toBe(0);
  });

  it('адрес с features.sshAgent — выбирается, секрет уходит в тело POST /exec', async () => {
    // Исполнитель-стаб протокола 6: агентный режим объявляет, но материал
    // не материализует (нужен настоящий `ssh-agent` — его в тесте нет).
    let execCalls = 0;
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 6,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
            features: { background: true, secrets: true, sshAgent: true, secretsSpawn: true },
          }),
        );
        return;
      }
      if (req.url === '/exec') {
        execCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port: addrPort } = server.address() as AddressInfo;
    legacyServers.push(server);

    const bodies: unknown[] = [];
    const capturing: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec') && typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body));
      }
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${addrPort}`],
      token: TOKEN,
      fetchImpl: capturing,
    });

    const res = await port.execute({
      command: { kind: 'shell', command: 'printf ok' },
      secrets: [{ kind: 'ssh-key', privateKey: pem('agent-secret'), mode: 'agent' }],
    });
    expect(res.stdout).toBe('ok');
    expect(execCalls).toBe(1);

    const body = bodies.at(-1) as { secrets?: Array<{ mode?: string }> };
    expect(body.secrets?.[0]?.mode).toBe('agent');
  });
});

/**
 * ADR-077 (шаг 7c): фоновый запуск в удалённом порте.
 *
 * Процесс живёт на исполнителе, клиент наблюдает его опросом (журнал — 300 мс,
 * состояние — 500 мс) и отдаёт те же поля, что и inline-порт: `processId`,
 * `pid`, поток вывода, промис `exited`, `stop()`.
 */
describe('клиент удалённого порта: фоновый запуск', () => {
  /** Исполнитель протокола v2 — фоновых процессов не знает. */
  async function startLegacyExecutor(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.url === '/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 2,
            toolchain: { sh: 'sh 5.2' },
            os: process.platform,
            arch: process.arch,
            node: process.version,
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            reason: 'not_found',
            code: null,
            message: 'не найдено',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    legacyServers.push(server);
    return `http://127.0.0.1:${port}`;
  }

  /** Запустить фоновый процесс (метод обязан быть — иначе тест бессмыслен). */
  async function spawnBackground(
    port: ExecutionPort,
    command: string,
    requires?: string[],
  ): Promise<ExecBackgroundProcess> {
    const spawn = port.spawnBackground;
    if (!spawn) throw new Error('ожидалась поддержка фонового запуска');
    return spawn.call(port, {
      command: { kind: 'shell', command },
      ...(requires ? { requires } : {}),
    });
  }

  it('фоновый процесс: proc_-id, pid, вывод потоком, exited с кодом 0', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });

    const bg = await spawnBackground(port, 'printf hi; printf err >&2');
    expect(bg.processId).toMatch(/^proc_/);
    expect(bg.pid).toBeGreaterThan(0);

    const chunks: Array<{ stream: string; data: string }> = [];
    for await (const chunk of bg.output) {
      chunks.push({ stream: chunk.stream, data: chunk.data });
    }
    const stdout = chunks
      .filter((c) => c.stream === 'stdout')
      .map((c) => c.data)
      .join('');
    const stderr = chunks
      .filter((c) => c.stream === 'stderr')
      .map((c) => c.data)
      .join('');
    expect(stdout).toContain('hi');
    expect(stderr).toContain('err');

    const exit = await bg.exited;
    expect(exit.exitCode).toBe(0);
    expect(exit.signal).toBeNull();
  });

  it('ненулевой код завершения — в exitCode', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });

    const bg = await spawnBackground(port, 'exit 3');
    const exit = await bg.exited;
    expect(exit.exitCode).toBe(3);
    expect(exit.signal).toBeNull();
  });

  it('stop() — процесс завершается по сигналу (killed)', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });

    const bg = await spawnBackground(port, 'sleep 5');
    bg.stop();
    const exit = await bg.exited;
    expect(exit.signal).not.toBeNull();
    expect(exit.exitCode).toBeNull();
    // Повторный `stop()` — no-op (не бросает).
    expect(() => bg.stop()).not.toThrow();
  });

  it('недоступный адрес — ошибка запуска (fail-closed)', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'fail',
    });

    const err = await spawnBackground(port, 'sleep 1').catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('spawn_failed');
    expect((err as ExecutionError).code).toBe('EUNREACHABLE');
  });

  it('исполнитель исчез — exited резолвится, а не висит', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });

    const bg = await spawnBackground(port, 'sleep 5');
    // HTTP-сервер исполнитетеля остановлен — состояние процесса недоступно.
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));

    const exit = await bg.exited;
    expect(exit.exitCode).toBe(-1);
    expect(exit.signal).toBeNull();
  });

  it('исполнитель протокола v2 — фоновые процессы не поддержаны', async () => {
    const url = await startLegacyExecutor();
    const port = createRemoteExecutionPort({ urls: [url], token: TOKEN });

    const err = await spawnBackground(port, 'sleep 1').catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EBACKGROUND');
  });

  it('requires: адрес без нужной программы исключается из маршрутизации', async () => {
    const withGit = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: { git: 'git version 2.39.2' },
    });
    handles.push(withGit);
    const withoutGit = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: { sh: 'sh 5.2' },
    });
    handles.push(withoutGit);

    const spawnHits: string[] = [];
    const counting: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec/spawn')) spawnHits.push(new URL(url).port);
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [withoutGit.url, withGit.url],
      token: TOKEN,
      fetchImpl: counting,
    });

    const bg = await spawnBackground(port, 'printf ok', ['git']);
    const exit = await bg.exited;
    expect(exit.exitCode).toBe(0);
    // Запуск ушёл только к адресу, у которого есть требуемая программа.
    expect(spawnHits).toEqual([String(withGit.port)]);
  });

  /**
   * PROP-124 §7: секреты вызова в фоновом запуске.
   *
   * Адрес выбирается **только** тот, что объявляет `features.secretsSpawn`:
   * нет признака — адрес не выбирается (тихого фоллбека нет: процесс не должен
   * пойти без ключа).
   */
  it('секреты вызова уходят в тело POST /exec/spawn на адрес с features.secretsSpawn', async () => {
    const handle = await startExecutor();
    const bodies: unknown[] = [];
    const capturing: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec/spawn') && typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body));
      }
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      fetchImpl: capturing,
    });

    const secret = { kind: 'ssh-key' as const, privateKey: pem('bg-remote-secret') };
    const spawn = port.spawnBackground;
    if (!spawn) throw new Error('ожидалась поддержка фонового запуска');
    const bg = await spawn.call(port, {
      command: { kind: 'shell', command: 'sleep 0.2' },
      secrets: [secret],
    });
    const exit = await bg.exited;
    expect(exit.exitCode).toBe(0);

    const body = bodies.at(-1) as { secrets?: Array<{ kind: string; privateKey: string }> };
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets?.[0]?.privateKey).toBe(secret.privateKey);
  });

  it('адрес без features.secretsSpawn исключается из маршрутизации фонового запуска с секретами', async () => {
    const legacy = await startLegacySecretsSpawnExecutor();
    const handle = await startExecutor();
    const spawnHits: string[] = [];
    const counting: ExecutorFetch = async (url, init) => {
      if (url.endsWith('/exec/spawn')) spawnHits.push(new URL(url).port);
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [legacy.url, handle.url],
      token: TOKEN,
      fetchImpl: counting,
    });

    const spawn = port.spawnBackground;
    if (!spawn) throw new Error('ожидалась поддержка фонового запуска');
    const bg = await spawn.call(port, {
      command: { kind: 'shell', command: 'sleep 0.2' },
      secrets: [{ kind: 'ssh-key', privateKey: pem('bg-remote-secret') }],
    });
    const exit = await bg.exited;
    expect(exit.exitCode).toBe(0);
    // Запуск ушёл только к адресу с признаком `features.secretsSpawn`.
    expect(spawnHits).toEqual([String(handle.port)]);
  });
});

/**
 * FS-операции клиента удалённого порта (протокол 7, PROP-135 Ф1).
 *
 * Адрес выбирается по признаку `features.fs`: старый исполнитель (протокол
 * ≤ 6) его не объявляет ⇒ файловые тулы в remote-режиме **fail-closed**
 * (`ExecutionFsUnavailableError`), тихого возврата к чтению ФС в control plane
 * нет.
 */
describe('клиент удалённого порта: FS-операции', () => {
  it('исполнитель без features.fs — ExecutionFsUnavailableError (fail-closed)', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: { sh: 'sh 5.2' },
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true, secrets: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    const err = await port.fs!.stat('/tmp/x').catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionFsUnavailableError);
    expect((err as ExecutionFsUnavailableError).message).toContain('filesystem operations are unavailable');
  });

  it('исполнитель без features.fs — тот же отказ на realpath и readdir', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.realpath('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.readdir('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });

  it('исполнитель с features.fs — вызов уходит на его адрес', async () => {
    const executor = await startFsExecutor(fsCapabilities());
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const stat = await port.fs!.stat('/workspace/a.txt');
    expect(stat).toEqual({ kind: 'file', size: 42, mtimeMs: 1 });
    expect(executor.fsCalls()).toEqual(['/fs/stat']);
  });

  it('адрес без features.fs исключается — вызов уходит к адресу с признаком', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const executor = await startFsExecutor(fsCapabilities());
    const port = createRemoteExecutionPort({ urls: [legacy, executor.url], token: TOKEN });

    const stat = await port.fs!.stat('/workspace/a.txt');
    expect(stat.size).toBe(42);
    expect(executor.fsCalls()).toEqual(['/fs/stat']);
  });

  it('ошибка исполнителя по reason → FsPathError с машинным кодом', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 404,
      body: {
        error: {
          reason: 'not_found',
          code: 'ENOENT',
          message: 'путь не найден: /workspace/a.txt',
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
          truncated: false,
          durationMs: 0,
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.stat('/workspace/a.txt').catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('not_found');
    expect((err as FsPathError).path).toBe('/workspace/a.txt');
  });

  it('readdir — записи приходят из ответа исполнителя', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 200,
      body: {
        entries: [
          { name: 'sub', kind: 'directory', size: 4096 },
          { name: 'a.txt', kind: 'file', size: 5 },
        ],
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const entries = await port.fs!.readdir('/workspace');
    expect(entries).toEqual([
      { name: 'sub', kind: 'directory', size: 4096 },
      { name: 'a.txt', kind: 'file', size: 5 },
    ]);
    expect(executor.fsCalls()).toEqual(['/fs/list']);
  });

  it('readText — страница приходит из ответа исполнителя, offset/limit уходят в тело', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/read-text': {
        status: 200,
        body: { page: { lines: ['1: one', '2: two'], totalLines: 2, truncated: false, bytes: 15 } },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const page = await port.fs!.readText('/workspace/a.txt', { offset: 0, limit: 2 });
    expect(page).toEqual({ lines: ['1: one', '2: two'], totalLines: 2, truncated: false, bytes: 15 });
    expect(executor.fsCalls()).toEqual(['/fs/read-text']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt', offset: 0, limit: 2 });
  });

  it('sniff — признак бинаря и MIME приходят из ответа исполнителя', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/sniff': { status: 200, body: { sniff: { binary: true, mime: 'image/png' } } },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const sniff = await port.fs!.sniff('/workspace/shot.png');
    expect(sniff).toEqual({ binary: true, mime: 'image/png' });
    expect(executor.fsCalls()).toEqual(['/fs/sniff']);
  });

  it('readBytes — байты приходят из ответа исполнителя, лимит уходит в тело', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/read-bytes': {
        status: 200,
        body: { bytes: { dataBase64: Buffer.from('hello').toString('base64'), size: 5 } },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const bytes = await port.fs!.readBytes('/workspace/a.txt', 1024);
    expect(bytes.size).toBe(5);
    expect(Buffer.from(bytes.dataBase64, 'base64').toString('utf-8')).toBe('hello');
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt', maxBytes: 1024 });
  });

  it('readBytes — too_large с провода → FsPathError с кодом too_large', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/read-bytes': {
        status: 400,
        body: {
          error: {
            reason: 'too_large',
            code: 'too_large',
            message: 'файл больше лимита: 20 байт (лимит 10 байт)',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.readBytes('/workspace/big.bin', 10).catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('too_large');
    expect((err as FsPathError).message).toContain('10');
  });

  it('исполнитель без features.fs — отказ и на чтении содержимого', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.readText('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.sniff('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.readBytes('/tmp/x', 10)).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });

  it('writeFile — POST уходит на адрес с features.fs, ответ 204 принимается', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.writeFile('/workspace/a.txt', 'hello\n');

    expect(executor.fsCalls()).toEqual(['/fs/write-file']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt', content: 'hello\n' });
  });

  it('mkdir — POST уходит на адрес с features.fs, ответ 204 принимается', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.mkdir('/workspace/sub');

    expect(executor.fsCalls()).toEqual(['/fs/mkdir']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/sub' });
  });

  it('remove — POST уходит на адрес с features.fs, ответ 204 принимается', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.remove('/workspace/a.txt');

    expect(executor.fsCalls()).toEqual(['/fs/remove']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt' });
  });

  it('запись: 404 not_found с провода → FsPathError с кодом not_found', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 404,
      body: {
        error: {
          reason: 'not_found',
          code: 'ENOENT',
          message: 'путь не найден: /workspace/nope.txt',
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
          truncated: false,
          durationMs: 0,
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.remove('/workspace/nope.txt').catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('not_found');
    expect((err as FsPathError).path).toBe('/workspace/nope.txt');
  });

  it('запись: 400 invalid с провода → FsPathError с кодом invalid', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 400,
      body: {
        error: {
          reason: 'invalid_request',
          code: 'EINVAL',
          message: 'непустой каталог удалить нельзя',
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
          truncated: false,
          durationMs: 0,
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.remove('/workspace/full').catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('invalid');
  });

  it('исполнитель без features.fs — тот же отказ на записи', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.writeFile('/tmp/x', 'y')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.mkdir('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.remove('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });

  it('адрес без features.fs исключается и для записи — вызов уходит к адресу с признаком', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [legacy, executor.url], token: TOKEN });

    await port.fs!.writeFile('/workspace/a.txt', 'x');

    expect(executor.fsCalls()).toEqual(['/fs/write-file']);
  });

  it('readRawText — текст приходит из ответа исполнителя, лимит уходит в тело', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/read-raw': {
        status: 200,
        body: { raw: { text: 'alpha\nbeta\n', size: 11 } },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const raw = await port.fs!.readRawText('/workspace/a.txt', 4096);

    expect(raw.text).toBe('alpha\nbeta\n');
    expect(raw.size).toBe(11);
    expect(executor.fsCalls()).toEqual(['/fs/read-raw']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt', maxBytes: 4096 });
  });

  it('readRawText — too_large с провода → FsPathError с кодом too_large', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/read-raw': {
        status: 400,
        body: {
          error: {
            reason: 'too_large',
            code: 'too_large',
            message: 'файл больше лимита: 20 байт (лимит 10 байт)',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.readRawText('/workspace/big.txt', 10).catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('too_large');
  });

  it('rename — POST уходит на адрес с features.fs, ответ 204 принимается', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.rename('/workspace/a.txt', '/workspace/b.txt');

    expect(executor.fsCalls()).toEqual(['/fs/rename']);
    // Источник — `path`, цель — `to` (тот же разбор путей, что у прочих
    // FS-операций).
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.txt', to: '/workspace/b.txt' });
  });

  it('rename: 404 not_found с провода → FsPathError с кодом not_found', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 404,
      body: {
        error: {
          reason: 'not_found',
          code: 'ENOENT',
          message: 'путь не найден: /workspace/nope.txt',
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
          truncated: false,
          durationMs: 0,
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.rename('/workspace/nope.txt', '/workspace/b.txt').catch((e) => e);
    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('not_found');
  });

  it('исполнитель без features.fs — тот же отказ на чтении сырого текста и переносе', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.readRawText('/tmp/x', 10)).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs!.rename('/tmp/x', '/tmp/y')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });

  /**
   * Бинарная передача файла (`/fs/download`, протокол 7, PROP-135 Ф3):
   * байты едут **без** base64, а размер известен **до** чтения тела
   * (заголовки `content-length`/`x-synth-size`).
   */
  it('download — бинарные байты один в один, лимит уходит в тело', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x7f, 0x80]);
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/download': { status: 200, raw: payload },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const bytes = await port.fs!.download('/workspace/blob.bin', 1024);

    expect(bytes.equals(payload)).toBe(true);
    expect(executor.fsCalls()).toEqual(['/fs/download']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/blob.bin', maxBytes: 1024 });
  });

  it('download — размер больше лимита виден по заголовку: тело не читается', async () => {
    // Заголовок объявляет файл больше потолка — клиент отбрасывает его
    // **до** чтения тела (тело тут меньше объявленного — «файл не влез»).
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/download': { status: 200, raw: Buffer.from('hello'), headers: { 'x-synth-size': '999' } },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.download('/workspace/big.bin', 10).catch((e) => e);

    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('too_large');
    expect((err as FsPathError).message).toContain('10');
  });

  it('download — too_large с провода → FsPathError с кодом too_large', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/download': {
        status: 400,
        body: {
          error: {
            reason: 'too_large',
            code: 'too_large',
            message: 'файл больше лимита: 20 байт (лимит 10 байт)',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.download('/workspace/big.bin', 10).catch((e) => e);

    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('too_large');
  });

  it('download — 404 not_found с провода → FsPathError с кодом not_found', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/download': {
        status: 404,
        body: {
          error: {
            reason: 'not_found',
            code: 'ENOENT',
            message: 'путь не найден: /workspace/nope',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.download('/workspace/nope', 10).catch((e) => e);

    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('not_found');
  });

  it('исполнитель без features.fs — тот же отказ на бинарной передаче', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.download('/tmp/x', 10)).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });

  it('upload — байты уходят в тело PUT, путь и режим — в query', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.upload('/workspace/a.bin', Buffer.from('hello'), { ifExists: 'overwrite' });

    const call = executor.fsCalls()[0]!;
    expect(call.startsWith('/fs/upload?')).toBe(true);
    // Путь и режим — URL-encoded в query (путь может содержать `/` и пробелы).
    const params = new URLSearchParams(call.slice('/fs/upload?'.length));
    expect(params.get('path')).toBe('/workspace/a.bin');
    expect(params.get('ifExists')).toBe('overwrite');
    // Тело — сырые байты, без JSON-обёртки.
    expect(executor.fsRawBodies()[0]).toBe('hello');
  });

  it('upload — путь с пробелами и не-ASCII уходит URL-encoded', async () => {
    const executor = await startFsExecutor(fsCapabilities(), { status: 204, body: null });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    await port.fs!.upload('/workspace/мои файлы/a.bin', Buffer.from('x'));

    const call = executor.fsCalls()[0]!;
    const params = new URLSearchParams(call.slice('/fs/upload?'.length));
    expect(params.get('path')).toBe('/workspace/мои файлы/a.bin');
  });

  it('upload — exists с провода → FsPathError с кодом exists', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      status: 409,
      body: {
        error: {
          reason: 'exists',
          code: 'exists',
          message: 'путь уже существует: /workspace/a.bin',
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
          truncated: false,
          durationMs: 0,
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.upload('/workspace/a.bin', Buffer.from('x')).catch((e) => e);

    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('exists');
    expect((err as FsPathError).path).toBe('/workspace/a.bin');
  });

  it('hash — sha256 приходит из ответа исполнителя', async () => {
    const digest = 'a'.repeat(64);
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/hash': { status: 200, body: { sha256: digest } },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const sha256 = await port.fs!.hash('/workspace/a.bin');

    expect(sha256).toBe(digest);
    expect(executor.fsCalls()).toEqual(['/fs/hash']);
    expect(executor.fsBodies()[0]?.body).toEqual({ path: '/workspace/a.bin' });
  });

  it('hash — not_found с провода → FsPathError с кодом not_found', async () => {
    const executor = await startFsExecutor(fsCapabilities(), {
      '/fs/hash': {
        status: 404,
        body: {
          error: {
            reason: 'not_found',
            code: 'ENOENT',
            message: 'путь не найден: /workspace/nope',
            stdout: '',
            stderr: '',
            killed: false,
            signal: null,
            truncated: false,
            durationMs: 0,
          },
        },
      },
    });
    const port = createRemoteExecutionPort({ urls: [executor.url], token: TOKEN });

    const err = await port.fs!.hash('/workspace/nope').catch((e) => e);

    expect(isFsPathError(err)).toBe(true);
    expect((err as FsPathError).code).toBe('not_found');
  });

  it('исполнитель без features.fs — тот же отказ на публикации и хэше', async () => {
    const legacy = await startLegacyExecutor({
      protocol: 6,
      toolchain: {},
      os: process.platform,
      arch: process.arch,
      node: process.version,
      features: { background: true },
    });
    const port = createRemoteExecutionPort({ urls: [legacy], token: TOKEN });

    await expect(port.fs!.upload('/tmp/x', Buffer.from('x'))).rejects.toBeInstanceOf(
      ExecutionFsUnavailableError,
    );
    await expect(port.fs!.hash('/tmp/x')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });
});

/**
 * PROP-136b: отказ внешнего чекера команд на проводе.
 *
 * Причина `policy_denied` — **причина порта core**, а не `spawn_failed`:
 * клиент переносит её как есть (команда не запускалась), а код `EPOLICY`
 * отличает решение политики от прочих протокольных отказов.
 */
describe('клиент удалённого порта: отказ внешнего чекера команд (PROP-136b)', () => {
  it('wire policy_denied → ExecutionError reason policy_denied', async () => {
    const handle = await startExecutorServer({
      token: TOKEN,
      workspaceRoot: workspace,
      host: '127.0.0.1',
      port: 0,
      toolchain: {},
      policyGuard: {
        provider: 'http',
        check: async () => ({ action: 'deny', reason: 'blocked by policy' }),
      },
    });
    handles.push(handle);
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const err = await port
      .execute({ command: { kind: 'shell', command: 'printf hi' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('policy_denied');
    expect((err as ExecutionError).code).toBe('EPOLICY');
    expect((err as ExecutionError).message).toBe('blocked by policy');
  });
});

/**
 * D1: встроенные browser-тулы идут через клиент удалённого порта —
 * `POST /mcp/call` `{server: browserMcpServer, tool, arguments}`.
 *
 * Проверяется провод (адрес, тело, bearer-токен), разбор вложений и то, что
 * ошибки инструмента/транспорта **не бросаются**, а возвращаются `isError`.
 */
describe('клиент удалённого порта: browserCall (D1)', () => {
  type RecordedCall = { url: string; init?: RequestInit };

  /** Транспорт-запись: фиксирует запросы и отдаёт подготовленный ответ. */
  function recordingFetch(
    calls: RecordedCall[],
    respond: (call: RecordedCall) => Response | Promise<Response>,
  ): ExecutorFetch {
    return async (input, init) => {
      const call = { url: input, init };
      calls.push(call);
      return respond(call);
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('POST /mcp/call: сервер `playwright`, инструмент и аргументы + bearer', async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: recordingFetch(calls, () => jsonResponse({ content: 'Navigated', isError: false })),
    });

    const result = await port.browserCall!({
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });

    expect(result).toEqual({ content: 'Navigated', isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://exec-a:5100/mcp/call');
    expect(calls[0]!.init?.method).toBe('POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      server: 'playwright',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
  });

  it('кастомный browserMcpServer уходит в теле вызова', async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      browserMcpServer: 'browser-mcp',
      fetchImpl: recordingFetch(calls, () => jsonResponse({ content: 'ok' })),
    });

    await port.browserCall!({ tool: 'browser_snapshot', arguments: {} });

    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      server: 'browser-mcp',
      tool: 'browser_snapshot',
      arguments: {},
    });
  });

  it('attachments ответа → base64/mime (без `data:`-префикса)', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: recordingFetch([], () =>
        jsonResponse({
          content: '',
          isError: false,
          attachments: [
            { mime: 'image/png', base64: 'aGk=', name: 'shot.png' },
            { mime: 'image/jpeg', base64: '' },
            { base64: 'aGk=' },
          ],
        }),
      ),
    });

    const result = await port.browserCall!({ tool: 'browser_snapshot', arguments: {} });

    // Некорректные записи (пустой base64, нет mime) пропускаются.
    expect(result.attachments).toEqual([{ mime: 'image/png', dataBase64: 'aGk=' }]);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('1 attachment');
  });

  it('404 → isError:true без исключения (повтор не помогает)', async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: recordingFetch(calls, () =>
        jsonResponse({ error: { message: 'unknown tool' } }, 404),
      ),
    });

    const result = await port.browserCall!({ tool: 'browser_nope', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
    expect(result.content).toContain('unknown tool');
    expect(result.attachments).toBeUndefined();
    // Ответ исполнителя — не повод для failover: попытка одна.
    expect(calls).toHaveLength(1);
  });

  it('isError инструмента → isError, вложения не собираются', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: recordingFetch([], () =>
        jsonResponse({
          content: 'Navigation failed',
          isError: true,
          attachments: [{ mime: 'image/png', base64: 'aGk=' }],
        }),
      ),
    });

    const result = await port.browserCall!({ tool: 'browser_navigate', arguments: { url: 'x' } });

    expect(result).toEqual({ content: 'Navigation failed', isError: true });
  });

  it('ошибка соединения по всем адресам → isError (без исключения)', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100', 'http://exec-b:5100'],
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await port.browserCall!({ tool: 'browser_snapshot', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unavailable');
    expect(result.content).toContain('ECONNREFUSED');
  });

  it('нет адресов → isError (браузер недоступен)', async () => {
    const port = createRemoteExecutionPort({ urls: [], token: TOKEN });

    const result = await port.browserCall!({ tool: 'browser_close', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unavailable');
  });
});

/**
 * Таймаут одного browser-вызова: дефолт инстанса, параметр тула `timeout`
 * (с запасом `REMOTE_TIMEOUT_GRACE_MS`) и потолок
 * `MAX_EXECUTION_BROWSER_TIMEOUT_MS`.
 *
 * Задержка таймера читается напрямую (перехват `setTimeout`): ждать 5 минут
 * ради проверки нельзя.
 */
describe('клиент удалённого порта: таймаут browser-вызова', () => {
  /** Перехват задержек таймеров на время вызова. */
  function captureTimerDelays(): { delays: number[]; restore: () => void } {
    const delays: number[] = [];
    type TimerCallback = Parameters<typeof setTimeout>[0];
    const original = globalThis.setTimeout as unknown as (
      handler: TimerCallback,
      timeout?: number,
      ...args: unknown[]
    ) => NodeJS.Timeout;
    globalThis.setTimeout = ((
      handler: TimerCallback,
      timeout?: number,
      ...args: unknown[]
    ): NodeJS.Timeout => {
      delays.push(Number(timeout ?? 0));
      return original(handler, timeout, ...args);
    }) as unknown as typeof globalThis.setTimeout;
    return {
      delays,
      restore: () => {
        globalThis.setTimeout = original as unknown as typeof globalThis.setTimeout;
      },
    };
  }

  /** Задержка таймера browser-вызова, мс (-1 — таймер не ставился). */
  async function browserCallTimerMs(
    port: ExecutionPort,
    req: BrowserCallRequest,
  ): Promise<number> {
    const capture = captureTimerDelays();
    try {
      await port.browserCall!(req);
      return capture.delays[0] ?? -1;
    } finally {
      capture.restore();
    }
  }

  /** Транспорт-заглушка: успешный ответ исполнителя. */
  function okFetch(): ExecutorFetch {
    return async () =>
      new Response(JSON.stringify({ content: 'ok', isError: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  /** Транспорт-заглушка: вызов «зависает» до отмены по сигналу. */
  function hangingFetch(): ExecutorFetch {
    return async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = (): void => reject(new Error('The operation was aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
  }

  it('без timeoutMs — таймер равен BROWSER_MCP_CALL_TIMEOUT_MS', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: okFetch(),
    });

    const delay = await browserCallTimerMs(port, {
      tool: 'browser_navigate',
      arguments: {},
    });

    expect(delay).toBe(BROWSER_MCP_CALL_TIMEOUT_MS);
  });

  it('browserTimeoutMs в опциях клиента — таймер инстанса', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      browserTimeoutMs: 45_000,
      fetchImpl: okFetch(),
    });

    const delay = await browserCallTimerMs(port, {
      tool: 'browser_navigate',
      arguments: {},
    });

    expect(delay).toBe(45_000);
  });

  it('timeoutMs 300 000 — с запасом REMOTE_TIMEOUT_GRACE_MS (305 000)', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: okFetch(),
    });

    const delay = await browserCallTimerMs(port, {
      tool: 'browser_navigate',
      arguments: {},
      timeoutMs: 300_000,
    });

    expect(delay).toBe(300_000 + REMOTE_TIMEOUT_GRACE_MS);
    expect(delay).toBe(305_000);
  });

  it('timeoutMs выше потолка — обрезается до MAX (+ запас)', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      fetchImpl: okFetch(),
    });

    const delay = await browserCallTimerMs(port, {
      tool: 'browser_navigate',
      arguments: {},
      timeoutMs: 10_000_000,
    });

    expect(delay).toBe(MAX_EXECUTION_BROWSER_TIMEOUT_MS + REMOTE_TIMEOUT_GRACE_MS);
    expect(delay).toBe(605_000);
  });

  it('текст ошибки по таймауту содержит фактическое число мс', async () => {
    const port = createRemoteExecutionPort({
      urls: ['http://exec-a:5100'],
      token: TOKEN,
      browserTimeoutMs: 60,
      fetchImpl: hangingFetch(),
    });

    const result = await port.browserCall!({
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 60 ms');
  });
});
