# AD-030: Hooks для событий агента

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-17
> **Парные документы:**
> - [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — `pre_tool_use` и `permission_denied` — точки расширения для allow/deny/ask и аудита безопасности;
> - [AD-025](./ad-025-plan-act-toggle.md) «Plan/Act как глобальный permission toggle» — `plan_approved` / `plan_rejected` привязаны к переходам plan/act.

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

**Не реализовано, кода нет.**

Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Идентификаторы системы хуков — `pre_tool_use`, `post_tool_use`, `agent_spawned`, `agent_completed`, `agent_failed`, `hooks.on`, `SynthPlugin` — не встречаются ни в одном пакете. Plugin SDK в коде отсутствует.
- Типы/поля `hooks` в `packages/shared/src` отсутствуют.
- Смежное, но не AD-030:
  - `ContextOptimizerGatewayHooks` — `packages/core/src/engine/context/optimizer.ts:34`, `setGatewayHooks()` (`:84`) — внутренний интерфейс шлюза безопасности (AD-036), не система хуков;
  - `EventBus` (SessionEventBus) — `packages/core/src/events/bus.ts:10` (AD-009) — шина событий сессии; событий с именами из таблицы выше в ней нет.
