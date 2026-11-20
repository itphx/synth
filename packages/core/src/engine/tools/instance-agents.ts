/**
 * Самообслуживание реестра агентов из чата: `synth_agent_*`.
 *
 * ## Зачем
 *
 * Реестр агентов (`{dataDir}/agents/*.json` + ролевые файлы
 * `{dataDir}/context/roles/`) настраивался только через HTTP API/админку.
 * Агент не мог по просьбе человека ни посмотреть состав, ни создать роль, ни
 * импортировать агента из opencode-подобного markdown — приходилось объяснять
 * человеку, куда идти и что нажимать.
 *
 * ## Границы (паритет с HTTP-роутами `createAgentRoutes`)
 *
 * - источник данных тот же: встроенные определения (`loadSystemAgentDefinitions`)
 *   + записи стора (`agentStore`, порт `DocumentRepository`); мутации пишутся в
 *   **стор**, а реестр (`AgentRegistry`) обновляется тем же вызовом — логика
 *   роутов не дублируется, а переиспользуется по семантике;
 * - ролевой промпт (`role_prompt`) пишется **портом файлов контекста**
 *   (`ContextFileRepository.saveFile(..., 'role')` — атомарно, tmp→rename) в
 *   `{dataDir}/context/roles/<contextFile | ID.md>`; в ответе — отчёт
 *   `role: {file, written, replaced}`, как у `POST /api/v2/agents`;
 * - права: чтение — любому агенту с capability `agents`; запись — **только
 *   ADMIN** (`isInstanceAdmin`: роль `ADMIN` либо локальный владелец standalone —
 *   паритет с локальным API-ключом);
 * - в plan-режиме доступны только чтения: write-имена заблокированы
 *   permission-слоем (`permission/evaluator.ts`), а не проверкой внутри execute
 *   (ADR-025/ADR-029);
 * - ошибки валидации — `ToolResult` с понятным кодом (`agent.invalid_id`,
 *   `agent.invalid_effort`, `agent.invalid_role_file`), не исключение;
 * - импорт читает файл **через порт исполнения** (PROP-135): в remote-режиме
 *   рабочий каталог живёт на исполнителе, `node:fs` в тулах запрещён.
 */
