/**
 * Группа портов **сессий** PostgreSQL-драйвера (PROP-032, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит только `sessions.ts`.
 * Файл экспортирует единственную фабрику `buildSessionPorts(deps)`, возвращающую
 * свою часть `StorageContext` (`sessions` — и в будущем только он).
 *
 * Сейчас — заглушка `notImplementedPort`: SQL-реализация появится в волне 3b;
 * контракт (`describeSessionRepository`) — в
 * `packages/core/src/storage/contract/postgres.test.ts`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { notImplementedPort } from './stub.js';

/** Часть `StorageContext`, которой владеет группа `sessions`. */
export type SessionPorts = Pick<StorageContext, 'sessions'>;

/** Собрать порты группы `sessions`. */
export function buildSessionPorts(deps: PortDeps): SessionPorts {
  // `deps.connection`/`deps.dataDir` использует волна реализации (SQL-запросы).
  void deps;

  return {
    sessions: notImplementedPort('sessions'),
  };
}
