# Synth — архитектурные соглашения

## Язык

Все сообщения, коммиты и документация — **на русском**. Не коммитить без явной просьбы пользователя.

---

## Прототип

Прототип: `~/dev/aic/t11` (t11). Его код **не менять**.

Локально: бэкенд `:5100`, UI `:5101`. Для аутентификации — ключ `your-secret-api-key`.

При реализации новой функциональности сначала исследовать как это сделано в прототипе.
Текущий проект разрабатывается как конечный продукт — решения могут отличаться.

---

## Структура проекта

Монорепозиторий `synth/` (pnpm workspaces). Единый стек TypeScript.

```
synth/
├── packages/
│   ├── shared/    @synth/shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @synth/core     # Ядро: сессии, очередь, LLM, TSM, MCP, FileStore
│   │                              #   HTTP API v2 (Hono), CLI (synth chat/serve)
│   ├── backend/   @synth/backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @synth/ui       # React 19 SPA + админка (Vite)
│   └── runner/    @synth/runner   # Gateway: адаптеры opencode/cline, LLM Proxy
│                                  #   Импортируется in-process из @synth/core
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
└── .prettierrc
```

### Слои зависимостей

```
@synth/shared  ←  только контракты, никакой логики
       ↑
@synth/core    ←  импортирует shared, содержит всю общую логику
       ↑
┌──────┴──────┐
@synth/backend │ @synth/ui     ←  импортируют core
@synth/runner (in-process)     ←  опционально импортируется в core
```

---

## Команды

Из корня `synth/`:

```bash
# Разработка
./dev.sh                    # backend (:5000) + UI (:5002)
./dev.sh backend | ui | core | all

# Сборка, тесты, линтинг
pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/`; backend — аналогично для `definitions/`.

Логи: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`. Каталог `tmp/` не коммитится.

---

## Архитектурные решения (ключевые)

| AD | Суть |
|----|------|
| AD-002 | Собственная TSM (Task State Machine), в @synth/core |
| AD-005 | JSON-файлы как хранилище (атомарная запись через tmp-файл + rename) |
| AD-008 | WebSocket для real-time событий |
| AD-009 | SessionEventBus — шина событий сессии |
| AD-014 | Проект как контейнер (сессии, файлы, контекст внутри проекта) |
| AD-017 | Собственный API-контракт (API v2 на Hono) |
| AD-018 | Выбор AI-движка на уровне сессии |
| AD-019 | React 19 SPA с нуля |
| AD-022 | Единый TypeScript стек + Runner архитектура |
| AD-023 | Единая система конфигурации (@synth/shared/config) |
| AD-024 | Единый транспорт: EventHub (backend) + TransportClient (UI) |
| AD-025 | Plan/Act как глобальный permission toggle (не отдельные агенты) |
| AD-026 | Режимы контекста саб-агента: inherit / summary / none |
| AD-027 | Двойная передача плана: диск + system prompt |
| AD-028 | Настраиваемая строгость цикла Plan→Build: auto / strict / off |
| AD-029 | Гранулярные permissions: allow/deny/ask per tool + file patterns |
| AD-030 | Hooks для событий агента (pre/post tool use, session, plan, spawn) |
| AD-031 | Verification синт (аналог VerificationAgent из Claude Code) |
| AD-032 | Хранение истории: SQLite нормализованная схема (сессии, сообщения, части) |
| AD-033 | Ветвление сессий, наследование контекста и межсессионное слияние |

Подробности deprecated решений — в `archive/AGENTS_OLD.md`.

### AD-022: TypeScript стек + Runner

- **@synth/core** — автономное ядро: сессии, очередь, LLM-провайдеры, TSM, MCP, HTTP API v2, CLI
- **@synth/backend** — облачный API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
- **@synth/runner** — мост между бэкендом и движками (opencode, cline, synth-core)
- **@synth/ui** — React 19 SPA + админка

### AD-023: Конфигурация

Приоритет: `CLI-флаги > SYNTH_* env vars > config.yaml > defaults`.

Каскадный поиск `config.yaml`:
1. `--config` / `SYNTH_CONFIG`
2. `./synth.config.yaml`
3. `./config.yaml`
4. `~/.config/synth/config.yaml`
5. `/etc/synth/config.yaml`

Ключевые env vars: `SYNTH_DATA_DIR`, `SYNTH_PORT`, `SYNTH_CORE_PORT`, `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`.

### AD-024: Транспорт (EventHub + TransportClient)

Единое WS-соединение `WS /ws/events` для всех событий. EventHub на бэкенде автоматически подписывает клиентов на сессии пользователя. TransportClient на UI — единый клиент с авто-фоллбеком на SSE.

### AD-025: Plan/Act как глобальный permission toggle

**Решение:** Plan/Act режимы — глобальное состояние сессии, не привязанное к конкретному синту. При переключении режима меняется набор доступных инструментов, но роль и промпт агента остаются прежними.

**Контекст:** в OpenCode Plan и Act — это разные агенты (plan agent ↔ build agent) со своими permissions и системными промптами. В Claude Code — один и тот же агент, но с переключением permissionMode. И тот и другой подход сошлись на одном: plan mode — это ограничение инструментов, а не отдельная личность. Synth идёт по пути Claude Code.

**Реализация:**

```yaml
# config.yaml
session:
  mode: "auto"  # plan | act | auto

