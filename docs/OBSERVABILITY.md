# Synth — наблюдаемость: метрики, готовность, алерты

> **Класс документа:** Runbook + контракт ([ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1).
> Основание — [ADR-094](./arch_decisions/adr-094-observability-metrics.md). Конфигурация — [CONFIGURATION.md](./CONFIGURATION.md)
> §«Наблюдаемость», HTTP-спека — [API_V2.md](./API_V2.md) §5.1, эксплуатация — [MAINTENANCE.md](./MAINTENANCE.md).
> Устройство LLM-аудита — [ADR-036](./arch_decisions/adr-036-llm-gateway.md); хранилище и деградация —
> [ADR-096](./arch_decisions/adr-096-storage-layer.md)/[ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md).

## Назначение

Контур наблюдаемости Synth — минимально достаточный, без внешних зависимостей:

- **`GET /metrics`** — снимок в текстовом формате Prometheus (exposition 0.0.4). Свой мини-реестр
  (`counter`/`gauge`/`histogram`) внутри core; история и ретенция — ответственность Prometheus.
- **`GET /ready`** — readiness, отделённый от liveness `GET /health`.
- **Поставка** — правила алертов, дашборды Grafana, dev-стенд Prometheus + Grafana.

Что **не** входит (остаток ADR-094): JSON-логи с `request_id`/`session_id`, OpenTelemetry-трейсинг,
хранение истории метрик, доставка алертов (Alertmanager) и SLO-страница (портал).

Метрики отвечают на вопросы: латентность и ошибки HTTP, глубина очереди и активные ходы, LLM по
провайдерам/моделям (ошибки, токены, стоимость), рост `{dataDir}`, деградация хранилища, поток
внешних событий, дрейф шедулера, доставки webhooks, состояние гибрида.

## Включение

`/metrics` **выключен по умолчанию** (`metrics.enabled=false`) — эндпоинта «нет», пока его не включили.

| Способ | Как включить | Применение |
|---|---|---|
| UI | Настройки → Администрирование → **«Метрики»**, тумблер `enabled` (runtime, `settings.json`/PG) | **после перезапуска** |
| `config.yaml` | `metrics.enabled: true` | при старте |
| env | `SYNTH_METRICS_ENABLED=true` | при старте |
| Helm | `--set metrics.enabled=true` | при старте |
| dev (`./scripts/dev.sh`) | `SYNTH_METRICS_ENABLED=true ./scripts/dev.sh` | при старте |

Приоритет: `SYNTH_METRICS_ENABLED` > runtime (UI/`settings.json`) > `config.yaml` > default `false`.
Если действует env-значение, тумблер в UI заблокирован (источник `env`). Изменение `enabled`
пересоздаёт middleware/коллекторы только при старте процесса, поэтому `restartRequired =
effective !== running`: раздел показывает баннер и кнопку перезапуска (тот же graceful restart,
ADR-092). Токен применяется сразу — `/metrics` читает env/файл на каждый запрос.

Поведение эндпоинта:

| Состояние | Ответ |
|---|---|
| `enabled=false` | `404 NOT_FOUND` (эндпоинта нет — не 401: выключенные метрики не должны выглядеть проблемой авторизации) |
| `enabled=true`, токен не задан | `200`, `Content-Type: text/plain; version=0.0.4; charset=utf-8` |
| `enabled=true`, задан токен, заголовка нет/неверный | `401 UNAUTHORIZED` + `WWW-Authenticate: Bearer` |
| `enabled=true`, токен верный | `200`, тот же `Content-Type` |

Ответ всегда с `Cache-Control: no-store`. `/metrics` отдаётся на том же порту, что API
(backend — `SYNTH_PORT`, дефолт 5000; standalone — `SYNTH_CORE_PORT`/4300), **вне** префикса
`/api/v2`, и **не публикуется** через UI-nginx (SPA-раздача в standalone его также не перехватывает —
путь исключён в `server/app/http-server.ts`).

### Токен

Bearer-токен в `config.yaml` **не хранится** (инвариант 13). Источники:

1. env `SYNTH_METRICS_TOKEN` (приоритет);
2. файл `{dataDir}/secrets/metrics-token` (**автоматически не создаётся** — вручную или из UI «Метрики»; права `0600`).

Сравнение — `timingSafeEqual` (сначала длины). Токен не логируется. В кластере обычно не нужен:
доступ ограничен сетью pod'а и NetworkPolicy/Ingress; токен — opt-in для недоверенной сети.

```bash
# файл токена
install -m 600 /dev/null "$SYNTH_DATA_DIR/secrets/metrics-token"
openssl rand -hex 32 > "$SYNTH_DATA_DIR/secrets/metrics-token"
curl -s -H "Authorization: Bearer $(cat "$SYNTH_DATA_DIR/secrets/metrics-token")" \
  localhost:4300/metrics | head
```

### Раздел «Метрики» в UI

Настройки → **Администрирование → «Метрики»** (EN «Metrics», только ADMIN; в core — любой
аутентифицированный). Компонент `ObservabilitySettings`, API-домен `observabilityApi`.

- **Статус** (обновляется каждые 15 с): источник и эффективное значение `enabled`, `running`,
  `/ready` (200/503), `storage` (`ok`/`degraded`), backend хранилища, версия, uptime, объём
  exposition (`series`, `bytes`, `droppedSeries`).
- **Тумблер `enabled`** — runtime-override. При `restartRequired` — баннер и кнопка
  «Перезапустить инстанс»; при источнике `env` тумблер заблокирован.
- **Токен** — статус (`env`/файл/нет), задать/удалить (write-only, ≥16 символов, файл
  `{dataDir}/secrets/metrics-token`, `0600`); применяется без рестарта. Если токен задан через
  `SYNTH_METRICS_TOKEN`, операции возвращают **409 `CONFLICT`**.
- **Подсказки**: копирование URL `/metrics`, пример `scrape_config`, ссылки на runbook и портал.

### Управление из API

Мутации — ADMIN (managed) / `requireAuth` (core); контракт — [API_V2.md](./API_V2.md) §5.21.

| Метод/путь | Назначение |
|---|---|
| `GET /api/v2/settings/metrics` | `{metrics:{enabled}, defaults, isOverridden, source, running, restartRequired, token:{configured,source}, endpoints}` |
| `PUT /api/v2/settings/metrics` | `{metrics:{enabled:boolean}}` — runtime-override (400 на не-boolean) |
| `DELETE /api/v2/settings/metrics` | Сброс runtime к env/config/default |
| `GET /api/v2/settings/metrics/status` | Live-снимок: `ready`, `storage`, `storageBackend`, `version`, `uptimeSec`, `exposition:{series,bytes,droppedSeries}`, `token`, `endpoints` |
| `PUT /api/v2/settings/metrics/token` | `{token}` (≥16, write-only) → файл `0600`, применяется сразу; env-токен → 409 |
| `DELETE /api/v2/settings/metrics/token` | Удалить файл токена (идемпотентно); env-токен → 409 |

## `/health` vs `/ready`

| Эндпоинт | Смысл | Коды |
|---|---|---|
| `GET /health`, `GET /api/v2/health` | **Liveness**: процесс жив и отвечает | всегда `200`; в деградации — `status:'degraded'` + блок `storage` (аддитивно) |
| `GET /ready` | **Readiness**: приложение инициализировано (storage context собран, миграции применены, очередь готова) | `200` — готов; `503` — **только** старт не завершён или fail-closed |

Ключевое правило: **деградированное хранилище не снимает readiness**. Read-only-инстанс
(ADR-098) продолжает обслуживать трафик и остаётся доступным ADMIN для диагностики; вывод pod'а из
балансировки лишил бы оператора единственного пути к восстановлению. Деградация сигнализируется
метрикой `synth_storage_degraded=1` и алертом `StorageDegraded`, а не пробой.

Тело `/ready`:

```json
{
  "status": "ready",
  "storage": "ok",
  "version": "0.x.y",
  "startedAt": "2026-10-19T10:00:00.000Z",
  "time": "2026-10-19T10:05:00.000Z"
}
```

При неготовности — `503` и `"status": "not_ready"`; причина может быть детализирована в
необязательном `checks` (например `{"migrations":"pending"}`). `storage` — `ok` | `degraded`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:5000/ready     # 200 — готов, 503 — нет
curl -s localhost:5000/ready | jq .                               # status/storage/version/startedAt
curl -s localhost:5000/health | jq '{status, storage, version, startedAt}'
```

Probes Helm: liveness — `/health` (или `/ready` с большим `failureThreshold`), readiness — `/ready`.
`startedAt` (ISO) — метка старта процесса, по ней UI отличает рестарт.

## Каталог метрик

Префикс `synth_` **фиксирован** — имена метрик являются контрактом дашбордов и алертов
(настраиваемый префикс ломал бы их). Лейблы — только контрактные (см. «Кардинальность»).

### HTTP

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_http_requests_total` | counter | `method`, `route`, `status` | Число запросов; `route` — шаблон (`/api/v2/sessions/:id`), неизвестный → `other`; на каждый ответ |
| `synth_http_request_duration_seconds` | histogram | `method`, `route` | Длительность обычных запросов (корзины 0.005…10 с); SSE/WS **не** входят |
| `synth_http_in_flight` | gauge | — | Запросы в обработке сейчас |
| `synth_http_streams_active` | gauge | — | Активные долгоживущие потоки (SSE `/api/v2/events`, `/ws/*`); снимается по завершении/отмене чтения |

Скрейп самого `/metrics` в HTTP-метриках не учитывается.

### Процесс / Node

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_build_info` | gauge | `version`, `node` | Версия Synth и Node, значение всегда `1`; на старте |
| `synth_process_resident_memory_bytes` | gauge | — | RSS |
| `synth_process_heap_used_bytes` | gauge | — | Heap used |
| `synth_process_cpu_seconds_total` | counter | — | Суммарное CPU (user+system) |
| `synth_node_eventloop_lag_seconds` | gauge | — | Средний event loop lag (`monitorEventLoopDelay`) |
| `synth_process_uptime_seconds` | gauge | — | Uptime процесса |

Все — снимаются коллектором перед каждым рендером (актуальны на скрейпе).

### Сессии, очередь, ходы

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_sessions_active` | gauge | — | Неархивные сессии; фон, **15 с** |
| `synth_queue_pending` | gauge | — | Сумма `pendingMessages` по сессиям; фон, **15 с** |
| `synth_turns_total` | counter | `outcome` (`ok`/`error`/`cancelled`) | Терминальные исходы хода (`stream.done`/`stream.error`/`stream.cancelled`), по одному на стрим |
| `synth_active_streams` | gauge | — | Ходы, стримящие сейчас (по событиям шины) |

### LLM

Единственная точка — `GatewayProvider.onCall` (или `createLlmCallRecorder` из реестра); метрики
покрывают и chat, и `decide()`. Ошибки метрик не влияют на вызов.

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_llm_requests_total` | counter | `provider`, `model`, `outcome` | Исход вызова: `ok`/`error`/`cancelled`/`rate_limited`/`blocked`; на вызов |
| `synth_llm_duration_seconds` | histogram | `provider`, `model` | Длительность вызова (для стрима — до последнего чанка); на вызов |
| `synth_llm_tokens_total` | counter | `provider`, `model`, `kind` | Токены: `input`/`output`/`cache_read`/`cache_write`/`reasoning`; пишутся только `> 0` |
| `synth_llm_retries_total` | counter | `provider`, `model` | Повторы (`stream.retry`), provider/model — из последнего события стрима |
| `synth_llm_cost_total` | counter | `currency` | Стоимость по терминальным событиям (`cost_usd`/`cost`+`currency`); live `stream.usage` не суммируется |

### Хранилище

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_datadir_bytes` | gauge | `kind` | Рекурсивный размер верхнеуровневых каталогов `{dataDir}`; фон, **300 с**. `kind`: `sessions`, `projects`, `providers`, `models`, `agents`, `events`, `webhooks`, `scheduler`, `audit`, `workspaces`, `secrets`, `other` (симлинки не разыменовываются) |
| `synth_store_records` | gauge | `store` | Записей в сторе через доменные порты: `sessions`, `projects`, `providers`, `models`, `agents`, `webhooks`, `schedules`, `event_bindings`, `event_routes`; фон, **60 с** |
| `synth_storage_degraded` | gauge | — | `1` — файловый read-only фоллбек (ADR-098), `0` — норма; фон, **60 с** |
| `synth_storage_backend_info` | gauge | `backend` (`file`/`postgres`/`memory`) | Информация о backend, значение `1`; фон, **60 с** |

### Вложения сообщений (ADR-115)

Загрузка/раздача вложений (API — [API_V2.md](./API_V2.md) §5.6.1, лимиты —
[CONFIGURATION.md](./CONFIGURATION.md) §«Вложения сообщений»). Лейблы — только фиксированные наборы
(`outcome`, `kind`); путей объектов (`blobPath`), `sha256`, имён файлов, id сессий и пользователей в
лейблах нет.

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_attachment_uploads_total` | counter | `outcome` (`ok`/`too_large`/`unsupported`), `kind` (`image`/`audio`/`video`/`file`) | Исход загрузки `POST /sessions/:id/attachments`: `ok` — принят, `too_large` — `413`, `unsupported` — `415` (MIME вне белого списка/запрещён, пустой файл); на попытку, дошедшую до сервиса вложений (ранние `413` по `Content-Length` и `400` без файла не считаются) |
| `synth_attachment_upload_bytes` | histogram | `kind` (`image`/`audio`/`video`/`file`) | Размер **принятого** файла после вычищения метаданных, байт (только `outcome=ok`); корзины 1 КиБ … 64 МиБ |
| `synth_attachment_downloads_total` | counter | `outcome` (`ok`/`not_found`) | Выдача байтов `GET/HEAD /sessions/:id/attachments/:partId`: `ok` — объект найден и ответ отдан/условный (`200`/`206`/`304`/`416`), `not_found` — части/объекта нет (`404`) |
| `synth_attachment_gc_removed_total` | counter | — | Объекты, удалённые фоновым pruner'ом осиротевших вложений (нет ссылок в `blob_refs` и истёк `attachments.gcDays`); sidecar-метаданные удаляются вместе с объектом и отдельно не считаются |

**Кардинальность безопасна.** Наборы значений закрыты: `outcome` — 3 доменных значения у загрузки и
2 у выдачи, `kind` — 4 (совпадают с типами медиа-частей), у GC-счётчика лейблов нет; неизвестное
значение нормализуется в `other` — набор остаётся конечным, а произвольные данные (MIME целиком,
`blobPath`, `sha256`, имя файла, id сессии/части) в лейблы не попадают — серии не «взрываются»
(ADR-094 п. 5). Ошибка метрик не влияет на загрузку/выдачу/GC. При `metrics.enabled=false` рекордер
не создаётся (no-op).

### События, шедулер, webhooks, гибрид, decision

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_events_ingested_total` | counter | `source`, `outcome` (`ok`/`error`) | Приём внешних событий (`EventIngress.ingest`) |
| `synth_event_decisions_total` | counter | `kind` (`bound`/`ephemeral`/`queue`/`drop`) | Решения Router (`bind` нормализуется к `bound`) |
| `synth_event_journal_size` | gauge | — | Записей в журнале событий; фон, **5 мин** |
| `synth_scheduler_jobs_total` | counter | `outcome` (`ok`/`error`) | Завершённые Job (`skipped` учитывается как `ok`) |
| `synth_scheduler_drift_seconds` | gauge | — | Дрейф последнего cron-срабатывания (факт − план) |
| `synth_webhook_deliveries_total` | counter | `outcome` (`ok`/`error`/`blocked`) | Доставки webhooks |
| `synth_webhook_retries_total` | counter | — | Повторы (попытки сверх первой) |
| `synth_webhook_delivery_duration_seconds` | histogram | — | Длительность доставки |
| `synth_hybrid_connected` | gauge | — | `1` — гибрид подключён к серверу (ADR-042), `0` — нет; читается при скрейпе |
| `synth_remote_request_duration_seconds` | histogram | `op` (`sessions`/`projects`/`events`/`llm`/`other`) | Исходящие запросы к удалённому backend; `op` — нормализованный сегмент пути, без id/query |

Зеркало агрегатных метрик decision-слоя (ADR-084) — монотонные counter'ы, пишется только прирост:

| Метрика | Тип | Смысл |
|---|---|---|
| `synth_decision_calls_total` | counter | Вызовы decision-слоя |
| `synth_decision_handled_total` | counter | Обработано decision-моделью |
| `synth_decision_fallback_total` | counter | Fallback (fail-safe) |
| `synth_decision_escalated_total` | counter | Эскалация `primary → escalation` |
| `synth_decision_attempts_total` | counter | Попытки (primary + escalation) |
| `synth_decision_rejected_total` | counter | Отклонённые попытки |

### Пайплайны

Метрики движка пайплайнов (ADR-101). Лейблы — только контрактные (`status`/`source`/`kind`/`outcome`);
идентификаторов прогона/узла/сессии в лейблах нет — значения приведены к конечным наборам (неизвестное →
`other`), поэтому кардинальность серий ограничена. Ошибка метрик не влияет на прогон.

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_pipeline_runs_total` | counter | `status` (`done`/`failed`/`cancelled`) | Завершённые прогоны пайплайна; на завершении прогона |
| `synth_pipeline_runs_started_total` | counter | `source` (`user`/`gateway`/`schedule`/`tool`/`webhook`/`manual`) | Запуски прогонов по виду триггера; на старте прогона |
| `synth_pipeline_run_duration_seconds` | histogram | `status` (как у `synth_pipeline_runs_total`) | Длительность завершённого прогона (корзины 0.5…3600 с) |
| `synth_pipeline_steps_total` | counter | `kind` (`agent`/`script`/`tool`/`human`), `outcome` (`ok`/`failed`/`skipped`) | Завершённые шаги по виду узла и исходу |
| `synth_pipeline_step_duration_seconds` | histogram | `kind` (`agent`/`script`/`tool`/`human`) | Длительность шага (корзины 0.1…900 с) |
| `synth_pipeline_human_waits_total` | counter | `kind` (`human`/`tool_approval`) | Прогоны, вставшие на ожидание решения человека (HITL-гейт) |
| `synth_pipeline_human_wait_duration_seconds` | histogram | — | Длительность ожидания, закрытого решением оператора (корзины 1…21600 с); истечение таймаута гейта не измеряется |

Прогон, вставший на ожидание человека, `synth_pipeline_runs_total` **не** увеличивает: счётчик
завершённых прогонов пополняется только терминальным исходом. Шаг, вставший на гейт, в
`synth_pipeline_steps_total` тоже не попадает — он учитывается, когда завершится (после решения
оператора).

### Память

Метрики подсистемы памяти (ADR-107 / PROP-047 §2.1). Серии регистрирует **ядро**
(плагин памяти своей реестровой метрики не заводит): данные памяти хранит ядро
(порты `MemoryFactRepository`/`MemoryIndexRepository`, ADR-096), логика — плагин.
Лейблы — только фиксированные наборы (`status`, `block`, `kind`, `outcome`):
`namespace`, `project_id`, `session_id` в лейблах нет — кардинальность ограничена (ADR-094 п. 5).

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_memory_facts` | gauge | `status` (`candidate`/`active`/`superseded`/`retracted`) | Число фактов в namespace плагина памяти; пересчёт **на скрейпе** (порты `count`) |
| `synth_memory_indexes` | gauge | `status` (`building`/`ready`/`stale`/`failed`) | Число индексов в namespace плагина памяти по состоянию; пересчёт **на скрейпе** |
| `synth_memory_index_chunks` | gauge | `status` (`building`/`ready`/`stale`/`failed`) | Объём корпуса индексов памяти: суммарное число чанков по индексам в каждом состоянии; пересчёт **на скрейпе** (порт `countChunks`) |
| `synth_memory_context_injected_total` | counter | `block` (`facts`/`recall`), `status` (`loaded`/`truncated`/`empty`/…) | Сколько раз блок памяти попадал в промпт хода (по манифесту, один раз на блок за ход) |
| `synth_memory_context_chars` | histogram | `block` (`facts`/`recall`) | Размер блока памяти, фактически ушедшего в контекст (символы); бакеты 50…16 000 |
| `synth_memory_recall_queries_total` | counter | `kind` (`recall`/`search`), `outcome` (`hit`/`empty`/`unavailable`/`error`) | Запросы recall (блок промпта) и `memory_search` (тул) |
| `synth_memory_recall_hits` | histogram | `kind` (`recall`/`search`) | Сколько фрагментов/строк вернуло вспоминание |
| `synth_memory_recall_duration_seconds` | histogram | `kind` (`recall`/`search`) | Длительность вспоминания (поиск + слияние) |

Контекстные серии снимает **ядро** (манифест промпта, `promptMeta.memory`), recall-серии —
плагин через сервис фасада `facade.memoryTelemetry` (ADR-107): ядро ведёт метрики,
плагин только сообщает `{kind, outcome, hits, durationMs}`. Ошибка/отсутствие телеметрии
не влияет на ход. При `metrics.enabled=false` рекордер не создаётся — серий нет.

Порт памяти не сконфигурирован — серии **не публикуются** (нули-обманки не
показываем: «память недоступна» ≠ «в памяти ноль фактов»). Ошибка порта не
ломает скрейп.

`synth_memory_index_chunks` считает **актуальное поколение** корпуса индекса:
индекс без поколения (`generation = 0`, ещё не собран) чанков не даёт и не
опрашивается; ошибка `countChunks` по одному индексу пропускает только этот
индекс — остальные считаются (частичный результат), скрейп при этом не падает.

### Исполнитель (split-режим, ADR-077)

Метрики исполнения команд в split-топологии (`execution.mode: remote`). Счёт
**двусторонний**: у control plane свой набор (очередь/занятость пула), у
исполнителя — свой (исполненные команды). Эндпоинтов `/metrics` тоже два:
backend'а и pod'ов пула.

**Control plane** (backend `/metrics`; коллектор
`createExecutorMetricsCollector`, `packages/core/src/metrics/collectors/executor.ts`):

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_executor_queue_depth` | gauge | — | Запросов в очереди на отправку исполнителю (ждут слот пула); растёт на постановке в очередь, падает при снятии |
| `synth_executor_workers_busy` | gauge | — | Занятых слотов пула; растёт на старте команды, падает по её завершении |
| `synth_executor_wait_seconds` | histogram | — | Ожидание в очереди до отправки (корзины 0.005…60 с); наблюдается при снятии с очереди |
| `synth_executor_commands_total` | counter | `outcome` (`ok`/`error`/`timeout`/`cancelled`) | **Доставленные** исполнителю вызовы по исходу |

**Исполнитель** (его собственный `/metrics`, `packages/executor/src/metrics.ts`):

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_executor_commands_total` | counter | `outcome` (`ok`/`error`/`timeout`/`cancelled`) | **Исполненные** команды по исходу |
| `synth_executor_exec_duration_seconds` | histogram | — | Длительность исполнения команды (корзины 0.05…600 с) |
| `synth_executor_inflight` | gauge | — | Выполняющихся сейчас команд |
| `synth_executor_mcp_servers` | gauge | `status` (`idle`/`up`/`down`) | MCP-серверы исполнителя по состоянию (ленивый старт: `idle` = «ещё не поднят»); пересчёт **на скрейпе** |

> ⚠️ **Двойного счёта нет — но суммировать серии нельзя.**
> `synth_executor_commands_total` есть **на обеих сторонах** и считает **разное**:
> control plane — доставленные исполнителю вызовы, исполнитель — исполненные
> команды. Одна команда даёт единицу в каждом счётчике, поэтому
> `sum(...)` по обоим job'ам посчитает её **дважды**. Различайте стороны по
> лейблу `job` Prometheus (`synth-backend` vs `synth-executor`) и не складывайте
> их в одну метрику.

Серии исполнителя появляются **только** при включённом экспорте:
`executor.metrics.enabled: true` (chart) → env `SYNTH_EXECUTOR_METRICS_ENABLED=true`.
Выключено → `/metrics` исполнителя отвечает `404` (как у control plane,
ADR-094 п. 4); без bearer-токена исполнителя — `401`. Идентификаторов
(адресов, id команд, имён MCP-серверов) в лейблах нет: число MCP-серверов —
это **счётчик по состоянию**, а не список имён.

### Authority-слой (ADR-106)

Решения Authority-слоя (ADR-106 Ф1). Лейблы — `action`/`effect`/`source` (аддитивное
расширение списка лейблов ADR-094 двумя именами); идентификаторов принципала, хода, сессии и
цели в лейблах нет — значения приведены к конечным наборам (неизвестное → `other`), поэтому
кардинальность серий ограничена. Ошибка метрик не влияет на ход.

| Метрика | Тип | Лейблы | Смысл / обновление |
|---|---|---|---|
| `synth_authority_decisions_total` | counter | `action` (`read`/`write`/`execute`/`commit`/`publish`/`approve`/`sign`/`delegate`/`other`), `effect` (`allow`/`ask`/`deny`/`other`), `source` (`user`/`agent`/`session`/`pack`/`instance`/`other`) | Посчитанные решения Authority-слоя (в режиме shadow — считаются, но не применяются) |

Счётчик пополняется **после** записи решения в журнал решений Authority-слоя
(`{dataDir}/audit/authority.jsonl`); ошибка записи в журнал метрику **не** гасит (решение-то
посчитано). Доменные действия (из контента пакета, `provides.authority`) поимённо в метрику не
попадают — иначе кардинальность не ограничена; они сводятся к `other`.

### Служебные (self-metrics)

| Метрика | Тип | Лейблы | Смысл |
|---|---|---|---|
| `synth_ready` | gauge | — | `1` — готов (`/ready` отдаёт 200), `0` — not ready; ставится композицией и снимается при graceful shutdown |
| `synth_metrics_series` | gauge | — | Число серий в реестре (кардинальность) |
| `synth_metrics_scrape_duration_seconds` | gauge | — | Длительность последнего рендера `/metrics` |
| `synth_metrics_series_dropped_total` | counter | `metric` | Серии, отброшенные из-за предела (по умолчанию 2000 на метрику) |

## Кардинальность

Контракт, а не соглашение (ADR-094 п. 5):

- Лейблы — только `method`, `route`, `status`, `provider`, `model`, `kind`, `outcome`, `source`, `op`,
  `currency`, `backend`, `store`, `metric`, а также `action`/`effect` — только для метрик
  Authority-слоя (ADR-106 Ф1: `synth_authority_decisions_total`).
- **`route` — шаблон маршрута**, не сырой путь. Неизвестный/catch-all маршрут сводится к `other`.
- **Нет** `session_id`, `user_id`, query-строк, сырых путей, текстов сообщений — это и PII, и
  неограниченная кардинальность.
- SSE `/api/v2/events` и `/ws/*` **исключены** из гистограммы длительности (долгоживущие соединения
  искажают p95); вместо них — `synth_http_streams_active`/`synth_active_streams`.
- Неизвестные лейблы игнорируются (фиксированный `labelNames` на метрику).
- Предел — 2000 серий на метрику; при исчерпании серия отбрасывается, растёт
  `synth_metrics_series_dropped_total{metric}`. Ненулевое значение — нарушение контракта или
  «взрыв» значений (например, произвольный `store`/`provider`).

## Скрейп

### Vanilla Prometheus

```yaml
# prometheus.yml
scrape_configs:
  - job_name: synth-backend
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ["synth-backend:5000"]

  # при включённом SYNTH_METRICS_TOKEN
  - job_name: synth-backend
    metrics_path: /metrics
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/synth-metrics-token
    static_configs:
      - targets: ["synth-backend:5000"]

rule_files:
  - /etc/prometheus/rules/synth-rules.yaml
```

Файл правил — `charts/synth/files/alerts/synth-rules.yaml` (обычный формат `groups`).

### Kubernetes — аннотации (без CRD)

```yaml
# values.yaml
metrics:
  enabled: true
  prometheus:
    annotations: true     # prometheus.io/scrape/port/path на pod template
```

Prometheus должен вести job по `kubernetes_sd_configs` (роль pod), учитывающий `prometheus.io/*`
(стандартный `kubernetes-pods`). `prometheus.io/port` берётся из `backend.service.targetPort` (5000),
путь — `/metrics`. **Не включайте аннотации при `metrics.enabled=false`** — получите `up==0` (404) и
ложные алерты.

### Kubernetes — ServiceMonitor (Prometheus Operator)

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
    namespaceSelector: {}      # пусто → namespace релиза
```

CRD `monitoring.coreos.com/v1` обязательны: без них установка упадёт (молчаливое отсутствие скрейпа
хуже ошибки). При включённом токене передайте его в скрейп, иначе будет 401:

```yaml
metrics:
  enabled: true
  existingSecret: synth-metrics
  tokenKey: SYNTH_METRICS_TOKEN
  serviceMonitor:
    enabled: true
    bearerTokenSecret:
      name: synth-metrics
      key: SYNTH_METRICS_TOKEN
```

`secretKeyRef` создаётся с `optional: true` — отсутствие ключа не блокирует старт pod'а. Полные
примеры — [charts/synth/README.md](../charts/synth/README.md) §«Наблюдаемость».

### Пул исполнителей (split-режим, ADR-077)

В split-топологии у пула исполнителей **свой** `/metrics` — отдельный target и
отдельный `job` Prometheus. Скрейпятся **два** эндпоинта: backend (control
plane: очередь, занятость, ожидание, доставленные вызовы) и pod'ы пула
(исполненные команды, длительность, inflight, MCP-серверы).

```yaml
# prometheus.yml — пул исполнителей (отдельный job!)
scrape_configs:
  # control plane
  - job_name: synth-backend
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ["synth-backend:5000"]

  # пул исполнителей: токен — ФАЙЛОМ (значение в конфиге не пишется)
  - job_name: synth-executor
    metrics_path: /metrics
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/synth-executor-token
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ["synth"]
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_component]
            action: keep
            regex: executor
          - source_labels: [__meta_kubernetes_pod_container_port_name]
            action: keep
            regex: http
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: instance
```

- **Токен исполнителя** — тот же bearer, что и у остальных эндпоинтов пула
  (`SYNTH_EXECUTOR_TOKEN`, Secret `executor.token.existingSecret` /
  `executor.token.secretKey`). В `scrape_config` — только **путь к файлу**
  (`credentials_file`); значение токена в конфиге Prometheus не пишется.
  Без токена `/metrics` исполнителя отвечает `401`.
- **Доступ из сети** — ingress-правило в NetworkPolicy пула:
  `executor.networkPolicy.metricsIngress` (дополнительное правило **в
  дополнение** к правилу от control plane, не вместо него). Само правило для
  скрейпа не включает egress-ограничения пула — те включаются
  `executor.networkPolicy.enabled: true`.
- **Двойного счёта нет** — но `synth_executor_commands_total` есть на обеих
  сторонах и считает разное (доставленные вызовы vs исполненные команды):
  **не суммируйте** серии двух job'ов, различайте их по `job`
  (см. §«Исполнитель (split-режим)»).
- В `inline`-режиме (`execution.mode: inline`) исполнителей нет: серии
  control plane существуют (нули), серии исполнителя — нет.

Пример в чарте — [charts/synth/README.md](../charts/synth/README.md)
§«Метрики исполнителя»; включение — `executor.metrics.enabled: true` (env
`SYNTH_EXECUTOR_METRICS_ENABLED=true`).

### Grafana и алерты

| Артефакт | Путь | Подключение |
|---|---|---|
| Дашборды | `charts/synth/files/dashboards/synth-overview.json`, `synth-llm.json`, `synth-events-ops.json`, `synth-memory.json` | ConfigMap с label `grafana_dashboard=1` (sidecar) при `grafana.dashboards.enabled=true`; либо импорт JSON вручную |
| Правила алертов | `charts/synth/files/alerts/synth-rules.yaml` | `rule_files` (vanilla) или `PrometheusRule` при `alerts.enabled=true` |

Все панели используют переменную `DS_PROMETHEUS` (datasource типа `prometheus`) — при импорте
выберите свой источник. Файл правил — источник истины и для чарта, и для dev-стенда.

Дашборд памяти (`synth-memory.json`, UID `synth-memory`) — девять панелей по метрикам памяти
(ADR-107, §«Память»):

- **Состав памяти (gauge, пересчёт на скрейпе)** — «Факты по статусам» (`synth_memory_facts`),
  «Индексы по состояниям» (`synth_memory_indexes`), «Чанки индексов по состояниям»
  (`synth_memory_index_chunks`) и stat «Сводка памяти» (`sum(...)` по `status="active"` /
  `status="ready"`). Эти панели читаются без `$__rate_interval` (stat — instant, графики — обычный
  range-запрос).
- **Вспоминания (recall)** — «Вспоминания: запросы» (`rate(synth_memory_recall_queries_total)` по
  `kind`/`outcome`), «Вспоминания: попадания (p50/p95)» (`histogram_quantile` по
  `synth_memory_recall_hits_bucket`) и «Вспоминания: длительность (p95)»
  (`histogram_quantile(0.95, … synth_memory_recall_duration_seconds_bucket)`).
- **Память в контексте** — «Память в контексте: инжекты»
  (`rate(synth_memory_context_injected_total)` по `block`/`status`) и «Память в контексте: средний
  размер блока» (`rate(synth_memory_context_chars_sum) / rate(synth_memory_context_chars_count)`).

Если порт памяти не сконфигурирован, серий нет — панели пустые, а не нулевые.

### Dev-стенд без кластера

```bash
docker compose up -d
docker compose -f docker-compose.yml -f deploy/observability/synth-metrics.override.yml up -d
docker compose -f docker-compose.observability.yml up -d
curl -s localhost:4300/metrics | head
```

Prometheus — `:9090`, Grafana — `:3000` (папка **Synth**, четыре дашборда). Цели/порты/сеть и диагностика —
[deploy/observability/README.md](../deploy/observability/README.md).

## Несколько окружений в одном Prometheus

Один Prometheus может скрейпить dev и test одновременно. Окружение задаётся **лейблом `env`** на
scrape-джобе, а не отдельным сервером Prometheus:

```yaml
scrape_configs:
  - job_name: synth-dev
    metrics_path: /metrics
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/synth-dev-metrics-token
    static_configs:
      - targets: ["dev-host:4300"]
        labels:
          env: dev

  - job_name: synth-test
    metrics_path: /metrics
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/synth-test-metrics-token
    static_configs:
      - targets: ["synth-backend.synth.svc.cluster.local:5000"]
        labels:
          env: test
