# Пайплайны — как устроено сейчас и как будет устроено (Spec)

> **Назначение:** «как устроено сейчас, точно и полно» — формат, поля, семантика (класс **Spec** по
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) (пайплайн как второй движок);
> поставка расширений — в [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md);
> остаток (rollback/exit-стратегия, дашборд, отдельное хранилище артефактов) —
> [PROP-059](./arch_decisions/prop-059-pipeline-automation.md).
>
> **Статус документа:** описывает переходное состояние — часть I «сейчас» соответствует коду
> (ADR-100), часть II «будет» — целевая форма по ADR-101 (реализация по этапам Э1–Э7; план этапов и
> критерии приёмки — в журнале задач `.opencode/tasks/log.md`).

---

## Часть I. Сейчас (ADR-100): декларация + учёт прогона

### 1.1. Что лежит в коде

| Слой | Файл | Что делает |
|---|---|---|
| shared | `packages/shared/src/types/pipeline.ts` | типы и Zod-схемы: `PipelineStepKind` (`agent`/`loop`), `EventMatch`, `PipelineArtifact`, `PipelineStep`, `PipelineErrorPolicy`, `PipelineDefinition`, `PipelineInstanceStatus`, `PipelineStepStatus`, `PipelineStepState`, `PipelineTrigger`, `PipelineInstance` |
| shared | `packages/shared/src/types/events.ts` | `PipelineRef` — ссылка на шаг пайплайна в цели правила маршрутизации |
| shared | `packages/shared/src/types/pack.ts` | `provides.pipelines[]` в манифесте `synth.pack` (ADR-086 §5) |
| core | `packages/core/src/storage/ports/pipeline-repository.ts` | порт `PipelineRepository`: определения (`PipelineDefinitionRecord`) и экземпляры (`PipelineInstanceRecord`) — ADR-096 |
| core | `packages/core/src/storage/file-pipeline-store.ts` | файловая реализация: `{dataDir}/pipelines/definitions.json`, `{dataDir}/pipelines/instances.json` |
| core | `packages/core/src/engine/events/pipeline-tracker.ts` | `PipelineTracker` — учёт экземпляров в funnel'е (ADR-089) |
| core | `packages/core/src/server/routes/pipelines.ts` | `GET /api/v2/pipelines`, `/pipelines/instances`, `/pipelines/:id`, `POST /pipelines/:id/instances` (ручной запуск) |
| core | `packages/core/src/server/routes/packs.ts` | установка пакета: определения пайплайнов + порождённые правила маршрутизации |
| ui | `packages/ui/src/components/settings/AddonsSettings.tsx` | раздел «Аддоны» → «Пайплайны»: определения и прогоны |

HTTP-контракт — [API_V2.md](./API_V2.md) §5.33–§5.34.

### 1.2. Семантика автомата

- **первый** шаг с `waitsFor` — **триггер**: совпавшее событие создаёт экземпляр;
- **последующие** шаги с `waitsFor` — **гейты** (HITL): событие означает «предыдущий шаг завершён и
  подтверждён человеком» — автомат продвигается в существующем экземпляре;
- **артефакт между шагами = payload события** — следующий шаг получает его из `trigger.payload`;
- шаг пайплайна — **обычная агентская сессия**, порождённая существующим funnel'ом (ADR-089).

### 1.3. Ограничения (почему нужен ADR-101)

1. Шаг переводится в `done` **при следующем событии пайплайна**, а не по факту окончания хода: хук
   «ход завершён» живёт в оркестраторе, вне контура funnel.
2. `prompt`/`skill` шага **не доходят до модели** — вход сессии = payload события.
3. Нет переходов (условных рёбер), нет версий спецификации, нет exit-семантики.
4. Пайплайн **не принадлежит проекту**: `projectId` нет, видимость — ADMIN; у прогона нет workspace и
   проектного MCP-скоупа.
5. `onError: 'retry'|'rollback'` и `maxAttempts` объявлены в контракте, но **не исполняются**.
6. `PipelineTracker` — промежуточная реализация; она уходит в замену движку.

---

## Часть II. Будет (ADR-101): Pipeline Engine

### 2.1. Модель исполнения

```
PipelineSpec (pipelineId@version)
        │  trigger: PipelineTrigger
        ▼
   PipelineEngine ──► шаг 1 ──► шаг 2 ──► … ──► exit
        │                │         │
        │                └─ StepResult (output, artifacts, status)
        └─► журнал прогона (append-only) + события pipeline.run.*
```

