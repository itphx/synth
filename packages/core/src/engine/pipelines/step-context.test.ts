/**
 * Тесты контекста шага пайплайна (ADR-101 §10, Э4.1).
 *
 * Проверяются: сбор проектной части (рабочий каталог, инструкции, тулы),
 * fail-soft поведение без проекта, гейт `workspace` (ADR-075), режим
 * пайплайна и capabilities агента (ADR-070 §2.9.1) и проектный MCP-скоуп
 * (ADR-071). Без LLM, без сети и без записи в хранилище.
 */
import { describe, it, expect } from 'vitest';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  AgentDefinition,
  PipelineNode,
  PipelineRunTrigger,
  PipelineSpec,
  Project,
  ToolDefinition,
} from '@itphx/synth-shared';

import { computeToolAvailability } from '../permission/availability.js';
import { buildPipelineStepContext, type PipelineStepContextDeps } from './step-context.js';
import type { StepExecutionContext } from './types.js';

// --- Заготовки данных ---

const trigger: PipelineRunTrigger = { kind: 'manual', payload: { issue: 'что-то сломалось' } };

function makeSpec(overrides: Partial<PipelineSpec> = {}): PipelineSpec {
  return {
    id: 'p1',
    name: 'Тестовый пайплайн',
    version: 1,
    status: 'published',
    mode: 'act',
    nodes: [{ id: 'step1', kind: 'agent', agent: 'implementer' }],
    exits: [{ kind: 'none' }],
    ...overrides,
  };
}

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'step1', kind: 'agent', agent: 'implementer', ...overrides };
}

function makeCtx(overrides: Partial<StepExecutionContext> = {}): StepExecutionContext {
  const spec = overrides.spec ?? makeSpec();
  return {
    runId: 'prun_1',
    pipelineId: 'p1',
    version: spec.version,
    node: overrides.node ?? spec.nodes[0]!,
    spec,
    trigger,
    input: {},
    vars: {},
    signal: new AbortController().signal,
    attempt: 1,
    mode: spec.mode,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Проект',
    ownerId: 'u1',
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Project;
}

function makeTool(name: string, capabilities: string[]): ToolDefinition {
  return {
    name,
    description: name,
    capabilities,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: '' }),
  } as unknown as ToolDefinition;
}

const READ_FILE = makeTool('read_file', [ToolCapability.FILE_READ]);
const WRITE_FILE = makeTool('write_file', [ToolCapability.FILE_WRITE]);
const EXECUTE_SHELL = makeTool('execute_shell', [ToolCapability.SHELL]);
const GIT_STATUS = makeTool('git_status', [ToolCapability.GIT_READ]);
const WEB_FETCH = makeTool('web_fetch', [ToolCapability.WEB]);

const MCP_TOOL = {
  ...makeTool('github_create_issue', [ToolCapability.MCP]),
  source: 'mcp',
  mcpServer: 'github',
} as ToolDefinition;

/** Реестр инструментов: встроенные + MCP выбранных серверов. */
function makeToolRegistry(
  builtin: ToolDefinition[] = [READ_FILE, WRITE_FILE, EXECUTE_SHELL, GIT_STATUS, WEB_FETCH],
  mcp: ToolDefinition[] = [MCP_TOOL],
) {
  return {
    listBuiltin: () => builtin,
    listMcp: (serverNames: Iterable<string>) => {
      const allowed = new Set(serverNames);
      return mcp.filter((tool) => tool.mcpServer != null && allowed.has(tool.mcpServer));
    },
  };
}

/** Менеджер MCP: состав серверов, происхождение и системный мастер-флаг. */
function makeMcpManager(
  servers: string[],
  opts: { origin?: 'instance' | 'user'; systemEnabled?: Record<string, boolean> } = {},
) {
  return {
    getConfig: () => Object.fromEntries(servers.map((name) => [name, {}])),
    getServerOrigin: () => opts.origin ?? 'instance',
    isServerSystemEnabled: (name: string) => opts.systemEnabled?.[name] ?? true,
  };
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'implementer',
    displayName: 'Исполнитель',
    capabilities: [ToolCapability.FILE_READ, ToolCapability.FILE_WRITE],
    enabled: true,
    isOverridden: false,
    ...overrides,
  } as AgentDefinition;
}

// --- Тесты ---

