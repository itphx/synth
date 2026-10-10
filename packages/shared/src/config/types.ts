import { z } from 'zod';
import { permissionConfigSchema } from '../types/permission.js';
import { createToolsDisabledSchema } from '../schemas/index.js';
import {
  TOOLS_POLICIES,
  MCP_NETWORK_POLICY_MODES,
  COMMAND_CONFLICT_MODES,
  DEFAULT_MCP_PRIVATE_CIDRS,
  DEFAULT_MCP_NETWORK_POLICY,
  DEFAULT_LLM_GATEWAY_RATE_LIMIT,
  ToolCapability,
} from '../types/index.js';

const toolCapabilityValues = Object.values(ToolCapability) as [ToolCapability, ...ToolCapability[]];

// --- SynthConfig: единый конфиг для всех компонентов ---

export const serverConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(5000),
  corsOrigin: z.string().default('http://localhost:5002'),
  allowedOrigins: z.array(z.string()).default([]),
});

export const storageConfigSchema = z.object({
  dataDir: z.string().default('/var/synth/data'),
  workspacesRoot: z.string().default(''),
  /** Рабочий каталог по умолчанию для сессий без проекта. Резолвится от dataDir: {dataDir}/workspaces/default. */
  defaultWorkspace: z.string().default(''),
  /**
   * AD-075: политика для абсолютного `project.workspace` вне `workspacesRoot`
   * (`confirm` — подтверждение, `deny` — запрет). `''` — не задано (эффективно
   * `confirm`), читать через `resolveWorkspaceOutsideRootPolicy`.
   */
  workspaceOutsideRoot: z.enum(['confirm', 'deny']).or(z.literal('')).default(''),
});

export const authConfigSchema = z.object({
  debugMode: z.boolean().default(false),
  apiKey: z.string().optional(),
  testUsers: z
    .array(
      z.object({
        username: z.string(),
        apiKey: z.string(),
        roles: z.array(z.string()),
        displayName: z.string(),
      }),
    )
    .optional(),
  sessionMaxAgeMinutes: z.number().int().min(1).default(1440),
  oidc: z
    .object({
      enabled: z.boolean().default(false),
      issuer: z.string().default(''),
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      redirectUri: z.string().default('http://localhost:5002/auth/callback'),
      /** Public client_id для локального CLI/core (ROPC/device flow). Не секрет. */
      cliClientId: z.string().default('synth-cli'),
    })
    .optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string().default(''),
  defaultModel: z.string().default(''),
  maxRetries: z.number().int().min(0).default(3),
  timeout: z.number().int().min(1).default(60),
  /** AD-070 §2.2: политика prompt-cache — auto (ставить маркеры) | none (отключить). */
  cache: z.enum(['auto', 'none']).default('auto'),
});

export const coreConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4300),
  apiKey: z.string().default(''),
});

export const runnerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(5200),
  backendUrl: z.string().default('http://localhost:5000'),
  enginePorts: z.object({
    opencode: z.number().int().default(4100),
    cline: z.number().int().default(4200),
    synth: z.number().int().default(4300),
  }).default({}),
  proxyPort: z.number().int().min(1).max(65535).default(9090),
});

export const uiConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(5002),
  backendUrl: z.string().default('http://localhost:5000'),
  theme: z.string().default('synthesis'),
  themeMode: z.enum(['system', 'light', 'dark']).default('system'),
  locale: z.string().default('ru'),
});

export const i18nConfigSchema = z.object({
  defaultLanguage: z.string().default('ru'),
  supportedLanguages: z.array(z.string()).default(['ru', 'en']),
});

export const loggingConfigSchema = z.object({
  groups: z.record(z.string(), z.string()).default({}),
});

export const tsmConfigSchema = z.object({
  maxIterations: z.number().int().min(1).default(50),
  validationTimeout: z.number().int().min(1).default(30),
});

// --- Session (AD-025 / AD-028): настройки по умолчанию для сессий ---

export const sessionConfigSchema = z.object({
  /** Строгость цикла Plan→Build по умолчанию для новых сессий: auto | strict | off. */
  planMode: z.enum(['auto', 'strict', 'off']).default('auto'),
});

export const contextConfigSchema = z.object({
  enabledFiles: z.array(z.string()).default(['SOUL.md', 'COMPANY.md', 'ABOUT.md']),
});

export const summarizationConfigSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  promptFile: z.string().default('SUMMARIZER'),
});

