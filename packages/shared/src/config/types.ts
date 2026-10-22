import { z } from 'zod';
import { permissionConfigSchema } from '../types/permission.js';
import { createToolsDisabledSchema, globalRoleSchema, serviceScopeSchema } from '../schemas/index.js';
import {
  TOOLS_POLICIES,
  MCP_NETWORK_POLICY_MODES,
  COMMAND_CONFLICT_MODES,
  DEFAULT_MCP_PRIVATE_CIDRS,
  DEFAULT_MCP_NETWORK_POLICY,
  DEFAULT_EGRESS_TOOLS_POLICY,
  DEFAULT_EGRESS_WEBHOOKS_POLICY,
  DEFAULT_EGRESS_LOG,
  EGRESS_POLICY_MODES,
  WEBHOOKS_EGRESS_POLICY_MODES,
  DEFAULT_LLM_GATEWAY_RATE_LIMIT,
  DEFAULT_LLM_FILTER_TIMEOUT_MS,
  MIN_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_LIMIT,
  ToolCapability,
} from '../types/index.js';
import { catalogTrustLevelSchema } from '../types/trust.js';

const toolCapabilityValues = Object.values(ToolCapability) as [ToolCapability, ...ToolCapability[]];

// --- SynthConfig: единый конфиг для всех компонентов ---

export const serverConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(5000),
  corsOrigin: z.string().default('http://localhost:5002'),
  allowedOrigins: z.array(z.string()).default([]),
});

/**
 * ADR-097: параметры подключения к PostgreSQL (секция `storage.postgres`).
 *
 * Пароль здесь **не хранится** (инвариант 13) — его читает резолвер
 * `resolvePostgresPassword` (env `SYNTH_POSTGRES_PASSWORD` → файл
 * `{dataDir}/secrets/postgres-password`); решение об ошибке отсутствия пароля
 * принимает драйвер (`@itphx/synth-storage-postgres`). `dsn` задан —
 * приоритетнее отдельных `host`/`port`/`database`/`user`.
 */
export const postgresStorageConfigSchema = z.object({
  /** Полная строка подключения; задана — приоритетнее host/port/database/user. */
  dsn: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  /** Схема БД (namespace таблиц). */
  schema: z.string().optional(),
  /**
   * ADR-099/ADR-097: TLS-режим соединения с БД.
   * `disable` — без TLS; `require` — шифрование без проверки сертификата;
   * `verify-full` — проверка сертификата сервера по CA из `security.tls`.
   * `verify-ca` принимается как **алиас** `verify-full` (нормализуется с
   * предупреждением). **Не задано — прежнее поведение (`ssl: false`, без TLS)**,
   * чтобы не сломать dev/существующие установки (dev-сервер без TLS).
   * Читать/мапить — `resolvePostgresConfig` + `buildPostgresSslOptions`
   * (`resolve.ts`/`tls.ts`, core — `storage/storage-context.ts`).
   * TLS-параметры (`sslmode`/`sslrootcert`/…) **запрещены в `dsn`** — `pg`
   * накладывает DSN поверх конфига и молча перекрывает `ssl`.
   */
  sslmode: z.enum(['disable', 'require', 'verify-full', 'verify-ca']).optional(),
  /**
   * Legacy-флаг TLS (`true`/`false`); используется, только если `sslmode` не
   * задан (обратная совместимость). Новые установки — через `sslmode`.
   */
  ssl: z.boolean().optional(),
  /** Максимальный размер пула соединений. */
  poolMax: z.number().int().min(1).optional(),
});

