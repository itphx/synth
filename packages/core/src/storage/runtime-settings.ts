import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';
import type { EgressPolicy, EgressPolicyScope, WebhooksEgressPolicy, McpServerToolSettings, LLMGatewayConfig, McpNetworkPolicy, SecurityConfig, ToolsPolicy, ToolsDisabledConfig, SkillsDisabledRequest, WorkspaceOutsideRootPolicy, SynthConfig, DecisionConfig, ProxyConfig, PluginsConfig } from '@itphx/synth-shared';
import { DEFAULT_LLM_GATEWAY_RATE_LIMIT, DEFAULT_LLM_FILTER_TIMEOUT_MS } from '@itphx/synth-shared';
import { DEFAULT_ASK_TIMEOUT_MS } from '../engine/permission/derive.js';
import type { SettingsRepository } from './ports/settings-repository.js';

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
 * ADR-089: runtime-настройки раздела «События» (админка), сохраняемые через UI.
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
   * ADR-084 × ADR-089: decision-маршрутизация внешних событий (opt-in).
   * `false` — только декларативные правила; `true` — при промахе правил
   * decision-модель выбирает шаблон агента (fail-safe → `defaultMode`).
   */
  decisionRouting: boolean;
  /**
   * ADR-089 (auto-bind): фоллбек Router закрепляет событие с `identity.chatKey`/
   * `threadKey` за новой сессией (`EventBinding mode='bound'`). Влияет только на
   * фоллбек.
   */
  autoBind: boolean;
  /** ADR-089 (auto-bind): шаблон агента auto-bind-сессий (пусто — по умолчанию). */
  autoBindAgentTemplate: string;
  /**
   * ADR-089: маппинг идентичности внешнего отправителя (`identity.chatKey` или
   * `identity.principalId`) на владельца синт-сессии. Применяется при
   * материализации `ephemeral`/`bind`; пусто — владелец не переопределяется.
   */
  identityMap: Record<string, string>;
}

/**
 * ADR-084: runtime-настройки decision-слоя (админка), сохраняемые через UI.
 * Эффективные значения = `mergeDecisionConfig(config.decisionConfig, runtime)`.
 */
export type DecisionRuntimeSettings = Partial<DecisionConfig>;

/**
 * ADR-094: runtime-настройки раздела «Наблюдаемость» (админка).
 * Приоритет эффективного значения: env `SYNTH_METRICS_ENABLED` > runtime >
 * config.yaml `metrics.enabled` > default `false`. Включает/выключает экспорт
 * `GET /metrics` и сбор метрик; применяется при старте процесса
 * (`restartRequired`, если runtime расходится с запущенным процессом).
 */
export interface MetricsRuntimeSettings {
  enabled?: boolean;
}

/**
 * PROP-090 §10 / ADR-023: runtime-настройки секции `plugins` (слой плагинов),
 * сохраняемые через UI. Состав ключей — ровно `pluginsConfigSchema`
 * (`@itphx/synth-shared/config`): политики (`enabled`/`runtimeInstall`/
 * `trustFloor`/`scan`/`executionEnabled`), списки имён (`allowlist`/`denylist`/
 * `remoteAllowlist`), путь файла исключений семвер-гейта и бюджет блока
 * промпта.
 *
 * Эффективные значения = `mergePluginsConfig(config.plugins, runtime)`
 * (приоритет runtime > config > defaults).
 */
