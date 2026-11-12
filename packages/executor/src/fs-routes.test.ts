/**
 * FS-операции исполнителя на проводе (протокол 7, PROP-135 Ф1).
 *
 * Роуты `/fs/stat`, `/fs/realpath`, `/fs/list` — те же bearer-токен и тот же
 * корень workspace, что у команд. Проверяется:
 *
 *   - аутентификация (401 без токена);
 *   - содержимое workspace: файл, каталог, симлинк;
 *   - **семантика `cwd`**: относительный путь резолвится от `cwd`, а сам
 *     `cwd` проходит containment (вне workspace → 400);
 *   - **типизированные ошибки**: `not_found` → 404, `not_directory` → 400,
 *     невалидное тело → 400;
 *   - признак `features.fs` в `/capabilities` (без него control plane файловые
 *     тулы в remote-режиме не запускает — fail-closed).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createExecutorApp, type ExecutorAppOptions } from './server.js';
import {
  EXECUTOR_FS_MAX_UPLOAD_BYTES,
  EXECUTOR_FS_MAX_WRITE_BYTES,
  type ExecErrorBody,
} from './protocol.js';

const TOKEN = 'executor-fs-token-test-1234567890';

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-fs-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-fs-out-')));
  await mkdir(join(workspace, 'sub'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'hello');
  await symlink(join(workspace, 'a.txt'), join(workspace, 'link.txt'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function makeApp(opts: Partial<ExecutorAppOptions> = {}): Hono {
  return createExecutorApp({
    token: TOKEN,
    workspaceRoot: workspace,
    toolchain: {},
    ...opts,
  }) as unknown as Hono;
}

/** POST на FS-роут (с токеном или без него). */
function postFs(
  app: Hono,
  route: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request(route, {
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
 * PUT на FS-роут публикации байтов (`PUT /fs/upload`).
 *
 * Тело — **сырые байты** (`application/octet-stream`), параметры — в query
 * (путь может содержать `/` и не-ASCII ⇒ URL-encoded).
 */
function putFsUpload(
  app: Hono,
  query: { path: string; cwd?: string; ifExists?: string },
  bytes: Buffer,
  token: string | null = TOKEN,
): Promise<Response> {
  const params = new URLSearchParams({ path: query.path });
  if (query.cwd !== undefined) params.set('cwd', query.cwd);
  if (query.ifExists !== undefined) params.set('ifExists', query.ifExists);
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request(`/fs/upload?${params.toString()}`, {
      method: 'PUT',
      headers,
      body: bytes,
    }),
  );
}

describe('FS-операции исполнителя: аутентификация', () => {
  it('без токена — 401 на всех FS-роутах', async () => {
    const app = makeApp();
    for (const route of [
      '/fs/stat',
      '/fs/realpath',
      '/fs/list',
      '/fs/read-text',
      '/fs/sniff',
      '/fs/read-bytes',
      '/fs/write-file',
      '/fs/mkdir',
      '/fs/remove',
      '/fs/read-raw',
      '/fs/rename',
      '/fs/download',
      '/fs/upload',
      '/fs/hash',
    ]) {
      const res = await postFs(app, route, { path: workspace, maxBytes: 1024, content: 'x', to: 'y' }, null);
      expect(res.status).toBe(401);
      expect((await readError(res)).reason).toBe('unauthorized');
    }
  });

  it('с неверным токеном — 401', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/stat', { path: workspace }, 'wrong-token');
    expect(res.status).toBe(401);
  });
});

describe('FS-операции исполнителя: stat', () => {
  it('файл — вид, размер и время изменения', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/stat', { path: join(workspace, 'a.txt') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stat: { kind: string; size: number; mtimeMs: number } };
    expect(body.stat.kind).toBe('file');
    expect(body.stat.size).toBe(5);
    expect(body.stat.mtimeMs).toBeGreaterThan(0);
  });

  it('каталог — вид "directory", размер 0', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/stat', { path: join(workspace, 'sub') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stat: { kind: string; size: number } };
    expect(body.stat.kind).toBe('directory');
    expect(body.stat.size).toBe(0);
  });

  it('отсутствующий путь — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/stat', { path: join(workspace, 'nope') });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('невалидное тело (без path) — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/stat', { cwd: workspace });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });
});