export const storageConfigSchema = z.object({
  dataDir: z.string().default('/var/synth/data'),
  /**
   * ADR-096: физический backend хранения. `file` — JSON-файлы с атомарной
   * записью tmp→rename (ADR-005, дефолт); `memory` — in-memory (энергонезависимо
   * НЕ сохраняется, для герметичных тестов); `postgres` — БД (драйвер —
   * in-tree опциональный пакет `@itphx/synth-storage-postgres`). Читать через
   * `resolveStorageBackend` (env `SYNTH_STORAGE_BACKEND` > это поле > `file`,
   * fail-closed на неизвестном явно заданном значении).
   *
   * Необязательно: частичные override-объекты (`{ dataDir, workspacesRoot, … }`)
   * остаются валидными, а дефолт `file` задают `defaults.ts`/`resolveStorageBackend`.
   */
  backend: z.enum(['file', 'memory', 'postgres']).optional(),
  /** ADR-097: параметры PostgreSQL-backend (используются при `backend: postgres`). */
  postgres: postgresStorageConfigSchema.default({}),
  /**
   * ADR-098 (волна 5): поведение при недоступности выбранного backend —
   * `fallback-file` (перейти на файловое хранилище в `fallbackDir`, default) |
   * `halt` (остановить старт). Читать через `resolveDegradedMode`
   * (приоритет env `SYNTH_DEGRADED_MODE` > это поле > `fallback-file`).
   */
  degradedMode: z.enum(['fallback-file', 'halt']).default('fallback-file'),
  /**
   * ADR-098 (волна 5): каталог файлового фоллбека при деградации.
   * `''` — не задано (эффективно `{dataDir}/fallback`), читать через
   * `resolveStorageFallbackDir` (приоритет env `SYNTH_STORAGE_FALLBACK_DIR` >
   * это поле > `{dataDir}/fallback`).
   */
  fallbackDir: z.string().default(''),
  workspacesRoot: z.string().default(''),
  /** Рабочий каталог по умолчанию для сессий без проекта. Резолвится от dataDir: {dataDir}/workspaces/default. */
  defaultWorkspace: z.string().default(''),
  /**
   * ADR-075: политика для абсолютного `project.workspace` вне `workspacesRoot`
   * (`confirm` — подтверждение, `deny` — запрет). `''` — не задано (эффективно
   * `confirm`), читать через `resolveWorkspaceOutsideRootPolicy`.
   */
  workspaceOutsideRoot: z.enum(['confirm', 'deny']).or(z.literal('')).default(''),
  /**
   * Максимальный размер загружаемого файла (`POST /api/v2/fs/upload`), в байтах.
   * Валидируется (положительное целое в границах `MIN_UPLOAD_BYTES`…
   * `MAX_UPLOAD_BYTES_LIMIT`), читать через `resolveMaxUploadBytes` (env
   * `SYNTH_MAX_UPLOAD_BYTES` > это поле > `DEFAULT_MAX_UPLOAD_BYTES`).
   * Не задано — резолвер подставляет `DEFAULT_MAX_UPLOAD_BYTES` (100 МиБ).
   */
  maxUploadBytes: z.number().int().min(MIN_UPLOAD_BYTES).max(MAX_UPLOAD_BYTES_LIMIT).optional(),
});

// --- Исполнение (ADR-077) ---

/**
 * ADR-077: топология исполнения — переключатель запуска (`execution.mode`).
 *
 * - `inline` (дефолт) — исполнение в процессе backend'а (прежнее поведение,
 *   all-in-one образ);
 * - `remote` — отдельные исполнители (`RemoteExecutionPort` + сервис-исполнитель,
 *   шаг 7 плана ADR-077).
 *
 * Секция — **параметр запуска**, а не runtime-настройка: смена режима — только
 * рестартом процесса (инвариант 24 — process-глобальные решения не
 * переинициализируются на лету). Значение `mode` — **fail-closed**: неизвестное
 * явное значение (опечатка `inlne`) валит старт, а не молча выбирает дефолт
 * (как `storage.backend`).
 */
export const EXECUTION_MODES = ['inline', 'remote'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Поведение при недоступном исполнителе:
 * - `fail` (дефолт) — fail-closed: инструмент недоступен с явной причиной;
 * - `inline-fallback` — backend исполняет команду сам; **только явной настройкой**
 *   (в managed-контуре это обход изоляции).
 */
export const EXECUTION_FAIL_MODES = ['fail', 'inline-fallback'] as const;
export type ExecutionFailMode = (typeof EXECUTION_FAIL_MODES)[number];

/**
 * Таймаут exec-вызова по умолчанию (30 с — как у нынешних тулов: shell/search/git).
 * Больший лимит для shell (до 120 с) — свойство тула, не конфига.
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Параметры удалённого исполнителя (`execution.remote`).
 *
 * - `url` — **список** адресов исполнителей (K8s Service `synth-executor`,
 *   `http://…`); пусто при `mode: remote` → fail-closed на старте;
 * - `timeoutMs` — таймаут exec-вызова;
 * - `concurrency` — лимит одновременных exec-вызовов на backend; не задан —
 *   число CPU процесса;
 * - `failMode` — поведение при недоступном исполнителе;
 * - `tokenSecret` — **путь/ссылка** на токен исполнителя, НЕ значение
 *   (инвариант 13): сам токен — `synth_exec_…` и живёт в Secret/файле.
 */
export const executionRemoteConfigSchema = z.object({
  url: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).default(DEFAULT_EXECUTION_TIMEOUT_MS),
  /** Лимит одновременных exec-вызовов; не задан — число CPU процесса. */
  concurrency: z.number().int().min(1).optional(),
  failMode: z.enum(EXECUTION_FAIL_MODES).default('fail'),
  /** Путь/ссылка на токен исполнителя (НЕ значение — инвариант 13). */
  tokenSecret: z.string().default(''),
});

