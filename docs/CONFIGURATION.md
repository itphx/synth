# Конфигурация Synth

> 🌐 [English](./en/CONFIGURATION.md) · **Русский**

> [!NOTE]
> Пользовательская часть по настройке — в портале документации:
> https://docs.synth.itphx.ru/admin/configuration/.

## Приоритет

```
CLI-флаги > env vars (SYNTH_*) > config.yaml > defaults
```

- **CLI-флаги** передаются в `loadConfig({ overrides })` — самый высокий приоритет (например `--port`, `--api-key`, `--data-dir` у `synth serve`).
- **Env vars**: скалярные ключи вложенных секций применяются в `loadConfig` поверх `config.yaml` (единый реестр `ENV_OVERRIDES`, см. «Env-оверрайды вложенных секций»); точечные переменные (пути, порты, ключи) читаются резолверами в точках использования (см. таблицу ниже).
- **ADR-079 (home)**: `--home <dir>` (`SYNTH_HOME`) — базовый каталог локального инстанса. Пути: config `<home>/config.yaml`, dataDir `<home>/data`, profiles `<home>/profiles.json`, credentials `<home>/credentials.json`. Приоритет путей: явные флаги (`--data-dir`/`--config`/`--profiles`/`--credentials`) > `--home` > `SYNTH_HOME` > XDG-дефолты. Без home поведение не меняется.
- **config.yaml** — файл, найденный каскадным поиском; сливается с дефолтами (`deepMerge`).
- **Defaults** — схема `synthConfigSchema` в `packages/shared/src/config/types.ts`.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `SYNTH_API_KEY` | Ключ для входа в API (backend → роль ADMIN; core standalone → роль ADMIN). Если не задан, `synth serve` генерирует устойчивый локальный ключ в `{dataDir}/secrets/api-key` | — |
| `SYNTH_DATA_DIR` | Каталог данных (сессии, проекты, провайдеры, модели) | по режиму: `~/.local/share/synth` (user), `./data` (dev), `/var/synth/data` (docker/server) |
| `SYNTH_STORAGE_BACKEND` | ADR-096: физический backend хранения: `file` (JSON-файлы, ADR-005), `memory` (in-memory, данные **не** сохраняются) или `postgres` (PROP-032) | `file` |
| `SYNTH_POSTGRES_DSN` | PROP-032: строка подключения PostgreSQL (приоритетнее отдельных `host`/`port`/`database`/`user`) | — |
| `SYNTH_POSTGRES_HOST` | PROP-032: хост PostgreSQL | — |
| `SYNTH_POSTGRES_PORT` | PROP-032: порт PostgreSQL | — |
| `SYNTH_POSTGRES_DATABASE` | PROP-032: имя базы данных PostgreSQL | — |
| `SYNTH_POSTGRES_USER` | PROP-032: пользователь PostgreSQL | — |
| `SYNTH_POSTGRES_SCHEMA` | PROP-032: схема БД (namespace таблиц драйвера) | — |
| `SYNTH_POSTGRES_SSL` | PROP-032: legacy-флаг TLS-соединения (`true`/`false`); используется, только если `SYNTH_POSTGRES_SSLMODE` не задан | — |
| `SYNTH_POSTGRES_SSLMODE` | PROP-032/ADR-099: TLS-режим соединения с БД: `disable` / `require` / `verify-full` (`verify-ca` — алиас `verify-full`); приоритетнее legacy `ssl` | — |
| `SYNTH_POSTGRES_POOL_MAX` | PROP-032: максимальный размер пула соединений | `10` |
| `SYNTH_POSTGRES_PASSWORD` | PROP-032: пароль БД — **только** env или файл `{dataDir}/secrets/postgres-password` (в `config.yaml` не хранится, инвариант 13) | — |
| `SYNTH_DEGRADED_MODE` | PROP-032/ADR-098: поведение при недоступности БД (`fallback-file`/`halt`) | `fallback-file` |
| `SYNTH_STORAGE_FALLBACK_DIR` | PROP-032/ADR-098: каталог файлового фоллбека при деградации | `{dataDir}/fallback` |
| `SYNTH_WORKSPACES_ROOT` | Корень каталогов workspace проектов (`storage.workspacesRoot`) | `{dataDir}/workspaces` |
| `SYNTH_DEFAULT_WORKSPACE` | Рабочий каталог по умолчанию (`storage.defaultWorkspace`) | `{dataDir}/workspaces/default` |
| `SYNTH_WORKSPACE_OUTSIDE_ROOT` | ADR-075: политика абсолютного workspace вне `workspacesRoot` (`confirm`/`deny`) | по режиму (standalone — `confirm`, managed — `deny`) |
| `SYNTH_MAX_UPLOAD_BYTES` | Максимальный размер загрузки файла `/api/v2/fs/upload` (`storage.maxUploadBytes`), байт | `104857600` (100 МиБ) |
| `SYNTH_CONFIG` | Путь к `config.yaml` (приоритетнее каскадного поиска) | каскадный поиск |
| `SYNTH_HOME` | ADR-079: базовый home-каталог локального инстанса (`--home`): config/data/profiles/credentials резолвятся от него | — |
| `SYNTH_HOST` | Адрес прослушивания HTTP-серверов (backend — `0.0.0.0`; `synth serve` — `127.0.0.1`) | `0.0.0.0` / `127.0.0.1` (serve) |
| `SYNTH_PORT` | Порт бэкенда | `5000` |
| `SYNTH_CORE_PORT` | Порт core (и `synth serve`) | `4300` |
| `SYNTH_RUNNER_PORT` | Порт раннера | `5200` |
| `SYNTH_AUTH_DEBUG` | Режим отладки auth (тестовые пользователи) | `false` |
| `SYNTH_DEFAULT_LANGUAGE` | Язык интерфейса backend (`ru`/`en`; проверяется префикс `en`) | `ru` |
| `SYNTH_DEPLOY_MODE` | Режим развёртывания: `user`, `docker`, `server`, `dev` | автодетект (docker-маркеры → `docker`, root → `server`, `SYNTH_AUTH_DEBUG=true` → `dev`, иначе `user`) |
| `SYNTH_LOG_DIR` | Каталог логов сервисов (эндпоинт `/api/v2/logs`) | ищется существующий каталог логов |
| `SYNTH_BACKEND_URL` | URL бэкенда (для раннера) | `http://localhost:5000` |
| `SYNTH_CORS_ORIGIN` | CORS origin (приоритет выше конфига) | — |
| `SYNTH_DECISION_PROVIDER` | ADR-084: имя провайдера decision-типа (`decision`/`systemone`) | `decision.provider` |
| `SYNTH_DECISION_MODEL` | ADR-084: модель decision-слоя (напр. `clef-flash`) | `decision.model` |

**UI (Vite):**

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `VITE_BACKEND_URL` | URL бэкенда (прокси Vite) | `http://localhost:5000` |
| `VITE_PORT` | Порт dev-сервера Vite | `5002` |
| `VITE_ALLOWED_HOSTS` | Разрешённые хосты (`true` — все) | `true` |

**Провайдеры LLM (см. [LLM_PROVIDERS.md](LLM_PROVIDERS.md)):**

| Переменная | Назначение |
|-----------|------------|
| `SYNTH_PROVIDER_<NAME>_URL` | URL провайдера |
| `SYNTH_PROVIDER_<NAME>_API_KEY` | API-ключ |
| `SYNTH_PROVIDER_<NAME>_MODEL` | Модель по умолчанию |
| `SYNTH_PROVIDER_<NAME>_TYPE` | Тип: `openai`, `anthropic`, `ollama`, `decision`, `systemone` |

### Env-оверрайды вложенных секций (ADR-023)

Скалярные ключи секций `events`, `scheduler`, `webhooks`, `decision` можно задавать
переменными окружения — удобно для k8s (ConfigMap → env пода). Имя переменной
собирается по правилу **`SYNTH_<SECTION>_<KEY>`**, где camelCase ключа переводится в
SNAKE_CASE: `autoBind` → `SYNTH_EVENTS_AUTO_BIND`, `ephemeralTtl` →
`SYNTH_EVENTS_EPHEMERAL_TTL`, `keyRateLimitPerMinute` →
`SYNTH_EVENTS_KEY_RATE_LIMIT_PER_MINUTE`.

Применяются в одном месте — `loadConfig` (`packages/shared/src/config/env-overrides.ts`),
поверх `defaults` + `config.yaml` и **ниже** CLI-overrides: `CLI > env > config.yaml > defaults`.

- **boolean** — `true`/`1`/`false`/`0` (регистронезависимо);
- **number** — `Number()` с проверкой конечности;
- **string** — как есть (для строк из перечислений значение проверяет схема);
- пустая переменная → «не задано» (значение из `config.yaml`/defaults);
- нераспознанное значение → предупреждение в лог и игнор (без падения);
- неизвестные `SYNTH_*` игнорируются молча.

