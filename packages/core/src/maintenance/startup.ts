// ADR-091/ADR-092: операции обслуживания при старте инстанса.
//
// Порядок: отложенное восстановление (`applyPendingRestore`, ADR-091) →
// авто-миграции схемы данных (`applyStartupMigrations`, ADR-092): guard
// совместимости → обязательная страховочная копия (fail-closed) → применение
// pending-миграций под межпроцессным локом `{dataDir}/migrate`. Восстановление
// меняет данные, поэтому миграции идут строго по восстановленным данным.
//
// Общий для standalone-core (`server/app/deps.ts`) и managed-backend
// (`backend/src/app/deps.ts`) — чтобы операции шли один раз на старт, а не на
// каждый ход, и данные не портились без копии.
import { join } from 'node:path';
import type { SessionManager, SessionProjectStoreLike } from '../sessions/manager.js';
import { FileMutex } from '../storage/file-mutex.js';
import {
  checkInstanceCompatibility,
  InstanceDataTooNewError,
  runMigrations,
} from '../storage/instance-meta.js';
import type { SettingsRepository } from '../storage/ports/settings-repository.js';
import { createBackup, safetyCopyPath } from './backup.js';
import { cancelPendingRestore, getPendingRestore } from './service.js';
import { restoreBackup } from './restore.js';

/** Опции `applyPendingRestore` (ADR-091). */
export interface ApplyPendingRestoreOptions {
  /** Каталог данных инстанса. */
  dataDir: string;
  /** Канал вывода (по умолчанию `console.warn`). */
  log?: (m: string) => void;
}

/**
 * Применяет отложенный запрос на восстановление (ADR-091) — офлайн-операция,
 * выполняемая при старте до миграций и до использования стораджей.
 *
 * - Запроса нет → `{restored:false}` (ничего не делает).
 * - Запрос есть → `restoreBackup` (со страховочной копией по `safetyCopy`),
 *   затем файл запроса удаляется (восстановление возвращает каталог к снимку,
 *   поэтому `maintenance/` уже сброшен — удаление идемпотентно).
 * - Ошибка валидации/восстановления → запрос **не** удаляется, ошибка
 *   пробрасывается выше (fail-closed: старт с невалидным запросом
 *   останавливается с понятным сообщением — оператор исправляет или отменяет).
 *
 * @returns признак применения и путь восстановленного архива.
 */
export async function applyPendingRestore(
  opts: ApplyPendingRestoreOptions,
): Promise<{ restored: boolean; archive?: string }> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const request = await getPendingRestore(opts.dataDir);
  if (!request) return { restored: false };

  const result = await restoreBackup({
    archive: request.archive,
    dataDir: opts.dataDir,
    safetyCopy: request.safetyCopy,
  });
  // Восстановление уже сбросило `maintenance/` (возврат к снимку) — вызов
  // идемпотентен и страхует случай, когда запрос сохранился.
  await cancelPendingRestore(opts.dataDir);
  log(
    `⚠️ Обнаружен запрос на восстановление из ${request.archive}: восстановление выполнено ` +
      `(страховочная копия: ${result.safetyCopyPath ?? 'не создавалась'}).`,
  );
  return { restored: true, archive: request.archive };
}

/** Опции `applyStartupMigrations` (ADR-092). */
export interface ApplyStartupMigrationsOptions {
  /** Каталог данных инстанса. */
  dataDir: string;
  /** Runtime-настройки: маркеры разовых миграций (`settings.json`). */
  settingsStore: SettingsRepository;
  /** Менеджер сессий (миграции данных сессий); нет — шаг не выполняется. */
  sessionManager?: SessionManager;
  /** Загрузка проекта (для снапшотов скоупа). */
  projectStore?: SessionProjectStoreLike;
  /** Системные дефолты для сессий без проекта. */
  resolveSystemDefaults?: () => Promise<{ mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined>;
  /** Канал вывода (по умолчанию `console.warn`). */
  log?: (m: string) => void;
}

/**
 * Применяет pending-миграции схемы данных при старте инстанса (ADR-092).
 *
 * 1. `checkInstanceCompatibility`; `too-new` → `InstanceDataTooNewError`;
 *    нет pending → `{applied: []}` (ничего не пишется).
 * 2. **Страховочная копия обязательна** перед записью: `createBackup` в
 *    `{dataDir}/backups/` (с секретами). Ошибка копирования → миграции не
 *    выполняются (fail-closed).
 * 3. Миграции применяются под межпроцессным локом `{dataDir}/migrate`
 *    (`FileMutex`, heartbeat), чтобы параллельные старты не писали одновременно.
 *
 * @returns применённые id миграций и путь страховочной копии (если создавалась).
 */
export async function applyStartupMigrations(
  opts: ApplyStartupMigrationsOptions,
): Promise<{ applied: string[]; safetyCopyPath?: string }> {
  const { dataDir } = opts;
  const log = opts.log ?? ((m: string) => console.warn(m));

  // 1. Guard совместимости: данные новее Synth — отказ старта (fail-closed).
  const compatibility = await checkInstanceCompatibility(dataDir);
  if (compatibility.status === 'too-new') {
    throw new InstanceDataTooNewError(
      compatibility.meta ?? {
        schemaVersion: compatibility.currentVersion,
        instanceVersion: '',
        migrations: [],
        updatedAt: '',
      },
      compatibility.expectedVersion,
    );
  }
  if (compatibility.pending.length === 0) return { applied: [] };

  // 2. Страховочная копия — обязательна перед записью (ADR-092). Без неё не
  //    мигрируем: повреждение данных без отката недопустимо.
  const copyPath = safetyCopyPath(dataDir, 'pre-migrate');
  try {
    await createBackup({ dataDir, out: copyPath, withSecrets: true });
  } catch (err) {
    throw new Error(
      `Не удалось создать страховочную копию перед миграцией (${copyPath}): ` +
        `${err instanceof Error ? err.message : String(err)}; миграции не применены.`,
    );
  }

  // 3. Применение миграций под межпроцессным локом.
  const mutex = new FileMutex({ path: join(dataDir, 'migrate') });
  const result = await mutex.withLock(
    () =>
      runMigrations({
        dataDir,
        deps: {
          settingsStore: opts.settingsStore,
          ...(opts.sessionManager ? { sessionManager: opts.sessionManager } : {}),
          ...(opts.projectStore ? { projectStore: opts.projectStore } : {}),
          ...(opts.resolveSystemDefaults ? { resolveSystemDefaults: opts.resolveSystemDefaults } : {}),
        },
      }),
    { heartbeat: true },
  );

  // 4. Единственное предупреждение на старт (не на ход), без секретов.
  log(
    `⚠️ Схема данных устарела (${compatibility.currentVersion} → ${compatibility.expectedVersion}): ` +
      `создана страховочная копия ${copyPath}, миграции применены: ${result.applied.join(', ')}`,
  );

  return { applied: result.applied, safetyCopyPath: copyPath };
}