export const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse', 'http']),
  /** AD-071 §2.2: человекочитаемое описание сервера (попадает в блок `mcp.servers`). */
  description: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Сид системного мастер-флага записи реестра при первичном создании из config
   * (`seedFromConfig`); в резолвинге/подключении не участвует — после создания
   * мастер-флаг живёт только в `McpRegistryEntry.enabled`.
   */
  enabled: z.boolean().optional(),
  /**
   * Сид «включён по умолчанию для НОВЫХ ПРОЕКТОВ» (`project.enabled`/
   * `project.defaultOn`), снимок на момент создания проекта.
   */
  enabledByDefault: z.boolean().optional(),
  timeout: z.number().int().min(1).optional(),
  connectTimeout: z.number().int().min(1).optional(),
});

/**
 * AD-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP-серверов.
 * Дефолт — `deny` приватных/служебных диапазонов (SSRF/egress).
 */
export const mcpNetworkPolicySchema = z.object({
  mode: z.enum(MCP_NETWORK_POLICY_MODES).default(DEFAULT_MCP_NETWORK_POLICY.mode),
  list: z.array(z.string()).default([...DEFAULT_MCP_PRIVATE_CIDRS]),
});

export const mcpConfigSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
  networkPolicy: mcpNetworkPolicySchema.default({}),
  /**
   * AD-071 §2.3: глобальная админская политика включения **MCP**-инструментов.
   * Независима от `tools.policy` (только встроенные). Per-session override —
   * `SessionSettings.mcpPolicy`.
   */
  policy: z.enum(TOOLS_POLICIES).default('auto'),
});

// --- Инструменты (AD-071 §2.3) ---

/**
 * AD-071 §2.6: instance-wide жёсткое отключение инструментов администратором.
 * Отключённые тулы не попадают в запрос независимо от `tools.policy`.
 * `runtime`-capability неотключаема (ядро сессии).
 */
export const toolsDisabledConfigSchema = createToolsDisabledSchema(false);

/**
 * AD-071 §2.3: глобальная админская политика включения **встроенных**
 * инструментов (MCP — отдельная `mcp.policy`). Per-session override —
 * `SessionSettings.toolsPolicy`.
 */
export const toolsConfigSchema = z.object({
  policy: z.enum(TOOLS_POLICIES).default('auto'),
  /** AD-071 §2.6: instance-wide отключение инструментов (admin). */
  disabled: toolsDisabledConfigSchema.default({}),
});

// --- Скиллы (AD-046) ---

/**
 * AD-046 §4.2/§4.4/§7.4: конфигурация механизма скиллов.
 * `paths` — дополнительные пользовательские каталоги; `trustedProjectDirs` —
 * доверенные проектные каталоги (бинарный trust); `inlineShell` — выключатель
 * `!`cmd`` в шаблонных командах (по умолчанию выключено).
 *
 * `urls` — внешние удалённые каталоги (opencode-совместимый `index.json`):
 * **только read-only индексация** — скачиваются в `{dataDir}/skills-cache/urls`,
 * видны в реестре/диагностике, но `trusted: false` (в каталог для модели не
 * попадают, тело не грузится). Установка/доверие/подписи/`lock.json` — AD-068.
 *
 * Внешние локальные каталоги совместимости (`.opencode`, `.claude`, `.agents`,
 * `~/.config/opencode`) подключаются как read-only discovery в core (AD-046 §4.2).
 */
export const skillsConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
  /** AD-046 §4.2/§4.3: удалённые каталоги — read-only индексация (`trusted: false`). */
  urls: z.array(z.string()).default([]),
  trustedProjectDirs: z.array(z.string()).default([]),
  inlineShell: z.boolean().default(false),
  /**
   * AD-046 §3.2/§12: именованные группы тулов → capabilities. Используется
   * для экспансии `metadata.synth.requires_toolsets` в проверку доступности
   * скилла (union с `requires_capabilities`).
   */
  toolsets: z.record(z.string(), z.array(z.enum(toolCapabilityValues))).default({}),
});

// --- Slash-команды (AD-046 §7) ---

/**
 * AD-046 §7/§9.4: конфигурация slash-команд. `paths` — дополнительные каталоги
 * шаблонных `.md`-команд; `bundlesPath` — подкаталог `{dataDir}` для YAML-бандлов;
 * `conflict` — режим разрешения конфликтов имён (см. resolver).
 */
