/**
 * ADR-051 (шедулер и пайплайны) + ADR-100 (Pipeline Automation): контракт
 * пайплайна — определение, шаг, состояние шага и экземпляр автомата.
 *
 * Здесь только типы и zod-схемы (browser-safe, без `node:*`): сам рантайм
 * пайплайнов (создание экземпляра, доставка шага, HITL-гейты) ещё не
 * реализован — он в объёме ADR-100. Контракт заводится заранее, чтобы
 * манифест расширения (`synth.pack`, ADR-086 §5) мог объявлять пайплайны.
 */
import { z } from 'zod';

/**
 * Вид шага пайплайна:
 * - `agent` — шаг с агентом (основной вид, значение по умолчанию);
 * - `loop` — резерв под Loop Engine (PROP-057, вне объёма сейчас).
 */
export const pipelineStepKindSchema = z.enum(['agent', 'loop']);
export type PipelineStepKind = z.infer<typeof pipelineStepKindSchema>;

/**
 * Совпадение с внешним событием — триггер шага/пайплайна.
 *
 * Форма — **сужение** `eventRouteMatchSchema` (ADR-089, `schemas/index.ts`)
 * до полей, осмысленных для автомата: `source` + `type`. Полную схему правил
 * маршрутизации здесь не переиспользуем намеренно:
 * - она несёт поля смысла роутера (`chatKey`/`threadKey`/`principalId`/
 *   `label`/`keywords`), а не триггера пайплайна;
 * - она лежит в `schemas/`, который импортирует `types/` — прямой импорт
 *   дал бы цикл `types → schemas → types`.
 */
export const eventMatchSchema = z.object({
  /** Источник события (напр. `ci`, `tg`, `cron`). */
  source: z.string().optional(),
  /** Тип события (напр. `release.created`). */
  type: z.string().optional(),
});
export type EventMatch = z.infer<typeof eventMatchSchema>;

/**
 * Артефакт шага (ADR-100: передача артефактов между шагами): что шаг
 * произвёл (`kind`) и откуда взялось (`from`).
 */
export const pipelineArtifactSchema = z.object({
  /** Вид артефакта (напр. `draft`, `report`). */
  kind: z.string().min(1),
  /** Идентификатор артефакта (если он адресуем). */
  id: z.string().optional(),
  /** Источник артефакта (путь/ссылка/идентификатор предыдущего шага). */
  from: z.string().optional(),
  /** Источник события, породившего артефакт (для артефакта-события). */
  source: z.string().optional(),
  /** Тип события, породившего артефакт (для артефакта-события). */
  type: z.string().optional(),
  /**
   * Данные артефакта (напр. payload события, которым шаг продвинул автомат).
   * Именно это «содержимое» получает следующий шаг пайплайна.
   */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type PipelineArtifact = z.infer<typeof pipelineArtifactSchema>;

/**
 * Шаг пайплайна.
 *
 * `waitsFor` — событие, которое **продвигает** автомат к этому шагу.
 * Семантика:
 * - **первый** шаг с `waitsFor` определяет **триггер** пайплайна: по приходу
 *   совпавшего события создаётся новый экземпляр автомата;
 * - **последующие** шаги с `waitsFor` — **гейты**: событие означает сигнал
 *   «предыдущий шаг завершён (и подтверждён человеком)» — автомат ждёт его,
 *   чтобы перейти дальше (HITL, ADR-089/ADR-051).
 */
export const pipelineStepSchema = z.object({
  /** Идентификатор шага (уникален в пределах определения). */
  id: z.string().min(1),
  /** Вид шага; по умолчанию — `agent`. */
  kind: pipelineStepKindSchema.default('agent'),
  /** Человекочитаемое название шага. */
  title: z.string().optional(),
  /** Агент, исполняющий шаг (id агента инстанса/пака). */
  agent: z.string().optional(),
  /** Скилл, используемый шагом. */
  skill: z.string().optional(),
  /** Промпт/задание для агента. */
  prompt: z.string().optional(),
  /** Событие-продвижение (триггер пайплайна или гейт). */
  waitsFor: eventMatchSchema.optional(),
  /** Артефакт, который шаг производит (или потребляет). */
  artifact: pipelineArtifactSchema.optional(),
  /** Таймаут шага в секундах. */
  timeoutSec: z.number().int().positive().optional(),
});
export type PipelineStep = z.infer<typeof pipelineStepSchema>;

/** Политика пайплайна при ошибке шага. */
export const pipelineErrorPolicySchema = z.enum(['fail', 'retry', 'rollback']);
export type PipelineErrorPolicy = z.infer<typeof pipelineErrorPolicySchema>;

/**
 * Определение пайплайна — декларация автомата (шаги, гейты, политика ошибок).
 * Тот же контракт используется в `provides.pipelines` манифеста `synth.pack`
 * (ADR-086 §5) — inline-определение вкладывается без преобразований.
 */
export const pipelineDefinitionSchema = z.object({
  /** Идентификатор пайплайна (уникален в пределах пака/инстанса). */
  id: z.string().min(1),
  /** Человекочитаемое имя. */
  name: z.string().min(1),
  /** Краткое описание. */
  description: z.string().optional(),
  /** Версия определения (semver-строка). */
  version: z.string().optional(),
  /** Шаги пайплайна; минимум один. */
  steps: z.array(pipelineStepSchema).min(1, 'пайплайн: нужен хотя бы один шаг'),
  /** Что делать при ошибке шага. */
  onError: pipelineErrorPolicySchema.optional(),
  /** Максимум попыток перезапуска экземпляра. */
  maxAttempts: z.number().int().positive().optional(),
  /** TTL экземпляра (строка-длительность, как у `Schedule.target.ttl`). */
  ttl: z.string().optional(),
});
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

/** Статус экземпляра пайплайна. */
export const pipelineInstanceStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'cancelled',
]);
export type PipelineInstanceStatus = z.infer<typeof pipelineInstanceStatusSchema>;

