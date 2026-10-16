// ADR-092: версионирование схемы данных инстанса, реестр миграций и guard
// совместимости.
//
// Глобальная версия схемы каталога данных хранится в `{dataDir}/meta.json`:
// `{ schemaVersion, instanceVersion, migrations, updatedAt }`. Миграции —
// идемпотентная цепочка `toVersion`-монотонного реестра, применяемая командой
// `synth migrate`. Отсутствующий `meta.json` трактуется как `schemaVersion = 0`
// (существующие инсталляции до введения meta).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, SYNTH_VERSION } from '@itphx/synth-shared';
import type { SessionManager, SessionProjectStoreLike } from '../sessions/manager.js';
import { migrateSessionScopeSnapshots, SESSION_SCOPE_SNAPSHOT_MIGRATION } from './migrations.js';
import type { SettingsRepository } from './ports/settings-repository.js';

/** Применённая версия схемы данных инстанса (`{dataDir}/meta.json`). */
export interface InstanceMeta {
  /** Применённая версия схемы. */
  schemaVersion: number;
  /** `SYNTH_VERSION` на момент последней миграции/создания meta. */
  instanceVersion: string;
  /** Применённые id миграций (в порядке применения). */
  migrations: string[];
  /** ISO-метка последнего обновления. */
  updatedAt: string;
}

/** Зависимости миграции (ADR-092). */
export interface MigrationDeps {
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
}

/** Элемент реестра миграций (ADR-092). */
export interface Migration {
  /** Стабильный id, напр. `session-scope-snapshots-v1`. */
  id: string;
  /** Версия схемы ПОСЛЕ применения (монотонно, уникально). */
  toVersion: number;
  /** Человекочитаемое описание (для плана `synth migrate --dry-run`). */
  description: string;
  /** Применить миграцию; возвращает число изменённых записей. */
  run(deps: MigrationDeps): Promise<number>;
}

/** Результат проверки совместимости данных с текущей версией Synth. */
export interface InstanceCompatibility {
  status: 'ok' | 'pending' | 'too-new';
  meta: InstanceMeta | null;
  /** Текущая версия: `meta?.schemaVersion ?? 0`. */
  currentVersion: number;
  /** Ожидаемая версия: `SCHEMA_VERSION`. */
  expectedVersion: number;
  /** Миграции с `toVersion > currentVersion` (порядок применения). */
  pending: Migration[];
}

/**
 * Данные инстанса новее версии Synth (схема `meta.schemaVersion` > `expected`).
 * Fail-closed: старт/миграция должны отказаться, иначе можно повредить данные
 * старшей схемы (понижение версии не мигрирует назад — ADR-092).
 */
export class InstanceDataTooNewError extends Error {
  readonly meta: InstanceMeta;
  readonly expected: number;

  constructor(meta: InstanceMeta, expected: number) {
    super(
      `Данные новее версии Synth (схема ${meta.schemaVersion} > ${expected}); обновите Synth.`,
    );
    this.name = 'InstanceDataTooNewError';
    this.meta = meta;
    this.expected = expected;
  }
}

/**
 * ADR-071 §2.4 / ADR-046 §4.5: разовая миграция снапшотов скоупа как элемент
 * общего реестра (ADR-092). Проверка маркера сохранена ВНУТРИ самой миграции
 * (`migrateSessionScopeSnapshots`) — повторный запуск по-прежнему no-op.
 */
export const SESSION_SCOPE_SNAPSHOTS_MIGRATION_V1: Migration = {
  id: SESSION_SCOPE_SNAPSHOT_MIGRATION,
  toVersion: 1,
  description: 'Материализация снапшотов mcpDefaultOn/skillsDefaultOn у существующих сессий',
  run(deps: MigrationDeps): Promise<number> {
    // Нет менеджера сессий — мигрировать нечего (каталог сессий не сконфигурирован).
    if (!deps.sessionManager) return Promise.resolve(0);
    return migrateSessionScopeSnapshots({
      sessionManager: deps.sessionManager,
      projectStore: deps.projectStore,
      settingsStore: deps.settingsStore,
      resolveSystemDefaults: deps.resolveSystemDefaults,
    });
  },
};

/**
 * Реестр миграций, отсортированный по `toVersion` (`SCHEMA_VERSION` =
 * max `toVersion`). Порядок применения — по возрастанию версии.
 */
export const MIGRATIONS: Migration[] = [
  SESSION_SCOPE_SNAPSHOTS_MIGRATION_V1,
].sort((a, b) => a.toVersion - b.toVersion);

/** Текущая (ожидаемая кодом) версия схемы данных — max `toVersion` реестра. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.toVersion), 0);

/** Путь к файлу версии схемы данных. */
function _metaPath(dataDir: string): string {
  return join(dataDir, 'meta.json');
}

