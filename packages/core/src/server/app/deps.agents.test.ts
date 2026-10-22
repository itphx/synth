/**
 * ADR-096 + ADR-086 §5: реестр агентов и стор агентов — разные
 * источники при `storage.backend=postgres` (стор — БД, а `createAgentRegistry`
 * читает только файловый каталог `{dataDir}/agents`). Проверяем, что агент,
 * лежащий **только в сторе**, попадает в `agentRegistry` при сборке deps —
 * иначе Router не резолвит `agentTemplate` и сессия не создаётся.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, SynthEvent } from '@itphx/synth-shared';
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
  const dir = await mkdtemp(join(tmpdir(), 'synth-core-deps-agents-'));
  dirs.push(dir);
  return dir;
}

const ACCESSORS = {
  getActiveRemoteProviderNames: () => new Set<string>(),
  isBlockLocalProviders: () => false,
};

function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    displayName: id,
    capabilities: [],
    enabled: true,
    isOverridden: true,
    ...extra,
  };
}

describe('createStandaloneDeps: агенты из стора попадают в реестр', () => {
  it('агент, записанный только в стор, регистрируется в agentRegistry', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      // Стор агентов — не файловый каталог (как при postgres).
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    await storage.agents.save('publisher', agent('publisher', {
      displayName: 'Publisher',
      contextFile: 'PUBLISHER.md',
      agentMode: ['primary'],
    }));

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      const stored = deps.agentRegistry.get('publisher');
      expect(stored).toBeDefined();
      expect(stored!.displayName).toBe('Publisher');
      expect(stored!.isOverridden).toBe(true);
      // Резолвер `agentTemplate` (ADR-089) отдаёт агента — Router создаст сессию.
      expect(deps.resolveAgentTemplate('publisher')).toBe('publisher');
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });

  it('запись из стора с id встроенного агента перекрывает встроенное определение', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    await storage.agents.save('assistant', agent('assistant', {
      displayName: 'Мой ассистент',
      contextFile: 'MY_ASSISTANT.md',
    }));

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      const merged = deps.agentRegistry.get('assistant');
      expect(merged).toBeDefined();
      expect(merged!.displayName).toBe('Мой ассистент');
      expect(merged!.contextFile).toBe('MY_ASSISTANT.md');
      expect(merged!.isOverridden).toBe(true);
      // Поля, которых нет в записи из стора, у встроенного сохраняются.
      expect(merged!.icon).toBeDefined();
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });

  it('файловое хранилище: агент из файла `{dataDir}/agents` виден как раньше', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'file',
    };

    const deps = await createStandaloneDeps(config, ACCESSORS);
    try {
      // Встроенные агенты на месте.
      expect(deps.agentRegistry.get('assistant')).toBeDefined();
      // Файл в `{dataDir}/agents` — и стор, и реестр (каталог и стор — одно).
      await deps.agentStore.save('publisher', agent('publisher', { displayName: 'Publisher' }));
      expect(deps.agentRegistry.get('publisher')).toBeUndefined();

      const deps2 = await createStandaloneDeps(config, ACCESSORS);
      try {
        expect(deps2.agentRegistry.get('publisher')?.displayName).toBe('Publisher');
      } finally {
        deps2.stopEphemeralSweeper();
        deps2.stopEventJournalPruner();
        deps2.stopWebhookDeliveryPruner();
      }
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });

  it('Router создаёт сессию с агентом из стора (agentTemplate резолвится)', async () => {
    // Симптом бага: агент, поставленный пакетом расширения (ADR-086), лежит в
    // сторе (при postgres — БД), но не в реестре → `agentTemplate` не резолвится
    // → Router не создаёт сессию (`sessionId: null`).
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    await storage.agents.save('publisher', agent('publisher', {
      displayName: 'Publisher',
      contextFile: 'PUBLISHER.md',
      agentMode: ['primary'],
    }));

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      deps.eventRouter.registerRuleProvider({
        name: 'test-publisher',
        resolve: () => ({ kind: 'ephemeral', agentTemplate: 'publisher', ttl: '1h' }),
      });

      const event: SynthEvent = {
        id: 'evt_test_1',
        source: 'test',
        type: 'message',
        payload: { text: 'hi' },
        identity: {},
        dedupKey: 'dedup-test-1',
        ts: new Date().toISOString(),
      };
      const { session } = await deps.requestSessionService.handleEvent(event);

      expect(session).not.toBeNull();
      expect(session!.settings.agentRole).toBe('publisher');
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });
});