export interface PluginsRuntimeSettings {
  enabled?: boolean;
  runtimeInstall?: 'allow' | 'deny';
  trustFloor?: PluginsConfig['trustFloor'];
  scan?: 'enabled' | 'disabled';
  allowlist?: string[];
  denylist?: string[];
  remoteAllowlist?: string[];
  exactHostExceptions?: string;
  promptBlockMaxChars?: number;
  /**
   * PROP-090 Ф1: переключатель исполнения кода плагинов (по умолчанию `false`).
   * `false` — загрузчик доводит плагин до шага `import` и останавливается
   * (`plugin.execution_disabled`).
   */
  executionEnabled?: boolean;
  /**
   * PROP-090 Ф3б: бюджет времени на один вызов фильтра LLM-вызовов, мс
   * (точка `llmFilters`).
   */
  llmFilterTimeoutMs?: number;
  /**
   * PROP-090 Ф5в: каталог бандлов, поставленных образом/PVC (deploy-time).
   * Пусто — не задан. Runtime-override действует после рестарта (рантайм
   * плагинов собирается при старте, инвариант 24).
   */
  deployDir?: string;
  /** PROP-090 Ф5в: доверие deploy-бандлов (`plugin.trust_below_floor` при ниже порога). */
  deployTrust?: PluginsConfig['deployTrust'];
  /** PROP-090 Ф5в: management-плагин нельзя снять/переустановить через API/CLI. */
  managedReadonly?: boolean;
  /**
   * PROP-090 Ф7: серверная политика плагинов для гибридного режима.
   *
   * `mode` — `off` (сервер не ограничивает) | `allowlist` (разрешены только
   * плагины из `allow`); `allow` — имена разрешённых плагинов.
   */
  hybrid?: {
    mode?: PluginsConfig['hybrid']['mode'];
    allow?: string[];
  };
}

/**
 * Модель по умолчанию инстанса — явная пара `provider` + `model`.
 *
 * Задаётся в UI (раздел «Модели») и хранится в runtime-настройках
 * (`{dataDir}/settings.json`, ключ `defaultModel`); config.yaml
 * (`llm.defaultProvider`/`llm.defaultModel`) — только fallback. Используется
 * для новых сессий (в т.ч. из внешних событий) и как признак «дефолтной»
 * модели/провайдера в ответах `/api/v2/models`/`/api/v2/providers`.
 */
export interface DefaultModelPair {
  provider: string;
  model: string;
}

