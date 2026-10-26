import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createExecutorApp, type ExecutorAppOptions } from './server.js';
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
      features?: { background?: boolean; secrets?: boolean };
    };
    expect(body.protocol).toBe(4);
    expect(body.toolchain.git).toBe('git version 2.39.2');
    expect(body.os.length).toBeGreaterThan(0);
    expect(body.arch.length).toBeGreaterThan(0);
    expect(body.node.length).toBeGreaterThan(0);
    expect(body.features?.background).toBe(true);
    expect(body.features?.secrets).toBe(true);
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
    expect(body.protocol).toBe(4);
  });
});
