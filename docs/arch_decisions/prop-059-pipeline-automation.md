# PROP-059: Pipeline Automation

> **Статус:** 🧩 Предложение (vision) — Pipeline Automation: цепочки loops, артефакты между шагами, rollback, HITL, мониторинг
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D14; черновик 2026-09-16); Roadmap Фаза 1; доклад
> Яндекс Браузера (обоснование).
> **Связано:** [ADR-030](./adr-030-hooks-agent-events.md), [ADR-051](./adr-051-scheduler-pipelines.md),
> [PROP-057](./prop-057-loop-engine.md), [PROP-058](./prop-058-service-agents-council.md),
> [PROP-063](./prop-063-user-learning-metrics.md), [ADR-089](./adr-089-external-events-automation.md).

**Решение:** композиция Loops ([PROP-057](./prop-057-loop-engine.md)) в **сквозные пайплайны** — цепочки
`[loop1 → loop2 → loop3]`, описанные в YAML/JSON, с передачей артефактов между шагами, стратегией
выхода и rollback на уровне цепочки, точками human-in-the-loop (HITL) и мониторинг-дашбордом.

Примеры пайплайнов: PR Pipeline, CI Recovery, merge-conflict, security release, cleanup sprint.

**Обоснование (доклад Яндекс Браузера):** ускорение только кодинга даёт +20–30% производительности;
реальный рост — в автоматизации **целых инженерных пайплайнов** (от задачи до релиза), а не отдельных
шагов написания кода.

## Контекст

- **Loop vs Pipeline.** Loop ([PROP-057](./prop-057-loop-engine.md)) — самодостаточный цикл («шаг →
  проверка → повтор») для одной цели. Pipeline — это цепочка Loops, где результат одного шага
  становится входом следующего.
- **Запуск.** Пайплайны могут запускаться вручную, по расписанию (шедулер,
  [ADR-051](./adr-051-scheduler-pipelines.md)) или по внешним событиям
  ([ADR-089](./adr-089-external-events-automation.md)).
- **Верификация.** Каждый шаг может иметь рубрику/гейт, в т.ч. через консилиум
  ([PROP-058](./prop-058-service-agents-council.md)).
- Компонентов Pipeline в Synth нет; зависит от Loop Engine (PROP-057) и шедулера (ADR-051).

## Детали

### 1. Схема пайплайна

Декларативное описание цепочки шагов (YAML/JSON): последовательность Loops, условия перехода,
точки HITL, стратегия при ошибке. Формат — общий с `loop.yaml`
([PROP-057](./prop-057-loop-engine.md)) или расширяющий его (открытый вопрос).

```yaml
pipeline:
  name: pr-pipeline
  steps:
    - loop: implement
    - loop: verify      # верификация (PROP-058)
      onFail: implement # возврат к предыдущему шагу
    - loop: cleanup
  onError: rollback
  hitl: [publish]
```

### 2. Pipeline Runner

Оркестратор цепочки: последовательно запускает Loops, передаёт **контекст и артефакты** между
шагами, применяет гейты и HITL-паузы, фиксирует статус каждого шага.

### 3. Контекст и артефакты между шагами

Результат шага (изменения в файлах, отчёты, вердикты) должен быть доступен следующим шагам.
Требуется явное хранилище артефактов (где — открытый вопрос).

### 4. Exit-стратегия и rollback

На уровне цепочки: что делать при провале шага — остановиться, откатиться, повторить, перейти к
альтернативной ветке. Rollback для необратимых шагов (push/deploy) — особая семантика
(компенсирующие действия, а не откат).

### 5. Human-in-the-loop

Точки обязательного подтверждения человеком перед необратимыми/опасными шагами (merge, publish,
deploy). Согласуется с HITL в [PROP-061](./prop-061-llm-security-layers.md).

### 6. Мониторинг-дашборд

Отображение статуса пайплайнов/шагов, истории прогонов, метрик
([PROP-063](./prop-063-user-learning-metrics.md)).

### 7. Интеграция запуска

- Вручную (CLI/UI).
- По расписанию — [ADR-051](./adr-051-scheduler-pipelines.md).
- По внешним событиям — [ADR-089](./adr-089-external-events-automation.md).
- События жизненного цикла — hooks ([ADR-030](./adr-030-hooks-agent-events.md)).

## Статус реализации в коде

**Не реализовано.** Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Компонентов Pipeline (схема, Runner, артефакты между шагами, rollback, HITL, дашборд) в Synth нет.
- В коде есть только `MicroPipeline` (`packages/core/src/engine/router/micro/`) — это micro-слой
  ([ADR-035](./adr-035-micro-model-first.md)), **не** инженерные пайплайны. Других совпадений на
  `pipeline` вне тестов нет.
- Шедулер отсутствует ([ADR-051](./adr-051-scheduler-pipelines.md)); Loop Engine отсутствует
  ([PROP-057](./prop-057-loop-engine.md)).
- В UI есть заглушка вкладки «Шедулер» (`packages/ui/src/components/panels/RightPanel.tsx`,
  `rightPanel.scheduler.placeholder`), пайплайнов нет.

## Открытые вопросы

- Формат описания пайплайна — общий с `loop.yaml` ([PROP-057](./prop-057-loop-engine.md))?
- Rollback-семантика для необратимых шагов (push/deploy)?
- Где хранить артефакты между шагами?
- Кто и как определяет точки HITL — автор пайплайна или политика инстанса?
- Как пайплайны соотносятся с внешним роутером событий
  ([ADR-089](./adr-089-external-events-automation.md)) и шедулером
  ([ADR-051](./adr-051-scheduler-pipelines.md)) — один оркестратор или слои?

## Связи

- [PROP-057](./prop-057-loop-engine.md) «Loop Engine» — строительные блоки пайплайна (Loops).
- [ADR-051](./adr-051-scheduler-pipelines.md) «Шедулер и пайплайны» — запуск по расписанию; тесно
  связанный слой (граница между расписанием и композицией шагов).
- [ADR-089](./adr-089-external-events-automation.md) «Внешние события и автоматизация» — запуск по
  событиям (роутер).
- [PROP-058](./prop-058-service-agents-council.md) «Служебные агенты и консилиум» — верификация на шагах.
- [ADR-030](./adr-030-hooks-agent-events.md) «Hooks для событий агента» — события жизненного цикла.
- [PROP-061](./prop-061-llm-security-layers.md) «Многослойная безопасность LLM» — HITL перед опасными
  действиями.
- [PROP-063](./prop-063-user-learning-metrics.md) «Обучение пользователя и метрики» — метрики пайплайнов.