export interface RuntimeSettings {
  /** Рабочий каталог по умолчанию, заданный через UI (раздел «Проекты»). */
  workspace?: string;
  /** Глобальные настройки доступности MCP-серверов по режимам plan/act. */
  mcpServers?: Record<string, McpServerToolSettings>;
  /** Глобальный тумблер LLM Gateway (ADR-036): включается/выключается через UI (только ADMIN). */
  llmGateway?: Partial<LlmGatewayRuntimeSettings>;
  /** Глобальные настройки секции «Безопасность» (защищённые пути). */
  security?: Partial<SecurityRuntimeSettings>;
  /** ADR-071 §2.3: глобальная политика включения встроенных инструментов (админка). */
  toolsPolicy?: ToolsPolicy;
  /** ADR-071 §2.3: глобальная политика включения MCP-инструментов (админка). */
  mcpPolicy?: ToolsPolicy;
  /** ADR-071 §2.6: instance-wide отключение инструментов (админка). */
  toolsDisabled?: ToolsDisabledConfig;
  /** ADR-046 §4.5: instance-wide отключение скиллов группами/точечно (админка). */
  skillsDisabled?: SkillsDisabledRequest;
  /**
   * ADR-046 §4.5: сид для НОВЫХ проектов — скиллы, отключённые по умолчанию
   * (снимок при создании проекта).
   */
  skillsDisabledForNewProjects?: SkillsDisabledRequest;
  /** ADR-046 §4.5: глобальная политика включения скиллов (админка). */
  skillsPolicy?: ToolsPolicy;
  /** Разовые идемпотентные миграции: имя → `true` (выполнено). */
  migrations?: Record<string, boolean>;
  /** ADR-071 §2.3.1: runtime-политика сетевого доступа пользовательских HTTP MCP. */
  mcpNetworkPolicy?: McpNetworkPolicy;
  /** Egress-политика: runtime override для `tools`/`webhooks` (админка). */
  egress?: Partial<Record<EgressPolicyScope, EgressPolicy | WebhooksEgressPolicy>>;
  /**
   * ADR-071 §2.6: откалиброванный chars-per-token по модели (promptChars /
   * usage.inputTokens). Используется для `estTokens`; отсутствие — дефолт 4.
   */
  tokenRatios?: Record<string, number>;
  /** Агент по умолчанию (админка «Агенты»); отсутствие — `DEFAULT_AGENT_ID`. */
  defaultAgent?: string;
  /** Модель по умолчанию инстанса (админка «Модели»); отсутствие — fallback из config. */
  defaultModel?: DefaultModelPair;
  /**
   * ADR-075: политика для абсолютного workspace вне `workspacesRoot`
   * (`confirm` | `deny`); отсутствие — значение из config.yaml/env.
   */
  workspacePolicy?: WorkspaceOutsideRootPolicy;
  /** ADR-089: runtime-настройки раздела «События» (админка). */
  events?: Partial<EventsRuntimeSettings>;
  /** ADR-084: runtime-настройки decision-слоя (админка). */
  decision?: DecisionRuntimeSettings;
  /** ADR-094: runtime-настройки наблюдаемости (`metrics.enabled`). */
  metrics?: MetricsRuntimeSettings;
  /** PROP-090 §10: runtime-настройки секции `plugins` (админка, слой плагинов). */
  plugins?: Partial<PluginsRuntimeSettings>;
  /**
   * ADR-099: runtime-override секции `proxy` (админка). Секретов не содержит:
   * пароль Basic — только `SYNTH_PROXY_PASSWORD`/`{dataDir}/secrets/proxy-password`.
   * Применяется при следующем старте процесса (dispatcher start-only).
   */
  proxy?: Partial<ProxyConfig>;
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
 *
 * ADR-099: `security.tls` **намеренно не входит** в runtime-настройки UI. Доверие
 * TLS/CA — стартовая конфигурация процесса: оно применяется один раз при старте
 * (`initTlsTrust`, до первого исходящего запроса) и строит глобальный
 * undici-dispatcher/читает PEM-файлы. Node не перечитывает CA на лету, а смена
 * политики доверия во время работы небезопасна (смена MITM-периметра без рестарта),
 * поэтому `tls` резолвится напрямую из `config.security.tls` + env `SYNTH_TLS_*`
 * (`resolveTlsTrust`, ADR-023), независимо от этой функции. Возвращаемый
 * `SecurityConfig` здесь несёт только runtime-изменяемые поля
 * (`promptInjection`/`protectedPaths`/`secretKey`/`askTimeoutMs`); потребители
 * (`onSecurityChange`, оркестратор) `tls` не читают — потери доверия нет.
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
    // ADR-076: мастер-ключ не относится к runtime-настройкам UI — переносим из config.
    secretKey: base?.secretKey ?? '',
    askTimeoutMs: runtime.askTimeoutMs
      ?? (base as SecurityConfig & { askTimeoutMs?: number })?.askTimeoutMs
      ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/**
 * ADR-071 §2.3.1: мёржит runtime-политику сетевого доступа MCP поверх config.yaml.
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
    exceptions: runtime?.exceptions ?? base?.exceptions ?? [],
  };
}

/**
 * Egress-политика: runtime override поверх config.yaml. Runtime приоритетнее;
 * отсутствие обоих — undefined (вызывающий подставляет встроенный дефолт).
 */
export function mergeEgressPolicy<T extends EgressPolicy | WebhooksEgressPolicy>(
  base: T | undefined,
  runtime: T | undefined,
): T | undefined {
  if (!runtime && !base) return undefined;
  return {
    mode: runtime?.mode ?? base?.mode ?? 'deny',
    list: [...(runtime?.list ?? base?.list ?? [])],
    exceptions: [...(runtime?.exceptions ?? base?.exceptions ?? [])],
  } as T;
}

/**
 * ADR-089: мёржит runtime-настройки раздела «События» (админка) поверх config.yaml.
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
    autoBind: r.autoBind ?? base?.autoBind ?? false,
    autoBindAgentTemplate: r.autoBindAgentTemplate ?? base?.autoBindAgentTemplate ?? '',
    identityMap: r.identityMap ?? base?.identityMap ?? {},
  };
}

/**
 * ADR-084: мёржит runtime-настройки decision-слоя (админка) поверх config.yaml
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
    escalationProvider: r.escalationProvider ?? base?.escalationProvider ?? '',
    escalationModel: r.escalationModel ?? base?.escalationModel ?? '',
  };
}

/** Конвенциональный каталог deploy-плагинов в образе (Ф5в). */
export const DEFAULT_PLUGIN_DEPLOY_DIR = '/opt/synth/plugins';

/**
 * PROP-090 §10 / ADR-023: мёржит runtime-настройки секции `plugins` поверх
 * config.yaml. Runtime приоритетнее; отсутствие поля — значения из config,
 * затем дефолты схемы `pluginsConfigSchema` (`defaults.ts`).
 *
 * Возвращает полный `PluginsConfig` (все ключи заданы) — потребитель
 * (загрузчик плагинов Ф1, `SystemPromptComposer` Ф3) не различает источник.
 */
export function mergePluginsConfig(
  base: PluginsConfig | undefined,
  runtime: Partial<PluginsRuntimeSettings>,
): PluginsConfig {
  const r = runtime ?? {};
  return {
    enabled: r.enabled ?? base?.enabled ?? true,
    runtimeInstall: r.runtimeInstall ?? base?.runtimeInstall ?? 'deny',
    trustFloor: r.trustFloor ?? base?.trustFloor ?? 'trusted',
    scan: r.scan ?? base?.scan ?? 'enabled',
    allowlist: r.allowlist ?? base?.allowlist ?? [],
    denylist: r.denylist ?? base?.denylist ?? [],
    remoteAllowlist: r.remoteAllowlist ?? base?.remoteAllowlist ?? [],
    exactHostExceptions: r.exactHostExceptions ?? base?.exactHostExceptions ?? '',
    promptBlockMaxChars: r.promptBlockMaxChars ?? base?.promptBlockMaxChars ?? 4000,
    executionEnabled: r.executionEnabled ?? base?.executionEnabled ?? false,
    llmFilterTimeoutMs: r.llmFilterTimeoutMs ?? base?.llmFilterTimeoutMs ?? DEFAULT_LLM_FILTER_TIMEOUT_MS,
    // Ф5в: deploy-каталог/PVC (путь внутри контейнера) и доверие deploy-бандлов.
    deployDir: r.deployDir ?? base?.deployDir ?? DEFAULT_PLUGIN_DEPLOY_DIR,
    // Дефолт — как в схеме (`pluginsConfigSchema`): образные бандлы доверены
    // ровно настолько, насколько доверен образ; при trustFloor=trusted (дефолт)
    // установка проходит.
    deployTrust: r.deployTrust ?? base?.deployTrust ?? 'trusted',
    managedReadonly: r.managedReadonly ?? base?.managedReadonly ?? true,
    // Ф7: серверная политика плагинов в гибриде. Режим и список мержатся
    // по отдельности (runtime может переключить режим, не затирая список).
    hybrid: {
      mode: r.hybrid?.mode ?? base?.hybrid?.mode ?? 'off',
      allow: r.hybrid?.allow ?? base?.hybrid?.allow ?? [],
    },
  };
}

/**
 * Runtime-настройки приложения (ADR-005).
 *
 * Хранятся одним JSON-файлом `{dataDir}/settings.json`. Запись атомарная:
 * временный файл `.tmp.{uuid}` → `rename()`. Значения переживают рестарт
 * сервера: при старте `createStandaloneApp` читает workspace отсюда и
 * применяет в приоритете над config.yaml.
 */
export class RuntimeSettingsStore implements SettingsRepository {
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

