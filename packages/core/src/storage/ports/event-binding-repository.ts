import type { EventBinding } from '@itphx/synth-shared';
import type { UpsertEventBindingInput } from '../event-binding-store.js';

/**
 * Порт реестра устойчивых привязок внешнего адреса к сессии/шаблону
 * (ADR-089, реализация — `EventBindingStore`).
 */
export interface EventBindingRepository {
  list(): Promise<EventBinding[]>;
  get(id: string): Promise<EventBinding | null>;
  /**
   * Резолвинг привязки события: `threadKey` приоритетнее `chatKey`; матч по
   * `source` + ключу. @future-backend — запрос по составному индексу.
   */
  findByKey(input: { source: string; chatKey?: string; threadKey?: string }): Promise<EventBinding | null>;
  upsert(input: UpsertEventBindingInput): Promise<EventBinding>;
  remove(id: string): Promise<boolean>;
}