export const commandsConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
  bundlesPath: z.string().default('skill-bundles'),
  conflict: z
    .object({
      mode: z.enum(COMMAND_CONFLICT_MODES).default('bundle-wins'),
      namespacePrefix: z.boolean().default(false),
    })
    .default({}),
  maxArgumentsLength: z.number().int().min(1).default(10_000),
  maxRenderedBytes: z.number().int().min(1).default(200_000),
});

// --- Внешние события (AD-089) ---

/**
 * AD-089: конфигурация приёма внешних событий.
 * - `enabled` — мастер-выключатель приёма событий;
 * - `defaultMode` — режим по умолчанию, если Router не выбрал иной;
 * - `ephemeralTtl` — TTL ephemeral-сессий по умолчанию;
 * - `journalRetentionDays` — срок хранения журнала событий (0 — без ограничения);
 * - `allowedSources` — белый список источников (пусто — разрешены все);
 * - `dedupStore` — источник дедупа событий: `memory` (in-process `Set`, поведение
 *   single-process) | `file` (межпроцессный атомарный claim файлами-маркерами на
 *   общем `dataDir`). Default — `memory` (OFF): поведение single-process не меняется;
 * - `unknownAgentTemplate` — поведение, если `agentTemplate` события/правила не
 *   резолвится в существующего enabled-агента: `drop` — не создавать сессию и
 *   зафиксировать ошибку `agent_not_found` в журнале (fail-safe, default) |
 *   `default-agent` — не задавать `agentRole` (сессия возьмёт агента по умолчанию);
 * - `keyRateLimitPerMinute` — глобальный дефолт лимита запросов/мин на API-ключ
 *   привязки (0 — без лимита; конкретный ключ может переопределить);
 * - `decisionRouting` — AD-084 × AD-089: умная классификация внешних событий
 *   decision-моделью. `false` (default, opt-in) — только декларативные правила
 *   (`ProjectRuleProvider`); `true` — при промахе правил decision-модель выбирает
 *   шаблон агента для ephemeral-сессии. Fail-safe: ошибка/неуверенность/пустой
 *   список агентов → фоллбек Router (`defaultMode`).
 */
export const eventsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultMode: z.enum(['bound', 'ephemeral']).default('bound'),
  ephemeralTtl: z.string().default('24h'),
  journalRetentionDays: z.number().int().min(0).default(30),
  allowedSources: z.array(z.string()).default([]),
  dedupStore: z.enum(['memory', 'file']).default('memory'),
  unknownAgentTemplate: z.enum(['drop', 'default-agent']).default('drop'),
  /**
   * Глобальный дефолт лимита запросов/мин на API-ключ привязки (AD-089/AD-052).
   * `0` — без лимита; конкретный ключ может переопределить своим
   * `rateLimitPerMinute`.
   */
  keyRateLimitPerMinute: z.number().int().min(0).default(0),
  /**
   * AD-084 × AD-089: decision-маршрутизация внешних событий. По умолчанию
   * выключена (поведение не меняется) — включение требует настроенного
   * decision-провайдера (`decision.enabled`).
   */
  decisionRouting: z.boolean().default(false),
});

// --- Планировщик расписаний (AD-051 срез / AD-089) ---

/**
 * AD-051 (минимальный срез) / AD-089: конфигурация cron/interval-планировщика.
 * - `enabled` — мастер-выключатель сервиса (в standalone гейтит `start()`);
 * - `tickSec` — период тика, секунды (1..3600);
 * - `catchUp` — дефолт поведения при пропущенном срабатывании (`skip`/`once`);
 * - `jobRetentionDays` — срок хранения Job-истории (дни, `prune` на старте);
 * - `leaderElection` — выбор лидера-владельца тикера: `none` (каждый процесс
 *   считает себя лидером, поведение single-process) | `file` (file-based lock на
 *   общем `dataDir`). Default — `none` (OFF);
 * - `crossProcessLocks` — межпроцессная сериализация мутаций `ScheduleStore`
 *   (file-мьютекс поверх in-process `AsyncLock`). Default — `false` (OFF):
 *   поведение single-process не меняется.
 */
export const schedulerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tickSec: z.number().int().min(1).max(3600).default(60),
  catchUp: z.enum(['skip', 'once']).default('skip'),
  jobRetentionDays: z.number().int().min(0).default(30),
  leaderElection: z.enum(['none', 'file']).default('none'),
  crossProcessLocks: z.boolean().default(false),
});

