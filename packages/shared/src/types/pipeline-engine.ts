/**
 * ADR-101 (Pipeline Engine): контракты пайплайна как **второго движка**.
 *
 * Формат и устройство — [docs/PIPELINES.md](../../../../docs/PIPELINES.md)
 * (Spec, часть II) и сам ADR-101. Здесь только типы и zod-схемы
 * (browser-safe, без `node:*`): исполнение пайплайнов (движок, виды шагов,
 * журнал, порты хранилища) — в core (этапы Э2–Э5).
 *
 * Модуль **не заменяет** контракты ADR-100 (`types/pipeline.ts`): они
 * объявляют пайплайн как «декларация + учёт прогона» и уходят в Э2–Э3,
 * поэтому имена новых схем не пересекаются с legacy (`pipelineSpec*`/
 * `pipelineRun*`).
 */
import { z } from 'zod';

import { pipelineArtifactSchema } from './pipeline.js';

// --- Режимы и виды ---

/**
 * Режим пайплайна (`plan`/`act`/`yolo`) — объявляется спецификацией и
 * применяется permission-слоем (ADR-025/ADR-028/ADR-029), не хардкодом в
 * тулах.
 */
export const PIPELINE_MODES = ['plan', 'act', 'yolo'] as const;
export const pipelineModeSchema = z.enum(PIPELINE_MODES);
export type PipelineMode = z.infer<typeof pipelineModeSchema>;

/**
 * Вид узла пайплайна:
 * - `agent` — свой Tool-Use-цикл внутри движка (LLM — только через
 *   `GatewayProvider`, ADR-036);
 * - `script` — только через shell-policy (не голой `child_process`);
 * - `tool` — через `ToolRegistry` + `executeToolDef`;
 * - `human` — HITL-гейт: прогон встаёт на паузу и ждёт действия человека.
 */
export const pipelineNodeKindSchema = z.enum(['agent', 'script', 'tool', 'human']);
export type PipelineNodeKind = z.infer<typeof pipelineNodeKindSchema>;

/**
 * Вид выхода пайплайна: `session` (создать/продолжить сессию), `file`
 * (артефакт в workspace проекта), `gateway` (событие/webhook наружу),
 * `none` (прогон завершается без внешнего следа).
 */
export const pipelineExitKindSchema = z.enum(['session', 'file', 'gateway', 'none']);
export type PipelineExitKind = z.infer<typeof pipelineExitKindSchema>;

/**
 * Оператор условия перехода — **структурированный DSL, никакого `eval`**:
 * `eq`/`ne` — равенство/неравенство, `in` — вхождение в массив, `exists` —
 * наличие значения по пути, `gt`/`lt` — сравнение чисел.
 */
export const pipelineConditionOpSchema = z.enum(['eq', 'ne', 'in', 'exists', 'gt', 'lt']);
export type PipelineConditionOp = z.infer<typeof pipelineConditionOpSchema>;

// --- Границы входа/выхода (JSON Schema) ---

/**
 * Минимальный тип JSON Schema — полноценного JSON Schema-типа в репозитории
 * нет, а пайплайну нужен лишь «скелет» схемы границы (`type`/`properties`/
 * `required`) плюс произвольные ключи спецификации JSON Schema.
 */
export type JsonSchemaLike = {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  [key: string]: unknown;
};

/** Схема границы пайплайна (JSON Schema в урезанном виде). */
export const jsonSchemaLikeSchema: z.ZodType<JsonSchemaLike> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      properties: z.record(z.string(), jsonSchemaLikeSchema).optional(),
      required: z.array(z.string()).optional(),
    })
    .passthrough(),
);

// --- Условия и переходы ---

/** Скалярное значение условия (литерал, без вложенных объектов). */
const pipelineConditionScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Значение условия — скаляр или массив скаляров (литерал; произвольные
 * объекты в условии не допускаются).
 */
const pipelineConditionValueSchema = z.union([
  pipelineConditionScalarSchema,
  z.array(pipelineConditionScalarSchema),
]);

