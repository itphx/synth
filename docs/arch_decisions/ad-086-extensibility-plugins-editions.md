# AD-086: Расширяемость Synth: плагины, editions, вклад в mainline и внешние сервисы-надстройки

> **Статус:** ⏳ Не реализовано (концепт/проект)
> **Дата:** 2026-10-02
> **Обновлено:** 2026-10-08 — добавлен четвёртый столп «внешние сервисы-надстройки (add-ons / bridge services)»
> и первый частный случай (Telegram gateway); сюда же **поглощён** [AD-087](./ad-087-messenger-gateway-merged.md)
> «Gateway для подключения к мессенджерам».
> **Связано:** [AD-030](./ad-030-hooks-agent-events.md) «Hooks/Plugin SDK», [AD-038](./ad-038-npm-packages.md) «npm-пакеты»,
> [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы», [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог»,
> [AD-082](./ad-082-full-images-deployment.md) «Flavor-образы», [AD-089](./ad-089-external-events-automation.md) «Платформа внешних событий»,
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md).

**Решение:** дать сообществу и пользователям **лёгкий путь** доработать Synth без приватного форка ядра. Четыре
взаимодополняющих столпа:

1. **Extension API** — расширять без форка: версионированный контракт плагинов, точки расширения, загрузка
   из npm/каталога/реестра, trust/scan/install-policy (по образцу [AD-068](./ad-068-skills-agents-registry.md)).
2. **Editions** — собрать и поддерживать свою редакцию (по образцу Ubuntu): пресет-метапакет из плагинов,
   скиллов, агентов, flavor-образов, темы и тулчейна.
3. **Contribution flow** — предложить функционал в mainline и реализовать его своим Synth'ом за свой счёт:
   отдельный скилл ведёт агента и разработчика по циклу issue/design → план → реализация → тесты → PR.
4. **Внешние сервисы-надстройки (add-ons / bridge services)** — вынести целые интеграционные подсистемы
   в отдельные сервисы со **своим** репозиторием, образами, `docker-compose`/Helm и **общим шаблоном**;
   реестр/каталог и trust/install-policy — по образцу [AD-068](./ad-068-skills-agents-registry.md).
   **Первый частный случай — Telegram gateway.**

Выигрыш: пользователь получает нужное, проект — функционал и экосистему, авторы плагинов/editions/add-on'ов —
аудиторию. Кастомизация не требует держать приватный форк ядра.

## Контекст

Synth открыт (лицензия MIT), но расширить его сегодня можно только форком ядра. При этом уже есть заделы:
публикуемые npm-пакеты ([AD-038](./ad-038-npm-packages.md)), flavor-образы ([AD-082](./ad-082-full-images-deployment.md)),
контент-платформа скиллов/агентов ([AD-046](./ad-046-skills-and-slash-commands.md)/[AD-068](./ad-068-skills-agents-registry.md)),
проект hooks/Plugin SDK ([AD-030](./ad-030-hooks-agent-events.md)). Не хватает формализованного контракта расширения,
механизма упаковки/распространения и — отдельно — места для **сервисов**, которые не должны жить в ядре
(мессенджер-шлюзы, коннекторы, внешние интеграции).

Отдельно выделяется класс интеграционных подсистем, которым тесно в ядре: они требуют сети, секретов,
деплоя, своего жизненного цикла и часто своего языка/стека. Их правильнее оформлять как **внешние
сервисы-надстройки**. Первый конкретный запрос сообщества — gateway к мессенджерам (черновик AD-087).

## Детали

### 1. Extension API (расширять без форка)

- **Контракт плагина:** манифест (`name`, `version`, `apiVersion`, `host` range, `engines`).
- **Точки расширения:** встроенные тулы, провайдеры, HTTP-роуты, event-hooks ([AD-030](./ad-030-hooks-agent-events.md)),
  UI-слоты/панели, скиллы/agent-packs.
- **Загрузка:** npm-пакет / локальный каталог / реестр.
- **Доверие и безопасность:** trust + сканер + install-policy по образцу [AD-068](./ad-068-skills-agents-registry.md);
  sandbox/лимиты и явные permissions ([AD-029](./ad-029-granular-permissions.md)); аудит; глобальный выключатель.
- **Стабильность:** semver-политика, окно deprecation для `apiVersion`.

### 2. Editions (специализированные сборки)

- **Пресет-метапакет:** `edition.json` с зависимостями — плагины, скиллы, agents, flavor-образ, тема, toolchain.
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

### 4. Внешние сервисы-надстройки (add-ons / bridge services)

Класс внешних сервисов экосистемы Synth, которые **не входят в ядро и npm-пакеты** и общаются с Synth по
контрактам API v2 ([AD-017](./ad-017-api-v2-hono.md))/[AD-052](./ad-052-public-api-platform.md), MCP
([AD-071](./ad-071-mcp-servers-prompt.md)) и событий ([AD-089](./ad-089-external-events-automation.md)).

- **Свой репозиторий и свой жизненный цикл** — независимые релизы, версии и деплой.
- **Свои образы**, `docker-compose` и Helm-чарт.
- **Общий шаблон add-on'а** — единый скелет (репозиторий, CI, образ, compose/Helm, README/AGENTS.md, контракт
  интеграции), чтобы новый сервис поднимался быстро и единообразно.
