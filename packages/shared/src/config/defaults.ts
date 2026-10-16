import type { SynthConfig } from './types.js';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '../types/index.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../types/index.js';

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
    // PROP-032: параметры PostgreSQL-backend (пусто — драйвер берёт дефолты/env).
    postgres: {},
    // PROP-032 (задел W5): при недоступности backend — файловый фоллбек в {dataDir}/fallback.
    degradedMode: 'fallback-file',
    fallbackDir: '',
    workspacesRoot: '',
    defaultWorkspace: '',
    workspaceOutsideRoot: '',
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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
  webhooks: {
    // ADR-052 (этап II): доставка webhooks выключена по умолчанию (opt-in).
    enabled: false,
    maxAttempts: 5,
    timeoutMs: 10_000,
    // Только https и публичные адреса; приватные/loopback — запрещены (SSRF).
    allowPrivateTargets: false,
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
