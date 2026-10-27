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
| `SYNTH_STORAGE_BACKEND` | ADR-096: физический backend хранения: `file` (JSON-файлы, ADR-005), `memory` (in-memory, данные **не** сохраняются) или `postgres` (ADR-097) | `file` |
| `SYNTH_POSTGRES_DSN` | ADR-097: строка подключения PostgreSQL (приоритетнее отдельных `host`/`port`/`database`/`user`) | — |
| `SYNTH_POSTGRES_HOST` | ADR-097: хост PostgreSQL | — |
| `SYNTH_POSTGRES_PORT` | ADR-097: порт PostgreSQL | — |
| `SYNTH_POSTGRES_DATABASE` | ADR-097: имя базы данных PostgreSQL | — |
| `SYNTH_POSTGRES_USER` | ADR-097: пользователь PostgreSQL | — |
| `SYNTH_POSTGRES_SCHEMA` | ADR-097: схема БД (namespace таблиц драйвера) | — |
| `SYNTH_POSTGRES_SSL` | ADR-097: legacy-флаг TLS-соединения (`true`/`false`); используется, только если `SYNTH_POSTGRES_SSLMODE` не задан | — |
| `SYNTH_POSTGRES_SSLMODE` | ADR-097/ADR-099: TLS-режим соединения с БД: `disable` / `require` / `verify-full` (`verify-ca` — алиас `verify-full`); приоритетнее legacy `ssl` | — |
| `SYNTH_POSTGRES_POOL_MAX` | ADR-097: максимальный размер пула соединений | `10` |
| `SYNTH_POSTGRES_PASSWORD` | ADR-097: пароль БД — **только** env или файл `{dataDir}/secrets/postgres-password` (в `config.yaml` не хранится, инвариант 13) | — |
| `SYNTH_DEGRADED_MODE` | ADR-098: поведение при недоступности БД (`fallback-file`/`halt`) | `fallback-file` |
| `SYNTH_STORAGE_FALLBACK_DIR` | ADR-098: каталог файлового фоллбека при деградации | `{dataDir}/fallback` |
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
| `SYNTH_ANALYTICS_RETENTION_DAYS` | ADR-102: срок хранения суточных роллапов аналитики, дни (`<= 0` — без ограничения) | `analytics.retentionDays` (`400`) |
| `SYNTH_METRICS_ENABLED` | ADR-094: включить `GET /metrics` (Prometheus exposition 0.0.4); `false` → 404 | `metrics.enabled` (`false`) |
| `SYNTH_METRICS_TOKEN` | ADR-094: bearer-токен `/metrics` (приоритетнее файла `{dataDir}/secrets/metrics-token`); значение не логируется | — |
| `SYNTH_EXECUTION_MODE` | ADR-077: топология исполнения — `inline` (по умолчанию) \| `remote` (удалённый исполнитель, шаг 7b ADR-077; fail-closed на старте) | `inline` |
| `SYNTH_EXECUTION_REMOTE_URL` | ADR-077: список адресов исполнителей (через запятую) | — |
| `SYNTH_EXECUTION_TOKEN` | ADR-077: путь/ссылка на токен исполнителя (НЕ значение, инвариант 13) | — |
| `SYNTH_EXECUTION_TIMEOUT_MS` | ADR-077: таймаут exec-вызова, мс | `30000` |
| `SYNTH_EXECUTION_CONCURRENCY` | ADR-077: лимит одновременных exec-вызовов | число CPU процесса |
| `SYNTH_EXECUTION_FAIL_MODE` | ADR-077: поведение при недоступном исполнителе (`fail`/`inline-fallback`) | `fail` |

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

