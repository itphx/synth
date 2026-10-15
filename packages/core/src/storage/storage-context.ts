/**
 * StorageContext — единая точка сборки слоя хранения (PROP-032, шаг W2.3).
 *
 * Делает шов реальным: домен (composition root — `server/app/deps.ts`,
 * `backend/app/deps.ts`) получает порты из одного места, а не собирает
 * конкретные классы по-отдельности. Сейчас доступны два backend'а:
 *   - `file`   — файловые реализации (JSON + атомарная запись, ADR-005);
 *   - `memory` — in-memory реализации (герметичные тесты, без ФС).
 *
 * Каждый вызов фабрики создаёт **новые** экземпляры (никаких модульных
 * синглтонов) — это важно для герметичных тестов.
 */

import { join } from 'node:path';
import type { AgentDefinition, ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import type {
  BlobStore,
  ContextFileRepository,
  DedupRepository,
  DefaultsRepository,
  DictionaryRepository,
  DocumentRepository,
  EventApiKeyRepository,
  EventBindingRepository,
  EventJournalRepository,
  EventRouteRepository,
  IdentityClaimRepository,
  JobRepository,
  McpRegistryRepository,
  ProfileRepository,
  ProjectRepository,
  ProtectedPathsRepository,
  ScheduleRepository,
  SecretPatternRepository,
  ServiceKeyRepository,
  SessionRepository,
  SettingsRepository,
  SkillBundleRepository,
  SkillRepository,
  SSHKeyRepository,
  WebhookDeliveryRepository,
  WebhookRepository,
} from './ports/index.js';

// ── Файловые реализации ────────────────────────────────────────────────
import { FileStore } from './file-store.js';
import { JsonStore } from './json-store.js';
import { ProjectStore } from './project-store.js';
import { FileProfileStore } from './profile-store.js';
import { RuntimeSettingsStore } from './runtime-settings.js';
import { DefaultsStore } from './defaults-store.js';
import { SecretPatternStore } from '../engine/gateway/secret-pattern-store.js';
import { ProtectedPathsStore } from '../engine/security/protected-paths-store.js';
import { DictionaryStore } from '../engine/router/dictionary-store.js';
import { McpRegistryStore } from './mcp-registry-store.js';
import { ServiceApiKeyStore } from './service-api-key-store.js';
import { EventApiKeyStore } from './event-api-key-store.js';
import { EventBindingStore } from './event-binding-store.js';
import { EventJournalStore } from './event-journal-store.js';
import { RouteRuleStore } from './route-rule-store.js';
import { IdentityClaimStore } from './identity-claim-store.js';
import { WebhookStore } from './webhook-store.js';
import { WebhookDeliveryStore } from './webhook-delivery-store.js';
import { ScheduleStore } from './schedule-store.js';
import { JobStore } from './job-store.js';
import { FileDedupStore, MemoryDedupStore } from '../engine/events/dedup-store.js';
import { SkillStore } from './skill-store.js';
import { SkillBundleStore } from './skill-bundle-store.js';
import { ContextConfig } from '../engine/context/config.js';
import { SSHKeyStore } from './ssh-key-store.js';
import { FileBlobStore } from './file-blob-store.js';

// ── In-memory реализации ───────────────────────────────────────────────
import {
  MemoryBlobStore,
  MemoryContextFileRepository,
  MemoryDefaultsRepository,
  MemoryDictionaryRepository,
  MemoryDocumentRepository,
  MemoryEventApiKeyRepository,
  MemoryEventBindingRepository,
  MemoryEventJournalRepository,
  MemoryEventRouteRepository,
  MemoryIdentityClaimRepository,
  MemoryJobRepository,
  MemoryMcpRegistryRepository,
  MemoryProfileRepository,
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
  MemoryDedupRepository,
} from './memory/index.js';

/** Физический backend хранения (`storage.backend` в конфиге). */
export type StorageBackendKind = 'file' | 'memory';

/**
 * Собранный слой хранения: домен получает порты (а не конкретные классы).
 * Поле `kind` — какой backend собран (для диагностики/предупреждений).
 */
export interface StorageContext {
  kind: StorageBackendKind;
  sessions: SessionRepository;
  projects: ProjectRepository;
  profiles: ProfileRepository;
  settings: SettingsRepository;
  defaults: DefaultsRepository;
  secretPatterns: SecretPatternRepository;
  protectedPaths: ProtectedPathsRepository;
  dictionaries: DictionaryRepository;
  /** Конфигурационные словари (PROP-032, W2.4): `providers`/`models`/`agents`. */
  providers: DocumentRepository<ProviderConfig>;
  models: DocumentRepository<ModelConfig>;
  agents: DocumentRepository<AgentDefinition>;
  mcpRegistry: McpRegistryRepository;
  serviceKeys: ServiceKeyRepository;
  eventApiKeys: EventApiKeyRepository;
  eventBindings: EventBindingRepository;
  eventRoutes: EventRouteRepository;
  eventJournal: EventJournalRepository;
  identityClaims: IdentityClaimRepository;
  webhooks: WebhookRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  schedules: ScheduleRepository;
  jobs: JobRepository;
  dedup: DedupRepository;
  skills: SkillRepository;
  skillBundles: SkillBundleRepository;
  contextFiles: ContextFileRepository;
  sshKeys: SSHKeyRepository;
  blobs: BlobStore;
}

/** Параметры сборки слоя хранения (общие для file/memory). */
export interface StorageContextConfig {
  dataDir: string;
  /** ADR-076: мастер-ключ секретов at-rest (env > config > файл в dataDir). */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** `events.dedupStore`: 'memory' (дефолт) | 'file'. */
  dedupStore?: 'memory' | 'file';
  /** `scheduler.crossProcessLocks` — сериализация мутаций ScheduleStore. */
  scheduleCrossProcess?: boolean;
  /** Каталог системных словарей (по умолчанию — `dictionaries/` пакета core). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (по умолчанию `{dataDir}/context`). */
  contextUserDataDir?: string;
  /** `commands.bundlesPath` — каталог instance-bundles (like-for-like с deps). */
  bundlesPath?: string;
  /** Каталог встроенных промптов (`StandaloneConfig.systemPromptsDir`). */
  systemPromptsDir?: string;
}

/**
 * Файловый backend: те же реализации и аргументы, что собирал
 * `packages/core/src/server/app/deps.ts` (побайтово то же поведение).
 */
export function createFileStorage(config: StorageContextConfig): StorageContext {
  const dataDir = config.dataDir;
  const contextUserDataDir = config.contextUserDataDir ?? join(dataDir, 'context');
  return {
    kind: 'file',
    sessions: new FileStore({ dataDir }),
    projects: new ProjectStore({ dataDir }),
    profiles: new FileProfileStore({ dataDir }),
    settings: new RuntimeSettingsStore({ dataDir }),
    defaults: new DefaultsStore({ dataDir }),
    secretPatterns: new SecretPatternStore({ dataDir }),
    protectedPaths: new ProtectedPathsStore({ dataDir }),
    // Словари: системные — из пакета core (или заданного каталога), пользовательские —
    // `{dataDir}/dictionaries` (позиционный ctor `(userDataDir, systemDir?)`).
    dictionaries: new DictionaryStore(dataDir, config.systemDictionariesDir),
    // PROP-032 (W2.4): провайдеры/модели/агенты — «ключ → JSON-документ».
    providers: new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' }),
    models: new JsonStore<ModelConfig>({ dataDir, subdir: 'models' }),
    agents: new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' }),
    mcpRegistry: new McpRegistryStore({ dataDir }),
    serviceKeys: new ServiceApiKeyStore({ dataDir }),
    eventApiKeys: new EventApiKeyStore({ dataDir }),
    eventBindings: new EventBindingStore({ dataDir }),
    eventRoutes: new RouteRuleStore({ dataDir }),
    eventJournal: new EventJournalStore({ dataDir }),
    identityClaims: new IdentityClaimStore({ dataDir }),
    webhooks: new WebhookStore({
      dataDir,
      secretKey: config.secretKey,
      env: config.env,
    }),
    webhookDeliveries: new WebhookDeliveryStore({ dataDir }),
    schedules: new ScheduleStore({
      dataDir,
      crossProcess: config.scheduleCrossProcess,
    }),
    jobs: new JobStore({ dataDir }),
    // ADR-051/ADR-089: источник дедупа — in-process (default) или файловый межпроцессный.
    dedup: config.dedupStore === 'file' ? new FileDedupStore({ dataDir }) : new MemoryDedupStore(),
    skills: new SkillStore({ dataDir }),
    skillBundles: new SkillBundleStore({ dataDir, bundlesPath: config.bundlesPath }),
    contextFiles: new ContextConfig({
      userDataDir: contextUserDataDir,
      systemPromptsDir: config.systemPromptsDir,
    }),
    sshKeys: new SSHKeyStore({
      dataDir,
      secretKey: config.secretKey,
      env: config.env,
    }),
    blobs: new FileBlobStore({ root: dataDir }),
  };
}

/**
 * In-memory backend: чистая сборка без модулей ФС (`fs`/`path`), состояние — в
 * памяти процесса. `dedupStore` неактуален — дедуп всегда in-process.
 */
export function createMemoryStorage(config: Partial<StorageContextConfig> = {}): StorageContext {
  void config;
  return {
    kind: 'memory',
    sessions: new MemorySessionRepository(),
    projects: new MemoryProjectRepository(),
    profiles: new MemoryProfileRepository(),
    settings: new MemorySettingsRepository(),
    defaults: new MemoryDefaultsRepository(),
    secretPatterns: new MemorySecretPatternRepository(),
    protectedPaths: new MemoryProtectedPathsRepository(),
    dictionaries: new MemoryDictionaryRepository(),
    providers: new MemoryDocumentRepository<ProviderConfig>(),
    models: new MemoryDocumentRepository<ModelConfig>(),
    agents: new MemoryDocumentRepository<AgentDefinition>(),
    mcpRegistry: new MemoryMcpRegistryRepository(),
    serviceKeys: new MemoryServiceKeyRepository(),
    eventApiKeys: new MemoryEventApiKeyRepository(),
    eventBindings: new MemoryEventBindingRepository(),
    eventRoutes: new MemoryEventRouteRepository(),
    eventJournal: new MemoryEventJournalRepository(),
    identityClaims: new MemoryIdentityClaimRepository(),
    webhooks: new MemoryWebhookRepository(),
    webhookDeliveries: new MemoryWebhookDeliveryRepository(),
    schedules: new MemoryScheduleRepository(),
    jobs: new MemoryJobRepository(),
    dedup: new MemoryDedupRepository(),
    skills: new MemorySkillRepository(),
    skillBundles: new MemorySkillBundleRepository(),
    contextFiles: new MemoryContextFileRepository(),
    sshKeys: new MemorySSHKeyRepository(),
    blobs: new MemoryBlobStore(),
  };
}

/** Диспетчер backend'а по `storage.backend`. */
export function createStorageContext(
  kind: StorageBackendKind,
  config: StorageContextConfig,
): StorageContext {
  return kind === 'memory' ? createMemoryStorage(config) : createFileStorage(config);
}
