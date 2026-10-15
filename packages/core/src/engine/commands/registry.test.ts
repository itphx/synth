import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from './registry.js';
import type { CommandSource } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-cmd-registry-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCommand(dir: string, name: string, description = 'desc') {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.md`),
    ['---', `name: ${name}`, `description: ${description}`, '---', 'body'].join('\n'),
    'utf-8',
  );
}

describe('CommandRegistry — trust в кэше (ADR-046 §4.4/§8.3)', () => {
  it('пере-сканирует при смене trust источника без изменения каталога', async () => {
    const dir = join(root, 'proj');
    await writeCommand(dir, 'p');

    let trusted = false;
    const sources = (): CommandSource[] => [{ origin: 'project', dir, trusted }];
    const registry = new CommandRegistry({ sources });

    expect((await registry.list()).commands[0]!.trusted).toBe(false);

    // Каталог не менялся (signature та же) — кэш должен инвалидироваться по trust.
    trusted = true;
    expect((await registry.list()).commands[0]!.trusted).toBe(true);

    trusted = false;
    expect((await registry.list()).commands[0]!.trusted).toBe(false);
  });

  it('reload() сбрасывает кэш', async () => {
    const dir = join(root, 'inst');
    await mkdir(dir, { recursive: true });
    const registry = new CommandRegistry({
      sources: () => [{ origin: 'instance', dir, trusted: true }],
    });
    expect((await registry.list()).commands).toHaveLength(0);

    await writeCommand(dir, 'new-one');
    registry.reload();
    expect((await registry.list()).commands.map((c) => c.name)).toEqual(['new-one']);
  });
});
