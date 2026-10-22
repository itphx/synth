import type {
  PipelineErrorPolicy,
  PipelineInstance,
  PipelineInstanceStatus,
  PipelineStep,
} from '@itphx/synth-shared';

/**
 * Порт хранилища определений и экземпляров пайплайнов
 * (ADR-051 «шедулер и пайплайны», ADR-100 «Pipeline Automation»).
 *
 * Разделение на два вида сущности:
 * - **определение** (`PipelineDefinitionRecord`) — декларация автомата: шаги,
 *   гейты, политика ошибок. Живёт в реестре инстанса (`provides.pipelines`
 *   манифеста `synth.pack`, ADR-086 §5);
 * - **экземпляр** (`PipelineInstanceRecord`) — конкретный прогон автомата:
 *   состояние шагов, попытки, статус. Создаётся рантаймом (ADR-100).
 *
 * Контракт (ADR-096) — «паспорт» порта, общий для всех backend'ов:
 * - `saveDefinition` — **upsert по `id`**: `createdAt` записи не перезаписывается,
 *   `updatedAt` обновляется (монотонно не убывает);
 * - `listDefinitions` — детерминированный порядок (по `id`);
 * - `deleteDefinition` — `true`, если запись была удалена, иначе `false`;
 * - `listInstances` — **свежие первыми** (`createdAt` убыв.), фильтры
 *   `pipelineId`/`status` — по «И», `limit` по умолчанию 100, потолок 1000.
 */

/** Дефолтный потолок выборки экземпляров (`listInstances` без `limit`). */
export const PIPELINE_INSTANCE_DEFAULT_LIMIT = 100;

/** Абсолютный потолок выборки экземпляров (`limit` выше — обрезается). */
export const PIPELINE_INSTANCE_MAX_LIMIT = 1000;

/**
 * Привести `limit` к допустимому виду: дефолт 100, потолок 1000.
 * Нечисловое/неположительное значение — дефолт.
 */
export function resolvePipelineInstanceLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return PIPELINE_INSTANCE_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), PIPELINE_INSTANCE_MAX_LIMIT);
}

/**
 * Определение пайплайна в реестре инстанса.
 *
 * Поверх `PipelineDefinition` (shared) добавлены служебные поля хранения:
 * `createdAt`/`updatedAt` и провенанс установки (`installedBy`).
 */
export interface PipelineDefinitionRecord {
  /** Идентификатор пайплайна (уникален в инстансе). */
  id: string;
  /** Человекочитаемое имя. */
  name: string;
  /** Краткое описание. */
  description?: string;
  /** Версия определения (semver-строка). */
  version?: string;
  /** Шаги пайплайна (контракт — `@itphx/synth-shared`). */
  steps: PipelineStep[];
  /** Что делать при ошибке шага (`fail`/`retry`/`rollback`). */
  onError?: PipelineErrorPolicy;
  /** Максимум попыток перезапуска экземпляра. */
  maxAttempts?: number;
  /** TTL экземпляра (строка-длительность, как у `Schedule.target.ttl`). */
  ttl?: string;
  /** Провенанс: каким пакетом расширения установлено (если установлен пакетом). */
  installedBy?: { pack: string; version: string };
  /** ISO-время создания записи. */
  createdAt: string;
  /** ISO-время последней записи. */
  updatedAt: string;
}

/**
 * Экземпляр пайплайна — конкретный прогон автомата.
 *
 * Контракт состояния — общий (`@itphx/synth-shared`, ADR-051/ADR-100);
 * здесь он только переиспользуется, дублирования типов нет. Поверх общего
 * контракта добавлена **полезная нагрузка запуска** (`payload`) — то, чем
 * экземпляр был порождён (событие/ручной запуск). Имя — не пустой
 * `interface extends` (lint `no-empty-object-type`).
 */
export interface PipelineInstanceRecord extends PipelineInstance {
  /**
   * Полезная нагрузка запуска (тело ручного запуска/события) — контекст
   * автомата. Не входит в общий контракт `PipelineInstance` (ADR-051):
   * хранится в записи порта, чтобы прогон был самодостаточным.
   */
  payload?: Record<string, unknown>;
}

/** Фильтр выборки экземпляров (`listInstances`). */
export interface PipelineInstanceFilter {
  /** Только экземпляры этого определения. */
  pipelineId?: string;
  /** Только экземпляры в этом статусе. */
  status?: PipelineInstanceStatus;
  /** Потолок выборки (дефолт 100, максимум 1000). */
  limit?: number;
}

/**
 * Порт реестра пайплайнов инстанса (ADR-051, ADR-100; ADR-096 — слой хранения).
 */
export interface PipelineRepository {
  /** Upsert определения по `id` (существующее обновляется, `createdAt` сохраняется). */
  saveDefinition(def: PipelineDefinitionRecord): Promise<void>;
  /** Определение по `id` (`null`, если нет). */
  getDefinition(id: string): Promise<PipelineDefinitionRecord | null>;
  /** Все определения (детерминированный порядок — по `id`). */
  listDefinitions(): Promise<PipelineDefinitionRecord[]>;
  /** Удаление определения (`true` — удалено, `false` — не было). */
  deleteDefinition(id: string): Promise<boolean>;

  /** Upsert экземпляра по `id` (состояние шагов/статус обновляются целиком). */
  saveInstance(instance: PipelineInstanceRecord): Promise<void>;
  /** Экземпляр по `id` (`null`, если нет). */
  getInstance(id: string): Promise<PipelineInstanceRecord | null>;
  /** Экземпляры: свежие первыми, фильтры `pipelineId`/`status` — по «И». */
  listInstances(filter?: PipelineInstanceFilter): Promise<PipelineInstanceRecord[]>;
}