/**
 * Условие перехода `{ path, op, value }`.
 *
 * `path` — точечный путь к данным прогона: `prev.output.x` (выход
 * предыдущего узла), `trigger.payload.y` (payload триггера), `vars.z`
 * (переменная спецификации). Сравнение тип-строгое: при несовпадении типов
 * условие не выполнено (fail-soft, без исключения прогона).
 */
export const pipelineConditionSchema = z.object({
  /** Путь к значению (`prev.output.x` / `trigger.payload.y` / `vars.z`). */
  path: z.string().min(1),
  /** Оператор сравнения. */
  op: pipelineConditionOpSchema,
  /** Литерал сравнения (не нужен для `exists`). */
  value: pipelineConditionValueSchema.optional(),
});
export type PipelineCondition = z.infer<typeof pipelineConditionSchema>;

/**
 * Условный переход из узла: при выполнении условия `when` прогон идёт в узел
 * `then`.
 */
export const pipelineSpecEdgeSchema = z.object({
  /** Условие перехода. */
  when: pipelineConditionSchema,
  /** Идентификатор узла-цели (должен существовать в спецификации). */
  then: z.string().min(1),
});
export type PipelineTransition = z.infer<typeof pipelineSpecEdgeSchema>;

// --- Узел ---

/**
 * Узел пайплайна (шаг графа).
 *
 * Вход узла задаётся **маппингом** (`input`): в запрос к LLM попадает не
 * вся история, а только отображённое маппингом — выход предыдущего узла
 * (`prev.output.*`), payload триггера (`trigger.payload.*`) и явно заданные
 * переменные (`vars.*`).
 */
export const pipelineSpecNodeSchema = z.object({
  /** Идентификатор узла (уникален в пределах спецификации). */
  id: z.string().min(1),
  /** Вид узла (исполнение и границы — по виду). */
  kind: pipelineNodeKindSchema,
  /** Человекочитаемое название узла. */
  title: z.string().optional(),
  /** Агент, исполняющий узел (для вида `agent`). */
  agent: z.string().optional(),
  /** Скилл, используемый узлом. */
  skill: z.string().optional(),
  /** Промпт/задание для узла. */
  prompt: z.string().optional(),
  /** Инструмент узла (для вида `tool`). */
  tool: z.string().optional(),
  /** Аргументы инструмента. */
  toolArgs: z.record(z.string(), z.unknown()).optional(),
  /** Команда узла (для вида `script`; исполняется только через shell-policy). */
  command: z.string().optional(),
  /** Аргументы команды. */
  args: z.array(z.string()).optional(),
  /** Маппинг входа узла — пути (`prev.output.report`, `trigger.payload.issue`). */
  input: z.array(z.string().min(1)).optional(),
  /** Таймаут узла в секундах (для `human` — время ожидания человека). */
  timeoutSec: z.number().int().positive().optional(),
  /** Политика повторов узла. */
  retry: z
    .object({
      /** Максимум повторов (0 — без повторов). */
      max: z.number().int().min(0),
      /** Пауза перед повтором в секундах. */
      backoffSec: z.number().int().positive().optional(),
    })
    .optional(),
  /** Условные переходы из узла. */
  on: z.array(pipelineSpecEdgeSchema).optional(),
});
export type PipelineNode = z.infer<typeof pipelineSpecNodeSchema>;

// --- Выход пайплайна ---

/**
 * Выход пайплайна — что движок делает по завершении прогона.
 *
 * Требования к полям по виду (`session` — `agent` или `sessionId`; `file` —
 * `path`; `gateway` — `event` или `webhookId`) проверяет
 * `validatePipelineSpec`: схема описывает **форму**, валидатор — **смысл**.
 */
