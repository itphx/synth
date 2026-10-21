import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogEntry } from '@itphx/synth-shared';
import {
  isBlockedHost,
  refreshRemoteCatalogs,
  resolveCatalogSkillPath,
  resolveRemoteIndexUrl,
  resolveSkillFileUrl,
  safeCacheDirName,
  validateRemoteUrl,
  REMOTE_FILE_MAX_BYTES,
  type FetchLike,
} from './remote.js';
import { buildUrlSource, urlCacheDir } from './discovery.js';

/**
 * Базовая карточка записи каталога для тестов резолва пути (все поля формы
 * `catalogEntrySchema`).
 */
function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name: 'demo',
    kind: 'pack',
    packType: 'skills',
    version: '1.0.0',
    description: { ru: 'Демо', en: 'Demo' },
    license: 'MIT',
    category: 'skills',
    trust_level: 'community',
    identifier: 'acme/demo',
    source: 'registry',
    screenshots: [],
    tags: [],
    versions: [],
    extra: {},
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-remote-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const URL_BASE = 'https://example.com/skills';

/**
 * Фикстура — канонический индекс каталога расширений (`format: 1`) с записями
 * **всех пяти классов** (`plugin`/`gateway`/`addon`/`pack`/`storage`).
 * Лежит рядом с тестом (конвенция `__fixtures__`).
 */
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'catalog-index-format1.json',
);
const CATALOG_FIXTURE = readFileSync(FIXTURE_PATH, 'utf-8');

/**
 * Герметичный DNS-резолвер теста (seam `resolveHost`): без реальной сети.
 * Все хосты — публичный адрес; `private.example` намеренно резолвится в приватный.
 */
const PUBLIC_RESOLVER = async (host: string): Promise<string[]> =>
  host === 'private.example' ? ['10.0.0.5'] : ['93.184.216.34'];

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: desc-${name}\n---\n\nBody of ${name}\n`;
}

describe('validateRemoteUrl / isBlockedHost — SSRF-guard (ADR-046 §4.2)', () => {
  it('только http/https', async () => {
    expect('error' in await validateRemoteUrl('ftp://example.com/skills')).toBe(true);
    expect('error' in await validateRemoteUrl('file:///etc/passwd')).toBe(true);
    expect('error' in await validateRemoteUrl('not a url')).toBe(true);
    expect('error' in await validateRemoteUrl('https://example.com/skills', { resolveHost: PUBLIC_RESOLVER })).toBe(false);
    expect('error' in await validateRemoteUrl('http://example.com/skills', { resolveHost: PUBLIC_RESOLVER })).toBe(false);
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
    'fe80::1%eth0',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ])('блокирует приватный/локальный хост %s', async (host) => {
    expect(isBlockedHost(host)).toBe(true);
    const url = `http://${host.includes(':') ? `[${host}]` : host}/skills`;
    expect('error' in await validateRemoteUrl(url, { resolveHost: PUBLIC_RESOLVER })).toBe(true);
  });

  it('пропускает обычные публичные хосты', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
  });

  // PROP-100 дефект 1: политика обязана резолвить DNS, а не проверять только литерал.
  it('блокирует hostname, резолвящийся в приватный адрес (fail-closed по всем A-записям)', async () => {
    const resolve = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];
    expect('error' in await validateRemoteUrl('https://evil.example/skills', {
      resolveHost: resolve({ 'evil.example': ['127.0.0.1'] }),
    })).toBe(true);
    expect('error' in await validateRemoteUrl('https://meta.example/skills', {
      resolveHost: resolve({ 'meta.example': ['169.254.169.254'] }),
    })).toBe(true);
    expect('error' in await validateRemoteUrl('https://lan.example/skills', {
      resolveHost: resolve({ 'lan.example': ['192.168.1.10'] }),
    })).toBe(true);
    // Несколько A-записей, одна приватная → запрещено (нельзя «проскочить» на публичную).
    expect('error' in await validateRemoteUrl('https://mixed.example/skills', {
      resolveHost: resolve({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] }),
    })).toBe(true);
    // IPv4-mapped через DNS-резолв — тоже запрещено.
    expect('error' in await validateRemoteUrl('https://mapped.example/skills', {
      resolveHost: resolve({ 'mapped.example': ['::ffff:169.254.169.254'] }),
    })).toBe(true);
  });

  it('публичный hostname разрешён', async () => {
    const valid = await validateRemoteUrl('https://public.example/skills', {
      resolveHost: async () => ['93.184.216.34'],
    });
    expect('url' in valid).toBe(true);
  });

  it('ошибка/пустой DNS-резолв → запрет (fail-closed)', async () => {
    expect('error' in await validateRemoteUrl('https://unknown.example/skills', {
      resolveHost: async () => { throw new Error('ENOTFOUND'); },
    })).toBe(true);
    expect('error' in await validateRemoteUrl('https://empty.example/skills', {
      resolveHost: async () => [],
    })).toBe(true);
  });
});

