# PROP-133: Доступ к проекту — участники, группы и видимость

> **Статус:** 🧩 Предложение — единая ось доступа к проекту (автор / выбранные пользователи и группы / все пользователи) с распространением на всё содержимое, включая сессии
> **Решение до:** 2026-11-30
> **Дата:** 2026-11-11
> **Согласовано:** 2026-11-11 — роль «всем» `viewer` по умолчанию (+`editor` явно), `LEAD`/`ADMIN` — сквозной обзор, передача владения автор+`ADMIN`.
> **Источник:** обсуждение 2026-11-11 (на test пользователи не видят проекты друг друга); инвариант 21 корневого AGENTS.md, [ADR-089](./adr-089-external-events-automation.md) (видимость), [ADR-106](./adr-106-authority-layer.md) Ф4 (участники сессии).
> **Связано:** [ADR-014](./adr-014-project-container.md), [ADR-024](./adr-024-eventhub-transport.md), [ADR-118](./adr-118-message-stream-v2.md), [ADR-025](./adr-025-plan-act-toggle.md), [ADR-089](./adr-089-external-events-automation.md), [ADR-096](./adr-096-storage-layer.md), [ADR-097](./adr-097-storage-provider-class.md), [ADR-106](./adr-106-authority-layer.md), [ADR-107](./adr-107-plugin-facade-services.md), [ADR-115](./adr-115-multimodal-input.md), [PROP-074](./prop-074-soft-delete-retention.md)

## Решение (предложение)

Ввести **одну ось доступа к проекту** и вывести из неё все остальные формы доступа. Хранится не enum «видимость», а **состояние списка доступа** — три поля проекта:

```ts
members:       Record<userId, ProjectRole>;       // существует; становится рабочим списком пользователей
groupMembers?: Record<groupName, ProjectRole>;    // новое
everyoneRole?: ProjectRole | null;                // новое; null/undefined = проект не опубликован
```

**Видимость — производная величина, а не хранимое поле.** Она не пишется в договор проекта и вычисляется для DTO:

- `author` — пользовательских грантов нет, групп нет, `everyoneRole` не задан ⇒ проект видит только автор (плюс `ADMIN`/`LEAD` — сквозной обзор);
- `selected` — есть хотя бы один пользовательский грант и/или групп-грант, `everyoneRole` не задан;
- `all` — `everyoneRole ≠ null`; **по умолчанию `viewer`**, `editor` — только явным выбором автора (UI — переключатель «разрешить редактирование», по умолчанию выключен). Неявного повышения до записи нет.

**Три проекции в UI** — это три состояния одного и того же списка доступа: «Только автору» / «Только выбранным» / «Всем пользователям». Переключение проекции меняет поля состояния (очищает/заполняет `members`/`groupMembers`/`everyoneRole`), а не отдельный флаг.

Правила:

- **Видимость открывает всё содержимое проекта**: описание, workspace/FS, git, план, журнал, инварианты, память, пайплайны, **сессии и их историю**. Отдельных «частичных» видимостей нет.
- **Запись — по роли участника**: `viewer` — read-only, `editor`/`owner` — обычный ход. Потолок хода — существующий механизм [ADR-106](./adr-106-authority-layer.md) Ф4 (`engine/authority/participants.ts`), не новый.
- `ADMIN`/`LEAD` — сквозной обзор **при любом состоянии доступа, включая `author`** (сохраняем [ADR-089](./adr-089-external-events-automation.md), контракт не меняется).
- **Менять доступ** (`members`/`groupMembers`/`everyoneRole`) может только `canManage`: автор проекта, участник с ролью `OWNER`, `LEAD`, `ADMIN`. `EDITOR` — нет.
- **Видимость не даёт прав на изменение.** `canEditProjectContent` строится на роли, а не на факте видимости (инвариант 21); `viewer` не получает запись ни на одном контуре.
- **Совместимость.** У существующих проектов `members` = только владелец (`project-store.ts:130-145`, PG `principals-projects.ts:209-216`), поэтому состояние вычисляется как `author` — поведение не меняется. Миграция добавляет только nullable-поля.
- **Передача владения** — отдельный шаг, не часть редактирования доступа: только автор проекта или `ADMIN` (см. §3.4).

## Контекст

### Что уже есть

«Кто видит проект» сегодня размазано по **шести независимым реализациям предиката**, и они уже расходятся в деталях:

1. **Backend RBAC** — `packages/backend/src/routes/projects.ts:19-46` (`createProjectAccess`): `canManageProject` (owner / `members[userId] === OWNER` / `LEAD` / `ADMIN`), `canEditProjectContent` (+ `EDITOR`), `canReadProject` (+ любой участник).
2. **Видимость сессий** — `packages/core/src/server/session-visibility.ts:42-71` (`isSessionVisible`): владелец сессии, `localOwnerResolver`, иначе — `project.ownerId === userId || userId in project.members`.
3. **Инструменты агента** — `packages/core/src/engine/tools/project-resolve.ts:79-86` (`isProjectVisible`): `elevated`, `ownerId`, `hasOwnProperty(members)`.
4. **Файловый store** — `packages/core/src/storage/project-store.ts:106-127`: фильтр `list(userId)` — owner или `userId in members`.
5. **PostgreSQL** — `packages/storage-postgres/src/ports/principals-projects.ts:191-207`: `p.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members …)`; таблица `project_members(project_id, user_id, role)` — `packages/storage-postgres/src/migrations/001-init.ts:164-170`.
6. **UI-зеркало** — `packages/ui/src/lib/projectAccess.ts:26-70` (`canManageProject` / `canEditProjectContent`) плюс `packages/ui/src/lib/sessionAccess.ts`.

`members: Record<userId, ProjectRole>` **существует в контракте** (`packages/shared/src/types/project.ts:122-126`), но **write-path у него нет**:

- заполняется только владельцем при создании — `packages/core/src/storage/project-store.ts:130-145`, PG `packages/storage-postgres/src/ports/principals-projects.ts:209-216`;
- `PUT /projects/:id` не принимает `members`: whitelist `projectContentFields` — `packages/core/src/server/routes/projects.ts:163-166`, обработчик — `:484-599`;
- в UI есть только счётчик (`packages/ui/src/components/admin/ProjectsPanel.tsx:211`, `admin.projects.memberCount`).

Участники сессии выводятся из проекта — `packages/core/src/engine/authority/participants.ts:48-73` (`deriveSessionParticipants`), единственное место, где это происходит; глобальные роли со сквозным доступом — `ELEVATED_INSTANCE_ROLES = ['ADMIN','LEAD']` (`:31`). Потолок хода: `viewer` → read-only.

Список сессий фильтруется по `projectStore.list(userId)` — `packages/backend/src/routes/sessions.ts:801-808` (`resolveMemberProjectIds`), а подписки хаба строятся **только по своим сессиям** — `packages/backend/src/events/hub.ts:52` (`listSessions({ userId })`). Ограничение описано в `docs/MESSAGE_FLOW.md:920-956` (§8.11): для чужой сессии в shared-проекте live-события не придут до перезагрузки.

**Групп пользователей в продукте нет:**

- `groups` у агентов — привязка скиллов, не ACL (`packages/shared/src/types/agent.ts:34-40`);
- `teamRoles` — самоправный ярлык профиля, ни на что не влияет: `packages/shared/src/types/user.ts:103`, запись — `PUT /auth/profile` `packages/backend/src/routes/auth.ts:329,340`, UI — `packages/ui/src/components/settings/ProfileSettings.tsx:257-262,355-361`;
- Keycloak-группы используются только как способ выдать роль — `docs/KEYCLOAK.md:53-67`;
- claim `groups` не парсится: `packages/backend/src/auth/oidc.ts:242-285` извлекает только `realm_access.roles` / `resource_access.<clientId>.roles` и фильтрует по `KNOWN_ROLES`.

Список пользователей для выбора доступен **только ADMIN** и без пагинации — `packages/backend/src/routes/users.ts:12-33` (`requireAdminOrScope('users:read')`, `profiles.listProfiles()` целиком). В standalone `features.users=false` (`docs/API_V2.md:1345` и далее) — эндпоинта нет вовсе.

Смена схемы поддержана: PG-миграции нумеруются и регистрируются (`packages/storage-postgres/src/migrations/index.ts`, актуальны до `034-pending-approvals.ts`, пример аддитивной — `020-project-memory.ts`); файловый контур — `packages/core/src/storage/instance-meta.ts` (+ `synth migrate`, [ADR-092](./adr-092-instance-lifecycle-maintenance.md)/[ADR-097](./adr-097-storage-provider-class.md)); контракт порта прогоняется на file/memory/PG — `packages/core/src/storage/contract/principals.ts:505-536` (`describeProjectRepository`).

