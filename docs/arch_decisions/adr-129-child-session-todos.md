# ADR-129: Список задач дочерней сессии саб-агента

> **Статус:** ✅ Реализовано — решение принято 2026-11-07; код и тесты в дереве (см. «Статус в коде»).
> **Дата:** 2026-11-07
> **Связано:** [ADR-039](./adr-039-plan-in-project.md) (todo — в `session.todos`, а не в ответе модели),
> [ADR-026](./adr-026-subagent-context-modes.md) (режимы контекста саб-агента),
> [ADR-111](./adr-111-background-subagent-sessions.md) (фоновые прогоны и реестр),
> [ADR-070](./adr-070-system-prompt-composer.md) (state-сообщения и композиция промпта),
> [ADR-118](./adr-118-message-stream-v2.md) (поток хода и события).

## Контекст

По ADR-039 операционный список задач живёт в `Session.todos` и у **любой** сессии, включая
дочернюю сессию саб-агента. Но тулы `todo_*` определяли владельца списка по `extra.sessionId` —
а в контекст инструментов ребёнка оркестратор клал **родительский** id (это же значение нужно
событиям, `permission.ask`/`replied` и проектно-автоматизационному скоупу). Следствия:

- **Ребёнок писал в родителя.** `todo_write`/`todo_add`/`todo_update`/`todo_delete` из саб-агента
  меняли `session.todos` родительской сессии и публиковали `todos.updated` в её канал. Родитель
  видел чужие правки своего списка, а собственный список ребёнка оставался пустым.
- **Список не передавался при создании.** У вызывающего агента не было способа дать ребёнку
  стартовый список: параметра `task.todos` не существовало, а `session.todos` новой сессии пуст.
- **Ребёнок не видел свой список.** Цикл саб-агента не вызывает `syncStateMessages`, поэтому
  seeded-список (если бы он был) не попадал в историю ребёнка как state-сообщение и не был виден
  модели в привычном для основного хода виде.
- **Результат без списка.** `task` возвращал только текст отчёта: родитель не знал, что сделано,
  что осталось и в каком состоянии ребёнок закончил работу.
- **Фон возвращает `running` сразу.** При `background: true` родитель получает `{status:'running'}`
  и позже — уведомление; списка задач в нём не было.
- **Побочный симптом.** Предохранитель бюджета контекста (`agents.subagentMaxInputTokens`) при
  срабатывании перечисляет незавершённые пункты из `child.todos`. Из-за записи в родителя список
  ребёнка был пуст, и детерминированный отчёт терял раздел «что осталось».

## Решение

1. **Владение списком — у ребёнка, `extra.sessionId` не подменяем.** В контекст тулов ребёнка
   добавлено отдельное поле `extra.todoSessionId = childSessionId`
   (`packages/core/src/engine/tools/task/run-cycle.ts`), а `todo_*` выбирают владельца через
   `resolveTodoSessionId(extra) = todoSessionId ?? sessionId`
   (`packages/core/src/engine/tools/todo.ts`). `extra.sessionId` остаётся **родительским** — события,
   подтверждения (`permission.ask`/`permission.replied`) и проектный/automation-скоуп не меняются.
2. **Новая capability `todo` — без расширения полномочий.** В `ToolCapability`
   (`packages/shared/src/types/tools.ts`) добавлена `todo`; пять тулов (`todo_write`, `todo_list`,
   `todo_add`, `todo_update`, `todo_delete`) объявляют `[runtime, todo]`. В permission-слое появилась
   группа `todo` (`packages/core/src/engine/permission/groups.ts`, имена продублированы в `runtime`
   намеренно — правило `permission.rules.runtime` действует как прежде, а `permission.rules.todo`
   отключает только список задач). Capability выдана всем встроенным агентам, кроме `title`
   (включая read-only `researcher`/`general`/`explore`/`security-auditor`): это доступ к
   собственному операционному списку, а не к `project_*` — проверка пересечения capability
   полномочий проекта не расширяет.
3. **Параметр `task.todos` — стартовый список.** Схема `todoAddItemSchema[]`
   (`packages/core/src/engine/tools/task/args.ts`): `status`/`priority` опциональны (дефолты
   `pending`/`medium`), `id` сохраняются как переданы — вызывающий агент сверяет списки по ним.
   Новая дочерняя сессия — сид списка; вместе с `task_id` — **полная замена** (семантика
   `todo_write`); без параметра существующий список не трогается. Сид пишется в
   `prepareChildSession` (`packages/core/src/engine/tools/task/fork.ts`) **до** публикации
   `session.created`; унаследованные от родителя state-сообщения `todos_updated` при создании
   удаляются (это derived-состояние родительского списка).
