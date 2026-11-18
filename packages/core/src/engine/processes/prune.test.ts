/**
 * Retention-очистка логов фоновых процессов (`engine/processes/prune.ts`).
 *
 * У прогона **три** файла лога: общий (`processes/<id>.log`) и по одному на
 * поток (`processes/<id>.stdout.log` / `.stderr.log`). Проверяется:
 *   • «сиротская» очистка каталога `processes/` **не** трогает файлы потоков
 *     живых (не истёкших) записей;
 *   • по истечении срока удаляются **все три** файла;
 *   • файл, на который не ссылается ни одна запись, удаляется как сирота.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { startProcessLogPruner } from './prune.js';

/** Запись реестра фонового процесса. */
function processRecord(
  id: string,
  overrides: Partial<BackgroundRunRecord> = {},
): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    logPath: `processes/${id}.log`,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Три пути лога прогона. */
function logPaths(id: string): string[] {
  return [
    `processes/${id}.log`,
    `processes/${id}.stdout.log`,
    `processes/${id}.stderr.log`,
  ];
}

describe('ProcessLogPruner — очистка логов фоновых процессов', () => {
  let blobs: MemoryBlobStore;
  let repository: MemoryBackgroundRunRepository;

  beforeEach(() => {
    blobs = new MemoryBlobStore();
    repository = new MemoryBackgroundRunRepository();
  });

  it('файлы потоков живого прогона не считаются сиротами', async () => {
    await repository.save(processRecord('bgr_live'));
    for (const path of logPaths('bgr_live')) await blobs.write(path, 'x');
    // Сирота: на неё не ссылается ни одна запись — её удаление означает,
    // что проход pruner'а (включая «сиротскую» очистку) завершился.
    await blobs.write('processes/bgr_orphan.log', 'x');

    // Срок хранения — 7 дней: живая запись не истёкшая.
    const stop = startProcessLogPruner(repository, blobs, { getRetentionDays: () => 7 });
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/bgr_orphan.log')).toBe(false);
    });
    stop();

    for (const path of logPaths('bgr_live')) {
      expect(await blobs.exists(path), path).toBe(true);
    }
  });

  it('по истечении срока удаляются все три файла', async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    await repository.save(
      processRecord('bgr_old', { status: 'completed', finishedAt: old }),
    );
    for (const path of logPaths('bgr_old')) await blobs.write(path, 'x');

    // Срок — 1 день: запись истёкшая.
    const stop = startProcessLogPruner(repository, blobs, { getRetentionDays: () => 1 });
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/bgr_old.stdout.log')).toBe(false);
    });
    stop();

    for (const path of logPaths('bgr_old')) {
      expect(await blobs.exists(path), path).toBe(false);
    }
  });

  it('файл без записи реестра удаляется как сирота', async () => {
    await blobs.write('processes/bgr_orphan.log', 'x');
    await blobs.write('processes/bgr_orphan.stdout.log', 'x');

    const stop = startProcessLogPruner(repository, blobs, { getRetentionDays: () => 7 });
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/bgr_orphan.log')).toBe(false);
    });
    stop();

    expect(await blobs.exists('processes/bgr_orphan.log')).toBe(false);
    expect(await blobs.exists('processes/bgr_orphan.stdout.log')).toBe(false);
  });
});

/**
 * ADR-113 §detach: живые логи foreground-команд (`processes/live/…`) — отдельный
 * класс. У идущей команды записи реестра ещё нет, поэтому безусловное
 * «сиротское» правило снесло бы её лог: удаляем только по сроку
 * (`LIVE_LOG_ORPHAN_TTL_MS`), и только если файл никому не принадлежит.
 */
describe('ProcessLogPruner — живые логи foreground-команд', () => {
  let blobs: MemoryBlobStore;
  let repository: MemoryBackgroundRunRepository;

  beforeEach(() => {
    blobs = new MemoryBlobStore();
    repository = new MemoryBackgroundRunRepository();
  });

  it('молодой live-лог не удаляется (команда может ещё идти)', async () => {
    await blobs.write('processes/live/proc_young.log', 'out');
    // Маркер завершения прохода: сиротский лог прогона удаляется всегда.
    await blobs.write('processes/bgr_orphan.log', 'x');

    const stop = startProcessLogPruner(repository, blobs, { getRetentionDays: () => 7 });
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/bgr_orphan.log')).toBe(false);
    });
    stop();

    expect(await blobs.exists('processes/live/proc_young.log')).toBe(true);
  });

  it('старый «сиротский» live-лог удаляется (процесс упал, не удалив лог)', async () => {
    await blobs.write('processes/live/proc_old.log', 'out');

    // Срок жизни live-лога — 0: файл считается старым.
    const stop = startProcessLogPruner(repository, blobs, {
      getRetentionDays: () => 7,
      liveLogTtlMs: 0,
    });
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/live/proc_old.log')).toBe(false);
    });
    stop();
  });

  it('live-лог переведённого в фон прогона не удаляется (есть в logPath)', async () => {
    await repository.save(
      processRecord('bgr_detached', { logPath: 'processes/live/proc_live.log' }),
    );
    await blobs.write('processes/live/proc_live.log', 'out');

    const stop = startProcessLogPruner(repository, blobs, {
      getRetentionDays: () => 7,
      // Даже «старый» по сроку: ссылка живой записи защищает безусловно.
      liveLogTtlMs: 0,
    });
    // Маркер завершения прохода.
    await blobs.write('processes/bgr_orphan.log', 'x');
    await vi.waitFor(async () => {
      expect(await blobs.exists('processes/bgr_orphan.log')).toBe(false);
    });
    stop();

    expect(await blobs.exists('processes/live/proc_live.log')).toBe(true);
  });
});
