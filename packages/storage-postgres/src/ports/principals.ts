/**
 * Группа портов **принципалов и конфигурации** PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит `principals.ts` и
 * `principals-*.ts`. Файл экспортирует единственную фабрику
 * `buildPrincipalPorts(deps)`, возвращающую свою часть `StorageContext`:
 * `projects`, `profiles`, `settings`, `defaults`, `providers`, `models`,
 * `agents`.
 *
 * Реализация разложена по файлам (по одному ответственному порту/семейству):
 *   - `principals-projects.ts`  → `projects` (projects + project_members);
 *   - `principals-profiles.ts`  → `profiles` (profiles + profile_identities);
 *   - `principals-settings.ts`  → `settings` (settings + token_ratios +
 *     migration_markers);
 *   - `principals-defaults.ts`  → `defaults` (ключ в `settings`);
 *   - `principals-documents.ts` → `providers`/`models`/`agents` (documents).
 *
 * `deps.dataDir` этим портам не нужен: всё состояние — в БД (секции/документы),
 * файловых путей у группы нет. Контракты — `packages/core/src/storage/contract/*`.
 */

import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import {
  createDocumentPort,
  type AgentDocument,
  type ModelDocument,
  type ProviderDocument,
} from './principals-documents.js';
import { createPrincipalDefaultsPort } from './principals-defaults.js';
import { createPrincipalProfilesPort } from './principals-profiles.js';
import { createPrincipalProjectsPort } from './principals-projects.js';
import { createPrincipalSettingsPort } from './principals-settings.js';

/** Часть `StorageContext`, которой владеет группа `principals`. */
export type PrincipalPorts = Pick<
  StorageContext,
  'projects' | 'profiles' | 'settings' | 'defaults' | 'providers' | 'models' | 'agents'
>;

/** Собрать порты группы `principals`. */
export function buildPrincipalPorts(deps: PortDeps): PrincipalPorts {
  const { connection } = deps;

  return {
    projects: createPrincipalProjectsPort(connection),
    profiles: createPrincipalProfilesPort(connection),
    settings: createPrincipalSettingsPort(connection),
    defaults: createPrincipalDefaultsPort(connection),
    providers: createDocumentPort<ProviderDocument>(connection, 'provider'),
    models: createDocumentPort<ModelDocument>(connection, 'model'),
    agents: createDocumentPort<AgentDocument>(connection, 'agent'),
  };
}
