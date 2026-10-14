# Публикация и релиз

Руководство для разработчика/поддержки: как собирать, публиковать и выпускать релизы Synth. Все команды выполняются из корня монорепозитория (`synth/`).

## Порядок публикации пакетов

Публикуются **все 7 пакетов** в строгом порядке зависимостей:

```
shared → core → ui → backend → runner → sdk → synth
```

Порядок задан иерархией зависимостей: `@itphx/synth-shared` — фундамент, `@itphx/synth-core` импортирует shared, `@itphx/synth-backend`/`@itphx/synth-ui`/`@itphx/synth-runner` импортируют core, `@itphx/synth-sdk` — тонкий клиент публичного API над shared (AD-052), `@itphx/synth` — тонкая обёртка над core/ui/shared (AD-038).

## `pnpm publish` вместо `npm publish`

`npm publish` **не переписывает** `workspace:*` в зависимостях — опубликованные пакеты падают у npm-потребителей (не резолвится `workspace:*`). `pnpm publish` автоматически заменяет `workspace:*` на фактические версии workspace-пакетов, поэтому используется именно он.

Скрипты публикации используют флаг `--no-git-checks` (публикация идёт не из чистого git-дерева).

## Реестры

| Реестр | URL | Токен |
|--------|-----|-------|
| npmjs.org | `https://registry.npmjs.org` | `NPM_TOKEN` |
| GitVerse Package Registry | `https://gitverse.ru/api/packages/itphx/npm/` | `GV_TOKEN` |

Значения токенов хранятся в секретах репозитория (GitVerse CI) и в локальном окружении. **Никогда не указывайте значения токенов в документации, коде или коммитах.**

Проверка токена npmjs: `npm whoami --registry https://registry.npmjs.org`.

## Требования npm 2026 (важно)

С 2026 года npm ужесточил требования к публикации:

- **Старые классические токены без 2FA отозваны.** Для публикации нужен **Granular Access Token (GAT) с включённой 2FA** (права `publish` только на нужные пакеты `@itphx/*`) либо классический токен при включённой на аккаунте 2FA.
- **Токены с `bypass 2FA` не публикуют напрямую** (с января 2027 — только staged publishing с ручным 2FA-подтверждением). При создании токена НЕ выбирать «bypass 2FA» — использовать обычный GAT.
- **Токены GAT без права `unpublish`** не могут удалить опубликованную версию — вместо `npm unpublish` использовать `npm deprecate` (см. [Диагностика](TROUBLESHOOTING.md)).
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` выключены по умолчанию. Если при установке пакета нужны lifecycle-скрипты — `npm approve-scripts`/`--allow-scripts`.

## Docker-образ

Образ собирается из опубликованного npm-пакета: `npm install -g @itphx/synth@<version>` (зависимости `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared` ставятся как транзитивные, промпты и UI резолвятся из node_modules). Dockerfile: `docker/Dockerfile`.

Реестр Docker — **`gitverse.ru`** (не `registry.gitverse.ru`!). Образ:

```
gitverse.ru/itphx/synth:<version>
```

Тег `latest` **не публикуется** — в реестре остаются только версионные теги. Причина: квота «Пакеты» в GitVerse считает размер каждой версии без дедупликации — `latest` и версия указывают на один digest, но оплачиваются дважды (лимит 500 МБ на репозиторий). Поэтому `docker pull gitverse.ru/itphx/synth` без тега не работает — указывайте версию.

## Helm-чарт

Чарт приложения — `charts/synth/` в монорепозитории. Версия чарта и `appVersion` равны версии релиза: при bump в CI (`version-bump` в `release.yaml`) они обновляются вместе с `version.ts` и `package.json`.

Реестр — **нативный Helm-реестр GitVerse**, не OCI (путь `helm push oci://...` на GitVerse не используется):

```
https://gitverse.ru/api/packages/itphx/helm
```

Индекс-репозиторий — `https://gitverse.ru/api/packages/itphx/helm/index.yaml` (доступен анонимно).

### Публикация

В CI — job `publish-helm` в `.gitverse/workflows/release.yaml` (не запускается при `dry_run`): установка Helm → `helm lint charts/synth` → `helm package` → `curl` POST в `.../helm/api/charts` (успех = HTTP 201).

Вручную:

```bash
helm package charts/synth --version <version> --app-version <version> --destination dist/helm
curl --user "itphx:$GV_TOKEN" -X POST \
  --upload-file dist/helm/synth-<version>.tgz \
  https://gitverse.ru/api/packages/itphx/helm/api/charts
```

