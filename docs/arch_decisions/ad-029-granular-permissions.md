# AD-029: Гранулярные permissions

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** права доступа на основе модели OpenCode — allow/deny/ask для каждого инструмента с поддержкой glob-паттернов для файлов.

**Контекст:** у Claude Code система прав — `disallowedTools` (простой список запрета). У OpenCode — allow/deny/ask на каждый инструмент + паттерны файлов с разрешением на glob-уровне. Модель OpenCode **строго лучше** — даёт точный контроль без оверхеда.

```yaml
permission:
  # Глобальные правила
  "*": "allow"                    # всё разрешено по умолчанию
  doom_loop: "ask"                # подозрительные циклы — переспросить
  question: "deny"                # саб-агентам нельзя переспрашивать пользователя
  plan_enter: "deny"              # саб-агентам нельзя входить в план
  plan_exit: "deny"               # саб-агентам нельзя выходить из плана

  # Внешние директории
  external_directory:
    "*": "ask"                    # любые внешние файлы — спросить
    "/tmp/*": "allow"             # кроме tmp

  # Чтение файлов
  read:
    "*": "allow"
    "*.env": "ask"                # .env — всегда спрашивать
    "*.env.example": "allow"      # .env.example — можно
    "**/credentials.*": "deny"    # credentials файлы — никогда

  # Редактирование (переопределяется в plan mode)
  edit:
    "*": "deny"                   # plan mode: ничего не трогаем
```

**Три уровня действия (action):**

| Action | Поведение | Пример |
|---|---|---|
| `allow` | Выполняется без спроса | `read: "*": "allow"` |
| `deny` | Блокируется с пояснением причины | `edit: "*.env": "deny"` |
| `ask` | Показывается пользователю на подтверждение | `external_directory: "*": "ask"` |

**Наследование саб-агентами:** саб-агент получает permissions родительской сессии + свои deny-правила (edit-ограничения от plan mode родителя) + блокировку `question`, `plan_enter`, `task`. Реализуется через `deriveSubagentSessionPermission()` по аналогии с OpenCode.

**«Разрешить в сессии» (once:false):** при ответе пользователя на `ask` с `once:false` в сессию добавляется allow-правило для тула — повторные вызовы не спрашивают. `once:true` — разрешение только на один вызов.

**Deny от пользователя:** при отказе (ask → deny) обработка завершается (`stopped_by_deny`), файл не создаётся, промежуточные результаты сохраняются в истории.

**Саб-агенты:** проходят permission-check; `ask` публикуется в родительскую сессию (`permission.asked`), ответ пользователя применяется к дочерней сессии.

**MCP-инструменты:** доступность по режимам plan/act — `SessionSettings.mcpToolSettings[server].default|tools[tool] = { plan, act }` (настройки в UI). В текущем режиме недоступный тул → deny.

### AD-030: Hooks для событий агента

**Решение:** система хуков на ключевые события жизненного цикла агента. На основе Claude Code (20+ событий), адаптированная под архитектуру Synth.

**Контекст:** у Claude Code — богатейшая система: PreToolUse, PostToolUse, Notification, Stop, PreCompact и 15+ других. У OpenCode — только `plugin.trigger("experimental.chat.system.transform")`. Synth реализует модель Claude Code на своей Plugin SDK.

**События:**

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

**Регистрация через Plugin SDK:**

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

**Важно:** хуки не должны блокировать основной поток. Для тяжёлых операций (CI, нотификации) — асинхронный fire-and-forget с таймаутом.

### AD-031: Verification синт

**Решение:** встроенный синт `verifier`, запускаемый автоматически после завершения реализации. Аналог VerificationAgent из Claude Code, адаптированный под архитектуру Synth.

**Поведение:**
- Запускается через hook `plan_approved` или вручную пользователем
- **Read-only** — не модифицирует проект (edit → deny, можно писать только в `/tmp`)
- Проверяет: билд, тесты, линтеры, typecheck
- Применяет **адверсальные пробы**: граничные значения, конкурентные запросы, идемпотентность
- Выносит вердикт: `VERDICT: PASS` / `FAIL` / `PARTIAL`
- `PARTIAL` — только когда проверка физически невозможна (нет тестов, сервер не стартует)

