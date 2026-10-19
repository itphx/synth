# Чарт `synth`

Helm-чарт для развёртывания AI-платформы **Synth** для командной работы в Kubernetes:
**backend** (API Hub: OIDC/RBAC + встроенный движок, хранилище: JSON-файлы в PVC или
PostgreSQL) и
**ui** (React SPA под nginx, проксирует `/api /ws /auth /admin /health` на backend).

Чарт универсален: подходит для self-host у заказчиков. Self-hosted, enterprise-ready.
Все значения по умолчанию нейтральны — окружение задаётся своим `values`-файлом или `--set`/`--set-file`.
Канонический набор значений с комментариями — [`values.yaml`](./values.yaml);
примеры переопределений и плейсхолдеров (`<...>`) — ниже в этом README.

## Архитектура

| Сервис | Образ (по умолчанию) | Порт | Роль |
|---|---|---|---|
| `backend` | `gitverse.ru/itphx/synth-backend` | 5000 | API Hub: OIDC + RBAC + движок; данные — JSON в PVC (по умолчанию) или PostgreSQL (`storage.backend: postgres`) |
| `ui` | `gitverse.ru/itphx/synth-ui` | 8080 | React SPA под nginx; проксирует API на backend |

Backend самодостаточен (встроенный движок + хранилище), поэтому отдельный runner
не разворачивается. Backend всегда 1 реплика (`backend.replicaCount`), чарт не
разворачивает HA: файловое хранилище не масштабируется, а PostgreSQL-бэкенд в
этом чарте — смена носителя данных, не переход на мультирепличный режим.

## Требования

- Kubernetes ≥ 1.24, Helm 3.
- StorageClass для PVC backend (по умолчанию — класс кластера).
- (Опционально) Ingress-контроллер: nginx (по умолчанию) или Traefik — для
  авто-редиректа HTTP→HTTPS. Без контроллера чарт тоже работает
  (`ingress.controller: none`).
- Secret с секретами (см. ниже).
- (Опционально) PostgreSQL, если выбран `storage.backend: postgres`, и Secret с
  паролем БД — см. раздел «PostgreSQL как backend хранения».

## Установка

```bash
helm repo add synth https://gitverse.ru/api/packages/itphx/helm
helm repo update

# Минимальная установка (публичные образы, ingress выключен)
helm install synth synth/synth --namespace synth --create-namespace

# С values-файлом окружения
helm install synth ./charts/synth -f my-values.yaml --namespace synth --create-namespace
```

Из исходников репозитория:

```bash
helm lint charts/synth
helm template synth charts/synth
```

## Пример values-файла окружения

Компактный пример переопределений под конкретную инсталляцию (замените
плейсхолдеры `<...>`). Полный список ключей с комментариями — в `values.yaml`.

```yaml
# my-values.yaml
backend:
  image:
    tag: ""                     # пусто → .Chart.AppVersion
  persistence:
    size: 10Gi
    storageClass: "<class>"     # "" = storageClass по умолчанию кластера
  oidc:
    enabled: true
    issuer: "https://keycloak.example.com/realms/<realm>"
    clientId: "synth"
    redirectUri: "https://synth.example.com/auth/callback"
  resources:                    # подберите под нагрузку
    limits:   { cpu: 1000m, memory: 1Gi }
    requests: { cpu: 200m, memory: 256Mi }

ingress:
  enabled: true
  controller: nginx
  className: "nginx"            # "" = IngressClass по умолчанию
  redirectHttpToHttps: true     # нужен настроенный TLS (см. ingress.tls)
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: synth.example.com
      paths:
        - { path: /, pathType: Prefix }
  tls:
    - secretName: synth-tls     # существующий TLS-secret
      hosts: [synth.example.com]

# CA внутренней инфраструктуры удобно передавать файлом, а не встраивать PEM:
#   helm install synth ./charts/synth --set-file caCert=./my-ca.crt -f my-values.yaml
```

