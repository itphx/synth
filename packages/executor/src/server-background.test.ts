import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { BackgroundExecService } from './background.js';
import { createExecutorApp, type ExecutorAppOptions } from './server.js';
import type {
  BackgroundLogsResponse,
  BackgroundStatusResponse,
  ExecErrorBody,
  SpawnExecResponse,
  StopBackgroundResponse,
} from './protocol.js';

const TOKEN = 'executor-token-bg-test-1234567890';

let workspace: string;
let outside: string;
let logDir: string;
let service: BackgroundExecService | undefined;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bghttp-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bghttp-out-')));
  logDir = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bghttp-logs-')));
});

afterEach(async () => {
  await service?.dispose();
  service = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

/** Приложение исполнителя с отдельным сервисом фоновых процессов. */
function makeApp(opts: Partial<ExecutorAppOptions> = {}): Hono {
  service = new BackgroundExecService({
    workspaceRoot: workspace,
    logDir,
    ...(opts.maxBackgroundProcesses !== undefined
      ? { maxProcesses: opts.maxBackgroundProcesses }
      : {}),
    ...(opts.backgroundLogMaxBytes !== undefined ? { maxLogBytes: opts.backgroundLogMaxBytes } : {}),
  });
  return createExecutorApp({
    token: TOKEN,
    workspaceRoot: workspace,
    toolchain: { git: 'git version 2.39.2' },
    backgroundService: service,
    ...opts,
  }) as unknown as Hono;
}

/** Заголовки с токеном (или без него — если токен не передан). */
function authHeaders(token: string | null = TOKEN): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** POST /exec/spawn с токеном. */
function postSpawn(app: Hono, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return Promise.resolve(
    app.request('/exec/spawn', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
  );
}

async function readError(res: Response): Promise<ExecErrorBody> {
  const body = (await res.json()) as { error: ExecErrorBody };
  return body.error;
}

/** Дождаться терминального статуса фонового процесса (через HTTP). */
async function waitStatus(app: Hono, id: string): Promise<BackgroundStatusResponse> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await app.request(`/exec/${id}`, { headers: authHeaders() });
    const body = (await res.json()) as BackgroundStatusResponse;
    if (body.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`фоновый процесс ${id} не завершился`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref?.();
    });
  }
}