describe('FS-операции исполнителя: realpath', () => {
  it('симлинк — канонический путь цели', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/realpath', { path: join(workspace, 'link.txt') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(join(workspace, 'a.txt'));
  });

  it('битый симлинк — 400 unresolvable', async () => {
    await symlink(join(workspace, 'missing'), join(workspace, 'broken.txt'));
    const app = makeApp();
    const res = await postFs(app, '/fs/realpath', { path: join(workspace, 'broken.txt') });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('unresolvable');
  });

  it('отсутствующий путь — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/realpath', { path: join(workspace, 'nope') });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });
});

describe('FS-операции исполнителя: list', () => {
  it('записи каталога — имена, виды и размеры', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: workspace });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ name: string; kind: string; size: number }>;
    };
    const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('a.txt')).toMatchObject({ kind: 'file', size: 5 });
    expect(byName.get('sub')).toMatchObject({ kind: 'directory' });
    expect(byName.get('link.txt')).toMatchObject({ kind: 'other' });
  });

  it('путь-файл вместо каталога — 400 not_directory', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: join(workspace, 'a.txt') });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('not_directory');
  });

  it('отсутствующий каталог — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: join(workspace, 'nope') });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });
});

describe('FS-операции исполнителя: семантика cwd', () => {
  it('относительный путь резолвится от cwd внутри workspace', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: 'sub', cwd: workspace });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries).toEqual([]);
  });

  it('относительный путь от cwd — файл, а не корень', async () => {
    await writeFile(join(workspace, 'sub', 'inner.txt'), 'x');
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: '.', cwd: join(workspace, 'sub') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((entry) => entry.name)).toEqual(['inner.txt']);
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: '.', cwd: outside });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('cwd с выходом через ".." — 400 cwd_outside_workspace', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/list', { path: '.', cwd: join(workspace, '..', '..') });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });
});

/**
 * Чтение **содержимого** файла (протокол 7, слайс 2 Ф1).
 *
 * Формат вывода — тот же, что у control plane: строки с исходной 1-based
 * нумерацией (`N: текст`), общий код чтения в core (`execution/fs-text.ts`).
 */
describe('FS-операции исполнителя: read-text', () => {
  it('строки файла — с исходной нумерацией, totalLines и размер вывода', async () => {
    await writeFile(join(workspace, 'lines.txt'), 'one\ntwo\nthree\n');
    const app = makeApp();

    const res = await postFs(app, '/fs/read-text', { path: join(workspace, 'lines.txt') });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page: { lines: string[]; totalLines: number; truncated: boolean; bytes: number };
    };
    expect(body.page.lines).toEqual(['1: one', '2: two', '3: three']);
    expect(body.page.totalLines).toBe(3);
    expect(body.page.truncated).toBe(false);
    expect(body.page.bytes).toBeGreaterThan(0);
  });

  it('offset/limit — страница с исходной нумерацией', async () => {
    await writeFile(join(workspace, 'lines2.txt'), 'a\nb\nc\nd\n');
    const app = makeApp();

    const res = await postFs(app, '/fs/read-text', {
      path: join(workspace, 'lines2.txt'),
      offset: 1,
      limit: 2,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: { lines: string[]; totalLines: number; truncated: boolean } };
    expect(body.page.lines).toEqual(['2: b', '3: c']);
    expect(body.page.totalLines).toBe(4);
    expect(body.page.truncated).toBe(true);
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-text', { path: join(workspace, 'nope.txt') });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('невалидный offset — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-text', { path: join(workspace, 'a.txt'), offset: -1 });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('без токена — 401', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-text', { path: join(workspace, 'a.txt') }, null);
    expect(res.status).toBe(401);
  });
});

