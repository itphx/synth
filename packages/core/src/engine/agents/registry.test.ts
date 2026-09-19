import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry } from './index.js';
import { createToolRegistry } from '../tools/index.js';
import type { AgentDefinition } from '@itphx/synth-shared';

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

  it('unregister удаляет агента из реестра', async () => {
    await writeAgent('@bankassist', { contextFile: 'BANKASSIST.md' });

    const registry = createAgentRegistry(undefined, overridesDir);
    expect(registry.get('@bankassist')).toBeDefined();

    registry.unregister('@bankassist');
    expect(registry.get('@bankassist')).toBeUndefined();
    expect(registry.list().map((a) => a.id)).not.toContain('@bankassist');
  });

  it('agentMode нормализуется в массив при регистрации', async () => {
    const registry = createAgentRegistry(undefined, overridesDir);

    // title — системный (из дефиниции), assistant — основной по дефолту
    expect(registry.get('title')?.agentMode).toEqual(['system']);
    expect(registry.get('assistant')?.agentMode).toEqual(['primary']);
    expect(registry.get('general')?.agentMode).toEqual(['subagent']);
  });

  it('list({ mode }) фильтрует по классам агентов', async () => {
    const registry = createAgentRegistry(undefined, overridesDir);

    const primaryIds = registry.list({ mode: 'primary' }).map((a) => a.id);
    expect(primaryIds).toContain('assistant');
    expect(primaryIds).not.toContain('general');
    expect(primaryIds).not.toContain('title');

    const subagentIds = registry.list({ mode: 'subagent' }).map((a) => a.id);
    expect(subagentIds).toContain('general');
    expect(subagentIds).not.toContain('assistant');

    const systemIds = registry.list({ mode: 'system' }).map((a) => a.id);
    expect(systemIds).toContain('title');
    expect(systemIds).not.toContain('assistant');

    const allIds = registry.list({ mode: 'all' }).map((a) => a.id);
    expect(allIds).toContain('title');
    expect(allIds).toContain('assistant');
    expect(allIds).toContain('general');
  });
});

describe('AgentRegistry.getToolsForAgent (AD-070 §2.9)', () => {
  it('найденный агент получает ВСЕ тулы, без фильтра по capabilities', () => {
    const toolRegistry = createToolRegistry();
    const registry = createAgentRegistry(toolRegistry);

    const allNames = toolRegistry.toLLMFormat().map((t) => t.function.name).sort();
    const agentTools = registry.getToolsForAgent('assistant');

    expect(agentTools).toBeDefined();
    expect(agentTools!.map((t) => t.function.name).sort()).toEqual(allNames);
    // assistant без capability shell — но тул всё равно виден модели
    // (недоступность обеспечивает permission-слой: unavailable(role)).
    expect(allNames).toContain('execute_shell');
  });

  it('неизвестный агент → undefined', () => {
    const registry = createAgentRegistry(createToolRegistry());
    expect(registry.getToolsForAgent('no-such-agent')).toBeUndefined();
  });

  it('без ToolRegistry → undefined', () => {
    const registry = createAgentRegistry();
    expect(registry.getToolsForAgent('assistant')).toBeUndefined();
  });
});
