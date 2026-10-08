import type { RouteDecision } from '@itphx/synth-shared';
import type { ScheduleStore } from '../../storage/schedule-store.js';
import type { RouteRuleInput, RouteRuleProvider } from '../events/types.js';

const DEFAULT_EPHEMERAL_TTL = '24h';

/**
 * AD-051 (минимальный срез) / AD-089: правило маршрутизации cron-событий.
 *
 * Router вызывает провайдер после явного `Binding` и после dedup — это ок.
 * Поддерживаются только события `source === 'cron'` с `payload.scheduleId`:
 * по расписанию выбирается цель (`bound` / `queue` / `ephemeral`). Нет
 * расписания или оно выключено → `drop` с аудитом.
 */
export class SchedulerRuleProvider implements RouteRuleProvider {
  readonly name = 'scheduler';

  constructor(
    private _store: ScheduleStore,
    private _defaultEphemeralTtl: string = DEFAULT_EPHEMERAL_TTL,
  ) {}

  async resolve({ event }: RouteRuleInput): Promise<RouteDecision | null> {
    if (event.source !== 'cron') return null;

    const payload = event.payload;
    const scheduleId =
      payload && typeof payload === 'object'
        ? (payload as { scheduleId?: unknown }).scheduleId
        : undefined;
    if (typeof scheduleId !== 'string' || !scheduleId) return null;

    const schedule = await this._store.get(scheduleId);
    if (!schedule) return { kind: 'drop', reason: 'schedule_not_found', audited: true };
    if (!schedule.enabled) return { kind: 'drop', reason: 'schedule_disabled', audited: true };

    const target = schedule.target;
    if (target.mode === 'bound') return { kind: 'bound', sessionId: target.sessionId };
    if (target.mode === 'queue') {
      return { kind: 'queue', owner: target.sessionId, reason: 'schedule' };
    }
    return {
      kind: 'ephemeral',
      agentTemplate: target.agentTemplate ?? '',
      ttl: target.ttl ?? this._defaultEphemeralTtl,
    };
  }
}
