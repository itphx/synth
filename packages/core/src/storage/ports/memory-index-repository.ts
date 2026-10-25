/**
 * Порт хранилища **индексов памяти** (ADR-096 — слой хранения; PROP-047 —
 * «Память Synth»).
 *
 * Индекс — построенный корпус для retrieval: чанки документов с векторами
 * эмбеддингов. Ключевые свойства модели (PROP-047 §5.2/§5.3):
 * - **поколение** (`generation`) — атомарная замена корпуса: новое поколение
 *   пишется рядом со старым, переключение — одной записью состояния; старое
 *   поколение не трогается (в нём может ещё идти поиск);
 * - **фингерпринт эмбеддинга** (`fingerprint`) — модель, размерность,
 *   нормализация, версия чанкера, «уровень обёртки». Смена модели эмбеддинга
 *   делает индекс `stale`, а не молча «похожим»: вектор переиспользуется
 *   только при совпадении `embeddingInputHash` чанка;
 * - **состояние** (`state`) — `building`/`ready`/`stale`/`failed`; при
 *   `failed` индекс хранит текст ошибки;
 * - **область видимости** (`scope`) — `project` (индекс виден только своему
 *   проекту) или `instance` (индекс виден всем на инстансе).
 *
 * Векторы хранятся **как есть** (`number[]`): ANN-поиск в порт **не** входит —
 * retrieval целиком в плагине (PROP-047 §3). Порт отвечает за хранение и
 * смену поколений, чтобы ядро владело данными (бэкап ADR-091, миграция
 * ADR-097, retention), а плагин — логикой.
 *
 * Контракт (ADR-096) — «паспорт» порта, общий для всех backend'ов:
 * - `saveIndex` — **upsert по `id`**: `createdAt` не перезаписывается,
 *   `updatedAt` обновляется монотонно;
 * - `listIndexes` — детерминированный порядок («свежие первыми»: `createdAt`
 *   убыв., тайбрейкер `id`), фильтры — по «И», `limit`/`offset` — пагинация;
 * - `deleteIndex` — **каскад**: удаляет чанки индекса;
 * - `setState` — смена состояния индекса (с текстом ошибки), `false`, если
 *   индекса нет;
 * - `replaceChunks` — **атомарная замена поколения**: чанки поколения
 *   заменяются целиком, другие поколения не трогаются; возвращает число
 *   записанных чанков;
 * - `listChunks`/`countChunks` — выборка чанков индекса с фильтрами
 *   `generation`/`documentId` и пагинацией;
 * - `deleteChunks` — удаление чанков поколения (или всех поколений индекса,
 *   если `generation` не задан); возвращает число удалённых.
 */

/** Состояние индекса памяти. */
export type MemoryIndexState = 'building' | 'ready' | 'stale' | 'failed';

/**
 * Область видимости индекса: проектный или общий на инстанс.
 *
 * - `project` — индекс виден только проекту-владельцу (`projectId`);
 * - `instance` — индекс виден всем на инстансе (общий корпус: например,
 *   индекс по фактам памяти или по workspace, не привязанному к проекту).
 *
 * Легаси-записи (сохранённые до появления поля) читаются как `project` —
 * это историческое поведение (индекс без области видимости виден своему
 * проекту).
 */
export type MemoryIndexScope = 'project' | 'instance';

/**
 * Фингерпринт эмбеддинга — конфигурация, при которой векторы переиспользуемы.
 *
 * Смена любой оси (модель, размерность, нормализация, версия чанкера, уровень
 * обёртки) означает «другой вектор»: индекс становится `stale` и требует
 * пересборки, а не тихого переиспользования старых векторов.
 */
export interface MemoryIndexFingerprint {
  /** Модель эмбеддинга (идентификатор провайдера/модели). */
  model: string;
  /** Размерность вектора. */
  dimension: number;
  /** Нормируется ли вектор. */
  normalize?: boolean;
  /** Версия чанкера (изменение нарезки меняет вектора). */
  chunkerVersion: string;
  /** Уровень «обёртки» текста перед эмбеддингом (префикс/суффикс/обёртка). */
  wrapTier?: string;
}

/** Источник корпуса индекса (что индексируется). */
export interface MemoryIndexSource {
  /** Вид источника (`project`/`files`/`sessions`/`external`/…). */
  kind: string;
  /** Фильтр источника (glob, запрос, предикат — по виду источника). */
  filter?: string;
}

/** Статистика индекса (объём корпуса). */
export interface MemoryIndexStats {
  /** Число документов в индексе. */
  documents: number;
  /** Число чанков в индексе. */
  chunks: number;
  /** ISO-момент обновления статистики. */
  updatedAt: string;
}

