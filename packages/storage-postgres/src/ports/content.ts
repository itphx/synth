/**
 * Группа портов **контента, секретов и обслуживания** PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит только `content.ts`.
 * Файл экспортирует единственную фабрику `buildContentPorts(deps)`, возвращающую
 * свою часть `StorageContext`: `serviceKeys`, `sshKeys`, `mcpRegistry`,
 * `skillBundles`, `dictionaries`, `secretPatterns`, `protectedPaths`,
 * `maintenanceAudit`.
 *
 * Сейчас — заглушки `notImplementedPort`: SQL-реализация появится в волне 3b;
 * контракты — в `packages/core/src/storage/contract/postgres.test.ts`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { notImplementedPort } from './stub.js';

/** Часть `StorageContext`, которой владеет группа `content`. */
export type ContentPorts = Pick<
  StorageContext,
  | 'serviceKeys'
  | 'sshKeys'
  | 'mcpRegistry'
  | 'skillBundles'
  | 'dictionaries'
  | 'secretPatterns'
  | 'protectedPaths'
  | 'maintenanceAudit'
>;

/** Собрать порты группы `content`. */
export function buildContentPorts(deps: PortDeps): ContentPorts {
  // `deps.connection`/`deps.secretKey`/файловые пути использует волна реализации.
  void deps;

  return {
    serviceKeys: notImplementedPort('serviceKeys'),
    sshKeys: notImplementedPort('sshKeys'),
    mcpRegistry: notImplementedPort('mcpRegistry'),
    skillBundles: notImplementedPort('skillBundles'),
    dictionaries: notImplementedPort('dictionaries'),
    secretPatterns: notImplementedPort('secretPatterns'),
    protectedPaths: notImplementedPort('protectedPaths'),
    maintenanceAudit: notImplementedPort('maintenanceAudit'),
  };
}