/** ADR-077: секция `execution` — топология исполнения (параметр запуска). */
export const executionConfigSchema = z.object({
  mode: z.enum(EXECUTION_MODES).default('inline'),
  remote: executionRemoteConfigSchema.default({}),
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
  /** ADR-070 §2.2: политика prompt-cache — auto (ставить маркеры) | none (отключить). */
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

// --- Session (ADR-025 / ADR-028): настройки по умолчанию для сессий ---

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
  /** ADR-071 §2.2: человекочитаемое описание сервера (попадает в блок `mcp.servers`). */
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
 * ADR-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP-серверов.
 * Дефолт — `deny` приватных/служебных диапазонов (SSRF/egress).
 */
export const mcpNetworkPolicySchema = z.object({
  mode: z.enum(MCP_NETWORK_POLICY_MODES).default(DEFAULT_MCP_NETWORK_POLICY.mode),
  list: z.array(z.string()).default([...DEFAULT_MCP_PRIVATE_CIDRS]),
  /** Allow-правила-исключения (общий формат с `egress.*`). */
  exceptions: z.array(z.string()).default([]),
});

export const mcpConfigSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
  networkPolicy: mcpNetworkPolicySchema.default({}),
  /**
   * ADR-071 §2.3: глобальная админская политика включения **MCP**-инструментов.
   * Независима от `tools.policy` (только встроенные). Per-session override —
   * `SessionSettings.mcpPolicy`.
   */
  policy: z.enum(TOOLS_POLICIES).default('auto'),
});

// --- Инструменты (ADR-071 §2.3) ---

/**
 * ADR-071 §2.6: instance-wide жёсткое отключение инструментов администратором.
 * Отключённые тулы не попадают в запрос независимо от `tools.policy`.
 * `runtime`-capability неотключаема (ядро сессии).
 */
export const toolsDisabledConfigSchema = createToolsDisabledSchema(false);

/**
 * ADR-071 §2.3: глобальная админская политика включения **встроенных**
 * инструментов (MCP — отдельная `mcp.policy`). Per-session override —
 * `SessionSettings.toolsPolicy`.
 */
export const toolsConfigSchema = z.object({
  policy: z.enum(TOOLS_POLICIES).default('auto'),
  /** ADR-071 §2.6: instance-wide отключение инструментов (admin). */
  disabled: toolsDisabledConfigSchema.default({}),
});

// --- Скиллы (ADR-046) ---

/**
 * ADR-046 §4.2/§4.4/§7.4: конфигурация механизма скиллов.
 * `paths` — дополнительные пользовательские каталоги; `trustedProjectDirs` —
 * доверенные проектные каталоги (бинарный trust); `inlineShell` — выключатель
 * `!`cmd`` в шаблонных командах (по умолчанию выключено).
 *
 * `urls` — внешние удалённые каталоги (opencode-совместимый `index.json`):
 * **только read-only индексация** — скачиваются в `{dataDir}/skills-cache/urls`,
 * видны в реестре/диагностике, но `trusted: false` (в каталог для модели не
 * попадают, тело не грузится). Установка/доверие/подписи/`lock.json` — PROP-068.
 *
 * Внешние локальные каталоги совместимости (`.opencode`, `.claude`, `.agents`,
 * `~/.config/opencode`) подключаются как read-only discovery в core (ADR-046 §4.2).
 */
export const skillsConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
  /** ADR-046 §4.2/§4.3: удалённые каталоги — read-only индексация (`trusted: false`). */
  urls: z.array(z.string()).default([]),
  trustedProjectDirs: z.array(z.string()).default([]),
  inlineShell: z.boolean().default(false),
  /**
   * ADR-046 §3.2/§12: именованные группы тулов → capabilities. Используется
   * для экспансии `metadata.synth.requires_toolsets` в проверку доступности
   * скилла (union с `requires_capabilities`).
   */
  toolsets: z.record(z.string(), z.array(z.enum(toolCapabilityValues))).default({}),
});

// --- Slash-команды (ADR-046 §7) ---