4. **Видимость — durable state-сообщение.** Список ребёнка синхронизируется сообщением
   `todos_updated` (`packages/core/src/engine/tools/task/child-todo-state.ts`,
   `ensureTodoStateMessage` — идемпотентно: сравнивает последнее state-сообщение с актуальным
   рендером, добавляет только при отличии, устаревшее удаляет). Вызывается при создании ребёнка,
   при продолжении по `task_id` и при HTTP-resume (`task-resume.ts`). `messageToLLMMessage`
   (`packages/core/src/engine/tools/task/prompt.ts`) отдаёт state-сообщения как `role:'user'` с
   обёрткой `<system-state type="…">` — паритет с основным ходом (Anthropic не принимает `role:
   system`).
5. **Инструкция финализации.** `packages/core/prompts/system/TODO_FINALIZE.{ru,en}.md` +
   `ContextConfig.getTodoFinalizePrompt` (порт `ContextFileRepository`, реализации memory/PG/stubs)
   + `buildTodoFinalizeSection` (`task/prompt.ts`). Блок `[TODO FINALIZE]` включается только если у
   ребёнка **есть** `todo_write` в уже собранных тулах (учитывает capability/админ-отключение) и
   `session.todos` непуст; сам список в промпт не дублируется — он живёт state-сообщением.
6. **Результат несёт список.** `renderTodosSection` добавляет `<todos>` в `<task_result>` (кап
   **30** пунктов, хвост — маркер `todo.more`), а `metadata` — полный массив `todos` (без капа,
   данные для UI/аналитики), `todos_total` и `todos_unfinished`. Секция и поля присутствуют во
   **всех** терминальных ветках: обычный финал, отмена/`finishAborted`, ошибка LLM, бюджет
   контекста (`task.context_budget`), шаг-лимит и жёсткий сбой (`task.subagent_exec_error`).
   Пустой список — секции и полей нет (прежний вид результата).
7. **Фон и detach — тем же путём.** `service.finish(..., {metadata:{todos}})`
   (`task/tool.ts`, `task/detachable.ts`); `buildSubagentNotification`
   (`engine/background/service.ts`) добавляет `<todos>` в конверт уведомления и `todos` в
   `metadata` сообщения-уведомления. Немедленный ответ `background:true` не меняется
   (`{status:'running'}`). Отдельного поля в `BackgroundRunRecord` нет — используется существующее
   свободное `metadata`.
8. **Без авто-merge.** Родитель получает список в результате и сам решает, что перенести
   (`todo_update`). Существующие родительские списки, загрязнённые прежним поведением, не
   мигрируются.

## Ограничения и краевые случаи

- **`task-resume` не принимает `todos`.** HTTP-resume только синхронизирует state-сообщение с уже
  существующим списком ребёнка; параметра для замены списка у него нет (замена — через
  `task({task_id, todos})` или `todo_write` в прогоне).
- **Списки не копируются при fork.** Ребёнок не наследует `session.todos` родителя ни в одном
  режиме контекста: это отдельная задача, а не продолжение диалога; стартовый список задаётся
  только явно (`task.todos`).
- **Кастомные агенты без capability `todo`.** Инструкция `[TODO FINALIZE]` добавляется только если
  `todo_write` реально попал в собранные тулы: без него список для ребёнка пассивен (сид виден, но
  менять нечем). Важно: тулы объявляют `[runtime, todo]`, а доступность считается по **пересечению**
  capability — агент с `runtime`, но без `todo`, по-прежнему видит `todo_*` (совместимость с
  существующими/кастомными агентами); недоступны они только агенту без обеих capability
  (например, `title`).
- **Шаг-лимит не даёт вызвать тулы.** Финальный шаг-отчёт идёт с `toolChoice: 'none'`, поэтому
  список в результате — последний известный на момент лимита; инструкция финализации его не
  «дотягивает».
- **Пустой список — прежний вид.** Нет `<todos>`, нет `metadata.todos`/`todos_total`/
  `todos_unfinished`; уведомление фонового прогона — прежний конверт.
- **`background: true` — сразу `running`.** Список появляется только в терминальном уведомлении
  (и в карточке прогона из `metadata`), не в немедленном ответе.
- **Ошибка чтения списка не фатальна.** `readChildTodos` при ошибке/отсутствии сессии возвращает
  пустой список — результат формируется как раньше.
- **Кап — только в тексте.** В `content` ≤ 30 пунктов с маркером `todo.more`; полный массив
  доступен в `metadata.todos`.

## Альтернативы

- **Подменить `extra.sessionId` целиком на id ребёнка.** Отклонено: это поле — адрес событий,
  подтверждений прав (`permission.ask`/`replied`) и проектно-автоматизационного скоупа. Подмена
  сломала бы маршрутизацию подтверждений и события родителя ради одной функции; отдельное
  `todoSessionId` меняет ровно владельца списка.
- **Блок `[TODO]` в system prompt вместо state-сообщения.** Отклонено: ADR-039/ADR-070 требуют
  хронологического state-сообщения для derived-состояния. Блок в промпте пришлось бы пересобирать
  на каждом шаге, он ломал бы prompt-cache и расходился бы с историей; список в промпте — дубль.