describe('resolveCatalogSkillPath — путь скилла внутри каталога', () => {
  it('extra.path — явный путь', () => {
    expect(
      resolveCatalogSkillPath({
        name: 'demo',
        kind: 'pack',
        packType: 'skills',
        version: '1.0.0',
        description: { ru: 'Демо', en: 'Demo' },
        license: 'MIT',
        category: 'skills',
        trust_level: 'community',
        identifier: 'acme/demo',
        source: 'registry',
        screenshots: [],
        tags: [],
        versions: [],
        extra: { path: 'skills/demo' },
      }),
    ).toBe('skills/demo');
  });

  it('фрагмент identifier после #', () => {
    expect(
      resolveCatalogSkillPath({
        name: 'demo',
        kind: 'pack',
        packType: 'skills',
        version: '1.0.0',
        description: { ru: 'Демо', en: 'Demo' },
        license: 'MIT',
        category: 'skills',
        trust_level: 'community',
        identifier: 'acme/repo#skills/demo',
        source: 'registry',
        screenshots: [],
        tags: [],
        versions: [],
        extra: {},
      }),
    ).toBe('skills/demo');
  });

  it('без пути — undefined (loader возьмёт имя записи)', () => {
    expect(
      resolveCatalogSkillPath({
        name: 'demo',
        kind: 'pack',
        packType: 'skills',
        version: '1.0.0',
        description: { ru: 'Демо', en: 'Demo' },
        license: 'MIT',
        category: 'skills',
        trust_level: 'community',
        identifier: 'acme/repo',
        source: 'registry',
        screenshots: [],
        tags: [],
        versions: [],
        extra: {},
      }),
    ).toBeUndefined();
  });

  it('явное поле path — приоритет над extra.path и фрагментом identifier', () => {
    expect(
      resolveCatalogSkillPath(
        catalogEntry({
          path: 'packs/demo',
          extra: { path: 'legacy/demo' },
          identifier: 'acme/repo#skills/demo',
        }),
      ),
    ).toBe('packs/demo');
  });

  it('приоритет: path → extra.path → фрагмент identifier → имя записи', () => {
    // 1. Явное поле карточки (каноническая форма).
    expect(resolveCatalogSkillPath(catalogEntry({ path: 'packs/demo' }))).toBe('packs/demo');
    // 2. extra.path — legacy-формы и прежние карточки.
    expect(resolveCatalogSkillPath(catalogEntry({ extra: { path: 'legacy/demo' } }))).toBe('legacy/demo');
    // 3. Фрагмент identifier после '#'.
    expect(resolveCatalogSkillPath(catalogEntry({ identifier: 'acme/repo#skills/demo' }))).toBe(
      'skills/demo',
    );
    // 4. Ничего нет — loader берёт имя записи как путь.
    const withoutPath = catalogEntry({ name: 'demo' });
    expect(resolveCatalogSkillPath(withoutPath)).toBeUndefined();
    expect(
      resolveSkillFileUrl(new URL('https://example.com/skills/index.json'), {
        name: withoutPath.name,
        path: resolveCatalogSkillPath(withoutPath),
      })?.toString(),
    ).toBe('https://example.com/skills/demo/SKILL.md');
  });

  it('legacy-формы (extra.path) работают как раньше', () => {
    // Запись, разобранная tolerant-парсером: путь лежит и в path, и в extra.path.
    expect(
      resolveCatalogSkillPath(catalogEntry({ path: 'dir/beta', extra: { path: 'dir/beta' } })),
    ).toBe('dir/beta');
    expect(resolveCatalogSkillPath(catalogEntry({ extra: { path: 'dir/beta' } }))).toBe('dir/beta');
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
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
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(await readFile(join(sourceDir, 'ok', 'SKILL.md'), 'utf-8')).toBe(skillFile('ok'));
    expect(await readFile(join(sourceDir, 'stale', 'SKILL.md'), 'utf-8')).toBe('old-stale');
    expect(res.diagnostics.some((d) => d.code === 'read-error' && d.skill === 'stale')).toBe(true);
  });
});