Скалярные ключи секций `events`, `scheduler`, `webhooks`, `decision`, `analytics`, `metrics`,
`questions`, `background`, `authority` можно задавать
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
| `SYNTH_PROXY_PASSWORD`, `SYNTH_PROXY_<NAME>_PASSWORD` | string (секрет) | пароль Basic-аутентификации прокси: `default` и именованные профили соответственно (в config не хранится) |
| `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | ADR-099: CA к https-прокси (взаимоисключающи) | `proxy.tls` |
| `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | ADR-099: mTLS к https-прокси | `proxy.tls` |
| `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | boolean | `proxy.tls.rejectUnauthorized` |
| `SYNTH_DECISION_ENABLED` | boolean | `decision.enabled` |
| `SYNTH_DECISION_PROVIDER` | string | `decision.provider` |
| `SYNTH_DECISION_MODEL` | string | `decision.model` |
| `SYNTH_DECISION_CONFIDENCE_THRESHOLD` | number | `decision.confidenceThreshold` |
| `SYNTH_DECISION_ESCALATION_PROVIDER` | string | `decision.escalationProvider` |
| `SYNTH_DECISION_ESCALATION_MODEL` | string | `decision.escalationModel` |
| `SYNTH_ANALYTICS_RETENTION_DAYS` | number | `analytics.retentionDays` |
| `SYNTH_QUESTIONS_TIMEOUT_MS` | number | `questions.timeoutMs` (этап 1 roadmap 0.13 — блок 3) |
| `SYNTH_QUESTIONS_RETENTION_DAYS` | number | `questions.retentionDays` (этап 1 roadmap 0.13 — блок 3) |
| `SYNTH_BACKGROUND_ENABLED` | boolean | `background.enabled` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | number | `background.maxSubagentsPerSession` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | number | `background.maxProcessesPerSession` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | number | `background.maxRunsPerSession` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_BACKGROUND_LOG_MAX_BYTES` | number | `background.logMaxBytes` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_BACKGROUND_RETENTION_DAYS` | number | `background.retentionDays` (этап 1 roadmap 0.13 — блок 4) |
| `SYNTH_METRICS_ENABLED` | boolean | `metrics.enabled` |
| `SYNTH_AUTHORITY_ENABLED` | boolean | `authority.enabled` (ADR-106; мастер-выключатель слоя полномочий) |
| `SYNTH_AUTHORITY_SHADOW` | boolean | `authority.shadow` (ADR-106; `true` — наблюдение, `false` — принуждение) |
| `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` | string (секрет) | `client_secret` OAuth-провайдера: `google` → `SYNTH_OAUTH_GOOGLE_CLIENT_SECRET` (в config не хранится; альтернатива — файл `{dataDir}/secrets/oauth/<provider>.client_secret`, см. ниже) |
| `SYNTH_OAUTH_PROVIDERS` | JSON-объект | `oauth.providers` — каталог OAuth-провайдеров (объектный env-оверрайд, ADR-105 Ф3; см. ниже) |
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
| `SYNTH_RESTART_MODE` | ADR-092: graceful restart из UI — `disabled` (default) \| `process` (выход с кодом 75, поднимает супервизор) \| `supervisor` (локальный `scripts/dev.sh`). CLI `synth serve --restart-mode` приоритетнее env; неизвестное значение → `disabled` + предупреждение |

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

### Перезапуск инстанса (ADR-092)

`POST /api/v2/maintenance/restart {confirm:true}` (ADMIN) не перезапускает процесс «изнутри», а
выполняет **graceful shutdown с кодом 75** (`EX_TEMPFAIL`); поднять процесс заново должен супервизор.
Режим — `SYNTH_RESTART_MODE` (CLI `synth serve --restart-mode` приоритетнее env):

| Режим | Что делает | Для чего |
|---|---|---|
| `disabled` (default) | `GET /restart` → `supported:false`, `POST` → 409 `RESTART_UNSUPPORTED` | одиночный `synth serve` без супервизора (systemd `Restart=on-failure` — отдельно) |
| `process` | выход с кодом 75; перезапускает внешний супервизор | K8s (Deployment `restartPolicy: Always`), Docker (`restart: unless-stopped`), systemd (`Restart=on-failure`), pm2 |
| `supervisor` | то же, но локальный `scripts/dev.sh` сам поднимает процесс | dev-окружение |

Деплой-дефолты: Helm-чарт — `backend.restartMode: process` (+ env `SYNTH_RESTART_MODE`), Docker Compose —
`restart: unless-stopped` + `SYNTH_RESTART_MODE=process`, `scripts/dev.sh` — `supervisor`, bare
`synth serve` — `disabled`. Пример systemd-юнита:

```ini
[Service]
ExecStart=/usr/bin/synth serve --restart-mode process
Restart=on-failure        # код 75 — «временно не могу», unit поднимется
RestartSec=2
```

**Multi-replica:** endpoint перезапускает только тот процесс/pod, который обработал запрос; для всего
Deployment — `kubectl rollout restart deployment/<release>-synth-backend` (или `helm rollback`).
Активные стримы и in-flight запросы на перезапускаемом процессе прерываются; запрос пишется в аудит
`restart.requested`. UI ждёт смены `startedAt` в `GET /health` (до 90 с), затем перезагружается.

`GET /health` и `GET /api/v2/health` отдают аддитивное поле `startedAt` (ISO) — метка старта процесса.

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
                                  # | postgres (ADR-097: опциональный драйвер @itphx/synth-storage-postgres);
                                  # SYNTH_STORAGE_BACKEND
  postgres:                       # ADR-097: параметры PostgreSQL (используются при backend: postgres)
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
  degradedMode: "fallback-file"   # ADR-098: при недоступности БД — fallback-file (файловый фоллбек,
                                  # строго read-only) | halt (остановить старт); SYNTH_DEGRADED_MODE
  fallbackDir: ""                 # ADR-098: каталог файлового фоллбека; пусто — {dataDir}/fallback;
                                  # SYNTH_STORAGE_FALLBACK_DIR
  workspacesRoot: ""              # если пусто — {dataDir}/workspaces; SYNTH_WORKSPACES_ROOT
  defaultWorkspace: ""            # если пусто — {dataDir}/workspaces/default; SYNTH_DEFAULT_WORKSPACE
  workspaceOutsideRoot: ""        # ADR-075: политика для абсолютного workspace вне workspacesRoot
                                  # confirm | deny; пусто — дефолт по режиму (standalone — confirm,
                                  # managed — deny); SYNTH_WORKSPACE_OUTSIDE_ROOT
  maxUploadBytes: 104857600       # лимит загрузки файла /api/v2/fs/upload, байт (>=1024, <=2 ГиБ);
                                  # не задано — 100 МиБ; SYNTH_MAX_UPLOAD_BYTES

execution:                         # ADR-077: топология исполнения (параметр запуска, инвариант 24)
  mode: "inline"                  # inline (по умолчанию) | remote; SYNTH_EXECUTION_MODE;
                                  # CLI-флаг --execution-mode важнее env; неверное значение — fail-closed
  remote:
    url: []                       # список адресов исполнителей; SYNTH_EXECUTION_REMOTE_URL (через запятую);
                                  # пусто при mode=remote — fail-closed на старте
    timeoutMs: 30000              # таймаут exec-вызова; SYNTH_EXECUTION_TIMEOUT_MS
    concurrency: 8                # лимит одновременных exec-вызовов; SYNTH_EXECUTION_CONCURRENCY
                                  # (дефолт — число CPU процесса)
    failMode: "fail"              # fail (fail-closed) | inline-fallback (только явной настройкой);
                                  # SYNTH_EXECUTION_FAIL_MODE
    tokenSecret: ""               # путь/ссылка на токен исполнителя (НЕ значение — инвариант 13);
                                  # SYNTH_EXECUTION_TOKEN

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback", cliClientId: "synth-cli" }

llm:
  defaultProvider: ""             # fallback: пусто — админ настраивает сам; runtime-пара «провайдер + модель»
  defaultModel: ""                # задаётся в UI «Модели» (`/api/v2/settings/default-model`) и приоритетнее config
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
  #   auth: { kind: "credential", credentialId: "extc_…" } — ссылка на внешний
  #   доступ (ADR-105 Ф0): коннектор авторизуется токеном из слоя доступов,
  #   сам токен в конфиге/реестре не лежит (доступ — в {dataDir}/secrets/oauth/).
  #   Поле аддитивно: записи без auth валидны.
  # networkPolicy — адресная политика MCP {mode, list, exceptions} (тот же формат, что egress.*),
  # см. «Адресная политика исходящих запросов (`egress.*`, ADR-099)»

oauth:
  providers: {}                    # ADR-105 Ф3: каталог OAuth-провайдеров инстанса —
                                  # «имя → описание» (данные, без секретов);
                                  # подробности — «Каталог OAuth-провайдеров (`oauth.providers`, ADR-105 Ф3)»

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

analytics:                        # ADR-102: аналитика и отчётность инстанса
  retentionDays: 400              # хранение суточных роллапов (UTC-дни; <= 0 — без ограничения)

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

- `storage.backend` — физический backend хранения: `file` (JSON-файлы с атомарной записью tmp→rename, [ADR-005](./arch_decisions/adr-005-json-storage.md); по умолчанию), `memory` (in-memory, данные **не** сохраняются на диск — для герметичных тестов и эмуляции) или `postgres` (PostgreSQL; опциональный in-tree драйвер `@itphx/synth-storage-postgres`, [ADR-097](./arch_decisions/adr-097-storage-provider-class.md)). Домен работает через доменные порты, backend взаимозаменяем ([ADR-096](./arch_decisions/adr-096-storage-layer.md)); любой backend обязан пройти контрактный suite `packages/core/src/storage/contract/*`.
- **Приоритет** ([ADR-023](./arch_decisions/adr-023-configuration.md)): env `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `file`. Некорректное значение (не `file`/`memory`/`postgres`) — warn и фолбэк на config/дефолт (fail-soft); неизвестное **явное** значение в самом `resolveStorageBackend` — **fail-closed** (ошибка, а не тихий уход на файлы). Резолвер — `resolveStorageBackend` (`@itphx/synth-shared/config`); выбор применяется в точке сборки `StorageContext` (`createStorageContextAsync`/`buildStorageContext`; синхронный `createStorageContext` для `postgres` бросает).
- `memory` печатает предупреждение `storage.backend=memory: данные не сохраняются на диск` — режим **не для прода** (только тесты/эмуляция).
- `postgres` требует установленного драйвера (`@itphx/synth-storage-postgres`, ставится в комплекте `@itphx/synth`; `pg` — optional-зависимость драйвера) и доступной БД. Драйвер применяет/проверяет **свою** схему БД (`synth_schema_migrations`, инлайн-SQL-миграции) — отдельно от `meta.json`/`synth migrate` (ADR-092); «схема БД новее драйвера» — fail-closed.

### PostgreSQL (`storage.postgres`, ADR-097)

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

### TLS соединения с PostgreSQL (`storage.postgres.sslmode`, ADR-099 × ADR-097)

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
- **TLS применяется при старте** (live-переключения нет): изменения — в т.ч. сохранённые из UI в `security-tls.json` — вступают в силу после рестарта.

### Деградированный режим при недоступности БД (`storage.degradedMode`, ADR-098)

Если выбран `postgres`, но БД недоступна на старте, поведение задаёт `storage.degradedMode` (env `SYNTH_DEGRADED_MODE` > config > `fallback-file`; резолвер `resolveDegradedMode`):

- `fallback-file` (по умолчанию) — сервис поднимается на **файловом фоллбеке** в `storage.fallbackDir` (env `SYNTH_STORAGE_FALLBACK_DIR` > config > `{dataDir}/fallback`; **отдельный** от `dataDir` каталог) в **строгом read-only**: мутации → `503 STORAGE_DEGRADED_READONLY`, не-администраторам — `503 STORAGE_DEGRADED`. `/health` отдаёт `status: 'degraded'` + блок `storage.{backend,fallbackDir,reason,since}`; диагностика — `GET /api/v2/storage/status`.
- `halt` — старт останавливается с внятной ошибкой (`STORAGE_UNAVAILABLE`).

**Fail-closed** (фоллбек **не** применяется независимо от `degradedMode`): ошибка конфигурации/кред (`STORAGE_POSTGRES_CONFIG_INVALID`), отсутствие зависимости (`…DEPENDENCY_MISSING`, нет `pg`), незагружаемый пакет-драйвер (`STORAGE_BACKEND_UNAVAILABLE`), схема БД новее драйвера (`…SCHEMA_TOO_NEW`). Деградация охватывает **отказ БД** (сеть/класс `08`/`57P0x`, auth-ошибка сервера, `…SCHEMA_OUTDATED` — лечится `synth migrate`, прочие runtime-ошибки). Авто-возврата к БД **нет** — только рестарт после восстановления соединения ([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)); процедуры — [MAINTENANCE.md](./MAINTENANCE.md).

### Исполнение (топология) (`execution.*`, ADR-077)

Секция `execution` — **переключатель топологии исполнения**: где выполняются команды агентских
тулов (`execute_shell`, `grep_files`, git-тулы). Это **параметр запуска**, а не runtime-настройка:
смена режима — только рестартом процесса (инвариант 24). Спецификация — [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md).

| Поле | Тип / значения | Дефолт | Env | Смысл |
|---|---|---|---|---|
| `execution.mode` | `inline` \| `remote` | `inline` | `SYNTH_EXECUTION_MODE` | Топология: `inline` — исполнение в процессе backend'а (all-in-one, прежнее поведение); `remote` — отдельные исполнители |
| `execution.remote.url` | список адресов | `[]` | `SYNTH_EXECUTION_REMOTE_URL` (через запятую) | Адреса исполнителей (K8s Service `synth-executor`, `http://…`); пусто при `remote` → fail-closed на старте |
| `execution.remote.timeoutMs` | число | `30000` | `SYNTH_EXECUTION_TIMEOUT_MS` | Таймаут exec-вызова (30 с — как у нынешних тулов; больший лимит shell — свойство тула, не конфига) |
| `execution.remote.concurrency` | число | число CPU процесса | `SYNTH_EXECUTION_CONCURRENCY` | Лимит одновременных exec-вызовов на backend; превышение → очередь |
| `execution.remote.failMode` | `fail` \| `inline-fallback` | `fail` | `SYNTH_EXECUTION_FAIL_MODE` | Поведение при недоступном исполнителе: `fail` — fail-closed (инструмент недоступен с явной причиной); `inline-fallback` — backend исполняет команду сам (**только явной настройкой**) |
| `execution.remote.tokenSecret` | путь/ссылка | — | `SYNTH_EXECUTION_TOKEN` | **Путь/ссылка на токен, НЕ значение** (инвариант 13). Сам токен — `synth_exec_…`, живёт в Secret/файле |

**Приоритет** ([ADR-023](./arch_decisions/adr-023-configuration.md)): CLI-флаг `--execution-mode inline|remote` >
env `SYNTH_EXECUTION_*` > `config.yaml` > дефолт. Резолвер — `resolveExecutionConfig`
(`@itphx/synth-shared/config`).

**Fail-closed** (как `storage.backend`): неизвестное **явное** значение `mode` (опечатка `inlne`) или
`failMode` — ошибка конфигурации, а не тихий выбор дефолта:

```text
[config] невалидное значение SYNTH_EXECUTION_MODE="inlne": ожидается одно из 'inline', 'remote'
[config] невалидное значение --execution-mode="inlne": ожидается одно из 'inline', 'remote'
```

**Текущее состояние реализации (шаги 3 и 7b плана ADR-077).** Режим `inline` — прежнее
поведение, ничего не меняется. Режим `remote` реализован **шагом 7b**: core подключает пакет
исполнителя `@itphx/synth-executor` динамическим `import()` и собирает удалённый порт. Пакет
опционален (`optionalDependencies` core), поэтому режим `remote` — **fail-closed на старте**
(процесс не поднимается, а не «молча уходит в inline»):

| Ситуация | Что видит оператор |
|---|---|
| `mode: remote`, список `remote.url` пуст | `Remote execution mode (execution.mode=remote) requires at least one executor address (execution.remote.url / SYNTH_EXECUTION_REMOTE_URL).` |
| `mode: remote`, адреса заданы, но пакет исполнителя не установлен | `Remote execution mode (execution.mode=remote) is unavailable: executor package '@itphx/synth-executor/client' is not installed` |
| `mode: remote`, пакет есть, но токен не читается | `Remote execution mode (execution.mode=remote) is unavailable: executor token could not be read (execution.remote.tokenSecret / SYNTH_EXECUTION_TOKEN)` |

Пример `config.yaml`:

```yaml
execution:
  mode: "inline"                   # inline (по умолчанию) | remote (ADR-077)
  remote:
    url: []                        # список адресов исполнителей (через запятую — env SYNTH_EXECUTION_REMOTE_URL)
    timeoutMs: 30000               # SYNTH_EXECUTION_TIMEOUT_MS
    concurrency: 8                 # SYNTH_EXECUTION_CONCURRENCY (дефолт — число CPU процесса)
    failMode: "fail"               # fail (fail-closed) | inline-fallback; SYNTH_EXECUTION_FAIL_MODE
    tokenSecret: ""                # путь/ссылка на токен исполнителя (НЕ значение!); SYNTH_EXECUTION_TOKEN
```

### Доверие TLS и mTLS исходящих соединений (`security.tls`, ADR-099)

Единый источник доверия TLS/CA для **всех** исходящих соединений Synth (провайдеры LLM, MCP HTTP,
`web_fetch`/`web_search`, webhooks, гибридный backend, инструкции/скиллы по URL, update-checker,
OIDC/JWKS, иконки провайдеров, git, PostgreSQL). Секция читается резолверами
`resolveTlsProfiles`/`resolveTlsTrust` (`packages/shared/src/config/tls.ts`). Настраивается в
`config.yaml`/env и **из админ-UI** (раздел «Сеть» → «Доверенные CA (TLS)»); применение — **при старте
процесса** (`EgressDispatcher` start-only), сохранение из UI вступает в силу после рестарта
(`restartRequired`). Инвариант — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md): подсистемы не
создают собственных агентов/диспетчеров/CA-пулов.

**Приоритет (поле-уровневый):** env `SYNTH_TLS_*` > runtime (bootstrap/UI) > `config.yaml` > defaults
([ADR-023](./arch_decisions/adr-023-configuration.md)). Параметры, заданные в config/env, показываются в
UI **read-only** с пометкой источника; переопределить их из UI нельзя (кроме per-host маппингов).

| Поле | Env | Назначение |
|---|---|---|
| `caFile` | `SYNTH_TLS_CA_FILE` | Путь к PEM-файлу доверенного CA (один сертификат или **CA-бандл** из нескольких); **взаимоисключающ** с `caPem` |
| `caPem` | `SYNTH_TLS_CA_PEM` | PEM доверенного CA (например из Secret); **взаимоисключающ** с `caFile` |
| `certFile` | `SYNTH_TLS_CERT_FILE` | mTLS: путь к PEM-файлу клиентского сертификата (default-профиль) |
| `keyFile` | `SYNTH_TLS_KEY_FILE` | mTLS: путь к PEM-файлу приватного ключа клиента (default-профиль) |
| `rejectUnauthorized` | `SYNTH_TLS_REJECT_UNAUTHORIZED` | Проверять сертификат сервера (`true`/`1`/`false`/`0`); по умолчанию `true` |

- **Пустая конфигурация — системное доверие** (системные CA Node), поведение не меняется.
- **CA-бандл:** один CA-набор на весь egress; в PEM допустимо несколько сертификатов. **Per-host CA
  нет** — различаются только клиентские сертификаты (mTLS).
- **`rejectUnauthorized`:** `true` (дефолт) — проверка сертификата сервера; `false` — проверка
  отключена (осознанный риск MITM; только для отладки). Невалидное env-значение — `warn` + фолбэк.
- **mTLS-профили:** один **default** клиент (`certFile`+`keyFile`, задаются только вместе) и
  `mappings[]` — per-host пары серт+ключ. Паттерны: точный host, `*.suffix` (поддомены), `*` (все
  хосты); регистронезависимо; выбирается **первое совпадение** в порядке маппингов, иначе default; если
  нет ни того, ни другого — клиентский серт не предъявляется. `mappings[]` — только runtime (UI), в
  `config.yaml` их нет.
- **PostgreSQL** использует **тот же** резолвер профилей по host — default-серт без маппинга
  предъявляется и БД. Отдельной «настройки серта для БД» нет.
- **TLS к прокси** (`proxy.tls`) — **отдельная** секция (CA/mTLS к https-прокси), не смешивается с
  доверием к цели; в UI показывается read-only.
- **Fail-closed:** `caFile` и `caPem` одновременно (в т.ч. между источниками) → ошибка; явно заданный
  `caFile`, который отсутствует/не читается/не PEM → ошибка; неполная клиентская пара → ошибка;
  заданное доверие без `undici` → внятная ошибка, а не недоверенный транспорт.
- **Применение:** при старте строится глобальный undici-dispatcher (`setGlobalDispatcher`), обычный
  `fetch` наследует доверие; точки вне общего транспорта (git) получают CA через
  `http.sslCAInfo=<caFile>` (`caPem` без файла git-каналу недоступен).
- **`NODE_EXTRA_CA_CERTS` — только совместимость** (наследуется дочерними процессами: MCP stdio, git),
  **не** конфигурируемый механизм доверия.
- **Применяется при старте:** `security.tls` **не входит** в `RuntimeSettings`/PG — dispatcher
  процесс-глобальный. Runtime-оверрайд живёт в **bootstrap-файле** `{dataDir}/security-tls.json`
  (см. ниже), потому что читается **до** подключения к PostgreSQL.

#### Настройка из UI (раздел «Сеть»)

- **«Прокси»** — egress-прокси (см. раздел `proxy.*`): редактируемая форма, пароль write-only,
  статус saved/running, плашка рестарта.
- **«Доверенные CA (TLS)»** — CA-бандл (вставка PEM или файл, несколько сертификатов, кнопка
  проверки/`validate`), `rejectUnauthorized`, **default** клиентский серт+ключ (upload, write-only),
  таблица **per-host маппингов** (`hosts`, `label`, серт+ключ; порядок = приоритет), read-only
  параметры config/env с источником и read-only TLS к прокси.
- **Где хранится:** `{dataDir}/security-tls.json` (0600, каталог 0700, атомарная запись tmp→rename);
  PEM-материалы — `{dataDir}/secrets/tls/` (`ca.pem`, `client.crt`/`client.key`, `<id>.crt`/`<id>.key`,
  0600). В JSON — только пути и публичный `caPem`; ключи/секреты наружу не отдаются. Это **осознанное
  исключение** из «всё через порты хранилища»: файл читается до БД.
- **Применение:** при следующем старте (`restartRequired`); API — `GET/PUT /api/v2/settings/tls`,
  `PUT/DELETE /settings/tls/ca`, `PUT/DELETE /settings/tls/client`,
  `POST/PUT/DELETE /settings/tls/mappings[/:id]`, `POST /settings/tls/validate` (мутации — ADMIN в
  managed). Изменения пишутся в аудит `{dataDir}/audit/security.jsonl` со `scope:'tls'` (пути, hosts,
  subject — без PEM/ключей). Ответы API не содержат PEM/ключей.

Пример `config.yaml`:

```yaml
security:
  tls:
    caFile: "/etc/synth/tls/corp-ca.pem"   # или caPem (взаимоисключающи); допускается CA-бандл
    # certFile: "/etc/synth/tls/client.pem"  # default mTLS-клиент (вместе с keyFile)
    # keyFile:  "/etc/synth/tls/client.key"
    rejectUnauthorized: true
```

Пример runtime-оверрайда (`{dataDir}/security-tls.json`, управляется UI; пути — в `secrets/tls/`):

```json
{
  "caFile": "/var/synth/data/secrets/tls/ca.pem",
  "rejectUnauthorized": true,
  "defaultClient": {
    "certFile": "/var/synth/data/secrets/tls/client.crt",
    "keyFile": "/var/synth/data/secrets/tls/client.key"
  },
  "mappings": [
    { "id": "m_1", "hosts": ["*.corp.example"], "label": "corp",
      "certFile": "/var/synth/data/secrets/tls/m_1.crt",
      "keyFile": "/var/synth/data/secrets/tls/m_1.key" },
    { "id": "m_2", "hosts": ["*"], "label": "fallback",
      "certFile": "/var/synth/data/secrets/tls/m_2.crt",
      "keyFile": "/var/synth/data/secrets/tls/m_2.key" }
  ]
}
```

**Ограничения.** Нет per-host CA (один CA-бандл на весь egress) и нет нескольких default-сертов.
Default-серт без маппинга предъявляется всем целям, включая PostgreSQL. Через SOCKS5 клиентский серт к
цели не передаётся (`Socks5ProxyAgent` не принимает `requestTls`). Runtime-reload без рестарта нет.
Bootstrap-файл — исключение из правила «всё через порты хранилища» (читается до PG).

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

- Грамматика правила (одинаковая для `list` и `exceptions`): **точный hostname** |
  **`*.suffix`** (только поддомены — сам suffix не матчится) | **CIDR**
  (`10.0.0.0/8`) | **одиночный IP-литерал** (`10.0.0.5` → /32, `::1` → /128).
  Паттерн `*` («любой хост») **недопустим**: его отвергает валидатор, а правило `*`
  в исключении не разрешает ни один хост (fail-closed) — иначе одно исключение
  сняло бы всю SSRF-защиту.
- Порядок проверок: **исключение (hostname, без DNS) → резолв всех A/AAAA →
  исключение (адресное) → локальное имя (`localhost`/`*.localhost`/`*.local`/
  `*.internal`) → `list`**. Локальные имена блокируются **до** `list`, поэтому
  MCP-аддон в кластере (K3s: `*.svc.cluster.local`) разрешается именно
  hostname-исключением (`*.svc.cluster.local`), а не CIDR.
- Одиночный IP в `list`/`exceptions` **работает** и равнозначен CIDR с полной
  маской; IPv4-mapped (`::ffff:10.0.0.5`) нормализуется так же, как проверяемый
  адрес. `exceptions` — allow-правила и проверяются **первыми**: точный hostname,
  `*.suffix`, IP/CIDR.
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
Пример: HTTP-MCP-аддон в K3s (`synth-gateway-telegram.synth.svc.cluster.local`) — имя оканчивается на
`.local`, поэтому блокируется проверкой локальных имён; разрешается hostname-исключением
`exceptions: ["*.svc.cluster.local"]` (не CIDR — hostname-исключение срабатывает до резолва).

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
    exceptions: []                # напр. ["*.svc.cluster.local"] — разрешить MCP-аддон в кластере
```

### Прокси (`proxy.*`, ADR-099 D1+D2, профили и правила — п. 27)

Исходящий HTTP/HTTPS/SOCKS5-прокси — часть единого egress-слоя (см. также `security.tls` — доверие к
**цели** и к https-прокси, и `egress.*` — адресная политика). Секция **top-level**; настраивается в
`config.yaml`/env и **из админ-UI** (раздел «Сеть» → «Прокси»; runtime-override, см.
«Настройка из UI» в разделе `security.tls`). Применение — **при
старте процесса** (`EgressDispatcher` start-only, как TLS): сохранение из UI не переключает маршрут на
лету, нужен рестарт. Маршрут выбирается **per-origin**: `noProxy` (всегда важнее) → правила
(`proxy.rules`, порядок = приоритет, **первое совпадение**) → `mode: all` ? `defaultProfile` : direct
(`selected`). Внутри профиля — `httpsProxy`/`httpProxy` по схеме цели → `allProxy` → `url`.

| Поле | Env | Назначение | По умолчанию |
|---|---|---|---|
| `enabled` | `SYNTH_PROXY_ENABLED` | Явный выключатель. Не задан — прокси включается наличием URL (в т.ч. из стандартных env при `fromEnv`); явный `false` подавляет стандартные env | — (авто) |
| `mode` | — | `all` — `defaultProfile` для всех, кроме `noProxy` (правила переопределяют); `selected` — **только** правила, остальное напрямую | `all` |
| `defaultProfile` | — | Имя профиля для `mode: all` и правил без `profile`; при `mode: all` обязателен (иначе `default`, если он есть) | `default` (если есть) |
| `profiles.<name>` | — | Именованный профиль: `label`, `url` и/или `httpProxy`/`httpsProxy`/`allProxy`, `auth` (Basic), `tls` (к прокси). Имя — `^[a-z][a-z0-9_-]{0,31}$`, **неизменяемо** | — |
| `rules[]` | — | Правила: `{id?, label?, hosts[], action: proxy\|direct, profile?}`; `action: direct` запрещает `profile`; без `profile` — `defaultProfile` | `[]` |
| `url` | `SYNTH_PROXY_URL` | Общий прокси `http://`/`https://`/`socks5://`/`socks5h://` (userinfo в config.yaml/env допускается; при сохранении из UI пароль в URL **запрещён**). **Legacy**: без `profiles` — синтетический профиль `default` | — |
| `httpProxy` / `httpsProxy` | `SYNTH_PROXY_HTTP_PROXY` / `SYNTH_PROXY_HTTPS_PROXY` | Прокси для целей по схеме (`http`/`https`); приоритетнее `allProxy`/`url`. **Legacy**-поля (с `profiles` запрещены) | — |
| `allProxy` | `SYNTH_PROXY_ALL_PROXY` | Прокси для всех схем (если нет схемного). **Legacy** | — |
| `noProxy` | `SYNTH_PROXY_NO_PROXY` | Исключения (важнее правил): `host`, `.suffix` (apex + поддомены), `*.suffix` (только поддомены), `host:port`, IP, CIDR (по IP-литералу цели — DNS не резолвится), `*` | `[]` |
| `fromEnv` | — | Учитывать стандартные `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | `true` |
| `fallbackDirect` | `SYNTH_PROXY_FALLBACK_DIRECT` | Явный opt-in: при недоступном прокси идти напрямую (warn + `via:'fallback'`). Ошибки аутентификации (`407`) фоллбек **не** разрешают | `false` |
| `connectTimeoutMs` | `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | Таймаут соединения с прокси, мс | `10000` |
| `auth.type` | — | Только `basic`; `ntlm`/`negotiate` → ошибка/400 (**доменная аутентификация — egress-шлюз**, ADR-099 п. 25) | `basic` |
| `auth.username` | — | Пользователь Basic (альтернатива — userinfo в URL) | — |
| `auth`-пароль | `SYNTH_PROXY_PASSWORD` (профиль `default`), `SYNTH_PROXY_<NAME>_PASSWORD` (остальные) | Пароль Basic: **только** env или файл (`{dataDir}/secrets/proxy-password`, `{dataDir}/secrets/proxy/<name>.password`); в config.yaml/`settings.json` не хранится (инвариант 13); env приоритетнее файла и блокирует управление из UI (409) | — |
| `tls.caFile` / `tls.caPem` | `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | CA к **самому** https-прокси (взаимоисключающи), свой у каждого профиля | системное доверие |
| `tls.certFile` / `tls.keyFile` | `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | mTLS к https-прокси (задаются вместе) | — |
| `tls.rejectUnauthorized` | `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | Проверять сертификат прокси | `true` |

**Приоритет (ADR-023):** defaults ← `config.yaml proxy` ← **runtime-оверрайд (UI)** ← явные
`SYNTH_PROXY_*`; стандартные `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` применяются только при
`fromEnv` и если runtime/config не задали явный `enabled: false`. Слияние — поле-уровневое (UI
правит config-уровень, но **не переопределяет явный env деплоя**), **кроме** `profiles`/`rules`:
runtime-значение заменяет их **целиком** (частичного мержа списков нет). `noProxy`:
`SYNTH_PROXY_NO_PROXY` > runtime > непустой `proxy.noProxy` > `NO_PROXY`.

**Порядок разрешения маршрута:** `enabled:false` → direct; `noProxy` → direct (`no-proxy`); правила в
порядке объявления, **первое совпадение** (`rule`; `action: direct` → direct, `proxy` → профиль
`rule.profile ?? defaultProfile`); `mode: selected` → direct (`no-match`); `mode: all` → `defaultProfile`
(`default`). Тот же резолвер используют транспорт (`egressFetch`) и диагностика
(`POST /settings/proxy/test`) — расхождения «проверка показывает одно, трафик идёт иначе» нет.

**Паттерны `hosts`/`noProxy`:** `exact`; `.suffix` — apex **и** поддомены; `*.suffix` — только
поддомены (apex **не** матчится); `host:port`; IP-литерал; CIDR (только по IP-литералу цели, DNS для
правил/исключений не резолвится); `*`.

**Секреты профилей (инвариант 13).** Пароль `default` — `SYNTH_PROXY_PASSWORD` >
`{dataDir}/secrets/proxy-password` (legacy), остальных — `SYNTH_PROXY_<NAME>_PASSWORD` (имя в верхнем
регистре, `-` → `_`) > `{dataDir}/secrets/proxy/<name>.password`. Файлы `0600`, каталоги `0700`,
атомарная запись tmp→rename; значения **write-only** (не возвращаются, не логируются, не попадают в
аудит). TLS-материалы профиля, загруженные из UI, — `{dataDir}/secrets/proxy/<name>/{ca.pem,client.crt,
client.key}` (в конфиг пишутся только пути).

**Legacy-совместимость.** Без `profiles`/`rules` поведение прежнее: top-level `url`/`httpProxy`/
`httpsProxy`/`allProxy`/`auth`/`tls` = синтетический профиль `default`. При заданных `profiles`
top-level URL/auth/tls **запрещены** (fail-closed), env `SYNTH_PROXY_URL`/`HTTP_PROXY`/`HTTPS_PROXY`/
`ALL_PROXY` в режиме профилей не применяются (ошибка конфигурации/400). UI при сохранении конвертирует legacy-форму в
`profiles.default`, сохраняя схемные поля.

**Fail-closed.** Битый URL, неизвестная схема, `enabled=true` без URL, Basic без пароля,
`auth.type` ≠ `basic`, `proxy.tls` вместе с `socks5://`, `caFile`+`caPem` одновременно, `certFile` без
`keyFile`, неизвестный `defaultProfile`/`profile` правила, `action: direct` с `profile`, `mode: selected`
без правил, `mode: all` без default-профиля (в режиме `profiles`/`rules`), невалидное имя профиля — ошибка конфигурации
(`EGRESS_PROXY_CONFIG_INVALID`) на старте и 400 `VALIDATION_ERROR` при сохранении из UI. Недоступный
прокси → `EGRESS_PROXY_UNAVAILABLE` (тихого direct нет); `407`/SOCKS-отказ
→ `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED`.

**Адресная политика при прокси** (ADR-099 п. 18): для запросов через прокси проверяются только схема и
hostname-правила/`exceptions` (DNS/CIDR не выполняются — адрес резолвит прокси); для хостов из `noProxy`
проверка полная (DNS/CIDR каждого хопа). Фактический маршрут пишется в журнал egress (`via`:
`proxy`/`direct`/`fallback`); `POST /api/v2/settings/egress/check` отдаёт `proxied`/`addressChecksActive`.

#### Настройка из UI (раздел «Сеть» → «Прокси»)

- **Что редактируется:** `enabled`, `mode` (`all`/`selected`), `defaultProfile`, **профили**
  (`label`, URL-поля, `auth.username`, пути `tls.*`; имя профиля неизменяемо), **правила** (порядок =
  приоритет, первое совпадение; `action`/`profile`/`hosts`), `noProxy`, `fromEnv`, `fallbackDirect`,
  `connectTimeoutMs`. Сохраняется одна секция `proxy` в `RuntimeSettings.proxy`
  (`{dataDir}/settings.json`; при `storage.backend=postgres` — таблица `settings`, переносится
  `synth storage migrate`).
- **Профильные секреты (write-only):** пароль — `PUT/DELETE /settings/proxy/profiles/:name/password`
  (файл `{dataDir}/secrets/proxy/<name>.password`; для `default` — legacy `secrets/proxy-password`),
  CA/mTLS — `PUT/DELETE /settings/proxy/profiles/:name/tls/{ca,client}`
  (`secrets/proxy/<name>/{ca.pem,client.crt,client.key}`, `0600`). При env-пароле профиля
  (`SYNTH_PROXY_<NAME>_PASSWORD`) мутация → `409 CONFLICT`; PEM/ключи и пароли **не возвращаются**.
- **Применение:** при **следующем старте** (`restartRequired`), не live. `GET /settings/proxy` отдаёт
  `saved` (config ← runtime ← env), `running` (текущий dispatcher), `defaults`, `isOverridden`,
  `restartRequired`; `profiles`/`rules` в статусе — redacted (URL без userinfo, `username`, пути TLS,
  `hasCaPem`, `password:{source,set,removable}`); плоские поля ответа = `saved` (обратная совместимость). UI показывает плашку
  «изменения вступят после рестарта» со ссылкой на «Обслуживание → Перезапуск».
- **Проверки:** `POST /settings/proxy/check` — коннект **к прокси** (без `url` — по saved,
  `usingSaved:true`); `POST /settings/proxy/test {url}` — проверка **цели**: `HEAD` без редиректов и
  тела, адресная политика проверяется **до** запроса, ответ содержит `route` (`action`/`via`/`reason`/
  `ruleId`/`ruleLabel`/`profile`/`profileLabel`/`proxyUrl`), `ok`, `httpStatus`, `latencyMs`,
  `authChallenge`, `usingSaved`, `restartRequired`.
- **Аудит:** изменения (save/reset/password/tls профиля) пишутся в `{dataDir}/audit/security.jsonl` со
  `scope:'proxy'` (before/after без пароля, URL — redacted).

**RBAC:** чтение — `requireAuth`; сохранение/сброс, профильные секреты и проверки — `settingsWriteGuard`
(managed — `ADMIN`, core — `requireAuth`).

**Ограничения.** Доменная аутентификация прокси (NTLM/Negotiate/Kerberos) **в приложении не
реализуется** — делегируется промежуточному egress-прокси/шлюзу (ADR-099 п. 25, см. следующий
подраздел); `auth.type` ≠ `basic` → 400. `security.tls` к **цели** через SOCKS5 не применяется
(ограничение `Socks5ProxyAgent` — только системное доверие); SOCKS5/SOCKS5H — **best-effort**,
experimental, резолвят hostname на прокси, без target CA/mTLS, **не целевой для K8s** (там — HTTP
CONNECT). https-прокси/SOCKS по IP-литералу требуют DNS-хоста (SNI по IP запрещён в Node);
`proxy/check` при этом может показать `reachable`. Встроенный глобальный `fetch` не гарантирован
(npm-`setGlobalDispatcher` не влияет на него в Node 26; на Node 22 — перепроверка в CI) — покрыты пути
через `egressFetch`. Runtime-reload без рестарта — нет. PostgreSQL не проксируется (не HTTP). git
применяет `no_proxy` средствами libcurl, per-remote настройки нет; **per-host маршрут в git/stdio-MCP
не поддерживается** (один прокси через child-env; в `mode: selected` прокси-env им не ставится, чтобы
не обходить правила молча); `stdio`-MCP получает прокси-env без пароля.

#### Корпоративный прокси с Kerberos/NTLM (egress gateway)

Если корпоративный прокси требует доменную аутентификацию, между Synth и ним ставится промежуточный
**egress-прокси/шлюз** — для K8s это целевая схема:

```text
[Synth] → HTTP CONNECT (Basic/mTLS/без auth) → [Squid | px] → Kerberos/NTLM → [corporate proxy] → Internet
```

- **Synth** настраивает `proxy.url` на внутренний шлюз (например `http://egress-gw.synth.svc:3128`),
  `noProxy` — для `.svc`/кластера, опционально Basic/mTLS **до шлюза** (`proxy.auth` + `proxy.tls`).
  `auth.type: basic` относится только к участку Synth↔шлюз.
- **Squid (Kerberos):** upstream через `cache_peer`, аутентификация — `login=NEGOTIATE` с keytab:
  ```squid
  cache_peer corp-proxy.corp.local parent 3128 0 no-query default \
             login=NEGOTIATE:svc-synth@CORP.REALM connection-auth=on
  never_direct allow all
  ```
  Keytab — Secret (read-only) + `KRB5_KTNAME`; `krb5.conf` — ConfigMap; KDC доступен по NetworkPolicy
  (TCP/UDP 88, 464), NTP обязателен. Шлюз — **отдельный Deployment/namespace** (лучше, чем sidecar):
  keytab не попадает в pod приложения; HA/ротация/аудит — на шлюзе.
- **`px` (px-proxy):** если нужен **NTLM**/PAC или standalone-развёртывание (Docker/VM); Kerberos — через
  `kinit`/ccache либо конфигурацию `px` (`PX_PASSWORD` для NTLM).
