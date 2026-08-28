# Конфигурация Synth

## Приоритет

```
CLI-флаги > env vars (SYNTH_*) > config.yaml > defaults
```

- **CLI-флаги** передаются в `loadConfig({ overrides })` — самый высокий приоритет (например `--port`, `--api-key`, `--data-dir` у `synth serve`).
- **Env vars** читаются поверх конфига в точках использования (см. таблицу ниже).
- **config.yaml** — файл, найденный каскадным поиском; сливается с дефолтами (`deepMerge`).
- **Defaults** — схема `synthConfigSchema` в `packages/shared/src/config/types.ts`.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `SYNTH_API_KEY` | Ключ для входа в API (backend → роль ADMIN; core standalone → роль USER) | — |
| `SYNTH_DATA_DIR` | Каталог данных (сессии, проекты, провайдеры, модели) | по режиму: `~/.local/share/synth` (user), `./data` (dev), `/var/synth/data` (docker/server) |
| `SYNTH_CONFIG` | Путь к `config.yaml` (приоритетнее каскадного поиска) | каскадный поиск |
| `SYNTH_HOST` | Адрес прослушивания HTTP-серверов (backend, core, CLI-обёртка) | `0.0.0.0` |
| `SYNTH_PORT` | Порт бэкенда | `5000` |
| `SYNTH_CORE_PORT` | Порт core (и `synth serve`) | `4300` |
| `SYNTH_RUNNER_PORT` | Порт раннера | `5200` |
| `SYNTH_AUTH_DEBUG` | Режим отладки auth (тестовые пользователи) | `false` |
| `SYNTH_DEFAULT_LANGUAGE` | Язык интерфейса backend (`ru`/`en`; проверяется префикс `en`) | `ru` |
| `SYNTH_DEPLOY_MODE` | Режим развёртывания: `user`, `docker`, `server`, `dev` | автодетект (docker-маркеры → `docker`, root → `server`, `SYNTH_AUTH_DEBUG=true` → `dev`, иначе `user`) |
| `SYNTH_LOG_DIR` | Каталог логов сервисов (эндпоинт `/api/v2/logs`) | ищется существующий каталог логов |
| `SYNTH_BACKEND_URL` | URL бэкенда (для раннера) | `http://localhost:5000` |
| `SYNTH_CORS_ORIGIN` | CORS origin (приоритет выше конфига) | — |

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
| `SYNTH_PROVIDER_<NAME>_TYPE` | Тип: `openai`, `anthropic`, `ollama` |

## config.yaml

Каскадный поиск (от высшего приоритета к низшему):

1. `--config` CLI-флаг или `SYNTH_CONFIG` env var
2. `./synth.config.yaml` (CWD)
3. `./config.yaml` (CWD)
4. `~/.config/synth/config.yaml` (пользовательский)
5. `/etc/synth/config.yaml` (системный)

Найденный файл сливается с дефолтами (`deepMerge`), затем применяются CLI-overrides. Реализация: `loadConfig` в `packages/shared/src/config/loader.ts`, `findConfigPath` в `resolve.ts`.

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
  workspacesRoot: ""              # если пусто — {dataDir}/workspaces
  defaultWorkspace: ""            # если пусто — {dataDir}/workspaces/default

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback" }

llm:
  defaultProvider: ""             # пусто — админ настраивает сам
  defaultModel: ""
  maxRetries: 3
  timeout: 60

core:
  port: 4300
  apiKey: ""

runner:
  port: 5200
  backendUrl: "http://localhost:5000"
  enginePorts: { opencode: 4100, cline: 4200, synth: 4300 }
  proxyPort: 9090

ui:
  port: 5002
  backendUrl: "http://localhost:5000"
  theme: "flexoki"
  themeMode: "system"
  locale: "ru"

i18n:
  defaultLanguage: "ru"
  supportedLanguages: ["ru", "en"]

session:
  planMode: "auto"                # строгость цикла Plan→Build: auto | strict | off

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

microFirst:
  enabled: false
  confidenceThreshold: 0.8
  rulesEnabled: true
  embeddingEnabled: false
  embedProvider: "ollama"
  embedModel: "local.nomic-embed-text:latest"
  microLlmEnabled: false

llmGateway:
  enabled: false                  # выключен по умолчанию
  inputMode: "obfuscate"          # obfuscate | block
  logPayloads: false
  rateLimit: { userPerMinute: 60, providerPerMinute: 120 }
  audit: { enabled: true, logPath: "" }   # logPath пуст → {dataDir}/audit/llm-gateway.jsonl

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
```

Полный список полей (включая `logging`, `tsm`, `context`, `summarization`, `mcp`, `auth.oidc`) — в `packages/shared/src/config/types.ts`.

## Первый запуск

- `ensureDataDir()` создаёт структуру подкаталогов в `dataDir` (sessions, projects, providers, models, agents, context, auth, workspaces)
- `ensureConfigFile()` опционально пишет `config.yaml` с дефолтами (в зависимости от режима: `~/.config/synth/config.yaml`, `./config.yaml` или `/etc/synth/config.yaml`)
- Режим развёртывания определяется `resolveDeployMode()` (`SYNTH_DEPLOY_MODE` → docker-маркеры → root → dev)

## Права доступа к файлам

- `config.yaml` — `600` (rw-------)
- `data/` — вне репозитория, в `.gitignore`
- API-ключи — никогда не коммитить
