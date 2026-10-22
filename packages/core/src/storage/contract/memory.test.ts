import { describe, expect, it } from 'vitest';

import {
  describeAnalyticsRollupRepository,
  describeBlobStore,
  describeContextFileRepository,
  describeDefaultsRepository,
  describeDedupRepository,
  describeDictionaryRepository,
  describeDocumentRepository,
  describeEventApiKeyRepository,
  describeEventBindingRepository,
  describeEventJournalRepository,
  describeEventRouteRepository,
  describeIdentityClaimRepository,
  describeJobRepository,
  describeMaintenanceAuditRepository,
  describePluginAuditRepository,
  describePluginLockRepository,
  describeSecurityAuditRepository,
  describeEgressRequestLogRepository,
  describeMcpRegistryRepository,
  describePackRepository,
  describePipelineRepository,
  describePipelineRunRepository,
  describeProfileRepository,
  describeProjectPipelineRepository,
  describeProjectRepository,
  describeProtectedPathsRepository,
  describeScheduleRepository,
  describeSecretPatternRepository,
  describeServiceKeyRepository,
  describeSessionRepository,
  describeSettingsRepository,
  describeSkillBundleRepository,
  describeSkillRepository,
  describeSSHKeyRepository,
  describeWebhookDeliveryRepository,
  describeWebhookRepository,
} from './index.js';
import {
  MemoryAnalyticsRollupRepository,
  MemoryBlobStore,
  MemoryContextFileRepository,
  MemoryDefaultsRepository,
  MemoryDedupRepository,
  MemoryDictionaryRepository,
  MemoryDocumentRepository,
  MemoryEventApiKeyRepository,
  MemoryEventBindingRepository,
  MemoryEventJournalRepository,
  MemoryEventRouteRepository,
  MemoryIdentityClaimRepository,
  MemoryJobRepository,
  MemoryMaintenanceAuditRepository,
  MemoryPluginAuditRepository,
  MemoryPluginLockRepository,
  MemorySecurityAuditRepository,
  MemoryEgressRequestLogRepository,
  MemoryMcpRegistryRepository,
  MemoryPackRepository,
  MemoryPipelineRepository,
  MemoryPipelineRunRepository,
  MemoryProfileRepository,
  MemoryProjectPipelineRepository,
  MemoryProjectRepository,
  MemoryProtectedPathsRepository,
  MemoryScheduleRepository,
  MemorySecretPatternRepository,
  MemoryServiceKeyRepository,
  MemorySessionRepository,
  MemorySettingsRepository,
  MemorySkillBundleRepository,
  MemorySkillRepository,
  MemorySSHKeyRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookRepository,
} from '../memory/index.js';

/**
 * Контрактный прогон in-memory реализаций портов (ADR-096, W2.2) — те же
 * `describeXxxRepository`, что и `contract/file.test.ts`. Общие проверки обязаны
 * проходить на обеих реализациях; файловые детали (tmp-каталоги, права,
 * атомарность) в общие функции не входят.
 */
