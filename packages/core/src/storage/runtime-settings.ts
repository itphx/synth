import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';
import type { McpServerToolSettings, LLMGatewayConfig, McpNetworkPolicy, SecurityConfig, ToolsPolicy, ToolsDisabledConfig, SkillsDisabledRequest, WorkspaceOutsideRootPolicy, SynthConfig, DecisionConfig } from '@itphx/synth-shared';
import { DEFAULT_LLM_GATEWAY_RATE_LIMIT } from '@itphx/synth-shared';
import { DEFAULT_ASK_TIMEOUT_MS } from '../engine/permission/derive.js';

/** Runtime-настройки LLM Gateway, сохраняемые через UI (раздел «Шлюз безопасности»). */
export interface LlmGatewayRuntimeSettings {
  enabled: boolean;
  inputMode: 'obfuscate' | 'block';
  /** Полное логирование запросов/ответов LLM (после обфускации) в JSONL. */
  logPayloads?: boolean;
  rateLimit: {
    userPerMinute: number;
    providerPerMinute: number;
  };
}

/** Runtime-настройки секции «Безопасность», сохраняемые через UI. */
export interface SecurityRuntimeSettings {
  protectedPaths?: {
    enabled: boolean;
  };
  /** Глобальный дефолт таймаута подтверждения ask (мс). Переживает рестарт. */
  askTimeoutMs?: number;
}

/**
 * AD-089: runtime-настройки раздела «События» (админка), сохраняемые через UI.
 * Эффективные значения = `mergeEventsConfig(config.eventsConfig, runtime)`.
 * `dedupStore` намеренно не входит — это deployment-настройка, не runtime.
 */
export interface EventsRuntimeSettings {
  enabled: boolean;
  defaultMode: 'bound' | 'ephemeral';
  ephemeralTtl: string;
  journalRetentionDays: number;
  allowedSources: string[];
  unknownAgentTemplate: 'drop' | 'default-agent';
  /** Глобальный дефолт лимита запросов/мин на API-ключ привязки (0 — без лимита). */
  keyRateLimitPerMinute: number;
  /**
   * AD-084 × AD-089: decision-маршрутизация внешних событий (opt-in).
   * `false` — только декларативные правила; `true` — при промахе правил
   * decision-модель выбирает шаблон агента (fail-safe → `defaultMode`).
   */
  decisionRouting: boolean;
}

/**
 * AD-084: runtime-настройки decision-слоя (админка), сохраняемые через UI.
 * Эффективные значения = `mergeDecisionConfig(config.decisionConfig, runtime)`.
 */
export type DecisionRuntimeSettings = Partial<DecisionConfig>;

