import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBlockedHost,
  parseRemoteIndex,
  refreshRemoteCatalogs,
  resolveRemoteIndexUrl,
  resolveSkillFileUrl,
  safeCacheDirName,
  validateRemoteUrl,
  REMOTE_FILE_MAX_BYTES,
  type FetchLike,
} from './remote.js';
import { buildUrlSource, urlCacheDir } from './discovery.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-remote-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const URL_BASE = 'https://example.com/skills';

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: desc-${name}\n---\n\nBody of ${name}\n`;
}

describe('validateRemoteUrl / isBlockedHost — SSRF-guard (ADR-046 §4.2)', () => {
  it('только http/https', () => {
    expect('error' in validateRemoteUrl('ftp://example.com/skills')).toBe(true);
    expect('error' in validateRemoteUrl('file:///etc/passwd')).toBe(true);
    expect('error' in validateRemoteUrl('not a url')).toBe(true);
    expect('error' in validateRemoteUrl('https://example.com/skills')).toBe(false);
    expect('error' in validateRemoteUrl('http://example.com/skills')).toBe(false);
  });

  it.each([
    'localhost',
    'foo.localhost',
    'printer.local',
    'metadata.google.internal',
    '127.0.0.1',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('блокирует приватный/локальный хост %s', (host) => {
    expect(isBlockedHost(host)).toBe(true);
    expect('error' in validateRemoteUrl(`http://${host.includes(':') ? `[${host}]` : host}/skills`)).toBe(true);
  });

  it('пропускает обычные публичные хосты', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
  });
});

describe('parseRemoteIndex — tolerant-parse', () => {
  it('массив записей', () => {
    const res = parseRemoteIndex(JSON.stringify([{ name: 'a' }, { name: 'b', path: 'dir/b' }]));
    expect(res).toEqual({ entries: [{ name: 'a' }, { name: 'b', path: 'dir/b' }] });
  });

  it('{ skills: [...] }', () => {
    const res = parseRemoteIndex(JSON.stringify({ skills: [{ name: 'a', description: 'x' }] }));
    expect(res).toEqual({ entries: [{ name: 'a' }] });
  });

  it('невалидные записи пропускаются, не роняя разбор', () => {
    const res = parseRemoteIndex(JSON.stringify([
      { name: 'ok' },
      { name: '' },
      { path: 'only-path' },
      'str',
      42,
      null,
    ]));
    expect(res).toEqual({ entries: [{ name: 'ok' }] });
  });

  it('некорректный JSON / неверный корень → ошибка', () => {
    expect('error' in parseRemoteIndex('{oops')).toBe(true);
    expect('error' in parseRemoteIndex(JSON.stringify({ nope: [] }))).toBe(true);
  });
});

describe('resolveRemoteIndexUrl / resolveSkillFileUrl / safeCacheDirName', () => {
  it('index URL: .json как есть, иначе <url>/index.json', () => {
    expect(resolveRemoteIndexUrl(new URL('https://e.com/skills/index.json')).toString())
      .toBe('https://e.com/skills/index.json');
    expect(resolveRemoteIndexUrl(new URL('https://e.com/skills')).toString())
      .toBe('https://e.com/skills/index.json');
    expect(resolveRemoteIndexUrl(new URL('https://e.com/skills/')).toString())
      .toBe('https://e.com/skills/index.json');
  });

  it('file URL: путь относительно индекса, чужой origin — null', () => {
    const idx = new URL('https://example.com/skills/index.json');
    expect(resolveSkillFileUrl(idx, { name: 'alpha' })?.toString())
      .toBe('https://example.com/skills/alpha/SKILL.md');
    expect(resolveSkillFileUrl(idx, { name: 'x', path: 'nested/beta' })?.toString())
      .toBe('https://example.com/skills/nested/beta/SKILL.md');
    // protocol-relative путь на чужой хост — отсекается
    expect(resolveSkillFileUrl(idx, { name: 'x', path: '//evil.com/x' })).toBeNull();
  });

  it('safeCacheDirName: одиночный безопасный сегмент', () => {
    expect(safeCacheDirName('my-skill')).toBe('my-skill');
    expect(safeCacheDirName('..')).toBe('skill');
    expect(safeCacheDirName('a/b')).toBe('a-b');
    expect(safeCacheDirName('')).toBe('skill');
  });
});