describe('исполнитель: фоновые процессы — запуск и статус', () => {
  it('spawn — 201, id формата proc_ и pid', async () => {
    const app = makeApp();
    const res = await postSpawn(app, {
      command: { kind: 'shell', command: 'printf out; printf err 1>&2' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SpawnExecResponse;
    expect(body.processId.startsWith('proc_')).toBe(true);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('статус — running, затем exited с кодом и временем', async () => {
    const app = makeApp();
    const spawn = (await postSpawn(app, {
      command: { kind: 'shell', command: 'sleep 0.3; printf done' },
    })).json() as Promise<SpawnExecResponse>;
    const { processId } = await spawn;
    const running = (await (
      await app.request(`/exec/${processId}`, { headers: authHeaders() })
    ).json()) as BackgroundStatusResponse;
    expect(running.status).toBe('running');
    expect(running.exitCode).toBeNull();

    const finished = await waitStatus(app, processId);
    expect(finished.status).toBe('exited');
    expect(finished.exitCode).toBe(0);
    expect(finished.signal).toBeNull();
    expect(finished.startedAt).toBeGreaterThan(0);
    expect(finished.finishedAt).toBeGreaterThanOrEqual(finished.startedAt);
    expect(finished.command).toEqual({ kind: 'shell', command: 'sleep 0.3; printf done' });
  });

  it('ненулевой код выхода — статус failed', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'exit 4' } })
    ).json()) as SpawnExecResponse;
    const finished = await waitStatus(app, processId);
    expect(finished.status).toBe('failed');
    expect(finished.exitCode).toBe(4);
  });

  it('spawn — timeoutMs 0 (без таймаута) — 201, процесс живёт и завершается', async () => {
    const app = makeApp();
    const res = await postSpawn(app, {
      command: { kind: 'shell', command: 'sleep 0.3; printf done' },
      // Фоновый процесс по умолчанию **без таймаута** — порт передаёт `0`.
      timeoutMs: 0,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SpawnExecResponse;
    expect(body.processId.startsWith('proc_')).toBe(true);
    expect(body.pid).toBeGreaterThan(0);

    const finished = await waitStatus(app, body.processId);
    expect(finished.status).toBe('exited');
    expect(finished.exitCode).toBe(0);
  });

  it('spawn — отрицательный timeoutMs — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postSpawn(app, {
      command: { kind: 'shell', command: 'printf x' },
      timeoutMs: -1,
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('невалидное тело — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postSpawn(app, { command: { kind: 'shell' } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('невалидный JSON — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await app.request('/exec/spawn', {
      method: 'POST',
      headers: authHeaders(),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();
    const res = await postSpawn(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: outside,
    });
    expect(res.status).toBe(400);
    const error = await readError(res);
    expect(error.reason).toBe('cwd_outside_workspace');
    expect(error.code).toBe('EWORKSPACE');
  });

  it('превышение лимита живых процессов — 429', async () => {
    const app = makeApp({ maxBackgroundProcesses: 1 });
    const first = await postSpawn(app, { command: { kind: 'shell', command: 'sleep 5' } });
    expect(first.status).toBe(201);
    const second = await postSpawn(app, { command: { kind: 'shell', command: 'sleep 5' } });
    expect(second.status).toBe(429);
    const error = await readError(second);
    expect(error.reason).toBe('too_many_requests');
    expect(error.code).toBe('ELIMIT');
  });
});

describe('исполнитель: фоновые процессы — журнал', () => {
  it('логи — stdout и stderr раздельно', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, {
        command: { kind: 'shell', command: 'printf out; printf err 1>&2' },
      })
    ).json()) as SpawnExecResponse;
    await waitStatus(app, processId);

    const res = await app.request(`/exec/${processId}/logs`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BackgroundLogsResponse;
    expect(body.processId).toBe(processId);
    expect(body.stdout.content).toBe('out');
    expect(body.stderr.content).toBe('err');
    expect(body.totalBytes).toBe(6);
    expect(body.truncated).toBe(false);
    expect(body.status).toBe('exited');
  });

  it('логи — смещение и лимит отрезка', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'printf abcdefghij' } })
    ).json()) as SpawnExecResponse;
    await waitStatus(app, processId);

    const head = (await (
      await app.request(`/exec/${processId}/logs?limit=4`, { headers: authHeaders() })
    ).json()) as BackgroundLogsResponse;
    expect(head.stdout.content).toBe('abcd');
    expect(head.stdout.offset).toBe(0);
    expect(head.stdout.nextOffset).toBe(4);

    const tail = (await (
      await app.request(`/exec/${processId}/logs?stdoutOffset=4`, { headers: authHeaders() })
    ).json()) as BackgroundLogsResponse;
    expect(tail.stdout.content).toBe('efghij');
    expect(tail.stdout.offset).toBe(4);
    expect(tail.stdout.nextOffset).toBe(10);
  });

  it('логи — невалидное смещение — 400', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'printf x' } })
    ).json()) as SpawnExecResponse;
    const res = await app.request(`/exec/${processId}/logs?stdoutOffset=abc`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('логи — превышение лимита журнала даёт truncated', async () => {
    const app = makeApp({ backgroundLogMaxBytes: 8 });
    const { processId } = (await (
      await postSpawn(app, {
        command: { kind: 'shell', command: 'printf abcdefghijklmnopqrstuvwxyz' },
      })
    ).json()) as SpawnExecResponse;
    await waitStatus(app, processId);
    const body = (await (
      await app.request(`/exec/${processId}/logs`, { headers: authHeaders() })
    ).json()) as BackgroundLogsResponse;
    expect(body.truncated).toBe(true);
    expect(body.stdout.content.length).toBeLessThanOrEqual(8);
  });
});