- **Реестр/каталог add-on'ов** — аналог каталога контента [AD-068](./ad-068-skills-agents-registry.md):
  индекс, trust-уровни, **install-policy** (по образцу матрицы AD-068), провенанс, подписи/checksums.
- **Версионирование** — семвер-совместимость с Synth (`apiVersion`/`host` range), окно deprecation.
- **Доверие:** те же уровни `builtin → verified → trusted → community`; сканер и install-policy переиспользуются.

#### Первый частный случай — Telegram gateway

Gateway к мессенджерам (поглощённый [AD-087](./ad-087-messenger-gateway-merged.md)) — эталонный add-on:

- **MCP-сервер (Synth → шлюз):** отправка/редактирование сообщений, уведомления, inline-кнопки, вложения.
- **Webhook (шлюз → Synth):** входящие сообщения/нажатия кнопок приходят как внешние события
  ([AD-089](./ad-089-external-events-automation.md): `Event`/`Binding`/`Router`); альтернатива — long-polling.
- **Маппинг identity** (пользователь мессенджера → профиль/RBAC), **секреты ботов** (at-rest по модели
  [AD-076](./ad-076-git-repo-registry-ssh.md)), **дедуп/идемпотентность**, **вложения** (→ [AD-085](./ad-085-multimodal-input.md)).
- **Привязки `Binding`** (чат/тред/топик ↔ сессия/проект) и права — по [AD-089](./ad-089-external-events-automation.md).

### Поглощение AD-087

**AD-087 «Gateway для подключения к мессенджерам» признан поглощённым этим AD.** Общий шаблон внешних
add-on'ов шире, чем один gateway, поэтому тема перенесена сюда (раздел 4 + «Первый частный случай»).
Файл [AD-087](./ad-087-messenger-gateway-merged.md) оставлен как **указатель** (tombstone): адаптеры/коннекторы,
binding чат↔сессия, webhook/long-polling, identity, дедуп и вложения унаследованы и развиваются здесь.

### Что уже есть

- **Точек расширения нет.** Хуки/hook-шина [AD-030](./ad-030-hooks-agent-events.md) реализованы, но Plugin SDK
  (`SynthPlugin`) и загрузка плагинов — нет; grep `SynthPlugin` по `packages/` — пусто (кроме Vite/tailwind
  и `blockUnsafeOperationsPlugin` внутри git-обёртки).
- **Публикуемые пакеты** [AD-038](./ad-038-npm-packages.md) — ключевой enabler editions: 6 независимых npm-пакетов,
  тонкая `@itphx/synth`, `scripts/{build,publish,version-bump}.sh`.
- **Flavor-образы** [AD-082](./ad-082-full-images-deployment.md) — уже предтеча «editions» для образов
  (`slim/core/dev/devops/browser/full`, alpine+debian); не реализовано.
- **Контент-платформа** [AD-046](./ad-046-skills-and-slash-commands.md)/[AD-068](./ad-068-skills-agents-registry.md) —
  скиллы/agent-packs, реестр, trust/install-policy/провенанс, `skill-creator`; плагины/editions/add-on'ы
  логично наследуют trust/guard-модель (внешние каталоги по умолчанию выключены).
- **Dogfooding-скиллы** — локальные `.opencode/skills/` (`synth-dev`, `synth-build-publish`, `synth-release`,
  `synth-agents-md`, `synth-dev-cycle`); скилл доработки делается в этом же формате, в перспективе — builtin
  семейства `skill-creator`.
