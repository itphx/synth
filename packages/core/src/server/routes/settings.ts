import { Hono } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AuthKit } from '../../auth/local.js';
import type { RuntimeSettingsStore, LlmGatewayRuntimeSettings, SecurityRuntimeSettings, EventsRuntimeSettings } from '../../storage/runtime-settings.js';
import type { ProtectedPathsStore } from '../../engine/security/protected-paths-store.js';
import type { ProtectedPathsPolicy, ProtectedPathsOverride } from '../../engine/security/protected-paths.js';
import type { McpServerToolSettings, McpToolAvailability, ToolsPolicy, McpNetworkPolicy, ToolsDisabledConfig, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { TOOLS_POLICIES, DEFAULT_MCP_NETWORK_POLICY, DEFAULT_LLM_GATEWAY_RATE_LIMIT, toolsDisabledSchema, workspacePolicySchema, ToolCapability, defaultConfig } from '@itphx/synth-shared';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../engine/permission/derive.js';
import { DEFAULT_AGENT_ID } from '../../engine/agents/index.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** AD-072 Ф2: эффективные дефолты LLM Gateway (config.yaml без runtime). */
const DEFAULT_LLM_GATEWAY: LlmGatewayRuntimeSettings = {
  enabled: false,
  inputMode: 'obfuscate',
  logPayloads: false,
  rateLimit: { ...DEFAULT_LLM_GATEWAY_RATE_LIMIT },
};

/** AD-072 Ф2: дефолты секции «Безопасность» (config.yaml без runtime). */
function resolveSecurityDefaults(fallback?: Partial<SecurityRuntimeSettings>): {
  protectedPaths: { enabled: boolean };
  askTimeoutMs: number;
} {
  return {
    protectedPaths: { enabled: fallback?.protectedPaths?.enabled ?? true },
    askTimeoutMs: fallback?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/** AD-072 Ф2: дефолты LLM Gateway (config.yaml без runtime), вложенный rateLimit мёржится по полям. */
function resolveLlmGatewayDefaults(fallback?: Partial<LlmGatewayRuntimeSettings>): LlmGatewayRuntimeSettings {
  return {
    enabled: fallback?.enabled ?? DEFAULT_LLM_GATEWAY.enabled,
    inputMode: fallback?.inputMode ?? DEFAULT_LLM_GATEWAY.inputMode,
    logPayloads: fallback?.logPayloads ?? DEFAULT_LLM_GATEWAY.logPayloads,
    rateLimit: {
      userPerMinute: fallback?.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY.rateLimit.userPerMinute,
      providerPerMinute: fallback?.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY.rateLimit.providerPerMinute,
    },
  };
}

/** AD-072 Ф2: runtime-поле присутствует в settings.json (объект с хотя бы одним ключом / скаляр). */
function hasOverride(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

/** AD-089: эффективные дефолты раздела «События» (config без runtime). */
function resolveEventsDefaults(fallback?: Partial<EventsRuntimeSettings>): EventsRuntimeSettings {
  const base = defaultConfig.events;
  return {
    enabled: fallback?.enabled ?? base.enabled,
    defaultMode: fallback?.defaultMode ?? base.defaultMode,
    ephemeralTtl: fallback?.ephemeralTtl ?? base.ephemeralTtl,
    journalRetentionDays: fallback?.journalRetentionDays ?? base.journalRetentionDays,
    allowedSources: fallback?.allowedSources ?? base.allowedSources,
    unknownAgentTemplate: fallback?.unknownAgentTemplate ?? base.unknownAgentTemplate,
    keyRateLimitPerMinute: fallback?.keyRateLimitPerMinute ?? base.keyRateLimitPerMinute,
    decisionRouting: fallback?.decisionRouting ?? base.decisionRouting,
  };
}

/** AD-089: валидация runtime-настроек раздела «События» (частичный патч). */
function validateEventsSettings(
  value: unknown,
): { ok: true; value: Partial<EventsRuntimeSettings> } | { ok: false; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'events: ожидается объект runtime-настроек раздела «События»' };
  }
  const s = value as Record<string, unknown>;
  const result: Partial<EventsRuntimeSettings> = {};

  if (s.enabled !== undefined) {
    if (typeof s.enabled !== 'boolean') return { ok: false, message: 'events.enabled: ожидается boolean' };
    result.enabled = s.enabled;
  }
  if (s.defaultMode !== undefined) {
    if (s.defaultMode !== 'bound' && s.defaultMode !== 'ephemeral') {
      return { ok: false, message: 'events.defaultMode: ожидается "bound" | "ephemeral"' };
    }
    result.defaultMode = s.defaultMode;
  }
  if (s.ephemeralTtl !== undefined) {
    if (typeof s.ephemeralTtl !== 'string' || s.ephemeralTtl.trim().length === 0) {
      return { ok: false, message: 'events.ephemeralTtl: ожидается непустая строка' };
    }
    result.ephemeralTtl = s.ephemeralTtl;
  }
  if (s.journalRetentionDays !== undefined) {
    if (!Number.isInteger(s.journalRetentionDays) || (s.journalRetentionDays as number) < 0) {
      return { ok: false, message: 'events.journalRetentionDays: ожидается целое >= 0' };
    }
    result.journalRetentionDays = s.journalRetentionDays as number;
  }
  if (s.allowedSources !== undefined) {
    if (!Array.isArray(s.allowedSources) || !s.allowedSources.every((x) => typeof x === 'string')) {
      return { ok: false, message: 'events.allowedSources: ожидается string[]' };
    }
    result.allowedSources = s.allowedSources as string[];
  }
  if (s.unknownAgentTemplate !== undefined) {
    if (s.unknownAgentTemplate !== 'drop' && s.unknownAgentTemplate !== 'default-agent') {
      return { ok: false, message: 'events.unknownAgentTemplate: ожидается "drop" | "default-agent"' };
    }
    result.unknownAgentTemplate = s.unknownAgentTemplate;
  }
  if (s.keyRateLimitPerMinute !== undefined) {
    if (!Number.isInteger(s.keyRateLimitPerMinute) || (s.keyRateLimitPerMinute as number) < 0) {
      return { ok: false, message: 'events.keyRateLimitPerMinute: ожидается целое >= 0' };
    }
    result.keyRateLimitPerMinute = s.keyRateLimitPerMinute as number;
  }
  if (s.decisionRouting !== undefined) {
    if (typeof s.decisionRouting !== 'boolean') {
      return { ok: false, message: 'events.decisionRouting: ожидается boolean' };
    }
    result.decisionRouting = s.decisionRouting;
  }
  return { ok: true, value: result };
}

/** AD-089: эффективные события = дефолты (config) поверх runtime-патча. */
function effectiveEvents(
  defaults: EventsRuntimeSettings,
  runtime: Partial<EventsRuntimeSettings>,
): EventsRuntimeSettings {
  return {
    enabled: runtime.enabled ?? defaults.enabled,
    defaultMode: runtime.defaultMode ?? defaults.defaultMode,
    ephemeralTtl: runtime.ephemeralTtl ?? defaults.ephemeralTtl,
    journalRetentionDays: runtime.journalRetentionDays ?? defaults.journalRetentionDays,
    allowedSources: runtime.allowedSources ?? defaults.allowedSources,
    unknownAgentTemplate: runtime.unknownAgentTemplate ?? defaults.unknownAgentTemplate,
    keyRateLimitPerMinute: runtime.keyRateLimitPerMinute ?? defaults.keyRateLimitPerMinute,
    decisionRouting: runtime.decisionRouting ?? defaults.decisionRouting,
  };
}

export interface SettingsRoutesDeps {
  /** Store runtime-настроек ({dataDir}/settings.json). */
  settingsStore: RuntimeSettingsStore;
  /** Значение по умолчанию (env > config > {dataDir}/workspaces/default), если runtime-настройка не задана. */
  fallbackWorkspace: string;
  /** AD-072 Ф2: дефолт LLM Gateway из config.yaml (без runtime) для GET/DELETE /llm-gateway. */
  fallbackLlmGateway?: Partial<LlmGatewayRuntimeSettings>;
  /** AD-072 Ф2: дефолт секции «Безопасность» из config.yaml для GET/DELETE /security. */
  fallbackSecurity?: Partial<SecurityRuntimeSettings>;
  /** Вызывается после успешного PUT /llm-gateway (live-применение runtime-настройки). */
  onLlmGatewayChange?: (runtime: Partial<LlmGatewayRuntimeSettings>) => void | Promise<void>;
  /** Вызывается после успешного PUT /security (live-применение тумблера защищённых путей). */
  onSecurityChange?: (runtime: Partial<SecurityRuntimeSettings>) => void | Promise<void>;
  /** AD-071 §2.3: значение tools.policy из config.yaml (если runtime не задан). */
  fallbackToolsPolicy?: ToolsPolicy;
  /** Вызывается после успешного PUT /tools-policy (live-применение политики встроенных инструментов). */
  onToolsPolicyChange?: (policy: ToolsPolicy) => void | Promise<void>;
  /** AD-071 §2.3: значение mcp.policy из config.yaml (если runtime не задан). */
  fallbackMcpPolicy?: ToolsPolicy;
  /** Вызывается после успешного PUT /mcp-policy (live-применение политики MCP-инструментов). */
  onMcpPolicyChange?: (policy: ToolsPolicy) => void | Promise<void>;
  /** AD-071 §2.3.1: значение mcp.networkPolicy из config.yaml (если runtime не задан). */
  fallbackMcpNetworkPolicy?: McpNetworkPolicy;
  /** Вызывается после успешного PUT /mcp-network-policy (live-применение). */
  onMcpNetworkPolicyChange?: (policy: McpNetworkPolicy) => void | Promise<void>;
  /** AD-071 §2.6: значение tools.disabled из config.yaml (если runtime не задан). */
  fallbackToolsDisabled?: ToolsDisabledConfig;
  /** Вызывается после успешного PUT /tools-disabled (live-применение). */
  onToolsDisabledChange?: (config: ToolsDisabledConfig) => void | Promise<void>;
  /**
   * AD-071 §2.6: известные инструменты (имя → capabilities) для защиты
   * `runtime`-тулов от отключения. Не задан — проверка по имени пропускается
   * (capability `runtime` всё равно отклоняется).
   */
  knownTools?: () => Array<{ name: string; capabilities: string[] }>;
  /** Store override политики защищённых путей ({dataDir}/security/protected-paths.json). */
  protectedPathsStore?: ProtectedPathsStore;
  /** Агент по умолчанию из config.yaml (если runtime не задан); иначе — `DEFAULT_AGENT_ID`. */
  fallbackDefaultAgent?: string;
  /** Вызывается после успешного PUT /default-agent (live-применение). */
  onDefaultAgentChange?: (id: string) => void | Promise<void>;
  /**
   * AD-075: дефолт политики для абсолютного workspace вне `workspacesRoot`
   * (config.yaml/env), если runtime-настройка не задана. По умолчанию — `confirm`.
   */
  fallbackWorkspaceOutsideRootPolicy?: WorkspaceOutsideRootPolicy;
  /** Вызывается после успешного PUT /workspace-policy (live-применение в роутах проектов). */
  onWorkspacePolicyChange?: (policy: WorkspaceOutsideRootPolicy) => void | Promise<void>;
  /**
   * AD-075: managed-развёртывание — политика вне `workspacesRoot` задаётся
   * развёртыванием (`fallbackWorkspaceOutsideRootPolicy: 'deny'`). При `true`
   * GET отдаёт fallback без override + `readOnly: true`, а PUT/DELETE → 403
   * `WORKSPACE_POLICY_READ_ONLY`. Standalone (по умолчанию `false`) не меняется.
   */
  workspacePolicyReadOnly?: boolean;
  /** AD-089: дефолт раздела «События» из config.yaml для GET/DELETE-сброса. */
  fallbackEvents?: Partial<EventsRuntimeSettings>;
  /** AD-089: вызывается после успешного PUT/DELETE /events — live-применение. */
  onEventsChange?: (effective: EventsRuntimeSettings) => void | Promise<void>;
}

/** Опции фабрики настроек (guard'ы). */
export interface SettingsRoutesOptions {
  /**
   * Guard на мутации раздела «События» (PUT/DELETE /events); по умолчанию —
   * `auth.requireAuth`. Backend передаёт `requirePermission('ADMIN')`.
   */
  eventsWriteGuard?: Middleware;
}

/** AD-071 §2.3: валидна ли политика включения инструментов. */
function isValidToolsPolicy(value: unknown): value is ToolsPolicy {
  return typeof value === 'string' && (TOOLS_POLICIES as readonly string[]).includes(value);
}

/** Формат id агента (совпадает с валидацией в роутах /agents). */
const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

/** Валиден ли id агента: непустая строка латиницы/цифр/дефиса/подчёркивания. */
function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && AGENT_ID_REGEX.test(value.trim());
}

/** AD-071 §2.3.1: валидна ли политика сетевого доступа MCP ({ mode, list }). */
function isValidMcpNetworkPolicy(value: unknown): value is McpNetworkPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.mode !== 'allow' && p.mode !== 'deny') return false;
  if (!Array.isArray(p.list) || !p.list.every((x) => typeof x === 'string' && x.trim().length > 0)) return false;
  return true;
}