/** Нормализует распарсенное значение; форма неверна — `null`. */
function _normalizeMeta(value: unknown): InstanceMeta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion)) return null;
  const migrations = Array.isArray(raw.migrations)
    ? raw.migrations.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    schemaVersion: raw.schemaVersion,
    instanceVersion: typeof raw.instanceVersion === 'string' ? raw.instanceVersion : '',
    migrations,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

/**
 * Читает `{dataDir}/meta.json`. Файл отсутствует, недоступен или битый
 * (не-JSON/неверная форма) → `null` (не бросает).
 */
export async function readInstanceMeta(dataDir: string): Promise<InstanceMeta | null> {
  try {
    const data = await readFile(_metaPath(dataDir), 'utf-8');
    return _normalizeMeta(JSON.parse(data));
  } catch {
    return null;
  }
}

/** Атомарно пишет `{dataDir}/meta.json` (mkdir -p + tmp→rename, ADR-005). */
export async function writeInstanceMeta(dataDir: string, meta: InstanceMeta): Promise<void> {
  const path = _metaPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(
    (p, d) => writeFile(p, d, 'utf-8'),
    (o, n) => rename(o, n),
    path,
    JSON.stringify(meta, null, 2),
  );
}

/**
 * Проверяет совместимость каталога данных с текущей версией Synth.
 * НЕ бросает: возвращает статус (`ok`/`pending`/`too-new`),
 * текущую/ожидаемую версию и список pending-миграций.
 */
export async function checkInstanceCompatibility(dataDir: string): Promise<InstanceCompatibility> {
  const meta = await readInstanceMeta(dataDir);
  const currentVersion = meta?.schemaVersion ?? 0;
  const expectedVersion = SCHEMA_VERSION;
  const pending = MIGRATIONS.filter((m) => m.toVersion > currentVersion);
  const status: InstanceCompatibility['status'] = currentVersion > expectedVersion
    ? 'too-new'
    : pending.length > 0
      ? 'pending'
      : 'ok';
  return { status, meta, currentVersion, expectedVersion, pending };
}

/**
 * Бросает `InstanceDataTooNewError`, если `meta.schemaVersion > SCHEMA_VERSION`
 * (данные новее версии Synth). Пустой/свежий каталог — без ошибки и без записи.
 */
export async function assertInstanceDataNotTooNew(dataDir: string): Promise<void> {
  const meta = await readInstanceMeta(dataDir);
  if (meta && meta.schemaVersion > SCHEMA_VERSION) {
    throw new InstanceDataTooNewError(meta, SCHEMA_VERSION);
  }
}

/**
 * Применяет pending-миграции (ADR-092).
 *
 * `dryRun` — только строит план (`planned`), ничего не выполняет и не пишет.
 * Иначе выполняет миграции по порядку и **один раз** пишет `meta.json`:
 * `migrations` = старое ∪ применённые (без дублей, порядок применения),
 * `schemaVersion` = max применённый `toVersion`, `instanceVersion` = `SYNTH_VERSION`.
 *
 * @throws InstanceDataTooNewError если данные новее ожидаемой схемы.
 */
export async function runMigrations(opts: {
  dataDir: string;
  deps: Omit<MigrationDeps, 'dataDir'>;
  dryRun?: boolean;
  log?: (msg: string) => void;
}): Promise<{ applied: string[]; planned: string[]; updated: number }> {
  const { dataDir, deps, dryRun = false, log } = opts;

  const meta = await readInstanceMeta(dataDir);
  const currentVersion = meta?.schemaVersion ?? 0;

  if (currentVersion > SCHEMA_VERSION) {
    throw new InstanceDataTooNewError(meta ?? {
      schemaVersion: currentVersion,
      instanceVersion: '',
      migrations: [],
      updatedAt: '',
    }, SCHEMA_VERSION);
  }

  const pending = MIGRATIONS.filter((m) => m.toVersion > currentVersion);
  const planned = pending.map((m) => m.id);

  if (dryRun || pending.length === 0) {
    return { applied: [], planned, updated: 0 };
  }

  const applied: string[] = [];
  let updated = 0;
  let schemaVersion = currentVersion;

  for (const migration of pending) {
    log?.(`Применяю миграцию ${migration.id}: ${migration.description}`);
    const count = await migration.run({ ...deps, dataDir });
    updated += count;
    applied.push(migration.id);
    schemaVersion = Math.max(schemaVersion, migration.toVersion);
  }

  const merged = [...(meta?.migrations ?? [])];
  for (const id of applied) {
    if (!merged.includes(id)) merged.push(id);
  }

  await writeInstanceMeta(dataDir, {
    schemaVersion,
    instanceVersion: SYNTH_VERSION,
    migrations: merged,
    updatedAt: new Date().toISOString(),
  });

  return { applied, planned, updated };
}