describe('исполнитель: фоновые процессы — остановка', () => {
  it('stop — 200 stopping, процесс killed', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'sleep 30' } })
    ).json()) as SpawnExecResponse;

    const res = await app.request(`/exec/${processId}/stop`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StopBackgroundResponse).status).toBe('stopping');

    const finished = await waitStatus(app, processId);
    expect(finished.status).toBe('killed');
    expect(finished.signal).toBe('SIGTERM');
  });

  it('stop — повторный вызов идемпотентен', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'sleep 30' } })
    ).json()) as SpawnExecResponse;
    for (const attempt of [1, 2]) {
      expect(attempt).toBeGreaterThan(0);
      const res = await app.request(`/exec/${processId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    }
    const finished = await waitStatus(app, processId);
    expect(finished.status).toBe('killed');
  });

  it('stop — сигнал SIGKILL из тела учитывается', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'sleep 30' } })
    ).json()) as SpawnExecResponse;

    const res = await app.request(`/exec/${processId}/stop`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ signal: 'SIGKILL' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StopBackgroundResponse).status).toBe('stopping');

    const finished = await waitStatus(app, processId);
    expect(finished.status).toBe('killed');
    expect(finished.signal).toBe('SIGKILL');
  });

  it('stop — невалидный сигнал — 400 invalid_request (процесс не тронут)', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'sleep 30' } })
    ).json()) as SpawnExecResponse;

    const res = await app.request(`/exec/${processId}/stop`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ signal: 'SIGINT' }),
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');

    // Процесс жив — отказ не остановил его.
    const status = await app.request(`/exec/${processId}`, { headers: authHeaders() });
    expect(((await status.json()) as BackgroundStatusResponse).status).toBe('running');
  });

  it('stop — невалидный JSON — 400 invalid_request', async () => {
    const app = makeApp();
    const { processId } = (await (
      await postSpawn(app, { command: { kind: 'shell', command: 'sleep 30' } })
    ).json()) as SpawnExecResponse;

    const res = await app.request(`/exec/${processId}/stop`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });
});

describe('исполнитель: фоновые процессы — несуществующие и аутентификация', () => {
  it('неизвестный процесс — 404 на status/logs/stop', async () => {
    const app = makeApp();
    const status = await app.request('/exec/proc_missing', { headers: authHeaders() });
    expect(status.status).toBe(404);
    expect((await readError(status)).reason).toBe('not_found');

    const logs = await app.request('/exec/proc_missing/logs', { headers: authHeaders() });
    expect(logs.status).toBe(404);

    const stop = await app.request('/exec/proc_missing/stop', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(stop.status).toBe(404);
  });

  it('без токена — 401 на всех фоновых маршрутах', async () => {
    const app = makeApp();
    const spawn = await postSpawn(
      app,
      { command: { kind: 'shell', command: 'printf x' } },
      null,
    );
    expect(spawn.status).toBe(401);
    expect((await readError(spawn)).reason).toBe('unauthorized');

    const status = await app.request('/exec/proc_x');
    expect(status.status).toBe(401);

    const logs = await app.request('/exec/proc_x/logs');
    expect(logs.status).toBe(401);

    const stop = await app.request('/exec/proc_x/stop', { method: 'POST' });
    expect(stop.status).toBe(401);
  });

  it('с неверным токеном — 401', async () => {
    const app = makeApp();
    const res = await postSpawn(
      app,
      { command: { kind: 'shell', command: 'printf x' } },
      'wrong-token',
    );
    expect(res.status).toBe(401);
  });
});

describe('исполнитель: протокол и прежние маршруты', () => {
  it('capabilities — протокол 3 и признак фоновых процессов', async () => {
    const app = makeApp();
    const res = await app.request('/capabilities', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocol: number;
      features?: { background?: boolean };
    };
    expect(body.protocol).toBe(3);
    expect(body.features?.background).toBe(true);
  });

  it('health — счётчики фоновых процессов', async () => {
    const app = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocol: number;
      background?: { limit: number; active: number };
    };
    expect(body.protocol).toBe(3);
    expect(body.background?.limit).toBeGreaterThan(0);
    expect(body.background?.active).toBe(0);
  });

  it('прежний POST /exec — работает как раньше', async () => {
    const app = makeApp();
    const res = await app.request('/exec', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ command: { kind: 'shell', command: 'printf ok' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string; exitCode: number };
    expect(body.stdout).toBe('ok');
    expect(body.exitCode).toBe(0);
  });
});