export const pipelineExitSchema = z.object({
  /** Вид выхода. */
  kind: pipelineExitKindSchema,
  /** Выход в сессию (создать/продолжить). */
  session: z
    .object({
      /** Агент, которому передаётся результат. */
      agent: z.string().optional(),
      /** Существующая сессия, которую нужно продолжить. */
      sessionId: z.string().optional(),
    })
    .optional(),
  /** Выход в файл (артефакт в workspace проекта). */
  file: z
    .object({
      /** Путь файла в workspace проекта. */
      path: z.string().optional(),
      /** Путь к содержимому (`prev.output.report` и т.п.). */
      contentFrom: z.string().optional(),
    })
    .optional(),
  /** Выход наружу (событие/webhook — ADR-087/ADR-052). */
  gateway: z
    .object({
      /** Тип публикуемого события. */
      event: z.string().optional(),
      /** Идентификатор подписки (webhook). */
      webhookId: z.string().optional(),
      /** Путь к payload публикации. */
      payloadFrom: z.string().optional(),
    })
    .optional(),
});
export type PipelineExit = z.infer<typeof pipelineExitSchema>;

// --- Спецификация ---

/**
 * Спецификация пайплайна (`pipelineId@version`) — источник истины в
 * JSON/YAML; формат — [docs/PIPELINES.md](../../../../docs/PIPELINES.md)
 * §2.2, решение — ADR-101.
 *
 * Инварианты версионирования (ADR-101 §7): `draft` редактируется,
 * `published` — неизменяемая версия; прогон всегда ссылается на конкретную
 * `pipelineId@version`.
 */
export const pipelineSpecSchema = z.object({
  /** Идентификатор пайплайна. */
  id: z.string().min(1),
  /** Человекочитаемое имя. */
  name: z.string().min(1),
  /** Краткое описание. */
  description: z.string().optional(),
  /** Версия спецификации (целое ≥ 1). */
  version: z.number().int().min(1),
  /** Статус версии: `draft` редактируется, `published` — неизменяемая. */
  status: z.enum(['draft', 'published']),
  /** Режим пайплайна (применяется permission-слоем). */
  mode: pipelineModeSchema,
  /** Владелец-проект (ADR-014); шаблоны из пакетов — инстансные. */
  projectId: z.string().optional(),
  /** Границы входа/выхода (JSON Schema); без `io` границы нестрогие. */
  io: z
    .object({
      /** Схема входа. */
      input: jsonSchemaLikeSchema.optional(),
      /** Схема выхода. */
      output: jsonSchemaLikeSchema.optional(),
    })
    .optional(),
  /**
   * Явно заданные переменные для маппинга входа: имя → путь к значению
   * (напр. `branch: 'trigger.payload.branch'`).
   */
  vars: z.record(z.string(), z.string()).optional(),
  /** Узлы графа; минимум один. */
  nodes: z.array(pipelineSpecNodeSchema).min(1, 'пайплайн: нужен хотя бы один узел'),
  /** Выходы пайплайна; минимум один. */
  exits: z.array(pipelineExitSchema).min(1, 'пайплайн: нужен хотя бы один выход'),
});
export type PipelineSpec = z.infer<typeof pipelineSpecSchema>;

// --- Вход прогона ---

/**
 * Вход прогона — единый триггер пайплайна (ADR-101 §3).
 *
 * Имя `PipelineRunTrigger` (а не `PipelineTrigger`): имя `PipelineTrigger`
 * уже занято legacy-контрактом ADR-100 в `types/pipeline.ts` (его
 * заменяет этот контракт в Э2–Э3, но до тех пор переименование ломало бы
 * существующих потребителей).
 */
export const pipelineRunTriggerSchema = z.object({
  /** Вид запуска. */
  kind: z.enum(['user', 'gateway', 'schedule', 'tool', 'webhook', 'manual']),
  /** Источник (напр. `ci`, `tg`, `cron`). */
  source: z.string().optional(),
  /** Тип события (напр. `release_published`). */
  type: z.string().optional(),
  /** Данные запуска (вход маппинга `trigger.payload.*`). */
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Ключ дедупликации: повторный триггер не создаёт новый прогон. */
  dedupKey: z.string().optional(),
});
export type PipelineRunTrigger = z.infer<typeof pipelineRunTriggerSchema>;

// --- Выход узла ---

/**
 * Результат исполнения узла — единый выход шага (ADR-101 §3).
 */
