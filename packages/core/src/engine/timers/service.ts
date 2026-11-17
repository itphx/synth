/**
 * PROP-141 (Часть B): движок таймеров и будильников.
 *
 * Один движок на два вида автоматизации (`timer` — относительный отсчёт,
 * `alarm` — абсолютное время/повтор). Ключевые решения:
 *
 * - **Второго тикера нет.** Выбор лидера переиспользует шедулер
 *   (`engine/scheduler/leader.ts`: `AlwaysLeader`/`FileLeader`/PG) — срабатывает
 *   только лидер (ADR-051/ADR-089).
 * - **Точность ~1 с.** На ближайшее `firesAt` ставится **единичный**
 *   `setTimeout` (не `setInterval`), который пересоздаётся после каждого
 *   срабатывания/правки; страховочный тик раз в 30 с ловит дрейф часов и
 *   пропущенные окна. Таймеры — `unref()`: процесс не держится из-за них.
 * - **Персистентность — в портах.** `setTimeout` живёт в control plane и не
 *   заменяет хранилище: после рестарта движок восстанавливает состояние из
 *   `TimerRepository` (ADR-096).
 * - **Catch-up.** Просроченный one-shot срабатывает **один раз** с меткой
 *   `catchup`; `daily`/`every` пересчитывают `firesAt` от текущего времени —
 *   серии догонов не бывает.
 * - **Дедуп** — по `(timerId, scheduledFor)`: in-flight множество плюс
 *   последние записи истории срабатываний. Повторный тик и смена лидера не
 *   дают двух сообщений.
 * - **Доставка — инъекция** (`deliver`): движок не знает ни про шину событий,
 *   ни про механизм фоновых процессов (этап 4 PROP-141 подключает доставку).
 */
import type {
  Timer,
  TimerFiring,
  TimerFiringOutcome,
  TimerKind,
  TimerPatch,
  TimerRepeat,
} from '@itphx/synth-shared';
import {
  TIMER_COMMENT_MAX,
  TIMER_MAX_ACTIVE_PER_SESSION,
  TIMER_MAX_INTERVAL_SEC,
  TIMER_MIN_INTERVAL_SEC,
  TIMER_ONE_SHOT_HORIZON_DAYS,
  TIMER_TIME_REGEX,
  generateId,
  nowISO,
} from '@itphx/synth-shared';
import type { TimerFiringRepository, TimerRepository } from '../../storage/ports/timer-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { SecurityAuditAction } from '@itphx/synth-shared';
import type { TimerMetricsHooks } from '../../metrics/collectors/timers.js';
import { AlwaysLeader } from '../scheduler/leader.js';
import type { SchedulerLeader } from '../scheduler/leader.js';
import { isValidTimezone, nextFireForRepeat, resolveFirstFire } from './next-fire.js';
import { TimerLimitExceededError, TimerValidationError } from './types.js';
import type { TimerDeliver, TimerIntent, TimerUpdatePatch } from './types.js';

/** Страховочный тик (ловит дрейф часов и пропущенные окна), мс. */
export const TIMER_SAFETY_TICK_MS = 30_000;

/**
 * Граница «догоняющего» срабатывания: опоздание больше страховочного тика
 * означает, что окно было пропущено (рестарт/просевший тик) — такое срабатывание
 * помечается `catchup`.
 */
export const TIMER_CATCHUP_LAG_MS = 30_000;

/** Сколько последних срабатываний таймера проверяется на дедуп. */
export const TIMER_DEDUP_HISTORY = 20;

/** Максимальная задержка `setTimeout` в Node (2^31−1 мс) — длинные горизонты ведёт страховочный тик. */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/** Потолок выборки активных таймеров для пересчёта метрики и планирования. */
const ACTIVE_LIST_LIMIT = 1000;

/** Секунд в сутках (перевод горизонта из shared-константы). */
const SECONDS_PER_DAY = 86_400;

/** Горизонт one-shot в секундах (из `TIMER_ONE_SHOT_HORIZON_DAYS`). */
const ONE_SHOT_HORIZON_SEC = TIMER_ONE_SHOT_HORIZON_DAYS * SECONDS_PER_DAY;

/** Действия аудита таймеров (входят в `SECURITY_AUDIT_ACTIONS`). */
export type TimerAuditAction = Extract<SecurityAuditAction, 'create' | 'update' | 'remove' | 'fire'>;