describe('FS-операции исполнителя: sniff', () => {
  it('текстовый файл — не бинарь', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/sniff', { path: join(workspace, 'a.txt') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sniff: { binary: boolean; mime?: string } };
    expect(body.sniff.binary).toBe(false);
  });

  it('PNG — бинарь и MIME по сигнатуре', async () => {
    await writeFile(
      join(workspace, 'shot.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    );
    const app = makeApp();

    const res = await postFs(app, '/fs/sniff', { path: join(workspace, 'shot.png') });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sniff: { binary: boolean; mime?: string } };
    expect(body.sniff.binary).toBe(true);
    expect(body.sniff.mime).toBe('image/png');
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/sniff', { path: join(workspace, 'nope.png') });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });
});

describe('FS-операции исполнителя: read-bytes', () => {
  it('байты файла — в base64, размер совпадает', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-bytes', { path: join(workspace, 'a.txt'), maxBytes: 1024 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bytes: { dataBase64: string; size: number } };
    expect(body.bytes.size).toBe(5);
    expect(Buffer.from(body.bytes.dataBase64, 'base64').toString('utf-8')).toBe('hello');
  });

  it('файл больше лимита — 400 too_large', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-bytes', { path: join(workspace, 'a.txt'), maxBytes: 2 });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('too_large');
  });

  it('без maxBytes — 400 invalid_request (потолок обязателен)', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-bytes', { path: join(workspace, 'a.txt') });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-bytes', { path: join(workspace, 'nope'), maxBytes: 10 });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('без токена — 401', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/read-bytes', { path: join(workspace, 'a.txt'), maxBytes: 10 }, null);
    expect(res.status).toBe(401);
  });
});

/**
 * Запись/создание каталога/удаление (протокол 7, PROP-135 Ф2).
 *
 * Проверяется: happy path (файл/каталог на диске), относительный `path` +
 * `cwd` внутри workspace, containment `cwd` (вне workspace → 400), создание
 * родительских каталогов, типизированные ошибки (`not_found` → 404,
 * `invalid` → 400, `permission` → 403) и атомарность записи (временных
 * файлов не остаётся).
 */
describe('FS-операции исполнителя: write-file', () => {
  it('файл записан — содержимое на диске', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: join(workspace, 'written.txt'),
      content: 'hello\n',
    });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'written.txt'), 'utf-8')).resolves.toBe('hello\n');
  });

  it('родительские каталоги создаются', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: join(workspace, 'deep', 'nested', 'file.txt'),
      content: 'deep\n',
    });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'deep', 'nested', 'file.txt'), 'utf-8')).resolves.toBe('deep\n');
  });

  it('относительный path резолвится от cwd внутри workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: 'inner.txt',
      cwd: join(workspace, 'sub'),
      content: 'inner\n',
    });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'sub', 'inner.txt'), 'utf-8')).resolves.toBe('inner\n');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: 'evil.txt',
      cwd: outside,
      content: 'x',
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
    await expect(readFile(join(outside, 'evil.txt'), 'utf-8')).rejects.toThrow();
  });

  it('запись атомарна — временных файлов в каталоге не остаётся', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: join(workspace, 'atomic.txt'),
      content: 'data\n',
    });

    expect(res.status).toBe(204);
    const names = await readdir(workspace);
    expect(names.filter((name) => name.includes('.synth-tmp-'))).toEqual([]);
  });

  it('content не строка — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', { path: join(workspace, 'x.txt'), content: 42 });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('content больше потолка тела — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', {
      path: join(workspace, 'huge.txt'),
      content: 'x'.repeat(EXECUTOR_FS_MAX_WRITE_BYTES + 1),
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
    await expect(readFile(join(workspace, 'huge.txt'), 'utf-8')).rejects.toThrow();
  });

  it('нет доступа на запись — 403 permission', async () => {
    const ro = join(workspace, 'ro');
    await mkdir(ro, { recursive: true });
    await chmod(ro, 0o555);
    try {
      const app = makeApp();

      const res = await postFs(app, '/fs/write-file', { path: join(ro, 'nope.txt'), content: 'x' });

      expect(res.status).toBe(403);
      expect((await readError(res)).reason).toBe('permission');
    } finally {
      await chmod(ro, 0o755);
    }
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/write-file', { path: join(workspace, 'x.txt'), content: 'x' }, null);

    expect(res.status).toBe(401);
  });
});

describe('FS-операции исполнителя: mkdir', () => {
  it('каталог создан (с родительскими)', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/mkdir', { path: join(workspace, 'made', 'nested') });

    expect(res.status).toBe(204);
    expect((await stat(join(workspace, 'made', 'nested'))).isDirectory()).toBe(true);
  });

  it('относительный path резолвится от cwd внутри workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/mkdir', { path: 'made', cwd: join(workspace, 'sub') });

    expect(res.status).toBe(204);
    expect((await stat(join(workspace, 'sub', 'made'))).isDirectory()).toBe(true);
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/mkdir', { path: 'made', cwd: outside });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('путь-файл вместо каталога — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/mkdir', { path: join(workspace, 'a.txt') });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/mkdir', { path: join(workspace, 'made') }, null);

    expect(res.status).toBe(401);
  });
});

