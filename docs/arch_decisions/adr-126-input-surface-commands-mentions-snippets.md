# ADR-126: Поверхность ввода — команды, `@`-упоминания, `$`-скиллы и `#`-сниппеты

> **Статус:** ⚠️ Частично — команды `/compact`, `/review`, `$`/`#`/`@` и подсветка ввода реализованы; остаток по командам — в §«Остаток».
> **Дата:** 2026-11-14
> **Источник:** PROP-126 (файл удалён после принятия).
> **Связано:** [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-115](./adr-115-multimodal-input.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-024](./adr-024-eventhub-transport.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-104](./adr-104-mid-turn-steering.md), [ADR-118](./adr-118-message-stream-v2.md), [ADR-119](./adr-119-context-compaction.md), [PROP-057](./prop-057-loop-engine.md), [PROP-132](./prop-132-ui-terminal.md), [PROP-068](./prop-068-skills-agents-registry.md)

## Контекст

В opencode/openchamber поверхность ввода состоит из `/`-команд, `@`-упоминаний, `$`-скиллов,
`#`-сниппетов и `!`-shell. В Synth был только `/`-реестр (`builtin`/`template`/`skill`/`bundle`) и
`@agent` с регуляркой `@(\w+)`, которая уже конфликтовала с `@src/index.ts` и email. Сниппетов не
было; `$` не было; `!` не было. Копировать TUI-навигацию в web-`/` нельзя — это элементы UI и
транспортных шлюзов, а не промпт-команды.

## Решение

1. **`/` — только контентные команды.** Добавлены `/compact` (компактизация, ADR-119) и `/review`
   (ревью изменений кода; без аргумента — незакоммиченные изменения, аргумент — commit/branch/PR).
   `/summary` остаётся суммаризацией; `/init` — prompt-командой. TUI-команды (`/new`, `/undo`,
   `/redo`, `/sessions`, `/models`, `/connect`) **не переносятся**: это UI-контролы/API, для
   мессенджеров — отдельный слой транспортных команд.
2. **`@` — файлы, агенты, пользователи.** Единый лексер в core (`engine/input-surface/parser.ts`),
   структурированное поле `mentions` в `POST /sessions/:id/prompt`, `Message.mentions`.
   - `@file` — текст внутри workspace (≤5 МиБ), блок `<file path>`; бинарь/вне периметра → 400.
   - `@user` — первое упоминание делит сообщение: до — агенту, от — user-directed сообщение
     (`metadata.userDirected`) без хода + `message.mentioned`; контекстный фильтр по `ord`/`seq`/`createdAt`.
   - `@agent` — прежняя сегментация; UI-пикер показывает агентов/пользователей/файлы.
3. **`$` — скиллы.** `$name` в тексте обычного сообщения (не `/`-шаблона: `$ARGUMENTS` не токен),
   резолв тем же путём, что `/skill-name`; тело `<skill_content>` в user-сообщение, `skill.invoked`.
4. **`#` — сниппеты, три уровня.** `instance` / `project` / `user`; приоритет `user > project > instance`;
   канон важнее алиаса. Хранение — **файлы markdown**: `{dataDir}/snippets`,
   `{project.workspace}/.synth/snippets`, `{dataDir}/snippets/users/<userId>`. Проектные сниппеты —
   **всегда `project.workspace`**, не worktree сессии: это уровень проекта, а не ветки. Раскрытие — в
   `POST /prompt` до очереди; лимиты 15/64 КБ, без рекурсии, code-блоки не трогаются. Trust — по
   каталогу источника (как у проектных скиллов/команд); недоверенный project-сниппет виден, но не
   раскрывается.
5. **`!` — shell.** Отложен в [PROP-132](./prop-132-ui-terminal.md): нужен терминальный
   контур, permission-слой и PTY; обходить `execute_shell` нельзя.
6. **Goal — не команда.** Это outer loop [PROP-057](./prop-057-loop-engine.md); UI целится туда, а не
   в реестр `/`.

## Последствия

- (+) Единый вход ввода для UI/CLI/гибрида; `@` больше не ломается на путях/email; сниппеты
  переиспользуют текстовые фрагменты; проектный контент защищён trust-гейтом.
- (−) Три уровня сниппетов и trust требуют понимания; worktree-сессии читают проектные сниппеты из
  корня проекта (осознанно).
- Вне объёма: `!` shell, транспортные команды мессенджеров, `/compact`-кнопка (slash работает).

## Остаток по командам

| Что | Состояние |
|---|---|
| `!` shell-режим | Не реализован; ждёт [PROP-132](./prop-132-ui-terminal.md) (терминал, permission/ask, PTY) |
| `/review` | Prompt-команда реализована; жёсткого `available:false` при отсутствии git/diff **нет** — гейт на стороне модели (промпт честно говорит «ревью недоступно») |
| `/compact` | Slash-команда реализована; отдельной UI-кнопки нет (UI вызывает `/summarize`-маршрут без `mode`) |
| TUI-команды | `/new`, `/undo`, `/redo`, `/sessions`, `/models`, `/connect` намеренно не перенесены; для шлюзов — отдельный слой |

## Статус в коде

- Команды: `engine/commands/{builtin,service}.ts`, `orchestrator.ts`, `POST /sessions/:id/summarize`
  (`mode`), `POST /sessions/:id/prompt`.
- Ввод: `engine/input-surface/{parser,user-mentions,file-mentions}.ts`; UI
  `components/chat/{CommandAutocomplete,SkillAutocomplete,SnippetAutocomplete,MentionPopup,composerHighlight}.tsx`.
- Сниппеты: `engine/snippets/*`, `server/routes/snippets.ts`, редакторы `SnippetsSettings`,
  `SnippetsAdminSettings`, `SnippetScopeEditor`; проектные — `ProjectTab`.
- Хранение сообщений: `Message.mentions` (file-store + PostgreSQL-миграция `036_message_mentions`).

## История

- 2026-11-14 — принято из PROP-126; реализованы команды, `@`/`$`/`#`, подсветка; `!` — остаток PROP-132.
