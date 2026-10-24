import { afterAll, describe } from 'vitest';
import { join } from 'node:path';

import {
  createTmpDir,
  describeAnalyticsRollupRepository,
  describeAuthorityDecisionJournal,
  describeAuthorityPolicyRepository,
  describeBlobStore,
  describeContextFileRepository,
  describeCredentialAuditRepository,
  describeDedupRepository,
  describeDictionaryRepository,
  describeDocumentRepository,
  describeEventApiKeyRepository,
  describeEventBindingRepository,
  describeEventJournalRepository,
  describeEventRouteRepository,
  describeExternalCredentialRepository,
  describeIdentityClaimRepository,
  describeJobRepository,
  describeMaintenanceAuditRepository,
  describeMemoryFactRepository,
  describeMemoryIndexRepository,
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

import { FileStore } from '../file-store.js';
import { ProjectStore } from '../project-store.js';
import { FileProfileStore } from '../profile-store.js';
import { RuntimeSettingsStore } from '../runtime-settings.js';
import { EventBindingStore } from '../event-binding-store.js';
import { RouteRuleStore } from '../route-rule-store.js';
import { EventJournalStore } from '../event-journal-store.js';
import { EventApiKeyStore } from '../event-api-key-store.js';
import { IdentityClaimStore } from '../identity-claim-store.js';
import { FileDedupStore } from '../../engine/events/dedup-store.js';
import { ScheduleStore } from '../schedule-store.js';
import { JobStore } from '../job-store.js';
import { MaintenanceAuditStore } from '../maintenance-audit-store.js';
import { FilePluginAuditStore } from '../file-plugin-audit-store.js';
import { FilePluginLockStore } from '../file-plugin-lock-store.js';
import { SecurityAuditStore } from '../security-audit-store.js';
import { EgressRequestLogStore } from '../egress-request-log-store.js';
import { AnalyticsRollupStore } from '../analytics-rollup-store.js';
import { ServiceApiKeyStore } from '../service-api-key-store.js';
import { SSHKeyStore } from '../ssh-key-store.js';
import { WebhookStore } from '../webhook-store.js';
import { WebhookDeliveryStore } from '../webhook-delivery-store.js';
import { ExternalCredentialStore } from '../external-credential-store.js';
import { FileCredentialAuditStore } from '../file-credential-audit-store.js';
import { McpRegistryStore } from '../mcp-registry-store.js';
import { SkillStore } from '../skill-store.js';
import { SkillBundleStore } from '../skill-bundle-store.js';
import { DictionaryStore } from '../../engine/router/dictionary-store.js';
import { JsonStore } from '../json-store.js';
import { ContextConfig } from '../../engine/context/config.js';
import { SecretPatternStore } from '../../engine/gateway/secret-pattern-store.js';
import { ProtectedPathsStore } from '../../engine/security/protected-paths-store.js';
import { FileBlobStore } from '../file-blob-store.js';
import { FilePipelineStore } from '../file-pipeline-store.js';
import { FilePackStore } from '../file-pack-store.js';
import { FileProjectPipelineStore } from '../file-project-pipeline-store.js';
import { FilePipelineRunStore } from '../file-pipeline-run-store.js';
import { FileMemoryFactStore } from '../file-memory-fact-store.js';
import { FileMemoryIndexStore } from '../file-memory-index-store.js';
import { FileAuthorityPolicyStore } from '../file-authority-policy-store.js';
import { FileAuthorityDecisionJournal } from '../file-authority-decision-journal.js';

/** Мастер-ключ для шифрующих хранилищ (base64, 32 байта) — файл master.key не создаётся. */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

// Все tmp-каталоги прогона удаляются одним хуком после сьюта.
const disposers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(disposers.map((d) => d()));
});

async function tmp(): Promise<string> {
  const { dir, dispose } = await createTmpDir();
  disposers.push(dispose);
  return dir;
}