- **Почему не в приложении:** `undici.ProxyAgent` не делает 407-challenge → нужен свой CONNECT-цикл;
  нативная зависимость (libkrb5/`kerberos`), keytab/KDC/время/cross-realm, PAC/WPAD; приёмка только с
  AD/KDC клиента; рост blast radius (keytab в pod) и поддержки multi-arch/образов. Оценка 4–8 недель +
  сопровождение (NTLM отдельно +1–2 недели). Детали — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)
  п. 25.
- **SOCKS5** — best-effort и не для K8s; если нужен target mTLS — используйте HTTP CONNECT (п. 26 ADR-099).

Пример (один прокси — legacy-форма, эквивалент `profiles.default`):

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

Пример (профили и правила — несколько прокси на разные направления):

```yaml
proxy:
  enabled: true
  mode: all                        # all | selected
  defaultProfile: default
  profiles:
    default:                       # корпоративный прокси для всего, кроме noProxy
      label: Corporate
      url: "http://proxy.corp.example:3128"
      auth: { type: basic, username: synth }
      tls: { caFile: "/etc/synth/tls/proxy-ca.pem", rejectUnauthorized: true }
    llm:                           # отдельный LLM-egress с mTLS
      label: LLM egress
      url: "https://llm-proxy.svc:8443"
      auth: { type: basic, username: synth-llm }
      tls:
        caFile: "/etc/synth/tls/llm-ca.pem"
        certFile: "/etc/synth/tls/llm-client.crt"
        keyFile: "/etc/synth/tls/llm-client.key"
  rules:                           # порядок = приоритет, первое совпадение
    - id: r_openai
      label: OpenAI
      hosts: ["api.openai.com", "*.openai.com"]
      action: proxy
      profile: llm
    - hosts: ["*.corp.example", "10.0.0.0/8"]   # CIDR — только по IP-литералу цели
      action: direct
  noProxy: ["localhost", ".svc"]   # важнее любых правил
```