- **Движок** — `PipelineEngine`, самостоятельный оркестратор рядом с `ChatOrchestrator`.
- **Шаг — не сессия.** Шаг исполняется движком со своей **локальной историей**; сессия может быть
  только **входом** (запуск пайплайна из сессии) или **выходом** (финальный шаг создаёт/продолжает
  сессию).
- **Маппинг входа** — в запрос к LLM попадает не вся история, а только отображённое маппингом:
  выход предыдущего шага (`prev.output.*`), payload триггера (`trigger.payload.*`), явно заданные
  переменные (`vars.*`).

### 2.2. Спецификация (`PipelineSpec`)

JSON/YAML — **источник истины**; IR — собственный, а не формат редактора.

> **Контракт (Э1):** `packages/shared/src/types/pipeline-engine.ts` — Zod-схемы и типы
> (`PipelineSpec`, узлы, условия переходов, `PipelineRunTrigger`, `StepResult`, `PipelineRun`,
> `PipelineRunEvent`) + валидатор графа `validatePipelineSpec` (список проблем строками).
> Имена в коде: узлы — `nodes`, выходы — `exits` (массив), `vars` — карта «имя → путь»
> (`branch: 'trigger.payload.branch'`); тип триггера — `PipelineRunTrigger` (имя
> `PipelineTrigger` занято legacy-контрактом ADR-100 в `types/pipeline.ts`, он заменяется в Э2–Э3).

```yaml
id: pr-pipeline
name: PR Pipeline
version: 3
status: published          # draft | published
mode: act                  # режим пайплайна: plan | act | yolo
projectId: proj_…          # владелец-проект (ADR-014)
io:                        # опционально: JSON Schema на границы входа/выхода
  input: { type: object }
  output: { type: object }
vars:                      # явно заданные переменные для маппинга входа
  branch: trigger.payload.branch
nodes:
  - id: implement
    kind: agent            # agent | script | tool | human
    agent: implementer
    skill: code-review
    prompt: |
      Исправь задачу {{ trigger.payload.issue }}
    input:                # маппинг входа шага
      - prev.output.report
      - trigger.payload.issue
    timeoutSec: 900
    on:                    # условные переходы (структурированный DSL)
      - when: { path: prev.output.status, op: eq, value: ok }
        then: verify
      - when: { path: prev.output.status, op: eq, value: failed }
        then: fix
  - id: verify
    kind: tool
    tool: git_status
  - id: approve
    kind: human
    prompt: Подтверди публикацию
    timeoutSec: 86400
exits:
  - kind: session          # session | file | gateway | none
    session: { agent: reporter }
```

- **`io`** — опционально: объявляется конкретным пайплайном; тогда границы валидируются строго
  (вход/выход — JSON Schema). Без `io` валидация границ нестрогая.
- **`mode`** — режим пайплайна (`plan|act|yolo`), объявляется в спецификации; применяется permission-слой
  (ADR-025/028/029).
- **`on`** — условные переходы; структурированный DSL, **никакого `eval`**.

### 2.3. Вход (`PipelineRunTrigger`)

В коде — `PipelineRunTrigger` (`pipelineRunTriggerSchema`): имя `PipelineTrigger`
занято legacy-контрактом ADR-100 (`types/pipeline.ts`), он заменяется в Э2–Э3.

```ts
interface PipelineRunTrigger {
  kind: 'user' | 'gateway' | 'schedule' | 'tool' | 'webhook' | 'manual';
  source?: string;   // напр. 'ci', 'tg', 'cron'
  type?: string;     // напр. 'release_published'
  payload?: Record<string, unknown>;
  dedupKey?: string; // повторный триггер не создаёт новый прогон
}
```

### 2.4. Выход шага (`StepResult`)

```ts
interface StepResult {
  status: 'ok' | 'failed' | 'skipped' | 'awaiting_human';
  output?: Record<string, unknown>;
  artifacts?: Array<{ kind: string; id?: string; from?: string; payload?: Record<string, unknown> }>;
  error?: { code: string; message: string };
  startedAt?: string; finishedAt?: string; durationMs?: number;
  attempt: number;
}
```

### 2.5. Виды шага

