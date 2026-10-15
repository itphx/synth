/**
 * Barrel in-memory реализаций портов хранения (PROP-032, шаг W2.2).
 *
 * Второй backend за единым слоем хранения (после файлового): чистая реализация
 * без модулей ФС (`fs`/`path`), состояние — в памяти процесса. Используется в
 * тестах (контрактный suite) и будущим режимом `storage.backend: 'memory'`.
 */

export { MemorySessionRepository, MemoryProjectRepository, MemoryProfileRepository } from './sessions.js';

export {
  MemorySettingsRepository,
  MemoryDefaultsRepository,
  MemorySecretPatternRepository,
  MemoryProtectedPathsRepository,
  MemoryDictionaryRepository,
} from './settings.js';

export {
  MemoryEventBindingRepository,
  MemoryEventRouteRepository,
  MemoryEventJournalRepository,
  MemoryEventApiKeyRepository,
  MemoryIdentityClaimRepository,
  MemoryDedupRepository,
  MemoryMcpRegistryRepository,
  MemoryServiceKeyRepository,
} from './events.js';

export { MemoryWebhookRepository, MemoryWebhookDeliveryRepository } from './webhooks.js';

export { MemoryScheduleRepository, MemoryJobRepository } from './scheduler.js';

export {
  MemorySkillRepository,
  MemorySkillBundleRepository,
  MemoryContextFileRepository,
  MemoryBlobStore,
  MemorySSHKeyRepository,
} from './content.js';
