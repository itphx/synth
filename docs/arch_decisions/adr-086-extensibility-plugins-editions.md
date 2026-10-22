# ADR-086: Расширяемость Synth: классы расширений, editions и contribution flow

> **Статус:** ⚠️ Частично — первый **Gateway** (Telegram-шлюз) реализован и мультитенантен; эталон **Add-on** — `synth-media`; **доставка пакета расширения в ядро** реализована ([ADR-100](./adr-100-extension-packs-pipelines.md): манифест `synth.pack` валидируется, установка — одна операция, одобрение администратора); класс **Gateway** выделен в [ADR-087](./adr-087-gateways.md) (HA/leader election — нет); класс **Storage** выделен в [ADR-097](./adr-097-storage-provider-class.md) (PostgreSQL-драйвер — нет); Plugin SDK ([PROP-090](./prop-090-extension-api.md) — в работе, в коде нет; спецификация 2026-10-22 добавляет два режима исполнения плагина: inline и out-of-process), editions и contribution flow — нет
> **Дата:** 2026-10-02
> **Обновлено:** 2026-10-22 — PROP-090 **вернулся в работу** (🧩 Предложение, срок решения 2026-11-14); Plugin определён
> как **код расширения с двумя режимами исполнения** — `inline` (в процессе ядра) и `out-of-process` (отдельный процесс);
> в коде Plugin SDK по-прежнему нет.
> **Обновлено:** 2026-10-20 — **доставка пакета в ядро** вынесена в [ADR-100](./adr-100-extension-packs-pipelines.md):
> контракт манифеста валидируется в ядре, установка — одна операция `POST /api/v2/packs`, пакеты с
> capability-грантами требуют одобрения администратора; `provides` аддона может включать `agents`/`pipelines`.
> **Обновлено:** 2026-10-16 — добавлен класс **Storage** (драйверы слоя хранения; `kind: "storage"`) — [ADR-097](./adr-097-storage-provider-class.md); посторонние материалы не дублируются.
> **Обновлено:** 2026-10-14 — **реструктуризация классов расширений**: класс **Gateway** выделен в действующий
> [ADR-087](./adr-087-gateways.md) (туда перенесён весь материал Telegram-шлюза, в ADR-086 дубликатов нет), а ADR-086
> стал **зонтиком «Классы расширений»** (Plugin / Gateway / Add-on / контент-пак + Editions + Contribution flow);
> введён **единый манифест** `synth.pack` для всех классов и контент-паков; терминология 4 классов закреплена в
> [PROP-090](./prop-090-extension-api.md).
> **Обновлено:** 2026-10-12 — Extension API v1 вынесен в отдельный [PROP-090](./prop-090-extension-api.md);
> ограничение «плагины только standalone» снято (плагины разрешены во всех режимах: managed — установка ADMIN,
> hybrid — allow-list сервера с server-scoped токенами). Ранее (2026-10-08) добавлен четвёртый столп «внешние
> сервисы-надстройки (add-ons)».
> **Классы расширений:** Plugin → [PROP-090](./prop-090-extension-api.md); **Gateway → [ADR-087](./adr-087-gateways.md)**;
> Add-on → этот AD; контент-паки → [PROP-068](./prop-068-skills-agents-registry.md); **Storage → [ADR-097](./adr-097-storage-provider-class.md)**; Edition → этот AD.
> **Связано:** [ADR-100](./adr-100-extension-packs-pipelines.md) «Пакет расширения и пайплайн в ядре»,
> [PROP-090](./prop-090-extension-api.md) «Extension API v1», [ADR-087](./adr-087-gateways.md) «Шлюзы (gateways)»,
> [ADR-030](./adr-030-hooks-agent-events.md) «Hooks/Plugin SDK», [ADR-038](./adr-038-npm-packages.md) «npm-пакеты»,
> [ADR-046](./adr-046-skills-and-slash-commands.md) «Скиллы», [PROP-068](./prop-068-skills-agents-registry.md) «Реестр и каталог»,
> [PROP-082](./prop-082-full-images-deployment.md) «Flavor-образы», [ADR-089](./adr-089-external-events-automation.md) «Платформа внешних событий»,
> [ADR-023](./adr-023-configuration.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md),
> [ADR-042](./adr-042-hybrid-mode.md), [PROP-080](./prop-080-managed-hybrid-modes.md), [PROP-081](./prop-081-hybrid-policy-leak-protection.md),
> [PROP-055](./prop-055-instance-exchange.md) «Обмен между инстансами», [ADR-097](./adr-097-storage-provider-class.md) «PostgreSQL».

