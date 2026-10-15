---
name: synth-k3s-deploy
description: Managed-деплой Synth в K3s (Rancher Fleet): test-инстанс (бандлы из Helm-реестра Gitea), preprod, prod, адреса, Keycloak, kubectl-доступ. Используй при работе с инстансами Synth.
---

# K3s-инстанс (managed-деплой)

Текущий managed-инстанс — **среда test** (внутренний тестовый). Развёрнут в K3s (Rancher Fleet) на `itphx.loc`. Код приложения — в монорепо `synth/`, код деплоя test-среды — в отдельном репозитории `synth-deploy/` (каталог рядом с `synth/`). Правила репозитория деплоя — `synth-deploy/AGENTS.md`, назначение и флоу — `synth-deploy/README.md`.

## Среды

| Среда | Адрес | Как разворачивается |
|-------|-------|---------------------|
| **test** | https://synth.k3s.itphx.loc | Fleet (`synth-deploy`): образы собираются локально и пушатся в `git.itphx.ru`, чарты публикуются в Helm-реестр Gitea (`synth-deploy/scripts/build-and-publish.sh`); Fleet разворачивает бандлы `synth-test` и `synth-gateway-telegram` |
| **preprod** | https://synth-release.k3s.itphx.loc | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты/заказчики сами | публикуемый Helm-чарт (self-host) |

preprod и prod ставятся из опубликованного Helm-чарта (`helm repo add synth https://gitverse.ru/api/packages/itphx/helm`), **не** через Fleet.

## Репозиторий деплоя (test)

Fleet-деплой **test-среды** (namespace `synth`). Репозиторий: `https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`. Один каталог верхнего уровня = один Fleet-бандл (= один helm-релиз); имя бандла и релиза — `<GitRepo>-<путь>`. **Чартов в репозитории нет**: они публикуются в приватный Helm-реестр Gitea, Fleet тянет их по `helm.repo`/`helm.chart`/`helm.version`.

| Каталог | Бандл / релиз | Что разворачивает |
|---|---|---|
| `test/` | `synth-test` | backend (API Hub: OIDC/RBAC, встроенный движок) + ui (SPA под nginx) + Ingress + ConfigMap'ы (`synth-env`, `synth-config`, `synth-itphx-ca`) + SealedSecret `synth-secrets` (`extraObjects`) |
| `gateway-telegram/` | `synth-gateway-telegram` | Telegram-шлюз (add-on, ADR-086/ADR-089): long-polling → `POST /api/v2/events`; Deployment/Service + SealedSecret `synth-gateway-telegram-secrets` (`extraObjects`); `dependsOn: [synth-test]` |

Каждый каталог содержит `fleet.yaml` (namespace + `helm: repo/chart/version`) и `values.yaml` (значения чарта бандла).

## Подготовка артефактов

`synth-deploy/scripts/build-and-publish.sh` собирает образы backend/ui (пушатся в `git.itphx.ru/itphx/*`) и публикует чарты `synth` и `synth-gateway-telegram` в приватный Helm-реестр Gitea (`https://git.itphx.ru/api/packages/itphx/helm`, нативный API `/api/charts`). Версия чарта — `<base>-<N>`, где `base` = `--app-version` для `synth` и `version` чарта add-on'а для шлюза, а `N` — автоинкремент по `index.yaml` реестра. Скрипт обновляет пиннинги версий — только строки с маркером `# sync: <ключ>` (`test/fleet.yaml` `chart-version`, `test/values.yaml` `backend-image-tag`/`ui-image-tag`, `gateway-telegram/*`); эти строки вручную не править.

```bash
cd synth-deploy
./scripts/build-and-publish.sh --dry-run --app-version X.Y.Z              # локальная проверка (lint + package + пиннинг)
GITEA_USER=… GITEA_TOKEN=… ./scripts/build-and-publish.sh --app-version X.Y.Z
GITEA_USER=… GITEA_TOKEN=… ./scripts/build-and-publish.sh --skip-images --app-version X.Y.Z   # только чарты
```

Флаги: `--app-version X.Y.Z`, `--skip-images`, `--skip-charts`, `--dry-run`, `--help`. Версия приложения при отсутствии флага берётся из запиненного `backend-image-tag` → `version` из `packages/synth/package.json`. Скрипт **не** коммитит и **не** пушит git; после прогона — ревью `git diff`.

## Предпосылки (в кластере)

