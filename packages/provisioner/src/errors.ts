/**
 * Ошибки провайдеров пулов (PROP-135, Ф4b-2b).
 *
 * Вынесены в отдельный модуль, чтобы провайдеры (`provider.ts`,
 * `kubernetes-provider.ts`) и Kubernetes-клиент (`kubernetes.ts`) могли
 * бросать один и тот же тип без циклических импортов:
 *
 * ```text
 * errors.ts  ←  kubernetes.ts  ←  kubernetes-provider.ts  ←  provider.ts
 * ```
 *
 * Причина (`reason`) — закрытый набор: вызывающий отличает «пул не найден»
 * (`404`), «некорректный запрос» (`400`) и «провайдер не смог» (`500`).
 */

/** Причина отказа провайдера пулов. */
export type PoolProviderErrorReason = 'pool_not_found' | 'provider_error' | 'invalid_request';

/**
 * Ошибка провайдера пулов.
 *
 * Текст ошибки **никогда** не содержит токенов: Kubernetes-клиент передаёт в
 * него только метод, путь и сообщение API (значения секретов в сообщения
 * ошибок не попадают).
 */
export class PoolProvisionerError extends Error {
  readonly reason: PoolProviderErrorReason;

  constructor(reason: PoolProviderErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PoolProvisionerError';
    this.reason = reason;
  }
}