describe('FS-операции исполнителя: remove', () => {
  it('файл удалён', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: join(workspace, 'a.txt') });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'a.txt'), 'utf-8')).rejects.toThrow();
  });

  it('пустой каталог удалён', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: join(workspace, 'sub') });

    expect(res.status).toBe(204);
    await expect(stat(join(workspace, 'sub'))).rejects.toThrow();
  });

  it('относительный path резолвится от cwd внутри workspace', async () => {
    await writeFile(join(workspace, 'sub', 'inner.txt'), 'x');
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: 'inner.txt', cwd: join(workspace, 'sub') });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'sub', 'inner.txt'), 'utf-8')).rejects.toThrow();
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: 'a.txt', cwd: outside });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('отсутствующий путь — 404 not_found', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: join(workspace, 'nope.txt') });

    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('непустой каталог — 400 invalid_request (рекурсии нет)', async () => {
    const full = join(workspace, 'full');
    await mkdir(full, { recursive: true });
    await writeFile(join(full, 'inner.txt'), 'x');
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: full });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
    // Каталог на месте — содержимое не тронуто.
    await expect(readFile(join(full, 'inner.txt'), 'utf-8')).resolves.toBe('x');
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/remove', { path: join(workspace, 'a.txt') }, null);

    expect(res.status).toBe(401);
  });
});

/**
 * «Сырой» текст файла (протокол 7, PROP-135 Ф2).
 *
 * Нужен тулам правки (`edit_file`/`patch`): содержимое едет **как есть**,
 * без нумерации строк.
 */
describe('FS-операции исполнителя: read-raw', () => {
  it('текст файла — как есть, без нумерации строк', async () => {
    await writeFile(join(workspace, 'multi.txt'), 'первая\nвторая\n', 'utf-8');
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: join(workspace, 'multi.txt'),
      maxBytes: 1024,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: { text: string; size: number } };
    expect(body.raw.text).toBe('первая\nвторая\n');
    // Размер — в байтах (UTF-8).
    expect(body.raw.size).toBe(Buffer.byteLength('первая\nвторая\n', 'utf-8'));
  });

  it('относительный path резолвится от cwd внутри workspace', async () => {
    await writeFile(join(workspace, 'sub', 'rel.txt'), 'rel\n', 'utf-8');
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: 'rel.txt',
      cwd: join(workspace, 'sub'),
      maxBytes: 1024,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: { text: string } };
    expect(body.raw.text).toBe('rel\n');
  });

  it('файл больше лимита — 400 too_large', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: join(workspace, 'a.txt'),
      maxBytes: 2,
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('too_large');
  });

  it('без maxBytes — 400 invalid_request (потолок обязателен)', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', { path: join(workspace, 'a.txt') });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: join(workspace, 'nope.txt'),
      maxBytes: 1024,
    });

    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: 'a.txt',
      cwd: outside,
      maxBytes: 1024,
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/read-raw', {
      path: join(workspace, 'a.txt'),
      maxBytes: 1024,
    }, null);

    expect(res.status).toBe(401);
  });
});

/**
 * Переименование/перемещение файла (протокол 7, PROP-135 Ф2).
 *
 * Источник — `path`, цель — `to`; обе стороны резолвятся от `cwd`.
 */
