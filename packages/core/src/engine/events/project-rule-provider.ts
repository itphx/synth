import type {
  EventRouteMatch,
  RouteDecision,
  SynthEvent,
} from '@itphx/synth-shared';
import type { RouteRuleStore } from '../../storage/route-rule-store.js';
import { eventToMessageText } from './request-session.js';
import { decisionFromTarget } from './target-decision.js';
import type { RouteRuleInput, RouteRuleProvider } from './types.js';

/**
 * AD-089: правило маршрутизации по матчу события (`source`/`type`/ключи
 * идентичности/`label`/`keywords`). Провайдер вызывается Router'ом после явного
 * `EventBinding` и dedup; первое (по `priority` desc) совпадение выигрывает.
 * Нет совпадения → `null` (решает фоллбек Router, не drop).
 */
export class ProjectRuleProvider implements RouteRuleProvider {
  readonly name = 'project-rules';

  constructor(
    private _store: RouteRuleStore,
    private _defaultEphemeralTtl: string,
  ) {}

  async resolve({ event }: RouteRuleInput): Promise<RouteDecision | null> {
    const rules = await this._store.listEnabled();
    const ordered = [...rules].sort((a, b) => b.priority - a.priority);

    const text = eventToMessageText(event).toLowerCase();
    for (const rule of ordered) {
      if (!hasAnyCriterion(rule.match)) continue;
      if (!matches(rule.match, event, text)) continue;
      return decisionFromTarget(rule.target, this._defaultEphemeralTtl, { reason: 'rule' });
    }
    return null;
  }
}

/**
 * Пустой `match` (все поля не заданы) не должен матчить всё — считаем правило
 * невалидным и игнорируем.
 */
function hasAnyCriterion(match: EventRouteMatch): boolean {
  return (
    match.source !== undefined ||
    match.type !== undefined ||
    match.chatKey !== undefined ||
    match.threadKey !== undefined ||
    match.principalId !== undefined ||
    match.label !== undefined ||
    (Array.isArray(match.keywords) && match.keywords.length > 0)
  );
}

/** AND по заполненным полям `match`; `keywords` — хотя бы одна подстрока. */
function matches(match: EventRouteMatch, event: SynthEvent, lowerText: string): boolean {
  if (match.source !== undefined && event.source !== match.source) return false;
  if (match.type !== undefined && event.type !== match.type) return false;
  if (match.chatKey !== undefined && event.identity?.chatKey !== match.chatKey) return false;
  if (match.threadKey !== undefined && event.identity?.threadKey !== match.threadKey) return false;
  if (match.principalId !== undefined && event.identity?.principalId !== match.principalId) return false;

  if (match.label !== undefined) {
    const payload = event.payload;
    const label =
      payload && typeof payload === 'object'
        ? (payload as { label?: unknown }).label
        : undefined;
    if (label !== match.label) return false;
  }

  if (Array.isArray(match.keywords) && match.keywords.length > 0) {
    const hit = match.keywords.some(
      (kw) => typeof kw === 'string' && kw.length > 0 && lowerText.includes(kw.toLowerCase()),
    );
    if (!hit) return false;
  }

  return true;
}