agents:
  analyst:
    description: "Анализирует код, архитектуру, находит проблемы"
    systemPrompt: "..."
    # tools — максимальный набор для синта
    # в plan mode write-тулы будут заблокированы глобально
```

| Режим | Поведение | Переключение |
|---|---|---|
| `plan` | **Read-only.** Все write/edit/delete → deny. Синт исследует, задаёт вопросы, пишет план в `.synth/plans/`. Единственное исключение — сам plan-файл | Пользователь (`/plan`) или синт через tool `plan_enter` |
| `act` | **Полный доступ.** Набор тулов из конфига синта + глобальные permissions | Пользователь (`/act`) или tool `plan_exit` |
| `auto` | Синт **сам решает**, когда войти в план. Вызывает `plan_enter` если задача сложная, требует исследования или архитектурных решений | Автоматически (аналог EnterPlanModeTool) |

**Почему не N×2 агентов:** создание отдельных plan-версий для каждого синта даёт квадратичный рост конфигурации. С глобальным toggle — N синтов × 3 режима = те же N в конфиге, а режим переключается сессионно.

### AD-026: Режимы контекста саб-агента

**Решение:** три режима передачи контекста при запуске саб-агента.

**Контекст:** fork-модель Claude Code (агент наследует всю историю родительской сессии) удобна на коротких диалогах, но на длинных — саб-агент получает 50K+ токенов мусора. Изоляция OpenCode (агент — чистый лист, только prompt) дешевле, но легко упустить важный контекст. Synth даёт выбор.

| Режим | Поведение | Токены | Когда использовать |
|---|---|---|---|
| `inherit` | Саб-агент получает полную историю родительской сессии + свой prompt | Много (fork-модель) | Короткие диалоги (<10K токенов), продолжение разговора, тесная связь с родителем |
| `summary` | Контекст сжимается через отдельную LLM перед отправкой саб-агенту. В саммари попадают: ключевые решения, соглашения, результаты предыдущих шагов | Среднее (авто-саммари) | Длинные диалоги, нужно сохранить суть без мусора. **Дефолт для продакшена** |
| `none` | Саб-агент получает только prompt. Никакого контекста родителя | Минимальное | Самодостаточные задачи, параллельные workers, чистое выполнение по спецификации |

**Выбор режима:**

```bash
synth task "Исправь баг в auth.ts" --context summary
synth task "Проверь build"         --context none
synth task "Продолжи рефакторинг"   --context inherit
```

**Внутренняя механика:** `summary` реализуется через дополнительный вызов LLM (быстрой/дешёвой модели) для компрессии контекста перед spawn-ом саб-агента. Саммари кешируется до следующего значимого изменения родительской сессии.

### AD-027: Двойная передача плана

**Решение:** после утверждения план записывается в файл `.synth/plans/{timestamp}-{slug}.md` **и** вставляется в system prompt исполнителя.

**Контекст:** Claude Code встраивает план в `tool_result` выхода из plan mode — модель видит план сразу, но он существует только в контексте сессии. OpenCode пишет план на диск, модель должна прочитать его отдельным tool call. Synth берёт оба подхода.

```
plan (план написан)
  │
  ├─1─→ .synth/plans/{ts}-{slug}.md    ← файл на диске
  │       • персистентность между сессиями
  │       • аудит: видно что и когда планировали
  │       • возобновление: можно продолжить через неделю
  │
  └─2─→ system prompt исполнителя       ← встроен в контекст
          • немедленная видимость без tool call
          • не тратит токены на чтение файла