  /** ADR-071 §2.3: runtime-политика встроенных инструментов (админка), undefined — не задана. */
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

  /** ADR-071 §2.3: runtime-политика MCP-инструментов (админка), undefined — не задана. */
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

  /** ADR-071 §2.6: instance-wide отключение инструментов (админка), undefined — не задано. */
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

  /** ADR-046 §4.5: instance-wide отключение скиллов (админка). */
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

  /** ADR-046 §4.5: сид «отключено по умолчанию» для новых проектов. */
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

  /** ADR-046 §4.5: глобальная политика включения скиллов (админка). */
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

  /** ADR-071 §2.6: chars-per-token модели (undefined — калибровки нет). */
  async getTokenRatio(model: string): Promise<number | undefined> {
    const settings = await this.load();
    return settings.tokenRatios?.[model];
  }

  async getTokenRatios(): Promise<Record<string, number>> {
    const settings = await this.load();
    return settings.tokenRatios ?? {};
  }

  /** ADR-071 §2.6: сохранить откалиброванный chars-per-token модели. */
  async setTokenRatio(model: string, ratio: number): Promise<void> {
    await this._update((current) => ({
      ...current,
      tokenRatios: { ...(current.tokenRatios ?? {}), [model]: ratio },
    }));
  }

  /** ADR-071 §2.3.1: runtime-политика сетевого доступа MCP (админка). */
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