describe('контрактные тесты in-memory реализаций портов', () => {
  describeSessionRepository('MemorySessionRepository → SessionRepository', async () => ({
    repo: new MemorySessionRepository(),
  }));

  describeProjectRepository('MemoryProjectRepository → ProjectRepository', async () => ({
    repo: new MemoryProjectRepository(),
  }));

  describeProfileRepository('MemoryProfileRepository → ProfileRepository', async () => ({
    repo: new MemoryProfileRepository(),
  }));

  describeSettingsRepository('MemorySettingsRepository → SettingsRepository', async () => ({
    repo: new MemorySettingsRepository(),
  }));

  describeEventBindingRepository('MemoryEventBindingRepository → EventBindingRepository', async () => ({
    repo: new MemoryEventBindingRepository(),
  }));

  describeEventRouteRepository('MemoryEventRouteRepository → EventRouteRepository', async () => ({
    repo: new MemoryEventRouteRepository(),
  }));

  describeEventJournalRepository('MemoryEventJournalRepository → EventJournalRepository', async () => ({
    repo: new MemoryEventJournalRepository(),
  }));

  describeEventApiKeyRepository('MemoryEventApiKeyRepository → EventApiKeyRepository', async () => ({
    repo: new MemoryEventApiKeyRepository(),
  }));

  describeIdentityClaimRepository('MemoryIdentityClaimRepository → IdentityClaimRepository', async () => ({
    repo: new MemoryIdentityClaimRepository(),
  }));

  describeDedupRepository('MemoryDedupRepository → DedupRepository', async () => ({
    repo: new MemoryDedupRepository(),
  }));

  describeScheduleRepository('MemoryScheduleRepository → ScheduleRepository', async () => ({
    repo: new MemoryScheduleRepository(),
  }));

  describeJobRepository('MemoryJobRepository → JobRepository', async () => ({
    repo: new MemoryJobRepository(),
  }));

  describeMaintenanceAuditRepository(
    'MemoryMaintenanceAuditRepository → MaintenanceAuditRepository',
    async () => ({ repo: new MemoryMaintenanceAuditRepository() }),
  );

  describePluginAuditRepository(
    'MemoryPluginAuditRepository → PluginAuditRepository',
    async () => ({ repo: new MemoryPluginAuditRepository() }),
  );

  describePluginLockRepository(
    'MemoryPluginLockRepository → PluginLockRepository',
    async () => ({ repo: new MemoryPluginLockRepository() }),
  );

  describeSecurityAuditRepository(
    'MemorySecurityAuditRepository → SecurityAuditRepository',
    async () => ({ repo: new MemorySecurityAuditRepository() }),
  );

  describeEgressRequestLogRepository(
    'MemoryEgressRequestLogRepository → EgressRequestLogRepository',
    async () => ({ repo: new MemoryEgressRequestLogRepository() }),
  );

  describeAnalyticsRollupRepository(
    'MemoryAnalyticsRollupRepository → AnalyticsRollupRepository',
    async () => ({ repo: new MemoryAnalyticsRollupRepository() }),
  );

  describeServiceKeyRepository('MemoryServiceKeyRepository → ServiceKeyRepository', async () => ({
    repo: new MemoryServiceKeyRepository(),
  }));

  describeSSHKeyRepository('MemorySSHKeyRepository → SSHKeyRepository', async () => ({
    repo: new MemorySSHKeyRepository(),
  }));

  describeWebhookRepository('MemoryWebhookRepository → WebhookRepository', async () => ({
    repo: new MemoryWebhookRepository(),
  }));

  describeWebhookDeliveryRepository('MemoryWebhookDeliveryRepository → WebhookDeliveryRepository', async () => ({
    repo: new MemoryWebhookDeliveryRepository(),
  }));

  describeMcpRegistryRepository('MemoryMcpRegistryRepository → McpRegistryRepository', async () => ({
    repo: new MemoryMcpRegistryRepository(),
  }));

  describeSkillRepository('MemorySkillRepository → SkillRepository', async () => ({
    repo: new MemorySkillRepository(),
  }));

  describeSkillBundleRepository('MemorySkillBundleRepository → SkillBundleRepository', async () => ({
    repo: new MemorySkillBundleRepository(),
  }));

  describeDictionaryRepository('MemoryDictionaryRepository → DictionaryRepository', async () => ({
    repo: new MemoryDictionaryRepository(),
  }));

  // ADR-096 (W2.4): конфигурационные словари (провайдеры/модели/агенты).
  describeDocumentRepository<{ name: string; enabled: boolean }>(
    'MemoryDocumentRepository → DocumentRepository',
    async () => ({ repo: new MemoryDocumentRepository<{ name: string; enabled: boolean }>() }),
    (key) => ({ name: key, enabled: true }),
  );

  describeContextFileRepository('MemoryContextFileRepository → ContextFileRepository', async () => ({
    repo: new MemoryContextFileRepository(),
  }));

  describeSecretPatternRepository('MemorySecretPatternRepository → SecretPatternRepository', async () => ({
    repo: new MemorySecretPatternRepository(),
  }));

  describeProtectedPathsRepository('MemoryProtectedPathsRepository → ProtectedPathsRepository', async () => ({
    repo: new MemoryProtectedPathsRepository(),
  }));

  describeBlobStore('MemoryBlobStore → BlobStore', async () => ({
    repo: new MemoryBlobStore(),
  }));

  describeDefaultsRepository('MemoryDefaultsRepository → DefaultsRepository', async () => ({
    repo: new MemoryDefaultsRepository(),
  }));

  // ADR-051/ADR-100: пайплайны (определения + экземпляры).
  describePipelineRepository('MemoryPipelineRepository → PipelineRepository', async () => ({
    repo: new MemoryPipelineRepository(),
  }));

  // ADR-086 §5: реестр установок пакетов расширений.
  describePackRepository('MemoryPackRepository → PackRepository', async () => ({
    repo: new MemoryPackRepository(),
  }));

  // ADR-101: спецификации пайплайнов (черновик + опубликованные версии).
  describeProjectPipelineRepository(
    'MemoryProjectPipelineRepository → ProjectPipelineRepository',
    async () => ({
      repo: new MemoryProjectPipelineRepository(),
    }),
  );

  // ADR-101: прогоны пайплайнов и журнал выполнения (append-only).
  describePipelineRunRepository('MemoryPipelineRunRepository → PipelineRunRepository', async () => ({
    repo: new MemoryPipelineRunRepository(),
    pipelines: new MemoryProjectPipelineRepository(),
  }));
});