**Решение:** дать сообществу и пользователям **лёгкий путь** доработать Synth без приватного форка ядра. Четыре
взаимодополняющих столпа и набор **классов расширений**:

1. **Extension API** (спецификация — [PROP-090](./prop-090-extension-api.md)) — расширять без форка: версионированный
   контракт плагинов, точки расширения, загрузка из npm/каталога/реестра, trust/scan/install-policy (по образцу
   [PROP-068](./prop-068-skills-agents-registry.md)). Терминология жёсткая — пять классов: **Plugin** (код в процессе
   ядра) / **Gateway** ([ADR-087](./adr-087-gateways.md), внешний сервис-транспорт) / **Add-on** (внешний сервис
   иного назначения) / **контент-пак** (данные без кода) / **Storage** ([ADR-097](./adr-097-storage-provider-class.md),
   драйвер слоя хранения) — см. §«Классы расширений».
2. **Editions** — собрать и поддерживать свою редакцию (по образцу Ubuntu): пресет-метапакет из плагинов,
   скиллов, агентов (agent-packs), тем, локалей (i18n), провайдер/модель-паков, flavor-образов и тулчейна.
3. **Contribution flow** — предложить функционал в mainline и реализовать его своим Synth'ом за свой счёт:
   отдельный скилл ведёт агента и разработчика по циклу issue/design → план → реализация → тесты → PR.
4. **Внешние сервисы-надстройки (add-ons)** — вынести целые интеграционные подсистемы
   в отдельные сервисы со **своим** репозиторием, образами, `docker-compose`/Helm и **общим шаблоном**;
   реестр/каталог и trust/install-policy — по образцу [PROP-068](./prop-068-skills-agents-registry.md).
   **Шлюзы — отдельный класс (Gateway)** со своим контрактом, см. [ADR-087](./adr-087-gateways.md).

Все классы и контент-паки описываются **единым манифестом** `synth.pack` (§«Единый манифест расширения `synth.pack`»).

Выигрыш: пользователь получает нужное, проект — функционал и экосистему, авторы плагинов/editions/add-on'ов —
аудиторию. Кастомизация не требует держать приватный форк ядра.

## Классы расширений

| Класс | Что запускается | Где спецификация/детали |
|---|---|---|
| **Plugin** | код расширения: **в процессе ядра** (`inline`) или **отдельным процессом** (`out-of-process`); фасад `@itphx/synth-plugin` | [PROP-090](./prop-090-extension-api.md) |
| **Gateway** | **внешний сервис-транспорт** внешний мир ↔ Synth (двусторонний обмен) | **[ADR-087](./adr-087-gateways.md)** |
| **Add-on** | **внешний сервис** иного назначения (свой репозиторий/образы/деплой) | этот AD, §4 |
| **Storage** | **драйвер слоя хранения** (доменные порты + контрактный suite; `file`/`memory`/`postgres`) | **[ADR-097](./adr-097-storage-provider-class.md)** |
| **Контент-пак** | **данные без кода** (скиллы, agents, mcp, темы, i18n, провайдеры, промпты, automation, policies, memory, ui) | [PROP-068](./prop-068-skills-agents-registry.md) |
| **Edition** | пресет-метапакет (плагины + контент-паки + образ + тулчейн) | этот AD, §2 |