describe('FS-операции исполнителя: rename', () => {
  it('файл перенесён под новым именем', async () => {
    await writeFile(join(workspace, 'from.txt'), 'payload\n', 'utf-8');
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: join(workspace, 'from.txt'),
      to: join(workspace, 'to.txt'),
    });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'to.txt'), 'utf-8')).resolves.toBe('payload\n');
    await expect(stat(join(workspace, 'from.txt'))).rejects.toThrow();
  });

  it('относительные path и to резолвятся от cwd внутри workspace', async () => {
    await writeFile(join(workspace, 'sub', 'rel.txt'), 'rel\n', 'utf-8');
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: 'rel.txt',
      to: 'rel2.txt',
      cwd: join(workspace, 'sub'),
    });

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'sub', 'rel2.txt'), 'utf-8')).resolves.toBe('rel\n');
  });

  it('источника нет — 404 not_found', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: join(workspace, 'nope.txt'),
      to: join(workspace, 'to.txt'),
    });

    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('цель уже существует — 400 invalid_request (цель не перезаписана)', async () => {
    await writeFile(join(workspace, 'src.txt'), 'one\n', 'utf-8');
    await writeFile(join(workspace, 'dst.txt'), 'two\n', 'utf-8');
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: join(workspace, 'src.txt'),
      to: join(workspace, 'dst.txt'),
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
    await expect(readFile(join(workspace, 'dst.txt'), 'utf-8')).resolves.toBe('two\n');
  });

  it('без to — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', { path: join(workspace, 'a.txt') });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: 'a.txt',
      to: 'b.txt',
      cwd: outside,
    });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/rename', {
      path: join(workspace, 'a.txt'),
      to: join(workspace, 'b.txt'),
    }, null);

    expect(res.status).toBe(401);
  });
});

/**
 * Бинарная передача файла (`POST /fs/download`, протокол 7, PROP-135 Ф3).
 *
 * Ответ — **бинарный** (`application/octet-stream`), не JSON: вложения идут
 * бинарно (base64 раздувал бы 100 МиБ до 133 МиБ). Размер файла известен
 * **до** чтения (`stat`) и едет в `content-length`/`x-synth-size` — вызывающий
 * может отклонить файл, не читая тело.
 */
describe('FS-операции исполнителя: download', () => {
  it('файл — бинарный ответ один в один', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'a.txt'), maxBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString('utf-8')).toBe('hello');
  });

  it('бинарный файл — байты один в один (без искажений)', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x7f, 0x80]);
    await writeFile(join(workspace, 'blob.bin'), payload);
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'blob.bin'), maxBytes: 1024 });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
  });

  it('размер едет в content-length и x-synth-size (известен до чтения тела)', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'a.txt'), maxBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('x-synth-size')).toBe('5');
  });

  it('пустой файл — пустое тело, размер 0', async () => {
    await writeFile(join(workspace, 'empty.bin'), '');
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'empty.bin'), maxBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-synth-size')).toBe('0');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('файл больше лимита — 400 too_large (файл не читается)', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'a.txt'), maxBytes: 2 });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('too_large');
  });

  it('без maxBytes — 400 invalid_request (потолок обязателен)', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'a.txt') });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'nope'), maxBytes: 10 });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('каталог вместо файла — 400 invalid_request', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'sub'), maxBytes: 10 });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('относительный path + cwd — файл из cwd', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: 'a.txt', cwd: workspace, maxBytes: 1024 });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString('utf-8')).toBe('hello');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: 'a.txt', cwd: outside, maxBytes: 1024 });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
  });

  it('без токена — 401', async () => {
    const app = makeApp();
    const res = await postFs(app, '/fs/download', { path: join(workspace, 'a.txt'), maxBytes: 10 }, null);
    expect(res.status).toBe(401);
  });
});