import { basename } from 'node:path';
import { z } from 'zod';
import { EFFORT_LEVELS, ToolCapability, isEffortLevel, parseFrontmatter } from '@itphx/synth-shared';
import type {
  AgentDefinition,
  AgentMode,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { DocumentRepository } from '../../storage/ports/document-repository.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import { loadSystemAgentDefinitions, normalizeAgentModes, isAgentDefinitionChanged } from '../agents/index.js';
import { publishAgentsUpdated } from '../../events/agents-events.js';
import type { InstanceEventPublisherLike } from '../../events/agents-events.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { escapesWorkspace, FS_UNAVAILABLE_TEXT } from '../../execution/fs-perimeter.js';
import { resolvePath, toolRoots } from './path-utils.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isInstanceAdmin } from './instance-auth.js';
import { info, warning } from '../../logger.js';

/** Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор). */
export interface InstanceAgentsExtra {
  /** Стор агентов (порт `DocumentRepository`) — те же записи, что у HTTP-роутов. */
  agentStore?: DocumentRepository<AgentDefinition>;
  /** Реестр агентов в памяти процесса — обновляется вместе со стором. */
  agentRegistry?: AgentRegistry;
  /** Порт файлов контекста — запись/чтение ролевого промпта. */
  contextConfig?: Pick<ContextFileRepository, 'getFile' | 'saveFile'>;
  /** Снимок метаданных инстанса (режим — для ADMIN-паритета standalone). */
  instanceMeta?: InstanceRuntimeMeta;
  /**
   * Шина событий — публикация `agents.updated` (инстансный канал, ADR-118)
   * после успешной мутации реестра. Тот же шов, что у HTTP-роутов: без него
   * UI узнавал бы о правке из чата только после перезагрузки страницы.
   * Не задана — событие не публикуется (тесты/сторонние потребители).
   */
  eventBus?: InstanceEventPublisherLike;
}

/** Пределы ответа (краткость для модели). */
const MAX_AVAILABLE_IDS = 20;
/** Потолок размера ролевого промпта/импортируемого markdown. */
const MAX_ROLE_BYTES = 256 * 1024;

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

/** Имя файла роли агента — тот же дефолт, что в `ContextConfig.getRolePrompt`. */
function roleFileName(agent: Pick<AgentDefinition, 'id' | 'contextFile'>): string {
  return agent.contextFile || `${agent.id.toUpperCase()}.md`;
}

/**
 * Имя файла роли — «плоское» (без путей и `..`): файл пишется в
 * `{dataDir}/context/roles/`, имя с путём ушло бы за пределы каталога
 * (path traversal). Правило — как у HTTP-роута `POST /api/v2/agents`.
 */
function isSafeRoleFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

/** Размер строки в байтах (UTF-8) — без импорта `node:fs`/`Buffer`-хаков. */
function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

function getExtra(ctx: ToolContext): InstanceAgentsExtra {
  return (ctx.extra ?? {}) as InstanceAgentsExtra;
}

function fail(key: Parameters<typeof sm>[0], params?: Record<string, string>): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

function depsError(toolName: string): ToolResult {
  return fail('agent.deps_unavailable', { tool: toolName });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Состояние реестра: встроенные определения + записи стора (merge как у роутов). */
interface AgentState {
  builtins: AgentDefinition[];
  overrides: AgentDefinition[];
  /** Смерженный список: встроенные (с override) + custom из стора. */
  agents: AgentDefinition[];
}

async function loadState(store: DocumentRepository<AgentDefinition>): Promise<AgentState> {
  const builtins = loadSystemAgentDefinitions();
  const builtinIds = new Set(builtins.map((agent) => agent.id));
  const overrides = await store.list();
  const agents = builtins.map((builtin) => {
    const override = overrides.find((item) => item.id === builtin.id);
    return override ? { ...builtin, ...override, isOverridden: true } : builtin;
  });
  for (const override of overrides) {
    if (!builtinIds.has(override.id)) agents.push({ ...override, isOverridden: true });
  }
  return { builtins, overrides, agents };
}

/** Краткий список известных id — для текста «агент не найден». */
function availableIds(state: AgentState): string {
  return state.agents
    .slice(0, MAX_AVAILABLE_IDS)
    .map((agent) => agent.id)
    .join(', ');
}

/** Компактная сводка агента (список/ответы) — поля DTO HTTP-роутов. */
function agentSummary(agent: AgentDefinition, builtinIds: ReadonlySet<string>) {
  return {
    id: agent.id,
    display_name: agent.displayName,
    agent_mode: normalizeAgentModes(agent.agentMode),
    capabilities: agent.capabilities ?? [],
    max_steps: agent.maxSteps ?? null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    effort: agent.effort ?? null,
    context_file: agent.contextFile ?? null,
    groups: agent.groups ?? null,
    enabled: agent.enabled,
    is_builtin: builtinIds.has(agent.id),
    is_overridden: agent.isOverridden === true,
  };
}

/** Группы агента (ADR-126 §9): непустые строки без дублей. */
function normalizeGroups(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || groups.includes(name)) continue;
    groups.push(name);
  }
  return groups;
}

/** Отчёт о записи ролевого промпта (паритет с `POST /api/v2/agents`). */
interface AgentRoleOutcome {
  file: string;
  written: boolean;
  replaced: boolean;
  bytes: number;
}

/** Параметры upsert (общие для `synth_agent_save` и `synth_agent_import`). */
export interface AgentSaveParams {
  id: string;
  display_name?: string;
  description?: string;
  capabilities?: string[];
  agent_mode?: AgentMode | AgentMode[];
  max_steps?: number;
  provider?: string;
  model?: string;
  temperature?: number | null;
  effort?: string | null;
  color?: string;
  icon?: string;
  groups?: string[];
  enabled?: boolean;
  context_file?: string;
  role_prompt?: string;
}

type UpsertOutcome =
  | { ok: true; agent: AgentDefinition; created: boolean; role: AgentRoleOutcome | null }
  | { ok: false; result: ToolResult };

/**
 * Создать/обновить агента: запись в стор + ролевой промпт (если он передан) +
 * регистрация в реестре. Семантика merge — как у `POST /api/v2/agents`:
 * `body → existing → builtin`.
 *
 * `action` — вид мутации для события `agents.updated` (`save`/`import`):
 * импорт — тоже upsert, но UI различает его в payload.
 */
