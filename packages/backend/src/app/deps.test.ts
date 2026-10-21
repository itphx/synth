/**
 * `createBackendDeps` (`src/app/deps.ts`) — сборка зависимостей backend.
 * Проверяем контракт композиции (набор и форма полей, на которые опирается
 * фасад `app.ts` и `mount-routes.ts`) и семантику live-аксессоров
 * (`deps.live`): runtime-настройки применяются к замыканиям без рестарта.
 *
 * Прямая проверка here — дешёвая ловушка на переименование/потерю поля, которое
 * фасад читает по имени (TypeScript ловит часть, но не «значение по геттеру»).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_ID, MetricsRegistry } from '@itphx/synth-core';
import type { EventsRuntimeSettings } from '@itphx/synth-core';
import type { AgentDefinition, DecisionConfig } from '@itphx/synth-shared';
import { loadBackendConfig } from '../lib/app-config.js';
import { createBackendDeps, createBackendStorage } from './deps.js';

type Deps = Awaited<ReturnType<typeof createBackendDeps>>;

describe('createBackendDeps: композиция и live-аксессоры', () => {
  let dataDir: string;
  let deps: Deps;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-deps-'));
    savedEnv.set('SYNTH_DATA_DIR', process.env.SYNTH_DATA_DIR);
    process.env.SYNTH_DATA_DIR = dataDir;
    const config = await loadBackendConfig();
    expect(config.dataDir).toBe(dataDir);
    deps = await createBackendDeps(config);
  });

  afterAll(async () => {
    deps.schedulerService.stop();
    deps.webhookService.stop();
    deps.stopEphemeralSweeper();
    deps.stopEventJournalPruner();
    deps.stopWebhookDeliveryPruner();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('возвращает все поля, которые читают фасад и mount-routes', () => {
    expect(deps.dataDir).toBe(dataDir);
    // Хранилища и менеджеры
    for (const key of [
      'projectStore', 'sessionManager', 'eventBus', 'queueManager', 'profilesStore',
      'settingsStore', 'defaultsStore', 'sshKeyStore', 'patternStore', 'protectedPathsStore',
      'providerStore', 'modelStore', 'agentStore', 'providerCache', 'modelCache',
      'skillService', 'commandService', 'bundleStore', 'toolRegistry', 'agentRegistry',
      'mcpManager', 'mcpRegistryStore', 'orchestrator', 'contextOptimizer',
      'gatewayAuditLogger', 'gatewayConfig', 'protectedPathsStore',
      // Событийное ядро (ADR-089)
      'eventRouter', 'requestSessionService', 'eventIngress', 'eventHub',
      'eventBindingStore', 'eventApiKeyStore', 'eventJournal', 'routeRuleStore',
      'identityClaimStore',
      // Шедулер (ADR-051) / webhooks (ADR-052)
      'scheduleStore', 'jobStore', 'schedulerService', 'webhookStore', 'webhookDeliveryStore',
      'webhookService', 'webhooksConfig',
      // Функции/аксессоры
      'resolveAgentTemplate', 'getDefaultAgentId', 'providerLoader', 'modelLoader',
      'modelWindowLoader', 'gatewayPayloadLogPath', 'defaultWorkingDir',
    ] as const) {
      expect(deps[key], `deps.${key}`).toBeDefined();
    }
    // Функции жизненного цикла
    expect(typeof deps.stopEphemeralSweeper).toBe('function');
    expect(typeof deps.stopEventJournalPruner).toBe('function');
    expect(typeof deps.stopWebhookDeliveryPruner).toBe('function');
    // ADR-094: без реестра метрик доменные коллекторы не подключаются (пустой список).
    expect(deps.metrics).toBeUndefined();
    expect(deps.stopMetricsCollectors).toEqual([]);
    expect(typeof deps.schedulerService.stop).toBe('function');
    expect(typeof deps.webhookService.stop).toBe('function');
    // Ключевые методы, на которые опираются роуты.
    expect(typeof deps.eventBus.publish).toBe('function');
    expect(typeof deps.sessionManager.getSession).toBe('function');
    expect(typeof deps.requestSessionService.request).toBe('function');
    expect(typeof deps.eventIngress.ingest).toBe('function');
    expect(typeof deps.orchestrator.createProcessMessage).toBe('function');
  });

  it('resolveAgentTemplate: неизвестный шаблон → null; getDefaultAgentId → DEFAULT_AGENT_ID', async () => {
    expect(deps.resolveAgentTemplate('__unknown-agent-template__')).toBeNull();
    expect(await deps.getDefaultAgentId()).toBe(DEFAULT_AGENT_ID);
  });

  it('live.setEvents/getEvents: значение заменяется целиком (live-проводка)', () => {
    const before = deps.live.getEvents();
    expect(typeof before.enabled).toBe('boolean');

    const next: EventsRuntimeSettings = { ...before, enabled: !before.enabled };
    deps.live.setEvents(next);
    expect(deps.live.getEvents()).toBe(next);
    expect(deps.live.getEvents().enabled).toBe(!before.enabled);

    // Возврат к исходному (изоляция от других тестов в файле).
    deps.live.setEvents(before);
    expect(deps.live.getEvents().enabled).toBe(before.enabled);
  });

  it('egressResolver.resolveMcp читает стор на каждый вызов (live-проводка)', async () => {
    const before = await deps.egressResolver.resolveMcp();
    await deps.settingsStore.setMcpNetworkPolicy({
      mode: 'deny',
      list: ['example.invalid'],
      exceptions: [],
    });
    expect((await deps.egressResolver.resolveMcp()).list).toEqual(['example.invalid']);

    await deps.settingsStore.clearMcpNetworkPolicy();
    expect(await deps.egressResolver.resolveMcp()).toEqual(before);
  });

  it('ADR-094: переданный реестр метрик доходит до оркестратора', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-backend-deps-metrics-'));
    const saved = process.env.SYNTH_DATA_DIR;
    process.env.SYNTH_DATA_DIR = dir;
    try {
      const config = await loadBackendConfig();
      const registry = new MetricsRegistry();
      const withMetrics = await createBackendDeps(config, undefined, registry);
      try {
        // Поле приватное — публичного аксессора нет; проверяем саму проводку
        // композиции (до фикса `metrics` в конструктор не передавался).
        const internal = withMetrics.orchestrator as unknown as {
          _metrics: MetricsRegistry | null;
        };
        expect(internal._metrics).toBe(registry);
      } finally {
        withMetrics.schedulerService.stop();
        withMetrics.webhookService.stop();
        withMetrics.stopEphemeralSweeper();
        withMetrics.stopEventJournalPruner();
        withMetrics.stopWebhookDeliveryPruner();
      }
    } finally {
      if (saved === undefined) delete process.env.SYNTH_DATA_DIR;
      else process.env.SYNTH_DATA_DIR = saved;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('live.setDecision не бросает и не ломает composition', () => {
    const decision: DecisionConfig = {
      enabled: false,
      provider: '',
      model: '',
      confidenceThreshold: 0.6,
      escalationProvider: '',
      escalationModel: '',
    };
    expect(() => deps.live.setDecision(decision)).not.toThrow();
  });
});

/**
 * ADR-096/PROP-032 + ADR-086 §5: при `storage.backend=postgres` стор агентов —
 * БД, а `createAgentRegistry` читает только файловый каталог `{dataDir}/agents`.
 * Агент, поставленный пакетом расширения, после рестарта процесса не попадал
 * в реестр → Router не резолвил `agentTemplate` → сессия не создавалась.
 */
