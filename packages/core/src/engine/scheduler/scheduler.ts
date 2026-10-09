import type { Schedule, ScheduleJob, ScheduleJobTrigger } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import type { EventIngress } from '../events/ingest.js';
import type { ScheduleStore } from '../../storage/schedule-store.js';
import type { JobStore } from '../../storage/job-store.js';
import { nextRunAt } from './schedule-time.js';

export interface SchedulerServiceDeps {
  scheduleStore: ScheduleStore;
  ingress: EventIngress;
  /** История срабатываний (AD-051); без неё Job не пишутся. */
  jobStore?: JobStore;
  /** Период тика, мс. По умолчанию 60 000. */
  tickMs?: number;
  /** TTL ephemeral-сессий по умолчанию (когда target его не задаёт). */
  defaultEphemeralTtl?: string;
  /** Дефолт catch-up расписаний (`skip`/`once`). По умолчанию `skip`. */
  catchUp?: 'skip' | 'once';
  /** Срок хранения Job-истории, дни. По умолчанию 30. */
  jobRetentionDays?: number;
  /** Источник времени (для тестов). */
  now?: () => Date;
}

/** Дефолтный период тика, если `tickMs` не задан. */
export const DEFAULT_SCHEDULER_TICK_MS = 60_000;

/** Дефолтный срок хранения Job-истории, дни. */
export const DEFAULT_JOB_RETENTION_DAYS = 30;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AD-051 / AD-089: cron/interval-планировщик с Job-историей и catch-up.
 *
 * Не создаёт сессии сам: срабатывание публикует событие `{source:'cron',
 * type:'schedule_fired', payload:{scheduleId, name, text, ...}}` через
 * `EventIngress`; маршрутизацию выполняет `EventRouter` (`SchedulerRuleProvider`).
 *
 * Catch-up после простоя: на старте расписание с `nextRunAt` в прошлом либо
 * догоняется одним срабатыванием (`trigger:'catchup'`), либо помечается Job
 * `skipped` (`reason:'missed'`) с пересчётом `nextRunAt`. Ограничение наложения —
 * in-flight guard по `scheduleId` плюс флаг `_busy` на тик.
 */
export class SchedulerService {
  private _store: ScheduleStore;
  private _ingress: EventIngress;
  private _jobStore?: JobStore;
  private _tickMs: number;
  private _defaultEphemeralTtl: string;
  private _catchUp: 'skip' | 'once';
  private _jobRetentionDays: number;
  private _now: () => Date;
  private _timer?: ReturnType<typeof setInterval>;
  private _busy = false;
  /** Защита от параллельного запуска одного расписания. */
  private _inFlight = new Set<string>();

  constructor(deps: SchedulerServiceDeps) {
    this._store = deps.scheduleStore;
    this._ingress = deps.ingress;
    this._jobStore = deps.jobStore;
    this._tickMs = deps.tickMs ?? DEFAULT_SCHEDULER_TICK_MS;
    this._defaultEphemeralTtl = deps.defaultEphemeralTtl ?? '24h';
    this._catchUp = deps.catchUp ?? 'skip';
    this._jobRetentionDays = deps.jobRetentionDays ?? DEFAULT_JOB_RETENTION_DAYS;
    this._now = deps.now ?? (() => new Date());
  }

  /**
   * Планирует `nextRunAt` для включённых расписаний, обрабатывает catch-up,
   * чистит Job-историю и запускает тикер (`unref`). Повторный вызов идемпотентен.
   */
  async start(): Promise<void> {
    if (this._timer) return;
    const now = this._now();

    // Retention Job-истории — best-effort, не роняет старт сервиса.
    if (this._jobStore) {
      try {
        await this._jobStore.prune(this._jobRetentionDays);
      } catch (err) {
        console.warn(`[scheduler] prune Job-истории не удался: ${errorMessage(err)}`);
      }
    }

    const schedules = await this._store.list();
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      await this._catchUpOnStart(schedule, now);
    }

