---
name: synth-build-publish
description: Сборка и публикация Synth: build.sh, publish.sh, version-bump.sh, npm (3 реестра), Docker и Helm в Gitea. Используй при сборке/публикации пакетов.
---

# Сборка и публикация

## Скрипты (в `synth/scripts/`)

| Скрипт | Назначение |
|--------|------------|
| `build.sh` | Полная сборка: shared → core → executor → storage-postgres → ui → sdk → synth. Опции: `--clean`, `--check`, `--docker`, `--docker-tag=X` |
| `publish.sh` | Публикация в npm. Опции: `--dry-run`, `--no-build`, `--registry=both\|npmjs\|gitverse`, `--docker` |
| `version-bump.sh` | Bump версии: `./version-bump.sh patch\|minor\|major\|X.Y.Z`. Обновляет `version.ts` + все `package.json` |
| `dev.sh` | Dev-запуск: backend (:5000) + UI (:5002). Аргументы: `backend\|ui\|core\|all` |
| `changelog.sh` | Генерация CHANGELOG.md из коммитов между тегами (используется в CI release) |

## Секреты (кратко)

| Секрет | Где используется |
|--------|------------------|
| `NPM_TOKEN` | публикация в npmjs.org |
| `GV_TOKEN` | npm-реестр GitVerse, API релизов GitVerse, git push от бота |
| `GH_TOKEN` | GitHub: зеркало refs, GitHub Release, npm в GitHub Packages (`write:packages`) |
| `GT_TOKEN` | Gitea `git.itphx.ru`: **образы** (`docker push`) и **Helm-чарт** |
| `GV_GITEA_TOKEN` | Gitea `git.itphx.ru`: npm-реестр Gitea (бета-пакеты) |

Локально вместо `GT_TOKEN`/`GV_GITEA_TOKEN` — переменная `GITEA_TOKEN`.

## Версионирование

Единая константа `SYNTH_VERSION` в `packages/shared/src/version.ts`.

При bump-е версии обновляются:
1. `packages/shared/src/version.ts` — константа `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 8 пакетах

Все hardcoded строки версии в коде заменены на импорт `SYNTH_VERSION` из `@itphx/synth-shared`.

## Публикация npm

Публикуются **все 8 пакетов** монорепозитория в строгом порядке зависимостей:

```
shared → core → executor → storage-postgres → ui → backend → sdk → synth
```

Порядок задан иерархией зависимостей: `executor` (`@itphx/synth-executor`, исполнитель
агентских команд, ADR-077; `peer-dep` core) публикуется после `core`; `sdk`
(`@itphx/synth-sdk`, клиент публичного API, ADR-052) — тонкий пакет над `shared`;
публикуется перед `synth`.

Для публикации используется **`pnpm publish`** (а не `npm publish`), т.к. он автоматически переписывает `workspace:*` в зависимостях на фактические версии workspace-пакетов.

Релиз публикует пакеты в **три** реестра (джобы `publish-npmjs`, `publish-gitverse-npm`,
`publish-github-npm` в `release.yaml`):

- `https://registry.npmjs.org` — токен `NPM_TOKEN`
- `https://gitverse.ru/api/packages/itphx/npm/` — токен `GV_TOKEN` (единый для всего GitVerse)
- `https://npm.pkg.github.com` (scope `@itphx`) — токен `GH_TOKEN` со scope `write:packages`
  (`scripts/publish-packages.sh` уже передаёт `--access public`; поле `repository` в `package.json`
  отсутствует — GitHub Packages требует, чтобы оно не указывало на чужой хостинг)

Бета-пакеты — только npm-реестр Gitea (`./scripts/publish-beta.sh`, токен `GV_GITEA_TOKEN`).

## Токены npmjs (важно, изменения npm 2026)

- **Старые классические токены без 2FA отозваны.** Нужен Granular Access Token (GAT) с 2FA (права `publish` на `@itphx/*`), либо классический токен при включённой 2FA.
- **Токены с `bypass 2FA` больше не публикуют напрямую.** При создании токена НЕ выбирать «bypass 2FA» — использовать обычный GAT.
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` выключены по умолчанию. Если нужны lifecycle-скрипты — `npm approve-scripts`/`--allow-scripts`.
- Долгосрочно npm рекомендует trusted publishing (OIDC) или staged publishing.

Проверка токена: `npm whoami --registry https://registry.npmjs.org`.

## Docker

Реестр образов один — **публичный Gitea** `git.itphx.ru/itphx` (анонимный pull,
`imagePullSecret` не обязателен; авторизация нужна только на push — секрет `GT_TOKEN`,
локально `GITEA_TOKEN`). gitverse.ru и ghcr.io для образов не используются. Теги версионные,
`latest` нет.

Образ собирается из npm-публикации: `npm install -g @itphx/synth@<version>` (зависимости ставятся как транзитивные npm-зависимости, промпты и UI резолвятся из node_modules) — **не** из workspace-сборки. Dockerfile: `docker/Dockerfile` (контекст — корень репозитория). Образ: `git.itphx.ru/itphx/synth:<version>`.

Все образы (версионные теги, без `latest`):

| Образ | Теги | Где публикуется |
|---|---|---|
| `synth` | `<версия>` (multi-arch amd64+arm64, manifest list best-effort) | `build-docker` → `git.itphx.ru/itphx/synth` |
| `synth-backend` | `<версия>` (slim), `<версия>-<flavor>` | slim — `build-docker`; flavor'ы — `publish-images-gitea` (`--no-slim`) |
| `synth-ui` | `<версия>` | `build-docker` |
| `synth-executor` | `<версия>-<flavor>` | `publish-images-gitea` |
| `synth-provisioner` | `<версия>` | `publish-images-gitea --only provisioner` |

Локально: `./scripts/publish-images.sh --tag-base <версия> [--dry-run|--skip-push]` (flavor'ы),
`./scripts/build.sh --docker --docker-tag=<версия>` (одиночный образ).

## Helm-чарт

Нативный Helm-реестр **Gitea** (не OCI): `https://git.itphx.ru/api/packages/itphx/helm`,
upload — `POST …/helm/api/charts` с Basic-авторизацией `itphx:$GT_TOKEN` (секрет CI —
`GT_TOKEN`; локально `GITEA_TOKEN`, фоллбек `GV_TOKEN`). Джоба `publish-helm`
(`CI_HELM_SOFT=1` — неудача не валит релиз), скрипт — `scripts/ci-helm.sh publish`.

```bash
helm repo add synth https://git.itphx.ru/api/packages/itphx/helm
helm install synth synth/synth --version <версия> -f my-values.yaml
```

Helm-реестр GitVerse больше не используется.

## Сборка core и ассеты

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/`; backend — аналогично для `definitions/`. Это **fallback для Docker**: источник истины промптов — `packages/core/prompts`, публикуется в npm через поле `files`.
