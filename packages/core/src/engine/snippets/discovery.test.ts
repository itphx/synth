/**
 * ADR-126 §4: discovery сниппетов — три уровня (`instance` / `project` / `user`),
 * приоритет `user > project > instance`, project-trust гейт и разбор frontmatter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnippetSources,
  instanceSnippetsDir,
  parseSnippetFile,
  projectSnippetsDir,
  scanSnippetSource,
  userSnippetsDir,
  PROJECT_SNIPPETS_DIR,
} from './discovery.js';
import type { SnippetSource } from './types.js';

let dataDir: string;
let workspace: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-snippets-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-snippets-ws-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function writeSnippet(
  dir: string,
  fileName: string,
  frontmatter: string[],
  body = 'тело сниппета',
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, fileName);
  await writeFile(file, ['---', ...frontmatter, '---', body].join('\n'), 'utf-8');
  return file;
}

describe('buildSnippetSources — уровни и приоритет (ADR-126 §4)', () => {
  it('порядок источников: user > project > instance', () => {
    const sources = buildSnippetSources({
      dataDir,
      userId: 'u1',
      projectWorkspace: workspace,
    });
    expect(sources.map((s) => s.scope)).toEqual(['user', 'project', 'instance']);
  });

  it('без пользователя и проекта остаётся только instance', () => {
    const sources = buildSnippetSources({ dataDir });
    expect(sources.map((s) => s.scope)).toEqual(['instance']);
    expect(sources[0]!.dir).toBe(instanceSnippetsDir(dataDir));
  });

  it('пути уровней: instance / user / project', () => {
    const sources = buildSnippetSources({
      dataDir,
      userId: 'u1',
      projectWorkspace: workspace,
    });
    expect(sources[0]!.dir).toBe(userSnippetsDir(dataDir, 'u1'));
    expect(sources[1]!.dir).toBe(join(workspace, PROJECT_SNIPPETS_DIR));
    expect(sources[1]!.dir).toBe(projectSnippetsDir(workspace));
  });

  it('project-trust: недоверенный проект помечается trusted:false', () => {
    const untrusted = buildSnippetSources({ dataDir, projectWorkspace: workspace });
    expect(untrusted[0]!.trusted).toBe(false);

    const trusted = buildSnippetSources({
      dataDir,
      projectWorkspace: workspace,
      trustedProjectDirs: [workspace],
    });
    expect(trusted[0]!.trusted).toBe(true);
  });
});

describe('scanSnippetSource — чтение файлов', () => {
  it('читает *.md и пропускает отсутствующий каталог', async () => {
    const dir = instanceSnippetsDir(dataDir);
    await writeSnippet(dir, 'one.md', ['name: one', 'description: Первый']);

    const source: SnippetSource = { scope: 'instance', dir, trusted: true };
    const res = await scanSnippetSource(source);
    expect(res.snippets.map((s) => s.name)).toEqual(['one']);
    expect(res.snippets[0]!.description).toBe('Первый');
    expect(res.snippets[0]!.scope).toBe('instance');
    expect(res.snippets[0]!.trusted).toBe(true);
    expect(res.snippets[0]!.body).toBe('тело сниппета');

    const missing = await scanSnippetSource({ scope: 'instance', dir: join(dataDir, 'nope'), trusted: true });
    expect(missing.snippets).toEqual([]);
    expect(missing.diagnostics).toEqual([]);
  });

  it('пропускает не-`.md` файлы и подкаталоги', async () => {
    const dir = instanceSnippetsDir(dataDir);
    await mkdir(join(dir, 'users'), { recursive: true });
    await writeFile(join(dir, 'note.txt'), 'не сниппет', 'utf-8');
    await writeSnippet(dir, 'ok.md', ['name: ok']);

    const res = await scanSnippetSource({ scope: 'instance', dir, trusted: true });
    expect(res.snippets.map((s) => s.name)).toEqual(['ok']);
  });

  it('trust источника проставляется в сниппет', async () => {
    const dir = projectSnippetsDir(workspace);
    await writeSnippet(dir, 'p.md', ['name: p']);
    const res = await scanSnippetSource({ scope: 'project', dir, trusted: false });
    expect(res.snippets[0]!.trusted).toBe(false);
  });
});

describe('parseSnippetFile — frontmatter (ADR-126 §4 «Формат»)', () => {
  const source: SnippetSource = { scope: 'instance', dir: '/tmp/x', trusted: true };

  it('имя берётся из frontmatter, алиасы — списком', () => {
    const parsed = parseSnippetFile(
      ['---', 'name: greet', 'description: Приветствие', 'aliases:', '  - hi', '  - hello', '---', 'Привет!'].join('\n'),
      'greet.md',
      source,
      '/tmp/x/greet.md',
    );
    expect(parsed.snippet?.name).toBe('greet');
    expect(parsed.snippet?.aliases).toEqual(['hi', 'hello']);
    expect(parsed.snippet?.body).toBe('Привет!');
    expect(parsed.diagnostics).toEqual([]);
  });

  it('без frontmatter имя берётся из файла, тело — весь документ', () => {
    const parsed = parseSnippetFile('просто текст', 'plain.md', source, '/tmp/x/plain.md');
    expect(parsed.snippet?.name).toBe('plain');
    expect(parsed.snippet?.body).toBe('просто текст');
    expect(parsed.snippet?.aliases).toEqual([]);
  });

  it('битый YAML — диагностика invalid-frontmatter, сниппет не создаётся', () => {
    const parsed = parseSnippetFile(
      ['---', 'name: [broken', '---', 'body'].join('\n'),
      'broken.md',
      source,
      '/tmp/x/broken.md',
    );
    expect(parsed.snippet).toBeUndefined();
    expect(parsed.diagnostics.some((d) => d.code === 'invalid-frontmatter')).toBe(true);
  });

  it('недопустимое имя отбрасывается', () => {
    const parsed = parseSnippetFile(
      ['---', 'name: Плохое Имя', '---', 'body'].join('\n'),
      'bad.md',
      source,
      '/tmp/x/bad.md',
    );
    expect(parsed.snippet).toBeUndefined();
    expect(parsed.diagnostics.some((d) => d.code === 'invalid-frontmatter')).toBe(true);
  });

  it('недопустимый алиас отбрасывается, валидные остаются', () => {
    const parsed = parseSnippetFile(
      ['---', 'name: x', 'aliases:', '  - ok', '  - "Плохое"', '---', 'body'].join('\n'),
      'x.md',
      source,
      '/tmp/x/x.md',
    );
    expect(parsed.snippet?.aliases).toEqual(['ok']);
    expect(parsed.diagnostics.some((d) => d.code === 'invalid-frontmatter')).toBe(true);
  });
});