| Вид | Исполнение | Границы |
|---|---|---|
| `agent` | свой Tool-Use-цикл внутри движка; LLM — **только** через `GatewayProvider` (ADR-036) | промпт — через `SystemPromptComposer`/`ContextBuilder` (ADR-070, контракт сужается до минимального «session-like» интерфейса); проектные инструкции — резолвер ADR-069; MCP-скоуп — по проекту (ADR-071) |
| `tool` | через `ToolRegistry` + `executeToolDef` (`engine/tools/tool-execution.ts`) | тот же permission-слой, что у сессий |
| `script` | только через shell-policy (не голой `child_process`) | protected paths и правила `definitions/*.json` действуют |
| `human` | HITL-гейт: прогон **ставится на паузу**, ждёт действия человека; есть таймаут | наблюдателя-сессии нет → действия берутся из ролей проекта/владельца |

### 2.6. Условия переходов

`{ path, op, value }`:

- **path** — `prev.output.x`, `trigger.payload.y`, `vars.z` (точечный путь, без `eval`);
- **op** — `eq | ne | in | exists | gt | lt`;
- **value** — литерал (скаляр/массив); сравнение тип-строгое, при несовпадении типов — условие не
  выполнено (fail-soft, без исключения прогона).

> Полный набор путей и семантика операторов — §2.6.1 (реализовано в Э3,
> `packages/core/src/engine/pipelines/condition.ts`).

### 2.6.1. Условия: пути и операторы

**Путь** — точечная строка, разобранная по `.`; обход объектов и массивов (индекс массива —
целое число). Ни `eval`, ни регулярные выражения: путь — только чтение данных прогона.

| Путь                    | Что означает                                       |
|-------------------------|----------------------------------------------------|
| `prev.output.*`         | Выход предыдущего шага (`StepResult.output`)       |
| `prev.status`           | Статус предыдущего шага (`ok`/`failed`/`skipped`/`awaiting_human`) |
| `prev.error.code`       | Код ошибки предыдущего шага                        |
| `trigger.payload.*`     | Payload триггера прогона (санитизированный)        |
| `trigger.kind` / `trigger.source` / `trigger.type` | Атрибуты триггера                    |
| `vars.*`                | Переменные спецификации (`spec.vars`)               |

Тот же набор путей использует **маппинг входа** шага (`node.input` — пути,
`spec.vars` — «имя → путь»): вход шага = `{ '<путь>': значение, '<имя переменной>': значение }`;
пути, которых нет в данных, в результат **не попадают**.

**Операторы** (сравнение тип-строгое):

| Оператор | Смысл                                                                 |
|----------|------------------------------------------------------------------------|
| `eq`     | Строгое равенство: `1` ≠ `'1'`, `true` ≠ `'true'`                    |
| `ne`     | Отрицание `eq` (по типу)                                             |
| `in`     | Значение пути ∈ массиву-литералу `value`                             |
| `exists` | Путь существует и значение не `undefined`/`null`                     |
| `gt` / `lt` | Числовое сравнение; не-числа ⇒ условие не выполнено              |

**Fail-soft.** Неизвестный путь, отсутствующее значение, несовпадение типов ⇒ условие **не
выполнено** (`false`), без исключения и без падения прогона. В частности, `ne` на отсутствующем
пути — `false` («нет значения» — не «значение отличается»).

### 2.7. Разрешения

- Режим пайплайна (`plan|act|yolo`) объявляется в спецификации и проверяется **permission-слоем**
  (ADR-025/028/029) — не хардкодом в тулах.
- Тулы с `ask`-политикой в пайплайне **эскалируются в human-шаг (HITL)**: наблюдателя-сессии нет, а
  спросить некого → шаг `human` с таймаутом.
- Пайплайн **не обходит** permission-слой: тот же `PermissionEvaluator`, те же правила per-tool и
  per-pattern.

### 2.8. Версии

- Спецификация версионируется: `draft` редактируется, `published` — **неизменяемая** версия.
- Прогон всегда ссылается на конкретную `pipelineId@version`; изменение `draft` не влияет на идущие
  и завершённые прогоны.
- Определения из пакетов расширений (`provides.pipelines[]`) — **шаблоны инстанса**; проект
  инстанцирует шаблон в свой пайплайн (копия → черновик со своими версиями).

### 2.9. Журнал выполнения (append-only)