describe('контрактные тесты файловых реализаций портов', () => {
  describeSessionRepository('FileStore → SessionRepository', async () => ({
    repo: new FileStore({ dataDir: await tmp() }),
  }));

  describeProjectRepository('ProjectStore → ProjectRepository', async () => ({
    repo: new ProjectStore({ dataDir: await tmp() }),
  }));

  describeProfileRepository('FileProfileStore → ProfileRepository', async () => ({
    repo: new FileProfileStore({ dataDir: await tmp() }),
  }));

  describeSettingsRepository('RuntimeSettingsStore → SettingsRepository', async () => ({
    repo: new RuntimeSettingsStore({ dataDir: await tmp() }),
  }));

  describeEventBindingRepository('EventBindingStore → EventBindingRepository', async () => ({
    repo: new EventBindingStore({ dataDir: await tmp() }),
  }));

  describeEventRouteRepository('RouteRuleStore → EventRouteRepository', async () => ({
    repo: new RouteRuleStore({ dataDir: await tmp() }),
  }));

  describeEventJournalRepository('EventJournalStore → EventJournalRepository', async () => ({
    repo: new EventJournalStore({ dataDir: await tmp() }),
  }));

  describeEventApiKeyRepository('EventApiKeyStore → EventApiKeyRepository', async () => ({
    repo: new EventApiKeyStore({ dataDir: await tmp() }),
  }));

  describeIdentityClaimRepository('IdentityClaimStore → IdentityClaimRepository', async () => ({
    repo: new IdentityClaimStore({ dataDir: await tmp() }),
  }));

  describeDedupRepository('FileDedupStore → DedupRepository', async () => ({
    repo: new FileDedupStore({ dataDir: await tmp() }),
  }));

  describeScheduleRepository('ScheduleStore → ScheduleRepository', async () => ({
    repo: new ScheduleStore({ dataDir: await tmp() }),
  }));

  describeJobRepository('JobStore → JobRepository', async () => ({
    repo: new JobStore({ dataDir: await tmp() }),
  }));

  describeMaintenanceAuditRepository(
    'MaintenanceAuditStore → MaintenanceAuditRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new MaintenanceAuditStore({ dataDir: dir }),
        filePath: join(dir, 'audit', 'maintenance.jsonl'),
      };
    },
  );

  describePluginAuditRepository(
    'FilePluginAuditStore → PluginAuditRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new FilePluginAuditStore({ dataDir: dir }),
        filePath: join(dir, 'audit', 'plugins.jsonl'),
      };
    },
  );

  describePluginLockRepository(
    'FilePluginLockStore → PluginLockRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new FilePluginLockStore({ path: join(dir, 'plugin', 'plugins.lock.json') }),
      };
    },
  );

  describeSecurityAuditRepository(
    'SecurityAuditStore → SecurityAuditRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new SecurityAuditStore({ dataDir: dir }),
        filePath: join(dir, 'audit', 'security.jsonl'),
      };
    },
  );

  describeEgressRequestLogRepository(
    'EgressRequestLogStore → EgressRequestLogRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new EgressRequestLogStore({ dataDir: dir }),
        filePath: join(dir, 'audit', 'egress.jsonl'),
      };
    },
  );

  describeAnalyticsRollupRepository(
    'AnalyticsRollupStore → AnalyticsRollupRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new AnalyticsRollupStore({ dataDir: dir }),
        filePath: join(dir, 'analytics', 'rollups.json'),
      };
    },
  );

  describeServiceKeyRepository('ServiceApiKeyStore → ServiceKeyRepository', async () => ({
    repo: new ServiceApiKeyStore({ dataDir: await tmp() }),
  }));

  describeSSHKeyRepository('SSHKeyStore → SSHKeyRepository', async () => ({
    repo: new SSHKeyStore({ dataDir: await tmp(), secretKey: MASTER_KEY }),
  }));

  describeWebhookRepository('WebhookStore → WebhookRepository', async () => ({
    repo: new WebhookStore({ dataDir: await tmp(), secretKey: MASTER_KEY }),
  }));

  describeWebhookDeliveryRepository('WebhookDeliveryStore → WebhookDeliveryRepository', async () => ({
    repo: new WebhookDeliveryStore({ dataDir: await tmp() }),
  }));

  // ADR-105 (Ф1): внешние доступы — `secrets/oauth/credentials.json` (0600).
  describeExternalCredentialRepository(
    'ExternalCredentialStore → ExternalCredentialRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY }),
        filePath: join(dir, 'secrets', 'oauth', 'credentials.json'),
      };
    },
  );

  // ADR-105 (Ф4): журнал операций со слоем доступов — `audit/credentials.jsonl`.
  describeCredentialAuditRepository(
    'FileCredentialAuditStore → CredentialAuditRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new FileCredentialAuditStore({ dataDir: dir }),
        filePath: join(dir, 'audit', 'credentials.jsonl'),
      };
    },
  );

  describeMcpRegistryRepository('McpRegistryStore → McpRegistryRepository', async () => ({
    repo: new McpRegistryStore({ dataDir: await tmp() }),
  }));

  describeSkillRepository('SkillStore → SkillRepository', async () => ({
    repo: new SkillStore({ dataDir: await tmp() }),
  }));

  describeSkillBundleRepository('SkillBundleStore → SkillBundleRepository', async () => ({
    repo: new SkillBundleStore({ dataDir: await tmp() }),
  }));

  describeDictionaryRepository('DictionaryStore → DictionaryRepository', async () => ({
    repo: new DictionaryStore(await tmp()),
  }));

  // ADR-096 (W2.4): конфигурационные словари (провайдеры/модели/агенты).
  describeDocumentRepository<{ name: string; enabled: boolean }>(
    'JsonStore → DocumentRepository',
    async () => ({
      repo: new JsonStore<{ name: string; enabled: boolean }>({
        dataDir: await tmp(),
        subdir: 'providers',
      }),
    }),
    (key) => ({ name: key, enabled: true }),
  );

  describeContextFileRepository('ContextConfig → ContextFileRepository', async () => ({
    repo: new ContextConfig({ userDataDir: await tmp() }),
  }));

  describeSecretPatternRepository('SecretPatternStore → SecretPatternRepository', async () => ({
    repo: new SecretPatternStore({ dataDir: await tmp() }),
  }));

  describeProtectedPathsRepository('ProtectedPathsStore → ProtectedPathsRepository', async () => ({
    repo: new ProtectedPathsStore({ dataDir: await tmp() }),
  }));

  describeBlobStore('FileBlobStore → BlobStore', async () => {
    const dir = await tmp();
    return { repo: new FileBlobStore({ root: join(dir, 'blobs') }) };
  });

  // ADR-051/ADR-100: пайплайны (определения + экземпляры).
  describePipelineRepository('FilePipelineStore → PipelineRepository', async () => ({
    repo: new FilePipelineStore({ dataDir: await tmp() }),
  }));

  // ADR-086 §5: реестр установок пакетов расширений.
  describePackRepository('FilePackStore → PackRepository', async () => ({
    repo: new FilePackStore({ dataDir: await tmp() }),
  }));

  // ADR-101: спецификации пайплайнов (черновик + опубликованные версии).
  describeProjectPipelineRepository(
    'FileProjectPipelineStore → ProjectPipelineRepository',
    async () => ({
      repo: new FileProjectPipelineStore({ dataDir: await tmp() }),
    }),
  );

  // ADR-101: прогоны пайплайнов и журнал выполнения (append-only).
  describePipelineRunRepository('FilePipelineRunStore → PipelineRunRepository', async () => {
    const dir = await tmp();
    return {
      repo: new FilePipelineRunStore({ dataDir: dir }),
      pipelines: new FileProjectPipelineStore({ dataDir: dir }),
    };
  });

  // PROP-047 §2.1 (предпосылка A): порты памяти — факты (`memory/facts.json`)
  // и индексы с чанками (`memory/indexes.json` + `memory/chunks/<id>/g<N>.json`).
  describeMemoryFactRepository('FileMemoryFactStore → MemoryFactRepository', async () => ({
    repo: new FileMemoryFactStore({ dataDir: await tmp() }),
  }));

  describeMemoryIndexRepository('FileMemoryIndexStore → MemoryIndexRepository', async () => ({
    repo: new FileMemoryIndexStore({ dataDir: await tmp() }),
  }));

  // ADR-106: порты Authority-слоя (политика инстанса + журнал решений).
  describeAuthorityPolicyRepository(
    'FileAuthorityPolicyStore → AuthorityPolicyRepository',
    async () => {
      const dir = await tmp();
      return {
        repo: new FileAuthorityPolicyStore({ dataDir: dir }),
        filePath: join(dir, 'authority', 'policy.json'),
      };
    },
  );

  describeAuthorityDecisionJournal(
    'FileAuthorityDecisionJournal → AuthorityDecisionJournal',
    async () => {
      const dir = await tmp();
      return {
        repo: new FileAuthorityDecisionJournal({ dataDir: dir }),
        filePath: join(dir, 'audit', 'authority.jsonl'),
      };
    },
  );
});

// `DefaultsRepository` реализуется в backend (`DefaultsStore`) — его контрактный
// прогон принадлежит backend-пакету (core не импортирует backend).
