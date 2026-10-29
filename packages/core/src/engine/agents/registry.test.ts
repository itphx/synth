import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentRegistry } from './index.js';
import { normalizeAgentModes } from './normalize.js';
import { createToolRegistry } from '../tools/index.js';
import { ToolCapability, type AgentDefinition, type ToolDefinition } from '@itphx/synth-shared';

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

describe('AgentRegistry — набор ролей (leader/fixer/tester/researcher/security-auditor)', () => {
  const registry = createAgentRegistry();

  /**
   * Удалённый набор ролей: у старых сессий в `settings.agentRole` может остаться id.
   * В реестре его нет, но оркестратор резолвит алиас (`LEGACY_AGENT_ROLE_ALIASES`:
   * `pm` → `leader` и т.д.) — см. `orchestrator-unknown-role.test.ts`.
   */
  it.each(['pm', 'developer', 'qa', 'analyst', 'auditor', 'reviewer', 'no-such-role'])(
    'агента %s больше нет в реестре',
    (id) => {
      expect(registry.get(id)).toBeUndefined();
    },
  );

  it('assistant сохранён', () => {
    expect(registry.get('assistant')).toBeDefined();
    expect(registry.get('assistant')!.agentMode).toEqual(['primary']);
    // Универсальный агент: запись файлов и git есть — shell тоже нужен
    expect(registry.get('assistant')!.capabilities).toContain(ToolCapability.SHELL);
    // capability `user` (`profile_update`) — сабагенту не отдаём
    expect(registry.getSubagents().map((a) => a.id)).not.toContain('assistant');
  });

  it.each([
    ['leader', ['primary'], 200],
    ['fixer', ['primary', 'subagent'], 100],
    ['tester', ['primary', 'subagent'], 100],
    ['researcher', ['primary', 'subagent'], 25],
    ['security-auditor', ['primary', 'subagent'], 60],
    ['devops', ['primary', 'subagent'], 100],
    ['admin', ['primary', 'subagent'], 100],
  ] as const)('%s есть в реестре, agentMode нормализован, maxSteps=%d', (id, modes, maxSteps) => {
    const agent = registry.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    // agentMode всегда массив (даже если в определении строка/одно значение)
    expect(Array.isArray(agent!.agentMode)).toBe(true);
    expect(agent!.agentMode).toEqual([...modes]);
    expect(agent!.maxSteps).toBe(maxSteps);
    expect(agent!.contextFile).toBe(`${id.toUpperCase()}.md`);
  });

  it('leader — только primary (это оркестратор, а не сабагент)', () => {
    const leader = registry.get('leader')!;
    expect(normalizeAgentModes(leader.agentMode)).toEqual(['primary']);
    expect(registry.getSubagents().map((a) => a.id)).not.toContain('leader');
  });

  it('leader: отображаемое имя — «Лидер» (не «Оркестратор»: оркестратор — архитектурный слой)', () => {
    const leader = registry.get('leader')!;
    expect(leader.displayName).toBe('Лидер');
    // Слово не должно вернуться ни в имя, ни в описание роли
    expect(leader.description ?? '').not.toContain('Оркестратор');
    // Формулировка роли: лидер команды разработки (не абстрактное «лидерство»)
    expect(leader.description ?? '').toContain('команды разработки');
  });

  it.each(['fixer', 'tester', 'researcher', 'security-auditor', 'devops', 'admin'])(
    '%s доступен как сабагент',
    (id) => {
      expect(registry.getSubagents().map((a) => a.id)).toContain(id);
    },
  );

  it('admin/devops: primary+subagent и maxSteps 100 (делегирование инфраструктуры)', () => {
    for (const id of ['admin', 'devops']) {
      const agent = registry.get(id)!;
      expect(agent.agentMode).toEqual(['primary', 'subagent']);
      expect(agent.maxSteps).toBe(100);
      expect(registry.list({ mode: 'primary' }).map((a) => a.id)).toContain(id);
      expect(registry.getSubagents().map((a) => a.id)).toContain(id);
    }
  });

  it('leader: все capability, кроме user (profile_update)', () => {
    const caps = registry.get('leader')!.capabilities;
    const all = Object.values(ToolCapability);
    expect(new Set(caps)).toEqual(new Set(all.filter((c) => c !== ToolCapability.USER)));
  });

  it('tester без web (промпт запрещает сеть)', () => {
    const caps = registry.get('tester')!.capabilities;
    expect(caps).not.toContain(ToolCapability.WEB);
  });

  it('researcher без shell и web (read-only)', () => {
    const caps = registry.get('researcher')!.capabilities;
    expect(caps).not.toContain(ToolCapability.SHELL);
    expect(caps).not.toContain(ToolCapability.WEB);
  });

  /**
   * Температура встроенных агентов — значения из кастомных агентов OpenCode
   * (`~/dev/harness/agents/*.md`). `undefined` — «Auto»: поле `temperature`
   * в LLM-запрос не отправляется, используется дефолт модели.
   */
  it.each([
    ['leader', 0.15],
    ['fixer', 0.2],
    ['researcher', 0.2],
    ['admin', 0.1],
    ['devops', 0.1],
    ['tester', 0.1],
    ['security-auditor', 0.1],
    ['title', 0.3],
  ] as const)('%s: temperature=%d из определения', (id, temperature) => {
    expect(registry.get(id)?.temperature).toBe(temperature);
  });

  it.each(['assistant', 'general', 'explore'])('%s: температура не задана (Auto)', (id) => {
    const agent = registry.get(id);
    expect(agent).toBeDefined();
    expect(agent!.temperature).toBeUndefined();
  });
});

describe('AgentRegistry.getToolsForAgent (ADR-070 §2.9)', () => {
  it('найденный агент получает ВСЕ тулы, без фильтра по capabilities', () => {
    const toolRegistry = createToolRegistry();
    const registry = createAgentRegistry(toolRegistry);

    const allNames = toolRegistry.toLLMFormat().map((t) => t.function.name).sort();
    const agentTools = registry.getToolsForAgent('assistant');

    expect(agentTools).toBeDefined();
    expect(agentTools!.map((t) => t.function.name).sort()).toEqual(allNames);
    // assistant с capability shell — тул виден модели
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

  it('ADR-071 §2.1: MCP-тулы — только активных серверов (per-session)', () => {
    const toolRegistry = createToolRegistry();
    const mcpTool = (server: string, name: string): ToolDefinition => ({
      name: `${server}_${name}`,
      description: 'mcp',
      parameters: z.object({}),
      capabilities: [ToolCapability.MCP],
      source: 'mcp',
      mcpServer: server,
      execute: async () => ({ content: '' }),
    });
    toolRegistry.registerAll([mcpTool('srvA', 'search'), mcpTool('srvB', 'fetch')]);
    const registry = createAgentRegistry(toolRegistry);

    // Без активных серверов MCP-слой пуст (builtin-only).
    const noMcp = registry.getToolsForAgent('assistant')!.map((t) => t.function.name);
    expect(noMcp).not.toContain('srvA_search');
    expect(noMcp).not.toContain('srvB_fetch');

    const sessionA = registry.getToolsForAgent('assistant', ['srvA'])!.map((t) => t.function.name);
    expect(sessionA).toContain('srvA_search');
    expect(sessionA).not.toContain('srvB_fetch');

    const sessionB = registry.getToolsForAgent('assistant', ['srvB'])!.map((t) => t.function.name);
    expect(sessionB).toContain('srvB_fetch');
    expect(sessionB).not.toContain('srvA_search');
  });
});
