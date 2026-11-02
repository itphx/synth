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
    maxTokens: 8192,
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
    // Авто-заголовок сессии: включён, приветствие откладывает именование,
    // ждём до 2 реплик, «сигналом задачи» считаем сообщение от 30 символов.
    autoTitle: {
      enabled: true,
      deferOnChatter: true,
      maxAttempts: 2,
      minSignalChars: 30,
    },
  },
  context: {
    enabledFiles: ['SOUL.md', 'COMPANY.md', 'ABOUT.md'],
    // Политика контекстного окна: по умолчанию только предупреждать (блокировка — opt-in).
    windowPolicy: 'warn',
    // Дефолты оптимизации контекста для новых сессий (совпадают с прежними
    // литералами `SessionManager.createSession`).
    defaults: {
      contextOptimization: 'none',
      summarizationEnabled: false,
      summarizationTriggerMode: 'messages',
      summarizeAfterN: 10,
      summarizeTokenThreshold: 50,
      summarizationHeadMessages: 2,
      summarizationTailMessages: 3,
      slidingWindowMode: 'messages',
      slidingWindowMessageLimit: 10,
      slidingWindowTokenThreshold: 80,
    },
    // Instance-wide лимиты заметок сессии (`context.stickyNotes`): ограничения
    // инстанса, не дефолты сессии. Существующие заметки не обрезаются.
    stickyNotes: {
      maxCount: 50,
      maxChars: 2000,
    },
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
    // Общий предел вывода инструментов (строк/байт) — усечение результата
    // с пометкой «показано N из M».
    outputMaxLines: 2000,
    outputMaxBytes: 51_200,
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
  oauth: {
    // ADR-105 (Ф3): каталога OAuth-провайдеров нет — описания задаёт оператор
    // (`oauth.providers` в config.yaml или env `SYNTH_OAUTH_PROVIDERS`).
    providers: {},
  },
  analytics: {
    // ADR-102: срок хранения суточных роллапов — 400 дней (<= 0 — без ограничения).
    retentionDays: 400,
  },
  git: {
    // ADR-076: таймауты сетевых git-операций. 5 минут: сеть git может идти
    // минутами (большой репозиторий/медленный remote), но «зависший» вызов не
    // должен держать ход агента бесконечно; 0 — без таймаута.
    cloneTimeoutMs: 300_000,
    fetchTimeoutMs: 300_000,
    // Таймауты git-тулов агента по классам операции: локальные изменяющие
    // (commit/checkout/stash) — 2 минуты, сетевые (push/pull) — 5 минут.
    // Read-only операции имеют фиксированный предел 30 с. 0 — без таймаута.
    localTimeoutMs: 120_000,
    networkTimeoutMs: 300_000,
  },
  questions: {
    // Этап 1 roadmap 0.13 (блок 3): срок ожидания ответа пользователя на вопрос —
    // по умолчанию **без таймаута** (0): вопрос ждёт, пока ответят или отменят
    // вручную. Тул `question` может задать срок для конкретного вопроса
    // (`timeout`, ≥ 5 минут — не рекомендуется: ожидание обрывается).
    timeoutMs: 0,
    // Срок хранения терминальных записей вопросов (дни; <= 0 — без ограничения).
    retentionDays: 14,
  },
  background: {
    // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов
    // (PROP-096 — фоновые саб-агенты, PROP-097 — фоновые шелл-процессы).
    // Фоновая работа включена; лимиты — по родительской сессии.
    enabled: true,
    // Максимум одновременно идущих фоновых саб-агентов на родительскую сессию.
    maxSubagentsPerSession: 2,
    // Максимум одновременно идущих фоновых шелл-процессов на сессию-владельца.
    maxProcessesPerSession: 5,
    // Максимум одновременно идущих прогонов любого вида на сессию-владельца
    // (история реестра лимитом не считается — её чистит retention).
    maxRunsPerSession: 10,
    // Предел размера лога фонового процесса, байт (10 МиБ; 0 — без ограничения).
    logMaxBytes: 10_485_760,
    // Срок хранения терминальных записей реестра (дни; <= 0 — без ограничения).
    retentionDays: 7,
  },
  agents: {
    // Предохранитель по объёму промпта саб-агента (не окно модели): при
    // превышении оценка бюджета завершает прогон детерминированным отчётом.
    // 0 — без ограничения.
    subagentMaxInputTokens: 0,
    // Лимит глубины вложенности саб-агентов (по цепочке `parentId` сессий:
    // текущая — 0, родитель — 1, …). 0 — без ограничения.
    subagentDepth: 1,
  },
  attachments: {
    // ADR-115: вложения сообщений. Мастер-выключатель, семейства MIME,
    // лимиты (байты на файл, число файлов в сообщении, суммарный объём на
    // сессию), белый список MIME, резервное хранение в workspace и срок
    // хранения осиротевших объектов.
    enabled: true,
    modalities: { image: true, pdf: true, audio: true, video: true },
    maxBytesPerFile: 100 * 1024 * 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 1024 * 1024 * 1024,
    allowedMimePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'text/'],
    workspaceFallback: true,
    // ADR-115: модели обработки по семействам (aux-модели). Пусто — обработка
    // не настроена: вложение, которое модель сессии не принимает, отбрасывается
    // с путём в workspace (текущее поведение).
    modalityModels: {},
    gcDays: 30,
    // ADR-115: сжатие — только на границе отправки провайдеру (в blob лежит
    // оригинал). Пределы сторон/битрейты — разумные дефолты для чата; пороги
    // `minBytes` не дают перекодировать мелкие файлы.
    compression: {
      enabled: true,
      image: { enabled: true, maxSidePx: 2048, quality: 85, minBytes: 1024 * 1024 },
      video: {
        enabled: true,
        maxHeightPx: 720,
        bitrateKbps: 2000,
        audioBitrateKbps: 96,
        minBytes: 8 * 1024 * 1024,
      },
      audio: {
        enabled: true,
        bitrateKbps: 64,
        channels: 1,
        sampleRateHz: 16000,
        minBytes: 4 * 1024 * 1024,
      },
    },
    // ADR-115: серверные миниатюры для UI (производный JPEG в blob).
    thumbnail: { enabled: true, maxWidthPx: 512 },
    // Предел одной части chunked-загрузки, байт (8 МиБ).
    maxChunkBytes: 8 * 1024 * 1024,
  },
  metrics: {
    // ADR-094: экспорт Prometheus-метрик выключен по умолчанию (`GET /metrics` → 404).
    enabled: false,
  },
  authority: {
    // ADR-106 Ф1: Authority-слой выключен по умолчанию — права не меняются.
    enabled: false,
    // При включении слоя он сначала только наблюдает (shadow): решение
    // считается и пишется в журнал, но не применяется.
    shadow: true,
  },
  plugins: {
    // ADR-090: слой плагинов. Мастер-выключатель Extension API включён;
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
    // Ф3б). Значение — вопрос владельца (ADR-090), механизм fail-closed/open
    // реализован.
    llmFilterTimeoutMs: DEFAULT_LLM_FILTER_TIMEOUT_MS,
    // Ф5в: каталог deploy-плагинов (образ/PVC). Пусто — не задан.
    deployDir: '/opt/synth/plugins',
    // Ф5в: доверие deploy-бандлов (образ — доверенный источник, но не выше
    // политики инстанса: ниже trust-floor — штатный отказ).
    deployTrust: 'trusted',
    // Ф5в: management-плагин нельзя снять/переустановить через API/CLI.
    managedReadonly: true,
    // ADR-090 (WP-F): провайдер/модель эмбеддингов для `facade.embed`.
    // Пусто — сервис эмбеддингов не сконфигурирован (вызов бросает
    // `plugin.embedding_not_configured`, плагин решает, деградировать ли).
    embeddingProvider: '',
    embeddingModel: '',
    // Ф7: серверная политика плагинов в гибриде. По умолчанию сервер не
    // ограничивает плагины (`off`); allow-list включается явно.
    hybrid: {
      mode: 'off',
      allow: [],
    },
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
    // ADR-029: срок ожидания подтверждения `ask` (по истечении — авто-отказ).
    // 5 минут: пользователь должен успеть увидеть запрос и ответить.
    askTimeoutMs: 300_000,
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