Пароли профилей — только env/файл (в примере не показаны): `SYNTH_PROXY_PASSWORD` /
`{dataDir}/secrets/proxy-password` для `default`, `SYNTH_PROXY_LLM_PASSWORD` /
`{dataDir}/secrets/proxy/llm.password` для `llm`.

### Секреты at-rest (`security.secretKey`, ADR-076)

- `security.secretKey` — мастер-ключ для шифрования секретов в хранилище (SSH-ключи агентов; AES-256-GCM). Env — `SYNTH_SECRET_KEY`.
- **Приоритет**: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > файл `{dataDir}/secrets/master.key` (резолвер `resolveSecretKey`).
- **Форматы** ключа: base64 (ровно 32 байта) либо 64 hex-символа; иначе — ошибка `encryption_unavailable` (без молчаливого обрезания).
- **Fallback-файл**: если ключ не задан ни env, ни конфигом, core создаёт `{dataDir}/secrets/master.key` при первом запуске (`randomBytes(32)`, каталог `0700`, файл `0600`, атомарная запись). Секреты шифруются at-rest.
- **Ротация**: `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`) перешифровывает существующие SSH-ключи старым→новым ключом (preflight: нерасшифровываемое поле → abort, ничего не пишется), обновляет `master.key` и сбрасывает кэш; `--dry-run` показывает сводку без записи. Без `--yes` (и без `--dry-run`) — отказ. Если эффективный ключ задан через env/`config.security.secretKey`, файл перезаписывается, но при старте игнорируется — обновите ключ в env/config. Перед ротацией рекомендуются бэкап `$SYNTH_DATA_DIR` и остановка сервера.

