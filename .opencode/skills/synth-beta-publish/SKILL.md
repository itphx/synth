---
name: synth-beta-publish
description: "Бета-публикация пакетов Synth в Gitea (npm): publish-beta.sh, CI Beta packages, установка @beta, ретеншн и диагностика. Используй для быстрой сборки «как у пользователя» и проверки local/hybrid вне релиза."
---

# Бета-публикация (Gitea)

## Когда использовать

- Нужна **текущая сборка без релиза и тега** — проверить поведение на той же поставке, что получают потребители.
- Проверить local/hybrid на **чистой машине** (отдельный home), не копируя исходники и не собирая workspace.
- Быстро отдать коллеге/тестировщику установку одной командой из Gitea.

Это **не релиз**: `latest` не двигается, релизные гейты не запускаются.

## Что публикуется

Все **8 пакетов** в строгом порядке зависимостей:

```text
shared → core → executor → storage-postgres → ui → backend → sdk → synth
```

Версия: `X.Y.Z-beta.<UTC timestamp>.<sha8>[.dirty]`
- `X.Y.Z` — `--base` либо следующий patch от текущей версии (prerelease отбрасывается);
- `<UTC timestamp>` — уникален, конфликт версий при повторной публикации исключён;
- `<sha8>` — короткий коммит (`nogit` без git), `.dirty` — грязное рабочее дерево.

dist-tag: `beta` (по умолчанию) или `next`. **`latest` не двигается** — установка без тега и Helm-чарт остаются на релизе.

Реестр: `https://git.itphx.ru/api/packages/itphx/npm/` — Gitea Package Registry, `git.itphx.ru` отдаёт публичный LE-сертификат (дополнительный CA не нужен).

## Предпосылки

- Node.js ≥ 22, `pnpm`, `git` (без git версия получит `nogit` и dirty-детект пропустится).
- Токен с правом **`package:write`** на пространство `itphx`:
  - локально — `GITEA_NPM_TOKEN`, fallback `GITEA_TOKEN` / `GV_GITEA_TOKEN`;
  - в CI — секрет `GV_GITEA_TOKEN` (пробрасывается в `GITEA_NPM_TOKEN`).
- Для установки достаточно **read-токена** на тот же реестр.

## Локальный цикл

```bash
GITEA_NPM_TOKEN=… ./scripts/publish-beta.sh --base 0.13.4
```

| Флаг | Что делает |
|---|---|
| `--base X.Y.Z` | базовая версия (по умолчанию следующий patch от текущей) |
| `--tag beta\|next` | dist-tag публикации (по умолчанию `beta`) |
| `--registry URL` | npm-реестр (по умолчанию `GITEA_NPM_REGISTRY` или Gitea) |
| `--no-build` | публиковать уже собранное `dist/` (версия внутри может быть старой) |
| `--no-smoke` | не проверять установку из реестра |
| `--skip-install` | не запускать `pnpm install --frozen-lockfile` |
| `--dry-run` | показать версию/пакеты/команды; **не публикует и не собирает** |
| `--restore-dist` | после восстановления версий пересобрать `shared` и `ui` под исходную версию |

Порядок работы скрипта:

1. бэкап **9 файлов** — 8 `packages/*/package.json` + `packages/shared/src/version.ts`;
2. подмена версии и проверка всех 9 файлов;
3. `pnpm install --frozen-lockfile` (до подмены версий — иначе lock-файл не сойдётся);
4. `pnpm build` + проверка, что `dist` содержит бету;
5. публикация 8 пакетов через `scripts/publish-packages.sh` (`pnpm publish`, не `npm publish`);
6. `npm dist-tag add` для всех 8 + проверка `npm view @itphx/synth@<tag>`;
7. smoke-установка в `tmp/beta-publish/smoke`;
8. восстановление исходных версий по `trap` (успех, ошибка, Ctrl-C, TERM).

Вычисленная версия сохраняется в `tmp/beta-publish/version.txt`.

## CI

Actions → **`Beta packages`** (`.gitverse/workflows/beta.yaml`), входы:

- `ref` — ветка/коммит (по умолчанию `master`);
- `base` — база `X.Y.Z` (пусто — следующий patch);
- `tag` — `beta`/`next`;
- `smoke` — проверка установки из реестра (по умолчанию да);
- `dry_run` — сборка и проверки без публикации.

Первый прогон на новой ветке/раннере — `dry_run: true`. Бета **намеренно** не проходит `security-gate` и `release-notes`: она не является релизом и не заменяет аудит.

## Установка и проверка

`.npmrc` (scope + токен из env):

```ini
@itphx:registry=https://git.itphx.ru/api/packages/itphx/npm/
//git.itphx.ru/api/packages/itphx/npm/:_authToken=${GITEA_NPM_TOKEN}
```

```bash
npm i -g @itphx/synth@beta
synth --version

# standalone, отдельный home — бета не мешает рабочему инстансу
synth serve --home ~/.local/share/synth-beta

# гибрид: локальный core + сервер в K3s (test)
synth serve --connect https://synth.k3s.itphx.loc --home ~/.local/share/synth-beta --port 4300
```

## Smoke

Скрипт сам ставит пакет в `tmp/` и проверяет `synth --version` — ловит «опубликовано, но не устанавливается» (битые `workspace:*`, отсутствующие файлы в `files`). Отключается `--no-smoke` (в CI — `smoke: false`).

Вручную:

```bash
npm i -g --prefix tmp/beta-smoke @itphx/synth@beta \
  --registry https://git.itphx.ru/api/packages/itphx/npm/
tmp/beta-smoke/bin/synth --version
```

## Ретеншн

```bash
./scripts/beta-prune.sh --keep 20          # по умолчанию только план
./scripts/beta-prune.sh --keep 20 --yes    # удалить лишние беты (необратимо)
```

Оставляет N последних бета-версий (semver, по убыванию) по всем 8 пакетам. Удаляются **только** версии с `-beta.`; релизные версии и `latest` не трогаются. `404`/«уже нет» — предупреждение, повторный прогон идемпотентен.

## Правила и ограничения

- Docker-образы и Helm-чарт беты **не публикуются** — только npm-пакеты в Gitea.
- Бета из грязного дерева **невоспроизводима** (`.dirty`); для воспроизводимости — чистый коммит.
- Не путать с релизом: бета не двигает `latest` и не заменяет внутренний аудит безопасности.
- Токен — только env/секрет, не коммитить и не писать в документацию.
- После беты `dist/` остаётся с бета-версией: пересобрать `--restore-dist` либо
  `pnpm --filter @itphx/synth-shared build && pnpm --filter @itphx/synth-ui build`.

## Диагностика

| Симптом | Причина и действие |
|---|---|
| `404`/`401` при публикации или `npm view` | нет `package:write`; не задан scope-registry; проверьте `npm view @itphx/synth --registry https://git.itphx.ru/api/packages/itphx/npm/` |
| `EACCES … esbuild` | потерян execute-бит: `chmod +x node_modules/.pnpm/@esbuild+linux-x64@*/node_modules/@esbuild/linux-x64/bin/esbuild` или `pnpm rebuild esbuild` |
| `pnpm install --frozen-lockfile` падает | версии подменены до install; запускать install **до** подмены (скрипт так и делает) |
| `workspace:*` не резолвится в опубликованном пакете | публиковать только `pnpm publish`, не `npm publish` |
| `latest` уехал на бету | вернуть: `npm dist-tag add @itphx/synth@<stable> latest --registry …` |
| smoke показывает старую версию | публикация с `--no-build` — пересобрать без флага |
| конфликт версии при повторе | timestamp уникален; при необходимости задать другой `--base` |

## Файлы

- `scripts/publish-beta.sh` — локальный цикл публикации.
- `scripts/publish-packages.sh` — идемпотентная публикация 8 пакетов (используется бетой).
- `scripts/beta-prune.sh` — ретеншн бет.
- `.gitverse/workflows/beta.yaml` — CI-workflow `Beta packages`.
- `docs/PUBLISHING.md` §«Бета-версии (Gitea)» — пользовательская процедура.