/** Статус шага внутри экземпляра. */
export const pipelineStepStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
]);
export type PipelineStepStatus = z.infer<typeof pipelineStepStatusSchema>;

/** Состояние шага в экземпляре пайплайна. */
export const pipelineStepStateSchema = z.object({
  /** Идентификатор шага (совпадает с `PipelineStep.id`). */
  id: z.string().min(1),
  status: pipelineStepStatusSchema,
  /** Сессия агента, исполнявшая шаг. */
  sessionId: z.string().optional(),
  /** ISO-время старта шага. */
  startedAt: z.string().optional(),
  /** ISO-время завершения шага. */
  finishedAt: z.string().optional(),
  /** Текст ошибки (при `status: 'failed'`). */
  error: z.string().optional(),
  /** Произведённый артефакт. */
  artifact: pipelineArtifactSchema.optional(),
});
export type PipelineStepState = z.infer<typeof pipelineStepStateSchema>;

/** Триггер, породивший экземпляр пайплайна. */
export const pipelineTriggerSchema = z.object({
  /** Источник события (напр. `ci`). */
  source: z.string().optional(),
  /** Тип события (напр. `release.created`). */
  type: z.string().optional(),
  /** Ключ дедупликации (повторное событие не создаёт новый экземпляр). */
  dedupKey: z.string().optional(),
  /** Payload события, породившего (продвинувшего) автомат. */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type PipelineTrigger = z.infer<typeof pipelineTriggerSchema>;

/** Экземпляр пайплайна — конкретный прогон автомата. */
export const pipelineInstanceSchema = z.object({
  /** Идентификатор экземпляра. */
  id: z.string().min(1),
  /** Идентификатор определения пайплайна. */
  pipelineId: z.string().min(1),
  /** Версия определения, по которой запущен экземпляр. */
  pipelineVersion: z.string().optional(),
  status: pipelineInstanceStatusSchema,
  /** Событие, породившее экземпляр. */
  trigger: pipelineTriggerSchema.optional(),
  /** Состояния шагов. */
  steps: z.array(pipelineStepStateSchema),
  /** Идентификатор текущего (исполняемого/ожидающего) шага. */
  currentStep: z.string().optional(),
  /** Число попыток перезапуска. */
  attempts: z.number().int().min(0),
  /**
   * Payload исходного события-триггера (неизменяемый). Актуальный payload
   * продвижения лежит в `trigger.payload` — он перезаписывается на каждом
   * гейте, а этот — хранит исходный.
   */
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Текст ошибки экземпляра. */
  error: z.string().optional(),
  /** ISO-время создания. */
  createdAt: z.string(),
  /** ISO-время последнего обновления. */
  updatedAt: z.string(),
});
export type PipelineInstance = z.infer<typeof pipelineInstanceSchema>;
