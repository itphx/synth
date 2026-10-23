/**
 * ADR-105 (Ф3): реестр описаний OAuth-провайдеров — шов для каталога.
 *
 * Описание провайдера — **данные** (ADR-105 §13, вариант «А»): endpoint'ы,
 * `client_id`, scope'ы. Кода провайдера в ядре нет — каталог (плагин/расширение
 * или будущий HTTP-контракт) приносит только описание, а ядро строит по нему
 * клиента (`OAuthClient`).
 *
 * Реестр — **in-memory**: он живёт вместе с процессом и наполняется при старте
 * (сейчас — пустой; регистрация описаний — вместе с каталогом провайдеров).
 * `clientFor()` — тот самый срез, который `OAuthCredentialService` использует
 * для refresh: если описания провайдера нет, refresh завершается понятной
 * ошибкой (`OAuthError('not_found')`), а не «тихим» отказом.
 */
import { OAuthClient, type OAuthClientOptions } from './client.js';
import { OAuthError, type OAuthProviderDescription } from './types.js';

/** Запись реестра: описание провайдера и (необязательно) готовый клиент. */
export interface OAuthProviderRegistration {
  /** Описание провайдера (данные). */
  description: OAuthProviderDescription;
  /**
   * Готовый клиент. Если не задан — строится из описания (+ `clientSecret`,
   * если он передан), когда понадобится.
   */
  client?: OAuthClient;
  /** `client_secret` (только из env/файла — см. `client-secret.ts`). */
  clientSecret?: string;
  /** Дополнительные параметры клиента (напр. транспорт для тестов). */
  clientOptions?: Omit<OAuthClientOptions, 'provider' | 'clientSecret'>;
}

/**
 * Реестр OAuth-провайдеров инстанса.
 *
 * Наполняется при старте (каталог провайдеров); пустой реестр — штатное
 * состояние: доступы, созданные кодом, работают, но **обновить** токен без
 * описания провайдера нечем (refresh вернёт понятную ошибку).
 */
export class OAuthProviderRegistry {
  private readonly _items = new Map<string, OAuthProviderRegistration>();

  /** Зарегистрировать (или перерегистрировать) провайдера. */
  register(registration: OAuthProviderRegistration): void {
    this._items.set(registration.description.provider, registration);
  }

  /** Описание провайдера (или `undefined`). */
  get(provider: string): OAuthProviderDescription | undefined {
    return this._items.get(provider)?.description;
  }

  /** Все зарегистрированные описания. */
  list(): OAuthProviderDescription[] {
    return [...this._items.values()].map((item) => item.description);
  }

  /**
   * Клиент провайдера — для `OAuthCredentialService.clientFor`.
   *
   * Неизвестный провайдер → `OAuthError('not_found')` (без секретов).
   */
  clientFor(provider: string): OAuthClient {
    const item = this._items.get(provider);
    if (!item) {
      throw new OAuthError(
        'not_found',
        `Описание OAuth-провайдера "${provider}" не зарегистрировано`,
      );
    }
    if (item.client) return item.client;
    return new OAuthClient({
      provider: item.description,
      ...(item.clientSecret !== undefined ? { clientSecret: item.clientSecret } : {}),
      ...(item.clientOptions ?? {}),
    });
  }
}
