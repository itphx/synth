import type { EventRouteRule } from '@itphx/synth-shared';
import type { UpsertRouteRuleInput } from '../route-rule-store.js';

/**
 * Порт реестра правил маршрутизации внешних событий
 * (ADR-089, реализация — `RouteRuleStore`).
 */
export interface EventRouteRepository {
  list(): Promise<EventRouteRule[]>;
  /** Только включённые правила (провайдер маршрутизации).
   *  @future-backend — фильтр `enabled` в SQL. */
  listEnabled(): Promise<EventRouteRule[]>;
  get(id: string): Promise<EventRouteRule | null>;
  upsert(input: UpsertRouteRuleInput): Promise<EventRouteRule>;
  remove(id: string): Promise<boolean>;
}
