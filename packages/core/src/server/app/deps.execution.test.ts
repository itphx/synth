/**
 * ADR-135: runtime-каталог профилей исполнения применяется при сборке deps —
 * **runtime > config** (env/CLI выше — их разрешает `resolveExecutionConfig`,
 * ADR-023), каталог runtime **заменяет** каталог config.yaml целиком.
 *
 * Проверяем на уровне deps: `deps.executionConfig` — секция, с которой
 * работает процесс (порты пулов/роутер), `deps.fallbackExecutionConfig` —
 * config-уровень (база для `/api/v2/settings/execution`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared/config';
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
  const dir = await mkdtemp(join(tmpdir(), 'synth-core-deps-execution-'));
  dirs.push(dir);
  return dir;
}

const ACCESSORS = {
  getActiveRemoteProviderNames: () => new Set<string>(),
  isBlockLocalProviders: () => false,
};

/**
 * Config-уровень секции `execution`: два профиля (`base`, `legacy`).
 *
 * Режим — `inline`: сборка deps в `remote` требует читаемого токена
 * исполнителя (fail-closed, ADR-077), а проверка каталога к режиму не
 * относится — каталог резолвится при любом режиме.
 */
function baseExecutionConfig() {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: 'inline',
        remote: {
          ...defaultConfig.execution.remote,
          url: ['http://executor:8080'],
          defaultProfile: 'base',
          profiles: {
            base: { url: ['http://base:8080'] },
            legacy: { url: ['http://legacy:8080'] },
          },
        },
      },
    },
    {},
  );
}

describe('createStandaloneDeps: runtime-каталог профилей исполнения (ADR-135)', () => {
  it('runtime-каталог заменяет каталог config; config-уровень остаётся базой', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
      executionConfig: baseExecutionConfig(),
    };

    const storage = await createStandaloneStorage(config);
    await storage.settings.setExecution({
      defaultProfile: 'runtime',
      profiles: { runtime: { image: 'img:runtime' } },
    });

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      // Эффективная секция — runtime-каталог (config-профили заменены).
      expect(Object.keys(deps.executionConfig?.remote.profiles ?? {})).toEqual(['runtime']);
      expect(deps.executionConfig?.remote.defaultProfile).toBe('runtime');
      expect(deps.executionConfig?.remote.profiles.runtime?.image).toBe('img:runtime');
      // Config-уровень (без runtime) — база для `/api/v2/settings/execution`.
      expect(Object.keys(deps.fallbackExecutionConfig?.remote.profiles ?? {}).sort())
        .toEqual(['base', 'legacy']);
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });

  it('без runtime-секции эффективная секция = config-уровень', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
      executionConfig: baseExecutionConfig(),
    };

    const storage = await createStandaloneStorage(config);
    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      expect(Object.keys(deps.executionConfig?.remote.profiles ?? {}).sort())
        .toEqual(['base', 'legacy']);
      expect(deps.executionConfig?.remote.defaultProfile).toBe('base');
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });
});
