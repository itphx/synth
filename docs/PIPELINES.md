# Пайплайны — формат и устройство (Spec)

> **Назначение:** «как устроено, точно и полно» — формат, поля, семантика (класс **Spec** по
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) (пайплайн как второй движок);
> поставка расширений — в [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md);
> остаток (rollback/exit-стратегия, дашборд, отдельное хранилище артефактов) —
> [PROP-059](./arch_decisions/prop-059-pipeline-automation.md).
>
> **Статус документа:** часть I — **legacy-контур ADR-100** («декларация + учёт прогона»), он
> остаётся рабочим; часть II — **движок пайплайнов по ADR-101, реализован** (этапы Э1–Э7 закрыты
> 2026-10-21): контракты, порты хранения, движок и виды шагов, журнал и наблюдаемость, выходы,
> HTTP-контур с правами и UI (вкладка «Пайплайны», страницы пайплайна и прогона, визуальный
> редактор). План этапов и критерии приёмки — в журнале задач (`.opencode/tasks/log.md`).

---

## Часть I. Legacy-контур (ADR-100): декларация + учёт прогона

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

Ограничения 1–6 снимает **движок пайплайнов (ADR-101, часть II)**: шаг закрывается по факту хода,
у шага своя локальная история и поля `prompt`/`skill`, есть переходы и версии спецификации,
пайплайн принадлежит проекту, ретраи/таймауты исполняются, а `PipelineTracker` заменён движком.

---

## Часть II. Движок пайплайнов (ADR-101): Pipeline Engine — реализовано (Э1–Э7)

### 2.1. Модель исполнения

```
PipelineSpec (pipelineId@version)
        │  trigger: PipelineRunTrigger
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
> `PipelineTrigger` занято legacy-контрактом ADR-100 в `types/pipeline.ts` — он остаётся в коде:
> legacy-контур §5.34 API работает и показывается в разделе «Аддоны»).

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
занято legacy-контрактом ADR-100 (`types/pipeline.ts`) — legacy-контур остаётся рабочим
(§5.34 API, раздел «Аддоны» в UI), поэтому имена не пересекаются.

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
  artifacts?: Array<{ kind: string; id?: string; from?: string; source?: string; type?: string; payload?: Record<string, unknown> }>;
  error?: { code: string; message: string };
  startedAt?: string; finishedAt?: string; durationMs?: number;
  attempt: number;
}
```

### 2.5. Виды шага

| Вид | Исполнение | Границы |
|---|---|---|
| `agent` | свой Tool-Use-цикл внутри движка; LLM — **только** через `GatewayProvider` (ADR-036) | промпт — через `SystemPromptComposer`/`ContextBuilder` (ADR-070, контракт сужен до минимального «session-like» интерфейса — §2.5.1); проектные инструкции — резолвер ADR-069; MCP-скоуп — по проекту (ADR-071) |
| `tool` | через `ToolRegistry` + `executeToolDef` (`engine/tools/tool-execution.ts`) | тот же permission-слой, что у сессий (§2.7) |
| `script` | только через shell-policy (не голой `child_process`) | protected paths и правила `definitions/*.json` действуют |
| `human` | HITL-гейт: прогон **ставится на паузу**, ждёт действия человека; есть таймаут | наблюдателя-сессии нет → действия берутся из ролей проекта/владельца |

> **Реализовано (Э4.2):** исполнители видов `tool`, `script` и `human` —
> `packages/core/src/engine/pipelines/executors/` (`tool-step.ts`, `script-step.ts`,
> `human-step.ts`). Исполнитель вида `agent` — Э4.3 (реализован, см. ниже).
>
> - `tool` — инструмент берётся из реестра или из контекста шага (§2.5.1), перед
>   вызовом проверяется право (§2.7); результат тула → `StepResult{status:'ok',
>   output:{content, isError, metadata}}`, ошибка тула → `failed`
>   (`pipeline.tool_failed`), инструмент не зарегистрирован →
>   `pipeline.tool_not_found`;
> - `script` — команда (`node.command` + `node.args`, аргументы экранируются)
>   исполняется **только** через shell-тул `execute_shell` с той же
>   permission-проверкой; ненулевой код выхода → `failed`
>   (`pipeline.script_failed`, код выхода в сообщении), stdout/stderr → в `output`;
> - `human` — вопрос оператору (`node.prompt`/`node.title`), прогон встаёт на
>   паузу; **активный таймаут** `node.timeoutSec` — таймер в процессе ядра,
>   по истечении шаг `failed` с `pipeline.gate_timeout` (§2.13).
>
> **Реализовано (Э4.3–Э4.3b):** исполнитель вида `agent` (`agent-step.ts`) —
> свой Tool-Use-цикл внутри движка:
>
> - **цикл**: LLM-вызов (только `GatewayProvider`, ADR-036) → вызовы тулов из
>   ответа → право на каждый вызов (`checkPipelineToolPermission`, тот же
>   permission-слой, §2.7) → `allow` — вызов тула, `deny` — результат-отказ в
>   локальную историю (шаг не валится: модель видит отказ и продолжает), `ask` —
>   пауза-гейт `tool_approval` (§2.7.2) → повторный LLM-вызов — до ответа без
>   вызовов тулов;
> - **результаты тулов** — только в локальную историю шага: ни сессия, ни
>   хранилище (§2.1);
> - **лимит итераций** (`maxIterations` опции исполнителя, по умолчанию 25) →
>   шаг `failed` с `pipeline.agent_iterations`;
> - **выход шага** — `text` + расход токенов + сводка вызовов (имя тула и признак
>   ошибки): полные выводы тулов (объём/секреты) в выход не попадают;
> - **`ask` → гейт → `resume`**: одобрение оператора применяется к тому же
>   вызову (данные гейта восстанавливаются движком из журнала прогона), право на
>   инструмент считается выданным — permission-чек по `ask`-политике не
>   повторяется; отклонение — вызов не исполняется, в историю уходит
>   результат-отказ, цикл продолжается;
> - **отмена** — гонкой с `ctx.signal` (`pipeline.cancelled`).

