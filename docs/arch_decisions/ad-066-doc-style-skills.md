# AD-066: Скиллы и гайдлайны оформления документации

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D21, «Скиллы и гайдлайны оформления документации»;
> идея пользователя 2026-09-16).
> **Связано:** [AD-046](./ad-046-skills-and-slash-commands.md),
> [AD-068](./ad-068-skills-agents-registry.md),
> [AD-069](./ad-069-project-instructions-agents-md.md),
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-065](./ad-065-ui-docs-plan-todo.md), [AD-067](./ad-067-org-guidelines-defaults.md).

**Решение:** дать Synth **продуктовый механизм стандарта документации**: набор скиллов, шаблонов и
линтеров, задающих структуру и стиль документов (`README`, `docs/`, ADR, `CHANGELOG`, комментарии),
которые агент применяет при создании/обновлении доков, плюс автоматическая проверка соответствия
(docs-lint) в цикле.

## Контекст

Документация в проектах разъезжается: кто-то пишет ADR, кто-то README без структуры, формат
`CHANGELOG` у всех свой. Инженерный ответ — перенести «как писать доки» из головы в **скиллы и
шаблоны**, а соответствие проверять автоматически.

### Что уже есть

- **Механизм скиллов** — [AD-046](./ad-046-skills-and-slash-commands.md) (формат `SKILL.md`,
  discovery, progressive disclosure, core-тул `skill`, слэш-команды/bundles, scope-API,
  trust-гейт). Реализованы Фазы 1–3 (core+API+CLI, UI; см. корневой `AGENTS.md`).
- **Реестр и каталог** — [AD-068](./ad-068-skills-agents-registry.md) (индекс, trust/guard,
  install-policy, agent-packs) — спроектирован, в коде нет.
- **Проектные инструкции** — [AD-069](./ad-069-project-instructions-agents-md.md): `AGENTS.md`/`/init`,
  discovery/merge, threat-scan, `GET /api/v2/context/instructions`, событие
  `context.instructions_loaded`, скилл `synth-agents-md`. Реализовано (Ф1–Ф3).
- **Dev-скиллы проекта** — `.opencode/skills/*` (в т. ч. `synth-docs`, `synth-agents-md`): это
  локальные скиллы раннера, а не продуктовый механизм доставки стандарта.
- **`AGENTS.md`** — де-факто гайдлайн оформления и архитектурных соглашений.
- **Общая конфигурация** — [AD-023](./ad-023-configuration.md) (`@itphx/synth-shared/config`).
- **Permissions** — [AD-029](./ad-029-granular-permissions.md) (какие скиллы/инструменты доступны).

### Чего нет

- Отдельного механизма **doc-скиллов** (продуктовых) нет.
- **Линтеров документации** (`docs-lint`/`doc-lint`/`docGuidelines`) нет (grep — 0 вхождений).
- Шаблонов документов и автоматической проверки соответствия в цикле — нет.

## Детали

### 1. Формат doc-guidelines

Единое описание стандарта (структура, стиль, обязательные разделы) для типов документов:
- ADR/AD (контекст → решение → детали → статус → связи);
- `README` (назначение → установка → использование → ссылки);
- `CHANGELOG` (формат, разделы);
- комментарии/`AGENTS.md`.

Стандарт оформляется как **скилл** (формат [AD-046](./ad-046-skills-and-slash-commands.md)), чтобы
агент грузил его по триггеру «пишу/правлю документацию».

### 2. Скиллы оформления

Скиллы вида `docs-writing` / `adr-writing` / `readme-writing` — инструкции + примеры + антипаттерны.
Не дублировать `synth-agents-md` (он про `AGENTS.md`), а дополнять.

### 3. Шаблоны документов

Заготовки (front-matter/структура) для новых AD/README/CHANGELOG, из которых агент генерирует
документ. Могут лежать как supporting-файлы скилла ([AD-046](./ad-046-skills-and-slash-commands.md),
прогрессивное раскрытие).

### 4. Авто-проверка (docs-lint)

Проверка соответствия прямо в цикле агента: обязательные разделы, битые относительные ссылки, стиль,
запрещённые конструкции. Режим — **обязательно или предупреждение** (открытый вопрос). Возможные
точки:
- отдельный тул/скилл, вызываемый агентом;
- хук (когда появится [AD-030](./ad-030-hooks-agent-events.md)) на запись docs-файлов;
- проверка в pipeline ([AD-059](./ad-059-pipeline-automation.md)) / `pre-commit`.

### 5. Где хранить

- **Instance** (глобальный стандарт организации) — связка с [AD-067](./ad-067-org-guidelines-defaults.md);
- **Project** (правила конкретного репозитория) — [AD-069](./ad-069-project-instructions-agents-md.md);
- приоритет наследования — instance → project.

## Статус реализации в коде

**Не реализовано (в объёме AD).** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- Идентификаторы `docs-lint`/`doc-lint`/`docGuidelines`/`doc-guidelines` — 0 вхождений.
- Механизм скиллов есть ([AD-046](./ad-046-skills-and-slash-commands.md), `packages/core/src/engine/skills/*`,
  `server/routes/skill-scope.ts`), но продуктовых doc-скиллов в поставке нет.
- `.opencode/skills/synth-docs/SKILL.md` и `synth-agents-md` — dev-скиллы проекта (не продуктовый
  стандарт).
- `packages/ui/src/components/chat/MarkdownContent.tsx` — рендер (не линтер).
- Отдельного docs-lint-механизма и шаблонов документов нет.

## Открытые вопросы

- Где хранить стандарт (instance / project / оба)? Как наследуется?
- Проверки обязательны или предупреждения?
- Связь с памятью/шаблонами ([AD-047](./ad-047-memory-gbrain.md), [AD-068](./ad-068-skills-agents-registry.md))?
- Как не дублировать `synth-docs`/`synth-agents-md` (dev-скиллы) и продуктовый каталог?
- Линтер — отдельный тул, хук ([AD-030](./ad-030-hooks-agent-events.md)) или шаг pipeline
  ([AD-059](./ad-059-pipeline-automation.md))?
- Формализовать ли машинно-проверяемую часть (схема front-matter)?

## Связи

- [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм доставки
  doc-гайдлайнов (формат `SKILL.md`, тул `skill`).
- [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог скиллов и агентов» — публикация и
  trust doc-скиллов, install-policy.
- [AD-069](./ad-069-project-instructions-agents-md.md) «Проектные инструкции (AGENTS.md)» — проектный
  уровень правил.
- [AD-023](./ad-023-configuration.md) «Конфигурация» — где включается стандарт/линтер.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — гейтинг doc-скиллов.
- [AD-065](./ad-065-ui-docs-plan-todo.md) «Просмотр документации… в UI» — viewer как потребитель
  отрендеренной документации.
- [AD-067](./ad-067-org-guidelines-defaults.md) «Орг-гайдлайны → дефолты инстанса» — источник
  организационных стандартов.
- [AD-030](./ad-030-hooks-agent-events.md) «Hooks» — возможная точка авто-проверки.
- [AD-047](./ad-047-memory-gbrain.md) «Память Synth» — поиск по документации/шаблонам.
