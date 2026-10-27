/**
 * ADR-116 (F2b): `SkillService` в сборке зависимостей получает **порт** слоя
 * хранения (`storageContext.skills`), а не создаёт собственный файловый
 * `SkillStore`. Иначе при `storage.backend=postgres` instance-скиллы писались бы
 * в `{dataDir}/skills` мимо БД/blob-стора, а discovery читал бы пустой порт.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneDeps, createStandaloneStorage } from './deps.js';
import type { StandaloneConfig } from '../app.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-core-deps-skills-'));
  dirs.push(dir);
  return dir;
}

const ACCESSORS = {
  getActiveRemoteProviderNames: () => new Set<string>(),
  isBlockLocalProviders: () => false,
};

function stopAll(deps: Awaited<ReturnType<typeof createStandaloneDeps>>): void {
  deps.stopEphemeralSweeper();
  deps.stopEventJournalPruner();
  deps.stopWebhookDeliveryPruner();
}

describe('createStandaloneDeps: instance-скиллы через порт хранения (ADR-116)', () => {
  it('скилл, записанный в порт, виден сервису скиллов (и наоборот)', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      // Стор скиллов — не файловый каталог (как при postgres).
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    await storage.skills.create({
      name: 'ported-skill',
      description: 'из порта',
      body: 'тело из порта',
      files: { 'notes/a.md': 'A' },
    });

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      const detail = await deps.skillService.detail('ported-skill');
      expect(detail?.description).toBe('из порта');
      expect(detail?.files).toEqual(['notes/a.md']);
      expect(await deps.skillService.readSupportingFile('ported-skill', 'notes/a.md')).toBe('A');
      expect(await deps.skillService.isInstanceSkill('ported-skill')).toBe(true);

      // Обратное направление: запись через сервис попадает **в порт**.
      await deps.skillService.createInstance({ name: 'from-service', description: 'd' });
      expect(await storage.skills.exists('from-service')).toBe(true);
    } finally {
      stopAll(deps);
    }
  });
});