/**
 * AD-071 §2.6: валидация `tools.disabled`. Структура — Zod-схемой
 * (`toolsDisabledSchema`), поэтому неизвестная capability отклоняется (закрытый
 * набор: опечатка молча ничего бы не отключила). Имена инструментов — свободные
 * строки (реестр динамический: MCP-тулы регистрируются лениво), но инструмент
 * с capability `runtime` (ядро сессии) отключать нельзя — 400.
 */
function validateToolsDisabled(
  value: unknown,
  knownTools?: () => Array<{ name: string; capabilities: string[] }>,
): { ok: true; config: ToolsDisabledConfig } | { ok: false; message: string } {
  const parsed = toolsDisabledSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `toolsDisabled: ожидается { capabilities: ToolCapability[], tools: string[] } (${issue?.message ?? 'невалидная структура'})`,
    };
  }
  const config: ToolsDisabledConfig = {
    capabilities: parsed.data.capabilities,
    tools: parsed.data.tools,
  };
  if (config.capabilities.includes(ToolCapability.RUNTIME)) {
    return {
      ok: false,
      message: `capability "${ToolCapability.RUNTIME}" неотключаема — это ядро сессии (plan/todo/project/reference/classify)`,
    };
  }
  if (knownTools) {
    const known = new Map(knownTools().map((tool) => [tool.name, tool.capabilities]));
    for (const name of config.tools) {
      if (known.get(name)?.includes(ToolCapability.RUNTIME)) {
        return {
          ok: false,
          message: `инструмент "${name}" неотключаем — capability "${ToolCapability.RUNTIME}" (ядро сессии)`,
        };
      }
    }
  }
  return { ok: true, config };
}

