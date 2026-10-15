import type { EventBindingApiKey, EventBindingApiKeyCreated } from '@itphx/synth-shared';
import type { EventKeyCredential } from '../../engine/events/credential.js';
import type { CreateEventApiKeyInput, UpdateEventApiKeyPatch } from '../event-api-key-store.js';

/** Результат резолва секрета binding-key: публичные метаданные + контекст аутентификации. */
export interface EventApiKeyResolution {
  key: EventBindingApiKey;
  credential: EventKeyCredential;
}

/**
 * Порт реестра API-ключей привязок (ADR-089/ADR-052, реализация — `EventApiKeyStore`).
 *
 * Метка уникальна глобально по инстансу (регистронезависимо) — инвариант любой
 * реализации; нарушение реализуется доменным конфликтом (`EventApiKeyConflictError`).
 */
export interface EventApiKeyRepository {
  listByBinding(bindingId: string): Promise<EventBindingApiKey[]>;
  get(bindingId: string, keyId: string): Promise<EventBindingApiKey | null>;
  create(input: CreateEventApiKeyInput): Promise<EventBindingApiKeyCreated>;
  update(
    bindingId: string,
    keyId: string,
    patch: UpdateEventApiKeyPatch,
  ): Promise<EventBindingApiKey | null>;
  remove(bindingId: string, keyId: string): Promise<boolean>;
  /** Каскадное удаление ключей привязки; число удалённых. */
  removeByBinding(bindingId: string): Promise<number>;
  /** Мягкий отзыв ключа; идемпотентно. */
  revoke(bindingId: string, keyId: string): Promise<boolean>;
  /** Резолв секрета `synth_evt_…`; revoked/expired/unknown → `null`. */
  resolveBySecret(rawSecret: string): Promise<EventApiKeyResolution | null>;
  touch(id: string): Promise<void>;
}
