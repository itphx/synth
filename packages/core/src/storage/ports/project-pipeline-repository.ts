import type { PipelineSpec } from '@itphx/synth-shared';

/**
 * ADR-101 (Pipeline Engine): порт хранилища **спецификаций** пайплайнов —
 * черновик, публикация и журнал опубликованных версий (ADR-096 — слой хранения).
 *
 * Отличие от legacy-порта `PipelineRepository` (ADR-051/ADR-101, ADR-100):
 * там пайплайн — «декларация + учёт прогона» (шаги-сессии), здесь — полноценная
 * спецификация `PipelineSpec` (ADR-101, `packages/shared/src/types/pipeline-engine.ts`)
 * с версионированием. Legacy-порт не трогаем: он заменяется на Э3.
 *
 * ## Модель сущностей
 *
 * - **пайплайн** (`PipelineRecord`) — черновик спецификации (`draft`) и счётчик
 *   версий; `scope` разделяет шаблоны инстанса (`instance` — из пакета
 *   расширения) и пайплайны проекта (`project` — `projectId` обязателен);
 * - **версия** (`PipelineVersionRecord`) — **иммутабельный снимок**
 *   опубликованной спецификации (`pipelineId@version`); прогон всегда ссылается
 *   на конкретную версию.
 *
 * ## Контракт (ADR-096) — «паспорт» порта, общий для всех backend'ов
 *
 * - `savePipeline` — **upsert по `id`**: `createdAt` записи не перезаписывается,
 *   `updatedAt` обновляется (монотонно не убывает); `installedBy` (провенанс
 *   установки) переносится как обычное поле записи;
 * - `listPipelines` — детерминированный порядок (по `id`), фильтры
 *   `scope`/`projectId` — по «И»;
 * - `deletePipeline` — `true`, если запись была удалена, иначе `false`;
 *   удаление пайплайна удаляет и его версии, но **не** прогоны (прогон
 *   самодостаточен — несёт снимок спецификации);
 * - `saveVersion` — **upsert по `(pipelineId, version)`**; `listVersions` — по
 *   `version` asc.
 *
 * ## Секреты
 *
 * Порт хранит только спецификации и метаданные. Секреты в payload'е
 * спецификации/триггера не должны попадать в хранилище: санитизация — задача
 * движка (Э3), на этом уровне порт ничего не фильтрует и ничего секретного
 * не добавляет.
 */

/** Область пайплайна: `instance` — шаблон инстанса, `project` — пайплайн проекта. */
export type PipelineScope = 'instance' | 'project';

/**
 * Провенанс установки (ADR-101 §2.11, ADR-100): каким пакетом расширения
 * принесён пайплайн (шаблон) и в какой версии.
 *
 * Форма — та же, что у legacy-определения ADR-100
 * (`PipelineDefinitionRecord.installedBy`): переход с legacy-реестра на
 * шаблоны инстанса не теряет провенанс.
 */
export interface PipelineProvenance {
  /** Имя пакета расширения (`synth.pack`, ADR-086 §5). */
  pack: string;
  /** Версия пакета. */
  version: string;
  /**
   * id шаблона-источника, из которого пайплайн проекта инстанцирован
   * (`POST /pipeline-templates/:tid/instantiate`). Нужен для идемпотентного
   * инстанцирования (`ensure: true`): повторный вызов находит уже созданный
   * пайплайн по этому полю. Необязателен — записи без него (прежние данные)
   * остаются валидными, миграция не нужна.
   */
  templateId?: string;
}

/**
 * Пайплайн (черновик + счётчики версий).
 *
 * Поверх `PipelineSpec` (shared) здесь только служебные поля хранения:
 * `scope`/`projectId` (владение), `draft`/`draftVersion`/`publishedVersion`
 * (версионирование) и `createdAt`/`updatedAt`.
 */
export interface PipelineRecord {
  /** Идентификатор пайплайна (уникален в инстансе). */
  id: string;
  /** Область: шаблон инстанса (`instance`) или пайплайн проекта (`project`). */
  scope: PipelineScope;
  /** Проект-владелец; обязателен при `scope='project'`, при `scope='instance'` — отсутствует. */
  projectId?: string;
  /** Человекочитаемое имя. */
  name: string;
  /** Краткое описание. */
  description?: string;
  /** Канонический ключ иконки (нормализуется при чтении, как у `ProjectStore`). */
  icon?: string;
  /** Редактируемый черновик спецификации (неизменяем после публикации). */
  draft?: PipelineSpec;
  /** Номер версии, которая станет следующей опубликованной (≥ 1). */
  draftVersion: number;
  /** Номер опубликованной версии (если публикация была). */
  publishedVersion?: number;
  /**
   * Провенанс: каким пакетом расширения принесён шаблон (ADR-101 §2.11).
   * Заполняется при инстанцировании шаблона в пайплайн проекта; у пайплайна,
   * созданного вручную, — отсутствует.
   */
  installedBy?: PipelineProvenance;
  /** ISO-время создания записи (иммутабельно). */
  createdAt: string;
  /** ISO-время последней записи (монотонно не убывает). */
  updatedAt: string;
}

/**
 * Опубликованная версия спецификации — **иммутабельный снимок**.
 *
 * Снимок хранится рядом с черновиком и не меняется: правка черновика не влияет
 * на идущие и завершённые прогоны (ADR-101 §7).
 */
export interface PipelineVersionRecord {
  /** Идентификатор пайплайна-владельца версии. */
  pipelineId: string;
  /** Номер версии (≥ 1). */
  version: number;
  /** Снимок спецификации. */
  spec: PipelineSpec;
  /** ISO-время публикации. */
  publishedAt: string;
  /** Кто опубликовал (идентификатор пользователя/системы). */
  publishedBy?: string;
}

/** Фильтр выборки пайплайнов (`listPipelines`). */
export interface PipelineFilter {
  /** Только пайплайны этой области. */
  scope?: PipelineScope;
  /** Только пайплайны этого проекта. */
  projectId?: string;
}

/**
 * Порт хранилища спецификаций пайплайнов (ADR-101, ADR-096 — слой хранения).
 */
export interface ProjectPipelineRepository {
  /** Upsert пайплайна по `id` (существующий обновляется, `createdAt` сохраняется). */
  savePipeline(rec: PipelineRecord): Promise<void>;
  /** Пайплайн по `id` (`null`, если нет). */
  getPipeline(id: string): Promise<PipelineRecord | null>;
  /** Все пайплайны (детерминированный порядок — по `id`); фильтры — по «И». */
  listPipelines(filter?: PipelineFilter): Promise<PipelineRecord[]>;
  /**
   * Удаление пайплайна вместе с его версиями (`true` — удалён, `false` — не
   * было). Прогоны **не** удаляются: прогон самодостаточен (несёт снимок
   * спецификации) и должен оставаться читаемым после удаления пайплайна.
   */
  deletePipeline(id: string): Promise<boolean>;

  /** Upsert опубликованной версии по `(pipelineId, version)`. */
  saveVersion(rec: PipelineVersionRecord): Promise<void>;
  /** Опубликованная версия (`null`, если нет). */
  getVersion(pipelineId: string, version: number): Promise<PipelineVersionRecord | null>;
  /** Опубликованные версии пайплайна (по `version` asc). */
  listVersions(pipelineId: string): Promise<PipelineVersionRecord[]>;
}
