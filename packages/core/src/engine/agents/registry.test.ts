import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry } from './index.js';
import type { AgentDefinition } from '@synth/shared';

describe('createAgentRegistry', () => {
  let overridesDir: string;

  beforeEach(async () => {
    overridesDir = await mkdtemp(join(tmpdir(), 'synth-agents-'));
  });

  afterEach(async () => {
    await rm(overridesDir, { recursive: true, force: true });
  });

  function writeAgent(id: string, extra: Partial<AgentDefinition> = {}) {
    const agent: AgentDefinition = {
      id,
      displayName: id,
      capabilities: [],
      enabled: true,
      sshKeys: [],
      isOverridden: true,
      ...extra,
    };
    return writeFile(join(overridesDir, `${id}.json`), JSON.stringify(agent), 'utf-8');
  }

  it('регистрирует custom-агентов из overridesDir (id вне системных)', async () => {
    await writeAgent('@bankassist', { displayName: 'Банковский ассистент', contextFile: 'BANKASSIST.md' });

    const registry = createAgentRegistry(undefined, overridesDir);
    const agent = registry.get('@bankassist');

    expect(agent).toBeDefined();
    expect(agent!.displayName).toBe('Банковский ассистент');
    expect(agent!.contextFile).toBe('BANKASSIST.md');
    expect(agent!.isOverridden).toBe(true);
  });

  it('custom-агенты появляются в списке', async () => {
    await writeAgent('@bankassist', { contextFile: 'BANKASSIST.md' });

    const registry = createAgentRegistry(undefined, overridesDir);
    const ids = registry.list().map((a) => a.id);

    expect(ids).toContain('@bankassist');
  });

  it('системные агенты продолжают регистрироваться', async () => {
    const registry = createAgentRegistry(undefined, overridesDir);

    const assistant = registry.get('assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.contextFile).toBe('ASSISTANT.md');
  });

  it('custom-файл с id системного агента не перетирает системную дефиницию, а мержится', async () => {
    await writeAgent('assistant', { contextFile: 'CUSTOM.md', capabilities: [] });

    const registry = createAgentRegistry(undefined, overridesDir);
    const assistant = registry.get('assistant');

    expect(assistant).toBeDefined();
    expect(assistant!.contextFile).toBe('CUSTOM.md');
    expect(assistant!.isOverridden).toBe(true);
    // системные поля сохраняются после merge
    expect(assistant!.icon).toBeDefined();
  });

  it('корректно работает без overridesDir', async () => {
    const registry = createAgentRegistry(undefined);
    expect(registry.get('assistant')).toBeDefined();
    expect(registry.get('@bankassist')).toBeUndefined();
  });

  it('не падает на невалидном JSON в overridesDir', async () => {
    await writeFile(join(overridesDir, 'broken.json'), '{ not json', 'utf-8');

    const registry = createAgentRegistry(undefined, overridesDir);
    expect(registry.get('assistant')).toBeDefined();
  });
});
