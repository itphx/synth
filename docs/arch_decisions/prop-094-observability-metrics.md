# PROP-094: Наблюдаемость и эксплуатационные метрики

> **Статус:** 🧩 Предложение — Наблюдаемость: `/metrics` (Prometheus), `/ready` + раздельные probes, структурные логи, SLO/алерты
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-15
> **Парные документы:**
> - [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — аудит запросов (журнал), который наблюдаемость дополняет операционными метриками;
> - [ADR-051](./adr-051-scheduler-pipelines.md) — job-история планировщика как источник метрик;
> - [ADR-052](./adr-052-public-api-platform.md) — webhooks и service-key, чьи доставки/вызовы нужно измерять;
> - [ADR-005](./adr-005-json-storage.md) / [PROP-032](./prop-032-history-storage-postgresql.md) — хранилище, объём и рост которого надо отслеживать;
> - [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — эксплуатационный контур, в который встраивается мониторинг.

## Решение

Ввести минимально достаточный **контур наблюдаемости** для self-hosted инстанса:

1. **Метрики `/metrics`** (формат Prometheus) — HTTP, очередь, LLM-вызовы, события, планировщик, вебхуки, хранилище, гибрид.
2. **Разделить health/readiness** — `/health` (liveness, текущий) и `/ready` (зависимости: доступность каталога данных, инициализация стораджей, готовность очереди), с разными probe в Helm.
3. **Структурированные логи** — опциональный JSON-формат, уровни, корреляция `request_id`/`session_id`, редакция секретов.
4. **Базовый SLO/алертинг и sizing** — задокументированные целевые показатели и рекомендуемые алерты + гайд по ресурсам.

---

## Контекст

Аудит отметил: «Нет наблюдаемости: только `/health`; метрик, алертов, sizing/SLO/SLA и оценки стоимости эксплуатации нет вовсе.» По факту:

- Единственный публичный эндпоинт состояния — `GET /health` и `GET /api/v2/health` (`packages/backend/src/app.ts`), оба возвращают статический `{status:'healthy', version, time}`.
- Helm-probes ссылаются на health (`charts/synth/.../backend-deployment.yaml`), но отдельного readiness-эндпоинта нет — «процесс отвечает» ≠ «готов обслуживать».
- Метрики есть точечно: `GET/DELETE /api/v2/settings/decision/metrics` (in-memory метрики decision-слоя). Общих метрик платформы нет.
- Аудит ([ADR-036](./adr-036-llm-gateway.md)) пишет журнал запросов, но это не операционные метрики (нельзя построить latency/error-rate/нагрузку).
- Нет метрик очереди (глубина, время ожидания), LLM (латентность, ошибки по провайдерам, токены), событий/планировщика/вебхуков, объёма хранилища.

Это критично для эксплуатации: без метрик невозможны ни SLO, ни алерты, ни обоснованный sizing.

## Детали

### Метрики (Prometheus)

| Домен | Примеры метрик |
|---|---|
| HTTP | `synth_http_requests_total{route,method,status}`, `synth_http_request_duration_seconds` (histogram) |
| Очередь/сессии | `synth_queue_pending`, `synth_queue_wait_seconds`, `synth_active_streams`, `synth_sessions_total` |
| LLM/Gateway | `synth_llm_requests_total{provider,model,outcome}`, `synth_llm_duration_seconds`, `synth_llm_tokens_total{kind}`, `synth_llm_retries_total` |
| События | `synth_events_ingested_total{source}`, `synth_event_decisions_total{kind}`, `synth_event_journal_size` |
| Планировщик | `synth_scheduler_jobs_total{outcome}`, `synth_scheduler_drift_seconds` |
| Вебхуки | `synth_webhook_deliveries_total{outcome}`, `synth_webhook_retries_total`, `synth_webhook_delivery_duration_seconds` |
| Хранилище | `synth_datadir_bytes{kind}`, `synth_store_records{store}` |
| Гибрид | `synth_hybrid_connected`, `synth_remote_request_duration_seconds` |

Требования: **низкая кардинальность** (никаких `user_id`/`session_id`/путей в лейблах), без секретов/PII в значениях.

### Health / readiness

- `/health` — liveness: процесс жив (текущее поведение, без авторизации).
- `/ready` — readiness: каталог данных доступен на запись, стораджи инициализированы, миграции применены ([ADR-092](./adr-092-instance-lifecycle-maintenance.md)), очередь готова; при неготовности — `503` с причиной.
- Helm: `livenessProbe` → `/health`, `readinessProbe` → `/ready` (по умолчанию, с возможностью переопределить).

### Логи

- Опция JSON-логов (`SYNTH_LOG_FORMAT=json`) для сбора в ELK/Loki; уровни (`LOG_LEVEL`).
- Корреляция: `request_id` (HTTP) и `session_id` (движок) в записях; редакция секретов ([ADR-036](./adr-036-llm-gateway.md)).

### SLO, алерты, sizing

- Базовые SLO: доступность (uptime), p95 латентность API, доля 5xx, глубина очереди, ошибки LLM-провайдера.
- Рекомендуемые алерты (напр.): `5xx > 1%` 5 мин; `queue_pending` растёт; `llm_errors` по провайдеру; свободное место < 15%; `/ready` = 0.
- Sizing: рекомендации CPU/RAM/диска под нагрузку и рост `{dataDir}`; оценка стоимости эксплуатации (LLM-провайдер + инфраструктура).

## Безопасность

- `/metrics` — не публиковать наружу (внутренний порт/ingress-политика), при необходимости — auth/allowlist.
- Логи и метрики не содержат секретов, ключей, полного содержимого сообщений; кардинальность ограничена.
- Опционально: экспорт в pull-модели (Prometheus scrape) без исходящего egress по умолчанию ([PROP-088](./prop-088-http-proxy.md) — если egress нужен).

## Объём MVP и этапы

1. **MVP:** `/ready` + раздельные probes; `/metrics` с HTTP/очередь/LLM/Gateway/хранилище; JSON-логи + `request_id`. ~2–3 дня.
2. Метрики событий/планировщика/вебхуков/гибрида + дашборд-пример (Grafana JSON). ~1–2 дня.
3. SLO/алерты (правила) + sizing-гайд в портале. ~1 день.

## Открытые вопросы

1. Формат экспорта: собственный `/metrics` (Prometheus text) через лёгкую зависимость или ручной рендер без новых зависимостей?
2. Нужен ли OpenTelemetry-трейсинг (сквозной по LLM-вызову) или достаточно метрик/логов на этом этапе?
3. Дашборды поставлять как Grafana-JSON в репозитории или только документировать?
4. Хранить ли историю метрик на стороне Synth или полностью делегировать Prometheus?

## Связи

- [ADR-005](./adr-005-json-storage.md), [PROP-032](./prop-032-history-storage-postgresql.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-051](./adr-051-scheduler-pipelines.md), [ADR-052](./adr-052-public-api-platform.md), [PROP-088](./prop-088-http-proxy.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md).

## Порядок реализации

`/ready` + `/metrics` (HTTP/очередь/LLM/хранилище) → остальные домены + дашборд → SLO/алерты/sizing. Даёт эксплуатационную видимость при минимальном риске и не требует PostgreSQL.
