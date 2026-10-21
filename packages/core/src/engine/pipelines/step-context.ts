/**
 * ADR-101 (Pipeline Engine): контекст шага пайплайна.
 *
 * Шаг пайплайна — **не сессия** (ADR-101 §1), но он работает в том же окружении:
 * проект (ADR-014), рабочий каталог (ADR-075), режим пайплайна (ADR-025),
 * инструменты (ADR-070/ADR-071), проектные инструкции (ADR-069) и скиллы
 * (ADR-046). Этот модуль **собирает** всё это из спецификации/прогона и
 * проекта — без HTTP, без сессий и без очереди: только порты слоя хранения
 * (ADR-096) и инъектированные зависимости.
 *
 * ## Что собирается
 *
 * | Часть | Источник | Правило |
 * |---|---|---|
 * | Проект | `spec.projectId` / `ctx.projectId` → порт проектов | проекта может не быть — шаг работает без проектного контекста |
 * | Рабочий каталог | `project.workspace` (ADR-075) | каталог **не создаётся молча**; нет workspace → `workspaceReady: false` |
 * | Режим | `spec.mode` (`plan`/`act`/`yolo`) | режим permission-слоя (ADR-025), не `sessionMode` сессии |
 * | Инструменты | `ToolRegistry` (встроенные) + MCP-тулы проекта | доступность — общий `computeToolAvailability` (ADR-070 §2.9.1) |
 * | MCP-скоуп | система + проект (ADR-071) | без сессионного снапшота — `resolveMcpProjectScope` |
 * | Инструкции | резолвер ADR-069 | резолвятся от имени проекта; без проекта — пусто |
 * | Скиллы | каталог ADR-046 | уровень system/project (сессионного слоя нет) |
 * | Агент шага | `node.agent` → `AgentRegistry` | его `capabilities` участвуют в отборе тулов |
 *
 * ## Отсутствие проекта/рабочего каталога
 *
 * Ошибкой это **не считается**: шаг без проекта идёт без проектного контекста
 * (`project: undefined`, `workspaceReady: false`), а file/shell/git-тулы
 * помечаются недоступными с причиной `workspace` — ровно тем же механизмом,
 * что и у сессий (ADR-075, `engine/permission/availability.ts`).
 */

import { isAbsolute, normalize, resolve } from 'node:path';

import type {
  AgentDefinition,
  McpRegistryOrigin,
  PipelineMode,
  Project,
  ToolDefinition,
} from '@itphx/synth-shared';

import type { ComposerInstructions } from '../context/composer.js';
import type { ProjectInstructionsResolveArgs, ProjectInstructionsResult } from '../context/instructions.js';
import type { UnavailableTool } from '../context/state-messages.js';
import { resolveMcpProjectScope, type McpScopeDecision } from '../mcp/scope.js';
import { computeToolAvailability } from '../permission/availability.js';
import type { ComposerSkillsCatalog } from '../skills/catalog.js';
import type { SkillCatalogOptions } from '../skills/types.js';
import { RUNTIME_DEP_BINARY, TOOL_RUNTIME_DEP, type RuntimeDeps } from '../tools/runtime-deps.js';
import type { StepExecutionContext } from './types.js';

/** Порт загрузки проекта (ADR-096) — минимальный контракт для контекста шага. */
export interface PipelineProjectStoreLike {
  load(id: string): Promise<Project | null>;
}

/** Минимальный контракт реестра инструментов (ADR-071) для контекста шага. */
export interface PipelineToolRegistryLike {
  /** Встроенные инструменты (слой `tools`). */
  listBuiltin(): ToolDefinition[];
  /** MCP-инструменты указанных серверов (per-scope выборка). */
  listMcp(serverNames: Iterable<string>): ToolDefinition[];
}

/** Минимальный контракт менеджера MCP (ADR-071) для контекста шага. */
export interface PipelineMcpManagerLike {
  /** Имена настроенных серверов. */
  getConfig(): Record<string, unknown>;
  /** Происхождение записи реестра (`instance` — системный уровень). */
  getServerOrigin(name: string): McpRegistryOrigin;
  /** Системный мастер-флаг записи реестра (`McpRegistryEntry.enabled`). */
  isServerSystemEnabled(name: string): boolean;
}

