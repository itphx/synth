/**
 * PROP-143: единая таблица причин остановки хода для UI.
 *
 * Один источник истины вместо локальных наборов в `ChatMessage` и
 * `SubagentResumeBar`: по причине (`metadata.reason` durable-записи
 * `execution_stopped`) здесь определяется
 *
 *  - `labelKey`   — ключ локализации человеческой подписи причины;
 *  - `severity`   — тон блока: `error` (сбой), `warning` (штатная остановка
 *    ограничителем), `neutral` (остановка человеком);
 *  - `resumable`  — имеет ли смысл кнопка «Продолжить» (решение владельца:
 *    только сбои прогона — `provider_error`/`internal`/`empty`);
 *  - `showProviderBody` — можно ли показывать тело конверта. Тело — сырой текст
 *    провайдера **только** у `provider_error`; у остальных причин там машинный
 *    EN-текст движка (`shared/i18n`), который в ленте выглядел ошибкой из ничего.
 *
 * Набор ключей совпадает с union `StopReason` ядра
 * (`packages/core/src/engine/stop-reason.ts`) — сверяется переписью
 * (`stopReason.test.ts`), новый ключ без строки таблицы роняет тест.
 */

/** Причина остановки хода — зеркало union'а ядра (`engine/stop-reason.ts`). */
export type StopReason =
  | 'provider_error'
  | 'steps_limit'
  | 'context_budget'
  | 'stopped_by_user'
  | 'denied'
  | 'empty'
  | 'output_limit'
  | 'internal'
  | 'restart'
  | 'orphaned'

/** Тон блока причины остановки. */
export type StopSeverity = 'neutral' | 'warning' | 'error'

export interface StopReasonInfo {
  /** Ключ локализации подписи причины (`chat.notice.stopReason.<reason>`). */
  labelKey: string
  severity: StopSeverity
  /** Показывать ли кнопку «Продолжить» для дочерней сессии. */
  resumable: boolean
  /** Показывать ли тело конверта (сырой текст провайдера). */
  showProviderBody: boolean
}

/**
 * Таблица причин. `error` — реальный сбой, `warning` — штатное завершение
 * ограничителем (ход не «упал», но и не дошёл до конца сам), `neutral` —
 * решение человека.
 */
export const STOP_REASON_TABLE: Readonly<Record<StopReason, StopReasonInfo>> = {
  provider_error: {
    labelKey: 'chat.notice.stopReason.provider_error',
    severity: 'error',
    resumable: true,
    // Единственная причина, где тело — настоящий текст провайдера: он нужен.
    showProviderBody: true,
  },
  steps_limit: {
    labelKey: 'chat.notice.stopReason.steps_limit',
    severity: 'warning',
    resumable: false,
    showProviderBody: false,
  },
  context_budget: {
    labelKey: 'chat.notice.stopReason.context_budget',
    severity: 'warning',
    resumable: false,
    showProviderBody: false,
  },
  stopped_by_user: {
    labelKey: 'chat.notice.stopReason.stopped_by_user',
    severity: 'neutral',
    resumable: false,
    showProviderBody: false,
  },
  denied: {
    labelKey: 'chat.notice.stopReason.denied',
    severity: 'error',
    resumable: false,
    showProviderBody: false,
  },
  empty: {
    labelKey: 'chat.notice.stopReason.empty',
    severity: 'error',
    resumable: true,
    showProviderBody: false,
  },
  output_limit: {
    labelKey: 'chat.notice.stopReason.output_limit',
    severity: 'warning',
    resumable: false,
    showProviderBody: false,
  },
  internal: {
    labelKey: 'chat.notice.stopReason.internal',
    severity: 'error',
    resumable: true,
    showProviderBody: false,
  },
  restart: {
    labelKey: 'chat.notice.stopReason.restart',
    severity: 'warning',
    resumable: false,
    showProviderBody: false,
  },
  orphaned: {
    labelKey: 'chat.notice.stopReason.orphaned',
    severity: 'error',
    resumable: false,
    showProviderBody: false,
  },
}

/**
 * Нормализация причины из `metadata.reason`.
 *
 * Неизвестный код (ядро новее UI) деградирует на `internal` — иначе в подписи
 * оказался бы сырой i18n-ключ, а в таблице — `undefined`.
 */
export function normalizeStopReason(reason: string | null | undefined): StopReason {
  if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(STOP_REASON_TABLE, reason)) {
    return reason as StopReason
  }
  return 'internal'
}

/** Строка таблицы по причине из записи (неизвестная — как `internal`). */
export function stopReasonInfo(reason: string | null | undefined): StopReasonInfo {
  return STOP_REASON_TABLE[normalizeStopReason(reason)]
}