### Секреты внешних доступов (OAuth, ADR-105)

Секреты внешних доступов (OAuth-коннекторы) **в `config.yaml` не хранятся** (инвариант 13) — только env или файлы в каталоге `secrets/`.

| Что | Где | Права |
|-----|-----|-------|
| `client_secret` OAuth-провайдера | env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` (например `provider=google` → `SYNTH_OAUTH_GOOGLE_CLIENT_SECRET`) **или** файл `{dataDir}/secrets/oauth/<provider>.client_secret` | файл `0600`, каталог `secrets/` — `0700` |
| access/refresh-токены доступов | `{dataDir}/secrets/oauth/credentials.json` (файловый backend; PostgreSQL — таблица `external_credentials`) | файл `0600`, атомарная запись tmp→rename (ADR-005) |

- **Приоритет `client_secret`**: env → файл → «секрета нет». Пустое значение env/файла считается отсутствием секрета — провайдеру пустой `client_secret` не уходит.
- В `config.yaml` у OAuth-провайдера хранятся только **данные**: `authorizeUrl`/`tokenUrl`/`revokeUrl`/`clientId`/`scopes`/`clientAuth`/`redirectUri`. Значение секрета ядро читает само и наружу (API/UI/логи, тексты ошибок) не отдаёт.
- Токены at-rest **зашифрованы** мастер-ключом (`enc:v1:…`, ADR-076) — plaintext на диске не появляется; наружу отдаются только метаданные с маской.
- **Бэкап**: каталог `secrets/` исключается из архива `synth backup` без `--with-secrets` — вместе с ним исключаются и токены доступов. Экспорт/импорт проекта (ADR-091) доступы не переносит: они инстанс-локальны.
- Устройство подсистемы — [EXTERNAL_ACCESS.md](./EXTERNAL_ACCESS.md); решение — [ADR-105](./arch_decisions/adr-105-external-credentials.md).

### Каталог OAuth-провайдеров (`oauth.providers`, ADR-105 Ф3)

Каталог описывает **данные** внешних OAuth-провайдеров инстанса: endpoint'ы, `client_id`, scope'ы.
По этому описанию ядро строит OAuth-клиент (обмен кода, refresh, отзыв) для записей слоя доступов.
Пустой каталог — штатное состояние: доступы, созданные кодом, работают, но **обновить** токен без описания
провайдера нечем (refresh вернёт понятную ошибку «провайдер не зарегистрирован»).

```yaml
oauth:
  providers:
    github:
      authorizeUrl: "https://github.com/login/oauth/authorize"
      tokenUrl: "https://github.com/login/oauth/access_token"
      revokeUrl: "https://api.github.com/applications/token"
      clientId: "synth-client"
      scopes: ["repo", "read:user"]
      clientAuth: "none"           # none (PKCE, публичный клиент) | client_secret_post | client_secret_basic
    google:
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth"
      tokenUrl: "https://oauth2.googleapis.com/token"
      clientId: "synth-client"
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
      clientAuth: "client_secret_post"
