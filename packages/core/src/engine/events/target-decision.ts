import type { EventRouteTarget, RouteDecision } from '@itphx/synth-shared';

/**
 * AD-089: единый маппинг цели правила (`EventRouteTarget`, семантика как у
 * `ScheduleTarget`) в решение Router. `reason` используется только для
 * `queue` (по умолчанию `'target'`).
 */
export function decisionFromTarget(
  target: EventRouteTarget,
  defaultEphemeralTtl: string,
  extra?: { reason?: string },
): RouteDecision {
  if (target.mode === 'bound') {
    return { kind: 'bound', sessionId: target.sessionId };
  }
  if (target.mode === 'queue') {
    return { kind: 'queue', owner: target.sessionId, reason: extra?.reason ?? 'target' };
  }
  return {
    kind: 'ephemeral',
    agentTemplate: target.agentTemplate ?? '',
    ttl: target.ttl ?? defaultEphemeralTtl,
    ...(target.project ? { project: target.project } : {}),
  };
}