**Критерий выбора класса:** по умолчанию — **Gateway/Add-on** (внешний сервис); **Plugin — только когда
изменение обязано быть in-process** (синхронная трансформация потока, внутренние реестры, производительность).
Детали терминологии и таксономии влияния плагинов — [PROP-090](./prop-090-extension-api.md) §1.

## Контекст

Synth открыт (лицензия MIT), но расширить его сегодня можно только форком ядра. При этом уже есть заделы:
публикуемые npm-пакеты ([ADR-038](./adr-038-npm-packages.md)), flavor-образы ([PROP-082](./prop-082-full-images-deployment.md)),
контент-платформа скиллов/агентов ([ADR-046](./adr-046-skills-and-slash-commands.md)/[PROP-068](./prop-068-skills-agents-registry.md)),
проект hooks/Plugin SDK ([ADR-030](./adr-030-hooks-agent-events.md)). Не хватает формализованного контракта расширения,
механизма упаковки/распространения и — отдельно — места для **сервисов**, которые не должны жить в ядре
(мессенджер-шлюзы, коннекторы, внешние интеграции).

Отдельно выделяется класс интеграционных подсистем, которым тесно в ядре: они требуют сети, секретов,
деплоя, своего жизненного цикла и часто своего языка/стека. Их правильнее оформлять как **внешние
сервисы-надстройки**; их частный случай — **шлюзы** (Gateway, [ADR-087](./adr-087-gateways.md)). Первый конкретный
запрос сообщества — gateway к мессенджерам.

## Детали

### 1. Extension API (расширять без форка)

**Полная спецификация — [PROP-090](./prop-090-extension-api.md)**: терминология 4 классов (Plugin/Gateway/Add-on/
контент-пак), манифест (`synth.pack`), точки расширения (встроенные тулы, провайдеры, HTTP-роуты, event-hooks
[ADR-030](./adr-030-hooks-agent-events.md), UI-слоты/панели, скиллы/agent-packs), фасад `@itphx/synth-plugin` +
disposer-модель, bundle-only дистрибуция, install/activate (`plugins.lock.json`/`plugins.json`), trust/scan по
[PROP-068](./prop-068-skills-agents-registry.md), permissions ([ADR-029](./adr-029-granular-permissions.md)), semver-политика
и окно deprecation, а также режимы (managed/hybrid). Ниже — только указатель; детали не дублируются.

### Плагины, add-on'ы, шлюзы и режимы (обновлено 2026-10-14)

Пять классов расширений Synth (терминология жёсткая, [PROP-090](./prop-090-extension-api.md)):

| Класс | Что запускается | Режимы |
|---|---|---|
| **Plugin** | Код **в процессе core** (загружается через Extension API, фасад `@itphx/synth-plugin`) | standalone — владелец/ADMIN; **managed** — установка ADMIN (deploy-time — дефолт, runtime-install — опция, по умолчанию `deny`); **hybrid** — allow-list сервера + server-scoped токены |
| **Gateway** | **Внешний сервис-транспорт** внешний мир ↔ Synth (двусторонний); свой репозиторий/образы | Любой режим; общается по API v2/событиям/MCP; детали — [ADR-087](./adr-087-gateways.md) |
| **Add-on** | **Внешний сервис** иного назначения со своим репозиторием/образами/деплоем (эталон — `synth-media`) | Любой режим; общается по API v2/MCP/событиям |
| **Storage** | **Драйвер слоя хранения** (доменные порты `storage/ports/*` + контрактный suite `storage/contract/*`) | Любой режим; in-tree (`file`/`memory`) либо опциональный пакет; выбор — `storage.backend` ([ADR-023](./adr-023-configuration.md)); детали — [ADR-097](./adr-097-storage-provider-class.md) |
| **Контент-пак** | **Контент без кода** (скиллы, agent-packs, темы, i18n, провайдеры, промпты, automation, policies, memory, ui) | Любой режим; устанавливается из каталога ([PROP-068](./prop-068-skills-agents-registry.md)) |

