import type {
  Timer,
  TimerCreateInput,
  TimerFiring,
  TimerFilter,
  TimerPatch,
  TimerStatus,
} from '@itphx/synth-shared';

/**
 * Порт реестра таймеров/будильников (PROP-141, Часть B; ADR-096 — слой
 * хранения).
 *
 * Таймер — **персистентная** автоматизация: он переживает рестарт инстанса,
 * поэтому ближайшее срабатывание (`firesAt`) и статус лежат в хранилище, а не
 * в памяти процесса. Домен (движок `engine/timers/`) работает только через
 * этот порт; прямых записей в `$SYNTH_DATA_DIR` нет (инвариант 2).
 *
 * Семантика (общая для всех backend'ов):
 * - `create` — создаёт запись с id `tmr_<uuid>`, `createdAt`/`updatedAt` = now,
 *   статус по умолчанию — `active`;
 * - `list` — выборка с фильтрами по «И» (`sessionId`/`projectId`/`status`/
 *   `kind`), порядок — **по ближайшему срабатыванию** (`firesAt` возраст.,
 *   тайбрейкер `id`), затем постраничное смещение/потолок;
 * - `listDue` — «пора сработать»: `status = 'active'` и `firesAt <= at`,
 *   тот же порядок (движок тикает по ней);
 * - `countActive` — счётчик активных (`status = 'active'`) таймеров сессии
 *   (лимит 50 на сессию — движок);
 * - `update` — частичная правка (`name`/`comment`/`repeat`/`firesAt`/…),
 *   `updatedAt` = now; неизменяемые поля (`id`/`projectId`/`sessionId`/
 *   `ownerId`/`createdAt`) патчем не меняются;
 * - `setStatus` — смена статуса (+ необязательный доводок), `updatedAt` = now;
 * - `remove` — удалить запись; отсутствующая — `false` (не ошибка);
 * - `removeBySession` — каскадное удаление таймеров сессии (удаление сессии),
 *   число удалённых.
 */
export interface TimerRepository {
  /** Выборка таймеров; фильтры — по «И». */
  list(filter?: TimerFilter): Promise<Timer[]>;
  /** Запись по `id`; отсутствующая — `null`. */
  get(id: string): Promise<Timer | null>;
  /** Создать таймер (id `tmr_<uuid>`, таймстемпы — now). */
  create(input: TimerCreateInput & { firesAt: string }): Promise<Timer>;
  /** Частичная правка; отсутствующая запись — `null`. */
  update(id: string, patch: TimerPatch): Promise<Timer | null>;
  /** Удалить запись; отсутствующая — `false` (не ошибка). */
  remove(id: string): Promise<boolean>;
  /**
   * «Пора сработать»: активные записи с `firesAt <= at` (ISO-8601), порядок —
   * по `firesAt` возраст. Движок тикает по этой выборке.
   */
  listDue(at: string): Promise<Timer[]>;
  /** Счётчик активных таймеров сессии (лимит `TIMER_MAX_ACTIVE_PER_SESSION`). */
  countActive(sessionId: string): Promise<number>;
  /**
   * Сменить статус записи (+ необязательный доводок: `firedAt`/`lastError`/
   * `firesAt`); `updatedAt` = now. Отсутствующая запись — `null`.
   */
  setStatus(id: string, status: TimerStatus, patch?: TimerPatch): Promise<Timer | null>;
  /** Удалить все таймеры сессии; число удалённых. */
  removeBySession(sessionId: string): Promise<number>;
}

/**
 * Порт истории срабатываний таймеров (PROP-141, Часть B) — append-only
 * журнал в духе Job-истории планировщика (ADR-051).
 *
 * Семантика:
 * - `append` — дозапись одной записи (id `tmf_<uuid>` задаёт вызывающий,
 *   как в `JobRepository.append`);
 * - `list` — записи таймера **в порядке добавления** (старые → новые),
 *   `limit` — последние N (как у Job-истории);
 * - `prune` — удалить записи **строго старше** отсечки (`firedAt < before`),
 *   число удалённых; повторный вызов идемпотентен.
 */
export interface TimerFiringRepository {
  /** Дозаписать запись срабатывания. */
  append(firing: TimerFiring): Promise<void>;
  /** История срабатываний таймера (старые → новые; `limit` — последние N). */
  list(timerId: string, limit?: number): Promise<TimerFiring[]>;
  /** Retention-очистка: удалить записи старше `before` (ISO-8601). */
  prune(before: string): Promise<number>;
}