/**
 * ADR-046 §7/§9.4: конфигурация slash-команд. `paths` — дополнительные каталоги
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

// --- Внешние события (ADR-089) ---

/**
 * ADR-089: конфигурация приёма внешних событий.
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
 * - `decisionRouting` — ADR-084 × ADR-089: умная классификация внешних событий
 *   decision-моделью. `false` (default, opt-in) — только декларативные правила
 *   (`ProjectRuleProvider`); `true` — при промахе правил decision-модель выбирает
 *   шаблон агента для ephemeral-сессии. Fail-safe: ошибка/неуверенность/пустой
 *   список агентов → фоллбек Router (`defaultMode`);
 * - `autoBind` — ADR-089: фоллбек Router закрепляет событие с `identity.chatKey`/
 *   `threadKey` за новой сессией (`EventBinding` `mode='bound'`) вместо
 *   `defaultMode`. `false` (default) — поведение не меняется; влияет только на
 *   фоллбек;
 * - `autoBindAgentTemplate` — шаблон агента для auto-bind-сессий (пусто — агент
 *   по умолчанию);
 * - `identityMap` — ADR-089: маппинг идентичности внешнего отправителя на
 *   владельца синт-сессии. Ключ — `identity.chatKey` (`chat:telegram:<id>`) или
 *   `identity.principalId` (`tg:<id>`), значение — id пользователя
 *   синт-инстанса. Применяется при материализации сессий `ephemeral`/`bind`:
 *   совпадение (сначала `chatKey`, затем `principalId`) задаёт владельца сессии.
 *   Пусто (default) — сессия принадлежит аутентифицированному пользователю
 *   запроса (или `identity.principalId`/`resolveOwnerId`), прежнее поведение.
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
   * Глобальный дефолт лимита запросов/мин на API-ключ привязки (ADR-089/ADR-052).
   * `0` — без лимита; конкретный ключ может переопределить своим
   * `rateLimitPerMinute`.
   */
  keyRateLimitPerMinute: z.number().int().min(0).default(0),
  /**
   * ADR-084 × ADR-089: decision-маршрутизация внешних событий. По умолчанию
   * выключена (поведение не меняется) — включение требует настроенного
   * decision-провайдера (`decision.enabled`).
   */
  decisionRouting: z.boolean().default(false),
  /**
   * ADR-089 (auto-bind): фоллбек Router — если у события есть `identity.chatKey`
   * или `identity.threadKey`, закрепить его за новой сессией (создать
   * `EventBinding` `mode='bound'`) вместо `defaultMode`. По умолчанию выключено
   * (поведение не меняется). Влияет **только** на фоллбек — явный binding,
   * правила и decision-маршрутизация сохраняют своё поведение.
   */
  autoBind: z.boolean().default(false),
  /**
   * ADR-089 (auto-bind): шаблон агента для auto-bind-сессий (пусто — агент по
   * умолчанию; резолвится через `AgentRegistry` с политикой `unknownAgentTemplate`).
   */
  autoBindAgentTemplate: z.string().default(''),
  /**
   * ADR-089: маппинг идентичности внешнего отправителя (`identity.chatKey` или
   * `identity.principalId`) на владельца синт-сессии (id пользователя
   * инстанса). Применяется при материализации `ephemeral`/`bind`; пусто —
   * владелец не переопределяется (аутентифицированный пользователь запроса,
   * `identity.principalId` или `resolveOwnerId`).
   */
  identityMap: z.record(z.string(), z.string()).default({}),
});

// --- Планировщик расписаний (ADR-051 срез / ADR-089) ---

/**
 * ADR-051 (минимальный срез) / ADR-089: конфигурация cron/interval-планировщика.
 * - `enabled` — мастер-выключатель сервиса (в standalone гейтит `start()`);
 * - `tickSec` — период тика, секунды (1..3600);
 * - `catchUp` — дефолт поведения при пропущенном срабатывании (`skip`/`once`);
 * - `jobRetentionDays` — срок хранения Job-истории (дни, `prune` на старте);
 * - `leaderElection` — выбор лидера-владельца тикера: `none` (каждый процесс
 *   считает себя лидером, поведение single-process) | `file` (file-based lock на
 *   общем `dataDir`) | `postgres` (session-level advisory-lock БД; требует
 *   `storage.backend=postgres`, иначе — `AlwaysLeader`). Default — `none` (OFF);
 * - `crossProcessLocks` — межпроцессная сериализация мутаций `ScheduleStore`
 *   (file-мьютекс поверх in-process `AsyncLock`). Default — `false` (OFF):
 *   поведение single-process не меняется. Под `storage.backend=postgres`
 *   `ScheduleStore` не используется (мутации — атомарные SQL), лок не создаётся.
 */
export const schedulerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tickSec: z.number().int().min(1).max(3600).default(60),
  catchUp: z.enum(['skip', 'once']).default('skip'),
  jobRetentionDays: z.number().int().min(0).default(30),
  leaderElection: z.enum(['none', 'file', 'postgres']).default('none'),
  crossProcessLocks: z.boolean().default(false),
});

// --- Decision-модели (ADR-084) ---

/**
 * ADR-084: конфигурация класса decision-моделей (System One: Clef/Jev/…).
 * - `enabled` — мастер-выключатель decision-слоя (по умолчанию выключен);
 * - `provider` — имя провайдера decision-типа (`decision`/`systemone`);
 * - `model` — модель decision-слоя (напр. `clef-flash`);
 * - `confidenceThreshold` — порог уверенности, ниже — fallback (fail-safe);
 * - `escalationProvider`/`escalationModel` — необязательный точный тир на
 *   эскалацию (вторая пара provider/model, напр. Clef): при промахе primary
 *   decision-каскад пробует эскалацию. Пусто — эскалации нет.
 *
 * Транспорт задаётся типом провайдера (`decision` → `POST {base}/decisions`,
 * `systemone` → `POST {base}/v1/systemone`), а таймаут — свойством провайдера.
 */
export const decisionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default(''),
  model: z.string().default(''),
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  /** ADR-084: провайдер тира эскалации; пусто — эскалации нет. */
  escalationProvider: z.string().default(''),
  /** ADR-084: модель тира эскалации; пусто — эскалации нет. */
  escalationModel: z.string().default(''),
});

// --- Аналитика и отчётность (ADR-102) ---