async function upsertAgent(
  extra: InstanceAgentsExtra,
  params: AgentSaveParams,
  rolePrompt: string | undefined,
  action: 'save' | 'import',
): Promise<UpsertOutcome> {
  const store = extra.agentStore;
  if (!store) return { ok: false, result: fail('agent.deps_unavailable', { tool: 'synth_agent_save' }) };

  const state = await loadState(store);
  const builtin = state.builtins.find((item) => item.id === params.id);
  const existing = state.overrides.find((item) => item.id === params.id);

  const agent: AgentDefinition = {
    id: params.id,
    displayName: params.display_name ?? existing?.displayName ?? builtin?.displayName ?? params.id,
    contextFile: params.context_file ?? existing?.contextFile ?? builtin?.contextFile,
    capabilities: (params.capabilities as ToolCapability[] | undefined)
      ?? existing?.capabilities
      ?? builtin?.capabilities
      ?? [],
    enabled: params.enabled ?? existing?.enabled ?? builtin?.enabled ?? true,
    provider: params.provider ?? existing?.provider,
    model: params.model ?? existing?.model,
    // `null` — явный сброс в Auto (дефолт модели), как у HTTP-роута.
    temperature: params.temperature === null
      ? undefined
      : (params.temperature ?? existing?.temperature),
    effort: params.effort === null
      ? undefined
      : (isEffortLevel(params.effort) ? params.effort : (existing?.effort ?? builtin?.effort)),
    reasoningLevel: existing?.reasoningLevel ?? builtin?.reasoningLevel,
    isOverridden: true,
    icon: params.icon ?? existing?.icon,
    color: params.color ?? existing?.color,
    description: params.description ?? existing?.description,
    agentMode: normalizeAgentModes(params.agent_mode ?? existing?.agentMode ?? builtin?.agentMode),
    maxSteps: params.max_steps ?? existing?.maxSteps ?? builtin?.maxSteps,
    groups: normalizeGroups(params.groups) ?? existing?.groups ?? builtin?.groups,
    // Поля, которыми тул не управляет, но которые не должны потеряться.
    executorProfile: existing?.executorProfile ?? builtin?.executorProfile,
    allowedProfiles: existing?.allowedProfiles ?? builtin?.allowedProfiles,
    browserProfile: existing?.browserProfile ?? builtin?.browserProfile,
    allowedBrowserProfiles: existing?.allowedBrowserProfiles ?? builtin?.allowedBrowserProfiles,
  };

  // Ролевой промпт пишется ДО сохранения агента: агент без роли — сломанный
  // агент, а «лишний» файл роли перезапишется следующей установкой.
  let role: AgentRoleOutcome | null = null;
  if (rolePrompt !== undefined && rolePrompt.trim().length > 0) {
    const file = roleFileName(agent);
    if (!isSafeRoleFileName(file)) {
      return { ok: false, result: fail('agent.invalid_role_file', { file }) };
    }
    const roleFiles = extra.contextConfig;
    if (!roleFiles) return { ok: false, result: fail('agent.role_unavailable', { file }) };
    let previous: string | null = null;
    try {
      previous = roleFiles.getFile(file, 'role')?.content ?? null;
    } catch {
      previous = null;
    }
    const replaced = previous !== null && previous !== rolePrompt;
    let saved = false;
    try {
      saved = await roleFiles.saveFile(file, rolePrompt, 'role');
    } catch (err) {
      return { ok: false, result: fail('agent.role_write_failed', { file, error: errorText(err) }) };
    }
    if (!saved) {
      return {
        ok: false,
        result: fail('agent.role_write_failed', { file, error: 'the context file port returned false' }),
      };
    }
    role = { file, written: true, replaced, bytes: byteSize(rolePrompt) };
    if (replaced) warning('AGENTS', `Ролевой промпт агента ${params.id} перезаписан: ${file}`);
    else info('AGENTS', `Ролевой промпт агента ${params.id} сохранён: ${file}`);
  }

  await store.save(params.id, agent);
  extra.agentRegistry?.register(agent);
  // Событие — только когда определение реально изменилось (или переписан файл
  // роли): повторное сохранение тем же содержимым сеть UI не дёргает.
  // `before` — состояние реестра до записи (override поверх встроенного).
  const before: AgentDefinition | undefined = existing
    ? { ...builtin, ...existing, isOverridden: true }
    : builtin;
  if (isAgentDefinitionChanged(before, agent) || role?.replaced === true) {
    publishAgentsUpdated(extra.eventBus, { id: agent.id, action });
  }
  return { ok: true, agent, created: existing === undefined, role };
}

/** Артефакт ответа write-тулов: определение агента в том же DTO, что у списка. */
function writeMetadata(
  agent: AgentDefinition,
  created: boolean,
  role: AgentRoleOutcome | null,
) {
  return {
    ...agentSummary(agent, new Set(loadSystemAgentDefinitions().map((item) => item.id))),
    created,
    role: role ?? null,
  };
}