### Чего нет

- Единой функции доступа — шесть копий предиката правятся независимо.
- Write-path для `members`: API, UI и права на изменение списка доступа.
- Понятия «видимость проекта» и состояния «всем пользователям».
- Групп пользователей как субъекта ACL и разбора claim `groups` из IdP.
- `GET /users/directory` — лёгкого списка пользователей для выбора (не ADMIN).
- Расширения подписок хаба на сессии shared-проектов.

## Детали

### 1. Единая точка истины

Ввести чистую функцию без побочных эффектов:

```ts
// @itphx/synth-shared либо core/server/project-access-policy.ts
export type ProjectAccessRole = 'owner' | 'editor' | 'viewer' | null;

export function resolveProjectAccess(
  project: Pick<Project, 'ownerId' | 'members' | 'groupMembers' | 'everyoneRole'>,
  principal: { userId: string; roles: readonly string[]; groups?: readonly string[] },
): { read: boolean; role: ProjectAccessRole };
```

Порядок резолва (первое совпадение выигрывает, дальше не идём):

1. `project.ownerId === principal.userId` → `owner`;
2. `principal.roles` содержит `ADMIN` или `LEAD` → `owner` (сквозной обзор);
3. `project.members[principal.userId]` → эта роль;
4. максимальная роль по `project.groupMembers` среди `principal.groups` (owner > editor > viewer);
5. `project.everyoneRole` (если задан) → эта роль;
6. иначе — доступа нет (`read: false`, `role: null`).

`read` = `role !== null`. Неизвестная роль в данных (битая запись, легаси) — **fail-closed** в `viewer`, как в `normalizeParticipantRole` (`participants.ts:38-44`).

На неё переводятся **все шесть копий** предиката: backend `createProjectAccess`, `isSessionVisible`, `isProjectVisible`, `project-store.list(userId)`, PG `list(userId)` (SQL должен повторить те же приоритеты либо делегировать в резолвер по загруженным строкам), UI `projectAccess.ts`. Резолвер также становится источником роли для `deriveSessionParticipants` и guard'а: участники-группы и `everyoneRole` учитываются **через роль действующего пользователя**, а не через перечисление участников (иначе список участников пришлось бы материализовать, а `everyoneRole` — разворачивать в миллион записей).

Правило: **новый `:id`-маршрут проекта не заводит собственной проверки** — он берёт роль из резолвера на границе (инвариант 16).

### 2. Группы: источник

Ф2 (см. этапы): `auth.oidc.groups { claim: 'groups', allow: [...] }` + `User.groups?: string[]` (и `RemoteUser.groups` в гибриде — `packages/core/src/remote/types.ts:10-13`).

- Разбор claim — по образцу ролей (`packages/backend/src/auth/oidc.ts:242-285`): берём массив строк, фильтруем по `allow`, нормализуем, дедуп.
- Маппер group-membership в Keycloak — новый раздел `docs/KEYCLOAK.md` по образцу §2.3 (роли) / §2.4 (мапперы).
- **Fail-closed:** нет признака (`groups` отсутствует в токене) или не задан allowlist — групп у пользователя нет. Пустой allowlist ≠ «все группы».
- `teamRoles` **не используется для ACL** — это самоправное поле (пользователь пишет его себе сам, `auth.ts:329,340`). Допустимо производное заполнение для отображения — но отдельным решением, не в этом PROP.
- Позже (не в этом PROP): собственный справочник групп для standalone. Схема грантов (`groupMembers`) при этом не меняется.

### 3. API (предложение)

#### 3.1 Приём состояния доступа

`POST /api/v2/projects` и `PUT /api/v2/projects/:id` принимают:

```jsonc
{
  "members":        { "<userId>": "viewer" | "editor" | "owner" },
  "group_members":  { "<groupName>": "viewer" | "editor" | "owner" },
  "everyone_role":  null | "viewer" | "editor"
}
```

