/**
 * ADR-051 (минимальный срез) / ADR-089: контракты планировщика расписаний.
 *
 * Шедулер не создаёт сессии сам: срабатывание публикует нормализованное событие
 * (`source: 'cron'`, `type: 'schedule_fired'`) через `EventIngress`, а
 * маршрутизацию в сессию выполняет `EventRouter` (seam — `RouteRuleProvider`).
 * Здесь только типы без бизнес-логики; cron/interval-парсеры живут в core.
 */

/**
 * ADR-051/ADR-089: цель срабатывания расписания.
 * - `bound` — постоянная сессия (событие уходит в неё);
 * - `ephemeral` — разовая сессия с TTL и авто-архивом;
 * - `queue` — не запускать сразу, отложить владельцу;
 * - `pipeline` — прямой запуск прогона пайплайна (ADR-101): событие в Router
 *   **не** публикуется, шедулер запускает прогон сам.
 */
export type ScheduleTarget =
  | { mode: 'bound'; sessionId: string }
  | { mode: 'ephemeral'; agentTemplate?: string; project?: string; ttl?: string }
  | { mode: 'queue'; sessionId: string }
  | {
      mode: 'pipeline';
      /** Проект-владелец пайплайна (прогон живёт в проекте). */
      projectId: string;
      /** id пайплайна проекта (не шаблона). */
      pipelineId: string;
      /** Версия спецификации; по умолчанию — последняя опубликованная. */
      version?: number;
      /** Данные входа прогона → trigger.payload.* (напр. {sessionId}). */
      payload?: Record<string, unknown>;
    };

/** ADR-051/ADR-089: статус последнего запуска расписания. */
export type ScheduleRunStatus = 'ok' | 'error' | 'skipped';

/**
 * ADR-051: триггер срабатывания расписания.
 * - `cron` — обычный тик планировщика (или интервальное срабатывание);
 * - `manual` — принудительный запуск (`POST /:id/run`, force);
 * - `catchup` — догоняющее срабатывание после простоя.
 */
export type ScheduleJobTrigger = 'cron' | 'manual' | 'catchup';

/**
 * ADR-051: запись Job-истории — результат одного срабатывания расписания.
 *
 * Append-only JSONL `{dataDir}/scheduler/jobs.jsonl`. `decision` — итог
 * маршрутизации события (`RouteDecision['kind']`), `reason` — причина
 * `drop`/`skip`, `sessionId` — материализованная Router'ом сессия (если была).
 *
 * ADR-101: для цели `mode:'pipeline'` событие в Router не публикуется, поэтому
 * `decision:'pipeline'` — **пометка прямого запуска прогона**, а не решение
 * Router; `pipelineId`/`runId` адресуют запущенный прогон.
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
  /**
   * Решение Router: `'bound' | 'queue' | 'ephemeral' | 'bind' | 'drop'`;
   * `'pipeline'` — прямой запуск прогона пайплайна (ADR-101, не решение Router).
   */
  decision?: 'bound' | 'queue' | 'ephemeral' | 'bind' | 'drop' | 'pipeline';
  /** Причина `drop`/`skip` (напр. `no_route`, `busy`, `missed`). */
  reason?: string;
  /** Идентификатор сессии, в которую доставлено событие. */
  sessionId?: string;
  /** ADR-101: id пайплайна, прогон которого запущен расписанием. */
  pipelineId?: string;
  /** ADR-101: id запущенного прогона пайплайна. */
  runId?: string;
  /** Текст ошибки при `status === 'error'`. */
  error?: string;
}

/**
 * ADR-051/ADR-089: расписание запуска промпта/события.
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
   * ADR-051: поведение при пропущенном срабатывании на старте процесса
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
 * ADR-051/ADR-089: вход создания/обновления расписания — без служебных полей,
 * которыми управляет хранилище/сервис (`id`, таймстемпы, статус последнего запуска).
 */
export type ScheduleInput = Omit<
  Schedule,
  'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastError'
>;