### 2.5.1. Контекст шага

Шаг пайплайна — **не сессия**, но работает в том же окружении. Контекст шага
собирается **один раз на шаг** и передаётся исполнителю:
`PipelineEngine.buildStepContext(ctx)` → `buildPipelineStepContext`
(`packages/core/src/engine/pipelines/step-context.ts`).

| Часть | Источник | Правило |
|---|---|---|
| Проект | `spec.projectId` / `projectId` прогона → порт проектов (ADR-096) | проекта может не быть — шаг работает без проектного контекста (не ошибка) |
| Рабочий каталог | `project.workspace` (ADR-075) | каталог **не создаётся молча** (provisioning — `engine/workspace-provision.ts`); нет workspace → `workspaceReady: false` |
| Режим | `spec.mode` (`plan`/`act`/`yolo`) | режим permission-слоя (ADR-025), **не** `sessionMode` сессии |
| Инструменты | `ToolRegistry` (встроенные) + MCP-тулы активных серверов | доступность — общий `computeToolAvailability` (ADR-070 §2.9.1): режим, capabilities агента, зависимости окружения, гейт `workspace` |
| MCP-скоуп | система + проект (ADR-071) | без сессионного снапшота — `resolveMcpProjectScope` (`engine/mcp/scope.ts`) |
| Проектные инструкции | резолвер ADR-069 (`engine/context/instructions.ts`) | резолв от имени проекта; без рабочего каталога инструкций нет |
| Каталог скиллов | ADR-046 (`engine/skills/catalog.ts`) | уровень system/project; сессионного слоя нет |
| Агент шага | `node.agent` → `AgentRegistry` | его `capabilities` участвуют в отборе тулов |

**Гейт `workspace` (ADR-075).** Рабочего каталога нет → `workspaceReady: false`,
и file/shell/git-тулы помечаются недоступными с причиной `workspace` — тем же
механизмом, что у сессий (`engine/permission/availability.ts`). Состав
дефинишенов при этом **постоянен** (ADR-070 §2.9): тулы не выбрасываются,
недоступность кодируется причиной (`mode`/`role`/`dependency`/`workspace`).

**Суженный контракт Composer'а (ADR-101 §10).** Промпт агентского шага собирается
тем же `SystemPromptComposer` (ADR-070), но контракт сессии сужен до
`ComposerSessionLike = Pick<Session, 'settings' | 'promptStates' | 'projectId'>`
(`engine/context/composer.ts`): Composer читает только роль агента, язык,
override системного промпта, состояние промпта per-agent и привязку к проекту.
Обычная `Session` остаётся структурно совместимой — совместимость гарантирована
компилятором (`Pick` от реального типа `Session`), а не соглашением.

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

#### 2.7.1. Permission-обёртка пайплайна

> **Реализовано (Э4.2):** `packages/core/src/engine/pipelines/permissions.ts` —
> `checkPipelineToolPermission(check, deps)` → `{action:'allow'|'deny'|'ask', reason?,
> matchedRule?, messageId?, params?}`. Обёртка **не** содержит своих правил: она
> вызывает `PermissionEvaluator.check()` с теми же входными данными, что и
> сессия.

| Параметр permission-слоя | Значение для пайплайна | Почему |
|---|---|---|
| `sessionMode` | `spec.mode` (`plan`/`act`/`yolo`) | режим пайплайна объявляется спецификацией (ADR-025) |
| `planMode` | `auto` | цикла plan→build в пайплайне нет — ветка `strict` (план должен быть утверждён) не срабатывает никогда; режимная рестрикция `plan` (write/edit/git-write запрещены) остаётся включённой |
| `planApproved` | `true` | спецификация опубликована — шаг выполняется в рамках утверждённого плана |
| `workingDir` | рабочий каталог проекта (ADR-075) | тот же, что у сессий проекта |
| `workspaceReady` | `workspaceReady` контекста шага | гейт `workspace` (ADR-075) |
| `shellPolicy` / `protectedPaths` / `runtimeDeps` | из инъектированных зависимостей | те же объекты, что у сессий (`definitions/*.json`, ADR-078/ADR-099) |