- Валидация — zod-схема в `@itphx/synth-shared`; **неизвестная роль → `400 VALIDATION_ERROR`** (fail-closed, без «умного» понижения).
- `members` не может содержать `ownerId` с ролью ниже `owner`; понижение автора — только через передачу владения (§3.4).
- Смена доступа — только `canManage`; `EDITOR`/`viewer` получают `403 FORBIDDEN`.
- Запись — через `store.mutate` (атомарный read-modify-write, `project-repository.ts`), не `load`+`save`.
- Публикация `project.updated` в канал сессий проекта — инвариант 27 (`opts.onProjectChanged`, `core/src/server/routes/projects.ts:594-597`).
- **Аудит изменений доступа** — запись `scope:'projects'` (кто, какие поля, было/стало) вместе с публикацией `project.updated`; отдельного уведомления добавленным участникам в Ф1 нет.
- `everyone_role = 'editor'` — явное действие автора (переключатель «разрешить редактирование»), требует `canManage`; **значение по умолчанию для «всем» — `viewer`**.

#### 3.2 DTO проекта

`serializeProject` (`packages/core/src/server/serialize.ts:400-410`) добавляет `members` (уже есть), `group_members`, `everyone_role` и **производное** `visibility: 'author' | 'selected' | 'all'`. `visibility` — только чтение; попытка записать его через API игнорируется (400 при явной попытке — предпочтительно).

#### 3.3 Каталог пользователей

`GET /api/v2/users/directory` — лёгкая проекция `{ id, username, display_name }`, **странично** по контракту ADR-118 §4 (`{ users, total, offset, limit, next_offset }`, `parseBoundedInt`/`paginate`). Доступ — любой аутентифицированный пользователь (иначе владелец проекта физически не может выбрать участников: `/users` сейчас только ADMIN).

- В standalone `features.users=false` (`docs/API_V2.md:1345`) ⇒ выбора пользователей/групп нет, UI этих проекций не предлагает.
- Ответ **не** содержит `roles`, `email`, `identities`, `notes` — только то, что нужно для выбора.
- В managed backend `route-access-census.test.ts` фиксирует отсутствие параметрических маршрутов в этом семействе; если `directory` станет `:id`-подобным — обязательна запись в `DECLARED_PARAM_ROUTES`.

#### 3.4 Передача владения

`POST /api/v2/projects/:id/transfer` — `{ user_id }`:

- **Право:** `project.ownerId === userId` **или** `ADMIN`. Общий `canManageProject` здесь **сужается**: его ветки `LEAD` и «участник с ролью `OWNER`» к передаче владения не применяются — `LEAD` и `OWNER`-не-автор права передачи не получают.
- Целевой пользователь существует и активен; нельзя передать `service:`-идентичности.
- Новый получает `ownerId` **и** роль `owner` в `members`; **прежний владелец остаётся `editor`** (не теряет доступ и не выпадает из проекта).
- Публикует `project.updated` и пишет аудит `scope:'projects'`.
- Пишет `:id`-маршрут → **обязательна запись в `DECLARED_PARAM_ROUTES`** (`packages/backend/src/app/route-access-census.test.ts:109`, рядом с проектами `:190-211`) — инварианты 16/17.

### 4. UI (предложение)

- Блок «Доступ» в панели проекта (`packages/ui/src/components/panels/ProjectTab.tsx`, рядом с секциями workspace/MCP/скиллов): радио «Только автору / Только выбранным / Всем пользователям».
  - `selected` — мультиселект пользователей (готовый `MultiSelectField`, `packages/ui/src/components/ui/settings/controls/MultiSelectField.tsx`) и групп (Ф2);
  - `all` — переключатель «разрешить редактирование»: по умолчанию **выключен** ⇒ `viewer`; включён ⇒ `editor` (никогда не включается автоматически);
  - весь блок гейтится `canManageProject`.
- Выбор при создании проекта — `packages/ui/src/components/panels/CreateProjectPopover.tsx`.
- Бейдж режима в списке проектов (`LeftPanel`/`ProjectsTabToolbar`).
- Зеркало предиката в `packages/ui/src/lib/projectAccess.ts` (сейчас там только `canManage`/`canEditContent`) — одна функция, общая для кнопок.
- i18n-ключи `project.access.*` в `packages/ui/src/lib/i18n/messages/{ru,en}.ts` (RU и EN в одном коммите).
- Standalone: проекция «Только выбранным» и «Всем» бессмысленна (пользователь один) — блок скрыт или read-only.

### 5. Хранилище и миграции