// --- Decision-модели (AD-084) ---

/**
 * AD-084: конфигурация класса decision-моделей (System One: Clef/Jev/…).
 * - `enabled` — мастер-выключатель decision-слоя (по умолчанию выключен);
 * - `mode` — выбор транспорта: `auto` (по политике) | `local` (Ollama) |
 *   `remote` (RouterAI/managed). `auto` = `remote` при заданном decision-провайдере,
 *   иначе `local` (задел под AD-080/AD-081);
 * - `provider` — имя провайдера типа `decision` (пусто — провайдер не задан);
 * - `model` — модель decision-слоя (напр. `clef-flash`);
 * - `escalationModel` — модель для эскалации (опционально);
 * - `timeoutMs` — таймаут decision-запроса, мс;
 * - `confidenceThreshold` — порог уверенности, ниже — fallback (fail-safe);
 * - `remoteEndpoint` — явный endpoint remote-транспорта (перебивает base URL
 *   провайдера; пусто — используется URL провайдера).
 */
export const decisionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['auto', 'local', 'remote']).default('auto'),
  provider: z.string().default(''),
  model: z.string().default(''),
  escalationModel: z.string().default(''),
  timeoutMs: z.number().int().min(1).default(10_000),
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  remoteEndpoint: z.string().default(''),
});

// --- Проектные инструкции (AD-069) ---

/**
 * AD-069 §3.4/§11: дополнительный источник проектных инструкций.
 * `position` задаёт место в порядке: `before` — перед merged chain, `after` —
 * после. `ttlSec` (только для URL) переопределяет `instructions.fetch.cacheTtlSec`.
 */
export const instructionSourceConfigSchema = z.object({
  kind: z.enum(['path', 'url']),
  value: z.string(),
  position: z.enum(['before', 'after']).default('after'),
  label: z.string().optional(),
  ttlSec: z.number().int().min(0).optional(),
});

/**
 * AD-069 §4: параметры lazy-догрузки подкаталогов (реализация — Фаза 2;
 * схема заводится в Фазе 1).
 */
export const instructionsLazyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxAncestors: z.number().int().min(0).default(5),
  maxChars: z.number().int().min(1).default(8_000),
  excludeDirs: z
    .array(z.string())
    .default(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'coverage', 'tmp', '.cache']),
});

/**
 * AD-069 §5.1/§9.1: параметры fetch URL-источников (без фонового таймера —
 * загрузка при старте + TTL-кэш). Реализация fetch — Фаза 2.
 */
export const instructionsFetchConfigSchema = z.object({
  timeoutMs: z.number().int().min(1).default(5_000),
  cacheTtlSec: z.number().int().min(0).default(3_600),
  maxBytes: z.number().int().min(1).default(262_144),
});

/**
 * AD-069 §5.1/§9.1: конфигурация проектных инструкций (`AGENTS.md` и совместимые).
 * Порядок: `sources` с `position: before` → merged chain (`git root → … → cwd`) →
 * `sources` с `position: after`. Кап — динамический от окна модели.
 */
export const instructionsConfigSchema = z.object({
  /** Глобальный тумблер автоматической загрузки проектных инструкций. */
  enabled: z.boolean().default(true),
  /** Читать `CLAUDE.md`, если нет основного кандидата (инвертированный disableClaudeCodePrompt). */
  claudeCompat: z.boolean().default(true),
  /** Deprecated `CONTEXT.md` (выключено по умолчанию). */
  contextCompat: z.boolean().default(false),
  /** Доля head при обрезке. */
  headRatio: z.number().min(0).max(1).default(0.7),
  /** Доля tail при обрезке. */
  tailRatio: z.number().min(0).max(1).default(0.2),
  /** Явный cap-override (перебивает расчёт от окна модели). */
  maxChars: z.number().int().min(1).optional(),
  /** Доля окна модели для динамического капа. */
  windowRatio: z.number().min(0).max(1).default(0.06),
  /** Нижняя граница динамического капа (floor). */
  minChars: z.number().int().min(1).default(20_000),
  /** Верхняя граница динамического капа (ceiling). */
  maxCharsCeiling: z.number().int().min(1).default(500_000),
  lazy: instructionsLazyConfigSchema.default({}),
  fetch: instructionsFetchConfigSchema.default({}),
  sources: z.array(instructionSourceConfigSchema).default([]),
  /** Проекты (id), где автозагрузка выключена. */
  excludeProjects: z.array(z.string()).default([]),
  /** Не грузить инструкции внутри дерева исходников Synth (install-tree guard, Фаза 2). */
  allowInstallTreeFallback: z.boolean().default(false),
});