/** Проверка ADMIN для write-тулов: отказ — `ToolResult`, не исключение. */
function requireAdmin(ctx: ToolContext): ToolResult | null {
  return isInstanceAdmin(ctx) ? null : fail('agent.forbidden');
}

const agentModeSchema = z.union([
  z.enum(['primary', 'subagent', 'system']),
  z.array(z.enum(['primary', 'subagent', 'system'])),
]);

const saveSchema = z.object({
  id: z.string().min(1).describe('Agent id: lowercase latin, digits, "-" and "_" only'),
  display_name: z.string().min(1).optional().describe('Human-readable agent name'),
  description: z.string().optional().describe('Short agent description (shown in the UI)'),
  capabilities: z.array(z.string()).optional()
    .describe('Tool capabilities of the agent (e.g. ["file_read","shell","task"])'),
  agent_mode: agentModeSchema.optional()
    .describe('Agent class: "primary", "subagent", "system" or an array of them'),
  max_steps: z.number().int().min(0).max(10000).optional()
    .describe('Step limit (0 — unlimited; default 0 for primary, 15 for subagent)'),
  provider: z.string().optional().describe('LLM provider for the agent'),
  model: z.string().optional().describe('Model for the agent'),
  temperature: z.number().min(0).max(2).nullable().optional()
    .describe('Temperature; null resets to the model default (auto)'),
  effort: z.string().nullable().optional()
    .describe(`Reasoning effort tier (${EFFORT_LEVELS.join(', ')}); null resets to auto`),
  color: z.string().optional().describe('UI color'),
  icon: z.string().optional().describe('UI icon name'),
  groups: z.array(z.string()).optional()
    .describe('Agent groups — skills are bound to agents by these groups (ADR-126 §9)'),
  enabled: z.boolean().optional().describe('Whether the agent is enabled (default true)'),
  context_file: z.string().optional()
    .describe('Role file name in the context/roles directory (default "<ID>.md")'),
  role_prompt: z.string().optional()
    .describe('Role prompt content — written atomically to the role file'),
});

export const synthAgentListTool: ToolDefinition = {
  name: 'synth_agent_list',
  description:
    'List the instance agent registry (read-only): builtin agent definitions merged with stored overrides '
    + 'and custom agents. Returns id, display_name, agent_mode, capabilities, max_steps, provider, model, '
    + 'effort, context_file, groups, enabled, is_builtin, is_overridden for every agent. '
    + 'Use synth_agent_get for one agent (and its role file).',
  parameters: z.object({}),
  capabilities: [ToolCapability.AGENTS],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getExtra(ctx);
    const store = extra.agentStore;
    if (!store) return depsError(this.name);

    let state: AgentState;
    try {
      state = await loadState(store);
    } catch (err) {
      return fail('agent.registry_unavailable', { error: errorText(err) });
    }
    const builtinIds = new Set(state.builtins.map((agent) => agent.id));
    const agents = state.agents.map((agent) => agentSummary(agent, builtinIds));
    const json = JSON.stringify(agents);
    return {
      content: sm('agent.list', { count: String(agents.length), json }),
      metadata: {
        count: agents.length,
        agents,
        i18n: i18nMeta('agent.list', { count: String(agents.length), json }),
      },
    };
  },
};

const getSchema = z.object({
  id: z.string().min(1).describe('Agent id from synth_agent_list'),
  include_role: z.boolean().optional()
    .describe('Include the role prompt content (the prompt is bulky, so it is opt-in)'),
});

