import type {
  PipelineRunEventType,
  PipelineRunStatus,
  PipelineRunTrigger,
  PipelineSpec,
} from '@itphx/synth-shared';

/**
 * ADR-101 (Pipeline Engine): порт хранилища **прогонов** пайплайнов и журнала
 * выполнения (append-only) — ADR-096 (слой хранения).
 *
 * Прогон состоит из двух частей (docs/PIPELINES.md §2.9):
 * - **заголовок** (`PipelineRunRecord`) — состояние прогона: статус, текущий
 *   узел, версия спецификации, триггер, владелец/проект, тайминги;
 * - **события** (`PipelineRunEventRecord`) — журнал шагов и переходов:
 *   `run.started`/`node.started`/`node.finished`/`edge.taken`/`gate.awaiting`/
 *   `run.finished`/`run.failed`. Журнал **неизменяем** (append-only).
 *
 * ## Самодостаточность прогона
 *
 * Прогон несёт **снимок спецификации** (`spec`), по которому он идёт. Поэтому
 * удаление пайплайна (и его версий) не делает прогон нечитаемым: журнал
 * остаётся воспроизводимым (ADR-101 §7).
 *
 * ## Контракт (ADR-096) — «паспорт» порта, общий для всех backend'ов
 *
 * - `saveRun` — **upsert по `id`**: `createdAt` записи не перезаписывается,
 *   `updatedAt` обновляется (монотонно не убывает);
 * - `listRuns` — **свежие первыми** (`createdAt` убыв., тайбрейкер — `id`),
 *   фильтры `pipelineId`/`projectId`/`status` — по «И», `limit` по умолчанию
 *   100, потолок 1000;
 * - `appendEvent` — только добавляет (журнал неизменяем);
 * - `listEvents` — хронологически (по `ts`, затем порядок добавления); при
 *   `limit` — последние N в хронологическом порядке; неизвестный `runId` — `[]`.
 *
 * ## Секреты
 *
 * Порт не фильтрует и не добавляет ничего секретного. Payload события и
 * payload триггера могут содержать данные внешнего источника — их санитизация
 * (вырезание токенов/ключей) — задача движка (Э3), не порта.
 */

/** Заголовок прогона — состояние конкретного запуска пайплайна. */
export interface PipelineRunRecord {
  /** Идентификатор прогона (уникален в инстансе). */
  id: string;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации, по которой идёт прогон (≥ 1). */
  version: number;
  /** Снимок спецификации на момент запуска — прогон самодостаточен. */
  spec: PipelineSpec;
  /** Проект-владелец прогона. */
  projectId?: string;
  /** Статус прогона. */
  status: PipelineRunStatus;
  /** Текущий узел (исполняемый/ожидающий). */
  currentNode?: string;
  /** Триггер, породивший прогон. */
  trigger?: PipelineRunTrigger;
  /** ISO-время старта прогона. */
  startedAt?: string;
  /** ISO-время завершения прогона. */
  finishedAt?: string;
  /** Текст ошибки прогона. */
  error?: string;
  /** ISO-время создания записи (иммутабельно). */
  createdAt: string;
  /** ISO-время последней записи (монотонно не убывает). */
  updatedAt: string;
}

/** Событие прогона — запись журнала выполнения (append-only). */
export interface PipelineRunEventRecord {
  /** Идентификатор прогона. */
  runId: string;
  /** ISO-время события. */
  ts: string;
  /** Тип события. */
  type: PipelineRunEventType;
  /** Данные события (узел, переход, причина и т.п.). */
  payload?: Record<string, unknown>;
}

/** Фильтр выборки прогонов (`listRuns`). */
export interface PipelineRunFilter {
  /** Только прогоны этого пайплайна. */
  pipelineId?: string;
  /** Только прогоны этого проекта. */
  projectId?: string;
  /** Только прогоны в этом статусе. */
  status?: PipelineRunStatus;
  /** Потолок выборки (дефолт 100, максимум 1000). */
  limit?: number;
}

/** Опции чтения журнала прогона (`listEvents`). */
export interface PipelineRunEventListOptions {
  /** Вернуть последние N событий (в хронологическом порядке). */
  limit?: number;
}

/**
 * Порт хранилища прогонов пайплайнов и журнала выполнения (ADR-101, ADR-096).
 */
export interface PipelineRunRepository {
  /** Upsert заголовка прогона по `id` (существующий обновляется, `createdAt` сохраняется). */
  saveRun(rec: PipelineRunRecord): Promise<void>;
  /** Прогон по `id` (`null`, если нет). */
  getRun(id: string): Promise<PipelineRunRecord | null>;
  /** Прогоны: свежие первыми, фильтры — по «И», `limit` — дефолт 100 / потолок 1000. */
  listRuns(filter?: PipelineRunFilter): Promise<PipelineRunRecord[]>;

  /** Дозапись события в журнал прогона (append-only). */
  appendEvent(ev: PipelineRunEventRecord): Promise<void>;
  /** События прогона хронологически (по `ts`, затем порядок добавления). */
  listEvents(runId: string, opts?: PipelineRunEventListOptions): Promise<PipelineRunEventRecord[]>;
}
