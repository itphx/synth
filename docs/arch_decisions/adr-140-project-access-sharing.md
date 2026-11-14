# ADR-140: Доступ к проекту — участники, группы и видимость

> **Статус:** ✅ Реализовано (Ф1 — пользовательские гранты, единый резолвер, API/DTO/каталог/аудит, UI; Ф2 — источник групп: claim IdP → снимок в принципале хода, каталог групп, UI-мультиселект групп; Ф3 — передача владения `POST /api/v2/projects/:id/transfer` и политика переносов).
> **Дата:** 2026-11-14
> **Источник:** PROP-133 (реализованы Ф1–Ф3; файл удалён после принятия).
> **Связано:** [ADR-014](./adr-014-project-container.md), [ADR-089](./adr-089-external-events-automation.md), [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md), [ADR-106](./adr-106-authority-layer.md), [ADR-118](./adr-118-message-stream-v2.md).

## Контекст

«Кто видит проект» был размазан по шести независимым копиям предиката (backend RBAC,
видимость сессий, тулы агента, файловый store, PostgreSQL, UI-зеркало) — и копии уже
расходились в деталях. Поле `members: Record<userId, ProjectRole>` существовало в
контракте, но **write-path у него не было**: заполнялось только владельцем при создании,
`PUT /projects/:id` его не принимал, в UI был лишь счётчик. Групп пользователей в продукте
не было: claim `groups` из IdP не разбирался, `teamRoles` — самоправный ярлык профиля, для
ACL не годится.

## Решение

1. **Одна ось доступа.** Хранится не enum «видимость», а **состояние списка доступа**:
   `members` (пользователи) + `groupMembers` (группы) + `everyoneRole` (`null` — проект не
   опубликован). Видимость `author`/`selected`/`all` — **производная** величина
   (`deriveProjectVisibility`), не хранится и в запросе не пишется.
2. **Единый резолвер** `resolveProjectAccess` (`@itphx/synth-shared`, browser-safe) — порядок
   (первое совпадение выигрывает): владелец → `ADMIN`/`LEAD` → `members[userId]` → максимальная
   роль по группам (`owner` > `editor` > `viewer`) → `everyoneRole` → доступа нет (`read: false`).
   Неизвестная роль в данных (битая запись, легаси) — **fail-closed** в `viewer`. На резолвер переведены
   все прежние копии предиката; новый `:id`-маршрут берёт роль из резолвера на границе
   (инвариант 16), а не заводит свою проверку.

## Правила

- **Видимость даёт только чтение.** Запись — `owner`/`editor`; потолок хода — существующий
  механизм [ADR-106](./adr-106-authority-layer.md) Ф4 (`viewer` — read-only, ход не запускается).
  Read-уровень доступа не расширяет права на изменение (инвариант 21).
- **Менять доступ** (`members`/`group_members`/`everyone_role`) может только `canManage`:
  автор проекта, участник с ролью `owner`, `LEAD`, `ADMIN`. `EDITOR`/`viewer` — нет.
- **`ADMIN`/`LEAD` — сквозной обзор** при любом состоянии доступа, включая `author`.
- **Автор всегда дописывается в `members` как `owner`** при любой записи состояния доступа;
  понизить роль автора нельзя (передача владения — отдельная операция `POST /:id/transfer`, Ф3).

## Область

Видимость открывает **всё** содержимое проекта, включая сессии и их историю: описание,
workspace/FS, git, план, журнал, инварианты, память, пайплайны. Частичной видимости нет.
Запись в чужую сессию определяется ролью (`viewer` — read-only, `editor`/`owner` — обычный ход).

## Хранение

- **file/memory** — `groupMembers`/`everyoneRole` как опциональные поля `Project`, читаются с
  дефолтами; состояние вычисляется как `author` ⇒ поведение существующих проектов не меняется.
- **PostgreSQL** — миграция `035_project_access` (`group_members jsonb NOT NULL DEFAULT '{}'`,
  `everyone_role text`): только `ADD COLUMN`, идемпотентно.
- **Паритет бэкендов:** «нет грантов» — **поле отсутствует** (`undefined`), а не пустая карта и не
  `null`; `ProjectRepository.list(viewer)` фильтрует список проектов тем же резолвером.

## API

- `POST /api/v2/projects` и `PUT /api/v2/projects/:id` принимают `members`/`group_members`/
  `everyone_role` — **полная замена** набора (не слияние). `everyone_role: null` — снять
  публикацию; `everyone_role: 'owner'` → `400`; понижение роли автора → `400`; `visibility` в
  теле → `400` (величина производная); неизвестная роль → `400`; `EDITOR`/`viewer` →
  `403 FORBIDDEN`.
- **DTO** проекта несёт `group_members`/`everyone_role` и производное `visibility`
  (`author`/`selected`/`all`, только чтение).
