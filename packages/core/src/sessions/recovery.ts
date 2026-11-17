/**
 * PROP-142 §3: бюджет автовосстановления прерванных ходов после рестарта
 * инстанса.
 *
 * Основа решения владельца (2026-11-18): «попытки на ход + детект crash-loop».
 * Счётчик живёт в сессии (`status.recovery`, durable — файловое хранилище и
 * PostgreSQL), поэтому переживает рестарт; ручной повтор через API
 * (`recovery/retry`) сбрасывает его.
 *
 * Модуль — чистая основа: решения принимаются функциями, запись идёт точечной
 * мутацией метаданных сессии (`mutateMeta`, ADR-144). Проводка в boot-последовательность
 * (`deps.ts`) и HTTP-роут — отдельная работа.
 */

import type { SessionRecoveryState } from '@itphx/synth-shared';
import type { SessionManager } from './manager.js';

/** Бюджет восстановления (собран из секции конфига `recovery`). */
export interface RecoveryBudgetConfig {
  /** Мастер-выключатель автовосстановления (`recovery.autoResume`). */
  autoResume: boolean;
  /** Максимум автовосстановлений одного хода (`recovery.maxAttempts`). */
  maxAttempts: number;
  /** Окно детекта crash-loop, минуты (`recovery.crashLoop.windowMinutes`). */
  windowMinutes: number;
  /** Сколько попыток в окне считаются crash-loop'ом (`recovery.crashLoop.maxRestarts`). */
  maxRestarts: number;
}

/** Причина отказа в автовосстановлении. */
export type RecoveryDenyReason = 'disabled' | 'attempts' | 'crash_loop';

/** Решение по автовосстановлению хода. */
export type RecoveryDecision =
  | { allowed: true }
  | { allowed: false; reason: RecoveryDenyReason };

/**
 * Сколько меток попыток храним в `status.recovery.attemptsAt` (хвост).
 * Хвост нужен детектору crash-loop; старые метки за пределами окна всё равно
 * не учитываются, поэтому глубже держать нечего.
 */
export const MAX_RECOVERY_ATTEMPT_MARKERS = 10;

/**
 * Метки попыток из durable-состояния: мусорный тип (правка JSON на диске) не
 * должен ронять проверку бюджета — не-Array трактуется как «меток нет».
 */
function attemptMarkers(state: SessionRecoveryState | undefined): string[] {
  return Array.isArray(state?.attemptsAt) ? state.attemptsAt : [];
}

/**
 * Решение по автовосстановлению хода.
 *
 * Порядок проверок:
 * 1. `autoResume === false` → `disabled` (мастер-выключатель);
 * 2. `attempts >= maxAttempts` → `attempts` (бюджет попыток на ход исчерпан);
 * 3. попыток в окне `windowMinutes` ≥ `maxRestarts` → `crash_loop`.
 *
 * Невалидные метки времени игнорируются; метка из будущего считается свежей
 * (расхождение часов не должно отключать предохранитель).
 */
export function evaluateRecovery(
  state: SessionRecoveryState | undefined,
  cfg: RecoveryBudgetConfig,
  now: Date = new Date(),
): RecoveryDecision {
  if (!cfg.autoResume) return { allowed: false, reason: 'disabled' };

  const attempts = state?.attempts ?? 0;
  if (attempts >= cfg.maxAttempts) return { allowed: false, reason: 'attempts' };

  const windowMs = cfg.windowMinutes * 60_000;
  const nowMs = now.getTime();
  const recent = attemptMarkers(state).filter((marker) => {
    const ts = Date.parse(marker);
    if (Number.isNaN(ts)) return false;
    return nowMs - ts <= windowMs;
  });
  if (recent.length >= cfg.maxRestarts) return { allowed: false, reason: 'crash_loop' };

  return { allowed: true };
}

/**
 * Зафиксировать попытку автовосстановления хода: инкремент счётчика, метка
 * времени в хвост `attemptsAt` (≤ 10 записей), обновление `lastAt`.
 *
 * `updatedAt` сессии **не двигается** — служебная отметка не «оживляет» сессию
 * в списках. Запись — точечная мутация метаданных (`mutateMeta`), полная
 * перезапись документа сессии здесь недопустима (ADR-144).
 *
 * Сессия не найдена → понятная ошибка (вызывающий решает, терминализировать
 * ли ход).
 */
export async function recordRecoveryAttempt(
  sessionManager: SessionManager,
  sessionId: string,
  now: Date = new Date(),
): Promise<SessionRecoveryState> {
  const at = now.toISOString();
  const result = await sessionManager.mutateMeta(
    sessionId,
    (meta) => {
      const previous = meta.status.recovery;
      meta.status.recovery = {
        attempts: (previous?.attempts ?? 0) + 1,
        attemptsAt: [...attemptMarkers(previous), at].slice(-MAX_RECOVERY_ATTEMPT_MARKERS),
        lastAt: at,
      };
      return true;
    },
    { touchUpdatedAt: false, shouldWrite: (changed) => changed },
  );
  if (!result.found) {
    throw new Error(
      `[recovery] сессия ${sessionId} не найдена — попытку автовосстановления не зафиксировать`,
    );
  }
  // Свежая сессия — источник истины (запись могла слить параллельную мутацию).
  return result.session.status.recovery ?? { attempts: 0, attemptsAt: [] };
}

/**
 * Сбросить счётчик автовосстановления (ручной повтор через API, PROP-142 §3.7):
 * поле `status.recovery` удаляется целиком — состояние «автовосстановление не
 * пробовали» снова достижимо.
 *
 * `updatedAt` сессии не двигается; запись выполняется, только если поле было.
 */
export async function resetRecoveryState(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<void> {
  const result = await sessionManager.mutateMeta(
    sessionId,
    (meta) => {
      if (!meta.status.recovery) return false;
      delete meta.status.recovery;
      return true;
    },
    { touchUpdatedAt: false, shouldWrite: (changed) => changed },
  );
  if (!result.found) {
    throw new Error(`[recovery] сессия ${sessionId} не найдена — сбросить счётчик нельзя`);
  }
}
