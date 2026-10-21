---
name: synth-release
description: CI/CD GitVerse для Synth: workflow-файлы, секреты, особенности, запуск релиза. Используй при работе с CI или релизами.
---

# CI/CD (GitVerse)

## Workflow-файлы

| Файл | Назначение | Триггер |
|------|------------|---------|
| `.gitverse/workflows/ci.yaml` | CI: typecheck, lint, тесты | `push`, `pull_request` |
| `.gitverse/workflows/ci-docs.yaml` | Доки: `node scripts/adr-check.mjs` (индекс/статусы ADR/PROP) + `node scripts/docs-link-check.mjs` (относительные ссылки) | `push`/PR по доковым путям (`docs/**`, `**/*.md`, `AGENTS.md`, `packages/*/AGENTS.md`, `scripts/{adr-check,docs-link-check}.mjs`) |
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

## Грабли (проверено на 0.10.1)

- **npmjs публикует версию медленно** — версия видна в реестре через 4–6 мин (автоматический
  review/репликация). Бюджет верификации в `scripts/publish-packages.sh` — 15 мин
  (`VERIFY_TIMEOUT=900`), таймаут джобы `publish-npmjs` — 30 мин. Иначе получается расклад
  «все 8 пакетов опубликованы, а джоба срезана таймаутом».
- **Перезапуск run в GitVerse падает на `actions/upload-artifact@v4`** →
  `Failed to CreateArtifact (409) Conflict`: артефакты предыдущего прогона ещё существуют.
  Перед `POST /repos/{owner}/{repo}/actions/runs/{id}/rerun` нужно снять артефакты рана:
  `GET .../actions/artifacts` → `DELETE .../actions/artifacts/{id}` (204).
- **Джоба `build-docker` публикует в ДВА реестра** (gitverse.ru + ghcr.io) — шесть пушей на три
  образа, при этом kaniko стартует поздно (pull образа исполнителя). Таймаут держать ≥45 мин.
- **`scripts/publish-release.mjs` для GitHub требует `target_commitish`** = ветка/SHA: если передать
  имя тега, GitHub отвечает `422 invalid target_commitish` (воспроизведено на v0.10.1). По умолчанию
  для GitHub берётся `GITHUB_SHA` → `main` (для GitVerse — тег, как было).
- **Образы GHCR создаются приватными**, если публикуются PAT'ом (не GitHub Actions). Анонимный
  `docker pull ghcr.io/...` заработает только после переключения видимости пакета в public в UI
  GitHub Packages.

## Порядок сборки в CI

```
pnpm install --frozen-lockfile
pnpm --filter @itphx/synth-shared build    # обязательно перед typecheck!
pnpm --filter @itphx/synth-core build      # нужно для backend
pnpm typecheck                       # рекурсивно по всем пакетам
pnpm lint
pnpm test
```

Без сборки `shared` и `core` перед `typecheck` — `@itphx/synth-backend` и остальные пакеты не найдут типы.

## Запуск релиза

1. Dry-run: `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. Реальная публикация: `workflow_dispatch` с `dry_run: false`
3. Или вручную: создать тег `vX.Y.Z` и запушить — workflow запустится автоматически

## Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Для правок документации дополнительно: `node scripts/adr-check.mjs && node scripts/docs-link-check.mjs`
(это же гоняет `ci-docs.yaml`).

## Квота пакетов GitVerse — предварительная очистка

**Лимит: 500 МБ на репозиторий.** Смотреть «Настройки репозитория → Лимиты» → блок «Пакеты»
(отдельные лимиты: сборочные артефакты 500 МБ, релизы 4 ГБ, LFS 2 ГБ).
При переполнении реестр отдаёт **403 на push** → падает джоба «Docker образ» → релиз не выходит.

**Как считается:** сумма размеров **всех версий всех пакетов без дедупликации**:

- каждый тег контейнера оплачивается размером образа целиком; `latest` и версия указывают на
  один digest, но считаются **дважды**;
- npm — по размеру тарболлов каждой версии; helm — по размеру `.tgz`.

Замер на 0.9.0 (совпал с UI-счётчиком 607,4 МБ из 500):

| Что | Расчёт | МБ |
|---|---|---|
| Контейнеры | `synth` 84,9×2 + `synth-backend` 63,4×2 + `synth-ui` 28,0×2 + `synth-gateway-telegram` 108,6×2 | 569,8 |
| npm | 6 пакетов × 12 версий (72 тарболла) | 37,4 |
| Helm | 8 чартов × ~10 КБ | 0,1 |

Отсюда правило: **`latest` не публикуем** — 3 образа × (версия + `latest`) ≈ 570 МБ, это перелимит
сам по себе. В `release.yaml` у kaniko должны быть только версионные `--destination`.

**Что уже делает CI:** шаг «Очистка старых Docker-образов» (`release.yaml`, перед kaniko) —
`node scripts/docker-cleanup.mjs synth synth-backend synth-ui` удаляет все теги этих образов.
Образ аддона `synth-gateway-telegram` в список **не входит**, хотя считается в эту же квоту.

### Чек-лист перед релизом

1. «Лимиты» репозитория `itphx/synth` → «Пакеты». Использовано больше ~450 МБ — чистить до релиза.
2. Посчитать объём публикации (3 образа без `latest` + npm/helm) и убедиться, что запас положительный.
   Размер образа = `sum(layers[].size) + config.size` из манифеста.
3. Лишние контейнерные теги — distribution API (auth: Basic `itphx:$GV_TOKEN`):

```bash
curl -s  -u "itphx:$TOKEN" https://gitverse.ru/v2/itphx/<image>/tags/list
curl -sI -u "itphx:$TOKEN" -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
     https://gitverse.ru/v2/itphx/<image>/manifests/<tag>     # -> Docker-Content-Digest