**Стандартный промпт** (адаптирован из Claude Code):

```
Ты verification specialist. Твоя задача — НЕ подтвердить что всё работает,
а ПОПЫТАТЬСЯ СЛОМАТЬ.

1. Прочитай план реализации из project.plan — это критерий успеха
2. Запусти build, полный test suite, linter, typecheck
3. Примени стратегию проверки под тип изменений:
   - Frontend: подними dev server → проверь через браузер → curl API
   - Backend: curl/fetch endpoints → проверь response shapes → error handling
   - Bug fix: воспроизведи баг → проверь фикс → регрессия
4. Адверсальные пробы (выбери подходящие):
   - Конкурентность: параллельные запросы → дубликаты? потерянные записи?
   - Граничные значения: 0, -1, "", очень длинные строки, unicode
   - Идемпотентность: повтори мутирующий запрос → дубликат создался?
5. Каждый чек: Command run + Output observed + Expected vs Actual
6. Финальная строка: VERDICT: PASS | FAIL | PARTIAL

Ты не подтверждаешь что код работает. Ты доказываешь что он НЕ работает.
```

**Интеграция в цикл:**

```
plan_exit (план утверждён)
  │
  ├─→ hook: plan_approved
  │     └─→ spawn verifier (background)
  │
  ├─→ исполнитель начинает работу по плану
  │
  └─→ verifier завершается
        ├─ PASS → результат принят
        ├─ FAIL → уведомление + возврат исполнителю
        └─ PARTIAL → только то что смогли + список не покрытого
```

**Почему не просто тесты:** тесты для реализации пишет та же LLM. Verification синт — независимая вторая пара глаз со свежим контекстом.

### AD-032: Хранение истории сессий

**Решение:** нормализованная модель «сессия → сообщения → части» с parent-child связями.

**Контекст:** Claude Code хранит историю в плоских JSONL-файлах (`~/.claude/transcripts/{sessionId}.jsonl`), саб-агенты — в sidechain. Это просто, но не даёт parent-child связей и запросов между сессиями. OpenCode использует нормализованную модель с parent_id — лучшая основа для командной работы.

**Логическая модель:**

```
Сессия (id, parent_id, project_id, agent, title, ...)
  │
  ├── parent_id → Сессия (parent-child дерево)
  ├── plan_path → путь к plan-файлу
  ├── branch_point → точка развилки для дочерних веток
  │
  └─1:N──→ Сообщение (id, session_id, seq, role, content, origin, source_msg_id, ...)
              │
              ├── seq — порядковый номер, уникален внутри сессии
              ├── origin: local | inherited | merged | crosspost
              ├── source_msg_id → Сообщение (откуда пришло)
              │
              └─1:N──→ Часть (id, message_id, type, data)
                          ├── type: text | tool_use | tool_result | reasoning
                          └── data — содержимое блока
```

**Ключевые сущности:**

| Сущность | Назначение |
|---|---|
| **Сессия** | Контейнер диалога. Имеет `parent_id` — дерево сессий. Хранит `agent`, `plan_path`, `branch_point` |
| **Сообщение** | Одна реплика (user/assistant/tool/system). Имеет `seq` — порядок внутри сессии. Имеет `origin` — откуда пришло |
| **Часть (part)** | Блок контента внутри сообщения: text, tool_use, tool_result, reasoning. Одно сообщение → много частей |
| **context_snapshot** | Сжатый контекст для summary-режима саб-агентов. Создаётся через отдельный LLM-вызов |

**Origin tracking — отслеживание происхождения сообщения:**

| origin | Как попало в сессию | source_msg_id |
|---|---|---|
| `local` | Создано в этой сессии (дефолт) | NULL |
| `inherited` | Унаследовано от родительской сессии (ветвление) | ID оригинального сообщения |
| `merged` | Скопировано из другой сессии пользователем (smart paste) | ID оригинального сообщения |
| `crosspost` | Существует в нескольких сессиях одновременно | Синхронизировано |

**Способы хранения (физический уровень):**
- Целевое хранилище: **PostgreSQL** (нормализованная схема). Идём сразу в PostgreSQL — SQLite как промежуточный вариант не используется.
- Переход с JSON-файлов (AD-005) на PostgreSQL.