## Ключевые values

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `backend.image.repository` | `gitverse.ru/itphx/synth-backend` | Образ backend |
| `backend.image.tag` | `""` | Тег; пусто → `.Chart.AppVersion` |
| `backend.imagePullSecrets` | `[]` | Секреты для приватного реестра |
| `backend.oidc.enabled` | `false` | Включить OIDC-вход |
| `backend.oidc.issuer` | `""` | Issuer IdP |
| `backend.oidc.clientId` | `""` | Client ID |
| `backend.oidc.redirectUri` | `""` | Redirect URI (callback) |
| `backend.providers` | `[]` | Список LLM-провайдеров (`name/type/url/model/apiKey`) |
| `backend.persistence.*` | `enabled: true`, `10Gi` | PVC для JSON-данных |
| `backend.persistence.keepOnUninstall` | `false` | Не удалять PVC при `helm uninstall` (аннотация `helm.sh/resource-policy: keep` в манифесте релиза); для окружений, где данные нельзя терять |
| `backend.extraEnv` | `{}` | Доп. env для backend |
| `backend.restartMode` | `process` | Restart из UI: `process` \| `supervisor` \| `disabled` (env `SYNTH_RESTART_MODE`, см. «Перезапуск инстанса из UI») |
| `backend.config` | `{}` | Декларативный `config.yaml` backend (монтируется в `/etc/synth`); сюда же домерживается секция `storage` из значений ниже |
| `storage.backend` | `file` | Backend хранения (PROP-032): `file` \| `memory` \| `postgres` |
| `storage.postgres.host` | `""` | Хост БД (при `backend: postgres`) |
| `storage.postgres.port` | `5432` | Порт БД |
| `storage.postgres.database` | `""` | Имя БД |
| `storage.postgres.user` | `""` | Пользователь БД |
| `storage.postgres.schema` | `""` | Схема БД (namespace таблиц; пусто → схема драйвера) |
| `storage.postgres.ssl` | `false` | Legacy-флаг: `true` → `ssl: true` в конфиге (эквивалент `sslmode=require`); тонкий `sslmode` (`disable`\|`require`\|`verify-full`) задаётся через `backend.config.storage.postgres.sslmode` |
| `storage.postgres.poolMax` | `10` | Максимальный размер пула соединений |
| `storage.postgres.existingSecret` | `""` | Secret с паролем БД (пусто → `secrets.existingSecret`) |
| `storage.postgres.secretPasswordKey` | `SYNTH_POSTGRES_PASSWORD` | Ключ внутри Secret с паролем БД |
| `storage.degradedMode` | `""` | Задел деградации: `fallback-file` \| `halt` (пусто → дефолт core) |
| `storage.fallbackDir` | `""` | Каталог файлового фоллбека (пусто → `{dataDir}/fallback`) |
| `security.tls.existingSecret` | `""` | Secret с CA/клиентскими сертификатами → mount в `/etc/synth/tls` (ADR-099) |
| `security.tls.caKey` / `certKey` / `keyKey` | `""` | Ключи внутри Secret → `security.tls.{caFile,certFile,keyFile}` (путь `/etc/synth/tls/<key>`) |
| `security.tls.caFile` / `certFile` / `keyFile` | `""` | Явные пути внутри контейнера (когда файлы смонтированы вами) |
| `security.tls.rejectUnauthorized` | `""` | `""` (дефолт `true`) \| `"true"` \| `"false"` → `security.tls.rejectUnauthorized` |
| `metrics.enabled` | `false` | `GET /metrics` (ADR-094): env `SYNTH_METRICS_ENABLED=true`; выключено по умолчанию |
| `metrics.existingSecret` / `tokenKey` | `""` / `SYNTH_METRICS_TOKEN` | Bearer-токен `/metrics` из Secret (env `SYNTH_METRICS_TOKEN`, `optional` — см. `metrics.tokenOptional`) |
| `metrics.tokenOptional` | `true` | `optional` у `secretKeyRef` токена: `true` — отсутствие ключа не блокирует старт; `false` — pod ждёт Secret |
| `metrics.ingress.enabled` | `false` | Отдельный Ingress напрямую на backend Service для внешнего Prometheus (только вместе с `metrics.enabled`) |
| `metrics.ingress.className` | `""` | `ingressClassName` метрик-Ingress |
| `metrics.ingress.annotations` | `{}` | Аннотации метрик-Ingress |
| `metrics.ingress.hosts` | `[]` | Список `[{host, paths: [{path, pathType}]}]`; `pathType` по умолчанию `Prefix` |
| `metrics.ingress.tls` | `[]` | `tls`-блок метрик-Ingress |
| `metrics.prometheus.annotations` | `false` | Аннотации `prometheus.io/scrape`, `prometheus.io/port`, `prometheus.io/path` на pod (vanilla Prometheus) |
| `metrics.serviceMonitor.enabled` | `false` | Объект `ServiceMonitor` (Prometheus Operator; нужны CRD) |
| `metrics.serviceMonitor.interval` / `scrapeTimeout` | `30s` / `10s` | Параметры скрейпа ServiceMonitor |
| `metrics.serviceMonitor.labels` | `{}` | Доп. labels ServiceMonitor (например `release: kube-prometheus-stack`) |
| `metrics.serviceMonitor.namespaceSelector` | `{}` | `namespaceSelector` (пусто → namespace релиза) |
| `metrics.serviceMonitor.bearerTokenSecret.name` / `key` | `""` / `""` | Bearer для скрейпа при включённом токене |
| `grafana.dashboards.enabled` | `false` | ConfigMap с дашбордами и label `grafana_dashboard=1` (sidecar) |
| `grafana.dashboards.folder` | `""` | Аннотация `grafana_folder` (папка в Grafana) |
| `alerts.enabled` | `false` | `PrometheusRule` с правилами из `files/alerts/synth-rules.yaml` |
| `ui.image.repository` | `gitverse.ru/itphx/synth-ui` | Образ UI |
| `ui.image.tag` | `""` | Тег; пусто → `.Chart.AppVersion` |
| `ui.imagePullSecrets` | `[]` | Секреты для приватного реестра |
| `ingress.enabled` | `false` | Включить Ingress |
| `ingress.controller` | `nginx` | Ingress-контроллер: `nginx` \| `traefik` \| `none` |
| `ingress.className` | `""` | IngressClass |
| `ingress.annotations` | `{}` | Произвольные аннотации Ingress (мержатся с авто-аннотациями) |
| `ingress.redirectHttpToHttps` | `true` | HTTP→HTTPS-редирект (nginx: аннотация; traefik: CRD) |
| `ingress.entrypoints` | `""` | Traefik entrypoints (**только Traefik**; аннотация при непустом значении) |
| `ingress.hosts` | `[]` | Список хостов |
| `ingress.tls` | `[]` | TLS-секция Ingress |
| `secrets.existingSecret` | `synth-secrets` | Имя Secret с секретами |
| `installerKey.enabled` | `false` | Создать installer service-key (Secret + env `SYNTH_BOOTSTRAP_SERVICE_KEYS`) |
| `installerKey.label` | `addon-installer` | Метка installer-ключа |
| `installerKey.scopes` | `["addons:install"]` | Scope installer-ключа |
| `installerKey.roles` | `[]` | Роли синтетического пользователя (пусто → дефолт хранилища) |
| `installerKey.secretName` | `synth-installer-key` | Secret, создаваемый чартом (при пустом `existingSecret`) |
| `installerKey.existingSecret` | `""` | Готовый Secret с JSON для `SYNTH_BOOTSTRAP_SERVICE_KEYS` (тогда чарт Secret не создаёт) |
| `installerKey.bootstrapKey` | `bootstrap.json` | Ключ внутри Secret с JSON-массивом (для бутстрапа backend) |
| `installerKey.tokenKey` | `token` | Ключ внутри Secret с plaintext-токеном (для аддонов) |
| `caCert` | `""` | PEM внутреннего CA (опционально) |
| `extraObjects` | `[]` | Произвольные дополнительные манифесты (рендерятся как есть) |

