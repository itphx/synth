# @itphx/synth-provisioner — provisioner пулов исполнения

Отдельный процесс (ADR-135, Ф4b-2a/4b-2b): по запросу control plane выдаёт
**адрес и токен пула** исполнителей. Ни сессий, ни хранилища Synth, ни LLM он не
знает; своего каталога данных у него нет — конфигурация **только env**
(`packages/provisioner/src/config.ts`, fail-closed: без токена/профилей процесс
не стартует).

## Контракт (HTTP)

| Метод | Путь | Смысл |
|---|---|---|
| `POST` | `/v1/pools` | `{key, scope, id?, class, profile, workspaceSubPath?, profileSpec?}` → `{url, token?}`; идемпотентно по ключу |
| `POST` | `/v1/pools/{key}/touch` | Продлить жизнь пула (idle-таймер) |
| `POST` | `/v1/pools/{key}/drain` | Удалить под с grace, секрет оставить |
| `DELETE` | `/v1/pools/{key}` | Удалить пул и секрет |
| `POST` | `/v1/images/warm` | Прогреть образы на нодах: `{images: string[]}` → `{results: [{image, ok, nodes, error?}]}` |
| `GET` | `/v1/capabilities` | Диагностика: провайдер, профили, протокол, лимиты |
| `GET` | `/health` | Liveness (единственный публичный маршрут) |
| `GET` | `/metrics` | Метрики (exposition 0.0.4, нужен bearer) |

Токен — `Authorization: Bearer <SYNTH_PROVISIONER_TOKEN>`, сравнение постоянное
по времени (`auth.ts`); `{key}` — URL-encoded канонический ключ пула. Клиент —
`HttpExecutionPoolProvider` в core (`packages/core/src/execution/pool-provider.ts`),
он же строит ключ (`poolKeyString`).

## Спецификация профиля (`profileSpec`)

Тело `POST /v1/pools` может нести `profileSpec` — **та же strict-схема**, что у
каталога `SYNTH_PROVISIONER_PROFILES` (`profileSchema` из `config.ts`). Спецификацию
шлёт control plane из эффективного каталога инстанца
(`execution.remote.profiles[<profile>]`) — так админ задаёт профили в UI, не
правя Helm values.

- **Приоритет: `profileSpec` > каталог provisioner'а.** `kubernetes` — под по
  спецификации (`image` обязателен, без образа — `400 invalid_request`; `url`
  игнорируется); `static` — поле **игнорирует** (адрес из `staticPools`/
  `profiles[].url`).
- `mcpServers` спецификации → env пода `SYNTH_EXECUTOR_MCP_SERVERS` (JSON).
- Поле аддитивное: запрос без него работает с любой версией provisioner'а; у
  **старого** provisioner'а тело строгое — запрос с `profileSpec` он отвергнет
  (`400`), поэтому provisioner новой версии обновляют раньше backend'а.

## Scheduling-поля профиля и ресурсы

Модель профиля (`profileSchema` в `config.ts`, каталог `SYNTH_PROVISIONER_PROFILES`
и `profileSpec` в теле `POST /v1/pools` — одна схема):

| Поле | Куда в pod spec | Правило |
|---|---|---|
| `annotations` | `metadata.annotations` | служебные `synth.io/*` **приоритетнее** |
| `labels` | `metadata.labels` | служебные `synth.io/*`, `app.kubernetes.io/*` **приоритетнее** |
| `nodeSelector` | `spec.nodeSelector` | ключ/значение — как у label'а Kubernetes |
| `tolerations` | `spec.tolerations` | `operator: Exists\|Equal`, `effect: NoSchedule\|PreferNoSchedule\|NoExecute` |
| `affinity` | `spec.affinity` | passthrough, предел 8 КиБ |
| `resources.requests/limits` | `resources` контейнера | **произвольные** ключи (`nvidia.com/gpu: "1"`), значения — quantity Kubernetes |

Валидация — fail-closed на разборе конфигурации (мусорный ключ label'а, не
quantity, неизвестный оператор toleration → provisioner не стартует).

## Прогрев образов (`POST /v1/images/warm`)