### Установка

```bash
helm repo add synth https://gitverse.ru/api/packages/itphx/helm
helm repo update
helm install synth synth/synth --version <version> -f my-values.yaml
```

Образы `gitverse.ru/itphx/synth{,-ui,-backend}:<version>` тянутся **анонимно** — imagePullSecret не нужен.

### Кастомные values

Кастомные values (адреса, секреты, ресурсы) хранятся в каталоге `secrets/` **вне git-репозитория** `synth/`. В репозитории лежит канонический набор значений с комментариями — `charts/synth/values.yaml` (переопределяется своим values-файлом/`--set`).

## Скрипты

Все скрипты — в `synth/scripts/`.

### `version-bump.sh` — bump версии

```bash
./scripts/version-bump.sh patch | minor | major | X.Y.Z
./scripts/version-bump.sh --dry-run 0.3.1   # проверка без изменений
```

Обновляет:
1. `packages/shared/src/version.ts` — константу `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 7 пакетах

Единый источник версии — `SYNTH_VERSION` в `packages/shared/src/version.ts` (импортируется из `@itphx/synth-shared`).

### `build.sh` — сборка

```bash
./scripts/build.sh                # полная сборка
./scripts/build.sh --check        # сборка + проверка типов и тестов
./scripts/build.sh --clean        # очистить dist перед сборкой
./scripts/build.sh --docker       # сборка + Docker-образ (тег по умолчанию: dev)
./scripts/build.sh --docker-tag=<tag>
./scripts/build.sh --docker-registry=<registry>
./scripts/build.sh --help         # справка
```

Результат: `packages/synth/dist/cli.js` (исполняемый CLI).

### `publish.sh` — публикация

```bash
./scripts/publish.sh                          # сборка + публикация (оба реестра)
./scripts/publish.sh --dry-run                # проверка без реальной публикации
./scripts/publish.sh --no-build               # без пересборки
./scripts/publish.sh --registry=npmjs | gitverse | both
./scripts/publish.sh --docker                 # также Docker-образ (только версионный тег)
./scripts/publish.sh --docker-tag=<tag>
```

Переменные окружения: `NPM_TOKEN`, `GV_TOKEN`, `NPM_REGISTRY`, `GITVERSE_NPM_REGISTRY`, `GITVERSE_DOCKER_REGISTRY`.

Особенность: GitVerse npm-реестр не поддерживает `/-/whoami` (404) — авторизация проверяется реальной публикацией.

## CI/CD (GitVerse)

Workflow-файлы: `.gitverse/workflows/ci.yaml` (push/PR: typecheck, lint, тесты, `helm lint`) и `.gitverse/workflows/release.yaml` (релиз).

### Запуск релиза

1. **Dry-run:** `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. **Реальная публикация:** `workflow_dispatch` с `dry_run: false` (входы: `bump` patch/minor/major, `pre_release`)
3. **Автоматически:** создать тег `vX.Y.Z` и запушить — workflow запустится по push тега (пропускает bump-стадию, версия берётся из тега)

Релизный workflow: bump версии (version.ts + package.json + `charts/synth/Chart.yaml`) → CI-проверки → сборка → CHANGELOG → публикация npmjs → публикация GitVerse npm → Docker (kaniko, `gitverse.ru/itphx/synth`) → публикация Helm-чарта (`publish-helm`) → создание GitVerse Release.

### Особенности GitVerse CI

1. **`actions/setup-node@v4` не использовать** — вместо этого `npm install -g pnpm@latest`
2. **`${{ env.VAR }}` не работает** — резолвится в Go-строку `%!t(string=...)`. Значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает. Сложный bash выносить в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub; в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Версия Node.js в раннере: 22 (предустановлена).

### Секреты

| Secret | Назначение |
|--------|------------|
| `NPM_TOKEN` | Публикация в npmjs.org |
| `GV_TOKEN` | Единый токен GitVerse (API, Docker Registry, npm registry, git push от бота) |

Префикс `GITVERSE_` запрещён в именах секретов GitVerse — использовать `GV_`.

## Важно: поле `repository` в package.json

Для публикации в GitVerse Package Registry поле `repository` в `package.json` **должно отсутствовать**: GitVerse при привязке пакета к репозиторию по `repository.url` проверяет права и отдаёт 403 «no permission». Во всех 7 пакетах поле `repository` удалено — не добавляйте его обратно.

## Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```
