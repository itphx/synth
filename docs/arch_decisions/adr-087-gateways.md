# ADR-087: Шлюзы (gateways) — подключение внешних миров

> **Статус:** ⚠️ Частично — Telegram-шлюз реализован и **мультитенантен** («несколько ботов → несколько сред», `tenants.json`); **ядро шлюзов** `@itphx/synth-gateway-core` выделено ([ADR-103](./adr-103-gateway-core-channel-contract.md)); каналы: **Telegram** (реализован), **email** (реализован, `addons/synth-gateway-email`), **VK Messenger** (реализован: код готов и проверен тестами; ждёт публикации, деплоя и проверки на живом сообществе), **MAX Messenger** (Bot API исследован, реализация в очереди); остаток — HA через leader election
> **Дата:** 2026-10-01
> **Обновлено:** 2026-10-21 — решение по **общему каркасу адаптеров каналов** принято (§4 — путь выбран), второй канал — **VK Messenger** — реализован (код готов и проверен тестами; ждёт публикации, деплоя и проверки на живом сообществе); 2026-10-14 — **возрождён как действующий AD**: класс **Gateway** выделен в отдельный класс
> расширений (наряду с Plugin / Add-on / контент-паком, [ADR-086](./adr-086-extensibility-plugins-editions.md));
> весь материал Telegram-шлюза перенесён сюда из [ADR-086](./adr-086-extensibility-plugins-editions.md)
> (там дубликатов больше нет).
> **Связано:** [ADR-086](./adr-086-extensibility-plugins-editions.md) (зонтик «Классы расширений»),
> [PROP-090](./prop-090-extension-api.md) (Plugin / классы расширений), [ADR-089](./adr-089-external-events-automation.md)
> (Event/Binding/Router, identity/claim-flow), [ADR-030](./adr-030-hooks-agent-events.md) (hooks),
> [ADR-052](./adr-052-public-api-platform.md) (service-key/scopes/webhooks), [ADR-076](./adr-076-git-repo-registry-ssh.md)
> (секреты at-rest), [PROP-085](./prop-085-multimodal-input.md) (вложения), [ADR-051](./adr-051-scheduler-pipelines.md)
> (ориентир HA — leader election), [PROP-088](./prop-088-http-proxy.md) (egress/прокси).

## 1. Решение

Ввести **класс «Gateway»** — отдельный класс расширений Synth, наряду с Plugin / Add-on / контент-паком /
Edition ([ADR-086](./adr-086-extensibility-plugins-editions.md), [PROP-090](./prop-090-extension-api.md)).

**Gateway** — внешний сервис-транспорт, который подключает Synth к **внешнему миру** (мессенджеры, чаты,
каналы, боты, внешние платформы) и обеспечивает **двусторонний** обмен:

- **вход** — входящие сообщения/нажатия/события внешнего мира → Synth (внешние события, [ADR-089](./adr-089-external-events-automation.md));
- **выход** — ответы/уведомления Synth → внешний мир.

Gateway — **не** подвид Add-on'а и **не** Plugin: это самостоятельный класс со своим контрактом, адресацией,
идентичностью, топологией, персистентностью и жизненным циклом. Реализованные подтипы — **мессенджеры**
(Telegram — реализован; VK — реализован; MAX — в очереди); см. §4.

Манифест любого расширения, включая gateway, — единый файл **`synth.pack`** (`kind: "gateway"`,
[ADR-086](./adr-086-extensibility-plugins-editions.md), [PROP-090](./prop-090-extension-api.md)).

## 2. Отличия класса Gateway от Add-on/Plugin/контент-пака