function isValidAvailability(value: unknown): value is McpToolAvailability {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).plan === 'boolean'
    && typeof (value as Record<string, unknown>).act === 'boolean';
}

function isValidMcpServers(servers: unknown): servers is Record<string, McpServerToolSettings> {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  for (const [serverName, server] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof serverName !== 'string' || !serverName.trim()) return false;
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const s = server as Record<string, unknown>;
    if (s.default !== undefined && !isValidAvailability(s.default)) return false;
    if (s.tools !== undefined) {
      if (!s.tools || typeof s.tools !== 'object' || Array.isArray(s.tools)) return false;
      for (const [toolName, avail] of Object.entries(s.tools as Record<string, unknown>)) {
        if (typeof toolName !== 'string' || !toolName.trim()) return false;
        if (!isValidAvailability(avail)) return false;
      }
    }
  }
  return true;
}

/** Валидация runtime-настроек LLM Gateway: допустимы только известные поля. */
function isValidLlmGatewaySettings(value: unknown): value is Partial<LlmGatewayRuntimeSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') return false;
  if (s.inputMode !== undefined && s.inputMode !== 'obfuscate' && s.inputMode !== 'block') return false;
  if (s.logPayloads !== undefined && typeof s.logPayloads !== 'boolean') return false;
  if (s.rateLimit !== undefined) {
    const rl = s.rateLimit as Record<string, unknown>;
    if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return false;
    if (rl.userPerMinute !== undefined && (!Number.isInteger(rl.userPerMinute) || (rl.userPerMinute as number) < 1)) return false;
    if (rl.providerPerMinute !== undefined && (!Number.isInteger(rl.providerPerMinute) || (rl.providerPerMinute as number) < 1)) return false;
  }
  return true;
}