/** Запись индекса памяти. */
export interface MemoryIndexRecord {
  /** Идентификатор индекса (уникален в инстансе). */
  id: string;
  /** Владелец индекса (обычно `plugin:<имя плагина>`). */
  namespace: string;
  /** Человекочитаемое имя индекса. */
  name: string;
  /** Провайдер памяти, которому принадлежит индекс (`plugin:<ns>`). */
  providerId: string;
  /**
   * Проект-владелец индекса.
   *
   * Для `scope: 'project'` — проект-владелец (индекс виден только ему).
   * Для `scope: 'instance'` — **источник корпуса** (`files`: чей workspace
   * сканировать); может отсутствовать (например, источник `facts`).
   */
  projectId?: string;
  /**
   * Область видимости: `project` — только проект `projectId`; `instance` — виден всем.
   */
  scope: MemoryIndexScope;
  /** Источник корпуса. */
  source: MemoryIndexSource;
  /** Состояние индекса. */
  state: MemoryIndexState;
  /** Текущее поколение корпуса (инкремент при пересборке). */
  generation: number;
  /** Фингерпринт эмбеддинга (модель/размерность/чанкер). */
  fingerprint: MemoryIndexFingerprint;
  /** Статистика корпуса. */
  stats: MemoryIndexStats;
  /** ISO-момент создания записи (иммутабельно при перезаписи). */
  createdAt: string;
  /** ISO-момент последней записи (монотонно не убывает). */
  updatedAt: string;
  /** Текст ошибки (при `state: 'failed'`). */
  error?: string;
}

/** Запись чанка индекса. */
export interface MemoryChunkRecord {
  /** Идентификатор индекса-владельца. */
  indexId: string;
  /** Поколение, к которому относится чанк. */
  generation: number;
  /** Идентификатор чанка (уникален в пределах `(indexId, generation)`). */
  id: string;
  /** Идентификатор документа-источника. */
  documentId: string;
  /** Порядковый номер чанка в документе (0-based). */
  ordinal: number;
  /** Текст чанка (то, что уходит в эмбеддинг). */
  text: string;
  /**
   * Вектор эмбеддинга. В JSON/PostgreSQL хранится как есть (`jsonb`);
   * ANN-поиск в порт не входит — retrieval живёт в плагине.
   */
  vector?: number[];
  /**
   * Хэш входа эмбеддинга (модель + размерность + обёртка + текст) — по нему
   * вектор переиспользуется при пересборке, пока фингерпринт не изменился.
   */
  embeddingInputHash?: string;
  /** Произвольные метаданные чанка (теги, путь, диапазон строк). */
  metadata?: Record<string, unknown>;
}

/** Фильтр выборки индексов (`listIndexes`). Фильтры соединяются по «И». */
export interface MemoryIndexQuery {
  /** Только индексы этого namespace'а. */
  namespace?: string;
  /** Только индексы этого проекта. */
  projectId?: string;
  /** Только индексы этой области видимости (`project`/`instance`). */
  scope?: MemoryIndexScope;
  /** Только индексы этого провайдера. */
  providerId?: string;
  /** Только индексы в этих состояниях (одно состояние или список). */
  state?: MemoryIndexState | readonly MemoryIndexState[];
  /** Потолок выборки (дефолт 100, максимум 1000). */
  limit?: number;
  /** Пропуск записей (пагинация). */
  offset?: number;
}

/**
 * Порт хранилища индексов памяти и их чанков (ADR-096; PROP-047 §2.1).
 */
export interface MemoryIndexRepository {
  /** Upsert индекса по `id` (`createdAt` сохраняется, `updatedAt` обновляется). */
  saveIndex(index: MemoryIndexRecord): Promise<void>;
  /** Индекс по `id` (`null`, если нет). */
  getIndex(id: string): Promise<MemoryIndexRecord | null>;
  /** Индексы под фильтр (детерминированный порядок, пагинация). */
  listIndexes(query?: MemoryIndexQuery): Promise<MemoryIndexRecord[]>;
  /** Удаление индекса **каскадом** (чанки индекса удаляются). */
  deleteIndex(id: string): Promise<boolean>;
  /**
   * Смена состояния индекса (с необязательным текстом ошибки).
   *
   * @returns `false`, если индекса с таким `id` нет; иначе `true`.
   */
  setState(id: string, state: MemoryIndexState, error?: string): Promise<boolean>;

  /**
   * Атомарно заменить чанки поколения (старое поколение не трогается).
   *
   * @returns число записанных чанков.
   */
  replaceChunks(
    indexId: string,
    generation: number,
    chunks: readonly MemoryChunkRecord[],
  ): Promise<number>;
  /** Чанки индекса: фильтры `generation`/`documentId`, пагинация. */
  listChunks(
    indexId: string,
    opts?: { generation?: number; documentId?: string; limit?: number; offset?: number },
  ): Promise<MemoryChunkRecord[]>;
  /** Удалить чанки поколения (или все поколения индекса) — возвращает число удалённых. */
  deleteChunks(indexId: string, generation?: number): Promise<number>;
  /** Число чанков индекса (во всех поколениях или в одном). */
  countChunks(indexId: string, generation?: number): Promise<number>;
}
