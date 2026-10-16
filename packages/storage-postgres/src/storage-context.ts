/**
 * Сборка `StorageContext` PostgreSQL-драйвера (PROP-032, волна 3b-каркас).
 *
 * Контекст собирается из четырёх независимых файлов-групп
 * (`src/ports/{sessions,principals,events,content}.ts`) — по одной фабрике на
 * группу, чтобы волна реализации правила группы параллельно и без конфликтов:
 *   - `buildSessionPorts(deps)`   → `sessions`;
 *   - `buildPrincipalPorts(deps)` → `projects`/`profiles`/`settings`/`defaults`/
 *     `providers`/`models`/`agents`;
 *   - `buildEventPorts(deps)`     → `eventBindings`/`eventRoutes`/`eventApiKeys`/
 *     `eventJournal`/`identityClaims`/`dedup`/`schedules`/`jobs`/`webhooks`/
 *     `webhookDeliveries`;
 *   - `buildContentPorts(deps)`   → `serviceKeys`/`sshKeys`/`mcpRegistry`/
 *     `skillBundles`/`dictionaries`/`secretPatterns`/`protectedPaths`/
 *     `maintenanceAudit`.
 *
 * Сейчас все четыре группы отдают заглушки `notImplementedPort`; FS/package-bound
 * порты (`skills`, `contextFiles`, `blobs`) — **файловые реализации** core
 * (контент скиллов/prompts-ролей и blob-дерево остаются на диске; ADR-091/ADR-092:
 * ФС-периметр вне портов).
 *
 * Осознанное исключение: драйвер в этой части **импортирует core рантаймом**
 * (`createFileStorage`), чтобы переиспользовать уже проверенные файловые
 * реализации, а не дублировать их. Для портов БД core по-прежнему не тянется:
 * порты подключаются динамическим `import()` из core по `storage.backend`.
 */

import { createFileStorage } from '@itphx/synth-core';
import type { StorageContext } from '@itphx/synth-core';
import type { PostgresConnection } from './pool.js';
import { buildContentPorts } from './ports/content.js';
import type { CoreSyncDeps, PortDeps } from './ports/deps.js';
import { buildEventPorts } from './ports/events.js';
import { buildPrincipalPorts } from './ports/principals.js';
import { buildSessionPorts } from './ports/sessions.js';

/** Опции сборки контекста PostgreSQL. */
export interface BuildPostgresContextOptions {
  dataDir: string;
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Каталог системных словарей (пробрасывается группе `content`/файловым портам). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (файловый порт `contextFiles`). */
  contextUserDataDir?: string;
  /**
   * PROP-032: живое соединение драйвера — удерживается в контексте, порты БД
   * ходят через него; `close()` контекста закрывает пул.
   */
  connection: PostgresConnection;
  /** ADR-097/PROP-032: синхронные данные/хелперы core (см. `CoreSyncDeps`). */
  coreSync: CoreSyncDeps;
}

/** Собрать `StorageContext`: четыре группы портов + файловые FS-порты + `close`. */
export function buildPostgresStorageContext(opts: BuildPostgresContextOptions): StorageContext {
  // Файловый контекст переиспользуется только для FS/package-bound портов
  // (`skills`/`contextFiles`/`blobs`); прочие его порты не задействованы.
  const file = createFileStorage({
    dataDir: opts.dataDir,
    secretKey: opts.secretKey,
    env: opts.env,
    systemDictionariesDir: opts.systemDictionariesDir,
    contextUserDataDir: opts.contextUserDataDir,
  });

  const deps: PortDeps = {
    connection: opts.connection,
    dataDir: opts.dataDir,
    secretKey: opts.secretKey,
    env: opts.env,
    systemDictionariesDir: opts.systemDictionariesDir,
    contextUserDataDir: opts.contextUserDataDir,
    coreSync: opts.coreSync,
  };

  return {
    kind: 'postgres',
    // PROP-032: соединение живёт в контексте; `close()` закрывает пул (graceful
    // shutdown домена).
    close: () => opts.connection.end(),
    ...buildSessionPorts(deps),
    ...buildPrincipalPorts(deps),
    ...buildEventPorts(deps),
    ...buildContentPorts(deps),
    // FS/package-bound порты: остаются файловыми (см. шапку модуля).
    skills: file.skills,
    contextFiles: file.contextFiles,
    blobs: file.blobs,
  };
}