describe('createBackendDeps: агенты из стора попадают в реестр', () => {
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

  it('агент, записанный только в стор, регистрируется в agentRegistry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-backend-deps-agents-'));
    const savedDataDir = process.env.SYNTH_DATA_DIR;
    const savedBackend = process.env.SYNTH_STORAGE_BACKEND;
    process.env.SYNTH_DATA_DIR = dir;
    // Стор агентов — не файловый каталог (как при postgres).
    process.env.SYNTH_STORAGE_BACKEND = 'memory';
    try {
      const config = await loadBackendConfig();
      const storage = await createBackendStorage(config);
      await storage.agents.save('publisher', agent('publisher', {
        displayName: 'Publisher',
        contextFile: 'PUBLISHER.md',
        agentMode: ['primary'],
      }));

      const deps = await createBackendDeps(config, storage);
      try {
        const stored = deps.agentRegistry.get('publisher');
        expect(stored).toBeDefined();
        expect(stored!.displayName).toBe('Publisher');
        expect(stored!.isOverridden).toBe(true);
        // Резолвер `agentTemplate` (ADR-089) отдаёт агента — Router создаст сессию.
        expect(deps.resolveAgentTemplate('publisher')).toBe('publisher');
      } finally {
        deps.schedulerService.stop();
        deps.webhookService.stop();
        deps.stopEphemeralSweeper();
        deps.stopEventJournalPruner();
        deps.stopWebhookDeliveryPruner();
      }
    } finally {
      if (savedDataDir === undefined) delete process.env.SYNTH_DATA_DIR;
      else process.env.SYNTH_DATA_DIR = savedDataDir;
      if (savedBackend === undefined) delete process.env.SYNTH_STORAGE_BACKEND;
      else process.env.SYNTH_STORAGE_BACKEND = savedBackend;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('запись из стора с id встроенного агента перекрывает встроенное определение', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-backend-deps-agents-'));
    const savedDataDir = process.env.SYNTH_DATA_DIR;
    const savedBackend = process.env.SYNTH_STORAGE_BACKEND;
    process.env.SYNTH_DATA_DIR = dir;
    process.env.SYNTH_STORAGE_BACKEND = 'memory';
    try {
      const config = await loadBackendConfig();
      const storage = await createBackendStorage(config);
      await storage.agents.save('assistant', agent('assistant', {
        displayName: 'Мой ассистент',
        contextFile: 'MY_ASSISTANT.md',
      }));

      const deps = await createBackendDeps(config, storage);
      try {
        const merged = deps.agentRegistry.get('assistant');
        expect(merged).toBeDefined();
        expect(merged!.displayName).toBe('Мой ассистент');
        expect(merged!.contextFile).toBe('MY_ASSISTANT.md');
        expect(merged!.isOverridden).toBe(true);
        // Поля, которых нет в записи из стора, у встроенного сохраняются.
        expect(merged!.icon).toBeDefined();
      } finally {
        deps.schedulerService.stop();
        deps.webhookService.stop();
        deps.stopEphemeralSweeper();
        deps.stopEventJournalPruner();
        deps.stopWebhookDeliveryPruner();
      }
    } finally {
      if (savedDataDir === undefined) delete process.env.SYNTH_DATA_DIR;
      else process.env.SYNTH_DATA_DIR = savedDataDir;
      if (savedBackend === undefined) delete process.env.SYNTH_STORAGE_BACKEND;
      else process.env.SYNTH_STORAGE_BACKEND = savedBackend;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
