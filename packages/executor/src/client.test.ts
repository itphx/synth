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
import { createRemoteExecutionPort, type ExecutorFetch } from './client.js';
import { startExecutorServer, type ExecutorHandle } from './server.js';

const TOKEN = 'executor-client-token-test-1234567890';

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
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nremote-secret\n-----END OPENSSH PRIVATE KEY-----\n',
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

  it('фоновый запуск с секретами — fail-closed ESECRETS', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });

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
});
