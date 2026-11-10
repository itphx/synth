/**
 * Единый маппинг `SynthConfig` → опции `createStandaloneApp` (ADR-023).
 *
 * Зачем шов: у standalone-инстанса две точки входа — core-CLI (`src/main.ts`,
 * dev/внутренний) и публичный CLI `@itphx/synth` (`packages/synth/src/cli.ts`,
 * npm-потребители). Каждая раньше собирала объект `StandaloneConfig` руками, и
 * публичный CLI передавал лишь малую часть секций: в npm-инсталляции молча
 * игнорировались `skills.trustedProjectDirs`, `commands`, `permission`, `tools`,
 * `mcp.servers`, `plugins`, `git`, `attachments`, `limits`, `execution` и др.
 * Теперь список полей, выводимых из конфига, живёт **здесь** — одна точка
 * правки: новая секция добавляется в этот файл, а не в одну из точек входа.
 *
 * Функция возвращает только **конфиг-производные** поля. То, что относится к
 * запуску (порт, API-ключ, UI, гибрид/профили/credentials — вычисляются из
 * CLI-флагов и файлов), передаёт вызывающий — он кладёт эти поля после spread.
 */

import {
  resolveDefaultWorkspace,
  resolveDegradedMode,
  resolveMaxPreviewBytes,
  resolveMaxReadBytes,
  resolveMaxUploadBytes,
  resolvePostgresConfig,
  resolvePostgresPassword,
  resolveSecretKey,
  resolveStorageBackend,
  resolveStorageFallbackDir,
  resolveWorkspaceOutsideRootPolicy,
  resolveWorkspacesRoot,
} from '@itphx/synth-shared';
import type { ResolvedExecutionConfig, SynthConfig } from '@itphx/synth-shared';
import type { StandaloneConfig } from '../app.js';