## Наблюдаемость

`GET /metrics` (формат Prometheus exposition 0.0.4) отдаётся на том же порту, что и API
(`backend.service.targetPort`), и **по умолчанию выключен** (ADR-094 п. 4). Кардинальность ограничена
контрактом: лейблы — только `method`, `route`, `status`, `provider`, `model`, `kind`, `outcome`,
`source`, `op`, `currency`, `backend`, `store`; SSE/WS в гистограмму длительности не попадают
(вместо них — gauge активных стримов).

Что включает какой флаг:

| Значение | Эффект |
|---|---|
| `metrics.enabled: true` | env `SYNTH_METRICS_ENABLED=true` → `/metrics` начинает отвечать |
| `metrics.existingSecret` + `metrics.tokenKey` | env `SYNTH_METRICS_TOKEN` из Secret (`optional` — см. `metrics.tokenOptional`) → `/metrics` требует `Authorization: Bearer …` |
| `metrics.prometheus.annotations: true` | аннотации `prometheus.io/scrape`, `prometheus.io/port`, `prometheus.io/path` на pod template |
| `metrics.serviceMonitor.enabled: true` | объект `ServiceMonitor` (Prometheus Operator; CRD обязательны) |
| `metrics.serviceMonitor.bearerTokenSecret` | bearer для скрейпа (обязателен, если включён токен) |
| `metrics.ingress.enabled: true` | отдельный Ingress напрямую на backend Service (внешний Prometheus; требует `metrics.enabled: true`) |
| `grafana.dashboards.enabled: true` | ConfigMap `*-grafana-dashboards` с label `grafana_dashboard=1` (sidecar) |
| `alerts.enabled: true` | `PrometheusRule` с правилами из `files/alerts/synth-rules.yaml` |

### Вариант 1 — vanilla Prometheus по аннотациям (без CRD)

```yaml
metrics:
  enabled: true
  prometheus:
    annotations: true
```

Prometheus должен вести job по `kubernetes_sd_configs` (роль pod), учитывающий `prometheus.io/*` —
это стандартный job `kubernetes-pods` из примеров Prometheus. Значение `prometheus.io/port` берётся из
`backend.service.targetPort` (дефолт `5000`), путь — `/metrics`.

### Вариант 2 — Prometheus Operator (ServiceMonitor)

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack   # label селектора вашего Prometheus
    namespaceSelector: {}              # пусто → namespace релиза
```

CRD `monitoring.coreos.com/v1` обязательны: при `serviceMonitor.enabled: true` без CRD установка
упадёт (это осознанно — молчаливое отсутствие скрейпа хуже ошибки).

### Вариант 3 — bearer-токен `/metrics`

```bash
kubectl -n synth create secret generic synth-metrics \
  --from-literal=SYNTH_METRICS_TOKEN="$(openssl rand -hex 32)"
```

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

`secretKeyRef` создаётся с `optional: true` (по умолчанию `metrics.tokenOptional: true`): отсутствие
ключа не блокирует старт pod'а. При `tokenOptional: false` pod ждёт появления Secret/ключа — это
рекомендуется для внешнего Ingress с токеном. При включённом токене и пустом `bearerTokenSecret`
скрейп получит 401 → алерт `SynthMetricsMissing`.

### Вариант 4 — внешний Prometheus через Ingress

Отдельный Ingress ведёт **напрямую на backend Service** (`/metrics` живёт на backend; UI-nginx его не
проксирует). Включайте вместе с `metrics.enabled` и токеном (для внешнего доступа — `tokenOptional: false`):

```yaml
metrics:
  enabled: true
  existingSecret: synth-metrics
  tokenOptional: false
  ingress:
    enabled: true
    className: traefik
    annotations:
      traefik.ingress.kubernetes.io/router.entrypoints: websecure
    hosts:
      - host: metrics.synth.example.com
        paths:
          - path: /
            pathType: Prefix
    tls: []
```

URL скрейпа — `https://<host>/metrics` (при `tls: []` схему задаёт контроллер/аннотации; при необходимости
добавьте `tls`-блок с Secret сертификата). Токен передаётся Prometheus через `authorization.credentials_file`:

```yaml
scrape_configs:
  - job_name: synth
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/synth-metrics-token
    static_configs:
      - targets: ["metrics.synth.example.com"]
```

### Вариант 5 — Grafana sidecar и алерты