/** Специфика memory-реализаций: изоляция экземпляров и замороженные дефолты. */
describe('memory-реализации: изоляция экземпляров', () => {
  it('два репозитория сессий не делят данные', async () => {
    const a = new MemorySessionRepository();
    const b = new MemorySessionRepository();
    await a.save({ id: 's1' } as never);
    expect(await b.load('s1')).toBeNull();
    expect(await b.list()).toEqual([]);
    expect(await a.exists('s1')).toBe(true);
  });

  it('два репозитория настроек не делят данные', async () => {
    const a = new MemorySettingsRepository();
    const b = new MemorySettingsRepository();
    await a.setWorkspace('/ws-a');
    expect(await b.getWorkspace()).toBeUndefined();
  });

  it('два репозитория webhooks не делят данные', async () => {
    const a = new MemoryWebhookRepository();
    const b = new MemoryWebhookRepository();
    await a.create({ label: 'hook', url: 'https://example.com/hook' }, 'admin');
    expect(await b.list()).toEqual([]);
  });

  it('данные клонируются: мутация возвращённого объекта не влияет на стор', async () => {
    const repo = new MemorySessionRepository();
    await repo.save({ id: 's1', title: 'original' } as never);
    const loaded = await repo.load('s1');
    (loaded as { title?: string }).title = 'mutated';
    expect((await repo.load('s1'))?.title).toBe('original');
  });

  it('два репозитория пайплайнов не делят данные', async () => {
    const a = new MemoryPipelineRepository();
    const b = new MemoryPipelineRepository();
    await a.saveDefinition({
      id: 'p1',
      name: 'p1',
      steps: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await b.listDefinitions()).toEqual([]);
    expect(await b.getDefinition('p1')).toBeNull();
  });

  it('два реестра пакетов не делят данные', async () => {
    const a = new MemoryPackRepository();
    const b = new MemoryPackRepository();
    await a.save({
      name: 'pack',
      version: '1.0.0',
      kind: 'pack',
      status: 'active',
      requiresApproval: false,
      provides: { agents: [], skills: [], mcp: [], pipelines: [] },
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await b.list()).toEqual([]);
    expect(await b.get('pack')).toBeNull();
  });
});