| Переменная | Тип | Ключ |
|-----------|-----|------|
| `SYNTH_EVENTS_ENABLED` | boolean | `events.enabled` |
| `SYNTH_EVENTS_DEFAULT_MODE` | string (`bound`/`ephemeral`) | `events.defaultMode` |
| `SYNTH_EVENTS_EPHEMERAL_TTL` | string | `events.ephemeralTtl` |
| `SYNTH_EVENTS_JOURNAL_RETENTION_DAYS` | number | `events.journalRetentionDays` |
| `SYNTH_EVENTS_KEY_RATE_LIMIT_PER_MINUTE` | number | `events.keyRateLimitPerMinute` |
| `SYNTH_EVENTS_DECISION_ROUTING` | boolean | `events.decisionRouting` |
| `SYNTH_EVENTS_AUTO_BIND` | boolean | `events.autoBind` |
| `SYNTH_EVENTS_AUTO_BIND_AGENT_TEMPLATE` | string | `events.autoBindAgentTemplate` |
| `SYNTH_SCHEDULER_ENABLED` | boolean | `scheduler.enabled` |
| `SYNTH_SCHEDULER_TICK_SEC` | number | `scheduler.tickSec` |
| `SYNTH_SCHEDULER_CATCH_UP` | string (`skip`/`once`) | `scheduler.catchUp` |
| `SYNTH_SCHEDULER_JOB_RETENTION_DAYS` | number | `scheduler.jobRetentionDays` |
| `SYNTH_WEBHOOKS_ENABLED` | boolean | `webhooks.enabled` |
| `SYNTH_WEBHOOKS_MAX_ATTEMPTS` | number | `webhooks.maxAttempts` |
| `SYNTH_WEBHOOKS_TIMEOUT_MS` | number | `webhooks.timeoutMs` |
| `SYNTH_WEBHOOKS_DELIVERY_RETENTION_DAYS` | number | `webhooks.deliveryRetentionDays` |
| `SYNTH_EGRESS_TOOLS_MODE` | string (`deny`/`allow`) | `egress.tools.mode` |
| `SYNTH_EGRESS_WEBHOOKS_MODE` | string (`deny`/`allow`/`off`) | `egress.webhooks.mode` |
| `SYNTH_EGRESS_LOG_ENABLED` | boolean | `egress.log.enabled` |
| `SYNTH_EGRESS_LOG_RETENTION_DAYS` | number | `egress.log.retentionDays` |
| `SYNTH_PROXY_ENABLED` | boolean | `proxy.enabled` |
| `SYNTH_PROXY_URL` | string | `proxy.url` |
| `SYNTH_PROXY_HTTP_PROXY` | string | `proxy.httpProxy` |
| `SYNTH_PROXY_HTTPS_PROXY` | string | `proxy.httpsProxy` |
| `SYNTH_PROXY_ALL_PROXY` | string | `proxy.allProxy` |
| `SYNTH_PROXY_NO_PROXY` | string (список через запятую) | `proxy.noProxy` |
| `SYNTH_PROXY_FALLBACK_DIRECT` | boolean | `proxy.fallbackDirect` |
| `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | number | `proxy.connectTimeoutMs` |
| `SYNTH_PROXY_PASSWORD` | string (секрет) | пароль Basic-аутентификации прокси (в config не хранится) |
| `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | ADR-099: CA к https-прокси (взаимоисключающи) | `proxy.tls` |
| `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | ADR-099: mTLS к https-прокси | `proxy.tls` |
| `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | boolean | `proxy.tls.rejectUnauthorized` |
| `SYNTH_DECISION_ENABLED` | boolean | `decision.enabled` |
| `SYNTH_DECISION_PROVIDER` | string | `decision.provider` |
| `SYNTH_DECISION_MODEL` | string | `decision.model` |
| `SYNTH_DECISION_CONFIDENCE_THRESHOLD` | number | `decision.confidenceThreshold` |
| `SYNTH_DECISION_ESCALATION_PROVIDER` | string | `decision.escalationProvider` |
| `SYNTH_DECISION_ESCALATION_MODEL` | string | `decision.escalationModel` |
| `SYNTH_BOOTSTRAP_SERVICE_KEYS` | JSON-массив | `security.bootstrapServiceKeys` (объектный env-оверрайд, ADR-052/O1; см. ниже) |
| `SYNTH_TLS_CA_FILE` | ADR-099: путь к PEM-файлу доверенного CA (корпоративный CA); взаимоисключающ с `SYNTH_TLS_CA_PEM` | — |
| `SYNTH_TLS_CA_PEM` | ADR-099: PEM доверенного CA (например из Secret); взаимоисключающ с `SYNTH_TLS_CA_FILE` | — |
| `SYNTH_TLS_CERT_FILE` | ADR-099: путь к PEM-файлу клиентского сертификата (mTLS) | — |
| `SYNTH_TLS_KEY_FILE` | ADR-099: путь к PEM-файлу приватного ключа клиента (mTLS) | — |
| `SYNTH_TLS_REJECT_UNAUTHORIZED` | ADR-099: проверять сертификат сервера (`true`/`1`/`false`/`0`) | `true` |

### Env-переменные обслуживания (ADR-091)

Ключ шифрования архива бэкапа — **внешний ключ оператора** (не мастер-ключ инстанса).
Резолвится для `synth backup --encrypt` и `synth restore <archive>.tar.gz.enc`; приоритет:
флаг `--key-file` > `SYNTH_BACKUP_KEY_FILE` > `SYNTH_BACKUP_KEY` (32 байта в base64 или 64
hex-символа). Ключ не логируется и не попадает в аудит; храните его отдельно от архива.

| Переменная | Назначение |
|-----------|------------|
| `SYNTH_BACKUP_KEY` | Ключ шифрования архива бэкапа (32 байта base64 / 64 hex), ADR-091 |
| `SYNTH_BACKUP_KEY_FILE` | Путь к файлу с ключом шифрования архива (приоритетнее `SYNTH_BACKUP_KEY`), ADR-091 |

Пример:

```bash
SYNTH_WEBHOOKS_ENABLED=true \
SYNTH_EVENTS_AUTO_BIND=true \
SYNTH_EVENTS_EPHEMERAL_TTL=15m \
SYNTH_SCHEDULER_TICK_SEC=30 \
synth serve
```

Ключи-объекты и массивы (`events.allowedSources`, `events.identityMap`,
`events.dedupStore`, `scheduler.leaderElection`, `mcp.servers`, …) env-оверрайдов не
имеют — задаются в `config.yaml` (или через runtime-API, где он есть).

## config.yaml

Каскадный поиск (от высшего приоритета к низшему):

1. `--config` CLI-флаг или `SYNTH_CONFIG` env var
2. `<home>/config.yaml`, если задан `--home`/`SYNTH_HOME` (ADR-079; при отсутствии файла дефолты, без отката к XDG)
3. `./synth.config.yaml` (CWD)
4. `./config.yaml` (CWD)
5. `~/.config/synth/config.yaml` (пользовательский)
6. `/etc/synth/config.yaml` (системный)

Найденный файл сливается с дефолтами (`deepMerge`), затем применяются env-оверрайды (ADR-023) и CLI-overrides. Реализация: `loadConfig` в `packages/shared/src/config/loader.ts`, `findConfigPath` в `resolve.ts`.

### Пример (реальная схема)

Источник истины — zod-схемы в `packages/shared/src/config/types.ts`. Ниже ключевые секции с дефолтами:

