/**
 * Общие зависимости сборки доменных портов PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Один объект `PortDeps` передаётся во все четыре файла-группы
 * (`sessions`/`principals`/`events`/`content`), чтобы каждая группа брала только
 * нужное ей и не зависела от остальных. Поля описывают ровно то, что реально
 * требуется портам при реализации поверх SQL:
 *   - `connection` — живой пул/примитивы запросов (`query`/`withTransaction`/
 *     `withAdvisoryLock`) из `pool.ts`, удерживается в `StorageContext`;
 *   - `dataDir` — базовый каталог инстанса (файловые нужды, пути по умолчанию);
 *   - `secretKey`/`env` — шифрование секретов at-rest (`sshKeys`/`webhooks`);
 *   - `systemDictionariesDir`/`contextUserDataDir` — файловые пути словарей и
 *     контента (для групп, которые совмещают SQL-хранение с файловым контентом).
 *
 * Никаких модульных синглтонов: `deps` собирается на каждый
 * `buildPostgresStorageContext` (герметичность тестов и переключаемых схем).
 */

import type { DictionaryRepository, ProtectedPathsPolicy, SecretPattern } from '@itphx/synth-core';
import type { PostgresConnection } from '../pool.js';

/**
 * Синхронные данные/хелперы `@itphx/synth-core`, нужные sync-геттерам портов
 * (`secretPatterns`/`protectedPaths`/`dictionaries`).
 *
 * Sync-геттеры вызываются на горячем пути (сборка промпта, детекция секретов,
 * маршрутизация) и не могут ждать I/O или ленивый `import()`. Core **инъектирует**
 * их в конфиг драйвера (`packages/core/src/storage/storage-context.ts`) —
 * это заменяет прежний обход `exports`-карты core; при прямом вызове
 * `createPostgresStorage` (контрактный suite, внешний потребитель) драйвер
 * собирает тот же набор ленивым `import('@itphx/synth-core')` (`core-sync.ts`).
 */
export interface CoreSyncDeps {
  /** Дефолтные паттерны детекции секретов в сериализуемой форме (core `DEFAULT_PATTERNS`). */
  secretPatterns: SecretPattern[];
  /** Системный base политики защищённых путей (core `loadProtectedPaths`, без override). */
  protectedPathsBase: ProtectedPathsPolicy;
  /** Системный источник словарей (core `DictionaryStore`, реализация `DictionaryRepository`). */
  systemDictionaries: DictionaryRepository;
}

/** Общие зависимости портов: соединение + пути/ключи, не привязанные к порту. */
export interface PortDeps {
  /** Живое соединение драйвера (пул + примитивы запросов/транзакций/локов). */
  connection: PostgresConnection;
  /** Базовый каталог данных инстанса. */
  dataDir: string;
  /** ADR-076: мастер-ключ секретов at-rest (env > config > файл в dataDir). */
  secretKey?: string;
  /** Окружение процесса (резолвинг секретов/путей). */
  env?: NodeJS.ProcessEnv;
  /** Каталог системных словарей (по умолчанию — `dictionaries/` пакета core). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (по умолчанию `{dataDir}/context`). */
  contextUserDataDir?: string;
  /** ADR-097/PROP-032: инъекция sync-данных core (см. `CoreSyncDeps`). */
  coreSync: CoreSyncDeps;
  /**
   * Регистрация фоновой задачи сборки, которую владелец контекста обязан
   * дождаться в `close()` **до** закрытия пула. Нужна для fire-and-forget
   * прогрева синхронных кэшей `content`: без учёта warm-запросы попадают в уже
   * закрытый пул и дают ложные предупреждения «пул недоступен».
   */
  trackBackground?: (task: Promise<unknown>) => void;
}