    this._timer = setInterval(() => {
      void this.tick();
    }, this._tickMs);
    this._timer.unref?.();
  }

  stop(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = undefined;
  }

  /** Список расписаний (проксирует store; `nextRunAt` актуален). */
  async list(): Promise<Schedule[]> {
    return this._store.list();
  }

  /**
   * Один проход по расписаниям: срабатывают включённые, у которых `nextRunAt`
   * уже наступил. Публичный — для тестов. Ошибка одного расписания не роняет тик.
   */
  async tick(at?: Date): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    try {
      const now = at ?? this._now();
      const schedules = await this._store.list();
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (!schedule.nextRunAt) {
          await this._ensureNextRun(schedule, now);
          continue;
        }
        const due = new Date(schedule.nextRunAt);
        if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) continue;
        await this._runDue(schedule, now);
      }
    } finally {
      this._busy = false;
    }
  }

  /**
   * Принудительный запуск расписания (в т.ч. выключенного — force): ingest с
   * уникальным dedup-ключом, Job `trigger:'manual'`, обновление
   * `lastRunAt`/`nextRunAt`. Возвращает обновлённое расписание либо `null`.
   */
  async runNow(id: string, opts?: { force?: boolean }): Promise<Schedule | null> {
    const schedule = await this._store.get(id);
    if (!schedule) return null;

    const at = this._now();
    const force = opts?.force ?? true;
    const dedupKey = `cron:${schedule.id}:manual:${at.toISOString()}`;
    await this._dispatchSafe(schedule, at, dedupKey, 'manual', { force });
    return this._store.get(id);
  }

  /**
   * Пересчитывает `nextRunAt` расписания (create/update через API). Выключенное
   * расписание теряет `nextRunAt`.
   */
  async refreshNextRun(id: string): Promise<Schedule | null> {
    const schedule = await this._store.get(id);
    if (!schedule) return null;
    if (!schedule.enabled) return this._store.setNextRun(id, undefined);
    await this._ensureNextRun(schedule, this._now());
    return this._store.get(id);
  }

  /**
   * Catch-up на старте: расписание без `nextRunAt` — планируется; с `nextRunAt`
   * в будущем — оставляется как есть; с `nextRunAt` в прошлом — либо одно
   * догоняющее срабатывание, либо Job `skipped` (`missed`) + пересчёт.
   */
  private async _catchUpOnStart(schedule: Schedule, now: Date): Promise<void> {
    if (!schedule.nextRunAt) {
      await this._ensureNextRun(schedule, now);
      return;
    }

    const due = new Date(schedule.nextRunAt);
    if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) return;

    const mode = schedule.catchUp ?? this._catchUp;
    if (mode === 'once') {
      const dedupKey = `cron:${schedule.id}:catchup:${now.toISOString()}`;
      await this._dispatchSafe(schedule, now, dedupKey, 'catchup');
      return;
    }

    await this._recordJob({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      trigger: 'catchup',
      status: 'skipped',
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      target: schedule.target,
      reason: 'missed',
    });
    await this._ensureNextRun(schedule, now);
  }

  /** Считает и сохраняет `nextRunAt`; ошибки конфигурации фиксируются как `error`. */
  private async _ensureNextRun(schedule: Schedule, from: Date): Promise<void> {
    try {
      const next = nextRunAt(schedule, from);
      await this._store.setNextRun(schedule.id, next.toISOString());
    } catch (err) {
      await this._store
        .markRun(schedule.id, {
          at: schedule.lastRunAt ?? from.toISOString(),
          status: 'error',
          error: errorMessage(err),
        })
        .catch(() => {});
      console.warn(`[scheduler] расписание "${schedule.id}" не запланировано: ${errorMessage(err)}`);
    }
  }

  /** Обрабатывает наступившее срабатывание; ошибки не выходят наружу. */
  private async _runDue(schedule: Schedule, at: Date): Promise<void> {
    const dedupKey = `cron:${schedule.id}:${at.toISOString().slice(0, 16)}`;
    await this._dispatchSafe(schedule, at, dedupKey, 'cron');
  }

  /**
   * Обёртка над `_dispatch`: при исключении пишет Job `status:'error'` и
   * фиксирует ошибку в расписании (не роняя тик).
   */
  private async _dispatchSafe(
    schedule: Schedule,
    at: Date,
    dedupKey: string,
    trigger: ScheduleJobTrigger,
    opts?: { force?: boolean },
  ): Promise<void> {
    const started = this._now();
    try {
      await this._dispatch(schedule, at, dedupKey, trigger, opts);
    } catch (err) {
      const error = errorMessage(err);
      const finished = this._now();
      await this._recordJob({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        trigger,
        status: 'error',
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        target: schedule.target,
        dedupKey,
        error,
      }).catch(() => {});
      try {
        const next = nextRunAt(schedule, at);
        await this._store.markRun(schedule.id, {
          at: at.toISOString(),
          status: 'error',
          error,
          nextRunAt: next.toISOString(),
        });
      } catch {
        await this._store
          .markRun(schedule.id, { at: at.toISOString(), status: 'error', error })
          .catch(() => {});
      }
      console.warn(`[scheduler] запуск расписания "${schedule.id}" завершился ошибкой: ${error}`);
    }
  }

  /**
   * Публикует событие, пишет Job и фиксирует результат с новым `nextRunAt`.
   * Повторный запуск того же расписания, пока предыдущий не завершён, —
   * Job `skipped` (`reason:'busy'`) без публикации события.
   */
  private async _dispatch(
    schedule: Schedule,
    at: Date,
    dedupKey: string,
    trigger: ScheduleJobTrigger,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (this._inFlight.has(schedule.id)) {
      const atIso = at.toISOString();
      await this._recordJob({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        trigger,
        status: 'skipped',
        startedAt: atIso,
        finishedAt: atIso,
        durationMs: 0,
        target: schedule.target,
        dedupKey,
        reason: 'busy',
      });
      return;
    }

    this._inFlight.add(schedule.id);
    const started = this._now();
    try {
      const payload: Record<string, unknown> = {
        scheduleId: schedule.id,
        name: schedule.name,
        ...(schedule.payload ?? {}),
        text: schedule.prompt ?? schedule.name,
      };
      if (opts?.force) payload.force = true;

      const { decision, session } = await this._ingress.ingest({
        source: 'cron',
        type: 'schedule_fired',
        payload,
        identity: schedule.ownerId ? { principalId: schedule.ownerId } : {},
        dedupKey,
      });

      const finished = this._now();
      const dropped = decision.kind === 'drop';
      await this._recordJob({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        trigger,
        status: dropped ? 'skipped' : 'ok',
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        target: schedule.target,
        dedupKey,
        decision: decision.kind,
        reason: dropped ? decision.reason : undefined,
        sessionId: session?.id,
      });

      const next = nextRunAt(schedule, at);
      await this._store.markRun(schedule.id, {
        at: at.toISOString(),
        status: dropped ? 'skipped' : 'ok',
        nextRunAt: next.toISOString(),
      });
    } finally {
      this._inFlight.delete(schedule.id);
    }
  }

  /** Дозапись Job в историю (`job_<uuid>`); без `jobStore` — no-op. */
  private async _recordJob(job: Omit<ScheduleJob, 'id'>): Promise<void> {
    if (!this._jobStore) return;
    try {
      await this._jobStore.append({ id: `job_${generateId()}`, ...job });
    } catch (err) {
      console.warn(`[scheduler] не удалось записать Job: ${errorMessage(err)}`);
    }
  }
}

/**
 * Создаёт и запускает `SchedulerService`; ошибки старта логируются и не
 * пробрасываются (сервис не должен ронять процесс).
 */
export function startScheduler(deps: SchedulerServiceDeps): SchedulerService {
  const service = new SchedulerService(deps);
  void service.start().catch((err) => {
    console.warn(`[scheduler] не удалось запустить: ${errorMessage(err)}`);
  });
  return service;
}
