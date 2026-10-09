# AD-030: Hooks для событий агента

> **Статус:** ⚠️ Частично (реализованы hook-шина и эмиты жизненного цикла; Plugin SDK/загрузка плагинов — нет)
> **Дата:** 2026-09-17
> **Обновлено:** 2026-10-09 — статус уточнён до ⚠️ Частично и раздел «Статус реализации в коде» приведён
> к фактическому состоянию (hook-шина и эмиты реализованы, Plugin SDK — нет).
> Ранее (2026-10-08) закреплён как **фундамент** для внешних событий ([AD-089](./ad-089-external-events-automation.md)):
> добавлены события уровня интеграций (`external_event` / `message_received` / `callback` / `session_requested`)
> и связи с [AD-051](./ad-051-scheduler-pipelines.md), [AD-052](./ad-052-public-api-platform.md), [AD-086](./ad-086-extensibility-plugins-editions.md),
> [AD-087](./ad-087-messenger-gateway-merged.md).
> **Парные документы:**
> - [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — `pre_tool_use` и `permission_denied` — точки расширения для allow/deny/ask и аудита безопасности;
> - [AD-025](./ad-025-plan-act-toggle.md) «Plan/Act как глобальный permission toggle» — `plan_approved` / `plan_rejected` привязаны к переходам plan/act;
> - [AD-089](./ad-089-external-events-automation.md) «Платформа внешних событий и автоматизации» — Router и приём внешних событий строятся на hook-шине;
> - [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны» — cron/timer-события и событийные триггеры;
> - [AD-052](./ad-052-public-api-platform.md) «Публичная API-платформа» — приём внешних webhook'ов и событий;
> - [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость и внешние сервисы-надстройки» — add-on'ы и gateway-события;
> - [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway для мессенджеров» (⛔ поглощён AD-086).

## Решение

Система хуков на ключевые события жизненного цикла агента. На основе Claude Code (20+ событий), адаптированная под архитектуру Synth.

---

## Контекст

У Claude Code — богатейшая система: PreToolUse, PostToolUse, Notification, Stop, PreCompact и 15+ других. У OpenCode — только `plugin.trigger("experimental.chat.system.transform")`. Synth реализует модель Claude Code на своей Plugin SDK.

---

## Детали

### События

| Событие | Момент | Контекст | Назначение |
|---|---|---|---|
| `pre_tool_use` | Перед вызовом тула | `{tool, input, agent}` | Валидация, аудит, блокировка опасных команд |
| `post_tool_use` | После выполнения тула | `{tool, input, output, duration}` | Логирование, метрики, алертинг |
| `session_start` | Создание сессии | `{session_id, project, agent}` | Инициализация контекста, загрузка memory |
| `session_end` | Завершение сессии | `{session_id, summary, usage}` | Очистка, сохранение контекста, нотификация |
| `plan_approved` | План утверждён | `{plan_path, plan_content}` | Запуск verification, CI хуки, оповещение команды |
| `plan_rejected` | План отклонён | `{plan_path, reason?}` | Нотификация, возврат в plan mode |
| `agent_spawned` | Запуск саб-агента | `{agent_id, agent_type, parent_id}` | Настройка окружения, мониторинг |
| `agent_completed` | Саб-агент завершён | `{agent_id, result, usage}` | Сбор результатов, цепочка dependent tasks |
| `agent_failed` | Ошибка саб-агента | `{agent_id, error, retries}` | Алертинг, автоматический ретрай |
| `permission_denied` | Отказ в доступе | `{tool, input, reason}` | Аудит безопасности, оповещение ИБ |

### События уровня интеграций (внешние события)

Кроме событий жизненного цикла агента, hook-шина принимает **события интеграций** — они могут инициироваться
**внешне** (webhook / публичный API / шедулер / add-on сервис) и **внутренне** (агент, сессия, другой hook).
Имена согласованы с [AD-089](./ad-089-external-events-automation.md), где эти события нормализуются в сущность `Event`.

| Событие | Момент | Контекст | Назначение |
|---|---|---|---|
| `external_event` | Нормализованное внешнее событие принято | `{event: SynthEvent}` | Точка входа Router ([AD-089](./ad-089-external-events-automation.md)); позволяет плагинам наблюдать/дополнять событие |
| `message_received` | Получено сообщение из внешнего канала | `{source, chatKey?, threadKey?, from, text?}` | Частный случай `external_event` для мессенджер-шлюзов ([AD-086](./ad-086-extensibility-plugins-editions.md)/[AD-087](./ad-087-messenger-gateway-merged.md)) |
| `callback` | Нажатие кнопки/инлайн-действие во внешнем сервисе | `{source, callbackId, data, from}` | Обработка интерактивных действий (inline-кнопки, approve) |
| `session_requested` | Запрошено создание сессии | `{reason, agentTemplate?, project?, initiator}` | Создание сессии как событие ([AD-089](./ad-089-external-events-automation.md)); может инициировать владелец, агент или внешний сервис |
| `schedule_fired` | Сработал таймер/расписание | `{scheduleId, cron?, payload?}` | Cron/timer-триггеры ([AD-051](./ad-051-scheduler-pipelines.md)) |

> **Инициатор хука — внешний или внутренний.** Hook может быть вызван как изнутри агента (как в примере
> ниже), так и извне — через webhook/публичный API ([AD-052](./ad-052-public-api-platform.md)), шедулер
> ([AD-051](./ad-051-scheduler-pipelines.md)) или внешний add-on сервис ([AD-086](./ad-086-extensibility-plugins-editions.md)).
> Для внешнего пути обязательны проверка подписи/аутентификация, дедуп (`dedupKey`, AD-089) и аудит.

### Регистрация через Plugin SDK

```typescript
// plugin.ts
export default function myPlugin(synth: SynthPlugin) {
  synth.hooks.on('pre_tool_use', async (ctx) => {
    if (ctx.tool === 'bash' && ctx.input.includes('rm -rf')) {
      return { block: true, reason: 'Потенциально опасная команда' }
    }
  })

  synth.hooks.on('post_tool_use', async (ctx) => {
    await metrics.increment(`tool.${ctx.tool}`, { duration: ctx.duration })
  })

  synth.hooks.on('plan_approved', async (ctx) => {
    await slack.notify(`План утверждён: ${ctx.plan_path}`)
    await ci.triggerVerification(ctx.session_id)
  })
}
```

### Неблокирующее выполнение

**Важно:** хуки не должны блокировать основной поток. Для тяжёлых операций (CI, нотификации) — асинхронный fire-and-forget с таймаутом.

---

## Статус реализации в коде

**Реализовано частично:** hook-шина (`HookBus`) и эмиты жизненного цикла. Plugin SDK и загрузка плагинов — не реализованы.

### Реализовано

- **HookBus** — `packages/core/src/engine/hooks/hook-bus.ts` (реэкспорт через `engine/hooks/index.ts` и публичную поверхность core — `packages/core/src/index.ts`, инстанцируется в `server/app.ts`): `on`/`off`/`emit`/`emitAsync`, `priority` (больше — раньше; тай-брейк — порядок регистрации), режимы
  - `sync` (по умолчанию) — последовательный вызов в `emit`, блокировка через `{block, reason}` (немедленно прерывает цепочку) и `{patch}` (поверхностный мерж в контекст);
  - `async` — fire-and-forget в `emitAsync` с таймаутом `HOOK_ASYNC_TIMEOUT_MS = 5000` (`unref` таймера).
  Ошибки и таймауты обработчиков изолированы (логируются, наружу не пробрасываются). Шина не зависит от session-`EventBus` (`events/bus.ts`).
- **Типы** — `packages/shared/src/types/hooks.ts`: `HookName`, `HookMode`, `HookResult`, `HookContextMap` (карта контекстов всех объявленных хуков, включая события интеграций из AD-089). Экспортируются через `@itphx/synth-shared`.
- **Эмиты жизненного цикла:**
  - `session_start` — `packages/core/src/sessions/manager.ts` (`createSession`, после сохранения); `session_end` — там же (`deleteSession`, `archiveSession`), контекст `{ sessionId }`;
  - `pre_tool_use` (sync, блокирует исполнение → результат `hook.blocked`), `post_tool_use` (async, только для реально исполненных тулов), `permission_denied`, `plan_approved` — `packages/core/src/engine/orchestrator.ts`;
  - `agent_spawned`, `agent_completed`, `agent_failed` — `packages/core/src/engine/tools/task.ts` (эмитятся при наличии дочерней сессии саб-агента);
  - `session_requested` (async) и `external_event` (sync, блокируемый → решение `drop`) — `packages/core/src/engine/events/request-session.ts`.
- **Тесты** — `engine/hooks/hook-bus.test.ts`, `engine/orchestrator-hooks.test.ts`, `sessions/manager-hooks.test.ts`, `engine/events/request-session.test.ts`.

### Остаток (не реализовано)

- **Plugin SDK и загрузка плагинов** — отсутствуют: нет `SynthPlugin`, `synth.hooks.on(...)`, конфига/загрузчика и публичной точки регистрации внешних обработчиков (см. AD-086).
- **Неэмитируемые хуки** — `plan_rejected`, `message_received`, `callback`, `schedule_fired` объявлены в `HookName`, но нигде не эмитятся.
- **Политика `builtin`** — флаг `builtin` хранится в регистрации, но политики снятия (защита обработчиков ядра от внешних плагинов) нет: `off` снимает любой обработчик.
- **Неполные контексты** — `session_end` эмитится без `summary`/`usage`; в ветке жёсткого сбоя `agent_failed` не заполняет `retries`.
- **Конфиг/API/UI/аудит хуков** — отсутствуют.

## Связи

AD-030 — **фундамент** событийной модели Synth: hook-шина и Plugin SDK — база не только для жизненного цикла
агента, но и для внешних событий.

- [AD-089](./ad-089-external-events-automation.md) «Платформа внешних событий и автоматизации» — Router и приём
  внешних событий (`external_event`/`message_received`/`callback`/`session_requested`).
- [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны» — событийные триггеры и cron (`schedule_fired`).
- [AD-052](./ad-052-public-api-platform.md) «Публичная API-платформа» — приём внешних webhook'ов и событий.
- [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость и внешние сервисы-надстройки» — add-on'ы
  и gateway-события (External API/hooks как точки расширения).
- [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway для мессенджеров» — ⛔ поглощён AD-086; hook `message_received`.