| Аспект | **Gateway** | Add-on | Plugin | Контент-пак |
|---|---|---|---|---|
| **Направление** | **двусторонний транспорт** внешний мир ↔ Synth и обратно | вызываемый/подключаемый внешний сервис иного назначения (потребляет API Synth) | код **в процессе ядра** | данные, без кода |
| **Адресация** | канал/чат/тред ↔ сессия (**Binding**) | вызовы API/MCP/события | регистрации в реестрах ядра | scope установки (instance/project) |
| **Идентичность** | внешний отправитель → профиль/RBAC + **claim-flow**; роли только **сужаются** ([ADR-089](./adr-089-external-events-automation.md)) | по service-key/ролям вызова | по permission-слою ядра | — |
| **Топология** | **один поллер на бота** → второй получает `409 Conflict`; HA только через **leader election** | свободная (stateless/реплики) | в процессе core | — |
| **Персистентность** | сессии/чаты/routes/**дедуп отправки** — своё состояние сервиса | своя БД/состояние сервиса | через `FileStore` | контент в каталоге |
| **Секреты** | **per-bot** токены + владелец бота (at-rest, [ADR-076](./adr-076-git-repo-registry-ssh.md)) | креды интеграции | выдаются API ядра | — |
| **Репозиторий/деплой** | **свой репозиторий**, образы, Helm/compose и жизненный цикл | свой репозиторий/образы | в поставке/каталоге плагинов | каталог контента |

Ключевой критерий выбора класса: **по умолчанию — Gateway/Add-on (внешний сервис); Plugin — только когда
изменение обязано быть in-process** (синхронная трансформация потока, внутренние реестры, производительность).

## 3. Состав контракта шлюза

- **Приём (внешний мир → Synth).** Нормализация входящих сообщений/нажатий в **внешние события** →
  `POST /api/v2/events` ([ADR-089](./adr-089-external-events-automation.md): `Event`/`Binding`/`Router`).
- **Доставка наружу (Synth → внешний мир).** SSE-`watcher` на `GET /api/v2/events` → `sendMessage` по
  `stream.done` (фоллбек `message.added`/`stream.error`).
- **MCP-часть (Synth → шлюз).** MCP-инструменты шлюза: отправка/редактирование сообщений, уведомления,
  inline-кнопки, вложения.
- **Binding чат↔сессия.** Привязка `chatKey`/`threadKey` ↔ сессия/проект; режимы `bound`/`ephemeral`/`queue`
  ([ADR-089](./adr-089-external-events-automation.md)).
- **Идентичность.** Маппинг внешнего отправителя → профиль/RBAC + **claim-flow** (одноразовый код подтверждения);
  роли внешнего отправителя только **сужают** роли профиля (fail-closed для несопознанных).
- **Allowlist.** Список доступа (`chatId:ROLE` / `userId:ROLE`) — только сужение прав.
- **Вложения.** Медиа из чатов → контракт вложений ([PROP-085](./prop-085-multimodal-input.md)).
- **Дедуп/идемпотентность.** Дедуп входящих апдейтов и **дедуп отправки** ответов.
- **Прокси/egress.** Bot API требует прокси (HTTP CONNECT / SOCKS5); OIDC-запросы идут напрямую;
  общий egress-слой — [PROP-088](./prop-088-http-proxy.md).
- **Секреты at-rest.** Токены ботов и SSH/иные секреты — по модели [ADR-076](./adr-076-git-repo-registry-ssh.md).

## 4. Первый подтип — мессенджеры (Telegram)

Gateway к мессенджерам — эталонный шлюз; реализация живёт в **отдельном репозитории**
`addons/synth-gateway-telegram` (вне `synth/`) и собрана по общему шаблону `addons/synth-addon-template`
(общий скелет внешних сервисов, [ADR-086](./adr-086-extensibility-plugins-editions.md)):

- **MCP-сервер (Synth → шлюз):** отправка/редактирование сообщений, уведомления, inline-кнопки, вложения.
- **Вход (шлюз → Synth):** входящие сообщения/нажатия кнопок приходят как внешние события
  ([ADR-089](./adr-089-external-events-automation.md): `Event`/`Binding`/`Router`); транспорт — Telegram
  `getUpdates` (**long-polling**), нормализация → `POST /api/v2/events`.
- **Выход (Synth → шлюз → чат):** SSE `GET /api/v2/events` (watcher) → `sendMessage` по `stream.done`
  (фоллбек `message.added`/`stream.error`).
- **Маппинг identity** (пользователь мессенджера → профиль/RBAC), **секреты ботов** (at-rest по модели
  [ADR-076](./adr-076-git-repo-registry-ssh.md)), **дедуп/идемпотентность**, **вложения** (→ [PROP-085](./prop-085-multimodal-input.md)).
- **Привязки `Binding`** (чат/тред/топик ↔ сессия/проект) и права — по [ADR-089](./adr-089-external-events-automation.md).

Telegram — **первая** реализация этого подтипа (эталон). Второй канал — **VK Messenger** (решения — см.
«Решения по VK-каналу» ниже), третий — **MAX Messenger** (Bot API исследован, реализация в очереди).

### Топология: один бот — один инстанс шлюза

Текущая (реализованная) топология — **один процесс на одного бота**:

- **Секреты/креды одного бота:** `TELEGRAM_BOT_TOKEN` (env или `secrets/telegram_bot_token`), **один владелец**
  (`secrets/telegram_owner_chat_id` — для MCP-уведомлений), **один** `SYNTH_URL` + одни креды Synth
  (OIDC client-credentials в managed приоритетнее статического `SYNTH_API_KEY` в standalone/dev).
- **Список доступа** `GATEWAY_ALLOWLIST` (`chatId:ROLE` либо `userId:ROLE`) — **мультичатовый**: один бот уже
  обслуживает несколько чатов/пользователей с разными ролями.
- **Состояние — JSON на PVC** (`FileStore`, ADR-005): `state/offset.json` (смещение long-polling),
  `state/seen-updates.json` (дедуп апдейтов), `state/chat-sessions.json` (chatKey→сессия),
  `state/session-routes.json` (обратный индекс sessionId) и `state/sent.json` (дедуп отправки ответов).
- **Прокси обязателен** для Bot API (`TELEGRAM_PROXY_URL`, HTTP CONNECT / SOCKS5); OIDC-запросы идут напрямую
  и прокси не используют.
- **Деплой:** Helm-чарт `charts/synth-gateway-telegram` и `docker-compose.yml`; в K3s — дельта в репозитории
  `synth-deploy`.

### Мультитенантность (реализовано: «несколько ботов → несколько сред»)

**Реализовано (2026-10-13).** Один процесс шлюза обслуживает **N ботов**, каждый бот привязан к своей среде
Synth. Конфигурация — файл `tenants.json` (`--tenants-file` > env `GATEWAY_TENANTS_FILE` > `secrets/tenants.json`):
на тенанта `{ id, botToken, synthUrl, serviceKey|apiKey|oidc, allowlist?, proxyUrl?, parseMode?, … }`. Рантайм
фан-аутится: на тенанта — свой `TelegramClient`/`AuthTokenProvider`/`SynthEventsClient`/`GatewayStore`/`Poller`/
`AgentWatcher`; состояние изолировано каталогом (`data/tenants/<id>/…`; legacy `default` — корень, без миграции);
`GET /health` отдаёт агрегат + разбивку по тенантам. Топология «**один бот = один поллер**» сохраняется (у каждого
тенанта свой токен), поэтому `getUpdates`-конфликта (`409`) нет. Обратная совместимость: без файла — один тенант
`default` из env/CLI. MCP-часть остаётся однотенантной.

**Альтернатива (не выбрана):** **«один бот → несколько инстансов/тенантов»** через таблицу маршрутов
(`chatKey`/`userId`/источник → `{ synthUrl, creds, tenant }`) — один бот обслуживает разные контуры. Родственные
темы: [PROP-055](./prop-055-instance-exchange.md) (обмен между инстансами) и [PROP-081](./prop-081-hybrid-policy-leak-protection.md).

### Отказоустойчивость: HA через leader election (решение, не реализовано)

**Почему нельзя N поллеров.** Telegram `getUpdates` (long-polling) допускает **одного** потребителя на бота:
второй поллер получает **`409 Conflict`**. Значит, горизонтально масштабировать приём нельзя «в лоб».

**Решение** — 2+ реплики, из которых **поллит только лидер** (выборы через Kubernetes **Lease**); остальные —
**hot standby** с быстрым failover. Требования к реализации:

- **общий стейт** реплик (Redis/Postgres либо PVC `ReadWriteMany` вместо текущего `ReadWriteOnce`);
- **атомарный дедуп отправки** — сейчас `hasSent → markSent` в `sent.json` не атомарен между процессами;
- **лидер-гейт** для поллинга (lease + graceful stop/start).

**MCP-часть шлюза stateless** — масштабируется свободно, лидера не требует.

Альтернатива — **webhook-режим Telegram** (stateless HTTP за ingress): рассмотрена и **отложена**.

_Ориентир для реализации:_ в шедулере ядра ([ADR-051](./adr-051-scheduler-pipelines.md)) уже есть семы
leader election и file-based реализации (default OFF, K8s Lease — будущее) — шлюз может повторить тот же подход.

### Текущая гарантия — singleton

Сейчас корректность держится на **`replicaCount: 1`** (один поллер) и **`strategy: Recreate`**. В деплое
`synth-deploy` (K3s-дельта) `strategy: Recreate` задан.

**Известный пробел/риск:** в самом чарте шлюза `charts/synth-gateway-telegram` **`strategy` не задан**
(в `templates/deployment.yaml` есть только `replicas: {{ .Values.replicaCount }}`, `revisionHistoryLimit: 2`
без блока `strategy`). При ручном увеличении `replicaCount > 1` без lease это даёт **`409 Conflict`** на
`getUpdates` и **двойную отправку** (неатомарный дедуп `sent.json`). До реализации HA чарт должен оставаться
`replicaCount: 1`.

### Адаптеры каналов (общий каркас — путь выбран)

Универсальность «платформа каналов» — **выбранный путь** (решение владельца, 2026-10-21). Реализуется как
**общий каркас шлюза** (отдельный пакет) + **адаптеры каналов**:

- **общий каркас** — ядро шлюза, не зависящее от конкретного мессенджера: `store`/`health`/`watcher`/`auth`/
  `allowlist`/`claim` + общая логика приёма, дедупа, доставки наружу и MCP-части;
- **абстракция канала** — единый интерфейс операций канала: `send`/`edit`/`delete`/`actions`/`subscribe`;
- **адаптеры каналов** — реализации абстракции под конкретную платформу.

Порядок: первая реализация — **Telegram** (`addons/synth-gateway-telegram`), второй
канал — **VK Messenger**, третий — **MAX Messenger**; далее Slack/Matrix (пересмотр при третьем канале).
Telegram на общий каркас **ещё не мигрирован** (реализован на собственном коде) — миграция отдельная
задача; **VK — на общем каркасе с первого дня** (`@itphx/synth-gateway-core`,
[ADR-103](./adr-103-gateway-core-channel-contract.md)).
**email** (почта: IMAP/SMTP) — `addons/synth-gateway-email`, реализован (решения — см. «Решения по email-каналу» ниже).

**Общий каркас реализован** — пакет `@itphx/synth-gateway-core`
(`addons/synth-gateway-core`); контракт канала и границы «ядро ↔ канал» зафиксированы в
[ADR-103](./adr-103-gateway-core-channel-contract.md) и в `docs/contract.md` пакета. Интерфейс операций
(`send`/`edit`/`delete`/`actions`/`subscribe`) реализован в ядре: `subscribe` — как `start(ctx)`/`stop()`,
остальные — как опциональные операции `ChannelAdapter` (`edit`/`delete`/`actions`), плюс `markRead`
(аналог IMAP `\Seen`). Поддержка объявляется флагами `ChannelCapabilities` — канал без правок (почта)
реализует только `send`.

### Решения по VK-каналу (второй канал)

- **Транспорт по умолчанию — Bots Long Poll** (`groups.getLongPollServer` + `act=a_check`); **Callback API**
  (webhook) — **альтернативный режим первого релиза**.
- **Токен — community-токен на сообщество** (тенант = сообщество); мультитенантность — через `tenants.json`,
  как у Telegram.
- **Идентичность:** `principalId = vk:<user_id>`, `chatKey = chat:vk:<group_id>:<peer_id>` (сообщество входит
  в `chatKey`); `source` остаётся `vk`. Тредов у VK нет → `threadKey` не используется.
- **Форматирование:** `parse_mode` **нет** — ограниченный HTML (`b`/`i`/`u`/`a`), лимит **9000** символов ⇒
  **свой конвертер** разметки (не переиспользуемый TG-конвертер).
- **Ответ в беседе:** `forward{conversation_message_ids:[1], is_reply:1}` (аналога `reply_parameters` нет).
- **Ядро Synth префикс `tg:` не хардкодит** — `parsePrincipalId` режет по первому `':'`
  (`packages/shared/src/types/user.ts`), `EventIngestInput.source: string` ⇒ VK-идентификаторы работают
  **без правок ядра**.

### Фактическая реализация VK-канала

**Реализовано (2026-10-21).** Репозиторий — `addons/synth-gateway-vk`, общий каркас — `@itphx/synth-gateway-core`
([ADR-103](./adr-103-gateway-core-channel-contract.md)); **ядро в npm ещё не опубликовано** — CI/релиз шлюза
берут его отдельным checkout'ом (без публикации ядра релиз шлюза не пройдёт).

- **Транспорт:** **Bots Long Poll** по умолчанию (`groups.getLongPollServer` →
  `act=a_check&key&ts&wait=25`); курсор `ts` — **строка**, двигается **после** публикации пачки (при падении
  публикации курсор прежний — пачка придёт заново); `failed:1/2/3` → пересоздание сервера long poll, при
  `failed:3` — **явная потеря событий**. **Callback API** (webhook) — альтернативный режим: сверка поля
  `secret`, ответ ровно `ok`, код подтверждения, ретраи VK 10 с → 3 мин → 10 мин → 30 мин → 1 ч.
- **Идентичность:** `principalId = vk:<user_id>`, `chatKey = chat:vk:<group_id>:<peer_id>`; составной
  `inboundMessageId` — `<peer_id>:<message_id>[:<conversation_message_id>]`, потому что `message.id` у VK
  уникален только в пределах диалога.
- **Дедуп — в ядре**, по `dedupKey` = `vk:<group_id>:<peer_id>:<type>:<message_id>:<date>`; канал своего дедупа
  не ведёт.
- **Возможности канала:** `streaming`/`editing`/`drafts`/`threads`/`attachments`/`deleting`/`actions` —
  **все `false`** (у VK нет подтверждённых методов правки/удаления сообщений сообщества, стриминга частями и
  «печатает…»); `markRead` реализован отдельно (`messages.markAsRead`).
- **Соблюдение правил VK:** §7.1 — в беседу **только ответом** (`forward.is_reply = 1`) и не чаще **100
  сообщений на диалог за 15 минут**; §8 — `content_source` **не проставляется** (шлюз не пересылает
  пользовательский контент); массовая рассылка не поддержана.
- **Ограничения платформы:** лимит текста **9000** символов, **20 req/s**, квота **10 000 вызовов API в
  месяц** без верификации бизнес-профиля (после верификации — 100 млн).
- **Порты:** 7120 (health) / 7121 (MCP) / 7122 (приёмник Callback API).

### Решения по email-каналу (почта)

- **Транспорт:** IMAP для приёма (`imapflow`), SMTP для отправки (`nodemailer`); сервер
  `imap.itphx.ru:993` / `smtp.itphx.ru:25` (STARTTLS; порт 587 не отвечает).
- **Опрос, а не IDLE.** Сервер `IDLE` поддерживает, но шлюз сознательно работает по
  расписанию (`EMAIL_POLL_INTERVAL_MS`, по умолчанию 15 с): push требует keepalive и
  усложняет восстановление курсора, а восстановление после обрыва делается через
  `UID SEARCH UID <lastUid+1>:*`. `QRESYNC`/`UIDPLUS` сервер объявляет, но шлюз на них
  не опирается — кандидат на оптимизацию.
- **Курсор:** `(UIDVALIDITY, UID, lastSeenAt)`. Смена `UIDVALIDITY` ⇒ сервер пересоздал
  ящик, прежние UID недействительны ⇒ курсор сбрасывается, старые письма не
  обрабатываются (фильтр по `lastSeenAt`).
- **Идентичность:** `principalId = email:<нормализованный адрес>`, `source = 'email'`.
  `chatKey` — **переписка с собеседником** (`chat:email:<tenant>:<peer>`), `threadKey` —
  **тред письма** по RFC 5322 (`thread:email:<tenant>:<rootMessageId>`); корень треда
  восстанавливается персистентным индексом `messageId → threadRoot` (Outlook обрезает
  `References` до непосредственного родителя).
- **Дедуп — по `Message-ID`** (`email:<tenant>:<messageId>`), а не по UID: Message-ID
  переживает смену `UIDVALIDITY`. Без Message-ID — `email:<tenant>:<uidValidity>:<uid>`.
- **Адресат ответа** — `Reply-To` исходного письма, иначе `From`. **Конверт SMTP всегда
  явный** и содержит только адресата ответа — иначе nodemailer собрал бы конверт из
  `to`/`cc`/`bcc` (риск **reply-all** третьим лицам).
- **Режим отправки** — `sendMode`: `draft` (по умолчанию — ответ кладётся в черновики,
  человек отправляет сам; «человек в контуре»), `auto`, `off`. Значение вне списка —
  **ошибка fail-fast**, а не молчаливый дефолт.
- **Защита от почтового цикла.** Ответ агента уходит в тот же ящик ⇒ письма с
  собственным адресом в `From` **пропускаются** (`processOwnMessages`, по умолчанию
  выключен). Без этого шлюз отвечает на собственные ответы — бесконечный цикл
  «письмо → ответ → письмо» (жжёт токены, засоряет ящик). Проверено на живом сервере.
- **Автоответы и боуты** (`Auto-Submitted`, `Precedence: bulk`, …) **не публикуются** —
  иначе агент отвечает на автоответ и получает «блуп» от MTA.
- **Вложения** — только метаданные (PROP-085 не реализован), как в Telegram-шлюзе.

## 5. Что унаследовано из прежнего ADR-087

Тема «Gateway для подключения к мессенджерам» возрождена как действующий ADR-087 (класс Gateway); прежний
tombstone-файл удалён. Наследование относительно исходного gateway-черновика:

| Из gateway-черновика | Куда перешло |
|---|---|
| Адаптеры-коннекторы с общим интерфейсом (`send`/`receive`/`edit`/`attach`) | сам [ADR-087](./adr-087-gateways.md), §4 «Адаптеры каналов» (путь выбран: общий каркас + адаптеры каналов) |
| Binding «чат/тред ↔ сессия/проект» | [ADR-089](./adr-089-external-events-automation.md) — сущность `Binding` (режимы `bound`/`ephemeral`/`queue`) |
| Транспорт webhook и/или long-polling | [ADR-087](./adr-087-gateways.md) §4 (long-polling; webhook отложен) + [ADR-089](./adr-089-external-events-automation.md) (приём событий) |
| Маппинг идентичности (пользователь мессенджера → профиль/RBAC) | [ADR-089](./adr-089-external-events-automation.md) — поле `identity` у `Event` + claim-flow |
| Дедуп / идемпотентность | [ADR-089](./adr-089-external-events-automation.md) — `dedupKey` (+ дедуп отправки в шлюзе) |
| Вложения | [PROP-085](./prop-085-multimodal-input.md) — контракт вложений (по ссылке из `Event`) |
| Секреты ботов at-rest | [ADR-076](./adr-076-git-repo-registry-ssh.md) — мастер-ключ |

## 6. Открытые вопросы

- **Совместное использование стейта HA-шлюза:** Redis vs RWX-PVC vs Postgres — чем синхронизировать
  `offset`/`sent`/дедуп между репликами (зависит от [PROP-032](./prop-032-history-storage-postgresql.md)); как
  сделать дедуп отправки атомарным между процессами.
- **Реализация HA:** K8s Lease для шлюза (лидер-гейт поллинга, hot standby, failover).
- **Судьба `strategy`** в чарте шлюза `synth-gateway-telegram` (сейчас не задан — риск при случайном
  `replicaCount > 1`); фиксировать `Recreate` в чарте или защищать через lease.
- **Webhook-транспорт Telegram** (stateless HTTP за ingress) — рассмотрен и отложен; условия возврата.
- **Второй канал и общий интерфейс адаптеров каналов** — общий интерфейс адаптеров **выбран** (реализуется
  общий каркас `synth-gateway-core`); **VK** — второй канал (реализован: код готов и проверен тестами;
  транспорт — Bots Long Poll + Callback API), **MAX** — третий; **Slack/Matrix** — в очереди, пересмотр при
  третьем канале.
- **Остаток по VK-каналу:** **проверка на живом сообществе** — набор HTML-тегов VK, «окно последних N
  сообщений» для ответа в беседе, лимит payload кнопки, приход `message_new` в ЛС без `message_allow`,
  фактический расход вызовов API; **публикация ядра в npm** (`@itphx/synth-gateway-core`) — без неё релиз
  шлюза не пройдёт.

## 7. Связи

- [ADR-086](./adr-086-extensibility-plugins-editions.md) — зонтик «Классы расширений»: Gateway наряду с Plugin/Add-on/контент-паком, editions и contribution flow.
- [PROP-090](./prop-090-extension-api.md) — Extension API v1: терминология классов, единый манифест `synth.pack`.
- [ADR-089](./adr-089-external-events-automation.md) — Event/Binding/Router, identity/claim-flow: как события мессенджера превращаются в работу сессии.
- [ADR-030](./adr-030-hooks-agent-events.md) — hook-шина: фундамент событийной обработки (hook `message_received`).
- [ADR-052](./adr-052-public-api-platform.md) — публичный API, service-key/scopes, приём webhook'ов.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) — хранение секретов ботов at-rest.
- [PROP-085](./prop-085-multimodal-input.md) — вложения из чатов.
- [ADR-051](./adr-051-scheduler-pipelines.md) — ориентир для HA: семы leader election и file-based реализации.
- [PROP-088](./prop-088-http-proxy.md) — egress/прокси: Bot API требует прокси.
- [PROP-055](./prop-055-instance-exchange.md) — родственная тема мультитенантности (один бот → несколько инстансов/тенантов).
- [PROP-081](./prop-081-hybrid-policy-leak-protection.md) — политики/утечки для мультитенантного размещения.