> ⚠️ `planMode: 'off'` использовать **нельзя**: в ядре `isPlanRestricted()`
> (ADR-025) трактует `'off'` как «планирование отключено полностью» — режимная
> рестрикция `plan` при этом тоже выключается, и режим пайплайна `plan` перестал бы
> запрещать запись (ADR-025/ADR-070 §2.9.1). Значение `auto` даёт то же отсутствие
> цикла plan→build при сохранённой смысле режима.

Три исхода проверки разведены по разным ветвям движка:

| Исход | Что делает шаг |
|---|---|
| `allow` | инструмент исполняется (для `script` — команда уходит в shell-тул `execute_shell`) |
| `deny` | шаг `failed` с кодом **`permission.denied`** (причина — в сообщении); обхода нет |
| `ask` | **эскалация в гейт**: прогон встаёт на паузу (`awaiting_human`), в журнал пишется `gate.awaiting` с видом `tool_approval` (инструмент, аргументы, причина). Одобрение оператора (`resume({approved:true})`) даёт инструменту право исполняться: узел исполняется заново, но permission-проверка **не** повторяется (право считается выданным) |

#### 2.7.2. Эскалация `ask` → human-гейт

Наблюдателя-сессии у пайплайна нет, поэтому «спросить пользователя» нельзя:
решение `ask` превращается в **гейт** — паузу прогона с данными для оператора.
Механика гейта общая для обоих видов (§2.13):

- `tool_approval` — эскалация `ask`-политики permission-слоя (инструмент, аргументы, причина);
- `human` — вопрос human-шага (`node.prompt`/`node.title`).

Оба вида гейта ставят прогон в `awaiting_human` и ждут `resume()`; отличаются они
только данными для оператора и тем, что именно происходит при одобрении
(для `tool_approval` — повторный вызов инструмента, для `human` — выход гейта).

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

#### 2.9.1. Где хранятся данные гейта

> **Реализовано (Э4.2):** данные гейта живут **в журнале прогона** — событие
> `gate.awaiting` (append-only, порт `PipelineRunRepository.appendEvent`). Контракт
> записи прогона при этом **не меняется** и миграция схемы хранилища не нужна.

Событие `gate.awaiting` несёт payload гейта:

| Поле | Смысл |
|---|---|
| `node` | узел, на котором прогон встал на паузу |
| `kind` | вид гейта: `tool_approval` (эскалация `ask`) или `human` (вопрос human-шага) |
| `toolName`, `args` | инструмент и его аргументы (для `tool_approval`) |
| `question`, `title` | вопрос и заголовок (для `human`) |
| `timeoutSec` | таймаут ожидания оператора |
| `reason` | причина эскалации (решение permission-слоя) |

Payload проходит общую санитизацию журнала (§2.12, инвариант 13): ключи, похожие на
секреты, вырезаются; глубина/длина/размер массивов ограничены. Поэтому журнал —
**аудит** гейта, а не источник аргументов для повторного вызова: при `resume` узел
исполняется заново из спецификации (её снимок лежит в записи прогона), а аргументы
инструмента берутся из `node.toolArgs` прогона.

При `resume` движок читает последнее событие `gate.awaiting` прогона — это и есть
источник «вида гейта» для продолжения.

### 2.10. Выход пайплайна

| Вид | Что делает |
|---|---|
| `session` | создаёт/продолжает сессию (выход шага — её вход) |
| `file` | кладёт артефакт в workspace проекта |
| `gateway` | публикует событие/вызывает webhook наружу (ADR-087/ADR-052) |
| `none` | прогон завершается без внешнего следа |

#### 2.10.1. Реализация выходов (Э5)

> **Реализовано (Э5):** обработчики выходов — `packages/core/src/engine/pipelines/exits.ts`
> (`createPipelineExitHandler`). Подключаются в точке сборки (`server/app/deps.ts` —
> standalone, `backend/app/deps.ts` — managed) через `PipelineEngineDeps.exits`;
> глобальных синглтонов нет.