- **Каталог пользователей** — `GET /api/v2/users/directory`: лёгкая проекция
  `{id, username, display_name}`, постранично (ADR-118 §4), доступ **любому аутентифицированному**
  (иначе владелец не может выбрать участников).
- **Каталог групп** — `GET /api/v2/users/groups`: имена групп из allowlist'а
  `auth.oidc.groups.allow`, постранично, фильтр `?q=`; доступ **любому аутентифицированному**
  (Ф2).
- **Аудит** изменений доступа — `scope:'projects'` (кто, что, было/стало), журнал
  `GET /api/v2/audit/security?scope=projects` (`ADMIN`/`AUDITOR`); запись best-effort — её
  ошибка не ломает мутацию.
- **Передача владения** — `POST /api/v2/projects/:id/transfer`, тело `{user_id}` (строгая
  схема): право — текущий владелец или `ADMIN`; новый владелец — `owner` в `members`,
  прежний — `editor` (Ф3).
- **Пространство имён id.** ACL (`owner_id`, `members`) живёт в пространстве **`User.id`**
  (OIDC `sub`; в debug — имя пользователя), а `ProfileData.id` — UUID профиля: это разные
  пространства. Поэтому **id в каталоге `GET /api/v2/users/directory` = ACL-id**:
  привязанная identity `provider: 'auth'` (`externalId` = `User.id`) либо `profile.id` для
  legacy-профилей без привязки; привязка создаётся автоматически при логине (идемпотентно,
  best-effort — конфликт пары в лог, вход не ломается), до первого логина у старого профиля
  остаётся `profile.id`. `POST /api/v2/projects/:id/transfer` ищет получателя **по ACL-id**
  (сначала identity `auth`, затем `profile.id`); `GET /api/v2/users` (админский список) не
  меняется — там по-прежнему `profile.id`.
- **Событие** `project.updated` публикуется в каналы сессий проекта (инвариант 27).

## Сессии и подписки

Видимость сессии = видимость проекта: сессии всех проектов, где у пользователя есть роль, видны
и в списке сессий, и в **подписках WS/SSE**. Оба места считают один и тот же список через общий
шов `packages/backend/src/events/visible-session-ids.ts` (`resolveVisibleProjectIds`/
`listVisibleSessions`) ⇒ видимость сессий и проектов не расходится.

## Статус реализации (Ф1)

- **Контракт и хранилища** — `Project.groupMembers`/`Project.everyoneRole`,
  `deriveProjectVisibility`, схемы `projectAccessRoleSchema`/`projectEveryoneRoleSchema`/
  `projectMembersSchema`; `ProjectRepository.list(viewer)` в file/memory/PG; миграция
  `035-project-access.ts`.
- **Предикат на всех контурах** — резолвер в `@itphx/synth-shared`; свои копии предиката в
  core/backend/UI/storage убраны.
- **API/DTO/каталог/аудит** — запись состояния доступа, DTO, `GET /api/v2/users/directory`,
  аудит `scope:'projects'`, `project.updated`.
- **UI** — блок «Доступ» в панели проекта и при создании (три проекции, мультиселект с ролями,
  тумблер «разрешить редактирование»), бейдж режима в списке, зеркало предиката в
  `lib/projectAccess.ts`, i18n `project.access.*` (RU/EN).
- **Коммиты:** `c77cb09d` (контракт + хранилища), `85afc26d` (предикат + API + аудит),
  `909ef875` (UI), `25045802` (документация + AGENTS.md).
- **Тесты:** `projects-access-matrix` 16/16 (author/selected/all × viewer/editor/EDITOR/ADMIN/
  LEAD/чужой, группы), `sessions-access-projects` 8/8 (чтение да, запись 403),
  `session-idor-matrix` 82/82 (+ мир shared-проекта), `session-visibility` 18/18, `hub` 16/16,
  `route-access-census` 11/11; контракт портов на живой PostgreSQL — **262/262**.

## Статус реализации (Ф2)

- **Конфиг.** `auth.oidc.groups { claim?, allow[] }` (`shared/config/types.ts`), env
  `SYNTH_OIDC_GROUPS_CLAIM` / `SYNTH_OIDC_GROUPS_ALLOW` (csv) перекрывают конфиг (ADR-023).
  Пустой allowlist — **групп нет** (fail-closed): «принять все» невозможно.
- **Разбор claim.** `backend/src/auth/oidc.ts` `extractGroups`: claim **верхнего уровня**,
  значения — строки, trim + дедуп, фильтр по allowlist **регистрозависимо**; fallback
  `id_token → access_token` (`extractUserFromTokens`); нет claim / не массив → `[]`.