export interface RuntimeSettings {
  /** Рабочий каталог по умолчанию, заданный через UI (раздел «Проекты»). */
  workspace?: string;
  /** Глобальные настройки доступности MCP-серверов по режимам plan/act. */
  mcpServers?: Record<string, McpServerToolSettings>;
  /** Глобальный тумблер LLM Gateway (AD-036): включается/выключается через UI (только ADMIN). */
  llmGateway?: Partial<LlmGatewayRuntimeSettings>;
  /** Глобальные настройки секции «Безопасность» (защищённые пути). */
  security?: Partial<SecurityRuntimeSettings>;
  /** AD-071 §2.3: глобальная политика включения встроенных инструментов (админка). */
  toolsPolicy?: ToolsPolicy;
  /** AD-071 §2.3: глобальная политика включения MCP-инструментов (админка). */
  mcpPolicy?: ToolsPolicy;
  /** AD-071 §2.6: instance-wide отключение инструментов (админка). */
  toolsDisabled?: ToolsDisabledConfig;
  /** AD-046 §4.5: instance-wide отключение скиллов группами/точечно (админка). */
  skillsDisabled?: SkillsDisabledRequest;
  /**
   * AD-046 §4.5: сид для НОВЫХ проектов — скиллы, отключённые по умолчанию
   * (снимок при создании проекта).
   */
  skillsDisabledForNewProjects?: SkillsDisabledRequest;
  /** AD-046 §4.5: глобальная политика включения скиллов (админка). */
  skillsPolicy?: ToolsPolicy;
  /** Разовые идемпотентные миграции: имя → `true` (выполнено). */
  migrations?: Record<string, boolean>;
  /** AD-071 §2.3.1: runtime-политика сетевого доступа пользовательских HTTP MCP. */
  mcpNetworkPolicy?: McpNetworkPolicy;
  /**
   * AD-071 §2.6: откалиброванный chars-per-token по модели (promptChars /
   * usage.inputTokens). Используется для `estTokens`; отсутствие — дефолт 4.
   */
  tokenRatios?: Record<string, number>;
  /** Агент по умолчанию (админка «Агенты»); отсутствие — `DEFAULT_AGENT_ID`. */
  defaultAgent?: string;
  /**
   * AD-075: политика для абсолютного workspace вне `workspacesRoot`
   * (`confirm` | `deny`); отсутствие — значение из config.yaml/env.
   */
  workspacePolicy?: WorkspaceOutsideRootPolicy;
  /** AD-089: runtime-настройки раздела «События» (админка). */
  events?: Partial<EventsRuntimeSettings>;
  /** AD-084: runtime-настройки decision-слоя (админка). */
  decision?: DecisionRuntimeSettings;
}

/**
 * Мёржит runtime-настройки LLM Gateway (из {dataDir}/settings.json) поверх
 * конфига из config.yaml. Runtime приоритетнее: включается/выключается шлюз
 * через UI без правки конфига. Возвращает undefined, если ни конфига, ни
 * runtime-настроек нет (шлюз не применяется — обратная совместимость).
 */
export function mergeLlmGatewayConfig(
  base: LLMGatewayConfig | undefined,
  runtime: Partial<LlmGatewayRuntimeSettings>,
): LLMGatewayConfig | undefined {
  const hasRuntime = !!runtime && Object.keys(runtime).length > 0;
  if (!base && !hasRuntime) return undefined;
  return {
    enabled: runtime.enabled ?? base?.enabled ?? false,
    inputMode: runtime.inputMode ?? base?.inputMode ?? 'obfuscate',
    logPayloads: runtime.logPayloads ?? base?.logPayloads ?? false,
    payloadLogPath: base?.payloadLogPath ?? '',
    rateLimit: {
      userPerMinute: runtime.rateLimit?.userPerMinute ?? base?.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute,
      providerPerMinute: runtime.rateLimit?.providerPerMinute ?? base?.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute,
    },
    audit: base?.audit ?? { enabled: true, logPath: '' },
  };
}

/**
 * Мёржит runtime-настройки секции «Безопасность» (protectedPaths.enabled,
 * askTimeoutMs) поверх конфига из config.yaml. Runtime приоритетнее. Возвращает
 * undefined, если ни конфига, ни runtime-настроек нет.
 *
 * askTimeoutMs не входит в SecurityConfig (это permission-настройка), поэтому
 * возвращается как доп. поле — потребитель (onSecurityChange) пробрасывает его
 * в дефолтный permission-конфиг оркестратора.
 */
