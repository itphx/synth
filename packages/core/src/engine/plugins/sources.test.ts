/**
 * PROP-090 §«Источники установки» (долги Д1): тесты резолвинга источников.
 *
 * Сеть **не используется**: `npm`/`url` проверяются инъекцией фейкового
 * `fetch` (метаданные и тарбол — в памяти, tar собирается тем же тестовым
 * сборщиком). Так проверяются именно правила — обязательный SRI, сверка
 * sha256/shasum, редиректы (в т.ч. уход на `http:`), лимит размера — без
 * зависимости от доступности registry.npmjs.org в CI.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTarGz } from '../../test-helpers/tar-fixture.js';
import { resolvePluginSource, PluginSourceError } from './sources.js';

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Создать временный каталог (учитывается в уборке). */
async function makeTempDir(prefix = 'synth-plugin-sources-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** JSON-ответ реестра. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ с байтами. */
function bytesResponse(body: Buffer, status = 200): Response {
  return new Response(new Uint8Array(body), { status });
}

/** Редирект на адрес. */
function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** Ожидаемый отказ источника с классом причины. */
async function expectSourceError(
  promise: Promise<unknown>,
  fragment: string,
  code?: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PluginSourceError);
  await expect(promise).rejects.toThrow(fragment);
  if (code) {
    const err = await promise.catch((e: unknown) => e);
    expect((err as PluginSourceError).code).toBe(code);
  }
}

/** Каталог бандла (`synth.pack` + `dist/index.js`) с манифестом. */
async function makeBundleDir(): Promise<string> {
  const dir = await makeTempDir();
  await writeFile(join(dir, 'synth.pack'), '{"name":"demo","version":"1.0.0","kind":"plugin"}\n');
  await writeFile(join(dir, 'index.js'), 'export function apply() {}\n');
  return dir;
}

/** npm-тарбол: файлы упакованы в `package/`. */
function npmTarball(name = 'demo-plugin', version = '1.2.3'): Buffer {
  return buildTarGz([
    { name: 'package/', type: '5' },
    {
      name: 'package/synth.pack',
      content: `${JSON.stringify({ name, version, kind: 'plugin' })}\n`,
    },
    { name: 'package/dist/index.js', content: 'export function apply() {}\n' },
  ]);
}

describe('resolvePluginSource — dir', () => {
  it('каталог с манифестом → source=local, identifier — абсолютный путь, cleanup — no-op', async () => {
    const dir = await makeBundleDir();

    const resolved = await resolvePluginSource({ kind: 'dir', ref: dir });

    expect(resolved.dir).toBe(dir);
    expect(resolved.source).toBe('local');
    expect(resolved.identifier).toBe(dir);
    expect(resolved.ref).toBeUndefined();

    await resolved.cleanup();
    // cleanup для dir ничего не удаляет: это каталог пользователя.
    expect(existsSync(join(dir, 'synth.pack'))).toBe(true);
  });

  it('нет synth.pack → отказ invalid_request', async () => {
    const dir = await makeTempDir();

    await expectSourceError(
      resolvePluginSource({ kind: 'dir', ref: dir }),
      'нет манифеста',
      'invalid_request',
    );
  });

  it('несуществующий путь → отказ invalid_request', async () => {
    await expectSourceError(
      resolvePluginSource({ kind: 'dir', ref: join(await makeTempDir(), 'nope') }),
      'не найден',
      'invalid_request',
    );
  });
});

describe('resolvePluginSource — archive', () => {
  it('реальный .tgz → распакован, ref — sha256 архива, cleanup удаляет каталог', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'demo.tgz');
    const bytes = buildTarGz([
      { name: 'synth.pack', content: '{"name":"demo","version":"1.0.0","kind":"plugin"}\n' },
      { name: 'dist/index.js', content: 'export default 1;\n' },
    ]);
    await writeFile(file, bytes);

    const resolved = await resolvePluginSource({ kind: 'archive', ref: file });
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    expect(resolved.source).toBe('local');
    expect(resolved.identifier).toBe(file);
    // «Неверный» переданный hash не участвует: ref считается по факту.
    expect(resolved.ref).toBe(`sha256:${expectedHash}`);
    expect(await readFile(join(resolved.dir, 'dist/index.js'), 'utf-8')).toBe('export default 1;\n');

    const extractedDir = resolved.dir;
    expect(existsSync(extractedDir)).toBe(true);
    await resolved.cleanup();
    expect(existsSync(extractedDir)).toBe(false);
  });

  it('превышение maxDownloadBytes → отказ', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'big.tgz');
    await writeFile(file, buildTarGz([{ name: 'a.txt', content: 'x'.repeat(2048) }]));

    await expectSourceError(
      resolvePluginSource({ kind: 'archive', ref: file }, { maxDownloadBytes: 64 }),
      'больше допустимого',
      'invalid_request',
    );
  });

  it('симлинк в архиве → отказ archive (распаковка не состоялась)', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'evil.tgz');
    await writeFile(
      file,
      buildTarGz([
        { name: 'synth.pack', content: '{}' },
        { name: 'link', type: '2', linkname: '/etc/passwd' },
      ]),
    );

    await expectSourceError(
      resolvePluginSource({ kind: 'archive', ref: file }),
      'символьную ссылку',
      'archive',
    );
  });
});