```

| Поле | Обязательно | Назначение |
|------|-------------|------------|
| `authorizeUrl` | да | endpoint выдачи кода (RFC 6749 §3.1) |
| `tokenUrl` | да | endpoint обмена кода и refresh (RFC 6749 §3.2/§6) |
| `revokeUrl` | нет | endpoint отзыва токена (RFC 7009) |
| `deviceAuthorizationUrl` | нет | endpoint device flow (RFC 8628 §3.1) |
| `clientId` | да | публичный `client_id` приложения (не секрет) |
| `scopes` | нет | scope'ы по умолчанию (дефолт `[]`) |
| `clientAuth` | нет | способ подтверждения клиента: `none` (PKCE, дефолт) / `client_secret_post` / `client_secret_basic` |
| `redirectUri` | нет | `redirect_uri` по умолчанию |

- **Env-оверрайд**: `SYNTH_OAUTH_PROVIDERS` — JSON-объект «имя → описание» (тот же формат). Провайдер из env **заменяет** одноимённого из `config.yaml`, остальные записи сохраняются. Невалидный JSON или набор, не прошедший валидацию, → предупреждение в журнале и **игнор**: кривой каталог не роняет старт инстанса (доступы просто не обновятся).
- **`client_secret` в каталоге нет** (инвариант 13) — только env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файл `{dataDir}/secrets/oauth/<provider>.client_secret`; см. раздел «Секреты внешних доступов (OAuth, ADR-105)» выше.
- Ключ карты совпадает с полем `provider` записи доступа; устройство подсистемы — [EXTERNAL_ACCESS.md](./EXTERNAL_ACCESS.md).

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
БД, ADR-097); K8s `Lease` — будущий шаг (ADR-051).

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

### Плагины (`plugins.*`, ADR-090)

Секция задаёт политику слоя плагинов (Extension API v1): доверие, скан, установку и бюджеты точек
расширения. Runtime-override этих ключей — `GET/PUT/DELETE /api/v2/settings/plugins`
([API_V2.md](./API_V2.md) §5.36); **изменения применяются после перезапуска** (инвариант 24) —
рантайм плагинов (хост, загрузчик, эффективный конфиг) собирается при старте.

> Значения по умолчанию сверяются с кодом автоматически (`packages/shared` — тест дефолтов
> `plugins.*`): расхождение с `packages/shared/src/config/defaults.ts` ломает сборку.

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `plugins.enabled` | Мастер-выключатель слоя плагинов | `true` |
| `plugins.executionEnabled` | **Исполнение кода плагинов.** `false` — активация останавливается на шаге `import` (`plugin.execution_disabled`); установка/снятие и скан работают | `false` |
| `plugins.runtimeInstall` | Установка во время работы (`allow`/`deny`); `deny` — только deploy-time | `deny` |
| `plugins.trustFloor` | Минимальное доверие для **установки и активации** (`builtin`/`verified`/`trusted`/`community`); ниже порога установщик **отказывает в установке** (`plugin.trust_below_floor`) | `trusted` |
| `plugins.scan` | Статический скан содержимого (`enabled`/`disabled`). `disabled` вместе с `executionEnabled: true` — **fail-closed** (`plugin.scan_disabled_with_execution`) | `enabled` |
| `plugins.allowlist`/`plugins.denylist` | Имена расширений, которым разрешён/запрещён запуск (пусто — политика не применяется) | `[]` |
| `plugins.remoteAllowlist` | Allow-list для hybrid-контура (Ф7) | `[]` |
| `plugins.exactHostExceptions` | Путь к файлу точных исключений семвер-гейта (`host`, одна версия в строке) | `''` |
| `plugins.promptBlockMaxChars` | Бюджет символов **на блок** системного промпта от плагина (превышение — обрезка с маркером, `status: 'truncated'`) | `4000` |
| `plugins.llmFilterTimeoutMs` | Бюджет времени на один вызов фильтра LLM-вызовов; по истечении — `failMode` фильтра | `1000` |
| `plugins.deployDir` | Каталог бандлов, поставленных **образом/развёртыванием** (каждый подкаталог — бандл с `synth.pack` + `dist/`). Ставится при старте инстанса (манифест → скан → trust-floor → install-policy), затем активируется из lock. Пусто — deploy-плагинов нет | `/opt/synth/plugins` |
| `plugins.deployTrust` | Уровень доверия deploy-бандлов (`builtin`/`verified`/`trusted`/`community`). Ниже `trustFloor` — штатный отказ `plugin.trust_below_floor`; скан содержимого выполняется всегда | `trusted` |
| `plugins.managedReadonly` | Management-плагин (`deployDir`, lock `source: 'deploy'`) **нельзя** снять или переустановить через API/CLI — `403 plugin.managed_readonly`. Меняется только новым образом/переразвёртыванием. Действует независимо от режима инстанса | `true` |
| `plugins.embeddingProvider` | Провайдер эмбеддингов для сервиса фасада `facade.embed` (ADR-090, WP-F). Пусто — эмбеддинги не сконфигурированы: `facade.embed` бросает `plugin.embedding_not_configured` (плагин сам решает, деградировать ли). Плагин может перекрыть провайдера/модель в вызове | `''` |
| `plugins.embeddingModel` | Модель эмбеддингов для `facade.embed`. Пусто — берётся дефолтная модель провайдера | `''` |
| `plugins.hybrid.mode` | Режим **серверной политики плагинов в гибридном режиме** (Ф7): `off` — сервер **не ограничивает** плагины; `allowlist` — разрешены только плагины из `plugins.hybrid.allow` (пустой список — не разрешён никто) | `off` |
| `plugins.hybrid.allow` | Имена плагинов, которым сервер разрешает работать (релевантно только при `mode: 'allowlist'`) | `[]` |

```yaml
plugins:
  executionEnabled: false   # включить после установки и проверки плагинов
  runtimeInstall: deny
  trustFloor: trusted
  promptBlockMaxChars: 4000
  llmFilterTimeoutMs: 1000
  # Managed deploy-time (Ф5в): бандлы из образа/PVC.
  deployDir: /opt/synth/plugins
  deployTrust: trusted
  managedReadonly: true
  # Ф7: серверная политика плагинов в гибридном режиме.
  hybrid:
    mode: off        # off (по умолчанию) | allowlist
    allow: []        # имена разрешённых плагинов (только при allowlist)
