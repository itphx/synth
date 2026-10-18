/**
 * ADR-094: фоновые метрики хранилища (`startStorageMetrics`).
 * memory-порты + временный каталог данных (размеры по верхнеуровневым kind).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsRegistry } from '../registry.js';
import { createMemoryStorage } from '../../storage/storage-context.js';
import { startStorageMetrics } from './storage.js';

/** Значение серии по точному префиксу строки (`name{...} value`). */
function valueOf(text: string, prefix: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${prefix} `));
  if (!line) return undefined;
  return Number(line.slice(prefix.length + 1));
}

describe('startStorageMetrics', () => {
  it('backend/degraded/records + рекурсивный размер dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'synth-storage-metrics-'));
    const storage = createMemoryStorage();
    try {
      await mkdir(join(dataDir, 'sessions'), { recursive: true });
      await writeFile(join(dataDir, 'sessions', 'a.json'), '0123456789');
      await mkdir(join(dataDir, 'providers'), { recursive: true });
      await writeFile(join(dataDir, 'loose.txt'), 'abc');

      const registry = new MetricsRegistry();
      const stop = startStorageMetrics(registry, {
        sessions: storage.sessions,
        projects: storage.projects,
        providers: storage.providers,
        models: storage.models,
        agents: storage.agents,
        webhooks: storage.webhooks,
        schedules: storage.schedules,
        eventBindings: storage.eventBindings,
        eventRoutes: storage.eventRoutes,
        dataDir,
        backend: storage.kind,
        degraded: () => false,
      });

      await vi.waitFor(() => {
        const rendered = registry.render().text;
        expect(valueOf(rendered, 'synth_storage_backend_info{backend="memory"}')).toBe(1);
        expect(valueOf(rendered, 'synth_storage_degraded')).toBe(0);
        expect(valueOf(rendered, 'synth_store_records{store="sessions"}')).toBe(0);
        expect(valueOf(rendered, 'synth_store_records{store="event_routes"}')).toBe(0);
        expect(valueOf(rendered, 'synth_datadir_bytes{kind="sessions"}')).toBe(10);
        expect(valueOf(rendered, 'synth_datadir_bytes{kind="other"}')).toBe(3);
      });

      stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('degraded=true отражается в gauge; отсутствующий dataDir не ломает сбор', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    const stop = startStorageMetrics(registry, {
      sessions: storage.sessions,
      projects: storage.projects,
      providers: storage.providers,
      models: storage.models,
      agents: storage.agents,
      webhooks: storage.webhooks,
      schedules: storage.schedules,
      eventBindings: storage.eventBindings,
      eventRoutes: storage.eventRoutes,
      dataDir: join(tmpdir(), 'synth-storage-metrics-missing-dir-xyz'),
      backend: 'file',
      degraded: () => true,
    });

    await vi.waitFor(() => {
      const rendered = registry.render().text;
      expect(valueOf(rendered, 'synth_storage_degraded')).toBe(1);
      expect(valueOf(rendered, 'synth_storage_backend_info{backend="file"}')).toBe(1);
    });
    stop();
  });
});