export const synthAgentGetTool: ToolDefinition = {
  name: 'synth_agent_get',
  description:
    'Get one agent definition (read-only) with its role file info: role {file, exists, bytes} and, '
    + 'with include_role: true, the role prompt content. A builtin agent overridden in the store is '
    + 'reported as merged (is_overridden: true).',
  parameters: getSchema,
  capabilities: [ToolCapability.AGENTS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { id: string; include_role?: boolean };

    const extra = getExtra(ctx);
    const store = extra.agentStore;
    if (!store) return depsError(this.name);

    let state: AgentState;
    try {
      state = await loadState(store);
    } catch (err) {
      return fail('agent.registry_unavailable', { error: errorText(err) });
    }
    const agent = state.agents.find((item) => item.id === params.id);
    if (!agent) {
      return fail('agent.not_found', { id: params.id, available: availableIds(state) || '—' });
    }

    const baseFile = roleFileName(agent);
    let roleContent: { content: string; isSystem: boolean } | null = null;
    let roleFile = baseFile;
    if (extra.contextConfig) {
      // Роль грузится **с учётом локали** (`getRolePrompt` смотрит сначала
      // override, потом встроенный `ROLE.<lang>.md`), поэтому проверка одного
      // базового имени давала ложное `exists: false` для всех встроенных ролей
      // (`KEEPER.ru.md`). Перебираем кандидатов и отдаём **фактически найденный** файл.
      const stem = baseFile.replace(/\.md$/, '');
      const candidates = [baseFile, `${stem}.ru.md`, `${stem}.en.md`];
      try {
        for (const candidate of candidates) {
          const found = extra.contextConfig.getFile(candidate, 'role');
          if (found) {
            roleContent = { content: found.content, isSystem: found.isSystem };
            roleFile = candidate;
            break;
          }
        }
      } catch {
        roleContent = null;
      }
    }
    const bytes = roleContent ? byteSize(roleContent.content) : null;
    const truncated = roleContent !== null && bytes !== null && bytes > MAX_ROLE_BYTES;
    const role = {
      file: roleFile,
      exists: roleContent !== null,
      bytes,
      ...(roleContent ? { source: roleContent.isSystem ? 'system' : 'override' } : {}),
      ...(params.include_role && roleContent
        ? {
          content: truncated ? roleContent.content.slice(0, MAX_ROLE_BYTES) : roleContent.content,
          truncated,
        }
        : {}),
    };

    const builtinIds = new Set(state.builtins.map((item) => item.id));
    const definition = {
      ...agentSummary(agent, builtinIds),
      description: agent.description ?? null,
      temperature: agent.temperature ?? null,
      reasoning_level: agent.reasoningLevel ?? null,
      icon: agent.icon ?? null,
      color: agent.color ?? null,
      executor_profile: agent.executorProfile ?? null,
      allowed_profiles: agent.allowedProfiles ?? null,
      browser_profile: agent.browserProfile ?? null,
      allowed_browser_profiles: agent.allowedBrowserProfiles ?? null,
      role,
    };
    const json = JSON.stringify(definition);
    return {
      content: sm('agent.get', { id: agent.id, json }),
      metadata: { ...definition, i18n: i18nMeta('agent.get', { id: agent.id, json }) },
    };
  },
};

export const synthAgentSaveTool: ToolDefinition = {
  name: 'synth_agent_save',
  description:
    'Create or update an agent (write, ADMIN only). Upsert semantics: a builtin agent is overridden, '
    + 'an unknown id creates a custom agent. role_prompt is written atomically to the role file '
    + '(context/roles/<context_file | ID.md>); the answer reports role {file, written, replaced}. '
    + 'Validation errors are returned as results (agent.invalid_id, agent.invalid_effort, '
    + 'agent.invalid_role_file), never thrown. Requires ADMIN (in standalone the local owner is admin).',
  parameters: saveSchema,
  capabilities: [ToolCapability.AGENTS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as AgentSaveParams;

    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const id = params.id.trim();
    if (!AGENT_ID_REGEX.test(id)) return fail('agent.invalid_id', { id });
    if (params.effort !== undefined && params.effort !== null && !isEffortLevel(params.effort)) {
      return fail('agent.invalid_effort', { levels: EFFORT_LEVELS.join(', ') });
    }
    if (params.context_file !== undefined && !isSafeRoleFileName(params.context_file)) {
      return fail('agent.invalid_role_file', { file: params.context_file });
    }

    let outcome: UpsertOutcome;
    try {
      outcome = await upsertAgent(getExtra(ctx), { ...params, id }, params.role_prompt, 'save');
    } catch (err) {
      return fail('agent.save_failed', { id, error: errorText(err) });
    }
    if (!outcome.ok) return outcome.result;

    const key = outcome.created ? 'agent.save.created' : 'agent.save.updated';
    const metadata = writeMetadata(outcome.agent, outcome.created, outcome.role);
    return {
      content: sm(key, { id: outcome.agent.id }),
      metadata: { ...metadata, i18n: i18nMeta(key, { id: outcome.agent.id }) },
    };
  },
};

const deleteSchema = z.object({
  id: z.string().min(1).describe('Agent id'),
});

