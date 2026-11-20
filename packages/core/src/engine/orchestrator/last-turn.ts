/**
 * Durable-исход последнего хода сессии (`status.lastTurn`, `SessionLastTurn`).
 *
 * Зачем: списки сессий (левое дерево UI) отдают сводку **без истории**, поэтому
 * «чем закончился последний ход» должно жить в документе сессии, а не
 * вычисляться по ленте. Клиент красит название сессии (красный — `error`,
 * зелёный — `completed`) и не показывает цвет, пока ход идёт
 * (`activity !== 'idle'`).
 *
 * Здесь два шва, чтобы запись не разъезжалась между точками:
 *  - {@link lastTurnOutcomeFor} — маппинг терминального статуса сообщения хода
 *    (и ключа фоллбека) в грубый класс исхода + конкретную причину
 *    (`StopReason`, PROP-143);
 *  - {@link recordLastTurn} — **единственная** точка записи: точечная мутация
 *    метаданных (`mutateMeta`, ADR-144) без `touchUpdatedAt` (служебная отметка
 *    не «оживляет» сессию в списках). Ошибка записи ход не ломает — только
 *    предупреждение в лог (как у `appendStopRecord`).
 */
import type { SessionLastTurn, SessionLastTurnOutcome } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { warning } from '../../logger.js';
import type { StopReason } from '../stop-reason.js';
import type { AssistantMessageStatus } from './persistence.js';

/**
 * i18n-ключ фоллбека → конкретная причина остановки (PROP-143).
 *
 * Ключи — те, что реально выставляются в финализации/цикле хода
 * (`session.*`, `task.*`). Неизвестный ключ → причины нет (грубый класс
 * считается по статусу сообщения).
 */
const REASON_BY_I18N_KEY: Readonly<Record<string, StopReason>> = {
  'session.steps_limit': 'steps_limit',
  // Лимит итераций инструментов — тот же класс «исчерпан лимит шагов»,
  // отдельной причины в `StopReason` нет.
  'session.max_iterations': 'steps_limit',
  'session.output_limit': 'output_limit',
  'session.output_limit_exhausted': 'output_limit',
  'task.output_limit': 'output_limit',
  'session.empty_response': 'empty',
  'task.empty_response': 'empty',
  // Отказ прав (политика/подтверждение) и ролевой отказ (тул недоступен
  // агенту) — «ход остановлен отказом», а не «модель промолчала».
  'session.denied_blocked': 'denied',
  'session.role_tool_blocked': 'denied',
  // «Обработка остановлена: {reason}» — пользовательский «Стоп».
  'session.stopped': 'stopped_by_user',
};

/** Грубый класс исхода + причина (пара, которая уходит в `status.lastTurn`). */
export interface LastTurnOutcome {
  outcome: SessionLastTurnOutcome;
  reason?: StopReason;
}

/**
 * Терминальный статус сообщения хода → исход хода.
 *
 * Соответствие статусов (`AssistantMessageStatus`, ADR-070 §2.6):
 *  - `limit` (шаг-лимит или исчерпанные продолжения) → `limit`;
 *  - `stopped` (отказ прав / ролевой отказ) → `stopped` (+ `denied`);
 *  - `error` (пустой ответ, лимит вывода, сбой) → `error` (+ причина по ключу);
 *  - `cancelled` (отмена хода) → `cancelled`;
 *  - `completed`/`interrupted` → `completed`.
 *
 * `stepLimitReached` (синтетический шаг-лимит исполнялся) приоритетнее статуса:
 * ход в любом случае закрыт лимитом шагов.
 */
export function lastTurnOutcomeFor(
  messageStatus: AssistantMessageStatus,
  opts: { stepLimitReached?: boolean; i18nKey?: string } = {},
): LastTurnOutcome {
  const reason = opts.i18nKey !== undefined ? REASON_BY_I18N_KEY[opts.i18nKey] : undefined;
  if (opts.stepLimitReached === true || messageStatus === 'limit') {
    // Лимит без известного ключа — по умолчанию исчерпан лимит шагов
    // (`stepLimitReached` — основной путь; `max_iterations` даёт тот же класс).
    return { outcome: 'limit', reason: reason ?? 'steps_limit' };
  }
  switch (messageStatus) {
    case 'stopped':
      return reason !== undefined ? { outcome: 'stopped', reason } : { outcome: 'stopped' };
    case 'cancelled':
      return { outcome: 'cancelled', ...(reason !== undefined ? { reason } : {}) };
    case 'error':
      return reason !== undefined ? { outcome: 'error', reason } : { outcome: 'error' };
    default:
      return { outcome: 'completed' };
  }
}

/**
 * Записать исход хода в документ сессии (durable, переживает рестарт).
 *
 * Точечная мутация метаданных (`mutateMeta`, ADR-144): история и child-наборы
 * не читаются и не перезаписываются, параллельная дозапись сообщений не
 * теряется. `updatedAt` не двигается — служебная отметка не «оживляет» сессию
 * в списках (паритет с `status.recovery`, `sessions/recovery.ts`).
 *
 * Сессии нет — `null` (писать некуда). Ошибка хранилища — предупреждение в лог
 * и `null`: исход хода — производная отметка, она не должна ронять ход.
 */
export async function recordLastTurn(
  sessionManager: SessionManager,
  sessionId: string,
  input: LastTurnOutcome & { now?: Date },
): Promise<SessionLastTurn | null> {
  const lastTurn: SessionLastTurn = {
    outcome: input.outcome,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    at: (input.now ?? new Date()).toISOString(),
  };
  try {
    const result = await sessionManager.mutateMeta(
      sessionId,
      (meta) => {
        meta.status.lastTurn = lastTurn;
      },
      { touchUpdatedAt: false },
    );
    return result.found ? lastTurn : null;
  } catch (err) {
    warning(
      'ORCHESTRATOR',
      `Не удалось записать исход хода (lastTurn): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