```yaml
grafana:
  dashboards:
    enabled: true
    label: "1"                         # label, который ищет sidecar
    folder: Synth                      # аннотация grafana_folder (опционально)
    labels:
      release: kube-prometheus-stack   # чтобы ConfigMap попал в селектор sidecar'а
alerts:
  enabled: true
  labels:
    release: kube-prometheus-stack     # чтобы Prometheus выбрал PrometheusRule
```

Дашборды (`charts/synth/files/dashboards/`):

| Файл | Содержимое |
|---|---|
| `synth-overview.json` | Готовность (`synth_ready`), HTTP RED (RPS по route, доля 5xx, p95), in-flight, uptime/build, RSS/heap/CPU/event loop lag, `{dataDir}`/записи/деградация, сессии/стримы/очередь |
| `synth-llm.json` | запросы/ошибки/p95 по provider/model, токены по kind, ретраи, стоимость по currency, зеркало decision-метрик |
| `synth-events-ops.json` | ingest по source/outcome, решения Router по kind, журнал, шедулер (jobs/drift), webhooks, гибрид, remote p95 |

Все панели используют переменную `DS_PROMETHEUS` (datasource типа `prometheus`) — при импорте
выберите свой источник. После выбора datasource доступны переменные **«Окружение»** (`env`) и
**«Инстанс»** (`instance`): все запросы фильтруются `env=~"$env"` / `instance=~"$instance"`.
Кратко: `env` — надёжный признак среды (dev/test), `instance` — конкретная цель (`host:port`).
Правила алертов — обычный Prometheus-формат: тот же
`files/alerts/synth-rules.yaml` подключается к vanilla Prometheus через `rule_files`.

Проверка после применения:

```bash
kubectl -n synth port-forward deploy/synth-backend 5000:5000
curl -s localhost:5000/metrics | grep -c '^synth_'        # > 0
curl -s -o /dev/null -w '%{http_code}\n' localhost:5000/ready   # 200
```

Локальный стенд без кластера (Prometheus + Grafana + дашборды) —
`docker-compose.observability.yml`, инструкция — `deploy/observability/README.md`.

## Перезапуск инстанса из UI

В админ-разделе «Обслуживание → Перезапуск» (`GET/POST /api/v2/maintenance/restart`)
можно инициировать graceful restart инстанса: процесс завершается с кодом **75**
(`EX_TEMPFAIL`), а поднимает его заново супервизор.

- `backend.restartMode: process` (дефолт чарта) → env `SYNTH_RESTART_MODE=process`;
  Deployment имеет `restartPolicy: Always` (дефолт Kubernetes), поэтому pod
  перезапускается автоматически.
- `disabled` — кнопка в UI недоступна (`GET /restart` → `supported:false`,
  `POST /restart` → `409 RESTART_UNSUPPORTED`).
- `supervisor` — для локального `scripts/dev.sh` (не для кластера).

**Multi-replica.** Перезапускается только тот pod, который обработал запрос
(остальные реплики продолжают работать); соединения, попавшие на него, прерываются.
Чтобы перезапустить весь Deployment (например, после изменения `config.yaml`),
используйте rollout:

```bash
kubectl -n synth rollout restart deployment/<release>-synth-backend
```

Запрос рестарта фиксируется в журнале обслуживания (аудит `restart.requested`).

## Прокси с профилями и правилами

Прокси-конфигурация (включая `mode`/`profiles`/`rules`, ADR-099 п. 27) задаётся декларативно через
`backend.config.proxy` — чарт рендерит её в ConfigMap `config.yaml`:

```yaml
backend:
  config:
    proxy:
      enabled: true
      mode: all
      defaultProfile: default
      profiles:
        default:
          label: Corporate
          url: http://proxy.corp:3128
          auth: { type: basic, username: synth }
          tls: { caFile: /etc/synth/tls/proxy-ca.pem }
        llm:
          label: LLM egress
          url: https://llm-proxy.svc:8443
          auth: { type: basic, username: synth-llm }
      rules:
        - id: r_openai
          hosts: ["api.openai.com", "*.openai.com"]
          action: proxy
          profile: llm
        - hosts: ["*.corp.local", "10.0.0.0/8"]
          action: direct
      noProxy: ["localhost", ".svc"]
```

- **Пароли** в `config.yaml` не хранятся (инвариант 13): `default` — `SYNTH_PROXY_PASSWORD`,
  остальные профили — `SYNTH_PROXY_<NAME>_PASSWORD` (имя в верхнем регистре, `-` → `_`). Передайте их
  через `backend.extraEnv` из существующего Secret (или задайте файл `{dataDir}/secrets/proxy/…`).
- **TLS к прокси** — `proxy.profiles.<name>.tls` (`caFile`/`certFile`/`keyFile`): смонтируйте Secret в pod
  (по аналогии с `security.tls.existingSecret`, `/etc/synth/tls`) и укажите пути.
- **Применение** — при старте pod: после правки values нужен `helm upgrade` (или
  `kubectl rollout restart`), кнопка «Перезапуск» перезапускает только текущий pod.
- Профили/правила также редактируются в UI («Сеть» → «Прокси», runtime-override в `settings.json`/PG);
  `config.yaml` — базовый слой, UI его перекрывает (кроме явных `SYNTH_PROXY_*`).

## Secret с секретами

Чарт **не создаёт** Secret с секретами OIDC/провайдеров — он должен существовать в
namespace релиза. Имя задаётся `secrets.existingSecret` (по умолчанию `synth-secrets`).
Единственное исключение, когда чарт сам создаёт Secret — опция `installerKey` (см. ниже).

Ожидаемые ключи:

| Ключ | Когда нужен |
|---|---|
| `SYNTH_OIDC_CLIENT_SECRET` | при `backend.oidc.enabled: true` |
| `SYNTH_PROVIDER_<NAME>_API_KEY` | для каждого провайдера с `apiKey: true` (`<NAME>` — name в верхнем регистре, `-` → `_`) |
| `SYNTH_POSTGRES_PASSWORD` | при `storage.backend: postgres` — пароль БД (ключ переопределяется `storage.postgres.secretPasswordKey`, Secret — `storage.postgres.existingSecret`) |

Пример:

```bash
kubectl create secret generic synth-secrets \
  --namespace synth \
  --from-literal=SYNTH_OIDC_CLIENT_SECRET='<client-secret>' \
  --from-literal=SYNTH_PROVIDER_OPENAI_API_KEY='<api-key>' \
  --from-literal=SYNTH_POSTGRES_PASSWORD='<db-password>'
```

Секреты можно создавать любым способом: вручную, External Secrets Operator,
sealed-secrets и т.п. Зашифрованных секретов в чарте нет.

> Пароль БД подключается как `optional: true` (env `SYNTH_POSTGRES_PASSWORD`): если
> ключа в Secret нет, под стартует без env, и core ищет пароль в файле
> `{dataDir}/secrets/postgres-password` (внутри PVC) — fallback для схем, где
> пароль лежит в томе, а не в Secret. Отсутствие пароля там, где он нужен,
> приводит к ошибке подключения в логах backend, а не к молчаливой работе.

## PostgreSQL как backend хранения (`storage.backend: postgres`)

PROP-032 / ADR-096 / ADR-097: физический backend хранения выбирается значением
`storage.backend` — `file` (JSON-файлы в PVC, по умолчанию), `memory` (данные не
сохраняются — тесты/эмуляция), `postgres` (БД). Драйвер
`@itphx/synth-storage-postgres` и `pg` входят в образ backend (optionalDependencies
ядра) — доустанавливать в кластер ничего не нужно.

```yaml
# my-values.yaml — плейсхолдеры <...> заменить
storage:
  backend: postgres
  postgres:
    host: "synth-postgres.<namespace>.svc.cluster.local"
    port: 5432
    database: synth
    user: synth
    schema: synth          # "" → схема драйвера
    ssl: true              # sslmode=require
    poolMax: 10
    existingSecret: ""     # "" → secrets.existingSecret
    secretPasswordKey: SYNTH_POSTGRES_PASSWORD
  degradedMode: ""         # "" | fallback-file | halt (задел, см. ниже)
  fallbackDir: ""          # "" → {dataDir}/fallback
```

Пароль БД — только в Secret, не в values:

```bash
kubectl create secret generic synth-secrets -n <namespace> \
  --from-literal=SYNTH_POSTGRES_PASSWORD='<db-password>'
```

Что делает чарт:

- домерживает в `config.yaml` (`ConfigMap <release>-config` → `/etc/synth/config.yaml`)
  секцию `storage` **без пароля**: `storage.backend` + `storage.postgres.*`
  (`host`/`port`/`database`/`user`/`schema`/`ssl`/`poolMax`);
- прокидывает пароль **только** в env `SYNTH_POSTGRES_PASSWORD` из Secret
  (`secretKeyRef`, `optional: true`) — пароля нет ни в values, ни в ConfigMap;
- приоритет при конфликте: chart-значения `storage.*` **выше**
  `backend.config.storage.*` (глубокая домержка; остальные ключи `backend.config`
  сохраняются как есть).

Чего чарт намеренно не делает:

- **не задаёт `dsn`**: полная строка подключения почти всегда содержит пароль, а
  значение ушло бы в ConfigMap. Нужен DSN — задайте его сами в `backend.config`
  (без пароля) или отдельным env из вашего Secret.
- **не разворачивает PostgreSQL и не создаёт Secret с паролем** (как и остальные
  секреты чарта): БД и её креды — ответственность оператора (managed-сервис,
  оператор Zalando/Crunchy, helm-чарт БД). Локальный пример — профиль `postgres`
  в `docker-compose.yml` репозитория.
- **не проверяет БД в probes**: liveness/readiness смотрят `/health` (живость
  процесса backend). Выключать под из балансировки при недоступной БД нельзя:
  вместе с backend недоступен UI (nginx проксирует `/api`), а при
  `storage.degradedMode: fallback-file` деградация — штатный режим, а не отказ.
  DB-aware готовность подключайте внешним мониторингом БД; при необходимости —
  своим `CronJob` с `pg_isready`.
- **не бэкапит БД**: `synth backup` архивирует каталог данных, а при
  `backend: postgres` данные — в БД, поэтому бэкап/восстановление — средствами
  СУБД (`pg_dump`/`pg_basebackup`/pgBackRest, `CronJob` или managed-бэкап).

### TLS соединения с БД (`sslmode`)

Режим TLS задаётся `storage.postgres.sslmode` (`disable` | `require` | `verify-full`;
алиас `verify-ca` → `verify-full`). Отдельного value в чарте нет — задайте его через
`backend.config.storage.postgres.sslmode` (chart-значение `storage.postgres.ssl: true`
— legacy-эквивалент `require`):

```yaml
backend:
  config:
    storage:
      postgres:
        sslmode: verify-full
security:
  tls:
    existingSecret: corp-tls
    caKey: ca.crt
```