export const synthAgentDeleteTool: ToolDefinition = {
  name: 'synth_agent_delete',
  description:
    'Delete a custom agent or reset a builtin agent override (write, ADMIN only) — same semantics as '
    + 'DELETE /api/v2/agents/:id. A builtin agent is not removed: its stored override is dropped and the '
    + 'builtin definition is restored (status "reset"). A custom agent is removed from the registry '
    + '(status "deleted").',
  parameters: deleteSchema,
  capabilities: [ToolCapability.AGENTS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const { id } = parsed.data as { id: string };

    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const extra = getExtra(ctx);
    const store = extra.agentStore;
    if (!store) return depsError(this.name);

    let state: AgentState;
    let exists: boolean;
    try {
      state = await loadState(store);
      exists = await store.exists(id);
    } catch (err) {
      return fail('agent.registry_unavailable', { error: errorText(err) });
    }
    const builtin = state.builtins.find((agent) => agent.id === id);

    if (builtin) {
      if (!exists) return fail('agent.override_not_found', { id });
      await store.delete(id);
      extra.agentRegistry?.register(builtin);
      publishAgentsUpdated(extra.eventBus, { id, action: 'reset' });
      return {
        content: sm('agent.delete.reset', { id }),
        metadata: {
          id,
          status: 'reset',
          is_builtin: true,
          i18n: i18nMeta('agent.delete.reset', { id }),
        },
      };
    }

    if (!exists) return fail('agent.not_found', { id, available: availableIds(state) || '—' });
    await store.delete(id);
    extra.agentRegistry?.unregister(id);
    publishAgentsUpdated(extra.eventBus, { id, action: 'delete' });
    return {
      content: sm('agent.delete.deleted', { id }),
      metadata: {
        id,
        status: 'deleted',
        is_builtin: false,
        i18n: i18nMeta('agent.delete.deleted', { id }),
      },
    };
  },
};

const enableSchema = z.object({
  id: z.string().min(1).describe('Agent id'),
  enabled: z.boolean().describe('Enable or disable the agent'),
});

export const synthAgentEnableTool: ToolDefinition = {
  name: 'synth_agent_enable',
  description:
    'Enable or disable an agent (write, ADMIN only) — same semantics as PATCH /api/v2/agents/:id/enabled. '
    + 'A builtin agent gets a stored override with the new flag; a custom agent record is updated in place.',
  parameters: enableSchema,
  capabilities: [ToolCapability.AGENTS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { id: string; enabled: boolean };

    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const extra = getExtra(ctx);
    const store = extra.agentStore;
    if (!store) return depsError(this.name);

    let state: AgentState;
    let existing: AgentDefinition | null;
    try {
      state = await loadState(store);
      existing = await store.load(params.id);
    } catch (err) {
      return fail('agent.registry_unavailable', { error: errorText(err) });
    }
    const builtin = state.builtins.find((agent) => agent.id === params.id);
    if (!builtin && !existing) {
      return fail('agent.not_found', { id: params.id, available: availableIds(state) || '—' });
    }

    const agent: AgentDefinition = existing
      ? { ...existing, enabled: params.enabled, isOverridden: true }
      : { ...builtin!, enabled: params.enabled, isOverridden: true };
    await store.save(params.id, agent);
    extra.agentRegistry?.register(agent);
    // Событие — только при реальной смене признака (идемпотентный вызов не шумит).
    if ((existing?.enabled ?? builtin!.enabled) !== params.enabled) {
      publishAgentsUpdated(extra.eventBus, { id: params.id, action: 'enable' });
    }
    return {
      content: sm('agent.enable.ok', { id: params.id, enabled: String(params.enabled) }),
      metadata: {
        id: params.id,
        enabled: params.enabled,
        is_builtin: builtin !== undefined,
        i18n: i18nMeta('agent.enable.ok', { id: params.id, enabled: String(params.enabled) }),
      },
    };
  },
};

const importSchema = z.object({
  path: z.string().optional()
    .describe('Path to an opencode-like agent markdown file (relative to the working directory)'),
  content: z.string().optional().describe('Markdown content to import (alternative to path)'),
  dry_run: z.boolean().optional()
    .describe('Only report the resulting definition and warnings — write nothing'),
});