/** Валидация runtime-настроек секции «Безопасность»: protectedPaths.enabled + askTimeoutMs. */
function isValidSecuritySettings(value: unknown): value is Partial<SecurityRuntimeSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.protectedPaths !== undefined) {
    const pp = s.protectedPaths as Record<string, unknown>;
    if (!pp || typeof pp !== 'object' || Array.isArray(pp)) return false;
    if (pp.enabled !== undefined && typeof pp.enabled !== 'boolean') return false;
  }
  if (s.askTimeoutMs !== undefined && (!Number.isInteger(s.askTimeoutMs) || (s.askTimeoutMs as number) < 0)) return false;
  return true;
}

/** Валидация эффективной политики защищённых путей: четырёх списков строк. */
function isValidProtectedPathsPolicy(value: unknown): value is ProtectedPathsPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return isStringArray(p.deniedPaths) && isStringArray(p.deniedPrefixes)
    && isStringArray(p.approvalPaths) && isStringArray(p.deniedCommandPrefixes);
}

/** Валидация сырого override (add/remove): add/remove — объекты с массивами строк, version — число. */
function isValidProtectedPathsOverride(value: unknown): value is { version?: number; add: Record<string, unknown>; remove: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (o.version !== undefined && typeof o.version !== 'number') return false;
  const isStringArray = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  for (const section of ['add', 'remove'] as const) {
    const s = o[section];
    if (s === undefined) continue;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    const sp = s as Record<string, unknown>;
    if (!isStringArray(sp.deniedPaths) || !isStringArray(sp.deniedPrefixes)
      || !isStringArray(sp.approvalPaths) || !isStringArray(sp.deniedCommandPrefixes)) return false;
  }
  return true;
}

/**
 * Настройки приложения для UI (раздел «Проекты»).
 *
 * GET/PUT /api/v2/settings/workspace — рабочий каталог по умолчанию.
 * Значение сохраняется в {dataDir}/settings.json (AD-005, атомарно) и
 * переживает рестарт: при старте createStandaloneApp читает его и применяет
 * в приоритете над config.yaml.
 */
