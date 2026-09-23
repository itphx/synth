import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from './service.js';
import { urlCacheDir } from './discovery.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-service-'));
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

describe('SkillService — builtin skill-creator (AD-046 §9.5)', () => {
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

describe('SkillService — skills.urls (AD-046 §4.2/§4.3)', () => {
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
    vi.stubGlobal('fetch', fetchMock);

    new SkillService({ dataDir: join(root, 'data'), urls: [URL_BASE], home: join(root, 'home') });

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
    vi.stubGlobal('fetch', fetchMock);

    const service = new SkillService({ dataDir, urls: [URL_BASE], home: join(root, 'home') });
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
    vi.stubGlobal('fetch', fetchMock);

    const service = new SkillService({ dataDir, urls: [URL_BASE], home: join(root, 'home') });
    await Promise.all([service.refreshRemote(), service.refreshRemote()]);

    // index.json + SKILL.md, а не 2×(index+skill)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshRemote без urls — no-op, сеть не дёргается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new SkillService({ dataDir: join(root, 'data'), home: join(root, 'home') });
    await service.refreshRemote();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ошибка сети диагностируется, не роняя сервис', async () => {
    const dataDir = join(root, 'data');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const service = new SkillService({ dataDir, urls: [URL_BASE], home: join(root, 'home') });
    await service.refreshRemote();

    const { diagnostics } = await service.list();
    expect(diagnostics.some((d) => d.code === 'read-error')).toBe(true);
  });

  it('старый кэш сохраняется при ошибке сети', async () => {
    const dataDir = join(root, 'data');
    const cacheDir = urlCacheDir(join(dataDir, 'skills-cache'), URL_BASE);
    await writeSkill(cacheDir, 'keep');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const service = new SkillService({ dataDir, urls: [URL_BASE], home: join(root, 'home') });
    await service.refreshRemote();

    expect(await readFile(join(cacheDir, 'keep', 'SKILL.md'), 'utf-8')).toContain('keep');
  });
});