/** Маппинг opencode-подобных `permissions[].tool` → capability ядра. */
const PERMISSION_CAPABILITIES: Record<string, ToolCapability> = {
  shell: ToolCapability.SHELL,
  read: ToolCapability.FILE_READ,
  edit: ToolCapability.FILE_WRITE,
  write: ToolCapability.FILE_WRITE,
  grep: ToolCapability.SEARCH,
  glob: ToolCapability.SEARCH,
  websearch: ToolCapability.WEB,
  webfetch: ToolCapability.WEB,
  question: ToolCapability.QUESTION,
  totowrite: ToolCapability.TODO,
  todowrite: ToolCapability.TODO,
};

interface PermissionEntry {
  name: string;
  effect: string;
  action: string;
}

/** Нормализация записи `permissions[]` (строка или объект opencode-вида). */
function readPermissionEntry(raw: unknown): PermissionEntry | null {
  if (typeof raw === 'string') {
    const name = raw.trim().toLowerCase();
    return name ? { name, effect: 'allow', action: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nameRaw = record.tool ?? record.name ?? record.permission ?? record.id;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) return null;
  const effect = typeof record.effect === 'string' ? record.effect.trim().toLowerCase() : 'allow';
  const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : '';
  return { name: nameRaw.trim().toLowerCase(), effect, action };
}

interface ImportPlan {
  params: AgentSaveParams;
  warnings: string[];
  rolePrompt: string | undefined;
}

/**
 * Разбор opencode-подобного markdown: frontmatter → определение агента.
 * Ничего не пишет; предупреждения (unmapped permissions, `skill`) отдаются
 * вызывающему, а не глотаются — импорт не должен молча терять права.
 */
function planImport(raw: string, fallbackId: string): ImportPlan | { error: ToolResult } {
  const front = parseFrontmatter(raw);
  if (front.issues.length > 0) {
    return {
      error: fail('agent.import.invalid_frontmatter', {
        error: front.issues.map((issue) => issue.message).join('; '),
      }),
    };
  }
  const data = front.data as Record<string, unknown>;
  const id = typeof data.id === 'string' && data.id.trim() !== '' ? data.id.trim() : fallbackId;
  if (!id) return { error: fail('agent.import.no_id') };

  const warnings: string[] = [];
  const capabilities = new Set<ToolCapability>();

  // Два вида `permissions` (opencode-совместимость): массив записей
  // (`[{tool, effect, action}]`) или карта «имя разрешения → эффект»
  // (`{shell: allow}`). Во втором виде имя берётся из **ключа**, иначе `shell:
  // deny` превратился бы в разрешение с именем «deny» и потерял право
  // (импорт не должен терять права молча). Сингулярный `permission` — тот же
  // ключ в opencode-формате.
  const rawPermissions = data.permissions ?? data.permission;
  const permissionList = Array.isArray(rawPermissions)
    ? rawPermissions
    : (rawPermissions && typeof rawPermissions === 'object'
      ? Object.entries(rawPermissions as Record<string, unknown>).map(([name, value]) => (
        value && typeof value === 'object'
          ? { tool: name, ...(value as Record<string, unknown>) }
          : { tool: name, effect: value }
      ))
      : []);

  for (const rawEntry of permissionList) {
    const entry = readPermissionEntry(rawEntry);
    if (!entry) continue;
    // `action: subagent` — право запускать сабагентов; `effect: deny` его снимает.
    if (entry.action === 'subagent') {
      if (entry.effect !== 'deny') capabilities.add(ToolCapability.TASK);
      continue;
    }
    if (entry.name === 'skill') {
      // Capability для скиллов не существует: они привязываются через `groups`.
      warnings.push(sm('agent.import.warning_skill', { name: entry.name }));
      continue;
    }
    const capability = PERMISSION_CAPABILITIES[entry.name];
    if (!capability) {
      warnings.push(sm('agent.import.warning_permission', { name: entry.name }));
      continue;
    }
    if (entry.effect === 'deny') continue;
    capabilities.add(capability);
  }

  const modeRaw = data.mode;
  let agentMode: AgentMode[] | undefined;
  if (modeRaw === 'all') agentMode = ['primary', 'subagent'];
  else if (typeof modeRaw === 'string' && modeRaw.trim() !== '') agentMode = [modeRaw.trim() as AgentMode];

  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;
  const steps = typeof data.steps === 'number' && Number.isFinite(data.steps) ? data.steps : undefined;

  const params: AgentSaveParams = {
    id,
    ...(text(data.description) ? { description: text(data.description) } : {}),
    ...(text(data.color) ? { color: text(data.color) } : {}),
    ...(steps !== undefined ? { max_steps: steps } : {}),
    ...(agentMode ? { agent_mode: agentMode } : {}),
    ...(capabilities.size > 0 ? { capabilities: [...capabilities] } : {}),
    // Группы/скиллы и явные поля, которых нет во frontmatter, тул не выдумывает.
  };

  const body = front.body.trim();
  return { params, warnings, rolePrompt: body.length > 0 ? front.body : undefined };
}

export const synthAgentImportTool: ToolDefinition = {
  name: 'synth_agent_import',
  description:
    'Import an agent from an opencode-like markdown file (write, ADMIN only): YAML frontmatter '
    + '(description, mode, steps, color, permissions[]) + the body as role_prompt. '
    + 'Mapping: mode "all" → ["primary","subagent"], primary/subagent/system → the same, steps → max_steps, '
    + 'color → color; permissions → capabilities (shell→shell, read→file_read, edit/write→file_write, '
    + 'grep/glob→search, websearch/webfetch→web, question→question, totowrite/todowrite→todo). '
    + 'An entry with action "subagent" adds `task`, unless its effect is "deny". Skills have no capability '
    + '(they are bound via groups) — such entries are reported as warnings. '
    + 'The id comes from the frontmatter `id`, otherwise from the file name without ".md". '
    + 'With dry_run: true nothing is written — the resulting definition and warnings are returned.',
  parameters: importSchema,
  capabilities: [ToolCapability.AGENTS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { path?: string; content?: string; dry_run?: boolean };

    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const extra = getExtra(ctx);
    const store = extra.agentStore;
    if (!store) return depsError(this.name);

    const hasPath = typeof params.path === 'string' && params.path.trim() !== '';
    const hasContent = typeof params.content === 'string' && params.content !== '';
    if (!hasPath && !hasContent) return fail('agent.import.source_required');
    if (hasPath && hasContent) return fail('agent.import.source_ambiguous');

    let raw = params.content ?? '';
    let fallbackId = '';
    if (hasPath) {
      const resolved = resolvePath(params.path, ctx.workingDir);
      fallbackId = basename(resolved).replace(/\.md$/i, '');
      const fs = resolveExecutionPort(ctx).fs;
      if (!fs) return { content: FS_UNAVAILABLE_TEXT, isError: true };
      try {
        // Периметр сессии: путь вне рабочего каталога/корня проекта — отказ.
        if (await escapesWorkspace(fs, toolRoots(ctx), resolved)) {
          return fail('agent.import.path_outside', { path: params.path ?? '' });
        }
        raw = (await fs.readRawText(resolved, MAX_ROLE_BYTES)).text;
      } catch (err) {
        return fail('agent.import.read_failed', { path: params.path ?? '', error: errorText(err) });
      }
    }

    const plan = planImport(raw, fallbackId);
    if ('error' in plan) return plan.error;
    if (!AGENT_ID_REGEX.test(plan.params.id)) return fail('agent.invalid_id', { id: plan.params.id });

    if (params.dry_run) {
      const roleFile = roleFileName({ id: plan.params.id, contextFile: plan.params.context_file });
      const definition = {
        ...plan.params,
        agent_mode: normalizeAgentModes(plan.params.agent_mode),
        context_file: roleFile,
      };
      return {
        content: sm('agent.import.dry_run', {
          id: plan.params.id,
          json: JSON.stringify({ definition, warnings: plan.warnings }),
        }),
        metadata: {
          dry_run: true,
          id: plan.params.id,
          definition,
          role: {
            file: roleFile,
            bytes: plan.rolePrompt !== undefined ? byteSize(plan.rolePrompt) : 0,
            written: false,
          },
          warnings: plan.warnings,
        },
      };
    }

    let outcome: UpsertOutcome;
    try {
      outcome = await upsertAgent(extra, plan.params, plan.rolePrompt, 'import');
    } catch (err) {
      return fail('agent.save_failed', { id: plan.params.id, error: errorText(err) });
    }
    if (!outcome.ok) return outcome.result;

    const key = outcome.created ? 'agent.import.imported' : 'agent.import.updated';
    const metadata = {
      ...writeMetadata(outcome.agent, outcome.created, outcome.role),
      warnings: plan.warnings,
    };
    return {
      content: plan.warnings.length > 0
        ? sm(key, { id: outcome.agent.id, warnings: plan.warnings.join('; ') })
        : sm(key, { id: outcome.agent.id, warnings: '—' }),
      metadata: {
        ...metadata,
        i18n: i18nMeta(key, { id: outcome.agent.id, warnings: plan.warnings.join('; ') }),
      },
    };
  },
};

