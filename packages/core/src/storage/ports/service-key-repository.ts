import type { ServiceApiKey, ServiceApiKeyCreated } from '@itphx/synth-shared';
import type { CreateServiceApiKeyInput, UpdateServiceApiKeyPatch } from '@itphx/synth-shared';
import type {
  EnsureServiceKeyInput,
  ServiceApiKeyRecord,
  ServiceKeyCredential,
  ServiceKeyEnsureStatus,
} from '../service-api-key-store.js';

/** Результат резолва секрета service-key: публичные метаданные + контекст enforcement. */
export interface ServiceKeyResolution {
  key: ServiceApiKey;
  credential: ServiceKeyCredential;
}

/**
 * Порт реестра service-key инстанса (ADR-052, реализация — `ServiceApiKeyStore`).
 *
 * Секрет хранится не в порту, а в реализации (at-rest sha256); порт возвращает
 * plaintext только в `create`/`ensure` — как и класс. Уникальность `label`
 * (регистронезависимо) — инвариант любой реализации.
 *
 * `exportAll`/`importExisting` — служебная пара для переноса между backend'ами
 * (`synth storage migrate`, PROP-032): она работает с **готовым хешем**, plaintext
 * не участвует. HTTP-слой эти методы не использует.
 */
export interface ServiceKeyRepository {
  list(): Promise<ServiceApiKey[]>;
  get(id: string): Promise<ServiceApiKey | null>;
  create(input: CreateServiceApiKeyInput, createdBy: string): Promise<ServiceApiKeyCreated>;
  ensure(input: EnsureServiceKeyInput): Promise<{ status: ServiceKeyEnsureStatus; key: ServiceApiKey }>;
  update(id: string, patch: UpdateServiceApiKeyPatch): Promise<ServiceApiKey | null>;
  remove(id: string): Promise<boolean>;
  /** Мягкий отзыв (`revokedAt`); идемпотентно. */
  revoke(id: string): Promise<boolean>;
  /** Резолв секрета `synth_svc_…`; revoked/expired/unknown → `null`. */
  resolveBySecret(rawSecret: string): Promise<ServiceKeyResolution | null>;
  touch(id: string): Promise<void>;
  /**
   * Полные записи, включая `hash` (sha256) — только для переноса между
   * backend'ами (`synth storage migrate`); публичный API отдаёт `list()`.
   */
  exportAll(): Promise<ServiceApiKeyRecord[]>;
  /**
   * Импорт готовой записи **как есть** (PROP-032): сохраняет `id`, `prefix`,
   * `hash` и метаданные; новый секрет не генерируется, plaintext не принимается.
   * Идемпотентно: если запись с таким `id`, меткой (регистронезависимо) или
   * хешем уже существует — возвращается она, запись не перезаписывается.
   */
  importExisting(record: ServiceApiKeyRecord): Promise<ServiceApiKey>;
}