```yaml
server:
  host: "0.0.0.0"
  port: 5000
  corsOrigin: "http://localhost:5002"
  allowedOrigins: []

storage:
  dataDir: "/var/synth/data"      # каталог данных вне репозитория
  backend: "file"                 # ADR-096: физический backend хранения — file (JSON-файлы с атомарной записью,
                                  # дефолт) | memory (in-memory, данные НЕ сохраняются — герметичные тесты/эмуляция)
                                  # | postgres (PROP-032: опциональный драйвер @itphx/synth-storage-postgres);
                                  # SYNTH_STORAGE_BACKEND
  postgres:                       # PROP-032: параметры PostgreSQL (используются при backend: postgres)
    # dsn: "postgres://synth@db:5432/synth"   # строка подключения; задана — приоритетнее host/port/database/user
    host: ""                      # SYNTH_POSTGRES_HOST
    port: 5432                    # SYNTH_POSTGRES_PORT
    database: ""                  # SYNTH_POSTGRES_DATABASE
    user: ""                      # SYNTH_POSTGRES_USER
    schema: ""                    # SYNTH_POSTGRES_SCHEMA — namespace таблиц драйвера
    ssl: false                    # SYNTH_POSTGRES_SSL — legacy: требовать TLS (только если sslmode не задан)
    sslmode: ""                   # ADR-099: disable | require | verify-full (verify-ca — алиас);
                                  # CA/mTLS — из security.tls; SYNTH_POSTGRES_SSLMODE; TLS-параметры в dsn запрещены
    poolMax: 10                   # SYNTH_POSTGRES_POOL_MAX — максимальный размер пула
    # ПАРОЛЬ здесь НЕ хранится (инвариант 13): env SYNTH_POSTGRES_PASSWORD или файл
    # {dataDir}/secrets/postgres-password.
  degradedMode: "fallback-file"   # PROP-032/ADR-098: при недоступности БД — fallback-file (файловый фоллбек,
                                  # строго read-only) | halt (остановить старт); SYNTH_DEGRADED_MODE
  fallbackDir: ""                 # PROP-032/ADR-098: каталог файлового фоллбека; пусто — {dataDir}/fallback;
                                  # SYNTH_STORAGE_FALLBACK_DIR
  workspacesRoot: ""              # если пусто — {dataDir}/workspaces; SYNTH_WORKSPACES_ROOT
  defaultWorkspace: ""            # если пусто — {dataDir}/workspaces/default; SYNTH_DEFAULT_WORKSPACE
  workspaceOutsideRoot: ""        # ADR-075: политика для абсолютного workspace вне workspacesRoot
                                  # confirm | deny; пусто — дефолт по режиму (standalone — confirm,
                                  # managed — deny); SYNTH_WORKSPACE_OUTSIDE_ROOT
  maxUploadBytes: 104857600       # лимит загрузки файла /api/v2/fs/upload, байт (>=1024, <=2 ГиБ);
                                  # не задано — 100 МиБ; SYNTH_MAX_UPLOAD_BYTES

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback", cliClientId: "synth-cli" }

llm:
  defaultProvider: ""             # пусто — админ настраивает сам
  defaultModel: ""
  maxRetries: 3
  timeout: 60
  cache: "auto"                   # ADR-070: политика prompt-cache — auto (маркеры/ключ) | none (отключить);
                                  # применяется в провайдерах (Anthropic cache_control, OpenAI prompt_cache_key)

core:
  port: 4300
  apiKey: ""                      # пусто → synth serve генерирует ключ в {dataDir}/secrets/api-key (0600)

runner:
  port: 5200
  backendUrl: "http://localhost:5000"
  enginePorts: { opencode: 4100, cline: 4200, synth: 4300 }
  proxyPort: 9090

ui:
  port: 5002
  backendUrl: "http://localhost:5000"
  theme: "synthesis"
  themeMode: "system"
  locale: "ru"

i18n:
  defaultLanguage: "ru"
  supportedLanguages: ["ru", "en"]

session:
  planMode: "auto"                # строгость цикла Plan→Build: auto | strict | off

mcp:
  policy: "auto"                  # ADR-071 §2.3: политика включения MCP-инструментов
                                  # consistency | available | auto (дефолт auto)
                                  # независима от tools.policy; per-session override: session.settings.mcpPolicy
  # servers — см. packages/shared/src/config/types.ts
  # networkPolicy — адресная политика MCP {mode, list, exceptions} (тот же формат, что egress.*),
  # см. «Адресная политика исходящих запросов (`egress.*`, ADR-099)»

tools:
  policy: "auto"                  # ADR-071 §2.3: политика включения ВСТРОЕННЫХ инструментов
                                  # consistency | available | auto (дефолт auto)
                                  # consistency — все определения + подсказки unavailable(mode|role);
                                  # available — только доступные тулы (экономия контекста);
                                  # auto — по провайдеру: локальные (ollama) → available, облачные → consistency.
                                  # Per-session override: session.settings.toolsPolicy.
  disabled:                       # ADR-071 §2.9: instance-wide отключение встроенных инструментов (ADMIN)
    capabilities: []              # группы ToolCapability (git, web, file_read, file_write, shell, mcp, ...)
    tools: []                     # отдельные тулы по имени (execute_shell, git_push, ...)
                                  # runtime (plan/todo/project/reference/classify) неотключаем

router:
  enabled: true
  strategy: "auto"                # content | cost | content+cost | auto
  content:
    coding:   { provider: "", model: "" }
    chat:     { provider: "", model: "" }
    research: { provider: "", model: "" }
  escalation:
    enabled: true
    fallbackProvider: ""
    fallbackModel: ""
    maxRetries: 1
    checks: ["min_length", "constraint"]
    minLength: 10
  cost:
    enabled: false
    cheapProvider: ""
    cheapModel: ""
    expensiveProvider: ""
    expensiveModel: ""
    maxCheapTokens: 500
  subagent:                       # маршрутизация саб-агентов: provider/model пусты — наследуют основную пару
    enabled: true
    provider: ""
    model: ""

microFirst:
  enabled: false
  confidenceThreshold: 0.8
  rulesEnabled: true
  embeddingEnabled: false
  embedProvider: "ollama"
  embedModel: "local.nomic-embed-text:latest"
  microLlmProvider: ""            # провайдер micro-LLM-слоя (пусто — основной)
  microLlmModel: ""               # модель micro-LLM-слоя (пусто — основная)
  microLlmEnabled: false

llmGateway:
  enabled: false                  # выключен по умолчанию
  inputMode: "obfuscate"          # obfuscate | block
  logPayloads: false
  payloadLogPath: ""              # путь JSONL полного лога; пусто → {dataDir}/audit/llm-payloads.jsonl
  rateLimit: { userPerMinute: 60, providerPerMinute: 120 }
  audit: { enabled: true, logPath: "" }   # logPath пуст → {dataDir}/audit/llm-gateway.jsonl

decision:                         # ADR-084: decision-модели (System One: Clef/Jev/…)
  enabled: false                  # мастер-выключатель decision-слоя
  provider: ""                    # имя провайдера decision-типа (decision | systemone)
  model: ""                       # модель (напр. clef-flash)
  confidenceThreshold: 0.6        # порог уверенности (ниже — fail-safe fallback)
  escalationProvider: ""          # Ф6: провайдер тира эскалации (пусто — без эскалации)
  escalationModel: ""             # Ф6: модель тира эскалации (пусто — без эскалации)
  # Тир эскалации — вторая пара provider/model: единый каскад `primary → escalation`
  # (decision-cascade.ts) идёт дальше при низкой уверенности/ошибке основной модели.
  # Транспорт задаётся типом провайдера (decision → POST {base}/decisions,
  # systemone → POST {base}/v1/systemone); таймаут — свойством провайдера (timeout).

> Секция `decision` переопределяется в runtime через `GET/PUT/DELETE /api/v2/settings/decision`
> (live, без рестарта): значения сохраняются в `{dataDir}/settings.json` и применяются ко всем
> трём потребителям — микро-каскаду (`DecisionModel`), роутеру (`DecisionContentClassifier`) и
> маршрутизации внешних событий (`DecisionRuleProvider`, ADR-089); агрегатные метрики decision-слоя
> доступны через `GET/DELETE /api/v2/settings/decision/metrics`. Мутации в managed — ADMIN.

permission:
  rules: {}                       # гранулярные permissions: allow/deny/ask per tool
  askTimeoutMs: 30000

security:
  promptInjection:
    enabled: true
    wrapContent: true
    mode: "flag"                  # flag | sanitize | block
  protectedPaths:
    enabled: true
  tls:                            # ADR-099: доверие TLS/CA исходящих соединений (env SYNTH_TLS_*)
    caFile: ""                    # путь к PEM-файлу доверенного CA (корпоративный CA); взаимоисключающ с caPem
    # caPem: ""                   # PEM доверенного CA (например из Secret); взаимоисключающ с caFile
    certFile: ""                  # mTLS: путь к PEM-файлу клиентского сертификата
    keyFile: ""                   # mTLS: путь к PEM-файлу приватного ключа клиента
    rejectUnauthorized: true      # проверять сертификат сервера (по умолчанию true)
  secretKey: ""                   # ADR-076: мастер-ключ секретов at-rest (пусто → файл dataDir/secrets/master.key)
  bootstrapServiceKeys: []        # ADR-052/O1: installer service-key'и (label/secret/scopes/roles?) — см. ниже; обычно через env SYNTH_BOOTSTRAP_SERVICE_KEYS

remote:                           # гибридный режим: локальный core + удалённый backend
  enabled: false
  backendUrl: "https://synth.k3s.itphx.loc"
  auth:
    type: device                  # device | api_key
    apiKey: ""
    issuer: "https://keycloak.itphx.loc/realms/synth"
    clientId: "synth"
  llm: "server"                   # server | local (по умолчанию server — централизация)
  worlds: { local: true, remote: true }
  credentialsPath: ""             # пусто → ~/.config/synth/credentials.json
  timeoutMs: 15000
```

Полный список полей (включая `logging`, `tsm`, `context`, `summarization`, `mcp`, `auth.oidc`) — в `packages/shared/src/config/types.ts`.

### Хранилище и рабочий каталог (`storage.*`, ADR-075)

- `storage.dataDir` — корень данных (`SYNTH_DATA_DIR`; при `--home`/`SYNTH_HOME` — `<home>/data`, ADR-079).
- `storage.workspacesRoot` — корень каталогов workspace проектов; если не задан — `{dataDir}/workspaces` (`SYNTH_WORKSPACES_ROOT`). Managed-проекты создают workspace внутри него (авто-имя `slugify(name)` + суффикс `-2/-3…`); абсолютный путь внутри root нормализуется в относительный.
- `storage.defaultWorkspace` — рабочий каталог сессий без проекта; если не задан — `{dataDir}/workspaces/default` (`SYNTH_DEFAULT_WORKSPACE`). Runtime-override — `PUT /api/v2/settings/workspace`.
- `storage.workspaceOutsideRoot` — политика для абсолютного `project.workspace` вне `workspacesRoot` (`confirm` — подтверждение флагом `confirmOutsideRoot`, `deny` — запрет). Пусто (`''`) — не задано, эффективно `confirm` в standalone; managed-backend жёстко использует `deny`. Env `SYNTH_WORKSPACE_OUTSIDE_ROOT`, runtime — `GET/PUT/DELETE /api/v2/settings/workspace-policy` (managed — read-only).
- `storage.maxUploadBytes` — максимальный размер загрузки файла `POST /api/v2/fs/upload`, байт. Не задан — `104857600` (100 МиБ). Валидация (config.yaml): целое в границах `1024`…`2147483648` (2 ГиБ), иначе — ошибка конфигурации (`Невалидная конфигурация`); env-значение вне границ/не число — warn + фолбэк на config (fail-soft). Env `SYNTH_MAX_UPLOAD_BYTES`, резолвер `resolveMaxUploadBytes` (приоритет env > config > дефолт). Лимит проверяется до чтения тела (по `content-length` и размеру `File`) и повторно по фактическому размеру; превышение → `413 PAYLOAD_TOO_LARGE`. Тело по-прежнему буферизуется в память целиком (стриминговый лимит не реализован).

### Backend хранения (`storage.backend`, ADR-096)