| Вид | Что именно делается | Ключевые правила |
|---|---|---|
| `session` | новая сессия в проекте прогона (`SessionManager.createSession`) — **владелец — владелец проекта** (ADR-089); результат шага кладётся сообщением (`author: 'Pipeline'`, `metadata.pipeline`); `session.created` публикуется в канал сессии, хабы подписывают владельца (инвариант 18) | `exit.session.sessionId` — **продолжение** существующей сессии (владелец не меняется); агент — `exit.session.agent`, модель — дефолты инстанса (`resolveLlmDefaults`) |
| `file` | артефакт пишется в **workspace проекта** (ADR-075); содержимое — `exit.file.contentFrom` (путь в данных прогона) либо весь выход шага (JSON) | **containment**: путь только **относительный**; абсолютный путь, `..` за пределы workspace и отсутствие workspace — **отказ**; каталоги создаются, файл перезаписывается |
| `gateway` | событие публикуется **наружу** через ingress внешних событий (`EventIngress.ingest`, ADR-089) — источник `pipeline`, тип — `exit.gateway.event` (по умолчанию `pipeline.completed`); payload — **санитизированный** результат шага (секреты вырезаны) | дополнительно событие уходит в **инстансный канал** шины (`pipeline.completed`) — его видят исходящие webhooks (ADR-052) и UI; адресная доставка по `exit.gateway.webhookId` не реализована (подписки срабатывают по типу события) |
| `none` | ничего не делает | — |

