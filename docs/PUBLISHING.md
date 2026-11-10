# Публикация и релиз

> 🌐 [English](./en/PUBLISHING.md) · **Русский**

Руководство для разработчика/поддержки: как собирать, публиковать и выпускать релизы Synth. Все команды выполняются из корня монорепозитория (`synth/`).

## Порядок публикации пакетов

Публикуются **все 8 пакетов** в строгом порядке зависимостей:

```
shared → core → executor → storage-postgres → ui → backend → sdk → synth
```

Порядок задан иерархией зависимостей: `@itphx/synth-shared` — фундамент, `@itphx/synth-core` импортирует shared, `@itphx/synth-executor` — исполнитель агентских команд (`dependencies`: `@itphx/synth-shared`, `peerDependencies`: `@itphx/synth-core`, ADR-077), `@itphx/synth-storage-postgres` — опциональный драйвер слоя хранения (`peerDependencies: @itphx/synth-core`, `pg` — `optionalDependencies`, ADR-097), `@itphx/synth-backend`/`@itphx/synth-ui` импортируют core, `@itphx/synth-sdk` — тонкий клиент публичного API над shared (ADR-052), `@itphx/synth` — тонкая обёртка над core/ui/shared (ADR-038).

## `pnpm publish` вместо `npm publish`

`npm publish` **не переписывает** `workspace:*` в зависимостях — опубликованные пакеты падают у npm-потребителей (не резолвится `workspace:*`). `pnpm publish` автоматически заменяет `workspace:*` на фактические версии workspace-пакетов, поэтому используется именно он.

Скрипты публикации используют флаг `--no-git-checks` (публикация идёт не из чистого git-дерева).

## Реестры

| Реестр | URL | Токен |
|--------|-----|-------|
| npmjs.org | `https://registry.npmjs.org` | `NPM_TOKEN` |
| GitVerse Package Registry | `https://gitverse.ru/api/packages/itphx/npm/` | `GV_TOKEN` |
| Gitea Package Registry | `https://git.itphx.ru/api/packages/itphx/npm/` | `GITEA_NPM_TOKEN` (публикация; для установки — read-токен) |

Значения токенов хранятся в секретах репозитория (GitVerse CI) и в локальном окружении. **Никогда не указывайте значения токенов в документации, коде или коммитах.**

Проверка токена npmjs: `npm whoami --registry https://registry.npmjs.org`.

## Требования npm 2026 (важно)

С 2026 года npm ужесточил требования к публикации:

- **Старые классические токены без 2FA отозваны.** Для публикации нужен **Granular Access Token (GAT) с включённой 2FA** (права `publish` только на нужные пакеты `@itphx/*`) либо классический токен при включённой на аккаунте 2FA.
- **Токены с `bypass 2FA` не публикуют напрямую** (с января 2027 — только staged publishing с ручным 2FA-подтверждением). При создании токена НЕ выбирать «bypass 2FA» — использовать обычный GAT.
- **Токены GAT без права `unpublish`** не могут удалить опубликованную версию — вместо `npm unpublish` использовать `npm deprecate` (см. [Диагностика](TROUBLESHOOTING.md)).
- **npm v12**: `allowScripts`/`--allow-git`/`--allow-remote` выключены по умолчанию. Если при установке пакета нужны lifecycle-скрипты — `npm approve-scripts`/`--allow-scripts`.

## Бета-версии (Gitea)

Бета-канал — быстрый путь «как у пользователя»: пакеты публикуются в **Gitea Package Registry** (`git.itphx.ru`) и ставятся оттуда одной командой, без сборки из исходников. Это нужно, чтобы проверить локальный запуск и гибридный режим на той же поставке, что получают потребители, не дожидаясь релиза в npmjs.

Пошаговая процедура и диагностика — скилл `synth-beta-publish`.

Версия беты: `X.Y.Z-beta.<UTC timestamp>.<sha>[.dirty]` — prerelease-суффикс отделяет её от релизных версий; `<sha>` фиксирует коммит, `.dirty` означает, что публикация собрана из грязного рабочего дерева. Публикуется под dist-tag `beta` или `next`; **`latest` не двигается** — установка `@itphx/synth` без тега и официальный Helm-чарт по-прежнему указывают на релиз.

Публикуются **все 8 пакетов** в порядке релиза (`shared → core → executor → storage-postgres → ui → backend → sdk → synth`).

