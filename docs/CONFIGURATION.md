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
| `SYNTH_WEBHOOKS_ALLOW_PRIVATE_TARGETS` | boolean | `webhooks.allowPrivateTargets` |
| `SYNTH_WEBHOOKS_DELIVERY_RETENTION_DAYS` | number | `webhooks.deliveryRetentionDays` |
| `SYNTH_DECISION_ENABLED` | boolean | `decision.enabled` |
| `SYNTH_DECISION_PROVIDER` | string | `decision.provider` |
| `SYNTH_DECISION_MODEL` | string | `decision.model` |
| `SYNTH_DECISION_CONFIDENCE_THRESHOLD` | number | `decision.confidenceThreshold` |
| `SYNTH_DECISION_ESCALATION_PROVIDER` | string | `decision.escalationProvider` |
| `SYNTH_DECISION_ESCALATION_MODEL` | string | `decision.escalationModel` |
| `SYNTH_BOOTSTRAP_SERVICE_KEYS` | JSON-массив | `security.bootstrapServiceKeys` (объектный env-оверрайд, ADR-052/O1; см. ниже) |

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
  # servers / networkPolicy — см. packages/shared/src/config/types.ts

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
| `webhooks.allowPrivateTargets` | Разрешить `http` и приватные/loopback адреса (dev). `false` — только `https` и публичные адреса (SSRF-политика поверх `engine/mcp/network-policy.ts`) | `false` |
| `webhooks.deliveryRetentionDays` | Срок хранения журнала доставок (`{dataDir}/webhooks/deliveries.jsonl`), дни; `0` — без ограничения; prune на старте и каждые 6 ч | `30` |

Пример:

```yaml
webhooks:
  enabled: false
  maxAttempts: 5
  timeoutMs: 10000
  allowPrivateTargets: false
  deliveryRetentionDays: 30
```

API и формат подписи (`/api/v2/webhooks`, подписки/ротация секрета/журнал/тест) — `docs/API_V2.md` §5.29;
устройство движка и SSRF — `docs/ARCHITECTURE.md` («Внешние события и хуки»)
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
| `scheduler.leaderElection` | Выбор лидера-владельца тикера: `none` — каждый процесс считает себя лидером (single-process), `file` — file-лок `{dataDir}/scheduler/leader.lock` (stale `3×tick`), тикер стартует только у лидера | `none` |
| `scheduler.crossProcessLocks` | Межпроцессная сериализация мутаций `ScheduleStore` (file-мьютекс `{dataDir}/scheduler/schedules.lock` поверх in-process `AsyncLock`); защита от потери `nextRunAt` при нескольких репликах | `false` |

File-based флаги (`events.dedupStore: file`, `scheduler.leaderElection: file`,
`scheduler.crossProcessLocks: true`) рассчитаны на **общий `dataDir` на одном хосте/FS** и
по умолчанию выключены (поведение single-process не меняется). Для разных dataDir на реплику
или нескольких хостов нужен K8s `Lease`/PG advisory lock (будущий шаг, ADR-051).

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
