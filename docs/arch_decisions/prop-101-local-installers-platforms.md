# PROP-101: Локальные инсталляторы и платформенная дистрибуция (Windows / macOS / Linux)

> **Статус:** 🧩 Предложение — поставлять Synth набором платформенных артефактов с частично снятыми пререквизитами; flatpak/snap не берём; реализация — до 1.0.0
> **Решение до:** 2026-12-31
> **Дата:** 2026-10-16
> **Класс:** предложение ([ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §1–2): решения нет — есть гипотеза и поэтапный план; кода/артефактов по этапам нет.
> **Связано:** [ADR-038](./adr-038-npm-packages.md), [ADR-078](./adr-078-runtime-dependency-availability.md), [ADR-079](./adr-079-local-home-independent-instances.md), [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [PROP-082](./prop-082-full-images-deployment.md), [PROP-053](./prop-053-cli-tui.md), [docs/PUBLISHING.md](../PUBLISHING.md), [docs/QUICKSTART.md](../QUICKSTART.md), [docs/MAINTENANCE.md](../MAINTENANCE.md), [docs/DEVELOPMENT.md](../DEVELOPMENT.md).

## Контекст

Сегодня способы запустить Synth — два, и оба требуют пререквизита окружения:

- **npm-пакет (канон):** `npm i -g @itphx/synth` → `synth serve` (`README.md:80-93`, `docs/QUICKSTART.md:22-50`). Пререквизит — **system Node**.
- **Docker:** образ из `docker/Dockerfile` / `docker-compose.yml` (`README.md:106-111`). Пререквизит — **Docker**.

Платформенных инсталляторов нет: нет ни `.msi/.msix`, ни `.pkg/.dmg`, ни манифестов brew/winget/scoop/choco/AUR; все скрипты запуска — bash (`scripts/*.sh`). Единого self-contained артефакта тоже нет — сборка предполагает установленный Node и сеть для зависимостей.

Предмет этого предложения: **что и к какой дате поставляем как локальные инсталляторы** (Windows / macOS / Linux), какие пререквизиты снимаем, а какие остаются, и что **сознательно не берём** (flatpak/snap). Кода и артефактов по этапам пока нет — это гипотеза с планом.

## Текущее состояние (факты)

- **Пользовательский запуск = system Node** (`npm i -g @itphx/synth` → `synth serve`) или **Docker** (`docker/Dockerfile`, `docker-compose.yml`). Требуется Node ≥ 22: `packages/synth/package.json:34-35`, `packages/sdk/package.json:33-34`; блок `engines` **отсутствует** у `core`/`backend`/`ui`/`shared`.
- **CI — Linux-only (ключевой блокер).** Все джобы `.gitverse/workflows/{release,ci,ci-docs}.yaml` объявлены на `ubuntu-latest`; каталог `.github/workflows/` отсутствует (GitHub — зеркало без Actions, см. `AGENTS.md` § «GitVerse CI — особенности» и `docs/PUBLISHING.md`). Docker собирается kaniko (Linux-only): `.gitverse/workflows/release.yaml:362-393`.
- **Единого standalone-бинарника нет.** `packages/synth/tsup.config.ts:13-23` держит `@itphx/synth-core`/`@itphx/synth-shared`/`@itphx/synth-ui` в `external` (ADR-038); core собирается `tsc` в мультифайловый `dist` (`packages/core/package.json:55`); ассеты (prompts/dictionaries/definitions, UI-dist) резолвятся из `node_modules` (`docker/Dockerfile:1-5`, `packages/synth/src/cli.ts`).
- **Пререквизиты рантайма (внешние бинарники):** `sh` (`packages/core/src/engine/tools/shell.ts`, `packages/core/src/engine/commands/inline-shell.ts`), `git` (`packages/core/src/engine/tools/git.ts`), `rg` (`packages/core/src/engine/tools/search.ts`), `ssh`/askpass (`packages/core/src/git/ssh-env.ts`), `npm` для самообновления (`packages/core/src/server/routes/updates.ts:37`). Отсутствие бинарника → авто-отключение тула `unavailable(dependency)` (`packages/core/src/engine/tools/runtime-deps.ts`, ADR-078), **не** срыв старта.
- **Нет нативных npm-зависимостей** (чистый JS на рантайме) → Node ставится без toolchain; поля `os`/`cpu` в `package.json` пакетов отсутствуют.
- **Пути и данные:** XDG-дефолт конфига `~/.config/synth` (`packages/shared/src/config/loader.ts:23`), данные — `dataDir` (дефолт `/var/synth/data`, `packages/shared/src/config/defaults.ts:13`); пользовательский режим — `--home`/`SYNTH_HOME` (ADR-079), root не требуется; порт 4300 (`packages/shared/src/config/defaults.ts:32`), host `127.0.0.1` (standalone).
- **Ориентир размера self-contained** (без git): **~60–120 МБ** — JS + ассеты ~25–30 МБ плюс Node ~40–80 МБ; ripgrep ~5 МБ.

### Матрица каналов

| Платформа | Формат | Собирается на Linux-CI? | Подпись/нотаризация |
|---|---|---|---|
| Windows | MSI (WiX) / MSIX | ❌ (нужен Windows) | Authenticode (OV/EV) |
| Windows | NSIS `.exe` / portable zip | ✅ (`makensis`, подпись `osslsigncode`) | Authenticode |
| Windows | winget / scoop / choco (манифесты) | ✅ (манифесты) | ссылается на подписанный артефакт |
| macOS | `.pkg` / `.dmg` / universal2 | ❌ (только macOS) | Developer ID + notarization |
| macOS | Homebrew formula / cask | ✅ (манифест) | артефакт должен быть подписан |
| Linux | `.deb` / `.rpm` / AppImage / tarball | ✅ (`dpkg-deb`/`rpmbuild`/`appimagetool`) | GPG-подпись репозитория |
| Linux | Arch: AUR PKGBUILD (офиц. репы недостижимы) | ✅ (манифест) | сборка у пользователя |

### Linux-таргеты (зафиксировать)

- **RHEL-семейство** — `.rpm` → COPR/EPEL/свой репозиторий.
- **Debian-семейство** — `.deb` → PPA/свой репозиторий.
- **Arch** — **AUR** PKGBUILD (сборка у пользователя).
- **AppImage/tarball** — дистро-агностик; собирать на старейшей базе (из-за glibc), чтобы не задирать минимальную версию.

Оговорка: попасть в **официальные** репозитории дистрибутивов для стороннего проекта недостижимо в обозримом горизонте — каналы выше (AUR, COPR, свой репо, PPA) это обходят.

## Стратегия: «всё в одном» vs пререквизиты

Ключевая ось — **Node**: поставлять пакет поверх уже установленного Node (текущий путь) или тянуть **bundled Node** внутрь артефакта.

| Ось | System Node | Bundled Node |
|---|---|---|
| Размер | минимум (~25–30 МБ) | +50–100 МБ **на каждую arch** |
| Что снимает | ничего сверх npm | пререквизит Node |
| Требует | — | нативные раннеры под каждую ОС + сборку/упаковку рантайма |
| Готовность | **работает уже сейчас** | нет (см. «Текущее состояние»: единого бинарника нет) |

Отдельные тезисы:

- **Единого файла на все ОС не существует** — артефакт собирается под платформу (и, для bundled, под arch).
- **Канон — npm**: он остаётся основным путём и де-факто «этапом 0».
- **«Просто запустить» — Docker**: уже доступно, пререквизит — Docker Desktop/runtime.
- **Self-contained — второй этап** (требует переупаковки рантайма, см. этап 3).

### flatpak/snap — не берём (рекомендация)

Synth — **локальный сервер, не desktop-GUI**: слушает порт, спавнит `sh`/`git`/`rg`, работает с произвольным workspace и ФС, кладёт SSH-ключи, ходит в сеть. Песочницы обоих форматов это ломают:

- **snap strict-confinement** не даёт доступа к произвольным путям; вариант `classic` требует ручного одобрения Canonical и **обнуляет песочницу**.
- **flatpak** использует bubblewrap-порталы, рассчитанные на GUI; рабочий вариант `--filesystem=host` тоже **обнуляет песочницу**, плюс тянется desktop-runtime.

Вердикт: **не брать**. Пересмотреть только при появлении desktop-GUI клиента ([PROP-064](./prop-064-ui-browser-terminal.md)).

## Этапы

### Этап 0 — есть (baseline)

npm + Docker Desktop. Пререквизит: Node либо Docker. Ничего делать не нужно — это текущее состояние, по которому меряем выигрыш этапов 1–3.

### Этап 1 — реализуем на текущем Linux-CI

- **Цель:** первые платформенные артефакты без нативных раннеров.
- **Состав:** `.deb` + `.rpm` + `tarball` (+ AppImage опционально); бандл `ripgrep` **внутрь**; systemd **user**-unit/автозапуск; манифесты **AUR PKGBUILD**, **Homebrew** formula/cask (из tarball), **winget/scoop** (на tarball).
- **Предпосылки:** текущие `ubuntu-latest`-джобы; ничего, кроме Linux-CI, не требуется.
- **Оговорка:** `synth update --to` **не реализован** — обновление идёт через пакетный менеджер, а не самообновлением.

### Этап 2 — нужны нативные раннеры + подписи

- **Цель:** нативные инсталляторы Windows и macOS.
- **Состав:** Windows — **NSIS** + Authenticode (`osslsigncode` возможен даже на Linux), затем winget/scoop из **подписанного** артефакта; macOS — `.pkg`/`.dmg`, Developer ID, нотаризация.
- **Предпосылки:** self-hosted раннеры под Windows/macOS (вопрос 2); сертификаты (вопрос 3).
- Здесь же — **решение по bundled Node** (вопрос 1).

### Этап 3 — опционально

- **Цель:** self-contained артефакт с **bundled Node**.
- **Состав:** переупаковка рантайма (Node + JS + ассеты) в единый дистрибутив.
- **Предпосылки:** требует переупаковки сборки — сейчас единого бинарника нет (см. «Текущее состояние»); блокируется вопросом 1.

## Пререквизиты и открытые вопросы

Четыре **решения владельца** (каждое блокирует свой этап):

1. **Стратегия Node** — system vs bundled. **Блокирует этапы 2–3.**
2. **Нативные раннеры** — есть ли Windows/macOS-машины под self-hosted runner. **Блокирует этап 2.**
3. **Подписи** — Apple Developer Program ($99/год) и Windows code-signing cert (OV). **Блокирует этап 2.**
4. **Scope пакетных менеджеров** — что берём в первый заход: winget/scoop/choco / brew tap / AUR+COPR. **Блокирует этап 1.**

**Неизбежные пререквизиты рантайма** (что остаётся у пользователя после установки):

| Пререквизит | Нужен для | Снимается инсталлятором? |
|---|---|---|
| Node (если не bundled) | запуск пакета | нет (этап 3 может снять) |
| `git` | git-тулы (ADR-078) | **нет** — единообразно не снимается ни на одной платформе |
| `rg` (ripgrep) | `grep_files` | **да** — легко бандлится внутрь |
| `sh` | `execute_shell`, inline-shell | **нет** — на Windows нативно отсутствует |
| сеть | установка/LLM/egress | нет |

## Влияние на подсистемы

| Подсистема | Что меняется | Риск |
|---|---|---|
| `packages/synth` (tsup/bundling) | только для этапа 3 (bundled) | меняет модель дистрибуции (ADR-038) |
| `packages/shared` (config-резолв путей) | возможные `%APPDATA%`/`%LOCALAPPDATA%` на win32 (этап 1/2) | расхождение путей между ОС |
| `packages/core/src/engine/tools/{shell,search,git}.ts` | платформенный выбор шелла и детект бинарников (ADR-078), нужен для этапа 2 | поведение тулов на Windows |
| `docker/Dockerfile` | докомплектация `git` + `ripgrep` (этап 1) | рост образа |
| CI `.gitverse/workflows/release.yaml` | новые артефакты **после** `security-gate` (этапы 1–2) | порядок джоб, артефакты не должны проскочить гейт |
| `scripts/*.sh` | обёртки платформенного запуска (этап 1+) | bash-only скрипты не годятся для Windows |

## Критерии готовности и способ проверки

1. **Артефакты собираются в CI без ручных шагов**; `sha256` манифестируются (`SHA256SUMS` уже есть в `release.yaml:622-630`).
2. **Чистая машина целевой ОС:** установка одним артефактом → `synth serve` → UI открывается, `GET /health` → 200.
3. **Пререквизиты явно перечислены** в инструкции; при отсутствии `git`/`rg` — деградация по ADR-078, **не** падение.
4. **Этап 2:** подпись/нотаризация проходят — SmartScreen/Gatekeeper не блокируют.
5. **Проверка:** `synth doctor` зелёный на каждом артефакте; smoke на реальных Win/mac/Linux-машинах.
6. **Доковая проверка:** `node scripts/adr-check.mjs` (0 ошибок) + `node scripts/docs-link-check.mjs`.

## Связи

- [ADR-038](./adr-038-npm-packages.md) — npm-пакеты как канон и тонкая CLI-обёртка (почему нет единого бинарника).
- [ADR-078](./adr-078-runtime-dependency-availability.md) — деградация при отсутствии `git`/`rg`/`sh` (обосновывает, какие пререквизиты можно не снимать).
- [ADR-079](./adr-079-local-home-independent-instances.md) — локальный home и пути (влияние на win32-пути).
- [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — `doctor`/`migrate`/`update`, обновление через пакетный менеджер.
- [PROP-082](./prop-082-full-images-deployment.md) — flavor-образы с toolchain (соседний канал доставки).
- [PROP-053](./prop-053-cli-tui.md) — CLI/TUI как потребитель платформенной упаковки.
- [PROP-064](./prop-064-ui-browser-terminal.md) — desktop-GUI (условие пересмотра вердикта по flatpak/snap).
- [docs/PUBLISHING.md](../PUBLISHING.md), [docs/QUICKSTART.md](../QUICKSTART.md), [docs/MAINTENANCE.md](../MAINTENANCE.md), [docs/DEVELOPMENT.md](../DEVELOPMENT.md).

## История

- 2026-10-16 — документ создан: зафиксированы стратегия (npm/Docker канон + платформенные артефакты), этапы 0–3, матрица каналов, вердикт по flatpak/snap и 4 пререквизита-вопроса владельца.