```

Оба `job_name` попадают под `job=~".*synth.*"` — этот regex используют переменные дашбордов и
базовые алерты. `credentials_file` — путь к файлу с токеном на хосте Prometheus (сам токен в
`scrape_config` не пишется).

`instance` по умолчанию — `host:port` цели, поэтому у pod'а/хоста он меняется при пересоздании и
не годится как стабильный признак среды. Надёжный селектор окружения — **`env`**; `instance` нужен,
чтобы выбрать конкретную реплику/инстанс внутри окружения.

В дашбордах (`synth-overview`, `synth-llm`, `synth-events-ops`, `synth-memory`) после `DS_PROMETHEUS` добавлены
переменные **«Окружение»** (`env`) и **«Инстанс»** (`instance`, зависит от выбранного `env`). Все
запросы панелей фильтруются `env=~"$env"` и `instance=~"$instance"`; по умолчанию выбрано `All`
(`.*`), поэтому на инстансе с одним окружением поведение не меняется.

> **Правила алертов env-aware.** Базовые правила
> `charts/synth/files/alerts/synth-rules.yaml` группируют агрегаты по `env`, а у каждого алерта
> есть лейбл `env` (из scrape label, через `{{ $labels.env }}`): упавший dev даёт `SynthDown` с
> `env="dev"`, а доли 5xx/p95/ошибок LLM и webhooks считаются отдельно по окружениям:
>
> ```promql
> sum by (env) (rate(synth_http_requests_total{status=~"5.."}[5m]))
>   / clamp_min(sum by (env) (rate(synth_http_requests_total[5m])), 1e-9)
> ```
>
> Исключение — `SynthMetricsMissing` (`absent(synth_build_info)`): правило остаётся глобальным,
> потому что Prometheus не знает список ожидаемых окружений. Если одно окружение метрики присылает,
> а другое нет, сработает `SynthDown` по конкретному target; `SynthMetricsMissing` — только про
> полное отсутствие метрик. Пороги и `for` по-прежнему стоит держать отдельно по окружениям
> (dev — мягче, test — ближе к прод), но теперь для этого не нужно править сами выражения.

## Алерты и SLO-минимум

Правила из `synth-rules.yaml` (пороги стартовые, консервативные — подбирайте под SLO окружения):

| Алерт | Условие (кратко) | Severity |
|---|---|---|
| `SynthDown` | `up{job=~".*synth.*"} == 0` 2 мин | critical |
| `SynthReadyDown` | `synth_ready == 0` 5 мин | critical |
| `SynthMetricsMissing` | `absent(synth_build_info)` 10 мин | warning |
| `High5xxRate` / `High5xxRateCritical` | доля 5xx > 1% (10 мин) / > 5% (5 мин) | warning / critical |
| `HighLatencyP95` / `HighLatencyP95Critical` | p95 > 1 с (10 мин) / > 3 с (5 мин) | warning / critical |
| `QueueBacklogGrowing` | `synth_queue_pending > 20` и растёт 15 мин | warning |
| `QueueBacklogCritical` | `synth_queue_pending > 200` 5 мин | critical |
| `LLMErrorRate` | доля `outcome="error"` > 10% 10 мин | warning |
| `LLMProviderDown` | > 90% ошибок у провайдера 5 мин | critical |
| `StorageDegraded` | `synth_storage_degraded == 1` 1 мин | critical |
| `SynthDatadirGrowthFast` | рост `synth_datadir_bytes` ~> 1 ГиБ/сутки | warning |
| `SynthDatadirLarge` | `synth_datadir_bytes` > 50 ГиБ | warning |
| `EventJournalGrowth` | журнал событий > 10k записей/сутки | warning |
| `WebhookFailures` | > 20% доставок с ошибкой 10 мин | warning |
| `SchedulerDrift` / `SchedulerDriftCritical` | дрейф > 60 с (10 мин) / > 300 с (5 мин) | warning / critical |
| `MetricsScrapeSlow` | рендер `/metrics` > 1 с 10 мин | warning |
| `ExecutorPoolStalled` | пул исполнителей недоступен: `workers_busy == 0` при растущем `queue_depth` | critical |
| `ExecutorCommandErrorRate` | доля `commands_total{outcome="error"}` > 10% (10 мин) | warning |
| `ExecutorQueueWaitHigh` | p95 ожидания в очереди пула > 5 с (10 мин) | warning |

Алерты пула (ADR-077 шаг 7d) — отдельная группа `synth-executor` в
`charts/synth/files/alerts/synth-rules.yaml`:

```promql
# пул недоступен: слоты не заняты, а очередь растёт
(synth_executor_workers_busy == 0) and (synth_executor_queue_depth > 0)
  and (deriv(synth_executor_queue_depth[10m]) > 0)

