/**
 * AD-051 (минимальный срез) / AD-089: контракты планировщика расписаний.
 *
 * Шедулер не создаёт сессии сам: срабатывание публикует нормализованное событие
 * (`source: 'cron'`, `type: 'schedule_fired'`) через `EventIngress`, а
 * маршрутизацию в сессию выполняет `EventRouter` (seam — `RouteRuleProvider`).
 * Здесь только типы без бизнес-логики; cron/interval-парсеры живут в core.
 */

/**
 * AD-051/AD-089: цель срабатывания расписания.
 * - `bound` — постоянная сессия (событие уходит в неё);
 * - `ephemeral` — разовая сессия с TTL и авто-архивом;
 * - `queue` — не запускать сразу, отложить владельцу.
 */
export type ScheduleTarget =
  | { mode: 'bound'; sessionId: string }
  | { mode: 'ephemeral'; agentTemplate?: string; project?: string; ttl?: string }
  | { mode: 'queue'; sessionId: string };

/** AD-051/AD-089: статус последнего запуска расписания. */
export type ScheduleRunStatus = 'ok' | 'error' | 'skipped';

/**
 * AD-051: триггер срабатывания расписания.
 * - `cron` — обычный тик планировщика (или интервальное срабатывание);
 * - `manual` — принудительный запуск (`POST /:id/run`, force);
 * - `catchup` — догоняющее срабатывание после простоя.
 */
export type ScheduleJobTrigger = 'cron' | 'manual' | 'catchup';

/**
 * AD-051: запись Job-истории — результат одного срабатывания расписания.
 *
 * Append-only JSONL `{dataDir}/scheduler/jobs.jsonl`. `decision` — итог
 * маршрутизации события (`RouteDecision['kind']`), `reason` — причина
 * `drop`/`skip`, `sessionId` — материализованная Router'ом сессия (если была).
 */
export interface ScheduleJob {
  /** `job_<uuid>`, уникален в пределах инстанса. */
  id: string;
  scheduleId: string;
  scheduleName: string;
  trigger: ScheduleJobTrigger;
  status: ScheduleRunStatus;
  /** Начало срабатывания, ISO-8601. */
  startedAt: string;
  /** Окончание срабатывания, ISO-8601. */
  finishedAt: string;
  durationMs: number;
  target: ScheduleTarget;
  /** Ключ идемпотентности события (`cron:<id>:<...>`). */
  dedupKey?: string;
  /** Решение Router: `'bound' | 'queue' | 'ephemeral' | 'drop'`. */
  decision?: 'bound' | 'queue' | 'ephemeral' | 'drop';
  /** Причина `drop`/`skip` (напр. `no_route`, `busy`, `missed`). */
  reason?: string;
  /** Идентификатор сессии, в которую доставлено событие. */
  sessionId?: string;
  /** Текст ошибки при `status === 'error'`. */
  error?: string;
}

/**
 * AD-051/AD-089: расписание запуска промпта/события.
 *
 * Ровно одно из `cron` (5 полей) / `every` (интервал) задано; время cron
 * считается в UTC. `payload` домешивается в тело события, `prompt` — текст
 * сообщения (`payload.text`).
 */
export interface Schedule {
  /** `sch_<uuid>`, уникален в пределах инстанса. */
  id: string;
  name: string;
  enabled: boolean;
  /** Cron-выражение из 5 полей (`minute hour day-of-month month day-of-week`), UTC. */
  cron?: string;
  /** Интервал `30s | 15m | 1h | 24h`. */
  every?: string;
  target: ScheduleTarget;
  /** Текст промпта (попадает в событие как `payload.text`). */
  prompt?: string;
  /** Дополнительные поля тела события. */
  payload?: Record<string, unknown>;
  /** Владелец расписания (попадает в `identity.principalId`). */
  ownerId?: string;
  /**
   * AD-051: поведение при пропущенном срабатывании на старте процесса
   * (`skip` — пропустить, `once` — одно догоняющее). Не задано — дефолт из
   * конфига `scheduler.catchUp`.
   */
  catchUp?: 'skip' | 'once';
  createdAt: string;
  updatedAt: string;
  /** Время последнего запуска, ISO-8601. */
  lastRunAt?: string;
  /** Время следующего запуска, ISO-8601. */
  nextRunAt?: string;
  lastStatus?: ScheduleRunStatus;
  lastError?: string;
}

/**
 * AD-051/AD-089: вход создания/обновления расписания — без служебных полей,
 * которыми управляет хранилище/сервис (`id`, таймстемпы, статус последнего запуска).
 */
export type ScheduleInput = Omit<
  Schedule,
  'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastError'
>;