- **Заголовок прогона** — состояние прогона (статус, текущий шаг, версия спецификации, триггер,
  владелец/проект, тайминги).
- **События прогона** — шаг начался/завершился, переход по ребру, ожидание человека, падение.
- Прецедент в репо: `scheduler/jobs.jsonl`, `webhooks/deliveries.jsonl`, `audit/maintenance.jsonl`.

### 2.10. Выход пайплайна

| Вид | Что делает |
|---|---|
| `session` | создаёт/продолжает сессию (выход шага — её вход) |
| `file` | кладёт артефакт в workspace проекта |
| `gateway` | публикует событие/вызывает webhook наружу (ADR-087/ADR-052) |
| `none` | прогон завершается без внешнего следа |

### 2.11. Проектная привязка и шаблоны

- `projectId` — обязателен для пайплайна проекта; видимость — по владельцу/участникам проекта (те же
  правила, что у сессий проекта; read-уровень не расширяет права на изменение).
- Шаблоны из пакетов — инстансные, **не** принадлежат проекту; инстанцирование — явное действие
  (копия → черновик).

### 2.12. События и метрики

- События — **новые типы** `pipeline.run.*` в существующей шине (ADR-024/ADR-089); новых каналов нет.
- Метрики — реестр ADR-094: `synth_pipeline_*` (прогоны, шаги, длительности, статусы, HITL-ожидания).
- Строки движка — через ключи `shared/i18n` (ADR-041).

### 2.13. Движок: точки расширения

> **Реализовано (Э3):** `packages/core/src/engine/pipelines/` — движок, условия, маппинг,
> планировщик переходов, журнал прогона. Публичный API: `PipelineEngine`
> (`packages/core/src/index.ts`).

**Движок** — `PipelineEngine`, второй оркестратор рядом с `ChatOrchestrator`. Знает только про
порты слоя хранения (ADR-096) и исполнителей шагов — ни HTTP, ни сессий, ни очереди.

Стартовый узел прогона — **первый узел `spec.nodes`**; прогон всегда идёт по опубликованной версии
спецификации (`pipelineId@version`), а в записи прогона лежит её снимок.

```ts
const engine = new PipelineEngine({ pipelines, runs, executors, exits?, logger?, sleep? });

// запуск: берётся опубликованная версия (version? — конкретная, иначе последняя)
const run = await engine.run({ pipelineId, version?, trigger, projectId?, signal? });

// продолжение после HITL-паузы
const resumed = await engine.resume(run.id, { approved: true, output?, comment? });
```

**Исполнители шагов** — контракт `StepExecutor` (`{ kind, execute(ctx) }`); подбираются по виду
узла (`kind`). В Э3 реализаций видов нет (Э4: `agent`/`script`/`tool`); `human` обрабатывает сам
движок (HITL-гейт). Контекст шага — `StepExecutionContext`: `runId`/`pipelineId`/`version`/`node`/
`spec`/`projectId?`/`trigger`/`input`/`vars`/`prev?`/`signal`/`attempt`/`mode`.

**HITL-пауза и возобновление.** Узел `human` → прогон `awaiting_human`, в журнал `gate.awaiting`,
`run()` возвращает управление. `resume(runId, {approved, output?, comment?})`: результат гейта
становится `StepResult` (`ok`/`failed`, отклонение — `pipeline.gate_rejected`), дальше — обычный
цикл; состояние прогона и «текущий узел» восстанавливаются из записи прогона. Таймаут ожидания
человека (`node.timeoutSec`) проверяется **по времени ожидания** — детерминированно и переживает
рестарт процесса (`pipeline.gate_timeout`).

**Точки выхода.** `PipelineExitHandler` (`handle(ctx)`) — точка расширения; по умолчанию no-op
(`NoopPipelineExitHandler`). В Э3 выходы **не исполняются**: движок фиксирует сработавшие выходы
в журнале (`run.finished.exits`) и отдаёт контекст обработчикам; реальные действия (создание
сессии, запись файла, публикация в шлюз) подключаются в Э5 — без переписывания движка.

**Ретраи, таймауты, отмена.** `node.retry.max` (попыток = `1 + max`) и `node.retry.backoffSec`
(пауза между попытками); `node.timeoutSec` — таймаут шага (`pipeline.step_timeout`). `AbortSignal`
останавливает прогон: статус `cancelled`, в журнал `run.failed` с кодом `pipeline.cancelled`.
Исключение исполнителя не выходит наружу: шаг становится `StepResult{status:'failed'}`.