`verify-full` требует доверенный CA из `security.tls` — **fail-closed** без него.
**TLS-параметры в DSN запрещены** (`sslmode`/`sslrootcert`/`sslcert`/`sslkey`/…):
`pg` накладывает DSN поверх конфига (`Object.assign`) и молча перекрывает `ssl`-опции
(вплоть до отключения TLS), поэтому политика доверия задаётся только
`storage.postgres.sslmode` + `security.tls` (DSN при необходимости — без TLS-параметров).

### PVC при `backend: postgres` — только периферия

PVC (`backend.persistence.*`) остаётся смонтированным в `/var/synth/data`, но
хранит только периферию — «файловый периметр» (терминология `synth backup`):

- `secrets/` — мастер-ключ секретов at-rest (ADR-076), api-key, SSH-ключи агентов,
  при необходимости `postgres-password` (если пароль не в Secret);
- `meta.json` — версия схемы данных инстанса (ADR-092);
- `workspaces/` — рабочие каталоги проектов (файлы агента) и файловый фоллбек
  (`storage.fallbackDir`, по умолчанию `{dataDir}/fallback`);
- `backups/` — архивы `synth backup`, если они пишутся в каталог данных.

Данные (сессии, проекты, сообщения, провайдеры/модели/агенты, события,
расписания, service-keys, webhooks) — в PostgreSQL. Следствия:

- **бэкап/восстановление данных — средствами СУБД**; `synth backup`/`synth restore`
  по каталогу данных не заменяют дамп БД (и не вернут данные БД);
- PVC всё ещё нужен (секреты/workspace) — не отключайте `backend.persistence`
  без отдельного хранилища для `secrets/`: иначе мастер-ключ и SSH-ключи окажутся
  в эфемерном слое;
- `backend.persistence.keepOnUninstall` защищает только PVC; БД — снаружи чарта.

### Миграции схемы

Драйвер применяет миграции при старте (`schemaMode=apply` по умолчанию) —
отдельная инициализация БД не нужна (достаточно прав на DDL в схеме). Вручную —
`synth migrate` (см. `docs/MAINTENANCE.md`).

### Задел деградации (`storage.degradedMode`)

`fallback-file` (дефолт core) — при недоступности БД инстанс переходит на файловое
хранилище в `storage.fallbackDir` (пусто → `{dataDir}/fallback`); `halt` — старт не
выполняется. Реализация — параллельная волна PROP-032; чарт лишь доводит значения
до `config.yaml` (env-переменных у этих ключей нет). Значение `storage.backend`
валидируется приложением (при неизвестном — ошибка старта), чарт его не проверяет.

## Installer service-key (опция `installerKey`)

Создаёт при развёртывании Synth **service-key установщика** (ADR-052) со scope
`addons:install`: аддоны (внешние сервисы/интеграции) используют его для
самоустановки своих ресурсов (MCP-серверы, скиллы) без ручного создания ключа
через API. Ключ провижинится идемпотентно при старте backend (по `label`,
секрет существующего ключа не перезаписывается).

```yaml
installerKey:
  enabled: true
  label: addon-installer
  scopes: ["addons:install"]
  roles: []                          # доступ дают scopes; роль повышать не нужно
  secretName: synth-installer-key    # Secret, создаёт чарт (enabled + пустой existingSecret)
  existingSecret: ""                 # готовый Secret (тогда чарт Secret не создаёт)
  bootstrapKey: bootstrap.json       # ключ с JSON для бутстрапа backend
  tokenKey: "token"                  # ключ с plaintext-токеном для аддонов
```

Поведение:

- `enabled: false` (по умолчанию) — ничего не создаётся, env не задаётся.
- `enabled: true`, `existingSecret: ""` — чарт создаёт Secret `<secretName>` с **двумя**
  ключами, содержащими **один и тот же** секрет:
  - `bootstrapKey` (`bootstrap.json`) — JSON-массив `[{label,secret,scopes,roles}]`
    для env `SYNTH_BOOTSTRAP_SERVICE_KEYS` (backend Deployment ссылается через `secretKeyRef`);
  - `tokenKey` (`token`) — «сырой» plaintext-токен (`synth_svc_` + 43 символа base64url)
    для аддонов/скриптов: `secretKeyRef {name: <secret>, key: token}`.
- `enabled: true`, `existingSecret: <name>` — Secret не создаётся; чарт только
  ссылается на существующий Secret, в котором оператор сам кладёт оба ключа:
  `bootstrapKey` (готовый JSON) и `tokenKey` (plaintext-токен)
  (вручную, External Secrets, sealed-secrets и т.п.).

Токен **стабилен между `helm upgrade`**: если Secret уже есть в кластере, его текущее
значение переиспользуется (`lookup`). Вне кластера (`helm template`, `--dry-run`) `lookup`
пуст, поэтому при каждом рендере генерируется новый токен — это ожидаемо: реальный токен
фиксируется при `helm install`/`upgrade` в кластере. Токен не логируется и в ConfigMap
не попадает.

> Конфликт с `backend.config`: если в `backend.config` уже задан
> `security.bootstrapServiceKeys`, env `SYNTH_BOOTSTRAP_SERVICE_KEYS` из этой опции
> **приоритетнее** `config.yaml` (ADR-023: CLI > env > config.yaml), т.е. список из Secret
> полностью заменяет список из `config.yaml`. Не задавайте installer-ключи в обоих местах.

### Ключи Secret и как выдать токен

В Secret два ключа с одинаковым секретом:

| Ключ | Содержимое | Кому |
|---|---|---|
| `bootstrap.json` (`bootstrapKey`) | JSON-массив с секретом | backend (авто-бутстрап `security.bootstrapServiceKeys`) |
| `token` (`tokenKey`) | «сырой» токен `synth_svc_…` | аддоны/скрипты (hook-Job авто-установки) |