/**
 * ADR-102: конфигурация аналитики инстанса.
 * - `retentionDays` — срок хранения суточных роллапов (UTC-дни): бакеты со
 *   `day < utcDay(now) - retentionDays` удаляются прунером. `<= 0` — без
 *   ограничения. Default — 400.
 */
export const analyticsConfigSchema = z.object({
  retentionDays: z.number().int().default(400),
});

// --- Наблюдаемость: Prometheus-метрики (ADR-094) ---

/**
 * ADR-094: конфигурация экспорта метрик.
 * - `enabled` — включает `GET /metrics` и сбор HTTP/процессных метрик
 *   (по умолчанию выключено — контракт «эндпоинта нет, пока не включили»).
 *
 * Bearer-токен в конфиге **не хранится** (инвариант 13): env
 * `SYNTH_METRICS_TOKEN` либо файл `{dataDir}/secrets/metrics-token`.
 * Имя env совпадает с Helm-чартом (`SYNTH_METRICS_ENABLED`).
 */
export const metricsConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

// --- Webhooks (ADR-052, этап II) ---

/**
 * ADR-052 (этап II): конфигурация исходящих webhooks.
 * - `enabled` — мастер-выключатель доставки (по умолчанию выключен);
 * - `maxAttempts` — число HTTP-попыток на доставку (экспоненциальный backoff с джиттером);
 * - `timeoutMs` — таймаут одного HTTP-запроса;
 * - `deliveryRetentionDays` — срок хранения журнала доставок (0 — без ограничения).
 *
 * Политика egress (https/приватные адреса) вынесена в `egress.webhooks`
 * (`mode: 'off'` заменяет удалённый `allowPrivateTargets`).
 */
export const webhooksConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(5),
  timeoutMs: z.number().int().min(1).default(10_000),
  deliveryRetentionDays: z.number().int().min(0).default(30),
});

// --- Слой плагинов (PROP-090 §10) ---

/**
 * PROP-090 §10: конфигурация слоя плагинов (Extension API).
 *
 * - `enabled` — мастер-выключатель Extension API (по умолчанию включён: слой
 *   Ф0–Ф2 ещё не исполняет код плагинов, но политики читаются);
 * - `runtimeInstall` — установка плагинов во время работы инстанса
 *   (`allow`/`deny`; по умолчанию `deny` — в managed установка только
 *   deploy-time);
 * - `trustFloor` — минимальный уровень доверия для **активации** плагина
 *   (по умолчанию `trusted`: плагин ниже порога устанавливается, но не
 *   активируется — PROP-090 §9);
 * - `scan` — статический сканер содержимого расширения
 *   (`enabled`/`disabled`; по умолчанию включён);
 * - `allowlist`/`denylist` — списки имён расширений, которым разрешён/
 *   запрещён запуск (пусто — политика не применяется);
 * - `remoteAllowlist` — allow-list расширений для hybrid-контура (Ф7);
 * - `exactHostExceptions` — путь к файлу точных исключений семвер-гейта
 *   (формат файла — открытый вопрос PROP-090 §14);
 * - `promptBlockMaxChars` — бюджет символов **на блок** системного промпта
 *   от плагина (по умолчанию 4000; превышение — обрезка хостом с маркером
 *   усечения, PROP-090 §5);
 * - `executionEnabled` — **главный переключатель исполнения кода плагинов**
 *   (по умолчанию `false`: в Ф1 загрузчик доводит плагин до шага `import` и
 *   останавливается — `plugin.execution_disabled`; в Ф3/Ф4 включает `inline`/
 *   `out-of-process`).
 */
export const pluginsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  runtimeInstall: z.enum(['allow', 'deny']).default('deny'),
  trustFloor: catalogTrustLevelSchema.default('trusted'),
  scan: z.enum(['enabled', 'disabled']).default('enabled'),
  allowlist: z.array(z.string().min(1)).default([]),
  denylist: z.array(z.string().min(1)).default([]),
  remoteAllowlist: z.array(z.string().min(1)).default([]),
  exactHostExceptions: z.string().default(''),
  promptBlockMaxChars: z.number().int().positive().default(4000),
  executionEnabled: z.boolean().default(false),
  /**
   * Бюджет времени на один вызов фильтра LLM-вызовов, мс (точка
   * `llmFilters`, PROP-090 §6). Не задан фильтром — берётся это значение;
   * по истечении применяется `failMode` фильтра (`closed` → вызов не уходит,
   * `open` → вызов идёт, факт — в аудите).
   */
  llmFilterTimeoutMs: z.number().int().positive().default(DEFAULT_LLM_FILTER_TIMEOUT_MS),
});

// --- Egress-политика (shared формат tools/webhooks/MCP) ---

/** Общий формат политики egress (`mode` + `list` + `exceptions`). */
export const egressPolicySchema = z.object({
  mode: z.enum(EGRESS_POLICY_MODES).default(DEFAULT_EGRESS_TOOLS_POLICY.mode),
  list: z.array(z.string()).default([...DEFAULT_MCP_PRIVATE_CIDRS]),
  exceptions: z.array(z.string()).default([]),
});

