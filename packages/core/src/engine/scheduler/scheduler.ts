import type { Schedule } from '@itphx/synth-shared';
import type { EventIngress } from '../events/ingest.js';
import type { ScheduleStore } from '../../storage/schedule-store.js';
import { nextRunAt } from './schedule-time.js';

export interface SchedulerServiceDeps {
  scheduleStore: ScheduleStore;
  ingress: EventIngress;
  /** Период тика, мс. По умолчанию 60 000. */
  tickMs?: number;
  /** TTL ephemeral-сессий по умолчанию (когда target его не задаёт). */
  defaultEphemeralTtl?: string;
  /** Источник времени (для тестов). */
  now?: () => Date;
}

/** Дефолтный период тика, если `tickMs` не задан. */
export const DEFAULT_SCHEDULER_TICK_MS = 60_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AD-051 (минимальный срез) / AD-089: cron/interval-планировщик.
 *
 * Не создаёт сессии сам: срабатывание публикует событие `{source:'cron',
 * type:'schedule_fired', payload:{scheduleId, name, text, ...}}` через
 * `EventIngress`; маршрутизацию выполняет `EventRouter` (`SchedulerRuleProvider`).
 *
 * Без catch-up: `nextRunAt` пересчитывается от текущего момента, пропущенные
 * срабатывания не догоняются. Гарантия от наложения — флаг `_busy` на тик.
 */
export class SchedulerService {
  private _store: ScheduleStore;
  private _ingress: EventIngress;
  private _tickMs: number;
  private _defaultEphemeralTtl: string;
  private _now: () => Date;
  private _timer?: ReturnType<typeof setInterval>;
  private _busy = false;

  constructor(deps: SchedulerServiceDeps) {
    this._store = deps.scheduleStore;
    this._ingress = deps.ingress;
    this._tickMs = deps.tickMs ?? DEFAULT_SCHEDULER_TICK_MS;
    this._defaultEphemeralTtl = deps.defaultEphemeralTtl ?? '24h';
    this._now = deps.now ?? (() => new Date());
  }

  /**
   * Вычисляет `nextRunAt` для всех включённых расписаний и запускает тикер
   * (`unref`, чтобы не держать event loop). Повторный вызов идемпотентен.
   */
  async start(): Promise<void> {
    if (this._timer) return;
    const now = this._now();
    const schedules = await this._store.list();
    for (const schedule of schedules) {
      if (schedule.enabled) await this._ensureNextRun(schedule, now);
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
   * Принудительный запуск расписания (в т.ч. выключенного): ingest с уникальным
   * dedup-ключом (полный timestamp), обновление `lastRunAt`/`nextRunAt`.
   * Возвращает обновлённое расписание либо `null`, если его нет.
   */
  async runNow(id: string): Promise<Schedule | null> {
    const schedule = await this._store.get(id);
    if (!schedule) return null;

    const at = this._now();
    const dedupKey = `cron:${schedule.id}:${at.toISOString()}`;
    await this._dispatch(schedule, at, dedupKey);
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
    try {
      const dedupKey = `cron:${schedule.id}:${at.toISOString().slice(0, 16)}`;
      await this._dispatch(schedule, at, dedupKey);
    } catch (err) {
      const error = errorMessage(err);
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

  /** Публикует событие и фиксирует успешный запуск с новым `nextRunAt`. */
  private async _dispatch(schedule: Schedule, at: Date, dedupKey: string): Promise<void> {
    await this._ingress.ingest({
      source: 'cron',
      type: 'schedule_fired',
      payload: {
        scheduleId: schedule.id,
        name: schedule.name,
        ...(schedule.payload ?? {}),
        text: schedule.prompt ?? schedule.name,
      },
      identity: schedule.ownerId ? { principalId: schedule.ownerId } : {},
      dedupKey,
    });
    const next = nextRunAt(schedule, at);
    await this._store.markRun(schedule.id, {
      at: at.toISOString(),
      status: 'ok',
      nextRunAt: next.toISOString(),
    });
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