- **Авто-merge результата в родительский список по `id`.** Отклонено: два писателя (родитель и
  ребёнок) дают конфликт и неявную перезапись; решение о переносе остаётся за вызывающим агентом.
- **Отдельное поле `todos` в `BackgroundRunRecord`.** Отклонено: свободное `metadata` уже
  персистится и передаётся в уведомление; новое поле потребовало бы миграции хранилища без выгоды.

## Последствия

- **`todos.updated` идёт в канал ребёнка.** Вкладка саб-агента и подписчики его сессии видят
  изменения списка; родительский канал больше не получает чужие правки.
- **Предохранитель бюджета видит реальные незавершённые пункты.** Детерминированный отчёт по
  `task.context_budget` перечисляет то, что действительно осталось, а не пустой список.
- **UI-вкладка саб-агента показывает список.** `metadata.todos` в результате и в уведомлении даёт
  карточке прогона полные данные (в конверте модели — только капнутый рендер).
- **Родитель должен явно перенести список.** Авто-merge нет: после `task` вызывающий агент при
  необходимости зовёт `todo_update`/`todo_write` по id, сохраняя сверку.
- **История ребёнка получает derived-сообщение.** `todos_updated` — не «мусор»: он идемпотентно
  заменяется/удаляется и в промпт как список не дублируется.
- **Совместимость.** Пустой список и агенты без capability `todo` ведут себя как прежде; формат
  `task_result` расширен аддитивно (новая секция после `<child_session_id>`/статуса).

## Статус в коде

- **Владение:** `packages/core/src/engine/tools/task/run-cycle.ts` (`todoSessionId` в extra тулов),
  `packages/core/src/engine/tools/todo.ts` (`resolveTodoSessionId`, публикация `todos.updated` в
  канал сессии-владельца, `renderTodosMarkdownCapped`/`renderTodosSection`, `TODO_MAX_OUTPUT_ITEMS = 30`).
- **Capability и группы:** `packages/shared/src/types/tools.ts` (`ToolCapability.TODO`),
  `packages/core/src/engine/permission/groups.ts` (`TODO_TOOLS`, группа `todo`, порядок правил),
  определения агентов `packages/core/src/engine/agents/definitions/*.json`.
- **Параметр и сид:** `packages/core/src/engine/tools/task/args.ts` (`todos`),
  `packages/core/src/engine/tools/task/fork.ts` (`prepareChildSession` — сид до `session.created`,
  удаление унаследованных `todos_updated`), `packages/core/src/engine/tools/task/tool.ts`
  (создание, `task_id` — полная замена), `packages/core/src/engine/tools/task/types.ts` (шов).
- **Видимость:** `packages/core/src/engine/tools/task/child-todo-state.ts`
  (`ensureTodoStateMessage`), `packages/core/src/engine/tools/task/prompt.ts`
  (`buildTodoFinalizeSection`, `messageToLLMMessage` — state → `role:'user'` +
  `<system-state>`), `packages/core/src/engine/context/state-messages.ts` (рендер
  `todos_updated`).
- **Инструкция:** `packages/core/prompts/system/TODO_FINALIZE.{ru,en}.md`,
  `packages/core/src/engine/context/config.ts` (`getTodoFinalizePrompt`), порт
  `packages/core/src/storage/ports/context-file-repository.ts` и реализации
  (`storage/memory/content.ts`, `packages/storage-postgres/src/ports/context-files.ts`,
  `test-helpers/storage-stubs.ts`).
- **Результат:** `packages/core/src/engine/tools/task/run-cycle.ts` (`readChildTodos`,
  `todoMetadata`, секции во всех терминальных ветках).
- **Фон/detach:** `packages/core/src/engine/background/service.ts`
  (`buildSubagentNotification`), `packages/core/src/engine/tools/task/tool.ts`,
  `packages/core/src/engine/tools/task/detachable.ts` (`service.finish({metadata:{todos}})`).
- **Resume:** `packages/core/src/engine/tools/task-resume.ts` (синхронизация state-сообщения,
  без параметра `todos`).
- **UI-подпись capability:** `packages/ui/src/lib/i18n/messages/{ru,en}.ts`
  (`admin.agents.cap.todo`).
- **Тесты:** `todo.test.ts`, `task/fork.test.ts`, `task/tool.test.ts`, `task/prompt.test.ts`,
  `task/run-cycle.test.ts`, `task/detachable.test.ts`, `task-resume.test.ts`,
  `background/service.test.ts`, `context/config.test.ts`, `agents/capabilities.test.ts`,
  `permission/evaluator.test.ts`.

## История

- 2026-11-07 — принято и реализовано: todo-тулы ребёнка владеют его списком (`extra.todoSessionId`),
  capability `todo` и группа правил, параметр `task.todos`, durable state-сообщение
  `todos_updated`, инструкция `TODO_FINALIZE`, `<todos>`/`metadata.todos` во всех терминальных
  ветках результата и в уведомлении фонового прогона, без авто-merge.