**Чтение реестра — без токена.** Проверка обновлений и установка из Gitea не требуют
аутентификации: `synth update --check --channel beta` читает dist-tag `beta` публичным GET
метаданных пакета, а `npm i -g @itphx/synth@beta --registry https://git.itphx.ru/api/packages/itphx/npm/`
работает без `.npmrc`-токена. Токен `GITEA_NPM_TOKEN` с правом `package:write` нужен **только
публикации** (`publish-beta.sh`/CI). Закрытый контур, где реестр требует read-токен, — исключение:
тогда токен задаётся в `.npmrc` как условие установки пакета, а не как условие проверки версии.

### Локальная публикация

```bash
# токен с правом package:write в пространстве itphx
GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base 0.13.4
```

База `--base X.Y.Z` задаёт версию, от которой считается следующий patch; без неё скрипт берёт текущую версию `packages/synth/package.json`.

| Флаг | Что делает |
|---|---|
| `--tag beta\|next` | dist-tag публикации (по умолчанию `beta`) |
| `--base X.Y.Z` | база версии (пусто — следующий patch) |
| `--no-smoke` | не проверять установку из реестра (быстрее) |
| `--dry-run` | показать версию и план, ничего не собирать и не публиковать |
| `--no-build` | не пересобирать пакеты (использовать готовые `dist/`) |

Скрипт пишет вычисленную версию в `tmp/beta-publish/version.txt`.

### Публикация из CI

Actions → **`Beta packages`** ([workflow](../.gitverse/workflows/beta.yaml)), входы:

- `ref` — ветка или коммит (по умолчанию `master`);
- `base` — база версии `X.Y.Z` (пусто — следующий patch);
- `tag` — dist-tag `beta`/`next`;
- `smoke` — проверить установку из реестра (по умолчанию да);
- `dry_run` — показать план без сборки и публикации.

Workflow намеренно **не проходит релизные гейты** (`security-gate`, `release-notes`): бета не является релизом и не заменяет аудит. Токен `GV_GITEA_TOKEN` должен иметь `package:write`; если у него этого права нет — заводится отдельный секрет и подставляется в `env` шага публикации.

### Установка

```ini
@itphx:registry=https://git.itphx.ru/api/packages/itphx/npm/
//git.itphx.ru/api/packages/itphx/npm/:_authToken=${GITEA_NPM_TOKEN}
```

```bash
npm i -g @itphx/synth@beta
synth --version

# отдельный home — бета не мешает рабочему инстансу
synth serve --home ~/.local/share/synth-beta

# гибрид: локальный core, сервер в K3s (test)
synth serve --connect https://synth.k3s.itphx.loc --home ~/.local/share/synth-beta --port 4300
```

### Переход с беты на стабильную версию

Переход `beta → stable` — это **понижение** (стабильная версия ниже текущей беты), поэтому команда
помечает операцию как откат и требует подтверждения:

```bash
synth update --check --channel stable          # что доступно в стабильном канале
synth update --channel stable --apply          # понижение: подтвердить «ОТКАТ»
synth service restart                          # или POST /api/v2/maintenance/restart, или кнопка в UI
synth doctor                                   # после старта — без fail
```

Версия из бета-канала при этом **не** удаляется и не мигрируется; данные инстанса остаются на месте
(понижение версии не откатывает схему — при необходимости восстановление только из бэкапа,
см. [MAINTENANCE.md](./MAINTENANCE.md) §«Обновление и откат»). Обратно на бету — обычное обновление
по каналу `beta` (`--channel beta --apply`).

### Smoke-проверка

Скрипт сам ставит опубликованный пакет в `tmp/` и проверяет `synth --version` — так ловится «опубликовано, но не устанавливается» (битые `workspace:*`, отсутствующие файлы в `files`). Отключается флагом `--no-smoke`; в CI — входом `smoke: false`.

### Ретеншн

```bash
./scripts/beta-prune.sh --keep 20          # план: что будет удалено (безопасный default)
./scripts/beta-prune.sh --keep 20 --yes    # удалить лишние беты
```

Скрипт оставляет N последних бета-версий (semver, по убыванию) и удаляет более старые во всех 8 пакетах. Удаляются **только** версии с `-beta.`; релизные версии и dist-tag `latest` не затрагиваются. Без `--yes` (и с `--dry-run`) выполняется только показ плана.