/** Минимальный контракт резолвера проектных инструкций (ADR-069). */
export interface PipelineInstructionsResolverLike {
  resolve(args: ProjectInstructionsResolveArgs): Promise<ProjectInstructionsResult>;
}

/** Минимальный контракт реестра агентов (ADR-070 §2.7). */
export interface PipelineAgentRegistryLike {
  get(id: string): AgentDefinition | undefined;
}

/** Источник каталога скиллов (ADR-046) — уровень system/project. */
export interface PipelineSkillsCatalogLike {
  buildCatalog(opts: SkillCatalogOptions): Promise<ComposerSkillsCatalog>;
}

/**
 * Зависимости сборки контекста шага — те же объекты, что уже собраны в
 * `server/app/deps.ts` (проекты, реестр инструментов, MCP, резолвер
 * инструкций, реестр агентов, сервис скиллов). Все опциональны: шаг без
 * соответствующей зависимости работает с пустой частью контекста.
 */
export interface PipelineStepContextDeps {
  /** Порт проектов (ADR-096) — загрузка проекта-владельца прогона. */
  projectStore?: PipelineProjectStoreLike | null;
  /** Реестр встроенных инструментов (ADR-070/ADR-071). */
  toolRegistry?: PipelineToolRegistryLike | null;
  /** Менеджер MCP (ADR-071) — состав серверов и их уровень. */
  mcpManager?: PipelineMcpManagerLike | null;
  /** Резолвер проектных инструкций (ADR-069). */
  instructionsResolver?: PipelineInstructionsResolverLike | null;
  /** Реестр агентов (ADR-070 §2.7) — определение агента шага. */
  agentRegistry?: PipelineAgentRegistryLike | null;
  /** Каталог скиллов (ADR-046). */
  skillsCatalog?: PipelineSkillsCatalogLike | null;
  /** Доступность внешних программ окружения (git/rg/sh) — ADR-078. */
  runtimeDeps?: RuntimeDeps;
  /** Корень рабочих каталогов (ADR-014/ADR-075) — для относительного workspace. */
  workspacesRoot?: string;
  /** Язык шага (`ru`/`en`) — резолвер проектных инструкций. */
  language?: string;
}

/**
 * Контекст шага — всё, что исполнителю нужно знать об окружении шага.
 *
 * Собирается один раз на шаг (`buildPipelineStepContext`) и передаётся
 * исполнителю; сами исполнители шагов (agent/script/tool/human) — Э4.2/Э4.3.
 */
export interface PipelineStepContext {
  /** Проект-владелец шага; `undefined` — проекта нет (шаг без проектного контекста). */
  project?: Project;
  /** Проект-владелец прогона (из спецификации/прогона). */
  projectId?: string;
  /**
   * Рабочий каталог проекта (ADR-075). `undefined` — рабочего каталога нет.
   * Каталог **не создаётся** — provisioning за `engine/workspace-provision.ts`.
   */
  workspace?: string;
  /**
   * Готов ли рабочий каталог (ADR-075). `false` — file/shell/git-тулы
   * недоступны с причиной `workspace`.
   */
  workspaceReady: boolean;
  /** Режим пайплайна (`plan`/`act`/`yolo`) — применяет permission-слой (ADR-025). */
  mode: PipelineMode;
  /** Агент шага (`node.agent` → реестр агентов); `undefined` — агент не задан/не найден. */
  agent?: AgentDefinition;
  /** Все тулы шага: встроенные + MCP активных серверов (постоянный список, ADR-070 §2.9). */
  tools: ToolDefinition[];
  /** Тулы, доступные шагу сейчас (то, что можно вызвать). */
  availableTools: ToolDefinition[];
  /** Недоступные тулы с причиной (`mode`/`role`/`dependency`/`workspace`/`storage`). */
  unavailableTools: UnavailableTool[];
  /** Активные MCP-серверы шага (ADR-071) — по системе и проекту. */
  mcpServers: string[];
  /** Решения по всем MCP-серверам (включая отключённые — с причиной). */
  mcpDecisions: McpScopeDecision[];
  /** Проектные инструкции (ADR-069); нет проекта/workspace — не загружались. */
  instructions?: ComposerInstructions;
  /** Каталог скиллов шага (ADR-046) — system/project-уровень. */
  skillsCatalog?: ComposerSkillsCatalog;
}

