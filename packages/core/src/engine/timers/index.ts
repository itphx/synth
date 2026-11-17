/**
 * PROP-141 (Часть B): движок таймеров и будильников.
 *
 * Публичные точки входа: `TimerService` (жизненный цикл автоматизации),
 * вычисление ближайшего срабатывания (`next-fire.ts`) и именованные ошибки
 * подсистемы. Доставка подключается инъекцией (`deliver`) — на этапе 4.
 */
export {
  nextDailyFire,
  nextEveryFire,
  nextFireForRepeat,
  resolveFirstFire,
  isValidTimezone,
} from './next-fire.js';
export { TimerService, TIMER_SAFETY_TICK_MS, TIMER_CATCHUP_LAG_MS, TIMER_DEDUP_HISTORY } from './service.js';
export type { TimerServiceDeps, TimerAuditAction, TimerEventType, TimerEventPublisher } from './service.js';
export { TimerRuleProvider, TIMER_EVENT_SOURCE, TIMER_EVENT_TYPE } from './route-provider.js';
export {
  TIMER_ERROR_CODES,
  TimerError,
  TimerValidationError,
  TimerLimitExceededError,
} from './types.js';
export type {
  TimerErrorCode,
  TimerIntent,
  TimerIntentRepeat,
  TimerUpdatePatch,
  TimerDeliveryMeta,
  TimerDeliver,
} from './types.js';