```

- **Живые ключи.** `promptBlockMaxChars` и `llmFilterTimeoutMs` применяются **без перезапуска**
  (первый — со следующего хода, второй — к последующим регистрациям фильтров); остальные ключи секции
  (`executionEnabled`, `trustFloor`, `scan`, `runtimeInstall`, allow/deny) вступают в силу **после
  перезапуска** инстанса (инвариант 24).
- **Где живут плагины**: `<home>/plugin/` (ADR-079) или `{dataDir}/plugin/` — `installed/<name>@<version>/`,
  `quarantine/` (ожидают подтверждения), `plugins.lock.json` (провенанс — источник истины для
  update/uninstall). Журнал — `{dataDir}/audit/plugins.jsonl`.
- **Bundle-only**: плагин — self-contained ESM-бандл (`dist/index.js`); npm-зависимости не
  резолвятся, `@itphx/*` — external (peer).
- **Порядок гейтов** (установка и активация): манифест → fail-closed (`scan=disabled` +
  `executionEnabled`) → trust-floor → скан → `runtimeInstall` → install-policy
  (`safe→allow`, `caution→ask` = карантин, `dangerous→block`).
- **Deploy-плагины (образ/PVC, Ф5в).** `deployDir` читается при старте: каждый подкаталог — бандл;
  битый манифест пропускается с предупреждением (старт не падает), совпадение версии и `content_hash`
  с lock — «skipped» (не переустанавливается). Скан и install-policy — **те же**, что у ручной
  установки (образ — доверенный источник кода, но не повод отключать проверку содержимого).
  `managedReadonly: true` запрещает снятие/`update` такого плагина через API/CLI: он меняется новым
  образом или переразвёртыванием каталога. Env-эквиваленты — `SYNTH_PLUGINS_DEPLOY_DIR`,
  `SYNTH_PLUGINS_DEPLOY_TRUST`, `SYNTH_PLUGINS_MANAGED_READONLY`.
- **Гибридная политика (Ф7).** `plugins.hybrid.mode`/`plugins.hybrid.allow` — серверная политика
  плагинов: локальный core в гибриде сверяется с ней **перед активацией** плагина (режим
  `allowlist` и плагина нет в списке → `403 plugin.hybrid_not_allowed`), а сервер отвергает
  server-scoped токен плагина, чей `plugin_id` вне списка (`403 PLUGIN_NOT_ALLOWED`). При
  `mode: 'off'` **сервер не ограничивает** плагины: проверка allow-list не применяется, но
  привязка заголовка `X-Synth-Plugin-Id` и scope `plugins:invoke` действуют всегда. Полный
  allow-list клиент берёт аутентифицированным запросом `GET /api/v2/settings/plugins` (блок
  `hybrid`); публичный сигнал режима — в `GET /auth/oidc-meta` (`plugins: {enabled, mode}`, без
  списка имён). Env-эквивалент режима — `SYNTH_PLUGINS_HYBRID_MODE`; список имён остаётся в
  `config.yaml`.
- **Модели эмбеддингов** (`plugins.embeddingProvider`/`plugins.embeddingModel`) — ими
  пользуется плагин памяти (индексы и recall) и микро-слой маршрутизации. Проверенные модели
  Ollama:

  | Модель | Размерность | Задержка | Объём | Рекомендация |
  |---|---|---|---|---|
  | `nomic-embed-text:latest` | 768 | ~0.1–2 с | 274 МБ | **По умолчанию** — быстро и компактно |
  | `nomic-embed-text-v2-moe:latest` | 768 | ~6 с (cold) | 958 МБ | Качество при **той же** размерности |
  | `qwen3-embedding:latest` | **4096** | 17–21 с | 4.7 ГБ | Только осознанно: объём векторов ×~5.3, нагрузка на хост |

  ```yaml
  plugins:
    embeddingProvider: ollama
    embeddingModel: nomic-embed-text:latest
  ```

  Env-эквиваленты — `SYNTH_PLUGINS_EMBEDDING_PROVIDER` / `SYNTH_PLUGINS_EMBEDDING_MODEL`
  (env выше конфига, ADR-023). Пустой провайдер — эмбеддинги не сконфигурированы
  (`plugin.embedding_not_configured`): индекс не строится, recall деградирует до keyword-поиска.

  **Egress.** Текст чанков уходит провайдеру эмбеддингов **без обфускации** (при индексании её
  нет, подробности — [MEMORY.md](./MEMORY.md) §10.1). Локальный Ollama не отправляет корпус
  наружу; внешний провайдер получает его целиком, а найденные фрагменты затем уходят в LLM.
  Индексируйте только те каталоги, которые не содержат чувствительного текста, и держите
  секреты вне рабочего каталога.

  Смена модели **помечает построенные индексы как `stale`** (в фингерпринте — фактическая
  модель `provider/model`): их нужно пересобрать (`synth memory rebuild <indexId>`). Подробности
  — [MEMORY.md](./MEMORY.md) §2.4.

### Аналитика и отчётность (`analytics.*`, ADR-102)

Секция задаёт только срок хранения **пред-агрегированных суточных роллапов**
аналитики (единица — сутки UTC). Отчёты и их параметры — [API_V2.md](./API_V2.md)
§5.32; пересборка роллапов из истории — [MAINTENANCE.md](./MAINTENANCE.md)
§«Аналитика: пересборка роллапов».

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `analytics.retentionDays` | Срок хранения роллапов (UTC-дни): бакеты со `day` раньше `utcDay(now − retentionDays)` удаляются прунером; `<= 0` — хранение без ограничения. Env — `SYNTH_ANALYTICS_RETENTION_DAYS` | `400` |

```yaml
analytics:
  retentionDays: 400
```

- **Запись — best-effort и не влияет на ход.** Роллапы инкрементируются на уже
  существующих швах (сохранение ответа, жизненный цикл сессии/инструментов через
  hook-шину, decision-каскад); ошибки порта логируются и не пробрасываются, ход
  агента не блокируется. В деградированном режиме хранилища (ADR-098) запись
  выключена.
- **Хранилище** — доменный порт `AnalyticsRollupRepository` (ADR-096): файловый
  backend — `{dataDir}/analytics/rollups.json` (ADR-005, атомарная запись),
  PostgreSQL — таблица `analytics_rollups` (миграция 003 драйвера).
- **Retention.** Прунер запускается сразу при старте и далее каждые 6 часов
  (таймер `unref`); ошибки очистки логируются и не роняют процесс.
- **Приватность.** Роллапы агрегированы: текста сообщений, содержимого промптов,
  ключей и PII в значениях нет; дериваты (`cache_hit_rate`, `output_tps`, …)
  не персистятся, а считаются на чтении.

### Вопросы пользователю (`questions.*`, этап 1 roadmap 0.13 — блок 3)

Секция задаёт поведение подсистемы «вопрос пользователю» (тул `question`): агент
задаёт вопрос с вариантами ответа, ход **ждёт** ответа пользователя. Ответ
приходит по `id` вопроса (`POST /api/v2/sessions/:id/questions/:qid/answer`).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `questions.timeoutMs` | Срок ожидания ответа, мс. `0` — **без таймаута** (по умолчанию): вопрос ждёт, пока ответят или его отменят (конец хода, «Стоп», ручная отмена). Тул `question` может задать срок для конкретного вопроса (`timeout`, ≥ 5 минут — не рекомендуется: ожидание обрывается). По истечении срока вопрос снимается с причиной `timeout`. Env — `SYNTH_QUESTIONS_TIMEOUT_MS` | `0` (без таймаута) |
| `questions.retentionDays` | Срок хранения терминальных записей вопросов (`answered`/`cancelled`), дни; `<= 0` — без ограничения. Env — `SYNTH_QUESTIONS_RETENTION_DAYS` | `14` |

```yaml
questions:
  timeoutMs: 0
  retentionDays: 14
```

- **Хранение** — доменный порт `QuestionRepository` (ADR-096): файловый backend —
  `{dataDir}/questions.json` (ADR-005, атомарная запись), PostgreSQL — таблица
  `questions` (миграция 021 драйвера).
- **Ожидание ответа — в памяти процесса.** Поэтому при старте все открытые
  вопросы снимаются с причиной `interrupted` (ожидание не пережило рестарт) —
  иначе вопрос «завис» бы навсегда.
- **Таймеры** — `unref` (не держат процесс); retention-очистка запускается сразу
  при старте и далее каждые 6 часов, ошибки логируются и не роняют процесс.
- **События** — `user_question.asked` / `user_question.answered` /
  `user_question.cancelled` в канале сессии (ADR-009/ADR-024, новых каналов нет).

### Фоновые прогоны (background.*, этап 1 roadmap 0.13 — блок 4)

Секция задаёт поведение единого реестра фоновой работы: фоновые **саб-агенты**
(`task({background: true})`, PROP-096/ADR-111) и фоновые **шелл-процессы**
(`execute_shell({background: true})`, ADR-113) живут в **одном** реестре —
второго хранилища нет. Лимиты считаются по сессии-владельцу (для саб-агента —
родительская сессия).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `background.enabled` | Мастер-выключатель фоновой работы. `false` — и `task({background: true})`, и `execute_shell({background: true})` отвечают ошибкой (`task.background_disabled` / `process.background_disabled`; ход не падает), а foreground-работа и реестр продолжают работать. Env — `SYNTH_BACKGROUND_ENABLED` | `true` |
| `background.maxSubagentsPerSession` | Максимум одновременно идущих фоновых саб-агентов на сессию-владельца; превышение → `background_limit_exceeded` (ошибка тула, ход не падает). Env — `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | `2` |
| `background.maxProcessesPerSession` | Максимум одновременно идущих фоновых шелл-процессов на сессию-владельца; превышение → `background_limit_exceeded`. Env — `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | `5` |
| `background.maxRunsPerSession` | Максимум записей реестра на сессию-владельца (считаются все записи, чистятся retention-ом). Env — `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | `10` |
| `background.logMaxBytes` | Предел размера лога фонового процесса, байт; `0` — без ограничения. Не путать с потолком выдачи лога за один HTTP-запрос (256 КиБ) — это разные величины. Env — `SYNTH_BACKGROUND_LOG_MAX_BYTES` | `10485760` (10 МиБ) |
| `background.retentionDays` | Срок хранения терминальных записей реестра (`completed`/`failed`/`cancelled`/`orphaned`), дни; `<= 0` — без ограничения. Env — `SYNTH_BACKGROUND_RETENTION_DAYS` | `7` |

```yaml
background:
  enabled: true
  maxSubagentsPerSession: 2
  maxProcessesPerSession: 5
  maxRunsPerSession: 10
  logMaxBytes: 10485760
  retentionDays: 7
```

- **Хранение реестра** — доменный порт `BackgroundRunRepository` (ADR-096):
  файловый backend — `{dataDir}/processes/registry.json` (ADR-005, атомарная
  запись), PostgreSQL — таблица `background_runs` (миграция
  `021_background_runs` драйвера). Логи фоновых процессов — blob-хранилище
  (`BlobStore`), путь `processes/<id>.log`.
- **Рестарт не возобновляет фоновые прогоны.** «Живые» хэндлы отмены живут в
  памяти процесса, поэтому при старте все записи `running` переводятся в
  `orphaned` с пометкой «interrupted by restart»: запись остаётся в реестре
  (честно показывает незавершённость), но прогона уже нет.
- **Таймеры** — `unref` (не держат процесс); retention-очистка запускается
  сразу при старте и далее каждые 6 часов, ошибки логируются и не роняют
  процесс. Чистятся **только** терминальные записи.
- **Глубина вложенности — 1**: саб-агент не может породить фонового
  саб-агента.
- **Фоновые процессы в `remote`-режиме идут через исполнителя** (протокол
  v3, `features.background`): процесс живёт на исполнителе, control plane
  наблюдает его опросом (журнал — 300 мс, состояние — 500 мс), поэтому лог
  дублируется (на исполнителе до `prune` и в control plane через `BlobStore`).
  Исполнитель **старой версии** (протокол < 3, фоновых маршрутов не знает) →
  `background_unsupported`: адрес без `features.background` в кандидаты на
  фоновый запуск не попадает, а пул без таких адресов даёт отказ `EBACKGROUND`.
  Для фоновых саб-агентов ограничение не действует.
- **События** — `process.started` / `process.stopped` / `process.exited` /
  `child.completed` / `child.failed` / `child.cancelled` в канале
  сессии-владельца (ADR-009/ADR-024, новых каналов нет). `process.stopped` —
  запрос остановки (один раз на прогон); терминальный статус приходит позже —
  `process.exited`.

### Вложения сообщений (`attachments.*`, ADR-115)

Лимиты и политика вложений (мультимодальный ввод — [ADR-115](./arch_decisions/adr-115-multimodal-input.md),
контракт API — [API_V2.md](./API_V2.md) §5.6.1). Байты **не** пишутся в БД: они лежат на томе в
`{dataDir}/blobs` (вложения — content-addressed), в базе — только учёт ссылок `blob_refs`
([ADR-116](./arch_decisions/adr-116-instance-state-and-blob-ports.md)).

В blob хранятся **оригинальные** байты (EXIF/метаданные при загрузке не теряются): очистка
`stripMetadata` применяется только на границе отправки провайдеру (гидратация вложений, aux-вызов),
поэтому скачивание через API отдаёт оригинал. Staging-загрузка без сессии
(`POST /api/v2/attachments`) использует те же лимиты; объект без ссылок живёт `attachments.gcDays`.

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `attachments.enabled` | Мастер-выключатель вложений: `false` — загрузка запрещена (`415 attachments_disabled`), ссылки `attachments` в промпте отклоняются. Env — `SYNTH_ATTACHMENTS_ENABLED` | `true` |
| `attachments.modalities` | Семейства MIME, включаемые по отдельности: `image`/`pdf`/`audio`/`video`; выключенное семейство → `415 UNSUPPORTED_MEDIA_TYPE` (и на загрузке, и при постановке промпта). Env — `SYNTH_ATTACHMENTS_MODALITIES` (csv **включённых**, напр. `image,pdf`; отсутствующие выключаются) | все `true` |
| `attachments.maxBytesPerFile` | Предел размера одного файла, байт; превышение → `413 PAYLOAD_TOO_LARGE`. Env — `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE` | `26214400` (25 МиБ) |
| `attachments.maxFilesPerMessage` | Предел числа вложений в одном сообщении (проверяется при постановке промпта); превышение → `400 VALIDATION_ERROR`. Env — `SYNTH_ATTACHMENTS_MAX_FILES_PER_MESSAGE` | `10` |
| `attachments.maxBytesPerSession` | Предел суммарного объёма вложений сессии (по частям в истории сообщений); превышение при промпте → `413 PAYLOAD_TOO_LARGE`. Env — `SYNTH_ATTACHMENTS_MAX_BYTES_PER_SESSION` | `1073741824` (1 ГиБ) |
| `attachments.allowedMimePrefixes` | Белый список MIME-**префиксов**; пустой список — разрешены все. `image/svg+xml` запрещён всегда (XSS). **Только `config.yaml`** (список не имеет плоского env-представления). | `["image/", "audio/", "application/pdf", "text/"]` |
| `attachments.workspaceFallback` | Резервное хранение вложений в workspace проекта, когда blob-хранилище недоступно. Env — `SYNTH_ATTACHMENTS_WORKSPACE_FALLBACK`. **Пока только настройка**: применение в оркестраторе — отдельная задача | `true` |
| `attachments.modalityModels` | Модели **обработки** по семействам вложений (aux-модели, ADR-115): `image`/`pdf`/`audio`/`video` → `{provider, model}`. Если модель сессии модальность не принимает, вложение обрабатывает указанная модель, а в диалог попадает текстовый результат. **Только `config.yaml`** (env нет) | `{}` (не настроено) |
| `attachments.gcDays` | Срок хранения **осиротевших** объектов (нет ссылок в `blob_refs`), дни; `0` — без ограничения (объекты не чистятся по сроку). Env — `SYNTH_ATTACHMENTS_GC_DAYS` | `30` |

```yaml
attachments:
  enabled: true
  modalities: { image: true, pdf: true, audio: true, video: true }
  maxBytesPerFile: 26214400
  maxFilesPerMessage: 10
  maxBytesPerSession: 1073741824
  # Список — только в config.yaml; пустой список = все префиксы разрешены.
  allowedMimePrefixes: ["image/", "audio/", "application/pdf", "text/"]
  workspaceFallback: true
  # ADR-115: aux-модели по семействам (provider/model из каталога моделей).
  # Записи нет — обработка не настроена (вложение отбрасывается с путём).
  modalityModels:
    image: { provider: openai, model: gpt-4o }
    audio: { provider: local, model: whisper }
  gcDays: 30
```

- **Приоритет источников.** `SYNTH_ATTACHMENTS_*` (env) > runtime (UI, `settings.json`/PG) >
  `config.yaml` `attachments` > defaults схемы. Поля, заданные env, фиксируются (`envLocked`) и
  runtime их не перекрывает: попытка задать другое значение через UI → `409 CONFLICT`.
- **Runtime-настройки (ADR-115).** Админ-раздел «Вложения» (API —
  `GET/PUT/DELETE /api/v2/settings/attachments`, [API_V2.md](./API_V2.md) §5.21) меняет
  `enabled`/`modalities`/лимиты/`workspaceFallback`/`modalityModels`/`gcDays` **без рестарта**: сервис вложений,
  постановка промпта и GC читают резолвер на каждый вызов (`restartRequired: false`).
  Изменения пишутся в аудит политик (`scope: "attachments"`).
- **Модели обработки по модальностям (`attachments.modalityModels`, ADR-115).** Модель сессии
  **не меняется**: aux-модель получает только вложение (описание/извлечённый текст), а диалог
  продолжается на модели сессии. Приоритет — **нативный путь**: если модель сессии принимает
  модальность (`ModelConfig.modalities`), вложение уходит ей как есть, а aux-модель не вызывается.
  Нет записи для семейства — обработка не настроена, и вложение, которое модель сессии не принимает,
  отбрасывается с путём в workspace (текущее поведение). `auto`-значений нет — нативная поддержка
  определяется по модальностям модели. Настройка проверяется по каталогу: провайдер и модель должны
  существовать, а модель — заявлять нужную модальность (иначе `PUT /settings/attachments` → `400`).
  Env-оверрайдов нет (слишком дробно) — только `config.yaml` и runtime (UI/API).
- **Обработка медиа: форматы и `ffmpeg` (ADR-115, этап 2).** Когда модель сессии модальность не
  принимает и для семейства назначена модель обработки, вложение обрабатывается ею, а в диалог
  попадает **текст** (описание/транскрипт/извлечённый текст); модель сессии не меняется.
  Что уходит модели обработки:
  - `image` — файл как есть; `pdf` — файл как есть (извлечение текста с сохранением структуры);
  - `audio` — `wav` и `mp3` как есть; другие контейнеры (`ogg`/`m4a`/`flac`/`opus`/…)
    транскодируются в `wav` 16 кГц mono;
  - `video` — **только кадры** (до 5 JPEG, равномерно по длительности): видеофайл целиком
    провайдеру не отправляется.

  Транскод аудио и извлечение кадров видео выполняет **внешний `ffmpeg`** — не npm-зависимость, а
  программа окружения. Базовые образы Synth её **не содержат**: для обработки аудио (кроме wav/mp3) и
  видео `ffmpeg` нужно установить в образе/на хосте (в split-режиме — в образе исполнителя, потому что
  проба идёт через порт исполнения, ADR-077). Доступность проверяется через тот же порт, результат
  кэшируется на 60 с; **нет `ffmpeg`** → транскод и кадры не выполняются, вложение отбрасывается
  обычным путём (материализация в workspace + блок `[ATTACHMENTS NOT DELIVERED]`), `wav`/`mp3` при
  этом обрабатываются без него.
  `ffprobe` не требуется: длительность берётся из метаданных части (нет метаданных — кадры берутся
  с частотой 1 кадр/с, не более пяти). Результат обработки кэшируется в blob (`attachments/.derived/`,
  ключ — `sha256(blobPath|provider/model|family)`), поэтому повторная отправка того же файла в ту же
  модель обработки не тратит вызов.
- **Env — скаляры + `modalities`.** В реестре env-оверрайдов (ADR-023) два boolean
  (`SYNTH_ATTACHMENTS_ENABLED`/`SYNTH_ATTACHMENTS_WORKSPACE_FALLBACK`), четыре числовых ключа и
  csv `SYNTH_ATTACHMENTS_MODALITIES`; список префиксов (`allowedMimePrefixes`) — только `config.yaml`.
- **Где применяется.** `enabled` и `modalities` — при загрузке
  (`POST /sessions/:id/attachments`, staging `POST /api/v2/attachments`) и при постановке сообщения;
  `maxBytesPerFile` и белый
  список — при загрузке; `maxFilesPerMessage`, `maxBytesPerSession` — при постановке сообщения
  (`POST /sessions/:id/prompt`); `gcDays` — фоновый pruner (сразу при старте и далее каждые
  6 часов, `unref`-таймер). Все значения читаются через live-резолвер на каждый вызов.
- **GC не удаляет живые объекты.** Критерий — `countRefs(blobPath) === 0` **и** объект старше
  `gcDays`; ссылки снимаются при удалении сообщения/сессии, поэтому общий (дедуплицированный) объект
  переживает удаление одного из сообщений. Sidecar-метаданные (`<sha256>.json`) удаляются вместе с
  объектом.
- Бэкап и перенос: байты входят в файловый периметр (`synth backup` их включает), но
  `synth storage migrate` их **не** переносит — см. [MAINTENANCE.md](./MAINTENANCE.md).

### Наблюдаемость (`metrics.*`, ADR-094)

Экспорт Prometheus-метрик и разделение liveness/readiness. Полный каталог метрик, скрейп, алерты и
диагностика — [OBSERVABILITY.md](./OBSERVABILITY.md); основание — [ADR-094](./arch_decisions/adr-094-observability-metrics.md).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `metrics.enabled` | Включает `GET /metrics` (тот же порт, вне `/api/v2`) и сбор HTTP/процессных/доменных метрик. `false` — эндпоинта нет (404), ничего не собирается. Env — `SYNTH_METRICS_ENABLED` | `false` |

**Runtime-override.** `metrics.enabled` можно переключить в UI: Настройки → Администрирование →
**«Метрики»** (runtime в `settings.json`/PG, API — `GET/PUT/DELETE /api/v2/settings/metrics`).
Приоритет: `SYNTH_METRICS_ENABLED` > runtime (UI) > `config.yaml` > default `false`; при env-значении
тумблер заблокирован (источник `env`). Middleware и коллекторы создаются при старте процесса, поэтому
изменение применяется **после перезапуска**: API/UI отдают `restartRequired = effective !== running`.
Токен применяется сразу (читается на каждый запрос).

Bearer-токен в `config.yaml` **не хранится** (инвариант 13): env `SYNTH_METRICS_TOKEN` (приоритет) либо
файл `{dataDir}/secrets/metrics-token` (создаётся вручную или из UI write-only, права `0600`). При
заданном токене `/metrics` отвечает 401 без `Authorization: Bearer …`; сравнение constant-time,
значение не логируется. Если токен задан через env, UI-операции записи/удаления → 409 `CONFLICT`.

```yaml
metrics:
  enabled: true
```

```bash
# файл токена (opt-in; в кластере обычно достаточно сети/NetworkPolicy)
install -m 600 /dev/null "$SYNTH_DATA_DIR/secrets/metrics-token"
openssl rand -hex 32 > "$SYNTH_DATA_DIR/secrets/metrics-token"
```

- `GET /health`/`/api/v2/health` — liveness; `GET /ready` — readiness (`200`; `503` только на
  старте/fail-closed). Деградация хранилища **не** снимает readiness (ADR-098) — она видна в
  `synth_storage_degraded` и алерте `StorageDegraded`.
- `/metrics` не публикуется через UI-nginx; в Helm — `metrics.enabled`, аннотации `prometheus.io/*`
  или `ServiceMonitor`, дашборды `grafana.dashboards`, правила `alerts` ([charts/synth/README.md](../charts/synth/README.md)
  §«Наблюдаемость»). Dev-стенд — `docker-compose.observability.yml` ([deploy/observability/README.md](../deploy/observability/README.md)).

### Полномочия (authority) (`authority.*`, ADR-106)

Authority-слой — единая ось полномочий пользователей и агентов (в дополнение к ролям инстанса, ролям участника проекта, capability агента и правилам permission-конфига). Устройство подсистемы — [AUTHORITY.md](./AUTHORITY.md); решение — [ADR-106](./arch_decisions/adr-106-authority-layer.md).

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `authority.enabled` | Мастер-выключатель слоя: `false` — ни решений, ни записей (поведение прав прежнее). Env — `SYNTH_AUTHORITY_ENABLED` | `false` |
| `authority.shadow` | Режим наблюдения: `true` — решение считается и пишется в журнал, но **не применяется**; `false` — решение применяется (enforced). Env — `SYNTH_AUTHORITY_SHADOW` | `true` |

Три режима:

| Режим | Что происходит |
|-------|----------------|
| **выключено** (`enabled: false`) | Слой не считает решения и не пишет их в журнал; права определяет только permission-слой (ADR-025/ADR-029) |
| **наблюдение / shadow** (`enabled: true`, `shadow: true`) | Решение Authority считается и пишется в журнал (`{dataDir}/audit/authority.jsonl`), но **не применяется** — права не меняются. Режим миграции: расхождение shadow-решения с текущим — дефект миграции |
| **принуждение / enforced** (`enabled: true`, `shadow: false`) | Решение применяется в permission-слое: `deny` слоя → `deny`, `ask` слоя → `ask` (требование потолка `yolo` не снимает); `allow` слоя ничего не разрешает сверх решения permission-слоя; тул без маппинга → `deny('unknown')`. Ошибка слоя не ломает ход — решение permission-слоя остаётся в силе |

```yaml
authority:
  enabled: false
  shadow: true
```

```bash
# включить слой в режиме наблюдения (решения считаются, права не меняются)
SYNTH_AUTHORITY_ENABLED=true SYNTH_AUTHORITY_SHADOW=true
```

- Секция — `authorityConfigSchema` (`packages/shared/src/config/types.ts`), дефолты — `config/defaults.ts`; env-оверрайды — по общему правилу `SYNTH_<SECTION>_<KEY>` (реестр `ENV_OVERRIDES`).
- Runtime-настроек (UI) у секции нет: раздел «Полномочия» — остаток ADR-106 (Ф5).
- Принуждение подключается **в permission-слое** (`PermissionEvaluator`), а не в тулах и не в обработчиках; журнал решений и метрика `synth_authority_decisions_total{action,effect,source}` — в [OBSERVABILITY.md](./OBSERVABILITY.md).

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