**Сбой выхода не роняет прогон.** Ошибка обработчика (например, отказ по containment'у)
ловится движком, пишется в лог **и фиксируется в результате выхода** — в журнале
прогона событие `run.finished` содержит `exits[i].error = {code: 'pipeline.exit_failed',
message}`. Статус прогона при этом остаётся `done`: отказ артефакта — не провал шага.

```ts
// точка сборки (standalone/backend) — обработчик один на все виды выхода
const exits = [
  createPipelineExitHandler({
    sessionManager,   // выход `session`
    projectStore,     // владелец проекта и его workspace
    eventBus,         // `session.created` + инстансный `pipeline.completed`
    ingress,          // выход `gateway` (ADR-089)
    workspacesRoot,   // относительный workspace проекта (ADR-075)
    resolveLlmDefaults,
    resolveOwnerId,             // владелец сессии без проекта
    onSessionMaterialized,      // хабы подписывают владельца (инвариант 18)
  }),
];
```

### 2.11. Проектная привязка и шаблоны

- `projectId` — обязателен для пайплайна проекта; видимость — по владельцу/участникам проекта (те же
  правила, что у сессий проекта; read-уровень не расширяет права на изменение).
- Шаблоны из пакетов — инстансные, **не** принадлежат проекту; инстанцирование — явное действие
  (копия → черновик).

#### 2.11.1. Шаблоны инстанца и конвертация legacy-определений (Э6)

> **Реализовано (Э6):** `packages/core/src/server/routes/pipeline-project-routes.ts` —
> `GET /api/v2/pipeline-templates`, `POST /api/v2/pipeline-templates/:tid/instantiate`;
> конвертация — `legacyDefinitionToPipelineSpec` (тот же модуль, экспортируется из
> `@itphx/synth-core`).

**Источник шаблонов — два места, миграции данных нет:**

1. **legacy-реестр ADR-100** — `{dataDir}/pipelines/definitions.json` (порт `PipelineRepository`):
   определения, которые ставит установщик пакета расширения (`provides.pipelines[]`);
2. **записи `scope:'instance'`** нового порта `ProjectPipelineRepository` — шаблоны в формате
   ADR-101 (спецификация движка).

Список шаблонов объединяет оба источника; в ответе формат помечен полем `format`
(`adr-100`/`adr-101`). **Миграции legacy-определений в шаблоны нет**: конвертация выполняется
**на лету при инстанцировании** — исходное определение остаётся в реестре ADR-100 и продолжает
работать в legacy-контуре (§5.34 API).

**Правила конвертации** (`PipelineDefinition` → `PipelineSpec`):

| Шаг legacy-определения | Результат |
|---|---|
| `kind: 'agent'` | узел `kind: 'agent'`; переносятся `id`, `agent`, `title?`, `skill?`, `prompt?`, `timeoutSec?` |
| `kind: 'loop'` | **не конвертируется** — Loop Engine вне объёма (PROP-057): инстанцирование → `409 PIPELINE_TEMPLATE_UNSUPPORTED` со списком проблем |
| шаг без `agent` | **не конвертируется** — узел `agent` требует агента: та же 409 |
| `waitsFor` | **не переносится**: в ADR-101 триггер задаётся при запуске прогона (`PipelineRunTrigger`), а HITL-гейт выражается узлом `human` — его добавляет владелец пайплайна в черновике |

Прочие поля: имя и описание определения переносятся; режим пайплайна — `act`; выход — `none`
(выходы задаются вручную в черновике); результат конвертации проходит `validatePipelineSpec` —
невалидная спецификация даёт ту же 409 со списком проблем.

**Инстанцирование** — копия спецификации в **черновик** пайплайна проекта (`draftVersion: 1`,
`publishedVersion` не задан); провенанс `installedBy` (пакет и версия) сохраняется.

### 2.12. События и метрики

- События — **новые типы** `pipeline.run.*` в существующей шине (ADR-024/ADR-089); новых каналов нет.
- Метрики — реестр ADR-094: `synth_pipeline_*` (прогоны, шаги, длительности, статусы, HITL-ожидания).
- Строки движка — через ключи `shared/i18n` (ADR-041).

#### 2.12.1. Имена событий (Э5)

> **Реализовано (Э5):** типы — в `packages/shared/src/types/bus-events.ts` (`EventType`);
> публикация — `EventBus.publishInstance` (`packages/core/src/events/bus.ts`), инстансный
> канал `instance`.

| Тип | Когда | Payload |
|---|---|---|
| `pipeline.run.started` | прогон запущен | `runId`, `pipelineId`, `version`, `projectId?`, `triggerKind` |
| `pipeline.run.node_started` | начало попытки узла | `runId`, `pipelineId`, `version`, `projectId?`, `node`, `nodeKind`, `attempt` |
| `pipeline.run.node_finished` | узел завершён (попытка) | те же поля + `status`, `durationMs?`, `errorCode?` (**только код**, не текст ошибки) |
| `pipeline.run.awaiting_human` | прогон встал на ожидание решения | те же поля + `node`, `gateKind` (`human`/`tool_approval`), `timeoutSec?` (вопрос оператора и аргументы инструмента — **в журнале прогона**, не в событии) |
| `pipeline.run.finished` | прогон завершён штатно | те же поля + `status: 'done'`, `exits` (число выходов), `durationMs` |
| `pipeline.run.failed` | прогон провален/отменён | те же поля + `status` (`failed`/`cancelled`), `code`, `node?`, `durationMs` |
| `pipeline.completed` | выход `gateway` — публикация наружу | `source: 'pipeline'`, `type` (из `exit.gateway.event`), санитизированный результат шага |

**В payload событий не попадают**: payload прогона/триггера, секреты, сырые пути и
тексты ошибок — только идентификаторы и технические поля (ADR-094/ADR-101 §2.9).

#### 2.12.2. Имена метрик и лейблы (Э5)

> **Реализовано (Э5):** `packages/core/src/metrics/collectors/pipelines.ts`
> (`createPipelineMetrics`) — колбэки движка.

| Метрика | Тип | Лейблы | Значения лейблов |
|---|---|---|---|
| `synth_pipeline_runs_total` | counter | `status` | `done`/`failed`/`cancelled` |
| `synth_pipeline_runs_started_total` | counter | `source` | `user`/`gateway`/`schedule`/`tool`/`webhook`/`manual` |
| `synth_pipeline_run_duration_seconds` | histogram | `status` | как у `synth_pipeline_runs_total` |
| `synth_pipeline_steps_total` | counter | `kind`, `outcome` | `kind`: `agent`/`script`/`tool`/`human`; `outcome`: `ok`/`failed`/`skipped` |
| `synth_pipeline_step_duration_seconds` | histogram | `kind` | как у `synth_pipeline_steps_total` |
| `synth_pipeline_human_waits_total` | counter | `kind` | `human`/`tool_approval` |
| `synth_pipeline_human_wait_duration_seconds` | histogram | — | — |

**Контракт ADR-094:** в лейблах **нет** id (пайплайна/прогона/узла/сессии) и сырых
путей — значения приводятся к конечным наборам (неизвестное → `other`), поэтому
кардинальность серий ограничена. Идентификаторы прогонов живут только в payload
событий и в журнале прогона.

#### 2.12.3. Канал live-обновлений прогона

> **Ответ на открытый вопрос ADR-101:** отдельный поток **не нужен** — хватает
> существующей шины (ADR-024/ADR-089). Прогон — не сессия, поэтому его события
> публикуются в **инстансный канал** (`EventBus.publishInstance`, канал `instance`):
> per-session подписки их не касаются, а глобальные — видят.

| Режим | Путь доставки |
|---|---|
| standalone | SSE `GET /api/v2/events` (глобальная подписка `subscribeAll`) + WS `/ws/events` (клиент подписывается на инстансный канал) |
| managed (backend) | `EventHub` — watch-all клиенты: `ADMIN`/`LEAD` и service-key (ADR-052); обычный `USER` per-session событий прогонов **не получает** — прогон здесь инстансный админ-ресурс (права определены в Э6: чтение/изменение — по правилам проекта, §2.15) |

Новых транспортных каналов не заводится (инвариант 6): UI подписывается на тот же
`/ws/events`/SSE, что и остальные события.

### 2.13. Движок: точки расширения

> **Реализовано (Э3):** `packages/core/src/engine/pipelines/` — движок, условия, маппинг,
> планировщик переходов, журнал прогона. Публичный API: `PipelineEngine`
> (`packages/core/src/index.ts`).
>
> **Реализовано (Э4.1–Э4.2):** контекст шага (`step-context.ts`), permission-обёртка
> (`permissions.ts`), помощники гейтов (`gate.ts`) и исполнители видов `tool`/`script`/`human`
> (`executors/`). Исполнитель вида `agent` — Э4.3 (реализован).
>
> **Реализовано (Э4.3/Э4.3b):** исполнитель вида `agent` (`executors/agent-step.ts`) —
> свой Tool-Use-цикл внутри движка.
>
> **Реализовано (Э5):** наблюдаемость (метрики `synth_pipeline_*`, события
> `pipeline.run.*` в инстансном канале шины) и реальные обработчики выходов
> (`exits.ts`). Точка сборки движка — `server/app/deps.ts` (standalone) и
> `backend/app/deps.ts` (managed); HTTP-роутов у движка нет — они живут в отдельной
> фабрике `createPipelineProjectRoutes` (§2.15, Э6).

**Движок** — `PipelineEngine`, второй оркестратор рядом с `ChatOrchestrator`. Знает только про
порты слоя хранения (ADR-096) и исполнителей шагов — ни HTTP, ни сессий, ни очереди.

Стартовый узел прогона — **первый узел `spec.nodes`**; прогон всегда идёт по опубликованной версии
спецификации (`pipelineId@version`), а в записи прогона лежит её снимок.

```ts
const engine = new PipelineEngine({ pipelines, runs, executors, exits?, logger?, sleep? });

// запуск: берётся опубликованная версия (version? — конкретная, иначе последняя)
const run = await engine.run({ pipelineId, version?, trigger, projectId?, signal? });

// продолжение после HITL-паузы (с узла паузы)
const resumed = await engine.resume(run.id, { approved: true, output?, comment? });
```

```ts
// исполнители шагов (Э4.2) — регистрируются по виду узла
import {
  createToolStepExecutor,
  createScriptStepExecutor,
  createHumanStepExecutor,
} from '@itphx/synth-core';

const engine = new PipelineEngine({
  pipelines,
  runs,
  executors: [
    createToolStepExecutor({ toolRegistry, permissions: { permissionConfig, shellPolicy } }),
    createScriptStepExecutor({ toolRegistry, permissions: { permissionConfig, shellPolicy } }),
    createHumanStepExecutor(),
  ],
});
```

**Исполнители шагов** — контракт `StepExecutor` (`{ kind, execute(ctx) }`); подбираются по виду
узла (`kind`). Реализованы все четыре вида: `tool`/`script`/`human` (Э4.2) и `agent` (Э4.3,
`executors/agent-step.ts`).
Исполнитель возвращает либо `StepResult`, либо исход-гейт (`StepOutcome`) — паузу с
данными для оператора. Если исполнитель для вида узла не зарегистрирован, а узел —
`human`, гейт обрабатывает сам движок (обратная совместимость с Э3).

Контекст шага — `StepExecutionContext`: `runId`/`pipelineId`/`version`/`node`/`spec`/
`projectId?`/`trigger`/`input`/`vars`/`prev?`/`signal`/`attempt`/`mode` + `step?`
(контекст шага, §2.5.1), `gateDecision?` (решение оператора при повторном
исполнении узла после `resume`) и `onGateTimeout?` (обработчик активного таймаута
гейта).

**Контекст шага** (Э4.1) — `buildPipelineStepContext`
(`packages/core/src/engine/pipelines/step-context.ts`): проект, рабочий каталог, режим пайплайна,
инструменты, MCP-скоуп (система + проект), проектные инструкции, каталог скиллов и агент шага.
Движок отдаёт его исполнителю через `PipelineEngine.buildStepContext(ctx)`. Зависимости —
опциональные поля `PipelineEngineDeps` (`projectStore`, `toolRegistry`, `mcpManager`,
`instructionsResolver`, `agentRegistry`, `skillsCatalog`): те же объекты, что собраны в
`server/app/deps.ts`. Модуль не знает про HTTP/сессии/очередь; отсутствие проекта или рабочего
каталога — не ошибка (контекст без проектной части, file/shell/git-тулы недоступны с причиной
`workspace`). Подробно — §2.5.1.

**Гейт: пауза на любом узле.** Прогон может встать на паузу **на любом узле**: исполнитель
возвращает исход-гейт (`StepGateOutcome` — либо вопрос human-шага `human`, либо эскалация
`ask`-политики `tool_approval`, §2.7.2). Движок сохраняет текущий узел в записи прогона,
пишет в журнал `gate.awaiting` с данными гейта (§2.9.1), ставит статус прогона
`awaiting_human` и **возвращает управление** вызывающему.

> **Реализовано (Э4.2):** исход-гейт — расширение уровня ядра (`StepOutcome` в
> `engine/pipelines/types.ts`); контракт `StepResult` в `@itphx/synth-shared` (ADR-101 §3)
> не менялся.

**Возобновление (`resume`).** `resume(runId, {approved, output?, comment?})` продолжает прогон
**с того узла, на котором он встал на паузу**:

| Решение | Гейт `tool_approval` | Гейт `human` |
|---|---|---|
| `approved: true` | узел исполняется **заново**, но право на инструмент считается **выданным** (permission-проверка не повторяется); цикл продолжается из результата вызова инструмента | результат шага = выход гейта (`output`) + комментарий оператора; цикл продолжается |
| `approved: false` | результат шага = `failed` с кодом **`pipeline.gate_rejected`**; дальше — обычный цикл (переход по условиям, иначе прогон падает) | то же |

Узел при возобновлении исполняется заново с решением оператора в контексте шага
(`ctx.gateDecision`) — это переживает рестарт процесса: состояние прогона, «текущий
узел» и снимок спецификации восстанавливаются из записи прогона, а номер попытки — из
журнала (`node.started`).

**Активный таймаут гейта.** Ожидание оператора ограничено `node.timeoutSec`. Таймер
живёт **в процессе** ядра (`setTimeout` + `unref`, `engine/pipelines/gate.ts`): по истечении
шаг проваливается с кодом **`pipeline.gate_timeout`**, а движок продолжает прогон по
условиям перехода (или завершает его, если перехода нет). Таймер закрытого гейта
игнорируется (проверка по токену гейта) — уже завершённый прогон он не портит.

Дополнительно таймаут ожидания проверяется **по времени ожидания** (при `resume`):
детерминированно и переживает рестарт процесса, когда активного таймера уже нет
(`pipeline.gate_timeout`).

**Коды ошибок гейтов:** `pipeline.gate_rejected` (решение человека — отказ),
`pipeline.gate_timeout` (истекло ожидание), `permission.denied` (отказ permission-слоя).
Коды сохраняются и на уровне прогона — по ним видно, **почему** прогон встал или упал.

**Точки выхода.** `PipelineExitHandler` (`handle(ctx)`) — точка расширения; по умолчанию no-op
(`NoopPipelineExitHandler`). Выходы **исполняются** — подключён реальный обработчик
`createPipelineExitHandler` (`engine/pipelines/exits.ts`): сессия/файл/шлюз/none, с правилами
containment'а файла (ADR-075) и санитизацией наружу (ADR-101 §9, §2.10.1).

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

**Коды ошибок движка** (`PIPELINE_ERROR_CODES`, `engine/pipelines/types.ts`): `pipeline.not_found`,
`pipeline.not_published`, `pipeline.invalid_spec`, `pipeline.loop_limit`, `pipeline.cancelled`,
`pipeline.executor_missing`, `pipeline.gate_rejected`, `pipeline.gate_timeout`, `pipeline.step_failed`,
`pipeline.step_timeout`, `pipeline.run_not_found`, `pipeline.invalid_state`, `pipeline.tool_not_found`,
`pipeline.tool_failed`, `pipeline.script_failed`, `permission.denied`, `pipeline.agent_unavailable`,
`pipeline.provider_not_found`, `pipeline.llm_failed`, `pipeline.llm_unrecoverable`,
`pipeline.agent_iterations`.

### 2.14. Что переиспользуется из ядра

`GatewayProvider` (ADR-036) · `PermissionEvaluator` (ADR-025/028/029) · `ToolRegistry` +
`executeToolDef` · `SystemPromptComposer`/`ContextBuilder` (ADR-070) · MCP-скоуп по проекту (ADR-071) ·
резолвер проектных инструкций (ADR-069) · shell-policy/protected paths · i18n-ключи `shared/i18n` ·
реестр метрик (ADR-094) · порты слоя хранилища (ADR-096) · egress/TLS-контур (ADR-099) · шина событий.

### 2.15. API и права пайплайнов (Э6)

> **Реализовано (Э6):** `packages/core/src/server/routes/pipeline-project-routes.ts`
> (`createPipelineProjectRoutes`) — единая фабрика для core и backend; монтирование —
> `core/src/server/app/mount-routes.ts` и `backend/src/app/mount-routes.ts`. Полный контракт
> (тела, ответы, коды) — [API_V2.md](./API_V2.md) §5.35.

**Три контура:**

| Контур | Пути | Что это |
|---|---|---|
| Пайплайн проекта | `/api/v2/projects/:id/pipelines*` | спецификация (черновик + опубликованные версии) пайплайна проекта |
| Прогон | `/api/v2/pipeline-runs/:runId*` | заголовок прогона + журнал выполнения; HITL-действия (`resume`) и отмена (`cancel`) |
| Шаблон инстанса | `/api/v2/pipeline-templates*` | список шаблонов и инстанцирование в проект |

Пути **не пересекаются** с legacy-контуром ADR-100 (`/api/v2/pipelines*`, §5.34 API) — тот
остаётся рабочим (удаления не планируется); UI переведён на новый контур (Э7), legacy-определения
по-прежнему показываются в разделе «Аддоны».

**Права (ADR-089 §5.5/§5.8, инвариант 21).**

| Действие | Право |
|---|---|
| Чтение пайплайнов и прогонов | право **чтения** проекта: владелец, участник (любая роль, в т.ч. `VIEWER`), `LEAD`, `ADMIN` |
| Изменение (создание, правка, публикация, удаление, запуск, HITL) | право **изменения содержимого** проекта: `OWNER`, `EDITOR`, `LEAD`, `ADMIN` (`VIEWER` не мутирует) |
| Шаблоны инстанса и инстанцирование | **ADMIN** (managed) / `requireAuth` (core, single-user); инстанцирование — плюс право изменения целевого проекта |
| service-key (ADR-052) | мутации — scope `automation:install` (или роль `ADMIN` ключа) + проекция `allowedProjects`; без scope — `403 SCOPE_REQUIRED`, вне проектов — `403 PROJECT_FORBIDDEN`; чтение scope-гейта не имеет |

Проверка доступа — **на границе** (guard, инвариант 16): проект/прогон резолвятся один раз и
кладутся в контекст, в обработчиках проверок нет. Нет проекта → 404; нет прав → 403; чужой
пайплайн под чужим id → 404.

**Жизненный цикл версий.** `PUT` правит черновик (версия не bump'ается) → `POST …/publish`
фиксирует **неизменяемую** опубликованную версию и открывает следующую версию черновика;
повторная публикация без изменений идемпотентна (версии не плодит). Прогон всегда ссылается на
конкретную `pipelineId@version` и несёт её снимок — правка черновика не влияет на идущие прогоны.

**Прогон.** `POST …/runs` отвечает заголовком прогона (`201`) и идёт **в фоне** — прогресс —
по событиям `pipeline.run.*` (§2.12.1) и журналу `GET /api/v2/pipeline-runs/:runId`. `run.error` —
текст ошибки; машиночитаемый код причины — в журнале (`run.failed.payload.code`).

**Хранилище.** Черновики и версии — порт `ProjectPipelineRepository`
(`{dataDir}/pipelines/{pipelines,versions}.json`), прогоны и журнал — `PipelineRunRepository`
(`{dataDir}/pipelines/{runs.json,run-events.jsonl}`); при `storage.backend=postgres` — драйвер
`@itphx/synth-storage-postgres` (PROP-032).

#### UI (Э7)

| Экран | Где | Что делает |
|---|---|---|
| Вкладка «Пайплайны» | `packages/ui/src/components/panels/left-panel/PipelinesTab.tsx` (левая панель, `leftPanel.tab.pipelines`) | дерево «проект → пайплайн» с проектным скоупом (закреплённый блок «Текущий проект» + сворачиваемые «Другие проекты (N)», `useActiveProject`); клик по пайплайну — center-tab `pipeline`, по прогону — `pipeline-run`; кнопки записи скрыты без права изменения содержимого проекта (`VIEWER` читает) |
| Страница пайплайна | `packages/ui/src/components/pipelines/PipelineTab.tsx` (center-tab `pipeline`) | имя/описание, провенанс, черновик и опубликованная версия (read-only — `PipelineSpecView`), действия «Сохранить черновик»/«Опубликовать»/«Запустить прогон»/«Удалить», список прогонов с фильтром по статусу; черновик правится **визуально** или в JSON-режиме |
| Страница прогона | `packages/ui/src/components/pipelines/PipelineRunTab.tsx` (center-tab `pipeline-run`) | заголовок и статус прогона, текущий узел, версия, тайминги, журнал событий, **HITL-действия** «Одобрить»/«Отклонить» (только при `awaiting_human`) и отмена активного прогона |
| Визуальный редактор | `packages/ui/src/components/pipelines/editor/` (`@xyflow/react`) | канвас, палитра узлов `agent`/`script`/`tool`/`human`, инспектор полей по виду узла, редактор условий переходов, добавление/удаление/перестановка узлов, рисование рёбер; переключатель «Визуальный / JSON» и кнопка «Проверить» (`validatePipelineSpec`) — невалидная спецификация на сервер не уходит; **выходы пайплайна правятся в JSON-режиме** |

**IR — `PipelineSpec`**, а не формат React Flow: JSON/YAML — источник истины, редактор — один из
клиентов. Адаптер IR↔граф (`specToFlow`/`flowToSpec`) — чистый модуль без React, round-trip без
потерь. Атрибуция React Flow не скрывается (лицензия).

**Живой прогон** — по событиям `pipeline.run.*` инстансного канала шины (§2.12.3):
`stores/transportStore.ts` разбирает их **до** проверки `sid` (у прогона нет сессии), стор
`stores/pipelinesStore.ts` (`applyRunEvent`) обновляет детали прогона; второй транспорт не
заводим (ADR-024/ADR-089, инвариант 6).

---

## Часть III. Границы

| Что | Где |
|---|---|
| Loop Engine (loop'и, верификация, termination guards) | [PROP-057](./arch_decisions/prop-057-loop-engine.md) — вне объёма, не трогаем |
| Rollback/exit-стратегия, мониторинг-дашборд, отдельное хранилище артефактов | [PROP-059](./arch_decisions/prop-059-pipeline-automation.md) — остаётся там |
| Визуальный редактор | `@xyflow/react` (зависимость разрешена владельцем; **реализован, Э7**); **IR — `PipelineSpec`**, формат React Flow не является источником истины |
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
- HTTP-контракт — [API_V2.md](./API_V2.md) §5.33–§5.35.