Получить токен для аддона (или сверить со скриптом):

```bash
# plaintext-токен (для аддонов/скриптов)
kubectl get secret synth-installer-key -n <namespace> -o jsonpath='{.data.token}' | base64 -d

# то же значение из JSON-бутстрапа (для сверки)
kubectl get secret synth-installer-key -n <namespace> \
  -o jsonpath='{.data.bootstrap\.json}' | base64 -d | jq -r '.[0].secret'
```

Аддон аутентифицируется заголовком `Authorization: Bearer synth_svc_…`
(scope `addons:install`). Чтобы не доставать токен вручную, hook-Job аддона ссылается
на тот же Secret через `secretKeyRef`:

```yaml
# фрагмент Job/Deployment аддона
env:
  - name: SYNTH_INSTALLER_TOKEN
    valueFrom:
      secretKeyRef:
        name: synth-installer-key     # installerKey.existingSecret | default installerKey.secretName
        key: token                    # installerKey.tokenKey
```

> В `autoInstall.installerSecretKey` чарт аддона указывает имя **Secret** (например
> `synth-installer-key`), а ключ внутри — `token` (`installerKey.tokenKey`).

### Ротация

1. Удалите запись ключа: `DELETE /api/v2/service-keys/<id>`. (Мягкий `revoke` не
   подойдёт: запись остаётся, и `ensure` не пересоздаст секрет.)
2. Удалите Secret чарта: `kubectl delete secret synth-installer-key -n <namespace>`.
3. `helm upgrade …` — чарт сгенерирует новый токен, backend при старте создаст ключ
   с новым секретом.
4. Обновите токен у аддонов.

Смена `label` создаёт новый ключ (прежний остаётся и его нужно удалить отдельно);
смена `scopes`/`roles` синхронизируется на существующем ключе без смены секрета.
Надёжнее управлять секретом вне чарта — через `installerKey.existingSecret`.

## Провайдеры LLM

Список задаётся в `backend.providers`. Для каждого рендерятся env
`SYNTH_PROVIDER_<NAME>_URL/TYPE/MODEL` в ConfigMap; API-ключ (если `apiKey`
не `false`) читается из Secret по ключу `SYNTH_PROVIDER_<NAME>_API_KEY`.
Backend подхватывает их при старте.

```yaml
backend:
  providers:
    - name: openai
      type: openai
      url: "https://api.openai.com/v1/"
      model: "gpt-4o-mini"
      apiKey: true
    - name: local
      type: ollama
      url: "http://ollama.internal:11434"
      model: "qwen2.5:14b"
      apiKey: false
```

## CA внутренней инфраструктуры

Если backend обращается к ресурсам (IdP, LLM-провайдеры) с сертификатами
собственного CA, задайте PEM в `caCert`. Тогда чарт:

1. создаёт ConfigMap `<release>-itphx-ca` (только при непустом `caCert`);
2. монтирует сертификат в backend как `/etc/ssl/certs/itphx-ca.crt`;
3. автоматически добавляет env `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/itphx-ca.crt`.

При пустом `caCert` (по умолчанию) ни ConfigMap, ни volume, ни env не создаются.
Вручную дублировать `NODE_EXTRA_CA_CERTS` в `backend.extraEnv` не нужно.

Удобно передавать через файл:

```bash
helm install synth ./charts/synth --set-file caCert=./my-ca.crt -f my-values.yaml
```

> `caCert` → `NODE_EXTRA_CA_CERTS` — это **process-level** канал Node: он влияет только
> на стандартный транспорт и остаётся как совместимость **для дочерних процессов**.
> Для доверия **самого Synth** (исходящие https-вызовы, включая PostgreSQL
> `verify-full`) канонический путь — секция `security.tls` (см. ниже); при заданном
> `security.tls` Synth ставит собственный глобальный TLS-dispatcher и
> `NODE_EXTRA_CA_CERTS` не учитывает.

## Доверие TLS/CA исходящих соединений (`security.tls`)

ADR-099: единый источник доверия TLS/CA для **всех** исходящих соединений Synth
(LLM-провайдеры, MCP, webhooks, гибрид, OIDC/JWKS, загрузка иконок/обновлений,
git-over-https) и для TLS к PostgreSQL (`verify-full`). Пусто (дефолт) → системное
доверие Node, манифесты не меняются.

Секретов в ConfigMap нет (инвариант 13): в `config.yaml` попадают **только пути**
внутри контейнера, сами файлы — в Secret, который монтируется в backend как
`/etc/synth/tls` (readOnly, `0400`).

```yaml
# my-values.yaml
security:
  tls:
    existingSecret: corp-tls   # Secret с CA/клиентскими сертификатами
    caKey: ca.crt              # ключи внутри Secret → путь /etc/synth/tls/<key>
    certKey: client.crt        # опционально (mTLS)
    keyKey: client.key         # опционально (mTLS)
    rejectUnauthorized: "true" # "" = дефолт (true)

backend:
  config:
    storage:
      postgres:
        sslmode: verify-full   # CA для verify-full берётся из security.tls
```

Поведение:

- непустой `security.tls.existingSecret` → Secret монтируется в `/etc/synth/tls`;
  пути в `config.yaml` выводятся из ключей (`caKey`/`certKey`/`keyKey`) —
  `security.tls.{caFile,certFile,keyFile} = /etc/synth/tls/<key>`;