- **Контракт пользователя.** `User.groups?: string[]` (`shared/types/user.ts`) — **снимок на момент
  логина**, пассивный: на права влияет только `resolveProjectAccess`. В ответах
  `/auth/status|session|me` поле есть **только при непустом списке** (аддитивно — старый клиент
  не ломается); `PUT /auth/profile` группы **не принимает** — снимок меняется повторным входом.
- **Гибрид.** `RemoteUser.groups` (`core/remote/types.ts`) → cookie v2 (`core/auth/local.ts`
  `serverUserToUser`) → `User.groups`; refresh токена снимок **сохраняет** (группы живут до
  повторного входа — так и задумано).
- **Ядро.** `AuthorityPrincipal.groups?` (`shared/types/authority.ts`) — аддитивно и необязательно:
  старое сохранённое сообщение парсится, отсутствие поля = «групп нет», потребители нормализуют
  `?? []`. `resolveUserPrincipal(id, roles, groups)`; группы фиксируются **при постановке сообщения
  в очередь** (`createSessionRoutes` → опция `resolveUserGroups`; backend — `groupsOf(user)`;
  standalone — опция не задана ⇒ групп нет). `_resolveToolPrincipal` берёт группы **принципала
  хода**; `createAuthorityTurnContext({groups})` — потолок хода по групповому гранту;
  `canEditProject(session, project, groups?)` — грант по группе даёт роль, индивидуальный грант
  **приоритетнее** группового.
- **Каталог групп.** `GET /api/v2/users/groups` (backend, `routes/users.ts`): источник — allowlist
  `auth.oidc.groups.allow`, постранично, фильтр `?q=`, доступ **любому аутентифицированному**;
  маршрут объявлен **до** `/:id`.
- **Синхронизация доступа.** Изменение доступа публикует `project.updated { kind:'access' }`;
  `EventHub.resyncAllClients()` пересчитывает подписки WS/SSE (новый участник получает события
  проекта, отозванный — перестаёт); UI на `kind:'access'` перечитывает **списки** проектов и сессий.
- **UI.** `useGroupsCatalog` / `getGroupsDirectory` (`GET /api/v2/users/groups`); блок групп в
  `ProjectTab` и `CreateProjectPopover` (`group_members` в теле); **мерж грантов вне каталога** —
  грант группе, которой нет в allowlist, не теряется; бейдж режима — **по составу** (только группы /
  группы и пользователи / пользователи); `User.groups` в зеркале `resolveProjectRole`.
- **Тесты.** shared `types/authority` +7; core `engine/authority/principal` 9 (новый файл),
  `engine/authority/turn` 12 (из них 5 — блок Ф2), `engine/tools/project-access` +8 (блок Ф2),
  `server/routes/sessions` +3 (группы в очереди); backend `routes/projects-access-matrix` +4 (20
  всего), `routes/users-groups` 7, `routes/auth` +5, `lib/app-config` +8, `events/hub` +2,
  `routes/projects` +2, `routes/projects-access` +1; core `auth/local` +3, `remote/session` +5,
  `server/routes/auth` +2. Полный прогон backend — **950** (73 файла), ошибок нет.

## Статус реализации (Ф3)

- **Передача владения.** `POST /api/v2/projects/:id/transfer` (core-фабрика
  `createProjectRoutes` + backend-обёртка `routes/projects.ts`): тело `{user_id}` — схема
  `projectTransferSchema` (`@itphx/synth-shared`), **строгая** (`.strict()`): лишнее поле →
  `400 VALIDATION_ERROR` (опечатка в теле иначе «передала бы владение не туда»).
  Право — текущий владелец (`ownerId`) **или** `ADMIN` (опция `canTransfer`); `LEAD`,
  участник с ролью `owner`, `EDITOR`/`VIEWER`, посторонний → `403 FORBIDDEN` (передача
  владения — не «управление содержимым»; сквозной обзор `LEAD` права не даёт).
- **Поведение.** Новый владелец → `ownerId` **и** роль `owner` в `members`; прежний
  владелец (если это другой пользователь) → роль `editor` — доступ к содержимому
  сохраняется, право управления — нет. Правка **атомарна** (`store.mutate` — чтение и
  запись под локом хранилища). Ответ — DTO проекта.
- **Получатель — по ACL-id.** `GET /api/v2/users/directory` отдаёт **ACL-id** (пространство
  `User.id`), а не `profile.id`: привязанная identity `provider: 'auth'` (`externalId` =
  `User.id`) либо `profile.id` для legacy-профилей; привязка создаётся автоматически при
  логине (идемпотентно, best-effort — конфликт пары в лог, вход не ломается). Передача
  владения ищет получателя по тому же id (сначала identity `auth`, затем `profile.id`); в
  админском `GET /api/v2/users` остаётся `profile.id`.
