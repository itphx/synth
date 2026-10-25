/**
 * ADR-101/ADR-051: рантайм автоматизации для встроенных тулов.
 *
 * Тулы пайплайнов (`pipeline_*`) и расписаний (`schedule_*`) работают с
 * доменными портами слоя хранения и с движком пайплайнов — тем же набором
 * объектов, что и HTTP-роуты. Чтобы не прокидывать их по сигнатуре тула,
 * они кладутся в `ToolContext.extra.automation` (ADR-070 §2.9 — рантайм в
 * extra, как `skillRuntime`/`executionPort`).
 *
 * ## Почему `getAutomationRuntime`, а не готовый объект
 *
 * Оркестратор создаётся **до** движка пайплайнов и шедулера (точка сборки
 * `server/app/deps.ts` / `backend/app/deps.ts`), поэтому объекты доступны
 * только позже. Поэтому опция — **late-bound геттер** (как
 * `getRequestSessionService`): он вызывается в момент хода и отдаёт актуальный
 * снимок зависимостей.
 *
 * ## Границы
 *
 * - модуль не знает про HTTP, сессии и очередь — только про порты и движок;
 * - запись идёт **только через порты** (ADR-096) — прямой записи в
 *   `{dataDir}` нет;
 * - capability `runtime` для этого **не переиспользуется**: она
 *   неотключаема админом, а пайплайны/расписания — отключаемые доменные
 *   ресурсы (у них свои capability `pipeline`/`schedule`).
 */
import type { PipelineEngine } from '../pipelines/engine.js';
import type { PipelineRunControl } from '../pipelines/run-control.js';
import type { SchedulerService } from '../scheduler/scheduler.js';
import type {
  PipelineRunRepository,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import type { JobRepository } from '../../storage/ports/job-repository.js';
import type { ScheduleRepository } from '../../storage/ports/schedule-repository.js';
import type { PipelineRepository } from '../../storage/ports/pipeline-repository.js';

/**
 * Рантайм автоматизации для тулов.
 *
 * Все поля необязательные: отсутствие порта означает «тул недоступен» —
 * тул возвращает понятную ошибку (`pipeline.tool.deps_unavailable`), а не
 * падает.
 */
export interface AutomationRuntime {
  /** Порт спецификаций пайплайнов (черновик + опубликованные версии). */
  pipelines?: ProjectPipelineRepository;
  /** Порт прогонов и журнала выполнения. */
  runs?: PipelineRunRepository;
  /** Движок пайплайнов (ADR-101). */
  engine?: PipelineEngine;
  /** Реестр активных прогонов (soft-lock + отмена, ADR-101). */
  runControl?: PipelineRunControl;
  /**
   * Legacy-реестр шаблонов пайплайнов инстанца (ADR-100) — **источник
   * шаблонов** для инстанцирования (формат `adr-100`).
   */
  templates?: PipelineRepository;
  /** Порт расписаний планировщика (ADR-051) — Stage C. */
  schedules?: ScheduleRepository;
  /** Порт истории Job'ов планировщика (ADR-051) — Stage C. */
  jobs?: JobRepository;
  /** Планировщик (ADR-051) — Stage C. */
  scheduler?: SchedulerService;
}
