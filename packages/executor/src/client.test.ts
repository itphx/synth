import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egressFetch, ExecutionError } from '@itphx/synth-core';
import type {
  ExecBackgroundProcess,
  ExecutionMetricsSink,
  ExecutionPort,
} from '@itphx/synth-core';
import {
  ExecutionFsUnavailableError,
  FsPathError,
  isFsPathError,
} from '@itphx/synth-core';
import { createRemoteExecutionPort, RemoteExecutionPort, type ExecutorFetch } from './client.js';
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
 * Исполнитель с FS-операциями (`features.fs`, протокол 7, PROP-135).
 *
 * Отвечает на `/capabilities` и на FS-роуты; ответ FS-роута задаётся
 * параметром: либо один общий ответ, либо карта «роут → ответ» (для
 * разных операций — разные тела).
 */
async function startFsExecutor(
  capabilities: Record<string, unknown>,
  fsResponse?:
    | { status: number; body: unknown }
    | Record<string, { status: number; body: unknown }>,
): Promise<{
  url: string;
  fsCalls: () => string[];
  fsBodies: () => Array<{ url: string; body: unknown }>;
}> {
  const calls: string[] = [];
  const bodies: Array<{ url: string; body: unknown }> = [];
  type FsAnswer = { status: number; body: unknown };
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
        const answer: FsAnswer =
          byRoute?.[req.url as string]
          ?? single
          ?? { status: 200, body: { stat: { kind: 'file', size: 42, mtimeMs: 1 } } };
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
  return { url: `http://127.0.0.1:${port}`, fsCalls: () => calls, fsBodies: () => bodies };
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
    expect((err as ExecutionFsUnavailableError).message).toContain('features.fs');
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
});