- Файловый контур: `groupMembers`/`everyoneRole` — опциональные поля `Project`, читаются с дефолтами; версия схемы — через реестр `instance-meta.ts` + `synth migrate` ([ADR-092](./adr-092-instance-lifecycle-maintenance.md)).
- PostgreSQL: новая миграция `035-project-access.ts` (номер — следующий свободный) в `packages/storage-postgres/src/migrations/index.ts`, **только `ADD COLUMN` nullable**: `group_members jsonb`, `everyone_role text`. Таблица `project_members` уже есть (`001-init.ts:164-170`) и переиспользуется как есть.
- Контракт порта: сценарий в `describeProjectRepository` (`packages/core/src/storage/contract/principals.ts:505-536`) — `list(userId)` учитывает группу/`everyoneRole`; прогон на file / memory / PG.

### 6. Сессии и подписки

- Видимость проекта распространяется на его сессии: `isSessionVisible` берёт роль из `resolveProjectAccess`, а не из собственной копии.
- `resolveMemberProjectIds` (`packages/backend/src/routes/sessions.ts:801-808`) должен возвращать **все проекты, где у пользователя есть роль** (включая `everyoneRole` и группы), а не только `owner`/`members`.
- Подписки хаба (`packages/backend/src/events/hub.ts:52`) строятся по `listSessions({ userId })` и потому сессии чужого владельца в shared-проекте не подпишут. Расширение — **тем же швом**, что `resolveMemberProjectIds`: подписка на сессии всех видимых проектов (инвариант 18, `docs/MESSAGE_FLOW.md:920-956`). Иначе после открытия проекта события не придут до перезагрузки.

### 7. Гибрид, импорт/экспорт, standalone

- **Гибрид:** локальный `core` должен знать `groups` пользователя (`RemoteUser`, `packages/core/src/remote/types.ts:10-13`), иначе гранты групп не применятся в локальном мире. `forkProjectToLocal` → состояние `author`; `syncProjectToRemote` — политика отдельным решением.
- **Импорт/экспорт** (`packages/core/src/projects/portable.ts:743`, создание — `:813`): `ownerId`/`members` не переносятся, и `group_members`/`everyone_role` переносить **нельзя** — id и групп на целевом инстансе нет. При импорте — состояние `author` (новый владелец = импортирующий).
- **Standalone:** один пользователь `local` (инвариант 19) ⇒ состояние всегда `author`; UI не предлагает вариантов.

## Этапы

**Ф1 (MVP) — пользовательские гранты.**
`members` как рабочий список, все три проекции, `resolveProjectAccess` и перевод на него всех шести копий, распространение на сессии/FS/git/память/процессы, `GET /users/directory`, UI-блок «Доступ», миграция nullable-полей, расширение подписок хаба, аудит `scope:'projects'` на изменение доступа.
Тесты: матрица доступа (автор/`members` по ролям/`ADMIN`/`LEAD`/`AUDITOR`/чужой `USER`), негативные кейсы (`EDITOR` не меняет доступ, `viewer` не пишет ни на одном контуре), перепись `:id`-маршрутов.

**Ф2 — группы.**
`groupMembers`, OIDC claim `groups` + allowlist, `User.groups`/`RemoteUser.groups`, UI-мультиселект групп (только при `features.users`), маппер Keycloak в `docs/KEYCLOAK.md`.

**Ф3 — передача владения и перенос.**
`POST /projects/:id/transfer` (автор или `ADMIN`; + запись в census), политика импорта/экспорта (не переносить `members`/`group_members`; при импорте — `author`), hybrid transfer (`forkProjectToLocal` → `author`, `syncProjectToRemote` — политика), документация + ADR после принятия.

## Риски и подводные камни