```

**Формат плана:**

```markdown
# План: {краткое описание}
> Создан: 2026-07-22 14:30 (analyst)
> Утверждён: 2026-07-22 14:35

## Подход
...

## Критические файлы
- src/auth/validate.ts:42
- src/auth/types.ts:15

## Шаги
1. ...
2. ...

## Верификация
- Прогнать тесты auth/*.test.ts
- Проверить edge cases: ...
```

**Защита от потери:** при возобновлении сессии план восстанавливается из файла. Если файл не найден (CCR/remote сессия) — ищется в снапшотах и истории сообщений (аналог `copyPlanForResume` из Claude Code).

### AD-028: Настраиваемая строгость цикла Plan → Build

**Решение:** три режима строгости, настраиваются глобально или на уровне проекта.

| Режим | Поведение | Когда синт может писать | Аналог |
|---|---|---|---|
| `auto` | Синт сам решает, нужен ли план. Для простых задач — сразу делает. Для сложных — вызывает `plan_enter` | После того как сам решил (или без плана для простых) | Claude Code (EnterPlanMode + ExitPlanMode) |
| `strict` | **План обязателен** перед любым write. Без утверждённого плана все write/edit/delete → deny. Исследовать (read) можно | Только после `plan_exit` (план утверждён) | OpenCode (принудительный Plan→Build цикл) |
| `off` | Планирование отключено. Всегда act mode | Всегда | — (для тривиальных фиксов, Personal/personal) |

```yaml
# config.yaml
session:
  plan_mode: "auto"  # auto | strict | off
```

**Рекомендации по выбору:**
- `strict` — командная работа, сложные проекты, новички в команде. Не даст наломать дров
- `auto` — продвинутые пользователи, balance между скоростью и безопасностью
- `off` — персональные скрипты, прототипы, одноразовые задачи

**Вход в план в режиме `auto`:** синт получает промпт-инструкцию (аналог EnterPlanModeTool prompt): «Если задача сложная, затрагивает несколько файлов или требует архитектурных решений — вызови `plan_enter`. Для простых фиксов — делай сразу.»

### AD-029: Гранулярные permissions

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
    ".synth/plans/*.md": "allow"  #   кроме plan-файла
```

**Три уровня действия (action):**

| Action | Поведение | Пример |
|---|---|---|
| `allow` | Выполняется без спроса | `read: "*": "allow"` |
| `deny` | Блокируется с пояснением причины | `edit: "*.env": "deny"` |
| `ask` | Показывается пользователю на подтверждение | `external_directory: "*": "ask"` |

**Наследование саб-агентами:** саб-агент получает permissions родительской сессии + свои deny-правила (edit-ограничения от plan mode родителя) + блокировку `question`, `plan_enter`, `task`. Реализуется через `deriveSubagentSessionPermission()` по аналогии с OpenCode.

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

1. Прочитай план реализации из .synth/plans/ — это критерий успеха
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

**Способы хранения (физический уровень — отдельное решение):**
- Локально: SQLite (одна embedded БД, не требует сервера)
- Командный режим: PostgreSQL (через drizzle — смена драйвера)
- Вариант: JSON-файлы с индексацией (как сейчас в прототипе)

### AD-033: Ветвление сессий и межсессионное слияние

**Решение:** три слоя наследования истории + операция слияния по инициативе пользователя.

**Контекст:** OpenCode поддерживает parent-child через `parent_id` и `ForkInput`, но fork копирует все сообщения целиком и не поддерживает слияние. Claude Code передаёт контекст саб-агента через копирование `initialMessages` в runtime. Synth добавляет: ветвление без копирования данных, ссылочное наследование, и ручной merge по инициативе пользователя.

#### Слой 1: Результаты саб-агента → в основную сессию

**Как сейчас:** результат возвращается через `tool_result`. Родитель видит итоговый ответ, но не видит промежуточных шагов (tool_use, tool_result, reasoning).

```
Родитель:
  tool_use → task({prompt: "исправь auth.ts"})
  tool_result ← "<task id='ses_child' state='completed'>
                   <task_result>Готово, починил в validate.ts:42</task_result>
                 </task>"
```

**Это ок для MVP.** Промежуточные шаги доступны в дочерней сессии при необходимости.

#### Слой 2: Наследование контекста (ветвление)

При запуске саб-агента с `--context inherit` или `--context summary` — создаётся дочерняя сессия:

```
ses_main (родитель)
  ├── msg_1..msg_42 — родительская история
  └── ses_branch (дочерняя, parent_id=ses_main, branch_point=msg_42)
        ├── msg_1..msg_42 — унаследованы (origin=inherited, ссылки на ses_main)
        ├── msg_43 — origin=local, prompt саб-агента
        └── msg_44..50 — origin=local, работа саб-агента
```

**Экономия:** не дублируем содержимое сообщений — храним ссылки на оригинал через `source_msg_id`.

#### Слой 3: Межсессионное слияние (по инициативе пользователя)

**Сценарий:** пользователь провёл анализ в сессии A, хочет передать выводы в сессию B (где коллега ведёт разработку).

Три способа:

**a) Smart paste — копирование сообщений**

```bash
# В сессии A: выбрать сообщения для копирования
synth msg select 4..8
synth msg copy 4..8

# В сессии B: вставить
synth msg paste --after last
synth msg paste --before 3
synth msg paste --summarize    # сжать через LLM перед вставкой
```

Механика: копирует выбранные сообщения в целевую сессию с `origin='merged'`, `source_msg_id=<original>`. `--summarize` прогоняет через быструю модель для компрессии.

**b) Ссылочный блок — вставка без копирования**

```bash
synth ref ses_analysis:4..8   # вставить ссылку на диапазон сессии
```

В сессию B добавляется attachment:

```json
{
  "type": "session_reference",
  "session_id": "ses_analysis",
  "label": "Выводы по auth модулю",
  "range": [4, 8],
  "auto_summary": "Анализ auth модуля. Найден null pointer в validate.ts:42..."
}
```

Модель видит ссылку и может прочитать referenced-сессию через tool call. **Не тратит токены** на вставку больших блоков.

**c) Crosspost — параллельное связывание**

```bash
synth crosspost ses_analysis:4..8 --to ses_dev --label "Выводы по auth"
```

Сообщение существует в обеих сессиях с `origin='crosspost'`. Обновление в одной — видно в другой. Для параллельных веток одного исследования.

**Таблица: операции слияния**

| Операция | Инициатор | Источник → Цель | Что происходит |
|---|---|---|---|
| **subagent result** | Система (авто) | Дочерняя → Родительская | Итог через `tool_result`. Промежуточные шаги НЕ копируются |
| **smart paste** | Пользователь | Любая → Любая | Копирование сообщений с `origin='merged'`. Опционально `--summarize` |
| **reference** | Пользователь | Любая → Любая | Ссылочный блок, модель читает через tool call. Не копирует данные |
| **crosspost** | Пользователь | N ↔ M | Сообщение в нескольких сессиях, синхронизация изменений |

**Реализация merge (smart paste):**

```typescript
async function mergeMessages(
  targetSessionId: SessionID,
  sourceSessionId: SessionID,
  options: {
    sourceRange: [number, number],    // какие seq копировать
    position: 'after' | 'before',
    anchorMsgId?: MessageID,          // после/перед какого сообщения
    summarize?: boolean,              // сжать через LLM
    model?: string,                   // модель для саммаризации
  }
): Promise<MessageID[]> {
  // 1. Прочитать source-сообщения
  // 2. Если summarize — сжать через LLM в одно сообщение
  // 3. Пересчитать seq в target (раздвинуть)
  // 4. Вставить с origin='merged', source_msg_id
}
```

**Порядок реализации:**
1. Базовое хранение: логическая модель сессия + сообщение + часть
2. Ветвление: parent_id + branch_point + наследование через ссылки
3. Subagent result — через tool_result (без изменений)
4. Reference — ссылочные блоки между сессиями
5. Smart paste — копирование сообщений по инициативе пользователя
6. Crosspost — синхронизация между сессиями

### Модель Runner

Раннер — мост между бэкендом и движками. Два режима: локальный (прямой доступ к ФС) и облачный (K8s pod, per-user).

Движки — stateless: история на бэкенде, на вход получают историю + новое сообщение + контекст.

### Отказ от JSON-блока

Механизм JSON-блока (модель возвращает JSON со статусом в конце ответа) не перенесён из прототипа. Причины: хрупкий парсинг, трата токенов, загрязнение промпта. Замена: Tool Use / Function Calling, TSM управляется бэкендом.

---

## Аутентификация

Все запросы к API (кроме `GET /health`) аутентифицированы. 401 для неаутентифицированных.

Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`. Middleware: `requireAuth`, `requirePermission`.

### Режимы

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | Тестовые ключи (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| API Key | backend | Продакшен без OIDC | Один `SYNTH_API_KEY` → роль ADMIN |
| OIDC | backend | Продакшен с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve --api-key` | Один ключ → роль USER |

Auth middleware — первый в цепочке после CORS/logging.

---

## Соглашения по коду

### TypeScript (strict mode)

| Элемент | Стиль | Пример |
|---------|-------|--------|
| Файлы | `kebab-case.ts` | `session-manager.ts` |
| Классы/Интерфейсы/Типы | `PascalCase` | `SessionManager`, `interface SessionStore` |
| Функции | `camelCase` | `getSession()` |
| Константы | `UPPER_SNAKE_CASE` | `MAX_RETRIES = 3` |
| Приватные методы | `_camelCase` | `_internalMethod()` |
| API маршруты | `kebab-case` | `/api/v2/sessions` |

### Порядок импортов

```typescript
// 1. Node.js builtins
import { readFile } from 'node:fs/promises';

// 2. Внешние библиотеки
import { Hono } from 'hono';

// 3. @synth/shared
import { type Session } from '@synth/shared';

// 4. Локальные модули
import { SessionStorage } from '../storage/sessions.js';
```

### Коммиты

```bash
git commit -m "feat: добавлен эндпоинт для списка провайдеров"
git commit -m "fix: исправлена обработка пустых сессий"
git commit -m "refactor: упрощён ChatOrchestrator"
git commit -m "docs: обновлён AGENTS.md"
git commit -m "test: добавлены тесты для SessionStore"
```

### Роутинг задач по агентам

При получении задачи определи её тип и переключись на соответствующего агента
(через Tab или @mention):

| Тип задачи | Агент | Пример промпта |
|---|---|---|
| **Bug fix** | `@fixer` | «Почини баг: при логине с неверным паролем падает 500 вместо 401» |
| **Тестирование / QA** | `@tester` | «Проверь что модуль auth не сломан после изменений», «Прогони smoke-сценарии через Playwright» |
| **Исследование / консультация** | `@researcher` | «Как устроена авторизация?», «Найди все места где используется Redis» |

Эти агенты уже настроены и готовы к работе. Не дублируй их инструкции — просто
передавай задачу.

---

## Порты

| Сервис | Порт | Env var |
|--------|------|---------|
| synth-backend | 5000 | `SYNTH_PORT` |
| synth-ui | 5002 | `VITE_PORT` |
| synth-core | 4300 | `SYNTH_CORE_PORT` |
| synth-runner | 5200 | `SYNTH_RUNNER_PORT` |
| LLM Proxy (runner) | 9090 | — |
| opencode (движок) | 4100 | — |
| cline (движок) | 4200 | — |

---

## Хранилище данных

JSON-файлы вне репозитория. Путь: `SYNTH_DATA_DIR` или `storage.dataDir` в config.yaml.
Дефолт: `/var/synth/data`. В разработке `dev.sh` задаёт свой путь.

Атомарная запись: временный файл `.tmp.{uuid}` → `rename()`.

```
$SYNTH_DATA_DIR/
├── sessions/       projects/       providers/
├── models/         agents/         context/
└── auth/           (sessions, states, profiles)
```

---

## Сборка и публикация

### Скрипты (в корне `/Agent/dev/Synth/`)

| Скрипт | Назначение |
|--------|------------|
| `build.sh` | Полная сборка: shared → core → ui → synth. Опции: `--clean`, `--check`, `--docker`, `--docker-tag=X` |
| `publish.sh` | Публикация в npm. Опции: `--dry-run`, `--no-build`, `--registry=both\|npmjs\|gitverse`, `--docker` |
| `version-bump.sh` | Bump версии: `./version-bump.sh patch\|minor\|major\|X.Y.Z`. Обновляет `version.ts` + все `package.json` |
| `dev.sh` | Dev-запуск: backend (:5000) + UI (:5002). Аргументы: `backend\|ui\|core\|all` |

### Версионирование

Единая константа `SYNTH_VERSION` в `packages/shared/src/version.ts`.
Текущая версия: из `packages/synth/package.json`.

При bump-е версии обновляются:
1. `packages/shared/src/version.ts` — константа `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 6 пакетах

Все hardcoded строки версии в коде заменены на импорт `SYNTH_VERSION` из `@synth/shared`.

### Публикация npm

Публикуемый пакет: `@itphx/synth` (из `packages/synth/`).
Два реестра:
- `https://registry.npmjs.org` — токен `NPM_TOKEN`
- `https://npm.gitverse.ru` — токен `GV_TOKEN` (единый для всего GitVerse)

### Docker

Образ: `registry.gitverse.ru/itphx/synth:<version>` (latest).
Токен: `GV_TOKEN`.

---

## CI/CD (GitVerse)

### Workflow-файлы

| Файл | Назначение | Триггер |
|------|------------|---------|
| `.gitverse/workflows/ci.yaml` | CI: typecheck, lint, тесты | `push`, `pull_request` |
| `.gitverse/workflows/release.yaml` | Релиз: bump, сборка, npm, Docker, Release | `workflow_dispatch`, `push tags v*` |

### Секреты (настроены в репозитории)

| Secret | Назначение |
|--------|------------|
| `NPM_TOKEN` | Публикация в npmjs.org |
| `GV_TOKEN` | Единый токен GitVerse (API, Docker Registry, npm registry, git push от бота) |

**Важно:** префикс `GITVERSE_` запрещён в именах секретов GitVerse. Использовать `GV_`.

### Особенности GitVerse CI

1. **`actions/setup-node@v4`** — не использовать. Вместо этого: `npm install -g pnpm@latest`
2. **`${{ env.VAR }}`** — не работает, резолвится в Go-строку `%!t(string=...)`. Значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает. Выносить сложный bash в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub, в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Версия Node.js в раннере: 22 (предустановлена).

### Порядок сборки в CI

```
pnpm install --frozen-lockfile
pnpm --filter @synth/shared build    # обязательно перед typecheck!
pnpm --filter @synth/core build      # нужно для backend и runner
pnpm typecheck                       # рекурсивно по всем пакетам
pnpm lint
pnpm test
```

Без сборки `shared` и `core` перед `typecheck` — `@synth/runner` и `@synth/backend` не найдут типы.

### Запуск релиза

1. Dry-run: `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. Реальная публикация: `workflow_dispatch` с `dry_run: false`
3. Или вручную: создать тег `vX.Y.Z` и запушить — workflow запустится автоматически

### Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```

---

## GitVerse MCP

### Подключение к opencode

Конфигурация в `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "gitverse": {
    "type": "remote",
    "url": "https://mcp.gitverse.ru",
    "headers": {
      "Authorization": "Bearer <токен>"
    },
    "oauth": false,
    "enabled": true
  }
}
```

**Важно:** `"oauth": false` обязательно для GitVerse MCP (не поддерживает OAuth flow).
Изменения в `opencode.jsonc` требуют перезапуска opencode.

### Токен

Получить: `https://gitverse.ru/settings/tokens`
Права: для read-only достаточно «Чтение», для записи — «Запись».

### Доступные инструменты (37 шт.)

Группы: репозитории, файлы, коммиты, релизы, PR, CI/CD, пользователи, команды, звёзды.
Подробнее: `https://gitverse.ru/docs/ai/mcp/gitverse-mcp-tools`

---

## Документация

| Файл | Назначение |
|------|------------|
| `AGENTS.md` | Архитектурные соглашения (этот файл) |
| `plan.md` | План дальнейших работ |
| `archive/AGENTS_OLD.md` | Архив: deprecated AD, Python/FastAPI стек |
| `SPEC.md` | Спецификация функциональности |
| `rbac-design.md` | Дизайн RBAC |
