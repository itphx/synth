import { afterAll, describe } from 'vitest';
import { join } from 'node:path';

import {
  createTmpDir,
  describeBlobStore,
  describeContextFileRepository,
  describeDedupRepository,
  describeDictionaryRepository,
  describeEventApiKeyRepository,
  describeEventBindingRepository,
  describeEventJournalRepository,
  describeEventRouteRepository,
  describeIdentityClaimRepository,
  describeJobRepository,
  describeMcpRegistryRepository,
  describeProfileRepository,
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
import { ServiceApiKeyStore } from '../service-api-key-store.js';
import { SSHKeyStore } from '../ssh-key-store.js';
import { WebhookStore } from '../webhook-store.js';
import { WebhookDeliveryStore } from '../webhook-delivery-store.js';
import { McpRegistryStore } from '../mcp-registry-store.js';
import { SkillStore } from '../skill-store.js';
import { SkillBundleStore } from '../skill-bundle-store.js';
import { DictionaryStore } from '../../engine/router/dictionary-store.js';
import { ContextConfig } from '../../engine/context/config.js';
import { SecretPatternStore } from '../../engine/gateway/secret-pattern-store.js';
import { ProtectedPathsStore } from '../../engine/security/protected-paths-store.js';
import { FileBlobStore } from '../file-blob-store.js';

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
});

// `DefaultsRepository` реализуется в backend (`DefaultsStore`) — его контрактный
// прогон принадлежит backend-пакету (core не импортирует backend).
