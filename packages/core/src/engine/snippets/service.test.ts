/**
 * PROP-126 §4: доменный сервис сниппетов — список/чтение/раскрытие и запись
 * (create/update/delete) по трём уровням, атомарная запись файла.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnippetError, SnippetService } from './service.js';
import {
  instanceSnippetsDir,
  projectSnippetsDir,
  userSnippetsDir,
} from './discovery.js';

let dataDir: string;
let workspace: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-snippets-svc-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-snippets-svc-ws-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function writeSnippetFile(dir: string, fileName: string, frontmatter: string[], body = 'тело'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), ['---', ...frontmatter, '---', body].join('\n'), 'utf-8');
}

function makeService(opts: { trusted?: boolean } = {}): SnippetService {
  return new SnippetService({
    dataDir,
    trustedProjectDirs: opts.trusted === false ? [] : [workspace],
  });
}

describe('SnippetService — список и чтение', () => {
  it('видит три уровня с приоритетом user > project > instance', async () => {
    await writeSnippetFile(userSnippetsDir(dataDir, 'u1'), 'dup.md', ['name: dup', 'description: user']);
    await writeSnippetFile(projectSnippetsDir(workspace), 'dup.md', ['name: dup', 'description: project']);
    await writeSnippetFile(instanceSnippetsDir(dataDir), 'dup.md', ['name: dup', 'description: instance']);
    await writeSnippetFile(instanceSnippetsDir(dataDir), 'only-instance.md', ['name: only-instance']);

    const service = makeService();
    const { snippets, diagnostics } = await service.list({ userId: 'u1', projectWorkspace: workspace });

    const dup = snippets.filter((s) => s.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.scope).toBe('user');
    expect(dup[0]!.description).toBe('user');
    expect(snippets.some((s) => s.name === 'only-instance')).toBe(true);
    expect(diagnostics.some((d) => d.code === 'shadowed')).toBe(true);
  });

  it('пользовательские сниппеты изолированы по userId', async () => {
    await writeSnippetFile(userSnippetsDir(dataDir, 'u1'), 'mine.md', ['name: mine']);
    const service = makeService();
    const mine = await service.list({ userId: 'u1' });
    const other = await service.list({ userId: 'u2' });
    expect(mine.snippets.some((s) => s.name === 'mine')).toBe(true);
    expect(other.snippets.some((s) => s.name === 'mine')).toBe(false);
  });

  it('недоверенный проектный сниппет виден в list с trusted:false', async () => {
    await writeSnippetFile(projectSnippetsDir(workspace), 'p.md', ['name: p']);
    const service = makeService({ trusted: false });
    const { snippets, diagnostics } = await service.list({ projectWorkspace: workspace });
    const project = snippets.find((s) => s.name === 'p');
    expect(project?.trusted).toBe(false);
    expect(diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
  });

  it('get находит по имени и по алиасу', async () => {
    await writeSnippetFile(instanceSnippetsDir(dataDir), 'greet.md', [
      'name: greet',
      'aliases:',
      '  - hi',
    ]);
    const service = makeService();
    expect((await service.get('greet'))?.name).toBe('greet');
    expect((await service.get('hi'))?.name).toBe('greet');
    expect(await service.get('nope')).toBeUndefined();
  });

  it('get находит недоверенный проектный сниппет, но помечает trusted:false', async () => {
    await writeSnippetFile(projectSnippetsDir(workspace), 'p.md', ['name: p']);
    const service = makeService({ trusted: false });
    const found = await service.get('p', { projectWorkspace: workspace });
    expect(found?.name).toBe('p');
    expect(found?.trusted).toBe(false);
  });
});

describe('SnippetService — раскрытие', () => {
  it('expandText раскрывает сниппеты нужного пользователя', async () => {
    await writeSnippetFile(userSnippetsDir(dataDir, 'u1'), 'mine.md', ['name: mine'], 'МОЁ');
    await writeSnippetFile(userSnippetsDir(dataDir, 'u2'), 'mine.md', ['name: mine'], 'ЧУЖОЕ');

    const service = makeService();
    const mine = await service.expandText('#mine', { userId: 'u1' });
    const other = await service.expandText('#mine', { userId: 'u2' });
    expect(mine.text).toBe('МОЁ');
    expect(other.text).toBe('ЧУЖОЕ');
  });

  it('недоверенный проектный сниппет не раскрывается', async () => {
    await writeSnippetFile(projectSnippetsDir(workspace), 'p.md', ['name: p'], 'ПРОЕКТ');
    const service = makeService({ trusted: false });
    const res = await service.expandText('см. #p', { projectWorkspace: workspace });
    expect(res.text).toBe('см. #p');
    expect(res.applied).toEqual([]);
    expect(res.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
  });

  it('доверенный проектный сниппет раскрывается', async () => {
    await writeSnippetFile(projectSnippetsDir(workspace), 'p.md', ['name: p'], 'ПРОЕКТ');
    const service = makeService();
    const res = await service.expandText('см. #p', { projectWorkspace: workspace });
    expect(res.text).toBe('см. ПРОЕКТ');
    expect(res.applied).toEqual(['p']);
  });
});

describe('SnippetService — create/update/delete', () => {
  it('create пишет файл с frontmatter (instance)', async () => {
    const service = makeService();
    const created = await service.create({
      scope: 'instance',
      name: 'greet',
      body: 'Привет!',
      description: 'Приветствие',
      aliases: ['hi'],
    });
    expect(created.name).toBe('greet');
    expect(created.file).toBe(join(instanceSnippetsDir(dataDir), 'greet.md'));

    const raw = await readFile(created.file, 'utf-8');
    expect(raw).toContain('name: greet');
    expect(raw).toContain('description: Приветствие');
    expect(raw).toContain('hi');
    expect(raw).toContain('Привет!');
  });

  it('созданный сниппет сразу виден в list и раскрывается', async () => {
    const service = makeService();
    await service.create({ scope: 'instance', name: 'greet', body: 'Привет!' });
    const { snippets } = await service.list();
    expect(snippets.some((s) => s.name === 'greet')).toBe(true);
    expect((await service.expandText('#greet')).text).toBe('Привет!');
  });

  it('create для уровня user пишет в каталог пользователя', async () => {
    const service = makeService();
    const created = await service.create({
      scope: 'user',
      userId: 'u1',
      name: 'mine',
      body: 'МОЁ',
    });
    expect(created.file).toBe(join(userSnippetsDir(dataDir, 'u1'), 'mine.md'));
  });

  it('create для уровня project пишет в workspace проекта', async () => {
    const service = makeService();
    const created = await service.create({
      scope: 'project',
      projectWorkspace: workspace,
      name: 'proj',
      body: 'ПРОЕКТ',
    });
    expect(created.file).toBe(join(projectSnippetsDir(workspace), 'proj.md'));
    expect(created.trusted).toBe(true);
  });

  it('повторный create — конфликт', async () => {
    const service = makeService();
    await service.create({ scope: 'instance', name: 'greet', body: 'Привет!' });
    await expect(service.create({ scope: 'instance', name: 'greet', body: 'Ещё' })).rejects.toBeInstanceOf(
      SnippetError,
    );
  });

  it('update переписывает тело и алиасы', async () => {
    const service = makeService();
    await service.create({ scope: 'instance', name: 'greet', body: 'Привет!' });
    const updated = await service.update({
      scope: 'instance',
      name: 'greet',
      body: 'Здравствуйте',
      aliases: ['hi'],
    });
    expect(updated.body).toBe('Здравствуйте');
    expect(updated.aliases).toEqual(['hi']);
    expect((await service.expandText('#greet')).text).toBe('Здравствуйте');
  });

  it('update отсутствующего — not-found', async () => {
    const service = makeService();
    await expect(
      service.update({ scope: 'instance', name: 'nope', body: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('delete удаляет файл, повтор — false', async () => {
    const service = makeService();
    await service.create({ scope: 'instance', name: 'greet', body: 'Привет!' });
    expect(await service.delete({ scope: 'instance', name: 'greet' })).toBe(true);
    expect(await service.delete({ scope: 'instance', name: 'greet' })).toBe(false);
    const { snippets } = await service.list();
    expect(snippets.some((s) => s.name === 'greet')).toBe(false);
  });

  it('недопустимое имя отклоняется', async () => {
    const service = makeService();
    await expect(
      service.create({ scope: 'instance', name: 'Плохое Имя', body: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-name' });
  });

  it('недопустимый алиас отклоняется', async () => {
    const service = makeService();
    await expect(
      service.create({ scope: 'instance', name: 'ok', body: 'x', aliases: ['Плохое'] }),
    ).rejects.toMatchObject({ code: 'invalid-alias' });
  });

  it('write атомарна: временных файлов не остаётся', async () => {
    const service = makeService();
    await service.create({ scope: 'instance', name: 'greet', body: 'Привет!' });
    const entries = await readdir(instanceSnippetsDir(dataDir));
    expect(entries).toEqual(['greet.md']);
  });
});
