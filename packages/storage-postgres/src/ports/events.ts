/**
 * Группа портов **событий, расписаний и webhooks** PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит только `events.ts`.
 * Файл экспортирует единственную фабрику `buildEventPorts(deps)`, возвращающую
 * свою часть `StorageContext`: `eventBindings`, `eventRoutes`, `eventApiKeys`,
 * `eventJournal`, `identityClaims`, `dedup`, `schedules`, `jobs`, `webhooks`,
 * `webhookDeliveries`.
 *
 * Сейчас — заглушки `notImplementedPort`: SQL-реализация появится в волне 3b;
 * контракты — в `packages/core/src/storage/contract/postgres.test.ts`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { notImplementedPort } from './stub.js';

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
  // `deps.connection`/`deps.secretKey` использует волна реализации (SQL + шифрование webhooks).
  void deps;

  return {
    eventBindings: notImplementedPort('eventBindings'),
    eventRoutes: notImplementedPort('eventRoutes'),
    eventApiKeys: notImplementedPort('eventApiKeys'),
    eventJournal: notImplementedPort('eventJournal'),
    identityClaims: notImplementedPort('identityClaims'),
    dedup: notImplementedPort('dedup'),
    schedules: notImplementedPort('schedules'),
    jobs: notImplementedPort('jobs'),
    webhooks: notImplementedPort('webhooks'),
    webhookDeliveries: notImplementedPort('webhookDeliveries'),
  };
}
