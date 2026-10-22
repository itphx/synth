/**
 * Резолвинг синхронных данных/хелперов core для sync-геттеров портов
 * (ADR-097, волна 3b).
 *
 * `@itphx/synth-core` — `peerDependencies` драйвера и подключается только ленивым
 * `import()` (цикл core ↔ драйвер: core динамически грузит драйвер по
 * `storage.backend === 'postgres'`), поэтому статический рантайм-импорт core здесь
 * недопустим. При штатной сборке через core значения инъектируются в конфиг
 * драйвера (`packages/core/src/storage/storage-context.ts`); при прямом вызове
 * `createPostgresStorage` (контрактный suite, внешний потребитель) тот же набор
 * собирается здесь — sync-геттеры иначе не получили бы доступ к данным core.
 */

import { join } from 'node:path';
import type {
  DictionaryRepository,
  ProtectedPathsPolicy,
  SecretPattern,
} from '@itphx/synth-core';
import type { CoreSyncDeps } from './deps.js';

/**
 * Каталог-заглушка пользовательских словарей: реальный override живёт в БД
 * (`settings`), файловый каталог пользователя намеренно пуст.
 */
export const POSTGRES_EMPTY_USER_DICTIONARIES_SUBDIR = 'storage-postgres/no-user-dictionaries';

/** Параметры сборки sync-данных core. */
export interface CoreSyncResolveOptions {
  dataDir: string;
  /** Каталог системных словарей (по умолчанию — `dictionaries/` пакета core). */
  systemDictionariesDir?: string;
}

/**
 * Собрать `CoreSyncDeps` ленивым `import('@itphx/synth-core')`.
 *
 * Используется только когда core не передал значения явно (прямой вызов фабрики);
 * ошибки загрузки core не глушатся — без них sync-геттеры вернули бы неполные данные.
 */
export async function resolveCoreSyncDeps(opts: CoreSyncResolveOptions): Promise<CoreSyncDeps> {
  const core = await import('@itphx/synth-core');

  const secretPatterns: SecretPattern[] = core.DEFAULT_PATTERNS.map((pattern) => ({
    type: pattern.type,
    regex: typeof pattern.regex === 'string' ? pattern.regex : pattern.regex.source,
  }));

  const protectedPathsBase: ProtectedPathsPolicy = core.loadProtectedPaths({ overridePath: '' });

  const systemDictionaries: DictionaryRepository = new core.DictionaryStore(
    join(opts.dataDir, POSTGRES_EMPTY_USER_DICTIONARIES_SUBDIR),
    opts.systemDictionariesDir,
  );

  return { secretPatterns, protectedPathsBase, systemDictionaries };
}
