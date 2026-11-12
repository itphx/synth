/**
 * Провайдеры пулов provisioner'а (PROP-135, Ф4b-2a).
 *
 * Контракт `PoolProvisioner` — то, что provisioner умеет делать с ресурсом
 * пула: обеспечить (`ensure`), подготовить к удалению (`drain`) и удалить
 * (`release`). В 4b-2a реализован только `static`: адрес пула известен
 * заранее (точный ключ либо профиль), ресурсов не создаётся.
 *
 * Kubernetes-провайдер (под на проект/сессию, namespace, ServiceAccount —
 * PROP-135 §4b-2b) подключается позже; контракт уже учитывает его форму:
 * `drain` отделён от `release` (сначала «попросить» исполнителя завершиться,
 * потом удалить ресурс), `capabilities` отдаёт профили.
 *
 * ## Токены пулов
 *
 * Токен возвращается **значением** (control plane передаёт его исполнителю);
 * provisioner его не логирует и не отдаёт в диагностике (`GET /v1/pools`).
 * В static-режиме токен никуда не сохраняется — он существует только для
 * контракта (реальный исполнитель проверяет свой токен сам).
 */

import { randomBytes } from 'node:crypto';
import type { ProvisionerConfig, ProvisionerProfiles } from './config.js';
import type { EnsurePoolRequest, EnsurePoolResponse } from './protocol.js';

/** Причина отказа провайдера пулов. */
export type PoolProviderErrorReason = 'pool_not_found' | 'provider_error';

/**
 * Ошибка провайдера пулов: вызывающий отличает «пул не найден» (`404`) от
 * «провайдер не смог» (`500`).
 */
export class PoolProvisionerError extends Error {
  readonly reason: PoolProviderErrorReason;

  constructor(reason: PoolProviderErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PoolProvisionerError';
    this.reason = reason;
  }
}

/**
 * Источник пулов исполнения.
 *
 * `ensure` — идемпотентный по контракту (повторный запрос того же ключа
 * возвращает тот же ресурс; кэш держит `PoolService`). `drain`/`release` —
 * операции над уже существующим ресурсом; неизвестный ключ — no-op.
 */
export interface PoolProvisioner {
  /** Обеспечить пул: адрес и токен исполнителя. */
  ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse>;
  /** Подготовить ресурс пула к удалению (освободить исполнителей). */
  drain(key: string): Promise<void>;
  /** Удалить ресурс пула. */
  release(key: string): Promise<void>;
  /** Диагностика: имя провайдера и известные профили. */
  capabilities(): Promise<{ provider: string; profiles: string[] }>;
}

/**
 * Случайный токен пула (значение, не секрет provisioner'а).
 *
 * 32 байта CSPRNG → base64url: достаточно для bearer-токена исполнителя и
 * безопасно как символ пути/заголовка.
 */
export function generatePoolToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Провайдер пулов `static` (4b-2a): адреса известны заранее.
 *
 * Порядок поиска:
 * 1. **точный ключ** в `SYNTH_PROVISIONER_STATIC_POOLS` (тесты/дев: пул на
 *    конкретный проект/сессию);
 * 2. **профиль** запроса — `url` из `SYNTH_PROVISIONER_PROFILES` (общий пул
 *    профиля; изоляции пулов нет — это документированное ограничение static);
 * 3. иначе — `pool_not_found` (`404`).
 *
 * `ensure` возвращает **новый** токен на каждый вызов; идемпотентность
 * (тот же url/токен на повторный ключ) обеспечивает `PoolService`, который
 * кэширует запись.
 */
export class StaticPoolProvisioner implements PoolProvisioner {
  private readonly _staticPools: Record<string, string>;
  private readonly _profiles: ProvisionerProfiles;

  constructor(staticPools: Record<string, string>, profiles: ProvisionerProfiles) {
    this._staticPools = staticPools;
    this._profiles = profiles;
  }

  async ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    const exact = this._staticPools[req.key]?.trim() ?? '';
    if (exact !== '') {
      return { url: exact, token: generatePoolToken() };
    }
    const profile = this._profiles[req.profile];
    const url = profile?.url?.trim() ?? '';
    if (url === '') {
      throw new PoolProvisionerError(
        'pool_not_found',
        `пул "${req.key}" не найден: профиль "${req.profile}" не описан ` +
          '(SYNTH_PROVISIONER_PROFILES / SYNTH_PROVISIONER_STATIC_POOLS)',
      );
    }
    return { url, token: generatePoolToken() };
  }

  // Ресурсов нет: удалять/сливать нечего. Методы существуют, чтобы контракт
  // был одинаковым у всех провайдеров.
  async drain(_key: string): Promise<void> {
    // no-op
  }

  async release(_key: string): Promise<void> {
    // no-op
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'static', profiles: Object.keys(this._profiles) };
  }
}

/**
 * Собрать провайдера пулов по эффективной конфигурации.
 *
 * `kubernetes` отсекается ещё разбором env (fail-closed) — здесь страховка
 * на случай прямого вызова фабрики из кода.
 */
export function createPoolProvisioner(config: ProvisionerConfig): PoolProvisioner {
  if (config.provider === 'static') {
    return new StaticPoolProvisioner(config.staticPools, config.profiles);
  }
  throw new PoolProvisionerError(
    'provider_error',
    `провайдер пулов "${String(config.provider)}" не реализован в 4b-2a`,
  );
}
