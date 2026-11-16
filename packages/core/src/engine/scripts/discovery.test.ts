import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildScriptSources,
  listUndeclaredExecutables,
  mergeScriptScans,
  scanScriptSource,
  PROJECT_SCRIPTS_DIR,
} from './discovery.js';
import type { ScriptSource } from './types.js';

/**
 * ADR-126 §5: discovery реестра скриптов.
 *
 * Проверяется:
 *   • приоритет источников `project > instance > config`;
 *   • project-trust (недоверенный каталог виден, но недоверенный);
 *   • `shadowed` при одноимённых скриптах;
 *   • отсутствие каталога — не ошибка;
 *   • необъявленные исполняемые файлы (`listUndeclaredExecutables`).
 */

let dataDir: string;
let workspace: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-scripts-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-scripts-ws-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function writeScript(root: string, name: string, description = 'Описание'): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, `${name}.md`);
  await writeFile(file, ['---', `description: ${description}`, 'run: ./run.sh', '---', 'тело'].join('\n'), 'utf-8');
  return file;
}

describe('buildScriptSources — приоритет источников', () => {
  it('project > instance > config', () => {
    const sources = buildScriptSources({
      dataDir, projectWorkspace: workspace, configPaths: ['/cfg/scripts'],
    });
    expect(sources.map((s) => s.origin)).toEqual(['project', 'instance', 'config']);
    expect(sources[0]!.dir).toBe(join(workspace, PROJECT_SCRIPTS_DIR));
    expect(sources[1]!.dir).toBe(join(dataDir, 'scripts'));
  });

  it('без workspace источников проекта нет', () => {
    const sources = buildScriptSources({ dataDir, configPaths: ['/cfg/scripts'] });
    expect(sources.map((s) => s.origin)).toEqual(['instance', 'config']);
  });

  it('project-trust из trustedProjectDirs; instance/config — доверены', () => {
    const trusted = buildScriptSources({
      dataDir, projectWorkspace: workspace, trustedProjectDirs: [workspace],
    });
    expect(trusted[0]!.trusted).toBe(true);
    expect(trusted[1]!.trusted).toBe(true);

    const untrusted = buildScriptSources({
      dataDir, projectWorkspace: workspace, trustedProjectDirs: [],
    });
    expect(untrusted[0]!.trusted).toBe(false);
    expect(untrusted[1]!.trusted).toBe(true);
  });
});

describe('scanScriptSource — чтение деклараций', () => {
  it('читает *.md и подставляет trust источника', async () => {
    await writeScript(join(dataDir, 'scripts'), 'dev');
    const trusted = await scanScriptSource({ origin: 'instance', dir: join(dataDir, 'scripts') });
    expect(trusted.scripts.map((s) => s.name)).toEqual(['dev']);
    expect(trusted.scripts[0]!.trusted).toBe(true);

    const untrusted = await scanScriptSource({
      origin: 'project', dir: join(dataDir, 'scripts'), trusted: false,
    });
    expect(untrusted.scripts[0]!.trusted).toBe(false);
  });

  it('отсутствие каталога — не ошибка', async () => {
    const res = await scanScriptSource({ origin: 'instance', dir: join(dataDir, 'nope') });
    expect(res.scripts).toEqual([]);
    expect(res.diagnostics).toEqual([]);
  });
});

describe('mergeScriptScans — дедупликация', () => {
  it('first-wins по имени, проигравший — shadowed', async () => {
    const project: ScriptSource = { origin: 'project', dir: join(workspace, 'p') };
    const instance: ScriptSource = { origin: 'instance', dir: join(dataDir, 'i') };
    await writeScript(project.dir, 'dup', 'из проекта');
    await writeScript(instance.dir, 'dup', 'из инстанса');

    const merged = mergeScriptScans([
      { source: project, result: await scanScriptSource(project) },
      { source: instance, result: await scanScriptSource(instance) },
    ]);

    expect(merged.scripts).toHaveLength(1);
    expect(merged.scripts[0]!.description).toBe('из проекта');
    expect(merged.diagnostics.some((d) => d.code === 'shadowed')).toBe(true);
  });

  it('недоверенный скрипт остаётся в реестре, но с диагностикой untrusted', async () => {
    const project: ScriptSource = { origin: 'project', dir: join(workspace, 'p'), trusted: false };
    await writeScript(project.dir, 'dev');

    const merged = mergeScriptScans([{ source: project, result: await scanScriptSource(project) }]);

    expect(merged.scripts).toHaveLength(1);
    expect(merged.scripts[0]!.trusted).toBe(false);
    expect(merged.diagnostics.some((d) => d.code === 'untrusted' && d.script === 'dev')).toBe(true);
  });
});

describe('listUndeclaredExecutables — исполняемые файлы без декларации', () => {
  it('находит исполняемый файл без декларации и не трогает объявленный', async () => {
    const scriptsDir = join(workspace, 'scripts');
    await mkdir(scriptsDir, { recursive: true });

    const declared = join(scriptsDir, 'dev.sh');
    await writeFile(declared, '#!/bin/sh\n', 'utf-8');
    await chmod(declared, 0o755);

    const undeclared = join(scriptsDir, 'release.sh');
    await writeFile(undeclared, '#!/bin/sh\n', 'utf-8');
    await chmod(undeclared, 0o755);

    const notExecutable = join(scriptsDir, 'notes.txt');
    await writeFile(notExecutable, 'просто текст', 'utf-8');

    // Декларация с именем `dev` покрывает `dev.sh`.
    await writeScript(join(workspace, PROJECT_SCRIPTS_DIR), 'dev');

    const found = await listUndeclaredExecutables(workspace);

    expect(found).toEqual(['scripts/release.sh']);
  });

  it('пустой проект — пустой список, каталоги не создаются', async () => {
    const found = await listUndeclaredExecutables(workspace);
    expect(found).toEqual([]);
  });

  it('ошибка чтения игнорируется (каталога нет)', async () => {
    const found = await listUndeclaredExecutables(join(workspace, 'нет-такого'));
    expect(found).toEqual([]);
  });
});