/**
 * Собирает контекст шага из спецификации/прогона и проекта.
 *
 * Порядок: проект → рабочий каталог → агент → MCP-скоуп → инструменты →
 * инструкции → скиллы. Каждый шаг **fail-soft**: отсутствие проекта, порта или
 * резолвера не роняет сборку — соответствующая часть контекста пуста.
 */
export async function buildPipelineStepContext(
  ctx: StepExecutionContext,
  deps: PipelineStepContextDeps = {},
): Promise<PipelineStepContext> {
  const mode = ctx.mode;
  const projectId = ctx.projectId ?? ctx.spec.projectId;

  // Проект: владелец прогона. Отсутствие проекта — не ошибка (шаг работает
  // без проектного контекста).
  const project = await loadProject(projectId, deps.projectStore);

  // Рабочий каталог (ADR-075): абсолютный — как есть, относительный — от
  // `workspacesRoot`. Каталог не создаём: provisioning — за общим провижинингом.
  const workspace = resolveWorkspace(project, deps.workspacesRoot ?? '');
  const workspaceReady = workspace !== undefined;

  // Агент шага: `node.agent` → реестр агентов. Его capabilities участвуют в
  // отборе тулов (ADR-070 §2.9.1).
  const agent = resolveAgent(ctx.node.agent, deps.agentRegistry);

  // MCP-скоуп: система + проект, без сессионного снапшота (ADR-071).
  const mcpDecisions = resolveMcpDecisions(deps.mcpManager, project);
  const mcpServers = mcpDecisions.filter((decision) => decision.enabled).map((decision) => decision.name);

  // Инструменты: встроенные + MCP активных серверов; доступность — общий
  // `computeToolAvailability` (ADR-070 §2.9.1).
  const tools = collectTools(deps.toolRegistry, mcpServers);
  const { availableTools, unavailableTools } = partitionTools(tools, {
    mode,
    agent,
    runtimeDeps: deps.runtimeDeps,
    workspaceReady,
  });

  // Проектные инструкции (ADR-069) — от имени проекта; без workspace их нет.
  const instructions = await resolveInstructions(project, workspace, projectId, deps);

  // Каталог скиллов (ADR-046) — уровень system/project.
  const skillsCatalog = await resolveSkillsCatalog(project, workspace, agent, deps);

  return {
    ...(project ? { project } : {}),
    ...(projectId ? { projectId } : {}),
    ...(workspace ? { workspace } : {}),
    workspaceReady,
    mode,
    ...(agent ? { agent } : {}),
    tools,
    availableTools,
    unavailableTools,
    mcpServers,
    mcpDecisions,
    ...(instructions ? { instructions } : {}),
    ...(skillsCatalog ? { skillsCatalog } : {}),
  };
}