**Ограничение «плагин только standalone» снято:** плагины разрешены во всех режимах. В **managed**
установку выполняет ADMIN (deploy-time по умолчанию; runtime-install — опция, по умолчанию `deny`). В **hybrid** —
allow-list сервера, усиленный **server-scoped токенами** (Уровень 2, проектируется сразу). Детали — [PROP-090](./prop-090-extension-api.md).

### 2. Editions (специализированные сборки)

- **Пресет-метапакет:** `edition.json` с зависимостями — плагины, скиллы, **agent-packs**, **темы**,
  **локали (i18n)**, **провайдер/модель-паки**, flavor-образ, toolchain.
- **Официальные vs community-редакции** с trust-уровнями (иерархия [PROP-068](./prop-068-skills-agents-registry.md)).
- **Каталог editions**; CLI/API `edition list|install|info|update`.
- **Сборка из пресета** смыкается с [PROP-082](./prop-082-full-images-deployment.md) (flavor-образы).
- **Upstream-sync** вместо жёсткого форка (rebase/скрипт); рекомендации по именованию и **trademark policy**
  (что можно называть «Synth …»); совместимость лицензий компонентов.

### 3. Contribution flow + скилл доработки

- **Скилл** `synth-extend`/`synth-contrib` (builtin или official-реестр) ведёт по циклу:
  классификация запроса (issue/design) → design-first AD → план ([ADR-039](./adr-039-plan-in-project.md)) →
  реализация (file/shell/git-тулы, [ADR-075](./adr-075-project-workspace-provisioning.md)/[ADR-076](./adr-076-git-repo-registry-ssh.md)) →
  `pnpm build/typecheck/lint/test` → PR/ревью → поддержка.
- **Decision tree** «форк vs upstream»; шаблоны issue/PR; DCO/CLA; CI для внешних контрибьюторов.
- **Честная модель:** «предложил и реализовал за свой счёт — без гарантии принятия».

### 4. Внешние сервисы-надстройки (add-ons)

Класс внешних сервисов экосистемы Synth, которые **не входят в ядро и npm-пакеты** и общаются с Synth по
контрактам API v2 ([ADR-017](./adr-017-api-v2-hono.md))/[ADR-052](./adr-052-public-api-platform.md), MCP
([ADR-071](./adr-071-mcp-servers-prompt.md)) и событий ([ADR-089](./adr-089-external-events-automation.md)).

- **Свой репозиторий и свой жизненный цикл** — независимые релизы, версии и деплой.
- **Свои образы**, `docker-compose` и Helm-чарт.
- **Общий шаблон add-on'а** — единый скелет (репозиторий, CI, образ, compose/Helm, README/AGENTS.md, контракт
  интеграции), чтобы новый сервис поднимался быстро и единообразно (эталон — `addons/synth-addon-template`).
- **Реестр/каталог add-on'ов** — аналог каталога контента [PROP-068](./prop-068-skills-agents-registry.md):
  индекс, trust-уровни, **install-policy** (по образцу матрицы PROP-068), провенанс, подписи/checksums.
- **Версионирование** — семвер-совместимость с Synth (`apiVersion`/`host` range), окно deprecation.
- **Доверие:** те же уровни `builtin → verified → trusted → community`; сканер и install-policy переиспользуются.

**Шлюзы — отдельный класс (Gateway, [ADR-087](./adr-087-gateways.md)):** внешний сервис-транспорт с двусторонним
обменом (мессенджеры/чаты/боты), своим контрактом адресации/идентичности/топологии. Эталон — Telegram-шлюз
`addons/synth-gateway-telegram`; все детали (топология «один бот — один инстанс», мультитенантность, HA через
leader election, singleton-гарантия) — в [ADR-087](./adr-087-gateways.md), здесь не дублируются.

