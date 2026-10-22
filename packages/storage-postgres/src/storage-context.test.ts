/**
 * Герметичные тесты сборки `StorageContext` PostgreSQL-драйвера (ADR-097).
 *
 * Регресс: `buildContentPorts` запускает прогрев синхронных кэшей
 * (`secretPatterns`/`protectedPaths`/`dictionaries`) fire-and-forget. Если
 * `close()` не дожидается фонового прогрева, warm-запросы уходят в уже закрытый
 * пул (`connection.end()`) и диагностика (`synth doctor`), `backup`/`migrate`
 * видят ложные предупреждения «прогрев порта не удался: пул недоступен», хотя
 * БД и схема в порядке.
 *
 * Тест герметичный: живая БД не нужна — соединение подменяется фейком, который
 * считает запросы, выполненные после `end()`.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PostgresConnection } from './pool.js';
import type { CoreSyncDeps } from './ports/deps.js';
import { buildPostgresStorageContext } from './storage-context.js';

const DATA_DIR = join(tmpdir(), 'synth-pg-context');

/** Минимальная инъекция core: прогрев её не использует (только `settings`). */
const CORE_SYNC: CoreSyncDeps = {
  secretPatterns: [],
  protectedPathsBase: {},
  systemDictionaries: {},
} as unknown as CoreSyncDeps;

interface FakeStats {
  /** Запросы, выполненные **после** `end()` (должно быть 0). */
  postEndQueries: number;
  /** Чтения `settings` — по одному на каждый прогреваемый порт. */
  settingsQueries: number;
}

/**
 * Фейковое соединение: `query` отвечает с задержкой (чтобы прогрев оставался
 * «в полёте» к моменту `close()`), а после `end()` — бросает и инкрементит
 * счётчик. Схема «инициализирована» (версия 1), поэтому прогрев идёт в БД.
 */
function makeFakeConnection(): { connection: PostgresConnection; stats: FakeStats } {
  const stats: FakeStats = { postEndQueries: 0, settingsQueries: 0 };
  let closed = false;

  const connection = {
    schema: 'synth',
    query: async (text: string): Promise<unknown[]> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (closed) {
        stats.postEndQueries += 1;
        throw new Error('Соединение с PostgreSQL закрыто (end()): пул недоступен.');
      }
      if (text.includes('to_regclass')) return [{ t: 'synth.synth_schema_migrations' }];
      if (text.includes('FROM synth_schema_migrations')) return [{ version: 1 }];
      if (text.includes('FROM settings')) {
        stats.settingsQueries += 1;
        return [];
      }
      return [];
    },
    end: async (): Promise<void> => {
      closed = true;
    },
  } as unknown as PostgresConnection;

  return { connection, stats };
}

describe('buildPostgresStorageContext.close', () => {
  it('дожидается фонового прогрева и не закрывает пул под warm-запросами', async () => {
    const { connection, stats } = makeFakeConnection();
    const ctx = buildPostgresStorageContext({
      dataDir: DATA_DIR,
      connection,
      coreSync: CORE_SYNC,
    });

    await ctx.close?.();

    // Ни одно warm-обращение не попало в уже закрытый пул — иначе именно здесь
    // появляются ложные «прогрев порта … не удался: пул недоступен».
    expect(stats.postEndQueries).toBe(0);
    // Прогрев реально отработал: три порта прочитали свой ключ из `settings`.
    expect(stats.settingsQueries).toBe(3);
  });
});
