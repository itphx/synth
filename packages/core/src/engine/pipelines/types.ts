/**
 * ADR-101 (Pipeline Engine): внутренние типы движка пайплайнов.
 *
 * Контракты (спецификация, узлы, результат шага, прогон, журнал) живут в
 * `@itphx/synth-shared` (`types/pipeline-engine.ts`) — здесь только то, что
 * нужно **движку**: контекст исполнения шага, контракт исполнителя, зависимости
 * и точки расширения (выходы пайплайна).
 *
 * Модуль не знает про HTTP/сессии/очередь — только про порты слоя хранения
 * (ADR-096) и исполнителей шагов (ADR-101 §1).
 */
import type {
  PipelineExit,
  PipelineMode,
  PipelineNode,
  PipelineNodeKind,
  PipelineRunTrigger,
  PipelineSpec,
  StepResult,
} from '@itphx/synth-shared';
import type {
  PipelineRunRepository,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';

/**
 * Машиночитаемые коды ошибок движка пайплайнов (латница, ADR-101).
 *
 * Обязательный набор (задан планом этапа Э3): `pipeline.not_found`,
 * `pipeline.not_published`, `pipeline.invalid_spec`, `pipeline.loop_limit`,
 * `pipeline.cancelled`, `pipeline.executor_missing`, `pipeline.gate_rejected`,
 * `pipeline.step_failed`. Дополнительно введены коды состояний, которых в
 * обязательном наборе не было, но которые невозможно честно закрыть одним из
 * существующих: `pipeline.run_not_found` (прогон не найден), `pipeline.invalid_state`
 * (возобновление прогона не в состоянии `awaiting_human`), `pipeline.gate_timeout`
 * (истекло время ожидания человека), `pipeline.step_timeout` (истёк таймаут шага).
 */
export const PIPELINE_ERROR_CODES = [
  'pipeline.not_found',
  'pipeline.not_published',
  'pipeline.invalid_spec',
  'pipeline.loop_limit',
  'pipeline.cancelled',
  'pipeline.executor_missing',
  'pipeline.gate_rejected',
  'pipeline.gate_timeout',
  'pipeline.step_failed',
  'pipeline.step_timeout',
  'pipeline.run_not_found',
  'pipeline.invalid_state',
] as const;

/** Код ошибки движка пайплайнов (см. `PIPELINE_ERROR_CODES`). */
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

/**
 * Ошибка движка пайплайнов — машинночитаемый код + локализуемое сообщение.
 *
 * Сообщение формируется через `t()` (ключ `shared/i18n`, ADR-041), поэтому
 * ошибки движка не содержат «сырых» строк вне словаря.
 */
export class PipelineEngineError extends Error {
  /** Машиночитаемый код ошибки. */
  readonly code: PipelineErrorCode;

  constructor(code: PipelineErrorCode, message: string) {
    super(message);
    this.name = 'PipelineEngineError';
    this.code = code;
  }
}

/**
 * Контекст исполнения шага — всё, что нужно исполнителю (ADR-101 §1).
 *
 * Вход шага (`input`) — **результат маппинга**, а не «вся история»: пути
 * `node.input` плюс явно объявленные переменные (`spec.vars`).
 */
export interface StepExecutionContext {
  /** Идентификатор прогона. */
  runId: string;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации, по которой идёт прогон. */
  version: number;
  /** Исполняемый узел (спецификация целиком — в `spec`). */
  node: PipelineNode;
  /** Снимок спецификации прогона (прогон самодостаточен). */
  spec: PipelineSpec;
  /** Проект-владелец прогона (ADR-014), если задан. */
  projectId?: string;
  /** Триггер прогона (payload уже санитизирован). */
  trigger: PipelineRunTrigger;
  /** Маппинг входа шага (путь/имя → значение). */
  input: Record<string, unknown>;
  /** Разрешённые переменные спецификации (`spec.vars`). */
  vars: Record<string, unknown>;
  /** Результат предыдущего шага (источник `prev.output.*`). */
  prev?: StepResult;
  /** Сигнал отмены шага (отмена прогона + таймаут шага). */
  signal: AbortSignal;
  /** Номер попытки (нумерация с 1). */
  attempt: number;
  /** Режим пайплайна (`plan`/`act`/`yolo`) — применяет permission-слой. */
  mode: PipelineMode;
}

/**
 * Исполнитель шага — контракт исполнения узла пайплайна (ADR-101 §4).
 *
 * Исполнитель выбирается по виду узла (`kind`): `agent`/`script`/`tool`
 * реализуются в Э4, `human` обрабатывается движком как HITL-гейт (Э3/Э4).
 * Движок **не** знает, как именно исполняется шаг: он строит контекст, отдаёт
 * его исполнителю и получает `StepResult`.
 */
export interface StepExecutor {
  /** Вид узла, который исполняет исполнитель. */
  kind: PipelineNodeKind;
  /** Исполнение шага; бросок исключения — ошибка шага (`pipeline.step_failed`). */
  execute(ctx: StepExecutionContext): Promise<StepResult>;
}

/**
 * Контекст обработчика выхода пайплайна (ADR-101 §9).
 *
 * В Э3 выходы **не исполняются**: движок только фиксирует, какие выходы
 * сработали, и отдаёт контекст обработчикам. Реальные действия (создание
 * сессии, запись файла, публикация в шлюз) подключаются в Э5.
 */
export interface PipelineExitContext {
  /** Идентификатор прогона. */
  runId: string;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации. */
  version: number;
  /** Проект-владелец прогона (если задан). */
  projectId?: string;
  /** Выход из спецификации (`spec.exits[i]`). */
  exit: PipelineExit;
  /** Снимок спецификации прогона. */
  spec: PipelineSpec;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Выход последнего шага (`prev.output`). */
  output: Record<string, unknown>;
  /** Разрешённые переменные спецификации. */
  vars: Record<string, unknown>;
}

/**
 * Обработчик выхода пайплайна — **точка расширения** движка (ADR-101 §9).
 *
 * В Э3 используется no-op реализация: выходы фиксируются в журнале прогона,
 * но не исполняются. Э5 подключает реальные обработчики, не меняя движок.
 */
export interface PipelineExitHandler {
  /** Обработка выхода пайплайна. */
  handle(ctx: PipelineExitContext): Promise<void> | void;
}

/** No-op обработчик выхода (значение по умолчанию в Э3). */
export class NoopPipelineExitHandler implements PipelineExitHandler {
  handle(_ctx: PipelineExitContext): void {
    // Выходы в Э3 не исполняются (Э5 подключит реальные обработчики).
  }
}

/** Логгер движка (совместим с `logger.ts` ядра; по умолчанию — он же). */
export interface PipelineEngineLogger {
  /** Информационное сообщение. */
  info(group: string, message: string): void;
  /** Предупреждение. */
  warning(group: string, message: string): void;
  /** Ошибка. */
  error(group: string, message: string): void;
}

/** Зависимости движка пайплайнов (ADR-101). */
export interface PipelineEngineDeps {
  /** Порт спецификаций пайплайнов (черновик + опубликованные версии). */
  pipelines: ProjectPipelineRepository;
  /** Порт прогонов и журнала выполнения. */
  runs: PipelineRunRepository;
  /** Исполнители шагов (по виду узла). */
  executors: StepExecutor[];
  /** Обработчики выходов пайплайна (Э3 — no-op). */
  exits?: PipelineExitHandler[];
  /** Логгер (по умолчанию — логгер ядра). */
  logger?: PipelineEngineLogger;
  /** Пауза между попытками ретрая (в тестах — мгновенная). */
  sleep?: (ms: number) => Promise<void>;
}

/** Опции запуска прогона. */
export interface PipelineRunOptions {
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации (по умолчанию — последняя опубликованная). */
  version?: number;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Проект-владелец прогона. */
  projectId?: string;
  /** Сигнал отмены прогона. */
  signal?: AbortSignal;
}

/** Решение человека по HITL-гейту (возобновление прогона). */
export interface PipelineGateDecision {
  /** Одобрение (`true`) или отклонение (`false`). */
  approved: boolean;
  /** Данные, переданные шагом дальше (выход гейта). */
  output?: Record<string, unknown>;
  /** Комментарий человека (пишется в журнал прогона). */
  comment?: string;
}

/**
 * Контекст разрешения путей прогона — данные, доступные условиям и маппингу.
 *
 * Поддерживаемые корни (см. `paths.ts`): `prev.output.*`, `prev.status`,
 * `prev.error.code`, `trigger.payload.*`, `trigger.kind|source|type`, `vars.*`.
 */
export interface PipelinePathContext {
  /** Результат предыдущего (или текущего) шага. */
  prev?: StepResult;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Разрешённые переменные спецификации (`spec.vars`). */
  vars: Record<string, unknown>;
}

/**
 * Контекст вычисления условия — тот же набор данных, что и для маппинга
 * (условия и маппинг читают одни и те же пути прогона).
 */
export type ConditionContext = PipelinePathContext;