// --- Security (IPI protection) ---

export const promptInjectionConfigSchema = z.object({
  /** Глобальный выключатель защиты от Indirect Prompt Injection. */
  enabled: z.boolean().default(true),
  /** Оборачивать tool-контент в [CONTENT | SOURCE: ... | trust: ...] маркеры. */
  wrapContent: z.boolean().default(true),
  /** Режим детекции подозрительных паттернов: flag (пометить), sanitize (заменить), block (заблокировать). */
  mode: z.enum(['flag', 'sanitize', 'block']).default('flag'),
});

export const protectedPathsConfigSchema = z.object({
  /** Глобальный выключатель защиты защищённых путей (сквозная проверка файловых тулов). */
  enabled: z.boolean().default(true),
});

export const securityConfigSchema = z.object({
  promptInjection: promptInjectionConfigSchema.default({}),
  protectedPaths: protectedPathsConfigSchema.default({}),
  /**
   * AD-076: мастер-ключ для шифрования секретов at-rest (SSH-ключи, AES-256-GCM).
   * Приоритет — env `SYNTH_SECRET_KEY` (читать через `resolveSecretKey`).
   * Пусто — core использует файл `{dataDir}/secrets/master.key`.
   */
  secretKey: z.string().default(''),
});

// --- LLM Gateway (AD-036) ---

export const llmGatewayRateLimitConfigSchema = z.object({
  userPerMinute: z.number().int().min(1).default(DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute),
  providerPerMinute: z.number().int().min(1).default(DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute),
});

export const llmGatewayAuditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  logPath: z.string().default(''), // по умолчанию {dataDir}/audit/llm-gateway.jsonl
});

export const llmGatewayConfigSchema = z.object({
  /** Глобальный выключатель LLM Gateway. */
  enabled: z.boolean().default(false),
  /** Режим Input Guard: obfuscate (замена на плейсхолдер) | block (запрос блокируется). */
  inputMode: z.enum(['obfuscate', 'block']).default('obfuscate'),
  /** Полное логирование запросов и ответов LLM (после обфускации) в JSONL. */
  logPayloads: z.boolean().default(false),
  /** Путь к JSONL полного лога; по умолчанию {dataDir}/audit/llm-payloads.jsonl. */
  payloadLogPath: z.string().default(''),
  rateLimit: llmGatewayRateLimitConfigSchema.default({}),
  audit: llmGatewayAuditConfigSchema.default({}),
});

// --- Router (AD-034) ---

export const routerContentConfigSchema = z.object({
  coding: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
  chat: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
  research: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
});

export const routerEscalationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackProvider: z.string().default(''),
  fallbackModel: z.string().default(''),
  maxRetries: z.number().int().min(0).max(3).default(1),
  checks: z.array(z.enum(['min_length', 'constraint', 'self_check'])).default(['min_length', 'constraint']),
  minLength: z.number().int().min(1).default(10),
});

export const routerCostConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cheapProvider: z.string().default(''),
  cheapModel: z.string().default(''),
  expensiveProvider: z.string().default(''),
  expensiveModel: z.string().default(''),
  maxCheapTokens: z.number().int().min(1).default(500),
});

export const routerSubagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default(''),
  provider: z.string().default(''),
});

// --- Micro-first (AD-035) ---

export const microFirstConfigSchema = z.object({
  enabled: z.boolean().default(false),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  microLlmProvider: z.string().default(''),
  microLlmModel: z.string().default(''),
  rulesEnabled: z.boolean().default(true),
  embeddingEnabled: z.boolean().default(false),
  embedProvider: z.string().default('ollama'),
  embedModel: z.string().default('local.nomic-embed-text:latest'),
  microLlmEnabled: z.boolean().default(false),
});

export const routerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(['content', 'cost', 'content+cost', 'auto']).default('auto'),
  content: routerContentConfigSchema.default({}),
  escalation: routerEscalationConfigSchema.default({}),
  cost: routerCostConfigSchema.default({}),
  subagent: routerSubagentConfigSchema.default({}),
});

