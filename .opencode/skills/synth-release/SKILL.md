---
name: synth-release
description: CI/CD GitVerse для Synth: workflow-файлы, секреты, особенности, запуск релиза. Используй при работе с CI или релизами.
---

# CI/CD (GitVerse)

## Workflow-файлы

| Файл | Назначение | Триггер |
|------|------------|---------|
| `.gitverse/workflows/ci.yaml` | CI: typecheck, lint, тесты | `push`, `pull_request` |
| `.gitverse/workflows/release.yaml` | Релиз: bump, сборка, npm, Docker, Release | `workflow_dispatch`, `push tags v*` |

## Секреты (настроены в репозитории)

| Secret | Назначение |
|--------|------------|
| `NPM_TOKEN` | Публикация в npmjs.org |
| `GV_TOKEN` | Единый токен GitVerse (API, Docker Registry, npm registry, git push от бота) |

**Важно:** префикс `GITVERSE_` запрещён в именах секретов GitVerse. Использовать `GV_`.

## Особенности GitVerse CI

1. **`actions/setup-node@v4`** — не использовать. Вместо этого: `npm install -g pnpm@latest`
2. **`${{ env.VAR }}`** — не работает, резолвится в Go-строку `%!t(string=...)`. Значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает. Выносить сложный bash в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub, в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Версия Node.js в раннере: 22 (предустановлена).

## Порядок сборки в CI

```
pnpm install --frozen-lockfile
pnpm --filter @itphx/synth-shared build    # обязательно перед typecheck!
pnpm --filter @itphx/synth-core build      # нужно для backend и runner
pnpm typecheck                       # рекурсивно по всем пакетам
pnpm lint
pnpm test
```

Без сборки `shared` и `core` перед `typecheck` — `@itphx/synth-runner` и `@itphx/synth-backend` не найдут типы.

## Запуск релиза

1. Dry-run: `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. Реальная публикация: `workflow_dispatch` с `dry_run: false`
3. Или вручную: создать тег `vX.Y.Z` и запушить — workflow запустится автоматически

## Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```