describe('buildPipelineStepContext (ADR-101 §10)', () => {
  it('проект есть → workspace, инструкции и тулы собраны', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: '/ws/proj' }) },
      toolRegistry: makeToolRegistry(),
      mcpManager: makeMcpManager(['github']),
      instructionsResolver: {
        resolve: async () => ({
          content: '[PROJECT INSTRUCTIONS]\nправило\n[END PROJECT INSTRUCTIONS]',
          files: [
            {
              path: 'AGENTS.md',
              kind: 'chain' as const,
              chars: 10,
              truncated: false,
              blocked: false,
              scanned: true,
            },
          ],
          diagnostics: [],
        }),
      },
      agentRegistry: { get: () => makeAgent() },
      skillsCatalog: {
        buildCatalog: async () => ({
          stable: [
            {
              name: 'code-review',
              description: 'Ревью',
              scope: 'project' as const,
              level: 'project' as const,
              available: true,
            },
          ],
          session: [],
        }),
      },
    };

    const ctx = makeCtx({ projectId: 'proj-1' });
    const result = await buildPipelineStepContext(ctx, deps);

    expect(result.project?.id).toBe('proj-1');
    expect(result.projectId).toBe('proj-1');
    expect(result.workspace).toBe('/ws/proj');
    expect(result.workspaceReady).toBe(true);
    expect(result.agent?.id).toBe('implementer');
    expect(result.instructions?.content).toContain('PROJECT INSTRUCTIONS');
    expect(result.instructions?.provenance).toBe('AGENTS.md');
    expect(result.skillsCatalog?.stable.map((s) => s.name)).toEqual(['code-review']);
    // Встроенные тулы + MCP активных серверов.
    expect(result.tools.map((t) => t.name)).toEqual([
      'read_file',
      'write_file',
      'execute_shell',
      'git_status',
      'web_fetch',
      'github_create_issue',
    ]);
    expect(result.mcpServers).toEqual(['github']);
  });

  it('проекта нет → контекст без проектной части, без падения', async () => {
    const deps: PipelineStepContextDeps = {
      // Порт отдаёт null — проекта нет.
      projectStore: { load: async () => null },
      toolRegistry: makeToolRegistry(),
      mcpManager: makeMcpManager(['github']),
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-missing' }), deps);

    expect(result.project).toBeUndefined();
    expect(result.projectId).toBe('proj-missing');
    expect(result.workspace).toBeUndefined();
    expect(result.workspaceReady).toBe(false);
    expect(result.instructions).toBeUndefined();
    expect(result.skillsCatalog).toBeUndefined();
    // Тулы остаются, но file/shell/git — недоступны (нет рабочего каталога).
    expect(result.tools.length).toBeGreaterThan(0);
    const reasons = new Map(result.unavailableTools.map((t) => [t.name, t.reason]));
    expect(reasons.get('read_file')).toBe('workspace');
    expect(reasons.get('execute_shell')).toBe('workspace');
    expect(reasons.get('git_status')).toBe('workspace');
    // Веб-тул рабочему каталогу не нужен.
    expect(reasons.get('web_fetch')).toBeUndefined();
  });

  it('нет рабочего каталога → workspaceReady:false и file/shell/git помечены причиной workspace', async () => {
    const deps: PipelineStepContextDeps = {
      // Проект есть, но `workspace` не задан (ADR-075).
      projectStore: { load: async (id) => makeProject({ id }) },
      toolRegistry: makeToolRegistry(),
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-1' }), deps);

    expect(result.workspaceReady).toBe(false);
    expect(result.workspace).toBeUndefined();

    // Причина недоступности — та же, что у сессий (ADR-070 §2.9.1/ADR-075).
    for (const tool of [READ_FILE, WRITE_FILE, EXECUTE_SHELL, GIT_STATUS]) {
      expect(computeToolAvailability(tool.name, tool.capabilities, { workspaceReady: false })).toEqual({
        available: false,
        reason: 'workspace',
      });
    }
    const unavailable = new Map(result.unavailableTools.map((t) => [t.name, t.reason]));
    expect(unavailable.get('read_file')).toBe('workspace');
    expect(unavailable.get('write_file')).toBe('workspace');
    expect(unavailable.get('execute_shell')).toBe('workspace');
    expect(unavailable.get('git_status')).toBe('workspace');
    expect(result.availableTools.map((t) => t.name)).toEqual(['web_fetch']);
  });

  it('режим пайплайна попадает в контекст и учитывается в доступности тулов', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: '/ws' }) },
      toolRegistry: makeToolRegistry(),
    };

    const act = await buildPipelineStepContext(
      makeCtx({ mode: 'act', projectId: 'proj-1' }),
      deps,
    );
    expect(act.mode).toBe('act');
    // В режиме `act` write-тулы доступны.
    expect(act.availableTools.map((t) => t.name)).toContain('write_file');

    const plan = await buildPipelineStepContext(
      makeCtx({ mode: 'plan', projectId: 'proj-1' }),
      deps,
    );
    expect(plan.mode).toBe('plan');
    // В режиме `plan` write-тулы недоступны (ADR-025).
    expect(plan.availableTools.map((t) => t.name)).not.toContain('write_file');
    const reasons = new Map(plan.unavailableTools.map((t) => [t.name, t.reason]));
    expect(reasons.get('write_file')).toBe('mode');
  });

  it('capabilities агента ограничивают набор тулов (причина role)', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: '/ws' }) },
      toolRegistry: makeToolRegistry(),
      agentRegistry: {
        get: () => makeAgent({ capabilities: [ToolCapability.FILE_READ, ToolCapability.WEB] }),
      },
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-1' }), deps);

    // Тул без пересечения по capabilities недоступен агенту (ADR-070 §2.9.1).
    const reasons = new Map(result.unavailableTools.map((t) => [t.name, t.reason]));
    expect(reasons.get('write_file')).toBe('role');
    expect(reasons.get('execute_shell')).toBe('role');
    expect(reasons.get('git_status')).toBe('role');
    expect(result.availableTools.map((t) => t.name)).toEqual(['read_file', 'web_fetch']);
    // Список дефинишенов постоянен — тулы не выбрасываются, а помечаются.
    expect(result.tools.map((t) => t.name)).toContain('write_file');
  });

  it('агент узла (node.agent) задаёт capabilities для отбора тулов', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: '/ws' }) },
      toolRegistry: makeToolRegistry(),
      agentRegistry: {
        get: (id: string) =>
          makeAgent({
            id,
            capabilities:
              id === 'reviewer'
                ? [ToolCapability.FILE_READ]
                : [ToolCapability.FILE_READ, ToolCapability.FILE_WRITE],
          }),
      },
    };

    const result = await buildPipelineStepContext(
      // Проект обязателен: без рабочего каталога file/shell/git-тулы
      // недоступны с причиной `workspace` (ADR-075), и проверка capabilities
      // была бы не единственным различием.
      makeCtx({ node: makeNode({ agent: 'reviewer' }), projectId: 'proj-1' }),
      deps,
    );

    // Агент берётся из узла, а не из спецификации по умолчанию.
    expect(result.agent?.id).toBe('reviewer');
    // Рабочий каталог есть — гейт `workspace` не срабатывает.
    expect(result.workspaceReady).toBe(true);
    // Его capabilities ограничивают набор доступных тулов (ADR-070 §2.9.1).
    expect(result.availableTools.map((t) => t.name)).toEqual(['read_file']);
    const reasons = new Map(result.unavailableTools.map((t) => [t.name, t.reason]));
    expect(reasons.get('write_file')).toBe('role');
  });

  it('MCP-скоуп считается по системе и проекту (без сессионного снапшота)', async () => {
    const project = makeProject({
      id: 'proj-1',
      workspace: '/ws',
      // Проект разрешает серверы `github` и `gitlab`.
      mcp: { enabled: ['github', 'gitlab'], defaultOn: ['github'] },
    });
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async () => project },
      toolRegistry: makeToolRegistry(),
      mcpManager: makeMcpManager(['github', 'gitlab', 'slack'], {
        systemEnabled: { gitlab: false },
      }),
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-1' }), deps);

    const byName = new Map(result.mcpDecisions.map((d) => [d.name, d]));
    // Разрешён проектом и включён системно → доступен.
    expect(byName.get('github')?.enabled).toBe(true);
    // Проектом не разрешён → `project_disabled`.
    expect(byName.get('slack')?.enabled).toBe(false);
    expect(byName.get('slack')?.reason).toBe('project_disabled');
    // `gitlab` разрешён проектом, но системный мастер выключен → `system_disabled`.
    expect(byName.get('gitlab')?.enabled).toBe(false);
    expect(byName.get('gitlab')?.reason).toBe('system_disabled');
    // В шаг попадают только активные серверы проекта.
    expect(result.mcpServers).toEqual(['github']);
    expect(result.tools.map((t) => t.name)).toContain('github_create_issue');
  });

  it('проект без MCP-скоупа → системно-включённые серверы доступны (legacy)', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: '/ws' }) },
      toolRegistry: makeToolRegistry(),
      mcpManager: makeMcpManager(['github']),
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-1' }), deps);

    expect(result.mcpServers).toEqual(['github']);
    expect(result.mcpDecisions[0]?.enabled).toBe(true);
  });

  it('без зависимостей контекст пустой, но не падает', async () => {
    const result = await buildPipelineStepContext(makeCtx(), {});

    expect(result.project).toBeUndefined();
    expect(result.workspaceReady).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.availableTools).toEqual([]);
    expect(result.unavailableTools).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.mode).toBe('act');
  });

  it('относительный workspace резолвится от workspacesRoot', async () => {
    const deps: PipelineStepContextDeps = {
      projectStore: { load: async (id) => makeProject({ id, workspace: 'sub/dir' }) },
      workspacesRoot: '/root/workspaces',
    };

    const result = await buildPipelineStepContext(makeCtx({ projectId: 'proj-1' }), deps);

    expect(result.workspace).toBe('/root/workspaces/sub/dir');
    expect(result.workspaceReady).toBe(true);
  });
});
