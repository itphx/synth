import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillSources,
  buildUrlSource,
  mergeSkillScans,
  scanSkillSource,
  urlCacheSlug,
} from './discovery.js';
import { buildSkillCatalog } from './catalog.js';
import { SkillRegistry } from './registry.js';
import type { SkillSource } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, description = 'desc', extra = ''): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}\n`, 'utf-8');
  return skillDir;
}

describe('buildSkillSources (AD-046 §4.2/§4.3)', () => {
  it('порядок project > instance > config.paths, приоритет/trust', () => {
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/work/proj',
      configPaths: ['/extra/skills'],
      trustedProjectDirs: ['/work/proj'],
      home: '/home/u',
    });
    // Первые три — заявленный приоритет; далее external (AD-046 §4.2).
    expect(sources.slice(0, 3).map((s) => s.origin)).toEqual(['project', 'instance', 'config']);
    expect(sources[0]!.dir).toBe(join('/work/proj', '.synth', 'skills'));
    expect(sources[0]!.trusted).toBe(true);
    expect(sources[1]!.trusted).toBe(true);
    expect(sources[1]!.scope).toBe('instance');
    expect(sources[1]!.level).toBe('system');
  });

  it('проект без trust — trusted=false', () => {
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/work/proj',
      trustedProjectDirs: [],
    });
    expect(sources[0]!.trusted).toBe(false);
  });

  it('раскрывает ~ в config.paths и trustedProjectDirs', () => {
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/home/u/proj',
      configPaths: ['~/skills'],
      trustedProjectDirs: ['~/proj'],
      home: '/home/u',
    });
    expect(sources[2]!.dir).toBe(join('/home/u', 'skills'));
    expect(sources[0]!.trusted).toBe(true);
  });

  it('без проекта — instance, config и внешний home-каталог', () => {
    const sources = buildSkillSources({ dataDir: '/data', configPaths: ['/x'], home: '/home/u' });
    expect(sources.map((s) => s.origin)).toEqual(['instance', 'config', 'external']);
    expect(sources[2]!.dir).toBe(join('/home/u', '.config', 'opencode', 'skills'));
  });

  it('external-каталоги после config.paths, в порядке .opencode/skills > .opencode/skill > .claude/skills > .agents/skills > ~/.config/opencode/skills (AD-046 §4.2)', () => {
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/work/proj',
      configPaths: ['/extra/skills'],
      trustedProjectDirs: ['/work/proj'],
      home: '/home/u',
    });
    expect(sources.map((s) => s.origin)).toEqual([
      'project', 'instance', 'config',
      'external', 'external', 'external', 'external', 'external',
    ]);
    expect(sources[3]!.dir).toBe(join('/work/proj', '.opencode', 'skills'));
    expect(sources[4]!.dir).toBe(join('/work/proj', '.opencode', 'skill'));
    expect(sources[5]!.dir).toBe(join('/work/proj', '.claude', 'skills'));
    expect(sources[6]!.dir).toBe(join('/work/proj', '.agents', 'skills'));
    expect(sources[7]!.dir).toBe(join('/home/u', '.config', 'opencode', 'skills'));
    // project-trust наследуется, home-каталог trusted
    expect(sources[3]!.scope).toBe('project');
    expect(sources[3]!.trusted).toBe(true);
    expect(sources[7]!.scope).toBe('instance');
    expect(sources[7]!.trusted).toBe(true);
  });

  it('external в недоверенном проекте — trusted=false', () => {
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/work/proj',
      trustedProjectDirs: [],
    });
    const projectExternal = sources.filter((s) => s.origin === 'external' && s.scope === 'project');
    expect(projectExternal).toHaveLength(4);
    expect(projectExternal.every((s) => s.trusted === false)).toBe(true);
  });

  it('skills.urls → url-кэш-источники trusted:false, пути детерминированы (AD-046 §4.3)', () => {
    const urls = ['https://example.com/skills', 'https://example.org/catalog/index.json'];
    const sources = buildSkillSources({
      dataDir: '/data',
      projectWorkspace: '/work/proj',
      urls,
      skillsCacheDir: '/cache/skills',
      home: '/home/u',
    });
    const urlSources = sources.filter((s) => s.origin === 'url');
    expect(urlSources).toHaveLength(2);
    expect(urlSources.every((s) => s.trusted === false)).toBe(true);
    expect(urlSources[0]!.dir).toBe(join('/cache/skills', 'urls', urlCacheSlug(urls[0]!)));
    expect(urlSources[1]!.dir).toBe(join('/cache/skills', 'urls', urlCacheSlug(urls[1]!)));
    // urls — последний (низший приоритет)
    expect(sources[sources.length - 1]!.origin).toBe('url');
  });

  it('url-скиллы: trusted=false, видны в диагностике, но отсутствуют в каталоге для модели', async () => {
    const cacheDir = join(root, 'cache');
    const url = 'https://example.com/skills';
    await writeSkill(join(cacheDir, 'urls', urlCacheSlug(url)), 'remote-skill');

    const source = buildUrlSource(cacheDir, url);
    const merged = mergeSkillScans([{ source, result: await scanSkillSource(source) }]);

    expect(merged.skills.map((s) => s.name)).toEqual(['remote-skill']);
    expect(merged.skills[0]!.trusted).toBe(false);
    expect(merged.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);

    const catalog = buildSkillCatalog(merged.skills, {});
    expect(catalog.stable).toHaveLength(0);
    expect(catalog.session).toHaveLength(0);
  });
});

describe('scanSkillSource + mergeSkillScans', () => {
  it('находит только каталоги с SKILL.md, диагностирует ошибки', async () => {
    const src = join(root, 'src');
    await writeSkill(src, 'good');
    await mkdir(join(src, 'no-skill', 'sub'), { recursive: true });
    await mkdir(join(src, 'bad'), { recursive: true });
    await writeFile(join(src, 'bad', 'SKILL.md'), '---\nname: Bad\ndescription: d\n---\n', 'utf-8');

    const source: SkillSource = { scope: 'instance', level: 'system', origin: 'instance', dir: src, trusted: true };
    const { skills, diagnostics } = await scanSkillSource(source);
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(diagnostics.map((d) => d.code)).toContain('invalid-name');
    expect(skills[0]!.source.scope).toBe('instance');
    expect(skills[0]!.dir).toBe(join(src, 'good'));
  });

  it('first-wins и shadowed-диагностика', async () => {
    const proj = join(root, 'proj');
    const inst = join(root, 'inst');
    await writeSkill(proj, 'dup', 'from project');
    await writeSkill(inst, 'dup', 'from instance');
    await writeSkill(proj, 'only-project');
    await writeSkill(inst, 'only-instance');

    const project: SkillSource = { scope: 'project', level: 'project', origin: 'project', dir: proj, trusted: true };
    const instance: SkillSource = { scope: 'instance', level: 'system', origin: 'instance', dir: inst, trusted: true };
    const merged = mergeSkillScans([
      { source: project, result: await scanSkillSource(project) },
      { source: instance, result: await scanSkillSource(instance) },
    ]);
    expect([...merged.skills.map((s) => s.name)].sort()).toEqual(['dup', 'only-instance', 'only-project']);
    expect(merged.skills.find((s) => s.name === 'dup')!.meta.description).toBe('from project');
    expect(merged.diagnostics.some((d) => d.code === 'shadowed')).toBe(true);
  });

  it('недоверенный проектный скилл виден, но trusted=false + diagnostics untrusted', async () => {
    const proj = join(root, 'proj');
    await writeSkill(proj, 'p');
    const project: SkillSource = { scope: 'project', level: 'project', origin: 'project', dir: proj, trusted: false };
    const merged = mergeSkillScans([{ source: project, result: await scanSkillSource(project) }]);
    expect(merged.skills).toHaveLength(1);
    expect(merged.skills[0]!.trusted).toBe(false);
    expect(merged.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
  });
});

describe('SkillRegistry — ленивая инвалидация по mtime (AD-046 §8.3)', () => {
  it('пере-сканирует при изменении SKILL.md', async () => {
    const src = join(root, 'src');
    const skillDir = await writeSkill(src, 's', 'first');
    const sources = (): SkillSource[] => [
      { scope: 'instance', level: 'system', origin: 'instance', dir: src, trusted: true },
    ];
    const registry = new SkillRegistry({ sources });

    expect((await registry.list()).skills[0]!.meta.description).toBe('first');

    // Изменяем содержимое и mtime (даже при совпадении миллисекунд).
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: s\ndescription: second-longer\n---\n\nBody\n',
      'utf-8',
    );
    const future = new Date(Date.now() + 5000);
    await utimes(join(skillDir, 'SKILL.md'), future, future);

    expect((await registry.list()).skills[0]!.meta.description).toBe('second-longer');
  });

  it('reload() сбрасывает кэш (подхватывает новый скилл)', async () => {
    const src = join(root, 'src');
    await mkdir(src, { recursive: true });
    const sources = (): SkillSource[] => [
      { scope: 'instance', level: 'system', origin: 'instance', dir: src, trusted: true },
    ];
    const registry = new SkillRegistry({ sources });
    expect((await registry.list()).skills).toHaveLength(0);

    await writeSkill(src, 'new-one');
    registry.reload();
    expect((await registry.list()).skills.map((s) => s.name)).toEqual(['new-one']);
  });
});