### Ограничения

- Бета, собранная из грязного дерева, **невоспроизводима** — суффикс `.dirty` это помечает; для проверки воспроизводимости публикуйте из чистого коммита.
- Docker-образы и Helm-чарт беты **не публикуются** — только npm-пакеты в Gitea.
- Токен публикации требует `package:write`; для чтения реестра (проверка обновлений, установка `@beta`) токен не нужен — он остаётся нужен только закрытым реестрам, где read требует `.npmrc`.

## Docker-образ

Образ собирается из опубликованного npm-пакета: `npm install -g @itphx/synth@<version>` (зависимости `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared` ставятся как транзитивные, промпты и UI резолвятся из node_modules). Dockerfile: `docker/Dockerfile`.

Образы собираются с идентификатором сборки **`SYNTH_BUILD_ID`** (в CI — commit sha; локально — `git rev-parse --short HEAD`, при грязном дереве с суффиксом `-dirty`). Значение отдаётся в `GET /health` (аддитивное поле `build`) и входит в имя кэша service worker; PWA сравнивает его с build id бандла и при расхождении сама сбрасывает кэши, обновляет SW и один раз перезагружается — пересборка под той же semver больше не оставляет старый шелл. Если build id пуст (локальная сборка без переменной), клиент, как раньше, сравнивает `health.version` с `SYNTH_VERSION`.

Реестр Docker — **`gitverse.ru`** (не `registry.gitverse.ru`!). Образ:

```
gitverse.ru/itphx/synth:<version>
```

Тег `latest` **не публикуется** — в реестре остаются только версионные теги. Причина: квота «Пакеты» в GitVerse считает размер каждой версии без дедупликации — `latest` и версия указывают на один digest, но оплачиваются дважды (лимит 500 МБ на репозиторий). Поэтому `docker pull gitverse.ru/itphx/synth` без тега не работает — указывайте версию.