/** Вход маппинга: конфиг инстанса + параметры запуска, влияющие на значения. */
export interface StandaloneOptionsInput {
  /** Эффективный конфиг инстанса (`loadConfig`, ADR-023). */
  synth: SynthConfig;
  /** Каталог данных инстанса (уже резолвленный точкой входа). */
  dataDir: string;
  /** ADR-079: home-каталог инстанса — база для путей `storage.*`. */
  home?: string | null;
  /**
   * ADR-069 §9.2: `--ignore-rules`/`--safe-mode` (или env `SYNTH_IGNORE_RULES`) —
   * проектные инструкции не грузятся (`instructions.enabled=false`, конфиг не
   * мутируется).
   */
  ignoreRules?: boolean;
  /**
   * ADR-077: эффективная секция `execution` (параметр запуска). Fail-closed
   * проверку режима выполняет вызывающий **до** сборки приложения
   * (`resolveExecutionForStartup`).
   */
  execution: ResolvedExecutionConfig;
  /** Env-слой резолверов (дефолт `process.env`; тесты передают пустой). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Собирает `Partial<StandaloneConfig>` из `SynthConfig`.
 *
 * Возвращаются все поля `StandaloneConfig`, выводимые из конфига. Запуск-специфичные
 * (`port`, `dataDir`, `apiKey`, `uiDistPath`, `defaultBackendUrl`, `defaultToken`,
 * `hybridEnabled`, `remoteAuth`, `remoteCredentialsPath`, `profilesPath`,
 * `systemPromptsDir`) остаются у вызывающего.
 */
export function buildStandaloneOptions(input: StandaloneOptionsInput): Partial<StandaloneConfig> {
  const { synth, dataDir, home, execution } = input;
  const env = input.env ?? process.env;
  const ignoreRules = input.ignoreRules ?? false;

  return {
    // ADR-096: физический backend хранения (env > config.yaml > file).
    storageBackend: resolveStorageBackend(synth, env),
    postgresConfig: resolvePostgresConfig(synth, env),
    postgresPassword: resolvePostgresPassword({ dataDir }, env),
    degradedMode: resolveDegradedMode(synth, env),
    fallbackDir: resolveStorageFallbackDir(synth, env, home),
    workspacesRoot: resolveWorkspacesRoot(synth, env, home),
    defaultWorkingDir: resolveDefaultWorkspace(synth, env, home),
    // ADR-077: режим исполнения и параметры удалённого исполнителя —
    // порт собирается по ним (параметр запуска, инвариант 24).
    executionConfig: execution,
    maxUploadBytes: resolveMaxUploadBytes(synth, env),
    maxReadBytes: resolveMaxReadBytes(synth, env),
    maxPreviewBytes: resolveMaxPreviewBytes(synth, env),
    permissionConfig: synth.permission,
    defaultPlanMode: synth.session?.planMode,
    // Секция `session` целиком: planMode + autoTitle (авто-именование).
    sessionConfig: synth.session,
    securityConfig: synth.security,
    // ADR-099 (D1): HTTP/HTTPS-прокси единого egress-слоя.
    proxyConfig: synth.proxy,
    // ADR-076: мастер-ключ шифрования SSH-ключей (env > config > file в dataDir).
    secretKey: resolveSecretKey(synth, env),
    gatewayConfig: synth.llmGateway,
    llmCachePolicy: synth.llm.cache,
    // Лимит вывода по умолчанию (`llm.maxTokens`) — резолв `max_tokens` вызова.
    llmMaxTokens: synth.llm.maxTokens,
    // ADR-089: дефолтные provider/model инстанса — для сессий из внешних событий
    // (materialize ephemeral/bind), когда явная модель не задана.
    llmDefaults: { provider: synth.llm.defaultProvider, model: synth.llm.defaultModel },
    toolsPolicy: synth.tools.policy,
    mcpPolicy: synth.mcp?.policy,
    toolsDisabled: synth.tools.disabled,
    // Общий предел вывода инструментов (`tools.outputMaxLines`/`tools.outputMaxBytes`).
    toolsConfig: synth.tools,
    // Политика ограничения контекстного окна (`context.windowPolicy`) и
    // дефолты оптимизации контекста новых сессий (`context.defaults`).
    contextConfig: synth.context,
    // ADR-075: политика для абсолютного workspace вне root (env > config > 'confirm').
    workspaceOutsideRootPolicy: resolveWorkspaceOutsideRootPolicy(synth, env) || 'confirm',
    mcpServers: synth.mcp?.servers ?? {},
    // ADR-046: конфигурация скиллов (paths/trustedProjectDirs/inlineShell).
    skillsConfig: synth.skills,
    // ADR-046 §7: конфигурация slash-команд (paths/bundlesPath/conflict/лимиты).
    commandsConfig: synth.commands,
    // ADR-069 Фаза 1: конфигурация проектных инструкций (AGENTS.md).
    // ADR-069 §9.2: ignore-rules/safe-mode → enabled=false (без мутации конфига).
    instructionsConfig: ignoreRules ? { ...synth.instructions, enabled: false } : synth.instructions,
    // ADR-089: конфигурация приёма внешних событий (allowedSources/ephemeralTtl).
    eventsConfig: synth.events,
    // ADR-051 (срез) / ADR-089: конфигурация планировщика (enabled/tickSec).
    schedulerConfig: synth.scheduler,
    // ADR-084: конфигурация decision-слоя микро-каскада.
    decisionConfig: synth.decision,
    // ADR-105 (Ф3): каталог OAuth-провайдеров (описания внешних доступов).
    oauthProviders: synth.oauth.providers,
    // ADR-102: конфигурация аналитики (retention суточных роллапов).
    analyticsConfig: synth.analytics,
    // ADR-076: таймауты локальных/сетевых git-операций (clone/fetch/push/pull).
    gitConfig: synth.git,
    // Этап 1 roadmap 0.13 (блок 3): «вопрос пользователю» (таймаут ответа).
    questionsConfig: synth.questions,
    // Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов (PROP-096).
    backgroundConfig: synth.background,
    // Предохранитель по объёму промпта саб-агента (`agents.subagentMaxInputTokens`).
    agentsConfig: synth.agents,
    // Лимит тяжёлых операций с сессиями (`limits.sessionOpsPerMinute`).
    limitsConfig: synth.limits,
    // PROP-124: режим инстанса для SSH-ключей (`ssh.mode`).
    sshConfig: synth.ssh,
    // ADR-115: лимиты вложений сообщений (attachments.*).
    attachmentsConfig: synth.attachments,
    // ADR-094: конфигурация метрик (`metrics.enabled`, env SYNTH_METRICS_ENABLED).
    metricsConfig: synth.metrics,
    // ADR-133: каналы и проверка обновлений (`updates.*`).
    updatesConfig: synth.updates,
    // ADR-106 Ф1: Authority-слой (по умолчанию выключен).
    authorityConfig: synth.authority,
    // ADR-090: конфигурация слоя плагинов (политики + бюджеты).
    pluginsConfig: synth.plugins,
    // ADR-052 (этап II): конфигурация исходящих webhooks (enabled/retry).
    webhooksConfig: synth.webhooks,
    // ADR-071 §2.3.1 / egress: политика сетевого доступа (config-фоллбек).
    mcpNetworkPolicy: synth.mcp.networkPolicy,
    // Egress: настраиваемая политика tools/webhooks + журнал внешних запросов.
    egressConfig: synth.egress,
    // Гибрид: маршрутизация LLM локальных сессий и таймаут удалённого backend.
    remoteLlm: synth.remote.llm,
    remoteTimeoutMs: synth.remote.timeoutMs,
  };
}
