/**
 * In-memory реализации портов **таймеров/будильников** (PROP-141, Часть B;
 * ADR-096, второй backend за единым слоем хранения).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map` и
 * массиве процесса. Семантика повторяет файловую реализацию
 * (`FileTimerStore`/`FileTimerFiringStore`): `create` — id `tmr_<uuid>`,
 * таймстемпы = now, статус по умолчанию — `active`; `list` — по ближайшему
 * срабатыванию (`firesAt` возраст., тайбрейкер `id`) с фильтрами по «И»;
 * `listDue` — активные с `firesAt <= at`; `countActive` — счётчик активных
 * таймеров сессии; `update`/`setStatus` — частичная правка с `updatedAt` =
 * now; `remove` идемпотентно; `removeBySession` — каскад по сессии.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type {
  Timer,
  TimerCreateInput,
  TimerFiring,
  TimerFilter,
  TimerPatch,
  TimerStatus,
} from '@itphx/synth-shared';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { TimerFiringRepository, TimerRepository } from '../ports/timer-repository.js';
import {
  applyTimerPatch,
  byTimerFiresAtAsc,
  isTimerDue,
  paginateTimers,
  timerMatchesFilter,
} from '../timer-utils.js';

/** Порт реестра таймеров поверх `Map` (реализация — `FileTimerStore`). */
export class MemoryTimerRepository implements TimerRepository {
  private readonly _timers = new Map<string, Timer>();

  async list(filter?: TimerFilter): Promise<Timer[]> {
    const filtered = [...this._timers.values()].filter((t) => timerMatchesFilter(t, filter));
    return paginateTimers([...filtered].sort(byTimerFiresAtAsc), filter).map((t) =>
      structuredClone(t),
    );
  }

  async get(id: string): Promise<Timer | null> {
    const timer = this._timers.get(id);
    return timer ? structuredClone(timer) : null;
  }

  async create(input: TimerCreateInput & { firesAt: string }): Promise<Timer> {
    const now = nowISO();
    const timer: Timer = {
      ...structuredClone(input),
      id: `tmr_${generateId()}`,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    this._timers.set(timer.id, timer);
    return structuredClone(timer);
  }

  async update(id: string, patch: TimerPatch): Promise<Timer | null> {
    const current = this._timers.get(id);
    if (!current) return null;
    const updated = applyTimerPatch(current, patch);
    this._timers.set(id, updated);
    return structuredClone(updated);
  }

  async remove(id: string): Promise<boolean> {
    return this._timers.delete(id);
  }

  async listDue(at: string): Promise<Timer[]> {
    return [...this._timers.values()]
      .filter((t) => t.status === 'active' && isTimerDue(t, at))
      .sort(byTimerFiresAtAsc)
      .map((t) => structuredClone(t));
  }

  async countActive(sessionId: string): Promise<number> {
    let count = 0;
    for (const timer of this._timers.values()) {
      if (timer.status === 'active' && timer.sessionId === sessionId) count += 1;
    }
    return count;
  }

  async setStatus(id: string, status: TimerStatus, patch?: TimerPatch): Promise<Timer | null> {
    const current = this._timers.get(id);
    if (!current) return null;
    const updated = applyTimerPatch(current, { ...(patch ?? {}), status });
    this._timers.set(id, updated);
    return structuredClone(updated);
  }

  async removeBySession(sessionId: string): Promise<number> {
    let removed = 0;
    for (const [id, timer] of [...this._timers.entries()]) {
      if (timer.sessionId !== sessionId) continue;
      this._timers.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/**
 * Порт истории срабатываний поверх массива (реализация —
 * `FileTimerFiringStore`): порядок добавления (старые → новые), `limit` —
 * последние N, `prune` — записи строго старше отсечки.
 */
export class MemoryTimerFiringRepository implements TimerFiringRepository {
  private _firings: TimerFiring[] = [];

  async append(firing: TimerFiring): Promise<void> {
    this._firings.push(structuredClone(firing));
  }

  async list(timerId: string, limit?: number): Promise<TimerFiring[]> {
    const firings = this._firings
      .filter((f) => f.timerId === timerId)
      .map((f) => structuredClone(f));
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return firings;
    return firings.slice(-Math.floor(limit));
  }

  async prune(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    if (Number.isNaN(cutoff)) return 0;
    const kept = this._firings.filter((f) => {
      const t = Date.parse(f.firedAt);
      // Записи с непарсящейся датой сохраняются (fail-soft, как у Job-истории).
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    const removed = this._firings.length - kept.length;
    if (removed === 0) return 0;
    this._firings = kept;
    return removed;
  }
}
