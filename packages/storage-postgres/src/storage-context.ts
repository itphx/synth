/**
 * Сборка `StorageContext` PostgreSQL-драйвера (PROP-032, волна 3a).
 *
 * До реализации доменных портов (следующая волна) контекст собирается так:
 *   - **файловые реализации** для FS/package-bound портов (`skills`,
 *     `contextFiles`, `blobs`) — контент скиллов/prompts-ролей и blob-дерево
 *     остаются на диске (ADR-091/ADR-092: ФС-периметр вне портов);
 *   - **заглушки PG** для остальных портов — бросают
 *     `PostgresStorageNotImplementedError` с именем порта (контракт для
 *     следующих волн).
 *
 * Осознанное исключение: драйвер в этой части **импортирует core рантаймом**
 * (`createFileStorage`), чтобы переиспользовать уже проверенные файловые
 * реализации, а не дублировать их. Для портов БД core по-прежнему не тянется:
 * порты подключаются динамическим `import()` из core по `storage.backend`.
 */

import { createFileStorage } from '@itphx/synth-core';
import type { StorageContext } from '@itphx/synth-core';
import { PostgresStorageNotImplementedError } from './errors.js';

/**
 * Заглушка порта: любой доступ к методу бросает понятную ошибку с именем порта.
 * Методы кэшируются (стабильные ссылки на функцию), символьные ключи не трогаем.
 */
export function notImplementedPort<T>(port: string): T {
  const methods = new Map<PropertyKey, () => never>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop === 'symbol') return undefined;
        let method = methods.get(prop);
        if (!method) {
          method = () => {
            throw new PostgresStorageNotImplementedError(
              `Порт '${port}' ещё не реализован в PostgreSQL-драйвере (PROP-032, волна реализации портов).`,
            );
          };
          methods.set(prop, method);
        }
        return method;
      },
    },
  );
  return proxy as T;
}

/** Опции сборки контекста PostgreSQL. */
export interface BuildPostgresContextOptions {
  dataDir: string;
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}

/** Собрать `StorageContext` с файловыми FS-портами и заглушками остальных. */
export function buildPostgresStorageContext(opts: BuildPostgresContextOptions): StorageContext {
  // Файловый контекст переиспользуется только для FS/package-bound портов
  // (`skills`/`contextFiles`/`blobs`); прочие его порты не задействованы.
  const file = createFileStorage({
    dataDir: opts.dataDir,
    secretKey: opts.secretKey,
    env: opts.env,
  });

  return {
    kind: 'postgres',
    sessions: notImplementedPort('sessions'),
    projects: notImplementedPort('projects'),
    profiles: notImplementedPort('profiles'),
    settings: notImplementedPort('settings'),
    defaults: notImplementedPort('defaults'),
    secretPatterns: notImplementedPort('secretPatterns'),
    protectedPaths: notImplementedPort('protectedPaths'),
    dictionaries: notImplementedPort('dictionaries'),
    providers: notImplementedPort('providers'),
    models: notImplementedPort('models'),
    agents: notImplementedPort('agents'),
    mcpRegistry: notImplementedPort('mcpRegistry'),
    serviceKeys: notImplementedPort('serviceKeys'),
    eventApiKeys: notImplementedPort('eventApiKeys'),
    eventBindings: notImplementedPort('eventBindings'),
    eventRoutes: notImplementedPort('eventRoutes'),
    eventJournal: notImplementedPort('eventJournal'),
    identityClaims: notImplementedPort('identityClaims'),
    webhooks: notImplementedPort('webhooks'),
    webhookDeliveries: notImplementedPort('webhookDeliveries'),
    schedules: notImplementedPort('schedules'),
    jobs: notImplementedPort('jobs'),
    maintenanceAudit: notImplementedPort('maintenanceAudit'),
    dedup: notImplementedPort('dedup'),
    skillBundles: notImplementedPort('skillBundles'),
    sshKeys: notImplementedPort('sshKeys'),
    // FS/package-bound порты: остаются файловыми (см. шапку модуля).
    skills: file.skills,
    contextFiles: file.contextFiles,
    blobs: file.blobs,
  };
}
