# PROP-074: Скрытие вместо удаления (soft-delete) — проекты, сессии, история; аудит-режим для ADMIN/AUDITOR

> **Статус:** 🧩 Предложение — Soft-delete (скрытие) проектов/сессий/сообщений, read-only-аудит для ADMIN/AUDITOR, restore/purge — ADMIN
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-23
> **Парные документы:**
> - [ADR-005](./adr-005-json-storage.md) «JSON-файлы как хранилище» — сущности лежат отдельными JSON-файлами; soft-delete не удаляет файл, purge — единственная точка физического `unlink`;
> - [ADR-014](./adr-014-project-container.md) «Проект как контейнер» — проект группирует сессии/файлы/план; скрытие проекта не трогает workspace;
> - [ADR-040](./adr-040-sessions-without-project.md) «Сессии без проекта» — `projectId` опционален; скрытие сессии не зависит от проекта;
> - [ADR-033](./adr-033-session-branching-merge.md) «Ветвление сессий и слияние» — `parentId`/`children`, `references`, merge; каскад скрытия — открытый вопрос;
> - [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — аудит и точки LLM-вызовов; hidden-сообщения исключаются из контекста до отправки провайдеру;
> - [PROP-037](./prop-037-commit-security-step.md) «Security step перед коммитом» — пример неизменяемого аудита/маркера;
> - [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — скрытие/restore/purge remote-сущностей выполняет владелец (сервер), локальный core проксирует; маршрутизация по `origin`;
> - [ADR-017](./adr-017-api-v2-hono.md) «API v2 на Hono» — контракт эндпоинтов и RBAC-паттерны;
> - [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — доступ к скрытому — через permission-слой, не хардкод;
> - [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — сборка промпта/контекста; hidden-сообщения не попадают ни в один тир;
> - [ADR-072](./adr-072-settings-ui-kit.md) «Settings UI Kit» — стандарт панели для админ/аудит-раздела «Скрытые»;
> - [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) «Мобильный UI + PWA» — `ConfirmDialog` для destructive-подтверждений, touch-first.

**Решение:** удаление проектов, сессий и сообщений становится **скрытием** (soft-delete). Данные физически не удаляются из хранилища (ADR-005), полностью скрыты от обычных пользователей (без заглушек/tombstone в UI) и исключены из LLM-контекста. Просмотр скрытого — read-only спец. режим ADMIN/AUDITOR; восстановление — ADMIN; окончательная очистка (purge) — ADMIN, вручную, без TTL, с аудитом.

---

## 1. Решения (Вопрос → Решение)

| Вопрос | Решение |
|---|---|
| Что скрывается | Проекты, сессии, сообщения (история в сессиях) |
| Физическое удаление | НЕ удаляется; данные остаются в хранилище (ADR-005) |
| Видимость скрытого для пользователей | Полностью скрыто; **никаких заглушек/tombstone в UI** |
| Скрытые сообщения и LLM | Не отправляются провайдеру, не входят в контекст/суммаризацию/auto-title/саб-агентов/micro-LLM, не влияют на токены/стоимость |
| Просмотр скрытого | Read-only спец. режим: ADMIN + AUDITOR |
| Восстановление (restore) | ADMIN |
| Окончательная очистка (purge) | ADMIN, вручную, **без TTL/автоочистки**; отдельный эндпоинт; аудит |
| RBAC | `requirePermission('ADMIN','AUDITOR')` для просмотра; ADMIN для restore/purge |
| Гибрид | Скрытие выполняется на стороне владельца сущности (remote → сервер), локальный core проксирует; маршрутизация по `origin` (ADR-042) |
| Аудит операций | `session.hidden/restored/purged`, `project.hidden/restored/purged`, `message.hidden/restored`; неизменяемый лог (ADR-036/037) |

## 2. Контекст и проблема

Сейчас удаление необратимо: `DELETE /sessions/:id` и `DELETE /projects/:id` вызывают `unlink` (`packages/core/src/storage/file-store.ts:431`, `packages/core/src/storage/project-store.ts:59`), `DELETE /messages/:sessionId/:index` делает `splice` по массиву и пересчитывает `seq` (`packages/core/src/server/routes/messages.ts:142`). Случайное удаление сессии/проекта/истории не восстановить, а аудит и разбор инцидентов требуют сохранять след. При этом бизнес-пользователю удалённое не должно быть видно, а модели — не должно попадать в контекст (иначе удаление бессмысленно). Решение — двухслойное: для пользователя сущность и сообщения просто исчезают из UI и из контекста (как при обычном удалении, без заглушек), но система сохраняет данные и открывает их только доверенной роли в read-only режиме.

## 3. Модель данных

Поля опциональны — обратная совместимость, миграция не нужна (JSON-файлы, ADR-005). Добавляются в типы и Zod-схемы (`packages/shared/src/types/index.ts`, `packages/shared/src/schemas`).

| Сущность | Поля | Семантика |
|---|---|---|
| `Session` | `deletedAt?: string`, `deletedBy?: string`, `deletionReason?: string` | Заполнено `deletedAt` → сессия скрыта |
| `Project` | `deletedAt?: string`, `deletedBy?: string`, `deletionReason?: string` | Заполнено `deletedAt` → проект скрыт |
| `Message` | `hidden: boolean` (уже есть, `index.ts:322`), `deletedAt?: string`, `deletedBy?: string` | `hidden=true` — сообщение-«надгробие»; `deletedAt` — для аудита/restore |

- **Почему не `visibility: 'visible' | 'hidden'`.** Отдельное поле-перечисление дублирует булев флаг и не даёт метаданных; тройка `deletedAt/deletedBy/deletionReason` несёт и признак, и след, и совместима с сортировкой/аудитом. `visibility` отклонён.
- **`Message.hidden` уже существует** и уже исключается из контекста: `packages/core/src/sessions/manager.ts:320,446,535`, `packages/core/src/engine/orchestrator.ts:1440–1441`, UI-статистика `packages/ui/src/components/panels/StatsTab.tsx:187`. PROP-074 переиспользует его как tombstone-флаг, а `deletedAt`/`deletedBy` добавляет для restore/аудита.

## 4. Фильтрация и API

- **Списки по умолчанию исключают скрытое.** `GET /sessions`, `GET /projects` (и агрегация гибрида) не отдают сущности с `deletedAt`. `?includeDeleted=true` — только ADMIN/AUDITOR; для остальных игнорируется (не 403 — просто без эффекта), чтобы не раскрывать существование.
- **Одиночный GET скрытой сущности обычному пользователю → `404`** (не `403`): не раскрываем факт существования. Для ADMIN/AUDITOR с `includeDeleted` — `200` (read-only).
- **`DELETE /sessions/:id` и `DELETE /projects/:id` → soft.** Ставят `deletedAt`/`deletedBy`, публикуют `session.hidden` / `project.hidden` вместо `session.deleted`. Публичное поведение события `session.deleted` переосмыслить как `session.hidden` (или сохранить имя `session.deleted` для совместимости и добавить флаг `hidden`).
- **Новые эндпоинты:**
  - `POST /sessions/:id/restore`, `POST /projects/:id/restore` — ADMIN, снимают `deletedAt`.
  - `POST /sessions/:id/purge`, `POST /projects/:id/purge` — ADMIN, физическое удаление (эквивалент текущего `unlink`), аудит. Альтернатива — `DELETE ?purge=true`; выбирается отдельный путь для явности и RBAC.
  - `DELETE /messages/:sessionId/:index` → soft (`hidden=true`, `deletedAt`), `POST /messages/:sessionId/:index/restore`.
- **Реализация — через core-фабрики** (`createSessionRoutes` и т. п.), backend монтирует и добавляет RBAC (`requirePermission`, `canAccess`), как сейчас: `packages/backend/src/routes/sessions.ts`, `packages/backend/src/auth/middleware.ts`.
- **Remote-ветки** сохраняют проксирование: `isRemoteRef(id)` → запрос на сервер (владелец сущности), как в `DELETE` сейчас (`packages/core/src/server/routes/sessions.ts:367`, `projects.ts:164`, `messages.ts:142`).

## 5. Контекст LLM

- Hidden-сообщения фильтруются во **всех** точках сборки контекста до отправки провайдеру (ADR-036 перечисляет 11 точек LLM-вызовов: tool-loop, fallback-эскалация, debug, суммаризация, auto-title, саб-агенты, micro-LLM).
- Токены и стоимость по hidden-сообщениям **не считаются**; в статистику (`inputTokens`/`outputTokens`/cost) они не входят.
- Точки фильтрации: `packages/core/src/engine/orchestrator.ts` (сборка сообщений хода, счётчик `excluded.hidden`), `packages/core/src/engine/context/optimizer.ts` (суммаризация/токен-окно), `packages/core/src/sessions/manager.ts` (merge/reference/копирование — уже фильтрует `!m.hidden`), `packages/core/src/engine/context/builder.ts`.
- Опора: ADR-070 (SystemPromptComposer — единая точка сборки промпта; hidden не попадает ни в один тир) и ADR-022 (движки stateless — история и состояние на бэкенде, значит фильтрация на бэкенде достаточна и обязательна).

## 6. UI

- **Обычный UI** скрытое не показывает: ни сессий, ни проектов, ни сообщений; никаких заглушек/tombstone, счётчиков «удалено» и плейсхолдеров в истории.
- **Отдельный админ/аудит-раздел «Скрытые»** (виден ADMIN/AUDITOR): read-only просмотр скрытых сессий, проектов и истории. У AUDITOR действий нет.
- **Кнопки Restore / Purge** — только ADMIN; Purge — destructive, с `ConfirmDialog` (ADR-044) и явным подтверждением.
- Раздел собирается на Settings UI Kit (ADR-072): один вертикальный скролл, фиксированная шапка, `SettingsPanel`/`SettingsSection`, `meta`-счётчики.

## 7. Гибрид

- Скрытие/restore/purge remote-сущностей выполняет **владелец сущности** (сервер), локальный core проксирует запросы через `packages/core/src/remote/client.ts`.
- События `*.hidden/restored/purged` приходят через `RemoteEventBridge` (`packages/core/src/remote/event-bridge.ts`) и публикуются в локальный EventBus.
- Списки гибрида агрегируют локальный и удалённый миры с фильтрацией скрытого (`packages/core/src/remote/aggregate.ts`); `includeDeleted` для ADMIN/AUDITOR объединяет скрытое из обоих миров.
- Маршрутизация — по полю `origin` (ADR-042); `remote:<id>` не дают прав, доступ проверяется на сервере.

## 8. Безопасность и retention

- **Purge — destructive, только ADMIN**, с подтверждением и записью в аудит. Физически удаляет JSON-файл сущности (через существующий `delete()`/`unlink` в `file-store.ts`/`project-store.ts`) и связанные данные (сообщения внутри файла сессии, ссылки). Открытый вопрос — что с ветками/`references` (см. §9).
- **Retention по умолчанию — бессрочный:** нет TTL и автоочистки. Скрытое живёт, пока ADMIN не выполнит purge.
- **Purge — путь реализации права на забвение** (GDPR): пользователь «удаляет», ADMIN по запросу выполняет окончательную очистку.
- **Согласование с требованием D16 «неизменяемость аудита».** Отдельного AD по D16 нет; аудит-инварианты — ADR-036/PROP-037 (append-only JSONL на сервере, RBAC ADMIN/AUDITOR, `packages/backend/src/routes/audit.ts`). Purge удаляет пользовательские данные, но **не** записи аудита: факт скрытия/восстановления/очистки остаётся в неизменяемом логе. Это согласуется с D16 и фиксируется как инвариант.

## 9. Открытые вопросы

- **Каскад скрытия:** скрывать ли дочерние/саб-агентские сессии (`parentId`/`children`) и связанные `references`/merge (ADR-033/040)? Нужен ли `cascade`-параметр или каскад по умолчанию.
- **`checkpoints`/`stickyNotes`:** скрываются вместе с сессией или остаются?
- **Purge файлов workspace проекта:** по решению **файлы НЕ трогаем** — purge удаляет только сущности и историю, workspace остаётся.
- **Auto-TTL:** нужен ли в будущем (сейчас — нет).
- **Расхождение скрытого на сервере и локально:** что показывать/делать, если статус скрытия разошёлся между мирами гибрида.
- **`deletionReason`:** обязателен ли при purge (для аудита) или опционален.

## 10. Реализация (предполагаемые файлы)

- `packages/shared/src/types/index.ts` + `packages/shared/src/schemas` — поля `deletedAt`/`deletedBy`/`deletionReason`; события `*.hidden/restored/purged`.
- `packages/core/src/storage/file-store.ts`, `packages/core/src/storage/project-store.ts` — soft-delete вместо `unlink`, purge как явный путь физического удаления.
- `packages/core/src/sessions/manager.ts` — `deleteSession` → soft, restore/purge, фильтрация.
- `packages/core/src/server/routes/sessions.ts`, `projects.ts`, `messages.ts` — soft `DELETE`, `restore`/`purge`, `includeDeleted`, `404` для скрытого.
- `packages/backend/src/routes/*` — RBAC (`requirePermission('ADMIN','AUDITOR')`), AUDITOR read-all, `includeDeleted`; `packages/backend/src/routes/audit.ts` — записи `*.hidden/restored/purged`.
- `packages/core/src/engine/orchestrator.ts` + context optimizer (`engine/context/optimizer.ts`, `builder.ts`) — фильтр hidden перед LLM.
- `packages/core/src/remote/*` — проксирование soft-delete/restore/purge, события через мост.
- UI: админ/аудит-раздел «Скрытые» на Settings UI Kit (ADR-072) + `ConfirmDialog` (ADR-044).
- Тесты: core-роуты (soft/restore/purge, `404`), backend RBAC, фильтрация контекста.

## 11. Вне объёма

- TTL/автоочистка и любые фоновые задачи retention.
- Удаление файлов workspace проекта.
- Изменение существующих записей аудита.
- Tombstone/заглушки в обычном UI.

## 12. Статус в коде и прототипе

- В коде сейчас — только жёсткое удаление (§2). `Message.hidden` существует и уже исключается из контекста, но используется не для пользовательского «удаления сообщения» (тот делает `splice`). `deletedAt`/`restore`/`purge`/`includeDeleted`/админ-раздел «Скрытые» — нет.
- В прототипе `~/dev/aic/t11` soft-delete и retention отсутствуют — заимствовать нечего; ближайший артефакт — роль-промпт `synth/context/ROLE_SECURITY_AUDITOR.md` (аудитор ИБ), не механизм хранения.
