# AD-086: Расширяемость Synth: классы расширений, editions и contribution flow

> **Статус:** ⚠️ Частично — первый **Gateway** (Telegram-шлюз) реализован и мультитенантен; эталон **Add-on** — `synth-media`;
> класс **Gateway** выделен в [AD-087](./ad-087-gateways.md) (HA/leader election — нет); Plugin SDK
> ([AD-090](./ad-090-extension-api.md)), editions и contribution flow — нет
> **Дата:** 2026-10-02
> **Обновлено:** 2026-10-14 — **реструктуризация классов расширений**: класс **Gateway** выделен в действующий
> [AD-087](./ad-087-gateways.md) (туда перенесён весь материал Telegram-шлюза, в AD-086 дубликатов нет), а AD-086
> стал **зонтиком «Классы расширений»** (Plugin / Gateway / Add-on / контент-пак + Editions + Contribution flow);
> введён **единый манифест** `synth.pack` для всех классов и контент-паков; терминология 4 классов закреплена в
> [AD-090](./ad-090-extension-api.md).
> **Обновлено:** 2026-10-12 — Extension API v1 вынесен в отдельный [AD-090](./ad-090-extension-api.md);
> ограничение «плагины только standalone» снято (плагины разрешены во всех режимах: managed — установка ADMIN,
> hybrid — allow-list сервера с server-scoped токенами). Ранее (2026-10-08) добавлен четвёртый столп «внешние
> сервисы-надстройки (add-ons)».
> **Классы расширений:** Plugin → [AD-090](./ad-090-extension-api.md); **Gateway → [AD-087](./ad-087-gateways.md)**;
> Add-on → этот AD; контент-паки → [AD-068](./ad-068-skills-agents-registry.md); Edition → этот AD.
> **Связано:** [AD-090](./ad-090-extension-api.md) «Extension API v1», [AD-087](./ad-087-gateways.md) «Шлюзы (gateways)»,
> [AD-030](./ad-030-hooks-agent-events.md) «Hooks/Plugin SDK», [AD-038](./ad-038-npm-packages.md) «npm-пакеты»,
> [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы», [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог»,
> [AD-082](./ad-082-full-images-deployment.md) «Flavor-образы», [AD-089](./ad-089-external-events-automation.md) «Платформа внешних событий»,
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md),
> [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами», [AD-032](./ad-032-history-storage-postgresql.md) «PostgreSQL».

**Решение:** дать сообществу и пользователям **лёгкий путь** доработать Synth без приватного форка ядра. Четыре
взаимодополняющих столпа и набор **классов расширений**:

1. **Extension API** (спецификация — [AD-090](./ad-090-extension-api.md)) — расширять без форка: версионированный
   контракт плагинов, точки расширения, загрузка из npm/каталога/реестра, trust/scan/install-policy (по образцу
   [AD-068](./ad-068-skills-agents-registry.md)). Терминология жёсткая — четыре класса: **Plugin** (код в процессе
   ядра) / **Gateway** ([AD-087](./ad-087-gateways.md), внешний сервис-транспорт) / **Add-on** (внешний сервис
   иного назначения) / **контент-пак** (данные без кода) — см. §«Классы расширений».
2. **Editions** — собрать и поддерживать свою редакцию (по образцу Ubuntu): пресет-метапакет из плагинов,
   скиллов, агентов (agent-packs), тем, локалей (i18n), провайдер/модель-паков, flavor-образов и тулчейна.
3. **Contribution flow** — предложить функционал в mainline и реализовать его своим Synth'ом за свой счёт:
   отдельный скилл ведёт агента и разработчика по циклу issue/design → план → реализация → тесты → PR.
4. **Внешние сервисы-надстройки (add-ons)** — вынести целые интеграционные подсистемы
   в отдельные сервисы со **своим** репозиторием, образами, `docker-compose`/Helm и **общим шаблоном**;
   реестр/каталог и trust/install-policy — по образцу [AD-068](./ad-068-skills-agents-registry.md).
   **Шлюзы — отдельный класс (Gateway)** со своим контрактом, см. [AD-087](./ad-087-gateways.md).

Все классы и контент-паки описываются **единым манифестом** `synth.pack` (§«Единый манифест расширения `synth.pack`»).

Выигрыш: пользователь получает нужное, проект — функционал и экосистему, авторы плагинов/editions/add-on'ов —
аудиторию. Кастомизация не требует держать приватный форк ядра.

## Классы расширений

| Класс | Что запускается | Где спецификация/детали |
|---|---|---|
| **Plugin** | код **в процессе ядра** (Extension API, фасад `@itphx/synth-plugin`) | [AD-090](./ad-090-extension-api.md) |
| **Gateway** | **внешний сервис-транспорт** внешний мир ↔ Synth (двусторонний обмен) | **[AD-087](./ad-087-gateways.md)** |
| **Add-on** | **внешний сервис** иного назначения (свой репозиторий/образы/деплой) | этот AD, §4 |
| **Контент-пак** | **данные без кода** (скиллы, agents, mcp, темы, i18n, провайдеры, промпты, automation, policies, memory, ui) | [AD-068](./ad-068-skills-agents-registry.md) |
| **Edition** | пресет-метапакет (плагины + контент-паки + образ + тулчейн) | этот AD, §2 |

**Критерий выбора класса:** по умолчанию — **Gateway/Add-on** (внешний сервис); **Plugin — только когда
изменение обязано быть in-process** (синхронная трансформация потока, внутренние реестры, производительность).
Детали терминологии и таксономии влияния плагинов — [AD-090](./ad-090-extension-api.md) §1.

## Контекст

Synth открыт (лицензия MIT), но расширить его сегодня можно только форком ядра. При этом уже есть заделы:
публикуемые npm-пакеты ([AD-038](./ad-038-npm-packages.md)), flavor-образы ([AD-082](./ad-082-full-images-deployment.md)),
контент-платформа скиллов/агентов ([AD-046](./ad-046-skills-and-slash-commands.md)/[AD-068](./ad-068-skills-agents-registry.md)),
проект hooks/Plugin SDK ([AD-030](./ad-030-hooks-agent-events.md)). Не хватает формализованного контракта расширения,
механизма упаковки/распространения и — отдельно — места для **сервисов**, которые не должны жить в ядре
(мессенджер-шлюзы, коннекторы, внешние интеграции).

Отдельно выделяется класс интеграционных подсистем, которым тесно в ядре: они требуют сети, секретов,
деплоя, своего жизненного цикла и часто своего языка/стека. Их правильнее оформлять как **внешние
сервисы-надстройки**; их частный случай — **шлюзы** (Gateway, [AD-087](./ad-087-gateways.md)). Первый конкретный
запрос сообщества — gateway к мессенджерам.

## Детали

### 1. Extension API (расширять без форка)

**Полная спецификация — [AD-090](./ad-090-extension-api.md)**: терминология 4 классов (Plugin/Gateway/Add-on/
контент-пак), манифест (`synth.pack`), точки расширения (встроенные тулы, провайдеры, HTTP-роуты, event-hooks
[AD-030](./ad-030-hooks-agent-events.md), UI-слоты/панели, скиллы/agent-packs), фасад `@itphx/synth-plugin` +
disposer-модель, bundle-only дистрибуция, install/activate (`plugins.lock.json`/`plugins.json`), trust/scan по
[AD-068](./ad-068-skills-agents-registry.md), permissions ([AD-029](./ad-029-granular-permissions.md)), semver-политика
и окно deprecation, а также режимы (managed/hybrid). Ниже — только указатель; детали не дублируются.

### Плагины, add-on'ы, шлюзы и режимы (обновлено 2026-10-14)

Четыре класса расширений Synth (терминология жёсткая, [AD-090](./ad-090-extension-api.md)):

| Класс | Что запускается | Режимы |
|---|---|---|
| **Plugin** | Код **в процессе core** (загружается через Extension API, фасад `@itphx/synth-plugin`) | standalone — владелец/ADMIN; **managed** — установка ADMIN (deploy-time — дефолт, runtime-install — опция, по умолчанию `deny`); **hybrid** — allow-list сервера + server-scoped токены |
| **Gateway** | **Внешний сервис-транспорт** внешний мир ↔ Synth (двусторонний); свой репозиторий/образы | Любой режим; общается по API v2/событиям/MCP; детали — [AD-087](./ad-087-gateways.md) |
| **Add-on** | **Внешний сервис** иного назначения со своим репозиторием/образами/деплоем (эталон — `synth-media`) | Любой режим; общается по API v2/MCP/событиям |
| **Контент-пак** | **Контент без кода** (скиллы, agent-packs, темы, i18n, провайдеры, промпты, automation, policies, memory, ui) | Любой режим; устанавливается из каталога ([AD-068](./ad-068-skills-agents-registry.md)) |

**Ограничение «плагин только standalone» снято:** плагины разрешены во всех режимах. В **managed**
установку выполняет ADMIN (deploy-time по умолчанию; runtime-install — опция, по умолчанию `deny`). В **hybrid** —
allow-list сервера, усиленный **server-scoped токенами** (Уровень 2, проектируется сразу). Детали — [AD-090](./ad-090-extension-api.md).

### 2. Editions (специализированные сборки)

- **Пресет-метапакет:** `edition.json` с зависимостями — плагины, скиллы, **agent-packs**, **темы**,
  **локали (i18n)**, **провайдер/модель-паки**, flavor-образ, toolchain.
- **Официальные vs community-редакции** с trust-уровнями (иерархия [AD-068](./ad-068-skills-agents-registry.md)).
- **Каталог editions**; CLI/API `edition list|install|info|update`.
- **Сборка из пресета** смыкается с [AD-082](./ad-082-full-images-deployment.md) (flavor-образы).
- **Upstream-sync** вместо жёсткого форка (rebase/скрипт); рекомендации по именованию и **trademark policy**
  (что можно называть «Synth …»); совместимость лицензий компонентов.

### 3. Contribution flow + скилл доработки

- **Скилл** `synth-extend`/`synth-contrib` (builtin или official-реестр) ведёт по циклу:
  классификация запроса (issue/design) → design-first AD → план ([AD-039](./ad-039-plan-in-project.md)) →
  реализация (file/shell/git-тулы, [AD-075](./ad-075-project-workspace-provisioning.md)/[AD-076](./ad-076-git-repo-registry-ssh.md)) →
  `pnpm build/typecheck/lint/test` → PR/ревью → поддержка.
- **Decision tree** «форк vs upstream»; шаблоны issue/PR; DCO/CLA; CI для внешних контрибьюторов.
- **Честная модель:** «предложил и реализовал за свой счёт — без гарантии принятия».

### 4. Внешние сервисы-надстройки (add-ons)

Класс внешних сервисов экосистемы Synth, которые **не входят в ядро и npm-пакеты** и общаются с Synth по
контрактам API v2 ([AD-017](./ad-017-api-v2-hono.md))/[AD-052](./ad-052-public-api-platform.md), MCP
([AD-071](./ad-071-mcp-servers-prompt.md)) и событий ([AD-089](./ad-089-external-events-automation.md)).

- **Свой репозиторий и свой жизненный цикл** — независимые релизы, версии и деплой.
- **Свои образы**, `docker-compose` и Helm-чарт.
- **Общий шаблон add-on'а** — единый скелет (репозиторий, CI, образ, compose/Helm, README/AGENTS.md, контракт
  интеграции), чтобы новый сервис поднимался быстро и единообразно (эталон — `addons/synth-addon-template`).
- **Реестр/каталог add-on'ов** — аналог каталога контента [AD-068](./ad-068-skills-agents-registry.md):
  индекс, trust-уровни, **install-policy** (по образцу матрицы AD-068), провенанс, подписи/checksums.
- **Версионирование** — семвер-совместимость с Synth (`apiVersion`/`host` range), окно deprecation.
- **Доверие:** те же уровни `builtin → verified → trusted → community`; сканер и install-policy переиспользуются.

**Шлюзы — отдельный класс (Gateway, [AD-087](./ad-087-gateways.md)):** внешний сервис-транспорт с двусторонним
обменом (мессенджеры/чаты/боты), своим контрактом адресации/идентичности/топологии. Эталон — Telegram-шлюз
`addons/synth-gateway-telegram`; все детали (топология «один бот — один инстанс», мультитенантность, HA через
leader election, singleton-гарантия) — в [AD-087](./ad-087-gateways.md), здесь не дублируются.

### 5. Единый манифест расширения `synth.pack`

Манифест **всех** классов расширений и контент-паков — единый файл **`synth.pack`** (JSON) в корне репозитория
расширения. Схема/загрузка для классов с кодом — [AD-090](./ad-090-extension-api.md); для контент-паков
(индекс/trust/install-policy/провенанс) — [AD-068](./ad-068-skills-agents-registry.md).

Поля: `name`, `version`, `kind` (`plugin|gateway|addon|pack`), `host`, `contracts`, `description`,
`provides` (для `pack` дополнительно `packType`).

- `kind: "plugin" | "gateway" | "addon"` — класс кода/сервиса (Plugin/Gateway/Add-on);
- `kind: "pack"` + `packType` — тип контент-пака: `skills`, `agents`, `mcp`, `themes`, `i18n`, `providers`,
  `prompts`, `automation`, `policies`, `memory`, `ui` ([AD-068](./ad-068-skills-agents-registry.md)).

npm-плагин кладёт `synth.pack` в `files` пакета (канонический манифест — файл `synth.pack`, а не поле в
`package.json`; см. [AD-090](./ad-090-extension-api.md) §3). Реестр/индекс/trust/install-policy/провенанс —
**единые** для всех классов и типов ([AD-068](./ad-068-skills-agents-registry.md)).

### Что уже есть

- **Точек расширения нет.** Хуки/hook-шина [AD-030](./ad-030-hooks-agent-events.md) реализованы, но Plugin SDK
  (`SynthPlugin`) и загрузка плагинов — нет; grep `SynthPlugin` по `packages/` — пусто (кроме Vite/tailwind
  и `blockUnsafeOperationsPlugin` внутри git-обёртки).
- **Публикуемые пакеты** [AD-038](./ad-038-npm-packages.md) — ключевой enabler editions: 6 независимых npm-пакетов,
  тонкая `@itphx/synth`, `scripts/{build,publish,version-bump}.sh`.
- **Flavor-образы** [AD-082](./ad-082-full-images-deployment.md) — уже предтеча «editions» для образов
  (`slim/core/dev/devops/browser/full`, alpine+debian); не реализовано.
- **Контент-платформа** [AD-046](./ad-046-skills-and-slash-commands.md)/[AD-068](./ad-068-skills-agents-registry.md) —
  скиллы/agent-packs, реестр, trust/install-policy/провенанс, `skill-creator`; плагины/editions/add-on'ы/шлюзы
  логично наследуют trust/guard-модель (внешние каталоги по умолчанию выключены).
- **Dogfooding-скиллы** — локальные `.opencode/skills/` (`synth-dev`, `synth-build-publish`, `synth-release`,
  `synth-agents-md`, `synth-dev-cycle`); скилл доработки делается в этом же формате, в перспективе — builtin
  семейства `skill-creator`.
- **Первые внешние сервисы уже есть** — `synth-media` (отдельный репозиторий; Telegram-MCP + бот + приём
  пересылок) и эталонный **Telegram-шлюз** `addons/synth-gateway-telegram` ([AD-087](./ad-087-gateways.md));
  общий шаблон add-on'а пока не оформлен как поставка.
- **Инфраструктура-опора:** config [AD-023](./ad-023-configuration.md), permissions [AD-029](./ad-029-granular-permissions.md),
  API v2 [AD-017](./ad-017-api-v2-hono.md), события [AD-024](./ad-024-eventhub-transport.md),
  guard [AD-036](./ad-036-llm-gateway.md), home/хранение [AD-005](./ad-005-json-storage.md)/[AD-045](./ad-045-hybrid-server-profiles.md)/[AD-079](./ad-079-local-home-independent-instances.md),
  гибрид/политики [AD-042](./ad-042-hybrid-mode.md)/[AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md),
  промпт [AD-070](./ad-070-system-prompt-composer.md), egress [AD-088](./ad-088-http-proxy.md).
- **Лицензия MIT:** корневой `synth/LICENSE` (англ.) + `synth/LICENSE.ru.md` (рус.; приоритет — у англ.),
  правообладатель `Дмитрий Рамазанов <ramazanov_dv@mail.ru>`; `license: MIT` во всех `package.json`
  (root + 6 пакетов). В npm-пакеты оба файла материализуются при публикации (`scripts/publish.sh`,
  copy-on-publish + `.gitignore`).

### Зависимости

[AD-030](./ad-030-hooks-agent-events.md) (hooks/Plugin SDK — фундамент), [AD-038](./ad-038-npm-packages.md) (npm),
[AD-068](./ad-068-skills-agents-registry.md) (trust/guard/каталог/провенанс + контент-паки/`synth.pack`),
[AD-046](./ad-046-skills-and-slash-commands.md) (скиллы/команды/`skill-creator`),
[AD-082](./ad-082-full-images-deployment.md) (flavor-образы),
[AD-089](./ad-089-external-events-automation.md) (Event/Binding/Router для событийных add-on'ов и шлюзов),
[AD-087](./ad-087-gateways.md) (класс Gateway — шлюзы/Telegram, HA),
[AD-090](./ad-090-extension-api.md) (Extension API v1, манифест `synth.pack`, классы),
[AD-023](./ad-023-configuration.md) (конфиг), [AD-029](./ad-029-granular-permissions.md) (permissions),
[AD-036](./ad-036-llm-gateway.md)/[AD-037](./ad-037-commit-security-step.md) (безопасность),
[AD-005](./ad-005-json-storage.md)/[AD-045](./ad-045-hybrid-server-profiles.md)/[AD-079](./ad-079-local-home-independent-instances.md) (хранение/home),
[AD-017](./ad-017-api-v2-hono.md)/[AD-024](./ad-024-eventhub-transport.md) (API/события),
[AD-042](./ad-042-hybrid-mode.md)/[AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md) (гибрид/политики),
[AD-088](./ad-088-http-proxy.md) (egress add-on'ов и шлюзов), D3 (self-help/dogfooding), D21/D22 (гайдлайны и стандарты).

## Статус реализации в коде

**Extension API / editions / contribution flow — не реализованы (концепт/проект); Telegram-шлюз (класс Gateway) — реализован ([AD-087](./ad-087-gateways.md)).**

Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- **Extension API v1** (манифест `synth.pack`, фасад `@itphx/synth-plugin` + disposer-модель, загрузчик,
  trust/scan, install/activate, `plugins.lock.json`/`plugins.json`) — **специфицирован в [AD-090](./ad-090-extension-api.md)
  и не реализован**.
- Хуки/hook-шина [AD-030](./ad-030-hooks-agent-events.md) реализованы; Plugin SDK / загрузка плагинов
  (`SynthPlugin`) — нет.
- Реестра/каталога editions и add-on'ов нет; install-policy для них не существует.
- [AD-082](./ad-082-full-images-deployment.md) (flavor-образы) — не реализовано.
- [AD-068](./ad-068-skills-agents-registry.md) (реестр/каталог контента) — не реализовано; [AD-046](./ad-046-skills-and-slash-commands.md)
  реализован частично (скиллы/команды есть, backend-админка каталога — нет).
- **Telegram-шлюз** (`addons/synth-gateway-telegram`) — реализован и мультитенантен (см. [AD-087](./ad-087-gateways.md)).

**Что уже можно переиспользовать:**

- npm-пакеты и `scripts/{build,publish,version-bump}.sh` ([AD-038](./ad-038-npm-packages.md)) — реализованы.
- Механизм скиллов и slash-команд ([AD-046](./ad-046-skills-and-slash-commands.md)) — реализован (формат `SKILL.md`,
  discovery, тул `skill`, scope-API).
- Внешние сервисы: `synth-media` (Telegram-MCP + бот) и Telegram-шлюз ([AD-087](./ad-087-gateways.md)) — де-факто
  существующие add-on/gateway.

## Открытые вопросы

- ~~**Декомпозиция:** один AD или несколько~~ — **закрыто:** Extension API v1 выделен в отдельный [AD-090](./ad-090-extension-api.md)
  (AD-086 остаётся зонтиком: плагины/gateway/editions/contribution/add-on'ы/контент-паки).
- ~~**Реестр:** переиспользовать каталог [AD-068](./ad-068-skills-agents-registry.md) или отдельный~~ — **закрыто:**
  переиспользуется единая trust/guard-инфраструктура каталога [AD-068](./ad-068-skills-agents-registry.md) ([AD-090](./ad-090-extension-api.md)).
- ~~**Исполнение стороннего кода:** JS-плагины в процессе ядра — какой sandbox~~ — **закрыто:** bundle-only +
  trust/скан ([AD-068](./ad-068-skills-agents-registry.md)) + server-scoped токены ([AD-090](./ad-090-extension-api.md)).
- **Стабильность Extension API:** что считается public, semver-политика, окно deprecation.
- **Editions:** пресет-метапакет (меньше дрейфа, рекомендуемо) vs полноценный long-lived форк ядра; как
  синхронизировать форк (гайд, скрипт, rebase, subtree)?
- **Брендинг и юр.:** trademark policy (логотип/имя в форках), совместимость лицензий плагинов/editions/add-on'ов.
- **Contribution:** DCO vs CLA, кто ревьюит и SLA, что делаем с «предложил, но не реализовал/забросил».
- **Экономика «за свой счёт»:** только PR vs спонсорство/баунти; как не превратить в обязательство core-команды.
- ~~**Управляемый гибрид:** разрешать ли сторонние плагины/editions/add-on'ы на managed-бэкенде~~ — **закрыто:**
  разрешены; managed — установка ADMIN (deploy-time + runtime-опция), hybrid — allow-list сервера с server-scoped
  токенами ([AD-090](./ad-090-extension-api.md); политики — [AD-081](./ad-081-hybrid-policy-leak-protection.md)).
- **Скилл доработки:** builtin (в поставке) vs official-реестр; нужны ли спец-тулы (git/fork/PR/CI-статус).
- **Шаблон add-on'а:** что именно в общем скелете (язык, CI, формат контракта интеграции), как проверять
  совместимость версий с Synth.

_Вопросы шлюза (топология приёма, HA-стейт, реализация leader election, судьба `strategy`, webhook-транспорт) —
[AD-087](./ad-087-gateways.md) §6._

## Связи

- [AD-090](./ad-090-extension-api.md) — Extension API v1: терминология 4 классов, манифест `synth.pack`, загрузка, install/activate, trust/scan, режимы (спецификация плагинов; вынесена из AD-086).
- [AD-087](./ad-087-gateways.md) — класс «Шлюзы (gateways)»: контракт, Telegram-шлюз, мультитенантность, HA.
- [AD-030](./ad-030-hooks-agent-events.md) — hooks/Plugin SDK: фундамент Extension API и событийных add-on'ов.
- [AD-038](./ad-038-npm-packages.md) — npm-пакеты: enabler editions и распространения плагинов.
- [AD-068](./ad-068-skills-agents-registry.md) — переиспользуемая инфраструктура trust/guard/каталога/провенанса и единый манифест контент-паков `synth.pack`.
- [AD-046](./ad-046-skills-and-slash-commands.md) — механизм скиллов; агент-паки и `skill-creator`.
- [AD-082](./ad-082-full-images-deployment.md) — flavor-образы как предтеча editions и образов add-on'ов.
- [AD-089](./ad-089-external-events-automation.md) — Event/Binding/Router: как шлюзы и add-on'ы приносят события в Synth.
- [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) — гибрид и политики для сторонних расширений.
- [AD-055](./ad-055-instance-exchange.md) — обмен между инстансами: родственная тема мультитенантности шлюза (один бот → несколько инстансов/тенантов).
- [AD-032](./ad-032-history-storage-postgresql.md) — PostgreSQL: возможная опора общего стейта HA-шлюза (мультирепличный `offset`/дедуп).
- [AD-088](./ad-088-http-proxy.md) — egress внешних add-on/gateway сервисов.
- `synth-media` — существующий внешний сервис-демонстратор (прототип add-on'а).