- `storage.backend` — физический backend хранения: `file` (JSON-файлы с атомарной записью tmp→rename, [ADR-005](./arch_decisions/adr-005-json-storage.md); по умолчанию), `memory` (in-memory, данные **не** сохраняются на диск — для герметичных тестов и эмуляции) или `postgres` (PostgreSQL; опциональный in-tree драйвер `@itphx/synth-storage-postgres`, [PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md)). Домен работает через доменные порты, backend взаимозаменяем ([ADR-096](./arch_decisions/adr-096-storage-layer.md)); любой backend обязан пройти контрактный suite `packages/core/src/storage/contract/*`.
- **Приоритет** ([ADR-023](./arch_decisions/adr-023-configuration.md)): env `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `file`. Некорректное значение (не `file`/`memory`/`postgres`) — warn и фолбэк на config/дефолт (fail-soft); неизвестное **явное** значение в самом `resolveStorageBackend` — **fail-closed** (ошибка, а не тихий уход на файлы). Резолвер — `resolveStorageBackend` (`@itphx/synth-shared/config`); выбор применяется в точке сборки `StorageContext` (`createStorageContextAsync`/`buildStorageContext`; синхронный `createStorageContext` для `postgres` бросает).
- `memory` печатает предупреждение `storage.backend=memory: данные не сохраняются на диск` — режим **не для прода** (только тесты/эмуляция).
- `postgres` требует установленного драйвера (`@itphx/synth-storage-postgres`, ставится в комплекте `@itphx/synth`; `pg` — optional-зависимость драйвера) и доступной БД. Драйвер применяет/проверяет **свою** схему БД (`synth_schema_migrations`, инлайн-SQL-миграции) — отдельно от `meta.json`/`synth migrate` (ADR-092); «схема БД новее драйвера» — fail-closed.

### PostgreSQL (`storage.postgres`, PROP-032)

Секция используется при `storage.backend: postgres`. Источник истины — `postgresStorageConfigSchema` (`packages/shared/src/config/types.ts`); резолвер — `resolvePostgresConfig` (env `SYNTH_POSTGRES_*` > `config.storage.postgres`; [ADR-023](./arch_decisions/adr-023-configuration.md)).

| Поле | Env | Назначение |
|------|-----|------------|
| `dsn` | `SYNTH_POSTGRES_DSN` | Строка подключения `postgres://…`; задана — приоритетнее `host`/`port`/`database`/`user` |
| `host` | `SYNTH_POSTGRES_HOST` | Хост сервера БД |
| `port` | `SYNTH_POSTGRES_PORT` | Порт (1–65535) |
| `database` | `SYNTH_POSTGRES_DATABASE` | Имя базы |
| `user` | `SYNTH_POSTGRES_USER` | Пользователь |
| `schema` | `SYNTH_POSTGRES_SCHEMA` | Схема БД (namespace таблиц драйвера; по умолчанию — первая в `search_path`) |
| `sslmode` | `SYNTH_POSTGRES_SSLMODE` | TLS-режим: `disable` / `require` / `verify-full` (`verify-ca` — алиас `verify-full`); приоритетнее legacy `ssl` ([ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)) |
| `ssl` | `SYNTH_POSTGRES_SSL` | Legacy-флаг TLS (`true`/`false`); применяется, только если `sslmode` не задан |
| `poolMax` | `SYNTH_POSTGRES_POOL_MAX` | Максимальный размер пула соединений (по умолчанию `10`) |

- **Пароль** в секции **не хранится** (инвариант 13). Источник — env `SYNTH_POSTGRES_PASSWORD` > файл `{dataDir}/secrets/postgres-password` (резолвер `resolvePostgresPassword`); рекомендуется k8s Secret → env.
- Невалидные числовые/boolean env-значения — ошибка резолвинга с внятным сообщением (не «тихо как есть»).
- Контракт драйвера и схема БД — `packages/storage-postgres/AGENTS.md`; критерий приёмки — suite `packages/core/src/storage/contract/*` (прогон против живой БД по env `SYNTH_TEST_POSTGRES_DSN`).

### TLS соединения с PostgreSQL (`storage.postgres.sslmode`, ADR-099 × PROP-032)

Источник истины для TLS-политики — `storage.postgres.sslmode`; CA и клиентские сертификаты (mTLS) берутся из **общей** секции `security.tls` (см. ниже). Резолвер режима — `normalizePostgresSslMode`, сборка `ssl`-опций `pg` — `buildPostgresSslOptions` (`packages/shared/src/config/tls.ts`).

| `sslmode` | Что делаем |
|---|---|
| не задано | Прежнее поведение: legacy-поле `ssl` (`true`/`false`) либо дефолт `pg` — соединение **без TLS** (dev/совместимость) |
| `disable` | TLS выключен явно (`ssl: false`); CA/mTLS игнорируются |
| `require` | Шифрование **без** проверки сертификата сервера (`rejectUnauthorized: false`); mTLS (`cert`/`key` из `security.tls`) добавляется, если задан |
| `verify-full` | Проверка сертификата сервера по CA из `security.tls` (`rejectUnauthorized: true` + `ca`); mTLS — если задан; для non-IP хоста без DSN проставляется `servername` (SNI) |
| `verify-ca` | **Алиас** `verify-full` (нормализуется с предупреждением: `pg-connection-string` трактует его как `verify-full`, проверка имени хоста включена) |

- **Fail-closed:** `verify-full` без сконфигурированного CA (`security.tls.caFile`/`caPem`) → ошибка конфигурации (никакого тихого `rejectUnauthorized: false` — иначе проверка сертификата сервера невозможна). mTLS требует **оба** файла — `certFile` и `keyFile`.
- **TLS-параметры в DSN запрещены.** Строка подключения `storage.postgres.dsn` не должна нести `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/`ssl`/`sslnegotiation`/`uselibpqcompat`: драйвер `pg` накладывает распарсенный DSN **поверх** явного конфига (`Object.assign({}, config, parse(connectionString))`) и молча перекрывает `ssl`-объект — вплоть до отключения TLS. Обнаружение → ошибка конфигурации: `TLS-параметры в DSN запрещены (обнаружено: …). … задайте их только в storage.postgres.sslmode + security.tls` (`assertNoDsnTlsParams`, `packages/storage-postgres/src/pool.ts`). Проверяются и URL-форма (`?sslmode=…`), и libpq-подобная (`sslmode=…`).
- **TLS — стартовая конфигурация** (не runtime): изменения применяются при старте; для переключения режима — рестарт.

### Деградированный режим при недоступности БД (`storage.degradedMode`, ADR-098)

Если выбран `postgres`, но БД недоступна на старте, поведение задаёт `storage.degradedMode` (env `SYNTH_DEGRADED_MODE` > config > `fallback-file`; резолвер `resolveDegradedMode`):

- `fallback-file` (по умолчанию) — сервис поднимается на **файловом фоллбеке** в `storage.fallbackDir` (env `SYNTH_STORAGE_FALLBACK_DIR` > config > `{dataDir}/fallback`; **отдельный** от `dataDir` каталог) в **строгом read-only**: мутации → `503 STORAGE_DEGRADED_READONLY`, не-администраторам — `503 STORAGE_DEGRADED`. `/health` отдаёт `status: 'degraded'` + блок `storage.{backend,fallbackDir,reason,since}`; диагностика — `GET /api/v2/storage/status`.
- `halt` — старт останавливается с внятной ошибкой (`STORAGE_UNAVAILABLE`).

**Fail-closed** (фоллбек **не** применяется независимо от `degradedMode`): ошибка конфигурации/кред (`STORAGE_POSTGRES_CONFIG_INVALID`), отсутствие зависимости (`…DEPENDENCY_MISSING`, нет `pg`), незагружаемый пакет-драйвер (`STORAGE_BACKEND_UNAVAILABLE`), схема БД новее драйвера (`…SCHEMA_TOO_NEW`). Деградация охватывает **отказ БД** (сеть/класс `08`/`57P0x`, auth-ошибка сервера, `…SCHEMA_OUTDATED` — лечится `synth migrate`, прочие runtime-ошибки). Авто-возврата к БД **нет** — только рестарт после восстановления соединения ([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)); процедуры — [MAINTENANCE.md](./MAINTENANCE.md).

### Доверие TLS и mTLS исходящих соединений (`security.tls`, ADR-099)

Единый источник доверия TLS/CA для **всех** исходящих соединений Synth (провайдеры LLM, MCP HTTP,
`web_fetch`/`web_search`, webhooks, гибридный backend, инструкции/скиллы по URL, update-checker,
OIDC/JWKS, иконки провайдеров, git, PostgreSQL). Секция читается резолверами `resolveTlsConfig`/`resolveTlsTrust`
(`packages/shared/src/config/tls.ts`); приоритет — общий ([ADR-023](./arch_decisions/adr-023-configuration.md)):
env > `config.yaml` > дефолты. Инвариант — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md):
подсистемы не создают собственных агентов/диспетчеров.

| Поле | Env | Назначение |
|---|---|---|
| `caFile` | `SYNTH_TLS_CA_FILE` | Путь к PEM-файлу доверенного CA (корпоративный CA); **взаимоисключающ** с `caPem` |
| `caPem` | `SYNTH_TLS_CA_PEM` | PEM доверенного CA (например из Secret); **взаимоисключающ** с `caFile` |
| `certFile` | `SYNTH_TLS_CERT_FILE` | mTLS: путь к PEM-файлу клиентского сертификата |
| `keyFile` | `SYNTH_TLS_KEY_FILE` | mTLS: путь к PEM-файлу приватного ключа клиента |
| `rejectUnauthorized` | `SYNTH_TLS_REJECT_UNAUTHORIZED` | Проверять сертификат сервера (`true`/`1`/`false`/`0`); по умолчанию `true` |

- **Пустая секция — системное доверие** (системные CA Node), поведение не меняется.
- **`rejectUnauthorized`:** `true` (дефолт) — проверка сертификата сервера; `false` — проверка отключена (осознанный риск MITM; только для отладки). Невалидное env-значение — `warn` + фолбэк на config/дефолт.
- **mTLS:** задаются `certFile` **и** `keyFile` одновременно; задан ровно один — ошибка конфигурации.
- **Fail-closed:** `caFile` и `caPem` одновременно → ошибка; явно заданный `caFile`, который отсутствует/не читается/не PEM → ошибка (никакого тихого фоллбэка на системное доверие); заданное доверие без установленного пакета `undici` (прямая зависимость core `undici@^7`) → внятная ошибка, а не недоверенный транспорт.
- **Применение:** при старте процесса строится глобальный undici-dispatcher (`setGlobalDispatcher`), обычный `fetch` наследует доверие; точки вне общего транспорта (git) получают CA через `http.sslCAInfo=<caFile>` (`caPem` без файла git-каналу недоступен).
- **`NODE_EXTRA_CA_CERTS` — только совместимость** (наследуется дочерними процессами: MCP stdio, git), **не** конфигурируемый механизм доверия.
- **TLS-транспорт — стартовая конфигурация:** секция **не входит** в runtime-настройки (`RuntimeSettings`); изменения применяются при старте и требуют рестарта. То же — для прокси (`proxy.*`, см. ниже). Адресная политика — наоборот, **runtime** (live per-request): см. следующий раздел.

### Адресная политика исходящих запросов (`egress.*`, ADR-099)

Настраиваемая политика «куда можно ходить» для исходящих запросов. Часть единого egress-слоя
([ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) п. 8–15); доверие TLS/CA — отдельная секция
`security.tls` (выше). Три **независимых** экземпляра политики:

| Скоуп | Ключ | Что покрывает | Режимы |
|---|---|---|---|
| Инструменты | `egress.tools` | `web_fetch`/`web_search`, внутренние потребители `net/fetch` (URL-скиллы, URL-источники инструкций), иконки провайдеров | `deny`/`allow` |
| Вебхуки | `egress.webhooks` | исходящие webhooks (доставка событий) | `deny`/`allow`/`off` |
| MCP | `mcp.networkPolicy` | пользовательские HTTP/SSE MCP-серверы (`origin:'user'`) | `deny`/`allow` |

Формат у всех трёх общий: `{mode, list: string[], exceptions: string[]}`.

| Поле | Env | Назначение | По умолчанию |
|---|---|---|---|
| `egress.tools.mode` | `SYNTH_EGRESS_TOOLS_MODE` | `deny` — блок при попадании любого resolved-адреса в `list`; `allow` — разрешено, только если **все** адреса в `list` | `deny` |
| `egress.tools.list` | — (только config.yaml) | Список правил: точный hostname, `*.suffix`, IP/CIDR | `DEFAULT_MCP_PRIVATE_CIDRS` |
| `egress.tools.exceptions` | — | Allow-правила-исключения, проверяются **первыми** | `[]` |
| `egress.webhooks.mode` | `SYNTH_EGRESS_WEBHOOKS_MODE` | То же + `off` — dev: без проверок и **без требования `https`** | `deny` |
| `egress.webhooks.list` / `.exceptions` | — | Как у `egress.tools` | `DEFAULT_MCP_PRIVATE_CIDRS` / `[]` |
| `egress.log.enabled` | `SYNTH_EGRESS_LOG_ENABLED` | Журнал внешних запросов `{dataDir}/audit/egress.jsonl` | `true` |
| `egress.log.retentionDays` | `SYNTH_EGRESS_LOG_RETENTION_DAYS` | Срок хранения журнала, дни; `0` — не чистить; prune на старте и раз в 6 ч | `7` |

**Семантика.**

- `exceptions` — allow-правила и проверяются **первыми**: точный hostname, `*.suffix`, IP/CIDR.
  Hostname-правило разрешает сразу, адресное — по резолву.
- `deny` — блок, если **хотя бы один** resolved-адрес попал в `list`; `allow` — разрешено, только если
  **все** resolved-адреса в `list` либо сработало исключение.
- Литеральные `localhost`/`*.localhost`/`*.local`/`*.internal` и приватные адреса блокируются **самой
  политикой** (проверка локальных имён + дефолтный `list`), а не отдельным зашитым списком подсистемы;
  `exceptions` их разрешают.
- `off` — **только** `egress.webhooks` (dev): проверок нет, требование `https` снято. Для `tools`/MCP
  `off` не принимается (400).
- Невалидная запись (мусор, regex-подобное, битый CIDR) → 400 `VALIDATION_ERROR`.
- **Fail-closed:** нет значения → config.yaml → встроенный дефолт (`deny` приватных диапазонов);
  «политика не задана» не означает «разрешено всё».
- Env — только скаляры (`mode`, `log.*`); списки `list`/`exceptions` — только в `config.yaml`.

**Live и хранилище.** Политика резолвится из стора при **каждой** исходящей операции (runtime override в
`{dataDir}/settings.json` → `config.yaml` → встроенный дефолт), без фонового опроса и кэша; в рамках одного
вызова — один снимок. Изменения применяются без рестарта. Управление — `GET/PUT/DELETE
/api/v2/settings/egress/tools`, `.../egress/webhooks`, `GET/PUT/DELETE /api/v2/settings/mcp-network-policy`
и проверка без выполнения запроса — `POST /api/v2/settings/egress/check` (мутации в managed — ADMIN,
core — `requireAuth`); изменения пишутся в аудит `{dataDir}/audit/security.jsonl`
(`GET /api/v2/audit/security`), запросы — в журнал `{dataDir}/audit/egress.jsonl`
(`GET /api/v2/audit/egress`; без тел/заголовков, `url` — без query/userinfo).

**MCP отдельно.** `mcp.networkPolicy` остаётся **отдельным ключом** (не `egress.mcp`), но использует тот же
формат и валидатор; проверяются только пользовательские HTTP/SSE-серверы (`origin:'user'`) — при записи в
реестр и при подключении; `origin:'instance'` и `stdio`-серверы не проверяются, per-project политики нет.
Пиннинга проверенного адреса нет (TOCTOU/DNS-rebinding — [PROP-100](./arch_decisions/prop-100-ssrf-dns-rebinding.md)).

**Что не входит.** Провайдеры LLM не пишутся в журнал egress (у них свой LLM audit/payload-лог, ADR-036).
При включённом HTTP/HTTPS/SOCKS5-прокси ([`proxy.*`](#прокси-proxy-adr-099-d1d2) ниже) адрес резолвит
прокси: адресная проверка Synth работает в proxied-режиме (только схема и hostname-правила, без DNS/CIDR),
ответственность — на прокси/allowlist (ADR-099 п. 15/18); исключение — хосты из `proxy.noProxy` (direct и
полная проверка). Политика — **не граница безопасности** при доступном shell, `stdio`-MCP или внешних
движках.

Пример:

```yaml
egress:
  tools:                          # web_fetch/web_search, URL-скиллы и инструкции, иконки провайдеров
    mode: "deny"                  # deny | allow (SYNTH_EGRESS_TOOLS_MODE)
    list: ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "::1/128"]   # hostname | *.suffix | CIDR
    exceptions: []                # allow-правила, проверяются первыми
  webhooks:                       # исходящие webhooks (ADR-052 этап II)
    mode: "deny"                  # deny | allow | off (off — dev, без https-требования)
    list: ["10.0.0.0/8", "127.0.0.0/8"]
    exceptions: ["hooks.internal.example"]   # напр. разрешить конкретный корпоративный хост
  log:                            # журнал внешних запросов
    enabled: true                 # SYNTH_EGRESS_LOG_ENABLED
    retentionDays: 7              # 0 — не чистить (SYNTH_EGRESS_LOG_RETENTION_DAYS)