/**
 * PROP-141 (Часть B): live-события таймеров в канале сессии.
 *
 * Типы — `timer.created`/`timer.updated`/`timer.fired`/`timer.cancelled`
 * (шина сессии, ADR-009/ADR-024; новых каналов нет). Payload — только
 * метаданные (id/вид/статус/время): комментарий таймера — пользовательский
 * текст, в live-событие он не попадает.
 */
export type TimerEventType = 'timer.created' | 'timer.updated' | 'timer.fired' | 'timer.cancelled';

/** Колбэк публикации live-события таймера в канал сессии. */
export type TimerEventPublisher = (
  sessionId: string,
  type: TimerEventType,
  data: Record<string, unknown>,
) => void;

/** Зависимости движка таймеров. */
export interface TimerServiceDeps {
  /** Реестр таймеров/будильников (порт слоя хранения, ADR-096). */
  timers: TimerRepository;
  /** История срабатываний (append-only, порт слоя хранения). */
  firings: TimerFiringRepository;
  /** Доставка срабатывания (инъекция; подключается на этапе 4). */
  deliver: TimerDeliver;
  /**
   * Лидер-выбор (переиспользуется шедулер, ADR-051/ADR-089). По умолчанию
   * `AlwaysLeader` (single-process).
   */
  leader?: SchedulerLeader;
  /** Источник времени (для тестов). */
  clock?: () => Date;
  /** Метрики (ADR-094); не заданы — метрики не пишутся. */
  metrics?: TimerMetricsHooks;
  /** Аудит изменений (best-effort); не задан — аудит не пишется. */
  audit?: SecurityAuditRepository;
  /**
   * PROP-141 (Часть B): публикация live-событий в канал сессии. Не задана —
   * события не публикуются (движок работает как раньше).
   */
  onEvent?: TimerEventPublisher;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Краткое описание таймера для аудита (без пользовательского текста). */
function describeTimer(timer: Timer | null): Record<string, unknown> | null {
  if (!timer) return null;
  return {
    timerId: timer.id,
    kind: timer.kind,
    status: timer.status,
    repeat: timer.repeat.mode,
    sessionId: timer.sessionId,
    projectId: timer.projectId,
    firesAt: timer.firesAt,
  };
}

/**
 * Движок таймеров и будильников (PROP-141, Часть B).
 *
 * Жизненный цикл: `createTimer` → (`pauseTimer`/`resumeTimer`/`updateTimer`) →
 * срабатывание → `removeTimer`; каскад `onSessionDeleted` снимает записи
 * сессии (история срабатываний остаётся).
 */
export class TimerService {
  private readonly _timers: TimerRepository;
  private readonly _firings: TimerFiringRepository;
  private readonly _deliver: TimerDeliver;
  private readonly _leader: SchedulerLeader;
  private readonly _clock: () => Date;
  private readonly _metrics?: TimerMetricsHooks;
  private readonly _audit?: SecurityAuditRepository;
  private readonly _onEvent?: TimerEventPublisher;

  private _isLeader = false;
  private _started = false;
  private _busy = false;
  private _nextTimer?: ReturnType<typeof setTimeout>;
  private _safetyTimer?: ReturnType<typeof setInterval>;
  /** Ключи срабатываний в полёте (`timerId|scheduledFor`). */
  private readonly _inFlight = new Set<string>();
  /** Текущий тик (для `stop()` — дождаться незавершённой доставки). */
  private _pending?: Promise<void>;

  constructor(deps: TimerServiceDeps) {
    this._timers = deps.timers;
    this._firings = deps.firings;
    this._deliver = deps.deliver;
    this._leader = deps.leader ?? new AlwaysLeader();
    this._clock = deps.clock ?? (() => new Date());
    this._metrics = deps.metrics;
    this._audit = deps.audit;
    this._onEvent = deps.onEvent;
  }