- Secret `helm-gitea` (namespace `fleet-local`, ключи `username`/`password`) — креды Fleet к приватному Helm-реестру.
- Fleet GitRepo `synth` (namespace `fleet-local`, `synth-deploy/gitrepo.yaml`, применяется вручную) с полями: `paths: [test, gateway-telegram]` (каталог → бандл), `helmSecretName: helm-gitea`, `helmRepoURLRegex: "https://git\\.itphx\\.ru/api/packages/itphx/helm.*"` (allow-list реестра; Fleet v0.16.1).
- Secret `git.itphx.ru` (namespace `synth`, `kubernetes.io/dockerconfigjson`) — pull-secret образов backend/ui.
- SealedSecret'ы `synth-secrets` и `synth-gateway-telegram-secrets` — не отдельные объекты, а `extraObjects` в `values.yaml` соответствующего бандла.

## Деплой и проверки

Fleet поллит `main` раз в минуту. Деплой — `git push` в `main` после ревью `git diff` (пиннинги к этому моменту уже обновлены скриптом).

```bash
kubectl get bundles -A | grep synth                        # synth-test, synth-gateway-telegram → DEPLOYED
kubectl get bundledeployments -A | grep synth              # desiredReady == ready
kubectl -n fleet-local get gitrepo synth -o jsonpath='{.status.readyClusters}{"\n"}'
helm -n synth list                                         # synth-test, synth-gateway-telegram → deployed
kubectl -n synth rollout status deploy/synth-backend
kubectl -n synth get pvc synth-backend-data synth-gateway-telegram
curl -s https://synth.k3s.itphx.loc/health                 # {"status":"ok",…}
kubectl -n synth exec deploy/synth-backend -- cat /etc/synth/config.yaml   # декларативный конфиг (backend.config)
```

## Сохранение данных (PVC)

PVC `synth-backend-data` и `synth-gateway-telegram` создаются чартами; данные переживают снятие бандла/релиза только при `persistence.keepOnUninstall: true` (значение бандла) — чарт добавляет в **манифест** релиза аннотацию `helm.sh/resource-policy: keep`.

> **Предупреждение.** Ручной `kubectl annotate` живого PVC **не помогает**: при удалении релиза Helm фильтрует манифест релиза, а не живые объекты. Без `keepOnUninstall` снятие релиза удаляет PVC вместе с данными. Перед любой операцией, приводящей к удалению релиза, проверяйте аннотацию в рендере: `helm template synth-test ../synth/charts/synth -n synth -f test/values.yaml | grep 'resource-policy: keep'`.

## Smoke-тест доставки чарта из реестра

Быстрая проверка, что Fleet аутентифицируется в реестре (`helm-gitea`), доверяет внутреннему CA и тянет чарт: во временный каталог бандла кладётся `fleet.yaml` с `helm.repo/chart/version` любого опубликованного чарта (пример — `synth-deploy/probe/fleet.yaml`), каталог добавляется в `paths` GitRepo; бандл должен стать `1/1`, после чего каталог удаляется.

```bash
kubectl get bundles -A | grep synth-probe    # READY 1/1
helm -n synth list | grep synth-probe
```

## Откат

- **Версия приложения/чарта:** вернуть значение в маркерной строке (`test/values.yaml` `backend-image-tag` / `fleet.yaml` `chart-version`) → `git push` — Fleet сделает `helm upgrade` с прежней версией.
- **Один бандл:** убрать каталог из `paths` (или удалить каталог) → Fleet снимает бандл и релиз; PVC сохраняются при `keepOnUninstall: true`.
- **Релиз Helm:** `helm -n synth history synth-test` → `helm -n synth rollback synth-test <REV>`.

## Адреса (test)

| Сервис | Адрес |
|--------|-------|
| Synth UI (вход) | https://synth.k3s.itphx.loc |
| Keycloak issuer | https://keycloak.itphx.loc/realms/synth (клиент `synth`, confidential) |
| Backend в кластере | `synth-backend:5000` (namespace `synth`) |
| Telegram-шлюз (health) | `synth-gateway-telegram:7100/health` |

Доступ к кластеру: `kubectl` (контекст `local`), поды/логи — `kubectl -n synth get pods`, `kubectl -n synth logs deploy/synth-backend`.

## Учётные записи Keycloak

Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле `secrets/keycloak-accounts.md` в корне проекта, вне git-репозитория `synth/`.

Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики ролей и мапперов. Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`, ключ `SYNTH_OIDC_CLIENT_SECRET`), команда для получения — в файле секретов.