- **Первый внешний сервис уже есть** — `synth-media` (отдельный репозиторий; Telegram-MCP + бот + приём
  пересылок), де-факто прототип add-on'а; общего шаблона пока нет.
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
[AD-068](./ad-068-skills-agents-registry.md) (trust/guard/каталог/провенанс), [AD-046](./ad-046-skills-and-slash-commands.md)
(скиллы/команды/`skill-creator`), [AD-082](./ad-082-full-images-deployment.md) (flavor-образы),
[AD-089](./ad-089-external-events-automation.md) (Event/Binding/Router для событийных add-on'ов),
[AD-087](./ad-087-messenger-gateway-merged.md) (tombstone, поглощён),
[AD-023](./ad-023-configuration.md) (конфиг), [AD-029](./ad-029-granular-permissions.md) (permissions),
[AD-036](./ad-036-llm-gateway.md)/[AD-037](./ad-037-commit-security-step.md) (безопасность),
[AD-005](./ad-005-json-storage.md)/[AD-045](./ad-045-hybrid-server-profiles.md)/[AD-079](./ad-079-local-home-independent-instances.md) (хранение/home),
[AD-017](./ad-017-api-v2-hono.md)/[AD-024](./ad-024-eventhub-transport.md) (API/события),
[AD-042](./ad-042-hybrid-mode.md)/[AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md) (гибрид/политики),
[AD-088](./ad-088-http-proxy.md) (egress add-on'ов), D3 (self-help/dogfooding), D21/D22 (гайдлайны и стандарты).

## Статус реализации в коде

**Не реализовано, кода нет (концепт/проект).**

Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Хуки/hook-шина [AD-030](./ad-030-hooks-agent-events.md) реализованы; Plugin SDK / загрузка плагинов
  (`SynthPlugin`) — нет.
- Реестра/каталога editions и add-on'ов нет; install-policy для них не существует.
- [AD-082](./ad-082-full-images-deployment.md) (flavor-образы) — не реализовано.
- [AD-068](./ad-068-skills-agents-registry.md) (реестр/каталог контента) — не реализовано; [AD-046](./ad-046-skills-and-slash-commands.md)
  реализован частично (скиллы/команды есть, backend-админка каталога — нет).

**Что уже можно переиспользовать:**

- npm-пакеты и `scripts/{build,publish,version-bump}.sh` ([AD-038](./ad-038-npm-packages.md)) — реализованы.
- Механизм скиллов и slash-команд ([AD-046](./ad-046-skills-and-slash-commands.md)) — реализован (формат `SKILL.md`,
  discovery, тул `skill`, scope-API).
- Внешний `synth-media` (отдельный репозиторий, Telegram-MCP + бот) — де-факто существующий add-on.

## Открытые вопросы

- **Декомпозиция:** один AD или несколько (расширения / editions / contribution+скилл / add-on'ы)?
- **Реестр:** переиспользовать каталог [AD-068](./ad-068-skills-agents-registry.md) (единая trust/guard-инфраструктура)
  или отдельный для плагинов/editions/add-on'ов?
- **Исполнение стороннего кода:** JS-плагины в процессе ядра — какой sandbox (worker/child-process/VM), какие
  capabilities; нужны ли декларативные (не исполняемые) плагины на первом этапе?
- **Стабильность Extension API:** что считается public, semver-политика, окно deprecation.
- **Editions:** пресет-метапакет (меньше дрейфа, рекомендуемо) vs полноценный long-lived форк ядра; как
  синхронизировать форк (гайд, скрипт, rebase, subtree)?
- **Брендинг и юр.:** trademark policy (логотип/имя в форках), совместимость лицензий плагинов/editions/add-on'ов.
- **Contribution:** DCO vs CLA, кто ревьюит и SLA, что делаем с «предложил, но не реализовал/забросил».
- **Экономика «за свой счёт»:** только PR vs спонсорство/баунти; как не превратить в обязательство core-команды.
- **Управляемый гибрид:** разрешать ли сторонние плагины/editions/add-on'ы на managed-бэкенде
  (политики [AD-081](./ad-081-hybrid-policy-leak-protection.md)) или только standalone.
- **Скилл доработки:** builtin (в поставке) vs official-реестр; нужны ли спец-тулы (git/fork/PR/CI-статус).
- **Шаблон add-on'а:** что именно в общем скелете (язык, CI, формат контракта интеграции), как проверять
  совместимость версий с Synth.

## Связи

- [AD-030](./ad-030-hooks-agent-events.md) — hooks/Plugin SDK: фундамент Extension API и событийных add-on'ов.
- [AD-038](./ad-038-npm-packages.md) — npm-пакеты: enabler editions и распространения плагинов.
- [AD-068](./ad-068-skills-agents-registry.md) — переиспользуемая инфраструктура trust/guard/каталога/провенанса.
- [AD-046](./ad-046-skills-and-slash-commands.md) — механизм скиллов; агент-паки и `skill-creator`.
- [AD-082](./ad-082-full-images-deployment.md) — flavor-образы как предтеча editions и образов add-on'ов.
- [AD-089](./ad-089-external-events-automation.md) — Event/Binding/Router: как add-on'ы (gateway) приносят события в Synth.
- [AD-087](./ad-087-messenger-gateway-merged.md) — поглощённый каталог «Gateway для мессенджеров» (указатель).
- [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) — гибрид и политики для сторонних расширений.
- [AD-088](./ad-088-http-proxy.md) — egress внешних add-on сервисов.
- `synth-media` — существующий внешний сервис-демонстратор (прототип add-on'а).