### 5. Единый манифест расширения `synth.pack`

Манифест **всех** классов расширений и контент-паков — единый файл **`synth.pack`** (JSON) в корне репозитория
расширения. Схема/загрузка для классов с кодом — [PROP-090](./prop-090-extension-api.md); для контент-паков
(индекс/trust/install-policy/провенанс) — [PROP-068](./prop-068-skills-agents-registry.md).

Поля: `name`, `version`, `kind` (`plugin|gateway|addon|pack|storage`), `host`, `contracts`, `description`,
`provides` (для `pack` дополнительно `packType`).

- `kind: "plugin" | "gateway" | "addon"` — класс кода/сервиса (Plugin/Gateway/Add-on);
- `kind: "storage"` — драйвер слоя хранения (доменные порты; [ADR-097](./adr-097-storage-provider-class.md));
- `kind: "pack"` + `packType` — тип контент-пака: `skills`, `agents`, `mcp`, `themes`, `i18n`, `providers`,
  `prompts`, `automation`, `policies`, `memory`, `ui` ([PROP-068](./prop-068-skills-agents-registry.md)).

npm-плагин кладёт `synth.pack` в `files` пакета (канонический манифест — файл `synth.pack`, а не поле в
`package.json`; см. [PROP-090](./prop-090-extension-api.md) §3). Реестр/индекс/trust/install-policy/провенанс —
**единые** для всех классов и типов ([PROP-068](./prop-068-skills-agents-registry.md)).

**Состав `provides` — не только по `packType`.** `provides` — это **набор вкладов**, поэтому у
**любого** класса (в т.ч. у `addon` — у `synth-media` свой сервис-receiver, `kind` остаётся `addon`)
могут быть объявлены `agents` (с ролевым промптом) и `pipelines`; `packType` — только для
`kind: "pack"` и описывает **основной** вид вклада, а не весь состав.

**Доставка в ядро — одна операция** ([ADR-100](./adr-100-extension-packs-pipelines.md)): ядро
валидирует манифест и устанавливает пакет запросом `POST /api/v2/packs` (скиллы → MCP → агенты с
ролями → определения пайплайнов → порождённые правила маршрутизации). Пакет, дающий
capability-гранты (непустые `capabilities` агента), объявляющий пайплайны или расписания,
**требует одобрения администратора** (`POST /api/v2/packs/:name/approve`, только ADMIN) — фактическая
установка не выполняется до одобрения. **Plugin (код расширения) остаётся вне объёма** —
[PROP-090](./prop-090-extension-api.md) (вернулся в работу 2026-10-22).

### Что уже есть

- **Точек расширения нет.** Хуки/hook-шина [ADR-030](./adr-030-hooks-agent-events.md) реализованы, но Plugin SDK
  (`SynthPlugin`) и загрузка плагинов — нет; grep `SynthPlugin` по `packages/` — пусто (кроме Vite/tailwind
  и `blockUnsafeOperationsPlugin` внутри git-обёртки).
- **Публикуемые пакеты** [ADR-038](./adr-038-npm-packages.md) — ключевой enabler editions: 6 независимых npm-пакетов,
  тонкая `@itphx/synth`, `scripts/{build,publish,version-bump}.sh`.
- **Flavor-образы** [PROP-082](./prop-082-full-images-deployment.md) — уже предтеча «editions» для образов
  (`slim/core/dev/devops/browser/full`, alpine+debian); не реализовано.
- **Контент-платформа** [ADR-046](./adr-046-skills-and-slash-commands.md)/[PROP-068](./prop-068-skills-agents-registry.md) —
  скиллы/agent-packs, реестр, trust/install-policy/провенанс, `skill-creator`; плагины/editions/add-on'ы/шлюзы
  логично наследуют trust/guard-модель (внешние каталоги по умолчанию выключены).