mcp:
  networkPolicy:                  # отдельный ключ, тот же формат
    mode: "deny"
    list: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.169.254/32"]
    exceptions: []
```

### Прокси (`proxy.*`, ADR-099 D1+D2)

Исходящий HTTP/HTTPS/SOCKS5-прокси — часть единого egress-слоя (см. также `security.tls` — доверие к
**цели** и к https-прокси, и `egress.*` — адресная политика). Секция **top-level** и **start-only**:
изменения применяются при старте процесса (как `security.tls`), runtime-переключения нет. Маршрут
выбирается **per-origin**: `httpsProxy`/`httpProxy` по схеме цели → `allProxy` → `url`; хосты из `noProxy`
идут напрямую.

| Поле | Env | Назначение | По умолчанию |
|---|---|---|---|
| `enabled` | `SYNTH_PROXY_ENABLED` | Явный выключатель. Не задан — прокси включается наличием URL (в т.ч. из стандартных env при `fromEnv`); явный `false` подавляет стандартные env | — (авто) |
| `url` | `SYNTH_PROXY_URL` | Общий прокси `http://`/`https://`/`socks5://`/`socks5h://` (userinfo допускается, но вырезается в статусе/логах) | — |
| `httpProxy` / `httpsProxy` | `SYNTH_PROXY_HTTP_PROXY` / `SYNTH_PROXY_HTTPS_PROXY` | Прокси для целей по схеме (`http`/`https`); приоритетнее `allProxy`/`url` | — |
| `allProxy` | `SYNTH_PROXY_ALL_PROXY` | Прокси для всех схем (если нет схемного) | — |
| `noProxy` | `SYNTH_PROXY_NO_PROXY` | Исключения: `host`, `.suffix`, `*.suffix`, `host:port`, IP, CIDR (по IP-литералу цели — DNS не резолвится), `*` | `[]` |
| `fromEnv` | — | Учитывать стандартные `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | `true` |
| `fallbackDirect` | `SYNTH_PROXY_FALLBACK_DIRECT` | Явный opt-in: при недоступном прокси идти напрямую (warn + `via:'fallback'`). Ошибки аутентификации (`407`) фоллбек **не** разрешают | `false` |
| `connectTimeoutMs` | `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | Таймаут соединения с прокси, мс | `10000` |
| `auth.type` | — | `basic` — реализовано; `ntlm`/`negotiate` → ошибка конфигурации (остаток) | `basic` |
| `auth.username` | — | Пользователь Basic (альтернатива — userinfo в URL) | — |
| `auth`-пароль | `SYNTH_PROXY_PASSWORD` | Пароль Basic: **только** env или файл `{dataDir}/secrets/proxy-password` (в config.yaml не хранится, инвариант 13) | — |
| `tls.caFile` / `tls.caPem` | `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | CA к **самому** https-прокси (взаимоисключающи) | системное доверие |
| `tls.certFile` / `tls.keyFile` | `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | mTLS к https-прокси | — |
| `tls.rejectUnauthorized` | `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | Проверять сертификат прокси | `true` |

**Приоритет (ADR-023):** `SYNTH_PROXY_*` > `config.proxy` > стандартные `HTTP_PROXY`/`HTTPS_PROXY`/
`ALL_PROXY`/`NO_PROXY` (только при `fromEnv`) > defaults. Явный `proxy.enabled: false` подавляет
стандартные env — прокси не включается «из окружения» вопреки конфигу. `noProxy`:
`SYNTH_PROXY_NO_PROXY` > непустой `proxy.noProxy` > `NO_PROXY`.

**Fail-closed.** Битый URL, неизвестная схема, `enabled=true` без URL, Basic без пароля,
`auth.type` ≠ `basic`, `proxy.tls` вместе с `socks5://` → ошибка конфигурации на старте
(`EGRESS_PROXY_CONFIG_INVALID`). Недоступный прокси → `EGRESS_PROXY_UNAVAILABLE` (тихого direct нет);
`407`/SOCKS-отказ → `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED`.

