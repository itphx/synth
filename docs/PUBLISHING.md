# Публикация и релиз

> 🌐 [English](./en/PUBLISHING.md) · **Русский**

Руководство для разработчика/поддержки: как собирать, публиковать и выпускать релизы Synth. Все команды выполняются из корня монорепозитория (`synth/`).

## Порядок публикации пакетов

Публикуются **все 7 пакетов** в строгом порядке зависимостей:

```
shared → core → storage-postgres → ui → backend → sdk → synth
```

Порядок задан иерархией зависимостей: `@itphx/synth-shared` — фундамент, `@itphx/synth-core` импортирует shared, `@itphx/synth-storage-postgres` — опциональный драйвер слоя хранения (`peerDependencies: @itphx/synth-core`, `pg` — `optionalDependencies`, ADR-097/PROP-032), `@itphx/synth-backend`/`@itphx/synth-ui` импортируют core, `@itphx/synth-sdk` — тонкий клиент публичного API над shared (ADR-052), `@itphx/synth` — тонкая обёртка над core/ui/shared (ADR-038).

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

Дополнительно **все три базовых образа** (`synth`, `synth-backend`, `synth-ui`) зеркалируются в GitHub Container Registry: `ghcr.io/itphx/synth:<version>`, `ghcr.io/itphx/synth-backend:<version>`, `ghcr.io/itphx/synth-ui:<version>`. Политика — в разделе [Релиз в GitHub-зеркале](#релиз-в-github-зеркале).

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

### `release-github.sh` — backfill GitHub-зеркала

```bash
./scripts/release-github.sh --version 0.10.0 --dry-run             # план без действий
./scripts/release-github.sh --version 0.10.0 --push-refs --yes     # зеркало refs (master→main + теги)
./scripts/release-github.sh --version 0.10.0 --release --yes       # GitHub Release + ассеты
./scripts/release-github.sh --version 0.10.0 --push-refs --release --yes
```

Локальный backfill GitHub-зеркала: синхронизирует refs и создаёт/обновляет GitHub Release.
Docker-образы **не** собирает (их собирает CI GitVerse → `gitverse.ru` + `ghcr.io`), npm не
публикует. Подробности — [Релиз в GitHub-зеркале](#релиз-в-github-зеркале).

### `changelog.sh` — тело релиза

```bash
./scripts/changelog.sh                                  # RU, changelog-partial.md
./scripts/changelog.sh --lang en --out tmp/changelog-en.md
./scripts/changelog.sh --help
```

Опции: `--lang <ru|en>` (по умолчанию `ru`), `--out <path>` (по умолчанию `changelog-partial.md`).
Версия берётся из `packages/synth/package.json` (`<VERSION>`). О роли описаний релизов — см.
[Описания релизов](#описания-релизов).

## Описания релизов

Каждому релизу соответствует **пара** файлов в `docs/releases/`; `changelog.sh` берёт файл
**целиком** и подставляет его как тело релиза (при наличии файла авто-сборка из коммитов не
запускается). Поэтому описания готовятся заранее — до публикации тега.

| Файл | Язык | Куда идёт тело |
|------|------|----------------|
| `docs/releases/<VERSION>.md` | русский | тело **GitVerse Release** (job `create-release`) |
| `docs/releases/<VERSION>.en.md` | английский | тело **GitHub Release** (job `publish-github`) |

Что писать: что вошло в релиз, ключевые изменения, **breaking changes**, блок установки
(команды `npm`/`docker`/`helm`). Ориентир по структуре — [`docs/releases/0.10.0.md`](./releases/0.10.0.md).

Поведение `changelog.sh`:

- `--lang ru` (по умолчанию) — приоритет у `docs/releases/<VERSION>.md`;
- `--lang en` — приоритет у `docs/releases/<VERSION>.en.md`; если его нет, но есть RU-файл —
  используется RU-файл и печатается предупреждение (`[changelog] НЕТ английского описания …`);
  если нет ни одного — авто-сборка из коммитов между предыдущим тегом и HEAD (с предупреждением).

Пример имён для версии `0.10.1`: `docs/releases/0.10.1.md` и `docs/releases/0.10.1.en.md`.

## CI/CD (GitVerse)

**Принцип: сборка и публикация — только на тегах релизов; обычный push — тесты; мелкие (доковые) пуши — облегчённая проверка.**

| Workflow | Триггер | Содержание |
|---|---|---|
| `.gitverse/workflows/release.yaml` | push тега `v*` + `workflow_dispatch` | **сборка и публикация** релиза (включая GitHub-зеркало и релиз) |
| `.gitverse/workflows/ci.yaml` | push в `main`/`master`/`feature/**`/`fix/**`/`refactor/**`/`chore/**`/`docs/**` и PR | тесты кода: typecheck, lint, тесты `shared`/`core`/`backend`/`ui`/`sdk`, `helm lint` + `template`, `pnpm audit --audit-level=high` (report-only) |
| `.gitverse/workflows/ci-docs.yaml` | push в `main`/`master`/`feature/**` и PR, изменения по `paths` (доки/AGENTS.md/скрипты проверок) | `node scripts/adr-check.mjs` + `node scripts/docs-link-check.mjs` |

Разделение сделано через `paths`/`paths-ignore`: у `ci.yaml` в `paths-ignore` есть `docs/**` и `**/*.md`, поэтому доковые пуши не гоняют тяжёлые джобы; у `ci-docs.yaml` наоборот — `paths` только по докам, и джоба не ставит pnpm (скрипты на голом node).

### Запуск релиза

1. **Dry-run:** `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. **Реальная публикация:** `workflow_dispatch` с `dry_run: false` (входы: `bump` patch/minor/major, `pre_release`)
3. **Автоматически:** создать тег `vX.Y.Z` и запушить — workflow запустится по push тега (пропускает bump-стадию, версия берётся из тега)

Ручной `workflow_dispatch` сохранён в `release.yaml` (пункты 1–2) — это единственный способ запустить сборку/публикацию без тега.

Релизный workflow: bump версии (version.ts + package.json + `charts/synth/Chart.yaml`) → CI-проверки → сборка → CHANGELOG → публикация npmjs → публикация GitVerse npm → Docker (kaniko → `gitverse.ru/itphx/{synth,synth-backend,synth-ui}` + `ghcr.io/itphx/{synth,synth-backend,synth-ui}`) → публикация Helm-чарта (`publish-helm`) → создание GitVerse Release → GitHub-зеркало (`publish-github`: push `main`+теги, GitHub Release).

npm-пакеты публикуются **только** из GitVerse (`publish-npmjs`/`publish-gitverse-npm`) — GitHub-контур npm не публикует.

### Проверка документации

`ci-docs.yaml` (job `docs-check`) запускается на доковые изменения и проверяет:

- `node scripts/adr-check.mjs` — индекс AD, целостность ссылок и канонических статусов;
- `node scripts/docs-link-check.mjs` — относительные ссылки `[..](path)` в `docs/**` (кроме `docs/arch_decisions/**`), `README.md`, `AGENTS.md`, `packages/*/AGENTS.md`; внешние ссылки, якоря `#…`, fenced code-блоки и inline code пропускаются, при битой ссылке — exit 1 с локацией `файл:строка → ссылка`.

Локально то же самое:

```bash
node scripts/adr-check.mjs && node scripts/docs-link-check.mjs
```

### Особенности GitVerse CI

1. **`actions/setup-node@v4` не использовать** — вместо этого `npm install -g pnpm@latest`
2. **`${{ env.VAR }}` не работает** — резолвится в Go-строку `%!t(string=...)`. Значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает. Сложный bash выносить в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub; в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Версия Node.js в раннере: 22 (предустановлена).
6. **Версия в npmjs появляется с задержкой 4–6 мин** (автоматический review/репликация). Бюджет
   верификации в `scripts/publish-packages.sh` — 15 мин (`VERIFY_TIMEOUT=900`), таймаут джобы
   `publish-npmjs` — 30 мин; на 0.10.1 джоба была срезана таймаутом уже после публикации всех
   6 пакетов.
7. **Перезапустить run с повторной загрузкой артефакта нельзя** — `actions/upload-artifact@v4` падает
   с `Failed to CreateArtifact (409) Conflict`, пока живы артефакты предыдущего прогона. Обход: снять
   артефакты рана через API (`GET /repos/{owner}/{repo}/actions/artifacts` → `DELETE
   /repos/{owner}/{repo}/actions/artifacts/{id}` → 204), затем `POST /repos/{owner}/{repo}/actions/runs/{id}/rerun`.

### Секреты

| Secret | Назначение |
|--------|------------|
| `NPM_TOKEN` | Публикация в npmjs.org |
| `GV_TOKEN` | Единый токен GitVerse (API, Docker Registry, npm registry, git push от бота) |
| `GH_TOKEN` | GitHub-зеркало: push refs, GitHub Release, публикация базовых образов в GHCR (classic PAT, scope `repo` + `write:packages`) |
| `GHCR_USER` | Необязательно: логин владельца `GH_TOKEN` для `ghcr.io` (по умолчанию `itphx`) |
| `GV_SYNTH_URL` | База API v2 инстанса Synth для события релиза (например `https://synth.k3s.itphx.loc/api/v2`) |
| `GV_SYNTH_MEDIA_KEY` | Service-key Synth со scope `events:ingest` — приём события релиза (см. «Событие релиза для synth-media») |

Префикс `GITVERSE_` запрещён в именах секретов GitVerse — использовать `GV_`.

## Событие релиза для synth-media

После релиза CI публикует в Synth **одно внешнее событие** — агент внутри Synth готовит черновик поста о релизе (скилл `media-hub`, подсистема `synth-media`).

### Как это работает

```text
release.yaml (джоба media-event)
        │  POST {SYNTH_URL}/api/v2/events
        │  Authorization: Bearer <service-key, scope events:ingest>
        │  {source: "ci", type: "release_published", payload: {…}, dedupKey: "ci:release:vX.Y.Z"}
        ▼
Synth: EventIngress → Router (ADR-089)
        │  правило маршрутизации: source=ci / type=release_published → ephemeral-сессия агента
        ▼
Агент (publisher) по скиллу media-hub: draft_create → draft_render → draft_submit
        ▼
Владелец: approve / rewrite / reject в UI synth-media (публикация — за коннектором)
```

**Факты собирает CI-хук, а не агент.** Агент внутри Synth не имеет доступа к репозиторию (workspace-политика `deny`, файловые/гит-тулы требуют workspace проекта), поэтому всё нужное для текста поста приходит в `payload` события.

### Скрипт `scripts/media-release-event.sh`

Собирает факты релиза и публикует событие:

| Источник факта | Что берётся |
|---|---|
| тег релиза | `--tag` / `SYNTH_RELEASE_TAG` → тег на `HEAD` → `v<версия>` из `packages/synth/package.json` |
| предыдущий тег | список semver-тегов (`git tag --sort=-v:refname`) — соседний перед текущим |
| описание релиза | `--changelog` → `changelog-partial.md` (артефакт джобы `changelog`) → `docs/releases/<VERSION>.md` → генерация `scripts/changelog.sh` → `CHANGELOG.md` |
| highlights | до 7 строк из описания релиза без markdown-заголовков (вводный абзац + пункты списка) |
| коммиты | `git log PREV..TAG --no-merges` (`sha` + `subject`), максимум 100 |
| новые AD | файлы, добавленные в `docs/arch_decisions/` после прошлого релиза; суть и статус — из таблицы AD-индекса в `AGENTS.md` |

Формат события:

```json
{
  "source": "ci",
  "type": "release_published",
  "dedupKey": "ci:release:v0.11.3",
  "payload": {
    "kind": "release",
    "version": "0.11.3",
    "previousVersion": "0.10.1",
    "tag": "v0.11.3",
    "date": "2026-10-20",
    "repo": "https://gitverse.ru/itphx/synth.git",
    "highlights": ["…"],
    "commits": [{ "sha": "…", "subject": "…" }],
    "ads": [{ "id": "ADR-089", "title": "…", "status": "✅ Реализовано" }],
    "changelog": "…markdown…"
  }
}
```

`dedupKey` привязан к **релизу**, а не к прогону: повторный запуск джобы (re-run) не создаст второе событие и вторую сессию.

### Локальная проверка

```bash
# собрать событие и напечатать JSON — ничего не отправляется
bash scripts/media-release-event.sh --dry-run

# отправить в свой инстанс
SYNTH_URL=http://localhost:5000/api/v2 \
SYNTH_MEDIA_KEY=<service-key> \
bash scripts/media-release-event.sh
```

Флаги: `--dry-run`, `--url`, `--key`, `--tag`, `--version`, `--changelog`, `--repo`, `--max-highlights`, `--max-commits`. Скрипт читает репозиторий и шлёт **одно** событие — ничего не коммитит и не пушит; ключ не печатается в лог (`curl -sS` без `-v`).

### Секреты GitVerse

| Секрет | Что положить | Где взять |
|---|---|---|
| `GV_SYNTH_URL` | Базовый URL API v2 инстанса, который принимает событие (например `https://synth.k3s.itphx.loc/api/v2`) | адрес стенда |
| `GV_SYNTH_MEDIA_KEY` | Секрет service-key (`synth_svc_…`) со scope `events:ingest` | `POST /api/v2/service-keys` на нужном инстансе (секрет отдаётся один раз) |

Ключи и токены **не хранятся в git**: в репозитории `synth-deploy` секретов нет, рабочие значения лежат в `secrets/` вне репозитория.

### Отказоустойчивость

Публикация поста **не блокирует релиз**:

- джоба `media-event` идёт с `continue-on-error: true`, и ни одна джоба релиза от неё не зависит;
- нет секретов → публикация пропускается с предупреждением, код `0`;
- Synth недоступен или ответил не-2xx → предупреждение в лог и код `3` (джоба остаётся «мягко упавшей», релиз не срывается);
- код `2` — только ошибка использования (неизвестный флаг).

Шаг в джобе: `bash scripts/media-release-event.sh` (сложный bash вынесен в файл — особенность GitVerse, см. «Особенности GitVerse CI»).

## Релиз в GitHub-зеркале

GitHub — **зеркало и релизы**, а не билд-контур. GitHub Actions в репозитории **не используются**: все workflow живут в CI GitVerse (`.gitverse/workflows/`), и GitHub получает только уже собранное.

### Политика образов

Все три **базовых образа** публикуются в оба реестра — `gitverse.ru` (основной) и GitHub Container Registry (`ghcr.io`):

| Образ | `gitverse.ru` | GHCR (`ghcr.io/itphx/…`) | Docker Hub |
|---|---|---|---|
| `synth` | ✅ | ✅ (зеркало) | — |
| `synth-backend` | ✅ | ✅ (зеркало) | — |
| `synth-ui` | ✅ | ✅ (зеркало) | — |

Ограничение по размеру артефактов (~500 МБ) касается не базовых образов, а **будущих дополнительных/full-образов** (flavor-образы из PROP-082: `dev`, `devops`, `browser`, `full` и т.п.) — когда они появятся, они пойдут **только в Docker Hub**. Публикуется только версионный тег (без `latest`) — та же политика, что и в GitVerse-контуре.

### Что делает CI GitVerse

Джоба `publish-github` в `.gitverse/workflows/release.yaml` запускается после сборки/публикации npm и Docker (`build-docker`) и после джобы `changelog`:

1. **Зеркало:** push `master→main` и всех тегов в `https://github.com/itphx/synth.git` (только `main` + теги, никаких других ветвей);
2. **GitHub Release** для тега `v<version>` — тело **на английском**: `bash scripts/changelog.sh --lang en` берёт `docs/releases/<version>.en.md` (при отсутствии — русское описание с предупреждением, затем авто-сборка из коммитов), плюс англоязычный блок установки «Installation» (npm из npmjs.org/GitVerse, образ из `ghcr.io/itphx/synth:<version>`); создание идемпотентно (если релиз по тегу есть — тело обновляется);
3. **Ассеты — best-effort:** `cli.js` (артефакт джобы `build`), Helm-чарт (`helm package charts/synth`, версия из `Chart.yaml`), `SHA256SUMS`. Если файла нет — печатается предупреждение и работа продолжается; ошибка загрузки ассета **не валит** джобу, но видна в логе. На GitHub используется штатный `uploads.github.com` (в отличие от GitVerse API, который на ассеты отдаёт 500 — там ассет также best-effort).

Все три базовых образа (`synth`, `synth-backend`, `synth-ui`) собираются в джобе `build-docker` (kaniko) сразу в **два** реестра: `gitverse.ru/itphx/<image>:<version>` и `ghcr.io/itphx/<image>:<version>`. Авторизация в GHCR — из секрета `GH_TOKEN` (переиспользуется всеми тремя kaniko-шагами).

### Локальный backfill

`scripts/release-github.sh` — для «догона» исторических тегов и повторного релиза, когда CI GitVerse недоступен:

```bash
./scripts/release-github.sh --version 0.10.0 --dry-run                        # план без действий
./scripts/release-github.sh --version 0.10.0 --push-refs --yes                # зеркало refs (master→main + теги)
./scripts/release-github.sh --version 0.10.0 --release --yes                  # GitHub Release + ассеты
./scripts/release-github.sh --version 0.10.0 --push-refs --release --yes      # и то, и другое
```

Скрипт **не** собирает и не публикует Docker-образы (это делает CI GitVerse) и не публикует npm. Токен берётся из `GH_TOKEN` или `gh auth token` — в файле не хранится. Изменяющие операции требуют `--yes`.

### Почему без GitHub Actions

Осознанное решение: единственный билд-контур — CI GitVerse (kaniko). Дублирование сборки на GitHub ломало бы воспроизводимость (два источника истины для образов/релизов) и упиралось бы в лимиты артефактов. GitHub-контур намеренно тонкий: зеркало кода + релизы + публикация базовых образов в GHCR.

### Секреты GitHub-контура

- **`GH_TOKEN`** — classic PAT со scope `repo` + `write:packages` (push зеркала, GitHub Release, GHCR). `write:packages` — это classic-scope, поэтому **fine-grained PAT официально не поддерживается для GHCR CLI** — нужен classic. PAT лучше завести на **отдельном машинном аккаунте**, а не на личном.
- **`GHCR_USER`** (необязательно) — логин владельца PAT для `docker login ghcr.io`; по умолчанию `itphx`.

## Важно: поле `repository` в package.json

Для публикации в GitVerse Package Registry поле `repository` в `package.json` **должно отсутствовать**: GitVerse при привязке пакета к репозиторию по `repository.url` проверяет права и отдаёт 403 «no permission». Во всех 7 пакетах поле `repository` удалено — не добавляйте его обратно.

## Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```
