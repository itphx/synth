# Чарт `synth`

Helm-чарт для развёртывания агентной платформы **Synth** в Kubernetes:
**backend** (API Hub: OIDC/RBAC + встроенный движок, JSON-хранилище) и
**ui** (React SPA под nginx, проксирует `/api /ws /auth /admin /health` на backend).

Чарт универсален: подходит для self-host у заказчиков и для preprod-инстансов.
Все значения по умолчанию нейтральны — окружение задаётся через `values`-файл
(см. [`values.example.yaml`](./values.example.yaml)).

## Архитектура

| Сервис | Образ (по умолчанию) | Порт | Роль |
|---|---|---|---|
| `backend` | `gitverse.ru/itphx/synth-backend` | 5000 | API Hub: OIDC + RBAC + движок; JSON-данные в PVC |
| `ui` | `gitverse.ru/itphx/synth-ui` | 8080 | React SPA под nginx; проксирует API на backend |

Backend самодостаточен (встроенный движок + JSON-хранилище в PVC), поэтому
отдельный runner не разворачивается. Хранилище JSON не масштабируется —
backend всегда 1 реплика.

## Требования

- Kubernetes ≥ 1.24, Helm 3.
- StorageClass для PVC backend (по умолчанию — класс кластера).
- (Опционально) Ingress-контроллер: nginx (по умолчанию) или Traefik — для
  авто-редиректа HTTP→HTTPS. Без контроллера чарт тоже работает
  (`ingress.controller: none`).
- Secret с секретами (см. ниже).

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
helm template synth charts/synth -f charts/synth/values.example.yaml
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
| `backend.config` | `{}` | Декларативный `config.yaml` backend (монтируется в `/etc/synth`) |
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
| `caCert` | `""` | PEM внутреннего CA (опционально) |
| `extraObjects` | `[]` | Произвольные дополнительные манифесты (рендерятся как есть) |

## Secret с секретами

Чарт **не создаёт** Secret — он должен существовать в namespace релиза.
Имя задаётся `secrets.existingSecret` (по умолчанию `synth-secrets`).

Ожидаемые ключи:

| Ключ | Когда нужен |
|---|---|
| `SYNTH_OIDC_CLIENT_SECRET` | при `backend.oidc.enabled: true` |
| `SYNTH_PROVIDER_<NAME>_API_KEY` | для каждого провайдера с `apiKey: true` (`<NAME>` — name в верхнем регистре, `-` → `_`) |

Пример:

```bash
kubectl create secret generic synth-secrets \
  --namespace synth \
  --from-literal=SYNTH_OIDC_CLIENT_SECRET='<client-secret>' \
  --from-literal=SYNTH_PROVIDER_OPENAI_API_KEY='<api-key>'
```

Секреты можно создавать любым способом: вручную, External Secrets Operator,
sealed-secrets и т.п. Зашифрованных секретов в чарте нет.

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
Пример — в `values.example.yaml` (закомментированный блок).

> Traefik CRD (`Middleware`/`IngressRoute`) рендерятся **только** при
> `ingress.controller: traefik`; при других значениях чарт не создаёт
> Traefik-ресурсов.

## Обновление версии

Версия чарта синхронизирована с версией релиза приложения: `version` и
`appVersion` в `Chart.yaml` обновляются скриптом `scripts/version-bump.sh`
вместе с пакетами монорепозитория.
