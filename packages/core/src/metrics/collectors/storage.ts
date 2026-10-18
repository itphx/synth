/**
 * ADR-094: фоновые gauge хранилища.
 *
 * Три группы:
 * - `synth_store_records{store}` — число записей через доменные порты;
 * - `synth_storage_degraded` и `synth_storage_backend_info{backend}` — состояние;
 * - `synth_datadir_bytes{kind}` — рекурсивный размер верхнеуровневых каталогов
 *   dataDir (симлинки не разыменовываются, ошибки прав пропускаются).
 *
 * Интервалы: записи/деградация — 60 c, размеры — 300 c. Таймеры `unref`,
 * ошибки не пробрасываются.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DocumentRepository,
  EventBindingRepository,
  EventRouteRepository,
  ProjectRepository,
  ScheduleRepository,
  SessionRepository,
  WebhookRepository,
} from '../../storage/ports/index.js';
import type { StorageBackendKind } from '../../storage/storage-context.js';
import type { MetricsRegistry } from '../registry.js';

/** Период обновления записей/деградации, мс. */
export const STORAGE_RECORDS_INTERVAL_MS = 60_000;

/** Период обновления размеров dataDir, мс. */
export const STORAGE_BYTES_INTERVAL_MS = 300_000;

/** Контрактные значения лейбла `kind` для `synth_datadir_bytes`. */
export const DATADIR_KINDS = [
  'sessions',
  'projects',
  'providers',
  'models',
  'agents',
  'events',
  'webhooks',
  'scheduler',
  'audit',
  'workspaces',
  'secrets',
  'other',
] as const;

/** Источники данных коллектора (порты слоя хранения, ADR-096). */
export interface StorageMetricsSources {
  dataDir: string;
  backend: StorageBackendKind;
  /** Деградированное хранилище (файловый read-only фоллбек, ADR-098). */
  degraded: () => boolean;
  sessions: SessionRepository;
  projects: ProjectRepository;
  providers: DocumentRepository<unknown>;
  models: DocumentRepository<unknown>;
  agents: DocumentRepository<unknown>;
  webhooks: WebhookRepository;
  schedules: ScheduleRepository;
  eventBindings: EventBindingRepository;
  eventRoutes: EventRouteRepository;
}

/** Рекурсивный размер каталога; симлинки/ошибки — пропуск. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        total += await directorySize(full);
      } else if (entry.isFile()) {
        const info = await lstat(full);
        total += info.size;
      }
    } catch {
      // Права/исчезнувший файл — просто пропускаем.
    }
  }
  return total;
}

/**
 * Запустить фоновый сбор метрик хранилища. Возвращает функцию остановки.
 */
export function startStorageMetrics(
  registry: MetricsRegistry,
  sources: StorageMetricsSources,
  options: { recordsIntervalMs?: number; bytesIntervalMs?: number } = {},
): () => void {
  const datadir = registry.gauge(
    'synth_datadir_bytes',
    'Size of top-level data directories in bytes.',
    ['kind'],
  );
  const records = registry.gauge(
    'synth_store_records',
    'Number of records in a storage store.',
    ['store'],
  );
  const degraded = registry.gauge(
    'synth_storage_degraded',
    'Whether storage is running in degraded (read-only fallback) mode.',
  );
  const backendInfo = registry.gauge(
    'synth_storage_backend_info',
    'Storage backend information (value is always 1).',
    ['backend'],
  );

  let stopped = false;

  const collectRecords = async (): Promise<void> => {
    if (stopped) return;
    try {
      backendInfo.set({ backend: sources.backend }, 1);
      degraded.set(sources.degraded() ? 1 : 0);
    } catch {
      // ignore
    }

    const read = async <T>(store: string, fn: () => Promise<T[]>): Promise<void> => {
      try {
        const items = await fn();
        records.set({ store }, items.length);
      } catch {
        // Ошибка одного порта не мешает остальным.
      }
    };

    await Promise.all([
      read('sessions', () => sources.sessions.listLight()),
      read('projects', () => sources.projects.list()),
      read('providers', () => sources.providers.list()),
      read('models', () => sources.models.list()),
      read('agents', () => sources.agents.list()),
      read('webhooks', () => sources.webhooks.list()),
      read('schedules', () => sources.schedules.list()),
      read('event_bindings', () => sources.eventBindings.list()),
      read('event_routes', () => sources.eventRoutes.list()),
    ]);
  };

  const collectBytes = async (): Promise<void> => {
    if (stopped) return;
    const totals = new Map<string, number>();
    for (const kind of DATADIR_KINDS) totals.set(kind, 0);

    let entries: Dirent[];
    try {
      entries = await readdir(sources.dataDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const kind = (DATADIR_KINDS as readonly string[]).includes(entry.name)
        && entry.name !== 'other'
        ? entry.name
        : 'other';
      const full = join(sources.dataDir, entry.name);
      try {
        if (entry.isDirectory()) {
          totals.set(kind, (totals.get(kind) ?? 0) + (await directorySize(full)));
        } else if (entry.isFile()) {
          totals.set(kind, (totals.get(kind) ?? 0) + (await lstat(full)).size);
        }
      } catch {
        // ignore
      }
    }

    for (const kind of DATADIR_KINDS) {
      datadir.set({ kind }, totals.get(kind) ?? 0);
    }
  };

  void collectRecords();
  void collectBytes();
  const recordsTimer = setInterval(() => {
    void collectRecords();
  }, options.recordsIntervalMs ?? STORAGE_RECORDS_INTERVAL_MS);
  recordsTimer.unref?.();
  const bytesTimer = setInterval(() => {
    void collectBytes();
  }, options.bytesIntervalMs ?? STORAGE_BYTES_INTERVAL_MS);
  bytesTimer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(recordsTimer);
    clearInterval(bytesTimer);
  };
}