- **Предикат продублирован шесть раз** — забытая копия = дыра: агент видит скрытое, сессии «протекают», UI показывает недоступные кнопки. Ф1 не закрывается, пока все шесть не переведены на резолвер.
- **`members` ≠ права на изменение.** `viewer` не должен получать запись ни на одном контуре: FS, git, план, сообщения, очередь, процессы, память, пайплайны. Легко «открыть видимость» и заодно открыть запись.
- **Потолок хода.** Роль из группы должна применяться к **действующему** пользователю через резолвер, иначе `viewer` из группы сможет вести ход (или наоборот — `editor` окажется read-only).
- **Подписки WS/SSE строятся по владельцу** (`hub.ts:52`) — при открытии проекта события чужих сессий не придут до перезагрузки. Расширять тем же швом, что `resolveMemberProjectIds` (инвариант 18, `MESSAGE_FLOW.md` §8.11).
- **Импорт/экспорт** (`packages/core/src/projects/portable.ts`) не переносит `ownerId`/`members`; `group_members`/`everyone_role` тоже переносить нельзя — id и групп на целевом инстансе нет.
- **Гибрид:** без `groups` у `RemoteUser` локальный мир не применит групповые гранты; удалённые/локальные id не смешивать (инвариант 7).
- **Standalone:** один пользователь ⇒ UI не должен предлагать бессмысленные варианты; `features.users=false` отключает и выбор людей.
- **service-key** проекция `allowedProjects` — **независимая ось**, видимостью не расширяется и наоборот.
- **Метрики:** не добавлять `visibility`/`project_id` в лейблы `synth_*` — контракт [ADR-094](./adr-094-observability-metrics.md) закрыт, неизвестные значения уходят в `other`.
- **Обфускация/секреты:** `GET /projects/:id/secrets` и `withSecrets` остаются привилегией владельца/`ADMIN`/`AUDITOR`; видимость их не открывает (`session-idor-matrix.test.ts`, `route-access-census.test.ts`).
- **Передача владения уже́, чем `canManage`.** Общий `canManageProject` пускает `LEAD`; если переиспользовать его напрямую для `transfer`, `LEAD` получит право передачи. Нужен отдельный предикат: автор проекта **или** `ADMIN`.
- **Аудит доступа без шума.** `scope:'projects'` пишется на каждое изменение `members`/`group_members`/`everyone_role` и на `transfer`; не логировать полный список участников в текстовые логи.
- **`AUDITOR`** не получает содержимое проекта через новую ось — только аудит-поверхности.

## Не цели

- Собственный справочник групп для standalone (позже, схема грантов не меняется).
- Роль-ось в permission-слое: роли остаются доступом к эндпоинтам, а не правами внутри сессии ([ADR-029](./adr-029-granular-permissions.md)).
- Частичная видимость (например, «видит только план, не видит сессии») — видимость открывает всё.
- Перенос грантов между инстансами (импорт/экспорт, гибрид) — вне объёма.
- Гранулярные ACL на отдельные сообщения/файлы.
- Использование `teamRoles` как ACL.

## Принятые решения (2026-11-11)

1. **Роль режима «Всем пользователям».** По умолчанию `viewer`; `editor` — только явным выбором автора (UI — переключатель «разрешить редактирование»).
2. **Сквозной обзор.** `LEAD` сохраняет обзор и в состоянии «Только автору» (вместе с `ADMIN`); контракт [ADR-089](./adr-089-external-events-automation.md) не меняется.
3. **Передача владения.** Автор проекта + `ADMIN`; `LEAD` права передачи не получает. Прежний владелец остаётся `editor`, новый получает `ownerId` + роль `owner`.
4. **Аудит изменений доступа.** `scope:'projects'` + событие `project.updated`; отдельного уведомления добавленным участникам в Ф1 нет.
5. **Группы из IdP.** Только allowlist, без маппинга claim → `teamRoles` (возможное производное отображение — отдельным решением позже).

## Открытые вопросы

1. Уведомление добавленным участникам — будущая фича (в Ф1 не делаем): in-app `project.updated`, письмо или ничего?
2. Сопоставление групп IdP → отображаемые `teamRoles` — отдельное решение позже; нужно ли оно вообще и в какую сторону (только отображение или производное заполнение профиля)?

## Статус в коде

**Не реализовано.** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- `resolveProjectAccess`/`project-access-policy.ts` — отсутствуют;
- `groupMembers`/`everyoneRole` в `Project` (`packages/shared/src/types/project.ts:122-126`) — отсутствуют;
- запись `members` через API — отсутствует (`projectContentFields`, `core/src/server/routes/projects.ts:163-166`);
- `GET /api/v2/users/directory` — отсутствует (`packages/backend/src/routes/users.ts:12-33` — только `/` и `/:id`, ADMIN);
- разбор claim `groups` — отсутствует (`packages/backend/src/auth/oidc.ts:242-285`);
- UI-блок доступа и i18n `project.access.*` — отсутствуют.