// --- Remote (гибридный режим) ---

export const remoteConfigSchema = z.object({
  /** Включён ли гибридный режим: локальный core подключается к удалённому backend. */
  enabled: z.boolean().default(false),
  /** Базовый URL удалённого backend (например https://synth.k3s.itphx.loc). */
  backendUrl: z.string().default(''),
  auth: z
    .object({
      type: z.enum(['device', 'api_key']).default('device'),
      apiKey: z.string().default(''),
      /** OIDC issuer (Keycloak realm), напр. https://keycloak.itphx.loc/realms/synth. Для device flow. */
      issuer: z.string().default(''),
      /** OIDC client_id (public client). Для device flow. */
      clientId: z.string().default(''),
    })
    .default({}),
  /** Куда идут LLM-запросы локальных сессий: server (централизация) | local. По умолчанию server. */
  llm: z.enum(['server', 'local']).default('server'),
  worlds: z
    .object({
      local: z.boolean().default(true),
      remote: z.boolean().default(true),
    })
    .default({}),
  /** Путь к файлу credentials (пусто → ~/.config/synth/credentials.json). */
  credentialsPath: z.string().default(''),
  timeoutMs: z.number().int().min(1).default(15000),
});

export const synthConfigSchema = z.object({
  server: serverConfigSchema.default({}),
  storage: storageConfigSchema.default({}),
  auth: authConfigSchema.default({}),
  llm: llmConfigSchema.default({}),
  core: coreConfigSchema.default({}),
  runner: runnerConfigSchema.default({}),
  ui: uiConfigSchema.default({}),
  i18n: i18nConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  tsm: tsmConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  context: contextConfigSchema.default({}),
  summarization: summarizationConfigSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  tools: toolsConfigSchema.default({}),
  skills: skillsConfigSchema.default({}),
  commands: commandsConfigSchema.default({}),
  events: eventsConfigSchema.default({}),
  scheduler: schedulerConfigSchema.default({}),
  decision: decisionConfigSchema.default({}),
  instructions: instructionsConfigSchema.default({}),
  router: routerConfigSchema.default({}),
  remote: remoteConfigSchema.default({}),
  microFirst: microFirstConfigSchema.default({}),
  llmGateway: llmGatewayConfigSchema.default({}),
  permission: permissionConfigSchema.default({}),
  security: securityConfigSchema.default({}),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type CoreConfig = z.infer<typeof coreConfigSchema>;
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export type UIConfig = z.infer<typeof uiConfigSchema>;
export type I18nConfig = z.infer<typeof i18nConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type TsmConfig = z.infer<typeof tsmConfigSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type ContextConfigSchema = z.infer<typeof contextConfigSchema>;
export type SummarizationConfig = z.infer<typeof summarizationConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type ToolsDisabledConfig = z.infer<typeof toolsDisabledConfigSchema>;
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;
export type CommandsConfig = z.infer<typeof commandsConfigSchema>;
export type EventsConfig = z.infer<typeof eventsConfigSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type DecisionConfig = z.infer<typeof decisionConfigSchema>;
export type InstructionSourceConfig = z.infer<typeof instructionSourceConfigSchema>;
export type InstructionsLazyConfig = z.infer<typeof instructionsLazyConfigSchema>;
export type InstructionsFetchConfig = z.infer<typeof instructionsFetchConfigSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type RouterContentConfig = z.infer<typeof routerContentConfigSchema>;
export type RouterEscalationConfig = z.infer<typeof routerEscalationConfigSchema>;
export type RouterCostConfig = z.infer<typeof routerCostConfigSchema>;
export type RouterSubagentConfig = z.infer<typeof routerSubagentConfigSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type MicroFirstConfig = z.infer<typeof microFirstConfigSchema>;
export type SynthConfig = z.infer<typeof synthConfigSchema>;
export type PermissionConfig = z.infer<typeof permissionConfigSchema>;
export type PromptInjectionConfig = z.infer<typeof promptInjectionConfigSchema>;
export type ProtectedPathsConfig = z.infer<typeof protectedPathsConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type LLMGatewayRateLimitConfig = z.infer<typeof llmGatewayRateLimitConfigSchema>;
export type LLMGatewayAuditConfig = z.infer<typeof llmGatewayAuditConfigSchema>;
export type LLMGatewayConfig = z.infer<typeof llmGatewayConfigSchema>;
