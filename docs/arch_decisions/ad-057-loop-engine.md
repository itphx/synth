# AD-057: Loop Engine и Loop Design Wizard

> **Статус:** 🧩 Предложение (vision) — Loop Engine и Loop Design Wizard: outer loop, Verification Rubric, LoopRunner, терминация
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D12; черновик 2026-09-16); Roadmap Фаза 1; Obsidian-vault
> `Loop-Engineering-Inner-Outer.md` (READ-ONLY).
> **Связано:** [AD-030](./ad-030-hooks-agent-events.md), [AD-031](./ad-031-verification-agent.md),
> [AD-039](./ad-039-plan-in-project.md), [AD-047](./ad-047-memory-gbrain.md),
> [AD-050](./ad-050-external-engines-runner.md), [AD-051](./ad-051-scheduler-pipelines.md),
> [AD-058](./ad-058-service-agents-council.md), [AD-059](./ad-059-pipeline-automation.md).

**Решение:** inner loop (ReAct) в Synth уже автоматический; AD-057 автоматизирует **outer loop** —
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
реализован в `ChatOrchestrator` ([AD-022](./ad-022-typescript-stack-runner.md)). Outer loop — это
цикл **вокруг** задачи: сформулировать цель, выполнить шаг, проверить результат по рубрике, при
неуспехе повторить с учётом ошибки. Сегодня этот внешний цикл держит человек.

**Почему ручной outer loop плох.** Без явной цели, критериев и лимитов агент либо останавливается
раньше времени, либо зацикливается, либо «самоподтверждает» результат. Loop Engine формализует
цикл: цель → проверяемый критерий → шаг → вердикт → повтор/стоп.

**Связь с планированием.** Инструменты `plan_*`/`todo_*` ([AD-039](./ad-039-plan-in-project.md)) —
база для планирования, но самих управляемых циклов нет.

## Детали

### 1. Loop Design Wizard (`/design-loop`)

Интервью в диалоге, на выходе — спецификация цикла. Ключевой шаг — **фальсифицируемость цели**:
мастер требует цель, для которой можно объективно определить «выполнено/не выполнено».

### 2. Verification Rubric

| Тип | Как проверяется |
|---|---|
| `programmatic` | детерминированно: exit-code, тест, скрипт (`shellCheck`) |
| `judge` | LLM-оценка по рубрике (см. [AD-058](./ad-058-service-agents-council.md), `judge`) |
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
[AD-047](./ad-047-memory-gbrain.md) (память) и метрики ([AD-063](./ad-063-user-learning-metrics.md)).

### 8. Где исполнять шаг

Вариант A — shell напрямую; вариант B — через Runner ([AD-050](./ad-050-external-engines-runner.md)).
Определяется в рамках реализации.

## Статус реализации в коде

**Не реализовано.** Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Каталог `loops/` (40 шаблонов) **отсутствует**; файлов `guardrails.md` / `loop-journal.md` нет.
- Строки `design-loop` / `loop.yaml` / `loop.resolved.json` в коде не встречаются.
- Инструменты `plan_*` / `todo_*` есть ([AD-039](./ad-039-plan-in-project.md), `packages/core/src/engine/tools/plan.ts`,
  `.../todo.ts`) — база планирования, но не движок циклов.
- **Не путать:** `MicroPipeline` (`packages/core/src/engine/router/micro/`) и `tool_call.loop` /
  `tool.doom_loop` — это внутренние механизмы (micro-слой [AD-035](./ad-035-micro-model-first.md) и
  защита от повторных вызовов), не outer-loop.
- Отдельного раннера (Runner, [AD-050](./ad-050-external-engines-runner.md)) нет; если шаг будет
  исполняться через внешний движок, его предстоит реализовать.

## Открытые вопросы

- Формат `loop.yaml` — совместим с Looper (`github/ksimback/looper`)?
- Источник 40 шаблонов (`loops.elorm.xyz`) — лицензия/импорт?
- Где исполнять шаг — shell напрямую или через Runner ([AD-050](./ad-050-external-engines-runner.md))?
- Где хранить `guardrails.md`/`loop-journal.md` (проект/память)?
- Как рубрика `judge` избегает самоподтверждения исполнителем
  ([AD-058](./ad-058-service-agents-council.md))?

## Связи

- [AD-039](./ad-039-plan-in-project.md) «План в проекте, todo в сессии» — инструменты планирования,
  база для циклов.
- [AD-030](./ad-030-hooks-agent-events.md) «Hooks для событий агента» — точки запуска/завершения цикла.
- [AD-031](./ad-031-verification-agent.md) «Verification синт» — verifier/judge как рубрика проверки
  (вливается в [AD-058](./ad-058-service-agents-council.md)).
- [AD-050](./ad-050-external-engines-runner.md) «Внешние движки — Runner» — возможный исполнитель шага.
- [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны» — запуск циклов по расписанию.
- [AD-058](./ad-058-service-agents-council.md) «Служебные агенты и консилиум» — verification/consensus.
- [AD-059](./ad-059-pipeline-automation.md) «Pipeline Automation» — композиция циклов.
- [AD-047](./ad-047-memory-gbrain.md) «Память Synth» — журнал/guardrails/шаблоны.
- [AD-063](./ad-063-user-learning-metrics.md) «Обучение пользователя и метрики» — метрики циклов.