describe('refreshRemoteCatalogs (мок сети)', () => {
  it('не-http URL отклонён, сеть не дёргается', async () => {
    const fetchImpl = vi.fn();
    const res = await refreshRemoteCatalogs({
      urls: ['ftp://example.com/skills'],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.diagnostics.some((d) => d.code === 'remote' && /не поддерживается/.test(d.message))).toBe(true);
    expect(res.sources[0]).toEqual(buildUrlSource(root, 'ftp://example.com/skills'));
    expect(res.sources[0]!.trusted).toBe(false);
  });

  it('private/loopback URL заблокирован', async () => {
    const fetchImpl = vi.fn();
    const res = await refreshRemoteCatalogs({
      urls: ['http://169.254.169.254/latest/meta-data', 'http://[::1]/skills'],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.diagnostics.filter((d) => d.code === 'remote')).toHaveLength(2);
  });

  it('таймаут → сетевая ошибка, без падения', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
      timeoutMs: 20,
    });
    expect(res.diagnostics.some((d) => d.code === 'read-error' && /таймаут/.test(d.message))).toBe(true);
  });

  it('превышение размера index.json → диагностика', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(100), { status: 200 }));
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
      maxIndexBytes: 10,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.diagnostics.some((d) => d.code === 'read-error' && /превышен лимит/.test(d.message))).toBe(true);
  });

  it('превышение размера SKILL.md → диагностика, файл не пишется', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) {
        return new Response(JSON.stringify([{ name: 'big' }]), { status: 200 });
      }
      return new Response('x'.repeat(REMOTE_FILE_MAX_BYTES + 1), { status: 200 });
    });
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    expect(res.diagnostics.some((d) => d.code === 'read-error' && /превышен лимит/.test(d.message))).toBe(true);
    await expect(readFile(join(urlCacheDir(root, URL_BASE), 'big', 'SKILL.md'), 'utf-8')).rejects.toThrow();
  });

  it('успешное скачивание в кэш (массив и { skills })', async () => {
    const routes: Record<string, string> = {
      [`${URL_BASE}/index.json`]: JSON.stringify([
        { name: 'alpha', description: 'a' },
        { name: 'beta', path: 'nested/beta' },
      ]),
      [`${URL_BASE}/alpha/SKILL.md`]: skillFile('alpha'),
      [`${URL_BASE}/nested/beta/SKILL.md`]: skillFile('beta'),
    };
    const fetchImpl = vi.fn(async (input: string) => {
      const body = routes[input];
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { status: 200 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics).toEqual([]);
    expect(res.sources).toEqual([buildUrlSource(root, URL_BASE)]);

    const cache = urlCacheDir(root, URL_BASE);
    expect(await readFile(join(cache, 'alpha', 'SKILL.md'), 'utf-8')).toBe(skillFile('alpha'));
    expect(await readFile(join(cache, 'beta', 'SKILL.md'), 'utf-8')).toBe(skillFile('beta'));
  });

  it('запись с чужим origin пропускается (path на другой хост)', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) {
        return new Response(JSON.stringify([{ name: 'x', path: '//evil.com/x' }]), { status: 200 });
      }
      return new Response('nope', { status: 200 });
    });
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.diagnostics.some((d) => d.code === 'remote' && /вне источника/.test(d.message))).toBe(true);
  });

  it('редирект на приватный адрес блокируется (проверка каждого хопа)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/secret/index.json' },
    }));
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.diagnostics.some((d) => d.code === 'read-error' && /запрещён/.test(d.message))).toBe(true);
  });

  it('ошибка сети → read-error, старый кэш не затирается', async () => {
    const sourceDir = urlCacheDir(root, URL_BASE);
    await mkdir(join(sourceDir, 'keep'), { recursive: true });
    await writeFile(join(sourceDir, 'keep', 'SKILL.md'), 'old-content', 'utf-8');

    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics.some((d) => d.code === 'read-error' && /boom/.test(d.message))).toBe(true);
    expect(await readFile(join(sourceDir, 'keep', 'SKILL.md'), 'utf-8')).toBe('old-content');
  });

  it('ошибка одного скилла не мешает другому, старый кэш сохраняется', async () => {
    const sourceDir = urlCacheDir(root, URL_BASE);
    await mkdir(join(sourceDir, 'stale'), { recursive: true });
    await writeFile(join(sourceDir, 'stale', 'SKILL.md'), 'old-stale', 'utf-8');

    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) {
        return new Response(JSON.stringify([{ name: 'ok' }, { name: 'stale' }]), { status: 200 });
      }
      if (input.includes('/ok/')) return new Response(skillFile('ok'), { status: 200 });
      return new Response('err', { status: 500 });
    });
    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(await readFile(join(sourceDir, 'ok', 'SKILL.md'), 'utf-8')).toBe(skillFile('ok'));
    expect(await readFile(join(sourceDir, 'stale', 'SKILL.md'), 'utf-8')).toBe('old-stale');
    expect(res.diagnostics.some((d) => d.code === 'read-error' && d.skill === 'stale')).toBe(true);
  });
});