**Адресная политика при прокси** (ADR-099 п. 18): для запросов через прокси проверяются только схема и
hostname-правила/`exceptions` (DNS/CIDR не выполняются — адрес резолвит прокси); для хостов из `noProxy`
проверка полная (DNS/CIDR каждого хопа). Фактический маршрут пишется в журнал egress (`via`:
`proxy`/`direct`/`fallback`); `POST /api/v2/settings/egress/check` отдаёт `proxied`/`addressChecksActive`.

**API/UI.** `GET /api/v2/settings/proxy` — read-only статус (redacted URL, источник `env`/`config`/`none`,
`noProxy`, `fallbackDirect`, `connectTimeoutMs`, `restartRequired: true`); `POST /api/v2/settings/proxy/check`
— проверка только коннекта к прокси (TCP/TLS/SOCKS-handshake, `authChallenge`, `latencyMs`; цель не
запрашивается). UI — админ-секция «Прокси (egress)» в «Встроенных инструментах».

**Ограничения.** NTLM/Negotiate/Kerberos не реализованы (нужен собственный CONNECT-цикл и нативная
зависимость; приёмка — с AD/KDC). `security.tls` к **цели** через SOCKS5 не применяется (ограничение
`Socks5ProxyAgent` — только системное доверие). https-прокси/SOCKS по IP-литералу требуют DNS-хоста
(SNI по IP запрещён в Node); `proxy/check` при этом может показать `reachable`. SOCKS5/SOCKS5H в undici
экспериментальные и резолвят hostname на прокси. Встроенный глобальный `fetch` не гарантирован
(npm-`setGlobalDispatcher` не влияет на него в Node 26; на Node 22 — перепроверка в CI) — покрыты пути
через `egressFetch`. PostgreSQL не проксируется (не HTTP). git применяет `no_proxy` средствами libcurl,
per-remote настройки нет; `stdio`-MCP получает прокси-env без пароля.

Пример:

```yaml
proxy:
  enabled: true
  # url: "http://proxy.corp.example:3128"        # общий; либо схемные ниже
  httpProxy: "http://proxy.corp.example:3128"
  httpsProxy: "https://proxy.corp.example:8443"  # https-прокси: TLS — в proxy.tls
  # allProxy: "socks5://proxy.corp.example:1080" # SOCKS5 (без proxy.tls)
  noProxy: ["localhost", ".corp.example", "git.corp.example:22", "10.0.0.0/8"]
  fromEnv: false
  fallbackDirect: false
  connectTimeoutMs: 10000
  auth:
    type: "basic"
    username: "synth"              # пароль — SYNTH_PROXY_PASSWORD или {dataDir}/secrets/proxy-password
  tls:                             # TLS/mTLS к https-прокси (не к цели)
    caFile: "/etc/synth/tls/proxy-ca.pem"
    # certFile: "/etc/synth/tls/proxy-client.pem"
    # keyFile: "/etc/synth/tls/proxy-client.key"
    rejectUnauthorized: true
```

### Секреты at-rest (`security.secretKey`, ADR-076)

- `security.secretKey` — мастер-ключ для шифрования секретов в хранилище (SSH-ключи агентов; AES-256-GCM). Env — `SYNTH_SECRET_KEY`.
- **Приоритет**: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > файл `{dataDir}/secrets/master.key` (резолвер `resolveSecretKey`).
- **Форматы** ключа: base64 (ровно 32 байта) либо 64 hex-символа; иначе — ошибка `encryption_unavailable` (без молчаливого обрезания).
- **Fallback-файл**: если ключ не задан ни env, ни конфигом, core создаёт `{dataDir}/secrets/master.key` при первом запуске (`randomBytes(32)`, каталог `0700`, файл `0600`, атомарная запись). Секреты шифруются at-rest.
- **Ротация**: `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`) перешифровывает существующие SSH-ключи старым→новым ключом (preflight: нерасшифровываемое поле → abort, ничего не пишется), обновляет `master.key` и сбрасывает кэш; `--dry-run` показывает сводку без записи. Без `--yes` (и без `--dry-run`) — отказ. Если эффективный ключ задан через env/`config.security.secretKey`, файл перезаписывается, но при старте игнорируется — обновите ключ в env/config. Перед ротацией рекомендуются бэкап `$SYNTH_DATA_DIR` и остановка сервера.

### Installer service-key (`security.bootstrapServiceKeys`, ADR-052/O1)

Секция задаёт **installer service-key'и**, которые провижинятся идемпотентно при
старте (core standalone и backend) — для машинной установки аддонов (MCP-серверы,
скиллы) и консент-чтения пользователей без ручного создания ключа через API.

Формат элемента:

| Поле | Обязательно | Назначение |
|------|-------------|------------|
| `label` | да | Уникальная метка ключа (`create`/`ensure` идемпотентность по ней, регистронезависимо) |
| `secret` | да | Plaintext-секрет (`synth_svc_…`; если префикс отсутствует — дописывается). At-rest хранится только sha256-хеш |
| `scopes` | да | Список известных scope (напр. `addons:install`, `users:read`) |
| `roles` | нет | Роли синтетического пользователя (не заданы — `USER`) |
| `description` | нет | Описание ключа |

Поведение: если ключа с такой `label` нет — создаётся с заданным секретом; если
есть — синхронизируются `scopes`/`roles` (**секрет не меняется**). Статус
(`created`/`updated`/`unchanged`) пишется в лог. Ошибка конфигурации одного ключа
**не роняет старт** (best-effort, лог без секретов).

**Приоритет**: env `SYNTH_BOOTSTRAP_SERVICE_KEYS` (JSON-массив, обычно из
k8s Secret) > `config.security.bootstrapServiceKeys` в `config.yaml`. Рекомендуется
держать секрет в env/Secret, а не в файле конфигурации.

В Helm-чарте `charts/synth` installer-ключ провижинится опцией `installerKey`
(создаёт Secret и прокидывает `SYNTH_BOOTSTRAP_SERVICE_KEYS`; `existingSecret` —
взять готовый Secret); подробности — `charts/synth/README.md`.

Пример (installer-ключ для установки аддонов):

```yaml
security:
  bootstrapServiceKeys:
    - label: addon-installer
      secret: "synth_svc_…"          # лучше передавать через env, не в git
      scopes: [addons:install]
      roles: [USER]
      description: "Установка аддонов (MCP/скиллы)"
```

```bash
# k8s: значение из Secret → env пода (приоритетнее config.yaml)
SYNTH_BOOTSTRAP_SERVICE_KEYS='[{"label":"addon-installer","secret":"synth_svc_…","scopes":["addons:install"]}]'
```

### Политики инструментов (`tools.policy` / `mcp.policy`)

Две **независимые** админские политики (ADR-071 §2.3; UI-раздел — ADMIN-категория):
`tools.policy` управляет только **встроенными** инструментами, `mcp.policy` —
только **MCP**-инструментами. Обе: `consistency` | `available` | `auto`
(дефолт `auto`). Per-session override — `session.settings.toolsPolicy` и
`session.settings.mcpPolicy` соответственно. Runtime-правка:
`GET/PUT /api/v2/settings/tools-policy` и `GET/PUT /api/v2/settings/mcp-policy`
(живое применение, persist в `settings.json`). MCP-блоки промпта
(`mcp.servers`/`mcp.tools`/`mcp.status`) всегда `volatile` и не входят в
кэшируемый `staticPrefixChars`.

### Отключение встроенных инструментов (`tools.disabled`)

Instance-wide настройка (ADR-071 §2.6; UI-раздел — ADMIN-категория `mcpAdmin`):
жёстко исключает встроенные инструменты из запроса **независимо** от
`tools.policy` — и по группам (`capabilities`, значения `ToolCapability`:
`file_read`, `file_write`, `shell`, `search`, `web`, `git_read`, `git_write`,
`task`, `mcp`), и по отдельным тулам (`tools`). Эффективный
набор = доступные агенту/режиму тулы − (union отключённых групп и имён).

`runtime`-инструменты (управление планом/todo, проект, reference, classify)
неотключаемы — иначе ломается инвариант ADR-039. Отключённые тулы не уходят в
запрос и не показываются в таблице состава промпта (в админ-UI их можно
включить/отключить). Runtime-правка: `GET/PUT /api/v2/settings/tools-disabled`
телом `{toolsDisabled:{capabilities,tools}}` (живое применение, persist в
`settings.json`).

### Скиллы (`skills.*`, ADR-046)

Секция `skills` управляет discovery скиллов, доверием проектным каталогам,
inline shell в шаблонных командах и удалёнными каталогами:

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `skills.paths` | Доп. пользовательские каталоги скиллов (после project/instance) | `[]` |
| `skills.trustedProjectDirs` | Доверенные проектные каталоги (бинарный project-trust) | `[]` |
| `skills.inlineShell` | Разрешить `` !`cmd` `` в шаблонных командах (RCE-вектор, только для доверенных источников) | `false` |
| `skills.urls` | Удалённые каталоги (opencode-совместимый `index.json`) — **read-only индексация** в `{dataDir}/skills-cache` | `[]` |
| `skills.toolsets` | Именованные группы тулов → capabilities (см. ниже) | `{}` |

Порядок источников (приоритет, first-wins): `{project.workspace}/.synth/skills` >
`{dataDir}/skills` > `skills.paths` > внешние read-only каталоги
(`.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`,
`~/.config/opencode/skills`) > `skills.urls`.

- **Project-trust:** недоверенный проектный каталог (нет в `trustedProjectDirs`)
  виден в реестре/диагностике (`untrusted`), но его скиллы и шаблонные команды
  не грузятся — не попадают в каталог для модели, `/`-автокомплит и core-тул
  `skill`. Команды дополнительно не могут перекрыть доверенный skill/bundle.
- **`skills.urls`** кэшируются, индексируются и видны в реестре, но помечены
  **`trusted:false`** (в каталог для модели не попадают). Установка/обновление,
  trust-уровни и подписи удалённых каталогов — задача [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md).