- **Dogfooding-скиллы** — локальные `.opencode/skills/` (`synth-dev`, `synth-build-publish`, `synth-release`,
  `synth-agents-md`, `synth-dev-cycle`); скилл доработки делается в этом же формате, в перспективе — builtin
  семейства `skill-creator`.
- **Первые внешние сервисы уже есть** — `synth-media` (отдельный репозиторий; Telegram-MCP + бот + приём
  пересылок) и эталонный **Telegram-шлюз** `addons/synth-gateway-telegram` ([ADR-087](./adr-087-gateways.md));
  общий шаблон add-on'а пока не оформлен как поставка.
- **Инфраструктура-опора:** config [ADR-023](./adr-023-configuration.md), permissions [ADR-029](./adr-029-granular-permissions.md),
  API v2 [ADR-017](./adr-017-api-v2-hono.md), события [ADR-024](./adr-024-eventhub-transport.md),
  guard [ADR-036](./adr-036-llm-gateway.md), home/хранение [ADR-005](./adr-005-json-storage.md)/[ADR-045](./adr-045-hybrid-server-profiles.md)/[ADR-079](./adr-079-local-home-independent-instances.md),
  гибрид/политики [ADR-042](./adr-042-hybrid-mode.md)/[PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md),
  промпт [ADR-070](./adr-070-system-prompt-composer.md), egress [ADR-099](./adr-099-egress-tls-trust.md).
- **Лицензия MIT:** корневой `synth/LICENSE` (англ.) + `synth/LICENSE.ru.md` (рус.; приоритет — у англ.),
  правообладатель `Дмитрий Рамазанов <ramazanov_dv@mail.ru>`; `license: MIT` во всех `package.json`
  (root + 6 пакетов). В npm-пакеты оба файла материализуются при публикации (`scripts/publish.sh`,
  copy-on-publish + `.gitignore`).

### Зависимости