export function mergeSecurityConfig(
  base: SecurityConfig | undefined,
  runtime: Partial<SecurityRuntimeSettings>,
): (SecurityConfig & { askTimeoutMs?: number }) | undefined {
  const hasRuntime = !!runtime && Object.keys(runtime).length > 0;
  if (!base && !hasRuntime) return undefined;
  return {
    promptInjection: base?.promptInjection ?? { enabled: true, wrapContent: true, mode: 'flag' },
    protectedPaths: {
      enabled: runtime.protectedPaths?.enabled ?? base?.protectedPaths?.enabled ?? true,
    },
    // AD-076: мастер-ключ не относится к runtime-настройкам UI — переносим из config.
    secretKey: base?.secretKey ?? '',
    askTimeoutMs: runtime.askTimeoutMs
      ?? (base as SecurityConfig & { askTimeoutMs?: number })?.askTimeoutMs
      ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/**
 * AD-071 §2.3.1: мёржит runtime-политику сетевого доступа MCP поверх config.yaml.
 * Runtime приоритетнее; при отсутствии обоих возвращает undefined (вызывающий
 * подставляет дефолт `DEFAULT_MCP_NETWORK_POLICY`).
 */
export function mergeMcpNetworkPolicy(
  base: McpNetworkPolicy | undefined,
  runtime: McpNetworkPolicy | undefined,
): McpNetworkPolicy | undefined {
  if (!runtime && !base) return undefined;
  return {
    mode: runtime?.mode ?? base?.mode ?? 'deny',
    list: runtime?.list ?? base?.list ?? [],
  };
}

/**
 * AD-089: мёржит runtime-настройки раздела «События» (админка) поверх config.yaml.
 * Runtime приоритетнее; отсутствие полей — значения из config, затем дефолты.
 */
export function mergeEventsConfig(
  base: SynthConfig['events'] | undefined,
  runtime: Partial<EventsRuntimeSettings>,
): EventsRuntimeSettings {
  const r = runtime ?? {};
  return {
    enabled: r.enabled ?? base?.enabled ?? true,
    defaultMode: r.defaultMode ?? base?.defaultMode ?? 'bound',
    ephemeralTtl: r.ephemeralTtl ?? base?.ephemeralTtl ?? '24h',
    journalRetentionDays: r.journalRetentionDays ?? base?.journalRetentionDays ?? 30,
    allowedSources: r.allowedSources ?? base?.allowedSources ?? [],
    unknownAgentTemplate: r.unknownAgentTemplate ?? base?.unknownAgentTemplate ?? 'drop',
    keyRateLimitPerMinute: r.keyRateLimitPerMinute ?? base?.keyRateLimitPerMinute ?? 0,
    decisionRouting: r.decisionRouting ?? base?.decisionRouting ?? false,
  };
}

/**
 * AD-084: мёржит runtime-настройки decision-слоя (админка) поверх config.yaml
 * `decision`. Runtime приоритетнее; отсутствие полей — значения из config,
 * затем дефолты схемы. Возвращает полный `DecisionConfig` (все поля заданы).
 */
export function mergeDecisionConfig(
  base: DecisionConfig | undefined,
  runtime: Partial<DecisionRuntimeSettings>,
): DecisionConfig {
  const r = runtime ?? {};
  return {
    enabled: r.enabled ?? base?.enabled ?? false,
    provider: r.provider ?? base?.provider ?? '',
    model: r.model ?? base?.model ?? '',
    confidenceThreshold: r.confidenceThreshold ?? base?.confidenceThreshold ?? 0.6,
  };
}

/**
 * Runtime-настройки приложения (AD-005).
 *
 * Хранятся одним JSON-файлом `{dataDir}/settings.json`. Запись атомарная:
 * временный файл `.tmp.{uuid}` → `rename()`. Значения переживают рестарт
 * сервера: при старте `createStandaloneApp` читает workspace отсюда и
 * применяет в приоритете над config.yaml.
 */
export class RuntimeSettingsStore {
  private _locks = new Map<string, AsyncLock>();

  constructor(private _opts: { dataDir: string }) {}

  private _filePath(): string {
    return join(this._opts.dataDir, 'settings.json');
  }

  private _getLock(key: string): AsyncLock {
    if (!this._locks.has(key)) {
      this._locks.set(key, new AsyncLock());
    }
    return this._locks.get(key)!;
  }

  async load(): Promise<RuntimeSettings> {
    try {
      const data = await readFile(this._filePath(), 'utf-8');
      return JSON.parse(data) as RuntimeSettings;
    } catch {
      return {};
    }
  }

  async getWorkspace(): Promise<string | undefined> {
    const settings = await this.load();
    return settings.workspace;
  }

  async setWorkspace(workspace: string): Promise<void> {
    await this._update((current) => ({ ...current, workspace }));
  }

  async clearWorkspace(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.workspace;
      return next;
    });
  }

  async getMcpSettings(): Promise<Record<string, McpServerToolSettings>> {
    const settings = await this.load();
    return settings.mcpServers ?? {};
  }

  async setMcpSettings(servers: Record<string, McpServerToolSettings>): Promise<void> {
    await this._update((current) => ({ ...current, mcpServers: servers }));
  }

  async clearMcpSettings(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.mcpServers;
      return next;
    });
  }

  async getLlmGatewaySettings(): Promise<Partial<LlmGatewayRuntimeSettings>> {
    const settings = await this.load();
    return settings.llmGateway ?? {};
  }

  async setLlmGatewaySettings(config: Partial<LlmGatewayRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, llmGateway: config }));
  }

  async clearLlmGatewaySettings(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.llmGateway;
      return next;
    });
  }

  async getSecuritySettings(): Promise<Partial<SecurityRuntimeSettings>> {
    const settings = await this.load();
    return settings.security ?? {};
  }

  async setSecuritySettings(config: Partial<SecurityRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, security: config }));
  }

  async clearSecuritySettings(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.security;
      return next;
    });
  }

  /** AD-071 §2.3: runtime-политика встроенных инструментов (админка), undefined — не задана. */
  async getToolsPolicy(): Promise<ToolsPolicy | undefined> {
    const settings = await this.load();
    return settings.toolsPolicy;
  }

  async setToolsPolicy(policy: ToolsPolicy): Promise<void> {
    await this._update((current) => ({ ...current, toolsPolicy: policy }));
  }

  async clearToolsPolicy(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.toolsPolicy;
      return next;
    });
  }

  /** AD-071 §2.3: runtime-политика MCP-инструментов (админка), undefined — не задана. */
  async getMcpPolicy(): Promise<ToolsPolicy | undefined> {
    const settings = await this.load();
    return settings.mcpPolicy;
  }

  async setMcpPolicy(policy: ToolsPolicy): Promise<void> {
    await this._update((current) => ({ ...current, mcpPolicy: policy }));
  }

  async clearMcpPolicy(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.mcpPolicy;
      return next;
    });
  }

  /** AD-071 §2.6: instance-wide отключение инструментов (админка), undefined — не задано. */
  async getToolsDisabled(): Promise<ToolsDisabledConfig | undefined> {
    const settings = await this.load();
    return settings.toolsDisabled;
  }

  async setToolsDisabled(config: ToolsDisabledConfig): Promise<void> {
    await this._update((current) => ({ ...current, toolsDisabled: config }));
  }

  async clearToolsDisabled(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.toolsDisabled;
      return next;
    });
  }

  /** AD-046 §4.5: instance-wide отключение скиллов (админка). */
  async getSkillsDisabled(): Promise<SkillsDisabledRequest | undefined> {
    const settings = await this.load();
    return settings.skillsDisabled;
  }

  async setSkillsDisabled(config: SkillsDisabledRequest): Promise<void> {
    await this._update((current) => ({ ...current, skillsDisabled: config }));
  }

  async clearSkillsDisabled(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.skillsDisabled;
      return next;
    });
  }

  /** AD-046 §4.5: сид «отключено по умолчанию» для новых проектов. */
  async getSkillsDisabledForNewProjects(): Promise<SkillsDisabledRequest | undefined> {
    const settings = await this.load();
    return settings.skillsDisabledForNewProjects;
  }

  async setSkillsDisabledForNewProjects(config: SkillsDisabledRequest): Promise<void> {
    await this._update((current) => ({ ...current, skillsDisabledForNewProjects: config }));
  }

  async clearSkillsDisabledForNewProjects(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.skillsDisabledForNewProjects;
      return next;
    });
  }

  /** Разовые идемпотентные миграции: маркер выполненной миграции. */
  async getMigrationMarker(name: string): Promise<boolean> {
    const settings = await this.load();
    return settings.migrations?.[name] === true;
  }

  async setMigrationMarker(name: string): Promise<void> {
    await this._update((current) => ({
      ...current,
      migrations: { ...(current.migrations ?? {}), [name]: true },
    }));
  }

  /** AD-046 §4.5: глобальная политика включения скиллов (админка). */
  async getSkillsPolicy(): Promise<ToolsPolicy | undefined> {
    const settings = await this.load();
    return settings.skillsPolicy;
  }

  async setSkillsPolicy(policy: ToolsPolicy): Promise<void> {
    await this._update((current) => ({ ...current, skillsPolicy: policy }));
  }

  async clearSkillsPolicy(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.skillsPolicy;
      return next;
    });
  }

  /** AD-071 §2.6: chars-per-token модели (undefined — калибровки нет). */
  async getTokenRatio(model: string): Promise<number | undefined> {
    const settings = await this.load();
    return settings.tokenRatios?.[model];
  }

  async getTokenRatios(): Promise<Record<string, number>> {
    const settings = await this.load();
    return settings.tokenRatios ?? {};
  }

  /** AD-071 §2.6: сохранить откалиброванный chars-per-token модели. */
  async setTokenRatio(model: string, ratio: number): Promise<void> {
    await this._update((current) => ({
      ...current,
      tokenRatios: { ...(current.tokenRatios ?? {}), [model]: ratio },
    }));
  }

  /** AD-071 §2.3.1: runtime-политика сетевого доступа MCP (админка). */
  async getMcpNetworkPolicy(): Promise<McpNetworkPolicy | undefined> {
    const settings = await this.load();
    return settings.mcpNetworkPolicy;
  }

  async setMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<void> {
    await this._update((current) => ({ ...current, mcpNetworkPolicy: policy }));
  }

  async clearMcpNetworkPolicy(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.mcpNetworkPolicy;
      return next;
    });
  }

  /** Агент по умолчанию (админка «Агенты»), undefined — не задан. */
  async getDefaultAgent(): Promise<string | undefined> {
    const settings = await this.load();
    return settings.defaultAgent;
  }

  async setDefaultAgent(id: string): Promise<void> {
    await this._update((current) => ({ ...current, defaultAgent: id }));
  }

  async clearDefaultAgent(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.defaultAgent;
      return next;
    });
  }

  /** AD-075: runtime-политика workspace вне root (админка), undefined — не задана. */
  async getWorkspacePolicy(): Promise<WorkspaceOutsideRootPolicy | undefined> {
    const settings = await this.load();
    return settings.workspacePolicy;
  }

  async setWorkspacePolicy(policy: WorkspaceOutsideRootPolicy): Promise<void> {
    await this._update((current) => ({ ...current, workspacePolicy: policy }));
  }

  async clearWorkspacePolicy(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.workspacePolicy;
      return next;
    });
  }

  /** AD-089: runtime-настройки «События» (админка), undefined — не заданы. */
  async getEvents(): Promise<Partial<EventsRuntimeSettings>> {
    const settings = await this.load();
    return settings.events ?? {};
  }

  async setEvents(config: Partial<EventsRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, events: config }));
  }

  async clearEvents(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.events;
      return next;
    });
  }

  /** AD-084: runtime-настройки decision-слоя (админка), {} — не заданы. */
  async getDecision(): Promise<Partial<DecisionRuntimeSettings>> {
    const settings = await this.load();
    return settings.decision ?? {};
  }

  async setDecision(config: Partial<DecisionRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, decision: config }));
  }

  async clearDecision(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.decision;
      return next;
    });
  }

  private async _update(mutate: (current: RuntimeSettings) => RuntimeSettings): Promise<void> {
    const path = this._filePath();
    const lock = this._getLock('settings');

    await lock.acquire();
    try {
      const current = await this.load();
      const next = mutate(current);
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(next, null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
    } finally {
      lock.release();
    }
  }
}