- **`skills.inlineShell`** по умолчанию выключен; при включении исполнение идёт
  только при `allow` от `PermissionEvaluator` (как `execute_shell`), с timeout,
  лимитом вывода и аудит-событием `command.inline_shell`; `deny`/`ask` —
  отказ без интерактива.
- **Builtin-скилл `skill-creator`** (`instance`/`system`, `trusted`) — встроенная
  инструкция по созданию проектного скилла в `{project.workspace}/.synth/skills`;
  доступен как `/skill-creator` (требует `file_read`/`file_write`).

### Проектные инструкции (`instructions.*`, ADR-069)

Автозагрузка репозиторных `AGENTS.md` в системный промпт (блок `[PROJECT INSTRUCTIONS]`, тир `context`):

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `instructions.enabled` | Глобальный тумблер автозагрузки | `true` |
| `instructions.claudeCompat` | Читать `CLAUDE.md`, если нет `AGENTS.md` | `true` |
| `instructions.contextCompat` | Читать deprecated `CONTEXT.md` | `false` |
| `instructions.windowRatio` / `minChars` / `maxCharsCeiling` | Динамический кап от окна модели (`clamp(ratio*window, min, ceiling)`) | `0.06` / `20000` / `500000` |
| `instructions.maxChars` | Явный override капа (отключает динамику) | — |
| `instructions.headRatio` / `tailRatio` | Доли head/tail при обрезке | `0.7` / `0.2` |
| `instructions.lazy.{enabled,maxAncestors,maxChars,excludeDirs}` | Lazy-догрузка вложенных инструкций в tool-result | `true` / `5` / `8000` / `[node_modules,.git,…]` |
| `instructions.fetch.{timeoutMs,cacheTtlSec,maxBytes}` | Политика fetch URL-источников | `5000` / `3600` / `262144` |
| `instructions.sources` | Доп. источники `{ kind: path\|url, value, position: before\|after, label?, ttlSec? }` | `[]` |
| `instructions.excludeProjects` | Проекты, где автозагрузка выключена | `[]` |
| `instructions.allowInstallTreeFallback` | Грузить инструкции внутри дерева исходников Synth | `false` |

- Discovery: цепочка `git root → … → workspace` (глубже = приоритетнее), на каталог `AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` > `CONTEXT.md`; дедуп sha256.
- **`sources`:** `position: before|after` — до/после merged chain; `kind: path` — `value` относительный/glob/`~/`/абсолютный; `kind: url` — read-only fetch с TTL-кэшем `{dataDir}/instructions-cache` (`ttlSec` переопределяет `fetch.cacheTtlSec`), кап `fetch.maxBytes`.
- Каждый блок проходит **threat-scan** (ADR-036): `block` — не грузится, `flag` — с WARN-строкой.
- **Project-trust:** инструкции недоверенного проекта (нет в `skills.trustedProjectDirs`) не грузятся (статус `untrusted`). Каталог внутри `storage.workspacesRoot` доверяется **автоматически** (R3) — гейт общий для system-chain и lazy-догрузки; на project-trust скиллов (ADR-046) не влияет.
- **Install-tree guard:** внутри дерева исходников Synth инструкции не грузятся (статус `skipped-install-tree`), кроме `allowInstallTreeFallback: true`.
- **Кэш/инвалидация (R5, новых настроек нет):** результат резолвера кэшируется по подписи кандидатов (`mtime:size`, helper `engine/file-signature.ts`, общий со скиллами ADR-046); изменение/добавление/удаление файла инвалидирует, `ProjectInstructionsResolver.clear()` — принудительный сброс. В реальном ходе результат дополнительно мемоизируется на `turnId`.
- Отключение: `instructions.enabled=false`, `excludeProjects`, CLI `--ignore-rules`/`--safe-mode` (или env `SYNTH_IGNORE_RULES=1|true`; флаги приоритетнее env, работают для `serve` и `chat`), а также `session.settings.systemPrompt` override.
- Прозрачность: `GET /api/v2/context/instructions?session_id=…` и событие `context.instructions_loaded`; UI — секция «Проектные инструкции» в правой панели (вкладка «Сессия»).
- `/init` — builtin-команда (статус `prompt`), генерирует/обновляет `AGENTS.md`; скилл `synth-agents-md` (`/agents-md`) — аудит/обновление инструкций.

### Slash-команды (`commands.*`, ADR-046)

Резолвинг `/`-команд выполняется в core. Секция `commands`:

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `commands.paths` | Доп. каталоги шаблонных `.md`-команд (после project/instance) | `[]` |
| `commands.bundlesPath` | Подкаталог `{dataDir}` для YAML-bundles | `skill-bundles` |
| `commands.conflict.mode` | Режим конфликтов имён: `bundle-wins` \| `conservative` \| `namespace` | `bundle-wins` |
| `commands.conflict.namespacePrefix` | В `namespace`: бандл-скиллы как `<bundle>:<skill>` при конфликте с builtin | `false` |
| `commands.maxArgumentsLength` | Лимит `$ARGUMENTS` | `10000` |
| `commands.maxRenderedBytes` | Лимит рендера шаблона/агрегата bundle | `200000` |

Источники шаблонных команд (приоритет): `{project.workspace}/.synth/commands` > `{dataDir}/commands` > `commands.paths`. Встроенные команды — `/help`, `/skills`, `/commands`, `/summary`, `/init` (ADR-069; `/compact`, `/review` отложены). Скилловые команды — `/skill-creator`, `/agents-md` (builtin-скиллы). `allowed-tools` во frontmatter — advisory (в права не транслируется).

### Группы тулов для скиллов (`skills.toolsets`)

`skills.toolsets` — словарь `имя → ToolCapability[]`. Экспандит `metadata.synth.requires_toolsets` скилла: проверка доступности идёт по `requires_capabilities ∪ expand(requires_toolsets)`. Пример:

```yaml
skills:
  toolsets:
    git: [git_read, git_write]
    web: [web]
```

### Внешние события (`events.*`, ADR-089)

Приём внешних событий и маршрутизация через `EventRouter` (ADR-089). Поля секции:

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `events.enabled` | Мастер-выключатель приёма внешних событий; `false` → `POST /api/v2/events` отвечает 503 `UNAVAILABLE` (CRUD привязок/правил/журнала остаётся) | `true` |
| `events.defaultMode` | Фоллбек Router, если ни `EventBinding`, ни правило не выбрали маршрут: `bound` — осознанный `drop no_route` с аудитом; `ephemeral` — создать временную сессию (агент по умолчанию) с TTL `events.ephemeralTtl` | `bound` |
| `events.ephemeralTtl` | TTL ephemeral-сессий (формат `24h`, `30m`, …) | `'24h'` |
| `events.journalRetentionDays` | Срок хранения журнала событий, дни (0 — без ограничения); очистка — pruner на старте и каждые 6 ч (`EventJournalStore.prune`) | `30` |
| `events.allowedSources` | Белый список источников (пусто — разрешены все) | `[]` |
| `events.dedupStore` | Источник дедупа событий: `memory` — in-process `Set` (single-process), `file` — межпроцессный атомарный claim на общем `dataDir` (`{dataDir}/events/dedup/<sha256(key)>`) | `memory` |
| `events.unknownAgentTemplate` | Поведение, если `agentTemplate` события/правила не резолвится в enabled-агента: `drop` — не создавать сессию, зафиксировать `agent_not_found` в журнале (fail-safe); `default-agent` — не задавать `agentRole` (сессия возьмёт агента по умолчанию) | `drop` |
| `events.keyRateLimitPerMinute` | Глобальный дефолт лимита запросов/мин на API-ключ привязки (0 — без лимита); конкретный ключ переопределяет `rateLimitPerMinute`; превышение → 429 `RATE_LIMITED` | `0` |
| `events.decisionRouting` | ADR-084 × ADR-089: умная классификация внешних событий decision-моделью. `false` — только декларативные правила; `true` — при промахе правил decision-модель выбирает шаблон агента (ephemeral-сессия). Требует настроенного `decision.*`; fail-safe: ошибка/низкая уверенность/нет агентов → фоллбек `defaultMode` | `false` |
| `events.autoBind` | ADR-089: фоллбек Router — если у события есть `identity.chatKey` или `identity.threadKey`, закрепить его за новой сессией (`EventBinding mode='bound'`) вместо `defaultMode`. Влияет **только** на фоллбек (явная привязка/правила/decision-маршрутизация приоритетнее). Защита от мусорных сессий: флаг выключен по умолчанию + `allowedSources` + per-key rate limit | `false` |
| `events.autoBindAgentTemplate` | ADR-089: шаблон агента auto-bind-сессий (id агента; пусто — агент по умолчанию). Неизвестный шаблон обрабатывается политикой `events.unknownAgentTemplate` | `''` |
| `events.identityMap` | ADR-089: **override**-карта идентичности внешнего отправителя на владельца синт-сессии. Основной источник владельца — привязки в **профиле** (`ProfileData.identities[]`, ключ `provider:externalId`; наполняются claim-flow — подтверждение владения id по одноразовому коду, API `POST /api/v2/me/identities/claim`). Карта задаёт **ручное** переопределение и приоритетнее профиля. Ключ — `identity.principalId` (`tg:<id>`; **предпочтителен** для владельца — человек, а не чат) либо `identity.chatKey` (`chat:telegram:<id>`; фоллбек — ЛС/чатовый уровень), значение — id пользователя инстанса. Применяется при материализации сессий `ephemeral`/`bind`; приоритет выше per-event владельца (аутентифицированный пользователь / создатель ключа привязки). Так Telegram-сессии человека попадают в его `listSessions({ userId })` и UI-список. Роли override-ветка **не** несёт — права считаются из профиля (см. ниже) | `{}` |

Правила маршрутизации `source/type/…` → сессия задаются через API (`/api/v2/events/routes`, §5.26)
и хранятся в `{dataDir}/events/routes.json` (`RouteRuleStore`, `ProjectRuleProvider`).
При `events.decisionRouting: true` после промаха декларативных правил срабатывает
decision-модель (`DecisionRuleProvider`, ADR-084): она выбирает шаблон агента из
enabled-агентов и создаёт ephemeral-сессию; при ошибке/низкой уверенности Router идёт
к фоллбеку `events.defaultMode` (fail-safe).