[ADR-030](./adr-030-hooks-agent-events.md) (hooks/Plugin SDK — фундамент), [ADR-038](./adr-038-npm-packages.md) (npm),
[PROP-068](./prop-068-skills-agents-registry.md) (trust/guard/каталог/провенанс + контент-паки/`synth.pack`),
[ADR-046](./adr-046-skills-and-slash-commands.md) (скиллы/команды/`skill-creator`),
[PROP-082](./prop-082-full-images-deployment.md) (flavor-образы),
[ADR-089](./adr-089-external-events-automation.md) (Event/Binding/Router для событийных add-on'ов и шлюзов),
[ADR-087](./adr-087-gateways.md) (класс Gateway — шлюзы/Telegram, HA),
[PROP-090](./prop-090-extension-api.md) (Extension API v1, манифест `synth.pack`, классы),
[ADR-023](./adr-023-configuration.md) (конфиг), [ADR-029](./adr-029-granular-permissions.md) (permissions),
[ADR-036](./adr-036-llm-gateway.md)/[PROP-037](./prop-037-commit-security-step.md) (безопасность),
[ADR-005](./adr-005-json-storage.md)/[ADR-045](./adr-045-hybrid-server-profiles.md)/[ADR-079](./adr-079-local-home-independent-instances.md) (хранение/home),
[ADR-017](./adr-017-api-v2-hono.md)/[ADR-024](./adr-024-eventhub-transport.md) (API/события),
[ADR-042](./adr-042-hybrid-mode.md)/[PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md) (гибрид/политики),
[ADR-099](./adr-099-egress-tls-trust.md) (egress add-on'ов и шлюзов), D3 (self-help/dogfooding), D21/D22 (гайдлайны и стандарты).

## Статус реализации в коде

**Extension API / editions / contribution flow — не реализованы (концепт/проект); Telegram-шлюз (класс Gateway) — реализован ([ADR-087](./adr-087-gateways.md)); доставка пакета расширения в ядро — реализована ([ADR-100](./adr-100-extension-packs-pipelines.md)).**

Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- **Доставка пакета расширения** (манифест `synth.pack` + валидация в ядре + установка одной
  операцией `POST /api/v2/packs` + одобрение администратора + реестр установок и провенанс +
  учёт экземпляров пайплайна) — **реализовано**, см. [ADR-100](./adr-100-extension-packs-pipelines.md);
  эталон — add-on `synth-media` (поставляется пакетом: роль `publisher`, скилл `media-hub`,
  MCP-сервер receiver'а, пайплайн публикации).
- **Extension API v1** (манифест `synth.pack`, фасад `@itphx/synth-plugin` + disposer-модель, загрузчик,
  trust/scan, install/activate, `plugins.lock.json`/`plugins.json`) — **специфицирован в [PROP-090](./prop-090-extension-api.md)
  и не реализован**.
- Хуки/hook-шина [ADR-030](./adr-030-hooks-agent-events.md) реализованы; Plugin SDK / загрузка плагинов
  (`SynthPlugin`) — нет.
- Реестра/каталога editions и add-on'ов нет; install-policy для них не существует.
- [PROP-082](./prop-082-full-images-deployment.md) (flavor-образы) — не реализовано.
- [PROP-068](./prop-068-skills-agents-registry.md) (реестр/каталог контента) — не реализовано; [ADR-046](./adr-046-skills-and-slash-commands.md)
  реализован частично (скиллы/команды есть, backend-админка каталога — нет).
- **Telegram-шлюз** (`addons/synth-gateway-telegram`) — реализован и мультитенантен (см. [ADR-087](./adr-087-gateways.md)).

**Что уже можно переиспользовать:**

- npm-пакеты и `scripts/{build,publish,version-bump}.sh` ([ADR-038](./adr-038-npm-packages.md)) — реализованы.
- Механизм скиллов и slash-команд ([ADR-046](./adr-046-skills-and-slash-commands.md)) — реализован (формат `SKILL.md`,
  discovery, тул `skill`, scope-API).
- Внешние сервисы: `synth-media` (Telegram-MCP + бот) и Telegram-шлюз ([ADR-087](./adr-087-gateways.md)) — де-факто
  существующие add-on/gateway.

## Открытые вопросы

- ~~**Декомпозиция:** один AD или несколько~~ — **закрыто:** Extension API v1 выделен в отдельный [PROP-090](./prop-090-extension-api.md)
  (ADR-086 остаётся зонтиком: плагины/gateway/editions/contribution/add-on'ы/контент-паки).
- ~~**Реестр:** переиспользовать каталог [PROP-068](./prop-068-skills-agents-registry.md) или отдельный~~ — **закрыто:**
  переиспользуется единая trust/guard-инфраструктура каталога [PROP-068](./prop-068-skills-agents-registry.md) ([PROP-090](./prop-090-extension-api.md)).
- ~~**Исполнение стороннего кода:** JS-плагины в процессе ядра — какой sandbox~~ — **закрыто:** bundle-only +
  trust/скан ([PROP-068](./prop-068-skills-agents-registry.md)) + server-scoped токены ([PROP-090](./prop-090-extension-api.md)).
- **Стабильность Extension API:** что считается public, semver-политика, окно deprecation.
- **Editions:** пресет-метапакет (меньше дрейфа, рекомендуемо) vs полноценный long-lived форк ядра; как
  синхронизировать форк (гайд, скрипт, rebase, subtree)?
- **Брендинг и юр.:** trademark policy (логотип/имя в форках), совместимость лицензий плагинов/editions/add-on'ов.
- **Contribution:** DCO vs CLA, кто ревьюит и SLA, что делаем с «предложил, но не реализовал/забросил».
- **Экономика «за свой счёт»:** только PR vs спонсорство/баунти; как не превратить в обязательство core-команды.
- ~~**Управляемый гибрид:** разрешать ли сторонние плагины/editions/add-on'ы на managed-бэкенде~~ — **закрыто:**
  разрешены; managed — установка ADMIN (deploy-time + runtime-опция), hybrid — allow-list сервера с server-scoped
  токенами ([PROP-090](./prop-090-extension-api.md); политики — [PROP-081](./prop-081-hybrid-policy-leak-protection.md)).
- **Скилл доработки:** builtin (в поставке) vs official-реестр; нужны ли спец-тулы (git/fork/PR/CI-статус).
- **Шаблон add-on'а:** что именно в общем скелете (язык, CI, формат контракта интеграции), как проверять
  совместимость версий с Synth.

_Вопросы шлюза (топология приёма, HA-стейт, реализация leader election, судьба `strategy`, webhook-транспорт) —
[ADR-087](./adr-087-gateways.md) §6._

## Связи

- [PROP-090](./prop-090-extension-api.md) — Extension API v1: терминология классов, манифест `synth.pack`, загрузка, install/activate, trust/scan, режимы (спецификация плагинов; вынесена из ADR-086).
- [ADR-100](./adr-100-extension-packs-pipelines.md) — доставка пакета расширения в ядро: валидация манифеста, установка одной операцией, одобрение администратора, реестр установок, пайплайны и учёт прогонов (продолжение §5 «Единый манифест расширения `synth.pack`»).
- [ADR-087](./adr-087-gateways.md) — класс «Шлюзы (gateways)»: контракт, Telegram-шлюз, мультитенантность, HA.
- [ADR-097](./adr-097-storage-provider-class.md) — класс «хранилище» (storage): драйвер слоя хранения (доменные порты + контрактный suite; `kind: "storage"`).
- [ADR-030](./adr-030-hooks-agent-events.md) — hooks/Plugin SDK: фундамент Extension API и событийных add-on'ов.
- [ADR-038](./adr-038-npm-packages.md) — npm-пакеты: enabler editions и распространения плагинов.
- [PROP-068](./prop-068-skills-agents-registry.md) — переиспользуемая инфраструктура trust/guard/каталога/провенанса и единый манифест контент-паков `synth.pack`.
- [ADR-046](./adr-046-skills-and-slash-commands.md) — механизм скиллов; агент-паки и `skill-creator`.
- [PROP-082](./prop-082-full-images-deployment.md) — flavor-образы как предтеча editions и образов add-on'ов.
- [ADR-089](./adr-089-external-events-automation.md) — Event/Binding/Router: как шлюзы и add-on'ы приносят события в Synth.
- [ADR-042](./adr-042-hybrid-mode.md), [PROP-080](./prop-080-managed-hybrid-modes.md), [PROP-081](./prop-081-hybrid-policy-leak-protection.md) — гибрид и политики для сторонних расширений.
- [PROP-055](./prop-055-instance-exchange.md) — обмен между инстансами: родственная тема мультитенантности шлюза (один бот → несколько инстансов/тенантов).
- [ADR-097](./adr-097-storage-provider-class.md) — PostgreSQL: возможная опора общего стейта HA-шлюза (мультирепличный `offset`/дедуп).
- [ADR-099](./adr-099-egress-tls-trust.md) — egress внешних add-on/gateway сервисов.
- `synth-media` — существующий внешний сервис-демонстратор (прототип add-on'а) и **эталон пакета расширения** (ставится в инстанс как пакет — [ADR-100](./adr-100-extension-packs-pipelines.md)).

## История

- 2026-10-22 — PROP-090 вернулся в работу; Plugin определён как код расширения с двумя режимами исполнения (`inline`/`out-of-process`); в коде SDK нет.
- 2026-10-20 — доставка пакета расширения в ядро вынесена в [ADR-100](./adr-100-extension-packs-pipelines.md); §5 дополнен: `provides` любого класса может включать `agents`/`pipelines`, установка — `POST /api/v2/packs`, capability-гранты требуют одобрения.
- 2026-10-16 — добавлен класс **Storage** (`kind: "storage"`) — [ADR-097](./adr-097-storage-provider-class.md).