describe('refreshRemoteCatalogs — канонический каталог расширений (format: 1)', () => {
  it('из индекса с записями всех классов скачиваются только скиллы', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response(CATALOG_FIXTURE, { status: 200 });
      if (input.endsWith('/skills/review/SKILL.md')) {
        return new Response(skillFile('acme-skill-pack'), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    // Индекс + ровно один SKILL.md (запись-скилл); прочие классы не трогаются.
    expect(res.diagnostics).toEqual([]);
    const requested = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(requested).toEqual([
      `${URL_BASE}/index.json`,
      `${URL_BASE}/skills/review/SKILL.md`,
    ]);

    const cache = urlCacheDir(root, URL_BASE);
    expect(await readFile(join(cache, 'acme-skill-pack', 'SKILL.md'), 'utf-8'))
      .toBe(skillFile('acme-skill-pack'));
    // Каталоги записей других классов не создаются.
    await expect(readFile(join(cache, 'acme-plugin', 'SKILL.md'), 'utf-8')).rejects.toThrow();
  });

  it('путь скилла берётся из identifier (owner/repo#path)', async () => {
    const index = JSON.stringify({
      format: 1,
      title: { ru: 'Каталог', en: 'Catalog' },
      description: { ru: 'Каталог', en: 'Catalog' },
      generated_at: '2026-10-21T06:00:00Z',
      metadata: { categories: {}, sources: [] },
      plugins: [
        {
          name: 'acme-pack',
          kind: 'pack',
          packType: 'skills',
          version: '1.0.0',
          description: { ru: 'Пак', en: 'Pack' },
          license: 'MIT',
          category: 'skills',
          trust_level: 'community',
          identifier: 'acme/repo#skills/demo',
          source: 'github',
          versions: [],
          extra: {},
        },
      ],
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response(index, { status: 200 });
      return new Response(skillFile('acme-pack'), { status: 200 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics).toEqual([]);
    const requested = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(requested).toContain(`${URL_BASE}/skills/demo/SKILL.md`);
  });

  it('путь скилла берётся из явного поля path (вендоренный контент пака)', async () => {
    const index = JSON.stringify({
      format: 1,
      title: { ru: 'Каталог', en: 'Catalog' },
      description: { ru: 'Каталог', en: 'Catalog' },
      generated_at: '2026-10-21T06:00:00Z',
      metadata: { categories: {}, sources: [] },
      plugins: [
        {
          name: 'acme-pack',
          kind: 'pack',
          packType: 'skills',
          version: '1.0.0',
          description: { ru: 'Пак', en: 'Pack' },
          license: 'MIT',
          category: 'skills',
          trust_level: 'community',
          identifier: 'acme/repo',
          path: 'packs/acme/skills/demo',
          source: 'github',
          versions: [],
          extra: {},
        },
      ],
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response(index, { status: 200 });
      return new Response(skillFile('acme-pack'), { status: 200 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics).toEqual([]);
    const requested = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(requested).toEqual([
      `${URL_BASE}/index.json`,
      `${URL_BASE}/packs/acme/skills/demo/SKILL.md`,
    ]);
    const cache = urlCacheDir(root, URL_BASE);
    expect(await readFile(join(cache, 'acme-pack', 'SKILL.md'), 'utf-8')).toBe(skillFile('acme-pack'));
  });

  it('превышение лимита записей — обрабатываются первые', async () => {
    const index = JSON.stringify({
      format: 1,
      plugins: [
        {
          name: 'first',
          kind: 'pack',
          packType: 'skills',
          version: '1.0.0',
          description: { ru: 'Первый', en: 'First' },
          license: 'MIT',
          category: 'skills',
          trust_level: 'community',
          identifier: 'acme/first',
          source: 'github',
          versions: [],
          extra: {},
        },
        {
          name: 'second',
          kind: 'pack',
          packType: 'skills',
          version: '1.0.0',
          description: { ru: 'Второй', en: 'Second' },
          license: 'MIT',
          category: 'skills',
          trust_level: 'community',
          identifier: 'acme/second',
          source: 'github',
          versions: [],
          extra: {},
        },
      ],
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response(index, { status: 200 });
      return new Response(skillFile('x'), { status: 200 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
      maxSkills: 1,
    });

    expect(res.diagnostics.some((d) => d.code === 'remote' && /обрабатываются первые 1/.test(d.message)))
      .toBe(true);
    const requested = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(requested).toEqual([`${URL_BASE}/index.json`, `${URL_BASE}/first/SKILL.md`]);
  });

  it('пустой индекс — пустой результат, без исключений', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response('[]', { status: 200 });
      return new Response('not found', { status: 404 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('битый JSON → диагностика, сеть не дёргается дальше', async () => {
    const fetchImpl = vi.fn(async () => new Response('{oops', { status: 200 }));

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.diagnostics.some((d) => d.code === 'remote' && /некорректный JSON/.test(d.message)))
      .toBe(true);
  });

  it('мусор в корне (не каталог) → диагностика', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: [] }), { status: 200 }));

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.diagnostics.some((d) => d.code === 'remote' && /ожидается каталог расширений/.test(d.message)))
      .toBe(true);
  });

  it('записи других классов каталога не превращаются в скиллы', async () => {
    const index = JSON.stringify({
      format: 1,
      plugins: [
        {
          name: 'acme-plugin',
          kind: 'plugin',
          version: '1.0.0',
          description: { ru: 'Плагин', en: 'Plugin' },
          license: 'MIT',
          category: 'plugins',
          trust_level: 'community',
          identifier: 'acme/plugin',
          source: 'github',
          versions: [],
          extra: {},
        },
      ],
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) return new Response(index, { status: 200 });
      return new Response('not found', { status: 404 });
    });

    const res = await refreshRemoteCatalogs({
      urls: [URL_BASE],
      cacheDir: root,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    expect(res.diagnostics).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