/** Политика webhooks: дополнительно `off` (dev — без проверок и без https). */
export const webhooksEgressPolicySchema = z.object({
  mode: z.enum(WEBHOOKS_EGRESS_POLICY_MODES).default(DEFAULT_EGRESS_WEBHOOKS_POLICY.mode),
  list: z.array(z.string()).default([...DEFAULT_MCP_PRIVATE_CIDRS]),
  exceptions: z.array(z.string()).default([]),
});

export const egressLogConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_EGRESS_LOG.enabled),
  retentionDays: z.number().int().min(0).default(DEFAULT_EGRESS_LOG.retentionDays),
});

/**
 * `egress` — настраиваемая политика исходящих запросов (tools/webhooks) и
 * журнал внешних запросов. `mcp.networkPolicy` остаётся отдельным ключом, но
 * использует тот же формат (mode `deny|allow` + `exceptions`).
 */
export const egressConfigSchema = z.object({
  tools: egressPolicySchema.default({}),
  webhooks: webhooksEgressPolicySchema.default({}),
  log: egressLogConfigSchema.default({}),
});

// --- Проектные инструкции (ADR-069) ---

/**
 * ADR-069 §3.4/§11: дополнительный источник проектных инструкций.
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
 * ADR-069 §4: параметры lazy-догрузки подкаталогов (реализация — Фаза 2;
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
 * ADR-069 §5.1/§9.1: параметры fetch URL-источников (без фонового таймера —
 * загрузка при старте + TTL-кэш). Реализация fetch — Фаза 2.
 */
export const instructionsFetchConfigSchema = z.object({
  timeoutMs: z.number().int().min(1).default(5_000),
  cacheTtlSec: z.number().int().min(0).default(3_600),
  maxBytes: z.number().int().min(1).default(262_144),
});

/**
 * ADR-069 §5.1/§9.1: конфигурация проектных инструкций (`AGENTS.md` и совместимые).
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

/**
 * ADR-052/O1: installer service-key, провижининг которого делается при старте из
 * конфига/Secret (идемпотентно). `secret` — plaintext-секрет `synth_svc_…`
 * (приходит из env/Secret; in config.yaml держать не рекомендуется). `scopes` —
 * только известные (`serviceScopeSchema`); `roles` не заданы — дефолт хранилища.
 */
export const bootstrapServiceKeySchema = z.object({
  label: z.string().trim().min(1),
  secret: z.string().min(1),
  scopes: z.array(serviceScopeSchema).min(1),
  roles: z.array(globalRoleSchema).optional(),
  description: z.string().optional(),
});

export const bootstrapServiceKeysSchema = z.array(bootstrapServiceKeySchema);

/**
 * ADR-099 (единый механизм доверия TLS/CA): секция `security.tls`.
 *
 * Задаёт доверие для **исходящих** соединений Synth (https-провайдеры, MCP,
 * webhooks, гибридный backend, OIDC, git, загрузка иконок/обновлений):
 * - `caFile` — путь к PEM-файлу с доверенным CA-сертификатом (корпоративный CA);
 * - `caPem` — сам PEM-сертификат (например из Secret) — **взаимоисключающ** с `caFile`;
 * - `certFile`/`keyFile` — клиентский сертификат и ключ (mTLS);
 * - `rejectUnauthorized` — проверять сертификат сервера (по умолчанию `true`).
 *
 * Читать эффективные значения через `resolveTlsConfig`/`resolveTlsTrust` (ADR-023:
 * env > config.yaml > defaults). Пусто — системное доверие (поведение не меняется).
 * Опционально — литеральные `SecurityConfig` без поля валидны.
 */
export const securityTlsConfigSchema = z.object({
  /** Путь к PEM-файлу доверенного CA. Взаимоисключающ с `caPem`. */
  caFile: z.string().optional(),
  /** PEM доверенного CA (приоритетно над файлом; взаимоисключающ с `caFile`). */
  caPem: z.string().optional(),
  /** Путь к PEM-файлу клиентского сертификата (mTLS). */
  certFile: z.string().optional(),
  /** Путь к PEM-файлу приватного ключа клиента (mTLS). */
  keyFile: z.string().optional(),
  /** Проверять сертификат сервера (по умолчанию `true`). */
  rejectUnauthorized: z.boolean().optional(),
});

export const securityConfigSchema = z.object({
  promptInjection: promptInjectionConfigSchema.default({}),
  protectedPaths: protectedPathsConfigSchema.default({}),
  /** ADR-099: единый механизм доверия TLS/CA для исходящих соединений. */
  tls: securityTlsConfigSchema.optional(),
  /**
   * ADR-076: мастер-ключ для шифрования секретов at-rest (SSH-ключи, AES-256-GCM).
   * Приоритет — env `SYNTH_SECRET_KEY` (читать через `resolveSecretKey`).
   * Пусто — core использует файл `{dataDir}/secrets/master.key`.
   */
  secretKey: z.string().default(''),
  /**
   * ADR-052/O1: installer service-key'и, провижининг которых выполняется
   * идемпотентно при старте (core standalone и backend). Может задаваться
   * JSON-строкой через env `SYNTH_BOOTSTRAP_SERVICE_KEYS` (приоритетнее
   * config.yaml) — так секрет не попадает в файл конфигурации.
   * Опционально (legacy/литеральные SecurityConfig без поля — валидны).
   */
  bootstrapServiceKeys: bootstrapServiceKeysSchema.optional(),
});