  /**
   * Запустить движок: стать лидером, догнать просроченное, включить таймер
   * ближайшего срабатывания и страховочный тик. Повторный вызов идемпотентен.
   *
   * Не-лидер тик не запускает (срабатывает только владелец лок-а).
   */
  async start(): Promise<void> {
    if (this._started) return;
    if (!(await this._leader.acquire())) {
      console.warn('[timers] не удалось стать лидером — тикер не запущен');
      return;
    }
    this._isLeader = true;

    await this._catchUpOnStart();

    this._safetyTimer = setInterval(() => {
      void this._tickInternal();
    }, TIMER_SAFETY_TICK_MS);
    this._safetyTimer.unref?.();

    await this._refreshSchedule();
    this._started = true;
  }

  /** Остановить движок: снять таймеры, дождаться доставки в полёте, отпустить лидерство. */
  async stop(): Promise<void> {
    if (this._nextTimer) {
      clearTimeout(this._nextTimer);
      this._nextTimer = undefined;
    }
    if (this._safetyTimer) {
      clearInterval(this._safetyTimer);
      this._safetyTimer = undefined;
    }
    this._started = false;

    if (this._isLeader) {
      this._isLeader = false;
      try {
        await this._leader.release();
      } catch (err) {
        console.warn(`[timers] не удалось освободить лидерство: ${errorMessage(err)}`);
      }
    }

    const pending = this._pending;
    if (pending) {
      await pending.catch(() => {
        // ошибка тика не должна ломать остановку
      });
    }
  }

  /**
   * Один проход по просроченным таймерам: срабатывание → доставка → запись в
   * историю → пересчёт следующего срабатывания.
   *
   * Публичный — для тестов и для ручного прогона. Не-лидер не тикает.
   */
  async tick(at?: Date): Promise<void> {
    if (!this._isLeader) return;
    if (this._busy) return;
    this._busy = true;
    const run = this._runTick(at).finally(() => {
      this._busy = false;
    });
    this._pending = run;
    try {
      await run;
    } finally {
      if (this._pending === run) this._pending = undefined;
    }
  }

  /** Создать таймер/будильник (с валидацией и лимитами). */
  async createTimer(intent: TimerIntent): Promise<Timer> {
    const now = this._clock();
    this._validateIntent(intent, now);

    const active = await this._timers.countActive(intent.sessionId);
    if (active >= TIMER_MAX_ACTIVE_PER_SESSION) {
      throw new TimerLimitExceededError(
        TIMER_MAX_ACTIVE_PER_SESSION,
        `Достигнут лимит активных таймеров на сессию (${TIMER_MAX_ACTIVE_PER_SESSION})`,
      );
    }

    const firesAt = resolveFirstFire(intent, now);
    const timer = await this._timers.create({
      kind: intent.kind,
      ...(intent.name !== undefined ? { name: intent.name } : {}),
      comment: intent.comment,
      projectId: intent.projectId,
      sessionId: intent.sessionId,
      ownerId: intent.ownerId,
      repeat: intent.repeat,
      status: 'active',
      firesAt: firesAt.toISOString(),
    });

    await this._refreshSchedule();
    await this._auditOp('create', timer, null, describeTimer(timer));
    this._publish('timer.created', timer);
    return timer;
  }

  /**
   * Частично изменить таймер. Отсутствующая запись — `null`.
   *
   * Смена правила повтора без явного `firesAt` пересчитывает ближайшее
   * срабатывание от текущего времени.
   */
  async updateTimer(id: string, patch: TimerUpdatePatch): Promise<Timer | null> {
    const current = await this._timers.get(id);
    if (!current) return null;

    const next: TimerUpdatePatch = { ...patch };
    if (patch.comment !== undefined) this._validateComment(patch.comment);
    if (patch.repeat !== undefined) {
      this._validateRepeat(patch.repeat);
      if (patch.firesAt === undefined) {
        const firesAt = this._nextFireAfter(patch.repeat, this._clock());
        if (firesAt) next.firesAt = firesAt.toISOString();
      }
    }

    const updated = await this._timers.update(id, next);
    if (!updated) return null;

    await this._refreshSchedule();
    await this._auditOp('update', updated, describeTimer(current), describeTimer(updated));
    this._publish('timer.updated', updated);
    return updated;
  }

  /** Удалить таймер (история срабатываний остаётся). */
  async removeTimer(id: string): Promise<boolean> {
    const current = await this._timers.get(id);
    const removed = await this._timers.remove(id);
    if (removed) {
      await this._refreshSchedule();
      await this._auditOp('remove', current, describeTimer(current), null);
      if (current) this._publish('timer.cancelled', current, { status: 'cancelled' });
    }
    return removed;
  }

