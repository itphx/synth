import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from './service.js';
import { urlCacheDir } from './discovery.js';
import { buildSkillContentBlock } from './loader.js';
import { SkillStore, type UpdateSkillMarkdownInput } from '../../storage/skill-store.js';
import { MemorySkillRepository } from '../../storage/memory/index.js';
import type { HostResolver } from '../mcp/network-policy.js';

let root: string;

/**
 * Герметичность: ни DNS, ни HTTP в сеть не ходят.
 * - `resolveHost` — инъекция DNS-резолвера (шов SSRF-проверки);
 * - `fetchImpl` — инъекция транспорта (шов загрузки каталога);
 * - глобальный `fetch` — «ловушка»: любой обход шва уронит тест.
 */
const PUBLIC_ADDRESS = '93.184.216.34';
const resolveHostStub: HostResolver = async () => [PUBLIC_ADDRESS];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-service-'));
  vi.stubGlobal('fetch', () => {
    throw new Error('network forbidden: удалённые каталоги грузятся только через fetchImpl');
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const URL_BASE = 'https://example.com/skills';

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: desc-${name}\n---\n\nBody of ${name}\n`,
    'utf-8',
  );
}

describe('SkillService — builtin skill-creator (ADR-046 §9.5)', () => {
  it('виден в list/listSummaries как trusted instance/system', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    const { skills } = await service.list();
    const builtin = skills.find((s) => s.name === 'skill-creator');
    expect(builtin).toBeDefined();
    expect(builtin!.trusted).toBe(true);
    expect(builtin!.source.scope).toBe('instance');
    expect(builtin!.source.level).toBe('system');

    const { skills: summaries } = await service.listSummaries();
    const summary = summaries.find((s) => s.name === 'skill-creator');
    expect(summary?.trusted).toBe(true);
    expect(summary?.userInvocable).toBe(true);
    expect(summary?.requiresCapabilities).toEqual(['file_read', 'file_write']);
  });

  it('попадает в каталог для модели при наличии capabilities', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    const catalog = await service.buildCatalog({ capabilities: ['file_read', 'file_write'] });
    expect(catalog.stable.map((e) => e.name)).toContain('skill-creator');
  });

  it('load() возвращает тело, detail() — без supporting-файлов', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    const loaded = await service.load('skill-creator', { capabilities: ['file_read', 'file_write'] });
    expect(loaded?.body).toContain('.synth/skills');
    expect(loaded?.files).toEqual([]);

    const detail = await service.detail('skill-creator');
    expect(detail?.body).toContain('.synth/skills');
    expect(detail?.files).toEqual([]);
  });

  it('builtin не перекрывается одноимённым project-скиллом (builtin первым)', async () => {
    const dataDir = join(root, 'data');
    const ws = join(root, 'ws');
    await writeSkill(join(ws, '.synth', 'skills'), 'skill-creator');

    const service = new SkillService({
      dataDir,
      home: join(root, 'home'),
      trustedProjectDirs: [ws],
    });
    const { skills, diagnostics } = await service.list({ projectWorkspace: ws });

    const matches = skills.filter((s) => s.name === 'skill-creator');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.source.scope).toBe('instance');
    expect(matches[0]!.meta.description).toContain('Scaffold a new project skill');
    expect(diagnostics.some((d) => d.code === 'shadowed')).toBe(true);
  });
});

describe('SkillService — builtin synth-agents-md (ADR-069 §8.2)', () => {
  it('виден в реестре как trusted instance/system с requires_capabilities', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    const { skills } = await service.list();
    const builtin = skills.find((s) => s.name === 'synth-agents-md');
    expect(builtin).toBeDefined();
    expect(builtin!.trusted).toBe(true);
    expect(builtin!.source.scope).toBe('instance');
    expect(builtin!.source.level).toBe('system');
    expect(builtin!.meta.command).toBe('agents-md');
    expect(builtin!.meta.requiresCapabilities).toEqual(['file_read', 'search', 'file_write']);

    const { skills: summaries } = await service.listSummaries();
    const summary = summaries.find((s) => s.name === 'synth-agents-md');
    expect(summary?.trusted).toBe(true);
    expect(summary?.userInvocable).toBe(true);
    expect(summary?.requiresCapabilities).toEqual(['file_read', 'search', 'file_write']);
  });

  it('capability-aware: стабилен при наличии capabilities, unavailable без search', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });

    const full = await service.buildCatalog({ capabilities: ['file_read', 'search', 'file_write'] });
    expect(full.stable.map((e) => e.name)).toContain('synth-agents-md');

    const readOnly = await service.buildCatalog({ capabilities: ['file_read'] });
    const entry = readOnly.session.find((e) => e.name === 'synth-agents-md');
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toBe('capabilities');
  });

  it('load() возвращает тело про AGENTS.md, detail() — без supporting-файлов', async () => {
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    const loaded = await service.load('synth-agents-md', { capabilities: ['file_read', 'search', 'file_write'] });
    expect(loaded?.body).toContain('AGENTS.md');
    expect(loaded?.files).toEqual([]);
  });
});

describe('SkillService — skills.urls (ADR-046 §4.2/§4.3)', () => {
  it('urls прокинуты: url-скилл из кэша виден, trusted=false', async () => {
    const dataDir = join(root, 'data');
    const cacheDir = urlCacheDir(join(dataDir, 'skills-cache'), URL_BASE);
    await writeSkill(cacheDir, 'remote-skill');

    const service = new SkillService({ dataDir, urls: [URL_BASE], home: join(root, 'home') });
    const { skills, diagnostics } = await service.list();

    const found = skills.find((s) => s.name === 'remote-skill');
    expect(found).toBeDefined();
    expect(found!.trusted).toBe(false);
    expect(diagnostics.some((d) => d.code === 'untrusted')).toBe(true);

    // В каталог для модели url-скиллы не попадают (builtin skill-creator — не url-скилл).
    const catalog = await service.buildCatalog({});
    expect(catalog.stable.some((e) => e.name === 'remote-skill')).toBe(false);
    expect(catalog.session.some((e) => e.name === 'remote-skill')).toBe(false);
  });

  it('конструктор не ходит в сеть', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('network forbidden');
    });

    new SkillService({
      dataDir: join(root, 'data'),
      urls: [URL_BASE],
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshRemote скачивает в кэш и вызывает reload', async () => {
    const dataDir = join(root, 'data');
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/index.json')) {
        return new Response(JSON.stringify([{ name: 'r1' }]), { status: 200 });
      }
      return new Response('---\nname: r1\ndescription: d\n---\n\nBody\n', { status: 200 });
    });

    const service = new SkillService({
      dataDir,
      urls: [URL_BASE],
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });
    const reloadSpy = vi.spyOn(service, 'reload');

    await service.refreshRemote();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const { skills } = await service.list();
    expect(skills.map((s) => s.name)).toContain('r1');
    expect(skills.find((s) => s.name === 'r1')!.trusted).toBe(false);
  });

  it('refreshRemote: in-flight guard — параллельные вызовы дают одно обновление', async () => {
    const dataDir = join(root, 'data');
    const fetchMock = vi.fn(async (input: string) => {
      await new Promise((r) => setTimeout(r, 5));
      if (input.endsWith('/index.json')) {
        return new Response(JSON.stringify([{ name: 'r1' }]), { status: 200 });
      }
      return new Response('---\nname: r1\ndescription: d\n---\n\nBody\n', { status: 200 });
    });

    const service = new SkillService({
      dataDir,
      urls: [URL_BASE],
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });
    await Promise.all([service.refreshRemote(), service.refreshRemote()]);

    // index.json + SKILL.md, а не 2×(index+skill)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshRemote без urls — no-op, сеть не дёргается', async () => {
    const fetchMock = vi.fn();
    const service = new SkillService({
      dataDir: join(root, 'data'),
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });
    await service.refreshRemote();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ошибка сети диагностируется, не роняя сервис', async () => {
    const dataDir = join(root, 'data');
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });

    const service = new SkillService({
      dataDir,
      urls: [URL_BASE],
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });
    await service.refreshRemote();

    const { diagnostics } = await service.list();
    expect(diagnostics.some((d) => d.code === 'read-error')).toBe(true);
  });

  it('старый кэш сохраняется при ошибке сети', async () => {
    const dataDir = join(root, 'data');
    const cacheDir = urlCacheDir(join(dataDir, 'skills-cache'), URL_BASE);
    await writeSkill(cacheDir, 'keep');
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });

    const service = new SkillService({
      dataDir,
      urls: [URL_BASE],
      home: join(root, 'home'),
      fetchImpl: fetchMock,
      resolveHost: resolveHostStub,
    });
    await service.refreshRemote();

    expect(await readFile(join(cacheDir, 'keep', 'SKILL.md'), 'utf-8')).toContain('keep');
  });
});

describe('SkillService — instance CRUD инвалидирует кэш реестра (ADR-046 §8.3)', () => {
  it('updateInstance отдаёт новое содержимое при совпадении floor(mtime) и размера SKILL.md', async () => {
    // Стор восстанавливает mtime после перезаписи — эмуляция create+update в одну
    // миллисекунду; сигнатура ленивой инвалидации (`floor(mtimeMs):size`) тогда не
    // меняется, и без явного сброса `detail()` вернул бы устаревшие данные.
    class SameMtimeStore extends SkillStore {
      restoreSeconds: number | null = null;
      override async updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void> {
        await super.updateMarkdown(name, patch);
        if (this.restoreSeconds !== null) {
          // Файловая раскладка — деталь реализации `SkillStore` (порт путей не отдаёт).
          await utimes(
            join(dataDir, 'skills', name, 'SKILL.md'),
            this.restoreSeconds,
            this.restoreSeconds,
          );
        }
      }
    }

    const dataDir = join(root, 'data');
    const store = new SameMtimeStore({ dataDir });
    const service = new SkillService({ dataDir, home: join(root, 'home'), store });

    await service.createInstance({ name: 'a', description: 'old', body: 'old body' });
    // Точное значение `mtimeMs` (без потери субмиллисекунд) — floor совпадёт с кэшем.
    store.restoreSeconds = Math.floor((await stat(join(dataDir, 'skills', 'a', 'SKILL.md'))).mtimeMs) / 1000;

    const detail = await service.updateInstance('a', { description: 'new', body: 'new body' });
    expect(detail?.description).toBe('new');
    expect(detail?.body).toContain('new body');
  });
});

describe('SkillService — instance-скиллы через порт (ADR-116: SQL + blobs)', () => {
  it('скилл виден, supporting-файлы читаются портом, правки видны после изменения', async () => {
    const dataDir = join(root, 'data');
    const store = new MemorySkillRepository();
    await store.create({
      name: 'ported',
      description: 'портовый',
      body: 'body v1',
      files: { 'notes/a.md': 'A' },
    });

    const service = new SkillService({ dataDir, home: join(root, 'home'), store });

    const detail = await service.detail('ported');
    expect(detail?.description).toBe('портовый');
    expect(detail?.files).toEqual(['notes/a.md']);
    expect(await service.readSupportingFile('ported', 'notes/a.md')).toBe('A');

    const loaded = await service.load('ported');
    expect(loaded?.files).toEqual(['notes/a.md']);
    // ФС-пути порт не отдаёт: base directory — виртуальный blob-каталог.
    expect(loaded?.dir).toBe('blob:skills/ported');
    expect(
      buildSkillContentBlock(loaded!.summary, loaded!.body, loaded!.dir, loaded!.files),
    ).toContain('instance store');

    // Правка «в обход» сервиса: подпись порт-источника (размер SKILL.md)
    // меняется — реестр пере-сканирует без явного reload().
    await store.updateMarkdown('ported', { body: 'body v2 (длиннее)' });
    const rescanned = await service.get('ported');
    expect(rescanned?.body).toContain('body v2');
  });

  it('instance CRUD через сервис: создание/файлы/удаление видны сразу', async () => {
    const dataDir = join(root, 'data');
    const store = new MemorySkillRepository();
    const service = new SkillService({ dataDir, home: join(root, 'home'), store });

    const created = await service.createInstance({
      name: 'fresh',
      description: 'свежий',
      body: 'body',
      files: { 'ref/a.md': 'a' },
    });
    expect(created?.files).toEqual(['ref/a.md']);
    expect(await service.listInstanceFiles('fresh')).toEqual(['ref/a.md']);

    await service.writeInstanceFile('fresh', 'ref/b.md', 'b');
    expect((await service.detail('fresh'))?.files).toEqual(['ref/a.md', 'ref/b.md']);

    expect(await service.deleteInstanceFile('fresh', 'ref/b.md')).toBe(true);
    expect((await service.detail('fresh'))?.files).toEqual(['ref/a.md']);

    expect(await service.removeInstance('fresh')).toBe(true);
    expect(await service.detail('fresh')).toBeUndefined();
  });
});
