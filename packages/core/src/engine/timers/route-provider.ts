/**
 * PROP-141 (Часть B, «Доставка»): правило маршрутизации срабатываний таймеров
 * и будильников.
 *
 * Срабатывание — **внутреннее** событие инстанса (`source:'timer'`,
 * `type:'timer_fired'`): сессия-получатель известна заранее (таймер привязан к
 * конкретной сессии), эфемерных сессий и пайплайнов у таймеров нет.
 *
 * Поэтому правило всегда возвращает `bound` с режимом доставки `steer` —
 * вклинивание в текущий ход (как завершение фонового процесса, ADR-113/ADR-104).
 * Цель не найдена или payload невалиден — `null`: Router уходит на свой
 * фоллбек (осознанный `drop`), а не «молча» доставляет сообщение не туда.
 */
import type { RouteDecision } from '@itphx/synth-shared';
import type { RouteRuleInput, RouteRuleProvider } from '../events/types.js';

/** Источник события срабатывания таймера. */
export const TIMER_EVENT_SOURCE = 'timer';

/** Тип события срабатывания таймера. */
export const TIMER_EVENT_TYPE = 'timer_fired';

export class TimerRuleProvider implements RouteRuleProvider {
  readonly name = 'timer';

  async resolve({ event }: RouteRuleInput): Promise<RouteDecision | null> {
    if (event.source !== TIMER_EVENT_SOURCE) return null;
    if (event.type !== TIMER_EVENT_TYPE) return null;

    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as { sessionId?: unknown })
        : {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) return null;

    return {
      kind: 'bound',
      sessionId,
      delivery: 'steer',
      reason: 'timer',
    };
  }
}