export function createSettingsRoutes(
  auth: AuthKit,
  deps: SettingsRoutesDeps,
  opts: SettingsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const eventsWriteGuard: Middleware = opts.eventsWriteGuard ?? auth.requireAuth;

  app.get('/workspace', auth.requireAuth, async (c) => {
    const runtimeWorkspace = await deps.settingsStore.getWorkspace();
    return c.json({
      workspace: runtimeWorkspace ?? deps.fallbackWorkspace,
      isOverridden: runtimeWorkspace !== undefined,
      defaults: deps.fallbackWorkspace,
    });
  });

  app.put('/workspace', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';

    if (!workspace) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Поле workspace обязательно и не может быть пустым' },
      }, 400);
    }

    await deps.settingsStore.setWorkspace(workspace);
    return c.json({ workspace });
  });

  app.delete('/workspace', auth.requireAuth, async (c) => {
    await deps.settingsStore.clearWorkspace();
    return c.json({
      status: 'restored',
      workspace: deps.fallbackWorkspace,
      isOverridden: false,
      defaults: deps.fallbackWorkspace,
    });
  });

  app.get('/mcp', auth.requireAuth, async (c) => {
    const servers = await deps.settingsStore.getMcpSettings();
    return c.json({ servers, isOverridden: hasOverride(servers), defaults: {} });
  });

  app.put('/mcp', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const servers = (body as { servers?: unknown }).servers;

    if (!isValidMcpServers(servers)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'servers: ожидается структура { "<serverName>": { default: { plan, act }, tools: { "<toolName>": { plan, act } } } }',
        },
      }, 400);
    }

    await deps.settingsStore.setMcpSettings(servers);
    return c.json({ servers });
  });

  app.delete('/mcp', auth.requireAuth, async (c) => {
    await deps.settingsStore.clearMcpSettings();
    return c.json({ status: 'restored', servers: {}, isOverridden: false, defaults: {} });
  });

  /**
   * GET/PUT /api/v2/settings/llm-gateway — глобальные настройки LLM Gateway (AD-036).
   * Тумблер включается/выключается через UI (раздел «Шлюз безопасности», только ADMIN).
   * Значение сохраняется в {dataDir}/settings.json (AD-005) и переживает рестарт.
   */
  app.get('/llm-gateway', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getLlmGatewaySettings();
    const defaults = resolveLlmGatewayDefaults(deps.fallbackLlmGateway);
    const llmGateway = {
      enabled: runtime.enabled ?? defaults.enabled,
      inputMode: runtime.inputMode ?? defaults.inputMode,
      logPayloads: runtime.logPayloads ?? defaults.logPayloads,
      rateLimit: {
        userPerMinute: runtime.rateLimit?.userPerMinute ?? defaults.rateLimit.userPerMinute,
        providerPerMinute: runtime.rateLimit?.providerPerMinute ?? defaults.rateLimit.providerPerMinute,
      },
    };
    return c.json({ llmGateway, isOverridden: hasOverride(runtime), defaults });
  });

  app.put('/llm-gateway', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const llmGateway = (body as { llmGateway?: unknown }).llmGateway;

    if (!isValidLlmGatewaySettings(llmGateway)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'llmGateway: ожидается { enabled?: boolean, inputMode?: "obfuscate"|"block", logPayloads?: boolean, rateLimit?: { userPerMinute, providerPerMinute } }',
        },
      }, 400);
    }

    await deps.settingsStore.setLlmGatewaySettings(llmGateway);
    // AD-036: live-применение runtime-настройки — оркестратор переконфигурируется без рестарта.
    await deps.onLlmGatewayChange?.(llmGateway);
    return c.json({ llmGateway });
  });

  app.delete('/llm-gateway', auth.requireAuth, async (c) => {
    await deps.settingsStore.clearLlmGatewaySettings();
    // Пустой runtime → mergeLlmGatewayConfig вернёт config.yaml (или undefined — шлюз выключен).
    await deps.onLlmGatewayChange?.({});
    const defaults = resolveLlmGatewayDefaults(deps.fallbackLlmGateway);
    return c.json({ status: 'restored', llmGateway: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT /api/v2/settings/security — глобальные настройки секции «Безопасность».
   * Тумблер защищённых путей + глобальный таймаут подтверждения (askTimeoutMs)
   * настраиваются через UI (только ADMIN). Значение сохраняется в
   * {dataDir}/settings.json (AD-005) и переживает рестарт.
   */
  app.get('/security', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getSecuritySettings();
    const defaults = resolveSecurityDefaults(deps.fallbackSecurity);
    return c.json({
      security: {
        protectedPaths: { enabled: runtime.protectedPaths?.enabled ?? defaults.protectedPaths.enabled },
        askTimeoutMs: runtime.askTimeoutMs ?? defaults.askTimeoutMs,
      },
      isOverridden: hasOverride(runtime),
      defaults,
    });
  });

  app.put('/security', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const security = (body as { security?: unknown }).security;

    if (!isValidSecuritySettings(security)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'security: ожидается { protectedPaths?: { enabled?: boolean }, askTimeoutMs?: number }',
        },
      }, 400);
    }

    await deps.settingsStore.setSecuritySettings(security);
    // Live-применение тумблера защищённых путей + таймаута подтверждения —
    // оркестратор переконфигурируется без рестарта.
    await deps.onSecurityChange?.(security);
    return c.json({
      security: {
        protectedPaths: { enabled: security.protectedPaths?.enabled ?? true },
        askTimeoutMs: security.askTimeoutMs,
      },
    });
  });

  app.delete('/security', auth.requireAuth, async (c) => {
    await deps.settingsStore.clearSecuritySettings();
    // Пустой runtime → mergeSecurityConfig вернёт config.yaml.
    await deps.onSecurityChange?.({});
    const defaults = resolveSecurityDefaults(deps.fallbackSecurity);
    return c.json({ status: 'restored', security: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT /api/v2/settings/tools-policy — AD-071 §2.3: глобальная админская
   * политика включения инструментов (`consistency` | `available` | `auto`).
   * Runtime-значение ({dataDir}/settings.json) приоритетнее config.yaml;
   * per-session override — `session.settings.toolsPolicy`.
   */
  app.get('/tools-policy', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getToolsPolicy();
    const defaults = deps.fallbackToolsPolicy ?? 'auto';
    return c.json({ toolsPolicy: runtime ?? defaults, isOverridden: runtime !== undefined, defaults });
  });

  app.put('/tools-policy', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const toolsPolicy = (body as { toolsPolicy?: unknown }).toolsPolicy;

    if (!isValidToolsPolicy(toolsPolicy)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'toolsPolicy: ожидается "consistency" | "available" | "auto"',
        },
      }, 400);
    }

    await deps.settingsStore.setToolsPolicy(toolsPolicy);
    // Live-применение политики встроенных инструментов — оркестратор
    // переконфигурируется без рестарта сервера.
    await deps.onToolsPolicyChange?.(toolsPolicy);
    return c.json({ toolsPolicy });
  });

  app.delete('/tools-policy', auth.requireAuth, async (c) => {
    const defaults = deps.fallbackToolsPolicy ?? 'auto';
    await deps.settingsStore.clearToolsPolicy();
    // Live-применение дефолта из config.yaml.
    await deps.onToolsPolicyChange?.(defaults);
    return c.json({ status: 'restored', toolsPolicy: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT /api/v2/settings/mcp-policy — AD-071 §2.3: глобальная админская
   * политика включения **MCP**-инструментов (`consistency` | `available` |
   * `auto`). Независима от `tools.policy` (встроенные). Runtime-значение
   * ({dataDir}/settings.json) приоритетнее config.yaml `mcp.policy`;
   * per-session override — `session.settings.mcpPolicy`.
   */
  app.get('/mcp-policy', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getMcpPolicy();
    const defaults = deps.fallbackMcpPolicy ?? 'auto';
    return c.json({ mcpPolicy: runtime ?? defaults, isOverridden: runtime !== undefined, defaults });
  });

  app.put('/mcp-policy', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const mcpPolicy = (body as { mcpPolicy?: unknown }).mcpPolicy;

    if (!isValidToolsPolicy(mcpPolicy)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'mcpPolicy: ожидается "consistency" | "available" | "auto"',
        },
      }, 400);
    }

    await deps.settingsStore.setMcpPolicy(mcpPolicy);
    // Live-применение политики MCP-инструментов — оркестратор
    // переконфигурируется без рестарта сервера.
    await deps.onMcpPolicyChange?.(mcpPolicy);
    return c.json({ mcpPolicy });
  });

  app.delete('/mcp-policy', auth.requireAuth, async (c) => {
    const defaults = deps.fallbackMcpPolicy ?? 'auto';
    await deps.settingsStore.clearMcpPolicy();
    await deps.onMcpPolicyChange?.(defaults);
    return c.json({ status: 'restored', mcpPolicy: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT /api/v2/settings/mcp-network-policy — AD-071 §2.3.1: политика
   * сетевого доступа пользовательских HTTP MCP-серверов (`allow`/`deny` +
   * список host/CIDR). Runtime-значение ({dataDir}/settings.json) приоритетнее
   * config.yaml `mcp.networkPolicy`; дефолт — deny приватных диапазонов.
   */
  app.get('/mcp-network-policy', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getMcpNetworkPolicy();
    const defaults = deps.fallbackMcpNetworkPolicy ?? DEFAULT_MCP_NETWORK_POLICY;
    return c.json({ policy: runtime ?? defaults, isOverridden: runtime !== undefined, defaults });
  });

  app.put('/mcp-network-policy', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const policy = (body as { policy?: unknown }).policy;

    if (!isValidMcpNetworkPolicy(policy)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'policy: ожидается { mode: "allow" | "deny", list: string[] }',
        },
      }, 400);
    }

    await deps.settingsStore.setMcpNetworkPolicy(policy);
    // Live-применение политики сетевого доступа — McpManager переконфигурируется
    // без рестарта сервера.
    await deps.onMcpNetworkPolicyChange?.(policy);
    return c.json({ policy });
  });

  app.delete('/mcp-network-policy', auth.requireAuth, async (c) => {
    const defaults = deps.fallbackMcpNetworkPolicy ?? DEFAULT_MCP_NETWORK_POLICY;
    await deps.settingsStore.clearMcpNetworkPolicy();
    await deps.onMcpNetworkPolicyChange?.(defaults);
    return c.json({ status: 'restored', policy: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT/DELETE /api/v2/settings/default-agent — агент по умолчанию
   * (админка «Агенты»): используется при создании сессии без `settings.agentRole`
   * и как `default_agent` в ответах `/api/v2/agents`. Runtime-значение
   * ({dataDir}/settings.json) приоритетнее `fallbackDefaultAgent`
   * (config.yaml), иначе — `DEFAULT_AGENT_ID` ('assistant' при первом развёртывании).
   */
  app.get('/default-agent', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getDefaultAgent();
    const fallback = deps.fallbackDefaultAgent ?? DEFAULT_AGENT_ID;
    return c.json({
      defaultAgent: runtime ?? fallback,
      isOverridden: runtime !== undefined,
      defaults: fallback,
    });
  });

  app.put('/default-agent', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { defaultAgent?: unknown }).defaultAgent;
    const defaultAgent = typeof raw === 'string' ? raw.trim() : raw;

    if (!isValidAgentId(defaultAgent)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'defaultAgent: ожидается непустой id агента (латиница, цифры, дефис, подчёркивание)',
        },
      }, 400);
    }

    await deps.settingsStore.setDefaultAgent(defaultAgent);
    await deps.onDefaultAgentChange?.(defaultAgent);
    return c.json({ defaultAgent });
  });

  app.delete('/default-agent', auth.requireAuth, async (c) => {
    const fallback = deps.fallbackDefaultAgent ?? DEFAULT_AGENT_ID;
    await deps.settingsStore.clearDefaultAgent();
    await deps.onDefaultAgentChange?.(fallback);
    return c.json({ status: 'restored', defaultAgent: fallback, isOverridden: false, defaults: fallback });
  });

  /**
   * AD-075: GET/PUT/DELETE /api/v2/settings/workspace-policy — политика для
   * абсолютного `project.workspace` вне `workspacesRoot` (`confirm` | `deny`).
   * Runtime-значение ({dataDir}/settings.json) приоритетнее config.yaml/env;
   * на managed-развёртывании (`workspacePolicyReadOnly: true`) — строго
   * read-only: эффективно всегда `deny` (enforcement — backend).
   */
  app.get('/workspace-policy', auth.requireAuth, async (c) => {
    const defaults = deps.fallbackWorkspaceOutsideRootPolicy ?? 'confirm';
    if (deps.workspacePolicyReadOnly) {
      // Managed: эффективная политика всегда fallback (enforcement — развёртывание).
      return c.json({ outsideRoot: defaults, isOverridden: false, defaults, readOnly: true });
    }
    const runtime = await deps.settingsStore.getWorkspacePolicy();
    return c.json({ outsideRoot: runtime ?? defaults, isOverridden: runtime !== undefined, defaults });
  });

  app.put('/workspace-policy', auth.requireAuth, async (c) => {
    if (deps.workspacePolicyReadOnly) {
      return c.json({
        error: {
          code: 'WORKSPACE_POLICY_READ_ONLY',
          message: 'Политика путей вне корня workspace задаётся развёртыванием (managed) и не может быть изменена',
        },
      }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = workspacePolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'outsideRoot: ожидается "confirm" | "deny"' },
      }, 400);
    }

    await deps.settingsStore.setWorkspacePolicy(parsed.data.outsideRoot);
    // Live-применение — роуты проектов читают политику без рестарта.
    await deps.onWorkspacePolicyChange?.(parsed.data.outsideRoot);
    return c.json({ outsideRoot: parsed.data.outsideRoot });
  });

  app.delete('/workspace-policy', auth.requireAuth, async (c) => {
    if (deps.workspacePolicyReadOnly) {
      return c.json({
        error: {
          code: 'WORKSPACE_POLICY_READ_ONLY',
          message: 'Политика путей вне корня workspace задаётся развёртыванием (managed) и не может быть изменена',
        },
      }, 403);
    }
    const defaults = deps.fallbackWorkspaceOutsideRootPolicy ?? 'confirm';
    await deps.settingsStore.clearWorkspacePolicy();
    await deps.onWorkspacePolicyChange?.(defaults);
    return c.json({ status: 'restored', outsideRoot: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT /api/v2/settings/tools-disabled — AD-071 §2.6: instance-wide
   * жёсткое отключение инструментов администратором (`capabilities` + `tools`).
   * Отключённые тулы не попадают в запрос независимо от `tools.policy`;
   * `runtime`-capability (ядро сессии) неотключаема. Runtime-значение
   * ({dataDir}/settings.json) приоритетнее config.yaml `tools.disabled`.
   */
  app.get('/tools-disabled', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getToolsDisabled();
    const defaults = deps.fallbackToolsDisabled ?? { capabilities: [], tools: [] };
    return c.json({ toolsDisabled: runtime ?? defaults, isOverridden: runtime !== undefined, defaults });
  });

  app.put('/tools-disabled', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = validateToolsDisabled(
      (body as { toolsDisabled?: unknown }).toolsDisabled,
      deps.knownTools,
    );
    if (!result.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: result.message } }, 400);
    }

    await deps.settingsStore.setToolsDisabled(result.config);
    // Live-применение — оркестратор переконфигурируется без рестарта.
    await deps.onToolsDisabledChange?.(result.config);
    return c.json({ toolsDisabled: result.config });
  });

  app.delete('/tools-disabled', auth.requireAuth, async (c) => {
    const defaults = deps.fallbackToolsDisabled ?? { capabilities: [], tools: [] };
    await deps.settingsStore.clearToolsDisabled();
    await deps.onToolsDisabledChange?.(defaults);
    return c.json({ status: 'restored', toolsDisabled: defaults, isOverridden: false, defaults });
  });

  /**
   * GET/PUT/DELETE /api/v2/settings/protected-paths — override политики защищённых
   * путей ({dataDir}/security/protected-paths.json, формат add/remove, version: 1).
   * GET — эффективная политика + системный base + признак override;
   * PUT — сохранить эффективную политику (каскад вычисляется относительно base);
   * DELETE — сбросить к системной политике.
   */
  app.get('/protected-paths', auth.requireAuth, async (c) => {
    if (!deps.protectedPathsStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'protectedPathsStore не доступен в standalone-режиме' } }, 404);
    }
    const raw = deps.protectedPathsStore.getRaw();
    return c.json({
      policy: raw.policy,
      base: raw.base,
      is_overridden: raw.isOverridden,
    });
  });

  app.put('/protected-paths', auth.requireAuth, async (c) => {
    if (!deps.protectedPathsStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'protectedPathsStore не доступен в standalone-режиме' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const policy = (body as { policy?: unknown }).policy;

    // Поддерживаем два формата: эффективная политика (policy) ИЛИ сырой override (add/remove).
    if (isValidProtectedPathsPolicy(policy)) {
      const ok = await deps.protectedPathsStore.savePolicy(policy);
      if (!ok) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Не удалось сохранить политику защищённых путей' } }, 400);
      }
    } else if (isValidProtectedPathsOverride(body)) {
      const ok = await deps.protectedPathsStore.saveRawOverride(body as Partial<ProtectedPathsOverride>);
      if (!ok) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Не удалось сохранить override защищённых путей' } }, 400);
      }
    } else {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'ожидается { policy: { deniedPaths, deniedPrefixes, approvalPaths, deniedCommandPrefixes } } или { version, add, remove }',
        },
      }, 400);
    }

    const raw = deps.protectedPathsStore.getRaw();
    return c.json({ policy: raw.policy, base: raw.base, is_overridden: raw.isOverridden, saved: true });
  });

  app.delete('/protected-paths', auth.requireAuth, async (c) => {
    if (!deps.protectedPathsStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'protectedPathsStore не доступен в standalone-режиме' } }, 404);
    }
    await deps.protectedPathsStore.reset();
    return c.json({ status: 'restored' });
  });

  /**
   * AD-089: GET/PUT/DELETE /api/v2/settings/events — runtime-настройки раздела
   * «События» (мастер-выключатель, режим маршрутизации, TTL ephemeral, retention
   * журнала, белый список источников, политика неизвестного агента, per-key
   * rate limit). Runtime-значение ({dataDir}/settings.json) приоритетнее
   * config.yaml `events`; live-применение — через `onEventsChange`.
   */
  app.get('/events', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getEvents();
    const defaults = resolveEventsDefaults(deps.fallbackEvents);
    return c.json({
      events: effectiveEvents(defaults, runtime),
      defaults,
      isOverridden: hasOverride(runtime),
    });
  });

  app.put('/events', eventsWriteGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = validateEventsSettings((body as { events?: unknown }).events);
    if (!result.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: result.message } }, 400);
    }

    await deps.settingsStore.setEvents(result.value);
    const defaults = resolveEventsDefaults(deps.fallbackEvents);
    const effective = effectiveEvents(defaults, result.value);
    // Live-применение — Router/funnel/pruner переконфигурируются без рестарта.
    await deps.onEventsChange?.(effective);
    return c.json({ events: effective });
  });

  app.delete('/events', eventsWriteGuard, async (c) => {
    await deps.settingsStore.clearEvents();
    const defaults = resolveEventsDefaults(deps.fallbackEvents);
    // Пустой runtime → эффективные значения = config.yaml/defaults.
    await deps.onEventsChange?.(defaults);
    return c.json({ status: 'restored', events: defaults, isOverridden: false, defaults });
  });

  return app;
}