describe('resolvePluginSource — npm (инъекция fetch, без сети)', () => {
  /** Фейковый реестр: метаданные + тарбол; собирает список запрошенных URL. */
  function makeNpmFetch(opts: {
    tarball: Buffer;
    integrity?: string | null;
    shasum?: string | null;
    version?: string;
    metadataStatus?: number;
    tarballUrl?: string;
  }): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
    const calls: string[] = [];
    const tarballUrl = opts.tarballUrl ?? 'https://cdn.example.com/demo-plugin-1.2.3.tgz';
    const version = opts.version ?? '1.2.3';
    const dist: Record<string, unknown> = { tarball: tarballUrl };
    if (opts.integrity !== null) {
      dist['integrity'] =
        opts.integrity ??
        `sha512-${createHash('sha512').update(opts.tarball).digest('base64')}`;
    }
    if (opts.shasum !== null) {
      dist['shasum'] = opts.shasum ?? createHash('sha1').update(opts.tarball).digest('hex');
    }
    const metadata = {
      'dist-tags': { latest: version },
      versions: { [version]: { dist } },
    };

    return {
      calls,
      fetch: async (url: string) => {
        calls.push(url);
        if (url.includes('registry.npmjs.org')) {
          return jsonResponse(metadata, opts.metadataStatus ?? 200);
        }
        if (url === tarballUrl) return bytesResponse(opts.tarball);
        return new Response('not found', { status: 404 });
      },
    };
  }

  it('метаданные + тарбол: integrity/shasum сходятся → source=npm, ref=точная версия', async () => {
    const tarball = npmTarball();
    const fake = makeNpmFetch({ tarball });

    const resolved = await resolvePluginSource(
      { kind: 'npm', ref: 'demo-plugin' },
      { fetch: fake.fetch },
    );

    expect(resolved.source).toBe('npm');
    expect(resolved.identifier).toBe('demo-plugin');
    expect(resolved.ref).toBe('1.2.3');
    // stripPrefix `package` снят: манифест лежит в корне каталога.
    expect(await readFile(join(resolved.dir, 'synth.pack'), 'utf-8')).toContain('demo-plugin');
    expect(existsSync(join(resolved.dir, 'package'))).toBe(false);
    expect(fake.calls[0]).toBe('https://registry.npmjs.org/demo-plugin');

    const extractedDir = resolved.dir;
    await resolved.cleanup();
    expect(existsSync(extractedDir)).toBe(false);
  });

  it('scoped-имя кодируется как @scope%2Fname; точная версия из versions[]', async () => {
    const tarball = npmTarball('@scope/demo', '2.0.0');
    const fake = makeNpmFetch({ tarball, version: '2.0.0' });

    const resolved = await resolvePluginSource(
      { kind: 'npm', ref: '@scope/demo', version: '2.0.0' },
      { fetch: fake.fetch },
    );

    expect(resolved.identifier).toBe('@scope/demo');
    expect(resolved.ref).toBe('2.0.0');
    expect(fake.calls[0]).toBe('https://registry.npmjs.org/@scope%2Fdemo');
    await resolved.cleanup();
  });

  it('несовпадение integrity (SRI) → отказ integrity', async () => {
    const tarball = npmTarball();
    const fake = makeNpmFetch({
      tarball,
      integrity: `sha512-${createHash('sha512').update('другие байты').digest('base64')}`,
    });

    await expectSourceError(
      resolvePluginSource({ kind: 'npm', ref: 'demo-plugin' }, { fetch: fake.fetch }),
      'Несовпадение integrity',
      'integrity',
    );
  });

  it('нет dist.integrity → отказ integrity (fail-closed)', async () => {
    const tarball = npmTarball();
    const fake = makeNpmFetch({ tarball, integrity: null });

    await expectSourceError(
      resolvePluginSource({ kind: 'npm', ref: 'demo-plugin' }, { fetch: fake.fetch }),
      'dist.integrity',
      'integrity',
    );
  });

  it('несовпадение shasum → отказ integrity (дополнительная проверка)', async () => {
    const tarball = npmTarball();
    const fake = makeNpmFetch({ tarball, shasum: 'f'.repeat(40) });

    await expectSourceError(
      resolvePluginSource({ kind: 'npm', ref: 'demo-plugin' }, { fetch: fake.fetch }),
      'Несовпадение shasum',
      'integrity',
    );
  });

  it('URL вместо npm-имени → invalid_request (не URL и не путь)', async () => {
    const fake = makeNpmFetch({ tarball: npmTarball() });

    await expectSourceError(
      resolvePluginSource({ kind: 'npm', ref: 'https://evil.example.com/x' }, { fetch: fake.fetch }),
      'не является npm-именем',
      'invalid_request',
    );
    expect(fake.calls).toEqual([]);
  });

  it('редирект тарбола на http: → отказ (схема проверяется на каждом шаге)', async () => {
    const tarball = npmTarball();
    const base = makeNpmFetch({ tarball });

    await expectSourceError(
      resolvePluginSource(
        { kind: 'npm', ref: 'demo-plugin' },
        {
          fetch: async (url, init) => {
            if (url.endsWith('.tgz')) return redirectResponse('http://cdn.example.com/demo.tgz');
            return base.fetch(url, init);
          },
        },
      ),
      'должен быть https',
      'invalid_request',
    );
  });

  it('редирект на другой https-адрес разрешён (до 3 переходов)', async () => {
    const tarball = npmTarball();
    let redirects = 0;
    const base = makeNpmFetch({ tarball });

    const resolved = await resolvePluginSource(
      { kind: 'npm', ref: 'demo-plugin' },
      {
        fetch: async (url, init) => {
          if (url.includes('registry.npmjs.org')) return base.fetch(url, init);
          if (url.endsWith('.tgz') && redirects === 0) {
            redirects += 1;
            return redirectResponse('https://mirror.example.com/demo.tgz');
          }
          return bytesResponse(tarball);
        },
      },
    );

    expect(redirects).toBe(1);
    expect(await readFile(join(resolved.dir, 'synth.pack'), 'utf-8')).toContain('demo-plugin');
    await resolved.cleanup();
  });

  it('ответ реестра не-2xx → отказ network с кодом статуса', async () => {
    const fake = makeNpmFetch({ tarball: npmTarball(), metadataStatus: 404 });

    await expectSourceError(
      resolvePluginSource({ kind: 'npm', ref: 'demo-plugin' }, { fetch: fake.fetch }),
      'HTTP 404',
      'network',
    );
  });

  it('превышение размера скачиваемого → отказ network', async () => {
    const fake = makeNpmFetch({ tarball: npmTarball() });

    await expectSourceError(
      resolvePluginSource(
        { kind: 'npm', ref: 'demo-plugin' },
        { fetch: fake.fetch, maxDownloadBytes: 32 },
      ),
      'превышает предел',
      'network',
    );
  });
});

