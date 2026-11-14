import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { PtyProvider, PtySession } from '@itphx/synth-core';
import { createExecutorApp, type ExecutorAppOptions } from './server.js';
import { PtyService } from './pty-service.js';
import type { ExecErrorBody, ExecSuccessBody } from './protocol.js';

const TOKEN = 'executor-token-test-1234567890';

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-out-')));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function makeApp(opts: Partial<ExecutorAppOptions> = {}): Hono {
  return createExecutorApp({
    token: TOKEN,
    workspaceRoot: workspace,
    toolchain: { git: 'git version 2.39.2' },
    ...opts,
  }) as unknown as Hono;
}

/** POST /exec с токеном (или без него — если токен не передан). */
function postExec(
  app: Hono,
  body: unknown,
  token: string | null = TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request('/exec', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function readError(res: Response): Promise<ExecErrorBody> {
  const body = (await res.json()) as { error: ExecErrorBody };
  return body.error;
}

/**
 * Поддельный провайдер PTY: эхо ввода, без нативного модуля.
 *
 * `pid` не задан намеренно: закрытие в core шлёт сигнал **группе** процессов
 * (`kill(-pid)`) — в тестах это не должно задевать реальные процессы.
 */
function createFakePtyProvider(): PtyProvider {
  return {
    spawn: () => {
      const dataListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<(e: { exitCode?: number; signal?: string }) => void>();
      let exited = false;
      const session: PtySession = {
        write: (data: string) => {
          for (const cb of dataListeners) cb(data);
        },
        resize: () => {},
        onData: (cb) => {
          dataListeners.add(cb);
          return () => {
            dataListeners.delete(cb);
          };
        },
        onExit: (cb) => {
          exitListeners.add(cb);
          return () => {
            exitListeners.delete(cb);
          };
        },
        kill: () => {
          if (exited) return;
          exited = true;
          for (const cb of exitListeners) cb({ exitCode: 0 });
        },
      };
      return session;
    },
  };
}

/** PTY-сервис с поддельным провайдером (нативный модуль не нужен). */
function makePtyService(opts: { maxSessions?: number } = {}): PtyService {
  return new PtyService({
    workspaceRoot: workspace,
    maxSessions: opts.maxSessions ?? 4,
    idleTimeoutMs: 60_000,
    inputMaxBytes: 16 * 1024,
    providerFactory: async () => createFakePtyProvider(),
  });
}

/** Первый NDJSON-кадр потока вывода терминала. */
async function readFirstFrame(res: Response, timeoutMs = 5_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('у ответа нет тела');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('кадр вывода не получен')), timeoutMs);
      timer.unref?.();
    });
    const { value, done } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf('\n');
    if (newline >= 0) return buffer.slice(0, newline);
  }
  throw new Error('поток вывода закрылся без кадра');
}

describe('исполнитель: аутентификация', () => {
  it('без токена — 401', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell', command: 'printf hi' } }, null);
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
  });

  it('с неверным токеном — 401', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell', command: 'printf hi' } }, 'wrong-token');
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
  });

  it('с корректным токеном — 200', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell', command: 'printf hi' } });
    expect(res.status).toBe(200);
  });

  it('токен не пишется в тело ответа', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell', command: 'printf hi' } }, 'wrong-token');
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe('исполнитель: выполнение команды', () => {
  it('успех — stdout/stderr/exitCode/durationMs', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'printf out; printf err 1>&2' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecSuccessBody;
    expect(body.stdout).toBe('out');
    expect(body.stderr).toBe('err');
    expect(body.exitCode).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('argv — бинарник запускается без shell', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'argv', file: 'sh', args: ['-c', 'printf argv'] },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ExecSuccessBody).stdout).toBe('argv');
  });

  it('ненулевой код выхода — ошибка nonzero_exit с частичным выводом', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'printf o; printf e 1>&2; exit 3' },
    });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('nonzero_exit');
    expect(error.code).toBe(3);
    expect(error.stdout).toBe('o');
    expect(error.stderr).toBe('e');
  });

  it('отсутствующий бинарник — ошибка spawn_failed (ENOENT)', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'argv', file: 'synth-executor-missing-binary' },
    });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('spawn_failed');
    expect(error.code).toBe('ENOENT');
  });

  it('таймаут — ошибка timeout', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'sleep 5' },
      timeoutMs: 300,
    });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('timeout');
    expect(error.killed).toBe(true);
  });

  it('превышение лимита вывода — ошибка max_output с признаком усечения', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'yes abcdefgh | head -c 4096' },
      maxOutputBytes: 256,
    });
    expect(res.status).toBe(500);
    const error = await readError(res);
    expect(error.reason).toBe('max_output');
    expect(error.truncated).toBe(true);
  });

  it('env запроса мержится поверх окружения исполнителя', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'printf "%s|%s" "$SYNTH_EXEC_VAR" "$PATH"' },
      env: { SYNTH_EXEC_VAR: 'value' },
    });
    const body = (await res.json()) as ExecSuccessBody;
    const [value = '', path = ''] = body.stdout.split('|');
    expect(value).toBe('value');
    expect(path.length).toBeGreaterThan(0);
  });

  it('невалидное тело запроса — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell' } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('невалидный JSON — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });
});