# доля неуспешных команд
sum by (env) (rate(synth_executor_commands_total{outcome="error"}[10m]))
  / clamp_min(sum by (env) (rate(synth_executor_commands_total[10m])), 1e-9) > 0.1

# команды ждут слот пула слишком долго
histogram_quantile(0.95,
  sum by (le, env) (rate(synth_executor_wait_seconds_bucket[10m]))) > 5
```

Доли и p95 считаются **по каждой стороне отдельно**: у control plane и у
исполнителя своя серия `synth_executor_commands_total`, и складывать их нельзя
(см. §«Исполнитель (split-режим)»). В `inline`-режиме эти правила молчат:
очередь пула всегда пуста, серий исполнителя нет.

Что подстроить под себя:

- **`job`** — базовые правила используют `job=~".*synth.*"`. При нескольких инстансах в одном
  Prometheus сузьте regex, иначе алерт сработает по любому упавшему инстансу. В Prometheus Operator
  `job` = `<namespace>/<service>`.
- **PVC/диск** — `SynthDatadirLarge` (50 ГиБ) и рост 1 ГиБ/сутки — стартовые; для 10Gi-дефолта чарта
  абсолютный порог нужно снизить.
- **Токен** — при `SYNTH_METRICS_TOKEN` без `bearerTokenSecret` скрейп получит 401 → `SynthMetricsMissing`.
- **`SynthReadyDown`** — работает по `synth_ready`; внешняя проверка через `blackbox_exporter` на
  `/ready` опциональна (в dev-стенде её нет).

## Диагностика

| Симптом | Причина / что делать |
|---|---|
| `curl /metrics` → 404 | `metrics.enabled=false` (или `SYNTH_METRICS_ENABLED` не передан контейнеру/процессу) |
| `curl /metrics` → 401 | Задан `SYNTH_METRICS_TOKEN` или файл `{dataDir}/secrets/metrics-token`; передайте `Authorization: Bearer …` (в ServiceMonitor — `bearerTokenSecret`) |
| В UI `restartRequired=true` | Runtime-значение `enabled` отличается от стартового (`running`): нажмите «Перезапустить инстанс» в разделе «Метрики» (или «Обслуживание»), только рестарт пересоздаёт middleware/коллекторы |
| Тумблер `enabled` в UI заблокирован | Действует `SYNTH_METRICS_ENABLED` (источник `env`): env приоритетнее runtime; измените env/Helm и перезапустите процесс |
| UI: задать/удалить токен → 409 | Токен задан через `SYNTH_METRICS_TOKEN` (env) — из UI не перезаписывается; меняйте env |
| `synth_llm_*` пусто | С момента старта не было LLM-вызовов (серии создаются при первом вызове) — это нормально |
| `synth_pipeline_*` пусто | С момента старта не было прогонов пайплайнов (серии создаются при первом прогоне) — это нормально; детали прогона — в его журнале и в событиях `pipeline.run.*` (ADR-101), в метриках id прогонов нет |
| `synth_ready=0` | Старт не завершён или fail-closed хранилище; смотрите логи старта, `StorageDegraded`, доступность БД |
| Растёт `synth_metrics_series_dropped_total` | Нарушен контракт лейблов или предел 2000 серий на метрику; проверьте `synth_metrics_series` и значения (`route`/`store`/`provider`/`model`) |
| `synth_storage_degraded=1` | Инстанс на файловом read-only фоллбеке (ADR-098): проверьте PostgreSQL (dsn/сеть/права); авто-возврата нет — рестарт после устранения причины; доступ только ADMIN |
| `synth_datadir_bytes` растёт | Проверьте `kind` (сессии/события/workspaces), retention журнала событий и Job-истории, свободное место PVC |
| Target `UP`, но серий `synth_*` нет | Скрейп попал в `/metrics` при выключенном экспорте (404) или отфильтрован по пути — см. «Включение» |
| `MetricsScrapeSlow` | Дорогой рендер: высокая кардинальность или много `route`/`store`; проверьте `synth_metrics_series` |
| `curl /metrics` исполнителя → 404 | Экспорт исполнителя выключен: не задан `executor.metrics.enabled` / env `SYNTH_EXECUTOR_METRICS_ENABLED` |
| `curl /metrics` исполнителя → 401 | Не передан bearer-токен исполнителя (`SYNTH_EXECUTOR_TOKEN`): в `scrape_config` нужен `credentials_file` с токеном из Secret |
| `synth_executor_queue_depth` растёт, `workers_busy == 0` | Пул недоступен: ни один исполнитель не отвечает (при `failMode: fail` команды падают с `EUNREACHABLE`); проверьте pod'ы пула, токен доверия и NetworkPolicy |
| `synth_executor_wait_seconds` растёт | Слоты пула заняты (`workers_busy` на пределе `maxConcurrency`) — расширьте пул или поднимите лимит одновременных команд |

Общая диагностика инстанса — [MAINTENANCE.md](./MAINTENANCE.md) §«Проверка и диагностика»,
типовые проблемы — [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Безопасность

- **Нет PII и секретов.** В метриках нет текстов сообщений, промптов, ключей, id сессий/пользователей,
  query-строк и сырых путей. Лейблы — только контрактные.
- **Сеть.** `/metrics` — на порту API и вне `/api/v2`; в кластере ограничьте доступ NetworkPolicy
  (только namespace Prometheus) или включите токен. Публикация через Ingress допустима только с
  bearer-токеном: в test это путь `/metrics` на основном host `synth.k3s.itphx.loc` (отдельного
  хоста `metrics.*` нет — TLS-сертификат покрывает основной host); UI-nginx этот путь не проксирует.
- **Токен.** `SYNTH_METRICS_TOKEN`/`{dataDir}/secrets/metrics-token` (`0600`); сравнение
  constant-time, значение не логируется и не возвращается в ответах. В `config.yaml` не хранится
  (инвариант 13). UI пишет только файл (write-only) и не перезаписывает env-токен (409).
- **Аудит релиза.** Контур входит в обязательный внутренний аудит: политика — [security/README.md](./security/README.md),
  чек-лист — [security/AUDIT-CHECKLIST.md](./security/AUDIT-CHECKLIST.md); запись релиза —
  `docs/security/releases/<version>.json` (ADR-094, гейт `security-gate`).