export const pipelineStepResultSchema = z.object({
  /** Итог узла. */
  status: z.enum(['ok', 'failed', 'skipped', 'awaiting_human']),
  /** Выход узла (источник `prev.output.*` для следующего узла). */
  output: z.record(z.string(), z.unknown()).optional(),
  /** Произведённые артефакты (контракт артефакта — ADR-100, `types/pipeline.ts`). */
  artifacts: z.array(pipelineArtifactSchema).optional(),
  /** Ошибка узла. */
  error: z
    .object({
      /** Машиночитаемый код ошибки. */
      code: z.string().min(1),
      /** Текст ошибки. */
      message: z.string().min(1),
    })
    .optional(),
  /** ISO-время старта узла. */
  startedAt: z.string().optional(),
  /** ISO-время завершения узла. */
  finishedAt: z.string().optional(),
  /** Длительность узла в миллисекундах. */
  durationMs: z.number().int().min(0).optional(),
  /** Номер попытки (нумерация с 1). */
  attempt: z.number().int().min(1),
});
export type StepResult = z.infer<typeof pipelineStepResultSchema>;

// --- Прогон ---

/** Статус прогона. */
export const pipelineRunStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_human',
  'done',
  'failed',
  'cancelled',
]);
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;

/**
 * Прогон пайплайна — заголовок журнала (ADR-101 §8, журнал append-only).
 *
 * Прогон всегда ссылается на конкретную версию спецификации
 * (`pipelineId@version`): изменение черновика не влияет на идущие и
 * завершённые прогоны.
 */
