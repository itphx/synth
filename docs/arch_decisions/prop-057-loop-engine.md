# PROP-057: Loop Engine и Loop Design Wizard

> **Статус:** 🧩 Предложение (vision) — Loop Engine и Loop Design Wizard: outer loop, Verification Rubric, LoopRunner, терминация
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D12; черновик 2026-09-16); Roadmap Фаза 1; Obsidian-vault
> `Loop-Engineering-Inner-Outer.md` (READ-ONLY).
> **Связано:** [ADR-030](./adr-030-hooks-agent-events.md), [PROP-031](./prop-031-verification-agent.md),
> [ADR-039](./adr-039-plan-in-project.md), [PROP-047](./prop-047-memory-gbrain.md),
> [PROP-050](./prop-050-external-engines-runner.md), [ADR-051](./adr-051-scheduler-pipelines.md),
> [PROP-058](./prop-058-service-agents-council.md), [ADR-100](./adr-100-extension-packs-pipelines.md).

**Решение:** inner loop (ReAct) в Synth уже автоматический; PROP-057 автоматизирует **outer loop** —
управляемый цикл «шаг → проверка → повтор» вокруг работы агента.

Компоненты:

- **`/design-loop`** — интерактивный мастер (Loop Design Wizard): интервью по цепочке
  «цель → контекст → модель → верификация → гейты» с **критикой цели на фальсифицируемость** (цель,
  которую нельзя опровергнуть, не годится для цикла).
- **Verification Rubric** — критерии проверки результата: `programmatic` / `judge` / `human`.
- **Генерация артефактов цикла:** `loop.yaml` (человекочитаемый) + `loop.resolved.json` (машинный).
- **LoopRunner** — исполнение шага (`shellCheck` → `exitCondition` → повтор).
- **Каталог из 40 шаблонов Loops.**
- **Termination Guards** — ограничители завершения: `max iterations`, `revision caps`,
  `no-progress detection`, `budget caps`.
- **Обучение** — накопление результатов: `guardrails.md`, `loop-journal.md`.

## Контекст

**Inner vs outer loop.** Inner loop — это ReAct-цикл самого агента (LLM → tool → LLM …), он уже
реализован в `ChatOrchestrator` ([ADR-022](./adr-022-typescript-stack-runner.md)). Outer loop — это
цикл **вокруг** задачи: сформулировать цель, выполнить шаг, проверить результат по рубрике, при
неуспехе повторить с учётом ошибки. Сегодня этот внешний цикл держит человек.

**Почему ручной outer loop плох.** Без явной цели, критериев и лимитов агент либо останавливается
раньше времени, либо зацикливается, либо «самоподтверждает» результат. Loop Engine формализует
цикл: цель → проверяемый критерий → шаг → вердикт → повтор/стоп.

**Связь с планированием.** Инструменты `plan_*`/`todo_*` ([ADR-039](./adr-039-plan-in-project.md)) —
база для планирования, но самих управляемых циклов нет.

## Детали

### 1. Loop Design Wizard (`/design-loop`)

Интервью в диалоге, на выходе — спецификация цикла. Ключевой шаг — **фальсифицируемость цели**:
мастер требует цель, для которой можно объективно определить «выполнено/не выполнено».

### 2. Verification Rubric

| Тип | Как проверяется |
|---|---|
| `programmatic` | детерминированно: exit-code, тест, скрипт (`shellCheck`) |
| `judge` | LLM-оценка по рубрике (см. [PROP-058](./prop-058-service-agents-council.md), `judge`) |
| `human` | человек подтверждает (human-in-the-loop) |

### 3. Артефакты цикла

- `loop.yaml` — человекочитаемое описание (цель, шаги, рубрика, гейты).
- `loop.resolved.json` — машинное, развёрнутое представление для LoopRunner.

### 4. LoopRunner

Исполнение шага и проверка условия выхода:

```
шаг → shellCheck → exitCondition?
                    ├─ satisfied  → завершение
                    └─ not        → повтор (с учётом результата)
```

### 5. Каталог 40 шаблонов

Библиотека готовых Loops (аналог каталога скиллов/агентов). Источник-референс —
`loops.elorm.xyz` (лицензия/импорт — открытый вопрос).

### 6. Termination Guards

Обязательные ограничители, чтобы цикл не был бесконечным и не сжигал бюджет:
`max iterations`, `revision caps`, `no-progress detection`, `budget caps`.

### 7. Обучение

`guardrails.md` — накопленные ограничения/уроки; `loop-journal.md` — журнал прогонов. Потребитель —
[PROP-047](./prop-047-memory-gbrain.md) (память) и метрики ([PROP-063](./prop-063-user-learning-metrics.md)).

### 8. Где исполнять шаг

Вариант A — shell напрямую; вариант B — через Runner ([PROP-050](./prop-050-external-engines-runner.md)).
Определяется в рамках реализации.

## Статус реализации в коде

**Не реализовано.** Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Каталог `loops/` (40 шаблонов) **отсутствует**; файлов `guardrails.md` / `loop-journal.md` нет.
- Строки `design-loop` / `loop.yaml` / `loop.resolved.json` в коде не встречаются.
- Инструменты `plan_*` / `todo_*` есть ([ADR-039](./adr-039-plan-in-project.md), `packages/core/src/engine/tools/plan.ts`,
  `.../todo.ts`) — база планирования, но не движок циклов.
- **Не путать:** `MicroPipeline` (`packages/core/src/engine/router/micro/`) и `tool_call.loop` /
  `tool.doom_loop` — это внутренние механизмы (micro-слой [ADR-035](./adr-035-micro-model-first.md) и
  защита от повторных вызовов), не outer-loop.
- Отдельного раннера (Runner, [PROP-050](./prop-050-external-engines-runner.md)) нет; если шаг будет
  исполняться через внешний движок, его предстоит реализовать.

## Открытые вопросы

- Формат `loop.yaml` — совместим с Looper (`github/ksimback/looper`)?
- Источник 40 шаблонов (`loops.elorm.xyz`) — лицензия/импорт?
- Где исполнять шаг — shell напрямую или через Runner ([PROP-050](./prop-050-external-engines-runner.md))?
- Где хранить `guardrails.md`/`loop-journal.md` (проект/память)?
- Как рубрика `judge` избегает самоподтверждения исполнителем
  ([PROP-058](./prop-058-service-agents-council.md))?

## Связи

- [ADR-039](./adr-039-plan-in-project.md) «План в проекте, todo в сессии» — инструменты планирования,
  база для циклов.
- [ADR-030](./adr-030-hooks-agent-events.md) «Hooks для событий агента» — точки запуска/завершения цикла.
- [PROP-031](./prop-031-verification-agent.md) «Verification синт» — verifier/judge как рубрика проверки
  (вливается в [PROP-058](./prop-058-service-agents-council.md)).
- [PROP-050](./prop-050-external-engines-runner.md) «Внешние движки — Runner» — возможный исполнитель шага.
- [ADR-051](./adr-051-scheduler-pipelines.md) «Шедулер и пайплайны» — запуск циклов по расписанию.
- [PROP-058](./prop-058-service-agents-council.md) «Служебные агенты и консилиум» — verification/consensus.
- [ADR-101](./adr-101-pipeline-engine.md) «Pipeline Automation» — композиция циклов.
- [PROP-047](./prop-047-memory-gbrain.md) «Память Synth» — журнал/guardrails/шаблоны.
- [PROP-063](./prop-063-user-learning-metrics.md) «Обучение пользователя и метрики» — метрики циклов.
