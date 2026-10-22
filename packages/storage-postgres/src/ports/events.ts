/**
 * Группа портов **событий, расписаний и webhooks** PostgreSQL-драйвера
 * (ADR-097, волна 3b).
 *
 * Фабрика `buildEventPorts(deps)` собирает свою часть `StorageContext` из четырёх
 * независимых под-файлов (каждый — отдельная подсистема, удобно править/тестировать):
 *   - `events-bindings.ts`   → `eventBindings`/`eventRoutes`/`eventApiKeys`;
 *   - `events-journal.ts`    → `eventJournal`/`identityClaims`/`dedup`;
 *   - `events-scheduler.ts`  → `schedules`/`jobs`;
 *   - `events-webhooks.ts`   → `webhooks`/`webhookDeliveries`.
 *
 * Общие примитивы (ленивая загрузка core, типы-алиасы, хелперы) — `events-core.ts`.
 * Контракты — `packages/core/src/storage/contract/{events,scheduler,secrets}.ts`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { buildEventBindingPorts } from './events-bindings.js';
import { buildEventJournalPorts } from './events-journal.js';
import { buildEventSchedulerPorts } from './events-scheduler.js';
import { buildEventWebhookPorts } from './events-webhooks.js';

/** Часть `StorageContext`, которой владеет группа `events`. */
export type EventPorts = Pick<
  StorageContext,
  | 'eventBindings'
  | 'eventRoutes'
  | 'eventApiKeys'
  | 'eventJournal'
  | 'identityClaims'
  | 'dedup'
  | 'schedules'
  | 'jobs'
  | 'webhooks'
  | 'webhookDeliveries'
>;

/** Собрать порты группы `events`. */
export function buildEventPorts(deps: PortDeps): EventPorts {
  return {
    ...buildEventBindingPorts(deps),
    ...buildEventJournalPorts(deps),
    ...buildEventSchedulerPorts(deps),
    ...buildEventWebhookPorts(deps),
  };
}