curl -s  -u "itphx:$TOKEN" -X DELETE \
     https://gitverse.ru/v2/itphx/<image>/manifests/<digest>  # 202
```

Удаление идёт **по digest** и снимает **все** теги на него: если `latest` и версия — один digest,
точечно снять только `latest` нельзя, образ уходит целиком. То же делает `docker-cleanup.mjs`.

4. npm/helm — удаление только через UI GitVerse (страница пакета → «Удалить»): публичный API
   удаления не поддерживает (`POST /api/users/itphx/packages/{type}/{name}/versions/{version}/settings/delete`
   с PAT → `404`, работает лишь из веб-сессии). Чтение доступно (auth: `Authorization: token <PAT>`):
   `GET /api/users/itphx/packages?limit=100`,
   `GET /api/users/itphx/packages/{type}/{name}/versions/{version}` — `type` строчными: `container` | `helm` | `npm`.
5. Артефакты Actions (`synth-bundle`, `changelog`) — **отдельный** лимит 500 МБ, живут 30 дней,
   удаления через публичный API нет; квоту пакетов не занимают.

Если меняются `--destination` в `release.yaml` (например, возвращается `latest`) — синхронизировать
`docs/PUBLISHING.md`.

## Описание релиза

Тело GitVerse Release собирает джоба `changelog` (`scripts/changelog.sh`):

1. если есть **`docs/releases/<version>.md`** — используется он **как есть** (структурированное
   описание: разделы по подсистемам, AD, артефакты; обязательный минимум — «что вошло», «артефакты»,
   «установка/особенности»);
2. иначе — авто-список коммитов между тегами (`feat`/`fix`/`chore|refactor|docs`).

Порядок для релиза: сначала закоммитить `docs/releases/<version>.md` в `master`, потом ставить тег —
иначе CI возьмёт авто-список. Блок «## Установка» CI добавляет сам (в файл его не писать).

## Создание GitVerse Release (почему не `actions/create-release`)

GitVerse **сам создаёт релиз** для тега в момент push тега — с пустым/чужим телом, а `POST /releases`
для уже существующего git-тега отвечает `409 TAG_EXISTS`. Поэтому `actions/create-release@v1` падает
(«Release with tag … not found. Creating a new one…» → `404`, затем `context canceled … 404`) —
на релизах 0.8.8/0.9.0/0.10.0 тело проставляли вручную.

Сейчас в джобе `create-release` используется `scripts/publish-release.mjs`: находит релиз по `tag_name`
(с пагинацией) и делает идемпотентный `PATCH` тела; если релиза нет — `POST /releases`, при `409` —
повторный поиск и `PATCH`. Ассет `cli.js` грузится **best-effort**: API GitVerse сейчас отвечает
`500 INTERNAL_ERROR` (и на multipart, и на raw), скрипт пишет предупреждение и не роняет джобу —
когда API починят, ассет начнёт прикладываться без изменений.

API для ручных операций: `Authorization: Bearer $GV_TOKEN` + `Accept: application/vnd.gitverse.object+json;version=1`,
база `https://api.gitverse.ru/repos/itphx/synth` (`GET /releases`, `PATCH /releases/{id}`).