- явные `caFile`/`certFile`/`keyFile` приоритетнее выведенных из ключей Secret
  (для случая, когда файлы смонтированы вами) — тогда чарт ничего не монтирует,
  а лишь рендерит секцию в `config.yaml`;
- `rejectUnauthorized` строка `"true"`/`"false"` → булево в `config.yaml`
  (иное значение — `helm`-ошибка);
- нужен `caPem` **без файла** (например из env)? Чарт рендерит только пути; для
  git-канала (`git -c http.sslCAInfo`) `caPem` вообще недоступен — задавайте
  `caFile`.

Отличие от `caCert`/`NODE_EXTRA_CA_CERTS`: `caCert` — process-level канал Node
(ConfigMap + `/etc/ssl/certs/itphx-ca.crt` + env, для дочерних процессов);
`security.tls` — штатная конфигурация доверия самого Synth (и CA для PostgreSQL
`verify-full`). Для Synth предпочтителен `security.tls`.

## Декларативный config.yaml

Непустой `backend.config` рендерит ConfigMap `<release>-config` и монтирует его в
backend как `/etc/synth/config.yaml` — это штатный путь поиска конфига backend
(`SYSTEM_CONFIG_PATH`). При пустом `backend.config` (по умолчанию) ConfigMap и
volume не создаются.

Приоритет источников конфига: CLI-флаги > `SYNTH_*` env > `config.yaml` >
defaults. Runtime-настройки, изменённые через UI/API (`settings.json`),
применяются поверх файла — файл задаёт базовые значения, а не жёстко
фиксирует их. Это отдельный объект от `backend.extraEnv`/ConfigMap
`<release>-env` и не конфликтует с ними.
Секция `storage` может задаваться и chart-значениями `storage.*` — они
домерживаются поверх `backend.config.storage` (см. раздел «PostgreSQL как backend
хранения»).

Когда использовать: декларативно поставлять базовый конфиг инстанса, например
включить авто-привязку внешних событий или шедулер.

```yaml
backend:
  config:
    events:
      autoBind: true
    scheduler:
      enabled: true
```

## Дополнительные манифесты

`extraObjects` — список произвольных Kubernetes-манифестов, которые чарт
рендерит как есть (любой `kind`: ConfigMap, Secret, CR кластера и т.п.).
Namespace указывать не обязательно — подставится namespace релиза. При пустом
списке (по умолчанию) ничего не рендерится.

```yaml
extraObjects:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: synth-extra
    data:
      key: value
```

## Ingress, TLS и HTTP→HTTPS

`ingress.enabled: true` создаёт обычный `networking.k8s.io/v1` Ingress (`/` →
UI-сервис). Способ редиректа HTTP→HTTPS задаётся `ingress.controller`:

| `ingress.controller` | Аннотации контроллера | CRD | HTTP→HTTPS |
|---|---|---|---|
| `nginx` (дефолт) | `nginx.ingress.kubernetes.io/ssl-redirect: "true"` (при `redirectHttpToHttps: true`) | нет | на nginx-контроллере |
| `traefik` | `traefik.ingress.kubernetes.io/router.entrypoints` (при непустом `entrypoints`) | `Middleware` + `IngressRoute` (`web` → 301 `https`) при `redirectHttpToHttps: true` | на Traefik |
| `none` | нет | нет | не управляется чартом |

- `ingress.redirectHttpToHttps` (по умолчанию `true`) — включает редирект для
  выбранного контроллера. Для `none` игнорируется.
- `ingress.entrypoints` — **только для Traefik**; аннотация добавляется лишь
  при непустом значении.
- `ingress.annotations: {}` — произвольные аннотации Ingress, мержатся поверх
  авто-аннотаций контроллера. Например, для cert-manager:
  `cert-manager.io/cluster-issuer: letsencrypt-prod`.
- Блок `annotations:` в манифесте рендерится только если есть хотя бы одна
  аннотация (никакого `annotations: null`).

### TLS и редирект для nginx

Для nginx-редиректа нужен **настроенный TLS**: заполните `ingress.tls` с именем
существующего Secret (`secretName`), иначе контроллеру нечего отдавать по HTTPS
и редирект приведёт к ошибке. Секрет можно выпустить через cert-manager —
достаточно добавить его cluster-issuer в `ingress.annotations`.

Если TLS терминируется **выше** (внешний LB/прокси, а до пода доходит HTTP),
штатный nginx `ssl-redirect` не сработает — вместо него добавьте через
`ingress.annotations`:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
```

### Traefik

Для Traefik-редиректа укажите `ingress.controller: traefik` и (обычно)
`entrypoints: websecure`: приложение слушает `websecure`, а HTTP-трафик на `web`
перехватывает `IngressRoute` из `templates/traefik-redirect.yaml` и отвечает 301.

```yaml
ingress:
  enabled: true
  controller: traefik
  className: traefik
  entrypoints: websecure
  redirectHttpToHttps: true
  hosts:
    - host: synth.example.com
      paths:
        - { path: /, pathType: Prefix }
  tls:
    - secretName: synth-tls
      hosts: [synth.example.com]
```

> Traefik CRD (`Middleware`/`IngressRoute`) рендерятся **только** при
> `ingress.controller: traefik`; при других значениях чарт не создаёт
> Traefik-ресурсов.

## Обновление версии

Версия чарта синхронизирована с версией релиза приложения: `version` и
`appVersion` в `Chart.yaml` обновляются скриптом `scripts/version-bump.sh`
вместе с пакетами монорепозитория.
