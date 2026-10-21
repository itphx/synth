import type { EventRouteTarget, RouteDecision, RouteDecisionMeta } from '@itphx/synth-shared';

/**
 * ADR-089: единый маппинг цели правила (`EventRouteTarget`, семантика как у
 * `ScheduleTarget`) в решение Router. `reason` используется только для
 * `queue` (по умолчанию `'target'`); `confidence`/`signals` — диагностическая
 * мета (ADR-084), приклеивается к решению во всех ветвях, если задана.
 * Обратная совместимость: без меты поведение прежнее.
 *
 * `pipeline` (ссылка на шаг пайплайна) прокидывается в решение для целей
 * `ephemeral`/`bind` — там, где решение порождает сессию. В `bound`/`queue`
 * сессия фиксирована, поля в цели нет (его отвергает схема), поэтому в
 * решении оно тоже не появляется.
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
  // ADR-089 (auto-bind): цель закрепляет внешний адрес за новой сессией.
  if (target.mode === 'bind') {
    return {
      kind: 'bind',
      agentTemplate: target.agentTemplate ?? '',
      ...(target.project ? { project: target.project } : {}),
      ...(target.pipeline ? { pipeline: target.pipeline } : {}),
      ...meta,
    };
  }
  return {
    kind: 'ephemeral',
    agentTemplate: target.agentTemplate ?? '',
    ttl: target.ttl ?? defaultEphemeralTtl,
    ...(target.project ? { project: target.project } : {}),
    ...(target.pipeline ? { pipeline: target.pipeline } : {}),
    ...meta,
  };
}
