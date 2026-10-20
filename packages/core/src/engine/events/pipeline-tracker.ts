import { generateId, nowISO } from '@itphx/synth-shared';
import type {
  PipelineArtifact,
  PipelineStepState,
  PipelineTrigger,
  SynthEvent,
} from '@itphx/synth-shared';
import type {
  PipelineDefinitionRecord,
  PipelineInstanceRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';
import { warning } from '../../logger.js';

/**
 * ADR-089/ADR-051: учёт экземпляров пайплайна в ядре (PROP-059).
 *
 * Семантика (ADR-089, `decision.pipeline` в цели правила маршрутизации):
 * событие пришло, Router выбрал правило с `target.pipeline = {id, step}` —
 * это значит «событие `waitsFor` продвинуло автомат пайплайна `id` к шагу
 * `step`». Правило такое порождает установщик пакета расширения
 * (`server/routes/packs.ts`): для каждого шага с `waitsFor` — правило
 * `match = waitsFor` → `target = {mode:'ephemeral', agentTemplate: step.agent,
 * pipeline: {id, step}}`.
 *
 * Кто первый шаг, а кто гейт:
 * - **первый** шаг определения с `waitsFor` — триггер пайплайна: по приходу
 *   совпавшего события **создаётся** экземпляр автомата;
 * - **последующие** шаги с `waitsFor` — гейты (HITL): событие означает
 *   «предыдущий шаг завершён (и подтверждён человеком)» — автомат
 *   **продвигается** в существующем экземпляре.
 *
 * Артефакт между шагами (PROP-059): payload события (напр. `{draftId}`)
 * сохраняется в артефакте шага и дублируется в `trigger.payload` — следующий
 * шаг получает артефакт предыдущего из payload события-триггера. В ядре
 * хранится только значимая часть payload (без секретов).
 *
 * Чего модуль **не** делает: не определяет момент фактического завершения
 * хода агента (`stream.done` живёт в оркестраторе, вне контура funnel) —
 * поэтому шаг переводится в `done` при следующем событии этого же
 * пайплайна (см. `_advance`). Ограничение зафиксировано в отчёте задачи.
 */

/** Лог-группа трекера (уровень по умолчанию — WARNING). */
const LOG_GROUP = 'PIPELINE';

/** Префикс id экземпляра пайплайна (совпадает с ручным запуском, ADR-051). */
const INSTANCE_ID_PREFIX = 'plrun_';

/**
 * Ключи payload'а, значения которых **не** попадают в артефакт (секреты и
 * креды — инвариант 13: секреты не пишутся в журналы/документацию открытым
 * текстом). Артефакт шага — служебная запись прогонов, а не хранилище
 * секретов.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|cookie|session[-_]?key|signature)/i;

/** Максимальная глубина вложенности payload'а, попадающего в артефакт. */
const MAX_PAYLOAD_DEPTH = 4;

/** Максимум элементов массива в payload'е (всё остальное отбрасывается). */
const MAX_PAYLOAD_ARRAY = 50;

/** Максимальная длина строкового значения в payload'е. */
const MAX_PAYLOAD_STRING = 1000;

/**
 * ADR-089: артефакт шага пайплайна — событие, которым автомат продвинут.
 * Контракт — общий (`@itphx/synth-shared`): `kind`/`id`/`from` + `source`/`type`
 * и `payload` (PROP-059 «передача артефактов между шагами»).
 */
export type PipelineEventArtifact = PipelineArtifact;

/**
 * ADR-089: триггер экземпляра — событие, породившее или продвинувшее
 * автомат. Payload события — и есть «артефакт между шагами»: следующий шаг
 * берёт его из payload события-триггера.
 */
export type PipelineEventTrigger = PipelineTrigger;

/** Состояние шага экземпляра (артефакт — общего контракта). */
export type PipelineEventStepState = PipelineStepState;

/**
 * Экземпляр пайплайна в учёте ядра (запись порта общего контракта).
 */
export type PipelineTrackedInstance = PipelineInstanceRecord;

/** Зависимости трекера: порт реестра пайплайнов (ADR-096 — слой хранения). */
export interface PipelineTrackerDeps {
  /** Порт реестра пайплайнов (определения + экземпляры). */
  repository: PipelineRepository;
}

/** Вход учёта экземпляра: решение Router'а + событие + сессия шага. */
export interface PipelineTrackInput {
  /** Ссылка на шаг пайплайна (`decision.pipeline`). */
  pipeline: { id: string; step: string };
  /** Событие, продвинувшее автомат. */
  event: SynthEvent;
  /** id сессии, материализованной для шага. */
  sessionId: string;
}

/** Контекст перехода автомата (общий для создания и продвижения). */
interface TransitionContext {
  /** Триггер (последнее событие автомата) с payload'ом-артефактом. */
  trigger: PipelineEventTrigger;
  /** Артефакт текущего шага. */
  artifact: PipelineEventArtifact;
  /** Время перехода (ISO-8601). */
  now: string;
  /** Индекс текущего шага в `definition.steps`. */
  stepIndex: number;
  /** Payload события (или `undefined`, если значимых полей нет). */
  payload?: Record<string, unknown>;
}

/**
 * ADR-089/ADR-051: трекер экземпляров пайплайна.
 *
 * Логика чистая: работает только с портом `PipelineRepository` (ADR-096) и
 * не знает про HTTP/сессии/очередь — поэтому тестируется на подставном
 * репозитории. Ошибки записи **не** гасятся внутри трекера: их гасит
 * вызывающий (funnel) — учёт экземпляра не должен ломать доставку события.
 */
export class PipelineTracker {
  private _repository: PipelineRepository;

  constructor(deps: PipelineTrackerDeps) {
    this._repository = deps.repository;
  }

  /**
   * Учёт экземпляра пайплайна по решению Router'а.
   *
   * Возвращает созданный/обновлённый экземпляр либо `null`, если пайплайн
   * неизвестен (определения нет) или в определении нет шага с таким id —
   * оба случая fail-soft (доставка события не должна ломаться из-за
   * неполного реестра).
   */
  async track(input: PipelineTrackInput): Promise<PipelineTrackedInstance | null> {
    const definition = await this._repository.getDefinition(input.pipeline.id);
    if (!definition) {
      warning(
        LOG_GROUP,
        `пайплайн «${input.pipeline.id}» не найден — экземпляр не создан (событие «${input.event.type}» доставлено)`,
      );
      return null;
    }

    const stepIndex = definition.steps.findIndex((step) => step.id === input.pipeline.step);
    if (stepIndex === -1) {
      warning(
        LOG_GROUP,
        `в пайплайне «${definition.id}» нет шага «${input.pipeline.step}» — экземпляр не создан`,
      );
      return null;
    }

    const payload = sanitizeEventPayload(input.event.payload);
    const context: TransitionContext = {
      trigger: {
        source: input.event.source,
        type: input.event.type,
        ...(input.event.dedupKey ? { dedupKey: input.event.dedupKey } : {}),
        ...(payload ? { payload } : {}),
      },
      artifact: buildArtifact(input.event, payload),
      now: nowISO(),
      stepIndex,
      ...(payload ? { payload } : {}),
    };

    // Триггер пайплайна (первый шаг с `waitsFor`) — новый экземпляр.
    if (this._isTriggerStep(definition, stepIndex)) {
      const instance = this._createInstance(definition, input, context);
      await this._repository.saveInstance(instance);
      return instance;
    }

    // Гейт (следующий шаг) — продвигаем существующий экземпляр.
    const active = await this._findActive(definition.id);
    if (!active) {
      // Состояние потеряно (перезапуск процесса/потерянный реестр) — не
      // выдумываем историю: создаём новый экземпляр с текущим шагом
      // (fail-safe: экземпляр всегда отражает реальность).
      const instance = this._createInstance(definition, input, context);
      await this._repository.saveInstance(instance);
      return instance;
    }

    const instance = this._advance(active, definition, input, context);
    await this._repository.saveInstance(instance);
    return instance;
  }

  /**
   * Триггер пайплайна или гейт?
   *
   * Контракт шага (`PipelineStep.waitsFor`, ADR-051/PROP-059): **первый** шаг
   * с `waitsFor` — триггер (по приходу совпавшего события создаётся новый
   * экземпляр), **последующие** шаги с `waitsFor` — гейты (событие означает
   * «предыдущий шаг завершён и подтверждён»). Правило маршрутизации
   * порождается из `waitsFor` шага (`server/routes/packs.ts`), поэтому
   * адресованный шаг — это всегда шаг с `waitsFor`.
   *
   * Если в определении нет ни одного шага с `waitsFor` (определение создано
   * вручную, а не пакетом) — триггером считается первый шаг определения.
   */
  private _isTriggerStep(definition: PipelineDefinitionRecord, stepIndex: number): boolean {
    const firstWithWait = definition.steps.findIndex((step) => step.waitsFor !== undefined);
    return firstWithWait === -1 ? stepIndex === 0 : firstWithWait === stepIndex;
  }

  /**
   * Новый экземпляр автомата: текущий шаг — `running` (с сессией шага и
   * артефактом), остальные — `pending`. Шаги **перед** текущим не
   * выполнялись (автомат стартовал с текущего шага) — помечаются `skipped`.
   */
  private _createInstance(
    definition: PipelineDefinitionRecord,
    input: PipelineTrackInput,
    context: TransitionContext,
  ): PipelineTrackedInstance {
    const steps: PipelineEventStepState[] = definition.steps.map((step, index) => {
      if (step.id === input.pipeline.step) {
        return {
          id: step.id,
          status: 'running',
          sessionId: input.sessionId,
          startedAt: context.now,
          artifact: context.artifact,
        };
      }
      const skipped = index < context.stepIndex;
      return { id: step.id, status: skipped ? 'skipped' : 'pending' };
    });

    const instance: PipelineTrackedInstance = {
      id: `${INSTANCE_ID_PREFIX}${generateId()}`,
      pipelineId: definition.id,
      ...(definition.version ? { pipelineVersion: definition.version } : {}),
      status: 'running',
      trigger: context.trigger,
      steps,
      currentStep: input.pipeline.step,
      attempts: 1,
      // Полезная нагрузка запуска (тело события) — прогон самодостаточен.
      ...(context.payload ? { payload: context.payload } : {}),
      createdAt: context.now,
      updatedAt: context.now,
    };
    return instance;
  }

  /**
   * Продвижение существующего экземпляра: предыдущий шаг → `done`
   * (с `finishedAt`), текущий → `running` (с сессией и артефактом),
   * `currentStep` — текущий, статус экземпляра — `running`.
   *
   * Ограничение (зафиксировано в отчёте задачи): момент фактического
   * окончания хода агента ядру здесь недоступен (`stream.done` — в
   * оркестраторе, вне контура funnel), поэтому `done` ставится здесь, при
   * следующем событии пайплайна, а не по факту завершения сессии.
   */
  private _advance(
    instance: PipelineInstanceRecord,
    definition: PipelineDefinitionRecord,
    input: PipelineTrackInput,
    context: TransitionContext,
  ): PipelineTrackedInstance {
    const steps = this._mergeSteps(instance.steps, definition);

    // Предыдущий шаг → done.
    const previousId = this._previousStepId(instance, definition, input.pipeline.step, context.stepIndex);
    if (previousId) {
      const index = steps.findIndex((step) => step.id === previousId);
      const previous = index === -1 ? undefined : steps[index];
      if (previous) {
        steps[index] = { ...previous, status: 'done', finishedAt: context.now };
      }
    }

    // Текущий шаг → running (сессия шага + артефакт события).
    const currentIndex = steps.findIndex((step) => step.id === input.pipeline.step);
    const existingCurrent = currentIndex === -1 ? undefined : steps[currentIndex];
    const current: PipelineEventStepState = existingCurrent
      ? { ...existingCurrent }
      : { id: input.pipeline.step, status: 'running' };
    const running: PipelineEventStepState = {
      ...current,
      status: 'running',
      sessionId: input.sessionId,
      startedAt: context.now,
      artifact: context.artifact,
    };
    if (currentIndex === -1) {
      steps.push(running);
    } else {
      steps[currentIndex] = running;
    }

    const advanced: PipelineTrackedInstance = {
      ...instance,
      status: 'running',
      // Триггер обновляется на каждом переходе: payload последнего события
      // (гейта) — это артефакт, который получит следующий шаг.
      trigger: context.trigger,
      steps,
      currentStep: input.pipeline.step,
      updatedAt: context.now,
    };
    return advanced;
  }

  /**
   * Живой экземпляр пайплайна: последний в статусе `running`/`waiting`.
   * `listInstances` отдаёт свежие первыми — берём первый подходящий.
   */
  private async _findActive(pipelineId: string): Promise<PipelineInstanceRecord | null> {
    const instances = await this._repository.listInstances({ pipelineId });
    for (const instance of instances) {
      if (instance.status === 'running' || instance.status === 'waiting') return instance;
    }
    return null;
  }

  /**
   * Шаги экземпляра в порядке определения (порядок шагов значим). Состояния
   * сохраняются; шаги, которых больше нет в определении, не теряются.
   */
  private _mergeSteps(
    existing: PipelineStepState[],
    definition: PipelineDefinitionRecord,
  ): PipelineEventStepState[] {
    const steps: PipelineEventStepState[] = definition.steps.map((defStep) => {
      const found = existing.find((step) => step.id === defStep.id);
      return found ? { ...found } : { id: defStep.id, status: 'pending' };
    });
    for (const step of existing) {
      if (!definition.steps.some((defStep) => defStep.id === step.id)) {
        steps.push({ ...step });
      }
    }
    return steps;
  }

  /**
   * Id предыдущего шага: текущий шаг экземпляра (`currentStep`), если он
   * известен и отличается от нового; иначе — шаг определения перед новым.
   */
  private _previousStepId(
    instance: PipelineInstanceRecord,
    definition: PipelineDefinitionRecord,
    currentStepId: string,
    stepIndex: number,
  ): string | undefined {
    const current = instance.currentStep;
    if (
      current &&
      current !== currentStepId &&
      definition.steps.some((step) => step.id === current)
    ) {
      return current;
    }
    return stepIndex > 0 ? definition.steps[stepIndex - 1]?.id : undefined;
  }
}

/**
 * ADR-089: payload события-триггера из записи экземпляра — «артефакт между
 * шагами» (следующий шаг получает его отсюда). Поле `payload` в `trigger` —
 * расширение ядра поверх общего контракта `PipelineTrigger`
 * (`@itphx/synth-shared`), поэтому чтение идёт через этот хелпер, а не через
 * приведение типа на стороне потребителя.
 */
export function pipelineTriggerPayload(
  instance: PipelineInstanceRecord,
): Record<string, unknown> | undefined {
  const trigger = instance.trigger as PipelineEventTrigger | undefined;
  return trigger?.payload;
}

/**
 * ADR-089: артефакт шага экземпляра (расширенный — с payload'ом события).
 * Читается через хелпер по той же причине, что и `pipelineTriggerPayload`.
 */
export function pipelineStepArtifact(
  step: PipelineStepState,
): PipelineEventArtifact | undefined {
  return step.artifact as PipelineEventArtifact | undefined;
}

/**
 * Артефакт шага из события: значимая часть payload'а + координаты события.
 * Контрактные поля `PipelineArtifact` заполнены (`kind`/`id`/`from`),
 * payload — расширение (PROP-059).
 */
function buildArtifact(
  event: SynthEvent,
  payload: Record<string, unknown> | undefined,
): PipelineEventArtifact {
  return {
    kind: 'event',
    id: event.id,
    from: event.source,
    ...(event.type ? { type: event.type } : {}),
    ...(payload ? { payload } : {}),
  };
}

/**
 * Значимая часть payload'а события для артефакта: без секретов, без
 * несериализуемых значений, с ограничением глубины/длины. Не-объектный
 * payload сохраняется как `{text}` (строковое тело события).
 */
function sanitizeEventPayload(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return undefined;
    return { text: truncate(text) };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const sanitized = sanitizeValue(payload as Record<string, unknown>, 0);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return undefined;
  return Object.keys(sanitized).length > 0 ? (sanitized as Record<string, unknown>) : undefined;
}

/** Рекурсивная очистка значения payload'а (секреты, глубина, длина). */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_PAYLOAD_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, MAX_PAYLOAD_ARRAY)) {
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== undefined) items.push(sanitized);
    }
    return items;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeValue(item, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

/** Обрезка длинной строки (артефакт не должен раздуваться). */
function truncate(text: string): string {
  return text.length > MAX_PAYLOAD_STRING ? `${text.slice(0, MAX_PAYLOAD_STRING)}…` : text;
}
