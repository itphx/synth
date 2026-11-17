import type { Timer, TimerFilter, TimerPatch } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';

/**
 * Общие правила выборки и правки таймеров (PROP-141, Часть B) — единый
 * источник истины для всех backend'ов слоя хранения (файлового, in-memory и
 * PostgreSQL). Модуль **без модулей ФС** — его читает и memory-реализация.
 *
 * Здесь только механика порта (порядок, фильтры, сброс полей); бизнес-правила
 * движка (вычисление `firesAt`, catch-up, лимиты) — в core `engine/timers/`.
 */

/** Дефолтный потолок выборки (паритет с `COLLECTION_LIMIT_DEFAULT`). */
export const TIMER_LIST_DEFAULT_LIMIT = 100;

/** Абсолютный потолок выборки (паритет с `COLLECTION_LIMIT_MAX`). */
export const TIMER_LIST_MAX_LIMIT = 1000;

/** Совпадает ли таймер с фильтрами выборки (все условия — по «И»). */
export function timerMatchesFilter(timer: Timer, filter: TimerFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && timer.sessionId !== filter.sessionId) return false;
  if (filter.projectId !== undefined && timer.projectId !== filter.projectId) return false;
  if (filter.status !== undefined && timer.status !== filter.status) return false;
  if (filter.kind !== undefined && timer.kind !== filter.kind) return false;
  return true;
}

/** Порядок — по ближайшему срабатыванию (`firesAt` возраст., тайбрейкер `id`). */
export function byTimerFiresAtAsc(a: Timer, b: Timer): number {
  const diff = Date.parse(a.firesAt) - Date.parse(b.firesAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id.localeCompare(b.id);
}

/**
 * «Пора сработать»: `firesAt <= at`. Нераспарсенная дата **не** считается
 * просроченной (fail-closed: битая метка не должна ронять тик движка).
 */
export function isTimerDue(timer: Timer, at: string): boolean {
  const fires = Date.parse(timer.firesAt);
  const due = Date.parse(at);
  if (Number.isNaN(fires) || Number.isNaN(due)) return false;
  return fires <= due;
}

/** Нормализация смещения: неотрицательное целое (иначе 0). */
export function normalizeTimerOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

/**
 * Нормализация потолка выборки: по умолчанию — 100, абсолютный потолок —
 * 1000 (паритет с `resolveCollectionLimit`).
 */
export function normalizeTimerLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return TIMER_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), TIMER_LIST_MAX_LIMIT);
}

/** Постраничный срез выборки (смещение, затем потолок). */
export function paginateTimers(timers: Timer[], filter: TimerFilter | undefined): Timer[] {
  const offset = normalizeTimerOffset(filter?.offset);
  const limit = normalizeTimerLimit(filter?.limit);
  const sliced = offset > 0 ? timers.slice(offset) : timers;
  return sliced.slice(0, limit);
}

/**
 * Применить частичную правку к записи таймера: `updatedAt` = now, `id` и
 * неизменяемые поля (`projectId`/`sessionId`/`ownerId`/`createdAt`) не
 * трогаются, `null` — сброс необязательного поля.
 */
export function applyTimerPatch(timer: Timer, patch: TimerPatch): Timer {
  const updated: Timer = { ...timer, updatedAt: nowISO() };
  if (patch.kind !== undefined) updated.kind = patch.kind;
  if (patch.comment !== undefined) updated.comment = patch.comment;
  if (patch.repeat !== undefined) updated.repeat = patch.repeat;
  if (patch.status !== undefined) updated.status = patch.status;
  if (patch.firesAt !== undefined) updated.firesAt = patch.firesAt;
  if (patch.name !== undefined) {
    if (patch.name === null) delete updated.name;
    else updated.name = patch.name;
  }
  if (patch.firedAt !== undefined) {
    if (patch.firedAt === null) delete updated.firedAt;
    else updated.firedAt = patch.firedAt;
  }
  if (patch.lastError !== undefined) {
    if (patch.lastError === null) delete updated.lastError;
    else updated.lastError = patch.lastError;
  }
  return updated;
}