Дополнительно **все три базовых образа** (`synth`, `synth-backend`, `synth-ui`) зеркалируются в GitHub Container Registry: `ghcr.io/itphx/synth:<version>`, `ghcr.io/itphx/synth-backend:<version>`, `ghcr.io/itphx/synth-ui:<version>`. Политика — в разделе [Релиз в GitHub-зеркале](#релиз-в-github-зеркале).

## Образы исполнителей и flavor'ы (PROP-082)

Кроме трёх базовых образов публикуются **flavor-образы** (all-in-one: control plane + toolchain) и **образы исполнителей** (worker'ы, split-топология). Все они — в реестре Gitea `git.itphx.ru`:

| Образ | Тег | Состав |
|---|---|---|
| `synth-backend` | `<версия>` | slim: control plane без toolchain'а |
| `synth-backend` | `<версия>-core` | hard deps + tier 0 + control plane |
| `synth-backend` | `<версия>-dev` | core + tier 1 + tier 4 (MCP) + БД-клиенты + buildah |
| `synth-backend` | `<версия>-devops` | dev + tier 2 + диаг + docker CLI |
| `synth-backend` | `<версия>-browser` | debian-ветка: tier 0/1 + tier 3 (Playwright + Chromium) + диаг |
| `synth-backend` | `<версия>-full` | всё вышеперечисленное |
| `synth-executor` | `<версия>-core` … `<версия>-full` | образы исполнителей (те же flavor'ы, без control plane) |

Полный адрес: `git.itphx.ru/itphx/synth-backend:<версия>-core`, `git.itphx.ru/itphx/synth-executor:<версия>-core`.

**Теги версионные, без `latest`.** Pull в кластере идёт по конкретной версии (`<версия>-<flavor>`) — иначе развёртывание перестаёт быть воспроизводимым. Ограничение GitVerse/GHCR (~500 МБ на репозиторий) к Gitea-реестру не относится, но политика тегов общая для всех реестров.

### Секрет

Публикация в Gitea-реестр — по секрету **`GV_GITEA_TOKEN`** (логин `itphx`); локально и в `synth-deploy` — переменная `GITEA_TOKEN`. Если секрет не задан, публикация **падает** с понятным сообщением (fail-closed), а не пропускается молча: `scripts/docker-auth-gitea.sh` готовит `config.json` для kaniko/CLI.

### Сборка и публикация

В CI публикация живёт в джобе `publish-images-gitea` файла `.gitverse/workflows/release.yaml`: она запускается **по тегу релиза** (как и публикация базовых образов) и собирает каждый flavor отдельным шагом kaniko с `--target` и `--destination=git.itphx.ru/itphx/<образ>:<версия>-<flavor>`. В `ci.yaml` (push/PR) публикации нет — там только сборка и smoke-тесты (джоба `images`).

Явный `--platform` в flavor-шагах **не задаётся**: kaniko не выставляет `BUILDPLATFORM`/`TARGETPLATFORM` (проверено на v1.24.0), и пустое значение уронило бы сборку (PROP-082, «Multistage-сборка»). Registry-кэш включён — иначе одиннадцать сборок повторяли бы тяжёлую стадию `build`.

Локально:

```bash
# план действий (ничего не выполняется)
./scripts/publish-images.sh --tag-base 0.11.4 --dry-run

# собрать локально, без публикации
./scripts/publish-images.sh --tag-base 0.11.4 --skip-push

# собрать и опубликовать все flavor'ы в Gitea
GV_GITEA_TOKEN=<токен> ./scripts/publish-images.sh --tag-base 0.11.4

# только образ исполнителя, flavor core
GV_GITEA_TOKEN=<токен> ./scripts/publish-images.sh --tag-base 0.11.4 \
    --only executor --flavor core
```

Скрипт печатает сводку (образ, тег, размер, digest) и пушит **последовательно**, с ретраями: DNS `git.itphx.ru` на nameserver `10.0.0.245` сбрасывает параллельные запросы, из-за чего `docker push` падал с `Temporary failure in name resolution`.

### Smoke-тесты flavor'ов

```bash
./scripts/smoke-image.sh --image synth-backend:0.11.4-dev
./scripts/smoke-image.sh --image git.itphx.ru/itphx/synth-executor:0.11.4-core --flavor core
```

Скрипт запускает контейнер и проверяет состав **по flavor'у** (не только наличие бинарников, но и их работоспособность):

| Flavor | Проверки |
|---|---|
| `core` | `git`, `rg`, `python3` (+`pip`, `python3 -m venv`), `bash`, `jq`, `yq`, `curl`, `openssl`, `ssh` (+`scp`, `sftp`), `rsync`, `ca-certificates` |
| `dev` | + tier 1 (`make`, `gcc`, `g++`, `patch`), MCP-серверы (`initialize` по stdio), клиенты БД (`sqlite3`, `psql`, `redis-cli`, `mysql`), `buildah` |
| `devops` | + tier 2 (`kubectl`, `helm`, `kustomize`, `tofu`/`terraform`, `ansible`, `shellcheck`, `yamllint`, `hadolint`), диаг (`dig`, `nc`, `lsof`, `ss`, `traceroute`), `docker --version` (демона в образе нет) |
| `browser` | + `playwright`, headless-старт Chromium, `xmllint` |
| `full` | всё вышеперечисленное |
| `slim` | **негативная проверка:** бинарников toolchain'а в образе быть не должно |

Код возврата ненулевой при провале; в выводе видно, какая именно проверка не сошлась.

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
2. `packages/*/package.json` — поле `version` во всех 8 пакетах

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

Это **обязательное требование, а не рекомендация**: релизный гейт `release-notes` (до `build`)
падает без непустых `<version>.md` и `<version>.en.md`. Авто-сборка из коммитов остаётся только
аварийным фоллбеком для ручного/локального запуска.

| Файл | Язык | Куда идёт тело |
|------|------|----------------|
| `docs/releases/<VERSION>.md` | русский | тело **GitVerse Release** (job `create-release`) |
| `docs/releases/<VERSION>.en.md` | английский | тело **GitHub Release** (job `publish-github`) |

Что писать: что вошло в релиз, ключевые изменения, **breaking changes**, блок установки
(команды `npm`/`docker`/`helm`). Ориентир по структуре — [`docs/releases/0.10.0.md`](./releases/0.10.0.md).

Локальная проверка пары:

```bash
pnpm release:notes -- --version 0.13.4
# или
node scripts/release-notes-check.mjs --version 0.13.4
```

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
| `.gitverse/workflows/release.yaml` | push тега `v*` + `workflow_dispatch` | **сборка и публикация** релиза (включая GitHub-зеркало и релиз); до сборки артефактов — обязательные гейты `security-gate` и `release-notes` (`build.needs`) |
| `.gitverse/workflows/ci.yaml` | push в `main`/`master`/`feature/**`/`fix/**`/`refactor/**`/`chore/**`/`docs/**` и PR | тесты кода: typecheck, lint, тесты `shared`/`core`/`executor`/`storage-postgres`/`backend`/`ui`/`sdk`, задача `test-postgres` (контрактный suite на живой PostgreSQL), `helm lint` + `template`, `secret-scan` (дерево + история, **блокирующая**), `pnpm audit --audit-level=high` (report-only) + ратчет уязвимостей дельтой к baseline (report-only) |
| `.gitverse/workflows/ci-docs.yaml` | push в `main`/`master`/`feature/**` и PR, изменения по `paths` (доки/AGENTS.md/скрипты проверок) | `node scripts/adr-check.mjs` + `node scripts/docs-link-check.mjs` + `node scripts/security-gate.mjs --lint-records` (записи аудита; pnpm не ставится) |

Разделение сделано через `paths`/`paths-ignore`: у `ci.yaml` в `paths-ignore` есть `docs/**` и `**/*.md`, поэтому доковые пуши не гоняют тяжёлые джобы; у `ci-docs.yaml` наоборот — `paths` только по докам, и джоба не ставит pnpm (скрипты на голом node).

**Где исполняется.** Джобы всех трёх workflow идут на **self-hosted раннере** (метка `synth-ci`,
host-режим): доступен docker-демон, облачный лимит 30 минут не действует, кэш pnpm/docker
переиспользуется между прогонами. Это внутренняя инфраструктура: топология, регистрация, обновление
и диагностика — в приватном репозитории `synth-deploy` (`docs/CI_RUNNERS.md`).

### Порядок сборки в CI

`pnpm install --frozen-lockfile` → `pnpm --filter @itphx/synth-shared build` (обязательно перед
typecheck) → `pnpm --filter @itphx/synth-core build` (нужен backend'у и typecheck драйвера
хранилища) → `pnpm --filter @itphx/synth-executor build` (типы ссылаются на dist core) →
`pnpm --filter @itphx/synth-storage-postgres build` → `pnpm typecheck` → `pnpm lint` → `pnpm test`.

Без сборки shared/core typecheck не найдёт типы. Рекурсивные задачи (`pnpm typecheck`/`lint`/`test`
= `pnpm --recursive run …`) идут по **намеренным** циклам `core ↔ @itphx/synth-storage-postgres` и
`core ↔ @itphx/synth-executor` (core подключает оба пакета динамическим `import()`, пакеты —
peer-dep на core) — они разрешены `ignoreWorkspaceCycles: true` в `pnpm-workspace.yaml` (pnpm ≥12
иначе роняет их с `ERR_PNPM_TASK_CYCLE`; между самими задачами зависимостей нет — порядок сборки
задают явные `--filter` выше). Рекурсивные задачи идут последовательно по пакетам
(`workspaceConcurrency: 1`): иначе vitest пакетов конкурируют за CPU и тесты деградации `core`
ловят `Test timed out in 20000ms`.

Драйвер собирается и в релизном гейте `lint-and-test` (`release.yaml`): рекурсивный `pnpm test`
включает тесты деградации core, которые не гейтятся `SYNTH_TEST_POSTGRES_DSN`, но динамически
импортируют `@itphx/synth-storage-postgres` — без его `dist` прогон падает. Контрактный suite
драйвера против **живой** PostgreSQL — отдельная задача `test-postgres` (`SYNTH_TEST_POSTGRES_DSN`;
БД поднимает `scripts/ci-postgres.sh`: секрет `GV_TEST_POSTGRES_DSN` → локальный `initdb` → docker
`postgres:17-alpine`). `security-gate` и `release-notes` гейтят сборку артефактов
(`build.needs`) — политика и чек-лист: [docs/security/README.md](./security/README.md).

### Запуск релиза

> **Правило: релиз тегируется только с `master`.** Тег на feature-ветке формально валиден (он указывает
> на конкретный код), но оставляет `master` позади релиза — «релиз есть, а кода в master нет»
> (так вышло на 0.12.4). Кроме того `release.yaml` берёт версию из `packages/synth/package.json`,
> а Helm/Docker/offline — из тега: без bump-коммита в теге публикация уходит под **прежней** версией
> (на 0.12.4 так ушли npm-пакеты под `0.12.3`, прогон пришлось отменять).

**Порядок (обязательный):**

1. Слить рабочую ветку в `master` и запушить: `git checkout master && git merge --ff-only <branch> && git push origin master`.
2. Дождаться зелёного `ci.yaml` на `master` (он и есть «коммит аудита»).
3. Bump версии одним коммитом в `master`: 8 × `packages/*/package.json`, `packages/shared/src/version.ts`,
   `charts/synth/Chart.yaml` (`version` + `appVersion`). Проверить, что `ci.yaml` на этом коммите зелёный.
4. Положить пару `docs/releases/<version>.md` + `.en.md` и проверить `pnpm release:notes -- --version <version>`.
5. Положить запись внутреннего аудита `docs/security/releases/<version>.json` (её проверяет `security-gate`).
6. Поставить **аннотированный** тег на коммит с записью и запушить: `git tag -a v<version> -m "…" && git push origin v<version>`.
7. Не пересоздавать тег и не отменять прогон «на лету»: повторный push тега запускает новый прогон, а
   у GitVerse незавершённые джобы предыдущего ещё занимают слоты — платформа может снять оба
   (наблюдалось: джобы помечаются `failure` одновременно, включая не запускавшиеся шаги).

Альтернативный ручной запуск (без тега):

1. **Dry-run:** `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. **Реальная публикация:** `workflow_dispatch` с `dry_run: false` (входы: `bump` patch/minor/major, `pre_release`)
   — этот путь делает bump, коммит и тег сам.

Повторный прогон по тому же тегу идемпотентен: npm-пакеты, которые уже в реестре, пропускаются,
Helm-чарт перезаписывается тем же содержимым, CI-артефакты и offline-сборки объявлены best-effort.

Ручной `workflow_dispatch` сохранён в `release.yaml` (пункты 1–2) — это единственный способ запустить сборку/публикацию без тега.

Релизный workflow: bump версии (version.ts + package.json + `charts/synth/Chart.yaml`) → проверка заметок (`release-notes`) → CI-проверки → сборка → CHANGELOG → публикация npmjs → публикация GitVerse npm → Docker (kaniko → `gitverse.ru/itphx/{synth,synth-backend,synth-ui}` + `ghcr.io/itphx/{synth,synth-backend,synth-ui}`) → публикация Helm-чарта (`publish-helm`) → создание GitVerse Release → GitHub-зеркало (`publish-github`: push `main`+теги, GitHub Release).

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
| `GV_GITEA_TOKEN` | Токен Gitea (`git.itphx.ru`) с правом на container registry — публикация flavor-образов и образов исполнителей (логин `itphx`) |
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

Ограничение по размеру артефактов (~500 МБ) касается **базовых** образов в GitVerse/GHCR. Flavor-образы (`synth-backend:<версия>-<flavor>`, `synth-executor:<версия>-<flavor>`) в GitVerse/GHCR не публикуются — только в приватный Gitea `git.itphx.ru/itphx/*` (см. §«Образы исполнителей и flavor'ы»), где лимита нет; slim control plane `synth-backend:<версия>` дополнительно публикуется и в Gitea. Публикуется только версионный тег (без `latest`) — та же политика, что и в GitVerse-контуре.

### Что делает CI GitVerse

Джоба `publish-github` в `.gitverse/workflows/release.yaml` запускается после сборки/публикации npm и Docker (`build-docker`) и после джобы `changelog`:

1. **Зеркало:** push `master→main` и всех тегов в `https://github.com/itphx/synth.git` (только `main` + теги, никаких других ветвей);
2. **GitHub Release** для тега `v<version>` — тело **на английском**: `bash scripts/changelog.sh --lang en` берёт `docs/releases/<version>.en.md` (файл обязателен; гейт `release-notes` не пропустит релиз без него; фоллбек на русское описание/авто-сборку — только аварийный, для ручного `release-github.sh`), плюс англоязычный блок установки «Installation» (npm из npmjs.org/GitVerse, образ из `ghcr.io/itphx/synth:<version>`); создание идемпотентно (если релиз по тегу есть — тело обновляется);
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

Для публикации в GitVerse Package Registry поле `repository` в `package.json` **должно отсутствовать**: GitVerse при привязке пакета к репозиторию по `repository.url` проверяет права и отдаёт 403 «no permission». Во всех 8 пакетах поле `repository` удалено — не добавляйте его обратно.

## Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```
