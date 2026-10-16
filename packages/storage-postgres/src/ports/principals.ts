/**
 * Группа портов **принципалов и конфигурации** PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит только `principals.ts`.
 * Файл экспортирует единственную фабрику `buildPrincipalPorts(deps)`, возвращающую
 * свою часть `StorageContext`: `projects`, `profiles`, `settings`, `defaults`,
 * `providers`, `models`, `agents`.
 *
 * Сейчас — заглушки `notImplementedPort`: SQL-реализация появится в волне 3b;
 * контракты — в `packages/core/src/storage/contract/postgres.test.ts`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { notImplementedPort } from './stub.js';

/** Часть `StorageContext`, которой владеет группа `principals`. */
export type PrincipalPorts = Pick<
  StorageContext,
  'projects' | 'profiles' | 'settings' | 'defaults' | 'providers' | 'models' | 'agents'
>;

/** Собрать порты группы `principals`. */
export function buildPrincipalPorts(deps: PortDeps): PrincipalPorts {
  // `deps.connection`/`deps.dataDir` использует волна реализации (SQL-запросы).
  void deps;

  return {
    projects: notImplementedPort('projects'),
    profiles: notImplementedPort('profiles'),
    settings: notImplementedPort('settings'),
    defaults: notImplementedPort('defaults'),
    providers: notImplementedPort('providers'),
    models: notImplementedPort('models'),
    agents: notImplementedPort('agents'),
  };
}