  /** Поставить таймер на паузу (срабатывание не наступит). */
  async pauseTimer(id: string): Promise<Timer | null> {
    const current = await this._timers.get(id);
    if (!current) return null;
    const paused = await this._timers.setStatus(id, 'paused');
    if (!paused) return null;
    await this._refreshSchedule();
    await this._auditOp('update', paused, describeTimer(current), describeTimer(paused));
    this._publish('timer.updated', paused);
    return paused;
  }

  /**
   * Снять таймер с паузы.
   *
   * Для повторяющихся (`daily`/`every`) ближайшее срабатывание пересчитывается
   * от текущего времени — пропущенные окна не догоняются. У одноразового
   * таймера исходная задержка не хранится, поэтому плановая метка
   * сохраняется: просроченный one-shot сработает как догон.
   */
  async resumeTimer(id: string): Promise<Timer | null> {
    const current = await this._timers.get(id);
    if (!current) return null;

    const patch: TimerPatch = { status: 'active' };
    const firesAt = this._nextFireAfter(current.repeat, this._clock());
    if (firesAt) patch.firesAt = firesAt.toISOString();

    const resumed = await this._timers.update(id, patch);
    if (!resumed) return null;
    await this._refreshSchedule();
    await this._auditOp('update', resumed, describeTimer(current), describeTimer(resumed));
    this._publish('timer.updated', resumed);
    return resumed;
  }

  /**
   * Каскад удаления сессии: записи таймеров снимаются, **история срабатываний
   * остаётся**. Возвращает число снятых записей.
   */
  async onSessionDeleted(sessionId: string): Promise<number> {
    const removed = await this._timers.removeBySession(sessionId);
    await this._refreshSchedule();
    return removed;
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────

  /** Тело тика: выборка просроченных → срабатывания → пересчёт расписания. */
  private async _runTick(at?: Date): Promise<void> {
    const now = at ?? this._clock();
    let due: Timer[];
    try {
      due = await this._timers.listDue(now.toISOString());
    } catch (err) {
      console.warn(`[timers] выборка просроченных таймеров не удалась: ${errorMessage(err)}`);
      return;
    }

    for (const timer of due) {
      await this._fire(timer, now, this._isCatchup(timer, now));
    }

    await this._refreshSchedule();
  }

  /** Тик по таймеру (единичный `setTimeout` на ближайшее срабатывание). */
  private async _onTimeout(): Promise<void> {
    this._nextTimer = undefined;
    await this._tickInternal();
  }

  /** Тик со страховкой: ошибка тика не должна ронять движок. */
  private async _tickInternal(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      console.warn(`[timers] тик не удался: ${errorMessage(err)}`);
    }
  }

  /**
   * Догон после рестарта/простоя.
   *
   * - просроченный **one-shot** срабатывает ровно один раз (метка `catchup`);
   * - `daily`/`every` пересчитывают `firesAt` от текущего времени — серии
   *   догонов не бывает;
   * - `fired`/`cancelled`/`paused` не воскресают (в выборке — только активные).
   */
  private async _catchUpOnStart(): Promise<void> {
    const now = this._clock();
    let active: Timer[];
    try {
      active = await this._timers.list({ status: 'active', limit: ACTIVE_LIST_LIMIT });
    } catch (err) {
      console.warn(`[timers] выборка активных таймеров не удалась: ${errorMessage(err)}`);
      return;
    }

    for (const timer of active) {
      const scheduled = Date.parse(timer.firesAt);
      if (Number.isNaN(scheduled) || scheduled > now.getTime()) continue;

      if (timer.repeat.mode === 'once') {
        await this._fire(timer, now, true);
        continue;
      }

      const next = this._nextFireAfter(timer.repeat, now);
      if (!next) continue;
      await this._timers.update(timer.id, { firesAt: next.toISOString() });
    }
  }

