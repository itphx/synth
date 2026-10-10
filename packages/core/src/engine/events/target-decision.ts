import type { EventRouteTarget, RouteDecision, RouteDecisionMeta } from '@itphx/synth-shared';

/**
 * AD-089: единый маппинг цели правила (`EventRouteTarget`, семантика как у
 * `ScheduleTarget`) в решение Router. `reason` используется только для
 * `queue` (по умолчанию `'target'`); `confidence`/`signals` — диагностическая
 * мета (AD-084), приклеивается к решению во всех ветвях, если задана.
 * Обратная совместимость: без меты поведение прежнее.
 */
export function decisionFromTarget(
  target: EventRouteTarget,
  defaultEphemeralTtl: string,
  extra?: { reason?: string; confidence?: number; signals?: string[] },
): RouteDecision {
  const meta: RouteDecisionMeta = {};
  if (extra?.confidence !== undefined) meta.confidence = extra.confidence;
  if (extra?.signals !== undefined) meta.signals = extra.signals;

  if (target.mode === 'bound') {
    return { kind: 'bound', sessionId: target.sessionId, ...meta };
  }
  if (target.mode === 'queue') {
    return { kind: 'queue', owner: target.sessionId, reason: extra?.reason ?? 'target', ...meta };
  }
  return {
    kind: 'ephemeral',
    agentTemplate: target.agentTemplate ?? '',
    ttl: target.ttl ?? defaultEphemeralTtl,
    ...(target.project ? { project: target.project } : {}),
    ...meta,
  };
}
