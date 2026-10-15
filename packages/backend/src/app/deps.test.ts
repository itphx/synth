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
import { DEFAULT_AGENT_ID } from '@itphx/synth-core';
import type { EventsRuntimeSettings } from '@itphx/synth-core';
import type { DecisionConfig, McpNetworkPolicy } from '@itphx/synth-shared';
import { loadBackendConfig } from '../lib/app-config.js';
import { createBackendDeps } from './deps.js';

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

  it('live.setNetworkPolicy/getNetworkPolicy: политика применяется (live-проводка)', () => {
    const before = deps.live.getNetworkPolicy();
    const policy: McpNetworkPolicy = { mode: 'deny', list: ['example.invalid'] };
    deps.live.setNetworkPolicy(policy);
    expect(deps.live.getNetworkPolicy()).toEqual(policy);

    if (before) deps.live.setNetworkPolicy(before);
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