  /**
   * Сработавший таймер: дедуп → доставка → запись в историю → смена статуса.
   *
   * Ошибка доставки не останавливает движок: исход `error`, текст — в
   * `lastError`; одноразовый таймер после ошибки всё равно становится
   * `fired` (иначе он зациклится), повторяющийся — уходит на следующий цикл.
   */
  private async _fire(timer: Timer, now: Date, catchup: boolean): Promise<void> {
    const scheduledMs = Date.parse(timer.firesAt);
    if (Number.isNaN(scheduledMs)) return;
    const scheduledFor = new Date(scheduledMs).toISOString();
    const key = `${timer.id}|${scheduledFor}`;

    if (this._inFlight.has(key)) return;
    if (await this._alreadyFired(timer.id, scheduledFor)) return;

    this._inFlight.add(key);
    try {
      const lagMs = now.getTime() - scheduledMs;
      const firing: TimerFiring = {
        id: `tmf_${generateId()}`,
        timerId: timer.id,
        firedAt: now.toISOString(),
        scheduledFor,
        lagMs,
        outcome: 'ok',
        sessionId: timer.sessionId,
      };

      let outcome: TimerFiringOutcome = 'ok';
      let failure: string | undefined;
      try {
        await this._deliver(timer, firing, { catchup });
      } catch (err) {
        outcome = 'error';
        failure = errorMessage(err);
      }
      firing.outcome = outcome;

      await this._appendFiring(firing);
      this._reportFiring({ kind: timer.kind, outcome, lagSeconds: lagMs / 1000 });
      // PROP-141: live-событие срабатывания — в канал сессии (метаданные).
      this._publish('timer.fired', timer, {
        fired_at: firing.firedAt,
        scheduled_for: firing.scheduledFor,
      });

      if (outcome === 'error') {
        console.warn(`[timers] доставка таймера "${timer.id}" не удалась: ${failure ?? 'неизвестная ошибка'}`);
        await this._auditOp('fire', timer, null, {
          timerId: timer.id,
          kind: timer.kind,
          outcome,
          error: failure ?? 'unknown_error',
        });
      }

      await this._applyFiringResult(timer, now, failure);
    } finally {
      this._inFlight.delete(key);
    }
  }

  /** Итог срабатывания в записи таймера: one-shot — `fired`, повтор — следующий цикл. */
  private async _applyFiringResult(timer: Timer, now: Date, failure: string | undefined): Promise<void> {
    const errorPatch = failure === undefined ? null : failure;

    if (timer.repeat.mode === 'once') {
      await this._timers.setStatus(timer.id, 'fired', {
        firedAt: now.toISOString(),
        lastError: errorPatch,
      });
      return;
    }

    const patch: TimerPatch = { status: 'active', lastError: errorPatch };
    let next = this._nextFireAfter(timer.repeat, new Date(timer.firesAt));
    // Просевший тик/долгий простой: не догоняем серию — считаем один цикл
    // от фактического момента.
    if (!next || next.getTime() <= now.getTime()) {
      next = this._nextFireAfter(timer.repeat, now);
    }
    if (next) patch.firesAt = next.toISOString();
    await this._timers.update(timer.id, patch);
  }

  /** Ближайшее срабатывание по правилу повтора (для `once` — `null`). */
  private _nextFireAfter(repeat: TimerRepeat, from: Date): Date | null {
    return nextFireForRepeat(repeat, from);
  }

  /** Догоняющее ли срабатывание (опоздание больше страховочного тика). */
  private _isCatchup(timer: Timer, now: Date): boolean {
    const scheduled = Date.parse(timer.firesAt);
    if (Number.isNaN(scheduled)) return false;
    return now.getTime() - scheduled > TIMER_CATCHUP_LAG_MS;
  }