  /** Egress-политика скоупа (`tools`/`webhooks`), undefined — не задана. */
  async getEgressPolicy(scope: EgressPolicyScope): Promise<EgressPolicy | WebhooksEgressPolicy | undefined> {
    const settings = await this.load();
    return settings.egress?.[scope];
  }

  async setEgressPolicy(scope: EgressPolicyScope, policy: EgressPolicy | WebhooksEgressPolicy): Promise<void> {
    await this._update((current) => ({
      ...current,
      egress: { ...(current.egress ?? {}), [scope]: policy },
    }));
  }

  async clearEgressPolicy(scope: EgressPolicyScope): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      if (next.egress) {
        const egress = { ...next.egress };
        delete egress[scope];
        if (Object.keys(egress).length > 0) next.egress = egress;
        else delete next.egress;
      }
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

  /** Модель по умолчанию инстанса (админка «Модели»), undefined — не задана. */
  async getDefaultModel(): Promise<DefaultModelPair | undefined> {
    const settings = await this.load();
    return settings.defaultModel;
  }

  async setDefaultModel(pair: DefaultModelPair): Promise<void> {
    await this._update((current) => ({ ...current, defaultModel: pair }));
  }

  async clearDefaultModel(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.defaultModel;
      return next;
    });
  }

  /** ADR-075: runtime-политика workspace вне root (админка), undefined — не задана. */
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

  /** ADR-089: runtime-настройки «События» (админка), undefined — не заданы. */
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

  /** ADR-084: runtime-настройки decision-слоя (админка), {} — не заданы. */
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

  /** ADR-094: runtime-настройки наблюдаемости (админка), {} — не заданы. */
  async getMetrics(): Promise<Partial<MetricsRuntimeSettings>> {
    const settings = await this.load();
    return settings.metrics ?? {};
  }

  async setMetrics(config: Partial<MetricsRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, metrics: config }));
  }

  async clearMetrics(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.metrics;
      return next;
    });
  }

  /** PROP-090 §10: runtime-настройки слоя плагинов, {} — не заданы. */
  async getPlugins(): Promise<Partial<PluginsRuntimeSettings>> {
    const settings = await this.load();
    return settings.plugins ?? {};
  }

  async setPlugins(config: Partial<PluginsRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, plugins: config }));
  }

  async clearPlugins(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.plugins;
      return next;
    });
  }

  /** ADR-099: runtime-override прокси (админка), undefined — не задан. */
  async getProxySettings(): Promise<Partial<ProxyConfig> | undefined> {
    const settings = await this.load();
    return settings.proxy;
  }

  async setProxySettings(config: Partial<ProxyConfig>): Promise<void> {
    await this._update((current) => ({ ...current, proxy: config }));
  }

  async clearProxySettings(): Promise<void> {
    await this._update((current) => {
      const next = { ...current };
      delete next.proxy;
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
