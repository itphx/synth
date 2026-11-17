/**
 * PROP-142 §3: планировщик автовосстановления прерванных ходов при старте
 * инстанса (boot).
 *
 * Модуль — **чистый**: решение принимается по входным данным (список сессий +
 * бюджет), без доступа к хранилищу, шине и оркестратору. Boot-контур
 * (`server/app/deps.ts` в core и backend) применяет план:
 *
 * - `resume-main` — основная сессия: обычный процессор очереди с
 *   resume-сообщением (прежнее поведение автозапуска);
 * - `resume-child` — дочерняя сессия (саб-агент): цикл саб-агента
 *   (`orchestrator.startSubagentResume`), **не** процессор очереди — у ребёнка
 *   нет своей очереди, а его цикл ведёт родитель;
 * - `deny` — отказ по бюджету (попытки на ход / crash-loop / выключенное
 *   автовосстановление): ход терминализируется, след остаётся в истории
 *   (`engine/stop-record.ts`).
 *
 * Бюджет у ребёнка — **тот же**, что у основной сессии (счётчик живёт в
 * сессии, `status.recovery`), поэтому цикл «рестарт → возобновление» не
 * становится бесконечным ни для основной сессии, ни для саб-агента.
 */

import type { SessionRecoveryState } from '@itphx/synth-shared';
import { evaluateRecovery, type RecoveryBudgetConfig, type RecoveryDenyReason } from './recovery.js';

/**
 * План восстановления одной сессии при старте инстанса.
 *
 * - `resume-main` — возобновить обычным процессором очереди;
 * - `resume-child` — возобновить циклом саб-агента;
 * - `deny` — не возобновлять (бюджет исчерпан), причина — в `reason`.
 */
export type BootRecoveryPlan =
  | { action: 'resume-main'; sessionId: string }
  | { action: 'resume-child'; sessionId: string }
  | { action: 'deny'; sessionId: string; reason: RecoveryDenyReason };

/** Сессия во входе планировщика (только поля, нужные для решения). */
export interface BootRecoverySession {
  /** Id сессии. */
  id: string;
  /** Родитель сессии (задана — сессия дочерняя). */
  parentId?: string;
  /** Происхождение сессии (`subagent` — дочерняя сессия саб-агента). */
  sessionOrigin?: string;
  /** Durable-счётчик автовосстановления (`status.recovery`). */
  recovery?: SessionRecoveryState;
}

/**
 * Дочерняя ли сессия (саб-агент).
 *
 * Признак — любой из двух: `parentId` задан (сессия создана как дочерняя) или
 * `sessionOrigin === 'subagent'`. Основная сессия пользователя не является
 * дочерней ни по одному из признаков.
 */
export function isChildSession(session: {
  parentId?: string;
  sessionOrigin?: string;
}): boolean {
  if (session.parentId) return true;
  return session.sessionOrigin === 'subagent';
}

/**
 * План восстановления для списка сессий.
 *
 * Правила:
 * 1. дочерняя сессия (`parentId`/`sessionOrigin === 'subagent'`) → план
 *    `resume-child`, иначе → `resume-main`;
 * 2. бюджет проверяется **одинаково** для обоих видов (`evaluateRecovery`):
 *    при отказе план `deny` с причиной (`disabled`/`attempts`/`crash_loop`);
 * 3. порядок планов совпадает с порядком сессий во входе.
 *
 * `now` — текущее время (окно crash-loop считается по нему); не задано —
 * системное время.
 */
export function planBootRecovery(input: {
  sessions: BootRecoverySession[];
  config: RecoveryBudgetConfig;
  now?: Date;
}): BootRecoveryPlan[] {
  const now = input.now ?? new Date();
  return input.sessions.map((session) => {
    const decision = evaluateRecovery(session.recovery, input.config, now);
    if (!decision.allowed) {
      return { action: 'deny', sessionId: session.id, reason: decision.reason };
    }
    if (isChildSession(session)) {
      return { action: 'resume-child', sessionId: session.id };
    }
    return { action: 'resume-main', sessionId: session.id };
  });
}

/**
 * Бюджет восстановления по умолчанию — как дефолты секции `recovery`
 * (`shared/config/types.ts`): автовосстановление включено, 3 попытки на ход,
 * crash-loop — 3 рестарта за 10 минут.
 */
export const DEFAULT_RECOVERY_BUDGET: RecoveryBudgetConfig = {
  autoResume: true,
  maxAttempts: 3,
  windowMinutes: 10,
  maxRestarts: 3,
};

/** Секция `recovery` в не-нормализованном виде (из конфига). */
interface RecoverySectionLike {
  autoResume?: unknown;
  maxAttempts?: unknown;
  crashLoop?: unknown;
}

/**
 * Достать секцию `recovery` из произвольного объекта.
 *
 * Поддерживаются три формы (источник значения в конфиге инстанса):
 * 1. сама секция (`{autoResume, maxAttempts, crashLoop}`);
 * 2. объект с полем `recovery` (или `recoveryConfig`);
 * 3. объект с полем `synth`, внутри которого — `recovery`.
 *
 * Секция не найдена — `undefined` (бюджет берётся из дефолтов).
 */
function readRecoverySection(source: unknown): RecoverySectionLike | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const obj = source as Record<string, unknown>;
  for (const key of ['recovery', 'recoveryConfig'] as const) {
    const value = obj[key];
    if (value && typeof value === 'object') return value as RecoverySectionLike;
  }
  const synth = obj.synth;
  if (synth && typeof synth === 'object') {
    const value = (synth as Record<string, unknown>).recovery;
    if (value && typeof value === 'object') return value as RecoverySectionLike;
  }
  // Сама секция: у неё есть характерные поля.
  if ('autoResume' in obj || 'maxAttempts' in obj || 'crashLoop' in obj) {
    return obj as RecoverySectionLike;
  }
  return undefined;
}

/** Целое число ≥ 1 (невалидное значение — дефолт). */
function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : fallback;
}

/**
 * Собрать бюджет восстановления из конфига инстанса.
 *
 * Источник — секция `recovery` (`shared/config/types.ts`): `autoResume`
 * (мастер-выключатель), `maxAttempts` (бюджет попыток на ход),
 * `crashLoop.windowMinutes`/`crashLoop.maxRestarts` (детект crash-loop).
 *
 * Секция не найдена или поле невалидно — берётся дефолт (fail-safe: бюджет
 * действует всегда, даже если конфиг не задан).
 */
export function resolveRecoveryBudget(source: unknown): RecoveryBudgetConfig {
  const section = readRecoverySection(source);
  if (!section) return { ...DEFAULT_RECOVERY_BUDGET };
  const crashLoop =
    section.crashLoop && typeof section.crashLoop === 'object'
      ? (section.crashLoop as { windowMinutes?: unknown; maxRestarts?: unknown })
      : {};
  return {
    autoResume:
      typeof section.autoResume === 'boolean'
        ? section.autoResume
        : DEFAULT_RECOVERY_BUDGET.autoResume,
    maxAttempts: positiveInt(section.maxAttempts, DEFAULT_RECOVERY_BUDGET.maxAttempts),
    windowMinutes: positiveInt(crashLoop.windowMinutes, DEFAULT_RECOVERY_BUDGET.windowMinutes),
    maxRestarts: positiveInt(crashLoop.maxRestarts, DEFAULT_RECOVERY_BUDGET.maxRestarts),
  };
}