describe('resolvePluginSource — url (обязательный pin)', () => {
  const url = 'https://example.com/plugins/demo.tgz';

  it('sha256 сходится → source=url, ref=sha256:<hash>', async () => {
    const bytes = buildTarGz([{ name: 'synth.pack', content: '{"name":"demo"}' }]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const resolved = await resolvePluginSource(
      { kind: 'url', ref: url, sha256 },
      { fetch: async () => bytesResponse(bytes) },
    );

    expect(resolved.source).toBe('url');
    expect(resolved.identifier).toBe(url);
    expect(resolved.ref).toBe(`sha256:${sha256}`);
    expect(existsSync(join(resolved.dir, 'synth.pack'))).toBe(true);
    await resolved.cleanup();
  });

  it('sha256 не передан → invalid_request (произвольный адрес не ставим)', async () => {
    await expectSourceError(
      resolvePluginSource({ kind: 'url', ref: url }, { fetch: async () => bytesResponse(Buffer.alloc(0)) }),
      'обязателен pin sha256',
      'invalid_request',
    );
  });

  it('sha256 не совпал → отказ integrity', async () => {
    const bytes = buildTarGz([{ name: 'synth.pack', content: '{}' }]);

    await expectSourceError(
      resolvePluginSource(
        { kind: 'url', ref: url, sha256: 'a'.repeat(64) },
        { fetch: async () => bytesResponse(bytes) },
      ),
      'Несовпадение sha256',
      'integrity',
    );
  });

  it('http:// → invalid_request (только https)', async () => {
    await expectSourceError(
      resolvePluginSource(
        { kind: 'url', ref: 'http://example.com/demo.tgz', sha256: 'a'.repeat(64) },
        { fetch: async () => bytesResponse(Buffer.alloc(0)) },
      ),
      'должен быть https',
      'invalid_request',
    );
  });
});