- Тело: `{images: string[]}` — непустой список (≤ **20**) docker-ref'ов
  (≤512 символов, без пробелов). Ответ: `{results: [{image, ok, nodes, error?}]}`.
- Провайдер `kubernetes`: для каждого образа создаётся **DaemonSet**
  (`synth.io/component=image-warmer`, метка с хешем образа,
  `imagePullPolicy: Always`, `command: ["sh","-c","sleep 60"]`), ждётся
  `numberReady >= desiredNumberScheduled` (до **300 с**), затем DaemonSet
  **удаляется** (образ остаётся в кэше ноды). Обработка образов —
  **последовательная**; ошибка одного образа не прерывает остальные.
- Провайдер `static` прогрева не умеет → `400 invalid_request`
  (`PoolService.warmImages`).
- Права: `apps/daemonsets` — `create`, `get`, `list`, `watch`, `delete`
  (`charts/synth/templates/provisioner-rbac.yaml`).
- На стороне control plane — `POST /api/v2/execution/images/warm` (core,
  `server/routes/execution.ts`): guard — `writeGuard` (managed: ADMIN),
  `501 EXECUTION_PROVIDER_UNAVAILABLE`, если провайдер не умеет прогрев.

## Провайдеры и жизненный цикл

- `static` — адрес из `profiles[].url`/`staticPools`; изоляции нет;
- `kubernetes` — `Pod` с образом профиля + `Secret` (`token`) в **одном**
  namespace; под монтирует PVC workspace с `subPath` (`workspaceSubPath`),
  находится по label `synth.io/pool-hash` и **усыновляется** после рестарта;
- уборщик снимает пулы по `idleTimeoutMs`/`sessionIdleTimeoutMs`/
  `maxLifetimeMs`, между `drain` и `release` — `drainGraceMs`; сверх
  `maxPools` — `429`.

## Развёртывание

Helm-шаблоны — `charts/synth/templates/provisioner-*.yaml` и values
`provisioner.*` (RBAC: поды create/get/list/watch/delete, секреты
create/get/delete, daemonsets create/get/list/watch/delete в namespace
релиза; образ — `docker/Dockerfile.provisioner`). Публикация —
`scripts/publish-images.sh --only provisioner` (отдельный шаг
`publish-images-gitea`). Документация: `docs/EXECUTION.md` §«Ф4b-2b»,
`docs/CONFIGURATION.md` §«Provisioner пулов», `docs/OBSERVABILITY.md`
§«Provisioner пулов», README чарта §«Provisioner пулов».

## Границы

- **Не** разбирает состояние сессий и не хранит пулы на диске: источник истины —
  labels подов/секретов (adopt) и память процесса (idle-таймеры сбрасываются
  рестартом).
- Управляет ресурсами только в **одном** namespace (namespace релиза).
- Прогрева пулов (`minWarm`) нет; прогрев **образов** (`/v1/images/warm`) —
  только у kubernetes-провайдера (создаёт DaemonSet, ждёт готовности, удаляет).
- Политика сети выбирает поды по label; API Kubernetes — по CIDR
  (`provisioner.networkPolicy.apiServerCidrs`), не по DNS.
- `executorMcp` динамического пула не собирается (это делает core).
- Секреты в образ/values не попадают (инвариант 13): токен — только env из
  Secret; токены пулов — в `Secret` кластера, в логи не пишутся.

## Тесты и проверки

```bash
pnpm --filter @itphx/synth-provisioner test        # vitest: config/auth/server/providers/lifecycle/metrics
pnpm --filter @itphx/synth-provisioner build
pnpm --filter @itphx/synth-provisioner typecheck
helm lint charts/synth
helm template synth charts/synth --set provisioner.enabled=true \
  --set provisioner.token.existingSecret=synth-provisioner-token \
  --set provisioner.kubernetes.workspacePvc=synth-workspace
```

Юнит-тесты кластер не поднимают: Kubernetes-клиент подменяется in-memory
(`kubernetes.ts`/`kubernetes.test.ts`), под-манифест проверяется чистой
функцией `buildPoolPodManifest`, манифест прогрева — `buildImageWarmerManifest`.
