/**
 * Порт хранилища **фактов памяти** (ADR-096 — слой хранения; PROP-047 —
 * «Память Synth»).
 *
 * Факт — утверждение с провенансом, которое помнит плагин памяти: «деплой идёт
 * через Fleet (источник: сессия s-42)». Ключевые свойства модели (PROP-047 §5.2):
 * - **провенанс** — откуда взялось утверждение (`provenance`), без него факт
 *   неотличим от выдумки модели;
 * - **жизненный цикл** — `status` (`candidate` → `active` → `superseded` /
 *   `retracted`); исправление факта не переписывает его, а заводит новую
 *   версию и помечает старую (`supersededBy`);
 * - **версия** — `version` факта и история ревизий (`revisions`); версия
 *   факта и поколение индекса — независимые оси (PROP-047 §5.3);
 * - **namespace** — владелец записей (обычно `plugin:<имя плагина>`): порт
 *   обслуживает несколько независимых поставщиков памяти, поэтому запись
 *   всегда принадлежит namespace'у, а не «инстансу вообще».
 *
 * Порт хранит **данные**, а не логику памяти: RAG, консолидация, эмбеддинги и
 * retrieval живут в плагине (PROP-047 §3). Ядро владеет данными — отсюда
 * бэкап (ADR-091), `synth storage migrate` (ADR-097), retention и PostgreSQL
 * «бесплатно».
 *
 * Контракт (ADR-096) — «паспорт» порта, общий для всех backend'ов:
 * - `save` — **upsert по `id`**: `createdAt` записи не перезаписывается,
 *   `updatedAt` обновляется монотонно (паритет `record-timestamps.ts`);
 * - `list` — детерминированный порядок («свежие первыми»: `createdAt` убыв.,
 *   тайбрейкер `id`), фильтры — по «И», `limit` — дефолт 100 / потолок 1000
 *   (`resolveCollectionLimit`), `offset` — пропуск записей;
 * - `delete` — `true`, если запись была удалена, иначе `false`;
 * - `supersede` — **идемпотентно**: помечает факт заменённым (`status` →
 *   `superseded`, `supersededBy` → id новой версии); `false`, если факта нет;
 * - `count` — количество записей под теми же фильтрами (без `limit`/`offset`).
 */

/** Статус факта памяти (жизненный цикл утверждения). */
export type MemoryFactStatus = 'candidate' | 'active' | 'superseded' | 'retracted';

/**
 * Провенанс факта — откуда взялось утверждение.
 *
 * `sourceKind` — вид источника (`session`/`project`/`file`/`external`/…),
 * `sourceId` — его идентификатор. `uri`/`revision` — необязательные детали
 * (путь/ссылка и ревизия источника), `capturedAt` — ISO-момент захвата.
 */
export interface MemoryFactProvenance {
  /** Вид источника (`session`/`project`/`file`/`external`/…). */
  sourceKind: string;
  /** Идентификатор источника. */
  sourceId: string;
  /** Ссылка на источник (путь, URL, якорь в сессии). */
  uri?: string;
  /** Ревизия источника (хеш коммита, `seq` сообщения, версия документа). */
  revision?: string;
  /** ISO-момент захвата утверждения. */
  capturedAt: string;
}

/** Ревизия факта — предыдущая (или текущая) формулировка утверждения. */
export interface MemoryFactRevision {
  /** Номер версии факта, к которой относится ревизия. */
  version: number;
  /** Текст утверждения. */
  text: string;
  /** ISO-момент изменения. */
  changedAt: string;
  /** Причина изменения (коррекция, уточнение, консолидация). */
  reason?: string;
}

/** Запись факта памяти (то, что хранит порт). */
export interface MemoryFactRecord {
  /** Идентификатор факта (уникален в инстансе). */
  id: string;
  /** Владелец записей (обычно `plugin:<имя плагина>`). */
  namespace: string;
  /** Версия факта (монотонно растёт при коррекции). */
  version: number;
  /** Текст утверждения. */
  text: string;
  /** Вид факта (`decision`/`constraint`/`reference`/`preference`/`observation`/…). */
  kind: string;
  /** Проект-владелец утверждения (если утверждение проектное). */
  projectId?: string;
  /** Пользователь-владелец утверждения (если утверждение личное). */
  userId?: string;
  /** Провенанс (откуда утверждение). */
  provenance: MemoryFactProvenance;
  /** Уверенность в утверждении, 0..1. */
  confidence: number;
  /** Статус факта (жизненный цикл). */
  status: MemoryFactStatus;
  /** ISO-момент создания записи (иммутабельно при перезаписи). */
  createdAt: string;
  /** ISO-момент последней записи (монотонно не убывает). */
  updatedAt: string;
  /** ISO-момент, после которого утверждение перестаёт быть актуальным. */
  validUntil?: string;
  /** id новой версии (если факт заменён). */
  supersededBy?: string;
  /** История ревизий утверждения. */
  revisions?: MemoryFactRevision[];
  /** Произвольные метаданные (теги, веса, ссылки на сущности). */
  metadata?: Record<string, unknown>;
}

/** Фильтр выборки фактов (`list`/`count`). Фильтры соединяются по «И». */
export interface MemoryFactQuery {
  /** Только факты этого namespace'а. */
  namespace?: string;
  /** Только факты этого проекта. */
  projectId?: string;
  /** Только факты этого пользователя. */
  userId?: string;
  /** Только факты в этих статусах (один статус или список). */
  status?: MemoryFactStatus | readonly MemoryFactStatus[];
  /** Только факты этого вида. */
  kind?: string;
  /** Потолок выборки (дефолт 100, максимум 1000). */
  limit?: number;
  /** Пропуск записей (пагинация). */
  offset?: number;
}

/**
 * Порт хранилища фактов памяти (ADR-096; PROP-047 §2.1 «предпосылка A»).
 */
export interface MemoryFactRepository {
  /** Upsert факта по `id` (`createdAt` сохраняется, `updatedAt` обновляется). */
  save(fact: MemoryFactRecord): Promise<void>;
  /** Факт по `id` (`null`, если нет). */
  get(id: string): Promise<MemoryFactRecord | null>;
  /** Факты под фильтр (детерминированный порядок, пагинация). */
  list(query?: MemoryFactQuery): Promise<MemoryFactRecord[]>;
  /** Удаление факта (`true` — удалён, `false` — не было). */
  delete(id: string): Promise<boolean>;
  /**
   * Пометить старый факт заменённым новой версией (идемпотентно): статус
   * становится `superseded`, `supersededBy` — id новой версии.
   *
   * @returns `false`, если факта с таким `id` нет; иначе `true` (повторный
   *   вызов с тем же `nextId` тоже `true` — операция идемпотентна).
   */
  supersede(id: string, nextId: string): Promise<boolean>;
  /** Количество фактов под теми же фильтрами (без `limit`/`offset`). */
  count(query?: MemoryFactQuery): Promise<number>;
}