/** Загрузка проекта-владельца; ошибка порта не роняет шаг (проекта нет). */
async function loadProject(
  projectId: string | undefined,
  store: PipelineProjectStoreLike | null | undefined,
): Promise<Project | undefined> {
  if (!projectId || !store) return undefined;
  try {
    return (await store.load(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Рабочий каталог проекта (ADR-075) — абсолютный путь как есть, относительный
 * от `workspacesRoot`. Путь не проверяется на диске и **не создаётся**:
 * provisioning каталога — за общим `engine/workspace-provision.ts`.
 */
function resolveWorkspace(project: Project | undefined, workspacesRoot: string): string | undefined {
  const raw = project?.workspace?.trim();
  if (!raw) return undefined;
  if (!isAbsolute(raw)) {
    if (!workspacesRoot) return undefined;
    return resolve(workspacesRoot, raw);
  }
  return normalize(raw);
}

/** Определение агента шага (ADR-070 §2.7): `node.agent` → реестр агентов. */
function resolveAgent(
  agentId: string | undefined,
  registry: PipelineAgentRegistryLike | null | undefined,
): AgentDefinition | undefined {
  if (!agentId || !registry) return undefined;
  return registry.get(agentId);
}

/**
 * MCP-скоуп шага (ADR-071): система + проект, без сессионного снапшота.
 * Менеджер MCP не задан — MCP-тулов у шага нет (пустой скоуп).
 */
function resolveMcpDecisions(
  manager: PipelineMcpManagerLike | null | undefined,
  project: Project | undefined,
): McpScopeDecision[] {
  if (!manager) return [];
  const config = manager.getConfig();
  const servers = Object.keys(config).map((name) => ({
    name,
    origin: manager.getServerOrigin(name),
    systemEnabled: manager.isServerSystemEnabled(name),
  }));
  return resolveMcpProjectScope(servers, project?.mcp);
}

/** Все тулы шага: встроенные + MCP активных серверов проекта. */
function collectTools(
  registry: PipelineToolRegistryLike | null | undefined,
  mcpServers: string[],
): ToolDefinition[] {
  if (!registry) return [];
  return [...registry.listBuiltin(), ...registry.listMcp(mcpServers)];
}

/**
 * Разделение тулов на доступные и недоступные — **тот же** расчёт доступности,
 * что у сессий (ADR-070 §2.9.1): режим пайплайна, capabilities агента,
 * зависимости окружения и готовность рабочего каталога.
 */
function partitionTools(
  tools: ToolDefinition[],
  opts: {
    mode: PipelineMode;
    agent?: AgentDefinition;
    runtimeDeps?: RuntimeDeps;
    workspaceReady: boolean;
  },
): { availableTools: ToolDefinition[]; unavailableTools: UnavailableTool[] } {
  const availableTools: ToolDefinition[] = [];
  const unavailableTools: UnavailableTool[] = [];
  for (const tool of tools) {
    const availability = computeToolAvailability(tool.name, tool.capabilities, {
      sessionMode: opts.mode,
      agentCapabilities: opts.agent?.capabilities,
      ...(opts.runtimeDeps ? { runtimeDeps: opts.runtimeDeps } : {}),
      workspaceReady: opts.workspaceReady,
    });
    if (availability.available) {
      availableTools.push(tool);
      continue;
    }
    if (!availability.reason) continue;
    const dep = availability.reason === 'dependency' ? TOOL_RUNTIME_DEP[tool.name] : undefined;
    unavailableTools.push({
      name: tool.name,
      reason: availability.reason,
      ...(dep ? { binary: RUNTIME_DEP_BINARY[dep] } : {}),
    });
  }
  return { availableTools, unavailableTools };
}

/**
 * Проектные инструкции (ADR-069) — резолв от имени проекта. Без workspace
 * (нет проекта или каталог не задан) инструкции недоступны (ADR-040).
 */
async function resolveInstructions(
  project: Project | undefined,
  workspace: string | undefined,
  projectId: string | undefined,
  deps: PipelineStepContextDeps,
): Promise<ComposerInstructions | undefined> {
  const resolver = deps.instructionsResolver;
  if (!resolver || !workspace) return undefined;
  let result: ProjectInstructionsResult;
  try {
    result = await resolver.resolve({
      workspace,
      ...(deps.language ? { language: deps.language } : {}),
      ...(projectId ? { projectId } : {}),
    });
  } catch {
    return undefined;
  }
  if (!result.content) return undefined;
  const loaded = result.files.filter((file) => !file.blocked);
  const provenance = loaded.map((file) => file.path).join(', ') || undefined;
  const status = loaded.some((file) => file.truncated) ? 'truncated' : 'loaded';
  return { content: result.content, provenance, status };
}

/**
 * Каталог скиллов шага (ADR-046) — system/project-уровень: проектный
 * hard-gate (`project.skills.enabled`) и проектный сид (`project.skills.defaultOn`).
 * Сессионного слоя нет (у шага нет сессии).
 */
async function resolveSkillsCatalog(
  project: Project | undefined,
  workspace: string | undefined,
  agent: AgentDefinition | undefined,
  deps: PipelineStepContextDeps,
): Promise<ComposerSkillsCatalog | undefined> {
  const provider = deps.skillsCatalog;
  if (!provider) return undefined;
  try {
    return await provider.buildCatalog({
      ...(workspace ? { projectWorkspace: workspace } : {}),
      ...(agent ? { agent: { id: agent.id, ...(agent.groups ? { groups: agent.groups } : {}) } } : {}),
      ...(agent ? { capabilities: agent.capabilities } : {}),
      ...(project?.skills?.enabled ? { projectEnabled: project.skills.enabled } : {}),
      ...(project?.skills?.defaultOn ? { defaultOn: project.skills.defaultOn } : {}),
    });
  } catch {
    return undefined;
  }
}
