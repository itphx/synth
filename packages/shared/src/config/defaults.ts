import type { SynthConfig } from './types.js';
import {
  DEFAULT_MCP_PRIVATE_CIDRS,
  DEFAULT_EGRESS_TOOLS_POLICY,
  DEFAULT_EGRESS_WEBHOOKS_POLICY,
  DEFAULT_EGRESS_LOG,
} from '../types/index.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../types/index.js';
import { DEFAULT_PROMPT_BLOCK_MAX_CHARS, DEFAULT_LLM_FILTER_TIMEOUT_MS } from '../types/index.js';
import { DEFAULT_EXECUTION_TIMEOUT_MS } from './types.js';
import { defaultExecutionConcurrency } from './execution.js';

export const defaultConfig: SynthConfig = {
  server: {
    host: '0.0.0.0',
    port: 5000,
    corsOrigin: 'http://localhost:5002',
    allowedOrigins: [],
  },
  storage: {
    dataDir: '/var/synth/data',
    backend: 'file',
    // ADR-097: параметры PostgreSQL-backend (пусто — драйвер берёт дефолты/env).
    postgres: {},
    // ADR-098 (задел W5): при недоступности backend — файловый фоллбек в {dataDir}/fallback.
    degradedMode: 'fallback-file',
    fallbackDir: '',
    workspacesRoot: '',
    defaultWorkspace: '',
    workspaceOutsideRoot: '',
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  },
  execution: {
    // ADR-077: топология исполнения — параметр запуска (инвариант 24: смена
    // режима — только рестартом). `inline` — исполнение в процессе (прежнее
    // поведение); `remote` — отдельные исполнители (шаг 7 плана ADR-077).
    mode: 'inline',
    remote: {
      // Список адресов исполнителей; пусто при `remote` → fail-closed на старте.
      url: [],
      // Таймаут exec-вызова (30 с — как у нынешних тулов).
      timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
      // Лимит одновременных exec-вызовов — число CPU процесса.
      concurrency: defaultExecutionConcurrency(),
      // Fail-closed при недоступности исполнителя; inline-fallback — только
      // явной настройкой.
      failMode: 'fail',
      // Путь/ссылка на токен исполнителя (НЕ значение — инвариант 13).
      tokenSecret: '',
    },
  },
  auth: {
    debugMode: false,
    sessionMaxAgeMinutes: 1440,
  },
  llm: {
    defaultProvider: '',
    defaultModel: '',
    maxRetries: 3,
    timeout: 60,
    cache: 'auto',
  },
  core: {
    port: 4300,
    apiKey: '',
  },
  runner: {
    port: 5200,
    backendUrl: 'http://localhost:5000',
    enginePorts: {
      opencode: 4100,
      cline: 4200,
      synth: 4300,
    },
    proxyPort: 9090,
  },
  ui: {
    port: 5002,
    backendUrl: 'http://localhost:5000',
    theme: 'synthesis',
    themeMode: 'system',
    locale: 'ru',
  },
  i18n: {
    defaultLanguage: 'ru',
    supportedLanguages: ['ru', 'en'],
  },
  logging: {
    groups: {
      OPENAI: 'INFO',
      ANTHROPIC: 'INFO',
      OLLAMA: 'INFO',
      ROUTES: 'WARNING',
      ORCHESTRATOR: 'INFO',
      CHAT_STREAM: 'WARNING',
      STORAGE: 'WARNING',
      DEBUG: 'DEBUG',
      WEBSOCKET: 'INFO',
      MCP: 'INFO',
    },
  },
  tsm: {
    maxIterations: 50,
    validationTimeout: 30,
  },
  session: {
    planMode: 'auto',
  },
  context: {
    enabledFiles: ['SOUL.md', 'COMPANY.md', 'ABOUT.md'],
  },
  summarization: {
    provider: '',
    model: '',
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  },
  mcp: {
    servers: {},
    policy: 'auto',
    networkPolicy: {
      mode: 'deny',
      list: [...DEFAULT_MCP_PRIVATE_CIDRS],
      exceptions: [],
    },
  },
  tools: {
    policy: 'auto',
    disabled: {
      capabilities: [],
      tools: [],
    },
  },
  skills: {
    paths: [],
    urls: [],
    trustedProjectDirs: [],
    inlineShell: false,
    toolsets: {},
  },
  commands: {
    paths: [],
    bundlesPath: 'skill-bundles',
    conflict: {
      mode: 'bundle-wins',
      namespacePrefix: false,
    },
    maxArgumentsLength: 10_000,
    maxRenderedBytes: 200_000,
  },
  events: {
    enabled: true,
    defaultMode: 'bound',
    ephemeralTtl: '24h',
    journalRetentionDays: 30,
    allowedSources: [],
    // Default OFF: дедуп in-process, поведение single-process не меняется (ADR-051/ADR-089).
    dedupStore: 'memory',
    // Неизвестный agentTemplate → drop с аудитом (fail-safe, ADR-089).
    unknownAgentTemplate: 'drop',
    // Глобальный дефолт лимита запросов/мин на API-ключ привязки (0 — без лимита).
    keyRateLimitPerMinute: 0,
    // ADR-084 × ADR-089: decision-маршрутизация событий выключена по умолчанию (opt-in).
    decisionRouting: false,
    // ADR-089 (auto-bind): фоллбек-закрепление события с chatKey/threadKey за сессией — по умолчанию выключено.
    autoBind: false,
    autoBindAgentTemplate: '',
    // ADR-089: маппинг идентичности отправителя события на владельца сессии (пусто — не переопределяется).
    identityMap: {},
  },
  scheduler: {
    enabled: true,
    tickSec: 60,
    catchUp: 'skip',
    jobRetentionDays: 30,
    // Default OFF: leader election и межпроцессные локи выключены (ADR-051/ADR-089).
    leaderElection: 'none',
    crossProcessLocks: false,
  },
  decision: {
    // ADR-084: decision-слой выключен по умолчанию (провайдер задаёт админ).
    enabled: false,
    provider: '',
    model: '',
    confidenceThreshold: 0.6,
    // ADR-084: тир эскалации не задан (пусто — эскалации нет).
    escalationProvider: '',
    escalationModel: '',
  },
  analytics: {
    // ADR-102: срок хранения суточных роллапов — 400 дней (<= 0 — без ограничения).
    retentionDays: 400,
  },
  metrics: {
    // ADR-094: экспорт Prometheus-метрик выключен по умолчанию (`GET /metrics` → 404).
    enabled: false,
  },
  plugins: {
    // PROP-090 §10: слой плагинов. Мастер-выключатель Extension API включён;
    // исполнение кода плагинов появляется в Ф1+ (сейчас — только политики).
    enabled: true,
    // Установка во время работы инстанса — по умолчанию запрещена (managed:
    // только deploy-time).
    runtimeInstall: 'deny',
    // Trust-floor плагина: ниже порога — установка есть, активации нет.
    trustFloor: 'trusted',
    // Статический сканер содержимого расширения включён.
    scan: 'enabled',
    // Списки имён расширений (пусто — политика не применяется).
    allowlist: [],
    denylist: [],
    // Allow-list расширений для hybrid-контура (Ф7).
    remoteAllowlist: [],
    // Файл точных исключений семвер-гейта (формат — открытый вопрос §14).
    exactHostExceptions: '',
    // Бюджет символов на блок системного промпта от плагина.
    promptBlockMaxChars: DEFAULT_PROMPT_BLOCK_MAX_CHARS,
    // Исполнение кода плагинов выключено по умолчанию (Ф1: загрузчик доходит
    // до шага `import` и останавливается — `plugin.execution_disabled`).
    executionEnabled: false,
    // Бюджет времени на один вызов фильтра LLM-вызовов (точка `llmFilters`,
    // Ф3б). Значение — вопрос владельца (PROP-090 §14), механизм fail-closed/open
    // реализован.
    llmFilterTimeoutMs: DEFAULT_LLM_FILTER_TIMEOUT_MS,
  },
  egress: {
    // Политика встроенных инструментов: deny приватных/служебных диапазонов.
    tools: {
      mode: DEFAULT_EGRESS_TOOLS_POLICY.mode,
      list: [...DEFAULT_EGRESS_TOOLS_POLICY.list],
      exceptions: [],
    },
    // Политика webhooks: deny приватных + обязательный https (`off` — dev).
    webhooks: {
      mode: DEFAULT_EGRESS_WEBHOOKS_POLICY.mode,
      list: [...DEFAULT_EGRESS_WEBHOOKS_POLICY.list],
      exceptions: [],
    },
    // Журнал внешних запросов: включён, retention 7 дней (0 — без очистки).
    log: { ...DEFAULT_EGRESS_LOG },
  },
  webhooks: {
    // ADR-052 (этап II): доставка webhooks выключена по умолчанию (opt-in).
    enabled: false,
    maxAttempts: 5,
    timeoutMs: 10_000,
    deliveryRetentionDays: 30,
  },
  instructions: {
    enabled: true,
    claudeCompat: true,
    contextCompat: false,
    headRatio: 0.7,
    tailRatio: 0.2,
    windowRatio: 0.06,
    minChars: 20_000,
    maxCharsCeiling: 500_000,
    lazy: {
      enabled: true,
      maxAncestors: 5,
      maxChars: 8_000,
      excludeDirs: ['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'coverage', 'tmp', '.cache'],
    },
    fetch: {
      timeoutMs: 5_000,
      cacheTtlSec: 3_600,
      maxBytes: 262_144,
    },
    sources: [],
    excludeProjects: [],
    allowInstallTreeFallback: false,
  },
  router: {
    enabled: true,
    strategy: 'auto',
    content: {
      coding: { provider: '', model: '' },
      chat: { provider: '', model: '' },
      research: { provider: '', model: '' },
    },
    escalation: {
      enabled: true,
      fallbackProvider: '',
      fallbackModel: '',
      maxRetries: 1,
      checks: ['min_length', 'constraint'],
      minLength: 10,
    },
    cost: {
      enabled: false,
      cheapProvider: '',
      cheapModel: '',
      expensiveProvider: '',
      expensiveModel: '',
      maxCheapTokens: 500,
    },
    subagent: {
      enabled: true,
      model: '',
      provider: '',
    },
  },
  proxy: {
    // ADR-099 (D1): прокси выключен по умолчанию (поведение не меняется).
    // `enabled` намеренно не задан: явный `false` в config.yaml подавляет
    // стандартные HTTP_PROXY/…, а отсутствие — позволяет включиться из env.
    // `profiles`/`rules` намеренно не заданы: отсутствие = legacy-поведение
    // (top-level URL + синтетический профиль `default`).
    mode: 'all',
    noProxy: [],
    fromEnv: true,
    fallbackDirect: false,
    connectTimeoutMs: 10_000,
  },
  remote: {
    enabled: false,
    backendUrl: '',
    auth: { type: 'device', apiKey: '', issuer: '', clientId: '' },
    llm: 'server',
    worlds: { local: true, remote: true },
    credentialsPath: '',
    timeoutMs: 15000,
  },
  microFirst: {
    enabled: false,
    confidenceThreshold: 0.8,
    microLlmProvider: '',
    microLlmModel: '',
    rulesEnabled: true,
    embeddingEnabled: false,
    embedProvider: 'ollama',
    embedModel: 'local.nomic-embed-text:latest',
    microLlmEnabled: false,
  },
  llmGateway: {
    enabled: false,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: {
      userPerMinute: 60,
      providerPerMinute: 120,
    },
    audit: {
      enabled: true,
      logPath: '',
    },
  },
  permission: {
    rules: {},
    askTimeoutMs: 30_000,
  },
  security: {
    promptInjection: {
      enabled: true,
      wrapContent: true,
      mode: 'flag',
    },
    protectedPaths: {
      enabled: true,
    },
    // ADR-099: доверие TLS/CA исходящих соединений. Пусто — системное доверие
    // (поведение не меняется); caFile — корпоративный CA, cert/key — mTLS.
    tls: {},
    // Пусто — core использует файл {dataDir}/secrets/master.key (ADR-076).
    secretKey: '',
    // ADR-052/O1: installer service-key'и из env/Secret (по умолчанию нет).
    bootstrapServiceKeys: [],
  },
};
