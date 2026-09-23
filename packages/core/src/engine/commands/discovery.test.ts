import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCommandSources,
  mergeCommandScans,
  scanCommandSource,
  PROJECT_COMMANDS_DIR,
} from './discovery.js';
import type { CommandSource } from './types.js';

let dataDir: string;
let workspace: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-cmd-disc-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-cmd-disc-ws-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function writeCommand(root: string, name: string, description: string, body = 'body') {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${name}.md`),
    ['---', `name: ${name}`, `description: ${description}`, '---', body].join('\n'),
    'utf-8',
  );
}

describe('discovery шаблонных команд (AD-046 §7.1)', () => {
  it('buildCommandSources: приоритет project > instance > config', () => {
    const sources = buildCommandSources({
      dataDir, projectWorkspace: workspace, configPaths: ['/cfg/cmds'],
    });
    expect(sources.map((s) => s.origin)).toEqual(['project', 'instance', 'config']);
    expect(sources[0]!.dir).toBe(join(workspace, PROJECT_COMMANDS_DIR));
  });

  it('scanCommandSource читает *.md и пропускает отсутствующий каталог', async () => {
    await writeCommand(join(dataDir, 'commands'), 'one', 'Первая');
    const res = await scanCommandSource({ origin: 'instance', dir: join(dataDir, 'commands') });
    expect(res.commands.map((c) => c.name)).toEqual(['one']);
    const missing = await scanCommandSource({ origin: 'instance', dir: join(dataDir, 'nope') });
    expect(missing.commands).toEqual([]);
  });

  it('mergeCommandScans: first-wins + shadowed-диагностика', async () => {
    const a: CommandSource = { origin: 'project', dir: join(workspace, 'a') };
    const b: CommandSource = { origin: 'instance', dir: join(dataDir, 'b') };
    await writeCommand(a.dir, 'dup', 'из проекта');
    await writeCommand(b.dir, 'dup', 'из instance');
    const [ra, rb] = await Promise.all([scanCommandSource(a), scanCommandSource(b)]);
    const merged = mergeCommandScans([{ source: a, result: ra }, { source: b, result: rb }]);
    expect(merged.commands).toHaveLength(1);
    expect(merged.commands[0]!.description).toBe('из проекта');
    expect(merged.diagnostics.some((d) => d.code === 'shadowed')).toBe(true);
  });
});