  /** Уже срабатывал ли таймер на этом плановом времени (по истории). */
  private async _alreadyFired(timerId: string, scheduledFor: string): Promise<boolean> {
    try {
      const recent = await this._firings.list(timerId, TIMER_DEDUP_HISTORY);
      return recent.some((firing) => firing.scheduledFor === scheduledFor);
    } catch (err) {
      console.warn(`[timers] история срабатываний недоступна: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Дозапись в историю срабатываний (best-effort). */
  private async _appendFiring(firing: TimerFiring): Promise<void> {
    try {
      await this._firings.append(firing);
    } catch (err) {
      console.warn(`[timers] не удалось записать срабатывание: ${errorMessage(err)}`);
    }
  }

  /**
   * Пересчитать расписание: единичный `setTimeout` на ближайшее срабатывание
   * + счётчики активных таймеров для метрик.
   */
  private async _refreshSchedule(): Promise<void> {
    let active: Timer[] = [];
    try {
      active = await this._timers.list({ status: 'active', limit: ACTIVE_LIST_LIMIT });
    } catch (err) {
      console.warn(`[timers] выборка активных таймеров не удалась: ${errorMessage(err)}`);
    }

    const counts: Record<TimerKind, number> = { timer: 0, alarm: 0 };
    for (const timer of active) counts[timer.kind] = (counts[timer.kind] ?? 0) + 1;
    this._reportActive(counts);

    if (this._nextTimer) {
      clearTimeout(this._nextTimer);
      this._nextTimer = undefined;
    }

    // Тик живёт только у лидера — не-лидер не вооружает таймер.
    if (!this._isLeader) return;

    const nearest = active[0];
    if (!nearest) return;
    const delay = Math.min(
      MAX_TIMEOUT_DELAY_MS,
      Math.max(0, Date.parse(nearest.firesAt) - this._clock().getTime()),
    );
    this._nextTimer = setTimeout(() => {
      void this._onTimeout();
    }, delay);
    this._nextTimer.unref?.();
  }

  /** Валидация интента (комментарий, правило повтора, горизонт, обязательные поля). */
  private _validateIntent(intent: TimerIntent, now: Date): void {
    if (!intent || typeof intent !== 'object') {
      throw new TimerValidationError('timer_invalid_target', 'Ожидается описание таймера');
    }
    if (!intent.sessionId) {
      throw new TimerValidationError('timer_invalid_target', 'Сессия обязательна', 'sessionId');
    }
    if (!intent.projectId) {
      throw new TimerValidationError('timer_invalid_target', 'Проект обязателен', 'projectId');
    }
    if (!intent.ownerId) {
      throw new TimerValidationError('timer_invalid_target', 'Владелец обязателен', 'ownerId');
    }
    this._validateComment(intent.comment);

    const repeat = intent.repeat;
    if (!repeat) {
      throw new TimerValidationError('timer_invalid_target', 'Правило повтора обязательно', 'repeat');
    }

    if (repeat.mode === 'daily') {
      if (!TIMER_TIME_REGEX.test(repeat.time)) {
        throw new TimerValidationError(
          'timer_invalid_time',
          `Ожидается время в формате HH:MM, получено «${String(repeat.time)}»`,
          'time',
        );
      }
      if (!isValidTimezone(repeat.timezone)) {
        throw new TimerValidationError(
          'timer_invalid_timezone',
          `Неизвестный часовой пояс «${String(repeat.timezone)}»`,
          'timezone',
        );
      }
      return;
    }

    if (repeat.mode === 'every') {
      this._validateInterval(repeat.everySec, 'everySec');
      return;
    }

    // Режим `once`: таймер — относительная задержка, будильник — абсолютное время.
    if (intent.kind === 'timer') {
      const delay = intent.delaySec;
      if (delay === undefined || !Number.isFinite(delay)) {
        throw new TimerValidationError(
          'timer_invalid_interval',
          'Для таймера требуется задержка `delay` (секунды)',
          'delay',
        );
      }
      this._validateInterval(delay, 'delay');
      if (delay > ONE_SHOT_HORIZON_SEC) {
        throw new TimerValidationError(
          'timer_invalid_horizon',
          `Горизонт одноразового таймера — не более ${TIMER_ONE_SHOT_HORIZON_DAYS} суток`,
          'delay',
        );
      }
      return;
    }

    if (!intent.at) {
      throw new TimerValidationError(
        'timer_invalid_target',
        'Для будильника требуется абсолютное время `at`',
        'at',
      );
    }
    const at = Date.parse(intent.at);
    if (Number.isNaN(at)) {
      throw new TimerValidationError(
        'timer_invalid_target',
        `Некорректное время срабатывания «${String(intent.at)}»`,
        'at',
      );
    }
    if (at - now.getTime() > ONE_SHOT_HORIZON_SEC * 1000) {
      throw new TimerValidationError(
        'timer_invalid_horizon',
        `Горизонт одноразового будильника — не более ${TIMER_ONE_SHOT_HORIZON_DAYS} суток`,
        'at',
      );
    }
    // Время в прошлом не запрещено: будильник сработает как догон (один раз).
  }

  /** Валидация правила повтора (используется и при правке). */
  private _validateRepeat(repeat: TimerRepeat): void {
    if (repeat.mode === 'daily') {
      if (!TIMER_TIME_REGEX.test(repeat.time)) {
        throw new TimerValidationError(
          'timer_invalid_time',
          `Ожидается время в формате HH:MM, получено «${String(repeat.time)}»`,
          'time',
        );
      }
      if (!isValidTimezone(repeat.timezone)) {
        throw new TimerValidationError(
          'timer_invalid_timezone',
          `Неизвестный часовой пояс «${String(repeat.timezone)}»`,
          'timezone',
        );
      }
      return;
    }
    if (repeat.mode === 'every') {
      this._validateInterval(repeat.everySec, 'everySec');
    }
  }

  /** Интервал/задержка: целое число в границах `TIMER_MIN_INTERVAL_SEC`…`TIMER_MAX_INTERVAL_SEC`. */
  private _validateInterval(value: number, field: string): void {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TimerValidationError(
        'timer_invalid_interval',
        `Интервал должен быть целым числом секунд`,
        field,
      );
    }
    if (value < TIMER_MIN_INTERVAL_SEC) {
      throw new TimerValidationError(
        'timer_invalid_interval',
        `Минимальный интервал — ${TIMER_MIN_INTERVAL_SEC} с`,
        field,
      );
    }
    if (value > TIMER_MAX_INTERVAL_SEC) {
      throw new TimerValidationError(
        'timer_invalid_interval',
        `Максимальный интервал — ${TIMER_MAX_INTERVAL_SEC} с`,
        field,
      );
    }
  }

  /** Комментарий: 1…500 символов. */
  private _validateComment(comment: string): void {
    if (typeof comment !== 'string' || comment.length < 1) {
      throw new TimerValidationError(
        'timer_invalid_comment',
        'Комментарий обязателен (1…500 символов)',
        'comment',
      );
    }
    if (comment.length > TIMER_COMMENT_MAX) {
      throw new TimerValidationError(
        'timer_invalid_comment',
        `Комментарий длиннее ${TIMER_COMMENT_MAX} символов`,
        'comment',
      );
    }
  }

  /**
   * PROP-141: публикация live-события таймера в канал сессии.
   *
   * Только метаданные (id/вид/проект/сессия/статус/время) — комментарий
   * таймера (пользовательский текст) в live-событие не попадает. Ошибка
   * публикации не ломает движок (событие — сигнал для UI, а не состояние).
   */
  private _publish(
    type: TimerEventType,
    timer: Timer,
    extra?: Record<string, unknown>,
  ): void {
    const publisher = this._onEvent;
    if (!publisher) return;
    try {
      publisher(timer.sessionId, type, {
        timer_id: timer.id,
        kind: timer.kind,
        project_id: timer.projectId,
        session_id: timer.sessionId,
        status: timer.status,
        fires_at: timer.firesAt,
        ...(timer.name ? { name: timer.name } : {}),
        ...(extra ?? {}),
      });
    } catch (err) {
      console.warn(`[timers] live-событие "${type}" не опубликовано: ${errorMessage(err)}`);
    }
  }

  /** Счётчики активных таймеров для метрик (ошибка метрик не ломает движок). */
  private _reportActive(counts: Record<TimerKind, number>): void {    try {
      this._metrics?.setActive(counts);
    } catch (err) {
      console.warn(`[timers] метрики активных таймеров не записаны: ${errorMessage(err)}`);
    }
  }

  /** Метрика срабатывания (ошибка метрик не ломает движок). */
  private _reportFiring(info: { kind: TimerKind; outcome: TimerFiringOutcome; lagSeconds: number }): void {
    try {
      this._metrics?.onFiring(info);
    } catch (err) {
      console.warn(`[timers] метрики срабатываний не записаны: ${errorMessage(err)}`);
    }
  }

  /** Запись в журнал аудита (best-effort: сбой журнала не ломает операцию). */  private async _auditOp(
    action: TimerAuditAction,
    timer: Timer | null,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    const audit = this._audit;
    if (!audit) return;
    try {
      await audit.append({
        id: `sa_${generateId()}`,
        ts: nowISO(),
        actor: timer?.ownerId ?? 'local',
        scope: 'timer',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(`[timers] аудит не записан: ${errorMessage(err)}`);
    }
  }
}
