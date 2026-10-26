/**
 * ADR-114 §7.4: sweep осиротевших записей worktree'ов подключён при старте.
 *
 * Проверяем **точку подключения** (core `server/app/deps.ts`): сборка
 * зависимостей вызывает `WorktreeService.sweepOrphans()`, причём
 *
 * - вызов происходит **без блокировки старта** (обещание не ожидается);
 * - ошибка sweep **не роняет старт** — она уходит в лог.
 *
 * Оба свойства проверяются **одним** прогоном: sweep замокан так, что он
 * (а) вызывается и (б) возвращает rejected promise. Успешная сборка
 * зависимостей при падающем sweep доказывает, что ошибка старт не роняет, а
 * счётчик вызовов — что sweep подключён к точке сборки.
 *
 * Одна сборка `createStandaloneDeps` вместо двух: полная сборка зависимостей
 * тяжёлая, а обе проверки (вызов sweep'а и «ошибка не роняет старт») закрывает
 * один прогон — вторая сборка ничего не добавляла.
 *
 * Поведение самого sweep'а (какие записи удаляются, успешный путь) — в
 * `src/engine/worktree/service.test.ts` и `sweep.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeService } from '../../engine/worktree/service.js';
import { createStandaloneDeps } from './deps.js';
import type { StandaloneConfig } from '../app.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-core-deps-worktree-'));
  dirs.push(dir);
  return dir;
}

const ACCESSORS = {
  getActiveRemoteProviderNames: () => new Set<string>(),
  isBlockLocalProviders: () => false,
};

async function buildDeps(): Promise<void> {
  const dataDir = await makeDir();
  const config: StandaloneConfig = {
    port: 0,
    dataDir,
    apiKey: 'test-key',
    storageBackend: 'memory',
  };
  const deps = await createStandaloneDeps(config, ACCESSORS);
  deps.stopEphemeralSweeper();
  deps.stopEventJournalPruner();
  deps.stopWebhookDeliveryPruner();
}

describe('createStandaloneDeps: стартовый sweep worktree (ADR-114 §7.4)', () => {
  it('вызывает sweep при сборке зависимостей; ошибка sweep не роняет старт', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Sweep и вызывается, и падает — обе проверки закрывает один прогон.
    const sweep = vi
      .spyOn(WorktreeService.prototype, 'sweepOrphans')
      .mockRejectedValue(new Error('порт недоступен'));

    // Сборка зависимостей завершается успешно, несмотря на ошибку sweep.
    await expect(buildDeps()).resolves.toBeUndefined();

    // Sweep подключён к точке сборки — вызов состоялся.
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));

    // Ошибка ушла в лог, а не наружу: старт не упал, процесс продолжает жить.
    await vi.waitFor(() =>
      expect(warn.mock.calls.some(([line]) => String(line).includes('sweep'))).toBe(true),
    );
  });
});
