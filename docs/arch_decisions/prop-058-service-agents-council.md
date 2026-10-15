# PROP-058: Служебные агенты и консилиум (Council)

> **Статус:** 🧩 Предложение (vision) — Служебные агенты и консилиум (Council): panel/consensus/debate/verifier/judge, Council Gate
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D13; черновик 2026-09-16); Roadmap + Obsidian-vault
> `Loop-Engineering-Inner-Outer.md`, `Заметки/Harness Engineering.md` (READ-ONLY). **Включает
> PROP-031** «Verification синт».
> **Связано:** [ADR-026](./adr-026-subagent-context-modes.md), [ADR-029](./adr-029-granular-permissions.md),
> [ADR-030](./adr-030-hooks-agent-events.md), [PROP-031](./prop-031-verification-agent.md),
> [ADR-034](./adr-034-model-routing.md), [PROP-057](./prop-057-loop-engine.md),
> [PROP-059](./prop-059-pipeline-automation.md), [ADR-084](./adr-084-decision-models-clef.md).

**Решение:** расширить набор служебных агентов Synth до полноценного **консилиума** и ввести
**Council Gate** — кросс-модельную/кросс-агентную верификацию.

Новые роли:

- **`general`** — универсальный служебный агент (уже есть).
- **`analyst`** — аналитик.
- **`panel`** — N агентов, запускаемых **параллельно**.
- **`consensus`** — поиск консенсуса, противоречий и слепых зон между ответами panel.
- **`debate`** — несколько раундов обсуждения между агентами.
- **`verifier`** — кросс-валидация результата (read-only, адверсальные пробы,
  `VERDICT: PASS/FAIL/PARTIAL`).
- **`judge`** — оценка результата по рубрике.
- **Council Gate** — кросс-модельная верификация (одна модель проверяет другую).

**PROP-031 «Verification синт» вливается сюда** как частный случай: агент `verifier` (read-only,
адверсальные пробы) + `judge` (оценка по рубрике). Отдельным PROP-031 не реализуется — закрывается в
рамках PROP-058.

## Контекст

- Служебные агенты уже существуют: `general`, `explore` и др. (`packages/core/src/engine/agents/definitions/`),
  запуск субагента — инструментом `task` (`packages/core/src/engine/tools/task.ts`).
- `task` запускает **одного** субагента за вызов; `panel`/`consensus`/`debate` требуют
  **оркестрации нескольких** агентов (параллельно/по раундам).
- PROP-031 (verifier) не реализован; существующий `qa`-агент — не верификатор.
- Кросс-модельность опирается на routing ([ADR-034](./adr-034-model-routing.md)) и decision-модели
  ([ADR-084](./adr-084-decision-models-clef.md)).
- Контекст субагента — режимы `none`/`inherit`/`summary`/`last_n` ([ADR-026](./adr-026-subagent-context-modes.md)).

**Зачем консилиум:** одиночный LLM склонен к самоподтверждению. Несколько независимых агентов
(и/или моделей) + явный поиск противоречий + оценка по рубрике повышают надёжность. Верификатор
обязан **отличаться** от исполнителя, иначе проверка фиктивна.

## Детали

### 1. Роли

| Агент | Назначение | Особенности |
|---|---|---|
| `general` | универсальный служебный | уже есть |
| `analyst` | анализ, декомпозиция | уже есть определение `analyst.json` |
| `panel` | N агентов параллельно | мульти-провайдер, стоимость |
| `consensus` | консенсус/противоречия/слепые зоны | сведение мнений panel |
| `debate` | несколько раундов | регламент раундов, арбитр |
| `verifier` | кросс-валидация, адверсальные пробы | read-only, `VERDICT` |
| `judge` | оценка по рубрике | отдельная модель по умолчанию |

### 2. Council Gate

Кросс-модельная верификация: результат, полученный моделью A, проверяется моделью B (другой
вендор/класс). Результат — вердикт и/или оценка. Встраивается в гейты циклов
([PROP-057](./prop-057-loop-engine.md)) и пайплайнов ([PROP-059](./prop-059-pipeline-automation.md)).

### 3. Интеграция с PROP-031 (verifier)

Поведение `verifier` (из PROP-031):

- запуск хуком `plan_approved` или вручную;
- **read-only** (edit → deny; запись только во временный каталог);
- проверяет билд, тесты, линтеры, typecheck;
- адверсальные пробы: граничные значения, конкурентность, идемпотентность;
- вердикт `VERDICT: PASS | FAIL | PARTIAL`.

Автозапуск опирается на систему хуков ([ADR-030](./adr-030-hooks-agent-events.md)).

### 4. Разделение ответственности

- `verifier` ≠ исполнитель (гарантия «второй пары глаз»).
- `judge` — отдельная модель по умолчанию (кросс-вендор), чтобы не судить своей же моделью.
- Права консилиума — через permission-слой
  ([ADR-029](./adr-029-granular-permissions.md)); `verifier` — read-only.

## Статус реализации в коде

**Не реализовано.** Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Определения агентов: `admin`, `analyst`, `assistant`, `auditor`, `developer`, `devops`, `explore`,
  `general`, `pm`, `qa`, `title` (`packages/core/src/engine/agents/definitions/`).
  (Черновик упоминал только `general`/`explore` — фактически ролей больше; **`analyst` уже есть**.)
- Инструмент `task` существует (`packages/core/src/engine/tools/task.ts`), но запускает одного
  субагента; `panel`/`consensus`/`debate`/`judge`/`verifier` и Council Gate в коде отсутствуют
  (grep по этим идентификаторам по `packages/core/src/engine/` пуст).
- PROP-031 не реализован (см. [PROP-031](./prop-031-verification-agent.md)); `qa` — не verifier.
- Автозапуск через hook `plan_approved` невозможен — система хуков не реализована
  ([ADR-030](./adr-030-hooks-agent-events.md)).

## Открытые вопросы

- Параллельные модели (`panel`) — мульти-провайдер и стоимость?
- `judge` — отдельная модель по умолчанию (кросс-вендор)?
- Как гарантировать, что `verifier` ≠ исполнитель (разные агенты/модели/контекст)?
- Как `consensus` агрегирует мнения (голосование, ранжирование, RRF)?
- Сколько раундов `debate` и кто арбитр?
- Как консилиум вписывается в лимиты токенов/бюджета
  ([PROP-061](./prop-061-llm-security-layers.md))?

## Связи

- [PROP-031](./prop-031-verification-agent.md) «Verification синт» — вливается в PROP-058 как `verifier`/`judge`.
- [ADR-030](./adr-030-hooks-agent-events.md) «Hooks для событий агента» — `agent_spawned`/`agent_completed`/
  `plan_approved` для запуска консилиума.
- [ADR-026](./adr-026-subagent-context-modes.md) «Режимы контекста саб-агента» — изоляция контекста
  участников консилиума.
- [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — read-only для verifier.
- [ADR-034](./adr-034-model-routing.md), [ADR-084](./adr-084-decision-models-clef.md) — выбор моделей для
  panel/judge/consensus.
- [PROP-057](./prop-057-loop-engine.md) «Loop Engine» — рубрика `judge` в цикле, интеграция с гейтами.
- [PROP-059](./prop-059-pipeline-automation.md) «Pipeline Automation» — верификация на шагах пайплайна.
- [PROP-061](./prop-061-llm-security-layers.md) «Многослойная безопасность LLM» — лимиты и HITL.
