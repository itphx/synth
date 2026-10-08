# AD-067: «Впитывание» организационных гайдлайнов → дефолты инстанса

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D22, «Впитывание организационных гайдлайнов → дефолты
> инстанса»; идея пользователя 2026-09-16).
> **Связано:** [AD-046](./ad-046-skills-and-slash-commands.md),
> [AD-068](./ad-068-skills-agents-registry.md),
> [AD-069](./ad-069-project-instructions-agents-md.md),
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-066](./ad-066-doc-style-skills.md), [AD-047](./ad-047-memory-gbrain.md).

**Решение:** механизм **импорта существующих в организации гайдлайнов** (документы, репозитории
правил, code style, security policy) и применения их как **дефолтных на уровне инстанса** — так,
чтобы они действовали во **всех проектах и сессиях** (в отличие от проект-локальных `AGENTS.md`).
С **версионированием**, **scope** (`instance / org / team / project`) и **аудитом изменений**.

## Контекст

В организациях уже есть правила: Confluence-страницы, репозиторий `code-style`, security policy,
гайдлайны ревью. Сейчас Synth видит только то, что лежит в конкретном проекте, и каждая новая
сессия не знает общих правил компании.

Идея: один раз «впитать» (ingest) организационные источники и превратить их в **дефолты инстанса**,
которые наследуются всеми проектами и сессиями и переопределяются проектом при необходимости.

### Что уже есть

- **Контекст-файлы** — `packages/core/src/engine/context/config.ts`: категории `user | role | system`
  (`CATEGORY_DIRS: { user: 'user', role: 'roles', system: 'system' }`), `userPromptsDir` —
  `{dataDir}/user`, `userRolesDir` — `{dataDir}/roles`; instance-файлы `_enabledFiles =
  ['SOUL.md', 'COMPANY.md', 'ABOUT.md']` (`config.ts:64`), проектный `info.md` (`builder.ts`).
- **Проектные инструкции** — [AD-069](./ad-069-project-instructions-agents-md.md): discovery/merge
  `AGENTS.md`, `/init`, threat-scan, `GET /api/v2/context/instructions`,
  `context.instructions_loaded`, скилл `synth-agents-md`. **Реализовано (Ф1–Ф3).**
- **Механизм скиллов** — [AD-046](./ad-046-skills-and-slash-commands.md) (доставка инструкций,
  scope system/project/session, `skill-scope.ts`).
- **Реестр/каталог** — [AD-068](./ad-068-skills-agents-registry.md) (trust/guard/установка) — в коде нет.
- **Конфигурация** — [AD-023](./ad-023-configuration.md) — где хранить дефолты.
- **Permissions** — [AD-029](./ad-029-granular-permissions.md) — гейтинг применения и правки.

### Чего нет

- **Ingestion** организационных гайдлайнов — нет.
- **Каталога гайдлайнов** с приоритетами/наследованием scope — нет.
- **Версионирования/аудита** изменений правил — нет.
- Применения правил **по умолчанию** ко всем проектам — нет.

## Детали

### 1. Ingestion

Разбор источников → нормализованные правила:
- документы (Confluence/файлы/URL),
- репозитории правил (git),
- code style / security policy.

Для «впитывания» больших текстов — опора на память/индексы
([AD-047](./ad-047-memory-gbrain.md), RAG). Результат — структурированные правила, а не «свалить
весь документ в промпт».

### 2. Каталог гайдлайнов и scope

Иерархия `instance / org / team / project` с приоритетом (конкретнее — выше):
`project` переопределяет `team`, `team` — `org`, `org` — `instance`. Каталог — источник,
версия, владелец, область применения.

Согласовать с точками вставки контекста ([AD-070](./ad-070-system-prompt-composer.md)) и с
проектными инструкциями [AD-069](./ad-069-project-instructions-agents-md.md) — не дублировать,
наследовать.

### 3. Дефолты инстанса

Правила применяются ко всем новым (и, по политике, существующим) проектам/сессиям. Формат доставки:
скилл ([AD-046](./ad-046-skills-and-slash-commands.md)), контекст-файл категории `user/system`
(`config.ts`), либо секция конфига ([AD-023](./ad-023-configuration.md)).

### 4. Версионирование и аудит

Каждое изменение набора правил — версия + кто/когда/что. Смыкается с аудитом
([AD-036](./ad-036-llm-gateway.md)) и реестром [AD-068](./ad-068-skills-agents-registry.md) (провенанс).

### 5. Гейтинг

Какие правила включать, кто ADMIN и как подтверждает — через permissions
([AD-029](./ad-029-granular-permissions.md)). Конфликт с project-правилами решается приоритетом
scope (см. п. 2).

### 6. Обновление при изменении источника

При изменении источника (документ/репозиторий) — пересинхронизация (вручную/по расписанию,
[D-шедулер](./ad-051-scheduler-pipelines.md)) с диффом и подтверждением.

## Статус реализации в коде

**Не реализовано (в объёме AD).** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- Контекст-файлы и категории есть: `packages/core/src/engine/context/config.ts` (`CATEGORY_DIRS`,
  `userPromptsDir` `{dataDir}/user`, `userRolesDir` `{dataDir}/roles`, `_enabledFiles =
  ['SOUL.md','COMPANY.md','ABOUT.md']`), `builder.ts` (проектный `info.md`).
- Проектные инструкции реализованы: `engine/context/instructions.ts`,
  `engine/context/lazy-instructions.ts`, секция `instructions` в
  `packages/shared/src/config/types.ts`, `GET /api/v2/context/instructions`, событие
  `context.instructions_loaded`, скилл `synth-agents-md` ([AD-069](./ad-069-project-instructions-agents-md.md)).
- Механизм скиллов/scope есть ([AD-046](./ad-046-skills-and-slash-commands.md),
  `server/routes/skill-scope.ts`).
- **Ingestion организационных гайдлайнов, каталог гайдлайнов, версионирование/аудит правил,
  применение как instance-дефолтов — отсутствуют.**

## Открытые вопросы

- Источники: Confluence / Git / файлы / URL? Форматы?
- Кто ADMIN и как подтверждает «впитывание»?
- Конфликты с project-правилами ([AD-069](./ad-069-project-instructions-agents-md.md)) — приоритет и
  разрешение?
- Как обновлять при изменении источника (пул/вебхук/расписание)?
- Где хранить правила: контекст-файлы, скиллы или секция конфига?
- Как «впитывание» соотносится с памятью/RAG ([AD-047](./ad-047-memory-gbrain.md)) — правила как
  индексируемый корпус?
- Приватность/утечки в гибриде ([AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md))?

## Связи

- [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм доставки правил.
- [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог» — trust/guard/провенанс для
  установки наборов правил.
- [AD-069](./ad-069-project-instructions-agents-md.md) «Проектные инструкции (AGENTS.md)» — проектный
  уровень; instance-дефолты наследуются и переопределяются.
- [AD-023](./ad-023-configuration.md) «Конфигурация» — хранение дефолтов.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — гейтинг правки/применения.
- [AD-066](./ad-066-doc-style-skills.md) «Скиллы и гайдлайны оформления документации» — частный случай
  орг-гайдлайнов (стандарт доков).
- [AD-047](./ad-047-memory-gbrain.md) «Память Synth» — ingestion/индексация источников.
- [AD-070](./ad-070-system-prompt-composer.md) «SystemPromptComposer» — точка вставки правил в промпт.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — аудит изменений.
- [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны» — пересинхронизация источников.
