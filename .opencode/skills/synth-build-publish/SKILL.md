---
name: synth-build-publish
description: Сборка и публикация Synth: build.sh, publish.sh, version-bump.sh, npm (2 реестра), Docker. Используй при сборке/публикации пакетов.
---

# Сборка и публикация

## Скрипты (в `synth/scripts/`)

| Скрипт | Назначение |
|--------|------------|
| `build.sh` | Полная сборка: shared → core → storage-postgres → ui → sdk → synth. Опции: `--clean`, `--check`, `--docker`, `--docker-tag=X` |
| `publish.sh` | Публикация в npm. Опции: `--dry-run`, `--no-build`, `--registry=both\|npmjs\|gitverse`, `--docker` |
| `version-bump.sh` | Bump версии: `./version-bump.sh patch\|minor\|major\|X.Y.Z`. Обновляет `version.ts` + все `package.json` |
| `dev.sh` | Dev-запуск: backend (:5000) + UI (:5002). Аргументы: `backend\|ui\|core\|all` |
| `changelog.sh` | Генерация CHANGELOG.md из коммитов между тегами (используется в CI release) |

## Версионирование

Единая константа `SYNTH_VERSION` в `packages/shared/src/version.ts`.

При bump-е версии обновляются:
1. `packages/shared/src/version.ts` — константа `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 7 пакетах

Все hardcoded строки версии в коде заменены на импорт `SYNTH_VERSION` из `@itphx/synth-shared`.

## Публикация npm

Публикуются **все 7 пакетов** монорепозитория в строгом порядке зависимостей:

```
shared → core → storage-postgres → ui → backend → sdk → synth
```

Порядок задан иерархией зависимостей: `sdk` (`@itphx/synth-sdk`, клиент публичного API, ADR-052) —
тонкий пакет над `shared`; публикуется перед `synth`.

Для публикации используется **`pnpm publish`** (а не `npm publish`), т.к. он автоматически переписывает `workspace:*` в зависимостях на фактические версии workspace-пакетов.

Два реестра:
- `https://registry.npmjs.org` — токен `NPM_TOKEN`
- `https://gitverse.ru/api/packages/itphx/npm/` — токен `GV_TOKEN` (единый для всего GitVerse)

## Токены npmjs (важно, изменения npm 2026)

- **Старые классические токены без 2FA отозваны.** Нужен Granular Access Token (GAT) с 2FA (права `publish` на `@itphx/*`), либо классический токен при включённой 2FA.
- **Токены с `bypass 2FA` больше не публикуют напрямую.** При создании токена НЕ выбирать «bypass 2FA» — использовать обычный GAT.
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` выключены по умолчанию. Если нужны lifecycle-скрипты — `npm approve-scripts`/`--allow-scripts`.
- Долгосрочно npm рекомендует trusted publishing (OIDC) или staged publishing.

Проверка токена: `npm whoami --registry https://registry.npmjs.org`.

## Docker

Образ собирается из npm-публикации: `npm install -g @itphx/synth@<version>` (зависимости ставятся как транзитивные npm-зависимости, промпты и UI резолвятся из node_modules) — **не** из workspace-сборки. Dockerfile: `docker/Dockerfile` (контекст — корень репозитория). Образ: `gitverse.ru/itphx/synth:<version>` (latest). Токен: `GV_TOKEN`.

## Сборка core и ассеты

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/`; backend — аналогично для `definitions/`. Это **fallback для Docker**: источник истины промптов — `packages/core/prompts`, публикуется в npm через поле `files`.