**Идентичности отправителей (claim-flow, ADR-089).** Записей в конфиге не требует:
при приёме события от неизвестного отправителя ядро автоматически выпускает одноразовый
код подтверждения (TTL 10 мин, хранится в `{dataDir}/events/identity-claims.json`) и
возвращает его в ответе `POST /api/v2/events` (поле `identityHint`). Пользователь вводит код
в профиле UI (`POST /api/v2/me/identities/claim`), после чего идентичность привязывается к
его профилю. Код доставляется отправителю **шлюзом**, и только в приватный чат (в группе не
показывается); активация на стороне шлюза — `GATEWAY_UNKNOWN_ACTION=hint` (дефолт `register`
кодов не показывает). Ручной override владельца — `events.identityMap` (приоритетнее профиля).

**Права внешнего отправителя (ADR-089, этап 5).** Прав в конфиге не требует — вычисляются на
приёме события:

- **База прав — роли профиля Synth** отправителя (`ProfileData.roles`; резолвинг внешнего
  отправителя → профиль, см. `events.identityMap` выше).
- **`identity.roles` — потолок**: роль из allowlist внешнего источника (напр.
  `GATEWAY_ALLOWLIST=chatId:ROLE` у Telegram-шлюза) **сужает** права профиля (пересечение),
  но **не повышает** их. Роль — ограничение, а не дарование.
- **Несопознанный отправитель** (нет профиля/идентичности) → **без прав Synth** (fail-closed):
  транспортное участие (сессия/чат) работает, привилегированные операции недоступны.
- Эффективные роли вычисляет `resolveEffectiveRoles` (`core`, `engine/events/identity-roles.ts`)
  и `deliver` кладёт их в `metadata` хода (`effective_roles`/`identity_linked`).
- **Enforcement (остаток):** permission-слой (`PermissionEvaluator`, ADR-029) роль-оси не имеет —
  глобальные роли проверяются на HTTP-уровне (`requirePermission`). Права машинного аккаунта
  шлюза (`SYNTH_API_KEY`/service-account) больше не «раздаются» внешним отправителям: сопознанный
  с ролью `USER` действует с пользовательскими правами, сужение работает. Полный role-aware
  enforcement — отдельный срез (альтернатива — ADR-052 service-key со scoped-токенами).

Пример:

```yaml
events:
  enabled: true
  defaultMode: bound
  ephemeralTtl: "24h"
  journalRetentionDays: 30
  allowedSources: []
  dedupStore: memory
  unknownAgentTemplate: drop
  keyRateLimitPerMinute: 0
  decisionRouting: false
  autoBind: false
  autoBindAgentTemplate: ""
  identityMap:
    "chat:telegram:123456": "user-uuid-or-login"
    "tg:123456": "user-uuid-or-login"
```

Часть полей (`enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`,
`unknownAgentTemplate`, `keyRateLimitPerMinute`, `decisionRouting`, `autoBind`, `autoBindAgentTemplate`,
`identityMap`)
переопределяется в runtime через
`GET/PUT/DELETE /api/v2/settings/events` (live, без рестарта); `dedupStore` — deployment-настройка.

API (`POST /api/v2/events`, bindings, ключи привязок, journal) — `docs/API_V2.md` §5.26; устройство
шины/роутера — `docs/ARCHITECTURE.md` («Внешние события и хуки»).

### Исходящие webhooks (`webhooks.*`, ADR-052 этап II)

Подписки на события и HTTP-доставка подписчикам (`WebhookService` над `EventBus.subscribeAll`).
Секция — deployment-настройка; мастер-выключатель `enabled` и политики доставки.

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `webhooks.enabled` | Мастер-выключатель доставки (opt-in); `false` — движок не доставляет, а мутации `/api/v2/webhooks` и тест отвечают 503 `UNAVAILABLE` (чтение доступно) | `false` |
| `webhooks.maxAttempts` | Число HTTP-попыток на доставку (1..10); между попытками — экспоненциальный backoff с джиттером | `5` |
| `webhooks.timeoutMs` | Таймаут одного HTTP-запроса, мс | `10000` |
| `egress.webhooks` | Политика цели доставки (ADR-099): `mode` `deny`/`allow`/`off`, `list`, `exceptions`; `off` — dev (снимает и требование `https`). Заменяет удалённый `webhooks.allowPrivateTargets` | `deny` приватных диапазонов |
| `webhooks.deliveryRetentionDays` | Срок хранения журнала доставок (`{dataDir}/webhooks/deliveries.jsonl`), дни; `0` — без ограничения; prune на старте и каждые 6 ч | `30` |

Пример:

```yaml
webhooks:
  enabled: false
  maxAttempts: 5
  timeoutMs: 10000
  deliveryRetentionDays: 30
# Политика цели доставки — в секции egress.webhooks (mode deny | allow | off), см. выше.
```

API и формат подписи (`/api/v2/webhooks`, подписки/ротация секрета/журнал/тест) — `docs/API_V2.md` §5.29;
устройство движка и адресная политика — `docs/ARCHITECTURE.md` («Внешние события и хуки»)
и [ADR-052](./arch_decisions/adr-052-public-api-platform.md).

### Планировщик расписаний (`scheduler.*`, ADR-051 срез / ADR-089)

Cron/interval-планировщик публикует события `source: 'cron'` через
`EventIngress`; маршрутизацию в сессии выполняет `EventRouter`
(правило `SchedulerRuleProvider`). Управление — API `/api/v2/schedules`
(`docs/API_V2.md` §5.27).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `scheduler.enabled` | Мастер-выключатель сервиса: `false` — тикер не стартует (CRUD расписаний и `run` остаются) | `true` |
| `scheduler.tickSec` | Период тика, секунды (1..3600) | `60` |
| `scheduler.catchUp` | Поведение при пропущенном на старте срабатывании: `skip` — Job `skipped` с пересчётом `nextRunAt`, `once` — одно догоняющее (`trigger:'catchup'`); расписание может переопределить полем `catchUp` | `skip` |
| `scheduler.jobRetentionDays` | Срок хранения Job-истории (`{dataDir}/scheduler/jobs.jsonl`), дни; `prune` на старте сервиса | `30` |
| `scheduler.leaderElection` | Выбор лидера-владельца тикера: `none` — каждый процесс считает себя лидером (single-process), `file` — file-лок `{dataDir}/scheduler/leader.lock` (stale `3×tick`), `postgres` — session-level advisory-lock БД (требует `storage.backend=postgres`; иначе — предупреждение и `AlwaysLeader`), тикер стартует только у лидера | `none` |
| `scheduler.crossProcessLocks` | Межпроцессная сериализация мутаций `ScheduleStore` (file-мьютекс `{dataDir}/scheduler/schedules.lock` поверх in-process `AsyncLock`); защита от потери `nextRunAt` при нескольких репликах. Под `storage.backend=postgres` неактуален: записи `schedules` — атомарные SQL-мутации, файловый лок не создаётся | `false` |

File-based флаги (`events.dedupStore: file`, `scheduler.leaderElection: file`,
`scheduler.crossProcessLocks: true`) рассчитаны на **общий `dataDir` на одном хосте/FS** и
по умолчанию выключены (поведение single-process не меняется). Для реплик без общего FS
используйте `storage.backend=postgres` и `scheduler.leaderElection: postgres` (advisory-лок
БД, PROP-032); K8s `Lease` — будущий шаг (ADR-051).

Пример:

```yaml
scheduler:
  enabled: true
  tickSec: 60
  catchUp: skip
  jobRetentionDays: 30
  leaderElection: none
  crossProcessLocks: false
```

### Гибридный режим (remote)

Секция `remote` включает гибридный режим: локальный `synth serve` подключается
к удалённому backend (например, корпоративному K3s) и объединяет локальные и
удалённые проекты/сессии в одном UI, а LLM-запросы централизуются на сервере.
Подробности — [HYBRID.md](HYBRID.md).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `enabled` | Включить гибридный режим | `false` |
| `backendUrl` | Базовый URL удалённого backend | `""` |
| `auth.type` | Способ аутентификации: `device` (OIDC device flow) или `api_key` | `device` |
| `auth.apiKey` | API-ключ для `auth.type: api_key` | `""` |
| `auth.issuer` | OIDC issuer (Keycloak realm) для device flow | `""` |
| `auth.clientId` | OIDC `client_id` (public client) для device flow | `""` |
| `llm` | Куда идут LLM-запросы локальных сессий: `server` (централизация) или `local` | `server` |
| `worlds` | Какие миры доступны: `{ local, remote }` | `{ local: true, remote: true }` |
| `credentialsPath` | Путь к файлу credentials; пусто → `~/.config/synth/credentials.json` (0600) | `""` |
| `timeoutMs` | Таймаут запросов к удалённому backend | `15000` |

**Env-переменные:** отдельных `SYNTH_REMOTE_*` переменных нет — секция задаётся
в `config.yaml` или CLI-флагами (`synth serve --connect <url> --oidc-issuer ...
--oidc-client-id ... --token ...`, `synth connect|disconnect --backend <url>`,
`synth project publish|fork <id> --remote <url>`).

## Первый запуск

- `ensureDataDir()` создаёт структуру подкаталогов в `dataDir` (sessions, projects, providers, models, agents, context, auth, workspaces)
- `ensureConfigFile()` опционально пишет `config.yaml` с дефолтами (в зависимости от режима: `~/.config/synth/config.yaml`, `./config.yaml` или `/etc/synth/config.yaml`)
- Режим развёртывания определяется `resolveDeployMode()` (`SYNTH_DEPLOY_MODE` → docker-маркеры → root → dev)

## Права доступа к файлам

- `config.yaml` — `600` (rw-------)
- `data/` — вне репозитория, в `.gitignore`
- API-ключи — никогда не коммитить
