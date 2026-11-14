/**
 * PROP-126 §4: реестр сниппетов — приоритет уровней (`user > project > instance`),
 * каноническое имя важнее алиаса, диагностика `shadowed` и кэш по mtime/size.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnippetSources,
  instanceSnippetsDir,
  projectSnippetsDir,
  userSnippetsDir,
} from './discovery.js';
import { SnippetRegistry, mergeSnippetScans, resolveSnippet } from './registry.js';
import type { SnippetScanResult, SnippetSource } from './types.js';

let dataDir: string;
let workspace: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-snippets-reg-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-snippets-reg-ws-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function writeSnippet(dir: string, fileName: string, frontmatter: string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, fileName),
    ['---', ...frontmatter, '---', 'тело'].join('\n'),
    'utf-8',
  );
}

function makeRegistry(): SnippetRegistry {
  return new SnippetRegistry({
    sources: (o) =>
      buildSnippetSources({
        dataDir,
        userId: o?.userId,
        projectWorkspace: o?.projectWorkspace,
        trustedProjectDirs: [workspace],
      }),
  });
}

describe('mergeSnippetScans — приоритет уровней', () => {
  it('user > project > instance: побеждает верхний уровень, проигравший — shadowed', async () => {
    const userDir = userSnippetsDir(dataDir, 'u1');
    const projectDir = projectSnippetsDir(workspace);
    const instanceDir = instanceSnippetsDir(dataDir);

    await writeSnippet(userDir, 'dup.md', ['name: dup', 'description: user']);
    await writeSnippet(projectDir, 'dup.md', ['name: dup', 'description: project']);
    await writeSnippet(instanceDir, 'dup.md', ['name: dup', 'description: instance']);

    const registry = makeRegistry();
    const index = await registry.index({ userId: 'u1', projectWorkspace: workspace });

    expect(resolveSnippet(index, 'dup')?.scope).toBe('user');
    expect(resolveSnippet(index, 'dup')?.description).toBe('user');
    const shadowed = index.diagnostics.filter((d) => d.code === 'shadowed');
    expect(shadowed.length).toBe(2);
    expect(shadowed.every((d) => d.snippet === 'dup')).toBe(true);
  });

  it('project перекрывает instance', async () => {
    await writeSnippet(projectSnippetsDir(workspace), 'x.md', ['name: x', 'description: project']);
    await writeSnippet(instanceSnippetsDir(dataDir), 'x.md', ['name: x', 'description: instance']);

    const index = await makeRegistry().index({ projectWorkspace: workspace });
    expect(resolveSnippet(index, 'x')?.scope).toBe('project');
  });

  it('недоверенный проектный сниппет виден, но не перекрывает доверенный', async () => {
    const registry = new SnippetRegistry({
      sources: (o) =>
        buildSnippetSources({
          dataDir,
          projectWorkspace: o?.projectWorkspace,
          trustedProjectDirs: [],
        }),
    });
    await writeSnippet(projectSnippetsDir(workspace), 'y.md', ['name: y']);
    await writeSnippet(instanceSnippetsDir(dataDir), 'y.md', ['name: y', 'description: instance']);

    const index = await registry.index({ projectWorkspace: workspace });
    expect(index.snippets.some((s) => s.scope === 'project' && !s.trusted)).toBe(true);
    expect(index.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
    // Доверенный instance-сниппет остаётся разрешимым.
    expect(resolveSnippet(index, 'y')?.scope).toBe('instance');
  });
});

describe('mergeSnippetScans — алиасы', () => {
  it('алиас не перекрывает каноническое имя', async () => {
    const userDir = userSnippetsDir(dataDir, 'u1');
    await writeSnippet(userDir, 'alpha.md', ['name: alpha', 'aliases:', '  - beta']);
    await writeSnippet(projectSnippetsDir(workspace), 'beta.md', ['name: beta']);

    const index = await makeRegistry().index({ userId: 'u1', projectWorkspace: workspace });
    // Канон важнее алиаса: по "beta" находится канонический сниппет проекта.
    expect(resolveSnippet(index, 'beta')?.scope).toBe('project');
    expect(resolveSnippet(index, 'alpha')?.scope).toBe('user');
    expect(index.diagnostics.some((d) => d.code === 'shadowed' && d.snippet === 'beta')).toBe(true);
  });

  it('алиасы разрешаются, если не конфликтуют', async () => {
    await writeSnippet(instanceSnippetsDir(dataDir), 'greet.md', [
      'name: greet',
      'aliases:',
      '  - hi',
      '  - hello',
    ]);
    const index = await makeRegistry().index();
    expect(resolveSnippet(index, 'hi')?.name).toBe('greet');
    expect(resolveSnippet(index, 'hello')?.name).toBe('greet');
  });

  it('коллизия алиасов — shadowed, побеждает первый (приоритет уровня)', async () => {
    await writeSnippet(userSnippetsDir(dataDir, 'u1'), 'a.md', ['name: a', 'aliases:', '  - shared']);
    await writeSnippet(projectSnippetsDir(workspace), 'b.md', ['name: b', 'aliases:', '  - shared']);

    const index = await makeRegistry().index({ userId: 'u1', projectWorkspace: workspace });
    expect(resolveSnippet(index, 'shared')?.name).toBe('a');
    expect(index.diagnostics.some((d) => d.code === 'shadowed' && d.snippet === 'shared')).toBe(true);
  });
});

describe('SnippetRegistry — кэш по mtime/size', () => {
  it('перечитывает каталог после изменения файла', async () => {
    const dir = instanceSnippetsDir(dataDir);
    await writeSnippet(dir, 'one.md', ['name: one']);

    const registry = makeRegistry();
    expect((await registry.index()).snippets.map((s) => s.name)).toEqual(['one']);

    await writeSnippet(dir, 'two.md', ['name: two']);
    registry.reload();
    expect((await registry.index()).snippets.map((s) => s.name)).toEqual(['one', 'two']);
  });

  it('reload() сбрасывает кэш', async () => {
    const dir = instanceSnippetsDir(dataDir);
    await mkdir(dir, { recursive: true });
    const registry = makeRegistry();
    expect((await registry.index()).snippets).toHaveLength(0);

    await writeSnippet(dir, 'new.md', ['name: new']);
    registry.reload();
    expect((await registry.index()).snippets.map((s) => s.name)).toEqual(['new']);
  });
});

describe('mergeSnippetScans — диагностика источников', () => {
  it('диагностики скана прокидываются в индекс', () => {
    const source: SnippetSource = { scope: 'instance', dir: '/tmp/x', trusted: true };
    const result: SnippetScanResult = {
      snippets: [],
      diagnostics: [
        { level: 'warning', code: 'read-error', message: 'не удалось прочитать', path: '/tmp/x/a.md' },
      ],
    };
    const index = mergeSnippetScans([{ source, result }]);
    expect(index.diagnostics.some((d) => d.code === 'read-error')).toBe(true);
  });
});