export const pipelineRunSchema = z.object({
  /** Идентификатор прогона. */
  id: z.string().min(1),
  /** Идентификатор пайплайна. */
  pipelineId: z.string().min(1),
  /** Версия спецификации, по которой идёт прогон. */
  version: z.number().int().min(1),
  /** Проект-владелец прогона. */
  projectId: z.string().optional(),
  /** Статус прогона. */
  status: pipelineRunStatusSchema,
  /** Текущий узел (исполняемый/ожидающий). */
  currentNode: z.string().optional(),
  /** Триггер, породивший прогон. */
  trigger: pipelineRunTriggerSchema.optional(),
  /** ISO-время старта прогона. */
  startedAt: z.string().optional(),
  /** ISO-время завершения прогона. */
  finishedAt: z.string().optional(),
  /** Текст ошибки прогона. */
  error: z.string().optional(),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

/**
 * Тип события прогона — журнал шагов и переходов (ADR-101 §8).
 * Наружу события публикуются как `pipeline.run.*` в существующей шине
 * (ADR-024/ADR-089) — новых каналов не заводим.
 */
export const pipelineRunEventTypeSchema = z.enum([
  'run.started',
  'node.started',
  'node.finished',
  'edge.taken',
  'gate.awaiting',
  'run.finished',
  'run.failed',
]);
export type PipelineRunEventType = z.infer<typeof pipelineRunEventTypeSchema>;

/** Событие прогона — запись журнала (append-only). */
export const pipelineRunEventSchema = z.object({
  /** Идентификатор события. */
  id: z.string().optional(),
  /** Идентификатор прогона. */
  runId: z.string().min(1),
  /** ISO-время события. */
  ts: z.string(),
  /** Тип события. */
  type: pipelineRunEventTypeSchema,
  /** Данные события (узел, переход, причина и т.п.). */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type PipelineRunEvent = z.infer<typeof pipelineRunEventSchema>;

// --- Проверка целостности графа ---

/** Итог проверки спецификации. */
export type PipelineSpecValidationResult =
  | { ok: true }
  | { ok: false; problems: string[] };

/** Непустая строка (пробелы не считаются значением). */
function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Проверка целостности спецификации — **список проблем строками, без throw**
 * (по образцу `validatePackManifest` из `types/pack.ts`).
 *
 * Разделение ответственности: `pipelineSpecSchema` — **структура** (форма
 * полей, типы, enum'ы), `validatePipelineSpec` — **семантика** графа:
 * 1. непустой список узлов;
 * 2. уникальность идентификаторов узлов;
 * 3. `on[].then` ссылается на существующий узел;
 * 4. `exits` непуст, и у каждого выхода заполнены поля, нужные его виду
 *    (`file` — `path`, `session` — `agent` или `sessionId`, `gateway` —
 *    `event` или `webhookId`);
 * 5. у узла задано поле, обязательное для его вида (`agent` — `agent`,
 *    `tool` — `tool`, `script` — `command`);
 * 6. `mode` — из допустимых значений.
 *
 * Функция работает по **уже распарсенной** спецификации (после
 * `pipelineSpecSchema.safeParse`), поэтому не отбрасывает спецификацию
 * целиком: все проблемы перечисляются за один проход.
 */
export function validatePipelineSpec(spec: PipelineSpec): PipelineSpecValidationResult {
  const problems: string[] = [];

  // 1/2/5. Узлы: наличие, уникальность id, поля по виду.
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (nodes.length === 0) {
    problems.push('nodes: нужен хотя бы один узел');
  }

  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    const id = node?.id;
    if (!hasText(id)) {
      problems.push(`nodes[${index}]: узел без поля «id»`);
      return;
    }
    if (nodeIds.has(id)) {
      problems.push(`nodes[${index}]: дубликат id узла «${id}»`);
      return;
    }
    nodeIds.add(id);

    if (node.kind === 'agent' && !hasText(node.agent)) {
      problems.push(`nodes[${index}] («${id}»): узел вида «agent» требует поле «agent»`);
    }
    if (node.kind === 'tool' && !hasText(node.tool)) {
      problems.push(`nodes[${index}] («${id}»): узел вида «tool» требует поле «tool»`);
    }
    if (node.kind === 'script' && !hasText(node.command)) {
      problems.push(`nodes[${index}] («${id}»): узел вида «script» требует поле «command»`);
    }
  });

  // 3. Переходы: цель должна существовать (ссылка вперёд допустима — поэтому
  // второй проход, после сбора всех id).
  nodes.forEach((node, index) => {
    const transitions = Array.isArray(node?.on) ? node.on : [];
    transitions.forEach((transition, transitionIndex) => {
      const target = transition?.then;
      if (!hasText(target)) {
        problems.push(`nodes[${index}].on[${transitionIndex}]: переход без поля «then»`);
        return;
      }
      if (!nodeIds.has(target)) {
        problems.push(
          `nodes[${index}].on[${transitionIndex}]: переход ведёт на несуществующий узел «${target}»`,
        );
      }
    });
  });

  // 4. Выходы: список непуст, поля по виду выхода.
  const exits = Array.isArray(spec.exits) ? spec.exits : [];
  if (exits.length === 0) {
    problems.push('exits: нужен хотя бы один выход');
  }
  exits.forEach((exit, index) => {
    if (exit?.kind === 'session') {
      const session = exit.session;
      if (!session || (!hasText(session.agent) && !hasText(session.sessionId))) {
        problems.push(
          `exits[${index}]: выход вида «session» требует «session.agent» или «session.sessionId»`,
        );
      }
    } else if (exit?.kind === 'file') {
      if (!exit.file || !hasText(exit.file.path)) {
        problems.push(`exits[${index}]: выход вида «file» требует «file.path»`);
      }
    } else if (exit?.kind === 'gateway') {
      const gateway = exit.gateway;
      if (!gateway || (!hasText(gateway.event) && !hasText(gateway.webhookId))) {
        problems.push(
          `exits[${index}]: выход вида «gateway» требует «gateway.event» или «gateway.webhookId»`,
        );
      }
    }
  });

  // 6. Режим пайплайна (схема уже ограничивает значения — проверка нужна для
  // спецификаций, собранных вручную).
  if (!(PIPELINE_MODES as readonly string[]).includes(spec.mode)) {
    problems.push(
      `mode: неизвестный режим пайплайна «${String(spec.mode)}» (допустимо: ${PIPELINE_MODES.join('|')})`,
    );
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