// --- Egress-прокси (ADR-099, этапы D1/D2a) ---

/** Тип аутентификации прокси: D2a — только `basic` (NTLM/Negotiate — D3/D4). */
export const PROXY_AUTH_TYPES = ['basic', 'ntlm', 'negotiate'] as const;
export type ProxyAuthType = (typeof PROXY_AUTH_TYPES)[number];

/**
 * Basic-аутентификация прокси (D2a). Пароль **не хранится в config**
 * (инвариант 13): только env `SYNTH_PROXY_PASSWORD` или файл
 * `{dataDir}/secrets/proxy-password`. Username также может быть в userinfo URL.
 */
export const proxyAuthConfigSchema = z.object({
  type: z.enum(PROXY_AUTH_TYPES).default('basic'),
  username: z.string().default(''),
});

/**
 * TLS к **самому прокси** (D2a) — схема как у `security.tls` (ADR-099):
 * `caFile`/`caPem` (взаимоисключающие), `certFile`/`keyFile` (mTLS к прокси),
 * `rejectUnauthorized`. Доверие к цели по-прежнему задаёт `security.tls`.
 */
export const proxyTlsConfigSchema = z.object({
  caFile: z.string().optional(),
  caPem: z.string().optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
});

/** Режим маршрутизации прокси: `all` — default для всех, `selected` — только правила. */
export const PROXY_MODES = ['all', 'selected'] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];

/** Имя профиля прокси: lower-case буква, далее `[a-z0-9_-]`, длина 1..32. */
export const PROXY_PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const proxyProfileNameSchema = z
  .string()
  .regex(PROXY_PROFILE_NAME_RE, 'имя профиля: ^[a-z][a-z0-9_-]{0,31}$');

/**
 * Именованный профиль прокси (ADR-099, per-host маршрутизация).
 *
 * Набор URL-полей тот же, что у top-level legacy-конфига (`url` и/или
 * `httpProxy`/`httpsProxy`/`allProxy`); профиль обязан задавать хотя бы один URL
 * (проверяется резолвером). `auth` — только Basic; пароль в config не хранится —
 * env/файл: `SYNTH_PROXY_<PROFILE>_PASSWORD` / `{dataDir}/secrets/proxy/<profile>.password`
 * (для `default` — legacy `SYNTH_PROXY_PASSWORD` / `{dataDir}/secrets/proxy-password`).
 */
export const proxyProfileSchema = z.object({
  label: z.string().optional(),
  url: z.string().optional(),
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  allProxy: z.string().optional(),
  auth: proxyAuthConfigSchema.optional(),
  tls: proxyTlsConfigSchema.optional(),
});

/** Действие правила маршрутизации: через прокси либо напрямую. */
export const proxyRuleActionSchema = z.enum(['proxy', 'direct']);

/**
 * Правило маршрутизации по хосту (порядок = приоритет, первое совпадение).
 * `hosts` — exact, `.suffix` (apex+sub), `*.suffix` (sub), `host:port`, IP, CIDR, `*`.
 * `action: direct` несовместим с `profile`.
 */
export const proxyRuleSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().optional(),
  hosts: z.array(z.string().min(1)).min(1),
  action: proxyRuleActionSchema,
  profile: proxyProfileNameSchema.optional(),
});

/**
 * ADR-099 (D1/D2a): HTTP/HTTPS-прокси единого egress-слоя.
 *
 * - `enabled` — явный выключатель; **не задан** — прокси включается наличием
 *   URL (в т.ч. из стандартных env при `fromEnv`); явный `false` подавляет
 *   стандартные `HTTP_PROXY`/… (прокси не включается «из окружения»);
 * - `url` + `httpProxy`/`httpsProxy`/`allProxy` — URL прокси (`http`/`https`;
 *   userinfo допускается, креды вырезаются в resolved-конфиг; SOCKS5 — D2b);
 * - `auth` — Basic-аутентификация (`username`; пароль — env/файл, не config);
 * - `tls` — TLS/mTLS к самому прокси (`proxyTls`);
 * - `noProxy` — исключения (host, `.suffix`, `*.suffix`, `host:port`, IP, CIDR, `*`);
 * - `fromEnv` — учитывать стандартные `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`;
 * - `fallbackDirect` — явный opt-in: при недоступном прокси идти напрямую (warn);
 * - `connectTimeoutMs` — таймаут соединения с прокси.
 *
 * Эффективные значения — `resolveProxyConfig` (`config/proxy.ts`), приоритет
 * `SYNTH_PROXY_*` > config.yaml > стандартные env > defaults (ADR-023).
 */
