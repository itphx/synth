# AD-086: Расширяемость Synth: плагины, editions, вклад в mainline и внешние сервисы-надстройки

> **Статус:** ⏳ Не реализовано (концепт/проект)
> **Дата:** 2026-10-02
> **Обновлено:** 2026-10-12 — зафиксирован фактический эталон add-on'а (Telegram-шлюз в отдельном репозитории
> `addons/synth-gateway-telegram`): топология «один бот — один инстанс шлюза» (факты), HA через leader election
> (K8s Lease; не реализовано), мультитенантность (маршруты → `{synthUrl, creds, tenant}`; не реализовано),
> текущая гарантия singleton (`replicaCount: 1` + `strategy: Recreate`) и **пробел** — в addon-чарте `strategy`
> не задан; адаптеры каналов — отложенный путь. Ранее тем же днём: Extension API вынесен в отдельный [AD-090](./ad-090-extension-api.md); ограничение
> «плагины только standalone» снято (плагины разрешены во всех режимах: managed — установка ADMIN, hybrid — allow-list
> сервера с server-scoped токенами). Ранее (2026-10-08) добавлен четвёртый столп «внешние сервисы-надстройки
> (add-ons / bridge services)» и первый частный случай (Telegram gateway); сюда же **поглощён** [AD-087](./ad-087-messenger-gateway-merged.md)
> «Gateway для подключения к мессенджерам».
> **Связано:** [AD-090](./ad-090-extension-api.md) «Extension API v1», [AD-030](./ad-030-hooks-agent-events.md) «Hooks/Plugin SDK», [AD-038](./ad-038-npm-packages.md) «npm-пакеты»,
> [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы», [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог»,
> [AD-082](./ad-082-full-images-deployment.md) «Flavor-образы», [AD-089](./ad-089-external-events-automation.md) «Платформа внешних событий»,
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md),
> [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами», [AD-032](./ad-032-history-storage-postgresql.md) «PostgreSQL».

**Решение:** дать сообществу и пользователям **лёгкий путь** доработать Synth без приватного форка ядра. Четыре
взаимодополняющих столпа:

1. **Extension API** (спецификация — [AD-090](./ad-090-extension-api.md)) — расширять без форка: версионированный
   контракт плагинов, точки расширения, загрузка из npm/каталога/реестра, trust/scan/install-policy (по образцу
   [AD-068](./ad-068-skills-agents-registry.md)). Терминология жёсткая: **Plugin ≠ Add-on ≠ Declarative** — plugin
   (код в процессе core) и add-on (внешний сервис) суть разные классы, не синонимы.
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

**Полная спецификация — [AD-090](./ad-090-extension-api.md)**: терминология Plugin/Add-on/Declarative, манифест
(`synth.plugin`), точки расширения (встроенные тулы, провайдеры, HTTP-роуты, event-hooks [AD-030](./ad-030-hooks-agent-events.md),
UI-слоты/панели, скиллы/agent-packs), фасад `@itphx/synth-plugin` + disposer-модель, bundle-only дистрибуция,
install/activate (`plugins.lock.json`/`plugins.json`), trust/scan по [AD-068](./ad-068-skills-agents-registry.md),
permissions ([AD-029](./ad-029-granular-permissions.md)), semver-политика и окно deprecation, а также режимы
(managed/hybrid). Ниже — только указатель; детали не дублируются.

### Плагины, add-on'ы и режимы (обновлено 2026-10-12)

Три класса расширений Synth (терминология жёсткая, [AD-090](./ad-090-extension-api.md)):

| Класс | Что запускается | Режимы |
|---|---|---|
| **Plugin** | Код **в процессе core** (загружается через Extension API, фасад `@itphx/synth-plugin`) | standalone — владелец/ADMIN; **managed** — установка ADMIN (deploy-time — дефолт, runtime-install — опция, по умолчанию `deny`); **hybrid** — allow-list сервера + server-scoped токены |
| **Add-on** | **Внешний сервис** со своим репозиторием/образами/деплоем (эталон — `synth-media`) | Любой режим; общается по API v2/MCP/событиям |
| **Declarative** | **Контент без кода** (скиллы, agent-packs, плагин-конфиги) | Любой режим |

**Ограничение «плагин только standalone» снято:** плагины разрешены во всех режимах. В **managed**
установку выполняет ADMIN (deploy-time по умолчанию; runtime-install — опция, по умолчанию `deny`). В **hybrid** —
allow-list сервера, усиленный **server-scoped токенами** (Уровень 2, проектируется сразу). Детали — [AD-090](./ad-090-extension-api.md).

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

Gateway к мессенджерам (поглощённый [AD-087](./ad-087-messenger-gateway-merged.md)) — эталонный add-on;
реализация живёт в **отдельном репозитории** `addons/synth-gateway-telegram` (вне `synth/`) и собрана по
общему шаблону `addons/synth-addon-template`:

- **MCP-сервер (Synth → шлюз):** отправка/редактирование сообщений, уведомления, inline-кнопки, вложения.
- **Вход (шлюз → Synth):** входящие сообщения/нажатия кнопок приходят как внешние события
  ([AD-089](./ad-089-external-events-automation.md): `Event`/`Binding`/`Router`); транспорт — Telegram
  `getUpdates` (**long-polling**), нормализация → `POST /api/v2/events`.
- **Выход (Synth → шлюз → чат):** SSE `GET /api/v2/events` (watcher) → `sendMessage` по `stream.done`
  (фоллбек `message.added`/`stream.error`).
- **Маппинг identity** (пользователь мессенджера → профиль/RBAC), **секреты ботов** (at-rest по модели
  [AD-076](./ad-076-git-repo-registry-ssh.md)), **дедуп/идемпотентность**, **вложения** (→ [AD-085](./ad-085-multimodal-input.md)).
- **Привязки `Binding`** (чат/тред/топик ↔ сессия/проект) и права — по [AD-089](./ad-089-external-events-automation.md).

##### Топология: один бот — один инстанс шлюза

Текущая (реализованная) топология — **один процесс на одного бота**:

- **Секреты/креды одного бота:** `TELEGRAM_BOT_TOKEN` (env или `secrets/telegram_bot_token`), **один владелец**
  (`secrets/telegram_owner_chat_id` — для MCP-уведомлений), **один** `SYNTH_URL` + одни креды Synth
  (OIDC client-credentials в managed приоритетнее статического `SYNTH_API_KEY` в standalone/dev).
- **Список доступа** `GATEWAY_ALLOWLIST` (`chatId:ROLE` либо `userId:ROLE`) — **мультичатовый**: один бот уже
  обслуживает несколько чатов/пользователей с разными ролями.
- **Состояние — JSON на PVC** (`FileStore`, AD-005): `state/offset.json` (смещение long-polling),
  `state/seen-updates.json` (дедуп апдейтов), `state/chat-sessions.json` (chatKey→сессия),
  `state/session-routes.json` (обратный индекс sessionId) и `state/sent.json` (дедуп отправки ответов).
- **Прокси обязателен** для Bot API (`TELEGRAM_PROXY_URL`, HTTP CONNECT / SOCKS5); OIDC-запросы идут напрямую
  и прокси не используют.
- **Деплой:** Helm-чарт `charts/synth-gateway-telegram` и `docker-compose.yml`; в K3s — дельта в репозитории
  `synth-deploy`.

##### Мультитенантность (направление развития, не реализовано)

Выбранное направление — **«один бот → несколько инстансов/тенантов Synth»**: внутри шлюза появляется
**таблица маршрутов** (напр. `chatKey`/`userId`/источник → `{ synthUrl, creds, tenant }`), и один бот
обслуживает разные контуры/тенанты, направляя события в соответствующий инстанс. Родственные темы:
[AD-055](./ad-055-instance-exchange.md) (обмен между инстансами, не реализован) и
[AD-081](./ad-081-hybrid-policy-leak-protection.md) (политики гибрида и защита от утечек).

**Пока не реализуем — фиксируем проект.** Принципиальное ограничение сохраняется: **один бот = один поллер**
(см. ниже), поэтому мультитенантность решается маршрутизацией внутри одного шлюза, а не запуском N шлюзов на
тот же токен.

##### Отказоустойчивость: HA через leader election (решение, не реализовано)

**Почему нельзя N поллеров.** Telegram `getUpdates` (long-polling) допускает **одного** потребителя на бота:
второй поллер получает **`409 Conflict`**. Значит, горизонтально масштабировать приём нельзя «в лоб».

**Решение** — 2+ реплики, из которых **поллит только лидер** (выборы через Kubernetes **Lease**); остальные —
**hot standby** с быстрым failover. Требования к реализации:

- **общий стейт** реплик (Redis/Postgres либо PVC `ReadWriteMany` вместо текущего `ReadWriteOnce`);
- **атомарный дедуп отправки** — сейчас `hasSent → markSent` в `sent.json` не атомарен между процессами;
- **лидер-гейт** для поллинга (lease + graceful stop/start).

**MCP-часть шлюза stateless** — масштабируется свободно, лидера не требует.

Альтернатива — **webhook-режим Telegram** (stateless HTTP за ingress): рассмотрена и **отложена**.

_Ориентир для реализации:_ в шедулере ядра ([AD-051](./ad-051-scheduler-pipelines.md)) уже есть семы
leader election и file-based реализации (default OFF, K8s Lease — будущее) — шлюз может повторить тот же подход.

##### Текущая гарантия — singleton

Сейчас корректность держится на **`replicaCount: 1`** (один поллер) и **`strategy: Recreate`**. В деплое
`synth-deploy` (K3s-дельта) `strategy: Recreate` задан.

**Известный пробел/риск:** в самом addon-чарте `charts/synth-gateway-telegram` **`strategy` не задан**
(в `templates/deployment.yaml` есть только `replicas: {{ .Values.replicaCount }}`, `revisionHistoryLimit: 2`
без блока `strategy`). При ручном увеличении `replicaCount > 1` без lease это даёт **`409 Conflict`** на
`getUpdates` и **двойную отправку** (неатомарный дедуп `sent.json`). До реализации HA чарт должен оставаться
`replicaCount: 1`.

##### Адаптеры каналов (отложенный путь универсальности)

Универсальность «платформа каналов» (общий интерфейс коннектора `send`/`receive`/`edit`/`attach` + ядро
платформы store/health/watcher/auth/allowlist/claim) с адаптерами каналов (Telegram первый → Max/VK/Slack/Matrix)
унаследована из [AD-087](./ad-087-messenger-gateway-merged.md). **Не выбранный сейчас путь** — фиксируется как
задел, не реализуется.

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

- **Extension API v1** (манифест `synth.plugin`, фасад `@itphx/synth-plugin` + disposer-модель, загрузчик,
  trust/scan, install/activate, `plugins.lock.json`/`plugins.json`) — **специфицирован в [AD-090](./ad-090-extension-api.md)
  и не реализован**.
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

- ~~**Декомпозиция:** один AD или несколько~~ — **закрыто:** Extension API v1 выделен в отдельный [AD-090](./ad-090-extension-api.md)
  (AD-086 остаётся зонтиком: плагины/editions/contribution/add-on'ы).
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
- ~~**Транспорт приёма и топология шлюза:** webhook vs long-polling; сколько инстансов на бота~~ —
  **закрыто (первый случай, Telegram):** транспорт — long-polling (`getUpdates`), топология — «один бот — один
  инстанс шлюза». Принципиальное ограничение: `getUpdates` допускает **одного** потребителя на бота
  (второй → `409 Conflict`), поэтому HA — только через leader election, а мультитенантность — маршрутизацией
  внутри одного шлюза (разделы выше).
- **Совместное использование стейта HA-шлюза:** Redis vs RWX-PVC vs Postgres — чем синхронизировать
  `offset`/`sent`/дедуп между репликами (зависит от [AD-032](./ad-032-history-storage-postgresql.md)); как
  сделать дедуп отправки атомарным между процессами.
- **Реализация HA:** K8s Lease для шлюза (лидер-гейт поллинга, hot standby, failover) и судьба `strategy`
  в addon-чарте (сейчас не задан — риск при случайном `replicaCount > 1`).

## Связи

- [AD-090](./ad-090-extension-api.md) — Extension API v1: манифест, загрузка, install/activate, trust/scan, режимы (спецификация плагинов; вынесена из AD-086).
- [AD-030](./ad-030-hooks-agent-events.md) — hooks/Plugin SDK: фундамент Extension API и событийных add-on'ов.
- [AD-038](./ad-038-npm-packages.md) — npm-пакеты: enabler editions и распространения плагинов.
- [AD-068](./ad-068-skills-agents-registry.md) — переиспользуемая инфраструктура trust/guard/каталога/провенанса.
- [AD-046](./ad-046-skills-and-slash-commands.md) — механизм скиллов; агент-паки и `skill-creator`.
- [AD-082](./ad-082-full-images-deployment.md) — flavor-образы как предтеча editions и образов add-on'ов.
- [AD-089](./ad-089-external-events-automation.md) — Event/Binding/Router: как add-on'ы (gateway) приносят события в Synth.
- [AD-087](./ad-087-messenger-gateway-merged.md) — поглощённый каталог «Gateway для мессенджеров» (указатель).
- [AD-042](./ad-042-hybrid-mode.md), [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) — гибрид и политики для сторонних расширений.
- [AD-055](./ad-055-instance-exchange.md) — обмен между инстансами: родственная тема мультитенантности шлюза (один бот → несколько инстансов/тенантов).
- [AD-032](./ad-032-history-storage-postgresql.md) — PostgreSQL: возможная опора общего стейта HA-шлюза (мультирепличный `offset`/дедуп).
- [AD-088](./ad-088-http-proxy.md) — egress внешних add-on сервисов.
- `synth-media` — существующий внешний сервис-демонстратор (прототип add-on'а).