**Правила переходов** (планировщик, `planner.ts`):

1. узел с `on` — переходы проверяются **по порядку**, первый с выполненным условием — победитель;
2. узел без `on` — линейный переход к следующему узлу `spec.nodes`;
3. **провал шага** (`prev.status === 'failed'`) — линейного перехода нет: продолжить прогон после
   ошибки можно только явным переходом по условию; иначе прогон `failed` (`pipeline.step_failed`);
4. перехода нет при успешном шаге — прогон завершается штатно (`done`) и срабатывают выходы;
5. **лимит переходов** на прогон — `MAX_PIPELINE_TRANSITIONS = 100`; при превышении прогон падает с
   `pipeline.loop_limit` (защита от бесконечного цикла в графе).

**Журнал.** События — `run.started`/`node.started`/`node.finished`/`edge.taken`/`gate.awaiting`/
`run.finished`/`run.failed` (append-only, порт `PipelineRunRepository`). Payload и payload триггера
**санитизируются**: ключи, похожие на секреты, вырезаются; ограничены глубина, длина строк и
размер массивов (как в трекере ADR-089). Прогон несёт **снимок спецификации** — он самодостаточен
(удаление пайплайна не делает прогон нечитаемым).

**Коды ошибок движка:** `pipeline.not_found`, `pipeline.not_published`, `pipeline.invalid_spec`,
`pipeline.loop_limit`, `pipeline.cancelled`, `pipeline.executor_missing`, `pipeline.gate_rejected`,
`pipeline.gate_timeout`, `pipeline.step_failed`, `pipeline.step_timeout`, `pipeline.run_not_found`,
`pipeline.invalid_state`.

### 2.14. Что переиспользуется из ядра

`GatewayProvider` (ADR-036) · `PermissionEvaluator` (ADR-025/028/029) · `ToolRegistry` +
`executeToolDef` · `SystemPromptComposer`/`ContextBuilder` (ADR-070) · MCP-скоуп по проекту (ADR-071) ·
резолвер проектных инструкций (ADR-069) · shell-policy/protected paths · i18n-ключи `shared/i18n` ·
реестр метрик (ADR-094) · порты слоя хранилища (ADR-096) · egress/TLS-контур (ADR-099) · шина событий.

---

## Часть III. Границы

| Что | Где |
|---|---|
| Loop Engine (loop'и, верификация, termination guards) | [PROP-057](./arch_decisions/prop-057-loop-engine.md) — вне объёма, не трогаем |
| Rollback/exit-стратегия, мониторинг-дашборд, отдельное хранилище артефактов | [PROP-059](./arch_decisions/prop-059-pipeline-automation.md) — остаётся там |
| Визуальный редактор | `@xyflow/react` (зависимость разрешена владельцем); **IR — `PipelineSpec`**, формат React Flow не является источником истины |
| Plugin SDK, каталог пакетов, trust | [PROP-090](./arch_decisions/prop-090-extension-api.md), [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) |

---

## Связи

- [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) — решение «пайплайн как второй движок».
- [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md) — поставка `synth.pack`, текущая
  реализация «декларация + учёт».
- [ADR-051](./arch_decisions/adr-051-scheduler-pipelines.md) — шедулер как источник запуска (`schedule`).
- [ADR-089](./arch_decisions/adr-089-external-events-automation.md) — события, Router, funnel, журналы.
- [ADR-096](./arch_decisions/adr-096-storage-layer.md) — порты слоя хранилища.
- [ADR-070](./arch_decisions/adr-070-system-prompt-composer.md) — сборка промпта (агентский шаг).
- [ADR-025](./arch_decisions/adr-025-plan-act-toggle.md)/[ADR-028](./arch_decisions/adr-028-plan-build-strictness.md)/[ADR-029](./arch_decisions/adr-029-granular-permissions.md) — разрешения.
- [ADR-094](./arch_decisions/adr-094-observability-metrics.md) — метрики.
- [PROP-059](./arch_decisions/prop-059-pipeline-automation.md) — остаток визионного предложения.
- [PROP-057](./arch_decisions/prop-057-loop-engine.md) — Loop Engine (вне объёма).
- HTTP-контракт — [API_V2.md](./API_V2.md) §5.33–§5.34.