- **Ошибки.** `404 NOT_FOUND` (нет проекта), `403 FORBIDDEN` (нет права), `400
  VALIDATION_ERROR` — нет `user_id`/пустая строка, лишние поля, передача самому себе,
  сервисная идентичность (`service:*` — владельцем человек не становится), неизвестный
  или отключённый получатель (`profilesStore`: профиль должен существовать и быть
  активным), `remote:`-проект (владение удалённого проекта передаётся на сервере
  проекта, локальная копия прав доступа не имеет).
- **Событие и аудит.** `project.updated { kind:'access' }` — хаб пересчитывает подписки
  WS/SSE (новый владелец получает события проекта, прежний теряет право управления);
  аудит `scope:'projects'` (`action:'update'`) — снимок «было/стало» **включая
  `owner_id`** (смена владения — тоже изменение доступа).
- **Политика переносов.** Ось доступа (`members`/`group_members`/`everyone_role`)
  описывает права **людей и групп конкретного инстанса** — на другой инстанс эти id не
  переносятся (там и людей/групп может не быть). Поэтому: портативный архив
  (`project.json`) состояние доступа **не содержит** (`serializeProjectArchive` вырезает
  `members`/`group_members`/`everyone_role`/`visibility`); импорт создаёт проект в
  состоянии «только автор» (владелец — импортирующий), а `--merge-into`/`mergeInto`
  состояние доступа **цели** не меняет (гранты источника не просачиваются);
  `syncProjectToRemote` (publish) гранты не переносит (в теле только контентные поля);
  `forkProjectToLocal` создаёт локальный проект в состоянии «только автор» (владелец
  `local`).
- **UI.** Блок «Владение» в панели проекта (`ProjectTab`, `ProjectOwnershipBlock`):
  показывает текущего владельца и кнопку «Передать владение» (видна только владельцу и
  `ADMIN` — enforcement на сервере); получатель выбирается из каталога
  `GET /api/v2/users/directory` (текущий владелец и `service:*` не предлагаются), перед
  передачей — подтверждение; `projectsApi.transferProject`, i18n
  `project.access.transfer.*` (RU/EN).
- **Тесты.** backend `routes/projects-transfer` — **15/15** (право: владелец/`ADMIN`/
  `LEAD`/участник/`EDITOR`/посторонний; отказы: себе, `service:*`, неизвестный,
  неактивный, без `user_id`, лишнее поле; событие `kind:'access'`, аудит с `owner_id` в
  before/after); core `server/routes/projects-access` — **28/28** (из них 8 — блок Ф3);
  core `projects/portable` — **32/32** (из них 4 — блок Ф3: в архиве нет состояния
  доступа, импорт «только автор», `--merge-into` не меняет цель); core `remote/transfer` —
  **25/25** (из них 3 — блок Ф3: publish не передаёт гранты ×2, fork — «только автор»).
  Полный прогон backend — **965** (74 файла), ошибок нет.

## Осталось

- **Живая проверка UI групп.** Каталог и мультиселект групп проверены в dev без IdP (каталог
  пуст ⇒ блок пустой). Сценарий «пользователь с группой видит проект» требует окружения с
  Keycloak (группы в claim'е) — проверка в `test`/`preprod` не выполнена.

## Открытые вопросы

1. Уведомление добавленным участникам — будущая фича (в Ф1/Ф2 не делаем): in-app `project.updated`,
   письмо или ничего?
2. Сопоставление групп IdP → отображаемые `teamRoles` — отдельное решение позже; нужно ли оно
   вообще и в какую сторону (только отображение или производное заполнение профиля)? Источник групп
   в Ф2 появился, но автоматически `teamRoles` не заполняются: гранты по группам и профиль —
   разные оси.

## История

- 2026-11-14 — принято из PROP-133 (реализована Ф1 — пользовательские гранты, единый резолвер,
  API/DTO/каталог/аудит, UI); Ф2 (источник групп) и Ф3 (передача владения и переносы) — остаток;
  файл предложения удалён.
- 2026-11-14 — реализована **Ф2** (источник групп): claim IdP + allowlist, `User.groups`/
  `RemoteUser.groups`, группы в принципале хода, каталог `GET /api/v2/users/groups`, UI-мультиселект
  групп, пересчёт подписок хаба при `kind:'access'`. Остаток — Ф3 и живая проверка UI групп в
  окружении с Keycloak.
- 2026-11-14 — реализована **Ф3** (передача владения и переносы): `POST
  /api/v2/projects/:id/transfer` (владелец/`ADMIN`, прежний владелец → `editor`, событие
  `kind:'access'`, аудит `scope:'projects'` с `owner_id`) и политика переносов — состояние
  доступа не переносится ни в портативном архиве, ни при publish/fork. Статус документа —
  `✅ Реализовано`; остаток — живая проверка UI групп в окружении с Keycloak.
