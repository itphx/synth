# Dev-стенд наблюдаемости Synth

Prometheus + Grafana для локальной проверки `/metrics` (ADR-094) без Kubernetes.
Основной `docker-compose.yml` **не меняется**: стенд цепляется к его default-сети
и скрейпит контейнер `synth` по имени сервиса.

## Что внутри

| Файл | Назначение |
|---|---|
| `../../docker-compose.observability.yml` | Prometheus (`:9090`) + Grafana (`:3000`), общая сеть с основным стеком |
| `synth-metrics.override.yml` | опциональный override: `SYNTH_METRICS_ENABLED=true` контейнеру `synth` |
| `prometheus/prometheus.yml` | шаблон scrape_config (15s, `/metrics`), плейсхолдеры целей |
| `grafana/provisioning/datasources/prometheus.yml` | источник `Prometheus` (`http://prometheus:9090`) |
| `grafana/provisioning/dashboards/dashboards.yml` | провайдер дашбордов из `charts/synth/files/dashboards` |
| `../../../charts/synth/files/alerts/synth-rules.yaml` | правила алертов (тот же файл, что в Helm-чарте) |

Дашборды — те же JSON, что чарт отдаёт в ConfigMap для Grafana sidecar: правка
`charts/synth/files/dashboards/*.json` видна и в dev-стенде (провайдер перечитывает
файлы каждые 30 с), и в кластере после `helm upgrade`.

## Быстрый старт

```bash
# 1. Основной стек (создаёт сеть synth_default и контейнер synth)
docker compose up -d

# 2. Метрики включены (override — сам docker-compose.yml не правим)
docker compose -f docker-compose.yml \
  -f deploy/observability/synth-metrics.override.yml up -d

# 3. Стенд
docker compose -f docker-compose.observability.yml up -d

# 4. Проверка
curl -s localhost:4300/metrics | head
```

Открыть:

- Prometheus — <http://localhost:9090> (`Status → Targets`: оба job'а `UP`,
  `Alerts`: правила загружены);
- Grafana — <http://localhost:3000> (по умолчанию `admin` / `admin`; анонимный
  просмотр включён, папка **Synth** с тремя дашбордами).

Если основной стек ещё не поднимали, сети `synth_default` нет — стенд упадёт с
`network synth_default not found`. Поднимите основной стек первым либо создайте
сеть вручную:

```bash
docker network create synth_default
```

## Включение метрик в Synth

`/metrics` **выключен по умолчанию** (ADR-094 п. 4) — без него Prometheus видит
цель, но получает 404.

| Способ запуска | Как включить |
|---|---|
| контейнер `synth` | `docker compose -f docker-compose.yml -f deploy/observability/synth-metrics.override.yml up -d` |
| `./scripts/dev.sh` (host, `:4300`) | `SYNTH_METRICS_ENABLED=true ./scripts/dev.sh` |
| `./scripts/dev.sh backend` (host, `:5000`) | `SYNTH_METRICS_ENABLED=true ./scripts/dev.sh backend` |
| Helm/Kubernetes | `--set metrics.enabled=true` (см. `charts/synth/README.md`, «Наблюдаемость») |

Проверка без Prometheus:

```bash
curl -s localhost:4300/metrics | grep -E '^synth_(build_info|http_requests_total|process_uptime_seconds|ready)'
curl -s -o /dev/null -w '%{http_code}\n' localhost:4300/ready     # 200 — готов обслуживать
```

`synth_ready` — gauge `0`/`1` (`1` — приложение инициализировано и готово
обслуживать трафик, `0` — not ready: старт или fail-closed, ADR-094 п. 3); на неё
опирается алерт `SynthReadyDown`. `synth_build_info{version,node}` — версия/node.

При включённом bearer-токене (`SYNTH_METRICS_TOKEN`) добавьте заголовок:

```bash
curl -s -H "Authorization: Bearer $SYNTH_METRICS_TOKEN" localhost:4300/metrics | head
```

В dev-стенде токен не настроен: если он нужен, допишите `authorization` в оба
job'а `prometheus.yml` (Prometheus не подставляет env в конфиг — используйте
`credentials_file` и смонтируйте файл с токеном).

## Цели скрейпа и сеть

| Переменная | Дефолт | Смысл |
|---|---|---|
| `SYNTH_METRICS_CORE_TARGET` | `synth:4300` | standalone-core (контейнер `synth`) |
| `SYNTH_METRICS_BACKEND_TARGET` | `host.docker.internal:5000` | backend из `dev.sh` на хосте |
| `SYNTH_DOCKER_NETWORK` | `synth_default` | external-сеть основного compose |
| `SYNTH_PROMETHEUS_PORT` / `SYNTH_GRAFANA_PORT` | `9090` / `3000` | публикуемые порты |
| `SYNTH_PROMETHEUS_RETENTION` | `15d` | retention TSDB |
| `SYNTH_GRAFANA_ADMIN_USER` / `_PASSWORD` | `admin` / `admin` | учётка Grafana |
| `SYNTH_GRAFANA_ANONYMOUS` | `true` | анонимный просмотр (Viewer) |

Пример: backend в k3s через port-forward и core в контейнере:

```bash
kubectl -n synth port-forward svc/synth-backend 5001:5000 &
SYNTH_METRICS_CORE_TARGET=synth:4300 \
SYNTH_METRICS_BACKEND_TARGET=host.docker.internal:5001 \
  docker compose -f docker-compose.observability.yml up -d
```

Имя сети основного стека зависит от имени каталога репозитория
(`<каталог>_default`). Посмотреть и переопределить:

```bash
docker network ls | grep -i synth
SYNTH_DOCKER_NETWORK=myproject_default \
  docker compose -f docker-compose.observability.yml up -d
```

## Проверка правил и алертов

```bash
# правила загружены (plain YAML, не PrometheusRule)
curl -s localhost:9090/api/v1/rules | python3 -m json.tool | head -40

# сработавшие алерты
curl -s localhost:9090/api/v1/alerts

# синтаксис правил без Prometheus (если установлен promtool)
promtool check rules charts/synth/files/alerts/synth-rules.yaml
```

`SynthReadyDown` требует blackbox_exporter probe job на `/ready` — в dev-стенде
его нет, правило неактивно (и не даёт ложных срабатываний). Остальные правила
работают на метриках `/metrics`; `SynthDown` использует `up{job=~".*synth.*"}`.

## Остановка

```bash
docker compose -f docker-compose.observability.yml down        # данные сохраняются
docker compose -f docker-compose.observability.yml down -v     # + удалить TSDB и Grafana
```

## Диагностика

| Симптом | Причина / что делать |
|---|---|
| `network synth_default not found` | не поднят основной стек; `docker network ls`, задайте `SYNTH_DOCKER_NETWORK` |
| Target `DOWN`, `connection refused` | контейнер `synth` не запущен или цель задана неверно |
| Target `UP`, но серий `synth_*` нет | `SYNTH_METRICS_ENABLED` не задан (404) — см. «Включение метрик» |
| `401` в ошибке скрейпа | включён `SYNTH_METRICS_TOKEN`; настройте `authorization`/`credentials_file` |
| Grafana пустая, дашбордов нет | не смонтирован `charts/synth/files/dashboards`; `docker compose ... logs grafana` |
| Панели «No data» | выберите источник в переменной `DS_PROMETHEUS` (Prometheus) |
| `host.docker.internal` не резолвится | Linux: нужен `extra_hosts: host-gateway` (уже задан); проверьте Docker ≥ 20.10 |