describe('исполнитель: containment рабочего каталога', () => {
  it('cwd внутри workspace — команда выполняется в нём', async () => {
    const app = makeApp();
    const dir = join(workspace, 'sub');
    await mkdir(dir, { recursive: true });
    const res = await postExec(app, { command: { kind: 'shell', command: 'pwd' }, cwd: dir });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ExecSuccessBody).stdout.trim()).toBe(await realpath(dir));
  });

  it('cwd без указания — корень workspace', async () => {
    const app = makeApp();
    const res = await postExec(app, { command: { kind: 'shell', command: 'pwd' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ExecSuccessBody).stdout.trim()).toBe(await realpath(workspace));
  });

  it('абсолютный cwd вне workspace — отказ (400)', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: outside,
    });
    expect(res.status).toBe(400);
    const error = await readError(res);
    expect(error.reason).toBe('cwd_outside_workspace');
    expect(error.code).toBe('EWORKSPACE');
  });

  it('cwd с выходом через ".." — отказ (400)', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: '../..',
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('абсолютный cwd с ".." — отказ (400)', async () => {
    const app = makeApp();
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: join(workspace, '..', 'escape'),
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('симлинк наружу — отказ (400)', async () => {
    const app = makeApp();
    await symlink(outside, join(workspace, 'escape'));
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: join(workspace, 'escape'),
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('симлинк внутрь workspace — разрешён', async () => {
    const app = makeApp();
    const dir = join(workspace, 'real');
    await mkdir(dir, { recursive: true });
    await symlink(dir, join(workspace, 'link'));
    const res = await postExec(app, {
      command: { kind: 'shell', command: 'pwd' },
      cwd: join(workspace, 'link'),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ExecSuccessBody).stdout.trim()).toBe(await realpath(dir));
  });
});

describe('исполнитель: лимиты и служебные эндпоинты', () => {
  it('превышение лимита одновременных команд — 429', async () => {
    const app = makeApp({ maxConcurrency: 1 });
    const first = postExec(app, { command: { kind: 'shell', command: 'sleep 1' } });
    // Даём первой команде занять слот.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await postExec(app, { command: { kind: 'shell', command: 'printf second' } });
    expect(second.status).toBe(429);
    const error = await readError(second);
    expect(error.reason).toBe('too_many_requests');
    expect(error.code).toBe('ELIMIT');
    await first;
  });

  it('capabilities — протокол и состав toolchain', async () => {
    const app = makeApp();
    const res = await app.request('/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocol: number;
      toolchain: Record<string, string>;
      os: string;
      arch: string;
      node: string;
      features?: {
        background?: boolean;
        secrets?: boolean;
        mcpAttachments?: boolean;
        sshAgent?: boolean;
        secretsSpawn?: boolean;
      };
      limits?: { timeoutMs: number; maxOutputBytes: number };
    };
    expect(body.protocol).toBe(8);
    expect(body.toolchain.git).toBe('git version 2.39.2');
    expect(body.os.length).toBeGreaterThan(0);
    expect(body.arch.length).toBeGreaterThan(0);
    expect(body.node.length).toBeGreaterThan(0);
    expect(body.features?.background).toBe(true);
    expect(body.features?.secrets).toBe(true);
    expect(body.features?.mcpAttachments).toBe(true);
    // Протокол 6 (PROP-124 §2): агентный режим секрета вызова.
    expect(body.features?.sshAgent).toBe(true);
    // Протокол 6 (PROP-124 §7): секреты вызова в фоновом запуске.
    expect(body.features?.secretsSpawn).toBe(true);
  });

  it('capabilities — эффективные лимиты исполнителя (потолок таймаута и вывода)', async () => {
    // Дефолт исполнителя: потолок таймаута 600 c (10 мин), буфер вывода 10 МиБ.
    const app = makeApp();
    const res = await app.request('/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocol: number;
      features?: {
        background?: boolean;
        secrets?: boolean;
        mcpAttachments?: boolean;
        sshAgent?: boolean;
        secretsSpawn?: boolean;
      };
      limits?: { timeoutMs: number; maxOutputBytes: number };
    };
    expect(body.limits?.timeoutMs).toBe(600_000);
    expect(body.limits?.maxOutputBytes).toBe(10 * 1024 * 1024);
    // Поле аддитивное: версия протокола и признаки не меняются.
    expect(body.protocol).toBe(8);
    expect(body.features?.background).toBe(true);
    expect(body.features?.secrets).toBe(true);
    expect(body.features?.mcpAttachments).toBe(true);
    // Протокол 6 (PROP-124 §2): агентный режим секрета вызова.
    expect(body.features?.sshAgent).toBe(true);
    // Протокол 6 (PROP-124 §7): секреты вызова в фоновом запуске.
    expect(body.features?.secretsSpawn).toBe(true);
  });

  it('capabilities — лимиты соответствуют заданным оператором', async () => {
    const app = makeApp({ maxTimeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 });
    const res = await app.request('/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limits?: { timeoutMs: number; maxOutputBytes: number };
    };
    expect(body.limits?.timeoutMs).toBe(1_800_000);
    expect(body.limits?.maxOutputBytes).toBe(32 * 1024 * 1024);
  });

  it('capabilities без токена — 401', async () => {
    const app = makeApp();
    const res = await app.request('/capabilities');
    expect(res.status).toBe(401);
  });

  it('health — без токена, status ok', async () => {
    const app = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; protocol: number };
    expect(body.status).toBe('ok');
    expect(body.protocol).toBe(8);
  });
});

describe('исполнитель: PTY-сессии (протокол 8)', () => {
  /** POST /pty/open с токеном. */
  function postPty(
    app: Hono,
    path: string,
    body: unknown,
    token: string | null = TOKEN,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  it('открытие, ввод и поток вывода: кадр с данными', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });
    const dir = join(workspace, 'term');
    await mkdir(dir, { recursive: true });

    const opened = await postPty(app, '/pty/open', { cwd: dir, cols: 80, rows: 24 });
    expect(opened.status).toBe(201);
    const session = (await opened.json()) as { id: string; cols: number; rows: number };
    expect(session.id.startsWith('pty_')).toBe(true);
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);

    const input = await postPty(app, `/pty/${session.id}/input`, { data: 'hello' });
    expect(input.status).toBe(200);
    expect((await input.json()) as { bytes: number }).toMatchObject({ bytes: 5 });

    const stream = await app.request(`/pty/${session.id}/stream?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.status).toBe(200);
    const frame = JSON.parse(await readFirstFrame(stream)) as { seq: number; data: string };
    expect(frame.seq).toBeGreaterThanOrEqual(1);
    expect(frame.data).toContain('hello');

    // Состояние сессии и её закрытие.
    const status = await app.request(`/pty/${session.id}/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.status).toBe(200);
    expect((await status.json()) as { exited: boolean }).toMatchObject({ exited: false });

    const closed = await postPty(app, `/pty/${session.id}/close`, {});
    expect(closed.status).toBe(200);
    await pty.dispose();
  });

  it('повторное открытие с тем же id — идемпотентно (200, тот же id)', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });

    const first = await postPty(app, '/pty/open', { id: 'pty_fixed', cwd: workspace, cols: 80, rows: 24 });
    expect(first.status).toBe(201);
    const second = await postPty(app, '/pty/open', { id: 'pty_fixed', cwd: workspace, cols: 80, rows: 24 });
    expect(second.status).toBe(200);
    expect((await second.json()) as { id: string }).toMatchObject({ id: 'pty_fixed' });
    await pty.dispose();
  });

  it('контур выключен — 501 pty_unsupported', async () => {
    const app = makeApp({ ptyEnabled: false });
    const res = await postPty(app, '/pty/open', { cwd: workspace, cols: 80, rows: 24 });
    expect(res.status).toBe(501);
    const error = await readError(res);
    expect(error.reason).toBe('pty_unsupported');
    expect(error.code).toBe('EPTY');
  });

  it('размеры терминала вне диапазона — 400 invalid_request', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });
    const tooSmall = await postPty(app, '/pty/open', { cwd: workspace, cols: 0, rows: 24 });
    expect(tooSmall.status).toBe(400);
    expect((await readError(tooSmall)).reason).toBe('invalid_request');
    const tooBig = await postPty(app, '/pty/open', { cwd: workspace, cols: 80, rows: 5000 });
    expect(tooBig.status).toBe(400);
    expect((await readError(tooBig)).reason).toBe('invalid_request');
    await pty.dispose();
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });
    const res = await postPty(app, '/pty/open', { cwd: outside, cols: 80, rows: 24 });
    expect(res.status).toBe(400);
    const error = await readError(res);
    expect(error.reason).toBe('cwd_outside_workspace');
    expect(error.code).toBe('EWORKSPACE');
    await pty.dispose();
  });

  it('превышение лимита живых сессий — 429 pty_limit', async () => {
    const pty = makePtyService({ maxSessions: 1 });
    const app = makeApp({ ptyService: pty });
    const first = await postPty(app, '/pty/open', { cwd: workspace, cols: 80, rows: 24 });
    expect(first.status).toBe(201);
    const second = await postPty(app, '/pty/open', { cwd: workspace, cols: 80, rows: 24 });
    expect(second.status).toBe(429);
    const error = await readError(second);
    expect(error.reason).toBe('pty_limit');
    expect(error.code).toBe('ELIMIT');
    await pty.dispose();
  });

  it('несуществующая сессия — 404 pty_not_found', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });
    const res = await app.request('/pty/pty_missing/status', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('pty_not_found');
    await pty.dispose();
  });

  it('ввод без токена — 401', async () => {
    const pty = makePtyService();
    const app = makeApp({ ptyService: pty });
    const res = await postPty(app, '/pty/pty_any/input', { data: 'x' }, null);
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
    await pty.dispose();
  });

  it('capabilities — признак features.pty', async () => {
    const app = makeApp();
    const res = await app.request('/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol: number; features?: { pty?: boolean } };
    expect(body.protocol).toBe(8);
    expect(body.features?.pty).toBe(true);
  });
});
