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

- Prometheus — <http://localhost:9090> (`Status → Targets`: оба job'а
  (`synth-dev-core`, `synth-dev-backend`) `UP`, `Alerts`: правила загружены);
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
job'а `prometheus.yml` — только через `credentials_file` со смонтированным файлом
(Prometheus не подставляет env в конфиг). Подробно — раздел
[«Несколько окружений (dev + test)»](#несколько-окружений-dev--test).

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

## Несколько окружений (dev + test)

Стенд — шаблон схемы **«один Prometheus, несколько окружений»**: одно окружение
не должно «затирать» другое, поэтому окружение различается **именем job'а** и
лейблом `env`, а роль процесса — лейблом `component`:

| `job_name` | `env` | `component` | Источник |
|---|---|---|---|
| `synth-dev-core` | `dev` | `core` | контейнер `synth` / `synth serve` (`:4300`) |
| `synth-dev-backend` | `dev` | `backend` | `./scripts/dev.sh backend` или k3s (`:5000`) |
| `synth-test-backend` (пример, закомментирован) | `test` | `backend` | Ingress `synth.k3s.itphx.loc`, путь `/metrics` |

dev-job'ы включены всегда; пример test лежит в `prometheus/prometheus.yml`
закомментированным — раскомментируйте и смонтируйте токен (см. ниже). Новое
окружение добавляется так же: **новый** `job_name` вида
`synth-<env>-<component>` и свой `env` в `static_configs.labels`. Не
переиспользуйте dev-job'ы и не пытайтесь различить окружения через
`external_labels`: Prometheus **не применяет** их к локальным запросам
(`/graph`, HTTP API, дашборды) — они уходят только в remote write, federation и
уведомления Alertmanager. Фильтрация и агрегация — строго по `env` из
`static_configs`. Общая схема (не только dev-стенд) — в
[docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md#несколько-окружений-в-одном-prometheus).

### `/metrics` из test

Test — k3s, namespace `synth` (backend `synth-backend:5000`). Два способа
достать `/metrics`:

```bash
# 1) основной host, путь /metrics (https) — так ходит Prometheus из шаблона
curl -s -H "Authorization: Bearer $SYNTH_METRICS_TOKEN" \
  https://synth.k3s.itphx.loc/metrics | head

# 2) port-forward, если Ingress не опубликован или нужен локальный стенд
kubectl -n synth port-forward svc/synth-backend 15000:5000 &
curl -s -H "Authorization: Bearer $SYNTH_METRICS_TOKEN" \
  http://localhost:15000/metrics | head
```

`/metrics` отдаётся по основному host'у `synth.k3s.itphx.loc` отдельным метрик-Ingress,
который ведёт напрямую на backend Service (UI-nginx этот путь не проксирует). Отдельного
хоста `metrics.*` нет намеренно: TLS-сертификат test покрывает только основной host,
поэтому путь `/metrics` живёт на нём же. Для port-forward target в scrape_config —
`host.docker.internal:15000` (`extra_hosts: host-gateway` в
`docker-compose.observability.yml` уже задан). Токен проверяется на стороне backend'а;
если `/metrics` в test выключен (`metrics.enabled=false`) — будет 404, а не пустой ответ.

### Токен — только файлом

`/metrics` в test защищён bearer-токеном (`SYNTH_METRICS_TOKEN`, ADR-094),
который лежит в SealedSecret `synth-metrics` (namespace `synth`). В конфиг
Prometheus токен **не пишется**: распакуйте его в файл вне git и смонтируйте
read-only.

```bash
# секреты — вне git-репозитория synth/ (инвариант 13)
mkdir -p ../secrets
kubectl -n synth get secret synth-metrics \
  -o jsonpath='{.data.SYNTH_METRICS_TOKEN}' | base64 -d \
  > ../secrets/synth-test-metrics-token
chmod 600 ../secrets/synth-test-metrics-token
```

```yaml
authorization:
  type: Bearer
  credentials_file: /etc/prometheus/secrets/synth-test-token
```

`credentials_file` — путь **внутри** контейнера Prometheus; mount добавляется в
`docker-compose.observability.yml`:

```yaml
volumes:
  - ../secrets/synth-test-metrics-token:/etc/prometheus/secrets/synth-test-token:ro
```

Inline `credentials:` в репозиторий не попадает (инвариант 13), а env-подстановки
в `prometheus.yml` нет — поэтому только `credentials_file`. Тот же приём нужен
dev-job'ам, если вы включили `SYNTH_METRICS_TOKEN` локально.

### Grafana: окружение и инстанс

В дашбордах (`charts/synth/files/dashboards/*.json`) три переменные:

| Переменная | Label | Что выбирает |
|---|---|---|
| `DS_PROMETHEUS` | Prometheus | источник данных |
| `env` | **Окружение** | `label_values(up{job=~".*synth.*"}, env)` |
| `instance` | **Инстанс** | `label_values(up{job=~".*synth.*", env=~"$env"}, instance)` |

Все запросы панелей фильтруются `env=~"$env"` и `instance=~"$instance"`; по
умолчанию выбрано `All` (`.*`), поэтому на инстансе с одним окружением
поведение не меняется. Значения берутся из лейблов `up`, т.е. из
`static_configs.labels` ваших job'ов: job вне regex `.*synth.*` в списке
окружений не появится, а job без `env` даст пустой список. Если окружения нет
в выпадающем списке — проверьте `Status → Targets` (лейбл `env` и `up == 1`).

`instance` — это `host:port` цели, он меняется при пересоздании pod'а; как
стабильный признак среды используйте `env`, а `instance` — чтобы выбрать
конкретную реплику внутри окружения.

### Алерты при общем Prometheus

Файл правил общий с чартом (`charts/synth/files/alerts/synth-rules.yaml`,
подключён через `rule_files`). Правила env-aware: `env` приходит из scrape
labels, агрегаты группируются `by (env)`, а у каждого алерта есть label
`env` (`{{ $labels.env }}`). Поэтому `alerts.enabled: true` (PrometheusRule)
и `rule_files` подхватывают обновлённый файл как есть — dev и test не
смешиваются:

- агрегаты считаются по окружению: `sum by (env) (...)`,
  `histogram_quantile(0.95, sum by (le, env) (...))` — доля ошибок,
  стоимость и p95 не суммируются по dev+test;
- `SynthDown`/`SynthReadyDown` и другие правила по сырым сериям сохраняют
  `env` в labels/аннотации, поэтому видно, какое окружение упало;
- `job` можно оставить regex `.*synth.*` — разбивку обеспечивает `env`;
- `SynthMetricsMissing` остаётся глобальным (`absent(synth_build_info)`):
  Prometheus не знает список ожидаемых env, поэтому пропажа метрик одного
  окружения ловится `SynthDown` по конкретному target, а правило — только
  про полное отсутствие метрик;
- пороги задавайте по окружностям: шумный test не должен срабатывать как
  инцидент dev.

Если scrape-джоб не задаёт `env`, шаблон даёт пустой лейбл и поведение
остаётся прежним (один инстанс без разбивки).

Полный каталог метрик, лейблов, скрейпа и диагностики — в
[docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md); здесь только dev-стенд.

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
