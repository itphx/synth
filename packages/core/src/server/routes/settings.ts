import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { RuntimeSettingsStore, LlmGatewayRuntimeSettings, SecurityRuntimeSettings } from '../../storage/runtime-settings.js';
import type { ProtectedPathsStore } from '../../engine/security/protected-paths-store.js';
import type { ProtectedPathsPolicy, ProtectedPathsOverride } from '../../engine/security/protected-paths.js';
import type { McpServerToolSettings, McpToolAvailability, ToolsPolicy, McpNetworkPolicy, ToolsDisabledConfig } from '@itphx/synth-shared';
import { TOOLS_POLICIES, DEFAULT_MCP_NETWORK_POLICY, toolsDisabledSchema, ToolCapability } from '@itphx/synth-shared';

export interface SettingsRoutesDeps {
  /** Store runtime-настроек ({dataDir}/settings.json). */
  settingsStore: RuntimeSettingsStore;
  /** Значение по умолчанию (env > config > {dataDir}/workspaces/default), если runtime-настройка не задана. */
  fallbackWorkspace: string;
  /** Вызывается после успешного PUT /llm-gateway (live-применение runtime-настройки). */
  onLlmGatewayChange?: (runtime: Partial<LlmGatewayRuntimeSettings>) => void | Promise<void>;
  /** Вызывается после успешного PUT /security (live-применение тумблера защищённых путей). */
  onSecurityChange?: (runtime: Partial<SecurityRuntimeSettings>) => void | Promise<void>;
  /** AD-071 §2.3: значение tools.policy из config.yaml (если runtime не задан). */
  fallbackToolsPolicy?: ToolsPolicy;
  /** Вызывается после успешного PUT /tools-policy (live-применение политики инструментов). */
  onToolsPolicyChange?: (policy: ToolsPolicy) => void | Promise<void>;
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
}

/** AD-071 §2.3: валидна ли политика включения инструментов. */
function isValidToolsPolicy(value: unknown): value is ToolsPolicy {
  return typeof value === 'string' && (TOOLS_POLICIES as readonly string[]).includes(value);
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
): Hono {
  const app = new Hono();

  app.get('/workspace', auth.requireAuth, async (c) => {
    const runtimeWorkspace = await deps.settingsStore.getWorkspace();
    return c.json({ workspace: runtimeWorkspace ?? deps.fallbackWorkspace });
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

  app.get('/mcp', auth.requireAuth, async (c) => {
    const servers = await deps.settingsStore.getMcpSettings();
    return c.json({ servers });
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

  /**
   * GET/PUT /api/v2/settings/llm-gateway — глобальные настройки LLM Gateway (AD-036).
   * Тумблер включается/выключается через UI (раздел «Шлюз безопасности», только ADMIN).
   * Значение сохраняется в {dataDir}/settings.json (AD-005) и переживает рестарт.
   */
  app.get('/llm-gateway', auth.requireAuth, async (c) => {
    const llmGateway = await deps.settingsStore.getLlmGatewaySettings();
    return c.json({ llmGateway });
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

  /**
   * GET/PUT /api/v2/settings/security — глобальные настройки секции «Безопасность».
   * Тумблер защищённых путей + глобальный таймаут подтверждения (askTimeoutMs)
   * настраиваются через UI (только ADMIN). Значение сохраняется в
   * {dataDir}/settings.json (AD-005) и переживает рестарт.
   */
  app.get('/security', auth.requireAuth, async (c) => {
    const security = await deps.settingsStore.getSecuritySettings();
    return c.json({
      security: {
        protectedPaths: { enabled: security.protectedPaths?.enabled ?? true },
        askTimeoutMs: security.askTimeoutMs ?? 30_000,
      },
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

  /**
   * GET/PUT /api/v2/settings/tools-policy — AD-071 §2.3: глобальная админская
   * политика включения инструментов (`consistency` | `available` | `auto`).
   * Runtime-значение ({dataDir}/settings.json) приоритетнее config.yaml;
   * per-session override — `session.settings.toolsPolicy`.
   */
  app.get('/tools-policy', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getToolsPolicy();
    return c.json({ toolsPolicy: runtime ?? deps.fallbackToolsPolicy ?? 'consistency' });
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
    // Live-применение политики инструментов — оркестратор переконфигурируется
    // без рестарта сервера.
    await deps.onToolsPolicyChange?.(toolsPolicy);
    return c.json({ toolsPolicy });
  });

  /**
   * GET/PUT /api/v2/settings/mcp-network-policy — AD-071 §2.3.1: политика
   * сетевого доступа пользовательских HTTP MCP-серверов (`allow`/`deny` +
   * список host/CIDR). Runtime-значение ({dataDir}/settings.json) приоритетнее
   * config.yaml `mcp.networkPolicy`; дефолт — deny приватных диапазонов.
   */
  app.get('/mcp-network-policy', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getMcpNetworkPolicy();
    const policy = runtime ?? deps.fallbackMcpNetworkPolicy ?? DEFAULT_MCP_NETWORK_POLICY;
    return c.json({ policy });
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

  /**
   * GET/PUT /api/v2/settings/tools-disabled — AD-071 §2.6: instance-wide
   * жёсткое отключение инструментов администратором (`capabilities` + `tools`).
   * Отключённые тулы не попадают в запрос независимо от `tools.policy`;
   * `runtime`-capability (ядро сессии) неотключаема. Runtime-значение
   * ({dataDir}/settings.json) приоритетнее config.yaml `tools.disabled`.
   */
  app.get('/tools-disabled', auth.requireAuth, async (c) => {
    const runtime = await deps.settingsStore.getToolsDisabled();
    const config = runtime ?? deps.fallbackToolsDisabled ?? { capabilities: [], tools: [] };
    return c.json({ toolsDisabled: config });
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

  return app;
}
