# @itphx/synth-provisioner — provisioner пулов исполнения

Отдельный процесс (PROP-135, Ф4b-2a/4b-2b): по запросу control plane выдаёт
**адрес и токен пула** исполнителей. Ни сессий, ни хранилища Synth, ни LLM он не
знает; своего каталога данных у него нет — конфигурация **только env**
(`packages/provisioner/src/config.ts`, fail-closed: без токена/профилей процесс
не стартует).

## Контракт (HTTP)

| Метод | Путь | Смысл |
|---|---|---|
| `POST` | `/v1/pools` | `{key, scope, id?, class, profile, workspaceSubPath?}` → `{url, token?}`; идемпотентно по ключу |
| `POST` | `/v1/pools/{key}/touch` | Продлить жизнь пула (idle-таймер) |
| `POST` | `/v1/pools/{key}/drain` | Удалить под с grace, секрет оставить |
| `DELETE` | `/v1/pools/{key}` | Удалить пул и секрет |
| `GET` | `/v1/capabilities` | Диагностика: провайдер, профили, протокол, лимиты |
| `GET` | `/health` | Liveness (единственный публичный маршрут) |
| `GET` | `/metrics` | Метрики (exposition 0.0.4, нужен bearer) |

Токен — `Authorization: Bearer <SYNTH_PROVISIONER_TOKEN>`, сравнение постоянное
по времени (`auth.ts`); `{key}` — URL-encoded канонический ключ пула. Клиент —
`HttpExecutionPoolProvider` в core (`packages/core/src/execution/pool-provider.ts`),
он же строит ключ (`poolKeyString`).

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
create/get/delete в namespace релиза; образ —
`docker/Dockerfile.provisioner`). Публикация —
`scripts/publish-images.sh --only provisioner` (отдельный шаг
`publish-images-gitea`). Документация: `docs/EXECUTION.md` §«Ф4b-2b»,
`docs/CONFIGURATION.md` §«Provisioner пулов», `docs/OBSERVABILITY.md`
§«Provisioner пулов», README чарта §«Provisioner пулов».

## Границы

- **Не** разбирает состояние сессий и не хранит пулы на диске: источник истины —
  labels подов/секретов (adopt) и память процесса (idle-таймеры сбрасываются
  рестартом).
- Управляет ресурсами только в **одном** namespace (namespace релиза).
- Прогрева пулов (`minWarm`) нет.
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
функцией `buildPoolPodManifest`.