export const proxyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /**
   * Per-host маршрутизация: `all` — `defaultProfile` для всех, кроме `noProxy`
   * (правила могут переопределить); `selected` — только правила, остальное напрямую.
   */
  mode: z.enum(PROXY_MODES).default('all'),
  /** Профиль для `mode: all` и правил без явного `profile` (по умолчанию `default`). */
  defaultProfile: proxyProfileNameSchema.optional(),
  /** Именованные профили. При наличии top-level URL/auth/tls запрещены. */
  profiles: z.record(proxyProfileNameSchema, proxyProfileSchema).optional(),
  /** Правила маршрутизации (первое совпадение). */
  rules: z.array(proxyRuleSchema).optional(),
  url: z.string().optional(),
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  allProxy: z.string().optional(),
  auth: proxyAuthConfigSchema.optional(),
  tls: proxyTlsConfigSchema.optional(),
  noProxy: z.array(z.string()).default([]),
  fromEnv: z.boolean().default(true),
  fallbackDirect: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(1).default(10_000),
});

// --- LLM Gateway (ADR-036) ---

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

// --- Router (ADR-034) ---

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

// --- Micro-first (ADR-035) ---

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
  execution: executionConfigSchema.default({}),
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
  analytics: analyticsConfigSchema.default({}),
  metrics: metricsConfigSchema.default({}),
  plugins: pluginsConfigSchema.default({}),
  egress: egressConfigSchema.default({}),
  webhooks: webhooksConfigSchema.default({}),
  instructions: instructionsConfigSchema.default({}),
  router: routerConfigSchema.default({}),
  proxy: proxyConfigSchema.default({}),
  remote: remoteConfigSchema.default({}),
  microFirst: microFirstConfigSchema.default({}),
  llmGateway: llmGatewayConfigSchema.default({}),
  permission: permissionConfigSchema.default({}),
  security: securityConfigSchema.default({}),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
/** ADR-097: параметры PostgreSQL-backend (`storage.postgres`). */
export type PostgresStorageConfig = z.infer<typeof postgresStorageConfigSchema>;
/** ADR-077: секция `execution` — топология исполнения. */
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
/** ADR-077: параметры удалённого исполнителя (`execution.remote`). */
export type ExecutionRemoteConfig = z.infer<typeof executionRemoteConfigSchema>;
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
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>;
/** ADR-094: секция `metrics` (`enabled`). */
export type MetricsConfig = z.infer<typeof metricsConfigSchema>;
/** PROP-090 §10: секция `plugins` — политики слоя плагинов. */
export type PluginsConfig = z.infer<typeof pluginsConfigSchema>;
export type WebhooksConfig = z.infer<typeof webhooksConfigSchema>;
export type EgressPolicyConfig = z.infer<typeof egressPolicySchema>;
export type WebhooksEgressPolicyConfig = z.infer<typeof webhooksEgressPolicySchema>;
export type EgressLogConfig = z.infer<typeof egressLogConfigSchema>;
export type EgressConfig = z.infer<typeof egressConfigSchema>;
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
/** ADR-099 (D1): секция `proxy` — HTTP/HTTPS-прокси единого egress-слоя. */
export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
/** ADR-099 (D2a): Basic-аутентификация прокси (пароль — env/файл). */
export type ProxyAuthConfig = z.infer<typeof proxyAuthConfigSchema>;
/** ADR-099 (D2a): TLS/mTLS к самому прокси. */
export type ProxyTlsConfig = z.infer<typeof proxyTlsConfigSchema>;
/** ADR-099: именованный профиль прокси (per-host маршрутизация). */
export type ProxyProfileConfig = z.infer<typeof proxyProfileSchema>;
/** ADR-099: правило маршрутизации прокси по хостам. */
export type ProxyRuleConfig = z.infer<typeof proxyRuleSchema>;
export type MicroFirstConfig = z.infer<typeof microFirstConfigSchema>;
export type SynthConfig = z.infer<typeof synthConfigSchema>;
export type PermissionConfig = z.infer<typeof permissionConfigSchema>;
export type PromptInjectionConfig = z.infer<typeof promptInjectionConfigSchema>;
export type ProtectedPathsConfig = z.infer<typeof protectedPathsConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
/** ADR-099: секция `security.tls` — доверие TLS/CA исходящих соединений. */
export type SecurityTlsConfig = z.infer<typeof securityTlsConfigSchema>;
export type BootstrapServiceKeyConfig = z.infer<typeof bootstrapServiceKeySchema>;
export type LLMGatewayRateLimitConfig = z.infer<typeof llmGatewayRateLimitConfigSchema>;
export type LLMGatewayAuditConfig = z.infer<typeof llmGatewayAuditConfigSchema>;
export type LLMGatewayConfig = z.infer<typeof llmGatewayConfigSchema>;