describe('FS-операции исполнителя: признак в /capabilities', () => {
  it('протокол 7 и features.fs — control plane выбирает адрес для файловых тулов', async () => {
    const app = makeApp();
    const res = await app.request('/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol: number; features?: { fs?: boolean } };
    expect(body.protocol).toBe(7);
    expect(body.features?.fs).toBe(true);
  });
});

/**
 * Публикация байтов в файл (`PUT /fs/upload`, протокол 7, PROP-135 Ф3).
 *
 * Тело — **сырые байты** (`application/octet-stream`), параметры — в query.
 * Публикация атомарна и без перезаписи (`ifExists=fail` по умолчанию): занятая
 * цель → `409 exists`.
 */
describe('FS-операции исполнителя: upload', () => {
  it('байты записаны один в один', async () => {
    const app = makeApp();

    const res = await putFsUpload(app, { path: join(workspace, 'uploaded.bin') }, Buffer.from('hello\n'));

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'uploaded.bin'), 'utf-8')).resolves.toBe('hello\n');
  });

  it('бинарный файл — байты один в один (без искажений)', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x7f, 0x80]);
    const app = makeApp();

    const res = await putFsUpload(app, { path: join(workspace, 'blob.bin') }, payload);

    expect(res.status).toBe(204);
    const written = await readFile(join(workspace, 'blob.bin'));
    expect(written.equals(payload)).toBe(true);
  });

  it('родительские каталоги создаются', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'deep', 'nested', 'file.bin') },
      Buffer.from('deep\n'),
    );

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'deep', 'nested', 'file.bin'), 'utf-8')).resolves.toBe('deep\n');
  });

  it('занятая цель при ifExists=fail — 409 exists (файл не перезаписан)', async () => {
    await writeFile(join(workspace, 'occupied.bin'), 'old\n');
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'occupied.bin'), ifExists: 'fail' },
      Buffer.from('new\n'),
    );

    expect(res.status).toBe(409);
    expect((await readError(res)).reason).toBe('exists');
    await expect(readFile(join(workspace, 'occupied.bin'), 'utf-8')).resolves.toBe('old\n');
  });

  it('ifExists=overwrite — файл перезаписан', async () => {
    await writeFile(join(workspace, 'overwritten.bin'), 'old\n');
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'overwritten.bin'), ifExists: 'overwrite' },
      Buffer.from('new\n'),
    );

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'overwritten.bin'), 'utf-8')).resolves.toBe('new\n');
  });

  it('ifExists=overwrite — права существующего файла сохраняются (0640)', async () => {
    const target = join(workspace, 'mode.bin');
    await writeFile(target, 'old');
    await chmod(target, 0o640);
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: target, ifExists: 'overwrite' },
      Buffer.from('new'),
    );

    expect(res.status).toBe(204);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it('неизвестный ifExists — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'x.bin'), ifExists: 'maybe' },
      Buffer.from('x'),
    );

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('без path — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await putFsUpload(app, { path: '' }, Buffer.from('x'));

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('тело больше потолка — 413 payload_too_large', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'huge.bin') },
      Buffer.alloc(EXECUTOR_FS_MAX_UPLOAD_BYTES + 1),
    );

    expect(res.status).toBe(413);
    expect((await readError(res)).reason).toBe('payload_too_large');
    // Файл не создан: тело отвергнуто до записи.
    await expect(stat(join(workspace, 'huge.bin'))).rejects.toThrow();
  });

  it('относительный path резолвится от cwd внутри workspace', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: 'rel.bin', cwd: join(workspace, 'sub') },
      Buffer.from('rel\n'),
    );

    expect(res.status).toBe(204);
    await expect(readFile(join(workspace, 'sub', 'rel.bin'), 'utf-8')).resolves.toBe('rel\n');
  });

  it('cwd вне workspace — 400 cwd_outside_workspace', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: 'evil.bin', cwd: outside },
      Buffer.from('x'),
    );

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('cwd_outside_workspace');
    await expect(readFile(join(outside, 'evil.bin'), 'utf-8')).rejects.toThrow();
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await putFsUpload(
      app,
      { path: join(workspace, 'x.bin') },
      Buffer.from('x'),
      null,
    );

    expect(res.status).toBe(401);
  });
});

/**
 * SHA-256 файла (`POST /fs/hash`, протокол 7, PROP-135 Ф3) — считается **на
 * исполнителе** (там, где лежит файл).
 */
describe('FS-операции исполнителя: hash', () => {
  it('sha256 совпадает с посчитанным по файлу', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/hash', { path: join(workspace, 'a.txt') });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha256: string };
    expect(body.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('бинарный файл — sha256 совпадает с посчитанным', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]);
    await writeFile(join(workspace, 'blob.bin'), payload);
    const app = makeApp();

    const res = await postFs(app, '/fs/hash', { path: join(workspace, 'blob.bin') });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha256: string };
    expect(body.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('отсутствующий файл — 404 not_found', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/hash', { path: join(workspace, 'nope.txt') });

    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });

  it('невалидное тело (без path) — 400 invalid_request', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/hash', { cwd: workspace });

    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('без токена — 401', async () => {
    const app = makeApp();

    const res = await postFs(app, '/fs/hash', { path: join(workspace, 'a.txt') }, null);

    expect(res.status).toBe(401);
  });
});
